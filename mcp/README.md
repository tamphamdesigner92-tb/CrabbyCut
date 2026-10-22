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

## Tool (38)

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
| `crabbycut_catalog` | Tra id hợp lệ: chuyển cảnh, hoạt ảnh, kiểu chữ, hiệu ứng chữ, LUT, thông số màu, tuỳ chọn xuất, phụ đề, thư viện, GeoCode, hình (`shapes`), giọng đọc (`voices`), biến dạng chữ + mẫu đường (`text_warps`) |

### Dự án và media

| Tool | Việc nó làm |
|---|---|
| `crabbycut_new_project` | Dự án trống, có thể kèm video cho lane chính |
| `crabbycut_open_project` / `crabbycut_save_project` | Mở / lưu tệp .crab (từ chối mở khi còn thay đổi chưa lưu) |
| `crabbycut_add_main_videos` | Thêm video vào cuối lane chính |
| `crabbycut_import_media` | Nhập ảnh/video/âm thanh theo đường dẫn (chép hoặc liên kết), có thể đặt luôn lên timeline |
| `crabbycut_list_assets` | Tài nguyên của dự án và thư viện có sẵn |
| `crabbycut_add_asset` | Đặt tài nguyên dự án hoặc thư viện lên track overlay |
| `crabbycut_add_text` | Thêm block chữ — kèm luôn trong cùng lượt gọi (một bước hoàn tác): `style`, **biến dạng** `warp` (kiểu Warp của After Effects: arc, arch, bulge, flag, wave, fish, rise, fisheye, inflate, squeeze, twist…, `bend` / `horizontal` / `vertical` −100..100), **chữ chạy theo đường** `path` (mẫu `arc` / `smile` / `wave` / `circle` / `s_curve` / `rise` hoặc `points` theo mô hình Pen; `offset`, `align`, `flip`, `shift`), `transform`, `keyframes`, `animation`. Sửa về sau bằng `crabbycut_update_block` `style {warp_*, path_*}`. Tra bằng `crabbycut_catalog text_warps` |

### Chỉnh sửa block

| Tool | Việc nó làm |
|---|---|
| `crabbycut_update_block` | Vị trí, tỉ lệ, xoay, độ mờ, lật, âm lượng, tốc độ, thời điểm, độ dài, nội dung chữ, kiểu chữ, **keyframe** |
| `crabbycut_apply_text_preset` | Áp kiểu chữ (`p1`…) và/hoặc hiệu ứng chữ (`fx1`…) |
| `crabbycut_set_animation` | Hoạt ảnh vào/ra, hoặc combo |
| `crabbycut_set_transition` | Chuyển cảnh giữa hai clip lane chính hoặc hai block overlay liền nhau |
| `crabbycut_set_color` | LUT, cường độ LUT, thông số màu (`basic.exposure`, `effects.vignette`…) |

#### Keyframe

`crabbycut_update_block` (và từng mục của `crabbycut_add_media_batch`) nhận `keyframes`, cùng mô hình lưu của app:

```json
{
  "item_id": "item_…",
  "keyframes": {
    "position": [{ "t": 0, "x": -600, "y": 0 }, { "t": 1.5, "x": 0, "y": 0, "e": "ease-out" }],
    "scale":    [{ "t": 0, "v": 60 }, { "t": 1.5, "v": 100 }],
    "opacity":  [{ "t": 0, "v": 0, "e": "linear" }, { "t": 0.5, "v": 100 }],
    "basic.exposure": [{ "t": 0, "v": -30 }, { "t": 3, "v": 0 }]
  }
}
```

- `t`: giây tính từ đầu block (`keyframe_time: "timeline"` để dùng giây trên sequence). Ngoài block là lỗi.
- `v`: px với `position_x/y`, % với `scale`/`opacity`/`volume`, độ với `rotation`, -100…100 với phần lớn thông số màu. `position` ghi cả hai trục một lần (`x`, `y` hoặc `v: [x, y]`); ghi lẻ một trục thì app tự chèn mốc cho trục kia để X/Y luôn trùng mốc (như nút ◆ Vị trí).
- `e`: easing của đoạn RỜI mốc này — `linear`, `ease-in`, `ease-out`, `ease-in-out` (mặc định), `back`, `spring`, `bounce`.
- Thông số màu keyframe được: `basic.exposure/contrast/saturation/temperature/tint`, `wheels.{lift,gamma,gain}.{r,g,b}`, `tone.*`, `lut.intensity`, `effects.blur`, `effects.vignette` (viết `basic.exposure` hay `adj.basic.exposure` đều được).
- `keyframe_mode`: `merge` (mặc định) chèn/ghi đè từng mốc; `replace` thay trọn danh sách của field được nêu — `[]` là xoá keyframe field đó.

### Lệnh gộp (một lượt gọi, một bước hoàn tác)

