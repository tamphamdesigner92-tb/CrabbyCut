#!/usr/bin/env python3
"""Sidecar cho tính năng "Sắp xếp timeline theo kịch bản" (giai đoạn Timeline).

Cùng khuôn với python_filter_sidecar.py (đọc argv[1] JSON, ghi argv[2] JSON, phát
NDJSON tiến độ ra stdout) nhưng gọi align_blocks_to_script thay vì cả pipeline lọc.

KHÁC pipeline lọc ở chỗ KHÔNG cần session_segments.json: dòng từ đi kèm từng block
(sub_segments) do renderer gửi lên mới là sự thật, vì block có thể đã bị người dùng
trim hoặc cắt sau khi chốt timeline.
"""
import json
import math
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def emit_progress(message: str) -> None:
    print(json.dumps({"type": "progress", "message": message}, ensure_ascii=False), flush=True)


def json_safe(value):
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(key): json_safe(nested) for key, nested in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


def load_payload(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_output(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(json_safe(payload), f, ensure_ascii=False, allow_nan=False)


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: python_reorder_sidecar.py <input.json> <output.json>", file=sys.stderr)
        return 2

    output_path = sys.argv[2]
    try:
        from core_logic import align_blocks_to_script

        payload = load_payload(sys.argv[1])
        reference_script = str(payload.get("reference_script") or "")
        blocks = payload.get("blocks") or []

        emit_progress(f"Đang so khớp {len(blocks)} block với kịch bản chuẩn...")
        result = align_blocks_to_script(
            reference_script=reference_script,
            blocks=blocks,
        )
        write_output(output_path, {"status": "success", **result})
        print(json.dumps({"type": "result", "message": "script reorder complete", "path": output_path}, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:
        write_output(output_path, {"status": "error", "detail": str(exc)})
        print(json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
