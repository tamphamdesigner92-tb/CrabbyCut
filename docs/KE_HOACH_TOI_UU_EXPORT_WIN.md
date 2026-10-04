# Kế hoạch: Xuất video CrabbyCut nhanh ≥ 2× trên Windows và macOS — sửa lệnh ffmpeg + tự build ffmpeg

> **Phiên 14 (2026-10-04):** **bộ nhớ đệm khung vẽ trước** (miếng vá Retouch + chuỗi khung chữ/hình/ảnh động không dựng lại khi xuất lại; khoá gồm vân tay mã nguồn của trang) + kết quả dò GPU cất ngoài temp + nạp LUT không trùng lượt + nhớ chuỗi cube. **Xuất lại "Yêu Con" trong Electron thật: 37,9 s -> 2,85 s** (lượt đầu 52,9 s); sửa một khối Retouch 15 s, sửa chữ một phụ đề 9,5 s. **Đọc "BÀN GIAO PHIÊN 14 -> 15" ở mục 25.**
>
> **Phiên 13 (2026-10-03):** phát hành ffmpeg `.2` (Release + bản ghim); LUT chạy float ở đường CPU (+0,9..+10 dB); lưu kết quả dò GPU; **`hwupload` thay `hwupload_cuda`** (mỗi cái tự tạo ngữ cảnh CUDA ~0,25 s): Yêu Con 22,6 -> 17,4 s (CPU 51,8), Bin Tom 13,3 -> 9,1 s (CPU 14,9), phim 4K AV1 84 -> 49 s (CPU 59). Chuỗi màu tĩnh bake thành LUT trên GPU; 1.9 chọn bộ mã hoá bằng phép thử; **1.13 cache render cho lượt xuất lại** (cả lượt tiếng: Yêu Con xuất lại 14,4 -> 2,9 s, Bin Tom 8,0 -> 2,1 s, đổi một phụ đề 4,8 s, phim 300 s ~49 -> 4,7 s); payload gửi sidecar bỏ `editingItems` 92 MB (Bin Tom 9,5 -> 8,0 s); ảnh tĩnh lớp phủ hết đúng mép cuối (trước đây sớm 1–3 khung ở mọi bản xuất); lớp phủ động chặn mốc cắt đúng theo cửa sổ enable (Yêu Con 17,0 -> 14,7 s). **Đọc "BÀN GIAO PHIÊN 13 -> 14" ở mục 24.**
>
> **Phiên 12 (2026-10-03):** 1.21 G2 tiếp — LUT trên GPU (`crabgeo_cuda` lut/lut2/mix, bản `n8.1.1-crabbycut.2`) + lớp phủ chưa có bản GPU dựng bằng CPU rồi tải lên (batch không còn bị kéo về CPU vì lớp phủ). **Yêu Con 51 -> 22,6 s**, Bin Tom 14,9 -> 13,3 s; bộ so 0.3 ĐẠT; hồi quy 52/52 ×3. Bản ffmpeg `.2` đã phát hành (Release + bản ghim, đầu phiên 13). **Đọc "BÀN GIAO PHIÊN 12 -> 13" ở mục 23.**
>
> **Phiên 11 (2026-10-03):** 1.21 G5 — bản ffmpeg riêng `n8.1.1-crabbycut.1` dựng sạch từ repo `ffmpeg-for-CrabbyCut` (kịch bản + bản vá, người dùng chọn), đóng zip 33,5 MB, qua hồi quy trên đúng zip đó; `scripts/ffmpeg_pin.js` trỏ sang. Chữa trước khi phát hành: bản riêng nhập tĩnh `vulkan-1.dll` (máy không có driver Vulkan sẽ không chạy nổi ffmpeg) -> kèm bộ nạp Vulkan. **G5 XONG: người dùng đã tạo Release + tải zip lên; zip tải về từ `FFMPEG_PIN.url` khớp SHA-256, đường cài thật của bộ cài chạy trọn. Đọc "BÀN GIAO PHIÊN 11 -> 12" ở mục 22.**
>
> **Phiên 10 (2026-10-02):** 1.21 — G3 (sidecar dựng đồ thị GPU) + G4 (Cài đặt › Xuất video "Render bằng GPU/CPU") XONG; chữa chạy đua GPU ở bản ffmpeg riêng (`sync=1`); chữa `test:logo-ai` đỏ từ 83b8307. Người dùng chốt G5: bản ffmpeg riêng phát hành ở **repo riêng `tamphamdesigner92-tb/ffmpeg-for-CrabbyCut`**. **Đọc "BÀN GIAO PHIÊN 10 -> 11" ở mục 21 (có "G5 — VIỆC CHO PHIÊN 11").**
>
> **Phiên 9 (2026-10-02):** 1.12 pha 2 BẬT mặc định. 1.21 (bộ ghép GPU riêng): G0 + G1 XONG (bản ffmpeg tự build qua 36/36 test), bộ lọc `crabgeo_cuda`/`crabblend_cuda` viết + kiểm xong, G3 (sidecar) ĐANG DỞ — **đọc "BÀN GIAO PHIÊN 9 -> 10" ở mục 20 trước khi làm tiếp.**
>
> **Phiên 8 (2026-10-01):** 1.8 xuất song song nhiều tiến trình — xong, bật mặc định (Bin Tom −35%); 1.12 pha 2 — viết xong, sau env. Xem "VIỆC TIẾP THEO" mục 18–19.
>
> **Trạng thái (cập nhật 2026-09-30, phiên 5 — thêm 1.1 gom dải nguồn và bỏ `eof_action=repeat` của chuỗi khung chữ; Bin Tom 27,5–28,6 s → 20,6–20,7 s): Bước 0 XONG; Bước 1 đã xong 1.15 (+ cache SDR), 1.1a, 1.1 (gom dải), 1.16 (hỏi chỗ lưu trước, ghi thẳng ra đích), 1.17 (+ tắt tự phát khi mở dự án), 1.18, 1.3 và 1.5 (cả hai BẬT mặc định), chữa `tpad` của 1.3 (khung "không ghi được"), phần `faststart` của 1.8, 1.12 pha 1. MỤC TIÊU "CA THẬT 2 ≤ 10 PHÚT" ĐÃ ĐẠT: 55,6 phút → 9,2 phút (phát lại), 1.11 hoãn (số đo ở mục 1.11).** Lập ngày 2026-09-26, bắt đầu thi công 2026-09-27.
> - 0A mục 1–5: commit `0508bd0`; Bước 0 + phần đầu Bước 1 (phiên 2): commit `5e5635a` — cả hai trên `main`, **chưa push**. 0A mục 6: đã port sang `CrabbyCut_Private`, **chưa commit** bên đó. Chưa dựng bộ cài, chưa phát hành (người dùng chọn).
> - **Bản 39 phút (phát lại, 2026-09-30):** 3.334,9 s (số nền) → 1.392,5 s (1.1a) → 731,3 s (1.3 + 1.5) → **552,9 s** (chữa `tpad` + `moov` dành sẵn) = **6,0×**; trong app còn bớt 21,6 s tải về nhờ 1.16.
> - **Lợi đã có:** dự án phụ đề 4K 39 phút 49,6 → 23,2 phút (1.1a, trước 1.3); bản cắt 300 s 4K 191–196 s → 111–113 s với 1.3 (1,7×) → 81–91 s với 1.3 + 1.5 (~2,2×); Bin Tom 50–56 s → 39–40 s (1.3) → 29–35 s (1.3 + 1.5); trong app Bin Tom 129,2 s → 39,1 s; lượt xuất đầu của Bin Tom bỏ được 72,5/129 s (1.15). 25/25 test export xanh trên Gyan 8.1.1 (`npm run test:export-all`).
> - Danh sách việc cho phiên sau: xem mục **"VIỆC TIẾP THEO"** ngay dưới khối này.
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

## VIỆC TIẾP THEO (đọc đầu tiên khi mở phiên mới)

**Trạng thái git lúc dừng (2026-09-30, phiên 5)** — kiểm lại bằng `git status` / `git log -3` trước khi làm. Phiên 3 = commit `8fd9a22`; phiên 4 = `01b249d` + `a590ad4` (chữa `tpad`, `moov` dành sẵn, 1.12 pha 1); phiên 5 (1.1 gom dải nguồn): xem commit mới nhất. Chưa push.

| Repo | Trạng thái |
|---|---|
| `CrabbyCut` (`main`) | `0508bd0` = 0A; `5e5635a` = Bước 0 + 1.15 + 1.1a + 1.17 + 1.18 + 1.5 (tắt). Cả hai **chưa push**. Phiên 3 (1.3 + chữa màu mép 1.5 + ảnh tĩnh một lần): xem commit mới nhất. Cây làm việc còn phần sửa dở **của người dùng**: `index.html` (màn chờ "Đang mở dự án…", các hunk ngoài `performVideoExport`), dòng cuối `static/i18n/en.json` và `zh.json` — commit thì tách hunk, không gộp phần của người dùng |
| `CrabbyCut_Private` (`CrabbyCut_v2.0.4`) | bản port 0A **chưa commit**, gồm 7 file: `native/sidecar/core_process.cpp`, `backend/server.js`, `backend/subtitle-jobs.js`, `package.json`, `tests/scripts/overlay_placement_contract.js`, `video_mask_export.js`, `video_animation_expr.js`, cộng file mới `tests/scripts/export_concat_video_overlay.js`. Còn 5 file khác người dùng đang sửa dở (`asr/…`, `shortvideo/sidecar.py`, `static/js/ai-video-panel.js`, `tts/server.py`, `progress.txt`) |

**A. Khép lại Bước 0A** (người dùng tự làm, hoặc bảo làm):
1. Push: `git -C E:/Dev/Windows_App/CrabbyCut push origin main`.
2. Phát hành (khi người dùng quyết). Hai hướng đã nêu:
   - nhánh hotfix từ `v1.1.12`: an toàn;
   - phát hành từ `main`: kéo theo lồng tiếng "chưa test xong".

   Việc cần làm khi phát hành:
   - nâng `version` trong `package.json` + 2 chỗ trong `package-lock.json` (xem `test:app-version`);
   - dựng từ **cây sạch** (git worktree của đúng commit), không dựng từ cây đang có `index.html` sửa dở;
   - chạy `npm run dist:win`; người dùng tự đăng lên GitHub Releases vì máy không có `gh`.
   - Ghi chú phát hành: hai hồi quy của BtbN `latest` (không nhận `-filter_complex_script`, NVENC đòi driver ≥ 610) và lỗi treo khi có video lớp phủ. Số đo ở mục 0A.4.
   - Bộ cài mới sẽ mở cửa sổ thiết lập **một lần** trên máy đã cài bản cũ, để tải FFmpeg ghim (~96 MB); thư viện AI giữ nguyên.
3. `CrabbyCut_Private`: người dùng test bản port **trên Mac**: `npm run test:export-concat-video-overlay`, `test:export`, `test:video-anim`, rồi commit ("Port từ CrabbyCut public 0508bd0").
   - Build sidecar Private trên Windows phải chạy trong `vcvars64.bat`, vì script bên đó không tự tìm `cl`.
   - Trên Windows, Private có sẵn 2 test đỏ **không liên quan 0A**: `export-many-overlays` ("The command line is too long", vì chưa có đường `CreateProcessW` của bản public) và `video-mask`. Đỏ cả ở HEAD chưa vá.
   - **Phát hiện khi port:** sidecar macOS cũ (xuất hai pha) không treo nhưng **làm mất hình lớp phủ sau chỗ file đổi thông số màu**, không báo lỗi. Bản port sửa được (test đo màu xanh).
4. macOS M.3 (bỏ lượt xuất hai pha): chỉ làm sau khi test treo xanh trên Mac.

**B. Bước 0 — XONG (phiên 2).** Dụng cụ, bộ so chất lượng, số nền và kết luận ở mục "Kết quả Bước 0". Tóm tắt: filter là nút thắt (58–77% thời gian ffmpeg), 1B không cần làm.

**C. Bước 1 — trạng thái (2026-09-29, phiên 3):**
1. **1.15 chỉ hạ SDR asset có item dùng** — xong, test `test:export-hdr-asset-usage`. Bin Tom lượt đầu: bỏ được 72,5/129 s.
2. **1.1a seek theo batch** (batch chỉ-hình) — xong, test `test:export-batch-seek`. **Bản 39 phút: 2.978,8 → 1.392,5 s (2,14×)**, bản xuất giống hệt từng gói.
3. **1.17 dừng preview khi xuất** — xong. **1.18 dọn batch trung gian** — xong.
4. **1.3 đường nhanh YUV cho lane chính** — **xong, BẬT mặc định**. Test `test:export-fast-path`. Bin Tom 50–56 → 39–40 s; bản cắt 300 s 4K 191–196 → 111–113 s (1,7×). Bộ so 0.3 ĐẠT trên Bin Tom (gần bản chuẩn hơn: 40,3 → 45,1 dB). Chi tiết mục 1.3.
5. **1.5 lớp phủ ở YUV** — **xong, BẬT mặc định** (người dùng nới tiêu chí (b), xem "Quyết định đã chốt"). Chữa màu mép (`AlphaWeightedYuva420`, chỉ ảnh tĩnh; đệm +4) và **ảnh tĩnh xử lý một lần** (`OverlayStillOnce`). Bộ so 0.3 trên Bin Tom ĐẠT: so bản chuẩn 40,3 → 52,5 dB. Env tắt: `CRABBYCUT_EXPORT_YUVCOMP=0`, `CRABBYCUT_EXPORT_ALPHACHROMA=0`, `CRABBYCUT_EXPORT_STILL1=0`.
6. **1.15 cache SDR, 1.16 ghi thẳng ra đích, 1.17 tắt tự phát** — xong theo lựa chọn của người dùng (chi tiết ở từng mục). Test `test:export-output-path`; E2E Electron cho 1.16/1.17.
7. **Đo lại bản 39 phút (phiên 4)** trên nền 1.3 + 1.5: 731,3 s. Tách batch 3 (4.320 khung 4K AV1, 70 phụ đề, `-f null`): chỉ giải mã 19,1 s, lane chính 22,9 s, cả đồ thị 31–33 s — và **một** `overlay` trong suốt đã thêm ~5 s, còn 10 → 70 lớp chỉ thêm ~3,5 s. Thủ phạm: `tpad=stop_mode=clone` của 1.3 giữ tham chiếu tới mọi khung → `overlay` đầu phải chép nguyên khung 4K. **Đã chữa** (dời `tpad` lên trước hình học, md5 trùng 4.320 khung): batch 33,2 → 28,1 s. Cùng lúc: batch trung gian bỏ `+faststart`, bước ghép cuối dành sẵn chỗ cho `moov` (`-moov_size`) thay cho lượt ghi lại cả tệp. **Kết quả: 731,3 → 552,9 s** (hình 574,7 → 453,3 s; ghép 84,3 → 27,2 s). Chi tiết ở mục 1.3 và 1.8.
8. **1.11 hoãn**: sau khi chữa `tpad`, 70 lớp phủ chỉ còn tốn ~3 s/batch (cả đồ thị 26 s so với lane chính 23 s), trong đó ~1 s là phần trộn mà 1.11 cũng phải trả → lợi còn ~2 s/batch (~4% bản 39 phút) trong khi phải mô phỏng chính xác quy tắc hiện/tắt của framesync (xem mục 1.11). Làm lại khi có dự án nhiều lớp phủ hơn hẳn.
9. **1.12 pha 1 — xong**: ô "Kích thước video" (trước bị ẩn và vô tác dụng) nay hiện ra và có tác dụng; khổ lệch thì làm như Premiere (đúng cỡ preset + viền đen, người dùng chốt 2026-09-30). Còn pha 2 (dựng cả đồ thị ở cỡ xuất). Xem mục 1.12.
10. **Phiên 5 (2026-09-30): đo Bin Tom rồi làm 1.1 (gom dải nguồn)** — Bin Tom 24 s trước đó; tách: lane chính một mình 6,7 s, 2 video lớp phủ ~1,5 s, **17 chuỗi khung chữ động ~7 s**. 1.1 xong: −12% (xem mục 1.1). 1.0 (một `[0:v]` + `split`) gần như hết việc: clip nay đọc input của dải mình.
11. **Chi phí của chuỗi khung chữ — ĐÃ TÌM RA VÀ CHỮA (phiên 5): `eof_action=repeat`.** Đo CPU từng luồng (đọc `TotalProcessorTime` của từng luồng ffmpeg mỗi 200 ms — máy không có quyền quản trị nên không dùng được bộ lấy mẫu của xperf): luồng filter 3,25 CPU-giây khi chỉ có lane, 10,2 khi có 17 chuỗi chữ — và vẫn 8,6 khi thay mọi khung PNG bằng ảnh 16×16, tức phí của khung sườn chứ không phải của phép trộn. Đổi `repeat` → `pass`: 11,9 → 7,8 s (PNG 16×16), 14,8 → 11,0–11,3 s (PNG thật), nhưng mất 10 khung ở mép cửa sổ (chuỗi hết sớm 1–3 khung vì `setpts` cắt phần lẻ). **Chữa:** `SequenceTailFrames` nối K khung nhân bản khung cuối (`tpad=stop=K:stop_mode=clone`, K đủ phủ tới mép cửa sổ) rồi `pass`; thiếu `frame_count` thì giữ `repeat`. Ảnh tĩnh có retouch (chuỗi 2 khung giữ cả block) cũng đi đường này. **A/B cả lượt xuất Bin Tom: 24,4 / 24,1 → 20,6 / 20,7 s (−15%), framemd5 trùng 2.297/2.297.** Env tắt `CRABBYCUT_EXPORT_SEQPASS=0`; test `test:export-seq-tail` (chuỗi 29,97 mốc lẻ, chuỗi 2 khung giữ 4 s, chuỗi thiếu `frame_count`; đột biến bỏ khung nhân bản đỏ ở khung 81–89). Vì sao `repeat` đắt thì chưa rõ trên mã nguồn (sau EOF framesync hạ `sync` về 0 ở cả hai chế độ) — không cần biết để chữa.
    Ghi lại các phép đo trên đường tìm (phiên 5): 17 chuỗi, chỉ 1.043 khung PNG ~1000×550, mà thêm ~7 s thời gian thực và ~28 CPU-giây. Đã đo và LOẠI: cỡ khung đổi giữa chừng (không đổi), luồng giải mã PNG (`-threads 1` không đổi), mốc thời gian đầu vào (`-itsoffset` không đổi), cỡ phần trộn (thu khung chữ về 16×16 vẫn 13,3 s so với 15 s). Đã đo được: (a) chuỗi chuẩn bị đơn luồng tốn ~10 ms/khung, phần lớn là phép **kéo 1 điểm ảnh** cho bề rộng lẻ thành chẵn (`scale=ceil(iw/2)*2` ở tỉ lệ 100% — vừa tốn vừa làm chữ mờ nhẹ, preview vẽ PNG 1:1); thay bằng **đệm 1 cột/hàng trong suốt** cho 14,8 → 13,8 s (−14 CPU-giây), điểm ảnh khác bản cũ (sắc hơn, dời ≤ 0,5 px) nên cần qua bộ so 0.3 trước khi bật; (b) chạy riêng 17 chuỗi chuẩn bị: 2,5 s thực nhưng 24 CPU-giây (chia lát đa luồng trên ảnh nhỏ tốn điều phối), `threads=1` thì 12 CPU-giây nhưng 10 s thực. Hai hướng đã thử và BỎ: tách phần chuẩn bị ra filtergraph riêng (mục 1.8) **treo cứng** — đúng cái bẫy "hàng đợi vào của graph dùng chung cho mọi input"; chuẩn bị trước ra FFV1 bằng tiến trình song song: đồ thị chính còn 12,3 s nhưng lượt chuẩn bị tốn 4,9 s, md5 lệch (mkv làm tròn mốc). Phép "đệm thay kéo 1 px" ở (a) vẫn còn để ngỏ (−1 s trên Bin Tom, đổi điểm ảnh — cần bộ so 0.3).
12. **Dò nguồn song song (phiên 5):** mỗi lần `ffprobe` tốn ~120 ms khởi động; sidecar gọi nối tiếp ~8 lần → khâu dò 1,8 s trên Bin Tom. Nay 4 lần dò không có trạng thái chung (mốc hình, mốc tiếng, fps, `SourceSeekSafe`) chạy bằng `std::async` cùng lúc với phần còn lại: 1,79 → 1,25–1,39 s. Còn lại ở luồng chính: `MediaColorUntagged` (cache tĩnh, không an toàn luồng) cho nguồn và từng video lớp phủ, `ProbeMainSourceForFastPath`, chọn encoder — gộp các lần dò nguồn thành một lệnh `ffprobe` sẽ bớt thêm ~0,5 s.
13. **Bin Tom sau phiên 5 (phát lại):** 27,5–28,6 s (A/B đầu phiên) → **20,2–20,3 s** (−27%): 1.1 gom dải −12%, bỏ `repeat` −15%, dò song song −0,5 s. Bản 39 phút đo lại cuối phiên: 547,9 s (phiên 4: 552,9 s) — nhánh nhiều batch không chậm đi.
14. Việc kế tiếp theo thứ tự: 1.6 → 1.7 → 1.4 → 1.10 → 1.12 pha 2 → 1.2 → phần còn lại của 1.8 → 1.9 → 1.13 → 1.14; 1.11 khi có dự án nhiều lớp phủ hơn hẳn.
15. **Fixture người dùng chỉ định cho bước tiếp (2026-09-30): `G:\Work\AI\Test CrabbyCut\Test Export\Test.crab`** — sequence 1920×1080 25 fps; lane chính 2 nguồn khác khổ (`swim_protect_v2 (720p).mp4` 1366×720 + `DSCF3442.MOV` 3840×2160, clip 107%); lane overlay: video 4K cùng nguồn (nay 110% sau khi đổi mốc vừa khung) và một block **scale 150%, độ mờ 48% có keyframe độ mờ** — đúng đường `geq` của mục 1.6. Chưa dựng payload bench (`npm run bench:export -- --crab "<đường dẫn>"` lần đầu mở Electron để ghi payload). Việc nhỏ đã thấy: gộp các lần `ffprobe` (mục 12); đệm thay kéo 1 px cho chữ rộng lẻ (mục 11a, cần bộ so 0.3); lượt xuất trong app của Bin Tom chưa đo lại (phần vẽ trước ở renderer).
16. **Phiên 6 (2026-10-01): 1.19 áp màu sau phép co — xong** (dự án "Yêu Con 1" của người dùng: server 120,8 → 58,0 s). **1.20 ô "Bitrate" kiểu CapCut — xong** (người dùng chốt). Fixture bench mới: `test_temp/bench_export/yeu_con_1` (bản sao .crab ở `test_temp/yeucon_src/`). Bản Gyan 8.1.1 ghim trong scratch đã bị dọn (thư mục `bin` rỗng) — phiên này đo và chạy test trên BtbN N-123955 của PATH (đúng bản app đang chạy từ mã nguồn dùng).
17. **Phiên 7 (2026-10-01): 1.6 + 1.4 — xong.** Fixture `test_temp/bench_export/test_crab` (bản sao Test.crab ở `test_temp/testcrab_src/`): **55,6 → 14,2 s (3,9×)** — `geq` độ mờ keyframe −43 s, cắt trước khi phóng to −2,6 s. "Yêu Con 1": mép mềm Retouch −3 s. 1.7: sửa lỗi cắt batch qua chuỗi màu có LOCALT/sendcmd (phần tối ưu còn lại chờ 1.11). 1.10: các dự án mẫu chỉ có `lut3d` đã gộp sẵn ở frontend (HSL + LUT bake thành một .cube) — không có gì để gộp, bỏ. **Nhánh 1B (Retouch) xong**: dựng khung miếng vá 28,3 → 18,0 s trên Yêu Con. Việc kế tiếp: 1.10 → 1.12 pha 2 → 1.2 → phần còn lại của 1.8 → 1.9 → 1.13 → 1.14; Retouch vẽ trước ở renderer (27–42 s trên Yêu Con) đáng đo riêng.
18. **Phiên 8 (2026-10-01): 1.12 pha 2 (dựng đồ thị ở cỡ xuất khi co nhỏ) — đã viết mã + test; BẬT mặc định từ phiên 9 (người dùng chốt 2026-10-02)** (`CRABBYCUT_EXPORT_OUTSCALE=0` để tắt): 4K → 1080p −17%, 1080p → 720p −10..−23%; bộ so 0.3 (b) đạt, (a) trượt 2,6 dB vì bản chuẩn là đồ thị pha 1 (chi tiết mục 1.12). Bộ đo có `--resolution <preset>` để phát lại payload sẵn có ở cỡ xuất khác.
19. **Phiên 8: 1.8 xuất song song nhiều tiến trình — xong, BẬT mặc định** (`CRABBYCUT_EXPORT_PARALLEL=1` để tắt). Bin Tom −35%, Yêu Con −13%, phim 4K AV1 không đổi (đã bão hoà CPU). Bản chia batch trùng từng khung + từng mẫu với bản một lượt sau khi chữa 6 lỗi có sẵn của đường nhiều batch (chi tiết mục 1.8) — trong đó **chuỗi khung chữ động ở mọi bản xuất từng chạy sớm 1 khung và mất khung đầu**: nay đúng khung như preview, nên bản một lượt cũng đổi ở các khung hoạt ảnh. 1.2 tạm bỏ qua: trên máy này không lợi (HEVC 10-bit NVDEC 50,2 so với 50,4 s; GTX 1060 không giải mã AV1) và không có máy để kiểm ca có lợi (AV1 trên RTX 30+). Việc kế tiếp: 1.9 → 1.13 → 1.14; hướng mở: ở lượt một batch chỉ đổi RGBA trong cửa sổ của lớp phủ RGBA (xem cuối mục 1.8); bake chữ ở mật độ cỡ xuất nếu 1.12 pha 2 được bật.
25. **Phiên 14 (2026-10-04): bộ nhớ đệm khung vẽ trước (việc kế tiếp số 1 của phiên 13) — XONG; xuất lại Yêu Con 37,9 -> 2,85 s.**
    **BÀN GIAO PHIÊN 14 -> 15:**
    - **Bộ nhớ đệm khung vẽ trước** (commit `795a10d`; cách làm + khoá chi tiết: APP_INTERNALS "Xuất lại không dựng lại khung vẽ trước"). Renderer tính khoá (JSON ổn định của khối + sequence + fps + `faces_id` + **vân tay mã nguồn** = băm index.html + mọi script của trang lúc nạp + userAgent + GPU WebGL), hỏi `POST /api/prebake/lookup`; trúng thì gửi khoá thay khung, trượt thì dựng rồi gửi khung kèm khoá. Backend (`backend/prebake-cache.js`) cộng danh tính tệp nguồn + dòng đầu `ffmpeg -version`, cất ở `<USER_DATA_ROOT>/prebake_cache` (10 GB, 30 ngày), trỏ overlay vào bản trong cache (đường dẫn đứng yên -> cache render cũng trúng). Chung công tắc "Dùng lại phần đã render" + nút dọn "Bản render để xuất lại" (không thêm chuỗi giao diện nào). Áp cho: Retouch lane chính đường miếng vá; chữ / hình / mẫu văn bản động; ảnh động không màu/LUT/lớp Điều chỉnh/Retouch/xoá logo. CHƯA áp: Retouch bake cả khung, overlay video có Retouch, chuyển cảnh (Yêu Con không có, đo được 0 s).
    - **Kiểm khoá ở renderer thật** bằng bench mới `--eval-before <tệp.js>` (kịch bản ở `test_temp/pb_bench/`: `run_pb.sh` 3 lượt ghi, `run_mut.sh` A/B/C): sửa "Mịn da" khối 3 -> trúng 15 cất 1 (chỉ khối đó dựng lại, 15,0 s); sửa chữ một phụ đề -> trúng 15 cất 1 (9,5 s); chỉ chọn block (`is_selected`) -> trúng 16 (4,9 s). Lưu ý khi đo: sửa BẤT KỲ tệp script nào của trang giữa hai lượt là vân tay đổi, cả cache trượt (đúng thiết kế) — đừng sửa mã trong lúc bench đang chạy.
    - **Số đo** (Electron thật, `--rerecord`, GTX 1060, zip `.2`, có cache bám mặt + cache render): lượt đầu 52,9 s; xuất lại đầu phiên 37,9 s -> cache khung vẽ trước 5,0 s (vẽ trước 33,9 -> 1,5 s, `editing_json` 25 -> 5,4 MB) -> dò GPU ngoài temp 4,1 s -> kiểm cube không lặp 3,4 s -> nạp LUT không trùng lượt **2,85 s** (vẽ trước 0,84 s, server: tải lên 0,26 + chuẩn bị 0,56 + sidecar 0,82 s).
    - **Sửa kèm:** cache dò GPU cất ở `<USER_DATA_ROOT>/gpu_probe_cache.txt` (env `CRABBYCUT_EXPORT_GPU_PROBE_FILE`; test giữ trong temp) — trước đây mở dự án là mất (dò 1,17 -> 0,36 s); `ensureLutLoadedAsync` gộp lượt nạp đang chạy (10 clip song song cùng `registerUserLut` -> `cubeCache` bị xoá 10 lần; bước lane chính 0,92 -> 0,24 s); `cubeToText` nhớ 6 chuỗi; backend không kiểm cú pháp lại `.cube` đã kiểm.
    - **Test:** mới `npm run test:export-prebake-cache` (thêm vào `test:export-all`). Hồi quy sau commit `795a10d`: 54/54 (52 cũ + render-cache + prebake-cache, zip `.2`, GPU tự động); sau các sửa kèm: 54/54 (cùng danh sách).
    - **Cần người dùng xác nhận** (cộng dồn với mục 24): (5) cache khung vẽ trước dùng CHUNG công tắc + nút dọn với cache render, trần riêng 10 GB — không thêm ô/nút mới.
    - **Việc kế tiếp:**
      1. Lớp Điều chỉnh bị CHÉP vào `color_adjust_layer` của mọi clip (Yêu Con: `timeline_json` 20 MB = 2 cube 1 MB × 10 clip): gửi một lần rồi tham chiếu — phải sửa `timelineForExport` trong `index.html` (đang có phần người dùng stage, chờ họ commit) + `normalizeExportIntervals`. Lợi ước ~0,3–0,5 s mỗi lượt xuất (tải lên + JSON + băm).
      2. Cache khung vẽ trước cho chuyển cảnh (lane chính + overlay) và Retouch overlay video — cùng cơ chế; cần dự án mẫu có chuyển cảnh để đo.
      3. Các việc còn lại của mục 24 (keyframe zoom/pan trên GPU, 1.14, cache cho dự án một batch).
