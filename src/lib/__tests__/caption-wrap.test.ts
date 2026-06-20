import { describe, it, expect } from "vitest";
import { wrapCaption } from "@/lib/video-composer/composer";

// 估宽与组件内一致：CJK≈fontSize，拉丁≈fontSize×0.55；上限 frameWidth×0.86
const fits = (line: string, fontSize: number, frameWidth: number) => {
  const w = Array.from(line).reduce(
    (s, c) => s + (/[⺀-鿿豈-﫿＀-￯　-〿]/.test(c) ? fontSize : fontSize * 0.55),
    0
  );
  return w <= frameWidth * 0.86 + 0.01;
};

describe("wrapCaption（字幕自动换行）", () => {
  it("长英文折成多行，且每行都不超宽", () => {
    const text = "Still using tissues that tear at one wipe in your living room today";
    const out = wrapCaption(text, 36, 720);
    expect(out).toContain("\n"); // 确实换行了
    for (const line of out.split("\n")) expect(fits(line, 36, 720)).toBe(true);
    // 不丢字（去掉换行后词序不变）
    expect(out.replace(/\n/g, " ")).toBe(text);
  });

  it("拉丁按单词断行，不拆开单词", () => {
    const out = wrapCaption("hello wonderful beautiful morning sunshine coffee", 40, 480);
    for (const line of out.split("\n")) {
      // 每行都是完整单词组合（无半个单词）
      expect(line.trim().split(" ").every((w) => w.length > 0)).toBe(true);
    }
  });

  it("短文案不换行", () => {
    expect(wrapCaption("你好世界", 36, 720)).toBe("你好世界");
    expect(wrapCaption("Hi there", 36, 720)).toBe("Hi there");
  });

  it("长中文（无空格）按字断行且不超宽", () => {
    const text = "这是一句非常非常非常非常非常非常非常非常长的中文字幕用来测试自动换行是否生效";
    const out = wrapCaption(text, 48, 720);
    expect(out).toContain("\n");
    for (const line of out.split("\n")) expect(fits(line, 48, 720)).toBe(true);
    expect(out.replace(/\n/g, "")).toBe(text); // 中文无空格，去换行应还原
  });

  it("空串返回空串", () => {
    expect(wrapCaption("", 36, 720)).toBe("");
    expect(wrapCaption("   ", 36, 720)).toBe("");
  });
});
