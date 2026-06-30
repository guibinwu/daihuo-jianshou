import { NextRequest, NextResponse } from "next/server";
import { eq, desc } from "drizzle-orm";
import { join } from "path";
import { existsSync } from "fs";
import { getDb } from "@/lib/db";
import { getDataDir } from "@/lib/paths";
import { compositions } from "@/lib/db/schema";
import { generateGifPreview } from "@/lib/video-composer/gif-preview";

const SAFE_ID = /^[a-zA-Z0-9\-]+$/;

/**
 * POST /api/project/[id]/preview-gif — turn a slice of the latest composed video into a looping GIF preview.
 * body: { startSec?: number, durationSec?: number, width?: number }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* allow empty body; defaults applied below */
  }

  const db = getDb();
  const [comp] = await db
    .select()
    .from(compositions)
    .where(eq(compositions.projectId, id))
    .orderBy(desc(compositions.createdAt))
    .limit(1);
  if (!comp?.outputPath || comp.status !== "done") {
    return NextResponse.json({ error: "请先合成视频再生成预览 GIF" }, { status: 400 });
  }
  const videoPath = existsSync(comp.outputPath) ? comp.outputPath : join(getDataDir(), comp.outputPath);
  if (!existsSync(videoPath)) return NextResponse.json({ error: "成片文件不存在" }, { status: 404 });

  const fileName = `preview-${Date.now()}.gif`;
  const outPath = join(getDataDir(), "uploads", id, fileName);
  try {
    await generateGifPreview({
      videoPath,
      outPath,
      startSec: Number(body.startSec) || 0,
      durationSec: Number(body.durationSec) || 4,
      width: Number(body.width) || 360,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "GIF 生成失败" }, { status: 500 });
  }
  return NextResponse.json({ gif: `/api/files/${id}/${fileName}` });
}