24. **Phiên 13 (2026-10-03): phát hành ffmpeg `.2`; LUT chạy float ở đường CPU; lưu kết quả dò GPU; `hwupload` thay `hwupload_cuda` (GPU nhanh hơn hẳn); dò NVDEC không treo với AV1.**
    **BÀN GIAO PHIÊN 13 -> 14:**
    - **Phát hành `.2`:** xem dòng "PHÁT HÀNH `.2` — XONG" ở mục 23 (push, sửa tag GitHub tự tạo sai, bản ghim, notices; commit `da78d30`).
    - **LUT chạy float ở đường CPU** (commit `1e67bf3`, `WithFloatLut` + nhánh trộn của `ColorAdjustLutBlend`): chèn `format=gbrpf32le|gbrapf32le` trước mỗi lut3d — trước đây lut3d đàm phán rgb24 nên nguồn 10-bit bị hạ 8-bit TRƯỚC LUT. Một LUT tĩnh 39,4 -> 49,3 dB so bản dựng float, không tốn thêm CPU; Yêu Con (đường CPU) so bản chuẩn 42,95 -> 43,87 dB, thời gian 51,8 / 52,7 s. Env tắt `CRABBYCUT_EXPORT_LUTF32=0`. `test:retouch-export`: fixture mép miếng vá 2/255 -> 4/255 (2/255 nay bị LUT nén dưới một mức; đo: 4/255 cho mép cứng 4, mép mềm 1 ở cả hai cách).
    - **Lưu kết quả dò GPU giữa các lần xuất** (commit `4075208`, `GpuProbeResult`, `<temp>/gpu_probe_cache.txt`, khoá = vân tay ffmpeg + NVENC + cỡ/mốc sửa nguồn và video lớp phủ, 3 ngày, xoá khi batch GPU lỗi): Test.crab khâu dò 1,23 -> 0,33 s. `test:export-gpu` kiểm lượt sau dùng cache, lỗi GPU xoá cache.
    - **`hwupload` thay `hwupload_cuda`** (commit `18b2bb1`) — **phát hiện lớn nhất phiên:** hwupload_cuda tự tạo một ngữ cảnh CUDA mới cho MỖI lần xuất hiện (~0,25 s + bộ nhớ GPU), mỗi lớp phủ ảnh/chuỗi khung, mỗi dải đen đệm của clip, nguồn chính đều có một cái. Tìm ra khi phim 4K AV1 (`forever_inside_cut300`) đi GPU CHẬM hơn CPU 44%: chi phí không theo số khung mà theo số lớp phủ (48 lớp: ~13 s dù xuất 20 s hay 60 s), `threadprof` thấy 855 luồng không tên. Kèm: **dò NVDEC thêm `-xerror` + `-t 2`** — AV1 trên GTX 1060 làm lệnh dò đọc hết tệp tới thời gian chờ 20 s.
    - **Số đo sau phiên 13** (phát lại, zip `.2`, 3 lượt, trung vị): **Yêu Con 17,4 s** (CPU 51,8; đầu phiên 22,6); **Bin Tom 9,1 s** (CPU 14,9; đầu phiên 13,3); **Test.crab 9,8 s** (10,5); **phim 4K AV1 300 s 49,3 s** (CPU 58,8; trước sửa 84,4) — GPU so CPU 52,7 dB trung bình, tệ nhất 47,7 dB (7.200 khung mp4).
    - **Hồi quy (sau commit `18b2bb1`):** 52/52 ở zip `.2` GPU tự động, 52/52 ở `CRABBYCUT_EXPORT_GPU=0`.
    - **Phim 39 phút đầy đủ** (`forever_inside_full`, 4K AV1, phụ đề, 14 batch): **GPU 362 s** (cả 14 batch GPU, không lùi) so với CPU 548 s đo ở phiên 5 (−34%). Chưa so chất lượng cả phim (FFV1 quá lớn); bản cắt 300 s đã so (52,7 dB GPU/CPU).
    - **Chuỗi màu tĩnh bake thành LUT** (commit `be5be25`, `BakeColorLut`/`GpuLutFromStages`): eq (số) / colorbalance / curves / lut3d qua mọi tầng màu -> một LUT 33³ (lưới 16-bit do sidecar dựng chạy qua chính chuỗi filter CPU; có eq thì đổi sang YUV bt709/tv), tầng trộn LUT theo keyframe đứng cuối nhận phép tĩnh trước nó vào cả hai cube, `enable` chung -> `mix`. GPU so CPU 46,9 dB; so bản chuẩn thì kém CPU ~1,5 dB khi có eq (bản chuẩn chạy eq 8-bit trên từng điểm ảnh, mang đúng bậc làm tròn của CPU — đã thử 3 cách bake, không cách nào tái tạo được); không eq thì GPU hơn CPU ~5 dB. **Lưu ý cho bộ so 0.3:** dự án dùng nhiều Phơi sáng/Tương phản/Bão hoà có thể trượt tiêu chí (a) dù bằng mắt không khác — cần người dùng quyết nếu gặp.
    - **Clip chưa có bản GPU dựng bằng CPU rồi tải lên NGAY TRONG batch GPU** (commit của phiên 13 sau `be5be25`, `ClipGpuNative`, `g_gpuBatchNvdec`): keyframe zoom/pan, xoay, mặt nạ, hiệu ứng không gian, xoá logo, keyframe màu… không còn kéo cả batch về CPU; batch có clip CPU thì giải mã nguồn bằng CPU. Hồi quy 52/52 (zip `.2`, GPU tự động) sau thay đổi này. Nay chỉ còn batch có lớp phủ text (drawtext) hoặc xuất nhỏ hơn sequence chưa dựng ở cỡ xuất là đi CPU.
    - **1.9 chọn bộ mã hoá bằng phép thử thật — XONG** (`WorkingHardwareEncoder`): trước đây máy AMD/Intel luôn chọn NVENC (có trong `-encoders` của mọi bản ffmpeg), lỗi từng batch rồi về libx264. Nay thử nvenc -> qsv -> amf (3 khung), nhớ ở `%TEMP%/crabbycut_encoder_probe.txt`; dương tính 3 ngày, âm tính 10 phút (cả cache dò GPU cũng vậy — NVENC có thể tạm bận). Kiểm: NVIDIA -> h264_nvenc; giấu CUDA -> libx264 ngay. Chưa có máy AMD/Intel để kiểm thật.
    - **Lớp phủ text (drawtext):** chỉ xuất hiện khi frontend không vẽ được chữ ra PNG (backend: `type: 'text'` khi thiếu `rendered_text_png`) -> hiếm, không làm bản GPU.
    - **1.13 bộ nhớ đệm render cho lượt xuất lại — XONG** (`RenderCacheKey` / `RenderCacheLookup` / `RenderCacheStore`; chi tiết: APP_INTERNALS "Xuất lại dùng bộ nhớ đệm render"). Batch hình (và lượt tiếng — thêm sau commit `2b846cd`) của lượt xuất nhiều batch được dùng lại khi khoá SHA-256 trùng: dòng lệnh, filter script (đường dẫn thay bằng định danh nội dung), nội dung mọi tệp vào (xxHash64 128 bit, nhớ theo đường dẫn/cỡ/mtime trong `file_ids.tsv`), vân tay ffmpeg + bản dựng sidecar + driver GPU. Bản ghép trùng từng khung với bản render lại. Cài đặt › Xuất video › "Dùng lại phần đã render khi xuất lại" (mặc định BẬT); trần 20 GB + 30 ngày; dọn tay ở Cài đặt › Bộ nhớ đệm › "Bản render để xuất lại"; thư mục `<USER_DATA_ROOT>/render_cache` (cùng ổ temp_uploads, cất bằng đổi tên). Mốc cắt batch theo LƯỚI cố định (`NextBatchMark`) và độ dài batch dự án ngắn theo bậc 8/10/12/15… s: sửa một chỗ không kéo lệch mọi batch sau. **Số đo** (phát lại, GTX 1060, cache cả lượt tiếng): **Yêu Con xuất lại 14,7 -> 3,3 s**, **Bin Tom 9,5 -> 3,5 s**, Bin Tom đổi một phụ đề (batch 5/6) 6,3 s, phim 4K 300 s xuất lại ~49 -> 4,7 s (chỉ hình: 4,1 / 5,7 / 6,5 / 10,6 s — lượt tiếng chiếm phần lớn phần còn lại nên cache luôn nó). Lượt đầu đắt thêm ~0,5–1 s (đọc trước khung PNG vừa ghi để băm, chồng lên lượt tiếng; bản SHA-256 tuần tự đầu tiên tốn 6,8–7,3 s). Dự án một batch (Test.crab; dự án ngắn trên máy chỉ 1 lượt hình) và dự án không lớp phủ không dùng cache. Test `test:export-render-cache`.
    - **Ảnh tĩnh lớp phủ hết đúng mép cuối — lỗi có sẵn ở MỌI bản xuất**, lộ ra khi mốc cắt batch đổi (`kStillTailSeconds`, `OverlayEnableEnd`): luồng ảnh tĩnh 25 khung/s hết ở khung ảnh cuối (end − 1/25 s) và framesync coi lớp phủ đã hết ngay đó -> mất khung nền cuối của mỗi ảnh/phụ đề tĩnh (1–2 khung ở 30 khung/s, 2–3 khung ở 60; hai phụ đề nối liền nháy trống); ở batch còn sớm thêm một khung vì `setpts` cắt phần lẻ. Nay luồng ảnh dài dư 0,25 s, `enable` chặn ở end − nửa khung: hiện đúng [start, end) như preview/Premiere (CPU + GPU). `test:export-parallel` kiểm hai mép (bản cũ trượt ở khung 599).
    - **Lớp phủ động chặn mốc cắt chính xác theo cửa sổ `enable`** (`OverlayStraddles`, sau commit `2b846cd`): trước đây nới một khung mỗi đầu nên phụ đề động sát biên clip (bắt đầu sau biên 1 khung / kết thúc trước biên 1 khung) chặn mốc cắt; "Yêu Con" chỉ cắt được ở 2 biên, batch đầu 25,9/37,8 s quyết định cả thời gian xuất. Nay 5 batch: **Yêu Con 17,0 -> 14,7 s** (lần đầu), Bin Tom 9,5 s / phim 300 s 49,3 s không đổi. `test:export-parallel` thêm kịch bản C/D (luật cũ trượt). Còn lại ở Yêu Con: batch 0 [0; 11,7 s] và batch [16,4; 25,9 s] mỗi cái ~11 s — dự án ngắn chỉ cắt ở biên clip (cắt giữa clip lệch pha `fps` khi nguồn khác nhịp, xem 1.8).
    - **Payload gửi sidecar bỏ `editingItems`** (backend, `export_timeline.json`): sidecar không đọc nó, mà item thô còn nguyên ảnh chữ base64 + khung hoạt ảnh (Bin Tom 92 MB) — sidecar quét cả tệp ~1 s trước mọi phép dò. **Bin Tom xuất thường 9,5 -> 8,0 s**, xuất lại khi trùng cache 3,5 -> **2,1 s**, đổi một phụ đề 6,3 -> 4,8 s; Yêu Con 14,7 -> 14,4 s, xuất lại 3,3 -> 2,9 s. Còn lại phía backend: `prepare_ms` 0,6–1,1 s (trong đó `normalize_ms` 0,4–0,8 s — giải base64 + ghi lại khung PNG chữ động mỗi lượt) — đáng đo tiếp.
    - **Đo lượt xuất THẬT trong Electron (gồm vẽ trước ở renderer), Yêu Con:** 50,1 s = vẽ trước 31,7 s (Retouch 28,3 s: bám khuôn mặt 11,3 s + dựng miếng vá ~17 s; chữ động 1,9 s) + server 17,4 s. Bench phát lại KHÔNG thấy phần vẽ trước — với dự án có Retouch nó lớn hơn cả phần render. **Cache bám khuôn mặt chuyển ra `<USER_DATA_ROOT>/retouch_cache`** (trước nằm trong temp_uploads nên mở lại dự án là bám lại): mở lại dự án rồi xuất 48,5 -> **37,9 s** (bám mặt 11,0 -> 0,16 s). Bin Tom (đo 28/09): vẽ trước 7,1 s, phần lớn là chuỗi khung chữ động (5,9 s).
    - **Việc lớn tiếp theo cho lượt xuất lại thật: dựng miếng vá Retouch (~16 s/lượt ở Yêu Con) và chuỗi khung chữ động (Bin Tom 5,9 s) chạy lại ở MỖI lượt xuất** dù không đổi gì — cần cache ở renderer/backend theo khoá (block, tham số, landmark, khung nguồn); khi đó xuất lại Yêu Con có thể còn ~5 s thay vì ~20 s (server đã có cache render). Chưa làm — đụng frontend (retouch.js, editing-runtime.js), cần thiết kế riêng.
    - **Hồi quy cuối phiên 13 (sau commit `adce58d`):** 46/46 (mọi bài export + retouch/retouch-export/retouch-frames/retouch-still + logo-ai + preview-proxy + app-settings + i18n + backend) ở zip `.2`, GPU tự động. Commit của phiên sau bản phát hành .2: `be5be25` (bake LUT), `20e09e4` (clip CPU trong batch GPU), `f475962` (1.9), `2b846cd` (1.13 + ảnh tĩnh), `7530b52` (cache tiếng + mốc cắt), `a91923d` (payload bỏ editingItems), `adce58d` (cache bám mặt Retouch). Chưa push gì lên GitHub.
    - **Cần người dùng xác nhận** (đã làm theo mặc định trong kế hoạch, đổi được bằng một dòng): (1) cache render **bật sẵn** — Premiere ("Use Previews") và Resolve ("Use render cached images") để tắt sẵn vì bản preview của họ có thể kém chất lượng hơn bản xuất; ở đây batch dùng lại trùng từng khung nên bật; (2) trần **20 GB** (như cache SDR); (3) nút dọn đặt ở Cài đặt › Bộ nhớ đệm cạnh các bộ nhớ đệm khác, còn ô bật/tắt ở Cài đặt › Xuất video (kế hoạch ghi nút ở Xuất video). (4) cache bám khuôn mặt Retouch nay sống qua lần mở lại dự án (trước đây cố ý đặt trong temp_uploads để "dọn cùng dữ liệu tạm của dự án"); dọn được ở Cài đặt › Bộ nhớ đệm, tự bỏ mục quá 30 ngày.
    - **Việc kế tiếp (xếp theo lợi ích đo được):**
      1. **Cache bước vẽ trước ở renderer** — giờ là phần lớn nhất của một lượt xuất lại thật: dựng miếng vá Retouch (~16 s/lượt ở Yêu Con, `bakeRetouchSequence` trong `editing-runtime.js`) và chuỗi khung chữ động (Bin Tom 5,9 s) chạy lại ở MỖI lượt xuất dù không đổi gì. Hướng: renderer tính khoá (block, tham số, landmark, khung nguồn, cỡ xuất), hỏi backend đã có bộ khung khoá đó chưa (cache đĩa ngoài temp_uploads, như render_cache) — có thì gửi khoá thay cho hàng trăm tệp khung. Giữ trong bộ nhớ renderer thì tốn ~hàng trăm MB. Cần thiết kế + hỏi người dùng nếu đụng UX.
      2. **Người dùng xác nhận mặc định** của cache render (bật sẵn, 20 GB, chỗ đặt nút dọn) và cache bám mặt Retouch ra ngoài temp_uploads — xem mục "Cần người dùng xác nhận" ở trên.
      3. Clip keyframe zoom/pan trên GPU thật (crabgeo `eval=frame` — cần bản ffmpeg `.3`, người dùng tạo Release): **lợi ích thấp theo số đo** — không dự án mẫu nào có keyframe trên clip lane chính, chỉ một lớp phủ (chuỗi khung có keyframe cỡ ở Yêu Con) đi CpuCanvas. Chỉ đáng làm khi có dự án thật dùng nhiều Ken Burns.
      4. 1.14 chép thẳng đoạn không hiệu ứng (nghiên cứu; mọi dự án mẫu đều có phụ đề nên không áp được); cache render cho dự án một batch / không lớp phủ (hiện đi thẳng một lượt).
      5. Ghi chú không đổi: ProRes không đi GPU (NVENC không có ProRes); máy không có NVIDIA (AMD/Intel) vẫn chỉ CPU — chưa có bản GPU cho AMF/QSV.
