// fflate 打包导出（architecture.md 4.3 / 2.1 zip 编码决策）
// zip 内所有目录名与文件名一律 ASCII：目录 = student_id，附件 = attachment_id.ext
import { zipSync, strToU8 } from "fflate";
import type { AttachmentRow, StudentRow } from "../types";
import { extOf } from "./validate";

export interface ExportFile {
  path: string;
  data: Uint8Array;
}

/** zip 内附件相对路径：attachments/{attachment_id}.{ext} */
export function zipAttachmentPath(att: AttachmentRow): string {
  return `attachments/${att.id}.${extOf(att.mime_type, att.original_name)}`;
}

export function buildZip(files: ExportFile[]): Uint8Array {
  const record: Record<string, Uint8Array> = {};
  for (const f of files) record[f.path] = f.data;
  // 附件多时用 level: 1 换速度（Workers 内存 128MB）
  return zipSync(record, { level: 1 });
}

export function profileJsonBytes(profile: unknown): Uint8Array {
  return strToU8(JSON.stringify(profile, null, 2));
}
