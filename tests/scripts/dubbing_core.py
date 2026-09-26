#!/usr/bin/env python3
"""Test lõi THUẦN của "Lồng tiếng" (tts/dubbing_core.py): lọc câu phụ đề, xếp giọng đọc lên trục
thời gian (auto_fit / dynamic_shift / fixed_duration) và trộn.

Không nạp model nào — chỉ cần numpy, nên chạy được bằng .venv thường:
    npm run test:dubbing-core
Audio giả là sóng sin có độ dài biết trước, nên mọi con số (tốc độ, độ dời, độ tràn) kiểm được
chính xác tới vài mili-giây.
"""
import sys
from pathlib import Path

import numpy as np

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT / "tts"))

import dubbing_core as core  # noqa: E402

SR = 24000
failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        failures.append(label)


def tone(seconds, lead=0.0, tail=0.0):
    t = np.arange(int(seconds * SR)) / SR
    voice = 0.5 * np.sin(2 * np.pi * 220 * t).astype(np.float32)
    return np.concatenate([np.zeros(int(lead * SR), np.float32), voice, np.zeros(int(tail * SR), np.float32)])


def near(a, b, tol=0.02):
    return abs(float(a) - float(b)) <= tol


print("normalize_cues")
cues, skipped = core.normalize_cues([
    {"start": 5, "end": 6, "text": "Câu thứ hai"},
    {"start": 1, "end": 2, "text": "<i>Câu</i> {\\an8}thứ\nnhất"},
    {"start": 3, "end": 4, "text": "[ÂM NHẠC]"},
    {"start": 3, "end": 4, "text": "♪ la la ♪"},
    {"start": 7, "end": 8, "text": "12345 !!!"},
    {"start": 9, "end": 9, "text": "mốc hỏng"},
    {"start": "x", "end": 9, "text": "mốc hỏng"},
    {"start": 10, "end": 11, "text": "   "},
    {"start": 12, "end": 13, "text": ">> Người kia nói"},
])
check("giữ 3 câu đọc được", len(cues) == 3, [c.text for c in cues])
check("sắp theo mốc bắt đầu", [c.start for c in cues] == [1, 5, 12])
check("bỏ thẻ HTML/ASS, gộp xuống dòng", cues[0].text == "Câu thứ nhất", cues[0].text)
check("bỏ dấu thoại >>", cues[2].text == "Người kia nói", cues[2].text)
check("seq đánh lại từ 1, index giữ vị trí gốc", [c.seq for c in cues] == [1, 2, 3] and cues[0].index == 1)
check("đếm bỏ qua", skipped == {"empty": 1, "music": 2, "no_letters": 1, "bad_time": 2}, skipped)

print("split_for_tts")
long_text = ", ".join(["một đoạn khá dài"] * 30) + ". Câu sau."
chunks = core.split_for_tts(long_text, 60)
check("mọi khối <= trần", all(len(c) <= 60 for c in chunks), [len(c) for c in chunks])
check("không mất chữ", " ".join(chunks).split() == long_text.split())

print("trim_silence_edges")
trimmed = core.trim_silence_edges(tone(1.0, lead=0.5, tail=0.4), SR)
check("cắt câm hai đầu, chừa đệm ~30ms", near(len(trimmed) / SR, 1.06, 0.03), len(trimmed) / SR)

print("auto_fit")
planner = core.TimelinePlanner(mode="auto_fit", max_speed=1.45, gap=0.2)
c1 = core.Cue(seq=1, index=0, start=0.0, end=1.0, text="a")
c2 = core.Cue(seq=2, index=1, start=1.2, end=3.0, text="b")
c3 = core.Cue(seq=3, index=2, start=5.0, end=6.0, text="c")
a1, p1 = planner.place(c1, tone(2.0), SR)
check("câu quá dài tăng tốc tới trần 1.45x", near(p1.speed, 1.45, 1e-6) and near(p1.required_speed, 2.0, 1e-6))
check("độ dài sau tăng tốc = 2/1.45", near(p1.duration, 2.0 / 1.45), p1.duration)
check("tràn được ghi lại", near(p1.overflow, 2.0 / 1.45 - 1.0), p1.overflow)
a2, p2 = planner.place(c2, tone(0.8), SR)
check("câu sau bị đẩy tới cuối câu tràn + gap", near(p2.start, 2.0 / 1.45 + 0.2), p2.start)
check("độ dời = mốc thật - mốc phụ đề", near(p2.shift, p2.start - 1.2))
check("câu vừa khung không đổi tốc độ", p2.speed == 1.0)
a3, p3 = planner.place(c3, tone(0.5), SR)
check("hết nợ -> câu kế về đúng mốc", near(p3.start, 5.0) and p3.shift == 0)

