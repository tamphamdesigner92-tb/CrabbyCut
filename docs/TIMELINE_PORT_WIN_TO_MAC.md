# BÀN GIAO — Chuyển thay đổi Timeline từ `CrabbyCut_v1.1.1-Win` sang bản Macbook (`CrabbyCut_v1.1.0`)

> File HƯỚNG DẪN CHUYỂN MÃ. Nó ghi lại **đúng những gì đã sửa trên Timeline panel ở nhánh
> Windows** và **cách đưa sang nhánh Mac**, không phải tài liệu kiến trúc.
> Chi tiết kiến trúc timeline nằm ở [APP_INTERNALS.md](APP_INTERNALS.md).
> Xoá file này sau khi đã chuyển xong và nhánh Mac đã chạy ổn.

Cập nhật: 2026-09-03 · Nguồn: `CrabbyCut_v1.1.1-Win` (`65fb148`) · Đích: `CrabbyCut_v1.1.0` (`c84366e`)

---

## 1. TÌNH TRẠNG MỘT DÒNG

Ba commit trên nhánh Windows (`004766a`, `3e905f1`, `caa93fe`) đã làm lại toàn bộ cách
**con trỏ chuột tương tác với Timeline panel** ở giai đoạn Editing (step4). Bản Mac
(`CrabbyCut_v1.1.0`) chưa có phần này nên hai máy đang cho cảm giác dùng khác nhau.

**Đã kiểm chứng: bản vá áp sạch 100% lên nhánh Mac**, không một xung đột nào, ở cả ba file
(`index.html`, `static/js/editing-runtime.js`, `static/js/audio-waveform.js`). Xem mục 5.

---

## 2. VÌ SAO HAI NHÁNH LỆCH NHAU

Hai nhánh tách ra ở `2068f42` (26/08/23), **trước** cả ba commit timeline:

```
2068f42 ─┬─ eae8918 ─ c84366e                          ← CrabbyCut_v1.1.0      (Mac)
         │
         └─ … ─ 004766a ─ 3e905f1 ─ caa93fe ─ 65fb148   ← CrabbyCut_v1.1.1-Win  (Windows)
                └──────── 3 commit Timeline ────────┘
```

Ba commit cần chuyển:

| Commit | Nội dung | File bị sửa |
|---|---|---|
| `004766a` | Thay đổi hiển thị con trỏ chuột khi di chuyển trên timeline | `index.html`, `editing-runtime.js` |
| `3e905f1` | Fix hiển thị chiều cao sóng âm của block | `index.html`, `editing-runtime.js`, `audio-waveform.js` |
| `caa93fe` | Fix lỗi di chuyển trên timeline | `index.html` |

Tổng: **+475 / −68 dòng** trên 3 file nguồn.

---

## 3. NHỮNG GÌ ĐÃ THAY ĐỔI

### 3.1. Con trỏ chuột đổi hình theo VÙNG đang rê

Trước đây `.timeline-track-container` đặt `cursor: pointer` cho cả mặt timeline: thước,
vùng trống và block trông y hệt nhau, không ai đoán được vùng nào làm gì.

Bây giờ ở giai đoạn Editing con trỏ nói rõ vùng nào làm gì:

| Vùng | Con trỏ | Thao tác |
|---|---|---|
| Ngoài thước (vùng trống / block) | mũi tên `default` | bấm chọn / quét khung chọn |
| Dải thước trên cùng | mũi tên 2 chiều `ew-resize` | kéo để tua |
| Đang cầm kéo block | bàn tay nắm `grabbing` | di chuyển block |
| Đang trim mép block | `ew-resize` | co giãn block |
| Đang bật dao cắt | con trỏ dao (SVG) | cắt block |
| Lane bị khoá | `not-allowed` | (giữ nguyên như cũ) |

Chỗ cần biết khi đọc code:

- CSS ở `index.html` khoảng dòng 1957–2013 — khối `/* ===== CON TRỎ THEO VÙNG ===== */`.
- Class `.tl-zone-ruler` **phải gắn bằng JS** lên `.timeline-track-frame`, không dùng được
  `:hover`. Lý do: `.editing-ruler` có `pointer-events: none` nên không phần tử nào ở dải
  thước nhận được con trỏ.
