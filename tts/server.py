#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>
"""Server lồng tiếng cục bộ của CrabbyCut — tab Âm thanh → "Lồng tiếng".

Nhận danh sách câu phụ đề có mốc thời gian, đọc từng câu bằng model TTS, co giãn cho vừa khung
rồi trộn thành file WAV đặt lên timeline. Backend Node (backend/tts-service.js) bật server này
khi cần, và nói chuyện qua HTTP 127.0.0.1.

VÌ SAO LÀ SERVER THƯỜNG TRÚ chứ không phải sidecar mỗi lượt một tiến trình như ASR: import
torch/onnxruntime + khởi động Python mất vài giây mỗi lượt. TỪ v1.1.17 model bị nhả NGAY khi mỗi
lượt xong (người dùng yêu cầu trả VRAM cho dựng phim/xuất GPU); CRAB_TTS_KEEP_LOADED=1 khôi phục
kiểu giữ ấm, khi đó model tự nhả sau IDLE_UNLOAD_SECONDS.

BA ENGINE (F5-TTS đã gỡ ở v1.1.17 — giấy phép weights tiếng Việt phi thương mại, không có giọng
mặc định; xem docs/KE_HOACH_V1_1_17.md):
  vieneu3 VieNeu-TTS v3 Turbo — MẶC ĐỊNH: 25 giọng Việt dựng sẵn + nhân bản giọng từ mẫu 3-8 s
          (không cần lời của mẫu). GPU (CUDA/MPS) bằng PyTorch, không có GPU thì ONNX trên CPU.
  vieneu  VieNeu-TTS v2 (port từ server TTS của CrabbyCut_Private): 7 giọng Việt dựng sẵn,
          chạy CPU.
  voxcpm  VoxCPM2 8-bit qua MLX — CHỈ macOS Apple Silicon (MLX không có trên Windows).
          Giọng tả bằng lời ("giọng nữ trẻ, ấm").

Model tải lần đầu qua tts/model_store.py — có tiến trình theo byte (GET /health → downloads).

Chạy tay:  npm run tts:serve   (= <python của .venv-tts> tts/server.py [--port 4124])
"""
from __future__ import annotations

import argparse
import importlib.util
import os
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

# Bộ cài .exe dùng Python NHÚNG (có tệp ._pth khoá sys.path, PYTHONPATH bị bỏ qua) nên gói của
# lồng tiếng được cài riêng bằng `pip --target` (xem scripts/setup_tts.js) và thêm vào đây.
_TTS_SITE = os.environ.get("CRAB_TTS_SITE", "").strip()
if _TTS_SITE and os.path.isdir(_TTS_SITE) and _TTS_SITE not in sys.path:
    sys.path.insert(0, _TTS_SITE)

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np  # noqa: E402

import dubbing_core as core  # noqa: E402
import model_store  # noqa: E402

DEFAULT_PORT = 4124
IDLE_UNLOAD_SECONDS = int(os.environ.get("CRAB_TTS_IDLE_UNLOAD", "300"))
PREVIEW_TEXT = "Xin chào, đây là giọng đọc thử cho video của bạn."


def log(message: str) -> None:
    print(f"[tts] {message}", flush=True)


