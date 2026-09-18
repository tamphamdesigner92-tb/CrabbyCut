# CrabbyCut — Chi Tiết Kỹ Thuật (Internals)

> Chi tiết triển khai từng hệ thống (công thức FFmpeg, bẫy, lý do fix). Tổng quan & cây thư mục: [APP_STRUCTURE.md](APP_STRUCTURE.md).

## Kiến Trúc FFmpeg, Export Và Preview

### Proxy & Thumbnail Cho Asset Ảnh (2026-09-18, port từ nhánh v2.0.2)

Nguyên nhân giật nặng nhất từng đo được. Nó **không** nằm ở tầng giải mã video — đó là lý do cả
một đợt truy tìm trên nhánh này lẫn bốn lượt đo nền trên macOS đều đi qua mà không thấy.

#### Trạng thái cũ

Ảnh **không có bản thu nhỏ ở bất kỳ đâu**, trong khi video có ở cả hai chỗ:

| | Preview overlay | Thumbnail panel |
|---|---|---|
| Video | proxy 720p all-intra (`ensureAssetProxy`) | 320px (`createOrGetThumbnail`) |
| **Ảnh** | **file gốc** | **file gốc** |

Bốn chỗ: `assetProxyEligible()` đòi `assetIsVideo(asset)`; `editingAssetPayload` và
`libraryAssetPayload` **cùng** đặt `thumbnailUrl = publicUrl`; và `/api/library` tự dựng item
nên gán thẳng URL gốc cho ảnh.

#### Số đo trên dự án thật của người dùng

Đo qua đúng luồng `/api/editing-assets/link` (6 ảnh máy ảnh):

| File | px | RAM sau giải mã | Thumbnail |
|---|---|---|---|
| `_FOT1731.jpg` | 8256×5504 | **173,3 MB** | 320×213 = 0,26 MB |
| `2H6A0278.JPG` | 8192×5464 | 170,8 MB | 320×213 = 0,26 MB |
| `2H6A4878.JPG` | 8192×5464 | 170,8 MB | 320×213 = 0,26 MB |
| `DSCF4260.JPG` | 6240×3512 | 83,6 MB | 320×180 = 0,22 MB |
| `bcc0e61a…jpg` | 4096×2731 | 42,7 MB | 320×213 = 0,26 MB |
| `2H6A4836.jpg` | 1080×1350 | 5,6 MB | 256×320 = 0,31 MB |

**Panel: 647 MB → 1,6 MB RGBA (giảm 411 lần). Preview: 647 MB → 51 MB.**

#### Vì sao HUD không thấy gì

Công giải mã + raster ảnh nằm trên **luồng raster/compositor**, không phải luồng JS. Trên dự án
thật lúc **ĐANG DỪNG**: `TỔNG JS 1,7%`, `Long task 0`, mọi pha `0 lượt` — mà rớt **62,3%** khung
trong 10s và rAF tệ nhất **500,1 ms**. Sức ép bộ nhớ khiến Chromium thu hồi cả bộ đệm media.

#### Bản sửa

Hai tầng, dùng lại **nguyên** hạ tầng proxy video (hàng đợi một-job, ưu tiên tiến trình thấp,
cổng "đang phát", cache theo `sha1(path|size|mtime|ver)`):

- **thumbnail 320px**, KHÔNG điều kiện — thẻ panel chỉ rộng ~60px
- **proxy cạnh dài ≤1920** cho preview, đi qua đúng cơ chế LQ/HQ sẵn có

`asset.url`/`asset.path` **không đổi** nên bản xuất vẫn dùng ảnh gốc — test khoá riêng.

Hạ kích thước lúc chạy KHÔNG cứu được: `createImageBitmap` kèm `resizeWidth` vẫn tốn 114,8 ms so
với 102,2 ms, vì JPEG phải giải mã đủ rồi mới thu nhỏ. Bắt buộc phải là **file nhỏ sinh sẵn**.

#### Ba cái bẫy

1. **`force_original_aspect_ratio=decrease` VẪN PHÓNG TO.** `w=1920:h=1920` đưa ảnh 800×600 lên
   1920×1440 — `decrease` chỉ co hộp cho vừa tỉ lệ, nó không kẹp theo kích thước nguồn. Phải dùng
   `scale=w='min(iw,1920)':h='min(ih,1920)'`. Test bắt được.
2. **`.svg` phải loại khỏi đường proxy** (ffmpeg không giải mã SVG) → `RASTER_IMAGE_EXTENSIONS`
   riêng thay vì dùng `ALLOWED_IMAGE_EXTENSIONS`.
3. **`pruneAssetProxyCache` chỉ dọn `.mp4`.** Proxy ảnh ghi ra `.jpg` nên cache ảnh sẽ phình mãi
   mãi và rác `.part.jpg` không ai dọn — mà TTL vẫn chạy đều cho video nên nhìn bên ngoài mọi thứ
   vẫn có vẻ ổn. (Chỗ này nhánh v2.0.2 còn sót; bản port đã vá.)

Cổng an toàn: tách `resolveAllowedSourcePath(raw, extSet)` từ `resolveAudioSourcePath` để ảnh dùng
ĐÚNG MỘT bộ luật thư mục + whitelist. `editingAssetPayload` và `libraryAssetPayload` cùng đi qua
một helper `imageThumbnailUrlFor` — hai bản sao là hai bản sẽ lệch nhau.

**Còn lại:** `prewarmAssetProxiesForAssets` vẫn bỏ qua `media_image`, nên proxy preview của ảnh chỉ
dựng khi block xuống timeline chứ không dựng sẵn lúc liên kết thư mục. Thumbnail panel — phần chiếm
gần hết 647 MB — thì sinh ngay, nên đây chỉ là độ trễ nhỏ ở lần xem trước đầu tiên.

Test: `npm run test:image-proxy`.

### FFmpeg Runtime

```text
- Mọi lệnh FFmpeg nặng hiện nằm trong native/sidecar/core_process.cpp.
- backend/server.js chuẩn hoá request, ghi payload export_timeline.json, rồi gọi sidecar bằng command export-video.
- Payload export là `version: 3` khi chỉ có main timeline, hoặc `version: 4` khi có Editing overlays; gồm `sequence`, `settings`, `intervals`, `editingTracks`, `editingItems`, `assets`, và `overlays`. Mỗi interval main có thể mang `audio_volume` riêng, và `adj_filters` khi block có Điều chỉnh màu (xem mục "Điều Chỉnh Màu").
- backend/server.js gọi command preview-proxy sau khi ASR hoàn tất, chạy nền để không tranh tài nguyên với mlx_whisper.
- FFmpeg được gọi qua binary `ffmpeg`/`ffprobe` có trong PATH của hệ điều hành.
- WebM nguồn chính được backend normalize sang MP4 H.264/AAC tạm nếu concat copy không an toàn; WebM overlay được sidecar đưa trực tiếp vào FFmpeg như một input decode.
- Nguồn HDR (HLG `arib-std-b67` / PQ `smpte2084` / `bt2020`) KHÔNG bao giờ đi thẳng vào pipeline: nó được tonemap về BT.709 SDR ngay khi nhập (nguồn lane chính), khi trích thumbnail, và khi dựng asset overlay — xem mục "Nguồn HDR (HLG/PQ) hiện sáng cháy".
- Vì thế build FFmpeg phải có `libzimg` (filter `zscale`, đường tonemap dự bị và là đường duy nhất của thumbnail). `libplacebo` + Vulkan là tuỳ chọn: có thì tonemap nhanh gần 2× và sát CapCut hơn, không có thì tự quay về zscale.
```

### Editing Stage Và Multi-Lane Timeline

```text
- Giai đoạn Editing nằm sau Timeline và trước export vật lý.
- `latestTimeline` vẫn là nguồn sự thật cho main clip lane để giữ tương thích Auto-Reframe/export cũ.
- `static/js/editing-runtime.js` quản lý state Editing riêng:
  - `editingTracks[]`: id, type, name, order, locked, muted, visible, volume.
  - `editingItems[]`: id, type, track_id, timeline_start, duration, asset_id, source_start, muted, volume, transform, text, style.
  - `editingAssets[]`: metadata asset đã import/copy vào `temp_uploads/editing_assets`, gồm `thumbnail_url` cho block timeline khi có.
- Main lane `track_main` là mốc cố định, chứa các clip đã chọn từ Timeline và luôn hiển thị trong Editing.
- Visual lanes luôn nằm phía trên main lane:
  - Media lanes chứa ảnh/video, bao gồm WebM.
  - Text lanes chứa text overlay.
  - Shape lanes chứa object SVG nội bộ do app tạo, không phải file `.svg` import.
- Audio lanes luôn nằm phía dưới main lane.
- Mỗi loại lane có thể có nhiều lane: Media 1/2, Text 1/2, Shape 1/2, Audio 1/2...
- CHIỀU CAO LANE (`LANE_HEIGHTS`, px): main 86 · media 57 · text/shape/vector 40 · audio 48 · adjust 34.
  Lane media = 2/3 lane chính (đổi 2026-08-12, trước đó bằng nhau): lane chính là mạch
  chuyện, lane phủ chỉ là lớp chèn — cao bằng nhau thì mắt không phân được trục chính.
  KÉO THEO: block media overlay chỉ còn 45px (lane − 12), không đủ cho bố cục 3 tầng
  nhãn(28) · dải phim · sóng âm(22) của block lane chính — dải phim sẽ ra chiều cao ÂM.
  Vì vậy `.editing-item-block.editing-media-block .editing-thumb-strip` đè lại thành
  top/bottom 3px: dải phim phủ TRỌN block, nhãn (có nền mờ riêng) và sóng âm (canvas
  z21, trên block) nằm đè lên — cùng cách CapCut vẽ block video.
- Runtime không tạo sẵn lane rỗng; ngoài main lane, chỉ lane có item mới được render và gửi export.
- Người dùng có thể:
  - thêm media/text/shape/audio bằng toolbar Editing; runtime tự tạo lane hợp lệ nếu chưa có.
  - đổi tên lane bằng double-click tên lane.
  - kéo sắp xếp lane trong cùng group visual hoặc audio.
  - chọn nhiều block bằng Shift/Cmd/Ctrl-click hoặc nút chọn nhanh block bên trái/bên phải con trỏ trên timeline.
  - QUÉT CHUỘT (marquee) từ vùng trống của khu vực lane để chọn nhiều block xuyên lane — xem mục
    "Quét Chuột Chọn Nhiều Block".
  - dùng phím tắt `Option + [` / `Option + ]` để chọn nhanh các block bên trái/bên phải con trỏ.
  - dùng Razor trên main clip hoặc overlay/audio/text/shape item để split block đang nằm dưới dao cắt.
  - kéo hoặc resize block overlay có snap cạnh-với-cạnh vào block cùng lane hoặc playhead khi Snap bật.
  - block lane CHÍNH: trim 2 mép cũng bắt dính playhead (mốc quy về giờ NGUỒN — xem snapMainSourceEdge).
  - kéo 2 đầu block trên LANE CHÍNH để đổi vùng nguồn (ripple) và kéo thân block để đổi thứ tự — xem
    mục "Lane Chính Ở Editing".
  - giữ `Alt` + kéo một block bất kỳ để NHÂN BẢN nó sang vị trí/lane khác — xem mục "Lane Chính Ở Editing".
  - giữ `Alt` + kéo block LANE CHÍNH LÊN khu vực overlay để SAO CHÉP nó thành block media overlay —
    xem mục "Sao Chép Block Lane Chính Lên Lane Overlay".
  - kéo CẢ NHÓM block đang chọn sang lane khác khi nhóm cùng loại + cùng lane — xem mục
    "Kéo Cả Nhóm Sang Lane Khác".
- Runtime không cho visual lane đi xuống dưới main lane và không cho audio lane đi lên trên main lane.
- Khi kéo item sang lane không đúng loại, item giữ lane hợp lệ hiện tại; item mới import luôn được đưa vào lane hợp lệ hoặc tạo lane phù hợp.
- UI timeline Editing theo kiểu CapCut:
  - media/main video lane cao hơn text/shape/audio lane.
  - main/media block hiển thị label và thumbnail strip; block có audio vẽ SÓNG ÂM THẬT từ file .pk (xem mục "Sóng Âm Thật").
  - text block dùng màu cam sẫm, shape block màu vàng/cam, audio block màu xanh với nhãn ở trên và sóng âm ở dưới.
  - rail trái mỗi lane có icon loại dữ liệu, khóa, mắt với visual lanes, âm thanh với media/audio lane, và menu dots.
- `locked=true` chặn kéo/resize/sửa item của lane; `visible=false` bỏ visual overlay khỏi preview/export; `muted=true` tắt audio overlay trong preview/export.
- Chọn main clip hoặc Editing item đều cập nhật inspector:
  - transform chung: position_x, position_y, scale, rotation, opacity.
  - main/media/audio có volume dB trong UI; model/export lưu linear percent, với 0 dB = 100%.
  - media/audio có muted.
  - text có nội dung, font Google offline, font size, màu và căn lề.
  - shape có loại hình, kích thước box, fill, stroke, stroke width, corner radius, polygon sides và star points.
- Preview Editing hiển thị selection box cho visual item đang chọn khi playhead nằm trong block; handles trên preview chỉnh scale đều/rotation, text width và corner radius cho shape hỗ trợ. Hover lên box không tự chuyển sang drag; chỉ khi giữ chuột và kéo vượt ngưỡng nhỏ thì object mới vào move mode. Riêng shape có edge handles để kéo giãn width/height theo từng cạnh; giữ Shift khi kéo cạnh sẽ resize đối xứng qua tâm. Shape corner widgets bám theo đỉnh hình học kiểu live-corner: kéo widget vào tâm object làm radius tăng, kéo ra xa tâm làm radius giảm, và vị trí widget tự dịch sâu hơn vào shape khi radius lớn hơn. Star tách outer/inner corner widgets; inspector của Text/Shape ẩn timing controls để giảm nhiễu.
- Text overlay dùng bộ font Google được bundle trong `static/fonts/google`: Inter, Roboto, Be Vietnam Pro, Noto Sans, Noto Serif, Montserrat, Oswald, Merriweather, Lora. Preview text và selection box đo kích thước bằng canvas metrics để box tự bao trọn nội dung text, kể cả khi font lớn hoặc chữ có dấu.
- Multi-select chỉ batch-edit qua inspector trong phiên bản này; field nào được chỉnh thì chỉ field đó được ghi đồng loạt vào các block đang chọn.
- Undo/redo lưu cả state Editing (`editingTracks`, `editingItems`, `editingAssets`, selection) để thao tác thêm/xoá/kéo/cắt overlay có thể hoàn tác/làm lại.
- Main clip volume được lưu độc lập trên từng clip trong `latestTimeline[].audio_volume`; main lane mute hiện chỉ áp dụng preview Editing.
- Preview video có nút chọn chất lượng LQ/HQ: LQ dùng proxy nhẹ khi có, HQ dùng video gốc `temp_input.mp4`.
```

### Hoạt Ảnh In/Out Cho Text (Text Animations)

```text
- Engine: `static/js/text-animations.js` (module thuần, UMD, nạp trước editing-runtime.js) — `window.TextAnimations`.
  - 8 hiệu ứng: fade, slide_up/down/left/right, scale, pop, typewriter; 4 easing closed-form: linear, ease-in-out, spring (overshoot ~11%), bounce (Penner).
  - Data model: `item.animation = {in:{type,duration(0.2–2s),delay(0–1s),easing}, out:{...}}`; field vắng = không animation (tương thích ngược, history/undo tự mang theo).
  - `resolveWindows(item)` là nguồn chân lý về cửa sổ thời gian (item ẨN trước inDelay/sau D-outDelay; tự co duration khi item ngắn) — preview và export cùng dùng nên không lệch nhau.
  - `animationStateAt(item, localTime, metrics)` (hàm thuần) -> `{opacityMul, dx, dy, scaleMul, charFrac, hidden}`.
- Preview: `renderPreviewOverlays` áp state lên DOM overlay (opacity/transform qua `transformCssForPreview(transform, extra)`, typewriter cắt textContent); write-cache `el.__lastPreviewStyles` chỉ ghi style khi đổi; `will-change: transform, opacity`; rAF loop sẵn có chạy khi playback, scrub/pause vẫn đúng state. Nút "▶ Xem thử" (`playItemAnimationPreview`) chạy rAF session riêng: phát In rồi nhảy sang Out, bỏ đoạn hold.
- **`.editing-preview-item` LÀ LỚP HỢP THÀNH, KHÔNG PHẢI PHẦN TỬ GIAO DIỆN** (sửa 2026-09-09).
  Hộp của nó = `itemBaseSize(item, asset)` × `previewScale` (tức khổ THẬT của asset), cộng
  `object-fit: contain`. Vì thế MỌI luật CSS chung cho thẻ `video`/`img` trong index.html đều
  là một nguồn "preview khác bản render", và index.html phải loại lớp này ra bằng
  `:not(.editing-preview-item):not(.editing-preview-src)` — có `tests/scripts/preview_overlay_css_contract.js`
  canh việc đó.
  LỖI ĐÃ TRẢ GIÁ: `video:not(#previewVideo) { max-width:100%; max-height:100%; background:#000;
  border-radius:var(--r-md); box-shadow:var(--sh-3) }` khớp luôn overlay. `.editing-preview-item`
  ĐÃ khai `max-width/max-height: none` nhưng KHÔNG THẮNG vì `:not(#previewVideo)` mang trọng số
  của một ID → `video:not(#previewVideo)` là **(1,0,1)** còn `.editing-preview-item` chỉ **(0,1,0)**.
  Đo trong Chromium (sequence 1728×3072, overlay 6.mp4 1920×1080 @100%):
  `el.style.width = 208.889px` → `getComputedStyle().width = 188px` (đúng bề rộng khung preview),
  tỉ lệ hộp 1.6000 vs tỉ lệ video 1.7778 → `object-fit: contain` letterbox → `background:#000`
  của chính luật đó tô đen phần lệch. Người dùng thấy "khung transform không fit kích thước
  video, có nền đen"; bản render đúng vì ffmpeg không có `max-width` nào.
  Chỉ lộ khi asset RỘNG hơn sequence (1920 > 1728) hoặc CAO hơn (do `max-height`). Item CÓ
  chỉnh màu thì KHÔNG lộ, vì đường đó thay `<video>` bằng `<canvas>` — luật kia chỉ nhắm `video`.
  ⚠️ CSS của editing-runtime.js nằm trong một TEMPLATE LITERAL: **không dùng dấu backtick trong
  chú thích của khối đó** — nó đóng chuỗi giữa đường và cả tệp chết ở runtime
  ("ReferenceError: preview is not defined"). `node --check` không bắt được ca này.
- **SPRITE LANE CHÍNH CHỈ VẼ VÙNG ẢNH THẬT** (sửa 2026-09-10). Khung file nối là KHUNG BAO của
  mọi nguồn, nên nguồn khác khổ có VIỀN ĐEN NẰM TRONG KHUNG HÌNH. Trước đây sprite lấy CẢ khung
  nối làm texture → viền đó được vẽ ra như pixel thật, trong khi `mainClipBaseSize` (khung
  transform) chỉ bằng content × fit → khung transform nhỏ hơn sprite.
  Đo trên dự án người dùng (sequence 1728×3072, khung nối 1920×3072, `6.mp4` content
  `{x:0,y:996,w:1920,h:1080}`, fit = 0.9): sprite 1728×2764.8 nhưng ảnh thật chỉ 972 cao →
  **viền đen 896.4px trên + dưới, nằm TRONG sprite**.
  Nay `mainCropRect` + `croppedSpriteTexture` bọc baseTexture bằng KHUNG CON = content rect
  (`new PIXI.Texture(baseTexture, frame)` — không chép pixel, không thêm lượt vẽ), áp cho CẢ
  hai đường texture: video thô và canvas trung gian (`fxTexture`, đường retouch/màu nhiều lượt).
  `mainDisplayScale` KHÔNG đổi: hệ số của nó là "pixel texture → pixel preview", không phụ
  thuộc việc vẽ cả khung hay một khung con. Kết quả đo trong Chromium sau khi sửa:
  `spriteExtent` == `mainClipBaseSize × previewScale` **khít tuyệt đối** (188.00×105.75 cho
  `6.mp4`; 188.00×334.22 cho DJI), và pixel ngoài dải ảnh là nền sequence chứ không còn đen.
  Ba nơi phụ thuộc phải đi kèm, nếu không là lệch âm thầm:
  · `sourceMap` thêm `texX/texY` (gốc vùng ảnh trong texture) + `texFullW/H`. `texW/texH` nay
    là cỡ VÙNG ẢNH. `pickPreviewSourceColor` đọc pixel TRỰC TIẾP từ thẻ `<video>` (cả khung)
    nên phải cộng `texX/texY` — thiếu là hút màu lệch đúng 996px, tức lấy màu viền đen.
  · `syncSpriteMask` nhận cỡ ĐÃ CẮT: mặt nạ cỡ khung nối sẽ trùm ra ngoài hình đúng bằng viền.
  · `skeletonSpriteMapper` dùng `texFullW/H` + `texX/texY`: landmark của `/api/pose/track`
    chuẩn hoá theo CẢ khung nối (nó phân tích `temp_input.mp4`), không theo vùng ảnh.
  ⚠️ Vùng trống còn lại là NỀN SEQUENCE. `isSequenceTransparencyWarningEnabled()` bật CỐ ĐỊNH ở
  FINAL + step3/step4 khi có block (KHÔNG có công tắc tắt), nên vùng đó hiện màu
  `SEQUENCE_TRANSPARENCY_WARNING_COLOR` = `0x0AD500` chứ không phải đen — trong khi bản xuất
  composite lên nền ĐEN. Premiere/CapCut đều hiện đen ở vùng không được phủ.
- Inspector: section "Hoạt ảnh" dựng bằng `buildAnimSectionHtml` (DÙNG CHUNG cho overlay và clip lane chính — `syncOverlayInspector` từng có bản sao riêng, hai bản lệch nhau mỗi lần sửa nên đã gộp) — 3 nhóm Vào (In)/Ra (Out)/Kết hợp: LƯỚI THUMBNAIL ĐỘNG chọn hiệu ứng (xem mục Hoạt Ảnh Mở Rộng), slider Thời lượng, select Easing; control disable khi type='none' qua `data-anim-disabled` (được tôn trọng khi sync trạng thái khoá track). Wiring qua `updateEditingInspectorField` (regex `editingAnim(In|Out)(Type|Duration|Delay|Easing)`), đổi hiệu ứng auto phát thử.
- Magic Fill: box tạo ra tự gán `defaultMagicFillAnimation()` = Pop in 0.4s (spring) / Fade out 0.4s (ease-in-out).
- Export (pre-render phía client, video xuất GIỐNG HỆT preview):
  1. `exportPayload({fps})` (index.html tính fps hiệu dụng từ `#exportFps`/`source_fps` hữu tỉ): item text có animation được render chuỗi frame PNG trong suốt cho từng cửa sổ In/Out (`renderTextAnimationWindow`, 2–121 frame, canvas nở ĐỐI XỨNG chứa overshoot; non-typewriter rasterize 1 lần rồi drawImage mỗi frame; typewriter vẽ `drawTextItemContent` với charLimit — glyph đứng đúng vị trí cuối, không reflow) -> `item.animation_render {fps, hold_start, hold_end, in, out}`; payload version 5.
  2. Backend `server.js`: multer `fieldSize` 256MB (mặc định 1MB sẽ chết với editing_json chứa frame base64); `materializeAnimationFrames` ghi `anim_<id>_<idx>_<side>_<hash>/frame_%04d.png` (cap 130 frame, 12MB/frame); `normalizeEditingPayload` tách item animated thành tối đa 3 overlay In(`text_image_seq`)/Hold(`text_image`)/Out cùng transform, `index` overlay là bộ đếm riêng (nhãn filter ffmpeg phải duy nhất); lỗi materialize -> fallback 1 overlay tĩnh.
  3. Sidecar `core_process.cpp`: `OverlayIsImageSequence` (asset_type `text_image_seq`), input `-framerate <seq_fps> -start_number 0`, filter bỏ `trim=` cho sequence; overlay căn tâm `(W-w)/2+posX` nên 3 đoạn trùng khít; rebuild bằng `npm run build:sidecar`.
- Chống giật trong video xuất (các quy tắc BẮT BUỘC giữ, sửa 20260716):
  - Sequence overlay dùng `eof_action=repeat` (overlay khác giữ `pass`): nếu pass, text biến mất đúng 1 frame tại ranh giới sequence->hold gây "nháy" ở mọi textbox có animation.
  - Backend snap mốc các đoạn In/Hold/Out vào lưới frame render (`snapT = round(t*renderFps)/renderFps` trong `normalizeEditingPayload`, render_fps parse qua `parseFpsValue` kể cả dạng "a/b") — 2 đoạn kề snap từ cùng giá trị biên nên luôn liền khít.
  - Encoder ép CFR: `-r <renderFps> -fps_mode cfr` trong `AppendEncoderArgs`; nguồn trim thêm `fps=<renderFps>` trong `WriteClipVideoFilters` (nguồn VFR/lệch fps sẽ lặp/bỏ frame không đều).
  - Engine: hiệu ứng THUẦN opacity (`fade`, `typewriter`) tự thay easing spring/bounce bằng ease-in-out (`effectiveEasing` + `OPACITY_ONLY_EFFECTS`) — overshoot bị kẹp trần opacity làm hiệu ứng kết thúc trong ~20% thời lượng rồi đứng im. Spring/bounce giữ nguyên cho slide/scale/pop.
  - Riêng cửa sổ OUT (sửa 20260716): frame bake sample CUỐI khoảng hiển thị (`sampleBias=1` trong `renderTextAnimationWindow`) thay vì giữa khoảng — frame cuối = easing(0) = ẨN HOÀN TOÀN; nếu không, với spring/bounce (phần dốc nằm cuối cửa sổ Out do easing đảo ngược) frame cuối còn ~30% hiển thị rồi bị cắt về 0 -> giật lúc biến mất. Sidecar trừ NỬA FRAME khỏi mốc cuối `enable` của sequence (`seqEndTrim`) — between() bao gồm 2 đầu + eof_action=repeat sẽ vẽ lặp frame cuối thêm 1 frame "bóng ma" tại ranh giới; ở In->Hold bị Hold che nên chỉ Out lộ.
  - Tham số Trễ (delay) đã loại bỏ (normalizeSide ép delay=0, item cũ có delay tự về 0; UI không còn slider Trễ).
  - Ràng buộc kiểu CapCut/Premiere: (thời lượng In) + (thời lượng Out) ≤ thời lượng item — `TextAnimations.maxSideDuration(item, side)` là trần động của slider Thời lượng (trần phía còn lại tự co giãn khi kéo), handler kẹp giá trị, `resolveWindows` vẫn co theo tỉ lệ làm chốt chặn khi item bị trim ngắn sau đó.
```

### Hoạt Ảnh In/Out/Combo Mở Rộng (Shape/Ảnh/Video/Clip Chính)

```text
- Engine text-animations.js dùng CHUNG cho mọi loại đối tượng; itemSupportsAnimation() (editing-runtime.js) là cổng quyết định loại nào có tab "Hiệu ứng động".
- Áp cho: TEXT + SHAPE + ẢNH (media image) + VIDEO overlay + CLIP LANE CHÍNH (latestTimeline[].animation). Inspector dùng chung buildAnimSectionHtml (Vào/Ra/Kết hợp).
- Combo = preset ghi ĐỒNG THỜI in+out (applyCombo/matchCombo chia thời lượng theo tỉ lệ); engine lõi chỉ thấy in/out.
- 13 hiệu ứng (EFFECT_OPTIONS): fade, slide_up/down/left/right, scale, zoom_out, pop, rotate, spin, flip, drift, typewriter (typewriter chỉ có nghĩa với text). 7 easing (EASING_OPTIONS). State: {opacityMul, dx, dy, scaleX, scaleY, rotate, charFrac}.
- MỘT BẢNG HỆ SỐ, HAI ĐẦU RA (`EFFECT_SPECS`, sửa 20260814): mọi hiệu ứng đều AFFINE theo
  visibility v, nên chúng được KHAI BÁO bằng hệ số {op, dx, dy, s|sx|sy, rot} thay vì viết
  tay thành hàm. `makeEffectFn` sinh ra hàm (v, metrics)->state cho preview/bake PNG, còn
  `videoAnimationExpr` đọc CHÍNH bảng đó để sinh biểu thức FFmpeg cho video. Trước đây hai
  đường có hai bảng riêng (`EFFECTS` viết tay + `videoAmp` chỉ biết dịch chuyển) — đó là lý
  do video từng phải chặn bớt hiệu ứng. Thêm/sửa hiệu ứng giờ chỉ đụng một chỗ.
  (typewriter vẫn khai riêng: nó cắt theo số ký tự, không affine cùng khuôn.)
- CHỌN HIỆU ỨNG = LƯỚI THUMBNAIL ĐỘNG (kiểu CapCut), không phải <select> (đọc tên "Pop"/"Trôi nhẹ" thì không hình dung được hiệu ứng chạy ra sao):
  - Vẽ ô: TextAnimations.drawThumb(canvas, spec, p, {glyph}) — spec={side:'in'|'out'|'combo', type, easing}, p=tiến độ chu kỳ (bỏ trống = khung tĩnh), glyph='text' (tile "Aa") | 'media' (tile khung hình). Ô chạy CHÍNH animationStateAt() với pseudo-item ngắn ([vào][giữ] / [giữ][ra] / [vào][giữ][ra]) và thứ tự translate→rotate→scale KHỚP preview -> ô xem trước không bao giờ lệch với video thật.
  - Khung TĨNH lấy theo VISIBILITY ≈ 0.45 (THUMB_STATIC_VIS, quét 32 mẫu vì spring/bounce không đơn điệu), KHÔNG theo % thời gian: 'ease-out' đi hết 94% quãng đường ở mốc 60% thời gian nên lấy theo thời gian thì cả lưới đóng băng ở trạng thái nghỉ, nhìn giống hệt nhau. Ô tĩnh nào đã có dấu hiệu HÌNH HỌC thì nâng opacity ≥ 0.85 (độ mờ là thông tin thừa, để nguyên thì cả lưới xám như bị vô hiệu hoá); riêng 'Mờ dần' giữ nguyên vì opacity là dấu hiệu duy nhất của nó. Ô 'Không' vẽ tile mờ 0.4 + huy hiệu ⊘.
  - UI: animEffectGridHtml() dựng lưới + MỘT <select> ẩn (.anim-fx-select) GIỮ NGUYÊN id cũ editingAnim{In,Out}Type / editingAnimComboType. Bấm ô -> ghi value vào select ẩn rồi dispatch 'change' -> đi lại NGUYÊN VẸN nhánh cũ trong updateEditingInspectorField (ghi dữ liệu, phát thử, kẹp thời lượng); select ẩn cũng là chỗ vòng disable chung của Inspector đánh dấu trạng thái khoá lane (syncAnimGridLocked làm mờ lưới theo).
  - Hover: initAnimThumbs(root) vẽ khung tĩnh cho mọi ô + gắn mouseenter/mouseleave chạy rAF (một vòng tại một thời điểm; rời chuột là vẽ lại khung tĩnh). Gọi ở CUỐI syncOverlayInspector và syncMainAudioInspector — Inspector dựng lại từ chuỗi HTML mỗi lần làm mới, cờ __animThumbBound chặn gắn trùng. Đổi Easing -> panel dựng lại -> ô minh hoạ chạy đúng easing mới.
  - Kiểm tay: tests/manual/anim_thumb_preview.html (mở qua backend) — xem cả thư viện cạnh nhau khi chỉnh dáng ô.
- Export theo loại:
  - Text/shape/ảnh: bake chuỗi PNG per-frame DÙNG CHUNG renderAnimationSequence(...,drawInto) — wrapper chỉ khác drawInto (chữ / SVG-raster / ảnh asset) -> item.animation_render{fps, seq}.
  - VIDEO overlay + clip lane chính: KHÔNG bake PNG được -> videoAnimationExpr() sinh biểu
    thức FFmpeg theo thời gian (ffEase khớp EASINGS bằng exp/sin/cos). TỪ 20260814 phủ ĐỦ
    thư viện hiệu ứng như ảnh (`VIDEO_SUPPORTED_EFFECTS` = tất cả trừ typewriter) nhờ gửi
    thêm 3 kênh HÌNH HỌC, đi đúng đường mà keyframe đã dùng trong sidecar:
      · opacity  : filter `fade` alpha (như cũ)
      · dịch     : overlay x/y = biểu thức(t)          -> anim_x_expr / anim_y_expr
      · thu phóng: scale w/h = biểu thức(t) + eval=frame -> anim_sx_expr / anim_sy_expr
      · xoay     : rotate a = biểu thức(t)             -> anim_rot_expr
    Ba kênh scale/xoay là TUỲ CHỌN — chỉ hiệu ứng thực sự phóng/xoay mới gửi. Cố ý: filter
    `rotate` + `scale=eval=frame` chạy MỌI khung của cả block (không chỉ trong cửa sổ In/Out)
    và rotate còn nở canvas ra hình vuông theo đường chéo, nên mờ/trượt phải giữ được đường
    xuất rẻ như trước.
  - Sidecar `AppendKfTransformFilters` phục vụ CẢ keyframe lẫn hoạt ảnh, và hai nguồn CHỒNG
    lên nhau chứ không loại trừ (khớp preview: keyframe cho transform hiệu dụng, hoạt ảnh áp
    delta lên trên): kf* THAY THẾ giá trị tĩnh, anim* là HỆ SỐ NHÂN (scale) và SỐ CỘNG (xoay).
    Cờ gộp `clipDynTransform` / `overlayDynTransform` quyết định đi nhánh biến đổi theo thời
    gian — nó cũng là chỗ BỎ bước scale tĩnh trước `format=rgba`, quên là scale hai lần.
  - Hai trục scale TÁCH nhau vì có hiệu ứng không đẳng hướng (flip chỉ co trục X). Hệ quả đã
    biết, giống hệt nhánh keyframe: khi có ĐỒNG THỜI xoay và scale không đẳng hướng thì thứ tự
    (ffmpeg xoay pixel rồi mới scale canvas / preview scale trong hệ toạ độ cục bộ rồi xoay)
    không tương đương — thực tế không gặp vì flip là hiệu ứng duy nhất không đẳng hướng và nó
    không xoay.
  - `fade` chạy alpha TUYẾN TÍNH theo thời gian, còn engine dùng min(1, op·v). Với op > 1
    (pop/spin/flip) thời lượng cửa trập được chia cho op (`fadeSpan`) để hai bên khớp MỐC
    đầy/cạn; nếu để nguyên, pop trên video mờ suốt cả cú phóng — khác preview và khác hẳn
    cùng hiệu ứng đó trên block ảnh. Cửa trập Out co về CUỐI cửa sổ Out (out_start = outEnd −
    span) để vẫn cạn đúng lúc block kết thúc. Với op = 1 (fade/slide/scale/...) giá trị y
    nguyên như trước bản sửa.
  - Test `npm run test:video-anim` (tests/scripts/video_animation_expr.js): tự nội suy biểu
    thức FFmpeg trong Node rồi so từng mốc với animationStateAt (12 hiệu ứng × 7 easing,
    ~25.6k phép so), chốt kênh tuỳ chọn chỉ gửi khi cần, rồi RENDER THẬT qua sidecar và đo
    hộp bao phần không đen — thu phóng (co giữa cửa sổ, phủ kín ở đoạn giữ) và xoay (nguồn
    ngang xoay −90° phải thành hộp dọc), cho cả lane chính lẫn overlay. Sai số duy nhất còn
    lại là hằng số 'bounce' viết rút gọn trong ffEase (~5e-5 tương đối).
- Preview clip lane chính: áp lên PixiJS sprite trong resizeAndRender. Fix quan trọng: sprite lane main chỉ vẽ lại qua updateSequencePreviewTransform (khi phát chỉ chạy theo 'timeupdate' ~4Hz -> hoạt ảnh clip main bị kẹt frame đầu, mất hình khi play). Khắc phục: vòng lặp 60fps startOverlayPreviewLoop (editing-runtime.js) nay gọi updateSequencePreviewTransform (đã bao renderPreviewOverlays) thay vì chỉ renderPreviewOverlays -> cập nhật cả sprite lane main lẫn overlay lane phụ mỗi frame.
```

### Mẫu Văn Bản (Text Template, kiểu CapCut)

```text
- Engine: `static/js/text-templates.js` (module thuần UMD, nạp TRƯỚC editing-runtime.js) — `window.TextTemplates`.
  Panel: tab "Văn bản" -> sub-tab "Mẫu văn bản" (`EDIT_PANEL_SUBTABS.text`, state `editPanelTextSub`).
- VÌ SAO KHÔNG DÙNG ĐƯỢC TEXTBOX + ENGINE HOẠT ẢNH SẴN CÓ: một text template là CẢNH NHỎ
  nhiều lớp (1..n lớp chữ nhập được + 0..n lớp trang trí), MỖI LỚP có đường thời gian
  riêng và có lớp lặp vô hạn. `text-animations.js` áp MỘT trạng thái cho MỘT item nên
  không diễn đạt được "chữ zoom vào 0.5s còn dấu tích nảy lặp mỗi 0.8s".
- KHÔNG THÊM item.type MỚI. Mẫu là item `type:'text'` mang thêm
  `item.template = { id, texts:[…], px_scale, overrides:{…} }`. Nhờ vậy timeline/chọn/kéo/xoay/keyframe/
  chuyển cảnh/guard `type==='text'` của backend/ghi-đọc .crab dùng lại NGUYÊN VẸN — thêm
  một type mới thì phải rà lại từng chỗ đó và chỗ bỏ sót sẽ hỏng âm thầm ở khâu xuất.
  `itemIsTextTemplate(item)` là cổng duy nhất; `item.text` chỉ là GƯƠNG của các ô chữ
  (nhãn block trên timeline), nguồn sự thật là `item.template.texts`.
- BỐN chỗ rẽ nhánh trong editing-runtime.js, không hơn:
  1. `measureTextItemBox` -> hộp = hợp các lớp của mẫu (`textTemplateLayout`), kèm
     `marginX/marginY` riêng trục và `templateLayout` để hàm vẽ dùng lại.
  2. `drawTextItemContent` -> gọi `TextTemplates.drawFrame(…, opts.localT)`.
  3. Preview: phần tử là `<canvas>` (`paintTextTemplateCanvas`) thay vì `<div>` chữ CSS.
  4. Export: `renderTextTemplateSequence` bake chuỗi khung phủ TRỌN block ->
     `animation_render{fps, seq}`; KHÔNG đi qua `attachAnim` (đó là cửa sổ In/Out của
     engine kia). `itemSupportsAnimation()` trả false cho mẫu nên tab "Hiệu ứng động"
     không hiện — thà không có còn hơn có mà bản xuất không mang theo.
- Mô hình dữ liệu của mẫu (khai báo trong TEMPLATES): layers[] với `place:'flow'` (xếp dọc
  thành "hộp chữ") hoặc `place:{fx,fy,lx,ly,dx,dy}` (neo tương đối vào hộp chữ đó);
  `anim:{delay, period, window:[a,b], tracks:{opacity,scale,dx,dy,rot}}` — track là
  [[t,v],…] nội suy tuyến tính, `period>0` = lặp, `window` = chỉ hiện trong khoảng đó của
  mỗi chu kỳ. Hình trang trí vẽ bằng ĐƯỜNG VECTOR trong `GLYPHS` (không dùng file ảnh:
  phải nét căng ở 4K và bake được ra PNG mà không cần tải thêm tài nguyên).
- HOẠT ẢNH THEO TỪNG KÝ TỰ (`anim.perChar:{stagger}` trên lớp chữ — mẫu "Correct 1"):
  mọi ký tự chạy CÙNG một `tracks`, chỉ lệch pha `stagger` giây một chữ. Không phải n lớp
  riêng: người dùng gõ chuỗi dài ngắn tuỳ ý mà hiệu ứng vẫn đúng, không phải khai lại mẫu.
  Bốn chỗ phải biết tới nó, bỏ sót chỗ nào là hỏng âm thầm:
  1. `layerStateAt` trả ĐỨNG YÊN (chỉ ẩn trước `delay`) — áp `tracks` ở mức lớp nữa là
     nhân đôi hiệu ứng: cả khối trôi trong khi từng chữ cũng trôi.
  2. `measureTextLayer` đo thêm `chars[]` (advance + hộp mực từng ký tự, đo bằng CHÍNH ctx
     đang set letterSpacing — tự cộng khe chữ bằng tay sẽ lệch dần về cuối dòng); vẽ đi
     qua `paintRun` dùng chung cho cả hai chế độ nên bật perChar không làm mất viền/bóng.
  3. `frameSignature` phải kể tới TỪNG ký tự (và do đó nhận thêm `texts`) — lúc chữ thứ 5
     đang rơi thì trạng thái mức-lớp vẫn là "đứng yên", bỏ sót là khâu xuất đẩy `null`
     (lặp khung trước) đúng lúc chữ đang chạy và bản xuất đứng hình.
  4. `settleTime` lấy mốc ký tự CUỐI xong (`delay + (n−1)·stagger + keyframe cuối`), không
     phải ký tự đầu — chênh 0.4s ở "Correct 1", đủ để thumbnail chụp trúng lúc nửa chữ
     đang rơi.
  Nền bo góc là của LỚP chứ không của ký tự nào: nó đứng yên, chỉ mượn độ mờ của ký tự
  ĐẦU TIÊN để hiện ra cùng lúc với chữ đầu.
- Mốc thời gian so sánh với video luôn cộng dồn số thực (`delay + i·stagger`) nên lệch cỡ
  1e-17 so với `k/fps` mà caller tính bằng phép chia; `stateFromAnim` nới 1ns ở mốc 0,
  nếu không đúng khung đầu của mỗi ký tự bị coi là "chưa tới" và chữ nhấp một khung.
- MÉP CẮT CỐ ĐỊNH (`layer.clip = { x0 }`, px@1080 so với gốc HỘP LỚP — mẫu "Incorrect" /
  "Incorrect 2"): phần bên trái x0 không bao giờ được vẽ. Dùng cho hiệu ứng "chữ chui ra
  từ sau biểu tượng": chữ trượt vào từ −595px mà không thò ra bên trái biểu tượng.
  Hai chỗ phải biết tới nó:
  1. `drawFrame` đặt clip TRƯỚC phép biến đổi của lớp — mép đứng yên, nội dung trượt qua
     nó. Đặt sau `translate` thì mép trôi theo chữ và không cắt gì cả.
  2. `layout` kẹp mép trái của lớp vào x0 khi tính lề. Bỏ qua thì lớp trượt −595px đòi lề
     bằng cả nửa khung hình -> canvas phình mấy lần và khâu xuất bake 90 khung PNG cỡ đó.
     Nhân tiện phép tính lề được viết lại cho ĐÚNG thay vì an toàn: lấy mép thật của lớp ở
     từng trạng thái (tâm đã dịch theo dx/dy) thay vì cộng |dx| vào nửa bề rộng rồi đo
     quanh tâm tĩnh — cách cũ nở đều hai phía nên một lớp chỉ trượt sang trái vẫn đòi lề
     bên phải bằng chừng ấy. Với dx=0 hai cách cho kết quả y hệt.
- KÊNH `reveal` (0..1, mặc định 1) là kênh track thứ sáu, truyền vào tham số thứ tư của
  `GLYPHS[].draw`. Khác opacity/scale ở chỗ nó KHÔNG phải phép biến đổi: hình tự quyết
  định "vẽ được bao nhiêu" (dấu X của "Incorrect" mọc dần từ hai đầu trên xuống). Để ở
  đây thay vì tách thành một lớp riêng vì nó thuộc THIẾT KẾ của hình, không phải một lớp
  người dùng thấy — tách ra thì panel Thuộc tính sẽ mọc thêm một mục vô nghĩa.
  `stateIsRest` và `frameSignature` đều phải kể tới nó, nếu không khâu xuất gộp khung
  ngay giữa lúc hình đang tự vẽ và bản xuất mất luôn đoạn đó.
  CÁCH PHÂN BIỆT "tự vẽ" với "bị mặt nạ quét qua" khi đo video: nhìn ĐẦU NÉT đang lớn
  dần — tự vẽ thì đầu nét luôn TRÒN (lát cắt thu nhỏ dần 22,20,18,16,14,8), mặt nạ ngang
  thì cắt PHẲNG. Hai cách giống hệt nhau ở giữa chừng, chỉ khác ở hai đầu.
  DÙNG THỨ HAI CỦA `reveal` (nét nhấn của "Folgen Sie"): nó là THAM SỐ THIẾT KẾ 0..1 nói
  chung, không chỉ "vẽ tới đâu" — ở đây 0/1 = hai trạng thái của nhịp đập, mỗi nét trượt ra
  xa dọc TRỤC CỦA CHÍNH NÓ. Phải đi qua kênh này chứ không phải dx/dy mức lớp vì dx/dy dời
  cả cụm theo CÙNG một hướng, còn ba nét toả ra ba hướng khác nhau; và không tách thành ba
  lớp vì nhịp đập thuộc thiết kế của hình — tách ra thì panel mọc thêm ba ô màu vô nghĩa.
  CẢNH BÁO: `layout` tính lề canvas KHÔNG xét `reveal`, nên hộp của hình phải phủ MỌI giá
  trị reveal (hộp nét nhấn là 168×119 = HỢP hai trạng thái, không phải 148×100 của riêng
  trạng thái trong) — thò ra ngoài là bị xén ở mép canvas, chỉ lộ ra ở khâu xuất.
  DÙNG THỨ BA — LỚP CHỮ (mẫu "Zoom Title"): `reveal` trên lớp `kind:'text'` là MÉP LỘ DẦN
  kiểu máy đánh chữ — một mép CẮT PHẲNG chạy từ trái sang phải qua hộp MỰC. Khác perChar ở
  chỗ chữ đang tới bị cắt ĐỨNG giữa thân (đo được trên video: chữ 'r' của "Tour" ở khung 29
  cụt một nửa), mà perChar chỉ bật/tắt trọn từng ký tự. Ba điều ràng buộc:
  1. Clip đặt SAU phần vẽ nền — nền (thanh màu) phải hiện nguyên vẹn ngay từ đầu, chỉ chữ
     mới lộ dần. Đặt trước là thanh màu cũng bị cắt, mà trên preview nhỏ nhìn vẫn "có vẻ
     đúng"; test chốt đúng THỨ TỰ này.
  2. Mép cắt bám hộp MỰC (`padX .. padX + innerWidth`), không bám hộp lớp — nếu không phần
     đệm nền hai bên ăn mất quãng chạy và chữ lộ xong sớm hơn số đo.
  3. Vùng giữ lại nới rộng sang trái bằng cả bề rộng hộp để không xén viền/bóng của phần
     chữ ĐÃ lộ. `reveal ≥ 0.999` thì không đặt clip nữa.
  Nhiều dòng thì cả khối lộ theo MỘT mép chung; đổi sang "xong dòng này mới tới dòng kia"
  là đổi hợp đồng, phải đo lại trên một video có nhiều dòng.
- ĐO MỘT MÉP LỘ DẦN TỪ VIDEO: đừng lấy "mực phải nhất" — mép cắt hay rơi vào KHE giữa hai
  chữ, lúc đó mực phải nhất đứng yên trong khi mép vẫn chạy. Cách đúng: dựng bảng CỘNG DỒN
  mực theo cột của khung đã lộ hết, rồi quy số pixel mực của từng khung ngược về vị trí mép.
  Kết quả vẫn là CẬN DƯỚI (cùng lý do), nên đường thẳng khai trong mẫu phải nằm TRÊN mọi
  điểm đo — chính chỗ này cho ra quãng chạy 12.3 khung thay vì 13 của "Zoom Title".
- ĐO HỆ SỐ PHÓNG KHI NỀN VIDEO ĐỘNG (người mẫu nghiêng đầu suốt "Zoom Title"): phép trừ nền
  cho ra rác, và hộp bao cũng không dùng được vì chữ to hơn khung hình nên bị xén. Cách đã
  dùng: lấy MẶT NẠ chữ lúc đứng yên, phóng quanh tâm theo hệ số thử rồi chấm điểm bằng ĐỘ
  CHÊNH độ sáng trong nét / ngoài nét. Đỉnh rất nhọn (chênh 178..204 ở hệ số trúng, tụt hẳn
  khi lệch 3%) và phép này cũng CHỈ RA tâm phóng. Riêng ĐỘ MỜ thì đo được bằng phân vị cao
  của bản đồ alpha trên một vùng mà chữ phủ gần hết — p95/p99/p99.9 trùng nhau tới 0.01
  chính là dấu hiệu vùng đó đang là một mảng alpha ĐỀU, tức số đo đáng tin.
- Số đo viết ở LỚP 1080 rồi nhân `item.template.px_scale` (= `sequenceTextScale()` lúc
  TẠO) — đúng quy ước scaledTextPx của textbox thường; `rescaleOverlaysForSequenceResize`
  là chỗ DUY NHẤT được sửa nó khi đổi độ phân giải Sequence.
- CHIỀU CAO LỚP CHỮ LẤY THEO DẢI CHỮ HOA (cap-height đo từ 'H'), KHÔNG theo mực thật; bề
  rộng thì theo mực (hộp tự co như CapCut). Lý do: "ĐÃ DUYỆT" có dấu trên và dấu dưới, nếu
  hộp chạy theo mực thì tâm dọc trôi theo dấu và hình trang trí neo `fy:0.5` lệch theo
  chuỗi người dùng gõ. Mực tràn ra ngoài dải (`overTop/overBottom`) được cộng vào lề canvas.
- LỀ CANVAS TÍNH RIÊNG TỪNG TRỤC VÀ CÓ TRẦN THEO KHUNG HÌNH: hoạt ảnh "Approved" phóng chữ
  lên 10.9× = 7700px rộng; tính đủ lề là canvas ~9000px và bake 90 khung PNG cỡ đó thì
  renderer chết. Phần nằm NGOÀI khung hình người xem không thấy (CapCut cũng chỉ vẽ tới
  mép), nên trần = vừa đủ phủ khung + 10% dự phòng. Kết quả thực đo: 1296×1214 ở Sequence
  1080×1920, 2305×1086 ở 1920×1080.
- PREVIEW VẼ Ở ĐỘ PHÂN GIẢI MÀN HÌNH, KHÔNG Ở PX SEQUENCE: canvas = kích thước hiển thị,
  nội dung nhân thêm `previewScale`. Vẽ ở px Sequence là ~1.4 triệu pixel mỗi khung, đủ để
  tụt khung ở vòng lặp 60fps; ở đây còn ~1/10 mà nhìn không khác gì vì canvas vốn bị CSS
  thu nhỏ về đúng cỡ đó. Chỉ vẽ lại khi (cỡ | nội dung | chữ ký khung) đổi — chữ ký lấy từ
  `TextTemplates.frameSignature`, CHÍNH thứ khâu xuất dùng để đẩy `null` (lặp khung trước).
- Thumbnail thẻ trong panel vẽ bằng CHÍNH `drawFrame` (không có ảnh dựng sẵn) nên ô xem
  trước không bao giờ lệch với thứ rơi xuống timeline; hover thì chạy hoạt ảnh thật.
  `settleTime()` không phải "sau keyframe cuối" mà là mốc MỌI lớp cùng ở trạng thái nghỉ
  (và giữ nguyên thêm 0.05s) — lớp lặp có lúc đang ẩn đúng sau keyframe cuối, lấy trúng
  đó thì thumbnail ra mẫu THIẾU hình trang trí.
- NGƯỜI DÙNG CHỈNH ĐƯỢC THÔNG SỐ CỦA MẪU (`item.template.overrides`), không chỉ nội dung chữ:
  · Khoá bảng = KHOÁ LỚP (`TextTemplates.layerKey`: lớp chữ lấy tên ô chữ, lớp hình lấy
    `layer.key`) — ổn định qua lưu/mở dự án. Giá trị: lớp chữ = style ĐÚNG HÌNH DẠNG style
    của text thường (`font_family/font_size/stroke_*/bg_*/shadow_*/deco_*…`), lớp hình =
    `{tênMảngMàu: hex}` theo `GLYPHS[].colorKeys`.
  · CHỈ GHI PHẦN ĐÃ ĐỔI, không chép nguyên thiết kế: số đo của mẫu là dữ liệu tham chiếu
    còn được đo lại chính xác hơn: chép nguyên vào từng block là mọi dự án cũ đóng băng
    bản đo cũ. Bảng rỗng/thiếu = đúng thiết kế gốc, nên dự án cũ mở lên không đổi hình.
  · `TextTemplates.resolve(tpl, overrides)` trộn ra MỘT template mới; phần engine còn lại
    (`layout`/`drawFrame`/`frameSignature`/`fonts`) không biết gì về override. Trong
    runtime, `textTemplateResolved(item)` là cổng duy nhất và `lay.tpl` LUÔN là bản đã
    trộn — nhờ vậy preview, thumbnail, PNG tĩnh và bake export tự đi theo, không có đường
    thứ hai để lệch. `resolve` KHÔNG được sửa template gốc (dùng chung cho mọi block).
  · ĐƠN VỊ CỦA OVERRIDE LÀ PX@1080, y như thiết kế — KHÔNG phải px Sequence. Vì thế
    `rescaleOverlaysForSequenceResize` KHÔNG đụng tới nó (chỉ nhân `px_scale`); ghi vào
    `item.style` thay vì `overrides` sẽ bị phóng HAI LẦN.
- Inspector: khối "Mẫu văn bản" (tên mẫu + các ô chữ + ô màu của từng lớp hình trang trí)
  ĐỨNG TRƯỚC Typography/Text Style — hai khối sau dùng lại NGUYÊN bộ control của text
  thường (cùng id phần tử, cùng lưới preset) nên `patchTextStyle` là chỗ duy nhất rẽ nhánh:
  với mẫu nó ghi vào override của LỚP CHỮ ĐANG CHỌN thay vì `item.style`. Mẫu nhiều lớp chữ
  thì có thêm hàng chọn lớp (`data-tpl-layer`); mẫu một lớp không hiện hàng đó.
  Khác biệt duy nhất về control: bỏ "Nội dung" (đã có ô riêng theo từng slot) và bỏ Case
  `small-caps` (engine vẽ canvas, không có font-variant). Sub-tab "Biến đổi" giữ nguyên
  (kéo/phóng/xoay cả nhóm). Khung chọn chỉ có 4 tay cầm góc (mẫu không dùng
  `style.box_width` nên 2 thanh cạnh của text sẽ là no-op), và double-click đưa con trỏ về
  ô chữ ở panel thay vì gõ trực tiếp trên canvas.
- ĐỆM NỀN TRÊN/DƯỚI TÁCH RIÊNG (`bg.padTop`/`bg.padBottom`, mặc định = `bg.padY` -> mẫu cũ
  không đổi hình): hộp nền của CapCut bám dải ascender→descender nên KHÔNG cân đối quanh dải
  chữ hoa — "Quote" đo được 9px trên dải chữ hoa và 18px dưới baseline trong một hộp cao 86.
  Đệm cân đối buộc phải chọn một trong hai: đúng chiều cao hộp (86) HOẶC đúng chỗ đặt baseline
  (68 tính từ mép trên); lệch 4.5px thấy rõ ở khe giữa hai dòng. Phần đệm dưới cũng chính là
  chỗ chứa nét thả của g/y, nên với mẫu này `overTop/overBottom` về 0 (không còn gì tràn ra
  ngoài hộp) kể cả với chuỗi tiếng Việt.
  PHẦN ĐỆM PHẢI ĐI QUA STYLE (`bg_pad_x`/`bg_pad_top`/`bg_pad_bottom`, tính theo % CỠ CHỮ):
  `applyTextStyle` dựng lại `bg` từ style, nên nếu style không mang phần đệm thì chỉ cần đổi
  màu chữ là hộp nền nhảy về tỉ lệ mặc định (0.28/0.22 cỡ chữ) và mất số đo lấy từ video.
  Panel KHÔNG có ô nhập cho ba khoá này (người dùng không cần) — chúng chỉ đi cùng bảng
  override; để theo % cỡ chữ nên đổi cỡ chữ thì hộp nền vẫn nở đúng tỉ lệ thiết kế.
- NỀN BO GÓC CỦA LỚP CHỮ NẰM TRONG HỘP LỚP (`measureTextLayer` cộng padding vào width/height),
  không phủ ra ngoài: hộp tĩnh là khung transform người dùng thấy nên mọi pixel được vẽ phải
  nằm gọn trong đó, và hình trang trí neo theo hộp (dấu tích của "Approved") tự lùi ra thay
  vì bị nền chữ đè lên. Ngược lại VIỀN & BÓNG vẽ RA NGOÀI mực: chúng KHÔNG vào hộp (hộp phải
  đứng yên khi bật/tắt viền, nếu không mọi khoảng cách của mẫu nhảy theo) mà chỉ cộng vào lề
  canvas qua `overTop/overBottom/overSide`.
- SỐ ĐO TỪNG MẪU LÀ DỮ LIỆU THAM CHIẾU, đo từng pixel trên video mẫu CapCut (30fps,
  1080×1920) — không phải tham số tinh chỉnh cho đẹp. Cách đo đã dùng cho "Approved":
  · hộp mực chữ + tâm/bán kính hình trang trí + màu lấy từ histogram khung tĩnh;
  · font: chuẩn hoá cỡ chữ cho chiều cao mực = mục tiêu, chuẩn hoá letter-spacing cho bề
    rộng mực = mục tiêu, rồi so bề rộng MỰC TỪNG CHỮ CÁI với cả 51 font của app; kiểm lại
    bằng phép chồng ảnh difference-blend lên khung video (Source Sans 3 700 lệch 0.7%);
  · hệ số phóng theo khung: bám mép một nét chữ qua từng khung rồi giải
    x_f = Xc + s·(x_settled − Xc) — phép này cũng CHỈ RA tâm phóng (tâm hộp chữ, không
    phải tâm cả nhóm hay tâm khung);
  · đường kính hình trang trí theo từng khung -> keyframe của lớp đó. Video mẫu chạy
    sticker 15fps nên dãy đo đi thành bậc: lấy MỘT điểm mỗi bậc rồi nội suy tuyến tính
    (cùng biên độ, cùng thời điểm, nhưng mượt ở 30/60fps).
- MỘT CHỖ CỐ Ý LỆCH SỐ ĐO (áp cho CẢ "Approved" lẫn "Correct 1"): dấu tích NẢY MỘT LẦN
  rồi đứng yên, trong khi CapCut cho nó lặp chu kỳ 0.80s (nảy, giữ tới 0.617s rồi TẮT HẲN,
  hiện lại ở chu kỳ sau). Bản lặp làm dấu tích nhấp nháy suốt cả block, gây rối khi mẫu
  đứng lâu trên khung hình. Cách bỏ: xoá `period` + `window` của lớp đó — `layerStateAt`
  không quay vòng thời gian nữa và `trackAt` kẹp ở keyframe cuối. Biên độ nảy và lệch pha
  giữ nguyên số đo.
- MẪU ĐÃ DỰNG (mỗi mẫu có khối chú thích số đo đầy đủ ngay trên khai báo của nó):
  · `approved` — "APPROVED" zoom từ 10.9× vào + đĩa tích nảy. Source Sans 3 700 / 147.4px.
  · `correct-1` — "Correct" rơi TỪNG KÝ TỰ (lệch pha 1/15s, mỗi chữ rơi từ trên xuống 77px
    trong 11 khung, vọt quá 4.5px) + đĩa tích CÓ BÓNG ĐỔ DÀI. Montserrat 800 / 183px,
    chốt bằng phép chồng ảnh IoU trên khung f45 (0.896 so với 0.875 của Montserrat 700 và
    0.847 của Poppins 700). Bóng đổ dài = quét chính dấu tích theo hướng u=(0.642,0.766)
    rồi nhạt tuyến tính hết sau 1.07r, cắt trong đĩa; vẽ bằng MỘT lệnh `stroke()` trên
    nhiều bản sao đã dịch — một lệnh stroke chỉ hợp thành MỘT vùng rồi tô một lần nên chỗ
    chồng nhau không cộng dồn alpha (vẽ nhiều lệnh thì bóng vón thành từng vạch đậm).
  · `incorrect` — vành tròn đỏ nảy DỘI HAI NHỊP (1.20 → 0.81 → 1.00), dấu X TỰ VẼ từ hai
    đầu trên xuống (khung 46..66), chữ "Incorrect" TRƯỢT VÀO TỪ TRÁI chui ra từ sau vành.
    Raleway 500 / 134px.
  · `incorrect-2` — cùng bộ, đĩa đỏ đặc + dấu X trắng đổ bóng, chữ IN HOA viền đỏ trượt
    vào từ trái. Raleway 500 / 109.5px.
  · `quote` — cặp dấu nháy vàng #fdee00 TRƯỢT LÊN 145px kèm mờ dần (khung 14..27) + HAI ô
    chữ đen trên NỀN TRẮNG trượt vào từ trái sau mép cắt (khung 23..40). Inter 500 / 79.87px.
    Mẫu đầu tiên có NHIỀU ô chữ và có NỀN cho lớp chữ, nên cũng là mẫu đầu tiên dùng đệm nền
    không cân đối (xem gạch đầu dòng về `bg.padTop/padBottom`) và hàng chọn "Lớp chữ" của
    Inspector. Hai dòng dùng CHUNG một mảng `dx` (video đo ra cùng một quãng tới từng pixel):
    nhờ vậy dòng ngắn hơn tự lộ ra muộn hơn thay vì phải khai hai đường thời gian lệch nhau.
    Dấu nháy vẽ bằng hai PHẦN TƯ VÀNH KHUYÊN đồng tâm, tâm đúng tại góc dưới-trái của đầu
    vuông và bán kính ngoài = bề rộng đầu vuông (giải đường tròn qua 3 điểm đo được ra tâm
    (89.5, 942.5) r=75.9 so với góc (88, 941) và bề rộng 78) — chỉ ba con số nên phóng to
    không làm méo cái đuôi.
    CÁCH TÁCH "TRƯỢT" KHỎI "PHÓNG TO" khi đo: dựng bản đồ alpha (chiếu hiệu màu từng pixel
    lên hướng nền→vàng) rồi so hộp bao qua từng khung — hộp bao cao đúng 152 ngay từ khung 17
    và chỉ ĐI LÊN, nếu là phóng to thì chiều cao phải lớn dần. Đo alpha bằng median trên mặt
    nạ khung cuối ĐÃ DỊCH theo dy, nếu không hai đại lượng trộn vào nhau.
    Font chốt bằng BA phép đo độc lập vì IoU một mình không đủ với chữ nét mảnh: IoU trên cả
    hai dòng (Inter 500 dẫn đầu 0.744/0.635, sau đó Prompt 500 và Figtree 600), bề rộng mực
    TỪNG CHỮ CÁI (Inter sai số RMS 4.8%), và TỈ LỆ ascender/dải-chữ-hoa = 60/59 = 1.017 —
    chính chỗ này loại Prompt/Roboto/Montserrat/Archivo (1.05-1.06, chữ 'l' phải cao hơn chữ
    'A' 3px trong khi video chỉ hơn 1px).
  · CHỌN FONT KHI IoU KHÔNG ĐỦ ĐỂ KẾT LUẬN: với chữ nét mảnh ("Incorrect"), IoU bị chi
    phối bởi bề dày nét chứ không "thấy" hình dáng đầu nét — Quicksand 500 đạt IoU cao
    nhất (0.816) nhưng đầu nét chữ 'I' của nó BO TRÒN (lát cắt theo hàng 3,7,9,11,11)
    trong khi video cắt phẳng (7,13,13,13). Loại nhóm bo tròn rồi mới xếp hạng: Raleway
    500 (0.811). Khi IoU trần chỉ ~0.81 (so với ~0.90 của mẫu chữ đậm) thì kết quả là
    "font gần nhất trong thư viện", không phải "đúng font CapCut" — ghi rõ điều đó trong
    chú thích của mẫu, vì người dùng đổi được font ở panel.
  · `mood-matcha` — HAI DÒNG chữ tròn mập viền HAI LỚP (xanh sáng #69eb03 dày 20 bọc ngoài
    xanh đậm #304227 dày 13, cả hai tính từ mép mực), mọc lên TỪNG KÝ TỰ **từ baseline**
    (vọt 1.06 rồi lắng), lệch pha 0.1s; kèm BÌNH SỮA ở trên-trái và ba VỆT NHẤN ở dưới-phải.
    Nunito 900 / 206.993px. Hai dòng là HAI LỚP riêng vì hai delay cách nhau 6.5 khung —
    không phải bội của lệch pha nên không gộp được thành một lớp hai dòng.
  · `zoom-title` — tiêu đề IN HOA phóng từ 9.73× thu về 1 trong 14 khung kèm mờ dần tuyến
    tính, rồi THANH MÀU #fcba00 bật ra NGUYÊN VẸN ở khung 27 và dòng phụ GÕ RA sau một mép
    cắt phẳng chạy đều hết hộp mực trong 12.3 khung. Rubik 800 / 144.286px (tiêu đề, IoU
    0.844) + Nunito Sans 800 / 51.064px trên nền vàng đệm lệch 29/32 (dòng phụ, IoU 0.800).
    Mẫu ĐẦU TIÊN không có nảy dội: hệ số phóng đơn điệu giảm, không vọt quá 1.
  · `folgen-sie` — chữ NGHIÊNG hiện ra TỪNG KÝ TỰ (phóng từ 0, vọt 1.129 rồi NẢY DỘI TẮT
    DẦN quanh 1, chu kỳ 10 khung; lệch pha 1/16s) + BA NÉT NHẤN ở góc phải trên: phóng vào
    một lần (đỉnh 1.101) rồi ĐẬP ra-vào không dứt. Roboto Condensed 700 ITALIC / 215.3px,
    letter −12.99.
  · `vlog-tag` — thẻ chữ NỀN TRẮNG ba dòng (Open Sans 600 / 97.5px, đệm 47 ngang, 39 trên,
    58 dưới) với HAI THẺ VÀNG #ffd744 NẤP SAU, phóng từ 0 quanh tâm chính nó kèm mờ dần
    nên lần lượt thò ra hai dải chữ L ở góc trên-trái (xong khung 29) và góc dưới-phải
    (xong khung 47). Chữ và hộp trắng KHÔNG có hoạt ảnh — hiện nguyên hình ở khung đầu.
    FONT CHỐT CHẮC NHẤT CẢ BỘ MẪU: IoU 0.965/0.934/0.951 trên ba dòng (á quân Open Sans
    500 ở 0.868), sai số bề rộng mực từng chữ 1.4%, và tỉ lệ asc/cap = 1.071 loại nốt nhóm
    asc = cap.
    HAI THẺ DÙNG `fit` (xem dưới) nên cạnh bám theo hộp chữ: gõ dài ngắn thế nào chúng
    cũng trùm đúng khổ chữ. Hai thẻ GIỮ HAI ĐƯỜNG CONG RIÊNG: ép chung một đường thì lệch
    pha đi ra 14 khung ở đoạn đầu nhưng 18 khung ở đoạn cuối.
  · `welcome` — chữ BÓNG hồng #ff6384 viền HAI LỚP (trắng 17 bọc trong, #febdbd 29 bọc
    ngoài) kèm bóng xám lệch (8,10), bật ra TẮNG CHỮ từ khung 13 (lệch pha 1.33 khung,
    vọt quá 15% rồi lắng); hai bông cúc ở trên-trái và mũi tên cuốn vẽ tay ở dưới-phải
    cùng bật từ khung 20. Smooch Sans 900 / 237.27px.
    LÀ MẪU BUỘC PHẢI ĐỔI CÁCH VẼ CỦA perChar: vẽ xong hẳn chữ này mới tới chữ sau thì
    viền ngoài 29px của chữ sau đè 22px vào chữ trước (khe giữa hai chữ chỉ 7px) — xem
    gạch đầu dòng về BỐN LƯỢT QUÉT ở dưới.
    HAI HÌNH TRANG TRÍ ĐỀU DỰNG BẰNG ĐƯỜNG VECTOR ĐO TỪ VIDEO: cặp cúc là MỘT hình
    (chúng lớn lên cùng một nhịp quanh tâm chung — tức một sticker), mỗi cánh là một hình
    tròn và bộ (góc xoay, khoảng cách, bán kính) được KHỚP bằng phép chồng ảnh (IoU 0.88 và
    0.90); mũi tên lấy thẳng ĐƯỜNG ĐI từ xương của nét vẽ trong video (tách nền bằng hiệu
    ảnh, rút xương Zhang-Suen, rồi đi dọc xương — 47 điểm thật, không phải vẽ ước chừng).
    FONT: lại là cảnh "thư viện không có font cùng loại" — mẫu dùng chữ bóng (bubble),
    app không có họ nào như vậy. Smooch Sans 900 thắng cả ba phép đo (IoU 0.798 so với
    0.776 của Fira Sans 900; asc/cap = 1.000 và x/cap = 0.758 khớp video) và quan trọng
    nhất là TỈ LỆ NGANG/DỌC tự nhiên đúng: ở cỡ cho dải chữ hoa 148 nó viết "Welcome"
    rộng 685.7 so với 728 đo được (chỉ cần letter +7), các ứng viên kia phải kéo letter
    tới −22..−31 mới vừa — tức chữ phải chồng lên nhau, sai hẳn dáng.
  · KHI KHÔNG TÌM ĐƯỢC FONT (mẫu "Folgen Sie" dùng chữ BÚT LÔNG KHÔ): dò cả 618 file .ttf
    của app (kể cả khuôn Italic) ra IoU cao nhất 0.52, dò tiếp 500+ font cài trong Windows
    cũng chỉ 0.54 — tức thư viện KHÔNG có font cùng loại, không phải "chưa dò kỹ". Lúc đó
    cách làm là: giữ HIỆU ỨNG (thứ nhận diện mẫu, và cũng là thứ người dùng không sửa được
    ở panel), lấy một font cùng dáng có TỈ LỆ tự nhiên gần nhất, rồi ghi rõ chỗ lệch vào
    chú thích của mẫu. Với "Folgen Sie": chốt cỡ chữ theo DẢI CHỮ HOA (153.5 — con số ràng
    buộc khoảng cách dọc với nét nhấn) và letter-spacing theo bề rộng mực (754), nên hai số
    đo ràng buộc bố cục vẫn đúng từng pixel dù nét chữ khác.
- HÌNH ĐO THEO HỘP CHỮ (`layer.fit = {fw, fh, dw, dh}` trên lớp glyph — "Vlog Tag"):
  cạnh = fw·bề-rộng-hộp-chữ + dw và fh·chiều-cao-hộp-chữ + dh, thay cho `size` cố định.
  Dùng cho hình phải BÁM KHỔ CHỮ: hai thẻ vàng của "Vlog Tag" là bản sao lệch chỗ của
  chính hộp chữ, người dùng gõ dài ngắn thế nào cũng phải trùm đúng bấy nhiêu.
  · fw/fh nhân vào hộp chữ (đã ở px Sequence) nên KHÔNG nhân `k` nữa; dw/dh viết ở lớp
    1080 như mọi số đo khác nên có.
  · Đo ở PHA 2 của layoutAt, cùng chỗ với lớp ảnh và cùng lý do (hộp chữ chưa có ở pha 1),
    và cũng vì vậy lớp `fit` KHÔNG được nằm trong hộp chữ (`place:'flow'`) — hộp cần cạnh
    của nó, cạnh của nó cần hộp. Khai nhầm thì layout ÂM THẦM bỏ qua (lọc ở `flowIdx`),
    không làm vỡ phép đo.
  · Hình 'card' (chữ nhật đặc) là hình ĐẦU TIÊN không có hình dáng riêng — cạnh do hộp
    quyết định — nên `GLYPHS[].draw` nhận thêm tham số thứ năm `{w, h}` = hộp của lớp.
    Mọi hình cũ bỏ qua tham số này và vẫn suy hình từ bán kính `r` như trước.
- LỚP CHẠY THEO KÝ TỰ VẼ THÀNH BỐN LƯỢT QUÉT, KHÔNG PHẢI "xong chữ này rồi tới chữ sau"
  (`drawTextLayerContent`, tham số `phase` của paintRun — mẫu "Welcome" bắt phải đổi):
  bóng của MỌI chữ → vòng viền ngoài của MỌI chữ → vòng trong → thân chữ.
  · VỀ HÌNH: viền vẽ theo từng chữ thì vòng ngoài của chữ SAU đè lên thân chữ TRƯỚC —
    "Welcome" có viền ngoài 29px mà khe giữa hai chữ chỉ 7px, tức nó gặm 22px vào chữ
    trước. Quét theo lớp thì các vòng viền hoà thành MỘT đường bao chung, đúng như
    sticker của CapCut (và đúng như video: lúc chữ đang bật, chữ nhỏ vẫn có đường bao
    riêng của nó — hình ấy tự đúng vì mỗi chữ vẫn mang phép biến đổi riêng).
  · TẠI SAO BÓNG CÓ PHA RIÊNG ĐI ĐẦU: bóng lệch xuống-phải nên bóng của chữ sau rơi
    ĐÚNG VÀO viền chữ trước; đổ hết bóng trước rồi mới vẽ viền thì phần bôi bỏ bị chính
    các nét đó phủ lại. Pha 'shadow' vẽ lại đúng lớp ngoài cùng (tốn thêm một lệnh
    strokeText mỗi chữ) chứ không có cách đổ bóng "không kèm hình" trong canvas 2D.
  · LỚP KHÔNG chạy theo ký tự giữ nguyên đường cũ (cả dòng vẽ một lượt nên vốn đã hoà).
  · "Mood Matcha" được hưởng lây: trước đó viền hai lớp của nó cũng bị chữ sau gặm,
    chỉ là ít lộ hơn vì viền mỏng hơn.
- VIỀN HAI LỚP (`layer.stroke2` = vòng NGOÀI, `layer.stroke` = vòng trong — "Mood Matcha"):
  cả hai bề dày đều tính TỪ MÉP MỰC, KHÔNG cộng dồn. Vẽ vòng ngoài trước với lineWidth lớn
  hơn rồi vòng trong đè lên; phần lộ ra của vòng ngoài đúng bằng hiệu hai bề dày. Nhờ vậy
  đổi bề dày vòng trong không làm mép ngoài của cả cụm nhúc nhích. Ba chỗ phải biết tới nó:
  bóng đổ chỉ đổ MỘT lần (dưới lớp ngoài cùng ĐƯỢC VẼ), lề canvas lấy theo bề dày LỚN NHẤT
  của hai vòng (lấy nhầm vòng trong là vòng ngoài bị xén ở mép, chỉ lộ ra ở khâu xuất), và
  `stroke2_color`/`stroke2_width` phải là khoá STYLE — panel không có ô nhập cho chúng nhưng
  applyTextStyle dựng lại phần viền từ style, thiếu khoá là đổi màu chữ làm mất vòng ngoài.
  Công tắc "Viền" của panel tắt CẢ HAI vòng: còn trơ lại vòng ngoài bọc chỗ trống là thứ
  người dùng không hiểu nổi.
- GỐC PHÓNG CỦA KÝ TỰ (`anim.perChar.origin`): mặc định `'cap'` = giữa dải chữ hoa (chữ nở
  đều hai phía, dùng cho "Correct 1"/"Folgen Sie"). `'baseline'` đặt gốc ngay trên baseline
  để chữ MỌC LÊN từ dòng kẻ ("Mood Matcha"). CÁCH PHÂN BIỆT KHI ĐO VIDEO: nhìn MÉP DƯỚI của
  chữ đang lớn dần — mọc từ baseline thì mép dưới đứng yên (chỉ nhích theo bề dày viền
  20·s), nở đều hai phía thì mép dưới ĐI XUỐNG. Đo trên 'M' dòng 2 của "Mood Matcha": đáy
  1139 ở s=0.263 và 1158 ở s=1.025, đúng baseline 1135 + 20·s.
- HÌNH TRANG TRÍ TỰ VẼ THAY CHO STICKER CỦA VIDEO ("Mood Matcha" đổi cốc trà sữa thành bình
  sữa em bé theo yêu cầu): giữ NGUYÊN hộp và chỗ neo đo được, chỉ đổi nội dung hình. Nhờ vậy
  bố cục và đường thời gian vẫn là số đo thật, và hình vẫn đi theo quy ước "vẽ bằng đường
  vector, không dùng file ảnh" của engine. Hình tự vẽ phải khai đủ `colorKeys` cho mọi mảng
  màu — thiếu ô nào là người dùng không đổi được phần đó mà cũng không biết vì sao.
- NEO HÌNH TRANG TRÍ THEO MỘT DÒNG CHỮ (`place.line` = số thứ tự dòng hoặc `'last'`) THAY
  VÌ THEO MÉP HỘP CHỮ: hộp chữ rộng bằng dòng DÀI NHẤT, nên hình neo theo mép hộp chỉ sát
  chữ khi dòng của nó đúng là dòng dài nhất. Bẫy này KHÔNG lộ ra lúc đo video: ở "Mood
  Matcha" mép trái hộp chữ (162, của "Matcha") và mực dòng 1 (244, của "Mood") cách nhau
  đúng 82 = bề rộng bình sữa, nên "lùi 26 so với hộp" và "lùi 26 so với mực dòng 1" cho
  CÙNG một chỗ — chỉ chuỗi người dùng gõ mới phân biệt được, và nó lệch về HAI phía ngược
  nhau: gõ MỘT dòng thì mép hộp trùng mép chữ -> hình ĐÈ LÊN chữ; gõ dòng 2 dài gấp đôi thì
  mép hộp lùi xa -> hình TRÔI RA XA chữ. Mốc DỌC vẫn là hộp chữ (chiều dọc không có vấn đề
  này: hộp cao đúng bằng khối chữ). Mép mực của một dòng do `lineInkLeft` tính, DÙNG CHUNG
  với phép vẽ — hai bản riêng thì đổi cách căn lề làm hình trôi khỏi chữ mà chữ vẫn đúng.
- NGHIÊNG TĨNH (`layer.tilt`, độ, dương = theo chiều kim đồng hồ — bình sữa của "Mood Matcha"
  nghiêng 30° về bên phải) TÁCH KHỎI `anim.tracks.rot`. Hai lý do, cả hai đều là lỗi âm thầm
  nếu nhập chung: (1) `stateIsRest` đòi |rot| < 0.01 để kết luận "lớp đã đứng yên", nên một
  lớp nghiêng vĩnh viễn bằng tracks.rot làm `settleTime` không tìm được mốc nghỉ và thumbnail
  của panel rơi về mốc dự phòng — chụp trúng lúc hình còn đang vào cảnh; (2) tilt là số đo
  THIẾT KẾ, phải đọc được mà không cần dò đường thời gian. Hai chỗ phải biết tới nó: phép
  xoay trong `drawFrame` (cộng vào rot của hoạt ảnh, quanh TÂM hộp lớp — hộp tĩnh không nhúc
  nhích, chỉ nội dung nghiêng) và LỀ CANVAS trong `layout` (hộp nghiêng choán rộng hơn hộp
  thẳng: nửa bề rộng thành w/2·cos + h/2·sin — thiếu là góc hình bị xén, chỉ lộ ở khâu xuất).
- ĐỈNH ĐO ĐƯỢC ≠ ĐỈNH ĐƯỜNG NÉT: điểm cực của mặt nạ nằm trên MÉP NGOÀI nét. Với
  lineJoin/lineCap tròn, góc ngoài là cung tròn bán kính w/2 quanh đỉnh tâm-nét, nên đỉnh
  khai trong GLYPHS = đỉnh đo được LÙI VÀO w/2 theo hướng trọng tâm. Bỏ phép lùi này thì
  hình vẽ ra to hơn số đo w/2 mỗi phía và tràn khỏi hộp (bắt được ở ba nêm của "Mood
  Matcha": 76×88 thành 82×94).
- CHỮ NGHIÊNG (`layer.font.italic`): các file `*_Italic.ttf` VỐN ĐÃ nằm trong
  static/fonts/google (bộ @expo-google-fonts đóng đủ mọi kiểu) nhưng trước nay không được
  đăng ký @font-face nên canvas không với tới. `editingFontFaceCss` nay phát cả khuôn
  nghiêng (285 khuôn, `NO_ITALIC_FOLDERS`/`ITALIC_WEIGHTS_EXCEPT` là danh sách đếm trên
  đĩa), và `fontShorthand` của engine mẫu chèn `italic` vào chuỗi font.
  BA CHỖ PHẢI BIẾT TỚI NÓ, bỏ sót là hỏng âm thầm:
  1. `fonts(tpl)` trả thêm `style`, và CẢ HAI chỗ dùng nó (`templateFontsReady` →
     `document.fonts.check`, `preloadTemplateFonts` → `document.fonts.load`) phải ghép
     `style` vào chuỗi hỏi — thiếu thì hỏi nhầm khuôn ĐỨNG, thấy "đã có" rồi đo luôn trong
     khi khuôn NGHIÊNG chưa về, hộp sai một nhịp.
  2. `font_italic` là một khoá STYLE (như `bg_pad_*`): `applyTextStyle` dựng lại `font` từ
     style, nên thiếu khoá này thì chỉ cần đổi màu chữ ở Inspector là mẫu hết nghiêng.
  3. Panel text THƯỜNG không có nút nghiêng, nên không dự án nào sinh ra chữ nghiêng ngoài
     mẫu văn bản — bảng font của backend (`EDITING_FONT_FILES`, chỉ phục vụ text thường ở
     khâu xuất) vì thế KHÔNG phải đổi theo; mẫu xuất bằng chuỗi PNG bake từ chính canvas.
  Family không có file italic vẫn dùng được cờ này: Chrome nghiêng giả, xấu hơn nhưng
  không bao giờ mất chữ — nên người dùng đổi mẫu sang font bất kỳ vẫn giữ dáng nghiêng.
- MỘT LỚP VỪA CÓ HOẠT ẢNH MỘT-LẦN VỪA CÓ VÒNG LẶP (nét nhấn của "Folgen Sie": phóng vào
  một lần + nhịp đập 0.4s không dứt) thì KHÔNG dùng được `anim.period` — period quay vòng
  TOÀN BỘ thời gian cục bộ của lớp, tức quay vòng luôn track `scale` và hình sẽ phóng lại
  từ 0 mỗi chu kỳ. Cách làm: rải thẳng vòng lặp thành keyframe phủ trọn thời lượng
  (`emphasisPulseTrack`). Bậc thang phải dựng bằng cách KẾT THÚC SỚM 0.1ms, không phải hai
  keyframe TRÙNG mốc: `trackAt` lấy đoạn ĐẦU TIÊN có t1 ≥ t nên ở đúng mốc nó vẫn trả giá
  trị cũ, nhịp đập trễ đúng một khung so với video.
- HAI THỨ DÙNG CHUNG VỚI TEXT THƯỜNG, xem mục riêng ở dưới:
  · ô "W"/"H" của khối Nền (lề chữ ↔ mép nền, % cỡ chữ) — với mẫu, ô "H" giữ đúng tỉ lệ
    lề trên/dưới của thiết kế (`bg.padTop`/`bg.padBottom`);
  · subtab "Mẫu" của tab Văn bản = lưới đổi mẫu ngay trên block đang chọn
    (`switchTextTemplate`), giữ nội dung chữ theo thứ tự ô và bỏ `overrides` của mẫu cũ.
- Test: `npm run test:text-templates` (tests/scripts/text_templates.js) chốt hình học hộp
  tĩnh, trần lề theo khung, tính bất biến của hộp trước dấu tiếng Việt, đối chiếu keyframe
  với dãy số đo từ video, hợp đồng của bảng override (bảng rỗng = bản gốc, resolve không
  sửa gốc, nền nở hộp / viền chỉ nở lề), hợp đồng perChar (khung vào cảnh của từng ký tự,
  quỹ đạo rơi, trạng thái mức-lớp phải đứng yên, chữ ký khung đổi theo số ký tự) và hợp
  đồng mép cắt (lề KHÔNG được phình theo quãng trượt, mép cắt nằm đúng chỗ đo được, trộn
  override không làm mất clip/anim), hợp đồng đệm nền không cân đối của "Quote" (baseline nằm
  68px dưới mép trên trong hộp cao 86, hai baseline cách đúng 100px, đổi màu/cỡ chữ không làm
  hộp nền nhảy tỉ lệ, `padY` cân đối của mẫu cũ vẫn đo y như trước), và hợp đồng của
  "Folgen Sie" (chỗ neo 65/76 của nét nhấn, chữ nghiêng không mất khi đổi màu, dấu cách vẫn
  chiếm một nhịp lệch pha, biên độ nảy phải tắt dần, nhịp đập đúng trạng thái ở 11 khung đã
  đo và là bậc thang thật, ba nét trượt KHÁC hướng nhau và nằm gọn trong hộp ở CẢ hai trạng
  thái), và hợp đồng của "Zoom Title" (hộp 810×101 + 816×97 cách nhau 17, baseline dòng phụ
  nằm 65px dưới mép trên thanh, hệ số phóng ĐƠN ĐIỆU GIẢM, mép cắt nằm trên mọi cận dưới đo
  được mà khung 39 vẫn chưa xong, và hợp đồng mép lộ dần: clip đặt SAU khi tô nền, bề rộng
  vùng giữ lại tính theo hộp MỰC, lộ hết thì không đặt clip nữa — đo bằng ctx giả ghi lại
  thứ tự thao tác), và hợp đồng của "Mood Matcha" (MỘT ô nội dung hai dòng: lineStep 218 giữ
  hộp cao đúng 366 = 148+70+148 của hai hộp cũ nên chỗ neo của bình sữa và vệt nhấn không
  nhúc nhích, chỉ số ký tự đếm LIÊN TỤC qua chỗ ngắt dòng, tâm phóng của ký tự nằm đúng trên
  baseline, vòng viền ngoài vẽ TRƯỚC và dày hơn vòng trong, lề canvas lấy theo vòng ngoài,
  vòng ngoài sống sót qua override còn công tắc "Viền" tắt cả hai, hình tự vẽ khai đủ ô màu
  và nét nằm gọn trong hộp, bình sữa nghiêng bằng `tilt` chứ không bằng tracks.rot nên
  settleTime vẫn có mốc nghỉ và lề ngang nở ra cho hộp nghiêng, khe bình sữa -> mực dòng 1
  đúng 26px với CẢ BỐN kiểu chuỗi: hai dòng dòng-dưới-dài-hơn / một dòng / hai dòng
  dòng-dưới-ngắn-hơn / dòng dưới dài gấp đôi), và hợp đồng của "Vlog Tag" (hộp trắng
  844×365 với baseline ở 109 dưới mép trên, hai thẻ đúng 850×285 và 154×126 ở đúng chỗ lệch
  (−30,−25) và (+24,+27); `fit` bám hộp chữ với MỌI chuỗi và mọi cỡ chữ, lớp `fit` khai nhầm
  place:flow vẫn không làm phình hộp chữ; lớp chữ không mang hoạt ảnh; hai thẻ giữ HAI đường
  cong riêng và đúng mốc LÒI RA đo được — nấp trọn sau hộp ở khung 19/24, thò ra ở khung
  20/25), và hợp đồng của "Welcome" (hộp chữ 728 và chỗ đậu của hoa/mũi tên, viền hai
  lớp 17/29 với lề canvas 45 = 29 + bóng 16, lệch pha 1.33 khung đo trên chữ đầu VÀ chữ
  cuối, và đặc biệt là THỨ TỰ VẼ: ghi lại chuỗi lệnh stroke/fill bằng ctx giả rồi đòi
  đúng bốn lượt quét, bóng chỉ đổ một lượt cho mỗi chữ và phải là lượt ĐẦU TIÊN).
  Thước đo chữ được thay bằng thước tất định (Node
  không có canvas) — mỗi mẫu một thước, số liệu bảng advance/hộp mực lấy từ chính canvas
  của trình duyệt rồi đóng băng — nên thuật toán xếp chỗ vẫn là thuật toán thật.
```

### Mặt Nạ Cắt Hình Cho Block (tab Video, kiểu CapCut)

```text
- KHÁC mặt nạ ở tab Điều chỉnh dù DÙNG CHUNG hình học: mặt nạ kia giới hạn PHẠM VI CHỈNH MÀU
  (ngoài vùng vẫn thấy hình); mặt nạ này CẮT chính block — ngoài vùng thành trong suốt, lộ lớp
  dưới. Vì thế nó sống ở `block.video_mask`, KHÔNG nằm trong `adjustments`: gộp vào thì "xoá hết
  chỉnh màu" sẽ xoá luôn hình cắt, và isIdentity/isBlank của chỉnh màu phải gánh thêm một ngữ
  nghĩa không liên quan.
- Áp cho video/ảnh ở MỌI lane: `latestTimeline[].video_mask` (clip lane chính) và `item.video_mask`
  (media overlay). Lớp Điều chỉnh KHÔNG có (nó không có hình).
- HÌNH HỌC DÙNG CHUNG (color-adjust.js): `MASK_TYPES` nay 6 hình, thêm `star` + `heart`.
  - `sdStar5` / `sdHeart` viết ở hệ y HƯỚNG LÊN (gốc công thức iq); caller truyền -py vì hệ mặt
    nạ có v hướng xuống — làm ngược thì sao chúc mũi xuống và tim lộn ngược.
  - Sao của iq có đỉnh y=+1 nhưng 2 chân chỉ tới -0.809 -> hình cao 1.809, tâm lệch +0.0955.
    `STAR_FIT`/`STAR_Y_MID` dịch+co cho lấp đúng hộp [-1,1]²; để nguyên thì sao lệch hẳn lên và
    chừa dải trống dưới đáy vùng chọn (đã dựng ASCII thấy rõ).
  - Bản GLSL trong `MASK_MIX_SRC` là BẢN CHÉP của 2 hàm này — sửa một bên PHẢI sửa bên kia.
  - `MASK_TYPE_CODE` (mã gửi vào shader) tách khỏi thứ tự `MASK_TYPES` (thứ tự HIỂN THỊ, đã đổi
    một lần cho khớp CapCut): buộc hai thứ vào nhau thì lần sắp xếp lại UI sau sẽ âm thầm đổi
    hình của mọi mặt nạ đã lưu.
  - `normalizeMask()` tách khỏi `normalize()` để cả hai tính năng dùng một cửa kẹp giá trị.
- `renderMaskAlphaCanvas()` — mặt nạ dạng canvas CÓ ALPHA cho preview (vẽ đè bằng
  `globalCompositeOperation='destination-in'` là block bị cắt). KHÔNG nhét vào chuỗi shader như
  mặt nạ chỉnh màu: chuỗi đó chỉ chạy khi block CÓ chỉnh màu và nó là lượt trộn MÀU; cắt hình chỉ
  cần nhân ALPHA. Cache LRU 6 ô theo chữ ký — cache 1 ô thì nhiều block cùng mang mặt nạ sẽ đạp
  lẫn nhau và thành dựng lại mỗi block mỗi khung. Cạnh bị kẹp 1024px: mặt nạ là hàm TRƠN nên
  phóng to lúc vẽ không thấy khác, dựng ở 4K thì mỗi lần kéo trượt là khựng.
- UI: subtab "Mặt nạ" trong tab Video (`INSPECTOR_TAB_DEFS.video.subs.mask`), dựng bằng
  `buildVideoMaskSectionHtml()` DÙNG CHUNG cho overlay lẫn clip lane chính. Ô hình vẽ CHÍNH bóng
  của `maskValueAt` chứ không phải icon vẽ tay (icon vẽ tay sớm muộn cũng lệch khỏi hình thật).
  Bấm ô hình khi mặt nạ đang tắt = BẬT luôn. Rộng/Cao theo PIXEL, dữ liệu vẫn lưu TỈ LỆ.
  Tắt mặt nạ -> XOÁ hẳn field để block sạch không mang object thừa vào .crab/export.
- PREVIEW — HAI ĐƯỜNG KHÁC NHAU theo lane, cùng lấy hình từ `renderMaskAlphaCanvas` nên không thể
  lệch nhau về hình học:
  · OVERLAY -> CSS `mask-image` (data URL) đặt trong `renderPreviewOverlays` qua `applyVideoMaskCss`.
    KHÔNG cắt pixel vì phần tử preview của overlay có thể là <video>, <img> HOẶC <canvas> fx tuỳ
    item có chỉnh màu/retouch — cắt pixel thì phải ép mọi item có mặt nạ đi đường canvas, mà đổi
    LOẠI THẺ giữa lúc phát là dựng lại <video>, mất frame và mất tiếng (bẫy đã ghi ở
    `itemNeedsColorCanvas`). Canvas fx lại đang giữ context WebGL nên không xin được context 2D.
    Transform CSS áp SAU mask -> mặt nạ nằm đúng KHÔNG GIAN NGUỒN.
  · LANE CHÍNH -> `syncSpriteMask()` (index.html) gắn SPRITE CON làm mask của sprite hình. Con thừa
    hưởng nguyên phép biến đổi của cha (vị trí/xoay/phóng/lật + delta hoạt ảnh) nên mặt nạ dính chặt
    vào hình mà không phải nhân lại ma trận. Canvas mặt nạ phải CHÉP RA BẢN RIÊNG trước khi giao cho
    Pixi: bản gốc nằm trong cache LRU, mà `destroy({baseTexture:true})` sẽ huỷ texture gắn với chính
    canvas đó -> lần sau cache trả lại canvas ấy thì `Texture.from()` đưa về texture đã chết.
    Mặt nạ vẽ RGB TRẮNG + alpha biến thiên: `SpriteMaskFilter` của Pixi đọc cả alpha lẫn luma tuỳ
    phiên bản, trắng thì cách đọc nào cũng ra đúng.
  · `videoMaskedDrawable()` / `blockDrawable()` (cắt pixel trên canvas) đã có sẵn cho đường CHỤP KHUNG
    GHÉP và bake export ở bước sau — chưa nối vào các call site đó.
- TAY CẦM TRÊN PREVIEW — DÙNG CHUNG bộ tay cầm với mặt nạ chỉnh màu (`renderMaskOverlay`), vì hình
  học y hệt, chỉ khác chỗ GHI. `maskEditorTarget()` nay trả thêm `kind`: subtab "Mặt nạ" của tab
  Video -> `video_mask`, của tab Điều chỉnh -> `adjustments.mask`. Chọn theo subtab NÀO ĐANG HIỆN
  (bộ chuyển tab chỉ mở một section nên hai loại không bao giờ tranh nhau). Lúc kéo, `handleMaskDrag`
  rẽ nhánh: `applyVideoMask(changed, {history:false})` (history đã ghi ở đầu cú kéo -> một cú kéo =
  một bước undo) vs `applyAdjust`; ô số đồng bộ theo tiền tố `editingVMask_` / `editingAdjMask_`.
- ĐƯỜNG VIỀN SAO/TIM (`maskOutlinePolys`) — KHÔNG viết công thức bao thứ hai mà DÒ CHÍNH SDF: bắn tia
  từ tâm theo 96 hướng, chia đôi 22 bước tìm chỗ đổi dấu. Hai hình này có công thức khoảng cách dài;
  chép thành đường bao riêng là sớm muộn viền lệch khỏi vùng thật. Cả hai đều "nhìn thấy toàn bộ biên
  từ tâm" nên tia luôn cắt biên đúng một lần. Tia đi trong hệ ĐƠN VỊ (đã chia hw/hh) rồi mới nhân
  lại — dò trong hệ (u,v) thì hình dẹt cho bước dò lệch giữa hai trục.
  Đã đo: điểm viền của cả 4 hình đều cho `maskValueAt` = 1 ở phía trong và 0 ở phía ngoài (lệch 0.000).
- HIỆU NĂNG (đo trên dự án thật, nguồn 1728×3072 — người dùng báo "chỉnh mặt nạ thì preview lag"):
  1. THỦ PHẠM CHÍNH: `maskValueAt` cũ gọi `normalize({mask})` — bộ chuẩn hoá CẢ adjustments
     (basic/tone/effects/hsl/wheels/curves/lut, ~50 trường) — CHO TỪNG PIXEL. Bake 576×1024 mất
     **428ms**. Mặt nạ chỉnh màu không lộ ra vì nó chỉ bake MỘT LẦN lúc xuất; mặt nạ Video bake lại
     mỗi lần nhích thanh trượt. Sửa: tách `maskValueAtNorm(m, ...)` KHÔNG chuẩn hoá cho vòng lặp,
     caller chuẩn hoá một lần (`renderMaskGray`, `renderMaskAlphaCanvas`). 428ms -> **29ms**.
  2. `MASK_ALPHA_MAX` 1024 -> **512**: chi phí là BÌNH PHƯƠNG cạnh, mà khung xem trước chỉ cao
     ~500px nên 1024 không thêm chi tiết nào mắt thấy được. 29ms -> **~10ms**. Bản XUẤT đi qua
     `renderMaskGray` ở ĐÚNG kích thước stream nên KHÔNG bị ảnh hưởng.
  3. Gộp vẽ lại về MỖI KHUNG MỘT LẦN (`schedulePreviewRedraw`, rAF): `input` của thanh trượt bắn
     nhanh hơn 60Hz, không gộp thì hàng đợi dài dần và preview trễ hẳn so với tay. Đo 40 sự kiện
     liên tiếp: **5ms tổng** (0.13ms/sự kiện) ở phía trình xử lý sự kiện.
  KẾT QUẢ: một lần vẽ lại preview khi mặt nạ ĐỔI = ~24ms ở hình nặng nhất (Ngôi sao), nhẹ hơn với
  các hình khác; trước đó là ~430ms. Mặt nạ KHÔNG đổi thì cache LRU trả ngay, chi phí ~0.
  CÒN DƯ ĐỊA nếu vẫn thấy nặng: hạ tiếp độ phân giải khi ĐANG kéo rồi dựng lại nét khi thả tay, và
  tránh `toDataURL` mỗi khung (trình duyệt phải giải mã lại data URL cho CSS mask).
- CHỤP KHUNG (`captureCompositeFrame`) phải CẮT LẠI BẰNG PIXEL, không thừa hưởng được preview:
  lane chính cắt bằng sprite mask của Pixi (không có ở canvas 2D), overlay cắt bằng CSS mask (chỉ là
  phép hợp lúc HIỂN THỊ — vẽ chính phần tử đó lên canvas thì ra hình CHƯA cắt). Cả hai đi qua
  `videoMaskedDrawable` với ĐÚNG khung mà đường preview tương ứng dùng (texture cho lane chính, hộp
  `itemBaseSize` cho overlay) nên ba đường không lệch nhau.
  Đã đo: pixel không-đen 207.315 (không mặt nạ) -> 81.071 (mặt nạ tròn) -> 36.328 (thu nhỏ mặt nạ).
- XUẤT VIDEO — cùng 3 chặng với mặt nạ chỉnh màu, nhưng chuỗi filter ĐƠN GIẢN HƠN vì không phải
  phủ lại lên nhánh gốc (mặt nạ kia giữ nguyên hình, mặt nạ này CẮT hình):
  1. Frontend bake PNG XÁM bằng `videoMaskExportPng()` ở ĐÚNG kích thước stream mà filter chạy trên
     đó — nguồn cho clip lane chính (index.html), kích thước gốc của asset cho overlay
     (editing-runtime.js) — vì `blend=multiply` đòi hai ảnh cùng kích thước, không có bước scale nào
     ở giữa. Gắn vào payload dưới khoá `video_mask_png`. Bake ở kích thước THẬT (không kẹp 512 như
     đường preview): bản xuất phải nét đúng độ phân giải video. Chuỗi khung đã bake (hoạt ảnh/
     chuyển cảnh) thì BỎ QUA — frontend đã cắt sẵn vào từng khung PNG, cắt nữa là chồng hai lần.
  2. Backend `normalizeVideoMaskFields()` -> `video_mask_path` qua `materializeColorMaskPng` (tên =
     sha1 nội dung nên nhiều block cùng mặt nạ dùng chung một file). KHÁC mặt nạ chỉnh màu ở cách
     xử lý lỗi: mất mặt nạ chỉnh màu thì bỏ phần chỉnh màu (hình vẫn đúng); mất mặt nạ CẮT HÌNH thì
     không có lựa chọn an toàn nào — NÉM LỖI để cả lần xuất dừng lại.
  3. `AppendVideoMaskFilter()` (core_process.cpp), gọi TRƯỚC bước `scale` ở cả hai đường:
     `,format=rgba,split[vc][ve]; [ve]alphaextract[va]; movie='mask.png',format=gray[vm];
      [va][vm]blend=all_mode=multiply[vam]; [vc][vam]alphamerge[vk]; [vk]null`
     GIỮ NGUYÊN 3 quyết định của mặt nạ chỉnh màu (nạp bằng `movie=` không thêm `-i`; KHÔNG `loop=0`
     vì `blend` chờ input dài nhất -> graph treo; nhân alpha bằng `blend=multiply` chứ không
     `alphamerge` thẳng vì overlay có thể ĐÃ có alpha riêng).
- TEST `npm run test:video-mask` (`tests/scripts/video_mask_export.js`) — 4 ca, đo bằng CHÍNH bản
  xuất vì preview và xuất đi hai đường rất khác nhau:
  · lane chính, "Tách": nửa giữ = màu nguồn, nửa cắt = ĐEN (lộ nền)
  · chữ nhật hẹp: giữa giữ, hai mép cắt — bắt ca "mặt nạ bị lật/lệch trục" mà nửa mặt phẳng không thấy
  · không mặt nạ: hai nửa như nhau — chốt nhánh mới là no-op tuyệt đối
  · OVERLAY: nửa bị cắt phải lộ MÀU LANE CHÍNH bên dưới (không phải đen) — đây mới là chỗ chứng minh
    alpha bị NHÂN chứ không bị GHI ĐÈ, tức quyết định số 3 ở trên thực sự đúng.
- TỐC ĐỘ RENDER (đo trên 1080×1920, 6s @30fps): chuỗi mặt nạ làm ffmpeg chậm thêm **1%**
  (2980ms -> 3015ms) — không đáng để tối ưu. Chi phí thật nằm ở BAKE PNG lúc dựng payload, đã hạ
  bằng `compileMask()`: mọi thứ không đổi theo pixel (cos/sin góc xoay, hw/hh, ngưỡng feather, bán
  kính bo góc) tính TRƯỚC vòng lặp thay vì mỗi pixel một lần. Trên nguồn 1728×3072: Tim 392->228ms,
  Tròn/Chữ nhật ~350->105ms, Sao 304ms (SDF sao vốn nặng). Đây là chi phí MỘT LẦN mỗi block khi
  bấm Xuất, so với ffmpeg chạy hàng phút thì không đáng kể.
```

### Keyframe Transform (Nội Suy Thuộc Tính Theo Thời Gian)

```text
- Lớp NÂNG CAO song song In/Out/Combo (cộng dồn): keyframe cho transform biến thiên theo thời gian.
- Mô hình: item.keyframes / clip.keyframes = { field: [{t, v, e}] } (t = giây cục bộ từ đầu item/clip, v = giá trị, e = easing đoạn RỜI keyframe này). Field hỗ trợ: position_x, position_y, scale, rotation, opacity.
- Engine (text-animations.js):
  - effectiveTransformAt(base, keyframes, t): trả transform HIỆU DỤNG tại t (nội suy field có keyframe, giữ mép trước kf đầu/sau kf cuối); caller áp delta hoạt ảnh In/Out/Combo LÊN TRÊN.
  - keyframeFfmpegExprs(keyframes): biên dịch keyframe -> {x_expr,y_expr,scale_expr,rot_expr,opacity_expr} (token LOCALT, đơn vị native px/%/độ, piecewise + easing KHỚP evalKeyframeField) cho render.
- UI (index.html #clipInspectorPanel):
  - Mỗi thuộc tính transform có cụm ◂ ◆ ▸: hình thoi (.kf-diamond) bật/tắt keyframe tại playhead; 2 mũi tên (.kf-nav) nhảy tới keyframe trước/sau (jumpKeyframeForSelected -> keyframeNavTarget, dùng biên KF_EPS; disable khi không còn keyframe hướng đó). Cụm nằm CÙNG HÀNG với slider (cột "auto" của .inspector-control-row / .fig-field) để không bị wrap.
  - Marker keyframe hiển thị trên block timeline; playhead SNAP vào keyframe (getTimelineSnapTimes cho overlay, getTimelineBlockSnapTimes cho clip main — thêm mốc start/cursor + t cục bộ).
- Ghi keyframe (auto-keyframe): applyTransformToSelected là CHOKE POINT — cả ĐƠN lẫn ĐA chọn đều qua đây; field đã có keyframe -> ghi keyframe tại playhead (đồng thời đồng bộ base = giá trị mới nhất để ô nhập/khung không lệch). Kéo box (handlePreviewBoxDrag) gọi mirrorTransformToKeyframes cho đúng field của thao tác.
- Bảng thông số hiển thị giá trị HIỆU DỤNG tại playhead: getInspectorTargetTransform() trả effectiveTransformAt(...) khi field có keyframe; renderPreviewOverlays() gọi syncInspectorControls + syncKeyframeDiamonds mỗi frame (bỏ qua khi đang gõ) nên panel luôn khớp playhead. renderSelectionBox cũng dùng effectiveTransformAt để khung chọn khớp đối tượng.
- Playhead cố định GIỮA khung nhìn (kiểu DaVinci): "playhead di chuyển" thực chất là cuộn timeline (scrollTimelineToCurrentTime). setVideoTimeFromTimelineTime gọi cuộn NGAY (đồng bộ) thay vì chờ 'timeupdate' async -> nhảy keyframe không bị "đứng hình".
- RENDER keyframe (áp THAY cho transform tĩnh khi có keyframe):
  - Frontend gắn copy.keyframe_expr (overlay, exportPayload) & clip.keyframe_expr (main, timelineForExport).
  - Backend server.js: normalizeKeyframeExprFields whitelist ký tự -> kf_*_expr cho mọi interval + overlay (kể cả image_seq).
  - Sidecar core_process.cpp: AppendKfTransformFilters (rotate TRƯỚC scale để canvas = đường chéo không bị xén) — rotate a='(deg)*PI/180' biến thiên, scale=w/h='...':eval=frame (scale động theo t), opacity qua geq a='clip(op/100,0,1)*alpha' (geq dùng biến T), overlay x/y='(W-w)/2 + kf_pos + anim_offset'. Field không keyframe -> dùng giá trị tĩnh.
  - LƯU Ý: opacity keyframe dùng geq (per-pixel) nên CHẬM ở video full-res; scale/vị trí/xoay dùng filter gốc nên nhanh.
```

### Hiệu Ứng Chuyển Cảnh Giữa 2 Block (Transitions)

```text
- MỤC TIÊU: hiệu ứng chuyển cảnh (fade/slide/wipe/zoom/circle...) giữa 2 block CÙNG LOẠI đứng
  SÁT CẠNH nhau trên cùng lane, kiểu CapCut. Thư viện hiệu ứng đặt ở tab "Chuyển tiếp" của panel
  trái (cạnh Tệp phương tiện/Âm thanh/Văn bản/Hình học/Thư viện).
- NGUYÊN TẮC WYSIWYG (chốt với người dùng): preview trông sao thì render (export) ra y hệt vậy —
  giống hệ thống Hoạt ảnh. MÔ HÌNH THỜI GIAN: "mượn tại điểm cắt" (lấy duration/2 đuôi block A +
  duration/2 đầu block B quanh điểm giao, KHÔNG dùng footage đã cắt bỏ). ÁP CHO: cả lane chính lẫn
  overlay (engine + data model dùng chung).
- Engine RIÊNG: static/js/transitions.js (UMD -> window.Transitions), nạp trước editing-runtime.js
  trong index.html. Muốn thêm hiệu ứng mới: thêm 1 dòng vào TRANSITION_OPTIONS (id = TÊN transition
  của FFmpeg xfade để export ánh xạ 1-1) + nếu cần dáng vẽ riêng thì thêm 1 case trong compose().
  - Danh mục hiện có (22, 3 nhóm): Cơ bản (fade, fadeblack, fadewhite, dissolve); Chuyển động
    (slideleft/right/up/down, wipeleft/right, zoomin, echoshift, spinslam, stretchleft, zoomslide);
    Hiệu ứng (circleopen/close, pixelize, radial, swirl, bokehswing, flashrotate).
    `swirl` ("Xoắn", thêm 2026-08-03), `bokehswing` ("Bokeh đung đưa", thêm 2026-09-11) và BỐN MẪU ĐO
    TỪ VIDEO thêm 2026-09-14 (`flashrotate`, `spinslam`, `stretchleft`, `zoomslide`) là những id KHÔNG
    có transition tương ứng trong xfade — xfade không nắn được theo bán kính, không rắc được hạt sáng,
    cũng không xoay/tách kênh màu/lát gương được. Không sao vì export đã luôn bake khung từ compose().
  - compose(ctx, id, p, w, h, drawA, drawB, opts): compositor canvas 2D generic — nhận 2 callback vẽ lớp
    A (đang ra) / B (đang vào), pha trộn theo tiến độ p∈[0,1]. GĐ1 dùng cho HOVER PREVIEW thumbnail
    (drawA/drawB tô tile mẫu A/B); GĐ3 sẽ tái dùng chính compose() cho preview thật (callback vẽ frame
    video) -> công thức pha trộn DUY NHẤT, không lệch giữa thumbnail/preview/export.
    opts = { fullFrame, duration, fps }: `duration` (giây) + `fps` là đầu vào của CỬA TRẬP (motion blur
    thật, xem "LÀM MƯỢT"); thiếu thì rơi về DUR_DEFAULT / SMOOTH.fps. MỌI call site phải truyền cặp này,
    nếu không đoạn chuyển cảnh đó mất motion blur mà không báo lỗi gì.
  - progressAt/clampDuration: DUR mặc định 0.5s, trần cứng 2.0s (trần động còn kẹp theo thời lượng 2 block).
  - LÀM MƯỢT (thêm 2026-07-26, theo yêu cầu "chuyển cảnh chưa mượt"): easing curve + blur, ĐẶT BÊN TRONG
    compose() nên tự động áp cho MỌI nơi (thumbnail, preview main/overlay, bake export) -> không lệch WYSIWYG.
    - EASING: p tuyến tính (progressAt = biến P của xfade) -> easeProgress(id, p) theo EASE_BY_ID: fade/dissolve/
      pixelize/fadeblack/fadewhite = easeInOutSine; slide* & zoomin = easeInOutCubic; wipe*/circle*/radial =
      easeInOutQuad. Nhờ vậy 2 mép vùng chuyển cảnh không còn "bật" cứng.
    - CỬA TRẬP = MOTION BLUR THẬT (thay bản blur giả, 2026-08-03, theo yêu cầu "mượt như fps cao"):
      NGUYÊN NHÂN gốc của "lộ từng frame": hiệu ứng CÓ CHUYỂN ĐỘNG dịch quá xa trong 1 khung xuất —
      trượt ngang 1920px/0.5s @30fps với easing inOutCubic (đạo hàm đỉnh = 3) nhảy ~380px/khung.
      Máy quay thật không bị vì cửa trập MỞ suốt khung -> ảnh ghi được là TRUNG BÌNH mọi vị trí trong
      khung đó. compose() làm đúng vậy: dựng N MẪU CON trải trong khoảng thời gian của chính khung rồi
      lấy TRUNG BÌNH ĐỀU (vẽ mẫu k lên bộ tích luỹ với alpha 1/(k+1) = trung bình cộng chuẩn) —
      tương đương render ở fps cao gấp N lần rồi gộp, nên chuyển động liền mạch thật chứ không phải
      "làm mờ cho đỡ thấy".
      - Áp cho slide*/zoomin (motionSpanPx). Số mẫu TỰ CO GIÃN: n = ceil(quãng đường px / 5) + 1, trần
        SHUTTER_MAX_TAPS = 16; khe còn sót giữa 2 mẫu được lấp bằng 1 lượt blur = nửa khe.
      - Độ mở cửa trập tính từ opts.duration + opts.fps: dpFrame = 1/(duration×fps). KHÉP DẦN về 0 ở 2
        mép vùng (shutterHalf = min(dpFrame/2, raw, 1-raw)) -> khung ĐẦU vẫn đúng bằng A, khung CUỐI
        đúng bằng B (điều kiện của mẹo chồng 1 frame khi export).
      - fps THAM CHIẾU: preview truyền transitionRefFps() = fps Sequence (chính là mặc định ô fps khi
        xuất), đường bake truyền thẳng fps xuất -> preview và export mờ bằng nhau. Chọn fps xuất KHÁC
        fps Sequence thì preview lệch một chút (chấp nhận được, không ảnh hưởng file ra).
    - BLUR bell-curve: giờ chỉ là ĐƯỜNG LÙI khi không lấy được mẫu con (thiếu fps/thời lượng, shutter=0,
      hoặc không có canvas nháp). BLUR_PEAK[id] px @1080p (slide 14, zoomin 10, fadeblack/white 9) nhân
      bell(p) = sin(πp)^0.75, nhân unitPx = min(w,h)/1080. fade/dissolve/pixelize = 0 (2026-08-03): pha
      trộn alpha KHÔNG có chuyển động hình học nên không hề "nhảy frame", blur chỉ làm mất nét vô ích.
      fadeblack/fadewhite dùng halfRamp (A mờ dần vào màu, B nét dần ra khỏi màu) thay bell.
    - FEATHER thay mẫu con cho hiệu ứng CÓ ĐƯỜNG BIÊN (rẻ hơn nhiều, kết quả tương đương vì chỉ có biên
      động): FEATHER_PX = mức TỐI THIỂU (wipe 28, circle 24, radial 20 @1080p), NỚI LÊN bằng quãng đường
      biên đi trong 1 khung (boundarySpanPx, cùng nguyên lý cửa trập), chặn trần FEATHER_MAX_GROW = 6×
      mức tối thiểu để nan quạt quay nhanh không loang hết khung.
      wipe = mặt nạ linear-gradient, circle = radial-gradient (edgeMask/circleMask, biên dịch ra ngoài nửa độ
      nhoè ở 2 đầu nên p=0 chưa lộ gì / p=1 lộ hết), radial (nan quạt) = vẽ mặt nạ hình quạt trên canvas CÓ ĐỆM
      rồi blur chính mặt nạ (canvas không có conic-gradient).
    - compose(..., opts.fullFrame): lớp A/B là khung ĐẦY & ĐỤC (lane chính + thumbnail) -> drawBlurred vẽ vào
      canvas nháp có đệm rồi KÉO GIÃN hàng/cột pixel ngoài cùng ra vùng đệm (edge-clamp, đệm = 3×bán kính blur)
      để nhân blur ở 4 mép có dữ liệu -> mép khung KHÔNG bị mờ/tối thành viền và KHÔNG phải phóng ảnh. Overlay
      (lớp trong suốt) KHÔNG đệm vì blur toả ra ngoài mép item mới đúng.
    - Canvas nháp DÙNG LẠI (scratchPool, không cấp phát mỗi frame), mỗi index MỘT VAI TRÒ CỐ ĐỊNH để 2 chỗ
      lồng nhau không giẫm lên nhau: 0 = lớp ảnh (blur/mask), 1 = mặt nạ nan quạt, 2 = bộ tích luỹ cửa trập,
      3 = mẫu con cửa trập, 4 = mặt nạ hạt (dissolve), 5 = ảnh thu nhỏ (pixelize), 6/7 = nguồn/đích
      phép nắn xoắn, 8/9 = ảnh nền và lớp hạt sáng của "Bokeh đung đưa". SUPPORTS_FILTER kiểm
      'filter' in ctx 1 lần; không có (môi trường test Node) -> tự bỏ blur / dùng clip biên cứng, compose vẫn chạy.
    - Transitions.setSmoothing({easing, blur, feather, shutter, fps}) để tinh chỉnh/tắt (shutter:0 = tắt motion
      blur thật và rơi về blur bell-curve; blur:0, feather:0, easing:false).
    - HAI HIỆU ỨNG ĐƯỢC LÀM ĐÚNG DÁNG (2026-08-03, trước đó chỉ là crossfade xấp xỉ):
      - dissolve "Hoà tan": mặt nạ HẠT ngưỡng — trường nhiễu 128×128 sinh bằng xorshift32 HẠT GIỐNG CỐ ĐỊNH
        (KHÔNG dùng Math.random, nếu không preview và export ra 2 kết quả khác nhau = mất WYSIWYG), mỗi ô có
        ngưỡng riêng, p vượt ngưỡng thì ô đó hiện; vẽ ở độ phân giải thấp rồi phóng to CÓ nội suy -> mép mảng
        mềm. Nhờ vậy nhóm 1 của Magic Fill có 2 hiệu ứng KHÁC NHAU thật (trước đây fade và dissolve y hệt).
      - pixelize "Vỡ hạt": thu nhỏ rồi phóng to KHÔNG nội suy, cạnh ô = 1 + 48×unitPx×bell(p) (to nhất ở
        giữa vùng), 2 lớp cùng vỡ hạt + crossfade.
    - zoomin "Phóng to" ĐỔI DÁNG (2026-08-03): cú ĐỘI KHUNG liên tục qua điểm giao — A nở 1→1.25, B nhận tiếp
      ở 1.25 rồi lún về 1. Bản cũ cho B bắt đầu ở scale 0.4 nên B nhỏ hơn khung -> HỞ NỀN quanh B (viền đen);
      bản mới cả 2 lớp LUÔN ≥ 100% nên không bao giờ hở.
    - echoshift "Phóng chồng bóng" (2026-09-11, dựng theo VIDEO MẪU người dùng đưa:
      "Effect Demo/Transition/Transitions-Echo Shift.mp4", cùng cách trừ nền với bản "No effect"
      như bokehswing):
      - CÁI TÊN ĐÁNH LẠC HƯỚNG. "Echo Shift" nghe như vệt bóng + dịch chuyển, nhưng đo thì KHÔNG có
        thứ nào trong đó. Đã loại trừ từng cái, mỗi cái bằng một phép đo riêng:
        · dịch chuyển — tương quan pha cho (0,0) ở mọi khung;
        · xoay — dò lưới −6°..+6° luôn cho đỉnh ở đúng 0°;
        · vệt phóng (echo hình học) — tỉ lệ năng lượng biên XUYÊN TÂM / TIẾP TUYẾN ở ba vành
          r=200..400 / 500..700 / 800..1050 nằm trong 0.92..1.09 ở mọi khung, đúng bằng mức của bản
          không hiệu ứng; có vệt phóng thì tỉ lệ này phải tụt hẳn ở vành ngoài;
        · echo theo THỜI GIAN — khớp khung thành tổng các bản trễ k khung (nội dung base[n−k] ở tỉ lệ
          s(n−k), k=0..9) dồn TOÀN BỘ trọng số vào k=0;
        · đổi màu/tương phản — khớp y = a + b·x cho ba kênh ra hệ số y hệt nhau.
        Cái thấy được là BÓNG ĐÔI của hai lớp cùng đội khung nhưng lệch pha nhau rất xa. Ghi lại đủ
        năm phép loại trừ ở đây vì chúng tốn nhiều công hơn cả phần dựng, và người sau đọc cái tên
        sẽ đi đúng vào những ngõ cụt đó.
      - VÙNG: khung 92..137 = 46 khung = 1.53s, đối xứng quanh điểm cắt.
      - DÙNG CHUNG đường vẽ với zoomin (một `case` cho cả hai trong composeAt): cùng cấu trúc hai lớp
        đội khung ngược chiều, cả hai LUÔN ≥ 100% nên không bao giờ hở nền. Khác nhau đúng ba chỗ:
        · BIÊN ĐỘ `ECHO_MAG` = 1.60 (zoomin 1.25). Suy từ số đo TRỰC TIẾP: tại điểm cắt hai lớp cùng
          ở cỡ 1.30 (đo lớp A được 1.302, lớp B 1.298 — hai phép đo độc lập trên hai nguồn ảnh khác
          nhau, trùng nhau tới 0.004), nên biên độ = 1 + 2·(1.30 − 1).
        · NHỊP ĐỘI KHUNG `ECHO_ZOOM` là BẢNG SỐ ĐO, ghép từ hai nửa độc lập: nửa đầu (sA − 1)/0.6 đo
          trên lớp A, nửa sau (1.60 − sB)/0.6 đo trên lớp B; hai nửa nối liền lạc tại p=0.489 (cùng
          cho 0.503). Đã thử ease có sẵn: easeInOutQuad lệch tới 0.05 ở nửa sau (≈33px sai chỗ ở góc
          khung 1080×1920 — đủ thấy rõ khi chồng hai khung), easeInOutCubic lệch 0.04 ở đoạn đầu.
          Đường thật KHÔNG đối xứng (lên chậm, xuống nhanh) nên không hàm inOut nào tả được.
        · ĐỔI ẢNH `echoMix` là đường RIÊNG, KHÔNG đi theo nhịp đội khung (zoomin dùng thẳng p đã ease
          làm alpha). Đây là cả tính cách của mẫu: ảnh đổi được một nửa ở p≈0.385 trong khi nhịp đội
          khung mới ở 0.26, nên lúc hai lớp ngang nhau thì A đang ở 1.16 còn B ở 1.44 — chênh hẳn một
          phần tư khung hình. Đây là khác biệt CẤU TRÚC duy nhất so với zoomin (zoomin dùng thẳng p
          đã ease làm alpha nên không diễn đạt được), nhưng xem mục bóc tách bên dưới: về LƯỢNG nó
          chỉ đóng góp +0.013.
          `ECHO_MIX_END` = 0.77 được CHỌN BẰNG HAI TIÊU CHÍ ĐỘC LẬP cùng chỉ vào một chỗ: đo trực
          tiếp tỉ lệ hai lớp cho điểm giữa 0.38; và quét 0.68/0.72/0.77/0.84/0.92 rồi so từng khung
          dựng ra với KHUNG MẪU thì 0.77 cho tương quan cao nhất (0.959 so với 0.956/0.957).
      - CÁI NÀO MỚI THẬT SỰ TẠO RA KHÁC BIỆT (phép bóc tách, cộng dồn từng thay đổi rồi so từng
        khung dựng ra với khung mẫu — tương quan trung bình trên 23 khung):
            'zoomin' nguyên bản                 0.763
            + biên độ 1.60                      0.920   (+0.157)
            + bảng nhịp đội khung đo được       0.947   (+0.027)
            + đổi ảnh tách khỏi nhịp phóng      0.960   (+0.013)
        BIÊN ĐỘ chiếm gần hết khoảng cách. Ghi lại vì nó sửa một ấn tượng sai dễ mắc (người viết ra
        nó đã mắc): phép tách đường đổi ảnh nghe thì "kiến trúc" nhất nhưng về lượng là nhỏ nhất.
        Đối chiếu sàn: 'zoomin' như đang có đạt 0.768 với chính mẫu này, còn 'Mờ dần' 0.718 — tức cú
        phóng của zoomin chỉ nhích hơn "không phóng gì" 0.05, nên KHÔNG thể coi echoshift là zoomin
        chỉnh thông số cho đẹp: cùng cơ chế, nhưng zoomin ở biên độ của nó không dựng lại được mẫu.
      - CHỖ CỐ Ý LỆCH SỐ ĐO: mẫu (CapCut) dựng khung SẮC NÉT, không có motion blur, dù ở đoạn nhanh
        nhất cỡ ảnh đổi 0.058/khung (≈64px ở góc). Ta vẫn để CỬA TRẬP của engine chạy (motionSpanPx
        khai theo ECHO_MAG) — cùng chính sách đang áp cho slide*/zoomin, và là chỗ engine CỐ Ý làm
        hơn CapCut ("mượt như fps cao"). Tắt bằng Transitions.setSmoothing({shutter: 0}).
      - CHI PHÍ: 0.3 ms/khung ở 1080×1920 (zoomin 0.2) — không đáng kể.
      - VERIFY: p=0 ra ĐÚNG khung A và p=1 ĐÚNG khung B (lệch 0/255); alpha 4 góc + 4 mép ≥ 253/255 ở
        21 mốc p; và phép kiểm mạnh nhất — dựng lại 23 khung bằng CHÍNH nguồn của video mẫu rồi so
        với khung mẫu tương ứng cho tương quan TRUNG BÌNH 0.959 (0.999 ở hai mép, thấp nhất 0.86).
        Phần hụt còn lại là do tư liệu: bản "No effect" chỉ có lớp A tới điểm cắt và lớp B từ điểm
        cắt, nên nửa kia phải giữ khung đông cứng, mà cảnh là người đang nói.
    - swirl "Xoắn" (2026-08-03, dựng theo VIDEO MẪU người dùng đưa: "Thư viện hiệu ứng mẫu/Be /Be Xoan.mp4"):
      ảnh bị XOÁY quanh tâm, `angle(r) = turns·2π·(1 − r/R)^FALLOFF`. FALLOFF > 1 nên MÉP khung gần như
      không xoáy, xoáy dồn vào vùng giữa — đúng dáng mẫu (mẫu giữ được cấu trúc kệ ở sát viền trong khi
      giữa khung đã nhoè thành vệt). Chuyển vị = r·angle đạt đỉnh ở khoảng nửa bán kính -> vệt dài nhất ở
      vùng giữa. Ramp `(1 − |2p−1|)^3`: 1/4 đầu gần như phẳng rồi bung lên ở điểm cắt; bằng 0 đúng ở 2 mép
      nên khung ĐẦU = A, khung CUỐI = B (giữ mẹo chồng 1 frame khi export). CẮT THẲNG ở p=0.5, KHÔNG
      crossfade — ở đỉnh ảnh không còn nhận ra nên mắt không thấy điểm cắt; mẫu cũng cắt thẳng.
      Hằng số đã dó theo mẫu: turns 0.8, FALLOFF 1.6, ramp^3, zoom 0.10.
      - Đây là hiệu ứng DUY NHẤT phải nắn TỪNG PIXEL (canvas 2D không có shader). Tối ưu: r của từng pixel
        không đổi theo tiến độ -> tính 1 lần/kích thước (cache Map tối đa 3 kích thước, vì thumbnail 120×68
        và preview 1080×1920 xen kẽ liên tục sẽ thrash nếu chỉ cache 1 ô); cos/sin chỉ phụ thuộc r -> bảng
        tra 1024 nấc/khung thay vì 2 triệu lần gọi trig; lấy mẫu song tuyến, trải phẳng các kênh; alpha bỏ
        nội suy khi fullFrame (lớp đục -> luôn 255).
      - KHÔNG lấy mẫu con cửa trập (motionSpanPx = 0, BLUR_PEAK = 0): bản thân phép nắn ĐÃ kéo pixel thành
        vệt xoáy (đó chính là "vệt" thấy ở mẫu, không phải motion blur), thêm 16 lần nắn/khung là chậm gấp
        16 lần mà không đẹp hơn.
      - CHI PHÍ (đo thật, 1080×1920, Electron M1 Pro): ~340–430ms/khung ở đỉnh, ~8.5s cho TRỌN một vùng
        chuyển cảnh 31 khung. Magic Fill chỉ dùng swirl cho ĐÚNG MỘT điểm giao (cờ Hook) nên export chỉ
        cộng ~8.5s — không đáng kể. ĐÁNH ĐỔI: khi playhead đi qua đúng vùng đó, PREVIEW rớt xuống ~2–3fps
        trong 0.5s. Nếu đặt TAY swirl vào nhiều điểm giao thì chi phí nhân lên theo số điểm.
      - VERIFY: endpoint p=0 cho ra ĐÚNG khung A và p=1 ĐÚNG khung B (so pixel, khớp tuyệt đối); alpha 4
        góc + 4 mép ≥ 250/255 ở 21 mốc p (không hở nền dù ảnh xoáy ra ngoài — nhờ KẸP mép khi lấy mẫu +
        zoom 0.10); dải khung của engine dựng ở đúng các mốc p của mẫu (khung 64→80, cắt ở 72) trùng dáng
        và trùng NHỊP với mẫu.
    - bokehswing "Bokeh đung đưa" (2026-09-11, dựng theo VIDEO MẪU người dùng đưa:
      "Effect Demo/Transition/Transitions-Bokeh Swing.mp4"):
      - CÁCH ĐO — TRỪ NỀN BẰNG BẢN "NO EFFECT". Trong cùng thư mục mẫu có "Transitions-No effect.mp4":
        CÙNG hai clip, CÙNG độ dài (227 khung @30fps), chỉ khác là cắt thẳng. Nhờ nó biết được ĐÚNG nội
        dung lớp A và lớp B ở từng khung, nên mọi con số dưới đây là hiệu số THẬT chứ không phải ước
        lượng bằng mắt. Điểm cắt tìm bằng chênh lệch giữa 2 khung liền kề của bản "No effect" (vọt lên
        99/255 ở 113|114); kiểm lại bằng tương quan chéo rằng CẢ HAI clip đúng vị trí thời gian như bản
        "No effect" (không bị dịch) — nếu không thì mọi phép trừ nền sau đó đều vô nghĩa.
      - VÙNG: khung 87..141 = 54 khung = 1.80s, ĐỐI XỨNG quanh điểm cắt.
      - KHÔNG có phép biến đổi hình học: dò tương quan trên lưới xoay −8°..+8° × phóng 0.94..1.15 cho
        đỉnh ở ĐÚNG 0°/1.0 ở mọi khung, tương quan pha cho dịch chuyển (0,0). "Swing" trong tên mẫu là
        chuyển động của HẠT SÁNG, không phải của khung hình — chỗ dễ đoán sai nhất của mẫu này.
      - BA ĐƯỜNG CONG LỆCH PHA NHAU, nên `bokehswing` giữ p TUYẾN TÍNH ở EASE_BY_ID (giống swirl) và
        BLUR_PEAK = 0 (độ mất nét là DÁNG của hiệu ứng, không đi qua SMOOTH.blur — tắt smoothing không
        được làm hiệu ứng mất một nửa tính cách):
        · ĐỔI ẢNH (bokehMix): smootherstep trên p 0.19..0.57, điểm giữa p≈0.38 — SỚM hơn điểm cắt
          (p=0.5) chừng 7 khung. Đo bằng khớp bình phương tối thiểu CÓ LOẠI ĐIỂM NGOẠI LAI (bỏ 60% điểm
          sáng nhất, vì hạt bokeh làm hỏng phép khớp): alpha lớp B đi 0.23 -> 0.76 trong p 0.33..0.44.
          Ảnh đổi ngay lúc ánh sáng mạnh nhất nên mắt không bắt được cú chuyển.
        · MẤT NÉT (bokehDefocusPx): cửa sổ HẸP HƠN cả vùng — 0 ở p≈0.10, đỉnh 2.2px@1080 ở p≈0.41, hết
          ở p≈0.74. Đo bằng tỉ lệ năng lượng tần số cao so với bản gốc (tụt còn 0.52 ở khung 108) rồi
          hiệu chuẩn bằng cách làm mờ CHÍNH khung gốc để quy ra sigma. Hạt sáng còn bay tới p=1 trong
          khi ảnh ĐÃ nét lại từ p≈0.75 — hai cửa sổ này không được gộp làm một.
        · ÁNH SÁNG (BOKEH_ENV): BẢNG SỐ ĐO, KHÔNG phải hình chuông. Dáng thật có ba đoạn mà không hàm
          trơn hai tham số nào tả được: bật lên ~0.18 rồi GIỮ NGUYÊN (p 0.09..0.15), leo dần và BÙNG ở
          p≈0.37, rồi rụng nhanh nhưng để lại ĐUÔI THẤP kéo dài (~0.12 suốt p 0.74..0.82; hình chuông
          cho 0.59 ở đó). Đo bằng TRUNG VỊ của phần cộng thêm (trung vị = miễn nhiễm với hạt sáng),
          đỉnh 66/255.
      - HẠT: vẽ bằng GRADIENT theo bảng sinh từ PRNG hạt giống cố định — cùng ba lý do với dissolve và
        với hình tự vẽ của text template: WYSIWYG (Math.random thì preview và export ra hai kết quả),
        không phải tải thêm tài nguyên khi bake, và không chép lại clip bokeh của người khác. Giữ đúng
        số đo: màu #ffb03d (tỉ lệ kênh 1 : 0.72 : 0.28 đo ở vùng chưa bão hoà; ở đỉnh tỉ lệ tự ngả về
        trắng nhờ phép CỘNG bão hoà, không cần màu thứ hai), hướng trôi (−810, −324) px@1080 cho trọn
        vùng (bám vết từng hạt: v ≈ (−15,−6) px/khung), biên đung đưa vuông góc hướng trôi 26px@1080
        (bám vết cho độ lệch khỏi đường thẳng 4–11px), hạt co 35% trong đời.
        · BÁN KÍNH PHẢI LÀ HAI NHÓM, không phải một. Đếm đốm cho trung vị 10–16px và phân vị 90 khoảng
          30–70px — TOÀN hạt nhỏ; nhưng độ phủ sáng lại tới 13.8% khung = 286k điểm ảnh mà cả trăm hạt
          nhỏ không ra nổi một phần tư chừng đó. Xem lại danh sách đốm thì có vài đốm r=115, 142, 248,
          309px: MỘT đốm r=250 đã chiếm 9.5% khung. Phân bố đơn khớp được trung vị thì thiếu hẳn độ
          phủ, khớp được độ phủ thì hạt to bằng nắm tay hết cả.
        · THỜI ĐIỂM hạt sáng nhất rút theo BOKEH_DENSITY (đường mật độ RIÊNG, không dùng chung với
          đường ánh sáng: ở p=0.07 quầng mới bằng 0.16 đỉnh nhưng hạt đã sáng tới +170/255 — hạt không
          mờ đi lúc đầu vùng, chỉ THƯA hơn) bằng nghịch đảo hàm phân phối tích luỹ, và rút PHÂN TẦNG
          ĐỀU chứ không tung xúc xắc; nhóm LỚN cũng chọn theo bước đều trên chỉ số. Tung xúc xắc thì
          hai chục hạt lớn — vốn chiếm gần hết độ phủ — dồn cục theo thời gian, đo ra độ phủ nhấp nhô
          2–3 lần so với mẫu ở cùng một p.
      - OVERLAY: lớp sáng bị cắt theo alpha của chính item (destination-in) trước khi cộng vào. Thiếu
        bước này thì quầng sáng phủ kín khung và item overlay biến mất trong một tấm màu cam.
      - CHI PHÍ: ~2.0 ms/khung ở 1080×1920 (đối chiếu: "Xoắn" ~340–430 ms). Rẻ vì hạt vẽ bằng gradient
        chứ không nắn từng pixel, nên KHÔNG cần dè dặt như với swirl. Cũng không lấy mẫu con cửa trập
        (motionSpanPx = 0): 16 lần dựng lại cả lớp hạt mỗi khung để làm nhoè vài đĩa mềm là không đáng.
      - VERIFY (Electron, 1080×1920, nguồn là chính hai khung của video mẫu): p=0 cho ra ĐÚNG khung A và
        p=1 ĐÚNG khung B (lệch 0/255 — nhờ ĐƯỜNG TẮT bỏ qua canvas nháp ở hai đầu mút; đi qua canvas có
        alpha thì phép làm tròn nhân alpha cho lệch 1/255); alpha 4 góc + 4 mép = 255 ở 21 mốc p; overlay
        không có điểm nào ngoài item bị ánh sáng làm đục; và hai chỉ số dựng lại từ mẫu — quầng sáng
        (trung vị phần cộng thêm) khớp trong ±3/255 ở 15 mốc p, độ phủ hạt cùng bậc và cùng dáng.
    - BỐN MẪU ĐO TỪ VIDEO (2026-09-14): flashrotate "Chớp sáng xoay", spinslam "Xoay đập",
      stretchleft "Kéo giãn trái", zoomslide "Phóng trượt". Dựng theo bốn video mẫu người dùng đưa
      trong "Effect Demo/Transition" (Flash & Rotate / Spin Slam / Stretch Left / Zoom Slide).
      - CÁCH ĐO: y như bokehswing/echoshift — TRỪ NỀN với "Transitions-No effect.mp4" cùng thư mục (cả
        năm bản 227 khung @30fps, CÙNG điểm cắt cứng 113|114, chênh lệch 2 khung liền kề vọt lên 98/255),
        nên biết ĐÚNG nội dung lớp A và lớp B ở từng khung. Từng khung hiệu ứng khớp bằng cách NẮN khung
        gốc (phóng / xoay / trượt, lấy mẫu song tuyến KẸP MÉP) rồi dò tham số cho tương quan cao nhất;
        độ sáng đo RIÊNG bằng TRUNG VỊ từng kênh (trung vị không bị vùng cháy sáng kéo lệch — phép khớp
        y = k·x + c thì bị vệt mờ làm tụt k và thổi phồng alpha lên 0.69 thay vì 0.50).
      - CẤU TRÚC CHUNG (MEASURED trong transitions.js, một đường vẽ drawMeasured dùng chung cho cả bốn):
        mỗi lúc chỉ MỘT lớp trên khung, đi theo BẢNG SỐ ĐO của riêng nó; ĐỔI ẢNH là cú CẮT THẲNG tại
        `swap`, KHÔNG hoà mờ; `swap` KHÔNG nằm giữa vùng (0.523–0.641) vì cả bốn mẫu lấy nhiều khung
        trước điểm cắt hơn sau. Cả bốn giữ p TUYẾN TÍNH ở EASE_BY_ID (bảng số đo đã mang sẵn nhịp; ép
        thêm easing là uốn cong hai lần) và BLUR_PEAK = 0 (có chuyển động hình học thật nên CỬA TRẬP tự
        tạo vệt mờ; measuredSpanPx() nói cho cửa trập biết quãng đường cộng từ trượt + phóng + xoay).
      - flashrotate: BA ĐƯỜNG LỆCH PHA. Phóng lớp A lên 1.50 (đỉnh p≈0.30) rồi TỤT XUỐNG 0.76 ở điểm
        đổi ảnh ("hít vào rồi ném đi"); XOAY không có tí nào suốt 40% đầu vùng rồi bung 34.6° trong 5
        khung cuối, lớp B nhận tiếp ở −26° và tở về 0 (hai lớp CÙNG CHIỀU kim đồng hồ); CHỚP TRẮNG
        trung tính (R:G:B = 1 : 1.01 : 1.05), đỉnh 0.50 tại điểm đổi ảnh, tắt hẳn ở p=0.80. Bằng chứng
        chớp là một LỚP TRẮNG ĐÈ LÊN chứ không phải chỉnh sáng: khớp y = k·x + c cho c ≈ 255·(1−k) ở
        MỌI khung, sai dưới 0.02.
      - spinslam: lớp A phóng 1.00 -> 1.50 và xoay 0° -> 27°, cả hai TĂNG TỐC (nửa đầu đi 16% quãng
        xoay, nửa sau 84%); lớp B vào ở 0.82 — NHỎ HƠN khung — nghiêng −19° rồi nở và tở về 0 trong 18
        khung (cú "đập"). TÁCH MÀU: kênh ĐỎ lệch trái, LAM lệch phải đúng bằng nhau, LỤC đứng yên, CHỈ
        theo phương ngang (thành phần dọc đo được 0.0 ở mọi khung), nửa biên độ 5/10/15px@1080 ở ba
        khung trước điểm cắt rồi tắt trong 3 khung sau. Đã LOẠI TRỪ giả thiết "quang sai theo bán kính":
        dò tỉ lệ phóng riêng từng kênh cho chênh lệch 0.000.
      - stretchleft: mẫu DUY NHẤT có vùng ĐỐI XỨNG quanh điểm cắt. KHÔNG phóng, KHÔNG xoay, KHÔNG đổi
        sáng — chỉ TRƯỢT NGANG. Lớp A sang TRÁI tăng tốc rất mạnh (0.03 bề khung ở p=0.14 -> 0.74 ở
        p=0.49; quãng đi trong một khung ở cuối gấp ~40 lần lúc đầu — chính chỗ đó sinh ra vệt nhoè mà
        mắt gọi là "kéo giãn"); lớp B vào từ PHẢI ở 0.29 rồi dịu về 0 trong 20 khung. LÁT GƯƠNG chứ
        không phải nền đen: so ba giả thiết lấp mép (kẹp mép / lật gương / cuộn vòng) trên từng khung,
        lật gương thắng ở MỌI khung và cách biệt nới dần (khung 111: 0.650 so với 0.480 và 0.534).
        CHỖ KHÔNG ĐO ĐƯỢC: quãng trượt của lớp A sau p≈0.49 — lát gương có chu kỳ đúng 2 bề khung nên
        dịch 1.48 và dịch −0.50 cho ra ảnh Y HỆT, phép khớp trả về cả hai với cùng điểm số; lấy theo đà
        tăng tốc đo được ở 5 khung trước đó thì tới điểm đổi ảnh là ≈ 1.00.
      - zoomslide: phóng lớp A 1.00 -> 2.33 (60% quãng phóng dồn vào 8 khung, p 0.35..0.48) kèm NGHIÊNG
        tới −14.5° (dò lưới góc ở khung 106: tương quan 0.990 ở −14.5° so với 0.569 ở 0° — nghiêng là
        có thật), rồi TRƯỢT sang PHẢI trong khi cú nghiêng TỞ NGƯỢC về −3°; lớp B vào từ TRÁI ở 2.57,
        nghiêng NGƯỢC LẠI +18°, rồi về giữa và lún về 1.
        · CỬA SỔ HAI LỚP (chỉ mẫu này): đây là một cú TRƯỢT nên có mấy khung cả A lẫn B cùng trên khung
          — khung 114 của mẫu có độ sáng trung bình 108, nằm giữa A (153) và B (74), tức ~43% vẫn là A.
          Ba mẫu kia KHÔNG có (độ sáng ở khung đổi ảnh chỉ lệch 6% khỏi lớp mới) nên chúng cắt thẳng.
          Bề rộng cửa sổ [0.609, 0.652] chọn bằng cách dựng lại cả vùng rồi so với video mẫu: 3 khung
          cho tương quan trung bình 0.947, nới ra 5 khung tụt còn 0.945, bỏ hẳn còn 0.939.
        · ĐO KÉM TIN CẬY NHẤT CỦA CẢ BỐN MẪU: khung 114..116 (hai lớp chồng nhau + vệt mờ mạnh nhất)
          chỉ khớp được 0.50 / 0.74 / 0.79, so với 0.97+ ở mọi khung khác. Giả thiết "hai lớp đi liền
          nhau như một dải phim" đã thử và MÂU THUẪN với số đo: suy từ vị trí lớp B ở khung 114 thì lớp
          A phải ở 1.73 bề khung, suy từ khung 115 lại ra 1.27 — lớp A không thể lùi lại. Góc nghiêng ở
          khung 114 (+14.2°) bị BỎ vì là mẫu tương quan thấp nhất (0.503) và đi ngược chiều tở cả đoạn.
        · GIAO DIỆN CAMERA (ZOOM_UI_*): mẫu vẽ thêm một lớp đồ hoạ mô phỏng màn hình camera điện thoại —
          khung lấy nét vàng 188px@1080 giữa khung (hộp bao x 446..633, y 866..1053, ĐỨNG YÊN so với
          khung hình ở mọi khung), vòng số zoom cong ở đáy, số bội và tiêu cự. KHÔNG phải nội dung của
          hai clip: bản "No effect" ở cùng những khung đó không có gì. Vòng số là cung tròn bán kính
          ≈480px@1080, tâm dưới đáy khung, thang LÔ-GA-RÍT ≈22° mỗi lần gấp đôi (0.5× ở 0°, 1× ở 22°,
          2× ở 43°, 3× ở 60°; ba vạch chính trên khung 117 khớp đường tròn cho R = 470/496/475, trùng
          nhau trong 3%). Số bội đọc thẳng từ mẫu: 0.5 -> leo tới trần 15 ở khung 107, GIỮ 15 tới khung
          110, rồi 14.9 14.4 12 1.6 và về 0.5 từ khung 115. Con số này KHÔNG bằng cỡ phóng của ảnh
          (ảnh chỉ tới 2.33) — nó là con số của một chiếc máy ảnh tưởng tượng. Màu đo ở 10 điểm sáng
          nhất của con trỏ: (246..248, 204..208, 20..35) -> #f8ce16. Lớp đồ hoạ SỐNG LÂU HƠN phần hình
          (còn rõ tới khung 127, tan 128..131, mất hẳn ở 132; phần hình đã yên từ khung 123) nên vùng
          của mẫu này lấy theo lớp đồ hoạ. Chữ dưới 7px thì BỎ HẲN (UI_TEXT_MIN_PX) — ở ô minh hoạ
          120×68 của panel thì unitPx ≈ 0.06, chữ 2.8px chỉ còn là vệt bẩn; vòng vạch và khung lấy nét
          vẫn vẽ nên ô minh hoạ vẫn nhận ra được hiệu ứng.
      - LẤP MÉP (drawClampExtended, scratch 13): flashrotate (lớp A co 0.76 + nghiêng 34.6° -> hở tới
        47% khung), spinslam (lớp B vào ở 0.82) và zoomslide (lớp B lệch hẳn sang trái ở khung 115, hở
        20% bề ngang) đều ĐO ĐƯỢC là có lấp: 4 góc khung ở vùng hở cho 80..145/255 chứ không phải 0.
        Cách làm: vẽ lớp vào canvas nháp rồi KÉO GIÃN hàng/cột pixel ngoài cùng ra (đúng mẹo của
        drawBlurred). ĐÃ THỬ VÀ BỎ cách "phóng to hẳn lớp lên rồi vẽ đè": nó sinh ra một ảnh THỨ HAI
        to đùng nhìn thấy rõ sau lớp chính (thấy ngay ở spinslam), và đắt hơn. Kẹp mép nâng tương quan
        trung bình của spinslam từ 0.923 lên 0.944. Chỉ làm cho lane chính — lớp overlay vốn trong
        suốt nên để hở mới đúng.
      - TÁCH MÀU trên canvas 2D (drawRgbSplit, scratch 10/11/12): canvas không có bộ lọc tách kênh nên
        vẽ lớp ba lần, mỗi lần 'multiply' với màu nguyên chất (#f00/#0f0/#00f) để dập hai kênh kia, rồi
        CỘNG lại ('lighter') ở ba vị trí lệch nhau. Phải trả alpha về bằng một lượt 'destination-in'
        với chính lớp gốc: 'multiply' làm alpha đặc lại và phép cộng ba kênh cộng luôn cả alpha, thiếu
        bước này thì lớp overlay bị vuông thành một tấm đặc.
      - VERIFY (Electron, dựng lại TỪNG KHUNG của cả bốn vùng rồi so tương quan với video mẫu, nguồn
        lấy từ chính bản "No effect"): trung bình flashrotate 0.959 · spinslam 0.944 · stretchleft
        0.863 · zoomslide 0.947. Kiểm chéo quan trọng hơn con số trung bình: khớp NGƯỢC khung do engine
        dựng ra để lấy lại (cỡ, góc) thì ở spinslam khung 116/117/119 cho (0.90, −12°) / (0.94, −9°) /
        (0.96, −6°) — TRÙNG KHÍT với khớp trên chính khung của video mẫu, và tương quan của engine
        (0.608/0.683/0.781) ngang bằng tương quan mà CHÍNH KHUNG MẪU tự khớp lại được (0.685/0.693/
        0.755). Tức trần ở đây do vệt mờ chi tiết quyết định chứ không phải do bảng số đo sai. Chỗ còn
        thấp là 1–2 khung ngay tại điểm đổi ảnh của mỗi mẫu (mẫu có 1 khung hỗn hợp, engine cắt thẳng).
    - HỆ QUẢ WYSIWYG: compose() KHÔNG còn khớp bit-perfect với xfade tuyến tính -> export PHẢI tiếp tục bake
      PNG từ compose(); nếu sau này muốn dùng xfade native cho nhanh thì phải setSmoothing tắt easing/blur.
    - VERIFY (Electron headless, 1920×1080): p=0 cho ra ĐÚNG khung A và p=1 ĐÚNG khung B (sai lệch 0/255 -> 2
      mép vẫn nét, khớp frame liền kề); alpha 4 mép khung ≥ 250/255 ở mọi hiệu ứng fullFrame (không viền tối);
      thời gian compose 1 frame 1080p ≈ 0.01–0.06ms khi có GPU (≈15ms nếu software render).
    - VERIFY CỬA TRẬP (đo lại 2026-08-03, 960×540, d=0.5s, fps=30): dải PHA TRỘN giữa A và B ở giữa vùng của
      slideleft = 178px khi shutter BẬT so với 28px khi TẮT — đúng bằng quãng đường 1 khung (≈192px), tức
      ảnh smear hết đúng đoạn nó đi qua như phim thật. Endpoint vẫn chính xác (p=0 = A, p=1 = B) cho CẢ 15
      hiệu ứng; zoomin không hở nền ở 21 mốc p; dissolve loang lổ (min 0/max 255 kênh B) còn fade đều tuyệt
      đối (128/128). compose 1 frame 1080p: fade ~0ms, slide 16 mẫu ~0.3ms, dissolve ~0.8ms (có putImageData).
- GIAI ĐOẠN 1 (ĐÃ LÀM): tab "Chuyển tiếp" (index.html data-edit-tab="transition") + panel thư viện
  hiệu ứng trong editing-runtime.js: EDIT_PANEL_SUBTABS.transition (Tất cả + 3 nhóm), state
  editPanelTransitionCat / transitionPickId, renderTransitionPaneHtml() + initTransitionThumbs()
  (vẽ thumb tĩnh p=0.5, hover chạy rAF minh hoạ), chọn card -> highlight is-selected + ghi status.
  CSS .edit-transition-* trong khối style của editing-runtime.js.
- GIAI ĐOẠN 2 (ĐÃ LÀM): Transition Node + băng vùng chuyển cảnh trên timeline (editing-runtime.js).
  - DATA MODEL: lưu NGAY TRÊN block TRÁI của điểm giao -> tự theo undo/redo (deep clone) & .crab.
    Main: latestTimeline[i].transition = {type,duration} (sang clip i+1). Overlay: item.transition
    (sang item kề phải cùng track). normalizeTimelineTransforms & getHistoryState/deepClone giữ field này.
  - transitionBoundaries(): liệt kê điểm giao hợp lệ = 2 block cùng loại CHẠM CẠNH (≤2px) trên main
    (span liền kề, luôn kề) + overlay visual (media/text/shape; audio để sau). boundaryMaxDuration =
    min(DUR_MAX, min(leftDur,rightDur)); boundaryEligible khi min(leftDur,rightDur) ≥ DUR_MIN.
  - TƯƠNG TÁC (thiết kế lại 2026-07-24 theo yêu cầu — DẢI là Node, CHỈ KÉO-THẢ, giống CapCut):
    renderTransitionNodes() (trong renderEditingTimeline) tạo 1 phần tử/điểm cắt, đều có class chung
    .transition-hit + data-key (để hit-test kéo-thả):
    - Điểm cắt ĐÃ CÓ hiệu ứng -> .editing-transition-band (CẢ DẢI SỌC CHÉO là Node TƯƠNG TÁC, pointer-events
      auto, z-index 22, phủ [junction-d/2, junction+d/2]); bên trong có .editing-transition-icon = bowtie ⋈
      (transitionMarkerSvg) CHỈ TRANG TRÍ (pointer-events none) + 2 tay cầm .editing-transition-handle (left/right).
    - Điểm cắt TRỐNG -> .editing-transition-dropzone (mảnh 20px canh giữa seam, opacity 0 + pointer-events none
      -> VÔ HÌNH & không chặn resize block); chỉ hiện (opacity .85) khi ĐANG KÉO (.transition-dnd-active trên
      #segmentsTrack); rê lên -> .drop-target sáng; thả -> thêm mới (duration mặc định).
  - CHỌN / XOÁ NODE (tách khỏi chọn block — sửa 2026-07-24): selectedTransitionKey. selectTransition(b) XOÁ
    selection block/clip (để phím Delete nhắm đúng node) + set key + renderTransitionInspector. mousedown trên
    band stopPropagation (KHÔNG cho chọn/kéo block bên dưới). Listener CAPTURE trên #timelineTrackOuter: mousedown
    ngoài .transition-hit -> deselectTransition (nên click block tự bỏ chọn node). Phím Delete/Backspace: nếu
    selectedTransitionKey -> deleteSelectedTransition (KHÔNG đụng deleteSelectedBlocks). recordHistory trước xoá.
  - RESIZE 2 ĐẦU (kiểu CapCut): kéo .editing-transition-handle -> startTransitionResize -> pointermove tính
    duration = 2 * |pxToTimelineTime(mouseX) - junctionTime| (đối xứng quanh điểm cắt), kẹp [MIN, boundaryMaxDuration].
  - INSPECTOR PHẢI: #transitionInspectorPanel thêm vào #sidebarInspector, hiện khi chọn node (Tên + slider Thời
    lượng + nút Xoá, giống CapCut). Ẩn #clipInspectorPanel bằng class .sidebar-inspector.showing-transition + CSS
    !important (vì updateInspectorState có thể ghi đè display). BỎ HẲN popup nổi (openTransitionSettings), click-để-thêm,
    transitionPickId, is-armed, "Áp cả lane". Thêm/thay hiệu ứng CHỈ bằng KÉO-THẢ.
  - Z-INDEX: .editing-block=20, rail .editing-lane-label=30, band & dropzone=22 (đè block, dưới rail).
  - KÉO-THẢ (cơ chế thêm/thay DUY NHẤT): card thư viện draggable="true"; setupTransitionDnd() (gắn 1 lần)
    bắt dragstart trên #step4 -> dataTransfer 'application/x-crabbycut-transition' + class transition-dnd-active.
    dragover/drop trên #timelineTrackOuter: nearestTransitionNode (query .transition-hit, bán kính 90px, ưu
    tiên trục X) tô .drop-target phần tử gần nhất. Thả lên dải ĐÃ CÓ -> THAY type GIỮ duration cũ; lên dropzone
    trống -> thêm mới. transitionBoundaryCache lưu điểm cắt lần render để hit-test.
  - CACHE-BUST: script tag transitions.js & editing-runtime.js trong index.html gắn ?v=transition-measured-p27 (bump
    mỗi lần sửa JS/CSS transition) để tránh trình duyệt/Electron nạp bản cũ.
  - recordHistory trước mọi thay đổi (undo/redo OK; dirty •).
- GIAI ĐOẠN 3 (ĐÃ LÀM cho OVERLAY, 2026-07-24): preview thời gian thực chuyển cảnh OVERLAY, dùng CHUNG
  window.Transitions.compose (đảm bảo WYSIWYG; GĐ4 export sẽ bake cùng compose ra PNG sequence).
  - MÔ HÌNH "mượn tại điểm cắt": vùng [J-d/2, J+d/2]. Nửa đầu: A sống + B đứng ở khung ĐẦU; nửa sau: B sống +
    A đứng ở khung CUỐI. progress p = (seqTime-(J-d/2))/d.
  - activeOverlayTransition(seqTime) BỎ QUA điểm cắt có item thuộc LANE ĐANG ẨN (sửa 2026-07-29):
    renderPreviewOverlays lọc item theo isItemVisible, nên nếu ở đây không lọc thì 2 item biến mất mà tấm
    composite của chúng VẪN phủ lên preview — hoá ra tắt hiển thị lane lại thấy đúng vùng chuyển cảnh.
    Lọc ở CHÍNH hàm này (không lọc ở chỗ vẽ) để suppressedTransitionItemIds cũng nhất quán theo.
  - activeOverlayTransition(seqTime): tìm điểm cắt overlay đang trong vùng. renderPreviewOverlays: ẩn 2 item
    A/B bằng class .is-transition-hidden (opacity !important — KHÔNG ghi inline để không phá cache setCached,
    tránh item kẹt ẩn sau khi rời vùng) nhưng GIỮ element làm nguồn vẽ; vẽ #transitionPreviewCanvas (z-index 6,
    seq-resolution, phủ vùng letterbox) qua compose(); ngoài vùng -> ẩn canvas.
  - Lấy drawable mỗi lớp (ensureItemDrawable): ảnh/text/shape -> raster cache (transitionRasterCache); video ->
    lớp SỐNG dùng element preview_<id>, lớp ĐỨNG YÊN dùng captureVideoSeamFrame (1 <video> ẩn seek tới mép
    nguồn, cache theo item+time). blitLayer = toán vẽ thuần (transform+anim, NHÂN DỒN vào ctx.globalAlpha để
    compose đặt alpha=p cho fade/dissolve hoạt động — bug đã sửa: trước ghi đè alpha=1). drawTransitionLayer
    (overlay) & drawMainClipLayer (clip lane chính, contain-fit "kích thước nguồn") đều gọi blitLayer.
  - captureSeamFrame(cacheKey, srcUrl, sourceTime): DÙNG CHUNG cho overlay video & lane chính — 1 <video> ẩn
    RIÊNG mỗi src (seamCaptureVideos) seek tới mép nguồn, vẽ ra canvas cache (seamCaptureCache); xong tự
    renderPreviewOverlays lại. Overlay gọi với asset.url; lane chính gọi với video.currentSrc.
  - Hook: 60fps startOverlayPreviewLoop -> renderPreviewOverlays (đã bao) nên chạy cả khi phát lẫn tua/kéo.
- GIAI ĐOẠN 3 LANE CHÍNH (ĐÃ LÀM, 2026-07-24): single <video> -> mỗi thời điểm 1 clip SỐNG, lớp kia = SEAM
  FRAME tĩnh (captureSeamFrame với source_time = clip.end của A / clip.start của B). activeMainTransition(seqTime)
  quét mainClipSequenceSpans tìm điểm cắt lane chính đang trong vùng. renderMainTransitionComposite vẽ
  #mainTransitionCanvas: nửa đầu A=video sống (video.currentTime do jump-cut scheduler/scrub đặt) + B=seam đầu;
  nửa sau B=video sống + A=seam cuối; compose(p). Nền ĐEN qua CSS background của canvas (compose() clear về trong
  suốt -> vùng trống = đen, khớp canvas đen export). Z-INDEX: #mainTransitionCanvas z-index -1 (trong root
  #editingPreviewOverlay z-index 3 -> TRÊN pixi z-index 2, DƯỚI overlay item z auto). Verify: video thật proxy,
  2 clip đoạn nguồn xa nhau -> khung blend hiện đúng, contain-fit đúng, ngoài vùng ẩn. Playback & scrub đều đúng.
- GIAI ĐOẠN 4 EXPORT — BAKE cả overlay lẫn lane chính (WYSIWYG 100%, KHÔNG sửa sidecar C++). Lý do đổi khỏi
  xfade native cho lane chính: xfade LUÔN cho 2 clip đè -> video NGẮN đi d giây/chuyển cảnh + hình khác preview
  (mô hình "mượn tại điểm cắt" giữ tổng thời lượng). Bake full-res khớp preview + giữ thời lượng.
  - GĐ4 OVERLAY (ĐÃ LÀM frontend, 2026-07-24): exportPayload -> appendOverlayTransitionItems: với mỗi điểm cắt
    overlay có transition, bakeTransitionSequence bake vùng [J-d/2, J+d/2] thành chuỗi PNG full-frame (seq-res)
    bằng CHÍNH Transitions.compose + drawTransitionLayer (mô hình mượn tại điểm cắt: nửa đầu A live+B khung đầu,
    nửa sau B live+A khung cuối) -> {fps, seq{frames}}. Tạo 1 ITEM TỔNG HỢP id 'trans_<Aid>' type 'text' +
    rendered_text_png 1×1 trong suốt (để qua guard asset ở server.js:2178) + animation_render -> backend
    normalizeEditingPayload biến thành overlay asset_type 'image_seq' (path đã chứng minh của hoạt ảnh text/ảnh,
    KHÔNG sửa backend/sidecar). TRIM 2 item gốc để không chồng vùng: A.duration -> tới J-d/2; B.timeline_start ->
    J+d/2, source_start += d/2. prepareExportLayer: ảnh/text/shape = raster tĩnh; video overlay = khung tĩnh mép
    (captureSeamFrameAsync — approx v1, per-frame nâng cấp sau). Verify: payload có item tổng hợp + trim đúng,
    frame giữa decode = blend đúng (khớp preview). Chạy FFmpeg thật để xác nhận end-to-end (rủi ro thấp, tái dùng path cũ).
    - FIX FLICKER 1 FRAME (2026-07-24): trim mép A không snap lưới frame -> hở 1 frame với item transition (đã
      snapT ở backend) -> block trước mất hình 1 frame trước chuyển cảnh. Sửa: SNAP winStart/winEnd = round((J∓half)*fps)/fps;
      A kéo dài tới winStart + 1 frame (chồng đầu transition), B bắt đầu winEnd − 1 frame (chồng cuối transition) ->
      KHÔNG còn khe hở. Phần chồng VÔ HÌNH vì frame đầu transition = A (p=0, clip chưa dịch), frame cuối = B (p=1).
      LƯU Ý: overlay BẮT BUỘC trim (không thể "không trim + phủ" như lane chính) vì composite overlay TRONG SUỐT
      -> nếu không trim, item gốc lòi ra ở vùng đã trượt (slide/wipe) -> nhân đôi hình. (Lane chính không trim được
      vì composite ĐỤC nền đen phủ clip liên tục.)
  - GĐ4 LANE CHÍNH (ĐÃ LÀM frontend, 2026-07-24): exportPayload -> appendMainTransitionItems: mỗi điểm cắt lane
    chính có transition -> bakeMainTransitionSequence bake vùng thành chuỗi PNG full-frame nền ĐEN (opaque). Lớp
    SỐNG = frame FULL-RES seek từ /temp_uploads/temp_input.mp4 (captureSeamFrameAsync); lớp TĨNH = seam frame mép
    (A.clip.end / B.clip.start). Vẽ qua drawMainClipLayer(...nativeRes=TRUE) -> fit=1 (frame đã full-res, KHÔNG
    dùng contain-fit theo proxy). Item tổng hợp 'maintrans_<i>' đặt track_id='track_main' -> track_order cao nhất
    trong visual -> composite ĐÁY stack overlay (phủ [mainv], dưới overlay item khác). Clip chính KHÔNG trim
    (tổng thời lượng giữ nguyên). blitLayer NHÂN DỒN alpha (fade OK). Verify: proxy 2 clip nguồn xa nhau ->
    frame full-res blend đúng (wipe seam thấy rõ). BUG đã sửa khi làm: (a) captureSeamFrameAsync so vid._loadedSrc
    (không so vid.src tuyệt đối) tránh reload vô hạn với URL tương đối; (b) đợi frame decode sau 'seeked' bằng
    setTimeout (rAF/rvfc bị tạm dừng khi tab nền/paused); (c) nativeRes fit=1 (payloadSequence.source_width có thể sai).
  - VẬN CHUYỂN CHUỖI KHUNG + 2 TRẦN CỨNG ĐÃ LÀM CHẾT EXPORT (sửa 2026-08-03, sau khi Magic Fill điền chuyển
    cảnh cho CẢ sequence lần đầu — 13 điểm giao, dọc 1080×1920 @59.94fps). Đo thật trên dự án đó:
    1 khung PNG = 9.5MB (base64 12.7MB), 1 chuyển cảnh = 31 khung -> ~5GB chuỗi base64.
    - CHẾT 1: `JSON.stringify(editing_json)` vượt TRẦN CHUỖI của V8 (~536MB) -> RangeError. Lệnh này ở
      index.html nằm NGOÀI try/catch của luồng xuất nên UI không hiện lỗi gì -> người dùng chỉ thấy
      "render lỗi" kèm log IME của macOS (getApplicationProperty / IMKCFRunLoopWakeUpReliable) vốn KHÔNG
      liên quan. Bài học: log macOS/Electron kiểu đó là tiếng ồn, đừng đi theo nó.
    - CHẾT 2: `seamCaptureCache` giữ MỌI khung đã seek ở ĐỘ PHÂN GIẢI NGUỒN (1728×3072 ≈ 21MB/canvas).
      403 khung -> ~8.5GB canvas. Khung "sống" của bake chỉ dùng ĐÚNG MỘT LẦN nên cache là thuần lãng phí:
      captureSeamFrameAsync nhận thêm `options.cache = false` và cả đường bake dùng nó (kể cả 2 khung tĩnh
      seamA/seamB — chúng đã nằm trong biến cục bộ suốt vòng lặp).
    - SỬA vận chuyển: (a) khung lane chính là khung ĐỤC (nền đen bake vào) -> JPEG q=0.95, đo thật
      438KB/khung, NHỎ HƠN PNG ~23 lần; overlay vẫn PNG vì cần alpha. (b) chuỗi khung KHÔNG còn nằm trong
      editing_json: `exportPayload({collectFile})` đẩy từng khung ra thành PHẦN FILE multipart
      (`transition_frames`), payload chỉ giữ danh sách TÊN trong `seq.frame_files`. Backend
      `materializeAnimationFrameFiles` RENAME file đã upload vào `animf_<id>_<index>/frame_%04d.<ext>`
      (không copy, không giải mã base64) và dọn phần còn sót trong `finally`. Không truyền collectFile thì
      rơi về base64 nội tuyến như cũ (hoạt ảnh text/shape/ảnh vẫn đi đường này — chúng nhẹ).
      Đo lại sau khi sửa: 3 chuyển cảnh -> editing_json 0.004MB, 93 phần file = 31.4MB nhị phân, JS heap
      PHẲNG (12MB -> 6MB). Sidecar KHÔNG phải sửa: image2 tự nhận định dạng theo đuôi file.
    - Đồng thời: trần 12MB/khung của materializeAnimationFrames chặn oan khung PNG 9.5MB và trả null LẶNG LẼ
      (cả đoạn chuyển cảnh biến mất không báo gì) -> nâng lên 24MB + console.warn; regex nhận cả jpeg.
    - Canvas bake DÙNG LẠI theo vai trò (bakeCanvasPool) thay vì createElement mỗi khung (403 khung × 2
      canvas 1080×1920 tự nó cũng đủ giết renderer).
  - EXPORT CHẠY CHỒNG -> FILE MP4 LỖI (sửa 2026-08-03, lần thử render thứ hai của người dùng: "không ra
    file video chuẩn" + "export tự lặp đi lặp lại"). Bằng chứng: 3 report `export_success` trong 90 giây
    (16:40:57 / 16:41:55 / 16:42:22) với 3 mốc client_started_at khác nhau -> frontend gửi 3 lượt xuất; và
    final_cut.mp4 có 29.6MB dữ liệu nhưng header khai `duration=2.002s / 120 khung` cho timeline 44.6s
    (moov dở dang = file bị ghi đè giữa lúc đang viết).
    - NGUYÊN NHÂN: `performVideoExport()` chỉ vô hiệu hoá 2 nút Xuất SAU khi đã dựng xong formData — mà
      bake khung chuyển cảnh nằm NGAY TRONG đoạn đó và tốn hàng phút. Người dùng thấy "không có gì xảy
      ra" nên bấm lại; mỗi lần bấm là một lượt export mới, tất cả cùng ghi TEMP_DIR/final_cut.mp4.
      `btnExportFromStep4` lại không có cả guard `.disabled` như `btnExportVideo`.
    - SỬA (2 lớp): (a) frontend có cờ `videoExportInFlight`, khoá + vô hiệu hoá 2 nút + startStatusPolling
      NGAY DÒNG ĐẦU hàm, nhả trong `finally`; đồng thời TOÀN BỘ phần bake nằm trong try/catch (trước đây
      ở ngoài nên lỗi bake không ai bắt -> UI im lặng, chính là cách lỗi trần chuỗi V8 trốn được);
      (b) backend có `exportInFlight`, lượt thứ hai bị TỪ CHỐI 409 với thông báo rõ ràng. Khoá backend nhả
      theo `res.on('close')` CHỨ KHÔNG theo `finally`: `res.download()` chỉ bắt đầu stream rồi trả về ngay,
      nhả ở `finally` thì lượt sau có thể ghi đè final_cut.mp4 đúng lúc nó đang được tải về.
    - Bake trong tiến trình cũng đã có `setStatusText('Đang dựng khung chuyển cảnh i/n...')` để không bị
      hiểu là treo — đây là gốc rễ của việc bấm nhiều lần.
    - VERIFY quy mô thật (test tự động): 13 chuyển cảnh × 31 khung = 403 phần file trên timeline 45s ->
      video ra 45.50s, `ffmpeg -f null` giải mã sạch KHÔNG cảnh báo, cả 13 chuỗi khung đều materialize; và
      lượt xuất thứ hai gửi trong lúc lượt đầu đang chạy nhận đúng 409. Tức QUY MÔ không phải vấn đề —
      chỉ chạy chồng mới làm hỏng file.
  - LƯU Ý HIỆU NĂNG CÒN LẠI: bake lane chính vẫn SEEK video full-res 1 lần/khung — đo thật ~1s/khung trên
    nguồn 1728×3072 (631MB), tức ~32–64s MỖI chuyển cảnh, và ~10–14 PHÚT cho 13 chuyển cảnh của cả sequence.
    Đã thêm `setStatusText('Đang dựng khung chuyển cảnh i/n...')` để không bị hiểu là treo. Hướng tối ưu kế
    tiếp (chưa làm): khung "sống" trong một vùng chuyển cảnh là các khung LIÊN TIẾP -> thay 31 lần seek bằng
    play() + requestVideoFrameCallback (nhanh hơn hàng chục lần); phải cẩn thận map đúng khung vào lưới
    thời gian, sai là lệch khung -> hỏng WYSIWYG. KHÔNG dùng preview_proxy.mp4 cho việc này: proxy chỉ
    406×720 trong khi sequence 1080×1920 -> đoạn chuyển cảnh sẽ nhoè hơn 2 block hai bên, thấy rõ.
    Lối giảm thời gian bake mà người dùng dùng được NGAY: chọn fps xuất 30 thay vì 'source' 59.94 (31 khung
    -> 16 khung mỗi chuyển cảnh, nhanh gần gấp đôi), hoặc giảm thời lượng chuyển cảnh 0.5s -> 0.3s.
  - CRAB_TEMP_DIR (env, chỉ cho test): test export phải xoá sạch thư mục tạm, mà thư mục tạm mặc định đang
    giữ temp_input.mp4 + nguồn của DỰ ÁN ĐANG MỞ (hàng trăm MB) -> chạy test là mất dữ liệu người dùng.
    tests/scripts/transition_frame_transport.js trỏ CRAB_TEMP_DIR sang thư mục tạm riêng (npm run
    test:transition-frames) và kiểm cả 2 đường: phần file multipart (JPEG) + base64 nội tuyến.
    LUẬT CHUNG (2026-08-06, sau khi mất dữ liệu thật): MỌI test đụng backend phải đặt CRAB_TEMP_DIR
    TRƯỚC khi require('backend/server') — cổng và thư mục tạm đọc lúc nạp module. `backend_smoke.js`
    (gọi POST /api/reset-project) và `export_smoke.js` (rmSync thẳng thư mục tạm) trước đây chạy trên
    thư mục THẬT, nên `npm test` một lần là xoá sạch dự án đang mở; nay cả hai trỏ sang `test_temp/`.
    TÊN THƯ MỤC KHÔNG ĐƯỢC BẮT ĐẦU BẰNG DẤU CHẤM: `res.download` đi qua `send`, mà `send` trả 404 cho
    mọi đường dẫn có đoạn thư mục dạng dotfile -> test:export đổ ở khâu tải file về.
  - Chạy FFmpeg thật để xác nhận end-to-end cho cả overlay & lane chính (tái dùng path image_seq đã chứng minh).
- GĐ5 (chưa): hoàn thiện/di trú data model .crab nếu cần (hiện đã lưu trên block, có thể giữ nguyên).
```

### Proxy LQ Cho Asset Overlay (nút LQ/HQ nay ăn cả lane overlay)

```text
- VẤN ĐỀ (người dùng báo 2026-09-08): nút LQ/HQ chỉ đổi nguồn LANE CHÍNH
  (`preview_proxy.mp4`). Asset overlay thì preview đọc thẳng file gốc qua
  `/api/source-file`, nên bật một b-roll 1920×1080@60fps lên lane overlay là cộng thêm
  một bộ giải mã đầy đủ + một texture nữa mỗi khung, ngay cạnh lane chính. Đo bằng mắt:
  bật video overlay -> giật; tắt nó -> hết giật.
- CÙNG BỘ MÃ HOÁ VỚI LANE CHÍNH: sidecar `preview-proxy` (cao tối đa 720, bề rộng chia hết
  cho 16, ALL-INTRA `-g 1`, `-bf 0`). All-intra đặc biệt quan trọng với overlay vì
  `syncMediaElement` TUA phần tử overlay mỗi khi lệch > 0,22s — xem số đo trong
  AppendPreviewEncoderArgs (core_process.cpp) trước khi định "tối ưu" GOP.
- PROXY CHỈ CHO PREVIEW, KHÔNG BAO GIỜ CHO EXPORT. `asset.url`/`asset.path` giữ nguyên bản
  gốc; chỉ `previewAssetUrl(asset)` (editing-runtime.js) mới trả proxy, và nó được dùng ở
  ĐÚNG ba chỗ: `src` của phần tử overlay, `mediaKey` (khoá dựng lại phần tử), và khung tĩnh
  của chuyển cảnh overlay. Mọi đường bake/export (renderImageAnimationSequence,
  captureSeamFrameAsync, eachSourceFrame) vẫn đọc `asset.url`.
  ĐỐI LẬP CÓ CHỦ Ý với `ensureSdrAsset`: bản SDR thay CẢ `url` LẪN `path` vì bản HDR gốc
  sai MÀU ở cả hai khâu; proxy chỉ sai ĐỘ PHÂN GIẢI, mà bản xuất thì không được sai độ phân
  giải. Lẫn hai chuyện này là xuất ra 720p mà không ai yêu cầu.
- TRẠNG THÁI PROXY SỐNG NGOÀI OBJECT ASSET (`assetProxyUrls` / `assetProxyAsking` /
  `assetProxyGivenUp`, khoá theo đường dẫn nguồn). Lý do: `captureFullState()` làm
  `deepClone(editingAssets)` cho undo VÀ cho .crab, nên field thêm vào asset sẽ bị ghi
  xuống tệp dự án — một cờ "đang hỏi" bị đóng băng trong .crab là lần mở sau không bao giờ
  hỏi proxy nữa, hỏng âm thầm ở chỗ không ai nghĩ tới.
- SINH TRƯỚC: job kick lúc asset vào panel "Tệp phương tiện"
  (upload / import-local / link / thư viện), cạnh chỗ prewarm sóng âm. Kéo xuống timeline
  trước khi xong cũng không chặn gì — preview chạy bản gốc rồi tự đổi khi job xong
  (`ensureAssetProxy` poll giãn dần 1,5s -> 8s rồi gọi lại renderPreviewOverlays).
  TRẦN `PROXY_PREWARM_MAX_PER_BATCH = 24`: `/api/editing-assets/link` nhận CẢ CÂY THƯ MỤC
  (hàng trăm file b-roll là chuyện thường, chính vì thế nó còn bỏ qua ffprobe). Vượt trần
  thì không mất gì: `ensureAssetProbed` xếp job đúng lúc kéo block xuống.
- PHÂN PHỐI TẢI — ba tầng, vì một job encode chạy sai lúc còn tệ hơn không có proxy:
  1. MỘT job tại một thời điểm (`PROXY_MAX_PARALLEL_JOBS = 1`).
  2. `runSidecar(..., { lowPriority: true })` -> `os.setPriority(BELOW_NORMAL)`. Trên
     Windows tiến trình con thừa hưởng priority class của cha nên ffmpeg xuống theo.
     BEST-EFFORT: có thể đua vài ms với lúc sidecar sinh ffmpeg, và ưu tiên CPU KHÔNG
     chặn được phần giải mã/mã hoá trên GPU.
  3. CỔNG "ĐANG PHÁT" (`/api/background-jobs/gate`) — tầng quan trọng nhất, vì proxy dùng
     NVENC/NVDEC, tức tranh chấp đúng phần cứng preview đang cần. Frontend ping
     `{busy:true, ttl_ms:15000}` khi bắt đầu phát và nhắc lại mỗi 7,5s; `{busy:false}` khi
     dừng. Cổng là MỐC THỜI GIAN có hạn dùng, không phải cờ bật/tắt: đóng cửa sổ giữa lúc
     phát thì cổng tự mở lại, hàng đợi không kẹt vĩnh viễn.
- CACHE: `proxy_cache/<sha1(path|size|mtime|version)>.mp4`, NGOÀI temp_uploads (asset thư
  viện dùng lại qua nhiều dự án, không được mất proxy mỗi lần tạo dự án mới). Ghi vào
  `<key>.part.mp4` rồi mới `rename` -> "file tồn tại" ĐỒNG NGHĨA "đã hoàn chỉnh", không có
  đường nào phát ra một mp4 bị cắt ngang của job bị kill. Dọn được từ Cài đặt -> Bộ nhớ đệm.
- Endpoint `/api/editing-assets/proxy` luôn trả HTTP 200 kèm `status` =
  'queued'|'running'|'ready'|'error'|'unsupported' (KHÔNG dùng 202/500 như /api/audio-peaks:
  bên đó thân phản hồi là file nhị phân nên mã trạng thái phải gánh cả nghĩa "chưa xong";
  còn ở đây một job hụt là chuyện bình thường — preview vẫn chạy bằng bản gốc).
- Test: `npm run test:asset-proxy` (tests/scripts/asset_proxy_cache.js) — hình dạng proxy
  (720 / %16 / all-intra), queued->ready, cache hit cùng key, Range request, cổng chặn được
  job, và chặn path traversal.
```

### Sóng Âm Thật Trên Block Timeline Editing (Audio Peaks / .pk)

```text
- YÊU CẦU (người dùng chốt 2026-07-27): block trên timeline Editing phải vẽ ĐÚNG dữ liệu âm thanh
  (như CapCut/Premiere), KHÔNG được bắt người dùng đợi load/tính toán. Trước đây createWaveformStrip()
  trong editing-runtime.js chỉ vẽ 36 <span> theo công thức `18 + (i*17)%34` -> sóng âm GIẢ.
  PHẠM VI BAN ĐẦU: chỉ giai đoạn Editing (GĐ1-5). Sau đó MỞ RỘNG cho mọi giai đoạn ở GĐ A-D bên dưới
  (step1 Transcribe, step2 Match Script, step3 Timeline) và BỎ HẲN đường 3000-peak cũ.
- CHIẾN LƯỢC "không phải đợi": peak được sinh TRƯỚC (prewarm) thành file cache trên đĩa; frontend chỉ
  fetch + vẽ. Job nền chạy SONG SONG với việc vốn đã lâu (ASR / upload) nên tới lúc cần thì cache đã có.

- GĐ1 (ĐÃ LÀM) — SIDECAR: lệnh `audio-peaks <input> <output.pk>` trong native/sidecar/core_process.cpp.
  ffmpeg giải mã -> s16le MONO 24kHz -> gom bucket 32 sample, mỗi bucket lưu max|abs| + RMS.
  - ĐỘ PHÂN GIẢI: 24000/32 = 750 peak/giây (~1.5 KB/giây; 10 phút ≈ 900KB). Cao hơn zoom tối đa của
    timeline (~600 px/giây) nên mỗi cột pixel luôn có ≥1 peak THẬT, không nội suy.
  - ĐỊNH DẠNG (little-endian, khớp DataView ở frontend): header 32B = 'CRWV' | u16 version | u16 headerSize
    | u32 sampleRate | u16 bucketSamples | u16 flags (bit0 = nguồn KHÔNG có audio) | f64 duration | u32 peakCount
    | u32 reserved; body = peakCount × [u8 peakAbs, u8 rms] (0..255 = biên độ 0..1 tuyến tính).
  - Ghi ra .tmp rồi rename -> người đọc không bao giờ gặp file dở. Bucket cuối (lẻ) vẫn được ghi.
  - Nguồn KHÔNG có audio stream (ffprobe kiểm trước): vẫn ghi file 32B cờ no_audio -> frontend biết để
    KHÔNG vẽ gì và không hỏi lại server mỗi lần render.
  - ffmpeg chạy với -hide_banner -loglevel error (job ngầm, không spam log khi đang ASR).

- GĐ2 (ĐÃ LÀM) — BACKEND (backend/server.js, khối "SÓNG ÂM THẬT"):
  - CACHE: peaks_cache/<sha1(path|size|mtime|PEAKS_FORMAT_VERSION)>.pk. Đặt NGOÀI temp_uploads để asset
    thư viện (dùng lại nhiều dự án) không mất cache khi tạo dự án mới; key gồm size+mtime nên tự invalidate
    khi file đổi và HTTP cache được vĩnh viễn (immutable). prunePeaksCache() lúc khởi động dọn .pk quá
    PEAKS_CACHE_TTL_MS (30 ngày) + rác .tmp/.raw của job bị kill.
  - HÀNG ĐỢI: queueAudioPeaks(path) trả state ĐỒNG BỘ (ready/queued/running/error), tối đa
    PEAKS_MAX_PARALLEL_JOBS=2 job (không giành CPU với ASR/export), hỏng tối đa PEAKS_MAX_ATTEMPTS=2 lần
    (tránh frontend poll vô hạn). runSidecar dùng forwardStatus:false -> KHÔNG ghi đè dòng trạng thái ASR.
    Nếu file .pk bị xoá ngoài luồng mà state RAM vẫn 'ready' -> tự sinh lại (không kẹt 202 mãi mãi).
  - ENDPOINT: GET /api/audio-peaks?source=main | path=<asset.path> | url=</temp_uploads/...|/library/...>
    -> 200 file .pk nhị phân (header X-Peaks-Key, Cache-Control immutable) | 202 {status:'pending'} khi đang
    sinh (gọi endpoint cũng chính là "kick" job) | 500 khi job lỗi | 404 khi nguồn không hợp lệ.
  - AN TOÀN: resolveAudioSourcePath() chỉ nhận file NẰM TRONG temp_uploads/ hoặc library/ và có đuôi
    video/audio -> chặn path traversal (client tự truyền đường dẫn vào).
  - PREWARM: (a) ngay sau concatVideos trong /api/transcribe và /api/project/reingest -> peak lane chính
    sinh song song ASR; (b) prewarmAudioPeaksForAssets() trong /api/editing-assets/upload, /import-local,
    /api/library/add (bỏ qua asset has_audio=false / ảnh).
  - KIỂM CHỨNG (tests/scripts/audio_peaks_smoke.js, npm run test:audio-peaks — đã nằm trong npm test):
    dựng file bíp 1kHz biên độ 0.9 tại t=1/3/5 (aevalsrc, exprs='...' PHẢI nháy đơn vì biểu thức có dấu phẩy)
    -> peak đúng thời điểm ±3ms, đúng độ dài ±6ms, đúng biên độ ±2/255, vùng im lặng = 0 tuyệt đối, rms ≤ peak;
    202->200; cache hit lần 2 trả byte y hệt; nguồn không audio = 32B cờ no_audio; 6 dạng đường dẫn xấu -> 404.
    Đo thực tế: video 48.6s -> 36464 peak (72KB) sinh trong ~10s; cache hit ~2-10ms; asset nhạc/SFX vài giây.
    Đối chiếu độ chính xác: peak cửa sổ 10-11s của video thật = 0.4471 vs giải mã độc lập 48kHz = 0.4464 (lệch 0.0007).

- GĐ3 (ĐÃ LÀM) — MODULE static/js/audio-waveform.js (UMD -> window.AudioWaveform, thuần dữ liệu + vẽ):
  - ensure(key, url): nạp .pk cho 1 nguồn; 202 -> tự poll backoff (160ms ×1.5, trần 1.2s, bỏ sau 120s),
    lỗi mạng thử lại 3 lần. cache:'no-store' vì URL không content-addressed (đổi file nguồn vẫn cùng URL);
    cache thật là store trong RAM. onChange(cb) -> caller schedule vẽ lại khi dữ liệu về.
  - ingest(key, buffer): nạp .pk trực tiếp không qua HTTP (dùng cho test; xem test:audio-waveform).
  - MIP PYRAMID dựng LƯỜI ×4 (max của max, rms = √mean(rms²)): zoom nhỏ 1 cột có thể trải hàng nghìn peak,
    nếu quét dữ liệu gốc thì mỗi frame tốn hàng triệu phép so sánh. columns() luôn chọn mức sao cho 1 cột
    đọc 1..4 phần tử -> chi phí vẽ gần như KHÔNG ĐỔI theo zoom. RAM mip ≤ ~1/3 dữ liệu gốc.
  - columns(key, srcStart, srcEnd, colCount): trả Float32Array [peak, rms] (0..1) theo THỜI GIAN NGUỒN
    (nên trim source_start / clip.start-end khớp tuyệt đối); ngoài phạm vi nguồn = 0 (KHÔNG lặp đỉnh cuối);
    mảng được DÙNG LẠI giữa các lần gọi (không cấp phát mỗi frame).
  - drawColumns(): envelope PEAK đối xứng quanh trục giữa + lõi RMS đậm hơn (dáng CapCut); mỗi cột ≥3px thì
    chừa 1px khe cho ra dáng "thanh". LRU 24 nguồn / 48MB.
- GĐ4 (ĐÃ LÀM) — VẼ TRÊN TIMELINE (editing-runtime.js, khối "SÓNG ÂM THẬT trên block timeline Editing"):
  - Bỏ HẲN createWaveformStrip() (36 <span> giả); block chỉ còn class .has-audio để đánh dấu.
  - MỘT canvas #editingWaveformCanvas đặt TRONG #segmentsTrack, kích cỡ = viewport, bù scrollLeft/scrollTop.
    Vì sao không dùng canvas trong từng block: ở zoom cao 1 block rộng hàng trăm nghìn px (vượt giới hạn
    canvas) và #segmentsTrack bị innerHTML='' mỗi render. z-index 21 = TRÊN block (20), DƯỚI dải chuyển cảnh
    (22) và rail nhãn lane (30) -> tự bị rail che, không cần tự clip; pointer-events none.
    attachWaveformCanvas() gắn lại canvas ở cuối renderEditingTimeline (vì innerHTML='' xoá nó).
  - Mỗi lần vẽ CHỈ xử lý phần block giao viewport (cull theo x/y) -> chi phí không đổi theo độ dài timeline.
    Redraw gộp bằng rAF, kích hoạt bởi: renderEditingTimeline (nên bao cả zoom/drag/resize/thêm-xoá block),
    scroll của #timelineTrackOuter, ResizeObserver trên viewport, và AudioWaveform.onChange.
  - VỊ TRÍ DẢI SÓNG: main/media = sát đáy block (bottom 5px, cao 16px, thụt 4px hai bên — khớp dải giả cũ);
    audio = từ top+20 tới bottom-4 (nhãn tên block audio đã chuyển LÊN TRÊN, dáng CapCut).
  - BIÊN ĐỘ: nhân clip.audio_volume (lane chính) / item.volume (overlay). ĐỘ MỜ: lane ẩn ×0.3, lane khoá
    ×0.62, mute (item hoặc lane) ×0.4 — khớp cảm giác của block.
  - CHƯA CÓ DỮ LIỆU: chỉ vẽ vạch trục mờ (TUYỆT ĐỐI không vẽ sóng giả), tự hiện sóng khi peak về.
  - API cho ngoài/test: EditingRuntime.drawWaveformsNow() (vẽ đồng bộ), scheduleWaveformRedraw(), waveformTargets().
  - (Cập nhật ở GĐ A bên dưới) vòng lặp vẽ đã CHUYỂN sang AudioWaveform.paintViewport dùng chung với
    timeline các giai đoạn trước; editing-runtime.js chỉ còn thu thập target.
- GĐ A (ĐÃ LÀM 2026-07-27) — BỘ VẼ DÙNG CHUNG cho mọi giai đoạn: `AudioWaveform.paintViewport(view, targets)`.
  view = {canvas, scrollLeft, scrollTop, viewWidth, viewHeight, dpr?}; target = {key, url, rect{x,y,w,h,mapRect?},
  srcStart, srcEnd, gain?, alpha?, peakColor?, rmsColor?}. Hàm này ghim canvas theo viewport, cull target ngoài
  viewport, xử lý trạng thái (pending -> vạch trục; no_audio/error -> bỏ) rồi gọi columns()+drawColumns().
  Canvas do CALLER tạo & đặt DOM (mỗi giai đoạn có chỗ đặt/z-index riêng).
  LÝ DO tách: nếu mỗi giai đoạn tự viết vòng lặp vẽ thì các bản sao sẽ lệch nhau — đúng cái bệnh đang phải chữa.
  - `mapRect` (QUAN TRỌNG): rect VẼ và rect ÁNH XẠ THỜI GIAN là 2 thứ khác nhau. Dải sóng thường thụt lề 4px
    mỗi bên (để không đè tay cầm resize) nên nếu ánh xạ theo rect đã thụt thì px/giây sai tỉ lệ: dải 600px thụt
    8px -> lệch 1.35%, block càng ngắn càng lệch, và sóng không thẳng hàng với playhead. mapRect = geometry đầy
    đủ của block. Lỗi này BỊ BẮT ngay khi refactor nhờ probe (bíp 1/3/5s đo được thành 0.985/2.955/4.93s).
  - Nhân đây SỬA LUÔN lệch 40ms của bản GĐ4: trước đó dùng 1/zoomScale nhưng đo x từ mép dải đã thụt 4px, nên
    toàn bộ sóng bị dịch phải 4px so với thời gian thật; nay dùng mapRect -> khớp playhead tuyệt đối.
- GĐ B (ĐÃ LÀM 2026-07-27) — SÓNG ÂM Ở CÁC GIAI ĐOẠN TRƯỚC (step1 Transcribe = RAW, step2 Match Script = MAPPED):
  - BỎ HẲN waveform Pixi: `renderWaveform()` + waveformLayer/waveformBars/theme.waveform trong
    pixi-timeline-renderer.js đã xoá (bản cũ chỉ 3000 peak cho TOÀN video -> video 10 phút còn 5 peak/giây,
    zoom vào là bậc thang; biên độ bị nén sqrt trong addon rồi nhân 1.8 nên không phản ánh đúng dB).
  - Thay bằng canvas `#timelineWaveformCanvas` trong `#timelineTrack`, z-index 1 (cùng dải với lớp Pixi, DƯỚI
    #segmentsTrack z2 và ruler z3), pointer-events none. `drawWaveform()` trong index.html viết lại: 1 target
    duy nhất key='main' (CÙNG key với lane chính ở Editing -> chuyển giai đoạn KHÔNG tải lại dữ liệu),
    rect = {x: sidePadding, y: 25, w: videoDuration*zoomScale, h: viewportH*0.5-12} (giữ đúng vùng của bản Pixi
    cũ nên layout không nhảy), srcStart=0, srcEnd=videoDuration.
  - VÌ SAO DẢI LIÊN TỤC (không vẽ theo block): ở RAW/MAPPED block xếp theo THỜI GIAN NGUỒN, người dùng cần thấy
    cả phần GIỮA các đoạn để quyết định cắt/trim. Ở FINAL thì canvas này ẩn (block xếp tuần tự sau khi cắt nên
    dải liên tục vô nghĩa) — sóng theo từng block cho FINAL là GĐ C.
  - Hook vẽ lại: drawWaveform() (đã được gọi từ updateTimelineLayout khi zoom/layout) + scroll #timelineTrackOuter
    + ResizeObserver + AudioWaveform.onChange + cuối drawTimelineSegments (đổi mode). Gộp frame bằng rAF.
  - Màu: xám bạc (peak rgba(130,140,155,.62), rms rgba(186,198,214,.82)) giữ tinh thần lớp Pixi cũ, khác màu
    lam của block Editing nhưng CÙNG hình dạng & cùng dữ liệu.
- KIỂM CHỨNG GĐ A-B:
  - `npm run test:audio-waveform` bổ sung mục 9: dùng canvas/ctx GIẢ (ghi lại rect được vẽ) để kiểm paintViewport
    mà không cần browser — thanh sóng phải rơi đúng mốc 1/3/5s theo mapRect (±1.5px), cull đúng viewport, nguồn
    chưa nạp chỉ vẽ vạch trục, nguồn no_audio không vẽ gì. Đã thử phá (bỏ mapRect) -> test đổ đúng chỗ (x=597
    thay vì 600) nên test có tác dụng thật.
  - Probe Electron ở step1 (RAW): canvas trong #timelineTrack, z-index 1, pointer-events none; mực nằm đúng dải
    [25, 25+viewportH*0.5-12]; chiều cao cột vẽ ra khớp columns() (vd t=5s: 15px vs 14.6px kỳ vọng); MAPPED vẫn
    hiện, FINAL ẩn; không lỗi console; store dựng 2 mức mip khi zoom 20 (95KB RAM).
    HIỆU NĂNG: 0.44 ms/lần vẽ ở zoom 100, 0.38 ms ở zoom 600, 0.38 ms ở zoom 20 (chi phí PHẲNG theo zoom).
  - Editing chạy lại probe sau refactor: bíp vẫn ở 0.995/2.995/4.995s (đo từ mép block), 0.48-0.55 ms/lần vẽ,
    và #timelineWaveformCanvas ẩn khi ở Editing.
- GĐ C (ĐÃ LÀM 2026-07-27) — step3 Timeline (FINAL): vẽ sóng THEO TỪNG BLOCK (dải liên tục vô nghĩa ở đây vì
  block xếp TUẦN TỰ sau khi cắt). timelineWaveformTargets() trong index.html dựng 1 target/clip từ latestTimeline:
  left cộng dồn từ sidePadding (đúng cách drawTimelineSegments xếp block), srcStart/srcEnd = item.start/end,
  gain = item.audio_volume/100, rect = dải 16px sát đáy block + mapRect = khối đầy đủ.
  - Hình học block lấy ĐÚNG công thức getSegmentGeometry() của Pixi (blockTop = h*0.5 + (h*0.5-12)*0.15,
    blockHeight = (h*0.5-12)*0.7) vì block ở các bước trước do PIXI vẽ, DOM .timeline-hit-block chỉ là vùng bắt
    chuột. Canvas là con CUỐI của #timelineTrack nên cùng z-index 1 vẫn vẽ TRÊN hình block của Pixi.
  - KHÔNG truyền màu -> dùng màu mặc định của module = đúng màu lane chính ở Editing.
  - Điều kiện ẩn đổi từ "currentMode === 'FINAL'" thành "currentStepId === 'step4'": step3 FINAL vẽ theo block,
    chỉ ở Editing mới nhường cho #editingWaveformCanvas (đa lane, mute/volume riêng từng block).
- GĐ D (ĐÃ LÀM 2026-07-27) — BỎ đường 3000-peak, chỉ còn MỘT nguồn dữ liệu:
  - backend/server.js: xoá hàm extractAudioPeaks, bỏ bước sinh peak trong /api/transcribe và
    /api/project/reingest, bỏ field audio_peaks khỏi payload, bỏ diagnostics waveform_duration_ms + dòng tương
    ứng trong report. File tạm temp_uploads/waveform_pcm_s16le.raw không còn được sinh ra nữa.
  - native/sidecar/core_process.cpp: xoá luôn lệnh `decode-audio-pcm` (sau thay đổi trên thì KHÔNG còn ai gọi;
    `audio-peaks` đã bao trọn việc giải mã + gom bucket). Hàm addon extractAudioPeaks trong native/addon GIỮ LẠI
    (còn tests/scripts/native_smoke.js dùng làm smoke cho addon) — chỉ bỏ chỗ gọi trong backend.
    LỢI ÍCH PHỤ: transcribe nhanh hơn vì bỏ được MỘT lần giải mã toàn bộ audio vốn chạy SAU ASR (job .pk đã
    prewarm song song ASR nên sẵn sàng sớm hơn).
  - index.html: xoá biến audioPeaks, tham số peaks của loadTranscribedVideoAndHydrateUI và 2 call-site, xoá
    mapping status 'biểu đồ sóng âm' (backend không còn phát thông báo này).
  - Hàm addon native extractAudioPeaks GIỮ LẠI (tests/scripts/native_smoke.js còn dùng), chỉ bỏ chỗ gọi.
- GĐ E (ĐÃ LÀM 2026-07-27) — KIỂM CHỨNG TỔNG THỂ + DỌN DEAD CODE:
  - Dead code: `renderWaveform` (Pixi) đã bỏ ở GĐ B; `decode-audio-pcm` (sidecar) bỏ ở GĐ E; đã grep xác nhận
    không còn chỗ nào tham chiếu audio_peaks / audioPeaks / waveform_duration_ms / waveform_pcm_s16le.
  - TOÀN BỘ 11 test của dự án chạy XANH. Lưu ý cách chạy: backend_smoke / asr_report_smoke / export_smoke gọi
    /api/reset-project (XOÁ sạch temp_uploads) nên KHÔNG chạy trong thư mục dự án đang có dữ liệu thật; chạy
    trong `git worktree` riêng (temp_uploads rỗng) + symlink node_modules/.venv + copy sẵn core_process và
    core_c.node (node-gyp KHÔNG build được trong worktree vì node_modules là symlink -> lỗi đường dẫn tương đối
    của gyp; copy binary là cách nhanh nhất).
  - BẢNG HIỆU NĂNG (ms cho 1 lần vẽ, 40 lần có scroll, viewport ~1478px, dpr 2, GPU bật):
      giai đoạn        zoom20   zoom100  zoom600
      step1 RAW        0.51     0.37     0.37
      step2 MAPPED     0.35     0.40     0.38
      step3 FINAL      0.14     0.31     0.40
      step4 Editing    0.24     0.37     0.31
    -> luôn dưới 1ms và PHẲNG theo zoom (nhờ mip pyramid), tổng RAM store 3 nguồn ≈ 195KB.
  - HIỂN THỊ ĐÚNG GIAI ĐOẠN: step1/2/3 hiện #timelineWaveformCanvas; step4 ẩn nó và dùng #editingWaveformCanvas;
    quay lại step1 thì canvas Editing bị xoá khỏi DOM (do #segmentsTrack.innerHTML='') và canvas timeline hiện lại.
  - TRIM ĐỔI NỘI DUNG SÓNG: đổi clip 1 từ [3,9] sang [20,26] -> chỉ 76/400 cột giống (lệch tối đa 23px); trả về
    [3,9] -> 322/400 cột trùng khít, 392/400 lệch ≤1px, tối đa 2px.
  - NGƯỠNG NHIỄU CỦA PHÉP ĐO (đừng đi tìm bug ở đây): so profile pixel giữa 2 lần vẽ giống nhau chỉ đạt ~322/400
    cột trùng TUYỆT ĐỐI, phần còn lại lệch 1px, vì ngưỡng alpha>10 gặp cạnh đã khử răng cưa của rect có toạ độ
    lẻ (rect.y phụ thuộc clientHeight; scrollbar xuất hiện/mất là đủ đổi phần lẻ). Dữ liệu KHÔNG đổi.
  - VOLUME ở step3: audio_volume 50% -> biên độ 16px so với 31px ở 100% (tỉ lệ 0.516).
  - CHƯA CÓ DỮ LIỆU: xoá store rồi vẽ ngay -> chỉ còn 2px mực (vạch trục 1 CSS px ở dpr 2), KHÔNG có sóng giả;
    khi peak về thì lên 134px. Không lỗi console ở bất kỳ bước nào.
- KIỂM CHỨNG GĐ C-D:
  - SO KHỚP step3 ↔ step4 (phép kiểm mạnh nhất cho "giống Editing"): cùng latestTimeline, cùng zoom, so profile
    độ cao từng cột của 400 cột thiết bị trong dải sóng block đầu -> 322/400 cột GIỐNG HỆT, 400/400 lệch ≤1px
    (chênh 1px là do offset lẻ pixel của 2 canvas), các cột mẫu trùng khít (20,20,20,10,9,10,26,25,26,...).
  - ĐỘ CHÍNH XÁC so với NGUỒN THẬT (không qua .pk): so columns('main', t, t+0.02) với max|abs| ffmpeg giải mã
    trực tiếp temp_input.mp4 tại t=1/2/3/5/8/11/20s -> lệch ≤0.0043 (≈1 bậc lượng tử 1/255) ở 6/7 mốc; mốc t=11
    lệch 0.029 do columns() làm tròn ra biên bucket (1.33ms) nên bao thêm một transient sát cửa sổ.
    Pixel VẼ RA ở step1 cũng khớp: t=2 -> 18.5px vẽ vs 17.88px kỳ vọng, t=5 -> 21px vs 21.16px.
  - HIỆU NĂNG: step3 0.37-0.42 ms/lần vẽ; step1 0.30-0.37 ms (zoom 20-100). Không lỗi console.
  - Test tự động: npm run test:audio-peaks + npm run test:audio-waveform (đều xanh sau khi bỏ đường dữ liệu cũ);
    asr_report_smoke/backend_smoke không tham chiếu field đã bỏ.
- KIỂM CHỨNG GĐ3-4 (bản đầu, trước refactor GĐ A):
  - tests/scripts/audio_waveform_columns.js (npm run test:audio-waveform, đã nằm trong npm test): nạp .pk của
    file bíp bằng ingest() rồi kiểm ánh xạ cột<->thời gian (bíp ở 1/3/5s, lệch ≤1.5 cột), biên độ 0.9 ±0.01,
    TRIM source_start=2 -> còn 2 bíp ở 3s và 5s, mip không mất đỉnh (≤1/255) và RAM mip ≤1.4× gốc, rms ≤ peak,
    ngoài phạm vi nguồn = 0, no_audio -> columns null, .pk rác -> ném lỗi magic.
  - Probe Electron trên index.html thật (dựng timeline tối thiểu: 2 clip lane chính + item audio + item video
    có tiếng): dải bíp trên canvas đo được ở 0.995/2.995/4.995s (lệch ≤5ms = 1 device pixel ở zoom 100, dpr2);
    volume 100 -> cột cao 22/24px, volume 50 -> 12px (đúng nửa); mute item & mute lane -> alpha 251 -> 150;
    rời Editing -> canvas biến mất, quay lại -> canvas được tạo lại; không lỗi console.
    HIỆU NĂNG: 0.50 ms/lần vẽ ở zoom 100 và 0.51 ms ở zoom 600 (4 dải sóng, viewport 1462px, dpr 2) ->
    dưới xa ngân sách 1 frame; store 3 nguồn ≈ 155KB RAM.
    LƯU Ý HARNESS: probe phải chạy CÓ GPU, nếu tắt hardware acceleration thì PixiJS init lỗi
    ("Unable to auto-detect a suitable renderer") -> script khởi tạo index.html dừng giữa đường (timelineOuter
    chưa khai báo) và showStep bị hỏng — đó là hiện tượng của harness, không phải lỗi ứng dụng.
```

### Tốc Độ (Speed) — Tab "Tốc độ" Ở Inspector, Không Méo Tiếng

```text
CHỖ ĐẶT: tab "Tốc độ" của Inspector, ngang hàng Video/Âm thanh/Điều chỉnh. Hiện với clip
lane chính (main4), media VIDEO overlay và block audio. Ảnh/text/shape KHÔNG có tab này
(không có trục thời gian nguồn để co dãn).
  - Thanh trượt + ô nhập: 0.1x - 100x
  - Preset nhanh: 0.1x / 0.5x / 1x / 1.5x / 2x / 5x
  - Công tắc "Giữ cao độ giọng nói" (bật mặc định)
  - Dòng đọc: thời lượng block SAU khi đổi tốc độ + đang ở chế độ giữ hay đổi cao độ

THANG LOGARIT cho thanh trượt: dải 0.1-100 trải 3 bậc10. Để tuyến tính thì 1.0x rơi vào
~0.9% hành trình -> không ai chỉnh nổi vùng quanh 1x, đúng vùng dùng nhiều nhất.

MÔ HÌNH: clip.speed / item.speed = {rate, pitch_correct, mode}. KHÔNG có field = 1.0x, và
đưa về 1.0x thì field bị XOÁ. Nằm ngay trên clip/item nên tự đi theo undo/redo, .crab và
payload export — giống Volume và Khử tiếng ồn, không có đường lưu riêng.
`mode` hiện chỉ nhận 'normal'; 'curve' (tốc độ biến thiên) để dành cho sau, đã có chỗ
trong mô hình để không phải đổi định dạng .crab lúc đó.

HAI TRỤC THỜI GIAN — đây là chỗ dễ sai nhất của tính năng:
  - thời gian NGUỒN   : clip.start/end, item.source_start, video.currentTime
  - thời gian SEQUENCE: vị trí block trên timeline, playhead, mốc overlay
  Quan hệ: sequence = nguồn / rate. rate = 2 làm block NGẮN đi một nửa trên timeline.
  Trước khi có tốc độ, hai trục co giãn 1:1 nên lẫn lộn cũng không lộ; giờ mọi chỗ bắc
  cầu giữa hai trục đều phải nhân/chia rate. Bảng quy đổi ở static/js/clip-speed.js.

RIPPLE (dồn block) — hai cách khác nhau, khác ở chỗ cái gì được giữ nguyên:
  - LANE CHÍNH: giữ nguyên clip.start/end. Bề rộng là đại lượng SUY RA
    (mainClipSequenceSpans chia cho rate) nên mọi block sau tự dồn — ripple có sẵn.
  - OVERLAY: item.duration LÀ thời gian timeline nên phải tự tính lại
    (duration_mới = duration_cũ × rate_cũ / rate_mới, tức GIỮ NGUYÊN khoảng nguồn) rồi
    dồn các block sau trên CÙNG LANE (rippleLaneAfter). Chỉ dồn cùng lane: lane khác là
    nội dung độc lập, dồn theo là tự ý xê dịch thứ người dùng đã đặt.

NHỮNG CHỖ BẮC CẦU ĐÃ SỬA (ai thêm chỗ mới thì phải qua clip-speed.js):
  index.html          : clipSequenceDuration, sequencePositionAtTimelineTime,
                        getCurrentTimelineTime, getTimelineDuration, getFinalSequenceOffset,
                        getTimelineBlockSnapTimes, và độ dài dùng cho hoạt ảnh/keyframe/
                        lớp điều chỉnh khi dựng payload export.
  editing-runtime.js  : mainClipSequenceSpans, trim 2 đầu lane chính (quãng kéo × rate),
                        cắt block overlay (source_start += leftDuration × rate), khung seam
                        của chuyển cảnh, khoảng dò landmark Retouch (+ rate nằm trong khoá
                        cache), sóng âm (cùng rect phủ khoảng nguồn dài/ngắn hơn -> sóng tự
                        co dãn), trần thời lượng hoạt ảnh Vào/Ra.
  perf-runtime.js     : vòng phát đặt lại playbackRate mỗi khi con trỏ clip đổi.
  server.js           : timelineDurationFromIntervals (độ dài SEQUENCE) + speed_rate /
                        speed_pitch_correct cho từng interval và overlay.
  core_process.cpp    : IntervalSequenceDuration + BuildTimelineFrameGrid, WriteClipVideoFilters,
                        nhánh audio lane chính, WriteOverlayAudioFilter, WriteVisualOverlayFilter,
                        SequenceDuration.

KHÔNG MÉO TIẾNG:
  - PREVIEW: `preservesPitch` của HTMLMediaElement (Chromium tự time-stretch). Đã kiểm
    trong runtime thật: thuộc tính có mặt và ghi được.
  - EXPORT : chuỗi `atempo` (WSOLA). Tắt pitch_correct thì dùng asetrate + aresample
    (đổi cao độ theo tốc độ — hiệu ứng "máy nhựa"), và `aresample` là BẮT BUỘC, nếu không
    nhánh này khác sample rate với nhánh khác và concat/amix từ chối ghép.
  BẪY `atempo`: FFmpeg chỉ nhận 0.5 <= tempo <= 2.0 MỖI TẦNG -> phải nối chuỗi
  (4.0x -> atempo=2,atempo=2; 0.25x -> atempo=0.5,atempo=0.5). Truyền thẳng atempo=4.0
  thì FFmpeg từ chối CẢ filter graph, tức hỏng bản xuất chứ không chỉ sai tiếng.
  Chuỗi dựng ở BuildAtempoFilter (C++); ClipSpeed.atempoChain là bản JS đối chiếu cho test.

KẸP CỦA PREVIEW: playbackRate của Chromium chỉ chạy trong [0.0625, 16]. Người dùng đặt
được tới 100x — ngoài dải đó PREVIEW chạy hết cỡ còn BẢN XUẤT vẫn đúng tốc độ đã đặt
(FFmpeg không có giới hạn đó). Đây là chênh lệch CÓ CHỦ Ý, đừng "sửa" cho khớp nhau.

THỨ TỰ TRONG FILTER GRAPH (quan trọng, đã đo):
  video lane chính : trim -> setpts=PTS-STARTPTS -> setpts=PTS/rate -> fps=renderFps
                     -> trim=end_frame=renderFrames
                     setpts phải đứng TRƯỚC `fps=`: sau đó khung đã resample về lưới
                     renderFps rồi, đổi PTS lúc ấy là lặp/bỏ khung không đều.
  audio lane chính : atrim(end = start + renderFrames/fps × rate) -> asetpts -> khử ồn
                     -> atempo -> volume -> aresample
                     renderFrames đếm khung SEQUENCE nên phải nhân rate để ra giờ nguồn;
                     atempo nén đúng chừng đó về lại renderFrames/fps.
  overlay video    : trim(duration × rate) -> setpts=(PTS-STARTPTS)/rate + start/TB
                     Chia TRƯỚC khi cộng `start`: chia cả biểu thức đã cộng thì mốc bắt
                     đầu của overlay cũng bị chia và lớp lệch chỗ.
  overlay audio    : atrim(duration × rate) -> asetpts -> khử ồn -> atempo -> volume -> adelay

KIỂM CHỨNG (npm run test:clip-speed, đã nằm trong npm test):
  1. Hợp đồng module: kẹp dải (rate = 0 hoặc âm -> RATE_MIN, vì rate là MẪU SỐ ở khắp nơi),
     quy đổi hai trục khép kín, chuỗi atempo có tích đúng bằng tốc độ và MỌI tầng nằm
     trong 0.5..2.0.
  2. Xuất thật qua backend, nguồn 8 s (đỏ 4 s + xanh 4 s, sin 440 Hz suốt file):
     block 1 nguồn 0-4 s ở 2x -> 0-2 s timeline; block 2 nguồn 4-8 s ở 1x -> 2-6 s.
     - thời lượng bản xuất đo được ĐÚNG 6.00 s (không phải 8 s)
     - giây 1 là ĐỎ, giây 4 là XANH -> trục thời gian không lệch
     - GIỮ cao độ: biên độ tại 440/880 Hz = 0.0312 / 0.0000
     - TẮT giữ cao độ: 440/880 Hz = 0.0000 / 0.0312 (đảo hẳn, đúng một quãng tám)
     - thời lượng KHÔNG đổi giữa hai chế độ
     - audio overlay 4 s ở 2x đặt tại 2-4 s: kêu đúng khoảng của nó (rms trong/ngoài
       0.0441 / 0.0000) và giữ đúng 1000 Hz -> atrim lấy đúng độ dài nguồn.
     Đo bằng Goertzel tại đúng hai tần số, và bằng TỈ LỆ chứ không bằng ngưỡng tuyệt đối
     (`amix` chia biên độ theo số nhánh nên mức tuyệt đối phụ thuộc bố trí test).
     Tắt tiếng lane chính ở block 2 (audio_volume = 0) để đo được overlay riêng.

CHƯA LÀM: mode 'curve' (tốc độ biến thiên theo đường cong) — mô hình đã chừa chỗ.
```

### Vùng Chuyển Cảnh Lane Chính Mất Retouch (+ lấy sai khung khi có Tốc độ) (đã sửa 2026-08-10)

```text
TRIỆU CHỨNG: giữa block A và B có chuyển cảnh, cả hai đã speed (0.8x / 1.2x) + chỉnh màu +
LUT + Retouch. Playhead NGOÀI vùng chuyển cảnh: hiển thị đúng. Playhead ĐI VÀO vùng chuyển
cảnh: preview nhảy về "giá trị mặc định" của cả A và B.

LỖI 1 — MẤT RETOUCH (đây là cái người dùng thấy)
Trong vùng chuyển cảnh, hình lane chính KHÔNG còn do sprite PIXI vẽ nữa mà do
`#mainTransitionCanvas` phủ lên (z-index -1 trong root z-3, vẫn nằm TRÊN pixi z-2).
Canvas đó dựng bằng `drawMainClipLayer`, mà hàm này CỐ Ý chỉ lo chỉnh màu + đặt lớp —
mọi nơi gọi nó đều phải tự retouch TRƯỚC rồi truyền khung ĐÃ retouch vào (xem
bakeRetouchSequence). `renderMainTransitionComposite` lại truyền khung THÔ.
  · Chỉnh màu/LUT thì KHÔNG mất (drawMainClipLayer có gọi colorAdjustedDrawable) — đúng
    như ghi chú ở đầu colorAdjustedDrawable. Chỉ Retouch mất.
  · Khâu XUẤT (bakeMainTransitionSequence) mắc y hệt -> sửa cả hai, nếu không preview và
    bản xuất lệch nhau ở đúng đoạn chuyển cảnh.
MỐC THỜI GIAN để tra landmark phải là GIỜ NGUỒN, không phải giờ sequence:
    lớp SỐNG -> video.currentTime (preview) / srcT đã tính (export)
    lớp SEAM -> clip.end (A) hoặc clip.start (B)

LỖI 2 — EXPORT LẤY SAI KHUNG KHI BLOCK CÓ TỐC ĐỘ
`bakeMainTransitionSequence` tính `srcT = clip.start + (seqT - span.start)`, tức coi thời
gian TIMELINE là giờ nguồn. Cùng đúng một họ lỗi với khâu bake Retouch đã sửa 2026-08-08,
ở một chỗ lần đó bỏ sót. Nay đi qua `mainClipSourceTimeAt` -> `ClipSpeed.sourceTimeAt`.
(Preview KHÔNG mắc lỗi này: lớp sống lấy thẳng khung đang phát của thẻ video, còn lớp
seam lấy theo clip.end/clip.start — cả hai vốn đã ở trục nguồn.)

CHI TIẾT DỄ SẬP HẦM: `retouchedDrawable` trả về CHÍNH canvas của bộ render trong pool
(trần 4, thu hồi cái cũ nhất). Trong một khung chuyển cảnh có HAI lớp cùng sống, nên phải
CHỤP LẠI sang canvas riêng trước khi vẽ, không thì lớp sau ghi đè lớp trước. Canvas chụp
lại khoá theo SLOT 'A'/'B' chứ không theo block: `bakeCanvasPool` không có trần, khoá theo
block là mỗi điểm cắt giữ thêm 8 MB (1080x1920) tới hết phiên.
Khâu xuất còn phải `awaitRetouchFaces` cho CẢ HAI block trước khi bake —
`retouchedDrawable` cố ý trả khung gốc khi chưa có landmark, nên thiếu bước này là bản
xuất im lặng mất retouch đúng ở đoạn chuyển cảnh.

KIỂM CHỨNG (đo trên app đang chạy, dựng đúng dự án của người dùng): render composite ở
cùng một mốc trong vùng chuyển cảnh, một lần retouch BẬT hết cỡ, một lần params rỗng ->
trung bình khung ĐỔI (-2.38 / -0.79 / +1.37 trên R/G/B). Trước khi sửa, đường này không
đọc `clip.retouch` một lần nào nên bật/tắt retouch KHÔNG THỂ làm đổi pixel.
```

### Preview LQ Zoom Khác HQ Khi Block Có Retouch/Hiệu Ứng (đã sửa 2026-08-10)

```text
TRIỆU CHỨNG: mở lại dự án cũ (.crab) rồi bật LQ -> preview PHÓNG HẲN vào mặt so với HQ.
Bật lại HQ là đúng ngay.

CÁCH TÌM RA — đo trực tiếp trên app đang chạy, không suy luận:
  · Sprite lane chính KHÔNG sai: dựng đúng clip của dự án rồi đọc `sourceMap` ở hai chế
    độ -> HQ và LQ cho cùng kích thước vẽ ra (196.6x349.4 vs 196.5x349.4) và cùng tâm.
  · `sequenceSettings.source_*` KHÔNG bị nhiễm kích thước proxy: cổng ở listener
    'loadedmetadata' (isPreviewProxySourceLoaded) chặn đúng — đo lại vẫn 1080x1920.
  · Cả ba đường canvas (retouch, CanvasColorRenderer, RetouchRenderer) đều RESIZE canvas
    theo kích thước được truyền vào -> canvas không sai.
  · Sai ở TEXTURE PIXI của canvas đó. Bật retouch cho clip rồi đo lại:
        HQ: canvas fx 1080x1920, texture 1080x1920, vẽ ra 196.6x349.4  (khung 189x337) ✓
        LQ: canvas fx  406x722,  texture 1080x1920, vẽ ra 522.7x929.3               ✗
    Phóng 522.7/196.6 = 2.66 = đúng 1080/406.

NGUYÊN NHÂN: trong syncSpriteTexture, texture chỉ được dựng lại khi `this.fxSource !== fx`
— tức chỉ so DANH TÍNH đối tượng. Nhưng `fx` là canvas DÙNG LẠI của renderer trong pool:
đổi LQ <-> HQ thì nó được RESIZE chứ không bị thay object. `PIXI.Texture.from()` đã chốt
cỡ baseTexture từ lần tạo, còn `baseTexture.update()` chỉ nạp lại PIXEL. Hệ quả: sprite
được scale cho texture rộng 406 trong khi PIXI vẫn tin texture rộng 1080.

VÌ SAO CHỈ GẶP KHI MỞ DỰ ÁN CŨ: lỗi cần đường CANVAS TRUNG GIAN đang hoạt động (có
Retouch, hoặc Lớp Điều chỉnh, hoặc chỉnh màu cần nhiều lượt) TRƯỚC khi độ phân giải thẻ
video đổi. Mở .crab thì retouch/LUT được khôi phục NGAY, rồi proxy mới xong và tự thay
video -> đúng thứ tự sinh lỗi. Phiên làm mới thường có proxy trước khi bật retouch nên
không lộ.

SỬA: so cả KÍCH THƯỚC canvas (`fxSourceW`/`fxSourceH`) chứ không chỉ danh tính; khác cỡ
thì huỷ texture cũ và dựng lại.
KIỂM CHỨNG (đo lại sau khi sửa, đổi qua lại HQ->LQ->HQ->LQ bốn lượt): kích thước vẽ ra
GIỐNG NHAU ở cả hai chế độ và texture bám đúng canvas (1080x1920 ở HQ, 406x722 ở LQ).

KHÔNG PHẢI LỖI, đừng "sửa": texture VIDEO THÔ do PIXI tự quản — VideoResource nghe
'loadedmetadata' và tự resize (đã đo: 406x722 đúng ngay sau khi sang LQ). Chỉ đường canvas
trung gian cần vá.
CÒN LẠI, chấp nhận: ở LQ retouch được tính ở 406x722 thay vì 1080x1920 nên CHI TIẾT hơi
khác HQ (mịn hơn). Đó là bản chất của proxy; bản xuất luôn dùng full-res.
```

### Hai Lỗi Của Bản Xuất Khi Có Retouch (đã sửa 2026-08-08)

```text
Hai lỗi khác nhau, cùng lộ ra trong một dự án thật (2 block, Retouch + LUT + Tốc độ).

--- LỖI 1: "TIẾNG ĐƯỢC SPEED CÒN HÌNH THÌ KHÔNG" ---
NGUYÊN NHÂN: khâu bake chuỗi khung Retouch (bakeRetouchSequence) lấy giờ nguồn bằng
`clip.start + k/exportFps`. `k/exportFps` là thời gian TRÊN TIMELINE, phải NHÂN `rate`
mới ra giờ nguồn. Không có tốc độ thì hai trục trùng nhau nên không lộ; có tốc độ thì
chuỗi khung đi qua nguồn ở 1x trong khi hình nền (setpts) và tiếng (atempo) đã chạy ở
`rate`. Hệ quả theo từng đường:
  - đường VÁ VÙNG MẶT   : miếng vá lấy mặt ở thời điểm khác -> lệch khung vùng vá.
  - đường BAKE CẢ KHUNG : chuỗi khung này CHÍNH LÀ hình nhìn thấy -> cả đoạn phát ở tốc
    độ thường trong khi tiếng đã nhanh/chậm. Đây đúng là triệu chứng người dùng báo, và
    dự án gặp lỗi có `plump: 100` (biến dạng = hiệu ứng KHÔNG GIAN) nên rơi vào đường này.
SỬA: dùng chung ClipSpeed.sourceTimeAt(sourceStart, localSeqTime, rate, sourceSpan) cho
CẢ hai khâu bake (lane chính + overlay). Kẹp theo độ dài NGUỒN, không theo độ dài
timeline — kẹp nhầm là khung cuối đứng hình sớm (2x thì đứng ngay từ nửa block).
Test: npm run test:clip-speed, mục "GIỜ NGUỒN CỦA KHUNG BAKE".

--- LỖI 2: LỘ HÌNH CHỮ NHẬT VÙNG VÁ KHI CÓ LUT ---
CÁCH TÌM RA (ghi lại vì mấy giả thuyết đầu đều SAI, đừng thử lại):
  · KHÔNG phải do chuỗi màu khác nhau: lấy spec THẬT từ app đang chạy cho cả hai nhánh
    (nền dùng cỡ NGUỒN, miếng vá dùng cỡ SEQUENCE) -> hai chuỗi filter và cube GIỐNG HỆT.
  · KHÔNG phải do lut3d: chạy lut3d trên video yuv420p và trên ảnh rời -> khớp tuyệt đối.
  · KHÔNG phải do colorbalance/curves: cũng khớp tuyệt đối.
  · `eq` có lệch nhưng chỉ 1/255 (nó chạy trên YUV với video, trên RGB với ảnh).
NGUYÊN NHÂN THẬT: pixel của miếng vá do TRÌNH DUYỆT giải mã (thẻ <video> -> canvas), còn
pixel quanh nó do FFMPEG giải mã CÙNG file. Hai bộ giải mã lệch nhau. Đo trên nguồn thật
(1080x1920, bt709/tv, cắt bằng `-c copy` nên không do mã hoá lại), trung bình cả khung:
    trình duyệt 149.62 / 139.83 / 131.22   vs   ffmpeg 147.35 / 138.05 / 129.11
    -> lệch +2.28 / +1.78 / +2.12 và lệch ĐỀU (64/64 ô lưới đều +2.1..+2.4).
Kiểm chéo: ảnh PNG qua canvas khớp ffmpeg TUYỆT ĐỐI, và ramp xám thuần qua video cũng
khớp tuyệt đối -> lệch nằm ở đường chroma của bộ giải mã video, không phải ở canvas,
không phải ở dải/gamma. 2/255 vốn không nhìn ra, nhưng chuỗi LUT + tương phản + "whites"
có độ dốc > 1 ở vùng sáng nên khuếch đại bậc nhảy tại mép miếng vá tới ngưỡng mắt thấy.

VÌ SAO KHÔNG CHỮA BẰNG BÙ MÀU: sai lệch đến từ bộ giải mã của Chromium — đổi theo phiên
bản, theo máy, theo có giải mã phần cứng hay không. Bù một hằng số đo hôm nay là sai vào
hôm khác.

SỬA: LÀM MỀM MÉP miếng vá.
  · frontend: retouchPatchRect NỚI hộp cắt ra đúng bằng bề rộng dải mềm trước khi trả về
    (hộp vốn bao SÁT phần bị retouch đổi; làm mềm ngay trên nó là ăn mất một vòng retouch
    ở rìa). Dải mềm = clamp(6, 24, 6% cạnh ngắn) -> nằm trọn trong vùng KHÔNG bị retouch,
    chỗ đó miếng vá và khung nền vốn cùng một hình.
  · payload: field `feather_px`, CHỈ miếng vá đặt (overlay thường và chuỗi khung chuyển
    cảnh vẫn 0).
  · sidecar: AppendFeatherAlpha nối `geq` sau `format=rgba`, chỉ đụng kênh ALPHA:
    a = alpha(X,Y) * min(1, khoảng_cách_tới_mép / feather).
    Dấu nháy đơn đã bảo vệ dấu phẩy trong biểu thức — cùng quy ước với geq của nhánh
    keyframe opacity ngay trên nó, ĐỪNG escape thêm (escape thành `\,` là hỏng biểu thức).
ĐO ĐƯỢC: miếng vá sáng hơn nền đúng 2/255, cùng qua chuỗi có LUT ->
    mép cứng: bậc nhảy 2/255 dồn vào MỘT pixel (145 -> 147)
    mép mềm : trải thành dốc, bậc lớn nhất còn 1/255 (145,145,146,146,146,147)
CHI PHÍ: geq chạy mỗi khung. Đo trên miếng vá 420x520, 300 khung: 1.58 s (8.8 s CPU).
Nhỏ so với khâu bake khung ở frontend mà retouch vốn đã phải làm. Muốn tối ưu tiếp thì
dựng dải alpha MỘT LẦN rồi `alphamerge`, hoặc thay geq bằng boxblur trên kênh alpha.
Test: npm run test:retouch-export, mục "mép miếng vá".

CÒN LẠI, CHƯA SỬA: bản xuất được gắn thẻ `yuvj420p / pc / smpte170m` trong khi nguồn là
`yuv420p / tv / bt709`. Không gây ra hai lỗi trên (cả khung cùng chịu như nhau) nhưng là
thẻ SAI, và trình phát nào tôn trọng thẻ sẽ hiện màu khác ý định.
```

### Hiệu Năng Preview Vùng Chuyển Cảnh (đã sửa 2026-08-15)

```text
- TRIỆU CHỨNG: playhead đi qua vùng chuyển cảnh "phức tạp" là preview giật hẳn.
- ĐO ĐƯỢC (máy dựng, render phần mềm; sequence dọc 1080×1920, vùng chuyển cảnh 0.5s @30fps, ms mỗi khung):
      hiệu ứng        cỡ sequence 1080×1920   cỡ dpr 778×1382   cỡ css 389×691
      Xoắn (swirl)          73.3                   33.3              9.1
      Trượt xuống            0.2                    0.2              0.2
      Quét trái / Mở vòng tròn / Mờ dần   ~0.01–0.03 ở mọi cỡ
  => KHÔNG phải "chuyển cảnh phức tạp" nói chung: chỉ "Xoắn" đắt, và đắt gấp ~300 lần mọi
  hiệu ứng khác. Lý do: nó là hiệu ứng DUY NHẤT phải nắn TỪNG PIXEL bằng JS (canvas 2D không
  có shader) — 2.07 triệu phép lấy mẫu song tuyến mỗi khung. Ngân sách 30fps chỉ có 33 ms.
  Cửa trập (tối đa 16 mẫu con) KHÔNG phải thủ phạm: mẫu con là drawImage, có tăng tốc phần
  cứng, nên "Trượt xuống" vẫn chỉ 0.2 ms.
- NGUYÊN NHÂN GỐC: composite luôn dựng ở CỠ SEQUENCE rồi để CSS thu nhỏ về khung xem trước
  (~389 CSS px bề ngang). Toàn bộ công vẽ ở phần dư bị vứt đi.
- SỬA: dựng ở cỡ HIỂN THỊ (transitionRenderScale trong editing-runtime.js), hai mức chất
  lượng như mọi app dựng phim — và đúng lối Retouch trong chính dự án này đã dùng (lưới 128
  khi phát, 256 khi dừng):
      ĐANG PHÁT -> đúng số CSS px của khung xem trước (bỏ devicePixelRatio)
      ĐANG DỪNG -> nhân devicePixelRatio, để hình đứng vẫn nét trên màn Retina
  "Xoắn" khi phát: 73.3 -> 9.1 ms/khung (nhanh gấp 8).
- CÁCH GIỮ ĐÚNG BỐ CỤC: KHÔNG sửa một công thức hình học nào. Callback vẽ vẫn nhận (seqW,
  seqH) và tính đặt lớp trong toạ độ SEQUENCE; chỉ bọc thêm `g.save(); g.scale(rs, rs); …;
  g.restore()`. Canvas nhỏ đi, toạ độ giữ nguyên. Đối chiếu ảnh giữa "dựng full rồi hạ cỡ"
  và "dựng thẳng ở cỡ nhỏ": lệch TRUNG BÌNH 0.4–1.4 / 255 cho cả 6 hiệu ứng đã thử (chênh
  lớn chỉ xuất hiện đúng ở điểm ảnh mép do lấy mẫu lại — lệch bố cục thì trung bình đã phải
  lên hàng chục).
- Đường XUẤT không đụng tới: bake vẫn dựng ở cỡ sequence đầy đủ (2 chỗ gọi compose riêng).
```

### SFX Mất Tiếng Khi Preview — Pre-roll (đã sửa 2026-08-15)

```text
- TRIỆU CHỨNG: một số SFX do Auto Sound Effects điền vào thì preview KHÔNG nghe thấy gì, dù
  block vẫn nằm đó và bản xuất vẫn có tiếng.
- NGUYÊN NHÂN: phần tử <audio> chỉ được TẠO đúng lúc playhead chạm vào block (nhánh
  `sortedItems` lọc theo `seqTime` nằm TRONG block). Trình duyệt còn phải tải + giải mã +
  seek rồi mới ra tiếng — cỡ 100–300 ms. Mà SFX của ASE phần lớn là tiếng "pop" chỉ 0.21s
  (đo trên dự án thật: 19 SFX thì 15 cái dài đúng 0.21s): cả block trôi qua trước khi âm
  thanh đầu tiên kịp phát, rồi phần tử bị dọn vì đã rời khỏi vùng active. Block càng ngắn
  càng chắc chắn mất.
- SỬA: PRE-ROLL, đúng cách các app dựng phim nạp sẵn tiếng trước playhead.
    AUDIO_PREROLL_SEC = 2.0  -> block sắp tới trong 2s được tạo phần tử + preload='auto' +
                                seek sẵn tới đúng offset nguồn, nhưng KHÔNG phát.
    AUDIO_KEEP_SEC    = 1.0  -> giữ thêm 1s sau khi block kết thúc, để tua tới lui quanh đó
                                không phải tạo/huỷ (mỗi lần tạo là một lượt tải + giải mã).
  Tới lúc playhead chạm vào, play() chạy trên phần tử đã sẵn sàng -> ra tiếng ngay.
- BẪY: chỉ seek MỘT LẦN cho mỗi lượt pre-roll (cờ `dataset.prerollAt`). Seek lại mỗi khung
  là huỷ đúng cái buffer vừa nạp — hỏng hẳn mục đích. Vào tới block thì xoá cờ để lần tua ra
  ngoài sau còn seek lại được.
- `ensureAudioEl()` dùng CHUNG cho cả nhánh đang phát lẫn nhánh pre-roll, để hai bên không
  lệch nhau về cách dựng phần tử.
```

### Trộn Tiếng Khi Xuất — amix normalize=0 (đã sửa 2026-08-15)

```text
- TRIỆU CHỨNG: chạy Auto Sound Effects xong rồi xuất video thì TOÀN BỘ tiếng nhỏ hẳn so với preview — kể cả lời thoại ở lane chính, thứ mà ASE không hề đụng vào.
- NGUYÊN NHÂN: `amix` của FFmpeg mặc định `normalize=1`, tức CHIA MỌI ĐẦU VÀO cho số luồng. Lane chính + 5 SFX + 1 nhạc nền = 7 luồng -> mọi thứ bị nhân 1/7 = −20·log10(7) ≈ −16.9 dB. Càng thêm tiếng càng nhỏ đi, ngược hoàn toàn với trực giác.
  - Đo trên bản dựng thật (sine 440 Hz ở lane chính, lọc dải quanh 440 Hz để tách riêng phần của lane chính khỏi bản trộn):
      lane chính một mình  −21.12 dB
      trong bản trộn 7 luồng, normalize=1  −38.01 dB  (mất 16.89 dB — khớp đúng lý thuyết 16.90)
      trong bản trộn 7 luồng, normalize=0  −21.10 dB  (lệch 0.02 dB)
- VÌ SAO PREVIEW KHÔNG BỊ: preview nối mỗi block audio qua một GainNode rồi cộng thẳng vào destination của WebAudio. Không có bước chia nào cả. Nên chỉ `normalize=0` mới cho preview ≙ bản xuất — nguyên tắc chung của dự án.
- Lý lẽ thêm: âm lượng từng block ĐÃ do người dùng (hoặc ASE: SFX −6 dB, nhạc nền −13 dB) đặt. Chia thêm một lần nữa theo số luồng là phủ nhận chính các con số đó, và kết quả còn phụ thuộc vào việc timeline có bao nhiêu block audio — cùng một dự án, thêm một tiếng "tách" là cả phim nhỏ đi.
- Chỗ sửa: `WriteFilterScript` trong `native/sidecar/core_process.cpp` — `amix=inputs=N:duration=first:dropout_transition=0:normalize=0`. `dropout_transition` giữ 0 nhưng nay vô hiệu (nó chỉ có tác dụng khi normalize=1), để lại cho rõ ý.
- ĐÁNH ĐỔI đã cân nhắc: cộng thẳng thì tổng có thể vượt 0 dBFS và bị kẹp. Trên lý thuyết xấu nhất (mọi đỉnh trùng nhau, nguồn đầy thang) tổng lên tới +11.4 dBFS. KHÔNG thêm limiter, vì preview cũng cộng thẳng và cũng kẹp y hệt — thêm limiter chỉ ở đường xuất là phá vỡ preview ≙ xuất, đúng thứ vừa đi sửa. Nếu nghe vỡ tiếng thì cần lever, không phải bộ nén: hạ âm lượng lane chính, hoặc hạ "Âm lượng SFX" / "Âm lượng nhạc nền" ở bảng Cài đặt.
- Test: `npm run test:audio-mix` (tests/scripts/audio_mix_levels.js). Đã kiểm ngược: khôi phục normalize mặc định thì test gãy đúng chỗ với 16.89 dB.
```

### Khử Tiếng Ồn (Noise Reduction) — Subtab "Âm thanh" Ở Inspector

```text
CHỖ ĐẶT: subtab "Âm thanh" của Inspector, ngay dưới Volume/Tắt âm thanh. Có ở CẢ clip
lane chính lẫn block overlay có tiếng (audio + media video). Ảnh tĩnh không có tab này.
  - Công tắc "Khử tiếng ồn"
  - "Kiểu ồn": Giọng nói / Tiếng ồn nền / Mạnh
  - "Mức độ": 0-100%, hiện luôn "Giảm tối đa X dB" để người dùng biết đang ép bao nhiêu

MÔ HÌNH: clip.audio_denoise / item.audio_denoise = {enabled, profile, amount}.
KHÔNG có field = TẮT — tắt lại thì field bị XOÁ, dự án cũ mở lên không mọc thêm dữ liệu.
Nằm ngay trên clip/item nên tự đi theo undo/redo, .crab và payload export như Volume,
không có đường lưu riêng nào.

MỘT BẢNG QUY ĐỔI CHO CẢ HAI ĐƯỜNG: static/js/audio-denoise.js (UMD).
  - previewParams() -> tham số cho AudioWorklet (Web Audio)
  - ffmpegFilters() -> ["highpass=f=90", "afftdn=nr=17.6:nf=-28"] cho FFmpeg
  backend/server.js REQUIRE CHÍNH file này (không phải bản chép) và tự dựng chuỗi filter
  từ {enabled, profile, amount}. Khác với color_adjust (frontend sinh chuỗi vì phụ thuộc
  LUT/keyframe): ở đây chỉ 3 con số qua dây nên không có bề mặt chèn filter lạ.

PREVIEW — static/js/denoise-worklet.js:
  source -> [highpass BiquadFilter] -> [AudioWorklet 'crabbycut-denoise'] -> gain -> out
  Tắt khử ồn thì nối thẳng source -> gain: không tốn CPU, không thêm độ trễ. Chuỗi CHỈ
  được nối lại khi CHỮ KÝ đổi (bật/tắt, đổi kiểu/mức, worklet vừa nạp xong) — hàm này bị
  gọi mỗi khung hình của vòng preview, nối lại mỗi khung là nghe rõ tiếng "tách".
  Worklet nạp hỏng -> rơi về tuyến chỉ có highpass, KHÔNG làm đứt đường tiếng.
  Thuật toán: STFT sqrt-Hann 512/hop 128 -> ước lượng nhiễu bằng THỐNG KÊ CỰC TIỂU
  (~0.5-1 s) -> độ lợi Wiener với SNR tiên nghiệm "hướng theo quyết định" (Ephraim-Malah)
  -> ISTFT overlap-add. Độ trễ 1 cửa sổ ≈ 10.7 ms @48kHz (dưới ngưỡng thấy lệch tiếng-hình
  ~45 ms) nên KHÔNG bù trễ ở chỗ nào khác.
  ĐÃ THỬ VÀ HỎNG: ước lượng nhiễu kiểu "trung bình có bám" (xuống nhanh/lên chậm). Sau
  vài giây chính giọng nói kéo ước lượng lên và bị cắt sạch — đo được giọng mất đúng bằng
  mức sàn, còn nền ồn chỉ giảm 6.8 dB. Nền ồn lộ ra ở ĐÁY công suất theo thời gian, nên
  phải lấy cực tiểu chứ không lấy trung bình.

EXPORT — chuỗi chèn NGAY SAU atrim và TRƯỚC volume, ở CẢ hai nhánh:
  lane chính   : [0:a]atrim=...,asetpts=PTS-STARTPTS,<khử ồn>,volume=...,aresample=48000
  audio overlay: [N:a]atrim=...,asetpts=PTS-STARTPTS,<khử ồn>,volume=...,adelay=...
  Vì sao TRƯỚC volume: lọc trên tiếng NHƯ ĐÃ THU rồi mới tới mức người dùng đặt. Đảo lại
  thì kéo Volume là đổi luôn kết quả khử ồn, trong khi preview thì không (bên đó gain
  nằm cuối chuỗi Web Audio) -> hai bên lệch nhau.
  Vì sao chạy trên đoạn ĐÃ atrim (từng block) chứ không trên cả file: mỗi block có thể là
  một lần thu khác nhau; chạy chung thì block ồn kéo lệch block sạch.

VÌ SAO KHÔNG DÙNG `tn=1` (track_noise) CỦA afftdn — đo trên FFmpeg 8.1:
  - Bật tn: gần như KHÔNG khử gì (-0.2 dB) ở mọi tổ hợp nf/fo/nl đã thử.
  - nf CỐ ĐỊNH: nền ồn giảm ĐÚNG bằng `nr` (đo -10.0 / -20.0 / -29.4 dB cho nr = 10/20/30)
    và ĐỘC LẬP với mức ồn của nguồn — cùng con số trên nguồn ồn -31 dBFS lẫn -55 dBFS.
  Nhờ tính độc lập đó KHÔNG cần đo trước sàn nhiễu của từng file (đã cân nhắc dùng astats
  hoặc percentile của file .pk; .pk có độ phân giải RMS 1 byte nên quá thô).
  Hệ quả: `nr` (thanh "Mức độ") là đại lượng điều khiển thật, `nf` chỉ chỉnh mức nương tay.

ĐO ĐƯỢC (tests/scripts/audio_denoise_pipeline.js, tín hiệu dạng lời nói + ồn trắng):
  cấu hình          nr      preview (nghỉ/tiếng)   export (nghỉ/tiếng)
  voice   / 60%     17.6    -17.6 / -1.3 dB        -16.6 / -0.5 dB
  room    / 80%     26.0    -25.9 / -1.5 dB        -25.3 / -0.6 dB
  strong  / 100%    40.0    -37.7 / -1.6 dB        -35.7 / -0.9 dB
  Hai đường lệch nhau ≤ 2 dB. Con số của preview đã kiểm lại TRONG BROWSER THẬT bằng
  OfflineAudioContext + AudioWorklet: trùng khít với bản chạy trong Node.

KIỂM CHỨNG (npm run test:audio-denoise, đã nằm trong npm test):
  1. Hợp đồng module: normalize/kẹp dải, nr và nf nằm trong dải afftdn cho phép, floorGain
     của preview = 10^(-nr/20) (điểm nối giữ hai đường cùng mức), chuỗi filter không chứa
     ký tự tách filter, và chốt "không được có tn=".
  2. Preview vs export trên cùng tín hiệu: cả hai giảm gần đúng `nr` dB ở khoảng NGHỈ và
     giữ nguyên đoạn CÓ TIẾNG; hai bên không lệch quá 5 dB.
     (Test dùng tín hiệu dạng lời nói — burst 0.4s xen im lặng. Sine LIÊN TỤC là phép thử
     sai: nó đứng yên theo thời gian nên đúng định nghĩa là "nhiễu dừng", bộ khử nhiễu nào
     cũng phải cắt nó.)
  3. Độc lập với mức ồn nguồn: chạy lại trên nguồn êm hơn 24 dB, kết quả không đổi quá 3 dB.
  4. Dây nối thật: xuất HAI lần qua backend (bật/tắt) rồi so hai file. Bố trí để tách được
     hai nhánh — 0-2s chỉ có lane chính, 2-4s chỉ có audio overlay (lane chính volume 0).
     Đo được lane chính -25.9 dB và audio overlay -39.8 dB. Kèm kiểm payload
     export_timeline.json: chỉ block/item thật sự bật mới có `audio_denoise_filter`.
     LƯU Ý: KHÔNG đọc được filter script của sidecar để kiểm vị trí chuỗi — sidecar xoá
     export_filter_batch_*.txt ngay sau khi render xong.
```

### Điều Chỉnh Màu (Color Adjustments) — Panel "Điều chỉnh" Ở Inspector

> PHẦN CÒN LẠI, hành vi FFmpeg đã đo và các bẫy khi đo: xem `docs/COLOR_ADJUST_TODO.md`.
> Mục dưới đây ghi phần ĐÃ LÀM và LÝ DO thiết kế.

```text
- PHẠM VI: áp cho BLOCK có nguồn hình thật — clip lane chính (latestTimeline[i].adjustments)
  và media overlay ảnh/video (editingItems[].adjustments). Text/shape KHÔNG có (do frontend
  tự vẽ, muốn đổi màu thì sửa thẳng style). Panel nằm ở tab "Điều chỉnh" của Inspector phải,
  6 subtab: Cơ bản / HSL / Curves / Vòng tròn màu / LUT / Mặt nạ.
  BỐ CỤC subtab "Cơ bản" (theo CapCut, sửa 2026-07-29): 3 nhóm — **Độ sáng** (Phơi sáng,
  Tương phản + 5 thông số đường cong tone), **Màu sắc** (Nhiệt độ, Sắc thái, Bão hoà),
  **Hiệu ứng** (5 phép không gian). Phơi sáng/Tương phản nằm ở nhóm Độ sáng nhưng DỮ LIỆU vẫn
  là `basic.exposure` / `basic.contrast` — đừng đổi sang `tone.*` cho "gọn": `eq` là filter
  màu duy nhất nhận biểu thức nên keyframe của chúng đang rẻ, chuyển sang `curves` là mất.

- ENGINE DÙNG CHUNG: static/js/color-adjust.js (UMD -> window.ColorAdjust), nạp TRƯỚC
  editing-runtime.js. Đây là NGUỒN SỰ THẬT DUY NHẤT: công thức viết một lần rồi dùng lại ở
  (a) GLSL shader preview, (b) bộ sinh chuỗi filter FFmpeg cho export, (c) bộ bake .cube.
  Muốn thêm/sửa một phép chỉnh màu thì sửa TRONG file này, không rải ra chỗ khác.

- CHUỖI XỬ LÝ (thứ tự CỐ ĐỊNH, preview và export giống hệt):
    1. Cơ bản      Exposure + Contrast + Saturation   -> `eq`
    2. Độ sáng     Vùng sáng/Bóng/Vùng sáng nhất/     -> `curves` (đường cong tone)
                   Vùng tối nhất/Độ chói
    3. Nhiệt/tông  Temperature + Tint + 3 vòng tròn   -> `colorbalance`
    4. Curves      4 kênh all/r/g/b                   -> `curves`
    5. HSL + LUT   8 dải màu + LUT người dùng         -> `lut3d` (bake ra .cube)

- NHÓM ĐỘ SÁNG — `adjustments.tone`, gộp 5 thông số thành MỘT đường cong tone
  (`toneCurvePoints`), xuất bằng một filter `curves` đặt TRƯỚC 2 curves của người dùng.
  Cố ý KHÔNG gộp Exposure/Contrast/Saturation vào đây: `eq` là filter màu duy nhất nhận
  biểu thức theo thời gian, nên 3 thông số đó phải ở lại `eq` để sau này keyframe được rẻ.
  MÔ HÌNH: `y(x) = x + Σ (thông số × nhân cos² cục bộ)` rồi kẹp [0,1], lấy mẫu ra 17 điểm
  điều khiển. Preview dựng bảng tra TỪ CHÍNH 17 điểm đó (`toneLut` -> `toneCurvePoints`)
  nên hai bên luôn khớp. Vùng ảnh hưởng: Bóng [0, 0.5] · Độ chói [0, 0.84] · Vùng sáng
  [0.5, 1] · điểm đen [0, 0.35] · điểm trắng [0.65, 1].
  BA LỖI ĐÃ MẮC Ở BẢN ĐẦU (sửa 2026-07-28) — đừng dựng lại kiểu ghim 5 điểm cố định:
  1. Dịch y ngay tại 2 điểm biên -> "Vùng sáng nhất" tăng bị kẹp trần y=1 và "Vùng tối
     nhất" giảm bị kẹp sàn y=0, hai slider CHẾT HOÀN TOÀN (đo được 128->128, 32->32,
     224->224). Đúng cách: nhân đạt cực đại NGAY TẠI biên rồi để phép kẹp [0,1] tự tạo ra
     "nghiến đen"/"cháy sáng" như Lightroom.
  2. Ghim cứng điểm ở x=0.4 -> nâng Bóng lên 100 lại LÀM TỐI trung tính (128->115).
  3. Biên độ ±0.15 quá nhỏ, kéo hết slider chỉ đổi ~4% -> người dùng tưởng không có tác dụng.
  Hệ quả nếu bỏ hết điểm neo (đã thử): spline lan tác động ra TOÀN DẢI, shadows=100 đẩy xám
  128 lên 196 — "Bóng" hoá thành "độ sáng tổng". Vì vậy phải dùng nhân cục bộ, không phải
  điểm điều khiển rời.
  LƯU Ý ĐO LƯỜNG: spline vượt biên nhẹ giữa 2 điểm mẫu là bình thường, sâu nhất đo được
  0.24/255 — dưới một bậc lượng tử nên biến mất khi làm tròn 8-bit. Đừng đi tìm bug ở đây.
  Quy đổi tham số nằm gọn trong color-adjust.js: exposure (nhân) được GỘP vào cặp
  (contrast, brightness) của eq bằng biến đổi tuyến tính chính xác — eq không có tham số nhân.
  lift/gamma/gain của vòng tròn màu ánh xạ 1-1 sang shadows/midtones/highlights của
  colorbalance nên không mất mát.

- NHÓM HIỆU ỨNG — `adjustments.effects` (Làm sắc nét / Độ rõ nét / Hạt nhỏ / Làm mờ /
  Viền mờ dần). ĐÃ XONG cả engine, export, preview nhiều lượt và UI.
  Đây là các phép KHÔNG GIAN (đọc pixel lân cận) nên không gộp được vào lut3d, và luôn
  nằm CUỐI chuỗi. Thứ tự: Độ rõ nét -> Làm sắc nét -> Làm mờ -> Hạt -> Viền mờ (chi tiết
  trước, hiệu ứng ống kính sau; đặt hạt trước khi làm nét thì nét luôn cả hạt).
  ĐỘC LẬP ĐỘ PHÂN GIẢI (bắt buộc): mọi bán kính khai theo TỈ LỆ CHIỀU CAO KHUNG rồi mới
  quy ra pixel, nên preview 540px và bản xuất 1080px cho cùng cảm giác. `ffmpegFilters`
  vì thế nhận thêm tham số `frameHeight` — truyền sai là bản xuất mờ/nét khác preview.
  BỐN HÀNH VI CỦA FFMPEG ĐÃ ĐO ĐƯỢC (đừng đoán lại, đừng "sửa cho đúng hơn"):
  1. Hạt nhân mờ của `unsharp` là BINOMIAL TÁCH TRỤC bậc (msize−1), KHÔNG phải trung bình
     hộp. Đo bằng mẹo `la=-1` (khi đó đầu ra ĐÚNG BẰNG ảnh đã mờ) rồi đọc đáp ứng xung:
     msize=5 cho [1,4,6,4,1]/16, msize=13 khớp Pascal bậc 12. Dùng hộp thì lệch 12/255 ở
     cạnh tương phản. Nhờ tách trục, preview chỉ cần 2 lượt 13 tap thay vì 169 tap.
  2. `unsharp` phải chạy ở YUV (đã ép `format=yuv444p` tường minh). Nó CŨNG nhận gbrp,
     nhưng khi đó `luma_amount` áp vào plane 0 = kênh G và `ca=0` tắt B/R -> chỉ làm nét
     MỘT kênh màu.
  3. `vignette` nhân hệ số THẲNG vào plane dải hẹp: `Y'=Y·f`, `U'=(U−128)·f+128`. Tức
     nhân cả sàn đen 16, lệch đúng 16·(f−1) ≈ 18/255 ở góc so với việc nhân RGB. Đã thử
     chèn `format=gbrp` để ép nó sang RGB: KHÔNG được, FFmpeg vẫn đàm phán về YUV. Vì vậy
     preview phải bắt chước đúng cách này — xem `vignetteFactorToRgb()`.
     Công thức: `f = cos⁴(angle·t)`, `t = min(1, dist/dmax)`,
     `dmax = hypot(max(x0,w−x0), max(y0,h−y0))`, tâm là `w/2` (KHÔNG phải `(w−1)/2` —
     dùng sai lệch 5.5/255 ở góc).
  4. "Làm mờ" dùng `avgblur` XẾP TẦNG 3 lần, KHÔNG dùng `gblur`. `gblur` là xấp xỉ Gauss
     ĐỆ QUY (IIR) — fragment shader không tái tạo được (đệ quy theo từng dòng); dùng Gauss
     thật ở preview để khớp "gần gần" thì lệch p95 ≈ 7/255 ở mọi sigma (đã đo ở
     64/256/540px với steps=1..6). `avgblur` là trung bình HỘP chính xác (đáp ứng xung:
     sizeX=1 cho đúng 255/9 mỗi tap) nên shader tái tạo được tuyệt đối.
  HẠT NHỎ là chỗ DUY NHẤT trong panel không WYSIWYG tuyệt đối: nhiễu ngẫu nhiên nên
  preview và bản xuất khớp CƯỜNG ĐỘ chứ không khớp từng hạt. Không phải bug.

- PREVIEW NHIỀU LƯỢT cho nhóm Hiệu ứng (`spatialPasses` + `CanvasColorRenderer`):
  MỖI lượt shader tương ứng đúng MỘT filter FFmpeg, nên nếu `ffmpegFilters` đổi thì
  `spatialPasses` cũng phải đổi theo — WYSIWYG được giữ bằng CẤU TRÚC, không bằng may.
  - 3 chương trình GLSL: `CONV_SRC` (tích chập 1D, cờ `uLumaOnly`), `UNSHARP_MIX_SRC`
    (`orig + amount·(luma(orig) − lumaĐãMờ)`, đọc thêm texture ảnh ghim), `PIXEL_FX_SRC`
    (hạt + viền mờ). Ping-pong 3 texture đệm: ping / pong / orig.
  - `MAX_TAPS = 33`, tap giữa ở chỉ số 16, các tap không dùng ĐỆM SỐ 0. Cố ý KHÔNG dùng
    `break` theo uniform trong vòng lặp GLSL ES 1.0 (không chắc chắn giữa các driver).
    Kéo theo: bán kính "Làm mờ" bị kẹp ở 16 (bề rộng 33) — kẹp trong `effectsSpec` là
    nguồn DÙNG CHUNG nên export và shader vẫn khớp, chỉ là từ ~2700px chiều cao trở lên
    thì mờ bão hoà.
  - Tích chập nhân alpha vào trước khi cộng rồi chia lại (premultiplied): cộng thẳng RGB
    thì mép bán trong suốt của overlay bị kéo màu vùng rỗng vào, tạo viền tối.
  - `saveOriginal` sao chép ảnh bằng một lượt `UNSHARP_MIX_SRC` với `amount=0` — WebGL1
    không có `glBlitFramebuffer`, và làm vậy đỡ phải thêm một shader chỉ để copy.
  - LANE CHÍNH: khi có hiệu ứng không gian, `resizeAndRender` KHÔNG dùng PIXI.Filter nữa
    mà đưa khung hình qua CHÍNH `CanvasColorRenderer` (`EditingRuntime.colorAdjustedDrawable`)
    rồi lấy canvas kết quả làm texture cho sprite. Cố ý KHÔNG viết một PIXI.Filter nhiều
    lượt riêng: hai bản cài đặt của cùng một chuỗi thì sớm muộn cũng lệch. Chỉ chỉnh MÀU
    thì vẫn đi đường PIXI.Filter một lượt (rẻ hơn).
  - `frameHeight` truyền vào `ffmpegFilters` là chiều cao của STREAM mà filter chạy trên
    đó (kích thước NGUỒN, vì chuỗi màu chèn TRƯỚC bước scale), KHÔNG phải chiều cao
    sequence. Preview thì dùng chiều cao ảnh đang xử lý (proxy). Hai bên khác số pixel
    nhưng cùng TỈ LỆ nên cùng cảm giác — đó là mục đích.
  - Probe Electron (GPU thật, so với `applyToImage`): sharpen 100 max 1.5 · clarity 100
    max 1.0 · blur 100 max 1.0 / p95 0 (hộp là phép chính xác) · vignette ± max 4.3-5.1 ·
    15 lượt cùng lúc max 2.8 / p95 1.5. HIỆU NĂNG: **0.04 ms/frame ở 1920×1080 với 15 lượt**.

- CÂN BẰNG TRẮNG (ống hút, trong subtab Cơ bản) — `ColorAdjust.solveWhiteBalance()`.
  Người dùng bấm nút rồi chọn một điểm đáng lẽ trung tính trên preview; kết quả ghi vào
  CHÍNH `temperature`/`tint` đang có, CỐ Ý không thêm filter mới — nhờ vậy export, keyframe,
  undo đều đi theo đường sẵn có, không phát sinh gì.
  - NGHIỆM ĐÓNG, không dò lặp: temp/tint chỉ tác động ở bước `colorbalance`, và ở đó chúng
    cộng ĐỀU vào cả 3 nhóm nên mỗi kênh chỉ bị dịch thêm một lượng TUYẾN TÍNH `d·K` với
    `K = cbWeightSum(l)`. Đặt A = baseR−baseG, B = baseB−baseG thì `t·K = (B−A)/2` và
    `ti·K = (A+B)/3`. Đo sau khi áp: 3 kênh lệch ≤0.6/255 ở mọi ca thử, kể cả khi đã có
    eq/tone/vòng tròn màu đứng trước.
  - MỐC CHUẨN là "sau colorbalance", KHÔNG phải "sau cả chuỗi": curves/HSL/LUT là lựa chọn
    sáng tạo, có thể phá tính trung tính theo cách temp/tint không sửa được. Cân bằng trắng
    theo nghĩa nhiếp ảnh là chỉnh ở khâu cân bằng màu.
  - ĐIỀU KIỆN LOẠI là pixel đã KẸP đen/trắng (max < 0.06 hoặc min > 0.96), KHÔNG phải K≈0:
    ở đen tuyệt đối trọng số shadows đạt CỰC ĐẠI (K=0.7) nên nhánh K≈0 gần như không bao
    giờ chạy — đã mắc lỗi này, test nay chốt lại `cbWeightSum(0) === 0.7`.
  - LẤY MÀU NGUỒN, không lấy pixel đang hiện: `pickPreviewSourceColor()` (index.html) đảo
    phép biến đổi của sprite lane chính (translate → rotate → scale, anchor giữa) để quy
    điểm bấm về toạ độ texture, rồi đọc trung bình ô 5×5 từ `<video>` (một pixel đơn lẻ
    mang đủ nhiễu nén để lệch thấy được). Các con số dùng để đảo được LƯU LẠI trong
    `renderer.sourceMap` NGAY TẠI chỗ vẽ sprite — tự tính lại ở nơi khác là sớm muộn cũng
    lệch khi công thức vẽ đổi. Probe Electron: sai số ánh xạ ngược = 0 pixel với cả 6 tổ
    hợp dịch/xoay/co giãn/lật X/lật Y.
  - Chế độ chọn điểm (`startAdjustPick`) đặt listener ở pha CAPTURE và chặn hẳn sự kiện —
    nếu không, pointerdown rơi xuống overlay item bên dưới và cú bấm biến thành chọn/kéo
    block. Esc hoặc bấm lại nút để huỷ; `onStepChanged` cũng gọi `stopAdjustPick()` để
    listener không treo lại sang bước khác.
  - LISTENER PHẢI Ở TẦNG **SHELL**, KHÔNG Ở KHUNG PREVIEW (sửa 2026-07-29 — lỗi thật, người
    dùng báo "chọn block overlay thì không hút được"): `#editingSelectionBox` và
    `#adjMaskOverlay` là con của `#sequencePreviewShell` chứ KHÔNG của
    `#sequencePreviewFrame`, mà chúng PHỦ ĐÚNG lên block đang chọn và có `pointer-events:auto`.
    Hệ quả đo được bằng `elementFromPoint` trên chính dự án của người dùng: bấm giữa block
    overlay thì phần tử trúng là `div#editingSelectionBox` (`cursor: default`, ngoài khung) nên
    listener gắn ở khung KHÔNG BAO GIỜ thấy cú bấm — đúng triệu chứng "đưa chuột lên block
    overlay không hiện con trỏ hút màu"; còn bấm ở vùng lane main thì trúng khung, có
    crosshair, nhưng điểm đó nằm NGOÀI hộp của block overlay đang chỉnh nên hút ra rỗng.
    Cách sửa: (1) listener nghe ở SHELL, chỉ xử lý khi điểm bấm nằm TRONG rect của khung (bấm
    ở vùng letterbox thì để nguyên, không huỷ chế độ hút); (2) thêm class `is-color-picking`
    lên CẢ shell, CSS tắt `pointer-events` của khung chọn + tay cầm mặt nạ trong lúc hút.
    BẪY KHI ĐO: probe đầu tiên bắn `pointerdown` TRỰC TIẾP vào phần tử preview nên bỏ qua khâu
    HIT-TEST và báo "chạy tốt". Phải hỏi `document.elementFromPoint(x,y)` xem cú bấm THỰC SỰ
    trúng phần tử nào — cùng một bài học với "đo cả phần nối dây".
  - ỐNG HÚT CHỌN DẢI MÀU (subtab HSL) dùng lại đúng cơ chế này: `applyAdjustPick('hsl')`
    lấy màu nguồn -> `rgbToHsl` -> `bandWeights` -> chọn dải có trọng số lớn nhất rồi đổi ô
    màu đang xem. KHÔNG ghi dữ liệu gì. Dùng CHÍNH `bandWeights` của engine nên "dải nào" ở
    đây khớp tuyệt đối với dải mà shader/lut3d thực sự tác động — test chốt cả hai điều: 8
    màu mẫu ra đúng 8 dải, VÀ kéo dải chọn ra phải làm màu đó đổi mạnh hơn dải khác >3 lần
    (điều người dùng thực sự cảm nhận). Điểm gần xám (bão hoà < 0.04) bị từ chối kèm thông
    báo, vì ở đó sắc độ không có nghĩa.
    Subtab HSL có 2 nút đặt lại (làm 2026-07-29): "Đặt lại dải" (chỉ dải đang xem) và "Đặt lại
    tất cả" (cả 8 dải, tự mờ khi chưa có dải nào bị chỉnh) — cùng khuôn với "Đặt lại kênh" của
    Curves và "Đặt lại" của từng vòng tròn màu; đều đi qua `applyAdjust` nên undo/preview tự có.
  - MEDIA OVERLAY (làm 2026-07-29) — `pickOverlaySourceColor()`: phần tử overlay là DOM có
    CSS transform nên phải đảo ĐÚNG chuỗi `translate(-50%,-50%) translate(dx,dy) rotate(θ)
    scale(sx,sy)` (CSS áp từ trái sang phải = ngoài vào trong -> đảo là bỏ dịch tâm, quay −θ,
    chia scale). Các con số lấy từ `el.__srcMap` được ghi NGAY TẠI chỗ đặt phần tử trong
    `renderPreviewOverlays`, cùng lý do như `renderer.sourceMap` của lane chính.
    - Đọc pixel từ NGUỒN ẨN `previewsrc_<id>`, KHÔNG từ `preview_<id>`: khi item có chỉnh màu
      thì cái sau là canvas ĐÃ chỉnh, hút vào đó là cộng dồn temp/tint cũ vào phép giải.
    - `startAdjustPick` định tuyến theo đối tượng đang chỉnh — lấy màu lane chính rồi ghi vào
      overlay là sai vật.
    - Chỉ số pixel dùng **floor**, không round: pixel CHỨA toạ độ liên tục `sx` là `floor(sx)`.
      Round thì điểm rơi đúng tâm pixel bị đẩy sang pixel bên cạnh — probe đo được lệch đúng
      một bậc mã hoá (4/255) ở CẢ 6 tổ hợp biến đổi vì lý do này; sửa xong còn **0/255**. Đã
      sửa cả đường lane chính để hai bên lấy mẫu y như nhau.
    - Probe Electron (ảnh 64×64 mã hoá toạ độ vào màu, tự tính XUÔI rồi bắt hàm đảo NGƯỢC):
      sai số **0/255** ở thẳng / dịch / xoay 37° / co giãn 0.6 / lật X + xoay / lật Y + co
      giãn; bấm ra ngoài hộp trả `null` (không đoán bừa một màu).

- MẶT NẠ (subtab Mặt nạ) — `adjustments.mask`, 6 hình dùng chung với mặt nạ Video (xem
  "Mặt Nạ Cắt Hình"): Tách · Cuộn phim · Hình tròn · Hình chữ nhật · Ngôi sao · Tim.
  Ý nghĩa: giới hạn PHẠM VI của phần chỉnh màu (đúng như CapCut), KHÔNG cắt clip.
  - MỘT công thức cho cả 4 hình: mỗi hình chỉ khác cách tính KHOẢNG CÁCH CÓ DẤU (SDF, âm =
    trong), feather áp chung bằng smoothstep quanh d=0. Nhờ vậy `maskValueAt()` (JS, dùng để
    bake PNG cho export) và `MASK_MIX_SRC` (GLSL, preview) là một công thức chép sang hai
    ngôn ngữ — sửa một bên PHẢI sửa bên kia.
  - ĐƠN VỊ: hệ toạ độ lấy NỬA CHIỀU CAO khung làm 1 đơn vị, trục x nhân thêm tỉ lệ khung.
    Nhờ đó "Hình tròn" tròn thật trên khung 16:9 và mọi con số độc lập độ phân giải (test
    chốt: bake ở 80×45 và 320×180 cho cùng giá trị tại cùng toạ độ tỉ lệ, lệch ≤6/255).
  - `isBlank()` KHÁC `isIdentity()`: mặt nạ đã bật nhưng chưa chỉnh màu thì không đổi hình gì
    (isIdentity = true) nhưng VẪN PHẢI LƯU, nếu không `applyAdjust` xoá field và người dùng
    vừa dựng xong mặt nạ là mất trắng. `applyAdjust` dùng `isBlank` cho quyết định xoá.
  - Preview: mặt nạ là lượt shader CUỐI (`maskMix`), trộn kết quả đã chỉnh với ảnh NGUỒN
    (`textures.source` không bị các lượt trung gian ghi lên nên dùng lại được). Lượt này đọc
    FBO (không lật) lẫn texture nạp từ DOM (lật) nên dùng MỘT biến `nrm` cho cả việc lấy mẫu
    nguồn lẫn toạ độ mặt nạ, tránh lệch trục.
  - EXPORT (`AppendColorAdjustFilters` trong core_process.cpp) — tách dòng thành 2 nhánh,
    chỉnh màu một nhánh, gắn mặt nạ vào ALPHA rồi phủ lên nhánh gốc:
    `split → [filters],format=rgba,split → alphaextract → blend=multiply với mặt nạ →
     alphamerge → overlay=0:0`, kết thúc bằng `null` để đoạn sau của caller (bắt đầu bằng
    dấu phẩy) nối vào được.
    BA LỰA CHỌN ĐÃ CÂN NHẮC RỒI MỚI CHỌN, đừng đổi mà không đo lại:
    1. Nạp mặt nạ bằng `movie=` chứ KHÔNG thêm `-i`: thêm input thì phải đánh số lại toàn bộ
       `overlay.assetInputIndex` (đang cộng dồn trong `CommandExportVideo`) — rủi ro cao mà
       chẳng được gì. Đã kiểm `movie=...:loop=0,setpts=N/FRAME_RATE/TB`: mặt nạ giữ đúng suốt
       40 frame, không lệch PTS.
    2. KHÔNG dùng `geq` để sinh mặt nạ trong graph: biểu thức SDF (chữ nhật bo góc + xoay +
       feather) dài vài KB và geq đánh giá biểu thức TỪNG PIXEL -> chậm không dùng được.
    3. Nhân alpha bằng `blend=all_mode=multiply` chứ không `alphamerge` thẳng: overlay
       ảnh/video có thể ĐÃ có alpha riêng, alphamerge sẽ GHI ĐÈ và vùng vốn trong suốt bỗng
       đục trong phạm vi mặt nạ. Nhân thì nguồn đục (alpha=255) cho ra đúng mặt nạ, còn nguồn
       có alpha thì giữ nguyên phần trong suốt -> MỘT đường mã đúng cho cả hai.
  - Mặt nạ bake ra ảnh XÁM (luma = giá trị mặt nạ), KHÔNG phải PNG có alpha, vì `alphamerge`
    lấy alpha từ LUMA của ảnh thứ hai. Kích thước bake = ĐÚNG kích thước stream mà filter
    chạy trên đó (nguồn cho clip chính, kích thước gốc của asset cho overlay) vì
    `blend=multiply` đòi hai ảnh cùng kích thước — không có bước scale nào ở giữa.
    Backend `materializeColorMaskPng()` ghi ra `temp_uploads/color_masks/mask_<sha1>.png`.
    Ghi mặt nạ thất bại -> BỎ LUÔN cả phần chỉnh màu của block đó, vì áp toàn khung là sai ý
    người dùng, thà không chỉnh còn hơn xuất ra hình sai.
  - UI ẩn thông số không có nghĩa theo từng hình: "Tách" là nửa mặt phẳng (không kích
    thước/bo góc), "Cuộn phim" là dải ngang (chỉ có chiều cao), bo góc chỉ có ở chữ nhật.
  - Ô NHẬP RỘNG/CAO THEO PIXEL (làm 2026-07-29) — `maskPixelSize()` / `maskFrameSize()`.
    VÌ SAO: hai trục lấy mốc KHÁC nhau (chiều rộng thật = `width × W`, chiều cao thật =
    `height × H`), nên `width = height` KHÔNG có nghĩa là vuông/tròn — trên khung 9:16 thì
    0.6/0.6 ra một OVAL cao. Người dùng báo đúng: "thông số bằng nhau mà hình tròn lại thành
    oval". Hiện theo PIXEL thì hai số bằng nhau LÀ tròn thật (điều kiện tròn là
    `width×W == height×H`), và giống hệt cách CapCut hiện ("1080 x 1075").
    DỮ LIỆU VẪN LƯU THEO TỈ LỆ — quy đổi chỉ nằm ở cửa đọc/ghi của panel (một chỗ duy nhất),
    vì tỉ lệ mới là thứ làm preview và bản xuất khớp nhau ở mọi độ phân giải.
    KHUNG QUY ĐỔI là stream mà filter chạy trên đó, KHÔNG phải khung sequence: nguồn cho clip
    lane chính (`source_width/height`), kích thước gốc của asset cho overlay. Lấy khung sequence
    thì con số bị HOÁN ĐỔI khi nguồn ngang mà sequence dọc.
    Test chốt cả hai điều bằng CHÍNH bake mặt nạ: rect 0.6×0.6 trên lưới 480×270 cho đúng
    288×162 (dung sai 1 pixel vì biên `d <= 0` là BAO GỒM và bake lấy mẫu ở tâm pixel), và
    "cùng số pixel thì tròn thật" trên cả 3 khung 480×270 / 270×480 / 400×400.
    "Tách" không có kích thước (nửa mặt phẳng), "Cuộn phim" chỉ có chiều cao.
  - `applyToImage` (tham chiếu JS) PHẢI giữ ảnh gốc TỪ ĐẦU rồi trộn ở cuối, giống lượt
    `maskMix`. Bỏ sót bước này thì tham chiếu thành "chỉnh toàn khung" và phép đo báo lệch
    167/255 — đã mắc, và đó là lệch của PHÉP ĐO chứ không phải của shader.
  - Probe Electron (GPU thật, so với `applyToImage`): chữ nhật max 0.5 · tròn có feather
    max 0.9 · Tách xoay 90° max 0.5 · ĐẢO + làm nét max 1.5 (đều /255).
  - TAY CẦM TRÊN PREVIEW (làm 2026-07-29) — `renderMaskOverlay` trong editing-runtime.js:
    đường viền vùng mặt nạ + tay cầm DI CHUYỂN (tâm) / ĐỔI KÍCH THƯỚC (4 góc, hoặc 2 mép
    trên-dưới với "Cuộn phim") / XOAY. "Tách" không có tay cầm kích thước (nửa mặt phẳng).
    Kéo ghi thẳng vào `adjustments.mask` qua `applyAdjust`, nên undo/.crab/export tự có.
    - MẶT NẠ NẰM TRONG KHÔNG GIAN NGUỒN (nó nhân vào ảnh TRƯỚC mọi biến đổi hình học), nên
      tay cầm phải vẽ trong đúng hình chữ nhật mà NGUỒN đang chiếm trên preview. Vì thế mọi
      toạ độ đi qua "khung nguồn" `maskSourceFrame` = `{cx, cy, ex, ey}` với ex/ey là ảnh
      màn hình của MỘT đơn vị u/v. Dùng VECTOR chứ không (góc + tỉ lệ) để đỡ luôn cả LẬT và
      co giãn không đều (hoạt ảnh In/Out có scaleX ≠ scaleY): khi đó mặt nạ đã xoay bị xiên,
      và sprite thật cũng xiên đúng như vậy.
    - Lane chính lấy khung nguồn TỪ `renderer.sourceMap` (qua `window.getPreviewSourceMap`),
      không tự dựng lại — cùng lý do như ống hút màu. Overlay thì hộp W×H của item CHÍNH LÀ
      khung nguồn (nguồn được vẽ trọn vào hộp đó).
    - Toán hình học (`maskOutlinePolys` / `maskRotateCw` / `maskPointToScreen` /
      `maskScreenDeltaToUv`) đặt trong `color-adjust.js` NGAY CẠNH `maskValueAt`: đường viền
      phải là đúng tập d = 0 của cùng một SDF. Để hai file thì sớm muộn viền lệch khỏi vùng
      thật — test `testMaskOutlineGeometry` chốt lại bằng cách lấy 2 điểm lệch ±0.02 theo
      pháp tuyến ở mỗi điểm viền: bên trong phải =1, bên ngoài phải =0 (feather=0).
    - BA BẪY ĐÃ XỬ LÝ:
      1. `pointerdown` phải chặn ở pha CAPTURE (cùng bẫy với `startAdjustPick`), nếu không cú
         kéo rơi xuống overlay item và thành chọn/kéo block.
      2. `mousedown` là sự kiện RIÊNG, stopPropagation của pointerdown KHÔNG chặn nó — mà
         `#sequencePreviewShell` có handler "mousedown ngoài khung -> BỎ CHỌN block", còn tay
         cầm lại là con của shell. Không chặn thêm `mousedown` thì vừa bấm tay cầm là mất
         block đang chọn (khung chọn tránh bẫy này bằng `stopSelectionBoxEvent`).
      3. `pointermove`/`pointerup` nghe ở WINDOW, KHÔNG `setPointerCapture`: mỗi lần vẽ lại
         preview là tay cầm được dựng lại (giống renderSelectionBox), bám vào phần tử thì cú
         kéo đứt giữa đường. `maskDrag` giữ khung nguồn của thời điểm BẮT ĐẦU kéo nên hình
         học không nhảy trong lúc kéo.
    - Ô số chạy theo tay bằng cách ghi TRỰC TIẾP 2 input của đúng field (không dựng lại cả
      panel giữa lúc kéo — mất focus và giật); `refreshAdjustPanel()` chỉ gọi khi nhả tay.
    - Chuyển tab/subtab Inspector không đi qua đường render preview, nên có listener riêng
      vẽ lại ở frame sau: vào subtab "Mặt nạ" là thấy tay cầm ngay, rời đi là mất ngay.
    - CHƯA CÓ: kéo cả vùng bằng cách bấm vào bên trong hình (hiện dùng tay cầm tâm), tay cầm
      cho feather, và các loại Văn bản / Cọ / Bút của CapCut (đã chốt để giai đoạn sau).

- KEYFRAME THÔNG SỐ MÀU — hiện có cho **22 thông số**, chia theo SÁU cơ chế xuất, mỗi cơ chế
  do một ràng buộc của FFmpeg chứ không phải lựa chọn tuỳ ý (`KEYFRAME_PARAMS[].via`):
    * `eq`      — Phơi sáng / Tương phản / Bão hoà. `eq` là filter màu DUY NHẤT nhận biểu thức.
    * `sendcmd` — Nhiệt độ màu / Tông màu / 3×3 Vòng tròn màu. `colorbalance` có cờ `T`, giá
                  trị lệnh là MỘT SỐ.
    * `curves`  — nhóm Độ sáng (5 thông số). Cũng `sendcmd`, nhưng giá trị lệnh là cả CHUỖI
                  ĐIỂM ĐIỀU KHIỂN. Xem "NHÓM ĐỘ SÁNG CÓ KEYFRAME" dưới.
    * `lutmix`  — Cường độ LUT. `lut3d` không có tham số trộn và không đổi file được lúc
                  chạy -> phải tách 2 nhánh rồi `blend`. Xem "CƯỜNG ĐỘ LUT CÓ KEYFRAME".
    * `blur`    — "Làm mờ". `avgblur` có cờ `T` ở sizeX/sizeY/**planes** -> sendcmd.
    * `vignette`— "Viền mờ dần". `angle` là BIỂU THỨC và có `eval=frame` -> animate trực tiếp.
  Còn KHOÁ (kèm tooltip): Đường cong 4 kênh của người dùng, 8 dải HSL, việc ĐỔI LUT, hình dạng
  Mặt nạ, và **3 thông số Hiệu ứng còn lại** (Làm sắc nét / Độ rõ nét / Hạt nhỏ).

- NHÓM HIỆU ỨNG CÓ KEYFRAME (làm 2026-07-29) — chỉ **2/5** thông số, và đó là ràng buộc của
  FFmpeg. Đã đo cờ runtime bằng `ffmpeg -h filter=<tên>` (cột cờ có chữ `T` = đổi được lúc chạy):
    avgblur sizeX/sizeY/planes  CÓ `T`             -> ĐƯỢC (sendcmd)
    vignette angle              biểu thức + eval=frame -> ĐƯỢC (biểu thức theo `t`)
    unsharp la (nét + rõ nét)   không cờ, không biểu thức -> KHÔNG
    noise alls (hạt nhỏ)        không cờ, không biểu thức -> KHÔNG
  - "LÀM MỜ": instance phải CÓ TÊN (`avgblur@blur_<nhãn>0..2`, mỗi lượt xếp tầng một tên) và
    phải phát kể cả khi bán kính tĩnh = 0 (`forceBlur`).
    MỐC 0 DÙNG `planes=0`, KHÔNG hạ `sizeX` về 1. Đã đo: `planes=0` là identity TUYỆT ĐỐI
    (max 0/255) trong khi `sizeX=1` — giá trị nhỏ nhất hợp lệ — vẫn là hộp 3 tap và lệch tới
    **201/255**. Đây là mẹo quan trọng nhất của mục này.
    Bán kính là SỐ NGUYÊN pixel khai theo tỉ lệ chiều cao, nên `sendcmdText` cần `frameHeight`;
    lọc mốc trùng theo (bán kính, planes) nên file lệnh rất gọn (bán kính chỉ nhảy vài bậc).
    LƯU Ý: `effectsSpec` kẹp bán kính tối thiểu = 1, nên CHỈ đúng giá trị 0 mới là identity —
    từ 0 lên 1 là một bước nhảy nhỏ, CÓ TỪ TRƯỚC, và preview khớp y hệt vì dùng chung effectsSpec.
  - "VIỀN MỜ DẦN": phát HAI instance `vignette` (mode=forward + mode=backward), mỗi cái nhận
    phần dương/phần âm của biểu thức (`max(0,(v))` và `max(0,-(v))`). Lý do: `mode` KHÔNG đổi
    được lúc chạy mà slider đi qua 0 là đổi chiều. Đã đo: `angle=0` là identity tuyệt đối ở cả
    hai chiều, kể cả khi nối tiếp nhau -> chiều không dùng tự vô hiệu. `eval=frame` BẮT BUỘC.
  - Biểu thức nằm NGAY TRONG chuỗi filter tĩnh (không qua field riêng như `eq`), nên
    `ColorAdjustChain` ở sidecar giờ chạy `SubstituteLocalTime` lên CẢ chuỗi tĩnh. Token
    `LOCALT` chỉ xuất hiện ở đúng các biểu thức đó nên thay ở đây là an toàn, và mọi filter
    nhận biểu thức về sau tự dùng được mà không phải thêm field mới.
  - PREVIEW không phải sửa gì: `effectiveAdjustments` nội suy `effects.*`, còn khoá cache của
    `draw()` vốn dựng TỪ `adj.effects` nên tự hoạch định lại lượt shader. Probe Electron ở
    1920×1080: **0.082 ms/frame** khi mờ đổi MỖI FRAME so với 0.087 ms/frame khi đứng im
    (7 lượt shader) — phần hoạch định lại không đáng kể.
  - KIỂM CHỨNG end-to-end qua sidecar (`testEffectsKeyframeSidecar`): độ gắt ảnh đi
    1.66 → 0.92 → 0.85 khi mờ tăng (mốc t=0 khớp CHÍNH đường xuất không filter = identity), và
    góc-trừ-tâm của vignette đi **+7 → −76 → −118** tức viền chạy từ SÁNG sang TỐI, chứng minh
    cả hai instance đều hoạt động.
    BẪY KHI ĐO (đã mắc 2 lần): (1) `testsrc2` là hoạ tiết ĐỘNG nên độ gắt tự đổi theo frame —
    phải bốc một frame ra PNG rồi loop; (2) khung thử 120px chiều cao cho bán kính tối đa chỉ
    ~1.4px nên "mờ" không đo được gì — phải dùng khung ≥480px.

- NHÓM ĐỘ SÁNG CÓ KEYFRAME (làm 2026-07-29) — `via: 'curves'`, đi CÙNG file lệnh `sendcmd`
  với colorbalance nhưng trỏ vào instance riêng `curves@tone_<nhãn>`.
  - ĐÃ ĐO TRƯỚC KHI VIẾT (tài liệu cũ lo rằng file lệnh sẽ phình — SAI): `sendcmd` đổi được
    `curves` lúc chạy, chuỗi điểm bọc trong NHÁY ĐƠN (`curves@tc all '0/0 0.5/0.8 1/1';` làm
    xám 128 → 204 đúng mốc). Clip 20s ở 30fps keyframe SUỐT clip = 600 mốc × 17 điểm =
    **157KB** và ffmpeg chạy **0.25s so với 0.22s** khi đặt tĩnh. Vì rẻ như vậy nên KHÔNG
    giảm mật độ mốc: mỗi frame một mốc, y như colorbalance, preview và bản xuất khớp từng frame.
  - MỘT lệnh mỗi mốc (không phải 9 như colorbalance) vì cả đường cong nằm trong một chuỗi.
    Mốc mà tone = identity phải gửi ĐƯỜNG CHÉO chứ không được bỏ lệnh — bỏ thì filter giữ
    nguyên đường cong của mốc trước.
  - `forceTone` + `toneLabel`: cùng cái bẫy của `forceColorbalance` — tone tĩnh đang identity
    thì `curves` không được phát, và lệnh chẳng có filter nào để tới.
  - Backend `materializeColorSendcmd` phải cho thêm `'` và `/` vào whitelist ký tự (chuỗi
    điểm cần chúng). Vẫn KHÔNG cho `[ ] \ "`.
  - Ô nhập nhóm Độ sáng chuyển sang `applyAdjustParam` (auto-keyframe) — ghi base khi field
    đang có keyframe là xoá mất đường nội suy.

- CƯỜNG ĐỘ LUT CÓ KEYFRAME (làm 2026-07-29) — `via: 'lutmix'`. `lut3d` KHÔNG có tham số trộn
  và `lut3d(file)` không đổi được file lúc chạy, nên đường DUY NHẤT là tách dòng thành 2 nhánh:
  ```
  <nửa trước>,split[la][lb];
  [la]lut3d=file=<cube A: chỉ HSL>[la2];
  [lb]lut3d=file=<cube B: HSL + LUT hết mức>[lb2];
  [la2][lb2]blend=all_expr='A*(1-M)+B*M'[lm];
  [lm]null,<nửa sau>
  ```
  - PREVIEW KHÔNG PHẢI ĐỔI SHADER: cube hiệu dụng = TRỘN TUYẾN TÍNH hai cube thành phần tại
    từng mắt lưới. Hợp lệ vì nội suy trilinear là phép tuyến tính, nên
    `interp(mix(A,B,i)) = mix(interp(A), interp(B), i)` — tức bản trộn ở preview và cách
    export (nội suy từng nhánh rồi trộn từng pixel) là CÙNG MỘT phép. Đo trên FFmpeg thật ở
    mix 0 / 0.35 / 0.7 / 1: lệch **0 / 1 / 2 / 1 trên 255** (mỗi nhánh lut3d làm tròn 8-bit
    trước khi blend, preview trộn ở float rồi mới làm tròn một lần).
  - VÌ SAO PHẢI TRỘN chứ không bake lại: chữ ký cache có chứa intensity, nên cường độ chạy
    theo keyframe = mỗi frame một chữ ký mới. Probe Electron trong ứng dụng thật: bake lại
    **12.64 ms/frame** (rớt frame) so với trộn **0.727 ms/frame** — nhanh 17×, và sai số 0.
    Chữ ký của 2 cube thành phần KHÔNG chứa intensity nên chúng nằm mãi trong cache.
  - `blend`: biến thời gian là **T (chữ HOA)**, không phải `t` như eq/rotate/overlay — sidecar
    dùng `SubstituteLocalTimeVar(expr, start, "T")`. Trong FILTER SCRIPT, dấu phẩy trong biểu
    thức KHÔNG cần escape miễn là bọc trong nháy đơn (đã kiểm bằng file script thật). Biểu
    thức pha phải tự KẸP `clip(...,0,1)`: easing có thể vượt biên mà `blend` không tự kẹp.
  - `blend` mặc định `shortest=false` (chờ input dài nhất) nhưng ở đây hai nhánh cùng sinh từ
    `split` nên bằng nhau — không có nguy cơ treo như khi ghép với `movie=...:loop=0`.
  - BẪY ĐÃ MẮC: `needsLut3d()` xét GIÁ TRỊ TĨNH, mà cường độ tĩnh rất thường là 0 (người dùng
    cho nó chạy từ 0 lên). Thiếu vế `|| !!blendCubes` thì chuỗi filter không có chỗ trống LUT,
    backend không biết tách ở đâu, và cả phần LUT im lặng biến mất khỏi bản xuất.

- VỊ TRÍ CHÈN `lut3d` (sửa 2026-07-29 — LỖI CÓ SẴN): backend NỐI `lut3d` vào CUỐI chuỗi filter,
  nên nó chạy SAU nhóm hiệu ứng không gian, trong khi preview áp TRƯỚC. Đo bằng ffmpeg thật
  (LUT đẩy đỏ + vignette): lệch **max 88/255, p95 57** — gấp 5 lần ngưỡng TOLERANCE của cả
  panel, và không test nào bắt được vì không ca nào ghép HSL/LUT với hiệu ứng qua đường backend.
  Nay `ffmpegFilters(..., {lutSlot:true})` đặt TOKEN `__LUT3D__` đúng chỗ và backend chỉ thay
  vào (hoặc xoá sạch cả dấu phẩy nếu bake cube lỗi) -> thứ tự chỉ còn nằm ở MỘT nơi.
  - LƯU TRỮ: dùng lại CHÍNH `obj.keyframes` sẵn có, khoá tiền tố `adj.` (ví dụ
    `adj.basic.exposure`). Kho đó là map `{field: [{t,v,e}]}` với khoá là chuỗi TUỲ Ý, và
    `TextAnimations.hasKeyframes()` chỉ xét `KEYFRAME_FIELDS` (transform) nên khoá màu không
    gây nhiễu. Undo/redo và .crab vì thế TỰ CÓ, không viết thêm dòng nào.
    `objectKeyframes` / `jumpKeyframeForSelected` / `syncKeyframeDiamonds` cũng generic theo
    tên field nên dùng được ngay — chỉ nút hình thoi cần định tuyến khoá `adj.*` sang
    `toggleAdjustKeyframe()`.
  - VÌ SAO CHỈ 3 THÔNG SỐ: đây là RÀNG BUỘC CỦA FFMPEG, không phải lựa chọn tuỳ ý. Đã đo:
    * `eq` là filter màu DUY NHẤT nhận BIỂU THỨC theo thời gian (`brightness='t*0.2'` +
      `eval=frame` cho Y ramp 147->246). `eval=frame` là BẮT BUỘC — thiếu thì biểu thức chỉ
      tính một lần lúc khởi tạo và thông số đứng im cả clip.
    * `colorbalance` có cờ `T` -> điều khiển bằng `sendcmd`. ĐÃ LÀM (xem dưới).
    * `curves` cũng có cờ `T` và giá trị lệnh là CHUỖI ĐIỂM ĐIỀU KHIỂN. ĐÃ LÀM cho nhóm Độ
      sáng (2026-07-29); nỗi lo "file lệnh phình rất nhanh" ĐÃ ĐO LẠI và KHÔNG đúng: 600 mốc
      × 17 điểm chỉ 157KB, ffmpeg 0.25s vs 0.22s. Đường cong 4 kênh của người dùng thì vẫn
      chưa làm — không phải vì kích thước mà vì chưa có UI keyframe cho từng điểm.
    * `lut3d(file)` KHÔNG đổi được lúc chạy, nhưng Cường độ LUT vẫn keyframe được bằng cách
      tách 2 nhánh + `blend` (ĐÃ LÀM 2026-07-29). Trong nhóm Hiệu ứng thì `avgblur` (Làm mờ)
      và `vignette` (Viền mờ dần) KEYFRAME ĐƯỢC — xem "NHÓM HIỆU ỨNG CÓ KEYFRAME"; chỉ
      `unsharp` (nét, rõ nét) và `noise` (hạt) là không, vì vừa không có cờ `T` vừa không nhận
      biểu thức.
    Đường cong 4 kênh/Hiệu ứng/HSL/việc ĐỔI LUT/Mặt nạ hiện KHOÁ nút hình thoi kèm tooltip,
    chứ KHÔNG cho bấm rồi âm thầm không xuất ra được.
  - EXPORT qua `sendcmd` (Nhiệt độ / Tông màu / Vòng tròn màu): `sendcmdText()` sinh file
    lệnh, backend `materializeColorSendcmd()` ghi ra `temp_uploads/color_masks/cmd_<sha1>.txt`
    rồi nối `sendcmd=f='...'` vào ĐẦU chuỗi filter (phải đứng trước colorbalance; đặt đầu là
    an toàn nhất vì sendcmd chỉ cho frame đi qua và phát lệnh theo mốc).
    BA ĐIỂM BẮT BUỘC:
    1. Mỗi mốc phải gửi ĐỦ 9 tham số `rs..bh`: `colorbalanceParams()` TRỘN temperature/tint
       với 3 vòng tròn màu, nên chỉ cần MỘT trong 11 đầu vào có keyframe là cả 9 đầu ra biến
       thiên.
    2. `forceColorbalance` — thông số có keyframe mà giá trị TĨNH đang là 0 thì
       `colorbalanceIsIdentity` = true và filter không được phát; lúc đó sendcmd chẳng có
       instance nào để gửi lệnh tới và keyframe im lặng mất tác dụng.
    3. Instance phải CÓ TÊN (`colorbalance@cb_<label>`), tên do FRONTEND chọn và dùng chung
       cho cả filter lẫn file lệnh; label lấy theo block (`c<index>` / `i<item id>`) để duy
       nhất trong cả filtergraph. Backend whitelist vì thế phải cho phép ký tự `@`.
    LỌC MỐC TRÙNG: chỉ ghi lệnh khi giá trị thực sự đổi (làm tròn 4 chữ số). Keyframe thường
    chỉ chiếm một đoạn ngắn của clip — clip 20s ở 30fps với keyframe 0.5s ra 144 dòng thay vì
    5409 dòng.
    ĐÃ SỬA KHI LÀM: `eqKeyframeExprs` phải xét `hasAdjustKeyframes(kf, 'eq')` chứ không xét
    mọi keyframe — nếu không, chỉ keyframe Nhiệt độ cũng làm nó phát ra một filter `eq` với
    biểu thức HẰNG SỐ kèm `eval=frame`, vô ích và gây nhiễu khi đọc filtergraph.
  - KẾT QUẢ SPIKE `sendcmd`: `sendcmd` HOẠT ĐỘNG và trục
    thời gian của lệnh là **0-BASED sau `setpts=PTS-STARTPTS`** — đúng bằng thời gian cục bộ
    của keyframe, nên sinh file lệnh không phải quy đổi gì. Đã kiểm trong bối cảnh thật
    (`trim=1..3,setpts,fps=25,sendcmd=f=...,colorbalance@cb=rh=0`): V ramp 128->166 mượt qua
    50 frame. Cú pháp: `<giây> <filter>@<nhãn> <tham số> <giá trị>;` mỗi lệnh một dòng.
    BẪY KHI SPIKE (đã mắc): lần đo đầu dùng `rm` (midtones) trên nguồn xám 147 -> `l = 1.2`,
    ở đó TRỌNG SỐ MIDTONES BẰNG 0 nên `rm` không đổi gì KỂ CẢ khi đặt tĩnh, và tôi tưởng
    sendcmd không chạy. Luôn kèm một phép kiểm "đặt tĩnh có đổi không" để biết phép đo có
    nhạy hay không.
  - EXPORT: `eqKeyframeExprs()` sinh biểu thức GIỮ ĐÚNG công thức của `eqParams()`, chỉ thay
    số bằng biểu thức: `gain = pow(2, E/50)`, `contrast = c*gain`,
    `brightness = 0.5*c*(gain-1)`, `saturation = 1 + S/100`. Biểu thức mang token `LOCALT`
    (tái dùng `TextAnimations.keyframeFieldFfmpegExpr` nên EASING khớp preview), backend lọc
    ký tự bằng `sanitizeFfmpegExpr` sẵn có, sidecar `ColorAdjustEqFilter()` thay `LOCALT` =
    `t - start` (start = 0 cho clip lane chính đã setpts 0-based, `timeline_start` cho overlay).
  - HAI CHỖ DỄ SAI ĐÃ XỬ LÝ:
    1. `ffmpegFilters(..., {skipEq:true})` khi có keyframe — nếu không bỏ eq tĩnh thì có HAI
       filter eq nối nhau và ảnh bị chỉnh HAI LẦN.
    2. eq-keyframe phải ghép vào TRƯỚC chuỗi tĩnh rồi mới đưa cả khối vào bộ bọc mặt nạ
       (`ColorAdjustChain`) — ghi thẳng ra script thì eq nằm NGOÀI mặt nạ và phần keyframe
       áp toàn khung.
    3. `colorAdjustExportSpec` KHÔNG được bỏ qua theo `isIdentity` khi có keyframe: giá trị
       tĩnh có thể đang là 0 trong khi keyframe vẫn kéo nó chạy suốt clip.
  - PANEL BÁM PLAYHEAD — `syncAdjustPanelValues()`, gọi từ `renderPreviewOverlays` (cùng chỗ
    mà `syncInspectorControls` của bảng transform đang dùng, nên phủ MỌI đường di chuyển
    playhead: phát 60fps, kéo, tua, nhảy keyframe).
    LỖI ĐÃ MẮC (sửa 2026-07-30, người dùng báo): panel chỉ được dựng lại khi CHỌN đối tượng
    hoặc khi SỬA giá trị, nên kéo playhead qua các keyframe thì preview đổi đúng mà ô số đứng
    im ở giá trị của lần dựng cuối — keyframe Nhiệt độ 0 → 80 thì về mốc 0 vẫn hiện 80.
    `currentAdjustments()` vốn đã trả giá trị hiệu dụng; thiếu là khâu ĐẨY nó ra DOM.
    - KHÔNG dựng lại HTML mỗi frame (mất focus khi đang gõ + tốn): chỉ ghi `input.value` khi
      giá trị THẬT SỰ khác, và BỎ QUA ô đang được focus.
    - Vòng tròn màu phải `redrawAdjustWheels()` vì tay cầm vẽ TỪ giá trị; chỉ vẽ khi subtab đó
      đang hiện. Mặt nạ KHÔNG đồng bộ ở đây (không keyframe được, và ô Rộng/Cao theo pixel có
      đường quy đổi riêng).
    - Chi phí đo được: `renderPreviewOverlays` **0.410 ms/frame** kể cả phần đồng bộ panel.
    - KIỂM CHỨNG: probe dựng đúng cảnh người dùng báo rồi ĐỌC Ô SỐ trong DOM (không đọc dữ
      liệu): playhead 2s → "80", 0s → "0", 1s → "40", 0s → "0". Đối chứng độ nhạy bằng cách
      tắt lời gọi: panel kẹt ở "80" ở cả 4 mốc, tức tái hiện đúng lỗi.
  - PREVIEW: `currentAdjustments()` và mọi đường vẽ dùng `effectiveAdjustments(obj, t)` nên
    bảng số và hình đều bám playhead. Ghi dữ liệu đi qua `applyAdjustParam()`: field đã có
    keyframe -> ghi KEYFRAME tại playhead (auto-keyframe, cùng lối bảng transform đang dùng)
    chứ không ghi base, nếu không đường nội suy bị xoá mất.
    LỖI ĐÃ MẮC Ở BẢN ĐẦU (sửa 2026-07-29) — "render đúng nhưng PREVIEW ĐỨNG IM": toán và
    đường xuất đều đúng, nhưng các đường VẼ truyền `obj.adjustments` (giá trị BASE) vào bộ
    chỉnh màu nên preview không bao giờ thấy giá trị nội suy. Đã sửa ĐỦ 5 đường, tất cả đều
    lấy `effectiveAdjustments(obj, localTime)` — MỘT hàm dùng chung, đã xuất qua
    `EditingRuntime.effectiveAdjustments` cho index.html:
      1. Sprite lane chính (`resizeAndRender`, index.html) — cả đường PIXI.Filter lẫn đường
         nhiều lượt; mốc thời gian dùng CHUNG với keyframe transform (`currentTime − start`).
      2. `drawMainClipLayer` (composite chuyển cảnh lane chính) — dùng `localT` có sẵn.
      3. `captureCompositeFrame` (chụp khung hình) — lane chính; overlay đã đúng vì nó đọc
         phần tử `preview_<id>` (canvas fx) đã chỉnh theo playhead.
      4. `prepareExportLayer` (bake chuyển cảnh) — khung seam: mốc = cuối item cho nhánh A,
         đầu item cho nhánh B.
      5. `renderImageAnimationSequence` — xem gạch đầu dòng dưới.
    Vì sao dễ lọt: các phép đo cũ đều gọi `ColorAdjust.effectiveAdjustments` rồi mới dựng
    uniform, tức đo ĐÚNG phần toán và bỏ qua phần NỐI DÂY. Test nay chốt cả cấu trúc
    (`testPreviewFollowsPlayhead`): không đường vẽ nào được truyền `.adjustments` thô vào
    `colorAdjustedDrawable`.
  - ẢNH CÓ HOẠT ẢNH + KEYFRAME MÀU: item này xuất bằng CHUỖI PNG (không đi qua chuỗi filter
    của sidecar), nên màu phải tính lại TỪNG FRAME. `renderAnimationSequence` nhận
    `options.perFrame` (bỏ phép rasterize-1-lần vào offscreen) và `options.contentSigAt(t)`
    (chữ ký NỘI DUNG tại mốc đó). Phép gộp frame vùng hold vẫn chạy nhưng xét CẢ HAI: chỉ đẩy
    `null` khi transform tĩnh VÀ chữ ký màu không đổi.
    - Gộp theo transform không thôi -> màu bị đóng băng ở frame đầu của đoạn hold.
    - Bỏ gộp cả span -> payload phình vô ích ở đoạn trước keyframe đầu và sau keyframe cuối,
      mà đó thường là phần lớn clip. Chữ ký nội dung giải quyết cả hai.
  - `itemHasColorAdjust` trả true cho CẢ item khi có keyframe màu, KHÔNG xét identity theo
    từng thời điểm: quyết định này đổi LOẠI THẺ của phần tử preview (canvas ⇄ video/img) và
    `renderPreviewOverlays` dựng lại thẻ mỗi lần nó đổi. Keyframe đầu thường bằng 0 (identity)
    nên nếu xét theo thời điểm thì thẻ `<video>` bị dựng lại giữa lúc phát -> mất frame, mất
    tiếng.
  - HIỆU NĂNG khi thông số đổi MỖI FRAME: `CanvasColorRenderer.setAdjustments` giờ cache
    theo chữ ký RIÊNG của từng texture (bảng curve; cube 33³ ≈ 144KB) — thông số có keyframe
    không nằm trong hai chữ ký đó nên không nạp lại gì, chỉ bind lại. Cũng đã bỏ dòng
    `this.spatialKey = ''`: khoá cache của `draw()` vốn dựng TỪ `adj.effects`/`adj.mask` nên
    tự phát hiện thay đổi, xoá tay thì mỗi frame lại hoạch định lượt + cấp phát hạt nhân.
    `ClipColorAdjustFilter` (đường PIXI) đã cache sẵn theo cách này từ đầu.
  - Marker keyframe trên block và mốc snap của playhead đã gộp cả khoá `adj.*`.
  - KIỂM CHỨNG: test chốt biểu thức tại t khớp `eqParams(giá trị nội suy)` ở 5 mốc (lệch
    <1e-4, dùng bộ đánh giá biểu thức FFmpeg viết trong test), giữ mép ngoài khoảng, keyframe
    transform không bị tính lẫn, `skipEq` thật sự bỏ eq, phân loại `via` đúng (temperature
    KHÔNG sinh biểu thức eq, exposure KHÔNG đi đường sendcmd), giá trị trong file lệnh khớp
    `colorbalanceParams(giá trị nội suy)` tại đúng mốc, và lọc mốc trùng có tác dụng.
    End-to-end `sendcmd` qua sidecar: Nhiệt độ chạy từ lạnh sang ấm, hiệu (đỏ − lam) đo được
    `−87 → −39 → +10 → +55 → +86` — tăng dần và ĐỔI DẤU, chứng minh lệnh tới được FFmpeg và
    trỏ đúng instance. End-to-end `eq` qua sidecar: độ sáng
    tăng dần `96 → 115 → 138 → 166 → 187` theo thời gian — đây là điều DUY NHẤT chứng minh
    biểu thức được đánh giá TỪNG FRAME. Test còn chốt mẫu cuối KHÔNG kẹp trần 255: bản đầu
    kéo exposure tới 80 làm 2 mẫu cuối là 253/255 và phép đo "tăng dần" mất tác dụng đúng chỗ
    cần đo. Probe Electron: `uEqContrast` tại t=2 = 2.2974 = 2^1.2, khớp giá trị nội suy 60.

- VÌ SAO HSL PHẢI ĐI QUA lut3d: FFmpeg KHÔNG có filter HSL theo 8 dải (hue/selectivecolor
  đều không tương đương). HSL và LUT đều là hàm thuần RGB->RGB nên GỘP ĐƯỢC vào MỘT .cube:
  frontend bake (33³), gửi nội dung cube trong payload, backend ghi ra
  temp_uploads/color_luts/bake_<sha1>.cube rồi tự nối `lut3d=file=...:interp=trilinear`.
  Tên file theo sha1 nội dung -> nhiều block cùng thông số dùng chung 1 file.
  interp=trilinear (không để mặc định tetrahedral) để KHỚP phép nội suy của shader.

- CÔNG THỨC CHÉP THEO MÃ NGUỒN FFMPEG, đã đo thực nghiệm — đừng "sửa cho đẹp":
  - `eq` chạy trên YUV (brightness/contrast lên plane Y, saturation lên U/V) nên shader
    PHẢI đổi RGB -> YUV (BT.709 dải hẹp) rồi mới áp; áp thẳng trên RGB là lệch ngay.
  - `colorbalance` nhận l = max(r,g,b) + min(r,g,b) (thang 0..2), KHÔNG phải lightness
    (max+min)/2. Dùng /2 thì 3 dải rộng gấp đôi và lệch tâm: đo được tới 36/255 khi kéo
    vòng tròn màu. Đây là lỗi đã mắc và đã sửa — xem cbLightness().
  - `curves`: tham số `all` KHÔNG nhân chồng lên r/g/b, nó chỉ là curve MẶC ĐỊNH cho kênh
    không khai báo riêng. Người dùng thì hiểu kiểu Photoshop (kênh riêng xong mới tới RGB
    tổng) -> phải phát ra HAI filter `curves` nối tiếp. Đo: đầu vào xám 128, all 0.5->0.7 và
    r 0.5->0.3, gộp 1 filter cho r=77, nối 2 filter cho r=117 (đúng cái preview vẽ).
  - Spline của curves là natural cubic spline (chép interpolate() của vf_curves.c) -> cùng
    điểm điều khiển thì preview và FFmpeg dựng ra cùng một đường.
  - ĐÃ THỬ VÀ BỎ: ép `format=gbrp10le` trước nhóm filter RGB cho đỡ làm tròn — swscale thêm
    dither khi hạ lại 8-bit ở cuối nên KÉM HƠN 8-bit thẳng. Đừng làm lại.

- VỊ TRÍ CHÈN Ở SIDECAR (core_process.cpp, AppendColorAdjustFilters): ngay sau trim/fps và
  TRƯỚC `format=rgba`, cho cả clip lane chính (WriteClipVideoFilters) lẫn overlay
  (WriteVisualOverlayFilter). Lý do: `eq` chỉ nhận YUV, đặt sau format=rgba thì FFmpeg chèn
  rgba->yuv->rgba quanh nó và VÒNG ĐÓ LÀM MẤT ALPHA mà rotate/opacity phía sau đang cần
  (clip xoay sẽ lộ nền đen 4 góc). Ngoài ra chỉnh màu là thao tác trên NGUỒN, phải xong
  trước biến đổi hình học — đúng thứ tự preview (shader trên texture, rồi mới transform sprite).

- PREVIEW:
  - Lane chính: PIXI.Filter bọc ColorAdjust.FRAGMENT_SRC, gắn vào sprite trong
    SequencePixiPreviewRenderer.resizeAndRender (index.html, class ClipColorAdjustFilter).
    isIdentity -> sprite.filters = null: mỗi filter là một lượt render vào framebuffer phụ,
    gắn thừa là mất frame rate mà không được gì.
  - Media overlay: preview vốn là DOM <video>/<img>, không có đường gắn shader. Cách làm:
    khi item CÓ chỉnh màu thì phần tử hiển thị `preview_<id>` đổi thành <canvas> WebGL, còn
    media thật lui về nguồn ẩn `previewsrc_<id>` (class .editing-preview-src, đẩy ra ngoài
    khung nhìn chứ KHÔNG display:none — Chromium cần phần tử "được render" thì mới tiếp tục
    giải mã frame cho texImage2D). Vì `preview_<id>` là cái mà mọi nơi khác đọc để vẽ, đổi ở
    đúng chỗ này là chuyển cảnh / chụp khung hình / bake export đều nhận pixel ĐÃ chỉnh màu.
  - Các đường vẽ canvas 2D khác dùng colorAdjustedDrawable() (editing-runtime.js): composite
    chuyển cảnh LANE CHÍNH (lúc đó #mainTransitionCanvas phủ lên sprite Pixi nên không xử lý
    là màu "nhảy" về gốc đúng lúc chuyển cảnh), captureCompositeFrame (chụp khung hình), và
    prepareExportLayer (bake chuyển cảnh khi export). Pool tối đa 4 WebGL context.
  - Bake cube 33³ tốn ~16ms nên KHÔNG chạy mỗi frame: ColorAdjust.bakeCubeCached() cache theo
    chữ ký riêng của phần HSL+LUT (kéo slider Cơ bản không làm mất cache), giữ 24 bảng.

- EXPORT:
  - Frontend gói `color_adjust: {filters, cube}` cho từng block — clip chính gắn trong
    timelineForExport (index.html), overlay gắn trong exportPayload (editing-runtime.js).
    `filters` KHÔNG chứa lut3d: frontend không biết đường dẫn máy chủ và cũng không nên được
    quyền chỉ định file cho FFmpeg mở.
  - Backend normalizeColorAdjustFields(): whitelist ký tự chuỗi filter (bỏ ; [ ] \ " để không
    thể tách filter/label mà chèn filter lạ), ghi .cube, nối lut3d, xuất field PHẲNG
    `adj_filters`. PHẲNG chứ không lồng object vì bộ đọc JSON của sidecar C++ quét khoá theo
    chuỗi trong phạm vi object — một object con chứa khoá "start" sẽ phá việc đọc start/end.
  - KHÔNG áp cho item image_seq của chuyển cảnh: frame PNG đã được bake TỪ nguồn đã chỉnh màu,
    áp thêm là chỉnh HAI LẦN đúng đoạn chuyển cảnh. Tương tự, ảnh có animation_render bỏ
    color_adjust vì màu đã nằm trong chuỗi PNG (renderImageAnimationSequence).

- LUT: bộ dựng sẵn sinh bởi scripts/generate_preset_luts.js (6 preset: Teal & Orange, Phim ấm,
  Lạnh xanh, Hoài cổ, Đen trắng, Đậm nét), lưới 17³ (~130KB/file; preset là hàm trơn nên 17
  điểm/trục đủ) kèm library/luts/presets.json cho tên hiển thị có dấu. Người dùng nhập .cube
  qua POST /api/color-luts/import — backend validateCubeText() kiểm LUT_3D_SIZE và đủ size³
  dòng NGAY lúc nhập, không để lỗi lộ ra lúc render mất cả buổi. Danh mục: GET /api/color-luts.
  Nội dung .cube nạp LƯỜI ở frontend (chỉ khi được chọn); export chờ nạp xong bằng
  ensureLutLoadedAsync trước khi bake, nếu không video xuất sẽ âm thầm thiếu phần LUT.

- LƯU TRỮ: chỉ ghi field `adjustments` khi thật sự có chỉnh, kéo hết về mặc định thì XOÁ field
  -> dự án cũ không phình thêm dữ liệu. Undo/redo và .crab KHÔNG cần code riêng: cả hai đi qua
  deepClone (JSON) nên tự mang theo.

- KIỂM CHỨNG (tests/scripts/color_adjust_pipeline.js, npm run test:color-adjust — đã nằm trong
  npm test). Đo trên FFmpeg 8.1, đơn vị 1/255 trên kênh R/G/B ĐÃ HIỂN THỊ:
  - Phần toán thuần: normalize kẹp/vá dữ liệu rác, spline đi đúng điểm điều khiển, tổng trọng
    số 8 dải HSL luôn = 1, khứ hồi .cube, cube identity, LUT intensity 0% = không áp, xám
    tuyệt đối không bị HSL đụng, parseCube từ chối file hỏng.
  - Đối chiếu FFmpeg thật (nguồn YUV444 sinh TỪ RGB hợp lệ — bốc đại Y/U/V thì phần lớn nằm
    ngoài gamut và phép đo chỉ đang đo cái kẹp): từng bước đơn lẻ max 1.2-4.7, p95 ≤ 4.6;
    "cơ bản + curves" (3 filter) max 7.7 / p95 5.9; kéo cả 5 subtab cùng lúc (4 filter)
    max 13.8 / p95 8.3 / avg 4.25. Đây là SÀN của FFmpeg: mọi filter màu đều qua bảng tra
    8-bit (eq còn khuếch đại sai số theo contrast) trong khi preview tính float trên GPU.
    Ngưỡng test TOLERANCE=16 là để BẮT LỖI CÔNG THỨC — khi công thức colorbalance sai, số đo
    là 36-111/255, cao hơn hẳn nhiễu lượng tử.
  - End-to-end qua SIDECAR: dựng video màu phẳng (PHẢI có track audio, filter script luôn
    tham chiếu [0:a]), chạy core_process export-video, so pixel frame xuất với công thức
    preview -> lệch 5.8/255 (đã gồm một lượt encode h264).
  - Nhóm HIỆU ỨNG dùng phép đo RIÊNG (`testEffects`, `compareFxCase`): tham chiếu phải là
    `applyToImage` (cả ảnh) chứ không phải `applyToRgb` (từng pixel), vì các filter này đọc
    pixel lân cận. Ảnh thử là ô bàn cờ + dốc màu để có cả cạnh sắc lẫn vùng phẳng; bỏ 6
    pixel viền (FFmpeg và tham chiếu xử lý mép khác nhau). Đo được:
    sharpen 100 max 1.5 / p95 1.1 · clarity 100 max 0.6 · blur 100 max 6.1 / p95 4.9 ·
    vignette ±: max 4.4 / p95 3.1 · nét+rõ+viền max 5.0 · màu+hiệu ứng max 12.3 / p95 8.6.
    Test còn chốt: bán kính TỈ LỆ chiều cao khung, msize là số lẻ trong [3,23], thứ tự
    filter (nét trước mờ, viền cuối), KHÔNG được dùng `gblur`, phải ép `format=yuv444p`
    trước `unsharp`, và số filter `avgblur` bằng số lượt xếp tầng.
    LƯU Ý khi viết assertion: chuỗi `"avgblur"` CÓ CHỨA `"gblur"` — phải khớp theo biên tên
    filter, `includes('gblur')` sẽ báo động giả (đã mắc).
  - Probe Electron trên ứng dụng thật: PIXI.Filter biên dịch OK (uniform eq/curve/lut đúng,
    lutSize 33), identity -> filters null; 6 LUT dựng sẵn về đủ từ /api/color-luts; bake cube
    15.8ms lần đầu / 0.1ms khi trúng cache; CanvasColorRenderer khớp tham chiếu JS ≤1/255;
    0.002 ms/lần vẽ; tab "Điều chỉnh" + 5 subtab hiện và chuyển đúng section; không lỗi console.
```

### Tự Động Chỉnh Màu (Auto Color Grading)

```text
- MỤC TIÊU: đọc MỘT khung hình của block rồi TỰ ĐIỀN các thông số mà panel "Điều
  chỉnh" đã có. Đây là NỀN để người dùng chỉnh tiếp, không phải bản grade cuối.

- ENGINE RIÊNG: static/js/auto-grade.js (UMD -> window.AutoGrade), nạp SAU
  color-adjust.js (đọc window.ColorAdjust lúc khởi tạo). Module THUẦN, chạy được
  trong Node -> test không cần DOM.

- KHÔNG THÊM BƯỚC NÀO VÀO CHUỖI MÀU (quyết định thiết kế quan trọng nhất):
  kết quả ghi thẳng vào `adjustments` sẵn có, đúng cách ỐNG HÚT CÂN BẰNG TRẮNG đang
  làm. Nhờ vậy export / keyframe / undo / .crab / WYSIWYG đi theo đường ĐÃ ĐƯỢC TEST,
  auto grade không phát sinh gì để bảo trì. Hệ quả cố ý: người dùng đè tay lên kết
  quả auto được ngay, vì đó vẫn chỉ là mấy con số trong cùng những slider đó.

- NGHIỆM ĐÓNG CHO `eq` (không dò lặp). Thay eqParams vào công thức của vf_eq và rút
  gọn thì số hạng 0.5·c·g TRIỆT TIÊU, còn:
        yp2 = c·g·yp + 0.5·(1 − c)          (yp = 219/255·y + 16/255)
  Độ dốc theo y đúng bằng c·g -> ĐỘ TRẢI chỉ phụ thuộc tích c·g, TRUNG VỊ phụ thuộc
  cả c. Hai ràng buộc, hai ẩn, giải thẳng:
        M = c·g = trảiMongMuon / trảiĐoĐược
        c = 2·(M·yp50 + 0.5 − T·s − o)
        g = M / c        -> contrast = (c−1)·100, exposure = 50·log₂(g)
  BẪY ĐÃ CHẶN: kẹp contrast xong PHẢI giải LẠI g theo c đã kẹp, nếu không trung vị
  trượt khỏi đích đúng bằng phần bị kẹp. Test chốt riêng ca này.

- ĐIỂM ĐEN/TRẮNG không có nghiệm đóng (đường cong tone là spline ĐÃ KẸP [0,1]) ->
  CHIA ĐÔI trên CHÍNH `ColorAdjust.toneLut()`, tức dò trên đúng bảng mà preview và
  export dùng, không phải trên một mô hình xấp xỉ viết lại. 24 vòng là dưới một bậc
  lượng tử 8-bit.

- CÂN BẰNG TRẮNG dùng LẠI `ColorAdjust.solveWhiteBalance()`, không viết lại phép giải.
  - Mốc trung tính = GRAY-WORLD CÓ TRỌNG SỐ, không phải trung bình trần: trọng số
    `wNeutral = 1/(1+12·chroma²)` × `wTone = exp(−((y−0.5)/0.34)²)`. Trung bình trần
    thì một mảng màu lớn (áo đỏ, trời xanh) kéo mốc theo, và auto WB "sửa" bằng cách
    nhuộm ngược cả khung sang màu bù — hỏng hơn là không làm gì.
  - Mốc còn bão hoà > 0.34 thì TỪ CHỐI chỉnh WB (trả null). Cảnh đơn sắc thật (hoàng
    hôn, đèn sân khấu) rơi vào nhánh này — đúng ý đồ, vì ở đó "trắng" là lựa chọn
    sáng tạo chứ không phải lỗi máy. Test chốt cả điều này.
  - PHẢI gọi SAU khi đã ghi exposure/contrast/tone vào adj: solveWhiteBalance cho
    pixel chạy qua eq+tone TRƯỚC rồi mới giải, thứ tự sai là lệch màu.

- KHUNG ĐẦU BLOCK RẤT HAY VÔ DỤNG (fade-in đen, slate, khung phẳng). `isDegenerate`
  bắt các ca đó (dải p99−p01 < 0.045, hoặc không có mốc xám) và runtime NHÍCH TỚI
  theo AUTO_GRADE_RETRY_OFFSETS = [0, 0.5, 1.5, 3] giây — chỉ nhích khi mốc mới còn
  NẰM TRONG block, nếu không là phân tích nhầm sang cảnh của block sau. Hết mốc mà
  vẫn phẳng thì BỎ QUA block đó và nói rõ trong status, không đoán bừa.

- THU NHỎ KHUNG TRƯỚC KHI PHÂN TÍCH (AUTO_GRADE_ANALYSIS_WIDTH = 480): bộ giải chỉ
  cần phân vị + màu trung bình, hai đại lượng gần như không đổi theo độ phân giải.
  Vẽ 4K rồi getImageData tốn ~90ms và 33MB MỖI block; ở 480px là ~4ms.

- KHÔNG ĐỤNG: curves, wheels, hsl, effects, mask — người dùng dựng tay, auto grade
  không có cơ sở đoán. LUT chỉ bị ghi đè khi người dùng CHỌN phong cách. Test
  `testPatchPreservesManualWork` chốt bằng deepStrictEqual.

- PHONG CÁCH = CHÍNH danh mục LUT (`adjustLutCatalog()`: library/luts + .cube người
  dùng nhập), ghi vào `adj.lut`. Cố ý không dựng danh sách phong cách riêng: thêm một
  .cube là có ngay một phong cách, không phải sửa mã. Phải `ensureLutLoadedAsync`
  TRƯỚC khi ghi — `ensureLutLoaded` chỉ trả true/false rồi nạp ngầm, await nó vô nghĩa.

- BỘ PRESET (12, sinh bởi `scripts/generate_preset_luts.js`) chia 2 nhóm, nhóm TƯƠI
  SÁNG đặt TRƯỚC vì hợp nội dung tích cực/giáo dục — thứ tự presets.json = thứ tự ô
  chọn; đổi thứ tự an toàn vì mọi nơi tham chiếu theo `id`, không theo chỉ số.
    Tươi sáng · Nắng ấm · Rực rỡ · Pastel dịu · Xanh tươi · Trong trẻo
    Teal & Orange · Phim ấm · Lạnh xanh · Hoài cổ (fade) · Đen trắng · Đậm nét
  BA QUY TẮC của nhóm tươi sáng (đo được, đừng bỏ khi thêm preset mới):
  1. NÂNG SÁNG BẰNG GAMMA, không bằng phép nhân (`gammaUp`). Nhân thì vùng sáng đụng
     trần 1.0 và cháy — mà bảng trắng/áo trắng có mặt khắp video giáo dục.
  2. VIBRANCE, không phải saturation (`vibrance`): màu nhạt tăng nhiều, màu đã đậm
     tăng ít. Đẩy saturation đều tay thì da người (vốn bão hoà sẵn) đỏ rực.
  3. NHUỘM MÀU PHẢI TÔN TRỌNG TRẦN (`splitToneSoft`): lượng cộng nhân với headroom
     (1−v). Bản đầu dùng `splitTone` thường -> "Nắng ấm" làm kênh đỏ của trắng 0.93
     KẸP trần và đẩy bão hoà +12.6%, tức bảng trắng thành mảng cam bệt. Sau khi sửa:
     không kênh nào kẹp, bão hoà trên trắng còn +7.6%.
  `fresh_nature` đẩy lục theo TRỌNG SỐ `w = clamp01((g − max(r,b))·3)` nên bằng 0 khi
  đỏ trội -> da người chỉ lệch tỉ lệ kênh lục 0.6–1.4% (đẩy lục đều tay là mặt ngả
  xanh, lỗi kinh điển của look "thiên nhiên").

- SAI SỐ NỘI SUY LƯỚI 17³ (đo lệch pha 1/64 để rơi giữa ô): trung bình ≤0.08/255,
  đỉnh 2.8–4.8/255. Chú thích cũ trong generator ghi "<1/255" là SAI với CẢ bộ preset
  gốc (teal_orange 3.5, cool_blue 3.5) — đã sửa lại kèm số đo. Giữ 17³ vì preview và
  export đọc CÙNG file .cube nên sai số này không phá WYSIWYG.

- UI (subtab "Cơ bản"): nút "✨ Tự động chỉnh màu" + ô chọn phong cách (mặc định
  "Trung tính" = chỉ cân chỉnh). Ô phong cách giữ state Ở NGOÀI adjustments vì đó là
  lựa chọn của CÔNG CỤ, không phải thuộc tính của block -> không lọt vào .crab.
  Ô select phải có `data-adjust="1"`, nếu không sự kiện change KHÔNG tới
  `handleAdjustFieldInput` (hàm này gate theo đúng thuộc tính đó).

- MỘT recordHistory CHO CẢ LƯỢT: bấm một nút thì một lần Ctrl+Z phải trả lại nguyên
  trạng, kể cả khi đang chọn 8 block. Vòng lặp gọi `applyAdjust` với saveHistory mặc
  định (false) và tự `recordHistory()` MỘT lần ở đầu. Vì applyAdjust áp cho MỌI target
  đang chọn mà mỗi target lại có patch riêng, mutate phải tự lọc `if (t !== target) return`.

- KIỂU CHỈNH (`AutoGrade.STYLES`, **21 kiểu / 5 nhóm**: Cơ bản 5 · Tương phản 4 ·
  Nhiệt độ 6 · Sắc 4 · Bão hoà 2). UI gom bằng `<optgroup>`, thứ tự nhóm lấy theo thứ
  tự xuất hiện trong STYLES nên đổi bố cục menu = sửa mảng đó, không sửa chỗ dựng HTML.
  Mỗi kiểu đổi ĐÍCH của bộ giải (`targets`) và/hoặc thêm `bias` nhiệt độ/tông.
  TUYỆT ĐỐI không phải chọn LUT — đây là chỗ RẤT dễ bị gộp lại.
  - `bias` cộng SAU `solveWhiteBalance`: cân trắng cho ĐÚNG trước, rồi mới ngả ấm/lạnh
    có chủ đích. Cộng trước là bộ giải WB triệt tiêu mất ý đồ đó. Test đo trên nền ám
    lam: Trung tính ra temp 40, "Ấm" ra 55 — đúng bằng bias +15, tức nó cộng nguyên
    vẹn chứ không bị WB nuốt.
  - QUY ƯỚC DẤU (ĐO ĐƯỢC trên xám 128, ĐỪNG suy luận lại):
        temperature > 0 -> ĐỎ/ẤM      temperature < 0 -> LAM/LẠNH
        tint        > 0 -> LỤC        tint        < 0 -> MAGENTA (hồng/tím)
    Suy ra: vàng = ấm + tint DƯƠNG · hồng = ấm + tint ÂM · lục = tint DƯƠNG ·
    tím = lạnh + tint ÂM.
    LỖI THẬT ĐÃ XẢY RA (người dùng báo 2026-08-05): tôi hiểu NGƯỢC dấu tint nên CẢ 4
    kiểu nhóm "Sắc" ra sai màu — chọn "Ngả vàng" thì ảnh ngả tím, "Ngả tím" ra lục.
    Sai kiểu này KHÔNG lộ ra ở bất kỳ phép đo nào khác: giá trị vẫn hợp lệ, các kiểu
    vẫn khác nhau, vẫn không đụng LUT. Chỉ có đối chiếu TÊN với MÀU THẬT mới bắt được
    -> nay có `testHueDirection` khoá đúng 4 hướng + chốt "Lạnh" KHÔNG được ngả lục
    (lạnh + lục là màu bệnh hoạn trên da người).
  - KHUNG THỬ CỦA TEST PHẢI CÓ MÀU THẬT: bản đầu dùng dải xám (bão hoà ≈ 0) khiến
    `solveSaturation` của MỌI kiểu đụng trần +60 rồi trùng nhau — test đổ vì khung thử
    sai chứ không phải engine sai. Nay dùng `colorfulFrame()` và có assertion chốt
    "bão hoà chưa chạm trần" làm BỐI CẢNH của phép thử.
  - Test còn chốt các kiểu phải KHÁC NHAU và ĐÚNG CHIỀU (Ấm > Trung tính > Lạnh về
    nhiệt độ; "Sáng & dịu" phơi sáng cao hơn và tương phản thấp hơn "Đậm nét") —
    nếu không thì menu chỉ để trang trí.
  - Kiểu chỉnh KHÔNG cần nạp file gì (khác LUT), nên nhánh `ensureLutLoadedAsync`
    từng có trong `runAutoColorGrade` đã bỏ hẳn.

- BẪY ĐÃ MẮC (2026-08-04): khi gỡ ô phong cách LUT ra khỏi nút tự động, hàm
  `autoGradeStyleFor` bị xoá nhưng LỜI GỌI trong `runAutoColorGrade` còn lại ->
  ReferenceError ngay khi bấm nút, mà không test nào bắt được vì phần toán vẫn xanh.
  Bài học: gỡ một hàm thì grep CHÍNH TÊN HÀM, đừng chỉ grep tên biến quanh nó.

- HÀNG "ĐANG ÁP <tên LUT>" ở subtab Cơ bản dùng CHIP tự quản layout, KHÔNG bọc trong
  `.fig-field`: `.fig-field` là flex có border + padding sẵn nên nút bên trong bị kéo
  giãn gần hết chiều ngang còn tên LUT bị cắt cụt còn "Tươi s…" (bản đầu ra đúng vậy).
  Nút gỡ là icon "×" tròn 17×17, `flex: 0 0 auto` để không bao giờ giãn theo chip.
  Đo lại sau khi sửa: tên được 178px = 10.5× bề rộng nút, tên dài không bị cắt.

- ĐO ĐƯỢC (test tests/scripts/auto_color_grade.js + probe trình duyệt thật):
  * Đối chiếu THẲNG với `ColorAdjust.applyToRgb` (= công thức GLSL preview, đã được
    color_adjust_pipeline đối chiếu với FFmpeg): 4 ca sáng/tối/bệt/rộng đều đưa trung
    vị về 0.458-0.466 so với đích 0.46, độ trải sai < 0.06.
  * `statsAfterEq` (dự đoán nội bộ) lệch chuỗi thật < 0.02 — chốt rằng công thức (*)
    được chép đúng.
  * Auto WB: độ lệch 3 kênh của mốc xám 0.112 -> 0.002 (ám vàng), 0.105 -> 0.001
    (ám lam), 0.060 -> 0.000 (ám lục) — dưới một bậc 8-bit.
  * Probe trình duyệt thật (canvas -> getImageData -> analyzeFrame -> solve -> chuỗi
    màu): khung tối ám vàng p50 0.293 -> 0.429, lệch kênh mốc xám 0.1215 -> 0.0019,
    `ffmpegFilters` sinh ra chuỗi export hợp lệ.
```

### Bộ Lọc LUT (tab "LUT" ở panel TRÁI)

```text
- VÌ SAO CHUYỂN RA PANEL TRÁI (2026-08-04): chọn LUT là việc DUYỆT THƯ VIỆN — nhìn
  nhiều ô, so sánh, thử. Subtab LUT trong Inspector chỉ đủ chỗ cho MỘT ô select,
  không xem trước được gì. Vai trò nay đúng như tab "Bộ lọc" của CapCut.
  Ở lại Inspector: tên LUT đang áp + thanh CƯỜNG ĐỘ — vì cường độ là thuộc tính của
  TỪNG block (và đang keyframe được), không phải của thư viện.

- 22 PRESET, 4 NHÓM (`cat` trong library/luts/presets.json, backend trả kèm):
    soft   (10) Sữa · Sứ · Ánh ngày · Đào nhạt · Ửng hồng · Sương lam · Bạc hà ·
                Mật nhạt · Vải lanh · Trời râm
    bright  (6) Tươi sáng · Nắng ấm · Rực rỡ · Pastel dịu · Xanh tươi · Trong trẻo
    cine    (5) Teal & Orange · Phim ấm · Lạnh xanh · Hoài cổ · Đậm nét
    mono    (1) Đen trắng
    user    (n) .cube người dùng nhập
  Nhóm `soft` mặc định mở trước.

- BA LỖI CỦA NHÓM DỊU BẢN ĐẦU (người dùng báo "khác mỗi cái tên", đo lại đúng vậy:
  cặp giống nhau nhất chỉ lệch 0.62/255 — vô hình). Đừng dựng lại kiểu cũ:
  1. `splitToneSoft` nhân lượng nhuộm với headroom `(1−v)`. Look dịu đẩy phần lớn ảnh
     lên vùng sáng (v ≈ 0.55–0.85), ở đó `(1−v)` chỉ còn 0.15–0.45 nên TINT BỊ TRIỆT
     TIÊU ĐÚNG CHỖ đáng lẽ thấy rõ nhất. Sửa: `headroomGuard` giữ nguyên lượng nhuộm
     tới 0.82 rồi mới cuộn về 0 ở 1.0 — vẫn chặn cháy, mà look còn nguyên.
  2. Biên độ nhuộm 0.004–0.046 và CÙNG MỘT HƯỚNG ở cả bóng lẫn vùng sáng. Nay
     0.05–0.16 và TÁCH TÔNG NGƯỢC HƯỚNG (bóng một sắc, vùng sáng sắc đối lập) — đó
     mới là cách các look phim phân biệt nhau.
  3. `softBase` áp riêng TỪNG KÊNH RGB. Nén tương phản theo kênh thì nén luôn KHOẢNG
     CÁCH GIỮA CÁC KÊNH = mất bão hoà: đo được da người tụt 27.0 -> 19.6 điểm CHỈ do
     bước này, trước cả bước giảm bão hoà cố ý -> mặt xám bệch. Sửa: `softTone` chạy
     đường cong TRÊN ĐỘ CHÓI rồi dịch cả 3 kênh cùng một lượng, giữ nguyên bão hoà;
     việc giảm bão hoà bao nhiêu để `desaturateKeepSkin` lo — mỗi thứ một việc.
  BÀI HỌC QUY TRÌNH: hai lần đầu tôi ĐOÁN nguyên nhân (đổ cho tint, rồi cho desaturate)
  và sửa trượt cả hai. Chỉ khi TRUY VẾT bão hoà qua từng giai đoạn mới thấy thủ phạm là
  `softBase`. Gặp "các preset trông giống nhau" thì đo từng bước, đừng đoán.

- `desaturateKeepSkin(rgb, amount, keep=0.78)` — giảm bão hoà nhưng CHỪA DA. Trọng số
  chỉ bật khi đỏ > lục > lam (thứ tự kênh đặc trưng của da), nên trời (lam trội) và
  cây (lục trội) vẫn bị rút bão hoà đầy đủ -> look giữ nguyên cá tính ở mọi chỗ TRỪ
  mặt người. Cần thiết vì nhóm này nhắm vào video nói trước máy, mặt chiếm phần lớn khung.

- SỐ ĐO SAU KHI SỬA (script đo trong scratchpad, tiêu chí tự đặt):
  * Khác biệt cặp: giống nhau nhất 0.62 -> **4.9/255**, trung bình 3.05 -> **10.5/255**.
  * Chất "dịu" giữ nguyên: cả 10 đều SÁNG hơn gốc (+6.4 → +11.2%) và TƯƠNG PHẢN THẤP
    hơn gốc (0.73–0.84×), KHÔNG preset nào gây kẹp.
  * Lệch bão hoà da: 9/10 nằm trong ±9%. NGOẠI LỆ CÓ CHỦ ĐÍCH: "Sương lam" −9.4% —
    rút bão hoà chính là bản chất của look sương mù; ép cho tròn số là mất cá tính.
  * Sai số nội suy 17³ của nhóm dịu: 2.0–3.7/255 (nhóm bright 2.9–4.8) — không xấu đi.

- THUMBNAIL VẼ TỪ CHÍNH KHUNG HÌNH CỦA DỰ ÁN (`lutThumbSource`), không dùng ảnh mẫu
  dựng sẵn: người dùng cần biết LUT tác động lên FOOTAGE CỦA HỌ (da người, ánh sáng
  phòng quay của họ) ra sao — ảnh mẫu đẹp sẵn thì LUT nào nhìn cũng ổn. Chưa có khung
  hình thì rơi về cảnh tổng hợp (trời → da → cây → xám). Cache lại vì mỗi lần mở tab
  phải chạy 22 LUT trên ảnh đó; `invalidateLutThumbs()` khi đổi cảnh.
  Vẽ bằng CHÍNH `ColorAdjust.sampleCubeTrilinear` — cùng phép nội suy preview/export
  dùng, nên ô xem trước không "đẹp hơn" kết quả thật.

- SUBTAB NHÓM (cột trái panel) — HAI thứ phải sửa cùng lúc khi thêm nhóm mới:
  (1) handler click ghi biến `editPanel<X>Cat`, (2) `renderEditPanel` ĐỌC biến đó để
  tính `activeSub`. Thiếu (2) là lỗi đã xảy ra (người dùng báo 2026-08-05): nội dung
  ĐỔI đúng nhưng `activeSub` luôn rơi về `subs[0]` nên nút "Dịu nhẹ" sáng vĩnh viễn,
  người dùng không biết mình đang ở nhóm nào.
  Kiểu hiển thị: nền xanh `--primary` + chữ trắng + VẠCH NHẤN trắng bên trái. Vạch là
  dấu hiệu THỨ HAI ngoài màu nền, để người khó phân biệt màu vẫn đọc được trạng thái.
  Bản cũ chỉ đổi nền xám nhạt -> gần như không thấy khác gì.

- KÉO-THẢ vào block (`setupLutDnd`): hit-test theo phần tử `.editing-block` dưới con
  trỏ, KHÔNG theo toạ độ lane như kéo-thả asset — LUT không tạo block mới, nó sửa
  block có sẵn. Thả trượt ra ngoài block thì KHÔNG làm gì, cố ý không đoán block gần
  nhất (đoán sai = đổi màu nhầm block mà người dùng không biết).
  Listener đặt ở pha CAPTURE: handler kéo-thả asset cũng nghe trên
  `#timelineTrackOuter` và sẽ preventDefault trước, biến cú thả LUT thành "tạo block".

- MỘT LUT / BLOCK (chốt 2026-08-04): kéo LUT mới lên block THAY thế LUT cũ, đúng cách
  CapCut làm khi thả bộ lọc lên clip. Giữ nguyên `adj.lut` một slot -> không phải đổi
  cấu trúc adjustments, định dạng .crab, bộ bake cube hay chuỗi filter export.
  Bấm lại LUT đang áp = gỡ (toggle).

- TỰ ĐỘNG CHỈNH MÀU KHÔNG CÒN DÍNH LUT (2026-08-04): hai thứ này là HAI LỚP khác
  nhau — auto grade SỬA footage về chuẩn (phơi sáng/cân bằng trắng), LUT là lựa chọn
  THẨM MỸ chồng lên trên. Trong chuỗi màu `lut3d` vốn đã đứng CUỐI (sau eq/tone/
  colorbalance/curves/HSL) nên thứ tự "LUT áp lên kết quả tự động" là sẵn có.
  `AutoGrade.applyPatch` KHÔNG đụng `adj.lut` — test chốt bằng deepStrictEqual.
  Ô cạnh nút vẫn còn, nhưng nay là KIỂU CHỈNH chứ không phải danh sách LUT — xem dưới.
```

### Lớp Điều Chỉnh (Adjustment Layer)

```text
- LÀ GÌ: một block KHÔNG VẼ GÌ CẢ, chỉ mang một bộ `adjustments` và áp bộ đó lên MỌI
  LỚP NẰM DƯỚI trong khoảng thời gian nó phủ — như Adjustment Layer của Premiere /
  lớp Điều chỉnh của CapCut. Tạo từ tab "Điều chỉnh" ở panel TRÁI.
  Cố ý KHÔNG có asset/animation: chỗ nào lỡ coi nó là lớp hình sẽ hỏng NGAY
  chứ không âm thầm vẽ ra một ô đen. Lane của nó có `visualTrackDefaultPriority` = −1
  nên luôn nằm TRÊN CÙNG (đặt lẫn giữa các lane khác thì thứ tự z không đọc được bằng mắt).
  Mặc định phủ TRỌN sequence; trim 2 đầu để khu trú.
  Thuộc tính DUY NHẤT của `transform` có nghĩa với nó là `opacity`, và nó mang nghĩa
  CƯỜNG ĐỘ HIỆU ỨNG — xem mục riêng bên dưới.

- KHÔNG CÓ PHẦN TỬ PREVIEW (sửa 2026-08-25). `renderPreviewOverlays` lọc bỏ hẳn item
  `adjust`. Trước đó nó chảy vào nhánh media chung, mà lớp không có asset -> dựng một
  `<img src="">`: hiện đúng một Ô VUÔNG cỡ 0.45×0.25 khung (kèm icon ảnh lỗi) chỉ có ở
  preview, bản xuất không có. Tệ hơn: `setCached('opacity', …)` làm mờ CÁI Ô đó, nên kéo
  Opacity trông như "đang làm mờ hiệu ứng" mà thật ra chẳng chạm vào màu lần nào.
  Khung CHỌN thì vốn đã không vẽ (`selectedVisualItemForBox` chỉ nhận media/text/shape).

- QUYẾT ĐỊNH KIẾN TRÚC 1 — ÁP THEO TỪNG LỚP, KHÔNG áp sau khi composite.
  Preview composite bằng DOM (overlay là phần tử DOM chồng lên canvas PIXI), KHÔNG có
  canvas gộp mỗi khung; muốn áp sau composite thì phải viết lại `renderPreviewOverlays`
  thành bộ composite từng khung. Áp theo lớp thì preview và export khớp TUYỆT ĐỐI.
  Sai khác duy nhất so với adjustment layer "thật": pixel BÁN TRONG SUỐT (mép chữ khử
  răng cưa, overlay mờ), vì f(a·x+(1−a)·y) ≠ a·f(x)+(1−a)·f(y) với f phi tuyến. Vùng
  đục thì hai cách cho kết quả y hệt.

- QUYẾT ĐỊNH KIẾN TRÚC 2 — MỘT LỚP TẠI MỘT THỜI ĐIỂM (lớp TRÊN CÙNG thắng).
  Ở export mỗi lớp cần chuỗi filter riêng KÈM .cube riêng, mà cơ chế LUT3D_SLOT của
  backend chỉ có MỘT chỗ trống cho mỗi block. Cho xếp chồng = phải làm slot nhiều chỗ
  ở backend + vòng lặp ở sidecar, và mỗi thứ đó là một chỗ để preview lệch export.
  Một lớp thì hai bên khớp bằng CẤU TRÚC. Muốn nhiều tầng: đặt LUT lên chính block,
  hoặc trim các lớp cho NỐI TIẾP nhau thay vì chồng lên nhau.

- PREVIEW = LƯỢT SHADER THỨ HAI, sau chỉnh màu của chính block (đúng thứ tự export):
  * Overlay (`paintColorFxCanvas`): renderer của item vẽ THẲNG vào canvas đang hiện nên
    không đọc lại được chính nó -> lượt 1 (màu của item) chạy ở canvas đệm qua
    `colorAdjustedDrawable`, lượt 2 (màu của lớp) vào canvas hiện.
  * Lane chính (index.html): có lớp -> ÉP sang đường canvas nhiều lượt, rồi gọi
    `colorAdjustedDrawable` lần hai. Cố ý KHÔNG dùng `sprite.filters = [a, b]`: sẽ
    thành HAI bản cài đặt của cùng một chuỗi (canvas ca này, PIXI ca kia) và sớm muộn
    lệch nhau.
  * `itemHasColorAdjust` trả true khi item CÓ GIAO THỜI GIAN với lớp — xét theo giao
    nhau chứ KHÔNG theo thời điểm hiện tại: giá trị này quyết định LOẠI THẺ preview
    (canvas <-> video/img), đổi giữa lúc phát là dựng lại <video>, mất frame và mất
    cả tiếng. Cùng bài học với nhánh keyframe.

- EXPORT = CHUỖI FILTER THỨ HAI nối SAU chuỗi của block:
  frontend `adjustLayerExportSpec()` -> `color_adjust_layer` -> backend
  `normalizeAdjustLayerFields()` -> `adj_layer_filters` -> sidecar gọi
  `AppendColorAdjustFilters` LẦN HAI với mặt nạ RỖNG.
  * VÌ SAO FIELD RIÊNG chứ không nối thẳng vào `adj_filters`: khi block có MẶT NẠ,
    sidecar bọc `adj_filters` trong nhánh split/alphamerge. Nối vào đó là lớp bị mặt
    nạ CỦA BLOCK cắt theo — sai (mặt nạ là của block), và preview áp toàn khung nên
    hai bên lệch. Gọi lần hai với mặt nạ rỗng thì chuỗi lớp nằm NGOÀI nhánh mặt nạ.
  * TÊN FIELD: `adj_layer_filters`, KHÔNG phải `adj_filters_post` — tên đó đã dùng cho
    nửa sau của chuỗi ở đường LUT-mix, trùng là hỏng cả hai.

- QUY ĐỔI THỜI GIAN (chỗ dễ sai nhất): lớp định vị theo thời gian SEQUENCE, nhưng
  chuỗi filter chạy TRONG một đoạn đã trim+setpts nên `t` của `enable` là thời gian
  CỤC BỘ từ đầu đoạn. Phải lấy phần giao rồi TRỪ ĐI mốc bắt đầu của block. Quên trừ là
  lớp bật đúng độ dài nhưng SAI CHỖ — và với block cuối sequence thì không bật lần nào.
  Mốc sequence của clip lane chính = TỔNG THỜI LƯỢNG các clip trước nó
  (`mainSeqStarts` trong index.html); `clip.start/end` là thời gian NGUỒN, dùng nhầm
  là sai hoàn toàn.

- `enable` PHẢI GẮN VÀO TỪNG FILTER, không bọc được cả chuỗi -> làm trong
  `ColorAdjust.ffmpegFilters(options.enable)`, nơi DUY NHẤT biết ranh giới giữa các
  filter. Ghép chuỗi rồi mới chèn bằng regex là sai với `curves=all='...'`.
  Chỗ trống LUT3D_SLOT cũng nhận enable, nếu không LUT của lớp áp SUỐT block trong khi
  các thông số khác chỉ áp trong khoảng.
  `enableBetween()` trả '' khi phủ TRỌN (không phát enable — ca thường gặp nhất, chuỗi
  rẻ hơn và không lo sai số biên) và null khi KHÔNG GIAO. Hai giá trị này phải phân
  biệt được: '' = áp cả block, null = không áp.

- ĐO ĐƯỢC (tests/scripts/adjust_layer_pipeline.js, cần ffmpeg):
  * Cổng thời gian chạy THẬT trên video render ra: nguồn 64 -> t=0.4s: 64 (nguyên) ·
    t=1.5s: 168 (đã sáng) · t=2.6s: 64 (nguyên).
  * Hai chuỗi nối tiếp khớp hai lượt `applyToRgb`: ĐO TƯƠNG ĐỐI, không tuyệt đối.
    Bộ khung thử nạp rgb24 nên MỖI chuỗi đã ăn một vòng làm tròn RGB<->YUV: chuỗi ĐƠN
    lệch sẵn 9.05/255, chuỗi ĐÔI 12.59 (≈ căn 2 lần, đúng mức tích luỹ tự nhiên).
    Đòi <1/255 ở đây là đòi điều bất khả — `color_adjust_pipeline` né chuyện này bằng
    cách làm việc thẳng trong YUV444.
    PHÉP THỬ ĐỐI CHỨNG: đảo thứ tự (lớp trước, block sau) cho 23.45/255 — nhờ vậy mới
    biết phép đo THỰC SỰ phân biệt được thứ tự, chứ không phải ngưỡng nào cũng qua.

- OPACITY CỦA LỚP = CƯỜNG ĐỘ HIỆU ỨNG (2026-08-25), như Custom Adjustment của CapCut.
  Lớp không vẽ hình nên "làm mờ chính nó" là vô nghĩa; điều cần làm mờ là CÁI NÓ ÁP.
  * CÀI ĐẶT: `ColorAdjust.scaleStrength(adj, k)` kéo mọi thông số về TRUNG TÍNH theo k
    (curves kéo tung độ về đường chéo, `lut.intensity` nhân k, mặt nạ KHÔNG đụng vì nó
    là hình học), cộng `scaleStrengthKeyframes` cho các danh sách keyframe màu.
    Điểm vào: `adjustLayerStrength(layer)` -> dùng trong `activeAdjustmentLayerAdjustments`
    (mọi đường PREVIEW) và `adjustLayerExportSpec` (mọi đường EXPORT).
  * VÌ SAO KHÔNG PHA ALPHA Ở CUỐI: pha ở cuối cần một lượt trộn riêng, mà bên xuất lượt
    đó phải do sidecar C++ dựng (split + blend) — tức HAI bản cài đặt của cùng một phép,
    đúng thứ WYSIWYG ở đây đang phải tránh. Kéo thông số thì preview và bản xuất nhận
    CÙNG một object `adjustments`; không thêm một dòng nào ở backend/sidecar.
  * ĐÃ ĐO (adjust_layer_pipeline.js) độ lệch so với pha alpha, trên pixel KHÔNG kẹp biên:
    mọi tầng TUYẾN TÍNH (eq: phơi sáng/tương phản/bão hoà; colorbalance: nhiệt độ/sắc
    thái/vòng tròn màu) = 0.00/255; curves & tone <= 0.4 (sai số bảng tra 256 mức);
    HSL ~6 (tầng phi tuyến thật — trọng số dải phụ thuộc chính pixel); nhiều tầng phi
    tuyến xếp chồng ~11. Chỗ kẹp biên thì hai cách khác nhau về BẢN CHẤT và ở đó giảm
    cường độ mới là cái người dùng muốn (pha một pixel đã cháy trắng không lấy lại được
    chi tiết).
  * PHƠI SÁNG CÓ NHÁNH RIÊNG: slider của nó phi tuyến (`gain = 2^(EV/50)`), nhân thẳng
    slider cho k là kéo về trung tính theo log -> đo được lệch tới 35/255. Phải làm trong
    miền HỆ SỐ: c' = 1 + k(c−1), g' = (1 + k(c·g − 1))/c', rồi đổi ngược ra slider.
  * k = 0 -> `scaleStrength` trả bộ identity nên `activeAdjustmentLayerAdjustments` và
    `adjustLayerExportSpec` đều trả null: lớp tắt hẳn, bản xuất không có filter rỗng.
    Đường cong đã phẳng phải THU VỀ `defaultCurve()` (2 điểm) — `curveIsIdentity` xét
    theo SỐ ĐIỂM nên một đường 4 điểm đã phẳng vẫn bị coi là "có chỉnh", và cả bộ không
    bao giờ identity.
  * `adjustLayerIsActive` CỐ Ý KHÔNG xét opacity: nó nuôi `itemOverlapsAnyAdjustLayer`,
    thứ quyết định LOẠI THẺ preview của các block bên dưới. Cho opacity vào đó là kéo
    Opacity qua 0 sẽ dựng lại `<video>` giữa lúc phát (mất frame + mất tiếng).
  * KHÔNG KEYFRAME ĐƯỢC: bản xuất dựng chuỗi filter MỘT LẦN cho cả block nên chỉ nối
    được một cường độ cố định. `refreshInspectorTabs` vì thế ẩn nút hình thoi của Opacity
    khi kind = 'adjust' (cho bấm là preview chạy mà bản xuất đứng im).

- PANEL THUỘC TÍNH của lớp (2026-08-25): `INSPECTOR_KIND_TABS.adjust = ['adjust']` — chỉ
  tab "Điều chỉnh"; `INSPECTOR_STATIC_HOME.adjust = ['adjust','basic']` đưa khối "Hiển
  thị" (Opacity) vào subtab Cơ bản, còn khối "Biến đổi" (X/Y/Scale/Xoay/Flip) bị ẩn hẳn —
  lớp phủ TOÀN khung, không có hình để di chuyển. `syncOverlayInspector` gọi
  `buildAdjustSectionsHtml(item.adjustments, { mask: false, retouch: false })`: bỏ Mặt nạ
  (chưa có đường xuất, xem CHƯA HỖ TRỢ) và Retouch (gắn với người trong một clip cụ thể).
  Trước đó panel chỉ dựng cho `type === 'media'` nên lớp KHÔNG có tab Điều chỉnh nào,
  dù thông báo lúc tạo lớp vẫn mời "chỉnh ở tab Điều chỉnh bên phải".

- CHƯA HỖ TRỢ (bỏ qua CÓ Ý THỨC, backend ghi log chứ không im lặng): mặt nạ CỦA LỚP
  và keyframe `eq` của lớp — đường nối ngoài nhánh mặt nạ chỉ chuyển được chuỗi TĨNH.
  Ảnh chụp khung (`captureCompositeFrame`) cũng CHƯA áp lớp: nó chỉ dùng
  `effectiveAdjustments(clip)` của từng block.
```

### Retouch (Làm Đẹp Khuôn Mặt) — CHẠY ĐỦ PREVIEW + EXPORT + MEDIA OVERLAY

```text
TRẠNG THÁI: nền dữ liệu + engine đã xong và đã đo. CHƯA có UI, CHƯA có shader preview,
CHƯA có đường export. Người dùng chưa thấy gì — đúng ý đồ, không bật nửa vời.

KIẾN TRÚC (chốt sau khảo sát, xem lý do bên dưới):
- Landmark: MediaPipe FaceMesh `refine_landmarks=True` -> 478 điểm, chuẩn hoá 0..1.
  Dự án ĐÃ có sẵn FaceMesh cho overlay Skeleton; Retouch dùng lại, không dựng mới.
- Preview: shader GLSL nhiều lượt (dùng lại CanvasColorRenderer), chèn TRƯỚC chuỗi
  Điều chỉnh màu — sửa da trước, grade sau, đúng thứ tự nghề.
- Export: BAKE VÙNG MẶT theo luồng (FFmpeg không có filter nào biết khuôn mặt).
  Đo được: mặt chiếm 5,5% diện tích khung -> bake vùng mặt rẻ hơn bake cả khung ~18 lần.
  KHÔNG viết retouch trong C++ sidecar: sẽ thành hai bản cài đặt của cùng thuật toán
  (GLSL preview / C++ export) — đúng cái bài học đã lặp lại nhiều lần trong dự án này.

ĐÃ LÀM (Phase 1):
- `FrameStream` (auto_reframe_sidecar.py): đọc frame TUẦN TỰ qua MỘT pipe rawvideo.
  VÌ SAO BẮT BUỘC: `capture_frame()` cũ spawn MỘT ffmpeg cho MỖI frame — đo được
  **123 ms/frame**, tức video 5 phút @30fps = **18,5 phút** chỉ để trích ảnh. Đọc
  tuần tự: **1,2 ms/frame** -> 11 giây. Nhanh hơn ~100 lần Ở KHÂU TRÍCH ẢNH.
  Hạ cỡ ngay trong ffmpeg (`scale`), không hạ ở Python: FaceMesh nội bộ chạy 192x192
  nên >384px không thêm độ chính xác, mà băng thông pipe tỉ lệ với số pixel.
- Chế độ `retouch_track` + `face_landmarks_multi`: NHIỀU mặt (`max_num_faces`) và
  `static_image_mode=False` (chế độ VIDEO — MediaPipe tự theo vết giữa các frame, vừa
  nhanh vừa đỡ rung). Chỉ đúng khi frame vào THEO THỨ TỰ THỜI GIAN — FrameStream bảo
  đảm; đừng dùng instance này cho việc lấy mẫu nhảy cóc.
- `smooth_face_series`: EMA HAI CHIỀU (xuôi + ngược rồi trung bình). Một chiều gây TRỄ
  PHA — mặt bám sau chuyển động thật, quay đầu nhanh là thấy. Chỉ làm mượt trong đoạn
  LIÊN TỤC có mặt và khi SỐ MẶT ổn định (bắc cầu qua chỗ mất dấu = kéo mặt cũ sang
  cảnh mới; ghép nhầm mặt A với mặt B khi số mặt đổi).
- `/api/retouch/track` + cache đĩa `temp_uploads/retouch_faces/`.
  KHOÁ CACHE GỒM CẢ mtime+size CỦA NGUỒN: dự án ghi đè `temp_input.mp4` mỗi lần ingest,
  chỉ băm đường dẫn là lần sau dùng lại landmark của video CŨ -> mặt nạ dán sai chỗ.
- `static/js/retouch.js`: mô hình 13 thông số chia 3 nhóm kỹ thuật + vùng FaceMesh +
  hộp bao + chọn mặt + điểm điều khiển biến dạng.
  BA NHÓM, BA KỸ THUẬT KHÁC HẲN — đừng gộp:
    warp  (Thon mặt, Đầy đặn)                  -> dịch UV theo điểm điều khiển
    freq  (Mịn da, Xoá khuyết điểm, Đều màu…)  -> tách tần số trên mặt nạ da
    color (Trắng da, Trắng răng, Sáng mắt…)    -> phép màu cục bộ theo mặt nạ
  `selectFaces('single')` chọn mặt LỚN NHẤT, KHÔNG phải phần tử [0]: thứ tự MediaPipe
  trả về không ổn định giữa các frame, lấy [0] là mặt nhảy qua lại giữa 2 người.
  Biên độ biến dạng khai theo TỈ LỆ CỠ MẶT, không theo pixel -> mặt gần/xa máy cho
  cùng cảm giác, và preview proxy khớp bản xuất.

ĐO ĐƯỢC (trên footage thật của dự án, 1728x3072 @59.94fps):
- 6 giây @30fps = 180 frame: phân tích hết **4,4 giây**, nhận diện **180/180 frame (100%)**.
- Làm mượt giảm rung landmark **2,26 -> 1,78 px** (−21%) trên khung rộng 1728.
  Phần còn lại là chuyển động THẬT của mặt, không phải nhiễu.
- Endpoint: lần đầu 3,49s -> lần sau **0,028s** nhờ cache (nhanh hơn 125 lần).

CHỈ SỐ VÙNG FACEMESH KIỂM BẰNG HÌNH HỌC, KHÔNG TIN VÀO VIỆC CHÉP ĐÚNG
(tests/scripts/retouch_regions.js + dữ liệu mẫu landmark THẬT):
  mắt/miệng phải NẰM TRONG viền mặt · miệng ở DƯỚI mắt · môi trong ⊂ môi ngoài ·
  cằm = điểm thấp nhất, trán = cao nhất · 2 má kẹp mũi.
  Lý do: chép sai một chỉ số thì mặt nạ lệch chỗ mà ĐỌC CODE KHÔNG THẤY SAI — chỉ nhìn
  ảnh mới biết. Các bất biến trên đúng với mọi khuôn mặt người nên sai là đổ ngay.

ĐÃ LÀM (Phase 2 — mặt nạ + nhóm `color`):
- BỐN MẶT NẠ GÓI VÀO BỐN KÊNH của MỘT texture RGBA: R=da · G=mắt · B=răng · A=quầng thâm.
  Một texture thay vì bốn: mỗi texture là một lần upload GPU + một sampler, mà WebGL1
  giới hạn số sampler. Gói kênh cũng bảo đảm 4 mặt nạ CÙNG độ phân giải và CÙNG phép
  làm mượt biên — lệch nhau là thấy đường ghép.
- MẶT NẠ DA = viền mặt TRỪ 2 mắt, TRỪ 2 chân mày, TRỪ khoang miệng. Không khoét thì:
  làm mịn lên mắt -> mất nét mi; làm trắng lên chân mày -> bay mày; làm mịn lên khoang
  miệng -> mất ranh giới răng. Đây CHÍNH LÀ khác biệt giữa retouch và "blur cả mặt".
- VÙNG QUẦNG THÂM không có sẵn thành một vòng trong bộ chỉ số MediaPipe -> phải DỰNG
  từ dải giữa mí dưới (`lower1`) và vòng ngoài hốc mắt (`lower3`): đi xuôi lower1 rồi
  đi NGƯỢC lower3 để ra polygon khép kín không tự cắt. Test kiểm nó nằm DƯỚI mắt, TRONG
  viền mặt, và diện tích > 0 (tự cắt thì diện tích ~0).
- `applyColorOps()` là CÔNG THỨC THAM CHIẾU cho 5 phép: Trắng da · Quầng thâm · Sáng
  mắt · Trắng răng · Tông da. Shader preview và khâu bake khi xuất đều phải cài đúng
  hàm này. Từng lựa chọn có lý do, đừng "đơn giản hoá":
    * Trắng da nâng bằng GAMMA, không nhân — nhân thì sống mũi/trán cháy ngay.
    * Quầng thâm nâng theo trọng số (1 − độ sáng): chỗ càng thâm càng được nâng nhiều;
      nâng đều cả vùng thì gò má bệt sáng. Bù thêm chút đỏ vì quầng thâm ngả xanh/tím.
    * Sáng mắt TĂNG TƯƠNG PHẢN quanh trung tính, không nâng sáng đều — nâng đều thì
      con ngươi cũng sáng lên và mắt bị "đục".
    * Trắng răng GIẢM BÃO HOÀ trước rồi mới nâng sáng: răng ố là ngả VÀNG, nâng sáng
      thẳng chỉ ra răng vàng sáng hơn chứ không trắng hơn.
    * Tông da GIỮ NGUYÊN ĐỘ SÁNG pixel (chỉ kéo sắc): trộn thẳng sang màu đích là mặt
      bẹt như dán giấy màu, mất hết khối sáng tối.

HỢP ĐỒNG QUAN TRỌNG NHẤT của nhóm `color`: NGOÀI mặt nạ thì pixel BẤT BIẾN TUYỆT ĐỐI.
  Sai điều này là retouch rỉ ra hậu cảnh — rất dễ lọt nếu quên nhân trọng số ở MỘT phép.
  Test kéo HẾT mọi slider với mặt nạ = 0 và đòi sai lệch < 1e-12.
  Đo trên footage thật: áp 4 phép -> chỉ **4,4% pixel của khung đổi**, khớp với hộp bao
  mặt 5,5% -> hiệu ứng không rỉ ra ngoài.

HƯỚNG PHẢI KHỚP TÊN — cùng bài học với nhóm Sắc của auto-grade (giá trị hợp lệ và khác
nhau KHÔNG chứng minh hướng đúng). Test chốt: Trắng da phải SÁNG hơn · Quầng thâm nâng
chỗ TỐI nhiều hơn chỗ sáng · Trắng răng GIẢM bão hoà · Sáng mắt làm lòng trắng sáng mà
con ngươi KHÔNG sáng theo · Tông da giữ độ sáng.

ĐÃ LÀM (Phase 3 — tách tần số, nhóm `freq`):
- BA TẦNG: lowCoarse (nền, khối sáng tối) · mid = lowFine − lowCoarse (nếp nhăn, mảng
  màu) · high = gốc − lowFine (lỗ chân lông, mụn). Nén mid/high TRONG mặt nạ rồi cộng
  lại. Giữ nguyên tầng NỀN là lý do da mịn mà không "nhựa" — blur thẳng rồi trộn thì
  mất cả khối, ra mặt phẳng lì.
- MỖI PHÉP TÁC ĐỘNG MỘT TẦNG KHÁC NHAU, để chúng thật sự khác nhau chứ không phải mấy
  tên gọi cho cùng một thứ:
    Mịn da           high, nén ĐỐI XỨNG
    Xoá khuyết điểm  high, nén BẤT ĐỐI XỨNG — chỉ hạ gai ÂM (chỗ tối hơn xung quanh =
                     mụn/đốm), giữ gai dương nên lỗ chân lông và ánh sáng trên da còn
                     lại -> da vẫn ra da
    Nét căng         high, KHUẾCH ĐẠI
    Xoá nếp nhăn     mid  (nếp nhăn thô hơn lỗ chân lông; nén nhầm tầng cao là xoá kết
                     cấu mà nếp nhăn vẫn còn nguyên)
    Nếp cười         mid, khu trú trong dải nasolabial
    Đều màu          nền, kéo sắc về trung bình cục bộ, GIỮ độ sáng
    Da căng bóng     nền, thêm phản quang ở phần sáng
- BẤT BIẾN NỀN TẢNG: tham số 0 thì nền + mid + high phải TÁI TẠO ĐÚNG ảnh gốc. Sai chỗ
  này thì mọi thứ dựng trên nó sai một cách âm thầm.
- DẢI NẾP CƯỜI dựng BẰNG HÌNH HỌC từ mũi/khoé miệng/mép má (các mốc đã kiểm chứng), KHÔNG
  chép thêm một bộ chỉ số MediaPipe nữa — mỗi bộ chép tay là một chỗ sai âm thầm.

ĐÃ LÀM (Phase 4 — biến dạng, nhóm `warp`): và sửa BA LỖI của bản Phase 1
1. KHOẢNG CÁCH PHẢI ĐO TRONG KHÔNG GIAN PIXEL, không phải UV. UV chuẩn hoá 0..1 ở CẢ
   hai trục, nhưng khung 1728x3072 thì 0.1 theo x = 173px còn theo y = 307px. Đo thẳng
   trên UV thì vùng ảnh hưởng "tròn" hoá ELIP -> biến dạng bè ngang trên video dọc.
   `displaceUv` nay nhân dx với `aspect` trước khi tính khoảng cách.
2. CỘNG DỒN điểm điều khiển chồng nhau -> GẤP ẢNH. JAW_LEFT có 5 điểm cùng hướng, bán
   kính lớn nên phủ lên nhau (đo được tổng trọng số tới 5.44). Nay TRUNG BÌNH CÓ TRỌNG
   SỐ rồi nhân lại trọng số lớn nhất — một điểm đơn lẻ giữ nguyên biên độ, N điểm trùng
   nhau không cộng thành N lần.
   BẢN SỬA ĐẦU dùng `if (wSum > 1) chia cho wSum`: CHỖ GÃY, đạo hàm nhảy bậc ngay tại
   đường wSum = 1 và chính nó đẩy gradient lên 0.805.
3. ĐƠN VỊ KHÔNG NHẤT QUÁN: `faceScale` đo trong UV thô nhưng bán kính lại so với
   khoảng cách trong không gian pixel. `faceScale(face, aspect)` nay trả khoảng cách
   trong không gian chuẩn hoá theo CHIỀU CAO, cùng đơn vị với `displaceUv`.

- `warpMaxGradient()` — GRADIENT ≥ 1 nghĩa là trường dịch chuyển GẤP ảnh lên chính nó
  (hai điểm nguồn rơi vào cùng một điểm đích) -> mép hàm rách/nhoè. Đây là hỏng hóc đặc
  trưng của warp làm ẩu và NHÌN CÔNG THỨC KHÔNG THẤY: nó phụ thuộc biên độ, bán kính VÀ
  mức chồng nhau giữa các điểm.
  BỘ HẰNG SỐ ĐƯỢC CHỌN BẰNG ĐO, không bằng cảm giác: bản đầu (0.055/0.040, bán kính
  0.34/0.30) cho gradient tổ hợp 0.815 — chưa gấp nhưng chỉ cần khuôn mặt góc cạnh hơn
  là rách. Nới BÁN KÍNH rẻ hơn hạ BIÊN ĐỘ: 0.815 -> 0.493 mà độ thon chỉ giảm 5.5% ->
  4.7% bề ngang mặt. Nay 0.048/0.034, bán kính 0.50/0.44.

BẪY ĐÃ MẮC — ĐƠN VỊ TRONG `freqRadii` (chỉ ẢNH mới lộ ra, unit test KHÔNG bắt được):
  Bản đầu nhận MỘT số pixel rồi nhân với `faceScale` thô. Nhưng faceScale đo giữa hai
  mép má nên là tỉ lệ theo CHIỀU RỘNG, nhân với pixel CHIỀU CAO là sai đúng bằng tỉ lệ
  khung: trên 400x712 ra bán kính thô 12px = 13% bề ngang mặt (đáng ra 8%) -> MẶT NHOÈ
  QUÁ TAY. Unit test cũ chỉ kiểm TỈ LỆ (gấp đôi khung thì gấp đôi bán kính) nên qua hết.
  Nay `freqRadii(face, frameW, frameH)` tính thẳng bề ngang mặt bằng pixel, và test chốt
  TRỊ TUYỆT ĐỐI (bán kính phải = đúng % bề ngang mặt ở mọi kích thước khung).
  BÀI HỌC: test tỉ lệ không thay được test trị tuyệt đối, và với thứ nhìn được thì phải
  NHÌN — hai lỗi đơn vị trong phiên này đều chỉ lộ ra khi dựng ảnh lên xem.

ĐÃ LÀM (raster hoá mặt nạ — `rasterizeMasks`):
- THUẦN JS, KHÔNG DÙNG CANVAS. `ctx.fill()` (khử răng cưa) và `ctx.filter='blur()'` đều
  do TRÌNH DUYỆT tự định nghĩa — dùng chúng thì preview và khâu bake khi xuất ra mặt nạ
  KHÁC NHAU, tức WYSIWYG vỡ đúng ở chỗ khó thấy nhất (mép mặt nạ). Tự rasterize bằng
  scanline + box blur thì hai bên ra ĐÚNG cùng một mảng số. Test chốt tính TẤT ĐỊNH.
- Làm mượt biên = BOX BLUR XẾP TẦNG ×3, đúng con số và đúng lý do mà nhóm Hiệu ứng của
  color-adjust.js đang dùng: box blur là phép CHÍNH XÁC nên tái tạo được tuyệt đối, còn
  Gauss đệ quy (gblur) thì không.
- 5 MẶT NẠ / 2 TEXTURE RGBA (`MASK_LAYOUT`): skin·eyes·teeth·underEye ở texture 0,
  nasolabial ở texture 1. Ghi chú cũ nói "gói 1 texture để đỡ sampler" là LO XA KHÔNG
  CẦN THIẾT — WebGL1 bảo đảm tối thiểu 8 texture unit, cả chuỗi retouch chỉ dùng 5.

- HAI LỖI ĐÃ ĐO ĐƯỢC VÀ SỬA (cả hai chỉ lộ ra khi đọc TRỊ SỐ trên mảng, không lộ ở
  test polygon):
  1. LỖ KHOÉT BỊ LẤP LẠI. Gộp viền + lỗ vào một lượt even-odd rồi làm mượt CẢ CỤM thì
     chân mày — dày chỉ ~3.6% bề ngang mặt — bị lấp gần hết: đo được da tại chân mày
     = 1.00 và tại giữa mắt = 0.65, tức mặt nạ da phủ luôn lông mày và tròng mắt, và
     "trắng da" sẽ bay mất mày. Sửa: raster viền và lỗ RIÊNG, lỗ làm mượt nhẹ hơn nhiều
     (`HOLE_FEATHER_SCALE` = 0.28) rồi TRỪ ra. Viền ngoài cần MỀM, lỗ cần SẮC.
     Sau khi sửa: mày 0.26 · giữa mắt 0.09 · khoang miệng 0.00 · má 1.00 · ngoài mặt 0.
  2. RASTER PHỦ CẢ KHUNG QUÁ ĐẮT. Để chân mày còn sống thì mặt phải chiếm ~200px trên
     lưới; mà mặt chỉ chiếm ~22% bề ngang khung nên lưới phủ cả khung thành 979x1740 =
     1.7 triệu pixel -> **325 ms/khung**, không dùng được cho preview.
     Sửa: raster trong KHÔNG GIAN HỘP BAO MẶT, lưới cố định 256² -> **16.7 ms/khung**
     (rẻ hơn ~19 lần) với CÙNG độ chi tiết. `sampleMasks` quy toạ độ khung về toạ độ
     hộp; ngoài hộp mọi mặt nạ = 0. Shader phải cài lại ĐÚNG phép quy đổi này.

ĐÃ LÀM (shader GLSL — `RETOUCH_FRAGMENT_SRC`):
- ĐÂY LÀ BẢN CÀI ĐẶT THỨ HAI của cùng phép toán (bản một là các hàm JS thuần). Luật:
  **sửa một bên thì phải sửa bên kia VÀ chạy lại trang đối chiếu** —
  `tests/manual/retouch_shader_parity.html` (cần WebGL nên không nằm trong `npm test`;
  đúng tiền lệ "Probe Electron" của color-adjust: chạy tay rồi ghi số đo vào đây).
  ĐO ĐƯỢC: lệch lớn nhất **0.97/255**, trung bình 0.25 — dưới một bậc lượng tử 8-bit,
  với đủ 16 điểm biến dạng + 11 tham số + đổi tông da. Ngưỡng chấp nhận: ≤ 2/255.
  Mọi texture để NEAREST trong phép đo, để tách bạch phép TOÁN khỏi phép nội suy của GPU.

- THỨ TỰ CHUỖI (cố định, hai bên giống hệt): BIẾN DẠNG -> TÁCH TẦN SỐ -> MÀU CỤC BỘ.
  Hình học trước (nó đổi chỗ pixel), rồi kết cấu, rồi màu. Cả ba đều phi tuyến nên đảo
  thứ tự là ra kết quả khác.

- HAI TẦNG MỜ TÍNH TRONG LƯỚI CỤC BỘ CỦA MẶT (`FREQ_GRID` = 256), KHÔNG tính ở độ phân
  giải nguồn. Đây là RÀNG BUỘC CỨNG chứ không phải tối ưu: shader tích chập dùng chung
  của dự án có MAX_TAPS = 33, tức bán kính tối đa 16px; mà bán kính thô = 7.5% bề ngang
  mặt, ở nguồn 1728x3072 là **29.1px** — vượt trần. Tính ở độ phân giải nguồn thì shader
  bị kẹp bán kính còn khâu bake thì không -> preview và bản xuất mờ khác nhau.
  Trong lưới cục bộ 256 thì bán kính thô còn **14.0px** ở MỌI độ phân giải nguồn.
  KHÔNG mất chi tiết: hai tầng này theo định nghĩa là tần số THẤP (trơn) nên tính ở lưới
  nhỏ rồi nội suy lên là gần như chính xác, còn tầng `high` vẫn lấy ở độ phân giải đầy
  đủ (high = gốc_full − lowFine_nội_suy). Chi tiết da nằm trọn trong `high`.
  `blurRgbBoxCascade` chốt luôn THUẬT TOÁN làm mờ (box blur xếp tầng ×3) để hai bên
  không mỗi bên một kiểu — trước đó `applyFreqOps` chỉ NHẬN hai tầng mà không nói chúng
  được làm mờ bằng gì, tức là một chỗ hở để preview lệch export.

ĐÃ LÀM (UI panel + bộ render):
- `RetouchRenderer` — đóng gói shader thành thứ dùng được, cùng khuôn
  `ColorAdjust.CanvasColorRenderer`: sở hữu canvas WebGL, nhận drawable vào và trả
  canvas ra. Không có WebGL / shader biên dịch lỗi -> `init()` trả false và caller phải
  rơi về ảnh gốc, KHÔNG được hiện khung đen. Lỗi biên dịch có `console.error` để nó
  không im lặng biến thành "không thấy hiệu ứng".
  CACHE THEO LANDMARK: raster mặt nạ + hai tầng mờ (CPU, ~17 ms) chỉ phụ thuộc
  LANDMARK, không phụ thuộc tham số -> kéo thanh trượt chỉ chạy lại shader (rẻ).
- Panel Inspector, tab "Retouch": công tắc bật/tắt · ô "Áp cho" (một người / mọi khuôn
  mặt) · dòng trạng thái bám mặt · 13 thanh trượt CHIA THEO 3 NHÓM KỸ THUẬT của engine
  (Định hình 2 · Da & kết cấu 7 · Sáng & màu 4) · bảng 9 tông da + mức.
  Danh sách thanh trượt sinh TỪ `Retouch.PARAMS`, nên thêm thông số ở engine là UI tự
  có — không phải sửa hai chỗ.
- `applyRetouch()` là ĐIỂM VÀO DUY NHẤT để sửa `retouch` (undo + dọn field rỗng + làm
  mới preview), đúng khuôn `applyAdjust` của phần màu. `isIdentity` -> xoá hẳn field nên
  .crab không mang rác.
- BẬT CÔNG TẮC LẦN ĐẦU tự mồi Mịn da 35 / Xoá khuyết điểm 40: nếu để 0 hết thì
  `isIdentity` xoá luôn field và công tắc vừa bật đã tắt lại. Cùng lý do chọn LUT tự
  đưa Cường độ về 100.
- LANDMARK KHÔNG VÀO .crab — nó suy ra được từ video nên chỉ là cache trong bộ nhớ
  (`retouchFaceCache`, khoá theo nguồn + khoảng clip). Nhét vào .crab thì file phình
  hàng chục MB mà mở ở máy khác vẫn phải tính lại nếu đổi nguồn.

ĐÃ NỐI VÀO PREVIEW (`retouchedDrawable` -> `resizeAndRender` ở index.html):
- CHẠY TRƯỚC CHUỖI CHỈNH MÀU: retouch sửa DA, grade/LUT là lớp thẩm mỹ áp LÊN kết quả
  đó. Kết quả là CANVAS nên buộc đi đường nhiều lượt, y như khi có lớp Điều chỉnh.
- KHÔNG BAO GIỜ TRẢ NULL: chưa có landmark / không có WebGL / mặt không thấy -> trả lại
  CHÍNH drawable gốc để preview vẽ tiếp như thường. Trả null giữa lúc phát là khung đen.
- CẮT VÙNG MẶT BẰNG `drawImage`, không bằng vòng lặp JS: lấy mẫu 256² bằng JS là 65k
  lần gọi hàm ngay trong vòng vẽ. `beginFace`/`finishFace` tách đôi chính vì bước ở giữa
  này là việc của caller (nó mới biết drawable là video, canvas hay ảnh).

- LỖI LỘN NGƯỢC ẢNH (đã sửa) — đáng ghi lại vì nó cho thấy giới hạn của phép đối chiếu:
  gốc toạ độ framebuffer WebGL ở DƯỚI-TRÁI, còn canvas (thứ PIXI.Texture.from/drawImage
  đọc) thì hàng 0 ở TRÊN. Vertex shader dùng `aPos*0.5+0.5` -> fragment ở đáy framebuffer
  lấy hàng 0 của ảnh -> ẢNH RA LỘN NGƯỢC (đo được: 99.4% pixel đổi, lệch TB 96.8/255).
  TRANG ĐỐI CHIẾU GLSL<->JS KHÔNG BẮT ĐƯỢC: nó đọc bằng readPixels (cũng dưới-lên) nên
  hai bên dùng chung quy ước ngược và nó TỰ TRIỆT TIÊU — vẫn báo 0.97/255.
  Sửa: `vUv = vec2(aPos.x*0.5+0.5, 0.5 - aPos.y*0.5)` và trang đối chiếu lật `v` khi so.
  BÀI HỌC: đối chiếu công thức KHÔNG thay được chạy thật một lần trên ảnh thật.
  Sau khi sửa, đo lại trên khung thật: **4.8% pixel đổi** (khớp hộp bao mặt 6.7%) — hiệu
  ứng nằm gọn quanh mặt.

HIỆU NĂNG KHI PHÁT — LỖI THẬT KHÔNG PHẢI LỖI TỐC ĐỘ (đã sửa)

- BẢN CHẤT: trong lúc PHÁT, `resizeAndRender()` KHÔNG hề được gọi. Bộ lập lịch ở
  `perf-runtime.js` (cờ `perf_scheduler`) mỗi khung chỉ chạy `runJumpCutLogic`, còn
  ticker của PIXI chỉ làm mới `this.texture` — texture VIDEO THÔ. Mọi đường đi qua canvas
  trung gian (retouch, lớp Điều chỉnh, hiệu ứng không gian) đều dùng `fxTexture`, mà
  fxTexture chỉ được dựng lại trong `resizeAndRender` -> preview ĐỨNG HÌNH trong khi
  tiếng vẫn chạy. Đây mới là thứ người dùng gặp; "chậm" chỉ là chẩn đoán sai.
- SỬA: tách khối dựng texture thành `SequencePixiPreviewRenderer.syncSpriteTexture()` rồi
  cho ticker gọi mỗi khung, có cờ `spatialActive` để đường thường (không canvas trung
  gian) vẫn rẻ như cũ. Lúc DỪNG chỉ chạy thêm ĐÚNG MỘT lượt (cờ `fxPlayedLast`) — lượt
  đó vẽ ở lưới đầy đủ thay cho lưới thấp của lúc phát.

- SỐ ĐO TỪNG KHÂU (`tests/manual/retouch_perf.html`, nguồn 1728×3072, Chrome, GPU thật,
  lưới 256). Ghi chú cũ quy ~100 ms cho "raster + tầng mờ" là quy SAI khâu:

    | khâu | ms |
    |---|---|
    | raster mặt nạ (CPU) | 20.4 |
    | drawImage cắt vùng | 0.1 |
    | getImageData | 1.1 |
    | hai tầng mờ (CPU) | 19.6 |
    | upload texture | 1.1 |
    | shader | 0.2 |
    | **tổng** | **43.2** |

- BA PHÉP TỐI ƯU, theo thứ tự lời/rủi ro:
  1. `willReadFrequently: false` cho canvas nháp. Bật cờ đó biến canvas thành canvas
     PHẦN MỀM: `drawImage` từ video 1728×3072 tốn **11.4 ms** thay vì 0.1 ms, trong khi
     đọc ngược 256² chỉ tốn 0.9 ms. Đổi chác này lãi ~10 ms/khung. Chrome vẫn cảnh báo
     trên console — cảnh báo đó SAI với ca này, đừng "sửa".
  2. BỎ VIỆC KHÔNG AI ĐỌC, hai phép rút gọn CHÍNH XÁC (không phải xấp xỉ):
     · `requiredMasks(cfg)` — mặt nạ nào không tham số nào đọc thì không dựng. Người
       dùng thường chỉ kéo 2-3 thanh nên bỏ được 3-4 trong 5 mặt nạ.
     · `needsCoarse(cfg)` — `out = base + mid + hi = lc + (lf−lc) + hi`. Không tham số
       nào động vào `base`/`mid` thì `lc` TRIỆT TIÊU khỏi công thức; truyền `lc := lf`
       cho ra đúng cùng con số mà bỏ được lượt làm mờ bán kính lớn (lượt đắt nhất).
       Shader trỏ sampler `uLowCoarse` về đơn vị texture của tầng mịn.
     Cả hai được test đòi TRÙNG BIT (`retouch_regions.js`) và được đối chiếu đầu-cuối
     trên GPU ở phần 2 của `retouch_shader_parity.html`.
  3. LƯỚI THẤP KHI PHÁT (`RetouchRenderer.setGrid`, `FREQ_GRID_PLAYING = 128`). Lúc phát
     mặt đổi mỗi khung nên cache mặt nạ không đỡ được gì. Đo trên nguồn thật, lưới 128
     so với 256: lệch **trung bình 0.22/255**, 1.06% pixel lệch quá 2/255, lớn nhất
     9.95/255 và chỉ ở mép mặt nạ. Dừng lại là về 256; khâu XUẤT luôn dùng 256.
     NỖI LO CŨ ĐO RA LÀ KHÔNG CÓ: "hạ lưới thì khoét chân mày kém đi" — sai, vì bán kính
     làm mượt đã quy theo BỀ NGANG MẶT (`MASK_FEATHER_FRAC`) nên bất biến theo lưới; giá
     trị mặt nạ da giữa chân mày là 0.545 ở lưới 256 và 0.490 ở lưới 128.

- KẾT QUẢ (qua `RetouchRenderer`, tức đường app thật chạy):

    | | 13 thanh (xấu nhất) | 3 thanh (thường gặp) |
    |---|---|---|
    | nguồn 1728×3072, đang phát | 24.2 ms (41 fps) | 16.2 ms (62 fps) |
    | proxy 406×720, đang phát | 12.3 ms (81 fps) | 6.0 ms (167 fps) |

- MỘT BỘ RENDER CHO MỖI BLOCK (`retouchRendererPool`, trần 4). `draw()` trả về CHÍNH
  canvas của nó, nên dùng chung một bộ cho lane chính và media overlay thì trong cùng
  một khung lane chính sẽ hiện khuôn mặt của overlay, và cache mặt nạ hai bên đập nhau.

EXPORT (GĐ5) — VÁ VÙNG MẶT, KHÔNG BAKE CẢ KHUNG

- KHÔNG cài lại retouch trong C++ sidecar. Bake ở frontend, đi qua ĐÚNG hàm mà preview
  gọi (`retouchedDrawable`) -> WYSIWYG không do đối chiếu mà do dùng chung một đoạn mã.
- NGÂN SÁCH (`tests/manual/retouch_export_budget.html`): vùng mặt = 6.7% diện tích khung
  -> JPEG95 **42 KB/khung** ở 1080×1920, tức ~74 MB cho mỗi phút có retouch. Bake cả
  khung là 0.41 MB/khung = 738 MB/phút, gấp 10 lần.
- BẮT KHUNG BẰNG SEEK TIẾN DẦN (`eachSourceFrame`), không bằng phát rồi hứng. Ghi chú cũ
  của bake chuyển cảnh nói seek ~1 s/khung — đó là seek NHẢY XA; seek tiến dần 1/30 s một
  chỉ **20 ms/khung**, lại cho mốc thời gian chính xác khớp lưới khung xuất.
  · Chốt NGAY ở sự kiện `seeked`. KHÔNG dùng `requestVideoFrameCallback` (video đang DỪNG
    và thẻ ẩn 1px thì Chrome có thể không bao giờ "trình bày" khung mới -> rVFC không bắn;
    đo được 24 khung mất hơn 90 giây) và KHÔNG dùng `setTimeout` (Chrome bóp còn 1 lần/
    giây khi cửa sổ ở nền — mà xuất video là đúng lúc người ta chuyển cửa sổ đi chỗ khác).
    `retouch_export_loop.html` canh điều này bằng cách đòi các khung liên tiếp phải KHÁC
    nhau và không khung nào trống.
- HỘP VÁ = HỢP QUA MỌI KHUNG của block (miếng vá đứng yên, mặt thì di chuyển), tính từ
  `Retouch.touchedBounds` — hộp này gồm CẢ bán kính ảnh hưởng của biến dạng, không chỉ
  hộp mặt nạ, vì bán kính warp (0.50/0.44 lần cỡ mặt) vươn ra ngoài hộp mặt nạ. Cắt theo
  hộp mặt nạ là cụt đúng mép hàm. `retouch_export_pipeline.js` chạy trọn chuỗi tham chiếu
  CPU rồi đòi MỌI pixel bị đổi phải nằm trong hộp.
- ĐẶT MIẾNG VÁ: `layerPlacement` được tách ra khỏi `blitLayer` để phép đặt lớp chỉ có MỘT
  bản cài đặt, dùng cho cả việc vẽ lẫn việc tính hình chữ nhật cắt. Cạnh ép CHẴN vì
  sidecar chạy `scale=ceil(iw/2)*2`.
- CHỈNH MÀU CHO MIẾNG VÁ do CHÍNH sidecar làm, không bake ở frontend: miếng vá là một
  MẢNH của khung nên phải chịu đúng bộ lọc ffmpeg đang chạy trên phần khung quanh nó
  (chênh lệch giữa hai đường đo được 9-12.6/255 — bake ở frontend là hiện một hình chữ
  nhật quanh mặt). Item mang cờ `animation_render.color_source = 'raw'`; backend mở cổng
  `adjFields` cho đúng cờ này, còn chuỗi khung CHUYỂN CẢNH (đã bake sẵn màu) vẫn bị chặn
  như cũ để không chỉnh màu hai lần.
- CÓ HIỆU ỨNG KHÔNG GIAN (vignette / hạt / nét / mờ) -> BAKE CẢ KHUNG, màu bake luôn vào
  khung (`retouchExportNeedsFullFrame`, soi cả keyframe màu lẫn lớp Điều chỉnh phủ lên).
  Vignette tính theo VỊ TRÍ TRONG KHUNG và hạt là ngẫu nhiên, nên áp cùng bộ lọc lên một
  miếng vá nhỏ KHÔNG ra cùng kết quả với phần xung quanh. Đắt hơn 10 lần nhưng chỉ rơi
  vào đúng ca này. Mặt chiếm quá `RETOUCH_PATCH_MAX_AREA` (45%) cũng đi đường này.
- Item chèn TRƯỚC hai khối chuyển cảnh (overlay vẽ theo thứ tự mảng): trong vùng chuyển
  cảnh thì khung tổng hợp của chuyển cảnh mới đúng, nó phải nằm TRÊN miếng vá.
- KHÔNG có `collectFile` thì KHÔNG bake: chuỗi khung retouch phủ trọn block (1800 khung
  cho 60s), nhét vào JSON dạng data URL là vượt trần chuỗi của V8 ngay.

MEDIA OVERLAY

- `/api/retouch/track` nhận `source_path` để bám mặt trên CHÍNH file asset. Chuỗi đó đến
  từ request rồi đi thẳng cho sidecar mở, nên `resolveRetouchSource` BẮT BUỘC kiểm: phải
  nằm trong `TEMP_DIR`/`LIBRARY_DIR` (so sau `realpathSync` nên `..` và symlink không
  lách được) và phải là file video có đuôi được phép. Có test đòi 400 cho `/etc/passwd`,
  `../../..`, và cả file trong dự án nhưng không phải video.
- Khoá cache đĩa của backend nay gồm CẢ đường dẫn (`v: 2`): từ khi nguồn không còn chỉ là
  `temp_input.mp4`, hai file khác nhau có thể trùng size+mtime.
- Overlay bám mặt theo trục thời gian của ASSET (`source_start`), không phải trục
  sequence — `retouchTrackRequest` lo phép quy đổi đó.

ẢNH TĨNH OVERLAY (2026-08-07) — MỘT KHUNG LANDMARK, KẸP CHỈ SỐ VỀ 0

- Sidecar rẽ nhánh theo ĐUÔI FILE (`is_still_image_source`), không theo cờ trong payload:
  thêm một cờ là thêm một chỗ để backend và sidecar nói khác nhau. `track_retouch_still`
  đọc một khung qua ffmpeg (`read_still_rgb`, cùng phép `scale` với FrameStream) rồi trả
  ĐÚNG hình dạng kết quả của đường video (`fps`/`frame_count`/`frames`) kèm cờ `still`.
- BỘ DÒ RIÊNG, `static_image_mode=True` (`ensure_face_mesh_still`). KHÔNG dùng lại
  `_face_mesh_multi`: instance đó chạy chế độ VIDEO và THEO VẾT giữa các lần gọi — đưa
  một ảnh rời vào vừa dò kém (không có vết để bám) vừa làm BẨN trạng thái theo vết của
  clip video xử lý cùng lượt. Ảnh tĩnh chỉ có một lần dò duy nhất nên phải dò đầy đủ.
- KHÔNG làm mượt: `smooth_face_series` là phép theo THỜI GIAN, một khung thì không có gì
  để trung bình.
- ĐO ĐƯỢC (khung 38.5s của footage dự án, tách ra thành PNG rồi so với chính khung đó đi
  đường video): lệch **trung bình 0.42 px, lớn nhất 1.67 px** trên bề rộng 1728 — hai
  đường cho cùng một khuôn mặt. Ảnh không có mặt -> `frames[0] = null` (KHÔNG phải mảng
  rỗng: frontend đọc null là "khung này không retouch", mảng rỗng thì lọt qua mọi guard).
- `retouchFacesAt` kẹp chỉ số về 0 khi `store.still`. Quy đổi theo thời gian như đường
  video thì mọi mốc quá nửa khung đều rơi ra ngoài mảng -> retouch chỉ hiện ở đúng khung
  đầu của block rồi tắt.
- KHOÁ CACHE của ảnh KHÔNG gồm khoảng thời gian (`item:<asset>:still`), và frontend gửi
  một khoảng CỐ ĐỊNH [0,1] cho backend: landmark của ảnh không phụ thuộc chỗ cắt, mà
  khoảng thời gian lại nằm trong khoá cache đĩa — gửi khoảng thật là mỗi lần trim ảnh
  chạy lại MediaPipe cho đúng một khuôn mặt ấy.
- `resolveRetouchSource` nay nhận CẢ ảnh (`isSupportedRetouchSourceFile`), vẫn giữ nguyên
  ràng buộc thư mục: nới LOẠI FILE không được nới CHỖ. Test đòi .mp3/.wav/.txt/.json/.svg
  bị từ chối, và ảnh nằm ngoài TEMP_DIR/LIBRARY_DIR cũng bị từ chối.
- XUẤT: ảnh chạy retouch ĐÚNG MỘT LẦN (`retouchedStillCanvas`) rồi dùng lại cho mọi khung.
  · Có hoạt ảnh -> `renderImageAnimationSequence` nhận ảnh đã retouch làm nguồn (retouch
    TRƯỚC chuỗi màu, cùng thứ tự với preview), màu vẫn bake vào từng khung như cũ.
  · Không hoạt ảnh -> `bakeRetouchedStillSeq` đẩy 2 khung PNG kèm `color_source:'raw'`;
    `eof_action=repeat` của sidecar giữ khung cuối suốt block, còn chuỗi màu do sidecar áp
    y như với file ảnh gốc. 2 khung là tối thiểu mà `materializeAnimationFrameFiles` nhận.
    PNG chứ không JPEG: ảnh overlay có kênh alpha.
  · Cổng màu ở `exportPayload` vì thế phải xét `!animation_render || color_source==='raw'`
    — CÙNG điều kiện với `seqWantsColor` của backend. Lệch nhau là ảnh mất chỉnh màu hoặc
    bị chỉnh hai lần.
  · CHỜ landmark TRƯỚC khi vẽ, bằng `awaitRetouchFaces` chứ KHÔNG phải
    `ensureRetouchFaces`. Hàm sau trả null NGAY khi đang có một lượt nạp (`pending`) —
    đúng cho preview (khung sau có landmark là tự đẹp) nhưng ở khâu xuất thì không có
    "khung sau": bật retouch rồi bấm Xuất luôn là bản xuất mất retouch. `awaitRetouchFaces`
    chờ có hạn rồi trả null, và caller phải NÓI RA (`setEditingStatusText`) chứ không lặng
    lẽ bỏ qua. Lane chính cũng đã chuyển sang dùng nó.
    Cũng phải nói ra khi `retouchedDrawable` trả lại CHÍNH ảnh vào (không thấy mặt / không
    có WebGL): nó cố ý không báo lỗi để preview khỏi nháy khung đen, nên chỗ duy nhất biết
    "người dùng bật mà không ra gì" là caller.
  · CHỤP LẠI kết quả sang canvas riêng: `retouchedDrawable` trả về CHÍNH canvas của bộ
    render trong pool (trần 4, thu hồi cái cũ nhất), và `bakeCanvas` cũng dùng chung theo
    vai trò — giữ nguyên tham chiếu là bake block sau đổi ảnh dưới chân mình.
- TEST: `npm run test:retouch-still` (hình dạng kết quả của sidecar cho PNG/JPEG, ảnh
  không mặt -> null, và video KHÔNG bị nhận nhầm là ảnh) + phần nguồn/cổng màu trong
  `npm run test:retouch-export`. Test still chạy được cả khi máy chưa cài MediaPipe.

OVERLAY VIDEO KHI XUẤT (2026-08-07) — VÁ VÙNG MẶT TRONG KHÔNG GIAN SEQUENCE

- `appendOverlayRetouchItems` / `bakeOverlayRetouchSequence`. Cùng ý tưởng với lane chính,
  nhưng phép đặt lớp lấy từ chính item (`overlayItemPlacement`), nên XOAY / keyframe /
  hoạt ảnh DỊCH CHUYỂN đều tự đúng: hộp vá được cắt SAU khi lớp đã vào đúng chỗ.
- MỘT PHÉP ĐẶT, DÙNG CHUNG. `overlayItemPlacement` giờ là nguồn duy nhất cho cả
  `drawTransitionLayer` (đường vẽ) lẫn khâu bake (đường tính hộp); `mainClipPlacement`
  tương tự cho lane chính; `blitLayerAt` là bản cài đặt duy nhất của
  translate→rotate→scale. Trước đó mỗi chỗ tự dựng lại chuỗi transform — miếng vá sẽ lệch
  ngay lần đầu ai đó sửa một trong hai chỗ.
- VÌ SAO KHÔNG thay hẳn video của item bằng chuỗi khung đã retouch (nghe gọn hơn nhiều):
  item video còn mang TIẾNG. Đổi `asset_type` sang `image_seq` là input không còn luồng
  audio, `OverlayHasAudio` thành false và tiếng của overlay biến mất. Miếng vá để nguyên
  item gốc nên không đụng tới tiếng.
- PNG CHỨ KHÔNG JPEG (khác lane chính). Lane chính vá lên khung ĐỤC nên JPEG đủ. Miếng vá
  overlay nằm TRÊN nền: chỗ nào ra ngoài hình lớp (hộp cắt thẳng trục, lớp thì có thể
  xoay) phải TRONG SUỐT — JPEG là ra viền đen quanh mặt.
- Z-ORDER: miếng vá lấy CÙNG `track_id` với item gốc và được đẩy vào CUỐI mảng item.
  Backend sắp overlay theo `track_order` rồi `index`, nên nó nằm ngay TRÊN item của mình
  và vẫn DƯỚI mọi track ở trên. Có test đòi đúng thứ tự này (`testOverlayPatchStacking`) —
  đây là hệ quả của phép SẮP XẾP ở backend nên phải kiểm, không đọc mã frontend rồi tin.
- BA CA TỰ Ý BỎ QUA, tất cả đều BÁO ra `setEditingStatusText` (im lặng bỏ qua là đúng cái
  bẫy mà cả tính năng này sinh ra để tránh):
  1. Hiệu ứng KHÔNG GIAN trên item hoặc trên lớp Điều chỉnh phủ lên nó — cùng lý do với
     lane chính.
  2. Vùng mặt quá lớn (`RETOUCH_PATCH_MAX_AREA`) hoặc không thấy mặt nào.
  3. Vừa có KEYFRAME MÀU vừa có đoạn mờ dần (xem ngay dưới).
- NHỮNG KHUNG LỚP KHÔNG ĐỤC HOÀN TOÀN thì KHÔNG vá được, và không có cách chữa: miếng vá
  vẽ ĐÈ LÊN item gốc, nên khi lớp trong suốt một phần thì mặt CHƯA retouch ở dưới lộ qua
  và trộn hai lần — đúng phải là nền(1−α) + vá·α, thực tế ra nền(1−α)² + gốc·α(1−α) + vá·α,
  sai lớn nhất ở α = 0.5. Miếng vá không biết NỀN phía dưới là gì nên không tự bù được.
  KHÔNG bỏ cả item vì chuyện này (hoạt ảnh In/Out là thứ dùng thường xuyên, phần mờ dần
  chỉ ở hai đầu): vá cho DẢI ĐỤC DÀI NHẤT rồi thu cửa sổ `enable` về đúng dải đó, và GHI
  RA số khung bị bỏ. Nhưng nếu item CÓ keyframe màu thì phải bỏ hẳn: miếng vá bắt đầu muộn
  hơn item, mà sidecar tính `LOCALT` của chuỗi màu theo mốc của CHÍNH overlay mang nó, nên
  keyframe màu sẽ chạy lệch đúng bằng khoảng trễ — payload không có chỗ khai lệch mốc.
  Cùng lý do đó, `colorAdjustExportSpec`/`adjustLayerExportSpec` của miếng vá phải khai
  theo CỬA SỔ CỦA MIẾNG VÁ (`runStart`/`runDur`), không phải cửa sổ của item.
- HỢP ĐỒNG ĐẶT LỚP với sidecar đã khoá bằng test chạy FFmpeg thật
  (`npm run test:overlay-placement`): cỡ lớp = cỡ asset × scale%, tâm = giữa khung +
  position, xoay quanh TÂM lớp (tâm không đổi, hộp bao nở ra), và
  `position_x = rect.x − (W_seq − w)/2` đặt miếng vá đúng từng pixel. Test viết THẲNG công
  thức mong đợi chứ không gọi lại mã frontend — chỗ cần khoá là RANH GIỚI giữa hai bên,
  gọi lại hàm của frontend thì hai bên cùng sai vẫn xanh.
- `paintColorFxCanvas` chạy retouch TRƯỚC chuỗi màu, cùng thứ tự với lane chính và với
  khâu xuất. `itemHasColorAdjust` nay trả true khi block có retouch, vì kết quả retouch
  là canvas mà thẻ `<video>`/`<img>` không nhận được.

VIỆC NHỎ

- NÚT "GIỮ ĐỂ SO SÁNH" (`#editingRtCompare`): giữ thì `retouchedDrawable` trả ảnh gốc.
  Cờ `retouchCompareOff` đặt ở ĐẦU hàm nên tắt retouch ở mọi đường vẽ bằng một chỗ, và
  KHÔNG đụng vào `clip.retouch` (sửa dữ liệu để xem thử là rơi vào undo/redo và vào
  .crab). Nhả cờ ở cả `pointerup`, `pointercancel` lẫn `blur`.
- `resetRetouchCaches()` gọi trong `performProjectLoad`: khoá của `retouchFaceCache` chỉ
  gồm [start, end], nên mở dự án KHÁC mà không dọn thì khoá trùng lại trỏ vào video khác
  -> mặt nạ dán sai chỗ, không có lỗi nào báo. "Dự án mới" tải lại cả trang nên tự sạch.

LƯỢT XUẤT THẬT ĐẦU TIÊN (2026-08-06) — lỗi nó phát hiện KHÔNG nằm trong retouch
- Bản xuất hiện một HÌNH CHỮ NHẬT lệch khung quanh mặt, đúng 1 khung ở cuối một block.
  Nguyên nhân là LƯỚI KHUNG HÌNH của timeline lệch giữa frontend và sidecar, không phải
  lỗi của chuỗi retouch: miếng vá của block N+1 bị dán lên khung cuối block N.
  → [chi tiết + 3 cái bẫy khi sửa](#lưới-khung-hình-của-timeline-khi-export-đã-sửa-2026-08-06)
- Phần retouch tự nó đúng: mọi khung còn lại của mọi block đều khớp mép, không lộ miếng vá.

CÒN LẠI:
  - Ảnh tĩnh overlay chưa bám mặt được.
  - Nếu muốn nhanh hơn nữa: đưa raster mặt nạ + hai tầng mờ lên GPU (bỏ được ~40 ms/khung
    ở lưới 256), phải thêm shader tích chập và đối chiếu lại với `blurRgbBoxCascade`.
```

### Ghi Chú Kịch Bản (/*...*/) Và Bôi Đậm Trên Panel Đối Chiếu

```text
- ĐỊNH DẠNG .md MỚI (người dùng chốt): mỗi câu thoại có thể kèm GHI CHÚ dạng chú thích /*Ghi chú*/
  NẰM CÙNG DÒNG với câu thoại tương ứng (vd `**...ốm.** /*CÂU HOOK (cắt trong vid)*/`).
- Parser `normalizeMarkdownScript` (static/js/script-markdown.js) kiểm /*...*/ TRƯỚC dấu * (đóng ở
  '*/' đầu tiên; nếu thiếu '*/' -> coi là văn bản thường, không nuốt phần còn lại). Ghi chú BỊ BỎ khỏi
  clean_text nên phân đoạn/so khớp kịch bản chạy như cũ. Vẫn hỗ trợ ghi chú cũ ***...*** để tương thích.
- GHI NHỚ VỊ TRÍ THẬT của mỗi ghi chú vào `metadata.notes[]`: `text`, `raw_start/raw_end` (offset trong
  raw), `line/column` (dòng câu thoại tương ứng), `clean_insert_offset` (vị trí trong clean_text). Notes
  đi theo script_metadata -> lưu vào dữ liệu nội bộ (project .crab + projectMetrics.transcribe.script_metadata,
  backend cleanScriptMarkerItem/parseScriptMetadata), KHÔNG hiển thị lên UI — dành cho tính năng tương lai.
- BÔI ĐẬM panel đối chiếu: panel "Kịch bản chuẩn (Đối chiếu)" `#refScriptCompare` (dùng chung Match Script
  step2 + Timeline step3) tô các cụm `bold_ranges[].text` thành ĐẬM + VÀNG (class `.script-bold`, #f5c518).
  `renderReferenceScriptViewer` gọi `collectScriptBoldPhrases()` (ưu tiên cụm dài) + `appendScriptPieceWithBold()`
  khớp CHUỖI trong từng piece (bền với sửa tay/stale, khớp được cả cụm bold cắt giữa từ như `n`+**guồn...**).
```

### Bảng Cài Đặt Ứng Dụng (2026-08-14)

```text
- Mục tiêu: một chỗ duy nhất để người dùng đổi tham số của app, mở bằng Menu → "Cài đặt…" (hoặc ⌘, / Ctrl+,). Dựng KHUNG NHIỀU MỤC ngay từ đầu (cột nav trái: Chung · Auto Sound Effects · Xuất video); lần này chỉ mục ASE có nội dung, hai mục kia hiện nhưng disabled để sẵn chỗ.
- Vì sao có: quy ước ghép tiếng của auto_sfx.txt là thứ người dùng muốn tự đổi (thêm file SFXs mới, tách nhóm, đổi ngưỡng thời lượng). Đóng cứng trong code thì mỗi lần đổi phải sửa mã.
- LƯU TRỮ: `settings/app_settings.json` ở GỐC dự án (không phải dữ liệu runtime như temp_uploads/peaks_cache — đặt ở đây để cấu hình đi theo thư mục dự án và sao lưu được). File chỉ sinh khi bấm Lưu lần đầu; xoá file = về mặc định.
  - `GET /api/settings` · `POST /api/settings` · `POST /api/settings/reset` (backend/server.js, cạnh /api/library).
  - Ghi NGUYÊN TỬ: writeFileSync('.tmp') -> renameSync. Mất điện giữa chừng thì file cũ còn nguyên, không sinh JSON cụt.
  - Đọc lỗi/hỏng/thiếu file -> rơi về mặc định, KHÔNG ném lỗi: cấu hình là thứ phụ, không được phép làm app không mở lên được.
- CHỐT CHẶN DUY NHẤT: `AppSettings.normalize()` trong static/js/app-settings.js (UMD), backend `require` thẳng file này — đúng cách server đang require audio-denoise.js / clip-speed.js. Frontend chuẩn hoá trước khi gửi, backend chuẩn hoá lại trước khi ghi, nên file trên đĩa không thể chứa cấu hình sai dù ai ghi vào nó.
  - Bất biến: idempotent (normalize∘normalize = normalize) và `DEFAULTS` phải là ĐIỂM BẤT ĐỘNG — nếu không, file ghi ra đĩa khác bản trong code và mọi so sánh khi gỡ lỗi thành vô nghĩa. Test canh cả hai.
  - Lọc id hiệu ứng/chuyển cảnh KHÔNG có trong engine (tra EFFECT_OPTIONS / TRANSITION_OPTIONS). Nâng cấp app mà engine đổi tên hiệu ứng thì cấu hình cũ chỉ mất đúng phần không hiểu được, không hỏng cả file.
  - Luật/dòng Element trỏ tới nhóm đã xoá thì TỰ RỤNG (nếu không, ASE tra ra nhóm ma). UI cũng xoá kèm khi xoá nhóm, để người dùng không thấy luật "tự biến mất" sau khi Lưu.
  - PHÂN BIỆT "chưa có khoá" (cấu hình cũ/rỗng -> lấy mặc định) với "mảng rỗng" (người dùng CỐ Ý xoá hết -> tôn trọng, ASE sẽ không điền gì). Nhầm chỗ này thì không ai tắt được một luật.
  - Nhóm hiệu ứng/chuyển cảnh RỖNG bị bỏ; nhóm SFXs được phép rỗng (vừa tạo, chưa chọn file) và lúc chạy ASE thì bỏ qua + báo ra.
- MỤC (2026-08-15): Chung · Phím tắt · Auto save · Xem trước · Auto Sound Effects · Bộ nhớ đệm · Xuất video (mục cuối còn để trống chỗ).
  - `general` {undoSteps, devMode, snapDefault} — `MAX_HISTORY` từ hằng số đổi thành hàm `maxHistory()` đọc lười, người dùng chỉnh giữa chừng là ăn ngay. `devMode` chuyển nguồn sự thật từ localStorage sang đây (localStorage giữ lại làm bản đệm để trạng thái đúng NGAY lúc khởi động, trước khi /api/settings kịp trả về); đồng bộ 2 chiều với mục toggle trong Menu, có cờ `fromSettings` chặn vòng lặp ghi ngược.
  - `preview` {defaultQuality, frameStep, transitionQuality} — `snapDefault` và `defaultQuality` CHỈ áp LẦN ĐẦU: đè liên tục thì người dùng tắt nút bắt dính xong lưu cài đặt là nó tự bật lại.
  - `autoSave` {enabled, intervalMin, keepVersions, warnOnExit} — xem mục Auto Save.
  - `shortcuts` — chỉ phần khác mặc định, xem mục Phím Tắt Đổi Được.
  - Bộ nhớ đệm: `GET /api/cache/usage` + `POST /api/cache/clear`. CHỈ `peaks_cache` và `asr_cache` dọn được (sinh lại được). `temp_uploads` CHỈ ĐỌC — đó là dữ liệu làm việc của dự án ĐANG MỞ (nguồn đã nhập, proxy, ảnh bake); dọn tay là giết dự án đang mở, và `/api/reset-project` đã lo việc đó đúng lúc rồi. Dùng `humanBytes` chứ không `formatBytes`: hàm cũ chỉ hiển thị từ GB (dành cho video nguồn) nên cache 17 MB hiện ra "0.0 GB".
- SCHEMA `autoSfx`: animGroups[{id,name,effects[]}] · transGroups[{id,name,transitions[]}] · sfxGroups[{id,name,files[],align,fit}] · musicFiles[] · elementRules[{assetName,sfxGroup}] · rules[{source:{kind,group},sfxGroup,threshold:{maxDuration,elseSfxGroup}|null}] · levels{sfxDb,musicDb,musicFadeToDb,musicFadeSec,animLeadSec}.
  - `align` ('peak'|'start') và `fit` ('full'|'toEffect') nằm trên NHÓM SFXs — đây là cách tổng quát hoá đặc lệ của nhóm 6 (tiếng gõ phím chạy suốt hiệu ứng Đánh máy thay vì một cú nhấn tại một mốc). Nhờ vậy nhóm người dùng tự tạo cũng chọn được kiểu canh.
  - `threshold` chỉ có ở luật cần đổi nhóm theo độ dài (mặc định: nhóm hiệu ứng động 1, ≤ 0.8s -> whoosh nhanh, > 0.8s -> whoosh dài).
- UI (static/js/settings-panel.js — tách khỏi index.html vì file đó đã ~9.8k dòng; index.html chỉ giữ VỎ modal + mở/đóng):
  - Sửa trên BẢN NHÁP (bản sao sâu trong bộ nhớ); bấm Lưu mới gọi AppSettings.save(). Huỷ/đóng thì vứt bản nháp — nghịch thoải mái không sợ hỏng cấu hình đang chạy.
  - Một hiệu ứng chỉ được thuộc MỘT nhóm: nằm ở 2 nhóm thì tra luật ra 2 kết quả tuỳ thứ tự duyệt. Chặn ngay ở chỗ chọn (ô select chỉ liệt kê hiệu ứng chưa dùng).
  - File trong cấu hình mà không còn trên đĩa được tô ĐỎ + gạch ngang ngay tại chỗ, thay vì im lặng bỏ qua rồi để người dùng thắc mắc sao thiếu tiếng.
  - Ô tên nhóm: handler trả false để KHÔNG render lại — render lại sẽ cướp con trỏ đang gõ.
- KHÔNG vào undo/redo và KHÔNG lưu trong .crab: đây là cài đặt ứng dụng, không phải trạng thái dự án. Đổi cấu hình cũng KHÔNG hồi tố lên các block ASE đã điền — chỉ áp cho lần chạy sau (câu này in đậm ngay đầu pane).
- Test: `npm run test:app-settings` (tests/scripts/app_settings.js) — canh cả bất biến normalize lẫn việc mọi id/file trong DEFAULTS còn TỒN TẠI THẬT trong engine và trong library/ (chuông báo khi ai đó đổi tên/xoá file).
```

### Phím Tắt Đổi Được (2026-08-15)

```text
- Mục tiêu: người dùng tự đổi phím tắt như Premiere, và có MỘT chỗ tra cứu đủ mọi phím.
- HIỆN TRẠNG TRƯỚC KHI SỬA: không có registry, không có keymap; phím so bằng chuỗi cứng
  (`if (e.code === 'KeyS')`) rải trong 2 bộ điều phối + 8 listener rời. 8 trong 23 phím
  không hiển thị ở đâu cả. Nhãn phím là chuỗi chép tay ở 8 chỗ UI.
- static/js/shortcuts.js (UMD, thuần) là NGUỒN SỰ THẬT DUY NHẤT:
    COMMANDS      13 lệnh đổi được, mỗi lệnh {id, group, label, combo, allowInInput}
    CONTEXT_KEYS  ~12 phím NGỮ CẢNH chỉ để liệt kê, KHÔNG đổi được
    comboFromEvent / normalizeCombo / formatCombo / resolve / conflictsOf / syncLabels
- Dùng `event.code` (PHÍM VẬT LÝ) chứ không `event.key`: giữ đúng hành vi mã cũ, và `key`
  đổi theo bố cục bàn phím lẫn theo Shift ('s' -> 'S') nên keymap lưu bằng `key` sẽ hỏng khi
  người dùng đổi bố cục. Premiere cũng gán theo vị trí phím.
- 'Cmd' GỘP metaKey lẫn ctrlKey: toàn bộ mã cũ so `e.ctrlKey || e.metaKey`, nên một tổ hợp
  'Cmd+KeyS' chạy bằng ⌘S trên Mac và Ctrl+S trên Windows — không phải khai hai lần.
- Thứ tự bổ trợ CHỐT theo MOD_ORDER: nếu không, 'Shift+Cmd+KeyS' và 'Cmd+Shift+KeyS' thành
  hai tổ hợp khác nhau -> dò trùng sai và so với comboFromEvent cũng sai.
- Mã phím phải QUA `isValidKeyCode`: file cài đặt hỏng có thể chứa chuỗi bất kỳ, mà binding
  không bao giờ khớp `event.code` thì im lặng vô hiệu — người dùng thấy phím trong bảng
  nhưng bấm không ăn.
- LƯU: chỉ phần KHÁC mặc định (`keymapOverrides`). Bản sau đổi phím mặc định của một lệnh
  thì người chưa gán tay nhận phím mới, không kẹt ở phím cũ. `''` = CỐ Ý bỏ trống, khác hẳn
  "thiếu khoá" -> phải phân biệt, nếu không thì không ai gỡ được phím của một lệnh.
- NỐI VÀO 2 BỘ ĐIỀU PHỐI, KHÔNG đổi cấu trúc: chỉ thay phần SO KHỚP bằng `Shortcuts.resolve`
  rồi switch theo id. Thứ tự và chỗ đặt preventDefault giữ nguyên từng dòng.
    index.html          window, BUBBLE  -> chạy SAU
    editing-runtime.js  window, CAPTURE -> chạy TRƯỚC
  Thứ tự này KHÔNG được đảo: nhánh Xoá của editing-runtime phải giành được phím trước khi
  lane chính xử lý (nó `stopPropagation` khi xoá được).
- Nhân tiện sửa 2 lỗi cũ ở đúng chỗ đụng tới:
    (1) guard "đang gõ chữ" bị chép ở 2 nơi, bản index.html thiếu `?.` -> TypeError khi
        `document.activeElement` là null. Nay một `Shortcuts.isTypingTarget`.
    (2) nhánh Delete ở index.html `return` VÔ ĐIỀU KIỆN -> nhấn Backspace lúc không chọn gì
        cũng nuốt luôn Space/mũi tên của cùng lượt nhấn. Nay chỉ nuốt khi xoá được thật.
- NHÃN TỰ SINH: 8 phần tử UI mang `data-shortcut-cmd`; `Shortcuts.syncLabels()` ghi lại
  `.app-menu-shortcut` / `title` từ keymap, gọi lúc khởi động và mỗi lần lưu cài đặt. Không
  làm vậy thì bảng Cài đặt nói một đằng, tooltip nói một nẻo.
- UI (mục "Phím tắt" trong bảng Cài đặt) dựng theo Premiere: hàng preset -> BÀN PHÍM TRỰC
  QUAN (ANSI-US, nút bổ trợ để xem từng LỚP, phím đã gán tô xanh, bấm phím thì lọc danh
  sách) -> ô tìm kiếm -> danh sách lệnh theo nhóm -> nhóm "Phím cố định" -> DẢI CẢNH BÁO
  XUNG ĐỘT ở đáy với nút "Gán đè"/"Huỷ".
- BẮT PHÍM nghe ở pha CAPTURE trên `document` và NUỐT sự kiện: nếu không, chính phím đang
  gán sẽ chạy lệnh của nó (gán Space là preview phát luôn, gán ⌘S là bật hộp thoại lưu).
  Esc huỷ; Delete/Backspace KHÔNG kèm bổ trợ = bỏ trống phím (kèm bổ trợ thì vẫn gán bình thường).
- VERIFY: bấm ô "Phát / Tạm dừng" -> gán J, không cảnh báo. Gán ⌘K cho "Hoàn tác" -> dải
  cảnh báo đúng tên «Dao cắt», 1 dòng tô đỏ; "Gán đè" -> Dao cắt về "chưa gán". Sau khi Lưu:
  resolve(KeyJ)=playback.togglePlay, resolve(Space)=null, resolve(⌘K)=edit.undo, tooltip nút
  Undo tự đổi thành "Hoàn tác (⌘K)".
- Test: `npm run test:shortcuts`. Đáng chú ý 3 ca chỉ test mới bắt được: mặc định không có
  tổ hợp TRÙNG; MỌI id lệnh đều xuất hiện trong mã 2 bộ điều phối (quên nối dây / gõ sai id
  thì phím hiện đủ trong bảng mà bấm không ăn); mọi `data-shortcut-cmd` trên UI trỏ tới lệnh có thật.
```

### Auto Save (2026-08-15)

```text
- Mục tiêu: không mất việc. Trước đây app KHÔNG có auto save, và đóng cửa sổ lúc còn thay
  đổi chưa lưu thì mất trắng, KHÔNG hỏi một câu (`beforeunload` chỉ dọn renderer,
  `before-quit` chỉ tắt backend sidecar).
- GHI BẢN SAO, KHÔNG ĐỤNG FILE GỐC (người dùng chốt). Sửa hỏng rồi thoát vẫn quay lại được.
    đã có file .crab -> <thư mục dự án>/CrabbyCut Auto-Save/<tên>_YYYYMMDD-HHmmss.crab
                        (lối Premiere: nằm cạnh dự án, đi theo khi copy thư mục)
    chưa từng Lưu    -> app.getPath('userData')/autosave/  (main.js trước đó chưa dùng
                        getPath ở đâu; sạch, không lọt vào git)
- Dấu thời gian dạng YYYYMMDD-HHmmss SẮP XẾP ĐƯỢC theo thứ tự chữ cái -> xoay vòng chỉ cần
  sort tên, không phải stat từng file.
- IPC `project-autosave` / `autosave-list` trong electron/main.js, DÙNG LẠI `writeCrabFile`
  (đã ghi nguyên tử tmp->rename, không mở hộp thoại khi được truyền targetPath).
- BẪY LỚN: `writeCrabFile` chạy gzip + SHA-256 ĐỒNG BỘ trên main process -> block toàn bộ UI
  vài chục–vài trăm ms. Nổ giữa lúc phát preview là giật hình (đúng thứ vừa đi sửa ở mục
  "Hiệu Năng Preview"). Nên tick BỎ QUA rồi thử lại sau 20s khi: chưa dirty · isStatusPolling
  (đúng cờ mà saveProject đã dùng) · đang phát preview · đang mở hộp thoại.
- setTimeout TỰ LÊN LỊCH (khuôn previewProxyPollTimer), KHÔNG setInterval: một lượt ghi lâu
  hơn chu kỳ sẽ làm các tick chồng lên nhau.
- CỐ Ý KHÔNG xoá `projectDirty` sau khi auto save: bản auto save là BẢN SAO, file dự án THẬT
  vẫn chưa có thay đổi đó. Xoá cờ là nói dối, và cảnh báo lúc thoát sẽ im lặng.
- CẢNH BÁO KHI THOÁT làm ở MAIN process, không dùng `beforeunload`: Electron không hiện hộp
  thoại của beforeunload, còn hộp thoại tự vẽ trong renderer thì không chặn được cửa sổ đang
  đóng. Luồng: `mainWindow.on('close')` -> preventDefault -> hỏi renderer còn dirty không ->
  `dialog.showMessageBox` Lưu/Không lưu/Huỷ -> đóng. Cờ `forceClose` chặn đệ quy (close bên
  trong handler lại kích hoạt chính handler đó).
- `ipcMain.handle` chỉ đi CHIỀU renderer->main, nên chiều ngược lại tự dựng: main gửi kèm mã
  lượt hỏi, renderer trả lời qua kênh chung `renderer-reply`. Có timeout để renderer treo thì
  cửa sổ vẫn đóng được, không kẹt vĩnh viễn.
- Mở lại: Menu -> "Mở bản lưu tự động…" -> danh sách (thời gian + dung lượng) -> đi thẳng vào
  `openProjectByPath()` đã có sẵn.
```

### Auto Sound Effects (ASE) (2026-08-14)

```text
- Mục tiêu: tự điền tiếng động (SFXs) và nhạc nền theo quy ước ở auto_sfx.txt, thay cho việc đặt tay từng tiếng rồi canh sao cho đỉnh sóng rơi đúng frame.
- Kích hoạt: nút `#btnAutoSfx` (`<symbol id="ic-auto-sfx">` — loa + cung sóng + 2 tia lấp lánh, nối tiếp ngôn ngữ "sparkle" của Magic Fill) đặt NGAY CẠNH `#btnMagicFill` trong `.timeline-left-tools`.
  - KHÁC Magic Fill: KHÔNG cần kịch bản .md. Điều kiện duy nhất là `currentStepId === 'step4'` và `latestTimeline` không rỗng (ASE đọc hiệu ứng trên timeline, không đọc kịch bản).
  - BẪY: `syncAutoSfxAvailability()` KHÔNG được gọi lúc khởi tạo — `latestTimeline` là `let` khai báo BÊN DƯỚI trong cùng scope, đọc sớm là ReferenceError (TDZ) và chết cả đoạn script còn lại. Nút đã `disabled` sẵn trong markup; showStep() gọi lại mỗi lần đổi bước. Cùng cái bẫy đã ghi ở `devModeEnabled`.
- BA nguồn MỐC (`autoSfxCollectCues` trong editing-runtime.js):
  1. Điểm KẾT THÚC hiệu ứng VÀO của mỗi block — lane chính (mainClipSequenceSpans) lẫn overlay (text/media/shape). Hiệu ứng RA không xét.
  2. Điểm nối 2 block có hiệu ứng chuyển cảnh — transitionBoundaries() + getBoundaryTransition(), mốc = `junctionTime`.
  3. Block Element `[Icon] True.png` / `[Icon] Wrong.png` — luật riêng, ĐÈ luật hiệu ứng động (một icon Đúng/Sai chỉ nên có MỘT tiếng, không chồng thêm whoosh/pop). Icon không có hiệu ứng động thì mốc = lúc block XUẤT HIỆN.
  - Block không có hiệu ứng vào / mối nối không có chuyển cảnh -> BỎ QUA, đúng chữ auto_sfx.txt.
  - Độ dài hiệu ứng phải hỏi `TextAnimations.resolveWindows()` chứ KHÔNG đọc thẳng `animation.in.duration`: block ngắn hơn hiệu ứng thì engine CO cửa sổ lại, tiếng phải bám độ dài THẬT mới khớp hình (và nhánh ngưỡng 0.8s phải xét đúng con số đó).
- HAI MỐC THỜI GIAN cho mỗi cue, KHÔNG được lẫn (đã sửa 2026-08-15):
  - `atTime` = lúc CẦN NGHE THẤY tiếng (kết thúc hiệu ứng vào / điểm chuyển cảnh / lúc [Icon] hiện) — nhóm `align:'peak'` dùng cái này.
  - `blockStart` = lúc hiệu ứng BẮT ĐẦU — nhóm `align:'start'` dùng cái này.
  - `lead` = đẩy đỉnh sóng SỚM hơn `atTime` bấy nhiêu giây (`levels.animLeadSec`, mặc định 0.3s — chỉnh được ở bảng Cài đặt). Tai người nghe tiếng trước khi hình chốt lại thì thấy ăn khớp hơn là trùng khít. Chỉ áp cho HIỆU ỨNG ĐỘNG và [Icon]; mốc CHUYỂN CẢNH truyền 0 vì mốc ở đó LÀ điểm cắt, đẩy sớm là nghe rời khỏi hình. `placeSfx` cũng bỏ qua `lead` khi `align:'start'` (tiếng gõ phím phải trùng khít đầu hiệu ứng).
  - Bản đầu chỉ có `atTime`, nên tiếng gõ phím của hiệu ứng Đánh máy bị đặt tại điểm hiệu ứng KẾT THÚC, tức vào muộn đúng bằng độ dài hiệu ứng (đánh máy 1.6s -> tiếng vào ở 2.6s thay vì 1.0s). Test canh bằng cách gọi placeSfx cùng một bộ mốc với 2 kiểu canh và bắt hai kết quả phải khác nhau.
- MẤU CHỐT "đỉnh sóng rơi đúng mốc": SFX KHÔNG bắt đầu tại mốc mà bắt đầu TRƯỚC mốc đúng bằng khoảng cách từ đầu file tới đỉnh sóng của chính file đó.
  - `autoSfxPeakOffset()` = argmax trên dữ liệu peak `.pk` ĐÃ CÓ SẴN cho waveform (AudioWaveform.ensure + columns), không giải mã lại audio. Xin `min(8192, ceil(duration*750))` cột = độ phân giải gốc cho file ngắn.
  - BẪY: `columns()` trả buffer SCRATCH DÙNG LẠI giữa các lần gọi — chỉ được đọc ngay tại chỗ, tuyệt đối không giữ tham chiếu.
  - Peak sinh bất đồng bộ (POST /api/library/add đã prewarm); chờ tối đa 8s, quá thì canh theo ĐẦU file — thà lệch còn hơn bỏ hẳn tiếng, người dùng kéo lại được.
  - Tràn ra trước mốc 0 -> DỊCH CẢ BLOCK về 0, KHÔNG cắt đầu (chốt với người dùng: giữ trọn tiếng, chấp nhận đỉnh lệch muộn hơn).
- Đặt block: `type:'audio'`, `volume = dbToPercent(levels.sfxDb)`, cờ `auto_sfx:true` + `auto_sfx_kind` + `auto_sfx_group`. Lane RIÊNG tên "Auto SFX" (chồng lấn thì "Auto SFX 2", …) và "Auto Music" — dễ nhận ra, và để lần chạy sau xoá đúng phần của mình mà không đụng block audio người dùng tự thêm. Mọi block bị kẹp trong tổng độ dài lane main.
- Nhạc nền: 1 file `[Mus]` ngẫu nhiên, từ 0 tới hết lane main, `levels.musicDb`, nhỏ dần ở cuối bằng KEYFRAME ÂM LƯỢNG thật (xem mục dưới) — hiện marker trên block, sửa tay được, và đi thẳng vào bản xuất.
- Chạy lại: có block `auto_sfx` -> `window.confirm` (cách hỏi hiện hành của runtime): OK = xoá sạch block ASE cũ + lane rỗng rồi điền lại; Cancel = chỉ bù mốc chưa có tiếng.
  - "Bù thiếu" so bằng chính MỐC (`auto_sfx_at` ghi trên block) chứ KHÔNG bằng khoảng thời gian của block (đã sửa 2026-08-15). Block được đặt LÙI VỀ TRƯỚC mốc đúng bằng lead + khoảng cách tới đỉnh sóng, nên mốc thường rơi NGOÀI block: tiếng "pop" 0.21s cho mốc t kết thúc ở t−0.17. Hỏi "mốc có nằm trong block không" luôn ra KHÔNG -> lần chạy sau đặt thêm một bản y hệt chồng lên, nghe to gấp đôi. Đã thấy trong dự án thật (2 bản trùng tại 0.76s và 2.63s). Block cũ chưa có `auto_sfx_at` thì lùi về so chồng lấn khoảng thời gian.
- MỘT `recordHistory()` cho cả lượt, gọi SAU khi mọi việc bất đồng bộ (nạp asset, dò đỉnh sóng) đã xong — ghi history rồi mới await thì ảnh chụp không còn khớp trạng thái ngay trước khi sửa. Đo được: 1 lần Ctrl+Z trả lại đúng trạng thái trước lượt chạy.
- Logic thuần ở static/js/auto-sfx-assets.js; MỌI hàm nhận `cfg` làm tham số, file KHÔNG giữ bảng luật nào (bảng mặc định nằm ở app-settings.js). Test bơm một cfg tuỳ biến để chứng minh engine thật sự đọc cấu hình.
- BẪY tên file: auto_sfx.txt ghi đuôi ".mp3" thường, trên đĩa là ".MP3" HOA -> mọi so khớp rel_path phải hạ hoa thường (`AutoSfxAssets.relPathKey`).
- VERIFY (timeline 3 block 3s/4s/3s, hiệu ứng vào Trượt lên 0.5s + Trượt lên 1.2s + Pop, chuyển cảnh Quét trái và Toả tròn):
  - 5 SFX + 1 nhạc nền. Nhóm đúng: 0.5s -> g1, 1.2s -> g2, Pop -> g3, Quét trái -> g1, Toả tròn -> g2.
  - Đỉnh sóng khớp mốc: block bắt đầu 0.329 cho mốc 0.5 (peak 0.171), 2.772 cho mốc 3.0, 3.695 cho mốc 4.2, 6.495 cho mốc 7.0, 7.319 cho mốc 7.4.
  - Chồng lấn tự sang lane "Auto SFX 2". Nhạc 0→10s (đúng tổng lane main), −13 dB, keyframe [9.2s, −13 dB] → [10s, −25 dB].
  - Textbox bắt đầu 1.0s + hiệu ứng Đánh máy 1.6s -> `[SFXs] Typing-1` đặt tại 1.0s, dài 1.6s (đúng đầu và đúng độ dài hiệu ứng).
  - `animLeadSec` 0 -> 0.3: tiếng của hiệu ứng Pop dời 3.334 -> 3.034 (sớm đúng 0.3s), tiếng của chuyển cảnh giữ nguyên 2.829, tiếng chạm mốc 0 bị kẹp về 0 (dịch cả block, không cắt).
  - Chạy lần 2 (chọn điền lại): vẫn 6 block audio, không nhân đôi. Ctrl+Z một lần về đúng trạng thái sau lượt 1.
- Test: `npm run test:auto-sfx` (tests/scripts/auto_sfx_assets.js).
```

### Keyframe Âm Lượng (2026-08-14)

```text
- Mô hình: `obj.keyframes.volume = [{t, v, e}]` — t = giây CỤC BỘ từ đầu block, v = PHẦN TRĂM âm lượng (100 = 0 dB, khớp `item.volume` / `clip.audio_volume`). Nằm chung chỗ với keyframe transform nên undo/redo và .crab tự có, đúng quy ước "gắn dữ liệu tính năng mới thẳng lên object clip/item".
- BẪY QUAN TRỌNG NHẤT: cố tình KHÔNG thêm 'volume' vào `KEYFRAME_FIELDS`. `hasKeyframes()` đang là CỔNG BẬT đường render/bake TRANSFORM ở editing-runtime.js (1337, 7873, 9719, 11458) — thêm vào là block audio chỉ có keyframe âm lượng bị kéo qua đường transform vô nghĩa và tốn kém. Làm NAMESPACE SONG SONG, đúng cách hệ keyframe MÀU (khoá 'adj.*') đang làm. Test canh bất biến này.
- text-animations.js: `VOLUME_KEYFRAME_FIELD` · `hasVolumeKeyframes()` · `volumeAt(kf,t)` (dùng lại `evalKeyframeField`) · `volumeKeyframeFfmpegExpr()` (dùng lại `keyframeFieldFfmpegExpr`, CHIA 100 vì filter `volume` của FFmpeg nhận GAIN TUYẾN TÍNH).
- Inspector: cụm ◂ ◆ ▸ ở hàng Volume dùng đúng class + `data-kf-field="volume"` của `adjustSliderRow()`, nên dùng chung luôn handler click và hàm đồng bộ trạng thái. `toggleKeyframeForSelected` phải có cổng riêng cho 'volume' (nó không nằm trong KEYFRAME_FIELDS). `appendKeyframeMarkers` cũng phải nới cổng vào, nếu không block audio chỉ có keyframe âm lượng sẽ không hiện marker nào.
- Kéo thanh dB khi ĐÃ có keyframe = ghi KEYFRAME tại playhead, không đổi giá trị tĩnh (auto-keyframe, cùng lối `applyTransformToSelected`).
- Ô dB HIỂN THỊ giá trị HIỆU DỤNG tại playhead, không phải giá trị base (sửa 2026-08-15). Cùng LOẠI lỗi đã sửa cho transform (2026-07-19) và panel màu — lần này là thông số cuối cùng còn sót. Không sửa thì nhạc nền do ASE điền luôn hiện −13 dB kể cả khi playhead nằm giữa đoạn nhỏ dần về −25 dB, tức bảng thông số nói dối về thứ đang nghe.
  - `effectiveVolumePercent()` + `syncVolumeControlsAtPlayhead()`, móc vào `renderPreviewOverlays` — ĐÚNG chỗ mà transform đang móc, vì đó là điểm chạy chung của MỌI đường di chuyển playhead (phát 60fps, kéo/tua, timeupdate).
  - Đặt NGOÀI guard `hasInspectorTarget()` (clip lane chính không qua guard đó nhưng vẫn có hàng Volume), và bỏ qua khi con trỏ đang ở chính ô dB — nhánh volume của overlay KHÔNG bật `inspectorEditInProgress` mà `renderPreviewOverlays` lại chạy ngay trong lúc kéo.
  - Đo: nhạc 12s, keyframe [11.2s → −13 dB] → [12s → −25 dB]. Ô dB đọc được −13.0 tại 0s và 11.2s, −17.1 tại 11.6s (giữa đoạn, khớp nội suy ease-in-out), −25.0 tại 12s.
- Preview: `applyMediaElementAudio(el, item, localTime)` đọc lại đường cong mỗi khung. Hàm này VỐN ĐÃ bị gọi mỗi khung hình của vòng preview nên fade tự chạy — không cần lịch trình riêng hay ramp thủ công trên AudioParam. Hai chỗ gọi truyền thời gian cục bộ: `syncMediaElement` (overlay) và `syncMainPreviewVolume` (lane chính).
- Export: frontend ghép `keyframe_expr.volume_expr` -> backend `normalizeKeyframeExprFields` thêm `kf_volume_expr` (tự chảy tới cả lane chính lẫn overlay) -> sidecar `BuildVolumeFilter()` phát `volume='<expr>':eval=frame` thay hằng số, ở CẢ HAI chuỗi tiếng (WriteOverlayAudioFilter + chuỗi lane chính).
  - `eval=frame` là BẮT BUỘC: mặc định của filter volume là `eval=once`, tính đúng một lần lúc khởi tạo nên biểu thức sẽ đứng im ở giá trị t=0.
  - LOCALT quy về `t` với start = 0: chỗ phát nằm SAU `asetpts=PTS-STARTPTS` (và sau chuỗi atempo của Tốc độ) nhưng TRƯỚC `adelay`, nên `t` của luồng đúng bằng giờ cục bộ của block.
- VERIFY: biểu thức đánh giá bằng eval khớp `volumeAt()/100` với sai số < 1e-3 (sai số chỉ từ làm tròn 4 chữ số của bộ sinh, như mọi field khác). Render thật bằng ffmpeg với nhạc −13 → −25 dB trong 0.8s cuối: RMS đoạn đầu −34.07 dB, đoạn 0.1s cuối −45.99 dB — chênh 11.9 dB so với 12 dB đặt ra.
- Test: `npm run test:auto-sfx` (phần cuối file kiểm phần này).
```

### Magic Fill (Tự Động Tạo Textbox Từ Kịch Bản)

```text
- Mục tiêu: dựa vào kịch bản chuẩn .md người dùng nhập ở giai đoạn Upload, tự động (a) tạo text box cho từng cụm in đậm (**...**) và (b) đưa ảnh/video trong `library/` vào timeline theo TỪ KHOÁ = ghi chú `/*...*/`, tất cả đặt đúng vị trí thời gian và né mặt người trong video.
- Kích hoạt: nút icon cây đũa phép `#btnMagicFill` (`<symbol id="ic-magic-fill">`) nằm trong `.timeline-left-tools` của timeline toolbar.
  - Bật khi `currentScriptMetadata` có `bold_ranges` HOẶC `notes` (chỉ có ghi chú vẫn chạy được, chỉ là không sinh text box) VÀ đang ở giai đoạn Editing (`currentStepId === 'step4'`).
  - KHÔNG còn kích hoạt Auto-Reframe (2026-08-02): AR là việc của giai đoạn Timeline (nút "AR"). Magic Fill chỉ ĐỌC `clip.auto_reframe` đã có; chưa chạy AR thì phần né mặt rơi về mặc định (text neo cạnh TRÊN, đối tượng [Icon]/[Illus] xuống nửa DƯỚI).
  - `syncMagicFillAvailability()` trong index.html cập nhật trạng thái bật/tắt + tooltip; được gọi ở `setScriptMetadata`/`clearScriptMetadata`/`showStep`/khi sửa textarea kịch bản và lúc load.
- Nguồn dữ liệu:
  - Cụm in đậm + vị trí ký tự: `static/js/script-markdown.js` -> `currentScriptMetadata.bold_ranges[]` (`text`, `clean_start`, `clean_end`, `line`, `column`).
  - Thời gian trên video: `latestTimeline[]` (mỗi clip giữ `script_index`, `start`, `end`, `text`, `sub_segments[]` word-level) + `mainClipSequenceSpans()` cho vị trí trên timeline Editing.
  - Vị trí mặt: `latestTimeline[].auto_reframe` (face_center_x/y, face_height, source size) + `window.AutoReframeGeometry.pointScreenPosition()`.
- Logic chính nằm trong `static/js/editing-runtime.js` (`magicFill` export qua `window.EditingRuntime.magicFill`), đọc các global của index.html (có bảo vệ typeof).
- Quy trình `magicFill()`:
  1. Chạy SONG SONG hai việc: (a) đọc danh mục `library/` ĐỆ QUY (`magicLibraryIndex` -> `GET /api/library/all`); (b) bóc băng lại CHỈ phần audio đã dựng (`magicRetranscribeTimeline` -> `POST /api/magic-fill/transcribe-range`): backend dùng ffmpeg atrim+concat (filter script `magic_fill_audio_filter.txt`, output `magic_fill_audio.wav` 16kHz mono) tách đúng các khoảng clip theo thứ tự phát rồi chạy lại ASR word-level — timestamp trả về nằm trên trục audio đã nối = trục timeline Editing, frontend quy đổi ngược về "giờ nguồn" từng clip để tái dùng pipeline khớp. Kết quả cache trong `asr_cache/` theo key riêng (`kind: magic_fill_range`, gồm intervals làm tròn ms + stat video nguồn + engine/model/mode + SHA1 kịch bản). Bóc lại lỗi thì fallback êm về `sub_segments` của lần bóc băng gốc (status ghi rõ nguồn dữ liệu).
  2. Cụm CHỈ CÓ 1 TỪ: khớp kèm ngữ cảnh trước (`magicBoldContext` + `magicMatchSingleWordWithContext`) vì 1 từ bỏ dấu rất dễ trúng nhầm từ khác ("Đừng"/"Đúng" đều thành "dung"). Lấy từ liền trước + liền sau của cụm bold trong kịch bản chuẩn (theo `clean_start/clean_end`, offset lệch thì dò lại bằng indexOf), so bộ 3 từ với chuỗi từ ASR: khớp đủ cả 3 -> nhận ngay; chỉ khớp 1 trong 2 từ lân cận -> giữ làm ứng viên, quét toàn bộ xong không có chỗ nào đủ 3 mới dùng; không có cả 2 tầng -> rơi xuống pipeline khớp thường. Cùng tầng ưu tiên vị trí >= cursor rồi vị trí sớm nhất. Sau đó khớp word-level TUẦN TỰ theo thứ tự kịch bản (`magicBuildWordIndex` + `magicMatchPhraseAt`): dựng bảng từ toàn timeline theo thứ tự phát, mỗi cụm dò từ cursor (điểm kết thúc của cụm trước) trở đi, so từng từ ĐÚNG VỊ TRÍ trong cửa sổ (từ có mặt nhưng lệch vị trí chỉ tính 0.5) — nhờ vậy cụm lặp lại (vd "GOS") bám vào lần xuất hiện kế tiếp thay vì bị hút cả về lần đầu. Nếu điểm khớp ≥ `MAGIC_FILL_WORD_MATCH_MIN` (0.5) thì dùng đúng khoảng từ. Cụm KHÔNG khớp xử lý theo 2 tầng: (a) NỘI SUY — cụm nằm giữa 2 cụm đã khớp (theo thứ tự kịch bản) được đặt vào khoảng thời gian giữa 2 cụm đó trên timeline, chuỗi nhiều cụm liên tiếp không khớp được rải ĐỀU trong khoảng trống; (b) thiếu neo một phía (đầu/cuối kịch bản) mới fallback fuzzy: chọn clip theo `magicFindClip`, neo NỐI TIẾP trong clip (không đè cùng thời điểm), thời lượng ước lượng 1.2–4s theo số từ. Mọi cụm không khớp word-level đều gắn `magic_fill_review: true` trên item -> block trên timeline tô TÍM SỌC (class `is-magic-fill-review`) để người dùng rà lại vị trí bằng tay; status báo số cụm cần rà. Cụm trùng nội dung + trùng thời gian với cụm đã lên kế hoạch sẽ bị bỏ (chống nhân đôi box). Mọi box đều bị kẹp bởi trần `MAGIC_FILL_MAX_DUR` (6s) và sàn `MAGIC_FILL_MIN_DUR` (0.6s).
  3. Cỡ chữ đồng bộ: mỗi cụm tính cỡ lớn nhất sao cho gói ≤2 dòng trong bề rộng an toàn VÀ chiều cao box ≤ `MAGIC_FILL_MAX_BOX_H_RATIO` (24% Sequence); trần cỡ chữ = `min(MAGIC_FILL_MAX_FONT_CAP=90, seqH*MAGIC_FILL_MAX_FONT_RATIO=4.8%)`. Cỡ chung cả sequence = min các cỡ khít (đảm bảo ≤2 dòng, box vừa lưới, lệch ≤10%).
  4. Neo cạnh lưới an toàn (không thả nổi theo tâm mặt nữa): `magicChooseSide` dựa vào tỉ lệ vị trí mặt trên màn hình sau Auto-Reframe (`magicFaceScreenRatio`) — mặt nửa trên (ratio ≤ 0.45) -> neo **sát cạnh DƯỚI** lưới; mặt giữa/dưới hoặc không có dữ liệu mặt -> neo **sát cạnh TRÊN** lưới. Lưới an toàn dùng ĐÚNG `SAFE_ZONE_INSETS` của overlay hiển thị (top 10%, bottom 20%, left 6%, right 10% — fallback `MAGIC_FILL_SAFE_INSETS_FALLBACK` khi thiếu global); box căn giữa theo ô lưới (safeCenterX) và neo mép box (đã tính chiều cao box) vào cạnh lưới nên không lòi ra ngoài.
  5. Xếp chồng dọc chống đè: các box trùng thời gian cùng phía được đẩy vào trong (cạnh trên -> xuống dưới, cạnh dưới -> lên trên) cách nhau `MAGIC_FILL_STACK_GAP_RATIO` (1.5% seqH), thay vì cùng một `position_y`.
  6. ĐỐI TƯỢNG THƯ VIỆN THEO TỪ KHOÁ (2026-08-02) — xem khối riêng bên dưới.
  7. Báo cáo: status hiện "đã tạo N/M text box" kèm số cụm khớp yếu + số đối tượng thư viện đã thêm.
- Nội dung & style text box:
  - Nội dung = đúng chữ trong kịch bản chuẩn (`bold_ranges[].text`), KHÔNG dùng chữ ASR; luôn viết hoa chữ cái đầu của text box.
  - Style mặc định: chữ hồng `#FF2D92`, nền trắng opacity 100%, bo góc 12px, weight 700, căn giữa (`MAGIC_FILL_STYLE_PATCH`); `box_width` kẹp ≤ bề rộng an toàn.
  - Item gắn cờ `magic_fill: true`; xếp vào lane text tên `Magic Fill` (tạo thêm lane `Magic Fill N` khi chồng thời gian).
- Có `recordHistory()` nên toàn bộ thao tác Magic Fill có thể Undo/Redo (history có cả `editingAssets` nên asset thư viện vừa nạp cũng được hoàn tác); sau khi tạo, item là overlay bình thường, người dùng chỉnh tiếp như mọi item khác.
- Nguồn kịch bản chuẩn (`scriptCtxText`) lấy ô ĐẦU TIÊN có nội dung trong `refScriptReview` -> `refScriptInput`: panel đối chiếu rỗng ở vài luồng (mở .crab, vào thẳng Editing), nếu chỉ đọc nó thì mất sạch ngữ cảnh cụm 1 từ lẫn từ khoá đối tượng.
```

### Magic Fill — Đối Tượng Thư Viện Theo Từ Khoá (2026-08-02)

```text
- QUY ƯỚC ĐẶT TÊN FILE TRONG library/ (người dùng chốt 2026-08-02): `[Tiền tố] nội dung - số`
  - Tiền tố: `Vid` | `Icon` | `Illus` | `SFXs` | `Mus` — quyết định CÁCH ĐẶT, KHÔNG theo thư mục.
    `Vid` -> cover (phủ khung); `Icon`/`Illus` -> inset (né mặt); `SFXs`/`Mus` -> audio, không đặt.
  - Nội dung: nhiều TỪ KHOÁ ngăn nhau bằng dấu "," (mỗi cụm là 1 từ khoá, có thể gồm nhiều chữ).
  - Hậu tố "- số": tuỳ chọn, chỉ để phân biệt file trùng tiền tố + trùng nội dung. CHỈ cắt khi có
    dấu gạch, nếu không "[Icon] Omega 3" sẽ bị mất số 3.
  - Ví dụ: `[Icon] Lactoferrin`, `[Vid] Be khoe, be tuoi cuoi - 1`.
- HAI nguồn từ khoá đưa đối tượng library/ vào timeline:
  - (A) GHI CHÚ /*...*/ — nhiều từ khoá ngăn bằng "," HOẶC "/". Khớp bằng cách lấy TỪ KHOÁ TRONG
    TÊN FILE đi dò ghi chú (cả [Vid] lẫn [Icon]/[Illus]). Thời gian = DÒNG chứa ghi chú được nói.
  - (B) CỤM IN ĐẬM **...** — ngoài việc sinh text box, còn dò [Icon]/[Illus] khớp theo TỪ; thời
    gian = khoảng của chính cụm in đậm (trùng với text box của nó).
- NGOẠI LỆ CÂU HOOK: ghi chú ở DÒNG ĐẦU kịch bản (hoặc nội dung bắt đầu bằng "CÂU HOOK"/"HOOK")
  được gắn `isHook` -> KHÔNG đem đi so khớp, chỉ GHI NHỚ (`EditingRuntime.getMagicFillHook()`)
  để dành cho tính năng kế tiếp. Cụm in đậm nằm trên dòng hook vẫn chạy nhánh (B) bình thường.
- Logic THUẦN nằm ở static/js/magic-fill-assets.js (UMD, test bằng tests/scripts/magic_fill_assets.js,
  `npm run test:magic-fill-assets`); phần chạm state/DOM nằm ở editing-runtime.js
  (`magicPlaceLibraryObjects`, gọi ở bước (6) của `magicFill` — nhận `boldPlacements` lấy từ chính
  các text box đã lên kế hoạch: {content, tlStart, tlEnd, clipIndex}).
- Backend:
  - `GET /api/library/all` — quét ĐỆ QUY library/ (bỏ luts/ + file ẩn, sâu tối đa 6 cấp), trả
    {name, rel_path, folder, url, type}. Rẻ: không ffprobe.
  - `POST /api/library/add` nhận thêm dạng `{paths:[rel...]}` (đường dẫn tương đối trong library/,
    kể cả thư mục con) -> trả payload đầy đủ (width/height/duration/has_audio) + prewarm sóng âm.
    `resolveLibraryRelPath` chặn ../ thoát khỏi LIBRARY_DIR. Dạng cũ {category,name} giữ nguyên.
  - URL asset dựng theo ĐƯỜNG DẪN TƯƠNG ĐỐI (`publicLibraryUrlForRelPath`) nên file trong thư
    mục con vẫn trỏ đúng; payload có thêm `rel_path` để frontend nhận ra asset đã nạp.
- Chuẩn hoá tên file (`describeAssetName`): bỏ tiền tố [..], đuôi file, hậu tố "- số", bỏ dấu
  tiếng Việt -> {tag, kind, base, keywords:[{text,tokens}], tokens}. `keywords` tách theo dấu ",".
- LUẬT KHỚP DUY NHẤT (`keywordCoverage`, dùng chung cho ghi chú và cụm in đậm) — sửa 2026-08-03:
  - Độ khớp của MỘT từ khoá K với đoạn text T = (số chữ của K có trong T) / (SỐ CHỮ CỦA CHÍNH K).
    Chỉ cần MỘT từ khoá của tên file đạt > 50% là cả file được coi là khớp — các từ khoá được so
    LẦN LƯỢT và ĐỘC LẬP (`bestKeywordMatch`).
  - MẪU SỐ LÀ ĐỘ DÀI TỪ KHOÁ, không phải số từ khoá của file. Bản đầu lấy nhầm mẫu số là "số từ
    khoá của file" nên `[Vid] Be om, be gay` chỉ được 1/2 = 50% với ghi chú `/*bé ốm/ ho/ khóc*/`
    và bị loại oan (lỗi thật người dùng gặp 2026-08-03).
  - Ví dụ chuẩn: "Be om" trong "bé ốm/ ho/ khóc" = 2/2 = 100% -> khớp;
    "Giam phat trien chieu cao" trong "…phát triển chiều cao…" = 4/5 = 80% -> khớp;
    cùng từ khoá đó trong "giảm số ngày ốm" = 1/5 = 20% -> KHÔNG khớp.
  - Ngưỡng `NOTE_MATCH_MIN_RATIO` = 0.5 và so bằng "> 0.5" (đúng chữ "trên 50%").
- Ghi chú (`matchNoteAssets`): mỗi ghi chú giữ TỐI ĐA 1 [Vid] + 1 [Icon]/[Illus] (nhiều đối tượng
  cùng loại, cùng thời điểm sẽ che nhau). Nhiều file cùng đạt tỉ lệ CAO NHẤT -> bốc NGẪU NHIÊN
  (`pickBestRandom`, chèn hàm random qua `options.random` để test tất định) — đây là cách các biến
  thể "- 1"/"- 2" luân phiên; file khớp 100% không bao giờ thua file khớp thấp hơn.
- Cụm in đậm — ĐỔI HẲN 2026-09-15, sửa tiếp 2026-09-16. Dùng CHUNG luật khớp trên
  (`matchBoldAsset` = luật đó + lọc theo tiền tố). Hai bước:
  - **BƯỚC 0 — GỘP CỤM LIỀN KỀ (`groupBoldRanges`)**, quan trọng nhất và là thứ bản 09-15 thiếu.
    Người viết kịch bản gõ `**HMO**, **lợi khuẩn** hay **sữa non**, **DHA**, **đạm A2**` tức NĂM
    cụm bold rời, KHÔNG phải một cụm có dấu phân chia. Bản cũ xử lý từng cụm nên chỉ "lợi khuẩn"
    (khớp `[Illus]`) ra mẫu Custom, bốn cụm kia ra ảnh trần — lỗi thật trên dự án "Bin Tom - Tap
    3". Luật gộp: hai cụm LIỀN KỀ, CÙNG DÒNG, phần chữ xen giữa CHỈ gồm khoảng trắng và `,`
    (`boldJoinerKind`) -> cùng một nhóm. Xen giữa chỉ khoảng trắng thì nối thành MỘT phần con; có
    dấu `,` thì mở phần con MỚI. Từ nối "và"/"hoặc"/"hay" KHÔNG-in-đậm xen giữa hai cụm bold thì
    KHÔNG cho gộp (thu hẹp 2026-09-16). Từ nối ĐƯỢC bôi đậm thì chính nó là một cụm bold, hai bên
    nối với nó bằng khoảng trắng nên tất cả về cùng một nhóm.
    Trong MỘT cụm bold, từ nối chỉ là chữ bình thường — `splitBoldPhrase` CHỈ tách bằng dấu `,`,
    nên `**canxi và vitamin D**` là MỘT cụm chứ không phải hai.
    Offset lấy từ `clean_start/clean_end`, và CHỈ dùng khi `clean.slice(s,e)` ra đúng nguyên văn
    cụm — lệch thì không gộp (thà lỡ còn hơn gộp nhầm hai cụm cách nhau cả câu).
  - **BƯỚC 1 — nhóm dựng ra khối gì** (`planBoldGroup` / `planBoldGroups`), theo thứ tự ưu tiên:
    0. CÂU (dòng kịch bản) có ĐÚNG HAI nhóm -> gộp làm MỘT mẫu `zoom-title` (nhóm đầu vào ô Tiêu
       đề, nhóm sau vào Dòng phụ). Thắng mọi luật dưới, kể cả khi một nhóm đã ≥ 6 từ. Ba nhóm trở
       lên thì KHÔNG gộp (mẫu chỉ có 2 ô chữ, nhóm thứ ba sẽ biến mất). Nhóm logo được miễn.
       Hai điều kiện THÊM (2026-09-16): (a) KHÔNG nhóm nào bị dấu `,` chia thành cụm nhỏ
       (`hasCommaParts`) — câu liệt kê phải lên mẫu Custom từng mục theo luật 2; (b) chữ xen giữa
       hai nhóm (phần KHÔNG in đậm) không được chỉ là "và"/"hoặc"/"hay" (`isConjunctionGap`, đọc
       `group.gapBefore` do `groupBoldRanges` ghi) — hai vế nối bằng từ nối là hai ý ngang hàng,
       không phải cặp tiêu đề + dòng phụ.
    1. Nhóm đúng bằng **"Little Étoile"** -> ảnh `[Icon] Logo LE` (`mode:'logo'`), KHÔNG chữ.
    2. Nhóm LIỆT KÊ có ít nhất MỘT phần con khớp -> MỌI phần con lên mẫu `custom`; phần không
       khớp mượn hình bất kỳ (`boldFallbackAssets`, luân phiên qua `fallbackIndex`, LOẠI logo +
       True/Wrong vì chúng mang nghĩa).
    3. Nhóm ≥ `BOLD_LONG_PHRASE_WORDS` (6) từ -> mẫu `vlog-tag` cho CẢ nhóm. Thắng cả việc nhóm
       khớp `[Illus]` (người dùng chốt): hộp Custom với 6+ từ rất rộng, hình đè mép mất cân.
       Nhóm liệt kê KHÔNG phần nào khớp cũng rơi vào đây — lúc đó nó chỉ là một câu dài.
    4. Nhóm liền mạch < 6 từ: khớp `[Illus]` -> mẫu `custom` kiểu illus; chỉ khớp `[Icon]` ->
       ẢNH TRẦN không kèm chữ.
    5. Còn lại -> chữ thường.
  - Phần con hiện **nối tiếp nhưng giữ lại**: phần thứ i bắt đầu lần lượt nhưng đều kết thúc ở
    CUỐI nhóm -> cuối câu thấy đủ cả danh sách. Có đủ mốc thời gian thật của từng cụm thành viên
    (số unit = số cụm) thì dùng mốc THẬT; không thì chia khoảng theo độ dài chữ.
  - Nhóm dựng bằng CHỮ: hiệu ứng chữ "Hồng kẹo" (`MAGIC_FILL_TEXT_EFFECT_ID` = `fx7`, tra trong
    `TEXT_EFFECT_PRESETS` chứ không chép màu ra Magic Fill) + hiệu ứng ĐỘNG VÀO luân phiên
    (`BOLD_TEXT_IN_ANIMATIONS`, theo vòng nên 2 cụm liền nhau không trùng và chạy lại ra y hệt);
    hiệu ứng RA vẫn mờ dần. Font/độ đậm/giãn chữ để ĐO lấy từ chính patch hiệu ứng, và bề rộng
    gói dòng là `inkWidth` = ô lưới trừ hai bên viền — viền nằm NGOÀI mực chữ.
  - Luật cũ `matchBoldInsets` ("mỗi cụm bold kéo tối đa 3 [Icon]/[Illus] thành block ảnh riêng")
    ĐÃ BỎ: hình giờ nằm trong mẫu, giữ cả hai là một hình hiện hai lần cho cùng một cụm.
    KHÔNG còn danh sách STOPWORDS (luật tỉ lệ đã tự loại các chữ chung lẻ loi).
- KỊCH BẢN CHUẨN dùng để đọc offset chọn bằng `magicCleanScriptText`, KHÔNG phải "ô nào có chữ
  trước thì lấy". `#refScriptInput` là nguồn sự thật (mọi lần gõ đều cập nhật
  `currentScriptMetadata`); `#refScriptReview` là bản "đang hiệu chỉnh" để bóc băng lại và ĐƯỢC
  PHÉP lệch. Dự án "Bin Tom - Tap 3" có bản review thêm 2 dòng -> `clean_start` của các cụm cuối
  trỏ sang câu khác, hỏng ÂM THẦM. Nay chấm điểm từng bản bằng số cụm mà
  `text.slice(clean_start, clean_end)` ra đúng nguyên văn, lấy bản cao điểm nhất (bằng điểm thì
  `#refScriptInput` thắng vì đứng trước).
- Một file khớp nhiều ghi chú / nhiều cụm bold thì được đặt ở TẤT CẢ các chỗ đó (người dùng chốt).
  Chỉ chống trùng ở mức: CÙNG MỘT FILE + khoảng thời gian CHỒNG NHAU (ghi chú và cụm in đậm của
  cùng một câu có thể cùng trỏ tới một ảnh) -> giữ block đầu tiên.
- Thời gian: gom từ khoá theo DÒNG (nhiều ghi chú cùng dòng dùng chung khoảng thời gian), rồi
  `magicMatchLineRange` neo ĐẦU dòng bằng 4 từ mở đầu + CUỐI dòng bằng 4 từ kết thúc trong bảng
  từ ASR (`magicScanWordRun` — KHÔNG ràng buộc cùng clip như khớp cụm in đậm, vì một dòng dài
  hoàn toàn có thể vắt qua nhiều clip). Dò xuôi theo cursor (thứ tự kịch bản), dưới ngưỡng
  `MAGIC_FILL_WORD_MATCH_MIN` mới quét lại từ đầu. Sàn thời lượng `MAGIC_ASSET_MIN_DUR` = 0.8s;
  video ngắn hơn câu thì cắt theo thời lượng video (block overlay không lặp).
- Đặt vào khung hình (giữ nguyên thông số gốc của file):
  - Tiền tố [Vid] (hoặc video không có tiền tố) -> KIND_COVER: giữa khung, `position_x/y = 0`,
    scale = cover-fit `coverScalePercent` (max(seqW/w, seqH/h)) nên không lọt nền. TẮT TIẾNG
    (muted/volume 0) để không đè lời thoại lane chính. Nhiều [Vid] cùng một dòng -> chia đều
    khoảng thời gian của dòng (nếu không chúng che nhau).
  - Tiền tố [Icon]/[Illus] (hoặc ảnh không có tiền tố) -> KIND_INSET: **TUYỆT ĐỐI KHÔNG ĐỔI
    SCALE** (luôn 100, giữ nguyên mọi thông số gốc); kích thước chỉ là dữ liệu ĐẦU VÀO để tính
    vị trí. Chỉ `position_x/y` được đổi. (Bản đầu có bước thu nhỏ cho vừa băng trống -> sai yêu
    cầu, dự án thật ghi ra scale 85.2 / 86.5.)
  - Phía đặt suy từ CHÍNH VỊ TRÍ MẶT (`magicFaceScreenBand` = tâm mặt ±face_height/2 quy về màn
    hình): mặt nửa TRÊN -> đối tượng xuống DƯỚI và ngược lại; không có dữ liệu mặt -> mặc định
    nửa DƯỚI (đối xứng với text Magic Fill vốn neo cạnh TRÊN). KHÔNG được suy ngược từ mép băng
    trống: băng còn bị các text box thu hẹp, mặt ở nửa DƯỚI mà bandTop bị text box đẩy xuống thì
    suy ngược ra "đặt phía dưới" -> ném đối tượng đúng vào mặt (đã mắc 2026-08-03).
  - Băng trống = nửa khung đối diện mặt, trừ tiếp các box TRÙNG THỜI GIAN đã đặt (text box Magic
    Fill + icon trước đó). Chọn vị trí theo thứ tự: (a) vừa băng -> đặt GIỮA BĂNG; (b) không vừa
    -> dán cạnh XA của băng nếu vẫn không chạm mặt; (c) vẫn chạm mặt -> dán SÁT RANH GIỚI MẶT
    (bỏ ràng buộc text box, cốt không đè mặt, vẫn gọn trong khung); (d) hết cách -> dán cạnh
    khung phía xa mặt nhất. Ảnh cao hơn cả khung -> căn giữa khung.
  - Hoạt ảnh mặc định: Pop vào / Fade ra (`TextAnimations.defaultMagicFillAnimation()`).
  - RIÊNG ảnh LOGO của cụm "Little Étoile" (`plan.place === 'logo'`): KHÔNG né mặt — giữa KHUNG
    theo chiều ngang (`position_x = 0`, giữa khung chứ không phải giữa ô lưới: logo lệch tâm
    khung thì lộ ngay) và MÉP TRÊN ảnh chạm mép trên lưới an toàn. Vẫn scale 100.
- Khối MẪU do cụm in đậm sinh ra (`magicFillTemplateItem`, `MAGIC_FILL_TEMPLATE_BY_MODE`): item
  `type:'text'` mang `template.id` là `custom` / `vlog-tag` / `zoom-title`. Riêng `custom` ghi
  `template.overrides.art = {variant, src, name}` — ghi thẳng hình đã khớp, khác block người dùng
  tự thêm (để rỗng = "hình đầu tiên hợp kiểu"). Ô chữ mẫu có mà nhóm không có thì để TRỐNG, KHÔNG
  lấy mặc định của mẫu ("Tournament Summer Season" nằm lại trên khung hình là người dùng tưởng
  Magic Fill bịa nội dung). Đo bằng chính `measureTextItemBox` (nhánh mẫu = hợp các lớp) rồi
  neo/xếp chồng bằng ĐÚNG bảng `placed` của text box — hai loại khối nằm chung khung hình nên phải
  chống đè lẫn nhau. PHẢI `await preloadTemplateFonts(...)` cho cả ba mẫu trước khi đo.
- GÓI CHỮ CHO MẪU (`magicFitTemplateItemText`): chỉ `custom` có `fitWidth` (tự co cỡ chữ); `vlog-tag`
  và `zoom-title` thì KHÔNG — chữ dài bao nhiêu hộp rộng bấy nhiêu. Đo thật: "đủ điều kiện để tăng
  trưởng và phát triển bình thường" ra hộp **2710px trong khung 1080**. Nên phải tự xuống dòng: thử
  1 dòng, 2 dòng… (trần `MAGIC_FILL_TEMPLATE_MAX_LINES` = 4) tới khi hộp lọt lưới an toàn, đo lại
  bằng chính `measureTextItemBox` mỗi lượt (khoá cache layout có `JSON.stringify(texts)` nên đổi
  chữ là đo lại thật). Số dòng của MỖI ô tỉ lệ theo độ dài của chính ô đó so với ô dài nhất — ép
  cùng một số dòng cho mọi ô thì mẫu 2 ô bẻ luôn cả ô ngắn ("HMO" thành "H\nMO" chỉ vì ô kia dài).
- Lane: `Magic Fill Video` (cover) và `Magic Fill Element` (icon/illus), tạo thêm lane N khi chồng
  thời gian. Lane Element luôn được `placeTrackAbove` lên trên lane Video, nếu không icon bị video
  phủ khung che mất. Item gắn `magic_fill: true` + `magic_fill_keyword` (từ khoá đã sinh ra nó).
```

### Magic Fill — Điền Chuyển Cảnh (ĐÃ GỠ 2026-08-04)

```text
- Từng có: Magic Fill tự đặt hiệu ứng chuyển cảnh vào mọi điểm giao lane chính theo 3 nhóm vị trí
  (hook/line/other) với bể hiệu ứng riêng. Người dùng chốt BỎ tự động, tự đặt chuyển cảnh THỦ CÔNG
  qua tab "Chuyển tiếp".
- Đã gỡ: lớp chính sách + bắc cầu — Transitions.AUTO_POOLS / AUTO_BLOCKLIST / autoAssign / autoPool
  (transitions.js), MagicFillAssets.classifyJunctions (magic-fill-assets.js), magicApplyTransitions /
  magicTagWordLines + lời gọi ở bước (7) magicFill (editing-runtime.js), và test transition_auto_assign.js.
- GIỮ NGUYÊN: engine chuyển cảnh (compose, cửa trập, dissolve/pixelize/zoomin, hiệu ứng "Xoắn"/swirl)
  và toàn bộ luồng đặt TAY (tab Chuyển tiếp, kéo-thả, bake export). Muốn bật lại tự điền thì dựng lại
  lớp chính sách theo mô tả cũ trong git history (commit 2026-08-03).
```

### Cây Thư Mục Trong Panel Tệp Phương Tiện (2026-08-15)

```text
VẤN ĐỀ NGƯỜI DÙNG BÁO: (1) thêm cả thư mục video thì panel đổ ra một đống thẻ phẳng, không
còn biết cái nào thuộc thư mục nào; (2) video thêm ở bước Upload đến giai đoạn Editing thì
BIẾN MẤT khỏi panel trái. (2) là do `body.editing-stage-active #projectSourcePanel {display:none}`
— bố cục Editing nhường chỗ cho timeline nhiều lane nên panel nguồn bị ẩn cứng.

MÔ HÌNH DỮ LIỆU — MỘT TRƯỜNG DUY NHẤT: mỗi mục mang `group_path` = MẢNG tên thư mục tính từ
thư mục người dùng đã thêm (`[]` = nằm ngay gốc panel). KHÔNG dựng cấu trúc cây riêng: panel
chỉ vẽ MỘT cấp tại một thời điểm, thư mục con = các tên khác nhau ở đoạn kế tiếp của những
mục có `group_path` bắt đầu bằng chỗ đang đứng. Nhờ vậy bao nhiêu cấp cũng vẽ được bằng cùng
một đoạn mã, và không có trạng thái cây nào phải giữ đồng bộ khi thêm/xoá tệp.
  - Bước Upload: state `projectLibraryPath` (index.html) + `renderProjectVideoLibrary()`.
  - Editing: state `editPanelFolderPath = {media, audio}` + `renderImportPaneHtml()`.
  Cả hai dùng chung CSS `.media-crumbs` (khai ở index.html) cho dải breadcrumb.
`clampProjectLibraryPath()` / `clampEditPanelFolderPath()` lùi về cấp còn tồn tại khi thư mục
đang đứng biến mất — thiếu bước này thì panel hiện ra RỖNG TRƠN và không có đường quay lại.

Ô TÍCH CỦA THẺ THƯ MỤC (bước Upload) bật/tắt TOÀN BỘ video bên trong; chọn dở dang thì để
`indeterminate` chứ không nói dối là "đã chọn hết".

LISTING PHẢI RẺ — ĐÂY LÀ MẤU CHỐT KHI QUÉT ĐỆ QUY:
  Bản trước `/api/video-sources/scan` ffprobe + trích thumbnail cho TỪNG video ngay trong
  request. Chỉ quét 1 cấp nên còn chịu được; quét đệ quy là hàng trăm lần gọi tuần tự -> thêm
  thư mục xong ngồi chờ hàng chục giây. Nay scan chỉ `readdir` + `stat`, còn hai việc đắt tách ra:
    - thumbnail -> `/api/source-thumb?path=` với `<img loading="lazy">`, chỉ thẻ lọt tầm nhìn
      mới trích (cùng khuôn `/api/library/thumb`). Trích lỗi -> 404 để `<img>` rơi về ô giữ chỗ;
      KHÔNG trả ảnh rỗng vì trình duyệt sẽ cache "thành công".
    - kích thước/fps -> `/api/media-probe`, hỏi cho ĐÚNG MỘT video: cái quyết định mặc định
      Sequence. `applySequenceDefaultFromProjectLibrary` nay bất đồng bộ, có token chống đua
      và ghi số đo lại vào chính mục đó nên lần sau không hỏi nữa.
  `collectVideosFromSourcePaths` (khâu XỬ LÝ: nối video, bóc băng) GIỮ NGUYÊN 1 cấp và vẫn
  phẳng — hàm mới `collectMediaTreeFromSourcePaths` chỉ phục vụ HIỂN THỊ. Trần: sâu 8 cấp,
  4000 file, bỏ qua thư mục/file bắt đầu bằng dấu chấm.

`webkitRelativePath` CHỈ CÓ Ở `<input webkitdirectory>`. File lấy từ `FileSystemEntry` (kéo
thả ở bản web) KHÔNG có, nên `walkFsEntry` phải tự gắn `file.__groupPath` — quên là cây thư
mục của cú kéo thả mất sạch và mọi video đổ về gốc. `<input webkitdirectory>` bước Upload
trước đây chỉ nhận file CẤP GỐC (`pickFolderRootVideoFiles`, đã bỏ): video trong thư mục con
biến mất mà không báo gì.

VIDEO NGUỒN BƯỚC UPLOAD Ở TAB "TỆP PHƯƠNG TIỆN":
  `syncProjectSourceAssets()` (editing-runtime) đọc `window.getProjectSourceVideos()` do
  index.html lộ ra, rồi dựng asset `source:'project'` dưới MỘT thư mục "Video nguồn dự án"
  (giữ nguyên cây thư mục gốc bên dưới). Chạy ở `onStepChanged` VÀ ở đầu `renderImportPaneHtml`
  -> tự khớp lại sau undo/redo hay mở dự án khác, không cần ai nhớ gọi.
  - ID PHẢI ỔN ĐỊNH THEO ĐƯỜNG DẪN (`stableAssetId`, FNV-1a): hàm chạy lại mỗi lần vào Editing,
    id ngẫu nhiên là block trên timeline (giữ `asset_id`) trỏ vào asset không còn tồn tại ->
    mất hình mà KHÔNG có lỗi nào báo.
  - Asset nguồn không còn trong thư viện Upload thì bị gỡ — TRỪ khi còn block dùng nó.
  - Thẻ nguồn KHÔNG có nút "×": danh sách do panel bước Upload quản, xoá từ đây thì lượt sync
    sau dựng lại nguyên vẹn, nút sẽ không có tác dụng thật.
  - Chỉ mục có `source_path` mới lên panel: bản web chỉ có Blob URL của phiên hiện tại, backend
    không phát lại được nên kéo xuống timeline sẽ ra block hỏng.

LINK CHỨ KHÔNG CHÉP (asset `linked: true`): `/api/editing-assets/link` mô tả file TẠI CHỖ,
`url` = `/api/source-file?path=`. Chép cả thư mục footage sang temp_uploads là nhân đôi hàng
chục GB và "Dự án mới" lại xoá sạch. `/api/editing-assets/import-local` (vài file lẻ) vẫn CHÉP
như cũ — không đổi hành vi sẵn có.
  - `ensureAssetProbed(asset)` hỏi số đo đúng lúc cần (kéo/bấm "+" xuống timeline), vì link
    bỏ qua ffprobe. Hỏi hụt thì rơi về thời lượng mặc định, không chặn thao tác.

DANH SÁCH TRẮNG ĐƯỜNG DẪN (`sourceAccessRoots`/`sourceAccessFiles`): file nguồn nằm rải rác
ngoài thư mục dự án nên `express.static` không với tới, mà mở một route đọc path tuỳ ý thì
thành lỗ hổng đọc file. Chỉ phát những gì phiên làm việc ĐÃ ĐĂNG KÝ (scan / link). Ở bộ nhớ,
không ghi đĩa — mở lại dự án thì `scanDesktopSourcePaths` đăng ký lại.
  - ASSET LINK CỦA PANEL EDITING PHẢI TỰ LO PHẦN ĐĂNG KÝ LẠI. `scanDesktopSourcePaths` chỉ
    đăng ký nguồn giai đoạn Upload; file/thư mục người dùng kéo thẳng vào tab "Tệp phương tiện"
    KHÔNG đi qua đường đó. Vì vậy `isLinkedEditingAssetRecord()` (index.html) đưa chúng vào
    `media.editingAssets` của .crab với cờ `linked: true`, và `reimportEditingAssets()` gom
    theo `${linked ? 'link' : 'copy'}|${kind}`: bản CHÉP đi `/import-local`, bản LINK đi
    `/editing-assets/link` — endpoint sau vừa dựng lại URL vừa ĐĂNG KÝ LẠI đường dẫn.
    Thiếu bước này thì mở lại dự án là mọi thẻ link trả 403: thumbnail trắng, preview trống,
    mà file vẫn nằm nguyên chỗ cũ trên máy nên không ai đoán ra vì sao (bug 2026-08-15).
    Loại trừ `source` 'project'/'main'/'library' — ba nguồn đó do chỗ khác dựng lại.
  - `/api/source-file` dùng `res.sendFile` (có sẵn Range nên `<video>` tua được).
  - HAI CHỖ KHÁC PHẢI NỚI THEO, nếu không lỗi hiện ra ở nơi hoàn toàn khác:
    · `resolveAudioSourcePath` — không nới thì block dựng từ asset link KHÔNG CÓ SÓNG ÂM.
    · `resolveRetouchSource` — không nới thì Retouch từ chối chính file người dùng vừa thêm.
    Cả hai vẫn là danh sách trắng, không phải mở toang.

KÉO-THẢ TỆP/THƯ MỤC TỪ MÁY VÀO PANEL EDITING (`setupPanelImportDnd`): trước đây panel chỉ nhận
kéo-thả THEO CHIỀU RA (thẻ -> timeline), thả file từ máy vào thì trình duyệt MỞ LUÔN file đó và
mất cả phiên làm việc. Nghe ở `#editPanelBody` chứ không ở `#step4` (nút "Quay lại Timeline" và
tab LUT/Chuyển tiếp không phải chỗ nhận tệp) và chỉ xử lý 2 tab media/audio — tab khác không
`preventDefault` nên con trỏ báo "không thả được" đúng như thật.

Hộp thoại chọn THƯ MỤC ở Electron là IPC RIÊNG (`pick-editing-asset-folders`) chứ không thêm
`openDirectory` vào `pick-editing-assets`: macOS cho trộn openFile+openDirectory nhưng Windows
thì KHÔNG — một trong hai thuộc tính bị bỏ qua và người dùng Windows không chọn được thư mục.

`group_path` ĐƯỢC LƯU trong .crab (`media.sources[].group_path`) và trả lại bằng
`restoreProjectLibraryGroups()` sau khi scan: manifest chỉ giữ danh sách FILE (thư mục gốc
không còn), nên không lưu thì mở lại dự án là cây thư mục đổ về phẳng.

FILE VECTOR (.svg) — VẼ RA PNG NGAY LÚC NHẬP, KHÔNG CHO ĐI THẲNG VÀO PIPELINE:
ffmpeg/ffprobe KHÔNG có bộ giải mã SVG — `ffprobe` trả 0×0 (block rơi về khung mặc định
45%×25%, sai hẳn tỉ lệ file) và export dừng ngay với `no decoder found for: svg`. Trong khi
đó Chromium vẽ SVG tốt, nên preview "có vẻ chạy" còn export thì chết: đúng kiểu lỗi chỉ lộ
ra ở khâu cuối. Cách chốt: dùng chính Chromium làm bộ rasterize, MỘT LẦN, lúc nhập.
  - `rasterizeVectorUrl()` (editing-runtime.js): `<img>` -> canvas -> PNG blob. Vẽ gấp đôi
    khổ gốc (`VECTOR_RASTER_SCALE`) để phóng to trong khung vẫn nét, chặn trần 4096px.
    SVG chỉ có `viewBox` thì `naturalWidth = 0` -> rơi về 1024 thay vì canvas 0×0.
  - `rasterizeVectorAssets()` chạy ở CẢ BA đường nhập (upload / import-local / link), ngay
    sau khi backend trả danh sách và TRƯỚC `addAssetRecord`. GIỮ NGUYÊN `id` cũ: id băm từ
    đường dẫn nguồn nên nó là danh tính của file trong panel — đổi id là lần sau thêm lại
    cùng file sẽ ra thẻ trùng. Vẽ hỏng thì giữ asset gốc, không nuốt mất file người dùng.
  - `/api/editing-assets/rasterize` cất PNG vào `editing_assets`, giữ `display_name` là tên
    .svg gốc (panel không hiện đuôi .png lạ mắt), và dọn bản .svg mà `/import-local` vừa
    chép (`replace_path`, chỉ xoá trong `editing_assets` — không đụng file người dùng).
  - KHÔNG nhận `.ai`/`.eps`: Chromium không vẽ được nên không rasterize nổi, ffmpeg cũng
    không giải mã được -> nhận vào chỉ để có một cái thẻ hỏng.

Test: `npm run test:vector-asset` (tests/scripts/vector_asset_raster.js) — .svg vào được /
.ai bị loại, rasterize giữ tên hiển thị + trả số đo thật + dọn bản .svg đã chép + không đụng
file gốc, và URL trả về phát được.

Test: `npm run test:media-folders` (tests/scripts/media_folder_tree.js) — đo quét đệ quy +
`group_path`, listing không ffprobe, danh sách trắng chặn 403 (kể cả leo `../`), link không
chép file và id ổn định giữa 2 lượt nạp.

Đo trên app (Electron thật, cây fixture Footage/{intro.mp4, Day1/{a,b}.mp4, Day1/Cam2/deep.mp4,
Day2/c.mp4} + 1 file .txt):
- Upload: thả thư mục -> 1 thẻ "Footage (5)"; vào trong -> "Day1 (3)", "Day2 (1)", intro.mp4;
  vào Day1 -> "Cam2 (1)", a.mp4, b.mp4; breadcrumb "Tất cả › Footage › Day1"; .txt bị bỏ qua.
- Bỏ chọn thẻ thư mục Cam2 -> deep.mp4 `selected:false`.
- Thumbnail: `<img src="/api/source-thumb?path=…">` tải về naturalWidth 320.
- Editing: tab Tệp phương tiện hiện "Video nguồn dự án (5)" -> Footage -> Day1 ra đúng cây;
  thẻ nguồn không có "×", có "+", `draggable="true"`, `source:'project'`, `linked:true`.
- Bấm "+" -> `asset.duration` từ null thành 2 (probe lười chạy) và block lên timeline; preview
  phát được qua /api/source-file.
- Kéo thả thư mục vào panel Editing -> viền sáng khi rê, thả xong ra thẻ thư mục ở gốc tab;
  thả lại cùng thư mục KHÔNG sinh asset trùng (id ổn định).
- /api/audio-peaks cho file link ngoài thư mục dự án -> 200, 3064 byte peak thật.
```

### Màn Hình Home — Dự Án Gần Đây (2026-08-15)

```text
Mở ứng dụng ra không còn nhảy thẳng vào giai đoạn Upload nữa mà là màn hình chọn dự án
kiểu CapCut: "Tạo dự án mới" (vào thẳng Editing trống) hoặc mở nhanh dự án đã lưu.

HOME KHÔNG PHẢI MỘT .step-panel — hai lý do, cả hai đều là bẫy im lặng:
  1. showStep() xoá .active của MỌI .step-panel, mà #exportModalPanel cũng mang class đó
     -> mỗi lần đổi bước là đóng luôn modal Export.
  2. currentStepId ĐƯỢC GHI VÀO tệp .crab và đọc lại lúc mở. Dự án lưu trong lúc đang ở
     Home sẽ mở lại vào Home — vĩnh viễn, nằm trong tệp.
Thay bằng lớp phủ position:fixed bật/tắt qua `body.home-active`, cùng khuôn
`editing-stage-active`. currentStepId không bao giờ đổi vì Home.
Là màn hình ĐẦU TIÊN bằng cách ghi <body class="home-active"> thẳng vào markup — đúng cơ
chế #step0 vẫn dùng, JS không phải gọi gì lúc khởi động và không có nháy hình.

GIA CỐ kèm theo: showStep(proj.currentStepId) khi mở dự án nay lọc qua whitelist step0..4.
Id lạ (tệp .crab của bản dev khác) là getElementById(...).classList null deref -> mở dự án
chết giữa chừng SAU KHI state đã bị reset sạch.

DANH MỤC "DỰ ÁN GẦN ĐÂY" (electron/recent-projects.js)
  Người dùng vẫn TỰ CHỌN nơi lưu .crab — không có thư mục dự án do app quản lý, nên Home
  không quét thư mục nào được; nó phải NHỚ những gì đã Lưu/Mở.
  - Đặt ở app.getPath('userData'), KHÔNG phải temp_uploads: /api/reset-project xoá sạch
    thư mục đó mỗi lần tạo dự án mới, ảnh đại diện của mọi dự án sẽ bay theo.
  - id = sha256(path.resolve(p)), hạ hoa-thường trên darwin/win32 vì hai hệ tệp đó không
    phân biệt hoa thường -> cùng một tệp mở bằng hai cách viết phải ra MỘT mục.
  - Tên lấy từ BASENAME đường dẫn, không từ media.sources[0]: dự án dựng thẳng ở Editing
    có thể chưa có nguồn nào.
  - Ghi kiểu .tmp -> rename như writeCrabFile; JSON hỏng -> trả rỗng và tự phục hồi (đây là
    tiện ích, hỏng nó không được phép chặn người dùng mở ứng dụng).
  - Tệp .crab mất -> exists:false, thẻ mờ + nhãn "Không tìm thấy tệp", KHÔNG tự gỡ (ổ ngoài
    có thể đang rút ra). Nút "×" chỉ gỡ khỏi DANH SÁCH và xoá ảnh đại diện — TUYỆT ĐỐI
    không đụng tệp .crab.
  - registerRecentProjectIpc() tách khỏi main.js để test gọi được đúng mã chạy thật:
    main.js không require được trong test (nạp nó là khởi động cả ứng dụng).
  - Ảnh trả về dạng DATA URL: trang chạy trên origin http://127.0.0.1 (mainWindow.loadURL)
    nên <img src="file:///…"> bị chặn.

ẢNH ĐẠI DIỆN
  captureCompositeFrame() khi đang ở Editing (đúng khung người dùng nhìn), dự phòng là
  khung đang giải mã của <video> preview, cuối cùng là ô giữ chỗ chữ cái đầu.
  - fire-and-forget + Promise.race timeout 3s: KHÔNG được để ⌘S phải chờ vẽ ảnh.
  - autosave có thêm rào 2 phút — captureCompositeFrame render TỪNG text/shape ra PNG nên
    ở dự án nhiều chữ nó đắt, chạy mỗi vòng autosave là thấy giật.
  - CỐ Ý không pause <video> (khác modal Chụp khung hình): autosave không được đụng vào
    việc phát.

THANH TIÊU ĐỀ + NÚT TRANG CHỦ thay breadcrumb. Quy tắc hiện/ẩn THUẦN CSS, không thêm state:
  Home (body.home-active)            -> ẩn cả breadcrumb lẫn thanh tiêu đề
  step0-3 (body.flow-script-filter)  -> hiện breadcrumb
  Editing                            -> hiện thanh tiêu đề
  updateProjectTitle() vốn đã được gọi sau mọi lần lưu/mở/đánh dấu bẩn nên nó là nguồn sự
  thật duy nhất; chỉ thêm 3 dòng vào cuối hàm.

TÊN DỰ ÁN SỬA ĐƯỢC TẠI CHỖ (2026-08-16, kiểu CapCut):
  - state `projectName` (rỗng = "chưa đặt"). getProjectDisplayName() = projectName ||
    tên file .crab; cả hai rỗng thì span hiện chỗ giữ chỗ "Dự án chưa lưu" (.is-untitled).
    Tên KHÔNG buộc trùng tên file: đổi tên dự án không đổi tên file trên đĩa.
  - #projectTitleName (span) <-> #projectTitleInput (input ẩn cạnh nó). Bấm/Enter/Space
    trên span để mở; Enter hoặc blur = nhận, Esc = huỷ. Ô rộng theo số ký tự đang gõ
    (fitProjectRenameInput, min 12ch) và bị max-width 24vw chặn trần.
  - keydown của input gọi stopPropagation: phím tắt toàn cục (Space = play, Delete = xoá
    block…) nghe ở document theo pha BUBBLE, không chặn là gõ tên thành ra điều khiển app.
  - Gõ đúng lại tên file .crab -> lưu '' chứ không lưu chuỗi đó: tên tiếp tục bám theo file
    nếu sau này "Lưu thành…" chỗ khác.
  - Ghi vào .crab ở `project.name`. Tệp cũ không có trường này -> '' -> hành vi y như trước.
    KHÔNG cần nâng CRAB_PAYLOAD_VERSION.
  - saveProject() gợi ý `<tên dự án>.crab`; chưa đặt tên thì rơi về tên nguồn đầu tiên như
    cũ. AUTO SAVE thì CỐ Ý vẫn dùng tên nguồn: tên thư mục bản lưu tự động phải ổn định qua
    các lần đổi tên, nếu không chuỗi bản lưu bị tách đôi (listAutosaves dò theo tên đó).

TÊN VIDEO XUẤT bám theo tên dự án (sanitizeProjectName), nhưng ô #exportFileName vẫn sửa
  được. Cờ `exportFileNameTouched` ghi nhớ "người dùng đã tự gõ" để lần mở Export sau không
  đè mất; cờ bị xoá khi đổi tên dự án / mở dự án khác / tạo dự án mới.
  sanitizeProjectName() bỏ ký tự cấm của hệ tệp (\ / : * ? " < > |), ký tự điều khiển và
  dấu chấm cuối — GIỮ tiếng Việt có dấu. Dùng chung cho cả tên .crab gợi ý lẫn a.download.

RỜI DỰ ÁN: ensureSavedBeforeLeaving() -> hộp 3 nút (Lưu / Không lưu / Huỷ), vì confirm()
chỉ có 2 nút. BẮT BUỘC gọi trước mọi đường rời dự án: goHome, "Tạo dự án mới", mở dự án
gần đây — startBlankProject() gọi /api/reset-project xoá sạch temp_uploads, asset Editing
chưa lưu sẽ biến mất.
"Dự án mới" trong Menu nay đi CÙNG ĐƯỜNG với Home (startBlankProject) thay vì
window.location.reload() như trước — dọn sạch được cả backend lẫn renderer nên không phải
tải lại trang (tiết kiệm ~2s và không nháy màn hình).
```

### Editing Là Điểm Bắt Đầu — Lane Chính Dựng Tay (2026-08-15)

```text
TRƯỚC: Editing là GA CUỐI. Phải có video + kịch bản -> bóc băng -> so khớp -> chốt timeline
-> mới tới Editing. Không có đường nào mở app rồi dựng ngay.
NAY:   mở dự án mới là vào thẳng Editing với dữ liệu trống; bóc băng theo kịch bản trở thành
       một CÔNG CỤ TUỲ CHỌN bên trong trình dựng.

BA CỬA GÁC phải mở thì Editing mới chạy với dự án trống:

1. currentMode === 'FINAL'. Điều kiện này lặp ở ~70 chỗ (index.html + editing-runtime.js).
   KHÔNG thêm cờ thứ hai để thay nó: trong mã này 'FINAL' không có nghĩa "đã lọc kịch bản"
   mà có nghĩa "timeline được lái bởi latestTimeline thay vì videoDuration thô" — dự án
   trống rồi tự nối video ĐÚNG là chế độ đó. Hai nguồn sự thật cho cùng một quyết định là
   chắc chắn có ngày lệch.
   ĐẶT BẰNG renderWordLevelTranscript([], 'FINAL'), KHÔNG gán tay: hàm đó vừa gán biến,
   vừa đồng bộ dao cắt, vừa DỌN #transcriptContainer (gán tay thì transcript của dự án
   trước còn nguyên trên màn hình).
   `projectFlowMode` ('editing-first' | 'script-filter') CHỈ dùng cho điều hướng —
   breadcrumb và nút "Quay lại Timeline" — không bao giờ cho logic dữ liệu.

2. Lane chính là SUY RA từ latestTimeline, không kéo clip vào được (trackTypeForItemType
   chỉ cho item vào lane visual/audio). Muốn có clip thì phải nối video THẬT.

3. Export bắt buộc có temp_input.mp4 + timeline khác rỗng (/api/export-video trả 400
   'Không tìm thấy video nguồn' / 'Timeline rỗng'). Nên (2) cũng là điều kiện mở khoá
   nút Xuất Video.

LỜI HỨA "THÊM VIDEO KHÔNG LÀM LỆCH NHỮNG GÌ ĐÃ DỰNG" — ba lớp, thiếu lớp nào cũng hỏng:

  a. preserve_order: collectVideosFromSourcePaths SẮP THEO TÊN FILE ở cuối hàm. Người dùng
     dựng trên "z.mp4" rồi thêm "a.mp4" là "a" nhảy lên ĐẦU file nối -> mọi mốc cũ lệch mà
     KHÔNG có lỗi nào báo. Cờ này bỏ phép sort đó. Mặc định vẫn sort (hai người gọi cũ —
     mở lại .crab, /api/transcribe-local — dựa vào thứ tự cũ).
  b. Nguồn mới luôn nối vào CUỐI, và chỉ APPEND row vào đuôi latestTimeline.
     mainClipSequenceSpans() cộng dồn trái->phải nên clip cũ giữ nguyên vị trí sequence;
     overlay định vị bằng timeline_start trong THỜI GIAN SEQUENCE nên KHÔNG nhúc nhích —
     timeline chỉ dài thêm về phải.
  c. rebaseRows() bù delta nếu biên vẫn trôi vài ms (nguồn phải chuẩn hoá lại).

  Đo thật (Electron + 3 clip trong library/): dựng 2 clip ra [0,35.243] và [35.243,47.243];
  thêm clip thứ ba TÊN SẮP TRƯỚC -> hai clip đầu giữ nguyên từng chữ số, clip mới vào
  [47.243,55.177].

NỐI VIDEO KHÁC ĐỊNH DẠNG LÀM MẤT PHIM (lỗi có sẵn, sửa cùng dịp):
  `ffmpeg -f concat -c copy` KHÔNG kiểm tra tương thích — đưa vào hai file khác codec /
  khác fps / một bên có tiếng một bên không, nó vẫn TRẢ VỀ 0 và sinh file hỏng: khung của
  clip sau bị nhồi vào mốc thời gian của clip trước ("Non-monotonic DTS"). Đo thật trên 2
  clip trong library/ (h264 23.976fps không tiếng + hevc 30fps có tiếng): 35.2s + 12.0s ra
  file 35.2s — MẤT TRẮNG 12 giây, không lỗi nào báo. shouldNormalizeForConcat trước đây
  chỉ nhận diện .webm nên hai file .mp4 này đi thẳng vào concat.
  Nay normalizeSourcesForConcat so CHỮ KÝ LUỒNG của mọi nguồn
  (codec/khổ/pix_fmt/fps | codec/tần số/số kênh tiếng), khác nhau thì chuẩn hoá TẤT CẢ:
    - cấp rãnh tiếng CÂM (anullsrc + -shortest) cho clip không có tiếng, nếu không bản
      chuẩn hoá vẫn lệch SỐ LUỒNG và concat lại hỏng đúng như cũ;
    - ép CÙNG MỘT nhịp khung vì concat demuxer không nối được hai nhịp khác nhau. Nhịp đó
      là nhịp CAO NHẤT của bộ nguồn (`concatTargetFps`, trần 60) — xem "Nhịp khung của file
      nối" bên dưới. Trước 2026-09-09 chỗ này ghi cứng `-r 30`.
  Ảnh hưởng CẢ luồng bóc băng cũ, không riêng lane chính dựng tay.

DANH SÁCH NGUỒN KHÔNG PHẢI STATE RIÊNG: suy ra từ chính latestTimeline
(MainLane.concatSourcesFromRows đọc row.source_path). latestTimeline đã nằm trong
captureFullState() nên undo/redo và file .crab tự lo giúp — giữ thêm một mảng song song
là chắc chắn có ngày hai bên lệch. Row do luồng LỌC sinh ra không có source_path, gặp ca
đó thì hàm trả null và người gọi rơi về mainConcatCache.

static/js/main-lane.js tách RIÊNG phần số học (không DOM, không fetch) vì toàn bộ rủi ro
của tính năng nằm ở mốc thời gian: lệch một chút là overlay dán sai khung mà không có lỗi
nào báo. Test: npm run test:main-lane (thuần), test:main-lane-reingest (thứ tự),
test:main-lane-concat (nối video THẬT, đối chiếu thời lượng file ra).
```

### Clip Lane Chính Vắt Qua Ranh Giới Hai Video Nguồn (2026-09-16)

```text
LỖI NGƯỜI DÙNG BÁO: mở lại "Yêu Con 1 - Test ver 2.crab" thì hiện toast "2 clip trên lane
chính bị kéo dài quá video nguồn và đã được cắt về đúng độ dài" — trong khi người dùng
chưa hề kéo tay cầm clip nào. Giải mã .crab đo được: hai clip bị gọt từ 6,80s -> 0,081s và
2,43s -> 0,106s, tức MẤT HẲN hai câu thoại. Vẫn dài hơn MIN_CLIP_SEC (0,05s) nên không bị
bỏ row, chỉ lặng lẽ thành mảnh vụn không ai thấy.

VÌ SAO. Lane chính của luồng LỌC KỊCH BẢN được cắt theo mốc PHIÊN ÂM của file nối, mà
phiên âm không biết ranh giới nguồn nằm đâu. Hai câu đó bắt đầu sớm hơn ranh giới 0,086s
và 0,107s rồi chạy trọn vẹn trong video KẾ TIẾP:
  clip 44,094->50,890 | ranh giới #7/#8 ở 44,177 -> 0,086s ở video #7, 6,71s ở video #8
  clip 57,383->59,816 | ranh giới #9/#10 ở 57,490 -> 0,107s ở #9, 2,33s ở #10
`segmentAt` gán clip theo mốc BẮT ĐẦU, nên cả hai bị coi là clip của video TRƯỚC rồi bị
`clampRowsToSegments` kẹp mép phải về hết video đó.

HAI LỖ HỔNG CỘNG LẠI, sửa cả hai:

1. GÁN SAI ĐOẠN (`segmentForRange`, thay `segmentAt` bên trong clampRowsToSegments).
   Mặc định VẪN theo mốc bắt đầu — đó mới là ý người dùng khi họ kéo tay cầm (lỗi
   2026-09-13: clip video A kéo quá mép vẫn là clip của A, phải cắt phần thừa). Chỉ đổi
   sang đoạn CHỒNG LẤN NHIỀU NHẤT khi clip mới chỉ thò đuôi vào đoạn của mốc bắt đầu một
   mẩu không đáng kể: dưới STRADDLE_TAIL_RATIO (10%) của chính clip VÀ dưới
   STRADDLE_TAIL_SEC (0,5s). Phải kèm ngưỡng chứ không lấy thẳng overlap lớn nhất: clip A
   5s bị kéo thành 15s thì phần ở B (9s) LỚN HƠN phần ở A (6s) — lấy theo overlap là clip
   nhảy hẳn sang B, đúng bằng lỗi 2026-09-13. Ở đó phần thuộc A chiếm 40%; ở ca trên chỉ
   1,3%. Sau khi sửa hai clip giữ 98,8% và 95,7% nội dung (chỉ mất mẩu thò sang video
   trước) thay vì 1,2% và 4,4%.

2. KHÔNG AI KIỂM LÚC CLIP VỪA SINH RA. Luật "mỗi clip nằm gọn trong một video nguồn" chỉ
   chạy khi MỞ DỰ ÁN và khi NỐI LẠI lane chính; đường `finalize-timeline` (nơi thực sự đẻ
   ra clip lệch) không kiểm gì. Clip hỏng nằm im trong .crab, phiên đầu preview vẫn đúng
   (file nối liền mạch, mắt không thấy chỗ ghép) nên không ai biết — tới lần mở sau mới bị
   phát hiện, và lúc đó bị gọt cụt.
   Nay `finalize-timeline` nắn ngay bằng clampRowsToSegments. Muốn vậy phải có bảng đoạn
   của đúng file vừa nối, mà luồng bóc băng trước đây không trả về: nay
   handleTranscribeFromSavedFiles trả thêm `concat_segments` (chỉ khi biết đường dẫn GỐC —
   bảng khoá theo bản chép trong temp_uploads là vô nghĩa với renderer), renderer giữ vào
   `mainConcatSegments` thay vì xoá trắng sau bước lọc.

Toast lúc mở dự án đổi lời cho đúng việc nó làm: "… đã được nắn về đúng ranh giới video
nguồn của nó" (trước ghi "bị kéo dài quá video nguồn và đã được cắt về đúng độ dài" — sai
cả nguyên nhân lẫn hậu quả với loại clip này).

Test: npm run test:main-lane-limits (mệnh đề 7/7b/7c — 7c là chính số đo của dự án trên).
```

### Playhead Đi Theo Video Vừa Thêm Vào Lane Chính (2026-08-18)

```text
TRƯỚC: thêm video thứ 7 vào lane chính xong, playhead vẫn nhảy về đầu block ĐẦU TIÊN.
  Lý do: `rebuildMainLane` nối lại temp_input.mp4 rồi nạp lại thẻ <video> -> currentTime
  về 0, và không ai đưa nó đi đâu cả. Người dùng phải tự cuộn đi tìm chỗ vừa thêm.

NAY: nhảy tới ĐẦU CLIP VỪA THÊM (thêm cả lô -> clip đầu tiên của lô), clip đó cũng được
  chọn sẵn ở panel Thuộc tính. Một dòng ở cuối nhánh thành công của `rebuildMainLane`:
  `selectTimelineClip(firstFreshIndex, { seek: true })` — hàm này vốn đã ghim con trỏ
  sequence, đặt video.currentTime và cuộn timeline về playhead.

DÒ THEO source_path, KHÔNG theo chỉ số: `MainLane.rowsFromSegments` BỎ QUA đoạn ngắn hơn
  MIN_CLIP_SEC nên chỉ số segment và chỉ số row không phải lúc nào cũng khớp; còn đường
  dẫn mới thì chắc chắn duy nhất (đã lọc khỏi oldSources). Nhờ vậy một dòng dò dùng chung
  cho CẢ hai nhánh (nối thêm bằng rebaseRows lẫn dựng lại toàn bộ vì .webm/lọc kịch bản).

LỖI ĐI KÈM PHẢI SỬA — ĐỔI PROXY LỖI THỜI DẪM LÊN PLAYHEAD (`previewSourceGeneration`):
  `applyPendingPreviewProxy` chụp `video.currentTime` RỒI mới await nạp file proxy. Nếu
  lượt đổi khởi động trước lúc lane chính dựng lại, khi nó về đích sẽ ghi thời điểm CŨ
  (và cả `activePreviewProxyUrl` của video cũ) đè lên nguồn MỚI — đo được: playhead nhảy
  đúng chỗ, rồi vài giây sau tự trôi ngược về ~0.5s. Nhánh dự phòng còn tệ hơn: nó nạp
  LẠI `previousUrl` — tức là video cũ. Nay `loadTranscribedVideoAndHydrateUI` tăng
  `previewSourceGeneration`, hai hàm đổi proxy chụp số hiệu trước khi await và bỏ qua
  mọi thao tác nếu số hiệu đã đổi.
```

### Sửa Thuộc Tính Chữ Cho CẢ NHÓM Block Đang Chọn (2026-08-18)

```text
TRƯỚC: chọn 5 block text rồi đổi cỡ chữ -> chỉ MỘT block đổi. Mọi nhánh text trong
  `updateEditingInspectorField` (và 4 handler click: preset / căn lề / decoration / case)
  ghi thẳng `item.style` của block CHÍNH, trong khi Volume và Transform đã đi theo nhóm từ
  lâu (applyVolumeToSelected / applyTransformToSelected) — text bị bỏ quên.

NAY: mọi đường ghi đi qua `patchTextStyle(item, patch)`; `textStyleTargets()` trả về MỌI
  block type='text' đang chọn (bỏ block nằm trên lane KHOÁ). Sau một lần chỉnh, cả nhóm có
  CÙNG giá trị dù trước đó khác nhau — đúng yêu cầu "đồng bộ thuộc tính", không phải
  "cộng thêm delta".

`patch` NHẬN CẢ HÀM `(styleHiệnTại, block) => delta`: cần cho trường suy ra từ giá trị cũ
  của CHÍNH block đó. Ca duy nhất hiện nay là đổi FONT — độ đậm phải giải lại theo font mới
  (`resolveFontWeight`) trên nền độ đậm cũ của từng block, chứ không phải của block chính.

KHÔNG gộp `item.text` (ô "Nội dung"): nội dung là dữ liệu riêng của từng block, ghi đè cả
  nhóm bằng một chuỗi là XOÁ dữ liệu chứ không phải đồng bộ thuộc tính. Dòng ghi chú ở đầu
  panel nói rõ điều này khi đang chọn nhiều block.

LỊCH SỬ: vẫn MỘT bước hoàn tác cho cả nhóm — `rememberInspectorEdit()`/`recordHistory()`
  chạy trước khi patch, và patch chỉ sửa dữ liệu nên ⌘Z trả lại toàn bộ. Đã đo: 3 block
  30/50/80 -> đổi thành 72/72/72, ⌘Z về đúng giá trị trước đó cho cả ba.

CÒN NGUYÊN THEO BLOCK CHÍNH (chưa đổi, cố ý): hoạt ảnh của overlay (`item.animation`) và
  thuộc tính hình học của shape (`normalizeShapeStyle`). Cùng kiểu bug nếu người dùng cần,
  nhưng nằm ngoài phạm vi lần sửa này.
```

### Inspector Text: Gộp "Kiểu" Vào "Cơ bản" + Ô Chọn Font Có Tìm Kiếm (2026-08-18)

```text
GỘP SUBTAB: tab "Văn bản" trước có 3 nhóm (Cơ bản / Kiểu / Biến đổi). Typography và Text
  Style là hai nửa của cùng một việc "định dạng chữ" — CapCut để chung một trang. Sửa
  ĐÚNG HAI CHỖ: `data-ins-sub` của section "Text Style" đổi 'style' -> 'basic', và bỏ
  khoá `style` khỏi INSPECTOR_TAB_DEFS.text.subs (index.html). Không đụng control nào,
  nên mọi id/wiring giữ nguyên.

Ô CHỌN FONT CÓ TÌM KIẾM (`fontPickerHtml`): 50 font trong một <select> thì phải cuộn mò;
  nay là nút + menu có ô tìm, mỗi dòng vẽ bằng CHÍNH font đó (@font-face nạp sẵn).
  <select id="editingTextFontFamily"> VẪN CÒN, chỉ ẩn đi (.font-picker-native) và vẫn là
  nguồn sự thật: chọn font = gán `select.value` rồi dispatch 'change' -> đi đúng nhánh cũ
  trong `updateEditingInspectorField`. Cùng thủ pháp với lưới hiệu ứng hoạt ảnh
  (`animEffectGridHtml`), lý do giống hệt: không nhân bản đường ghi dữ liệu.

BA CÁI BẪY ĐÃ VẤP KHI DỰNG, đều là "menu nằm trong một panel biết cuộn":
  1. Ô tìm kiếm nằm trong #clipInspectorPanel nên lọt vào listener 'input'/'change'
     DÙNG CHUNG của Inspector -> phải chặn sớm bằng `matches('[data-font-search]')`,
     nếu không mỗi phím gõ là một lượt commit + vẽ lại (menu bị huỷ ngay khi gõ).
  2. `scrollIntoView()` để đưa font đang chọn vào giữa danh sách LÔI CẢ PANEL trượt theo
     (ô "Nội dung" biến khỏi tầm mắt). Thay bằng tự tính `list.scrollTop` từ rect.
  3. Menu bị #inspectorPanelBody (overflow:auto) CẮT phần tràn. `placeFontPickerMenu()`
     đo chỗ trống trên/dưới lúc mở: đủ chỗ thì thả xuống, không thì lật lên, và
     max-height cắt theo chỗ trống thật — kèm `box-sizing: border-box` cho menu, nếu
     không padding + viền cộng thêm 14px và nó vẫn tràn đúng bằng ngần ấy.
```

### Menu Xổ Của &lt;select&gt; Nền Trắng (đã sửa 2026-09-10)

```text
DANH SÁCH XỔ RA CỦA <select> KHÔNG PHẢI DOM — trình duyệt vẽ nó ngoài trang, nên
  không selector nào (`select:focus`, `::picker`, z-index…) chạm tới. Chỉ hai thứ đổi
  được bộ màu của nó:
    1. `color-scheme: dark` trên chính <select> -> Chromium dựng popup bằng bộ màu tối
       (nền, viền, dải đang chọn, thanh cuộn);
    2. màu đặt trên <option>/<optgroup> -> nền + chữ của từng dòng.
  Trước đây app không đặt cả hai nên popup ra TRẮNG giứa một app tối — lộ nhất ở
  những ô trong `.fig-field` (độ dày chữ, kiểu khử ồn…) vì chính CSS của `.fig-field`
  đặt `background: transparent !important`, popup lấy nền trong suốt rồi rơi về trắng.
  Sửa: hai luật toàn cục cạnh `input, select, textarea` trong index.html.
  `color-scheme` ĐẶT RIÊNG CHO <select>, KHÔNG đặt ở `:root`: ở :root nó đổi luôn thanh
  cuộn và mọi ô nhập native của cả trang, mà app đã tự vẽ những thứ đó.
  LƯU Ý KHI KIỂM: ảnh chụp qua CDP/DevTools KHÔNG bắt được popup (nó nằm ở tiến trình
  khác). Kiểm bằng computed style: `getComputedStyle(sel).colorScheme === 'dark'` và
  `getComputedStyle(sel.options[0]).backgroundColor`.
```

### LỀ CHỮ ↔ MÉP NỀN (ô W/H của khối Nền, kiểu CapCut) (2026-09-10)

```text
CapCut cho kéo Height/Width của nền để chữ thoáng hay chật trong hộp màu. Ở đây là hai ô
  "W"/"H" ngay dưới hàng R/O của khối "Nền" — DÙNG CHUNG cho text thường và mẫu văn bản
  (cùng một bộ control, `patchTextStyle` đã tự định tuyến vào item.style hoặc vào
  override của lớp chữ đang chọn).

ĐƠN VỊ LÀ % CỠ CHỮ, KHÔNG PHẢI PX. Lề px thì đổi cỡ chữ là tỉ lệ hỏng ngay, và còn phải
  thêm vào danh sách khoá mà `rescaleOverlaysForSequenceResize` nhân theo độ phân giải
  Sequence — một chỗ nữa để bỏ sót. Theo % thì cả hai vấn đề tự hết.

`bg_pad_x` / `bg_pad_y` = null là "Auto" = ĐÚNG công thức cũ `max(10, ceil(0.28·cỡ chữ))`.
  KHÔNG đổi thành 28% phẳng: sàn 10px đang có tác dụng thật với chữ nhỏ (< 36px), đổi
  là mọi block chữ nhỏ của dự án cũ co lại.
  CẠM BẪY ĐÃ VẤP: `Number(null)` ra 0 chứ không phải NaN, nên `if (Number.isFinite(...))`
  hiểu `bg_pad_x: null` của style mặc định là "lề 0%" và MỌI textbox mất sạch phần đệm.
  Mọi chỗ đọc khoá % phải đi qua `padPctOrNaN` (editing-runtime) / `pct` (text-templates).

LỀ LÀ CỦA HỘP CHỮ, không chỉ của nền: hộp chữ (= khung transform, cũng là hộp nền) vốn
  = chữ + lề. Nên hai ô vẫn có tác dụng khi tắt nền (đúng như `padding` vẫn làm từ trước),
  cùng kiểu với R/O — hai ô đó cũng luôn hiện dù nền đang tắt.

BA CHỖ PHẢI DÙNG CÙNG HAI SỐ (bỏ sót một chỗ là preview lệch bản xuất):
  1. `measureTextItemBox` -> trả `padX`/`padY` (thay cho `padding` cũ) và cộng vào
     width/height/contentWidth;
  2. preview DOM -> `el.style.padding = padY px padX px`;
  3. `drawTextItemContent` -> ngang dùng padX (lineX0/anchorX), dọc dùng padY
     (lineContentTop).

MẪU VĂN BẢN: hộp nền đo từ video CapCut bám dải ascender→descender nên KHÔNG cân đối
  ("Quote": 9px trên dải chữ hoa / 18px dưới baseline). Ô "H" vì thế bày ra TRUNG BÌNH hai
  phía, và khi ghi thì `textBgPadPatch` GIỮ ĐÚNG TỈ LỆ 9:18 đó (ghi `bg_pad_top`/
  `bg_pad_bottom`, không ghi `bg_pad_y`) — làm phẳng thành hai lề bằng nhau là mất số đo
  của mẫu ngay ở cú kéo đầu tiên.

Test: `npm run test:magic-fill-text` (mục 2e và 2b của tests/scripts/magic_fill_text_defaults.js)
  — lề Auto bằng đúng công thức cũ, hai trục độc lập, 0% là 0px, ô H của mẫu giữ tỉ lệ
  trên/dưới, và cả ba chỗ trên dùng chung padX/padY (soi mã nguồn).
```

### Chuẩn Hoá Mẫu "Custom": Cỡ Chữ Chốt Lúc Tạo, Hình Có Cỡ Riêng (2026-09-16)

```text
BỐN YÊU CẦU NGƯỜI DÙNG CHỐT, và vì sao bản trước không đáp ứng được:

(1) CỠ MẶC ĐỊNH LÚC TẠO = 65% bản cũ.
(2) CHỈNH ĐƯỢC CỠ + VỊ TRÍ của Icon/Illus trong bảng thông số.
(3) Icon/Illus KHÔNG đổi cỡ khi nội dung hay khổ hộp chữ đổi — chỉ giữ VỊ TRÍ tương đối.
(4) Thêm/bớt chữ thì CỠ CHỮ đứng yên, chỉ hộp chữ tự nở/co.

GỐC RỄ. Mẫu "Custom" khai `fitWidth: 880` ("thiết kế rộng tối đa bấy nhiêu") nên mỗi lần
đo lại, CẢ MẪU bị co cho vừa 880 — cỡ chữ là hệ quả của nội dung, không phải một con số.
Đo trên chính mẫu (thước đo của test): câu mặc định hai dòng ra 34px, còn "chất đạm" (một
dòng ngắn) ra 96px. Cạnh hình thì `sizeRel × chiều cao hộp chữ`, mà chiều cao hộp nở theo
SỐ DÒNG -> hình cũng nhảy theo. Trên dự án thật ("Yêu Con 1") bốn cụm cùng kiểu ra bốn cỡ
chữ và bốn cỡ hình khác nhau.

CÁCH SỬA — hai thay đổi, mỗi thứ một tầng:

A. TẦNG ENGINE (`text-templates.js`) — hình có cỡ riêng.
   · `measureTextLayer` trả thêm `baseHeight` = chiều cao hộp NHƯ THỂ chỉ có MỘT dòng
     (dải chữ hoa + đệm trên/dưới). Cả ba thành phần đều tỉ lệ thuần với CỠ CHỮ (đệm là %
     cỡ chữ, xem `bg_pad_top`), và `capHeight` đo từ chữ 'H' nên không đổi theo chuỗi ->
     `baseHeight` đứng yên với mọi nội dung, vẫn co giãn đúng khi đổi cỡ chữ.
   · `measureImageLayer` nhận `baseHeight` thay cho chiều cao hộp thật. Ca MỘT DÒNG (đúng
     ca mà bản vẽ được đo) ra y hệt bản cũ, nên mọi tỉ lệ thiết kế giữ nguyên; chỉ block
     nhiều dòng là hình thôi phình theo.
     HÌNH VECTOR (`fit`) KHÔNG đổi: hai thẻ vàng của "Vlog Tag" là bản sao lệch chỗ của
     chính hộp chữ, chúng PHẢI trùm theo hộp thật.
   · Ba khoá override MỚI cho lớp ảnh — `scale` (% so với thiết kế, kẹp 10..400), `dx`/`dy`
     (px@1080). Ghi vào layer thành `artScale/artDx/artDy` để không đụng `place`. Độ lệch
     cộng SAU mọi số của thiết kế nên nó là "xê dịch so với chỗ đậu gốc": đổi kiểu
     Icon <-> Illus (hai chỗ đậu khác hẳn nhau) vẫn giữ nguyên ý người dùng.
     Whitelist của `resolve()` nới từ 3 lên 6 khoá; `place`/`variants`/`anim` vẫn khoá chặt.

B. TẦNG BLOCK (`editing-runtime.js`) — cỡ chữ chốt MỘT LẦN lúc tạo.
   `freezeTemplateTextSize(item, ratio)`: phép tự co vẫn quyết định cỡ BAN ĐẦU (nó chính
   là thiết kế — chữ dài thì mẫu nhỏ lại), nhưng chỉ chạy ĐÚNG MỘT LẦN. Cỡ đang vẽ được
   ghi thành `font_size` của block, và chính khoá ấy TẮT phép tự co (`fontSizeLocked`).
   VÌ SAO KHÔNG SỬA THẲNG `font.size` TRONG MẪU: một con số cố định không thể vừa cho cả
   "chất đạm" lẫn một câu bốn dòng — đó đúng là lý do `fitWidth` ra đời. Chốt theo TỪNG
   BLOCK giữ cái hay (mỗi block tự chọn cỡ hợp với chữ của nó) mà bỏ cái dở (cỡ nhảy khi
   sửa chữ).
   PHẢI GỌI SAU `preloadTemplateFonts`: đo bằng font dự phòng là chốt nhầm VĨNH VIỄN (chốt
   xong không đo lại nữa). Bốn chỗ gọi:
     · `addTextTemplateItem` / `switchTextTemplate` — trong `.then()` của preload, ratio
       = TEMPLATE_CREATE_SIZE_RATIO (0.65) -> yêu cầu (1);
     · Magic Fill — SAU `magicFitTemplateItemText` (gói dòng vẫn chạy trên phép tự co như
       cũ, chốt xong mới hạ 65%; làm ngược lại thì số dòng được chọn theo một cỡ chữ khác
       cỡ cuối cùng), rồi ĐO LẠI để neo vị trí;
     · handler sửa ô chữ — ratio 1, chốt cỡ ĐANG vẽ TRƯỚC khi ghi chữ mới. Đây là đường
       cho block của dự án CŨ: chúng chưa có cỡ chốt, không chặn ở đây thì vừa gõ một ký
       tự là cả mẫu co lại. ratio 1 = chỉ đóng băng, block trên timeline không đổi hình.
   Đo lại sau khi chốt: 65,0% cả bề rộng lẫn chiều cao, với mọi hình dạng nội dung.

PANEL: `templateArtSectionHtml` thêm hàng "Cỡ hình" (%) và "Lệch hình" (X/Y) + nút "Mặc
định" (XOÁ khoá chứ không ghi 100/0/0 — "không khai = đúng thiết kế gốc" là giao ước của
cả bảng override). Trần/sàn do engine bày ra (`scaleMin/scaleMax`), UI không tự đặt số.

ẢNH HƯỞNG TỚI DỰ ÁN CŨ: block Custom MỘT DÒNG không đổi gì (baseHeight = chiều cao hộp).
Block NHIỀU DÒNG có hình nhỏ lại (2 dòng: 145 -> 101 ở cỡ mặc định) và, vì cụm hẹp bớt,
phép tự co siết nhẹ hơn nên chữ to lên chút. Cỡ 65% chỉ áp cho block TẠO MỚI.

Test: npm run test:text-templates (C1 đổi mốc sang baseHeight; C3b cỡ hình đứng yên khi
đổi nội dung mà hộp vẫn nở/co; C3c ba khoá mới + kẹp trần/sàn + defaultOverrides).
```

### Magic Fill: Một Font, Một Cỡ Chữ Cho Mọi Thứ Đặt Xuống Timeline (2026-09-16)

```text
YÊU CẦU NGƯỜI DÙNG CHỐT:
 (1) Mọi text / text template Magic Fill đặt xuống đều dùng Nunito ExtraBold — nhưng KHÔNG
     được đổi font mặc định của chính các Text Template.
 (2) Dùng CÙNG một cỡ chữ, bất kể nội dung dài ngắn.

TRƯỚC ĐÓ, HAI ĐƯỜNG CÙNG LÀM CỠ CHỮ NHẢY:
 · TEXT BOX lấy font/độ đậm từ HIỆU ỨNG "Hồng kẹo" (fx7 → Poppins 900) và coi cỡ chữ là
   TRẦN (DEFAULT_TEXT_FONT_SIZE = 58), thu nhỏ dần cho tới khi gói vừa lưới an toàn.
 · MẪU "Custom" khai `fitWidth` nên CO CẢ MẪU cho vừa khổ — đo được cùng một mẫu ra 34px
   với câu hai dòng và 96px với một cụm ngắn. (Hai mẫu kia KHÔNG có tật này: `vlog-tag`
   cố định 97.5px, `zoom-title` cố định 144.3/51.1px.)

BA HẰNG SỐ LÀ NGUỒN SỰ THẬT DUY NHẤT, dùng cho CẢ HAI đường:
    MAGIC_FILL_FONT_FAMILY = 'Nunito'
    MAGIC_FILL_FONT_WEIGHT = 800        // ExtraBold
    MAGIC_FILL_FONT_SIZE_1080 = 48      // px@1080
Cỡ viết ở LỚP 1080 như mọi số đo khác của Magic Fill: đường text box nhân `scaledTextPx`,
đường mẫu ghi thẳng vào override (layout mẫu đã nhân `px_scale`) — cùng nghĩa, 4K ra 96.

VÌ SAO 48. Đo mẫu "Custom" với bốn nhãn của dự án thật (lưới an toàn ngang ≈ 907px@1080):
ở 36 cụm dài nhất chỉ chiếm 64% bề ngang khung — nhỏ hơn hẳn diện mạo cũ; ở 48 chúng chiếm
47–85% và cụm dài nhất tự xuống hai dòng. Xuống dòng mới là cách giữ cỡ chữ
(magicSplitToMaxLines / magicFitTemplateItemText), không phải thu nhỏ chữ.

BỐN CHỖ SỬA:
 1. `magicFillTextPatch` ÉP font SAU patch của hiệu ứng — "Hồng kẹo" vẫn quyết định
    màu/nền/viền, chỉ hai khoá font bị giành lại.
 2. `magicFillFontSize()` đổi từ DEFAULT_TEXT_FONT_SIZE sang hằng riêng: cỡ 58 của textbox
    thêm tay quá to cho mẫu (cụm dài nhất tràn lưới an toàn), nên hai con số phải tách.
 3. Font/độ đậm dùng để ĐO trong `magicFill()` lấy từ hằng, KHÔNG từ hiệu ứng nữa — đo
    theo hiệu ứng trong khi vẽ bằng font đã bị ép là gói dòng sai, box lòi lưới. Kèm
    `await awaitTextFontLoaded(...)`: `preloadTemplateFonts` chỉ nạp font của THIẾT KẾ mẫu,
    không biết tới font ta ghi đè ở tầng block.
 4. `magicFillTemplateItem` ghi font + cỡ vào `overrides` của TỪNG BLOCK -> thiết kế gốc
    của mẫu không bị đụng (yêu cầu 1). Khoá `font_size` này cũng TẮT phép tự co của mẫu,
    nên sửa chữ về sau cỡ cũng không nhảy — và phép gói dòng chạy trên ĐÚNG cỡ cuối cùng
    (trước đó phải chốt cỡ sau khi gói dòng, nay không cần nữa).

CHUẨN HOÁ THEO LỚP CHỮ CHÍNH, KHÔNG ÉP MỌI LỚP VỀ MỘT SỐ. "Zoom Title" có hai lớp với
phân cấp cố ý 2.8:1. Phân cấp KHÔNG phải thứ người dùng phàn nàn — cái họ gặp là cỡ nhảy
THEO NỘI DUNG. Nên dùng MỘT hệ số cho cả mẫu, chọn sao cho lớp chữ LỚN NHẤT rơi đúng 48:
    custom      120.0 -> 48
    vlog-tag     97.5 -> 48
    zoom-title  144.3 -> 48   |   dòng phụ 51.1 -> 17.0 -> KÉO LÊN 34 (sàn)
Nhìn trên khung hình thì CHỮ CHÍNH của mọi khối bằng nhau, mà tỉ lệ trong từng mẫu vẫn
còn. Phép chuẩn hoá thuần tỉ lệ đẩy dòng phụ của Zoom Title xuống 17px@1080 — đọc không
nổi — nên có thêm SÀN `MAGIC_FILL_MIN_LAYER_FONT_1080 = 34` (người dùng chốt). Cỡ mỗi lớp
bị kẹp vào [sàn, cỡ lớp chính]: sàn để dòng phụ đọc được, trần để một lớp phụ không bao
giờ vượt lớp chính (phân cấp bị lộn ngược). Zoom Title vì thế còn 48:34 = 1.41:1 — vẫn
thấy rõ đâu là tiêu đề. Sàn KHÔNG chạm tới lớp chính (luôn = 48 > 34).

BẢN XUẤT KHÔNG CẦN SỬA BACKEND: bảng EDITING_FONT_FILES chỉ map family -> file Regular và
chỉ phục vụ nhánh drawtext, mà nhánh đó không bao giờ chạm block text (renderer luôn gửi
kèm `rendered_text_png`, bake bằng font thật trong trình duyệt).

Test: npm run test:magic-fill-text (ba hằng số, cỡ 48/96, font ép sau patch hiệu ứng,
override của block mẫu, chuẩn hoá theo lớp lớn nhất, có file Nunito_800ExtraBold.ttf).
```

### Subtab "Mẫu" — Đổi Text Template Ngay Trên Block Đang Chọn (2026-09-10)

```text
Tab "Văn bản" của Inspector nay có 3 subtab: Cơ bản / Mẫu / Biến đổi. Subtab "Mẫu" là
  LƯỚI TOÀN BỘ MẪU của app; bấm một mẫu là block đang chọn đổi sang mẫu đó (như CapCut),
  không phải xoá đi thêm lại từ panel trái.

CHỈ HIỆN VỚI MẪU, KHÔNG CẦN CỜNG NÀO RIÊNG: danh sách subtab được lọc theo section CÓ
  THẬT trong panel (`presentSubs` trong refreshInspectorTabs), mà section
  `data-ins-sub="template"` chỉ được dựng khi `isTextTemplate` — text thường tự không
  có tab này.

LƯỚI DÙNG LẠI THẺ + CANVAS THUMBNAIL CỦA PANEL TRÁI (cùng class `edit-transition-card`,
  cùng `data-text-template-thumb`) nên `initTextTemplateThumbs(extra)` vẽ được ngay và
  hover cũng chạy hoạt ảnh thật — không có đường vẽ thumbnail thứ hai để lệch nhau.
  (Thẻ của mẫu đang dùng được đánh `is-selected` — class sẵn có của thẻ mẫu.)
  Hover mẫu "Quote" bắt đầu bằng KHUNG TRỐNG là ĐÚNG: hoạt ảnh của nó mở ra từ khung 14
  (dấu nháy alpha 0) và chữ chỉ lộ ra từ khung 23.

`switchTextTemplate(item, id)` ĐỔI TẠI CHỖ, ba quyết định:
  1. GIỮ CHỮ THEO THỨ TỰ Ô. Mẫu có thể khác số ô ("Quote" 2 ô, "Approved" 1 ô): ô nào
     mẫu mới không có thì bỏ, ô mới thừa ra thì lấy mặc định của mẫu. Ô cũ ĐANG TRỐNG
     cũng lấy mặc định — nếu không, đổi mẫu ra một block trắng trơn và người dùng
     tưởng mẫu bị lỗi.
  2. BỎ `overrides`. Khoá của bảng là khoá LỚP của mẫu cũ và giá trị là số đo của thiết
     kế cũ: đặt cỡ chữ 147.4 của "Approved" lên "Quote" là vỡ hình, mà giữ phần "trùng
     khoá" thì càng khó lường (hai mẫu đều có lớp `title` nhưng font/cỳ/nền khác hẳn).
  3. GIỮ `px_scale` của block, KHÔNG lấy lại `sequenceTextScale()`: nó là hệ số px@1080
     -> px Sequence của CHÍNH block này, sẽ sai nếu người dùng đã đổi độ phân giải
     Sequence sau khi tạo block (lúc đó `rescaleOverlaysForSequenceResize` đã ghi một
     px_scale khác).
  Block giữ nguyên id, chỗ đứng, thời lượng, transform, keyframe — chỉ `item.template`
  được thay. Thời lượng KHÔNG nhảy theo `duration` của mẫu mới (CapCut cũng vậy).
  `templateActiveLayerByItem` giữ khoá lớp cũ nhưng `templateActiveTextKey` tự rơi về lớp
  chữ đầu tiên khi khoá đó không còn — không cần dọn tay.
```

### Panel Là MỘT Kho Tệp — Lane Chính Là Đích Đến (2026-08-16)

```text
TRƯỚC: panel chia tệp làm HAI HẠNG.
  - nút "Video nguồn" -> projectVideoLibrary -> vào được LANE CHÍNH, là nguồn bóc băng;
  - nút "Nhập tệp"/"Thư mục" -> editingAssets -> CHỈ đặt được lên lane overlay.
  Cùng một file .mp4, nhập bằng nút nào thì dùng được ở chỗ nấy. Người dùng báo: sai hẳn
  với mọi NLE chuyên nghiệp, nơi media pool là một và track là ĐÍCH ĐẾN chứ không phải
  một hạng tệp.

NAY: panel là MỘT kho. Video nào có ĐƯỜNG DẪN THẬT trên máy đều lên lane chính được, và
  lên rồi thì video ĐÓ là nguồn của dự án (đầu vào của "Lọc video theo kịch bản").

BỐN ĐƯỜNG ĐƯA LÊN LANE CHÍNH — tất cả đổ về window.addSourcePathsToMainLane(paths):
  1. nút "+" trên thẻ video (xanh lá) — data-edit-asset-main;
  2. kéo-thả thẻ (một hoặc cả vùng chọn) xuống ĐÚNG DẢI LANE CHÍNH;
  3. nút gộp "Thêm vào lane chính (n)" ở thanh vùng chọn;
  4. ô "Thêm N video" ở CUỐI lưới thư mục (2026-08-23) — xem mục ngay dưới.
  Hàm đó lọc đường dẫn ĐÃ CÓ, scanDesktopSourcePaths() những đường dẫn MỚI (đưa cả danh
  sách cũ vào là thư viện mọc bản trùng), rồi rebuildMainLane({appendPaths}) như cũ — mọi
  lời hứa "thêm video không làm lệch cái đã dựng" ở mục trên giữ nguyên, không đụng vào.

VÌ SAO VẪN ĐÒI source_path: /api/project/reingest nối file bằng ffmpeg. Tệp tải lên qua
  trình duyệt không có đường dẫn thật -> chỉ dùng được ở lane overlay. assetCanJoinMainLane()
  là chỗ duy nhất quyết định điều đó.

KHÔNG CÒN HAI THẺ CHO MỘT FILE — hai chốt, cần cả hai:
  - syncProjectSourceAssets() BỎ QUA việc dựng thẻ 'project' nếu kho đã có asset cùng
    source_path (đường đi thường gặp: người dùng tự nhập rồi mới đưa lên lane chính);
  - importPaneAssets() khử trùng lúc VẼ và nay giữ THẺ CỦA NGƯỜI DÙNG, bỏ bản 'project'
    (ngược với trước 16/08). Thẻ người dùng nằm đúng thư mục họ nhập vào và có nút "×";
    thẻ 'project' chỉ còn là bản dự phòng cho nguồn đến từ giai đoạn Upload / .crab cũ.
  KHÔNG xoá asset khỏi editingAssets ở cả hai chỗ: block trên timeline giữ asset_id, xoá
  là block hoá trống mà không có lỗi nào báo.

Ô TÍCH "NGUỒN LỌC" TRÊN THẺ ĐÃ BỎ (cùng window.setProjectSourceSelected): nguồn của luồng
  bóc băng nay CHÍNH LÀ video đang nằm trên lane chính, không còn danh sách chọn riêng.
  projectVideoLibrary[].selected VẪN CÒN — màn hình duyệt lại ở giai đoạn Upload dùng nó để
  bỏ bớt video trước khi bóc băng, và .crab cũ vẫn đọc được. Không nâng phiên bản payload.

CHỌN NHIỀU THẺ: Cmd/Ctrl+click bật/tắt, Shift+click chọn cả dải, click thường vẫn là MỞ
  XEM TRƯỚC (không đổi thói quen cũ) và bỏ vùng chọn như mọi trình quản lý tệp.
  - Giữ theo asset id, KHÔNG theo phần tử DOM: panel vẽ lại nguyên lưới sau mỗi thao tác.
  - panelRenderedAssetIds ghi ĐÚNG THỨ TỰ VẼ của thư mục đang mở — Shift+click cần dải liên
    tục, đọc từ editingAssets là sai thứ tự ngay khi có thư mục con.
  - Kéo một thẻ ĐANG trong vùng chọn = kéo cả vùng chọn; kéo thẻ ngoài vùng chọn thì chỉ nó.
  - Thả cả lô xuống lane OVERLAY: xếp nối tiếp từ điểm thả, recordHistory() MỘT LẦN cho cả
    lô (hoàn tác từng cái sau khi thả 10 tệp là cực hình). addItemForAsset() nay TRẢ VỀ block
    vừa tạo để vòng lặp biết block trước kết thúc ở đâu.

NÚT "+" TRÊN THẺ VIDEO đổi nghĩa: chưa ở lane chính -> thêm vào LANE CHÍNH (xanh lá); đã ở
  lane chính -> quay về nghĩa cũ (đặt một bản lên lane overlay tại playhead). Nhờ vế sau,
  đường thêm overlay bằng MỘT cú bấm vẫn còn — không mất đi. Ảnh/âm thanh giữ nguyên nghĩa cũ.

THẢ XUỐNG LANE CHÍNH sáng CẢ LANE (#editingMainLaneDropZone) chứ không vẽ vạch chèn như
  lane overlay: vị trí thả KHÔNG quyết định gì — reingest nối lại cả chuỗi nên video luôn
  vào CUỐI. Một vạch chỉ chỗ ở đây là lời hứa sai.

Huy hiệu "LANE CHÍNH" trên thẻ LUÔN hiện (khác nút ×/+ chỉ hiện khi rê chuột): nó là TRẠNG
  THÁI, người dùng phải nhìn ra ngay video nào đang là nguồn của phim.
```

### Một Kịch Bản, Ba Chỗ Hiển Thị + Đường Lui Của Luồng Lọc (2026-08-17)

```text
LỖI GỐC — ĐỆ QUY VÔ HẠN, im lặng nuốt mọi lần nạp tệp kịch bản:
  window.handleScriptFile = (file) => handleScriptFile(file);
Script inline của index.html chạy ở PHẠM VI TOÀN CỤC, nên `function handleScriptFile` CHÍNH
LÀ window.handleScriptFile. Dòng trên gán đè nó bằng một arrow gọi lại `handleScriptFile` —
tức arrow gọi CHÍNH NÓ. Mọi đường nạp tệp (nút "Chọn tệp kịch bản" ở tab Kịch bản, kéo thả,
ô chọn tệp bước Upload) nổ RangeError "Maximum call stack size exceeded" rồi im lặng không
nạp gì. Đây mới là lý do người dùng báo "kịch bản thêm vào không hiện ở đâu cả".
SỬA: đổi tên hàm khai báo thành loadScriptFile() để tên nội bộ KHÔNG trùng tên phơi ra
window. Không dựa vào "xoá dòng gán là xong": script này đang ở phạm vi toàn cục hôm nay,
bọc nó vào IIFE ngày mai là hỏng lại mà không ai nhớ vì sao.

MỘT KỊCH BẢN, BA CHỖ HIỂN THỊ:
  #refScriptInput   nguồn sự thật (ô nhập bước Upload)
  #editScriptText   ô nhập ở tab "Kịch bản" của Editing — GƯƠNG, sửa được
  #refScriptCompare "Kịch bản chuẩn (Đối chiếu)" ở cột giữa — chỉ đọc
Mọi đường đổi kịch bản nay đi qua syncReferenceScriptViews(). Trước đây ô Đối chiếu chỉ được
vẽ ở hai chỗ lẻ (mở .crab, sau khi bấm So khớp) nên gõ/nạp tệp ở Editing không tới được nó.

currentReferenceScriptText() chọn nguồn THEO BƯỚC: step1/step2 dùng #refScriptReview (luồng
lọc cũ cho sửa bản "đang hiệu chỉnh" trước khi bóc lại), ngoài ra dùng #refScriptInput. Vì
thế showStep() cũng phải gọi lại sync — đổi bước là đổi nguồn.

CHỐNG GIẬT: vẽ ô Đối chiếu là dựng một <span> mỗi câu + dò cụm in đậm, làm ngay trong sự
kiện 'input' thì kịch bản vài nghìn chữ là thấy khựng -> gộp lại 120ms. Đường "thay toàn bộ
chữ" (nạp tệp, mở dự án, đổi bước) dùng immediate:true vì không có ai đang gõ.
keepPaneText:true khi người dùng đang gõ: chỉ cập nhật dòng trạng thái, KHÔNG dựng lại
textarea — dựng lại là con trỏ nhảy về đầu sau mỗi phím.

THANH TIÊU ĐỀ vs BREADCRUMB — chốt lại 17/08:
  - Nút "Trang chủ" LUÔN nép trái (`.project-titlebar { margin-right:auto }`).
  - Tên dự án nằm trong ô riêng `.titlebar-name-slot` -> ở Editing neo tuyệt đối vào giữa
    header mà KHÔNG kéo nút Trang chủ đi theo; dấu "/" ẩn đi vì không còn nối hai thứ đứng
    cạnh nhau. Đo @1600px: tâm ô tên = 800 = đúng tâm cửa sổ.
  - Breadcrumb TẮT HẲN ở Editing: cờ `flow-script-filter` nay đòi CẢ HAI điều kiện —
    projectFlowMode === 'script-filter' VÀ stepId !== 'step4'. Trước đây chỉ xét cờ luồng
    nên dự án đã đi qua lọc thì về Editing breadcrumb vẫn treo và tranh chỗ với tiêu đề.
    (Đường quay lại vẫn còn: nút "Quay lại Timeline" trong panel Editing.)

THANH TIÊU ĐỀ vs BREADCRUMB (chỉ va nhau ở luồng lọc):
.header-bar là space-between với 3 con TRONG LUỒNG (logo · thanh tiêu đề · nhóm phải) nên
thanh tiêu đề rơi vào khoảng giữa — đúng chỗ .breadcrumb-container (absolute, left:50%)
đứng. Sửa bằng cách cho breadcrumb THAM GIA LUỒNG ở riêng body.flow-script-filter: nó thành
ô co giãn nằm GIỮA thanh tiêu đề và nhóm phải, flexbox tự lo, không cách nào đè nhau ở bất
kỳ bề rộng nào. Về Editing thì breadcrumb tắt và mọi thứ trở lại y như cũ.
ĐÃ THỬ VÀ BỎ: chỉ đẩy tiêu đề sang trái (margin-right:auto) rồi hạ trần bề rộng tên. Đo ở
1200px (đúng minWidth cửa sổ Electron) với tên dài thì logo + nút Trang chủ + tên VẪN chạm
mép trái breadcrumb. Chỉnh số cho vừa một bề rộng là sai ở bề rộng khác.
Đo sau khi sửa @1600px: tiêu đề 117–301 (trái) · breadcrumb 311–1128 | Editing: 536–720
(giữa), breadcrumb display:none.

GIAI ĐOẠN UPLOAD nay CHỈ là bước duyệt lại của luồng lọc, nên bỏ hẳn đường thêm video ở đó
(ô "+", ô trống bấm-để-thêm, kéo-thả vào thư viện, triggerAddVideoSource): video thêm ở đấy
không có đường nào lên lane chính để mà lọc — một ngõ cụt. Thêm video là việc của panel Tệp
phương tiện ở Editing.
VẪN phải preventDefault dragover+drop trên #videoLibrary dù đã bỏ tính năng: bỏ trắng thì
trình duyệt MỞ THẲNG tệp được thả và mất cả phiên làm việc.
Thêm #btnCancelScriptFilter ("Quay lại Editing (không lọc)") — trước đó không có đường lui
nào ngoài bấm Trang chủ và bỏ cả dự án. Nút PHẢI trả projectFlowMode về 'editing-first' chứ
không chỉ showStep('step4'): cờ đó mới là thứ bật breadcrumb (xem showStep). Trừ khi dự án
ĐÃ đi qua luồng lọc trước đó (có rawSegments/mappedChunks) — lúc ấy breadcrumb vẫn có nghĩa,
cùng phép suy ra mà lúc mở .crab dùng.
```

### "Dự Án Mới" Còn Sót Hình Của Dự Án Cũ (đã sửa 2026-08-17)

```text
TRIỆU CHỨNG: mở một .crab cũ -> Menu > "Dự án mới" -> timeline trống trơn nhưng khung
preview VẪN hiện hình dự án vừa mở, kèm đồng hồ (00:31.70 / 00:44.62) và huy hiệu kích
thước của dự án đó.

VÌ SAO /api/reset-project KHÔNG ĐỦ: nó xoá sạch temp_uploads phía backend, nhưng
  1. thẻ <video> của trình duyệt ĐÃ giải mã xong và giữ khung hình trong bộ nhớ của nó —
     file nguồn biến mất không làm nó quên;
  2. NẶNG HƠN: ở Editing người dùng nhìn CANVAS PIXI chứ không nhìn thẻ <video> (nó bị thu
     còn 1px, opacity 0 khi .pixi-ready), mà texture PIXI giữ khung cuối TRONG GPU. Dọn thẻ
     <video> thôi vẫn còn hình.
startBlankProject() trước đây không đụng tới cả hai thứ này, cũng không reset
videoDuration / sequenceSettings / các URL preview.

SỬA — resetPreviewStage(), gọi từ startBlankProject():
  - video.pause(); removeAttribute('src'); load()  <- load() LÀ CHỖ MẤU CHỐT, chỉ gán src=''
    thì Chrome giữ nguyên khung đã vẽ;
  - xoá videoDuration + 4 biến URL preview (original/ready/pending/active) + dừng poll proxy;
  - sequenceSettings và sourceVideoInfo về mặc định — chúng là thiết lập của DỰ ÁN, không
    phải của ứng dụng (huy hiệu 640x360 của dự án cũ còn treo là do đây);
  - syncPlayPauseButton(): nhãn nút chạy theo sự kiện 'play'/'pause', mà video ĐANG dừng thì
    pause() không phát sự kiện nào -> nhãn "Pause" sót lại từ lần phát trước;
  - updateSequencePreviewTransform() để canvas PIXI vẽ lại.
Và trong SequencePixiPreviewRenderer.resizeAndRender():
    this.sprite.visible = Number(this.videoEl?.videoWidth) > 0;
  Đây là chốt chặn cho vế (2). Cũng đúng cho quãng ngắn video mới gán src mà chưa có
  metadata: thà trống còn hơn hiện nhầm hình của nguồn cũ.

GIÁ TRỊ KHỞI TẠO tách thành hằng số DEFAULT_SEQUENCE_SETTINGS / DEFAULT_SOURCE_VIDEO_INFO
rồi cả chỗ khai báo lẫn chỗ reset cùng dùng. Viết một bản literal thứ hai ở chỗ reset là
sớm muộn hai bên lệch nhau, mà lệch kiểu này không có lỗi nào báo.

KIỂM CHỨNG: chụp trạng thái ngay sau "khởi động + tạo dự án mới" làm chuẩn, rồi nạp video,
tua tới giữa, CHO PHÁT, mới bấm "Dự án mới" -> 6/6 trường (đồng hồ, tỷ lệ, fps, nhãn nút
Play, videoWidth, duration) khớp từng chữ với bản chuẩn. Nạp video lại sau đó vẫn hiện hình
bình thường (chốt chặn sprite.visible không kẹt ở trạng thái ẩn).
```

### Ô "Thêm Cả Thư Mục Vào Lane Chính" (2026-08-23)

```text
VẤN ĐỀ: máy quay cắt một buổi quay thành 13 file rời trong CÙNG một thư mục. Đưa chúng
  lên lane chính là 13 lượt bấm "+" trên 13 thẻ — và mỗi lượt là MỘT lần nối lại toàn bộ
  nguồn bằng ffmpeg (rebuildMainLane), tức 13 lần chờ chứ không phải một.

Ô "THÊM N VIDEO" — thẻ thứ (n+1) của lưới, ngay SAU video cuối cùng của thư mục đang mở.
  Icon: hai dấu "+" lồng nhau (#ic-plus-double). Bấm một cái -> mọi video trong thư mục
  nối vào CUỐI lane chính trong MỘT lượt addSourcePathsToMainLane().

  VÌ SAO LÀ Ô TRONG LƯỚI, không phải nút trên thanh đầu panel: hành động "lấy hết dãy này"
  phải nằm ngay ở cuối dãy nó nói tới. Thanh đầu đã có nút "Nhập" (nạp tệp TỪ máy VÀO
  panel) — đặt cạnh nhau một nút nạp vào, một nút đẩy xuống timeline là mời bấm nhầm.

ĐIỀU KIỆN HIỆN: thư mục đang mở có TỪ 2 VIDEO trở lên. Một video thì nút "+" xanh trên
  chính thẻ đó đã làm đúng việc này. Chỉ ở tab "Tệp phương tiện" (kind==='media').
  Đếm theo video ĐƯA LÊN LANE CHÍNH ĐƯỢC (assetCanJoinMainLane = là video + có
  source_path): tệp tải qua trình duyệt không có đường dẫn thật nên /api/project/reingest
  không nối được — đếm cả chúng vào thì ô hiện ra mà bấm không ra gì.
  Thêm hết rồi -> ô Ở LẠI nhưng mờ đi, nhãn "Đã thêm hết", bỏ data-attr nên bấm không ăn.
  (Cho ô biến mất thì lưới nhảy một dòng ngay dưới con trỏ — người dùng tưởng bấm hụt.)

THỨ TỰ = TÊN TỆP: sort localeCompare('vi', {numeric:true}) nên "b_2" đứng trước "b_10".
  Thứ tự vẽ của panel KHÔNG phải thứ tự này (panel giữ thứ tự nguồn) — hai thứ khác nhau
  có chủ ý: người dùng đọc thumbnail theo thứ tự nào cũng được, còn timeline thì phải
  theo tên. Đường đi giữ được thứ tự vì addSourcePathsToMainLane -> rebuildMainLane gửi
  preserve_order:true xuống /api/project/reingest.

MỘT LƯỢT CHO CẢ DANH SÁCH, không lặp từng đường dẫn: rebuildMainLane có cờ
  mainLaneRebuildInFlight, gọi chồng lượt là lượt sau bị từ chối và IM LẶNG mất phần còn
  lại của danh sách.

CODE (static/js/editing-runtime.js): folderBulkMainVideos() / folderBulkMainPendingPaths()
  / folderBulkMainCardHtml() — lúc VẼ và lúc BẤM đều đi qua cùng hai hàm đầu nên con số
  trên nhãn luôn đúng bằng số video sẽ thêm. Thẻ là <div role="button"> chứ không phải
  <button>: rule chung ".sidebar-left .step-panel button" đè mất kích thước ô lưới (cùng
  cái bẫy đã ghi ở .emt-reset) — bù lại phải bắc cầu Enter/Space sang click bằng một
  listener keydown trên #step4.
```

### Sóng Âm Lane Chính Kẹt Ở Bản Cũ (đã sửa 2026-08-17)

```text
TRIỆU CHỨNG người dùng báo: bóc băng xong chỉ BLOCK ĐẦU TIÊN có sóng âm, các block sau
trống trơn; qua Match Script vẫn thế; sang Editing thì KHÔNG block nào có sóng.

NGUYÊN NHÂN — bộ nhớ đệm RAM của AudioWaveform không bao giờ được làm mới:
  ensure(key, url) nạp lại một nguồn KHI VÀ CHỈ KHI url đổi (`entry.url !== url`).
  URL của lane chính là hằng số "/api/audio-peaks?source=main".
  => peak nạp MỘT LẦN rồi giữ nguyên suốt phiên, trong khi temp_input.mp4 bị DỰNG LẠI mỗi
     lần thêm video vào lane chính, mỗi lần bóc băng, mỗi lần lọc.
Khớp đúng triệu chứng: lúc peak được nạp lane chính mới có 1 video (~9s); sau khi nối lên
84s thì chỉ 9s đầu có dữ liệu -> block đầu có sóng, block sau không. Ở Editing các block
(sau khi lọc) trỏ vào mốc nguồn > 9s -> không block nào có sóng.
`AudioWaveform.reset()` có sẵn trong module nhưng KHÔNG CHỖ NÀO GỌI.

VÌ SAO KHÔNG PHẢI CACHE HTTP (đã loại trừ): module vốn fetch với `cache:'no-store'`, và
disk cache phía backend khoá theo sha1(path|size|mtime|version) nên tự invalidate đúng.
Chỉ tầng RAM là hỏng.

SỬA: URL peak lane chính mang theo phiên bản của temp_input.mp4 —
  /api/audio-peaks?source=main&v=<mtime>
`mainVideoVersion` đặt ở MỘT chỗ duy nhất: loadTranscribedVideoAndHydrateUI(), nơi mọi
đường dựng lại temp_input.mp4 (thêm video vào lane chính, bóc băng, mở .crab) đều đi qua và
vốn đã nhận `video_version` từ backend. Không thêm nguồn sự thật thứ hai.
index.html (mainPeaksSource) và editing-runtime.js (waveformMainSource) phải dựng ra CHUỖI
Y HỆT — cùng key 'main' — nếu không mỗi lần đổi giai đoạn lại nạp lại từ đầu, mất đúng cái
lợi mà key chung sinh ra để có. Đã kiểm: hai chuỗi bằng nhau.
`AudioWaveform.reset()` nay được gọi khi tạo dự án mới.

ĐO THẬT (2 video 8s có tiếng thật, dựng bằng ffmpeg vì clip trong library/ tuy CÓ rãnh aac
nhưng là im lặng số -91 dB nên sóng phẳng là ĐÚNG — mất một lượt chẩn đoán ở đây):
  URL cũ (cố định):  peak 12.05s -> thêm video, file dài 55s -> peak VẪN 12.05s (kẹt)
  URL mới (có v=):   peak  8.03s -> thêm video thứ 2 -> peak 16.07s, và vùng 8–16s có dữ
                     liệu sóng thật thay vì rỗng.
```

### Nạp Video Vào Lane Chính: Bộ Nhớ Đệm 2 Tầng (2026-08-17)

```text
TRIỆU CHỨNG: thêm một video vào lane chính chờ ~11s, và chờ ĐÚNG NGẦN ẤY mỗi lần, kể cả
khi 5 nguồn kia không đổi một byte. Lý do gốc nằm ở kiến trúc: lane chính đọc theo mốc thời
gian trong MỘT file temp_input.mp4, nên thêm một clip là phải NỐI LẠI CẢ BỘ.

ĐO TRƯỚC KHI SỬA (6 clip trong library/, 48.8 MB, chạy thật qua /api/project/reingest):
  lượt 1 (5 nguồn, nguội)   11547 ms
  lượt 2 (5 nguồn, y hệt)   11403 ms   <- không có gì đổi mà vẫn tốn ngần ấy
  lượt 3 (thêm nguồn thứ 6) 12781 ms
Đoán đầu tiên (phép chép file) là SAI: 48.8 MB chép hết vài trăm ms. Thủ phạm là
normalizeSourcesForConcat — các clip khác chữ ký luồng nhau nên MỌI nguồn bị libx264 mã hoá
lại, mỗi lượt, từ đầu.

HAI TẦNG ĐỆM, cùng một quy tắc hợp lệ: bản ra phải còn đó, khác rỗng, và MỚI HƠN nguồn.
  1. copyLocalSourcesToTemp -> tempCopyIsFresh(): so size + mtime với file gốc, khớp thì
     không chép lại. (copyFile KHÔNG giữ mtime nên bản chép luôn mới hơn nguồn; nguồn mới
     hơn bản chép = file gốc đã bị sửa -> chép lại.)
  2. normalizeVideoForConcat -> normalizedCopyIsFresh(): so mtime bản chuẩn hoá với BẢN CHÉP
     trong temp_uploads. Tầng 1 làm mtime bản chép đứng yên giữa các lượt — chính điều đó
     làm tầng 2 trúng. Thiếu tầng 1 thì tầng 2 không bao giờ trúng.

`withAudio` NẰM TRONG TÊN FILE (`source_003.mp4` vs `source_003_na.mp4`), không so ở ngoài:
cờ đó lật khi thêm một clip câm vào bộ toàn clip có tiếng, mà bản chuẩn hoá sai SỐ LUỒNG thì
concat sinh file hỏng KHÔNG báo lỗi (xem mục "nối video khác định dạng"). Cho vào tên là
không có đường nào lẫn.

`force` (lượt thử lại sau khi concat hỏng) BỎ QUA đệm: lúc đó đang đi đường cứu hộ, mã hoá
lại vài giây còn hơn dùng lại một bản có thể chính là thủ phạm.

concatStreamSignature() cũng có đệm riêng, khoá theo path+size+mtime: mỗi lượt trước đây tốn
2 ffprobe cho TỪNG nguồn, chạy TUẦN TỰ trước khi ffmpeg bắt đầu.
probeDurations() ở index.html đệm theo đường dẫn — cùng lý do, phía frontend.

ĐO SAU KHI SỬA (cùng máy, cùng bộ clip):
  lượt 1 (5 nguồn, nguội)   10348 ms   (không đổi — việc thật vẫn phải làm)
  lượt 2 (5 nguồn, y hệt)     137 ms   (83x)
  lượt 3 (thêm nguồn thứ 6)  1298 ms   (10x)  <- đúng thao tác người dùng làm
  lượt 4 (6 nguồn, y hệt)     147 ms

KIỂM CHỨNG ĐỆM TỰ HUỶ (ca nguy hiểm nhất — đệm khoá theo CHỈ SỐ, không theo nội dung):
bộ 3 nguồn CÓ chuẩn hoá, chạy 2 lượt rồi ĐỔI RUỘT file thứ 3 tại chỗ (giữ nguyên tên và vị
trí trong danh sách):
  lượt 1 (nguội)     6951 ms -> 49.58s
  lượt 2 (y hệt)      116 ms -> 49.58s
  lượt 3 (đổi ruột)  1832 ms -> 49.53s, khớp tổng độ dài MỚI (49.51s) chứ không phải cũ
-> chỉ file đổi được mã hoá lại, và kết quả đúng.

KHÔNG lẫn giữa hai dự án: /api/reset-project gọi resetProject() xoá sạch TEMP_DIR (cả
normalized_sources), nên dự án mới luôn bắt đầu với đệm nguội.

GIỚI HẠN ĐÃ BIẾT: so size+mtime, không băm nội dung — đọc để băm cũng tốn đúng lượng I/O
đang muốn tránh. File bị thay bằng file KHÁC có CÙNG size và mtime không mới hơn thì đệm
trúng nhầm. Mọi đường ghi file thông thường đều cập nhật mtime nên ca này chỉ xảy ra khi ai
đó cố tình dựng lại timestamp.
```

### Tab "Kịch Bản" + Lọc Video Theo Kịch Bản (2026-08-15)

```text
Kịch bản chuyển từ ĐIỀU KIỆN BẮT BUỘC (không có thì không qua nổi bước Upload) thành TUỲ
CHỌN: dựng phim không cần nó, chỉ hai tính năng cần — "Lọc video theo kịch bản" và Magic Fill.

TAB "KỊCH BẢN" (panel trái Editing, đặt ngay sau Tệp phương tiện)
  NGUỒN SỰ THẬT VẪN LÀ #refScriptInput; textarea trong tab chỉ là GƯƠNG.
  - Không dời hẳn node vào tab: renderEditPanel() ghi đè bodyEl.innerHTML mỗi lần đổi tab
    nên node sẽ bị huỷ, mà #refScriptInput còn là nguồn cho executeTranscription,
    collectProjectPayload và scriptMetadataForText.
  - Gõ vào gương -> ghi sang #refScriptInput rồi BẮN LẠI sự kiện 'input'. Nhờ vậy listener
    sẵn có lo cờ `stale` của metadata và Magic Fill, không nhân bản logic nào.
  - Chọn tệp: click ĐÚNG #fileScriptInput của bước Upload -> cùng listener 'change' ->
    handleScriptFile() lo cả .md/.txt/.doc/.docx.
  - Kéo-thả: preventDefault CẢ dragover LẪN drop; thiếu một trong hai là trình duyệt mở
    thẳng tệp và mất cả phiên làm việc.
  - refreshScriptPane({keepText}) : keepText=true khi người dùng ĐANG GÕ (chỉ cập nhật dòng
    trạng thái) — dựng lại textarea là con trỏ nhảy về đầu sau mỗi phím.

Ô TÍCH "NGUỒN LỌC" trên thẻ video
  Dùng chính projectVideoLibrary[].selected — trường ĐÃ CÓ, đã được
  getSelectedDesktopSourcePaths() và executeTranscription đọc, đã được lưu vào .crab
  (collectProjectPayload). Không tạo trường mới => 0 dòng cho persistence.
  - Bản sao hiển thị trên asset là `selected_for_filter`, PHẢI gán SAU addAssetRecord():
    hàm đó dựng object với danh sách khoá cố định, khoá lạ truyền vào bị vứt âm thầm.
  - Handler đặt TRƯỚC nhánh "mở xem trước", có stopPropagation, và KHÔNG renderEditPanel()
    (vẽ lại lưới thẻ là mất vị trí cuộn; trình duyệt đã tự lật `checked`).
  - Ô tích LUÔN hiện, khác nút ×/+ chỉ hiện khi rê chuột: nó là TRẠNG THÁI chứ không phải
    hành động, phải nhìn ra ngay video nào sẽ đi vào luồng lọc.
  - restoreProjectLibraryGroups() nay khôi phục cả `selected` — manifest vốn đã lưu nhưng
    chưa ai đọc, nên trước đây mở lại dự án là mọi video bị tích hết.
  - importPaneAssets() khử thẻ trùng LÚC VẼ (cùng source_path thì giữ thẻ 'project'), KHÔNG
    xoá asset: block trên timeline có thể đang trỏ vào bản nhập tay bằng asset_id.

ICON "LỌC VIDEO THEO KỊCH BẢN" (thanh công cụ Timeline, sau #btnAutoSfx)
  Nút KHÔNG bị khoá khi thiếu video/kịch bản — chỉ khoá khi ở ngoài Editing. Nút xám không
  nói được thiếu cái gì; ở đây thiếu thứ nào thì chỉ đúng chỗ thêm thứ đó (3 thông báo khác
  nhau cho: thiếu cả hai / thiếu video / thiếu kịch bản).

  ĐỦ ĐIỀU KIỆN -> projectFlowMode='script-filter' + showStep('step0'). TUYỆT ĐỐI KHÔNG gọi
  scanDesktopSourcePaths() ở đây: nó dựng lại projectVideoLibrary từ payload
  /api/video-sources/scan, mà payload đó KHÔNG có trường `selected` -> mọi video bị tích lại
  hết, phá đúng lựa chọn người dùng vừa làm, và selectedDesktopSourcePaths bị gán = mọi path.
  Không cần gọi: video đã nằm sẵn trong thư viện và đã đăng ký đường dẫn từ lúc thêm.

  QUAY LẠI: không cần code mới. #btnApplyAndReorder vốn GÁN ĐÈ cả mảng latestTimeline và
  không đụng editingItems -> lane chính thay mới, overlay giữ nguyên. Chỉ thêm việc dọn
  mainConcatSegments (file nối đã khác) và ghi lại mainConcatCache.
  LƯU Ý: "giữ nguyên overlay" = giữ nội dung + lane + thuộc tính. Vị trí thời gian vẫn bị
  clampItemTiming() kẹp trong độ dài timeline mới, nên timeline sau lọc ngắn hơn thì overlay
  ở cuối bị kéo về trái — hành vi có sẵn của app (xoá clip lane chính cũng vậy).

  THÊM VIDEO KHI LANE CHÍNH LÀ KẾT QUẢ LỌC: row do luồng lọc sinh ra không mang source_path
  nên không dò được row nào thuộc đoạn nào -> không dời an toàn được. rebuildMainLane() HỎI
  trước rồi dựng lại toàn bộ, thay vì lặng lẽ dời sai.

projectFlowMode là thuộc tính CỦA DỰ ÁN, không phải trạng thái màn hình: một khi đã vào
luồng lọc thì breadcrumb + "Quay lại Timeline" còn ý nghĩa mãi. Mở lại .crab thì SUY RA từ
dữ liệu (có rawSegments hoặc mappedChunks) thay vì thêm trường mới — tệp cũ vẫn mở đúng.
```

### Một Nút "Nhập" Duy Nhất Ở Tab Tệp Phương Tiện / Âm Thanh (2026-08-18)

```text
TRƯỚC: hai nút cạnh nhau — "Nhập tệp" (chép vào temp_uploads) và "Thư mục" (link tại chỗ).
  Người dùng phải QUYẾT ĐỊNH TRƯỚC mình đang thêm loại nào, và hai nút cùng nghĩa "thêm
  nguyên liệu" chiếm trọn hàng đầu của một panel chỉ rộng ~166px.

NAY (kiểu CapCut): MỘT nút "Nhập". Chọn tệp lẻ, nhiều tệp, thư mục, hay lẫn lộn cả ba
  trong một lượt đều được. Panel rỗng thì thân panel là VÙNG THẢ LỚN gạch đứt
  (`.edit-import-drop`) — bấm vào cũng mở hộp thoại. Kéo-thả giữ NGUYÊN như cũ
  (`setupPanelImportDnd` không đụng tới).

VÙNG THẢ KÍN KHỔ PANEL (2026-08-18) — đúng như CapCut, ô nhập rộng hết chiều ngang và
  cao hết chiều dọc panel, và đổi theo mỗi lần kéo cột trái rộng/hẹp hay đổi khổ cửa sổ.
  Muốn vậy phải có ĐỦ chuỗi flex, thiếu một mắt là ô nhập co lại bằng nội dung:
    #step4.active   display:flex + height:100%   (trước là block, cao theo nội dung)
    > .edit-panel   flex:1 1 auto; min-height:0
    > .edit-panel-main   align-items:STRETCH (trước là flex-start) + flex:1 1 auto
    > .edit-panel-body   flex:1; min-height:0; overflow-y:auto
    > .edit-import-pane  min-height:100%, flex column
    > .edit-import-drop  flex:1 1 auto; min-height:140px
  HỆ QUẢ: phần tràn của MỌI tab panel trái (LUT, Chuyển tiếp, Thư viện, lưới thẻ) nay
  cuộn TRONG `#editPanelBody` chứ không kéo dài `.panel-content` nữa — cũng là cách
  CapCut làm, và nhờ đó thanh nghe thử âm thanh (`.panel-audio-preview`, sticky đáy) luôn
  nằm trong tầm mắt thay vì trôi khỏi màn hình cùng nội dung.

BA ĐƯỜNG, hạ cấp dần theo khả năng của môi trường — `pickAssetsAny()`:
  1. Desktop macOS — `pick-editing-assets-any` mở MỘT NSOpenPanel bật cả `openFile` lẫn
     `openDirectory`. Kết quả (lẫn tệp và thư mục) đi qua `linkAssetPaths` -> POST
     `/api/editing-assets/link`: endpoint đó vốn đã nhận cả file lẻ lẫn cây thư mục
     (`collectMediaTreeFromSourcePaths`), nên không phải viết đường nhập thứ ba nào.
  2. Desktop Windows/Linux — hai cờ trên loại trừ nhau ở tầng OS (một cái bị bỏ qua âm
     thầm), nên main trả `null` (KHÁC mảng rỗng = người dùng bấm Huỷ) và renderer bung
     menu 2 mục ngay dưới nút.
  3. Bản web — `<input type=file>` và `<input webkitdirectory>` là hai input khác nhau,
     cũng phải hỏi qua menu ấy. Hai mục menu gọi thẳng `pickAssets` / `pickAssetFolders`
     cũ, không nhân bản logic.

HỆ QUẢ CÓ CHỦ Ý: trên desktop, chọn TỆP LẺ nay là LINK chứ không còn CHÉP vào
  `temp_uploads/editing_assets`. Đúng với đường kéo-thả trên desktop (vốn đã link từ
  trước) và tránh nhân đôi dung lượng; đổi lại asset phụ thuộc file gốc còn nằm đúng chỗ —
  đã có sẵn cơ chế đăng ký lại danh sách trắng khi mở .crab lo phần này.
  `importLocalPaths` (chép) vẫn giữ, dùng cho mục "Tệp…" của menu hạ cấp.

### Panel Trái Ở Editing — Thẻ Asset (Tệp Phương Tiện / Thư Viện)

```text
- Thêm vào timeline bằng 2 cách: nút "+" ở góc dưới phải thumbnail (thêm TẠI PLAYHEAD), hoặc
  KÉO-THẢ thẻ xuống timeline (xem khối "Kéo-Thả Từ Panel Xuống Timeline"). Bấm vào thân thẻ =
  MỞ XEM TRƯỚC (không thêm gì). Thẻ thư viện dùng `data-edit-lib-add` (kèm `data-edit-lib-cat`),
  thẻ tệp phương tiện dùng `data-edit-asset-add`. Nút "×" (xoá khỏi dự án) chỉ có ở tab Tệp phương tiện.
- THUMBNAIL VIDEO Ở TAB THƯ VIỆN: `/api/library` KHÔNG trích khung (listing phải rẻ — cùng lý do
  `walkLibraryAssets` không ffprobe; một thư mục vài chục video sẽ thành vài chục lần gọi sidecar
  ngay trong request). Thay vào đó `thumbnail_url` trỏ `/api/library/thumb?category=&name=` —
  `<img loading="lazy">` chỉ gọi khi thẻ lọt tầm nhìn, endpoint dùng `createOrGetThumbnail` (cache
  đĩa `temp_uploads/thumbnails`) rồi 302 sang file tĩnh; trích lỗi -> 404 để `<img>` rơi về ô giữ
  chỗ (KHÔNG trả ảnh rỗng: trình duyệt sẽ cache "thành công" và ô giữ chỗ không hiện).
  `name` đi qua `path.basename()` chặn `../`; asset không phải video -> 400.
- XEM TRƯỚC + CHỌN VÙNG CẮT (kiểu CapCut, 2026-08-12):
  - Bấm thân thẻ video/audio -> `openPanelMediaPreview()`, **TỰ PHÁT NGAY** (bấm thẻ đã là ý định
    "cho tôi xem/nghe cái này"; chính sách autoplay của trình duyệt cho qua vì đang trong chuỗi thao
    tác do người dùng khởi động). Đóng: nút ×, Esc, bấm lại chính thẻ đó, hoặc đổi tab/nhóm.
  - HAI BỀ MẶT TÁCH RIÊNG THEO LOẠI:
    · VIDEO -> lớp `#panelMediaPreview` phủ `#sequencePreviewShell` (một `<video>` RIÊNG). KHÔNG mượn
      `#previewVideo` cũng không đụng Pixi — mượn thì mọi trạng thái lane chính (proxy/HQ, transform,
      retouch) phải cứu lại khi thoát, sai một chỗ là hỏng preview timeline.
    · AUDIO -> thanh gọn `#panelAudioPreview` ghim ĐÁY PANEL TRÁI (`<audio>` riêng), kiểu CapCut:
      ô hình + nút phát · tên · `00:02 | 02:21` · thanh chạy kéo được · ×. Bản đầu cho audio dùng
      chung lớp phủ khung giữa: âm thanh KHÔNG CÓ HÌNH nên cả khung xem trước hoá ô đen kèm dấu ♪,
      che luôn preview timeline để đổi lấy đúng con số thời gian — với một hiệu ứng 2 giây thì vô
      nghĩa. Thanh dùng `position: sticky; bottom` vì panel trái cuộn ở `.panel-content` (nội dung
      cao gấp ~2 lần khung); để thanh nằm cuối `.edit-panel` thì nó rơi khỏi màn hình và người dùng
      tưởng bấm xong không có gì xảy ra.
    `closePanelMediaPreview()` tắt CẢ HAI bề mặt (state chỉ có một; sót bề mặt kia thì nó vừa phát
    tiếp vừa không còn thẻ nào sáng để lần ra đường tắt). Mở bất kỳ bề mặt nào cũng `previewVideo.pause()`.
  - Thẻ đang xem mang `.is-previewing`; RIÊNG thẻ video (`.is-trimming`) thêm `grid-column: 1/-1` +
    lưới đổi sang `minmax(82px, 1fr)` (class `.has-previewing`) để bung hết bề ngang panel — kéo 2
    tay cầm trong 82px thì mỗi pixel ~nửa giây, không nhắm được. Thẻ audio KHÔNG bung (chẳng có gì
    để kéo), chỉ viền sáng. Các thẻ khác giữ `width: var(--edit-thumb-w)` nên KHÔNG nhảy theo.
  - BẪY ĐÃ MẮC: sửa chú thích CSS trong template literal mà để chữ lọt ra ngoài `*/` -> parser nuốt
    luôn 2 rule ngay sau đó (`.has-previewing` + `.is-trimming`), thẻ video im lặng không bung nữa.
    Kiểm nhanh: `[...document.styleSheets]` phải tìm thấy selector `.edit-asset-grid.has-previewing`.
  - Vùng cắt vẽ ĐÈ lên thumbnail (`.emt-overlay`): 2 mảng tối ngoài vùng chọn + 2 tay cầm cyan +
    vạch playhead trắng bám theo `timeupdate`, đơn vị %. Kéo tay cầm bắt ở `pointerdown` trên
    `#step4` (thao tác là KÉO chứ không phải bấm) và `dragstart` bị `preventDefault` khi xuất phát
    từ tay cầm, nếu không trình duyệt khởi động kéo-thả gốc của thẻ (`draggable="true"`).
    Kéo cập nhật TẠI CHỖ qua `paintPanelTrimOverlay()` — dựng lại panel sẽ huỷ chính phần tử đang
    kéo và cú kéo đứt ngay frame đầu.
  - Vùng cắt nằm ở state (`panelPreviewSel`), KHÔNG ghi vào asset: nó là lựa chọn nhất thời cho lần
    thêm này. `panelTrimFor(key)` trả `{start,end}`; `addItemForAsset(asset, type, placement, trim)`
    ghi `source_start = trim.start` và lấy `trim.end - trim.start` làm `wantDuration`. Chưa động vào
    tay cầm (hoặc bấm "Cả tệp") -> thêm trọn tệp như cũ.
  - Audio xem trước được nhưng KHÔNG có thanh cắt (chỉ video); ảnh không mở xem trước (thumbnail đã
    là toàn bộ nội dung).
  - LƯU Ý: `resolveNewItemPlacement` kẹp thời lượng theo chỗ còn trống của timeline, nên dự án
    RỖNG (`timelineDuration() === 0`) làm mọi block mới — kể cả không cắt — về 0.2s. Đó là hành vi
    có sẵn, không phải do vùng cắt.
- Asset lấy từ tab Thư viện mang `source: 'library'` -> `renderImportPaneHtml` LỌC BỎ khỏi tab
  Tệp phương tiện / Âm thanh (đã có chỗ riêng ở tab Thư viện, liệt kê 2 nơi chỉ gây rối).
- Thumbnail KÍCH THƯỚC CỐ ĐỊNH `--edit-thumb-w` = 82px, khung 4/3 (~62px cao):
  `grid-template-columns: repeat(auto-fill, var(--edit-thumb-w))` (KHÔNG dùng `1fr`) + `justify-content: start`
  -> panel rộng ra chỉ tăng SỐ CỘT (176px = 2 cột, 400px = 4 cột), thumbnail không phình to.
  Tỉ lệ 4/3 đặt ở `.edit-asset-thumb-wrap` (khung neo của 2 nút) chứ không ở `.edit-asset-thumb`.
- BẪY ĐỘ ƯU TIÊN CSS (đã mắc): rule chung `.sidebar-left .step-panel button` đặt `padding: 8px 10px`
  + `margin-bottom: 8px`, độ ưu tiên (0,2,1) THẮNG rule 1 lớp `.edit-asset-add` (0,1,0) -> nút bị bóp
  méo và `bottom: 5px` hoá thành 13px (vì tính tới mép MARGIN), khiến "+" và "×" chồng lên nhau trên
  thumbnail thấp. Phải khai báo bằng selector 3 lớp `.edit-asset-card .edit-asset-thumb-wrap .edit-asset-add`.
  Kết quả đo trên app: "×" cách mép trên 5px, "+" cách mép dưới 5px, 2 nút cách nhau 9.5px.
```

### Kéo-Thả Từ Panel Xuống Timeline + Thay Thế Media (2026-08-03)

```text
- MỌI thẻ ở panel trái đều kéo được xuống timeline: Tệp phương tiện, Âm thanh, Văn bản, Hình dạng,
  Thư viện (Video/Elements/SFXs/Music). Thẻ mang `draggable="true"` + `data-edit-drag-kind` (chính
  là asset.type / 'text' / 'shape'); `setupPanelDnd()` (editing-runtime.js) uỷ quyền `dragstart`
  trên #step4 và nghe `dragover`/`drop` trên #timelineTrackOuter — CÙNG khuôn với setupTransitionDnd
  nên không đụng tới mousedown của timeline. MIME riêng `application/x-crabbycut-panel` để 2 luồng
  kéo-thả (chuyển cảnh và panel) không bắt nhầm của nhau.
- HAI CHẾ ĐỘ THẢ (`panelDropTarget`):
  - CHÈN: tạo block mới TẠI THỜI ĐIỂM thả (`timelineFromClientX`), ưu tiên LANE dưới con trỏ
    (`laneRowAt`) nếu đúng loại + không khoá + không chồng block; sai điều kiện nào thì rơi về
    `trackForNewItemAtRange` như nút "+". Lane chính không nhận block overlay nên bị bỏ qua.
    Chỉ báo: vạch dọc #editingPanelDropLine tại vị trí thả.
  - THAY THẾ: thả TRÚNG một block media (item.type==='media') trên lane overlay và vật kéo là
    ẢNH/VIDEO -> `replaceItemMedia`. Chỉ báo: block sáng viền xanh (.is-replace-target).
- `replaceItemMedia`: chỉ đổi `asset_id` + `source_start = 0`, GIỮ NGUYÊN tất cả thông số còn lại
  (transform vị trí/scale/xoay, hoạt ảnh In-Out, điều chỉnh màu, keyframe) — người dùng chốt.
  Ảnh <-> video thay thế lẫn nhau được. Độ dài block GIỮ NGUYÊN; riêng VIDEO mới ngắn hơn block
  thì block thu về đúng thời lượng video (ảnh không có thời lượng nên không đụng tới). Block thu
  ngắn có thể không còn chạm block kề phải -> xoá `item.transition` đã gắn cho khỏi treo.
- `resolveNewItemPlacement(type, wantDuration, placement)` dùng CHUNG cho nút "+" (placement=null
  -> playhead) và kéo-thả (placement={start,trackId}); `addTextItem`/`addShapeItem`/`addItemForAsset`
  đều nhận thêm tham số `placement`. `loadLibraryAsset(category,name)` tách khỏi `addLibraryItem`
  để lấy được asset thư viện mà KHÔNG tự tạo block (đường thay thế cần vậy).
- KHÔNG dùng `elementFromPoint` để dò block dưới con trỏ: canvas sóng âm (z-index 21) phủ lên block
  (z-index 20) nên luôn bắt trúng canvas. `overlayMediaBlockAt` duyệt rect từng block.
- PREVIEW PHẢI ĐỔI TỨC THÌ (sửa 2026-08-03): `renderPreviewOverlays` dùng lại phần tử preview theo
  khoá `preview_${item.id}`, mà `src` CHỈ được gán lúc TẠO phần tử. Thay media không đổi item.id nên
  preview vẫn hiện media CŨ tới khi playhead ra khỏi block rồi vào lại (lúc đó phần tử bị dọn và tạo
  lại) — đúng triệu chứng người dùng báo. Chữa: gắn `el.dataset.mediaKey = "assetId|url"` lúc tạo và
  DỰNG LẠI phần tử khi khoá đổi (cùng chỗ với kiểm tra `dataset.fx` của Điều chỉnh màu). Dựng lại
  thay vì gán `src` mới vì đổi ảnh <-> video là đổi luôn thẻ `<img>` <-> `<video>`. Nhánh `<audio>`
  cũng có y nguyên lỗi này nên vá cùng kiểu (`dataset.mediaKey = asset.id`).
  Đo trên app (playhead ĐỨNG YÊN trong block): ảnh→ảnh `IMG src=[Icon] Lactoferrin` -> `IMG
  src=[Icon] Wellmune`; ảnh→video -> phần tử thành `VIDEO src=[Vid] Be di hoc - 1.mp4`.
- Đo trên app: kéo [Vid] 8.3s thả ở 4s -> block 4.00–12.00s lane "Media 1"; thả video 5.97s lên
  block đó -> block thu còn 4.00–9.97s; thả tiếp video 8.3s -> ĐỘ DÀI GIỮ NGUYÊN 5.97s và
  scale=55/posX=-120/rot=12/anim pop-fade/adjustments đều còn nguyên; thả ảnh lên block video ->
  tráo được, độ dài giữ nguyên; thả ảnh lên block TEXT -> không thay thế mà chèn block mới; kéo
  thẻ Văn bản/Hình dạng/SFXs -> ra đúng lane text/shape/audio tại đúng giây thả.
```

### ASR Theo Nền Tảng Và Cache

```text
- macOS Apple Silicon dùng asr/mac_mlx_sidecar.py -> core_logic.transcribe_audio -> mlx_whisper.
- Default model/quality giữ nguyên: mlx-community/whisper-large-v3-turbo, mode vi_smart.
- Windows dùng asr/windows_faster_whisper_sidecar.py -> faster_whisper/CTranslate2.
- Windows chỉ có MỘT model ASR: `large-v3-turbo` (bỏ `distil-large-v3` từ 2026-08-24) —
  khớp với macOS, nơi core_logic.py ghim mlx-community/whisper-large-v3-turbo.
  - `min_vram_mb = 0` CÓ Ý: là lựa chọn duy nhất nên phải chạy mọi cấu hình, không GPU thì
    rơi về CPU/int8. Ngưỡng 6144 cũ quá thận trọng — đo thật (GTX 1060 6GB, int8, audio
    243s/~58 cụm) chỉ dùng 1.4GB ở batch 1 và 3.1GB ở batch 8, không OOM cả ở batch 32.
  - Tên cũ của Distil (`distil`, `distil-large`, `distil-large-v3`) VẪN được nhận và quy về
    Turbo ở cả `normalize_model_id()` (sidecar) lẫn `normalizeWindowsAsrModel()` (backend):
    dự án .crab và settings đã lưu còn mang tên đó, từ chối là chết bóc băng khi mở lại.
- Windows model được setup riêng qua `POST /api/asr-models/setup`; transcription không tự tải model.
- Model root mặc định trên Windows là `%LOCALAPPDATA%/AI Video Auto Cutter/asr_models`; có thể override bằng `WINDOWS_ASR_MODEL_DIR`.
- UI/backend đọc trạng thái model qua `GET /api/asr-models`.
- Windows ASR bật VAD của faster-whisper và dùng BatchedInferencePipeline; batch size chọn
  theo BẢNG RIÊNG CỦA TỪNG MODEL (`MODEL_CONFIGS[...]["batch_vram_tiers"]`) chứ không chỉ
  theo VRAM — dung lượng model quyết định phần lớn VRAM, dùng một bảng chung là lý do trước
  đây Turbo bị gán cùng batch với Distil (nhỏ hơn một nửa).
- RETRY OOM PHẢI DỰNG LẠI MODEL. Sau một lỗi CUDA, context của model đó hỏng: lần `encode()`
  tiếp theo trên CÙNG object KHÔNG raise mà TREO VĨNH VIỄN. Đo được: process mới thì batch
  4/2/1 đều raise sau ~0.3s, còn thử lại trong cùng process thì treo > 10 phút.
- cuBLAS: ctranslate2 4.8+ mang sẵn `cudnn64_9.dll` nhưng KHÔNG mang cuBLAS, và nó nạp DLL
  theo PATH. `_ensure_cuda_dll_path()` nối `site-packages/nvidia/*/bin` vào PATH trước mọi
  `import ctranslate2`. `os.add_dll_directory()` KHÔNG dùng được ở đây.
- Backend cache kết quả ASR trong asr_cache/ theo:
  - source path/mtime/size.
  - transcribe mode.
  - reference script SHA1.
  - engine/platform/arch/cache version.
  - ASR model/runtime device/compute/batch/VAD policy.
- Nếu cache hit, backend bỏ qua ASR runtime và dùng lại segments/diagnostics đã lưu.
- Report ASR ghi thêm concat/audio_preprocess/VAD/mlx/windows_asr/postprocess/cache/proxy timing để tách nguyên nhân chậm.
```

### Python Dependencies Cho Sidecar

```text
- Backend luôn ưu tiên `.venv/bin/python` nếu tồn tại; nếu không có thì dùng python/python3 hệ thống.
- Auto-Reframe cần MediaPipe classic API (`mp.solutions`) và OpenCV:
  - `mediapipe==0.10.21` cho Python < 3.13.
  - `opencv-contrib-python<4.12` cho Python < 3.13.
- Python hệ thống 3.13+ hoặc 3.14+ có thể không có wheel MediaPipe classic phù hợp; môi trường app nên dùng `.venv` Python 3.12 cho sidecar Auto-Reframe.
- ASR và Auto-Reframe là hai sidecar độc lập:
  - ASR dùng mac_mlx_sidecar.py/windows_faster_whisper_sidecar.py.
  - Auto-Reframe dùng auto_reframe_sidecar.py và chỉ đọc frame video, không chạy ASR.
```

### Encode Export: CPU/GPU Và Bộ Mã Hoá

```text
- Sidecar tự đọc `ffmpeg -encoders` để chọn encoder phần cứng nếu FFmpeg build/driver hỗ trợ.
- Có thể tắt tự động dùng hardware bằng biến môi trường FFMPEG_EXPORT_HW=0/cpu/off/false.
- Codec export hợp lệ từ UI/backend: h264, hevc, prores.
- macOS ưu tiên:
  - h264_videotoolbox cho h264.
  - hevc_videotoolbox cho hevc, kèm `-tag:v hvc1`.
  - prores_videotoolbox profile 3 cho prores nếu FFmpeg hỗ trợ.
- Windows ưu tiên:
  - h264_nvenc/hevc_nvenc nếu có NVIDIA NVENC.
  - h264_qsv/hevc_qsv nếu có Intel Quick Sync.
  - h264_amf/hevc_amf nếu FFmpeg build có AMD AMF.
- Nếu encoder phần cứng không có hoặc chạy lỗi, sidecar retry batch đó bằng CPU và chuyển các batch sau sang CPU.
- CPU fallback:
  - h264 dùng libx264.
  - hevc dùng libx265 kèm `-tag:v hvc1`.
  - prores dùng prores_ks profile 3.
- Audio h264/hevc dùng AAC với bitrate 128k/192k/320k; ProRes dùng pcm_s16le.
- Project report ghi lại encoder export thực tế qua dòng `[encoder]`.
```

### Preset Và Quality Export

```text
- CPU fallback:
  - quality=high: CRF 18, preset `veryfast`.
  - quality=balanced: CRF 23, preset `veryfast`.
  - quality=small: CRF 28, preset `ultrafast`.
- Hardware encoder không dùng CRF thống nhất; sidecar map quality sang bitrate theo độ phân giải export.
- Hardware encoder dùng chế độ ưu tiên tốc độ:
  - VideoToolbox: `-realtime 1 -prio_speed 1`.
  - NVENC: `-preset fast`.
  - QSV: `-preset veryfast`.
  - AMF: `-quality speed`.
- Giá trị mặc định khi UI/backend không gửi đủ setting: codec=h264, quality=high, fps=source, resolution=source, audio_bitrate=192k.
```

### Sequence, Resize Và Transform Khi Export

```text
- Ứng dụng có Sequence state riêng:
  - Mặc định lấy width/height/fps từ video nguồn đầu tiên khi scan hoặc khi video gốc load metadata.
  - UI cho phép đổi Sequence sang source, 16:9 Full HD, 9:16 Vertical, Square hoặc custom width/height.
  - ExportSettings cũ không còn là nguồn sự thật cho kích thước frame; backend ép output theo `sequence.width/height`.
- Timeline FINAL lưu transform độc lập cho từng transcript clip:
  - position_x, position_y tính theo pixel offset so với tâm Sequence.
  - scale tính theo %, mặc định 100 để giữ kích thước video gốc.
  - rotation tính theo độ.
  - opacity tính theo %.
- Timeline FINAL cũng lưu metadata Auto-Reframe riêng trong `auto_reframe`:
  - Không ghi đè khi người dùng đã chỉnh tay position_x/position_y/scale của clip.
  - Metadata nhận diện v2 gồm `coordinate_space=render`, render source size, coded size/rotation, body_center_x/body_center_y, body_box, face_center_x/face_center_y, face_height, detector/status và sample_time.
  - Khi đổi Sequence, frontend gọi lại luồng Auto-Reframe; nếu metadata v2 còn hợp lệ thì chỉ tính lại transform, nếu metadata cũ/sai source size thì gọi Python phân tích lại.
- Backend cung cấp `POST /api/auto-reframe/analyze`:
  - Chỉ nhận timeline clip start/end từ frontend.
  - Gọi asr/auto_reframe_sidecar.py với `/temp_uploads/temp_input.mp4`.
  - Trả JSON nhẹ theo từng clip; không trả chuỗi tọa độ theo thời gian.
- asr/auto_reframe_sidecar.py:
  - Dùng FFmpeg trích frame đã auto-rotate để tọa độ detector cùng hệ render với preview/export.
  - Ưu tiên MediaPipe Pose/Face Detection để lấy tâm body theo trục X/Y, body box, tâm mặt và chiều cao mặt.
  - Dùng OpenCV Haar face cascade làm fallback khi không có pose/face detection khả dụng.
  - Chỉ quét frame đầu clip, sau đó thử frame +1s và giữa clip nếu frame đầu không có người.
  - Nếu không tìm thấy người hoặc detector thiếu dependency, trả status fallback để frontend vẫn áp dụng scale phủ kín Sequence.
- Thuật toán frontend trong index.html:
  - Dùng static/js/auto-reframe-geometry.js cho các phép tính hình học và test Node.
  - Luôn tính theo render `source_width/source_height`; không ưu tiên `frame_width/frame_height` nếu detector/source bị lệch orientation.
  - Tính `scale_min = max(W_seq/W_source, H_seq/H_source)` và audit mép thật sau transform/làm tròn để không lộ nền.
  - Dịch X để body/person nằm giữa Sequence; trục Y ưu tiên coverage, giữ face box trong vùng nhìn thấy, rồi mới đưa tâm mặt về vùng mục tiêu.
  - Nếu tâm mặt trong source nằm ở nửa TRÊN: NEO THEO CẰM (người dùng chốt 2026-08-04, thay cho cách cũ "tâm mặt ~1/3"). Đặt CẰM cách đường ngang GIỮA khung 2%H và LÊN TRÊN đường giữa = mốc 48%H, dải cằm 45%-56%H. (Bản đầu 2026-08-04 để cằm XUỐNG dưới giữa 5% = 55%H làm mặt bị thấp; đã sửa hướng.) `faceCenterTargetRatios` trả về TỈ LỆ CẰM (chinBased) + cờ; `faceTargetBandPx` quy đổi cằm -> tâm mặt bằng cách TRỪ nửa CHIỀU CAO MẶT ĐÃ PHÓNG THẬT (lúc đặt vị trí, biết scale) -> cằm CHÍNH XÁC ở 48%H dù mặt to/nhỏ; lúc quét chọn scale (chưa biết scale) trừ theo cỡ tham chiếu `faceHeightRatio` để dải độc lập với scale (tránh vòng phản hồi). Config: `upperSourceChinTargetRatio/MinRatio/MaxRatio` (0.48/0.45/0.56).
  - Nếu tâm mặt trong source nằm ở nửa DƯỚI: KHÔNG đổi — vẫn neo TÂM MẶT về vùng giữa 44%-56% chiều cao Sequence; không ép mặt lên nửa trên.
  - Với source dọc sang Sequence ngang, nếu mặt thấp nhưng vẫn còn đầy đủ trong source, thuật toán tăng scale/offset để giữ toàn bộ face box trong frame.
  - Scale theo target face-height chỉ là ưu tiên sau coverage/face visibility; nếu cần, hệ thống tăng scale để phủ kín thay vì chấp nhận hở nền.
- Backend normalize `/api/export-video`:
  - đọc `timeline_json`.
  - bổ sung/default transform cho từng interval.
  - đọc thêm `editing_json` nếu frontend gửi từ EditingRuntime.
  - ghi `export_timeline.json` với `sequence`, `settings`, `intervals` chứa `audio_volume` riêng cho từng main clip, `main_audio_volume` fallback tương thích, và nếu có overlay thì thêm `editingTracks`, `editingItems`, `assets`, `overlays`.
- Sidecar không còn dùng một `BuildVideoFilter()` chung cho mọi đoạn khi export video chính.
- `WriteFilterScript()` tạo filter graph riêng cho từng clip:
  - tạo canvas nền đen đúng kích thước Sequence bằng `color`.
  - trim source theo start/end.
  - scale clip theo transform, mặc định 100% kích thước nguồn.
  - scale dùng ceil-even để export không nhỏ hơn kích thước frontend đã tính.
  - rotate nếu rotation khác 0.
  - đổi alpha bằng `format=rgba,colorchannelmixer=aa=<opacity>`.
  - overlay lên canvas Sequence tại `(W_seq-w)/2+position_x`, `(H_seq-h)/2+position_y`.
  - concat các clip sau khi đã compositing.
- Khi payload có Editing overlays, sidecar export một batch đầy đủ để giữ timeline_start chính xác:
  - visual overlay image/video/text-image/shape-image được scale/rotate/opacity rồi overlay theo thứ tự lane.
  - text overlay được frontend rasterize thành PNG trong suốt bằng canvas và font Google offline trước khi gửi export; backend ghi PNG vào `temp_uploads/editing_assets/generated_text/` rồi xuất như ảnh thường.
  - shape overlay dùng SVG DOM/code-native trong preview, nhưng frontend rasterize thành PNG trong suốt trước khi export; backend gửi xuống sidecar như `shape_image`.
  - file SVG import bị loại khỏi Editing vì FFmpeg hiện tại không decode SVG ổn định; các project cũ có vector/SVG item sẽ bị backend bỏ qua thay vì làm fail export.
  - audio lane và audio từ video overlay được trim/delay/volume rồi mix với main audio; main audio được áp volume riêng ngay trên từng interval trước khi concat/mix.
  - image/text-image/shape-image input được loop theo duration sequence để FFmpeg có frame phủ đủ thời gian overlay.
- Filter graph export vẫn chạy trên FFmpeg software frames để giữ đúng trim/concat và transform từng clip.
- Auto-Reframe không chạy lại khi export; export chỉ dùng transform cuối cùng mà frontend đã gửi trong `timeline_json`.
- Hardware encoder giảm tải encode, nhưng transform/resize/pad export chưa chuyển toàn bộ sang GPU vì graph hiện tại cần:
  - trim nhiều đoạn từ một source.
  - concat theo thứ tự timeline.
  - compositing theo Sequence frame.
  - transform khác nhau theo từng clip.
  - output pixel format yuv420p cho h264/hevc, yuv422p10le cho prores.
- Với preview proxy trên macOS, sidecar dùng scale_vt nếu FFmpeg có filter này; nếu không thì dùng scale CPU.
```

### Lưới Khung Hình Của Timeline Khi Export (đã sửa 2026-08-06)

```text
TRIỆU CHỨNG NGƯỜI DÙNG GẶP: bản xuất có retouch hiện MỘT HÌNH CHỮ NHẬT lệch khung quanh
mặt, đúng 1 khung, ở cuối một block. Các block khác nhìn hoàn hảo.

CHẨN ĐOÁN (dựng lại được từng pixel trên bản xuất thật 2026-08-06, khung f159):
- Miếng vá ở khung đó KHÔNG phải của block đang chiếu mà là KHUNG ĐẦU TIÊN của miếng vá
  block KẾ TIẾP. Xác nhận bằng 3 đường độc lập:
    · nền ngoài hình chữ nhật ở f158 và f159 GIỐNG HỆT BIT -> toàn bộ khác biệt là overlay;
    · hộp khác biệt đo được x 268..751 · y 482..1004, khớp CHÍNH XÁC `position` của
      `retouch_2_anim` trong export_timeline.json ((1080−484)/2−30 = 268), không khớp
      `retouch_1_anim`;
    · dựng lại từ temp_input.mp4: crop tại nguồn 21.890s với transform block #3 trùng khít,
      crop tại 41.690s với transform block #2 (thứ ĐÁNG LẼ phải ở đó) thì khác hẳn.

NGUYÊN NHÂN — HAI LƯỚI THỜI GIAN KHÁC NHAU:
- Frontend đặt overlay theo TỔNG DỒN SỐ THỰC của thời lượng block (`mainClipSequenceSpans`),
  backend chỉ làm tròn TỪNG MỐC một (`snapT` = round(t × fps)).
- Sidecar dựng timeline bằng `trim → fps=renderFps → concat`, mà độ dài mỗi segment lại
  khai theo GIÂY nên `fps` phát CEIL(giây × fps) khung. Mốc bắt đầu THẬT của block = TỔNG
  DỒN CÁC CEIL.
- Hai lưới trôi ra xa nhau gần 1 khung mỗi block. Trên dự án thật (14 block, 30fps):
  44.622s nội dung ra 1346 khung = 44.867s, lệch **7.04 khung** ở block cuối.
- Vượt nửa khung là cửa sổ `enable` của overlay bắt đầu SỚM hơn block của nó -> miếng vá
  block N+1 dán lên khung cuối block N, và khung cuối block N+1 thì MẤT retouch. Đo trên
  bản xuất lỗi: block cuối rỉ 5 khung và mất 6 khung.
- VÌ SAO NHÌN RA HÌNH CHỮ NHẬT: mỗi block có transform Auto-Reframe riêng, còn miếng vá
  thì bake bằng transform của CHÍNH BLOCK NÓ. Dán sang block khác là cả hậu cảnh trong
  miếng vá bị đóng khung ở góc/độ phóng khác -> viền chữ nhật sắc nét. AR KHÔNG gây ra
  lỗi; nó chỉ làm lỗi lộ ra. Tắt AR thì vẫn sai nhưng chỉ là 1 khung nháy ở khuôn mặt.

CÁCH CHỮA — CHỐT SỐ KHUNG TỪNG BLOCK TRÊN LƯỚI `round(mốc_tích_luỹ × fps)`
(`BuildTimelineFrameGrid`, gọi ngay sau khi đọc payload — MỘT LẦN cho CẢ timeline, không
theo batch, vì khi không có overlay sidecar chia batch rồi concat):
  1. `ExportInterval.renderFrames` = round(cum_{i+1}×fps) − round(cum_i×fps). Đây ĐÚNG là
     lưới `snapT` của backend, nên biên block khớp tuyệt đối với mốc overlay và sai số
     KHÔNG CÒN CỘNG DỒN (dư địa chỉ còn dưới nửa khung BÊN TRONG một block).
  2. Nền `color` khai `d = renderFrames/fps` (phát khung khi t < d -> đúng renderFrames).
  3. Nhánh clip kẹp bằng `trim=end_frame=renderFrames`.
  4. Tiếng cắt tới `start + renderFrames/fps` để A/V cùng độ dài từng segment.
  5. `frameCount` của bake Retouch ở frontend lấy trên cùng lưới (hiệu hai `round`), không
     phải `round(thời_lượng × fps)`.

BA CÁI BẪY TRẢ GIÁ TRONG CHÍNH LẦN SỬA NÀY — đọc trước khi động vào:
  1. `overlay` KHÔNG dừng ở input thứ nhất. Nó đồng bộ theo framesync và chạy tới input
     DÀI NHẤT (đo được: nền 55 khung + clip 56 khung -> ra 56 khung). Chốt độ dài nền
     `color` thôi là CHƯA đủ — số khung nhánh clip nhả ra phụ thuộc mốc thời gian THẬT
     của khung nguồn (59.94fps resample về 30) nên lúc bằng lúc hơn. Thiếu bước (3) thì
     2/14 block vẫn dài thêm 1 khung.
  2. ĐỪNG trừ bớt độ dài nền cho "chắc ăn". Bản sửa đầu để `(N−0.5)/fps`: số khung vẫn
     đúng, nhưng `concat` dời segment sau đi một đoạn bằng ĐỘ DÀI KHAI BÁO, mà cửa sổ
     `enable` lại tính bằng GIÂY -> mỗi block lùi nửa khung, dồn 3 block là overlay mất
     khung đầu. Đúng loại lỗi đang đi dẹp, chỉ đổi dấu.
  3. `between(t, start, end)` so `t` (do `concat` CỘNG DỒN các số in ra 6 chữ số) với một
     số cũng in ra 6 chữ số -> khung đầu của block có thể thấp hơn `start` vài phần 1e-16
     và bị vứt. `OverlayEnableStart` nới mốc mở LÙI NỬA KHUNG, đối xứng với `seqEndTrim`
     đã có ở đầu kia. Nới nửa khung không thể kéo overlay sang khung trước (khung đó cách
     một khung TRÒN) và không đổi thứ được vẽ, vì khung nội dung đầu vẫn nằm ở đúng mốc.

TEST: `tests/scripts/timeline_frame_grid.js` (npm run test:frame-grid). Chạy FFmpeg THẬT
qua sidecar — bẫy số 1 chỉ lộ khi chạy, số học không nhìn thấy. Thời lượng block cố ý
chọn lẻ để lưới CEIL và lưới ROUND phải khác nhau. Đòi: tổng khung đúng lưới, và chuỗi
khung overlay phủ ĐÚNG block của nó (không rỉ sang block trước, không hụt khung cuối).
Đối chiếu ngược: bản mã CŨ cho 378 khung trong khi lưới đòi 373 -> test đỏ.

KIỂM CHỨNG ĐẦU-CUỐI trên chính dự án gây lỗi (14 block, 10 miếng vá): thay mỗi miếng vá
bằng một ô màu rồi xuất thật -> cả 10 phủ đúng khung của block mình, tổng 1339 khung đúng
bằng round(44.622 × 30). Trước khi sửa là 1346 khung và 9/10 miếng vá lệch.
```

### Timeline Preview Và Preview Cuts

```text
- Sau khi concat video nguồn thành `/temp_uploads/temp_input.mp4`, backend trả transcript bằng video gốc trước.
- Sau response bóc băng, backend tạo nền `/temp_uploads/preview_proxy.mp4`; trạng thái xem qua `GET /api/preview-proxy-status`.
- Proxy preview là H.264 all-keyframe:
  - scale tối đa 720p, không upscale video nhỏ hơn 720p.
  - `-g 1 -bf 0` để mọi frame là keyframe.
  - audio AAC 128k stereo để preview vẫn nghe được.
  - ưu tiên h264_videotoolbox/h264_nvenc/h264_qsv/h264_amf nếu có; fallback libx264 ultrafast CRF 23.
- Renderer ban đầu phát `/temp_uploads/temp_input.mp4`, poll proxy status, rồi chỉ đổi sang proxy khi video đang pause.
- Nút Play trên timeline và Preview Cuts không render FFmpeg theo từng lần bấm.
- Cả hai dùng thẻ HTML `<video id="previewVideo">` để phát file đã load; Sequence preview dùng Pixi canvas inline trong index.html để hiển thị video texture theo frame Sequence, fallback sang CSS transform nếu Pixi không khởi tạo được.
- Khi Timeline ở FINAL:
  - click một dòng transcript hoặc clip trên timeline để chọn clip tương ứng.
  - Inspector chỉnh position/scale/rotation/opacity của clip đó, hỗ trợ nhập tay và kéo ngang trên ô thông số để scrub giá trị.
  - Kịch bản chuẩn và Clip Transform nằm trong panel stack bên trái transcript; icon rail ngoài cùng bên phải bật/tắt từng panel.
  - Preview khi pause hiển thị transform của clip đang chọn; khi play thì dùng transform của clip đang phát.
- Preview Cuts mô phỏng bản cắt bằng JavaScript: seek `video.currentTime` tới start của clip, phát, rồi nhảy qua clip kế tiếp khi chạm end.
- FINAL timeline playback cũng phát theo thứ tự mảng latestTimeline bằng jump-cut scheduler ở static/js/perf-runtime.js.

NỀN KHUNG PREVIEW — đen hay xanh nhấp nháy (isSequenceTransparencyWarningEnabled):
- Nền xanh `#0AD500` nhấp nháy là CẢNH BÁO "khung đang trong suốt" (không có gì phủ kín
  khổ sequence tại playhead), không phải màu trang trí. PIXI vẽ nó (Graphics + alpha đảo
  chiều theo ticker); đường CSS `.transparency-warning-active` chỉ là dự phòng khi Pixi
  không khởi tạo được — có `.pixi-ready` thì CSS trả nền về #000 và tắt keyframes.
- Điều kiện: đang ở step3/step4 + currentMode === 'FINAL' + TIMELINE ĐÃ CÓ BLOCK
  (latestTimeline.length > 0 hoặc EditingRuntime.hasTimelineBlocks()). Bỏ vế cuối là dự án
  vừa tạo (trống trơn) đã nhấp nháy xanh ngay — cảnh báo về một cái không tồn tại. Dự án
  trống để nền đen như mọi ứng dụng dựng khác.
- hasTimelineBlocks() cố ý RẺ (`editingItems.length > 0`): resizeAndRender hỏi nó mỗi
  frame, còn getState() thì chép mảng.
- Không cần chỗ đồng bộ riêng: renderAll() của editing-runtime gọi
  updateSequencePreviewTransform() sau MỌI lần thêm/xoá block.
```

### Tối Ưu Hiện Tại Theo Nền Tảng

```text
- MacBook/macOS:
  - ASR dùng mlx_whisper qua asr/mac_mlx_sidecar.py, phù hợp Apple Silicon/MLX.
  - Hardware info hiển thị MPS (Mac Silicon) khi chạy trên darwin arm64.
  - Timeline (ruler + segment) render bằng PixiJS; sóng âm render bằng canvas 2D riêng (audio-waveform.js), cả hai giới hạn devicePixelRatio tối đa 2 để giảm tải.
  - Export ưu tiên VideoToolbox cho h264/hevc/prores khi FFmpeg hỗ trợ.
  - Preview proxy ưu tiên h264_videotoolbox và scale_vt nếu FFmpeg hỗ trợ, nhưng chỉ chạy sau ASR để tránh tranh MLX/MPS/unified memory.
  - Playback preview dùng HTML video decoder của Chromium/Electron với proxy all-keyframe để seek mượt hơn.
- Windows:
  - ASR mặc định dùng faster-whisper/CTranslate2 qua asr/windows_faster_whisper_sidecar.py.
  - Model duy nhất là large-v3-turbo (min_vram_mb 0, luôn khả dụng).
  - Không tự download model trong lúc bóc băng; model phải được setup trước qua API/UI.
  - VAD bật mặc định bằng Silero VAD của faster-whisper.
  - Batching bật trên CUDA/GPU; nếu OOM thì giảm batch và ghi diagnostics.
  - Nếu không có CUDA/VRAM không xác định, large-v3-turbo chạy CPU int8 với batch 1.
  - whisper.cpp chỉ còn là rollback rõ ràng bằng `WINDOWS_ASR_ENGINE=whisper_cpp`.
  - Export/preview proxy ưu tiên NVENC, sau đó QSV, sau đó AMF nếu FFmpeg build/driver hỗ trợ.
  - Nếu không có encoder phần cứng hợp lệ, fallback CPU libx264/libx265/prores_ks.
  - UI/timeline dùng cùng PixiJS và HTML video playback như macOS.
- Export:
  - Render batch tối đa 80 interval/lần để tránh filter_complex quá lớn.
  - Nếu nhiều batch, sidecar concat các batch cuối bằng `-c copy` để tránh encode lại lần nữa ở bước nối cuối.
```

### Lưu / Mở Dự Án (.crab)

```text
- Tệp .crab lưu toàn bộ phiên làm việc: transcript (RAW/MAPPED/FINAL), timeline, editing items/tracks,
  kịch bản, cấu hình ASR, bước hiện tại (currentStepId/currentMode) và manifest media (tham chiếu).
- Định dạng nhị phân (electron/crab-format.js):
  [0..8) magic "CRABPRJ\0" | [8..10) version uint16 LE | [10..12) reserved
  [12..44) SHA-256 của phần gzip | [44..) gzip(JSON payload)
  Ghi atomic (.tmp rồi rename). Checksum sai / magic sai → báo "tệp hỏng"; version mới hơn → yêu cầu cập nhật app.
- Chiến lược media: CHỈ THAM CHIẾU — .crab lưu đường dẫn + size/mtime + fingerprint
  (sha256 64KB đầu + 64KB cuối + size) của video nguồn và editing asset gốc, không đóng gói byte video.
  Khi mở, file thiếu/đổi sẽ hiện modal re-link (Tìm lại… / Bỏ qua asset / Hủy).
- Luồng lưu (index.html: collectProjectPayload/saveProject): bọc snapshot captureFullState() (dùng chung với
  undo/redo) + session_segments.json + manifest media → IPC 'project-save' (electron/main.js) → dialog + ghi file.
  Cmd/Ctrl+S lưu vào đường dẫn hiện tại, Cmd/Ctrl+Shift+S = Save As, Cmd/Ctrl+O = mở. Title bar hiện tên dự án + chấm • khi có thay đổi chưa lưu.
- Luồng mở (openProjectFromResult/performProjectLoad): verify media → reset-project (không reload trang)
  → POST /api/project/reingest (copy nguồn + concat + peaks + proxy, KHÔNG chạy lại ASR — segments phục hồi
  từ .crab) → scan lại thư viện video → re-import editing assets (giữ nguyên asset_id cũ, chỉ rewire url/path)
  → restoreHistoryState() → showStep().
- Double-click .crab: macOS qua app.on('open-file'); Windows/Linux qua argv + single-instance lock
  (second-instance chuyển path về instance đang chạy). Renderer nhận qua desktopEnv.onOpenProjectFile.
  File association khai báo trong package.json build.fileAssociations (chỉ hoạt động ở bản đóng gói
  electron-builder; dev test bằng `npx electron . /path/x.crab`).

- `npm start` KHÔNG mở được gì (đã sửa 2026-08-16). Trên macOS, đóng cửa sổ bằng nút đỏ KHÔNG thoát
  app: `window-all-closed` cố ý chỉ quit khi platform !== 'darwin', nên tiến trình chính sống tiếp với
  mainWindow = null và VẪN GIỮ khoá `requestSingleInstanceLock()`. Lần `npm start` sau rơi vào nhánh
  "không lấy được khoá" -> `app.quit()` -> thoát với mã 0, KHÔNG cửa sổ, KHÔNG một dòng log nào. Nhìn
  hệt như "ứng dụng hỏng, không khởi động được", trong khi app vẫn đang chạy (đo được một tiến trình
  treo 13 giờ, có helper GPU + network nhưng KHÔNG có helper renderer -> đúng dấu hiệu "còn sống,
  không còn cửa sổ").
  Sửa 2 chỗ:
  1. `second-instance` không còn chỉ `focus()` khi có sẵn cửa sổ, mà DỰNG LẠI cửa sổ khi không còn
     (`reopenMainWindow()`), y như `app.on('activate')` vẫn làm khi bấm icon ở Dock. Kèm
     `app.focus({steal:true})` để cửa sổ không mở sau lưng terminal.
  2. Nhánh không lấy được khoá in một dòng ra stdout — terminal phải nói được lý do.
  `reopenMainWindow()` CỐ Ý không gọi thẳng `ensureBackendReady()`: hàm đó đặt `isExternalBackend = true`
  khi thấy backend còn sống (nay phải ĐÚNG chữ ký `app:'crabbycut'`), gọi bừa là sidecar của chính mình bị đánh dấu "của người khác" rồi không
  được tắt lúc thoát. Nên: `checkBackendHealth()` trước, còn sống thì mở cửa sổ luôn.
```

### Cổng Backend: 17219, Và Chữ Ký Chống Nhận Nhầm App Lạ (2026-09-10)

```text
- CỔNG MẶC ĐỊNH LÀ 17219, KHÔNG CÒN LÀ 8000. Khai ở HAI chỗ phải khớp nhau:
  `DEFAULT_BACKEND_PORT` (backend/server.js) và `BACKEND_PORT` (electron/main.js), cả hai
  đều nhường biến môi trường `BACKEND_PORT`. `.claude/launch.json` và các trang
  tests/manual/*.html đi theo.
- VÌ SAO ĐỔI: 8000 là cổng mặc định của quá nhiều thứ (python -m http.server, Django,
  FastAPI/uvicorn…). Trên chính máy dev nó đụng "Dynamic AI Learning Hub" chạy
  `python backend.py`. 17219 = 0x4343 ("CC"): ngoài dải 3000-9000 mà công cụ dev chen
  nhau, và vẫn dưới dải cổng động của Windows (bắt đầu 49152) nên hệ điều hành không
  mượn tạm mất.
- ĐỤNG CỔNG Ở ĐÂY KHÔNG PHẢI "KHÔNG KHỞI ĐỘNG ĐƯỢC" — nó tệ hơn nhiều. `checkBackendHealth()`
  bản cũ nhận MỌI mã 200..499 là "backend đã sống", nên tiến trình lạ đang giữ cổng (Hub
  trả 404 cho /api/status — vẫn nằm trong khoảng đó) bị coi là backend của mình:
  `ensureBackendReady()` đặt `isExternalBackend = true`, KHÔNG dựng sidecar, rồi `loadURL`
  vào đó — cửa sổ CrabbyCut hiện ra giao diện của app kia, và lúc thoát cũng không tắt gì.
- CHỐNG NHẬN NHẦM: `/api/status` nay trả kèm CHỮ KÝ `{app:'crabbycut', pid, port}` và
  `checkBackendHealth()` phải ĐỌC BODY, chỉ nhận khi `app === 'crabbycut'` và mã 2xx.
  Chỉ đổi cổng là chưa đủ: cổng nào rồi cũng có ngày bị ai đó chiếm, và proxy/captive-portal
  của công ty trả 200 cho mọi đường dẫn là chuyện có thật. Body đọc tối đa 64KB rồi huỷ —
  tiến trình lạ có thể trả về một luồng vô tận.
- `message` của /api/status GIỮ NGUYÊN (các chỗ đọc cũ và tests/scripts/backend_smoke.js
  vẫn dựa vào nó); chữ ký chỉ là trường cộng thêm.
- CÒN NỢ: cổng vẫn CỐ ĐỊNH. Kế hoạch "Giai đoạn 3 — Cổng động" (docs/t-i-mu-n-ng-g-i-toasty-wand.md)
  là backend bind cổng 0 rồi in cổng thật ra stdout — hết hẳn chuyện tranh cổng, kể cả hai
  bản CrabbyCut chạy song song. Phần chữ ký ở trên chính là một nửa của kế hoạch đó.
```

### Auto-Reframe: Điều Kiện Chạy, Hình Học Căn Khung & Công Tắc (2026-08-01)

```text
KHI NÀO CHẠY — ensureTimelineAutoReframe() được gọi từ:
  1. bật CÔNG TẮC "AR" (setAutoReframeEnabled(true), reason: 'toggle-on')
  2. lượt chạy bị hoãn nội bộ khi có yêu cầu tới lúc autoReframeInFlight đang bận
     (reason: 'pending') — không phải một "ca" riêng, chỉ là cơ chế nối tiếp của mục 1.
Điều kiện tối thiểu: currentMode==='FINAL', latestTimeline không rỗng, CÔNG TẮC đang bật.

  SỬA 2026-09-14 — MẶC ĐỊNH TẮT, CHỈ CHẠY QUA CÔNG TẮC:
  trước đây ensureTimelineAutoReframe() còn được gọi tự động ở nhiều nơi (vào step3/step4,
  rebuildMainLane() khi thêm video, đổi preset/kích thước sequence, cắt hoặc nhân bản block
  lane chính) và auto_reframe_enabled mặc định TRUE. Đã bỏ toàn bộ các đường gọi tự động đó
  và đổi default sang FALSE: giờ Auto-Reframe CHỈ chạy khi người dùng chủ động bấm nút "AR".
  Các hàm/biến chỉ phục vụ đường gọi tự động cũ (scheduleAutoReframeForSequenceChange(),
  autoReframeSequenceChangeTimer) đã bị xoá theo.

  LỊCH SỬ 2026-08-22 (đã lỗi thời, giữ lại để tham khảo) — VÌ SAO AUTO-REFRAME "KHÔNG HOẠT
  ĐỘNG": bản cũ chỉ chạy ở showStep('step3') và ở đường đi step3 -> step4. Từ khi Editing
  thành điểm bắt đầu (projectFlowMode 'editing-first', v1.0.7), người dùng vào THẲNG step4
  và dựng lane chính tại chỗ bằng rebuildMainLane(), còn mở lại .crab cũng showStep về step4
  -> KHÔNG điều kiện nào đúng, ensureTimelineAutoReframe() không chạy lần nào. Lúc đó đã vá
  bằng cách thêm nhiều đường gọi tự động; các đường đó nay đã bị bỏ lại theo SỬA 2026-09-14
  ở trên.

CÓ GỌI SIDECAR HAY KHÔNG — clipNeedsAutoReframeAnalysis():
  thiếu metadata | auto_reframe_version != AUTO_REFRAME_METADATA_VERSION |
  coordinate_space != 'render' | meta.source_width/height lệch payload > 2px |
  meta.sample_time nằm NGOÀI [start-0.05, end+0.05] của chính block đó.
  manual_override=true -> block đó bị loại vĩnh viễn (người dùng đã chỉnh tay).
  Metadata còn hợp lệ -> KHÔNG gọi backend, chỉ applyAutoReframeTransforms().

CHỈ GỬI BLOCK CẦN QUÉT (2026-08-22): body của POST /api/auto-reframe/analyze là
  [{index, start, end}] của riêng các block cần quét (backend đã nhận `index` gốc từ
  trước — normalizeAutoReframeClips). Trước đây gửi CẢ timeline: lane chính dựng tay nối
  lại toàn bộ nguồn mỗi lần thêm một video, nên thêm block thứ 15 là quét lại cả 15 (một
  lượt 12 block ≈ 60s trên M1 Pro). Đo lại: thêm 1 block vào lane 4 block = 1 block được
  gửi. Đây cũng là lý do phải kiểm sample_time ở trên: rebaseRows() dời start/end của row
  cũ mà giữ nguyên metadata, trước kia lệch này tự khỏi vì lượt nào cũng quét lại tất cả.
Sidecar cần cv2 + mediapipe (hoặc tối thiểu Haar cascade), lấy tối đa 3 frame mẫu
(start, start+1s, giữa block) và dùng kết quả ĐẦU TIÊN nhận diện được.

HÌNH HỌC (static/js/auto-reframe-geometry.js) — 3 lỗi đã sửa:
1. KHÔNG BAO GIỜ PHÓNG ĐỂ LẤY DƯ ĐỊA DỊCH. Ràng buộc "không lọt nền" khoá position vào
   ±(nguồn*scale - khung)/2. Ở mức vừa đủ phủ khung, khoảng đó = 0 theo trục trùng tỉ lệ
   -> dự án CÙNG tỉ lệ nguồn gần như không được căn gì (đo: 1920x1080 -> 1920x1080, người
   ở x=520 lệch tâm 430px; mặt ở nửa dưới nguồn rơi xuống 65.8% chiều cao thay vì ~50%).
   Sửa: scaleToPlacePoint() cho scale tối thiểu để đặt một điểm nguồn vào đúng vị trí khung
   (scale >= target/p và >= (seq-target)/(src-p)); layoutScalePercent() quét scale từ sàn
   tới trần, chấm SAI SỐ bố cục thật (đo SAU khi kẹp coverage) rồi lấy scale NHỎ NHẤT có
   sai số gần tối ưu (layoutErrorToleranceRatio = 2% chiều cao khung) -> phóng đúng mức
   cần, và KHÔNG phóng khi phóng không cứu được gì (mặt sát mép nguồn).
2. CỠ MẶT KHÔNG ĐỒNG ĐỀU. computeTargetFaceHeight() lấy TRUNG VỊ, nhưng scale mỗi block
   chỉ ĐI LÊN được từ scale bố cục của nó -> block có mặt to trong nguồn không tài nào thu
   xuống trung vị (đo: 320px vs 481px = lệch 50%). Sửa: cỡ mặt chung = LỚN NHẤT trong các
   "cỡ mặt tại scale bố cục" của từng block (kẹp bởi trần phóng của chính block đó).
3. LƯỚI AN TOÀN KHÔNG ĐƯỢC DÙNG. Module chỉ có ngưỡng riêng faceVisibilityMarginRatio.
   Sửa: faceTargetBandPx() GIAO dải mục tiêu với safeInset* — phải trùng SAFE_ZONE_INSETS
   của index.html (0.10/0.20/0.06/0.10), tức lưới người dùng nhìn thấy.

TRẦN PHÓNG — scaleBounds(meta, payload):
  sàn = max(phủ kín khung, đủ để KHUÔN MẶT nằm trọn trong khung). Sàn LUÔN thắng trần:
        mặt lọt ra ngoài khung là lỗi nặng hơn nhiều so với cắt hình quá tay.
  trần = mức "trung dung" × maxAutoZoomRatio (1.6); trung dung = max(sàn, scale để mặt đạt
        faceHeightRatio). KHÔNG lấy trần từ riêng sàn phủ khung: cảnh quay xa có mặt bé thì
        phóng lên cho mặt đủ to CHÍNH LÀ việc cần làm, không phải "cắt quá tay".
        Mức trung dung dùng hằng số faceHeightRatio chứ không dùng cỡ mặt chung đã đàm phán
        giữa các block — cỡ chung lại tính từ trần, sẽ thành vòng lặp phụ thuộc.
  Trần có thể không đủ để mọi mặt bằng nhau -> autoReframeFaceSizeSpread() đo chênh lệch
  THẬT và thanh trạng thái nói ra khi > 15%, thay vì im lặng.

nudgeFaceIntoSafeZone(): rà cuối, chỉ đụng position_y (không kéo theo phóng thêm) để đẩy
cả khuôn mặt vào lưới khi nó vừa lưới — chuỗi ưu tiên chính có lúc phải buông ràng buộc
mặt vì chọi với body-safe/coverage.
LƯU Ý về vòng phản hồi: dải mục tiêu dùng TRONG layoutErrorAtScale phải ĐỘC LẬP với scale.
Có lần trừ nửa chiều cao mặt (lớn dần theo scale) vào dải -> dải co lại đúng lúc đang tăng
scale để với tới nó -> scan chạy thẳng lên trần, mặt to hơn cả khung (đã sửa).

Đo lại sau khi sửa (tests/scripts/auto_reframe_geometry.js vẫn xanh):
  16:9 -> 16:9 người lệch trái : lệch tâm 430px -> 128px (chạm trần 160%), cỡ mặt 272/272
  mặt ở nửa dưới nguồn         : 65.8% -> 58.0% chiều cao khung (dải mục tiêu 44-56%)
  cỡ mặt chênh 3x trong nguồn  : lệch 50% -> 5.9%
Quét 720 tổ hợp (3 kích thước nguồn × 5 kích thước dự án × 3 vị trí ngang × 4 vị trí dọc
× 4 cỡ mặt 5-16% chiều cao nguồn):
  - PHỦ KÍN KHUNG (không lọt nền): 720/720 — ràng buộc cứng, chưa từng vỡ.
  - cả khuôn mặt trong lưới an toàn: 696/720. 24 ca còn lại là nguồn DỌC -> dự án NGANG với
    mặt 16% nguồn: phóng bắt buộc để phủ khung + ép cỡ mặt chung làm mặt cao hơn cả dải an
    toàn -> bất khả thi về hình học, không phải lỗi thuật toán.
  - Cận mặt cực đại (mặt 30% chiều cao nguồn) nằm ngoài tầm bảo đảm: khuôn mặt khi đó
    thường cao hơn cả dải an toàn (lưới cắt 10% trên + 20% dưới).

CÔNG TẮC BẬT/TẮT — sequenceSettings.auto_reframe_enabled (mặc định false kể từ 2026-09-14):
- Nút "AR" trong #panelToggleRail (cạnh Safe Zone), chỉ hiện ở step3/step4 + FINAL.
- Nằm TRONG sequenceSettings nên tự đi theo undo/redo (captureFullState) và file .crab,
  không phải thêm đường lưu riêng.
- TẮT: resetAutoReframedTransforms() đưa block về DEFAULT_CLIP_TRANSFORM (giống nút Reset
  của Inspector) và xoá applied_sequence, nhưng GIỮ NGUYÊN item.auto_reframe -> bật lại là
  áp ngay, KHÔNG gọi lại sidecar. ensureTimelineAutoReframe() thoát sớm khi tắt.
- Block đã manual_override KHÔNG bị đụng ở cả hai chiều (không xoá công sức chỉnh tay).

LQ/HQ KHÔNG ĐƯỢC ĐỤNG VÀO DỮ LIỆU DỰ ÁN:
- Proxy xem thử nhỏ hơn nguồn thật. Nếu kích thước proxy chảy vào sequenceSettings.source_*
  thì isAutoReframeMetadataCurrent() thấy lệch -> coi MỌI block là cần phân tích lại, và
  trong lúc chờ thì shouldApplyAutoReframeTransform()=false -> transform treo; preset
  'source' còn kéo cả kích thước SEQUENCE về kích thước proxy.
- Chốt bằng isPreviewProxySourceLoaded(): so khớp URL đang nạp với active/ready/pending
  proxy URL (chuẩn hoá tuyệt đối). So bằng URL chứ không chỉ bằng cờ isSwitchingPreviewProxy
  -> không lệ thuộc thời điểm sự kiện loadedmetadata.
- Handler loadedmetadata cũng KHÔNG tự fit lại zoomScale khi đang đổi LQ/HQ (đổi chất lượng
  mà nhảy mức zoom timeline là mất chỗ đang làm).
- Preview luôn quy texture về kích thước NGUỒN (displayScale trong PixiSequenceRenderer và
  updateNativeVideoPreviewTransform) nên LQ và HQ cho ra cùng một khung hình.

ĐỒNG BỘ PREVIEW <-> EXPORT: transform nằm trên latestTimeline[i].transform, đi thẳng vào
export payload; sequence payload mang source_width/height của NGUỒN THẬT. Backend
normalizeClipTransform() / normalizeSequenceSettings() dùng đúng các số đó -> preview và
render cùng một phép biến đổi.
```

### Auto-Reframe: Khớp Vị Trí Người Tại Điểm Cắt (2026-08-01)

```text
VẤN ĐỀ: mỗi block dùng MỘT transform tĩnh. Trong block, người di chuyển nên mặt trôi dần
(mượt, không sao). Nhưng TẠI ĐIỂM CẮT, mặt nhảy từ chỗ nó trôi tới ở cuối block N sang chỗ
transform của block N+1 đặt nó -> giật khung. Càng cắt nhiều càng rõ.

LẤY MẪU HAI ĐẦU BLOCK (asr/auto_reframe_sidecar.py, AUTO_REFRAME_VERSION 3):
- head_candidate_times(): frame ĐẦU trước, không thấy người thì nhích vào 15% (≤0.5s) rồi 35%.
- tail_candidate_times(): lùi 0.05s khỏi mép (frame cuối thường đã sang clip sau do sai số
  làm tròn), rồi lùi thêm về giữa block.
- sample_person_at() trả mẫu ĐẦU TIÊN dò được. Chỉ dò được một đầu -> dùng cho cả hai.
- Kết quả: field GỐC của clip = mẫu khung ĐẦU (giữ nguyên ý nghĩa cũ, mọi phép tính bố cục
  không đổi) + thêm `tail` = mẫu khung CUỐI. Thuần bổ sung, không phá tương thích code.
- Chi phí: gấp đôi số lần trích frame bằng ffmpeg (mỗi đầu tối đa 3 mốc).
- AUTO_REFRAME_METADATA_VERSION 2 -> 3: dự án cũ tự quét lại (v2 không có dữ liệu khung cuối).

BÀI TOÁN (static/js/auto-reframe-geometry.js -> solveJunctionContinuity):
position vào công thức vẽ một cách TUYẾN TÍNH, nên đây là bình phương tối thiểu 1 chiều
theo TỪNG TRỤC, có ràng buộc hộp:
    E = Σ wc·(p_i − b_i)²  +  Σ wj·((p_i + aT_i) − (p_{i+1} + aH_{i+1}))²
  b_i  = position mà bộ giải TỪNG BLOCK (calculateTransform) đã chọn — đã gói sẵn toàn bộ
         ràng buộc bố cục cũ. Dùng nó làm mốc "kéo về" nên KHÔNG phải dựng lại chuỗi ưu
         tiên nào, và đặt junctionMatchWeight = 0 là quay về đúng hành vi trước đây.
  aH_i, aT_i = (điểm mặt khung đầu / khung cuối − nguồn/2) × scale_i.
  Trục ngang khớp tâm THÂN (như bộ giải cũ), trục dọc khớp tâm MẶT.
Giải bằng Gauss-Seidel 60 lượt, quét xuôi/ngược xen kẽ, KẸP HỘP mỗi bước:
  hộp = vùng không lọt nền ∩ vùng giữ mặt trong khung ∩ vùng giữ mặt trong lưới an toàn
  (positionBoxForAxis). Kẹp NGAY TRONG vòng lặp nên ràng buộc CỨNG không bao giờ bị vi phạm
  dù nghiệm tối ưu nằm ngoài hộp.
CHỈ đụng position, KHÔNG đụng scale — đổi scale là cỡ mặt giữa các block lại lệch.

MỐC BỐ CỤC (junctionAnchor = 'travel-mid'): căn giữa ĐIỂM GIỮA đường đi của người trong
block, thay vì ghim vào khung đầu. Với một transform TĨNH, sai số trung bình trong block
nhỏ nhất khi lấy giữa đường đi. Cài đặt chỉ là dịch baseline đi (aHead − aTail)/2 rồi kẹp
lại — không phải sửa gì trong chuỗi ưu tiên bố cục.

BLOCK ĐÃ CHỈNH TAY (manual_override) = MỐC NEO: position giữ nguyên tuyệt đối (fixed=true)
nhưng vẫn kéo các block bên cạnh khớp vào nó.
Block KHÔNG nhận diện được người = ĐIỂM NGẮT chuỗi: không có cạnh nối đi qua nó.

CÂN NẶNG (junctionCompositionWeight 1 : junctionMatchWeight 2 — nghiêng về khớp cắt):
Đây là một NÚM XOAY, không phải nghiệm hoàn hảo. Đo trên chuỗi 8-10 block:
    wj   lệch điểm cắt max   lệch tâm trung bình
     0        241 px               0 px      (hành vi cũ)
     2        162 px              85 px      (mặc định)
     8         87 px             173 px
    50         43 px             254 px
Sàn ~40 px ở wj rất lớn là GIỚI HẠN CẤU TRÚC: một transform tĩnh không thể thoả mọi điểm
cắt khi mỗi block có quãng di chuyển khác nhau. Muốn triệt tiêu hẳn phải chuyển sang pan
theo keyframe trong block — nhưng Inspector hiện đọc transform GỐC của block, không phải
giá trị nội suy tại playhead, nên làm vậy phải sửa cả Inspector (chưa làm).

ĐO TRÊN CA THỰC TẾ (10 block, dựng dọc 1080x1920 từ nguồn 1920x1080):
  lắc lư nhẹ (±40px nguồn) : 72 px (6.7% bề rộng) -> 28 px (2.6%), lệch tâm tb 2.3%
  dịch vừa   (±120px nguồn): 196 px (18.1%)       -> 74 px (6.9%), lệch tâm tb 6.6%
  cùng tỉ lệ 16:9, lắc lư  : 40 px (2.1%)         -> 15 px (0.8%), lệch tâm tb 0.7%
Thanh trạng thái báo sai số thật qua autoReframeJunctionReport(); ngưỡng "coi như khớp" =
1% bề rộng khung.
```

### Giật Khung Tại Điểm Cắt Khi Preview — 1 Frame Vẽ Bằng Transform Mặc Định (đã sửa 2026-08-02)

```text
TRIỆU CHỨNG (dự án thật, 12 block, dựng dọc 1080x1920 từ nguồn 1728x3072 @59.94fps): khi
preview chạy qua điểm cắt, khung hình GIẬT một cái. Bước từng frame thì thấy frame ĐẦU của
block sau hiện ở transform GỐC (0,0,100%) rồi mới nhảy sang giá trị Auto-Reframe.
KHÔNG xảy ra ở bản render, và KHÔNG xảy ra khi tắt Auto-Reframe.

GỐC RỄ — getActivePreviewClipIndex() (index.html):
  resolveSequenceClipIndexAtVideoTime(currentTime, 0) không khớp block nào -> trả -1 ->
  getActivePreviewTransform() rơi về defaultClipTransform() = (0,0) scale 100.
Hai block kề nhau trên SEQUENCE hầu như luôn RỜI NHAU ở NGUỒN (đo trên dự án thật: cả 11
mép đều có khoảng trống, vd 37.100 -> 38.459 cách 1.359s; mép 1->2 còn nhảy LÙI 19.6s).
Ngay lúc chuyển block, video.currentTime rơi vào đúng khoảng trống đó, hoặc vượt end của
block cũ 1 frame trước khi lệnh seek kịp đáp -> không timestamp nào khớp -> -1.

VÌ SAO CHỈ LỘ KHI BẬT AR: tắt AR thì mọi transform vốn đã là (0,0,100) nên fallback trùng
khít, không ai thấy. Bật AR thì mỗi block một transform riêng (đo được: scale 76-85%,
position khác nhau cả 12 block) -> fallback lệch hẳn -> giật.
VÌ SAO EXPORT KHÔNG DÍNH: export ghi transform TĨNH cho từng đoạn, không dò lại lúc chạy.

CÁCH SỬA: khi dò theo timestamp thất bại, KHÔNG rơi thẳng xuống -1 mà dùng CON TRỎ CLIP
ĐANG PHÁT (getActiveSequenceClipIndex) — vốn đã là nguồn sự thật cho playhead/transcript
(xem mục "Thứ Tự Sequence"), chỉ là getActivePreviewClipIndex trước đây chưa đọc tới.
Thứ tự ưu tiên mới: timestamp -> con trỏ clip -> clip đang chọn -> -1.
Timestamp vẫn THẮNG con trỏ khi nó khớp rõ ràng, nên không phá luồng tua tay/đảo thứ tự.
Sửa một hàm là đủ cho cả 3 nơi dùng: transform preview, keyframe/anim của sprite lane
chính (PixiSequenceRenderer), và overlay Skeleton.

KIỂM CHỨNG (dữ liệu thật nạp từ .crab của dự án):
  trước: t vượt end block0 1 frame -> idx -1, transform (0,0) sc=100   <- lỗi
         t trong khoảng trống nguồn -> idx -1, transform (0,0) sc=100   <- lỗi
  sau  : cả hai trả đúng transform của block tương ứng
  quét 11 mép x 4 mốc thời gian x 2 trạng thái con trỏ = 88 ca: 0 ca rơi về mặc định.
  hồi quy: giữa 12/12 block vẫn đúng index; timestamp vẫn thắng con trỏ khi khớp rõ;
  RAW/MAPPED/timeline rỗng/con trỏ ngoài phạm vi đều giữ nguyên hành vi cũ.

NGUYÊN NHÂN THỨ HAI (vẫn còn giật sau lần sửa trên) — LỆCH PHA ẢNH <-> TRANSFORM:
Preview có HAI đường cập nhật chạy ĐỘC LẬP ở 60fps:
  ẢNH  : PixiSequenceRenderer -> app.ticker -> texture.baseTexture.update()
         => lấy KHUNG HÌNH ĐANG HIỆN của <video>.
  KHUNG: startOverlayPreviewLoop (rAF, editing-runtime) -> updateSequencePreviewTransform
         -> resizeAndRender() => lấy theo video.currentTime ĐÃ YÊU CẦU.
Khi runJumpCutLogic nhảy block, currentTime đổi NGAY (đồng bộ) còn khung hình hiển thị vẫn
là frame cuối block trước cho tới 'seeked'. Đo trên nguồn thật (temp_input.mp4 1728x3072
@59.94fps, 11 mép): seek chỉ 1-11ms (tb 6ms) — tức TỐI ĐA ~1 khung, nhưng ticker vẽ 60fps
nên gần như mép nào cũng dính đúng 1 khung "ẢNH block A + TRANSFORM block B" -> giật.
Đúng 1 khung nên khi phát thấy như rung nhẹ, còn bước từng frame thì thấy rõ.

CÁCH SỬA (2 vế, phải đi cùng nhau):
 1. getActivePreviewClipIndex(): trong lúc video.seeking, GIỮ clip của khung đang hiện
    (settledPreviewClipIndex — chỉ ghi nhận khi !seeking). Không áp khi người dùng đang rê
    playhead (isDraggingPlayhead/isTimelineSeeking) vì rê cần bám tay và seek kéo dài liên
    tục; có trần PREVIEW_SEEK_HOLD_MAX_MS = 400ms để seek treo không làm đứng khung hình.
    Phần dò thuần tuý tách ra resolveActivePreviewClipIndexNow() cho dễ đọc.
 2. Thêm listener 'seeked' ở index.html gọi updateSequencePreviewTransform() NGAY trong
    cùng tác vụ. Nếu để vòng rAF cập nhật ở frame sau thì dính lệch pha CHIỀU NGƯỢC LẠI
    (ảnh block mới + transform block cũ) — vế 1 không chặn được chiều này.

KIỂM CHỨNG (video nguồn thật + transform thật của dự án):
  trước: tại mép, trong lúc seek transform đã nhảy sang block B (vd sc 105 -> 111)
  sau  : 5/5 mép giữ đúng khung của A suốt lúc seek, và đổi sang B đúng lúc ảnh đổi
  hồi quy: đang rê playhead -> KHÔNG giữ (bám tay, đã test); giữa 6/6 block vẫn đúng.
LƯU Ý: seek nhanh (6ms) là do file đã nằm trong cache OS; máy chậm/đọc ổ ngoài thì cửa sổ
lệch pha dài hơn -> càng cần vế 1.

NGUYÊN NHÂN THỨ BA (vẫn còn giật sau CẢ HAI lần sửa trên; sửa 2026-09-09) —
`video.seeking` LÀ SAI TÍN HIỆU ĐỂ GÁC:
Người dùng báo: "khi playhead đi sang vị trí của block video thứ 2 thì 2 FRAME ĐẦU TIÊN lại
hiển thị hình ảnh của video block trước đó với KÍCH THƯỚC của block video phía sau".
`seeking = false` / sự kiện `seeked` chỉ có nghĩa **lệnh tua đã xong và có đủ dữ liệu để
giải mã** — KHÔNG có nghĩa "khung mới đã lên màn hình". Khung còn phải qua bộ giải mã rồi
qua tầng hợp thành, mà `texture.baseTexture.update()` nạp bất cứ thứ gì thẻ <video> đang
giữ ở đúng khoảnh khắc đó. Cửa sổ giữa hai mốc ấy chính là 2 khung bị vẽ sai. Vế 1 ở trên
NHẢ ĐÚNG VÀO cửa sổ đó, nên nó chỉ thu hẹp lỗi chứ không dẹp được.
Thêm nữa: ngay cả khi KHÔNG có cú tua nào, `video.currentTime` vẫn chạy trước tấm hình trên
màn hình tới cả một khung — nó là "vị trí phát chính thức", không phải mốc của khung đang hiện.

CÁCH SỬA (theo Premiere Pro / CapCut: bộ hợp thành làm việc theo SỐ KHUNG — mọi tham số của
clip được tính cho ĐÚNG khung đang dựng, không tồn tại trạng thái "pixel của khung N mà hình
học của khung N+1"):
 - `previewFrameClock` + `trackPresentedPreviewFrames()`: một vòng `requestVideoFrameCallback`
   chạy LIÊN TỤC (không chỉ lúc phát — tua lúc đang DỪNG cũng đưa khung mới lên) ghi lại
   `mediaTime` của khung VỪA ĐƯỢC ĐƯA lên tầng hợp thành, và ĐO `frameDur` tại chỗ. Phải đo,
   không suy từ fps sequence: `mediaTime` sống trong timebase của FILE ĐANG NẠP (proxy LQ
   hoặc bản nối HQ). Reset ở `loadstart` vì đổi nguồn là đổi timebase.
 - `presentedFrameBelongsToClip(i)`: so theo KHOẢNG khung chiếm `[mediaTime, +frameDur)` chứ
   không so một điểm, và ĐÒI GIAO NHAU >= 1/4 KHUNG — khoảng của khung cuối block trước KẾT
   THÚC đúng tại `block.start` của block sau, nên "giao nhau > 0" là sai số dấu phẩy động
   quyết định kết quả và bản sửa thành vô nghĩa.
 - `getActivePreviewClipIndex()`: gác bằng hàm trên thay cho `video.seeking`. Con trỏ đã sang
   block mới mà khung chưa tới -> GIỮ block cũ (giữ cả hình lẫn hình học, nên luôn cùng một
   khung). Trần 400ms giữ nguyên. Thiếu rVFC -> KHÔNG chặn gì (rơi về hành vi cũ, không treo).
 - `previewFrameTime()`: keyframe + hoạt ảnh In/Out của clip lane chính nội suy theo mốc
   KHUNG ĐANG HIỆN, không theo `currentTime` (chỉ tin số đo còn tươi <= 200ms).
 - Lúc DỪNG, mỗi khung mới tới thì `schedulePresentedFrameRedraw()` vẽ lại MỘT lượt. Thiếu
   bước này thì phép gác biến lỗi giật 2 khung thành lỗi hình học SAI VĨNH VIỄN: `seeked` vẽ
   một lượt (còn giữ block cũ) rồi không còn ai vẽ lại nữa.
 - Kèm theo, port từ nhánh v2.0.0 (commit 6dd4f6d): `-reinit_filter 0` TRƯỚC `-i` cho CẢ
   `ExportBatch` LẪN `BuildPreviewProxyCommand`. Với proxy, việc ffmpeg dựng lại đồ hình
   filter giữa đường làm mấy khung ĐẦU của cảnh sau mang hình của cảnh TRƯỚC — cùng một hiện
   tượng, nhưng nằm hẳn trong file proxy nên không phép gác nào ở JS chữa được.
CHỐT BẰNG TEST: `tests/scripts/preview_frame_sync.js` (trích hàm từ index.html qua vm, dựng
lại đúng chuỗi trạng thái của một mép cắt). Đã kiểm bản CŨ với cùng kịch bản: ngay khi
`seeking = false` nó trả index 1 trong khi `mediaTime` vẫn là khung cuối của block 0.

NGUYÊN NHÂN THỨ TƯ, VÀ LÀ NGUYÊN NHÂN GỐC (sửa 2026-09-09, sau khi người dùng báo lại) —
FILE NỐI KHÔNG BẮT ĐẦU Ở PTS 0, NÊN BẢNG ĐOẠN VÀ MEDIA NÓI HAI CHUYỆN KHÁC NHAU:
Ba lớp sửa ở trên đều nằm ở tầng JS và đều ĐÚNG, nhưng không lớp nào chữa được gốc: mốc của
block LỆCH so với nội dung thật của file. Xem khối `RestampVideoStartToZero` trong
`native/sidecar/core_process.cpp` để có đầy đủ số đo. Tóm lại:

- `concat demuxer + -c copy` sinh ra file mà LUỒNG HÌNH bắt đầu ở PTS > 0 (đo 0.021s trên
  dự án người dùng) trong khi luồng TIẾNG vẫn ở 0 — dù MỌI bản chuẩn hoá đưa vào đều có cả
  hai luồng bắt đầu ở 0. Đây là lệch do CHÍNH bước nối tạo ra.
- Chromium KHÔNG bỏ mốc lệch đó đi, nó CỘNG vào timeline của `<video>`: đo được
  `duration` = nội dung + 0.021, và `currentTime = <mốc block 2>` vẫn hiện khung cuối của
  cảnh trước. Bản proxy LQ thừa hưởng một mốc lệch KHÁC (0.016) -> LQ và HQ đổi cảnh lệch
  nhau đúng một khung (đo trong Chromium: ở ct=5.55555 thì LQ đã sang cảnh sau, HQ chưa).
- ffmpeg lúc xuất cũng so `trim=start=` với PTS THẬT -> hút vào một khung của cảnh trước.
- VÌ SAO CHỈ LỘ Ở FPS CAO. Mốc block là 5.538867 (giờ 0-based) nhưng ảnh chỉ đổi ở
  `currentTime` 5.559867 (= mốc + 0.021) -> **cửa sổ lệch rộng đúng 0.021s**. Playhead bám
  LƯỚI KHUNG CỦA SEQUENCE (`roundTimeToFrame`), nên vấn đề là lưới đó có mốc nào lọt vào cửa
  sổ hay không:
  - 30fps: lưới cách nhau 0.0333s — RỘNG HƠN cửa sổ, và hai mốc kề (5.5333 / 5.5667) nằm
    HAI BÊN nó. Không mốc nào lọt vào -> preview sạch.
  - 59.94fps: lưới cách nhau 0.0167s — HẸP HƠN cửa sổ, nên luôn có mốc lọt vào (5.5389 và
    5.5556 đều nằm trong) -> preview lỗi.
  Đúng như người dùng báo: đặt dự án 30fps thì preview sạch mà bản xuất lỗi, đặt 59.94 thì
  preview lỗi. Bản XUẤT thì lỗi ở CẢ HAI nhịp khung, vì `trim` không bám lưới nào của app.
- Bảng đoạn còn cộng dồn theo `format=duration` (MAX của mọi luồng) trong khi concat xếp
  HÌNH theo độ dài HÌNH -> nguồn nào có tiếng dài hơn hình là mốc block khai muộn hơn chỗ
  ảnh đổi. Nay dùng `mediaVideoSegmentSeconds` (số khung / nhịp khung).

CÁCH SỬA — CHỐT MỘT HỢP ĐỒNG DUY NHẤT thay vì bù mốc lệch ở từng nơi tiêu thụ:
**file nối của lane chính LUÔN bắt đầu ở PTS 0.** `RestampVideoStartToZero` remux `-c copy`
ngay sau bước nối, dịch RIÊNG luồng hình về 0 (`-itsoffset` trên input thứ nhất, tiếng lấy
từ input thứ hai không dịch — `-output_ts_offset` dịch cả hai nên kéo tiếng lệch theo).
Nhờ đó bảng đoạn, `trim` khi xuất, `currentTime` của `<video>` và proxy tự khớp, KHÔNG phải
sửa gì trong phần quy đổi thời gian của renderer — mà sửa ở đó thì renderer còn phải biết
đang nạp LQ hay HQ vì hai file lệch khác nhau.
Đã kiểm: proxy dựng từ bản đã chuẩn hoá tự ra `start_time = 0` (mốc lệch của proxy là thừa
hưởng, không phải do nó sinh ra) -> không cần xử lý riêng cho proxy.
Đường xuất còn giữ thêm một lớp phòng vệ: cộng `settings.videoStart/audioStart` đo bằng
ffprobe và lùi NỬA KHUNG NGUỒN ở hai đầu cửa sổ `trim` (xem `WriteClipVideoFilters`) — vô
hại với file đã chuẩn hoá, nhưng vẫn cắt đúng nếu gặp một file nối cũ.
`CONCAT_CACHE_VERSION` lên 5: mọi mục cache cũ vẫn còn mốc lệch.
CHỐT BẰNG TEST: `tests/scripts/seam_frame_accuracy.js` — hai nguồn MÀU ĐẶC khác khổ, kiểm
(1) file nối bắt đầu ở PTS 0, (2) bảng đoạn khớp đúng chỗ đổi nội dung đo được trong file,
(3) từng khung của bản xuất thuộc đúng một cảnh, ở CẢ 30fps lẫn 59.94fps.
ĐO TRÊN DỰ ÁN THẬT trước khi sửa: bản xuất 30fps sai khung 166, bản 59.94fps sai khung 332 —
cùng một lỗi, bản 59.94 chỉ khó thấy hơn vì khung lỗi ngắn hơn một nửa.
```

### Dò Điểm Đổi Góc Máy & Tách Block (Camera-Cut Split Cho Auto-Reframe)

```text
- Vấn đề: block main lane gộp từ nhiều lần bấm máy → góc máy đổi giữa block, nhưng auto-reframe
  chỉ áp MỘT transform tĩnh cho cả block → các đoạn sau bị lệch khung.
- Giải pháp: trước khi analyze, tự động dò điểm đổi góc máy trong từng block, tách block tại đúng
  frame đổi góc thành các block con (mỗi block con = một góc máy), rồi auto-reframe từng block con.
- Cách dò v2 (asr/auto_reframe_sidecar.py, mode "detect_cuts", nâng cấp 2026-07-19): KHÔNG dựa vào
  vị trí mặt người. Nguyên tắc cốt lõi: cắt cứng/đổi góc = GIÁN ĐOẠN THỜI GIAN (1 frame nhảy đột ngột),
  khác chuyển động camera mượt (đổi đều nhiều frame). Nhờ vậy bắt được cả cắt CÙNG BỐI CẢNH (quay lại
  cùng vị trí — hậu cảnh gần như không đổi) mà thuật toán cũ (v1) bỏ sót.
  1) Ứng viên = ĐỈNH scene_score NỔI BẬT so với nền cục bộ (pick_cut_candidates): floor tuyệt đối 0.06
     (thấp), đồng thời đỉnh phải >= trung vị nền trong ±0.5s * scene_prominence(3.0). Không dùng ngưỡng
     tuyệt đối cứng 0.30 như v1 (0.30 làm sót cắt cùng bối cảnh có scene_score ~0.15-0.17). Gộp đỉnh
     cách <0.4s (giữ đỉnh mạnh nhất), bỏ đỉnh sát mép <0.25s, trần 20 ứng viên.
  2) Xác minh GIÁN ĐOẠN THỜI GIAN (verify_camera_change): lấy 5 mốc quanh điểm cắt (bước 0.045s), tính
     4 chênh khung LIÊN TIẾP; ranh giới cắt = chênh lớn nhất trong 2 chênh giữa (cross_diff), 3 chênh
     còn lại = chuyển động 2 bên (side_motion). Xác nhận khi cross_diff >= cut_abs_min(6/255) VÀ
     >= side_motion * cut_prominence(2.2). Cắt thật -> cross vọt (đo thực tế 14-38) >> side (1-3);
     pan/zoom mượt hoặc vẫy tay -> cross ≈ side -> LOẠI. KHÔNG còn phụ thuộc "hậu cảnh phải đổi".
     Thiếu cv2/numpy -> degrade: tin bước đỉnh scene_score.
  3) Chống cắt vụn (min_segment=3.0s): duyệt điểm đã xác nhận theo scene_score GIẢM DẦN, nhận điểm nếu
     cách MỌI ranh giới đã nhận (gồm 2 mép block) >= min_segment -> mọi block con >= 3s, và khi 2 cắt
     quá gần thì GIỮ CÁI MẠNH HƠN. Tất cả tham số nằm trong CAMERA_CUT_DEFAULTS (dễ chỉnh).
- POPUP hỏi trước khi tách (thêm 2026-07-19): trong ensureTimelineAutoReframe, nếu có block cần quét
  cắt (needsCutScan) thì hiện popup #cutPromptPanel "Cắt tại điểm đổi góc máy?" TRƯỚC bước tách.
  askCameraCutSplit() trả Promise<boolean>: "Có, tách block" -> chạy detectCameraCutsAndSplitBlocks như
  cũ; "Không" (hoặc Enter/Escape) -> bỏ qua tách, markAllPendingCameraCutScanned() đánh dấu các block
  là đã quét (để KHÔNG hỏi lại) rồi chỉ căn khung theo block hiện có. Popup TỰ chọn KHÔNG sau 10s nếu
  không trả lời; đồng hồ đếm ngược hiển thị ngay trên nút "Không (n)" (#cutPromptCountdown, 10→0).
  Dành cho video quay chuyển động liên tục: chọn Không để tránh tách vụn.
- Backend: POST /api/auto-reframe/detect-cuts (server.js) — nhận {timeline:[{index,start,end}]},
  giữ nguyên index gốc do renderer gửi, gọi sidecar với mode detect_cuts.
- Renderer (index.html): tích hợp trong ensureTimelineAutoReframe — detectCameraCutsAndSplitBlocks()
  chạy TRƯỚC bước analyze. Tách bằng buildSplitTimelineItems (giữ script_index, chia sub_segments theo
  midpoint từ, xoá auto_reframe để block con được reframe lại). Mỗi block đã quét được đóng dấu
  clip.camera_cut_scan={version,start,end} → không quét lại (kể cả sau undo; stamp được ghi vào item
  gốc TRƯỚC saveHistoryState nên undo không gây vòng lặp tự tách lại). Block <1s không quét.
  Tách xong có undo entry riêng; EDL/XML refresh qua refreshFinalArtifactsFromTimeline().
```

### Menu Ứng Dụng, Chế Độ Nhà Phát Triển & Skeleton Overlay

```text
- Menu header (index.html): 3 nút cũ Dự án mới / Mở / Lưu gom vào MỘT dropdown "☰ Menu ▾" (#btnAppMenu + #appMenuDropdown) cho gọn header.
  - Mục: Dự án mới (doNewProject) | Mở dự án… ⌘O (triggerOpenProject) | Lưu dự án ⌘S (saveProject) | (ngăn) | toggle "Chế độ Nhà phát triển".
  - Mở/Lưu tự bật/tắt theo desktop env (Electron) khi menu mở; bấm ra ngoài hoặc Esc để đóng.
  - Phím tắt Cmd/Ctrl+O (mở), Cmd/Ctrl+S (lưu), Cmd/Ctrl+Shift+S (lưu thành) giữ nguyên như trước.
- Chế độ Nhà phát triển (Developer mode):
  - Toggle trong menu (#menuToggleDevMode), lưu localStorage 'crabbycut_dev_mode' (giữ giữa các phiên).
  - isDevMode() BỌC try/catch (TDZ-safe) vì có thể được gọi rất sớm (syncTimelineSidePanels lúc khởi tạo bước) trước khi biến state khởi tạo.
  - setDevMode/applyDevModeUi đồng bộ nút Skeleton và tắt overlay khi tắt dev.
- Skeleton overlay (chỉ hiện khi Dev mode + bước Editing step4 + FINAL): nút #btnToggleSkeleton trong panelToggleRail (dưới Safe Zone). Vẽ khung xương nhận diện người lên preview để KIỂM CHỨNG độ chính xác nhận diện — dành cho người phát triển.
  - Sidecar Python (asr/auto_reframe_sidecar.py) mode "pose_track": lấy mẫu frame theo fps (mặc định 10), xuất TOÀN BỘ 33 landmark BlazePose (khớp toàn thân + điểm mặt cơ bản) + FaceMesh 468 điểm (nạp lười ensure_face_mesh), toạ độ CHUẨN HOÁ 0..1. track_clip() trả frames:[{t (giây nguồn), pose:[[x,y,vis]*33], face:[[x,y]*N]}]. Suy biến an toàn khi thiếu cv2/mediapipe (pose=null).
  - Backend: POST /api/pose/track → runAutoReframeAnalysis(mode:'pose_track') (dùng chung hạ tầng temp-file với Auto-Reframe).
  - Frontend (index.html): drawSkeletonOverlay() vẽ lên #skeletonOverlayCanvas mỗi lần updateSequencePreviewTransform (đồng bộ playhead). skeletonSpriteMapper() map landmark chuẩn hoá → toạ độ canvas bằng cách ĐỌC TRỰC TIẾP transform của PIXI sprite lane main (position/scale/rotation/texture) nên bám đúng người kể cả khi clip scale/dịch/xoay/lật; có nhánh fallback tính tay khi PIXI không chạy. Fetch pose track theo TỪNG clip (lazy), cache theo key index:start:end; badge trạng thái #skeletonStatusBadge.
  - LƯU Ý: cần cv2 + mediapipe trong python runtime (dùng chung .venv với Auto-Reframe); căn chỉnh trên video XOAY (rotation metadata) là điểm cần kiểm chứng thêm ở máy thật.
```

### Điều Hướng Playhead Theo Khung Hình (← / →, 2026-08-01)

```text
- Phím ← / → lùi/tiến playhead ĐÚNG 1 khung hình, giống nút mũi tên trên phần mềm dựng phim.
  Khả dụng ở MỌI giai đoạn (RAW/MAPPED/FINAL, mọi step). Xử lý trong window keydown handler
  chính (index.html), NGAY SAU nhánh Space, chỉ khi KHÔNG giữ Ctrl/Cmd/Alt/Shift (nhường phím
  tắt OS/trình duyệt) và không nằm trong nhánh guard INPUT/TEXTAREA/contentEditable (để mũi tên
  vẫn di chuyển con trỏ text). Handler editing-runtime (capture phase) KHÔNG chặn mũi tên trừ
  khi đang sửa text overlay trong preview (isEditingPreviewText → stopPropagation), nên vẫn rơi
  xuống handler chính.
- stepPlayheadByFrames(dir): thống nhất mọi chế độ nhờ đi qua getCurrentTimelineTime() /
  setVideoTimeFromTimelineTime() (đều theo KHÔNG GIAN TIMELINE của chế độ hiện tại):
  RAW/MAPPED timeline time == video.currentTime (thời gian nguồn); FINAL == vị trí trên sequence
  đã ghép (băng qua mép block đúng, kể cả khi nguồn 2 block KHÔNG liền nhau — đã test).
  Bám LƯỚI FRAME: frame = round(current*fps); next = clamp((frame ± 1)/fps, 0, tổng) — sau khi
  phát (currentTime hiếm khi rơi đúng mép khung) bước nhảy vẫn sạch, không tích luỹ sai số.
  Luôn video.pause() trước khi bước (quy ước dựng phim). videoDuration ≤ 0 (chưa nạp video) → no-op.
- resolveSourceFps(): parse sequenceSettings.source_fps || sourceVideoInfo.fps, hỗ trợ dạng hữu
  tỉ "30000/1001" (NTSC 29.97) lẫn số thường; mặc định 30, kẹp [1,240] để chặn dữ liệu rác.
```

### Thanh Điều Khiển Preview Kiểu CapCut & FPS Sequence (2026-08-02)

```text
- Thanh điều khiển preview hiện ở MỌI giai đoạn (đồng nhất giao diện, sửa 2026-08-02): trái =
  đồng hồ, giữa = Play, phải = chụp ảnh + FPS + tỷ lệ. Trước đây chỉ hiện ở Editing còn các
  bước khác dùng .timeline-controls-center dưới timeline -> giao diện lệch nhau, đã bỏ.
- syncPreviewControlBar() DỜI (appendChild) #btnPlayPause / #timeDisplay / #btnCaptureFrame
  vào slot MỘT LẦN rồi giữ nguyên (không tạo bản sao) -> mọi listener/id cũ chạy nguyên vẹn.
  Kiểm parentElement.id trước khi append để gọi lại là no-op. .timeline-controls-center giờ
  display:none (nhà dự phòng nếu thanh vắng mặt).
- FPS + tỷ lệ khung hình (2 nút phải) CHỈ hiện khi có sequence: isPreviewSettingsEligible() =
  FINAL && (step3 || step4). RAW/MAPPED (Match Script) và lúc mới mở app -> ẩn 2 nút, nhưng
  transport (Play/đồng hồ/chụp ảnh) vẫn nằm nguyên chỗ -> transport ĐỒNG NHẤT xuyên suốt.
- Thanh là ANH EM của #sequencePreviewShell (không nằm trong shell): updateSequencePreviewLayout
  tính kích thước khung hình theo rect CỦA SHELL, nên để thanh bên trong sẽ làm khung tràn.
  Kèm theo đó .sequence-preview-shell đổi height:100% -> height:auto + flex:1 1 auto để chia
  chiều cao với thanh; ResizeObserver sẵn có tự tính lại khung.
- Menu mở LÊN TRÊN (bottom: 100%) vì thanh nằm ở đáy cột preview.
- FPS SEQUENCE: sequenceSettings.fps ('' = theo video nguồn, mặc định). Đặt trong
  sequenceSettings nên tự đi theo undo/redo (captureFullState) + .crab.
  resolveSequenceFps() = fps tự chọn, không thì resolveSourceFps() (parse được cả "30000/1001").
  Dùng chung cho: bước playhead 1 khung (phím ←/→) và nhánh "Theo nguồn" của export -> con số
  người dùng thấy khi dựng CHÍNH LÀ con số đem render. Đổi FPS cũng đồng bộ luôn #exportFps.
- ĐƯỜNG ĐI CỦA TIMEBASE SEQUENCE TỚI ffmpeg (sửa 2026-09-09 — trước đó ĐỨT ở cả ba chỗ):
  `sequenceSettings.fps` -> `getSequencePayload().fps` -> `sequence.fps` của
  `normalizeSequenceSettings` -> `exportSettings.render_fps` -> `-r` của sidecar.
  Thứ tự ưu tiên của `render_fps` khi hộp thoại Xuất để `'source'` ("Theo Sequence"):
  **`sequence.fps` > `sequence.source_fps` > '30'**. Bậc đầu là con số NGƯỜI DÙNG chọn và
  luôn thắng; bản trước bỏ hẳn bậc đó nên chọn 59.94 mà xuất ra 50 fps (`source_fps` bị
  clip thứ hai ghi đè). Chốt bằng `tests/scripts/export_sequence_fps.js` — cả ba bậc.
- BA DANH SÁCH FPS PHẢI BẰNG NHAU, lệch là lỗi IM LẶNG: `PREVIEW_FPS_CHOICES` (index.html),
  `<select id="exportFps">` (index.html), `EXPORT_FPS_VALUES` (backend/server.js) và
  allowlist `settings.fps` trong sidecar. `select.value = x` với x không khớp option nào
  KHÔNG ném lỗi — DOM đặt selectedIndex = -1 và `.value` trả `''`, rồi `|| 'source'` ở nơi
  đọc biến nó thành "theo nguồn". Dùng `setSelectValueOrAddOption()` để không lặp lại lỗi đó.
- NTSC ĐI BẰNG PHÂN SỐ ĐÚNG, không phải số thập phân: `canonicalFpsText()` (backend) đổi
  '23.976'/'29.97'/'59.94' -> '24000/1001'/'30000/1001'/'60000/1001'. Đây là chỗ DUY NHẤT
  quy đổi. KHÔNG "kéo gần về NTSC" theo sai số: |24 − 23.976| = 0.024 nên mọi ngưỡng đủ
  rộng để bắt 59.94 cũng sẽ kéo 24 fps xuống 23.976 (export_smoke.js bắt được).
- Tỷ lệ khung hình dùng lại applySequencePreset() + SEQUENCE_PRESETS (không thêm state mới),
  và đồng bộ ngược #sequencePreset ở step3.
- Danh sách tỷ lệ (2026-08-02): menu nhóm theo 16:9 / 9:16 / 1:1, mỗi nhóm đủ bậc HD 720p /
  FHD 1080p / 2K QHD / 4K UHD (buildPreviewMenu hỗ trợ {header}). KEY preset (p720/p1080/
  p1440/p2160, vertical_720..2160, square_1080) TRÙNG EXPORT_RESOLUTIONS ở backend/server.js
  -> kích thước sequence và kích thước encode cùng một chuẩn; thêm/đổi bậc phải sửa CẢ HAI:
  SEQUENCE_PRESETS (index.html) + <select id="sequencePreset"> (step3, dùng <optgroup>) +
  EXPORT_RESOLUTIONS (server.js).
```

### Chụp Khung Hình Preview (Export Frame)

```text
- Nút camera tối giản (#btnCaptureFrame, <symbol id="ic-camera">) nằm NGAY BÊN PHẢI ô hiển thị thời gian trong .timeline-controls-center; chỉ bật khi currentMode==='FINAL' và <video> đã có frame (syncCaptureButtonState, gọi từ syncTimelineSidePanels + các sự kiện video).
- Ghép ảnh ở ĐỘ PHÂN GIẢI SEQUENCE giống Premiere "Export Frame" (EditingRuntime.captureCompositeFrame trong editing-runtime.js): nền đen + clip lane chính (drawImage từ <video> previewVideo) + overlay text/shape/ảnh/video theo đúng thứ tự xếp lớp của renderPreviewOverlays, mỗi lớp áp transform + keyframe (effectiveTransformAt) + delta hoạt ảnh (animationStateAt) qua công thức translate→rotate→scale KHỚP preview/export. Text/shape rasterize bằng renderTextItemToPng/renderShapeItemToPng; ảnh/video dùng phần tử preview_<id> đang decode (fallback nạp asset.url). Trả {canvas, seqW, seqH, empty, time}.
- QUAN TRỌNG (clip lane chính): <video> preview có thể là PROXY (LQ ≤720p) nên videoWidth/Height NHỎ hơn nguồn/sequence. Phải vẽ theo "kích thước nguồn" qua contain-fit displayScale = min(source_w/texW, source_h/texH) (giống PIXI resizeAndRender) RỒI mới áp transform.scale; nếu vẽ theo videoWidth thô, clip bị thu nhỏ & lọt nền đen (bug đã sửa 2026-07-19).
- Luồng UI (index.html initFrameCapture): bấm camera → pause video → captureCompositeFrame → mở modal #captureModalPanel hiển thị ảnh preview + checkbox "Thêm ảnh vừa chụp vào tệp phương tiện của dự án" + nút "Lưu ảnh…"/"Huỷ" (Esc/backdrop để đóng).
- Lưu file: desktop (Electron) qua IPC 'save-frame-image' (electron/main.js dialog.showSaveDialog + ghi PNG từ base64; preload expose desktopEnv.saveFrameImage); web fallback = tải xuống bằng thẻ <a download>. Tên file mặc định frame_<phút>m<giây>s<centisec>.png theo playhead.
- Thêm vào dự án (nếu tick checkbox): EditingRuntime.addCapturedImageToProject(blob,name) → tái dùng importFiles('media',[file]) → POST /api/editing-assets/upload → asset media_image hiện trong panel Tệp phương tiện.
```

### Dao Cắt & Trim Handle Ở Bước RAW/MAPPED (2 lỗi đã sửa 2026-07-31)

```text
BỐI CẢNH: block màu trên timeline ở step1/step2/step3 do PIXI vẽ; phần BẮT CHUỘT là các
DOM .timeline-hit-block (kèm 2 .resize-handle) do perf-runtime.js dựng theo POOL (hitPool)
bên trong #segmentsTrack. Mất các node này = mất cả trim VÀ dao cắt, dù nhìn vẫn thấy block.

1) LỖI "mở .crab lên thì không trim/không cắt được ở Match Script"
   - Nguyên nhân: giai đoạn Editing xoá sạch #segmentsTrack bằng innerHTML=''
     (editing-runtime.js: renderEditingTimeline() và restoreStandardTimeline()). Node trong
     hitPool bị TÁCH khỏi DOM nhưng vẫn còn trong mảng pool, nên lần vẽ sau ensureHitNode()
     trả lại node cũ (`if (hitPool[slot]) return hitPool[slot]`) mà KHÔNG gắn lại vào track
     → #segmentsTrack rỗng vĩnh viễn ở RAW/MAPPED/FINAL-step3.
     Dự án mới không lỗi vì chưa lần nào vào Editing; mở .crab (đã lưu ở step3/step4 hoặc
     quay lại step trước) thì đi qua đường xoá này.
   - Sửa (perf-runtime.js ensureHitNode): node lấy từ pool mà `!node.isConnected` thì
     appendChild lại vào #segmentsTrack. Pool tự lành sau MỌI đường xoá track.

FIX (2026-08-22) "tay cầm trim không bắt dính playhead" ở giai đoạn Match Script
- Ngưỡng: `MATCH_TRIM_SNAP_SECONDS = 0.2` (thời gian CỐ ĐỊNH) -> `matchTrimSnapSeconds()` =
  `MATCH_TRIM_SNAP_PX(10) / zoomScale`, tức tính theo PIXEL như lane overlay ở Editing. Ngưỡng
  cũ = 120px khi zoom 600% (dính lung tung) nhưng chỉ 4px khi zoom 20% (không dính nổi).
  perf-runtime.js đọc `window.matchTrimSnapSeconds()`; trước đây nó đọc
  `window.MATCH_TRIM_SNAP_SECONDS` — vốn là `const` trong script inline nên KHÔNG nằm trên
  window -> luôn rơi về hằng số 0.2s.
- snapTrimBoundary(): playhead và mép block khác nay tranh MỘT cuộc thi theo khoảng cách (gần
  nhất thắng, playhead thắng khi bằng điểm). Bản cũ gán playhead trước rồi để vòng lặp mép
  block ghi đè với `bestDistance` khởi tạo bằng CẢ ngưỡng -> chỉ cần có bất kỳ mép block nào
  trong ngưỡng là playhead bị hất ra dù xa hơn nhiều; ở RAW/MAPPED các block gần như liền nhau
  nên mép liền kề LUÔN thắng.
- snapTrimItemToAdjacentBoundaries() (bước CHỐT khi nhả chuột): thêm playhead làm ứng viên,
  xét SAU cùng và thắng khi bằng điểm. Trước đây hàm chỉ xét mép block liền kề rồi GHI ĐÈ vô
  điều kiện -> mép vừa dính đúng playhead trong lúc kéo bị hất về mép block bên cạnh ngay khi
  nhả chuột.

2) LỖI "cắt lệch playhead dù dao đã snap vào playhead"
   - Nguyên nhân: findNearestSplitBoundary() hút điểm cắt về khe giữa 2 chữ GẦN NHẤT mà
     KHÔNG giới hạn khoảng cách. Câu thoại thưa chữ → cắt lệch tới vài trăm ms (đo được
     0.38s với chữ dài 1s), phá vỡ độ chính xác edit.
   - Sửa (index.html):
     * RAZOR_WORD_SNAP_SECONDS = 0.08 — chỉ hút về khe chữ khi khe nằm trong ngưỡng đó,
       xa hơn thì tôn trọng đúng vị trí dao.
     * findNearestSplitBoundary(item, time, {exact:true}) → cắt ĐÚNG time (bỏ hút chữ).
       splitMappedChunkAt/splitLatestTimelineAt nhận options và chuyển tiếp cờ này.
     * Handler mousedown dao cắt: khi getRazorPointerContext() báo snapped (dính playhead)
       thì lấy THẲNG video.currentTime làm điểm cắt (không quy đổi qua pixel/ratio) và bật
       exact → điểm cắt trùng khít playhead.
```

### Thứ Tự Sequence: Kéo-Thả Block Trên Timeline & Playhead Liên Tục (2026-08-01)

```text
GỐC VẤN ĐỀ: ở FINAL, thứ tự phát là THỨ TỰ MẢNG latestTimeline, còn video.currentTime là
timestamp NGUỒN. Khi block bị đảo thứ tự (hoặc 2 block trùng vùng nguồn sau khi cắt) thì
KHÔNG thể suy vị trí trên timeline từ timestamp nữa. Code cũ suy theo kiểu "cộng dồn tới
block đầu tiên chứa currentTime" -> playhead nhảy về đầu timeline khi phát tới block đã
sắp xếp lại; qua khỏi block đó lại đúng.

CON TRỎ CLIP SEQUENCE (state dùng chung, index.html):
- activeSequenceClipIndex + setActiveSequenceClipIndex()/getActiveSequenceClipIndex():
  chỉ số clip ĐANG PHÁT trong latestTimeline.
- resolveSequenceClipIndexAtVideoTime(t): ưu tiên con trỏ, chỉ khi con trỏ không còn chứa t
  mới dò toàn mảng (seek/scrub tay).
- sequencePositionAtTimelineTime(seqTime) -> {index, videoTime}: dùng cho cả
  mapTimelineTimeToVideoTime() và để ghim con trỏ khi seek theo vị trí sequence.
- Ai cập nhật con trỏ: vòng lặp playback (perf-runtime runJumpCutLogic + nhánh timeupdate
  legacy ở index.html), setVideoTimeFromTimelineTime (seek theo sequence), selectTimelineClip
  ({seek:true}), nút Preview Cuts (về 0), reorderTimelineClip (dịch theo block).
- Ai ĐỌC con trỏ: getCurrentTimelineTime (vị trí playhead), findActiveIndexFinal
  (highlight transcript ảo), getActivePreviewClipIndex + timelineClipIndexAtCurrentTime
  (transform/keyframe của clip đang phát).
- perf-runtime: nhánh FINAL của runJumpCutLogic giờ chạy CẢ khi Preview Cuts (trước đây
  preview rơi xuống nhánh dò theo timestamp nên vẫn lỗi), hết sequence thì pause + tự tắt
  chế độ preview. playbackState.jumpCursor chỉ còn dùng cho MAPPED (index của mảng đã
  filter is_selected — KHÔNG cùng không gian chỉ số với latestTimeline).

KÉO-THẢ BLOCK TRÊN TIMELINE (chỉ step3/FINAL, index.html):
- Bắt trong handler mousedown của #segmentsTrack (nhánh FINAL không dùng dao cắt), ngưỡng
  5px mới tính là kéo -> click thường vẫn chọn/tua clip như trước.
- computeBlockDropTarget(): so con trỏ với ĐIỂM GIỮA từng block trong mảng ĐÃ BỎ block đang
  kéo -> insertAt chính là tham số `to` của reorderTimelineClip.
- Phản hồi thị giác: .timeline-hit-block.is-reordering + #blockDropIndicator (vạch xanh chèn,
  con của #segmentsTrack, tự gắn lại nếu track bị xoá khi đi qua Editing).
- Sau khi kéo phải chặn cú 'click' đi kèm (suppressNextTimelineClick) vì index đã đổi.
- KHÔNG có auto-scroll khi kéo tới rìa viewport (đổi scrollLeft sẽ kích hoạt logic snap tâm
  + seek của timeline). Zoom nhỏ lại để chuyển block đi xa.
- reorderTimelineClip(from, to) là điểm DÙNG CHUNG với kéo-thả đoạn ở panel transcript
  (perf-runtime drop handler): saveHistoryState -> splice -> DỊCH con trỏ clip theo block
  (cursor===from ? to : remap chuẩn remove-then-insert) -> render transcript + timeline +
  refreshFinalArtifactsFromTimeline.

CLICK MAIN CLIP BLOCK Ở EDITING — tua tới VỊ TRÍ CON TRỎ (editing-runtime.js):
- Handler click của .editing-main-block: trước đây setPrimaryMainSelection(index,{seek:true})
  -> tua playhead về ĐẦU block. Nay chọn với {seek:false} rồi setSequenceTime(seqTime) với
  seqTime = clamp(timelineFromClientX(event.clientX), span.start, span.start+span.duration).
- Playhead cố định giữa -> setSequenceTime -> setVideoTimeFromTimelineTime ->
  scrollTimelineToCurrentTime() tự cuộn timeline sao cho điểm click nằm chính giữa.
- Kẹp trong [span.start, span.end] để block được CHỌN và playhead luôn thuộc CÙNG một block
  (kể cả khi con trỏ rơi sát mép/ra ngoài do sai số pixel).
- Cmd/Ctrl-click vẫn chỉ toggle multi-select, KHÔNG seek (nhánh isAdditiveSelectionEvent).

POPUP "Cắt tại điểm đổi góc máy?" — chỉ hỏi MỘT lần:
- ensureTimelineAutoReframe() chỉ dò/hỏi khi được gọi với {askCameraCut:true}. Từ SỬA
  2026-09-14 (Auto-Reframe mặc định tắt, chỉ chạy qua nút "AR"), KHÔNG còn đường gọi nào
  truyền cờ này — popup này hiện không còn được kích hoạt trên thực tế (logic vẫn còn
  trong code, chờ quyết định có gắn lại vào nút "AR" hay bỏ hẳn).
- Cờ cameraCutPromptAsked được bật NGAY TRƯỚC khi popup thật sự hiện (không bật ở showStep):
  nếu lúc vào Editing đang có lượt Auto-Reframe chạy dở, yêu cầu hỏi được giữ lại qua
  autoReframePendingAsk và chạy ở lượt hoãn -> không mất popup "một lần duy nhất".
- Mở dự án .crab khác -> reset cờ (được hỏi lại 1 lần).
```

### Lane Chính Ở Editing: Trim 2 Đầu, Đổi Thứ Tự, Alt-Nhân Bản (2026-08-01)

```text
VÌ SAO PHẢI CÓ CƠ CHẾ RIÊNG (không dùng lại editingDrag của overlay):
- Block lane chính KHÔNG phải editingItems[] mà là latestTimeline[i]. Toạ độ của nó là
  VÙNG NGUỒN (clip.start/clip.end); vị trí trên timeline do phép cộng dồn của
  mainClipSequenceSpans() sinh ra, không có field timeline_start.
- Hệ quả: lane chính xếp gạch LIỀN MẠCH, không có khái niệm "khoảng trống".

TRIM 2 ĐẦU (mode resize-left / resize-right, editing-runtime.js):
- GHIM ĐẦU KHÔNG BỊ KÉO (sửa 2026-08-02). Playhead ghim CỐ ĐỊNH GIỮA khung nhìn nên timeline
  tự cuộn theo getCurrentTimelineTime(). Khi trim đầu TRÁI, clip.start tăng -> thời gian
  sequence của playhead giảm đúng bằng lượng trim -> khung nhìn cuộn trái đúng bằng đó ->
  TÌNH CỜ trông như "đầu trái bám chuột, đầu phải đứng yên". Nhưng khi clip.start vượt QUA
  playhead thì playhead không còn trong block, getCurrentTimelineTime() trả mốc đầu block
  (hằng số) -> cuộn đứng lại -> đầu trái khựng tại playhead, đầu phải chạy ngược sang trái.
  Chữa: lúc kéo thì TẮT việc playhead kéo khung nhìn (beginTimelineViewPin) và tự ghim đầu
  KHÔNG bị kéo vào đúng vị trí màn hình cũ (pinTimelineTimeToViewportX, index.html). Ghi
  anchorViewportX lúc mousedown; mỗi frame kéo ghim lại theo span mới. Nhờ đó "kéo đầu nào
  chỉ đầu đó chạy" đúng ở MỌI vị trí playhead. Ghim phải đặt isProgrammaticScroll, nếu không
  handler 'scroll' tưởng người dùng cuộn tay rồi snap + tua video ngay giữa lúc trim.
  Đo: kéo đầu trái +60/120/180/240/300px -> đầu trái dịch đúng từng ấy px, đầu phải đứng yên
  tuyệt đối, clip.end không đổi; đầu phải tương tự và clip.start không đổi.
- Mỗi .editing-main-block nay có .editing-resize-handle left/right y hệt block overlay
  (chỉ thêm khi lane chính KHÔNG khoá).
- ĐIỂM GIAO 2 BLOCK: TRIM ĐÚNG BLOCK ĐANG CHỌN (sửa 2026-08-03). Lane xếp gạch liền mạch nên
  tay cầm PHẢI của block A và tay cầm TRÁI của block B dính sát nhau (mỗi cái 6px). Trước đây
  block bị trim là block chứa `event.target`, nên đang chọn A mà con trỏ lệch vài pixel sang B
  là trim nhầm đầu B (lỗi người dùng gặp). Nay `resolveMainTrimTarget(index, side)`: nếu tay cầm
  vừa cầm thuộc block KHÔNG được chọn mà block đối diện của CHÍNH điểm giao đó đang được chọn
  thì chuyển thao tác về mép tương ứng của block đang chọn (cầm mép trái B khi chọn A -> trim
  mép phải A, và ngược lại). Không chọn block nào, hoặc cầm đúng block đang chọn -> giữ nguyên
  hành vi cũ, nên vẫn trim được block chưa chọn. Trạng thái "đang chọn" đọc qua
  `mainClipIsSelected()` — CÙNG biểu thức renderer dùng để tô viền vàng, không được viết lại.
  Đo trên app: chọn A rồi cầm mép trái B kéo −40px -> A.end 5.00→4.60, B giữ nguyên; chọn B rồi
  cầm mép phải A kéo +40px -> B.start tăng, A giữ nguyên; không chọn gì -> trim đúng block cầm.
- Kéo mép TRÁI đổi clip.start, mép PHẢI đổi clip.end. Đây là RIPPLE kiểu CapCut: block
  trước vẫn dính mép, mọi block phía sau dồn theo, tổng thời lượng sequence đổi.
- Sàn thời lượng MAIN_CLIP_MIN_DURATION = 0.2s; trần của clip.end là videoDuration
  (nguồn = temp_input.mp4 đã nối) nên kéo giãn ra ĐƯỢC phần đã cắt bỏ trước đó.
- snapMainSourceEdge(proposed, excludeIndex, thresholdSec, playheadSourceTime): bắt dính mép
  đang kéo vào (a) start/end NGUỒN của clip khác -> kéo lại đúng điểm đã cắt, và (b) PLAYHEAD.
  Snap tính theo thời gian NGUỒN, không phải thời gian sequence.
  - FIX (2026-08-22) "tay cầm không bắt dính playhead" ở lane chính: trước đây hàm KHÔNG có
    mốc playhead nào (khác lane overlay — snapEdgeTime đã có playhead từ đầu). Nay
    startMainBlockDrag lưu `playheadSourceTime = clip.start + (playheadSeq − span.start) ×
    speedRate`, tính MỘT lần lúc bắt đầu kéo: trong lúc kéo, span đổi liên tục theo ripple nên
    quy đổi lại mỗi frame sẽ khiến mốc chạy theo tay kéo và không bao giờ dính được.
  - Vì sao quy về giờ NGUỒN mà không so trên trục timeline: với ripple, mép TRÁI của block
    KHÔNG đổi vị trí sequence (span.start = tổng thời lượng các clip trước), lại thêm view
    được ghim ở span.end -> khoảng cách MÀN HÌNH giữa tay cầm trái và vạch playhead là HẰNG SỐ
    suốt cú kéo, không có "tới gần" để mà dính. Mốc nguồn là mốc duy nhất đứng yên, và nó đúng
    nghĩa "cắt vào đúng khung hình playhead đang chỉ". Với mép PHẢI (view ghim ở span.start)
    thì hai cách trùng nhau, nên vẫn là bắt dính thị giác như người dùng mong đợi.
  - Ngưỡng = editingMoveSnapThresholdSeconds() × speedRate(clip): 10px trên trục timeline quy
    ra giây NGUỒN (ở 2x, 10px timeline là 0,2s nguồn).
  - Thứ tự xét: mép clip khác trước, playhead sau và THẮNG khi bằng điểm.
- Mỗi frame chỉ gọi updateTimelineLayout() (gộp bằng rAF): tổng thời lượng đổi nên phải
  dựng lại cả thước lẫn block, không thể chỉ sửa style của 1 block như trim ở RAW/MAPPED.
- Chốt (commitMainClipTrim): refreshMainClipWords() dựng lại text + sub_segments từ
  allWordsCache/globalRawSegments (đúng công thức của finishTrimResize ở RAW/MAPPED, giữ
  nguyên text cũ nếu không còn từ nào) -> renderWordLevelTranscript ->
  syncScriptHighlightAndTrim -> refreshFinalArtifactsFromTimeline -> đặt lại playhead theo
  MỐC TRƯỚC KHI KÉO (kẹp trong tổng mới), nếu không con trỏ rơi ra ngoài clip và nhảy về 0.
- Trim ghi thẳng vào clip trong lúc kéo -> mất focus giữa chừng vẫn CHỐT (muốn huỷ thì Undo).

ĐỔI THỨ TỰ (mode move):
- "Di chuyển" trên lane chính = đổi THỨ TỰ MẢNG, không phải đổi thời điểm. Ngưỡng 5px mới
  tính là kéo, dưới ngưỡng vẫn là click chọn/tua như cũ.
- mainDropTargetFromClientX() so con trỏ với ĐIỂM GIỮA từng block trong mảng ĐÃ BỎ block
  đang kéo (cùng công thức computeBlockDropTarget của step3) -> tham số `to` của
  reorderTimelineClip(), tức DÙNG CHUNG đường dịch con trỏ clip đang phát.
- Phản hồi thị giác: .editing-block.is-main-dragging + #editingMainDropIndicator (vạch xanh
  chỉ CAO BẰNG lane chính, con của #segmentsTrack nên phải tự gắn lại sau mỗi render).

ALT + KÉO = NHÂN BẢN (mọi lane):
- Lane chính (mode duplicate): chèn thêm 1 bản sao clip vào vị trí thả, vẫn ở lane chính —
  clip lane chính không tồn tại được ở lane overlay. Bỏ field `transition` của bản sao
  (chuyển cảnh gắn với cặp block kề nhau ở vị trí cũ) và dịch activeSequenceClipIndex.
- Lane overlay (startItemDrag): tạo bản sao TẠI CHỖ rồi kéo chính BẢN SAO, nên thả sang lane
  khác/vị trí khác dùng luôn trackForItemDrop() sẵn có (kể cả tự tạo lane mới). Bản sao bỏ
  `magic_fill_review` và `transition`. History ghi TRƯỚC khi chèn bản sao.
- Alt KHÔNG phải phím multi-select (isAdditiveSelectionEvent chỉ nhận Shift/Cmd/Ctrl) nên
  không đụng nhau; Alt+lăn chuột vẫn là zoom timeline.

ĐƯỜNG SỰ KIỆN (vì sao index.html phải gọi thẳng vào editing-runtime):
- Handler mousedown CAPTURE của #segmentsTrack (index.html) buộc phải stopPropagation cho
  block lane chính, nếu không sự kiện rơi xuống #timelineTrack và biến cú kéo thành seek
  playhead. stopPropagation ở pha capture cũng chặn luôn listener của chính block -> ở step4
  handler đó gọi thẳng window.EditingRuntime.startMainBlockDrag(e, block).
- Sau khi kéo phải bỏ cú 'click' đi kèm ở CẢ HAI chỗ: suppressNextMainBlockClick (handler
  của block) và window.suppressNextTimelineClickOnce() (handler chung của #segmentsTrack —
  block có thể đã bị dựng lại giữa chừng nên click rơi thẳng xuống track).
- Dao cắt vẫn được ưu tiên: toàn bộ nhánh trên nằm trong điều kiện !isRazorToolActive.
```

### Sao Chép Block Lane Chính Lên Lane Overlay (2026-08-11)

```text
CÙNG MỘT PHÍM TẮT với Alt-nhân bản trong cùng lane; khác nhau ở chỗ THẢ Ở ĐÂU:
  - thả trên lane chính            -> chèn bản sao vào lane chính (duplicateMainClipTo, như cũ)
  - thả trên lane MEDIA đã có      -> block media overlay đặt vào lane đó
  - thả ở bất kỳ đâu khác trong khu vực VISUAL (kể cả trên lane text/shape/adjust)
                                   -> tạo LANE MEDIA MỚI ngay tại chỗ đó rồi đặt vào
  - lane audio / lane media KHOÁ   -> từ chối, rơi về nhân bản trong lane chính
Bắt phải thả trúng khe 8px giữa 2 lane thì gần như không ai thả trúng khi khu vực visual
đã kín lane text — nên lane visual khác loại cũng nhận, chứ không trả null.

NGUỒN CỦA BẢN SAO — KHÔNG CHÉP FILE:
- Backend `GET /api/editing-assets/main-source` mô tả temp_input.mp4 như một asset Editing
  (dùng lại `editingAssetPayload`, nên có path/url/width/height/duration/has_audio). Block
  overlay chạy trên CHÍNH file nguồn, chỉ khác `source_start`.
- `id` băm từ path+size+mtime -> dự án mới ghi đè temp_input.mp4 là ra asset khác, không
  dùng nhầm dữ liệu cũ. Vì thế bộ nhớ đệm ở frontend bị XOÁ mỗi lần vào Editing
  (`resetMainSourceAssetCache`).
- HAI TẦNG ở frontend: `ensureMainSourceInfo()` chỉ hỏi backend (nạp sẵn lúc vào Editing để
  cú thả chuột không phải chờ ffprobe/thumbnail); `ensureMainSourceAsset()` mới GHI vào
  editingAssets — chỉ khi thật sự sao chép, để dự án không mọc thêm asset chẳng ai dùng.
- Asset này mang `source:'main'` và bị lọc khỏi danh sách "Tệp phương tiện" (cùng chỗ lọc
  `source:'library'`): người dùng không nhập tệp này, và xoá nó khỏi dự án thì vô nghĩa.

DỰNG BLOCK (copyMainClipToOverlay):
- `source_start = clip.start`, `duration = (clip.end - clip.start) / rate` — clip.start/end là
  giờ NGUỒN còn duration của item là giờ SEQUENCE, quên chia rate là block dài gấp rate lần.
- `transform.scale = MagicFillAssets.coverScalePercent(...)`: clip lane chính phủ kín khung
  nên bản sao cũng phải phủ kín, nếu không cỡ block đổi hẳn ngay lúc thả.
- MANG THEO những gì gắn với BLOCK và dùng CHUNG TÊN TRƯỜNG ở cả hai phía: `speed`,
  `adjustments`, `retouch`, `audio_denoise`. KHÔNG mang `auto_reframe` (việc của lane chính)
  và `transition` (gắn với cặp block kề nhau ở vị trí cũ).
- TIẾNG: giữ nguyên mức (`volume = clip.audio_volume`) nhưng `muted: true`. Không tắt thì lời
  thoại phát 2 lần chồng lên nhau ngay khi thả; bật lại là về đúng mức của clip gốc.
- Vị trí thả bám con trỏ: `grabOffsetSec` ghi lúc mousedown (khoảng cách từ mép trái block
  tới con trỏ), rồi qua snapMoveStart() như mọi block overlay khác.

NGƯỠNG KÉO PHẢI XÉT CẢ HAI TRỤC (sửa cùng lúc):
- handleMainBlockDrag trước đây chỉ đo |dx| < MAIN_DRAG_THRESHOLD_PX. Cú kéo lên lane overlay
  gần như THẲNG ĐỨNG -> không bao giờ được coi là "đã kéo". Nay xét cả |dy|.

PHẢN HỒI THỊ GIÁC: #editingMainOverlayGhost — hình chữ nhật đúng bề rộng bản sao (đã tính
tốc độ). Nằm đúng lane khi lane đã có; bám con trỏ + viền NÉT ĐỨT khi sẽ tạo lane mới.
```

### Quét Chuột Chọn Nhiều Block (Marquee, 2026-08-11)

```text
Kéo từ VÙNG TRỐNG của khu vực lane vẽ khung chọn; mọi block GIAO với khung đều được chọn —
block lane chính lẫn overlay, xuyên lane. Giữ Shift/Cmd/Ctrl lúc BẮT ĐẦU = cộng thêm vào
lựa chọn đang có. Lane KHOÁ bị bỏ qua (giống mọi đường chọn khác).

VÌ SAO CHẶN mousedown THAY VÌ CHỈ NGHE THÊM:
- mousedown trên #timelineTrack (index.html) bật `isDraggingPlayhead` rồi tua playhead theo
  con chuột. Để nguyên thì một cú quét vừa vẽ khung vừa tua.
- Nghe ở pha CAPTURE của #timelineTrack, tức TRƯỚC cả handler capture của #segmentsTrack lẫn
  handler bubble trên chính #timelineTrack. Chỉ stopPropagation khi THẬT SỰ mở khung chọn,
  nên mousedown trên block / tay cầm trim / dải thước đi tiếp y như cũ.
- Dải thước (contentY < LANE_TOP_PADDING) KHÔNG đụng tới -> vẫn kéo để tua như trước.
- Click thường (không vượt ngưỡng 4px): finishEditingMarquee tự tua playhead tới vị trí con
  trỏ — đúng việc mà cú mousedown bị chặn vẫn làm trước đây — rồi handler 'click' cũ chạy
  tiếp và vẫn chọn clip như cũ.
- ĐÁNH ĐỔI: trong khu vực lane không còn KÉO-để-tua liên tục (kéo giờ là quét chọn). Muốn
  scrub bằng cách kéo thì dùng dải thước phía trên.

HÌNH HỌC:
- Hit-test làm trong TOẠ ĐỘ NỘI DUNG: x = outer.scrollLeft + (clientX − outerRect.left)
  (cùng hệ với timelineX/pxToTimelineTime), y = (clientY − frameRect.top) + outer.scrollTop.
- `marqueeBlockRects()` dựng rect theo ĐÚNG công thức renderEditingTimeline dùng để đặt block
  (laneRowTop + 6, laneHeight − 12, bề rộng lane chính đã chia tốc độ). Lệch công thức là
  khung chọn "trượt" so với thứ người dùng nhìn thấy.
- Khung vẽ trong .timeline-track-frame (#editingMarqueeBox) chứ không phải #segmentsTrack:
  #segmentsTrack bị innerHTML='' mỗi lần render nên khung sẽ biến mất giữa cú kéo.
- Trong lúc kéo chỉ toggle class .is-selected TRỰC TIẾP trên DOM (refreshSelectionClasses);
  bản render đầy đủ + updateTimelineSelectionVisuals chạy MỘT LẦN lúc thả chuột.
- Thả xong phải bỏ cú 'click' đi kèm ở cả hai chỗ (suppressNextMainBlockClick +
  window.suppressNextTimelineClickOnce), nếu không nó chọn lại đúng 1 clip dưới con trỏ và
  phá sạch lựa chọn vừa quét.
- Dao cắt vẫn được ưu tiên: không mở khung chọn khi isRazorToolActive.
```

### Kéo Cả Nhóm Sang Lane Khác (2026-08-11)

```text
Trước đây kéo nhiều block cùng lúc bị KHOÁ LANE (chỉ dịch ngang). Nay mở khi nhóm ĐỒNG NHẤT:
mọi block trong nhóm CÙNG LOẠI và đang CÙNG MỘT LANE (`editingDrag.groupLaneMovable`, chốt
một lần lúc startItemDrag).
- Nhóm lẫn loại (text + media): không có lane đích nào nhận được cả nhóm.
- Nhóm rải nhiều lane: "đổi lane" không còn nghĩa — dồn hết về một lane sẽ đè lên nhau.
Hai trường hợp đó giữ nguyên nếp cũ là khoá lane.

Lane đích lấy từ CHÍNH `trackForItemDrop()` mà đường kéo 1 block đang dùng, nên tự có luôn:
lane cùng loại khác, và tạo LANE MỚI khi thả ở vùng trống (nhớ trong editingDrag.createdTrackId
để mỗi cú kéo chỉ tạo một lane). Cả nhóm đổi track_id cùng lúc; lượng dịch ngang vẫn tính
theo block đang nắm (snapMoveStart) rồi áp đều cho mọi block trong nhóm.
```

## Đợt UI/UX Pro — Phase A (2026-08-19)

Rà soát toàn bộ UI rồi nâng theo chuẩn CapCut/Premiere. Phase A = nền tảng token + thước thời gian + chrome block. Ràng buộc cứng: playhead ghim 50% giữa panel timeline, và KHÔNG đụng logic/thuật toán.

### A2. Thước thời gian của Editing stage (mới)

```text
VÌ SAO PHẢI VIẾT MỚI (đo được ở runtime, step4, dự án trống):
- getTimelineDuration() = 0, videoDuration = 0
- drawRuler() (index.html) `return` sớm ở dòng đầu: `if (videoDuration === 0) return;`
- canvas ruler của Pixi chưa bao giờ được resize -> 2x2 px
- document.querySelectorAll('.time-ruler-label').length === 0
=> Dải LANE_TOP_PADDING (30px) phía trên lane bỏ trống hoàn toàn. Không NLE nào thiếu thước.
Thêm nữa: rule `body.editing-stage-active .time-ruler-label-layer { left: 168px }` trỏ SAI class
(thực tế là `.time-ruler-labels`) nên nhãn của luồng cũ nằm dưới rail nhãn lane.

CÁCH LÀM (editing-runtime.js):
- renderEditingRuler() gọi ở cuối renderEditingTimeline() + từ showStep('step4').
- DOM: <div id="editingRuler" class="editing-ruler"> chèn làm con ĐẦU của #timelineTrack.
  * position: sticky; top: 0  -> ghim theo TRỤC DỌC (thước cũ nằm trong vùng cuộn dọc nên trôi mất).
  * Nằm TRONG nội dung cuộn ngang -> tick đặt theo toạ độ NỘI DUNG timelineX(t), cuộn ngang tự khớp block.
  * .editing-ruler-rail: position sticky; left: 0; width var(--lane-rail-w) -> che vùng rail nhãn lane,
    đúng thủ pháp .editing-lane-label đang dùng. Hiện "<fps> fps".
  * z-index 31 (trên rail nhãn lane 30, dưới #playhead 50 -> playhead vẫn cắt qua thước như NLE thật).
- Ảo hoá theo viewport: chỉ dựng tick trong [scrollLeft + LANE_LABEL_WIDTH, scrollLeft + clientWidth],
  trần RULER_TICK_BUDGET = 900 tick -> chi phí không đổi theo độ dài timeline.
- Bậc tick LIÊN TỤC (rulerSteps): lấy bước "đẹp" nhỏ nhất trong [1/fps, 0.1, 0.2, 0.5, 1, 2, 5, 10,
  15, 30, 60, 120, 300, 600, 1800] sao cho step*zoom >= RULER_LABEL_GAP (110px); tick phụ = major/5
  (hoặc /2, hoặc bỏ) và không mịn hơn 1 khung. Đo thật: zoom 20 -> nhãn mỗi 10s (200px);
  60 -> 2s (120px); 150 -> 1s (150px); 300 -> 15 khung (150px); 600 -> 6 khung (120px).
- Nhãn = formatTimecode(sec, fps) trong index.html: HH:MM:SS:FF non-drop-frame, dùng
  resolveSequenceFps() đã có. formatTime/formatClock/formatClockPad giữ NGUYÊN.
  Ô #timeDisplay ở thanh preview cũng đổi sang timecode này (3 chỗ trong index.html +
  updateTimeDisplayOnly trong perf-runtime.js — thiếu chỗ này là đồng hồ vẫn hiện format cũ khi phát).

AN TOÀN VỚI PLAYHEAD: renderer chỉ ĐỌC zoomScale / scrollLeft / timelineTimeToPx / pxToTimelineTime.
Không sửa và không bọc seekTimeline, scrollTimelineToCurrentTime (kể cả bản ghi đè ở perf-runtime.js),
updatePlayhead, hay handler scroll/wheel. Đo sau khi cuộn + zoom: playhead.style.left === '50%',
transform 'translateX(-50%)', lệch tâm khung = 0px.

BẪY 1 — HOOK PHẢI GẮN MỘT LẦN, KHÔNG GẮN TRONG ensureEditingRuler():
Thước được tạo LƯỜI (lần render đầu ở step4) nên gắn listener theo nó sẽ trượt mọi lượt zoom trước đó.
installEditingRulerHooks() gọi từ khối setup chung (cạnh setupPanelImportDnd) và gắn: scroll + wheel
trên #timelineTrackOuter, input trên #zoomSlider, resize trên window. Đều là listener RIÊNG, không
bọc/không sửa handler nào đang có. Cần cả zoom lẫn wheel vì updateTimelineLayout() thoát sớm khi
videoDuration === 0 (dự án chỉ có overlay) nên chuỗi renderEditingTimeline không chạy lại khi zoom.

BẪY 2 — rAF ĐƠN ĐỘC LÀ TREO VĨNH VIỄN KHI CỬA SỔ BỊ ẨN:
scheduleEditingRulerRender() ban đầu chỉ dùng requestAnimationFrame. Cửa sổ ẩn (tab nền, thu nhỏ,
và cả khung xem trước của Claude Code — đo được document.hidden === true, rAF KHÔNG hề chạy) thì
callback không bao giờ tới, cờ rulerRenderScheduled kẹt ở true và thước đứng im MÃI kể cả sau khi
hiện lại. Nay đặt cả rAF lẫn setTimeout(run, 120), cái nào tới trước thì chạy, cái sau thành no-op
nhờ chính cờ đó.

GHI CHÚ MÔI TRƯỜNG (không phải lỗi): perf-runtime.js nạp SAU editing-runtime.js và thay
updateTimelineLayout bằng một hàm chỉ markDirty('timelineGeometry'/'timelineVisual') — lượt vẽ thật
do bộ lịch rAF của perf-runtime thực hiện. Vì vậy trong khung xem trước không-có-animation-frame,
lane/block của timeline KHÔNG dựng được; đã đối chiếu với mã gốc (git stash) và hành vi y hệt, không
phải hồi quy. Chrome block ở A3 vì thế được kiểm bằng cách chèn block DOM đúng class + đọc
computed style, không phải bằng đường render thật.
```

### A1. Hoàn thiện tầng token

```text
- Thêm vào :root: --surface-1..4, --text-1..3, --border-subtle/strong, --primary-a05..a40,
  --white-a04..a40, --focus-ring, --dur-fast/--dur/--dur-slow, --ease-out/--ease-in-out,
  --z-base..--z-tooltip (+ --z-panel-popover), --header-h/--timeline-h, --ruler-h/--lane-rail-w,
  --selection/--selection-dim/--snap-guide.
- SỬA LỖI THẬT: --accent và --text-strong bị DÙNG mà chưa hề định nghĩa
  (editing-runtime.js: `var(--accent, #4da3ff)`) -> .speed-preset-btn.is-active ra xanh #4da3ff
  thay vì xanh thương hiệu #0a84ff. Đã định nghĩa cả hai. Kèm 2 fallback lệch
  `var(--primary, #4a90e2)` -> `var(--primary)`.
- .sidebar-right khai 340px rồi bị 380px ghi đè -> gộp về MỘT nguồn khai báo.
- font-size dạng `em` lồng nhau (19 chỗ) -> token tuyệt đối, SÀN 11px. Trước đó đo được
  9.594px ("Chưa chọn đoạn"), 10.14px, 10.4px, 11.05px, 11.7px, 12.285px; sau khi sửa: KHÔNG còn
  cỡ chữ phân số nào, và chỉ còn 3 chỗ ở 10px là nhãn HOA có letter-spacing + số mono (cố ý).
- z-index: dải modal/scrim/tooltip + 2 overlay dựng bằng JS đang hardcode 4000 -> token.
  CỐ Ý giữ nguyên giá trị: --z-panel-popover = 60 cho font picker / text settings, vì --z-popover
  = 300 sẽ đẩy chúng lên TRÊN cả dải modal.
- box-sizing: border-box toàn cục (trước chỉ đặt cục bộ 7 chỗ). Hệ quả phải bù: cột Thuộc tính
  340 -> 356px + padding 8 -> 6px (bề rộng NỘI DUNG hụt 17px vì padding/border nay tính vào),
  và .home-rail 264 -> 300px (chữ chân trang bị ngắt dòng).
- @media (prefers-reduced-motion: reduce) — trước đây file KHÔNG có @media nào.
- :focus-visible toàn cục cho button/a/[role=button]/[tabindex] + ring trên input/select/textarea.
  Trước đợt này :focus-visible xuất hiện ĐÚNG 1 lần trong toàn app (.edit-subtab).
- Dọn dead CSS: .time-ruler, .ruler-tick/.major/.minor, .timeline-block, .block-label.
  LƯU Ý: symbol #ic-snap-off KHÔNG chết — nó được dùng qua template chuỗi trong
  setSnappingEnabled(), grep theo `use href="#ic-snap-off"` sẽ không thấy.
```

### A3. Chrome block + rail lane + thanh công cụ timeline

```text
- Fill block: 4 màu PHẲNG -> gradient dọc + inset highlight 1px trên + hairline tối đáy, giữ
  nguyên hệ màu theo loại lane (media/text/shape/audio).
- Selection kiểu CapCut (đã chốt với người dùng): viền TRẮNG 2px + vòng tối inset. Thêm
  .is-secondary-selection (viền trắng 62%) cho block chọn THÊM — trước đây multi-select không
  phân biệt được block chính. Class do refreshSelectionClasses() + 2 điểm render gắn, chỉ là
  nhãn TRÌNH BÀY, không đổi state nào. Vàng #faea66 nay chỉ còn cho snap guide + keyframe marker.
- .editing-block:hover — trước đây KHÔNG có rule hover nào. Chỉ dùng state tĩnh, KHÔNG transition:
  renderEditingTimeline() xoá sạch innerHTML mỗi lượt render nên transition sẽ bị cắt giữa đường.
- Trim handle 6 -> 8px + vạch nắm + hover + ::after mở rộng vùng bấm ~18px (mượn thủ pháp
  .resize-handle::after của timeline cũ). Handler không đổi.
- appendThumbStrip(): trước đây lặp MỘT ảnh tĩnh N lần với stripHeight = 28 CỐ ĐỊNH dù block cao
  28-74px -> dải "ảnh giả" lặp đều. Nay số ô tính theo chiều cao THẬT của block, và vì nguồn chỉ
  có 1 ảnh nên render đúng 1 ô .is-single phủ trọn dải (cover). Cờ `singleFrameSource` để dành cho
  filmstrip nhiều khung (hạng mục riêng, chưa làm).
- Rail lane: .editing-lane-name bỏ display:none và hiện ở lane cao >= 48px (class has-name);
  thêm badge V1/A1/M (trackBadgeText: lane hình đếm từ lane gần lane chính nhất như Premiere,
  lane tiếng đếm từ trên xuống); nút icon 20 -> 24px + :active + :focus-visible;
  GỠ cụm '•••' vì nó trông như menu tràn nhưng KHÔNG có handler nào.
- Thanh công cụ timeline: vạch chia nhóm (.tool-divider), icon 17 -> 18px + stroke 1.75,
  razor đổi từ SVG inline 24px sang <use href="#ic-razor"> như mọi nút cùng hàng,
  và trạng thái tắt chuyển từ `btn.style.opacity = '0.4'` trong JS (7 chỗ) sang CSS
  .tool-icon-btn:disabled (mọi chỗ đó đều đã set btn.disabled nên ngữ nghĩa không đổi).
- Cụm Thu phóng: thêm nút Fit / − / + và số %. Cả ba CHỈ ghi zoomSlider.value rồi dispatch 'input'
  -> đi qua ĐÚNG handler zoom đang có, không nhân bản đường tính zoom thứ hai. "Fit" = về min,
  và min chính là mức vừa-khung app tự đặt lại mỗi lần 'loadedmetadata'.
  Hai chỗ JS tự ghi slider.value (không phát 'input') được thêm syncZoomReadout() để nhãn không lệch.
- #timeDisplay phải `white-space: nowrap`: timecode HH:MM:SS:FF dài hơn MM:SS.ss nên ở cửa sổ hẹp
  ô đồng hồ vỡ 2-3 dòng và làm cao thanh điều khiển preview.
```

## Chọn nhiều block trên timeline: ⌘/Ctrl+bấm và Shift+bấm (2026-08-19)

```text
TÌNH TRẠNG TRƯỚC ĐÓ (đo được ở runtime, không phải suy đoán):
- Cộng dồn chọn bằng bấm ĐÃ CÓ: isAdditiveSelectionEvent = shiftKey || metaKey || ctrlKey,
  nối vào 2 chỗ — block lane chính (handler 'click') và block overlay (startItemDrag,
  handler 'mousedown'). Bảng phím tắt cũng đã ghi "Shift / ⌘ + bấm".
- NHƯNG Shift và ⌘ làm ĐÚNG MỘT VIỆC giống nhau: bật/tắt một block. Không có thao tác
  "chọn cả dải" mà Premiere/Resolve/CapCut đều có -> người dùng tìm không thấy.
- Và bấm ra VÙNG TRỐNG của timeline KHÔNG bỏ chọn (đo: chọn 1 block, bấm vùng trống,
  selectedEditingItemIds vẫn còn 1 phần tử). Hệ quả: sau khi chọn nhiều block không có
  đường nào về lại một block ngoài việc bấm bỏ từng cái -> cảm giác "chọn nhiều không chạy".

HAI LỖI THẬT ĐÃ SỬA
1) Block CHÍNH trỏ ra ngoài tập đang chọn. toggleEditingItemSelection / 
   toggleMainClipSelection cũ luôn gán block vừa bấm làm block chính, KỂ CẢ khi cú bấm đó
   BỎ nó ra khỏi lựa chọn. Đo được: ids = [item_9] nhưng primary = item_7 -> Inspector sửa
   thông số của một block không còn được chọn. Nay khi bỏ chọn thì block chính dời sang một
   block còn lại (và mốc chọn cũng dời theo).
2) Tay cầm trim ăn hết thân block ngắn — HỒI QUY của Phase A (tôi nới tay cầm 6 -> 8px).
   Block 0.2s ở zoom 120 chỉ rộng 24px: hai tay cầm 8px + vùng bấm ::after nới vào trong
   -> MỌI cú bấm đều thành trim, không thể bấm chọn (bắt được bằng log: isResize luôn true).
   Nay: max-width 25% cho tay cầm, và ::after chỉ nới RA NGOÀI block (left/right riêng),
   không lấn vào thân.

THIẾT KẾ MỚI (nếp chung của phần mềm dựng phim)
- isToggleSelectionEvent  = ⌘/Ctrl  -> bật/tắt TỪNG block
- isRangeSelectionEvent   = Shift (không kèm ⌘/Ctrl) -> chọn CẢ DẢI
- isAdditiveSelectionEvent = một trong hai (giữ tên cũ; dùng cho quét chọn và cửa gác kéo/thả)
- selectionAnchor = block mốc, đặt khi chọn đơn hoặc khi cộng dồn thêm; Shift+bấm nhiều lần
  nới/thu dải từ CÙNG một mốc (đúng nếp Premiere), không nhảy mốc theo cú bấm cuối.
- selectRangeTo(kind, key): lấy hình chữ nhật bao giữa mốc và block vừa bấm rồi chọn mọi
  block giao với nó, DÙNG LẠI marqueeBlockRects() của quét chọn -> hai thao tác cho cùng
  kết quả và cùng bỏ qua lane đang khoá. Cùng lane = hình chữ nhật dẹt = "cả dải trên một
  lane"; khác lane = bao cả khoảng thời gian × khoảng lane.
- Bấm vùng TRỐNG = bỏ chọn hết. Đặt trong finishEditingMarquee ở nhánh !m.moved, vì
  marqueeStartAllowed() chỉ cho bắt đầu ở vùng trống DƯỚI dải thước — tới được đó nghĩa là
  người dùng bấm ra chỗ không có block. Giữ lựa chọn nếu đang bấm kèm bổ ngữ.
- Bấm (KHÔNG kéo) một block đang thuộc nhóm -> thu lựa chọn về đúng block đó, quyết ở
  finishItemDrag theo ngưỡng MARQUEE_THRESHOLD_PX (4px). keepGroup vẫn giữ nguyên cho
  đường KÉO cả nhóm (đã kiểm: kéo 40px giữ đủ 3 block).
- announceSelectionCount() báo "Đã chọn N block" ra #statusText khi N > 1.

ĐÃ KIỂM (click chuột thật, có bổ ngữ, trên block thật)
⌘+bấm cộng dồn 2 block · Shift+bấm chọn dải 2 rồi nới thành 3 · ⌘+bấm bỏ block chính ->
primary dời vào trong tập · bấm vùng trống -> bỏ chọn hết · bấm block trong nhóm -> thu về 1 ·
kéo 40px -> giữ nhóm 3.
CHƯA KIỂM ĐƯỢC: đường block LANE CHÍNH (cần video ở lane chính, mà hộp thoại chọn tệp
không lái được từ đây). Dùng chung selectRangeTo/toggle nên rủi ro thấp, nhưng lane chính đi
qua handler 'click' chứ không phải 'mousedown' — nên kiểm tay khi có dự án thật.

CÁCH DỰNG ĐƯỢC BLOCK THẬT TRONG KHUNG XEM TRƯỚC (mẹo test):
perf-runtime.js thay updateTimelineLayout bằng hàm chỉ markDirty(...), lượt vẽ do bộ lịch rAF
của nó làm — mà khung xem trước báo document.hidden = true nên rAF KHÔNG chạy. Tắt cờ perf
bằng query string thì perf-runtime thoát sớm và updateTimelineLayout trở lại bản vá của
editing-runtime (vẽ đồng bộ):
  /?perf_scheduler=0&virtualized_transcript=0&timeline_pointer_capture=0&pixi_viewport_culling=0&ruler_dom_overlay=0
```

### Làm rõ trạng thái ĐANG CHỌN của block (2026-08-19, đợt 2)

```text
VẤN ĐỀ: Phase A đã đổi viền chọn sang TRẮNG kiểu CapCut nhưng vẫn khó phân biệt, vì có ba
thứ cùng cạnh tranh sự chú ý:
  1. MỌI block đều mang viền SÁNG theo loại (media rgba(0,210,255,.28), text .22,
     shape .30, audio .28) -> viền trắng của block được chọn chỉ là "một cạnh sáng nữa".
  2. Tay cầm trim là hai VẠCH TRẮNG hiện trên MỌI block -> timeline lúc nào cũng đầy cạnh
     sáng. CapCut chỉ hiện tay cầm trên block đang chọn.
  3. Viền trắng 2px nằm trực tiếp trên nền teal sáng, thiếu lớp tối phân cách nên bị "tan".

CÁCH SỬA (đối chiếu ảnh CapCut người dùng gửi)
- Block THƯỜNG: viền đổi thành cạnh TỐI `1px rgba(0,0,0,0.5)`; bỏ hẳn màu viền theo loại.
  Loại block vẫn nhận ra bằng MÀU NỀN (dấu hiệu đủ mạnh) -> cạnh sáng trở thành đặc quyền
  của trạng thái đang chọn. Block kề sát nhau (lane chính xếp gạch liền) vẫn tách nhau rõ
  vì nền block sáng còn cạnh tối đóng vai đường phân cách.
- KHUNG CHỌN ba lớp:
    viền trắng 2px
  + `inset 0 0 0 2px rgba(0,0,0,0.6)`  -> KHE TỐI ngay trong viền, chính là thứ làm viền
    trắng bật ra; CapCut cũng có đúng khe này giữa khung trắng và nội dung
  + `0 0 0 1px rgba(0,0,0,0.7)` + bóng đổ -> khung không tan vào block kề
  + `filter: brightness(1.16) saturate(1.05)`
  + `z-index: 24` (block thường 20) — BẮT BUỘC: block nằm sát nhau nên cùng z-index thì
    block kề vẽ đè lên đúng cạnh trắng vừa vẽ.
- Chọn THÊM (không phải block chính): viền `--selection-dim` (trắng 62%), z-index 23,
  không bóng đổ, brightness 1.06.
- Tay cầm trim: `opacity: 0` mặc định, `opacity: 1` khi `:hover` hoặc `.is-selected`.
  Dùng opacity chứ KHÔNG dùng display/visibility để VÙNG BẤM vẫn còn -> trỏ vào là trim
  được ngay, không phải chọn trước (giống CapCut/Premiere).
- Hover giữ mức yếu hơn hẳn: viền `rgba(255,255,255,0.24)` + brightness 1.12, không có khe
  tối, để không bị đọc lẫn thành "đang chọn".

Số đo sau khi sửa: thường = 1px rgba(0,0,0,.5) / filter none / z 20 / tay cầm opacity 0;
hover = 1px rgba(255,255,255,.24) / brightness 1.12 / z 20 / tay cầm opacity 1;
chọn = 2px #fff / brightness 1.16 saturate 1.05 / z 24 / khe tối inset 2px / tay cầm opacity 1.

KIỂM BẰNG MẮT: dựng dải block kề nhau (có khe và KHÔNG khe), text/audio/media, các trạng
thái thường · hover · chọn · chọn-thêm · lane ẩn, rồi chụp so sánh. Lúc kiểm thì cổng 17219
đang do Electron của người dùng chiếm, nên chạy `python3 -m http.server` ở cổng khác để soi
CSS mà không dựng thêm một backend thứ hai (backend ghi temp_uploads/asr_cache/progress.txt,
chạy hai bản song song là chồng lấn dữ liệu).
```

### GỠ Shift+bấm khỏi việc chọn block (2026-08-19, đợt 3)

```text
Shift+bấm (chọn cả dải) thêm ở đợt trước đã bị GỠ sau khi người dùng dùng thử.

VÌ SAO GỠ (không phải vì code sai — nó chạy đúng thiết kế, mà vì thiết kế khó dùng):
- Kết quả phụ thuộc "block MỐC", nhưng mốc KHÔNG hiện ra ở đâu trên giao diện. Cùng một cú
  Shift+bấm vào cùng một block lại cho tập chọn khác nhau tuỳ mốc đang là block nào ->
  người dùng không đoán được trước khi bấm.
- Dải là hình chữ nhật bao (khoảng thời gian × khoảng lane), nên bấm hai block ở hai lane
  cách xa nhau sẽ quét luôn mọi block nằm giữa ở các lane trung gian — đúng như đã thiết kế
  nhưng trái với kỳ vọng "chỉ chọn hai block này".
- Trong timeline Shift ĐÃ có nghĩa khác: hít playhead vào mốc block (seekTimeline và
  Shift-lăn-chuột). Thêm nghĩa thứ hai cho cùng một phím là mời thêm lẫn lộn.
- ⌘/Ctrl+bấm đã đủ để chọn nhiều block, và nó đoán được: mỗi cú bấm đổi đúng một block.

ĐÃ GỠ: isRangeSelectionEvent, isToggleSelectionEvent, selectRangeTo(), selectionAnchor,
setSelectionAnchor() và mọi lời gọi (grep 3 tên này nay trả 0). Còn lại MỘT hàm duy nhất:
    isAdditiveSelectionEvent(event) => !!(event.metaKey || event.ctrlKey)
dùng ở đúng 4 chỗ: quét chọn (cờ additive), click block lane chính, mousedown block overlay,
và cửa gác startMainBlockDrag.

HỆ QUẢ CÓ CHỦ Ý (Shift nay hoàn toàn không tham gia chọn):
- Shift+bấm block  = bấm thường -> chọn đúng một block. Nếu block đó đang thuộc nhóm thì
  nhánh "nắm rồi thả tại chỗ" của finishItemDrag thu lựa chọn về đúng nó.
- Shift+kéo quét vùng trống = quét MỚI (không cộng dồn nữa); muốn cộng dồn thì giữ ⌘/Ctrl.
- Shift+bấm vùng trống = bỏ chọn hết (trước đây Shift giữ lại lựa chọn vì được coi là additive).
Bảng phím tắt đã bỏ dòng Shift và sửa dòng quét chọn thành "giữ ⌘/Ctrl để cộng dồn".

ĐÃ KIỂM (click chuột thật, block thật): Shift+bấm khi đang chọn 1 block khác -> còn đúng 1
block (block vừa bấm) · ⌘+bấm hai lượt -> 3 block, primary nằm trong tập, 2 block phụ mang
class is-secondary-selection, thanh trạng thái "Đã chọn 3 block" · Shift+bấm khi đang chọn 3
block -> thu về đúng 1. Console không lỗi.
```

## Đợt UI/UX Pro — Phase B: tầng component (2026-08-20)

### B1. Hệ nút `.btn`

```text
TRƯỚC: KHÔNG tồn tại component nút nào. Cấp bậc primary/secondary/danger được viết bằng
chuỗi style="" copy-paste ~12 lần, đã trôi thành 3 biến thể (color: var(--text-main) vs #fff,
và 4 chỗ rơi mất border). 98 <button> trong index.html, 32 cái KHÔNG có class -> dựa vào
selector `button` thô với `width: 100% + margin-bottom: 10px`.

CÁCH LÀM: thêm .btn + .btn-primary/secondary/ghost/danger/warning/success + .btn-sm/lg/block/icon.
.btn khai ĐẦY ĐỦ mọi thuộc tính nên thắng `button` thô theo độ đặc hiệu (class 0-1-0 >
element 0-0-1) -> KHÔNG cần !important và KHÔNG phải đổi rule `button` cũ, nên 66 nút đã có
class vẫn chạy y như trước. Đã chuyển 25/32 nút không-class sang .btn (chuỗi style= dài trong
body: 38 -> 22).
CỐ Ý KHÔNG chuyển: 4 nút btnAddEditing* (đang ẩn, giữ để không vỡ binding) và 3 nút
btnRotateClip90/btnFlipClipX/Y (nằm trong .clip-transform-quick-actions có rule riêng) —
nhóm này được sửa bằng CSS container: min-width 108px vì bị .ins-sec-head bóp còn 20px/nút.
GHI CHÚ: "Xuất Video" vẫn giữ MÀU ĐỎ (btn-danger) như trước. Xuất video không phải hành động
phá hoại nên về ngữ nghĩa đáng ra là .btn-primary; giữ đỏ để không tự đổi một màu nổi bật mà
người dùng chưa yêu cầu — đổi chỉ là sửa một class.
```

### B2. Form control

```text
TRƯỚC: 21 thanh trượt và 11 ô tích là control NATIVE trần giữa giao diện tối tuỳ biến
(0 rule ::-webkit-slider-thumb trong repo; đo runtime: 0/11 ô tích được style), cùng 3 chính
sách accent-color khác nhau. Không có component switch nào — mọi "toggle" phải mượn ô tích
hoặc nút .is-active.
NAY (đặt ở tầng TOÀN CỤC nên mọi control do editing-runtime/settings-panel dựng động cũng
nhận được): input[type=range] có track 4px + thumb 13px tròn (+ bản -moz-), input[type=checkbox]
/[type=radio] vẽ lại hoàn toàn bằng appearance:none (dấu tích là border xoay 45°, radio là
đốm tròn), và component .switch. accent-color đã gỡ vì thành mã chết.
Rule slider riêng của cụm zoom rút còn `width: 120px` — thân/thumb do rule toàn cục lo, không
nhân bản khai báo nữa.
Ô nhập trong .fig-field: height auto -> 100%. Trước đó ô cao 15px nằm giữa khung 30px nên hở
7px trên/dưới không bấm được vào ô.
```

### B3. Icon

```text
TRƯỚC: 11 cỡ icon (14/15/16/17/19/20/22/26/28/30) và 5 độ dày nét (1.5/1.6/1.8/2/3.5);
~110 KÝ TỰ hình học dùng làm icon.
NAY: sprite 32 -> 52 symbol; thang cỡ gom về 4 (.ico-sm/md/lg/xl = 14/16/18/24) và MỘT độ dày
nét 1.75 (15 thuộc tính stroke-width inline đã chuẩn hoá). Đã thay bằng SVG:
  index.html   — caret menu ▾, mục menu ↥ ↧ ↧+ ⟲, dấu ✓ (menu + .pcb-check), nút đóng × (3
                 modal + thẻ Home), reset ↺, keyframe ◂ ◆ ▸ (12 nút), rail chữ cái S/T/□/AR
  runtime      — icon loại lane ◐ ⬡ ✦ ♪ + chữ T (renderTrackIcon -> TRACK_TYPE_ICON), transport
                 ▶/❚❚ (2 chỗ, dùng #ic-play/#ic-pause có sẵn), ống hút màu ⌖ (2 chỗ), ✨, ◐
Kiểm: 0 tham chiếu <use href="#..."> trỏ tới symbol không tồn tại.
CỐ Ý GIỮ ký tự: ★ trong .fig-affix (nhãn ĐƠN VỊ của ô "số cánh sao", cùng loại với % và °),
⚠ và ✓ nằm trong câu văn trạng thái, 💡 trong khối .stage-help đang display:none, và
stroke-width 1.5/3.5 của .adj-mask-path (đường vẽ MẶT NẠ, không phải icon).

BẪY: ký tự ◆/◂/▸ tự giữ bề rộng theo font, còn <svg> thì CO ĐƯỢC trong flex -> sau khi đổi,
.kf-diamond/.kf-nav tụt từ 29/22px xuống 14px (đo được). Phải thêm flex: 0 0 auto.
```

### B4. Tab

```text
- .ins-tab.is-active chừa sẵn `border-bottom: 2px solid transparent` nhưng CHƯA BAO GIỜ tô màu
  -> tab đang chọn chỉ khác ở màu chữ. Nay tô đúng cái gạch đó bằng var(--primary).
- .ins-subtab.is-active trước là nền trắng 12% (yếu hơn hẳn .edit-subtab ở panel trái). Nay
  dùng cùng treatment: nền surface-3 + viền + bóng + weight 600, kèm border trong suốt ở trạng
  thái thường để chữ không nhảy 1px khi đổi tab.
- .edit-tabs: 9 tab (~692px) trong cột 264px, trước KHÔNG có dấu hiệu nào cho biết còn tab bị
  che. Nay mask-image làm mờ dần ở đầu còn nội dung (class can-scroll-left/right do
  syncEditTabsOverflow gắn — chỉ ĐỌC scrollLeft/scrollWidth), lăn chuột dọc -> cuộn ngang, ẩn
  scrollbar. ĐÃ LOẠI phương án bọc nhiều hàng: 9 pill cần tới 3 hàng, ăn hết chiều cao panel.
- .edit-tab nay có :hover và :focus-visible (trước đây không có rule hover nào).
```

### B5. Tooltip dùng chung

```text
TRƯỚC: 108 thuộc tính title= native — hiện sau ~1s, không theo design system, vô hình với bàn
phím, và nhiều title là cả đoạn văn dài nên trình duyệt vẽ thành khối chữ thô.
CÁCH LÀM (điểm chính): KHÔNG sửa 108 chỗ markup. Một controller uỷ quyền ở document, lần đầu
trỏ vào (pointerover, pha capture) hoặc focus bằng bàn phím thì chuyển title -> data-tip rồi
tự vẽ .app-tip. Vì chuyển ở pha capture nên tooltip native chưa kịp hiện. Lợi ích kèm theo:
mọi tooltip do editing-runtime.js dựng động cũng tự được hưởng, và nếu controller lỗi thì chữ
vẫn còn trong data-tip. Có delay 320ms, tự lật lên trên khi thiếu chỗ dưới, kẹp trong viewport,
đóng khi Esc/cuộn/resize. Bỏ qua [data-no-tip].
```

### B6. Gom thang bán kính + dropzone

```text
border-radius thô trong <style>: 30 -> 0 (mọi giá trị về --r-xs/sm/md/lg/pill; các mức lệch
thang 2/3/5/7/10px bị gom vào thang gần nhất). Dropzone: 3 độ dày viền nét đứt (1px/1.5px/2px)
-> MỘT chuẩn `1px dashed var(--border-strong)`, kể cả #dropzoneScript vốn viết tay trong inline
style. var(--…) dùng: 748 -> 860.
```

### LỖI CỦA PHASE A LỘ RA KHI ĐO Ở PHASE B

```text
5 token --white-a04/a08/a12/a18/a25 bị TỰ THAM CHIẾU (`--white-a08: var(--white-a08)`) — do
lượt regex gom token ở Phase A đã thay cả bên trong khối :root. Hệ quả im lặng: mọi rule dùng
chúng KHÔNG có nền, cụ thể hover nút icon lane, nền badge V1/A1/M, và hover .btn-ghost. Đã sửa
về giá trị chữ. Cùng lớp lỗi này đã xảy ra với --primary-a05..a22 ở Phase A và được bắt ngay
lúc đó; lần này lọt vì --white-* không được kiểm lại sau khi thay.
BÀI HỌC ĐÃ THÊM VÀO QUY TRÌNH: sau MỌI lượt regex gom token, chạy
  grep -nE -- '--([a-z0-9-]+): var\(--\1\)' index.html
và kiểm getPropertyValue của các token vừa tạo trong trình duyệt.
```

## Đợt UI/UX Pro — Phase C: Preview / Viewer (2026-08-20)

```text
1. TAY CẦM BIẾN ĐỔI trên khung xem trước
   Trước: 7x7px, không có :hover, chỉ một bóng đổ nhẹ -> trên khung hình SÁNG thì gần như
   tan mất, và 7px quá nhỏ để nắm chính xác.
   Nay: 10x10, viền trắng + VÒNG TỐI bao ngoài (nổi trên cả nền sáng lẫn nền tối), hover
   phóng 1.25x, nhấn thì chuyển màu primary. Vùng bắt chuột nới bằng ::after (inset -6px)
   nên nắm dễ mà hình vẽ vẫn nhỏ — cùng thủ pháp đã dùng cho tay cầm trim trên timeline.
   Tay cầm cạnh của shape 22x7 -> 24x9; tay cầm bán kính 5px -> 8px.

2. TAY CẦM XOAY
   Trước: lơ lửng cách khung 38px, KHÔNG có gì nối lại -> đọc như một nút rời, không rõ thuộc
   block nào; icon là ký tự ↻ trong ::before (phụ thuộc font, lệch baseline).
   Nay: 26px, ::before thành ĐƯỜNG NỐI 1px cao 28px về phía khung, và icon dùng #ic-rotate-cw
   từ sprite (createSelectionHandle tự chèn khi className chứa 'rotate', kèm aria-label).

3. HUD SỐ LIỆU KHI KÉO (mới)
   Trước: kéo scale/xoay/di chuyển thì không có số nào trên khung — phải nhìn sang Inspector
   ở cột phải, tức rời mắt khỏi chỗ đang làm. Mọi NLE đều hiện số ngay tại con trỏ.
   Nay: #editingPreviewHud bám con trỏ, hiện "166%" (scale) / "-20°" (rotate) / "X .. Y .."
   (move), tự ẩn khi thả. CHỈ ĐỌC item.transform — giá trị do đường kéo sẵn có ghi, HUD không
   tự tính gì, nên không có đường số thứ hai để lệch.

4. THANH TRANSPORT
   .pcb-btn cao 22px (đo được) -> min-height 28px, padding theo token, và thêm
   :hover/[aria-expanded=true]/:focus-visible (trước đây KHÔNG có trạng thái nào).
   #btnPlayPause và ô timecode đã xử lý ở Phase B/A (btn-secondary 32px; HH:MM:SS:FF mono).

5. .timeline-controls-center — KIỂM RỒI, KHÔNG PHẢI MÃ CHẾT, GIỮ NGUYÊN
   Kế hoạch ghi "gỡ dead cluster sau khi xác nhận syncPreviewControlBar() không cần nó làm
   fallback". Đã đọc syncPreviewControlBar(): nó DỜI #btnPlayPause / #timeDisplay /
   #btnCaptureFrame từ cụm này sang các slot của thanh preview. Cụm chính là NHÀ DOM BAN ĐẦU
   của ba phần tử đó -> gỡ markup là ba phần tử không có nơi khai sinh. display:none chỉ để
   không thấy nó trong khoảnh khắc trước khi dời. Chú thích sẵn trong mã đã nói đúng điều này.
   => Hạng mục này kết luận là "giữ", không phải "gỡ".

6. THANH XEM TRƯỚC TỆP ở panel trái (.pmp-*)
   Trước là một ngôn ngữ RIÊNG: nút vuông chữ '▶', vạch tiến độ cyan #22d3ee trần, nút đóng
   hover sang đỏ #d13b3b (một sắc đỏ thứ hai cạnh --danger).
   Nay dùng lại đúng bộ của thanh transport: nút tròn 28px + icon #ic-play/#ic-pause, track
   var(--surface-4) + fill var(--primary), thumb trắng 12px giống nút trượt của
   input[type=range], nút đóng dùng --danger, timecode dùng --font-mono. Thanh nghe thử audio
   (.pap-*) cũng đổi ▶ và × sang icon SVG.

BẪY ĐO LƯỜNG (mất thời gian, ghi lại để đừng lặp): khung xem trước của Claude Code có lúc
KHÔNG được hiển thị -> window.innerWidth/innerHeight = 0 và document.body 0x0. Khi đó MỌI số
đo layout đều sai theo hướng "sập": .edit-tab đo ra 18px (thật là 30px), timelineTrackOuter
clientWidth = 0, thước còn 2 tick, .edit-tabs cao 4px. Dấu hiệu nhận biết: screenshot báo
"the Browser pane is not displayed". Cách chữa: gọi lại resize_window rồi phát 'resize' trước
khi đo. Luôn kiểm window.innerWidth trước khi tin một con số layout.
```

## Tay cầm chọn kiểu CapCut + Zoom khung xem trước (2026-08-20)

### Thành phần tay cầm theo TỪNG LOẠI block

```text
Đối chiếu 3 ảnh CapCut người dùng gửi (media / text / shape):

              | CapCut                          | CrabbyCut TRƯỚC              | NAY
  Ảnh/Video   | 4 GÓC                           | 8 (nw n ne e se s sw w)      | 4 góc
  Văn bản     | 4 góc + 2 thanh dọc trái/phải   | CHỈ 2 thanh — THIẾU 4 góc    | 4 góc + 2 thanh
  Hình học    | 4 góc + 4 thanh (4 cạnh)        | 4 góc + 4 thanh              | giữ nguyên

VÌ SAO media chỉ 4 góc: co giãn media luôn GIỮ TỈ LỆ (mode 'scale' cho cả 8 vị trí), nên 4
tay cầm ở cạnh làm đúng y như 4 ở góc — chúng là lời hứa sai về việc "kéo cạnh đổi một chiều".
VÌ SAO text phải có 4 góc: trước đây text chỉ có 2 thanh đổi BỀ RỘNG hộp chữ, không có đường
nào để scale cả khối bằng góc — sai lệch rõ nhất so với CapCut.

Số đo sau khi sửa (đo runtime trên block thật):
  media: rotate 30x30 + nw/ne/se/sw 12x12                                  = 5 tay cầm
  text : rotate 30x30 + 4 góc 12x12 + side left/right 8x26                 = 7
  shape: rotate 30x30 + 4 góc 12x12 + shape-side n/s 26x8, e/w 8x26        = 9
```

### Hình thức

```text
- Khung chọn: 1.5px -> 1px rgba(255,255,255,0.92). CapCut dùng đường RẤT mảnh; tay cầm mới là
  thứ gánh sự chú ý.
- Tay cầm góc: đĩa TRẮNG ĐẶC 12px, bỏ viền trắng 1.5px (thành `border: none`), giữ vòng tối
  mảnh + bóng để nổi trên khung hình sáng. Hover phóng 1.2x. Bỏ `:active` đổi sang màu primary
  (CapCut giữ trắng suốt).
- Thanh cạnh: viên thuốc (border-radius pill) — text 8x26 dọc; shape 26x8 ngang ở trên/dưới và
  8x26 dọc ở trái/phải.
- Tay cầm XOAY: đĩa TỐI rgba(28,29,33,0.92) 30px với icon TRẮNG (#ic-rotate-cw), cách cạnh đáy
  30px. ĐÃ BỎ đường nối mà đợt Phase C tự thêm — ảnh tham chiếu cho thấy CapCut không vẽ nó.
```

### ZOOM khung xem trước

```text
QUYẾT ĐỊNH THIẾT KẾ QUAN TRỌNG: zoom bằng cách đổi KÍCH THƯỚC LAYOUT THẬT của
.sequence-preview-frame (nhân hệ số vào phép `fit` trong updateSequencePreviewLayout), KHÔNG
dùng `transform: scale()`.

Lý do — toàn bộ hệ toạ độ preview suy ra từ frame.clientWidth/clientHeight:
    previewScale = min(frameW/seqW, frameH/seqH)
Dùng nó là: renderPreviewOverlays, renderSelectionBox, maskSourceFrame, snapPreviewShapeTransform,
và mọi phép kéo. Đổi kích thước THẬT thì tất cả tự khớp, không phải bù hệ số ở đâu.
Nếu dùng transform: scale() thì clientWidth KHÔNG đổi trong khi getBoundingClientRect() lại
đổi -> hai đường số lệch nhau. Cụ thể sẽ sai âm thầm:
  - startPreviewBoxDrag lấy previewScale từ getBoundingClientRect (có scale) trong khi
    renderSelectionBox lấy từ clientWidth (không scale);
  - handleMaskDrag trộn toạ độ client (`event.clientX - rect.left`) với toạ độ cục bộ do
    maskToScheen sinh ra -> tay cầm mặt nạ lệch theo đúng hệ số zoom.
Chọn đổi kích thước thật nên KHÔNG có chỗ nào phải đặc biệt hoá, kể cả trình soạn mặt nạ.

Pan: .sequence-preview-shell chuyển sang vùng CUỘN THẬT, nên không phải tự viết logic pan.
Hai bẫy đã gặp và đã sửa:
  1. `overflow: auto` vô điều kiện sinh VÒNG LẶP: scrollbar xuất hiện -> clientWidth hụt ->
     phép fit ra khung to hơn chỗ trống -> lại thêm scrollbar. Đo được: ở 100% khung 715px
     trong vùng 711px. Chữa: chỉ mở cuộn khi đã zoom vào (class .is-zoomed), và tính fit theo
     clientWidth/clientHeight (đã trừ scrollbar) thay vì getBoundingClientRect.
  2. `justify-content: center` làm phần tràn ở phía TRÁI/TRÊN không cuộn tới được (đo được
     scrollWidth 800 trên khung rộng 886 — mất đúng một nửa). Chữa bằng `safe center`: còn vừa
     thì canh giữa, tràn thì tự lùi về canh đầu. Sau khi sửa: scrollWidth 1110 / khung 1108,
     scrollLeft về 0 được.

Điều khiển: cụm − / % / + trên thanh transport (nút % là "vừa khung"), và Ctrl/⌘ + lăn chuột
zoom quanh CON TRỎ (tính lại scrollLeft/scrollTop để điểm dưới con trỏ giữ nguyên vị trí).
Lăn chuột THƯỜNG không bị chặn — vẫn để cuộn xem quanh. Dải 0.25x–8x.

KIỂM ĐỘ ĐÚNG CỦA PHÉP KÉO SAU KHI ZOOM (điểm rủi ro chính, đã đo):
  100%: previewScale 0.3724 — kéo 100px thật -> position_x dịch 268 (kỳ vọng 269)
  156%: previewScale 0.5823 — kéo 100px thật -> position_x dịch 171 (kỳ vọng 172)
Lệch 1 đơn vị là do làm tròn. Đúng ở cả hai mức, không cần sửa công thức nào.
```

### Dải tab panel Editing bị CO ở tab Chuyển tiếp / LUT (đã sửa 2026-08-20)

```text
TRIỆU CHỨNG: bấm tab "Chuyển tiếp" hoặc "LUT" thì các pill tab ở trên thấp hẳn lại. Đo được:
    Tệp phương tiện / Hình học / Điều chỉnh / Văn bản / Âm thanh : pill 30px, dải tab 42px
    Chuyển tiếp                                                  : pill 18px, dải tab 13px
    LUT                                                          : pill 18px, dải tab 18px

NGUYÊN NHÂN — không nằm ở CSS của tab, mà ở phép chia chỗ của FLEXBOX:
  .edit-panel là flex COLUMN gồm 2 item: .edit-tabs và .edit-panel-main.
  .edit-panel-main có 'flex: 1 1 auto' -> flex-basis = auto = CHIỀU CAO NỘI DUNG. Nội dung
  của hai tab này rất cao: lưới chuyển cảnh scrollHeight 2084px, lưới LUT 1415px (các tab
  khác chỉ 493px, tức vừa chỗ).
  Khi tổng base size vượt chỗ trống, flexbox chia phần THIẾU theo TỈ LỆ base size × shrink
  factor của từng item. .edit-tabs không đặt flex-shrink nên mặc định là 1, base 42px:
      phần nó phải gánh ≈ 42 / (42 + 2084) × 1591 ≈ 31px
  -> dải tab tụt từ 42px còn ~13px, pill từ 30px còn 18px. Khớp đúng số đo.
  Các tab có nội dung vừa chỗ thì free space không âm -> không ai bị co -> không thấy lỗi.

SỬA: .edit-tabs { flex: 0 0 auto; } — dải tab không bao giờ co; phần thiếu dồn hết cho
.edit-panel-main, và #editPanelBody vốn đã có overflow-y:auto nên nó CUỘN thay vì đẩy layout.
Kiểm lại đủ 9 tab: pill 30px và dải tab 42px ở tất cả, subtab 30px, body vẫn cuộn đúng ở
Chuyển tiếp (2084) / LUT (1415) / Thư viện (515).

LỖI CÓ TỪ TRƯỚC, không phải do Phase B: bản ở commit 7af67b1 (trước Phase B) là
    .edit-tabs { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 4px; }
cũng không có flex-shrink. Phase B chỉ viết lại rule này thành khối nhiều dòng và thêm
mask/hover, không thêm cũng không bớt flex-shrink.

ĐÁNG CHÚ Ý: .ins-tabs và .ins-subtabs (cột Thuộc tính) ĐÃ có 'flex: 0 0 auto' sẵn từ trước —
tức đúng chỗ khác trong app đã phòng cái bẫy này, chỉ .edit-tabs bỏ sót.

BÀI HỌC: trong một flex column, MỌI thanh công cụ / dải tab / header có chiều cao theo nội
dung đều phải đặt flex-shrink: 0. Không đặt thì nó chỉ hỏng ở đúng những trang có nội dung
dài — nên lỗi lọt qua mọi lần kiểm bằng trang nội dung ngắn.
```

### Cụm keyframe trong .fig-field: lệch lên trên + dãn cách quá rộng (đã sửa 2026-08-20)

```text
HAI LỖI RIÊNG BIỆT, cả hai đo được (khung .fig-field cao 30px):

1) LỆCH LÊN TRÊN — .kf-nav và .kf-diamond KHÔNG đặt margin, nên thừa hưởng
   `margin-bottom: var(--sp-5)` (10px) của selector `button` thô ở đầu file. Trong một hàng
   flex có align-items:center, margin-bottom KHÔNG đẩy item xuống mà đẩy nó LÊN nửa margin
   (vì tâm được tính trên hộp đã cộng margin). Đo được:
       trước:  cách cạnh trên -4.5px  /  cách cạnh dưới 5.5px   (nút NHÔ RA NGOÀI cạnh trên)
       sau  :  cách cạnh trên  3.0px  /  cách cạnh dưới 3.0px   (đều hai bên)
   Sửa: margin: 0. Lỗi này cũng làm lệch cả cụm keyframe trong .kf-group (hàng Scale/Xoay/
   Opacity) — sau khi sửa lệch trên/dưới đều = 0.

2) DÃN CÁCH QUÁ RỘNG — 3 nút chiếm 24+29+24 = 77px, cộng 2 khe 6px của .fig-field là 89px
   trên tổng 157px, tức HƠN NỬA khung chỉ để chứa cụm keyframe, trong khi icon bên trong chỉ
   13-14px. Sửa: nút còn 20/22px, cao 24px, và kéo 3 nút sát nhau bằng margin-left âm.
       cụm keyframe: 89px -> 66px
       ô nhập số   : 30px -> 53px   (đây mới là phần đáng giá — số dài không còn bị bó)

   VÌ SAO DÙNG MARGIN ÂM: `gap` của flex không đặt riêng được cho từng cặp item, còn bọc 3 nút
   vào một thẻ container thì phải sửa markup mà JS đang bind theo data-kf-field. Rule:
       .fig-field > .kf-nav + .kf-diamond,
       .fig-field > .kf-diamond + .kf-nav { margin-left: -4px; }   /* 6px gap -> còn 2px */

VÙNG BẤM: vì vừa thu nhỏ nút, thêm ::after nới vùng bấm theo chiều DỌC cho bằng chiều cao
khung (top/bottom -3px). CỐ Ý không nới ngang: khe giữa 3 nút chỉ còn 2px, nới ngang là chúng
ăn vào vùng bấm của nhau và của ô nhập. Kiểm bằng elementFromPoint: bấm ở 1.5px / 15px /
28.5px tính từ cạnh trên khung đều trúng nút.
```

## Đợt UI/UX Pro — Phase D: màn hình, modal, phản hồi (2026-08-20)

### D1. Hệ phản hồi — trước đây KHÔNG có gì

Trạng thái trước:

```text
  toast / notification        : 0
  progress bar / spinner      : 0
  aria-live trong toàn app    : 0
  alert()                     : 49  (34 index.html + 15 editing-runtime.js)
  kênh phản hồi duy nhất      : #statusText — max-width 210px, text-overflow: ellipsis
```

`#statusText` còn đi qua `compactStatusMessage()` — hàm này rút gọn thông điệp thành 8 câu cố
định ("Đang xử lý...", "Có lỗi xảy ra"...). Nghĩa là **mọi chi tiết của lỗi đều rơi mất** trừ
khi người dùng rê chuột đọc `title`.

`static/js/ui-feedback.js` (mới, nạp ĐẦU TIÊN trong `<head>`, trước cả `mammoth`) cung cấp:

| API | Việc |
|---|---|
| `window.showToast(msg, {type,title,duration})` | thẻ nổi, `type` ∈ info/success/warning/error |
| `window.toast.info/success/warn/error(msg)` | lối tắt |
| `window.clearToasts()` | dọn hết |
| `window.setAppProgress(v[,total])` | `null` ẩn · `0..1` hoặc `(done,total)` xác định · `'busy'` vô định |

Vì sao là FILE RIÊNG chứ không nằm trong khối `<script>` của `index.html`: khối đó là một
closure, `editing-runtime.js` không với vào được — đó chính là lý do file này phải dùng
`typeof setStatusText === 'function'` ở 12 chỗ. Đặt trong file riêng thì cả hai bên gọi thẳng.

Dựng host DOM **lazy**: script chạy trong `<head>` nên lúc đó `document.body` chưa tồn tại.
`ensureHost()` gọi lại ở lần dùng đầu tiên và ở `DOMContentLoaded`.

**Gộp toast trùng.** Vòng lặp lỗi (ví dụ kéo thả 20 tệp hỏng) sẽ đẩy 20 thẻ ra màn hình. Toast
trùng cả `type` lẫn nội dung thì gộp vào thẻ đang sống và đếm bằng huy hiệu `×n`. Trần hiển thị
4 thẻ; quá thì thẻ cũ nhất bị đẩy ra.

**Bẫy `requestAnimationFrame`.** Transition "vào" cần một khung để có điểm bắt đầu, nên code
thêm class `.is-in` trong `rAF(rAF(...))`. Nhưng `rAF` **không chạy khi `document.hidden`**
(đúng cái bẫy đã ghi ở BAN_GIAO §7.1), toast sẽ kẹt ở `opacity: 0` vĩnh viễn. Có thêm
`setTimeout(..., 80)` làm lưới an toàn. Cùng lý do, `dismiss()` dọn DOM bằng `transitionend`
**và** một `setTimeout(400)` dự phòng.

**Chuyển 49 `alert()`.** Phân loại theo nội dung: 31 error, 17 warning, 1 info. Bốn thông điệp
dài (hướng dẫn nhiều bước) tách dòng đầu thành `title` và nới `duration` lên 11s. `confirm()`
(8 chỗ) và `window.prompt()` (1 chỗ) **KHÔNG đụng tới** — thay chúng phải chuyển hàm gọi sang
async, tức chạm luồng điều khiển; vẫn nằm ở hạng mục tách riêng.

**Thanh tiến độ** là dải 2px sát mép dưới `.header-bar` (`position:absolute; bottom:-1px`, nằm
đè lên đúng đường viền dưới nên không chiếm thêm một pixel chiều cao nào của shell).

Hai chế độ, và điểm cắm KHÔNG cần sửa call site nào cho chế độ vô định:

```js
// setStatusText(rawMessage, isBusy) — chữ ký GIỮ NGUYÊN, chỉ thêm một dòng
if (!isBusy) appProgressPinned = false;                       // lưới an toàn
if (!appProgressPinned) window.setAppProgress?.(isBusy ? 'busy' : null);
```

Mọi chỗ đang gọi `setStatusText(..., true)` (bóc băng, nối video, xuất video, bake) tự có
thanh chạy. Chế độ **xác định** cắm vào 3 vòng bake sẵn có trong `editing-runtime.js`, dùng
ĐÚNG con số mà dòng trạng thái đang đếm — không thêm phép đếm mới:

```text
  appendMainTransitionItems      done/todo          (số chuyển cảnh)
  appendRetouchItems             done+n/totalFrames (khung, lưới spanFrames)
  appendOverlayRetouchItems      n/all              (khung của overlay hiện tại)
```

`window.beginAppTask()` ghim thanh ở chế độ xác định để các lượt `setStatusText` xen giữa
không kéo nó về vô định; `endAppTask()` gỡ ghim. **Lưới an toàn** ở trên (bất kỳ lượt
`setStatusText(..., false)` nào cũng gỡ ghim) là lý do không cần bọc 3 vòng bake vào
`try/finally` — một ngoại lệ thoát ra giữa chừng vẫn không để thanh kẹt lại.

`aria-live`: `#statusText` được `role="status" aria-live="polite" aria-atomic="true"`; host
toast `role="status" aria-live="polite" aria-atomic="false"` (false vì mỗi toast là một thông
điệp độc lập, đọc lại cả cụm mỗi lần thêm thẻ là ồn).

### D2. Modal / dropdown

**Chỉ có animation VÀO, cố ý.** Cả 5 modal và 8 dropdown bật/tắt bằng `display:none ↔ block`.
Với khuôn đó, `@keyframes` gắn vào trạng thái HIỆN là cách duy nhất animate mà không phải sửa
hàm đóng/mở — mà các hàm đóng nằm rải ở `index.html`, `settings-panel.js` và
`editing-runtime.js`, toàn là luồng điều khiển (ràng buộc: không đụng logic). Lượt ra tức thì
cũng đúng kỳ vọng "đóng là biến ngay" và không tạo cửa sổ thời gian nào cho race giữa hai lần
mở liên tiếp.

Bốn keyframe, **không dùng lẫn được**:

```text
  ui-scrim-in    opacity                                  -> nền mờ
  ui-modal-in    opacity + scale, GIỮ translate(-50%,-50%) -> 4 modal khai trong HTML
                 (chúng căn giữa bằng top/left 50% + translate; bỏ translate khỏi keyframe
                  là modal nhảy sang góc phải-dưới trong suốt thời gian chạy animation)
  ui-panel-in    opacity + scale, KHÔNG translate          -> panel căn giữa bằng flex
  ui-menu-in     trượt XUỐNG  / ui-menu-up-in trượt LÊN    -> .pcb-menu mở lên trên
```

**Modal dựng bằng JS.** `showRelinkModal()` và `askSaveBeforeLeave()` trước đây tự viết
`style.cssText`: không kính mờ, không bóng, không `role="dialog"`, **không đóng được bằng
ESC**, và relink không có nút ×. Nay cả hai dùng chung khuôn `.ui-scrim` + `.ui-modal-panel`
(`.ui-modal-head` / `-title` / `-close` / `-desc` / `-body` / `-foot`), cùng ngôn ngữ với 4
modal khai sẵn trong HTML. Thêm:

- ESC đóng — `addEventListener('keydown', …, true)` ở pha **capture** để phím không bị handler
  phím tắt ở tầng dưới nuốt trước.
- **Trả focus** về phần tử đang focus lúc mở (`lastFocused`), và focus vào một control có
  nghĩa lúc mở (nút "Tìm lại…" đầu tiên / nút "Lưu").
- Nội dung do người dùng cung cấp (tên tệp, đường dẫn) đi qua `textContent` chứ không
  `innerHTML` như bản cũ.

Hợp đồng trả về **không đổi**: `showRelinkModal` vẫn resolve `{relinks, skipped}` hoặc `null`;
`askSaveBeforeLeave` vẫn resolve `'save' | 'discard' | 'cancel'`.

**`#settingsModalPanel`**: `height: min(680px, 100vh-80px)` → `max-height` + `min-height:
min(360px, 100vh-80px)`. Chiều cao cứng để lại một khoảng trống lớn ở dưới mỗi khi mục đang mở
ít nội dung (đo: tab "Chung" nay cao 379px thay vì 640px; tab "Phím tắt" vẫn chạm trần 640px
và cuộn trong `.set-pane` như cũ).

### D3. Empty state

`.home-card` **đã có** thumbnail / tên / thời gian sửa từ trước — kế hoạch Phase D ghi "lưới
`.home-grid` hiện là chữ trần" là ghi sai. Phần thật sự còn thiếu chỉ là **empty state**.

Empty state của Home nay là icon + tiêu đề + mô tả + CTA, và tách **hai ca** (trước gộp một):

```text
  homeRecentItems.length > 0  -> "Không có dự án nào khớp"  + icon kính lúp, KHÔNG CTA
  homeRecentItems.length == 0 -> "Chưa có dự án nào"        + icon phim + nút "Tạo dự án mới"
```

CTA dựng lại mỗi lần render nên nghe click bằng **uỷ quyền** trên `#homeRecentEmpty`, và gọi
đúng `startNewProjectFromHome()` mà nút ở rail đang gọi — không có đường thứ hai.

**Gom 4/6 empty state**, không phải cả 6:

| Class | Xử lý |
|---|---|
| `.empty-state` (mới), `.home-empty`, `.edit-empty`, `.font-picker-empty` | gom về MỘT bộ thuộc tính trong `index.html` |
| `.video-lib-empty` | GIỮ RIÊNG — nó là vùng thả tương tác (bấm vào mở hộp thoại nhập), đã có icon và trạng thái hover riêng |
| `.set-empty` | GIỮ RIÊNG — là `<span>` inline chen giữa các chip trong panel Cài đặt, ép thành khối flex căn giữa là hỏng dòng |

Hai bẫy khi gom:

1. `.edit-empty` được khai trong `injectStyle()` của `editing-runtime.js`. Style đó chèn vào
   `<head>` **SAU** khối `<style>` của `index.html`, nên cùng specificity thì nó thắng. Phải
   **xoá** khai báo `color/font-size/padding/text-align` bên đó, chỉ chừa `.edit-loading`.
2. Khuôn chung đặt `display: flex`, mà đó là **author style** nên nó thắng `[hidden]` của
   trình duyệt (UA style) → `.home-empty` / `.font-picker-empty` sẽ hiện cả khi có thuộc tính
   `hidden`. Bắt buộc phải có `.home-empty[hidden] { display: none }` cho từng class trong nhóm.

### D4. Vụn

`.breadcrumb-item.active` dùng `#00d2ff` + `text-shadow: 0 0 8px rgba(0,210,255,.4)` — màu
DUY NHẤT trong toàn app không thuộc bảng màu. Đổi về `var(--primary)` + `--fw-semibold`, bỏ
glow (bước đang đứng đã đủ nổi nhờ màu và độ đậm). Thêm `aria-current="step"` do
`updateBreadcrumb()` đặt/gỡ — trước đó bước đang đứng chỉ được đánh dấu bằng MÀU nên screen
reader không thấy gì.

### Kiểm sau Phase D

```text
  window.innerWidth                       1440   (≠ 0 — xem BAN_GIAO §7.2)
  updateTimelineLayout.name               patchedUpdateTimelineLayout   (§7.1)
  playhead.style.left / transform         50% / translateX(-50%)
  lệch tâm playhead so với tâm khung      0.000px
  git diff chạm 3 hàm cấm                 KHÔNG
  token tự tham chiếu --x: var(--x)       0
  console error                           chỉ 404 /api/editing-assets/main-source
  font-size < 10px trong DOM toast        0
  hit target nút đóng toast/modal         28×28
```

**Số đo tiến độ đọc trong khung xem trước tự động hoá là KHÔNG TIN ĐƯỢC.** `.app-progress-fill`
có `transition: width`, mà CSS transition bị đóng băng khi `document.hidden === true` — khung
xem trước ở trạng thái đó gần như suốt phiên, nên `getBoundingClientRect().width` đọc ra **0px**
dù `style.width` đã là `37%`. Cùng họ với bẫy §7.1/§7.2. Kiểm bằng `screenshot` (thao tác này
đưa tab ra trước) hoặc đọc `element.style.width` thay vì rect.

## Menu fps / kích thước khung ở thanh preview không mở ra (đã sửa 2026-08-21)

Bấm nút `30 fps` hoặc `1920x1080` không thấy menu. **Không phải lỗi handler** — mọi thứ phía
JS đều chạy đúng, đo được lúc menu "đang mở":

```text
  previewFpsMenu.hidden          false
  số .pcb-menu-item dựng ra      9
  getBoundingClientRect()        207 × 315 tại (720, 280) — nằm trọn trong viewport
  btnPreviewFps.className        pcb-btn is-open
  aria-expanded                  true
  opacity                        1
  document.elementFromPoint(tâm menu)   -> #sequencePreviewFrame   <-- KHÔNG phải menu
```

Dòng cuối là manh mối: menu tồn tại, đúng chỗ, đục, nhưng **không nhận được hit-test** ⇒ nó
đang bị XÉN chứ không phải bị che.

Thủ phạm là một dòng của Phase A:

```css
.preview-control-bar .pcb-right { min-width: 0; flex-wrap: nowrap; overflow: hidden; }
```

Ý định ban đầu đúng: `.pcb-right` là `flex: 1 1 0` + `justify-content: flex-end`, nên ở cửa sổ
hẹp cụm nút bên phải sẽ tràn sang TRÁI và đè lên nút Play ở giữa — cần một lưới an toàn.
Nhưng `overflow: hidden` **cắt cả hai trục**, mà `.pcb-menu` mở LÊN TRÊN
(`bottom: calc(100% + 6px)`), tức nằm hoàn toàn ngoài hộp cao 28px của zone ⇒ bị xén sạch.
Lỗi chỉ lộ ở hai nút CÓ MENU; nút zoom / Play / chụp ảnh nằm trong hộp nên không việc gì.

Sửa: cắt đúng MỘT trục.

```css
.preview-control-bar .pcb-right { min-width: 0; flex-wrap: nowrap; overflow-x: clip; overflow-y: visible; }
```

**Phải là `clip`, không phải `hidden`.** Theo spec, khi một trục là `hidden` thì trục còn lại
khai `visible` sẽ **tính thành `auto`** (biến thành vùng cuộn — và vẫn cắt). Chỉ `clip` mới để
trục kia `visible` đúng nghĩa. Đo lại sau khi sửa: `overflowX: "clip"`, `overflowY: "visible"`,
`elementFromPoint` trúng mục trong menu, và ở 1200px cụm phải vẫn KHÔNG chồng lên zone giữa
(`right.left = 593 > center.right = 583`).

Kèm sửa một lỗi markup cùng chỗ: `<span class="pcb-zoom">` (cụm −/%/+) bị lồng **bên trong**
`.pcb-menu-wrap` của nút fps, nên menu fps neo theo cả cụm zoom thay vì theo nút của nó. Đã
tách ra ngoài. Vì `syncPreviewControlBar()` ẩn/hiện theo selector `.pcb-menu-wrap`, tách ra là
cụm zoom mất luôn ràng buộc "chỉ hiện khi có sequence" — nên selector đó đổi thành
`.pcb-menu-wrap, .pcb-zoom` để **hành vi ẩn/hiện giữ nguyên như trước**.

## Đợt UI/UX Pro — Phase E: trợ năng & hoàn thiện (2026-08-21)

Số liệu đo lại đầu phase (kế hoạch cũ ước sai vài chỗ, ghi lại con số THẬT):

```text
                                   kế hoạch ước    đo thật    sau Phase E
  <label for=…>                          0             0          40
  role="tab"                             2             2          12
  aria-selected                          0             0          12
  role="tabpanel"                        0             0           2
  nút chỉ-icon thiếu aria-label        ~70             4           0
  ::-webkit-scrollbar                    6px           6px       10px (dọc timeline: 6px, xem dưới)
  bẫy focus cho modal                    0             0           4
```

Ước "~70 nút thiếu aria-label" là con số TRƯỚC Phase B; Phase B đã dọn gần hết khi thay
~30 ký tự hình học bằng sprite icon. Đo lại bằng script quét
`<button>…</button>` mà nội dung chỉ có `<svg>` và không có `aria-label`/`aria-labelledby`:
chỉ còn **4** (ô tông da retouch, ô dải màu HSL, nút hút màu, nút bánh răng Typography).

### E1. Hệ tooltip của Phase B đang NUỐT tên khả truy cập — lỗi thật

`tipHostFor()` chuyển `title` → `data-tip` rồi **`removeAttribute('title')`**. Với nút
chỉ-có-icon, `title` thường là **tên duy nhất** mà trình đọc màn hình có. Vừa rê chuột qua một
lần là nút thành **VÔ DANH** — và `.app-tip` thì `aria-hidden="true"` nên không gánh thay được.
Lỗi này không nhìn thấy bằng mắt và không có lượt kiểm nào ở Phase B bắt được.

Sửa: trước khi gỡ `title`, nếu phần tử **chưa có tên nào khác** thì chép sang `aria-label`.

```js
if (!hasAccessibleName(host)) host.setAttribute('aria-label', native);
```

`hasAccessibleName()` xét theo đúng thứ tự mà thuật toán tên khả truy cập dùng: `aria-label`
→ `aria-labelledby` → **chữ hiển thị** (nhân bản node rồi bỏ mọi `<svg>` và
`[aria-hidden="true"]` ra trước khi đọc `textContent`) → `<label for>` → `<label>` bọc ngoài.

Điều kiện "chưa có tên nào khác" là bắt buộc, không phải cho chắc: nút CÓ chữ hiển thị mà bị
ghi đè `aria-label` bằng `title` sẽ đọc lên **khác hẳn** chữ người dùng đang nhìn thấy (nút
`Menu` với `title="Mở bảng chọn"` sẽ được đọc là "Mở bảng chọn"). Đã kiểm bằng 3 ca:

```text
  A  <button title="Xoá block"><svg></button>              -> aria-label="Xoá block"   ✔ cấp mới
  B  <button title="Mở bảng chọn">Menu</button>            -> aria-label=null          ✔ không đè
  C  <button title="…" aria-label="Tên gốc"><svg></button> -> aria-label="Tên gốc"     ✔ giữ nguyên
```

### E2. Ngữ nghĩa tab cho 4 dải tab

App có 4 hệ tab, trước đây chỉ 2 chỗ có `role="tab"` và **không chỗ nào** có `aria-selected`:
mục đang mở chỉ được đánh dấu bằng MÀU.

| Dải | Dựng ở | Panel |
|---|---|---|
| `.edit-tab` (9 tab panel Editing) | markup tĩnh `index.html` + `renderEditPanel()` | `#editPanelBody` |
| `.edit-subtab` | `editing-runtime.js` `renderEditPanel()` | `#editPanelBody` |
| `.ins-tab` / `.ins-subtab` | `index.html` `refreshInspectorTabs()` | `#inspectorPanelBody` |
| `.set-nav-item` (dọc) | `settings-panel.js` `render()` | `#settingsPane` |

`aria-selected` phải đi CÙNG CHỖ với class `is-active`, không phải đặt một lần ở markup:
`.edit-tab` bật/tắt class bằng `classList.toggle` trong `renderEditPanel()`, nên nếu chỉ sửa
markup tĩnh thì đúng lúc mở app rồi **sai ngay lượt đổi tab đầu tiên**.

**KHÔNG dùng roving tabindex** dù đó là chuẩn APG. Roving đòi mọi lượt dựng lại tab phải đồng
bộ `tabindex`, tức phải theo dõi DOM — mà 3 trong 4 dải này dựng lại mỗi lần đổi block đang
chọn. Ở đây mọi tab vẫn nằm trong luồng Tab như cũ, phím mũi tên là **thêm** chứ không thay.

`static/js/ui-a11y.js` nghe `keydown` uỷ quyền ở `document` (pha capture) cho mọi
`[role="tablist"]`: ←/→ (hoặc ↑/↓ nếu `aria-orientation="vertical"`), Home, End. Kích hoạt
bằng `.click()` trên chính nút — đi qua ĐÚNG handler sẵn có, không nhân bản đường đổi tab
thứ hai để rồi lệch nhau. Sau `.click()` dải tab dựng lại (`innerHTML` mới) nên nút cũ rơi
khỏi DOM; phải tìm lại theo VỊ TRÍ để focus không rơi về `<body>`.

**`stopPropagation()` là bắt buộc:** ←/→ là phím tắt TOÀN CỤC (lùi/tiến một khung hình,
`shortcuts.js` `playback.prevFrame/nextFrame`). Không chặn thì đi giữa các tab làm con trỏ
thời gian nhảy. Handler phím tắt đó đăng ký ở `window` pha **bubble** (`index.html`), còn
listener này ở `document` pha **capture** — chạy trước, chặn được. Đã kiểm bằng listener dò:

```text
  focus TRÊN tab   -> window nhận keydown: 0    (phím tắt không chạy)  ✔
  focus NGOÀI tab  -> window nhận keydown: 1    (phím tắt vẫn sống)    ✔
```

Lưu ý `stopPropagation()` KHÔNG chặn listener khác trên CÙNG node — handler capture của
`editing-runtime.js` vẫn nhận (đo được), nhưng nó không xử lý mũi tên trần nên vô hại.

### E3. `<label for=…>`: 0 → 40

Trước Phase E **không có một `for=` nào** trong cả app: nhãn chỉ là thẻ đứng cạnh ô nhập, nên
trình đọc màn hình đọc ô nhập là "edit text" trống, và bấm vào nhãn không focus được ô.

Ba cách xử lý, chọn theo hình dạng thật của cụm:

1. **1 nhãn ↔ 1 control** → `for=` thẳng (33 chỗ). Với template literal thì `for="${prefix}VolumeDbRange"` chạy bình thường.
2. **1 nhãn ↔ thanh trượt + ô số** (Scale / Xoay / Opacity / Volume…) → `for=` trỏ **thanh trượt**, ô số nhận `aria-label` riêng (`Scale (phần trăm)`, `Xoay (độ)`…). `for` chỉ trỏ được một control.
3. **1 nhãn ↔ một NHÓM** (Căn lề = 3 nút, "Đang áp" = chip LUT, "Nguồn video đầu vào" = cả thư viện, Font = combobox dựng bằng nút) → nhãn nhận `id`, khối nhận `role="group"` + `aria-labelledby`.

`settings-panel.js` **không cần sửa**: 7 `<label>` ở đó đều BỌC control (gán nhãn ngầm) — hợp
lệ sẵn. Script quét ban đầu báo nhầm vì control nằm ở dòng sau.

Kiểm: `[...document.querySelectorAll('label[for]')].filter(l => !document.getElementById(l.htmlFor))` → rỗng.

### E4. Bẫy focus cho hộp thoại

Trước Phase E: mở modal xong bấm Tab là con trỏ đi **xuyên xuống trang phía dưới**, và đóng
modal thì focus rơi về `<body>`. `window.UiA11y.trapFocus(panel, {onEscape, initial})` trả về
hàm gỡ; gắn vào 4 modal khai trong HTML:

```text
  #exportModalPanel     editing-runtime.js  openExportModal / closeExportModal
  #settingsModalPanel   settings-panel.js   open / close      (initial = mục đang mở, không phải nút Đóng)
  #captureModalPanel    index.html          nút chụp / closeCaptureModal   (initial = nút Lưu)
  #cutPromptPanel       index.html          cleanup()          (initial = nút "Không")
```

**KHÔNG truyền `onEscape` cho cả 4** — cả 4 đã có handler ESC riêng từ trước
(`index.html:6748` settings, `8623` capture, `4645` cut-prompt, `editing-runtime.js:16175`
export). Truyền vào là đóng hai lần. `onEscape` chỉ dành cho hộp thoại dựng mới.

Hai modal dựng bằng JS (`showRelinkModal`, `askSaveBeforeLeave`) đã tự có ESC + trả focus từ
Phase D, nên không đổi.

`focusablesIn()` lọc `offsetParent !== null` — phần tử nằm trong nhánh `display:none` (tab
đang ẩn của modal Cài đặt) không được tính, nếu không Tab sẽ nhảy vào hư không.

Kiểm trên modal Cài đặt (14 phần tử focus được): Tab từ cuối vòng về đầu ✔, Shift+Tab từ đầu
về cuối ✔, focus bị đẩy ra ngoài thì Tab kéo về ✔, đóng thì trả focus đúng nút đã mở ✔.
**`SettingsPanel.open()` là `async`** (chờ `ensureLibrary`) — kiểm ngay sau lời gọi sẽ thấy
panel rỗng; phải chờ một nhịp.

### E5. Scrollbar 6px → 10px — VÀ vì sao trục dọc của timeline PHẢI giữ 6px

6px quá mảnh để trỏ trúng, nhất là thanh cuộn NGANG của timeline (thứ bị kéo nhiều nhất trong
cả app). Nới lên 10px, thumb đặc hơn, bo tròn, có đệm trong 2px bằng
`border: 2px solid transparent` + `background-clip: padding-box` để thumb trông mảnh hơn rãnh.

**Nhưng nới bề RỘNG là chạm thẳng vào ràng buộc cứng của playhead.** Toàn bộ phép cuộn ghim
playhead ở giữa đọc `timelineOuter.clientWidth`, mà:

```text
  clientWidth = offsetWidth − viền − BỀ RỘNG THANH CUỘN DỌC
```

`editing-runtime.js` đặt `overflow-y: auto` cho `.timeline-track-outer`, nên 6px → 10px làm
lệch tâm playhead so với tâm khung **tăng thêm 2px** (đã có sẵn ~3px do chính thanh cuộn 6px
— xem BAN_GIAO §5.4, hạng mục "chỉ báo, không sửa").

```css
/* Trục DỌC giữ 6px; trục NGANG nới thoải mái vì nó chỉ ăn vào clientHeight,
   không có phép toán nào đọc tới. */
.timeline-track-outer::-webkit-scrollbar { width: 6px; height: 10px; }
```

Đo lại sau khi sửa: scroller thường `[10, 10]`, `.timeline-track-outer` `[6, 10]`,
`clientWidth` **không đổi**, lệch tâm playhead **0.000px**.

### E6 + E7. Nhãn nút icon và kênh thông báo

4 nút chỉ-icon còn lại nhận `aria-label` ngay lúc dựng (không đợi E1 chép từ `title` — E1 chỉ
chạy khi có người rê chuột qua). Ô màu lấy tên nói rõ nghĩa chứ không lặp lại `title`: ô tông
da có `title="#f5d0b8"` nhưng `aria-label="Tông da #f5d0b8"`.

Kênh thông báo:

```text
  #statusText          role=status  aria-live=polite    (Phase D)
  #toastHost           role=status  aria-live=polite    (Phase D)
  #editingAssetStatus  role=status  aria-live=polite    (Phase E) — trạng thái panel Editing
  .sc-conflict         role=alert                       (Phase E) — xung đột phím tắt
```

`.sc-conflict` dùng `role="alert"` (assertive) chứ không `polite`: nó hiện **đột ngột** sau
khi người dùng bắt một phím và buộc phải quyết định ngay (Gán đè / Huỷ) — đọc "khi rảnh" là
quá muộn. Mọi kênh còn lại là trạng thái nền nên `polite`.

### E8. Contrast — đo CÓ compositing, và hai bẫy đo

Hàm đo tự viết: trộn ngược màu nền lên cây cha tới khi gặp lớp ĐỤC, rồi mới tính tỉ lệ. Hai
bẫy làm số đo sai, cả hai đều gây **báo động giả**:

1. **Gradient là background-IMAGE.** `getComputedStyle().backgroundColor` trả `rgba(0,0,0,0)`
   khi nền đặt bằng gradient (đúng cái đã làm bàn giao Phase D ghi nhầm `.app-menu-dropdown`
   là "trong suốt hoàn toàn"). Phải đọc `backgroundImage`, bóc các stop `rgba()` ra và lấy
   trung bình.
2. **`background-clip: text`.** Chữ "CrabbyCut" ở header dùng
   `linear-gradient(135deg,#fff,#b9c6d6)` LÀM CHỮ, không phải làm nền. Không loại ca này ra
   thì hàm đo coi nền là `rgb(220,227,235)` và báo contrast 1.19 — sai hoàn toàn. Bỏ qua
   phần tử có `background-clip: text` ở cả hai vòng (phần tử đang xét và cây cha).

Sau khi lọc hai bẫy, quét Home + step0 + step4 + modal Cài đặt còn **2 nhóm** dưới AA:

**(a) Accent dùng làm màu CHỮ — ĐÃ SỬA.** `#0a84ff` trên nền tối chỉ đạt:

```text
  trên --surface-2 #17181b   4.87  ✔
  trên --surface-3 #232428   4.25  ✘  (.ins-tab.is-active)
  trên --surface-4 #2d2f35   3.67  ✘
```

Thêm token `--primary-text: #3d9bff` → 6.20 / 5.41 / 4.67, mắt gần như không phân biệt được
với accent gốc. **Chỉ dùng cho CHỮ**; nền đặc, viền và icon vẫn là `--primary` (icon là đồ
hoạ phi văn bản, ngưỡng 3:1 nên 4.25 đã qua). Áp cho 5 rule text-bearing:
`.breadcrumb-item.active`, `.media-crumbs .media-crumb`, `.ins-tab.is-active`,
`.app-menu-toggle.is-on`, `.pap-time b`. Kèm `.breadcrumb-separator` từ `--border-color`
(1.22:1 — gần như vô hình) lên `--text-3`, và thêm `aria-hidden="true"` vì nó là hình trang trí.

**(b) Chữ TRẮNG trên nền ĐẶC accent/danger — CHƯA SỬA, cần người dùng quyết.**

```text
  trắng trên --primary #0a84ff   3.65  ✘   .btn-primary, .edit-tab.is-active,
                                            .edit-subtab.is-active, .set-nav-item.is-active,
                                            .edit-import-btn, .home-cta
  trắng trên --danger  #ff453a   3.41  ✘   .btn-danger (nút "Xuất Video")
```

Không sửa được bằng màu chữ (trắng đã là cực đại) — chỉ còn cách **làm tối nền nút**:
`#0a6fd6` → 4.93 ✔ (chính là `--primary-hover` sẵn có), `#e02d22` → 4.60 ✔. Nhưng
BAN_GIAO §6 ghi accent `#0a84ff` là **ràng buộc cứng**, nên đây là quyết định thẩm mỹ của chủ
dự án chứ không phải việc dọn dẹp trợ năng. Ghi lại số liệu, chưa đụng.

## Bộ đo so khớp kịch bản — Phase 0 (2026-08-21)

Trước đợt tối ưu so khớp transcript ↔ kịch bản chuẩn, phần này **không có bất kỳ
phép đo nào**: không dữ liệu vàng, không chỉ số, không test hồi quy. Mọi lần
chỉnh ngưỡng trong `core_logic.py` đều là chỉnh mù. Phase 0 dựng bộ đo trước,
chưa đụng vào thuật toán.

### Dữ liệu vàng lấy từ asr_cache, không bóc băng lại

`scripts/build_matching_fixtures.py` dựng fixture từ `asr_cache/` thay vì chạy
lại ASR. Mỗi lần app bóc băng xong đều ghi kết quả word-level vào đó, kèm khoá
cache có đủ đường dẫn nguồn và `reference_script_sha1`. Nhờ vậy ghép được đúng
cặp (kịch bản, transcript) của lần chạy thật mà không tốn hàng chục phút GPU cho
mỗi dự án.

Điểm phải giữ đúng: `read_script()` đọc kịch bản **nguyên xi** (`read_bytes()`
rồi decode, không strip, không normalize Unicode). sha1 của chuỗi đó nằm trong
khoá cache, thêm/bớt một ký tự trắng là mất khả năng đối chiếu. `meta.json` ghi
cờ `script_matches_transcribe_run` cho biết fixture có khớp đúng lần chạy không.

Fixture nằm trong `tests/fixtures/matching/<case>/` và **phải được commit**:
`asr_cache/` bị gitignore, nên đây là bản lưu duy nhất của các transcript này.

### Chỉ số

`scripts/eval_matching.py` chạy `deterministic_filter_pipeline` trên từng case.
Transcript được dựng lại thành chuỗi `[start - end | dBFS] text` y hệt
`formatSegmentsToText()` của `backend/server.js` — bộ so khớp nhận VĂN BẢN chứ
không nhận object, nên phải đi đúng đường đó thì mới đo đúng cái đang chạy thật.

Nhóm chỉ số tự-kiểm (không cần nhãn):

| Chỉ số | Ý nghĩa |
|---|---|
| `câu KB` | mẫu số thật: mọi câu người dùng nhìn thấy, tách theo dòng + dấu câu |
| `ngắn` / `dán` | câu mất ngay ở khâu tách kịch bản (dưới 3 từ / bị dán dính do lỗi xuống dòng) |
| `tới UI` / `rơi` | câu đã khớp trong pipeline nhưng không tới được `mapped_chunks` |
| `trùng` / `đảo` | hai hàng dùng chồng audio / hàng lùi về trước hàng liền trước |
| `dư(s)` | số giây audio thừa mà hàng ôm thêm ngoài đoạn đúng |

Nhóm cần nhãn: `take%`, `sai`, `sót`, `Δs90`. Tiêu chí "đúng take" là **phủ ≥50%
đoạn đúng**, cố ý không dùng IoU: nó đo việc *chọn đúng vùng*, còn biên khít hay
không đã có `Δs90` và `dư(s)` đo riêng. Dùng IoU sẽ đánh trượt cả những lần chọn
đúng chỗ nhưng lấy nguyên một chunk dài.

`--save-baseline` chốt mốc vào `tests/fixtures/matching/baseline.json`; các lần
chạy sau tự in delta từng chỉ số.

### Gán nhãn: bộ dò ứng viên phải độc lập với engine đang đo

`scripts/label_matching_takes.py --propose` sinh `review.md` liệt kê **mọi** lần
mỗi câu được nói. Bộ dò của nó quét cửa sổ trượt trên toàn bộ dòng từ, cố tình
không dùng chunk và không dùng cửa sổ ±2 chunk quanh anchor như
`apply_last_best_take`. Nếu lấy nhãn từ chính hệ thống đang đo thì mọi take mà hệ
thống không nhìn thấy sẽ mặc nhiên "không tồn tại" và điểm số đẹp một cách giả
tạo.

Dòng tick sẵn chỉ là **đề xuất** (take muộn nhất trong nhóm gần-tốt-nhất) để
người duyệt bấm nhanh, không phải nhãn — tin luôn đề xuất thì nhãn chỉ đang mã
hoá lại đúng cái giả định "take cuối là tốt nhất" mà ta muốn kiểm chứng.

`review.md` còn có mục **Lượt đọc dò được**: gom ứng viên theo thứ hạng xuất hiện
(`take 0` của mọi câu = lượt 1, …). Người quay thường đọc lại cả kịch bản chứ
không chỉ một câu, nên quyết định thật sự là "lấy lượt nào". Không tách lượt bằng
khoảng trống thời gian được: hai lượt liên tiếp thường chỉ cách nhau vài giây,
đúng bằng khoảng nghỉ giữa hai câu trong cùng một lượt.

`--import` đọc ngược `review.md` thành `labels.json`.

### Lệnh

```bash
npm run fixtures:matching       # dựng fixture từ asr_cache
npm run label:matching          # sinh review.md để duyệt
npm run label:matching-import   # review.md -> labels.json
npm run eval:matching           # đo, so với baseline
```

## So khớp kịch bản — Phase 1: vá các lỗi làm mất câu (2026-08-21)

Đo trên bộ dữ liệu vàng 6 dự án thật (113 câu kịch bản): **94/113 câu tới được
timeline (83,2%) → 113/113 (100%)**. Không đụng tới kiến trúc, chỉ sửa các chỗ
đang âm thầm đánh rơi dữ liệu. Chạy `npm run eval:matching` để xem lại delta,
`npm run test:matching` để giữ các lỗi này không quay lại.

### 1. Xuống dòng trong kịch bản là mã chết (7/113 câu bị dán dính)

`split_sentences()` khai báo tách câu theo dấu kết thúc câu **hoặc xuống dòng**,
nhưng dòng đầu tiên đã `re.sub(r"\s+", " ", ...)` — gộp cả `\n` thành dấu cách
trước khi tách. Nhánh `\n+` trong regex không bao giờ khớp được nữa:

```python
split_sentences('Câu một không có dấu chấm\nCâu hai kết thúc đây.')
# cũ → ['Câu một không có dấu chấm Câu hai kết thúc đây.']
```

Kịch bản thật đầy những dòng không kết thúc bằng dấu chấm, nên hai dòng liền
nhau bị dán thành một "câu". Câu dán đó không bao giờ khớp trọn một vùng nói vì
người quay đọc chúng ở hai thời điểm khác nhau — đây là lý do `cov10` của Nanu
chỉ 0,424. Nay xử lý xuống dòng trước, chuẩn hoá khoảng trắng trong từng dòng
sau, và bóc luôn ký hiệu đầu mục (`1.` `2)` `-` `•`). Ký hiệu đầu mục bắt buộc có
khoảng trắng theo sau nên không xén nhầm câu mở đầu bằng số như "1,7g/100ml".

### 2. Câu ngắn bị nuốt không dấu vết

Bản cũ lọc `len(s.split()) >= 3`. Câu bị loại **không** lọt vào
`unmatched_sentences`, nên người dùng mất câu mà không có cách nào biết. Nay giữ
lại tất cả, đổi sang siết ở khâu chấp nhận — `_row_passes_sentence_gate()` áp
ngưỡng riêng theo độ dài câu (≤2 từ: sim ≥0,85 và coverage 1,0; 3–4 từ: 0,60 và
0,65; ≥5 từ: dùng ngưỡng chung). Câu ngắn dễ khớp bừa vì chỉ cần vài từ trùng,
nhưng nếu không khớp được thì giờ nó **được báo cáo** thay vì biến mất.

Ngưỡng coverage cho câu 3 từ cố ý để 0,65 chứ không 0,75: 0,75 hoá ra là "phải
khớp cả ba từ", trong khi "Có EPA ko?" được đọc thành "có EPA hay chưa".

### 3. Luật thép số học giết cả cặp khớp 0,92

`_check_number_consistency()` trả `False` là `_similarity()` trả thẳng **0.0** —
xoá sổ ứng viên. Mà bộ tách số của nó quy đổi chữ sang số trên **cả hai** văn
bản: `\bba\b → 3`, `\bnăm\b → 5`. "Ba mẹ" thành số 3, "năm nay" thành số 5. Chỉ
cần ASR nghe "ba mẹ" ra "bà mẹ" là chuỗi số hai bên lệch nhau:

```
"Ba mẹ nhớ bổ sung 2 loại canxi" ~ "bà mẹ nhớ bổ sung 2 loại canxi"   cũ: 0.0
```

Thay bằng `_number_consistency_factor()` trả hệ số nhân [0..1]. Hai thay đổi:

- **Chỉ quy đổi theo chiều số → chữ.** Lấy các con số viết bằng chữ số trong kịch
  bản rồi tìm chúng trong lời nói dưới dạng chữ số hoặc dạng đọc ("10 giờ" khớp
  "mười giờ"). Không còn biến "ba mẹ" thành số.
- **Phạt điểm thay vì loại.** Thiếu số phạt tới 0,70×; cặp "số N là M" sai giá
  trị phạt 0,65×; sai thứ tự 0,85×; khoảng giờ sai 0,75×. Cặp đúng số vẫn thắng
  cặp sai số vì khoảng cách tương đối còn rất lớn (1,0 so với 0,67), nhưng cặp
  sai số không còn biến mất.

`_token_coverage()` bỏ hẳn phần phạt số: nó là phép đo "bao nhiêu phần từ vựng
của câu có mặt", phạt ở cả hai chỗ là tính hai lần cùng một bằng chứng. Riêng
việc này kéo `cov10` của Nanu từ 0,424 lên 0,631.

Số 2,77 nay chuẩn hoá thành `2.77` chứ không dán liền thành `277` — kịch bản dinh
dưỡng đầy "1,7g / 2,77g / 3,36g", dán liền là mất đúng thông tin phân biệt chúng.

### 4. Một từ ASR nghe sai là mất take cuối

Trong `apply_last_best_take()`, băng "coi như ngang nhau" cố định ±0,05:

| take 2 khác take 1 ở | similarity | score | cũ chọn |
|---|---|---|---|
| không khác gì | 1,000 | 1,000 | take 2 ✅ |
| 1 chữ ("ngày"→"ngài") | 0,973 | 0,963 | **take 1** ❌ |
| thiếu 1 từ | 0,963 | 0,958 | **take 1** ❌ |

Một từ sai trên câu 16 từ tốn ~0,04 điểm, cộng thêm việc rớt khỏi mốc thưởng
`coverage ≥ 0.95` (+0,06) là vượt băng. Mà chênh lệch ASR giữa hai lần đọc chính
là thứ luật "lấy take cuối" bắt buộc phải dung thứ.

Hai sửa đổi:

- `_take_tolerance(sentence)` = `clamp(1.2 / số_từ, 0.08, 0.25)` — câu càng ngắn
  thì một từ sai càng nặng nên dung sai giãn ra theo.
- `_take_score_for_chunk()` là thang điểm **duy nhất** để xếp take. Bản cũ trộn
  hai thang trong cùng một danh sách: chunk có sub_segments thì lấy `score` tổng
  hợp (đã cộng thưởng, vượt được 1.0), chunk không có thì lấy thẳng `_similarity`
  (0..1), rồi so cả hai với cùng một ngưỡng 0,63. Nay cả hai nhánh dùng
  `base_score` (chưa cộng thưởng) — mấy khoản thưởng coverage sinh ra để chọn
  **biên cắt bên trong** một chunk, không phải để so chunk này với chunk kia.

Vẫn giữ đúng hành vi mong muốn ở chiều ngược lại: take sau đứt giữa chừng, hoặc
take sau là câu khác hẳn, thì giữ take đầu.

### 5. Chunk dài nuốt hàng khớp, và biên tinh bị vứt ở bước bàn giao

`mapped_chunks` — thứ duy nhất mà UI đọc — trả về **nguyên chunk** và tick chọn
khi hàng phủ quá 40% thời lượng chunk:

```python
if overlap / duration > 0.4:   # duration = thời lượng CHUNK
```

Chunk 24 giây chứa hai câu, mỗi câu khớp similarity 1,000, mỗi hàng phủ ~30%
chunk — không hàng nào đủ 40%, cả chunk không được tick, **cả hai câu biến mất
khỏi timeline**. Càng cắt biên chính xác thì càng dễ bị rớt. Trên dữ liệu thật:
12/106 câu đã khớp không tới được UI (Nanu 6, Hato 5, Baby Sun 1).

Cùng chỗ đó còn vứt luôn biên tinh: hàng tính ra 29,92–35,15 nhưng UI nhận
30,00–35,00 của chunk, và `/finalize-timeline` dựng timeline từ biên chunk. Mọi
cải tiến về biên cắt đều vô hình.

`_build_mapped_chunks()` thay bằng cắt chunk **tại biên hàng**: gom mọi mốc biên
(chunk + hàng), chia thành các mẩu nguyên tử, mẩu nào nằm trong hàng thì thành
mục đã tick mang đúng thời gian/điểm số của hàng, phần thừa đầu-đuôi thành mục
chưa tick để người dùng vẫn nhìn thấy và tick thêm nếu muốn. Mẩu dưới 0,02 giây
bỏ đi, mẩu chỉ bị hàng liếm qua dưới nửa thời lượng thì không tính là của hàng,
các mẩu liền kề cùng chủ được gộp lại. Chữ hiển thị lấy từ các từ thật sự nằm
trong khoảng, nên người duyệt thấy đúng cái sẽ được cắt.

Hợp đồng dữ liệu giữ nguyên (`start/end/text/is_selected/script_index/
script_text/similarity/score/merged_script_indices`) nên UI không phải sửa; chỉ
thêm `matched_text`, `token_coverage`, `loudness_dBFS`, `source_chunk_index`.
Cố ý **không** thêm khoá `chunk_index`: `hydrateTimelineRows()` trong index.html
ưu tiên so khớp theo `chunk_index`, mà giờ nhiều mẩu dùng chung một chunk nguồn
thì nó sẽ vớ nhầm mẩu đầu tiên.

`tests/scripts/backend_smoke.js` nay kiểm luôn hợp đồng này ở tầng HTTP: câu đã
khớp phải có mục được tick, và tổng thời lượng các mục được tick phải bằng tổng
thời lượng các hàng.

### Mã chết đã gỡ

`_NUMBER_WORD_PATTERNS` và `_extract_nums_cached()` (bảng quy đổi chữ → số gây
lỗi ở mục 3) không còn ai gọi. Gỡ hẳn thay vì để đó, vì đây đúng là loại tiện ích
dễ bị dùng lại nhầm.

Ghi chú: `_build_candidate_options_for_sentence()`, `_resolve_one_to_one_candidates()`
và `_is_candidate_accepted()` cũng là mã chết (không nhánh nào trong pipeline gọi
tới — `stats.dedupe_conflicts_resolved` vì thế luôn bằng 0). Giữ lại chờ Phase 3
xử lý cùng đợt thay lõi.

## Nạp tệp kịch bản .md ở tab "Kịch bản" (đã sửa 2026-08-21)

Tab "Kịch bản" là chỗ duy nhất trong Editing chưa đi qua hộp thoại gốc, và là chỗ
duy nhất có vùng nhận thả nhỏ hơn khu vực người dùng nhắm vào. Hai lỗi độc lập,
cùng dẫn tới cùng một triệu chứng "không thêm được tệp .md".

### Nút "Chọn tệp kịch bản" bấm vào `<input type=file>` ẩn của bước Upload

`[data-edit-script-pick]` gọi `document.getElementById('fileScriptInput').click()` —
tức mượn `<input>` nằm trong `#step0`, khối đang `display:none` khi dựng phim. Mọi
nút chọn tệp khác của Editing (`pickVideoSources`, `pickEditingAssets`,
`pickEditingAssetFolders`, `pickRelinkFile`) đều đi qua `dialog.showOpenDialog`.

Cái bẫy nằm ở `accept=".txt,.md,.doc,.docx"`: trên macOS, Chromium quy đổi phần mở
rộng trong `accept` sang UTI. Máy nào chưa đăng ký UTI cho Markdown thì NSOpenPanel
**làm mờ toàn bộ tệp .md** — hộp thoại mở ra bình thường nhưng không chọn được gì.
Đúng triệu chứng "không thêm được file .md", và giải thích vì sao chỉ .md dính.

Nay thêm `pick-script-file` (electron/main.js) + `desktopEnv.pickScriptFile`
(preload). Hộp thoại gốc nhận thẳng phần mở rộng nên không dính chuyện UTI. Nó trả
luôn **nội dung** chứ không chỉ đường dẫn — renderer chạy contextIsolation, không
nodeIntegration, nên không tự đọc được tệp: `.md/.markdown/.txt` trả `text`,
`.doc/.docx` trả `base64` để renderer dựng lại ArrayBuffer cho mammoth.

Renderer gom về một cửa duy nhất `window.pickScriptFile()`, dùng chung cho nút ở
bước Upload lẫn nút ở tab Kịch bản. Bản web vẫn rơi về `<input>` ẩn. `loadScriptFile()`
tách phần áp nội dung ra thành `applyScriptTextByExtension()` / `applyScriptWordBuffer()`
để hai đường (FileReader và hộp thoại gốc) dùng chung, không nhân bản logic. Thêm
`.markdown`, thêm MIME type vào `accept`, và xoá `input.value` sau mỗi lần chọn —
chọn lại đúng tệp cũ thì `change` không bắn, người dùng tưởng ứng dụng treo.

### Thả tệp trượt ra ngoài dải gợi ý là mất cả phiên làm việc

`bindScriptPane()` chỉ gắn `dragover`/`drop` lên `.edit-script-drop` — dải gợi ý cao
khoảng 30px. Ngay dưới nó là ô dán chữ chiếm gần hết chiều cao pane, mang sẵn dòng
chữ mời "Dán kịch bản vào đây, hoặc kéo thả tệp .md" — chỗ người dùng nhắm vào.
Thả trúng ô đó thì không handler nào nhận, và mặc định của Chromium/Electron là
**điều hướng tới tệp**: cả phiên dựng phim biến mất, thay bằng nội dung thô của tệp.

Hai lớp bảo vệ:

- Vùng nhận mở rộng ra cả pane. Bind vào `[data-edit-script-zone]` — node bọc mới
  tinh sau mỗi lượt `renderEditPanel()` — chứ không vào `#editPanelBody`, vì phần tử
  đó sống mãi và bind vào đó là chồng thêm một bộ listener mỗi lần đổi tab.
- Chốt chặn toàn cục ở `window` (index.html) nuốt `dragover`/`drop` cho mọi cú thả
  lạc. Chỉ chặn khi con trỏ **đang mang tệp** (`dataTransfer.types` chứa `Files`),
  nên kéo-thả nội bộ (sắp xếp block, kéo asset vào timeline) không bị đụng; và
  không `stopPropagation`, nên listener này chạy sau khi vùng nhận thật đã xử lý xong.

### Đã kiểm

Chạy UI thật qua `backend/server.js` và bắn sự kiện `drop` với `File` thật:

| tình huống | trước | sau |
|---|---|---|
| thả trúng dải gợi ý | nạp được | nạp được |
| thả trúng ô dán chữ | điều hướng, mất phiên | nạp được |
| thả lạc ra ngoài pane | điều hướng, mất phiên | bị chặn, không xảy ra gì |
| kéo-thả nội bộ (không mang tệp) | bình thường | bình thường (không bị chặn nhầm) |
| nút chọn tệp — bản web | `<input>` ẩn | `<input>` ẩn |
| nút chọn tệp — desktop | `<input>` ẩn (.md bị làm mờ) | hộp thoại gốc |

## So khớp kịch bản — Phase 2 mục 1: ngữ âm tiếng Việt + trọng số từ vựng (2026-08-21)

**Kết quả tóm tắt: take accuracy 88/113 → 89/113. Nằm trong nhiễu.** Phần dưới ghi
cả cái không đạt, vì đó mới là thông tin đáng giá cho các phase sau.

### Đã có nhãn nên mới đo được thứ cần đo

Người dùng duyệt xong `review.md` cả 6 case (113 nhãn). Baseline thật sau Phase 1:
**take accuracy 88/113 = 77,9%**, sai 25 câu, không sót câu nào.

Bảy chỗ người duyệt sửa lại đề xuất của máy đều theo cùng một hướng:

| máy đề xuất | người chốt |
|---|---|
| take 0 · cov 1.00 · sim 1.00 | take 1 · cov 0.79 · sim 0.93 |
| take 0 · cov 1.00 · sim 0.99 | take 1 · cov 0.85 · sim 0.88 |
| take 0 · cov 0.88 · sim 0.90 | take 1 · cov 0.77 · sim 0.89 |
| take 2 · cov 0.91 · sim 0.93 | take 4 · cov 0.73 · sim 0.88 |

7/7 lần chọn take MUỘN HƠN dù điểm văn bản THẤP HƠN. Chênh lệch điểm giữa hai take
chủ yếu là nhiễu ASR chứ không phải chất lượng diễn đạt.

### Ba thay đổi

**Khoá ngữ âm** (`_phonetic_key`) làm kênh similarity phụ, chiết khấu 0,97 nên chỉ
được NÂNG điểm, không bao giờ lấn át một cặp khớp nguyên văn. Áp lên dạng đã bỏ dấu
thanh — thứ ASR sai nhiều nhất. Giữ 6 luật phụ âm đầu (d/gi/r→z, tr→ch, s→x, ngh→ng,
gh→g, k,q→c) cộng y→i.

**Tập token dính liền**: thêm mọi cặp âm tiết liền kề đã nối lại. ASR tách/dính từ
ghép rất tuỳ hứng — "canxi"/"can xi", "Nanu"/"Na Nu" — mà `token_coverage` so theo
tập token thì hai cách viết đó giao nhau bằng KHÔNG.

**Trọng số từ vựng**: từ chức năng ("là / thì / của / và"…) tính 0,3, từ nội dung
tính 1,0. Đây là xấp xỉ IDF bằng bảng tĩnh, không phải IDF thật: `_similarity()` là
hàm thuần có `lru_cache`, luồn ngữ liệu từng lượt chạy qua nó thì phải bỏ cache và
mang trạng thái toàn cục. IDF thật thuộc Phase 3, nơi bộ chấm điểm có sẵn ngữ liệu.

Đo được trên các cặp CÓ THẬT trong dữ liệu (đã khoá bằng `npm run test:matching`):

| cặp | coverage trước | sau |
|---|---|---|
| "mỗi ngày" / "mỗi ngài" | 0.89 | 1.00 |
| "trứng" / "chứng" | 0.88 | 1.00 |
| "tỷ lệ" / "tỉ lệ" | 0.88 | 1.00 |
| "canxi" / "can xi" | 0.86 | 1.00 |
| "Nanu" / "Na Nu" | 0.80 | 1.00 |

### Cái KHÔNG đạt, và luật đã bỏ đi

Sáu cấu hình đo trên bộ dữ liệu vàng:

| cấu hình | take |
|---|---|
| ngữ âm đủ luật + trọng số | 87/113 |
| ngữ âm đủ luật, không trọng số | 87/113 |
| **phụ âm đầu (bỏ l→n) + trọng số** | **89/113** |
| phụ âm đầu (bỏ l→n), không trọng số | 88/113 |
| không ngữ âm, có trọng số | 88/113 |
| không ngữ âm, không trọng số | 89/113 |

Toàn bộ dải là 87–89 trên 113 — chênh lệch không vượt nhiễu. Bỏ khỏi bảng luật:

- **l → n** (giọng Bắc bộ): đo ra LÀM TỆ ĐI một câu. Nó gộp toàn từ siêu phổ biến
  ("là/nà", "lại/nại", "lo/no") nên kéo điểm của cả ứng viên sai lên theo.
- **ng$→n, nh$→n, c$→t, ch$→t** (phụ âm cuối, giọng Nam): trung tính tuyệt đối,
  không sửa được câu nào trong bộ vàng. Không giữ mã không có bằng chứng — gặp giọng
  Nam mà hỏng thì thêm lại KÈM một case trong bộ dữ liệu vàng.

Chi phí: nanu (11,7 phút audio) từ 4,6s lên 6,9s, do mỗi cặp phải chạy thêm hai lượt
rapidfuzz cho chuỗi ngữ âm. Chấp nhận được với một bước chạy một lần mỗi dự án.

### Kết luận cho các phase sau

Giả định của Phase 2 — "tín hiệu tốt hơn thì so khớp tốt hơn" — **không đúng với nút
thắt hiện tại**. Similarity đã đủ tốt: sim50 quanh 0,88–0,97, và các cặp lỗi ASR nay
khớp gần tuyệt đối. Cái quyết định take nào thắng là CHÍNH SÁCH CHỌN, không phải
thang điểm.

Bằng chứng rõ nhất là bap_kids: 37,5% (10/16 sai) và **không nhúc nhích qua cả Phase
1 lẫn Phase 2**. Dự án đó đọc lại toàn bộ kịch bản lần hai; người dựng muốn lấy trọn
lượt sau, còn hệ thống quyết từng câu một nên ra timeline chắp vá nửa lượt này nửa
lượt kia. Không thang điểm nào chữa được — chỉ có prior "take cuối" đủ nặng cộng ràng
buộc liên tục theo lượt đọc (Phase 3–4) mới chữa được.

Khoá ngữ âm vẫn giữ lại vì Phase 3 cần nó để gieo mầm ứng viên: chỉ mục shingle phải
chịu được sai lệch ASR, nếu không thì có take mà không tìm ra.

## So khớp kịch bản — Phase 4a: chọn take toàn cục (2026-08-21)

**take accuracy 89/113 (78,8%) → 104/113 (92,0%).** Đây là phase đầu tiên chạm đúng
nút thắt. Phase 1 sửa chuyện mất câu, Phase 2 cải thiện thang điểm nhưng take accuracy
đứng yên — vì vấn đề chưa bao giờ nằm ở thang điểm.

| case | Phase 2 | Phase 4a |
|---|---|---|
| bap_kids | 37,5% | **100%** |
| hato | 86,7% | 96,7% |
| nanu | 80,0% | 88,0% |
| baby_sun | 100% | 100% |
| baby_love | 90,9% | 90,9% |
| nem_house | 63,6% | 63,6% |

### Nguyên nhân gốc: cửa sổ tìm kiếm mù

`apply_last_best_take()` chỉ dò take trong `[prev_anchor - 2, next_anchor + 1]` chunk
quanh mỏ neo Needleman-Wunsch (hoặc 18 giây khi cả kịch bản chỉ có một mỏ neo).

NW là thuật toán căn chỉnh **đơn điệu**. Khi người quay đọc lại cả kịch bản, NW neo
trọn bộ vào MỘT lượt đọc — và mọi lượt khác nằm ngoài tầm với. Đo trực tiếp trên
bap_kids: NW neo toàn bộ vào lượt 1 (chunk 2–14) trong khi nhãn nằm ở lượt 2 (chunk
23–36), **9/16 câu có take đúng nằm hoàn toàn ngoài cửa sổ**. Đáp án đúng chưa từng
được đưa ra cân nhắc, nên không thang điểm nào chữa được — đúng như số liệu đã cho
thấy: bap_kids đứng yên 37,5% qua cả Phase 1 lẫn Phase 2.

### Kiến trúc mới: sinh ứng viên toàn cục → chấm điểm → DP chọn

**`build_similarity_matrix()`** — tách riêng ma trận m×n để NW và khâu lọc thô ứng
viên dùng chung. Đây là phần đắt nhất của pipeline, không tính hai lần.

**`build_take_candidates()`** — với mỗi câu, lọc thô toàn bộ chunk bằng ma trận
(ngưỡng 0,35) rồi mới chạy phép dò span mức từ trên số ít chunk còn lại. Gộp các ứng
viên chồng nhau quá 60%, cắt còn tối đa 8, rồi gán **hạng thời gian** cho từng ứng
viên — "đây là lần đọc thứ mấy". Không còn cửa sổ nào cả.

**`select_takes_globally()`** — quy hoạch động trên (câu × ứng viên), ba thành phần:

| thành phần | vai trò |
|---|---|
| `score` | chunk này đọc câu đó tốt đến đâu (0,55·sim + 0,35·cov + 0,10·độ to) |
| `recency` | prior "take cuối thường là bản tốt", trọng số 0,18 |
| `continuity` | thưởng khi đi tiếp trong cùng lượt đọc; phạt khi nhảy ngược; **cấm** dùng chồng audio |

Thưởng liên tục làm khái niệm "lượt đọc" **tự nổi lên** mà không cần dò lượt tường
minh: chuỗi nào đi liền mạch theo thời gian thì cộng dồn được nhiều thưởng hơn, nên
cả một lượt tốt thắng trọn gói thay vì quyết rời rạc từng câu. Quyết từng câu là cách
chắc chắn tạo timeline chắp vá — câu 10 lấy lượt hai, câu 11 lấy lượt đầu, người xem
nghe giọng nhảy tới nhảy lui.

Một DP này thay thế `apply_last_best_take()`, bước ép đơn điệu, và hậu kiểm overlap.

### Dò trọng số: cao nguyên rộng, không phải đỉnh nhọn

Lưới 80 cấu hình trên 113 nhãn, chấm trực tiếp trên đầu ra của DP:

```
recency  0.00 ->  67/113      continuity  0.00 ->  98/113
recency  0.05 ->  80/113      continuity  0.04 -> 100/113
recency  0.08 ->  88/113      continuity  0.12 -> 100/113
recency  0.12 ->  97/113      continuity  0.18 -> 100/113
recency  0.18 -> 100/113      continuity  0.25 ->  98/113
recency  0.22 -> 100/113      continuity  0.40 ->  97/113
recency  0.40 ->  99/113
recency  1.00 ->  98/113
```

Prior "take cuối" **một mình đáng 33 điểm** (67 → 100). Cả hai đường cong đều là cao
nguyên rộng — recency 0,15–0,60 cho 98–100, continuity 0,04–0,18 cho 100 — nên giá
trị chốt (0,18 / 0,12) nằm giữa vùng phẳng chứ không phải khớp mép dữ liệu.

`TAKE_W_BACKJUMP` đo ra **hoàn toàn trung tính** (0,0 đến 0,45 cho kết quả y hệt): ràng
buộc cấm-chồng-audio đã chặn sẵn các ca xấu, và cả 6 dự án đều đọc gần đúng thứ tự.
Giữ lại như một chốt chặn thứ tự — khác với các luật ngữ âm bị gỡ ở Phase 2, nó là ba
dòng trong hàm chuyển trạng thái, không tốn thời gian chạy và không đụng tới điểm số
của bất kỳ cặp nào.

### 9 câu còn sai

Hai loại khác hẳn nhau:

- **2 câu chọn ĐÚNG vùng nhưng bị cắt cụt** (hato #9 lấy 130,9–136,0 trong khi nhãn
  121,5–135,8; baby_love #1 phủ 48% — trượt ngưỡng 50% trong gang tấc). Đây là lỗi
  RANH GIỚI, không phải lỗi chọn take.
- **7 câu chọn nhầm vùng thật**, dồn ở nem_house (4) và nanu (3) — hai dự án nội dung
  lặp đi lặp lại nhiều nhất (nem_house 3,6 ứng viên/câu). Đáng chú ý là chúng lệch về
  **hai phía**: nanu #14 và #24 chọn MUỘN hơn nhãn, còn nem_house #2 chọn SỚM hơn. Một
  hệ số recency vô hướng không thể sửa cả hai chiều — cần đặc trưng chất lượng take
  tốt hơn (Phase 2 mục "giữ confidence ASR").

Đã thử dựng hàng thẳng từ span của ứng viên thay vì dựng lại từ chunk: **không đổi một
con số nào**, vì `_rematch_shared_chunk_intervals()` phía sau vốn đã tính lại span.
Đã hoàn nguyên. Việc cắt cụt nằm ở `_merge_close_or_overlapping_rows()` (gộp mọi hàng
cách nhau dưới 0,8 giây, mà lời nói liên tục thì hàng nào cũng thoả) — thuộc Phase 5.

### Mã chết đã gỡ (~330 dòng)

`apply_last_best_take()` cùng `_take_tolerance()`, `_take_score_for_chunk()` (chỉ nó
dùng), và bộ ba đã chết từ trước: `_is_candidate_accepted()`,
`_build_candidate_options_for_sentence()`, `_resolve_one_to_one_candidates()`. Đây là
lý do `stats.dedupe_conflicts_resolved` bấy lâu luôn bằng 0.

## So khớp kịch bản — Phase 5: ranh giới cắt (2026-08-21)

**Điểm cắt rơi vào giữa một từ: 26/128 (20%) → 0/128. Lề trung bình 83ms → 104ms.**
take accuracy giữ nguyên 104/113.

### Chẩn đoán lật ngược cả giả thuyết lẫn thước đo

Kế hoạch ban đầu ghi "bước gộp hàng nuốt nội dung, dư 20 giây audio". Đo ra thì
ngược: hàng gộp bám nhãn khít trong 0,2 giây — đúng bằng lượng đệm cứng. **Chỉ số
`dư(s)` mới là thứ sai**: nó so một hàng gộp nhiều câu với nhãn của TỪNG CÂU một.
nanu gộp 27 câu thành 12 hàng, nên một hàng đúng bị báo "dư 20 giây".

Đã sửa `score_against_labels()`:

- Sai số biên đo theo **HÀNG**, tham chiếu là HỢP các khoảng nhãn mà hàng đó gộp.
- Chỉ đo biên trên hàng đã chọn đúng vùng — hàng chọn nhầm take thì sai số biên vô
  nghĩa và trộn vào sẽ che mất chất lượng biên thật.
- Tách `dư90` / `thiếu90` / `Δđầu90` / `Δcuối90` thay cho một cột `dư` gộp chung.
- Tiêu chí "đúng take" chia theo khoảng NGẮN HƠN thay vì chia theo nhãn.

Điểm cuối cần giải thích, vì nó nghe như nới lỏng để lấy điểm. Lý do: **nhãn không
đủ chính xác về BIÊN**. Bộ dò ứng viên dựng phiếu duyệt quét cửa sổ trượt theo F1
nên hay vơ thêm mấy từ đầu thừa, và người duyệt chỉ chọn *vùng nào*, không chỉnh
biên. Ca rõ nhất là nem_house #7: nhãn dài 17,4s ôm trọn 8,9 giây nói lắp phía trước
("yêu cầu nguyên liệu chất lượng *yêu cầu nguyên liệu chất lượng* cao hơn Vô cầu mưa
bệnh chứ nãy…"), còn pipeline lấy đúng 8,5 giây bản đọc sạch. **Hàng đúng hơn nhãn**,
mà tiêu chí cũ chấm nó là sai. Chia theo khoảng ngắn hơn thì take% trả lời đúng câu
hỏi "có chọn đúng vùng không", còn "đúng độ dài chưa" đã có bốn cột kia đo riêng.
Kiểm chứng là thước đo mới KHÔNG nới lỏng: chấm lại cấu hình cũ vẫn ra đúng 104/113.

### Thước đo khách quan, không cần nhãn

Vì nhãn không tin được ở mức biên, Phase 5 lái theo một tiêu chí không cần nhãn:
**điểm cắt có rơi vào giữa một từ không**. Đây đúng thứ người xem nghe thấy — âm tiết
bị chém cụt. Đo trên bộ vàng: 26/128 điểm cắt (20%) nằm giữa một từ.

### `_snap_rows_to_word_boundaries()`

Thay lối đệm mù cũ (trừ cứng 0,08s đầu, cộng cứng 0,15s cuối). Đệm một hằng số thì
không biết gì về chỗ mình đang cắt.

1. **Mở ra biên từ trọn vẹn.** Từ nào bị điểm cắt xén ngang thì lấy trọn, vì nó đã
   nằm trong đoạn được chọn rồi.
2. **Chừa lề, giới hạn bởi nửa khoảng lặng kề bên.** Khoảng lặng rộng thì được trọn
   lề (0,12s đầu / 0,18s cuối — giữ hơi thở, giữ độ vang); khoảng lặng hẹp thì lề co
   lại để không liếm sang từ của câu bên cạnh. Cắt giữa khoảng lặng là vị trí tối ưu
   khi mốc thời gian của Whisper vốn có sai số ±50ms.

### Đã gỡ "nam châm hút biên chunk"

`_rematch_shared_chunk_intervals()` có đoạn: span tìm được nằm trong 1,0 giây tính từ
đầu/cuối chunk thì bắt dính luôn vào mốc chunk. Biên chunk là sản phẩm phụ của ASR,
không phải đơn vị ngôn ngữ — sau khi đã bám biên từ thì phép hút này chỉ còn là nong
bừa tối đa 1 giây về cả hai phía. Chính nó nong hàng nem_house #7 ra ôm cả đoạn nói
lắp.

Gỡ đi: take% **không đổi** (104/113), biên khít hơn hẳn ở 4/6 case (nanu `dư90`
1,02→0,30; nem_house `thiếu90` 8,03→0,00; baby_sun `Δcuối90` 0,40→0,18).

Đổi lại, bap_kids #2 lộ ra một khiếm khuyết mà nam châm vẫn che: hàng gộp câu 0+1+2
kết thúc ở 172,86 trong khi câu 2 chạy tới 175,85 — **hụt 3 giây ở câu cuối**. Gốc rễ
nằm ở `_rematch_shared_chunk_intervals()`: các hàng dùng chung một chunk được chia
span kiểu tham lam, câu ngắn chia trước, nên câu cuối bị cắt cụt. Cách chữa đúng là
chia span ĐỒNG THỜI cho cả nhóm chứ không phải nong bừa — để Phase 3 làm cùng đợt
thay lõi. Không giữ lại nam châm chỉ để giấu nó.

## So khớp kịch bản — Phase 6: rà soát và đổi lần đọc (2026-08-21)

Đo trên bộ dữ liệu vàng: ~8% số câu là **ca mơ hồ thật sự** — điểm giữa ứng viên
đúng và ứng viên sai chênh nhau chưa tới 0,04, có ca bằng nhau tới số lẻ thứ ba, và
lệch về cả hai phía nên không hằng số nào chỉnh được. Máy không thể tự quyết đúng
những ca đó. Việc cần làm là đưa chúng ra cho người quyết bằng một cú bấm.

### Đã bác bỏ: bóc băng lại để lấy độ tin cậy ASR

Trước khi bỏ hàng giờ GPU bóc băng lại 5 dự án (mục còn nợ của Phase 2), thử một
phép đo rẻ: `quality_decision`/`quality_flags` vẫn còn trong cache và được sinh ra từ
chính `avg_logprob` / `no_speech_prob` / `compression_ratio`. Với 6 câu mà DP chọn
sai, so cờ chất lượng của ứng viên đã chọn với ứng viên đúng:

```
case         câu |  ĐÃ CHỌN (sai)          |  ĐÁNG RA (đúng)
                 |  cờxấu   điểm  recency  |  cờxấu   điểm  recency
nanu          14 |   0.00   0.887    1.00  |   0.00   0.849    0.00
nanu          16 |   0.00   0.950    0.00  |   0.00   0.950    1.00
nem_house      1 |   0.00   0.646    1.00  |   0.13   0.660    0.00  <- chỉ NGƯỢC
```

**Chỉ đúng hướng 0/6 ca, một ca chỉ ngược.** Không bóc băng lại nữa — đó là hàng giờ
GPU cho một loại dữ liệu vừa chứng minh là không phân biệt được ở đây.

### Sửa trước một lỗi Phase 1 để lại: UI và backend đánh số câu lệch nhau

`renderReferenceScriptViewer()` trong index.html tự tách câu bằng luật riêng, trong đó
có bộ lọc `wordCount >= 3`. Phase 1 đã bỏ bộ lọc đó ở phía Python. Hệ quả: kịch bản có
một câu "Đúng vậy." là **mọi số hiệu câu phía sau lệch đi một**, và `script_index` /
`merged_script_indices` mà backend trả về trỏ nhầm câu — im lặng, không lỗi nào bắn ra.

Đã đồng bộ `splitScriptDisplayPieces()` với `split_sentences()` (tách theo dòng trước,
bóc ký hiệu đầu mục, giữ mọi câu) và khoá bằng một test **đối chiếu thẳng hai ngôn
ngữ**: chạy bản JS moi từ index.html qua node, chạy bản Python, so từng câu trên 4
kịch bản mẫu + cả 6 kịch bản trong bộ vàng.

Test đó lập tức bắt được một khác biệt nữa: **BOM**. `String.prototype.trim()` của JS
coi U+FEFF là khoảng trắng nên loại nó, Python thì giữ lại trong câu đầu. Tệp .md xuất
từ Word/Google Docs dính U+FEFF rất thường. Đã loại BOM trong `split_sentences()`.

### Backend: `sentence_takes` và `pinned_takes`

`deterministic_filter_pipeline()` nay trả thêm `sentence_takes` — với mỗi câu kịch
bản: trạng thái khớp, điểm của hàng đang dùng, và **mọi lần câu đó được nói** kèm cờ
lần nào đang được chọn. Danh sách này hệ thống vốn đã tính để chọn take; trước đây nó
chết trong bộ nhớ.

Chiều ngược lại là `pinned_takes` (`{chỉ số câu: chỉ số take}`), đi qua
`/api/filter` → sidecar → `select_takes_globally()`. Câu đã ghim thì DP chỉ còn đúng
một lựa chọn cho câu đó, **các câu còn lại vẫn chạy lại bình thường**: ghim một câu
sang lượt đọc khác thì thưởng liên tục kéo theo cả cụm quanh nó, và ranh giới lẫn
bảng phân đoạn phải dựng lại cho khớp. Đó là lý do ghim rồi chạy lại cả pipeline chứ
không sửa tay một hàng trong kết quả cũ.

### UI: trạng thái từng câu + bộ chọn lần đọc

Ô "Kịch bản chuẩn (Đối chiếu)" nay tô trạng thái mỗi câu (không tìm thấy / khớp yếu /
có nhiều lần đọc), kèm một dòng tóm tắt và nhãn `take k/n` bấm được để mở danh sách
các lần đọc — mỗi lần hiện mốc thời gian, % giống, % đủ từ và nguyên văn ASR nghe
được. Chọn một lần khác là ghim và chạy lại; có cả mục "bỏ chốt, để máy tự chọn lại".

Hai cái bẫy đã vấp phải khi làm và cách xử lý:

- **Hàm trùng tên.** Bản `formatTimecode(seconds)` mới trùng tên với
  `formatTimecode(sec, fps)` sẵn có ở phía dưới cùng tệp; khai báo hàm sau đè lên khai
  báo trước, im lặng. Đã đổi thành `formatClock()`.
- **Trang trí bị lượt vẽ lại xoá sạch.** `syncReferenceScriptViews()` vẽ lại ô đối
  chiếu sau mỗi lần kịch bản đổi và còn hoãn 120ms, nên trang trí một lần sau khi lọc
  thì lượt vẽ kế tiếp xoá hết nhãn take. Đã chuyển `applyScriptMatchStatus()` vào cuối
  chính `renderReferenceScriptViewer()` — vẽ lại bao nhiêu lần cũng đúng.

Đã kiểm bằng cách chạy UI thật với dữ liệu dự án nanu: 27 câu, 19 nhãn take, mở bộ
chọn, đổi sang lần đọc khác → hàng dời từ 62,49–78,08 sang 349,49–351,79, nhãn đổi
thành "take 2/4", dòng tóm tắt ghi "1 câu bạn đã tự chốt". Trang trí sống sót qua một
lượt `syncReferenceScriptViews()` cưỡng bức.

## So khớp kịch bản — Phase 7: chốt một bộ so khớp duy nhất (2026-08-21)

`native/addon/src/core_c.cpp` **1279 → 258 dòng**. Gỡ toàn bộ bản cài đặt song song
của pipeline so khớp.

### Vì sao gỡ chứ không đồng bộ

Addon C++ từng chứa `filterTimeline` — một bản cài đặt thứ hai của gần như cả pipeline:
`SplitSentences`, `ParseTranscriptText`, `PreprocessTranscriptSegments`,
`AlignSequenceNeedlemanWunsch`, `ApplyLastBestTake`, `SubsegmentSpanCandidates`,
`RematchSharedChunkIntervals`, `MergeCloseOrOverlappingRows`, cùng cả một bộ đo
similarity riêng (Levenshtein tự viết, bảng bỏ dấu tiếng Việt riêng). Bật bằng biến
môi trường `MATCHING_ENGINE=cpp`.

Bản đó dừng lại ở 2026-05. Trong khi đó bản Python đi qua Phase 1, 2.1, 4a, 5, 6 — và
`apply_last_best_take()` mà bản C++ vẫn đang chạy thì **đã bị xoá hẳn** khỏi bản
Python vì đo ra là sai: lối chọn take theo cửa sổ quanh mỏ neo Needleman-Wunsch chỉ
đạt 37,5% trên dự án có đọc lại cả kịch bản (9/16 câu có take đúng nằm ngoài cửa sổ),
so với 100% của bản hiện tại.

Nên đây không phải "bản C++ hơi cũ" mà là **một biến môi trường âm thầm đổi hẳn sang
thuật toán đã biết là sai**. Đưa nó về ngang bản Python nghĩa là port lại ~800 dòng
logic mới sang C++ rồi phải làm hai lần cho mọi thay đổi sau này — mà lịch sử của
chính tệp này cho thấy lần thứ hai không bao giờ được làm.

### Còn giữ lại gì

Addon vẫn là chỗ đúng cho hai việc nặng về tính toán, và cả hai đều KHÔNG có bản thứ
hai ở đâu khác:

| hàm | dùng ở |
|---|---|
| `extractAudioPeaks` | sinh sóng âm (.pk) |
| `finalizeTimeline` | `/api/finalize-timeline` — dựng EDL/XML từ các mục người dùng đã tick |

Kèm theo là các tiện ích mà riêng hai hàm đó cần: `Row`, `NapiNumber/Int/String`,
`ReadRowsFromSelectedChunks`, `RowToObject/RowsToArray`, `MergedIndicesToNapi`,
`SecondsToTimecode`, `EscapeXml`, `BuildEdl`, `BuildTimelineXml`, `Trim`. Build sạch,
không còn cảnh báo hàm thừa.

### Kèm theo

- `runMatchingPipeline()` trong backend/server.js không còn rẽ nhánh; biến
  `MATCHING_ENGINE` đã hết tác dụng và bị gỡ khỏi cả `backend_smoke.js`.
- `tests/scripts/native_smoke.js` viết lại: kiểm `extractAudioPeaks` +
  `finalizeTimeline` (kể cả luật `script_index = -1` kế thừa chỉ số hàng trước, và
  việc biên đi qua nguyên vẹn không bị làm tròn — từ Phase 5 đó là biên đã bám mép từ),
  và **khẳng định `filterTimeline` phải bằng `undefined`** để không ai lặng lẽ thêm lại.
- Gỡ `stats.dedupe_conflicts_resolved` — luôn bằng 0 kể từ khi các hàm sinh ra nó chết
  (đã gỡ ở Phase 4a).
- `docs/APP_STRUCTURE.md` mô tả lại vai trò `core_logic.py`, `python_filter_sidecar.py`
  và `native/addon`.

### Nợ còn lại của cả đợt

- **Chia span đồng thời cho các hàng dùng chung một chunk.** `_rematch_shared_chunk_intervals()`
  chia kiểu tham lam, câu ngắn chia trước, nên câu cuối trong nhóm bị cắt cụt
  (bap_kids #2 hụt 3 giây). Đây là phần duy nhất của Phase 3 còn giá trị — tầng chọn
  ứng viên và tầng quyết định đã làm xong ở Phase 4a.
- **`npm test` đang đỏ sẵn ở `test:retouch-export`** (`"c.svg" KHÔNG phải nguồn hình —
  phải bị từ chối`). Đã kiểm trên bản HEAD sạch: hỏng từ trước đợt này, không liên
  quan tới so khớp.

## So khớp kịch bản — món nợ cuối: câu bị chunk cắt làm đôi (điều tra 2026-08-22)

**KHÔNG sửa được sạch trong kiến trúc hiện tại. Mã đã hoàn nguyên về trạng thái Phase 7
(104/113).** Ghi lại đây để người sau khỏi đi lại bốn ngõ cụt này.

### Nguyên nhân thật khác với điều kế hoạch giả định

Kế hoạch ghi món nợ này là "chia span kiểu tham lam trong nhóm hàng dùng chung một
chunk, câu ngắn chia trước nên câu cuối bị cắt cụt". Đo ra thì không phải:

```
câu | chunk | span chọn        | nhãn             | chunk trải
  0 |    23 | 160.04-165.52    | 160.04-164.80    | 157.52-169.34
  1 |    23 | 165.52-169.34    | 165.52-169.34    | 157.52-169.34
  2 |    24 | 169.82-172.86    | 169.82-175.85    | 169.82-173.10   <-- MỘT MÌNH
  3 |    25 | 175.96-179.58    | 175.96-179.58    | 174.09-185.94
```

Câu 2 **ở một mình trong chunk 24**, không tranh chấp với ai. Cái cắt cụt nó là chính
**biên chunk**: chunk kết thúc ở 173,10 còn câu chạy tới 175,85. `preprocess_transcript_segments()`
cắt chunk theo quãng lặng 0,35 giây — đó là **ranh giới ÂM THANH, không phải ranh giới
câu**. Người đọc hít một hơi giữa câu là câu bị chẻ đôi, và vì ứng viên take được dò
TRONG từng chunk nên không ứng viên nào phủ nổi cả câu. Không thang điểm nào cứu được:
nửa còn lại của câu nằm ngoài tầm nhìn.

### Bốn cách đã thử, cách nào cũng chỉ đổi lỗi này lấy lỗi khác

| cách làm | take | ghi chú |
|---|---|---|
| mốc Phase 7 | **104/113** | bap_kids `thiếu90` 2,99 |
| chia span đồng thời cho cả nhóm (DP phân hoạch) | 103/113 | **không đụng tới ca mục tiêu** — nó có tranh chấp đâu |
| nới ứng viên qua mối nối, tối đa 2 chunk mỗi bên | 103/113 | `thiếu90` về 0 khắp nơi, nhưng `dư90` tăng và chậm gấp 3 |
| nới theo SỐ TỪ (12 từ mỗi bên) | 104/113 | ca mục tiêu sạch, nhưng hato `dư90` 0,56→5,05, chậm 1,7× |
| nới có điều kiện (chỉ khi chunk không phủ nổi) | 101/113 | tệ nhất |

Cách thứ tư là cách gần được nhất, nhưng "hato `Δđầu90` 3,08" nghĩa là có hàng bắt đầu
sớm 3 giây, tức ôm luôn 3 giây của câu trước — nghe rõ mồn một, và tệ ngang cái nó vừa
chữa. Đổi một lỗi nghe được lấy một lỗi nghe được thì không phải là sửa.

Nới vô tư hỏng ở chỗ: mấy từ cuối của chunk trước rất hay là một lần nói lắp hoặc phần
đuôi câu bên cạnh có từ ngữ na ná, nên đoạn lấy ra trôi ngược về phía trước.

### Cả bộ dò để gắn cờ cảnh báo cũng không dùng được

Ý tiếp theo là thôi không tự sửa, chỉ **làm cho lỗi hiện ra** để người dùng đổi bằng bộ
chọn take của Phase 6. Dấu hiệu tự nhiên: span kết thúc đúng ngay biên chunk mà coverage
lại dưới 0,90.

Đo trên bộ vàng: **gắn cờ 31/113 hàng để bắt được 7/13 ca cụt thật** — chính xác 23%,
bỏ sót một nửa. Badge kiểu đó chỉ dạy người dùng bỏ qua badge. Không ship.

### Cách sửa đúng

Sinh ứng viên trên **dòng từ TOÀN CỤC** thay vì trong từng chunk — đúng thiết kế
seed-and-extend của Phase 3 nguyên bản. Khi ứng viên được dò bằng cách gieo mầm shingle
rồi nới ra hai phía trên một dòng từ liền mạch cả video, thì biên chunk **thôi tồn tại
như một ràng buộc**, và câu này khớp trọn vẹn mà không cần luật nới nào.

Đó là phần duy nhất của Phase 3 còn giá trị — tầng chấm điểm và tầng quyết định đã làm
xong ở Phase 4a. Nhưng nó là một khối việc riêng, không phải một miếng vá, nên để nguyên
đó thay vì nhét một bản vá làm xáo lỗi.

## Sắp xếp timeline theo kịch bản (2026-08-22)

Icon `#btnScriptReorder` trên thanh công cụ Timeline, đứng ngay sau icon phễu
`#btnScriptFilter`, **chỉ khả dụng ở `step3`** (`currentStepId === 'step3' && currentMode
=== 'FINAL'`, cần ≥2 block và có kịch bản). Bấm vào thì bày ra bảng xem trước; bấm "Áp
dụng" mới đổi timeline, và một `Ctrl+Z` hoàn tác cả lượt.

### Vì sao cần

`latestTimeline` ở giai đoạn Timeline nằm theo **thứ tự thời gian của video**, không theo
thứ tự kịch bản. `#btnApplyAndReorder` gửi `globalMappedChunks.filter(is_selected)` — mảng
dựng dọc trục thời gian — sang `/api/finalize-timeline`, và `FinalizeTimeline` trong native
addon trả lại **nguyên thứ tự đầu vào** dưới cái tên gây nhầm `timeline_script_order`:

```cpp
// native/addon/src/core_c.cpp:241-243
std::vector<Row> rows = ReadRowsFromSelectedChunks(input.Get("selected_chunks"));
result.Set("timeline_script_order", RowsToArray(env, rows));   // KHÔNG sort
```

Câu Hook quay ở giữa video vì thế phải kéo-thả sắp lại tay. Với clip dài, một block còn
chứa nội dung của nhiều câu — sắp thế nào cũng không đúng nếu không cắt nhỏ.

### BẢN ĐẦU SAI HOÀN TOÀN TRÊN DỰ ÁN THẬT — bốn nguyên nhân, đo được cả bốn

Bản đầu tin dữ liệu mà renderer có sẵn ở `step3`. Đo trên dự án thật của người dùng
(17 câu kịch bản, 10 block đã tick — đã lưu thành `tests/fixtures/reorder/wellmune.json`):

1. **`mapped_chunks` KHÔNG mang `sub_segments`** — 0/27 mục có. Ở `step3` không có mốc thời
   gian từ nào thật; `ensureTimelineWords()` phải bịa mốc chia đều theo số từ, nên mọi điểm
   cắt tính từ đó đều rơi sai chỗ.

2. **`item.text` bị nhân 2–3 lần** — 9/10 block, ví dụ 78 từ cho 26 từ audio. Đây là lỗi
   thật trong `_build_mapped_chunks`: mỗi mẩu lấy `text_in_range(start, end)` **hoặc rơi về
   `matched_text` của CẢ HÀNG** khi mẩu đó không chứa từ nào (biên mẩu rơi vào quãng lặng),
   rồi bước gộp mẩu liền kề nối chúng lại → hàng bị chẻ 3 mẩu cho ra 3 bản sao của cùng một
   câu (26+26+26=78). **Đã sửa**: fallback chỉ được dùng khi mục ĐÃ GỘP XONG mà vẫn rỗng.
   Lỗi này còn làm hỏng chính transcript người dùng nhìn thấy ở `step2`/`step3`.

3. **Nhãn `script_index` bị ĐIỀN TRƯỢT** — `ReadRowsFromSelectedChunks` gán nhãn của block
   trước cho block không có nhãn, biến đếm khởi tạo 0 (`core_c.cpp:172-174`), nên `-1` gần
   như không bao giờ xuất hiện và mẩu người dùng tự tick thêm ở `step2` mang nhãn trùng
   block liền trước. `merged_script_indices` thì bị làm phẳng còn 1 phần tử
   (`core_c.cpp:184`), còn `similarity`/`token_coverage`/`score` mặc định 1.0 khi vắng
   (`core_c.cpp:181-183`) nên vô dụng làm tín hiệu tin cậy.

4. **Đường tụt hạng phá hoại.** Bản đầu có nhánh "backend không tới được thì tụt về tin nhãn
   `script_index` sẵn có". Trên dự án thật, nhánh đó cho ra **`câu 13` rồi 9 block LẠC dồn
   xuống cuối** — đúng thứ người dùng thấy. Đây là bài học thiết kế: một tính năng sắp xếp
   thà **báo lỗi và không đổi gì** còn hơn tụt xuống một kết quả tệ trông như đã chạy xong.

### KHÔNG bóc băng lại audio đã NỐI các khoảng rời

Cách chữa đầu tiên là bóc băng lại để có mốc từ thật — đúng hướng, nhưng lần đầu làm bằng
`/api/magic-fill/transcribe-range`, mà endpoint đó `atrim` từng khoảng rồi `concat`. Đo trên
dự án thật:

| Nguồn mốc từ | Từ thu được | Kết quả so khớp |
|---|---|---|
| Bóc băng **cả video** rồi cắt theo khoảng | **243 từ**, thật hết | **10/10 block, 17/17 câu** |
| Bóc băng lại các khoảng **đã nối** (64,78s) | 157 từ, ~60 từ ảo giác | 7/17 câu, 5 block lạc |

Mối ghép giữa hai khoảng rời là **điểm gián đoạn giả**: VAD chia cụm thoại sai ở đó rồi
Whisper lấp chỗ trống bằng câu mẫu quen tay — nguyên văn ASR trả về
*"Hãy subscribe cho kênh Ghiền Mì Gõ Để không bỏ lỡ những video hấp dẫn"* và
*"Các bạn hãy đăng ký kênh để ủng hộ kênh của chúng mình nhé."*, đồng thời **mất trắng 7,1
giây đầu**. Magic Fill thoát được vì nó chạy trên timeline **liền mạch** của Editing và chỉ
cần vị trí từ khoá gần đúng.

### Kiến trúc sau khi sửa

```
#btnScriptReorder (step3)
  → fetchReorderAlignment()      [index.html] — chỉ gửi KHOẢNG THỜI GIAN của từng block
      POST /api/reorder-by-script
        ├─ resolveTimelineWords()          [backend/server.js]
        │    session_segments.json phủ đủ mọi block?  -> cắt theo khoảng (tức thì)
        │    không phủ  -> bóc băng lại CẢ video (một lần, có cache) rồi ghi lại session
        ├─ sliceWordsByBlocks()            — cắt dòng từ theo ĐIỂM GIỮA của từ
        └─ align_blocks_to_script()        [core_logic.py] qua asr/python_reorder_sidecar.py
  → modal xem trước #reorderModalPanel (có cột "Nói thật" để đối chiếu sai khác)
  → applyReorderPlan()  = 1 × saveHistoryState() + cắt + sắp + chuỗi commit chuẩn
```

Renderer **không còn đường nào bơm dữ liệu hỏng vào bộ so khớp**: nó chỉ gửi `{index, start,
end}`. Không có `hints`, không có đường tụt hạng — mọi lỗi đều báo ra và timeline giữ nguyên.

`align_blocks_to_script` **không sửa gì trong pipeline so khớp**, chỉ gọi lại primitive của
nó: `split_sentences`, `_similarity`, `_quick_token_overlap`, `_subsegment_span_candidates`,
`_row_passes_sentence_gate`, `_snap_rows_to_word_boundaries`. Nó cũng **không chọn take**
(người dùng đã chọn vùng nào giữ ở `step2`; việc còn lại chỉ là *gán nhãn*).

### Hàm mục tiêu PHẢI nhân với số từ

DP trong từng block chọn dãy span không chồng nhau, tăng dần theo thời gian. Bản đầu cộng
dồn `score` thô theo từng mảnh — và **cộng dồn theo mảnh là hàm mục tiêu thiên vị cắt vụn**:
hai mảnh bao giờ cũng cộng ra nhiều hơn một mảnh, nên DP xé block ra để vơ thêm điểm.

Đo trên bộ dữ liệu vàng: `nem_house` sinh **17 mảnh cho 11 câu** và bỏ sót 3 câu. Cụ thể một
mẩu 0,8 giây nói "EPA có" khớp trọn câu ngắn "Có EPA ko?" (điểm 0,98) rồi đẩy câu dài thật sự
của block ra ngoài — vì `0,98 + 0,47` (hai mảnh) lớn hơn `0,87` (một mảnh đúng).

Sửa: `value = score × số_từ_của_mảnh`. Mảnh phải **trả giá bằng đúng số từ nó chiếm**, và
phạt bỏ trắng (`ALIGN_SKIP_WORD_PENALTY`) cũng tính trên cùng đơn vị. Kết quả: gán nhãn đúng
**60/64 → 64/64 block**, `nem_house` 17 mảnh/3 câu thiếu → 12 mảnh/0 câu thiếu.

### Một từ chỉ thuộc một block

Hai block liền kề chia đúng một mốc (`block.end` của cái này = `block.start` của cái kia) —
chuyện thường gặp: `_build_mapped_chunks` cắt chunk tại biên hàng, và chính tính năng này cắt
block ra nhiều mảnh. Để khoảng đóng ở cả hai đầu thì từ nằm đúng mốc đó bị gán vào **cả hai**
block, nhân đôi trong đầu vào của bộ so khớp — lỗi này không lộ ở lượt đầu (block chưa kề
nhau) mà lộ ở **lượt chạy thứ hai**. Biên thuộc block **sớm hơn**, khớp luật
`midpoint <= splitTime -> nửa trái` của `buildSplitTimelineItems`. Và phải xét block theo thứ
tự **thời gian**, không theo thứ tự mảng: `latestTimeline` có thể đã bị sắp lại ở lượt trước.

### Bất biến: một mảnh thì giữ nguyên thời gian

Block ra **đúng một mảnh** thì `start`/`end` được giữ **nguyên xi** — không snap, không nới
lề. Tính năng này là "sắp xếp lại", không phải "trim lại". Chỉ block phải **cắt** (từ 2 mảnh
trở lên) mới đi qua `_snap_rows_to_word_boundaries`, và khi đó truyền **dòng từ của riêng
block** làm `chunks` để lề chỉ tính theo khoảng lặng bên trong block, rồi kẹp lại về
`[block.start, block.end]`.

### Kế hoạch dựng trọn vẹn TRƯỚC khi bày ra modal

`computeReorderPlan()` mô phỏng luôn cả việc cắt: `plan.ordered[].item` **chính là** các item
sẽ nằm trong `latestTimeline`. Xem trước mà tính bằng một đường, áp dụng đi bằng đường khác
thì sớm muộn hai đường lệch nhau. `buildSplitTimelineItems` là hàm thuần nên mô phỏng không
tốn gì. Gán nhãn cho từng phần sau khi cắt phải theo **mảnh chồng nhiều nhất về thời gian**,
không theo chỉ số: `buildSplitTimelineItems` có quyền từ chối một mốc (mảnh dưới 0,1 giây).

### Luật sắp xếp

Khoá sắp xếp là `(scriptIndex, start)`, **sort ổn định**:
- Nhiều mảnh cùng một `scriptIndex` → đứng **liền nhau** đúng vị trí câu đó, sắp theo thời
  gian. Quyết định của người dùng là GIỮ CẢ, chỉ cảnh báo trong modal.
- `scriptIndex < 0` (không khớp câu nào) → **dồn về cuối**, giữ thứ tự cũ. Không tự xoá.

`applyReorderPlan()` gọi `saveHistoryState()` **một lần** cho cả lượt rồi mutate
`latestTimeline` **tại chỗ** bằng `splice(0, length, ...)`. Không gọi `reorderTimelineClip`
trong vòng lặp — mỗi lần nó tự đẩy một mốc history và bắn một lượt `/finalize-timeline`.
Lượt áp dụng còn **đóng nhãn** `script_index`/`script_text` và **ghi lại `text` bằng lời nói
thật** — vá luôn text hỏng mà bản lọc cũ để lại trong dự án, và làm lượt chạy sau idempotent.

### Một bộ tách câu duy nhất

Luật tách câu ở `static/js/script-reorder.js` (UMD); `splitScriptDisplayPieces()` trong
`index.html` là vỏ mỏng gọi nó. Bài đối chiếu JS↔Python trong `matching_pipeline.py` đổi từ
"moi mã JS ra khỏi index.html bằng regex" sang `require()` thẳng file module. Đã thêm ca ký
tự vô hình: `trim()` của JS coi U+FEFF là khoảng trắng nhưng **không** coi U+200B là.

Module này **cố ý chỉ còn** bộ tách câu + luật sắp xếp. Cả tầng chấm điểm văn bản bằng JS và
`validateLabels` đã bị gỡ: chúng phục vụ thiết kế "tin nhãn `script_index` khi kiểm chứng
được", tức đúng cái bẫy ở mục nguyên nhân #3–#4.

### Hạn chế còn lại

- **Câu nằm vắt giữa hai mảnh.** `baby_love` câu 9 được đọc liền một hơi với câu 10; mảnh
  trước hút phần đầu, mảnh sau hút phần cuối, nên câu 9 không có nhãn riêng. Không mất dữ
  liệu, thứ tự vẫn đúng, chỉ thiếu nhãn — cùng họ với món nợ "câu bị chunk cắt làm đôi".
- **Overlay ở Editing lệch theo** khi lane chính đổi thứ tự — hạn chế sẵn có của
  `reorderTimelineClip`; ở đây chỉ bổ sung cảnh báo trong modal.
- **Bản bóc băng lạc video không phát hiện được.** Cổng `sessionWordsCoverBlocks` chỉ hỏi
  "mọi block có ít nhất một từ chưa"; một `session_segments.json` của video khác mà tình cờ
  phủ đủ các khoảng vẫn lọt. Lúc đó `token_coverage` sẽ thấp, modal gắn nhãn "khớp yếu" và
  cột "Nói thật" cho người dùng thấy máy nghe ra gì — chữa bằng mắt người, không bằng thuật toán.

### Cách kiểm chứng

```
npm run test:script-reorder         # logic thuần JS (tách câu, luật sắp xếp, tóm tắt)
npm run test:timeline-words         # gom/cắt dòng từ + cổng "có phủ nổi timeline không"
npm run test:script-reorder-align   # đầu-cuối: 6 fixture vàng (64/64 block) + ca THẬT wellmune
npm run test:matching               # parity tách câu JS <-> Python
npm run eval:matching               # phải KHÔNG đổi: recall 113/113, take 104/113
```

Đo trên dự án thật sau khi sửa: 10 block → **17 block đúng trình tự c1→c17**, 17/17 câu có
đoạn, 0 block lạc, 243 từ; chạy lần hai báo "đã đúng thứ tự" và vẫn 243 từ (không nhân đôi).

## Gộp mẩu liền kề khi chốt Match Script → Timeline (2026-08-23)

`_build_mapped_chunks` cắt chunk **tại biên hàng**, nên hai câu kịch bản đọc liền một hơi
thành hai mẩu chia đúng một mốc ở màn "Rà soát so khớp kịch bản". Chốt nguyên như vậy thì
timeline nhận hai block và giữa chúng là một **điểm cắt vô cớ ngay giữa dòng nói**.

Nay `#btnApplyAndReorder` chạy `ScriptReorder.mergeAdjacentChunks(pickedChunks)` trước khi
gửi sang `/api/finalize-timeline`: mẩu **đặt sát cạnh nhau** gộp thành một block; mẩu **cách
nhau** (quãng lặng, hoặc có mẩu chưa tick chen giữa) vẫn để riêng — đó mới là chỗ người dùng
chủ ý bỏ một đoạn.

**Dung sai 0,021s không phải số tuỳ ý.** Đúng bằng ngưỡng `_build_mapped_chunks` dùng để gộp
hai mẩu cùng chủ (`abs(previous.end - piece.start) <= 0.021`), và nằm **trên** ngưỡng 0,02s
mà hàm đó dùng để BỎ mẩu vụn do làm tròn. Nhờ vậy hai mẩu chỉ cách nhau một mảnh vụn đã bị bỏ
vẫn được coi là liền kề, còn một mẩu chưa tick thật sự (luôn dài hơn 0,02s) thì chặn việc gộp.

Quy ước gộp: `script_index` giữ của mẩu **đầu tiên theo thời gian**, cả cụm dồn vào
`merged_script_indices` — cùng luật với `_merge_close_or_overlapping_rows` của pipeline
(`cur["script_index"] = deduped_indices[0]`). `end` lấy **max** (hai mẩu có thể chồng nhau
chút do snap biên từ; lấy end của mẩu sau là làm block ngắn đi). Các điểm chất lượng
(`similarity`, `token_coverage`, `score`, `loudness_dBFS`) lấy **trung bình có trọng số theo
thời lượng** — trung bình trần thì một mẩu 0,3 giây kéo điểm của cả block 8 giây.

**BẪY:** `merged_script_indices` phải được lấy lại từ input ở `hydrateTimelineRows`. Native
addon làm phẳng nó còn một phần tử (`row.mergedScriptIndices = {row.scriptIndex}`,
`core_c.cpp:184`), nên block gộp từ nhiều mẩu về tới renderer mất sạch danh sách câu nó chứa
— im lặng, không lỗi nào bắn ra. Cùng lý do với `sub_segments` ở ngay dòng trên trong hàm đó.

Số block đổi đi là thay đổi **im lặng**: người dùng tick 12 mẩu rồi thấy 8 block sẽ tưởng mất
đoạn, nên có toast "Đã gộp N phân đoạn liền kề thành M block."

Kiểm chứng: `npm run test:script-reorder` (mục "gộp liền kề").

## Nút đỏ về Trang chủ, đóng ở Trang chủ mới thoát (2026-08-23)

Nút đỏ **không thoát ngay**: đang dựng dự án thì nó **về Trang chủ**; chỉ khi đã ở Trang chủ,
đóng cửa sổ mới kết thúc app. Bấm đỏ giữa lúc dựng là mất mạch làm việc, mà Trang chủ vẫn là
chỗ mở dự án khác ngay.

Luồng, thêm vào trước bước hỏi "còn thay đổi chưa lưu?" đã có:

```
mainWindow.on('close')  [electron/main.js]
  isQuitting? -> KHÔNG chặn (Cmd+Q / menu Thoát: người dùng đã nói rõ là muốn thoát)
  requestRendererCloseIntent()  --'ask-close-intent'-->  preload  -->  renderer
      'already-home' -> đi tiếp: hỏi dirty -> đóng -> quitAfterWindowClose = true
      'home'         -> renderer đã về Trang chủ  -> GIỮ cửa sổ
      'cancelled'    -> người dùng huỷ hộp thoại lưu -> GIỮ cửa sổ đúng chỗ đang làm
```

Renderer đi qua `goHome()` chứ không phải `showHome()`: chỉ `goHome` mới hỏi lưu khi còn thay
đổi và dọn sạch backend (`startBlankProject`). Trả `'cancelled'` khi `goHome()` về mà Trang chủ
vẫn chưa hiện — nếu không thì cửa sổ vừa đóng vừa chưa lưu.

`quitAfterWindowClose` làm `window-all-closed` thoát hẳn **kể cả trên macOS**. Trước đây darwin
cố ý không quit, nhưng giữ tiến trình sống mà không còn cửa sổ còn kéo theo một cái bẫy: khoá
single-instance vẫn bị giữ, nên `npm start` lần sau thoát ngay và người dùng thấy "chạy lệnh mà
chẳng có gì hiện ra" (xem `app.on('second-instance')`).

Renderer treo/không trả lời thì `askRenderer` trả `null` → coi như `'already-home'`, để không
bao giờ kẹt ở trạng thái không đóng được cửa sổ.

## Nguồn HDR (HLG/PQ) hiện sáng cháy — hạ về SDR ở 3 khâu (2026-09-07)

Video HDR từ điện thoại (iPhone: HEVC Main 10, `arib-std-b67`/HLG, `bt2020`, kèm Dolby Vision
profile 8 với `bl_signal_compatibility_id=4`) mở trong CrabbyCut thì **sáng rực và bạc màu**,
trong khi CapCut mở cùng file lại đúng. Đo trên vùng video của ảnh chụp thật
(`IMG_0826 (1).MOV`, 1080×1920, 429s):

| | luma TB | %pixel >235 | tương phản (std) | bão hoà |
|---|---|---|---|---|
| CrabbyCut trước khi sửa | **224,1** | **65,73%** | 52,1 | 0,129 |
| CapCut (mốc cần đạt) | 162,7 | 4,02% | 49,4 | 0,208 |
| CrabbyCut sau khi sửa | 166,5 | 0,63% | 45,9 | 0,191 |

**Hai phần ba khung đã cắt cụt.** Đó là lý do không có cách sửa nào ở tầng UI (hạ sáng, đổi
độ tương phản, filter màu) cứu được, và cũng là lý do loại phương án "tonemap trong shader
PixiJS": khung mà app hiển thị đã mất phần cao sáng, hạ sáng nó chỉ ra một vùng xám phẳng.
(Cắt cụt xảy ra ở đâu trong Electron thì CHƯA đo được — số đo trên là từ ảnh chụp cửa sổ thật.)

Trước bản này, `grep -iE 'tonemap|zscale|bt2020|arib'` toàn repo **không trúng chỗ nào** ngoài
`tests/scripts/`, mà ở đó cũng chỉ GẮN NHÃN `bt709` chứ không chuyển đổi. Ba khâu cùng hỏng:

- **Preview HQ** — `<video>` phát nguồn, frame lên texture qua `texImage2D` rồi vẽ bằng PixiJS.
- **Preview LQ** — `BuildPreviewProxyCommand` chỉ `scale…,format=yuv420p`: hạ xuống 8-bit nhưng
  **giữ nguyên nhãn HLG/BT.2020**, tức "HDR giả" 8-bit (kiểm lại bằng chính lệnh đó: output ra
  `pix_fmt=yuv420p` mà `color_transfer=arib-std-b67`, `color_primaries=bt2020`).
- **Export** — sidecar không có `setparams` lẫn tonemap, nên file giao khách cũng sai màu.

### Cơ chế: là Electron 31, KHÔNG phải "Chromium nói chung"

Chẩn đoán đầu tiên gán lỗi cho đường `texImage2D` của Chromium. **Sai.** Đo lại trên Chromium
hiện tại với cùng file: cả `canvas 2D drawImage` LẪN `WebGL texImage2D` đều tonemap đúng —
luma 175,1 và chỉ 0,83% pixel cháy. Hiện tượng 65,73% là của **Electron 31.7.7 (Chromium ~126)**
mà app đang dùng: bản đó giải được đường truyền HLG nhưng không nén dải sáng, nên đỉnh 1000 nit
bị cắt cụt ở mức trắng SDR. Dựng lại bằng ffmpeg ("giải HLG rồi đưa thẳng sang BT.709 không nén
dải") cho ra 74,11% — khớp, nên cơ chế đã chốt.

Hệ quả: **nâng Electron có thể tự khắc phục riêng phần preview** (chưa kiểm chứng). Nhưng nó
không giúp gì cho file xuất (ffmpeg vẫn cần tonemap) lẫn thumbnail, còn cách sửa dưới đây thì
không phụ thuộc runtime nào — Windows và macOS ra cùng một màu.

### Hai đường tonemap, cùng đích BT.709 full-range

```
HDR_TONEMAP_PLACEBO  format=yuv420p10,hwupload,libplacebo=…:tonemapping=bt.2446a:format=yuv420p,hwdownload,format=yuv420p
HDR_TONEMAP_ZSCALE   zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p
```

libplacebo (GPU, Vulkan) là đường chính: khớp CapCut sát nhất trong các ứng viên đã đo (luma
166,5 so với 162,7; tương phản 45,9 so với 49,4) và nhanh gần 2× (9s so với 16s cho 30s nguồn).
zscale (CPU, libzimg) là dự bị, chạy ở đâu cũng được nhưng nhạt hơn (luma 179,5; tương phản
42,8). Các ứng viên khác đã loại bằng số đo: `hable` với `npl=203` hoặc `npl=400` tối quá
(luma 150,7 và 122,5), `reinhard` thì phẳng (181,8).

`vulkanTonemapUsable()` dò **một lần mỗi lần chạy server** bằng một khung 64×64 rồi nhớ kết
quả, và in ra `[hdr] tonemap bằng Vulkan/libplacebo: dùng được | không có, quay về zscale CPU`.
`runTonemapWithFallback(buildArgs, onFallback)` bọc mọi lệnh tonemap: dò được Vulkan mà chạy
thật vẫn chết (hết VRAM, driver treo giữa file dài) thì **hạ cờ luôn** để các nguồn sau trong
cùng lượt nhập không lặp lại cú chết đó. **Không có nhánh cứu hộ cho zscale** — nó chết thì lỗi
phải nổi lên, vì bản duy nhất còn lại là bản sai màu. `buildArgs(chain)` phải dựng lại TOÀN BỘ
lệnh chứ không chỉ đổi `-vf`: nhánh Vulkan còn cần `-init_hw_device vulkan=vk -filter_hw_device vk`
đứng **trước** `-i` (nó là tuỳ chọn toàn cục).

### Khâu 1 — nguồn lane chính (`normalizeVideoForConcat`)

`shouldNormalizeForConcat()` trước đây chỉ bắt `.webm`; nay `|| sourceIsHdr(filePath)`.
`sourceIsHdr()` probe `color_transfer`/`color_primaries` (cache theo path+size+mtime như
`concatStreamSignature`) và nhận HLG (`arib-std-b67`), PQ (`smpte2084`), cùng nguồn chỉ ghi
`bt2020` — gam rộng thì dù không cháy vẫn lệch màu trên đường sRGB.

Sửa **ở đây** vì đây là chỗ duy nhất mà mọi khâu sau đều thừa hưởng: HQ, LQ, export, ảnh bake,
snapshot. Export đọc `TEMP_DIR/temp_input.mp4` nên tự đúng theo.

Hai chi tiết dễ mất nếu viết lại:

- **`_sdr` trong TÊN bản chuẩn hoá**, cùng lý do như `_na` của `withAudio`: máy nào đã nhập
  file này trước bản sửa thì trên đĩa đang có một bản chuẩn hoá SAI MÀU nhưng vẫn "mới hơn
  nguồn", và `normalizedCopyIsFresh()` sẽ vui vẻ dùng lại nó.
- **`-r` nay chỉ ép khi có >1 nguồn** (`forceFps` từ `normalizeSourcesForConcat`). Một nguồn
  HDR đơn lẻ nay cũng đi qua hàm này, mà ép nó về 30 là **ném đi một nửa số khung của clip
  60fps** — mất khung mà không ai yêu cầu. Một nguồn thì không có ai để khớp nhịp khung.
- **Nhịp khung của file nối = nhịp CAO NHẤT của bộ nguồn** (`concatTargetFps`, trần 60), và
  nó nằm TRONG TÊN bản chuẩn hoá (`_r60000-1001`) cùng lý do như `_na` / `_sdr`.
  Trước 2026-09-09 chỗ này ghi cứng `-r 30`, và đó là một lỗi **mất khung không ai thấy**:
  đo trên `Test_lech fps_ver 2.crab`, nguồn DJI 1728×3072@60000/1001 có 332 khung ra file
  nối chỉ còn **168 khung** — người dùng chọn xuất 59.94 thì nhận một file khai 59.94 trong
  header nhưng chuyển động vẫn là 30 fps đã lược.
  Vì sao lấy nhịp CAO NHẤT chứ không lấy timebase sequence: CapCut/Premiere không dựng file
  trung gian nào — mỗi nguồn giữ decoder riêng và việc **quy nhịp xảy ra ở khâu RENDER**.
  Lane chính buộc phải có file nối, nên file đó đóng vai "mezzanine" ở nhịp cao nhất (không
  ném khung của nguồn nào), rồi `-r`/`fps=` của export mới quy về timebase sequence — đúng
  chỗ Premiere làm. Kèm theo: **đổi fps sequence KHÔNG cần nhập lại lane chính.**
  Chi phí đo được (2 nguồn của dự án trên, libx264 veryfast crf20):
  `-r 30` = 19,3s mã hoá / 18,9 MB; `-r 60000/1001` = 28,5s / 20,7 MB (+48% thời gian, +9%
  dung lượng). `CONCAT_CACHE_VERSION` lên 4 để mọi mục cache đã lược khung hết hiệu lực.
  ⚠️ Đổi nhịp file nối là **đổi trục thời gian của file nối**: bảng đoạn đo lại sẽ khác bản
  lưu trong `.crab` cũ (nguồn DJI trên: `[0, 5.6]` -> `[0, 5.538867]`), nên dự án cũ mở lại
  có thể lệch nội dung tới vài khung ở các block phía sau. Không có đường nào vừa sửa được
  mất khung vừa giữ nguyên trục cũ.

Giá phải trả: nhập một file HDR tốn thêm một lượt mã hoá lại — đo được 16s cho 30s nguồn
1080×1920 (~3,8 phút cho clip 7 phút) và ~105 MB trên đĩa. Cũng mất đường xuất bản HDR, nhưng
dự án chưa có tính năng đó. Dolby Vision: profile 8 với `bl_signal_compatibility_id=4` có lớp
nền TỰ NÓ đã là HLG hợp lệ, nên bỏ lớp RPU và tonemap từ lớp nền là **đúng**, không phải xấp xỉ.

### Khâu 2 — thumbnail (`CommandThumbnail`, sidecar)

Trích thẳng một frame từ nguồn HLG rồi lưu JPEG là chép nguyên tín hiệu HDR vào ảnh SDR: thẻ
trong panel "Tệp phương tiện" bạc màu (bão hoà 0,108 so với 0,212 sau khi sửa — cùng mức với
thumbnail của một nguồn vốn đã SDR, 0,211).

Ở đây dùng **zscale (CPU)** chứ không libplacebo: một frame thì tốc độ không đáng bàn (0,35s so
với 0,25s), đổi lại không kéo phụ thuộc Vulkan vào một lệnh chạy hàng trăm lượt khi người dùng
cuộn panel. `HasFfmpegFilter("zscale")` chặn trước để build ffmpeg thiếu libzimg không sinh lệnh
chết — thumbnail cháy vẫn hơn thumbnail KHÔNG CÓ (bên gọi coi lỗi là "không trích được" rồi hiện
ô giữ chỗ). `SourceIsHdr()` của sidecar giữ ĐÚNG bộ điều kiện của backend.

Kèm ở server: `createOrGetThumbnail()` thêm `_sdr` vào tên cache. Khoá cũ chỉ băm
path+mtime+size nên **nó không hề biết cách trích đã đổi**, và thumbnail cháy đã cache sẽ được
dùng lại mãi.

### Khâu 3 — asset overlay (`ensureSdrAsset`)

Lane chính đã đúng màu từ lúc nhập, nhưng asset overlay đi đường khác: `/editing-assets/link`
cố tình **không chép và không probe** (nạp cả cây footage hàng trăm file thì probe từng cái là
treo request), nên một b-roll HLG kéo lên lane overlay vẫn cháy — cháy trong preview VÀ trong
file xuất, vì sidecar mở thẳng `asset_path`.

Một bản SDR dùng cho **cả preview lẫn export**: một file, một lượt chờ, không có đường nào lệch
màu giữa hai khâu. Khoá băm path+size+mtime nên mỗi file chỉ dựng một lần; đo được ~1/3 thời
lượng clip (clip 12s → 4s), tức b-roll thường gặp là vài giây. Bốn điểm nối:

```
/api/editing-assets/import-local   nguồn HDR -> mã hoá THẲNG TỪ NGUỒN, bỏ hẳn phép chép
/api/editing-assets/upload         tonemap từ file multer vừa nhận, xoá bản HDR
/api/editing-assets/ensure-sdr     asset LINK hỏi đúng lúc kéo block xuống timeline
POST /api/export-video             sdrOverridesForEditingAssets() chốt lần cuối
```

- **Vì sao import-local không chép trước rồi tonemap:** chép trước vừa tốn một lượt ghi cả file
  (nguồn iPhone 7 phút là 493 MB) vừa làm bộ đệm vô dụng — khoá băm theo path+mtime của BẢN CHÉP,
  mà mỗi lượt nhập lại sinh mtime mới.
- **Vì sao vẫn cần override ở export** dù preview đã đổi sang bản SDR: dự án mở lại từ `.crab`
  mang theo `path` đã lưu (trỏ file HDR gốc), và người dùng có thể bấm Xuất mà **chưa hề chạm
  vào block overlay nào** — lúc đó không có gì kích hoạt đường preview. `normalizeEditingPayload`
  nhận thêm tham số `assetPathOverrides` và đổi đường dẫn ở **cả hai chỗ** đọc `asset.path`
  (`normalizedAssets` và `overlayAssetPath` của từng item), vì hai chỗ đó phải trỏ CÙNG một file.
- **Frontend** gọi qua `ensureAssetSdr(asset)` trong `ensureAssetProbed()` — chỗ hẹp mà cả ba
  đường dựng block đều đi qua (thả chuột, thả nhiều tệp, nút "+"). Nó đổi `asset.url` (preview
  đọc: `v.src = asset.url`) LẪN `asset.path` (payload export đọc), nhưng **giữ nguyên
  `source_path`**: đó là chìa khoá để lưu `.crab` rồi dựng lại asset lúc mở, và là thứ
  `/api/project/reingest` cần nếu người dùng kéo asset này xuống lane chính. `asset.sdrPromise`
  giữ đúng một lượt hỏi cho mỗi asset (thả 5 tệp cùng lúc là 5 lời gọi song song).

**BẪY — chỗ đặt file không phải chuyện tuỳ ý.** Bản SDR nằm ở
`editing_assets/sdr/<khoá>/<tên gốc>.mp4`. Lúc lưu `.crab`, `isTempEditingAssetRecord()`
(`index.html`) nhận asset của dự án bằng cách tìm chuỗi `temp_uploads/editing_assets` trong url —
đặt ra ngoài (ví dụ `temp_uploads/sdr_assets/`) là asset **không vào manifest và mở lại dự án thì
mất luôn block**. Thư mục con tên theo khoá để **giữ được tên gốc** cho panel (không hiện một
chuỗi băm) mà hai file trùng tên từ hai thư mục khác nhau vẫn không đè nhau. Đuôi luôn `.mp4` vì
bản ra là H.264 — giữ `.mov` của nguồn là dán sai nhãn container. (`generated_text/` cũng là một
thư mục con như vậy.)

`sdrAssetInflight` giữ MỘT lượt dựng cho mỗi file dù có bao nhiêu bên hỏi cùng lúc: bấm Xuất
trong khi preview đang dựng cùng asset đó là **hai tiến trình ffmpeg ghi vào đúng một đường
dẫn** — file ra hỏng mà không bên nào báo lỗi.

`ensureSdrAsset()` **không ném lỗi ra ngoài**: dựng hụt thì trả lại đường dẫn gốc — asset vẫn
dùng được (chỉ sai màu như trước) còn hơn làm sập cả lượt nhập hay cả lượt xuất vì một file.
Endpoint `ensure-sdr` cho qua cả đường dẫn nằm trong `TEMP_DIR` chứ không chỉ
`isSourceAccessAllowed()`: asset ĐÃ CHÉP không đi qua `registerSourceAccess`, mà dự án cũ mở lại
có thể còn asset HDR đã chép từ trước bản sửa — đúng trường hợp cần hạ SDR nhất.

### Hạn chế còn lại

- **macOS chưa kiểm được libplacebo**: nó cần Vulkan qua MoltenVK. Nếu không dùng được thì log
  ghi `không có, quay về zscale CPU` và màu vẫn đúng, chỉ nhạt hơn (luma 179,5 thay vì 166,5) và
  chậm hơn ~1,8×.
- **Dự án cũ mở lại**: block overlay chưa được chạm vẫn phát bản HDR trong preview cho tới khi
  `ensureAssetProbed()` chạy. File xuất thì luôn đúng nhờ override.
- **Nguồn đã nhập trước bản sửa** phải nạp lại mới có bản SDR (`temp_input.mp4` cũ vẫn là
  `yuv420p10le / arib-std-b67 / bt2020`).
- Không còn đường xuất HDR.

### Cách kiểm chứng

Cắt một clip ngắn bằng `-c copy` để giữ nguyên nhãn màu, rồi nhập qua
`POST /api/project/reingest` trên một server chạy với `CRAB_TEMP_DIR` riêng (endpoint đó đi qua
đủ pipeline nhưng không kéo ASR; để TEMP_DIR mặc định là ghi đè dự án đang mở). Chờ log
`Nguồn 1 là HDR — đang hạ về SDR…`, rồi `ffprobe` bản chuẩn hoá, `temp_input.mp4` và
`preview_proxy.mp4` — cả ba phải ra `bt709/bt709/bt709` với `pix_fmt=yuv420p`, và số khung phải
khớp thời lượng × fps (không mất khung).

Asset overlay: `POST /api/editing-assets/link` rồi `POST /api/editing-assets/ensure-sdr` (nguồn
SDR phải trả `tonemapped:false` trong 0s). Export với `editing_json` trỏ **thẳng file HDR gốc**
để kiểm override: vùng overlay trong file xuất đo được 0,20% pixel cháy, còn nếu dùng bản HDR
thì 74%.

Test đã chạy cho đợt này (12 cái, mỗi cái một lệnh `npm run` riêng — `npm run` không nhận nhiều
script trong một lần gọi): `test:native`, `test:backend`, `test:media-folders`,
`test:vector-asset`, `test:export`, `test:retouch-export`, `test:overlay-placement`,
`test:main-lane-reingest`, `test:main-lane-concat`, `test:main-lane`, `test:proxy-alignment`,
`test:audio-peaks`.

**BẪY khi chạy test**: `audio_peaks_smoke.js` khởi động server trên `temp_uploads` THẬT (nó chỉ
dọn thư mục con `peaks_smoke/` của mình). Phần lớn test khác tự đặt `CRAB_TEMP_DIR` vào
`test_temp/`; kiểm bằng `grep -l CRAB_TEMP_DIR tests/scripts/<file>.js` trước khi chạy nếu dự án
đang mở còn dữ liệu chưa lưu.

## Khung transform cho lane chính + bỏ nền đen bake sẵn (2026-09-09, GĐ1)

Người dùng đối chiếu với CapCut và nêu hai điều:
1. block trên lane chính cũng phải có KHUNG TRANSFORM trên khung xem trước (kéo/co giãn/xoay
   trực tiếp), không chỉ block overlay;
2. video thêm vào lane chính mà khác khổ dự án phải giữ đúng tỉ lệ của nó, KHÔNG bị app chèn
   thêm nền đen vào ảnh.

Cả hai đều bắt nguồn từ một chỗ: lane chính không phải danh sách clip độc lập như CapCut mà là
các khoảng `[start,end]` trên MỘT file đã nối (`temp_uploads/temp_input.mp4`).

### Vì sao có nền đen bake sẵn

`ffmpeg -f concat` đòi mọi đoạn cùng khổ hình, nên `concatFitFilter()` co mọi nguồn về khổ đích
rồi `pad` viền đen cho đủ khổ. Viền đó nằm TRONG khung hình — không ai phân biệt được nó với
viền vốn có trong ảnh.

Khổ đích trước đây là khổ của nguồn ĐẦU TIÊN. Hệ quả đo được: dự án dọc 1080×1920, thêm clip
ngang 1920×1080 → clip đó bị nén còn **1080×607, mất 68% pixel và mất vĩnh viễn**. Người dùng
phóng nó lên cho tràn khung là thấy mờ hẳn so với CapCut.

### Ba con số là hợp đồng chung (static/js/main-lane.js)

`concatFrameSize` · `contentRectIn` · `fitScale`/`clipBaseSize` — MỘT bản cài đặt, dùng chung
cho cả ba phía: backend dựng file nối, preview vẽ sprite + khung chọn, sidecar dựng filtergraph.
Backend `require()` thẳng module này (như đã làm với AudioDenoise/ClipSpeed).

- **Khung nối = KHUNG BAO của mọi nguồn** (max rộng × max cao), không còn là khổ nguồn đầu.
  Nhờ vậy hệ số thu nhỏ luôn = 1: KHÔNG nguồn nào bị mất pixel lúc nạp. Đổi lại khung to hơn ở
  dự án lệch khổ (1080×1920 + 1920×1080 → 1920×1920) nên chuẩn hoá/nối/proxy tốn hơn. Dự án mà
  mọi nguồn cùng khổ: khung bao ĐÚNG BẰNG khổ đó → không đổi gì.
- **`content`** = hình chữ nhật ảnh thật trong khung nối, do `concatSegmentTable()` khai vào
  bảng đoạn (đã sẵn đường lưu vào `.crab` qua `main_lane_segments` và vào bộ đệm file nối).
  Frontend tra theo VỊ TRÍ `clip.start` nên block đã cắt bằng dao vẫn ra đúng vùng ảnh.
- **`fitScale`** = "scale 100% nghĩa là VỪA KHUNG" (theo CapCut). Bản trước vẽ khung nối theo
  đúng số pixel trên canvas, nên nguồn to hơn canvas bị cắt còn nguồn nhỏ hơn thì lọt giữa —
  hai hành vi cho cùng một thao tác. Nguồn cùng khổ sequence → hệ số = 1, y như bản trước.

`concatFitFilter` nay VIẾT THẲNG số đo (`scale=cw:ch,pad=W:H:x:y`) thay vì để
`force_original_aspect_ratio`/`(ow-iw)/2` tự quyết: vùng ảnh phải được GHI LẠI vào bảng đoạn,
nên backend buộc phải biết chính xác ffmpeg đặt ảnh ở đâu — đoán luật làm tròn của ffmpeg là
sai một pixel mà không ai thấy cho tới lúc xem bản xuất.

`CONCAT_CACHE_VERSION` 2 → 3: mục cache cũ vừa sai khổ vừa thiếu `content`.

### Ba cái bẫy đã xử lý

1. **`sequenceSettings.source_*` KHÔNG còn là khổ khung nối.** Nó là khổ VÙNG ẢNH của nguồn đầu
   tiên (đó là thứ preset 'source' phải lấy). Handler `loadedmetadata` vì thế thôi đọc
   `video.videoWidth` mà hỏi `mainConcatSegments[0].content` — không thì thêm một clip ngang là
   dự án tự đổi sang khổ VUÔNG. Khổ khung nối đi qua biến riêng `mainConcatFrame`, do backend
   khai trong phản hồi reingest (`concat_frame`) — KHÔNG suy từ thẻ `<video>` vì thẻ có thể
   đang nạp proxy LQ, mà con số này là mẫu số của mọi phép quy đổi.
2. **Mọi chỗ trước đây lấy `payload.source_*` làm "khổ stream" phải đổi sang `mainConcatFrame`**:
   bake mặt nạ cắt hình + `colorAdjustExportSpec` (chuỗi filter chạy trên `[0:v]` = chính file
   nối; lệch cỡ thì `blend=multiply` của sidecar từ chối ghép), `maskFrameSize()` (ô nhập
   rộng/cao theo pixel), hộp vá Retouch, `drawMainClipLayer`, ảnh chụp khung hình.
3. **Meta Auto-Reframe đo bằng pixel KHUNG NỐI**, còn `auto-reframe-geometry.js` hiểu
   `(sourceW, sourceH)` là "cỡ ảnh TRÊN CANVAS ở 100%" và trả position bằng pixel sequence. Hai
   hệ chỉ trùng nhau khi khung nối vừa khít sequence. `autoReframeMetaForGeometry()` quy đổi
   (dịch về gốc vùng ảnh rồi nhân `fit`) ngay trước mọi lời gọi sang module hình học; KHÔNG lưu
   bản đã quy đổi vào dự án vì nó phụ thuộc khổ sequence. Kèm theo, `isAutoReframeMetadataCurrent`
   nay so meta với KHUNG NỐI chứ không với khổ sequence: thêm video làm khung bao nở ra thì phải
   quét lại (bản cũ không bắt được), còn đổi Tỷ lệ khung hình thì KHÔNG cần gọi lại sidecar.

### Khung transform của block lane chính

Dữ liệu vốn đã có (`latestTimeline[i].transform` — panel Thuộc tính sửa được, Auto-Reframe ghi
vào đó, export đọc đúng nó); thiếu đúng phần khung trên canvas, vì `selectedVisualItemForBox()`
chỉ dò trong `selectedEditingItemIds` (lớp overlay).

Row lane chính nay được trả về NGUYÊN BẢN cho đường vẽ khung — không bọc thêm object, nên thao
tác kéo ghi thẳng vào `clip.transform`, đúng chỗ mà undo/`.crab`/export đang đọc. Ba chỗ cần
phân biệt thì hỏi `isMainLaneBoxItem()`, so bằng ĐỊNH DANH với
`latestTimeline[selectedTimelineClipIndex]` (không nhét field lạ vào row — field lạ sẽ chảy vào
`.crab` và payload export).

Khác biệt so với đường overlay: cỡ gốc lấy `mainClipBaseSize` (vùng ảnh đã vừa khung), giờ cục
bộ lấy `mainClipLocalTime` (row không có `timeline_start`), khoá lane hỏi `track_main`, và sau
mỗi cú kéo phải `markClipAutoReframeManualOverride` — thiếu nó thì Auto-Reframe ghi đè lại đúng
cú kéo vừa rồi ở lượt áp kế tiếp.

Bản sao "block lane chính → overlay" cũng phải nhân `fit` vào scale (hai lane hiểu `scale` khác
nhau đúng một hệ số) và mang theo transform của clip, thay cho `coverScalePercent` như trước.

### Export

Frontend gửi kèm `content` theo từng block; backend đổi thành `fit_scale` bằng CHÍNH
`MainLane.fitScale` rồi chuyển xuống sidecar. Sidecar nhân hệ số đó vào scale hiệu dụng ở CẢ
hai nhánh — tĩnh (`WriteClipVideoFilters`) và keyframe/hoạt ảnh (`AppendKfTransformFilters`);
bỏ sót một nhánh là clip có keyframe scale nhảy cỡ ngay khung đầu và chỉ lộ ra ở bản xuất.
`fit_scale` tách khỏi `scale` chứ không nhân sẵn: `scale` là dữ liệu người dùng.

`normalizeExportIntervals` nay nhận thêm `sequenceSettings`, nên thứ tự trong handler
`/api/export-video` đổi: chốt khổ sequence TRƯỚC rồi mới chuẩn hoá timeline.

### Hai hành vi cũ giờ gặp ca mới — người dùng đã chốt GIỮ NGUYÊN

- **Nền xanh nhấp nháy** (`isSequenceTransparencyWarningEnabled`) trước đây không bao giờ hiện ở
  lane chính vì khung đã pad luôn phủ kín. Nay clip khác khổ để lộ nền → cảnh báo hiện. Giữ
  nguyên theo yêu cầu: nó vẫn đúng nghĩa "không có gì phủ kín khổ sequence tại playhead".
- **Auto-Reframe (bật mặc định) phóng clip khác khổ cho tràn khung** — đo được 397% với clip
  ngang trong dự án dọc, bám mặt người. Trước bản sửa AR không đụng ca này vì khung đã pad làm
  nó tưởng clip phủ kín rồi. Giữ nguyên theo yêu cầu; muốn ra hình letterbox như CapCut thì tắt
  nút AR.

### Còn lại cho GĐ2

Viền đen VẪN được bake vào `temp_input.mp4` (concat đòi một khổ). GĐ1 chỉ thôi coi nó là ảnh:
hình học tính theo vùng ảnh thật, và vì nền canvas cũng đen nên viền vô hình (lane chính là lớp
đáy). GĐ2 sẽ `crop` viền đi thật ở cả preview lẫn export — lúc đó phóng clip lên mới hết mờ, và
không gian NGUỒN của mặt nạ/landmark retouch sẽ dời từ khung nối sang vùng ảnh.

### Cách kiểm chứng

- `npm run test:main-lane-fit` — số học thuần + bóc chính các hàm hình học trong `index.html` ra
  chạy: preview và export cùng hệ số, LQ và HQ ra cùng cỡ vẽ, dự án cùng khổ thì hệ số = 1.
- `npm run test:mixed-orientation` — đo PIXEL THẬT: `content` trỏ đúng chỗ ffmpeg đặt ảnh (tâm
  có hình, dải viền là đen), và trong bản xuất thì clip ngang letterbox còn clip dọc phủ trọn.
  So số với số ở đây vô nghĩa: cả hai phía dùng chung công thức nên sẽ "khớp" kể cả khi sai.
- Trên app thật (server chạy với `CRAB_TEMP_DIR` riêng, mở `http://127.0.0.1:<port>` trong
  trình duyệt rồi gọi `window.addSourcePathsToMainLane([...])`): dự án dọc + clip ngang cho khung
  nối 1920×1920, sequence vẫn 1080×1920, clip ngang ở 100% ra hộp 346×194.6 trên khung 348×619,
  và sprite giữ nguyên 346×346 ở CẢ LQ (texture 720×720) lẫn HQ (1920×1920).

## Auto Subtitle — phụ đề tự động từ audio timeline (Windows, 2026-09-13)

Nhóm **Âm thanh → Auto Subtitle**: bóc băng thứ đang nghe thấy trên timeline bằng chính
Whisper của ứng dụng, rồi rải thành block phụ đề — kiểu Auto Captions của CapCut. Kèm
thanh tiến trình thật và một tệp `.srt` ghi cạnh tệp `.crab`.

Port từ nhánh `CrabbyCut_v2.0.1` (macOS). Phần khác nhau nằm ở mục "Ba chỗ lệch với nhánh
macOS" bên dưới — đọc trước khi đồng bộ hai nhánh.

### Bốn quyết định gốc

**1. Phụ đề là block `type:'text'` THẬT, không phải một lớp vẽ riêng.**
Đổi lại được nguyên vẹn mọi đường đã chạy tốt cho text: preview, xuất video, keyframe,
kéo/sửa/xoá từng câu, ghi vào `.crab`. Dựng một "lớp phụ đề" riêng thì phải rà lại từng
đường đó và chỗ bỏ sót sẽ hỏng ÂM THẦM ở khâu xuất.

**2. Bản trộn audio dựng theo TRỤC TIMELINE, nên mốc ASR dùng thẳng được.**
`backend/subtitle-jobs.js` không nối liền các khoảng như Magic Fill (trục = tổng độ dài
các khoảng) mà `adelay` mỗi mảnh về đúng mốc nó phát. Không còn phép quy đổi mốc nào ở
frontend — mỗi phép quy đổi là một chỗ để lệch.

**3. Dữ liệu phụ đề đi theo dự án qua `EditingRuntime.subtitleState`**, nằm trong
`getHistoryState()` nên `.crab` + undo/redo + "Dự án mới" tự đúng, không có kênh lưu thứ hai.
Bản thân block text đã tự persist; sổ này thêm phần "chúng là MỘT BỘ": thiếu nó thì không
xuất lại được `.srt` sau khi mở dự án, "Xoá phụ đề" phải đoán block nào là phụ đề, và chạy
lần hai sẽ chồng bộ mới lên bộ cũ.

**4. Tệp `.srt` là BẢN XUẤT, không phải nguồn sự thật.** Nó được dựng từ
`subtitleCuesFromItems()` — đọc CHÍNH BLOCK đang có trên timeline — chứ không từ ảnh chụp
`subtitleState.cues` lúc bóc băng. Người dùng sửa chữ / kéo mốc từng block là chuyện bình
thường; ghi `.srt` theo ảnh chụp thì tệp lệch với video ngay lần sửa đầu tiên, lệch im lặng.
`cues` chỉ là bản dự phòng khi block đã bị xoá hết.

### Đường đi

```
Panel (static/js/auto-subtitle.js)
  └─ ER.collectAudibleTimelineSpans(scope)      lane chính + block audio/video CÒN NGHE THẤY
       │                                         (bỏ block/lane tắt tiếng, âm lượng 0, mảnh < 50 ms)
       ▼
POST /api/subtitles/transcribe  → job nền, trả job_id ngay
  └─ backend/subtitle-jobs.js
       ├─ normalizeEntries()   chuẩn hoá + danh sách trắng đường dẫn (resolveSubtitleSourcePath)
       ├─ buildMixFilter()     asplit → atrim → atempo → aresample 16k mono → volume → adelay
       │                       → amix normalize=0 → alimiter
       ├─ ffmpeg -progress pipe:2      →  4–22 %
       └─ transcribeSubtitleMix()      → 22–96 %   (cache asr_cache, khoá = KẾ HOẠCH trộn)
            └─ transcribeVideo(..., { onProgress, onChild })
                 └─ runWindowsFasterWhisper → runPythonSidecar(..., { onProgress })
                      └─ asr/windows_faster_whisper_sidecar.py  phát {"ratio": …} qua NDJSON
       ▼
GET /api/subtitles/jobs/:id  (panel poll 700 ms, vẽ thanh tiến trình)
       ▼
cuesFromSegments()  →  chunkSpansForScene()   (luật chia phụ đề, xem lệch #2 bên dưới)
       ▼
applyCuesToTimeline()  →  ER.addTextItem() trong một batch lịch sử (Ctrl+Z hoàn tác cả bộ)
       ▼
writeSrtFile()  →  IPC `subtitle-save-srt`  →  "<Tên dự án>.srt" CẠNH "<Tên dự án>.crab"
```

### Thanh tiến trình: số thật, không phải đồng hồ đếm giả

| Khoảng | Nguồn số |
| --- | --- |
| 0 → 4 % | dựng kế hoạch trộn |
| 4 → 22 % | `out_time_ms=` của `ffmpeg -progress pipe:2`, chia cho tổng độ dài timeline |
| 22 → 96 % | `ratio` do sidecar ASR phát về (bảng pha ngay dưới) |
| 96 → 100 % | chuẩn hoá kết quả |

Whisper không có API callback tiến độ, và trên Windows `faster-whisper` cũng không vẽ thanh
tqdm nào. Sidecar phát thẳng `{"type":"progress","ratio":…}` trên kênh NDJSON sẵn có của
stdout; `runPythonSidecar` đọc khoá `ratio` đó. CHỈ phát khi backend đặt `CRAB_ASR_PROGRESS=1`,
tức chỉ khi người gọi truyền `onProgress` — mọi luồng cũ (Upload → Transcribe, Magic Fill)
không thêm một dòng stdout nào.

**Vì sao phải CHIA PHA chứ không chỉ đếm segment.** `BatchedInferencePipeline` chạy VAD +
trích đặc trưng NGAY trong `transcribe()` rồi mới trả generator, và tiền xử lý audio bằng
ffmpeg chạy trước đó nữa. Bản đầu chỉ phát `segment.end / thời lượng audio` từ vòng lặp
generator: **đo được trên 48 phút audio là thanh đứng im 108 giây ở 22 % rồi mới nhảy** —
tệ hơn là không có thanh nào. Nay mỗi pha chiếm một khoảng của thanh, và hai pha có tiến độ
thật thì chạy mượt bên trong khoảng của mình:

| Pha | Khoảng (ratio) | Nguồn số | Đo trên 48 phút audio |
| --- | --- | --- | --- |
| Tiền xử lý ffmpeg | 0 → 0.40 | `-progress pipe:1` — số thật, mượt | 75,5 s (42 %) |
| Nạp model | 0.40 → 0.45 | một mốc khi nạp xong | 4,8 s (3 %) |
| VAD + trích đặc trưng | 0.45 → 0.55 | một mốc khi `transcribe()` trả về | ~23 s (13 %) |
| Giải mã | 0.55 → 1.00 | mỗi batch một nhịp (`segment.end`) | ~76 s (42 %) |

Thanh chỉ nhúc nhích khi một pha THẬT xong hoặc khi một pha có tiến độ thật báo về; ba con
số mốc chỉ quyết định mỗi pha chiếm bao nhiêu của thanh. Sau khi chia pha, cùng file 48 phút
đó cho: `0.2 % (5,9 s) → 33 % (68 s) → 55 % (101 s) → 63,8 % → 72,3 % → 80,7 % → 89,2 % → 100 % (185 s)`.
Còn đúng một quãng ~33 giây không có nhịp nào (đuôi tiền xử lý + nạp model + VAD) vì phần đó
nằm trong `faster_whisper` và không hook được.

> **BẪY ĐÃ TRẢ GIÁ (nhánh macOS):** ở đó không có kênh NDJSON, phải đọc thanh tqdm của
> `mlx_whisper` trên stderr. Bản đầu bắt `"NN%|"` chung chung — thanh `Fetching 4 files: 100%`
> của `huggingface_hub` (kiểm tra model trong cache, xong tức thì) khớp NGAY dòng đầu và đẩy
> thanh lên 100 % **trước khi bóc băng bắt đầu**. Nay chỉ nhận thanh có đơn vị `frames/s`.
> Đường macOS đã port sang nhánh này cho khỏi lệch khi đồng bộ, nhưng CHƯA chạy thử được
> trên máy Mac.

### Ba chỗ lệch với nhánh macOS (CrabbyCut_v2.0.1)

**1. Kênh tiến độ ASR.** macOS = tqdm `frames/s` trên stderr (mlx_whisper). Windows = khoá
`ratio` trong NDJSON trên stdout (faster-whisper), chia pha như bảng trên. `runPythonSidecar`
giữ CẢ HAI đường nên một tệp chạy được cho cả hai nhánh.

**2. `chunkSpansForScene` (luật chia câu dài thành phụ đề ≤ 2 dòng + gán mốc theo từng từ)**
nằm ở `static/js/ai-video-panel.js` trên nhánh macOS và dùng chung với "Tạo video AI". Nhánh
Windows CHƯA có tệp đó, nên bản luật sống trong `static/js/auto-subtitle.js`. `cuesFromSegments`
vẫn ưu tiên `AiVideoPanel.chunkSpansForScene` nếu tệp kia được port sang, nên không bao giờ có
hai bản luật cùng chạy — nhưng **sửa luật thì phải sửa cả hai nhánh**.

**3. Vị trí textbox mặc định.** Trên macOS, `addTextItem()` khớp MỌI textbox mới vào lưới an
toàn (tự xuống dòng + neo cạnh dưới), kể cả nút "+Text". Trên nhánh Windows, theo quyết định
của người dùng (2026-09-13), nút "+Text" GIỮ NGUYÊN hành vi cũ (giữa khung, chữ "Text"); chỉ
text sinh tự động — tức khi nơi gọi truyền sẵn `options.text` — mới được khớp lưới. Cổng rẽ
nhánh nằm gọn trong `addTextItem`.

### Hai bẫy của ffmpeg trong bản trộn

- **`asplit` là bắt buộc.** Một pad đầu vào của ffmpeg chỉ được TIÊU THỤ MỘT LẦN. Lane chính
  40 clip cùng đọc `temp_input.mp4` mà viết `[0:a]` 40 lần là ffmpeg chết. Mỗi FILE một `-i`,
  rồi `asplit` đúng số mảnh cần.
- **`amix` phải `normalize=0`.** Mặc định nó CHIA cho số đầu vào: timeline 10 block thì lời
  thoại nhỏ đi 10 lần và Whisper nghe thành im lặng — hỏng không một dòng lỗi nào. Giữ nguyên
  mức rồi chặn đỉnh bằng `alimiter` (cắt đỉnh cũng làm ASR sai).

Âm lượng từng block được giữ nguyên theo phần trăm của nó, nên nhạc nền đặt nhỏ vẫn nhỏ trong
bản trộn và không át lời thoại. Đường dẫn nguồn đi bằng đối số `-i`, TUYỆT ĐỐI không vào chuỗi
filter: trong cú pháp filtergraph `\` là ký tự escape và `:` ngăn tham số, nên một đường dẫn
`C:\Users\...` nhét vào đó là hỏng filter mà thông báo lỗi không hề nhắc tới đường dẫn.

### Ba nguồn âm thanh

| Lựa chọn | Lấy gì |
| --- | --- |
| Toàn bộ timeline | lane chính + mọi block audio/video overlay đang bật tiếng |
| Chỉ lane chính (mặc định) | tiếng thu trực tiếp trong video |
| Chỉ lane âm thanh | tệp lồng tiếng / thu ngoài đặt ở lane dưới |

Mặc định đổi từ "Toàn bộ timeline" sang **"Chỉ lane chính"** (2026-09-14, theo yêu cầu người
dùng): nguồn đúng trong hầu hết dự án là tiếng thu trực tiếp của video, còn "Toàn bộ timeline"
trộn thêm nhạc nền vào cùng một bản trộn và Whisper bóc nhạc ra thành lời thoại ảo.

Mảnh lane chính trả `source: 'main'` và KHÔNG kèm đường dẫn: audio lane chính nằm trong bản
nối `temp_input.mp4` của backend (`clip.start/end` là mốc TRONG bản nối đó), và clip do luồng
"Lọc video theo kịch bản" sinh ra vốn không có `source_path` riêng.

### Ba chỗ riêng của Windows trong `backend/subtitle-jobs.js`

1. **Huỷ phải giết CẢ CÂY tiến trình** (`killProcessTree`). Giết tiến trình cha trên Windows
   KHÔNG giết con: sidecar Python tự sinh ffmpeg để tiền xử lý audio, nên `kill(python)` để lại
   một ffmpeg mồ côi giữ file WAV — lượt sau xoá file đó là EPERM. Dùng `taskkill /T /F`.
2. **Xoá file tạm phải có retry** (`rmQuiet`): Windows không cho xoá file đang có handle mở.
3. **`windowsHide` khi spawn** (cả ở `runPythonSidecar` và ở `run_ffmpeg_with_progress` /
   `probe_audio_seconds` trong sidecar Python, bằng `CREATE_NO_WINDOW`), nếu không mỗi lượt
   bóc băng nháy một cửa sổ console đen trước mặt người dùng.

### Cache

Khoá theo **kế hoạch trộn đã chuẩn hoá** (đường dẫn + mốc làm tròn ms + tốc độ + âm lượng của
từng mảnh) **+ mã ngôn ngữ**, KHÔNG theo file WAV — `mtime` của bản trộn luôn mới nên không
khoá được gì. Sửa một block trên timeline, hoặc đổi ngôn ngữ ở menu, là khoá đổi và cache
trượt đúng lúc nó phải trượt. Thiếu mã ngôn ngữ trong khoá thì đổi từ "vi" sang "ja" rồi bấm
"Tạo lại phụ đề" sẽ TRÚNG cache của lượt trước và trả về nguyên bản tiếng cũ — hỏng im lặng,
trông y như model bóc sai.

## Auto Subtitle đa ngôn ngữ — menu ngôn ngữ, font CJK, đồng bộ phụ đề (2026-09-14)

Ba việc thêm vào Auto Subtitle, theo yêu cầu người dùng. Đọc mục trên trước.

### 1. Menu ngôn ngữ, và vì sao danh sách hẹp hơn Whisper rất nhiều

Whisper nhận **99 thứ tiếng**, nhưng menu chỉ bày 5 + "Tự nhận diện": `vi`, `en`, `zh`, `ja`,
`ko`. Ràng buộc không nằm ở model mà ở **font**: ứng dụng chỉ vẽ được thứ tiếng có font trong
`EDITING_FONTS`. Bày ra tiếng Ả Rập rồi dựng 300 block toàn ô vuông thì tệ hơn hẳn là không
bày — người dùng mất trọn một lượt bóc băng mới biết.

Mã ngôn ngữ đi qua **ba tệp và cả ba phải khớp nhau**; lệch một mã thì backend lặng lẽ hạ về
`vi` và người chọn "日本語" nhận phụ đề tiếng Việt:

| Tệp | Hằng |
| --- | --- |
| `static/js/auto-subtitle.js` | `LANGUAGES` (menu, kèm font của từng ngôn ngữ) |
| `backend/server.js` | `SUBTITLE_LANGUAGES` (lọc trắng ở cửa API) |
| `asr/windows_faster_whisper_sidecar.py` | `SUPPORTED_LANGUAGES` (trừ `auto`) |

`tests/scripts/subtitle_language_fonts.js` canh đúng ba danh sách này.

**`language` trước đây ghim cứng `"vi"`** trong lời gọi `batched_model.transcribe()`. Ép sai
ngôn ngữ thì Whisper KHÔNG báo lỗi — nó **dịch** lời thoại sang thứ tiếng bị ép. Nay mã đi từ
menu xuống; `auto` → `language=None` (Whisper tự nhận diện). **Không truyền khoá `language`
thì sidecar vẫn giữ `"vi"`**, nên Upload → Transcribe và Magic Fill (hai đường không biết gì
về khoá này) chạy y hệt bản cũ.

**Tiếng Trung: Whisper chỉ có MỘT mã `zh`**, không tách giản thể/phồn thể. Bộ chữ đầu ra được
neo bằng `initial_prompt` viết bằng chính chữ giản thể (`SIMPLIFIED_CHINESE_PROMPT`) — đây là
cách chính thức của Whisper cho việc này, không phải mẹo vặt.

**Kịch bản chuẩn CHỈ gửi khi bóc tiếng Việt.** Kịch bản của dự án luôn là văn bản tiếng Việt;
ném nó vào lượt bóc tiếng Nhật/Hàn là mồi cho Whisper một ngữ cảnh SAI NGÔN NGỮ và nó sẽ chèn
chữ tiếng Việt vào giữa phụ đề — một dạng ảo giác tự mình tạo ra.

### 2. Font CJK — ba thứ phải sửa, không chỉ một

**(a) Thêm font.** 50 family sẵn có đều là bộ Latin của @expo-google-fonts, KHÔNG có một glyph
CJK nào. Thêm `Noto Sans SC/JP/KR` dạng **biến thiên** (một tệp, trục `wght` 100–900, tổng
~38MB thay vì ~250MB của bộ tĩnh). `editingFontFaceCss()` khai chúng bằng `font-weight: 100 900`
+ `format("truetype-variations")`; khai từng số một thì trình duyệt tải lại cùng tệp ấy 9 lần
mà vẫn chỉ vẽ được một độ dày.

Thiếu font là lỗi **âm thầm nhất trong cả nhóm này**: chữ được bake thành PNG bằng canvas của
renderer (`renderTextItemToPng`), nên font thiếu không ném lỗi — hàng ô vuông đi thẳng vào
video xuất ra, và không mở preview thì không ai biết. Vì thế bài test kiểm **tệp trên đĩa**,
không kiểm bảng khai.

**(b) Ngắt dòng cho chữ không có khoảng trắng.** `magicWrap` cắt bằng `split(/\s+/)`, nên cả
một câu tiếng Trung/Nhật ra ĐÚNG MỘT "từ": không có chỗ nào để xuống dòng. Hậu quả kép — phụ
đề tràn ra ngoài khung hình, VÀ `splitTextToMaxLines` không cắt nổi câu thành mảnh nên mất
luôn phép khớp mốc từng từ. Nay `wrapTokens()` coi **mỗi chữ CJK là một điểm ngắt**, giữ chuỗi
Latin nguyên vẹn như một từ, nối lại theo `token.space` (chèn dấu cách giữa hai chữ Hán là sai
chính tả, không chỉ xấu), kèm kinsoku tối giản: dấu câu đóng (`。、！？」`) không mở đầu dòng.
Text Latin thuần đi qua hàm này ra kết quả y hệt bản cũ.

**(c) Đo bằng ĐÚNG font sẽ vẽ.** `splitTextToMaxLines` nhận thêm `styleOverrides`. Không có nó
thì hàm đo bằng Nunito trong khi block lại vẽ bằng Noto Sans KR: đo thật cho thấy cùng một câu
tiếng Hàn rộng **1136px dưới Nunito nhưng 1039px dưới Noto Sans KR (~10%)** — đủ để lật một
dòng ở sát mép khổ, tức hàm hứa "tối đa 2 dòng" mà block vẽ ra 3.

### 3. Kiểu chữ mặc định của phụ đề

`subtitleTextStyle(language)` — **KHÔNG** sửa `defaultTextStyle()`. `defaultTextStyle()` là
kiểu của MỌI textbox mới, kể cả nút "+Text"; bật nền đen cho tất cả chỉ vì phụ đề cần nền là
đổi hành vi của một tính năng khác. Số liệu chốt theo nhánh "Tạo video AI" (v2.0.1) + ảnh tham
chiếu người dùng: **Nunito SemiBold (600), nền bật, `#000000`, bo góc 20, độ mờ 25%**, font đổi
theo ngôn ngữ. `bg_pad_x/y` để `null` = "Auto" (0.28·cỡ chữ ≈ 29,3% trên ảnh) — ghim số cứng
thì lề chữ↔mép nền sai ngay lần đổi cỡ chữ đầu tiên.

Style được truyền vào `addTextItem(placement, { style })` **ngay lúc tạo**, vì bề rộng gói dòng
và toạ độ Y được ĐO trên chính style đó. Cùng một hàm (`subtitleStyleFor`) dùng cho cả bước
chia mảnh lẫn bước dựng block — tính riêng hai lần là hai bộ số đo khác nhau cho cùng một thứ.

### 4. "Đồng bộ các subtitle" (kiểu CapCut)

Bật = sửa MỘT block phụ đề thì cả bộ đổi theo, cho cả kiểu chữ lẫn thông số ở subtab
"Biến đổi". **Mặc định BẬT.** Một video 10 phút ra 300+ block: tắt sẵn thì cú chỉnh cỡ chữ đầu
tiên là 300 thao tác tay, tính năng coi như không dùng được.

Cờ sống trong `subtitleState.sync_style`, không phải một biến riêng — nhờ vậy nó tự đi vào
`.crab`, tự đúng khi undo/redo và khi mở dự án khác (cùng lý do với mọi dữ liệu phụ đề khác).
Dự án cũ không có khoá này: `!== false` cho ra BẬT, khớp mặc định của bộ mới thay vì đẻ ra một
hành vi thứ ba.

Hai đường ghi, cả hai đi qua `subtitleSyncTargets()`:

| Đường | Hàm | Ghi gì |
| --- | --- | --- |
| Kiểu chữ (Typography + Text Style) | `textStyleTargets()` | `item.style` |
| Subtab "Biến đổi" (X/Y/Scale/Xoay/Opacity) | `applyTransformToSelected()` | `item.transform` / keyframe |

**KHÔNG đồng bộ** `item.text`, `timeline_start`, `duration`: đó là nội dung và mốc tiếng của
TỪNG câu — ghi đè cả nhóm bằng một giá trị là xoá dữ liệu, không phải "đồng bộ thuộc tính".
Đây đúng ranh giới `patchTextStyle` đã vạch sẵn. Block nằm trên lane KHOÁ bị loại ngay trong
`subtitleSyncTargets` — khoá lane là để chặn MỌI đường ghi, kể cả đường này.

Ô tích có ở hai chỗ, cùng đọc/ghi một cờ: đầu khối "Biến đổi" của panel Thuộc tính
(`#inspectorSubtitleSyncSection`, chỉ hiện khi block đang chọn là phụ đề) và trong panel
Auto Subtitle bên trái. Bật/tắt **không** ghi history: nó không đổi một pixel nào trên khung
hình, chỉ đổi cách các lượt chỉnh SAU đó lan ra — nhét vào undo/redo thì Ctrl+Z sau khi chỉnh
cỡ chữ lại hoàn tác cái nút thay vì hoàn tác cỡ chữ.

### 4b. Vòng đời dữ liệu phụ đề: dọn, đi theo tệp, đóng gói (2026-09-14)

**Ba loại dữ liệu, ba vòng đời khác nhau** — nhầm lẫn giữa chúng là nguồn của cả ba lỗi dưới:

| Dữ liệu | Ở đâu | Đi theo dự án? |
| --- | --- | --- |
| Bản bóc băng (`sessionSegments`) | `temp_uploads/session_segments.json` (runtime) **+ nhúng trong `.crab`** | ✅ đã có sẵn — lưu vào `.crab`, mở lên ghi lại qua `/api/project/reingest` |
| Sổ phụ đề (`subtitleState` + block text) | `history.editingState` trong `.crab` | ✅ đã có sẵn |
| Tệp `.srt` | cạnh `.crab`, cùng tên | ✅ từ bản này |
| `asr_cache/` | gốc ứng dụng | ❌ **cố ý** — xem dưới |

**`asr_cache/` KHÔNG được dọn theo dự án.** Nó khoá theo **nội dung** (kế hoạch trộn + ngôn
ngữ + engine, đã băm), không theo dự án, nên không có đường nào để kết quả của dự án này rơi
vào dự án khác. Dọn nó ở "Dự án mới" vừa vô nghĩa vừa mất đúng cái lợi của nó (bấm "Tạo lại
phụ đề" trả kết quả tức thì), và còn xoá cả cache của những dự án khác. Người dùng vẫn xoá
tay được ở bảng Cài đặt ("Kết quả bóc băng").

**Lỗi đã sửa 1 — "Dự án mới" giữ lại sổ phụ đề của dự án cũ.** `resetProjectState()` xoá
`editingItems` nhưng không xoá `subtitleState`, để lại một trạng thái KHÔNG TỒN TẠI THẬT:
`item_ids` trỏ vào những block vừa bị xoá, `cues` thì vẫn đầy. Ba hậu quả, nặng dần:
panel vẫn liệt kê phụ đề dự án cũ (`currentCues()` thấy `subtitleCuesFromItems()` rỗng nên
rơi về `cues`) → dòng "Tệp phụ đề:" trỏ vào thư mục dự án cũ → **và lượt Lưu ĐẦU TIÊN của dự
án mới ghi bộ cue cũ đó ra `<Dự án mới>.srt`**, vì `saveProject` luôn gọi `writeSrtFile`.
Dữ liệu dự án này trộn vào dự án khác, im lặng.

Đường *mở dự án khác* không dính vì `restoreEditingHistoryState` đặt lại khoá này — **trừ
khi** tệp `.crab` đời cũ không có `history`, lúc đó `if (history) restoreHistoryState(...)`
không chạy. Nên `performProjectLoad` cũng gọi `setSubtitleState(null)` để hai đường khớp nhau.

**Lỗi đã sửa 2 — `srt_path` không re-link.** Nó là đường dẫn tuyệt đối nằm trong `.crab`.
Kéo tệp `.crab` sang thư mục khác (hoặc chép sang máy khác) là nó trỏ vào hư vô. `.srt` nay
đi qua `resolveSubtitlePath()` lúc đọc tệp, ba nước:

1. đường dẫn **tương đối** (bản đã đóng gói) → giải theo thư mục chứa `.crab`, y như media;
2. đường dẫn tuyệt đối nhưng tệp **không còn** → nhận `"<tên .crab>.srt"` **nằm cạnh** `.crab`.
   Media phải bật hộp thoại re-link hỏi người dùng; `.srt` thì không cần, vì giao ước đặt tên
   (cùng tên, cùng thư mục với `.crab`) đủ để suy ra không mơ hồ;
3. không thấy gì → **xoá khoá**. Khác chính sách của media (media thiếu thì GIỮ đường dẫn
   tuyệt đối để còn re-link tay) vì `.srt` không phải tư liệu gốc — nó dựng lại được từ
   timeline ở lượt Lưu kế tiếp. Giữ một đường dẫn chết chỉ để panel hiện
   "Tệp phụ đề: D:\MayCu\…" là nói dối người dùng.

**Lỗi đã sửa 3 — Đóng gói bỏ quên `.srt`.** Nay gói ghi `<Tên gói>.srt` cạnh `<Tên gói>.crab`
và ghi `srt_path` tương đối.

`.srt` **KHÔNG** đi qua `eachPathSite()`. Đó là danh sách MEDIA, và mọi thứ trong đó bị
`collectMediaPaths` chép vào `Media/` rồi đổi tên cho khỏi trùng — làm vậy là phá đúng giao
ước "`.srt` nằm cạnh `.crab`, cùng tên" mà nước 2 của re-link đang dựa vào.

Nội dung `.srt` được renderer **DỰNG LẠI** từ block đang có trên timeline
(`AutoSubtitlePanel.currentSrtText()`) rồi truyền xuống main, **không chép tệp `.srt` cũ**:
tệp cũ có thể đã cũ hơn timeline (sửa phụ đề xong bấm "Đóng gói" mà chưa Lưu) hoặc không còn
trên đĩa (dự án chép từ máy khác). Đi qua đúng `currentCues()` như lượt Lưu nên hai đường
không bao giờ ra hai nội dung khác nhau cho cùng một timeline.

BOM UTF-8 + CRLF nay viết ở **một chỗ duy nhất** (`writeSrtTo` trong
`electron/project-package.js`), dùng chung cho cả lượt Lưu lẫn lượt Đóng gói — hai chỗ tự ghi
riêng là sớm muộn cũng lệch định dạng, mà `.srt` lệch định dạng thì vẫn "trông đúng" khi mở
bằng mắt.

**"Lưu thành" sang thư mục khác** đã đúng sẵn: `writeSrtFile` chạy SAU khi
`currentProjectPath` đổi, nên `.srt` được ghi cạnh `.crab` MỚI. Bản `.srt` cũ ở thư mục cũ
được giữ nguyên — đúng ngữ nghĩa "Lưu thành" là CHÉP, dự án cũ phải còn nguyên vẹn.

## Đóng gói dự án — bảng đoạn lane chính bị bỏ sót (2026-09-14)

**Triệu chứng người dùng báo:** mở bản đã đóng gói thì panel "Tệp phương tiện" có đủ video
nguồn, nhưng **lane chính rỗng trắng**, và **mọi block phụ đề dồn hết về mốc 0**.

**Nguyên nhân:** `eachPathSite()` trong `electron/project-package.js` liệt 5 chỗ có đường dẫn,
nhưng payload có **6**. Chỗ thiếu là `media.main_lane_segments[].source_path`.

Đo trên đúng tệp của người dùng: sau khi gói, `main_lane_concat[0]` đã thành
`Media/…mp4` còn `main_lane_segments[0].source_path` vẫn là
`C:\Users\…\OneDrive\…\Auto Subtitle\…mp4`. Lúc mở:

```
oldSegs = media.main_lane_segments   -> source_path = đường dẫn MÁY CŨ
newSegs = backend vừa nối trả về      -> source_path = đường dẫn TRONG GÓI
MainLane.rebaseRows(rows, oldSegs, newSegs)
  └─ news.findIndex(seg => seg.source_path === olds[idx].source_path)  -> -1
     └─ `continue`  ->  BỎ row
```

`rebaseRows` ghép hai bảng **theo `source_path`**. Không khớp một dòng nào nên nó `continue`
cho TỪNG clip → `latestTimeline = []` → lane chính rỗng. Timeline mất độ dài kéo theo mọi
block phụ đề vẽ ở mốc 0 — **đó là triệu chứng thứ hai, không phải lỗi thứ hai**: dữ liệu phụ
đề trong `.crab` vẫn nguyên vẹn (đo được: 131 block, mốc 0,04 → 953,52s).

Không một dòng lỗi nào được in ra. Đây đúng thứ mà chú thích đầu `eachPathSite` đã cảnh báo:
*"Thiếu một chỗ là mở bản đã gói lên vẫn còn một nhánh trỏ về máy cũ"* — chỉ là danh sách ấy
tự nó thiếu một chỗ.

**Cách sửa.** Thêm `eachMirrorPathSite()` cho những chỗ có đường dẫn nhưng **không** được
quyết định việc chép file:

| Chỗ | Vì sao không nằm trong `eachPathSite` |
| --- | --- |
| `media.main_lane_segments[].source_path` | Cùng bộ tệp với `main_lane_concat` — đưa vào danh sách chép là chép lặp, và `uniqueName()` có thể đặt cho nó một tên KHÁC với tên `main_lane_concat` đã nhận, tức `rebaseRows` vẫn trượt |
| `editingState.editingAssets[].source_path` | Chứa cả asset thư viện dựng sẵn (`source:'library'`, trong `library/` của ứng dụng) — thứ đi kèm bản cài, gói vào `Media/` là phình gói vì một thứ máy nào cũng có |

Đường dẫn nào không nằm trong bảng chép thì hàm `visit` trả nguyên văn, nên asset thư viện tự
được giữ tuyệt đối mà không cần thêm luật riêng.

`editingState.editingAssets[].path` **cố ý không đụng tới**: nó trỏ vào
`temp_uploads/editing_assets/` — thư mục runtime bị `/api/reset-project` xoá sạch ở mỗi lượt
mở dự án và được dựng lại bởi `reimportEditingAssets()`. Viết nó thành tương đối là trỏ vào
một tệp không hề có trong gói.

**Chốt chặn để không tái diễn.** `tests/scripts/project_package.js` nay có một bài **quét
TOÀN BỘ payload đã gói** tìm mọi chuỗi còn là đường dẫn tuyệt đối, với một danh sách trắng
hẹp (tệp đã mất + asset thư viện + đường dẫn runtime). Mọi assert khác đều phải biết trước
tên khoá để kiểm; chỉ bài này bắt được một chỗ MỚI PHÁT SINH mà không ai nhớ thêm vào
`eachPathSite()` — đúng cái đã xảy ra lần này.

## Xuất video chết vì trần độ dài dòng lệnh của Windows (2026-09-14)

**Triệu chứng:** toast `ffmpeg batch export failed`. Trong `reports/`, `stderr` chỉ có đúng
một câu: **`The command line is too long.`**

Đó là thông báo của **cmd.exe**, không phải của ffmpeg.

**Nguyên nhân.** `Run()` trong sidecar chạy lệnh bằng `std::system()`, mà trên Windows nó đi
qua `cmd.exe /c "…"` — **trần 8.191 ký tự**, trong khi `CreateProcess` cho tới 32.767.

Ba thứ cộng lại thành lỗi:

1. mỗi lớp phủ ảnh là một `-loop 1 -t <d> -i "<đường dẫn tuyệt đối>"` **trên dòng lệnh**;
2. đường dẫn tuyệt đối tới `temp_uploads/generated_text/` dài ~91 ký tự, trong khi phần thật
   sự phân biệt chỉ ~42 — phần tiền tố lặp lại 131 lần;
3. **khi dự án có lớp phủ, export KHÔNG chia batch.** `CommandExportVideo` có nhánh
   `if (!overlays.empty())` gọi thẳng `ExportBatch(…, 0, intervals.size(), …)`, vì chỉ số
   input của lớp phủ (`assetInputIndex`) là chỉ số TOÀN CỤC mà filtergraph tham chiếu bằng
   `[N:v]` — chia batch thì phải đánh số lại theo từng batch.

Kết quả đo trên dự án thật (131 phụ đề tự động): riêng phần `-i` đã **15.196 ký tự**, gần gấp
đôi trần. Ngưỡng gãy rơi vào **~70 lớp phủ** — một video chừng 8 phút có phụ đề tự động là đã
chạm, và không có cách nào biết trước.

**Cách sửa — hai tầng, cùng một hướng: làm cho dòng lệnh vừa trần.**

| | trần | ký tự / lớp phủ | sức chứa |
| --- | --- | --- | --- |
| trước | 8.191 (cmd.exe) | 116 (đường dẫn tuyệt đối) | **~70 lớp phủ** |
| sau | 32.766 (CreateProcessW) | 67 (đường dẫn tương đối) | **~489 lớp phủ** |

1. **Bỏ cmd.exe.** `RunIn()` gọi `CreateProcessW` trực tiếp. Được thêm một thứ nữa: dòng lệnh
   không còn qua bộ phân tích của shell nên `&`, `^`, `%`, `!` trong tên tệp của người dùng
   không bị diễn giải thành cú pháp shell.

   *Lưới an toàn:* `CreateProcessW` tìm chương trình theo PATH nhưng **không** áp dụng
   `PATHEXT` như cmd.exe (nó chỉ thêm `.exe`). Máy nào cài ffmpeg dạng `.cmd`/`.bat` shim thì
   rơi về `std::system()` như cũ — và chỉ rơi về khi **không khởi chạy được**, không phải khi
   lệnh chạy rồi trả mã lỗi.

2. **Đường dẫn lớp phủ dạng tương đối.** `ExportBatch` chạy ffmpeg với `cwd = tempDir`, và
   `ShortInputPath()` rút gọn những tệp nằm trong đó. Tệp ngoài `tempDir` (media người dùng
   liên kết từ nơi khác) giữ nguyên tuyệt đối. `source`, `output` và tệp kịch bản filter cũng
   giữ tuyệt đối nên không phụ thuộc `cwd`; đường dẫn **bên trong** kịch bản filter (LUT, mặt
   nạ) vốn đã tuyệt đối — xem `FilterPath`.

3. **Vượt cả trần mới thì nói thẳng.** `RunIn` trả lỗi ghi rõ số ký tự và nguyên nhân, thay
   vì để cmd.exe trả về một câu mà người dùng chỉ thấy dưới dạng "export thất bại".

> **`NOMINMAX` phải đặt TRƯỚC `<windows.h>`.** Không có nó, windows.h định nghĩa `min`/`max`
> thành **macro** và mọi `std::min(a, b)` trong tệp biến thành `std::(a, b)` — 11 lỗi biên
> dịch rải ở những dòng chẳng liên quan gì tới Windows.

**Hai tầng trên CHƯA đủ** — xem mục kế tiếp: trần thật sự không nằm ở độ dài dòng lệnh mà ở
chi phí duyệt chuỗi `overlay`, và nó được gỡ bằng cách chia lượt render theo thời gian.

`tests/scripts/export_many_overlays.js` xuất **thật** một video 131 lớp phủ rồi **lấy mẫu
điểm ảnh** để chắc lớp phủ có mặt trong khung hình — đếm ký tự thì không chứng minh được rằng
đường dẫn tương đối trỏ đúng tệp, mà sai `cwd` thì ffmpeg có thể bỏ lớp phủ thay vì báo lỗi.

## Gỡ trần: chia lượt render theo thời gian khi dự án có lớp phủ (2026-09-14)

Mục trên đẩy trần dòng lệnh từ ~70 lên ~489 lớp phủ. Nhưng **trần thật sự không nằm ở độ dài
dòng lệnh.**

### Đo trước, sửa sau

Mọi lớp phủ được nối thành **một** chuỗi `overlay`: `[mainv] → ov0 → ov1 → …`. Mỗi khung hình
đầu ra phải đi qua **toàn bộ** chuỗi, kể cả những lớp đang tắt. Đo trên video 30s 720p, mỗi
lớp phủ hiện 0,8s:

| lớp phủ | dòng lệnh | thời gian | tốc độ |
| ---: | ---: | ---: | ---: |
| 50 | 3.607 | 1,3s | x23,7 |
| 131 | 8.500 | 1,5s | x20,3 |
| 300 | 18.809 | 3,5s | x8,7 |
| 600 | 37.109 | 13,8s | x2,2 |
| 1.200 | 73.911 | **hỏng** — vượt cả trần 32.766 của CreateProcess | |

Chi phí đi theo **(số khung × số lớp phủ)**. Ngoại suy cho video **3 giờ** với ~1.500 phụ đề:
324.000 khung × 1.500 ≈ **486 triệu lượt duyệt ≈ 3,5 giờ** chỉ để đi qua chuỗi, chưa tính
encode. Gỡ trần dòng lệnh không cứu được ca này.

### Chia theo THỜI GIAN, không phải theo clip

Cách chia sẵn có (`batchSize = 80` interval) không cắt được gì cho dự án phụ đề: dự án thật
đo được có **đúng một** interval dài 964s. Nên `PlanOverlayBatches()` cắt theo trục thời gian,
nhịp mục tiêu 180s, và chỉ cắt khi phim dài hơn 240s.

**Cắt ở đâu mới an toàn** — ba điều kiện, thiếu một là hình hoặc hiệu ứng sai:

1. đúng **biên khung** (xem `BuildTimelineFrameGrid`) — `SplitIntervalAtFrame()` chia
   `renderFrames` thành hai số nguyên cộng lại bằng số cũ, nên lưới khung không xê dịch;
2. **không cắt vào giữa một clip có hoạt ảnh/keyframe** — biểu thức của clip neo theo thời
   gian *cục bộ* của clip, cắt đôi là nửa sau chạy lại hiệu ứng từ đầu (`IntervalIsTimeVarying`);
3. **không cắt qua một lớp phủ có hoạt ảnh/keyframe** — cùng lý do (`OverlayIsTimeVarying`,
   tính cả chuỗi khung hoạt ảnh: nội dung nó đổi theo khung nên xén đầu là lệch pha).

Lớp phủ **tĩnh** (ảnh phụ đề, hình khối, watermark) vắt qua mốc cắt thì **xén được** — nội
dung không đổi theo thời gian nên cắt cho vừa cửa sổ là tương đương hệt. Không tìm được mốc
an toàn thì batch dài thêm; xấu nhất là quay về đúng hành vi cũ.

`OverlaysForBatch()` dời `timelineStart` về gốc toạ độ của batch và **đánh số input lại** —
filtergraph tham chiếu input bằng chỉ số (`[N:v]`), không bằng tên. Mọi thứ khác (hoạt ảnh,
keyframe, chỉnh màu, fade) tự đúng theo, vì tất cả đều neo vào `overlay.timelineStart`.

### Tiếng chạy MỘT lượt liền mạch

Đo được: nối hai đoạn AAC bằng `-c copy` làm tổng thời lượng dài thêm **23ms mỗi mối ghép**
(priming + padding của AAC — 10,000s thành 10,023s). Video 3 giờ chia 60 batch là gần 1,4
giây trôi dồn, kèm một chỗ ngắt tiếng nghe được ở **mỗi** mối.

Nên: mỗi batch render `FilterScriptMode::VideoOnly`, cộng **đúng một** lượt `AudioOnly` trên
toàn bộ timeline, rồi ghép `-c copy` cả hai. Hình `-c copy` nối chính xác từng khung nên chia
bao nhiêu cũng không mất gì. Việc này còn **sửa luôn** vấn đề cũ của đường batch >80 clip.

`-vn`/`-an` trong `AppendStreamMapArgs` là **bắt buộc**: ở chế độ VideoOnly filtergraph không
có nhãn `[a]`, mà ffmpeg vẫn tự nhặt rãnh tiếng của input 0 nếu không cấm — bản xuất ra có
tiếng *chưa qua bộ lọc* (sai âm lượng, chưa khử ồn, thiếu tiếng lớp phủ). Hỏng kiểu đó phải
nghe mới biết.

> **BẪY ĐÃ TRẢ GIÁ:** bản đầu truyền **nguyên bộ** lớp phủ vào lượt chỉ-tiếng.
> `OverlayNeedsInput()` trả true cho mọi lớp phủ không phải text có đường dẫn — tức cả ảnh
> phụ đề — nên lượt ấy nạp đủ 720 ảnh PNG bằng `-i`, vừa vô nghĩa (không ảnh nào có rãnh
> tiếng) vừa nổ dòng lệnh y như lỗi ban đầu. Triệu chứng đánh lạc hướng: 10 phút phim chạy
> tốt, 30 phút trở lên hỏng sạch, mà lỗi lại chỉ vào lượt render tiếng.
> `OverlaysForAudioPass()` lọc còn những cái thật sự có tiếng rồi đánh số lại.

### Đo lại sau khi chia

Mật độ phụ đề **24/phút** — gấp 3 lần dự án thật (131 phụ đề / 16 phút ≈ 8/phút), cố ý lấy
khắc nghiệt. Nguồn 320x180 30fps nên số tuyệt đối không phải thời gian render thật của phim
HD; cái cần đọc ở đây là **cột cuối**: chi phí trên mỗi phút phim gần như KHÔNG tăng theo độ
dài, tức đã hết nhân lên.

| phút phim | phụ đề | lượt render | thời gian | giây / phút phim |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 240 | 4 | 12,7s | 1,27 |
| 30 | 720 | 10 | 45,3s | 1,51 |
| 60 | 1.440 | 20 | 100,9s | 1,68 |
| 120 | 2.880 | 40 | 276,0s | 2,30 |

So với bản chưa chia: 30 phút trở lên **không xuất được** (dòng lệnh vượt trần), và nếu có
vượt được thì chi phí duyệt chuỗi đi theo tích (số khung × số lớp phủ) chứ không theo tổng.

**Còn lại gì.** Vòng dò mốc cắt chỉ tìm trong cửa sổ `kOverlayBatchScanSeconds` (90s); không
thấy chỗ an toàn thì batch dài thêm. Dự án có lớp phủ **hoạt ảnh phủ trọn phim** (watermark
động) vì thế vẫn chạy một lượt — chậm như cũ, nhưng ĐÚNG, và bài test chốt đúng hành vi lùi
đó. Muốn gỡ nốt thì phải cho phép cắt qua lớp phủ biến thiên bằng cách dời cả biểu thức của
nó theo mốc batch — việc riêng, chưa làm.

### Năm thứ bài test chốt

`tests/scripts/export_long_subtitles.js` xuất **thật** một phim 600s có 240 phụ đề (chia 4
lượt) và chốt:

1. **thời lượng không trôi** qua các mối ghép (cắt sai biên khung là lệch vài khung mỗi mối);
2. **phụ đề hiện đúng mốc** — lấy mẫu điểm ảnh ở 24 điểm *có* và 23 điểm *không*, trải đều cả
   phim. Đây là chốt quan trọng nhất: dời sai `timelineStart` hay đánh số input sai thì phụ đề
   vẫn "có", chỉ là hiện sai lúc, và bản xuất trông vẫn hoàn toàn bình thường;
3. **tiếng liền mạch** và khớp hình (bản xuất phải CÓ rãnh tiếng — quên `-an` ở chế độ
   VideoOnly là tiếng đi thẳng từ input 0, chưa qua bộ lọc);
4. **phim ngắn vẫn chạy một lượt** như cũ;
5. **nhánh lùi**: watermark có hoạt ảnh phủ trọn phim thì bộ hoạch định phải NHẬN RA là không
   cắt được và quay về một lượt — im lặng cắt bừa mới là hỏng.

## Tệp đi kèm dự án: .srt và .proxy.mp4 (2026-09-14)

Một dự án gồm nhiều hơn tệp `.crab`. Hai tệp đi kèm, **cùng một giao ước**: nằm cạnh `.crab`,
mang đúng tên `.crab`.

| Tệp | Nội dung | Cách sinh ra |
| --- | --- | --- |
| `<Tên>.srt` | phụ đề | **dựng lại** từ block trên timeline ở mỗi lượt Lưu / Đóng gói |
| `<Tên>.proxy.mp4` | bản proxy xem trước của lane chính | **chép tệp** — nó là kết quả encode hàng phút, không sinh ra từ payload được |

Giao ước đặt tên không phải để cho gọn: nó là thứ khiến ta **suy ra được** vị trí mới khi
người dùng kéo tệp `.crab` sang thư mục khác, và khiến lần ghi sau **đè** lên bản cũ thay vì
rải ra một đống tệp mồ côi. Vì vậy chỉ có **một** hàm dựng tên — `projectSidecarPath()`.

### Vì sao proxy đáng mang theo

Proxy được dựng từ `temp_input.mp4` — **file nối**, mà file nối bị dựng LẠI ở mỗi lượt mở dự
án, nên proxy cũng bị encode lại từ đầu. Video 16 phút 1440p mất vài phút, **mỗi lần mở**.

### Danh tính — thứ khiến việc dùng lại proxy an toàn

Dùng lại một proxy đã lưu là một phép đánh cược: nếu bản nối mới khác bản cũ (ffmpeg đổi
phiên bản, nguồn được chuẩn hoá lại) thì khung xem trước chiếu một phim còn bản xuất ra một
phim khác — **lệch im lặng**, người dùng chỉ phát hiện sau khi xuất xong. Đổi lại, từ chối
nhầm chỉ tốn vài phút encode. Cán cân đó quyết định mọi thiết kế dưới đây: **thà từ chối
nhầm còn hơn nhận nhầm.**

`media.preview_proxy` trong `.crab` mang **danh tính + dung lượng, KHÔNG mang đường dẫn**:

```js
{ identity: { version, concat_version, size_bytes, duration_ms, width, height },
  size_bytes: <dung lượng tệp proxy> }
```

`identity` lấy **từ chính file nối**, không phải từ danh sách nguồn: bốn số đó là hệ quả của
mọi thứ tạo ra nó (bộ nguồn, thứ tự nối, phiên bản ffmpeg, luật chuẩn hoá). Không băm nội
dung — file nối cỡ vài trăm MB tới vài GB, băm ở mỗi lượt mở là đánh đổi sai chỗ.

Không lưu đường dẫn vì đường dẫn được **suy ra** từ chỗ đặt `.crab` lúc mở
(`resolvePreviewProxyPath`). Nhờ vậy chép cả thư mục dự án đi đâu cũng đúng, và không có cảnh
payload hứa một tệp mà lượt chép ngay sau đó lại thất bại.

### Năm cửa của `tryAdoptPreviewProxy()`

1. tệp có thật, là `.mp4`, kích thước > 0;
2. `identity` khớp **tuyệt đối** file nối **vừa dựng** (không phải file nối lúc lưu);
3. **dung lượng** tệp proxy khớp đúng từng byte con số đã ghi lúc lưu;
4. **thời lượng** tệp proxy khớp thời lượng file nối trong vòng 0,05s (chặt hơn một khung);
5. chép được vào `temp_uploads`.

**Cửa 3 được thêm SAU KHI đo thấy lỗ, không phải đề phòng suông.** Bản đầu chỉ có cửa 4, và
một tệp proxy bị cắt cụt còn 40KB **vẫn lọt qua**: MP4 để `moov` ở đầu tệp nên ffprobe đọc ra
đủ 6,023s từ **metadata** dù phần dữ liệu đã mất. Thời lượng là thứ tệp **tự khai**; dung
lượng thì không nói dối được. Ngược lại cửa 3 không thay được cửa 4: một tệp proxy hoàn chỉnh
nhưng của bản nối khác có thể tình cờ cùng dung lượng.

Trượt cửa nào cũng **im lặng encode lại**. Hàm này không bao giờ ném — nó là đường tối ưu,
hỏng ở đây chỉ được phép làm chậm, không được làm mở dự án thất bại.

### Nhận và encode đi chung MỘT lượt gọi

```js
const previewProxy = tryAdoptPreviewProxy(req.body?.preview_proxy, concatPath)
  || queuePreviewProxy(concatPath);
```

Tách thành hai lượt gọi thì giữa chúng có một khoảng mà `queuePreviewProxy` đã chạy rồi, và
hai đường cùng ghi vào `temp_uploads/preview_proxy.mp4` — kết quả tuỳ lượt nào xong sau, tức
là không tất định.

### Lưu vẫn nhẹ như cũ

Lượt Lưu gọi `saveProjectProxySidecar()` **không `await`**: tệp `.crab` đã ghi xong trước đó,
và proxy là thứ dựng lại được. Chép ~100MB mà bắt người dùng đứng chờ là phá đúng nguyên tắc
sẵn có *"Đóng gói là hành động riêng, Lưu vẫn nhẹ như cũ"*.

Lượt Lưu thứ hai trở đi thấy đã có bản **đúng dung lượng** thì không chép lại gì. So bằng
dung lượng chứ không `mtime` — chép tệp làm mới `mtime` nên `mtime` luôn khác, còn proxy của
cùng một bản nối thì luôn cùng dung lượng. Tính đúng đắn do danh tính trong `.crab` chốt,
không phải do phép so này.

Chép ra `<đích>.part` rồi mới `rename`: "tệp tồn tại" phải **đồng nghĩa** "đã chép xong",
nếu không tắt ứng dụng giữa chừng để lại một mp4 cụt và lượt mở sau nhận đúng nó (cửa 3 bắt
được, nhưng đừng dựng ra tình huống để phải nhờ nó).

### 5. Lọc chất lượng segment phải biết đếm chữ CJK

`segment_quality_flags()` đo tốc độ nói bằng `re.findall(r"\w+", text)`. Với tiếng Trung/Nhật
viết liền, cả câu khớp ĐÚNG MỘT lần: câu 3 giây ra 1 "từ" = 0,33 từ/giây, dưới ngưỡng
`min_wps` 1.0 → câu nào cũng dính cờ `abnormal_speech_rate`; ghép thêm một cờ bất kỳ nữa là
`annotate_and_filter_segments` **ném bỏ** câu đó. Phụ đề CJK mất câu, và mất âm thầm (segment
bị lọc trước khi tới renderer). `count_speech_units()` đếm mỗi chữ CJK là một đơn vị, nhờ đó
tốc độ đọc thật (~4–7 chữ/giây) rơi đúng vào dải 1.0–8.0 đang dùng — không phải nới ngưỡng
riêng cho từng ngôn ngữ.

### Tệp `.srt`

Ghi ở main process (`ipcMain.handle('subtitle-save-srt')`): renderer không có quyền ghi đĩa,
còn backend thì KHÔNG BIẾT dự án đang lưu ở đâu — đường dẫn `.crab` chỉ sống trong renderer +
main. Tên lấy đúng tên `.crab` nên hai thứ đi thành cặp và lần ghi sau ĐÈ bản cũ. Ghi kèm BOM
UTF-8 **và xuống dòng CRLF**: chuẩn SubRip dùng CRLF, và không có BOM thì nhiều trình phát (kể
cả Notepad của Windows) đọc tiếng Việt thành mojibake.

Ghi ở HAI thời điểm: ngay khi tạo xong phụ đề (im lặng, bỏ qua nếu dự án chưa Lưu lần nào), và
ở MỌI lượt Lưu dự án — đó là lúc duy nhất chắc chắn bản trên đĩa khớp thứ người dùng đang thấy.
Lỗi ghi `.srt` KHÔNG tính là lưu thất bại (tệp `.crab` đã ghi xong).

### Cách kiểm chứng

Đo trên máy thật: Windows 10, GTX 1060 (6 GB), `faster-whisper large-v3-turbo`, int8, batch 8;
backend cô lập (`CRAB_TEMP_DIR` + `CRAB_CONCAT_CACHE_DIR` riêng, cổng 8124), UI mở trong trình
duyệt. Nguồn: một video tiếng Việt 11,2 s và bản nối 90 s của chính nó.

| Việc | Kết quả |
| --- | --- |
| Bóc băng video 11,2 s | 1 câu, đúng chữ, 11 mốc từng từ |
| Thanh tiến trình một lượt thật (timeline 83 s) | `22 % → 34 % → 52 % → 63 % → 100 %` trong 19 s |
| Trước khi chia pha (48 phút audio) | đứng im ở 22 % suốt 108 s rồi nhảy thẳng lên 96 % |
| Chạy lại y hệt timeline | `cache_hit: true` |
| Đổi một block rồi chạy lại | `cache_hit: false` — khoá theo kế hoạch trộn, trượt đúng lúc |
| 9 block phụ đề trên timeline | preview hiện đúng chữ ở đáy khung (`position_y` neo lưới an toàn) |
| Ctrl+Z một lần | trả lại CẢ 9 block + `subtitleState` |
| "Xoá phụ đề" | gỡ đúng 9 block phụ đề, textbox người dùng tự đặt còn nguyên |
| Nút "+Text" | vẫn ở giữa khung, chữ "Text" (`position_y: 0`) — đúng quyết định lệch #3 |
| Tệp `.srt` ghi ra | có BOM UTF-8, chỉ CRLF, tên trùng tên `.crab`, tiếng Việt đọc đúng |

```
npm run test:auto-subtitle   kế hoạch trộn (asplit/adelay/amix normalize=0/atempo) + .srt +
                             chia phụ đề + hợp đồng tiến độ sidecar ⇄ backend
```
