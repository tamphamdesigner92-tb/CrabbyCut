#!/usr/bin/env python3
"""Test hồi quy cho bộ so khớp kịch bản (các lỗi đã sửa ở Phase 1).

Dữ liệu tổng hợp, không cần fixture, chạy dưới một giây. Mỗi khối dưới đây khoá
lại một lỗi đã từng làm mất câu hoặc chọn nhầm take trong sản phẩm thật.
"""
import json
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT_ROOT))

from core_logic import (  # noqa: E402
    _number_consistency_factor,
    _similarity,
    _token_coverage,
    deterministic_filter_pipeline,
    split_sentences,
)

NO_SESSION = str(PROJECT_ROOT / "temp_uploads" / "__matching_test_no_session.json")
failures = []


def check(label, condition, detail=""):
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label} {detail}")
        failures.append(label)


def run(script, lines):
    return deterministic_filter_pipeline(script, "\n".join(lines), session_file=NO_SESSION)


print("Xuống dòng là ranh giới câu (không dán hai dòng thành một)")
sentences = split_sentences("Câu một không có dấu chấm\nCâu hai kết thúc đây.")
check("tách thành 2 câu", len(sentences) == 2, sentences)

print("Câu ngắn không bị nuốt im lặng")
sentences = split_sentences("Đúng vậy.\nBa mẹ hãy nhớ điều này nhé.\nTuyệt vời.")
check("giữ đủ 3 câu", len(sentences) == 3, sentences)

print("Đầu mục danh sách không thành câu rác")
sentences = split_sentences("1. Dinh dưỡng cân đối\n2) Ngủ sớm mỗi ngày")
check("bỏ '1.' và '2)'", sentences == ["Dinh dưỡng cân đối", "Ngủ sớm mỗi ngày"], sentences)
check(
    "không xén số mở đầu câu",
    split_sentences("4 việc này giúp con cao lớn.") == ["4 việc này giúp con cao lớn."],
)

print("Lệch số chỉ bị phạt điểm, không bị xoá sổ")
script_number = "Ba mẹ nhớ bổ sung 2 loại canxi cho con"
check(
    "ASR nghe 'bà mẹ' vẫn khớp",
    _similarity(script_number, "bà mẹ nhớ bổ sung 2 loại canxi cho con") > 0.85,
)
check(
    "sai số thật thì tụt điểm nhưng còn sống",
    0.0 < _similarity(script_number, "ba mẹ nhớ bổ sung 5 loại canxi cho con") < 0.80,
)
check("'10 giờ' khớp 'mười giờ'", _number_consistency_factor("ngủ trước 10 giờ tối", "ngủ trước mười giờ tối") == 1.0)

print("Take sau thắng dù ASR nghe sai một từ")
full = "Sữa non tổ yến giúp bé tăng đề kháng và ăn ngon miệng hơn mỗi ngày"
result = run(
    full + ".",
    [
        f"[5.00 - 10.00 | -17.00 dBFS] {full}",
        "[25.00 - 30.00 | -16.00 dBFS] " + full.replace("mỗi ngày", "mỗi ngài"),
    ],
)
check("chọn take 2", result["timeline_script_order"][0]["start"] > 15, result["timeline_script_order"][0])

print("Take sau đứt giữa chừng thì giữ take đầu")
result = run(
    full + ".",
    [
        f"[5.00 - 10.00 | -17.00 dBFS] {full}",
        "[25.00 - 30.00 | -16.00 dBFS] Sữa non tổ yến giúp bé tăng",
    ],
)
check("giữ take 1", result["timeline_script_order"][0]["start"] < 15, result["timeline_script_order"][0])

