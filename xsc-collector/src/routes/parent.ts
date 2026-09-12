// 家长端 API（/api/me/*，Bearer invite_token）— architecture.md 4.1
import { Hono } from "hono";
import type { Context } from "hono";
import type {
  AttachmentSectionType,
  BasicInfo,
  Env,
  EssayMaterial,
  SectionType,
  StudentRow,
} from "../types";
import { SECTION_TYPES } from "../types";
import { parentAuth } from "../lib/auth";
import { buildMeResponse, touchUpdatedAt } from "../db/queries";
import { rand4, uniqueId } from "../lib/ids";
import { ALLOWED_MIME, MAX_ATTACHMENT_SIZE, extOf, isImage } from "../lib/validate";
import { TEMPLATE_IDS, isTemplateId } from "../lib/templates";

type Vars = { student: StudentRow };
type C = Context<{ Bindings: Env; Variables: Vars }>;

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use("/*", parentAuth);

const ok = (c: C, data: unknown) => c.json({ ok: true, data });
const fail = (c: C, status: number, code: string, message: string) =>
  c.json({ ok: false, error: { code, message } }, status as 400);

const ATTACHMENT_SECTION_TYPES: AttachmentSectionType[] = [
  "basic",
  "general",
  ...SECTION_TYPES,
];

