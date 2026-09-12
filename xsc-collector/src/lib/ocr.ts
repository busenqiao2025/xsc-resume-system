// v1.4: 获奖证书 OCR 自动识别引擎
// architecture.md 13.2 / 13.3 / 13.4
//
// 核心设计：
// - 双轨架构：默认 Workers AI（@cf/google/gemma-3-12b-it）；可选外部多模态 LLM
// - Prompt 注入当前城市 CITY_CONFIGS[city].cups 字典，强制 JSON 输出对齐 AwardContent
// - 缓存：相同 attachment 不重复 OCR（ocr_cache 表）
//
// 所有外部 API key 走 wrangler secret，源码/前端都不接触密钥。

import type { CupItem } from "./city-configs";

/** OCR 输出的结构化字段（与 AwardContent 对齐，architecture.md 13.3 字段映射表） */
export interface OCRAwardFields {
  name: string;
  cup_short: string;
  cup_tier: string;
  subject: string;
  org: string;
  level: string;
  rank: string;
  date: string;
  description: string;
}

/** 视觉识别 provider（awards / talents / works 三条业务线共用） */
export type OCRProvider = "workers_ai" | "openai" | "google" | "qwen";

export interface OCRAwardResult {
  source: "cache" | "workers_ai" | "external";
  provider: OCRProvider;
  model: string;
  duration_ms: number;
  confidence: "high" | "medium" | "low";
  fields: OCRAwardFields;
  matched_dict_entry?: CupItem | null;
  raw_text: string;
  hints: string[];
}

/** 枚举收口（与前端 AwardContent 约束一致） */
const SUBJECT_ENUM = ["数学", "英语", "科创", "信息学", "语文", "艺术", "体育", "综合", ""];
const LEVEL_ENUM = ["国家级", "省级", "市级", "区级", "校级", ""];
const TIER_ENUM = ["T1", "T2", "T3", "T4", ""];

/** 归一化：剥离枚举外的值 */
function pickEnum(value: unknown, allowed: string[]): string {
  if (typeof value !== "string") return "";
  const v = value.trim();
  return allowed.includes(v) ? v : "";
}

/** 强制把 date 标准化为 YYYY-MM；解析失败返回空 */
function normalizeDate(value: unknown): string {
  if (typeof value !== "string") return "";
  const s = value.trim();
  // 形如 "2025-06" / "2025.06" / "2025年6月" / "2025年06月" / "2025-06-15" / "2025/6" / "2025-6"
  const m1 = s.match(/^(\d{4})[-\.\/年](\d{1,2})月?(?:日)?$/);
  if (m1) {
    const y = m1[1];
    const mo = m1[2].padStart(2, "0");
    return `${y}-${mo}`;
  }
  const m2 = s.match(/^(\d{4})[-\.\/](\d{1,2})[-\.\/](\d{1,2})/);
  if (m2) {
    return `${m2[1]}-${m2[2].padStart(2, "0")}`;
  }
  const m3 = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})[日号]?$/);
  if (m3) {
    return `${m3[1]}-${m3[2].padStart(2, "0")}`;
  }
  return "";
}

/** 把 LLM 自由输出归一化为受控结构 */
export function sanitizeFields(raw: unknown, cups: CupItem[]): { fields: OCRAwardFields; matched: CupItem | null; hints: string[] } {
  const hints: string[] = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  // 1. 先按 name 在 cups 里模糊匹配
  const rawName = String(o.name || "").trim();
  let matched: CupItem | null = null;
  if (rawName) {
    // 优先精确等于字典 name
    matched = cups.find((c) => c.name === rawName) || null;
    if (!matched) {
      // 次选：字典 name 包含 rawName 或 rawName 包含字典 name
      matched =
        cups.find(
          (c) => rawName.includes(c.name) || c.name.includes(rawName)
        ) || null;
    }
    if (!matched) {
      // 再次：按 short 黑话匹配（LLM 偶尔返回「华杯」而非全称）
      matched = cups.find((c) => rawName.includes(c.short)) || null;
    }
  }

  // 2. 用字典里的标准化字段覆盖 LLM 输出
  const name = matched ? matched.name : rawName;
  const cup_short = matched ? matched.short : String(o.cup_short || "").trim();
  const cup_tier = pickEnum(matched ? matched.tier : o.cup_tier, TIER_ENUM);
  const subject = matched
    ? matched.subject
    : pickEnum(o.subject, SUBJECT_ENUM) || "";
  const org = String(o.org || "").trim();
  const level = pickEnum(o.level, LEVEL_ENUM) || "";
  const rank = String(o.rank || "").trim();
  const date = normalizeDate(o.date);
  const description = String(o.description || "").trim();

  if (!matched && rawName) hints.push(`「${rawName}」未匹配城市竞赛字典，建议家长核对全称`);
  if (!date && o.date) hints.push(`获奖时间「${String(o.date)}」无法解析，已留空`);
  if (!level && o.level) hints.push(`级别「${String(o.level)}」不在标准枚举，已留空`);
  if (!subject && rawName && !matched) hints.push("科目未识别，请家长手动选择");

  return { fields: { name, cup_short, cup_tier, subject, org, level, rank, date, description }, matched, hints };
}

