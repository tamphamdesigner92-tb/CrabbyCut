#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>
"""Lõi THUẦN của "Lồng tiếng" (tab Âm thanh): làm sạch câu phụ đề, co giãn giọng đọc cho vừa
khung thời gian, xếp lên trục thời gian và trộn thành một file.

Chỉ phụ thuộc numpy (+ ffmpeg nếu có, cho atempo). KHÔNG import model, KHÔNG import FastAPI —
để `tests/scripts/dubbing_core.py` chạy được bằng .venv thường mà không phải cài torch.

Nguồn gốc: logic "auto_fit / dynamic_shift / fixed_duration" port từ Vi-TTS Studio
(repo TTS-App, nhánh TTS_App_v1.0.1 — backend/app.py `_process_srt_file`, backend/audio_merger.py,
backend/tts_engine.py `fit_audio_to_duration`) và bộ canh chunk câm từ server TTS của bản
CrabbyCut_Private. Khác bản gốc ở ba chỗ, đều có lý do:

1. MỐC LÀ GIÂY (float) chứ không phải ms — cùng đơn vị với timeline của Editing.
2. Cắt khoảng lặng ĐẦU/ĐUÔI của từng câu trước khi đo độ dài: VieNeu tự thêm ~0.2s câm ở đuôi,
   F5 thỉnh thoảng câm ở đầu. Để nguyên thì câu nào cũng "dài hơn khung" một chút và bị tăng
   tốc vô cớ.
3. File trộn BẮT ĐẦU Ở CÂU ĐẦU TIÊN (không phải 00:00): phụ đề bắt đầu ở phút 5 thì file ghép
   không mang theo 5 phút câm. Nơi gọi đặt clip tại `start` trả về.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, List, Optional

import numpy as np

# ── Làm sạch câu ─────────────────────────────────────────────────────────────

# Câu chỉ là ký hiệu âm nhạc / chú thích trong ngoặc vuông thì không đọc (port từ
# srt_processor.py của Vi-TTS Studio: "[ÂM NHẠC]", "♪ ... ♪", "[tiếng vỗ tay]"…).
_SKIP_PATTERNS = [
    re.compile(r"^\[.*\]$"),
    re.compile(r"^\(\s*(?:âm\s+nhạc|nhạc|music)\s*\)$", re.IGNORECASE),
    re.compile(r"^♪.*♪$"),
    re.compile(r"^[♪♫\s]+$"),
]
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_FORMAT_TAG_RE = re.compile(r"\{[^}]*\}")
_LEADING_DIALOGUE_RE = re.compile(r"^\s*(?:>>\s*|-\s+)+")
_SPACES_RE = re.compile(r"\s+")


def clean_text(text: str) -> str:
    """Bỏ thẻ HTML/ASS, dấu thoại đầu dòng, gộp khoảng trắng (kể cả xuống dòng)."""
    value = _HTML_TAG_RE.sub("", str(text or ""))
    value = _FORMAT_TAG_RE.sub("", value)
    lines = [_LEADING_DIALOGUE_RE.sub("", line) for line in value.splitlines()]
    return _SPACES_RE.sub(" ", " ".join(lines)).strip()


def is_music_marker(text: str) -> bool:
    stripped = str(text or "").strip()
    return any(p.match(stripped) for p in _SKIP_PATTERNS)


@dataclass
class Cue:
    seq: int          # thứ tự sau khi lọc, bắt đầu từ 1
    index: int        # vị trí trong danh sách gốc (để báo lại cho giao diện)
    start: float      # giây
    end: float        # giây
    text: str

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


def normalize_cues(raw: Iterable[dict]) -> tuple[List[Cue], dict]:
    """Danh sách {start, end, text} thô -> Cue đã lọc + thống kê bỏ qua.

    Bỏ: câu rỗng, câu nhạc, câu không có chữ cái nào (chỉ số/ký hiệu — model đọc ra tiếng lạ),
    câu mốc hỏng (end <= start hoặc không phải số). Sắp theo `start` vì tệp phụ đề đôi khi
    không theo thứ tự.
    """
    kept: list[tuple[float, float, str, int]] = []
    skipped = {"empty": 0, "music": 0, "no_letters": 0, "bad_time": 0}
    for index, item in enumerate(raw or []):
        try:
            start = float(item.get("start"))
            end = float(item.get("end"))
        except (TypeError, ValueError, AttributeError):
            skipped["bad_time"] += 1
            continue
        if not (np.isfinite(start) and np.isfinite(end)) or end <= start or end <= 0:
            skipped["bad_time"] += 1
            continue
        text = clean_text(item.get("text", ""))
        if not text:
            skipped["empty"] += 1
            continue
        if is_music_marker(text):
            skipped["music"] += 1
            continue
        if not any(ch.isalpha() for ch in text):
            skipped["no_letters"] += 1
            continue
        kept.append((max(0.0, start), end, text, index))
    kept.sort(key=lambda row: (row[0], row[3]))
    cues = [Cue(seq=i + 1, index=row[3], start=row[0], end=row[1], text=row[2]) for i, row in enumerate(kept)]
    return cues, skipped


# ── Cắt đoạn dài + canh chunk câm (port từ CrabbyCut_Private/tts/server.py) ───
#
# Model sinh NGẪU NHIÊN và thỉnh thoảng DEGENERATE: nhả một dải khung câm dài thay vì lời
# (đo thật trên VieNeu: chunk khoẻ có dải câm dài nhất 0.24-0.46s, chunk hỏng 24-30s). Sinh
# lại là thuốc đúng. Một câu phụ đề hiếm khi quá 220 ký tự, nhưng vẫn cắt cho chắc.

CHUNK_MAX_CHARS = 220
CHUNK_GAP_SEC = 0.15
CHUNK_RETRIES = 2
SUSPECT_SILENCE_RUN_SEC = 1.5
SUSPECT_SILENCE_FRACTION = 0.45


def split_for_tts(text: str, max_chars: int = CHUNK_MAX_CHARS) -> list[str]:
    """Cắt văn bản thành khối <= max_chars, ưu tiên ranh giới câu rồi dấu phẩy, không cắt giữa từ."""
    text = " ".join((text or "").split())
    if not text:
        return []
    sentences = [s.strip() for s in re.split(r"(?<=[.!?…:;\n])\s+", text) if s.strip()]
    out: list[str] = []
    for sentence in sentences:
        if len(sentence) <= max_chars:
            pieces = [sentence]
        else:
            pieces, current = [], ""
            for part in re.split(r"(?<=,)\s+", sentence):
                for token in ([part] if len(part) <= max_chars else part.split(" ")):
                    candidate = f"{current} {token}".strip()
                    if current and len(candidate) > max_chars:
                        pieces.append(current)
                        current = token
                    else:
                        current = candidate
            if current:
                pieces.append(current)
        for piece in pieces:
            if out and len(out[-1]) + 1 + len(piece) <= max_chars:
                out[-1] = f"{out[-1]} {piece}"
            else:
                out.append(piece)
    return out


def silence_report(audio: np.ndarray, rate: int) -> tuple[float, float]:
    """(dải câm dài nhất tính bằng giây, tỉ lệ khung câm). Ngưỡng = 2% đỉnh RMS của chính đoạn đó."""
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    hop = max(1, int(rate * 0.02))
    frame_count = samples.size // hop
    if frame_count == 0:
        return 0.0, 1.0
    frames = samples[:frame_count * hop].reshape(frame_count, hop)
    rms = np.sqrt((frames ** 2).mean(axis=1) + 1e-12)
    quiet = rms < max(1e-4, float(rms.max()) * 0.02)
    longest = current = 0
    for is_quiet in quiet:
        current = current + 1 if is_quiet else 0
        longest = max(longest, current)
    return longest * 0.02, float(quiet.mean())


def looks_degenerate(audio: np.ndarray, rate: int) -> str:
    """Lý do coi một chunk là hỏng, hoặc "" nếu bình thường."""
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    if samples.size < int(rate * 0.05):
        return "audio rỗng"
    longest, fraction = silence_report(samples, rate)
    if longest > SUSPECT_SILENCE_RUN_SEC:
        return f"có dải im lặng {longest:.1f}s"
    if fraction > SUSPECT_SILENCE_FRACTION:
        return f"im lặng {fraction * 100:.0f}% cả đoạn"
    return ""


# ── Tiện ích audio ───────────────────────────────────────────────────────────

def to_mono(audio) -> np.ndarray:
    data = np.asarray(audio, dtype=np.float32)
    if data.ndim == 2:
        # soundfile trả (frames, channels); torch trả (channels, frames) — kênh là chiều NHỎ.
        data = data.mean(axis=1 if data.shape[0] > data.shape[1] else 0)
    return data.reshape(-1)


def resample_linear(audio: np.ndarray, source_sr: int, target_sr: int) -> np.ndarray:
    audio = np.asarray(audio, dtype=np.float32)
    if source_sr == target_sr or audio.size == 0:
        return audio
    duration = audio.size / float(source_sr)
    target_len = max(1, int(round(duration * target_sr)))
    source_x = np.linspace(0.0, duration, num=audio.size, endpoint=False)
    target_x = np.linspace(0.0, duration, num=target_len, endpoint=False)
    return np.interp(target_x, source_x, audio).astype(np.float32)


def fade_tail(audio: np.ndarray, sample_rate: int, seconds: float = 0.02) -> np.ndarray:
    if audio.size == 0:
        return audio
    fade_len = min(audio.size, max(1, int(sample_rate * seconds)))
    out = audio.copy()
    out[-fade_len:] *= np.linspace(1.0, 0.0, fade_len, dtype=np.float32)
    return out


def trim_silence_edges(audio: np.ndarray, sample_rate: int, pad: float = 0.03) -> np.ndarray:
    """Cắt câm đầu/đuôi (ngưỡng 2% đỉnh RMS theo khung 10ms), chừa `pad` giây cho khỏi cụt âm."""
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    hop = max(1, int(sample_rate * 0.01))
    frame_count = samples.size // hop
    if frame_count < 3:
        return samples
    frames = samples[:frame_count * hop].reshape(frame_count, hop)
    rms = np.sqrt((frames ** 2).mean(axis=1) + 1e-12)
    loud = np.nonzero(rms >= max(1e-4, float(rms.max()) * 0.02))[0]
    if loud.size == 0:
        return samples
    pad_samples = int(sample_rate * pad)
    start = max(0, int(loud[0]) * hop - pad_samples)
    end = min(samples.size, (int(loud[-1]) + 1) * hop + pad_samples)
    return samples[start:end]


def atempo_chain(speed: float) -> list[str]:
    """`atempo` chỉ nhận 0.5-2.0 mỗi tầng, tốc độ ngoài dải phải xếp tầng."""
    filters, remaining = [], float(speed)
    while remaining > 2.0:
        filters.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        filters.append("atempo=0.5")
        remaining /= 0.5
    filters.append(f"atempo={remaining:.6f}")
    return filters


def change_speed(audio: np.ndarray, sample_rate: int, speed: float) -> tuple[np.ndarray, str]:
    """Đổi tốc độ GIỮ CAO ĐỘ bằng ffmpeg atempo. Không có ffmpeg thì co bằng nội suy (giọng
    cao lên chút — thà vậy còn hơn hỏng cả lượt). Trả (audio, phương pháp)."""
    audio = np.asarray(audio, dtype=np.float32)
    if abs(speed - 1.0) < 1e-3 or audio.size == 0:
        return audio, "none"
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        try:
            import soundfile as sf
            with tempfile.TemporaryDirectory(prefix="crab_tts_fit_") as tmp:
                src = Path(tmp) / "in.wav"
                dst = Path(tmp) / "out.wav"
                sf.write(str(src), audio, sample_rate, format="WAV", subtype="FLOAT")
                subprocess.run(
                    [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
                     "-filter:a", ",".join(atempo_chain(speed)), "-ar", str(sample_rate), str(dst)],
                    check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                out, sr = sf.read(str(dst), dtype="float32", always_2d=False)
                out = to_mono(out)
                if int(sr) != int(sample_rate):
                    out = resample_linear(out, int(sr), int(sample_rate))
                return out, "ffmpeg"
        except Exception:
            pass
    target_len = max(1, int(round(audio.size / float(speed))))
    return resample_linear(audio, audio.size, target_len), "resample"


# ── Xếp lên trục thời gian ───────────────────────────────────────────────────

TIMING_MODES = ("auto_fit", "dynamic_shift", "fixed_duration")
DEFAULT_MAX_SPEED = 1.45    # Vi-TTS Studio: TTS_AUTO_FIT_MAX_SPEED
DEFAULT_GAP_SEC = 0.2       # Vi-TTS Studio: TTS_AUTO_FIT_MAX_GAP_SECONDS


@dataclass
class Placement:
    seq: int
    index: int
    start: float              # mốc THẬT đặt audio (giây)
    duration: float           # độ dài audio sau khi co giãn
    cue_start: float
    cue_end: float
    original_duration: float  # độ dài lúc model vừa sinh (đã cắt câm hai đầu)
    speed: float = 1.0        # hệ số tăng tốc đã áp
    required_speed: float = 1.0
    shift: float = 0.0        # bị đẩy muộn bao nhiêu giây so với mốc phụ đề
    overflow: float = 0.0     # tràn quá cuối khung bao nhiêu giây
    trimmed: bool = False     # fixed_duration: bị cắt đuôi
    method: str = "none"

    @property
    def end(self) -> float:
        return self.start + self.duration

    def as_dict(self) -> dict:
        return {
            "seq": self.seq, "index": self.index,
            "start": round(self.start, 4), "duration": round(self.duration, 4),
            "cue_start": round(self.cue_start, 4), "cue_end": round(self.cue_end, 4),
            "original_duration": round(self.original_duration, 4),
            "speed": round(self.speed, 3), "required_speed": round(self.required_speed, 3),
            "shift": round(self.shift, 4), "overflow": round(self.overflow, 4),
            "trimmed": self.trimmed, "method": self.method,
        }


@dataclass
class TimelinePlanner:
    """Đặt từng câu lên trục thời gian — gọi `place()` THEO THỨ TỰ câu.

    auto_fit (mặc định, như Vi-TTS Studio):
        Câu dài hơn khung còn lại -> tăng tốc tới tối đa `max_speed`. Vẫn tràn thì để tràn, và
        câu SAU bị đẩy tới (cuối câu tràn + `gap`) nếu mốc của nó sớm hơn thế. Câu sau không
        tràn thì "trả nợ" xong, câu kế tiếp lại về đúng mốc.
    dynamic_shift:
        Không đổi tốc độ. Câu nào đè lên câu trước thì dời tới ngay sau câu trước.
    fixed_duration:
        Mỗi câu đúng mốc; dài hơn khung thì cắt đuôi (có fade). F5-TTS được nhắc độ dài từ lúc
        sinh nên hiếm khi phải cắt.
    """

    mode: str = "auto_fit"
    max_speed: float = DEFAULT_MAX_SPEED
    gap: float = DEFAULT_GAP_SEC
    _cursor: Optional[float] = field(default=None, init=False)

    def __post_init__(self) -> None:
        if self.mode not in TIMING_MODES:
            self.mode = "auto_fit"
        self.max_speed = max(1.0, min(3.0, float(self.max_speed or DEFAULT_MAX_SPEED)))
        self.gap = max(0.0, float(self.gap if self.gap is not None else DEFAULT_GAP_SEC))

    def place(self, cue: Cue, audio: np.ndarray, sample_rate: int) -> tuple[np.ndarray, Placement]:
        audio = np.asarray(audio, dtype=np.float32).reshape(-1)
        original = audio.size / float(sample_rate) if sample_rate else 0.0
        placement = Placement(seq=cue.seq, index=cue.index, start=cue.start, duration=original,
                              cue_start=cue.start, cue_end=cue.end, original_duration=original)

        if self.mode == "fixed_duration":
            limit = int(round(cue.duration * sample_rate))
            if limit > 0 and audio.size > limit:
                audio = fade_tail(audio[:limit], sample_rate)
                placement.trimmed = True
        elif self.mode == "dynamic_shift":
            if self._cursor is not None and self._cursor > cue.start:
                placement.start = self._cursor
                placement.shift = self._cursor - cue.start
        else:  # auto_fit
            if self._cursor is not None and self._cursor > cue.start:
                placement.start = self._cursor
                placement.shift = self._cursor - cue.start
            available = cue.end - placement.start
            if available <= 0.05:
                required = self.max_speed
            else:
                required = original / available
            placement.required_speed = max(1.0, required)
            if required > 1.001:
                speed = min(required, self.max_speed)
                audio, placement.method = change_speed(audio, sample_rate, speed)
                placement.speed = speed

        placement.duration = audio.size / float(sample_rate) if sample_rate else 0.0
        placement.overflow = max(0.0, placement.end - cue.end)
        if self.mode == "dynamic_shift":
            self._cursor = placement.end
        elif self.mode == "auto_fit":
            self._cursor = (placement.end + self.gap) if placement.overflow > 0 else None
        return audio, placement


def summarize(placements: List[Placement]) -> dict:
    return {
        "count": len(placements),
        "sped_up": sum(1 for p in placements if p.speed > 1.001),
        "max_speed": round(max([p.speed for p in placements] or [1.0]), 3),
        "shifted": sum(1 for p in placements if p.shift > 0.001),
        "max_shift": round(max([p.shift for p in placements] or [0.0]), 3),
        "overflowed": sum(1 for p in placements if p.overflow > 0.001),
        "max_overflow": round(max([p.overflow for p in placements] or [0.0]), 3),
        "trimmed": sum(1 for p in placements if p.trimmed),
    }


def mix_placements(clips: List[tuple[Placement, np.ndarray]], sample_rate: int) -> tuple[np.ndarray, float]:
    """Trộn các câu đã đặt thành một mảng. Trả (audio, mốc bắt đầu của mảng tính bằng giây).

    Mảng bắt đầu ở câu SỚM NHẤT (xem ghi chú 3 ở đầu tệp). Chỗ chồng nhau (dynamic_shift không
    có, auto_fit chỉ khi tràn mà câu sau đã bị đẩy — hiếm) được CỘNG rồi chuẩn hoá đỉnh nếu vượt 1.
    """
    if not clips:
        return np.zeros(0, dtype=np.float32), 0.0
    origin = min(p.start for p, _ in clips)
    end = max(p.start + (audio.size / float(sample_rate)) for p, audio in clips)
    canvas = np.zeros(int(round((end - origin) * sample_rate)) + 1, dtype=np.float32)
    for placement, audio in clips:
        offset = int(round((placement.start - origin) * sample_rate))
        stop = offset + audio.size
        if stop > canvas.size:
            canvas = np.pad(canvas, (0, stop - canvas.size))
        canvas[offset:stop] += audio
    peak = float(np.max(np.abs(canvas))) if canvas.size else 0.0
    if peak > 1.0:
        canvas /= peak
    return canvas, origin
