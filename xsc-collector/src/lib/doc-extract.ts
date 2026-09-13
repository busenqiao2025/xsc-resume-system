// v1.9: 文档（PDF/Word）文字提取 + 文本 LLM 结构化抽取
//
// 与视觉 OCR 的关系：
//   图片 → lib/ocr.ts 的视觉模型路径（看图识字）；
//   PDF/Word → 本模块：先把文档转成纯文字（Workers AI toMarkdown，DOCX 另有
//   fflate 解压兜底），再用文本大模型按板块各自的结构化 prompt 抽取字段。
//   输出契约与视觉路径完全一致（同一套 sanitize / 杯赛字典 / confidence），
//   路由层拿到结果后建条目的逻辑两条路通用。
//
// 所有外部 API key 走 wrangler secret，源码/前端都不接触密钥。

import { unzipSync } from "fflate";
import type { CupItem } from "./city-configs";
import {
  buildSystemPrompt,
  buildTalentSystemPrompt,
  buildWorkDocPrompt,
  sanitizeFields,
  sanitizeTalentFields,
  sanitizeWorkFields,
  deriveConfidence,
  deriveTalentConfidence,
  deriveWorkConfidence,
  extractJson,
  type OCRProvider,
  type OcrEnv,
  type OCRAwardFields,
  type OCRTalentFields,
  type OCRWorkFields,
} from "./ocr";

/** 支持走「文档提取」的 mime（与 validate.ts ALLOWED_MIME 的非图片部分一致） */
export const DOC_MIMES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function isDocMime(mime: string): boolean {
  return DOC_MIMES.has(mime);
}

/** 提取到的文字低于这个长度视为「没有文字层」（扫描件 PDF 等），不再调 LLM */
const MIN_DOC_TEXT_LEN = 10;

/** 喂给文本模型的文档内容上限（字符），防超长文档打爆上下文 */
const MAX_DOC_TEXT_FOR_LLM = 6000;

/* ============================================================================
 * 第一步：文档 → 纯文字
 * ========================================================================== */

/** Workers AI toMarkdown：PDF/DOCX/DOC 统一入口（账号若未开通会抛错，走兜底） */
async function aiToMarkdown(ai: Ai, bytes: Uint8Array, mime: string, name: string): Promise<string | null> {
  try {
    const aiWithMd = ai as Ai & { toMarkdown?: (f: { name: string; blob: Blob }) => Promise<unknown> };
    if (typeof aiWithMd.toMarkdown !== "function") return null;
    const res = (await aiWithMd.toMarkdown({
      name,
      blob: new Blob([bytes as unknown as ArrayBuffer], { type: mime }),
    })) as { format?: string; data?: string; error?: string };
    if (res && res.format === "markdown" && typeof res.data === "string") {
      const t = res.data.trim();
      if (t.length >= MIN_DOC_TEXT_LEN) return t;
    }
    if (res && res.format === "error") {
      console.warn(`[doc] toMarkdown 转换失败（${name}）：${String(res.error || "").slice(0, 160)}`);
    }
    return null;
  } catch (e) {
    console.warn(`[doc] toMarkdown 异常（${name}）：`, (e as Error).message);
    return null;
  }
}

/** DOCX 兜底：docx 本质是 zip，word/document.xml 里就是全文 */
function docxTextFallback(bytes: Uint8Array): string | null {
  try {
    const files = unzipSync(bytes);
    const xml = files["word/document.xml"];
    if (!xml) return null;
    let s = new TextDecoder("utf-8").decode(xml);
    s = s
      .replace(/<w:tab\s*\/>/g, "\t")
      .replace(/<w:br\s*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "");
    s = s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
    const t = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return t.length >= MIN_DOC_TEXT_LEN ? t : null;
  } catch (e) {
    console.warn("[doc] docx 兜底解析失败：", (e as Error).message);
    return null;
  }
}

/**
 * 文档 → 纯文字。返回 null 表示「没有可用文字层」：
 * 扫描件 PDF（里面全是图片）、旧版二进制 .doc、加密/损坏文件都走这里，
 * 路由层据此降级为「只保存原件」。
 */
export async function extractDocText(
  env: OcrEnv,
  bytes: Uint8Array,
  mime: string,
  name: string
): Promise<{ text: string; converter: "ai_tomarkdown" | "docx_zip" } | null> {
  if (env.AI) {
    const t = await aiToMarkdown(env.AI, bytes, mime, name);
    if (t) return { text: t, converter: "ai_tomarkdown" };
  }
  if (mime === DOCX_MIME) {
    const t = docxTextFallback(bytes);
    if (t) return { text: t, converter: "docx_zip" };
  }
  return null;
}

/* ============================================================================
 * 第二步：纯文字 → 文本 LLM → 结构化字段
 *
 * 模型选型与视觉路径同一原则：免费档可用优先，多模型 fallback，
 * 可用环境变量 OCR_TEXT_MODEL_ORDER 覆盖顺序。
 * ========================================================================== */

/** 免费档文本模型候选（按顺序尝试） */
export const WORKERS_AI_TEXT_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct",
];

interface TextLLMResult {
  text: string;
  provider: OCRProvider;
  model: string;
}

/** 从 Workers AI 文本模型响应中取文字（兼容几种返回形态） */
function textOfWorkersAI(resp: unknown): string {
  const r = resp as Record<string, unknown>;
  if (!r) return "";
  if (typeof r.response === "string") return r.response;
  if (typeof r.content === "string") return r.content;
  if (typeof r.output_text === "string") return r.output_text;
  if (Array.isArray(r.choices) && r.choices.length) {
    const c0 = r.choices[0] as { message?: { content?: string }; text?: string };
    return c0?.message?.content || c0?.text || "";
  }
  return "";
}