- Khối `.tl-zone-ruler` **cố ý đặt TRƯỚC** khối `.razor-mode`: hai bên cùng độ đặc hiệu
  `(0,3,0)` nên razor thắng nhờ thứ tự nguồn — dao cắt luôn đè lên mọi con trỏ theo vùng.
  **Đừng đổi thứ tự hai khối này.**
- Ba class khoá con trỏ toàn cục trong lúc kéo — `body.tl-scrubbing`, `body.tl-trimming`,
  `body.tl-block-dragging` — dùng cùng khuôn với `body.inspector-scrubbing` có sẵn. Không có
  chúng thì một cú kéo bắt đầu ở thước đi ngang qua lane/block sẽ làm con trỏ nhấp nháy đổi
  hình giữa chừng.

### 3.2. `getTimelinePointerZone()` — một định nghĩa duy nhất về "vùng"

`index.html` khoảng dòng 8838. Trả về một trong:
`ruler` · `rail` · `lane-rail` · `handle` · `block` · `empty` · `outside`.

Dùng chung cho **bốn** nơi thay vì mỗi nơi tự đo một kiểu: hình con trỏ, đường kẻ mờ, cổng
`mousedown`-để-tua, và cổng mở khung chọn của `editing-runtime`.

Hai điểm **rất dễ làm sai** khi chỉnh sau này:

- **Đo hình học, không dò `e.target`.** `.editing-ruler` có `pointer-events: none` nên
  `e.target` ở dải thước luôn là lane / `#timelineTrack` nằm dưới, không bao giờ là thước.
- **Dùng Y theo khung nhìn (`clientY - frame.top`), KHÔNG cộng `scrollTop`.**
  `.editing-ruler` là `position: sticky; top: 0` nên luôn được vẽ ở y `0..26` của khung nhìn
  dù lane đã cuộn dọc bao xa. Cộng `scrollTop` chính là lỗi của `marqueeStartAllowed` bản
  cũ: cuộn lane xuống quá 30px thì kéo trên thước lại mở khung chọn thay vì tua.

Hai hằng số phụ thuộc: `TL_LANE_RAIL_W = 168` (= `--lane-rail-w` = `LANE_LABEL_WIDTH`) và
`TL_RULER_H_EDITING` (đọc `--ruler-h`, mặc định 26). **Cả hai giá trị này trên nhánh Mac
đã trùng khớp** (`--ruler-h: 26px`, `--lane-rail-w: 168px`, `LANE_LABEL_WIDTH = 168`) nên
không cần chỉnh gì.

### 3.3. Đường kẻ mờ bám con trỏ, bám lưới khung hình

Phần tử mới `.timeline-hover-guide` / `#timelineHoverGuide` (`index.html` khoảng dòng 1999
và 4110) — một vạch dọc mờ chỉ đúng khung hình mà con trỏ đang trỏ. Dính vào mốc bắt dính
thì đổi sang vạch vàng dày (`.is-snapped`).

- Phần tử **đặt NGOÀI `#timelineTrack`**: `renderEditingTimeline()` xoá sạch `innerHTML`
  của `#timelineTrack` mỗi lượt vẽ, để trong đó là mất phần tử.
- Di chuyển bằng `transform` chứ không bằng `left` — `transform` chạy ở compositor, `left`
  gây reflow mỗi lần chuột nhích.
- `z-index: 47` = dưới `.razor-guide-line` (48) và `#playhead` (50).
- Không `Math.round()` toạ độ: ở zoom thấp một khung hình chưa tới 1px (20px/s ÷ 30fps =
  0.67px), làm tròn nguyên pixel sẽ dồn nhiều khung về cùng một vạch.
- Vòng cập nhật (`index.html` khoảng dòng 12941–12999) dò lại target bằng
  `document.elementFromPoint` chứ không giữ `e.target`, vì DOM có thể đã bị xoá giữa lúc
  chờ `requestAnimationFrame`.
- Có **chốt an toàn `setTimeout(…, 120)`** cạnh mỗi `requestAnimationFrame`: cửa sổ bị ẩn
  hoặc thu nhỏ thì rAF không chạy, cờ sẽ kẹt và đường kẻ đứng im mãi kể cả sau khi hiện lại.

### 3.4. Kéo-để-tua giới hạn về đúng dải thước

`index.html` khoảng dòng 10173–10186. Ở Editing, `mousedown` chỉ bắt đầu tua khi
`zone === 'ruler'`. Vùng trống đã thuộc khung chọn, block đã thuộc cú kéo block — nên không
mất thao tác nào, mà hết cảnh **kéo block thì playhead chạy theo**.