print("Hàng nhỏ trong chunk dài vẫn tới được UI, mang đúng biên của hàng")
result = run(
    "Việc đầu tiên là cho con ngủ sớm trước mười giờ tối.\nViệc thứ hai là bổ sung canxi và vitamin D3 đầy đủ.",
    [
        "[10.00 - 34.00 | -17.00 dBFS] à ừm để em nói nhé Việc đầu tiên là cho con ngủ sớm trước mười giờ tối "
        "rồi tiếp theo nè Việc thứ hai là bổ sung canxi và vitamin D3 đầy đủ đó cả nhà nhớ nha ừm vậy đó"
    ],
)
selected = [chunk for chunk in result["mapped_chunks"] if chunk["is_selected"]]
rows = result["timeline_time_order"]
check("cả hai câu đều khớp", len(rows) == 2, rows)
check("có mục được tick", len(selected) >= 1, result["mapped_chunks"])
check(
    "biên bàn giao đúng bằng biên hàng",
    abs(sum(c["end"] - c["start"] for c in selected) - sum(r["end"] - r["start"] for r in rows)) < 0.05,
)
check(
    "không ôm nguyên chunk 24 giây",
    all((chunk["end"] - chunk["start"]) < 20.0 for chunk in selected),
)

print("Ngữ âm: cặp Whisper hay nghe lẫn vẫn phải khớp")
# Tất cả đều là cặp CÓ THẬT trong bộ dữ liệu vàng.
for label, script_line, heard in [
    ("ngày/ngài", "giúp bé ăn ngon miệng hơn mỗi ngày", "giúp bé ăn ngon miệng hơn mỗi ngài"),
    ("trứng/chứng", "thịt cá trứng đều là protein chất lượng cao", "thịt cá chứng đều là protein chất lượng cao"),
    ("tỷ/tỉ", "dựa trên tỷ lệ DHA và EPA phổ biến", "dựa trên tỉ lệ DHA và EPA phổ biến"),
    ("lỏng lẻo/lòng lẽo", "cơ bắp lỏng lẻo vận động kém", "cơ bắp lòng lẽo vận động kém"),
]:
    check(f"{label} — coverage đầy đủ", _token_coverage(script_line, heard) >= 0.99,
          round(_token_coverage(script_line, heard), 3))

print("Từ ghép bị ASR tách hoặc dính tuỳ hứng vẫn phải khớp")
for label, script_line, heard in [
    ("canxi/can xi", "ba mẹ nhớ bổ sung canxi cho con", "ba mẹ nhớ bổ sung can xi cho con"),
    ("Nanu/Na Nu", "hôm nay Nanu chia sẻ bốn việc", "hôm nay Na Nu chia sẻ bốn việc"),
]:
    check(f"{label} — coverage đầy đủ", _token_coverage(script_line, heard) >= 0.99,
          round(_token_coverage(script_line, heard), 3))

print("Ngữ âm chỉ được NÂNG điểm, không được lấn át khớp nguyên văn")
exact = _similarity("bổ sung canxi và vitamin D3", "bổ sung canxi và vitamin D3")
folded = _similarity("bổ sung canxi và vitamin D3", "bổ sung can xi và vitamin D3")
check("khớp nguyên văn vẫn ăn điểm cao hơn", exact > folded, (round(exact, 3), round(folded, 3)))
check("hai câu khác hẳn nhau không bị ngữ âm kéo lại gần",
      _similarity("bổ sung canxi cho con mỗi ngày", "hôm nay trời mưa rất to ngoài kia") < 0.45)

print("Từ chức năng đếm nhẹ hơn từ nội dung")
# Cùng thiếu ĐÚNG MỘT từ, nhưng thiếu "canxi" phải đau hơn thiếu "thì".
missing_content = _token_coverage("mẹ thì nhớ bổ sung canxi cho con", "mẹ thì nhớ bổ sung cho con")
missing_filler = _token_coverage("mẹ thì nhớ bổ sung canxi cho con", "mẹ nhớ bổ sung canxi cho con")
check("thiếu từ nội dung tụt điểm mạnh hơn thiếu từ chức năng",
      missing_content < missing_filler - 0.1, (round(missing_content, 3), round(missing_filler, 3)))

