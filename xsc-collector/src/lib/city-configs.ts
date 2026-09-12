// 城市配置 CITY_CONFIGS（architecture.md 3.3 节，唯一的城市知识源）
// 城市差异只存在于这一层：表结构、API 形状、状态机、版本机制全部城市无关。
// 新增城市 = 新增一个配置对象 + 运营补字典，其他零改动。

export interface CupItem {
  short: string;    // 圈内简称
  name: string;     // 正式全称（简历成品只用它）
  subject: string;  // 数学|英语|科创|信息学|语文|艺术|体育|综合
  tier: "T1" | "T2" | "T3" | "T4" | "";
  note?: string;
}

export interface JargonItem {
  term: string;
  meaning: string;
}

export interface CityConfig {
  code: string;               // 'guangzhou'，与 students.city 对应
  name: string;               // '广州'
  schooling: "6-3" | "5-4";   // 学制：六三 / 五四（上海小学五年）
  semesters: string[];        // 可选学期枚举（表单下拉）
  core_semesters: string[];   // 核心学期（表单默认渲染 + 导出 is_core 计算依据）
  score_hint: string;         // 成绩填写提示语
  cups: CupItem[];            // 竞赛字典（快捷下拉 + tier 解析）
  jargon: JargonItem[];       // 黑话速查（表单 tooltip）
  essay_tips: string[];       // 自荐信写作要点（仅导出给 AI，不下发家长端）
}

