#!/usr/bin/env python3
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
        print("usage: python_filter_sidecar.py <input.json> <output.json>", file=sys.stderr)
        return 2

    output_path = sys.argv[2]
    try:
        from core_logic import deterministic_filter_pipeline

        payload = load_payload(sys.argv[1])
        reference_script = str(payload.get("reference_script") or "")
        transcript_text = str(payload.get("transcript_text") or "")
        session_file = str(payload.get("session_file") or PROJECT_ROOT / "temp_uploads" / "session_segments.json")
        # Take người dùng đã tự chọn ở màn rà soát: {chỉ số câu: chỉ số take}.
        pinned_takes = {
            int(key): int(value)
            for key, value in (payload.get("pinned_takes") or {}).items()
        }

        emit_progress("Đang chạy thuật toán so khớp Python reference...")
        result = deterministic_filter_pipeline(
            reference_script=reference_script,
            transcript_text=transcript_text,
            session_file=session_file,
            pinned_takes=pinned_takes or None,
        )
        write_output(output_path, {
            "status": "success",
            "matching_engine": "python_reference",
            **result,
        })
        print(json.dumps({"type": "result", "message": "python filter complete", "path": output_path}, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:
        write_output(output_path, {"status": "error", "detail": str(exc)})
        print(json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
