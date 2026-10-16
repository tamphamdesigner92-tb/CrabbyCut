# Kế hoạch: MCP gộp lệnh + subtab GeoCode (tab Hình học)

## Context
- **MCP hiện tại** (`mcp/crabbycut-mcp.js` → `electron/automation-bridge.js` → `static/js/automation-bridge.js` METHODS): mỗi lệnh = 1 HTTP + 1 IPC + 1 lần chụp toàn bộ state (undo) + ≥2 lần `renderAll()`. Không có lệnh gộp, **không lệnh nào tạo được keyframe** (`set_animation` chỉ là In/Out). Đưa 20 ảnh kèm keyframe = hàng chục lượt gọi và vượt trần undo 20 bước (`general.undoSteps`).
- **GeoCode**: người dùng muốn viết mã (HTML/CSS/JS, Python) rồi sinh ảnh tĩnh hoặc video ở kích thước pixel tuỳ chọn, đặt trên lane Hình khối. Hiện app không có chỗ chạy mã, không có cửa sổ offscreen; Python chỉ có sẵn trên Windows (`%LOCALAPPDATA%\CrabbyCut\runtime\python`, có PIL/numpy/matplotlib/cv2), **Mac không có runtime Python**.
- Đường xuất đã có sẵn thứ dùng lại được: chuỗi khung PNG → backend `image_seq` → sidecar ghép alpha (CPU lẫn CUDA), cộng prebake cache.

## Phần A — MCP gộp lệnh

### A1. Hạ tầng trong renderer
- `editing-runtime.js`: thêm `suspendRender()` (bộ đếm) — trong lúc treo, `renderAll`, `renderEditingTimeline`, `renderPreviewOverlays`, `updateSequencePreviewTransform` chỉ đánh dấu bẩn; nhả treo thì vẽ một lần. Xuất qua `EditingRuntime.automation`.
- Ghép với `beginHistoryBatch()` (`editing-runtime.js:223`) → cả lô = **1 bước undo**.
- `automation-bridge.js` (renderer): hàm `runBatch(ops)` gọi tuần tự các METHODS trong một `asOneUndoStep` + `suspendRender`; lỗi → hoàn nguyên cả lô (mặc định) hoặc bỏ qua tiếp (`on_error: "continue"`).
- Thời hạn chờ: `callRenderer` (30 s) và HTTP MCP (35 s) nhận `timeout_ms` theo method; lệnh gộp mặc định 300 s.

### A2. Lệnh mới
1. **`crabbycut_add_media_batch`** (trọng tâm yêu cầu): `items[]`, mỗi phần tử
   `{ path | asset_id | library, start | "after_previous", duration, track_id, trim_start/end, transform{}, keyframes{field:[{t,v,e}]}, animation{in,out,combo}, transition{type,duration}, color{lut_id,lut_intensity,params}, volume, muted }`
   + `mode: copy|link`, `gap`. Import **một request** cho mọi path (`importLocalPaths`/`linkAssetPaths` đã nhận danh sách), probe song song, thêm block với render treo, trả về `[{index, item_id, asset_id, error?}]`.
2. **`crabbycut_batch`**: `ops:[{tool, args}]` chạy mọi lệnh sửa (add_text, update_block, set_animation, set_color, set_transition, split, add_geocode…) trong 1 lần gọi; tham chiếu kết quả trước bằng `"$0.item_id"`. Không nhận lệnh ui_*/screenshot/job.
3. **Keyframe cho mọi lệnh**: `update_block` thêm `keyframes` (`mode: replace|merge`, `t` tính theo giây cục bộ của block, tuỳ chọn `time: "timeline"`). Dùng lại `upsertKeyframe`, `pairPositionKeyframes` (giữ bất biến position_x/y cùng mốc), `KEYFRAME_FIELDS`, `KEYFRAME_PARAMS` (màu `adj.*`), `volume`.
- Sửa luôn: `import_media` + `add_to_timeline` đang tốn 2 bước undo → 1.

### A3. Tài liệu
- `mcp/README.md`: thêm 3 lệnh + ví dụ JSON; `docs/APP_INTERNALS.md` mục automation.

## Phần B — GeoCode

### B1. Giao diện (subtab thứ hai của tab Hình học)
- `EDIT_PANEL_SUBTABS.shape` (`editing-runtime.js:18198`) thêm `{id:'geocode', label:_t('GeoCode')}`; biến `editPanelShapeSub`; nhánh ở `renderEditPanel` (~19675, 19707) và `handleEditPanelClick` (~19768) — theo chú thích "phải sửa cả hai chỗ".
- Module riêng `static/js/geocode.js` theo mẫu Dubbing/AutoSubtitle (`renderPaneHtml()` + `bindPane(bodyEl)`).
- Nội dung pane: chọn ngôn ngữ (HTML/CSS/JS · JavaScript canvas · Python), ô mã (textarea có đánh số dòng, Tab thụt lề, mẫu khởi đầu mỗi ngôn ngữ), kích thước, loại đầu ra (Ảnh / Video: thời lượng, fps mặc định = fps sequence, nền trong suốt/màu), nút **Xem thử**, **Tạo ảnh**, **Tạo video**, thanh tiến độ + Huỷ.
- Kích thước có sẵn (W×H px, sửa tay được): Nút 450×200 · Nút nhỏ 240×80 · Icon 512×512 · Logo 1000×1000 · Banner 728×90 · Lower third 1920×300 · Vuông 1080×1080 · Dọc 9:16 1080×1920 · Full HD 1920×1080 · 4K 3840×2160 · **Theo khung dự án**. Giới hạn 16–4096 px mỗi cạnh.
- Mọi chuỗi bọc `_t()`, thêm vào `static/i18n/en.json`, `zh.json`, chạy `npm run i18n:check`.

