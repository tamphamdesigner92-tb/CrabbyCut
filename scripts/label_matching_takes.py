#!/usr/bin/env python3
"""Dựng phiếu gán nhãn "take nào là đúng" cho bộ dữ liệu vàng (Phase 0).

Bộ dò ứng viên ở đây CỐ TÌNH độc lập với engine đang chạy: nó quét cửa sổ trượt
trên toàn bộ dòng từ của transcript, không dùng chunk, không dùng cửa sổ ±2
chunk quanh anchor của apply_last_best_take. Nếu lấy nhãn từ chính hệ thống đang
đo thì mọi take mà hệ thống không nhìn thấy sẽ mặc nhiên "không tồn tại", và
điểm số sẽ đẹp một cách giả tạo.

    python scripts/label_matching_takes.py --propose        # tạo review.md
    python scripts/label_matching_takes.py --import         # review.md -> labels.json
"""
import argparse
import json
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
FIXTURE_DIR = PROJECT_ROOT / "tests" / "fixtures" / "matching"

from core_logic import _similarity, _token_coverage  # noqa: E402
from matching_eval_common import fold, permissive_sentences, word_stream  # noqa: E402

MIN_COVERAGE = 0.45
STRONG_COVERAGE = 0.62
STRONG_SIMILARITY = 0.60
NEAR_BEST_BAND = 0.12
MAX_CANDIDATES = 6
RUN_GAP_SEC = 45.0


def find_takes(sentence: str, stream, folded_stream):
    """Mọi vùng trên dòng từ có thể là một lần đọc câu này."""
    target = fold(sentence).split()
    if not target:
        return []
    unique = set(target)
    n = len(stream)
    max_window = min(n, int(len(target) * 2.2) + 6)
    min_window = max(2, int(len(target) * 0.45))

    raw = []
    for i in range(n):
        present = set()
        hits = 0
        best_here = None
        for j in range(i, min(n, i + max_window)):
            token = folded_stream[j]
            if token in unique:
                hits += 1
                present.add(token)
            length = j - i + 1
            if length < min_window:
                continue
            recall = len(present) / len(unique)
            precision = hits / length
            if recall < MIN_COVERAGE:
                continue
            f1 = 2 * recall * precision / (recall + precision) if (recall + precision) else 0.0
            if best_here is None or f1 > best_here[0]:
                best_here = (f1, j, recall)
        if best_here is not None:
            raw.append((best_here[0], i, best_here[1]))

    # Gom các cửa sổ chồng lấn thành một "take" duy nhất, giữ cửa sổ điểm cao nhất.
    raw.sort(key=lambda item: -item[0])
    chosen = []
    for f1, i, j in raw:
        if any(not (j < ci or i > cj) for _, ci, cj in chosen):
            continue
        chosen.append((f1, i, j))
    chosen.sort(key=lambda item: item[1])

    takes = []
    for _, i, j in chosen:
        text = " ".join(stream[k][0] for k in range(i, j + 1))
        similarity = _similarity(sentence, text)
        coverage = _token_coverage(sentence, text)
        if coverage < MIN_COVERAGE:
            continue
        takes.append({
            "start": round(stream[i][1], 2),
            "end": round(stream[j][2], 2),
            "text": text,
            "similarity": round(similarity, 3),
            "coverage": round(coverage, 3),
        })

    # Lọc nhiễu cho người duyệt: chỉ những vùng đủ giống mới đáng cân nhắc. Câu
    # nào không có vùng nào đủ mạnh thì vẫn hiện vài ứng viên yếu nhất có thể,
    # để người duyệt còn thấy được là "không nói" hay chỉ là ASR nghe rất tệ.
    strong = [t for t in takes if t["coverage"] >= STRONG_COVERAGE and t["similarity"] >= STRONG_SIMILARITY]
    takes = strong if strong else sorted(takes, key=lambda t: -(t["coverage"] + t["similarity"]))[:3]
    takes.sort(key=lambda t: -(t["coverage"] + t["similarity"]))
    takes = takes[:MAX_CANDIDATES]
    takes.sort(key=lambda t: t["start"])
    return takes


