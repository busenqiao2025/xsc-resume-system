// profile 契约的 TS 类型（architecture.md 3.2 / 第 5 章）

export type SectionType = "grades" | "awards" | "talents" | "works" | "target_schools";

export const SECTION_TYPES: SectionType[] = ["grades", "awards", "talents", "works", "target_schools"];

export type AttachmentSectionType = SectionType | "basic" | "general";

export interface BasicInfo {
  gender?: string;
  birth_date?: string;
  primary_school?: string;
  hukou_district?: string;
  photo?: string | null; // attachments.id
}

export interface EssayMaterial {
  personality?: string;
  study_habits?: string;
  interests?: string;
  highlights?: string;
}

export interface GradeContent {
  semester: string;
  chinese?: string;
  math?: string;
  english?: string;
  total?: string;
  level?: string;
  remark?: string;
}

export interface AwardContent {
  name: string;
  cup_short?: string;
  cup_tier?: string; // T1|T2|T3|T4，空 = 非竞赛荣誉
  subject?: string;
  org?: string;
  level?: string;
  rank?: string;
  date?: string;
  description?: string;
  cert_images?: string[]; // attachments.id 列表
}

export interface TalentContent {
  category?: string; // 科创|艺术|体育|学科|其他
  title: string;
  description?: string;
  years?: string;
  cert_images?: string[];
}

export interface WorkContent {
  title: string;
  description?: string;
  images?: string[];
  link?: string;
}

export interface TargetSchoolContent {
  name: string;
  reason?: string;
}

export interface StudentRow {
  id: string;
  name: string;
  city: string;
  invite_token: string;
  status: "collecting" | "submitted" | "exported" | "review" | "ready";
  material_version: number;
  exported_version: number | null;
  template_id: string;
  basic: string;
  essay_material: string;
  family_note: string;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContactRow {
  id: string;
  student_id: string;
  relation: string;
  name: string;
  work_unit: string;
  title: string;
  phone: string;
  sort_order: number;
}

export interface SectionRow {
  id: string;
  student_id: string;
  type: SectionType;
  content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface AttachmentRow {
  id: string;
  student_id: string;
  section_type: AttachmentSectionType;
  item_id: string | null;
  r2_key: string;
  original_name: string;
  mime_type: string;
  size: number;
  sort_order: number;
  created_at: string;
}

export interface ResumeRow {
  id: string;
  student_id: string;
  material_version: number;
  batch_no: string | null;
  r2_key: string;
  file_name: string;
  file_size: number;
  note: string;
  review_status: "pending" | "approved" | "rejected";
  reviewed_at: string | null;
  revision_note: string | null; // v6: 退回修改的修改意见
  essay_text: string | null;    // v6: 该版简历的自荐信原文
  created_at: string;
}

// v6: 退回修改佐证文件
export interface RevisionFileRow {
  id: string;
  resume_id: string;
  student_id: string;
  r2_key: string;
  original_name: string;
  mime_type: string;
  size: number;
  created_at: string;
}

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  AI: Ai;                                // v1.4: Workers AI（OCR 默认走这里）
  ADMIN_KEY: string;
  AI_API_KEY: string;
  // v1.4: 可选外部 OCR（任一缺失则降级走 Workers AI）
  EXTERNAL_OCR_PROVIDER?: string;        // 'openai' | 'google' | 'qwen'
  EXTERNAL_OCR_API_KEY?: string;
  EXTERNAL_OCR_MODEL?: string;
  // v1.4.2: 覆盖 Workers AI 视觉模型尝试顺序（逗号分隔完整 model id）
  OCR_MODEL_ORDER?: string;
  // v1.9: 覆盖文档文字抽取的 Workers AI 文本模型顺序（逗号分隔完整 model id）
  OCR_TEXT_MODEL_ORDER?: string;
}
