#!/usr/bin/env python3
"""Đo chất lượng so khớp kịch bản trên bộ dữ liệu vàng (Phase 0).

Chạy `deterministic_filter_pipeline` trên từng case trong
tests/fixtures/matching/ rồi in bảng chỉ số. Có nhãn (labels.json) thì đo cả độ
chính xác chọn take; chưa có nhãn thì vẫn đo được các chỉ số tự-kiểm: câu bị bộ
tách nuốt, hàng rơi giữa pipeline và UI, audio dùng trùng, đảo thứ tự.

    python scripts/eval_matching.py                 # in bảng
    python scripts/eval_matching.py --save-baseline # chốt mốc so sánh
    python scripts/eval_matching.py --case nanu -v  # xem chi tiết một case
"""
import argparse
import json
import re
import sys
from pathlib import Path
from time import perf_counter

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

FIXTURE_DIR = PROJECT_ROOT / "tests" / "fixtures" / "matching"
BASELINE_FILE = FIXTURE_DIR / "baseline.json"
SCRATCH = PROJECT_ROOT / "temp_uploads" / "_eval_session.json"

from core_logic import deterministic_filter_pipeline, split_sentences  # noqa: E402
from matching_eval_common import (  # noqa: E402
    format_segments_to_text,
    overlap,
    permissive_sentences,
)