/** confidence 启发式：命中字典 + 关键字段都有值 → high；缺 1-2 个 → medium；name 空或全空 → low */
export function deriveConfidence(fields: OCRAwardFields, matched: CupItem | null, rawText: string): "high" | "medium" | "low" {
  if (!fields.name && !rawText.trim()) return "low";
  let score = 0;
  if (fields.name) score += 2;
  if (matched) score += 2;
  if (fields.subject) score += 1;
  if (fields.level) score += 1;
  if (fields.rank) score += 1;
  if (fields.date) score += 1;
  if (score >= 6) return "high";
  if (score >= 3) return "medium";
  return "low";
}

/** 构造 system prompt（注入城市 cups 字典） */
export function buildSystemPrompt(cityName: string, cups: CupItem[]): string {
  const cupsList = cups.length
    ? cups.map((c) => `- ${c.short} → ${c.name}｜${c.subject}｜${c.tier}`).join("\n")
    : "（暂无）";
  return `你是中国小升初简历助手，专注于识别获奖证书图片并抽取结构化字段。

# 任务
读取证书图片，输出一个 JSON 对象（仅 JSON，无任何 markdown 代码块、注释、前后缀文字），字段如下：
- name: 赛事/荣誉全称（必须是家长圈公认的正式名称，不要用圈内黑话简称）
- cup_short: 若属于下方"竞赛字典"中的赛事，填字典里的 short；否则留空字符串
- cup_tier: 若属于字典中赛事，填字典里的 tier（T1/T2/T3/T4）；否则留空字符串
- subject: 数学|英语|科创|信息学|语文|艺术|体育|综合（按字典映射或证书内容推断；无法判断留空字符串）
- org: 主办单位（自由文本）
- level: 国家级|省级|市级|区级|校级（按主办单位行政级别推断或证书盖章判断；无法判断留空字符串）
- rank: 获奖等级/名次原文（如「一等奖」「二等奖」「Distinction」「Honor Roll」「Pass with Merit」）
- date: YYYY-MM 格式（如 "2025-06"）；证书上有具体日期取月份；无法解析留空字符串
- description: 其他说明文字（如「决赛二等奖」「广州赛区」「个人赛」），没有则留空字符串

# 当前城市：${cityName}
# 竞赛字典（家长圈口径，简历成品用全称；OCR 优先匹配字典项）：
${cupsList}

# 输出要求
1. 仅输出 JSON，不要任何解释、markdown 包裹
2. 无法确定的字段留空字符串 ""，不要编造
3. 若图片不是证书（如学生证、奖牌、合影），name 与其他字段都留空字符串
4. 字段优先级：name > cup_short > cup_tier > subject > org > level > rank > date > description`;
}

/** 从 LLM 响应中尽量稳地提取 JSON（容忍 ```json 包裹、前后缀） */
export function extractJson<T = Record<string, unknown>>(text: string): T | null {
  if (!text) return null;
  // 直接尝试
  try {
    return JSON.parse(text) as T;
  } catch {
    // 尝试剥离 ```json ... ```
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) {
      try {
        return JSON.parse(m[1].trim()) as T;
      } catch {
        /* fallthrough */
      }
    }
    // 尝试提取第一个 { ... } 块
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1)) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * 把 Uint8Array 转 data URL（Workers AI image_url 输入）
 *
 * 注意 chunk 大小：`String.fromCharCode(...arr)` 用 spread 传参会走调用栈，
 * 数组过大会 "Maximum call stack size exceeded"（4MB 图 = 400 万参数必炸）。
 * 分块 8192（约 8K 参数）并逐块拼接，安全且性能可接受。
 */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  const CHUNK = 0x2000; // 8192
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    // apply 比 spread 在超大数组上更稳；8192 远低于引擎的栈上限
    bin += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return `data:${mime};base64,${btoa(bin)}`;
}