/** 规范化 JSON（键排序），用于「内容是否真的变了」的幂等比对 */
function canon(o: unknown): string {
  if (o === null || typeof o !== "object") return JSON.stringify(o) ?? "null";
  if (Array.isArray(o)) return "[" + o.map(canon).join(",") + "]";
  const keys = Object.keys(o as Record<string, unknown>).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + canon((o as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

// ---------- GET /api/me ----------
app.get("/", async (c) => {
  const data = await buildMeResponse(c.env.DB, c.get("student"));
  return ok(c, data);
});

// ---------- PUT /api/me/basic ----------
// 保存基本信息（含 essay_material / family_note / template_id，可分字段提交）
app.put("/basic", async (c) => {
  const student = c.get("student");
  const body = await c.req.json<{
    basic?: Partial<BasicInfo>;
    essay_material?: Partial<EssayMaterial>;
    family_note?: string;
    template_id?: string;
  }>().catch(() => null);
  if (!body) return fail(c, 400, "VALIDATION", "请求体必须是 JSON");

  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  let changed = false;

  if (body.basic && typeof body.basic === "object") {
    const cur = JSON.parse(student.basic || "{}") as BasicInfo;
    // photo 只允许已属于该学生的附件 id
    if (body.basic.photo !== undefined && body.basic.photo !== null) {
      const att = await c.env.DB.prepare(
        "SELECT id FROM attachments WHERE id = ? AND student_id = ?"
      )
        .bind(String(body.basic.photo), student.id)
        .first();
      if (!att) return fail(c, 400, "VALIDATION", "照片附件不存在");
    }
    const merged: BasicInfo = { ...cur, ...body.basic };
    // 只允许契约内字段
    const clean: BasicInfo = {
      gender: merged.gender || "",
      birth_date: merged.birth_date || "",
      primary_school: merged.primary_school || "",
      hukou_district: merged.hukou_district || "",
      photo: merged.photo ?? null,
    };
    // 幂等：内容无变化不写库、不 bump 版本（防止 blur 无操作虚抬版本）
    if (canon(clean) !== canon(cur)) {
      changed = true;
      stmts.push(
        c.env.DB.prepare("UPDATE students SET basic = ?, updated_at = ? WHERE id = ?").bind(
          JSON.stringify(clean),
          now,
          student.id
        )
      );
    }
  }

  if (body.essay_material && typeof body.essay_material === "object") {
    const cur = JSON.parse(student.essay_material || "{}") as EssayMaterial;
    const merged = { ...cur, ...body.essay_material };
    const clean: EssayMaterial = {
      personality: merged.personality || "",
      study_habits: merged.study_habits || "",
      interests: merged.interests || "",
      highlights: merged.highlights || "",
    };
    if (canon(clean) !== canon(cur)) {
      changed = true;
      stmts.push(
        c.env.DB.prepare("UPDATE students SET essay_material = ?, updated_at = ? WHERE id = ?").bind(
          JSON.stringify(clean),
          now,
          student.id
        )
      );
    }
  }

  if (typeof body.family_note === "string" && body.family_note !== student.family_note) {
    changed = true;
    stmts.push(
      c.env.DB.prepare("UPDATE students SET family_note = ?, updated_at = ? WHERE id = ?").bind(
        body.family_note,
        now,
        student.id
      )
    );
  }

  // 模板自选：影响渲染，变更视为材料写操作（bump → 重新生成）
  if (body.template_id !== undefined) {
    if (!isTemplateId(String(body.template_id))) {
      return fail(c, 400, "VALIDATION", `template_id 必须是 ${TEMPLATE_IDS.join("|")}`);
    }
    if (body.template_id !== student.template_id) {
      changed = true;
      stmts.push(
        c.env.DB.prepare("UPDATE students SET template_id = ?, updated_at = ? WHERE id = ?").bind(
          String(body.template_id),
          now,
          student.id
        )
      );
    }
  }

  // 字段存在但内容无变化：静默成功（saved:true），不写库不 bump
  if (stmts.length === 0) {
    const hasField =
      body.basic !== undefined ||
      body.essay_material !== undefined ||
      typeof body.family_note === "string" ||
      body.template_id !== undefined;
    if (!hasField) return fail(c, 400, "VALIDATION", "没有可保存的字段");
    return ok(c, { saved: true, unchanged: true });
  }
  await c.env.DB.batch(stmts);
  if (changed) await touchUpdatedAt(c.env.DB, student.id);
  return ok(c, { saved: true });
});

// ---------- contacts ----------
app.post("/contacts", async (c) => {
  const student = c.get("student");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.relation !== "string" || !body.relation.trim()) {
    return fail(c, 400, "VALIDATION", "关系（relation）必填");
  }
  const id = await uniqueId(c.env.DB, "contacts", "c", 6);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO contacts (id, student_id, relation, name, work_unit, title, phone, sort_order) VALUES (?,?,?,?,?,?,?,?)"
  )
    .bind(
      id,
      student.id,
      String(body.relation).trim(),
      String(body.name || ""),
      String(body.work_unit || ""),
      String(body.title || ""),
      String(body.phone || ""),
      Number(body.sort_order) || 0
    )
    .run();
  await touchUpdatedAt(c.env.DB, student.id);
  return ok(c, { id });
});

app.put("/contacts/:id", async (c) => {
  const student = c.get("student");
  const id = c.req.param("id");
  const owned = await c.env.DB.prepare(
    "SELECT * FROM contacts WHERE id = ? AND student_id = ?"
  )
    .bind(id, student.id)
    .first<Record<string, unknown>>();
  if (!owned) return fail(c, 404, "NOT_FOUND", "家庭成员不存在");
  const body = await c.req.json().catch(() => null);
  if (!body) return fail(c, 400, "VALIDATION", "请求体必须是 JSON");
  const next = {
    relation: String(body.relation ?? ""),
    name: String(body.name ?? ""),
    work_unit: String(body.work_unit ?? ""),
    title: String(body.title ?? ""),
    phone: String(body.phone ?? ""),
    sort_order: Number(body.sort_order) || 0,
  };
  const unchanged =
    owned.relation === next.relation &&
    owned.name === next.name &&
    owned.work_unit === next.work_unit &&
    owned.title === next.title &&
    owned.phone === next.phone &&
    Number(owned.sort_order) === next.sort_order;
  if (unchanged) return ok(c, { saved: true, unchanged: true });
  await c.env.DB.prepare(
    "UPDATE contacts SET relation=?, name=?, work_unit=?, title=?, phone=?, sort_order=? WHERE id=?"
  )
    .bind(next.relation, next.name, next.work_unit, next.title, next.phone, next.sort_order, id)
    .run();
  await touchUpdatedAt(c.env.DB, student.id);
  return ok(c, { saved: true });
});

app.delete("/contacts/:id", async (c) => {
  const student = c.get("student");
  const id = c.req.param("id");
  const r = await c.env.DB.prepare("DELETE FROM contacts WHERE id = ? AND student_id = ?")
    .bind(id, student.id)
    .run();
  if (!r.meta.changes) return fail(c, 404, "NOT_FOUND", "家庭成员不存在");
  await touchUpdatedAt(c.env.DB, student.id);
  return ok(c, { deleted: true });
});

// ---------- sections ----------
app.post("/sections", async (c) => {
  const student = c.get("student");
  const body = await c.req.json<{ type?: string; content?: Record<string, unknown> }>().catch(() => null);
  if (!body || !SECTION_TYPES.includes(body.type as SectionType)) {
    return fail(c, 400, "VALIDATION", `type 必须是 ${SECTION_TYPES.join("|")}`);
  }
  const id = await uniqueId(c.env.DB, "sections", "s", 5);
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO sections (id, student_id, type, content, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?)"
  )
    .bind(id, student.id, body.type, JSON.stringify(body.content || {}), 0, now, now)
    .run();
  await touchUpdatedAt(c.env.DB, student.id);
  return ok(c, { id });
});

