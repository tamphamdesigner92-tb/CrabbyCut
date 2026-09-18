# Bàn giao — Đợt nâng cấp UI/UX CrabbyCut

> Mục đích: mở một phiên làm việc mới là đọc **đúng file này** rồi làm tiếp được ngay, không
> cần đọc lại lịch sử hội thoại. Chi tiết kỹ thuật từng phần đã xong nằm ở
> [APP_INTERNALS.md](APP_INTERNALS.md); tổng quan ở [APP_STRUCTURE.md](APP_STRUCTURE.md).

Cập nhật: 2026-08-20 · Branch `CrabbyCut_v1.0.8` · Cây làm việc **sạch**, mọi việc dưới đây
đã commit.

---

## 1. Bối cảnh

Rà soát toàn bộ UI của CrabbyCut (Electron, vanilla-JS, CSS inline trong `index.html`) rồi nâng
dần theo chuẩn CapCut / Premiere. Kế hoạch chia 5 phase — **cả A, B, C, D, E đều đã xong**.
Mục tiêu là "đẹp và chuyên nghiệp hơn", không đổi tính năng. Việc còn lại nằm ở §5 (hạng mục
tách riêng, cần bạn duyệt) và §4 (một hạng mục contrast chờ quyết định về màu).

---

## 2. Đã xong (đã commit)

| Commit | Nội dung |
|---|---|
| `365ff61` | **Phase A** — hoàn thiện tầng design token; **thước thời gian HH:MM:SS:FF cho Editing stage** (trước đây KHÔNG có thước nào); chrome block timeline; rail lane có badge V1/A1/M; cụm zoom timeline −/+/Fit/% |
| `7af67b1`, `012cffb` | Chọn nhiều block: ⌘/Ctrl+bấm; bấm vùng trống = bỏ chọn; bấm block trong nhóm = thu về 1; sửa lỗi block CHÍNH trỏ ra ngoài tập đang chọn. Sau đó **gỡ Shift+bấm** theo yêu cầu (khó đoán) |
| `098923e` | **Phase B** — hệ nút `.btn`; style toàn cục slider + ô tích/radio + `.switch`; sprite icon 32→52 symbol và thay ~30 ký tự hình học; tab (tô gạch chân `.ins-tab`, affordance tràn cho `.edit-tabs`); **hệ tooltip dùng chung** thay 108 `title=`; gom thang bán kính |
| `f7323a6` | **Phase C** — tay cầm transform 7→10px; HUD số liệu khi kéo; `.pcb-btn` 22→28px; thanh xem trước tệp dùng lại ngôn ngữ transport |
| `1c70b80` | Tay cầm chọn **theo đúng CapCut** (media 4 góc / text 4 góc + 2 thanh / shape 4 góc + 4 thanh) + **zoom khung Preview** (−/%/+ và Ctrl/⌘+lăn) |
| `de4b996` | Sửa dải tab panel Editing bị co ở tab Chuyển tiếp / LUT (`flex-shrink`) |
| `0062967` | Sửa cụm keyframe trong `.fig-field` lệch lên trên + dãn cách quá rộng |
| `318e2a7` | **Phase D** — `static/js/ui-feedback.js` (toast 4 loại + thanh tiến độ dưới header); chuyển **toàn bộ 49 `alert()`** sang toast; `aria-live` cho `#statusText` + host toast; animation VÀO cho 5 modal + 8 dropdown; dựng lại `showRelinkModal()`/`askSaveBeforeLeave()` theo khuôn `.ui-scrim`+`.ui-modal-panel` (kính mờ, `role=dialog`, nút ×, **ESC**, trả focus); `#settingsModalPanel` `height` cứng → `max-height`; empty state Home có icon + CTA và gom 4/6 empty state; `.breadcrumb-item.active` về `var(--primary)` + `aria-current` |
| `f43fcf5` | Sửa menu fps / kích thước khung ở thanh preview không mở ra — `.pcb-right { overflow: hidden }` cắt CẢ HAI TRỤC, xén sạch `.pcb-menu` mở lên trên. Đổi sang `overflow-x: clip; overflow-y: visible` |
| *(đợt này)* | **Phase E** — sửa lỗi hệ tooltip Phase B **nuốt tên khả truy cập** của nút chỉ-icon; `<label for>` 0 → 40; ngữ nghĩa tab đầy đủ cho 4 dải + điều hướng ←/→/Home/End; bẫy focus + trả focus cho 4 modal khai trong HTML; scrollbar 6px → 10px (trục dọc timeline giữ 6px); 4 nút icon cuối nhận `aria-label`; `role=alert` cho xung đột phím tắt; token `--primary-text` cho accent làm màu chữ |

