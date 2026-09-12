-- schema.sql（D1 migration v1+004）— 与 architecture.md 3.1 节一致；v1.4 加 ocr_cache
-- 新部署：直接执行本文件即可（004 内容已合入）
-- 已部署：单独执行 migrations/004_ocr_cache.sql

CREATE TABLE IF NOT EXISTS students (
  id                TEXT PRIMARY KEY,        -- 'S' + 6位随机，如 S0007（服务端生成，保证 ASCII）
  name              TEXT NOT NULL DEFAULT '',
  city              TEXT NOT NULL DEFAULT 'guangzhou',
                    -- 城市代码: guangzhou|beijing|shanghai|shenzhen（CITY_CONFIGS 的 key，创建后不可改）
  invite_token      TEXT NOT NULL UNIQUE,    -- 32 hex 随机，家长链接用
  status            TEXT NOT NULL DEFAULT 'collecting',
                    -- collecting | submitted | exported | ready
  material_version  INTEGER NOT NULL DEFAULT 1,
  exported_version  INTEGER,                 -- 最后导出时的材料版本
  template_id       TEXT NOT NULL DEFAULT 'classic-blue',
  basic             TEXT NOT NULL DEFAULT '{}',   -- JSON：基本信息（见 3.2）
  essay_material    TEXT NOT NULL DEFAULT '{}',   -- JSON：自荐信素材
  family_note       TEXT NOT NULL DEFAULT '',     -- 家长寄语原文
  submitted_at      TEXT,                         -- v1.3: 最近一次点击「提交材料」的时间（派生未提交修改用）
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id          TEXT PRIMARY KEY,              -- 'c' + 6位随机
  student_id  TEXT NOT NULL,
  relation    TEXT NOT NULL,                 -- 父亲|母亲|其他
  name        TEXT NOT NULL DEFAULT '',
  work_unit   TEXT NOT NULL DEFAULT '',      -- 工作单位
  title       TEXT NOT NULL DEFAULT '',      -- 职务
  phone       TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (student_id) REFERENCES students(id)
);
CREATE INDEX IF NOT EXISTS idx_contacts_student ON contacts(student_id);

-- 统一的「多条目板块」表：获奖/成绩/特长/作品/目标学校
-- content 的 JSON 结构由 section_type 决定（见 3.2）
CREATE TABLE IF NOT EXISTS sections (
  id           TEXT PRIMARY KEY,             -- 's'+'5位随机'
  student_id   TEXT NOT NULL,
  type         TEXT NOT NULL,                -- grades|awards|talents|works|target_schools
  content      TEXT NOT NULL DEFAULT '{}',   -- JSON
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(id)
);
CREATE INDEX IF NOT EXISTS idx_sections_student ON sections(student_id, type);

CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,            -- 'a' + 5位随机，如 a0034（同时是 zip 内文件名主体）
  student_id    TEXT NOT NULL,
  section_type  TEXT NOT NULL,                -- basic|grades|awards|talents|works|target_schools|general
  item_id       TEXT,                         -- 关联 sections.id 或 contacts.id，basic 头像为 NULL
  r2_key        TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(id)
);
CREATE INDEX IF NOT EXISTS idx_attachments_student ON attachments(student_id, section_type);

CREATE TABLE IF NOT EXISTS resumes (
  id                TEXT PRIMARY KEY,        -- 'r' + 8位随机
  student_id        TEXT NOT NULL,
  material_version  INTEGER NOT NULL,        -- 生成时基于的材料版本
  batch_no          TEXT,                    -- 来源导出批次
  r2_key            TEXT NOT NULL,
  file_name         TEXT NOT NULL,           -- 如 张小明-小升初简历-v4.pdf
  file_size         INTEGER NOT NULL DEFAULT 0,
  note              TEXT NOT NULL DEFAULT '',-- AI 上传时的备注（如"材料版本落后"说明）
  review_status     TEXT NOT NULL DEFAULT 'pending',  -- pending|approved|rejected（v2 人工审核）
  reviewed_at       TEXT,                             -- 审核时间
  revision_note     TEXT,                             -- v6: 工作人员「退回修改」的修改意见
  essay_text        TEXT,                             -- v6: 该版简历使用的自荐信原文（AI 上传时回传）
  created_at        TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(id)
);
CREATE INDEX IF NOT EXISTS idx_resumes_student ON resumes(student_id, created_at);

-- v6: 退回修改的佐证文件（migration 006）
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

CREATE TABLE IF NOT EXISTS export_batches (
  batch_no       TEXT PRIMARY KEY,           -- B20260906-001
  student_count  INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS export_items (
  batch_no          TEXT NOT NULL,
  student_id        TEXT NOT NULL,
  material_version  INTEGER NOT NULL,        -- 导出时的材料版本快照
  PRIMARY KEY (batch_no, student_id)
);

-- v1.4: 获奖证书 OCR 缓存（migration 004）
CREATE TABLE IF NOT EXISTS ocr_cache (
  attachment_id TEXT PRIMARY KEY,        -- 关联 attachments.id，删除附件时 CASCADE 清理
  student_id    TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'award',  -- 'award'|'talent'|'work'（v1.5, migration 005）
  model         TEXT NOT NULL,
  provider      TEXT NOT NULL,
  fields_json   TEXT NOT NULL,
  matched_short TEXT,
  raw_text      TEXT NOT NULL DEFAULT '',
  confidence    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ocr_cache_student ON ocr_cache(student_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_ocr_cache_kind ON ocr_cache(attachment_id, kind);
