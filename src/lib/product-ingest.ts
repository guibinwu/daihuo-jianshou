/**
 * 商品链接一键 ingest —— 贴一个商品页 URL，自动抽取「标题 / 价格 / 描述 / 商品图」。
 *
 * 这是 2026 带货工作流的标准入口（Creatify/即创/Pippit 都以「贴商品链接」而非「写提示词」起步）。
 * 抽取优先级：JSON-LD(schema.org Product) > OpenGraph > Twitter Card > <title>/<meta description>。
 * 纯函数（解析与网络分离），可单测；下游交给现有 analyzeProduct + 脚本引擎提炼卖点。
 */

export interface ProductIngest {
  title: string;
  priceText?: string;
  description?: string;
  images: string[]; // 绝对 URL，已去重
  sourceUrl: string;
}

const CURRENCY_SYMBOL: Record<string, string> = {
  USD: "$", CNY: "¥", RMB: "¥", EUR: "€", GBP: "£", JPY: "¥", HKD: "HK$", TWD: "NT$", KRW: "₩", AUD: "A$", CAD: "C$",
};

/** 解码常见 HTML 实体（meta content 里常见 &amp; &#39; 等） */
export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 取某个 meta（property 或 name）的 content，兼容属性顺序两种写法 */
export function getMeta(html: string, keys: string[]): string | undefined {
  for (const key of keys) {
    const k = escapeRe(key);
    const m =
      html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`, "i")) ||
      html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, "i"));
    if (m && m[1].trim()) return decodeEntities(m[1]);
  }
  return undefined;
}

/** 把可能相对的 URL 解析为绝对 URL；失败返回原值 */
export function toAbsolute(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

// ==================== JSON-LD ====================

/* eslint-disable @typescript-eslint/no-explicit-any */
function findProductNode(data: any): any | undefined {
  if (!data || typeof data !== "object") return undefined;
  if (Array.isArray(data)) {
    for (const d of data) {
      const f = findProductNode(d);
      if (f) return f;
    }
    return undefined;
  }
  const type = data["@type"];
  if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) return data;
  if (data["@graph"]) return findProductNode(data["@graph"]);
  return undefined;
}

/** 从 JSON-LD script 块里找 schema.org Product 节点 */
export function extractJsonLdProduct(html: string): any | undefined {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const node = findProductNode(JSON.parse(m[1].trim()));
      if (node) return node;
    } catch {
      /* 单个块非法 JSON 则跳过 */
    }
  }
  return undefined;
}

function jsonLdPrice(node: any): string | undefined {
  const offers = Array.isArray(node.offers) ? node.offers[0] : node.offers;
  const price = offers?.price ?? offers?.lowPrice ?? offers?.highPrice;
  if (price == null || price === "") return undefined;
  const cur = (offers?.priceCurrency || node.priceCurrency || "").toUpperCase();
  const sym = CURRENCY_SYMBOL[cur] ?? (cur ? `${cur} ` : "");
  return `${sym}${price}`;
}

function jsonLdImages(node: any): string[] {
  const img = node.image;
  if (!img) return [];
  const arr = Array.isArray(img) ? img : [img];
  return arr.map((x: any) => (typeof x === "string" ? x : x?.url)).filter((x: any): x is string => typeof x === "string" && x.length > 0);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ==================== 主解析 ====================

/** 从商品页 HTML 解析出商品信息（JSON-LD 优先，OG/Twitter/title 兜底） */
export function parseProductFromHtml(html: string, baseUrl: string): ProductIngest {
  const ld = extractJsonLdProduct(html);

  // 标题
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const title =
    (ld?.name && decodeEntities(String(ld.name))) ||
    getMeta(html, ["og:title", "twitter:title"]) ||
    (titleTag && decodeEntities(titleTag)) ||
    "";

  // 价格
  const ogPrice = getMeta(html, ["product:price:amount", "og:price:amount"]);
  const ogCur = (getMeta(html, ["product:price:currency", "og:price:currency"]) || "").toUpperCase();
  const priceText =
    (ld && jsonLdPrice(ld)) ||
    (ogPrice ? `${CURRENCY_SYMBOL[ogCur] ?? (ogCur ? `${ogCur} ` : "")}${ogPrice}` : undefined);

  // 描述
  const description =
    (ld?.description && decodeEntities(String(ld.description))) ||
    getMeta(html, ["og:description", "twitter:description", "description"]);

  // 图片：JSON-LD + OG + Twitter，全部转绝对、去重、取前若干
  const raw: string[] = [
    ...jsonLdImages(ld ?? {}),
    ...(getMeta(html, ["og:image", "og:image:secure_url"]) ? [getMeta(html, ["og:image", "og:image:secure_url"])!] : []),
    ...(getMeta(html, ["twitter:image", "twitter:image:src"]) ? [getMeta(html, ["twitter:image", "twitter:image:src"])!] : []),
  ];
  const seen = new Set<string>();
  const images: string[] = [];
  for (const u of raw) {
    if (!u) continue;
    const abs = toAbsolute(decodeEntities(u), baseUrl);
    if (!/^https?:\/\//i.test(abs)) continue;
    if (seen.has(abs)) continue;
    seen.add(abs);
    images.push(abs);
  }

  return { title: title.trim(), priceText, description, images, sourceUrl: baseUrl };
}