def detect_runs(payload, sentence_count):
    """Gom ứng viên thành các "lượt đọc" (run) theo THỨ HẠNG xuất hiện.

    Người quay thường đọc lại CẢ kịch bản chứ không chỉ một câu. Khi đó quyết
    định thật sự là "lấy lượt nào", không phải N quyết định rời rạc — quyết theo
    từng câu rất dễ ra timeline chắp vá nửa lượt này nửa lượt kia.

    Lượt thứ r = tập hợp ứng viên thứ r (tính theo thời gian) của mỗi câu. Không
    thể tách lượt bằng khoảng trống thời gian: hai lượt đọc liên tiếp thường chỉ
    cách nhau vài giây, đúng bằng khoảng nghỉ giữa hai câu trong cùng một lượt.
    """
    depth = max((len(takes) for takes in payload.values()), default=0)
    summary = []
    for rank in range(depth):
        picked = [takes[rank] for takes in payload.values() if len(takes) > rank]
        if len(picked) < max(2, sentence_count * 0.35):
            continue
        summary.append({
            "start": round(min(take["start"] for take in picked), 2),
            "end": round(max(take["end"] for take in picked), 2),
            "covered": len(picked),
        })
    return summary


def propose_pick(takes):
    """Đề xuất mặc định: take MUỘN NHẤT trong nhóm gần-tốt-nhất.

    Đây chỉ là điểm khởi đầu để người duyệt bấm nhanh, KHÔNG phải nhãn. Đúng hay
    sai vẫn do người chốt — nếu tin luôn đề xuất này thì nhãn chỉ đang mã hoá lại
    đúng cái giả định "take cuối là tốt nhất" mà ta muốn kiểm chứng.
    """
    if not takes:
        return None
    best = max(t["coverage"] + t["similarity"] for t in takes)
    near = [t for t in takes if (t["coverage"] + t["similarity"]) >= best - NEAR_BEST_BAND]
    return takes.index(max(near, key=lambda t: t["start"]))


