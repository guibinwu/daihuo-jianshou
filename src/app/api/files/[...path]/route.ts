import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "@/lib/paths";
import { apiError } from "@/lib/api-error";
import { readFile } from "fs/promises";
import { join, normalize, sep } from "path";
import { existsSync } from "fs";

// Static file server - serves uploaded images/videos
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;

  // Root directory for uploads
  const uploadsRoot = join(getDataDir(), "uploads");
  // Decode and normalize path segments before joining to prevent path traversal via encodings like ..%2f
  const decodedSegments = path.map((seg) => decodeURIComponent(seg));
  const filePath = normalize(join(uploadsRoot, ...decodedSegments));

  // Verify the resolved path is still within the uploads root directory
  if (filePath !== uploadsRoot && !filePath.startsWith(uploadsRoot + sep)) {
    return apiError(req, "非法路径", "Invalid path", 403);
  }

  if (!existsSync(filePath)) {
    return apiError(req, "文件不存在", "File not found", 404);
  }

  const buffer = await readFile(filePath);
  const ext = filePath.split(".").pop()?.toLowerCase();

  const mimeTypes: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    webm: "video/webm",
  };

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": mimeTypes[ext || ""] || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000",
    },
  });
}
