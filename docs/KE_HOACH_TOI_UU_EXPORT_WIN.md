# Kế hoạch: Xuất video CrabbyCut nhanh ≥ 2× trên Windows — sửa lệnh ffmpeg + tự build ffmpeg

> **Trạng thái: CHƯA TRIỂN KHAI** — lập và lưu ngày 2026-09-26 để triển khai sau.
> - Lập trong phiên nghiên cứu ở repo `E:\Dev\Windows_App\ffmpeg` (clone upstream FFmpeg master `8864fd0aec`).
> - Mọi số dòng đã được kiểm trên mã nguồn tại thời điểm lập. Nếu mã đã đổi, kiểm lại trước khi làm theo.
> - Mọi con số "Đo" là đo thật trên máy dev: Ryzen 7 2700X + GTX 1060, driver 582.28.
>
> **Thứ tự thi công:** Bước 0A (bản vá gấp, phát hành riêng) → Bước 0 (đo + bộ so chất lượng) → Bước 1 (→ nhánh 1B nếu đạt ngưỡng) → Bước 2.

## Context

**Vì sao:** người dùng muốn export nhanh gấp đôi trên Windows. Repo `E:\Dev\Windows_App\ffmpeg` (upstream master `8864fd0aec`, 2026-09-26, chưa build) được clone về để cải tiến ffmpeg cho việc này.

**Hiện trạng đã kiểm chứng**
- CrabbyCut = Electron + Node (`backend/server.js`) + sidecar C++ (`native/sidecar/core_process.cpp`).
  - Sidecar không link libav\*: nó gọi `ffmpeg.exe` qua `CreateProcessW` (`:170-213`), với một filter script cho mỗi batch.
- ffmpeg đang chạy: BtbN `N-123955-g6c114bd6fa-20260414` ở `C:\ffmpeg-master-latest-win64-gpl\bin`. Máy còn có Gyan 8.1.1 full (winget).
  - Bộ cài tải BtbN `latest` (`setup_runtime.js:46`), không ghim phiên bản/checksum.
  - ffmpeg hệ thống được ưu tiên (`:491-494`), và mọi bản đã tải trước đó được dùng lại bất kể phiên bản (`:495-498`).
- Máy: Ryzen 7 2700X (16 luồng, AVX2, "slow gather"), GTX 1060 6 GB (Pascal, driver 582.28), 32 GB RAM. Có VS 18, Docker Desktop; không có MSYS2, nasm, CUDA toolkit.
- Dự án thật điển hình ("Bin Tom - Tap 3"):
  - Nguồn iPhone HEVC Main10 HLG, xoay −90°, dài 270 s.
  - Sequence 1080×1920; 20 clip, dài 76,6 s (giữ ~28% nguồn); 16 text + 3 media.
- **Đầu vào của export là `temp_input.mp4`**, bản nối các nguồn:
  - Nguồn HDR (kể cả một nguồn HLG đơn lẻ) và `.webm` được chuẩn hoá lúc nhập bằng libx264 8-bit `yuv420p`, xoay ghi thẳng vào khung (`server.js:1953-1955, 2212-2218`). Vì vậy "Bin Tom" được export từ **H.264 8-bit**.
  - Nguồn SDR đồng dạng thì `-c copy`, giữ nguyên codec (ví dụ HEVC 10-bit của DJI/điện thoại) và cả **metadata xoay**.
- **Con số 137,9 s trong báo cáo KHÔNG gồm bước vẽ trước và bước tải về.** `client_started_at_ms` được gán ở `index.html:15837`, sau `await exportPayload()` (`:15807`), là nơi bake PNG chữ, chuỗi khung hoạt ảnh và khung chuyển cảnh.
  - Tức con số đó = tải lên + chuẩn bị ở backend (có cả `sdrOverridesForEditingAssets`) + sidecar/ffmpeg. Phần lớn là ffmpeg, khoảng 30–60 ms cho mỗi khung đầu ra.
  - Thời gian vẽ trước hiện chưa được đo ở đâu cả.
- NVENC đang chạy `-preset fast` = P1, nhanh nhất; nó không phải nút thắt.

**Mục tiêu:** thời gian từ lúc bấm Xuất tới khi có file giảm **≥ 2×** trên các dự án mẫu (trung vị của ≥ 3 lượt). Bản xuất "giống bằng mắt" theo tiêu chí ở 0.3. Máy không có NVIDIA vẫn cho kết quả đúng và không chậm đi.

## Quyết định đã chốt với người dùng (2026-09-26)

| Vấn đề | Lựa chọn |
|---|---|
| Phạm vi | Bước 1 sửa cách sidecar dựng lệnh ffmpeg. Bước 2 tự build ffmpeg từ repo này, đo điểm nóng rồi vá đúng filter chậm |
| Phần cứng | NVIDIA trước (NVDEC/NVENC/CUDA), CPU dự phòng (thêm D3D11VA vì miễn phí trên Windows) |
| Chất lượng | Giống bằng mắt. Kiểm tự động bằng cách so với **bản chuẩn độ chính xác cao**: bản mới phải gần bản chuẩn ít nhất bằng bản cũ; cộng thêm VMAF(mới so với cũ) ≥ 95, PSNR ≥ 45 dB, và ngưỡng cho khung tệ nhất. Thay cho ngưỡng SSIM ≥ 0,995 ban đầu, vì số đo cho thấy ngưỡng đó đánh trượt cả thay đổi chính xác hơn |
| Bước vẽ trước trong Electron | Đo trước. Nếu chiếm ≥ 30% tổng thời gian trên dự án thật thì làm nhánh 1B |
| Bản ffmpeg dùng | Luôn dùng bản ghim phiên bản. ffmpeg hệ thống chỉ dùng khi bản ghim hỏng |
| Hai hồi quy do ffmpeg "latest" | Phát hành **bản vá riêng ngay** (ví dụ v1.1.13), trước mọi tối ưu; port sang `CrabbyCut_Private` |