def evaluate_case(case_dir: Path, verbose: bool = False) -> dict:
    script_text = (case_dir / "script.txt").read_bytes().decode("utf-8")
    segments = json.loads((case_dir / "segments.json").read_text(encoding="utf-8"))
    meta = json.loads((case_dir / "meta.json").read_text(encoding="utf-8"))

    SCRATCH.parent.mkdir(parents=True, exist_ok=True)
    SCRATCH.write_text(json.dumps(segments, ensure_ascii=False), encoding="utf-8")

    started = perf_counter()
    result = deterministic_filter_pipeline(
        reference_script=script_text,
        transcript_text=format_segments_to_text(segments),
        session_file=str(SCRATCH),
    )
    elapsed = perf_counter() - started

    sentences = split_sentences(script_text)
    rows = result["timeline_script_order"]
    mapped = result.get("mapped_chunks", [])
    selected = [c for c in mapped if c.get("is_selected")]

    # Hai kiểu mất câu ngay từ khâu tách kịch bản, cả hai đều IM LẶNG (không
    # xuất hiện trong unmatched_sentences nên người dùng không bao giờ biết):
    #   too_short — câu dưới 3 từ bị loại thẳng
    #   glued     — hai dòng kịch bản bị dán thành một câu, vì split_sentences
    #               gộp hết khoảng trắng trước khi tách theo "\n+"
    all_sentences = permissive_sentences(script_text)
    too_short = sum(1 for item in all_sentences if len(item.split()) < 3)
    glued = max(0, len(all_sentences) - too_short - len(sentences))
    dropped_by_splitter = len(all_sentences) - len(sentences)

    # F4/F5 — câu đã khớp trong pipeline nhưng KHÔNG tới được UI, vì
    # mapped_chunks chỉ tick chunk khi hàng phủ >40% thời lượng chunk.
    matched_idx = set()
    for row in rows:
        for idx in row.get("merged_script_indices", [row["script_index"]]):
            matched_idx.add(int(idx))
    delivered_idx = set()
    for chunk in selected:
        for idx in chunk.get("merged_script_indices") or [chunk.get("script_index", -1)]:
            if int(idx) >= 0:
                delivered_idx.add(int(idx))
    lost_to_ui = sorted(matched_idx - delivered_idx)

    # F5 — sai lệch giữa biên tinh pipeline tính được và biên chunk UI nhận.
    boundary_shift = []
    for row in rows:
        best = None
        for chunk in selected:
            ov = overlap(row["start"], row["end"], chunk["start"], chunk["end"])
            if ov > 0 and (best is None or ov > best[0]):
                best = (ov, chunk)
        if best:
            chunk = best[1]
            boundary_shift.append(abs(chunk["start"] - row["start"]) + abs(chunk["end"] - row["end"]))

    # Audio dùng trùng: hai hàng chồng lấn nhau > 0.2s.
    by_time = sorted(rows, key=lambda r: (r["start"], r["end"]))
    duplicate_pairs = sum(
        1
        for a, b in zip(by_time, by_time[1:])
        if overlap(a["start"], a["end"], b["start"], b["end"]) > 0.2
    )
    inversions = sum(
        1
        for a, b in zip(rows, rows[1:])
        if b["start"] < a["start"] - 0.001
    )

    sims = sorted(float(r["similarity"]) for r in rows)
    covs = sorted(float(r["token_coverage"]) for r in rows)

    def pct(values, ratio):
        if not values:
            return 0.0
        return round(values[min(len(values) - 1, int(len(values) * ratio))], 3)

    metrics = {
        "case_id": meta["case_id"],
        "script_lines": len(all_sentences),
        "sentences": len(sentences),
        "dropped_by_splitter": dropped_by_splitter,
        "too_short": too_short,
        "glued": glued,
        "chunks": result["stats"]["chunk_count"],
        "matched": len(matched_idx),
        "recall_vs_lines": round(len(matched_idx) / max(1, len(all_sentences)) * 100, 1),
        "delivered": len(delivered_idx),
        "lost_to_ui": len(lost_to_ui),
        "unmatched": len(result["unmatched_sentences"]),
        "duplicate_pairs": duplicate_pairs,
        "inversions": inversions,
        "sim_p50": pct(sims, 0.5),
        "sim_p10": pct(sims, 0.1),
        "cov_p50": pct(covs, 0.5),
        "cov_p10": pct(covs, 0.1),
        "boundary_shift_mean": round(sum(boundary_shift) / len(boundary_shift), 3) if boundary_shift else 0.0,
        "seconds": round(elapsed, 2),
    }

    labels_file = case_dir / "labels.json"
    if labels_file.exists():
        metrics.update(score_against_labels(json.loads(labels_file.read_text(encoding="utf-8")), rows, sentences))

    if verbose:
        print(f"\n--- {meta['case_id']} ---")
        for row in rows:
            print(
                f"  #{row['script_index']:3d} {row['start']:8.2f}-{row['end']:8.2f} "
                f"sim={row['similarity']:.3f} cov={row['token_coverage']:.3f}\n"
                f"       KB : {row['script_text'][:88]}\n"
                f"       RAW: {row['matched_text'][:88]}"
            )
        for item in result["unmatched_sentences"]:
            print(f"  #{item['script_index']:3d} KHÔNG KHỚP: {item['script_text'][:88]}")
        if lost_to_ui:
            print(f"  RƠI TRƯỚC UI (câu đã khớp nhưng chunk không được tick): {lost_to_ui}")
    return metrics


