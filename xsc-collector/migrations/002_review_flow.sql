-- migration v2（2026-09-08）：人工审核流 + 模板家长自选
-- resumes 增加审核状态；学生状态机新增 review（待审核）
-- 执行：wrangler d1 execute xsc-collector --remote --file=./migrations/002_review_flow.sql

ALTER TABLE resumes ADD COLUMN review_status TEXT NOT NULL DEFAULT 'pending';  -- pending|approved|rejected
ALTER TABLE resumes ADD COLUMN reviewed_at TEXT;
