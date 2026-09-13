// 学生/附件/简历查询封装（architecture.md 1.4 版本机制、4.1 响应结构）
import type {
  AttachmentRow,
  BasicInfo,
  ContactRow,
  ResumeRow,
  SectionRow,
  StudentRow,
} from "../types";
import { getCityConfig, publicCityConfig } from "../lib/city-configs";
import { TEMPLATES } from "../lib/templates";

function parseJson<T>(s: string, fallback: T): T {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 材料写操作只更新 updated_at（v1.3）。
 * material_version 不再随写操作推进——只在家长点击「提交材料」时 +1（见 submit 路由）。
 * 内容与附件仍然实时落库，家长随时可以关掉页面再回来。
 */
export async function touchUpdatedAt(db: D1Database, studentId: string): Promise<void> {
  await db
    .prepare("UPDATE students SET updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), studentId)
    .run();
}

export async function listContacts(db: D1Database, sid: string): Promise<ContactRow[]> {
  const r = await db
    .prepare("SELECT * FROM contacts WHERE student_id = ? ORDER BY sort_order, rowid")
    .bind(sid)
    .all<ContactRow>();
  return r.results;
}

export async function listSections(db: D1Database, sid: string): Promise<SectionRow[]> {
  const r = await db
    .prepare("SELECT * FROM sections WHERE student_id = ? ORDER BY type, sort_order, rowid")
    .bind(sid)
    .all<SectionRow>();
  return r.results;
}

export async function listAttachments(db: D1Database, sid: string): Promise<AttachmentRow[]> {
  const r = await db
    .prepare("SELECT * FROM attachments WHERE student_id = ? ORDER BY sort_order, rowid")
    .bind(sid)
    .all<AttachmentRow>();
  return r.results;
}

export async function listResumes(db: D1Database, sid: string): Promise<ResumeRow[]> {
  const r = await db
    .prepare("SELECT * FROM resumes WHERE student_id = ? ORDER BY created_at DESC")
    .bind(sid)
    .all<ResumeRow>();
  return r.results;
}

/** 家长视角：仅审核通过的简历 */
export async function listApprovedResumes(db: D1Database, sid: string): Promise<ResumeRow[]> {
  const r = await db
    .prepare(
      "SELECT * FROM resumes WHERE student_id = ? AND review_status = 'approved' ORDER BY created_at DESC"
    )
    .bind(sid)
    .all<ResumeRow>();
  return r.results;
}

/** needs_regen 的对标版本：最新「已通过审核」PDF 的材料版本 */
export async function maxApprovedResumeVersion(db: D1Database, sid: string): Promise<number | null> {
  const row = await db
    .prepare(
      "SELECT MAX(material_version) AS mv FROM resumes WHERE student_id = ? AND review_status = 'approved'"
    )
    .bind(sid)
    .first<{ mv: number | null }>();
  return row?.mv ?? null;
}

/** needs_regen 派生态（不落库）：有 PDF 且材料版本已领先于最新 PDF 的材料版本 */
export function deriveNeedsRegen(student: StudentRow, maxMv: number | null): boolean {
  return maxMv !== null && student.material_version > maxMv;
}

/** 附件 id → url 视图（家长端用） */
function attachmentView(att: AttachmentRow) {
  return {
    id: att.id,
    url: `/api/me/attachments/${att.id}`,
    name: att.original_name,
    mime_type: att.mime_type,
    size: att.size,
  };
}

/**
 * GET /api/me 的完整响应数据（architecture.md 4.1 响应示例）。
 * urlPrefix：附件预览 URL 前缀，家长端 /api/me/attachments，管理端 /api/admin/attachments。
 * audience：parent 只见审核通过的简历；admin 见全部（含审核状态字段）。
 */
export async function buildMeResponse(
  db: D1Database,
  student: StudentRow,
  urlPrefix = "/api/me/attachments",
  audience: "parent" | "admin" = "parent"
) {
  const [contacts, sectionRows, attachments, resumes, maxMv] = await Promise.all([
    listContacts(db, student.id),
    listSections(db, student.id),
    listAttachments(db, student.id),
    audience === "admin" ? listResumes(db, student.id) : listApprovedResumes(db, student.id),
    maxApprovedResumeVersion(db, student.id),
  ]);

  // 管理端：退回修改的佐证文件，按 resume_id 分组（v6）
  const revisionFilesByResume = new Map<string, { id: string; name: string; size: number }[]>();
  if (audience === "admin") {
    const rf = await db
      .prepare(
        "SELECT id, resume_id, original_name, size FROM revision_files WHERE student_id = ? ORDER BY created_at ASC"
      )
      .bind(student.id)
      .all<{ id: string; resume_id: string; original_name: string; size: number }>();
    for (const f of rf.results) {
      const list = revisionFilesByResume.get(f.resume_id) || [];
      list.push({ id: f.id, name: f.original_name, size: f.size });
      revisionFilesByResume.set(f.resume_id, list);
    }
  }

  const attById = new Map(attachments.map((a) => [a.id, a]));
  const view = (att: AttachmentRow) => ({
    id: att.id,
    url: `${urlPrefix}/${att.id}`,
    name: att.original_name,
    mime_type: att.mime_type,
    size: att.size,
  });
  const mapIds = (ids: unknown) =>
    Array.isArray(ids)
      ? ids
          .map((id) => attById.get(String(id)))
          .filter((a): a is AttachmentRow => !!a)
          .map(view)
      : [];

  const basic = parseJson<BasicInfo>(student.basic, {});
  const photoAtt = basic.photo ? attById.get(basic.photo) : undefined;

  const sections: Record<string, unknown[]> = {
    grades: [],
    awards: [],
    talents: [],
    works: [],
    target_schools: [],
  };
  for (const row of sectionRows) {
    const content = parseJson<Record<string, unknown>>(row.content, {});
    if (Array.isArray(content.cert_images)) content.cert_images = mapIds(content.cert_images);
    if (Array.isArray(content.images)) content.images = mapIds(content.images);
    (sections[row.type] ||= []).push({ id: row.id, content });
  }

  // v1.4 fix: 自愈「孤儿附件」——历史上传的证书照片已在 attachments 表（item_id 指对了），
  // 但 sections.content.cert_images 数组里没引用（家长走 PDF 路径 / 点 OCR「取消/仅添加图片」/
  // OCR 报错都跳过写 cert_images），家长视角 9 宫格就显示空。
  // 这里把所有 awards/talents/works section 的 item_id 反向补齐，导出渲染就回到一致状态。
  // 写入是幂等的（去重 + 不变更不写），不引入额外迁移。
  const REF_FIELDS: Record<string, string> = {
    awards: "cert_images",
    talents: "cert_images",
    works: "images",
  };
  const healQueue: { sectionId: string; content: Record<string, unknown> }[] = [];
  for (const [type, field] of Object.entries(REF_FIELDS)) {
    for (const item of sections[type] as Array<{ id: string; content: Record<string, unknown> }>) {
      const arr = Array.isArray(item.content[field]) ? (item.content[field] as Array<{ id: string }>) : [];
      const have = new Set(arr.map((a) => a.id));
      const orphans = attachments.filter(
        (a) => a.section_type === type && a.item_id === item.id && !have.has(a.id)
      );
      if (orphans.length === 0) continue;
      const merged = arr.concat(orphans.map(view));
      item.content[field] = merged;
      // 落库时只保留 id 字符串数组
      healQueue.push({
        sectionId: item.id,
        content: { ...item.content, [field]: merged.map((a) => a.id) },
      });
    }
  }
  if (healQueue.length) {
    const now = new Date().toISOString();
    const stmts = healQueue.map((h) =>
      db
        .prepare("UPDATE sections SET content = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(h.content), now, h.sectionId)
    );
    try {
      await db.batch(stmts);
    } catch (e) {
      // 自愈失败不影响正常返回（家长当次仍能正确看到图片，下次 GET 还会重试）
      console.warn("[buildMeResponse] 自愈 orphan attachments 失败：", e);
    }
  }

  const latestCreated = resumes.length ? resumes[0].created_at : null;

  return {
    student: {
      id: student.id,
      name: student.name,
      city: student.city,
      city_config: publicCityConfig(getCityConfig(student.city)),
      status: student.status,
      material_version: student.material_version,
      needs_regen: deriveNeedsRegen(student, maxMv),
      submitted_at: student.submitted_at,
      // 有已保存但未提交的修改（家长改过材料但还没再点「提交材料」）
      unsubmitted_changes:
        !!student.submitted_at && student.updated_at > student.submitted_at,
      basic: {
        gender: basic.gender || "",
        birth_date: basic.birth_date || "",
        primary_school: basic.primary_school || "",
        hukou_district: basic.hukou_district || "",
        photo: photoAtt ? view(photoAtt) : null,
      },
      essay_material: parseJson(student.essay_material, {}),
      family_note: student.family_note,
      template_id: student.template_id,
    },
    contacts: contacts.map((c) => ({
      id: c.id,
      relation: c.relation,
      name: c.name,
      work_unit: c.work_unit,
      title: c.title,
      phone: c.phone,
    })),
    sections,
    resumes: resumes.map((r) => ({
      id: r.id,
      material_version: r.material_version,
      file_name: r.file_name,
      note: r.note,
      created_at: r.created_at,
      is_latest: r.created_at === latestCreated,
      ...(audience === "admin"
        ? {
            review_status: r.review_status,
            reviewed_at: r.reviewed_at,
            revision_note: r.revision_note || null,
            revision_files: revisionFilesByResume.get(r.id) || [],
          }
        : {}),
    })),
    templates: TEMPLATES,
  };
}

/**
 * 组装导出用 profile.json（architecture.md 第 5 章契约）。
 * attachmentPath: (att) => zip 内相对路径，如 attachments/a0001.jpg
 * usedIds: 传入时回填 profile 实际引用的附件 id（导出方据此跳过孤儿附件）
 */
export async function buildProfile(
  db: D1Database,
  student: StudentRow,
  meta: { batch_no: string; exported_at: string },
  attachmentPath: (att: AttachmentRow) => string,
  usedIds?: Set<string>
) {
  const [contacts, sectionRows, attachments] = await Promise.all([
    listContacts(db, student.id),
    listSections(db, student.id),
    listAttachments(db, student.id),
  ]);
  const cfg = getCityConfig(student.city);
  const attById = new Map(attachments.map((a) => [a.id, a]));
  const mapPaths = (ids: unknown): string[] =>
    Array.isArray(ids)
      ? ids
          .map((id) => attById.get(String(id)))
          .filter((a): a is AttachmentRow => !!a)
          .map((a) => {
            usedIds?.add(a.id);
            return attachmentPath(a);
          })
      : [];

  const basic = parseJson<BasicInfo>(student.basic, {});
  const photoAtt = basic.photo ? attById.get(basic.photo) : undefined;
  if (photoAtt) usedIds?.add(photoAtt.id);

  const grades: Record<string, unknown>[] = [];
  const awards: Record<string, unknown>[] = [];
  const talents: Record<string, unknown>[] = [];
  const works: Record<string, unknown>[] = [];
  const targetSchools: Record<string, unknown>[] = [];

  for (const row of sectionRows) {
    const content = parseJson<Record<string, unknown>>(row.content, {});
    switch (row.type) {
      case "grades":
        grades.push({
          ...content,
          is_core: cfg.core_semesters.includes(String(content.semester || "")),
        });
        break;
      case "awards":
        awards.push({ ...content, cert_images: mapPaths(content.cert_images) });
        break;
      case "talents":
        talents.push({ ...content, cert_images: mapPaths(content.cert_images) });
        break;
      case "works":
        works.push({ ...content, images: mapPaths(content.images) });
        break;
      case "target_schools":
        targetSchools.push(content);
        break;
    }
  }

  return {
    student_id: student.id,
    name: student.name,
    city: {
      code: cfg.code,
      name: cfg.name,
      schooling: cfg.schooling,
      core_semesters: cfg.core_semesters,
      essay_tips: cfg.essay_tips,
    },
    basic: {
      gender: basic.gender || "",
      birth_date: basic.birth_date || "",
      primary_school: basic.primary_school || "",
      hukou_district: basic.hukou_district || "",
      photo: photoAtt ? attachmentPath(photoAtt) : null,
    },
    contacts: contacts.map((c) => ({
      relation: c.relation,
      name: c.name,
      work_unit: c.work_unit,
      title: c.title,
      phone: c.phone,
    })),
    grades,
    awards,
    talents,
    works,
    target_schools: targetSchools,
    essay_material: parseJson(student.essay_material, {}),
    family_note: student.family_note,
    meta: {
      batch_no: meta.batch_no,
      material_version: student.material_version,
      exported_at: meta.exported_at,
      template_id: student.template_id,
    },
  };
}

/** 待导出学生查询（architecture.md 1.4 派生规则） */
export async function listPendingExport(db: D1Database, limit = 50): Promise<StudentRow[]> {
  const r = await db
    .prepare(
      `SELECT * FROM students
       WHERE status = 'submitted'
         AND (exported_version IS NULL OR exported_version < material_version)
       ORDER BY updated_at ASC
       LIMIT ?`
    )
    .bind(limit)
    .all<StudentRow>();
  return r.results;
}
