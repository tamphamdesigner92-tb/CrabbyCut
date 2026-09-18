# BÀN GIAO — Tính năng Retouch (làm đẹp khuôn mặt)

> File TẠM. Chi tiết kỹ thuật đầy đủ nằm ở
> [APP_INTERNALS.md](APP_INTERNALS.md) mục **"Retouch (Làm Đẹp Khuôn Mặt)"** —
> file này chỉ nói **còn thiếu gì**. Xoá file này khi hết mục 2.

Cập nhật: 2026-08-07 · Nhánh `CrabbyCut_v1.0.6`

---

## 1. TÌNH TRẠNG MỘT DÒNG

Retouch chạy đủ (preview + export) ở **lane chính**, **ảnh tĩnh overlay** và
**overlay video**. Còn hở đúng hai chỗ, đều đã biết và đều có báo cho người dùng:
đoạn overlay đang **mờ dần** thì không vá được, và ca có **hiệu ứng không gian** thì
overlay bị bỏ qua (lane chính đã tự chuyển sang bake cả khung).

---

## 2. CÒN THIẾU

### 2.1. ~~Chạy thử một lượt XUẤT THẬT~~ — ĐÃ CHẠY (2026-08-06)

Đã xuất thật một dự án 14 block / 10 block có retouch. **Mép miếng vá không lộ ở bất kỳ
khung nào** — phần retouch tự nó đúng.

