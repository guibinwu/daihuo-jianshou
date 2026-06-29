/**
 * 脚本生成器
 * 使用 OpenAI 兼容格式调用 LLM 生成带货短视频脚本
 * 支持自定义 LLM endpoint、流式输出、商品图片分析
 */

import OpenAI from "openai";
import {
  SYSTEM_PROMPT,
  PRODUCT_ANALYSIS_PROMPT,
  TOPIC_SYSTEM_PROMPT,
  buildUserPrompt,
  buildBatchPrompt,
  buildTopicBatchPrompt,
  type ScriptGenerationInput,
  type TopicScriptInput,
} from "./prompts";
import type { Shot } from "@/lib/db/schema";

// ==================== 类型定义 ====================

/** LLM 配置 */
export interface LLMConfig {
  /** API 地址（兼容 OpenAI 格式的任意 endpoint） */
  baseUrl: string;
  /** API 密钥 */
  apiKey: string;
  /** 文本模型名称 */
  model: string;
  /** 视觉模型名称（用于商品图片分析，不指定则使用 model） */
  visionModel?: string;
}

/** 脚本生成输入参数 */
export interface ScriptInput extends ScriptGenerationInput {
  /** LLM 配置 */
  llmConfig: LLMConfig;
}

/** 生成的脚本结果 */
export interface GeneratedScript {
  /** 脚本标题 */
  title: string;
  /** 脚本风格 */
  styleType: string;
  /** 总时长（秒） */
  totalDuration: number;
  /** 分镜列表 */
  shots: Shot[];
}

/** 流式输出回调 */
export interface StreamCallbacks {
  /** 收到文本片段时触发 */
  onToken?: (token: string) => void;
  /** 生成完成时触发 */
  onComplete?: (scripts: GeneratedScript[]) => void;
  /** 发生错误时触发 */
  onError?: (error: Error) => void;
}

/** 商品分析结果 */
export interface ProductAnalysisResult {
  /** 商品名称 */
  productName: string;
  /** 品类 */
  category: string;
  /** 品牌 */
  brand: string;
  /** 视觉特征 */
  visualFeatures: {
    mainColor: string;
    designStyle: string;
    productForm: string;
    texture: string;
  };
  /** 卖点列表 */
  sellingPoints: string[];
  /** 目标用户 */
  targetAudience: string;
  /** 使用场景 */
  usageScenarios: string[];
  /** 痛点 */
  painPoints: string[];
  /** 视频建议 */
  videoSuggestions: {
    recommendedAngles: string[];
    keyVisuals: string[];
    suggestedStyle: string;
  };
}

// ==================== 工具函数 ====================

/** 创建 OpenAI 客户端 */
function createClient(config: LLMConfig): OpenAI {
  return new OpenAI({
    baseURL: config.baseUrl,
    // 本地/免费 OpenAI 兼容端点（Ollama、Pollinations）无需真 Key；SDK 要求非空，缺省给占位符
    apiKey: config.apiKey || "no-key",
  });
}

/**
 * 从 LLM 返回的文本中提取 JSON
 * 兼容直接输出 JSON 和包裹在 markdown 代码块中的情况
 */
export function extractJSON(text: string): string {
  // 尝试移除 markdown 代码块标记
  const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // 尝试找到第一个 { 或 [ 开头的 JSON
  const jsonMatch = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    return jsonMatch[1].trim();
  }

  return text.trim();
}

/**
 * 给「JSON 解析失败」的错误补一句可操作提示：以 {/[ 开头却未以 }/] 收尾，
 * 多半是 max_tokens 截断了输出——提示增大 token 上限，而非干巴巴的「非法 JSON」。
 */
function truncationHint(jsonStr: string): string {
  return /^[{[]/.test(jsonStr) && !/[}\]]\s*$/.test(jsonStr) ? "（输出疑似被截断，请增大 max_tokens 后重试）" : "";
}

/**
 * 验证并修正单个 Shot 数据
 * 确保所有必填字段都有合法值
 */