/**
 * 调用 Workers AI（默认路径）
 *
 * 关键：Workers AI 的图片 content part 必须是
 *   { type: "image_url", image_url: { url: dataUrl } }
 * 而不是 { type: "image", image: ... }——后者会触发 Workers AI 内部异常 → 网关 502。
 * 见 @cloudflare/workers-types 的 UserMessageContentPart 定义。
 *
 * 入参风格两版：
 *  - messages 风格（OpenAI 兼容）：绝大多数 Text Generation 模型用这个
 *  - prompt + image 风格：task 为 Image-to-Text 的老式模型（如 moondream）可能只认这个
 * 用 style 参数二选一，由 callWorkersAIFallback 依次尝试。
 */
async function callWorkersAI(
  ai: Ai,
  model: string,
  systemPrompt: string,
  dataUrl: string,
  style: "messages" | "prompt" = "messages",
  userText: string = "请识别这张证书图片，输出严格 JSON。"
): Promise<{ text: string; raw: unknown }> {
  const resp =
    style === "messages"
      ? await ai.run(model, {
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: userText },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
          max_tokens: 800,
          temperature: 0.1,
        } as Parameters<Ai["run"]>[1])
      : await ai.run(model, {
          prompt: systemPrompt + "\n\n" + userText,
          image: dataUrlToNumberArray(dataUrl),
          max_tokens: 800,
        } as unknown as Parameters<Ai["run"]>[1]);
  // Workers AI 视觉模型返回 { response: "..." } / { content: "..." } / OpenAI 风格 { choices[].message.content }
  const r = resp as Record<string, unknown>;
  let text = "";
  if (r && typeof r.response === "string") text = r.response;
  else if (r && typeof r.content === "string") text = r.content;
  else if (r && typeof r.output_text === "string") text = r.output_text;
  else if (r && typeof r.text === "string") text = r.text;
  else if (r && Array.isArray(r.choices) && r.choices.length) {
    const c0 = r.choices[0] as { message?: { content?: string }; text?: string };
    text = c0?.message?.content || c0?.text || "";
  }
  return { text: String(text || "").trim(), raw: resp };
}

/**
 * Workers AI 视觉模型候选（按顺序尝试，第一个成功的即返回）。
 *
 * 选型依据（2026-09 查 CF 官方 model catalog + pricing 页，均为**免费档可用**）：
 *
 * | 模型 | task | 单次 neurons* | 免费额度约 | 入选理由 |
 * |------|------|--------------|-----------|---------|
 * | moondream3.1-9B-A2B | Image-to-Text | ~96 | ~105 次/天 | 官方描述**唯一点名 OCR** + structured output |
 * | qwen3.8-27b | Image-Text-to-Text | ~190 | ~53 次/天 | 国产 Qwen，**中文最强**，原生图文 |
 * | gemma-4-26b-a4b-it | Text Gen+Vision | ~31 | ~323 次/天 | 26B 新模型 + Vision + Reasoning，最便宜 |
 * | llama-3.2-11b-vision | Text Gen+Vision | ~29 | ~340 次/天 | CF 官方 vision 标杆，schema 明确含 image |
 *
 * *按 input 2500 tokens（含图片）+ output 300 tokens 估算；免费额度 10,000 neurons/天。
 *
 * 排序逻辑：先试「任务最对口」（moondream 专做 OCR），再试「中文最强」（qwen），
 * 最后两个是低价高额度兜底，保证免费档下不会因为前两个限额而完全不可用。
 *
 * 排除项（这些**需要付费账单**，免费档调不通）：
 *   kimi-k2.6 / kimi-k2.7-code / glm-5.2 / glm-5.3 / glm-5.3-flash /
 *   deepseek-v4-flash-0731 / deepseek-v4-pro-0813
 *
 * 可用环境变量 OCR_MODEL_ORDER（逗号分隔）覆盖顺序，便于实测后就地调序而不改代码。
 */
export const WORKERS_AI_VISION_MODELS = [
  "@cf/moondream/moondream3.1-9B-A2B",
  "@cf/qwen/qwen3.8-27b",
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/meta/llama-3.2-11b-vision-instruct",
];

/** 单次 OCR 的 neurons 估算（用于 health 端点展示成本） */
export const MODEL_NEURON_RATES: Record<string, { in: number; out: number }> = {
  "@cf/moondream/moondream3.1-9B-A2B": { in: 27273, out: 90909 },
  "@cf/qwen/qwen3.8-27b": { in: 40909, out: 290909 },
  "@cf/google/gemma-4-26b-a4b-it": { in: 9091, out: 27273 },
  "@cf/meta/llama-3.2-11b-vision-instruct": { in: 4410, out: 61493 },
  "@cf/meta/llama-4-scout-17b-16e-instruct": { in: 24545, out: 77273 },
  "@cf/google/gemma-3-12b-it": { in: 31371, out: 50560 },
  "@cf/mistralai/mistral-small-3.1-24b-instruct": { in: 31876, out: 50488 },
  "@cf/moonshotai/kimi-k2.5": { in: 54545, out: 272727 },
};

