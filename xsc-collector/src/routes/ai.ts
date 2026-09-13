// AI 端 API（/api/ai/*，X-API-Key 头）— architecture.md 4.3，Skill 调用的核心接口
import { Hono } from "hono";
import type { Env, StudentRow } from "../types";
import { aiAuth } from "../lib/auth";
import { buildProfile, listPendingExport } from "../db/queries";
import { buildZipStream, profileJsonBytes, zipAttachmentPath, type ExportFile } from "../lib/zip";
import { rand4, uniqueId } from "../lib/ids";
import { MAX_RESUME_SIZE } from "../lib/validate";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", aiAuth);

const ok = (c: any, data: unknown) => c.json({ ok: true, data });
const fail = (c: any, status: number, code: string, message: string) =>
  c.json({ ok: false, error: { code, message } }, status);

const EXPORT_LIMIT = 50; // Workers 内存 128MB，单次导出建议 ≤ 50 名学生

interface RevisionFileRow {
  id: string;
  r2_key: string;
  original_name: string;
  mime_type: string;
}

const safeFileName = (name: string) => name.replace(/[\\/:*?"<>|]/g, "_").slice(-60);
const relRevisionPath = (f: { id: string; original_name: string }) =>
  `revision/${f.id}-${safeFileName(f.original_name)}`;

/** 批次号：B{YYYYMMDD}-{当日序号}（按北京时间日期） */
async function nextBatchNo(db: D1Database, now: Date): Promise<string> {
  const bjDate = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `B${bjDate}-`;
  const cnt = await db
    .prepare("SELECT COUNT(*) AS n FROM export_batches WHERE batch_no LIKE ?")
    .bind(`${prefix}%`)
    .first<{ n: number }>();
  return `${prefix}${String((cnt?.n ?? 0) + 1).padStart(3, "0")}`;
}

/** 退回修改上下文（v6）：该学生最新一条带修改意见的驳回简历 + 佐证文件清单 */
async function loadRevisionContext(db: D1Database, studentId: string) {
  const rejected = await db
    .prepare(
      "SELECT id, revision_note, essay_text FROM resumes WHERE student_id = ? AND revision_note IS NOT NULL AND revision_note != '' ORDER BY created_at DESC LIMIT 1"
    )
    .bind(studentId)
    .first<{ id: string; revision_note: string; essay_text: string | null }>();
  if (!rejected) return null;
  const rfiles = await db
    .prepare(
      "SELECT id, r2_key, original_name, mime_type FROM revision_files WHERE resume_id = ? ORDER BY created_at ASC"
    )
    .bind(rejected.id)
    .all<RevisionFileRow>();
  return {
    note: rejected.revision_note,
    previous_essay: rejected.essay_text || "",
    files: rfiles.results,
  };
}

// GET /api/ai/pending — 探测用：待导出学生数量与列表摘要
app.get("/pending", async (c) => {
  const students = await listPendingExport(c.env.DB, EXPORT_LIMIT);
  return ok(c, {
    count: students.length,
    students: students.map((s) => ({
      id: s.id,
      name: s.name,
      material_version: s.material_version,
    })),
  });
});

// POST /api/ai/export/begin — 按学生拉取模式（v1.10）：开启批次
// 快照待导出学生进 export_items，但不推进 exported_version（等客户端逐学生 ack）。
// 客户端随后 GET profile + 逐个下载附件，全部成功后 POST /export/:id/ack。
app.post("/export/begin", async (c) => {
  const students = await listPendingExport(c.env.DB, EXPORT_LIMIT);
  if (students.length === 0) return new Response(null, { status: 204 });

  const now = new Date();
  const exportedAt = now.toISOString();
  const batchNo = await nextBatchNo(c.env.DB, now);

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      "INSERT INTO export_batches (batch_no, student_count, created_at) VALUES (?,?,?)"
    ).bind(batchNo, students.length, exportedAt),
  ];
  for (const s of students) {
    stmts.push(
      c.env.DB.prepare(
        "INSERT INTO export_items (batch_no, student_id, material_version) VALUES (?,?,?)"
      ).bind(batchNo, s.id, s.material_version)
    );
  }
  await c.env.DB.batch(stmts);

  return ok(c, {
    batch_no: batchNo,
    exported_at: exportedAt,
    students: students.map((s) => ({
      id: s.id,
      name: s.name,
      material_version: s.material_version,
    })),
  });
});