export const CITY_CONFIGS: Record<string, CityConfig> = {
  guangzhou: {
    code: "guangzhou",
    name: "广州",
    schooling: "6-3",
    semesters: ["五上", "五下", "六上", "六下"],
    core_semesters: ["五下", "六上"],
    score_hint:
      "五下六上是学校筛选生源的首要参考（六下是分班依据）；285/290/295 即三科总分（满分300）。以当年官方政策为准。",
    cups: [
      { short: "华杯", name: "华罗庚金杯少年数学邀请赛", subject: "数学", tier: "T1", note: "圈内公认硬通货，数论计数见长" },
      { short: "红棉", name: "红棉杯青少年数学竞赛", subject: "数学", tier: "T2", note: "前身五羊杯，广州本土，与华杯同组委会，3-7年级另设英语单科奖" },
      { short: "希望杯", name: "希望数学（希望杯）", subject: "数学", tier: "T3", note: "全国性，参与基数大、区分度一般" },
      { short: "迎春杯", name: "数学花园探秘（迎春杯）", subject: "数学", tier: "T2", note: "北方四大杯赛之一，广州部分认可" },
      { short: "走美", name: "走进美妙的数学花园", subject: "数学", tier: "T3" },
      { short: "YMO", name: "YMO青少年数学思维研学活动", subject: "数学", tier: "T4", note: "线上水杯" },
      { short: "WMO", name: "WMO世界数学奥林匹克", subject: "数学", tier: "T4", note: "线上水杯" },
      { short: "AMC8", name: "AMC 8（美国数学竞赛）", subject: "数学", tier: "T2" },
      { short: "澳洲AMC", name: "AMC（澳大利亚数学竞赛）", subject: "数学", tier: "T3" },
      { short: "KET", name: "剑桥英语 KET（A2 Key）", subject: "英语", tier: "T2" },
      { short: "PET", name: "剑桥英语 PET（B1 Preliminary）", subject: "英语", tier: "T1" },
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
  },

  beijing: {
    code: "beijing",
    name: "北京",
    schooling: "6-3",
    semesters: ["五上", "五下", "六上", "六下"],
    core_semesters: ["五下", "六上"],
    score_hint: "校内成绩优秀线：低年级 297+、高年级 295+（三科总分）。以当年官方政策为准。",
    cups: [
      { short: "迎春杯", name: "数学花园探秘（迎春杯）", subject: "数学", tier: "T1", note: "北京本土权威，小高组(5-6年级)" },
      { short: "华数", name: "华罗庚金杯少年数学邀请赛", subject: "数学", tier: "T1" },
      { short: "美国大联盟", name: "美国数学大联盟（Math League）", subject: "数学", tier: "T2", note: "全英文数学竞赛" },
      { short: "希望杯", name: "希望数学（希望杯）", subject: "数学", tier: "T3" },
      { short: "KET", name: "剑桥英语 KET（A2 Key）", subject: "英语", tier: "T2" },
      { short: "PET", name: "剑桥英语 PET（B1 Preliminary）", subject: "英语", tier: "T1" },
      { short: "FCE", name: "剑桥英语 FCE（B2 First）", subject: "英语", tier: "T1" },
      { short: "朗思", name: "朗思国际英语测评（IESOL）", subject: "英语", tier: "T2", note: "剑桥系替代品" },
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
  },

  shanghai: {
    code: "shanghai",
    name: "上海",
    schooling: "5-4",
    semesters: ["四上", "四下", "五上", "五下"], // 小学五年，无六年级
    core_semesters: ["四下", "五上", "五下"],
    score_hint:
      "成长手册评价是核心——四年级起语数英全优是名校门槛；三公网申看五年级综合表现。以当年官方政策为准。",
    cups: [
      { short: "思维100", name: "「思维100」STEM应用能力活动（前身中环杯）", subject: "数学", tier: "T1", note: "上海奥数先驱，市二等奖以上被誉为名校通行证" },
      { short: "小机灵", name: "小机灵杯数学竞赛", subject: "数学", tier: "T2" },
      { short: "AMC8", name: "AMC 8（美国数学竞赛）", subject: "数学", tier: "T1", note: "三公加分项，前5%/21+分有竞争力" },
      { short: "小托福", name: "TOEFL Junior（小托福）", subject: "英语", tier: "T1", note: "三公加分项，≥850分有竞争力" },
      { short: "KET", name: "剑桥英语 KET（A2 Key）", subject: "英语", tier: "T2" },
      { short: "PET", name: "剑桥英语 PET（B1 Preliminary）", subject: "英语", tier: "T1" },
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
  },

  shenzhen: {
    code: "shenzhen",
    name: "深圳",
    schooling: "6-3",
    semesters: ["五上", "五下", "六上", "六下"],
    core_semesters: ["五下", "六上"],
    score_hint: "同广州口径（五下六上），部分名校另看简历+积分。以当年官方政策为准。",
    cups: [
      // 初期复用广州 cups（移除红棉条目），KET/PET/AMC8 保留，待运营校准补充本土赛事
      { short: "华杯", name: "华罗庚金杯少年数学邀请赛", subject: "数学", tier: "T1" },
      { short: "希望杯", name: "希望数学（希望杯）", subject: "数学", tier: "T3" },
      { short: "迎春杯", name: "数学花园探秘（迎春杯）", subject: "数学", tier: "T2" },
      { short: "走美", name: "走进美妙的数学花园", subject: "数学", tier: "T3" },
      { short: "YMO", name: "YMO青少年数学思维研学活动", subject: "数学", tier: "T4", note: "线上水杯" },
      { short: "WMO", name: "WMO世界数学奥林匹克", subject: "数学", tier: "T4", note: "线上水杯" },
      { short: "AMC8", name: "AMC 8（美国数学竞赛）", subject: "数学", tier: "T2" },
      { short: "澳洲AMC", name: "AMC（澳大利亚数学竞赛）", subject: "数学", tier: "T3" },
      { short: "KET", name: "剑桥英语 KET（A2 Key）", subject: "英语", tier: "T2" },
      { short: "PET", name: "剑桥英语 PET（B1 Preliminary）", subject: "英语", tier: "T1" },
    ],
    jargon: [
      // 待运营补充：SZ 深中 等
      { term: "深中 / 深实验 / 深外 / 高级", meaning: "深圳四大名校常见简称" },
    ],
    essay_tips: ["表述口径同广州；目标校常见深中/深实验/深外/高级"],
  },
};

export function getCityConfig(code: string): CityConfig {
  return CITY_CONFIGS[code] || CITY_CONFIGS.guangzhou;
}

/** 家长端/管理端下发的城市配置（不含 essay_tips，那是给 AI 的） */
export function publicCityConfig(cfg: CityConfig) {
  const { essay_tips, ...rest } = cfg;
  return rest;
}
