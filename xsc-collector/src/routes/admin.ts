// 管理端 API（/api/admin/*，X-Admin-Key 头）— architecture.md 4.2
import { Hono } from "hono";
import type { Env, StudentRow } from "../types";
import { adminAuth } from "../lib/auth";
import { CITY_CONFIGS } from "../lib/city-configs";
import { TEMPLATE_IDS } from "../lib/templates";
import { inviteToken, uniqueId } from "../lib/ids";
import { buildMeResponse, deriveNeedsRegen } from "../db/queries";
import { MAX_ATTACHMENT_SIZE } from "../lib/validate";

const REVISION_FILE_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf",
]);
const MAX_REVISION_FILES = 5;

const app = new Hono<{ Bindings: Env }>();

app.use("/*", adminAuth);

const ok = (c: any, data: unknown) => c.json({ ok: true, data });
const fail = (c: any, status: number, code: string, message: string) =>
  c.json({ ok: false, error: { code, message } }, status);

const TEMPLATES = TEMPLATE_IDS;

// POST /api/admin/students — 创建学生 {name, city?, template_id?} → 邀请链接
app.post("/students", async (c) => {
  const body = await c.req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  if (!name) return fail(c, 400, "VALIDATION", "学生姓名必填");
  const city = String(body?.city || "guangzhou");
  if (!CITY_CONFIGS[city]) {
    return fail(c, 400, "VALIDATION", `city 必须是 ${Object.keys(CITY_CONFIGS).join("|")}`);
  }
  const templateId = String(body?.template_id || "classic-blue");
  if (!TEMPLATES.includes(templateId)) {
    return fail(c, 400, "VALIDATION", `template_id 必须是 ${TEMPLATES.join("|")}`);
  }

  const id = await uniqueId(c.env.DB, "students", "S", 4);
  const token = inviteToken();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO students (id, name, city, invite_token, status, material_version, template_id, created_at, updated_at) VALUES (?,?,?,?, 'collecting', 1, ?, ?, ?)"
  )
    .bind(id, name, city, token, templateId, now, now)
    .run();

  const origin = new URL(c.req.url).origin;
  return ok(c, {
    id,
    name,
    city,
    invite_url: `${origin}/s/${token}`,
  });
});

