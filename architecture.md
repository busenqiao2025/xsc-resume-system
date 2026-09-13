# 小升初简历材料收集系统 — 实现架构文档

> 版本：v1.6（2026-09-11，新增「退回修改」工作流：修改意见 + 佐证文件 + 自荐信底稿回传）
> 定位：面向家长的简历材料收集页面 + 供 AI Skill 调用的导出/回传接口
> 部署形态：Cloudflare Workers（Hono）+ D1 + R2 + Workers AI
> 前提：这不是求职简历系统。内容结构围绕小升初设计——基本信息、家庭成员、核心学期学业成绩、获奖（含竞赛/杯碗）、兴趣特长、成长作品、自荐信素材、目标学校。
> **城市维度（v1.1 核心变化）**：小升初的「成绩口径、竞赛体系、圈内黑话」强依赖城市，甚至学制都不同（上海五四学制，小学五年）。系统以「城市配置 CITY_CONFIGS」承载全部城市差异，学生创建时绑定城市，表单/字典/导出全链路按城市渲染；广州为首发完整配置，北京/上海为初版，深圳复用广州模板待运营校准。**城市差异只存在于配置层，数据表结构、API 形状、版本机制、生成流程完全城市无关。**

---

## 1. 系统概述

### 1.1 业务模式

机构（老师）创建学生记录并生成专属邀请链接发给家长；家长在手机或电脑上打开链接填写材料、上传证书照片、**自选简历模板（v1.2）**；AI Skill 定期通过导出接口拉取「新材料」，在虚拟机中生成连贯单页 PDF 简历，再通过回传接口推送回系统；**老师人工审核通过后（v1.2），家长才能在页面上看到简历 PDF**，审核不通过可驳回，学生自动回到待生成队列。

**v1.2 两个变化：**
- **人工审核闸门**：AI 回传的 PDF 默认 `review_status='pending'`，家长端不可见；管理端「通过」后才对家长开放，「驳回」则学生自动重进导出队列（`exported_version` 置空）。
- **模板家长自选**：`students.template_id` 仍由管理端创建时给默认值，但家长可在收集页查看模板预览（缩略图 + 示例 PDF）并自行更换；更换视为材料写操作（版本 +1），简历按新模板重新生成。

**四个角色：**

| 角色 | 访问方式 | 鉴权 |
|------|---------|------|
| 家长 | 邀请链接 `/s/:token` | invite_token（URL 携带） |
| 老师/管理员 | `/admin` | ADMIN_KEY（环境变量） |
| AI Skill（虚拟机 Trae） | 服务端 API 调用 | AI_API_KEY（环境变量） |
| 简历阅读 | 家长页面内嵌 | 同家长 |

### 1.2 端到端链路

```
老师创建学生 → 发链接 → 家长填写/上传/选模板(自动保存) → 家长提交
     ↓
AI Skill: POST /api/ai/export/begin → GET profile/attachments 按学生拉取（v1.10 起，替代整批 zip）
     ↓
AI Skill: 逐学生生成连贯单页 PDF
     ↓
AI Skill: POST /api/ai/resumes (上传 PDF 回传 → review_status=pending，家长不可见)
     ↓
老师管理端审核：通过 → 家长页面可见；驳回 → 学生回到待导出队列
     ↓
家长页面查看 PDF (可多版本) → 家长更新材料 → material_version+1 → 回到待导出 → 循环
```

### 1.3 状态机

学生简历状态（`students.status`）：

```
collecting ──提交──> submitted ──导出──> exported ──PDF回传──> review ──审核通过──> ready
    ^                   ^                                    |  （待审核，家长不可见）
    |                   └────────── 家长更新材料 ────────────┘        |
    |                                                  审核驳回 <──────┘
    |                                                   （exported_version 置空，重进队列）
 (删除重建)
                                          needs_regen（派生态，仅展示用）：
                                          material_version > 最新「已通过审核」PDF的材料版本
```

| 状态 | 含义 | 页面展示 |
|------|------|---------|
| collecting | 家长填写中（未提交） | 灰色「填写中」 |
| submitted | 已提交，待 AI 拉取 | 蓝色「待生成」 |
| exported | 材料已导出，AI 生成中 | 橙色「生成中」 |
| review | PDF 已回传，待老师审核 | 家长端仍显示「生成中」；管理端紫色「待审核」 |
| ready | 有已通过审核的 PDF | 绿色「已生成」 |
| needs_regen* | 材料已更新，待重新生成 | 红色「材料已更新，待重新生成」 |

*needs_regen 不落库，展示时由 `material_version > (SELECT MAX(material_version) FROM resumes WHERE student_id=... AND review_status='approved')` 派生——对标的是家长实际能看到的那份 PDF。

简历审核状态（`resumes.review_status`）：`pending`（默认，家长不可见）→ `approved`（家长可见）/ `rejected`（驳回，学生重进队列）。

### 1.4 版本机制（核心，v1.3 改为提交驱动）

**设计语义：所有填写内容与附件实时自动保存（与版本无关）；`material_version` 只在家长点击「提交材料」时推进**——版本号 = 家长确认「按此内容生成简历」的快照序号，而不是编辑次数。

- `students.material_version`：材料版本号。创建时 = 1；**仅在 POST /api/me/submit 时按规则 +1**：
  - 当前版本已被「消费」（`exported_version >= material_version` 或已存在 resumes 记录）**且**自上次提交后有新修改（`updated_at > submitted_at`）时才 +1；
  - 首次提交保持 v1；无新修改的重复点击不 bump。
- `students.submitted_at`（v1.3 新增）：最近一次提交时间。派生 `unsubmitted_changes = updated_at > submitted_at`——家长改了材料但还没再点提交（内容已自动保存），用于页面黄条提醒与管理端标记。
- `students.exported_version`：最后一次被导出时的材料版本。导出时写入。
- `resumes.material_version`：某份 PDF 生成时所基于的材料版本。上传时写入。

材料写操作（basic/contacts/sections/attachments 的 CUD）**只更新 `updated_at`**，且全部幂等：与现有内容无变化的 PUT 不写库、不触碰 `updated_at`（防止 blur 无操作造成「未提交修改」误报与版本虚抬）。

派生规则：

```
待导出   = status='submitted' AND (exported_version IS NULL OR exported_version < material_version)
待重生成 = EXISTS(approved resumes) AND material_version > MAX(approved resumes.material_version)
未提交修改 = submitted_at IS NOT NULL AND updated_at > submitted_at
最新PDF  = 该学生 approved resumes 中 created_at 最大的一条
```

家长提交后（含修改后重新提交），`status` 置为 `submitted`，自动进入下一轮导出生成循环。

---

## 2. 技术选型与项目结构

### 2.1 技术栈

| 层 | 选型 | 说明 |
|----|------|------|
| 运行时 | Cloudflare Workers | wrangler 部署 |
| 框架 | Hono (TypeScript) | 路由 + 中间件 |
| 数据库 | D1 (SQLite) | 结构化字段用列，板块内容用 JSON 列 |
| 对象存储 | R2 | 证书图片、头像、生成 PDF |
| 前端 | Vite + TypeScript，无框架或轻量 Preact | 静态产物由 Workers 托管 |
| zip 打包 | fflate | Workers 内流式/同步压缩均可，支持 UTF-8 文件名 flag |

**zip 文件名编码决策**：为彻底规避中文文件名在 zip 中的跨平台编码问题（Python zipfile / JS zip 库对 UTF-8 flag 处理不一致），**zip 内所有目录名与文件名一律使用 ASCII**：目录名为 `student_id`（如 `S0007`），附件文件名为 `attachment_id.ext`（如 `a0034.jpg`）。真实姓名与原始文件名存放在 `profile.json` 内。

### 2.2 项目结构

```
xsc-collector/
├── src/
│   ├── index.ts               # Hono 入口 + 静态资源服务
│   ├── routes/
│   │   ├── parent.ts          # 家长端 API（/api/me/*）
│   │   ├── admin.ts           # 管理端 API（/api/admin/*）
│   │   └── ai.ts              # AI 端 API（/api/ai/*）
│   ├── db/
│   │   ├── schema.sql         # D1 migration
│   │   └── queries.ts         # 学生/附件/简历查询封装
│   ├── lib/
│   │   ├── auth.ts            # 三种鉴权中间件
│   │   ├── city-configs.ts   # 城市配置（3.3 节 CITY_CONFIGS，唯一的城市知识源）
│   │   ├── ids.ts             # 短 ID 生成
│   │   ├── zip.ts             # fflate 打包导出
│   │   └── validate.ts       # 附件类型/大小校验
│   └── types.ts               # profile 契约的 TS 类型
├── web/                       # 前端源码（Vite）
│   ├── parent/                # 家长页
│   └── admin/                 # 管理页
├── wrangler.toml
├── package.json
└── schema.sql
```

---

## 3. 数据模型（D1）

### 3.1 完整 DDL