print("Đọc lại CẢ kịch bản: phải lấy trọn lượt sau, không chắp vá")
# Bản thu nhỏ của bap_kids. Lượt 2 cách lượt 1 hơn 100 giây — nằm ngoài hẳn cửa sổ
# ±2 chunk / 18 giây mà bộ chọn take cũ dò tới, nên trước đây nó vô hình.
run_script = (
    "Sữa non tổ yến giúp bé tăng đề kháng mỗi ngày.\n"
    "Ba mẹ nhớ bổ sung canxi và vitamin D3 đầy đủ.\n"
    "Cảm ơn cả nhà đã xem hết video này."
)
result = run(run_script, [
    "[5.00 - 10.00 | -17.00 dBFS] Sữa non tổ yến giúp bé tăng đề kháng mỗi ngày",
    "[11.00 - 16.00 | -17.00 dBFS] Ba mẹ nhớ bổ sung canxi và vitamin D3 đầy đủ",
    "[17.00 - 21.00 | -17.00 dBFS] Cảm ơn cả nhà đã xem hết video này",
    "[40.00 - 42.00 | -26.00 dBFS] thôi chị nói lại từ đầu nha",
    # Lượt 2: ASR nghe kém hơn một chút ở mỗi câu, nhưng đây mới là bản tốt.
    "[130.00 - 135.00 | -16.50 dBFS] Sữa non tổ yến giúp bé tăng đề kháng mỗi ngài",
    "[136.00 - 141.00 | -16.50 dBFS] Ba mẹ nhớ bổ sung can xi và vitamin D3 đầy đủ",
    "[142.00 - 146.00 | -16.50 dBFS] Cảm ơn cả nhà đã xem hết video nay",
])
rows = sorted(result["timeline_script_order"], key=lambda r: r["script_index"])
check("khớp đủ 3 câu", len(rows) == 3, [(r["script_index"], round(r["start"], 1)) for r in rows])
check("cả 3 câu đều lấy từ lượt đọc thứ hai",
      all(r["start"] > 100 for r in rows), [round(r["start"], 1) for r in rows])
check("thứ tự thời gian không đảo", all(a["start"] <= b["start"] for a, b in zip(rows, rows[1:])))

print("Hai câu không được dùng chung một đoạn audio")
overlaps = 0
for a, b in zip(rows, rows[1:]):
    overlaps += max(0.0, min(a["end"], b["end"]) - max(a["start"], b["start"])) > 0.25
check("không có cặp hàng nào chồng audio", overlaps == 0, overlaps)

print("Lượt sau đọc dở dang thì vẫn phải giữ lượt đầu")
result = run(run_script, [
    "[5.00 - 10.00 | -17.00 dBFS] Sữa non tổ yến giúp bé tăng đề kháng mỗi ngày",
    "[11.00 - 16.00 | -17.00 dBFS] Ba mẹ nhớ bổ sung canxi và vitamin D3 đầy đủ",
    "[17.00 - 21.00 | -17.00 dBFS] Cảm ơn cả nhà đã xem hết video này",
    "[130.00 - 131.20 | -16.50 dBFS] Sữa non tổ yến giúp",
])
first = next(r for r in result["timeline_script_order"] if r["script_index"] == 0)
check("câu 1 giữ lượt đầu vì lượt sau bị cụt", first["start"] < 100, round(first["start"], 1))

print("Điểm cắt không được rơi vào giữa một từ")
# Session có word-timestamp thật, với khoảng lặng RỘNG trước câu 2 và khoảng lặng
# HẸP sau nó, để kiểm tra lề co giãn theo khoảng lặng chứ không đệm một hằng số.
def _words(spec, gap_after=0.06):
    out, t = [], spec[0]
    for word in spec[1]:
        out.append({"word": word, "start": round(t, 3), "end": round(t + 0.30, 3)})
        t += 0.30 + gap_after
    return out

snap_segments = [
    {"start": 1.0, "end": 3.1, "text": "Mở đầu một câu vu vơ", "loudness_dBFS": -17.0,
     "words": _words((1.0, ["Mở", "đầu", "một", "câu", "vu", "vơ"]))},
    # cách 2 giây — khoảng lặng rộng
    {"start": 5.5, "end": 8.4, "text": "Ba mẹ nhớ bổ sung canxi cho con", "loudness_dBFS": -17.0,
     "words": _words((5.5, ["Ba", "mẹ", "nhớ", "bổ", "sung", "canxi", "cho", "con"]), gap_after=0.06)},
    # cách 0,1 giây — khoảng lặng hẹp
    {"start": 8.5, "end": 10.6, "text": "rồi nói tiếp chuyện khác ngay", "loudness_dBFS": -17.0,
     "words": _words((8.5, ["rồi", "nói", "tiếp", "chuyện", "khác", "ngay"]))},
]
snap_session = str(PROJECT_ROOT / "temp_uploads" / "__matching_test_snap.json")
Path(snap_session).parent.mkdir(parents=True, exist_ok=True)
Path(snap_session).write_text(json.dumps(snap_segments, ensure_ascii=False), encoding="utf-8")
snap_lines = [
    f"[{s['start']:.2f} - {s['end']:.2f} | {s['loudness_dBFS']:.2f} dBFS] {s['text']}"
    for s in snap_segments
]
result = deterministic_filter_pipeline(
    "Ba mẹ nhớ bổ sung canxi cho con.", "\n".join(snap_lines), session_file=snap_session
)
row = result["timeline_script_order"][0]
all_words = [(w["start"], w["end"]) for seg in snap_segments for w in seg["words"]]
for label, cut in (("đầu", row["start"]), ("cuối", row["end"])):
    inside = [w for w in all_words if w[0] < cut < w[1]]
    check(f"điểm cắt {label} không nằm giữa từ", not inside, (round(cut, 3), inside))