def build_review(case_dir: Path):
    script_text = (case_dir / "script.txt").read_bytes().decode("utf-8")
    segments = json.loads((case_dir / "segments.json").read_text(encoding="utf-8"))
    sentences = permissive_sentences(script_text)
    stream = word_stream(segments)
    folded_stream = [fold(w[0]) for w in stream]

    lines = [
        f"# Gán nhãn take — {case_dir.name}",
        "",
        "Mỗi câu kịch bản liệt kê MỌI lần nó được nói trong video (dò độc lập với",
        "engine so khớp). Đánh dấu `[x]` vào ĐÚNG MỘT dòng cho mỗi câu:",
        "",
        "- `[x]` ở một take  → đó là đoạn nên đưa vào timeline",
        "- `[x]` ở `KHÔNG NÓI` → câu này không hề xuất hiện trong video",
        "",
        "Dòng đã tick sẵn là ĐỀ XUẤT của máy (take muộn nhất trong nhóm gần-tốt-nhất).",
        "Sửa lại chỗ nào sai rồi chạy: `python scripts/label_matching_takes.py --import`",
        "",
    ]
    payload = {}
    for idx, sentence in enumerate(sentences):
        payload[idx] = find_takes(sentence, stream, folded_stream)

    runs = detect_runs(payload, len(sentences))
    if len(runs) > 1:
        lines += ["**Lượt đọc dò được** (có vẻ kịch bản được đọc lại nhiều lần):", ""]
        for run_idx, run in enumerate(runs):
            lines.append(
                f"- Lượt {run_idx + 1} (`take {run_idx}` của mỗi câu): "
                f"{run['start']:.0f}s – {run['end']:.0f}s, phủ {run['covered']}/{len(sentences)} câu"
            )
        lines += ["", "Nếu cả một lượt là bản đọc tốt thì tick theo lượt đó cho nhất quán.", ""]

    for idx, sentence in enumerate(sentences):
        takes = payload[idx]
        pick = propose_pick(takes)
        lines.append(f"## [{idx}] {sentence}")
        lines.append("")
        if not takes:
            lines.append("- [x] KHÔNG NÓI  _(không dò được lần đọc nào)_")
        else:
            for take_idx, take in enumerate(takes):
                mark = "x" if take_idx == pick else " "
                lines.append(
                    f"- [{mark}] `take {take_idx}` "
                    f"{take['start']:8.2f}–{take['end']:8.2f}s  "
                    f"cov {take['coverage']:.2f} sim {take['similarity']:.2f}"
                )
                lines.append(f"      > {take['text']}")
            lines.append("- [ ] KHÔNG NÓI")
        lines.append("")

    (case_dir / "review.md").write_text("\n".join(lines), encoding="utf-8")
    (case_dir / "takes.json").write_text(
        json.dumps({"sentences": sentences, "takes": payload}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    multi = sum(1 for takes in payload.values() if len(takes) > 1)
    none = sum(1 for takes in payload.values() if not takes)
    return len(sentences), multi, none


_HEADING_RE = re.compile(r"^##\s*\[(\d+)\]")
_TAKE_RE = re.compile(r"^-\s*\[([ xX])\]\s*`take (\d+)`")
_NONE_RE = re.compile(r"^-\s*\[([ xX])\]\s*KHÔNG NÓI")


def import_review(case_dir: Path):
    review_file = case_dir / "review.md"
    if not review_file.exists():
        return None
    takes_data = json.loads((case_dir / "takes.json").read_text(encoding="utf-8"))
    takes_by_sentence = {int(k): v for k, v in takes_data["takes"].items()}

    labels = {}
    current = None
    conflicts = []
    for line in review_file.read_text(encoding="utf-8").splitlines():
        heading = _HEADING_RE.match(line)
        if heading:
            current = int(heading.group(1))
            continue
        if current is None:
            continue
        take_match = _TAKE_RE.match(line)
        if take_match and take_match.group(1).lower() == "x":
            if current in labels:
                conflicts.append(current)
            take = takes_by_sentence[current][int(take_match.group(2))]
            labels[current] = {"spoken": True, "start": take["start"], "end": take["end"], "text": take["text"]}
            continue
        none_match = _NONE_RE.match(line)
        if none_match and none_match.group(1).lower() == "x":
            if current in labels:
                conflicts.append(current)
            labels[current] = {"spoken": False}

    payload = {
        "source": "review.md",
        "sentences": {str(k): v for k, v in sorted(labels.items())},
    }
    (case_dir / "labels.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return len(labels), sorted(set(conflicts))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--propose", action="store_true")
    parser.add_argument("--import", dest="do_import", action="store_true")
    parser.add_argument("--case")
    args = parser.parse_args()
    if not args.propose and not args.do_import:
        parser.error("cần --propose hoặc --import")

    # Bộ ca thật KHÔNG được commit (chứa kịch bản và transcript của khách hàng — xem
    # tests/fixtures/README.md). `iterdir()` trên thư mục thiếu thì ném, nên báo bằng
    # một câu người đọc hiểu được thay vì một traceback.
    if not FIXTURE_DIR.is_dir():
        print(f"Không có bộ ca đo tại {FIXTURE_DIR} — xem tests/fixtures/README.md.")
        return 2
    case_dirs = sorted(d for d in FIXTURE_DIR.iterdir() if d.is_dir() and (d / "script.txt").exists())
    if args.case:
        case_dirs = [d for d in case_dirs if d.name == args.case]

    for case_dir in case_dirs:
        if args.propose:
            total, multi, none = build_review(case_dir)
            print(f"  {case_dir.name:11s} {total:3d} câu — {multi:3d} câu có nhiều take, {none:3d} câu không dò ra")
        else:
            outcome = import_review(case_dir)
            if outcome is None:
                print(f"  {case_dir.name:11s} chưa có review.md")
                continue
            count, conflicts = outcome
            warn = f"  ⚠ tick nhiều lựa chọn ở câu {conflicts}" if conflicts else ""
            print(f"  {case_dir.name:11s} {count:3d} nhãn{warn}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