```sql
-- schema.sql（D1 migration v1）

CREATE TABLE IF NOT EXISTS students (
  id                TEXT PRIMARY KEY,        -- 'S' + 6位随机，如 S0007（服务端生成，保证 ASCII）
  name              TEXT NOT NULL DEFAULT '',
  city              TEXT NOT NULL DEFAULT 'guangzhou',
                    -- 城市代码: guangzhou|beijing|shanghai|shenzhen（CITY_CONFIGS 的 key，创建后不可改）
  invite_token      TEXT NOT NULL UNIQUE,    -- 32 hex 随机，家长链接用
  status            TEXT NOT NULL DEFAULT 'collecting',
                    -- collecting | submitted | exported | ready
  material_version  INTEGER NOT NULL DEFAULT 1,
  exported_version  INTEGER,                 -- 最后导出时的材料版本
  template_id       TEXT NOT NULL DEFAULT 'classic-blue',
  basic             TEXT NOT NULL DEFAULT '{}',   -- JSON：基本信息（见 3.2）
  essay_material    TEXT NOT NULL DEFAULT '{}',   -- JSON：自荐信素材
  family_note       TEXT NOT NULL DEFAULT '',     -- 家长寄语原文
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id          TEXT PRIMARY KEY,              -- 'c' + 6位随机
  student_id  TEXT NOT NULL,
  relation    TEXT NOT NULL,                 -- 父亲|母亲|其他
  name        TEXT NOT NULL DEFAULT '',
  work_unit   TEXT NOT NULL DEFAULT '',      -- 工作单位
  title       TEXT NOT NULL DEFAULT '',      -- 职务
  phone       TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (student_id) REFERENCES students(id)
);
CREATE INDEX IF NOT EXISTS idx_contacts_student ON contacts(student_id);

-- 统一的「多条目板块」表：获奖/成绩/特长/作品/目标学校
-- content 的 JSON 结构由 section_type 决定（见 3.2）
CREATE TABLE IF NOT EXISTS sections (
  id           TEXT PRIMARY KEY,             -- 'w'+'5位随机'，如 w00012（awards 用 'a' 前缀…统一 'sec' 前缀亦可）
  student_id   TEXT NOT NULL,
  type         TEXT NOT NULL,                -- grades|awards|talents|works|target_schools
  content      TEXT NOT NULL DEFAULT '{}',   -- JSON
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(id)
);
CREATE INDEX IF NOT EXISTS idx_sections_student ON sections(student_id, type);

CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,            -- 'a' + 5位随机，如 a0034（同时是 zip 内文件名主体）
  student_id    TEXT NOT NULL,
  section_type  TEXT NOT NULL,                -- basic|grades|awards|talents|works|target_schools|general
  item_id       TEXT,                         -- 关联 sections.id 或 contacts.id，basic 头像为 NULL
  r2_key        TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(id)
);
CREATE INDEX IF NOT EXISTS idx_attachments_student ON attachments(student_id, section_type);

CREATE TABLE IF NOT EXISTS resumes (
  id                TEXT PRIMARY KEY,        -- 'r' + 8位随机
  student_id        TEXT NOT NULL,
  material_version  INTEGER NOT NULL,        -- 生成时基于的材料版本
  batch_no          TEXT,                    -- 来源导出批次
  r2_key            TEXT NOT NULL,
  file_name         TEXT NOT NULL,           -- 如 张小明-小升初简历-v4.pdf
  file_size         INTEGER NOT NULL DEFAULT 0,
  note              TEXT NOT NULL DEFAULT '',-- AI 上传时的备注（如"材料版本落后"说明）
  review_status     TEXT NOT NULL DEFAULT 'pending',  -- v1.2: pending|approved|rejected
  reviewed_at       TEXT,                             -- v1.2: 审核时间
  created_at        TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(id)
);
CREATE INDEX IF NOT EXISTS idx_resumes_student ON resumes(student_id, created_at);

CREATE TABLE IF NOT EXISTS export_batches (
  batch_no       TEXT PRIMARY KEY,           -- B20260906-001
  student_count  INTEGER NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS export_items (
  batch_no          TEXT NOT NULL,
  student_id        TEXT NOT NULL,
  material_version  INTEGER NOT NULL,        -- 导出时的材料版本快照
  PRIMARY KEY (batch_no, student_id)
);
```

**设计说明：**

- 不建独立的 `users` 表。B 端代生成模式下家长身份由「邀请链接」承载（token 唯一映射到学生），老师由环境变量 `ADMIN_KEY` 承载，避免为一个内部工具做完整注册登录体系。后续开放多机构时再加账号表，schema 无需破坏性变更。
- 成绩、获奖等多条目板块统一存 `sections` 表：前端一个通用「条目卡片」组件即可覆盖增删改，`content` JSON 结构由 `type` 约定，D1 无需频繁改表。
- 每次材料写操作后在同一事务内 `material_version = material_version + 1` 并更新 `updated_at`。

### 3.2 各板块 content JSON 结构（小升初内容契约）

这是全系统的核心契约，前端表单、API、导出的 profile.json 三方共同遵守。

**students.basic：**

```json
{
  "gender": "男",
  "birth_date": "2014-05-12",
  "primary_school": "广州市天河区第一小学",
  "hukou_district": "天河区",
  "photo": "a0001"          // attachments.id，头像；无则 null
}
```

**students.essay_material（自荐信素材，家长提供原文，AI 后续润色）：**

```json
{
  "personality": "孩子性格描述…",
  "study_habits": "学习习惯描述…",
  "interests": "兴趣爱好…",
  "highlights": "最想让老师知道的3个闪光点…"
}
```

**sections.type = grades（一行 = 一个学期的三科成绩）：**

> 「哪些学期是核心」由学生所属城市的 CITY_CONFIGS 定义（广州是五下/六上，上海是四下~五下等，详见 3.3）。表单按城市配置渲染默认行；`is_core` 是**导出时服务端按城市配置计算的派生字段**（不落库），随 profile.json 输出，下游渲染与写作直接消费，无需再感知城市规则。

```json
{
  "semester": "五下",              // 枚举集合由城市配置给出: 广州[五上..六下] / 上海[四上..五下]
  "chinese": "95",                 // 分数或等级，自由填写
  "math": "98",
  "english": "99",
  "total": "292",                  // 三科总分（可选；广州家长圈口径 285/290/295）
  "level": "年级前10",             // 等级或排名说明（可选；上海「成长手册全优」填这里）
  "remark": ""
}
```

**sections.type = awards（含竞赛/杯碗字段）：**

> 竞赛体系强城市相关（广州杯碗 vs 北京迎春杯/华数 vs 上海思维100）。家长从**所属城市的竞赛字典**快捷选择，自动带出全称、科目与梯队；`cup_tier`（T1–T4）是导出时的排序与分量依据；非竞赛类荣誉（三好学生、红领巾奖章等）`cup_tier` 留空。字典见 3.3 CITY_CONFIGS。

```json
{
  "name": "华罗庚金杯少年数学邀请赛",
  "cup_short": "华杯",             // 字典简称（广州: 华杯|红棉|希望杯… / 北京: 迎春杯|华数|美国大联盟… / 上海: 思维100|小机灵|AMC8…）
  "cup_tier": "T1",                // 竞赛梯队: T1|T2|T3|T4，空 = 非竞赛荣誉
  "subject": "数学",                // 数学|英语|科创|信息学|语文|艺术|体育|综合
  "org": "华罗庚金杯组委会",
  "level": "国家级",
  "rank": "二等奖",                // 广州家长圈"花衣花儿"即杯赛一/二等奖，是名校敲门砖
  "date": "2025-06",
  "description": "决赛二等奖",
  "cert_images": ["a0002", "a0003"]   // attachments.id 列表
}
```

**sections.type = talents：**

```json
{
  "category": "科创",            // 科创|艺术|体育|学科|其他
  "title": "编程与机器人",
  "description": "学习图形化编程与Python三年，完成多个开源作品…",
  "years": "3",
  "cert_images": ["a0004"]
}
```

**sections.type = works（成长作品，科创机构特色板块）：**

```json
{
  "title": "智能浇花器",
  "description": "基于 ESP32 与土壤湿度传感器的自动浇花系统…",
  "images": ["a0005", "a0006"],
  "link": ""
}
```

**sections.type = target_schools：**

```json
{
  "name": "华南师范大学附属中学",
  "reason": "看重学校的科技创新氛围…"
}
```

### 3.3 城市配置 CITY_CONFIGS（系统核心领域层）

**设计原则：城市差异只存在于这一层。** 表结构、API 形状、状态机、版本机制、Skill 生成流程全部城市无关。新增城市 = 新增一个配置对象 + 运营补字典，其他零改动。

```ts
interface CityConfig {
  code: string;                // 'guangzhou'，与 students.city 对应
  name: string;                // '广州'
  schooling: "6-3" | "5-4";    // 学制：六三 / 五四（上海小学五年）
  semesters: string[];         // 可选学期枚举（表单下拉），如 ["五上","五下","六上","六下"]
  core_semesters: string[];    // 核心学期（表单默认渲染 + 导出 is_core 计算依据）
  score_hint: string;          // 成绩填写提示语（黑话换算等）
  cups: CupItem[];             // 竞赛字典（快捷下拉 + tier 解析）
  jargon: JargonItem[];         // 黑话速查（表单 tooltip + 客服话术）
  essay_tips: string[];        // 该城市自荐信写作要点（导出给 AI 的提示）
}
```

