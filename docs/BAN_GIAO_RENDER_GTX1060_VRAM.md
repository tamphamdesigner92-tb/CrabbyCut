# Bàn giao: Full Test xuất rất chậm trên GTX 1060 — tràn VRAM do chạy song song (2026-10-23)

## Câu hỏi

Dự án `G:\Work\AI\Test CrabbyCut\Full Test\Forever Inside - Sci-Fi Short Film.crab` (nhánh
`feat/port-studio-wiggle-distort-nest-text-gif-mcp`) xuất tốt trên máy RTX nhưng rất chậm trên máy
GTX 1060 6 GB, trong khi trên `main` cùng phim (bản chỉ có phụ đề) xuất ~6 phút.

## Kết luận

Không phải hồi quy của code nhánh feat. Nguyên nhân là **tràn VRAM**:

1. Mỗi lớp phủ trên đồ thị GPU có pool khung CUDA riêng (`hwupload` cấp sẵn 2 khung + khung ra của
   `crabgeo_cuda`), nên VRAM của một lượt ffmpeg ≈ base + Σ(cỡ ảnh lớp phủ).
2. Toàn bộ 1.230 phụ đề của Full Test có `box_width = 3400` cố định, nền 25% đen kéo hết box →
   PNG mỗi câu ~3460×153 (dự án cũ: box khít chữ, trung bình 1275 px). Một batch 180 s có
   ~110–137 lớp phủ → **một lượt ffmpeg 3,2–3,7 GB VRAM** (main/phim cũ: tối đa 1,1 GB).
3. Sidecar chạy **4 lượt hình cùng lúc** (`ExportParallelWorkers` = 3, `RunExportJobs(…, workers + 1)`
   — chỗ của lượt tiếng được nhường cho batch hình khi tiếng xong). Số lượt chỉ giới hạn theo RAM,
   **không theo VRAM** → cần ~12–14 GB trên card 6 GB.
4. Hệ quả đo được: VRAM 5.935/6.144 MiB, batch còn chạy chỉ **2 khung/s** (WDDM phân trang VRAM),
   batch khác lỗi `CUDA_ERROR_INVALID_VALUE` / `hevc_nvenc Invalid argument` → `RunExportJobs` chạy
   lại batch đó bằng đồ thị CPU (giải mã AV1 4K + ghép CPU) → cực chậm.

Máy RTX không mắc vì nhiều VRAM hơn (và có NVDEC AV1). GTX 1060 không giải mã AV1 bằng phần cứng
(`gpu_probe_cache` ghi `main 1`) — điều này đã có từ trước, không phải nguyên nhân mới.

## Số đo (GTX 1060 6 GB, Ryzen 7 2700X, ffmpeg n8.1.1-crabbycut.2)

| Ca | Kết quả |
| --- | --- |
| main, payload phim cũ `forever_inside_full` (phát lại, 4 lượt) | 377 s; mỗi ffmpeg ≤ 1.124 MB VRAM, tổng ≤ 4,6 GB |
| feat, Full Test, lượt ghi trong Electron (4 lượt) | batch 0: 2 khung/s; batch 2, 3 lỗi CUDA; VRAM đầy — đã dừng |
| feat, Full Test batch 1 chạy một mình, 480 khung | 6,2 s; đỉnh **3.206 MB** VRAM (2 lượt) |
| Như trên, PNG phụ đề cắt còn ≤ 1400 px | 6,2 s; đỉnh **1.452 MB** VRAM (2 lượt) |
| feat, Full Test, phát lại, `CRABBYCUT_EXPORT_PARALLEL=1` | **502 s** cả phim, 14/14 batch GPU, 30–38 s/batch, VRAM một ffmpeg ≤ 3,7 GB |

Bằng chứng nằm ở `test_temp/bench_export/fulltest_feat/` của worktree
`.claude/worktrees/render-perf-gtx1060-slow-bdd140` (payload ghi lại, filter script, timing.json) và
`reports/perf_export_forever_inside_full_main_vram_20261022165716.json` ở checkout chính.

## Hướng sửa (chưa làm — chờ người dùng chọn)

- **A. Giới hạn số lượt GPU song song theo VRAM** trong sidecar: ước lượng VRAM mỗi batch từ cỡ ảnh
  lớp phủ + base, đọc VRAM trống, xếp lượt sao cho tổng ≤ ~85%; không dùng chỗ của lượt tiếng cho
  batch GPU khi VRAM chật. Tự động cho mọi dự án, không đổi hình.
- **B. Nhanh:** card ≤ 8 GB thì mặc định 1 lượt GPU. Đơn giản (Full Test 502 s) nhưng dự án nhẹ chậm
  đi (phim cũ 377 s với 4 lượt).
- **C. Chỉ đổi kiểu phụ đề** (box tự co theo chữ): VRAM ~một nửa, nhưng đổi hình (mất thanh nền
  ngang khung) và lỗi vẫn chờ dự án khác.

## Phát hiện phụ

- Một ffmpeg của lượt xuất bị huỷ lúc 23:10 treo mồ côi (0% CPU) sau khi app đóng, giữ khoá
  `temp_uploads/temp_input.mp4` → báo cáo 23:23 có lỗi `EBUSY … unlink temp_input.mp4`, và bộ đo
  chờ nó mãi. Đã tắt tay. Nên kiểm đường huỷ/đóng app có giết hết tiến trình con khi ffmpeg đang
  kẹt ở CUDA không.
- Worktree thiếu `static/vendor/` (không nằm trong git) thì trang chết lúc nạp với lỗi TDZ
  `CRAB_PAYLOAD_VERSION` — chép từ checkout chính trước khi chạy bộ đo.
