# Kế hoạch: Xuất video CrabbyCut nhanh ≥ 2× trên Windows và macOS — sửa lệnh ffmpeg + tự build ffmpeg

> **Trạng thái: ĐANG TRIỂN KHAI — Bước 0A** (bắt đầu 2026-09-27). Lập và lưu ngày 2026-09-26.
> - 0A mục 1–5 **đã làm**, chưa commit.
> - Đã chạy: 21 test export trên Gyan 8.1.1, nhóm test con trên BtbN tháng 4 và BtbN `latest`, thử bộ cài trên runtime sạch.
> - Còn mục 6: phát hành + port sang `CrabbyCut_Private`, chờ người dùng quyết.
> **Bổ sung 2026-09-27:**
> - ca thật thứ hai (phụ đề song ngữ 39 phút, 4K AV1, xuất mất ~49 phút) kèm số đo;
> - phát hiện mục 1.7 cũ gây hại, nên đã viết lại;
> - lỗi treo `concat` + video lớp phủ có sẵn trong bản hiện tại;
> - thêm các mục 1.11–1.14, phần macOS (Bước M), phần máy không có GPU, và đối chiếu Premiere/Resolve/After Effects/CapCut.
> - Tên file giữ `_WIN` để không gãy các tham chiếu cũ, dù nay phủ cả macOS.
> - Lập trong phiên nghiên cứu ở repo `E:\Dev\Windows_App\ffmpeg` (clone upstream FFmpeg master `8864fd0aec`).
> - Mọi số dòng đã được kiểm trên mã nguồn tại thời điểm lập. Nếu mã đã đổi, kiểm lại trước khi làm theo.
> - Mọi con số "Đo" là đo thật trên máy dev: Ryzen 7 2700X + GTX 1060, driver 582.28.
>
> **Thứ tự thi công:** Bước 0A (bản vá gấp, phát hành riêng) → Bước 0 (đo + bộ so chất lượng) → Bước 1 (→ nhánh 1B nếu đạt ngưỡng) → Bước 2. Bước M (macOS) chạy song song từ Bước 1, dùng chung mã sidecar.

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

**Mục tiêu:** thời gian từ lúc bấm Xuất tới khi có file giảm **≥ 2×** trên các dự án mẫu (trung vị của ≥ 3 lượt), **trên cả Windows lẫn macOS**. Tận dụng tối đa GPU khi có; máy không có GPU vẫn được tối ưu. Bản xuất "giống bằng mắt" theo tiêu chí ở 0.3. Máy không có NVIDIA vẫn cho kết quả đúng và không chậm đi.

## Quyết định đã chốt với người dùng (2026-09-26)

| Vấn đề | Lựa chọn |
|---|---|
| Phạm vi | Bước 1 sửa cách sidecar dựng lệnh ffmpeg. Bước 2 tự build ffmpeg từ repo này, đo điểm nóng rồi vá đúng filter chậm |
| Phần cứng | NVIDIA trước (NVDEC/NVENC/CUDA), CPU dự phòng (thêm D3D11VA vì miễn phí trên Windows) |
| Chất lượng | Giống bằng mắt. Kiểm tự động bằng cách so với **bản chuẩn độ chính xác cao**: bản mới phải gần bản chuẩn ít nhất bằng bản cũ; cộng thêm VMAF(mới so với cũ) ≥ 95, PSNR ≥ 45 dB, và ngưỡng cho khung tệ nhất. Thay cho ngưỡng SSIM ≥ 0,995 ban đầu, vì số đo cho thấy ngưỡng đó đánh trượt cả thay đổi chính xác hơn |
| Bước vẽ trước trong Electron | Đo trước. Nếu chiếm ≥ 30% tổng thời gian trên dự án thật thì làm nhánh 1B |
| Bản ffmpeg dùng | Luôn dùng bản ghim phiên bản. ffmpeg hệ thống chỉ dùng khi bản ghim hỏng |
| Hai hồi quy do ffmpeg "latest" | Phát hành **bản vá riêng ngay** (ví dụ v1.1.13), trước mọi tối ưu; port sang `CrabbyCut_Private` |
| Nền tảng (2026-09-27) | Tối ưu cho **cả Windows lẫn macOS**. Tận dụng tối đa GPU (giải mã, mã hoá, và ghép khi được); máy không có GPU vẫn phải được tối ưu |
| Cách xuất phụ đề (2026-09-27) | **Gom mỗi track phụ đề/chữ tĩnh thành MỘT luồng ảnh** từ chính các PNG do trình duyệt bake (giữ đúng hình như preview), thay cho hàng trăm lớp `overlay`. Không dùng libass (mục 1.11) |
| Độ phân giải xuất (2026-09-27) | Ô "Độ phân giải" trong hộp thoại xuất **có tác dụng thật** (Theo sequence / 1080p / 720p), không còn bị sequence đè (mục 1.12) |
| Bộ nhớ đệm render (2026-09-27) | **Có**, kiểu "render cached images" của Resolve / "use previews" của Premiere. Làm **sau** các tối ưu chính (mục 1.13) |
| macOS (2026-09-27) | Mac cũng **dùng bản ffmpeg ghim riêng** (không dựa vào Homebrew). Bỏ lượt xuất thứ hai khi lỗi treo đã được tránh. Người dùng tự chạy bộ đo trên máy Mac của họ (Bước M) |

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
| 7 | **Ảnh tĩnh giải mã lại mỗi khung** (`-loop 1 -t`). **Đo** (PNG 500×500 hiện 20 s): 3,09 s, so với 2,52 s khi nạp một khung + `yuv420`. ⚠️ Con số này chỉ đúng với **một** lớp phủ: với chuỗi 85 lớp phủ, cách "một khung + `eof_action=repeat`" tụt còn **8 khung/s** (xem "Ca thật 2") | `:2957-2962` |
| 12 | **Chuỗi lớp phủ: lớp đang TẮT vẫn chép cả khung chính.** `do_blend` gọi `ff_framesync_dualinput_get_writable` (`vf_overlay.c:854`), hàm này chép khung cho ghi được (`framesync.c:417`) **trước khi** xét `is_disabled`/`!second` (`vf_overlay.c:857`, `framesync.c:403`). Framesync còn giữ tham chiếu khung chính (clone), nên khung không bao giờ "ghi được" và mọi lớp phủ trong chuỗi đều chép lại. **Đo** ở 4K: mỗi lớp phủ tắt tốn ~1,2 ms/khung; 10 lớp tắt → 61 khung/s, 30 lớp tắt → 23 khung/s (1 lớp: 200) | `vf_overlay.c:845-889`; `framesync.c:390-424` |
| 13 | **Batch sau giải mã lại từ đầu.** Dự án dài có lớp phủ bị chia batch ~180 s (`kOverlayBatchTargetSeconds`), chạy tuần tự. Mỗi batch mở nguồn bằng `-i` không seek, nên batch thứ k giải mã từ giây 0 tới 180·k. Tổng lượng giải mã tăng theo cấp số cộng | `core_process.cpp:2280-2284, 3042-3046, 3274-3282` |
| 8 | `lut3d` 8-bit trilinear là C thuần (SIMD chỉ có cho tetrahedral float/16-bit) | `x86/vf_lut3d_init.c:67-89` |
| 9 | Chạy nối đuôi. **Đo**: song song 2–4 tiến trình chỉ lợi ~10% (CPU bão hoà hoặc chạm trần NVDEC). Đáng làm sau khi đã giảm việc | `core_process.cpp:3274-3299` |
| 10 | Bản SDR của video HDR làm lớp phủ được mã hoá lại **toàn bộ** ngay trong lúc export, nếu chưa có trong cache | `server.js:2289-2372` |
| 11 | **Vẽ trước trong Electron** (ngoài ffmpeg, chưa được đo): tua `<video>` full-res mỗi khung + `setTimeout(50)` + canvas mới + `toBlob`, tuần tự | `editing-runtime.js:18057-18097, 18330-18441, 17512-17682` |