print("dynamic_shift")
planner = core.TimelinePlanner(mode="dynamic_shift")
_, d1 = planner.place(c1, tone(2.0), SR)
_, d2 = planner.place(c2, tone(0.5), SR)
check("không đổi tốc độ", d1.speed == 1.0 and near(d1.duration, 2.0))
check("câu sau dời tới ngay sau câu trước", near(d2.start, 2.0), d2.start)

print("fixed_duration")
planner = core.TimelinePlanner(mode="fixed_duration")
f_audio, f1 = planner.place(c1, tone(2.0), SR)
check("cắt đúng độ dài khung", near(f1.duration, 1.0, 1e-3) and f1.trimmed)
check("fade đuôi về 0", abs(float(f_audio[-1])) < 1e-3)

print("mode lạ / tốc độ trần ngoài dải")
check("mode lạ -> auto_fit", core.TimelinePlanner(mode="xyz").mode == "auto_fit")
check("max_speed kẹp 1..3", core.TimelinePlanner(max_speed=9).max_speed == 3.0 and core.TimelinePlanner(max_speed=0.2).max_speed == 1.0)

print("mix_placements")
planner = core.TimelinePlanner(mode="auto_fit")
late1 = core.Cue(seq=1, index=0, start=10.0, end=11.0, text="a")
late2 = core.Cue(seq=2, index=1, start=12.0, end=13.0, text="b")
clips = [planner.place(late1, tone(0.5), SR)[::-1], planner.place(late2, tone(0.5), SR)[::-1]]
mixed, origin = core.mix_placements(clips, SR)
check("file trộn bắt đầu ở câu đầu (không mang 10s câm)", near(origin, 10.0), origin)
check("độ dài = cuối câu cuối - câu đầu", near(len(mixed) / SR, 2.5), len(mixed) / SR)
check("câu 2 nằm đúng offset 2s", float(np.abs(mixed[int(2.1 * SR)])) > 0 or float(np.abs(mixed[int(2.05 * SR):int(2.2 * SR)]).max()) > 0.1)
loud = [(core.Placement(seq=1, index=0, start=0, duration=1, cue_start=0, cue_end=1, original_duration=1), np.ones(SR, np.float32)),
        (core.Placement(seq=2, index=1, start=0, duration=1, cue_start=0, cue_end=1, original_duration=1), np.ones(SR, np.float32))]
mixed_loud, _ = core.mix_placements(loud, SR)
check("chồng nhau thì chuẩn hoá đỉnh <= 1", float(np.max(np.abs(mixed_loud))) <= 1.0 + 1e-6)

print("summarize")
summary = core.summarize([p1, p2, p3])
check("đếm tăng tốc/dời/tràn", summary["sped_up"] == 1 and summary["shifted"] == 1 and summary["overflowed"] == 1, summary)

print("atempo_chain")
check("3x -> hai tầng", core.atempo_chain(3.0) == ["atempo=2.0", "atempo=1.500000"])
check("0.3x -> tầng 0.5", core.atempo_chain(0.3)[0] == "atempo=0.5")

print("looks_degenerate")
check("giọng liền mạch không bị nghi", core.looks_degenerate(tone(2.0), SR) == "")
check("dải câm 2s bị nghi", "im lặng" in core.looks_degenerate(np.concatenate([tone(0.5), np.zeros(2 * SR, np.float32), tone(0.5)]), SR))

if failures:
    print(f"\n{len(failures)} lỗi")
    sys.exit(1)
print("\nTất cả đều qua.")
