// v1.5: 视觉识别 API（/api/me/ocr/*）
// architecture.md 13.7
//
// 端点：
//   POST /api/me/ocr/award           获奖证书识别（multipart file 或 JSON attachment_id）
//   POST /api/me/ocr/award/batch     获奖证书批量识别
//   POST /api/me/ocr/talent          兴趣特长证书识别（v1.5）
//   POST /api/me/ocr/talent/batch    兴趣特长批量识别（v1.5）
//   POST /api/me/ocr/work            成长作品「看图说话」（v1.5）
//   POST /api/me/ocr/work/batch      成长作品批量「看图说话」（v1.5）
//   DELETE /api/me/ocr/cache/:aid    清除某张图片的识别缓存（?kind=award|talent|work，默认清全部）
//   GET    /api/me/ocr/health        识别服务自检
//
// 鉴权：家长端 Bearer invite_token（同其他 /api/me/*）
// 限额：单学生每分钟 ≤ 10 次识别（防滥用 + 防 token 暴增）

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, StudentRow } from "../types";
import { parentAuth } from "../lib/auth";
import { getCityConfig } from "../lib/city-configs";
import { ALLOWED_MIME, MAX_ATTACHMENT_SIZE } from "../lib/validate";
import { uniqueId } from "../lib/ids";
import { touchUpdatedAt } from "../db/queries";
import {
  recognizeAward,
  recognizeTalent,
  describeWork,
  WORKERS_AI_VISION_MODELS,
  estimateNeurons,
  type OcrEnv,
  type OCRAwardResult,
  type OCRTalentResult,
  type OCRWorkResult,
} from "../lib/ocr";
import { isDocMime, extractDocText, extractFieldsFromDoc } from "../lib/doc-extract";

type Vars = { student: StudentRow };
type C = Context<{ Bindings: Env; Variables: Vars }>;

const app = new Hono<{ Bindings: Env; Variables: Vars }>();
app.use("/*", parentAuth);

const ok = (c: C, data: unknown) => c.json({ ok: true, data });
const fail = (c: C, status: number, code: string, message: string) =>
  c.json({ ok: false, error: { code, message } }, status as 400);

/** v1.5: 识别业务类型（与 ocr_cache.kind 一一对应） */
type OcrKind = "award" | "talent" | "work";
const OCR_KINDS: OcrKind[] = ["award", "talent", "work"];

/** 三种识别结果去掉 source 后的联合（recognize* 函数的原始返回） */
type VisionOutcome =
  | Omit<OCRAwardResult, "source">
  | Omit<OCRTalentResult, "source">
  | Omit<OCRWorkResult, "source">;

/**
 * 传给视觉模型的图片上限（bytes）。
 * 家长手机拍的证书常 2–5MB，base64 后膨胀 33%——Workers AI 对请求体有硬限制，
 * 超限会直接 502/413。超过此阈值先拒绝并提示家长压缩，避免无意义的模型调用。
 */
const MAX_OCR_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB

/** 识别速率限制：单学生 60s 内 ≤ 10 次（命中缓存不计） */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 10;
const rateBucket = new Map<string, number[]>();

