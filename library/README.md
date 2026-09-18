# Kho tài nguyên (`library/`)

Thư mục này là kho tài nguyên dùng lại của CrabbyCut: nhạc nền, hiệu ứng âm thanh, video
chèn, hình ảnh/icon và LUT màu. Panel "Thư viện" trong ứng dụng đọc thẳng từ đây.

## Vì sao kho này gần như trống trong repo

**Tài nguyên media không được theo dõi trong git và không đi kèm mã nguồn công khai.**

Đây không phải sơ suất, mà là bắt buộc:

- **Nhạc và hiệu ứng âm thanh** thường mua từ kho stock. Gần như mọi giấy phép stock cho
  phép *dùng* trong sản phẩm cuối nhưng **cấm phân phối lại chính tệp gốc**. Đẩy chúng lên
  một repo công khai là phân phối lại.
- **Video và hình ảnh** trong kho nội bộ có thể là tài sản của khách hàng — footage quay
  cho dự án của họ, logo, icon sản phẩm. Công khai chúng vừa là vấn đề bản quyền và nhãn
  hiệu, vừa có thể vi phạm thoả thuận bảo mật với khách.

**GPL không giải quyết được việc này.** GPL là giấy phép cho *phần mềm*. Nó không cấp cho
bạn quyền phát hành lại media của người khác, và việc mã nguồn là tự do không làm cho tài
nguyên đi kèm trở thành tự do.

## Cái gì CÓ trong repo

| Thư mục | Trạng thái | Lý do |
|---|---|---|
| `luts/` | **Có theo dõi** | 22 tệp `.cube` + `presets.json` do chính `scripts/generate_preset_luts.js` của dự án sinh ra. Đây là tác phẩm của dự án, thuộc giấy phép GPL của CrabbyCut. Sinh lại bằng `node scripts/generate_preset_luts.js` |
| `Elements/` | Chỉ khung thư mục | Hình ảnh, icon, hình khối |
| `Music/` | Chỉ khung thư mục | Nhạc nền |
| `SFXs/` | Chỉ khung thư mục | Hiệu ứng âm thanh |
| `Video/` | Chỉ khung thư mục | Video chèn |

Ứng dụng **tự tạo lại các thư mục này nếu thiếu** (xem `ensureDirs()` trong
`backend/server.js`), nên bản clone mới chạy được ngay với kho rỗng — panel Thư viện chỉ
đơn giản là không có mục nào.

## Tự nạp tài nguyên vào kho

Chép tệp vào đúng thư mục con. Ứng dụng quét lại kho mỗi lần khởi động.

Định dạng nhận được: `.mp4`, `.mov`, `.m4v`, `.webm` (video); `.mp3`, `.wav`, `.m4a`,
`.aac` (âm thanh); `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg` (hình ảnh); `.cube` (LUT).

### Quy ước đặt tên

Tên tệp trong kho đi theo quy ước có tiền tố phân loại, vì chức năng Magic Fill đọc tên để
chọn tài nguyên phù hợp:

```
[Vid] <mô tả>.mp4      [Mus] <tên bài>.mp3
[SFXs] <mô tả>.mp3     [Icon] <tên>.png
```

Xem `docs/QUY_UOC_DAT_TEN_TAI_NGUYEN.md` để biết đầy đủ.

### Nguồn tài nguyên dùng được cho dự án công khai

Nếu bạn muốn đóng góp tài nguyên mẫu vào repo công khai, chỉ dùng thứ **bạn tự tạo** hoặc
thứ có giấy phép cho phép phân phối lại — ví dụ CC0 / Public Domain:

- [Pixabay](https://pixabay.com) — nhạc, video, hình ảnh
- [Freesound](https://freesound.org) — hiệu ứng âm thanh (lọc theo CC0)
- [Openverse](https://openverse.org) — hình ảnh

Kèm theo tài nguyên phải có một tệp ghi rõ **nguồn và giấy phép** của từng tệp. Tài nguyên
không rõ nguồn gốc sẽ không được nhận.