Ở RAW/MAPPED/step3 thì **giữ nguyên nếp cũ**: các stage đó không có khung chọn, và
`#segmentsTrack` chỉ chiếm nửa dưới khung (`top: 50%`) nên nửa trên chính là chỗ người dùng
vẫn bấm để tua. Chặn ở đó sẽ giết một nửa mặt timeline.

Thêm `if (e.button !== 0) return` — chuột phải không tua nữa.

### 3.5. Ba lỗi "playhead tự nhảy" đã sửa

Đây là phần **đáng giá nhất** của `caa93fe`, và cũng là phần khó thấy nhất:

1. **Nhả chuột ngoài cửa sổ** → `mouseup` không bao giờ tới, cờ `isDraggingPlayhead` kẹt
   `true`, timeline tua theo chuột mãi. Rất dễ gặp khi kéo vượt mép màn hình — **và trên
   macOS thì càng dễ gặp hơn**. Sửa bằng `if (e.buttons === 0) endPlayheadDrag()` trong
   `mousemove`, cộng thêm `window.addEventListener('blur', endPlayheadDrag)`.
2. **Thả chuột sau khi kéo trên thước vẫn sinh ra một cú `click`** với target nằm trong
   `#segmentsTrack` (ở Editing `#segmentsTrack` phủ `top: 0; height: 100%` nên trùm cả dải
   thước). Handler `click` đó chọn block rồi kéo playhead đi chỗ khác — đúng cái "nhấc chuột
   lên là playhead tự nhảy". Sửa bằng `suppressNextTimelineClickOnce()`, **chỉ khi** cú kéo
   bắt đầu từ thước (cờ `playheadScrubFromRuler`); ở RAW/MAPPED/step3 mọi cú bấm đều đi qua
   đây, bỏ hết thì mất luôn thao tác bấm-để-chọn-block.
3. **Bấm vào vùng trống nhảy về đầu block.** Giờ bấm vùng trống giống hệt bấm lên chính
   block đó: chọn block nhưng playhead đi tới **đúng chỗ vừa bấm**, kẹp trong khoảng của
   block. Hàm `timelineClipIndexFromClickEvent` được thay bằng
   `timelineClipSpanFromClientX` trả về `{ index, start, end, time }` (`index.html` khoảng
   dòng 12888), và dùng `clipSequenceDuration()` (có chia tốc độ) chứ không phải
   `end - start` thô — nếu không, clip đã đổi tốc độ sẽ tính lệch hẳn so với block đang
   hiển thị.

Toàn bộ dồn vào một hàm `endPlayheadDrag()` duy nhất (`index.html` khoảng dòng 10207), gọi
từ cả `mouseup`, `mousemove` và `blur`.

### 3.6. `seekTimeline()` — bám lưới khung hình, và kéo chậm bằng Alt

`index.html` khoảng dòng 10251. Bốn thay đổi:

- **`roundTimeToFrame()`** (khoảng dòng 8788) — làm tròn về khung hình gần nhất bằng
  `Math.round`, **cùng công thức** với `formatTimecode` (`:ff`) và `stepPlayheadByFrames`.
  Ba chỗ làm tròn khác nhau là ba lưới khung khác nhau: bấm vào một khung rồi bước ±1 khung
  sẽ lệch nửa khung, và ô timecode nhảy số không khớp chỗ vừa bấm.
- **THỨ TỰ: BẮT DÍNH TRƯỚC, LƯỚI KHUNG SAU.** Mốc bắt dính (mép clip, keyframe) là số thực
  bất kỳ, không nhất thiết rơi đúng mép khung; làm tròn nó sẽ đẩy ra khỏi mép clip tới nửa
  khung → bấm đúng chỗ cắt mà lại không dính chỗ cắt. **Đừng đảo hai bước này.**
- **Giữ Alt trong lúc kéo thước = tua chậm 5 lần** (`FINE_SCRUB_FACTOR = 0.2`), để canh đúng
  khung hình cần. Chọn Alt vì Shift đã là "bật bắt dính" và Ctrl/Cmd là "chọn thêm".
- **Bỏ lượt trùng**: chuột 1000Hz hay trackpad bắn nhiều sự kiện trong cùng một khung hình
  màn hình; sau khi bám lưới khung phần lớn cho ra cùng một giá trị → `lastAppliedSeekTime`
  bỏ luôn, khỏi ghi `scrollLeft` và khỏi đặt lịch seek.

