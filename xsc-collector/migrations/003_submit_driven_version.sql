-- migration v3（2026-09-08）：版本机制改为「提交驱动」
-- 材料写操作不再 bump material_version，只在家长点击「提交材料」时推进；
-- 新增 students.submitted_at 用于派生「有未提交修改」。
-- 执行：wrangler d1 execute xsc-collector --remote --file=./migrations/003_submit_driven_version.sql

ALTER TABLE students ADD COLUMN submitted_at TEXT;
