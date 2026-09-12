-- migration v5（2026-09-10）：OCR 缓存支持多业务类型（v1.5）
--
-- 背景：v1.4 的 ocr_cache 只服务「获奖证书 OCR」，主键 attachment_id 一对一。
-- v1.5 起同一套缓存表要承载三种识别结果，而三种结果的 JSON 结构完全不同：
--   kind='award'  → fields_json = {name,cup_short,cup_tier,subject,org,level,rank,date,description}
--   kind='talent' → fields_json = {category,title,description,years}
--   kind='work'   → fields_json = {title,description}
-- 不加区分的话，同一附件一旦被不同业务复用，读缓存会按错误结构解析。
--
-- 兼容性：存量行全部是获奖证书缓存，DEFAULT 'award' 正好覆盖，无需回填。
-- 主键保持 attachment_id 不变（SQLite 不支持 ALTER PRIMARY KEY）；
-- 读缓存时额外校验 kind，不匹配即视为未命中并重新识别。
--
-- 执行：wrangler d1 execute xsc-collector --remote --file=./migrations/005_ocr_cache_kind.sql

ALTER TABLE ocr_cache ADD COLUMN kind TEXT NOT NULL DEFAULT 'award';

-- 按 (attachment_id, kind) 加速「读指定类型的缓存」
CREATE INDEX IF NOT EXISTS idx_ocr_cache_kind ON ocr_cache(attachment_id, kind);