23. **Phiên 12 (2026-10-03): 1.21 G2 tiếp — LUT trên GPU (`crabgeo_cuda` lut/lut2/mix) + lớp phủ chưa có bản GPU dựng bằng CPU rồi tải lên. Yêu Con 51 -> 26,6 s.**
    **BÀN GIAO PHIÊN 12 -> 13:**
    - **ffmpeg (bản fork `D:\CrabbyCut_ffmpeg\ffmpeg`, commit `5d00016`):** `crabgeo_cuda` thêm `lut=<.cube>`, `lut2=<.cube>`, `mix=<biểu thức t, n>` — LUT 3D áp lên NỘI DUNG sau phép co (nền đen/trong suốt không đụng), nội suy ba chiều như `lut3d interp=trilinear`, float từ khung nguồn (10-bit giữ nguyên). Có `lut2`: `lut + (lut2 − lut)·mix` (= `blend all_opacity` của ColorAdjustLutBlend); không có: `gốc + (lut − gốc)·mix` (dùng cho `enable` của lớp Điều chỉnh phủ một phần). Nguồn YUV: mẫu màu của khối cho mọi điểm luma (lặp ô), sau LUT hạ mẫu trung bình khối 2×2. **Đã đo các cách xử lý màu 4:2:0** trên nguồn DJI 10-bit, so bản chuẩn của bộ so 0.3: lặp ô + trung bình khối 48,7 dB (chọn); song tuyến mẫu ở mép trái 46,1; bicubic mẫu giữa khối 48,0; hạ mẫu bicubic dọc kiểu swscale 48,1 (đo xung: swscale nâng mẫu yuv420p 8-bit -> gbrp bằng lặp ô, yuv420p10 -> gbrp10 bằng bicubic giữa khối bất kể chroma_location; hạ rgb24 -> yuv420p ngang trung bình 2 cột, dọc bicubic).
    - **Bộ so 0.3 sửa bản chuẩn** (`tests/scripts/export_fidelity.js` GOLD_FORMAT): `format=rgb24` -> `format=gbrpf32le`. Lý do: lut3d đứng trước `format=rgb24` thì đàm phán rgb24 — **đường CPU hạ nguồn 10-bit về RGB 8-bit TRƯỚC LUT** (so bản dựng float: CPU 39,4 dB, GPU 49,3 dB), bản chuẩn cũ mắc y lỗi đó (39,5 dB) nên chấm ngược. Đã gợi ý một phiên riêng để sửa chính đường CPU (chip "Sửa đường CPU: LUT bị hạ về RGB 8-bit trước khi áp").
    - **Sidecar (commit của phiên 12):** `GpuLutAvailable` (dò `lut2` trong `-h filter=crabgeo_cuda`, cache tĩnh, dò sẵn trong luồng gpuProbe); `BlockGpuLut`/`ParseStaticLut`/`GpuLutOptions`/`BlockColorGpuReady` (một tầng màu duy nhất là LUT trộn hoặc đúng một `lut3d` [+ `enable`] -> tuỳ chọn crabgeo; eq/curves/mặt nạ -> CPU); clip và lớp phủ Native nối `GpuLutOptions`. **Lớp phủ: `OverlayGpuModeFor`** — `Native` / `CpuYuv` (lớp phủ yuvStatic chưa có bản GPU: chuỗi CPU tới yuva420p + `hwupload_cuda` trước loop/tpad + crabblend thay overlay=yuv420, trùng từng bit) / `CpuCanvas` (lớp phủ động: ghép RGBA lên khung trong suốt cỡ sequence trong cửa sổ của nó, dời sớm 1 ms, tải lên, crabgeo -> yuva420p alpha_chroma, crabblend (0,0)) / `None` (text). Batch chỉ còn bị kéo về CPU bởi clip (màu không phải LUT, xoá logo, không đi đường nhanh) hoặc text. NVDEC cho video lớp phủ chỉ khi Native. Chi tiết + bẫy ở `docs/APP_INTERNALS.md` mục "Xuất video bằng GPU".
    - **Bẫy đã gặp:** (1) khung trong suốt đúng lưới n/r tới crabblend MUỘN hơn mốc khung luồng chính 1 µs (mốc đã làm tròn µs qua các bộ trộn trước) -> lấy khung trước đó: chuỗi khung keyframe cỡ của Yêu Con chậm một khung ở 2/3 số khung đầu/cuối cửa sổ (28 dB). Chữa: dời sớm 1 ms SAU khi ghép (dời trước khi ghép thì ảnh/video lớp phủ — chỉ sớm 0,1 ms — mất khung đầu). Chưa tái hiện được lỗi này trên dự án tổng hợp (test E qua cả với bản đột biến) — phép kiểm của nó là bộ so 0.3 trên Yêu Con. (2) Ảnh tĩnh lặp: đường CPU (và Native) tắt ảnh sớm một khung ở mép cuối cửa sổ (`eof_action=pass` coi khung lặp cuối hết hạn ngay ở mốc của nó), CpuCanvas hiện đủ — test E miễn đúng khung đó và kiểm GPU có ảnh. (3) LUT đổi kênh (g,b,r) làm khác biệt nâng/hạ mẫu màu giữa crabgeo và swscale dồn vào độ sáng (29 dB ở mép testsrc2 dù cả hai đúng) — test D dùng âm bản.
    - **Số đo (phát lại):** trên zip `n8.1.1-crabbycut.2`, 3 lượt: **Yêu Con 51,1 (CPU) -> 22,1–25,4 s, trung vị 22,6 s** (−56%; batch 0: 45,9 -> ~20 s, CPU 79% -> 26–28%); **Bin Tom 13,1–15,0 s, trung vị 13,3 s** (phiên 10: GPU 15,3–15,8, CPU 14,9 — nay cả 5 batch đi GPU); **Test.crab 11,1–11,4 s** (phiên 10: 11,5–11,7). Bộ so 0.3 trên Yêu Con **ĐẠT** (bản fork dev, cùng mã): so bản chuẩn cũ 42,95 -> mới 46,42 dB, mới/cũ 46,5 dB, VMAF 98,4 (min 94,3), khung tệ nhất 41,2 dB.
    - **Hồi quy 52 test (tests_all.env + export-parallel + export-gpu) — 3 lượt đều 52/52:** zip `.2` GPU tự động; zip `.2` `CRABBYCUT_EXPORT_GPU=0`; zip `.1` (bản đang phát hành, chưa có LUT) GPU tự động — sidecar mới chạy đúng với bản cũ (clip có LUT đi CPU, lớp phủ dựng bằng CPU vẫn đi GPU). `blend_exact.js` 5/5 trên zip `.2`.
    - **Test:** `test:export-gpu` thêm dự án D (LUT tĩnh + LUT trộn theo keyframe; ffmpeg chưa có LUT -> phải đi CPU) và E (video mép mềm = CpuYuv, chuỗi khung keyframe cỡ + ảnh xoay = CpuCanvas, nền phẳng, 30 khung/s, chuỗi khung đúng khung).
    - **Bản ffmpeg `n8.1.1-crabbycut.2`:** repo `D:\CrabbyCut_ffmpeg\ffmpeg-for-CrabbyCut` — `patches/ffmpeg/0003.patch` (LUT; dòng From: danh tính công khai), `CRABBYCUT_VERSION`, README; dựng sạch ở `WORK=D:\CrabbyCut_ffmpeg\rel` (log `rel/build2.log`). Zip `D:\CrabbyCut_ffmpeg\rel\dist\ffmpeg-n8.1.1-crabbycut.2-win64-gpl-shared.zip` (+ `.sha256`), 33.504.908 byte, SHA-256 `410ae0b571aa73957c97bd7c7a7ea18fd0245d6c477d9e7e9f27baf8e9b776e9`; giải nén thử ở `rel/zipcheck2`. Đã commit + tag `n8.1.1-crabbycut.2` TẠI MÁY, **CHƯA push** (phiên 12 không có lệnh cho push).
    - **PHÁT HÀNH `.2` — XONG (2026-10-03, đầu phiên 13):** người dùng tạo Release + tải zip/.sha256 lên; push `main` (`cac54b3..4041ff3`). Release tạo trên web khi tag chưa có ở GitHub nên GitHub tự tạo tag `n8.1.1-crabbycut.2` trỏ `cac54b3` (commit của bản `.1`) — đã ghi đè tag về đúng `4041ff3` (`git push --force origin refs/tags/n8.1.1-crabbycut.2`; Release gắn theo tên tag, zip giữ nguyên). **Lần sau: push tag TRƯỚC rồi mới tạo Release.** Zip tải về từ URL Release: HTTP 200, 33.504.908 byte, SHA-256 khớp. `scripts/ffmpeg_pin.js` + mục FFmpeg của `THIRD-PARTY-NOTICES.md` trỏ sang `.2` (sửa tay, khớp chuỗi generate_third_party_notices.js sinh ra); `installPinnedFfmpeg` chạy vào runtime TẠM: 3,6 s, `installedPinnedFfmpeg` nhận đúng bản, bản cài chạy h264_nvenc, libx264, crabgeo lut/lut2/mix. `test:app-version` xanh. Máy đã cài bản cũ sẽ mở cửa sổ thiết lập một lần để tải ffmpeg `.2` (33,5 MB).
    - ~~Phát hành — việc của người dùng / phiên 13~~ (đã làm, giữ để tra):
      1. Push repo bản vá (cần người dùng cho phép): `git -C D:/CrabbyCut_ffmpeg/ffmpeg-for-CrabbyCut push origin main n8.1.1-crabbycut.2`.
      2. Người dùng tạo Release `n8.1.1-crabbycut.2` trên GitHub cho tag đó, tải lên zip + `.sha256` ở `D:\CrabbyCut_ffmpeg\rel\dist\`.
      3. Kiểm tải về từ URL Release khớp SHA-256, rồi sửa `scripts/ffmpeg_pin.js` của CrabbyCut (id/url/fileName/sha256/sizeBytes/versionPrefix — `build.sh` đã in: url `https://github.com/tamphamdesigner92-tb/ffmpeg-for-CrabbyCut/releases/download/n8.1.1-crabbycut.2/ffmpeg-n8.1.1-crabbycut.2-win64-gpl-shared.zip`, sha256 trên, sizeBytes 33504908), chạy `installPinnedFfmpeg` vào runtime TẠM như phiên 11. **Chưa làm bước 3 thì bản ghim vẫn là `.1`** — app vẫn chạy (LUT đi CPU), chỉ chưa có lợi của LUT trên GPU.
      4. `THIRD-PARTY-NOTICES.md` / `generate_third_party_notices.js`: mục FFmpeg ghi tên bản — đổi sang `.2` cùng lúc với bước 3.
    - **Việc kế tiếp sau phát hành:** sửa đường CPU hạ 8-bit trước LUT (chip đã gợi ý); xoá logo/eq/curves trên GPU (clip còn kéo batch về CPU); chia giải mã NVDEC/CPU giữa các batch song song (Bin Tom); lưu kết quả dò GPU giữa các lần xuất (−0,8 s); dò NVDEC cho video lớp phủ chỉ khi lớp phủ đó là Native (hiện dò mọi video).