def _has_module(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        return False


def _torch_device() -> str:
    forced = os.environ.get("CRAB_TTS_DEVICE", "").strip().lower()
    if forced in {"cpu", "cuda", "mps"}:
        return forced
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def _release_accelerator_memory() -> None:
    """Trả bộ nhớ GPU về hệ điều hành sau khi bỏ tham chiếu model.

    `_model = None` chỉ làm tensor thành rác; allocator của torch (CUDA lẫn MPS) và MLX vẫn GIỮ
    các khối đã cấp để dùng lại, nên nvidia-smi / Activity Monitor vẫn thấy chiếm chỗ cho tới khi
    xoá cache. Mỗi nhánh tự bọc try: máy không có torch (chỉ MLX) hay ngược lại đều phải chạy."""
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.synchronize()
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
        mps = getattr(torch, "mps", None)
        if mps is not None and getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            mps.empty_cache()
    except Exception:
        pass
    if "mlx.core" in sys.modules:
        try:
            import mlx.core as mx
            clear = getattr(mx, "clear_cache", None) or getattr(getattr(mx, "metal", None), "clear_cache", None)
            if clear:
                clear()
        except Exception:
            pass


def _keep_loaded_after_job() -> bool:
    """Mặc định nhả model NGAY khi một lượt (lồng tiếng hay nghe thử) xong — yêu cầu v1.1.17:
    VRAM phải trả lại cho dựng phim/xuất GPU. Đặt CRAB_TTS_KEEP_LOADED=1 để giữ như cũ (chỉ
    nhả sau IDLE_UNLOAD_SECONDS), tiện khi đo/thử nhiều lượt liền."""
    return os.environ.get("CRAB_TTS_KEEP_LOADED", "").strip().lower() in {"1", "true", "yes"}


class UserError(RuntimeError):
    """Lỗi do dữ liệu người dùng đưa vào (thiếu giọng mẫu, câu rỗng…) -> HTTP 400."""


# ── Engine ───────────────────────────────────────────────────────────────────

class Engine:
    name = ""
    label = ""
    sample_rate = 24000
    models: List[str] = []
    module = ""             # gói Python bắt buộc
    platforms: Optional[List[str]] = None
    chunked = True          # cắt đoạn dài + canh chunk câm ở dubbing_core
    clone = False           # nhận giọng mẫu (hồ sơ giọng trong Cài đặt)
    clone_needs_text = False  # nhân bản cần cả lời nói trong mẫu

    def __init__(self) -> None:
        self._model: Any = None
        self._lock = threading.RLock()
        self.last_used = 0.0
        self.load_seconds = 0.0
        self.device = ""

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def availability(self) -> tuple[bool, str]:
        if self.platforms and sys.platform not in self.platforms:
            return False, f"{self.label} chỉ chạy trên macOS (MLX)."
        if self.module and not _has_module(self.module):
            return False, f"Thiếu gói Python '{self.module}' trong môi trường lồng tiếng."
        return True, ""

    def ensure_models(self) -> Dict[str, Path]:
        return {key: model_store.ensure(key) for key in self.models}

    def ensure(self) -> Any:
        with self._lock:
            if self._model is None:
                ok, reason = self.availability()
                if not ok:
                    raise UserError(reason)
                paths = self.ensure_models()
                started = time.time()
                log(f"đang nạp {self.name}…")
                self._model = self._build(paths)
                self.load_seconds = time.time() - started
                log(f"nạp {self.name} xong sau {self.load_seconds:.1f}s (thiết bị: {self.device or 'cpu'})")
            self.last_used = time.time()
            return self._model

    def unload(self) -> bool:
        with self._lock:
            if self._model is None:
                return False
            self._model = None
            _release_accelerator_memory()
            log(f"đã nhả {self.name}")
            return True

    def voices(self) -> List[str]:
        return []

    def voice_details(self) -> List[dict]:
        return [{"id": v, "label": v, "description": ""} for v in self.voices()]

    def prepare(self, opts: dict) -> dict:
        """Chuẩn bị một lượt (kiểm giọng mẫu…). Trả opts đã chuẩn hoá."""
        return opts

    def _build(self, paths: Dict[str, Path]) -> Any:
        raise NotImplementedError

    def _synth_once(self, text: str, opts: dict, target: Optional[float]) -> tuple[np.ndarray, int]:
        raise NotImplementedError

    def synth(self, text: str, opts: dict, target: Optional[float] = None) -> tuple[np.ndarray, int, dict]:
        """Cắt đoạn -> sinh -> canh chunk câm (sinh lại tối đa CHUNK_RETRIES lượt) -> nối."""
        self.ensure()
        with self._lock:
            self.last_used = time.time()
            if not self.chunked:
                audio, rate = self._synth_once(text, opts, target)
                return core.to_mono(audio), rate, {"chunks": 1, "retries": 0, "suspects": []}
            chunks = core.split_for_tts(text)
            if not chunks:
                raise UserError("Câu rỗng.")
            pieces: List[np.ndarray] = []
            rate = self.sample_rate
            retries = 0
            suspects: List[str] = []
            for index, chunk in enumerate(chunks):
                best: Optional[np.ndarray] = None
                best_reason = ""
                for attempt in range(core.CHUNK_RETRIES + 1):
                    audio, rate = self._synth_once(chunk, opts, None if len(chunks) > 1 else target)
                    audio = core.to_mono(audio)
                    reason = core.looks_degenerate(audio, rate)
                    if not reason:
                        best, best_reason = audio, ""
                        break
                    if best is None or audio.size > best.size:
                        best, best_reason = audio, reason
                    if attempt < core.CHUNK_RETRIES:
                        retries += 1
                if best_reason:
                    suspects.append(f"#{index + 1} ({best_reason})")
                pieces.append(best if best is not None else np.zeros(1, dtype=np.float32))
            gap = np.zeros(int(rate * core.CHUNK_GAP_SEC), dtype=np.float32)
            joined = pieces[0]
            for piece in pieces[1:]:
                joined = np.concatenate([joined, gap, piece])
            return joined, rate, {"chunks": len(chunks), "retries": retries, "suspects": suspects}


def _cuda_capability() -> tuple:
    try:
        import torch
        if torch.cuda.is_available():
            return tuple(torch.cuda.get_device_capability(0))
    except Exception:
        pass
    return ()


class VieNeu3Engine(Engine):
    """VieNeu-TTS v3 Turbo — engine mặc định từ v1.1.17 (thay F5-TTS, xem docs/KE_HOACH_V1_1_17.md).

    25 giọng Việt dựng sẵn (Bắc/Trung/Nam, nhiều phong cách đọc) + NHÂN BẢN GIỌNG từ một mẫu 3-8 s,
    KHÔNG cần gõ lời của mẫu. Ra 48 kHz. Apache-2.0 (cả model lẫn codec MOSS).

    Hai đường, chọn theo máy — mỗi đường một bộ tệp riêng (model_store) nên chỉ tải đúng thứ cần:
      · GPU (CUDA trên Windows, MPS trên macOS): PyTorch, `vieneu3-torch` + `moss-nano`.
      · CPU (không có GPU dùng được):            ONNX Runtime, `vieneu3-onnx` + `moss-nano-onnx`.
    Người dùng yêu cầu macOS PHẢI chạy GPU -> trên Mac có MPS là dùng MPS, không rơi về ONNX/CPU."""

    name = "vieneu3"
    label = "VieNeu-TTS v3 Turbo"
    sample_rate = 48000
    module = "vieneu"
    chunked = False          # SDK tự cắt câu (max_chars) + tự sinh lại chunk "nói lảm nhảm"
    clone = True
    clone_needs_text = False

    def __init__(self) -> None:
        super().__init__()
        self._planned = ""

    def planned_device(self) -> str:
        if not self._planned:
            forced = os.environ.get("CRAB_TTS_DEVICE", "").strip().lower()
            self._planned = forced if forced in {"cpu", "cuda", "mps"} else _torch_device()
        return self._planned

    @property
    def models(self) -> List[str]:  # type: ignore[override]
        if self.planned_device() == "cpu":
            return ["vieneu3-onnx", "moss-nano-onnx"]
        return ["vieneu3-torch", "moss-nano"]

    def _dtype(self, device: str) -> str:
        # SDK để "auto" thì CUDA nào cũng nhận bf16 — GTX 10xx (Pascal, sm_6x) chỉ GIẢ LẬP bf16 và
        # fp16 của nó chạy ở 1/64 tốc độ fp32, nên dưới Volta phải ép fp32.
        if device == "cuda":
            cap = _cuda_capability()
            if cap and cap >= (8, 0):
                return "bfloat16"
            if cap and cap >= (7, 0):
                return "float16"
            return "float32"
        return "float32"

    def _build(self, paths: Dict[str, Path]) -> Any:
        from vieneu.v3turbo import V3TurboVieNeuTTS

        device = self.planned_device()
        if device == "cpu":
            from vieneu._v3_turbo_engine import onnx_runtime_lite as lite

            root = paths["vieneu3-onnx"]
            codec_dir = paths["moss-nano-onnx"]
            # SDK không chuyển `codec_dir` xuống engine ONNX mà tự tải codec từ Hub vào
            # ~/.cache/huggingface (ngoài kho model của app, không có tiến trình). Chặn đúng lượt
            # tải codec đó và trỏ về bản model_store đã tải.
            original = lite.OnnxV3LiteEngine._fetch
            if not getattr(original, "_crab_local", False):
                def _fetch(repo: str, files: List[str], subfolder: Optional[str]) -> Path:
                    if repo == lite._CODEC_REPO:
                        return codec_dir
                    return original(repo, files, subfolder)
                _fetch._crab_local = True  # type: ignore[attr-defined]
                lite.OnnxV3LiteEngine._fetch = staticmethod(_fetch)
            self.device = "cpu"
            return V3TurboVieNeuTTS(backbone_repo=str(root), backend="onnx",
                                    onnx_dir=str(root / "onnx_update"))
        root = paths["vieneu3-torch"]
        self.device = device
        return V3TurboVieNeuTTS(backbone_repo=str(root), model_subfolder="update",
                                moss_tokenizer=str(paths["moss-nano"]), device=device,
                                dtype=self._dtype(device), backend="pytorch")

    def voice_details(self) -> List[dict]:
        """Giọng dựng sẵn, đọc thẳng từ tệp JSON của SDK — không cần nạp model để hiện danh sách."""
        try:
            spec = importlib.util.find_spec("vieneu")
            base = Path(list(spec.submodule_search_locations)[0]) if spec else None
            import json
            data = json.loads((base / "assets" / "voices_v3_turbo.json").read_text(encoding="utf-8"))
            presets = data.get("presets") or {}
            names = sorted(presets, key=lambda n: (presets[n].get("featured") is None,
                                                   presets[n].get("featured") or 0))
            return [{"id": n, "label": n, "description": str(presets[n].get("description") or "")}
                    for n in names]
        except Exception:
            return []

    def voices(self) -> List[str]:
        return [v["id"] for v in self.voice_details()]

    def prepare(self, opts: dict) -> dict:
        ref_audio = str(opts.get("ref_audio") or "").strip()
        if ref_audio and not Path(ref_audio).is_file():
            raise UserError("Không tìm thấy tệp giọng mẫu của hồ sơ giọng — hãy tạo lại hồ sơ trong Cài đặt.")
        return opts

    def _synth_once(self, text: str, opts: dict, target: Optional[float]) -> tuple[np.ndarray, int]:
        model = self.ensure()
        ref_audio = str(opts.get("ref_audio") or "").strip()
        if ref_audio:
            audio = model.infer(text, ref_audio=ref_audio)
        else:
            name = str(opts.get("voice") or "").strip() or None
            try:
                audio = model.infer(text, voice=name) if name else model.infer(text)
            except ValueError as exc:
                raise UserError(f"Giọng '{name}' không có trong VieNeu-TTS v3.") from exc
        rate = int(getattr(model, "sample_rate", self.sample_rate) or self.sample_rate)
        audio = core.to_mono(audio)
        speed = float(opts.get("speed") or 1.0)
        if abs(speed - 1.0) > 1e-3:
            audio, _ = core.change_speed(audio, rate, speed)
        return audio, rate


class VieNeuEngine(Engine):
    """VieNeu-TTS v2, đường safetensors + codec ONNX (port nguyên từ CrabbyCut_Private).

    BẪY: `vieneu` 3.x mặc định mode "v3turbo" — một model KHÁC. `vieneu.standard.VieNeuTTS` mới
    ăn snapshot v2. `gguf_filename=None` là CỐ Ý: đường GGUF cần llama-cpp-python, không có wheel
    dựng sẵn cho mọi nền tảng."""

    name = "vieneu"
    label = "VieNeu-TTS"
    sample_rate = 24000
    models = ["vieneu-tts", "neucodec-onnx"]
    module = "vieneu"
    default_voice = "Ly"
    PRESETS = ["Ly", "Ngoc", "Tuyen", "Binh", "Vinh", "Doan", "Sơn"]

    def _build(self, paths: Dict[str, Path]) -> Any:
        from vieneu.standard import VieNeuTTS
        from vieneu.utils import NeuCodecOnnx

        class LocalCodecVieNeuTTS(VieNeuTTS):
            def _load_codec(self, codec_repo: str, codec_device: str) -> None:
                if Path(codec_repo).is_file():
                    self.codec = NeuCodecOnnx(codec_repo)
                    self._is_onnx_codec = True
                    return
                super()._load_codec(codec_repo, codec_device)

        self.device = "cpu"
        codec = paths["neucodec-onnx"] / "model.onnx"
        return LocalCodecVieNeuTTS(backbone_repo=str(paths["vieneu-tts"]), codec_repo=str(codec),
                                   gguf_filename=None, backbone_device="cpu")

    def voices(self) -> List[str]:
        if self._model is not None:
            try:
                return list(self._model._preset_voices)
            except Exception:
                pass
        return list(self.PRESETS)

    def _synth_once(self, text: str, opts: dict, target: Optional[float]) -> tuple[np.ndarray, int]:
        model = self.ensure()
        presets = model._preset_voices
        name = str(opts.get("voice") or "").strip() or self.default_voice
        if name not in presets:
            raise UserError(f"Giọng '{name}' không có. Có sẵn: {', '.join(presets)}")
        # max_chars rất lớn: đã tự cắt ở split_for_tts, để thư viện sinh MỘT lượt thì mới canh
        # được đúng lượt đó có câm hay không.
        audio = model.infer(text, voice=presets[name], max_chars=100000)
        rate = int(getattr(model, "sample_rate", self.sample_rate) or self.sample_rate)
        audio = core.to_mono(audio)
        speed = float(opts.get("speed") or 1.0)
        if abs(speed - 1.0) > 1e-3:
            audio, _ = core.change_speed(audio, rate, speed)
        return audio, rate


class VoxCPMEngine(Engine):
    """VoxCPM2-8bit qua MLX (GPU Metal), ra 48 kHz, đa ngôn ngữ. `voice` = MÔ TẢ giọng."""

    name = "voxcpm"
    label = "VoxCPM2"
    sample_rate = 48000
    models = ["voxcpm2-8bit"]
    module = "mlx_audio"
    platforms = ["darwin"]

    def _build(self, paths: Dict[str, Path]) -> Any:
        from mlx_audio.tts import load_model
        self.device = "mps"
        return load_model(str(paths["voxcpm2-8bit"]))

    def _synth_once(self, text: str, opts: dict, target: Optional[float]) -> tuple[np.ndarray, int]:
        model = self.ensure()
        instruct = str(opts.get("voice") or "").strip() or None
        chunks, rate = [], self.sample_rate
        for result in model.generate(text=text, instruct=instruct):
            chunks.append(core.to_mono(result.audio))
            rate = int(getattr(result, "sample_rate", None) or rate)
        if not chunks:
            raise RuntimeError("VoxCPM2 không sinh ra âm thanh nào")
        audio = np.concatenate(chunks)
        speed = float(opts.get("speed") or 1.0)
        if abs(speed - 1.0) > 1e-3:
            audio, _ = core.change_speed(audio, rate, speed)
        return audio, rate


ENGINES: Dict[str, Engine] = {e.name: e for e in (VieNeu3Engine(), VieNeuEngine(), VoxCPMEngine())}


def engine_info(engine: Engine) -> dict:
    ok, reason = engine.availability()
    return {
        "id": engine.name,
        "label": engine.label,
        "available": ok,
        "reason": reason,
        "loaded": engine.loaded,
        "device": engine.device,
        "sample_rate": engine.sample_rate,
        "voices": engine.voices(),
        "voice_details": engine.voice_details(),
        "clone": bool(engine.clone),
        "clone_needs_text": bool(engine.clone_needs_text),
        "models": model_store.status(engine.models),
        "idle_seconds": round(time.time() - engine.last_used, 1) if engine.last_used else None,
    }


# ── Job lồng tiếng ───────────────────────────────────────────────────────────

_synth_gate = threading.Lock()   # một lượt sinh tại một thời điểm — model nặng, máy 8-16 GB


class Cancelled(Exception):
    pass


class DubJob:
    def __init__(self, params: dict) -> None:
        self.id = f"dub_{int(time.time() * 1000):x}_{uuid.uuid4().hex[:6]}"
        self.params = params
        self.state = "queued"     # queued|running|done|error|cancelled
        self.stage = "queued"     # models|loading|synth|merge|done
        self.done = 0
        self.total = 0
        self.message = ""
        self.error = ""
        self.warnings: List[str] = []
        self.result: Optional[dict] = None
        self.created = time.time()
        self.finished: Optional[float] = None
        self.cancel_event = threading.Event()

    def public(self) -> dict:
        return {
            "job_id": self.id, "state": self.state, "stage": self.stage,
            "done": self.done, "total": self.total, "message": self.message,
            "error": self.error, "warnings": self.warnings, "result": self.result,
            "elapsed_ms": int(((self.finished or time.time()) - self.created) * 1000),
        }

    def check(self) -> None:
        if self.cancel_event.is_set():
            raise Cancelled()

    def run(self) -> None:
        self.state = "running"
        try:
            with _synth_gate:
                try:
                    self._run()
                finally:
                    # Nhả model khi CÒN giữ cổng và job còn "running": giao diện thấy "done" là
                    # VRAM đã trống, và không lượt mới nào kịp nạp model rồi bị lượt này nhả
                    # mất giữa chừng (create_job trả 409 khi còn job đang chạy).
                    self._release_engine()
            self.state = "done"
            self.stage = "done"
        except Cancelled:
            self.state = "cancelled"
            self.message = "Đã huỷ."
        except Exception as exc:  # noqa: BLE001 — mọi lỗi phải về được giao diện
            self.state = "error"
            self.error = str(exc) or exc.__class__.__name__
            if not isinstance(exc, UserError):
                traceback.print_exc()
        finally:
            self.finished = time.time()

    def _release_engine(self) -> None:
        engine = ENGINES.get(str(self.params.get("engine") or ""))
        if engine is None or _keep_loaded_after_job():
            return
        try:
            engine.unload()
        except Exception as exc:  # noqa: BLE001 — nhả lỗi không được che kết quả lượt sinh
            log(f"nhả {engine.name} lỗi: {exc}")

    def _run(self) -> None:
        import soundfile as sf

        params = self.params
        engine = ENGINES.get(str(params.get("engine") or ""))
        if engine is None:
            raise UserError(f"Không có engine '{params.get('engine')}'.")
        out_dir = Path(str(params.get("output_dir") or ""))
        if not out_dir.is_absolute():
            raise UserError("output_dir phải là đường dẫn tuyệt đối.")
        out_dir.mkdir(parents=True, exist_ok=True)

        if params.get("preview"):
            raw = [{"start": 0, "end": 60, "text": str(params.get("text") or PREVIEW_TEXT)}]
        else:
            raw = params.get("cues") or []
        cues, skipped = core.normalize_cues(raw)
        if not cues:
            raise UserError("Không có câu nào đọc được (câu rỗng, chỉ ký hiệu hoặc chú thích nhạc).")
        self.total = len(cues)

        self.stage = "models"
        pending = [key for key in engine.models if not model_store.is_ready(key)]
        if pending:
            self.message = "Đang tải mô hình lần đầu…"
        engine.ensure_models()
        self.check()

        self.stage = "loading"
        self.message = f"Đang nạp {engine.label}…"
        engine.ensure()
        self.check()

        opts = {
            "voice": params.get("voice"),
            "ref_audio": params.get("ref_audio"),
            "ref_text": params.get("ref_text"),
            "speed": max(0.5, min(2.0, float(params.get("speed") or 1.0))),
            "timing_mode": params.get("timing_mode") or "auto_fit",
        }
        opts = engine.prepare(opts)
        planner = core.TimelinePlanner(
            mode="fixed_duration" if params.get("preview") else opts["timing_mode"],
            max_speed=float(params.get("max_speed") or core.DEFAULT_MAX_SPEED),
            gap=float(params.get("gap") if params.get("gap") is not None else core.DEFAULT_GAP_SEC),
        )

        self.stage = "synth"
        rate = 0
        clips: List[tuple] = []
        clip_rows: List[dict] = []
        suspects: List[str] = []
        split = bool(params.get("split_clips"))
        # Tên tệp = tên hiện trên thẻ asset trong panel -> đặt theo tệp phụ đề cho dễ nhận ra.
        base = "".join(ch for ch in str(params.get("name") or "") if ch not in '<>:"/\\|?*').strip()[:80] or "dubbing"
        for cue in cues:
            self.check()
            self.message = cue.text[:80]
            audio, sr, info = engine.synth(cue.text, opts, target=cue.duration)
            if not rate:
                rate = sr
            elif sr != rate:
                audio = core.resample_linear(audio, sr, rate)
            audio = core.trim_silence_edges(audio, rate)
            audio, placement = planner.place(cue, audio, rate)
            clips.append((placement, audio))
            row = {**placement.as_dict(), "text": cue.text}
            if split:
                path = out_dir / f"{base} {cue.seq:03d}.wav"
                sf.write(str(path), audio, rate, format="WAV", subtype="PCM_16")
                row["path"] = str(path)
            clip_rows.append(row)
            suspects += [f"câu {cue.seq} {s}" for s in info.get("suspects", [])]
            self.done += 1

        self.check()
        self.stage = "merge"
        self.message = "Đang ghép…"
        mixed, origin = core.mix_placements(clips, rate)
        full_path = out_dir / ("preview.wav" if params.get("preview") else f"{base}.wav")
        sf.write(str(full_path), mixed, rate, format="WAV", subtype="PCM_16")

        summary = core.summarize([p for p, _ in clips])
        if summary["overflowed"]:
            self.warnings.append(f"{summary['overflowed']} câu vẫn dài hơn khung sau khi tăng tốc "
                                 f"{summary['max_speed']}x (tràn tối đa {summary['max_overflow']}s).")
        if suspects:
            self.warnings.append("Có đoạn nghi bị câm: " + "; ".join(suspects[:6]))
        self.result = {
            "engine": engine.name,
            "sample_rate": rate,
            "full": {"path": str(full_path), "start": round(origin, 4),
                     "duration": round(mixed.size / float(rate), 4)},
            "clips": clip_rows,
            "summary": summary,
            "skipped": skipped,
        }
        self.message = ""


_jobs: Dict[str, DubJob] = {}
_jobs_lock = threading.Lock()


def _active_job() -> Optional[DubJob]:
    with _jobs_lock:
        return next((j for j in _jobs.values() if j.state in ("queued", "running")), None)


def _prune_jobs() -> None:
    with _jobs_lock:
        finished = sorted((j for j in _jobs.values() if j.finished), key=lambda j: j.finished)
        for job in finished[:-20]:
            _jobs.pop(job.id, None)


# ── HTTP ─────────────────────────────────────────────────────────────────────

from fastapi import Body, FastAPI, HTTPException  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

app = FastAPI(title="CrabbyCut TTS", version="2.0")


@app.exception_handler(UserError)
def _user_error(_request, exc: UserError) -> JSONResponse:
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(RuntimeError)
def _runtime_error(_request, exc: RuntimeError) -> JSONResponse:
    log(f"lỗi: {exc}")
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.get("/health")
def health() -> dict:
    active = _active_job()
    return {
        "status": "ok",
        "app": "crabbycut-tts",
        "pid": os.getpid(),
        "model_root": str(model_store.model_root()),
        "engines": {name: {"loaded": e.loaded, "device": e.device} for name, e in ENGINES.items()},
        "downloads": model_store.downloads_snapshot(),
        "active_job": active.id if active else None,
        "idle_unload_seconds": IDLE_UNLOAD_SECONDS,
    }


@app.get("/v1/engines")
def engines() -> dict:
    return {"engines": [engine_info(e) for e in ENGINES.values()], "model_root": str(model_store.model_root())}


@app.post("/v1/models/ensure")
def ensure_models(payload: dict = Body(default={})) -> dict:
    """Tải trước model của một engine (nút "Tải mô hình") — chạy nền, tiến trình ở /health."""
    engine = ENGINES.get(str(payload.get("engine") or ""))
    if engine is None:
        raise UserError("Không có engine này.")
    ok, reason = engine.availability()
    if not ok:
        raise UserError(reason)

    def work() -> None:
        try:
            engine.ensure_models()
        except Exception as exc:  # noqa: BLE001 — trạng thái lỗi đã ghi vào downloads
            log(f"tải model {engine.name} lỗi: {exc}")

    threading.Thread(target=work, name=f"ensure-{engine.name}", daemon=True).start()
    return {"started": True}


@app.post("/v1/dub/jobs")
def create_job(payload: dict = Body(...)) -> dict:
    if _active_job():
        raise HTTPException(status_code=409, detail="Đang có một lượt lồng tiếng chạy. Đợi xong hoặc huỷ trước.")
    job = DubJob(payload)
    with _jobs_lock:
        _jobs[job.id] = job
    threading.Thread(target=job.run, name=job.id, daemon=True).start()
    _prune_jobs()
    return job.public()


@app.get("/v1/dub/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy lượt lồng tiếng.")
    return job.public()


@app.post("/v1/dub/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    job = _jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Không tìm thấy lượt lồng tiếng.")
    job.cancel_event.set()
    return job.public()


@app.post("/unload")
def unload() -> dict:
    return {"unloaded": [name for name, e in ENGINES.items() if e.unload()]}


@app.post("/shutdown")
def shutdown() -> dict:
    unloaded = [name for name, e in ENGINES.items() if e.unload()]
    threading.Timer(0.3, lambda: os._exit(0)).start()
    return {"unloaded": unloaded, "exiting": True}


def _idle_watcher() -> None:
    while True:
        time.sleep(30)
        if _active_job():
            continue
        now = time.time()
        for engine in ENGINES.values():
            if engine.loaded and now - engine.last_used > IDLE_UNLOAD_SECONDS:
                engine.unload()


def _parent_watcher(parent_pid: int) -> None:
    """Backend chết bất thường (bị kill, crash) thì server không được sống mồ côi giữ 1-2 GB RAM."""
    while True:
        time.sleep(5)
        try:
            if sys.platform == "win32":
                import ctypes
                handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, parent_pid)  # QUERY_LIMITED_INFORMATION
                if not handle:
                    os._exit(0)
                code = ctypes.c_ulong()
                ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
                ctypes.windll.kernel32.CloseHandle(handle)
                if code.value != 259:  # STILL_ACTIVE
                    os._exit(0)
            else:
                os.kill(parent_pid, 0)
        except OSError:
            os._exit(0)
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="CrabbyCut TTS server")
    parser.add_argument("--port", type=int, default=int(os.environ.get("CRAB_TTS_PORT", DEFAULT_PORT)))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()
    threading.Thread(target=_idle_watcher, name="idle-unload", daemon=True).start()
    if args.parent_pid:
        threading.Thread(target=_parent_watcher, args=(args.parent_pid,), name="parent", daemon=True).start()
    import uvicorn
    log(f"lắng nghe http://{args.host}:{args.port} · model: {model_store.model_root()}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
