#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>
"""Server lồng tiếng cục bộ của CrabbyCut — tab Âm thanh → "Lồng tiếng".

Nhận danh sách câu phụ đề có mốc thời gian, đọc từng câu bằng model TTS, co giãn cho vừa khung
rồi trộn thành file WAV đặt lên timeline. Backend Node (backend/tts-service.js) bật server này
khi cần, và nói chuyện qua HTTP 127.0.0.1.

VÌ SAO LÀ SERVER THƯỜNG TRÚ chứ không phải sidecar mỗi lượt một tiến trình như ASR: nạp model
mất 7-30 giây (F5-TTS ~1,3 GB, VieNeu ~0,9 GB). Người dùng nghe thử giọng, đổi câu, lồng lại —
nạp lại mỗi lượt là mỗi lượt chờ nửa phút. Server giữ model ấm và TỰ NHẢ sau
IDLE_UNLOAD_SECONDS để trả RAM cho việc dựng phim.

BA ENGINE:
  f5      Vi-F5-TTS (port từ Vi-TTS Studio / repo TTS-App): NHÂN BẢN GIỌNG từ một đoạn mẫu
          3-12 giây + lời của đoạn mẫu. Chạy được CPU, nhanh hơn nhiều nếu torch có CUDA.
  vieneu  VieNeu-TTS v2 (port từ server TTS của CrabbyCut_Private): 7 giọng Việt dựng sẵn,
          chạy CPU tốt.
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
            try:
                import gc
                gc.collect()
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            log(f"đã nhả {self.name}")
            return True

    def voices(self) -> List[str]:
        return []

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


def _patch_torchaudio_load() -> None:
    """torchaudio >= 2.9 chuyển `torchaudio.load` sang torchcodec, mà torchcodec trên Windows
    đòi bộ DLL FFmpeg "shared" (bản ffmpeg.exe tĩnh app đang dùng không có) -> F5-TTS chết ngay
    ở bước đọc giọng mẫu. F5 chỉ cần đọc WAV nên thay bằng soundfile là đủ và chạy mọi bản."""
    try:
        import soundfile as sf
        import torch
        import torchaudio
    except Exception:
        return
    if getattr(torchaudio, "_crab_patched", False):
        return

    def _load(path, *args, **kwargs):
        data, rate = sf.read(str(path), dtype="float32", always_2d=True)
        return torch.from_numpy(np.ascontiguousarray(data.T)), int(rate)

    torchaudio.load = _load
    torchaudio._crab_patched = True


class F5Engine(Engine):
    """Vi-F5-TTS — nhân bản giọng. Cấu hình kiến trúc khớp F5TTS_Base (dim 1024, depth 22…,
    xem vi-fine-tuned-f5-tts.yaml trong repo model) nên dùng thẳng config có sẵn của f5_tts."""

    name = "f5"
    label = "F5-TTS tiếng Việt"
    sample_rate = 24000
    models = ["f5-vi", "vocos"]
    module = "f5_tts"
    chunked = False         # F5 tự cắt đoạn theo độ dài giọng mẫu và tự nối có cross-fade

    # Số bước giải ODE: 32 là mặc định của F5 (Vi-TTS Studio chế độ "fast"). ĐO THẬT trên CPU
    # (torch bản CPU, máy dựng tính năng): ~3 phút MỘT câu ở 32 bước — không dùng nổi. Trên CPU hạ
    # xuống 16 (nhanh gấp đôi, giọng hơi kém mịn); GPU giữ 32. Ghi đè: CRAB_TTS_F5_NFE.
    NFE_STEP = 32
    NFE_STEP_CPU = 16
    CFG_STRENGTH = 2.0

    def nfe_step(self) -> int:
        forced = os.environ.get("CRAB_TTS_F5_NFE", "").strip()
        if forced.isdigit():
            return max(4, min(64, int(forced)))
        return self.NFE_STEP if self.device in ("cuda", "mps") else self.NFE_STEP_CPU

    def _build(self, paths: Dict[str, Path]) -> Any:
        _patch_torchaudio_load()
        from f5_tts.api import F5TTS

        self.device = _torch_device()
        ckpt = paths["f5-vi"] / "Vi_F5_TTS_ckpts" / "pruning_model.pt"
        vocab = paths["f5-vi"] / "vocab.txt"
        return F5TTS(model="F5TTS_Base", ckpt_file=str(ckpt), vocab_file=str(vocab),
                     vocoder_local_path=str(paths["vocos"]), device=self.device)

    def prepare(self, opts: dict) -> dict:
        ref_audio = str(opts.get("ref_audio") or "").strip()
        ref_text = " ".join(str(opts.get("ref_text") or "").split())
        if not ref_audio or not Path(ref_audio).is_file():
            raise UserError("F5-TTS cần một tệp giọng mẫu (3-12 giây, một người nói, không nhạc nền).")
        if not ref_text:
            # Để trống thì F5 tự bóc băng giọng mẫu bằng Whisper large-v3-turbo — thêm 1,6 GB
            # tải ngầm KHÔNG có tiến trình. Bắt người dùng gõ lời thì rẻ hơn nhiều.
            raise UserError("Nhập đúng lời nói trong tệp giọng mẫu — F5-TTS cần nó để bắt chước giọng.")
        self.ensure()
        from f5_tts.infer.utils_infer import preprocess_ref_audio_text

        # Cắt giọng mẫu về <= 12 giây + chuẩn hoá lời; kết quả được f5 cache theo hash nên
        # các lượt infer sau không làm lại. Cần độ dài THẬT của mẫu vì `fix_duration` của F5
        # là tổng (mẫu + câu mới), không phải riêng câu mới.
        processed_audio, processed_text = preprocess_ref_audio_text(ref_audio, ref_text, show_info=lambda *_a, **_k: None)
        import soundfile as sf
        info = sf.info(processed_audio)
        return {**opts, "ref_audio": processed_audio, "ref_text": processed_text,
                "ref_seconds": float(info.frames) / float(info.samplerate or 1)}

    def _synth_once(self, text: str, opts: dict, target: Optional[float]) -> tuple[np.ndarray, int]:
        model = self.ensure()
        fix = None
        if target and opts.get("timing_mode") == "fixed_duration":
            fix = float(opts.get("ref_seconds") or 0) + max(0.3, float(target))
        wav, rate, _spec = model.infer(
            ref_file=opts["ref_audio"], ref_text=opts["ref_text"], gen_text=text,
            show_info=lambda *_a, **_k: None, nfe_step=self.nfe_step(), cfg_strength=self.CFG_STRENGTH,
            speed=float(opts.get("speed") or 1.0), fix_duration=fix, remove_silence=False,
        )
        return np.asarray(wav, dtype=np.float32), int(rate)


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


ENGINES: Dict[str, Engine] = {e.name: e for e in (F5Engine(), VieNeuEngine(), VoxCPMEngine())}


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
                self._run()
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