## Chi phí đã xác định

Các số "Đo" là đo vi mô ngày 2026-09-26 trên máy này, ≥ 3 lượt, lấy trung vị, xuất ra `-f null`. Bước 0 sẽ đo lại trên dự án trọn vẹn.

| # | Chỗ tốn | Bằng chứng |
|---|---|---|
| 1 | **Giải mã thừa**: mọi interval `trim` từ `[0:v]`, không có `-ss`, nên ffmpeg giải mã từ giây 0 tới mốc cuối được dùng. "Bin Tom" giải mã ~8.100 khung để dùng ~2.300. **Đo**: H.264 8-bit 1080p giải mã ~600 khung/s, tốn ~8 lõi; HEVC Main10 ~330 khung/s, tốn ~12 lõi | `core_process.cpp:2089-2091, 3042-3046` |
| 2 | **Clip thường đi đường RGBA**: nền `color` + `format=rgba` + `overlay` (C, không SIMD) + `format=yuv420p`. **Đo** trên bản chuẩn hoá H.264 thật (20 s): đường hiện tại 5,89 s / 48,4 giây-CPU; đường nhanh YUV 1,07 s / 9,5; chỉ giải mã 1,00 s. Đường RGBA chiếm ~83% thời gian của clip thường | `:2051-2053, 2135, 2171-2185` |
| 3 | **Có lớp phủ thì cả luồng chính thành RGBA** (`overlay format=auto`, log xác nhận `yuv420p -> rgba`). **Đo** (một lớp phủ): 2,91 s so với 2,62 s khi dùng `format=yuv420`; không có lớp phủ 2,58 s | `vf_overlay.c:154-159, 276-277`; `core_process.cpp:2716` |
| 4 | **Xoay lặp lại theo từng clip**: mỗi lần tham chiếu `[0:v]` là một đầu vào filtergraph riêng, và autorotate chèn `transpose` cho **từng** đầu vào, trước `trim`. Nguồn xoay được `-c copy` thì mỗi khung bị xoay một lần cho mỗi clip còn mở | `ffmpeg_filter.c:2009-2036`; `core_process.cpp:2089` |
| 5 | **Phóng to scale cả khung rồi mới cắt** (auto-reframe tới 397%). Filter màu chạy trước khi thu nhỏ | `:2131-2135`; `APP_INTERNALS.md:8522-8525` |
| 6 | **Filter tính biểu thức từng điểm ảnh**: `geq` cho keyframe opacity và feather. `scale:eval=frame` cấu hình lại swscale mỗi khung | `:1770-1773, 2574-2581`; `vf_scale.c:766-811` |
| 7 | **Ảnh tĩnh giải mã lại mỗi khung** (`-loop 1 -t`). **Đo** (PNG 500×500 hiện 20 s): 3,09 s, so với 2,52 s khi nạp một khung + `yuv420` | `:2957-2962` |
| 8 | `lut3d` 8-bit trilinear là C thuần (SIMD chỉ có cho tetrahedral float/16-bit) | `x86/vf_lut3d_init.c:67-89` |
| 9 | Chạy nối đuôi. **Đo**: song song 2–4 tiến trình chỉ lợi ~10% (CPU bão hoà hoặc chạm trần NVDEC). Đáng làm sau khi đã giảm việc | `core_process.cpp:3274-3299` |
| 10 | Bản SDR của video HDR làm lớp phủ được mã hoá lại **toàn bộ** ngay trong lúc export, nếu chưa có trong cache | `server.js:2289-2372` |
| 11 | **Vẽ trước trong Electron** (ngoài ffmpeg, chưa được đo): tua `<video>` full-res mỗi khung + `setTimeout(50)` + canvas mới + `toBlob`, tuần tự | `editing-runtime.js:18057-18097, 18330-18441, 17512-17682` |

**NVDEC:** trên H.264 8-bit nó **chậm hơn** giải mã CPU (1,31 s so với 1,00 s), chỉ bớt ~3 giây-CPU. Trên HEVC Main10 nó bằng tốc độ CPU nhưng tốn ít CPU hơn ~72%. Vì vậy NVDEC chỉ đáng dùng cho nguồn HEVC/10-bit/độ phân giải cao được `-c copy`.

**Rủi ro đang xảy ra** (đã kiểm trong mã nguồn; NVENC đã thử thật một phần):
- **Export có thể đang hỏng trên máy cài mới.**
  - FFmpeg master đã xoá `-filter_complex_script`: commit `07407fff61`, vào master 2026-06-23, có trong `release/9.0`, không có trong 8.0/8.1; `ffmpeg_opt.c:1758-1766`.
  - CrabbyCut dùng nó ở `core_process.cpp:2974`, `server.js:3800`, `subtitle-jobs.js:308`; bản Private cũng vậy.
  - Bộ cài tải `master-latest` và verify chỉ chạy `-version`.
  - Cách thay: `-/filter_complex <file>`, có từ FFmpeg 7.0; đọc file qua `avio_open` nên an toàn Unicode (`cmdutils.c:253-273, 1569-1592`).
- **GTX 9xx/10xx có thể mất NVENC.**
  - BtbN master/n9.0/n8.1 hiện dùng nv-codec-headers 13.1 (`scripts.d/50-ffnvcodec.sh`), đòi driver ≥ 610 (`nvenc.c:257-333`). Pascal dừng ở nhánh R580.
  - Đã thử 2026-09-26: BtbN tháng 4 và **Gyan 8.1.1 full** đều chạy `h264_nvenc` trên GTX 1060.

