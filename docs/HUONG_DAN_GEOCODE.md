# Hướng dẫn GeoCode

GeoCode (tab **Hình học › GeoCode**) biến mã bạn viết thành **ảnh** hoặc **video** có nền trong suốt, rồi đặt lên lane Hình khối như một block.

## 1. Chọn ngôn ngữ nào?

| Ngôn ngữ | Chọn khi | Không hợp khi |
|---|---|---|
| **HTML/CSS/JS** | Nút, banner, lower third, thẻ chữ, logo chữ — thứ có **bố cục, chữ, bo góc, đổ bóng, gradient**, hiệu ứng CSS | Hình học tự do, hạt, vẽ theo công thức |
| **JavaScript canvas** | Hình vẽ theo công thức: vòng tròn, sóng, hạt, đồ thị chạy, hoạ tiết lặp | Cần nhiều chữ dàn trang (canvas phải tự căn chữ) |
| **Python** | Xử lý ảnh, mảng số, biểu đồ (Pillow, numpy, matplotlib) | Hiệu ứng UI đơn giản (HTML nhanh và an toàn hơn) |

Gợi ý nhanh: **có chữ → HTML · có công thức → canvas · có dữ liệu/biểu đồ → Python.**

> Python chạy bằng Python thật của máy, **toàn quyền** như người dùng. Chỉ chạy mã bạn tin. Trên Mac cần cài trước: `python3 -m pip install pillow numpy`.

## 2. Giới hạn chung

- Kích thước: **16–4096 px** mỗi cạnh. Khung dựng đúng W×H, không co giãn.
- Video: fps **1–60**, tối đa **3600 khung** (60 s @60 fps, 120 s @30 fps).
- Mã tối đa 512 KB. Mỗi khung HTML/canvas phải xong trong **8 giây**; khung Python đầu tiên trong 60 giây.
- **Ảnh** = chụp đúng một khung tại `t = 0`.
- Nút **Xem thử** dựng một khung tại giây `t` (thanh trượt) — dùng để sửa nhanh trước khi Tạo.

## 3. Quy tắc vàng (để mã chạy không lỗi)

1. **Mọi chuyển động tính từ `t` (giây).** Đừng cộng dồn biến kiểu `x += 2` mỗi khung — Xem thử chỉ dựng một khung nên sẽ ra hình khác bản thật.
2. **Không dùng `Math.random()` / `random` trần** — mỗi lần dựng ra kết quả khác. Dùng hàm ngẫu nhiên có seed cố định.
3. **Muốn nền trong suốt thì đừng tô nền** (không đặt `background` cho `body`, không `fillRect` toàn khung, Python dùng `RGBA` với alpha 0). Muốn nền màu thì chọn **Nền › Màu** trong pane.
4. **Video lặp mượt:** cho chuyển động tuần hoàn theo đúng thời lượng, ví dụ `sin(2π·t/duration)`.
5. **Ảnh tĩnh:** đừng để hiệu ứng mở màn bắt đầu từ `opacity: 0` — ảnh chụp tại `t = 0` sẽ trống.

## 4. Cấu trúc từng ngôn ngữ

### HTML/CSS/JS

- Viết đoạn HTML (`<style>` + thẻ) hoặc trọn trang `<html>`. `html, body` đã có sẵn cỡ W×H, `margin: 0`, `overflow: hidden`.
- Chuyển động: CSS `@keyframes`/`transition`, `element.animate()`, `requestAnimationFrame`, `setTimeout`, `Date.now()` — tất cả chạy theo **đồng hồ ảo** nên khung luôn đúng.
- Điều khiển chính xác theo khung: `geocode.onFrame((t, frame) => { ... })`. Có sẵn `geocode.width`, `geocode.height`, `geocode.fps`, `geocode.duration`.
- Phông/thư viện qua **https** (Google Fonts, CDN) dùng được. **Bị chặn:** `file://`, `localhost`, mở cửa sổ mới, chuyển trang. Ảnh cục bộ → dùng data URI.

```html
<style>
  .tag { position:absolute; inset:16px; display:flex; align-items:center; justify-content:center;
         border-radius:24px; background:#ff5a36; color:#fff; font:700 56px Arial, sans-serif;
         animation: pop 1s ease-in-out infinite alternate; }
  @keyframes pop { from { transform:scale(.95) } to { transform:scale(1) } }
</style>
<div class="tag">SUBSCRIBE</div>
```

### JavaScript canvas

- **Bắt buộc** khai `function draw(ctx, t, width, height, frame)`. Được gọi mỗi khung, canvas **đã xoá sẵn**. Có thể `async`.
- `canvas`, `ctx`, `width`, `height` **đã có sẵn** — **không khai lại** (`const width = …` gây lỗi cú pháp).
- Chỉ viết JavaScript, không viết thẻ HTML.

```js
function draw(ctx, t, width, height) {
  const r = Math.min(width, height) * (0.3 + 0.08 * Math.sin(t * Math.PI * 2));
  ctx.fillStyle = '#4f8cff';
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, r, 0, Math.PI * 2);
  ctx.fill();
}
```

### Python

- Khai **một trong hai**: `def frame(t, width, height)` (gọi mỗi khung) **hoặc** biến `image = ...` (một hình cho mọi khung).
- Trả về: `PIL.Image` (nên `RGBA`), mảng numpy `H×W×3` / `H×W×4` (uint8, hoặc float 0..1), hoặc `Figure` matplotlib.
- Biến có sẵn: `width`, `height`, `fps`, `duration`, `frames`. `print()` hiện trong **Nhật ký**.
- Tạo ảnh **đúng W×H** (sai cỡ sẽ bị co lại và mờ).
- matplotlib: gọi `matplotlib.use('Agg')` trước, dùng `Figure(figsize=(width/100, height/100), dpi=100)` thay cho `pyplot`.

