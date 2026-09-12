# 小升初简历生成系统（材料收集 + AI 生成）

两个组件组成一套完整链路，本目录包含全部交付物：

```
xsc-resume-system/
├── architecture.md     # 交付物 1：材料收集系统的实现架构文档（照此开发）
├── sample-resume-guangzhou.pdf   # 样例：广州学生简历（六三学制，五下六上）
├── sample-resume-shanghai.pdf    # 样例：上海学生简历（五四学制，思维100/小托福）
└── skill/
    └── xiaoshengchu-resume-generator/   # 交付物 2：Trae Skill（下载→生成→上传全自动）
```

## 城市维度（v1.1）

小升初的成绩口径、竞赛体系、圈内黑话强依赖城市，上海更是五四学制（小学五年无六年级）。系统以「城市配置 CITY_CONFIGS」（architecture.md 3.3 节）承载全部城市差异：

- 老师创建学生时选城市（广州/北京/上海/深圳，创建后不可改），表单字典、成绩口径、导出内容全链路按城市渲染。
- 收集系统导出 profile.json 时按城市写入 `city` 对象（核心学期 + 写作要点）与每条成绩的 `is_core`，Skill 只消费结构化数据、不内置城市规则——新增城市零代码改动，改配置即可。
- 简历成品不出现任何黑话（杯碗/花衣花儿/业主等仅用于理解家长素材），奖项一律正式全称。

## 端到端流程

```
老师(管理端)创建学生 → 邀请链接发给家长
  → 家长手机/电脑填写材料、上传证书照片（自动保存，可随时更新）
  → 获奖板块：上传证书 → AI 自动 OCR 抽取字段 → 家长核对确认（v1.4）
  → 家长提交
  → 虚拟机 Trae 定时触发 Skill:
       download.py 拉取全部待生成学生（zip，按材料版本去重）
       → 逐学生：AI 写自荐信 → render.py 渲染单页连贯长卷 PDF
       → upload.py 回传 → 家长页面直接查看
  → 家长更新材料 → 材料版本+1 → 自动进入下一轮生成（版本化）
```

## 获奖证书 OCR 自动识别（v1.4）

家长填 9 个获奖字段太重，v1.4 加了 OCR：上传证书照片 → 后端抽字段 → 前端弹「识别草稿」弹窗 → 家长核对/修改 → 确认导入。

- **双轨**：默认 Workers AI（`@cf/google/gemma-3-12b-it`，零配置零密钥）；可选外部多模态 LLM（配 `EXTERNAL_OCR_PROVIDER` / `EXTERNAL_OCR_API_KEY` / `EXTERNAL_OCR_MODEL` 三个 secret，精度更高）
- **Prompt 注入城市 cups 字典**：识别「华杯」自动展开成「华罗庚金杯少年数学邀请赛」+ T1 + 数学
- **缓存**：`ocr_cache` 表缓存 30 天，同一张证书不重复调模型
- **家长体验**：单张「📷 自动识别」+ 板块级「✨ 一键识别全部」；低置信度字段标红；可「重新识别」「仅添加图片不导入」

详见 `architecture.md` 第 13 章（方案选型、数据契约、Prompt 模板、缓存策略、成本估算）。

**启用外部高精度 OCR（可选）**：

```bash
wrangler secret put EXTERNAL_OCR_PROVIDER   # openai | google | qwen
wrangler secret put EXTERNAL_OCR_API_KEY
wrangler secret put EXTERNAL_OCR_MODEL      # gpt-4o | gemini-2.5-pro | qwen-vl-max
```

## 快速开始

**第一步：部署收集系统**

按 `architecture.md` 第 9 章部署到 Cloudflare Workers（D1 建表、R2 建 bucket、两个 secret：ADMIN_KEY / AI_API_KEY）。

已部署环境需追加 v1.4 迁移（OCR 缓存表）：

```bash
cd xsc-collector
wrangler d1 execute xsc-collector --remote --file=./migrations/004_ocr_cache.sql
wrangler deploy      # [ai] binding 会自动生效；外部 OCR secret 见上文「可选」
```

**第二步：安装 Skill**

把 `skill/xiaoshengchu-resume-generator/` 复制到虚拟机 Trae 的 skills 目录，然后：

```bash
cd xiaoshengchu-resume-generator
cp config.example.json config.json   # 填 api_base 和 AI_API_KEY
pip install -r requirements.txt
playwright install chromium
# Linux 服务器还需中文字体: sudo apt-get install -y fonts-noto-cjk
```

**第三步：联调**

1. 管理端创建学生，自己用手机打开邀请链接，填一份测试材料并提交。
2. 虚拟机 Trae 里触发本 skill（说「生成小升初简历」），观察全流程。
3. 回到家长页面查看生成的 PDF。

## 两个组件的契约（联调必读）

- 收集系统 `GET /api/ai/export` 输出的 zip：`{student_id}/profile.json + {student_id}/attachments/{attachment_id}.{ext}`，文件名全 ASCII。
- `profile.json` 的字段结构见 architecture.md 第 5 章，是双方唯一需要共同维护的契约。
- Skill `POST /api/ai/resumes` 上传 PDF 时带 `student_id` 与 `batch_no`，服务端据此写入版本记录。

## 版本机制

家长每次改动材料，`material_version` +1，学生自动回到「待生成」队列；每份 PDF 记录其生成时基于的材料版本，家长端可查看全部历史版本并收到「材料已更新，待重新生成」提示。