Mỗi lệnh lẻ là một lượt HTTP + IPC + một ảnh chụp trạng thái cho Hoàn tác + vài lượt vẽ lại; đưa 20 ảnh kèm keyframe bằng lệnh lẻ là hàng chục lượt gọi và vượt trần Hoàn tác (mặc định 20 bước). Hai lệnh dưới chạy cả lô trong **một bước Hoàn tác và một lượt vẽ**, chờ tới 5 phút.

| Tool | Việc nó làm |
|---|---|
| `crabbycut_add_media_batch` | Đặt nhiều ảnh/video/âm thanh lên timeline: nhập mọi đường dẫn trong một lượt (tệp đã có trong dự án thì dùng lại), mỗi mục kèm thời điểm, độ dài, track, cắt nguồn, transform, keyframe, hoạt ảnh, chuyển cảnh, màu, âm lượng |
| `crabbycut_batch` | Chạy tuần tự nhiều lệnh sửa bất kỳ (`add_text`, `update_block`, `set_animation`, `set_color`, `set_transition`, `split`, `add_asset`, `import_media`, `add_media_batch`…), tham chiếu kết quả bước trước bằng `"$<chỉ số>.<đường dẫn>"` |

```json
{
  "mode": "link",
  "start": 0,
  "gap": 0,
  "defaults": { "duration": 3, "animation": { "combo": "pop_fade" }, "transition": { "type": "fade", "duration": 0.5 } },
  "items": [
    { "path": "D:/anh/01.jpg", "keyframes": { "scale": [{ "t": 0, "v": 100 }, { "t": 3, "v": 115 }] } },
    { "path": "D:/anh/02.jpg", "keyframes": { "position": [{ "t": 0, "x": -80, "y": 0 }, { "t": 3, "x": 80, "y": 0 }] } },
    { "path": "D:/nhac/nen.mp3", "start": 0, "duration": 6, "volume": 60 }
  ]
}
```

Mục không có `start` nối ngay sau mục trước (+ `gap`); mục đầu bắt đầu ở `start` của lô hoặc playhead. `defaults` được gộp vào từng mục (object con gộp một tầng, giá trị của mục thắng). Chuyển cảnh được đặt sau khi mọi block đã vào chỗ, tới block kề phải trên cùng track. Kết quả: `[{ index, item_id, asset_id, track_id, timeline_start, duration, error? }]`.

```json
{
  "ops": [
    { "tool": "add_text", "args": { "text": "Chào mừng", "start": 1, "duration": 4 } },
    { "tool": "apply_text_preset", "args": { "item_id": "$0.item_id", "style_preset": "p3" } },
    { "tool": "update_block", "args": { "item_id": "$0.item_id",
      "keyframes": { "position": [{ "t": 0, "x": 0, "y": 300 }, { "t": 0.8, "x": 0, "y": 0, "e": "back" }] } } }
  ]
}
```

`on_error`: `abort` (mặc định) — một bước lỗi là hoàn nguyên cả lô, không để lại bước Hoàn tác nào; `continue` — chỉ bước lỗi bị quay lui, kết quả ghi `error` cho bước đó. Lệnh giao diện (`ui_*`), chụp màn hình và job không chạy trong lô.

### GeoCode, Shape, Lồng tiếng — ít lượt gọi, kết quả gọn

Ba nhóm này hay bị dùng nhiều lần liên tiếp, nên tool được thiết kế để **một lượt gọi làm trọn việc**. Tool dựng lâu (GeoCode, lồng tiếng) **tự chờ job ngay trong server** (`wait_seconds`, mặc định 50 s) rồi mới trả kết quả cuối. Model không phải gọi `crabbycut_job_status` nhiều lần; chỉ khi hết hạn chờ mà job còn chạy thì mới nhận `job_id` để hỏi tiếp.

