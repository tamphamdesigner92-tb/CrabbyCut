#!/usr/bin/env python3
import gc
import glob
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
from difflib import SequenceMatcher
from pathlib import Path
from time import perf_counter
from typing import Any, Dict, List, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parents[1]
TEMP_DIR = PROJECT_ROOT / "temp_uploads"


def _ensure_cuda_dll_path() -> List[str]:
    """WINDOWS: ctranslate2 KHÔNG mang theo cuBLAS, và nó nạp DLL bằng `LoadLibrary` — tức
    chỉ dò theo PATH.

    ctranslate2 4.8+ có sẵn `cudnn64_9.dll` trong chính thư mục gói, nhưng cuBLAS thì phải
    lấy từ nơi khác: CUDA Toolkit, bản torch dựng cho CUDA, hoặc gói pip
    `nvidia-cublas-cu12`. Máy chỉ có torch bản CPU và không cài Toolkit thì
    `model.encode()` chết với:

        RuntimeError: Library cublas64_12.dll is not found or cannot be loaded

    Lỗi này nổ ra ở GIỮA phiên bóc băng (lúc encode), KHÔNG phải lúc nạp model — nên
    `WhisperModel(device="cuda")` vẫn thành công và mọi phép thăm dò đều báo CUDA sẵn sàng.
    `ctranslate2.get_supported_compute_types("cuda")` cũng chỉ nói bản dựng hỗ trợ gì, nó
    KHÔNG kiểm tra được DLL có nạp nổi hay không.

    ĐÃ THỬ `os.add_dll_directory()` — KHÔNG ăn: cách đó chỉ tác động tới `LoadLibraryEx`
    với cờ LOAD_LIBRARY_SEARCH_USER_DIRS, còn bộ nạp bên trong ctranslate2 thì không dùng.
    Chỉ có sửa PATH mới hiệu quả (đo thực tế trên GTX 1060: 17s audio -> 1.6s trên GPU,
    so với 25.0s trên CPU, tức nhanh hơn ~15 lần).

    Phải chạy TRƯỚC mọi `import ctranslate2` (các import đó đều nằm trong hàm nên gọi hàm
    này ở mức module là đủ sớm). Trả về danh sách thư mục đã thêm để ghi vào diagnostics.
    """
    if sys.platform != "win32":
        return []

    roots: List[str] = []
    try:
        import importlib.util

        spec = importlib.util.find_spec("nvidia")
        roots = [str(item) for item in (getattr(spec, "submodule_search_locations", None) or [])]
    except Exception:
        roots = []
    if not roots:
        # `nvidia` là namespace package; nếu find_spec không thấy thì dò thẳng site-packages.
        try:
            import sysconfig

            purelib = sysconfig.get_paths().get("purelib")
            if purelib:
                roots = [os.path.join(purelib, "nvidia")]
        except Exception:
            roots = []

    current = os.environ.get("PATH", "")
    have = {entry.lower() for entry in current.split(os.pathsep) if entry}
    added: List[str] = []
    for root in roots:
        for bin_dir in sorted(glob.glob(os.path.join(root, "*", "bin"))):
            if not os.path.isdir(bin_dir) or bin_dir.lower() in have:
                continue
            added.append(bin_dir)
            have.add(bin_dir.lower())
    if added:
        os.environ["PATH"] = os.pathsep.join(added) + os.pathsep + current
    return added


CUDA_DLL_DIRS = _ensure_cuda_dll_path()

FAST_AUDIO_FILTER = "highpass=f=200,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11"
HQ_AUDIO_FILTER = (
    "highpass=f=120,lowpass=f=7500,afftdn=nf=-28,"
    "anlmdn=s=0.0003,dynaudnorm=f=250:g=15,loudnorm=I=-18:TP=-1.5:LRA=11"
)
VI_SMART_AUDIO_FILTER = (
    "highpass=f=80,lowpass=f=7600,afftdn=nf=-22,"
    "anlmdn=s=0.0002,dynaudnorm=f=250:g=12,loudnorm=I=-16:TP=-1:LRA=11"
)

HALLUCINATION_THRESHOLDS: Dict[str, Any] = {
    "avg_logprob_min": -0.9,
    "no_speech_prob_max": 0.7,
    "compression_ratio_max": 2.4,
    "repeat_token_run": 4,
    "min_wps": 1.0,
    "max_wps": 8.0,
    "short_seg_sec": 1.2,
    "short_seg_max_chars": 12,
}

# MỘT MODEL DUY NHẤT trên Windows: Large v3 Turbo (khớp với macOS, nơi core_logic.py ghim
# mlx-community/whisper-large-v3-turbo). Distil Large v3 đã bỏ hẳn.
#
# `min_vram_mb = 0` là CÓ Ý: Turbo là lựa chọn duy nhất nên nó phải chạy được ở MỌI cấu
# hình — không GPU thì rơi về CPU/int8. Ngưỡng 6144 cũ vừa quá thận trọng vừa sai chỗ: đo
# thật trên GTX 1060 6GB (int8, audio 243s / ~58 cụm thoại) cho thấy Turbo chỉ dùng 1.4GB
# ở batch 1 và 3.1GB ở batch 8, không OOM kể cả batch 32.
#
# `batch_vram_tiers` = [(VRAM tối thiểu, batch_size)], xét từ trên xuống. Bảng theo TỪNG
# model vì dung lượng model quyết định phần lớn VRAM: dùng chung một bảng cho mọi model là
# lý do trước đây Turbo bị gán cùng batch với Distil (nhỏ hơn một nửa). Số đo trên 6GB:
#     batch 1 -> 1433MB / 16.5s      batch 8  -> 3120MB / 14.2s
#     batch 2 -> 1603MB / 15.6s      batch 16 -> 3377MB / 14.5s
#     batch 4 -> 2172MB / 15.0s      batch 32 -> 3289MB / 14.1s
# Lợi ích tốc độ bão hoà sau batch 8 (chỉ nhanh thêm ~2%) nên không leo cao hơn 16: thêm
# batch chỉ ăn VRAM mà gần như không nhanh hơn.
MODEL_CONFIGS: Dict[str, Dict[str, Any]] = {
    "large-v3-turbo": {
        "id": "large-v3-turbo",
        "label": "Large v3 Turbo",
        "faster_whisper_name": "large-v3-turbo",
        "min_vram_mb": 0,
        "quality": "higher",
        "speed": "fast",
        "default": True,
        "batch_vram_tiers": [(10240, 16), (6144, 8), (4096, 4), (2560, 2)],
    },
}

