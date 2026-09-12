// 附件类型/大小校验（architecture.md 4.1 / 第 10 章）

export const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 单文件 10MB
export const MAX_RESUME_SIZE = 30 * 1024 * 1024; // PDF 30MB

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

/** 由 mime 推导扩展名（zip 内文件名与 R2 key 用，保证 ASCII 安全） */
export function extOf(mime: string, originalName = ""): string {
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(originalName);
  return m ? m[1].toLowerCase() : "bin";
}

export function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}
