// 短 ID 生成（architecture.md 8.1）

const CHARS = "0123456789"; // 纯数字避免混淆

export function shortId(prefix: string, len: number): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return prefix + Array.from(buf, (b) => CHARS[b % 10]).join("");
}

/** 32 hex 随机 token（邀请链接） */
export function inviteToken(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 4 位随机（简历 R2 文件名后缀） */
export function rand4(): string {
  const buf = new Uint8Array(2);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 生成不冲突的 ID（D1 查重，最多重试 10 次） */
export async function uniqueId(
  db: D1Database,
  table: string,
  prefix: string,
  len: number
): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const id = shortId(prefix, len);
    const row = await db.prepare(`SELECT 1 AS x FROM ${table} WHERE id = ?`).bind(id).first();
    if (!row) return id;
  }
  throw new Error("ID 生成冲突次数过多");
}