DEFAULT_MODEL_ID = "large-v3-turbo"


def emit_progress(message: str) -> None:
    print(json.dumps({"type": "progress", "message": message}, ensure_ascii=False), flush=True)


# TIẾN ĐỘ THẬT của lượt bóc băng, 0..1 — Auto Subtitle vẽ thanh từ con số này.
#
# ĐI CHUNG KÊNH NDJSON trên stdout với emit_progress, chỉ khác là KHÔNG có "message":
# backend chỉ đọc "ratio" và KHÔNG gọi setStatus, nên thanh chạy mượt mà không đẩy hàng
# trăm dòng chữ vào progress.txt.
#
# VÌ SAO KHÔNG ĐỌC THANH tqdm NHƯ NHÁNH macOS: faster-whisper không vẽ thanh nào cả, mà
# trả về một GENERATOR segment. Lấy ngay tại nguồn (`segment.end / thời lượng audio`) vừa
# chính xác hơn vừa không phụ thuộc vào cách tqdm vẽ chữ.
#
# CHỈ PHÁT KHI BACKEND XIN (CRAB_ASR_PROGRESS=1): luồng Upload -> Transcribe và Magic Fill
# không cần thanh, và thêm dòng vào stdout của chúng là thêm chỗ để hỏng.
# MỐC CÁC PHA CỦA MỘT LƯỢT BÓC BĂNG. Thanh chỉ nhúc nhích khi một pha THẬT xong hoặc khi
# một pha có tiến độ thật báo về — không có đồng hồ đếm giả ở đây. Ba con số này chỉ quyết
# định mỗi pha CHIẾM BAO NHIÊU của thanh.
#
# ĐO ĐƯỢC trên 48 phút audio, GTX 1060 / int8 / batch 8 (tổng 179,5 s):
#   tiền xử lý ffmpeg  75,5 s (42%)   <- có tiến độ thật (-progress)
#   nạp model           4,8 s ( 3%)   <- không có tiến độ, nhưng biên rõ ràng
#   VAD + trích đặc trưng ~23 s (13%) <- chạy TRONG batched_model.transcribe(), không hook được
#   giải mã            ~76 s (42%)   <- có tiến độ thật (mỗi batch một nhịp)
#
# VÌ SAO PHẢI CHIA PHA: `BatchedInferencePipeline` chạy VAD + trích đặc trưng NGAY trong
# transcribe() rồi mới trả generator, nên nếu chỉ phát tiến độ theo segment thì thanh đứng
# im suốt 108 giây đầu (đã đo) rồi mới nhảy — tệ hơn là không có thanh.
ASR_PHASE_PREPROCESS = 0.40   # hết tiền xử lý audio
ASR_PHASE_MODEL_LOAD = 0.45   # hết nạp model
ASR_PHASE_FEATURES = 0.55     # hết VAD + trích đặc trưng, bắt đầu giải mã

PROGRESS_RATIO_ENABLED = os.getenv("CRAB_ASR_PROGRESS") == "1"
_last_ratio_sent = -1.0


# Đặt lại mốc nhịp trước MỖI lượt giải mã. Cần vì OOM trên GPU làm lượt đó chạy LẠI TỪ
# ĐẦU với batch nhỏ hơn: mốc mới luôn nhỏ hơn mốc cũ nên bộ lọc 1% bên dưới sẽ chặn sạch
# mọi lần phát về sau, và thanh đứng im đúng vào lượt chạy lâu nhất.
def reset_ratio() -> None:
    global _last_ratio_sent
    _last_ratio_sent = -1.0


def emit_ratio(ratio: float) -> None:
    global _last_ratio_sent
    if not PROGRESS_RATIO_ENABLED:
        return
    try:
        value = float(ratio)
    except (TypeError, ValueError):
        return
    if not math.isfinite(value):
        return
    value = max(0.0, min(1.0, value))
    # Nhịp 1%: một video dài ra hàng trăm segment, phát từng cái là bơm rác vào stdout mà
    # thanh tiến trình cũng không mượt hơn (panel chỉ poll 700 ms một lần).
    if value - _last_ratio_sent < 0.01 and value < 1.0:
        return
    _last_ratio_sent = value
    print(json.dumps({"type": "progress", "ratio": value}), flush=True)


