#!/usr/bin/env python3
"""渲染单个学生目录为单页连贯长卷 PDF。

用法: python scripts/render.py <student_dir> [--template classic-blue]
输出: stdout 一行 JSON {"ok": true, "pdf": "...", "height_px": N, "missing_images": []}
"""
import argparse
import json
import sys
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

SKILL_DIR = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = SKILL_DIR / "templates"
VIEWPORT_WIDTH = 794  # px，约等于 210mm @ 96dpi
PX_PER_MM = 96 / 25.4

SEMESTER_ORDER = {"四上": 0, "四下": 1, "五上": 2, "五下": 3, "六上": 4, "六下": 5}
SEMESTER_FULL = {
    "四上": "四年级上学期",
    "四下": "四年级下学期",
    "五上": "五年级上学期",
    "五下": "五年级下学期",
    "六上": "六年级上学期",
    "六下": "六年级下学期",
}
CUP_TIER_ORDER = {"T1": 1, "T2": 2, "T3": 3, "T4": 4}
DEFAULT_CORE = {"五下", "六上"}  # 数据未携带 is_core / city 时的兜底（六三学制通用口径）


def px_to_mm(px: float) -> float:
    return px / PX_PER_MM


def normalize(profile: dict):
    """成绩按学期时间顺序排序并转正式学期名，is_core 兜底计算；
    奖项按梯队排序（T1 最前、非竞赛荣誉最后），同级内按日期倒序。"""
    core = set((profile.get("city") or {}).get("core_semesters") or DEFAULT_CORE)
    grades = profile.get("grades") or []
    for g in grades:
        # 兼容旧字段 grade_year + term
        if not g.get("semester") and g.get("grade_year") and g.get("term"):
            year = g["grade_year"].replace("年级", "").replace("级", "")
            g["semester"] = year + ("上" if "上" in g["term"] else "下")
        g["semester_full"] = SEMESTER_FULL.get(g.get("semester"), g.get("semester") or "")
        if g.get("is_core") is None:
            g["is_core"] = g.get("semester") in core
        if not g.get("total"):
            scores = [g.get(k) for k in ("chinese", "math", "english")]
            try:
                total = sum(float(s) for s in scores)
                g["total"] = str(int(total)) if total == int(total) else f"{total:g}"
            except (ValueError, TypeError):
                pass
        g["level_display"] = " · ".join(x for x in (g.get("level"), g.get("remark")) if x)
    grades.sort(key=lambda g: SEMESTER_ORDER.get(g.get("semester"), 9))
    profile["grades"] = grades

    awards = profile.get("awards") or []
    awards.sort(key=lambda a: a.get("date") or "", reverse=True)
    awards.sort(key=lambda a: CUP_TIER_ORDER.get(a.get("cup_tier") or "", 9))
    profile["awards"] = awards


def build_essay(profile: dict, student_dir: Path) -> str:
    """优先读 self_recommendation.md；缺失时用素材兜底拼接。"""
    md = student_dir / "self_recommendation.md"
    if md.exists():
        text = md.read_text(encoding="utf-8").strip()
        if text:
            return text
    em = profile.get("essay_material") or {}
    parts = []
    if em.get("personality"):
        parts.append(f"大家好，我叫{profile.get('name', '')}。{em['personality']}")
    if em.get("study_habits"):
        parts.append(em["study_habits"])
    if em.get("interests"):
        parts.append(em["interests"])
    if em.get("highlights"):
        parts.append(em["highlights"])
    return "\n\n".join(parts)


def sanitize(profile: dict, student_dir: Path):
    """剔除指向不存在文件的图片引用，返回缺失清单。"""
    missing = []

    def check(path_str):
        if path_str and not (student_dir / path_str).is_file():
            missing.append(path_str)
            return False
        return bool(path_str)

    basic = profile.get("basic") or {}
    if not check(basic.get("photo")):
        basic["photo"] = None

    for item in profile.get("awards") or []:
        item["cert_images"] = [p for p in (item.get("cert_images") or []) if check(p)]
    for item in profile.get("talents") or []:
        item["cert_images"] = [p for p in (item.get("cert_images") or []) if check(p)]
    for item in profile.get("works") or []:
        item["images"] = [p for p in (item.get("images") or []) if check(p)]
    return missing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("student_dir", type=Path)
    parser.add_argument("--template")
    args = parser.parse_args()

    student_dir = args.student_dir.resolve()
    profile_path = student_dir / "profile.json"
    if not profile_path.exists():
        print(json.dumps({"ok": False, "error": f"未找到 {profile_path}"}, ensure_ascii=False))
        sys.exit(1)
    profile = json.loads(profile_path.read_text(encoding="utf-8"))

    normalize(profile)
    missing = sanitize(profile, student_dir)
    essay = build_essay(profile, student_dir)
    template_id = args.template or (profile.get("meta") or {}).get("template_id") or "classic-blue"
    tpl_dir = TEMPLATES_DIR / template_id
    if not (tpl_dir / "template.html").exists():
        print(json.dumps({"ok": False, "error": f"模板不存在: {tpl_dir}"}, ensure_ascii=False))
        sys.exit(1)

    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES_DIR)),
        autoescape=select_autoescape(["html"]),
    )
    tpl = env.get_template(f"{template_id}/template.html")
    html = tpl.render(
        p=profile,
        essay=essay,
        essay_paragraphs=[para.strip() for para in essay.split("\n\n") if para.strip()],
    )
    html_path = student_dir / "resume.html"
    html_path.write_text(html, encoding="utf-8")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(json.dumps({"ok": False, "error": "playwright 未安装，请执行 pip install -r requirements.txt && playwright install chromium"}, ensure_ascii=False))
        sys.exit(1)

    pdf_path = student_dir / "resume.pdf"
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": VIEWPORT_WIDTH, "height": 1123})
        page.goto(html_path.as_uri())
        page.wait_for_load_state("networkidle")
        page.evaluate("document.fonts.ready")
        height = page.evaluate("document.documentElement.scrollHeight")
        height_mm = px_to_mm(height) + 2  # 余量防底部截断
        page.pdf(
            path=str(pdf_path),
            width="210mm",
            height=f"{height_mm:.1f}mm",
            print_background=True,
            margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
            prefer_css_page_size=False,
        )
        browser.close()

    print(json.dumps({
        "ok": True,
        "pdf": str(pdf_path),
        "html": str(html_path),
        "height_px": height,
        "missing_images": missing,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