**NVDEC:** trên H.264 8-bit nó **chậm hơn** giải mã CPU (1,31 s so với 1,00 s), chỉ bớt ~3 giây-CPU. Trên HEVC Main10 nó bằng tốc độ CPU nhưng tốn ít CPU hơn ~72%. Vì vậy NVDEC chỉ đáng dùng cho nguồn HEVC/10-bit/độ phân giải cao được `-c copy`.

## Ca thật 2 — phụ đề song ngữ 39 phút (đo 2026-09-27)

**Dự án:** `G:\Work\AI\Test CrabbyCut\Auto Subtitle\Forever Inside - Sci-Fi Short Film_Test Auto Subtitle.crab`.
- Nguồn `Forever Inside - Sci-Fi Short Film.mp4`: **AV1 3840×1646, 24 fps**, 2.364,9 s. Nguồn SDR `.mp4` một file nên được `-c copy` vào `temp_input.mp4`, tức export giải mã **AV1 4K**.
- Sequence "source" 3840×1646 @ 24 fps; 1 clip lane chính dài 2.364,8 s (**56.757 khung**).
- **1.116 lớp chữ tĩnh** trên 2 track (509 câu `faster_whisper`, song ngữ). Chữ Nunito 88, nền đen 25% bo góc 30, không hoạt ảnh.
- Báo cáo `reports/report_project_20260927_172722.txt`: `h264_nvenc`, quality high, `interval_count 1`, **server 2.964,7 s (~49,4 phút)**, chưa tính bước vẽ trước. Video chỉ dài ~39,4 phút.

**Số đo vi mô trên chính nguồn này** (20 s = 480 khung ở giây 300, xuất ra `-f null`, lấy lượt nhanh nhất trong 2):

| Cấu hình | Thời gian | Giây-CPU | Tốc độ |
|---|---|---|---|
| Chỉ giải mã AV1 (dav1d, CPU; GTX 1060 **không** có NVDEC cho AV1) | 2,02 s | 26,8 | 238 khung/s |
| Đường hiện tại (RGBA 4K + 10 lớp phụ đề kiểu hiện tại), chưa encode | 9,76 s | 111,6 | 49 khung/s |
| Đường nhanh YUV + 10 lớp phụ đề `yuv420`, chưa encode | 5,20 s | 35,0 | 92 khung/s |
| Đường hiện tại + NVENC | 10,83 s | 117,3 | 44 khung/s |
| Đường nhanh + 10 lớp + NVENC | 5,99 s | 40,4 | 80 khung/s |
| NVENC riêng (4K, P1, 39,6 Mb/s) | 2,1 s | ~1–6 | ~225 khung/s |
| **85 lớp phụ đề** (như một batch 180 s), kiểu hiện tại (rgba, `-loop 1`, `trim`, `eof_action=pass`) | 5,06 s | 62,3 | 95 khung/s |
| 85 lớp, kiểu hiện tại nhưng ghép `yuv420` | 3,76 s | 39,6 | 128 khung/s |
| **85 lớp, kiểu mục 1.7 cũ** (1 khung + `eof_action=repeat`) | **58,96 s** | 88,3 | **8 khung/s** |
| **Cả track phụ đề thành 1 luồng ảnh (ffconcat) + 1 `overlay`** | **2,78 s** | 34,3 | **173 khung/s** |

