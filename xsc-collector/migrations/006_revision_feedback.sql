-- migration v6（2026-09-11）：简历「退回修改」工作流
-- 工作人员在管理端对不满意的简历写入修改意见（必填）+ 上传佐证文件（可选），
-- 学生自动回到待导出队列；下次导出时 profile.json 携带 revision 字段，
-- AI 在原有简历基础上结合修改意见重新生成。
-- 执行：wrangler d1 execute xsc-collector --remote --file=./migrations/006_revision_feedback.sql

ALTER TABLE resumes ADD COLUMN revision_note TEXT;  -- 工作人员的修改意见（退回修改时必填）
ALTER TABLE resumes ADD COLUMN essay_text TEXT;     -- 该版简历使用的自荐信原文（AI 上传时回传，修订时作为底稿）

-- 修改意见佐证文件（图片/PDF，存 R2：revisions/{student_id}/{resume_id}/{id}-{原名}）
CREATE TABLE IF NOT EXISTS revision_files (
  id            TEXT PRIMARY KEY,        -- 'rf' + 6位随机
  resume_id     TEXT NOT NULL,
  student_id    TEXT NOT NULL,
  r2_key        TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  mime_type     TEXT NOT NULL DEFAULT 'application/octet-stream',
  size          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (resume_id) REFERENCES resumes(id),
  FOREIGN KEY (student_id) REFERENCES students(id)
);
CREATE INDEX IF NOT EXISTS idx_revision_files_resume ON revision_files(resume_id);
CREATE INDEX IF NOT EXISTS idx_revision_files_student ON revision_files(student_id);
