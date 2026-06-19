/**
 * Pexels 素材源 —— 免费可商用版权视频/图片的检索与下载
 *
 * 与 AIProvider（生成类、异步 task 轮询）不同，素材源是「检索 + 下载」模型：
 * 搜索关键词 → 拿到候选直链 → 下载到本地 data/uploads → 供 composer 当普通 video/image 片段使用。
 * 这是「无商品也能主题成片」的素材引擎基石。
 *
 * 合规要点（务必随成片留存）：Pexels 要求显著标注来源并尽量署名作者，
 * 因此每个候选都带 pageUrl(来源页) / author(作者) / authorUrl，落库到 assets 表的 sourceUrl/author/license。
 * 检索词建议用英文（Pexels 英文召回远好于中文）。
 *
 * 鉴权：Pexels 用 HTTP 头 `Authorization: <API_KEY>`（注意没有 Bearer 前缀）。
 * 免费 Key 在 https://www.pexels.com/api/ 申请，免费额度 200 次/小时、20000 次/月。
 */

const PEXELS_API = "https://api.pexels.com";

/** 单次下载体积上限（80MB），避免误下超大 4K 原片拖垮本地 */
const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;
/** 网络请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 30_000;

// ==================== Pexels 原始响应类型 ====================

/** Pexels 视频的单个清晰度文件 */
export interface PexelsVideoFile {
  id: number;
  quality: string | null; // "hd" | "sd" | null
  file_type: string; // "video/mp4"
  width: number;
  height: number;
  fps: number;
  link: string;
  size: number; // 字节
}

/** Pexels 视频条目 */
export interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number; // 秒
  url: string; // 视频详情页（归属链接）
  image: string; // 预览图
  user: { id: number; name: string; url: string };
  video_files: PexelsVideoFile[];
}

/** Pexels 图片条目 */
export interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string; // 图片详情页（归属链接）
  photographer: string;
  photographer_url: string;
  alt: string;
  src: {
    original: string;
    large2x: string;
    large: string;
    medium: string;
    portrait: string;
    landscape: string;
    tiny: string;
  };
}

// ==================== 归一化候选 ====================

export type StockOrientation = "portrait" | "landscape" | "square";

/** 统一的素材候选（视频/图片都归一到这个结构，供路由与匹配器消费） */
export interface StockCandidate {
  source: "pexels";
  mediaType: "video" | "image";
  id: number;
  /** 选中的清晰度文件直链（下载用） */
  downloadUrl: string;
  /** 来源详情页 URL（合规归属） */
  pageUrl: string;
  /** 作者名（署名） */
  author: string;
  /** 作者主页 */
  authorUrl: string;
  /** 授权类型 */
  license: "Pexels";
  width: number;
  height: number;
  /** 视频时长（秒），图片为 undefined */
  durationSec?: number;
  /** 预览图 */
  previewImage?: string;
}

// ==================== 纯函数（可单测） ====================

/** 判断方向 */
export function orientationOf(width: number, height: number): StockOrientation {
  if (height > width) return "portrait";
  if (width > height) return "landscape";
  return "square";
}

/**
 * 从一个 Pexels 视频的多个清晰度里挑「最合适」的文件：
 * 1. 只要 mp4；
 * 2. 优先匹配目标方向（竖屏成片要 portrait）；
 * 3. 在满足方向的里挑「短边 >= minShortSide 的最小体积」那条（省带宽又够清晰）；
 * 4. 若没有任何文件达到 minShortSide，则退而取分辨率最高的一条（尽量清晰）。
 * 纯函数，便于单测。
 */
export function pickBestVideoFile(
  files: PexelsVideoFile[],
  opts: { orientation?: StockOrientation; minShortSide?: number } = {}
): PexelsVideoFile | null {
  const { orientation = "portrait", minShortSide = 720 } = opts;
  const mp4 = files.filter((f) => f.file_type === "video/mp4" && f.link);
  if (mp4.length === 0) return null;

  // 优先方向匹配；若该方向一个都没有，则回退到全部文件
  const dirMatched = mp4.filter((f) => orientationOf(f.width, f.height) === orientation);
  const pool = dirMatched.length > 0 ? dirMatched : mp4;

  const shortSide = (f: PexelsVideoFile) => Math.min(f.width, f.height);

  // 达到清晰度门槛的候选里取体积最小的
  const qualified = pool.filter((f) => shortSide(f) >= minShortSide);
  if (qualified.length > 0) {
    return qualified.reduce((best, f) => (f.size < best.size ? f : best));
  }

  // 没有达标的，取分辨率（短边）最高的一条
  return pool.reduce((best, f) => (shortSide(f) > shortSide(best) ? f : best));
}

/** 把一个 Pexels 视频归一化为候选（挑好清晰度文件）；挑不出文件则返回 null */
export function toVideoCandidate(
  video: PexelsVideo,
  opts: { orientation?: StockOrientation; minShortSide?: number } = {}
): StockCandidate | null {
  const file = pickBestVideoFile(video.video_files, opts);
  if (!file) return null;
  return {
    source: "pexels",
    mediaType: "video",
    id: video.id,
    downloadUrl: file.link,
    pageUrl: video.url,
    author: video.user?.name ?? "Pexels",
    authorUrl: video.user?.url ?? "https://www.pexels.com",
    license: "Pexels",
    width: file.width,
    height: file.height,
    durationSec: video.duration,
    previewImage: video.image,
  };
}

