#!/usr/bin/env python3
import json
import math
import os
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def emit_progress(message: str) -> None:
    print(json.dumps({"type": "progress", "message": message}, ensure_ascii=False), flush=True)


def load_payload(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def json_safe(value):
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    return value


def finite_float(value, fallback=0.0):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if math.isfinite(parsed) else fallback


def normalize_word(word, seg_start, seg_end):
    if not isinstance(word, dict):
        return None
    text = str(word.get("word", word.get("text", ""))).strip()
    if not text:
        return None
    start = finite_float(word.get("start", seg_start), seg_start)
    end = finite_float(word.get("end", seg_end), seg_end)
    if end < start:
        end = start
    return {
        "word": text,
        "start": start,
        "end": end,
    }


def normalize_segment(seg):
    if not isinstance(seg, dict):
        return None

    start = finite_float(seg.get("start", 0.0), 0.0)
    end = finite_float(seg.get("end", start), start)
    if end < start:
        end = start

    text = str(seg.get("text", "")).strip()
    words = []
    for word in seg.get("words", []) or []:
        normalized = normalize_word(word, start, end)
        if normalized is not None:
            words.append(normalized)

    return {
        "start": start,
        "end": end,
        "text": text,
        "words": words,
        "loudness_dBFS": finite_float(seg.get("loudness_dBFS", 0.0), 0.0),
        "quality_decision": str(seg.get("quality_decision", "ACCEPT") or "ACCEPT"),
        "quality_flags": [
            str(flag)
            for flag in (seg.get("quality_flags", []) or [])
            if flag is not None
        ],
    }


def normalize_segments(segments):
    normalized = []
    for seg in segments or []:
        item = normalize_segment(seg)
        if item is not None:
            normalized.append(item)
    return normalized


def write_output(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(json_safe(payload), f, ensure_ascii=False, allow_nan=False)


def resolve_asr_engine(value: str) -> str:
    del value
    return "mlx_whisper"


def transcribe_with_mlx_whisper(video_path: str, reference_script: str, mode: str) -> dict:
    from core_logic import transcribe_audio

    emit_progress("Đang bóc băng bằng mlx_whisper trên Mac...")
    segments, has_hallucination, transcribe_mode_used, diagnostics = transcribe_audio(
        video_path,
        reference_script,
        transcribe_mode=mode,
        return_diagnostics=True,
    )
    return {
        "segments": normalize_segments(segments),
        "has_hallucination": has_hallucination,
        "transcribe_mode_used": transcribe_mode_used,
        "engine": "mlx_whisper",
        "diagnostics": diagnostics,
    }


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "--sanitize-smoke":
        write_output(sys.argv[2], {
            "status": "success",
            "value": float("nan"),
            "segments": normalize_segments([
                {
                    "start": 0.0,
                    "end": float("inf"),
                    "text": "Smoke",
                    "avg_logprob": float("nan"),
                    "compression_ratio": 1.2,
                    "tokens": [1, 2, 3],
                    "words": [
                        {"word": "Smoke", "start": 0.0, "end": float("nan"), "probability": float("nan")},
                    ],
                    "loudness_dBFS": float("-inf"),
                    "quality_decision": "ACCEPT",
                    "quality_flags": ["review"],
                }
            ]),
        })
        return 0

    if len(sys.argv) == 2 and sys.argv[1] == "--check-imports":
        import importlib.util
        import core_logic  # noqa: F401

        print(json.dumps({
            "status": "success",
            "project_root": str(PROJECT_ROOT),
            "core_logic": True,
            "mlx_whisper": importlib.util.find_spec("mlx_whisper") is not None,
        }, ensure_ascii=False), flush=True)
        return 0

    if len(sys.argv) == 3 and sys.argv[1] == "--resolve-engine":
        print(json.dumps({
            "status": "success",
            "requested": sys.argv[2],
            "resolved": resolve_asr_engine(sys.argv[2]),
        }, ensure_ascii=False), flush=True)
        return 0

    if len(sys.argv) != 3:
        print("usage: mac_mlx_sidecar.py <input.json> <output.json>", file=sys.stderr)
        return 2

    payload = load_payload(sys.argv[1])
    output_path = sys.argv[2]
    video_path = str(payload.get("video_path") or payload.get("audio_path") or "")
    reference_script = str(payload.get("reference_script") or "")
    mode = str(payload.get("transcribe_mode") or "vi_smart")
    requested_engine = "mlx_whisper"

    if not video_path:
        raise RuntimeError("Missing video_path/audio_path")

    try:
        forced_failure = resolve_asr_engine(os.getenv("MAC_ASR_FORCE_ENGINE_FAILURE", ""))
        if os.getenv("MAC_ASR_FORCE_ENGINE_FAILURE") and forced_failure == requested_engine:
            raise RuntimeError(f"Forced ASR failure for {requested_engine}")

        result = transcribe_with_mlx_whisper(video_path, reference_script, mode)

        write_output(output_path, {"status": "success", "requested_engine": requested_engine, **result})
        print(json.dumps({"type": "result", "message": "mac ASR complete", "path": output_path}, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:
        detail = f"ASR engine '{requested_engine}' failed: {exc}"
        write_output(output_path, {
            "status": "error",
            "detail": detail,
            "stage": "mac_asr",
            "requested_engine": requested_engine,
            "engine": None,
        })
        print(json.dumps({"type": "error", "message": detail}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