### B2. Khối dữ liệu
- Block `type:'geocode'` trên lane shape: `trackTypeForItemType('geocode') → 'shape'` (`editing-runtime.js:322`), tạo qua `resolveNewItemPlacement('shape', …)`.
- `item.geocode = { lang, code, width, height, kind:'image'|'video', fps, duration, loop, bg, render_key, frame_count }`; transform/keyframe/In-Out animation dùng chung với shape (`itemSupportsAnimation`, `effectiveTransformAt`).
- Khung đã render là **cache tái tạo được**: `<cache>/geocode/<render_key>/frame_%05d.png` với `render_key = sha256(lang, code, W, H, fps, duration, bg, engine_version)`. Mở dự án mà thiếu cache → tự render lại từ mã. Block dài hơn clip → lặp (`loop`) hoặc giữ khung cuối.
- Chọn block GeoCode → pane hiện lại mã để sửa và "Tạo lại" (một bước undo).

### B3. Bộ render (main process, `electron/geocode-renderer.js`)
- **HTML/CSS/JS**: `BrowserWindow({show:false, transparent:true, width:W, height:H, useContentSize:true, webPreferences:{offscreen:true, sandbox:true, contextIsolation:true, nodeIntegration:false, partition:'geocode'}})`. Session riêng: chặn `file://` và các cổng localhost của app; mặc định cho https (CDN thư viện/phông).
- **Đồng hồ ảo** để khung chính xác, không phụ thuộc tốc độ máy: script chèn trước mã người dùng thay `requestAnimationFrame`, `performance.now`, `Date.now`, `setTimeout/Interval`; CSS animation/transition qua Web Animations API (`document.getAnimations()` → pause + `currentTime = t`). API tường minh `window.geocode = { t, frame, fps, duration, width, height, onFrame(cb) }` cho ai muốn tự vẽ.
- Mỗi khung: `seek(t)` → chờ 2 rAF + `document.fonts.ready` → `webContents.capturePage()` → `image.toBitmap()` (BGRA thô) → ghi vào **stdin ffmpeg** (`-f rawvideo -pix_fmt bgra -s WxH -r fps -i -` → PNG `-compression_level 1`). ffmpeg lấy từ `RuntimePaths.ffmpegDir()` — cùng đường cho Win/Mac. Ghi nối tiếp (pipeline: chụp khung n+1 trong lúc ffmpeg nén khung n).
- HiDPI (Mac Retina, Windows 125–200%): kiểm `image.getSize()`; lệch thì `setZoomFactor(1/scale)` hoặc `--force-device-scale-factor` riêng cho offscreen; có test kích thước khung.
- Bảo vệ: quá hạn mỗi khung (vd 5 s) hoặc tổng → huỷ cửa sổ, báo lỗi; console/lỗi của mã người dùng hiện trong pane.
- **Python (Python thật của máy — đã chốt)**: tìm interpreter bằng `pythonCommand()` (`scripts/python_command.js`: `CRAB_PYTHON` → `.venv` → runtime Win `%LOCALAPPDATA%\CrabbyCut\runtime\python` → `python3`/`python` trên PATH, tức Mac dùng python3 hệ thống).
  - Harness mới `scripts/geocode_py_harness.py`: nạp mã người dùng từ file tạm, gọi `frame(t, width, height)` cho từng khung (ảnh tĩnh: một lần với `t=0`, hoặc đọc biến `image`), chấp nhận `PIL.Image` / numpy `HxWx4` / figure matplotlib, chuẩn hoá RGBA đúng W×H rồi ghi byte thô ra **stdout** → nối ống thẳng vào stdin ffmpeg (`-pix_fmt rgba`). stderr + `print()` → khung log trong pane. Chạy `-u`, cwd = thư mục tạm, kill khi Huỷ/quá hạn.
  - Kiểm trước khi chạy: không tìm được Python hoặc thiếu Pillow → thông báo rõ kèm lệnh cài (`python3 -m pip install pillow numpy`) — chủ yếu cho Mac.
  - Ghi rõ trong pane: mã Python chạy với toàn quyền người dùng (khác HTML/JS trong sandbox).
- IPC mới trong `electron/preload.js`: `geocodeRender({…})`, `geocodeCancel(id)`, sự kiện tiến độ.