// GET /api/ai/students/:id/profile — 单学生 profile.json（KB 级，无内存放大）
// query: batch_no / exported_at（begin 返回值，缺省为 manual/now）
// 响应 data.attachments：profile 实际引用的附件清单（id + 相对路径），客户端按 id 逐个下载
app.get("/students/:id/profile", async (c) => {
  const student = await c.env.DB.prepare("SELECT * FROM students WHERE id = ?")
    .bind(c.req.param("id"))
    .first<StudentRow>();
  if (!student) return fail(c, 404, "NOT_FOUND", "学生不存在");

  const batchNo = c.req.query("batch_no") || "manual";
  const exportedAt = c.req.query("exported_at") || new Date().toISOString();
  const usedIds = new Set<string>();
  const profile = (await buildProfile(
    c.env.DB,
    student,
    { batch_no: batchNo, exported_at: exportedAt },
    zipAttachmentPath,
    usedIds
  )) as Record<string, unknown>;

  const rev = await loadRevisionContext(c.env.DB, student.id);
  if (rev) {
    profile.revision = {
      note: rev.note,
      previous_essay: rev.previous_essay,
      files: rev.files.map((f) => ({
        id: f.id,
        path: relRevisionPath(f),
        name: f.original_name,
        mime_type: f.mime_type,
      })),
    };
  }

  const atts = await c.env.DB.prepare(
    "SELECT id, mime_type, original_name, size FROM attachments WHERE student_id = ?"
  )
    .bind(student.id)
    .all<{ id: string; mime_type: string; original_name: string; size: number }>();
  const referenced = atts.results
    .filter((a) => usedIds.has(a.id))
    .map((a) => ({
      id: a.id,
      path: zipAttachmentPath(a as any),
      mime_type: a.mime_type,
      size: a.size,
    }));

  return ok(c, { ...profile, attachments: referenced });
});

// GET /api/ai/attachments/:id — 单张附件，R2 流式转发（零内存放大、可断点续传）
app.get("/attachments/:id", async (c) => {
  const att = await c.env.DB.prepare(
    "SELECT id, r2_key, mime_type, original_name FROM attachments WHERE id = ?"
  )
    .bind(c.req.param("id"))
    .first<{ id: string; r2_key: string; mime_type: string; original_name: string }>();
  if (!att) return fail(c, 404, "NOT_FOUND", "附件不存在");
  const obj = await c.env.BUCKET.get(att.r2_key);
  if (!obj) return fail(c, 404, "NOT_FOUND", "附件文件已丢失");

  return new Response(obj.body, {
    headers: {
      "Content-Type": att.mime_type || obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Length": String(obj.size),
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(att.original_name)}`,
    },
  });
});

// GET /api/ai/revision-files/:id — 退回修改佐证文件，R2 流式转发
app.get("/revision-files/:id", async (c) => {
  const rf = await c.env.DB.prepare(
    "SELECT id, r2_key, mime_type, original_name FROM revision_files WHERE id = ?"
  )
    .bind(c.req.param("id"))
    .first<{ id: string; r2_key: string; mime_type: string; original_name: string }>();
  if (!rf) return fail(c, 404, "NOT_FOUND", "佐证文件不存在");
  const obj = await c.env.BUCKET.get(rf.r2_key);
  if (!obj) return fail(c, 404, "NOT_FOUND", "佐证文件已丢失");

  return new Response(obj.body, {
    headers: {
      "Content-Type": rf.mime_type || obj.httpMetadata?.contentType || "application/octet-stream",
      "Content-Length": String(obj.size),
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(rf.original_name)}`,
    },
  });
});

