---
name: xiaoshengchu-resume-generator
description: 小升初简历批量生成工作流。当需要为已收集材料的学生生成小升初简历 PDF 时使用。自动从收集系统 API 下载待生成学生的材料 zip 包，逐学生撰写自荐信并用 HTML 模板渲染成单页连贯长卷 PDF（不是分页 PDF），最后自动上传回收集系统。触发词：生成小升初简历、批量生成简历、生成简历、处理待生成学生。
---

# 小升初简历生成 Skill

为「小升初简历材料收集系统」（Cloudflare Workers）的待生成学生批量生产简历 PDF。完整工作流：**下载材料 → 逐学生撰写自荐信 → 渲染单页连贯 PDF → 上传回传 → 汇报**。

**重要：这是小升初简历，不是求职简历，且城市口径不同。** 内容围绕：基本信息、家庭成员、核心学期学业成绩、获奖（含竞赛/杯碗）、兴趣特长、成长作品、自荐信。绝不出现工作经历、职业技能、求职意向等字段。**每个学生的 profile.json 带 `city` 对象（核心学期、写作要点 essay_tips 以它为准）**——广州五下六上+杯碗、上海五四学制+思维100/小托福、北京迎春杯/红领巾奖章，写作前先读 city，不要拿广州口径套其他城市。

**目标学校与家长寄语不进简历。** `target_schools` 和 `family_note` 是给工作人员看的内部数据（了解家庭意向、写作参考），模板已不渲染这两个板块，也**绝不许把「目标学校」「家长寄语」作为标题或段落写进简历正文**。它们仅作为写作上下文：家长寄语可用来理解孩子的家庭氛围；目标学校仅当**只有一所且 reason 明确**时才可在自荐信结尾自然提及向往原因，多所或不明确时写通用的「期待进入适合我的中学」收尾，不点名（简历可能一稿多投）。

**关键输出要求：PDF 必须是「单页连贯长卷」**——固定 A4 宽度（210mm）、高度随内容自适应的一个超长页面，整份简历从头到尾连续流动，没有分页断点、没有页眉页脚割裂。

## 两种工作模式

- **批处理模式（默认）**：从收集系统 API 下载待生成学生 → 逐学生生成 → 上传回传。见「批处理工作流」。
- **直连模式（不走 API）**：用户在对话里把某个孩子的材料一股脑发过来（文字、图片、证书、成绩截图等），要求直接生成或修改简历。见「直连模式工作流」。

## 环境配置（首次使用必读）

### 1. 配置 API

复制 `config.example.json` 为 `config.json`（本 skill 目录下），填写：

```json
{
  "api_base": "https://你的收集系统.workers.dev",
  "api_key": "AI_API_KEY（收集系统的 wrangler secret）"
}
```

`config.json` 含密钥，**不得提交到 git**。

### 2. 依赖安装（幂等，每次运行前检查）

```bash
cd <skill目录>
pip install -r requirements.txt
playwright install chromium
```

### 3. 中文字体检查（缺失会导致 PDF 全是方块）

```bash
fc-list :lang=zh | head -3
```

无输出则安装（Debian/Ubuntu）：

```bash
sudo apt-get update && sudo apt-get install -y fonts-noto-cjk
```

macOS 自带 PingFang SC，无需处理。

## 批处理工作流

被调用时（无论手动还是定时自动执行），严格按以下顺序执行：

### 第 1 步：下载待生成材料

```bash
python scripts/download.py
```

- 脚本会调用 `GET {api_base}/api/ai/export`，把所有待导出学生打成一个 zip 下载并解压到 `workspace/{batch_no}/`。
- **stdout 输出一行 JSON**：`{"batch_no": "B20260906-001", "count": 3, "students": [{"student_id": "S0007", "name": "张小明", "dir": "workspace/B20260906-001/S0007"}], "empty": false}`
- 若 `"empty": true` 表示当前没有待生成学生，直接结束并汇报「无待生成学生」。
- 已导出过的学生不会重复出现在 zip 中（服务端按材料版本去重），下载天然幂等。

