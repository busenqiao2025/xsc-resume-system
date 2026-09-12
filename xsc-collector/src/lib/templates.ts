// 简历模板目录（唯一来源）。预览图与示例 PDF 为静态资源，路径相对站点根。
export interface TemplateInfo {
  id: string;
  name: string;
  desc: string;
  preview_img: string;   // 缩略预览图
  sample_pdf: string;    // 完整示例 PDF
}

export const TEMPLATES: TemplateInfo[] = [
  {
    id: "classic-blue",
    name: "经典蓝",
    desc: "深蓝主色调，正式稳重，适合科创/数理见长的学生",
    preview_img: "/templates/classic-blue.png",
    sample_pdf: "/templates/classic-blue-sample.pdf",
  },
  {
    id: "warm-elegant",
    name: "暖雅",
    desc: "暖色雅致，适合突出艺术、人文特长的学生",
    preview_img: "/templates/warm-elegant.png",
    sample_pdf: "/templates/warm-elegant-sample.pdf",
  },
];

export const TEMPLATE_IDS = TEMPLATES.map((t) => t.id);

export function isTemplateId(id: string): boolean {
  return TEMPLATE_IDS.includes(id);
}
