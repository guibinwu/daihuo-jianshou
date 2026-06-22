import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { getUploadsDir } from "@/lib/paths";
import { mkdir } from "fs/promises";
import { join, basename } from "path";
import { parseProductFromHtml } from "@/lib/product-ingest";
import { downloadStockFile } from "@/lib/providers/stock-types";

const UA = "Mozilla/5.0 (compatible; ClipForge/1.0; +https://github.com/xixihhhh/clipforge)";
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_IMAGES = 3;

/**
 * POST /api/ingest/product —— 商品链接一键导入。
 * body: { url, createProject? }（createProject 默认 true：建带货项目 + 下载前 3 张商品图）
 * 抓取商品页 → 解析 标题/价格/描述/图 → （可选）建项目落地，前端/MCP 拿到 projectId 直接走脚本→出片。
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!/^https?:\/\/.+/i.test(url)) {
    return NextResponse.json({ error: "请填写合法的商品链接（http/https）" }, { status: 400 });
  }
  const createProject = body.createProject !== false;

  // 抓取 HTML（描述性 UA + 超时 + 体积上限）
  let html: string;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
      signal: ctrl.signal,
      redirect: "follow",
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return NextResponse.json({ error: `抓取商品页失败：HTTP ${res.status}` }, { status: 502 });
    const ct = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml/i.test(ct)) {
      return NextResponse.json({ error: "该链接不是网页（非 HTML），无法解析" }, { status: 415 });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    html = buf.subarray(0, MAX_HTML_BYTES).toString("utf8");
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "抓取超时" : e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: `抓取商品页失败：${msg}` }, { status: 502 });
  }

  const product = parseProductFromHtml(html, url);
  if (!product.title && product.images.length === 0) {
    return NextResponse.json({ error: "没能从该链接解析出商品信息，请改用手动填写", product }, { status: 422 });
  }

  if (!createProject) return NextResponse.json({ product });

  // 建带货项目 + 下载前若干张商品图落库
  const db = getDb();
  const name = (product.title || "导入的商品").slice(0, 60);
  const [proj] = await db
    .insert(projects)
    .values({
      name,
      contentType: "product",
      productName: name,
      productDescription: product.description ?? null,
      productImages: [],
    })
    .returning();

  const destDir = join(getUploadsDir(), proj.id);
  await mkdir(destDir, { recursive: true });
  const saved: string[] = [];
  for (const [i, img] of product.images.slice(0, MAX_IMAGES).entries()) {
    try {
      const { filePath } = await downloadStockFile(img, destDir, `ingest_${Date.now()}_${i}`, "image");
      saved.push(`/api/files/${proj.id}/${basename(filePath)}`);
    } catch {
      /* 单张图下载失败则跳过 */
    }
  }
  if (saved.length > 0) {
    await db.update(projects).set({ productImages: saved, updatedAt: new Date() }).where(eq(projects.id, proj.id));
  }

  return NextResponse.json({ projectId: proj.id, product, productImages: saved });
}
