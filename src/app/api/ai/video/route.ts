import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "@/lib/paths";
import { readFile } from "fs/promises";
import { join } from "path";
import { createProvider } from "@/lib/providers";

/** 本地 /api/files 路径转 base64 data URI（远程 provider 无法访问 localhost 首帧） */
async function toRemoteUsableImage(ref: string | undefined): Promise<string | undefined> {
  if (!ref) return undefined;
  if (ref.startsWith("http") || ref.startsWith("data:")) return ref;
  const m = ref.match(/\/api\/files\/(.+)/);
  if (!m) return ref;
  try {
    const filePath = join(getDataDir(), "uploads", m[1]);
    const buf = await readFile(filePath);
    const ext = filePath.split(".").pop()?.toLowerCase() || "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return ref;
  }
}

// AI 生视频
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { provider: providerName, model, prompt, imageUrl, mode, apiKey, baseUrl, options } = body;

  if (!providerName || !model) {
    return NextResponse.json({ error: "缺少必要参数" }, { status: 400 });
  }

  if (!apiKey) {
    return NextResponse.json({ error: "缺少 API Key，请先在设置中配置对应平台" }, { status: 400 });
  }

  try {
    const provider = createProvider({ name: providerName, apiKey, baseUrl });

    const firstFrameUrl = await toRemoteUsableImage(imageUrl);

    const result = await provider.generateVideo({
      modelId: model,
      mode: mode || (imageUrl ? "image-to-video" : "text-to-video"),
      prompt: prompt || "",
      firstFrameUrl,
      ...options,
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error("生视频失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生视频失败" },
      { status: 500 }
    );
  }
}