/** 外部 provider 的纯文本调用（OpenAI/Qwen 兼容接口 + Gemini） */
async function callExternalText(
  provider: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
  userText: string
): Promise<string> {
  if (provider === "google") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 900, responseMimeType: "application/json" },
      }),
    });
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    return j.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }
  // openai / qwen 都是 OpenAI 兼容协议
  const base = provider === "qwen" ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : "https://api.openai.com/v1";
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText },
      ],
      max_tokens: 900,
      temperature: 0.1,
      response_format: { type: "json_object" },
    }),
  });
  if (!r.ok) throw new Error(`${provider} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return j.choices?.[0]?.message?.content || "";
}

function defaultExternalTextModel(p: string): string {
  switch (p) {
    case "openai":
      return "gpt-4o-mini";
    case "google":
      return "gemini-2.5-flash";
    case "qwen":
      return "qwen-plus";
    default:
      return "";
  }
}

/**
 * 文本 LLM 统一入口：外部 provider 优先（与视觉路径策略一致），
 * 未配置或失败则 Workers AI 免费档文本模型依次 fallback。全失败才抛错。
 */
export async function runTextLLM(env: OcrEnv, systemPrompt: string, userText: string): Promise<TextLLMResult> {
  const p = (env.EXTERNAL_OCR_PROVIDER || "").toLowerCase();
  if (p && env.EXTERNAL_OCR_API_KEY) {
    const model = env.EXTERNAL_OCR_MODEL || defaultExternalTextModel(p);
    try {
      const text = await callExternalText(p, env.EXTERNAL_OCR_API_KEY, model, systemPrompt, userText);
      if (text) return { text: text.trim(), provider: p as OCRProvider, model };
    } catch (e) {
      console.warn(`[doc] 外部 provider ${p} 文本调用失败，降级到 Workers AI：`, (e as Error).message);
    }
  }
  if (!env.AI) throw new Error("Workers AI 未绑定（env.AI 缺失）且无外部 OCR 配置");
  const order = (env.OCR_TEXT_MODEL_ORDER || "").split(",").map((s) => s.trim()).filter(Boolean);
  const models = order.length ? order : WORKERS_AI_TEXT_MODELS;
  const errors: string[] = [];
  for (const model of models) {
    try {
      const resp = await env.AI.run(model as Parameters<Ai["run"]>[0], {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
        max_tokens: 900,
        temperature: 0.1,
      } as Parameters<Ai["run"]>[1]);
      const text = textOfWorkersAI(resp).trim();
      if (text) return { text, provider: "workers_ai", model };
      errors.push(`${model}: 返回空内容`);
    } catch (e) {
      errors.push(`${model}: ${(e as Error).message}`);
      console.warn(`[doc] Workers AI ${model} 文本调用失败：`, (e as Error).message);
    }
  }
  throw new Error(`Workers AI 全部文本模型失败 → ${errors.join(" | ")}`);
}

/* ============================================================================
 * 端到端：文档文字 → 与视觉路径同构的归一化结果
 * ========================================================================== */

export interface DocExtractOutcome {
  provider: OCRProvider;
  model: string;
  duration_ms: number;
  confidence: "high" | "medium" | "low";
  fields: OCRAwardFields | OCRTalentFields | OCRWorkFields;
  matched_dict_entry?: CupItem | null;
  raw_text: string;
  hints: string[];
  /** 文字转换通道：ai_tomarkdown / docx_zip（诊断与前端展示用） */
  converter: string;
  /** 从文档提取到的纯文字（截断，随缓存存 30 天，生成简历的 skill 可参考） */
  doc_text: string;
}

export async function extractFieldsFromDoc(
  env: OcrEnv,
  kind: "award" | "talent" | "work",
  ctx: { cityName: string; cups: CupItem[] },
  doc: { text: string; converter: string },
  fileName: string
): Promise<DocExtractOutcome> {
  const t0 = Date.now();
  const capped = doc.text.slice(0, MAX_DOC_TEXT_FOR_LLM);
  const userText = `文件名：${fileName}\n\n文档内容：\n${capped}\n\n请输出严格 JSON。`;

  let systemPrompt: string;
  if (kind === "award") systemPrompt = buildSystemPrompt(ctx.cityName, ctx.cups, "以下从获奖证书文档（PDF/Word）中提取的文字");
  else if (kind === "talent") systemPrompt = buildTalentSystemPrompt("以下从特长证书文档（PDF/Word）中提取的文字");
  else systemPrompt = buildWorkDocPrompt();

  const { text, provider, model } = await runTextLLM(env, systemPrompt, userText);
  const rawJson = extractJson(text);
  const duration_ms = Date.now() - t0;
  const common = { provider, model, duration_ms, converter: doc.converter, raw_text: text.slice(0, 2000), doc_text: capped.slice(0, 2000) };

  if (kind === "award") {
    const { fields, matched, hints } = sanitizeFields(rawJson || {}, ctx.cups);
    return { ...common, fields, matched_dict_entry: matched, hints, confidence: deriveConfidence(fields, matched, text) };
  }
  if (kind === "talent") {
    const { fields, hints } = sanitizeTalentFields(rawJson || {});
    return { ...common, fields, hints, confidence: deriveTalentConfidence(fields, text) };
  }
  const { fields, hints } = sanitizeWorkFields(rawJson || {});
  return { ...common, fields, hints, confidence: deriveWorkConfidence(fields, text) };
}
