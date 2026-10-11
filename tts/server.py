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
          backbone lên GPU khi có (CUDA/MPS).
  voxcpm  VoxCPM2 8-bit qua MLX — CHỈ macOS Apple Silicon (MLX không có trên Windows).
          Giọng tả bằng lời ("giọng nữ trẻ, ấm").

Model tải lần đầu qua tts/model_store.py — có tiến trình theo byte (GET /health → downloads).

Chạy tay:  npm run tts:serve   (= <python của .venv-tts> tts/server.py [--port 4124])
"""
from __future__ import annotations

import argparse
import contextlib
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


@contextlib.contextmanager
def _hub_offline():
    """Tạm bật chế độ offline của huggingface_hub trong lúc NẠP model.

    Mọi tệp đã nằm sẵn trong kho model (model_store tải trước), nhưng thư viện vẫn gọi Hub để
    "chạm" config.json/voices.json theo repo id — trỏ đường dẫn local thì lượt gọi đó hỏng sau
    vài lần thử lại mạng. Đo trên VieNeu v2 (GTX 1060): nạp 109 s -> ~42 s khi offline.
    Cờ được đọc LÚC GỌI (huggingface_hub.is_offline_mode trả biến cấp module) nên bật tạm được.
    Không bật khi model_store đang tải dở một model khác: lượt tải đó cần mạng."""
    if any(d.get("state") in ("downloading", "preparing") for d in model_store.downloads_snapshot()):
        yield
        return
    saved = []
    try:
        import huggingface_hub
        from huggingface_hub import constants
        holder = sys.modules.get(huggingface_hub.is_offline_mode.__module__)
        for mod in {id(m): m for m in (constants, holder) if m is not None}.values():
            if hasattr(mod, "HF_HUB_OFFLINE"):
                saved.append((mod, mod.HF_HUB_OFFLINE))
                mod.HF_HUB_OFFLINE = True
    except Exception:
        pass
    try:
        yield
    finally:
        for mod, value in saved:
            mod.HF_HUB_OFFLINE = value


def _append_error_log(job: "DubJob", exc: BaseException) -> None:
    """Lỗi không phải do người dùng -> ghi kèm traceback vào `<kho model>/../logs/tts_errors.log`
    (bản cài: %LOCALAPPDATA%/CrabbyCut/logs, macOS: ~/Library/Application Support/CrabbyCut/logs).
    stdout của server chỉ còn trong terminal của backend — người dùng cuối không thấy được. Giữ
    tối đa ~512 KB: quá thì cắt nửa cũ."""
    try:
        folder = model_store.model_root().parent / "logs"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / "tts_errors.log"
        if path.is_file() and path.stat().st_size > 512 * 1024:
            data = path.read_bytes()
            path.write_bytes(data[len(data) // 2:])
        engine = ENGINES.get(str(job.params.get("engine") or ""))
        head = (f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} · engine={job.params.get('engine')} "
                f"· device={getattr(engine, 'device', '')} · python={sys.version.split()[0]} · {sys.platform}\n")
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(head + "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
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

    def configure(self, params: dict) -> None:
        """Gọi ĐẦU mỗi lượt, trước khi tải/nạp model: engine nhiều checkpoint (Qwen3-TTS) chọn
        checkpoint theo tuỳ chọn của lượt ở đây. Mặc định không làm gì."""

    def extras(self) -> dict:
        """Thông tin riêng của engine cho giao diện (ngôn ngữ, chế độ…)."""
        return {}

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
                with _hub_offline():
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

        # Backbone (transformers, fp32) lên GPU khi có — v1.1.17 yêu cầu lồng tiếng chạy GPU. Đo trên
        # GTX 1060 trước đây: ghim CPU thì nạp 68 s + một câu 112 s. Codec ONNX vẫn ở CPU (nhẹ).
        self.device = _torch_device()
        codec = paths["neucodec-onnx"] / "model.onnx"
        return LocalCodecVieNeuTTS(backbone_repo=str(paths["vieneu-tts"]), codec_repo=str(codec),
                                   gguf_filename=None, backbone_device=self.device)

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
    """VoxCPM2-8bit qua MLX (GPU Metal), ra 48 kHz, đa ngôn ngữ. `voice` = MÔ TẢ giọng.

    v1.1.17 — người dùng báo "không tạo được giọng" trên macOS (chưa có log). Mã gọi đúng API
    mlx-audio hiện hành, nên sửa theo các nguyên nhân khả dĩ nhất (docs/KE_HOACH_V1_1_17.md):

    1. MỘT LUỒNG MLX CỐ ĐỊNH. Từ mlx 0.31.2, GPU stream gắn với luồng tạo ra nó: mảng/stream tạo
       ở luồng A mà dùng ở luồng B thì nổ "There is no Stream(gpu, 0) in current thread"
       (ml-explore/mlx#3727, Blaizzy/mlx-audio#744). Server mở một threading.Thread MỚI cho mỗi
       job -> lượt nạp và lượt sinh chạy ở hai luồng khác nhau. Nên mọi lệnh MLX (import, nạp,
       sinh, chuyển sang numpy, xoá cache) đi qua `_MLX` — executor đúng một luồng.
    2. CHỈ Apple Silicon + macOS 14: MLX chỉ có wheel arm64 macosx_14_0 trở lên. Mac Intel / macOS
       13 trước đây vẫn được báo "có sẵn" rồi chết lúc cài hoặc lúc nạp.
    3. Ghi rõ tham số sinh (inference_timesteps, cfg_value) thay vì phụ thuộc mặc định đổi theo bản.
    CHƯA KIỂM TRÊN MAC THẬT — máy dựng tính năng là Windows."""

    name = "voxcpm"
    label = "VoxCPM2"
    sample_rate = 48000
    models = ["voxcpm2-8bit"]
    module = "mlx_audio"
    platforms = ["darwin"]
    INFERENCE_TIMESTEPS = 10
    CFG_VALUE = 2.0

    def availability(self) -> tuple[bool, str]:
        ok, reason = super().availability()
        if sys.platform != "darwin":
            return ok, reason
        import platform
        if platform.machine() != "arm64":
            return False, f"{self.label} cần máy Mac chip Apple (M1 trở lên) — MLX không chạy trên Mac Intel."
        try:
            major = int((platform.mac_ver()[0] or "0").split(".")[0])
        except ValueError:
            major = 0
        if major and major < 14:
            return False, f"{self.label} cần macOS 14 (Sonoma) trở lên."
        return ok, reason

    def _build(self, paths: Dict[str, Path]) -> Any:
        def load():
            from mlx_audio.tts import load_model
            return load_model(str(paths["voxcpm2-8bit"]))
        self.device = "mps"
        return _mlx_run(load)

    def unload(self) -> bool:
        with self._lock:
            if self._model is None:
                return False
            self._model = None
        # Xoá cache Metal trên CHÍNH luồng MLX (cache gắn với stream của luồng đó).
        try:
            _mlx_run(_release_accelerator_memory)
        except Exception:
            pass
        log(f"đã nhả {self.name}")
        return True

    def _synth_once(self, text: str, opts: dict, target: Optional[float]) -> tuple[np.ndarray, int]:
        model = self.ensure()
        instruct = str(opts.get("voice") or "").strip() or None

        def generate() -> tuple[np.ndarray, int]:
            import mlx.core as mx
            chunks, rate = [], self.sample_rate
            for result in model.generate(text=text, instruct=instruct,
                                         inference_timesteps=self.INFERENCE_TIMESTEPS, cfg_value=self.CFG_VALUE):
                audio = result.audio
                mx.eval(audio)
                # float32 TƯỜNG MINH: np.asarray(mx.array bfloat16) không chuyển được.
                chunks.append(core.to_mono(np.array(audio.astype(mx.float32))))
                rate = int(getattr(result, "sample_rate", None) or rate)
            return (np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)), rate

        audio, rate = _mlx_run(generate)
        if not audio.size:
            raise RuntimeError("VoxCPM2 không sinh ra âm thanh nào")
        speed = float(opts.get("speed") or 1.0)
        if abs(speed - 1.0) > 1e-3:
            audio, _ = core.change_speed(audio, rate, speed)
        return audio, rate


_MLX_EXEC = None   # ThreadPoolExecutor(max_workers=1) — xem VoxCPMEngine (MLX gắn GPU stream với luồng)


def _mlx_run(fn, *args, **kwargs):
    """Chạy một việc MLX trên ĐÚNG MỘT luồng cố định cho cả server (mọi engine MLX dùng chung)."""
    global _MLX_EXEC
    if _MLX_EXEC is None:
        from concurrent.futures import ThreadPoolExecutor
        _MLX_EXEC = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")
    return _MLX_EXEC.submit(fn, *args, **kwargs).result()


def _mlx_audio_array(audio) -> np.ndarray:
    """mx.array (có thể bf16) -> numpy float32 mono. Gọi TRONG luồng MLX."""
    import mlx.core as mx
    mx.eval(audio)
    return core.to_mono(np.array(audio.astype(mx.float32)))


def _cuda_total_gib() -> float:
    try:
        import torch
        if torch.cuda.is_available():
            return torch.cuda.get_device_properties(0).total_memory / float(1 << 30)
    except Exception:
        pass
    return 0.0


def _torch_dtype_for(device: str):
    """fp32 trên CPU/MPS và GPU trước Volta (GTX 10xx: bf16 chỉ giả lập, fp16 chạy 1/64 tốc độ);
    fp16 từ Volta; bf16 từ Ampere."""
    import torch
    if device == "cuda":
        cap = _cuda_capability()
        if cap and cap >= (8, 0):
            return torch.bfloat16
        if cap and cap >= (7, 0):
            return torch.float16
    return torch.float32


class Qwen3Engine(Engine):
    """Qwen3-TTS (Alibaba, Apache-2.0) — v1.1.17, người dùng chốt 2026-10-11.

    Ba CHẾ ĐỘ, mỗi chế độ một checkpoint riêng (tải theo nhu cầu):
      custom  0.6B CustomVoice — 9 giọng dựng sẵn, `instruct` chỉnh cảm xúc/phong cách bằng lời.
      clone   0.6B Base — nhân bản từ hồ sơ giọng; có lời mẫu thì dùng (tốt hơn), không có thì chỉ
              lấy đặc trưng giọng (x-vector).
      design  1.7B VoiceDesign — tạo giọng từ MÔ TẢ. Chỉ mở khi đủ sức: Mac (MLX) hoặc GPU NVIDIA
              từ Volta (fp16/bf16) có >= 7,5 GiB VRAM — fp32 trên GTX 10xx cần ~7,7 GB (không vừa 6 GB).
    10 ngôn ngữ (zh en ja ko de fr ru pt es it), KHÔNG có tiếng Việt chính thức.

    Windows/Linux: gói `qwen-tts` trong môi trường RIÊNG .venv-tts-qwen (ghim transformers 4.57 — xem
    scripts/setup_tts.js ENVS). macOS: mlx-audio trong môi trường chính (GPU Metal).
    Server mở mỗi job một luồng mới -> lệnh MLX đi qua _mlx_run (xem VoxCPMEngine)."""

    name = "qwen3"
    label = "Qwen3-TTS"
    sample_rate = 24000
    chunked = False
    clone = True
    clone_needs_text = False
    SPEAKERS = [
        ("Vivian", "Nữ · tiếng Trung · trẻ, sáng"),
        ("Serena", "Nữ · tiếng Trung · dịu dàng"),
        ("Uncle_Fu", "Nam · tiếng Trung · trầm, từng trải"),
        ("Dylan", "Nam · tiếng Trung (Bắc Kinh)"),
        ("Eric", "Nam · tiếng Trung (Tứ Xuyên)"),
        ("Ryan", "Nam · tiếng Anh · khoẻ, nhịp nhanh"),
        ("Aiden", "Nam · tiếng Anh · trẻ, tươi"),
        ("Ono_Anna", "Nữ · tiếng Nhật"),
        ("Sohee", "Nữ · tiếng Hàn · ấm"),
    ]
    LANGUAGES = ["Auto", "Chinese", "English", "Japanese", "Korean", "German", "French", "Russian",
                 "Portuguese", "Spanish", "Italian"]
    MODES = ("custom", "clone", "design")

    def __init__(self) -> None:
        super().__init__()
        self._mode = "custom"
        self._loaded_key = ""

    @property
    def mlx(self) -> bool:
        return sys.platform == "darwin"

    @property
    def module(self) -> str:  # type: ignore[override]
        return "mlx_audio" if self.mlx else "qwen_tts"

    def _key(self, mode: str) -> str:
        base = {"custom": "qwen3-0.6b-custom", "clone": "qwen3-0.6b-base", "design": "qwen3-1.7b-design"}[mode]
        return f"{base}-mlx" if self.mlx else base

    @property
    def models(self) -> List[str]:  # type: ignore[override]
        return [self._key(self._mode)]

    def design_available(self) -> tuple[bool, str]:
        if self.mlx:
            return True, ""
        cap = _cuda_capability()
        if cap and cap >= (7, 0) and _cuda_total_gib() >= 7.5:
            return True, ""
        return False, "Thiết kế giọng (Qwen3-TTS 1.7B) cần GPU NVIDIA RTX 20 trở lên có từ 8 GB VRAM, hoặc máy Mac chip Apple."

    def configure(self, params: dict) -> None:
        options = params.get("engine_options") or {}
        mode = str(options.get("mode") or "").strip()
        if not mode:
            mode = "clone" if params.get("ref_audio") else "custom"
        if mode not in self.MODES:
            raise UserError(f"Chế độ Qwen3-TTS không hợp lệ: {mode}")
        if mode == "design":
            ok, reason = self.design_available()
            if not ok:
                raise UserError(reason)
        if mode == "clone" and not params.get("ref_audio"):
            raise UserError("Chế độ nhân bản cần một hồ sơ giọng — tạo trong Cài đặt → Hồ sơ giọng.")
        if mode != self._mode and self.loaded:
            self.unload()   # mỗi chế độ một checkpoint; đổi chế độ là nạp model khác
        self._mode = mode

    def _build(self, paths: Dict[str, Path]) -> Any:
        path = paths[self._key(self._mode)]
        self._loaded_key = self._key(self._mode)
        if self.mlx:
            def load():
                from mlx_audio.tts import load_model
                return load_model(str(path))
            self.device = "mps"
            return _mlx_run(load)
        from qwen_tts import Qwen3TTSModel
        self.device = _torch_device()
        device_map = "cuda:0" if self.device == "cuda" else self.device
        return Qwen3TTSModel.from_pretrained(str(path), device_map=device_map,
                                             dtype=_torch_dtype_for(self.device), attn_implementation="sdpa")

    def unload(self) -> bool:
        if not self.mlx:
            return super().unload()
        with self._lock:
            if self._model is None:
                return False
            self._model = None
        try:
            _mlx_run(_release_accelerator_memory)
        except Exception:
            pass
        log(f"đã nhả {self.name}")
        return True

    def voices(self) -> List[str]:
        return [name for name, _ in self.SPEAKERS]

    def voice_details(self) -> List[dict]:
        return [{"id": name, "label": name.replace("_", " "), "description": desc} for name, desc in self.SPEAKERS]

    def extras(self) -> dict:
        design_ok, design_reason = self.design_available()
        return {
            "languages": [{"id": code, "label": code} for code in self.LANGUAGES],
            "modes": [
                {"id": "custom", "available": True, "reason": "", "model": model_store.status([self._key("custom")])[0]},
                {"id": "clone", "available": True, "reason": "", "model": model_store.status([self._key("clone")])[0]},
                {"id": "design", "available": design_ok, "reason": design_reason,
                 "model": model_store.status([self._key("design")])[0]},
            ],
            "instruct": True,
        }

    def prepare(self, opts: dict) -> dict:
        ref_audio = str(opts.get("ref_audio") or "").strip()
        if ref_audio and not Path(ref_audio).is_file():
            raise UserError("Không tìm thấy tệp giọng mẫu của hồ sơ giọng — hãy tạo lại hồ sơ trong Cài đặt.")
        return opts

    def _synth_once(self, text: str, opts: dict, target: Optional[float]) -> tuple[np.ndarray, int]:
        model = self.ensure()
        options = opts.get("engine_options") or {}
        language = str(options.get("language") or "Auto")
        if language not in self.LANGUAGES:
            language = "Auto"
        instruct = str(options.get("instruct") or "").strip() or None
        speaker = str(opts.get("voice") or "").strip() or "Ryan"
        ref_audio = str(opts.get("ref_audio") or "").strip()
        ref_text = " ".join(str(opts.get("ref_text") or "").split())
        mode = self._mode
        if mode == "design" and not instruct:
            raise UserError("Thiết kế giọng cần một câu mô tả giọng (ví dụ: giọng nữ trẻ, ấm, đọc chậm).")
        if self.mlx:
            def generate() -> tuple[np.ndarray, int]:
                kwargs = {"text": text, "lang_code": language.lower()}
                if mode == "custom":
                    kwargs.update(voice=speaker, instruct=instruct)
                elif mode == "design":
                    kwargs.update(instruct=instruct)
                else:
                    kwargs.update(ref_audio=ref_audio, ref_text=ref_text or None)
                chunks, rate = [], self.sample_rate
                for result in model.generate(**kwargs):
                    chunks.append(_mlx_audio_array(result.audio))
                    rate = int(getattr(result, "sample_rate", None) or rate)
                return (np.concatenate(chunks) if chunks else np.zeros(0, np.float32)), rate
            audio, rate = _mlx_run(generate)
        else:
            if mode == "custom":
                wavs, rate = model.generate_custom_voice(text=text, language=language, speaker=speaker, instruct=instruct)
            elif mode == "design":
                wavs, rate = model.generate_voice_design(text=text, language=language, instruct=instruct)
            else:
                wavs, rate = model.generate_voice_clone(text=text, language=language, ref_audio=ref_audio,
                                                         ref_text=ref_text or None, x_vector_only_mode=not ref_text)
            audio = core.to_mono(np.asarray(wavs[0] if isinstance(wavs, (list, tuple)) else wavs, dtype=np.float32))
        if not audio.size:
            raise RuntimeError("Qwen3-TTS không sinh ra âm thanh nào")
        speed = float(opts.get("speed") or 1.0)
        if abs(speed - 1.0) > 1e-3:
            audio, _ = core.change_speed(audio, int(rate), speed)
        return audio, int(rate)


class ChatterboxEngine(Engine):
    """Chatterbox Multilingual (Resemble AI, MIT) — v1.1.17, người dùng chốt 2026-10-11: chỉ bản
    CHÍNH THỨC (bản tiếng Việt cộng đồng "Viterbox" là CC BY-NC nên không đưa vào).

    23 ngôn ngữ, KHÔNG có tiếng Việt. Một giọng mặc định + nhân bản từ hồ sơ giọng (chỉ cần audio
    mẫu). Hai núm: `exaggeration` (độ cảm xúc, 0,25-2) và `cfg_weight` (bám giọng mẫu / nhịp, 0-1).
    MỌI tệp ra đều mang watermark Perth không nghe thấy (thư viện tự gắn).

    Windows/Linux: gói `chatterbox-tts` trong .venv-tts-chatterbox (ghim torch 2.6 + numpy<2).
    macOS: mlx-audio trong môi trường chính."""

    name = "chatterbox"
    label = "Chatterbox Multilingual"
    sample_rate = 24000
    chunked = False
    clone = True
    clone_needs_text = False
    LANGUAGES = [
        ("ar", "Tiếng Ả Rập"), ("da", "Tiếng Đan Mạch"), ("de", "Tiếng Đức"), ("el", "Tiếng Hy Lạp"),
        ("en", "Tiếng Anh"), ("es", "Tiếng Tây Ban Nha"), ("fi", "Tiếng Phần Lan"), ("fr", "Tiếng Pháp"),
        ("he", "Tiếng Do Thái"), ("hi", "Tiếng Hindi"), ("it", "Tiếng Ý"), ("ja", "Tiếng Nhật"),
        ("ko", "Tiếng Hàn"), ("ms", "Tiếng Mã Lai"), ("nl", "Tiếng Hà Lan"), ("no", "Tiếng Na Uy"),
        ("pl", "Tiếng Ba Lan"), ("pt", "Tiếng Bồ Đào Nha"), ("ru", "Tiếng Nga"), ("sv", "Tiếng Thụy Điển"),
        ("sw", "Tiếng Swahili"), ("tr", "Tiếng Thổ Nhĩ Kỳ"), ("zh", "Tiếng Trung"),
    ]

    @property
    def mlx(self) -> bool:
        return sys.platform == "darwin"

    @property
    def module(self) -> str:  # type: ignore[override]
        return "mlx_audio" if self.mlx else "chatterbox"

    @property
    def models(self) -> List[str]:  # type: ignore[override]
        return ["chatterbox-mtl-v3-mlx" if self.mlx else "chatterbox-mtl"]

    def _build(self, paths: Dict[str, Path]) -> Any:
        path = paths[self.models[0]]
        if self.mlx:
            def load():
                from mlx_audio.tts import load_model
                return load_model(str(path))
            self.device = "mps"
            return _mlx_run(load)
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        from chatterbox.models.tokenizers import tokenizer as cb_tokenizer

        # Bộ chuyển chữ Hán (Cangjie) tự tải Cangjie5_TC.json bằng hf_hub_download vào cache HF — ngoài
        # kho model của app, và hỏng khi đang nạp ở chế độ offline (_hub_offline). Tệp đó đã có trong
        # kho (CHATTERBOX_MTL_FILES): trỏ về đó.
        original = cb_tokenizer.hf_hub_download
        if not getattr(original, "_crab_local", False):
            def _local(*args, **kwargs):
                name = kwargs.get("filename") or (args[1] if len(args) > 1 else "")
                local = path / str(name)
                return str(local) if name and local.is_file() else original(*args, **kwargs)
            _local._crab_local = True  # type: ignore[attr-defined]
            cb_tokenizer.hf_hub_download = _local
        self.device = _torch_device()
        # Gói 0.1.7 (PyPI) nạp Multilingual V2; bản Mac (mlx-audio) là V3.
        return ChatterboxMultilingualTTS.from_local(str(path), self.device)

    def unload(self) -> bool:
        if not self.mlx:
            return super().unload()
        with self._lock:
            if self._model is None:
                return False
            self._model = None
        try:
            _mlx_run(_release_accelerator_memory)
        except Exception:
            pass
        log(f"đã nhả {self.name}")
        return True

    def voice_details(self) -> List[dict]:
        # Một giọng mặc định duy nhất; giọng khác là hồ sơ nhân bản (panel tự thêm nhóm hồ sơ).
        return [{"id": "default", "label": "Giọng mặc định", "description": ""}]

    def extras(self) -> dict:
        return {
            "languages": [{"id": code, "label": label} for code, label in self.LANGUAGES],
            "emotion": True,
            "watermark": True,
        }

    def prepare(self, opts: dict) -> dict:
        ref_audio = str(opts.get("ref_audio") or "").strip()
        if ref_audio and not Path(ref_audio).is_file():
            raise UserError("Không tìm thấy tệp giọng mẫu của hồ sơ giọng — hãy tạo lại hồ sơ trong Cài đặt.")
        return opts

    def _synth_once(self, text: str, opts: dict, target: Optional[float]) -> tuple[np.ndarray, int]:
        model = self.ensure()
        options = opts.get("engine_options") or {}
        language = str(options.get("language") or "en").lower()
        if language not in {code for code, _ in self.LANGUAGES}:
            raise UserError(f"Chatterbox không có ngôn ngữ '{language}'.")
        exaggeration = max(0.25, min(2.0, float(options.get("exaggeration") or 0.5)))
        cfg_weight = max(0.0, min(1.0, float(options.get("cfg_weight") if options.get("cfg_weight") is not None else 0.5)))
        ref_audio = str(opts.get("ref_audio") or "").strip() or None
        if self.mlx:
            def generate() -> tuple[np.ndarray, int]:
                chunks, rate = [], self.sample_rate
                for result in model.generate(text=text, ref_audio=ref_audio, lang_code=language,
                                             exaggeration=exaggeration, cfg_weight=cfg_weight, verbose=False):
                    chunks.append(_mlx_audio_array(result.audio))
                    rate = int(getattr(result, "sample_rate", None) or rate)
                return (np.concatenate(chunks) if chunks else np.zeros(0, np.float32)), rate
            audio, rate = _mlx_run(generate)
        else:
            wav = model.generate(text, language_id=language, audio_prompt_path=ref_audio,
                                 exaggeration=exaggeration, cfg_weight=cfg_weight)
            rate = int(getattr(model, "sr", self.sample_rate) or self.sample_rate)
            audio = core.to_mono(np.asarray(wav.detach().cpu().numpy() if hasattr(wav, "detach") else wav, dtype=np.float32))
        if not audio.size:
            raise RuntimeError("Chatterbox không sinh ra âm thanh nào")
        speed = float(opts.get("speed") or 1.0)
        if abs(speed - 1.0) > 1e-3:
            audio, _ = core.change_speed(audio, int(rate), speed)
        return audio, int(rate)


# ── Engine nào sống ở server nào ──────────────────────────────────────────────
# Mỗi môi trường Python chạy CHÍNH tệp này và chỉ mở engine của mình (CRAB_TTS_ENV, do
# backend/tts-service.js đặt khi bật server) — xem ENVS ở scripts/setup_tts.js. Trên Mac, Qwen3-TTS và
# Chatterbox chạy bằng mlx-audio nên ở luôn môi trường chính.
SERVER_ENV = os.environ.get("CRAB_TTS_ENV", "main").strip() or "main"


def engine_home(name: str) -> str:
    if name in ("qwen3", "chatterbox") and sys.platform != "darwin":
        return "qwen" if name == "qwen3" else "chatterbox"
    return "main"


ENGINES: Dict[str, Engine] = {
    e.name: e
    for e in (VieNeu3Engine(), VieNeuEngine(), VoxCPMEngine(), Qwen3Engine(), ChatterboxEngine())
    if engine_home(e.name) == SERVER_ENV
}


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
        **engine.extras(),
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
                _append_error_log(self, exc)
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
        engine.configure(params)

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
            "engine_options": params.get("engine_options") if isinstance(params.get("engine_options"), dict) else {},
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
    engine.configure(payload)   # Qwen3-TTS: tải checkpoint của chế độ đang chọn

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