// GET /api/admin/students — 列表（含城市/状态/版本/needs_regen/最新简历/待审核数）
app.get("/students", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT
       s.id, s.name, s.city, s.status, s.material_version, s.template_id,
       s.invite_token, s.created_at, s.updated_at, s.submitted_at,
       (SELECT MAX(material_version) FROM resumes WHERE student_id = s.id AND review_status = 'approved') AS max_resume_mv,
       (SELECT file_name FROM resumes WHERE student_id = s.id ORDER BY created_at DESC LIMIT 1) AS latest_resume_name,
       (SELECT id FROM resumes WHERE student_id = s.id ORDER BY created_at DESC LIMIT 1) AS latest_resume_id,
       (SELECT COUNT(*) FROM resumes WHERE student_id = s.id AND review_status = 'pending') AS pending_review_count
     FROM students s
     ORDER BY s.created_at DESC`
  ).all();
  const origin = new URL(c.req.url).origin;
  const list = r.results.map((row: any) => ({
    id: row.id,
    name: row.name,
    city: row.city,
    city_name: CITY_CONFIGS[row.city]?.name || row.city,
    status: row.status,
    material_version: row.material_version,
    needs_regen: row.max_resume_mv !== null && row.material_version > row.max_resume_mv,
    latest_resume_id: row.latest_resume_id,
    latest_resume_name: row.latest_resume_name,
    pending_review_count: row.pending_review_count,
    unsubmitted_changes: !!row.submitted_at && row.updated_at > row.submitted_at,
    template_id: row.template_id,
    invite_url: `${origin}/s/${row.invite_token}`,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  return ok(c, list);
});

// GET /api/admin/students/:id — 详情（同家长端数据 + 邀请链接 + 全部简历含审核状态）
app.get("/students/:id", async (c) => {
  const student = await c.env.DB.prepare("SELECT * FROM students WHERE id = ?")
    .bind(c.req.param("id"))
    .first<StudentRow>();
  if (!student) return fail(c, 404, "NOT_FOUND", "学生不存在");
  const origin = new URL(c.req.url).origin;
  const data = await buildMeResponse(c.env.DB, student, `/api/admin/attachments`, "admin");
  return ok(c, { ...data, invite_url: `${origin}/s/${student.invite_token}` });
});

// POST /api/admin/students/:id/resumes/:rid/approve — 审核通过 → 家长可见
app.post("/students/:id/resumes/:rid/approve", async (c) => {
  const sid = c.req.param("id");
  const rid = c.req.param("rid");
  const resume = await c.env.DB.prepare(
    "SELECT id, review_status FROM resumes WHERE id = ? AND student_id = ?"
  )
    .bind(rid, sid)
    .first<{ id: string; review_status: string }>();
  if (!resume) return fail(c, 404, "NOT_FOUND", "简历不存在");
  if (resume.review_status === "approved") return ok(c, { approved: true, already: true });

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE resumes SET review_status = 'approved', reviewed_at = ? WHERE id = ?"
  )
    .bind(now, rid)
    .run();
  // 学生在「待审核」时通过审核 → ready（家长端显示已生成）
  await c.env.DB.prepare(
    "UPDATE students SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'review'"
  )
    .bind(now, sid)
    .run();
  return ok(c, { approved: true });
});

// POST /api/admin/students/:id/resumes/:rid/reject — 驳回 → 学生回到待导出队列重新生成
app.post("/students/:id/resumes/:rid/reject", async (c) => {
  const sid = c.req.param("id");
  const rid = c.req.param("rid");
  const resume = await c.env.DB.prepare(
    "SELECT id, review_status, note FROM resumes WHERE id = ? AND student_id = ?"
  )
    .bind(rid, sid)
    .first<{ id: string; review_status: string; note: string }>();
  if (!resume) return fail(c, 404, "NOT_FOUND", "简历不存在");
  const body = await c.req.json().catch(() => ({}));
  const reason = String(body?.reason || "").trim();
  const now = new Date().toISOString();

  const note = [resume.note, reason ? `驳回原因：${reason}` : "已驳回"].filter(Boolean).join("；");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE resumes SET review_status = 'rejected', reviewed_at = ?, note = ? WHERE id = ?"
    ).bind(now, note, rid),
    // exported_version 置 NULL + status 回 submitted → 下次导出自动重进队列
    c.env.DB.prepare(
      "UPDATE students SET status = 'submitted', exported_version = NULL, updated_at = ? WHERE id = ?"
    ).bind(now, sid),
  ]);
  return ok(c, { rejected: true });
});

// POST /api/admin/students/:id/resumes/:rid/revise — 退回修改（multipart）
// 修改意见 note 必填；佐证文件 files 可选（可多传，图片/PDF，单个 ≤10MB，最多 5 个）。
// 学生回到待导出队列，下次导出时 profile.json 携带 revision（意见+上一版自荐信+佐证文件），
// AI 在原有简历基础上结合修改意见重新生成。
app.post("/students/:id/resumes/:rid/revise", async (c) => {
  const sid = c.req.param("id");
  const rid = c.req.param("rid");
  const resume = await c.env.DB.prepare(
    "SELECT id, review_status, note FROM resumes WHERE id = ? AND student_id = ?"
  )
    .bind(rid, sid)
    .first<{ id: string; review_status: string; note: string }>();
  if (!resume) return fail(c, 404, "NOT_FOUND", "简历不存在");

  const body = await c.req.parseBody();
  const noteText = String(body.note || "").trim();
  if (!noteText) return fail(c, 400, "VALIDATION", "修改意见必填");

  const rawFiles = body.files;
  const files = (Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : []).filter(
    (f): f is File => f instanceof File && f.size > 0
  );
  if (files.length > MAX_REVISION_FILES) {
    return fail(c, 400, "VALIDATION", `佐证文件最多 ${MAX_REVISION_FILES} 个`);
  }
  for (const f of files) {
    if (!REVISION_FILE_TYPES.has(f.type)) {
      return fail(c, 415, "UNSUPPORTED_MEDIA_TYPE", `不支持的文件类型：${f.name}（仅图片/PDF）`);
    }
    if (f.size > MAX_ATTACHMENT_SIZE) {
      return fail(c, 413, "PAYLOAD_TOO_LARGE", `文件超过 10MB 限制：${f.name}`);
    }
  }

  const now = new Date().toISOString();
  // 先传文件到 R2 + 落库，任一失败则不改变简历状态（可安全重试）
  const inserted: { id: string; r2_key: string; original_name: string; size: number }[] = [];
  for (const f of files) {
    const fid = await uniqueId(c.env.DB, "revision_files", "rf", 6);
    const safeName = f.name.replace(/[\\/:*?"<>|]/g, "_").slice(-80) || "file";
    const r2Key = `revisions/${sid}/${rid}/${fid}-${safeName}`;
    await c.env.BUCKET.put(r2Key, await f.arrayBuffer(), {
      httpMetadata: { contentType: f.type },
    });
    await c.env.DB.prepare(
      "INSERT INTO revision_files (id, resume_id, student_id, r2_key, original_name, mime_type, size, created_at) VALUES (?,?,?,?,?,?,?,?)"
    )
      .bind(fid, rid, sid, r2Key, f.name, f.type, f.size, now)
      .run();
    inserted.push({ id: fid, r2_key: r2Key, original_name: f.name, size: f.size });
  }

  const note = [resume.note, `退回修改：${noteText}`].filter(Boolean).join("；");
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE resumes SET review_status = 'rejected', reviewed_at = ?, note = ?, revision_note = ? WHERE id = ?"
    ).bind(now, note, noteText, rid),
    // exported_version 置 NULL + status 回 submitted → 下次导出自动重进队列并携带 revision
    c.env.DB.prepare(
      "UPDATE students SET status = 'submitted', exported_version = NULL, updated_at = ? WHERE id = ?"
    ).bind(now, sid),
  ]);
  return ok(c, { revised: true, files: inserted.map((f) => ({ id: f.id, name: f.original_name })) });
});

// GET /api/admin/students/:id/revision-files/:fid — 查看退回修改的佐证文件（流式）
app.get("/students/:id/revision-files/:fid", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT r2_key, original_name, mime_type FROM revision_files WHERE id = ? AND student_id = ?"
  )
    .bind(c.req.param("fid"), c.req.param("id"))
    .first<{ r2_key: string; original_name: string; mime_type: string }>();
  if (!row) return fail(c, 404, "NOT_FOUND", "文件不存在");
  const obj = await c.env.BUCKET.get(row.r2_key);
  if (!obj) return fail(c, 404, "NOT_FOUND", "文件内容不存在");
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.mime_type,
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(row.original_name)}`,
      "Cache-Control": "private, max-age=3600",
    },
  });
});

