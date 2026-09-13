// fflate 打包导出（architecture.md 4.3 / 2.1 zip 编码决策）
// zip 内所有目录名与文件名一律 ASCII：目录 = student_id，附件 = attachment_id.ext
import { zipSync, strToU8, Zip, ZipPassThrough } from "fflate";
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

/**
 * 流式 zip：不生成整份输出缓冲，峰值内存 = 源数据 + 单文件 chunk，
 * 避免 zipSync 输出缓冲区把 Workers 128MB 内存顶穿（error 1102）。
 * JPEG/PNG/PDF 本身已压缩，用 ZipPassThrough 直接存储（等价 level 0，省 CPU）。
 * pull 驱动：每次只把一个文件的压缩块推入队列，背压由 ReadableStream 天然提供。
 */
export function buildZipStream(files: ExportFile[]): ReadableStream<Uint8Array> {
  let index = 0;
  let ended = false;
  const pending: Uint8Array[] = [];
  let zipError: unknown = null;
  const zip = new Zip((err, chunk) => {
    if (err) {
      zipError = err;
      return;
    }
    if (chunk) pending.push(chunk);
  });
  const flush = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    for (const c of pending) controller.enqueue(c);
    pending.length = 0;
  };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (zipError) return controller.error(zipError);
      try {
        if (index < files.length) {
          const f = files[index++];
          const entry = new ZipPassThrough(f.path);
          zip.add(entry);
          entry.push(f.data, true);
          flush(controller);
        } else {
          if (!ended) {
            zip.end();
            ended = true;
          }
          flush(controller);
          controller.close();
        }
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

export function profileJsonBytes(profile: unknown): Uint8Array {
  return strToU8(JSON.stringify(profile, null, 2));
}