22. **Phiên 11 (2026-10-03): 1.21 G5 XONG — bản ffmpeg riêng đóng gói, kiểm, phát hành (Release do người dùng tạo), bản ghim trỏ sang.**
    **BÀN GIAO PHIÊN 11 -> 12:**
    - **Người dùng chốt (2026-10-03):** repo `ffmpeg-for-CrabbyCut` chứa **bản vá + kịch bản** (phương án (i); không đẩy nguyên fork — fork lại là clone nông `--depth 1`, GitHub từ chối đẩy); **cho push** repo đó.
    - **Repo** (bản làm việc `D:\CrabbyCut_ffmpeg\ffmpeg-for-CrabbyCut`, commit `cac54b3`, tag `n8.1.1-crabbycut.1`, đã push): `build.sh [check fetch configure make install package]` (MSYS2 UCRT64; `WORK=` thư mục làm việc, `FFMPEG_SRC=` dựng từ bản fork -> bản `-crabbycut-dev`, không đóng gói được); `CRABBYCUT_VERSION` = tên bản = chuỗi `-version` (qua tệp `VERSION` của FFmpeg) = tag; `patches/ffmpeg/{0001,0002}.patch` + `series`; `msys2-packages.txt`; `scripts/export-patches.sh <fork>` (`PATCH_AUTHOR=` ghi một danh tính tác giả — commit 49ad133 của fork mang địa chỉ email khác với các commit công khai, bản vá trong repo đã đổi sang `tampham.designer92@gmail.com`); `tools/register_filters.py <nguồn> <tên>` (thay `register_filters.py` cũ); `tests/blend_exact.js` (nay có ngưỡng: 4 ca trùng md5, ca độ mờ PSNR ≥ 60 dB — đo 62,06) và `tests/geo_check.js` (đường dẫn qua `FFMPEG_BIN`, `CRABBYCUT_FIXTURES`). Các `patch_*.py`, `rebuild_bg.sh`, `make_bg.sh`, `devbin.sh` cũ ở `D:\CrabbyCut_ffmpeg\` không đưa vào (đã nằm trong commit / thay bằng các bước của build.sh).
    - **Dựng sạch từ đầu** ở `WORK=D:\CrabbyCut_ffmpeg\rel` (clone GitHub FFmpeg `n8.1.1` + nv-codec-headers `n12.2.72.0` GỐC, cài vào `rel/deps` không đụng `/ucrt64`): ~15 phút. Nguồn sau khi áp bản vá trùng từng tệp với fork `6dcb4c0`. **Bỏ bản vá nv-codec-headers `91913cd`** (không còn ai gọi `cuMemAllocHost` từ khi bỏ tải lên qua bộ đệm ghim) — `avutil-60.dll` không còn tên hàm đó.
    - **Hồi quy chữa trước khi phát hành — `vulkan-1.dll`:** `libplacebo-360.dll` của MSYS2 nhập TĨNH `vulkan-1.dll` (avfilter nhập tĩnh libplacebo) -> máy không có driver Vulkan thì ffmpeg.exe không khởi động; bản Gyan nạp Vulkan động nên chưa từng gặp. build.sh nay kèm bộ nạp Vulkan (vulkan-loader 1.4.357, Apache-2.0) và `check_imports` dừng nếu có DLL nhập tĩnh ngoài danh sách DLL của Windows. Đã kiểm: phép dò `vulkanTonemapUsable` chạy với bộ nạp kèm theo.
    - **So với Gyan 8.1.1:** thiếu 52 bộ lọc (opencl, vaapi, frei0r, whisper, rubberband, vidstab, zmq…) và 43 encoder (libvpx, opus, vorbis, webp, svtav1, aom, `*_mf`…) — app không dùng (mã hoá chỉ libx264 / NVENC / ProRes / AAC / mp3lame; `.webm`/`.webp` giải mã bằng bộ giải mã gốc vp8/vp9/opus/vorbis/webp). build.sh kiểm có đủ bộ lọc + encoder app cần trước khi đóng gói.
    - **Zip** `ffmpeg-n8.1.1-crabbycut.1-win64-gpl-shared.zip` (`D:\CrabbyCut_ffmpeg\rel\dist\`): 33.494.956 byte (Gyan 101 MB), SHA-256 `44ec6411ef4e5bad87d2da34ea324f39f65bd349ebf39db222c2d898c415ff88`; `bin/` 43 tệp (chỉ tệp — bộ cài chép phẳng), `LICENSE.txt` (GPLv3), `licenses/` (31 thư mục), `README.txt` (commit FFmpeg + nv-codec-headers, sha256 bản vá, bảng DLL -> gói MSYS2 -> phiên bản -> giấy phép, nơi lấy mã nguồn gói).
    - **Kiểm trên đúng zip** (giải nén bằng tar.exe như bộ cài): `blend_exact` đạt 5/5; lượt "export tí hon" của bộ cài qua cả h264_nvenc lẫn libx264; Vulkan/libplacebo chạy (cả khi giấu CUDA). **Hồi quy 52 test** (tests_all.env + export-parallel + export-gpu, `run_regression_ff.sh`): GPU tự động **52/52**; `CRABBYCUT_EXPORT_GPU=0` **52/52**; giả lập máy không có NVIDIA (`CUDA_VISIBLE_DEVICES=-1`: cuInit báo không có thiết bị, NVENC không mở được, `export-gpu` tự bỏ qua) **51/52** — đỏ `color-adjust` ("mốc mờ=0 phải là identity": 1,67 so với 1,69, ngưỡng < 0,02), **bản Gyan 8.1.1 cũ đỏ y hệt** trong cùng môi trường -> không do bản mới; test sát ngưỡng khi xuất lùi về libx264 (đã tách thành việc riêng). Cũng thấy: khi giấu CUDA, sidecar vẫn chọn `h264_nvenc` rồi mới lùi về libx264 ở từng lượt (máy thật không có NVIDIA thì không có nvcuda.dll nên phép dò trượt ngay — chưa kiểm trên máy thật). **Bộ đo một lượt (phát lại, zip, GPU tự động):** Test.crab 11,8 s (phiên 10: 11,5–11,7), CPU 8%; Bin Tom 15,4 s (15,3–15,8).
    - **Đã push** (người dùng cho phép): `main` + tag `n8.1.1-crabbycut.1` -> https://github.com/tamphamdesigner92-tb/ffmpeg-for-CrabbyCut (`git ls-remote` trùng `cac54b3`).
    - **CrabbyCut (commit của phiên 11):** `scripts/ffmpeg_pin.js` (id/url/fileName/sha256/sizeBytes, `versionPrefix` có dấu cách cuối để `.1` không khớp `.10`, trường mới `sourceUrl`); `generate_third_party_notices.js` + `THIRD-PARTY-NOTICES.md` (CHỈ mục FFmpeg — chạy `npm run notices` còn đổi bảng gói Python theo môi trường máy dev: 73 -> 71 gói, một gói "không khai báo"; không lấy phần đó); `README.md` (mục FFmpeg); `docs/APP_INTERNALS.md` (mục "Xuất video bằng GPU": nguồn bản ffmpeg, build lại, DLL nhập tĩnh).
    - **Release — XONG (2026-10-03):** người dùng tạo Release `n8.1.1-crabbycut.1`, tải lên zip + `.sha256`. Đã kiểm: tải về từ `FFMPEG_PIN.url` HTTP 200, 33.494.956 byte, SHA-256 khớp; chạy đúng `installPinnedFfmpeg` của `setup_runtime.js` vào runtime TẠM (`CRAB_RUNTIME_DIR`/`CRAB_APP_DATA_DIR`, không đụng runtime thật): tải + kiểm SHA + giải nén + kiểm phiên bản 4,0 s, 43 tệp, `pin.json` đúng id, `installedPinnedFfmpeg` nhận là đã cài, lượt "export tí hon" qua cả h264_nvenc lẫn libx264. Còn nên làm: chạy bộ cài trên máy sạch / máy không có NVIDIA khi có. Bản CrabbyCut chứa pin mới phát hành được (nhớ nâng `version` trong package.json); máy đã cài bản cũ sẽ mở cửa sổ thiết lập một lần để tải ffmpeg mới (33,5 MB).
    - **Hoãn:** libvmaf có model dựng sẵn — gói MSYS2 không kèm model, phải tự build libvmaf (meson) mới có; chỉ công cụ đo cần -> chạy `export_fidelity.js` bằng `--ffmpeg-dir` của bản Gyan (`%TEMP%\claude\E--Dev-Windows-App-CrabbyCut\44e67d3b-…\scratchpad\gyan\ffmpeg-8.1.1-full_build-shared\bin`). Tối ưu `--prefix` trong dòng `configuration:` (đang lộ đường dẫn `/d/CrabbyCut_ffmpeg/rel/install`, vô hại).
    - **Bẫy mới:** sửa `build.sh` trong lúc bash đang chạy chính nó -> bash đọc tiếp ở vị trí cũ, báo "syntax error" ở cuối (bước đã chạy vẫn đúng); heredoc của Bash tool ăn `\` (lại gặp khi sửa kịch bản JS).
    - **Việc kế tiếp:** (1) ~~người dùng tạo Release~~ xong; (2) G2 tiếp: `crablut_cuda` (Yêu Con), keyframe vị trí/cỡ + hoạt ảnh lớp phủ; (3) chia giải mã NVDEC/CPU giữa các batch song song (Bin Tom); (4) lưu kết quả dò GPU giữa các lần xuất (−0,8 s). Bản vá mới: commit vào fork `D:\CrabbyCut_ffmpeg\ffmpeg`, `export-patches.sh`, tăng `CRABBYCUT_VERSION`, dựng sạch, chạy hồi quy trên zip, tag + Release, sửa `ffmpeg_pin.js`.
21. **Phiên 10 (2026-10-02): 1.21 — G3 (sidecar dựng đồ thị GPU) + G4 (Cài đặt) XONG, chữa chạy đua GPU — xem "BÀN GIAO PHIÊN 10 -> 11" ngay dưới; phần bàn giao phiên 9 bên dưới giữ để tra (các bước 1–6, 8 của nó đã làm).**
    **BÀN GIAO PHIÊN 10 -> 11:**
    - **G4 xong:** `static/js/app-settings.js` mục `export.renderDevice` ('gpu' | 'cpu', mặc định 'gpu'; cấu hình cũ -> 'gpu'); `static/js/settings-panel.js` mở mục "Xuất video" (ô "Render bằng"); backend gửi `render_device` theo cài đặt (route xuất video), report thêm `[render_device]` và ` gpu`/` gpu_fallback` từng lượt. Chuỗi mới có bản dịch en/zh.
    - **Chữa kèm:** `test:logo-ai` đỏ từ `83b8307` (phiên 8): video lớp phủ sớm thêm `kOverlayTieEpsilon` mà `/TB` cắt phần lẻ khác nhau trên timebase của video (1/15360) và của luồng miếng vá AI (1/90000) -> miếng vá lệch một khung. Lớp phủ có xoá logo AI nay `settb=AVTB` trước `setpts` (OverlayTimingChain).
    - **Bản ffmpeg riêng thiếu libmp3lame** (`test:image-proxy` đỏ: test tạo tệp mp3 mẫu; app không mã hoá MP3). Đã thêm `--enable-libmp3lame` vào `D:\CrabbyCut_ffmpeg\build.sh` + `devbin.sh` chép DLL phụ thuộc theo `ldd`. Khi đưa bản build vào repo (G5) phải chạy CẢ bộ hồi quy 52 test trên nó, không chỉ `test:export-all`.
    - **G3 xong** (sidecar, commit của phiên 10): `GpuRenderWanted` / `GpuRenderAvailable` (thử trọn chuỗi tải lên -> crabgeo `sync=1` -> NVENC) / `NvdecDecodes` (co một nửa — crabgeo chỉ co tối đa ~15 lần) chạy `std::async` cùng các phép dò khác; `GpuUploadFormat` (yuv420p/nv12/p010/yuv444p; 4:2:2 thì clip đi CPU); `ClipGpuEligible` / `OverlayGpuEligible` / `BatchGpuEligible` (thêm ngưỡng co `kGpuMinScale` 1/15, ảnh RGBA 2/15); `PrepareExportBatch` ghi thêm `export_filter_batch_N_gpu.txt`, `BatchJob` giữ cả lệnh CPU (`buildCmdCpu`, `UseCpuGraph`); `RunExportJobs` chạy lại batch GPU lỗi bằng đồ thị CPU trước logic lùi NVENC; video lớp phủ NVDEC không giải mã được thì tải lên `yuva420p`; nguồn không nhãn -> `in_matrix=bt709` thay setparams. Report sidecar có `render` và `gpu`/`gpu_fallback` từng lượt. Env: `CRABBYCUT_EXPORT_GPU=0|1` (ép), `CRABBYCUT_EXPORT_GPU_TEST_FAIL=1` (chỉ cho test).
    - **Chạy đua GPU — ĐÃ CHỮA ở bản ffmpeg riêng (commit `6dcb4c0`):** bản đầu để GPU chạy không đồng bộ ra khung RÁCH (hàng 0–671 của khung cũ, NVENC đọc khi kernel chép chưa xong) và lớp phủ chữ hiện khung cũ hơn 6 / mới hơn 2 — chỉ lộ khi luồng lọc chạy trước GPU (ra thẳng NVENC; ra FFV1 qua `hwdownload` thì che mất), nhiều nhất khi 3 batch chạy song song. Chưa tìm ra gốc (mọi lệnh đều trên stream NULL; vá NVENC chờ stream trước khi mã hoá KHÔNG chữa được). Cách chữa: crabgeo/crabblend `sync=1` (mặc định) + `hwcontext_cuda` chờ cả lúc tải lên; bỏ đường tải lên qua bộ đệm ghim của phiên 9 (lộ lỗi cả khi ra FFV1). Đo: 9/9 lượt song song sạch, thời gian như cũ. Bin Tom trọn lượt (3 batch GPU song song) 4/4 lượt: 0 khung dưới 38 dB so với bản CPU.
    - **Số đo trọn lượt (phát lại, devbin):** Bin Tom GPU 15,3–15,8 s so với CPU 14,9 s (đúng dự đoán phiên 9: NVDEC GTX 1060 giải mã H.264 1080p chậm hơn CPU 16 luồng; CPU 42% thay vì 72%). **Test.crab GPU 11,5–11,7 s so với CPU 14,3–14,6 s (−19%; phần ffmpeg 9,6 so với 13,2–13,5 s), CPU 19–21% thay vì 78–80%, NVDEC ~70–80%** — nhờ cho lớp phủ chỉ có keyframe độ mờ đi biểu thức `opacity` của crabblend (commit `c7045d5`). Bộ so 0.3 trên Test.crab ĐẠT: so bản chuẩn 45,46 (CPU) -> 48,0 dB (GPU), mới/cũ 51,8 dB, VMAF 99,0 (đường CPU ghép lớp keyframe ở RGB nên kéo cả batch qua YUV -> RGB -> YUV; GPU giữ YUV). Yêu Con chưa đi GPU (chuỗi màu LUT — chờ `crablut_cuda`).
    - **Chi phí dò GPU ở đầu lượt:** ~0,8 s (khâu dò Test.crab 0,4 -> 1,2 s) — đã gộp dò nguồn chính NVDEC -> crabgeo -> NVENC trong một tiến trình (từ 1,4 s). Còn lại: lệnh dò NVDEC riêng của từng video lớp phủ chạy song song tranh khởi tạo CUDA. Hướng: lưu kết quả dò theo (đường dẫn, cỡ, mtime, bản ffmpeg, driver) giữa các lần xuất.
    - **Bản ffmpeg riêng chưa ngang bản Gyan ở libvmaf:** không có model dựng sẵn (`export_fidelity.js` báo "could not load libvmaf model vmaf_v0.6.1") — chạy bộ so bằng ffmpeg khác, hoặc build libvmaf có model khi làm G5.
    - **Test:** `npm run test:export-gpu` (mới, `tests/scripts/export_gpu.js`) — dự án A: 3 batch song song, batch có clip chỉnh màu đi CPU, 3 chuỗi khung đúng khung, video lớp phủ 150% độ mờ 60%, ảnh tĩnh alpha toạ độ lẻ, nguồn không nhãn; đồ thị GPU hỏng -> lùi về CPU trùng từng khung; dự án B: H.264 10-bit (giải mã CPU, tải lên p010); dự án C: keyframe độ mờ. BỎ QUA khi ffmpeg không có bộ lọc CUDA của CrabbyCut. `export_fidelity.js` dựng được bản không mất mát từ lệnh GPU.
    - **Hồi quy cuối phiên (52 test = tests_all.env + export-parallel + export-gpu):** devbin GPU tự động 52/52; BtbN N-123955 52/52 (export-gpu tự bỏ qua). Lượt đầu trên devbin đỏ `image-proxy` (thiếu libmp3lame — đã thêm) và `logo-ai` (hồi quy 83b8307 — đã chữa).
    - **Việc kế tiếp:** G5 (người dùng đã chốt nơi phát hành — xem ngay dưới) và G2 tiếp (`crablut_cuda` cho Yêu Con; keyframe vị trí/cỡ + hoạt ảnh lớp phủ — keyframe độ mờ đã xong). Thứ tự đề xuất: G5 trước (đóng gói được thứ đã xong, app thật mới dùng được GPU), rồi G2. Hướng mở: Bin Tom chậm vì NVDEC bão hoà khi 3 batch cùng giải mã -> chia giải mã NVDEC/CPU giữa các batch; lưu kết quả dò GPU giữa các lần xuất (−0,8 s).
    - **G5 — người dùng chốt 2026-10-02: phương án B, repo riêng `https://github.com/tamphamdesigner92-tb/ffmpeg-for-CrabbyCut.git`** (đã loại: A asset trên Releases của repo CrabbyCut; C gói vào bộ cài). Lúc ghi, `git ls-remote` tới repo trả về rỗng = repo đã có nhưng **còn trống**.
    - **G5 — VIỆC CHO PHIÊN 11 (theo thứ tự):**
      1. **Hỏi người dùng nội dung repo** trước khi đẩy (ý kiến của phiên 10: (i) — nhẹ, dễ đọc, vẫn đủ nguồn):
         - (i) chỉ kịch bản build + bản vá (`git format-patch n8.1.1..crabbycut-8.1.1`, bản vá nv-codec-headers) + README + giấy phép; người build tự clone ffmpeg `n8.1.1`;
         - (ii) đẩy nguyên nhánh `crabbycut-8.1.1` của fork (`D:\CrabbyCut_ffmpeg\ffmpeg`, remote hiện chỉ trỏ `file:///E:/Dev/Windows_App/ffmpeg`) — lịch sử ffmpeg vài trăm MB.
         Push là việc ra ngoài: **xin phép người dùng trước khi push**, máy không có `gh` nên tạo Release/tải asset lên do người dùng làm (hoặc dùng git + trình duyệt nếu họ bảo).
      2. Gom về một chỗ trong repo mới những thứ đang nằm rải ở `D:\CrabbyCut_ffmpeg\` (KHÔNG dưới git): `build.sh` (đã có `--enable-libmp3lame`), `rebuild_bg.sh`, `make_bg.sh`, `devbin.sh` (chép DLL theo `ldd`), `register_filters.py`; các `patch_*.py` là công cụ một lần của phiên 9 — xem lại, bỏ cái đã vào commit. Kiểm: bản vá nv-codec-headers `91913cd` (`cuMemAllocHost/cuMemFreeHost`) chỉ phục vụ đường tải lên bộ đệm ghim đã BỎ ở `6dcb4c0` -> có thể không cần nữa (bỏ thì build lại + chạy lại test).
      3. Kịch bản đóng gói: `devbin` -> zip (cấu trúc thư mục giống zip Gyan `ffmpeg-8.1.1-full_build-shared` mà `ffmpeg_pin.js` đang giải nén, hoặc sửa `ffmpeg_pin.js` cho khớp) + in SHA-256. Tên bản đề xuất `n8.1.1-crabbycut.N`. **Giấy phép:** build có `--enable-gpl --enable-version3` (x264, x265) -> bản nhị phân là GPLv3; repo phải có mã nguồn tương ứng (bản vá + kịch bản + phiên bản thư viện), kèm LICENSE/README nêu rõ. Không bật `nonfree`.
      4. libvmaf có model dựng sẵn (hiện `export_fidelity.js` báo "could not load libvmaf model vmaf_v0.6.1") để ngang bản Gyan — chỉ công cụ đo dùng, app không cần.
      5. `scripts/ffmpeg_pin.js`: `url` (dòng 29, đang là `GyanD/codexffmpeg/releases/download/8.1.1/...`) -> asset Release của repo mới, `sha256` (dòng 32) mới; kiểm `test:app-version`/test liên quan tới ghim nếu có. Máy KHÔNG có NVIDIA vẫn phải chạy được bản này (CUDA nạp động; đã thấy `export-gpu` tự bỏ qua khi GPU không dùng được — nên thử thêm một lượt với `CUDA_VISIBLE_DEVICES=-1` hoặc trên máy khác).
      6. Chạy CẢ bộ hồi quy 52 test (tests_all.env + export-parallel + export-gpu) trên đúng bản zip đã giải nén, ở GPU tự động và `CRABBYCUT_EXPORT_GPU=0`; bộ đo Test.crab/Bin Tom một lượt để xác nhận số như phiên 10.
      7. Ghi `docs/APP_INTERNALS.md` (mục "Xuất video bằng GPU": nguồn bản ffmpeg, cách build lại) + cập nhật mục này. macOS giữ đường hiện tại (Bước M).
20. **Phiên 9 (2026-10-02): 1.21 bộ ghép GPU riêng — ĐANG LÀM.** Người dùng chốt **tự build ffmpeg + bộ lọc CUDA riêng** và **Cài đặt chọn GPU/CPU, mặc định GPU** (lý do + số đo ở mục 1.21).
    **BÀN GIAO PHIÊN 9 -> 10 (đọc trước khi làm tiếp):**
    - **Đã xong, đã commit:** `5b3066c` (1.12 pha 2 bật mặc định), `204b3b4` (doc 1.21). Repo ffmpeg riêng `D:\CrabbyCut_ffmpeg\ffmpeg` nhánh `crabbycut-8.1.1` commit `49ad133`; `D:\CrabbyCut_ffmpeg\nv-codec-headers` nhánh `crabbycut-12.2` commit `91913cd`. **Chưa push gì.** Phần người dùng đã stage (index.html, en.json, zh.json) vẫn nguyên — commit bằng `git commit -- <tệp>` để không gộp.
    - **G0 XONG:** bản ffmpeg 8.1.1 tự build (`n8.1.1-crabbycut`, `D:\CrabbyCut_ffmpeg\install\bin`, 88 MB, 39 DLL) qua **36/36 test export** (`PATH="/d/CrabbyCut_ffmpeg/install/bin:$PATH" npm run test:export-all`). Lưu ý: `install/bin` là bản TRƯỚC khi thêm bộ lọc; bản mới nhất ở `D:\CrabbyCut_ffmpeg\devbin` (chưa chạy 36 test trên devbin).
    - **G1 XONG** (trong commit `49ad133`): fftools không dựng lại đồ thị khi chỉ `hw_frames_ctx` đổi; `hwdownload` nhận khung từ vùng nhớ tương thích; `hwcontext_cuda` chép hàng màu cuối khi cao lẻ + **tải lên qua bộ đệm ghim** (chép H2D từ bộ nhớ pageable ngầm chờ cả stream). NVDEC ra thẳng khung CUDA đi qua chỗ nối SPS của temp_input đúng 300/300 khung.
    - **G2 phần đầu XONG:** `crabblend_cuda` (trùng TỪNG BIT với `overlay=format=yuv420` ở 4/5 ca, ca độ mờ 62 dB — `node D:/CrabbyCut_ffmpeg/tests/blend_exact.js`); `crabgeo_cuda` (lọc tách được, chép thẳng khi 1:1; NV12->yuv420p trùng từng bit; 4K bt601 full -> 1080p bt709: so bản chuẩn 53,3 dB so với CPU 44,6; HEVC 10-bit 52,3 so với 54,7; PNG RGBA->yuva420p 77 dB — `node D:/CrabbyCut_ffmpeg/tests/geo_check.js`). Tốc độ 4K->1080 ~1,4 ms/khung, chép 4K ~0,5 ms. Cả hai khai ma trận/dải màu riêng từng ngõ (không thì ffmpeg chèn `scale` CPU vào đường CUDA).
    - **Số đo đồ thị GPU dựng tay** (D:/CrabbyCut_ffmpeg/tests/to_crab.js, tc_gpu.txt): **Test.crab 14,0 -> 10,0 s (−29%), CPU 134 -> 4,5 CPU-giây**; Bin Tom 8,0 -> 8,8–9,3 s (+12%, chậm hơn) vì NVDEC của GTX 1060 giải mã H.264 1080p chỉ ~620 khung/s (CPU 16 luồng ~1.000) — một dòng đơn lẻ thì GPU vẫn nhanh hơn (1,13 so với 1,24 s). CPU giải mã + tải lên chậm hơn NVDEC khi chạy nhiều batch (13 s). Hướng mở: chia giải mã NVDEC/CPU giữa các batch song song khi NVDEC bão hoà.
    - **G3 ĐANG DỞ — sidecar CHƯA COMMIT** (`git diff native/sidecar/core_process.cpp`; bản sao `D:CrabbyCut_ffmpegwip_sidecar_G3.patch`, build được, `test:export-parallel` xanh; hành vi xuất CHƯA đổi vì chưa có chỗ bật). Đã có: `ExportSettings::renderDevice` + đọc `render_device` từ payload; biến `g_gpuGraph`/`g_gpuMainNvdec`; nhánh GPU trong đường nhanh của `WriteClipVideoFilters` (crabgeo_cuda, `hwupload_cuda` khi giải mã CPU, nền đen `format=yuv420p,hwupload_cuda`); tách `WriteOverlaySetpts`/`OverlayTimingChain` dùng chung; `WriteVisualOverlayFilterGpu`; cờ `gpu`/`gpu_fallback` trong timing + `render`. **Còn phải làm (theo thứ tự):**
      1. `GpuOutputFilters(settings)`: đuôi đồ thị GPU = `crabgeo_cuda=format=yuv420p:passthrough=0` (NVENC chỉ nhận khung từ MỘT vùng nhớ) + đệm/co khi OutputResized + `setsar=1,setparams=...`; gọi trong WriteFilterScript khi `g_gpuGraph`, và gọi `WriteVisualOverlayFilterGpu` thay bản CPU.
      2. `GpuRenderWanted` (env `CRABBYCUT_EXPORT_GPU=0|1`, `renderDevice != "cpu"`), `GpuRenderAvailable` (có `crabgeo_cuda`+`crabblend_cuda` + lệnh dò CUDA ~0,3 s, cache tĩnh), `NvdecDecodes(path)` (lệnh `-hwaccel cuda -hwaccel_output_format cuda -i src -frames:v 2 -vf crabgeo_cuda=w=16:h=16 -f null -`, exit 0 = giải mã được; chạy std::async cùng các phép dò khác trong CommandExportVideo). Chỉ bật khi encoder là NVENC và codec != prores.
      3. `BatchGpuEligible`: mọi clip `MainLaneFastPlan.ok` + không chỉnh màu/xoá logo (logoMode/logoRects/logoAiDir)/mặt nạ; mọi lớp phủ hình: không phải text, không keyframe/hoạt ảnh/xoay/màu (BlockColorStages rỗng)/mặt nạ/feather/lật/xoá logo, video phải NvdecDecodes. Không đạt -> batch đi đồ thị CPU (trộn được trong một lượt xuất vì cùng NVENC).
      4. `PrepareExportBatch`: batch đạt thì ghi THÊM `export_filter_batch_N_gpu.txt` (đặt g_gpuGraph/g_gpuMainNvdec, cùng g_clipVideoInput), lệnh GPU = `-init_hw_device cuda=cu -filter_hw_device cu` sau `-nostdin` + `-hwaccel cuda -hwaccel_device cu -hwaccel_output_format cuda` trước `-i` nguồn chính (và các input dải) khi NVDEC được, trước `-i` video lớp phủ (AppendOverlayInputArgs thêm cờ). BatchJob giữ cả lệnh/script CPU (`buildCmdCpu`, `cpuScriptPath`).
      5. `RunExportJobs`: job GPU lỗi -> chạy lại bằng đồ thị CPU (timing.gpuFallback) TRƯỚC logic lùi NVENC->CPU hiện có; xoá cả script GPU khi không đo.
      6. Test mới `tests/scripts/export_gpu.js` (so GPU với CPU từng khung, ngưỡng PSNR như 0.3; ca: clip co/đặt lệch/lẻ, nguồn bt601 full, ảnh tĩnh alpha, chuỗi khung, video lớp phủ, độ mờ, batch hỗn hợp GPU/CPU, lùi khi lỗi) + chạy 36 test ở cả `CRABBYCUT_EXPORT_GPU=0` và `=1` trên devbin; bộ đo Bin Tom/Test.crab/Yêu Con.
      7. G2 tiếp: `crablut_cuda` (LUT 3D + trộn 2 LUT theo cường độ — Yêu Con), keyframe lớp phủ (vị trí/scale/độ mờ biểu thức: crabblend đã nhận biểu thức `opacity` theo `t`), rồi các hiệu ứng còn lại hoặc tải xuống/chạy CPU/tải lên.
      8. G4: Cài đặt › Xuất video (`static/js/settings-panel.js` mục `export` đang `ready:false`, `static/js/app-settings.js` normalize) "Render bằng: GPU / CPU", mặc định GPU; backend đọc app_settings rồi gửi `render_device` xuống sidecar. Chuỗi i18n mới: en.json/zh.json đang được NGƯỜI DÙNG stage — commit riêng hunk của mình.
      9. G5: đưa build.sh + bản vá ffmpeg vào repo (ví dụ `native/ffmpeg/`, `git format-patch` từ nhánh crabbycut-8.1.1), nơi phát hành bản build (hỏi người dùng), `scripts/ffmpeg_pin.js`.
    - **Công cụ trên máy:** MSYS2 `D:\msys64` (UCRT64: gcc 16.2, clang 22 có NVPTX, nasm, các thư viện); build: `MSYSTEM=UCRT64 /d/msys64/usr/bin/bash.exe -lc "bash /d/CrabbyCut_ffmpeg/rebuild_bg.sh [configure] && bash /d/CrabbyCut_ffmpeg/devbin.sh"` (log `D:\CrabbyCut_ffmpeg\dl\rebuild.log`); thêm bộ lọc mới: `register_filters.py <tên>` rồi `rebuild_bg.sh configure`. **Sửa header ffnvcodec (`/ucrt64/include`) thì phải `make clean`** (make không theo dõi header hệ thống -> segfault). Đo A/B phải xem exit code từng lượt (lượt sập chạy "nhanh"). Công cụ đo (đã chép khỏi scratchpad): `D:/CrabbyCut_ffmpeg/tools/` — threadprof.exe (CPU từng luồng ffmpeg: `threadprof.exe <tiền tố> <lệnh...>`), fx.js (chạy danh sách lệnh JSON, in CPU-giây/khung), runjobs.js (chạy jobs.json GPU/CPU song song, báo lượt lỗi); kịch bản đo/kiểm ở `D:/CrabbyCut_ffmpeg/tests/` (blend_exact.js, geo_check.js, to_crab.js, par4.js, steps.json, tc_gpu.txt).

- **Câu hỏi 1.12 pha 2 — người dùng trả lời 2026-10-02: BẬT** (miễn tiêu chí (a) cho mục đổi thứ tự lấy mẫu vì (b) đạt). 36/36 test export xanh với pha 2 mặc định. Các câu trước: (a)–(e) trả lời 2026-09-29, khổ lệch của 1.12 trả lời 2026-09-30, ô Bitrate của 1.20 trả lời 2026-10-01 (xem bảng "Quyết định đã chốt").
- `CrabbyCut_Private`: chưa port gì của phiên 2–3. Mục trung lập để port (M.2): phần đo (sidecar + backend + renderer), 1.15, 1.1a, 1.17, 1.3, 1.5, ảnh tĩnh một lần.

**Công cụ và dữ liệu có sẵn trên máy dev:**
- Gyan 8.1.1 shared đã giải nén: `%TEMP%\claude\E--Dev-Windows-App-ffmpeg\30de9403-…\scratchpad\dl\gyan\ffmpeg-8.1.1-full_build-shared\bin`. Thư mục scratch có thể đã bị dọn; nếu mất thì tải lại theo `scripts/ffmpeg_pin.js` và kiểm SHA-256.
- ffmpeg trong PATH của máy dev vẫn là BtbN N-123955 (`C:\ffmpeg-master-latest-win64-gpl\bin`). Bộ đo/bộ so có `--ffmpeg-dir`; test thì đưa thư mục Gyan lên đầu PATH (dạng `/c/Users/...` trong bash — dạng `C:/...` bị bash cắt ở dấu `:`).
- Fixture bộ đo đã có payload ghi sẵn trong `test_temp/bench_export/` (`Bin_Tom_-_Tap_3`, `forever_inside_cut300`, `forever_inside_full`), chạy lại bằng `--replay-only`.
- Chạy test khi app/backend **đang tắt**.

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
| Tiêu chí chất lượng (2026-09-29) | **Nới ngưỡng "PSNR mới/cũ ≥ 45 dB"**: được miễn khi bản mới gần bản chuẩn hơn bản cũ ≥ 1 dB. VMAF ≥ 95 và ngưỡng khung tệ nhất giữ nguyên. Lý do: 1.3 + 1.5 trên Bin Tom mới/cũ 43,5 dB nhưng so bản chuẩn 40,3 → 52,5 dB. Kéo theo: **1.5 bật mặc định** |
| Lưu bản xuất (2026-09-29) | **Hỏi chỗ lưu TRƯỚC khi xuất**, như Premiere; ffmpeg ghi thẳng ra file đích — bỏ vòng tải file qua HTTP và bản sao trong `blob_storage` (mục 1.16) |
| Preview khi mở dự án (2026-09-29) | **Không tự phát**; playhead đứng ở đầu clip đầu (mục 1.17) |
| Khổ preset khác khổ sequence (2026-09-30) | **Như Premiere** ("Scale To Fit"): đúng cỡ preset, hình co vừa, viền đen hai bên hoặc trên/dưới; preset Dọc/Vuông giữ nghĩa. Không theo kiểu CapCut (preset = cạnh ngắn) (mục 1.12) |
| Bản hạ SDR (2026-09-29) | **Giữ trong cache có giới hạn** ngoài `TEMP_DIR` (kiểu `proxy_cache`, có trần và tự dọn), để mở lại dự án không phải hạ SDR lại (mục 1.15) |
| 1.12 pha 2 (2026-10-02) | **Bật mặc định**: xuất nhỏ hơn sequence thì dựng cả đồ thị ở cỡ xuất. Miễn tiêu chí (a) "gần bản chuẩn ít nhất bằng bản cũ" cho mục này vì bản chuẩn chính là cách cũ (dựng ở cỡ sequence rồi co); (b) đạt (PSNR 49,9 dB, VMAF 97,6) |
| GPU (2026-10-02) | **Máy có GPU thì dồn việc xuất sang GPU** (giải mã, ghép, mã hoá), chỉ máy không có GPU mới xuất bằng CPU. Người dùng thấy lúc xuất GPU chỉ 30–50% còn CPU gần 100% (mục 1.21) |
| Nơi phát hành bản ffmpeg riêng (2026-10-02, G5 của 1.21) | **Repo riêng**: https://github.com/tamphamdesigner92-tb/ffmpeg-for-CrabbyCut.git (phương án B; đã loại A = asset trên Releases của repo CrabbyCut, C = gói vào bộ cài +~90 MB). Bộ cài vẫn tải bản ghim + kiểm SHA-256 như hiện nay, chỉ đổi nguồn (`scripts/ffmpeg_pin.js`) |
| Nội dung repo ffmpeg-for-CrabbyCut (2026-10-03) | **Bản vá + kịch bản build** (~150 KB; build.sh tự clone FFmpeg n8.1.1), không đẩy nguyên cây nguồn/fork. Cho phép Claude push repo đó |
| Bitrate bản xuất (2026-10-01) | **Ô "Bitrate" kiểu CapCut** thay ô "Chất lượng": Thấp hơn / Khuyến nghị (mặc định) / Cao hơn / Tùy chỉnh. Ba mức đầu **theo chất lượng, có trần** (NVENC `-cq` 23/19/16, CPU CRF 23/18/16; trần = bitrate cố định cũ của Cân bằng / Cao / 2×Cao). Tùy chỉnh nhập **Mbps** (trung bình, đỉnh ×1,5). Khoá khi ProRes (mục 1.20) |

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
   - Commit: **xong**, `0508bd0` trên `main`, chưa push (người dùng chọn 2026-09-27).
   - Phát hành: **chưa**, người dùng chọn để sau. `main` đang có 12 commit từ `v1.1.12`, trong đó có lồng tiếng "chưa test xong". Xem "VIỆC TIẾP THEO" mục A.2.
   - Port sang `CrabbyCut_Private`: **xong, chưa commit**. `git apply` không áp sạch nên đã port tay.
     - Đã port: `-/filter_complex` ở 3 chỗ, `-reinit_filter:v 0`, test treo, sửa đuôi `.exe` ở 2 test, `-fps_mode`.
     - Chưa bỏ lượt xuất hai pha (M.3).
     - Test trên Windows bằng Gyan 8.1.1: `export-concat-video-overlay`, `export`, `video-anim`, `overlay-placement` xanh. Hai test đỏ có sẵn, xem "VIỆC TIẾP THEO" mục A.3.

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

## Kết quả Bước 0 (thi công 2026-09-28)

### Dụng cụ đã có

**0.1 Tách thời gian theo khâu — xong.**
- Sidecar (`core_process.cpp`, khối "ĐO THỜI GIAN EXPORT" cạnh `HardwareExportEnabled`):
  - **luôn bật**: bấm giờ từng lượt ffmpeg của `ExportBatch`, cuối lượt phát sự kiện `timing` (JSON: `probe_ms`, `plan_ms`, `concat_ms`, và mỗi lượt `label/mode/intervals/overlays/source_from/source_to/run_ms`). `source_to` = lượt đó giải mã nguồn từ giây 0 tới đâu.
  - `CRABBYCUT_EXPORT_BENCH=1`: giữ filter script, ghi `<temp>/export_bench/<nhãn>.cmd.json` (dòng lệnh đúng từng tham số + cwd), `.log` (FFREPORT mức INFO, có dòng `bench:` của `-benchmark`), `.progress.txt` (`-progress`), `.graphs.json` (`-print_graphs_file`, chỉ khi ffmpeg có). Đường dẫn trong các cờ là **tương đối** theo cwd = temp, vì FFREPORT coi `:` và `\` là ký tự đặc biệt.
  - Đổi so với kế hoạch: biến thể `-f null` và chỉ-giải-mã **không** nằm trong sidecar mà trong bộ đo (`--split`), chạy lại từ `cmd.json`. Sidecar giữ gọn, và biến thể nào cũng thêm được mà không build lại C++.
- Backend (`/api/export-video`): mốc `upload_ms`, `sdr_overrides_ms`, `normalize_ms`, `prepare_ms`, `sidecar_ms`, `verify_ms`, `server_ms`; header `X-Export-Timing`. Báo cáo dự án có thêm `overlay_count`, sequence, độ dài timeline/bản ra, codec + định dạng + xoay của `temp_input.mp4`, `client_prebake_ms` (+ chi tiết), các khâu server, và một dòng cho mỗi lượt ffmpeg.
- Renderer: `performVideoExport` đo `main_lane_ms`, `editing_payload_ms` (tách `text_png`, `shape_png`, `anim_seq`, `retouch`, `color`, `transition` trong `exportPayload`), `serialize_ms`, `request_ms`, `download_ms`, `total_ms` → `window.__crabLastExportTiming`; phần vẽ trước đi kèm FormData (`client_timing_json`) để vào báo cáo.
- Lấy mẫu CPU bằng `os.cpus()` (không phụ thuộc ngôn ngữ Windows như `typeperf`) và GPU bằng `nvidia-smi dmon`, nằm trong bộ đo.
- Chưa làm: lượt đo với thư mục tạm loại trừ khỏi Defender (tuỳ chọn, người dùng tự bật).

**0.2 `npm run bench:export` — xong** (`tests/scripts/bench_export.js`, viết lại từ bản `1bb3be8`).
- (b) một lượt thật trong Electron (CDP, user-data-dir riêng, cờ chống bóp nhịp khi bị che): `openProjectByPath()` → `performVideoExport()`. Backend chạy trong tiến trình bộ đo với `CRABBYCUT_EXPORT_CAPTURE_DIR`, nên payload (cả khung chuyển cảnh) được ghi lại. Có đo CPU của Electron và một CPU profile renderer 15 s giữa lượt xuất.
- (a) phát lại payload đó `--runs` lần qua HTTP; `--replay-only` dùng payload cũ. `--cut N` = bản cắt N giây cùng cấu trúc (sửa trạng thái trong renderer, không ghi .crab). `--env K=V`, `--cpu`, `--ffmpeg-dir`, `--tag`.
- Mọi thứ nằm trong `test_temp/bench_export/<fixture>/` (temp, cache nối, userdata, `capture/`, `runs/<giờ>_<tag>/<n>/`). Kết quả `reports/perf_export_<fixture>[_<tag>]_<giờ>.json`.
- Fixture đã dựng: 1 ("Bin Tom - Tap 3"), 9 (phụ đề 39 phút: bản đầy đủ + bản cắt 300 s). Các fixture 2–8, 10, 11 **chưa dựng**; `--lavfi` là ca kiểm nhanh bộ đo.

**0.3 Bộ so chất lượng — xong** (`tests/scripts/export_fidelity.js`), với hai điểm khác kế hoạch:
- **Bản chuẩn là 10-bit 4:4:4, không phải 16-bit**: `overlay` không có định dạng nào trên 10-bit (`vf_overlay.c:155-229`). Bản chuẩn = đồ thị của lượt cũ, `format=rgba`/`yuva420p` → `scale=out_color_matrix=bt709:out_range=tv,format=yuva444p10le`, `format=yuv420p` → `yuv444p10le`, mọi `overlay` → `format=yuv444p10`, ra FFV1.
  - Phải ghi rõ ma trận: `format=` trần làm swscale đổi RGB→YUV bằng BT.601, còn đường cũ đổi ở cuối bằng BT.709. Lần dựng đầu thiếu bước này và bản cũ chỉ cách bản chuẩn 33,4 dB; có nó thì 40,3 dB (Bin Tom).
- **So trên bản lossless của đồ thị, không trên mp4**: `bench:export --lossless` chạy lại `cmd.json` của lượt đó với FFV1 (`lossless.mkv`), `--gold` dựng bản chuẩn (`gold.mkv`), ngay sau lượt đo khi input còn trong temp. So trên mp4 thì nhiễu NVENC lấn thay đổi của đồ thị.
- Đã kiểm trên Bin Tom (hai lượt cùng mã): số khung/thời lượng khớp, PSNR ∞, bản cũ cách bản chuẩn 40,28 dB, ĐẠT.
- ⚠️ **VMAF của hai bản giống hệt nhau chỉ 97,86** (mô hình `vmaf_v0.6.1`, Bin Tom). Ngưỡng 95 vì vậy chỉ còn ~3 điểm dư; khi VMAF trượt mà PSNR/khung tệ nhất vẫn tốt thì xem lại ngưỡng này trước khi kết luận.
- Dung lượng: FFV1 1080×1920 ~1 MB/khung, bản chuẩn gấp ~4 lần. 4K thì dùng bản cắt ngắn (`--cut 30`).

### Số nền (0.5) — máy dev, Gyan 8.1.1, NVENC, sidecar của 0A + phần đo

"Trong app" = lượt (b) trong Electron, từ lúc gọi `performVideoExport` tới khi có Blob. "Phát lại" = lượt (a), trung vị. Giây.

| Fixture | Nguồn giải mã | Khung | Trong app | Vẽ trước | Tải lên | Hạ SDR | ffmpeg hình | Tiếng | Ghép | Tải về | Phát lại |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1. Bin Tom - Tap 3 (20 clip, 19 lớp phủ: 2 video + 17 chuỗi khung chữ) | H.264 1080×1920 ~30 fps (HLG đã chuẩn hoá) | 2.297 | **129,2** | 7,1 | 0,9 | **72,5** | 44,3 (1 batch) | — | — | 0,5 | **42,4** (3 lượt; về sau 47–51 do máy nóng) |
| 9b. Phụ đề, bản cắt 300 s (100 phụ đề) | AV1 3840×1646 24 fps | 7.200 | **248,4** | 0,8 | 0,1 | 0 | 228,5 (2 batch) | 6,8 | 2,3 | 8,8 | **204,5** (187,1 / 204,5 / 205,7) |
| 9a. Phụ đề, bản đầy đủ 39 phút (1.116 phụ đề) | AV1 3840×1646 24 fps | 56.757 | **3.334,9** (55,6 phút) | 6,5 | 0,6 | 0,1 | 3.147,7 (13 batch) | 45,3 | 66,4 | 63,6 | hỏng (xem dưới) |

- 9a phát lại: `fetch` của Node bỏ cuộc sau 300 s chờ header (`UND_ERR_HEADERS_TIMEOUT`); bộ đo nay POST bằng `http` thuần. Số phát lại của 9a lấy ở lượt A của phép A/B 1.1a. Báo cáo của người dùng 2026-09-27 (BtbN N-123955, sidecar trước 0A): server 2.964,7 s.
- 9a từng batch (180 s phim mỗi batch): 134,9 → 153,1 → 143,9 → 167,0 → 185,5 → 199,2 → 214,3 → 239,7 → 255,0 → 282,1 → 291,8 → 299,6 → 326,7 s, **batch cuối 24,8 s phim mất 254,9 s**. Tăng ~15 s mỗi batch ≈ 180 s × 24 khung ÷ 243 khung/s giải mã: đúng cấp số cộng của #13. Ước phần giải mã thừa ≈ 1.600 s (~27 phút).
- 9a ghép cuối 66,4 s: `-c copy` 11,5 GB kèm `+faststart` (phải ghi lại cả file để dời moov lên đầu).

**Tách khâu** (`--split`, lượt phát lại đầu, giây): encode ≈ thật − `-f null`, filter ≈ `-f null` − chỉ giải mã.

| Lượt | Thật | Giải mã | Filter | Encode |
|---|---|---|---|---|
| Bin Tom, batch duy nhất | 38,8 | 7,0 (0..265 s nguồn) | **29,7 (77%)** | 2,1 |
| 9b batch 0 (0..180 s) | 94,4 | 17,8 | **72,1 (76%)** | 4,5 |
| 9b batch 1 (180..300 s) | 78,6 | 29,0 (0..300 s, cần 120 s) | **45,5 (58%)** | 4,1 |

**Kết luận 0.5:**
- **Filter là nút thắt** ở mọi fixture (58–77% thời gian ffmpeg); encode NVENC chỉ 5–10%. Đúng chẩn đoán #2/#3 (đường RGBA) và #12 (chuỗi lớp phủ).
- Với dự án dài có lớp phủ, giải mã thừa (#13) là khoản lớn thứ hai (~27/55 phút ở 9a).
- Lượt xuất đầu của dự án có video HDR trong thư viện: hạ SDR asset không dùng (1.15) chiếm hơn nửa (Bin Tom 72,5/129 s).
- Trong app chậm hơn phát lại 21–30%: preview đang phát suốt lúc xuất (1.17).
- **Nhánh 1B: KHÔNG làm** (với các fixture đã đo). Vẽ trước = 5,5% (Bin Tom), 0,3% (9b), 0,2% (9a), xa ngưỡng 30%. Fixture 7 (nhiều chuyển cảnh) chưa dựng; đo lại khi có.
- Thứ tự Bước 1 xếp lại theo các số này (xem "Cách làm chung" của Bước 1).

---

# BƯỚC 1 — Sửa cách sidecar dựng lệnh (ffmpeg có sẵn, chưa cần fork)

**Cách làm chung:**
- Sửa `native/sidecar/core_process.cpp`, build bằng `npm run build:sidecar`. `native/sidecar/build/` nằm trong `.gitignore`, nên chỉ commit mã nguồn; bộ cài dựng lại exe.
- Mỗi mục có env tắt riêng. Chỉ bật mặc định khi qua 0.3 và test hồi quy.
- **Thứ tự (xếp lại theo số đo Bước 0, 2026-09-28):** **1.15** (hạ SDR asset thừa) → **1.1a** (seek theo batch) → **1.3 + 1.5** (đường nhanh YUV) → **1.11** (phụ đề thành một luồng) → **1.17** (Electron ăn CPU lúc xuất, chờ profile) → 1.0 → 1.6 → 1.7 → 1.4 → 1.10 → **1.12** → **1.16** (bỏ bước tải về, cần người dùng quyết) → 1.2 → 1.8 → 1.9 → **1.13** → 1.14.
  - Vì sao: ở cả hai fixture, **filter chiếm 68–77% thời gian ffmpeg**, encode chỉ 5–10% (xem "Số nền"). Lượt xuất đầu của Bin Tom thì hơn nửa là hạ SDR một file không ai dùng. 1.15 và 1.1a rẻ, rủi ro thấp, nên đi trước.
  - Thứ tự cũ (2026-09-27): 1.0 → 1.6 → 1.3 + 1.5 → 1.11 → 1.1 → 1.7 → 1.4 → 1.10 → 1.12 → 1.2 → 1.8 → 1.9 → 1.13 → 1.14.
- **Chạy A/B xen kẽ** (A B A B …), không chạy hết A rồi mới tới B: số đo trôi dần theo nhiệt độ máy (Bin Tom cùng mã: 42 → 48 → 51 s qua một giờ).
- **Giữ nguyên nguyên tắc `-reinit_filter 0`**: chỉ `scale` tự cấu hình lại theo từng khung (`vf_scale.c:757-811`). Mọi chuỗi phải mở đầu bằng một `scale` cố định cỡ + định dạng, trước các filter như `crop`, vốn cố định cỡ lúc cấu hình (`vf_crop.c:250-310`).

**1.0 Một `[0:v]` + `split`** (#4, không đụng mốc thời gian). Env: `CRABBYCUT_EXPORT_SPLIT=0`.
- Thay N lần tham chiếu `[0:v]` bằng một lần `[0:v]split=N`.
- Autorotate chỉ chèn một `transpose`, chỉ còn một buffersrc.
- Thêm `-threads 1` cho input ảnh đơn.

**1.6 Dẹp filter tính biểu thức từng điểm ảnh** (#6, làm trước 1.5 vì `geq` r/g/b chỉ nhận GBR(A)P, `vf_geq.c:266, 364-374`). — **ĐÃ LÀM (2026-10-01, phiên 7)** cho hai chỗ `geq` còn lại; test `test:export-alpha-filters`.
- **Đo trước (Test.crab, `-f null`):** lượt xuất 55,4–55,8 s; bỏ riêng `geq` độ mờ keyframe (block 150% của nguồn 1366×720 ≈ 2050×1080, 200 khung): **12,2 s** → geq tốn ~43 s (~215 ms/khung). Mép mềm Retouch trên "Yêu Con 1" (2 miếng vá ~510×490, 294 khung): ~3–5 s.
- **Độ mờ keyframe** (`KfOpacityFilter`): `format=gbrap,sendcmd=f='kfopN.cmd',colorchannelmixer@kfopN=aa=1`, file lệnh `[expr] … aa 'clip(op/100,0,1)'`. Đã thử `lut` thay `colorchannelmixer`: không được — sendcmd [expr] gửi KẾT QUẢ số của biểu thức, mà `lut` cần chuỗi `val*k`. Kiểm riêng: alpha trùng hoàn toàn ở đoạn 100%, lệch ±1 ở đoạn mờ dần (geq cắt phần lẻ, colorchannelmixer làm tròn), RGB trùng, không trễ khung. **Bẫy:** để colorchannelmixer chạy ở rgba thì `overlay=format=auto` kéo LUỒNG CHÍNH qua rgba (geq ép gbrap), swscale đi đường yuv420p→rgba nhanh mà kém chính xác cho MỌI khung — bộ so 0.3 trượt (so bản chuẩn 45,5 → 41,6 dB); ép `format=gbrap` trước colorchannelmixer thì đồ thị quanh nó y như cũ. **Kết quả Test.crab: 57,5 → 16,0 s (3,6×); bộ so 0.3 ĐẠT** (mới/cũ 68,4 dB, so bản chuẩn 45,476 → 45,478). Env tắt `CRABBYCUT_EXPORT_KFOP=0`.
- **Mép mềm** (`AppendFeatherAlpha`): tách một khung, `geq=lum=dốc mép` trên khung đó (một lần), `blend=multiply` vào alpha của mọi khung (framesync lặp khung cuối của nhánh dốc), `alphamerge`; ở gbrap như cũ. "Yêu Con 1": 59,7 → 56,5 s; bộ so 0.3 ĐẠT (trùng từng điểm ảnh — miếng vá JPEG alpha 255). Env tắt `CRABBYCUT_EXPORT_FEATHER1=0`.
- Ghi chú cũ:
- Keyframe opacity: `geq` → `colorchannelmixer=aa=…` (rgba) hoặc `lut=c0=val:c1=val:c2=val:c3='val*k'` (yuva) + `sendcmd` cờ `[expr]`.
  - Hai filter này nhận lệnh lúc chạy (`vf_colorchannelmixer.c:462-506`, `vf_lut.c:573-605`).
  - Phải ghi đủ `c0..c2=val`: thành phần bỏ trống mặc định là `clipval`, sẽ kẹp Y về 16–235 và U/V về 16–240 (`vf_lut.c:89-99, 267-274`).
  - Theo khuôn `ColorAdjustLutBlend` (`:1885-1909`): `sendcmd` đứng trước, lệnh nằm trong file.
- Feather (`:2574`): ảnh dốc mép sinh sẵn một lần → `blend=multiply` + `alphamerge`.
- `scale:eval=frame` chỉ dùng trên đoạn thực sự biến thiên.

**1.7 Ảnh tĩnh lẻ (không thuộc track phụ đề)** (#7). Env: `CRABBYCUT_EXPORT_STILL1=0`. **Đã viết lại 2026-09-27.** — **Trạng thái 2026-10-01 (phiên 7):** (b) xong qua 1.5 (ghép yuv420 + ảnh tĩnh xử lý một lần); `-threads 1` cho input ảnh đã đo ở phiên 5 — không đổi gì, bỏ; (c) chờ 1.11. **Lỗi tiềm ẩn khi cắt batch — ĐÃ SỬA** (`ColorChainTimeVarying`, test `test:export-batch-time-varying`): `OverlayIsTimeVarying` không dò chuỗi màu CỦA CHÍNH lớp phủ, và cả hai hàm (lớp phủ lẫn clip) chỉ dò `LOCALT` mà bỏ sót `sendcmd` (keyframe colorbalance/curves/làm mờ đi qua file lệnh theo giờ cục bộ của block). Tái hiện trước khi sửa: phim 300 s, ảnh 170–195 s có `vignette` theo LOCALT → mốc cắt rơi đúng 180 s, giữa ảnh (nửa sau chạy lại keyframe từ 0); nay mốc dời ra 195,1 s, clip có sendcmd không bị xén. Đánh đổi: clip dài có keyframe màu không còn chia batch bên trong (chậm hơn nhưng đúng) — muốn chia thì phải dời mốc của sendcmd/LOCALT theo phần đã xén.
- ⚠️ **KHÔNG dùng "một khung + `eof_action=repeat`" trong chuỗi lớp phủ.** Đo với 85 lớp phủ ở 4K: **8 khung/s**, so với 95 khung/s của kiểu hiện tại. Lý do: một lớp phủ đã hết khung làm framesync giữ tham chiếu khung chính, rồi `overlay` chép cả khung ở mọi lớp, mọi khung hình (#12).
  - Chỉ được dùng lại cách này khi bản fork đã vá #12 (2.4), và phải đo lại.
- Thay vào đó:
  - (a) ảnh tĩnh thuộc track chữ/phụ đề đi mục **1.11**;
  - (b) vài ảnh tĩnh lẻ (logo, sticker) giữ kiểu hiện tại (`-loop 1`, `trim=duration`, `eof_action=pass`) nhưng ghép `yuv420` (đo: 128 so với 95 khung/s với 85 lớp); input ảnh mang `-threads 1`;
  - (c) nhiều ảnh tĩnh lẻ cùng lúc (≥ ~5 trong một batch) thì cũng gom thành một luồng như 1.11.
- Điều kiện "thực sự tĩnh": `!OverlayIsTimeVarying` **và** không có `LOCALT` trong `adjustFilters`/`adjustFiltersPost`. `OverlayIsTimeVarying` (`:2315-2328`) hiện không kiểm hai trường này, khác với `IntervalIsTimeVarying` (`:2298-2301`). Đây cũng là lỗi tiềm ẩn khi cắt batch; sửa luôn.
- Mốc cuối của `enable`: hiện nay khung cuối của lớp phủ lúc có lúc mất, vì ảnh chạy 25 fps và framesync coi nó đã hết ở khung ảnh cuối + 1 tick (`framesync.c:238-266`). Khi đổi cách nạp ảnh, chốt mốc cuối theo lưới khung (`end − 0.5/renderFps`, đối xứng `seqEndTrim` `:2601-2608`) và thêm test biên.
- Chữ đã được bake đúng cỡ hộp chữ (`editing-runtime.js:17437-17447`), không cần cắt khung bao.

**1.3 Đường nhanh YUV cho clip lane chính "thường"** (#2, lợi lớn nhất đã đo). Env: `CRABBYCUT_EXPORT_FASTPATH=0`. — **ĐÃ LÀM, BẬT mặc định (2026-09-29, phiên 3).**
- **Đo trước khi làm (micro-bench, batch 0 của 9b, 30 s phim 4K, `-f null`, Gyan 8.1.1):**

  | Đồ thị | Thời gian | khung/s |
  |---|---|---|
  | hiện nay (lane chính RGBA + 49 lớp phủ RGBA) | 16,5 s | 43 |
  | **chỉ lane chính, chưa lớp phủ nào** (đường cũ) | 10,7 s | 67 |
  | chỉ lane chính, đường nhanh | 3,9 s | 180 (sát trần giải mã AV1) |
  | 1.5 (lớp phủ YUV) | 12,5 s | 57 |
  | **1.3 + 1.5** | **5,2 s** | **138** |
  | 1.3 + 1.11 (cả track phụ đề một luồng, giả lập) | 4,2 s | 171 |
  | ghép 4:4:4 (để chữa màu mép) | 8,2–15 s | loại |

  → Lane chính qua RGBA là khoản lớn nhất, lớn hơn cả chuỗi lớp phủ.
- **Mã** (`core_process.cpp`): `ProbeMainSourceForFastPath` (một lần mỗi lượt xuất: cỡ, pix_fmt, color_space, chroma_location, xoay của `temp_input.mp4`), `MainLaneFastPlan`, nhánh `fast.ok` trong `WriteClipVideoFilters`. Sự kiện `timing` có `fast_clips` cho mỗi lượt ffmpeg.
- **Điều kiện đã chốt:** nguồn YUV (không `yuva`), ma trận BT.709 (hoặc HD không nhãn đã được `UntaggedColorFix` gán BT.709), không xoay; clip không keyframe, hoạt ảnh, xoay, độ mờ < 100%, mặt nạ video, **lật** (hflip ở 4:2:0 đổi vị trí mẫu màu); `renderFrames > 0`. Nguồn BT.601 và SD không nhãn giữ đường cũ.
- **Ba nhánh**, chọn theo toạ độ và chuỗi màu:
  1. **YUV 4:2:0** (clip không chỉnh màu): `scale` → `pad` (khung đủ lớn, vị trí chẵn) → `crop exact`. Cắt lẻ mà clip tràn kín khung theo chiều đó → `scale` dời vị trí mẫu màu 1 điểm ảnh luma (`in/out_*_chr_pos`, +256) để sau phép cắt lẻ mẫu màu về đúng chỗ.
  2. **4:4:4 rồi hạ 4:2:0**: đệm lẻ, cắt lẻ mà mép clip nằm trong khung, clip giữ nguyên cỡ bị cắt lẻ. Ở hai ca đầu, mẫu màu ở mép clip giáp nền đen phải là trung bình (đen, cột đầu clip) như đường cũ; mẹo dời mẫu màu thì lấy trọn màu đen (đo: kênh U 30,2 so với 32,3 dB của đường cũ). Ca cuối: swscale chép thẳng khi không co giãn và **bỏ qua** `chr_pos` (đo: hai bản y hệt).
  3. **RGB** (clip có chuỗi màu): co giãn + đặt vị trí ở RGB, đổi sang YUV một lần ở cuối = đúng phép tính của đường cũ, chỉ bỏ nền `color` + `overlay`. Vì: (a) swscale vừa đổi RGB→YUV vừa co giãn thì đổi trước rồi mới co giãn, chỗ vọt/kẹp ở cạnh khác đường cũ (luma so bản chuẩn 47,8 so với 54,4 dB); (b) đường cũ kẹp gam RGB ngay sau chuỗi màu, giống preview (WebGL áp màu trên RGB) — giữ YUV nguyên vẹn thì vùng rất bão hoà khác preview. Test: `curves` ra **trùng từng bit** đường cũ.
- **`tpad` phải đứng TRƯỚC hình học (chữa 2026-09-30, phiên 4).** Để nhân bản khung cuối, `tpad` giữ một tham chiếu tới MỌI khung đi qua (`cache_stop = av_frame_clone`), nên khung nó nhả ra "không ghi được" và `overlay` đầu tiên phía sau phải chép nguyên khung (`ff_inlink_make_frame_writable`) — 4K là ~9,5 MB mỗi khung. Đặt `tpad` ngay sau chuỗi màu, trước `scale` → khung ra khỏi `scale` là bộ đệm mới. Hình học là phép cố định nên bản xuất y hệt (md5 trùng trên 4.320 khung 4K). Đo batch 3 của bản 39 phút (`-f null`): 33,2 → 28,1 s; cả lượt xuất 731,3 → 552,9 s (cùng phần `moov` của 1.8). Clip giữ nguyên cỡ (scale không làm gì) thì khung vẫn là khung của bộ giải mã, `overlay` vẫn phải chép — như đường cũ.
- **Số khung:** `tpad=stop=-1:stop_mode=clone` rồi `concat` với một dải đen `color`, rồi `trim=end_frame=N`. Kế hoạch cũ ghi `tpad … stop_mode=add` cho clip không có khung nào — **sai**: đầu vào rỗng thì `tpad add` cũng không ra khung nào (đã thử), mọi clip sau bị xô sớm lên. Clip ngắn thì tpad clone chạy mãi nên `concat` không bao giờ sang dải đen.
- **Ba bẫy đã gặp:**
  - `pad` làm tròn bề rộng **đầu vào** xuống số chẵn: cắt phần thấy được (có thể rộng lẻ) rồi mới đệm thì mất một cột ở mép clip → luôn **đệm trước, cắt sau** (clip đã scale luôn rộng chẵn).
  - `180×1,1` tính bằng số thực = 198,00000000000003 → `ceil(·/2)*2` = 200, không phải 198. Đường cũ cũng tính vậy nên không lệch; nhưng muốn dựng ca "cắt lẻ" trong test thì phải tính bằng đúng phép đó (test ban đầu tưởng 110% cắt lẻ 9 px, thật ra cắt 10).
  - Ma trận màu: như ghi chú dưới — chỉ BT.709.
- **Test** `npm run test:export-fast-path` (đã vào chuỗi `npm test`): 13 clip (100%, phóng/thu, cắt/đệm lẻ từng chiều, dời âm, 100% toạ độ lẻ, clip dài quá nguồn, clip ngoài nguồn, eq, curves, lật) + nguồn BT.601 / SD không nhãn / HD không nhãn + ProRes. Dựng lại đồ thị cả hai đường ra FFV1 (`renderFromCommands`), so từng clip với bản chuẩn: mỗi mặt phẳng không kém đường cũ; vị trí (luma so bản chuẩn ≥ 45 dB); clip có chỉnh màu và clip rơi về đường cũ phải trùng đường cũ. **Đột biến** bỏ phép dời mẫu màu → test đỏ ở clip 105% (U 38,8 → 31,2 dB).
- Kết quả test (so bản chuẩn, cũ → mới): mọi clip đường nhanh bằng hoặc hơn đường cũ ở cả Y/U/V; luma của clip không chỉnh màu trùng bản chuẩn (∞).
- **A/B xen kẽ trên dự án thật** (phát lại, 2026-09-29; A = `CRABBYCUT_EXPORT_FASTPATH=0`, B = 1.3, C = 1.3 + `CRABBYCUT_EXPORT_YUVCOMP=1` chưa chữa màu mép):

  | Fixture | A (cũ) | B (1.3) | C (1.3 + 1.5) |
  |---|---|---|---|
  | Bin Tom (3 lượt) | 56,4 / 51,3 / 49,6 s | 40,4 / 39,3 / 39,1 s | 30,8 / 28,8 / 28,7 s |
  | Phụ đề 4K, cắt 300 s (2 lượt) | 195,7 / 190,7 s | 113,1 / 111,3 s (**1,7×**) | 83,4 / 84,1 s (**2,3×**) |

- **Bộ so 0.3, Bin Tom, 1.3: ĐẠT** — mới/cũ PSNR 49,7 dB (tệ nhất 48,9), VMAF 97,6; so bản chuẩn: cũ 40,3 dB → mới 45,1 dB.
- Ghi chú cũ, giữ để tra:
- Điều kiện:
  - không keyframe, hoạt ảnh, xoay, opacity < 1 hay mặt nạ video (flip vẫn được);
  - **và** mọi độ dời crop/pad là số chẵn: 4:2:0 làm tròn toạ độ xuống số chẵn (`vf_pad.c:196-197`), còn đường RGBA đặt được ở mọi số nguyên (`vf_overlay.c:89-105`).
  - Toạ độ lẻ thì giữ đường cũ.
- Chuỗi: `scale` (cố định) → `crop` phần tràn khung → `pad` phần thiếu → `format=yuv420p`. Bỏ nền `color` + `format=rgba` + `overlay`.
- ⚠️ **Ma trận màu (đo 2026-09-28, Gyan 8.1.1):** `scale=out_color_matrix=bt709:out_range=tv` đi thẳng YUV→YUV **không đổi ma trận** — nguồn gắn nhãn BT.601 ra y hệt từng bit (PSNR ∞ so với nguồn). Đường RGBA hiện nay thì đổi đúng, vì YUV→RGB đọc ma trận của từng khung. Vậy đường nhanh chỉ được dùng khi **mọi khung** nguồn là BT.709 (hoặc không nhãn, đã được `UntaggedColorFix` gán BT.709); nếu không thì phải thêm `colorspace=all=bt709:range=tv` (đọc thuộc tính từng khung) hoặc giữ đường cũ.
  - Bản nối `-c copy` từ điện thoại có thể đổi `yuv420p/tv/bt709 ↔ yuvj420p/pc/bt470bg` giữa file ("Khám phá Hạ Long"), và phép dò extradata của 1.1a **không** bắt được chuyện đó (mp4 do ffmpeg nối không mang side data "New Extradata" dù SPS khác nhau — đã thử). Cần một phép dò riêng theo khung, hoặc dùng `colorspace` cho mọi nguồn không phải bản chuẩn hoá.
- Giữ chắc số khung: `tpad=stop=-1:stop_mode=clone,tpad=stop=-1:stop_mode=add,trim=end_frame=N`. Một `tpad=stop_mode=clone` đơn không ra khung nào nếu clip cho 0 khung (`vf_tpad.c:180-183`); lúc đó mọi clip phía sau bị xô lệch. Nền `color` hiện nay là thứ đang giữ số khung (`:2051-2053`).

**1.5 Ghép lớp phủ ở YUV** (#3). Env tắt: `CRABBYCUT_EXPORT_YUVCOMP=0` — **XONG, BẬT mặc định** (2026-09-29; viết mã 2026-09-28, chữa màu mép + bật ở phiên 3).
- Đã làm (`WriteVisualOverlayFilter`, `YuvCompositeEnabled`): lớp phủ đứng yên, không xoay → chuỗi RGBA như cũ + `pad` 1 px trong suốt khi toạ độ lẻ + `scale=out_color_matrix=bt709:out_range=tv,format=yuva420p`, rồi `overlay=format=yuv420` ở toạ độ chẵn `trunc(X) − mod(trunc(X),2)`. Lớp phủ động/xoay vẫn ghép RGBA, kèm đổi về yuv420p BT.709 ngay sau nó.
- Test `npm run test:export-yuv-composite`: 9 toạ độ (chẵn/lẻ/thập phân/âm) — khung bao luma trùng từng pixel với đường cũ và với `trunc((W−w)/2+dx)`; mọi `overlay` của chuỗi chính nhận `yuv420p` (trước: `rgba`); lớp phủ bán trong suốt PSNR mới/cũ 52,7 dB.
- **Vì sao chưa bật: màu ở mép.** Đổi RGBA → yuva420p lấy trung bình màu của khối 2×2 gồm cả điểm ảnh trong suốt (canvas lưu chúng là đen), rồi `overlay` nhân thêm alpha trung bình → mép bị pha loãng hai lần. Đo (chữ vàng khử răng cưa trên nền xanh đậm, so bản chuẩn 4:4:4): U **41,6 dB** so với 46,1 dB của đường cũ; Y và V như nhau. Chữ trắng/nền đen (phụ đề mặc định) không bị vì màu trung tính. Ở toạ độ lẻ, cột mép đệm cũng bị nhạt một nửa.
  - `overlay=…:alpha=premultiplied` (sau `premultiply`) cho luma tệ hơn (39,3 dB); `unpremultiply` chỉ nhận yuva444p/gbrap, nên không có đường "trung bình có trọng số alpha" gọn bằng filter sẵn có.
  - Hướng chữa, cần đo: (a) renderer bake PNG với màu "tràn" vào điểm ảnh trong suốt (alpha bleeding) — lúc đó trung bình 2×2 gần đúng trọng số alpha; (b) 1.11 (cả track phụ đề thành một luồng) sẵn là chỗ bake lại PNG; (c) bản fork (2.4) thêm hạ mẫu có trọng số alpha.
  - Việc tiếp: đo 1.5 trên fixture thật bằng `export_fidelity.js` (Bin Tom có chữ màu) trước khi quyết.
- **Đo trên Bin Tom (2026-09-29, phiên 3, trước khi chữa màu mép):** xuất 48,5 / 46,8 / 51,0 s → 37,7 / 36,2 / 38,6 s (−24%). Bộ so 0.3 **ĐẠT**: mới/cũ PSNR 49,6 dB, VMAF 97,6 (hai bản giống hệt nhau cho 97,86); **bản mới gần bản chuẩn hơn bản cũ: 45,1 so với 40,3 dB**, vì luồng chính không còn đi vòng YUV → RGB → YUV 8-bit. Khung biên tệ nhất 48,9 dB.
- **Chữa màu mép (phiên 3):** `AlphaWeightedYuva420` — mẫu màu 4:2:0 của lớp phủ ẢNH = trung bình có trọng số alpha: `premultiply` → thu nửa cỡ (hộp 2×2, `flags=area`) → `unpremultiply`, ở 16-bit (8-bit thì vùng đục lệch 1 mức vì premultiply nhân (U−128)·a >> 8), rồi `mergeplanes` với luma + alpha đầy đủ. Đo lại ca chữ vàng: kênh U so bản chuẩn **41,6 → 44,8 dB** (đường cũ 46,1; phần còn lệch là nhân hạ mẫu hộp 2×2 so với nhân của swscale), luma và V như cũ. Thử `flags=bicubic`/`bilinear`: 43,7 dB. Lớp phủ video đục thì đổi thẳng như trước.
- **Ảnh tĩnh xử lý một lần** (`OverlayStillOnce`, env tắt `CRABBYCUT_EXPORT_STILL1=0`, áp cho cả đường RGBA): input ảnh không còn `-loop 1 -t T` (25 khung/giây, mỗi khung giải mã PNG + scale + đổi màu lại từ đầu) mà là một khung, chuỗi xử lý chạy một lần, rồi `loop=loop=-1:size=1` + `trim` + `setpts`. Đã kiểm: dãy PTS y hệt `-loop 1` (34/34 khung). Chính việc này làm chuỗi chữa màu mép gần như không tốn gì.
- **Bẫy của `overlay` lộ ra khi chữa màu mép:** ở cột/hàng mẫu màu CUỐI của lớp phủ, `overlay` yuv420 chỉ lấy alpha của điểm ảnh đầu cặp (`vf_overlay.c`, nhánh `k+1 < src_wp`), không lấy trung bình. Mẫu màu pha loãng của cách cũ vô tình che chuyện này; mẫu màu đúng trọng số thì lộ ra thành 1 cột màu tràn sang phải (test vị trí đỏ: hộp đỏ ở toạ độ lẻ rộng thêm 1 px trong bản mp4). Chữa: đệm `iw+4`/`ih+4` thay cho `+2` để cặp cuối luôn trong suốt hẳn.
- Test `test:export-yuv-composite` thêm mục 4: đĩa vàng mép khử răng cưa (điểm trong suốt mang màu đen như canvas lưu) ở toạ độ lẻ, trên bản lossless của đồ thị, U/V quanh đĩa so với bản chuẩn **đã hạ về 4:2:0** (so ở 4:4:4 thì sai số hạ mẫu của cả hai bản lấn hết — đột biến vẫn xanh). Đo: đường cũ U 49,6 dB, chữa 46,3, trung bình thường (đột biến) 41,6 → ngưỡng "không kém đường cũ quá 4 dB". Phần lệch còn lại: `overlay` trộn mẫu màu theo alpha trung bình ngay ở 4:2:0, đường cũ ghép ở cỡ đầy đủ rồi mới hạ mẫu; đổi nhân hạ mẫu (area/bicubic/bilinear/lanczos, tách ngang-dọc) không thu hẹp được (tốt nhất 44,8 dB ở ca chữ vàng).
- **Chi phí** (micro-bench, batch 4K 49 lớp phủ): 30 s phim 5,47 s → ảnh tĩnh một lần 5,02 s (RAM 1,6 → 0,96 GB) → + chữa màu mép 6,08 s; trên đủ batch 180 s: 27,4 → 28,3 s (+3%, chi phí cố định lúc khởi tạo ~20 ms mỗi lớp phủ), RAM 1,7 GB (ngang bản phát hành).
- **Bin Tom, 1.3 + 1.5 (chưa chữa mép), bộ so 0.3: KHÔNG ĐẠT tiêu chí (b)** — PSNR mới/cũ 43,5 dB < 45, trong khi bản mới gần bản chuẩn hơn hẳn: **52,5 so với 40,3 dB** (+12,2); VMAF mới/cũ 97,2, khung tệ nhất 42,8 dB (≥ 38) đều đạt. Bản cũ cách bản chuẩn 40 dB (vòng YUV→RGB→YUV), nên bản nào chính xác hơn nhiều cũng buộc phải lệch khỏi bản cũ chừng ấy. Tiêu chí (b) nằm trong bảng đã chốt với người dùng → **hỏi người dùng** trước khi bật 1.5 mặc định.
- `overlay=format=yuv420`, lớp phủ `format=yuva420p`, luồng chính giữ `yuv420p`. Có SIMD SSE4.1 `ff_overlay_row_20`.
- Đã đo: `yuv444` chậm nhất (3,78 s), vì ffmpeg chọn `yuva444p` cho luồng chính nên mất SIMD (`x86/vf_overlay_init.c:43-46`).
- Chuẩn hoá mỗi lớp phủ về `scale=out_color_matrix=bt709:out_range=tv` trước `overlay`. `overlay` ép một không gian màu, dải và kiểu alpha chung cho mọi đầu vào (`formats.c:1170-1216`), và từng kéo cả luồng chính theo ảnh JPEG (`:1657-1670`).
- **Toạ độ lẻ:** `yuv420` cũng làm tròn x/y xuống số chẵn. Để giữ đúng vị trí: đệm 1 px trong suốt ở RGBA (lúc lớp phủ còn nhỏ), đổi sang `yuva420p`, rồi đặt ở toạ độ chẵn x−1 / y−1.
- Giữ RGBA ở chuỗi mặt nạ (`alphaextract`/`blend=multiply`/`alphamerge`).
- ProRes (`yuv422p10`, `:1653-1655`) dùng `yuv444p10`/`yuva444p10` để khỏi rơi xuống 8-bit.
- Chấp nhận khác biệt nhỏ ở vùng rất bão hoà hoặc dưới mức đen: đường cũ kẹp theo gam RGB, đường mới thì không. Bộ so 0.3 (so trong RGB, so với bản chuẩn) sẽ phân xử.

**1.4 Cắt trước khi scale khi phóng to; chỉnh màu sau khi thu nhỏ** (#5). — **ĐÃ LÀM (2026-10-01)**: "chỉnh màu sau khi thu nhỏ" là mục 1.19; "cắt trước khi phóng to" cho đường nhanh lane chính (`PreCropPlanAxis`, `MainLaneFast::preCrop`), test `test:export-precrop`, env tắt `CRABBYCUT_EXPORT_PRECROP=0`.
- **Ca thật:** Test.crab — nguồn 1366×720 nằm giữa khung chuẩn hoá 3840×2160 (viền đen), clip 108% (×1,4056 vừa khung) → mỗi khung co lên 5830×3280 rồi giữ 1920×1080.
- **Cách làm:** vùng cắt trên lưới 2q của tỉ lệ rút gọn w/iw = p/q, lề 8 điểm ảnh nguồn; ảnh co của vùng cắt (len·p/q, chẵn) đặt ở vị trí cũ + start·p/q, phần pad/crop/chroma phía sau giữ nguyên phép tính. Chỉ khi phóng ≥ 1,3× và bớt ≥ 25% diện tích; clip có chỉnh màu thì chỉ khi mọi tầng theo từng điểm ảnh (cắt đứng TRƯỚC chuỗi màu, sau xoá logo). Test.crab: vùng cắt 2304×756 → co 3498×1148 thay cho 5830×3280.
- **Kết quả Test.crab: 16,8 → 14,2 s (−15%); bộ so 0.3 ĐẠT** (mới/cũ 63,95 dB, tệ nhất 61,4 — bước lấy mẫu xInc làm tròn trên phân số khác mẫu số; so bản chuẩn 45,46 → 45,463). Test: 7 clip (1,2× không cắt, 1,35×–3×, dời lẻ, sát mép, curves cắt trước, unsharp giữ thứ tự cũ) ≥ 50 dB so với cách cũ, đột biến lệch mốc 2 px tụt 24 dB.
- Chưa làm: lớp phủ phóng to (đường RGBA) và clip có keyframe hình học.
- Ghi chú cũ:
- Chỉ bật khi zoom ≥ ~1,3×.
- Cắt trên lưới tỉ lệ rút gọn của W'/iw (W' = ceil(iw·s/2)·2, `:2132-2133`), chừa lề ≥ 4 px, rồi cắt chính xác lần nữa sau `scale`. Lý do: cắt trước thay đổi vị trí lấy mẫu của swscale.
- "Màu sau khi thu nhỏ" chỉ khi chuỗi màu gồm phép từng điểm ảnh (`eq`/`colorbalance`/`curves`/`lut3d`), không mặt nạ.
  - Loại `unsharp`/`avgblur`/`noise`: tham số của chúng tính theo điểm ảnh, `color-adjust.js:535-555`.
  - Loại `vignette`: hình học của nó tính theo khung đã cắt.

**1.10 (tuỳ số đo) Gộp chuỗi màu tĩnh thành một LUT** (bake `eq`+`colorbalance`+`curves`+`lut3d` → cube 33³). Kiểm bằng `test:color-adjust` + 0.3.

**1.15 (mới, 2026-09-28) Chỉ hạ SDR cho video HDR mà item thật sự dùng.** — **xong** (commit `5e5635a`; cache lâu dài ở phiên 3).
- **Phát hiện:** `sdrOverridesForEditingAssets` (`server.js`) mã hoá lại MỌI video HDR trong `editing_json.assets`, tức cả **thư viện** của dự án, gồm video nguồn lane chính mà dự án tự đăng ký làm asset "liên kết".
  - "Bin Tom - Tap 3": thư viện 13 asset, item chỉ dùng 3. Lượt xuất đầu mã hoá lại trọn `IMG_0827.MOV` (HEVC 10-bit HLG, 270 s): **72,5 s trong tổng 129 s**, cho một file không lớp phủ nào đọc.
  - Bản SDR nằm trong `TEMP_DIR/editing_assets/sdr/`, bị `/api/reset-project` xoá khi mở dự án, nên **mỗi phiên** trả giá lại một lần.
- **Sửa:** chỉ xét asset có `items[].asset_id` trỏ tới. Đồ thị xuất không đổi (asset không có item thì không vào đồ thị). Test: `npm run test:export-hdr-asset-usage` (đột biến bỏ phép lọc → test đỏ).
- **Cache lâu dài — ĐÃ LÀM (2026-09-29, người dùng chọn "giữ trong cache có giới hạn"):** `SDR_CACHE_DIR` = `userData/sdr_cache/<khoá>/<tên>.mp4` (env test `CRAB_SDR_CACHE_DIR`), hạn 30 ngày, trần 20 GB (bỏ mục lâu không dùng nhất trước; lần dùng ghi vào tệp `last_used`, KHÔNG chạm mtime video vì sóng âm/proxy khoá theo mtime). Bản dùng thật vẫn phải nằm dưới `editing_assets/` (renderer nhận asset dự án bằng đường dẫn đó khi lưu .crab), nên cache ↔ `editing_assets` là **liên kết cứng** (khác ổ thì chép). Khoá thêm `SDR_CACHE_VERSION`. Dọn lúc khởi động và sau mỗi lần cất; có mục "Bản SDR của video HDR" trong Cài đặt → Bộ nhớ đệm. Test `test:export-hdr-asset-usage` thêm: mở lại dự án (xoá `editing_assets`) lấy bản SDR từ cache trong **4 ms** thay vì mã hoá lại; dọn theo trần và theo hạn; dọn cache không xoá bản đang dùng.

**1.16 (mới) Bỏ vòng tải file qua HTTP sau khi xuất.** — **xong** (phiên 3, người dùng chọn hỏi chỗ lưu trước).
- Hiện nay: backend ghi `final_cut.mp4` → trình duyệt tải về thành Blob (`response.blob()`) → `<a download>` → Electron (không có handler `will-download`) hỏi chỗ lưu → ghi thêm một bản nữa.
- Đo: tải vào Blob mất 4,4–8,8 s cho ~1,5 GB (bản cắt 300 s 4K); bản 39 phút 11,5 GB mất **63,6 s**. Bước ghi sau hộp thoại lưu **chưa đo** (bộ đo chặn cú click).
- ⚠️ **Rò đĩa:** `performVideoExport` không bao giờ `URL.revokeObjectURL` Blob của bản xuất, nên Chromium giữ nó trong `<userData>/blob_storage` suốt phiên — đo trong profile của bộ đo sau lượt xuất 39 phút: **11 GB**. Trên máy người dùng: mỗi lượt xuất thêm một bản sao cỡ file xuất trong AppData tới khi tắt app. Chưa sửa: thu hồi URL khi hộp thoại lưu của Electron còn mở có thể làm hỏng lượt lưu, cần thử tay; bỏ hẳn vòng HTTP (hướng trên) thì hết luôn.
- Hướng: renderer xin đường dẫn lưu qua hộp thoại của main process rồi main process `rename`/`copyFile` thẳng `final_cut.mp4`. Đổi thời điểm hiện hộp thoại lưu, nên hỏi trước.
- **ĐÃ LÀM (2026-09-29, người dùng chọn "hỏi chỗ lưu trước khi xuất", như Premiere):**
  - Bấm "Xuất video ngay" → hộp thoại lưu gốc (`export-pick-output` ở `electron/main.js`, nhớ thư mục lần trước trong phiên, mặc định cạnh tệp .crab) → render → ffmpeg ghi **thẳng** ra `<tên>.exporting.mp4` cạnh đích rồi đổi tên khi xong (hỏng giữa chừng không để lại tệp dở, tệp cũ còn nguyên tới lúc xong). Server trả JSON `{ path }`, renderer báo toast "Đã xuất video". Không còn tải file vào Blob, không còn bản sao trong `blob_storage`.
  - **An toàn:** HTTP API không kiểm nguồn gọi, nên backend chỉ nhận `output_path` kèm HMAC của main process (khoá ngẫu nhiên mỗi phiên, qua env `CRAB_EXPORT_OUTPUT_SECRET` lúc spawn backend); sai chữ ký/sai đuôi → 400. Backend chạy ngoài Electron (không có khoá), trình duyệt, và `bench:export` (`performVideoExport({ pickOutput: false })`) đi đường tải về cũ.
  - Test `test:export-output-path` (chữ ký đúng + thư mục tiếng Việt + đè tệp cũ; chữ ký giả; sai đuôi; không có đường dẫn). Kiểm E2E trong Electron thật với móc test `CRAB_TEST_EXPORT_OUTPUT_DIR` (bỏ hộp thoại): Bin Tom ghi thẳng ra đích, `download_ms = 0`, toast đúng; lượt xuất trong app 39,1 s (số nền 129,2 s).

**1.17 (mới) Giao diện Electron ăn CPU trong lúc xuất.** — **xong** (dừng preview khi xuất: `5e5635a`; tắt tự phát khi mở dự án: phiên 3).
- Cùng payload, lượt xuất trong app chậm hơn lượt phát lại qua HTTP ~21–30%. CPU-giây của ffmpeg như nhau (~1.000 CPU-s cho batch 0 của bản cắt 300 s) mà thời gian thực 120 s so với 94 s; GPU SM 14,5% so với 5,4%.
- **Nguyên nhân (CPU profile giữa lượt xuất bản 39 phút):** renderer bận 11,3/15 s. Gần hết là vòng phát preview: `startOverlayPreviewLoop` → `updateSequencePreviewTransform` + `renderPreviewOverlays`, `tick` của perf-runtime → `scrollTimelineToCurrentTime`, và ticker Pixi. Nghĩa là **preview đang phát suốt lúc xuất**. Electron trung bình 0,72 lõi.
- **Vì sao preview đang phát:** `PIXI.Texture.from(this.videoEl)` (`index.html`, `SequencePixiPreviewRenderer.init`) tạo `VideoResource` với mặc định `autoPlay: true`; ở sự kiện `canplay` đầu tiên (mở dự án), `_onCanPlay` tự gọi `video.play()`. Có từ bản 1.1.8. Đã kiểm trong Electron: mở .crab xong, `currentTime` 0 → 17,8 s sau 8 s mà không ai bấm Phát.
- **Đã sửa:** `performVideoExport` dừng preview trước khi xuất (`video.pause()`, nút Phát tự đồng bộ theo sự kiện `pause`, như nút Chụp khung hình).
- **Chưa sửa, cần người dùng quyết:** tắt `autoPlay` của Pixi. Đã thử (`resourceOptions: { autoPlay: false }`): hết tự phát, nút Phát vẫn chạy. Nhưng nó lộ ra hai chỗ mà cú tự phát vẫn che: sau khi mở, preview đứng ở `currentTime` 0 (nguồn giây 0, nằm ngoài clip đầu 9,96 s của Bin Tom), và bộ đếm hiện "00:00:00:00 / 00:00:00:00". Đã hoàn lại, để xử lý chung với vị trí playhead khi mở dự án.
- **ĐÃ LÀM (2026-09-29, người dùng chọn "tắt, playhead đứng ở đầu clip đầu"):** `PIXI.Texture.from(video, { resourceOptions: { autoPlay: false } })` + `parkPreviewAtSequenceStart()` cuối lượt mở dự án (dừng, `setVideoTimeFromTimelineTime(0)`, vẽ đồng hồ ngay — timeupdate của lượt tua tới trễ ~1,5 s+). Kiểm trong Electron thật (Bin Tom): đứng yên ở 9,96 s = đầu clip đầu suốt 5,5 s, đồng hồ "00:00:00:00 / 00:01:16:17" ngay 1,5 s sau khi mở, preview hiện đúng khung (ảnh chụp). Kèm theo: đổi sang proxy lúc đang dừng cũng thôi tự phát (Pixi gọi play() ở MỌI `canplay`).

**1.18 (mới) Dọn batch trung gian sau khi ghép** — **đã làm**, chưa commit.
- Sau lượt xuất nhiều batch, `<temp>/export_batches/` (to bằng chính bản xuất: ~11,5 GB ở dự án 4K 39 phút) nằm lại trong thư mục tạm của dự án tới lượt xuất sau. Nay `RemoveExportBatches` xoá ngay sau khi ghép cuối thành công, ở cả nhánh có lớp phủ lẫn nhánh 80 clip. `test:export-batch-seek` kiểm thư mục đã mất.
- Còn lại (1.8): ghép cuối `-c copy` + `+faststart` 11,5 GB mất 66 s; batch trung gian cũng mang `+faststart` vô ích.

**1.19 (mới, 2026-10-01) Màu theo từng điểm ảnh áp SAU bước co nhỏ** — **đã làm**. Env tắt `CRABBYCUT_EXPORT_COLOR_AFTER_SCALE=0`; test `test:export-color-after-scale`.
- **Ca thật (người dùng báo "nhanh hơn ít"):** `G:\Work\CorgiBanana\Corgi Banana\KOC Retailer\Thang 8\Yêu Con 1\Yeu Con 1_vid 1.crab` — 37,8 s, sequence 1080×1920 30 fps, nguồn DJI HEVC Main 10 1728×3072 59,94 fps, 25 lớp phủ (14 chuỗi khung động, 2 Retouch video), một **lớp Điều chỉnh phủ cả bài có keyframe cường độ LUT**. Trong app: vẽ trước 31 s (Retouch 27,5 s) + sidecar 124 s. Bản cũ ~3 phút → ~2,6 phút: các tối ưu trước nhắm vào bản dài nhiều batch, dự án này chỉ một batch.
- **Tách khâu (bench `yeu_con_1`, phát lại, BtbN N-123955):** phần hình 118,5 s = giải mã 35,4 s + lọc ~81,6 s + mã hoá ~1,5 s. Bỏ riêng lớp Điều chỉnh: 33,9 s → lớp đó tốn **~85 s**. Nguyên nhân: chuỗi màu chạy ở cỡ NGUỒN (1728×3072 10-bit: `split` → 2×`lut3d` → `blend`), rồi mới co về 1080×1920 — gấp 2,56 lần số điểm ảnh, lại ở 10-bit.
- **Sửa:** tầng màu theo từng điểm ảnh (eq, colorbalance, curves, lut3d, trộn LUT, vignette) chạy SAU phép co khi phép co làm nhỏ khung, vẫn ở định dạng nguồn (co YUV 10-bit → màu → rgb24). Tầng theo lân cận (unsharp/avgblur/noise — bán kính tính theo điểm ảnh nguồn), mọi tầng trước nó, tầng có mặt nạ, clip có keyframe hình học, clip phóng to: giữ chỗ cũ (script trùng từng chữ). Áp cho cả đường nhanh, đường cũ của lane chính và lớp phủ. Adjustment Layer của Premiere/CapCut và preview Pixi đều áp ở cỡ hiển thị, nên thứ tự mới gần chuẩn hơn.
- **Đo:** so thứ tự cũ (FFV1, 1.135 khung): co YUV rồi áp màu **57,95 dB gộp, khung tệ nhất 55,2 dB**; co về rgb24 rồi áp: 43,8 dB (LUT chạy trên 8-bit — loại); co về rgb48: 53,1 dB. Phát lại cả lượt: **server 120,8 → 58,0 s (2,08×)**. Giải mã NVDEC (`-hwaccel cuda`) cho dải nguồn HEVC 10-bit: không lợi (50,2 so với 50,4 s) — đồ thị lọc vẫn là nút thắt; bỏ mã hoá (`-f null`) cũng 51,1 s.
- Còn lại trên dự án này: lớp Điều chỉnh vẫn ~22 s ở cỡ 1080×1920 (2×lut3d + blend 10-bit); Retouch vẽ trước ở renderer 27–42 s (`getImageData` 7 s trong cửa sổ 15 s của CPU profile) — chưa làm.

**1.20 (mới, 2026-10-01) Bitrate theo chất lượng thay cho bitrate cố định** — **đã làm** theo lựa chọn của người dùng (bảng "Quyết định đã chốt"): ô "Bitrate" kiểu CapCut. Test `test:export-bitrate-modes`.
- **Cài đặt:** `index.html` (`exportBitrate` + `exportBitrateMbps`, `readExportBitrate`, `syncExportBitrateUi` — khoá khi ProRes, ô Tùy chỉnh điền sẵn trần của Khuyến nghị theo cỡ khung xuất) → `rate_mode` / `rate_mbps` trong `export_settings` → backend `normalizeExportSettings` (dải 0,5..400 Mbps, số sai → Khuyến nghị, payload cũ chỉ có `quality`: Cao → Khuyến nghị, Cân bằng/Tệp nhỏ → Thấp hơn; dòng `[bitrate]` trong báo cáo) → sidecar `ExportSettings::rateMode/rateMbps`, `RateKbps`, `RateHardwareCq`, `RateCpuCrf`.
- NVENC: `-preset fast -rc vbr -cq N -b:v 0 -maxrate TRẦN -bufsize 2×TRẦN` (`-preset fast` = p1 + tune hq: md5 trùng). Tùy chỉnh: `-b:v T -maxrate 1,5T -bufsize 3T`. CPU: CRF không trần như trước (Khuyến nghị = CRF 18 cũ); Tùy chỉnh = ABR + VBV như NVENC. QSV/AMF/VideoToolbox: chưa có máy đo chế độ chất lượng → giữ bitrate cố định, với con số của mức đã chọn.
- Clip rất ngắn có thể vượt trần một chút (bộ đệm VBV đầy sẵn ở đầu): clip 2 s testsrc2 1080p ra 14,1 Mbps với trần 13.
- **Người dùng báo:** bản xuất phụ đề song ngữ 10,6 GB so với nguồn 612 MB; nghi bitrate quá cao làm chậm.
- **Hiện trạng:** NVENC `-preset fast -b:v <kbps>` với kbps = 13.000 (Cao) × số điểm ảnh / 1080p — không theo nội dung. 3840×1646 → 39,6 Mbps (thực đo 35,9 Mbps). Nguồn AV1 chỉ 2,07 Mbps. Đường CPU (libx264) thì đã dùng CRF 18 theo chất lượng. Premiere "Match Source – Adaptive High Bitrate" cũng chọn bitrate theo cỡ khung (4K 24–30 fps khoảng 35–45 Mbps theo các hướng dẫn phổ biến), nên mức hiện tại không lệch chuẩn nhưng thừa với nguồn đã nén mạnh.
- **Đo trên batch 3 bản 39 phút (4.320 khung 4K, 70 phụ đề, cùng đồ thị lọc):** thời gian 31,7–35,8 s ở mọi mức (không mã hoá: 30,8 s) → **bitrate KHÔNG làm chậm phần dựng hình**; preset p4 chậm hơn p1 ~4,6 s/batch nên loại. VMAF (so bản FFV1 của chính đồ thị, 1.440 khung, ghép cặp theo số thứ tự khung):

  | Mức | Mbps | Cỡ batch | VMAF tb | 1% thấp |
  |---|---|---|---|---|
  | hiện tại (VBR 39,6 M) | 39,1 | 838 MiB | 99,04 | 96,89 |
  | p1 CQ 19 (trần 39,6 M) | 27,7 | 595 MiB | 98,93 | 96,56 |
  | p1 CQ 21 | 21,6 | 463 MiB | 98,74 | 96,14 |
  | p1 CQ 23 | 16,5 | 355 MiB | 98,40 | 95,46 |
  | p1 CQ 26 | 11,4 | 245 MiB | 97,80 | 94,15 |

- Cỡ tệp có tốn thời gian ở bước ghép cuối (`-c copy`, tỉ lệ với cỡ): 80,7 s cho 10,6 GB ở lượt của người dùng.
- Bẫy đo đã gặp: bản tham chiếu FFV1 thiếu `-r/-fps_mode cfr` → lệch vài khung; mkv lưu mốc ms nên so theo PTS thì framesync cặp nhầm cứ 3 khung một (VMAF ~0 đều đặn) — phải `setpts=N/24/TB` cả hai phía.

**1.1 Chỉ giải mã đoạn được dùng** (#1, #13). Env: `CRABBYCUT_EXPORT_SEEK=0`.
- **Bước đầu, rủi ro thấp: seek theo batch (#13).** — **đã viết mã (1.1a), đang kiểm** (2026-09-28):
  - `BatchSeekSeconds`: S = mốc cắt sớm nhất của batch (hình lẫn tiếng) − 1 s; S < 5 s thì không seek. Áp cho mọi chế độ batch (hình, full, tiếng).
  - `SourceSeekSafe`: không seek nếu `temp_input.mp4` có side data "New Extradata" (bản nối `-c copy` nhiều cấu hình mã hoá). Đây là cách dò thay cho `-show_data_hash` trên từng nguồn: payload xuất không mang bảng đoạn, và bản nối có thể được khôi phục từ cache.
  - Đã kiểm trên mã FFmpeg (`ffmpeg_demux.c:1288-1295, 2466-2499`): không `-copyts` thì trim tự chèn là `start=0`, PTS giữ nguyên.
  - Báo cáo dự án ghi `seek=` cho từng batch.
  - **Chỉ batch chỉ-hình** (`FilterScriptMode::VideoOnly`): bộ giải mã AAC mang trạng thái theo số gói đã giải mã (PNS), giải mã từ giữa file cho mẫu float khác — đo: `atrim=12.25:13` giải mã từ 0 và từ `-ss 11.25` khác ở hầu hết mẫu, sau encode lệch tối đa 1 LSB. Lượt tiếng vẫn một lượt từ đầu nên tiếng khớp từng bit.
  - Bản nối `-c copy` hai cấu hình x264 khác nhau (khác PPS, có/không lặp header): có seek và không seek cho bản xuất y hệt (0/9.600 khung khác). Mp4 do ffmpeg nối không mang side data "New Extradata", nên `SourceSeekSafe` là chốt phòng hờ, chưa gặp trên file thật.
  - **A/B xen kẽ, bản cắt 300 s 4K** (A = `CRABBYCUT_EXPORT_SEEK=0`): A 207,9 / 209,2 / 204,2 s, B 193,8 / 181,9 / 184,4 s → trung vị **207,9 → 184,4 s (−11%)**; phần hình 194,7 → 168,6 s. Bản xuất A1 và B1 **giống hệt từng gói** (21.264 gói, cùng 1.457.948.876 byte).
  - **A/B bản 39 phút** (phát lại, server thuần): A **2.978,8 s** (49,6 phút) → B **1.392,5 s** (23,2 phút) = **nhanh 2,14×**. Phần hình 2.853,7 → 1.260,0 s. Từng batch — A: 111 → 127 → 148 → 159 → 194 → 197 → 196 → 214 → 227 → 245 → 261 → 268 → 287 s, batch cuối 221 s; B: phẳng 91–102 s, batch cuối **13 s**. Tiếng 44 s, ghép 57–63 s, tải về 20 s ở cả hai. `reports/perf_export_forever_inside_full_seekA_20260928165253.json` / `seekB_20260928174242.json`.
  - Cộng 1.17 (dừng preview khi xuất), lượt trong app của dự án này ước từ 55,6 phút xuống ~24 phút. Chưa đo lại trong Electron.
  - Mỗi batch (`ExportBatch`) mở nguồn bằng `-itsoffset S -ss S -i source`, với S = mốc trim nhỏ nhất của batch − 1 khung nguồn.
  - Mốc thời gian giữ nguyên như hôm nay, nên filter script không phải đổi gì.
  - Với dự án một clip dài (dạng phụ đề điển hình), việc này biến tổng giải mã từ cấp số cộng (~6,9× ở "Ca thật 2") về đúng 1×.
  - Làm trước phần gom dải bên dưới.
- **ĐÃ LÀM phần gom dải (2026-09-30, phiên 5)** — `PlanSourceRanges` + `ExportBatch`, env tắt `CRABBYCUT_EXPORT_RANGES=0`:
  - Cửa sổ `trim` của các clip trong batch (tính y như `WriteClipVideoFilters`) xếp theo mốc nguồn, gộp khi cách nhau < 2 s (`kRangeMergeGapSeconds`); quá trần thì gộp hai dải có khe nhỏ nhất. Trần `MaxSourceRanges`: 12 ở ≤ 1080p, giảm theo căn bậc hai số điểm ảnh (4K: 6), chưa đo được cỡ nguồn: 6. `ProbeMainSourceForFastPath` nay ghi cỡ nguồn cả khi nguồn không đủ điều kiện đường nhanh.
  - Mỗi dải một input `-reinit_filter 0 -itsoffset S -ss S -i nguồn` (S = đầu dải − 1 s, < 5 s thì không seek) đặt SAU input lớp phủ; clip đọc `[k:v]` của dải mình (`g_clipVideoInput`). Batch chỉ-hình: dải đầu dùng luôn input 0 (một dải = đúng seek theo batch 1.1a). Batch có tiếng: input 0 không seek, chỉ lấy tiếng; một dải không seek thì giữ nguyên lệnh cũ.
  - `SourceSeekSafe` nay dò ở đầu lượt xuất cho mọi nhánh (trước chỉ nhánh nhiều batch).
  - **Đo "Bin Tom"** (20 clip, dùng 76,6 s trên dải nguồn 9,96 → 265 s): đồ thị tách riêng 19–21 → 16,1–16,5 s (12 dải; 20 dải: 17–17,7 s), CPU 95 → 67 CPU-giây, RAM 1,53 → 1,68 GB (20 dải 1,86 GB); **A/B xen kẽ cả lượt xuất (phát lại, 3 + 3 lượt): 27,5 / 27,5 / 28,6 → 24,5 / 24,3 / 24,7 s (−12%)**. Bản xuất trùng framemd5 2.297/2.297 khung.
  - Test `npm run test:export-source-ranges`: clip rải + đảo thứ tự + dùng lại + chồng nhau (5 dải), 20 clip (gộp về 12), đổi tốc độ, không lớp phủ, bản nối hai cấu hình x264 có clip vắt qua chỗ nối — framemd5 và tiếng khớp với `CRABBYCUT_EXPORT_RANGES=0`. Đột biến "seek quá đầu dải 3 s" đỏ ngay khung 0 (+0,5 s thì không đỏ: `-ss` về keyframe trước mốc và không vứt khung nào, GOP nguồn thử 2 s).
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

**1.2 Giải mã phần cứng** (hạ ưu tiên theo số đo, trừ nguồn nặng). Env: `CRABBYCUT_HWACCEL_DECODE=0`. — **THAY BẰNG 1.21 (2026-10-02)**; số đo NVDEC trên GTX 1060 ở đó.
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

**1.8 Song song hoá** (#9, làm sau cùng, chỉ bật nếu dự án trọn vẹn lợi ≥ 15%). Env: `CRABBYCUT_EXPORT_PARALLEL=0|N`. — **NHIỀU TIẾN TRÌNH: ĐÃ LÀM, BẬT mặc định (2026-10-01, phiên 8)**; test `test:export-parallel`.
- **Vì sao bây giờ:** sau các mục giảm việc, dự án một batch nghẽn ở MỘT luồng filter (chuỗi lớp phủ): Bin Tom chỉ dùng 40–55% của 16 luồng CPU. Đo trước bằng lệnh đã ghi, chạy ấm: chia 2 / 3 / 4 / 6 batch chạy cùng lúc cả lượt tiếng: 8,1 / 7,9 / 7,5 / 7,7 s so với ~19 s nối tiếp.
- **Mã** (sidecar): `ExportBatch` tách thành `PrepareExportBatch` (ghi filter script + dựng sẵn dòng lệnh trừ bộ mã hoá — chạy tuần tự vì đụng biến toàn cục) và `RunBatchJobs` (Windows: `SpawnIn` = `CreateProcessW` không chờ + `WaitForMultipleObjects`; nơi khác: nối tiếp). `RunExportJobs`: lượt tiếng khởi chạy trước (nhẹ); lỗi bộ mã hoá phần cứng khi chạy song song thì chạy lại từng lượt bằng NVENC (trần số phiên GeForce), vẫn lỗi thì chạy lại MỌI batch hình bằng CPU — không ghép lẫn batch NVENC với libx264. `ExportParallelWorkers`: 1 lượt hình cho mỗi 4 luồng CPU, tối đa 3, bớt theo RAM (~1,5 GB/lượt ở ≤ 1080p, ~3 GB ở 4K). Dự án dưới 240 s (trước đây một batch) nay chia `2 × số lượt` batch, tối thiểu 8 s mỗi batch, **chỉ ở biên clip**; dự án dài giữ batch 180 s, chạy song song. Sự kiện `timing` có `workers`.
- **Tốc độ** (phát lại, xen kẽ, 1 / 2 / 3 / 4 lượt hình): Bin Tom 20,7 / 15,0 / 14,1 / 13,8 s; **A/B bản cuối** (tắt / mặc định 3, 3 + 3 lượt): **20,5 / 20,5 / 20,4 → 13,3 / 13,2 / 13,2 s (−35%)**; "Yêu Con 1" **56,9 / 56,0 → 49,1 / 49,6 s (−13%)**; Test.crab 13,5 / 11,4 / 11,0 s — nhưng chỉ cắt ở biên clip thì Test.crab không còn mốc cắt an toàn (video lớp phủ vắt qua biên clip duy nhất) nên chạy một lượt như cũ; "Yêu Con 1" chỉ cắt được một mốc (lớp Điều chỉnh có keyframe trên mọi clip); phim 4K AV1 300 s đã bão hoà CPU nên không đổi (67 / 67 / 66 s).
- **Bản chia batch phải TRÙNG bản một lượt — lần đầu đo ra KHÔNG trùng** (khung tệ nhất 13–19 dB trên cả ba dự án). Đường nhiều batch có sẵn từ trước cho dự án dài, nên các lỗi dưới đây đã có trong bản phát hành, chỉ lộ ra khi so từng khung:
  1. **Cắt giữa clip** (Test.crab): nửa sau khởi động lại `fps` từ khung nguồn đầu của nó → nguồn khác nhịp (30 → 25) chọn khung lệch pha. → chế độ song song dự án ngắn chỉ cắt ở biên clip (dự án dài vẫn cắt giữa clip: phim một clip).
  2. **Lớp nhạc nền chặn mọi mốc cắt** (Yêu Con: tiếng 0–37,8 s): `OverlayIsTimeVarying` coi mọi lớp phủ không phải ảnh là chặn. Batch chỉ dựng hình → chỉ lớp phủ có hình mới chặn; `OverlaysForBatch` cũng thôi nạp tệp tiếng làm input thừa.
  3. **Chuỗi khung chữ trễ / sớm 1 khung** (Yêu Con, Bin Tom): khung chuỗi bake đúng nhịp xuất nên trùng mốc khung nền ("hoà"); framesync làm tròn µs hai phía (ƯCLN timebase có mẫu > 500.000 thì lùi về µs), mà mốc khung nền ở lượt một batch phụ thuộc số mẫu tiếng (`concat v=1:a=1` lấy độ dài đoạn theo luồng dài hơn) — đo: khung 266 mang 8.866.667 µs ở lượt một batch, 8.866.666 µs ở batch chỉ-hình → chữ trễ 1 khung. Cộng thêm `setpts=…+start/TB` CẮT phần lẻ trên timebase 1/fps: chữ ở 20,067 s × 29,99926 = 601,995 → 601, **sớm 1 khung và mất khung 0** (rơi trước cửa sổ `enable`) — lỗi này có ở MỌI bản xuất. → chuỗi khung đưa về timebase µs và đặt sớm đúng ¼ khung (`settb=AVTB,setpts=…+round((start−¼ khung)/TB)`): khung k luôn hiện ở khung nền S+k. Video lớp phủ: sớm 0,1 ms (video cùng nhịp đặt đúng lưới cũng "hoà" ở mọi khung, nhất là khung cuối cửa sổ). Ảnh tĩnh giữ như cũ (timebase 1/25: sớm 0,1 ms bị cắt thành sớm 40 ms, mất khung cuối cửa sổ — đã gặp khi thử).
  4. **Ảnh tĩnh mất khung cuối batch**: lớp phủ tĩnh vắt qua mốc cắt bị xén khít mép, luồng ảnh 25 khung/s hết ở mép − 40 ms → khung nền cuối batch mất lớp phủ. → xén ở cuối batch thì kéo dài thêm 1 s qua mép (`kBatchOverlayTailSeconds`; `-t` của ảnh lặp cũng +1 s).
  5. **Lượt tiếng riêng lệch từng mẫu** (Bin Tom, 20 đoạn): nối tiếng một mình theo số mẫu, còn lượt một batch đệm lặng tới cuối đoạn hình. → lượt chỉ-tiếng nối kèm đoạn hình giả 16×16 đúng nhịp + đúng số khung (`concat` lấy mốc khung cuối × n/(n−1)) rồi đổ vào `nullsink`: tiếng ra y hệt.
  6. **Ghép cuối `-shortest` cắt khung hình cuối phim** (tiếng hết trước hình vài µs: 42,008625 so với 42,008633 s). → bỏ `-shortest`.
  Còn một khác biệt cố ý: lớp phủ ghép RGBA (có keyframe, hoặc mọi lớp phủ khi xuất ProRes) ở lượt một batch kéo CẢ luồng qua YUV → RGBA → YUV, kể cả ngoài cửa sổ của nó (thương lượng định dạng là tĩnh); batch không chứa lớp phủ đó thì khỏi vòng đổi → **gần bản chuẩn hơn** (Yêu Con batch 1: lệch đều ~48,7 dB so với lượt một batch). Hướng sau: ở lượt một batch cũng chỉ đổi RGBA trong cửa sổ của lớp phủ.
- **Kết quả sau chữa** (bản lossless, so theo số thứ tự khung — so theo PTS thì mkv làm tròn ms cặp nhầm khung, xem 1.20): **Bin Tom trùng tuyệt đối** (2.297/2.297 khung, tiếng md5 trùng); Yêu Con: tiếng trùng, batch 0 trùng, batch 1 chỉ khác do vòng RGBA nói trên (khung tệ nhất 48,6 dB).
- **Lượt một batch cũng đổi** (vì sửa lỗi 3): so bản cũ, Bin Tom 318 khung / Yêu Con 239 khung khác — đều là hoạt ảnh chữ dời đúng 1 khung về khung dự định (ví dụ chữ ở khung 68: bản cũ hiện khung 1 của hoạt ảnh ở khung 68, mất khung 0; bản mới hiện khung 0). Bộ so 0.3 (b)/(d) sẽ báo các khung đó; đây là sửa lỗi lệch preview, không phải tối ưu.
- **Test** `test:export-parallel` (vào `npm test` và `test:export-all`): hai kịch bản ở nhịp 1218000/40601 (nhịp NTSC 29.970030 làm tròn lên, không lộ lỗi nào), ProRes (nội khung), một lượt so với 3 lượt: framemd5 + PCM trùng; chuỗi khung 45 mức xám đúng từ khung 452, khung trước/sau cửa sổ không có. Kịch bản A 6 × 7 s / 48 kHz, B 12 đoạn lẻ / 44,1 kHz (mỗi bố cục lộ một nhóm lỗi khác — bố cục 12 đoạn lẻ cũng làm lộ lỗi 4 của bản đầu phép sớm 0,1 ms áp cả cho ảnh tĩnh). **Đột biến** (mỗi phép chữa bỏ đi, build exe riêng): bỏ sớm ¼ khung của chuỗi → đỏ khung 452–464; bỏ sớm 0,1 ms của video → đỏ 900–913; bỏ kéo dài ảnh tĩnh ở cuối batch → đỏ khung 419; trả lại `-shortest` → thiếu 1 khung; cho cắt giữa clip → đỏ từ khung 0; bỏ đoạn hình giả ở lượt tiếng → test tổng hợp vẫn xanh (độ dài đoạn tình cờ không lệch mẫu) nhưng **Bin Tom bắt được**: tiếng bản song song md5 `4fe22044…` so với `f780409c…` của bản một lượt. Phép "đặt lại mốc lane chính theo lưới khung" thử ở giữa chừng: sau khi lớp phủ đã dời sớm thì đột biến bỏ nó không đổi gì → đã gỡ. `test:export-source-ranges` chạy `PARALLEL=1` (đếm dải của một lượt).
- **Chuỗi filtergraph** (`ifilter_bind_fg`, có từ FFmpeg 7.1):
  - Kỳ vọng 1,2–1,6×. Hàng đợi vào của graph sau chỉ 2 khung, dùng chung cho mọi input, không nới được (`ffmpeg_sched.c:372-392`).
  - ⚠️ **Đã gặp thật (2026-09-30):** tách phần chuẩn bị của 19 lớp phủ Bin Tom ra 19 filtergraph riêng (mỗi graph một luồng, đồ thị chính chỉ trộn) → ffmpeg **treo cứng** (CPU ~0). Graph chuẩn bị của một câu chữ ở giây 45 nhả khung "tương lai" lấp hàng đợi dùng chung, chặn khung lane chính. Chuỗi filtergraph chỉ dùng được khi mọi graph phía trước đi cùng nhịp với luồng chính.
  - `-filter_complex_threads` ≈ 16/số tầng.
  - `sendcmd` ở chung graph với `blend@tag` của nó; `movie=` ở chung graph với nơi dùng.
  - Mỗi tầng kết thúc bằng đúng định dạng tầng sau cần. Không tách riêng tầng chuyển màu cuối.
- **Nhiều tiến trình:**
  - Ưu tiên cắt ở biên clip: `SplitIntervalAtFrame` (`:2350-2359`) khởi động lại `setpts`/`fps` của nửa sau, có thể chọn khung nguồn khác khi nguồn VFR.
  - `ExportBatch` chưa an toàn khi chạy đồng thời (biến toàn cục `g_filterAuxDir`/`g_filterAuxSeq` `:1882-1883`, và `plan` bị đổi tại chỗ `:3057-3060`). Ghi mọi script trước rồi mới spawn.
  - Lỗi phiên NVENC: thử lại batch đó bằng NVENC sau khi các batch khác xong, rồi mới chuyển mọi batch sang CPU. GeForce giới hạn số phiên, dùng chung với OBS/ShadowPlay; GTX 1060 chỉ có một bộ NVENC.
  - Cho dự án không lớp phủ đi đường VideoOnly + một lượt AudioOnly. Việc này sửa luôn khoảng hở AAC ở mối nối của đường 80 interval (`:3356`).
- Bỏ `+faststart` ở file batch trung gian (chỉ có ích khi có nhiều batch). — **ĐÃ LÀM (2026-09-30)**, kèm bước ghép cuối: `moov` ghi vào **chỗ dành sẵn** ở đầu tệp (`-moov_size`, `MoovReserveBytes`: 256 KB + 40 byte mỗi mẫu hình/tiếng, tiếng tính như AAC 96 kHz — dư ~15× so với nhu cầu đo được) thay cho `+faststart` (ghi xong rồi đọc + ghi lại cả tệp). Thiếu chỗ thì ffmpeg trả lỗi "reserved_moov_size is too small" và sidecar ghép lại bằng `+faststart`. ProRes giữ `+faststart`. Đo bản 39 phút: ghép **84,3 → 27,2 s**. `test:export-batch-seek` kiểm `moov` đứng trước `mdat` và có hộp `free` ngay sau.
- **Sau 1.11, xem lại lý do chia batch.** Batch ~180 s sinh ra chỉ để chặn chi phí chuỗi lớp phủ tăng theo (số khung × số lớp phủ) (`:2253-2279`). Khi phụ đề đã thành một luồng, chi phí đó biến mất. Kích thước batch nên chọn lại theo hai mục đích còn lại:
  - song song (mục này), tức đủ batch cho N tiến trình;
  - cache (1.13), tức lưới cố định, ví dụ 60 s.

**1.9 Chọn encoder bằng dò chức năng** (sửa lỗi cho máy không NVIDIA).
- Mã hoá thử 0,1 s theo thứ tự `h264_nvenc → h264_qsv → h264_amf → libx264`.
- Cache ở `%LOCALAPPDATA%\CrabbyCut\encoder-probe.json`, theo {hash `ffmpeg -version`, GPU, driver}.
- Không đổi tham số NVENC.

**1.11 Mỗi track phụ đề/chữ tĩnh thành MỘT luồng ảnh** (#12, #7; đã chốt 2026-09-27). Env: `CRABBYCUT_EXPORT_SUBSTREAM=0`. — **HOÃN (2026-09-30, phiên 4), theo số đo:**
- Batch 3 bản 39 phút (4.320 khung 4K, 70 phụ đề, `-f null`, sau khi chữa `tpad`): lane chính 22,9 s; lane + MỘT `overlay` khung track trong suốt suốt batch (cận dưới của 1.11) 23,6–24,2 s; cả 70 lớp 25,9–26,2 s. Tức 1.11 lợi ~2 s/batch ≈ 27 s cho cả bản 39 phút (~5%).
- Các giả thuyết đã loại bằng số đo: tính biểu thức x/y mỗi khung (`eval=init` không đổi gì), biểu thức `enable` (bỏ hẳn không đổi gì), framesync chép khung vì luồng ảnh 25 khung/s lệch lưới 24 (đưa về `fps=24` không đổi gì — sau EOF framesync hạ `sync` về 0 nên không chép).
- Chỗ khó khi làm: phải chép ĐÚNG quy tắc hiện/tắt của đường cũ ở từng khung. Sau `concat`, luồng chính mang timebase 1/1.000.000 (`avf_concat.c`: `outlink->time_base = AV_TIME_BASE_Q`), mốc từng khung phụ thuộc cách cộng dồn độ dài segment; khung cuối của mỗi câu còn phụ thuộc EOF của `trim=duration` (làm tròn gần nhất ở timebase 1/25) và `setpts` cắt phần lẻ (`D2TS`). Hướng sidecar-thuần đã phác: đệm từng câu (đã xử lý như cũ) vào khung chung của track ở toạ độ chẵn, nối thành một luồng đúng lưới khung, ghép bằng một `overlay`; với `alpha = 0` công thức của `overlay` cho lại đúng điểm ảnh nền nên có thể trùng từng bit.
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

**1.12 Độ phân giải xuất có tác dụng thật** (đã chốt 2026-09-27). — **PHA 1 ĐÃ LÀM (2026-09-30, phiên 4); PHA 2 ĐÃ LÀM (2026-10-01, phiên 8), BẬT mặc định từ 2026-10-02**:
- Ô "Kích thước video" trong hộp thoại xuất trước đây **bị ẩn** (`display: none`) và vô tác dụng; nay hiện ra, lựa chọn đầu đổi tên "Theo Sequence" (cùng nhãn với ô tốc độ khung hình).
- Backend `exportOutputFrame(seqW, seqH, preset)` tính `output_width/height` + `output_content_width/height` (renderer vẫn gửi lựa chọn ở `legacy_resolution`); sidecar dựng đồ thị ở cỡ sequence như cũ, `OutputColorFilters` co phần hình ở phép đổi màu cuối (`scale … flags=lanczos`, một lượt swscale) rồi `pad` đen toạ độ chẵn nếu khổ lệch. Bitrate NVENC tính theo cỡ xuất. Báo cáo dự án có dòng `output_size`.
- **Khổ preset khác khổ sequence — ĐÃ CHỐT 2026-09-30: như Premiere.** Premiere (Export → Scaling mặc định "Scale To Fit") ra đúng cỡ preset, thêm viền đen; CapCut coi độ phân giải là cạnh ngắn, giữ khổ dự án (2.35:1 ở 1080p ≈ 2560×1080, không viền). Người dùng chọn kiểu Premiere = `EXPORT_SCALE_MODE = 'fit'` (cũng là cách nhánh xuất cũ `BuildVideoFilter` của CrabbyCut từng làm: `force_original_aspect_ratio=decrease` + `pad`). Nhánh `'short'` giữ lại trong `exportOutputFrame` (có test) phòng khi cần thêm lựa chọn sau.
- Test `npm run test:export-resolution`: phép tính cỡ (cả hai kiểu), và 4 lượt xuất thật (khổ rộng → 720p viền trên/dưới; 4:3 có lớp phủ → viền hai bên; cùng khổ phóng to → không viền; ProRes khổ dọc): cỡ khung, viền đen (Y≈16), phần hình so với bản xuất đúng cỡ sequence rồi co bằng ffmpeg 44–56 dB, lệch 4 px tụt còn 19–24 dB.
- **PHA 2 — ĐÃ VIẾT MÃ (2026-10-01, phiên 8), BẬT MẶC ĐỊNH 2026-10-02** (người dùng chốt miễn tiêu chí (a), xem dưới; tắt bằng `CRABBYCUT_EXPORT_OUTSCALE=0`):
  - **Đo trước:** xuất 1080p theo pha 1 **không nhanh hơn** xuất đúng cỡ 4K (bản cắt 300 s 4K, 100 phụ đề, xen kẽ: cỡ sequence 70,0 / 78,4 s, 1080p 75,7 / 78,3 s, 720p 70,6 / 74,8 s) — đồ thị vẫn ghép ở 4K, cộng thêm một lượt lanczos 4K → 1080p trên luồng filter.
  - **Mã** (`ApplyOutputScaleToPayload`, sidecar): khi cỡ xuất NHỎ hơn sequence, cả cảnh co đều quanh tâm theo `output_scale` (backend `exportOutputFrame` gửi thêm hệ số này): nhân vào `fitScale` (nên áp cho cả nhánh keyframe scale), vị trí tĩnh, biểu thức vị trí keyframe và độ dời hoạt ảnh (bọc `((expr)*s)`), cỡ chữ drawtext, bề rộng mép mềm; `settings.width/height` = cỡ phần hình; `OutputColorFilters` chỉ còn đổi màu + đệm. Không đổi: số đo theo điểm ảnh nguồn (xoá logo, mặt nạ, bán kính làm mờ — đứng trước phép co), hệ số nhân hoạt ảnh, góc xoay. PNG chữ vẫn bake ở mật độ sequence, chuỗi của lớp phủ co nó. Phóng to giữ pha 1. Sự kiện `timing` + báo cáo có `graph_size`.
  - **Bẫy làm tròn:** hệ số in 6 chữ số, s = 2/3 thành "0.666667" → clip vừa khung 1920 px ra 1280,0006 → `ceil(·/2)*2` = 1282 (tràn 2 px). Nhân `fitScale` thêm (1 − 2e-6): tích đáng lẽ chẵn tròn ra đúng số đó. Đột biến bỏ phép hụt: ca keyframe tụt 40,3 → 32,1 dB.
  - **Tốc độ (phát lại, A = pha 1, B = pha 2, xen kẽ):** 4K → 1080p bản cắt 300 s: 82,6 / 80,4 → **68,8 / 66,1 s (−17%)**, phần hình 72,6 → 58,6 s (còn lại chủ yếu là giải mã AV1 4K); Test.crab → 720p: 17,1 / 17,0 / 15,7 → **13,1 / 13,5 / 12,6 s (−23%)**; Bin Tom → 720×1280: 23,8 / 26,2 / 25,1 → 23,5 / 22,5 / 22,7 s (−10%) — ngang xuất đúng cỡ sequence (23,9 / 22,5 / 21,6 s): dự án này nghẽn ở luồng filter đơn (CPU 40–55%), và 17 chuỗi khung chữ nay phải co từng khung (bake chữ ở mật độ cỡ xuất sẽ bỏ được phép co đó — chưa làm).
  - **Test** `test:export-resolution` thêm 3 ca co nhỏ, so pha 2 với pha 1 từng khung: khổ 2,34:1 → 720p (clip vừa khung ở s = 2/3, viền trên/dưới, lớp phủ lệch tâm) 36,6 dB; clip thu nhỏ + dời, lớp phủ keyframe vị trí/scale, lớp phủ hoạt ảnh + mép mềm 40,3 (tệ nhất 37,6); clip keyframe vị trí/scale (đường RGBA) 36,6 (tệ nhất 32,6 — dao động 32,6..42,6 theo khung: pha 2 đặt vị trí/cỡ ở lưới điểm ảnh XUẤT). Ngưỡng 34 / 30 dB. **Đột biến** (6 bản, đều đỏ): bỏ nhân vị trí lớp phủ 21,2 dB; keyframe lớp phủ 19,6; hoạt ảnh lớp phủ 23,9; keyframe clip 11,3; vị trí clip 13,0; bỏ phép hụt 2e-6 31,4.
  - **Bộ so 0.3, Test.crab → 720p: (b) ĐẠT, (a) TRƯỢT.** Mới/cũ PSNR 49,9 dB (tệ nhất 40,1), SSIM 0,9974, VMAF 97,6; tiếng giống hệt. So bản chuẩn: cũ 45,49 → mới **42,86 dB** (Δ −2,6). Bản chuẩn dựng từ CHÍNH đồ thị pha 1 ở độ chính xác cao (ghép ở cỡ sequence rồi co lanczos), nên cách lấy mẫu nào khác thứ tự cũng "xa" nó hơn. Lệch đều 1–3 dB, nhiều nhất ở đoạn chỉ có clip 4K ở 107% (44–47 s: 41,3 so với 35–36 dB) — pha 1 co hai lần (bicubic 0,535 rồi lanczos 2/3), pha 2 co một lần (0,357). Co bằng lanczos thay bicubic **không** thu hẹp (42,39 dB). → Người dùng chốt 2026-10-02: **bật**, miễn (a) cho mục này.
  - Chưa làm: bake chữ ở mật độ của cỡ xuất (renderer, `templateExportBakeDensity`); lớp phủ phóng to ở cỡ xuất.
- **Hiện nay** backend ép `resolution: 'sequence'` (`index.html:15821`, `server.js:6927`), nên ô "Độ phân giải" vô tác dụng. Sidecar đã có sẵn `ApplyResolutionPreset` (`core_process.cpp:1219`).
- **Pha 1:** dựng đồ thị ở cỡ sequence như cũ, `scale` xuống cỡ xuất ở đuôi (`OutputColorFilters`). Đúng ngay, và giảm tải cho encoder.
- **Pha 2:** dựng cả đồ thị ở cỡ xuất (nhân mọi toạ độ/cỡ clip, lớp phủ, khung track 1.11 với hệ số f). Renderer bake chữ ở mật độ của cỡ xuất (`templateExportBakeDensity`). Phần ghép và filter nhẹ đi ~f².
  - Kiểm pha 2 bằng 0.3 so với pha 1.
- Giải mã nguồn vẫn ở cỡ gốc. Với nguồn 4K AV1 thì giải mã vẫn là trần, xem 1.2.
- Ví dụ "Ca thật 2" xuất 1080p: phần ghép ~4× nhẹ hơn, encode ~4× nhẹ hơn.

**1.13 Bộ nhớ đệm render cho lượt xuất lại** (đã chốt: làm sau các tối ưu chính). — **XONG (phiên 13, 2026-10-03)**; trạng thái + số đo ở mục 24 ("BÀN GIAO PHIÊN 13 -> 14"), cách làm ở APP_INTERNALS "Xuất lại dùng bộ nhớ đệm render". Khác với phác thảo dưới đây: cache CHUNG theo khoá nội dung (không chia theo dự án — khoá không chứa đường dẫn, dự án nào trùng nội dung cũng dùng được); lưới cố định nằm ngay trong `PlanOverlayBatches` (mốc mong muốn k × target) thay cho lưới 60 s riêng; định danh tệp theo nội dung (xxHash64) chứ không theo đường dẫn + mtime; ô bật/tắt ở Cài đặt › Xuất video, nút dọn ở Cài đặt › Bộ nhớ đệm.
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

**1.21 (mới, 2026-10-02) Bộ ghép GPU riêng — máy có GPU thì xuất bằng GPU** (thay cho 1.2). — **ĐANG LÀM**: G0 + G1 xong, G2 hai bộ lọc đầu xong, G3 + G4 xong (phiên 10), **G5 xong (phiên 11, Release đã có)**, **G2: LUT trên GPU + lớp phủ dựng bằng CPU rồi tải lên xong (phiên 12, bản `.2` đã phát hành)** (trạng thái chi tiết + việc kế tiếp: "BÀN GIAO PHIÊN 12 -> 13" ở mục 23 phần VIỆC TIẾP THEO).
- **Phiên 10 — chạy đua GPU:** đồ thị GPU đầu tiên ra khung RÁCH / lớp phủ chữ lệch 2–6 khung khi luồng lọc chạy trước GPU (ra thẳng NVENC, nhiều batch song song). Đã loại: bộ đệm ghim khi tải lên (bỏ — lộ lỗi cả khi ra FFV1), NVENC đọc sớm (vá nvenc chờ stream trước khi mã hoá: không chữa). Chữa bằng chờ GPU từng khung ở mọi bộ lọc CUDA + lúc tải lên (`sync=1`, ffmpeg riêng `6dcb4c0`): sạch, không chậm hơn. Gốc thật chưa rõ (mọi lệnh trên stream NULL) — nếu sau này muốn GPU chạy không đồng bộ để nhanh hơn thì phải tìm ra trước, kiểm bằng `test:export-gpu` + 3 batch song song.
- **Yêu cầu (người dùng, 2026-10-02):** "máy có GPU thì render tận dụng 100% GPU, chỉ máy không có GPU mới render bằng CPU". Lúc xuất người dùng thấy GPU 30–50%, CPU gần 100%. Số đo bên dưới cho thấy 30–50% đó là NVENC đang **chờ khung**: CPU nghẽn ở giải mã + bộ lọc.
- **Người dùng chốt (2026-10-02):**
  - (1) **Tự viết bộ ghép GPU riêng**: tự build ffmpeg (Bước 2) kèm bộ lọc CUDA của CrabbyCut, chấp nhận nhiều phiên và tự bảo trì bản ffmpeg riêng thay cho bản ghim Gyan.
  - (2) **Bảng cài đặt render cho người dùng chọn GPU/CPU, mặc định GPU nếu máy có GPU**, kể cả với nguồn mà GPU giải mã chậm hơn CPU.
  - Cho phép tải công cụ build: MSYS2 vào `D:\msys64`, mã nguồn + build ở `D:\CrabbyCut_ffmpeg` (ổ E: chỉ còn 8 GB).
- **CPU tốn vào đâu** (1 lượt phát lại, `threadprof` đọc CPU từng luồng ffmpeg; bản BtbN):

  | Dự án | Thời gian | CPU-giây | Giải mã (CPU) | Lọc | NVENC dùng |
  |---|---|---|---|---|---|
  | Bin Tom (H.264 1080×1920) | 13,5 s | 80 | 44% (+ PNG) | 41% | 19% |
  | Yêu Con (HEVC 10-bit 1728×3072 @ 59,94) | 51,8 s | 527 | 44% | 55% | 5% |
  | Test.crab (H.264 4K) | 13,5 s | 130 | 34% | 62% | 16% |
  | Phim 4K AV1 (cắt 300 s) | 59 s | 692 | 72% (dav1d) | 20% | 52% |

- **Thông lượng GPU trên GTX 1060** (600 khung, `-benchmark`): NVDEC 4K H.264 **~175–180 khung/s** (CPU 360 khung/s nhưng ăn 11 lõi); 1080×1920 H.264 664 khung/s (CPU 1.040); **HEVC 10-bit 1728×3072: NVDEC 281 khung/s, 0,6 CPU-giây — CPU 145 khung/s, 90 CPU-giây**. Giải mã Vulkan 4K H.264 155 khung/s. AV1: không có (cần RTX 30+). Khởi động CUDA ~0,34 s (CPU 0,38 s) — không phải chi phí.
- **Đã thử và LOẠI (chậm hơn hoặc vỡ):**
  - **Ghép toàn GPU bằng bộ lọc CUDA sẵn có** (`hwupload_cuda` + `scale_cuda` + `overlay_cuda`, NVENC nhận khung CUDA): Bin Tom 7,4 → **13,3 s** (4 lượt song song), tuần tự 10,8 → 20,5 s; giải mã thẳng ra khung CUDA vẫn chậm hơn (batch 4: 1,32 → 1,81 s). Chép CPU↔GPU đồng bộ từng khung trên luồng lọc + NVDEC H.264 chậm hơn CPU.
  - **NVDEC ra RAM** (`-hwaccel cuda`, bộ lọc CPU như cũ): Yêu Con 42,6 → 38,3 s (−10%), Bin Tom 7,8 / 7,8 s, Test.crab 12,3 → 13,5 s (chậm hơn).
  - Vulkan/libplacebo: chạy được, nhưng tải lên/tải về của hwcontext Vulkan chậm (4K: ~8 ms/khung); nối CUDA↔Vulkan (`hwmap`/`hwupload`) báo "Invalid argument".
- **Lai — NVDEC cắt + co trong phần cứng, khung nhỏ về CPU** (`h264_cuvid`/`hevc_cuvid -crop -resize`): HEVC 10-bit → 1080×1920: 10,2 s / 118 CPU-giây → **4,17 s / 1,5 CPU-giây**; 4K H.264 → 1080p 2,79 s / 30,2 → 3,45 s / 3,1 (trần NVDEC). Chất lượng phép co phần cứng trên footage 4K máy ảnh: so lanczos 46,1 dB, **hơn** bicubic của swscale (44,6). Trọn lượt: Yêu Con 44,6 → 34,2 s (−23%, bản `scale_cuda`), Test.crab 12,9 → 11,25 s (−13%). Lợi nhỏ vì phần còn lại (hiệu ứng, ghép RGB, đổi định dạng) vẫn ở luồng lọc CPU — đó là lý do người dùng chọn tự viết bộ ghép.
- **Bẫy đã gặp (bộ ghép riêng phải xử lý):**
  - **`HWACCEL_CHANGED` của fftools** (`ffmpeg_filter.c:3238-3241`): khung mang `hw_frames_ctx` mới (NVDEC khởi tạo lại sau khi tua, ở chỗ đổi SPS) là **luôn** dựng lại cả đồ thị, kể cả có `-reinit_filter 0` → trim/concat mất trạng thái. Bản ffmpeg riêng phải vá: cùng định dạng + cỡ thì chỉ đổi tham chiếu.
  - **cuvid hỏng ở chỗ nối của `temp_input.mp4`** (nối `-c copy` các nguồn cùng chữ ký, mỗi đoạn mang SPS riêng): giải mã vắt qua chỗ nối (kể cả chỉ phần tua lùi từ keyframe trước) thì 6 khung cuối đoạn trước mang hình đoạn sau và 6 khung cuối dải bị mất; dừng hẳn trước chỗ nối thì trùng từng bit với CPU. Input `-t` KHÔNG cắt ở bộ tách luồng khi giải mã (chỉ `trim` trong đồ thị) nên không chặn được. Cần bảng đoạn (`concatSegmentTable` của backend, lưu `main_lane_segments` trong .crab) đi theo payload xuất.
  - **NVENC nhận khung CUDA từ nhiều vùng nhớ** (mỗi `scale_cuda` một pool) → "Could not register an input HW frame"; chép về MỘT vùng nhớ ở đuôi thì chạy.
  - **`scale_cuda` chép cả trường crop của khung vào** (`av_frame_copy_props`) → `crop` thứ hai trên khung CUDA cộng dồn, hình lệch hẳn (PSNR 8 dB).
  - `overlay_cuda`: alpha của chroma lấy theo điểm (CPU lấy trung bình 2×2), cắt phần lẻ thay vì làm tròn, không có độ mờ; chỉ 8-bit. `scale_cuda`/`colorspace_cuda` không đổi ma trận màu (nguồn bt601 full-range như DSCF3442 phải đổi).
- **Kế hoạch (bộ ghép GPU riêng, NVIDIA trước):**
  - **G0 — bộ công cụ + bản build tương đương bản ghim:** MSYS2 UCRT64, ffmpeg `n8.1.1` (nhánh `crabbycut-8.1.1` ở `D:\CrabbyCut_ffmpeg\ffmpeg`), nv-codec-headers `n12.2.72.0` (13.x đòi driver ≥ 610), `--enable-cuda-llvm` (clang dịch kernel, không cần CUDA Toolkit). Chỉ bật thư viện CrabbyCut dùng: zimg, libplacebo/Vulkan/shaderc, freetype/fribidi/harfbuzz/fontconfig, libass, dav1d, x264, x265, vmaf, libvpl, AMF, NVENC/NVDEC/cuvid, d3d11va. Đích: 36/36 test export xanh trên bản tự build trước khi thêm gì.
  - **G1 — vá fftools:** bỏ dựng lại đồ thị khi chỉ `hw_frames_ctx` đổi mà định dạng/cỡ giữ nguyên → giải mã NVDEC ra thẳng khung CUDA, không chép.
  - **G2 — bộ lọc CUDA của CrabbyCut** (`libavfilter/vf_*_crab_cuda`): co + cắt lẻ điểm ảnh + đổi ma trận/dải màu + đặt vào khung (một lượt cho hình học đường nhanh); trộn lớp phủ có độ mờ (biểu thức/keyframe), alpha chroma trung bình như `AlphaWeightedYuva420`, làm tròn như CPU; LUT 3D (+ trộn hai LUT theo cường độ); eq. Tải PNG lên bằng bộ đệm ghim, không đồng bộ.
  - **G3 — sidecar dựng đồ thị GPU** khi chế độ GPU: tính năng chưa có bản GPU thì `hwdownload` → bộ lọc CPU → `hwupload` (đúng trước, nhanh sau).
  - **G4 — Cài đặt › Xuất video: "Render bằng: GPU / CPU"**, mặc định GPU khi dò thấy GPU dùng được; payload mang lựa chọn xuống sidecar.
  - **G5 — phát hành:** nơi đặt bản ffmpeg tự build — **người dùng chốt 2026-10-02: repo riêng `tamphamdesigner92-tb/ffmpeg-for-CrabbyCut`**, nội dung = bản vá + kịch bản (chốt 2026-10-03). Phiên 11: repo + zip `n8.1.1-crabbycut.1` + `ffmpeg_pin.js` xong, hồi quy trên zip, Release đã tạo và kiểm (mục 22). macOS giữ đường hiện tại (Bước M).
  - Mỗi bước: test export xanh ở cả hai chế độ, bộ so 0.3, A/B ≥ 3 lượt.

**Tương thích nhánh macOS:** phần riêng Windows (`-hwaccel cuda/d3d11va`, `CreateProcessW`) gói sau `#ifdef _WIN32` hoặc sau phép dò; phần trung lập viết để `git apply` sang `CrabbyCut_Private` được. Chi tiết macOS ở **Bước M**.

