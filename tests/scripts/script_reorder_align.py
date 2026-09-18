#!/usr/bin/env python3
"""Test đầu-cuối cho align_blocks_to_script — bộ gán nhãn câu của tính năng
"Sắp xếp timeline theo kịch bản chuẩn" (giai đoạn Timeline).

CÁCH ĐO: chạy chính pipeline so khớp trên 6 case trong tests/fixtures/matching để lấy
timeline thật, rồi dựng lại đúng thứ bàn giao mà renderer có trong tay ở step3 —
block SẮP THEO THỜI GIAN và KHÔNG mang nhãn câu. Nếu align_blocks_to_script gán lại
đúng câu cho từng block thì thứ tự kịch bản được phục hồi.

Nhãn đối chiếu là script_index của chính pipeline. Ở đây ta KHÔNG đo "chọn đúng take"
(việc đó đã có npm run eval:matching); ta đo "nói đúng block này là câu nào" — hai bài
khác nhau, và bài này mới là bài mà tính năng sắp xếp phụ thuộc.

Fixture đã commit sẵn (asr_cache/ bị gitignore), nên test không cần bóc băng lại.
"""
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

from core_logic import (  # noqa: E402
    align_blocks_to_script,
    deterministic_filter_pipeline,
    split_sentences,
)
from matching_eval_common import format_segments_to_text, word_stream  # noqa: E402

FIXTURES = PROJECT_ROOT / "tests" / "fixtures" / "matching"
SESSION = PROJECT_ROOT / "temp_uploads" / "__script_reorder_session.json"
failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        failures.append(label)


def words_between(stream, start, end):
    """Dòng từ nằm trong một khoảng, lấy theo ĐIỂM GIỮA của từ.

    Cùng luật với buildSplitTimelineItems ở renderer, nếu không thì backend nói mảnh
    gồm từ 3..7 mà renderer cắt ra lại thành từ 3..8.
    """
    return [
        {"text": text, "start": word_start, "end": word_end}
        for text, word_start, word_end in stream
        if start - 0.01 <= (word_start + word_end) / 2.0 <= end + 0.01
    ]


def build_case(case_dir):
    script_text = (case_dir / "script.txt").read_bytes().decode("utf-8")
    segments = json.loads((case_dir / "segments.json").read_text(encoding="utf-8"))
    SESSION.parent.mkdir(parents=True, exist_ok=True)
    SESSION.write_text(json.dumps(segments, ensure_ascii=False), encoding="utf-8")
    result = deterministic_filter_pipeline(
        reference_script=script_text,
        transcript_text=format_segments_to_text(segments),
        session_file=str(SESSION),
    )
    stream = word_stream(segments)
    # Đúng thứ bàn giao của step3: SẮP THEO THỜI GIAN (finalizeTimeline không sort —
    # xem native/addon/src/core_c.cpp:241), và ta cố tình bỏ nhãn đi.
    rows = sorted(result["timeline_script_order"], key=lambda row: float(row["start"]))
    blocks = []
    truth = {}
    for index, row in enumerate(rows):
        start, end = float(row["start"]), float(row["end"])
        blocks.append({
            "index": index,
            "start": start,
            "end": end,
            "text": row.get("matched_text") or "",
            "sub_segments": words_between(stream, start, end),
        })
        truth[index] = int(row["script_index"])
    return script_text, blocks, truth


total_blocks = total_correct = 0
print("Gán nhãn câu cho block timeline (không nhãn sẵn, không chọn take)")
# FIXTURES CÓ THỂ KHÔNG TỒN TẠI và đó là trạng thái BÌNH THƯỜNG của bản clone công khai:
# bộ ca thật chứa kịch bản và transcript của khách hàng nên không được commit
# (xem tests/fixtures/README.md). `iterdir()` trên thư mục thiếu thì NÉM, nên phải chắn ở
# đây — không chắn thì người mới clone về chạy test là thấy traceback và tưởng repo hỏng.
if not FIXTURES.is_dir():
    print("  (bỏ qua: không có tests/fixtures/matching — xem tests/fixtures/README.md)")