### 第 2 步：逐学生处理（对每个学生目录依次执行）

**2a. 阅读材料**

读取 `{dir}/profile.json`（结构见下节），全面掌握学生情况。

**2b. 特点挖掘（先画像，再动笔）**

写自荐信之前，先把孩子的材料吃透，挖掘出**这个孩子独有的特点**——这是简历的灵魂，绝不能写成「品学兼优、全面发展」的套话模板。把分析结果写入 `{dir}/traits.md`（内部工作稿，不上传）：

- **1～3 个核心特点**：从材料里找「人无我有、人有我强」的点。例如：数学竞赛连年进阶（华杯→红棉）、科创作品有完整工程链路、乐器十年坚持、体育竞技与学业双优、阅读量远超同龄……每个特点必须能在 profile.json 里找到**证据锚点**（具体奖项/作品/年限/数据）。
- **一个叙事主线**：这些特点串起来说明这是个什么样的孩子（如「理工脑+动手派」「自律的长期主义者」），自荐信围绕主线展开。
- **详略分配**：T1/T2 奖项、核心特点展开写；与主线无关的普通荣誉只在获奖列表呈现，不进自荐信。

判空：如果材料实在单薄（无奖项无特点素材），在 traits.md 如实记录「材料单薄」并在汇报中标注，不要硬编特点。

**2c. 撰写自荐信（AI 的核心增值环节）**

基于 traits.md 的主线 + `essay_material` 素材写一封自荐信，写入 `{dir}/self_recommendation.md`：

写作铁律：
- **围绕特点写，不堆清单**：自荐信 = 特点主线 + 证据故事，不是获奖列表的复读。每个孩子读起来必须「就是这个人」，换个人名套不进去。写完自查：把名字遮掉，这段话能不能安到任何一个「好学生」身上？能，就重写。
- **先读 `profile.city`**：核心学期表述、竞赛分量判断、加分项侧重全部按学生所属城市的 essay_tips 来（profile 内置，权威），不要套其他城市的口径。
- **绝对不编造事实**：素材里没有的奖项、成绩、经历一律不写。所有荣誉必须能在 profile.json 的 awards/grades 里找到出处。特点可以提炼，事实不能发明。
- 小学六年级学生口吻（上海学生是五年级毕业，口吻按实际年级），真诚自然，禁用浮夸辞藻与 AI 腔（"在未来的学习生活中我将…""山高水长"之类）。
- **奖项用正式全称**：简历读者是学校老师，写「华罗庚金杯少年数学邀请赛二等奖」而非「华二」「花二」等黑话；学期写「五年级下学期」「四年级第二学期」（按城市学制）。
- **分量判断参考 cup_tier**：T1/T2 奖项值得在自荐信中展开一两句（考了什么、体现了什么能力）；T4 线上水杯不写进自荐信，列表里有即可。
- 结构：开场自我介绍 → 性格与学习习惯 → 核心特点与代表性成果（引用真实奖项，写明奖项级别与名称）→ 结尾向往（按前文「目标学校」规则处理点名问题）→ 简短致谢收尾。
- 400～600 字，4～5 个自然段。
- **纯文本段落，不使用任何 Markdown 符号**（渲染器按段落处理，`#`、`*` 等符号会原样出现在简历上）。

**2c-r. 修订模式：profile.json 带 `revision` 字段时**

说明这份简历被工作人员「退回修改」过。此时**不是重写一篇，而是在原有简历基础上修订**：