/** 估算单次调用 neurons（input 2500 / output 300 tokens） */
export function estimateNeurons(model: string): number {
  const r = MODEL_NEURON_RATES[model];
  if (!r) return -1;
  return Math.round(r.in * 0.0025 + r.out * 0.0003);
}

/** data URL → number[]（旧式 image 入参要求「0-255 整数数组」） */
function dataUrlToNumberArray(dataUrl: string): number[] {
  const b64 = dataUrl.split(",", 2)[1] || "";
  const bin = atob(b64);
  const arr = new Array<number>(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i) & 0xff;
  return arr;
}

/**
 * 依次尝试多个 Workers AI 模型 × 两种入参风格，第一个成功的即返回。
 * 全失败才抛错（带上每次的失败原因，便于诊断）。
 *
 * modelOrder：允许外部（环境变量 OCR_MODEL_ORDER）覆盖顺序。
 */
async function callWorkersAIFallback(
  ai: Ai,
  systemPrompt: string,
  dataUrl: string,
  modelOrder?: string[],
  userText?: string
): Promise<{ text: string; model: string; style: string; raw: unknown }> {
  const models = modelOrder && modelOrder.length ? modelOrder : WORKERS_AI_VISION_MODELS;
  const errors: string[] = [];
  for (const model of models) {
    for (const style of ["messages", "prompt"] as const) {
      try {
        const { text, raw } = await callWorkersAI(ai, model, systemPrompt, dataUrl, style, userText);
        if (text) return { text, model, style, raw };
        errors.push(`${model}[${style}]: 返回空内容`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`${model}[${style}]: ${msg}`);
        console.warn(`[ocr] Workers AI ${model} (${style}) 失败：${msg}`);
      }
    }
  }
  throw new Error(`Workers AI 全部视觉模型失败 → ${errors.join(" | ")}`);
}

/** 调用 OpenAI GPT-4o（可选） */
async function callOpenAI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  dataUrl: string,
  userText: string = "请识别这张证书图片，输出严格 JSON。"
): Promise<string> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 800,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`OpenAI ${r.status}: ${err.slice(0, 200)}`);
  }
  const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return j.choices?.[0]?.message?.content || "";
}

