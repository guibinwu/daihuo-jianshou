/**
 * Final video specs for each e-commerce platform — single source of truth for multi-platform export (re-encode to target aspect ratio).
 * Douyin / Kuaishou / TikTok Shop / Instagram Reels / YouTube Shorts use 9:16 portrait; Xiaohongshu prefers 3:4. Pure data + accessor, unit-testable.
 * Overseas short-video destinations (reels/shorts) share TikTok's 9:16 1080×1920 spec — same pixels, but exposed as named
 * export targets so a creator cross-posting one clip to TikTok + Reels + Shorts (the 2026 standard) gets correctly-labeled files.
 */

export interface PlatformSpec {
  name: string;
  w: number;
  h: number;
  ratio: string;
  /**
   * Platform recompression threshold in kbps (total file bitrate). Uploads above this line get
   * force-transcoded by the platform ("second compression"), which visibly softens AI-composed
   * footage. Values are community-measured / official-recommendation figures (recorded 2026-07),
   * NOT official hard limits — keep them maintainable here as encoding targets with headroom.
   */
  maxVideoKbps: number;
  /** Frame-rate ceiling; exports above this are downsampled (higher fps wastes the bitrate budget). */
  maxFps: number;
}

export const PLATFORM_SPECS: Record<string, PlatformSpec> = {
  // douyin: community tests report forced transcode above ~6000 kbps at 1080P (知乎实测, 2026-07)
  douyin: { name: "抖音", w: 1080, h: 1920, ratio: "9:16", maxVideoKbps: 6000, maxFps: 60 },
  // kuaishou / xiaohongshu / shipinhao: community consensus ≤8 Mbps at 1080P (2026-07)
  kuaishou: { name: "快手", w: 1080, h: 1920, ratio: "9:16", maxVideoKbps: 8000, maxFps: 60 },
  xiaohongshu: { name: "小红书", w: 1080, h: 1440, ratio: "3:4", maxVideoKbps: 8000, maxFps: 60 },
  shipinhao: { name: "视频号", w: 1080, h: 1920, ratio: "9:16", maxVideoKbps: 8000, maxFps: 60 },
  // tiktok: community tests show noticeable recompression above ~8-10 Mbps; conservative 8000
  tiktok: { name: "TikTok Shop", w: 1080, h: 1920, ratio: "9:16", maxVideoKbps: 8000, maxFps: 60 },
  // reels: Instagram officially recommends ~5 Mbps for 1080p/30
  reels: { name: "Instagram Reels", w: 1080, h: 1920, ratio: "9:16", maxVideoKbps: 5000, maxFps: 60 },
  // shorts: YouTube officially recommends 8 Mbps for 1080p SDR 30fps
  shorts: { name: "YouTube Shorts", w: 1080, h: 1920, ratio: "9:16", maxVideoKbps: 8000, maxFps: 60 },
};

/** Get the spec for a given platform; returns undefined for unknown platforms. */
export function getPlatformSpec(platform: string): PlatformSpec | undefined {
  return PLATFORM_SPECS[platform];
}
