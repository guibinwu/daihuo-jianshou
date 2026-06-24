/**
 * 免 Key 发布文案包 —— 不配 LLM 也能在导出页「复制即发」。
 * 按品类 + 平台映射热门话题标签，用痛点/数字/情绪钩子模板拼标题与种草文案。
 * 纯函数、确定性（同输入同输出），可单测；配了 LLM 的用户仍走 /api/llm/publish 拿更优文案。
 */

export interface PublishPack {
  titles: string[];
  hashtags: string[]; // 已带 # 前缀、去重
  caption: string;
}

export interface PublishPackInput {
  productName?: string;
  category?: string; // beauty/food/home/fashion/digital/other
  sellingPoints?: string; // 卖点/描述，可多句
  platform?: string; // douyin/kuaishou/xiaohongshu/tiktok
}

// 品类热门话题（贴合抖音/快手/小红书带货语境）
const CATEGORY_TAGS: Record<string, string[]> = {
  beauty: ["好物分享", "美妆", "护肤", "变美", "平价好物", "种草"],
  food: ["美食", "好吃推荐", "零食", "吃货日常", "干饭人", "种草"],
  home: ["家居好物", "居家生活", "生活好物", "收纳", "好物推荐", "种草"],
  fashion: ["穿搭", "时尚", "OOTD", "穿搭分享", "好物分享", "种草"],
  digital: ["数码", "数码好物", "科技", "实用好物", "好物推荐", "种草"],
  other: ["好物推荐", "种草", "好物分享", "值得买", "宝藏好物", "日常分享"],
};

// 平台热门话题
const PLATFORM_TAGS: Record<string, string[]> = {
  douyin: ["抖音好物", "抖音电商"],
  kuaishou: ["快手好物", "快手电商"],
  xiaohongshu: ["小红书", "好物推荐"],
  tiktok: ["TikTokMadeMeBuyIt", "TikTokShop"],
};

/** 取第一条卖点：按中英标点/换行切，去空白，限长 */
function firstSellingPoint(sp?: string): string {
  if (!sp) return "";
  const first = sp.split(/[。.,，;；\n、]/).map((s) => s.trim()).find((s) => s.length > 0) || "";
  return clip(first, 12);
}

/** 按显示宽度近似裁剪（CJK 记 1，避免标题过长） */
function clip(s: string, max: number): string {
  const arr = Array.from(s.trim());
  return arr.length <= max ? s.trim() : arr.slice(0, max).join("").trim();
}

export function buildPublishPack(input: PublishPackInput): PublishPack {
  const name = clip((input.productName || "").trim() || "这款好物", 16);
  const cat = (input.category || "other").toLowerCase();
  const point = firstSellingPoint(input.sellingPoints);

  // 标题：情绪 + 卖点/数字钩子，三条不同角度
  const titles = [
    clip(`${name}也太好用了吧！后悔没早买`, 22),
    clip(point ? `${name}｜${point}，谁用谁回购` : `${name}，闭眼入不踩雷`, 22),
    clip(`三个理由让你入手${name}`, 22),
  ];

  // 话题：品类 + 平台，去重、带 #、控制在 ~10 个内
  const platform = (input.platform || "").toLowerCase();
  const tagWords = [
    ...(CATEGORY_TAGS[cat] || CATEGORY_TAGS.other),
    ...(PLATFORM_TAGS[platform] || []),
  ];
  const seen = new Set<string>();
  const hashtags: string[] = [];
  for (const w of tagWords) {
    const tag = `#${w}`;
    if (seen.has(tag)) continue;
    seen.add(tag);
    hashtags.push(tag);
    if (hashtags.length >= 10) break;
  }

  // 种草文案：口语化 + 行动号召（挂车）。先裁前半句，再固定拼挂车号召，保证 CTA 尾巴不被整体裁断
  const cta = "，点下方小黄车带走它～";
  const lead = `${name}真的绝了${point ? "，" + point : ""}`;
  const caption = clip(lead, 40 - Array.from(cta).length) + cta;

  return { titles, hashtags, caption };
}