**Vì sao 2× là khả thi:**
- Với dự án kiểu "Bin Tom", đường clip hiện tại (#2) tốn ~8 ms/khung, còn đường nhanh ~0,1 ms/khung. Chỉ riêng mục này đã có thể rút phần hình của lane chính ~5×.
- Cộng thêm: lớp phủ không còn kéo luồng chính sang RGBA (#3), ảnh tĩnh giải mã một lần (#7), bỏ giải mã thừa (#1), bỏ xoay lặp (#4).
- Song song hoá chỉ đo lại sau khi đã giảm việc.
- Nếu Bước 0 thấy khâu vẽ trước chiếm phần lớn (dự án nhiều chuyển cảnh), 2× phải đến từ nhánh 1B.

---

# BƯỚC 0A — Bản vá gấp, phát hành riêng (làm đầu tiên)

1. `-filter_complex_script <file>` → `-/filter_complex <file>` ở cả 3 chỗ. Sửa thêm `-vsync 0` → `-fps_mode passthrough` ở `tests/scripts/overlay_placement_contract.js:42`.
2. **Ghim ffmpeg = Gyan 8.1.1 full_build**: `https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-full_build.zip` (252 MB, static; bản `-shared` 101 MB nếu muốn nhẹ).
   - Đã thử trên máy này: có đủ `zscale libplacebo lut3d scale_cuda drawtext sendcmd tpad xfade`, hwaccel `cuda`/`d3d11va`, NVENC chạy.
   - GitHub API công bố digest SHA-256 cho từng file. Khi thi công, tự tính SHA-256 của file tải về, so khớp rồi mới ghim.
   - Sửa chú thích `setup_runtime.js:44-45`: chỉ bản essentials mới thiếu libplacebo.
3. `setup_runtime.js`:
   - bản ghim thắng ffmpeg hệ thống (`:491-494`);
   - lưu phiên bản + SHA-256 vào `runtime.json` và cài lại khi lệch (`:495-498`);
   - tăng `RUNTIME_SCHEMA`;
   - `verify` chạy một lượt export tí hon thật (lavfi 0,5 s qua `-/filter_complex` + encoder đã chọn), thay cho chỉ `-version`.
4. Test:
   - **Toàn bộ** danh sách test ở mục Kiểm chứng 3, chạy trên Gyan 8.1.1. Mọi người dùng sẽ chuyển sang bản này. Ví dụ, bẫy `all_opacity = 1` (`core_process.cpp:1894-1899`) mới chỉ được đo trên bản N-123955.
   - `test:export`, `test:export-long-subtitles`, `test:unicode-path`, `test:overlay-placement` chạy thêm trên BtbN tháng 4 và BtbN `latest` (tải vào scratch). Lượt BtbN `latest` cũng để xác nhận bằng số đo cả hai hồi quy cho ghi chú phát hành.
5. Thử bộ cài trên runtime sạch (`CRAB_RUNTIME_DIR` mới) → `npm run dist:win` → phát hành → port sang `CrabbyCut_Private` (`core_process.cpp:3001`, `server.js:3890`, `subtitle-jobs.js:259`).

Việc tải ffmpeg và việc đăng bản phát hành đều sẽ hỏi người dùng lúc làm.

---

# BƯỚC 0 — Dụng cụ đo và bản tham chiếu (bắt buộc trước mọi tối ưu)

**0.1 Tách thời gian theo từng khâu.**
- Gán mốc ngay đầu `performVideoExport` (`index.html:15686`). Báo riêng: vẽ trước (từng loại: chuyển cảnh / retouch / chữ động), tải lên, server (`server_duration_ms`, trong đó có `sdrOverridesForEditingAssets`), tải về.
- Báo cáo (`server.js:1332-1344`) thêm `overlay_count`, cỡ/fps sequence, độ dài timeline, codec + xoay của `temp_input.mp4`.
- Sidecar có cờ `CRABBYCUT_EXPORT_BENCH=1`, khi bật thì:
  - giữ filter script (không xoá ở `:3071`);
  - in dòng lệnh;
  - `-v info -benchmark -progress <file>` (dòng `bench:` in ở mức INFO, `ffmpeg.c:331, 1052-1054`);
  - `-print_graphs_file` để soát định dạng thương lượng và bộ chuyển đổi tự chèn;
  - chạy lại với `-f null -` (tách encode) và lệnh chỉ giải mã.
- Lấy mẫu `nvidia-smi dmon -s u` + `typeperf` % CPU.
- (Tuỳ chọn, người dùng tự bật/tắt) Đo một lượt với thư mục tạm được loại trừ khỏi Windows Defender, để biết chi phí quét hàng nghìn file khung.

**0.2 Bộ đo `npm run bench:export`.**
- Khôi phục từ `git show 1bb3be8:tests/scripts/bench_export.js`, cập nhật theo payload hiện tại (`timeline_json`/`editing_json`/`transition_frames`/`export_settings`, `index.html:15735-15837`). Đăng ký lại script trong `package.json`, không đưa vào chuỗi `test`.
- Hai chế độ đo:
  - (a) phát lại FormData thật đã ghi lại (có cả `transition_frames`) vào `/api/export-video`, trên server riêng (`CRAB_TEMP_DIR`, `CRAB_CONCAT_CACHE_DIR`, `BACKEND_PORT=8123`);
  - (b) một lượt chạy thật trong renderer (`performVideoExport`) để đo từ lúc bấm tới khi có file và phần vẽ trước. Đo trong Electron thật, cửa sổ ghim trên cùng.
- Fixture:
  1. "Bin Tom - Tap 3.crab" (HLG → H.264 đã chuẩn hoá);
  2. clip xoay được `-c copy`: SDR HEVC 8-bit + H.264 `rotate=90`;
  3. bản nối `-c copy` nhiều nguồn;
  4. bản nối cũ còn mốc video 0,021 s, và bản nối không có tiếng;
  5. nguồn 60p và 29,97 VFR;
  6. "phụ đề dài" 5–10 phút, ~100 lớp phủ tĩnh, có ảnh JPEG;
  7. "hiệu ứng nặng": lớp Điều chỉnh LUT, keyframe scale/opacity, mặt nạ, zoom 397% và ~120%, clip/lớp phủ ở toạ độ lẻ, clip 0 khung và clip ngắn, batch cắt giữa clip, 3 chuyển cảnh;
  8. một lượt export ProRes.
  - Nguồn lavfi chỉ giữ làm ca kiểm nhanh.
- ≥ 3 lượt mỗi cấu hình, lấy trung vị.

**0.3 Bộ so chất lượng** (theo quyết định đã chốt) — `tests/scripts/export_fidelity.js`.
- **Bản chuẩn** cho mỗi fixture: cùng đồ thị nhưng chạy ở độ chính xác cao (16-bit, ví dụ `gbrp16`/`yuva444p16`) → `gold_*.mkv` (FFV1).
- **Tiêu chí:**
  - (a) khoảng cách của bản mới tới bản chuẩn (PSNR/SSIM, so trong RGB `gbrp` cùng ma trận) không tệ hơn của bản cũ;
  - (b) mới so với cũ: VMAF ≥ 95, PSNR ≥ 45 dB, và mỗi khung PSNR ≥ 38 dB;
  - (c) cùng số khung, cùng thời lượng;
  - (d) soát riêng khung ở mọi điểm nối và khung đầu/cuối của mọi lớp phủ.
- Bản cũ và bản mới phải dựng bằng **cùng một binary ffmpeg**. Khi sang Bước 2, lập trước một mốc "binary mới + sidecar cũ", vì 2.917 commit upstream có đổi swscale.
- Tiếng: so PCM, chỉ yêu cầu khớp tuyệt đối khi binary và chuỗi tiếng không đổi.
- Số đo vi mô đã chạy thử theo tinh thần này: lớp phủ `yuv420` so với đường cũ cho SSIM 0,9988, PSNR 48,7. Đường nhanh cho clip cho PSNR 48,7, VMAF 97,1, SSIM 0,9932; phần chênh SSIM đến từ dither khi hạ 10→8-bit, cùng xuất phát 8-bit thì SSIM là 0,9968.

**0.4 Ghi quyết định** vào chính file này (bảng "Quyết định đã chốt"), theo quy ước dự án. Bảng số nền ghi vào `docs/APP_INTERNALS.md`.

**0.5 Điều kiện chuyển tiếp:**
- Có bảng số nền (tổng, vẽ trước, tải lên, server, giải mã, filter, encode, % CPU/GPU) cho mọi fixture.
- Xếp lại thứ tự Bước 1 theo số đo.
- Quyết định có làm nhánh 1B không (ngưỡng 30%).

---

# BƯỚC 1 — Sửa cách sidecar dựng lệnh (ffmpeg có sẵn, chưa cần fork)

**Cách làm chung:**
- Sửa `native/sidecar/core_process.cpp`, build bằng `npm run build:sidecar`, commit cả `core_process.exe`.
- Mỗi mục có env tắt riêng. Chỉ bật mặc định khi qua 0.3 và test hồi quy.
- **Thứ tự đề xuất:** 1.0 → 1.6 → 1.7 → 1.3 + 1.5 → 1.4 → 1.10 → 1.1 → 1.2 → 1.8 → 1.9. Số đo Bước 0 có quyền đảo thứ tự này.
- **Giữ nguyên nguyên tắc `-reinit_filter 0`**: chỉ `scale` tự cấu hình lại theo từng khung (`vf_scale.c:757-811`). Mọi chuỗi phải mở đầu bằng một `scale` cố định cỡ + định dạng, trước các filter như `crop`, vốn cố định cỡ lúc cấu hình (`vf_crop.c:250-310`).

**1.0 Một `[0:v]` + `split`** (#4, không đụng mốc thời gian). Env: `CRABBYCUT_EXPORT_SPLIT=0`.
- Thay N lần tham chiếu `[0:v]` bằng một lần `[0:v]split=N`.
- Autorotate chỉ chèn một `transpose`, chỉ còn một buffersrc.
- Thêm `-threads 1` cho input ảnh đơn.

**1.6 Dẹp filter tính biểu thức từng điểm ảnh** (#6, làm trước 1.5 vì `geq` r/g/b chỉ nhận GBR(A)P, `vf_geq.c:266, 364-374`).
- Keyframe opacity: `geq` → `colorchannelmixer=aa=…` (rgba) hoặc `lut=c0=val:c1=val:c2=val:c3='val*k'` (yuva) + `sendcmd` cờ `[expr]`.
  - Hai filter này nhận lệnh lúc chạy (`vf_colorchannelmixer.c:462-506`, `vf_lut.c:573-605`).
  - Phải ghi đủ `c0..c2=val`: thành phần bỏ trống mặc định là `clipval`, sẽ kẹp Y về 16–235 và U/V về 16–240 (`vf_lut.c:89-99, 267-274`).
  - Theo khuôn `ColorAdjustLutBlend` (`:1885-1909`): `sendcmd` đứng trước, lệnh nằm trong file.
- Feather (`:2574`): ảnh dốc mép sinh sẵn một lần → `blend=multiply` + `alphamerge`.
- `scale:eval=frame` chỉ dùng trên đoạn thực sự biến thiên.

**1.7 Ảnh tĩnh giải mã một lần** (#7). Env: `CRABBYCUT_EXPORT_STILL1=0`.
- Chỉ áp cho lớp phủ thực sự tĩnh: `!OverlayIsTimeVarying` **và** không có `LOCALT` trong `adjustFilters`/`adjustFiltersPost`.
  - `OverlayIsTimeVarying` (`:2315-2328`) hiện không kiểm hai trường này, khác với `IntervalIsTimeVarying` (`:2298-2301`). Đây cũng là lỗi tiềm ẩn khi cắt batch; sửa luôn.
- Nạp đúng 1 khung, `setpts=<start>/TB` (giữ kiểu cắt cụt, không đổi sang làm tròn), `eof_action=repeat`.
- Mốc cuối của `enable` = `end − 0.5/renderFps`, đối xứng với `seqEndTrim` (`:2601-2608`).
  - Hiện nay khung cuối của lớp phủ lúc có lúc mất, vì ảnh chạy 25 fps và framesync coi nó đã hết ở khung ảnh cuối + 1 tick (`framesync.c:238-266`).
  - Thêm test biên. Chấp nhận lệch với bản tham chiếu ở khung cuối lớp phủ, vì chính bản tham chiếu sai ở đó.
- Chữ đã được bake đúng cỡ hộp chữ (`editing-runtime.js:17437-17447`), không cần cắt khung bao.

**1.3 Đường nhanh YUV cho clip lane chính "thường"** (#2, lợi lớn nhất đã đo). Env: `CRABBYCUT_EXPORT_FASTPATH=0`.
- Điều kiện:
  - không keyframe, hoạt ảnh, xoay, opacity < 1 hay mặt nạ video (flip vẫn được);
  - **và** mọi độ dời crop/pad là số chẵn: 4:2:0 làm tròn toạ độ xuống số chẵn (`vf_pad.c:196-197`), còn đường RGBA đặt được ở mọi số nguyên (`vf_overlay.c:89-105`).
  - Toạ độ lẻ thì giữ đường cũ.
- Chuỗi: `scale` (cố định) → `crop` phần tràn khung → `pad` phần thiếu → `format=yuv420p`. Bỏ nền `color` + `format=rgba` + `overlay`.
- Giữ chắc số khung: `tpad=stop=-1:stop_mode=clone,tpad=stop=-1:stop_mode=add,trim=end_frame=N`. Một `tpad=stop_mode=clone` đơn không ra khung nào nếu clip cho 0 khung (`vf_tpad.c:180-183`); lúc đó mọi clip phía sau bị xô lệch. Nền `color` hiện nay là thứ đang giữ số khung (`:2051-2053`).

**1.5 Ghép lớp phủ ở YUV** (#3). Env: `CRABBYCUT_EXPORT_YUVCOMP=0`.
- `overlay=format=yuv420`, lớp phủ `format=yuva420p`, luồng chính giữ `yuv420p`. Có SIMD SSE4.1 `ff_overlay_row_20`.
- Đã đo: `yuv444` chậm nhất (3,78 s), vì ffmpeg chọn `yuva444p` cho luồng chính nên mất SIMD (`x86/vf_overlay_init.c:43-46`).
- Chuẩn hoá mỗi lớp phủ về `scale=out_color_matrix=bt709:out_range=tv` trước `overlay`. `overlay` ép một không gian màu, dải và kiểu alpha chung cho mọi đầu vào (`formats.c:1170-1216`), và từng kéo cả luồng chính theo ảnh JPEG (`:1657-1670`).
- **Toạ độ lẻ:** `yuv420` cũng làm tròn x/y xuống số chẵn. Để giữ đúng vị trí: đệm 1 px trong suốt ở RGBA (lúc lớp phủ còn nhỏ), đổi sang `yuva420p`, rồi đặt ở toạ độ chẵn x−1 / y−1.
- Giữ RGBA ở chuỗi mặt nạ (`alphaextract`/`blend=multiply`/`alphamerge`).
- ProRes (`yuv422p10`, `:1653-1655`) dùng `yuv444p10`/`yuva444p10` để khỏi rơi xuống 8-bit.
- Chấp nhận khác biệt nhỏ ở vùng rất bão hoà hoặc dưới mức đen: đường cũ kẹp theo gam RGB, đường mới thì không. Bộ so 0.3 (so trong RGB, so với bản chuẩn) sẽ phân xử.

**1.4 Cắt trước khi scale khi phóng to; chỉnh màu sau khi thu nhỏ** (#5).
- Chỉ bật khi zoom ≥ ~1,3×.
- Cắt trên lưới tỉ lệ rút gọn của W'/iw (W' = ceil(iw·s/2)·2, `:2132-2133`), chừa lề ≥ 4 px, rồi cắt chính xác lần nữa sau `scale`. Lý do: cắt trước thay đổi vị trí lấy mẫu của swscale.
- "Màu sau khi thu nhỏ" chỉ khi chuỗi màu gồm phép từng điểm ảnh (`eq`/`colorbalance`/`curves`/`lut3d`), không mặt nạ.
  - Loại `unsharp`/`avgblur`/`noise`: tham số của chúng tính theo điểm ảnh, `color-adjust.js:535-555`.
  - Loại `vignette`: hình học của nó tính theo khung đã cắt.

**1.10 (tuỳ số đo) Gộp chuỗi màu tĩnh thành một LUT** (bake `eq`+`colorbalance`+`curves`+`lut3d` → cube 33³). Kiểm bằng `test:color-adjust` + 0.3.

**1.1 Chỉ giải mã đoạn được dùng** (#1). Env: `CRABBYCUT_EXPORT_SEEK=0`.
- Mỗi dải nguồn là một input `-itsoffset S -ss S -i source`, **không** có `-t`.
  - Khi đó `ts_offset = input_ts_offset − (S + start_time) = −start_time`, đúng bằng hôm nay (`ffmpeg_demux.c:2499`). Mốc thời gian của khung giữ nguyên từng bit, nên **mọi giá trị `trim` dùng lại nguyên vẹn**.
  - `trim` tự chèn chỉ bỏ pts < 0. Việc giải mã tự dừng khi mọi `trim` trên input đó đã đóng.
- Gom dải: gộp khi chồng lấn hoặc cách < ~2 s; tối đa ~12 dải (gộp các khe nhỏ nhất trước).
  - Mọi bộ giải mã khởi động cùng lúc (graph chỉ cấu hình khi mọi input đã có khung, `ffmpeg_filter.c:617-625, 3150-3163`), nên phải tính VRAM/RAM cho cả N.
  - Đặt `-threads` vừa phải cho mỗi dải.
- Giữ chỉ số input ổn định:
  - input 0 = nguồn không seek (chỉ dùng `[0:a]`, tiếng không seek);
  - lớp phủ giữ `1+assetInputIndex`;
  - dải nối **sau** lớp phủ;
  - dùng `ShortInputPath` (trần dòng lệnh 32.766, `:158`);
  - mỗi input dải mang `-reinit_filter 0`.
- Chỉ bật cho: một nguồn, bản nối đã chuẩn hoá, hoặc bản nối có extradata giống nhau (`ffprobe -show_data_hash`). Lý do: seek vào đoạn 2 trở đi của bản nối `-c copy` có thể thiếu SPS/PPS (`concatdec.c:180-188`). Ngoài các ca đó chỉ dùng 1.0.
- Áp tương tự cho video lớp phủ (hiện giải mã từ 0, `:2617, 2964`). Tiếng của chúng dùng chung seek khi S ≤ sourceStart − 2 khung AAC.
- ⚠️ Bắt buộc qua `test:seam`, `test:frame-grid`, `test:sequence-fps`, `test:clip-speed`, `test:main-lane-concat` + soát khung ở điểm nối.

**1.2 Giải mã phần cứng** (hạ ưu tiên theo số đo). Env: `CRABBYCUT_HWACCEL_DECODE=0`.
- Chỉ cho nguồn/lớp phủ HEVC, 10-bit, hoặc độ phân giải cao được `-c copy`. Với H.264 8-bit đã chuẩn hoá thì NVDEC chậm hơn CPU.
- `-hwaccel cuda` (NVIDIA) hoặc `d3d11va` (GPU khác), không đặt `-hwaccel_output_format`.
- Dò chức năng trước và cache:
  - codec không có hwaccel thì lùi về phần mềm êm (`ffmpeg_dec.c:1328-1376`);
  - máy không có thiết bị CUDA thì **dừng hẳn** (`:1598-1604`).
- Có `scale` đứng đầu chuỗi để hấp thụ nv12/p010.
- Có dải thì thử giải mã lai: dải chia cho cả NVDEC lẫn CPU.

**1.8 Song song hoá** (#9, làm sau cùng, chỉ bật nếu dự án trọn vẹn lợi ≥ 15%). Env: `CRABBYCUT_EXPORT_PARALLEL=0|N`.
- **Chuỗi filtergraph** (`ifilter_bind_fg`, có từ FFmpeg 7.1):
  - Kỳ vọng 1,2–1,6×. Hàng đợi vào của graph sau chỉ 2 khung, dùng chung cho mọi input, không nới được (`ffmpeg_sched.c:372-392`).
  - `-filter_complex_threads` ≈ 16/số tầng.
  - `sendcmd` ở chung graph với `blend@tag` của nó; `movie=` ở chung graph với nơi dùng.
  - Mỗi tầng kết thúc bằng đúng định dạng tầng sau cần. Không tách riêng tầng chuyển màu cuối.
- **Nhiều tiến trình:**
  - Ưu tiên cắt ở biên clip: `SplitIntervalAtFrame` (`:2350-2359`) khởi động lại `setpts`/`fps` của nửa sau, có thể chọn khung nguồn khác khi nguồn VFR.
  - `ExportBatch` chưa an toàn khi chạy đồng thời (biến toàn cục `g_filterAuxDir`/`g_filterAuxSeq` `:1882-1883`, và `plan` bị đổi tại chỗ `:3057-3060`). Ghi mọi script trước rồi mới spawn.
  - Lỗi phiên NVENC: thử lại batch đó bằng NVENC sau khi các batch khác xong, rồi mới chuyển mọi batch sang CPU. GeForce giới hạn số phiên, dùng chung với OBS/ShadowPlay; GTX 1060 chỉ có một bộ NVENC.
  - Cho dự án không lớp phủ đi đường VideoOnly + một lượt AudioOnly. Việc này sửa luôn khoảng hở AAC ở mối nối của đường 80 interval (`:3356`).
- Bỏ `+faststart` ở file batch trung gian (chỉ có ích khi có nhiều batch).

**1.9 Chọn encoder bằng dò chức năng** (sửa lỗi cho máy không NVIDIA).
- Mã hoá thử 0,1 s theo thứ tự `h264_nvenc → h264_qsv → h264_amf → libx264`.
- Cache ở `%LOCALAPPDATA%\CrabbyCut\encoder-probe.json`, theo {hash `ffmpeg -version`, GPU, driver}.
- Không đổi tham số NVENC.

**Tương thích nhánh macOS:** phần riêng Windows (`-hwaccel`, `CreateProcessW`) gói sau `#ifdef _WIN32` hoặc sau phép dò; phần trung lập viết để `git apply` sang `CrabbyCut_Private` được.

**Điều kiện chuyển tiếp:** có bảng A/B từng mục; mọi fixture qua 0.3; toàn bộ test export xanh.

---

# NHÁNH 1B — Bước vẽ trước trong Electron (chỉ làm nếu Bước 0 đo được ≥ 30% tổng thời gian)

- Chuyển cảnh: thay tua-từng-khung + `setTimeout(50)` (`editing-runtime.js:18057-18097, 18330-18441`) bằng `play()` + `requestVideoFrameCallback` hoặc WebCodecs. Map đúng lưới khung; hướng này đã ghi ở `APP_INTERNALS.md:1364-1367`.
- Dùng lại một canvas thay vì tạo mới mỗi khung. Mã hoá trong worker (`OffscreenCanvas.convertToBlob`). Chạy song song các chuyển cảnh độc lập.
- Chữ động: bỏ `toDataURL` đồng bộ + base64 trong `editing_json` (`17512-17682`), chuyển sang blob nhị phân như `transition_frames`.
- Bắt buộc qua `test:transition-frames`, `test:transitions-measured`, `test:bokeh-swing`, `test:echo-shift`, `test:retouch-export` + 0.3.

---

# BƯỚC 2 — Tự build ffmpeg từ repo này, đo điểm nóng, vá đúng chỗ

**2.1 Hạ tầng build.** Nhánh `crabbycut/perf` tách từ `master` trong `E:\Dev\Windows_App\ffmpeg`. Mỗi bản vá là một commit theo chuẩn FFmpeg.
- **Đường dev/đo**: MSYS2 CLANG64 (clang, lld, nasm, pkgconf + ffnvcodec-headers, libass, freetype, harfbuzz, fribidi, fontconfig, zimg, libplacebo, vulkan, shaderc, x264, x265).
  - PDB (`-gcodeview -Wl,--pdb=`) cho WPA/AMD uProf.
  - Không dùng MSVC: mất inline asm, tức mất đường CABAC nhanh của H.264.
  - Cài MSYS2: hỏi người dùng lúc làm.
- **Đường phát hành**: fork `BtbN/FFmpeg-Builds`, chạy trên Docker Desktop.
  - `./makeimage.sh win64 gpl` rồi `./build.sh win64 gpl`, với `FFMPEG_REPO`/`GIT_BRANCH` trỏ vào `crabbycut/perf` (đã kiểm: `build.sh` đọc hai biến này và `git clone` bên trong container).
  - Addin `debug` chỉ dùng cho bản đo.
  - **Ghim nv-codec-headers `sdk/13.0`** (sửa `scripts.d/50-ffnvcodec.sh`, commit `ced4f8eb`).
  - Ra đúng bố cục zip mà `setup_runtime.js:504-521` giải nén.

**2.1b Bản vá tương thích ngược — BẮT BUỘC, là commit đầu tiên của nhánh `crabbycut/perf`.**
- **Vì sao:** nhánh fork tách từ master, mà master đã xoá `-filter_complex_script` (commit `07407fff61`, vào master 2026-06-23). Mọi bản CrabbyCut phát hành trước Bước 0A đều export bằng tuỳ chọn này (`core_process.cpp:2974`, `server.js:3800`, `subtitle-jobs.js:308`; bản Private: `core_process.cpp:3001`, `server.js:3890`, `subtitle-jobs.js:259`). Nếu bản ffmpeg mới lọt vào máy đang chạy CrabbyCut cũ, export sẽ hỏng ngay ("Unrecognized option"). Có hai đường lọt: người dùng tự chép vào PATH, hoặc bản cũ cài lại runtime.
- **Làm gì:** khôi phục đúng phần `ffmpeg_opt.c` mà `07407fff61` đã xoá, làm **bí danh** của `-/filter_complex`. Cụ thể là hàm `opt_filter_complex_script`, đọc file bằng `read_file_to_string` rồi `GROW_ARRAY(go->filtergraphs, …)`, cùng mục `{ "filter_complex_script", OPT_TYPE_FUNC, OPT_FUNC_ARG | OPT_EXPERT, … }` trong bảng `options[]`.
  - Bỏ điều kiện `#if FFMPEG_OPT_FILTER_SCRIPT`, để tuỳ chọn luôn có.
  - Giữ cảnh báo "deprecated, use -/filter_complex", nhưng in ở mức `AV_LOG_VERBOSE` thay vì `WARNING`: CrabbyCut cũ chạy `-v error` nên không ảnh hưởng, còn log gỡ lỗi vẫn thấy.
  - Không cần khôi phục `-filter_script` (theo từng luồng) và các phần ở `ffmpeg_mux_init.c` / `ffmpeg.h` của commit đó: CrabbyCut chưa bao giờ dùng `-filter_script` (đã grep toàn bộ repo public + Private).
- **Rà các tuỳ chọn khác đã bị xoá** trong master kể từ bản BtbN tháng 4 (`git log 6c114bd6fa..HEAD -- fftools/`): `-vsync`, `-top`, `-qphist`, `-thread_queue_size` (input), `adrift_threshold`. Mã ứng dụng CrabbyCut không dùng cái nào, chỉ test `overlay_placement_contract.js:42` dùng `-vsync`. Khi rebase nhánh fork lên master mới hơn, lặp lại phép rà này, và khôi phục bí danh cho bất kỳ tuỳ chọn nào mà một bản CrabbyCut đã phát hành còn dùng.
- **Kiểm chứng:**
  - (a) chạy `core_process.exe` của bản CrabbyCut đã phát hành gần nhất trước Bước 0A (lấy từ bộ cài cũ) với bản ffmpeg fork: `test:export` và `test:export-long-subtitles` phải xanh;
  - (b) `ffmpeg -filter_complex_script <file>` và `ffmpeg -/filter_complex <file>` phải cho đầu ra giống hệt từng bit (`-f framemd5`);
  - (c) thêm một test FATE nhỏ cho tuỳ chọn này, để lần rebase sau không lặng lẽ làm mất nó.
- Đây là bản vá **chỉ giữ trong fork**, không gửi upstream (upstream đã chủ ý xoá). Ghi rõ trong commit message.

**2.2 Bản vá đo (chỉ dùng khi dev):** bộ đếm thời gian từng filter trong libavfilter, bật bằng `FFMPEG_FILTER_PROFILE=1` (cộng dồn thời gian `activate` mỗi instance, in bảng khi huỷ graph). Chạy trên filter script thật giữ lại nhờ 0.1.

**2.3 Tối ưu mức build cho Windows** (A/B từng cái, giữ cái lợi ≥ 3%):
- `--enable-w32threads` (SRWLOCK/CONDITION_VARIABLE, `compat/w32pthreads.h`) thay winpthreads;
- clang so với gcc;
- LTO;
- zlib-ng (compat) thay madler/zlib mà BtbN đang dùng (`scripts.d/20-zlib.sh`), để giải nén PNG nhanh hơn.
- Không nâng `-march`.

**2.4 Vá theo điểm nóng đo được** (xếp lại theo số):
1. **Filter lớp phủ hợp nhất**: lớp YUVA/RGBA + biểu thức theo thời gian cho scale/rotate/x/y/opacity. Lấy mẫu song tuyến, trộn **một lượt** vào vùng bao; slice-thread + AVX2; đặt được ở toạ độ lẻ.
   - Thay chuỗi `rotate → scale:eval=frame → colorchannelmixer/geq → fade → overlay`.
   - Sidecar chỉ dùng khi `HasFfmpegFilter(...)` báo có, không thì quay về đồ thị Bước 1.
2. **`lut3d` SIMD 8/10-bit** (trilinear + tetrahedral). Init tôn trọng `AV_CPU_FLAG_SLOW_GATHER` trên Zen+. Kèm `checkasm`.
3. **LUT trên GPU**, so hai hướng: `libplacebo lut=` có sẵn (cần `-init_hw_device vulkan` + `-filter_hw_device`; kiểm libplacebo không tự thêm biến đổi màu), và `lut3d_cuda` mới qua `cuda-llvm` (free).
4. Sửa nhỏ gửi upstream được: `x86/vf_overlay_init.c:39` gán `overlay = ctx->inputs[0]` (nhầm); `eq` chưa slice-thread (`vf_eq.c:344`); bản AVX2 cho `ff_overlay_row_*` (hiện chỉ SSE4.1).
5. fftools mở/đóng bộ giải mã theo kiểu lười cho input nhiều dải (khi 1.1/1.2 bị VRAM chặn).
- Mỗi bản vá cần: FATE (filter mới có ref), A/B, qua 0.3.

**2.5 Phát hành bản riêng** (thay Gyan 8.1.1 của Bước 0A):
- chỉ phát hành bản build có bản vá 2.1b và đã qua phép kiểm với sidecar của bản CrabbyCut cũ;
- ghim phiên bản + SHA-256;
- `RUNTIME_SCHEMA`;
- sidecar gọi đường dẫn tuyệt đối do backend truyền vào, để tránh `ffmpeg.exe` lạ trong thư mục làm việc thắng PATH;
- cập nhật `generate_third_party_notices.js:148-162` + README;
- GPL: công bố mã nhánh fork; đăng công khai sẽ hỏi người dùng trước.

---

# Kiểm chứng

1. **Tốc độ**: `npm run bench:export` (≥ 3 lượt, trung vị). Báo từ-lúc-bấm, vẽ trước, server, ffmpeg. Mục tiêu ≥ 2× trên "Bin Tom" và fixture phụ đề dài.
2. **Chất lượng**: `tests/scripts/export_fidelity.js` theo 0.3.
3. **Hồi quy**: `npm run test:export`, `test:export-many-overlays`, `test:export-color`, `test:export-long-subtitles`, `test:sequence-fps`, `test:seam`, `test:frame-grid`, `test:overlay-placement`, `test:video-mask`, `test:video-anim`, `test:position-keyframe`, `test:color-adjust`, `test:adjust-layer`, `test:clip-speed`, `test:mixed-orientation`, `test:retouch-export`, `test:transition-frames`, `test:main-lane-concat`, `test:unicode-path`.
   - Chạy khi app/backend **đang tắt** (bẫy `core_c.node` EPERM).
   - Xong thì khôi phục `progress.txt`.
4. **Máy không NVIDIA**: `FFMPEG_EXPORT_HW=0` + `CRABBYCUT_HWACCEL_DECODE=0` phải đúng và không chậm hơn số nền CPU; `d3d11va` thử được ngay trên máy này.
5. **Soát đồ thị**: `-print_graphs_file` xác nhận không có bộ chuyển đổi tự chèn giữa các `overlay` liên tiếp, và định dạng/dải màu đúng như thiết kế.
6. **Bước 2**: `make fate` cho các nhóm filter bị đụng, `checkasm`, rồi chạy lại 1–5 với bản ffmpeg riêng.
7. **Tương thích ngược**: sidecar của bản CrabbyCut phát hành trước Bước 0A phải export được với bản ffmpeg riêng (mục 2.1b). Chiều ngược lại cũng phải đúng: sidecar mới chạy trên ffmpeg cũ phải tự quay về lệnh thường nhờ dò tính năng.
8. Ghi quyết định + bảng số vào `docs/` (quy ước dự án).

## Ngoài phạm vi (ghi lại để không làm trùng hoặc bỏ sót)
- 1.9 thay phần "probe encoder" trong Đợt 6 của `KE_HOACH_TOI_UU_VA_BOOTSTRAP_WIN.md` (commit `91e768c`). Hai phần còn lại của Đợt 6 không nhắm vào tốc độ export:
  - proxy preview toàn GPU (NVDEC + `scale_cuda` + NVENC) — dùng chung phép dò của 1.2;
  - tham số NVENC theo chất lượng.
- Bước chuẩn hoá lúc nhập (libx264 veryfast) ảnh hưởng thời gian **nhập**, không ảnh hưởng thời gian export.

## File chính sẽ sửa
- `CrabbyCut/native/sidecar/core_process.cpp`: `WriteClipVideoFilters`, `WriteVisualOverlayFilter`, `AppendKfTransformFilters`, `AppendFeatherAlpha`, `AppendOverlayInputArgs`, `WriteFilterScript`, `ExportBatch`, `CommandExportVideo`, `PlanOverlayBatches`, `OverlayIsTimeVarying`, `SelectEncoderPlan`.
- `CrabbyCut/backend/server.js` (báo cáo, đo thời gian, `-/filter_complex`), `backend/subtitle-jobs.js`, `index.html` (mốc thời gian).
- `CrabbyCut/scripts/setup_runtime.js`, `runtime_paths.js`, `generate_third_party_notices.js`.
- `CrabbyCut/tests/scripts/bench_export.js` (khôi phục), `export_fidelity.js` (mới), `overlay_placement_contract.js`.
- (1B) `CrabbyCut/static/js/editing-runtime.js`.
- ffmpeg, nhánh `crabbycut/perf`: `fftools/ffmpeg_opt.c` (bí danh `-filter_complex_script`, mục 2.1b), `libavfilter/` (profiler, filter lớp phủ hợp nhất, `vf_lut3d` + `x86/`, `x86/vf_overlay_init.c`).
