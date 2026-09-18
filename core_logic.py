import os
import platform
import re
import subprocess
import unicodedata
import warnings
import json
from dataclasses import dataclass
from concurrent.futures import ThreadPoolExecutor
from bisect import bisect_left
from difflib import SequenceMatcher
from functools import lru_cache
from time import perf_counter
from typing import Any, Dict, List, Optional, Tuple

from rapidfuzz import fuzz
import torch
import whisper
from pydub import AudioSegment
from pydub.silence import detect_nonsilent

warnings.filterwarnings("ignore", category=UserWarning)

TEMP_AUDIO = "temp_clean_audio.wav"
FAST_AUDIO_FILTER = "highpass=f=200,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11"
HQ_AUDIO_FILTER = (
    "highpass=f=120,lowpass=f=7500,afftdn=nf=-28,"
    "anlmdn=s=0.0003,dynaudnorm=f=250:g=15,loudnorm=I=-18:TP=-1.5:LRA=11"
)
VI_SMART_AUDIO_FILTER = (
    "highpass=f=80,lowpass=f=7600,afftdn=nf=-22,"
    "anlmdn=s=0.0002,dynaudnorm=f=250:g=12,loudnorm=I=-16:TP=-1:LRA=11"
)

VI_SMART_CONFIG: Dict[str, Any] = {
    "temperature": 0.0,
    "best_of": 5,
    "language": "vi",
    "task": "transcribe",
    "word_timestamps": True,
    "condition_on_previous_text": False,
    "no_speech_threshold": 0.6,
    "compression_ratio_threshold": 2.2,
    "logprob_threshold": -0.8,
    "hallucination_silence_threshold": 1.5,
}

VAD_CONFIG: Dict[str, Any] = {
    "min_speech_duration_ms": 250,
    "min_silence_duration_ms": 350,
    "speech_pad_ms": 180,
    "merge_gap_ms": 300,
    "min_chunk_sec": 4.0,
    "max_chunk_sec": 12.0,
}

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

DIRECTOR_CUE_KEYWORDS = [
    "2, 3",
    "2 3",
    "thử lại",
    "1 lần nữa",
    "nói lại",
    "quay lại",
    "bị trùng",
    "đoạn tiếp theo",
    "ok chị",
    "chị nói lại",
    "cho em lại",
    "chỉ một chỗ",
    "em lấy",
    "cắt ra",
    "comment á",
]

FILLER_WORDS = {
    "nha",
    "nhé",
    "nhe",
    "ạ",
    "à",
    "ừ",
    "ừm",
    "thì",
    "là",
    "vậy",
    "mà",
    "ơi",
}

# Đánh dấu đầu mục kịch bản ("1." "2)" "-" "•"). Bắt buộc có khoảng trắng hoặc
# hết dòng ngay sau, để không xén nhầm câu mở đầu bằng số như "1,7g/100ml".
_LIST_MARKER_RE = re.compile(r"^(?:\d+[.)]|[-–—•*])(?=\s|$)\s*")
_NORMALIZE_NON_WORD_RE = re.compile(r"[^\w\s]")
_NORMALIZE_SPACE_RE = re.compile(r"\s+")
_NUMBER_PUNCT_RE = re.compile(r"(\d)[.,](\d)")
_NUMBER_RE = re.compile(r"\d+")
_ENUMERATED_NUMBER_PAIR_RE = re.compile(
    r"\bso\s*(\d+)\s*(?:se\s*)?la\s*(\d+(?:[.,]\d+)?)"
)
_HOUR_RANGE_RE = re.compile(
    r"(\d{1,2})\s*(?:h|gio)\b[^0-9]{0,40}?\bden\b[^0-9]{0,40}?(\d{1,2})\s*(?:h|gio)\b"
)

def restore_word_timestamps(parsed_segments: List[Dict[str, Any]], session_file: str) -> List[Dict[str, Any]]:
    """Đọc file local để lấy lại word-timestamps và map vào các segment từ UI"""
    if not os.path.exists(session_file):
        return parsed_segments

    try:
        with open(session_file, "r", encoding="utf-8") as f:
            raw_data = json.load(f)
    except Exception:
        return parsed_segments

    for p_seg in parsed_segments:
        p_start = p_seg["start"]
        for r_seg in raw_data:
            # Tìm segment gốc trùng khớp (dung sai 0.1s)
            if abs(r_seg.get("start", -1) - p_start) < 0.1:
                if "words" in r_seg and r_seg["words"]:
                    p_seg["word_level_data"] = [
                        {
                            "start": float(w.get("start", p_start)),
                            "end": float(w.get("end", p_seg["end"])),
                            "text": str(w.get("word", "")).strip(),
                            "loudness_dBFS": float(p_seg.get("loudness_dBFS", 0.0))
                        }
                        for w in r_seg["words"]
                    ]
                break
    return parsed_segments

def get_detailed_hardware_info() -> Dict[str, str]:
    sys_os = platform.system() # Windows, Darwin (Mac), Linux
    machine = platform.machine()
    gpu_name = "Không tìm thấy"
    device_used = "CPU"

    if sys_os == "Darwin" and machine == "arm64":
        device_used = "MPS (Mac Silicon)"
        gpu_name = f"Apple M-Series GPU ({machine})"
    elif torch.cuda.is_available():
        device_used = "GPU (CUDA)"
        gpu_name = torch.cuda.get_device_name(0)
    else:
        device_used = "CPU"
        gpu_name = "N/A (Sử dụng chip xử lý)"

    os_display = "Windows" if sys_os == "Windows" else ("macOS" if sys_os == "Darwin" else sys_os)
    
    return {
        "os": os_display,
        "gpu": gpu_name,
        "device": device_used
    }

def set_status(msg: str):
    with open("progress.txt", "w", encoding="utf-8") as f:
        f.write(msg)
    print(msg)


def get_system_config() -> Tuple[str, str]:
    sys_os = platform.system()
    machine = platform.machine()

    if sys_os == "Darwin" and machine == "arm64":
        return "mac_silicon", "h264_videotoolbox"
    if torch.cuda.is_available():
        return "cuda", "h264_nvenc"
    return "cpu", "libx264"


def concat_multiple_videos(uploaded_files, output_path: str) -> str:
    uploaded_files = sorted(uploaded_files, key=lambda x: x.name)
    list_file_path = "concat_list.txt"

    with open(list_file_path, "w", encoding="utf-8") as list_file:
        for file in uploaded_files:
            list_file.write(f"file '{file.path}'\n")

    command = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list_file_path,
        "-c",
        "copy",
        output_path,
    ]
    try:
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError as e:
        raise Exception(f"Lỗi khi ghép video bằng FFmpeg: {e}")

    if os.path.exists(list_file_path):
        os.remove(list_file_path)
    return output_path


def preprocess_audio_for_whisper(video_path: str, mode: str = "vi_smart") -> Tuple[str, str]:
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
            TEMP_AUDIO,
        ]
        try:
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return TEMP_AUDIO, mode_to_try
        except subprocess.CalledProcessError:
            continue

    return video_path, "source"


def split_sentences(text: str) -> List[str]:
    """Tách kịch bản thành các câu để so khớp.

    Ranh giới câu = XUỐNG DÒNG hoặc dấu kết thúc câu (. ! ?). Xử lý xuống dòng
    TRƯỚC rồi mới chuẩn hoá khoảng trắng trong từng dòng: bản cũ gộp mọi khoảng
    trắng thành dấu cách ngay từ đầu nên nhánh tách theo "\n+" thành mã chết, và
    hai dòng kịch bản mà dòng trên không có dấu chấm bị dán thành một câu. Câu dán
    như vậy không bao giờ khớp trọn một vùng nói, vì người quay đọc chúng ở hai
    thời điểm khác nhau.

    KHÔNG lọc câu ngắn nữa. Bản cũ vứt thẳng câu dưới 3 từ, mà chúng cũng không
    lọt vào unmatched_sentences — người dùng mất câu mà không có cách nào biết.
    Nay câu ngắn vẫn vào, chỉ bị siết ngưỡng chấp nhận ở _row_passes_sentence_gate.

    KHÔNG cắt vụn theo dấu phẩy.
    """
    # Bỏ BOM và các ký tự vô hình: tệp .md xuất từ Word/Google Docs hay dính U+FEFF ở
    # đầu, và nó sẽ ngồi lì trong câu đầu tiên. JS phía renderer thì loại nó (trim()
    # của JS coi U+FEFF là khoảng trắng), nên không loại ở đây là hai bên đánh số câu
    # khác nhau — xem test "UI và backend phải đánh số câu GIỐNG HỆT nhau".
    text = text.replace("\ufeff", "").replace("\u200b", "")
    sentences: List[str] = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = _LIST_MARKER_RE.sub("", re.sub(r"[ \t]+", " ", line).strip())
        if not line:
            continue
        for part in re.split(r"(?<=[.!?])\s+", line):
            part = part.strip(" \t-•")
            if part:
                sentences.append(part)
    return sentences


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
        raw_sentences = split_sentences(reference_script)
        ref_sentences = [re.sub(r"[^\w\s]", "", s.lower()).strip() for s in raw_sentences]

    for i in range(1, len(segments)):
        prev_text = re.sub(r"[^\w\s]", "", segments[i - 1]["text"].lower()).strip()
        curr_text = re.sub(r"[^\w\s]", "", segments[i]["text"].lower()).strip()

        if len(curr_text.split()) < 2:
            continue

        if curr_text == prev_text:
            is_in_script = False
            if ref_sentences:
                for ref_sent in ref_sentences:
                    score = SequenceMatcher(None, curr_text, ref_sent).ratio()
                    if score >= similarity_threshold:
                        is_in_script = True
                        break
            if not is_in_script:
                return True
    return False


def _build_vad_clip_timestamps(audio_path: str) -> List[float]:
    try:
        audio = AudioSegment.from_file(audio_path)
    except Exception:
        return []

    duration_ms = len(audio)
    if duration_ms <= 0:
        return []

    silence_thresh = max(-45.0, float(audio.dBFS) - 16.0)
    nonsilent_ranges = detect_nonsilent(
        audio,
        min_silence_len=int(VAD_CONFIG["min_silence_duration_ms"]),
        silence_thresh=silence_thresh,
        seek_step=10,
    )
    if not nonsilent_ranges:
        return []

    padded_ranges: List[Tuple[int, int]] = []
    pad_ms = int(VAD_CONFIG["speech_pad_ms"])
    min_speech_ms = int(VAD_CONFIG["min_speech_duration_ms"])
    for start_ms, end_ms in nonsilent_ranges:
        start_ms = max(0, start_ms - pad_ms)
        end_ms = min(duration_ms, end_ms + pad_ms)
        if end_ms - start_ms >= min_speech_ms:
            padded_ranges.append((start_ms, end_ms))

    if not padded_ranges:
        return []

    merged_ranges: List[Tuple[int, int]] = [padded_ranges[0]]
    merge_gap_ms = int(VAD_CONFIG["merge_gap_ms"])
    for start_ms, end_ms in padded_ranges[1:]:
        prev_start, prev_end = merged_ranges[-1]
        if start_ms - prev_end <= merge_gap_ms:
            merged_ranges[-1] = (prev_start, max(prev_end, end_ms))
        else:
            merged_ranges.append((start_ms, end_ms))

    clip_timestamps: List[float] = []
    max_chunk_ms = int(float(VAD_CONFIG["max_chunk_sec"]) * 1000)
    min_chunk_ms = int(float(VAD_CONFIG["min_chunk_sec"]) * 1000)

    for start_ms, end_ms in merged_ranges:
        seg_start = start_ms
        while seg_start < end_ms:
            seg_end = min(seg_start + max_chunk_ms, end_ms)
            if seg_end - seg_start < min_chunk_ms and seg_end < end_ms:
                seg_end = min(end_ms, seg_start + min_chunk_ms)
            clip_timestamps.extend([seg_start / 1000.0, seg_end / 1000.0])
            seg_start = seg_end

    # Tránh edge-case của mlx_whisper khi điểm cuối trùng chính xác thời lượng audio.
    if clip_timestamps and abs(clip_timestamps[-1] - (duration_ms / 1000.0)) < 1e-3:
        clip_timestamps[-1] = max(clip_timestamps[-2] + 0.05, clip_timestamps[-1] - 0.05)

    return clip_timestamps


def _safe_to_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _has_repeated_token_run(text: str, run_len: int = 4) -> bool:
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


def _segment_quality_flags(seg: Dict[str, Any]) -> List[str]:
    flags: List[str] = []
    text = (seg.get("text") or "").strip()
    duration = max(0.001, _safe_to_float(seg.get("end"), 0.0) - _safe_to_float(seg.get("start"), 0.0))
    avg_logprob = _safe_to_float(seg.get("avg_logprob"), -99.0)
    no_speech_prob = _safe_to_float(seg.get("no_speech_prob"), 0.0)
    compression_ratio = _safe_to_float(seg.get("compression_ratio"), 0.0)

    if avg_logprob < float(HALLUCINATION_THRESHOLDS["avg_logprob_min"]):
        flags.append("low_logprob")
    if no_speech_prob > float(HALLUCINATION_THRESHOLDS["no_speech_prob_max"]) and len(text) > 6:
        flags.append("high_no_speech_prob")
    if compression_ratio > float(HALLUCINATION_THRESHOLDS["compression_ratio_max"]):
        flags.append("high_compression_ratio")
    if _has_repeated_token_run(text, run_len=int(HALLUCINATION_THRESHOLDS["repeat_token_run"])):
        flags.append("repeated_tokens")

    word_count = len(re.findall(r"\w+", text))
    wps = word_count / duration
    if word_count >= 2 and (
        wps < float(HALLUCINATION_THRESHOLDS["min_wps"])
        or wps > float(HALLUCINATION_THRESHOLDS["max_wps"])
    ):
        flags.append("abnormal_speech_rate")

    if (
        duration < float(HALLUCINATION_THRESHOLDS["short_seg_sec"])
        and len(text) > int(HALLUCINATION_THRESHOLDS["short_seg_max_chars"])
    ):
        flags.append("too_much_text_for_short_segment")

    return flags