- `revision.note`：工作人员的修改意见。**逐条对照落实**，每条意见都要在修订结果里有回应（改了什么，或为什么材料不支持改）。
- `revision.previous_essay`：上一版自荐信原文。以它为底稿修订——意见没点名的问题（结构、口吻、事实）保持原有水平，不要顺手推翻重写。
- `revision.files`：佐证文件（zip 内 `revision/` 目录下，图片/PDF）。逐个打开看，里面可能有新证书、成绩单截图、参考样例——把其中的新事实吸收进材料和自荐信（新奖项补进 profile.json 的 awards 并保存）。
- 家长端材料若同时有更新（材料版本推进），新旧变化一并融合：以最新 profile.json 为准，修改意见作为质量要求叠加。
- 修订后的自荐信同样写入 `{dir}/self_recommendation.md` 覆盖旧稿，traits.md 同步更新。

**2d. 渲染 PDF**

```bash
python scripts/render.py {dir}
# 可选：--template warm-elegant 指定模板（默认取 profile.json 的 meta.template_id，再默认 classic-blue）
```

- 脚本用 Jinja2 渲染 `templates/{模板}/template.html`，输出 `{dir}/resume.html` 与 `{dir}/resume.pdf`。
- 若 `self_recommendation.md` 不存在，脚本用 essay_material 素材自动拼接一版兜底自荐信（Agent 模式下应总是先完成 2b，此为保险）。
- 单页连贯 PDF 的实现：视口固定 794px 宽渲染 HTML，测量全文高度后以 `page.pdf(width=210mm, height=计算高度)` 一次性输出，无任何分页。
- **渲染后必须自查**：打开生成的 `resume.html` 确认图片路径全部有效、照片正常显示。脚本会在 stdout 输出 `{"ok": true, "pdf": "…/resume.pdf", "height_px": 4820, "missing_images": []}`；若 `missing_images` 非空，说明 profile.json 引用了 zip 里不存在的附件，检查后重试。

**2e. 上传回传**

```bash
python scripts/upload.py {dir}
```

- 读取 `{dir}/resume.pdf` + profile.json 的 `student_id` 与 `meta.batch_no`，POST 到收集系统。
- 成功输出 `{"ok": true, "resume_id": "r0000001", "material_version": 4}`。
- 上传后简历进入「待审核」状态：由老师在管理端人工审核通过后才对家长可见，本 Skill 不需要也不能代替审核。
- **退回修改循环**：若老师在管理端「退回修改」某份简历（写了修改意见、可能附佐证文件），该学生自动回到待导出队列，下次导出的 profile.json 会带 `revision` 字段（意见 + 上一版自荐信 + 佐证文件）——按 **2c-r 修订模式**处理，不是简单重跑。
- 上传失败（网络/500）时重试一次；仍失败则记录，继续处理下一个学生，最后汇总。

### 第 3 步：汇报

全部学生处理完后，输出汇总报告：

```
批次 B20260906-001 处理完成：共 3 名学生
成功 3：S0007 张小明（v4）、S0012 李小红（v2）、S0018 王小刚（v1）
失败 0
（如有失败）失败 1：S0020 陈小明 — 原因：自荐信素材为空且获奖数据缺失，已跳过
```

失败学生的目录保留在 workspace 中供人工处理，不影响已成功上传的学生。

## 直连模式工作流（不走 API）

用户在对话里直接把某个孩子的材料发过来（文字描述、成绩截图、证书照片、作品图片等），要求生成或修改简历。此时**不需要也不能调用收集系统 API**，全流程本地完成：

### 第 1 步：建工作目录

`workspace/direct-{YYYYMMDD}-{学生姓名拼音或姓氏}/`，保存用户发来的图片/文件到该目录的 `attachments/` 子目录（规范命名：photo.jpg、cert-huabei-2026.jpg 等）。

### 第 2 步：整理材料为 profile.json

按「profile.json 结构速查」手工组装。要点：