// PATCH /api/admin/students/:id — 修改 template_id / 重置 invite_token（city 不可改）
app.patch("/students/:id", async (c) => {
  const student = await c.env.DB.prepare("SELECT * FROM students WHERE id = ?")
    .bind(c.req.param("id"))
    .first<StudentRow>();
  if (!student) return fail(c, 404, "NOT_FOUND", "学生不存在");
  const body = await c.req.json().catch(() => null);
  if (!body) return fail(c, 400, "VALIDATION", "请求体必须是 JSON");
  if (body.city !== undefined && body.city !== student.city) {
    return fail(c, 400, "VALIDATION", "城市创建后不可修改");
  }

  let newToken: string | null = null;
  if (body.template_id !== undefined) {
    if (!TEMPLATES.includes(String(body.template_id))) {
      return fail(c, 400, "VALIDATION", `template_id 必须是 ${TEMPLATES.join("|")}`);
    }
    await c.env.DB.prepare("UPDATE students SET template_id = ?, updated_at = ? WHERE id = ?")
      .bind(String(body.template_id), new Date().toISOString(), student.id)
      .run();
  }
  if (body.reset_token) {
    newToken = inviteToken();
    await c.env.DB.prepare("UPDATE students SET invite_token = ?, updated_at = ? WHERE id = ?")
      .bind(newToken, new Date().toISOString(), student.id)
      .run();
  }
  const origin = new URL(c.req.url).origin;
  return ok(c, {
    id: student.id,
    template_id: body.template_id ?? student.template_id,
    invite_url: newToken ? `${origin}/s/${newToken}` : undefined,
  });
});