app.put("/sections/:id", async (c) => {
  const student = c.get("student");
  const id = c.req.param("id");
  const owned = await c.env.DB.prepare(
    "SELECT id, content FROM sections WHERE id = ? AND student_id = ?"
  )
    .bind(id, student.id)
    .first<{ id: string; content: string }>();
  if (!owned) return fail(c, 404, "NOT_FOUND", "条目不存在");
  const body = await c.req.json<{ content?: Record<string, unknown> }>().catch(() => null);
  if (!body || typeof body.content !== "object" || body.content === null) {
    return fail(c, 400, "VALIDATION", "content 必须是对象");
  }
  // 幂等：内容与现有一致则静默成功，不写库不 bump
  let curContent: unknown = {};
  try { curContent = JSON.parse(owned.content || "{}"); } catch { /* 忽略 */ }
  if (canon(body.content) === canon(curContent)) {
    return ok(c, { saved: true, unchanged: true });
  }
  await c.env.DB.prepare("UPDATE sections SET content = ?, updated_at = ? WHERE id = ?")
    .bind(JSON.stringify(body.content), new Date().toISOString(), id)
    .run();
  await touchUpdatedAt(c.env.DB, student.id);
  return ok(c, { saved: true });
});

app.delete("/sections/:id", async (c) => {
  const student = c.get("student");
  const id = c.req.param("id");
  const owned = await c.env.DB.prepare(
    "SELECT id FROM sections WHERE id = ? AND student_id = ?"
  )
    .bind(id, student.id)
    .first();
  if (!owned) return fail(c, 404, "NOT_FOUND", "条目不存在");

  // 关联附件同时删除，R2 对象异步清理（architecture.md 4.1）
  const atts = await c.env.DB.prepare(
    "SELECT id, r2_key FROM attachments WHERE student_id = ? AND item_id = ?"
  )
    .bind(student.id, id)
    .all<{ id: string; r2_key: string }>();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM sections WHERE id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM attachments WHERE student_id = ? AND item_id = ?").bind(
      student.id,
      id
    ),
  ]);
  if (atts.results.length) {
    c.executionCtx.waitUntil(
      Promise.all(atts.results.map((a) => c.env.BUCKET.delete(a.r2_key))).catch(() => {})
    );
  }
  await touchUpdatedAt(c.env.DB, student.id);
  return ok(c, { deleted: true });
});

// ---------- attachments ----------
app.post("/attachments", async (c) => {
  const student = c.get("student");
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) return fail(c, 400, "VALIDATION", "缺少 file 字段");

  const sectionType = String(body.section_type || "general") as AttachmentSectionType;
  if (!ATTACHMENT_SECTION_TYPES.includes(sectionType)) {
    return fail(c, 400, "VALIDATION", "section_type 不合法");
  }
  const mime = file.type || "application/octet-stream";
  if (!ALLOWED_MIME.has(mime)) {
    return fail(c, 415, "UNSUPPORTED_MEDIA_TYPE", "仅支持 JPG/PNG/WebP 图片、PDF 或 Word 文档");
  }
  if (file.size > MAX_ATTACHMENT_SIZE) {
    return fail(c, 413, "PAYLOAD_TOO_LARGE", "附件超过 10MB 限制");
  }
  const itemId = typeof body.item_id === "string" && body.item_id ? body.item_id : null;
  if (itemId) {
    const owned = await c.env.DB.prepare(
      "SELECT id FROM sections WHERE id = ? AND student_id = ?"
    )
      .bind(itemId, student.id)
      .first();
    if (!owned) return fail(c, 400, "VALIDATION", "关联条目不存在");
  }

  const id = await uniqueId(c.env.DB, "attachments", "a", 5);
  const ext = extOf(mime, file.name);
  const r2Key = `students/${student.id}/attachments/${id}.${ext}`;
  await c.env.BUCKET.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType: mime },
  });
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO attachments (id, student_id, section_type, item_id, r2_key, original_name, mime_type, size, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  )
    .bind(
      id,
      student.id,
      sectionType,
      itemId,
      r2Key,
      file.name || `${id}.${ext}`,
      mime,
      file.size,
      Number(body.sort_order) || 0,
      now
    )
    .run();
  await touchUpdatedAt(c.env.DB, student.id);
  return ok(c, {
    id,
    url: `/api/me/attachments/${id}`,
    name: file.name || `${id}.${ext}`,
    mime_type: mime,
    size: file.size,
  });
});