```python
from PIL import Image, ImageDraw
import math

def frame(t, width, height):
    img = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = min(width, height) * (0.3 + 0.08 * math.sin(t * math.pi * 2))
    cx, cy = width / 2, height / 2
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(79, 140, 255, 255))
    return img
```

## 5. Lỗi hay gặp

| Thông báo / hiện tượng | Cách sửa |
|---|---|
| `chưa khai báo function draw(...)` | Canvas: đặt tên hàm đúng là `draw` |
| `Identifier 'width' has already been declared` | Canvas: xoá dòng khai lại `canvas`/`ctx`/`width`/`height` |
| `Khung n chạy quá 8 giây` | Có vòng lặp vô hạn hoặc tính quá nặng trong một khung |
| `hãy khai báo def frame(...) hoặc biến image` | Python: thiếu `frame` hoặc `image` |
| `Không chạy được Python` / thiếu Pillow | `python3 -m pip install pillow numpy` |
| Ảnh ra trống | Mã JS lỗi (HTML/canvas vẫn dựng tiếp nhưng ra khung trống) → xem dòng đỏ trong **Nhật ký**; hoặc hiệu ứng bắt đầu từ `opacity: 0`; hoặc nội dung nằm ngoài khung W×H |
| Có nền đen/trắng ngoài ý muốn | Bỏ `background` của `body` / `fillRect` nền / ảnh `RGB` → dùng `RGBA` |
| Phông/ảnh không hiện | Đường dẫn cục bộ bị chặn → dùng https hoặc data URI |

## 6. Mẫu prompt cho AI

Sao chép **một** mẫu dưới đây, điền phần `[...]`, dán cho AI (Claude, ChatGPT…). Gửi kèm lỗi trong Nhật ký nếu cần sửa.

### HTML/CSS/JS

```text
Viết mã cho GeoCode (HTML/CSS/JS) của CrabbyCut.
Nội dung: [mô tả: ví dụ "nút SUBSCRIBE màu đỏ bo tròn, chữ trắng, nảy nhẹ"]
Kích thước: [450]×[200] px. Loại: [ảnh / video [3] giây, [30] fps, lặp mượt]. Nền: trong suốt.

Quy tắc bắt buộc:
- Chỉ trả về MỘT khối mã HTML (đoạn <style> + thẻ, không cần <html>), không giải thích.
- html, body đã có sẵn đúng cỡ W×H, margin 0, overflow hidden; KHÔNG đặt background cho body.
- Nội dung nằm gọn trong W×H px; cỡ chữ, khoảng cách tính bằng px theo kích thước trên.
- Chuyển động bằng CSS @keyframes/transition, hoặc geocode.onFrame((t, frame) => {...}) với t là giây.
  Có sẵn geocode.width, geocode.height, geocode.fps, geocode.duration.
- Video lặp: chu kỳ chuyển động chia hết thời lượng. Ảnh tĩnh: khung t = 0 phải hiện đủ nội dung
  (không bắt đầu từ opacity 0).
- Không dùng Math.random() trần, không tải tệp cục bộ/localhost; phông/thư viện chỉ qua https.
```

### JavaScript canvas

```text
Viết mã cho GeoCode (JavaScript canvas) của CrabbyCut.
Nội dung: [mô tả: ví dụ "30 hạt sáng bay vòng tròn quanh tâm, màu xanh neon"]
Kích thước: [1080]×[1080] px. Loại: [video [4] giây, [30] fps, lặp mượt]. Nền: trong suốt.

Quy tắc bắt buộc:
- Chỉ trả về MỘT khối JavaScript thuần, không thẻ HTML, không giải thích.
- Phải khai function draw(ctx, t, width, height, frame); được gọi mỗi khung, canvas đã được xoá sẵn.
- Các biến canvas, ctx, width, height ĐÃ CÓ SẴN — tuyệt đối không khai lại chúng.
- Mọi vị trí/màu tính trực tiếp từ t (giây), không cộng dồn trạng thái giữa các khung.
- Không vẽ nền phủ toàn khung. Không dùng Math.random() trần — dùng hàm ngẫu nhiên có seed cố định.
- Video lặp: dùng chu kỳ bằng thời lượng (ví dụ Math.sin(2 * Math.PI * t / [4])).
```

### Python

```text
Viết mã cho GeoCode (Python) của CrabbyCut.
Nội dung: [mô tả: ví dụ "biểu đồ cột 5 tháng mọc dần lên, nhãn trắng"]
Kích thước: [1920]×[1080] px. Loại: [ảnh / video [5] giây, [30] fps]. Nền: trong suốt.

Quy tắc bắt buộc:
- Chỉ trả về MỘT khối Python, không giải thích. Chỉ dùng Pillow, numpy, matplotlib.
- Khai def frame(t, width, height) trả về PIL.Image RGBA đúng width×height (hoặc biến image cho ảnh tĩnh).
  Có sẵn biến toàn cục width, height, fps, duration, frames.
- Nền trong suốt: Image.new('RGBA', (width, height), (0, 0, 0, 0)).
- Mọi chuyển động tính trực tiếp từ t (giây); không cộng dồn trạng thái, không random không seed.
- Không ghi tệp, không mở cửa sổ, không gọi mạng. print() chỉ để ghi log.
- Nếu dùng matplotlib: matplotlib.use('Agg'), dùng matplotlib.figure.Figure(figsize=(width/100, height/100), dpi=100)
  (không dùng pyplot), nền trong suốt, trả về Figure.
- Phông chữ: thử ImageFont.truetype với vài phông phổ biến, lỗi thì dùng ImageFont.load_default(size=...).
```
