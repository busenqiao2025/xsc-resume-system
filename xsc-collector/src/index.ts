// Hono 入口 + 静态资源服务（architecture.md 2.2）
import { Hono } from "hono";
import type { Env } from "./types";
import { CITY_CONFIGS, publicCityConfig } from "./lib/city-configs";
import { TEMPLATES } from "./lib/templates";
import parentApp from "./routes/parent";
import adminApp from "./routes/admin";
import aiApp from "./routes/ai";
import ocrApp from "./routes/ocr";            // v1.4: 获奖证书 OCR

const app = new Hono<{ Bindings: Env }>();

// 统一错误兜底
app.onError((err, c) => {
  console.error(err);
  return c.json(
    { ok: false, error: { code: "INTERNAL", message: "服务器内部错误" } },
    500
  );
});

// GET /api/cities — 城市配置全量（只读，无需鉴权，前端缓存）
app.get("/api/cities", (c) =>
  c.json({
    ok: true,
    data: Object.values(CITY_CONFIGS).map(publicCityConfig),
  })
);

// GET /api/templates — 简历模板目录（只读，无需鉴权）
app.get("/api/templates", (c) => c.json({ ok: true, data: TEMPLATES }));

// 三组 API
app.route("/api/me", parentApp);
app.route("/api/admin", adminApp);
app.route("/api/ai", aiApp);
app.route("/api/me/ocr", ocrApp);  // v1.4: OCR 挂载在 /api/me/ocr/*（嵌套在家长鉴权域下）

// ---------- 静态页面（web/dist 由 [assets] 托管，这里做 SPA 路径改写） ----------
function serveAsset(path: string) {
  return async (c: any) => {
    const url = new URL(c.req.url);
    url.pathname = path;
    return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  };
}

app.get("/", (c) => c.redirect("/admin"));
app.get("/s", (c) => c.redirect("/admin"));
app.get("/s/:token", serveAsset("/s/index.html"));
app.get("/admin", serveAsset("/admin/index.html"));
app.get("/admin/*", serveAsset("/admin/index.html"));

// 其余静态资源（css/js/图片等）交给 assets
app.get("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  if (res.status === 404) {
    return c.json({ ok: false, error: { code: "NOT_FOUND", message: "页面不存在" } }, 404);
  }
  return res;
});

export default app;