Lượt xuất đó lòi ra một lỗi **NGOÀI retouch**: bản xuất có một hình chữ nhật lệch khung
quanh mặt, đúng 1 khung ở cuối một block. Nguyên nhân là LƯỚI KHUNG HÌNH của timeline
lệch giữa frontend và sidecar, khiến miếng vá của block N+1 dán lên khung cuối block N;
Auto-Reframe (mỗi block một transform) là thứ làm nó lộ thành hình chữ nhật. Đã sửa, có
test `npm run test:frame-grid`. Chi tiết + 3 cái bẫy khi sửa:
[APP_INTERNALS.md → Lưới Khung Hình Của Timeline Khi Export](APP_INTERNALS.md#lưới-khung-hình-của-timeline-khi-export-đã-sửa-2026-08-06).

CÒN LẠI ở mục này: chưa thử ca có **hiệu ứng không gian** (vignette / hạt / nét / mờ),
tức đường tự chuyển sang bake CẢ KHUNG. Lượt xuất vừa rồi chỉ đi đường vá vùng mặt.

### 2.2. ~~Ảnh tĩnh overlay~~ — ĐÃ LÀM (2026-08-07)

Sidecar nhận ảnh và trả MỘT khung landmark (`track_retouch_still`, bộ dò
`static_image_mode=True` RIÊNG), `retouchFacesAt` kẹp chỉ số về 0, và khâu xuất bake ảnh
đã retouch. Đo được: landmark của đường ảnh khớp đường video trên cùng một khung tới
0.42 px trung bình / 1.67 px lớn nhất (bề rộng 1728). Test `npm run test:retouch-still`.
Chi tiết: [APP_INTERNALS.md → Ảnh tĩnh overlay](APP_INTERNALS.md#retouch-làm-đẹp-khuôn-mặt--chạy-đủ-preview--export--media-overlay).

### 2.3. ~~Retouch cho overlay VIDEO khi XUẤT~~ — ĐÃ LÀM (2026-08-07)

`appendOverlayRetouchItems` vá vùng mặt cho overlay video, phép đặt lớp lấy từ chính item
nên xoay/keyframe/hoạt ảnh dịch chuyển tự đúng. Hợp đồng đặt lớp với sidecar đã khoá bằng
test chạy FFmpeg thật (`npm run test:overlay-placement`), z-order khoá bằng
`testOverlayPatchStacking`. Chi tiết + các ca bị bỏ qua:
[APP_INTERNALS.md → Overlay video khi xuất](APP_INTERNALS.md#retouch-làm-đẹp-khuôn-mặt--chạy-đủ-preview--export--media-overlay).

CÒN LẠI ở mục này — **khung nào lớp chưa đục hoàn toàn thì không vá được** (miếng vá đè
lên item gốc nên mặt chưa retouch ở dưới lộ qua và trộn hai lần). Hiện bỏ qua đoạn mờ dần
và báo ra. Muốn làm trọn thì miếng vá phải biết NỀN phía dưới, tức phải bake cả khung tổng
hợp — đắt hơn hẳn, và chỉ đáng làm nếu người dùng thật sự gặp.

### 2.4. Nếu cần nhanh hơn nữa

Raster mặt nạ + hai tầng mờ còn ~40 ms/khung ở lưới 256 (CPU). Đưa lên GPU thì gần như
hết, nhưng phải thêm shader tích chập và đối chiếu lại với `blurRgbBoxCascade` — nếu
không preview lệch bản xuất. Hiện lúc phát đã đủ mượt (41-81 fps) nên chưa cần.

---

## 3. BỐN QUYẾT ĐỊNH ĐÃ CHỐT — đừng mở lại nếu không có lý do mới

1. **Gắn theo BLOCK** (`clip.retouch` / `item.retouch`), không phải một lớp riêng.
2. **Mọi phép chạy trong LƯỚI CỤC BỘ CỦA MẶT.** Ràng buộc CỨNG, không phải tối ưu:
   shader tích chập của dự án có MAX_TAPS=33 (bán kính ≤16px) mà bán kính thô ở nguồn
   1728×3072 là 29.1px — vượt trần. Trong lưới cục bộ nó còn 14.0px ở MỌI độ phân giải.
3. **Thứ tự: BIẾN DẠNG → TÁCH TẦN SỐ → MÀU CỤC BỘ**, và retouch chạy **trước** chuỗi
   chỉnh màu. Cả ba phi tuyến nên đảo thứ tự là ra kết quả khác.
4. **Landmark KHÔNG vào `.crab`** — suy ra được từ video nên chỉ là cache.

---

## 4. BẢY CÁI BẪY ĐÃ TRẢ GIÁ — đọc trước khi sửa

1. **Ảnh lộn ngược.** Gốc toạ độ framebuffer WebGL ở dưới-trái, canvas thì hàng 0 ở trên.
   Vertex shader phải là `vUv = vec2(aPos.x*0.5+0.5, 0.5 - aPos.y*0.5)`.
   **Trang đối chiếu GLSL↔JS KHÔNG bắt được lỗi này** (readPixels cũng dưới-lên nên hai
   bên dùng chung quy ước ngược, tự triệt tiêu — vẫn báo 0.97/255 rất đẹp).
   → *Đối chiếu công thức không thay được chạy thật một lần trên ảnh thật.*
2. **Lỗi ĐƠN VỊ, hai lần.** `freqRadii` nhân tỉ lệ theo *chiều rộng* với pixel *chiều cao*.
   `faceScale`/bán kính warp trộn UV thô với không gian pixel. Unit test chỉ kiểm **tỉ lệ**
   nên qua hết; phải kiểm **trị tuyệt đối**.
3. **Gấp ảnh khi biến dạng.** Điểm điều khiển chồng nhau cộng dồn → gradient ≥1 → rách mép
   hàm. Dùng trung bình có trọng số × trọng số lớn nhất; `warpMaxGradient()` giữ < 0.6.
4. **Lỗ khoét bị lấp.** Viền và lỗ phải raster riêng, lỗ làm mượt nhẹ hơn
   (`HOLE_FEATHER_SCALE`), nếu không "trắng da" bay mất chân mày.
5. **Chỉ số FaceMesh chép sai không nhìn ra được.** Test kiểm bằng **hình học trên landmark
   thật**. Giữ cách đó khi thêm vùng mới.
6. **Chẩn đoán nhầm "chậm" thay vì "đứng hình".** Bản bàn giao trước ghi retouch "chưa đủ
   mượt khi phát" và quy cho raster + tầng mờ. Đo ra thì hai khâu đó chỉ chiếm 40/43 ms,
   còn nguyên nhân THẬT là `resizeAndRender` **không hề được gọi lúc phát** → preview đứng
   hình. → *Đo từng khâu trước khi tối ưu; con số trong tài liệu cũ cũng phải nghi ngờ.*
7. **`willReadFrequently: true` làm CHẬM đi.** Nó biến canvas thành canvas phần mềm:
   `drawImage` từ video 1728×3072 tốn 11.4 ms thay vì 0.1 ms, trong khi `getImageData`
   256² chỉ tốn 0.9 ms. Chrome vẫn cảnh báo trên console — cảnh báo đó SAI với ca này.

---

## 5. CẢNH BÁO NGOÀI RETOUCH — `npm test` từng XOÁ DỮ LIỆU DỰ ÁN

`tests/scripts/backend_smoke.js` gọi `POST /api/reset-project` và
`tests/scripts/export_smoke.js` chạy `fs.rmSync(temp_uploads, {recursive:true})` —
cả hai trước đây chạy trên thư mục tạm THẬT, tức chạy `npm test` một lần là mất sạch
`temp_input.mp4`, `preview_proxy.mp4`, toàn bộ file nguồn đã nhập và
`session_segments.json` của dự án đang mở. **Đã xảy ra thật ngày 2026-08-06.**

Đã sửa: cả hai test đặt `CRAB_TEMP_DIR` sang `test_temp/` riêng (đặt TRƯỚC khi
`require` server). Lưu ý tên thư mục **không được bắt đầu bằng dấu chấm** — `res.download`
đi qua `send`, mà `send` trả 404 cho mọi đường dẫn có đoạn thư mục dạng dotfile.

Khi thêm test mới có đụng backend: luôn đặt `CRAB_TEMP_DIR` trước khi require server.