Lưu ý mô hình tua **theo vận tốc**, không phải bám dính con trỏ: playhead ghim giữa
viewport, mỗi lượt lấy "thời gian ở tâm + độ lệch của con trỏ so với tâm", nên con trỏ càng
xa tâm thì timeline chạy càng nhanh. Công thức được viết tường minh ra (thay vì
`pxToTimelineTime(scrollLeft + pointerX)`) để nhân được hệ số kéo chậm vào đúng độ lệch đó —
hai cách cho kết quả y hệt khi `factor = 1`.

### 3.7. Bánh xe chuột / trackpad — phần liên quan trực tiếp tới Mac

`index.html` khoảng dòng 10078–10125. **Đây là mục cần để ý nhất khi chuyển sang Mac**, vì
nó chạm đúng vào cử chỉ trackpad:

- **`wheelDeltaPx()`** quy `deltaMode` về pixel. Chromium gần như luôn báo mode 0 (pixel),
  nhưng một số driver chuột trên Windows báo mode 1 (dòng) — khi đó một nấc chỉ là
  `deltaY = 3`, timeline cuộn 3px thay vì 100px. Trên Mac phần này gần như không kích hoạt,
  giữ lại cũng vô hại.
- **Vuốt 2 ngón ngang giờ cuộn được timeline.** Trước đây `deltaX` bị bỏ qua hoàn toàn, nên
  **cử chỉ tự nhiên nhất trên macOS lại không làm gì cả**. Giờ lấy trục nào trội hơn.
  → Đây là thay đổi mà người dùng Mac sẽ cảm nhận rõ nhất.
- **Pinch 2 ngón để zoom.** `e.ctrlKey` là cách Chromium tổng hợp cử chỉ chụm hai ngón trên
  **cả macOS lẫn** touchpad chính xác của Windows. `altKey` giữ nguyên làm phím tắt zoom cũ,
  `metaKey` thêm vào cho Cmd trên Mac.
- **Hệ số zoom theo ĐỘ LỚN delta**, không phải hệ số cố định. Bản cũ nhân `1.08` mỗi sự
  kiện: một nấc chuột thì vừa, nhưng pinch bắn ~60 sự kiện/giây nên thành `1.08^60 ≈ 100`
  lần/giây — zoom bay mất. Hằng `0.00077 = ln(1.08)/100` giữ cho một nấc chuột
  (`|deltaY| = 100`) vẫn đúng `×1.08` y như trước; pinch dùng `0.010`.

> **Cần canh lại trên Mac:** hệ số pinch `0.010` được chỉnh theo touchpad Windows. Trackpad
> Apple bắn delta khác biên độ, nên nếu zoom thấy quá nhạy hoặc quá đằm thì **chỉ cần sửa
> đúng một con số này**, không phải sửa gì khác.

### 3.8. Dao cắt — hết lỗi "cắt được một lần rồi thôi"

Hằng số dùng chung mới `TIMELINE_MIN_SPLIT_SECONDS = 0.1` (`index.html` khoảng dòng 4248),
thay cho ba chỗ trước đây mỗi hàm tự khai riêng `0.1`.

Nguyên nhân lỗi gồm ba lớp, cả ba đều đã sửa:

1. `findNearestSplitBoundary` **kẹp vào đúng ngưỡng**, còn `buildSplitTimelineItems` **từ
   chối bằng `<=` ngưỡng** → cái kẹp tự vô hiệu hoá chính nó, sinh ra một giá trị chắc chắn
   bị từ chối. Sửa bằng `EDGE_EPSILON = 1e-3`, kẹp vào phía **trong** ngưỡng.
2. Dao cắt bắt dính playhead, mà playhead ghim giữa viewport và sau mỗi nhát cắt lại đứng
   ngay trên mép vừa tạo → nhát sau bị hút về đúng mép đó rồi bị từ chối. Giờ chỉ bắt dính
   khi playhead nằm **sâu bên trong** clip (cách mép hơn `TIMELINE_MIN_SPLIT_SECONDS`).