服务端维护于 `src/lib/city-configs.ts`，`GET /api/cities` 输出全量（前端缓存）；导出时按 `students.city` 取配置，把 `core_semesters` 计算为每条 grade 的 `is_core`，并把竞赛字典解析结果（`cup_short`/`cup_tier`）写入 awards。

#### 3.3.1 广州（首发完整配置）

```ts
{
  code: "guangzhou", name: "广州", schooling: "6-3",
  semesters: ["五上", "五下", "六上", "六下"],
  core_semesters: ["五下", "六上"],
  score_hint: "五下六上是学校筛选生源的首要参考（六下是分班依据）；285/290/295 即三科总分（满分300）",
  cups: [
    // 数学类（广州家长圈梯队：华杯 > 红棉 > 希望杯 > 线上水杯）
    { short: "华杯",   name: "华罗庚金杯少年数学邀请赛", subject: "数学", tier: "T1", note: "圈内公认硬通货，数论计数见长" },
    { short: "红棉",   name: "红棉杯青少年数学竞赛",       subject: "数学", tier: "T2", note: "前身五羊杯，广州本土，与华杯同组委会，3-7年级另设英语单科奖" },
    { short: "希望杯", name: "希望数学（希望杯）",         subject: "数学", tier: "T3", note: "全国性，参与基数大、区分度一般" },
    { short: "迎春杯", name: "数学花园探秘（迎春杯）",     subject: "数学", tier: "T2", note: "北方四大杯赛之一，广州部分认可" },
    { short: "走美",   name: "走进美妙的数学花园",         subject: "数学", tier: "T3" },
    { short: "YMO",   name: "YMO青少年数学思维研学活动",  subject: "数学", tier: "T4", note: "线上水杯" },
    { short: "WMO",   name: "WMO世界数学奥林匹克",        subject: "数学", tier: "T4", note: "线上水杯" },
    { short: "AMC8",  name: "AMC 8（美国数学竞赛）",       subject: "数学", tier: "T2" },
    { short: "澳洲AMC", name: "AMC（澳大利亚数学竞赛）",   subject: "数学", tier: "T3" },
    { short: "KET",   name: "剑桥英语 KET（A2 Key）",     subject: "英语", tier: "T2" },
    { short: "PET",   name: "剑桥英语 PET（B1 Preliminary）", subject: "英语", tier: "T1" },
  ],
  jargon: [
    { term: "五下六上", meaning: "五年级下+六年级上成绩（核心筛选依据）" },
    { term: "285/290/295", meaning: "语数英三科总分（满分300）" },
    { term: "杯碗", meaning: "各类竞赛统称" },
    { term: "花衣花儿（花一花二）", meaning: "杯赛一等奖/二等奖（名校敲门砖）" },
    { term: "HB / HM / XWB", meaning: "华杯 / 红棉 / 希望杯" },
    { term: "水杯", meaning: "YMO/WMO 等线上赛" },
    { term: "业主 / 豪门", meaning: "目标学校 / 顶尖名校" },
    { term: "上岸 / 船票", meaning: "被录取 / 录取通知" },
    { term: "ZDB / KB", meaning: "重点班 / 课改班" },
    { term: "HF / SS / GZ / EZ / TY / LZ / BYGY", meaning: "华附/省实/广雅/二中/铁一/六中/白云广雅" },
  ],
  essay_tips: [
    "五下六上成绩可写「五年级下学期」「六年级上学期期末三科总分292」",
    "T1/T2 杯碗（华杯/红棉）值得展开，水杯（YMO/WMO）不进自荐信",
  ],
}
```

#### 3.3.2 北京（初版）

```ts
{
  code: "beijing", name: "北京", schooling: "6-3",
  semesters: ["五上", "五下", "六上", "六下"],
  core_semesters: ["五下", "六上"],
  score_hint: "校内成绩优秀线：低年级 297+、高年级 295+（三科总分）",
  cups: [
    { short: "迎春杯", name: "数学花园探秘（迎春杯）", subject: "数学", tier: "T1", note: "北京本土权威，小高组(5-6年级)" },
    { short: "华数",   name: "华罗庚金杯少年数学邀请赛", subject: "数学", tier: "T1" },
    { short: "美国大联盟", name: "美国数学大联盟（Math League）", subject: "数学", tier: "T2", note: "全英文数学竞赛" },
    { short: "希望杯", name: "希望数学（希望杯）", subject: "数学", tier: "T3" },
    { short: "KET",  name: "剑桥英语 KET（A2 Key）", subject: "英语", tier: "T2" },
    { short: "PET",  name: "剑桥英语 PET（B1 Preliminary）", subject: "英语", tier: "T1" },
    { short: "FCE",  name: "剑桥英语 FCE（B2 First）", subject: "英语", tier: "T1" },
    { short: "朗思",  name: "朗思国际英语测评（IESOL）", subject: "英语", tier: "T2", note: "剑桥系替代品" },
    { short: "叶圣陶", name: "叶圣陶杯（语文）", subject: "语文", tier: "T2" },
    { short: "红领巾奖章", name: "红领巾奖章（个人三星级等）", subject: "综合", tier: "T1", note: "北京小升初重头证书，等级越高分量越大" },
  ],
  jargon: [
    { term: "DZ / MD", meaning: "点招 / 密电（违规操作，系统不涉及，仅识别家长口语）" },
    { term: "早培 / 素质班", meaning: "人大附早培 / 十一学校素质班等特殊招生通道" },
    { term: "297+ / 295+", meaning: "三科总分线（低/高年级优秀线）" },
  ],
  essay_tips: [
    "红领巾奖章、大队委/班干部经历是北京特色加分项，可在自荐信体现",
    "英语证书按 KET=B1 前一级、PET=B1 等级注明",
  ],
}
```

#### 3.3.3 上海（初版，五四学制）

```ts
{
  code: "shanghai", name: "上海", schooling: "5-4",
  semesters: ["四上", "四下", "五上", "五下"],   // 小学五年，无六年级
  core_semesters: ["四下", "五上", "五下"],
  score_hint: "成长手册评价是核心——四年级起语数英全优是名校门槛；三公网申看五年级综合表现",
  cups: [
    { short: "思维100", name: "「思维100」STEM应用能力活动（前身中环杯）", subject: "数学", tier: "T1", note: "上海奥数先驱，市二等奖以上被誉为名校通行证" },
    { short: "小机灵", name: "小机灵杯数学竞赛", subject: "数学", tier: "T2" },
    { short: "AMC8",  name: "AMC 8（美国数学竞赛）", subject: "数学", tier: "T1", note: "三公加分项，前5%/21+分有竞争力" },
    { short: "小托福", name: "TOEFL Junior（小托福）", subject: "英语", tier: "T1", note: "三公加分项，≥850分有竞争力" },
    { short: "KET",  name: "剑桥英语 KET（A2 Key）", subject: "英语", tier: "T2" },
    { short: "PET",  name: "剑桥英语 PET（B1 Preliminary）", subject: "英语", tier: "T1" },
  ],
  jargon: [
    { term: "三公", meaning: "上实/上外附中/浦外三所全市招生公办（网申+面谈）" },
    { term: "成长手册", meaning: "《上海市学生成长记录册》，评价全优是硬门槛" },
    { term: "飞人 / HY", meaning: "华育中学（民办第一梯队）" },
    { term: "大哥 / 一哥", meaning: "上外附中 / 华育" },
  ],
  essay_tips: [
    "上海无六年级，表述用「四年级第二学期」「五年级」",
    "三公申请的自荐信可强调面单关键项：思维100/AMC8/小托福成绩",
    "获奖排序惯例：按级别 国家>省市>区县>学校；按学科 数学>英语>科创>语文",
  ],
}
```

#### 3.3.4 深圳（复用广州模板，待运营校准）

```ts
{
  code: "shenzhen", name: "深圳", schooling: "6-3",
  semesters: ["五上", "五下", "六上", "六下"],
  core_semesters: ["五下", "六上"],
  score_hint: "同广州口径（五下六上），部分名校另看简历+积分",
  cups: [ /* 初期复用广州 cups，移除红棉条目，KET/PET/AMC8 保留，待运营校准补充本土赛事 */ ],
  jargon: [ /* 待运营补充：SZ 深中、烧烤（点招黑话，违规系统不涉及）等 */ ],
  essay_tips: ["表述口径同广州；目标校常见深中/深实验/深外/高级"],
}
```

> 字典是**运营资产**，随政策与家长圈共识逐年更新（如希望杯 2018 年后官方停办、红棉移师港澳等），版本化管理配置文件即可，不涉及库表迁移。

### 3.4 全局合规约定（所有城市通用）

