#!/usr/bin/env python3
"""下载待生成学生材料（按学生拉取模式，v1.10 起替代整批 zip）。

流程：POST /api/ai/export/begin 开启批次 → 逐学生拉 profile.json →
逐个下载被引用附件（R2 流式转发，不受 Workers 内存限制）→ 全部成功后 ack 推进导出版本。

用法: python scripts/download.py [--workspace PATH]
输出: stdout 一行 JSON {"batch_no": "...", "count": N, "students": [...], "empty": false}
"""
import argparse
import json
import sys
import time
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


def get_with_retry(url: str, headers: dict, timeout: int = 300) -> requests.Response:
    """GET，5xx/网络异常重试一次。404 等客户端错误直接返回，由调用方处理。"""
    try:
        resp = requests.get(url, headers=headers, stream=True, timeout=timeout)
    except requests.RequestException:
        time.sleep(2)
        resp = requests.get(url, headers=headers, stream=True, timeout=timeout)
    if resp.status_code >= 500:
        time.sleep(2)
        resp = requests.get(url, headers=headers, stream=True, timeout=timeout)
    return resp


def download_file(url: str, headers: dict, dest: Path) -> tuple[bool, int | None]:
    """流式下载到 dest。返回 (成功与否, HTTP 状态码)。"""
    resp = get_with_retry(url, headers)
    if resp.status_code != 200:
        resp.close()
        return False, resp.status_code
    dest.parent.mkdir(parents=True, exist_ok=True)
    with open(dest, "wb") as f:
        for chunk in resp.iter_content(1024 * 256):
            f.write(chunk)
    return True, 200


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", default=str(DEFAULT_WORKSPACE))
    args = parser.parse_args()

    cfg = load_config()
    base = cfg["api_base"].rstrip("/")
    headers = {"X-API-Key": cfg["api_key"]}

    # 1. 开启批次：快照待导出学生（此时尚不推进 exported_version，等逐学生 ack）
    resp = requests.post(f"{base}/api/ai/export/begin", headers=headers, timeout=60)
    if resp.status_code == 204:
        print(json.dumps({"ok": True, "empty": True, "count": 0, "students": []}, ensure_ascii=False))
        return
    resp.raise_for_status()
    payload = resp.json()
    if not payload.get("ok"):
        print(json.dumps({"ok": False, "error": payload.get("error")}, ensure_ascii=False))
        sys.exit(1)
    batch = payload["data"]
    batch_no = batch["batch_no"]
    exported_at = batch["exported_at"]

    batch_dir = Path(args.workspace) / batch_no
    if batch_dir.exists():
        print(json.dumps({"ok": False, "error": f"批次目录已存在: {batch_dir}，请先处理或清理"}, ensure_ascii=False))
        sys.exit(1)
    batch_dir.mkdir(parents=True)

    # 2. 逐学生拉取 profile + 被引用附件
    students = []
    failed = []
    for s in batch["students"]:
        sid = s["id"]
        student_dir = batch_dir / sid
        try:
            # batch_no / exported_at 透传给服务端写进 profile 的 meta
            resp = get_with_retry(
                f"{base}/api/ai/students/{sid}/profile?batch_no={batch_no}&exported_at={exported_at}",
                headers=headers, timeout=60,
            )
            if resp.status_code != 200:
                raise RuntimeError(f"profile HTTP {resp.status_code}: {resp.text[:200]}")
            data = resp.json()["data"]
            referenced = data.pop("attachments", [])  # 服务端回传的被引用附件清单，不进 profile.json
            revision_files = ((data.get("revision") or {}).get("files")) or []

            student_dir.mkdir(parents=True, exist_ok=True)
            (student_dir / "profile.json").write_text(
                json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
            )

            missing = []
            for att in referenced:
                ok_, status = download_file(
                    f"{base}/api/ai/attachments/{att['id']}", headers, student_dir / att["path"]
                )
                if not ok_:
                    if status == 404:
                        missing.append(att["path"])  # 附件丢失不阻断，渲染阶段会剔除并报告
                    else:
                        raise RuntimeError(f"附件 {att['id']} HTTP {status}")
            for rf in revision_files:
                ok_, status = download_file(
                    f"{base}/api/ai/revision-files/{rf['id']}", headers, student_dir / rf["path"]
                )
                if not ok_ and status != 404:
                    raise RuntimeError(f"佐证文件 {rf['id']} HTTP {status}")

            # 3. 全部下载完成后 ack，服务端推进 exported_version
            ack = requests.post(
                f"{base}/api/ai/export/{sid}/ack",
                headers={**headers, "Content-Type": "application/json"},
                json={"batch_no": batch_no},
                timeout=30,
            )
            ack_payload = ack.json() if ack.headers.get("Content-Type", "").find("json") >= 0 else {}
            stale = bool((ack_payload.get("data") or {}).get("stale"))

            entry = {"student_id": sid, "name": s.get("name") or sid, "dir": str(student_dir)}
            if missing:
                entry["missing_attachments"] = missing
            if stale:
                entry["stale"] = True  # 导出期间家长又改了材料，本批次作废、下批重出
            students.append(entry)
        except Exception as e:
            # 不 ack：该学生留在待导出队列，下个批次重新拉取
            failed.append({"student_id": sid, "name": s.get("name") or sid, "error": str(e)[:300]})

    print(json.dumps({
        "ok": True,
        "empty": len(students) == 0 and len(failed) == 0,
        "batch_no": batch_no,
        "count": len(students),
        "students": students,
        "failed": failed,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