3. `buildSplitTimelineItems` từ chối khi một nửa **không có lời thoại**. Dao cắt là công cụ
   **thời gian**: từ chối cắt một clip 6 giây chỉ vì lời thoại của nó có đúng 1 từ là sai.
   Thêm `options.allowEmptyText` — dao cắt truyền `true`, còn tính năng **sắp xếp lại theo
   kịch bản** giữ luật cũ (mảnh không có chữ thì vô nghĩa với nó).

Kèm theo: mọi lần từ chối giờ **nói rõ đang vướng cái gì, có số liệu** (`showToast` chứ
không phải `setStatusText`, vì thanh trạng thái bị lượt vẽ lại ngay sau đó ghi đè). Bấm dao
cắt mà không trúng block cũng có toast thay vì thoát im lặng.

### 3.9. Sóng âm — chiều cao và z-index

| | Trước (Mac hiện tại) | Sau |
|---|---|---|
| `WAVE_MEDIA_HEIGHT` | 16 | **24** |
| `DISPLAY_GAIN` (`audio-waveform.js`) | — (không có) | **1.35** |
| `#editingWaveformCanvas` z-index | 21 | **25** |
| `.editing-transition-band` z-index | 22 | **26** |
| `.editing-transition-dropzone` z-index | 22 | **26** |
| `#editingMainLaneDropZone` z-index | 24 | **27** |

Ba lý do:

- **Chiều cao 16 → 24.** Ở 16px nửa biên độ chỉ còn 8px nên tiếng nói bình thường vẽ ra một
  sợi chỉ, phải kéo Volume lên mới nhìn được — mà **Volume là thuộc tính xuất bản, không
  phải nút phóng to hình**. Lane thấp nhất có sóng là media (57−12 = 45px) nên 24+5 vẫn thừa
  chỗ.
- **`DISPLAY_GAIN = 1.35`** (`audio-waveform.js` dòng 42) — hệ số phóng biên độ **chỉ khi
  VẼ**. Không đụng dữ liệu, không đụng âm lượng xuất bản. `gain` của caller vẫn là âm lượng
  thật của block (`volume/100`) để giữ quan hệ "tăng Volume → sóng cao hơn"; `DISPLAY_GAIN`
  nhân thêm ở bộ vẽ dùng chung nên mọi giai đoạn cùng một dáng sóng. `Math.min(1, …)` bên
  dưới vẫn chặn nên chỗ to nhất chỉ chạm mép dải.
- **z-index 21 → 25 (lỗi đã sửa).** Block **đang chọn** được nhấc lên `z-index: 24` (và 23
  cho chọn-thêm) để cạnh trắng không bị block kề vẽ đè. Ở z21 thì canvas sóng âm nằm **dưới
  chính block vừa chọn** → **chọn block nào là block đó mất sóng âm**, bỏ chọn thì sóng hiện
  lại. Canvas không phải block nên phải nằm trên toàn bộ dải 20..24. Dải chuyển cảnh và
  drop-zone phải đẩy lên theo để giữ đúng thứ tự cũ so với canvas.

### 3.10. `editing-runtime.js` — phần phối hợp

- `setTimelineDragCursor(mode)` / `clearTimelineDragCursor()` (khoảng dòng 1718) — bật/tắt
  `body.tl-trimming` hoặc `body.tl-block-dragging`, và bắn sự kiện `tl-drag-state-change`
  để `index.html` ẩn đường kẻ mờ ngay, khỏi phải hỏi vòng.
- Gọi từ 4 chỗ: `startItemDrag`, `finishItemDrag`, `startMainBlockDrag`,
  `finishMainBlockDrag`.
- **Lưới an toàn `window.addEventListener('blur', clearTimelineDragCursor)`** — mất focus
  cửa sổ giữa cú kéo (Alt-Tab, mở hộp thoại) thì `mouseup` có thể không bao giờ tới, con trỏ
  sẽ **kẹt hình bàn tay nắm trên toàn app**.
- `isTimelineDragActive()` được export qua `window.EditingRuntime` để `index.html` hỏi.
- `marqueeStartAllowed()` chuyển sang dùng `getTimelinePointerZone(event) === 'empty'`, có
  fallback về công thức cũ nếu hàm chưa tồn tại.

---

## 4. NHỮNG GÌ **KHÔNG** NẰM TRONG BẢN VÁ NÀY

Cố ý loại ra, đừng kéo theo:

- **`65fb148`** — toàn bộ phần **Lớp Điều chỉnh** (inspector của lớp adjust,
  `color-adjust.js`, `ColorAdjust.scaleStrength`, test `adjust_layer_pipeline.js`). Nhánh
  Mac đã có bản fix tương ứng ở `eae8918` / `c84366e`.