- 简历成品**不使用黑话**——对学校老师永远呈现正式名称（「华罗庚金杯少年数学邀请赛 二等奖」「五年级下学期期末 三科总分292」）；黑话仅用于家长端表单提示、客服话术与 AI 理解家长素材。
- MK（密考）、DZ（点招）等属教育主管部门明令禁止的行为，本系统任何功能不涉及；竞赛展示一律使用正式赛事名称。
- 各城市「成绩口径、竞赛梯队」仅为家长圈通行说法的整理，提示语中需带「以当年官方政策为准」的免责说明。

> 注意：**没有**工作经历、职业技能、求职意向、ATS 等任何求职简历字段。新增板块需求 = 新的 `sections.type` + 前端一个卡片配置，不动库表。

---

## 4. API 规范

统一响应格式：

```json
// 成功
{ "ok": true, "data": { ... } }
// 失败
{ "ok": false, "error": { "code": "VALIDATION", "message": "附件超过 10MB 限制" } }
```

错误码：`UNAUTHORIZED`（401）、`FORBIDDEN`（403）、`NOT_FOUND`（404）、`VALIDATION`（400）、`PAYLOAD_TOO_LARGE`（413）、`UNSUPPORTED_MEDIA_TYPE`（415）、`INTERNAL`（500）。

### 4.1 家长端（Bearer invite_token）