**Điều kiện chuyển tiếp:** có bảng A/B từng mục; mọi fixture qua 0.3; toàn bộ test export xanh.

---

# NHÁNH 1B — Bước vẽ trước trong Electron (chỉ làm nếu Bước 0 đo được ≥ 30% tổng thời gian)

**Phiên 7 (2026-10-01): ĐỦ NGƯỠNG trên "Yêu Con 1"** (sau 1.19 + 1.6 phần sidecar còn ~58 s, vẽ trước 31–42 s) **— đã làm phần Retouch.** Test `test:retouch-frames`.
- **Đo trước (Electron thật, nguồn DJI HEVC 10-bit 1728×3072 59,94 fps, 294 khung miếng vá):** mỗi khung 81 ms ở bước lấy khung — tua `<video>` 35 ms + chờ GPU giải mã xong 45 ms (getImageData đứng đợi); vẽ/cắt < 1 ms. Chạy song song 2–4 thẻ video: 76–84 ms/khung (bộ giải mã bão hoà). rVFC đã thử và bỏ từ trước (thẻ ẩn, cửa sổ nền) — xem eachSourceFrame.
- **Làm:** `POST /api/retouch/frames` (`backend/retouch-frames.js`): ffmpeg giải mã TUẦN TỰ đoạn cần, chọn khung CUỐI có PTS ≤ đích (đích theo quy ước trục của sidecar: lane chính + start_time luồng hình, asset + start_time tệp), CẮT vùng renderer xin (`retouchSourceRegion`: hợp các góc miếng vá đổi ngược qua phép đặt + hộp raster của Retouch, lề 4% + 8 px), gửi RGBA theo luồng; HDR trả 415. Renderer (`eachSourceFrameBest`): backend trước, thiếu thì tua phần còn lại. Retouch chạy TRÊN VÙNG (`view`: landmark đổi sang toạ độ vùng; `blitLayerAt` vẽ vùng vào đúng phần hộp lớp) — canvas WebGL ~800×900 thay cho 1728×3072. Canvas phụ của khâu bake là canvas phần mềm (`bakeCanvas({cpu})`). Sink pipeline mã hoá JPEG bằng 3 worker (OffscreenCanvas.convertToBlob) song song với khung sau.
- **Kết quả (phần dựng khung, đã trừ ~12 s bám mặt lần đầu):** 28,3 → **18,0 s (−37%)**. Miếng vá so với đường tua cũ: cùng khung 47,4–47,5 dB (chỉ khác bộ giải mã), lệch ±1 khung 32–33 dB — 294/294 khung đúng thời điểm.
- **Bẫy đã gặp:** `Buffer.concat` phần đang gom với từng mẩu 64 KB của stdout -> chép bậc hai (khung 21 MB: 2,8 s/khung, vẽ trước 836 s); `req.on('close')` bắn ngay khi body đọc xong (Node ≥ 16) -> nghe trên `res`; res.write backpressure 16 KB -> giải mã và xử lý chạy nối tiếp (cho đệm 64 MB); toBlob trên MỘT luồng nền ~33 ms/ảnh -> nhóm worker.
- **Còn lại:** chuyển khung backend -> renderer qua fetch ~70 MB/s (43 ms/khung vùng 794×940) là trần mới; khung đầu chờ ~3 s (tua trước 2 s + khởi động). Hướng: thu vùng cắt theo tỉ lệ hiển thị lớn nhất (khung nguồn bị co 0,625 khi vẽ). Bám mặt lần đầu (MediaPipe ở backend) ~12 s cho 2 block — cache đĩa theo dự án.

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
  - Đã port cờ này sang Private (chưa commit, 2026-09-27). Lượt xuất hai pha cũ còn một lỗi riêng: lớp phủ **mất hình** sau chỗ file đổi thông số màu. Đó thêm một lý do để bỏ nó sau khi test trên Mac.
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
3. **Hồi quy**: `npm run test:export`, `test:export-many-overlays`, `test:export-color`, `test:export-long-subtitles`, `test:sequence-fps`, `test:seam`, `test:frame-grid`, `test:overlay-placement`, `test:video-mask`, `test:video-anim`, `test:position-keyframe`, `test:color-adjust`, `test:adjust-layer`, `test:clip-speed`, `test:mixed-orientation`, `test:retouch-export`, `test:transition-frames`, `test:main-lane-concat`, `test:unicode-path`, cộng các test mới của Bước 1: `test:export-concat-video-overlay`, `test:auto-subtitle`, `test:export-hdr-asset-usage`, `test:export-batch-seek`, `test:export-yuv-composite`, `test:export-fast-path`, `test:export-output-path`, `test:export-resolution`, `test:export-source-ranges`, `test:export-seq-tail`, `test:export-parallel` (cùng các test khác của Bước 1 trong `package.json`) — cả 36 test: `npm run test:export-all` (~15 phút; đưa thư mục FFmpeg ghim lên đầu PATH trước).
   - `test:concat-cache` chạy bằng Node 24 của máy: Node 24 **bỏ qua** `rmSync({ maxRetries })` khi gặp EPERM (đo 2026-09-30: hỏng sau 0–1 ms; Node 20.18 của Electron thì đợi ~1,8 s rồi xoá được), nên hàm dọn của bài kiểm tự lặp. Backend thật chạy bằng Node của Electron nên không bị.
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
  - `bench_export.js` (viết lại, Bước 0);
  - mới: `export_fidelity.js`, `export_concat_video_overlay.js` (0A), `export_hdr_asset_usage.js` (1.15), `export_batch_seek.js` (1.1a);
  - sửa: `overlay_placement_contract.js`.
- (1B) `CrabbyCut/static/js/editing-runtime.js`.
- (Bước M) `CrabbyCut_Private`: cùng các file trên, cộng resolver ffmpeg cho macOS, và bỏ nhánh xuất hai pha (`core_process.cpp:3397-3432`) khi đủ điều kiện.
- ffmpeg, nhánh `crabbycut/perf`:
  - `fftools/ffmpeg_opt.c` (bí danh `-filter_complex_script`, mục 2.1b);
  - `fftools/ffmpeg_filter.c` / `ffmpeg_sched.c` (treo khi dựng lại graph, hết gấp);
  - `libavfilter/vf_overlay.c` + `framesync.c` (không chép khung khi lớp phủ tắt);
  - `libavfilter/` khác: profiler, filter lớp phủ hợp nhất, filter "nhiều ảnh", `vf_lut3d` + `x86/`, `x86/vf_overlay_init.c`.
