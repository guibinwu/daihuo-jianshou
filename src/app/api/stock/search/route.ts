import { NextRequest, NextResponse } from "next/server";
import { mkdir } from "fs/promises";
import { join, basename } from "path";
import {
  searchPexelsVideos,
  searchPexelsPhotos,
  downloadStockFile,
  type StockCandidate,
} from "@/lib/providers/pexels";
import { getDb } from "@/lib/db";
import { assets as assetsTable } from "@/lib/db/schema";

/** 校验 projectId 防路径穿越（与 upload 路由一致） */
const SAFE_ID = /^[a-zA-Z0-9\-]+$/;

/**
 * POST /api/stock/search
 * 检索版权素材库（Pexels），可选地下载选中的素材并落库到 assets 表。
 *
 * body: {
 *   query: string,             // 英文检索词
 *   projectId?: string,        // download=true 时必填
 *   shotId?: number,           // 落库对应的分镜序号，默认 0
 *   mediaType?: "video"|"image",  // 默认 video
 *   orientation?: "portrait"|"landscape"|"square", // 默认 portrait（竖屏）
 *   perPage?: number,          // 检索条数，默认 10
 *   count?: number,            // download=true 时下载前几条，默认 1
 *   minSec?: number, maxSec?: number, // 视频时长过滤
 *   download?: boolean,        // true=下载并落库；false=仅返回候选预览
 *   apiKey?: string            // Pexels Key（不传则读 PEXELS_API_KEY 环境变量）
 * }
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const query = String(body.query ?? "").trim();
  const mediaType = body.mediaType === "image" ? "image" : "video";
  const orientation =
    body.orientation === "landscape" || body.orientation === "square"
      ? (body.orientation as "landscape" | "square")
      : "portrait";
  const perPage = Number(body.perPage ?? 10);
  const count = Math.max(1, Number(body.count ?? 1));
  const download = body.download === true;
  const shotId = Number(body.shotId ?? 0);
  const apiKey = String(body.apiKey ?? process.env.PEXELS_API_KEY ?? "");

  if (!query) {
    return NextResponse.json({ error: "请填写检索词（建议英文，Pexels 英文召回更好）" }, { status: 400 });
  }
  if (!apiKey) {
    return NextResponse.json(
      { error: "未配置 Pexels API Key，请在设置中填写或设置 PEXELS_API_KEY 环境变量（免费申请：https://www.pexels.com/api/）" },
      { status: 400 }
    );
  }

  // 检索
  let candidates: StockCandidate[];
  try {
    candidates =
      mediaType === "image"
        ? await searchPexelsPhotos(query, { apiKey, perPage, orientation })
        : await searchPexelsVideos(query, {
            apiKey,
            perPage,
            orientation,
            minSec: body.minSec != null ? Number(body.minSec) : undefined,
            maxSec: body.maxSec != null ? Number(body.maxSec) : undefined,
          });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 鉴权失败给更友好的提示
    const status = /\b401\b/.test(msg) ? 401 : 502;
    return NextResponse.json({ error: `素材检索失败：${msg}` }, { status });
  }

  // 仅预览：直接返回候选
  if (!download) {
    return NextResponse.json({ candidates });
  }

  // 下载落库
  const projectId = String(body.projectId ?? "");
  if (!projectId || !SAFE_ID.test(projectId)) {
    return NextResponse.json({ error: "download=true 时需提供合法 projectId" }, { status: 400 });
  }
  if (candidates.length === 0) {
    return NextResponse.json({ error: "没有检索到可用素材，换个检索词试试" }, { status: 404 });
  }

  const stockDir = join(process.cwd(), "data", "uploads", projectId, "stock");
  await mkdir(stockDir, { recursive: true });

  const picked = candidates.slice(0, count);
  const saved: Array<Record<string, unknown>> = [];
  const db = getDb();

  for (let i = 0; i < picked.length; i++) {
    const c = picked[i];
    try {
      const base = `${c.source}_${c.id}_${Date.now()}_${i}`;
      const { filePath, bytes } = await downloadStockFile(c.downloadUrl, stockDir, base);
      const publicUrl = `/api/files/${projectId}/stock/${basename(filePath)}`;

      const [row] = await db
        .insert(assetsTable)
        .values({
          projectId,
          shotId,
          type: "stock_footage",
          filePath: publicUrl,
          thumbnailPath: c.previewImage ?? null,
          provider: "pexels",
          prompt: query,
          sourceUrl: c.pageUrl,
          author: c.author,
          license: c.license,
          status: "done",
        })
        .returning();

      saved.push({ ...row, bytes, mediaType: c.mediaType, downloadUrl: c.downloadUrl });
    } catch (e) {
      // 单条失败不阻塞其余（记录但继续）
      console.error(`素材下载落库失败（${c.downloadUrl}）:`, e);
    }
  }

  if (saved.length === 0) {
    return NextResponse.json({ error: "素材下载全部失败，请重试" }, { status: 502 });
  }

  return NextResponse.json({ assets: saved, candidatesCount: candidates.length });
}