- **city 必须确定**：从材料推断（学校名、学制、提到的杯赛）或直接问用户。确定后按本 Skill「各城市小升初领域知识」填写 city 对象（code/name/schooling/core_semesters/essay_tips 照抄对应城市口径）。
- **材料转结构化**：文字描述里的奖项逐条拆进 awards（名称用正式全称、判断 cup_tier）；成绩进 grades（标 is_core）；特长/作品同理。证书照片路径写进对应条目的 cert_images。
- **材料不清晰就问用户**，不要猜着写：奖项等级不明、学期成绩缺失、没有照片、城市不明、素材笼统（「孩子挺优秀的」）——这些都是必须提问的点。提问要具体（「华杯是一等还是二等？哪一年？」），一次问完，不要挤牙膏。
- `meta` 填 `{ "batch_no": "direct", "material_version": 1, "template_id": "classic-blue" }`（用户指定模板则用指定的）。

### 第 3 步：特点挖掘 + 自荐信

同批处理模式的 2b / 2c（traits.md → self_recommendation.md）。直连模式材料往往更散，特点挖掘更要下功夫：从只言片语里找线索（「拿过信息学奖」「一直坚持游泳」），找不到够分量的特点就向用户追问。

### 第 4 步：渲染 + 交付

`python scripts/render.py {dir}` 渲染后，**直接把 resume.pdf 交付给用户**（present_files），并附上你提炼的特点主线说明，方便用户判断「像不像这个孩子」。不上传任何系统。

### 直连模式的修改

用户对生成的简历不满意、直接给修改意见（或补发新材料）时：在原目录上修订——意见逐条落实，新材料并进 profile.json，更新 traits.md 与 self_recommendation.md，重新渲染交付。保留每轮意见与修订要点在 traits.md 末尾的「修订记录」里，多轮修改不丢上下文。

## profile.json 结构速查

```
student_id / name
city: { code, name, schooling, core_semesters[], essay_tips[] }   # 城市上下文，写作以 essay_tips 为准
basic: { gender, birth_date, primary_school, hukou_district, photo }
contacts: [ { relation, name, work_unit, title, phone } ]
grades: [ { semester, is_core, chinese, math, english, total, level, remark } ]
awards: [ { name, cup_short, cup_tier(T1-T4|空), subject, org, level, rank, date, description, cert_images[] } ]
talents: [ { category, title, description, years, cert_images[] } ]
works: [ { title, description, images[], link } ]
target_schools: [ { name, reason } ]        # 内部数据，不渲染，仅写作上下文
essay_material: { personality, study_habits, interests, highlights }
family_note                                  # 内部数据，不渲染，仅写作上下文
revision: { note, previous_essay, files[] }  # 可选。退回修改时由服务端注入，触发 2c-r 修订模式
meta: { batch_no, material_version, exported_at, template_id }
```

`photo`、`cert_images`、`images` 的值均为 zip 内相对路径（如 `attachments/a0001.jpg`），HTML 模板直接 `<img src>` 引用。

`meta.material_version` 是**家长点击「提交材料」确认的快照版本**（v1.3 起材料写操作不再推进版本，只有提交才推进）；服务端导出按 `exported_version < material_version` 去重的逻辑不变。

`grades.semester` 枚举与核心学期**由城市决定**（广州：五上~六下，核心五下/六上；上海五四学制：四上~五下，核心四下/五上/五下）。`is_core` 与 `cup_tier` 由收集系统按城市配置写入——渲染排序直接消费，**本 Skill 不内置城市规则**。渲染时脚本自动按时间顺序排序学期并转正式学期名，`is_core` 的行加粗。

`awards` 按梯队自动排序（T1 最前 → T4 → 非竞赛荣誉最后，同级内按日期倒序）。

## 各城市小升初领域知识（背景理解，写作细节以 profile.city.essay_tips 为准）

### 广州（六三学制）