for case_dir in sorted(path for path in (FIXTURES.iterdir() if FIXTURES.is_dir() else []) if path.is_dir()):
    if not (case_dir / "script.txt").exists():
        continue
    script_text, blocks, truth = build_case(case_dir)
    out = align_blocks_to_script(script_text, blocks)

    got = {}
    for piece in out["pieces"]:
        got.setdefault(int(piece["block_index"]), []).append(int(piece["script_index"]))
    correct = sum(1 for index, want in truth.items() if want in got.get(index, []))
    total_blocks += len(truth)
    total_correct += correct

    check(
        f"{case_dir.name}: {correct}/{len(truth)} block gán đúng câu",
        correct == len(truth),
        f"thiếu {[i for i, w in truth.items() if w not in got.get(i, [])]}",
    )
    # Không được bỏ rơi block nào: mọi block phải ra ít nhất một mảnh, kể cả block lạc
    # (nó vào unmatched_blocks để renderer dồn về cuối chứ không bị xoá).
    accounted = set(got) | set(int(i) for i in out["unmatched_blocks"])
    check(f"{case_dir.name}: không bỏ rơi block nào",
          accounted == set(truth), f"thiếu {set(truth) - accounted}")
    # Mảnh phải nằm TRONG block của nó — biên không được trôi sang block khác.
    stray = [
        piece for piece in out["pieces"]
        if piece["start"] < blocks[int(piece["block_index"])]["start"] - 1e-6
        or piece["end"] > blocks[int(piece["block_index"])]["end"] + 1e-6
    ]
    check(f"{case_dir.name}: mảnh không trôi ra ngoài block", not stray, stray[:1])

print(f"\nTổng: {total_correct}/{total_blocks} block gán đúng câu")
check("gán nhãn đúng 100% trên bộ dữ liệu vàng", total_correct == total_blocks,
      f"{total_correct}/{total_blocks}")

print("\nBlock ra ĐÚNG MỘT mảnh phải giữ NGUYÊN thời gian")
# Tính năng này là "sắp xếp lại", không phải "trim lại": lặng lẽ dịch biên của mọi block
# chỉ vì người dùng bấm nút sắp xếp là phá hoại. Chỉ block phải CẮT mới đi qua bộ snap.
script = "Xin chào cả nhà mình.\nHôm nay mình chia sẻ về canxi cho bé."
words_a = [{"text": t, "start": 1.0 + i * 0.3, "end": 1.25 + i * 0.3}
           for i, t in enumerate("Xin chào cả nhà mình".split())]
words_b = [{"text": t, "start": 9.0 + i * 0.3, "end": 9.25 + i * 0.3}
           for i, t in enumerate("Hôm nay mình chia sẻ về canxi cho bé".split())]
single = align_blocks_to_script(script, [
    {"index": 0, "start": 0.4, "end": 3.9, "text": "Xin chào cả nhà mình", "sub_segments": words_a},
    {"index": 1, "start": 8.5, "end": 12.4, "text": "Hôm nay mình chia sẻ về canxi cho bé", "sub_segments": words_b},
])
by_block = {int(p["block_index"]): p for p in single["pieces"]}
check("block một mảnh giữ đúng start/end gốc",
      abs(by_block[0]["start"] - 0.4) < 1e-9 and abs(by_block[0]["end"] - 3.9) < 1e-9,
      by_block.get(0))
check("gán đúng câu cho cả hai block",
      by_block[0]["script_index"] == 0 and by_block[1]["script_index"] == 1,
      {k: v["script_index"] for k, v in by_block.items()})

print("\nBlock phủ HAI câu phải bị cắt, không cắt giữa từ")
merged_words = words_a + [{"text": t, "start": 4.0 + i * 0.3, "end": 4.25 + i * 0.3}
                          for i, t in enumerate("Hôm nay mình chia sẻ về canxi cho bé".split())]
