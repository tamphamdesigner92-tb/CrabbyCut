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

**Bản đã cài trên Windows** (không cần Node; đổi đường dẫn nếu bạn cài chỗ khác):

```bash
claude mcp add crabbycut -e ELECTRON_RUN_AS_NODE=1 -- "%LOCALAPPDATA%\Programs\CrabbyCut\CrabbyCut.exe" "%LOCALAPPDATA%\Programs\CrabbyCut\resources\app\mcp\crabbycut-mcp.js"
```

**Bản đã cài trên macOS:**

```bash
claude mcp add crabbycut -e ELECTRON_RUN_AS_NODE=1 -- /Applications/CrabbyCut.app/Contents/MacOS/CrabbyCut /Applications/CrabbyCut.app/Contents/Resources/app/mcp/crabbycut-mcp.js
```

## Claude Desktop (`claude_desktop_config.json`)

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

## Khi bản dev và bản cài cùng mở

Mặc định server dùng bản nào bật cầu nối gần nhất. Muốn chọn cụ thể thì đặt `CRABBYCUT_TARGET`:

| Giá trị | Nhắm tới |
|---|---|
| `dev` | bản chạy từ mã nguồn |
| `packaged` | bản đã cài |
| `<pid>` | đúng tiến trình đó |

`crabbycut_status` liệt kê mọi bản đang chạy.

## Tool

| Tool | Việc nó làm |
|---|---|
| `crabbycut_status` | Kiểm tra kết nối + trạng thái ngắn (bước, dự án, chưa lưu, thời lượng, playhead…) |
| `crabbycut_get_timeline` | Clip lane chính + track/block overlay |
| `crabbycut_screenshot` | Chụp cửa sổ app |
| `crabbycut_seek` | Đặt playhead (giây) |
| `crabbycut_playback` | Phát / tạm dừng |
| `crabbycut_undo` | Hoàn tác / làm lại |
| `crabbycut_select` | Chọn clip lane chính (index) hoặc block overlay (id) |
| `crabbycut_split` | Cắt lane chính hoặc một block tại thời điểm |
| `crabbycut_delete_selected` | Xoá phần đang chọn |
| `crabbycut_add_text` | Thêm block chữ |
| `crabbycut_save_project` | Lưu vào tệp .crab hiện tại |
| `crabbycut_open_project` | Mở tệp .crab (từ chối khi dự án đang mở còn thay đổi chưa lưu) |

Các tool chỉnh sửa chỉ chạy ở bước **Editing**. Mọi chỉnh sửa đều đi qua đúng hàm mà nút bấm/phím tắt dùng, nên hoàn tác được bằng Ctrl/Cmd+Z.

## Thêm tool mới

1. Thêm lệnh vào `METHODS` trong `static/js/automation-bridge.js`, gọi hàm sẵn có của app.
2. Thêm mục vào `TOOLS` trong `mcp/crabbycut-mcp.js`, gọi `rpc('<tên lệnh>', args)`.

Lệnh không cần đến timeline (như chụp màn hình) thì đặt ở `MAIN_METHODS` trong `electron/automation-bridge.js`.