function rateCheck(studentId: string): boolean {
  const now = Date.now();
  const arr = (rateBucket.get(studentId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    rateBucket.set(studentId, arr);
    return false;
  }
  arr.push(now);
  rateBucket.set(studentId, arr);
  return true;
}

/** 从 attachments 表拉取附件（校验归属） */
async function fetchOwnedAttachment(c: C, attachmentId: string): Promise<{ r2_key: string; mime_type: string; size: number; original_name: string } | null> {
  const row = await c.env.DB.prepare(
    "SELECT r2_key, mime_type, size, original_name FROM attachments WHERE id = ? AND student_id = ?"
  )
    .bind(attachmentId, c.get("student").id)
    .first<{ r2_key: string; mime_type: string; size: number; original_name: string }>();
  return row || null;
}

/** 从 attachments 表拉取附件（带 mime 校验） */
async function fetchOwnedImage(c: C, attachmentId: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const att = await fetchOwnedAttachment(c, attachmentId);
  if (!att) return null;
  if (!ALLOWED_MIME.has(att.mime_type) || !att.mime_type.startsWith("image/")) return null;
  const obj = await c.env.BUCKET.get(att.r2_key);
  if (!obj) return null;
  return { bytes: new Uint8Array(await obj.arrayBuffer()), mime: att.mime_type };
}

/**
 * kind 列是否存在（migration 005）的探测结果。
 *
 * 为什么需要探测：005 是 ALTER TABLE ADD COLUMN，已部署的库要单独跑才生效。
 * 这里做自适应——有 kind 列就按类型精确读写，没有就退回 v1.4 的「一附件一缓存行」。
 * 安全性：同一 attachment 的 section_type 是固定的（awards|talents|works 之一），
 * 因此即使没有 kind 列，一个 attachment 也只会被一种识别类型使用，不会串味。
 * 每个 isolate 只探测一次（PRAGMA 开销可忽略）。
 */
let kindChecked = false;
let hasKind = false;
async function ensureKindColumn(db: D1Database): Promise<boolean> {
  if (kindChecked) return hasKind;
  try {
    const r = await db.prepare("PRAGMA table_info(ocr_cache)").all<{ name: string }>();
    hasKind = (r.results || []).some((c) => c && c.name === "kind");
  } catch {
    hasKind = false;
  }
  kindChecked = true;
  return hasKind;
}

/** 读 ocr_cache（命中且未过期，且 kind 匹配） */
async function readCache(
  db: D1Database,
  attachmentId: string,
  kind: OcrKind
): Promise<{
  fields: Record<string, unknown>;
  matched_short: string | null;
  raw_text: string;
  confidence: "high" | "medium" | "low";
  model: string;
  provider: string;
  created_at: string;
} | null> {
  const withKind = await ensureKindColumn(db);
  const row = await db
    .prepare(
      withKind
        ? "SELECT fields_json, matched_short, raw_text, confidence, model, provider, created_at, expires_at FROM ocr_cache WHERE attachment_id = ? AND kind = ?"
        : "SELECT fields_json, matched_short, raw_text, confidence, model, provider, created_at, expires_at FROM ocr_cache WHERE attachment_id = ?"
    )
    .bind(...(withKind ? [attachmentId, kind] : [attachmentId]))
    .first<{
      fields_json: string;
      matched_short: string | null;
      raw_text: string;
      confidence: "high" | "medium" | "low";
      model: string;
      provider: string;
      created_at: string;
      expires_at: string;
    }>();
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  try {
    return {
      fields: JSON.parse(row.fields_json) as Record<string, unknown>,
      matched_short: row.matched_short,
      raw_text: row.raw_text,
      confidence: row.confidence,
      model: row.model,
      provider: row.provider,
      created_at: row.created_at,
    };
  } catch {
    return null;
  }
}

/** 写 ocr_cache（30 天过期） */
async function writeCache(
  db: D1Database,
  attachmentId: string,
  studentId: string,
  kind: OcrKind,
  rec: { fields: unknown; matched_short?: string | null; raw_text: string; confidence: "high" | "medium" | "low"; model: string; provider: string }
): Promise<void> {
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const withKind = await ensureKindColumn(db);
  const sql = withKind
    ? `INSERT INTO ocr_cache (attachment_id, student_id, kind, model, provider, fields_json, matched_short, raw_text, confidence, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(attachment_id) DO UPDATE SET
         kind = excluded.kind,
         model = excluded.model,
         provider = excluded.provider,
         fields_json = excluded.fields_json,
         matched_short = excluded.matched_short,
         raw_text = excluded.raw_text,
         confidence = excluded.confidence,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`
    : `INSERT INTO ocr_cache (attachment_id, student_id, model, provider, fields_json, matched_short, raw_text, confidence, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(attachment_id) DO UPDATE SET
         model = excluded.model,
         provider = excluded.provider,
         fields_json = excluded.fields_json,
         matched_short = excluded.matched_short,
         raw_text = excluded.raw_text,
         confidence = excluded.confidence,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at`;
  const params: unknown[] = withKind
    ? [attachmentId, studentId, kind, rec.model, rec.provider, JSON.stringify(rec.fields), rec.matched_short ?? null, rec.raw_text.slice(0, 2000), rec.confidence, now, expires]
    : [attachmentId, studentId, rec.model, rec.provider, JSON.stringify(rec.fields), rec.matched_short ?? null, rec.raw_text.slice(0, 2000), rec.confidence, now, expires];
  await db.prepare(sql).bind(...params).run();
}

function ocrEnvOf(c: C): OcrEnv {
  return {
    AI: c.env.AI,
    EXTERNAL_OCR_PROVIDER: c.env.EXTERNAL_OCR_PROVIDER,
    EXTERNAL_OCR_API_KEY: c.env.EXTERNAL_OCR_API_KEY,
    EXTERNAL_OCR_MODEL: c.env.EXTERNAL_OCR_MODEL,
    OCR_MODEL_ORDER: c.env.OCR_MODEL_ORDER,
    OCR_TEXT_MODEL_ORDER: c.env.OCR_TEXT_MODEL_ORDER,
  };
}

/**
 * 共享处理：图片 → 缓存检查 → 限流 → 调模型 → 写缓存。
 * 三条业务线（award/talent/work）共用，差异只在传入的 recognize 回调。
 * 返回 Response 表示失败（已构造好错误响应），调用方直接 return。
 */
async function processVision(
  c: C,
  kind: OcrKind,
  bytes: Uint8Array,
  mime: string,
  attachmentId: string,
  recognize: (bytes: Uint8Array, mime: string) => Promise<VisionOutcome>
): Promise<Record<string, unknown> | Response> {
  const student = c.get("student");
  if (bytes.length > MAX_ATTACHMENT_SIZE) {
    return fail(c, 413, "PAYLOAD_TOO_LARGE", "图片超过 10MB 限制");
  }
  if (!mime.startsWith("image/")) {
    return fail(c, 415, "OCR_INVALID_IMAGE", "识别仅支持图片格式（JPG/PNG/WebP）");
  }
  // 视觉模型对请求体有硬限制，超限会 502——提前拦截并给家长明确指引
  if (bytes.length > MAX_OCR_IMAGE_BYTES) {
    return fail(
      c,
      413,
      "OCR_IMAGE_TOO_LARGE",
      `图片 ${(bytes.length / 1024 / 1024).toFixed(1)}MB 过大。` +
        `请用手机相册的「压缩/编辑」或截图后再上传（建议 4MB 以内、长边 1600px 左右）。`
    );
  }

  // 1. 查缓存
  const cached = await readCache(c.env.DB, attachmentId, kind);
  if (cached) {
    return {
      source: "cache",
      provider: cached.provider,
      model: cached.model,
      duration_ms: 0,
      confidence: cached.confidence,
      fields: cached.fields,
      matched_dict_entry: null,
      raw_text: cached.raw_text,
      hints: ["命中缓存（30 天内），如需重新识别请删除缓存"],
    };
  }

  // 2. 速率限制
  if (!rateCheck(student.id)) {
    return fail(c, 429, "OCR_RATE_LIMIT", "识别太频繁，请稍后再试（每分钟 ≤ 10 次）");
  }

  // 3. 调视觉模型
  let result: VisionOutcome;
  try {
    result = await recognize(bytes, mime);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ocr] ${kind} 模型调用失败：`, msg);
    // 带上模型真实错误（截断），便于定位是格式/限额/模型不可用；前端友好展示
    return fail(
      c,
      502,
      "OCR_PROVIDER_DOWN",
      `AI 识别服务暂时不可用（${msg.slice(0, 160)}）。请稍后重试或手动填写。`
    );
  }

  // 4. 写缓存
  await writeCache(c.env.DB, attachmentId, student.id, kind, {
    fields: result.fields,
    matched_short: "matched_dict_entry" in result ? (result.matched_dict_entry?.short ?? null) : null,
    raw_text: result.raw_text,
    confidence: result.confidence,
    model: result.model,
    provider: result.provider,
  });

  return { source: result.provider === "workers_ai" ? "workers_ai" : "external", ...result };
}

/**
 * v1.9: 文档处理（PDF/Word）——不做视觉识别。
 * 流程与 processVision 对齐：缓存 → 取文件 → 提取文字 → 限流 → 文本 LLM → 写缓存。
 * 差异：只有真正要调 LLM 前才占限流名额（提取不出文字的扫描件不消耗配额）。
 * 返回 Response 表示失败（已构造好错误响应），调用方直接建「仅存原件」条目。
 */
async function processDoc(
  c: C,
  kind: OcrKind,
  att: { r2_key: string; mime_type: string; size: number; original_name: string },
  attachmentId: string
): Promise<Record<string, unknown> | Response> {
  const student = c.get("student");
  if (att.size > MAX_ATTACHMENT_SIZE) {
    return fail(c, 413, "PAYLOAD_TOO_LARGE", "附件超过 10MB 限制");
  }

  // 1. 查缓存（与图片同一套 ocr_cache，30 天内不重复提取）
  const cached = await readCache(c.env.DB, attachmentId, kind);
  if (cached) {
    return {
      source: "cache",
      via: "doc_text",
      provider: cached.provider,
      model: cached.model,
      duration_ms: 0,
      confidence: cached.confidence,
      fields: cached.fields,
      matched_dict_entry: null,
      raw_text: cached.raw_text,
      hints: ["命中缓存（30 天内），如需重新提取请删除缓存"],
    };
  }

  // 2. 取文件 → 提取纯文字（不调 LLM，不占限流）
  const obj = await c.env.BUCKET.get(att.r2_key);
  if (!obj) return fail(c, 404, "NOT_FOUND", "附件文件不存在");
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const doc = await extractDocText(ocrEnvOf(c), bytes, att.mime_type, att.original_name || "");
  if (!doc) {
    const isPdf = att.mime_type === "application/pdf";
    return fail(
      c,
      422,
      "DOC_NO_TEXT",
      isPdf
        ? "这份 PDF 读不到文字（可能是扫描件/图片型 PDF），已保存原件，请手动填写或改传照片"
        : "这份文档读不到文字（旧版 .doc 建议另存为 .docx 或 PDF 再传），已保存原件，请手动填写"
    );
  }

  // 3. 限流（与图片识别同一个桶）
  if (!rateCheck(student.id)) {
    return fail(c, 429, "OCR_RATE_LIMIT", "识别太频繁，请稍后再试（每分钟 ≤ 10 次）");
  }

  // 4. 文本 LLM 抽取结构化字段
  const cfg = getCityConfig(student.city);
  let result;
  try {
    result = await extractFieldsFromDoc(ocrEnvOf(c), kind, { cityName: cfg.name, cups: cfg.cups }, doc, att.original_name || "");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[doc] ${kind} 文档提取失败：`, msg);
    return fail(c, 502, "OCR_PROVIDER_DOWN", `AI 提取服务暂时不可用（${msg.slice(0, 160)}）。文件已保存，请稍后重试或手动填写。`);
  }

  // 5. 写缓存
  await writeCache(c.env.DB, attachmentId, student.id, kind, {
    fields: result.fields,
    matched_short: result.matched_dict_entry?.short ?? null,
    raw_text: result.raw_text,
    confidence: result.confidence,
    model: result.model,
    provider: result.provider,
  });

  return { source: result.provider === "workers_ai" ? "workers_ai" : "external", via: "doc_text", ...result };
}