def score_against_labels(labels: dict, rows: list, sentences: list) -> dict:
    """Hai phép đo tách bạch: CHỌN ĐÚNG VÙNG chưa, và BIÊN có khít không.

    Đo biên phải theo HÀNG chứ không theo câu. Pipeline gộp các câu đọc liền nhau
    thành một hàng (nanu: 27 câu -> 12 hàng), nên so một hàng gộp 6 câu với nhãn của
    từng câu một sẽ báo "dư 20 giây" trong khi hàng đó bám nhãn khít trong 0,2s.
    Tham chiếu đúng của một hàng là HỢP của các khoảng nhãn mà nó gộp.

    Biên chỉ đo trên các hàng đã chọn đúng vùng — hàng chọn nhầm take thì sai số biên
    của nó là vô nghĩa, và trộn vào sẽ che mất chất lượng biên thật.
    """
    gold = {int(k): v for k, v in (labels.get("sentences") or {}).items()}
    if not gold:
        return {}
    spoken = {i: g for i, g in gold.items() if g.get("spoken") is not False}

    by_script = {}
    for row in rows:
        for idx in row.get("merged_script_indices", [row["script_index"]]):
            by_script.setdefault(int(idx), row)

    correct = wrong = missed = spurious = 0
    for idx, want in gold.items():
        row = by_script.get(idx)
        if want.get("spoken") is False:
            if row is not None:
                spurious += 1
            continue
        if row is None:
            missed += 1
            continue
        gold_span = max(0.001, float(want["end"]) - float(want["start"]))
        row_span = max(0.001, row["end"] - row["start"])
        covered = overlap(row["start"], row["end"], float(want["start"]), float(want["end"]))
        # Chia theo khoảng NGẮN HƠN, không chia theo nhãn. take% trả lời "có chọn đúng
        # vùng không", còn "đúng độ dài chưa" đã có Δđầu/Δcuối/dư/thiếu đo riêng.
        # Chia theo nhãn thì một hàng nằm gọn trong nhãn bị tính là SAI — mà nhãn lại
        # hay rộng hơn thực tế: bộ dò ứng viên dựng phiếu duyệt vơ cả đoạn nói lắp
        # phía trước vào (nem_house #7: nhãn dài 17,4s ôm 8,9s nói lắp, hàng lấy đúng
        # 8,5s bản đọc sạch — hàng đúng hơn nhãn).
        if covered / min(gold_span, row_span) >= 0.6:
            correct += 1
        else:
            wrong += 1

    start_err, end_err, extra_audio, missing_audio = [], [], [], []
    for row in rows:
        indices = [
            int(i) for i in row.get("merged_script_indices", [row["script_index"]])
            if int(i) in spoken
        ]
        if not indices:
            continue
        gold_start = min(float(spoken[i]["start"]) for i in indices)
        gold_end = max(float(spoken[i]["end"]) for i in indices)
        gold_span = max(0.001, gold_end - gold_start)
        if overlap(row["start"], row["end"], gold_start, gold_end) / gold_span < 0.5:
            continue  # hàng chọn nhầm vùng: sai số biên không có ý nghĩa
        start_err.append(abs(row["start"] - gold_start))
        end_err.append(abs(row["end"] - gold_end))
        row_span = row["end"] - row["start"]
        extra_audio.append(max(0.0, row_span - gold_span))
        missing_audio.append(max(0.0, gold_span - row_span))

    total = max(1, correct + wrong + missed)

    def p(values, ratio):
        if not values:
            return 0.0
        values = sorted(values)
        return round(values[min(len(values) - 1, int(len(values) * ratio))], 3)

    return {
        "take_accuracy": round(correct / total * 100, 1),
        "wrong_take": wrong,
        "missed": missed,
        "spurious": spurious,
        "start_err_p50": p(start_err, 0.5),
        "start_err_p90": p(start_err, 0.9),
        "end_err_p90": p(end_err, 0.9),
        "extra_audio_p90": p(extra_audio, 0.9),
        "missing_audio_p90": p(missing_audio, 0.9),
    }


COLUMNS = [
    ("case_id", "case", 11, "s"),
    ("script_lines", "câu KB", 7, "d"),
    ("sentences", "vào", 5, "d"),
    ("too_short", "ngắn", 5, "d"),
    ("glued", "dán", 4, "d"),
    ("chunks", "chunk", 6, "d"),
    ("matched", "khớp", 5, "d"),
    ("recall_vs_lines", "recall%", 8, ".1f"),
    ("delivered", "tới UI", 7, "d"),
    ("lost_to_ui", "rơi", 4, "d"),
    ("duplicate_pairs", "trùng", 6, "d"),
    ("inversions", "đảo", 4, "d"),
    ("sim_p50", "sim50", 6, ".3f"),
    ("cov_p10", "cov10", 6, ".3f"),
    ("seconds", "giây", 6, ".2f"),
]
LABEL_COLUMNS = [
    ("take_accuracy", "take%", 6, ".1f"),
    ("wrong_take", "sai", 4, "d"),
    ("missed", "sót", 4, "d"),
    ("start_err_p90", "Δđầu90", 7, ".2f"),
    ("end_err_p90", "Δcuối90", 8, ".2f"),
    ("extra_audio_p90", "dư90", 6, ".2f"),
    ("missing_audio_p90", "thiếu90", 8, ".2f"),
]


