# Bàn giao: Full Test xuất rất chậm trên GTX 1060 — tràn VRAM do chạy song song (2026-10-23, đã sửa)

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

## Đã sửa: hướng A — xếp lượt GPU theo VRAM (người dùng chọn 2026-10-23)

Ba hướng đã đưa ra: (A) xếp lượt theo VRAM, (B) card ≤ 8 GB chỉ 1 lượt GPU, (C) đổi kiểu phụ đề.
Người dùng chọn A. Mã ở `native/sidecar/core_process.cpp`:

- `EstimateBatchGpuVramMb` (đặt ngay sau `BatchGpuEligible`): VRAM một batch GPU =
  150 MB + 19 byte × điểm ảnh khung + Σ lớp phủ max(0,5 MB, 1,37 × byte thô − 2,25 MB). Byte thô
  theo đúng các cấp phát của bộ lọc: ảnh RGBA = 2 khung `hwupload` (4 B/px nguồn) + `crabgeo_cuda`
  4 mặt phẳng float (16 B/px ra) + bộ đệm lượt ngang + 2 khung ra yuva420p; video NVDEC/hwupload,
  CpuYuv, CpuCanvas (khung trong suốt cỡ sequence) tính riêng. Cỡ ảnh đọc từ IHDR của PNG (khung đầu
  với chuỗi khung), video qua ffprobe.
- `GpuVramBudgetMb`: VRAM trống từ `nvidia-smi` (đã trừ app khác đang giữ) trừ dự phòng
  max(256 MB, 5%). Không đọc được = không giới hạn (như cũ). `CRABBYCUT_EXPORT_VRAM_MB=N` đặt tay
  (0 = tắt).
- `RunBatchJobs` (nhánh Windows): lượt GPU kế tiếp chỉ khởi chạy khi tổng ước lượng của các lượt GPU
  đang chạy cộng nó còn vừa ngân sách; không thì chờ một lượt xong (giữ thứ tự batch, báo "Chờ VRAM
  trống…"). Không có lượt GPU nào chạy thì luôn cho chạy. Lượt tiếng, batch CPU không bị chặn. Tra
  cache render chỉ một lần cho mỗi batch kể cả khi phải chờ.
- timing.json thêm `vram_budget_mb`, mỗi lượt thêm `vram_est_mb` + `start_ms` (mốc khởi chạy).

**Hiệu chỉnh hệ số:** chạy riêng từng batch GPU (28 batch: Full Test + phim cũ, 3840×1646) tới hết,
lấy đỉnh `\GPU Process Memory(pid_*)\Dedicated Usage`. Mô hình "làm tròn mỗi cấp phát 2 MiB" ước dư
tới 2,7× với ảnh nhỏ (CUDA trên WDDM gom cấp phát nhỏ) nên bỏ; mô hình tuyến tính trên khớp
ước lượng / đo = **0,99–1,16** trên 27 batch (batch có video Subsequence khớp bằng phần tính video).
Phần cố định chỉ đo ở khung 4K — cỡ khung khác (1080p, dọc) là ngoại suy theo điểm ảnh.

**Số đo sau sửa** (phát lại payload, GTX 1060, cấu hình mặc định — không ép số lượt; "sidecar" =
thời gian sidecar trong timing.json):

| Dự án | Trước | Sau (lượt 1 / lượt 2) | Ghi chú |
| --- | --- | --- | --- |
| Full Test (feat) | tràn VRAM: 2 khung/s, batch lỗi CUDA → lùi CPU; ép 1 lượt: 502 s | **425,0 / 437,5 s** | 14/14 batch GPU, 0 lùi CPU; 1–3 lượt GPU cùng lúc tuỳ cỡ batch; VRAM đỉnh 5.526/6.144 MB |
| Phim 39 phút cũ | main hôm nay 361 s | **378,5 / 371,4 s** | lịch y hệt main: 4 lượt cùng lúc, 0 lần chờ VRAM; chênh nằm trong dao động giữa các lượt |

**Test:** `tests/scripts/export_gpu.js` dự án A thêm mục 6 — mỗi batch có `vram_est_mb`, đọc được
ngân sách, mặc định các batch vẫn chạy chồng nhau; ngân sách 1 MB thì không chồng nhau, có dòng
"Chờ VRAM", bản xuất trùng bản song song. Đột biến tắt phép chặn -> test đỏ đúng chỗ. Cùng qua:
export_parallel, export_batch_time_varying, export_render_cache, export_yuv_composite,
export_many_overlays, export_seq_tail, export_source_ranges, wiggle_styles.
`export_overlay_tail` và `export_distort_video` lỗi `HTTP 404` ở bước backend trả tệp — lỗi CÓ SẴN
trên mã feat chưa sửa (đã build lại mã gốc để kiểm), cùng lỗi làm `bench_export` báo thất bại ở bước
tải về sau khi xuất xong; chưa điều tra.

## Phát hiện phụ

- Một ffmpeg của lượt xuất bị huỷ lúc 23:10 treo mồ côi (0% CPU) sau khi app đóng, giữ khoá
  `temp_uploads/temp_input.mp4` → báo cáo 23:23 có lỗi `EBUSY … unlink temp_input.mp4`, và bộ đo
  chờ nó mãi. Đã tắt tay. Nên kiểm đường huỷ/đóng app có giết hết tiến trình con khi ffmpeg đang
  kẹt ở CUDA không.
- Worktree thiếu `static/vendor/` (không nằm trong git) thì trang chết lúc nạp với lỗi TDZ
  `CRAB_PAYLOAD_VERSION` — chép từ checkout chính trước khi chạy bộ đo.