/** 调用 Google Gemini（可选） */
async function callGemini(
  apiKey: string,
  model: string,
  systemPrompt: string,
  dataUrl: string,
  mime: string,
  userText: string = "请识别这张证书图片，输出严格 JSON。"
): Promise<string> {
  // dataUrl 形如 data:image/jpeg;base64,xxxx，取出 base64 部分
  const b64 = dataUrl.split(",", 2)[1] || "";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [
        {
          role: "user",
          parts: [
            { text: userText },
            { inlineData: { mimeType: mime, data: b64 } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 800,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Gemini ${r.status}: ${err.slice(0, 200)}`);
  }
  const j = (await r.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return j.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

/** 调用阿里通义千问 Qwen-VL（可选） */
async function callQwenVL(
  apiKey: string,
  model: string,
  systemPrompt: string,
  dataUrl: string,
  userText: string = "请识别这张证书图片，输出严格 JSON。"
): Promise<string> {
  const r = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: userText },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 800,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Qwen-VL ${r.status}: ${err.slice(0, 200)}`);
  }
  const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return j.choices?.[0]?.message?.content || "";
}

/**
 * 通用视觉入口：给定 systemPrompt + userText + 图片，按 env 选 provider 并调用。
 *
 * v1.5：awards(证书 OCR) / talents(特长证书 OCR) / works(看图说话) 三条业务共用这一层，
 * 差异全部收敛到各自传入的 prompt 上，模型调度、多模型 fallback、外部 provider 降级只写一遍。
 */
export async function runVision(
  env: OcrEnv,
  opts: { systemPrompt: string; userText: string },
  bytes: Uint8Array,
  mime: string
): Promise<{ text: string; provider: OCRProvider; model: string; raw: unknown }> {
  const { systemPrompt, userText } = opts;
  const dataUrl = bytesToDataUrl(bytes, mime);

  const externalProvider = (env.EXTERNAL_OCR_PROVIDER || "").toLowerCase();
  if (externalProvider && env.EXTERNAL_OCR_API_KEY) {
    const model = env.EXTERNAL_OCR_MODEL || defaultExternalModel(externalProvider);
    try {
      let text = "";
      if (externalProvider === "openai") {
        text = await callOpenAI(env.EXTERNAL_OCR_API_KEY, model, systemPrompt, dataUrl, userText);
      } else if (externalProvider === "google") {
        text = await callGemini(env.EXTERNAL_OCR_API_KEY, model, systemPrompt, dataUrl, mime, userText);
      } else if (externalProvider === "qwen") {
        text = await callQwenVL(env.EXTERNAL_OCR_API_KEY, model, systemPrompt, dataUrl, userText);
      } else {
        throw new Error(`未知外部 OCR provider: ${externalProvider}`);
      }
      return { text, provider: externalProvider as OCRProvider, model, raw: null };
    } catch (e) {
      console.warn(`[ocr] external provider ${externalProvider} 失败，降级到 Workers AI：`, (e as Error).message);
      // 降级到 Workers AI
    }
  }

  // 默认 / 降级路径：Workers AI（多模型 × 双入参风格 fallback）
  if (!env.AI) throw new Error("Workers AI 未绑定（env.AI 缺失）且无外部 OCR 配置");
  const order = (env.OCR_MODEL_ORDER || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const { text, model, style, raw } = await callWorkersAIFallback(
    env.AI,
    systemPrompt,
    dataUrl,
    order.length ? order : undefined,
    userText
  );
  if (style !== "messages") console.log(`[ocr] ${model} 使用 ${style} 入参风格`);
  return { text, provider: "workers_ai", model, raw };
}

/** awards 专用入口（保留原签名，内部复用 runVision） */
export async function runOCR(
  env: OcrEnv,
  cityName: string,
  cups: CupItem[],
  bytes: Uint8Array,
  mime: string
): Promise<{ text: string; provider: OCRProvider; model: string; raw: unknown }> {
  return runVision(
    env,
    { systemPrompt: buildSystemPrompt(cityName, cups), userText: "请识别这张证书图片，输出严格 JSON。" },
    bytes,
    mime
  );
}

function defaultExternalModel(p: string): string {
  switch (p) {
    case "openai":
      return "gpt-4o";
    case "google":
      return "gemini-2.5-pro";
    case "qwen":
      return "qwen-vl-max";
    default:
      return "";
  }
}

/** OCR 运行所需的 env 子集（便于路由层按需透传，也让测试好造 mock） */
export interface OcrEnv {
  AI?: Ai;
  EXTERNAL_OCR_PROVIDER?: string;
  EXTERNAL_OCR_API_KEY?: string;
  EXTERNAL_OCR_MODEL?: string;
  OCR_MODEL_ORDER?: string;
}

/** 端到端：bytes → 归一化结果 */
export async function recognizeAward(
  env: OcrEnv,
  cityName: string, cups: CupItem[], bytes: Uint8Array, mime: string
): Promise<Omit<OCRAwardResult, "source">> {
  const t0 = Date.now();
  const { text, provider, model, raw } = await runOCR(env, cityName, cups, bytes, mime);
  const rawJson = extractJson(text);
  const { fields, matched, hints } = sanitizeFields(rawJson || {}, cups);
  const confidence = deriveConfidence(fields, matched, text);
  return {
    provider,
    model,
    duration_ms: Date.now() - t0,
    confidence,
    fields,
    matched_dict_entry: matched,
    raw_text: text.slice(0, 2000), // 限长避免爆缓存
    hints,
    ...({ raw } as Record<string, unknown>), // 调试用，路由层决定是否下发
  };
}

/* ============================================================================
 * v1.5：兴趣特长（talents）证书 OCR
 *
 * 与 awards 的差异：特长证书形态更杂（考级证 / 段位证 / 等级考试 / 培训结业证），
 * 没有城市竞赛字典可锚定，因此不做字典匹配，只做枚举归一化 + 年限提取。
 * ========================================================================== */

export interface OCRTalentFields {
  category: string; // 科创|艺术|体育|学科|其他
  title: string; // 特长名称，如「钢琴」「少儿编程」「围棋」
  description: string; // 级别/机构/成果等补充
  years: string; // 坚持年限（多数证书没有，留空）
}

export interface OCRTalentResult {
  source: "cache" | "workers_ai" | "external";
  provider: OCRProvider;
  model: string;
  duration_ms: number;
  confidence: "high" | "medium" | "low";
  fields: OCRTalentFields;
  raw_text: string;
  hints: string[];
}

const TALENT_CATEGORY_ENUM = ["科创", "艺术", "体育", "学科", "其他", ""];

/** 归一化年限：接受「3年」「三年」「3 年」「学习满 2 年」等，输出纯数字字符串 */
function normalizeYears(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return String(Math.min(Math.trunc(value), 30));
  }
  if (typeof value !== "string") return "";
  const s = value.trim();
  if (!s) return "";
  const cn: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const mCn = s.match(/^([一二两三四五六七八九十])年?$/);
  if (mCn) return String(cn[mCn[1]] ?? "");
  const mNum = s.match(/(\d{1,2})\s*年/);
  if (mNum) {
    const n = Number(mNum[1]);
    if (n > 0 && n <= 30) return String(n);
  }
  const mPure = s.match(/^(\d{1,2})$/);
  if (mPure) {
    const n = Number(mPure[1]);
    if (n > 0 && n <= 30) return String(n);
  }
  return "";
}

export function buildTalentSystemPrompt(): string {
  return `你是中国小升初简历助手，专注于识别「兴趣特长类证书」并抽取结构化字段。

# 适用证书类型
考级证书（钢琴/舞蹈/声乐/美术/书法）、段位证书（围棋/象棋）、等级考试证书
（机器人技术等级考试、青少年编程等级考试、Scratch/Python 等级）、
运动员等级证、游泳/球类等级证、培训结业证、社团成员证等。

# 任务
读取证书图片，输出一个 JSON 对象（仅 JSON，无任何 markdown 代码块、注释、前后缀文字），字段如下：
- category: 科创|艺术|体育|学科|其他
  · 艺术 = 音乐/舞蹈/美术/书法/戏剧
  · 体育 = 球类/游泳/田径/棋类以外的体育项目
  · 科创 = 编程/机器人/创客/信息学/科学实验
  · 学科 = 数学/语文/英语等学科类拓展（非竞赛）
  · 棋类（围棋/象棋/国际象棋）归「体育」
  · 无法判断填「其他」
- title: 特长名称本身，**不要**带级别和机构（如「钢琴」而不是「钢琴拾级证书」；
  「少儿编程」而不是「全国青少年编程等级考试」）。≤12 字。
- description: 补充信息，用中文顿号或逗号分隔，只写证书上**确实印着**的内容，
  常见项：级别（拾级/八级/业余5段/三级）、颁证机构（中国音乐学院/中国舞蹈家协会）、
  成绩（优秀/良好/通过）。不要写「孩子很努力」这类评价。
- years: 坚持年限，纯数字字符串（如「3」）。**只有证书上明确印着**"学习满X年"
  "连续学习X年"之类才填；绝大多数证书没有这一项，留空字符串 ""。

# 输出要求
1. 仅输出 JSON，不要任何解释、markdown 包裹
2. 无法确定的字段留空字符串 ""，不要编造年限、级别、机构
3. 若图片不是特长类证书（如学科竞赛奖状、三好学生奖状、学生证、普通合影），
   category 与 title 都留空字符串，并在 description 里说明这是什么
4. title 只写项目名，级别放 description，两者不要重复`;
}

/** talents 字段归一化 */
export function sanitizeTalentFields(raw: unknown): { fields: OCRTalentFields; hints: string[] } {
  const hints: string[] = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const category = pickEnum(o.category, TALENT_CATEGORY_ENUM);
  const title = String(o.title || "").trim().slice(0, 40);
  const description = String(o.description || "").trim().slice(0, 300);
  const rawYears = o.years;
  const years = normalizeYears(rawYears);

  if (!title) hints.push("未识别出特长名称，请家长手动填写");
  if (!category && title) hints.push("分类未识别，请家长手动选择（科创/艺术/体育/学科/其他）");
  if (!years) hints.push("坚持年限证书上通常没有，请家长据实填写");
  if (rawYears && !years) hints.push(`年限「${String(rawYears)}」无法解析，已留空`);

  return { fields: { category, title, description, years }, hints };
}

/** talents confidence：title + category + 有补充 → high */
export function deriveTalentConfidence(fields: OCRTalentFields, rawText: string): "high" | "medium" | "low" {
  if (!fields.title && !rawText.trim()) return "low";
  let score = 0;
  if (fields.title) score += 2;
  if (fields.category) score += 2;
  if (fields.description) score += 1;
  if (fields.years) score += 1;
  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

/** 端到端：bytes → talents 归一化结果 */
export async function recognizeTalent(
  env: OcrEnv,
  bytes: Uint8Array,
  mime: string
): Promise<Omit<OCRTalentResult, "source">> {
  const t0 = Date.now();
  const { text, provider, model } = await runVision(
    env,
    { systemPrompt: buildTalentSystemPrompt(), userText: "请识别这张特长证书图片，输出严格 JSON。" },
    bytes,
    mime
  );
  const rawJson = extractJson(text);
  const { fields, hints } = sanitizeTalentFields(rawJson || {});
  const confidence = deriveTalentConfidence(fields, text);
  return {
    provider,
    model,
    duration_ms: Date.now() - t0,
    confidence,
    fields,
    raw_text: text.slice(0, 2000),
    hints,
  };
}

/* ============================================================================
 * v1.5：成长作品（works）「AI 看图说话」
 *
 * 与 OCR 的本质区别：证书是「抄录已有文字」，作品照片是「描述未见文字」。
 * 后者最大的风险是模型自由发挥——编造奖项、编造技术参数、堆砌自媒体式吹捧。
 * 简历是要交给学校老师的，一句「小小发明家打造的惊艳机械臂」足以毁掉可信度。
 * 因此这里的 prompt 以「禁止清单 + 语气基准 + 好/坏例子对照」为主，
 * 并在后端再做一次吹捧词兜底检测。
 * ========================================================================== */

export interface OCRWorkFields {
  title: string;
  description: string;
}

export interface OCRWorkResult {
  source: "cache" | "workers_ai" | "external";
  provider: OCRProvider;
  model: string;
  duration_ms: number;
  confidence: "high" | "medium" | "low";
  fields: OCRWorkFields;
  hints: string[];
  raw_text: string;
}

/**
 * 吹捧词黑名单（后端兜底）。
 * 视觉模型偶尔会滑向自媒体腔，光靠 prompt 挡不住；这里命中即在 hints 里提醒家长核对，
 * 并且**不自动改写字面内容**（改写权交给家长，AI 不替家长做主张）。
 */
const HYPE_WORDS = [
  "惊艳", "震撼", "天才", "神童", "卓越", "完美", "顶尖", "领先", "突破性", "革命性",
  "极具", "超强", "无敌", "史上", "前所未有", "叹为观止", "令人惊叹", "无与伦比",
  "小小发明家", "小小科学家", "未来可期", "前途无量", "不可限量", "傲人", "斐然",
];

export function buildWorkSystemPrompt(): string {
  return `你是中国小升初简历助手，负责帮家长描述孩子上传的「成长作品照片」。

这份描述会直接写进交给学校老师的简历。招生老师一眼就能看出哪些是吹出来的。
所以你的第一原则是：**宁可平淡，不可虚构；宁可说"看不清"，不可猜。**

# 任务
看这张照片，用客观、克制、具体的中文，写一句作品名称 + 一段作品介绍。

# 绝对禁止（违反任何一条即为失败输出）
1. **禁止臆造事实**——只描述画面中看得见的信息。以下一律不得编造：
   · 获奖情况、名次、含金量（"一等奖""国家级""金奖"）
   · 主办/认证机构、学校名、机构名、赛事名
   · 时间（年份、月份、学期、"历时三个月"）
   · 人名（孩子姓名、老师姓名、团队成员）
   · 技术参数（尺寸、重量、速度、代码行数、传感器型号、电池容量等看不出来的数字）
   · 作品是否获奖、是否申请专利、是否被媒体报道
2. **禁止夸张修辞**——不得出现"惊艳""天才""卓越""完美""顶尖""突破性"
   "极具""叹为观止""小小发明家""未来可期"等自媒体式吹捧词，也不得使用网络梗和感叹号堆砌。
3. **禁止品质升华**——不得写"体现了创新精神""展现了对科学的热爱""锻炼了动手能力"
   "培养了解决问题的意识"这类评价句。那是家长自己写的，AI 不替家长下结论。
4. **禁止第一人称**——不要写"我做了…""我们小组…"。用客观描述或"该作品…"。
5. **禁止脑补功能**——你无法验证它是否真的能动、代码是否正确。
   描述功能时必须带存疑措辞（"看起来可以…""似乎用于…""外观上像是…"）。

# 看不清就直说
画面模糊、角度奇怪、信息不足、或你根本认不出这是什么
→ title 与 description 全部留空字符串，在 hints 里明确写"画面信息不足，无法描述，请家长手动填写"。
留空远比编一段似是而非的话有价值。

# 输出 JSON（仅 JSON，无 markdown 代码块、无解释、无前后缀文字）
- title: 作品名称，≤20 字，客观命名，只写"是什么"，不写评价。
  例：「智能浇花装置」「废旧纸板机器人」「Scratch 打地鼠小游戏」
  画面信息不足则留空字符串 ""。
- description: 作品介绍，2–4 句，说清三件事：
  ① 这是什么（形态：是一个装置 / 一幅画 / 一个程序界面 / 一份手抄报）
  ② 用了什么材料或技术（**只写画面能辨认的**，如"纸板、舵机、Arduino 主控板、彩色卡纸"；
     看不出具体型号就写大类，如"一块开发板""几个电机"）
  ③ 看起来实现什么功能（**必须**用"看起来""似乎""外观上像是"等存疑措辞）
  完全看不清则留空字符串 ""。
- hints: 字符串数组，0–3 条，提示家长还需要补充或核对什么。
  例：「画面无法判断是否获奖，如已获奖建议填到『获奖情况』」
      「建议补充孩子在这个作品里具体负责哪部分」
  没有需要提示的则给空数组 []。

# 语气基准（严格照这个调性，不要更华丽）
好例子：「用纸板和舵机制作的简易机械臂，通过两个旋钮控制夹取动作。外观已完成组装，接线外露。」
坏例子：「小小发明家打造的惊艳机械臂！展现了卓越的创新能力与对机器人的无限热爱！」

# 若照片明显不是作品
若画面是：获奖证书、考级证书、学生证、普通合影、风景照、纯文字截图、
或模糊/空白到无法辨认 → title 与 description 全部留空字符串，
hints 写明「这似乎不是作品照片（建议改传到『获奖情况』或手动填写）」。`;
}

/** works 字段归一化 + 吹捧词兜底检测 */
export function sanitizeWorkFields(raw: unknown): { fields: OCRWorkFields; hints: string[] } {
  const hints: string[] = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  let title = String(o.title || "").trim().slice(0, 40);
  let description = String(o.description || "").trim().slice(0, 800);

  // 模型自报的 hints
  const rawHints = Array.isArray(o.hints) ? o.hints : [];
  for (const h of rawHints.slice(0, 3)) {
    const s = String(h || "").trim().slice(0, 120);
    if (s) hints.push(s);
  }

  // 吹捧词兜底：命中即提醒（不代改内容，改写权归家长）
  const blob = title + " " + description;
  const hit = HYPE_WORDS.filter((w) => blob.includes(w));
  if (hit.length) {
    hints.push(
      `AI 描述中出现了「${hit.slice(0, 3).join("、")}」等夸张表述，已原样保留供你参考，建议改成客观陈述后再保存。`
    );
  }
  // 明显编造信号的提醒
  if (/一等奖|二等奖|三等奖|金奖|银奖|铜奖|冠军|国家级|省级|专利/.test(blob)) {
    hints.push("描述中出现了奖项/专利相关字眼，请核对证书原件——AI 无法从照片判断获奖与否。");
  }
  // 感叹号堆砌也提示一下
  if ((description.match(/！/g) || []).length >= 2) {
    hints.push("描述中感叹号较多，简历里建议改成平实的陈述句。");
  }

  // 去留：标题若是纯评价性短语（含吹捧词且极短）也不要了
  if (title && HYPE_WORDS.some((w) => title.includes(w)) && title.length <= 12) {
    hints.push("作品名称疑似为评价性短语，已保留，建议改成客观命名（如「智能浇花装置」）。");
  }

  return { fields: { title, description }, hints };
}

/** works confidence：title + description 齐 → high */
export function deriveWorkConfidence(fields: OCRWorkFields, rawText: string): "high" | "medium" | "low" {
  if (!fields.title && !fields.description && !rawText.trim()) return "low";
  if (fields.title && fields.description) return "high";
  if (fields.title || fields.description) return "medium";
  return "low";
}

/** 端到端：bytes → works 看图说话结果 */
export async function describeWork(
  env: OcrEnv,
  bytes: Uint8Array,
  mime: string
): Promise<Omit<OCRWorkResult, "source">> {
  const t0 = Date.now();
  const { text, provider, model } = await runVision(
    env,
    { systemPrompt: buildWorkSystemPrompt(), userText: "请看这张作品照片，输出严格 JSON。" },
    bytes,
    mime
  );
  const rawJson = extractJson(text);
  const { fields, hints } = sanitizeWorkFields(rawJson || {});
  const confidence = deriveWorkConfidence(fields, text);
  return {
    provider,
    model,
    duration_ms: Date.now() - t0,
    confidence,
    fields,
    hints,
    raw_text: text.slice(0, 2000),
  };
}