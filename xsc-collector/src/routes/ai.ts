// AI 端 API（/api/ai/*，X-API-Key 头）— architecture.md 4.3，Skill 调用的核心接口
import { Hono } from "hono";
import type { Env, StudentRow } from "../types";
import { aiAuth } from "../lib/auth";
import { buildProfile, listPendingExport } from "../db/queries";
import { buildZip, profileJsonBytes, zipAttachmentPath, type ExportFile } from "../lib/zip";
import { rand4, uniqueId } from "../lib/ids";
import { MAX_RESUME_SIZE } from "../lib/validate";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", aiAuth);

const ok = (c: any, data: unknown) => c.json({ ok: true, data });
const fail = (c: any, status: number, code: string, message: string) =>
  c.json({ ok: false, error: { code, message } }, status);

const EXPORT_LIMIT = 50; // Workers 内存 128MB，单次导出建议 ≤ 50 名学生

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

// GET /api/ai/export — 拉取所有待导出学生，打成 zip 返回并记录批次
app.get("/export", async (c) => {
  const students = await listPendingExport(c.env.DB, EXPORT_LIMIT);
  if (students.length === 0) return new Response(null, { status: 204 });

  const now = new Date();
  const exportedAt = now.toISOString();
  // 批次号：B{YYYYMMDD}-{当日序号}（按北京时间日期）
  const bjDate = new Date(now.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
  const prefix = `B${bjDate}-`;
  const cnt = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM export_batches WHERE batch_no LIKE ?"
  )
    .bind(`${prefix}%`)
    .first<{ n: number }>();
  const batchNo = `${prefix}${String((cnt?.n ?? 0) + 1).padStart(3, "0")}`;

  // 组装 zip：{student_id}/profile.json + {student_id}/attachments/{attachment_id}.{ext}
  const files: ExportFile[] = [];
  for (const student of students) {
    const profile = await buildProfile(
      c.env.DB,
      student,
      { batch_no: batchNo, exported_at: exportedAt },
      zipAttachmentPath
    ) as Record<string, unknown>;

    // 退回修改上下文（v6）：取该学生最新一条带修改意见的驳回简历，
    // 把修改意见、上一版自荐信、佐证文件一并交给 AI，在原有简历基础上修订
    const rejected = await c.env.DB.prepare(
      "SELECT id, revision_note, essay_text FROM resumes WHERE student_id = ? AND revision_note IS NOT NULL AND revision_note != '' ORDER BY created_at DESC LIMIT 1"
    )
      .bind(student.id)
      .first<{ id: string; revision_note: string; essay_text: string | null }>();
    if (rejected) {
      const rfiles = await c.env.DB.prepare(
        "SELECT id, r2_key, original_name, mime_type FROM revision_files WHERE resume_id = ? ORDER BY created_at ASC"
      )
        .bind(rejected.id)
        .all<{ id: string; r2_key: string; original_name: string; mime_type: string }>();
      const revFiles: { path: string; name: string; mime_type: string }[] = [];
      for (const rf of rfiles.results) {
        const obj = await c.env.BUCKET.get(rf.r2_key);
        if (!obj) continue;
        const zipPath = `${student.id}/revision/${rf.id}-${rf.original_name.replace(/[\\/:*?"<>|]/g, "_").slice(-60)}`;
        files.push({ path: zipPath, data: new Uint8Array(await obj.arrayBuffer()) });
        revFiles.push({ path: zipPath.replace(`${student.id}/`, ""), name: rf.original_name, mime_type: rf.mime_type });
      }
      profile.revision = {
        note: rejected.revision_note,
        previous_essay: rejected.essay_text || "",
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
      const obj = await c.env.BUCKET.get(att.r2_key);
      if (!obj) continue; // R2 对象缺失时跳过，不阻断整个批次
      files.push({
        path: `${student.id}/${zipAttachmentPath(att as any)}`,
        data: new Uint8Array(await obj.arrayBuffer()),
      });
    }
  }
  const zipped = buildZip(files);

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

  return new Response(zipped as unknown as BodyInit, {
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