def load_payload(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_output(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(json_safe(payload), f, ensure_ascii=False, allow_nan=False)


def json_safe(value):
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    return value


def finite_float(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if math.isfinite(parsed) else fallback


def normalize_model_id(value: Any) -> str:
    raw = str(value or "").strip().lower().replace("_", "-")
    # CÁC TÊN CỦA DISTIL VẪN PHẢI NHẬN, và quy về Turbo. Dự án .crab cũ, settings đã lưu và
    # payload từ bản frontend cũ đều có thể còn mang "distil-large-v3"; raise ở đây là mở
    # dự án cũ lên là chết bóc băng. Quy đổi âm thầm sang model duy nhất còn lại.
    if raw in {"", "default", "distil", "distil-large", "distil-large-v3",
               "turbo", "large-v3-turbo", "whisper-large-v3-turbo"}:
        return DEFAULT_MODEL_ID
    if raw in MODEL_CONFIGS:
        return raw
    raise ValueError(f"Unsupported Windows ASR model: {value}")


def default_model_root() -> Path:
    env_path = os.getenv("WINDOWS_ASR_MODEL_DIR")
    if env_path:
        return Path(env_path).expanduser()
    if os.name == "nt":
        base = os.getenv("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / "AI Video Auto Cutter" / "asr_models"
    return PROJECT_ROOT / "asr_models" / "windows"


def resolve_model_root(value: Any = None) -> Path:
    if value:
        return Path(str(value)).expanduser()
    return default_model_root()


def model_dir(model_root: Path, model_id: str) -> Path:
    return model_root / model_id


def model_marker_path(model_root: Path, model_id: str) -> Path:
    return model_dir(model_root, model_id) / ".model-ready.json"


def is_model_ready(model_root: Path, model_id: str) -> bool:
    root = model_dir(model_root, model_id)
    required = ["config.json", "model.bin", "tokenizer.json"]
    return root.is_dir() and all((root / name).exists() for name in required)


def read_marker(model_root: Path, model_id: str) -> Optional[dict]:
    marker = model_marker_path(model_root, model_id)
    try:
        return json.loads(marker.read_text(encoding="utf-8"))
    except Exception:
        return None


def check_imports() -> dict:
    import importlib.util

    faster_spec = importlib.util.find_spec("faster_whisper")
    ct2_spec = importlib.util.find_spec("ctranslate2")
    hub_spec = importlib.util.find_spec("huggingface_hub")
    supported: Dict[str, Any] = {"cpu": [], "cuda": [], "cuda_error": None}
    if ct2_spec is not None:
        try:
            import ctranslate2

            try:
                supported["cpu"] = sorted(str(item) for item in ctranslate2.get_supported_compute_types("cpu"))
            except Exception as exc:
                supported["cpu_error"] = str(exc)
            try:
                supported["cuda"] = sorted(str(item) for item in ctranslate2.get_supported_compute_types("cuda"))
            except Exception as exc:
                supported["cuda_error"] = str(exc)
        except Exception as exc:
            supported["import_error"] = str(exc)
    return {
        "faster_whisper": faster_spec is not None,
        "ctranslate2": ct2_spec is not None,
        "huggingface_hub": hub_spec is not None,
        "supported_compute_types": supported,
    }


def probe_nvidia() -> dict:
    command = shutil.which("nvidia-smi")
    if not command:
        return {"available": False, "gpus": [], "max_vram_mb": None, "error": "nvidia-smi not found"}
    try:
        result = subprocess.run(
            [
                command,
                "--query-gpu=name,memory.total",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=3,
        )
    except Exception as exc:
        return {"available": False, "gpus": [], "max_vram_mb": None, "error": str(exc)}

    gpus = []
    max_vram_mb: Optional[int] = None
    for line in result.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 2:
            continue
        try:
            vram_mb = int(float(parts[-1]))
        except ValueError:
            vram_mb = None
        if vram_mb is not None:
            max_vram_mb = max(vram_mb, max_vram_mb or 0)
        gpus.append({"name": ", ".join(parts[:-1]) or parts[0], "vram_mb": vram_mb})
    return {
        "available": bool(gpus),
        "gpus": gpus,
        "max_vram_mb": max_vram_mb,
        "error": None,
    }


def select_runtime(model_id: str, imports: dict, nvidia: dict) -> dict:
    supported = imports.get("supported_compute_types", {})
    cuda_types = set(supported.get("cuda") or [])
    cpu_types = set(supported.get("cpu") or [])
    max_vram_mb = nvidia.get("max_vram_mb")
    cuda_ready = bool(nvidia.get("available") and cuda_types and max_vram_mb)

    if cuda_ready:
        vram = int(max_vram_mb or 0)
        if vram >= 8192 and "float16" in cuda_types:
            compute_type = "float16"
        elif "int8_float16" in cuda_types:
            compute_type = "int8_float16"
        elif "int8" in cuda_types:
            compute_type = "int8"
        else:
            compute_type = "auto"

        # BẢNG BATCH RIÊNG CHO TỪNG MODEL (xem chú thích MODEL_CONFIGS). Trước đây bảng
        # dùng chung nên mọi model nhận cùng batch ở cùng mức VRAM, bất kể model to nhỏ.
        tiers = MODEL_CONFIGS.get(model_id, {}).get("batch_vram_tiers") or []
        batch_size = 1
        for min_vram, size in tiers:
            if vram >= int(min_vram):
                batch_size = int(size)
                break
        return {
            "device": "cuda",
            "compute_type": compute_type,
            "batch_size": batch_size,
            "vad_filter": True,
            "vad_backend": "silero",
            "vram_mb": vram,
            "cuda_ready": True,
        }

    compute_type = "int8" if "int8" in cpu_types or not cpu_types else "auto"
    return {
        "device": "cpu",
        "compute_type": compute_type,
        "batch_size": 1,
        "vad_filter": True,
        "vad_backend": "silero",
        "vram_mb": max_vram_mb,
        "cuda_ready": False,
    }


def build_probe_payload(model_root: Path, selected_model: str = DEFAULT_MODEL_ID) -> dict:
    imports = check_imports()
    nvidia = probe_nvidia()
    max_vram_mb = nvidia.get("max_vram_mb")
    models = []
    for model_id, config in MODEL_CONFIGS.items():
        runtime = select_runtime(model_id, imports, nvidia)
        min_vram = int(config["min_vram_mb"])
        # `min_vram_mb = 0` -> luôn eligible. Giữ nguyên phép so sánh để nếu sau này có
        # model đặt ngưỡng > 0 thì nó vẫn được tôn trọng, thay vì hard-code tên model như
        # bản cũ (bản cũ đặc cách riêng "distil-large-v3", nên khi bỏ model đó là hỏng).
        eligible = min_vram <= 0 or bool(max_vram_mb and int(max_vram_mb) >= min_vram)
        ready = is_model_ready(model_root, model_id)
        reason = None
        if not imports["faster_whisper"] or not imports["ctranslate2"]:
            reason = "missing_python_dependencies"
        elif not eligible:
            reason = f"requires_at_least_{min_vram}_mb_vram"
        elif not ready:
            reason = "model_not_setup"
        models.append({
            **{k: v for k, v in config.items() if k != "faster_whisper_name"},
            "ready": ready,
            "eligible": eligible,
            "available": bool(ready and eligible and imports["faster_whisper"] and imports["ctranslate2"]),
            "reason": reason,
            "path": str(model_dir(model_root, model_id)),
            "marker": read_marker(model_root, model_id),
            "runtime": runtime,
        })

    selected = normalize_model_id(selected_model)
    return {
        "status": "success",
        "platform": "win32",
        "engine": "faster_whisper",
        "model_root": str(model_root),
        "selected_model": selected,
        "imports": imports,
        "nvidia": nvidia,
        "models": models,
        "runtime": select_runtime(selected, imports, nvidia),
    }


def setup_model(model_root: Path, model_id: str, force: bool = False) -> dict:
    probe = build_probe_payload(model_root, model_id)
    model_info = next(item for item in probe["models"] if item["id"] == model_id)
    if not model_info["eligible"] and not force:
        raise RuntimeError(f"Model {model_id} requires at least {MODEL_CONFIGS[model_id]['min_vram_mb']} MB VRAM.")
    if not probe["imports"]["faster_whisper"]:
        raise RuntimeError("Missing Python package: faster-whisper.")
    if not probe["imports"]["huggingface_hub"]:
        raise RuntimeError("Missing Python package: huggingface-hub.")

    from faster_whisper.utils import download_model

    target = model_dir(model_root, model_id)
    target.mkdir(parents=True, exist_ok=True)
    faster_name = MODEL_CONFIGS[model_id]["faster_whisper_name"]
    emit_progress(f"Đang setup model ASR Windows: {model_id}...")
    started = perf_counter()
    downloaded_path = download_model(faster_name, output_dir=str(target), local_files_only=False)
    duration_ms = int((perf_counter() - started) * 1000)
    marker = {
        "model": model_id,
        "faster_whisper_name": faster_name,
        "downloaded_path": str(downloaded_path),
        "duration_ms": duration_ms,
        "platform": platform.platform(),
    }
    model_marker_path(model_root, model_id).write_text(json.dumps(marker, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "status": "success",
        "action": "setup",
        "engine": "faster_whisper",
        "asr_model": model_id,
        "path": str(target),
        "duration_ms": duration_ms,
        "ready": is_model_ready(model_root, model_id),
        "marker": marker,
    }


def run_ffmpeg_with_progress(command, total_seconds: float, on_ratio) -> None:
    """Chạy ffmpeg và báo tiến độ thật; ném CalledProcessError y như subprocess.run(check=True).

    `-progress pipe:1` in ra "out_time_us=<micro giây>" theo từng nhịp. LƯU Ý: khoá
    `out_time_ms` của ffmpeg cũng mang giá trị MICRO giây (lỗi đặt tên có từ lâu của ffmpeg,
    đã kiểm lại trên bản đang dùng) — nên cả hai khoá đều chia cho 1e6.

    `creationflags` để Windows không nháy một cửa sổ console đen mỗi lượt.
    """
    proc = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
    )
    try:
        for line in proc.stdout:
            if not (total_seconds > 0 and on_ratio):
                continue
            line = line.strip()
            if not line.startswith(("out_time_us=", "out_time_ms=")):
                continue
            raw = line.split("=", 1)[1]
            try:
                done = float(raw) / 1_000_000.0
            except ValueError:
                continue
            on_ratio(max(0.0, min(1.0, done / total_seconds)))
    finally:
        proc.stdout.close()
        code = proc.wait()
    if code != 0:
        raise subprocess.CalledProcessError(code, command)


def preprocess_audio(video_path: str, mode: str, on_ratio=None) -> Tuple[str, str, int]:
    requested_mode = (mode or "vi_smart").lower()
    if requested_mode not in {"fast", "hq", "vi_smart"}:
        requested_mode = "vi_smart"

    mode_chain = {
        "fast": FAST_AUDIO_FILTER,
        "hq": HQ_AUDIO_FILTER,
        "vi_smart": VI_SMART_AUDIO_FILTER,
    }
    if requested_mode == "hq":
        modes_to_try = ["hq", "vi_smart", "fast"]
    elif requested_mode == "fast":
        modes_to_try = ["fast", "vi_smart"]
    else:
        modes_to_try = ["vi_smart", "hq", "fast"]

    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    output = TEMP_DIR / "windows_asr_input.wav"
    started = perf_counter()
    # Mẫu số của tiến độ ffmpeg. Đo hụt -> 0 -> chỉ mất thanh ở pha này, không hỏng gì khác.
    input_seconds = probe_audio_seconds(video_path) if on_ratio else 0.0
    for mode_to_try in modes_to_try:
        command = [
            "ffmpeg",
            "-y",
            "-i",
            video_path,
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-af",
            mode_chain[mode_to_try],
            "-nostats",
            "-progress",
            "pipe:1",
            str(output),
        ]
        try:
            run_ffmpeg_with_progress(command, input_seconds, on_ratio)
            return str(output), mode_to_try, int((perf_counter() - started) * 1000)
        except subprocess.CalledProcessError:
            # Lượt sau bắt đầu lại từ 0 giây: đặt lại mốc nhịp, nếu không bộ lọc 1% chặn sạch.
            reset_ratio()
            continue

    return video_path, "source", int((perf_counter() - started) * 1000)


def probe_audio_seconds(audio_path: str) -> float:
    """Thời lượng (giây) của một file audio, 0.0 nếu không đo được.

    Chỉ dùng làm mẫu số cho thanh tiến trình, nên hỏng thì TẮT THANH chứ không được làm
    hỏng cả lượt bóc băng — mọi lỗi đều nuốt. `creationflags` để Windows không nháy một
    cửa sổ console đen mỗi lượt (tiến trình con của app GUI được cấp console mới).
    """
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(audio_path),
            ],
            capture_output=True, text=True, timeout=30,
            creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
        )
        return max(0.0, float(out.stdout.strip()))
    except Exception:
        return 0.0


def object_to_segment(segment: Any) -> dict:
    words = []
    for word in getattr(segment, "words", None) or []:
        text = str(getattr(word, "word", "") or "").strip()
        if not text:
            continue
        words.append({
            "word": text,
            "start": finite_float(getattr(word, "start", None), finite_float(getattr(segment, "start", 0.0), 0.0)),
            "end": finite_float(getattr(word, "end", None), finite_float(getattr(segment, "end", 0.0), 0.0)),
            "probability": finite_float(getattr(word, "probability", None), 0.0),
        })
    return {
        "start": finite_float(getattr(segment, "start", 0.0), 0.0),
        "end": finite_float(getattr(segment, "end", 0.0), 0.0),
        "text": str(getattr(segment, "text", "") or "").strip(),
        "avg_logprob": finite_float(getattr(segment, "avg_logprob", None), 0.0),
        "no_speech_prob": finite_float(getattr(segment, "no_speech_prob", None), 0.0),
        "compression_ratio": finite_float(getattr(segment, "compression_ratio", None), 0.0),
        "words": words,
    }


def split_sentences(text: str) -> List[str]:
    normalized = re.sub(r"\s+", " ", text.replace("\r", "\n")).strip()
    if not normalized:
        return []
    primary_parts = re.split(r"(?<=[.!?])\s+|\n+", normalized)
    return [part.strip(" \t-•") for part in primary_parts if len(part.split()) >= 3]


# Chữ Hán / Kana / Hangul: mỗi ký tự là MỘT đơn vị đếm (xem count_speech_units).
CJK_CHAR_RE = re.compile(
    r"[⺀-〾ぁ-㏿㐀-䶿一-鿿"
    r"ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]"
)


def count_speech_units(text: str) -> int:
    """Số 'từ' dùng để đo tốc độ nói — đếm ĐƯỢC cho cả chữ không có khoảng trắng.

    `re.findall(r"\\w+", text)` là cách đếm cũ, và nó SAI HẲN với tiếng Trung/Nhật: cả
    câu viết liền nên `\\w+` khớp đúng MỘT lần. Một câu 3 giây ra 1 "từ" = 0,33 từ/giây,
    dưới ngưỡng min_wps 1.0 -> câu nào cũng dính cờ `abnormal_speech_rate`; ghép thêm một
    cờ bất kỳ nữa là annotate_and_filter_segments NÉM BỎ câu đó. Hậu quả: phụ đề tiếng
    Trung/Nhật mất câu, và mất ÂM THẦM (segment bị lọc trước khi tới renderer).

    Đếm mỗi chữ CJK là một đơn vị thì tốc độ đọc thật (~4-7 chữ/giây) rơi đúng vào dải
    1.0-8.0 đang dùng, không phải nới ngưỡng riêng cho từng ngôn ngữ.
    """
    cjk = len(CJK_CHAR_RE.findall(text))
    other = len(re.findall(r"\w+", CJK_CHAR_RE.sub(" ", text)))
    return cjk + other


def has_repeated_token_run(text: str, run_len: int = 4) -> bool:
    tokens = re.findall(r"\w+", text.lower())
    if not tokens:
        return False
    streak = 1
    for i in range(1, len(tokens)):
        if tokens[i] == tokens[i - 1]:
            streak += 1
            if streak >= run_len:
                return True
        else:
            streak = 1
    return False


def segment_quality_flags(seg: Dict[str, Any]) -> List[str]:
    flags: List[str] = []
    text = (seg.get("text") or "").strip()
    duration = max(0.001, finite_float(seg.get("end"), 0.0) - finite_float(seg.get("start"), 0.0))
    avg_logprob = finite_float(seg.get("avg_logprob"), 0.0)
    no_speech_prob = finite_float(seg.get("no_speech_prob"), 0.0)
    compression_ratio = finite_float(seg.get("compression_ratio"), 0.0)

    if avg_logprob < float(HALLUCINATION_THRESHOLDS["avg_logprob_min"]):
        flags.append("low_logprob")
    if no_speech_prob > float(HALLUCINATION_THRESHOLDS["no_speech_prob_max"]) and len(text) > 6:
        flags.append("high_no_speech_prob")
    if compression_ratio > float(HALLUCINATION_THRESHOLDS["compression_ratio_max"]):
        flags.append("high_compression_ratio")
    if has_repeated_token_run(text, int(HALLUCINATION_THRESHOLDS["repeat_token_run"])):
        flags.append("repeated_tokens")

    word_count = count_speech_units(text)
    wps = word_count / duration
    if word_count >= 2 and (
        wps < float(HALLUCINATION_THRESHOLDS["min_wps"])
        or wps > float(HALLUCINATION_THRESHOLDS["max_wps"])
    ):
        flags.append("abnormal_speech_rate")

    if duration < float(HALLUCINATION_THRESHOLDS["short_seg_sec"]) and len(text) > int(HALLUCINATION_THRESHOLDS["short_seg_max_chars"]):
        flags.append("too_much_text_for_short_segment")

    return flags


def annotate_and_filter_segments(segments: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    quality_stats = {"accept": 0, "review": 0, "reject": 0}
    cleaned = []
    for seg in segments:
        enriched = dict(seg)
        flags = segment_quality_flags(enriched)
        if len(flags) >= 2:
            decision = "REJECT"
            quality_stats["reject"] += 1
        elif len(flags) == 1:
            decision = "REVIEW"
            quality_stats["review"] += 1
        else:
            decision = "ACCEPT"
            quality_stats["accept"] += 1
        enriched["quality_flags"] = flags
        enriched["quality_decision"] = decision
        if decision != "REJECT":
            cleaned.append(enriched)
    return cleaned, quality_stats


def check_repeating_words(segments: List[Dict[str, Any]]) -> bool:
    for seg in segments:
        clean_text = re.sub(r"[^\w\s]", "", seg["text"].lower())
        words = clean_text.split()
        for i in range(len(words) - 2):
            if words[i] == words[i + 1] == words[i + 2]:
                return True
    return False


def check_identical_segments(segments: List[Dict[str, Any]], reference_script: str = "", similarity_threshold: float = 0.75) -> bool:
    if len(segments) < 2:
        return False

    ref_sentences = []
    if reference_script.strip():
        ref_sentences = [re.sub(r"[^\w\s]", "", s.lower()).strip() for s in split_sentences(reference_script)]

    for i in range(1, len(segments)):
        prev_text = re.sub(r"[^\w\s]", "", segments[i - 1]["text"].lower()).strip()
        curr_text = re.sub(r"[^\w\s]", "", segments[i]["text"].lower()).strip()
        if len(curr_text.split()) < 2:
            continue
        if curr_text == prev_text:
            is_in_script = any(SequenceMatcher(None, curr_text, ref_sent).ratio() >= similarity_threshold for ref_sent in ref_sentences)
            if not is_in_script:
                return True
    return False


def add_loudness(segments: List[Dict[str, Any]], audio_path: str) -> None:
    try:
        from pydub import AudioSegment

        audio_full = AudioSegment.from_file(audio_path)
        for seg in segments:
            start_ms = int(finite_float(seg.get("start"), 0.0) * 1000)
            end_ms = int(finite_float(seg.get("end"), 0.0) * 1000)
            chunk = audio_full[max(0, start_ms):max(0, end_ms)]
            loudness = chunk.dBFS
            seg["loudness_dBFS"] = loudness if loudness != float("-inf") else -100.0
    except Exception:
        for seg in segments:
            seg["loudness_dBFS"] = 0.0


# Ngôn ngữ bóc băng được bày ra ở menu Auto Subtitle. Whisper biết 99 thứ tiếng; danh sách
# này hẹp lại đúng những thứ tiếng mà ứng dụng CÓ FONT VẼ ĐƯỢC (xem EDITING_FONTS ở
# editing-runtime.js) — bày ra tiếng Ả Rập rồi dựng phụ đề toàn ô vuông thì tệ hơn là không
# bày. Giữ ĐỒNG BỘ với LANGUAGES ở static/js/auto-subtitle.js.
SUPPORTED_LANGUAGES = ("vi", "en", "zh", "ja", "ko")

# GIẢN THỂ vs PHỒN THỂ: Whisper CHỈ có một mã "zh", không tách hai bộ chữ. Model trả về bộ
# nào là tuỳ dữ liệu huấn luyện của đoạn đó, nên cùng một video có thể ra lẫn lộn. `initial_prompt`
# viết bằng chính chữ giản thể là cách duy nhất neo được bộ chữ đầu ra — đây là cách dùng
# chính thức của Whisper cho việc này, không phải mẹo vặt.
SIMPLIFIED_CHINESE_PROMPT = "以下是普通话的句子，请使用简体中文转写。"


def resolve_language(raw: Any) -> Tuple[Optional[str], Optional[str]]:
    """(mã ngôn ngữ cho Whisper, initial_prompt). None = để Whisper tự nhận diện.

    KHÔNG truyền khoá `language` -> "vi", đúng giá trị ghim cứng trước đây. Bước Transcribe
    và Magic Fill không biết gì về khoá này, nên chúng phải chạy y hệt bản cũ; chỉ Auto
    Subtitle mới có menu chọn ngôn ngữ và chỉ nó truyền xuống.
    """
    code = str(raw or "").strip().lower().replace("_", "-").split("-")[0]
    if code == "":
        return "vi", None
    if code == "auto":
        return None, None
    if code not in SUPPORTED_LANGUAGES:
        # Mã lạ (client cũ, hoặc người dùng sửa tay .crab): tự nhận diện còn hơn ép sai
        # ngôn ngữ — ép sai thì Whisper DỊCH sang thứ tiếng được ép thay vì báo lỗi.
        return None, None
    return code, (SIMPLIFIED_CHINESE_PROMPT if code == "zh" else None)


def is_oom_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return "out of memory" in text or "cuda failed" in text or "cublas" in text or "cudnn" in text


def transcribe(model_root: Path, payload: dict) -> dict:
    from faster_whisper import BatchedInferencePipeline, WhisperModel

    video_path = str(payload.get("video_path") or payload.get("audio_path") or "")
    reference_script = str(payload.get("reference_script") or "")
    mode = str(payload.get("transcribe_mode") or "vi_smart")
    language, initial_prompt = resolve_language(payload.get("language"))
    model_id = normalize_model_id(payload.get("asr_model") or payload.get("model") or DEFAULT_MODEL_ID)
    if not video_path:
        raise RuntimeError("Missing video_path/audio_path")

    # HOOK ÉP LỖI CHO TEST — đối xứng với MAC_ASR_FORCE_ENGINE_FAILURE ở mac_mlx_sidecar.py.
    # Đường BÁO LỖI của ASR (client nhận detail + /api/reset-project ghi report) cần kiểm
    # được một cách TẤT ĐỊNH. Trước đây trên Windows nó chỉ "tự đúng" vì máy đang thiếu
    # thư viện/model; hết thiếu là test đỏ dù sản phẩm không sai. Đặt TRƯỚC cả
    # is_model_ready để test chạy được trên máy chưa tải model.
    forced = os.getenv("WINDOWS_ASR_FORCE_ENGINE_FAILURE", "").strip().lower()
    if forced and forced in ("1", "true", "faster_whisper", "faster-whisper"):
        raise RuntimeError("Forced ASR failure for faster_whisper")

    if not is_model_ready(model_root, model_id):
        raise RuntimeError(f"Windows ASR model '{model_id}' is not setup. Run /api/asr-models/setup first.")

    diagnostics: Dict[str, Any] = {
        "windows_asr_model": model_id,
        "windows_asr_model_path": str(model_dir(model_root, model_id)),
        "windows_asr_vad_filter": True,
        "windows_asr_vad_backend": "silero",
    }
    overall_started = perf_counter()
    emit_progress(f"Đang bóc băng bằng faster-whisper ({model_id}) trên Windows...")
    processed_audio, mode_used, audio_ms = preprocess_audio(
        video_path, mode,
        on_ratio=lambda r: emit_ratio(r * ASR_PHASE_PREPROCESS),
    )
    emit_ratio(ASR_PHASE_PREPROCESS)
    diagnostics["audio_preprocess_duration_ms"] = audio_ms
    # Mẫu số của thanh tiến trình (xem emit_ratio). Đo bằng ffprobe trên bản ĐÃ tiền xử lý,
    # không phải trên file gốc: hai thứ có thể lệch nhau vài phần trăm giây, và 0 thì tắt
    # hẳn thanh thay vì chia cho 0.
    audio_seconds = probe_audio_seconds(processed_audio)

    probe = build_probe_payload(model_root, model_id)
    runtime = probe["runtime"]
    device = str(runtime["device"])
    compute_type = str(runtime["compute_type"])
    initial_batch_size = int(runtime["batch_size"])
    diagnostics.update({
        "windows_asr_device": device,
        "windows_asr_compute_type": compute_type,
        "windows_asr_initial_batch_size": initial_batch_size,
        "windows_asr_cuda_ready": bool(runtime.get("cuda_ready")),
        "windows_asr_vram_mb": runtime.get("vram_mb"),
    })

    # THỬ LẠI PHẢI DỰNG LẠI MODEL, KHÔNG ĐƯỢC DÙNG LẠI CÁI VỪA LỖI.
    # Sau khi một lệnh CUDA của ctranslate2 lỗi, context CUDA của model đó coi như hỏng:
    # lần `encode()` tiếp theo trên CÙNG object KHÔNG raise mà TREO VĨNH VIỄN (chờ một
    # future không bao giờ hoàn tất). Đã đo trên GTX 1060:
    #     process mới, batch 4 -> raise sau 0.3s
    #     process mới, batch 2 -> raise sau 0.3s
    #     process mới, batch 1 -> raise sau 0.4s
    #     cùng process, thử lần 2 -> treo > 10 phút (stack kẹt ở
    #       faster_whisper/transcribe.py `encode` -> ctranslate2 Whisper.encode)
    # Đúng triệu chứng đã gặp: log chỉ hiện MỘT dòng giảm batch rồi ứng dụng đứng im.
    # Nạp lại model tốn vài giây mỗi lần thử — rẻ hơn nhiều so với treo cả ứng dụng.
    model_path = str(model_dir(model_root, model_id))
    attempts = []
    batch_size = initial_batch_size
    raw_segments = []
    info = None
    model = None
    batched_model = None
    model_load_ms = 0
    model_loads = 0
    while True:
        attempts.append(batch_size)
        reset_ratio()
        load_started = perf_counter()
        model = WhisperModel(model_path, device=device, compute_type=compute_type)
        batched_model = BatchedInferencePipeline(model=model)
        model_load_ms += int((perf_counter() - load_started) * 1000)
        model_loads += 1
        emit_ratio(ASR_PHASE_MODEL_LOAD)
        try:
            transcribe_started = perf_counter()
            segments, info = batched_model.transcribe(
                processed_audio,
                # `None` = Whisper tự nhận diện (lựa chọn "Tự nhận diện" ở menu Auto
                # Subtitle). Trước đây ghim cứng "vi": ép sai ngôn ngữ thì Whisper không
                # báo lỗi mà lặng lẽ DỊCH lời thoại sang thứ tiếng bị ép.
                language=language,
                initial_prompt=initial_prompt,
                task="transcribe",
                beam_size=5,
                word_timestamps=True,
                condition_on_previous_text=False,
                vad_filter=True,
                vad_parameters={
                    "min_silence_duration_ms": 500,
                    "speech_pad_ms": 180,
                },
                batch_size=batch_size,
            )
            # transcribe() đã trả về = VAD + trích đặc trưng XONG (nó chạy hai bước đó NGAY,
            # trước khi trả generator). Từ đây trở đi mới là giải mã.
            emit_ratio(ASR_PHASE_FEATURES)
            # DUYỆT TAY chứ không list-comprehension: `segments` là GENERATOR, việc giải mã
            # xảy ra ngay tại vòng lặp này. Đây là chỗ DUY NHẤT biết được đã bóc băng tới
            # đâu, nên thanh tiến trình của Auto Subtitle phải phát từ đây.
            # `audio_seconds` = thời lượng audio ĐÃ tiền xử lý; `seg.end` cũng nằm trên trục
            # đó (vad_filter chỉ BỎ QUA khoảng lặng, mốc trả về vẫn là mốc gốc), nên tỉ số
            # hai số này là phần trăm thật.
            raw_segments = []
            for seg in segments:
                raw_segments.append(object_to_segment(seg))
                if audio_seconds > 0:
                    done = finite_float(getattr(seg, "end", 0.0), 0.0) / audio_seconds
                    emit_ratio(ASR_PHASE_FEATURES + (done * (1.0 - ASR_PHASE_FEATURES)))
            emit_ratio(1.0)
            diagnostics["windows_asr_transcribe_duration_ms"] = int((perf_counter() - transcribe_started) * 1000)
            break
        except Exception as exc:
            if device == "cuda" and batch_size > 1 and is_oom_error(exc):
                diagnostics["windows_asr_last_oom"] = str(exc)
                batch_size = max(1, batch_size // 2)
                # THẢ model hỏng TRƯỚC khi gc, rồi vòng lặp dựng cái mới. Giữ lại tham
                # chiếu là VRAM không được giải phóng, lần thử sau lại OOM y như cũ.
                batched_model = None
                model = None
                gc.collect()
                emit_progress(f"GPU thiếu VRAM, giảm ASR batch size xuống {batch_size}...")
                continue
            raise

    diagnostics["windows_asr_batch_size"] = batch_size
    diagnostics["windows_asr_batch_attempts"] = attempts
    # TỔNG thời gian nạp model của MỌI lần thử (không còn là một lần duy nhất), kèm số lần
    # nạp — hai số này cho thấy ngay đã phải thử lại bao nhiêu lần.
    diagnostics["windows_asr_model_load_duration_ms"] = model_load_ms
    diagnostics["windows_asr_model_loads"] = model_loads
    diagnostics["windows_asr_cuda_dll_dirs"] = CUDA_DLL_DIRS
    diagnostics["model_transcribe_duration_ms"] = diagnostics.get("windows_asr_transcribe_duration_ms")
    diagnostics["vad_duration_ms"] = None
    diagnostics["manual_vad"] = False
    diagnostics["vad_filter"] = True

    postprocess_started = perf_counter()
    add_loudness(raw_segments, processed_audio)
    cleaned_segments = [seg for seg in raw_segments if seg.get("loudness_dBFS", 0.0) != -100.0]
    final_segments, quality_stats = annotate_and_filter_segments(cleaned_segments)
    has_repeating_words = check_repeating_words(final_segments)
    has_identical = check_identical_segments(final_segments, reference_script)
    has_hallucination = quality_stats["review"] > 0 or quality_stats["reject"] > 0 or has_repeating_words or has_identical
    diagnostics.update({
        "raw_asr_segment_count": len(raw_segments),
        "aligned_segment_count": len(raw_segments),
        "final_segment_count": len(final_segments),
        "vad_chunk_count": None,
        "used_full_audio_fallback": False,
        "postprocess_duration_ms": int((perf_counter() - postprocess_started) * 1000),
        "total_transcribe_audio_duration_ms": int((perf_counter() - overall_started) * 1000),
        "language": getattr(info, "language", None) if info is not None else None,
        "language_probability": getattr(info, "language_probability", None) if info is not None else None,
        "quality_accept_count": quality_stats["accept"],
        "quality_review_count": quality_stats["review"],
        "quality_reject_count": quality_stats["reject"],
    })

    transcribe_mode_used = f"{mode_used} ({model_id}, {device}/{compute_type}, batch={batch_size}, vad)"
    return {
        "status": "success",
        "requested_engine": "faster_whisper",
        "engine": "faster_whisper",
        "asr_model": model_id,
        "segments": final_segments,
        # Ngôn ngữ THẬT SỰ được dùng — với "Tự nhận diện" thì đây là thứ Whisper nghe ra.
        # Auto Subtitle lấy đúng số này để chọn font cho phụ đề, nên nó phải nằm ở mức
        # trên cùng chứ không lẫn trong `diagnostics` (diagnostics chỉ đi vào report).
        "language": (language or (getattr(info, "language", None) if info is not None else None) or "vi"),
        "has_hallucination": has_hallucination,
        "transcribe_mode_used": transcribe_mode_used,
        "diagnostics": diagnostics,
    }


def main() -> int:
    if len(sys.argv) == 2 and sys.argv[1] == "--check-imports":
        print(json.dumps({"status": "success", **check_imports()}, ensure_ascii=False), flush=True)
        return 0

    if len(sys.argv) == 3 and sys.argv[1] == "--resolve-model":
        model_id = normalize_model_id(sys.argv[2])
        print(json.dumps({
            "status": "success",
            "requested": sys.argv[2],
            "resolved": model_id,
            "config": MODEL_CONFIGS[model_id],
        }, ensure_ascii=False), flush=True)
        return 0

    if len(sys.argv) != 3:
        print("usage: windows_faster_whisper_sidecar.py <input.json> <output.json>", file=sys.stderr)
        return 2

    payload = load_payload(sys.argv[1])
    output_path = sys.argv[2]
    action = str(payload.get("action") or "transcribe")
    model_root = resolve_model_root(payload.get("model_root"))
    model_id = normalize_model_id(payload.get("asr_model") or payload.get("model") or DEFAULT_MODEL_ID)

    try:
        if action == "probe":
            write_output(output_path, build_probe_payload(model_root, model_id))
        elif action == "setup":
            write_output(output_path, setup_model(model_root, model_id, bool(payload.get("force"))))
        elif action == "transcribe":
            write_output(output_path, transcribe(model_root, payload))
            print(json.dumps({"type": "result", "message": "windows ASR complete", "path": output_path}, ensure_ascii=False), flush=True)
        else:
            raise RuntimeError(f"Unsupported action: {action}")
        return 0
    except Exception as exc:
        detail = f"Windows ASR faster-whisper failed: {exc}"
        write_output(output_path, {
            "status": "error",
            "detail": detail,
            "stage": f"windows_asr_{action}",
            "requested_engine": "faster_whisper",
            "engine": None,
            "asr_model": model_id,
        })
        print(json.dumps({"type": "error", "message": detail}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
