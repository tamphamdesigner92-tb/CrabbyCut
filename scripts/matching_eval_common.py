#!/usr/bin/env python3
"""Tiện ích dùng chung cho các công cụ đo so khớp kịch bản (Phase 0)."""
import re
import unicodedata

_TRAILING_MARKER_RE = re.compile(r"^\s*(?:\d+[.)]|[-•*])\s*")


def permissive_sentences(script_text: str):
    """Mọi câu người dùng NHÌN THẤY trong kịch bản — mẫu số thật của recall.

    Khác split_sentences() của production ở hai điểm, và cả hai đều là chủ ý:

    1. TÔN TRỌNG XUỐNG DÒNG. Production gộp toàn bộ khoảng trắng thành dấu cách
       *trước* khi tách theo `\\n+`, nên nhánh xuống dòng thành mã chết: hai dòng
       kịch bản mà dòng trên không có dấu chấm sẽ bị dán thành một câu.
    2. GIỮ CÂU NGẮN. Production loại câu dưới 3 từ và không báo cáo, nên chúng
       biến mất không dấu vết.
    """
    text = script_text.replace("\r\n", "\n").replace("\r", "\n")
    out = []
    for line in text.split("\n"):
        line = _TRAILING_MARKER_RE.sub("", line.strip())
        if not line:
            continue
        for part in re.split(r"(?<=[.!?])\s+", re.sub(r"[ \t]+", " ", line)):
            part = part.strip(" \t-•")
            if part:
                out.append(part)
    return out


def fold(text: str) -> str:
    """Chuẩn hoá để so khớp thô: thường hoá, bỏ dấu câu, bỏ dấu thanh."""
    lowered = re.sub(r"[^\w\s]", " ", text.lower())
    decomposed = unicodedata.normalize("NFD", lowered)
    stripped = "".join(c for c in decomposed if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", stripped).strip()


def format_segments_to_text(segments) -> str:
    """Bản sao của formatSegmentsToText trong backend/server.js.

    Bộ so khớp nhận transcript dưới dạng VĂN BẢN chứ không phải object, nên muốn
    đo đúng cái đang chạy thật thì phải dựng lại đúng chuỗi đó.
    """
    lines = []
    for seg in segments:
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", start))
        loud = float(seg.get("loudness_dBFS", 0.0))
        lines.append(f"[{start:.2f} - {end:.2f} | {loud:.2f} dBFS] {str(seg.get('text', '')).strip()}")
    return "\n".join(lines)


def word_stream(segments):
    """Một dòng từ duy nhất cho cả video, phẳng và có mốc thời gian."""
    stream = []
    for seg in segments:
        words = seg.get("words") or []
        if words:
            for word in words:
                text = str(word.get("word", "")).strip()
                if text:
                    stream.append((text, float(word["start"]), float(word["end"])))
            continue
        text = str(seg.get("text", "")).strip()
        tokens = text.split()
        if not tokens:
            continue
        start, end = float(seg["start"]), float(seg["end"])
        step = (end - start) / len(tokens)
        for i, token in enumerate(tokens):
            stream.append((token, start + i * step, start + (i + 1) * step))
    return stream


def overlap(a0, a1, b0, b1) -> float:
    return max(0.0, min(a1, b1) - max(a0, b0))