function validateShot(shot: Partial<Shot>, index: number): Shot {
  const validTypes: Shot["type"][] = ["hook", "pain_point", "product_reveal", "demo", "social_proof", "cta"];
  const validTransitions: Shot["transition"][] = ["ai_start_end", "ai_reference", "direct_concat", "ffmpeg_fade"];
  const validSources: Shot["visualSource"][] = ["ai_generate", "product_image", "user_upload"];

  const validMotions: NonNullable<Shot["motion"]>[] = ["zoom_in_slow", "pan_left", "pan_right", "ken_burns", "static"];

  // 解析 LLM 产出的英文素材检索词（字段名 searchTerms 或 stockKeywords），取前 3 个非空字符串
  const rawTerms = (shot as Record<string, unknown>).searchTerms ?? shot.stockKeywords;
  const stockKeywords = Array.isArray(rawTerms)
    ? rawTerms.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim()).slice(0, 3)
    : undefined;

  return {
    shotId: shot.shotId || index + 1,
    type: validTypes.includes(shot.type as Shot["type"]) ? (shot.type as Shot["type"]) : "demo",
    duration: typeof shot.duration === "number" && shot.duration > 0 ? shot.duration : 3,
    description: shot.description || "",
    camera: shot.camera || "固定镜头",
    visualSource: validSources.includes(shot.visualSource as Shot["visualSource"]) ? (shot.visualSource as Shot["visualSource"]) : "ai_generate",
    // 默认转场与 schema(videoClips.transitionType) 及 UI 默认保持一致（ai_start_end）
    transition: validTransitions.includes(shot.transition as Shot["transition"]) ? (shot.transition as Shot["transition"]) : "ai_start_end",
    voiceover: shot.voiceover || "",
    prompt: shot.prompt || undefined,
    // 透传 LLM 按视频模式生成的扩展字段，避免被静默丢弃
    ...(stockKeywords?.length && { stockKeywords }),
    ...(shot.characterId && { characterId: shot.characterId }),
    ...(validMotions.includes(shot.motion as NonNullable<Shot["motion"]>) && { motion: shot.motion }),
    ...(shot.textOverlay?.text && {
      textOverlay: {
        text: shot.textOverlay.text,
        style: shot.textOverlay.style ?? "subtitle",
      },
    }),
  };
}

/**
 * 验证并修正完整的脚本数据
 */
function validateScript(raw: Record<string, unknown>, fallbackStyleType: string): GeneratedScript {
  const shots = Array.isArray(raw.shots)
    ? (raw.shots as Partial<Shot>[]).map((s, i) => validateShot(s, i))
    : [];

  const totalDuration = typeof raw.totalDuration === "number"
    ? raw.totalDuration
    : shots.reduce((sum, s) => sum + s.duration, 0);

  return {
    title: (raw.title as string) || "未命名脚本",
    styleType: (raw.styleType as string) || fallbackStyleType,
    totalDuration,
    shots,
  };
}

// ==================== 核心功能 ====================

/**
 * 生成带货脚本（单次调用，返回完整结果）
 * @param input - 脚本生成输入参数
 * @returns 生成的脚本数组
 */
export async function generateScript(input: ScriptInput): Promise<GeneratedScript[]> {
  const client = createClient(input.llmConfig);
  const userPrompt = buildBatchPrompt(input, 3);

  // 调用 LLM 生成脚本
  let response;
  try {
    response = await client.chat.completions.create({
      model: input.llmConfig.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.8,
      max_tokens: 16000,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`LLM 请求失败（模型: ${input.llmConfig.model}，地址: ${input.llmConfig.baseUrl}）: ${msg}`);
  }

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM 未返回有效内容");
  }

  return parseScriptResponse(content, input.styleType);
}

/** 主题成片脚本生成输入（一句话主题 + LLM 配置） */
export interface TopicScriptGenInput extends TopicScriptInput {
  llmConfig: LLMConfig;
  /** 生成几套方案，默认 3 */
  count?: number;
}

/**
 * 生成「一句话主题成片」脚本（去商品化，每个分镜带英文检索词供自动配画面）
 * @param input - 主题 + LLM 配置
 * @returns 生成的脚本数组（含 stockKeywords，可直接喂给 stock-fill 配齐画面）
 */
