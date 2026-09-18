# Magic Fill — Giải thích ngắn gọn

Magic Fill là nút "tự động dựng overlay" ở giai đoạn Editing. Nó đọc **kịch bản chuẩn** (.md) đã dán ở bước Upload và **thư viện** (`library/`), rồi tự đặt chữ + ảnh/video lên timeline đúng chỗ, đúng lúc.

## Cần gì để chạy

1. **Timeline đã có clip** (đang ở giai đoạn Editing).
2. **Kịch bản chuẩn** có ít nhất một trong hai thứ:
   - Cụm **in đậm** (`**...**`) → sinh chữ/hình trên khung.
   - **Ghi chú** `/*...*/` → sinh ảnh/video minh hoạ theo từ khoá.

Không có gì trong hai thứ trên thì Magic Fill báo "chưa có gì để làm" và dừng.

## Hai việc chính

### 1) Ghi chú `/*...*/` → ảnh/video minh hoạ

Mỗi ghi chú nằm cùng dòng với câu thoại nó minh hoạ. Magic Fill:
- Tách ghi chú thành từ khoá (ngăn bằng `,` hoặc `/`).
- Dò tên file trong `library/` khớp từ khoá đó (xem quy ước đặt tên bên dưới).
- Đặt **tối đa 1 `[Vid]`** (phủ kín khung) + **1 `[Icon]`/`[Illus]`** (giữ cỡ gốc, né mặt người) cho mỗi ghi chú, đúng khoảng thời gian dòng đó được nói.

### 2) Cụm in đậm `**...**` → chữ hoặc mẫu có hình

Đây là phần phức tạp hơn, chia làm hai bước:

**Bước A — Gộp cụm liền kề.** Kịch bản thường viết `**HMO**, **lợi khuẩn**, **sữa non**` — về mặt kỹ thuật đây là NHIỀU cụm bold rời nhau. Magic Fill gộp lại thành một **nhóm** nếu:
- Hai cụm nằm **cùng dòng**, và
- Phần chữ xen giữa chúng **chỉ là khoảng trắng và dấu `,`**.

Xen giữa chỉ có khoảng trắng → nối thành một cụm liền mạch (vd: "đủ điều kiện" + "để" + "tăng trưởng..." → một câu dài). Xen giữa có dấu `,` → coi là một **danh sách liệt kê** nhiều phần con.

Về các từ nối "và" / "hoặc" / "hay" (luật chốt 2026-09-16):
- Nằm **giữa hai cụm bold** và **không được bôi đậm** → **KHÔNG gộp**, đó là hai nhóm rời nhau (và cũng không được gộp thành "Zoom Title", xem bảng dưới). Vd `**không phải còi nên mới** hay **ốm**` → hai khối riêng.
- Nằm **bên trong một cụm bold** → chỉ là chữ bình thường của cụm, **không chia nhỏ gì cả**. Vd `**canxi và vitamin D**` là MỘT cụm. Chỉ dấu `,` mới chia một cụm bold thành danh sách (vd `**chất đạm, chất béo**`).
- Bản thân từ nối **được bôi đậm** (`**HMO** **và** **sữa non**`) → nó là một cụm bold, hai bên nối với nó bằng khoảng trắng nên tất cả về **cùng một nhóm**.

**Bước B — Mỗi nhóm dựng ra khối gì.** Theo đúng thứ tự ưu tiên:

