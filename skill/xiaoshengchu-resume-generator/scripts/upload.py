#!/usr/bin/env python3
"""上传学生目录下已生成的 resume.pdf 回收集系统。

用法: python scripts/upload.py <student_dir>
输出: stdout 一行 JSON {"ok": true, "resume_id": "...", "material_version": N}
"""
import json
import sys
import time
from pathlib import Path

import requests

SKILL_DIR = Path(__file__).resolve().parent.parent


def load_config():
    cfg_path = SKILL_DIR / "config.json"
    if not cfg_path.exists():
        print(json.dumps({"ok": False, "error": "config.json 不存在，请先配置"}, ensure_ascii=False))
        sys.exit(1)
    return json.loads(cfg_path.read_text(encoding="utf-8"))


def upload_once(base: str, api_key: str, student_id: str, batch_no: str, pdf_path: Path, essay: str = ""):
    with open(pdf_path, "rb") as f:
        return requests.post(
            f"{base}/api/ai/resumes",
            headers={"X-API-Key": api_key},
            data={"student_id": student_id, "batch_no": batch_no, "essay": essay},
            files={"file": (pdf_path.name, f, "application/pdf")},
            timeout=120,
        )


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "用法: python scripts/upload.py <student_dir>"}, ensure_ascii=False))
        sys.exit(1)

    student_dir = Path(sys.argv[1]).resolve()
    profile_path = student_dir / "profile.json"
    pdf_path = student_dir / "resume.pdf"
    if not profile_path.exists() or not pdf_path.exists():
        print(json.dumps({"ok": False, "error": f"缺少 profile.json 或 resume.pdf: {student_dir}"}, ensure_ascii=False))
        sys.exit(1)

    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    student_id = profile.get("student_id") or student_dir.name
    batch_no = (profile.get("meta") or {}).get("batch_no") or ""

    # 自荐信原文一并回传（存 resumes.essay_text，退回修改时作为修订底稿）
    essay = ""
    md_path = student_dir / "self_recommendation.md"
    if md_path.exists():
        essay = md_path.read_text(encoding="utf-8").strip()

    cfg = load_config()
    base = cfg["api_base"].rstrip("/")

    resp = upload_once(base, cfg["api_key"], student_id, batch_no, pdf_path, essay)
    if resp.status_code >= 500:
        time.sleep(3)
        resp = upload_once(base, cfg["api_key"], student_id, batch_no, pdf_path, essay)

    try:
        payload = resp.json()
    except ValueError:
        payload = {"ok": False, "error": f"HTTP {resp.status_code}: {resp.text[:200]}"}

    if resp.status_code == 200 and payload.get("ok"):
        data = payload.get("data") or {}
        print(json.dumps({
            "ok": True,
            "resume_id": data.get("resume_id"),
            "student_id": student_id,
            "material_version": data.get("material_version"),
        }, ensure_ascii=False))
    else:
        print(json.dumps({"ok": False, "student_id": student_id, "error": payload}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
