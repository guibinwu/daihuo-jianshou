import type { Shot } from "@/lib/db/schema";

/**
 * 素材页视图行：由「选中脚本的分镜」+「已落库素材」派生。
 * 纯数据，无 React 依赖，供素材页初次加载与配画面后刷新复用（可单测）。
 */
export interface AssetItem {
  shotId: number;
  type: Shot["type"];
  duration: number;
  description: string;
  prompt: string;
  visualSource: Shot["visualSource"];
  status: "pending" | "generating" | "done" | "failed";
  thumbnailUrl?: string;
  error?: string;
  /** 素材是否为视频（已转动态镜头/图生视频） */
  isVideo?: boolean;
  /** 已落库素材的真实类型（如 stock_footage 表示免费素材库自动配的画面） */
  assetType?: string;
}

/** GET /api/project/[id]/assets 返回行里本函数关心的子集 */
export interface SavedAssetRow {
  shotId: number;
  filePath?: string | null;
  status?: string | null;
  type?: string | null;
}

/**
 * 把「选中脚本分镜 + 已落库素材」合成素材页视图行。
 * - 已落库且就绪的素材（filePath 为 /api/files 可访问路径）→ 直接就绪并带缩略图；
 * - 商品原图分镜（product_image）→ 用首张商品图就绪；
 * - 其余分镜 → 待生成（pending）。
 * 纯函数，初次加载与「自动配画面」后刷新共用，保证两条路径行为一致。
 */
export function buildAssetRows(
  shots: Shot[],
  savedAssets: SavedAssetRow[],
  productImages: string[],
): AssetItem[] {
  // 已落库且就绪的素材按 shotId 索引
  const savedByShot = new Map<number, SavedAssetRow>();
  for (const a of savedAssets) {
    if (a && a.filePath && a.status === "done") savedByShot.set(a.shotId, a);
  }
  const firstProduct = productImages[0];

  return shots.map((s) => {
    const saved = savedByShot.get(s.shotId);
    if (saved && saved.filePath) {
      return {
        shotId: s.shotId,
        type: s.type,
        duration: s.duration,
        description: s.description,
        prompt: s.prompt ?? "",
        visualSource: s.visualSource,
        status: "done" as const,
        thumbnailUrl: saved.filePath,
        assetType: saved.type ?? undefined,
      };
    }
    return {
      shotId: s.shotId,
      type: s.type,
      duration: s.duration,
      description: s.description,
      prompt: s.prompt ?? "",
      visualSource: s.visualSource,
      status: s.visualSource === "product_image" ? ("done" as const) : ("pending" as const),
      thumbnailUrl: s.visualSource === "product_image" ? firstProduct : undefined,
    };
  });
}

/** 仍待配画面（pending）的分镜数 */
export function pendingShotCount(rows: AssetItem[]): number {
  return rows.filter((r) => r.status === "pending").length;
}

/**
 * 是否应展示「自动配画面（免费素材）」入口：
 * topic（无商品一句话成片）项目，或没有商品图、却仍有待配画面分镜的项目——
 * 这些场景靠免费素材库（keyless Openverse 图片）配画面，无需 AI 生图 Key。
 */
export function shouldOfferStockFill(
  rows: AssetItem[],
  contentType: string | undefined,
  productImageCount: number,
): boolean {
  if (rows.length === 0) return false;
  const isTopic = contentType === "topic";
  return isTopic || (productImageCount === 0 && pendingShotCount(rows) > 0);
}