/** 解析请求里的图片：multipart(file + attachment_id) 或 JSON(attachment_id) */
async function resolveImage(
  c: C
): Promise<{ bytes: Uint8Array; mime: string; attachmentId: string } | Response> {
  const ct = c.req.header("Content-Type") || "";
  const student = c.get("student");
  if (ct.startsWith("multipart/form-data")) {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) return fail(c, 400, "VALIDATION", "缺少 file 字段");
    if (file.size > MAX_ATTACHMENT_SIZE) return fail(c, 413, "PAYLOAD_TOO_LARGE", "图片超过 10MB 限制");
    if (!(file.type || "").startsWith("image/")) return fail(c, 415, "OCR_INVALID_IMAGE", "识别仅支持图片格式（JPG/PNG/WebP）");
    const givenId = typeof body.attachment_id === "string" ? body.attachment_id : "";
    if (!givenId) return fail(c, 400, "VALIDATION", "请先通过 /api/me/attachments 上传图片，再调用识别");
    const owned = await c.env.DB.prepare(
      "SELECT id FROM attachments WHERE id = ? AND student_id = ?"
    )
      .bind(givenId, student.id)
      .first();
    if (!owned) return fail(c, 404, "NOT_FOUND", "附件不存在");
    return {
      bytes: new Uint8Array(await file.arrayBuffer()),
      mime: file.type || "image/jpeg",
      attachmentId: givenId,
    };
  }
  const body = await c.req.json<{ attachment_id?: string }>().catch(() => null);
  if (!body || !body.attachment_id) return fail(c, 400, "VALIDATION", "缺少 attachment_id");
  const got = await fetchOwnedImage(c, body.attachment_id);
  if (!got) return fail(c, 404, "NOT_FOUND", "附件不存在或非图片格式");
  return { bytes: got.bytes, mime: got.mime, attachmentId: body.attachment_id };
}