export async function generateTopicScript(input: TopicScriptGenInput): Promise<GeneratedScript[]> {
  const client = createClient(input.llmConfig);
  const userPrompt = buildTopicBatchPrompt(input, input.count ?? 3);

  let response;
  try {
    response = await client.chat.completions.create({
      model: input.llmConfig.model,
      messages: [
        { role: "system", content: TOPIC_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.85,
      max_tokens: 16000,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`LLM 请求失败（模型: ${input.llmConfig.model}，地址: ${input.llmConfig.baseUrl}）: ${msg}`);
  }

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM 未返回有效内容");
  }

  // 主题成片没有带货风格概念，统一回退为 "custom"
  return parseScriptResponse(content, "custom");
}

/**
 * 生成单个脚本（更快的响应）
 * @param input - 脚本生成输入参数
 * @returns 单个生成的脚本
 */
export async function generateSingleScript(input: ScriptInput): Promise<GeneratedScript> {
  const client = createClient(input.llmConfig);
  const userPrompt = buildUserPrompt(input);

  const response = await client.chat.completions.create({
    model: input.llmConfig.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.8,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM 未返回有效内容");
  }

  const jsonStr = extractJSON(content);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`LLM 返回的内容不是合法 JSON${truncationHint(jsonStr)}: ${jsonStr.substring(0, 200)}`);
  }
  return validateScript(parsed, input.styleType);
}

/**
 * 流式生成脚本
 * 支持实时获取生成进度，适合前端流式展示
 * @param input - 脚本生成输入参数
 * @param callbacks - 流式回调函数
 * @returns AbortController 用于取消生成
 */
export function generateScriptStream(
  input: ScriptInput,
  callbacks: StreamCallbacks,
): AbortController {
  const abortController = new AbortController();

  const run = async () => {
    const client = createClient(input.llmConfig);
    const userPrompt = buildUserPrompt(input);

    let fullContent = "";

    try {
      const stream = await client.chat.completions.create({
        model: input.llmConfig.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.8,
        stream: true,
      }, {
        signal: abortController.signal,
      });

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          fullContent += delta;
          callbacks.onToken?.(delta);
        }
      }

      // 流式结束后解析完整结果
      const scripts = parseScriptResponse(fullContent, input.styleType);
      callbacks.onComplete?.(scripts);
    } catch (error) {
      // 用户主动取消不算错误
      if (abortController.signal.aborted) return;
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  run();
  return abortController;
}

/**
 * 创建流式生成的 ReadableStream
 * 用于 Next.js API Route 的流式响应
 * @param input - 脚本生成输入参数
 * @returns ReadableStream
 */
export function createScriptStream(input: ScriptInput): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const client = createClient(input.llmConfig);
      const userPrompt = buildUserPrompt(input);

      try {
        const stream = await client.chat.completions.create({
          model: input.llmConfig.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.8,
          stream: true,
        });

        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (delta) {
            controller.enqueue(encoder.encode(delta));
          }
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

// ==================== 商品图片分析 ====================

/**
 * 分析商品图片
 * 调用视觉模型提取商品信息、卖点、目标用户等
 * @param imageUrls - 商品图片 URL 列表（支持 http/https 和 base64 data URI）
 * @param config - LLM 配置
 * @returns 商品分析结果的 JSON 字符串
 */
export async function analyzeProduct(
  imageUrls: string[],
  config: LLMConfig,
): Promise<string> {
  const client = createClient(config);
  const model = config.visionModel || config.model;

  // 构建带图片的消息内容
  const imageContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] = imageUrls.map(
    (url) => ({
      type: "image_url" as const,
      image_url: { url, detail: "high" as const },
    }),
  );

  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: PRODUCT_ANALYSIS_PROMPT },
          ...imageContent,
        ],
      },
    ],
    temperature: 0.3,
    max_tokens: 2000,
  });

  return response.choices[0]?.message?.content || "";
}

/**
 * 分析商品图片并返回结构化数据
 * @param imageUrls - 商品图片 URL 列表
 * @param config - LLM 配置
 * @returns 结构化的商品分析结果
 */
export async function analyzeProductStructured(
  imageUrls: string[],
  config: LLMConfig,
): Promise<ProductAnalysisResult> {
  const rawResult = await analyzeProduct(imageUrls, config);
  const jsonStr = extractJSON(rawResult);
  try {
    return JSON.parse(jsonStr) as ProductAnalysisResult;
  } catch {
    throw new Error(`商品分析结果不是合法 JSON${truncationHint(jsonStr)}: ${jsonStr.substring(0, 200)}`);
  }
}

// ==================== 解析工具 ====================

/**
 * 解析 LLM 返回的脚本内容
 * 兼容多种返回格式（单个对象、数组、嵌套对象等）
 */
export function parseScriptResponse(content: string, fallbackStyleType: string): GeneratedScript[] {
  const jsonStr = extractJSON(content);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(`LLM 返回的内容不是合法 JSON${truncationHint(jsonStr)}: ${jsonStr.substring(0, 200)}`);
  }

  // 处理不同的返回格式
  let rawScripts: Record<string, unknown>[];

  if (Array.isArray(parsed)) {
    // 直接返回数组
    rawScripts = parsed;
  } else if (parsed.scripts && Array.isArray(parsed.scripts)) {
    // { scripts: [...] } 格式
    rawScripts = parsed.scripts;
  } else if (parsed.shots && Array.isArray(parsed.shots)) {
    // 单个脚本对象
    rawScripts = [parsed];
  } else {
    throw new Error("无法解析 LLM 返回的脚本格式");
  }

  // 丢弃没有任何分镜的脚本（LLM 偶尔返回只有 title、缺 shots 的残缺条目）；
  // 全部为空则抛错——否则会把「零分镜脚本」当成功落库，下游配画面/合成无米可炊却不报错。
  // 先滤掉 null/非对象元素：LLM 偶尔产出 [null, {...}]，validateScript 首行读 raw.shots 会对 null 抛错、连累整次解析。
  const scripts = rawScripts
    .filter((raw): raw is Record<string, unknown> => typeof raw === "object" && raw !== null)
    .map((raw) => validateScript(raw, fallbackStyleType))
    .filter((s) => s.shots.length > 0);
  if (scripts.length === 0) {
    throw new Error("LLM 未生成有效分镜（脚本为空），请重试或调整输入");
  }
  return scripts;
}
