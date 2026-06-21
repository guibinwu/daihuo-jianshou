import { describe, it, expect } from "vitest";
import {
  buildAssetRows,
  pendingShotCount,
  shouldOfferStockFill,
  type SavedAssetRow,
} from "@/lib/assets-view";
import type { Shot } from "@/lib/db/schema";

// 造一个最小可用的分镜
function shot(partial: Partial<Shot> & { shotId: number }): Shot {
  return {
    shotId: partial.shotId,
    type: partial.type ?? "hook",
    duration: partial.duration ?? 3,
    description: partial.description ?? `镜头${partial.shotId}`,
    camera: partial.camera ?? "static",
    visualSource: partial.visualSource ?? "ai_generate",
    transition: partial.transition ?? "ffmpeg_fade",
    voiceover: partial.voiceover ?? "",
    prompt: partial.prompt ?? "",
    stockKeywords: partial.stockKeywords,
  };
}

describe("buildAssetRows", () => {
  it("已落库且就绪的素材 → 就绪并带缩略图，透传 assetType", () => {
    const shots = [shot({ shotId: 1, visualSource: "ai_generate" })];
    const saved: SavedAssetRow[] = [
      { shotId: 1, filePath: "/api/files/p1/stock/a.jpg", status: "done", type: "stock_footage" },
    ];
    const rows = buildAssetRows(shots, saved, []);
    expect(rows[0].status).toBe("done");
    expect(rows[0].thumbnailUrl).toBe("/api/files/p1/stock/a.jpg");
    expect(rows[0].assetType).toBe("stock_footage");
  });

  it("未就绪的落库素材（status 非 done）不算就绪", () => {
    const shots = [shot({ shotId: 1 })];
    const saved: SavedAssetRow[] = [{ shotId: 1, filePath: "/x.jpg", status: "pending" }];
    const rows = buildAssetRows(shots, saved, []);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].thumbnailUrl).toBeUndefined();
  });

  it("商品原图分镜 → 用首张商品图直接就绪", () => {
    const shots = [shot({ shotId: 1, visualSource: "product_image" })];
    const rows = buildAssetRows(shots, [], ["/uploads/prod.jpg"]);
    expect(rows[0].status).toBe("done");
    expect(rows[0].thumbnailUrl).toBe("/uploads/prod.jpg");
  });

  it("普通 AI 分镜无素材 → 待生成", () => {
    const shots = [shot({ shotId: 1, visualSource: "ai_generate" })];
    const rows = buildAssetRows(shots, [], []);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].thumbnailUrl).toBeUndefined();
  });

  it("落库素材覆盖商品图（已生成优先于商品原图兜底）", () => {
    const shots = [shot({ shotId: 1, visualSource: "product_image" })];
    const saved: SavedAssetRow[] = [
      { shotId: 1, filePath: "/api/files/p1/a.png", status: "done", type: "ai_generated" },
    ];
    const rows = buildAssetRows(shots, saved, ["/uploads/prod.jpg"]);
    expect(rows[0].thumbnailUrl).toBe("/api/files/p1/a.png");
    expect(rows[0].assetType).toBe("ai_generated");
  });
});

describe("pendingShotCount", () => {
  it("统计 pending 分镜数", () => {
    const rows = buildAssetRows(
      [shot({ shotId: 1 }), shot({ shotId: 2, visualSource: "product_image" }), shot({ shotId: 3 })],
      [],
      ["/p.jpg"],
    );
    // shot1/shot3 pending，shot2 用商品图就绪
    expect(pendingShotCount(rows)).toBe(2);
  });
});

describe("shouldOfferStockFill", () => {
  const topicRows = buildAssetRows([shot({ shotId: 1 }), shot({ shotId: 2 })], [], []);

  it("topic 项目（无商品一句话成片）→ 提供自动配画面", () => {
    expect(shouldOfferStockFill(topicRows, "topic", 0)).toBe(true);
  });

  it("无商品图且有待配分镜 → 提供（即便不是 topic）", () => {
    expect(shouldOfferStockFill(topicRows, "product", 0)).toBe(true);
  });

  it("带商品项目且已全部就绪 → 不提供", () => {
    const rows = buildAssetRows([shot({ shotId: 1, visualSource: "product_image" })], [], ["/p.jpg"]);
    expect(shouldOfferStockFill(rows, "product", 1)).toBe(false);
  });

  it("空分镜 → 不提供", () => {
    expect(shouldOfferStockFill([], "topic", 0)).toBe(false);
  });
});