// 图片预览/下载：从 R2 流式返回（家长端，校验附件归属）
app.get("/attachments/:id", async (c) => {
  const student = c.get("student");
  const att = await c.env.DB.prepare(
    "SELECT * FROM attachments WHERE id = ? AND student_id = ?"
  )
    .bind(c.req.param("id"), student.id)
    .first<{ r2_key: string; mime_type: string }>();
  if (!att) return fail(c, 404, "NOT_FOUND", "附件不存在");
  const obj = await c.env.BUCKET.get(att.r2_key);
  if (!obj) return fail(c, 404, "NOT_FOUND", "附件文件不存在");
  return new Response(obj.body, {
    headers: {
      "Content-Type": att.mime_type,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

app.delete("/attachments/:id", async (c) => {
  const student = c.get("student");
  const id = c.req.param("id");
  const att = await c.env.DB.prepare(
    "SELECT id, r2_key, section_type FROM attachments WHERE id = ? AND student_id = ?"
  )
    .bind(id, student.id)
    .first<{ id: string; r2_key: string; section_type: string }>();
  if (!att) return fail(c, 404, "NOT_FOUND", "附件不存在");
  await c.env.DB.prepare("DELETE FROM attachments WHERE id = ?").bind(id).run();
  c.executionCtx.waitUntil(c.env.BUCKET.delete(att.r2_key).catch(() => {}));
  // 若是头像，同时清掉 basic.photo 引用
  if (att.section_type === "basic") {
    const basic = JSON.parse(student.basic || "{}") as BasicInfo;
    if (basic.photo === id) {
      basic.photo = null;
      await c.env.DB.prepare("UPDATE students SET basic = ? WHERE id = ?")
        .bind(JSON.stringify(basic), student.id)
        .run();
    }
  }
  await touchUpdatedAt(c.env.DB, student.id);
  return ok(c, { deleted: true });
});

// ---------- submit ----------
// v1.3 版本机制：material_version 只在这里推进。
// 规则：当前版本已被「消费」过（已导出或已生成 PDF）且自上次提交后有新修改时才 +1。
// 首次提交保持 v1；连续重复点击（无新修改）不 bump。
app.post("/submit", async (c) => {
  const student = c.get("student");
  const basic = JSON.parse(student.basic || "{}") as BasicInfo;
  const missing: string[] = [];
  if (!student.name.trim()) missing.push("孩子姓名");
  if (!basic.primary_school?.trim()) missing.push("毕业小学");
  const phoneRow = await c.env.DB.prepare(
    "SELECT 1 AS x FROM contacts WHERE student_id = ? AND phone != '' LIMIT 1"
  )
    .bind(student.id)
    .first();
  if (!phoneRow) missing.push("至少一个联系电话");
  if (missing.length) {
    return fail(c, 400, "VALIDATION", `请完善必填项：${missing.join("、")}`);
  }

  const resumeRow = await c.env.DB.prepare(
    "SELECT 1 AS x FROM resumes WHERE student_id = ? LIMIT 1"
  )
    .bind(student.id)
    .first();
  const consumed =
    (student.exported_version ?? 0) >= student.material_version || !!resumeRow;
  const dirty = !student.submitted_at || student.updated_at > student.submitted_at;
  const bump = consumed && dirty;

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE students
     SET status = 'submitted',
         submitted_at = ?,
         updated_at = ?,
         material_version = material_version + ${bump ? 1 : 0}
     WHERE id = ?`
  )
    .bind(now, now, student.id)
    .run();

  const fresh = await c.env.DB.prepare("SELECT material_version FROM students WHERE id = ?")
    .bind(student.id)
    .first<{ material_version: number }>();
  return ok(c, { status: "submitted", material_version: fresh?.material_version });
});

// ---------- resumes（家长端：仅审核通过可见） ----------
app.get("/resumes", async (c) => {
  const student = c.get("student");
  const r = await c.env.DB.prepare(
    "SELECT id, material_version, file_name, note, created_at FROM resumes WHERE student_id = ? AND review_status = 'approved' ORDER BY created_at DESC"
  )
    .bind(student.id)
    .all();
  const list = r.results.map((x: Record<string, unknown>, i: number) => ({
    ...x,
    is_latest: i === 0,
  }));
  return ok(c, list);
});

app.get("/resumes/:id", async (c) => {
  const student = c.get("student");
  const row = await c.env.DB.prepare(
    "SELECT r2_key, file_name FROM resumes WHERE id = ? AND student_id = ? AND review_status = 'approved'"
  )
    .bind(c.req.param("id"), student.id)
    .first<{ r2_key: string; file_name: string }>();
  if (!row) return fail(c, 404, "NOT_FOUND", "简历不存在或待审核");
  const obj = await c.env.BUCKET.get(row.r2_key);
  if (!obj) return fail(c, 404, "NOT_FOUND", "简历文件不存在");
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
      "Cache-Control": "private, no-cache",
    },
  });
});

export default app;