check("biên đầu bám đúng từ đầu tiên của câu", abs(row["start"] - (5.5 - 0.12)) < 0.02, round(row["start"], 3))
# Sau "con" chỉ còn 0,1s im lặng -> lề phải co lại tối đa nửa khoảng đó, không lấy đủ 0,18s.
check("lề cuối co theo khoảng lặng hẹp", row["end"] - 8.4 <= 0.06 + 1e-6, round(row["end"] - 8.4, 3))
Path(snap_session).unlink(missing_ok=True)

print("Câu không hề được nói thì phải báo, không gán bừa")
result = run(
    "Chào cả nhà hôm nay mình chia sẻ về dinh dưỡng.\nCâu này hoàn toàn không xuất hiện trong video đâu nhé.",
    ["[1.00 - 5.00 | -17.00 dBFS] Chào cả nhà hôm nay mình chia sẻ về dinh dưỡng"],
)
check("báo đúng 1 câu không khớp", len(result["unmatched_sentences"]) == 1, result["unmatched_sentences"])

print("Danh sách take cho từng câu, và ghim take theo ý người dùng")
result = run(run_script, [
    "[5.00 - 10.00 | -17.00 dBFS] Sữa non tổ yến giúp bé tăng đề kháng mỗi ngày",
    "[11.00 - 16.00 | -17.00 dBFS] Ba mẹ nhớ bổ sung canxi và vitamin D3 đầy đủ",
    "[17.00 - 21.00 | -17.00 dBFS] Cảm ơn cả nhà đã xem hết video này",
    "[130.00 - 135.00 | -16.50 dBFS] Sữa non tổ yến giúp bé tăng đề kháng mỗi ngài",
    "[136.00 - 141.00 | -16.50 dBFS] Ba mẹ nhớ bổ sung can xi và vitamin D3 đầy đủ",
    "[142.00 - 146.00 | -16.50 dBFS] Cảm ơn cả nhà đã xem hết video nay",
])
takes = result["sentence_takes"]
check("có một mục cho mỗi câu kịch bản", len(takes) == 3, len(takes))
check("câu đọc hai lần thì liệt kê hai take", len(takes[0]["takes"]) == 2, takes[0]["takes"])
check("đúng một take được đánh dấu đang dùng",
      sum(1 for t in takes[0]["takes"] if t["is_selected"]) == 1)
check("mặc định đang dùng lượt đọc sau",
      next(t for t in takes[0]["takes"] if t["is_selected"])["start"] > 100)

pinned = deterministic_filter_pipeline(
    run_script, "\n".join([
        "[5.00 - 10.00 | -17.00 dBFS] Sữa non tổ yến giúp bé tăng đề kháng mỗi ngày",
        "[11.00 - 16.00 | -17.00 dBFS] Ba mẹ nhớ bổ sung canxi và vitamin D3 đầy đủ",
        "[17.00 - 21.00 | -17.00 dBFS] Cảm ơn cả nhà đã xem hết video này",
        "[130.00 - 135.00 | -16.50 dBFS] Sữa non tổ yến giúp bé tăng đề kháng mỗi ngài",
        "[136.00 - 141.00 | -16.50 dBFS] Ba mẹ nhớ bổ sung can xi và vitamin D3 đầy đủ",
        "[142.00 - 146.00 | -16.50 dBFS] Cảm ơn cả nhà đã xem hết video nay",
    ]),
    session_file=NO_SESSION,
    pinned_takes={0: 0},
)
first = pinned["sentence_takes"][0]
check("ghim take 0 thì câu đó chuyển về lượt đọc đầu",
      next(t for t in first["takes"] if t["is_selected"])["start"] < 100,
      [(t["take_index"], t["start"], t["is_selected"]) for t in first["takes"]])
