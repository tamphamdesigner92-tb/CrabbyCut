# Ảnh thương hiệu CrabbyCut

| Tệp | Kích thước | Dùng cho |
| --- | --- | --- |
| `social-preview-1280x640.png` | 1280×640 | GitHub › Settings › General › Social preview (ảnh hiện khi dán link repo lên X, Facebook, Discord, Slack) |
| `banner-1500x500.png` | 1500×500 | Ảnh bìa X, Reddit, LinkedIn; Facebook Page dùng được (Facebook cắt nhẹ hai mép) |
| `banner-youtube-2560x1440.png` | 2560×1440 | Ảnh bìa kênh YouTube; chữ và logo nằm trong vùng an toàn 1546×423 ở giữa |
| `avatar-1024.png` | 1024×1024 | Ảnh đại diện mọi kênh (YouTube, X, TikTok, Facebook, Reddit, Bilibili, 小红书): chữ C đỏ trên nền trắng, giống icon app; cắt tròn vẫn đủ chữ |
| `avatar-dark-1024.png` | 1024×1024 | Bản nền tối, chữ C amber, cùng tông với banner; dùng khi muốn avatar hợp với ảnh bìa |

Nguồn thiết kế: `brand-assets.html` (mở trong trình duyệt, thêm `?v=preview`, `?v=banner` hoặc
`?v=youtube`, `?v=avatar`, `?v=avatar-dark` để xem từng ảnh). Màu, logo và font lấy từ app: nền `#08090c`, amber `#ffb020`,
logo `#logo-crabbycut` trong `index.html`, font Bricolage Grotesque và Inter trong `static/fonts/google`
(OFL).

Sửa chữ hoặc màu trong `brand-assets.html`, rồi xuất lại PNG:

```bash
npm i -D playwright   # hoặc dùng Playwright đã cài toàn cục
npx playwright install chromium
node docs/brand/render.js
```