### B4. Xem trước trong preview
- `renderPreviewOverlays` (`editing-runtime.js:17299`) thêm nhánh `geocode`: ảnh tĩnh → `<img>`; video → `<canvas>` vẽ khung theo playhead từ bộ nạp `ImageBitmap` có LRU + nạp trước quanh playhead (giống canvas Text Template ~17597). Khung >1280 px tạo thêm bản proxy nhỏ cho preview.
- Nút **Xem thử** trong pane: chạy mã trực tiếp ở cửa sổ nhỏ (không lưu khung) để sửa nhanh.

### B5. Xuất video
- `exportPayload` (`editing-runtime.js:22618`) nhánh `geocode`: gửi `geocode_frames_dir` + `frame_count` + `fps` + `loop` (không nhồi data URL).
- `backend/server.js` `normalizeEditingPayload` (~5825/5877): `geocode` → `media_image` (tĩnh) hoặc `image_seq` trỏ thẳng vào thư mục cache (kiểm thư mục nằm trong cache GeoCode), keyframe/animation đi như shape. Sidecar không cần sửa (đã ghép `image_seq` alpha cả CPU lẫn CUDA). Lặp: backend sinh danh sách khung lặp (hard link) hoặc dùng `-stream_loop`.
- Trần `image_seq` hiện 3600 khung/fps 10–60 (`server.js:5883`) → GeoCode cho thời lượng tối đa 60 s @60fps (120 s @30) — hoặc nâng trần nếu cần.

### B6. MCP cho GeoCode
- `crabbycut_add_geocode {lang, code, width|preset, height, kind, duration, fps, start, track_id, transform, keyframes}` — chạy như một job (`start_job`/`job_status`) vì render lâu; dùng được trong `crabbycut_batch`.
- **Mọi ngôn ngữ, kể cả Python thật (đã chốt).** Vẫn chỉ hoạt động khi người dùng bật cầu nối tự động hoá (`general.automationBridge`, mặc định tắt). Mỗi lần MCP chạy Python: toast "MCP đang chạy mã Python" + ghi log; `mcp/README.md` cảnh báo rõ quyền hạn.

## Tối ưu Win/Mac
- Một đường render duy nhất (Electron offscreen + ffmpeg runtime) cho cả hai OS; không phụ thuộc NVENC/VideoToolbox lúc sinh khung. Lúc xuất, khung đi đường `image_seq` sẵn có → hưởng nguyên CUDA (Win) / VideoToolbox (Mac).
- Đường dẫn qua `path.join`, ffmpeg không có `.exe` trên Mac, tên file khung không ký tự lạ.
- Chạy CI Win + Mac (ruleset `main` bắt buộc).

## Kiểm chứng
1. `npm run i18n:check`; test có sẵn `npm run test:keyframe-drag`, `tests/scripts/position_keyframe_pairing.js`.
2. Test mới `tests/scripts/geocode_render.js`: render HTML 450×200 tĩnh + CSS animation 2 s @30fps → đúng 60 khung, đúng kích thước, góc trong suốt alpha=0, khung t=1s giống nhau giữa hai lần chạy (đồng hồ ảo).
3. Test mới `tests/scripts/mcp_batch.js`: lô 20 ảnh kèm keyframe → 1 bước undo, đúng keyframe, đếm `renderAll` = 1.
4. Chạy thật qua MCP crabbycut trong phiên: `add_media_batch` 10 ảnh mẫu kèm keyframe position/scale, `crabbycut_screenshot`, `undo` một lần xoá sạch.
5. Electron thật: tạo GeoCode nút 450×200 có animation, phát preview, xuất MP4 (GPU và CPU) → so khung xuất với khung cache (ffmpeg trích khung).
6. Mac: CI build + chạy `geocode_render.js` trên runner macOS.

## Quy trình
- Hai nhánh tạm / hai PR: `feat/mcp-batch` rồi `feat/geocode` (theo ruleset `main`), CI Win+Mac. Không push khi chưa được phép. Bàn giao `docs/BAN_GIAO_GEOCODE.md`, quyết định ghi `docs/KE_HOACH_GEOCODE.md`.

## Quyết định đã chốt (2026-10-17) — ghi trong `docs/KE_HOACH_MCP_GEOCODE.md`
1. Python của GeoCode = Python thật của máy (Win: runtime sẵn có; Mac: python3 hệ thống + Pillow).
2. Đầu ra = block GeoCode giữ mã, sửa và Tạo lại được; khung là cache tự dựng lại.
3. MCP được tạo GeoCode với mọi ngôn ngữ, kể cả Python.
4. MCP gộp = cả `crabbycut_add_media_batch` lẫn `crabbycut_batch`.

## Thứ tự làm
0. **Lưu nguyên kế hoạch này thành `docs/KE_HOACH_MCP_GEOCODE.md`** (theo yêu cầu người dùng; gồm cả mục "Quyết định đã chốt").
1. A1–A3 (MCP gộp + keyframe) → test + chạy thật qua MCP → PR 1.
2. B1–B2 (UI + khối dữ liệu) → B3 HTML/JS → B4 preview → B5 xuất → B3 Python → B6 → PR 2.