/** 按 kind 生成对应的识别回调 */
function makeRecognizer(
  c: C,
  kind: OcrKind,
  cfg: ReturnType<typeof getCityConfig>
): (bytes: Uint8Array, mime: string) => Promise<VisionOutcome> {
  const env = ocrEnvOf(c);
  if (kind === "award") {
    return (bytes, mime) => recognizeAward(env, cfg.name, cfg.cups, bytes, mime);
  }
  if (kind === "talent") {
    return (bytes, mime) => recognizeTalent(env, bytes, mime);
  }
  return (bytes, mime) => describeWork(env, bytes, mime);
}

/** 注册一种识别类型的「单张 + 批量」两个端点 */
function registerKind(path: string, kind: OcrKind, label: string) {
  // 单张
  app.post(`/${path}`, async (c) => {
    const img = await resolveImage(c);
    if (img instanceof Response) return img;
    const cfg = getCityConfig(c.get("student").city);
    const result = await processVision(c, kind, img.bytes, img.mime, img.attachmentId, makeRecognizer(c, kind, cfg));
    if (result instanceof Response) return result;
    return ok(c, result);
  });

  // 批量
  app.post(`/${path}/batch`, async (c) => {
    const body = await c.req.json<{ attachment_ids?: string[] }>().catch(() => null);
    if (!body || !Array.isArray(body.attachment_ids) || !body.attachment_ids.length) {
      return fail(c, 400, "VALIDATION", "attachment_ids 必须是非空数组");
    }
    if (body.attachment_ids.length > 20) {
      return fail(c, 400, "VALIDATION", `批量${label}单次最多 20 张`);
    }
    const cfg = getCityConfig(c.get("student").city);
    const recognize = makeRecognizer(c, kind, cfg);

    const results: Array<
      | { ok: true; attachment_id: string; data: unknown }
      | { ok: false; attachment_id: string; error: { code: string; message: string } }
    > = [];

    const queue = [...body.attachment_ids];
    async function worker() {
      while (queue.length) {
        const aid = queue.shift()!;
        try {
          const got = await fetchOwnedImage(c, aid);
          if (!got) {
            results.push({ ok: false, attachment_id: aid, error: { code: "NOT_FOUND", message: "附件不存在或非图片" } });
            continue;
          }
          const r = await processVision(c, kind, got.bytes, got.mime, aid, recognize);
          if (r instanceof Response) {
            let code = "INTERNAL";
            let message = "识别失败";
            try {
              const b = (await r.clone().json()) as { error?: { code?: string; message?: string } };
              if (b && b.error) {
                code = b.error.code || code;
                message = b.error.message || message;
              }
            } catch {
              /* 忽略 */
            }
            results.push({ ok: false, attachment_id: aid, error: { code, message } });
          } else {
            results.push({ ok: true, attachment_id: aid, data: r });
          }
        } catch (e) {
          results.push({
            ok: false,
            attachment_id: aid,
            error: { code: "INTERNAL", message: (e as Error).message || "识别失败" },
          });
        }
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    results.sort((a, b) => body.attachment_ids!.indexOf(a.attachment_id) - body.attachment_ids!.indexOf(b.attachment_id));

    return ok(c, { results });
  });
}

// 注册三条业务线（award 保持 v1.4 的原路径不变，前端无感）
registerKind("award", "award", "识别");
registerKind("talent", "talent", "识别");
registerKind("work", "work", "看图说话");

/* ============================================================================
 * v1.8: POST /api/me/ocr/ingest — 批量材料「识别 + 自动建条目」一条龙
 * v1.9: 按文件类型三路分流——
 *   ① 图片（JPG/PNG/WebP）→ 视觉 OCR（processVision：缓存→限流→视觉模型）
 *   ② PDF/Word → 文档提取（processDoc：toMarkdown 转文字→文本 LLM 抽字段）
 *   ③ 提取不出文字（扫描件 PDF / 老 .doc）或未知类型 → 只保存原件，
 *     建空字段条目（作品/特长用文件名做占位标题），家长手动补填
 *
 * 新上传流程（家长端批量上传卡片）：
 *   家长先选归属（获奖/特长/作品），多选文件逐个上传到 /api/me/attachments
 *  （此时附件 item_id 为空），最后把全部 attachment_id 交给本端点。
 *   建条目后把附件绑定到新条目（UPDATE attachments.item_id + content.cert_images/images 引用）。
 *
 * 设计要点：
 *   - 单文件失败不拖垮整批：识别/提取失败也照常建「空字段 + 文件」条目，
 *     保住已上传材料，错误信息随 results 返回，家长手动补填即可；
 *   - 两条 AI 路径输出契约一致（同一套 sanitize + 杯赛字典），直接展开即合法 section content；
 *   - 每条结果带 via（image_ocr | doc_text），前端按通道区别展示；
 *   - 并发 3 路（与 /batch 一致），updated_at 只在最后统一 touch 一次。
 * ========================================================================== */

type IngestSectionType = "awards" | "talents" | "works";
const INGEST_SECTION_OF: Record<OcrKind, IngestSectionType> = {
  award: "awards",
  talent: "talents",
  work: "works",
};
const INGEST_REF_OF: Record<OcrKind, "cert_images" | "images"> = {
  award: "cert_images",
  talent: "cert_images",
  work: "images",
};

/** 识别失败/提取失败时的兜底空字段（与前端「添加条目」默认值一致） */
function ingestEmptyFields(kind: OcrKind): Record<string, unknown> {
  if (kind === "award") {
    return { name: "", cup_short: "", cup_tier: "", subject: "", org: "", level: "", rank: "", date: "", description: "" };
  }
  if (kind === "talent") {
    return { category: "其他", title: "", description: "", years: "" };
  }
  return { title: "", description: "", link: "" };
}

/** 文件名去扩展名，作为「仅存原件」条目的占位标题（家长看到能认出是哪个文件） */
function filenameStem(name: string): string {
  return String(name || "").replace(/\.[a-zA-Z0-9]{1,8}$/, "").trim().slice(0, 40);
}

/** 从失败的 processDoc/processVision 响应里抠出给家长看的错误消息 */
async function errMsgOf(r: Response, fallback: string): Promise<string> {
  try {
    const b = (await r.clone().json()) as { error?: { message?: string } };
    if (b && b.error && b.error.message) return b.error.message;
  } catch {
    /* 忽略 */
  }
  return fallback;
}

/** 结果面板展示的条目标题 */
function ingestTitleOf(kind: OcrKind, content: Record<string, unknown>): string {
  if (kind === "award") return String(content.name || "") || "获奖记录";
  return String(content.title || "") || (kind === "talent" ? "兴趣特长" : "成长作品");
}

app.post("/ingest", async (c) => {
  const student = c.get("student");
  const body = await c.req
    .json<{ kind?: string; attachment_ids?: unknown }>()
    .catch(() => null);
  if (!body || !OCR_KINDS.includes(body.kind as OcrKind)) {
    return fail(c, 400, "VALIDATION", `kind 必须是 ${OCR_KINDS.join("|")}`);
  }
  const kind = body.kind as OcrKind;
  const ids = Array.isArray(body.attachment_ids)
    ? body.attachment_ids.filter((x): x is string => typeof x === "string" && !!x)
    : [];
  if (!ids.length) return fail(c, 400, "VALIDATION", "attachment_ids 必须是非空数组");
  if (ids.length > 20) return fail(c, 400, "VALIDATION", "单次最多 20 个文件");

  const sectionType = INGEST_SECTION_OF[kind];
  const refField = INGEST_REF_OF[kind];
  const cfg = getCityConfig(student.city);
  const recognize = makeRecognizer(c, kind, cfg);

  interface IngestResult {
    ok: boolean;
    attachment_id: string;
    section_id?: string;
    title?: string;
    confidence?: string;
    /** 处理通道：image_ocr（图片识别）| doc_text（文档提取）；失败/仅存原件时缺省 */
    via?: string;
    error?: string;
  }
  const results: IngestResult[] = [];

  /** 建条目 + 绑定附件；fields 为 null 表示未识别（空字段兜底保住文件，作品/特长用文件名占位标题） */
  async function createItem(
    aid: string,
    fields: Record<string, unknown> | null,
    errMsg?: string,
    fileName?: string
  ): Promise<IngestResult> {
    const content: Record<string, unknown> = { ...(fields || ingestEmptyFields(kind)) };
    // 特长分类为空 → 「其他」：前端下拉没有空选项，留空会在下次编辑时被误存成第一个选项
    if (kind === "talent" && !content.category) content.category = "其他";
    // 作品/特长的标题兜底取文件名（stem），家长在结果面板能认出是哪个文件；奖项名不猜（防止编名进简历）
    if (kind !== "award" && !content.title && fileName) {
      const stem = filenameStem(fileName);
      if (stem) content.title = stem;
    }
    content[refField] = [aid];
    const sid = await uniqueId(c.env.DB, "sections", "s", 5);
    const now = new Date().toISOString();
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO sections (id, student_id, type, content, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
      ).bind(sid, student.id, sectionType, JSON.stringify(content), 0, now, now),
      c.env.DB.prepare(
        "UPDATE attachments SET item_id = ?, section_type = ? WHERE id = ? AND student_id = ?"
      ).bind(sid, sectionType, aid, student.id),
    ]);
    const base: IngestResult = {
      ok: !errMsg,
      attachment_id: aid,
      section_id: sid,
      title: ingestTitleOf(kind, content),
    };
    if (errMsg) base.error = errMsg;
    return base;
  }

  /** 提取/识别成功但关键字段全空 → 降级为「已保存原件，请手动补填」 */
  function fieldsEmpty(fields: Record<string, unknown>): boolean {
    if (kind === "award") return !fields.name;
    return !fields.title;
  }

  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const aid = queue.shift()!;
      try {
        const att = await fetchOwnedAttachment(c, aid);
        if (!att) {
          results.push({ ok: false, attachment_id: aid, error: "附件不存在" });
          continue;
        }

        // ① 图片：视觉 OCR
        if (att.mime_type.startsWith("image/") && ALLOWED_MIME.has(att.mime_type)) {
          const got = await fetchOwnedImage(c, aid);
          if (!got) {
            results.push(await createItem(aid, null, "图片读取失败，原件已保存", att.original_name));
            continue;
          }
          const r = await processVision(c, kind, got.bytes, got.mime, aid, recognize);
          if (r instanceof Response) {
            results.push(await createItem(aid, null, await errMsgOf(r, "AI 识别失败"), att.original_name));
          } else {
            const fields = (r as { fields?: Record<string, unknown> }).fields || null;
            if (fields && fieldsEmpty(fields)) {
              results.push(await createItem(aid, null, "AI 没能从这张图里认出有效内容，原件已保存，请手动填写", att.original_name));
              continue;
            }
            const item = await createItem(aid, fields, undefined, att.original_name);
            item.via = "image_ocr";
            const conf = (r as { confidence?: string }).confidence;
            if (conf) item.confidence = conf;
            results.push(item);
          }
          continue;
        }

        // ② PDF/Word：文档文字提取（不做视觉识别）
        if (isDocMime(att.mime_type)) {
          const r = await processDoc(c, kind, att, aid);
          if (r instanceof Response) {
            results.push(await createItem(aid, null, await errMsgOf(r, "文档提取失败"), att.original_name));
          } else {
            const fields = (r as { fields?: Record<string, unknown> }).fields || null;
            if (fields && fieldsEmpty(fields)) {
              results.push(await createItem(aid, null, "AI 读完文档但没能提取出有效信息，原件已保存，请手动填写", att.original_name));
              continue;
            }
            const item = await createItem(aid, fields, undefined, att.original_name);
            item.via = "doc_text";
            const conf = (r as { confidence?: string }).confidence;
            if (conf) item.confidence = conf;
            results.push(item);
          }
          continue;
        }

        // ③ 其他类型：只保存原件（正常不会走到——上传入口已限定 mime）
        results.push(await createItem(aid, null, "该文件类型仅保存原件，请手动填写内容", att.original_name));
      } catch (e) {
        results.push({
          ok: false,
          attachment_id: aid,
          error: (e as Error).message || "处理失败",
        });
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  results.sort((a, b) => ids.indexOf(a.attachment_id) - ids.indexOf(b.attachment_id));
  await touchUpdatedAt(c.env.DB, student.id);
  return ok(c, { results });
});


// ---------- DELETE /api/me/ocr/cache/:aid ----------
// ?kind=award|talent|work 只清指定类型；不带 kind 清空该附件全部识别缓存
app.delete("/cache/:aid", async (c) => {
  const student = c.get("student");
  const aid = c.req.param("aid");
  const kindQ = c.req.query("kind");
  const owned = await c.env.DB.prepare(
    "SELECT id FROM attachments WHERE id = ? AND student_id = ?"
  )
    .bind(aid, student.id)
    .first();
  if (!owned) return fail(c, 404, "NOT_FOUND", "附件不存在");

  const withKind = await ensureKindColumn(c.env.DB);
  if (kindQ && withKind) {
    if (!OCR_KINDS.includes(kindQ as OcrKind)) {
      return fail(c, 400, "VALIDATION", `kind 必须是 ${OCR_KINDS.join("|")}`);
    }
    await c.env.DB.prepare("DELETE FROM ocr_cache WHERE attachment_id = ? AND kind = ?").bind(aid, kindQ).run();
  } else {
    await c.env.DB.prepare("DELETE FROM ocr_cache WHERE attachment_id = ?").bind(aid).run();
  }
  return ok(c, { deleted: true });
});

/**
 * GET /api/me/ocr/health — 识别服务自检（家长端鉴权）
 *
 * 用途：部署后立刻确认 Workers AI 绑定与视觉模型是否真的可用，避免端到端
 * 靠「上传证书 → 502」这种慢反馈来排障。返回每个候选模型的连通性。
 * 用一个 1×1 的极小 PNG 做探针，几乎不消耗配额。
 */
app.get("/health", async (c) => {
  const cfg = getCityConfig(c.get("student").city);
  // 1×1 透明 PNG 探针（极小，几乎不消耗配额）
  const probeUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wFPn0kAAAAASUVORK5CYII=";
  const probeNums = Array.from(atob(probeUrl.split(",")[1]), (ch) => ch.charCodeAt(0) & 0xff);

  if (!c.env.AI) {
    return ok(c, {
      ai_binding: false,
      external_provider: c.env.EXTERNAL_OCR_PROVIDER || null,
      models: [],
      message: 'Workers AI 未绑定（wrangler.toml 缺少 [ai] binding = "AI"）',
    });
  }

  const order = (c.env.OCR_MODEL_ORDER || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const models = order.length ? order : WORKERS_AI_VISION_MODELS;

  // 每个模型实测两种入参风格：messages（OpenAI 兼容）/ prompt+image（旧式 Image-to-Text）
  const results: Array<{
    model: string;
    style: string;
    ok: boolean;
    error?: string;
    est_neurons_per_call: number;
    est_calls_per_free_day: number;
  }> = [];

  for (const model of models) {
    for (const style of ["messages", "prompt"] as const) {
      const est = estimateNeurons(model);
      try {
        await c.env.AI.run(
          model,
          (style === "messages"
            ? {
                messages: [
                  { role: "system", content: "只回复 OK 两个字母。" },
                  {
                    role: "user",
                    content: [
                      { type: "text", text: "ping" },
                      { type: "image_url", image_url: { url: probeUrl } },
                    ],
                  },
                ],
                max_tokens: 8,
              }
            : { prompt: "ping，只回复 OK 两个字母。", image: probeNums, max_tokens: 8 }) as Parameters<Ai["run"]>[1]
        );
        results.push({
          model,
          style,
          ok: true,
          est_neurons_per_call: est,
          est_calls_per_free_day: est > 0 ? Math.floor(10000 / est) : -1,
        });
      } catch (e) {
        results.push({
          model,
          style,
          ok: false,
          error: (e instanceof Error ? e.message : String(e)).slice(0, 180),
          est_neurons_per_call: est,
          est_calls_per_free_day: est > 0 ? Math.floor(10000 / est) : -1,
        });
      }
    }
  }

  // ?activate=1 → 对报「需先同意许可协议」（CF 错误 5016）的模型发一次 {"prompt":"agree"} 激活。
  // Meta 的 llama-3.2-11b-vision 首次使用前必须走这一步，否则一直报 5016。
  // 激活是账号级、一次性的；激活后重跑 health（不带参数）即可看到状态变化。
  const activated: Array<{ model: string; ok: boolean; error?: string }> = [];
  if (c.req.query("activate") === "1") {
    for (const r of results.filter((x) => !x.ok && /agree|5016/i.test(x.error || ""))) {
      const model = r.model;
      if (activated.some((a) => a.model === model)) continue;
      try {
        await c.env.AI.run(model, { prompt: "agree" } as Parameters<Ai["run"]>[1]);
        activated.push({ model, ok: true });
      } catch (e) {
        activated.push({
          model,
          ok: false,
          error: (e instanceof Error ? e.message : String(e)).slice(0, 180),
        });
      }
    }
  }

  const firstOk = results.find((r) => r.ok);
  return ok(c, {
    ai_binding: true,
    external_provider: c.env.EXTERNAL_OCR_PROVIDER || null,
    city: cfg.name,
    cup_count: cfg.cups.length,
    free_allowance_neurons_per_day: 10000,
    // v1.5: 三种识别类型
    kinds: OCR_KINDS,
    ...(activated.length ? { activated } : {}),
    recommended: firstOk ? { model: firstOk.model, style: firstOk.style } : null,
    // 建议写入 wrangler.toml 的 OCR_MODEL_ORDER（把可用且最省/最准的排前面）
    suggested_order: results
      .filter((r) => r.ok)
      .map((r) => r.model)
      .filter((m, i, a) => a.indexOf(m) === i),
    results,
  });
});

export default app;
