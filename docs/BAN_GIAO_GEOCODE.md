# Bàn giao: MCP gộp lệnh + GeoCode (2026-10-17)

Kế hoạch: `docs/KE_HOACH_MCP_GEOCODE.md` (kèm mục "Lệch so với kế hoạch"). Chi tiết kỹ thuật: `docs/APP_INTERNALS.md` (hai mục cuối), cách dùng MCP: `mcp/README.md`.

## Trạng thái
| Nhánh | Nội dung | Trạng thái |
|---|---|---|
| `feat/mcp-batch` | A1–A3: treo vẽ/treo lịch sử, `crabbycut_add_media_batch`, `crabbycut_batch`, keyframe qua `update_block`, import_media 1 bước Hoàn tác, thời hạn chờ theo lệnh | commit, **chưa push** |
| `feat/geocode` (trên `feat/mcp-batch`) | B1–B6: subtab GeoCode, block `geocode`, bộ dựng offscreen/CDP + Python, preview, xuất, `crabbycut_add_geocode`, bản dịch en/zh | commit, **chưa push** |

## Đã kiểm
- `tests/scripts/mcp_batch.js` (vm, mã cầu nối thật + hàm treo vẽ/lịch sử bóc từ runtime; đột biến 4 chỗ đều bị bắt).
- `tests/scripts/geocode_render.js` (Electron thật, 13 mục: cỡ 16…4K, alpha, đồng hồ ảo tất định, timer, canvas, nền màu, proxy, sandbox chặn localhost/file://, Python thật, lỗi Python, xem thử).
- App thật (Electron dev, backend thử cổng 8123, dữ liệu trong scratchpad) qua MCP server MỚI:
  - `add_media_batch` 10 ảnh + keyframe + hoạt ảnh + chuyển cảnh: 1,35 s, **1 bước Hoàn tác, đúng 1 lượt renderAll**; một lần Ctrl+Z gỡ sạch cả block lẫn asset; Làm lại khôi phục đủ.
  - `crabbycut_batch` (tham chiếu `$0.item_id`) và `import_media` + `add_to_timeline`: mỗi lệnh 1 bước + 1 lượt vẽ.
  - Pane GeoCode: "Tạo video" mẫu HTML → 90 khung / 6,5 s, block trên lane Hình khối, preview đúng (nền trong suốt), inspector "Overlay GeoCode".
  - Xuất MP4: khung xuất khớp khung cache, lệch **0 px**, sai khác trung bình 1,5/255 (nén); GPU vs CPU chênh 0,55/255.
  - `crabbycut_add_geocode` (canvas, video, keyframe) qua job: đúng, 1 bước Hoàn tác.
- `npm run i18n:check` xanh (1993/1993), các test keyframe/inspector/preview liên quan xanh.

### Lượt kiểm thứ hai trong Electron thật (2026-10-17, phiên phụ)
Môi trường tách biệt (backend wrapper 8123 + `electron . --remote-debugging-port=9333`, temp/cache/user-data trong scratchpad), clip chính xám 12 s @30 fps. Mã GeoCode vẽ **thanh trắng rộng (n+1)·5 px** = số khung n, nên đo được khung nào đang hiện ở cả preview (chụp vùng khung qua CDP) lẫn bản xuất (ffmpeg rút khung n), kèm hộp block và độ mờ.
1. **Video + hoạt ảnh In/Out** (640×200, 4 s, In `slide_left` 1 s, Out `fade` 1 s, block 1..5 s): ở 1,2/1,5/2,0/3,0/4,5/4,9 s, số khung preview = bản xuất (6/15/30/60/105/117), mép trái lệch ≤ 1 px sequence (preview co 0,37×), độ mờ lệch ≤ 0,025. Xuất GPU.
2. **loop khi block dài hơn video** (2 s = 60 khung, block 6 s): bản xuất ra đúng k % 60 (15/57/6/0/57 ở 6,5/7,9/8,2/10,0/11,9 s); thư mục `editing_assets/generated_text/geocode_<id>_<i>/` có 180 tệp là **liên kết cứng** (cùng inode với khung cache, nlink = 4).
3. **> 1280 px** (lower third 1920×300): preview nạp `proxy/` (1280×200) ở scale 100 %, tự chuyển sang khung gốc khi scale 250 %. Proxy nét ngang bản gốc: năng lượng biên 5080 vs 5001, sai khác 3,2/255 giữa hai ảnh chụp preview; khung xuất khớp khung cache 1,66/255, lệch 0 px.
4. **Lưu .crab → xoá `geocode_cache/<khoá>` → mở lại**: cả 3 khoá tự dựng lại (~18 s), khoá tính lại trùng khoá lưu, không cảnh báo; preview đúng khung ở 8 mốc. Xoá lần nữa rồi **xuất ngay** khi vừa mở (đua với lượt dựng nền): `ensureGeocodeFramesForExport` chờ đúng lượt dựng, bản xuất **trùng từng bit** với bản trước khi xoá (PSNR = ∞).

**Lỗi tìm thấy và đã sửa** — preview chậm bản xuất một khung:
- block đặt lệch lưới khung (kéo tới 6,01 s): backend snap mốc đầu về lưới (`snapT`) còn preview tính từ mốc thô → chậm 1 khung ở **mọi** vị trí playhead (đo: 14/56/5/59/56 vs 15/57/6/0/57);
- playhead đứng đúng mốc khung: `video.currentTime` bị cắt micro-giây (8,2 → 8,199999) nên `floor()` rơi về khung trước.
Sửa: `GeoCode.localTimeAt()` snap mốc đầu theo fps sequence, `frameIndexAt` dung sai 1e-3 khung. Test mới `tests/scripts/geocode_frame_index.js` (`npm run test:geocode-frame-index`, vm, 3200 vị trí playhead; trả từng chỗ sửa về bản cũ đều bị bắt). Kiểm lại trong Electron: 13 mốc khớp, kể cả block 6,01 s.

## Chưa làm / chưa kiểm
- **Chưa chạy trên macOS** (CI sẽ chạy `test:geocode-render` khi mở PR). Mac không có runtime Python: cần `python3 -m pip install pillow numpy`, pane báo rõ khi thiếu.
- GeoCode có fps KHÁC fps sequence (vd 24 trên 30) chưa so preview/xuất — preview chọn khung theo fps của GeoCode, bản xuất qua bộ lọc fps của ffmpeg; có thể lệch ở biên khung.
- Fps xuất khác fps sequence: preview snap theo fps sequence, bản xuất snap theo fps xuất.
- Quan sát (không riêng GeoCode, chưa sửa): block lệch lưới hiện trong bản xuất từ khung `round(start·fps)` (6,01 s → khung 6,0 s) còn preview chỉ hiện khi playhead ≥ 6,01 → khung đầu block chênh một khung. Fade In của bản xuất ở độ mờ thấp hơi trễ (0,175 vs 0,2 ở 0,2 s) — cùng đường `fade` của video overlay.
- Chưa chạy trọn `npm test` (cần tắt app đang mở vì `build:native`).
- Quan sát ngoài phạm vi: trong môi trường thử (backend ngoài), job xuất qua MCP xong nhưng tệp không nằm ở `output_path` mà rơi vào Downloads dạng `.tmp` — chưa điều tra (đã xoá 2 tệp .tmp do lượt thử sinh ra).
- Tên preset và mẫu chữ zh do máy dịch.

## Chạy lại môi trường thử
Xem memory `test-backend-khong-pha-du-an` + `crabbycut-do-hieu-nang`: backend wrapper (CRAB_TEMP_DIR/CRAB_CONCAT_CACHE_DIR/CRAB_USER_DATA_DIR riêng, cổng 8123) + `electron . --remote-debugging-port=9333 --user-data-dir=<riêng>` với cùng `CRAB_USER_DATA_DIR`; bật cầu nối bằng `desktopEnv.setAutomationEnabled(true)` qua CDP (không ghi cài đặt); gọi MCP mới bằng `CRABBYCUT_TARGET=<pid>`.
