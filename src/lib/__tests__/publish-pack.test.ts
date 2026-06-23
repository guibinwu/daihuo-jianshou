import { describe, it, expect } from "vitest";
import { buildPublishPack } from "@/lib/publish-pack";

describe("buildPublishPack（免 Key 发布文案包）", () => {
  it("产出 3 条标题，均含商品名", () => {
    const p = buildPublishPack({ productName: "云柔抽纸", category: "home" });
    expect(p.titles).toHaveLength(3);
    for (const t of p.titles) expect(t).toContain("云柔抽纸");
  });

  it("话题按品类映射、带 # 前缀、去重", () => {
    const p = buildPublishPack({ productName: "精华液", category: "beauty" });
    expect(p.hashtags).toContain("#美妆");
    expect(p.hashtags.every((h) => h.startsWith("#"))).toBe(true);
    expect(new Set(p.hashtags).size).toBe(p.hashtags.length); // 无重复
    expect(p.hashtags.length).toBeLessThanOrEqual(10);
  });

  it("平台话题追加（抖音→#抖音好物）", () => {
    const p = buildPublishPack({ productName: "x", category: "food", platform: "douyin" });
    expect(p.hashtags).toContain("#抖音好物");
  });

  it("未知品类回退到通用话题", () => {
    const p = buildPublishPack({ productName: "x", category: "不存在的品类" });
    expect(p.hashtags).toContain("#好物推荐");
  });

  it("种草文案含商品名与挂车号召", () => {
    const p = buildPublishPack({ productName: "神奇拖把", category: "home" });
    expect(p.caption).toContain("神奇拖把");
    expect(p.caption).toContain("小黄车");
  });

  it("卖点会被带进标题/文案", () => {
    const p = buildPublishPack({ productName: "面膜", category: "beauty", sellingPoints: "熬夜急救，第二天满血复活" });
    expect(p.titles.join("") + p.caption).toContain("熬夜急救");
  });

  it("空商品名回退占位、不抛错", () => {
    const p = buildPublishPack({});
    expect(p.titles).toHaveLength(3);
    expect(p.titles[0]).toContain("这款好物");
    expect(p.caption.length).toBeGreaterThan(0);
  });

  it("确定性：同输入同输出", () => {
    const a = buildPublishPack({ productName: "耳机", category: "digital", platform: "kuaishou" });
    const b = buildPublishPack({ productName: "耳机", category: "digital", platform: "kuaishou" });
    expect(a).toEqual(b);
  });

  it("标题做长度裁剪（不会过长）", () => {
    const p = buildPublishPack({ productName: "这是一个名字特别特别特别长的商品超出限制了", category: "other" });
    for (const t of p.titles) expect(Array.from(t).length).toBeLessThanOrEqual(22);
  });
});
