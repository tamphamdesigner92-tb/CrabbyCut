# Bộ tài nguyên khởi đầu (starter pack)

Gói tải riêng trong Releases, chép thẳng vào thư viện của CrabbyCut là chạy được hai việc:

- **Magic Fill** trên kịch bản mẫu [`kich-ban-mau.md`](kich-ban-mau.md): mỗi ghi chú và cụm in đậm lấy đúng một tệp.
- **Auto SFX** với cài đặt mặc định: đủ 15 tệp SFX, 2 bản nhạc nền và 2 icon đúng/sai mà
  `static/js/app-settings.js` trỏ tới, nên không phải sửa Cài đặt.

Media **không** nằm trong git (xem [`library/README.md`](../../library/README.md)). Thư mục này chỉ giữ
danh sách tệp, kịch bản mẫu, mẫu ghi công và script kiểm.

| Tệp | Vai trò |
|---|---|
| [`manifest.json`](manifest.json) | 34 tệp của gói: đường dẫn trong `library/`, dùng cho gì, nội dung cần tìm, nguồn gợi ý |
| [`kich-ban-mau.md`](kich-ban-mau.md) | Kịch bản 10 câu của video demo (V-001), đúng cú pháp Magic Fill |
| [`CREDITS.md`](CREDITS.md) | Mẫu ghi công: mỗi tệp một dòng, đi kèm trong gói |
| [`check_starter_pack.js`](check_starter_pack.js) | Kiểm tên, mô phỏng Magic Fill, đối chiếu Auto SFX, kiểm gói thật |

## Cấu trúc gói

```
CrabbyCut-starter-pack/
├── CREDITS.md
├── kich-ban-mau.md
├── Elements/   [Icon] …png      (15 tệp)
├── Music/      [Mus] …mp3       (2 tệp)
├── SFXs/       [SFXs] …mp3      (15 tệp)
└── Video/      [Vid] …mp4       (3 tệp, 1 là quay màn hình)
```

Chép bốn thư mục con vào `%LOCALAPPDATA%\CrabbyCut\library` (Windows) rồi mở lại app.

## Luật giấy phép

Chỉ nhận **CC0 / Public Domain**, icon **MIT** (Tabler Icons, kèm văn bản giấy phép trong `CREDITS.md`),
hoặc tự quay, tự làm. **Không** dùng Pixabay, Pexels, Mixkit: các trang này có giấy phép riêng, không phải
CC0, và hạn chế phân phối lại tệp gốc, mà gói này chính là phân phối lại.

- Icon: <https://tabler.io/icons>, xuất PNG **400×400**, màu trắng hoặc đỏ thương hiệu. Magic Fill đặt icon
  ở **100% cỡ gốc**, nên cỡ PNG chính là cỡ trên khung 1080×1920.
- SFX: <https://freesound.org>, bộ lọc License = *Creative Commons 0*.
- Nhạc: <https://freemusicarchive.org> hoặc <https://opengameart.org>, lọc CC0.
- Video chèn: tự quay bằng điện thoại 10–15 giây là nhanh và sạch giấy phép nhất.

Tên tệp SFX và nhạc giữ **đúng** tên mặc định trong Cài đặt (ví dụ `[SFXs] Swish-1.mp3`), dù tên gốc
khác; tên gốc và tác giả ghi ở cột riêng trong `CREDITS.md`.

## Kiểm

```bash
npm run test:starter-pack                     # kiểm danh sách + mô phỏng Magic Fill
npm run test:starter-pack -- --dir <thư mục>  # kiểm thêm tệp thật và CREDITS.md đã điền đủ
```