- **成绩口径**：**五下六上**（五年级下+六年级上期末成绩）是学校筛选生源的首要参考；六下是公办初中分班依据。黑话「285/290/295」指三科总分（满分 300）。
- **杯碗梯队**（华杯 > 红棉 > 希望杯 > 线上水杯）：华杯（HB，T1）圈内硬通货；红棉（HM，T2）前身五羊杯、广州本土、与华杯同组委会；希望杯（XWB，T3）基数大区分度一般；YMO/WMO（T4）线上水杯基本不当加分项；PET（T1）/KET（T2）英语凭证。
- **黑话**：花衣花儿/花一花二=杯赛一/二等奖（名校敲门砖）；业主=目标学校；豪门=顶尖名校；上岸=被录取；ZDB/KB=重点班/课改班；HF/SS/GZ/EZ/TY/LZ=华附/省实/广雅/二中/铁一/六中。
- 素材中「考了292」「班里前三」等口语对应转为「三科总分292」「成绩位列班级前三」。

### 北京（六三学制）

- **成绩口径**：校内优秀线低年级 297+、高年级 295+（三科总分）；核心同样看五下六上。
- **竞赛体系**：迎春杯（T1，北京本土权威，小高组 5-6 年级）、华数（T1）、美国数学大联盟（T2，全英文）、KET/PET/FCE（英语主线，PET=B1、FCE=B2）、朗思（T2，剑桥系替代）、叶圣陶杯（T2，语文）、**红领巾奖章（T1，北京特色重头证书，星级越高分量越大）**；大队委/班干部经历是特色加分项。

### 上海（五四学制，小学五年初中四年）

- **成绩口径**：无六年级，核心看**四下~五下**；《上海市学生成长记录册》（成长手册）评价全优是名校硬门槛，填在 grades 的 level 字段。
- **三公**：上实/上外附中/浦外，网申+面谈模式，简历即面单材料；小托福≥850、AMC8 前5%/21+分有竞争力。
- **竞赛体系**：思维100（T1，前身中环杯，上海奥数先驱，市二等奖以上被誉为名校通行证）、小机灵（T2）、AMC8（T1）、小托福（T1）、PET（T1）。
- **表述**：「四年级第二学期」「五年级」，不用「六上」等六年级说法。
- **获奖排序惯例**：按级别 国家>省市>区县>学校；按学科 数学>英语>科创>语文。

### 深圳（六三学制）

- 口径同广州（五下六上），目标校常见深中/深实验/深外/高级；字典待运营校准，以 profile 内数据为准。

### 通用合规红线

MK（密考）、DZ（点招）属教育主管部门明令禁止的行为——简历中不得出现任何密考、点招相关表述，奖项全部以正式赛事名称呈现。

## 模板说明

- `templates/classic-blue/`：经典蓝，深蓝主色调，正式稳重，默认模板。
- `templates/warm-elegant/`：暖色雅致，适合突出艺术特长的学生。
- 模板以 CSS 自定义属性集中管理配色，换肤 = 复制目录改 `:root` 变量。
- 学生级模板选择：**由家长在收集页自行挑选**（管理端创建学生时给默认值 classic-blue），导出时写入 `meta.template_id`；家长更换模板后学生会重新进入待导出队列，用新模板再生成即可。

## 目录约定

```
skill 目录/
├── SKILL.md
├── config.json               # 本地配置（gitignore）
├── requirements.txt
├── scripts/{download,render,upload}.py
├── templates/{classic-blue,warm-elegant}/template.html
└── workspace/                # 运行时工作区（gitignore）
    └── {batch_no}/
        └── {student_id}/     # profile.json + attachments/ + traits.md + self_recommendation.md
                              # + revision/（退回修改佐证文件，如有）+ resume.html + resume.pdf
```

## 注意事项

- 空材料容错：学生可能只填了部分板块（如没有 works），模板对每个板块做空判断，缺失板块整节隐藏，不要在简历上留空白区块。
- 重跑安全：同一学生重复渲染覆盖 `{dir}/resume.pdf`；重复上传会在服务端产生新的简历版本（无害）。
- 证书图片方向异常（EXIF 旋转）时，模板 CSS 已用 `image-orientation: from-image` 修正。