// POST /api/ai/export/:id/ack — 客户端确认该学生材料已下载完成，推进 exported_version
// body: { batch_no }。仅当材料版本仍等于批次快照时推进（期间家长又改了材料则跳过，下批重新导出）
app.post("/export/:id/ack", async (c) => {
  const studentId = c.req.param("id");
  const body = (await c.req.json<{ batch_no?: string }>().catch(() => ({}))) as {
    batch_no?: string;
  };
  const batchNo = String(body.batch_no || "");
  if (!batchNo) return fail(c, 400, "VALIDATION", "缺少 batch_no");

  const item = await c.env.DB.prepare(
    "SELECT material_version FROM export_items WHERE batch_no = ? AND student_id = ?"
  )
    .bind(batchNo, studentId)
    .first<{ material_version: number }>();
  if (!item) return fail(c, 404, "NOT_FOUND", `批次 ${batchNo} 中不存在学生 ${studentId}`);

  const now = new Date().toISOString();
  const res = await c.env.DB.prepare(
    "UPDATE students SET exported_version = ?, status = 'exported', updated_at = ? WHERE id = ? AND material_version = ?"
  )
    .bind(item.material_version, now, studentId, item.material_version)
    .run();

  return ok(c, {
    student_id: studentId,
    exported_version: item.material_version,
    stale: !res.meta.changes, // true = 材料在导出期间被家长更新，本批次作废、下批重出
  });
});

// GET /api/ai/export — 一次性 zip 导出（整批打包，记录批次并直接推进 exported_version）
// v1.10 起 Skill 默认走 begin/profile/attachments/ack 按学生拉取；本接口保留为整批兜底。
app.get("/export", async (c) => {
  const students = await listPendingExport(c.env.DB, EXPORT_LIMIT);
  if (students.length === 0) return new Response(null, { status: 204 });

  const now = new Date();
  const exportedAt = now.toISOString();
  const batchNo = await nextBatchNo(c.env.DB, now);

  // 组装 zip：{student_id}/profile.json + {student_id}/attachments/{attachment_id}.{ext}
  const files: ExportFile[] = [];
  for (const student of students) {
    const usedIds = new Set<string>();
    const profile = (await buildProfile(
      c.env.DB,
      student,
      { batch_no: batchNo, exported_at: exportedAt },
      zipAttachmentPath,
      usedIds
    )) as Record<string, unknown>;

    // 退回修改上下文（v6）：修改意见、上一版自荐信、佐证文件一并打包
    const rev = await loadRevisionContext(c.env.DB, student.id);
    if (rev) {
      const revFiles: { id: string; path: string; name: string; mime_type: string }[] = [];
      for (const rf of rev.files) {
        const obj = await c.env.BUCKET.get(rf.r2_key);
        if (!obj) continue;
        const rel = relRevisionPath(rf);
        files.push({ path: `${student.id}/${rel}`, data: new Uint8Array(await obj.arrayBuffer()) });
        revFiles.push({ id: rf.id, path: rel, name: rf.original_name, mime_type: rf.mime_type });
      }
      profile.revision = {
        note: rev.note,
        previous_essay: rev.previous_essay,
        files: revFiles,
      };
    }

    files.push({ path: `${student.id}/profile.json`, data: profileJsonBytes(profile) });

    const atts = await c.env.DB.prepare(
      "SELECT id, r2_key, mime_type, original_name FROM attachments WHERE student_id = ?"
    )
      .bind(student.id)
      .all<{ id: string; r2_key: string; mime_type: string; original_name: string }>();
    for (const att of atts.results) {
      if (!usedIds.has(att.id)) continue; // 只打包被 profile 引用的附件（孤儿附件是 1102 内存超限主因）
      const obj = await c.env.BUCKET.get(att.r2_key);
      if (!obj) continue; // R2 对象缺失时跳过，不阻断整个批次
      files.push({
        path: `${student.id}/${zipAttachmentPath(att as any)}`,
        data: new Uint8Array(await obj.arrayBuffer()),
      });
    }
  }

  // 事务：批次记录 + export_items + exported_version / status 更新（architecture.md 8.5）
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      "INSERT INTO export_batches (batch_no, student_count, created_at) VALUES (?,?,?)"
    ).bind(batchNo, students.length, exportedAt),
  ];
  for (const s of students) {
    stmts.push(
      c.env.DB.prepare(
        "INSERT INTO export_items (batch_no, student_id, material_version) VALUES (?,?,?)"
      ).bind(batchNo, s.id, s.material_version)
    );
    stmts.push(
      c.env.DB.prepare(
        "UPDATE students SET exported_version = material_version, status = 'exported', updated_at = ? WHERE id = ?"
      ).bind(exportedAt, s.id)
    );
  }
  await c.env.DB.batch(stmts);

  // 流式 zip：不生成整份输出缓冲，避免 Workers 128MB 内存上限（error 1102）
  return new Response(buildZipStream(files) as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "X-Batch-No": batchNo,
      "Content-Disposition": `attachment; filename="${batchNo}.zip"`,
    },
  });
});

