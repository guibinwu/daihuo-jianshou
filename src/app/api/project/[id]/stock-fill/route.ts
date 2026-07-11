import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { join } from "path";
import { access } from "fs/promises";
import { getDb } from "@/lib/db";
import { getDataDir } from "@/lib/paths";
import { scripts as scriptsTable, assets as assetsTable, type Shot } from "@/lib/db/schema";
import { fillShotStock, searchShotCandidates, persistCandidate, type ScoredStockCandidate } from "@/lib/stock-fill";
import { shotQuery, scoreCandidate, pickBestCandidate } from "@/lib/stock-matcher";
import { rerankShotCandidates, type RerankShot, type SemanticLLMConfig } from "@/lib/semantic-match";
import { mapWithConcurrency } from "@/lib/concurrency";
import type { StockSourceId, StockMediaType, StockOrientation } from "@/lib/providers/stock-types";
import { apiError } from "@/lib/api-error";

const SAFE_ID = /^[a-zA-Z0-9\-]+$/;

/** How many top-heuristic candidates each shot presents to the LLM (keeps the batched prompt small). */
const SEMANTIC_TOP_K = 6;

/**
 * POST /api/project/[id]/stock-fill —— for each shot in the currently selected script, auto-match one free stock asset and persist it.
 * This is the key step of "script → assets auto-fill" (non-product-theme video), reusing the multi-source asset engine with a guaranteed fallback.
 *
 * body: { source?, mediaType?, orientation?, apiKeys?, force?, llmConfig? }
 *  - source defaults to "all" (aggregated; keyless Openverse always participates)
 *  - force=true re-fills a shot even if it already has a stock asset
 *  - llmConfig {baseUrl, apiKey?, model} opt-in: semantic rerank — ONE batched LLM call picks the
 *    candidate that best matches each shot's narration (falls back to the keyword heuristic on any failure)
 * Cross-shot dedup: one shared usedIds set spans the whole fill, so the same stock item never repeats across shots.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) {
    return apiError(req, "无效的项目ID", "Invalid project ID");
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is allowed */
  }

  const source = (body.source as StockSourceId | "all") ?? "all";
  // mediaType="auto": per-shot "video first, fall back to image if unavailable" — gets dynamic B-roll while guaranteeing every shot has a visual (no API key needed throughout)
  const autoMode = body.mediaType === "auto";
  const mediaType: StockMediaType =
    body.mediaType === "image" || body.mediaType === "audio" ? (body.mediaType as StockMediaType) : "video";
  const orientation: StockOrientation =
    body.orientation === "landscape" || body.orientation === "square" ? (body.orientation as StockOrientation) : "portrait";
  const apiKeys = (body.apiKeys as Record<string, string>) ?? {};
  const force = body.force === true;
  const llmRaw = body.llmConfig as { baseUrl?: unknown; apiKey?: unknown; model?: unknown } | undefined;
  const llm: SemanticLLMConfig | null =
    llmRaw && typeof llmRaw.baseUrl === "string" && llmRaw.baseUrl && typeof llmRaw.model === "string" && llmRaw.model
      ? { baseUrl: llmRaw.baseUrl, model: llmRaw.model, apiKey: typeof llmRaw.apiKey === "string" ? llmRaw.apiKey : undefined }
      : null;

  const db = getDb();

  // Get the selected script (fall back to the most recent one if none is selected)
  const rows = await db.select().from(scriptsTable).where(eq(scriptsTable.projectId, id));
  if (rows.length === 0) {
    return apiError(req, "该项目还没有脚本，请先生成脚本", "This project has no script yet; please generate a script first", 404);
  }
  const script = rows.find((r) => r.selected) ?? rows[rows.length - 1];
  const shots = (script.shots ?? []) as Shot[];
  if (shots.length === 0) {
    return apiError(req, "脚本没有分镜", "The script has no shots");
  }

  // Shots that already have any asset (avoids duplicate filling and conflicts with AI/product assets on the same shot, unless force is set)
  const existing = await db
    .select({ shotId: assetsTable.shotId })
    .from(assetsTable)
    .where(eq(assetsTable.projectId, id));
  const already = new Set(existing.map((e) => e.shotId));

  // If the local material pool exists, include it in auto-fill: user-owned B-roll competes alongside free stock assets
  const materialsDir = join(getDataDir(), "uploads", id, "materials");
  let localDir: string | undefined;
  try {
    await access(materialsDir);
    localDir = materialsDir;
  } catch {
    /* no material pool; proceed with network free sources only */
  }

  const searchOpts = { apiKeys, mediaType, orientation, perPage: 10, localDir };
  type ShotFillResult = {
    shotId: number;
    ok: boolean;
    query: string;
    provider?: string;
    mediaType?: StockMediaType;
    /** which ranker chose the asset: semantic (LLM) or heuristic (keyword/orientation score) */
    matchedBy?: "semantic" | "heuristic";
    reason?: string;
  };

  // one shared dedup set across the whole fill: the same stock item never repeats across shots
  const usedIds = new Set<string>();

  const skipOf = (shot: Shot): ShotFillResult | null => {
    const sid = shot.shotId;
    if (!force && already.has(sid)) return { shotId: sid, ok: false, query: "", reason: "already has asset, skipped" };
    // Product-image shots do not receive free stock: the compose step uses the product image for fidelity, and free stock would overwrite it
    if (shot.visualSource === "product_image") return { shotId: sid, ok: false, query: "", reason: "product-image shot, skipped" };
    if (!shotQuery(shot)) return { shotId: sid, ok: false, query: "", reason: "no search query" };
    return null;
  };

  // ---------- semantic path (opt-in): gather all shots' candidates → ONE batched LLM pick → persist ----------
  if (llm) {
    // phase 1: search candidates per shot (bounded concurrency; auto mode falls back video → image)
    type Gathered = { shot: Shot; query: string; cands: ScoredStockCandidate[]; error?: string };
    const fillable = shots.filter((s) => !skipOf(s));
    const gathered = await mapWithConcurrency<Shot, Gathered>(fillable, 4, async (shot) => {
      const query = shotQuery(shot);
      try {
        let cands = await searchShotCandidates(query, source, searchOpts);
        if (cands.length === 0 && autoMode && mediaType !== "image") {
          cands = await searchShotCandidates(query, source, { ...searchOpts, mediaType: "image" });
        }
        return { shot, query, cands };
      } catch (e) {
        return { shot, query, cands: [], error: e instanceof Error ? e.message : String(e) };
      }
    });

    // phase 2: one batched LLM rerank over each shot's top-K heuristic candidates (any failure → heuristic for all)
    const topKOf = new Map<number, ScoredStockCandidate[]>();
    const rerankInputs: RerankShot[] = [];
    for (const g of gathered) {
      if (g.cands.length === 0) continue;
      const ranked = [...g.cands].sort(
        (a, b) =>
          scoreCandidate({ description: g.query }, b, { preferPortrait: true }) -
          scoreCandidate({ description: g.query }, a, { preferPortrait: true })
      );
      const topK = ranked.slice(0, SEMANTIC_TOP_K);
      topKOf.set(g.shot.shotId, topK);
      rerankInputs.push({
        shotId: g.shot.shotId,
        text: (g.shot.voiceover || g.shot.description || g.query).trim(),
        candidates: topK.map((c) => ({ title: c.title, tags: c.tags, source: String(c.source) })),
      });
    }
    let picks = new Map<number, number>();
    let semanticOk = false;
    try {
      picks = await rerankShotCandidates(rerankInputs, llm);
      semanticOk = true;
    } catch (e) {
      console.warn("[stock-fill] 语义配片失败，回退关键词启发式:", e instanceof Error ? e.message : e);
    }

    // phase 3: resolve the final candidate per shot (LLM pick if valid and unused, else heuristic) and persist
    const results = await mapWithConcurrency<Gathered, ShotFillResult>(gathered, 4, async (g) => {
      const sid = g.shot.shotId;
      if (g.cands.length === 0) {
        return { shotId: sid, ok: false, query: g.query, reason: g.error ?? "no asset found" };
      }
      // pick + usedIds.add happen synchronously (no await in between), so concurrent shots can't grab the same item
      const topK = topKOf.get(sid) ?? g.cands;
      const pickIdx = picks.get(sid);
      const llmPick = pickIdx !== undefined ? topK[pickIdx] : undefined;
      const chosen =
        llmPick && !usedIds.has(llmPick.id)
          ? llmPick
          : (pickBestCandidate({ description: g.query }, g.cands, { preferPortrait: true, usedIds }) ?? g.cands[0]);
      const matchedBy: "semantic" | "heuristic" = chosen === llmPick && semanticOk ? "semantic" : "heuristic";
      usedIds.add(chosen.id);
      try {
        const asset = await persistCandidate(id, sid, g.query, chosen);
        return {
          shotId: sid,
          ok: true,
          query: g.query,
          provider: String(asset.provider),
          mediaType: (asset.mediaType as StockMediaType) ?? mediaType,
          matchedBy,
        };
      } catch (e) {
        return { shotId: sid, ok: false, query: g.query, reason: e instanceof Error ? e.message : String(e) };
      }
    });
    const skipped = shots.map(skipOf).filter((r): r is ShotFillResult => r !== null);
    const all = [...results, ...skipped].sort((a, b) => a.shotId - b.shotId);
    const filled = all.filter((r) => r.ok).length;
    return NextResponse.json({ projectId: id, scriptId: script.id, total: shots.length, filled, semantic: semanticOk, results: all });
  }

  // ---------- heuristic path (default, no LLM) ----------
  // Per-shot searches are independent (each result depends only on itself and writes a distinct asset row); bounded concurrency (4) replaces serial execution — faster overall without hammering downstream APIs
  const results = await mapWithConcurrency<Shot, ShotFillResult>(shots, 4, async (shot) => {
    const sid = shot.shotId;
    const skip = skipOf(shot);
    if (skip) return skip;
    const query = shotQuery(shot);
    try {
      let asset = await fillShotStock({ projectId: id, shotId: sid, query, source, searchOpts, usedIds });
      // In auto mode, if no video was found → fall back to image to ensure the shot is never empty
      if (!asset && autoMode && mediaType !== "image") {
        asset = await fillShotStock({ projectId: id, shotId: sid, query, source, searchOpts: { ...searchOpts, mediaType: "image" }, usedIds });
      }
      // Report the ACTUAL downloaded media type (from the chosen candidate), not the requested one:
      // keyless "video" requests routinely fall back to Openverse images (its only video-less keyless
      // source), so reporting the requested "video" would mislabel an image asset as a video.
      const actualType = (asset?.mediaType as StockMediaType) ?? mediaType;
      return asset
        ? { shotId: sid, ok: true, query, provider: String(asset.provider), mediaType: actualType, matchedBy: "heuristic" }
        : { shotId: sid, ok: false, query, reason: "no asset found" };
    } catch (e) {
      return { shotId: sid, ok: false, query, reason: e instanceof Error ? e.message : String(e) };
    }
  });

  const filled = results.filter((r) => r.ok).length;
  return NextResponse.json({ projectId: id, scriptId: script.id, total: shots.length, filled, results });
}
