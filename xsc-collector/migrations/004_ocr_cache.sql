-- migration v4（2026-09-09）：获奖证书 OCR 缓存表（v1.4 自动识别）
-- 同一张证书（同 attachment_id）的 OCR 结果缓存 30 天，避免重复调用模型；
-- 字段含义见 architecture.md 13.5。
-- 执行：wrangler d1 execute xsc-collector --remote --file=./migrations/004_ocr_cache.sql

CREATE TABLE IF NOT EXISTS ocr_cache (
  attachment_id TEXT PRIMARY KEY,        -- 关联 attachments.id，删除附件时 CASCADE 清理
  student_id    TEXT NOT NULL,
  model         TEXT NOT NULL,           -- 模型标识: 'gemma-3-12b-it' | 'gpt-4o' | 'gemini-2.5-pro' | 'qwen-vl-max' ...
  provider      TEXT NOT NULL,           -- 提供方: 'workers_ai' | 'openai' | 'google' | 'qwen'
  fields_json   TEXT NOT NULL,           -- 13.3 字段映射表对应的 JSON（name/cup_short/cup_tier/subject/org/level/rank/date/description）
  matched_short TEXT,                    -- 命中的 city_config.cups[].short，未命中 NULL
  raw_text      TEXT NOT NULL DEFAULT '',-- 原始识别文本（兜底展示给家长）
  confidence    TEXT NOT NULL,           -- 'high'|'medium'|'low'，low 时前端字段标红
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,           -- 默认 +30 天；过期自动失效
  FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ocr_cache_student ON ocr_cache(student_id, expires_at);