// POST /api/ai/resumes — 上传生成好的 PDF（multipart）
app.post("/resumes", async (c) => {
  const body = await c.req.parseBody();
  const studentId = String(body.student_id || "");
  const batchNo = String(body.batch_no || "");
  const note = String(body.note || "");
  const essay = String(body.essay || "").slice(0, 8000); // 自荐信原文（修订底稿用，v6）
  const file = body.file;

  if (!studentId) return fail(c, 400, "VALIDATION", "缺少 student_id");
  if (!batchNo) return fail(c, 400, "VALIDATION", "缺少 batch_no");
  if (!(file instanceof File)) return fail(c, 400, "VALIDATION", "缺少 file 字段");
  if (file.type !== "application/pdf") {
    return fail(c, 415, "UNSUPPORTED_MEDIA_TYPE", "文件必须是 PDF");
  }
  if (file.size > MAX_RESUME_SIZE) {
    return fail(c, 413, "PAYLOAD_TOO_LARGE", "PDF 超过 30MB 限制");
  }

  const student = await c.env.DB.prepare("SELECT * FROM students WHERE id = ?")
    .bind(studentId)
    .first<StudentRow>();
  if (!student) return fail(c, 404, "NOT_FOUND", `学生 ${studentId} 不存在`);

  // R2 写入：resumes/{student_id}/{yyyymmddhhmmss}-{rand4}.pdf
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const ts = bj.toISOString().slice(0, 19).replace(/[-:T]/g, "");
  const r2Key = `resumes/${studentId}/${ts}-${rand4()}.pdf`;
  await c.env.BUCKET.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType: "application/pdf" },
  });

  // 材料版本：优先 export_items 快照，查不到用学生当前版本
  const item = await c.env.DB.prepare(
    "SELECT material_version FROM export_items WHERE batch_no = ? AND student_id = ?"
  )
    .bind(batchNo, studentId)
    .first<{ material_version: number }>();
  const materialVersion = item?.material_version ?? student.material_version;

  // 版本落后检测：仍接受上传，写入备注（家长端会看到「材料已更新，待重新生成」）
  let finalNote = note;
  if (student.material_version > materialVersion) {
    finalNote = [note, "材料已更新，此版本基于旧材料生成"].filter(Boolean).join("；");
  }

  const resumeId = await uniqueId(c.env.DB, "resumes", "r", 8);
  const safeName = student.name.replace(/[\\/:*?"<>|]/g, "") || studentId;
  const fileName = `${safeName}-小升初简历-v${materialVersion}.pdf`;
  await c.env.DB.prepare(
    "INSERT INTO resumes (id, student_id, material_version, batch_no, r2_key, file_name, file_size, note, essay_text, review_status, created_at) VALUES (?,?,?,?,?,?,?,?,?, 'pending', ?)"
  )
    .bind(resumeId, studentId, materialVersion, batchNo, r2Key, fileName, file.size, finalNote, essay || null, now.toISOString())
    .run();

  // 上传后进入「待审核」（review）：管理端审核通过前家长不可见
  if (student.status === "exported") {
    await c.env.DB.prepare("UPDATE students SET status = 'review', updated_at = ? WHERE id = ?")
      .bind(now.toISOString(), studentId)
      .run();
  }

  // is_latest：该 PDF 是否为该学生最新一份
  const latest = await c.env.DB.prepare(
    "SELECT id FROM resumes WHERE student_id = ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(studentId)
    .first<{ id: string }>();

  return ok(c, {
    resume_id: resumeId,
    student_id: studentId,
    material_version: materialVersion,
    is_latest: latest?.id === resumeId,
  });
});

export default app;