**Chẩn đoán 49 phút:**
1. **Giải mã theo cấp số cộng (#13).** 2.364,8 s chia ~13 batch × 180 s chạy tuần tự, batch k giải mã AV1 4K từ 0 tới 180·k. Tổng ≈ 393.000 khung giải mã cho 56.757 khung dùng (~6,9×). Ở 238 khung/s và đã bão hoà CPU, riêng phần này là ~27 phút.
2. **Đường RGBA ở 4K (#2, #3)** trên mọi khung: ~25 MB/khung RGBA, chuyển đổi và trộn bằng C.
3. **Chuỗi ~85 lớp phủ mỗi batch (#12)**, cộng giải mã PNG mỗi khung (#7).
4. NVENC (~225 khung/s ở 4K) và encode **không** phải nút thắt.

**Ước tính sau khi sửa** (1.1 cho từng batch + 1.3 + 1.11 + 1.5): nút thắt còn lại là giải mã AV1 ~170–230 khung/s. 56.757 khung ≈ **4–6 phút** trên máy này, thay cho ~49 phút (~8–10×). Máy có GPU giải mã AV1 (RTX 30+, RX 6000+, Intel Arc/Xe, Apple M3+) còn nhanh hơn nữa, xem 1.2.

**Rủi ro đang xảy ra** (đã kiểm trong mã nguồn; NVENC đã thử thật một phần):
- **Export có thể TREO VĨNH VIỄN khi có video lớp phủ** (tái hiện 2026-09-27 trên Windows, cả BtbN tháng 4, Gyan 8.1.1 lẫn BtbN master 2026-09-26). **ĐÃ SỬA ở Bước 0A** (xem mục 5 ở đó).
  - Đồ thị đúng dạng sidecar đang dựng treo quá 90 s, 0% tiến triển: lane chính `concat` từ 3 clip trở lên, cộng một **video** lớp phủ (`-i`) vắt qua điểm nối clip.
  - **Nguyên nhân gốc (tìm ra khi thi công 0A, 2026-09-27):** luồng hình của CHÍNH file lớp phủ đổi thông số giữa chừng. Ở file đo, nguồn đổi từ `yuv420p/tv/bt709` sang `yuvj420p/pc/bt470bg` tại 4,3 s; đó là chỗ nối của một bản nối `-c copy` nhiều nguồn, như `concat_cache`.
    - Input lớp phủ không có `-reinit_filter 0` (lane chính thì có), nên fftools dựng lại cả filtergraph giữa lượt, và bộ lập lịch kẹt khi `concat` đang dở.
    - Cùng nội dung nhưng mã hoá lại một file liền (không đổi thông số) thì không treo. Vì vậy mọi phép thử "vắt qua điểm nối" trước đây thực ra là vắt qua **chỗ đổi thông số** của file nguồn, không phải điểm nối của lane chính.
  - Các cách **không** chữa được: bỏ tiếng lớp phủ, chuỗi filtergraph, `[0:v]split` (1.0), mỗi clip một input `-itsoffset/-ss` (1.1), đưa mọi input về trục thời gian timeline.
  - **Cách chữa đã ship:** `-reinit_filter:v 0` trước `-i` của video lớp phủ. Xong trong vài giây trên cả 3 bản ffmpeg, màu đoạn sau chỗ đổi vẫn đúng (test đo).
    - `movie=` cũng chữa được, nhưng không cần nữa: nó mất pipeline giải mã và khác `-i` ở mốc `start_time` lẫn autorotate.
    - Nhánh macOS đã gặp lỗi này và vòng bằng cách xuất **hai lượt** (`CrabbyCut_Private/native/sidecar/core_process.cpp:3397-3432`); M.3 nay chỉ cần port cờ này.
  - Phần còn lại cho upstream (2.4): fftools không nên kẹt khi dựng lại graph giữa `concat`. Nên gửi báo lỗi kèm repro, nhưng hết gấp.
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
2. **Ghim ffmpeg = Gyan 8.1.1 `full_build-shared`** (người dùng chọn 2026-09-27; 101 MB thay cho 252 MB của bản tĩnh): `https://github.com/GyanD/codexffmpeg/releases/download/8.1.1/ffmpeg-8.1.1-full_build-shared.zip`, SHA-256 `4296b396…2d2f45`, tự tính và khớp digest GitHub.
   - Đã thử: có đủ `zscale libplacebo lut3d scale_cuda drawtext sendcmd tpad xfade movie`, hwaccel `cuda d3d11va qsv amf vulkan`, NVENC chạy trên GTX 1060.
   - Hằng số nằm ở một chỗ duy nhất: `scripts/ffmpeg_pin.js`.
3. `setup_runtime.js` + `runtime_paths.js`:
   - bản ghim thắng ffmpeg hệ thống; ffmpeg máy chỉ còn là đường lùi khi không tải được;
   - kiểm SHA-256, cả file còn trong cache;
   - thử gói vừa giải nén (`-version` phải khớp) **trước** khi đè bản đang cài;
   - dấu `runtime/ffmpeg/pin.json` + `pin_id` trong `runtime.json`.
   - **Không tăng `RUNTIME_SCHEMA`** (đổi so với kế hoạch): bump schema là coi cả thư viện AI ~2,5 GB là lệch.
     - Thay vào đó `verifyRuntimeQuick()` trả `ffmpeg_outdated` khi `pin_id` lệch. Manifest đời cũ không có `pin_id` nên cũng được cài lại đúng một lần.
     - `setupRuntime()` giữ nguyên các nhóm thư viện đã cài khi Python được dùng lại.
     - Đổi bản ghim lần sau chỉ cần sửa `ffmpeg_pin.js`.
   - Mất mạng: lùi về bản đã cài trước đó, không có thì về ffmpeg của máy. Ghi `pin_fallback` để không mở lại cửa sổ thiết lập ở mọi lần mở app.
   - `verify` chạy một lượt export tí hon thật: lavfi 0,5 s qua `-/filter_complex` từ file, có `overlay` + `concat`, bằng libx264; máy có NVIDIA thì thử thêm `h264_nvenc` và ghi `nvenc_ok`.
4. Test:
   - **Toàn bộ** danh sách test ở mục Kiểm chứng 3, chạy trên Gyan 8.1.1. Mọi người dùng sẽ chuyển sang bản này. Ví dụ, bẫy `all_opacity = 1` (`core_process.cpp:1894-1899`) mới chỉ được đo trên bản N-123955.
   - `test:export`, `test:export-long-subtitles`, `test:unicode-path`, `test:overlay-placement` chạy thêm trên BtbN tháng 4 và BtbN `latest` (tải vào scratch). Lượt BtbN `latest` cũng để xác nhận bằng số đo cả hai hồi quy cho ghi chú phát hành.
   - **Kết quả 2026-09-27** (sidecar đã vá, máy dev):

     | Bản ffmpeg | Test | Kết quả |
     |---|---|---|
     | Gyan 8.1.1 `full_build-shared` | 19 test ở Kiểm chứng 3 + `test:export-concat-video-overlay` + `test:auto-subtitle` | **21/21 xanh** |
     | BtbN N-123955 (tháng 4, đang dùng trên máy dev) | nhóm 4 test trên + `export-concat-video-overlay` + `video-anim` | 6/6 xanh |
     | BtbN N-126889 (`latest` 2026-09-26) | cùng nhóm 6 test | 6/6 xanh |

     - Trên BtbN `latest`, NVENC hỏng như dự đoán ("Required: 13.1 Found: 13.0 … driver 610.00 or newer"); sidecar tự lùi về CPU nên vẫn xuất được.
     - Trước bản vá, bản này còn chết ngay ở "Unrecognized option 'filter_complex_script'" (exit 8). Cả hai hồi quy đã được xác nhận bằng số đo cho ghi chú phát hành.
     - `test:video-mask` và `test:video-anim` **chưa từng chạy được trên Windows**: chúng kiểm `fs.existsSync('…/core_process')` thiếu đuôi `.exe`. Đã sửa đường dẫn; giờ chúng render thật và xanh.
   - **Thử bộ cài trên runtime sạch** (`CRAB_RUNTIME_DIR` trong scratch, harness gọi `setupRuntime()`). Cả 6 ca đạt:
     1. runtime sạch: cài bản ghim, xuất thử libx264 và NVENC đều đạt, `verifyRuntimeQuick` = ok;
     2. chạy lại: dùng lại bản ghim, không giải nén lại;
     3. máy "bản cũ" (BtbN trong `runtime/ffmpeg/bin`, manifest không `pin_id`, `asr` đã cài): quick = `ffmpeg_outdated` → thay bằng bản ghim, **`asr` vẫn `installed`**;
     4. mất mạng khi còn bản cũ: lùi về bản cũ, có `pin_fallback`, quick = ok;
     5. mất mạng khi không có gì: lùi về ffmpeg của máy;
     6. zip trong cache bị cắt cụt: phát hiện sai SHA-256, tải lại từ GitHub, cài được.
   - Cửa sổ thiết lập: dòng FFmpeg đổi thành "Dùng bản riêng đã kiểm chứng của ứng dụng", có bản dịch en/zh; `i18n:check` 1713/1713.
   - **Lưu ý cho máy dev:** `%LOCALAPPDATA%\CrabbyCut\runtime` hiện ghi `source: system`, nên cài bản mới trên máy này thì cửa sổ thiết lập mở một lần để tải bản ghim (~96 MB).
5. **Lỗi treo `concat` + video lớp phủ** (xem "Rủi ro đang xảy ra"):
   - Test `tests/scripts/export_concat_video_overlay.js` (`npm run test:export-concat-video-overlay`, đã thêm vào chuỗi `npm test`).
     - Dựng bằng lavfi đúng loại file gây treo: hai đoạn khác thông số màu, nối `-c copy`.
     - Xuất 3 clip + video lớp phủ vắt qua chỗ đổi, timeout 90 s, giết cả cây tiến trình khi quá hạn.
     - Đo màu hai phía chỗ đổi: đoạn full range đọc nhầm thành limited thì xám 200 ra ~214.
     - Với sidecar cũ: **đỏ** (treo, bị giết sau 90 s). Với bản vá: xanh sau 1,0 s.
   - **Vá (khác kế hoạch ban đầu):** `-reinit_filter:v 0` trước `-i` của video lớp phủ, cùng lý do với input lane chính. Không dùng `movie=` (xem "Rủi ro đang xảy ra").
     - Chỉ luồng hình: với tiếng, buffersrc trả EINVAL cho khung đổi thông số khi không được dựng lại (`buffersrc.c:98-106`), nên tiếng giữ hành vi cũ.
     - Không thêm cờ cho ảnh: ảnh không đổi thông số, và mỗi cờ tốn ~20 ký tự dòng lệnh × hàng trăm phụ đề.
6. Thử bộ cài trên runtime sạch (`CRAB_RUNTIME_DIR` mới) → `npm run dist:win` → phát hành → port sang `CrabbyCut_Private` (`core_process.cpp:3001`, `server.js:3890`, `subtitle-jobs.js:259`).
   - Runtime sạch: **đã thử** (xem mục 4).
   - Phát hành: **chờ người dùng**. `main` đang có 12 commit từ `v1.1.12`, trong đó có lồng tiếng "chưa test xong", nên phải chọn giữa nhánh hotfix từ `v1.1.12` và phát hành từ `main`.
   - Port: `git apply --check` bản vá sang `CrabbyCut_Private` (nhánh `CrabbyCut_v2.0.4`) **không áp sạch** ở `core_process.cpp`, nên phải port tay.
     - Bên đó còn thêm cờ `-reinit_filter:v 0` và bỏ lượt xuất hai pha (M.3).
     - Repo đó đang có sửa đổi chưa commit của người dùng.

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
  8. một lượt export ProRes;
  9. **dự án phụ đề song ngữ 39 phút** ("Ca thật 2": AV1 4K, 1.116 lớp chữ, nhiều batch). Dùng cả bản đầy đủ (số chính thức) lẫn bản cắt 5 phút cùng cấu trúc (để lặp nhanh);
  10. dự án 3 clip trở lên có **video lớp phủ tự đổi thông số màu giữa chừng**, vắt qua chỗ đổi (ca treo, đã sửa ở 0A mục 5);
  11. nguồn AV1/HEVC 10-bit `-c copy` khác, để thử giải mã phần cứng trên máy có hỗ trợ.
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
- Sửa `native/sidecar/core_process.cpp`, build bằng `npm run build:sidecar`. `native/sidecar/build/` nằm trong `.gitignore`, nên chỉ commit mã nguồn; bộ cài dựng lại exe.
- Mỗi mục có env tắt riêng. Chỉ bật mặc định khi qua 0.3 và test hồi quy.
- **Thứ tự đề xuất** (cập nhật 2026-09-27): 1.0 → 1.6 → 1.3 + 1.5 → **1.11** (phụ đề thành một luồng) → **1.1** (có "seek theo batch") → 1.7 → 1.4 → 1.10 → **1.12** (độ phân giải xuất) → 1.2 → 1.8 → 1.9 → **1.13** (cache render) → 1.14.
  - Với dự án dài nhiều phụ đề ("Ca thật 2"), riêng 1.1 (seek theo batch) + 1.11 + 1.3 đã gỡ gần hết 49 phút. Nếu cần ra kết quả sớm, làm ba mục này trước.
  - Số đo Bước 0 có quyền đảo thứ tự này.
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

**1.7 Ảnh tĩnh lẻ (không thuộc track phụ đề)** (#7). Env: `CRABBYCUT_EXPORT_STILL1=0`. **Đã viết lại 2026-09-27.**
- ⚠️ **KHÔNG dùng "một khung + `eof_action=repeat`" trong chuỗi lớp phủ.** Đo với 85 lớp phủ ở 4K: **8 khung/s**, so với 95 khung/s của kiểu hiện tại. Lý do: một lớp phủ đã hết khung làm framesync giữ tham chiếu khung chính, rồi `overlay` chép cả khung ở mọi lớp, mọi khung hình (#12).
  - Chỉ được dùng lại cách này khi bản fork đã vá #12 (2.4), và phải đo lại.
- Thay vào đó:
  - (a) ảnh tĩnh thuộc track chữ/phụ đề đi mục **1.11**;
  - (b) vài ảnh tĩnh lẻ (logo, sticker) giữ kiểu hiện tại (`-loop 1`, `trim=duration`, `eof_action=pass`) nhưng ghép `yuv420` (đo: 128 so với 95 khung/s với 85 lớp); input ảnh mang `-threads 1`;
  - (c) nhiều ảnh tĩnh lẻ cùng lúc (≥ ~5 trong một batch) thì cũng gom thành một luồng như 1.11.
- Điều kiện "thực sự tĩnh": `!OverlayIsTimeVarying` **và** không có `LOCALT` trong `adjustFilters`/`adjustFiltersPost`. `OverlayIsTimeVarying` (`:2315-2328`) hiện không kiểm hai trường này, khác với `IntervalIsTimeVarying` (`:2298-2301`). Đây cũng là lỗi tiềm ẩn khi cắt batch; sửa luôn.
- Mốc cuối của `enable`: hiện nay khung cuối của lớp phủ lúc có lúc mất, vì ảnh chạy 25 fps và framesync coi nó đã hết ở khung ảnh cuối + 1 tick (`framesync.c:238-266`). Khi đổi cách nạp ảnh, chốt mốc cuối theo lưới khung (`end − 0.5/renderFps`, đối xứng `seqEndTrim` `:2601-2608`) và thêm test biên.
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

**1.1 Chỉ giải mã đoạn được dùng** (#1, #13). Env: `CRABBYCUT_EXPORT_SEEK=0`.
- **Bước đầu, rủi ro thấp: seek theo batch (#13).**
  - Mỗi batch (`ExportBatch`) mở nguồn bằng `-itsoffset S -ss S -i source`, với S = mốc trim nhỏ nhất của batch − 1 khung nguồn.
  - Mốc thời gian giữ nguyên như hôm nay, nên filter script không phải đổi gì.
  - Với dự án một clip dài (dạng phụ đề điển hình), việc này biến tổng giải mã từ cấp số cộng (~6,9× ở "Ca thật 2") về đúng 1×.
  - Làm trước phần gom dải bên dưới.
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

**1.2 Giải mã phần cứng** (hạ ưu tiên theo số đo, trừ nguồn nặng). Env: `CRABBYCUT_HWACCEL_DECODE=0`.
- Chỉ cho nguồn/lớp phủ HEVC, 10-bit, **AV1**, hoặc độ phân giải cao được `-c copy`. Với H.264 8-bit đã chuẩn hoá thì NVDEC chậm hơn CPU.
- **AV1** là ca nặng nhất ("Ca thật 2": dav1d 4K ~238 khung/s, ăn ~12 lõi).
  - GPU có giải mã AV1: NVIDIA RTX 30 trở lên, AMD RX 6000 trở lên, Intel Arc/Xe (Gen12+), Apple M3 trở lên.
  - GTX 10xx/16xx và Apple M1/M2 **không** có, nên phải rơi về CPU.
  - Phép dò phải kiểm theo **từng codec**, không chỉ theo hãng GPU.
- `-hwaccel cuda` (NVIDIA) hoặc `d3d11va` (AMD/Intel trên Windows, và NVIDIA khi CUDA hỏng); macOS dùng `videotoolbox` (Bước M). Không đặt `-hwaccel_output_format`.
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
- **Sau 1.11, xem lại lý do chia batch.** Batch ~180 s sinh ra chỉ để chặn chi phí chuỗi lớp phủ tăng theo (số khung × số lớp phủ) (`:2253-2279`). Khi phụ đề đã thành một luồng, chi phí đó biến mất. Kích thước batch nên chọn lại theo hai mục đích còn lại:
  - song song (mục này), tức đủ batch cho N tiến trình;
  - cache (1.13), tức lưới cố định, ví dụ 60 s.

**1.9 Chọn encoder bằng dò chức năng** (sửa lỗi cho máy không NVIDIA).
- Mã hoá thử 0,1 s theo thứ tự `h264_nvenc → h264_qsv → h264_amf → libx264`.
- Cache ở `%LOCALAPPDATA%\CrabbyCut\encoder-probe.json`, theo {hash `ffmpeg -version`, GPU, driver}.
- Không đổi tham số NVENC.

**1.11 Mỗi track phụ đề/chữ tĩnh thành MỘT luồng ảnh** (#12, #7; đã chốt 2026-09-27). Env: `CRABBYCUT_EXPORT_SUBSTREAM=0`.
- **Vì sao:** chi phí chuỗi `overlay` tăng theo số lớp phủ trong batch, kể cả lớp đang tắt (#12).
  - Đo ở 4K: 85 lớp = 95 khung/s; một luồng = **173 khung/s**, và con số này không đổi dù có bao nhiêu câu.
  - Cách này cũng bỏ hàng nghìn `-i`, tức hết lo trần dòng lệnh 32.766 ký tự (`:158`).
  - Đây là cách các NLE xử lý track caption: một lớp, chỉ vẽ câu đang hiện.
- **Áp cho:** lớp phủ ảnh tĩnh (`text_image`, `shape_image`, `media_image`) không hoạt ảnh, keyframe hay lớp Điều chỉnh (điều kiện như 1.7), nằm trên cùng một track và không chồng thời gian nhau. Track có item vi phạm thì tách item đó ra đi đường cũ.
- **Khung cố định của track:**
  - Hộp bao hợp nhất của mọi item trên track, tính theo toạ độ sequence. Gốc (Rx, Ry) làm tròn xuống số chẵn, rộng/cao làm tròn lên số chẵn cho `yuv420`.
  - Mỗi câu được bake **đúng vào khung đó** ở độ dời (x−Rx, y−Ry). Renderer vẫn vẽ bằng canvas như hiện nay; chỉ thêm tham số canvas/offset cho `renderTextItemToPng` (`editing-runtime.js:17420`). Như vậy vị trí chính xác từng điểm ảnh, không bị làm tròn chẵn như ở 1.5.
  - Có thêm một ảnh trong suốt dùng cho khoảng trống.
- **Luồng:** sidecar ghi một file `ffconcat` cho mỗi track, xen kẽ ảnh trống / ảnh câu với `duration` = số khung / fps.
  - Mốc được tính theo đúng lưới khung và quy tắc nửa khung hiện tại (`OverlayEnableStart` `:2247`, `seqEndTrim`).
  - Mỗi batch có file riêng, đã cắt theo cửa sổ và dời về gốc batch (như `OverlaysForBatch` `:2480`).
  - Input: `-f concat -safe 0 -i track_N.ffconcat`. Graph: `[k:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[sN];[main][sN]overlay=x=Rx:y=Ry:format=yuv420`.
  - Mỗi ảnh câu chỉ giải mã **một lần**.
- **Song ngữ:** hai track thì hai luồng, hai `overlay`.
- **Kiểm:**
  - `test:export-long-subtitles`, `test:auto-subtitle`, `test:subtitle-langs`, `test:overlay-placement`;
  - thêm test biên: khung đầu/cuối của từng câu khớp đường cũ;
  - 0.3 trên fixture 9.
- Bản fork có thể thay việc bake khung cố định bằng một filter "nhiều ảnh" (2.4). Khi đó renderer không phải bake lại.

**1.12 Độ phân giải xuất có tác dụng thật** (đã chốt 2026-09-27).
- **Hiện nay** backend ép `resolution: 'sequence'` (`index.html:15821`, `server.js:6927`), nên ô "Độ phân giải" vô tác dụng. Sidecar đã có sẵn `ApplyResolutionPreset` (`core_process.cpp:1219`).
- **Pha 1:** dựng đồ thị ở cỡ sequence như cũ, `scale` xuống cỡ xuất ở đuôi (`OutputColorFilters`). Đúng ngay, và giảm tải cho encoder.
- **Pha 2:** dựng cả đồ thị ở cỡ xuất (nhân mọi toạ độ/cỡ clip, lớp phủ, khung track 1.11 với hệ số f). Renderer bake chữ ở mật độ của cỡ xuất (`templateExportBakeDensity`). Phần ghép và filter nhẹ đi ~f².
  - Kiểm pha 2 bằng 0.3 so với pha 1.
- Giải mã nguồn vẫn ở cỡ gốc. Với nguồn 4K AV1 thì giải mã vẫn là trần, xem 1.2.
- Ví dụ "Ca thật 2" xuất 1080p: phần ghép ~4× nhẹ hơn, encode ~4× nhẹ hơn.

**1.13 Bộ nhớ đệm render cho lượt xuất lại** (đã chốt: làm sau các tối ưu chính).
- Chia lượt xuất theo **lưới cố định**, ví dụ 60 s, cắt ở mốc an toàn theo luật của `PlanOverlayBatches`. Mỗi batch có một khoá SHA-256, gồm:
  - filter script đã chuẩn hoá về mốc tương đối của batch;
  - định danh file đầu vào (đường dẫn + cỡ + mtime, cộng băm 1 MB đầu/cuối);
  - chuỗi `ffmpeg -version`, tham số encoder, phiên bản sidecar.
- Xuất lại: batch trùng khoá thì dùng lại file cũ, chỉ render các batch khác rồi nối `-c copy` (`:3301-3316`). Lượt tiếng luôn chạy lại vì rẻ.
- Mọi batch trong một bản xuất phải **cùng tham số encoder**. Đổi encoder (ví dụ NVENC → CPU do lỗi) thì vô hiệu cả cache của dự án đó.
- Lưu ở `%LOCALAPPDATA%\CrabbyCut\render_cache\<id dự án>\` (macOS: `~/Library/Caches/CrabbyCut/`). Có trần dung lượng (LRU, mặc định ví dụ 20 GB) và nút "Xoá cache render" trong Cài đặt › Xuất video (mục này hiện đang để trống, `settings-panel.js:26`).
- Tương đương "Use Render Cached Images" của Resolve và "Use Previews" của Premiere.

**1.14 (nghiên cứu, làm sau) Chép thẳng đoạn không có hiệu ứng** (kiểu "Smart rendering" của Premiere và "Bypass re-encode when possible" của Resolve).
- Đoạn lane chính không lớp phủ, không màu, không đổi cỡ, cùng codec/tham số với bản xuất thì `-c copy` theo GOP. Chỉ mã hoá lại phần GOP dở ở hai mép.
- Chỉ có ích cho dự án cắt trơn không phụ đề.
- Khó ở chỗ khớp SPS/PPS giữa phần chép và phần mã hoá lại. Chỉ làm nếu Bước 0 cho thấy loại dự án này đủ phổ biến.

**Tương thích nhánh macOS:** phần riêng Windows (`-hwaccel cuda/d3d11va`, `CreateProcessW`) gói sau `#ifdef _WIN32` hoặc sau phép dò; phần trung lập viết để `git apply` sang `CrabbyCut_Private` được. Chi tiết macOS ở **Bước M**.

**Điều kiện chuyển tiếp:** có bảng A/B từng mục; mọi fixture qua 0.3; toàn bộ test export xanh.

---

# NHÁNH 1B — Bước vẽ trước trong Electron (chỉ làm nếu Bước 0 đo được ≥ 30% tổng thời gian)

- Chuyển cảnh: thay tua-từng-khung + `setTimeout(50)` (`editing-runtime.js:18057-18097, 18330-18441`) bằng `play()` + `requestVideoFrameCallback` hoặc WebCodecs. Map đúng lưới khung; hướng này đã ghi ở `APP_INTERNALS.md:1364-1367`.
- Dùng lại một canvas thay vì tạo mới mỗi khung. Mã hoá trong worker (`OffscreenCanvas.convertToBlob`). Chạy song song các chuyển cảnh độc lập.
- Chữ động: bỏ `toDataURL` đồng bộ + base64 trong `editing_json` (`17512-17682`), chuyển sang blob nhị phân như `transition_frames`.
- Bắt buộc qua `test:transition-frames`, `test:transitions-measured`, `test:bokeh-swing`, `test:echo-shift`, `test:retouch-export` + 0.3.

---

# BƯỚC M — macOS (chạy song song từ Bước 1; đã chốt 2026-09-27)

**Hiện trạng nhánh macOS** (`CrabbyCut_Private`, dòng `CrabbyCut_v2.0.x`, cùng khung sidecar):
- ffmpeg lấy từ hệ thống (Homebrew), gọi bằng tên trần (`backend/hdr-tonemap.js:10-11`), không ghim phiên bản. Homebrew lên FFmpeg 9 là `-filter_complex_script` hỏng (`core_process.cpp:3001`, `server.js:3890`, `subtitle-jobs.js:259`).
  - Việc đầu tiên trên Mac của người dùng: chạy `ffmpeg -version` để biết đã hỏng chưa.
- Encode: `h264_videotoolbox`/`hevc_videotoolbox` (`core_process.cpp:904-914, 2733`), proxy preview dùng `scale_vt` (`:3154-3180`). Export **chưa** có `-hwaccel videotoolbox`.
- **Xuất hai lượt** khi có lớp phủ và lane chính > 1 đoạn (`:3397-3432`), để vòng qua lỗi treo của FFmpeg (đã tái hiện trên Windows, xem "Rủi ro đang xảy ra"). Nghĩa là giải mã + encode **hai lần**, với bản trung gian ở chất lượng nới tay.
- Chưa có số đo nào trên Mac. Máy dev là Windows.

**Việc cần làm:**
- **M.1 Bản ffmpeg ghim cho macOS**, hai bản `arm64` và `x86_64`:
  - Đích lâu dài: build từ nhánh fork `crabbycut/perf` (cùng bản vá 2.1b và 2.4), bật VideoToolbox, zimg, libass, freetype, harfbuzz, fribidi, libplacebo (MoltenVK, tuỳ chọn).
  - Tạm thời: một bản static đáng tin, có ghim SHA-256. Chọn nguồn cụ thể lúc thi công và hỏi người dùng.
  - Ký mã (codesign, hardened runtime) và notarize cùng app. Nếu tải lúc chạy thì phải xử lý thuộc tính quarantine của Gatekeeper.
  - Resolver và verify bằng export tí hon, theo khuôn Bước 0A.
- **M.2 Port** bản vá 0A (`-/filter_complex`) và mọi mục trung lập của Bước 1 (1.0, 1.1, 1.3, 1.5, 1.6, 1.11, 1.12, 1.13) sang `CrabbyCut_Private`, theo cách port quen dùng.
- **M.3 Bỏ lượt xuất thứ hai** — nay chỉ cần port cờ `-reinit_filter:v 0` cho video lớp phủ (0A mục 5), vì nguyên nhân treo đã rõ:
  - ảnh/chữ tĩnh đã đi 1.11, nên không còn là input `-i` đổ vào `overlay`;
  - video lớp phủ mang `-reinit_filter:v 0` như bản Windows (đã đo: hết treo trên cả 3 bản ffmpeg).
  - Lợi dự kiến: ~2× cho đúng loại dự án đó. Kiểm bằng test treo ở 0A mục 5, chạy trên Mac.
- **M.4 Giải mã phần cứng** `-hwaccel videotoolbox`:
  - H.264/HEVC trên mọi Apple Silicon và phần lớn Mac Intel đời mới; ProRes có media engine từ M1 Pro/Max; **AV1 chỉ từ M3**.
  - Dò theo từng codec như 1.2. Bộ nhớ hợp nhất của Apple Silicon làm việc tải khung về RAM rẻ hơn nhiều so với PCIe trên PC.
- **M.5 Mã hoá:**
  - Giữ VideoToolbox với `-prio_speed 1`.
  - M1 Pro/Max/Ultra trở lên có 2 hoặc hơn bộ mã hoá, nên song song (1.8) đáng đo trên những máy này.
  - ProRes dùng `prores_videotoolbox` khi có.
- **M.6 Ghép bằng GPU trên Mac:**
  - FFmpeg chỉ có `scale_vt`, `transpose_vt`, `yadif_videotoolbox` (`libavfilter/allfilters.c:455, 520, 557`); cây này không có `overlay_videotoolbox`.
  - Vì vậy giữ ghép trên CPU (Apple Silicon mạnh, bộ nhớ hợp nhất). libplacebo qua MoltenVK chỉ là thử nghiệm.
- **M.7 Đo trên Mac của người dùng:**
  - `npm run bench:export` với cùng fixture (0.2), trong đó có fixture 9 (phụ đề 39 phút) và fixture 10 (ca treo);
  - chạy trước và sau từng mục;
  - ghi chip (M1/M2/M3…), RAM và phiên bản macOS vào báo cáo.

---

# MÁY KHÔNG CÓ GPU RỜI / KHÔNG CÓ BỘ MÃ HOÁ PHẦN CỨNG

- **Mọi mục "giảm việc" lợi y như trên máy có GPU:** 1.0, 1.1 (kể cả seek theo batch), 1.3, 1.5, 1.6, 1.11, 1.12, 1.13. Chúng bớt phần giải mã và ghép trên CPU, vốn là phần nặng nhất ở cả hai ca thật.
- **Phần lớn máy "không GPU" vẫn có GPU tích hợp có bộ mã hoá:** Intel Quick Sync, AMD AMF trên APU, Apple VideoToolbox.
  - Hôm nay CrabbyCut **không bao giờ** tới được QSV/AMF: chọn NVENC theo so chuỗi, hỏng, rồi rơi thẳng xuống libx264.
  - Mục 1.9 (dò chức năng) sửa đúng chỗ này, nên đây là mục lợi nhất cho nhóm máy này.
  - Giải mã tương tự: `d3d11va` dùng được trên GPU tích hợp Intel/AMD (1.2).
- **Máy CPU thuần** (hoặc khi phần cứng hỏng):
  - libx264 `veryfast` (`core_process.cpp:2737-2750`) ở 4K có thể thành nút thắt. Đo ở Bước 0 với `FFMPEG_EXPORT_HW=0 CRABBYCUT_HWACCEL_DECODE=0`.
  - Cân nhắc preset theo độ phân giải: `faster` ở ≤1080p, `veryfast`/`superfast` ở 4K. Giữ CRF theo mức chất lượng.
  - x264 đã tự đa luồng, nên song song nhiều tiến trình (1.8) chỉ lợi khi đồ thị filter là phần tuần tự.
- **Cổng chặn không hồi quy:** mọi mục phải chạy lại ở chế độ CPU thuần, và không được chậm hơn số nền CPU (Kiểm chứng 4).

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
0. **Hai bản vá phát hiện ở "Ca thật 2"**, ưu tiên cao, gửi upstream được:
   - **`overlay` không chép khung chính khi không cần (#12).**
     - Trong `do_blend` (`vf_overlay.c:845-889`), xét `ctx->is_disabled` / chưa có khung phụ **trước** khi gọi `ff_inlink_make_frame_writable`, rồi chuyển thẳng khung chính đi.
     - Trong framesync (`framesync.c:390-424`, logic `need_copy` của `ff_framesync_get_frame`), không clone khung chính khi đầu vào phụ đã hết và chỉ còn lặp khung cuối.
     - Đo lợi: mỗi lớp phủ tắt đang tốn ~1,2 ms/khung ở 4K. Sau vá, chuỗi 85 lớp phủ phải về gần mức 1 lớp (~200 khung/s thay vì 95, và thay vì 8 với `eof_action=repeat`).
     - Kèm FATE bảo đảm đầu ra không đổi (`-f framemd5`) trên các test overlay sẵn có.
   - **fftools treo khi dựng lại filtergraph giữa `concat`** (input đổi thông số giữa chừng, `-reinit_filter` mặc định bật). Sidecar đã né bằng `-reinit_filter:v 0` (0A mục 5), nên việc này **hết gấp**.
     - Điều tra đường dựng lại graph (`ffmpeg_filter.c:3236-3264`, `ifilter_has_all_input_formats`) cùng bộ lập lịch (`ffmpeg_sched.c`).
     - Gửi báo lỗi upstream kèm repro lavfi (hai đoạn khác thông số màu nối `-c copy`, xem test 0A mục 5).
     - Sidecar vẫn giữ `-reinit_filter:v 0` sau khi upstream sửa: dựng lại graph còn gây chớp đen (lý do của cờ ở lane chính).
   - (Tuỳ chọn) **filter "nhiều ảnh"**: đọc một file danh sách (ảnh, x, y, mốc đầu, mốc cuối), giải mã PNG khi cần và chỉ trộn ảnh đang hiện. Nó thay được việc renderer bake khung cố định ở 1.11, và đặt được ở toạ độ lẻ.
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
- macOS: cùng nhánh mã, build `arm64` + `x86_64`, ký mã + notarize (M.1).

---

# Đối chiếu với các ứng dụng chuyên nghiệp (tra cứu 2026-09-27)

| Kỹ thuật | Premiere Pro | DaVinci Resolve | After Effects | CapCut | Mục tương ứng ở CrabbyCut |
|---|---|---|---|---|---|
| Hiệu ứng/ghép chạy trên GPU | Mercury Playback Engine (CUDA/Metal/OpenCL) | Toàn bộ xử lý ảnh trên GPU | GPU cho nhiều hiệu ứng | Có | Bước 2 (`lut3d_cuda`, libplacebo); ghép GPU hoàn toàn chưa làm vì bộ lọc CUDA/VideoToolbox của FFmpeg thiếu (xem 2.4, M.6) |
| Giải mã/mã hoá phần cứng | "Hardware Encoding" H.264/HEVC | Chọn encoder GPU khi Deliver | Qua Media Encoder | "Speed up hardware decoding/encoding" trong Settings › Performance | 1.2 (dò theo codec, gồm AV1), 1.9 (dò encoder, tới được QSV/AMF), M.4/M.5 |
| Dùng lại phần đã render | "Use Previews" khi export | "Use render cached images" | Disk cache | — | 1.13 |
| Không mã hoá lại đoạn không đổi | Smart rendering (một số codec) | "Bypass re-encode when possible" | — | — | 1.14 (nghiên cứu) |
| Render nhiều khung/đoạn song song | Đa luồng nội bộ | Đa luồng nội bộ | Multi-Frame Rendering (1,2–3× tuỳ số lõi) | — | 1.8 (sau khi đã giảm việc) |
| Phụ đề/caption là **một track** | Track Captions | Track Subtitle | — | Lớp caption | 1.11 (một luồng ảnh mỗi track) |
| Độ phân giải xuất độc lập với sequence | Có | Có | Có | Có | 1.12 |
| Công tắc tăng tốc cho người dùng | Có (Preferences) | Có | Có | Có (Settings › Performance) | Cài đặt › Xuất video (đang trống): công tắc giải mã/mã hoá phần cứng, số tiến trình song song, cache render |

**Bài học chung:**
- Các ứng dụng này không thắng nhờ một mẹo encode. Họ **không làm việc thừa**: không giải mã phần không dùng, không vẽ lại lớp đang tắt, không render lại phần đã có. Và họ giữ khung trong một pipeline duy nhất, thay vì chuyển qua lại định dạng.
- Đó đúng là các mục 1.1, 1.3, 1.5, 1.11, 1.13 của kế hoạch này. Phần GPU là bước sau, khi phần thừa đã được bỏ.

Nguồn:
- [Adobe: Use preview files when rendering](https://helpx.adobe.com/premiere/desktop/render-and-export/render-sequences-for-playback/use-preview-files-when-rendering.html)
- [Adobe: Smart rendering supported formats](https://helpx.adobe.com/premiere/desktop/render-and-export/render-sequences-for-playback/smart-rendering-supported-formats.html)
- [Adobe: Hardware-accelerated encoding and decoding in Premiere](https://helpx.adobe.com/x-productkb/multi/gpu-acceleration-and-hardware-encoding.html)
- [Adobe: Mercury Playback Engine GPU acceleration](https://helpx.adobe.com/premiere/desktop/get-started/download-and-install/mercury-playback-engine-gpu-accelerated-in-premiere.html)
- [Adobe: Multi-Frame Rendering in After Effects](https://helpx.adobe.com/after-effects/using/multi-frame-rendering.html)
- [Puget Systems: After Effects Multi-Frame Rendering](https://www.pugetsystems.com/labs/articles/after-effects-multi-frame-rendering-processor-performance-analysis-2217/)
- [Blackmagic Forum: render cache to delivery format](https://forum.blackmagicdesign.com/viewtopic.php?f=21&t=160413)
- [DaVinci Resolve export settings](https://davinciresolve21.com/blog/export-settings)
- [CapCut export settings (hardware encoding)](https://editlogic.io/best-export-settings-for-capcut-pc/)

---

# Kiểm chứng

1. **Tốc độ**: `npm run bench:export` (≥ 3 lượt, trung vị). Báo từ-lúc-bấm, vẽ trước, server, ffmpeg.
   - Mục tiêu ≥ 2× trên "Bin Tom" và fixture phụ đề dài.
   - Riêng "Ca thật 2" (phụ đề song ngữ 39 phút, 4K AV1) trên máy này: từ ~49 phút xuống **≤ 10 phút** khi xuất 4K; xuất 1080p (1.12) còn nhanh hơn.
   - Trên Mac: đo theo M.7.
2. **Chất lượng**: `tests/scripts/export_fidelity.js` theo 0.3.
3. **Hồi quy**: `npm run test:export`, `test:export-many-overlays`, `test:export-color`, `test:export-long-subtitles`, `test:sequence-fps`, `test:seam`, `test:frame-grid`, `test:overlay-placement`, `test:video-mask`, `test:video-anim`, `test:position-keyframe`, `test:color-adjust`, `test:adjust-layer`, `test:clip-speed`, `test:mixed-orientation`, `test:retouch-export`, `test:transition-frames`, `test:main-lane-concat`, `test:unicode-path`.
   - Chạy khi app/backend **đang tắt** (bẫy `core_c.node` EPERM).
   - Xong thì khôi phục `progress.txt`.
4. **Máy không NVIDIA**: `FFMPEG_EXPORT_HW=0` + `CRABBYCUT_HWACCEL_DECODE=0` phải đúng và không chậm hơn số nền CPU; `d3d11va` thử được ngay trên máy này.
5. **Soát đồ thị**: `-print_graphs_file` xác nhận không có bộ chuyển đổi tự chèn giữa các `overlay` liên tiếp, và định dạng/dải màu đúng như thiết kế.
6. **Bước 2**: `make fate` cho các nhóm filter bị đụng, `checkasm`, rồi chạy lại 1–5 với bản ffmpeg riêng.
7. **Tương thích ngược**: sidecar của bản CrabbyCut phát hành trước Bước 0A phải export được với bản ffmpeg riêng (mục 2.1b). Chiều ngược lại cũng phải đúng: sidecar mới chạy trên ffmpeg cũ phải tự quay về lệnh thường nhờ dò tính năng.
8. **Không treo**: `tests/scripts/export_concat_video_overlay.js` (0A mục 5) xanh trên Windows và Mac, với mọi bản ffmpeg được hỗ trợ.
9. **Phụ đề**: khung đầu/cuối của từng câu ở 1.11 khớp đường cũ (trừ lỗi mất khung cuối đã biết ở 1.7), và vị trí chính xác từng điểm ảnh.
10. Ghi quyết định + bảng số vào `docs/` (quy ước dự án).

## Ngoài phạm vi (ghi lại để không làm trùng hoặc bỏ sót)
- 1.9 thay phần "probe encoder" trong Đợt 6 của `KE_HOACH_TOI_UU_VA_BOOTSTRAP_WIN.md` (commit `91e768c`). Hai phần còn lại của Đợt 6 không nhắm vào tốc độ export:
  - proxy preview toàn GPU (NVDEC + `scale_cuda` + NVENC) — dùng chung phép dò của 1.2;
  - tham số NVENC theo chất lượng.
- Bước chuẩn hoá lúc nhập (libx264 veryfast) ảnh hưởng thời gian **nhập**, không ảnh hưởng thời gian export.

## File chính sẽ sửa
- `CrabbyCut/native/sidecar/core_process.cpp`: `WriteClipVideoFilters`, `WriteVisualOverlayFilter`, `AppendKfTransformFilters`, `AppendFeatherAlpha`, `AppendOverlayInputArgs`, `WriteFilterScript`, `ExportBatch` (seek theo batch), `CommandExportVideo`, `PlanOverlayBatches`, `OverlaysForBatch`, `OverlayIsTimeVarying`, `SelectEncoderPlan`, `ApplyResolutionPreset`; mới: dựng `ffconcat` cho track phụ đề (1.11), khoá cache batch (1.13).
- `CrabbyCut/backend/server.js`:
  - báo cáo, đo thời gian, `-/filter_complex`;
  - bỏ ép `resolution = 'sequence'` (`:6927`);
  - chuyển thông tin track/khung cố định cho 1.11;
  - thư mục cache render.
- `backend/subtitle-jobs.js`.
- `index.html`: mốc thời gian, hộp thoại xuất (độ phân giải thật).
- `static/js/editing-runtime.js`: `renderTextItemToPng` thêm canvas/offset của track (1.11), mật độ bake theo cỡ xuất (1.12).
- `static/js/settings-panel.js`: mục "Xuất video" (công tắc phần cứng, song song, cache).
- `CrabbyCut/scripts/setup_runtime.js`, `runtime_paths.js`, `generate_third_party_notices.js`.
- `CrabbyCut/tests/scripts/`:
  - `bench_export.js` (khôi phục);
  - mới: `export_fidelity.js`, `export_concat_video_overlay.js`;
  - sửa: `overlay_placement_contract.js`.
- (1B) `CrabbyCut/static/js/editing-runtime.js`.
- (Bước M) `CrabbyCut_Private`: cùng các file trên, cộng resolver ffmpeg cho macOS, và bỏ nhánh xuất hai pha (`core_process.cpp:3397-3432`) khi đủ điều kiện.
- ffmpeg, nhánh `crabbycut/perf`:
  - `fftools/ffmpeg_opt.c` (bí danh `-filter_complex_script`, mục 2.1b);
  - `fftools/ffmpeg_filter.c` / `ffmpeg_sched.c` (treo khi dựng lại graph, hết gấp);
  - `libavfilter/vf_overlay.c` + `framesync.c` (không chép khung khi lớp phủ tắt);
  - `libavfilter/` khác: profiler, filter lớp phủ hợp nhất, filter "nhiều ảnh", `vf_lut3d` + `x86/`, `x86/vf_overlay_init.c`.