- **Tích hợp AI Hub** (`core_logic.py`, `electron/main.js`) — thứ này **chỉ có ở nhánh Mac**
  và **phải giữ nguyên ở đó**. Bản vá timeline không chạm tới hai file này.
- **Mọi thứ thuần Windows**: `asr/windows_faster_whisper_sidecar.py`, `native/` (build
  MSVC), `scripts/build_sidecar.js`, `requirements.txt`, `package-lock.json`,
  `backend/server.js`.
- `progress.txt` và `reports/*` — file ghi chép, xung đột vô nghĩa, bỏ hẳn.

---

## 5. CÁCH CHUYỂN MÃ

### 5.1. Tạo bản vá (chạy trên máy nào cũng được, chỉ cần có repo)

```bash
git fetch origin && git diff 004766a^..caa93fe -- index.html static/js/editing-runtime.js static/js/audio-waveform.js > timeline-win-to-mac.patch
```

Bản vá ra đúng **3 file, +475/−68 dòng**. Không chứa `progress.txt`, không chứa `reports/`.

### 5.2. Áp lên nhánh Mac

Làm trên **nhánh nháp** trước, đừng áp thẳng vào `CrabbyCut_v1.1.0`:

```bash
git checkout -b timeline-port-mac origin/CrabbyCut_v1.1.0
```

```bash
git apply --3way timeline-win-to-mac.patch
```

**Kết quả mong đợi** — đã chạy thử và xác nhận:

```
Applied patch to 'index.html' cleanly.
Applied patch to 'static/js/audio-waveform.js' cleanly.
Applied patch to 'static/js/editing-runtime.js' cleanly.
```

Không xung đột nào. Toàn bộ tiền đề mà mã mới cần đều đã có sẵn trên nhánh Mac:
`editing-stage-active`, `--ruler-h`, `--lane-rail-w`, `.timeline-track-frame`,
`snapTimelineTimeToBlocks`, `blockReorderDrag`, `suppressNextTimelineClickOnce`,
`showToast`, `clipSequenceDuration`, `resolveSequenceFps`, `timelineContentYFromClientY`,
`LANE_TOP_PADDING`, `getRazorPointerContext`, `editingMarquee`, `scheduleEditingRulerRender`.

### 5.3. Kiểm tra cú pháp

```bash
node --check static/js/editing-runtime.js && node --check static/js/audio-waveform.js && echo OK
```

### 5.4. Chạy test có sẵn

```bash
npm test
```

Nếu chỉ muốn chạy nhóm liên quan, xem `package.json` — các script `test:*` về frame grid và
color adjust là nhóm dễ bị ảnh hưởng nhất.

### 5.5. Nếu về sau bản vá không còn áp sạch

Chỉ xảy ra khi nhánh Mac có thêm commit sửa đúng những vùng đó. Khi ấy dùng cherry-pick và
tự giải `progress.txt`:

```bash
git cherry-pick -n 004766a 3e905f1 caa93fe
```

`progress.txt` **sẽ** xung đột (đã kiểm chứng) — cứ lấy bản của nhánh Mac:

```bash
git checkout --ours progress.txt && git add progress.txt
```

---

## 6. DANH SÁCH KIỂM TRA SAU KHI ÁP (chạy trên máy Mac)

Vào **step4 (Editing)** với một dự án có ít nhất 3 block, trong đó 1 block có tiếng nói:

**Con trỏ**

- [ ] Rê vùng trống và rê lên block → **mũi tên**, không phải bàn tay-ngón-trỏ
- [ ] Rê lên dải thước trên cùng → **mũi tên 2 chiều**
- [ ] Bấm giữ block → **bàn tay nắm**, giữ nguyên hình đó khi kéo ngang qua thước và lane
- [ ] Bấm giữ mép block để trim → `ew-resize` suốt cú kéo
- [ ] Bật dao cắt → con trỏ dao **đè lên mọi con trỏ theo vùng**, kể cả trên thước
- [ ] Cmd-Tab giữa lúc đang kéo block → con trỏ **không kẹt** hình bàn tay nắm

**Đường kẻ mờ**

