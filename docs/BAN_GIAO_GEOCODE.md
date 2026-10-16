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

## Chưa làm / chưa kiểm
- **Chưa chạy trên macOS** (CI sẽ chạy `test:geocode-render` khi mở PR). Mac không có runtime Python: cần `python3 -m pip install pillow numpy`, pane báo rõ khi thiếu.
- Chưa thử GeoCode với hoạt ảnh In/Out khi xuất, chế độ `loop` khi block dài hơn video, khung > 1280 px trong preview thật (proxy chỉ kiểm ở test), và mở lại `.crab` sau khi xoá cache (đường `ensureFrames`).
- Chưa chạy trọn `npm test` (cần tắt app đang mở vì `build:native`).
- Quan sát ngoài phạm vi: trong môi trường thử (backend ngoài), job xuất qua MCP xong nhưng tệp không nằm ở `output_path` mà rơi vào Downloads dạng `.tmp` — chưa điều tra (đã xoá 2 tệp .tmp do lượt thử sinh ra).
- Tên preset và mẫu chữ zh do máy dịch.

## Chạy lại môi trường thử
Xem memory `test-backend-khong-pha-du-an` + `crabbycut-do-hieu-nang`: backend wrapper (CRAB_TEMP_DIR/CRAB_CONCAT_CACHE_DIR/CRAB_USER_DATA_DIR riêng, cổng 8123) + `electron . --remote-debugging-port=9333 --user-data-dir=<riêng>` với cùng `CRAB_USER_DATA_DIR`; bật cầu nối bằng `desktopEnv.setAutomationEnabled(true)` qua CDP (không ghi cài đặt); gọi MCP mới bằng `CRABBYCUT_TARGET=<pid>`.