---

## 3. Phase D — Màn hình, modal, phản hồi (ĐÃ XONG)

Chi tiết đầy đủ: [APP_INTERNALS.md → Phase D](APP_INTERNALS.md#đợt-uiux-pro--phase-d-màn-hình-modal-phản-hồi-2026-08-20).
Tóm tắt để không phải mở file kia:

- **D1** — thêm `static/js/ui-feedback.js` (nạp ĐẦU TIÊN trong `<head>`): `window.showToast()`
  4 loại info/success/warning/error, gộp thẻ trùng bằng huy hiệu `×n`, trần 4 thẻ, rê chuột
  thì dừng đồng hồ; `window.setAppProgress()` là dải 2px sát mép dưới `.header-bar`.
  **49 `alert()` → 0** (31 error / 17 warning / 1 info). `aria-live` cho `#statusText` và host
  toast. Tiến độ **vô định** bám cờ `isBusy` sẵn có của `setStatusText` (không sửa call site
  nào); tiến độ **xác định** cắm vào 3 vòng bake sẵn có qua
  `window.beginAppTask/updateAppTask/endAppTask`.
- **D2** — animation VÀO cho 5 modal + 8 dropdown (4 keyframe, không dùng lẫn được — xem
  Internals). `showRelinkModal()` và `askSaveBeforeLeave()` dựng lại theo khuôn chung
  `.ui-scrim` + `.ui-modal-panel`: kính mờ, `role="dialog"`, nút ×, **ESC đóng**, trả focus về
  chỗ cũ; hợp đồng trả về giữ nguyên. `#settingsModalPanel` đổi `height` cứng → `max-height`.
- **D3** — empty state Home có icon + tiêu đề + mô tả + CTA, tách hai ca (lọc không khớp /
  chưa có dự án nào). Gom **4/6** empty state về một khuôn; `.video-lib-empty` (vùng thả tương
  tác) và `.set-empty` (chip inline) cố ý giữ riêng.
- **D4** — `.breadcrumb-item.active` bỏ `#00d2ff` + glow → `var(--primary)` + `--fw-semibold`
  + `aria-current="step"`.

### ⚠ ĐÍNH CHÍNH kế hoạch cũ (giữ lại làm bài học)

1. Kế hoạch ghi *"lưới `.home-grid` và empty state hiện là chữ trần"*. **`.home-card` đã có
   thumbnail / tên / thời gian sửa từ trước** (`index.html` `.home-card-*` + `renderHomeRecents`).
   Chỉ empty state mới là chữ trần. Đo lại trước khi tin một dòng mô tả trong kế hoạch.
2. Kế hoạch ghi *"BUG: `.app-menu-dropdown` có `background-color: rgba(0,0,0,0)`"*. **Đo sai,
   không phải lỗi.** Rule luôn có `background: var(--glass-bg-strong)` — một linear-gradient,
   mà `getComputedStyle().backgroundColor` luôn trả `rgba(0,0,0,0)` khi nền đặt bằng gradient
   (gradient là background-**image**). Muốn menu bớt "ám" thì nâng alpha token
   `--glass-bg-strong`, và nhớ token đó dùng CHUNG với modal Export / Cài đặt / Chụp khung.

### Còn nợ của D1 — cố ý không làm

`confirm()` (8 chỗ) và `window.prompt()` (1 chỗ) **chưa thay**: thay chúng phải chuyển hàm gọi
sang async ⇒ chạm luồng điều khiển, nằm ở hạng mục tách riêng §5.2. Cũng chưa có skeleton
loading — mọi chỗ tải đều đã có `.edit-loading` hoặc thanh tiến độ.

## 4. Phase E — Trợ năng & hoàn thiện (ĐÃ XONG)

Chi tiết: [APP_INTERNALS.md → Phase E](APP_INTERNALS.md#đợt-uiux-pro--phase-e-trợ-năng--hoàn-thiện-2026-08-21).

- **Lỗi thật phát hiện khi làm phase này**: hệ tooltip dùng chung của Phase B chuyển `title` →
  `data-tip` rồi `removeAttribute('title')`. Với nút chỉ-có-icon, `title` là **tên khả truy
  cập DUY NHẤT** — rê chuột qua một lần là nút thành vô danh. Nay chỉ chép sang `aria-label`
  khi phần tử **chưa có tên nào khác**.
- `<label for=…>` **0 → 40**. `settings-panel.js` không cần sửa (7 label ở đó BỌC control).
- Ngữ nghĩa tab đủ cho cả 4 dải + điều hướng ←/→/Home/End. `aria-selected` đặt **cùng chỗ**
  với class `is-active` — đặt ở markup tĩnh là sai ngay lượt đổi tab đầu tiên.
- Bẫy focus + trả focus cho 4 modal khai trong HTML (`window.UiA11y.trapFocus`). Không truyền
  `onEscape` vì cả 4 đã có handler ESC riêng.
- Scrollbar 6px → 10px. ⚠ **Trục DỌC của `.timeline-track-outer` phải giữ 6px** — `clientWidth`
  của nó là đầu vào của phép ghim playhead giữa khung (xem §6 và §5.4).
- 4 nút chỉ-icon cuối cùng nhận `aria-label`. Kế hoạch ước "~70" là con số **trước Phase B**.
- `role="alert"` cho dải xung đột phím tắt; `aria-live` cho `#editingAssetStatus`.

### Còn nợ — CẦN BẠN QUYẾT: chữ trắng trên nền đặc accent / danger

Đây là hạng mục contrast duy nhất còn dưới chuẩn AA sau khi đo lại có compositing đúng alpha:

```text
  trắng trên --primary #0a84ff   3.65  (cần 4.5)   .btn-primary, .edit-tab.is-active,
                                                    .edit-subtab.is-active, .set-nav-item.is-active,
                                                    .edit-import-btn, .home-cta
  trắng trên --danger  #ff453a   3.41  (cần 4.5)   .btn-danger — nút "Xuất Video"
```

Không sửa được bằng màu chữ (trắng đã là cực đại). Cách duy nhất là **làm tối nền nút**:

```text
  --primary #0a84ff -> #0a6fd6   ra 4.93 ✔   (chính là --primary-hover sẵn có)
  --danger  #ff453a -> #e02d22   ra 4.60 ✔
```

Nhưng §6 ghi accent `#0a84ff` là **ràng buộc cứng**, nên đây là quyết định thẩm mỹ của bạn,
không phải việc dọn dẹp trợ năng. Ba lựa chọn:

1. **Giữ nguyên** — chấp nhận 3.65/3.41 (Apple cũng dùng đúng cặp màu này trên iOS).
2. **Chỉ đổi nền NÚT**, giữ `--primary` cho viền/icon/gạch chân — accent vẫn là `#0a84ff` ở
   mọi chỗ khác, chỉ nút đặc tối hơn một nhịp.
3. **Đổi hẳn token** `--primary` — ảnh hưởng toàn app.

Tôi khuyên phương án 2. Chưa làm gì cho tới khi bạn chọn.

## 5. Hạng mục TÁCH RIÊNG — cần bạn duyệt trước khi làm

1. **Filmstrip thật** trên block timeline (trích nhiều khung từ `<video>` + cache). Hiện chỉ
   dùng 1 ảnh cover; toán số ô đã sửa ở Phase A. Là code mới, tốn CPU.
2. **Thay `confirm()`/`prompt()`** bằng dialog — cần chuyển async ⇒ chạm luồng điều khiển.
3. **Dải zoom timeline**: ở zoom max (600) một clip 8s chỉ rộng 78px ⇒ không cắt theo khung
   được. Nới `max` là chạm toán scale timeline.
4. **Lệch nửa scrollbar** ở step4: `editing-runtime.js` đặt `overflow-y:auto` cho
   `.timeline-track-outer`; khi có scrollbar dọc thì `clientWidth` (toán scroll) ≠ `offsetWidth`
   của frame (playhead `left:50%`) ⇒ lệch ~7px so với `frameRect.width/2` mà razor dùng
   (`index.html` ~10290). **CHỈ BÁO, KHÔNG SỬA** — nằm trong vùng cấm (§6).
5. **Màu nút "Xuất Video"**: đang `.btn-danger` (đỏ) theo lịch sử. Xuất video không phá hoại gì
   nên về ngữ nghĩa đáng ra là `.btn-primary`. Đổi chỉ là sửa một class.
6. **Dải chuyển cảnh** (`.editing-transition-band.is-selected`) vẫn dùng vòng xanh primary —
   một ngôn ngữ chọn khác với khung trắng của block. Đồng bộ hay không là quyết định của bạn.
7. **Selector `button` thô** vẫn còn `width:100%; margin-bottom:10px`. Còn 7 nút dựa vào nó
   (4 nút `btnAddEditing*` đang ẩn + 3 nút xoay/flip). Gỡ hẳn cần rà lại toàn bộ nút.
8. **Mùi specificity**: `.sidebar-left .step-panel button { padding: 8px 10px }` (0-2-1) đang
   **thắng padding riêng của mọi component** trong panel trái — `.edit-subtab`, `.adj-mini-btn`,
   `.edit-transition-card`… đều bị áp `8px 10px` dù tự khai khác. Dọn được nhưng phải đo lại
   từng tab.
9. Solo / volume fader / track targeting / kéo đổi chiều cao lane — **tính năng mới**, không
   phải việc UI.

---

## 6. RÀNG BUỘC CỨNG — đọc trước khi sửa bất cứ gì

- **Playhead ghim 50% giữa panel timeline: TUYỆT ĐỐI KHÔNG ĐỔI.** Không sửa
  `seekTimeline` (`index.html` ~8566), `scrollTimelineToCurrentTime` (`index.html` ~8411 **và**
  bản ghi đè ở `perf-runtime.js` ~357), `updatePlayhead` (~8484),
  `getTimelineSidePaddingPx`/`timelineTimeToPx`/`pxToTimelineTime` (~7280-7291), handler
  `scroll`/`wheel` (~8422-8479), và cấu trúc CSS `.timeline-track-frame` (relative/overflow
  hidden) + `.timeline-track-outer` (absolute/inset 0/overflow-x auto).
  Sau mỗi phase phải kiểm: `playhead.style.left === '50%'`, `transform === 'translateX(-50%)'`,
  lệch tâm khung = 0px, và `git diff` không chạm 3 hàm trên.
- **Không đụng logic/thuật toán.** Chỉ CSS, markup, và mã render thuần trình bày. Giữ nguyên
  mọi id input, `data-transform-field`, `data-edit-tab`, tên hàm.
- **Không thêm gì làm đổi `clientWidth` của `.timeline-track-outer`** (vào trực tiếp toán scroll
  của playhead) — ví dụ `scrollbar-gutter`.
- Dark-only, Apple + glassmorphism "cân bằng", accent `#0a84ff`, body 13px Inter, icon Lucide
  trong sprite. Không làm light mode.

---

## 7. KIẾN THỨC KIỂM THỬ — phần giá trị nhất của bàn giao này

Mỗi mục dưới đây đều đã làm tôi mất thời gian trong đợt này. Đọc trước khi tin bất cứ số đo nào.

### 7.1. Timeline KHÔNG dựng lane/block trong khung xem trước — và cách chữa
`perf-runtime.js` nạp **sau** `editing-runtime.js` và thay `updateTimelineLayout` bằng một hàm
chỉ `markDirty('timelineGeometry'/'timelineVisual')`; lượt vẽ thật do **bộ lịch rAF** của nó
thực hiện. Khung xem trước của Claude Code báo `document.hidden === true` nên **`requestAnimationFrame`
KHÔNG BAO GIỜ chạy** → lane/block không dựng, mọi thao tác trên timeline không kiểm được.
**Cách chữa:** tắt cờ perf bằng query string, `perf-runtime.js` sẽ thoát sớm và
`updateTimelineLayout` trở lại bản vá của `editing-runtime` (vẽ đồng bộ):
```
http://localhost:17219/?perf_scheduler=0&virtualized_transcript=0&timeline_pointer_capture=0&pixi_viewport_culling=0&ruler_dom_overlay=0
```
Kiểm đã ăn: `updateTimelineLayout.name === 'patchedUpdateTimelineLayout'`.

### 7.2. Viewport 0×0 làm MỌI số đo layout sai theo hướng "sập"
Khung xem trước có lúc không được hiển thị → `window.innerWidth/innerHeight = 0`,
`document.body` 0×0. Khi đó `.edit-tab` đo ra 18px (thật là 30px),
`timelineTrackOuter.clientWidth = 0`, thước còn 2 tick, `.edit-tabs` cao 4px. Tôi đã tưởng là
hồi quy và truy khá lâu.
**Dấu hiệu:** `screenshot` báo *"the Browser pane is not displayed"*.
**Luôn kiểm `window.innerWidth` trước khi tin một con số layout**; gọi lại `resize_window` rồi
phát `resize` trước khi đo.

### 7.3. Sau MỌI lượt regex gom token, phải rà token tự tham chiếu
Lượt gom token ở Phase A thay cả bên trong khối `:root`, sinh ra
`--white-a08: var(--white-a08)`. Token thành vô hiệu → mọi rule dùng nó **không có nền**, im
lặng (hover nút icon lane, nền badge V1/A1, hover `.btn-ghost`). Lỗi này xảy ra **hai lần**
(lần đầu với `--primary-a*`, bắt được ngay; lần sau với `--white-a*`, lọt tới Phase B).
```bash
python3 -c "import re;s=open('index.html',encoding='utf-8').read();print(re.findall(r'--([a-z0-9-]+): var\(--\1\)',s) or 'OK')"
```
Kèm kiểm `getPropertyValue` của token vừa tạo trong trình duyệt.

### 7.4. CSS của `editing-runtime.js` nằm trong template literal
~1300 dòng CSS sống trong một chuỗi `` ` `` ở `injectStyle()`. **Chú thích không được chứa
backtick** — tôi từng viết `` `flex: 1 1 auto` `` trong comment và làm vỡ chuỗi. Luôn
`node --check static/js/editing-runtime.js` sau khi sửa.

### 7.5. Đường thêm asset từ tab Thư viện rất "phập phù"
Bấm thẻ rồi bấm `+` **có lúc không dựng lane** dù asset đã vào (`editingItems` có phần tử).
Đã đối chiếu với mã gốc bằng `git stash` — **hành vi y hệt, không phải hồi quy**. Khi cần block
thật để kiểm, hãy thử lại vài lần hoặc thêm bằng tab Văn bản / Hình học
(`[data-edit-add-shape="circle"]`).

### 7.6. Số đo contrast thô rất dễ sai
Hàm đo tự viết mà bỏ qua alpha sẽ coi `rgba(255,255,255,0.04)` là nền TRẮNG → báo sai hàng loạt
"contrast 1.09". Phải composite đúng alpha qua các lớp cha trước khi kết luận.

### 7.7. Trong flex column, mọi thanh/dải/header phải `flex-shrink: 0`
`.edit-tabs` thiếu nó nên bị co ~31px ở đúng hai tab có nội dung dài (Chuyển tiếp 2084px, LUT
1415px) — flexbox chia phần thiếu **theo tỉ lệ base size**. Lỗi chỉ lộ ở trang nội dung dài nên
lọt qua mọi lần kiểm bằng trang nội dung ngắn. `.ins-tabs`/`.ins-subtabs` đã phòng sẵn.

### 7.8. `margin-bottom` trong hàng flex `align-items:center` đẩy item LÊN
Không đặt margin thì `.kf-nav`/`.kf-diamond` thừa hưởng `margin-bottom: 10px` của selector
`button` thô, và bị đẩy **lên** 5px (nhô ra ngoài cạnh trên khung). Nút nào nằm trong hàng flex
mà thừa hưởng rule `button` thô đều cần `margin: 0`.

### 7.9. Zoom preview: đổi kích thước LAYOUT, không `transform: scale()`
Cả overlay, khung chọn, tay cầm mặt nạ và mọi phép kéo đều suy ra từ `frame.clientWidth`
(`previewScale = min(frameW/seqW, frameH/seqH)`). Đổi cỡ thật thì tất cả tự khớp.
`transform: scale()` thì `clientWidth` không đổi mà `getBoundingClientRect()` lại đổi → hai
đường số lệch, và `handleMaskDrag` (trộn toạ độ client với toạ độ cục bộ) **sai âm thầm**.

---

### 7.10. `document.hidden` đóng băng CẢ transition, không chỉ `requestAnimationFrame`
§7.1 đã ghi `rAF` không chạy khi khung xem trước báo `document.hidden === true`. **CSS
transition và animation cũng đứng im ở đó.** Hệ quả rất dễ đọc nhầm thành lỗi: thanh tiến độ
được đặt `style.width = '37%'` (kiểm được, `aria-valuenow` = 37) nhưng
`getBoundingClientRect().width` đọc ra **0px** vì transition `width` chưa nhích một bước nào.
**Đừng đo phần tử có `transition` bằng rect trong khung xem trước.** Đọc `element.style.<prop>`
trực tiếp, hoặc gọi `screenshot` trước (thao tác này đưa tab ra trước, transition chạy tiếp).
Cùng lý do, mọi hiệu ứng "vào" dựa trên `rAF` phải có `setTimeout` làm lưới an toàn — xem
`ui-feedback.js`.

### 7.11. Hai bẫy làm phép đo contrast BÁO ĐỘNG GIẢ
§7.6 đã nói phải composite đúng alpha. Còn hai bẫy nữa, cả hai đều cho ra "lỗi" không tồn tại:
1. **Gradient là background-IMAGE.** `getComputedStyle().backgroundColor` trả `rgba(0,0,0,0)`
   khi nền đặt bằng gradient — đúng cái đã làm bàn giao cũ ghi nhầm `.app-menu-dropdown` là
   "trong suốt hoàn toàn" (§3). Phải đọc `backgroundImage`, bóc các stop `rgba()` ra.
2. **`background-clip: text`.** Chữ "CrabbyCut" ở header dùng gradient LÀM CHỮ. Không loại ca
   này ra thì hàm đo coi nền là `rgb(220,227,235)` và báo contrast 1.19 — sai hoàn toàn.
Lọc xong hai bẫy này, số chỗ "dưới chuẩn" từ 12 rút còn 5, và 5 chỗ đó đều là lỗi THẬT.

### 7.12. `SettingsPanel.open()` là hàm ASYNC
Nó `await ensureLibrary(...)` trước khi `render()`. Gọi rồi kiểm ngay lập tức sẽ thấy panel
RỖNG (0 phần tử focus được) và tưởng là lỗi. Phải chờ một nhịp trước khi đo.

## 8. Quy trình kiểm sau mỗi phase

```bash
node backend/server.js          # hoặc preview_start name "crabbycut-ui", cổng 17219
```
Nếu cổng 17219 đang bị Electron của người dùng chiếm: **đừng dựng backend thứ hai** (backend ghi
`temp_uploads/`, `asr_cache/`, `progress.txt` — chạy song song là chồng lấn dữ liệu). Dùng
`python3 -m http.server <cổng khác>` để soi CSS, hoặc chờ.

1. `resize_window` 1440×900, kiểm `window.innerWidth !== 0` (§7.2).
2. Home → "Tạo dự án mới" → step4. Thêm clip từ tab **Thư viện → Video** (`library/Video/` có 6 mp4).
3. Đo trước–sau: số `font-size` < 11px, hit target < 28px, `.er-tick` > 0,
   `<use href="#...">` trỏ tới symbol có thật, ô tích `appearance: none`.
4. **Kiểm ràng buộc playhead** (§6) sau mỗi phase.
5. `read_console_messages onlyErrors` — chỉ được còn 404 `/api/editing-assets/main-source`
   (có sẵn ở dự án trống, không liên quan).
6. Kiểm với `prefers-reduced-motion: reduce` và Tab bằng bàn phím.
   Trợ năng (từ Phase E trở đi, chạy trong console):
   - `[...document.querySelectorAll('label[for]')].filter(l => !document.getElementById(l.htmlFor))` → rỗng
   - `[...document.querySelectorAll('[role=tab]')].filter(t => (t.getAttribute('aria-selected')==='true') !== t.classList.contains('is-active'))` → rỗng
   - nút chỉ-icon thiếu `aria-label` → 0 (script quét ở APP_INTERNALS Phase E)
   - `.timeline-track-outer` bề rộng thanh cuộn dọc vẫn **6px** (`offsetWidth - clientWidth`)
7. Cập nhật `docs/APP_STRUCTURE.md` (một dòng tổng quan) + `docs/APP_INTERNALS.md` (chi tiết,
   kèm bẫy đã gặp) — quy ước sẵn của dự án.

---

## 9. Việc còn dang dở khác

- **Chưa có ảnh chụp cho Phase C và các đợt sau đó.** Khung xem trước giữa phiên không dựng
  khung hình được (§7.2) nên tôi chỉ kiểm bằng computed style. **Cần bạn xem lại bằng mắt**:
  tay cầm của block ảnh/text/shape, tay cầm xoay, HUD khi kéo, và zoom Preview (Ctrl+lăn).
- **Nhánh block LANE CHÍNH của việc chọn nhiều block chưa kiểm được** — cần video ở lane chính,
  mà hộp thoại chọn tệp không lái được từ môi trường kiểm. Dùng chung helper với lane overlay
  nên rủi ro thấp, nhưng nó đi qua handler `click` chứ không phải `mousedown` → nên thử tay.