check("các câu khác vẫn khớp đủ", len(pinned["timeline_script_order"]) >= 2)

print("UI và backend phải đánh số câu GIỐNG HỆT nhau")
# Số hiệu câu là khoá liên kết kịch bản <-> đoạn (script_index, merged_script_indices).
# Hai bộ tách lệch nhau một luật là mọi liên kết trỏ nhầm câu, im lặng, không lỗi nào
# bắn ra. index.html giữ bản JS riêng vì nó vẽ kịch bản ra màn hình, nên phải đối
# chiếu thẳng hai bản với nhau.
# Bộ tách câu nay nằm ở static/js/script-reorder.js (module UMD) — MỘT bản duy nhất
# cho renderer và cho test. Trước đây test moi mã JS ra khỏi index.html bằng regex, nên
# chỉ cần đổi tên hàm là bài đối chiếu này lặng lẽ bỏ qua.
probes = [
    "Đúng vậy.\nBa mẹ nhớ bổ sung canxi cho con nhé.\n1. Ngủ trước mười giờ tối\nTuyệt vời.",
    "Câu một không có dấu chấm\nCâu hai kết thúc đây.",
    "1. Dinh dưỡng cân đối\n2) Ngủ sớm mỗi ngày\n- Uống đủ nước",
    "4 việc này giúp con cao lớn. Số 1 là 1,7g/100ml.",
    # Ký tự vô hình: trim() của JS coi U+FEFF là khoảng trắng nhưng KHÔNG coi U+200B là.
    "\ufeffCâu có BOM ở đầu. Câu hai có ZWSP ở cuối\u200b",
]
for case_dir in sorted((PROJECT_ROOT / "tests" / "fixtures" / "matching").glob("*/script.txt")):
    probes.append(case_dir.read_bytes().decode("utf-8"))

module_path = PROJECT_ROOT / "static" / "js" / "script-reorder.js"
if not module_path.exists():
    check("có static/js/script-reorder.js", False, str(module_path))
else:
    script = (
        "const SR = require(" + json.dumps(str(module_path)) + ");"
        "\nconst input = JSON.parse(process.argv[1]);"
        # Renderer chia paragraph bằng /\n{2,}/ rồi gọi splitScriptPieces cho từng khối.
        # Đường đó phải cho ra ĐÚNG dãy mà splitScriptSentences trả về cho cả bài, nếu
        # không thì số hiệu câu trên màn hình lệch với số hiệu câu backend gán.
        "\nconst out = input.map((text) => ({"
        "\n  flat: SR.splitScriptSentences(text),"
        "\n  perBlock: text.replace(/\\r/g, '').split(/\\n{2,}/)"
        "\n    .flatMap((block) => SR.splitScriptPieces(block)),"
        "\n}));"
        "\nprocess.stdout.write(JSON.stringify(out));"
    )
    completed = subprocess.run(
        ["node", "-e", script, json.dumps(probes)],
        capture_output=True, text=True, cwd=str(PROJECT_ROOT),
    )
    if completed.returncode != 0:
        check("chạy được bộ tách JS", False, completed.stderr[:200])
    else:
        js_results = json.loads(completed.stdout)
        for number, (text, from_js) in enumerate(zip(probes, js_results)):
            from_python = split_sentences(text)
            label = f"kịch bản #{number} — {len(from_python)} câu"
            check(label, from_js["flat"] == from_python,
                  f"\n      JS  : {from_js['flat'][:3]}\n      PY  : {from_python[:3]}")
            check(f"{label} (đường vẽ theo paragraph)", from_js["perBlock"] == from_python,
                  f"\n      JS  : {from_js['perBlock'][:3]}\n      PY  : {from_python[:3]}")

if failures:
    print(f"\nmatching pipeline FAILED: {len(failures)} kiểm tra hỏng")
    raise SystemExit(1)
print("\nmatching pipeline ok")