def _annotate_and_filter_segments(segments: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    quality_stats = {"accept": 0, "review": 0, "reject": 0}
    cleaned: List[Dict[str, Any]] = []

    for seg in segments:
        enriched = dict(seg)
        flags = _segment_quality_flags(enriched)
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


def _transcribe_with_openai_whisper(
    model: Any,
    audio_path: str,
    decode_kwargs: Dict[str, Any],
    fp16: bool,
) -> Dict[str, Any]:
    kwargs = dict(decode_kwargs)
    kwargs["fp16"] = fp16
    try:
        return model.transcribe(audio_path, **kwargs)
    except TypeError:
        # Fallback cho các phiên bản whisper cũ thiếu một số tham số.
        kwargs.pop("hallucination_silence_threshold", None)
        kwargs.pop("best_of", None)
        return model.transcribe(audio_path, **kwargs)


def _transcribe_with_mlx_whisper(
    mlx_whisper_module: Any,
    audio_path: str,
    decode_kwargs: Dict[str, Any],
    prompt_moi: str,
) -> Dict[str, Any]:
    base_kwargs = dict(decode_kwargs)
    base_kwargs["initial_prompt"] = prompt_moi
    base_kwargs["path_or_hf_repo"] = "mlx-community/whisper-large-v3-turbo"
    try:
        return mlx_whisper_module.transcribe(audio_path, **base_kwargs)
    except TypeError:
        for key in ["task", "best_of", "hallucination_silence_threshold", "clip_timestamps"]:
            base_kwargs.pop(key, None)
        return mlx_whisper_module.transcribe(audio_path, **base_kwargs)


def transcribe_audio(
    video_path: str,
    reference_script: str = "",
    transcribe_mode: str = "vi_smart",
    return_diagnostics: bool = False,
) -> Any:
    overall_started = perf_counter()
    timings: Dict[str, int] = {}
    device, _ = get_system_config()
    set_status(f"Bắt đầu xử lý âm thanh... Đang khởi tạo mô hình trên {device.upper()}")
    preprocess_started = perf_counter()
    processed_audio, transcribe_mode_used = preprocess_audio_for_whisper(video_path, mode=transcribe_mode)
    timings["audio_preprocess_duration_ms"] = int((perf_counter() - preprocess_started) * 1000)
    prompt_moi = "Ngữ cảnh: hội thoại tiếng Việt. Từ khóa tham khảo: " + reference_script[:300]

    decode_kwargs = dict(VI_SMART_CONFIG)
    decode_kwargs["initial_prompt"] = prompt_moi
    # THANH TIẾN TRÌNH THẬT cho Auto Subtitle trên nhánh macOS. `verbose=False` bật thanh
    # tqdm của mlx_whisper/openai-whisper — nó đếm theo KHUNG MEL đã giải mã và ghi ra
    # stderr, backend đọc lại phần trăm ở đó (xem runPythonSidecar). `verbose=True` thì in
    # cả transcript (ồn, và không có phần trăm), `None` (mặc định) thì im hẳn.
    # Chỉ bật khi người gọi xin: mọi luồng cũ giữ nguyên hành vi, không thêm dòng nào.
    # (Trên Windows đường này không chạy — faster-whisper phát thẳng `ratio` qua NDJSON,
    #  xem emit_ratio ở asr/windows_faster_whisper_sidecar.py.)
    if os.getenv("CRAB_ASR_PROGRESS") == "1":
        decode_kwargs["verbose"] = False

    vad_started = perf_counter()
    clip_timestamps = _build_vad_clip_timestamps(processed_audio)
    timings["vad_duration_ms"] = int((perf_counter() - vad_started) * 1000)
    if clip_timestamps:
        decode_kwargs["clip_timestamps"] = clip_timestamps
        set_status(f"Đã phát hiện {len(clip_timestamps) // 2} cụm thoại bằng VAD, đang bóc băng...")
    else:
        set_status("Không tách được cụm thoại từ VAD, đang bóc băng toàn bộ audio...")

    if device == "mac_silicon":
        try:
            import mlx_whisper
        except ImportError:
            raise Exception("Chưa cài đặt mlx-whisper!")
        model_started = perf_counter()
        result = _transcribe_with_mlx_whisper(
            mlx_whisper_module=mlx_whisper,
            audio_path=processed_audio,
            decode_kwargs=decode_kwargs,
            prompt_moi=prompt_moi,
        )
        timings["mlx_transcribe_duration_ms"] = int((perf_counter() - model_started) * 1000)
        timings["model_transcribe_duration_ms"] = timings["mlx_transcribe_duration_ms"]
    else:
        model = whisper.load_model("large", device=device)
        use_fp16 = device == "cuda"
        model_started = perf_counter()
        result = _transcribe_with_openai_whisper(
            model=model,
            audio_path=processed_audio,
            decode_kwargs=decode_kwargs,
            fp16=use_fp16,
        )
        timings["model_transcribe_duration_ms"] = int((perf_counter() - model_started) * 1000)

    raw_segments = result.get("segments", [])

    # Nếu VAD quá gắt làm rỗng hoặc lọc quá mạnh, fallback transcribe toàn file.
    used_full_audio_fallback = False
    if clip_timestamps and len(raw_segments) == 0:
        used_full_audio_fallback = True
        decode_no_vad = dict(decode_kwargs)
        decode_no_vad.pop("clip_timestamps", None)
        fallback_started = perf_counter()
        if device == "mac_silicon":
            import mlx_whisper

            result = _transcribe_with_mlx_whisper(
                mlx_whisper_module=mlx_whisper,
                audio_path=processed_audio,
                decode_kwargs=decode_no_vad,
                prompt_moi=prompt_moi,
            )
        else:
            result = _transcribe_with_openai_whisper(
                model=model,
                audio_path=processed_audio,
                decode_kwargs=decode_no_vad,
                fp16=use_fp16,
            )
        raw_segments = result.get("segments", [])
        timings["full_audio_fallback_duration_ms"] = int((perf_counter() - fallback_started) * 1000)

    postprocess_started = perf_counter()
    try:
        audio_full = AudioSegment.from_file(video_path)
        for seg in raw_segments:
            start_ms = int(_safe_to_float(seg.get("start"), 0.0) * 1000)
            end_ms = int(_safe_to_float(seg.get("end"), 0.0) * 1000)
            audio_chunk = audio_full[max(0, start_ms):max(0, end_ms)]
            loudness = audio_chunk.dBFS
            seg["loudness_dBFS"] = loudness if loudness != float("-inf") else -100.0
    except Exception:
        for seg in raw_segments:
            seg["loudness_dBFS"] = 0.0

    cleaned_segments = [
        seg for seg in raw_segments if seg.get("loudness_dBFS", 0.0) != -100.0
    ]
    final_cleaned_segments, quality_stats = _annotate_and_filter_segments(cleaned_segments)
    set_status(
        "Đã bóc băng xong. "
        f"ACCEPT={quality_stats['accept']}, REVIEW={quality_stats['review']}, REJECT={quality_stats['reject']}."
    )

    has_repeating_words = check_repeating_words(final_cleaned_segments)
    has_identical_segments = check_identical_segments(final_cleaned_segments, reference_script)
    is_hallucinating = (
        quality_stats["review"] > 0
        or quality_stats["reject"] > 0
        or has_repeating_words
        or has_identical_segments
    )

    mode_suffix = []
    if clip_timestamps:
        mode_suffix.append("vad")
    if used_full_audio_fallback:
        mode_suffix.append("fallback_full_audio")
    mode_name = transcribe_mode_used
    if mode_suffix:
        mode_name = f"{transcribe_mode_used} ({', '.join(mode_suffix)})"

    if os.path.exists(TEMP_AUDIO):
        os.remove(TEMP_AUDIO)

    timings["postprocess_duration_ms"] = int((perf_counter() - postprocess_started) * 1000)
    timings["total_transcribe_audio_duration_ms"] = int((perf_counter() - overall_started) * 1000)

    diagnostics = {
        "vad_chunk_count": len(clip_timestamps) // 2,
        "raw_asr_segment_count": len(raw_segments),
        "aligned_segment_count": len(raw_segments),
        "final_segment_count": len(final_cleaned_segments),
        "used_full_audio_fallback": used_full_audio_fallback,
        "manual_vad": bool(clip_timestamps),
        **timings,
    }
    if return_diagnostics:
        return final_cleaned_segments, is_hallucinating, mode_name, diagnostics
    return final_cleaned_segments, is_hallucinating, mode_name


def format_segments_to_text(segments: List[Dict[str, Any]]) -> str:
    lines = []
    for seg in segments:
        loudness = seg.get("loudness_dBFS", 0.0)
        lines.append(f"[{seg['start']:.2f} - {seg['end']:.2f} | {loudness:.2f} dBFS] {seg['text'].strip()}")
    return "\n".join(lines)


def _parse_transcript_line(line: str) -> Optional[Dict[str, Any]]:
    pattern = re.compile(
        r"^\s*\[(?P<start>\d+(?:\.\d+)?)\s*-\s*(?P<end>\d+(?:\.\d+)?)(?:\s*\|\s*(?P<loud>-?\d+(?:\.\d+)?)\s*dBFS)?\]\s*(?P<text>.*)$"
    )
    match = pattern.match(line.strip())
    if not match:
        return None

    start = float(match.group("start"))
    end = float(match.group("end"))
    if end <= start:
        return None

    text = (match.group("text") or "").strip()
    if not text:
        return None

    loud_str = match.group("loud")
    loudness = float(loud_str) if loud_str is not None else 0.0

    return {
        "start": start,
        "end": end,
        "text": text,
        "loudness_dBFS": loudness,
    }


def parse_transcript_text(transcript_text: str) -> List[Dict[str, Any]]:
    parsed: List[Dict[str, Any]] = []
    for line in transcript_text.splitlines():
        item = _parse_transcript_line(line)
        if item:
            parsed.append(item)

    parsed.sort(key=lambda s: (s["start"], s["end"]))
    return parsed


def _normalize_for_match(text: str) -> str:
    lowered = text.lower()
    lowered = _NORMALIZE_NON_WORD_RE.sub(" ", lowered)
    lowered = _NORMALIZE_SPACE_RE.sub(" ", lowered).strip()
    return lowered


@lru_cache(maxsize=8192)
def _normalize_for_match_cached(text: str) -> str:
    return _normalize_for_match(text)


def _strip_diacritics(text: str) -> str:
    normalized = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn")


@lru_cache(maxsize=8192)
def _strip_diacritics_cached(text: str) -> str:
    return _strip_diacritics(text)


@lru_cache(maxsize=32768)
def _match_features_cached(text: str) -> Tuple[str, str, Tuple[str, ...], frozenset[str]]:
    normalized = _normalize_for_match_cached(text)
    if not normalized:
        return "", "", tuple(), frozenset()

    ascii_text = _strip_diacritics_cached(normalized)
    tokens = tuple(ascii_text.split())
    return normalized, ascii_text, tokens, frozenset(tokens)


def _quick_token_overlap(tokens_a: frozenset[str], tokens_b: frozenset[str]) -> float:
    if not tokens_a or not tokens_b:
        return 0.0
    union = tokens_a | tokens_b
    if not union:
        return 0.0
    return len(tokens_a & tokens_b) / len(union)


def _is_director_cue(text: str) -> bool:
    normalized = _NORMALIZE_SPACE_RE.sub(" ", text.lower()).strip()
    return any(keyword in normalized for keyword in DIRECTOR_CUE_KEYWORDS)


def preprocess_transcript_segments(
    segments: List[Dict[str, Any]],
    min_duration: float = 0.6,
    min_words: int = 2,
    max_gap: float = 0.35,
) -> List[Dict[str, Any]]:
    kept: List[Dict[str, Any]] = []
    for source_index, seg in enumerate(segments):
        duration = seg["end"] - seg["start"]
        word_count = len(seg["text"].split())

        if _is_director_cue(seg["text"]):
            continue
        if duration < min_duration and word_count < min_words:
            continue

        seg_copy = dict(seg)
        seg_copy["_source_index"] = source_index
        kept.append(seg_copy)

    if not kept:
        return []

       # [MỚI] Hàm lấy danh sách từ (words) thay vì lấy cả câu
    def _extract_sub_segments(seg: Dict[str, Any]) -> List[Dict[str, Any]]:
        if "word_level_data" in seg and seg["word_level_data"]:
            return seg["word_level_data"]
        
        # ---- FIX CỐT LÕI: PSEUDO-WORD TIMESTAMPS ----
        # Nếu mất dữ liệu json hoặc Whisper gộp câu quá dài thành 1 cục,
        # tự động chia nhỏ mốc thời gian đều cho từng chữ để "dao mổ" luôn có dữ liệu cắt.
        text = str(seg.get("text", "")).strip()
        words = text.split()
        if not words:
            return []
            
        start = float(seg["start"])
        end = float(seg["end"])
        duration = max(0.0, end - start)
        word_dur = duration / len(words) if len(words) > 0 else 0
        loudness = float(seg.get("loudness_dBFS", 0.0))
        
        subs = []
        for i, w in enumerate(words):
            subs.append({
                "start": start + i * word_dur,
                "end": start + (i + 1) * word_dur,
                "text": w,
                "loudness_dBFS": loudness
            })
        return subs
        # ----------------------------------------------

    merged: List[Dict[str, Any]] = []
    
    current = dict(kept[0])
    current["sub_segments"] = _extract_sub_segments(kept[0]) # Cập nhật

    for seg in kept[1:]:
        gap = seg["start"] - current["end"]
        last_sub_text = current.get("sub_segments", [{}])[-1].get("text", current.get("text", ""))
        
        if gap <= max_gap and not _is_retake_like_pair(last_sub_text, seg["text"]):
            old_duration = current["end"] - current["start"]
            new_duration = seg["end"] - seg["start"]
            total_duration = old_duration + new_duration
            
            weighted_loudness = (current.get("loudness_dBFS", 0.0) * old_duration + 
                                 seg.get("loudness_dBFS", 0.0) * new_duration) / total_duration if total_duration > 0 else current.get("loudness_dBFS", 0.0)

            current["end"] = seg["end"]
            current["text"] = f"{current['text']} {seg['text']}".strip()
            current["loudness_dBFS"] = weighted_loudness
            # [CẬP NHẬT] Nối trực tiếp mảng các từ vào sub_segments
            current.setdefault("sub_segments", []).extend(_extract_sub_segments(seg))
        else:
            merged.append(current)
            current = dict(seg)
            current["sub_segments"] = _extract_sub_segments(seg) # Cập nhật

    merged.append(current)

    for chunk in merged:
        chunk.pop("_source_index", None)
        chunk.pop("word_level_data", None)

    return merged


@lru_cache(maxsize=8192)
def _normalize_for_number_patterns(text: str) -> str:
    lowered = text.lower()
    lowered = _strip_diacritics_cached(lowered)
    lowered = _NORMALIZE_SPACE_RE.sub(" ", lowered).strip()
    return lowered


def _canonical_number_token(raw_value: str) -> str:
    compact = _NUMBER_PUNCT_RE.sub(r"\1\2", raw_value)
    digits = _NUMBER_RE.findall(compact)
    return "".join(digits)


@lru_cache(maxsize=8192)
def _extract_enumerated_number_pairs_cached(text: str) -> Tuple[Tuple[str, str], ...]:
    normalized = _normalize_for_number_patterns(text)
    pairs: Dict[str, str] = {}
    for index_raw, value_raw in _ENUMERATED_NUMBER_PAIR_RE.findall(normalized):
        index = _canonical_number_token(index_raw)
        value = _canonical_number_token(value_raw)
        if not index or not value:
            continue
        pairs[index] = value
    return tuple(pairs.items())


@lru_cache(maxsize=8192)
def _extract_hour_ranges_cached(text: str) -> Tuple[Tuple[str, str], ...]:
    normalized = _normalize_for_number_patterns(text)
    ranges: List[Tuple[str, str]] = []
    for start_raw, end_raw in _HOUR_RANGE_RE.findall(normalized):
        start = _canonical_number_token(start_raw)
        end = _canonical_number_token(end_raw)
        if start and end:
            ranges.append((start, end))
    return tuple(ranges)


_NUMBER_TOKEN_RE = re.compile(r"\d+(?:[.,]\d+)?")
_DIGIT_WORD_FORMS: Dict[str, Tuple[str, ...]] = {
    "0": ("khong",),
    "1": ("mot", "mot", "nhat"),
    "2": ("hai", "nhi"),
    "3": ("ba",),
    "4": ("bon", "tu"),
    "5": ("nam", "lam"),
    "6": ("sau",),
    "7": ("bay",),
    "8": ("tam",),
    "9": ("chin",),
    "10": ("muoi",),
    "11": ("muoi mot",),
    "12": ("muoi hai",),
}


@lru_cache(maxsize=8192)
def _number_tokens_cached(text: str) -> Tuple[str, ...]:
    """Các con số VIẾT BẰNG CHỮ SỐ trong văn bản, đã chuẩn hoá dấu thập phân.

    Giữ nguyên phần thập phân ("1,7" -> "1.7") chứ không dán liền thành "17":
    kịch bản dinh dưỡng đầy những "1,7g / 2,77g / 3,36g", dán liền là mất đúng
    thông tin phân biệt chúng.
    """
    return tuple(
        token.replace(",", ".") for token in _NUMBER_TOKEN_RE.findall(text)
    )


def _raw_contains_number(number: str, raw_numbers: frozenset, raw_normalized: str) -> bool:
    """Số trong kịch bản có xuất hiện trong lời nói không — chữ số HOẶC đọc thành chữ.

    Chỉ quy đổi theo chiều số -> chữ. Bản cũ làm ngược lại, quét cả hai văn bản
    rồi thay mọi "ba" thành 3, "năm" thành 5... nên "ba mẹ" hoá thành số 3 và
    "năm nay" thành số 5. Chỉ cần ASR nghe "ba mẹ" ra "bà mẹ" là chuỗi số hai bên
    lệch nhau và câu bị loại thẳng.
    """
    if number in raw_numbers:
        return True
    for word_form in _DIGIT_WORD_FORMS.get(number, ()):  # chỉ số nguyên nhỏ mới có dạng chữ
        if re.search(rf"\b{re.escape(word_form)}\b", raw_normalized):
            return True
    return False


@lru_cache(maxsize=65536)
def _number_consistency_factor(script_text: str, raw_text: str) -> float:
    """Hệ số nhân [0..1] phạt khi con số trong kịch bản không thấy trong lời nói.

    Trước đây đây là LUẬT THÉP: lệch số là similarity về thẳng 0.0, tức xoá sổ
    ứng viên. Với một bộ tách số hay nhận nhầm, luật thép đó âm thầm giết cả
    những cặp khớp 0.92. Nay chỉ phạt điểm: cặp đúng số vẫn thắng cặp sai số vì
    khoảng cách tương đối vẫn rất lớn, nhưng cặp sai số không còn biến mất.
    """
    factor = 1.0

    script_hour_ranges = set(_extract_hour_ranges_cached(script_text))
    if script_hour_ranges and not script_hour_ranges.issubset(set(_extract_hour_ranges_cached(raw_text))):
        factor *= 0.75

    script_pairs_seq = _extract_enumerated_number_pairs_cached(script_text)
    script_pairs = dict(script_pairs_seq)
    if len(script_pairs) >= 2:
        raw_pairs_seq = _extract_enumerated_number_pairs_cached(raw_text)
        raw_pairs = dict(raw_pairs_seq)
        # "số 1 là 1,7g / số 2 là 2,77g" — các câu chỉ khác nhau ở con số, nên
        # đây mới là chỗ con số thật sự phân biệt được ứng viên nào là đúng.
        if any(raw_pairs.get(index) != value for index, value in script_pairs.items()):
            factor *= 0.65
        else:
            raw_index_position: Dict[str, int] = {}
            for position, (index, _) in enumerate(raw_pairs_seq):
                raw_index_position.setdefault(index, position)
            positions = [raw_index_position.get(index, -1) for index, _ in script_pairs_seq]
            if any(p < 0 for p in positions) or any(positions[i] >= positions[i + 1] for i in range(len(positions) - 1)):
                factor *= 0.85

    script_numbers = _number_tokens_cached(script_text)
    if script_numbers:
        raw_numbers = frozenset(_number_tokens_cached(raw_text))
        raw_normalized = _normalize_for_number_patterns(raw_text)
        missing = sum(
            1
            for number in script_numbers
            if not _raw_contains_number(number, raw_numbers, raw_normalized)
        )
        factor *= 1.0 - 0.30 * (missing / len(script_numbers))

    return factor

# --- NGỮ ÂM TIẾNG VIỆT: gộp các cặp mà Whisper hay nghe lẫn ---
#
# Đây là kênh PHỤ, chỉ được phép NÂNG điểm (xem _similarity_from_features). Vì thế
# quy tắc ở đây cố ý gộp rộng tay: gộp nhầm hai từ khác nghĩa thì cùng lắm là bỏ
# lỡ một khác biệt, còn không gộp thì mất hẳn cặp khớp đúng. Ví dụ có thật trong
# dữ liệu: "ngày"→"ngài", "trứng"→"chứng", "tỉ lệ"→"tỷ lệ", "lỏng lẻo"→"lòng lẽo".
#
# Áp lên dạng ĐÃ BỎ DẤU THANH, vì dấu thanh là thứ ASR sai nhiều nhất.
_PHONETIC_RULES: Tuple[Tuple[re.Pattern[str], str], ...] = (
    # Phụ âm đầu: d/gi/r đồng âm giọng Bắc; tr/ch, s/x lẫn ở hầu hết giọng.
    (re.compile(r"^(?:gi|d|r)"), "z"),
    (re.compile(r"^tr"), "ch"),
    (re.compile(r"^s"), "x"),
    (re.compile(r"^ngh"), "ng"),
    (re.compile(r"^gh"), "g"),
    (re.compile(r"^[kq](?![u])"), "c"),
)
# CỐ Ý KHÔNG CÓ Ở ĐÂY, dù đều là hiện tượng ngữ âm có thật:
#   l → n          (giọng Bắc bộ): đo trên bộ dữ liệu vàng thì luật này LÀM TỆ ĐI
#                  một câu. Nó gộp toàn từ siêu phổ biến — "là/nà", "lại/nại",
#                  "lo/no" — nên kéo điểm của cả ứng viên sai lên theo.
#   ng$→n, nh$→n, c$→t, ch$→t   (phụ âm cuối, giọng Nam): đo ra trung tính tuyệt
#                  đối, không sửa được câu nào. Không giữ mã không có bằng chứng;
#                  gặp giọng Nam mà hỏng thì thêm lại KÈM một case trong bộ vàng.


@lru_cache(maxsize=65536)
def _phonetic_key(token: str) -> str:
    """Khoá ngữ âm của một âm tiết đã bỏ dấu."""
    key = token.replace("y", "i")  # y/i: "tỷ"/"tỉ", "tay"/"tai", "yêu"/"iêu"
    for pattern, replacement in _PHONETIC_RULES:
        key = pattern.sub(replacement, key, count=1)
    return key


# Từ chức năng tiếng Việt — đếm nhẹ hơn từ nội dung.
#
# Xấp xỉ IDF bằng một bảng tĩnh thay vì tính tần suất tài liệu thật: _similarity()
# là hàm thuần có lru_cache, luồn ngữ liệu của từng lượt chạy qua nó sẽ phải bỏ
# cache và mang trạng thái toàn cục. IDF thật thuộc về Phase 3, nơi bộ chấm điểm
# có sẵn ngữ liệu trong tay. Còn 90% giá trị nằm ở việc đừng để "là / thì / của /
# và" cân ngang với "canxi / protein / đề kháng" — bảng tĩnh làm được việc đó.
_LOW_WEIGHT_TOKENS = frozenset({
    "la", "thi", "ma", "va", "cua", "cho", "voi", "o", "den", "tu", "cac", "nhung",
    "nay", "do", "kia", "ay", "rat", "se", "da", "dang", "cung", "nen", "con", "nua",
    "roi", "a", "nhe", "nha", "nhi", "u", "um", "ne", "vay", "oi", "de", "duoc", "co",
    "khi", "ra", "vao", "len", "xuong", "hay", "hoac", "cai", "chi", "chinh", "nhu",
})
_LOW_TOKEN_WEIGHT = 0.3
_PHONETIC_DISCOUNT = 0.97


@lru_cache(maxsize=32768)
def _phonetic_features_cached(
    text: str,
) -> Tuple[str, Tuple[str, ...], frozenset[str], frozenset[str], Tuple[float, ...]]:
    """(chuỗi ngữ âm, token ngữ âm, tập token, tập token DÍNH LIỀN, trọng số)

    Tập "dính liền" gộp thêm mọi cặp âm tiết liền kề đã nối lại. ASR tách hoặc dính
    từ ghép rất tuỳ hứng — "canxi"/"can xi", "Nanu"/"Na Nu" — mà token_coverage so
    theo TẬP TOKEN thì hai cách viết đó giao nhau bằng không.
    """
    _, ascii_text, tokens, _ = _match_features_cached(text)
    if not tokens:
        return "", tuple(), frozenset(), frozenset(), tuple()

    phonetic = tuple(_phonetic_key(token) for token in tokens)
    glued = frozenset(
        phonetic[i] + phonetic[i + 1] for i in range(len(phonetic) - 1)
    )
    weights = tuple(
        _LOW_TOKEN_WEIGHT if token in _LOW_WEIGHT_TOKENS else 1.0 for token in tokens
    )
    return " ".join(phonetic), phonetic, frozenset(phonetic), glued, weights


@lru_cache(maxsize=65536)
def _weighted_overlap(script_text: str, raw_text: str) -> Tuple[float, float, float]:
    """(trọng số kịch bản khớp được, tổng trọng số kịch bản, tổng trọng số lời nói).

    Một âm tiết kịch bản coi là "có mặt" nếu lời nói chứa nó nguyên dạng, hoặc cùng
    khoá ngữ âm, hoặc nằm trong một từ ghép đã dính liền.
    """
    script_tokens = _match_features_cached(script_text)[2]
    _, _, _, raw_exact = _match_features_cached(raw_text)
    _, script_phonetic, _, _, script_weights = _phonetic_features_cached(script_text)
    _, _, raw_phonetic_set, raw_glued, raw_weights = _phonetic_features_cached(raw_text)
    if not script_phonetic:
        return 0.0, 0.0, sum(raw_weights)

    matched = 0.0
    for index, key in enumerate(script_phonetic):
        if (
            script_tokens[index] in raw_exact
            or key in raw_phonetic_set
            or key in raw_glued
        ):
            matched += script_weights[index]
    return matched, sum(script_weights), sum(raw_weights)


def _similarity_from_features(
    script_text: str,
    raw_text: str,
    script_features: Optional[Tuple[str, str, Tuple[str, ...], frozenset[str]]] = None,
    raw_features: Optional[Tuple[str, str, Tuple[str, ...], frozenset[str]]] = None,
) -> float:
    if script_features is None:
        script_features = _match_features_cached(script_text)
    if raw_features is None:
        raw_features = _match_features_cached(raw_text)

    norm_a, norm_a_ascii, tokens_a, set_a = script_features
    norm_b, norm_b_ascii, tokens_b, set_b = raw_features
    if not norm_a or not norm_b:
        return 0.0

    phonetic_a, _, phonetic_set_a, _, _ = _phonetic_features_cached(script_text)
    phonetic_b, _, phonetic_set_b, _, _ = _phonetic_features_cached(raw_text)

    # Lối tắt hiệu năng: không dính nhau ở cả chữ viết LẪN ngữ âm thì khỏi tính tiếp.
    if (
        _quick_token_overlap(set_a, set_b) == 0.0
        and _quick_token_overlap(phonetic_set_a, phonetic_set_b) == 0.0
    ):
        return 0.0

    # Kênh ngữ âm bị chiết khấu nhẹ nên nó chỉ thắng khi chữ viết lệch THẬT SỰ —
    # cặp khớp nguyên văn luôn được điểm cao hơn cặp chỉ khớp âm.
    seq_score = max(
        fuzz.ratio(norm_a, norm_b) / 100.0,
        fuzz.ratio(norm_a_ascii, norm_b_ascii) / 100.0,
        fuzz.ratio(phonetic_a, phonetic_b) / 100.0 * _PHONETIC_DISCOUNT,
    )
    partial_score = max(
        fuzz.partial_ratio(norm_a, norm_b) / 100.0,
        fuzz.partial_ratio(norm_a_ascii, norm_b_ascii) / 100.0,
        fuzz.partial_ratio(phonetic_a, phonetic_b) / 100.0 * _PHONETIC_DISCOUNT,
    )

    matched_weight, script_weight, raw_weight = _weighted_overlap(script_text, raw_text)
    total_weight = script_weight + raw_weight
    token_score = (2 * matched_weight / total_weight) if total_weight > 0 else 0.0
    token_recall = (matched_weight / script_weight) if script_weight > 0 else 0.0

    shorter_is_script = len(tokens_a) <= len(tokens_b)
    if shorter_is_script:
        blended = (
            0.35 * seq_score
            + 0.35 * partial_score
            + 0.30 * max(token_recall, token_score)
        )
    else:
        blended = 0.50 * seq_score + 0.20 * partial_score + 0.30 * token_score

    return blended * _number_consistency_factor(script_text, raw_text)


def _similarity(a: str, b: str) -> float:
    return _similarity_from_features(a, b)


def _is_retake_like_pair(text_a: str, text_b: str, threshold: float = 0.82) -> bool:
    return _similarity(text_a, text_b) >= threshold


def build_similarity_matrix(
    script_sentences: List[str],
    transcript_chunks: List[Dict[str, Any]],
) -> List[List[float]]:
    """Điểm giống nhau giữa mọi câu kịch bản và mọi chunk.

    Tính một lần rồi dùng chung cho cả căn chỉnh Needleman-Wunsch lẫn khâu lọc thô
    ứng viên take — đây là phần đắt nhất của cả pipeline (m×n phép so chuỗi).
    """
    script_features = [_match_features_cached(sentence) for sentence in script_sentences]
    chunk_texts = [chunk["text"] for chunk in transcript_chunks]
    chunk_features = [_match_features_cached(text) for text in chunk_texts]
    return [
        [
            _similarity_from_features(
                sentence,
                chunk_texts[j],
                script_features=script_features[i],
                raw_features=chunk_features[j],
            )
            for j in range(len(chunk_texts))
        ]
        for i, sentence in enumerate(script_sentences)
    ]


def align_sequence_needleman_wunsch(
    script_sentences: List[str],
    transcript_chunks: List[Dict[str, Any]],
    match_threshold: float = 0.45,
    weak_match_threshold: float = 0.25,
    gap_sentence_penalty: float = -0.18,
    gap_chunk_penalty: float = -0.04,
    mismatch_penalty: float = -0.25,
    precomputed_scores: Optional[List[List[float]]] = None,
) -> List[Tuple[int, int, float]]:
    m = len(script_sentences)
    n = len(transcript_chunks)
    if m == 0 or n == 0:
        return []

    scores = precomputed_scores if precomputed_scores is not None else build_similarity_matrix(
        script_sentences, transcript_chunks
    )

    dp = [[0.0] * (n + 1) for _ in range(m + 1)]
    trace = [[""] * (n + 1) for _ in range(m + 1)]

    for i in range(1, m + 1):
        dp[i][0] = dp[i - 1][0] + gap_sentence_penalty
        trace[i][0] = "U"
    for j in range(1, n + 1):
        dp[0][j] = dp[0][j - 1] + gap_chunk_penalty
        trace[0][j] = "L"

    for i in range(1, m + 1):
        for j in range(1, n + 1):
            sim = scores[i - 1][j - 1]
            diag_score = dp[i - 1][j - 1] + (sim if sim >= weak_match_threshold else mismatch_penalty)
            up_score = dp[i - 1][j] + gap_sentence_penalty
            left_score = dp[i][j - 1] + gap_chunk_penalty

            if diag_score >= up_score and diag_score >= left_score:
                dp[i][j] = diag_score
                trace[i][j] = "D"
            elif up_score >= left_score:
                dp[i][j] = up_score
                trace[i][j] = "U"
            else:
                dp[i][j] = left_score
                trace[i][j] = "L"

    matches: List[Tuple[int, int, float]] = []
    i, j = m, n
    while i > 0 and j > 0:
        move = trace[i][j]
        if move == "D":
            sim = scores[i - 1][j - 1]
            if sim >= match_threshold:
                matches.append((i - 1, j - 1, sim))
            i -= 1
            j -= 1
        elif move == "U":
            i -= 1
        else:
            j -= 1

    matches.reverse()
    return matches


# ===== CHỌN TAKE: sinh ứng viên TOÀN CỤC rồi chọn bằng quy hoạch động =====
#
# Thay cho apply_last_best_take() (đã gỡ), vốn chỉ dò quanh mỏ neo của
# Needleman-Wunsch (±2 chunk, hoặc 18 giây khi chỉ có một mỏ neo). Cửa sổ đó là
# điểm mù chí mạng khi người quay đọc lại CẢ kịch bản: NW là thuật toán đơn điệu
# nên nó neo trọn kịch bản vào MỘT lượt đọc, mọi lượt còn lại nằm ngoài tầm với.
# Đo trên bap_kids — dự án đọc lại toàn bộ hai lần — thì 9/16 câu có take đúng nằm
# ngoài cửa sổ, tức đáp án đúng chưa từng được đưa ra cân nhắc. Không thang điểm
# nào chữa được chuyện đó.
#
# Các trọng số dưới đây dò lưới trên bộ dữ liệu vàng 113 nhãn; xem
# docs/APP_INTERNALS.md mục Phase 4a để biết đường cong độ nhạy.

TAKE_CANDIDATE_MIN_SCORE = 0.55   # ngưỡng vào vòng ứng viên
TAKE_MAX_CANDIDATES = 8           # trần số take xét cho mỗi câu
TAKE_OVERLAP_FORBID = 0.30        # trùng quá tỉ lệ này thì cấm dùng chung đoạn audio
TAKE_RUN_GAP_SEC = 30.0           # cách nhau trong ngần này giây thì coi là cùng lượt đọc
TAKE_W_RECENCY = 0.18             # sức nặng của luật "take cuối thường là bản tốt"
TAKE_W_CONTINUITY = 0.12          # thưởng cho việc đi tiếp trong cùng một lượt đọc
TAKE_W_BACKJUMP = 0.25            # phạt khi câu sau lại lấy audio nằm TRƯỚC câu trước


def _take_candidates_for_sentence(
    sentence: str,
    chunks: List[Dict[str, Any]],
    chunk_indices: List[int],
) -> List[Dict[str, Any]]:
    """Mọi lần câu này được nói, trên TOÀN BỘ timeline."""
    found: List[Dict[str, Any]] = []
    for chunk_index in chunk_indices:
        chunk = chunks[chunk_index]
        sub_segments = chunk.get("sub_segments", [])
        if sub_segments:
            spans = _subsegment_span_candidates(sentence, sub_segments)
            if not spans:
                continue
            # base_score (chưa cộng thưởng biên) mới là thang so take-với-take.
            span = max(spans, key=lambda item: float(item.get("base_score", item["score"])))
            candidate = {
                "chunk_index": chunk_index,
                "start": float(span["start"]),
                "end": float(span["end"]),
                "matched_text": str(span["text"]),
                "similarity": float(span["similarity"]),
                "token_coverage": float(span["token_coverage"]),
                "loudness_dBFS": float(span["loudness_dBFS"]),
                "score": float(span.get("base_score", span["score"])),
            }
        else:
            similarity = _similarity(sentence, chunk["text"])
            coverage = _token_coverage(sentence, chunk["text"])
            loudness = float(chunk.get("loudness_dBFS", -100.0))
            candidate = {
                "chunk_index": chunk_index,
                "start": float(chunk["start"]),
                "end": float(chunk["end"]),
                "matched_text": str(chunk["text"]),
                "similarity": similarity,
                "token_coverage": coverage,
                "loudness_dBFS": loudness,
                "score": _final_match_score(similarity, coverage, loudness),
            }
        if candidate["score"] >= TAKE_CANDIDATE_MIN_SCORE:
            found.append(candidate)

    # Hai chunk liền nhau hay sinh ra gần như cùng một đoạn — gộp lại, giữ bản điểm cao.
    found.sort(key=lambda c: (c["start"], c["end"]))
    deduped: List[Dict[str, Any]] = []
    for candidate in found:
        if deduped:
            previous = deduped[-1]
            shortest = min(previous["end"] - previous["start"], candidate["end"] - candidate["start"])
            shared = _interval_overlap(previous["start"], previous["end"], candidate["start"], candidate["end"])
            if shortest > 0 and shared / shortest > 0.6:
                if candidate["score"] > previous["score"]:
                    deduped[-1] = candidate
                continue
        deduped.append(candidate)

    if len(deduped) > TAKE_MAX_CANDIDATES:
        deduped = sorted(deduped, key=lambda c: -c["score"])[:TAKE_MAX_CANDIDATES]
        deduped.sort(key=lambda c: (c["start"], c["end"]))

    # Hạng thời gian = "đây là lần đọc thứ mấy". Đầu vào của prior "take cuối".
    last = len(deduped) - 1
    for rank, candidate in enumerate(deduped):
        candidate["recency"] = (rank / last) if last > 0 else 1.0
    return deduped


def build_take_candidates(
    script_sentences: List[str],
    chunks: List[Dict[str, Any]],
    coarse_scores: List[List[float]],
    coarse_threshold: float = 0.35,
) -> Dict[int, List[Dict[str, Any]]]:
    """Ứng viên cho mọi câu, không giới hạn cửa sổ.

    Lọc thô bằng ma trận similarity mà Needleman-Wunsch đã tính sẵn trên văn bản
    chunk, rồi mới chạy phép dò span mức từ (đắt) trên số ít chunk còn lại.
    """
    candidates: Dict[int, List[Dict[str, Any]]] = {}
    for script_index, sentence in enumerate(script_sentences):
        row = coarse_scores[script_index] if script_index < len(coarse_scores) else []
        shortlist = [j for j, value in enumerate(row) if value >= coarse_threshold]
        if not shortlist:
            continue
        found = _take_candidates_for_sentence(sentence, chunks, shortlist)
        if found:
            candidates[script_index] = found
    return candidates


def select_takes_globally(
    candidates: Dict[int, List[Dict[str, Any]]],
    pinned: Optional[Dict[int, int]] = None,
) -> Dict[int, Dict[str, Any]]:
    """Chọn một take cho mỗi câu, tối ưu TOÀN CỤC chứ không quyết từng câu rời rạc.

    Quyết từng câu một là cách chắc chắn tạo ra timeline chắp vá: câu 10 lấy lượt
    đọc thứ hai, câu 11 lấy lượt đầu, người xem nghe thấy giọng nhảy tới nhảy lui.
    Thưởng liên tục ở đây làm khái niệm "lượt đọc" tự nổi lên mà không cần dò lượt
    tường minh — chuỗi nào đi liền mạch theo thời gian thì cộng dồn được nhiều
    thưởng hơn, nên cả một lượt tốt sẽ thắng trọn gói.

    Ba thành phần điểm:
      score      — chunk này đọc câu đó tốt đến đâu
      recency    — prior "take cuối thường là bản tốt". Nhãn người dùng cho thấy
                   7/7 lần họ chọn take muộn hơn DÙ điểm văn bản thấp hơn: chênh
                   lệch điểm giữa hai take chủ yếu là nhiễu ASR.
      continuity — đi tiếp trong cùng lượt đọc thì được thưởng; nhảy ngược về
                   trước bị phạt; dùng chồng audio thì cấm thẳng.
    """
    ordered = sorted(candidates)
    if not ordered:
        return {}

    # Người dùng đã chốt take cho câu nào thì DP không được quyền đổi ý, nhưng các
    # câu CÒN LẠI vẫn phải chạy lại: ghim một câu sang lượt đọc khác thì thưởng liên
    # tục kéo theo cả cụm quanh nó. Đó là lý do ghim rồi chạy lại cả pipeline, chứ
    # không sửa tay một hàng trong kết quả cũ.
    if pinned:
        candidates = {
            script_index: (
                [options[pinned[script_index]]]
                if script_index in pinned and 0 <= pinned[script_index] < len(options)
                else options
            )
            for script_index, options in candidates.items()
        }

    # value[k] = điểm tốt nhất của đường đi tới ứng viên thứ k của câu hiện tại.
    previous: List[Dict[str, Any]] = []
    previous_values: List[float] = []
    previous_back: List[List[Tuple[int, int]]] = []

    for position, script_index in enumerate(ordered):
        current = candidates[script_index]
        values: List[float] = []
        backpointers: List[List[Tuple[int, int]]] = []
        for candidate in current:
            own = candidate["score"] + TAKE_W_RECENCY * candidate["recency"]
            if position == 0:
                values.append(own)
                backpointers.append([(script_index, candidate["chunk_index"])])
                continue

            best_value = float("-inf")
            best_path: List[Tuple[int, int]] = []
            for prev_index, prev_candidate in enumerate(previous):
                shared = _interval_overlap(
                    prev_candidate["start"], prev_candidate["end"],
                    candidate["start"], candidate["end"],
                )
                shortest = min(
                    prev_candidate["end"] - prev_candidate["start"],
                    candidate["end"] - candidate["start"],
                )
                if shortest > 0 and shared / shortest > TAKE_OVERLAP_FORBID:
                    continue  # hai câu không được dùng chung một đoạn audio

                gap = candidate["start"] - prev_candidate["end"]
                if gap >= -0.25:
                    link = TAKE_W_CONTINUITY * max(0.0, 1.0 - max(0.0, gap) / TAKE_RUN_GAP_SEC)
                else:
                    link = -TAKE_W_BACKJUMP
                total = previous_values[prev_index] + link
                if total > best_value:
                    best_value = total
                    best_path = previous_back[prev_index]

            if best_value == float("-inf"):
                # Mọi đường tới đây đều chồng audio — vẫn phải cho câu này một chỗ.
                best_value = max(previous_values)
                best_path = previous_back[previous_values.index(best_value)]
            values.append(best_value + own)
            backpointers.append(best_path + [(script_index, candidate["chunk_index"])])

        previous, previous_values, previous_back = current, values, backpointers

    best_index = previous_values.index(max(previous_values))
    chosen_pairs = dict(previous_back[best_index])
    return {
        script_index: next(
            c for c in candidates[script_index] if c["chunk_index"] == chunk_index
        )
        for script_index, chunk_index in chosen_pairs.items()
    }


def _snap_rows_to_word_boundaries(
    rows: List[Dict[str, Any]],
    chunks: List[Dict[str, Any]],
    lead_sec: float = 0.12,
    tail_sec: float = 0.18,
) -> List[Dict[str, Any]]:
    """Kéo điểm cắt ra biên từ trọn vẹn, rồi chừa lề trong đúng khoảng lặng có thật.

    Thay cho lối đệm mù trước đây (trừ cứng 0,08s ở đầu, cộng cứng 0,15s ở cuối).
    Đệm một hằng số thì không biết gì về chỗ mình đang cắt: đo trên bộ dữ liệu vàng,
    20% điểm cắt rơi vào GIỮA một từ — người xem nghe thấy âm tiết bị chém cụt.

    Hai bước:
      1. Mở ra biên từ trọn vẹn. Từ nào bị điểm cắt xén ngang thì lấy trọn từ đó,
         vì nó đã nằm trong đoạn được chọn rồi.
      2. Chừa lề, NHƯNG không lấn quá nửa khoảng lặng kề bên. Khoảng lặng rộng thì
         được trọn lề (giữ hơi thở, giữ độ vang); khoảng lặng hẹp thì lề co lại để
         không liếm sang từ của câu bên cạnh.
    """
    words: List[Tuple[float, float]] = []
    for chunk in chunks:
        for sub in chunk.get("sub_segments", []) or []:
            start, end = float(sub["start"]), float(sub["end"])
            if end > start:
                words.append((start, end))
    if not words:
        return rows
    words.sort()
    starts = [w[0] for w in words]

    for row in rows:
        row_start, row_end = float(row["start"]), float(row["end"])

        # Từ đầu tiên bị điểm cắt chạm tới, và từ cuối cùng còn nằm trong đoạn.
        first = bisect_left([w[1] for w in words], row_start + 0.02)
        last = bisect_left(starts, row_end - 0.02) - 1
        if first >= len(words) or last < 0 or first > last:
            continue

        new_start, new_end = words[first][0], words[last][1]
        gap_before = new_start - words[first - 1][1] if first > 0 else float("inf")
        gap_after = words[last + 1][0] - new_end if last + 1 < len(words) else float("inf")

        row["start"] = max(0.0, new_start - min(lead_sec, max(0.0, gap_before) / 2.0))
        row["end"] = new_end + min(tail_sec, max(0.0, gap_after) / 2.0)

    rows.sort(key=lambda r: (float(r["start"]), float(r["end"])))
    for index in range(1, len(rows)):
        previous_end = float(rows[index - 1]["end"])
        gap = float(rows[index]["start"]) - previous_end
        # Chỉ chống đè khi hai hàng THẬT SỰ nối tiếp nhau. Gap âm nhiều nghĩa là hàng
        # này lấy take ở chỗ khác trên timeline, ép nó về sau hàng trước là sai.
        if -0.5 < gap < 0.0:
            rows[index]["start"] = previous_end
    return rows


def _seconds_to_timecode(seconds: float, fps: int = 25) -> str:
    total_frames = max(0, int(round(seconds * fps)))
    hh = total_frames // (3600 * fps)
    mm = (total_frames % (3600 * fps)) // (60 * fps)
    ss = (total_frames % (60 * fps)) // fps
    ff = total_frames % fps
    return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"


def build_edl(timeline: List[Dict[str, Any]], title: str = "AUTO_CUT", fps: int = 25) -> str:
    lines = [f"TITLE: {title}", "FCM: NON-DROP FRAME", ""]
    record_cursor = 0.0

    event_number = 1
    for item in timeline:
        source_in = item["start"]
        source_out = item["end"]
        duration = max(0.0, source_out - source_in)
        if duration < 0.05:
            continue

        rec_in = record_cursor
        rec_out = rec_in + duration

        lines.append(
            f"{event_number:03d}  AX       V     C        "
            f"{_seconds_to_timecode(source_in, fps)} {_seconds_to_timecode(source_out, fps)} "
            f"{_seconds_to_timecode(rec_in, fps)} {_seconds_to_timecode(rec_out, fps)}"
        )
        lines.append(f"* FROM CLIP NAME: Script line {item['script_index'] + 1}")
        lines.append(f"* COMMENT: {item['script_text']}")

        record_cursor = rec_out
        event_number += 1

    return "\n".join(lines).strip() + "\n"


def build_simple_timeline_xml(timeline: List[Dict[str, Any]]) -> str:
    lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<timeline>"]
    for item in timeline:
        lines.append(
            "  <clip "
            f"script_index=\"{item['script_index'] + 1}\" "
            f"start=\"{item['start']:.3f}\" "
            f"end=\"{item['end']:.3f}\" "
            f"score=\"{item['score']:.3f}\">"
        )
        lines.append(f"    <script_text>{_escape_xml(item['script_text'])}</script_text>")
        lines.append(f"    <matched_text>{_escape_xml(item['matched_text'])}</matched_text>")
        lines.append("  </clip>")
    lines.append("</timeline>")
    return "\n".join(lines) + "\n"


def _escape_xml(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&apos;")
    )


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _token_coverage(script_text: str, transcript_text: str) -> float:
    """Bao nhiêu phần TỪ VỰNG CÓ SỨC NẶNG của câu kịch bản có mặt trong lời nói.

    Đếm theo trọng số chứ không đếm đầu từ: bỏ sót "canxi" không thể ngang giá với
    bỏ sót "thì". Và khớp cả theo khoá ngữ âm, nên "tỷ lệ" đọc thành "tỉ lệ" vẫn
    tính là có mặt.

    Không phạt số ở đây: hệ số phạt số đã nằm trong _similarity, cộng thêm lần nữa
    là tính hai lần cùng một bằng chứng.
    """
    matched_weight, script_weight, _ = _weighted_overlap(script_text, transcript_text)
    if script_weight <= 0:
        return 0.0
    return matched_weight / script_weight


def _loudness_norm(loudness_dbfs: float) -> float:
    return _clamp((loudness_dbfs + 30.0) / 10.0, 0.0, 1.0)


@dataclass(frozen=True)
class LoudnessProfile:
    p10: float
    p25: float
    p50: float
    background_soft: float
    background_hard: float
    sample_size: int


def _percentile(values: List[float], ratio: float) -> float:
    if not values:
        return 0.0
    if len(values) == 1:
        return float(values[0])
    sorted_values = sorted(float(v) for v in values)
    clamped_ratio = _clamp(ratio, 0.0, 1.0)
    pos = (len(sorted_values) - 1) * clamped_ratio
    left = int(pos)
    right = min(left + 1, len(sorted_values) - 1)
    frac = pos - left
    return sorted_values[left] + (sorted_values[right] - sorted_values[left]) * frac


def _compute_loudness_profile(rows: List[Dict[str, Any]]) -> Optional[LoudnessProfile]:
    if not rows:
        return None

    stable_loudness = [
        float(row.get("loudness_dBFS", -100.0))
        for row in rows
        if float(row.get("similarity", 0.0)) >= 0.70 and float(row.get("token_coverage", 0.0)) >= 0.65
    ]
    all_loudness = [float(row.get("loudness_dBFS", -100.0)) for row in rows]
    source = stable_loudness if len(stable_loudness) >= 3 else all_loudness
    if len(source) < 3:
        return None

    p10 = _percentile(source, 0.10)
    p25 = _percentile(source, 0.25)
    p50 = _percentile(source, 0.50)
    background_soft = min(p25 - 2.0, p10 + 0.5)
    background_hard = background_soft - 2.0
    return LoudnessProfile(
        p10=float(p10),
        p25=float(p25),
        p50=float(p50),
        background_soft=float(background_soft),
        background_hard=float(background_hard),
        sample_size=len(source),
    )


def _final_match_score(similarity: float, token_coverage: float, loudness_dbfs: float) -> float:
    # CẢI TIẾN: Tăng mạnh quyền lực của Token Coverage (Từ 13% lên 35%). 
    # AI sẽ "sợ" việc bỏ sót từ vựng vì sẽ bị rớt điểm rất nặng.
    return (
        0.55 * similarity
        + 0.35 * token_coverage
        + 0.10 * _loudness_norm(loudness_dbfs)
    )


def _sentence_gate_thresholds(sentence: str) -> Tuple[float, float]:
    """Ngưỡng riêng cho câu ngắn: (similarity tối thiểu, token_coverage tối thiểu).

    Từ khi split_sentences() không vứt câu dưới 3 từ nữa, những câu như "Đúng
    vậy." hay "Tuyệt vời." mới đi vào so khớp — và câu càng ngắn thì càng dễ khớp
    bừa: chỉ cần vài từ trùng là điểm đã cao, trong khi cả video có hàng chục chỗ
    trùng như thế. Câu dài tự nó đã đủ đặc trưng nên dùng ngưỡng chung, câu ngắn
    phải gần như khớp trọn vẹn mới được nhận.
    """
    token_count = len(_match_features_cached(sentence)[2])
    if token_count >= 5:
        return 0.0, 0.0
    if token_count >= 3:
        # Cố ý nới coverage xuống dưới 0.75: với câu ba từ thì 0.75 hoá ra là
        # "phải khớp cả ba từ", trong khi người nói vẫn hay đổi một từ ("Có EPA
        # ko?" đọc thành "có EPA hay chưa"). 0.65 cho phép lệch đúng một từ.
        return 0.60, 0.65
    return 0.85, 1.0


def _row_passes_sentence_gate(row: Dict[str, Any]) -> bool:
    min_similarity, min_coverage = _sentence_gate_thresholds(str(row.get("script_text", "")))
    if min_similarity <= 0.0 and min_coverage <= 0.0:
        return True
    return (
        float(row.get("similarity", 0.0)) >= min_similarity
        and float(row.get("token_coverage", 0.0)) >= min_coverage
    )


def _build_match_row(
    script_idx: int,
    chunk_idx: int,
    script_sentence: str,
    chunk: Dict[str, Any],
) -> Dict[str, Any]:
    similarity = _similarity(script_sentence, chunk["text"])
    token_coverage = _token_coverage(script_sentence, chunk["text"])
    loudness = float(chunk.get("loudness_dBFS", -100.0))
    score = _final_match_score(similarity, token_coverage, loudness)
    return {
        "script_index": script_idx,
        "chunk_index": chunk_idx,
        "start": float(chunk["start"]),
        "end": float(chunk["end"]),
        "script_text": script_sentence,
        "matched_text": chunk["text"],
        "loudness_dBFS": loudness,
        "similarity": similarity,
        "token_coverage": token_coverage,
        "score": score,
    }


def _best_match_row_for_sentence(
    script_idx: int,
    script_sentence: str,
    chunks: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    best_row: Optional[Dict[str, Any]] = None

    for chunk_idx, chunk in enumerate(chunks):
        sub_segments = chunk.get("sub_segments", [])

        if not sub_segments:
            candidate = _build_match_row(script_idx, chunk_idx, script_sentence, chunk)
        else:
            spans = _subsegment_span_candidates(script_sentence, sub_segments)
            if not spans:
                continue
            best_span = spans[0]
            candidate = {
                "script_index": script_idx,
                "chunk_index": chunk_idx,
                "start": best_span["start"],
                "end": best_span["end"],
                "script_text": script_sentence,
                "matched_text": best_span["text"],
                "loudness_dBFS": best_span["loudness_dBFS"],
                "similarity": best_span["similarity"],
                "token_coverage": best_span["token_coverage"],
                "score": best_span["score"],
            }

        if best_row is None:
            best_row = candidate
            continue

        candidate_key = (
            float(candidate.get("score", 0.0)),
            float(candidate.get("similarity", 0.0)),
            float(candidate.get("token_coverage", 0.0)),
            float(candidate.get("loudness_dBFS", -100.0)),
            float(candidate.get("end", 0.0)),
        )
        best_key = (
            float(best_row.get("score", 0.0)),
            float(best_row.get("similarity", 0.0)),
            float(best_row.get("token_coverage", 0.0)),
            float(best_row.get("loudness_dBFS", -100.0)),
            float(best_row.get("end", 0.0)),
        )
        if candidate_key > best_key:
            best_row = candidate

    return best_row


def _process_one_unmatched(
    script_idx: int,
    script_sentences: List[str],
    chunks: List[Dict[str, Any]],
) -> Tuple[int, Optional[Dict[str, Any]]]:
    sentence = script_sentences[script_idx]
    best_row = _best_match_row_for_sentence(script_idx, sentence, chunks)

    if best_row is None:
        return script_idx, None
    if (
        float(best_row.get("similarity", 0.0)) < 0.28
        or float(best_row.get("token_coverage", 0.0)) < 0.35
        or float(best_row.get("score", 0.0)) < 0.38
    ):
        return script_idx, None
    if not _row_passes_sentence_gate(best_row):
        return script_idx, None

    return script_idx, best_row


def _expand_n_to_one_matches(
    script_sentences: List[str],
    chunks: List[Dict[str, Any]],
    matched_rows: Dict[int, Dict[str, Any]],
) -> Tuple[Dict[int, Dict[str, Any]], int]:
    if not matched_rows:
        return matched_rows, 0

    unmatched_script_indices = [i for i in range(len(script_sentences)) if i not in matched_rows]

    if unmatched_script_indices:
        max_workers = min(4, os.cpu_count() or 1)
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = [
                executor.submit(
                    _process_one_unmatched,
                    script_idx,
                    script_sentences,
                    chunks,
                )
                for script_idx in unmatched_script_indices
            ]
            matched_candidates = [future.result() for future in futures]

        for script_idx, best_row in sorted(matched_candidates, key=lambda item: item[0]):
            if best_row is not None:
                matched_rows[script_idx] = best_row

    shared_groups = {}
    for row in matched_rows.values():
        shared_groups.setdefault(row["chunk_index"], []).append(row["script_index"])
    n_to_one_shared_chunks = sum(1 for script_indices in shared_groups.values() if len(script_indices) > 1)

    return matched_rows, n_to_one_shared_chunks


def _subsegment_span_candidates(
    script_text: str,
    sub_segments: List[Dict[str, Any]],
    max_window: int = 40,
    max_span_sec: float = 12.0,
) -> List[Dict[str, Any]]:
    candidates: List[Dict[str, Any]] = []
    n = len(sub_segments)
    if n == 0:
        return candidates

    # 1. Thuật toán quét cửa sổ trượt (Sliding Window)
    for i in range(n):
        span_text_parts: List[str] = []
        loud_sum = 0.0
        dur_sum = 0.0
        span_start = float(sub_segments[i]["start"])
        span_end = span_start

        for j in range(i, min(n, i + max_window)):
            sub = sub_segments[j]
            seg_text = str(sub.get("text", "")).strip()
            if not seg_text:
                continue

            span_text_parts.append(seg_text)
            span_end = float(sub["end"])
            sub_duration = max(0.0, float(sub["end"]) - float(sub["start"]))
            loud_sum += float(sub.get("loudness_dBFS", 0.0)) * sub_duration
            dur_sum += sub_duration

            if span_end - span_start > max_span_sec:
                break

            span_text = " ".join(span_text_parts).strip()
            if not span_text:
                continue

            loudness = (loud_sum / dur_sum) if dur_sum > 0 else float(sub.get("loudness_dBFS", 0.0))
            similarity = _similarity(script_text, span_text)
            token_coverage = _token_coverage(script_text, span_text)
            base_score = _final_match_score(similarity, token_coverage, loudness)
            score = base_score

            # CẢI TIẾN: Thưởng điểm nếu lấy đủ 100% từ vựng cốt lõi -> Chống lẹm đầu lẹm đuôi
            if token_coverage >= 0.95:
                score += 0.06

            candidates.append({
                "start": span_start,
                "end": span_end,
                "text": span_text,
                "loudness_dBFS": loudness,
                "similarity": similarity,
                "token_coverage": token_coverage,
                "score": score,
                "base_score": base_score,
            })

    # 2. Thuật toán Căn chỉnh Ký tự (NLP Alignment)
    chunk_text = ""
    char_to_sub = []
    for i, sub in enumerate(sub_segments):
        word = str(sub.get("text", "")).strip() + " "
        chunk_text += word
        char_to_sub.extend([i] * len(word))

    def clean_len_preserve(t: str) -> str:
        t = t.lower()
        t = "".join(c if c.isalnum() else " " for c in t)
        return _strip_diacritics_cached(t)

    script_clean = clean_len_preserve(script_text)
    chunk_clean = clean_len_preserve(chunk_text)

    matcher = SequenceMatcher(None, script_clean, chunk_clean)
    blocks = matcher.get_matching_blocks()
    
    valid_blocks = [b for b in blocks if b.size >= 3]
    if not valid_blocks:
        valid_blocks = [b for b in blocks if b.size >= 2]
        
    if valid_blocks:
        start_char = valid_blocks[0].b
        end_char = valid_blocks[-1].b + valid_blocks[-1].size - 1
        
        start_char = max(0, min(start_char, len(char_to_sub) - 1))
        end_char = max(0, min(end_char, len(char_to_sub) - 1))

        start_idx = char_to_sub[start_char]
        end_idx = char_to_sub[end_char]

        if start_idx <= end_idx:
            span_subs = sub_segments[start_idx:end_idx + 1]
            span_start = float(span_subs[0]["start"])
            span_end = float(span_subs[-1]["end"])
            span_text = " ".join(str(s.get("text", "")).strip() for s in span_subs if str(s.get("text", "")).strip())

            loud_sum = sum(float(s.get("loudness_dBFS", 0.0)) * max(0.0, float(s["end"]) - float(s["start"])) for s in span_subs)
            dur_sum = sum(max(0.0, float(s["end"]) - float(s["start"])) for s in span_subs)
            loudness = (loud_sum / dur_sum) if dur_sum > 0 else float(span_subs[0].get("loudness_dBFS", 0.0))

            similarity = _similarity(script_text, span_text)
            token_coverage = _token_coverage(script_text, span_text)
            base_score = _final_match_score(similarity, token_coverage, loudness)
            score = base_score

            # CẢI TIẾN: NLP Alignment thường chốt biên rất chuẩn. Nếu nó tìm được cụm bao trọn vẹn từ
            # Thưởng siêu đậm để ép AI chọn ứng viên này làm Winner thay vì ứng viên của Sliding Window.
            if token_coverage >= 0.95:
                score += 0.08 
            else:
                score += 0.03

            candidates.append({
                "start": span_start,
                "end": span_end,
                "text": span_text,
                "loudness_dBFS": loudness,
                "similarity": similarity,
                "token_coverage": token_coverage,
                "score": score,
                "base_score": base_score,
            })

    candidates.sort(
        key=lambda c: (
            c["score"],
            c["similarity"],
            c["token_coverage"],
            -(c["end"] - c["start"]),
        ),
        reverse=True,
    )
    return candidates


def _interval_overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _split_sentence_into_clauses(text: str) -> List[str]:
    parts = re.split(r"[,;]+", text)
    clauses = [p.strip(" .!?-\t") for p in parts if p.strip()]
    return [c for c in clauses if len(c.split()) >= 4]


def _recover_missing_clauses_for_low_coverage_rows(
    rows: List[Dict[str, Any]],
    chunks: List[Dict[str, Any]],
    coverage_trigger: float = 0.58,
    clause_cov_in_row_max: float = 0.60,
    clause_token_coverage_min: float = 0.60,
    clause_similarity_min: float = 0.35,
) -> List[Dict[str, Any]]:
    if not rows or not chunks:
        return []

    used_intervals: List[Tuple[float, float]] = sorted(
        [
            (float(row.get("start", 0.0)), float(row.get("end", 0.0)))
            for row in rows
            if float(row.get("end", 0.0)) > float(row.get("start", 0.0))
        ]
    )
    recovered: List[Dict[str, Any]] = []
    rows_sorted_by_script = sorted(rows, key=lambda r: int(r.get("script_index", -1)))
    prev_end_by_script: Dict[int, float] = {}
    last_end = float("-inf")
    for row_item in rows_sorted_by_script:
        script_idx = int(row_item.get("script_index", -1))
        prev_end_by_script[script_idx] = last_end
        last_end = max(last_end, float(row_item.get("end", last_end)))

    def _interval_is_free(start: float, end: float) -> bool:
        overlap = sum(_interval_overlap(start, end, u0, u1) for u0, u1 in used_intervals)
        return overlap <= 0.12

    for row in rows:
        script_text = str(row.get("script_text", "")).strip()
        matched_text = str(row.get("matched_text", "")).strip()
        if not script_text or not matched_text:
            continue
        if len(script_text.split()) < 12:
            continue
        if float(row.get("token_coverage", 0.0)) >= coverage_trigger:
            continue

        clauses = _split_sentence_into_clauses(script_text)
        if len(clauses) < 2:
            continue

        anchor_mid = (float(row.get("start", 0.0)) + float(row.get("end", 0.0))) / 2.0
        row_script_idx = int(row.get("script_index", -1))
        prev_script_end = prev_end_by_script.get(row_script_idx, float("-inf"))
        local_left_bound = prev_script_end - 1.0 if prev_script_end > float("-inf") else float("-inf")
        local_right_bound = float(row.get("end", 0.0)) + 25.0
        for clause in clauses:
            if _token_coverage(clause, matched_text) > clause_cov_in_row_max:
                continue

            best_local: Optional[Dict[str, Any]] = None
            best_local_rank = float("-inf")
            best_local_relaxed: Optional[Dict[str, Any]] = None
            best_local_relaxed_rank = float("-inf")
            best_near: Optional[Dict[str, Any]] = None
            best_near_rank = float("-inf")
            best_near_relaxed: Optional[Dict[str, Any]] = None
            best_near_relaxed_rank = float("-inf")

            for chunk_idx, chunk in enumerate(chunks):
                sub_segments = chunk.get("sub_segments", [])
                if not sub_segments:
                    continue
                spans = _subsegment_span_candidates(clause, sub_segments)
                if not spans:
                    continue

                for span in spans[:6]:
                    start = float(span["start"])
                    end = float(span["end"])
                    if not _interval_is_free(start, end):
                        continue
                    span_cov = float(span["token_coverage"])
                    span_sim = float(span["similarity"])
                    strict_ok = span_cov >= clause_token_coverage_min and span_sim >= clause_similarity_min
                    relaxed_ok = span_cov >= (clause_token_coverage_min - 0.10) and span_sim >= (clause_similarity_min - 0.03)
                    if not strict_ok and not relaxed_ok:
                        continue

                    span_mid = (start + end) / 2.0
                    distance = abs(span_mid - anchor_mid)
                    rank = float(span["score"]) - min(distance, 80.0) / 250.0

                    cand = {
                        "script_index": int(row["script_index"]),
                        "chunk_index": int(chunk_idx),
                        "start": start,
                        "end": end,
                        "script_text": clause,
                        "matched_text": str(span["text"]),
                        "loudness_dBFS": float(span["loudness_dBFS"]),
                        "similarity": float(span["similarity"]),
                        "token_coverage": float(span["token_coverage"]),
                        "score": float(span["score"]),
                        "is_clause_recovery": True,
                        "parent_script_index": int(row["script_index"]),
                    }

                    in_near = distance <= 35.0
                    in_local = start >= local_left_bound and end <= local_right_bound

                    if strict_ok:
                        if in_near and rank > best_near_rank:
                            best_near = cand
                            best_near_rank = rank
                        if in_local and rank > best_local_rank:
                            best_local = cand
                            best_local_rank = rank
                    elif relaxed_ok:
                        if in_near and rank > best_near_relaxed_rank:
                            best_near_relaxed = cand
                            best_near_relaxed_rank = rank
                        if in_local and rank > best_local_relaxed_rank:
                            best_local_relaxed = cand
                            best_local_relaxed_rank = rank

            chosen = (
                best_local
                if best_local is not None
                else (
                    best_near
                    if best_near is not None
                    else (
                        best_local_relaxed
                        if best_local_relaxed is not None
                        else best_near_relaxed
                    )
                )
            )
            if chosen is None:
                continue

            recovered.append(chosen)
            used_intervals.append((float(chosen["start"]), float(chosen["end"])))
            used_intervals.sort()

    return recovered


def _merge_close_or_overlapping_rows(
    rows: List[Dict[str, Any]],
    merge_gap_sec: float = 0.8,
) -> List[Dict[str, Any]]:
    if not rows:
        return []

    rows_by_time = sorted(
        (dict(row) for row in rows),
        key=lambda r: (float(r.get("start", 0.0)), float(r.get("end", 0.0))),
    )

    for row in rows_by_time:
        if "merged_script_indices" not in row:
            row["merged_script_indices"] = [int(row.get("script_index", -1))]

    merged: List[Dict[str, Any]] = [rows_by_time[0]]
    for nxt in rows_by_time[1:]:
        cur = merged[-1]
        cur_end = float(cur.get("end", 0.0))
        next_start = float(nxt.get("start", 0.0))
        gap = next_start - cur_end
        if gap > merge_gap_sec:
            merged.append(nxt)
            continue

        cur_start = float(cur.get("start", 0.0))
        next_end = float(nxt.get("end", 0.0))
        new_start = min(cur_start, next_start)
        new_end = max(cur_end, next_end)

        cur_dur = max(0.001, cur_end - cur_start)
        nxt_dur = max(0.001, next_end - next_start)
        total_dur = cur_dur + nxt_dur

        def _weighted(field: str) -> float:
            return (
                float(cur.get(field, 0.0)) * cur_dur
                + float(nxt.get(field, 0.0)) * nxt_dur
            ) / total_dur

        cur["start"] = new_start
        cur["end"] = new_end
        cur["loudness_dBFS"] = _weighted("loudness_dBFS")
        cur["similarity"] = _weighted("similarity")
        cur["token_coverage"] = _weighted("token_coverage")
        cur["score"] = _weighted("score")

        cur_scripts = str(cur.get("script_text", "")).strip()
        nxt_scripts = str(nxt.get("script_text", "")).strip()
        if nxt_scripts and nxt_scripts not in cur_scripts:
            cur["script_text"] = f"{cur_scripts} {nxt_scripts}".strip()

        cur_raw = str(cur.get("matched_text", "")).strip()
        nxt_raw = str(nxt.get("matched_text", "")).strip()
        if nxt_raw and nxt_raw not in cur_raw:
            cur["matched_text"] = f"{cur_raw} {nxt_raw}".strip()

        merged_indices = list(cur.get("merged_script_indices", [])) + list(nxt.get("merged_script_indices", []))
        # Giữ unique theo thứ tự xuất hiện.
        deduped_indices: List[int] = []
        seen = set()
        for idx in merged_indices:
            idx_int = int(idx)
            if idx_int in seen:
                continue
            seen.add(idx_int)
            deduped_indices.append(idx_int)
        cur["merged_script_indices"] = deduped_indices
        if deduped_indices:
            cur["script_index"] = deduped_indices[0]

        if cur.get("chunk_index") != nxt.get("chunk_index"):
            cur["chunk_index"] = -1
            cur["shared_chunk_index"] = -1
        if "audio_flag" in nxt and "audio_flag" not in cur:
            cur["audio_flag"] = nxt["audio_flag"]

    return merged


def _rematch_shared_chunk_intervals(
    rows: List[Dict[str, Any]],
    chunks_by_index: Dict[int, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    if not rows:
        return []

    grouped: Dict[int, List[int]] = {}
    for idx, row in enumerate(rows):
        chunk_idx = int(row.get("chunk_index", -1))
        grouped.setdefault(chunk_idx, []).append(idx)

    output = [dict(row) for row in rows]
    for chunk_idx, row_indices in grouped.items():
        if chunk_idx < 0 or not row_indices:
            continue

        chunk = chunks_by_index.get(chunk_idx, {})
        sub_segments = list(chunk.get("sub_segments", []))
        if not sub_segments:
            continue

        sub_segments.sort(key=lambda s: (float(s["start"]), float(s["end"])))

        ordered = sorted(
            row_indices,
            key=lambda i: (
                len(_normalize_for_match_cached(output[i]["script_text"]).split()),
                -float(output[i].get("score", 0.0)),
                -float(output[i].get("similarity", 0.0)),
            ),
        )

        used_intervals: List[Tuple[float, float]] = []
        for row_idx in ordered:
            row = output[row_idx]
            candidates = _subsegment_span_candidates(row["script_text"], sub_segments)
            if not candidates:
                continue

            min_quality = max(0.38, float(row.get("similarity", 0.0)) - 0.18)
            feasible = [c for c in candidates if c["similarity"] >= min_quality and c["token_coverage"] >= 0.25]
            if not feasible:
                feasible = candidates

            chosen: Optional[Dict[str, Any]] = None
            ordered_candidates = sorted(
                feasible,
                key=lambda c: (
                    -sum(_interval_overlap(c["start"], c["end"], u0, u1) for u0, u1 in used_intervals),
                    c["score"],
                    c["similarity"],
                ),
                reverse=True,
            )

            for overlap_cap in (0.08, 0.20, 0.40):
                for cand in ordered_candidates:
                    overlap = sum(_interval_overlap(cand["start"], cand["end"], u0, u1) for u0, u1 in used_intervals)
                    if overlap <= overlap_cap:
                        chosen = cand
                        break
                if chosen is not None:
                    break

            if chosen is None:
                chosen = ordered_candidates[0]

            row["start"] = float(chosen["start"])
            row["end"] = float(chosen["end"])
            row["matched_text"] = chosen["text"]
            row["loudness_dBFS"] = float(chosen["loudness_dBFS"])
            row["similarity"] = float(chosen["similarity"])
            row["token_coverage"] = float(chosen["token_coverage"])
            row["score"] = float(chosen["score"])
            row["shared_chunk_index"] = chunk_idx
            row["shared_chunk_group_size"] = len(ordered)

            used_intervals.append((row["start"], row["end"]))
            used_intervals.sort()

    return output


def _retry_background_candidates_by_loudness(
    rows: List[Dict[str, Any]],
    chunks_by_index: Dict[int, Dict[str, Any]],
    profile: LoudnessProfile,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    if not rows:
        return [], []

    output = [dict(row) for row in rows]
    review_flags: List[Dict[str, Any]] = []

    for row in output:
        current_loudness = float(row.get("loudness_dBFS", -100.0))
        current_similarity = float(row.get("similarity", 0.0))
        is_soft_background = current_loudness <= profile.background_soft
        is_relative_low = current_loudness <= (profile.p25 - 0.8) and current_similarity < 0.75
        if not (is_soft_background or is_relative_low):
            continue

        chunk_idx = int(row.get("chunk_index", -1))
        chunk = chunks_by_index.get(chunk_idx, {})
        sub_segments = list(chunk.get("sub_segments", []))
        if not sub_segments:
            if current_loudness <= profile.background_hard:
                row["audio_flag"] = "possible_background"
                review_flags.append(
                    {
                        "script_index": int(row.get("script_index", -1)),
                        "audio_flag": "possible_background",
                        "reason": "hard_low_loudness",
                        "loudness_dBFS": current_loudness,
                    }
                )
            continue

        candidates = _subsegment_span_candidates(str(row.get("script_text", "")), sub_segments)
        if not candidates:
            continue

        curr_start = float(row.get("start", 0.0))
        curr_end = float(row.get("end", 0.0))
        curr_similarity = float(row.get("similarity", 0.0))
        curr_coverage = float(row.get("token_coverage", 0.0))
        curr_score = float(row.get("score", 0.0))

        replacement: Optional[Dict[str, Any]] = None
        for cand in candidates:
            cand_start = float(cand.get("start", 0.0))
            cand_end = float(cand.get("end", 0.0))
            if abs(cand_start - curr_start) < 0.05 and abs(cand_end - curr_end) < 0.05:
                continue
            if float(cand.get("token_coverage", 0.0)) < curr_coverage - 0.05:
                continue
            if float(cand.get("similarity", 0.0)) < curr_similarity - 0.06:
                continue
            if float(cand.get("loudness_dBFS", -100.0)) <= current_loudness + 0.8:
                continue
            replacement = cand
            break

        if replacement is not None:
            row["start"] = float(replacement["start"])
            row["end"] = float(replacement["end"])
            row["matched_text"] = str(replacement["text"])
            row["loudness_dBFS"] = float(replacement["loudness_dBFS"])
            row["similarity"] = float(replacement["similarity"])
            row["token_coverage"] = float(replacement["token_coverage"])
            row["score"] = float(replacement["score"])
            row["audio_flag"] = "background_replaced"
            review_flags.append(
                {
                    "script_index": int(row.get("script_index", -1)),
                    "audio_flag": "background_replaced",
                    "reason": "retry_candidate",
                    "old_loudness_dBFS": current_loudness,
                    "new_loudness_dBFS": float(replacement["loudness_dBFS"]),
                    "old_score": curr_score,
                    "new_score": float(replacement["score"]),
                }
            )
            continue

        if current_loudness <= profile.background_hard:
            row["audio_flag"] = "possible_background"
            review_flags.append(
                {
                    "script_index": int(row.get("script_index", -1)),
                    "audio_flag": "possible_background",
                    "reason": "hard_low_loudness_no_better_candidate",
                    "loudness_dBFS": current_loudness,
                }
            )

    return output, review_flags


def rescan_missing_script_sentences(
    script_sentences: List[str],
    chunks: List[Dict[str, Any]],
    existing_rows: List[Dict[str, Any]],
    token_coverage_threshold: float = 0.60,
    similarity_threshold: float = 0.35,
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    matched_indices = {int(row.get("script_index", -1)) for row in existing_rows}
    recovered_rows: List[Dict[str, Any]] = []
    still_unmatched: List[Dict[str, Any]] = []

    for script_idx, script_sentence in enumerate(script_sentences):
        if script_idx in matched_indices:
            continue

        best_row = _best_match_row_for_sentence(script_idx, script_sentence, chunks)
        if (
            best_row is not None
            and float(best_row.get("token_coverage", 0.0)) >= token_coverage_threshold
            and float(best_row.get("similarity", 0.0)) >= similarity_threshold
            and _row_passes_sentence_gate(best_row)
        ):
            recovered_rows.append(best_row)
            continue

        payload = {"script_index": script_idx, "script_text": script_sentence}
        if best_row is not None:
            payload["best_similarity"] = round(float(best_row.get("similarity", 0.0)), 4)
            payload["best_token_coverage"] = round(float(best_row.get("token_coverage", 0.0)), 4)
            payload["best_score"] = round(float(best_row.get("score", 0.0)), 4)
        still_unmatched.append(payload)

    return recovered_rows, still_unmatched


def _build_mapped_chunks(
    chunks: List[Dict[str, Any]],
    rows: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Bảng phân đoạn cho màn "Rà soát so khớp kịch bản".

    Bản cũ trả về NGUYÊN chunk và tick chọn khi hàng phủ quá 40% thời lượng
    chunk. Hai hậu quả, cả hai đều nặng:

    1. Hàng khớp chính xác nằm trong một chunk dài thì bị rớt. Chunk 24 giây chứa
       hai câu, mỗi câu khớp similarity 1.000, mỗi hàng phủ ~30% chunk — không
       hàng nào đủ 40%, cả chunk không được tick, cả hai câu biến mất khỏi
       timeline. Càng cắt biên chính xác thì càng dễ bị rớt.
    2. Biên tinh mà pipeline dày công tính ra (span mức từ, padding, snap) bị vứt
       ở đúng bước bàn giao: UI nhận biên chunk, /finalize-timeline dựng timeline
       từ biên chunk, nên mọi cải tiến về biên đều vô hình.

    Nay cắt chunk TẠI biên hàng: phần trùng hàng thành một mục đã tick mang đúng
    thời gian của hàng, phần thừa đầu/đuôi thành mục chưa tick để người dùng vẫn
    nhìn thấy và tick thêm nếu muốn.
    """
    if not chunks and not rows:
        return []

    words: List[Tuple[float, str]] = []
    for chunk in chunks:
        for sub in chunk.get("sub_segments", []) or []:
            text = str(sub.get("text", "")).strip()
            if text:
                words.append(((float(sub["start"]) + float(sub["end"])) / 2.0, text))
    words.sort(key=lambda item: item[0])
    word_times = [item[0] for item in words]

    def text_in_range(start: float, end: float) -> str:
        left = bisect_left(word_times, start)
        right = bisect_left(word_times, end)
        return " ".join(words[i][1] for i in range(left, right)).strip()

    boundaries = set()
    for chunk in chunks:
        boundaries.add(round(float(chunk["start"]), 3))
        boundaries.add(round(float(chunk["end"]), 3))
    for row in rows:
        boundaries.add(round(float(row["start"]), 3))
        boundaries.add(round(float(row["end"]), 3))
    ordered = sorted(boundaries)

    pieces: List[Dict[str, Any]] = []
    for start, end in zip(ordered, ordered[1:]):
        if end - start <= 0.02:  # mẩu vụn do làm tròn
            continue

        owner_row = None
        owner_overlap = 0.0
        for index, row in enumerate(rows):
            covered = _interval_overlap(start, end, float(row["start"]), float(row["end"]))
            if covered > owner_overlap:
                owner_row, owner_overlap = (index, row), covered
        # Hàng chỉ liếm qua một mẩu thì mẩu đó không thuộc về hàng.
        if owner_row is not None and owner_overlap < (end - start) * 0.5:
            owner_row = None

        source_chunk = None
        for index, chunk in enumerate(chunks):
            if _interval_overlap(start, end, float(chunk["start"]), float(chunk["end"])) > 0:
                source_chunk = (index, chunk)
                break
        if owner_row is None and source_chunk is None:
            continue  # khoảng lặng giữa các chunk, không có gì để hiển thị

        if owner_row is not None:
            row_index, row = owner_row
            script_index = int(row.get("script_index", -1))
            pieces.append({
                "key": ("row", row_index),
                "start": start,
                "end": end,
                # KHÔNG rơi về matched_text ngay tại đây. Mẩu không chứa từ nào (biên mẩu
                # rơi vào quãng lặng) mà đã lấy nguyên matched_text của CẢ HÀNG thì bước gộp
                # bên dưới nối chúng lại thành 2-3 bản sao của cùng một câu: đo trên dự án
                # thật, 9/10 mục đã tick có text dài gấp 2-3 lần lời nói thật (78 từ cho 26
                # từ audio). Fallback chỉ được dùng khi mục ĐÃ GỘP XONG mà vẫn rỗng.
                "text": text_in_range(start, end),
                "_fallback_text": str(row.get("matched_text", "")),
                "is_selected": True,
                "script_index": script_index,
                "script_text": str(row.get("script_text", "")),
                "matched_text": str(row.get("matched_text", "")),
                "loudness_dBFS": round(float(row.get("loudness_dBFS", 0.0)), 2),
                "similarity": round(float(row.get("similarity", 0.0)), 4),
                "token_coverage": round(float(row.get("token_coverage", 0.0)), 4),
                "score": round(float(row.get("score", 0.0)), 4),
                "merged_script_indices": [
                    int(idx) for idx in row.get("merged_script_indices", [script_index])
                ],
                "source_chunk_index": source_chunk[0] if source_chunk else -1,
            })
            continue

        chunk_index, chunk = source_chunk
        pieces.append({
            "key": ("chunk", chunk_index),
            "start": start,
            "end": end,
            "text": text_in_range(start, end),
            "_fallback_text": str(chunk.get("text", "")),
            "is_selected": False,
            "script_index": -1,
            "script_text": "",
            "matched_text": "",
            "loudness_dBFS": round(float(chunk.get("loudness_dBFS", 0.0)), 2),
            "similarity": 0.0,
            "token_coverage": 0.0,
            "score": 0.0,
            "merged_script_indices": [],
            "source_chunk_index": chunk_index,
        })

    merged: List[Dict[str, Any]] = []
    for piece in pieces:
        previous = merged[-1] if merged else None
        if (
            previous is not None
            and previous["key"] == piece["key"]
            and abs(previous["end"] - piece["start"]) <= 0.021
        ):
            previous["end"] = piece["end"]
            joined = " ".join(part for part in (previous["text"], piece["text"]) if part).strip()
            previous["text"] = joined
            continue
        merged.append(dict(piece))

    for piece in merged:
        piece.pop("key", None)
        if not piece["text"]:
            piece["text"] = piece.get("_fallback_text", "")
        piece.pop("_fallback_text", None)
        piece["start"] = round(float(piece["start"]), 3)
        piece["end"] = round(float(piece["end"]), 3)
    return merged


# =============================================================================
# SẮP XẾP TIMELINE THEO KỊCH BẢN — gán nhãn câu cho các block ĐANG CÓ trên timeline
#
# Khác hẳn deterministic_filter_pipeline: ở đây người dùng ĐÃ chọn xong vùng nào giữ
# (ở màn rà soát step2, hoặc tự cắt tay ở Timeline). Việc còn lại chỉ là NÓI XEM mỗi
# block ứng với câu kịch bản nào, để renderer sắp lại theo thứ tự kịch bản. Vì thế:
#
#   - KHÔNG chọn take: không dùng select_takes_globally, không prior "take cuối",
#     không thưởng liên tục. Câu được đọc lại nhiều lần mà cả mấy lần đều đang nằm
#     trên timeline là chuyện người dùng cố ý — giữ cả, xếp liền nhau.
#   - KHÔNG đọc session_segments.json. Dòng từ đi kèm từng block (sub_segments) mới là
#     sự thật: block có thể đã bị người dùng trim hoặc cắt sau khi chốt timeline.
#   - KHÔNG sửa gì trong pipeline so khớp. Hàm này chỉ GỌI lại primitive của nó
#     (split_sentences, _similarity, _subsegment_span_candidates,
#     _snap_rows_to_word_boundaries), nên npm run eval:matching không đổi một điểm nào.
#
# BẤT BIẾN QUAN TRỌNG: block chỉ ra ĐÚNG MỘT mảnh thì thời gian của nó được giữ NGUYÊN
# XI, không snap, không nới lề. Tính năng này là "sắp xếp lại", không phải "trim lại" —
# lặng lẽ dịch biên của mọi block chỉ vì người dùng bấm nút sắp xếp là phá hoại.
# Chỉ block phải CẮT (ra từ 2 mảnh trở lên) mới đi qua _snap_rows_to_word_boundaries.

ALIGN_COARSE_THRESHOLD = 0.30    # dưới mức này thì không sinh ứng viên span cho cặp đó
ALIGN_MIN_PIECE_SCORE = 0.45     # span yếu hơn thì không đáng coi là một mảnh
ALIGN_MIN_PIECE_SEC = 0.30       # mảnh ngắn hơn thì không đáng cắt riêng ra
ALIGN_SKIP_WORD_PENALTY = 0.02   # phạt mỗi từ bị bỏ trắng, để DP đừng bỏ sót nửa block
ALIGN_MAX_SPANS_PER_SENTENCE = 3 # mỗi câu giữ mấy ứng viên tốt nhất trong một block


def _align_block_words(block: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Dòng từ của một block, chấp nhận cả khoá 'text' lẫn 'word'.

    sub_segments do preprocess_transcript_segments sinh ra dùng 'text', còn dữ liệu ASR
    thô dùng 'word'; block đi qua buildSplitTimelineItems ở renderer thì đã chuẩn về
    'text'. Nhận cả hai để không phụ thuộc block đến từ đường nào.
    """
    words: List[Dict[str, Any]] = []
    for sub in (block.get("sub_segments") or []):
        if not isinstance(sub, dict):
            continue
        text = str(sub.get("text") or sub.get("word") or "").strip()
        try:
            start = float(sub["start"])
            end = float(sub["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if not text or not (end > start):
            continue
        words.append({
            "text": text,
            "start": start,
            "end": end,
            "loudness_dBFS": _safe_to_float(sub.get("loudness_dBFS"), _safe_to_float(block.get("loudness_dBFS"), 0.0)),
        })
    words.sort(key=lambda w: (w["start"], w["end"]))
    return words


def _align_word_range_for_span(
    words: List[Dict[str, Any]], span_start: float, span_end: float
) -> Optional[Tuple[int, int]]:
    """Dải chỉ số từ mà một span (đo bằng giây) phủ — theo ĐIỂM GIỮA của từ.

    Dùng điểm giữa cho cùng luật với buildSplitTimelineItems ở renderer, nếu không thì
    backend nói mảnh gồm từ 3..7 mà renderer cắt ra lại thành từ 3..8.
    """
    first = -1
    last = -1
    for index, word in enumerate(words):
        midpoint = (word["start"] + word["end"]) / 2.0
        if span_start - 0.01 <= midpoint <= span_end + 0.01:
            if first < 0:
                first = index
            last = index
    if first < 0 or last < first:
        return None
    return first, last


def align_blocks_to_script(
    reference_script: str,
    blocks: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """Gán câu kịch bản cho từng block timeline, cắt nhỏ block phủ nhiều câu.

    `blocks`: [{index, start, end, text, sub_segments[], loudness_dBFS}] — text và
              sub_segments do BACKEND dựng từ bản bóc băng cả video, không phải do renderer
              gửi lên: dữ liệu của renderer ở step3 đã được chứng minh là hỏng (text nhân
              2-3 lần, sub_segments rỗng).

    ĐÃ GỠ tham số `hints` (2026-08-22): nó nhận nhãn script_index mà renderer "đã kiểm
    chứng", nhưng nhãn ở step3 do native addon ĐIỀN TRƯỢT nên vô giá trị. Một đường duy
    nhất: mọi block đều đi qua bộ dò span, không tin gì dữ liệu cũ.

    Trả về {sentence_count, pieces[], unmatched_blocks[], missing_sentences[]}.
    """
    sentences = split_sentences(reference_script or "")
    prepared: List[Dict[str, Any]] = []
    for position, raw in enumerate(blocks or []):
        if not isinstance(raw, dict):
            continue
        try:
            start = float(raw["start"])
            end = float(raw["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if not (end > start):
            continue
        words = _align_block_words(raw)
        text = str(raw.get("text") or "").strip() or " ".join(w["text"] for w in words)
        index = raw.get("index")
        prepared.append({
            "index": int(index) if isinstance(index, int) else position,
            "start": start,
            "end": end,
            "text": text,
            "words": words,
            "loudness_dBFS": _safe_to_float(raw.get("loudness_dBFS"), 0.0),
        })

    pieces: List[Dict[str, Any]] = []
    unmatched_blocks: List[int] = []

    for block in prepared:
        block_index = block["index"]

        words = block["words"]
        if not words or not sentences:
            unmatched_blocks.append(block_index)
            continue

        # 1. Lọc thô: chỉ dò span cho câu có dính dáng tới văn bản của block.
        block_features = _match_features_cached(block["text"])
        interesting: List[int] = []
        for script_index, sentence in enumerate(sentences):
            sentence_features = _match_features_cached(sentence)
            if _quick_token_overlap(sentence_features[3], block_features[3]) <= 0.0:
                continue
            if _similarity(sentence, block["text"]) >= ALIGN_COARSE_THRESHOLD:
                interesting.append(script_index)

        # 2. Sinh ứng viên span mức từ, quy về dải chỉ số từ trong dòng từ của block.
        items: List[Dict[str, Any]] = []
        for script_index in interesting:
            candidates = _subsegment_span_candidates(sentences[script_index], words)
            kept = 0
            for candidate in candidates:
                if candidate["score"] < ALIGN_MIN_PIECE_SCORE:
                    continue
                if candidate["end"] - candidate["start"] < ALIGN_MIN_PIECE_SEC:
                    continue
                # Cổng câu ngắn, dùng chung với pipeline: câu 3-4 từ phải khớp gần trọn,
                # câu <=2 từ phải khớp trọn. Câu ngắn khớp bừa thì cả video có hàng chục chỗ.
                if not _row_passes_sentence_gate({
                    "script_text": sentences[script_index],
                    "similarity": candidate["similarity"],
                    "token_coverage": candidate["token_coverage"],
                }):
                    continue
                word_range = _align_word_range_for_span(words, candidate["start"], candidate["end"])
                if word_range is None:
                    continue
                word_count = word_range[1] - word_range[0] + 1
                items.append({
                    "script_index": script_index,
                    "word_from": word_range[0],
                    "word_to": word_range[1],
                    # ĐIỂM PHẢI NHÂN VỚI SỐ TỪ. Cộng dồn điểm thô theo từng mảnh là hàm mục
                    # tiêu thiên vị CẮT VỤN: hai mảnh bao giờ cũng cộng ra nhiều hơn một
                    # mảnh, nên DP xé block ra để vơ thêm điểm. Đo trên bộ dữ liệu vàng:
                    # nem_house sinh 17 mảnh cho 11 câu và bỏ sót 3 câu, vì một mẩu 0,8 giây
                    # nói "EPA có" khớp trọn câu ngắn "Có EPA ko?" (điểm 0,98) rồi đẩy câu
                    # dài thật sự của block ra ngoài. Nhân với số từ thì mảnh phải TRẢ GIÁ
                    # bằng đúng số từ nó chiếm, và phạt bỏ trắng cũng tính trên cùng đơn vị.
                    "value": candidate["score"] * word_count,
                    "similarity": candidate["similarity"],
                    "token_coverage": candidate["token_coverage"],
                    "score": candidate["score"],
                })
                kept += 1
                if kept >= ALIGN_MAX_SPANS_PER_SENTENCE:
                    break

        if not items:
            unmatched_blocks.append(block_index)
            continue

        # 3. DP trên dòng từ CỦA CHÍNH BLOCK: chọn dãy span không chồng nhau, tăng dần
        #    theo thời gian, tối đa tổng điểm trừ phạt số từ bị bỏ trắng. Không cần
        #    bitmask "câu đã dùng": hai mảnh cùng một câu trong một block đúng là hai
        #    lần đọc, và quyết định của người dùng là GIỮ CẢ.
        by_start: Dict[int, List[Dict[str, Any]]] = {}
        for item in items:
            by_start.setdefault(item["word_from"], []).append(item)

        total_words = len(words)
        best = [0.0] * (total_words + 1)
        choice: List[Optional[Dict[str, Any]]] = [None] * (total_words + 1)
        for position in range(total_words - 1, -1, -1):
            best[position] = best[position + 1] - ALIGN_SKIP_WORD_PENALTY
            choice[position] = None
            for item in by_start.get(position, []):
                candidate_value = item["value"] + best[item["word_to"] + 1]
                if candidate_value > best[position]:
                    best[position] = candidate_value
                    choice[position] = item

        chosen: List[Dict[str, Any]] = []
        position = 0
        while position < total_words:
            item = choice[position]
            if item is None:
                position += 1
                continue
            chosen.append(item)
            position = item["word_to"] + 1

        if not chosen:
            unmatched_blocks.append(block_index)
            continue

        # 4. Dựng mảnh. MỘT mảnh -> giữ nguyên thời gian block (xem BẤT BIẾN ở đầu mục).
        if len(chosen) == 1:
            item = chosen[0]
            script_index = item["script_index"]
            pieces.append({
                "block_index": block_index,
                "script_index": script_index,
                "start": block["start"],
                "end": block["end"],
                "text": block["text"],
                "script_text": sentences[script_index],
                "similarity": item["similarity"],
                "token_coverage": item["token_coverage"],
                "score": item["score"],
                "source": "align",
            })
            continue

        rows: List[Dict[str, Any]] = []
        for item in chosen:
            span_words = words[item["word_from"]:item["word_to"] + 1]
            rows.append({
                "block_index": block_index,
                "script_index": item["script_index"],
                "start": span_words[0]["start"],
                "end": span_words[-1]["end"],
                "text": " ".join(w["text"] for w in span_words),
                "script_text": sentences[item["script_index"]],
                "similarity": item["similarity"],
                "token_coverage": item["token_coverage"],
                "score": item["score"],
                "source": "align",
            })

        # Snap biên bằng chính hàm đã đưa "điểm cắt rơi giữa một từ" từ 20% về 0%. Truyền
        # DÒNG TỪ CỦA RIÊNG BLOCK để lề chỉ tính theo khoảng lặng bên trong block, và biên
        # không thể trôi sang block khác. Hàm này sort rows theo start và mutate tại chỗ.
        _snap_rows_to_word_boundaries(rows, [{"sub_segments": words}])
        for row in rows:
            row["start"] = max(block["start"], float(row["start"]))
            row["end"] = min(block["end"], float(row["end"]))
        rows = [row for row in rows if row["end"] - row["start"] >= ALIGN_MIN_PIECE_SEC]
        if not rows:
            unmatched_blocks.append(block_index)
            continue
        pieces.extend(rows)

    matched = {int(piece["script_index"]) for piece in pieces}
    missing_sentences = [
        {"script_index": index, "script_text": sentence}
        for index, sentence in enumerate(sentences)
        if index not in matched
    ]

    return {
        "sentence_count": len(sentences),
        "pieces": pieces,
        "unmatched_blocks": unmatched_blocks,
        "missing_sentences": missing_sentences,
    }


def deterministic_filter_pipeline(
    reference_script: str,
    transcript_text: str,
    chunk_gap_sec: float = 0.35,
    session_file: str = "temp_uploads/session_segments.json",
    enable_loudness_background_filter: bool = True,
    enable_unmatched_rescan: bool = True,
    merge_gap_sec: float = 0.8,
    pinned_takes: Optional[Dict[int, int]] = None,
) -> Dict[str, Any]:
    pipeline_start = perf_counter()
    stage_timings: Dict[str, float] = {}

    stage_start = perf_counter()
    script_sentences = split_sentences(reference_script)
    raw_segments = parse_transcript_text(transcript_text)
    # [MỚI] Phục hồi độ phân giải word-timestamps trước khi đưa vào chia chunk
    raw_segments = restore_word_timestamps(raw_segments, session_file)
    processed_chunks = preprocess_transcript_segments(raw_segments, max_gap=chunk_gap_sec)
    stage_timings["prepare_inputs"] = perf_counter() - stage_start

    def _rounded_stage_timings() -> Dict[str, float]:
        return {name: round(seconds, 4) for name, seconds in stage_timings.items()}

    if not script_sentences or not processed_chunks:
        stage_timings["total_pipeline"] = perf_counter() - pipeline_start
        return {
            "filtered_script": "",
            "filtered_rows": [],
            "timeline_script_order": [],
            "timeline_time_order": [],
            "timeline": [],
            "unmatched_sentences": [
                {"script_index": i, "script_text": sentence}
                for i, sentence in enumerate(script_sentences)
            ],
            "review_flags": [],
            "recovered_rows": [],
            "still_unmatched_sentences": [
                {"script_index": i, "script_text": sentence}
                for i, sentence in enumerate(script_sentences)
            ],
            "edl": build_edl([], title="AUTO_CUT"),
            "timeline_xml": build_simple_timeline_xml([]),
            "stats": {
                "script_sentence_count": len(script_sentences),
                "raw_segment_count": len(raw_segments),
                "chunk_count": len(processed_chunks),
                "match_count": 0,
                "match_rate": 0.0,
                "low_loudness_selected_count": 0,
                "nw_match_count": 0,
                "last_best_take_count": 0,
                "n_to_one_shared_chunks": 0,
                "background_flags_count": 0,
                "recovered_count": 0,
                "timings_sec": _rounded_stage_timings(),
            },
        }

    stage_start = perf_counter()
    score_matrix = build_similarity_matrix(script_sentences, processed_chunks)
    nw_matches = align_sequence_needleman_wunsch(
        script_sentences=script_sentences,
        transcript_chunks=processed_chunks,
        match_threshold=0.42,
        weak_match_threshold=0.24,
        gap_sentence_penalty=-0.16,
        gap_chunk_penalty=-0.05,
        mismatch_penalty=-0.24,
        precomputed_scores=score_matrix,
    )
    stage_timings["align_sequence_nw"] = perf_counter() - stage_start

    stage_start = perf_counter()
    take_candidates = build_take_candidates(script_sentences, processed_chunks, score_matrix)
    selected_takes = select_takes_globally(take_candidates, pinned=pinned_takes)
    refined_matches = [
        (script_idx, candidate["chunk_index"], candidate["score"])
        for script_idx, candidate in sorted(selected_takes.items())
    ]
    stage_timings["select_takes"] = perf_counter() - stage_start

    resolved_map: Dict[int, Dict[str, Any]] = {}
    stage_start = perf_counter()
    for script_idx, chunk_idx, _ in refined_matches:
        chunk = processed_chunks[chunk_idx]
        row = _build_match_row(
            script_idx=script_idx,
            chunk_idx=chunk_idx,
            script_sentence=script_sentences[script_idx],
            chunk=chunk,
        )
        if _row_passes_sentence_gate(row):
            resolved_map[script_idx] = row
    stage_timings["build_initial_rows"] = perf_counter() - stage_start

    stage_start = perf_counter()
    resolved_map, n_to_one_shared_chunks = _expand_n_to_one_matches(
        script_sentences=script_sentences,
        chunks=processed_chunks,
        matched_rows=resolved_map,
    )
    stage_timings["expand_n_to_one"] = perf_counter() - stage_start

    stage_start = perf_counter()
    chunk_index_map = {idx: chunk for idx, chunk in enumerate(processed_chunks)}
    filtered_rows = list(resolved_map.values())
    filtered_rows.sort(key=lambda x: x["script_index"])
    filtered_rows = _rematch_shared_chunk_intervals(filtered_rows, chunk_index_map)
    stage_timings["rematch_shared_intervals"] = perf_counter() - stage_start

    recovered_rows: List[Dict[str, Any]] = []
    still_unmatched: List[Dict[str, Any]] = []
    stage_start = perf_counter()
    if enable_unmatched_rescan:
        recovered_rows_full_sentence, still_unmatched = rescan_missing_script_sentences(
            script_sentences=script_sentences,
            chunks=processed_chunks,
            existing_rows=filtered_rows,
            token_coverage_threshold=0.60,
            similarity_threshold=0.35,
        )
        clause_recovered_rows = _recover_missing_clauses_for_low_coverage_rows(
            rows=filtered_rows,
            chunks=processed_chunks,
            coverage_trigger=0.54,
            clause_cov_in_row_max=0.60,
            clause_token_coverage_min=0.60,
            clause_similarity_min=0.35,
        )
        recovered_rows = recovered_rows_full_sentence + clause_recovered_rows
        if recovered_rows:
            filtered_rows.extend(recovered_rows)
            filtered_rows.sort(key=lambda x: x["script_index"])
            filtered_rows = _rematch_shared_chunk_intervals(filtered_rows, chunk_index_map)
    stage_timings["rescan_missing"] = perf_counter() - stage_start

    review_flags: List[Dict[str, Any]] = []
    loudness_profile: Optional[LoudnessProfile] = None
    stage_start = perf_counter()
    if enable_loudness_background_filter and filtered_rows:
        loudness_profile = _compute_loudness_profile(filtered_rows)
        if loudness_profile is not None:
            filtered_rows, review_flags = _retry_background_candidates_by_loudness(
                rows=filtered_rows,
                chunks_by_index=chunk_index_map,
                profile=loudness_profile,
            )
    stage_timings["background_audio_retry"] = perf_counter() - stage_start

    stage_start = perf_counter()
    filtered_rows = _merge_close_or_overlapping_rows(filtered_rows, merge_gap_sec=merge_gap_sec)
    stage_timings["merge_close_rows"] = perf_counter() - stage_start

    stage_start = perf_counter()
    filtered_rows = _snap_rows_to_word_boundaries(filtered_rows, processed_chunks)
    stage_timings["snap_boundaries"] = perf_counter() - stage_start

    for row in filtered_rows:
        if "merged_script_indices" not in row:
            row["merged_script_indices"] = [int(row.get("script_index", -1))]
        row["loudness_dBFS"] = round(float(row["loudness_dBFS"]), 2)
        row["similarity"] = round(float(row["similarity"]), 4)
        row["token_coverage"] = round(float(row["token_coverage"]), 4)
        row["score"] = round(float(row["score"]), 4)
        row["start"] = round(float(row["start"]), 3)
        row["end"] = round(float(row["end"]), 3)

    timeline_script_order = sorted(
        (dict(row) for row in filtered_rows),
        key=lambda x: (x["script_index"], float(x.get("start", 0.0)), float(x.get("end", 0.0))),
    )
    timeline_time_order = sorted((dict(row) for row in filtered_rows), key=lambda x: (x["start"], x["end"]))

    filtered_lines = []
    for item in timeline_script_order:
        filtered_lines.append(
            f"[{item['start']:.2f} - {item['end']:.2f} | {item['loudness_dBFS']:.2f} dBFS | "
            f"sim {item['similarity']:.4f} | score {item['score']:.4f}] "
            f"SCRIPT: {item['script_text']} || RAW: {item['matched_text']}"
        )

    matched_script_indices = {item["script_index"] for item in timeline_script_order}
    expanded_matched_indices = set()
    for item in timeline_script_order:
        merged_indices = item.get("merged_script_indices", [item["script_index"]])
        for idx in merged_indices:
            expanded_matched_indices.add(int(idx))
    matched_script_indices = expanded_matched_indices
    unmatched = [
        {"script_index": i, "script_text": sentence}
        for i, sentence in enumerate(script_sentences)
        if i not in matched_script_indices
    ]
    if enable_unmatched_rescan:
        still_lookup = {int(item["script_index"]): item for item in still_unmatched}
        still_unmatched = [
            still_lookup.get(
                i,
                {"script_index": i, "script_text": sentence},
            )
            for i, sentence in enumerate(script_sentences)
            if i not in matched_script_indices
        ]
        unmatched = list(still_unmatched)
    else:
        still_unmatched = list(unmatched)

    low_loudness_selected_count = len([item for item in timeline_script_order if item["loudness_dBFS"] < -20.0])
    stage_timings["finalize_output"] = perf_counter() - stage_start
    stage_timings["total_pipeline"] = perf_counter() - pipeline_start

    mapped_chunks = _build_mapped_chunks(processed_chunks, timeline_time_order)

    # Mọi lần câu được nói, kèm chỉ dấu lần nào đang được dùng. Hệ thống vốn đã tính
    # sẵn danh sách này để chọn take; trước đây nó chết trong bộ nhớ. Đưa ra ngoài thì
    # những câu mà máy không thể tự quyết (điểm các ứng viên chênh nhau chưa tới 0,04)
    # trở thành một cú bấm của người dựng, thay vì một lỗi âm thầm.
    sentence_takes = []
    for script_idx, sentence in enumerate(script_sentences):
        options = take_candidates.get(script_idx, [])
        chosen = selected_takes.get(script_idx)
        row = next(
            (
                item for item in timeline_script_order
                if script_idx in [int(v) for v in item.get("merged_script_indices", [item["script_index"]])]
            ),
            None,
        )
        sentence_takes.append({
            "script_index": script_idx,
            "script_text": sentence,
            "matched": row is not None,
            "row_start": float(row["start"]) if row else None,
            "row_end": float(row["end"]) if row else None,
            "similarity": float(row["similarity"]) if row else 0.0,
            "token_coverage": float(row["token_coverage"]) if row else 0.0,
            "merged_with": [int(v) for v in row.get("merged_script_indices", [])] if row else [],
            "takes": [
                {
                    "take_index": take_index,
                    "start": round(float(option["start"]), 3),
                    "end": round(float(option["end"]), 3),
                    "text": str(option["matched_text"]),
                    "similarity": round(float(option["similarity"]), 4),
                    "token_coverage": round(float(option["token_coverage"]), 4),
                    "score": round(float(option["score"]), 4),
                    "is_selected": chosen is not None and option["chunk_index"] == chosen["chunk_index"],
                }
                for take_index, option in enumerate(options)
            ],
        })

    return {
        "sentence_takes": sentence_takes,
        "filtered_script": "\n".join(filtered_lines),
        "filtered_rows": filtered_rows,
        "timeline_script_order": timeline_script_order,
        "timeline_time_order": timeline_time_order,
        "timeline": timeline_script_order,  # backward compatibility
        "mapped_chunks": mapped_chunks,
        "unmatched_sentences": unmatched,
        "review_flags": review_flags,
        "recovered_rows": recovered_rows,
        "still_unmatched_sentences": still_unmatched,
        "edl": build_edl(timeline_script_order, title="AUTO_CUT"),
        "timeline_xml": build_simple_timeline_xml(timeline_script_order),
        "stats": {
            "script_sentence_count": len(script_sentences),
            "raw_segment_count": len(raw_segments),
            "chunk_count": len(processed_chunks),
            "match_count": len(matched_script_indices),
            "match_rate": round((len(matched_script_indices) / len(script_sentences)) * 100, 2) if script_sentences else 0.0,
            "low_loudness_selected_count": low_loudness_selected_count,
            "nw_match_count": len(nw_matches),
            "last_best_take_count": len(refined_matches),
            "n_to_one_shared_chunks": n_to_one_shared_chunks,
            "background_flags_count": len(review_flags),
            "recovered_count": len(recovered_rows),
            "loudness_profile": (
                {
                    "p10": round(loudness_profile.p10, 3),
                    "p25": round(loudness_profile.p25, 3),
                    "p50": round(loudness_profile.p50, 3),
                    "background_soft": round(loudness_profile.background_soft, 3),
                    "background_hard": round(loudness_profile.background_hard, 3),
                    "sample_size": loudness_profile.sample_size,
                }
                if loudness_profile is not None
                else None
            ),
            "timings_sec": _rounded_stage_timings(),
        },
    }


def render_video_from_timeline(
    source_video_path: str,
    timeline: List[Dict[str, Any]],
    output_path: str,
    temp_dir: str,
    export_preset: str = "source",
    export_fps: str = "source",
) -> str:
    if not os.path.exists(source_video_path):
        raise Exception("Không tìm thấy video nguồn để cắt dựng.")
    if not timeline:
        raise Exception("Timeline rỗng. Không có đoạn nào để xuất video.")

    os.makedirs(temp_dir, exist_ok=True)
    clips_dir = os.path.join(temp_dir, "clips")
    if os.path.exists(clips_dir):
        for name in os.listdir(clips_dir):
            path = os.path.join(clips_dir, name)
            if os.path.isfile(path):
                os.remove(path)
    else:
        os.makedirs(clips_dir, exist_ok=True)

    preset_normalized = str(export_preset or "source").strip().lower()
    if preset_normalized not in {"source", "web_1080p", "mobile"}:
        preset_normalized = "source"

    fps_normalized = str(export_fps or "source").strip().lower()
    output_fps: Optional[int] = None
    if fps_normalized in {"30", "60"}:
        output_fps = int(fps_normalized)

    target_long_edge: Optional[int] = None
    if preset_normalized == "web_1080p":
        target_long_edge = 1920
    elif preset_normalized == "mobile":
        target_long_edge = 1280

    clip_paths: List[str] = []
    for i, item in enumerate(timeline):
        start = max(0.0, float(item.get("start", 0.0)))
        end = max(start, float(item.get("end", 0.0)))
        if end - start < 0.05:
            continue

        clip_path = os.path.join(clips_dir, f"clip_{i:04d}.mp4")
        clip_paths.append(clip_path)

        video_filters: List[str] = []
        if target_long_edge is not None:
            video_filters.append(
                f"scale=if(gte(iw,ih),{target_long_edge},-2):if(gte(iw,ih),-2,{target_long_edge})"
            )
            video_filters.append("setsar=1")
        if output_fps is not None:
            video_filters.append(f"fps={output_fps}")

        command = [
            "ffmpeg",
            "-y",
            "-ss",
            f"{start:.3f}",
            "-to",
            f"{end:.3f}",
            "-i",
            source_video_path,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
        ]
        if video_filters:
            command.extend(["-vf", ",".join(video_filters)])
        command.append(clip_path)
        try:
            subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError as e:
            raise Exception(f"Lỗi cắt clip thứ {i + 1}: {e}")

    if not clip_paths:
        raise Exception("Không tạo được clip hợp lệ từ timeline.")

    concat_list_path = os.path.join(temp_dir, "concat_clips.txt")
    with open(concat_list_path, "w", encoding="utf-8") as f:
        for clip_path in clip_paths:
            f.write(f"file '{os.path.abspath(clip_path)}'\n")

    concat_cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concat_list_path,
        "-c",
        "copy",
        output_path,
    ]
    try:
        subprocess.run(concat_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError:
        # Fallback nối lại bằng re-encode nếu copy thất bại do mismatch metadata.
        fallback_cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            concat_list_path,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            output_path,
        ]
        try:
            subprocess.run(fallback_cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except subprocess.CalledProcessError as e:
            raise Exception(f"Lỗi khi nối các clip đã cắt: {e}")

    return output_path

import math

def extract_audio_peaks(audio_path: str, num_peaks: int = 3000) -> List[float]:
    """
    Trích xuất mảng biên độ sóng âm (peaks) từ file audio/video bằng pydub.
    Sử dụng hàm căn bậc hai (sqrt) để khuếch đại hình ảnh của các âm thanh nhỏ,
    giúp waveform hiển thị trực quan hơn giống các phần mềm dựng phim.
    """
    try:
        audio = AudioSegment.from_file(audio_path)
        
        # Mix về Mono (1 kênh) để tính toán nhanh hơn
        if audio.channels > 1:
            audio = audio.set_channels(1)
            
        samples = audio.get_array_of_samples()
        num_samples = len(samples)
        if num_samples == 0:
            return []
            
        samples_per_chunk = max(1, num_samples // num_peaks)
        max_possible_val = float(2 ** (8 * audio.sample_width - 1))
        
        peaks = []
        for i in range(num_peaks):
            start = i * samples_per_chunk
            end = start + samples_per_chunk
            chunk = samples[start:end]
            
            if not chunk:
                peaks.append(0.0)
                continue
                
            # Tìm biên độ tuyệt đối lớn nhất trong chunk
            chunk_max = max(abs(x) for x in chunk)
            
            # Chuẩn hóa về thang 0.0 -> 1.0 và khuếch đại (logarithmic/sqrt scale)
            norm_val = chunk_max / max_possible_val
            peaks.append(min(1.0, math.pow(norm_val, 0.5)))
            
        return peaks
    except Exception as e:
        print(f"Lỗi trích xuất waveform bằng pydub: {e}")
        return []