// GET /api/admin/students/:id/resumes/:rid — 查看 PDF（流式）
app.get("/students/:id/resumes/:rid", async (c) => {
  const row = await c.env.DB.prepare(
    "SELECT r2_key, file_name FROM resumes WHERE id = ? AND student_id = ?"
  )
    .bind(c.req.param("rid"), c.req.param("id"))
    .first<{ r2_key: string; file_name: string }>();
  if (!row) return fail(c, 404, "NOT_FOUND", "简历不存在");
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

// GET /api/admin/attachments/:id — 管理端查看附件（详情页用）
app.get("/attachments/:id", async (c) => {
  const att = await c.env.DB.prepare("SELECT r2_key, mime_type FROM attachments WHERE id = ?")
    .bind(c.req.param("id"))
    .first<{ r2_key: string; mime_type: string }>();
  if (!att) return fail(c, 404, "NOT_FOUND", "附件不存在");
  const obj = await c.env.BUCKET.get(att.r2_key);
  if (!obj) return fail(c, 404, "NOT_FOUND", "附件文件不存在");
  return new Response(obj.body, {
    headers: {
      "Content-Type": att.mime_type,
      "Cache-Control": "private, max-age=3600",
    },
  });
});

// DELETE /api/admin/students/:id — 交付完成后清空学生材料（第 10 章安全设计）
app.delete("/students/:id", async (c) => {
  const student = await c.env.DB.prepare("SELECT id FROM students WHERE id = ?")
    .bind(c.req.param("id"))
    .first();
  if (!student) return fail(c, 404, "NOT_FOUND", "学生不存在");
  const sid = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM export_items WHERE student_id = ?").bind(sid),
    c.env.DB.prepare("DELETE FROM attachments WHERE student_id = ?").bind(sid),
    c.env.DB.prepare("DELETE FROM sections WHERE student_id = ?").bind(sid),
    c.env.DB.prepare("DELETE FROM contacts WHERE student_id = ?").bind(sid),
    c.env.DB.prepare("DELETE FROM resumes WHERE student_id = ?").bind(sid),
    c.env.DB.prepare("DELETE FROM revision_files WHERE student_id = ?").bind(sid),
    c.env.DB.prepare("DELETE FROM students WHERE id = ?").bind(sid),
  ]);
  // R2 前缀异步清理（attachments + resumes + revisions）
  c.executionCtx.waitUntil(
    (async () => {
      for (const prefix of [`students/${sid}/`, `resumes/${sid}/`, `revisions/${sid}/`]) {
        let cursor: string | undefined;
        do {
          const listed = await c.env.BUCKET.list({ prefix, cursor });
          if (listed.objects.length) {
            await c.env.BUCKET.delete(listed.objects.map((o) => o.key));
          }
          cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);
      }
    })().catch(() => {})
  );
  return ok(c, { deleted: true });
});

export default app;