def print_table(all_metrics, baseline=None):
    columns = list(COLUMNS)
    if any("take_accuracy" in m for m in all_metrics):
        columns += LABEL_COLUMNS
    header = "  ".join(f"{label:>{width}}" for _, label, width, _ in columns)
    print(header)
    print("-" * len(header))
    for metrics in all_metrics:
        cells = []
        for keyname, _, width, fmt in columns:
            value = metrics.get(keyname, 0)
            cells.append(f"{value:>{width}{fmt}}" if fmt != "s" else f"{value:>{width}}")
        print("  ".join(cells))
        if baseline and metrics["case_id"] in baseline:
            deltas = []
            for keyname, label, _, fmt in columns:
                if fmt == "s":
                    continue
                before = baseline[metrics["case_id"]].get(keyname)
                after = metrics.get(keyname)
                if before is None or after is None or abs(after - before) < 1e-9:
                    continue
                sign = "+" if after > before else ""
                deltas.append(f"{label} {sign}{round(after - before, 3)}")
            if deltas:
                print(f"{'':>11}  Δ so với baseline: {', '.join(deltas)}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", help="chỉ chạy một case")
    parser.add_argument("--save-baseline", action="store_true")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    # Bộ ca thật KHÔNG được commit (chứa kịch bản và transcript của khách hàng — xem
    # tests/fixtures/README.md). `iterdir()` trên thư mục thiếu thì ném, nên báo bằng
    # một câu người đọc hiểu được thay vì một traceback.
    if not FIXTURE_DIR.is_dir():
        print(f"Không có bộ ca đo tại {FIXTURE_DIR} — xem tests/fixtures/README.md.")
        return 2
    case_dirs = sorted(d for d in FIXTURE_DIR.iterdir() if d.is_dir() and (d / "script.txt").exists())
    if args.case:
        case_dirs = [d for d in case_dirs if d.name == args.case]
    if not case_dirs:
        print("Chưa có fixture nào. Chạy: python scripts/build_matching_fixtures.py")
        return 1

    baseline = None
    if BASELINE_FILE.exists() and not args.save_baseline:
        baseline = {m["case_id"]: m for m in json.loads(BASELINE_FILE.read_text(encoding="utf-8"))}

    all_metrics = [evaluate_case(d, verbose=args.verbose) for d in case_dirs]
    print()
    print_table(all_metrics, baseline)

    totals = {
        "câu kịch bản": sum(m["script_lines"] for m in all_metrics),
        "câu ngắn bị loại": sum(m["too_short"] for m in all_metrics),
        "câu bị dán dính": sum(m["glued"] for m in all_metrics),
        "khớp được": sum(m["matched"] for m in all_metrics),
        "tới được UI": sum(m["delivered"] for m in all_metrics),
        "rơi giữa đường": sum(m["lost_to_ui"] for m in all_metrics),
        "audio dùng trùng": sum(m["duplicate_pairs"] for m in all_metrics),
    }
    print("\nTỔNG: " + "  |  ".join(f"{k} {v}" for k, v in totals.items()))

    scored = [m for m in all_metrics if "take_accuracy" in m]
    if scored:
        wrong = sum(m["wrong_take"] for m in scored)
        missed = sum(m["missed"] for m in scored)
        labelled = sum(len(json.loads((FIXTURE_DIR / m["case_id"] / "labels.json").read_text(encoding="utf-8"))["sentences"]) for m in scored)
        correct = labelled - wrong - missed
        print(
            f"TAKE : đúng {correct}/{labelled} = {correct / max(1, labelled) * 100:.1f}%"
            f"  |  chọn nhầm take {wrong}  |  bỏ sót {missed}"
        )

    if args.save_baseline:
        BASELINE_FILE.write_text(json.dumps(all_metrics, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nĐã chốt baseline vào {BASELINE_FILE.relative_to(PROJECT_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