| # | Điều kiện | Kết quả |
|---|---|---|
| 0 | Một câu có **đúng 2 nhóm**, **không nhóm nào** bị dấu `,` chia nhỏ, và chữ xen giữa hai nhóm **không phải** chỉ là "và"/"hoặc"/"hay" | Gộp thành **1 mẫu "Zoom Title"** (nhóm 1 → Tiêu đề, nhóm 2 → Dòng phụ) |
| 1 | Nhóm là tên thương hiệu **"Little Étoile"** | Ảnh logo `[Icon] Logo LE`, không chữ, dán mép trên lưới an toàn |
| 2 | Danh sách liệt kê, **có ít nhất 1 phần khớp** thư viện | **Mọi phần** đều thành mẫu **"Custom"** kèm hình khớp; phần không khớp mượn hình bất kỳ (luân phiên) |
| 3 | Nhóm dài **≥ 6 từ** | Mẫu **"Vlog Tag"** cho cả nhóm |
| 4 | Nhóm ngắn, khớp `[Illus]` | Mẫu **"Custom"** kèm hình đó |
| 4b | Nhóm ngắn, chỉ khớp `[Icon]` | Chỉ đặt **ảnh trần**, không kèm chữ |
| 5 | Không khớp gì | **Chữ thường**, hiệu ứng "Hồng kẹo" + hoạt ảnh vào luân phiên (không lặp giữa 2 cụm liền nhau) |

Luật khớp dùng chung một công thức: tên file (bỏ tiền tố `[Icon]`/`[Illus]`, bỏ hậu tố `- số`) phải trùng **trên 50%** số chữ với cụm đang xét.

## Ví dụ

Kịch bản:
```
Thành phần nổi bật như **HMO**, **lợi khuẩn**, **sữa non**, **DHA**, **đạm A2**.
Trẻ có **đủ điều kiện** **để** **tăng trưởng và phát triển bình thường** hay không.
Bởi một **công thức tốt** là công thức **được** **thiết kế cân bằng** ngay từ đầu.
Giống như cách mà **Little Étoile** làm.
Bé **không phải còi nên mới** hay **ốm**.
```

Kết quả:
- Dòng 1 → 5 khối **Custom**, mỗi khối đúng 1 icon/illus khớp tên.
- Dòng 2 → gộp thành 1 cụm dài (≥ 6 từ) → mẫu **Vlog Tag**. Chữ "và" nằm trong cụm bold nên không chia nhỏ.
- Dòng 3 → 2 nhóm cùng câu, không nhóm nào có dấu `,`, chữ xen giữa là "là công thức" (không phải từ nối) → gộp thành 1 mẫu **Zoom Title**.
- Dòng 4 → ảnh **logo**, không chữ.
- Dòng 5 → chữ "hay" không in đậm xen giữa → **2 nhóm rời**, không gộp Zoom Title → 2 khối riêng.

## Quy ước đặt tên file thư viện

```
[Tiền tố] nội dung - số
```
- Tiền tố: `Vid` | `Icon` | `Illus` | `SFXs` | `Mus` — quyết định cách đặt vào khung, không phụ thuộc thư mục chứa.
- Nội dung: từ khoá để so khớp (nhiều từ khoá ngăn nhau bằng `,`).
- Hậu tố `- số`: tuỳ chọn, chỉ để phân biệt các file trùng nội dung.

Ví dụ: `[Icon] HMO.png`, `[Illus] Chuyen gia, chuyen gia y te.png`, `[Vid] Be khoe, be tuoi cuoi - 1.mp4`.

## Vài lưu ý

- Magic Fill **không** tự bật Auto-Reframe — nếu chưa chạy AR thì phần né mặt người rơi về mặc định.
- Magic Fill **không** tự đặt chuyển cảnh giữa các clip.
- Cụm không khớp word-level với timeline (nội suy/fuzzy) được đánh dấu **tím sọc** trên timeline để rà lại bằng tay.
- Chạy lại Magic Fill trên cùng một kịch bản sẽ ra **cùng một kết quả** (không có gì bốc ngẫu nhiên không kiểm soát được — trừ lúc nhiều file cùng khớp điểm cao nhất).

*Chi tiết kỹ thuật đầy đủ (hàm, tham số, các quyết định đã chốt) xem [APP_INTERNALS.md](APP_INTERNALS.md), mục "MAGIC FILL".*