/** 按目标方向挑图片的最佳尺寸链接 */
export function pickPhotoSrc(photo: PexelsPhoto, orientation: StockOrientation): string {
  if (orientation === "portrait") return photo.src.portrait || photo.src.large2x || photo.src.original;
  if (orientation === "landscape") return photo.src.landscape || photo.src.large2x || photo.src.original;
  return photo.src.large2x || photo.src.original;
}

/** 把一个 Pexels 图片归一化为候选 */
export function toPhotoCandidate(photo: PexelsPhoto, orientation: StockOrientation = "portrait"): StockCandidate {
  return {
    source: "pexels",
    mediaType: "image",
    id: photo.id,
    downloadUrl: pickPhotoSrc(photo, orientation),
    pageUrl: photo.url,
    author: photo.photographer ?? "Pexels",
    authorUrl: photo.photographer_url ?? "https://www.pexels.com",
    license: "Pexels",
    width: photo.width,
    height: photo.height,
    previewImage: photo.src?.tiny,
  };
}

/** 按时长过滤候选（避免太短/太长的素材） */
export function filterByDuration(
  candidates: StockCandidate[],
  opts: { minSec?: number; maxSec?: number } = {}
): StockCandidate[] {
  const { minSec, maxSec } = opts;
  return candidates.filter((c) => {
    if (c.mediaType !== "video" || c.durationSec == null) return true; // 图片不过滤
    if (minSec != null && c.durationSec < minSec) return false;
    if (maxSec != null && c.durationSec > maxSec) return false;
    return true;
  });
}

/** 从直链/响应推断文件扩展名 */
export function inferExtension(url: string, contentType?: string | null): string {
  const ctMap: Record<string, string> = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  };
  if (contentType && ctMap[contentType.split(";")[0].trim()]) {
    return ctMap[contentType.split(";")[0].trim()];
  }
  const m = url.split("?")[0].match(/\.([a-zA-Z0-9]{2,4})$/);
  return (m?.[1] || "mp4").toLowerCase();
}

// ==================== 网络函数 ====================

/** 带超时的 fetch */
async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 搜索 Pexels 视频 */
export async function searchPexelsVideos(
  query: string,
  opts: {
    apiKey: string;
    perPage?: number;
    orientation?: StockOrientation;
    minShortSide?: number;
    minSec?: number;
    maxSec?: number;
  }
): Promise<StockCandidate[]> {
  const { apiKey, perPage = 10, orientation = "portrait", minShortSide, minSec, maxSec } = opts;
  if (!apiKey) throw new Error("缺少 Pexels API Key");
  if (!query?.trim()) throw new Error("检索词为空");

  const params = new URLSearchParams({
    query: query.trim(),
    per_page: String(perPage),
    orientation,
  });
  const res = await fetchWithTimeout(`${PEXELS_API}/videos/search?${params}`, {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pexels 视频检索失败 ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { videos?: PexelsVideo[] };
  const candidates = (data.videos ?? [])
    .map((v) => toVideoCandidate(v, { orientation, minShortSide }))
    .filter((c): c is StockCandidate => c !== null);
  return filterByDuration(candidates, { minSec, maxSec });
}

/** 搜索 Pexels 图片 */
export async function searchPexelsPhotos(
  query: string,
  opts: { apiKey: string; perPage?: number; orientation?: StockOrientation }
): Promise<StockCandidate[]> {
  const { apiKey, perPage = 10, orientation = "portrait" } = opts;
  if (!apiKey) throw new Error("缺少 Pexels API Key");
  if (!query?.trim()) throw new Error("检索词为空");

  const params = new URLSearchParams({
    query: query.trim(),
    per_page: String(perPage),
    orientation,
  });
  const res = await fetchWithTimeout(`${PEXELS_API}/v1/search?${params}`, {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pexels 图片检索失败 ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { photos?: PexelsPhoto[] };
  return (data.photos ?? []).map((p) => toPhotoCandidate(p, orientation));
}

/** 下载结果 */
export interface DownloadResult {
  filePath: string; // 绝对路径
  bytes: number;
}

/**
 * 下载一个直链到指定目录，返回保存信息。
 * - 带超时与体积上限（先看 Content-Length，再以实际 buffer 兜底）；
 * - 调用方负责传入已 mkdir 的目录与文件名前缀。
 */
export async function downloadStockFile(
  url: string,
  destDir: string,
  fileBaseName: string
): Promise<DownloadResult> {
  const { writeFile } = await import("fs/promises");
  const { join } = await import("path");

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`素材下载失败 ${res.status}: ${url}`);

  const contentType = res.headers.get("content-type");
  const declaredLen = Number(res.headers.get("content-length") || 0);
  if (declaredLen && declaredLen > MAX_DOWNLOAD_BYTES) {
    throw new Error(`素材体积 ${declaredLen} 超过上限 ${MAX_DOWNLOAD_BYTES}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(`素材体积 ${buffer.byteLength} 超过上限 ${MAX_DOWNLOAD_BYTES}`);
  }

  const ext = inferExtension(url, contentType);
  const filePath = join(destDir, `${fileBaseName}.${ext}`);
  await writeFile(filePath, buffer);
  return { filePath, bytes: buffer.byteLength };
}
