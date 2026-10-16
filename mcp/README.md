# CrabbyCut MCP server

Cho Claude (Claude Code, Claude Desktop) xem và chỉnh timeline của **CrabbyCut đang chạy**. Dùng được cho cả bản dev (`npm start`) và bản đã cài (.exe / .app), trên Windows và macOS.

```
Claude ──stdio──► mcp/crabbycut-mcp.js ──HTTP 127.0.0.1 + token──► main process ──IPC──► renderer (timeline)
```

- Không cần gói npm nào. Chạy bằng `node`, hoặc bằng chính tệp chạy của app với `ELECTRON_RUN_AS_NODE=1`, nên máy không cài Node vẫn dùng được.
- Server không tự mở app. App phải đang chạy, và đã bật **Cài đặt › Chung › Nâng cao › “Cho phép Claude điều khiển (MCP)”** (mặc định tắt).
- Khi bật, app mở một cổng ngẫu nhiên trên 127.0.0.1 và ghi cổng + token vào `<appData>/CrabbyCut/automation/bridge-<pid>.json`. Bản dev và bản cài ghi vào cùng thư mục này, nên server tìm được cả hai mà không cần cấu hình gì:
  - Windows: `%LOCALAPPDATA%\CrabbyCut\automation\`
  - macOS: `~/Library/Application Support/CrabbyCut/automation/`

## Đăng ký với Claude Code

**Bản dev** (từ thư mục dự án):

```bash
claude mcp add crabbycut -- node mcp/crabbycut-mcp.js
```

**Bản đã cài trên Windows** (không cần Node; đổi đường dẫn nếu bạn cài chỗ khác). Bản cài 1.1.16 trở về trước chưa có thư mục `resources\app\mcp\` — dùng cách của bản dev cho tới khi cài bản mới hơn:

```bash
claude mcp add crabbycut -e ELECTRON_RUN_AS_NODE=1 -- "%LOCALAPPDATA%\Programs\CrabbyCut\CrabbyCut.exe" "%LOCALAPPDATA%\Programs\CrabbyCut\resources\app\mcp\crabbycut-mcp.js"
```

**Bản đã cài trên macOS:**

```bash
claude mcp add crabbycut -e ELECTRON_RUN_AS_NODE=1 -- /Applications/CrabbyCut.app/Contents/MacOS/CrabbyCut /Applications/CrabbyCut.app/Contents/Resources/app/mcp/crabbycut-mcp.js
```

## Claude Desktop (`claude_desktop_config.json`)

`claude mcp add` chỉ đăng ký cho Claude Code; Claude Desktop đọc cấu hình riêng ở `%APPDATA%\Claude\claude_desktop_config.json` (bản Microsoft Store chuyển tệp này vào `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`, nhưng sửa đường dẫn nào cũng là cùng một tệp). Tệp JSON không hiểu `%LOCALAPPDATA%`, nên phải ghi đường dẫn đầy đủ.

```json
{
  "mcpServers": {
    "crabbycut": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\CrabbyCut\\CrabbyCut.exe",
      "args": ["C:\\Users\\<you>\\AppData\\Local\\Programs\\CrabbyCut\\resources\\app\\mcp\\crabbycut-mcp.js"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

`<you>` phải đúng tên thư mục người dùng, kể cả dấu cách (thư mục `C:\Users\Nguyen Van A` thì trong JSON viết `C:\\Users\\Nguyen Van A\\...`) — gõ thiếu dấu cách là Claude Desktop báo `spawn ... ENOENT`. Mở `%LOCALAPPDATA%` trong Explorer để chép đường dẫn thật.

Với bản dev:

```json
{
  "mcpServers": {
    "crabbycut": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["E:\\đường\\dẫn\\tới\\CrabbyCut\\mcp\\crabbycut-mcp.js"]
    }
  }
}
```

Sửa xong phải thoát hẳn Claude Desktop (cả biểu tượng ở khay hệ thống) rồi mở lại.

## Khi bản dev và bản cài cùng mở

Mặc định server dùng bản nào bật cầu nối gần nhất. Muốn chọn cụ thể thì đặt `CRABBYCUT_TARGET`:

| Giá trị | Nhắm tới |
|---|---|
| `dev` | bản chạy từ mã nguồn |
| `packaged` | bản đã cài |
| `<pid>` | đúng tiến trình đó |

`crabbycut_status` liệt kê mọi bản đang chạy.

## Tool (32)

Claude có hai cách làm việc. **Tool theo tính năng** gọi thẳng hàm của app: nhanh, chính xác, mỗi lệnh là một bước hoàn tác. **Tool giao diện** bấm, gõ và kéo như người dùng thật, dùng cho mọi thứ chưa có tool riêng.

### Xem và điều khiển cơ bản

| Tool | Việc nó làm |
|---|---|
| `crabbycut_status` | Kiểm tra kết nối, trạng thái cửa sổ và dự án (bước, chưa lưu, thời lượng, playhead…) |
| `crabbycut_get_timeline` | Clip lane chính, track và block overlay |
| `crabbycut_screenshot` | Chụp cửa sổ. `restore: true` mở lại cửa sổ đang thu nhỏ mà không cướp focus |
| `crabbycut_seek` / `crabbycut_playback` | Đặt playhead / phát, dừng |
| `crabbycut_undo` | Hoàn tác / làm lại |
| `crabbycut_select` / `crabbycut_split` / `crabbycut_delete_selected` | Chọn, cắt, xoá clip/block |
| `crabbycut_catalog` | Tra id hợp lệ: chuyển cảnh, hoạt ảnh, kiểu chữ, hiệu ứng chữ, LUT, thông số màu, tuỳ chọn xuất, phụ đề, thư viện |

### Dự án và media

| Tool | Việc nó làm |
|---|---|
| `crabbycut_new_project` | Dự án trống, có thể kèm video cho lane chính |
| `crabbycut_open_project` / `crabbycut_save_project` | Mở / lưu tệp .crab (từ chối mở khi còn thay đổi chưa lưu) |
| `crabbycut_add_main_videos` | Thêm video vào cuối lane chính |
| `crabbycut_import_media` | Nhập ảnh/video/âm thanh theo đường dẫn (chép hoặc liên kết), có thể đặt luôn lên timeline |
| `crabbycut_list_assets` | Tài nguyên của dự án và thư viện có sẵn |
| `crabbycut_add_asset` | Đặt tài nguyên dự án hoặc thư viện lên track overlay |
| `crabbycut_add_text` | Thêm block chữ |

### Chỉnh sửa block

| Tool | Việc nó làm |
|---|---|
| `crabbycut_update_block` | Vị trí, tỉ lệ, xoay, độ mờ, lật, âm lượng, tốc độ, thời điểm, độ dài, nội dung chữ, kiểu chữ |
| `crabbycut_apply_text_preset` | Áp kiểu chữ (`p1`…) và/hoặc hiệu ứng chữ (`fx1`…) |
| `crabbycut_set_animation` | Hoạt ảnh vào/ra, hoặc combo |
| `crabbycut_set_transition` | Chuyển cảnh giữa hai clip lane chính hoặc hai block overlay liền nhau |
| `crabbycut_set_color` | LUT, cường độ LUT, thông số màu (`basic.exposure`, `effects.vignette`…) |

### Việc chạy lâu (job)

| Tool | Việc nó làm |
|---|---|
| `crabbycut_start_job` | `auto_subtitle`, `magic_fill`, `export` — trả `job_id` ngay |
| `crabbycut_job_status` | Tiến độ / kết quả; `wait_seconds` (≤ 25) chờ job xong rồi mới trả lời |
| `crabbycut_cancel_job` | Huỷ (chỉ Auto Subtitle huỷ được giữa chừng) |

Xuất video bắt buộc có `options.output_path`: main process ký vé ghi tệp cho đúng đường dẫn đó và bỏ qua hộp thoại Lưu. Renderer vẫn không tự chọn được nơi ghi.

### Giao diện (như người dùng)

| Tool | Việc nó làm |
|---|---|
| `crabbycut_ui_snapshot` | Danh sách phần tử bấm/nhập được đang hiện, kèm `ref`, nhãn, giá trị, toạ độ |
| `crabbycut_ui_click` | Bấm theo `ref` hoặc toạ độ ảnh chụp; chuột phải, nhấp đúp, phím bổ trợ |
| `crabbycut_ui_drag` | Kéo-thả (dời block, trim mép, thanh trượt, thả tài nguyên) |
| `crabbycut_ui_scroll` | Cuộn bánh xe |
| `crabbycut_ui_key` | Phím / tổ hợp (`Cmd+Z` = Ctrl+Z trên Windows, ⌘Z trên Mac) |
| `crabbycut_ui_type` | Gõ chữ (có dấu) vào ô đang chọn hoặc vào `ref` |

Chuột và phím đi qua `webContents.sendInputEvent`, nên app nhận sự kiện y như từ thiết bị thật. Block timeline vẽ bằng canvas không có `ref`; dùng toạ độ trên ảnh chụp.

## Giới hạn

- **Hộp thoại của hệ điều hành** (chọn tệp, Lưu thành…) không bấm được. Dùng tool nhận đường dẫn: `import_media`, `new_project`, `open_project`, `export`.
- **Cửa sổ thu nhỏ:** thao tác vẫn chạy nhưng ảnh chụp là khung cũ (`stale`). Gọi `crabbycut_screenshot` với `restore: true`.
- **Magic Fill** cần kịch bản đã nạp; nạp kịch bản bằng tool giao diện. Magic Fill và xuất video không huỷ được giữa chừng.
- Lệnh chỉnh sửa bị lỗi tự quay lui, không để lại thay đổi dở dang hay bước hoàn tác rỗng.

## Thêm tool mới

1. Thêm lệnh vào `METHODS` trong `static/js/automation-bridge.js`, gọi hàm sẵn có của app. Hàm nội bộ của `editing-runtime.js` thì mở thêm ở `EditingRuntime.automation`.
2. Thêm mục vào `TOOLS` trong `mcp/crabbycut-mcp.js`, gọi `rpc('<tên lệnh>', args)`.

Lệnh không cần đến timeline (chụp màn hình, chuột/phím) thì đặt ở `MAIN_METHODS` trong `electron/automation-bridge.js`.
