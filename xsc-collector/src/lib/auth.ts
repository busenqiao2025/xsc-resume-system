// 三种鉴权中间件（architecture.md 8.2）
import { createMiddleware } from "hono/factory";
import type { Env, StudentRow } from "../types";

function err(code: string, message: string) {
  return { ok: false, error: { code, message } };
}

/** 家长端：Bearer invite_token → 学生行注入 c.set("student")
 *  图片/PDF 预览走 <img>/<iframe> 无法带 Authorization 头，GET 请求允许 ?token= 兜底 */
export const parentAuth = createMiddleware<{ Bindings: Env; Variables: { student: StudentRow } }>(
  async (c, next) => {
    let token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token && c.req.method === "GET") token = c.req.query("token");
    const row = token
      ? await c.env.DB.prepare("SELECT * FROM students WHERE invite_token = ?")
          .bind(token)
          .first<StudentRow>()
      : null;
    if (!row) {
      return c.json(err("UNAUTHORIZED", "邀请链接无效或已重置，请联系老师获取新链接"), 401);
    }
    c.set("student", row);
    await next();
  }
);

/** 管理端：X-Admin-Key 头 */
export const adminAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (!c.env.ADMIN_KEY || c.req.header("X-Admin-Key") !== c.env.ADMIN_KEY) {
    return c.json(err("UNAUTHORIZED", "管理密钥无效"), 401);
  }
  await next();
});

/** AI 端：X-API-Key 头 */
export const aiAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  if (!c.env.AI_API_KEY || c.req.header("X-API-Key") !== c.env.AI_API_KEY) {
    return c.json(err("UNAUTHORIZED", "API Key 无效"), 401);
  }
  await next();
});