- [ ] Rê trên timeline → vạch dọc mờ bám con trỏ
- [ ] Rê gần mép clip → vạch **đổi sang vàng dày**
- [ ] Giữ Shift → vạch đổi màu **ngay**, không cần nhích chuột
- [ ] Đang kéo block / quét khung chọn → vạch **ẩn**
- [ ] Bật dao cắt → vạch mờ ẩn, chỉ còn đường dao
- [ ] Thu nhỏ cửa sổ rồi mở lại → vạch **vẫn chạy** (chốt `setTimeout` 120ms)

**Playhead — ba lỗi ở mục 3.5**

- [ ] Kéo trên thước rồi **nhả chuột ngoài cửa sổ** → playhead **dừng**, không tua theo mãi
- [ ] Kéo trên thước rồi nhả trong vùng timeline → playhead **đứng đúng chỗ vừa nhả**, không
      tự nhảy
- [ ] Bấm vùng trống của một block → chọn block, playhead tới **đúng chỗ bấm**, không nhảy về
      đầu block
- [ ] Kéo một block đi → playhead **không chạy theo**
- [ ] Cuộn lane xuống hết rồi kéo trên thước → **tua**, không mở khung chọn
- [ ] Bấm chuột **phải** trên timeline → không tua
- [ ] Giữ **Option/Alt** trong lúc kéo thước → tua chậm rõ rệt
- [ ] Bước ±1 khung bằng phím → ô timecode `:ff` **khớp** với chỗ vừa bấm

**Trackpad Mac** (mục 3.7 — phần cần canh lại)

- [ ] **Vuốt 2 ngón ngang** → timeline cuộn ngang (trước đây không làm gì)
- [ ] **Pinch 2 ngón** → zoom; nếu quá nhạy/quá đằm thì sửa hằng `0.010` trong nhánh
      `e.ctrlKey` của handler `wheel`
- [ ] `Cmd` + bánh xe → zoom
- [ ] Bánh xe chuột thường một nấc → zoom đúng ×1.08 như cũ

**Dao cắt**

- [ ] Cắt **nhiều nhát liên tiếp** trên cùng một clip → nhát nào cũng ăn
- [ ] Cắt một clip dài mà lời thoại chỉ có 1 từ → **cắt được**
- [ ] Cắt sát mép clip → có **toast nói rõ số liệu**, không phải "Không thể cắt đoạn quá ngắn"
- [ ] Bấm dao cắt vào chỗ trống → có toast, không im lặng
- [ ] Tính năng **sắp xếp lại theo kịch bản** vẫn hoạt động như cũ

**Sóng âm**

- [ ] Sóng cao rõ ràng ở Volume 100%, không phải sợi chỉ
- [ ] **Chọn một block có sóng → sóng KHÔNG mất** (đây là lỗi z-index 21)
- [ ] Chọn nhiều block → sóng vẫn còn ở tất cả
- [ ] Tăng Volume → sóng cao hơn (quan hệ này phải còn)
- [ ] Dải chuyển cảnh sọc chéo vẫn **nằm trên** sóng âm
- [ ] Rail nhãn lane vẫn **che** sóng âm ở mép trái

**Không được hỏng (giai đoạn khác)**

- [ ] RAW / MAPPED / step3: bấm **nửa trên** mặt timeline vẫn tua như cũ
- [ ] RAW / MAPPED / step3: bấm block vẫn chọn được block

---

## 7. GHI CHÚ CHO NGƯỜI SỬA SAU

Bốn chỗ trong bản vá này **có lý do đặt đúng như vậy**, đổi là hỏng:

1. **Thứ tự khối CSS** `.tl-zone-ruler` trước `.razor-mode` — cùng độ đặc hiệu, razor thắng
   nhờ thứ tự nguồn.
2. **`getTimelinePointerZone` đo Y theo khung nhìn, không cộng `scrollTop`** — vì
   `.editing-ruler` là `sticky`.
3. **`seekTimeline`: bắt dính trước, lưới khung sau** — đảo lại là bấm đúng chỗ cắt mà không
   dính chỗ cắt.
4. **`#timelineHoverGuide` nằm ngoài `#timelineTrack`** — trong đó là bị `innerHTML = ''`
   xoá mỗi lượt vẽ.

Và một chỗ **cố tình để trùng lặp**: vòng cập nhật đường kẻ mờ nghe `mousemove` riêng chứ
không ghép vào `updateRazorGuideLine` có sẵn, để giữ đường dao cắt đúng nguyên đường đi cũ.
