# Bàn giao: test:media-scale-fit chập chờn — libx264 không tất định trên CPU AVX-512 (2026-10-17)

## Kết quả
- **Nguyên nhân:** libx264 (core 165 r3222, trong ffmpeg ghim) ra bản khác bit nhau giữa các lần xuất y hệt trên CPU có AVX-512, kể cả `-threads 1`. Đầu ra filter của sidecar luôn tất định. Runner CI `windows-2022` đổi phần cứng giữa các lượt (EPYC 7763 / 9V45 / 9V74, Xeon 8370C / 8573C), nên test chỉ đỏ khi rơi vào máy có AVX-512.
- **Đã sửa:** PR #16 (merge `ca9749e`). Sidecar dò AVX-512 (`cpuid` + XCR0) rồi thêm `-x264-params asm=avx2` cho bản xuất libx264. Có biến `CRABBYCUT_X264_ASM_CAP=auto|avx2|off` để kiểm hoặc tắt.
- **Số đo:** `asm=avx2` tất định 180/180 lần trên máy AVX-512, trùng từng bit giữa mọi máy. Mã hoá chậm hơn khoảng 4–10 % trên máy AVX-512, 0 % ở máy khác.

## Chưa kiểm
- Nhánh tự dò AVX-512 chưa chạy trên máy AVX-512 thật: máy dev không có AVX-512, và log CI không ghi loại CPU. Nếu `test:media-scale-fit` (hoặc 8 test khác so framemd5 bản xuất sidecar) còn đỏ chập chờn trên Windows thì bản sửa chưa đủ.
- Gợi ý: thêm vào `ci.yml` một bước in loại CPU (`Get-CimInstance Win32_Processor`) để lần sau đọc log là biết runner có AVX-512 không.
- libx265 chưa đo xem có cùng hiện tượng không.

## Tài liệu còn ở máy, chưa đưa lên
- `docs/MCP gộp lệnh + subtab GeoCode.md` là bản cũ của `docs/KE_HOACH_MCP_GEOCODE.md`, giống từng chữ nhưng thiếu mục "Lệch so với kế hoạch". Chưa push vì người dùng chưa trả lời có muốn push bản trùng này không.

## Cách chẩn đoán đã dùng (để làm lại khi cần)
Nhánh tạm có workflow riêng, kích hoạt bằng `push` (workflow chạy theo tệp trong chính nhánh, không cần PR), ma trận 6–8 job `windows-2022`. Script lặp xuất với ffmpeg ghim theo nhiều cách: băm khung ngay sau filter, x264 mặc định, x264 một luồng, `asm=avx2`, `asm=0`; mỗi job in tên CPU vào `summary.json` rồi tải lên artifact. Lưu ý: `gh run view --job <id> --log` có lúc trả về log của job khác — đọc kết quả qua artifact cho chắc.
