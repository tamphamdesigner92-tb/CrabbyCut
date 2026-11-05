# Prompt pack · Series short hoạt hình 2D (MCP + GeoCode)

Bảy short 9:16 do Claude làm trong CrabbyCut qua MCP; mọi hình do GeoCode vẽ bằng code, không cần tài nguyên tải ngoài.
CrabbyCut miễn phí, mã nguồn mở. Để Claude điều khiển app, bạn cần một tài khoản Claude có hỗ trợ MCP (Claude Desktop hoặc Claude Code)
và bật **Cài đặt › Chung › Nâng cao › "Cho phép Claude điều khiển (MCP)"**. Cách kết nối: [`mcp/README.md`](../../mcp/README.md).
Quy tắc viết mã GeoCode: [`docs/HUONG_DAN_GEOCODE.md`](../HUONG_DAN_GEOCODE.md).

> Trạng thái: **bản nháp trước buổi dựng 7/11/2026.** Mã trong `geocode/` đã kiểm ngoài app bằng `kiem-geocode.js`
> (tất định, lặp khít, nền trong suốt) nhưng chưa chạy trong CrabbyCut. Câu lệnh sẽ được sửa theo kết quả thật sau buổi dựng.

## Câu lệnh

Mỗi câu là đúng chữ gõ cho Claude và hiện ở 2 giây đầu của short. Bản tiếng Anh dùng khi đăng quốc tế.

| Mã | Câu lệnh (VI) | Prompt (EN) | Dài |
|---|---|---|---|
| S-01 | Làm một short dọc 20 giây: Crabby, con cua đỏ, đi dạo ngang bãi biển lúc hoàng hôn, mặt trời lặn dần, sóng vỗ bờ. Vẽ mọi thứ bằng GeoCode. | Make a 20-second vertical short: Crabby the red crab strolls across a beach at sunset, the sun slowly sets and waves roll in. Draw everything with GeoCode. | 22 s |
| S-02 | Làm short 40 giây giải thích vì sao bầu trời màu xanh: sơ đồ ánh sáng tán xạ chuyển động, có lồng tiếng Việt. Vẽ bằng GeoCode. | Make a 40-second short explaining why the sky is blue: an animated light-scattering diagram with a voice-over. Draw it with GeoCode. | 40 s |
| S-03 | Làm short 30 giây: 8 hành tinh quay quanh Mặt Trời, tên từng hành tinh hiện dần theo thứ tự. Vẽ bằng GeoCode. | Make a 30-second short: the 8 planets orbit the Sun and their names appear one by one, in order. Draw it with GeoCode. | 30 s |
| S-04 | Làm short 15 giây chữ chuyển động cho khẩu hiệu "Create anything. Pay nothing." bằng màu thương hiệu CrabbyCut. | Make a 15-second kinetic-type short for the slogan "Create anything. Pay nothing." in CrabbyCut's brand colours. | 15 s |
| S-05 | Làm short 30 giây cảnh mưa trên phố đêm kiểu lofi, lặp liền mạch. Vẽ bằng GeoCode. | Make a 30-second lofi short of rain on a city street at night that loops seamlessly. Draw it with GeoCode. | 30 s |
| S-06 | (Hậu trường) Bản quay màn hình lúc Claude làm S-01, tua nhanh. | (Behind the scenes) Screen recording of Claude making S-01, sped up. | 60–90 s |
| S-07 | Ba câu sửa trên bản sao S-01: "Đổi cảnh sang ban đêm." · "Cho cua vẫy càng." · "Cho cua đi chậm lại." | Three edits on a copy of S-01: "Make it night." · "Make the crab wave its claws." · "Make the crab walk slower." | 30 s |

## Mã GeoCode nháp

| Tệp | Dùng cho | Ngôn ngữ · cỡ · thời lượng |
|---|---|---|
| `geocode/s01-nen-bien.canvas.js` | S-01, S-06, S-07: nền biển hoàng hôn; `TIME_OF_DAY` đổi sang `'night'` | canvas · 1080×1920 · 20 s |
| `geocode/s01-crabby.html` | S-01, S-07: linh vật cua bước đi, lặp 2 s; `CLAW_WAVE` = 1 để vẫy càng | HTML/SVG · 600×600 · 2 s lặp |
| `geocode/s02-tan-xa.canvas.js` | S-02: sơ đồ tán xạ 4 cảnh | canvas · 1080×1920 · 36 s |
| `geocode/s03-he-mat-troi.canvas.js` | S-03: 8 hành tinh, tên hiện dần mỗi 2,5 s | canvas · 1080×1920 · 26 s |
| `geocode/s04-khau-hieu.html` | S-04: chữ chuyển động + chữ CrabbyCut | HTML · 1080×1920 · 13 s |
| `geocode/s05-mua-pho-dem.canvas.js` | S-05: phố đêm mưa, lặp khít 10 s | canvas · 1080×1920 · 10 s lặp |
| `geocode/the-cau-lenh-va-the-cuoi.html` | Thẻ câu lệnh (2 s đầu) và thẻ cuối (2 s cuối), template `{{mode}}` `{{label}}` `{{text_json}}` | HTML · 1080×1920 · 2 s |

Các hằng số ở đầu mỗi tệp (`TIME_OF_DAY`, `CLAW_WAVE`, `RAIN_DENSITY`, `NAMES`…) được đặt sẵn để "sửa bằng lời" chỉ cần một lệnh
`crabbycut_update_geocode` với `replace: [{find, with}]`, không phải gửi lại mã.

## Kiểm mã ngoài app

```bash
node docs/prompts/kiem-geocode.js [thư mục ra PNG]
```

Script dựng vài khung mỗi tệp bằng Chromium (Playwright), kiểm: không `Math.random()` trần, cùng `t` ra cùng ảnh, video lặp có khung 0
trùng khung cuối, lớp nhân vật/chữ còn nền trong suốt; rồi xuất `tam-ghep.png` để xem bằng mắt. Không thay cho **Xem thử** trong app.
