#!/usr/bin/env python3
"""Dựng bộ dữ liệu vàng cho bài toán so khớp kịch bản (Phase 0).

Nguồn dữ liệu là `asr_cache/` — mỗi lần app bóc băng xong đều ghi lại kết quả
word-level ở đó, kèm khoá cache có đủ đường dẫn nguồn và sha1 của kịch bản. Nhờ
vậy không phải bóc băng lại (mỗi dự án tốn hàng chục phút GPU) mà vẫn có cặp
(kịch bản, transcript) đúng y bản đã chạy thật.

Mỗi case xuất ra tests/fixtures/matching/<case>/:
    script.txt     kịch bản chuẩn người dùng nhập
    segments.json  transcript word-level, ĐÚNG định dạng session_segments.json
    meta.json      nguồn gốc: dự án, file cache, sha1, thống kê
"""
import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CACHE_DIR = PROJECT_ROOT / "asr_cache"
FIXTURE_DIR = PROJECT_ROOT / "tests" / "fixtures" / "matching"
SOURCES_DIR = PROJECT_ROOT.parent / "sources"

# Ghép thư mục nguồn (đọc từ khoá cache) với file kịch bản tương ứng.
# Kịch bản .md đi qua bộ lọc markdown giống hệt static/js/script-markdown.js.
CASE_MAP = {
    "Nanu": ("nanu", "Nanu.txt"),
    "Hato": ("hato", "Hato Baby.txt"),
    "Baby Sun": ("baby_sun", "Baby Sun_Vid 4-T6.txt"),
    "Bap Kids": ("bap_kids", "Bắp Kids_Vid 4-T6.txt"),
    "Nem House.MP4": ("nem_house", "Nem House.txt"),
    "Baby Love - Tap 1": ("baby_love", "Baby Love_Vid 1-T7.md"),
}

_BOLD_RE = re.compile(r"\*\*(.+?)\*\*", re.S)
_NOTE_RE = re.compile(r"\*\*\*(.+?)\*\*\*", re.S)


def sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def read_script(path: Path) -> str:
    """Giữ NGUYÊN XI văn bản đã gửi lên app.

    sha1 của chuỗi này nằm trong khoá cache ASR, nên chỉ cần thêm/bớt một ký tự
    trắng là mất khả năng đối chiếu fixture với đúng lần bóc băng đã chạy. Chỉ
    kịch bản .md mới được xử lý, và xử lý y hệt static/js/script-markdown.js.
    """
    raw = path.read_bytes().decode("utf-8")
    if path.suffix.lower() == ".md":
        raw = _NOTE_RE.sub("", raw)
        raw = _BOLD_RE.sub(r"\1", raw)
    return raw


def project_of(key: dict) -> str:
    sources = key.get("sources") or ([key["source"]] if key.get("source") else [])
    for src in sources:
        path = str((src or {}).get("path", ""))
        if "/sources/" in path:
            return path.split("/sources/", 1)[1].split("/")[0]
    return ""


def load_cache_entries():
    """Với mỗi dự án, lấy bản bóc băng FULL mới nhất."""
    best = {}
    for file in sorted(CACHE_DIR.glob("*.json")):
        try:
            data = json.loads(file.read_text(encoding="utf-8"))
        except Exception:
            continue
        key = data.get("key") or {}
        if key.get("kind") not in (None, "full"):
            continue
        result = data.get("result") or {}
        segments = result.get("segments") or []
        if not segments:
            continue
        project = project_of(key)
        if project not in CASE_MAP:
            continue
        created = str(data.get("created_at", ""))
        if project not in best or created > best[project][0]:
            best[project] = (created, file, data)
    return best


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--clean", action="store_true", help="xoá fixture cũ trước khi dựng")
    args = parser.parse_args()

    if args.clean and FIXTURE_DIR.exists():
        shutil.rmtree(FIXTURE_DIR)
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)

    entries = load_cache_entries()
    if not entries:
        print("Không tìm thấy bản bóc băng nào trong asr_cache/ khớp với CASE_MAP.")
        return 1

    manifest = []
    for project, (created, cache_file, data) in sorted(entries.items()):
        case_id, script_name = CASE_MAP[project]
        script_path = SOURCES_DIR / script_name
        if not script_path.exists():
            print(f"  BỎ QUA {case_id}: thiếu kịch bản {script_path}")
            continue

        key = data["key"]
        segments = data["result"]["segments"]
        script_text = read_script(script_path)

        case_dir = FIXTURE_DIR / case_id
        case_dir.mkdir(parents=True, exist_ok=True)
        (case_dir / "script.txt").write_text(script_text, encoding="utf-8")
        (case_dir / "segments.json").write_text(
            json.dumps(segments, ensure_ascii=False, indent=1), encoding="utf-8"
        )

        duration = max((float(s.get("end", 0.0)) for s in segments), default=0.0)
        word_count = sum(len(s.get("words") or []) for s in segments)
        script_sha = sha1(script_text)
        cached_sha = key.get("reference_script_sha1", "")
        meta = {
            "case_id": case_id,
            "project": project,
            # CHỈ TÊN TỆP, KHÔNG PHẢI ĐƯỜNG DẪN TUYỆT ĐỐI.
            # Fixture được commit vào repo, mà đường dẫn tuyệt đối thì mang theo tên tài
            # khoản và cây thư mục của máy người tạo — thứ không ai muốn công khai. Trường
            # này chỉ để con người đối chiếu, không nơi nào trong mã đọc nó.
            "script_file": script_path.name,
            "script_sha1": script_sha,
            "cached_reference_script_sha1": cached_sha,
            # Khớp sha1 = kịch bản trong fixture ĐÚNG bản đã dùng khi bóc băng.
            # Lệch = kịch bản đã bị sửa trong app trước khi chạy; transcript vẫn
            # dùng được, chỉ khác đôi chỗ ở initial_prompt của Whisper.
            "script_matches_transcribe_run": script_sha == cached_sha,
            "asr": {
                "cache_file": cache_file.name,
                "created_at": created,
                "engine": key.get("engine"),
                "transcribe_mode": key.get("transcribe_mode"),
                "cache_version": key.get("version"),
                "source_count": len(key.get("sources") or []),
            },
            "stats": {
                "segment_count": len(segments),
                "word_count": word_count,
                "duration_sec": round(duration, 2),
                "segments_with_words": sum(1 for s in segments if s.get("words")),
            },
        }
        (case_dir / "meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        manifest.append(meta)
        flag = "" if meta["script_matches_transcribe_run"] else "  (kịch bản lệch bản đã chạy)"
        print(
            f"  {case_id:11s} {len(segments):4d} đoạn  {word_count:5d} từ  "
            f"{duration/60:5.1f} phút{flag}"
        )

    (FIXTURE_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"\nĐã dựng {len(manifest)} case tại {FIXTURE_DIR.relative_to(PROJECT_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