cut = align_blocks_to_script(script, [{
    "index": 0, "start": 1.0, "end": 6.7,
    "text": "Xin chào cả nhà mình Hôm nay mình chia sẻ về canxi cho bé",
    "sub_segments": merged_words,
}])
pieces = sorted(cut["pieces"], key=lambda p: p["start"])
check("block hai câu ra đúng 2 mảnh", len(pieces) == 2, [p["script_index"] for p in pieces])
if len(pieces) == 2:
    check("hai mảnh mang hai câu khác nhau, đúng thứ tự kịch bản",
          [p["script_index"] for p in pieces] == [0, 1],
          [p["script_index"] for p in pieces])
    boundary = pieces[0]["end"]
    inside_word = [w for w in merged_words if w["start"] + 1e-6 < boundary < w["end"] - 1e-6]
    check("điểm cắt không rơi vào giữa một từ", not inside_word, inside_word)

print("\nCa biên")
check("kịch bản rỗng -> không mảnh nào, không nổ",
      align_blocks_to_script("", [{"index": 0, "start": 0, "end": 1, "text": "a",
                                   "sub_segments": [{"text": "a", "start": 0, "end": 1}]}])["pieces"] == [])
check("danh sách block rỗng -> trả về đủ câu thiếu",
      len(align_blocks_to_script(script, [])["missing_sentences"]) == len(split_sentences(script)))
lost = align_blocks_to_script(script, [{
    "index": 0, "start": 0, "end": 2.0, "text": "ờ thôi quay lại nhé",
    "sub_segments": [{"text": t, "start": 0.2 * i, "end": 0.2 * i + 0.15}
                     for i, t in enumerate("ờ thôi quay lại nhé".split())],
}])
check("block không khớp câu nào -> vào unmatched_blocks, KHÔNG bị xoá",
      lost["unmatched_blocks"] == [0] and lost["pieces"] == [], lost)

print("\nCa THẬT từ dự án người dùng (tests/fixtures/reorder/)")
# Đây là ca làm lộ ra bản đầu của tính năng sai hoàn toàn. Nó khoá lại ba thứ mà bộ dữ
# liệu vàng không có: block chứa hai câu KHÔNG LIỀN NHAU (người nói nhảy câu), ba câu gói
# trong 5,7 giây, và tên riêng bị ASR nghe lệch hẳn (Wellmune -> "Wellmul", Little Étoile
# -> "Lít thôi thôi"). Lời nói lệch kịch bản là chuyện thường, bộ so khớp phải chịu được.
REORDER_FIXTURES = PROJECT_ROOT / "tests" / "fixtures" / "reorder"
for fixture_path in sorted(REORDER_FIXTURES.glob("*.json")):
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    result = align_blocks_to_script(fixture["reference_script"], fixture["blocks"])
    got = {}
    for piece in result["pieces"]:
        got.setdefault(int(piece["block_index"]), []).append(int(piece["script_index"]))
    name = fixture.get("name", fixture_path.stem)
    correct = 0
    for index, want in enumerate(fixture["expected_script_indices"]):
        have = sorted(got.get(index, []))
        if all(w in have for w in want):
            correct += 1
        else:
            print(f"       block{index + 1}: muốn {want}, được {have}")
    total = len(fixture["expected_script_indices"])
    check(f"{name}: {correct}/{total} block gán đúng mọi câu nó chứa", correct == total)
    check(f"{name}: không câu nào thiếu nhãn",
          not result["missing_sentences"],
          [m["script_index"] for m in result["missing_sentences"]])
    check(f"{name}: không block nào bị coi là lạc", not result["unmatched_blocks"], result["unmatched_blocks"])
    # Thứ tự cuối cùng phải là 0,1,2,... — đúng trình tự kịch bản.
    order = [int(p["script_index"]) for p in sorted(result["pieces"], key=lambda p: (p["script_index"], p["start"]))]
    check(f"{name}: sắp ra đúng trình tự kịch bản", order == sorted(order) and len(set(order)) == len(order),
          order)

if failures:
    print(f"\nscript reorder align FAILED: {len(failures)} kiểm tra hỏng")
    raise SystemExit(1)
print("\nscript reorder align ok")