| Tool | Việc nó làm |
|---|---|
| `crabbycut_add_geocode` | Viết mã (`html` / `canvas` / `python`) → ảnh hoặc video đúng `width`×`height` px (hoặc `preset`), nền trong suốt, đặt thành block trên lane Hình khối; kèm `transform`, `keyframes`, `animation`. **Nhiều block một lượt**: `items[]` + `defaults`, phần mã chung gửi **một lần** trong `template` có chỗ trống `{{tên}}`, mỗi mục chỉ gửi `vars` (hoặc `code` riêng); mục không có `start` nối tiếp mục trước (+ `gap`). Cả lô một bước Hoàn tác. Log chỉ trả dòng cảnh báo/lỗi (`verbose_logs` để lấy đủ). Trong `crabbycut_batch` dùng tool `add_geocode` (một block). Tra ngôn ngữ/preset/giới hạn bằng `crabbycut_catalog geocode` |
| `crabbycut_update_geocode` | Sửa block GeoCode **không cần gửi lại mã**: `replace: [{find, with, all}]` vá trên mã đang lưu trong block (hoặc `code` mới), đổi `width`/`height`/`kind`/`fps`/`duration`/`bg`/`loop` → dựng lại tại chỗ, giữ vị trí/biến đổi/keyframe/hoạt ảnh. `block_duration` chỉ đổi độ dài block (không dựng lại). `read: true` trả mã hiện tại |
| `crabbycut_add_shape` | Một hình (trường ở cấp trên) hoặc `items[]` + `defaults`, một bước Hoàn tác: `shape_type` rectangle / square / circle / triangle / trapezoid / polygon / star / line / path, cỡ, màu tô/viền, độ dày viền, bo góc, số cạnh/cánh, `path_points` cho path; kèm `start`, `duration`, `track_id`, `transform`, `keyframes`, `animation`. Dùng được trong `crabbycut_batch` (`add_shape`). Tra trường bằng `crabbycut_catalog shapes` |
| `crabbycut_dub` | Lồng tiếng lên lane "Lồng tiếng": `text` (tự tách câu, đọc nối tiếp, `gap` giây nghỉ, bắt đầu ở `start`) hoặc `sentences[]` (đúng từng câu) — hai cách này sinh kèm phụ đề khớp tiếng (`make_subtitles: false` để tắt); hoặc `cues[]` `{start, end, text}` có mốc (`timing_mode`). `engine`/`voice` bỏ trống = lựa chọn đang để ở panel Lồng tiếng; xem bằng `crabbycut_catalog voices` (`voice_profile` = giọng nhân bản). `replace` (mặc định bật) thay bản lồng cũ cùng `name`. Trả **mốc timeline của từng câu** (`clips[i]`) để canh GeoCode/chữ/hình theo lời đọc mà không phải đọc lại timeline |

Ví dụ 3 block minh hoạ cùng một khung cảnh, gửi CSS một lần:

```json
{
  "template": "<style>/* CSS chung dài */ .t{color:{{color}}}</style><h1 class=\"t\">{{title}}</h1>",
  "defaults": { "lang": "html", "width": 1080, "height": 1920, "kind": "video", "duration": 6, "fps": 30,
                "animation": { "in": { "type": "fade", "duration": 0.3 }, "out": { "type": "fade", "duration": 0.3 } } },
  "start": 0,
  "items": [
    { "vars": { "title": "Mở đầu", "color": "#ffd166" } },
    { "vars": { "title": "Phần 1", "color": "#06d6a0" }, "block_duration": 8 },
    { "vars": { "title": "Kết", "color": "#ef476f" } }
  ]
}
```

> ⚠️ `lang: "python"` chạy bằng **Python thật của máy với toàn quyền người dùng** (HTML/JS thì chạy trong sandbox: không đọc tệp, không gọi localhost). App hiện thông báo mỗi lần MCP chạy Python. Chỉ bật cầu nối MCP khi bạn tin chương trình đang điều khiển nó.

### Việc chạy lâu (job)

| Tool | Việc nó làm |
|---|---|
| `crabbycut_start_job` | `auto_subtitle`, `magic_fill`, `export` — trả `job_id` ngay |
| `crabbycut_job_status` | Tiến độ / kết quả; `wait_seconds` (≤ 25) chờ job xong rồi mới trả lời |
| `crabbycut_cancel_job` | Huỷ (chỉ Auto Subtitle huỷ được giữa chừng) |

Xuất video bắt buộc có `options.output_path`: main process ký vé ghi tệp cho đúng đường dẫn đó và bỏ qua hộp thoại Lưu. Renderer vẫn không tự chọn được nơi ghi. Backend chạy ngoài app (không có khoá ký) thì bản xuất đi đường tải về, và main lưu lượt tải đó thẳng ra `output_path`. Job chỉ báo `complete` khi tệp đã nằm trên đĩa, `result.output_path` là đường dẫn thật.

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
- Lệnh gộp: tối đa 500 mục/lệnh mỗi lô, thân yêu cầu tối đa 1 MB.

## Thêm tool mới

1. Thêm lệnh vào `METHODS` trong `static/js/automation-bridge.js`, gọi hàm sẵn có của app. Hàm nội bộ của `editing-runtime.js` thì mở thêm ở `EditingRuntime.automation`.
2. Thêm mục vào `TOOLS` trong `mcp/crabbycut-mcp.js`, gọi `rpc('<tên lệnh>', args)`.
3. Lệnh sửa timeline bọc trong `asOneUndoStep` (một bước hoàn tác + treo vẽ lại, tự quay lui khi lỗi). Muốn dùng được trong `crabbycut_batch` thì thêm tên vào `BATCHABLE`.
4. Lệnh có thể chạy quá 30 s thì thêm tên vào `LONG_RPC_TIMEOUT_MS` (`electron/automation-bridge.js`) và `LONG_METHODS` (`mcp/crabbycut-mcp.js`).

Lệnh không cần đến timeline (chụp màn hình, chuột/phím) thì đặt ở `MAIN_METHODS` trong `electron/automation-bridge.js`.
