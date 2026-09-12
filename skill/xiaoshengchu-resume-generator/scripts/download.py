#!/usr/bin/env python3
"""下载待生成学生材料 zip 并解压。

用法: python scripts/download.py [--workspace PATH]
输出: stdout 一行 JSON {"batch_no": "...", "count": N, "students": [...], "empty": false}
"""
import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

import requests

SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_WORKSPACE = SKILL_DIR / "workspace"


def load_config():
    cfg_path = SKILL_DIR / "config.json"
    if not cfg_path.exists():
        print(json.dumps({
            "ok": False,
            "error": "config.json 不存在，请复制 config.example.json 为 config.json 并填写 api_base / api_key",
        }, ensure_ascii=False))
        sys.exit(1)
    return json.loads(cfg_path.read_text(encoding="utf-8"))


def safe_extract(zf: zipfile.ZipFile, dest: Path):
    """解压并校验成员路径，防路径穿越。"""
    dest.mkdir(parents=True, exist_ok=True)
    for info in zf.infolist():
        name = info.filename
        if name.startswith("/") or ".." in Path(name).parts or (info.external_attr >> 16) & 0o170000 == 0o120000:
            continue
        target = (dest / name).resolve()
        if not str(target).startswith(str(dest.resolve())):
            continue
        zf.extract(info, dest)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", default=str(DEFAULT_WORKSPACE))
    args = parser.parse_args()

    cfg = load_config()
    base = cfg["api_base"].rstrip("/")
    headers = {"X-API-Key": cfg["api_key"]}

    resp = requests.get(f"{base}/api/ai/export", headers=headers, stream=True, timeout=600)
    if resp.status_code == 204:
        print(json.dumps({"ok": True, "empty": True, "count": 0, "students": []}, ensure_ascii=False))
        return
    resp.raise_for_status()
    if resp.headers.get("Content-Type", "").find("zip") == -1:
        print(json.dumps({"ok": False, "error": f"非 zip 响应: {resp.status_code} {resp.text[:200]}"}, ensure_ascii=False))
        sys.exit(1)

    batch_no = resp.headers.get("X-Batch-No") or re.search(r'filename="?([^";]+)', resp.headers.get("Content-Disposition", "")).group(1).removesuffix(".zip")
    workspace = Path(args.workspace)
    workspace.mkdir(parents=True, exist_ok=True)
    zip_path = workspace / f"{batch_no}.zip"
    with open(zip_path, "wb") as f:
        for chunk in resp.iter_content(1024 * 1024):
            f.write(chunk)

    batch_dir = workspace / batch_no
    if batch_dir.exists():
        print(json.dumps({"ok": False, "error": f"批次目录已存在: {batch_dir}，请先处理或清理"}, ensure_ascii=False))
        sys.exit(1)
    with zipfile.ZipFile(zip_path) as zf:
        safe_extract(zf, batch_dir)

    students = []
    for d in sorted(batch_dir.iterdir()):
        if not d.is_dir() or not (d / "profile.json").exists():
            continue
        try:
            profile = json.loads((d / "profile.json").read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            students.append({"student_id": d.name, "name": "?", "dir": str(d), "profile_error": str(e)})
            continue
        students.append({
            "student_id": profile.get("student_id", d.name),
            "name": profile.get("name", d.name),
            "dir": str(d),
        })

    print(json.dumps({
        "ok": True,
        "empty": len(students) == 0,
        "batch_no": batch_no,
        "count": len(students),
        "students": students,
        "zip": str(zip_path),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