前端从 URL `/s/:token` 提取 token，所有请求带 `Authorization: Bearer <token>`。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/me` | 学生信息 + 全部材料 + 状态 + 简历版本列表（**仅 approved**）+ 模板目录 |
| PUT | `/api/me/basic` | 保存基本信息（含 essay_material / family_note / **template_id**，可分字段提交） |
| POST | `/api/me/contacts` | 新增家庭成员 |
| PUT | `/api/me/contacts/:id` | 修改 |
| DELETE | `/api/me/contacts/:id` | 删除 |
| POST | `/api/me/sections` | 新增板块条目 `{type, content}`，返回 id |
| PUT | `/api/me/sections/:id` | 修改条目 content |
| DELETE | `/api/me/sections/:id` | 删除条目（关联附件同时删除，R2 对象异步清理） |
| POST | `/api/me/attachments` | 上传附件（multipart） |
| DELETE | `/api/me/attachments/:id` | 删除附件 |
| POST | `/api/me/submit` | 提交（校验必填：姓名、学校、至少一个联系电话；**v1.3：在此推进 material_version**） |
| GET | `/api/me/resumes` | 简历版本列表（**仅 approved**） |
| GET | `/api/me/resumes/:id` | PDF 文件流（inline，**仅 approved**） |
| GET | `/api/templates` | 模板目录（无需鉴权；id/name/desc/preview_img/sample_pdf） |

**v1.2 起所有材料 PUT 接口幂等**：与现有内容规范化比对无变化时不写库、不 bump 版本（防止 blur 无操作虚抬版本）；`template_id` 变更视为材料写操作（影响渲染，触发重新生成）。

**GET /api/me 响应示例：**

```json
{
  "ok": true,
  "data": {
    "student": {
      "id": "S0007",
      "name": "张小明",
      "city": "guangzhou",
      "city_config": {
        "name": "广州", "schooling": "6-3",
        "semesters": ["五上", "五下", "六上", "六下"],
        "core_semesters": ["五下", "六上"],
        "score_hint": "五下六上是学校筛选生源的首要参考…",
        "cups": [ … ],
        "jargon": [ … ]
      },
      "status": "ready",
      "material_version": 4,
      "needs_regen": false,
      "basic": { "gender": "男", "birth_date": "2014-05-12", "primary_school": "…", "hukou_district": "天河区", "photo": { "id": "a0001", "url": "/api/me/attachments/a0001" } },
      "essay_material": { "personality": "…", "study_habits": "…", "interests": "…", "highlights": "…" },
      "family_note": "…",
      "template_id": "classic-blue"
    },
    "contacts": [ { "id": "c00001", "relation": "父亲", "name": "张大强", "work_unit": "…", "title": "…", "phone": "…" } ],
    "sections": {
      "grades":  [ { "id": "s00001", "content": { "semester": "五下", "chinese": "95", "math": "98", "english": "99", "total": "292", "level": "年级前10", "remark": "" } } ],
      "awards":  [ { "id": "s00002", "content": { "name": "华罗庚金杯少年数学邀请赛", "cup_short": "华杯", "cup_tier": "T1", "subject": "数学", "org": "华罗庚金杯组委会", "level": "国家级", "rank": "二等奖", "date": "2025-06", "description": "决赛二等奖", "cert_images": [ {"id":"a0002","url":"/api/me/attachments/a0002"} ] } } ],
      "talents": [ … ], "works": [ … ], "target_schools": [ … ]
    },
    "resumes": [ { "id": "r0000001", "material_version": 4, "file_name": "张小明-小升初简历-v4.pdf", "created_at": "2026-09-06T18:30:00Z", "is_latest": true } ]
  }
}
```

**POST /api/me/attachments（multipart/form-data）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| file | File | 图片/PDF/Word |
| section_type | string | basic\|grades\|awards\|talents\|works\|target_schools\|general |
| item_id | string? | 关联条目 id，可后补（PATCH） |
| sort_order | number? | 排序 |

处理逻辑：校验 mime 白名单 `image/jpeg, image/png, image/webp, application/pdf, application/msword, application/vnd.openxmlformats-officedocument.wordprocessingml.document`；单文件 ≤ 10MB；写 R2 `students/{sid}/attachments/{aid}.{ext}`；插 attachments 表；bump material_version；返回 `{id, url}`。

图片预览：家长页面直接 `<img src="/api/me/attachments/:id">`，服务端从 R2 流式返回并带 `Cache-Control: public, max-age=31536000, immutable`（附件 id 唯一，内容不变）。

### 4.2 管理端（X-Admin-Key 头）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/cities` | 城市配置全量（管理端创建学生时选择城市；无需鉴权，只读配置） |
| POST | `/api/admin/students` | 创建学生 `{name, city?, template_id?}` → 返回邀请链接 |
| GET | `/api/admin/students` | 列表（含城市/状态/版本/needs_regen/最新简历/**待审核数**） |
| GET | `/api/admin/students/:id` | 详情（同家长端数据 + **全部简历含审核状态** + 操作记录） |
| PATCH | `/api/admin/students/:id` | 修改 template_id / 重置 invite_token（**city 创建后不可改**） |
| GET | `/api/admin/students/:id/resumes/:rid` | 查看 PDF（流式，不受审核状态限制） |
| POST | `/api/admin/students/:id/resumes/:rid/approve` | **v1.2 审核通过** → `review_status='approved'`，学生 status review→ready，家长立即可见 |
| POST | `/api/admin/students/:id/resumes/:rid/reject` | **v1.2 驳回** `{reason?}` → `review_status='rejected'`，学生 `status='submitted'` + `exported_version=NULL`，自动重进导出队列 |

**POST /api/admin/students 请求/响应：**

```json
// 请求
{ "name": "张小明", "city": "guangzhou", "template_id": "classic-blue" }
// 响应
{ "ok": true, "data": { "id": "S0007", "city": "guangzhou", "invite_url": "https://xxx.workers.dev/s/9f8e7d6c…", "name": "张小明" } }
```

### 4.3 AI 端（X-API-Key 头）——Skill 调用的核心接口

#### v1.10 按学生拉取模式（Skill 默认路径）

整批 zip 导出要求「所有学生附件 + zip 输出缓冲」同时驻留内存，批附件总量 ~60MB 即顶穿 Workers 128MB 上限（error 1102）。v1.10 起 Skill 改用按学生拉取，任何单次请求内存占用与附件总量无关：

**① POST /api/ai/export/begin** —— 开启批次。快照待导出学生写入 export_batches + export_items（**不推进** exported_version），无待导出学生返回 `204`。响应：

```json
{ "ok": true, "data": { "batch_no": "B20260913-001", "exported_at": "…", "students": [ { "id": "S0007", "name": "张小明", "material_version": 4 } ] } }
```

**② GET /api/ai/students/:id/profile?batch_no=&exported_at=** —— 单学生 profile.json（KB 级）。响应 `data` 即 profile 契约（第 5 章），外加 `data.attachments`：profile 实际引用的附件清单 `[{ id, path, mime_type, size }]`（孤儿附件不下发；path 为学生目录内相对路径如 `attachments/a0001.jpg`）。

**③ GET /api/ai/attachments/:id** —— 单张附件，R2 `obj.body` 流式转发（零内存放大）。`GET /api/ai/revision-files/:id` 同理转发退回修改佐证文件。

**④ POST /api/ai/export/:id/ack** —— body `{ "batch_no": "…" }`，客户端确认该学生材料全部下载完成，服务端按 export_items 快照推进 `exported_version`、`status='exported'`。仅当 `students.material_version` 仍等于快照版本时生效，否则返回 `stale: true`（材料在导出期间被家长更新，本批次作废、下批重出）。下载失败的学生不 ack，自然留在待导出队列。

#### GET /api/ai/export（整批 zip，保留为兜底）

**语义**：拉取所有「待导出」学生（已提交且导出后材料有更新），打成一个 zip 返回，并记录导出批次。无待导出学生返回 `204 No Content`。

> v1.10 起两处内存修复：① 只打包被 profile 引用的附件（`buildProfile` 回填 usedIds，孤儿附件跳过）；② zip 输出改流式（fflate `Zip` + `ZipPassThrough` 边压边吐），峰值内存 ≈ 源数据本身，不再随 zip 输出翻倍。

**响应头**：`X-Batch-No: B20260906-001`、`Content-Disposition: attachment; filename="B20260906-001.zip"`。

**zip 结构（文件名全 ASCII）：**

```
S0007/
  profile.json                 # 该学生全部结构化材料（契约见第 5 章）
  attachments/
    a0001.jpg                  # 头像
    a0002.jpg                  # 获奖证书（文件名 = attachments.id + 原扩展名）
    a0003.jpg
S0012/
  profile.json
  attachments/…
```

**服务端处理步骤：**

1. 验 `X-API-Key`。
2. 查待导出：`status='submitted' AND (exported_version IS NULL OR exported_version < material_version)`。
3. 生成 batch_no（`B{YYYYMMDD}-{当日序号}`），插入 export_batches。
4. 每个学生：按 `students.city` 取 CITY_CONFIGS，写入 `city` 对象（含 essay_tips）与每条 grade 的 `is_core`（按 core_semesters 计算）；组装 profile.json（同时回填被引用附件 id 集合）；读被引用附件的 R2 对象；fflate 流式 `Zip` 打包。
5. 事务内：插 export_items、更新 `students.exported_version = material_version`、`status='exported'`。
6. 返回 zip。

**实现要点（fflate）：**

```ts
import { zipSync, strToU8 } from "fflate";

const files: Record<string, Uint8Array> = {};
for (const st of students) {
  files[`${st.id}/profile.json`] = strToU8(JSON.stringify(st.profile, null, 2));
  for (const att of st.attachments) {
    const obj = await env.BUCKET.get(att.r2_key);
    files[`${st.id}/attachments/${att.id}.${ext(att)}`] = new Uint8Array(await obj.arrayBuffer());
  }
}
const zipped = zipSync(files, { level: 1 });   // v1.10 起改为流式 buildZipStream(files)，见 src/lib/zip.ts
return new Response(zipped, { headers: { "Content-Type": "application/zip", "X-Batch-No": batchNo, ... } });
```

**限制与对策**：Workers 内存 128MB。v1.10 流式 zip 后峰值 ≈ 源附件总量（不再翻倍），单批附件 ~110MB 内安全；Skill 默认走按学生拉取模式，彻底与附件总量无关。

#### POST /api/ai/resumes（multipart/form-data）

| 字段 | 类型 | 说明 |
|------|------|------|
| student_id | string | 如 S0007 |
| batch_no | string | 来源批次（用于版本对账） |
| file | File | PDF，≤ 30MB，mime 必须 application/pdf |
| note | string? | 备注 |
| essay | string? | **v1.6** 该版简历使用的自荐信原文（≤8000 字），存 `resumes.essay_text`，退回修改时作为 AI 修订底稿 |

**处理步骤：**

1. 验 `X-API-Key` + 参数校验。
2. 学生存在性校验（404）。
3. R2 写入：`resumes/{student_id}/{yyyymmddhhmmss}-{rand4}.pdf`。
4. 确定该 PDF 的材料版本：优先从 export_items 查 `(batch_no, student_id)` 的 material_version；查不到（如手工触发）用学生当前 material_version。
5. 插入 resumes 记录：`file_name = {学生姓名}-小升初简历-v{material_version}.pdf`，**`review_status='pending'`（v1.2，家长不可见）**。
6. 若学生当前 `status='exported'`，更新为 **`review`（待审核）**——审核通过后才变 ready。
7. 返回：

```json
{ "ok": true, "data": { "resume_id": "r0000001", "student_id": "S0007", "material_version": 4, "is_latest": true } }
```

> 版本落后场景：上传时若发现 `students.material_version > 导出时的版本`，仍接受上传（家长会看到该版本 PDF + 红色提示「材料已更新，待重新生成」），并在 resumes.note 写入「材料已更新，此版本基于旧材料生成」。

#### GET /api/ai/pending（可选，探测用）

返回待导出学生数量与列表摘要，Skill 定时任务可先探测再决定是否下载。

```json
{ "ok": true, "data": { "count": 3, "students": [ { "id": "S0007", "name": "张小明", "material_version": 4 } ] } }
```

---

## 5. profile.json 导出契约（与 Skill 的对接合同）

Skill（虚拟机 Trae）与收集页之间**唯一的两个交互点**就是导出 zip 和上传 PDF。profile.json 是单向数据契约，结构如下：

```json
{
  "student_id": "S0007",
  "name": "张小明",
  "city": {
    "code": "guangzhou",
    "name": "广州",
    "schooling": "6-3",
    "core_semesters": ["五下", "六上"],
    "essay_tips": ["五下六上成绩可写「五年级下学期」…", "T1/T2 杯碗值得展开…"]
  },
  "basic": {
    "gender": "男",
    "birth_date": "2014-05-12",
    "primary_school": "广州市天河区第一小学",
    "hukou_district": "天河区",
    "photo": "attachments/a0001.jpg"
  },
  "contacts": [
    { "relation": "父亲", "name": "张大强", "work_unit": "XX科技有限公司", "title": "工程师", "phone": "13800000000" }
  ],
  "grades": [
    { "semester": "五下", "is_core": true, "chinese": "95", "math": "98", "english": "99", "total": "292", "level": "年级前10", "remark": "" }
  ],
  "awards": [
    {
      "name": "华罗庚金杯少年数学邀请赛",
      "cup_short": "华杯",
      "cup_tier": "T1",
      "subject": "数学",
      "org": "华罗庚金杯组委会",
      "level": "国家级",
      "rank": "二等奖",
      "date": "2025-06",
      "description": "决赛二等奖",
      "cert_images": ["attachments/a0002.jpg", "attachments/a0003.jpg"]
    }
  ],
  "talents": [
    { "category": "科创", "title": "编程与机器人", "description": "…", "years": "3", "cert_images": ["attachments/a0004.jpg"] }
  ],
  "works": [
    { "title": "智能浇花器", "description": "…", "images": ["attachments/a0005.jpg"], "link": "" }
  ],
  "target_schools": [
    { "name": "华南师范大学附属中学", "reason": "…" }
  ],
  "essay_material": { "personality": "…", "study_habits": "…", "interests": "…", "highlights": "…" },
  "family_note": "家长寄语原文…",
  "revision": {
    "note": "工作人员的修改意见（v1.6，仅退回修改过的学生导出时注入）",
    "previous_essay": "上一版简历的自荐信原文（resumes.essay_text，可能为空）",
    "files": [{ "path": "revision/rf000001-参考样例.pdf", "name": "参考样例.pdf", "mime_type": "application/pdf" }]
  },
  "meta": {
    "batch_no": "B20260906-001",
    "material_version": 4,
    "exported_at": "2026-09-06T18:00:00Z",
    "template_id": "classic-blue"
  }
}
```

组装规则：`basic.photo` 与各条目 `cert_images / images` 在导出时由服务端从 attachments 表转换为 zip 内相对路径（`attachments/{id}.{ext}`）。无附件的条目对应空数组。**城市上下文（`city` 对象）与每条 grade 的 `is_core` 由服务端按 CITY_CONFIGS 在导出时写入**——Skill 端不需要内置城市规则，排序与加粗直接消费 `is_core`/`cup_tier`，写作分寸参考 `essay_tips`。

**v1.6 两点补充：**
- `target_schools` 与 `family_note` 是**内部数据**（给工作人员参考/写作上下文），简历模板不渲染，Skill 也不得写入简历正文。
- `revision` 字段**仅当学生最新一条带修改意见的驳回简历存在时注入**：取 `revision_note` 最新的一条驳回简历（`ORDER BY created_at DESC`），附其 `essay_text` 与 `revision_files`（文件打进 zip 的 `{sid}/revision/` 目录）。Skill 收到后以「修订」而非「重写」方式再生成。

## 6. R2 存储布局

```
students/{student_id}/attachments/{attachment_id}.{ext}    # 家长上传的材料
resumes/{student_id}/{yyyymmddhhmmss}-{rand4}.pdf           # AI 生成的简历
revisions/{student_id}/{resume_id}/{file_id}-{原名}          # v1.6: 退回修改的佐证文件
```

Bucket 私有，无公开访问；所有读取经 Workers 鉴权后流式代理。清理策略：删除学生（管理端软删预留）后异步清理 R2 前缀，MVP 可手动清。

---

## 7. 前端设计

### 7.1 家长页 `/s/:token`

**响应式断点**：≤ 768px 单列移动版（表单纵向滚动、大触控目标 ≥ 44px、`capture` 属性直接调相机）；> 768px 桌面版（表单 720px 居中，右侧吸顶显示「填写进度 + 状态卡」）。

**页面结构（自上而下）：**

```
┌──────────────────────────────────────────────┐
│ 头部：孩子姓名 · 状态徽章 · 材料版本 v4          │
│ （needs_regen 时红色横幅：材料已更新，简历将重新生成）│
├──────────────────────────────────────────────┤
│ ① 基本信息                                     │
│   姓名(只读) 性别 出生日期 毕业小学 户籍区        │
│   孩子照片上传（圆形裁切预览，调相机/相册）          │
├──────────────────────────────────────────────┤
│ ② 家庭成员（卡片：关系/姓名/单位/职务/电话，增删） │
├──────────────────────────────────────────────┤
│ ③ 学业成绩（按城市配置渲染：默认展示核心学期行     │
│   并标注★关键——广州五下/六上、上海四下/五上/五下； │
│   语/数/英/总分/排名，可增补其他学期；             │
│   提示语取自 city_config.score_hint）             │
├──────────────────────────────────────────────┤
│ ④ 获奖情况（卡片：快捷下拉取自城市竞赛字典——     │
│   广州华杯/红棉…、北京迎春杯/红领巾奖章…、        │
│   上海思维100/小托福…，选中自动带出全称+科目+梯队； │
│   也可自填其他赛事；级别/等级/时间/描述 +           │
│   证书照片九宫格上传）                            │
├──────────────────────────────────────────────┤
│ ⑤ 兴趣特长（分类选择 + 描述 + 证书图片）           │
├──────────────────────────────────────────────┤
│ ⑥ 成长作品（标题/描述/图片多张/链接，科创特色）     │
├──────────────────────────────────────────────┤
│ ⑦ 自荐信素材（性格/学习习惯/兴趣/闪光点，四个文本域，│
│   提示语：请用大白话描述，AI 会帮孩子组织成正式自荐信）│
├──────────────────────────────────────────────┤
│ ⑧ 家长寄语（文本域）                            │
├──────────────────────────────────────────────┤
│ ⑨ 目标学校（学校名 + 择校理由）                  │
├──────────────────────────────────────────────┤
│ ⑩ 简历模板（v1.2：预览缩略图卡片，点击选用，       │
│    点缩略图放大预览，附完整示例 PDF 链接；          │
│    更换模板 = 材料写操作，简历自动重新生成）         │
├──────────────────────────────────────────────┤
│ ⑪ 提交按钮（校验必填 → POST submit）             │
│    提交后按钮变为「已提交，仍可修改」              │
├──────────────────────────────────────────────┤
│ ⑫ 我的简历（PDF 版本列表：**仅显示审核通过的版本**，│
│    版本号/生成时间/查看按钮，内嵌 iframe 预览 +     │
│    全屏打开；旧版本可切换）                        │
└──────────────────────────────────────────────┘
```

**交互细节：**

- **自动保存**：文本类字段 debounce 800ms 后 PUT；条目类在「确认添加」时 POST、编辑即 PUT。保存失败顶部红色提示 + 本地 localStorage 兜底。
- **附件上传**：选择文件即上传（不随表单提交），进度条 + 缩略图占位；失败自动重试一次。
- **提交后可编辑**：所有接口在 submitted/exported/ready 状态下依然开放（写操作触发 material_version+1 与状态回退 submitted），顶部黄条提示「您修改了材料，简历将自动重新生成」。
- **PDF 查看**：`<iframe src="/api/me/resumes/:id">`，移动端提供「在新窗口打开」按钮。

### 7.2 管理页 `/admin`

- 登录：输入 ADMIN_KEY 存 localStorage。
- 学生表格：ID / 姓名 / **城市** / 状态徽章 / 材料版本 / 最新简历版本 / needs_regen / **待审核数** / 创建时间 / 操作（**审核**、复制邀请链接、查看 PDF、重置链接）。
- **审核界面（v1.2）**：学生详情内列出全部简历版本（pending/approved/rejected 标记），每份可「查看 PDF / 通过 / 驳回（可填原因）」；驳回后学生自动回到待导出队列。
- 新建学生：**城市选择（广州/北京/上海/深圳，决定表单与字典口径，创建后不可改）** + 姓名 + 模板选择（classic-blue / warm-elegant，家长可后续自改）→ 弹窗展示邀请链接 + 二维码（本地生成，qrcode 库）。

---

## 8. 关键实现要点

### 8.1 ID 生成（src/lib/ids.ts）

```ts
const CHARS = "0123456789"; // 纯数字避免混淆
export function shortId(prefix: string, len: number): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return prefix + Array.from(buf, (b) => CHARS[b % 10]).join("");
}
// 学生：shortId("S", 4) → S0007（冲突时重试）
// 附件：shortId("a", 4)、条目：shortId("s", 5)、简历：shortId("r", 8)
```

### 8.2 鉴权中间件（src/lib/auth.ts）

```ts
const parentAuth = createMiddleware(async (c, next) => {
  const token = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  const row = token ? await c.env.DB.prepare("SELECT * FROM students WHERE invite_token=?").first(token) : null;
  if (!row) return c.json({ ok: false, error: { code: "UNAUTHORIZED", message: "邀请链接无效" } }, 401);
  c.set("student", row);
  await next();
});

const aiAuth = createMiddleware(async (c, next) => {
  if (c.req.header("X-API-Key") !== c.env.AI_API_KEY) return c.json({ ok: false, ... }, 401);
  await next();
});
// adminAuth 同理比对 X-Admin-Key
```

### 8.3 material_version 自增

所有材料写路由（basic/contacts/sections/attachments 的 CUD）成功后执行：

```ts
await c.env.DB.prepare("UPDATE students SET material_version = material_version + 1, updated_at = ? WHERE id = ?")
  .bind(new Date().toISOString(), sid).run();
// 若当前 status 为 exported/ready，同时回退为 submitted
```

### 8.4 Hono multipart 解析

```ts
app.post("/api/me/attachments", parentAuth, async (c) => {
  const body = await c.req.parseBody(); // { file: File, section_type: string, ... }
  const file = body.file as File;
  // 校验 mime / size → R2 put → 插表 → bump version
});
```

### 8.5 导出事务

D1 的 batch API 保证原子性：`export_items` 插入、`exported_version` 更新、`status='exported'` 放同一 `DB.batch([...])`。

---

## 9. 部署步骤

```bash
# 1. 创建资源
wrangler d1 create xsc-collector
wrangler r2 bucket create xsc-materials

# 2. wrangler.toml
name = "xsc-collector"
main = "src/index.ts"
compatibility_date = "2026-09-01"
[[d1_databases]]
binding = "DB"
database_name = "xsc-collector"
database_id = "<上一步输出>"
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "xsc-materials"
[assets]
directory = "./web/dist"     # Hono 与静态资源共存的推荐方式

# 3. 建表 + 密钥
wrangler d1 execute xsc-collector --file=./schema.sql
wrangler secret put ADMIN_KEY    # openssl rand -hex 32
wrangler secret put AI_API_KEY   # openssl rand -hex 32

# 4. 前端构建 + 部署
cd web && npm run build && cd ..
wrangler deploy
```

---

## 10. 安全设计

- 邀请 token 32 hex 随机，仅经老师私发；重置即失效旧链接。
- 上传白名单 + 大小限制（单文件 10MB / PDF 30MB）；文件名服务端重生成，杜绝路径注入。
- 所有 R2 读写经 Workers 鉴权代理，bucket 不开公开访问。
- AI/Admin key 走 wrangler secret，不入库不入前端。
- 未成年人信息：R2 + D1 均在机构自有 Cloudflare 账号内；家长协议由线下签署；交付完成后管理端支持清空学生材料（删除 students + attachments + resumes 记录，R2 前缀异步清理）。
- CORS：API 默认同源（前端由同 Worker 托管）；AI 端为服务端调用无需 CORS。

---

## 11. 已知限制与后续优化

| 限制 | 触发条件 | 后续方案 |
|------|---------|---------|
| 单次导出 ≤ 50 学生 | Workers 内存 128MB | 导出分页（`?offset=`）或预签名 URL 直传 R2 后返回清单 |
| 无速率限制 | 内部系统 | Cloudflare WAF 规则或中间件计数 |
| 附件 R2 对象删除为惰性 | 删除条目 | Cron Trigger 每日对账清理孤儿对象 |
| 单管理员 | ADMIN_KEY 全权限 | 多角色账号表（开放 B 端输出时） |

---

## 12. 开发里程碑建议

1. **D1 schema + 管理 API**（半天）：建表、创建学生、列表。用 curl 验证。
2. **家长端 API**（1 天）：`/api/me` 系列 + 附件上传，先不接前端，用 curl/Postman 走通全流程。
3. **导出 + 上传 API**（1 天）：fflate 打包、zip 手工下载验证、PDF 手工上传回传、版本状态流转核对。
4. **家长前端**（2 天）：按 7.1 结构开发，移动端优先。
5. **管理前端**（0.5 天）：学生表格 + 邀请链接。
6. **与 Skill 联调**（0.5 天）：虚拟机跑 skill 全流程，端到端验证「导出→生成→回传→家长页面看到 PDF」。

---

## 附录：状态流转核对表（联调用）

| 操作 | status 变化 | 版本变化 |
|------|------------|---------|
| 老师创建学生 | collecting | material_version=1 |
| 家长保存任意材料/上传附件 | 不变 | **不变**（v1.3：实时落库，只更新 updated_at；内容无变化连 updated_at 都不动） |
| 家长首次提交 | submitted | 不变（保持 v1），submitted_at 写入 |
| 家长修改后重新提交 | submitted | 当前版本已被消费且有新修改时 +1（needs_regen 派生为 true） |
| 无新修改重复点提交 | submitted | 不变 |
| AI 导出 | exported | exported_version=当前 material_version |
| AI 上传 PDF | review（待审核） | resumes 新增 review_status='pending' |
| 老师审核通过 | ready | resumes.review_status='approved'，家长可见 |
| 老师驳回 | submitted（重进队列） | resumes.review_status='rejected'，exported_version=NULL |
| AI 再次导出该学生 | exported | exported_version 更新 |

---

## 13. 获奖证书 OCR 自动识别（v1.4）

### 13.1 设计动机

家长手动填写获奖记录要打字 9 个字段（赛事全称/科目/主办方/级别/等级/时间/补充说明/快捷选择...），多数家长最后放弃填写或填错。**OCR 的目标不是「完全替代填写」，而是把空白卡片从「9 个空字段」变成「1 张已填好的草稿，家长只需核对修改」**——这是产品体验上的核心提效。

### 13.2 方案选型（Workers 上可行方案对比）

| 方案 | 中文证书精度 | 成本 | 隐私 | 复杂度 | 是否采用 |
|------|------------|------|------|--------|---------|
| **Workers AI 内置**（`@cf/google/gemma-3-12b-it`） | 中 | 低（按 token 计费） | ✅ 数据不出 CF | 低 | **默认路径** |
| Workers AI 内置 Llama-3.2-11b-vision | 中偏弱（中文差） | 低 | ✅ | 低 | 否 |
| Google Cloud Vision + 正则后处理 | 高（纯 OCR 层） | 中 | ❌ 数据出海 | 高 | 否 |
| 百度/腾讯 OCR + 正则后处理 | 高 | 低 | ✅ | 高 | 否（纯 OCR + 正则比多模态 LLM 工程量还大） |
| **外部多模态 LLM**（GPT-4o / Gemini 2.5 Pro / Qwen-VL-Max） | **最高** | 中（单图 ¥0.1–0.3） | ⚠ 数据到第三方 | 低 | **可选高精度路径** |
| PaddleOCR 自部署 | 中 | 高（需 GPU） | ✅ | 极高 | 否 |

**核心判断**：传统 OCR 路线（Google Vision/百度/腾讯）的工程量与精度上限都劣于多模态 LLM——证书版式千变万化，纯文本 OCR 后还要写大量正则去抽「决赛二等奖」「Distinction」「Honor Roll」这类非结构化表达。**多模态 LLM 一站式完成「读图 + 理解版式 + 输出结构化 JSON」**，工程量小一个数量级。

**双轨架构**：
- **默认走 Workers AI**（`gemma-3-12b-it`）：零配置、零密钥、隐私最好；精度对常见证书够用（华杯/KET/红领巾奖章等标准化版式）
- **可选启用外部多模态 LLM**：配 `EXTERNAL_OCR_PROVIDER`（`openai` | `google` | `qwen`）+ `EXTERNAL_OCR_API_KEY` 启用，精度上限高
- 两套共用同一 prompt + 缓存层，对外契约一致
- 家长侧无感知差异（前端只看返回的 JSON 是否完整可信）

### 13.2.1 Workers AI 视觉模型选型（2026-09 实测查证，免费档）

数据来源：CF 官方 [model catalog](https://developers.cloudflare.com/workers-ai/models/) + [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)。
免费额度 **10,000 Neurons/天**；单次按 input 2500 tokens（含图）+ output 300 tokens 估算。

| 模型 | task | capabilities | 单次 neurons | 免费档约次数 | 结论 |
|------|------|--------------|-------------|-------------|------|
| **`@cf/moondream/moondream3.1-9B-A2B`** | **Image-to-Text** | Vision | ~96 | ~105/天 | **首选**：官方描述**唯一点名 OCR** + structured output，task 原生就是图转文本 |
| **`@cf/qwen/qwen3.8-27b`** | **Image-Text-to-Text** | Vision+Reasoning | ~190 | ~53/天 | **次选**：国产 Qwen，**中文最强**，原生图文 |
| **`@cf/google/gemma-4-26b-a4b-it`** | Text Generation | Vision+Reasoning+FC | ~31 | ~323/天 | 性价比兜底：26B 新模型，最省额度 |
| **`@cf/meta/llama-3.2-11b-vision-instruct`** | Text Generation | Vision+LoRA | ~29 | ~340/天 | 最后兜底：CF 官方 vision 标杆，schema 明确含 `image` |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | Text Generation | Vision+Batch+FC | ~85 | ~118/天 | 备选（原生多模态） |
| `@cf/google/gemma-3-12b-it` | Text Generation | — | ~94 | ~107/天 | ⚠️ binding schema 无 `image` 参数，传图易 502 |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | Text Generation | Vision | ~95 | ~105/天 | 备选 |
| `@cf/moonshotai/kimi-k2.5` | Text Generation | Vision+Reasoning | ~218 | ~46/天 | 备选（中文好但贵） |

**必须排除（需付费账单，免费档调不通）**：`kimi-k2.6`、`kimi-k2.7-code`、`glm-5.2`、`glm-5.3`、`glm-5.3-flash`、`deepseek-v4-flash-0731`、`deepseek-v4-pro-0813`。

**排序逻辑**：先「任务最对口」（moondream 专做 OCR），再「中文最强」（qwen），后两个低价高额度兜底——保证免费档下前两个触顶时仍可用。

**入参风格**：每个模型依次尝试两种，哪个通就用哪个：
1. `messages` + `{ type: "image_url", image_url: { url } }`（OpenAI 兼容，多数 Text Generation 模型）
2. `prompt` + `image: number[]`（旧式 Image-to-Text 模型，如 moondream 可能只认这个）

⚠️ **踩坑教训**：写 `{ type: "image", image: dataUrl }` 会触发 Workers AI 内部异常 → 网关 **502**，且不返回任何有效错误信息。

**顺序可用环境变量 `OCR_MODEL_ORDER` 覆盖**（wrangler.toml `[vars]`），部署后用 `GET /api/me/ocr/health` 实测再就地调序，无需改代码。

### 13.3 数据契约

**POST /api/me/ocr/award** — 单证书识别

请求：multipart/form-data，字段 `file`（图片，JPG/PNG/WebP，≤ 10MB）或 JSON `{ attachment_id }`（已上传的 R2 附件，**推荐路径**——家长无感识别）。

响应：

```json
{
  "ok": true,
  "data": {
    "source": "cache" | "workers_ai" | "external",
    "model": "gemma-3-12b-it" | "gpt-4o" | "gemini-2.5-pro" | "qwen-vl-max",
    "duration_ms": 4321,
    "confidence": "high" | "medium" | "low",
    "fields": {
      "name": "华罗庚金杯少年数学邀请赛",
      "cup_short": "华杯",
      "cup_tier": "T1",
      "subject": "数学",
      "org": "华罗庚金杯少年数学邀请赛组委会",
      "level": "国家级",
      "rank": "二等奖",
      "date": "2025-06",
      "description": "决赛二等奖"
    },
    "matched_dict_entry": {
      "short": "华杯",
      "name": "华罗庚金杯少年数学邀请赛",
      "subject": "数学",
      "tier": "T1"
    },
    "raw_text": "华罗庚金杯少年数学邀请赛...\n...",   // 原始识别文本，给家长做兜底参考
    "hints": ["等级字段模糊，已根据杯赛惯例推断为「二等奖」"]
  }
}
```

**字段映射表**（OCR 输出 → AwardContent，**家长页面落地规则**）：

| OCR 字段 | AwardContent 字段 | 备注 |
|---------|------------------|------|
| `name` | `content.name` | 优先用 city_config.cups 里的正式全称替换 |
| `cup_short` | `content.cup_short` | 仅当匹配 cups 字典时填入 |
| `cup_tier` | `content.cup_tier` | 同上，仅字典匹配时填 |
| `subject` | `content.subject` | 必须枚举：数学/英语/科创/信息学/语文/艺术/体育/综合 |
| `org` | `content.org` | 自由文本 |
| `level` | `content.level` | 必须枚举：国家级/省级/市级/区级/校级 |
| `rank` | `content.rank` | 自由文本（如「二等奖」「Distinction」） |
| `date` | `content.date` | 强制 `YYYY-MM` 格式，无法解析留空 |
| `description` | `content.description` | 自由文本 |

### 13.4 Prompt 工程（核心：注入城市 cups 字典）

System prompt 模板（src/lib/ocr.ts 实现）：

```
你是中国小升初简历助手，专注于识别获奖证书图片并抽取结构化字段。

# 你的任务
读取证书图片，输出一个 JSON 对象，字段定义如下：
- name: 赛事/荣誉全称（必须是家长圈公认的正式名称，不要用圈内黑话简称）
- cup_short: 若属于下方"竞赛字典"中的赛事，填字典里的 short；否则留空
- cup_tier: 若属于字典中赛事，填字典里的 tier（T1/T2/T3/T4）；否则留空
- subject: 数学|英语|科创|信息学|语文|艺术|体育|综合（按字典映射或证书内容推断）
- org: 主办单位
- level: 国家级|省级|市级|区级|校级（按主办单位推断或证书内容判断）
- rank: 获奖等级/名次原文（如「二等奖」「Distinction」「Honor Roll」）
- date: YYYY-MM 格式，无法解析留空
- description: 其他说明文字（如「决赛二等奖」「广州赛区」）

# 当前城市：广州
# 竞赛字典（家长圈口径，简历成品用「全称」，填写快捷选择时用 short）：
- 华杯 → 华罗庚金杯少年数学邀请赛｜数学｜T1
- 红棉 → 红棉杯青少年数学竞赛｜数学｜T2
- 希望杯 → 希望数学（希望杯）｜数学｜T3
- ...（动态注入 CITY_CONFIGS[city].cups）

# 输出要求
1. 严格 JSON，无任何注释、markdown 代码块包裹、前后缀文字
2. 无法确定的字段留空字符串，不要编造
3. 若图片不是证书（如学生证、奖牌），name 留空、其他字段也留空
4. 优先级：name > cup_short > cup_tier > subject > org > level > rank > date > description
```

User prompt：

```
请识别这张证书图片，输出 JSON。
```

Image：以 base64 data URL 或 multipart 二进制传入 Workers AI / 各外部 API。

### 13.5 OCR 缓存（同一证书不重复 OCR）

```sql
-- migration 004
CREATE TABLE IF NOT EXISTS ocr_cache (
  attachment_id TEXT PRIMARY KEY,        -- 关联 attachments.id
  student_id    TEXT NOT NULL,
  model         TEXT NOT NULL,           -- 'gemma-3-12b-it' / 'gpt-4o' / ...
  provider      TEXT NOT NULL,           -- 'workers_ai' / 'openai' / 'google' / 'qwen'
  fields_json   TEXT NOT NULL,           -- 13.3 字段映射表对应的 JSON
  matched_short TEXT,                    -- 命中的 city cup short
  raw_text      TEXT NOT NULL DEFAULT '',-- 原始识别文本（兜底展示）
  confidence    TEXT NOT NULL,           -- 'high'|'medium'|'low'
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL            -- 默认 +30 天；家长可手动重新识别
);
CREATE INDEX IF NOT EXISTS idx_ocr_cache_student ON ocr_cache(student_id, expires_at);
```

**缓存策略**：
- 命中：直接返回 `source: 'cache'`，不调模型
- 未命中：调模型 → 写缓存 → 返回 `source: 'workers_ai' | 'external'`
- 失效：30 天过期（OCR 模型版本升级、字典更新、家长主动「重新识别」按钮触发清理）
- 隐私：缓存是同一学生 + 同张证书图片的派生数据，无横向泄露；删除附件时同步清理缓存

### 13.6 前端交互（家长侧体验）

**核心交互**：上传证书照片后**自动**触发 OCR，结果以可编辑的「识别草稿」弹窗呈现，家长逐字段核对/修改 → 点「确认导入」才写入对应获奖条目（自动创建新条目或追加到现有条目的 `cert_images`）。

```
[获奖卡片]
├─ 现有手动条目（赛事/科目/级别...）
└─ 证书照片九宫格
   ├─ 已有图片（缩略图 + 删除按钮）
   └─ [+ 上传] 触发 OCR
       ├─ 上传成功 → 后台自动调 /api/me/ocr/award
       ├─ 弹出「识别草稿」弹窗：
       │   ┌──────────────────────────────────┐
       │   │ 识别结果 (gemma-3-12b-it)        │
       │   │ ─────────────────────────────── │
       │   │ 赛事全称 [华罗庚金杯少年数学...]│
       │   │ 快捷选择 [华杯｜红棉｜...]      │
       │   │ 科目    [数学▾]                  │
       │   │ 主办方  [华罗庚金杯组委会]        │
       │   │ 级别    [国家级▾]                │
       │   │ 等级    [二等奖]                 │
       │   │ 时间    [2025-06]                │
       │   │ 补充    [决赛二等奖]             │
       │   │ ─────────────────────────────── │
       │   │ 原始文本：[折叠面板]             │
       │   │ [重新识别]   [取消]   [确认导入] │
       │   └──────────────────────────────────┘
       ├─ 字段标红（confidence='low' 时）
       └─ 确认导入 → 自动创建新 award 条目，证书图片挂到 cert_images
```

**批量识别**：获奖卡片头部加「一键识别全部证书」按钮——遍历该学生所有 `awards.cert_images`，批量提交 OCR，最后生成 N 个识别草稿逐个确认（避免一次性弹 N 个 modal 压垮家长）。

**非证书图片降级**：OCR 返回 `confidence='low'` 或 `name=''` 时，弹窗只显示「这张图识别不出证书信息，已保存为附件」+ 「仍然添加为证书照片」选项，**不会**写入空字段。

### 13.7 API 详细规范

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/me/ocr/award` | 单证书识别（multipart `file` 或 JSON `{attachment_id}`） |
| POST | `/api/me/ocr/award/batch` | 批量：`{attachment_ids: ["a001","a002"]}`，并发 ≤ 3，返回数组 |
| DELETE | `/api/me/ocr/cache/:attachment_id` | 清除某张证书的 OCR 缓存（强制重新识别） |

**鉴权**：家长端 Bearer invite_token（同其他 /api/me/*）。
**限额**：单学生每分钟 ≤ 10 次 OCR（防滥用 + 防 token 暴增）。
**错误码**：`OCR_PROVIDER_DOWN`（外部 LLM 503）、`OCR_RATE_LIMIT`（429）、`OCR_INVALID_IMAGE`（400，非图片/损坏）、`OCR_NO_RESULT`（200 但 fields 全空，前端走降级路径）。

### 13.8 部署 / 配置

**wrangler.toml 新增**：

```toml
[ai]
binding = "AI"                       # Workers AI 默认绑定名

# 可选：外部 OCR 服务（不配走 Workers AI）
# wrangler secret put EXTERNAL_OCR_PROVIDER   # 'openai'|'google'|'qwen'
# wrangler secret put EXTERNAL_OCR_API_KEY
# wrangler secret put EXTERNAL_OCR_MODEL      # 'gpt-4o'|'gemini-2.5-pro'|'qwen-vl-max'
```

**模型选型默认值**（无 secret 时走 Workers AI）：
- 默认：`@cf/google/gemma-3-12b-it`（12B，中文版面理解中等，延迟 ~5s）
- 高精：环境变量切 `@cf/meta/llama-3.2-90b-vision-instruct`（90B，更慢但更准），需 Workers AI 付费档

**密钥管理**：
- 所有外部 LLM key 走 `wrangler secret put`，不入 wrangler.toml 不入前端
- 前端永远不直接接触 OCR 提供方——统一走 Workers 中转，便于审计/限流/降级

### 13.9 成本估算

**单张证书识别成本**（图片平均 1MB，OCR prompt ~800 tokens input + ~300 tokens output）：
- Workers AI Gemma-3-12b：~$0.0003/张（按 token 计费）→ 几乎免费
- OpenAI GPT-4o：~$0.01/张 → ¥0.07
- Google Gemini 2.5 Pro：~$0.005/张 → ¥0.035
- 阿里 Qwen-VL-Max：~¥0.01/张

**典型使用场景**：每学生 5 张获奖证书 = ¥0.035–0.35/学生；缓存命中后 0 成本。按 100 学生/月计 ≈ ¥3.5–35/月，可忽略。**OCR 自动化的 ROI 极高**（替家长省 5–10 分钟/学生 × 100 = 8–16 小时人工）。

### 13.10 已知限制

| 限制 | 场景 | 后续方案 |
|------|------|---------|
| Workers AI 中文精度中等 | 非常规版式证书（手写体、PS 过、模糊） | 家长点「重新识别」走外部 LLM 路径 |
| 外部 LLM 延迟 3–8s | 家长等待 | 前端骨架屏 + 「AI 识别中…预计 5 秒」提示 |
| OCR 缓存有效期 30 天 | 模型/字典升级 | 后台 cron 清理过期缓存；下次识别自动用新模型 |
| 一次性处理 ≥ 50 张证书 | 大量获奖 | 批量接口并发限速 3，避免触发 Workers subrequest 上限 |
