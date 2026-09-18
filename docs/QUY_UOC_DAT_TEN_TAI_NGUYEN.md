# Quy Ước Đặt Tên Tài Nguyên Cho Magic Fill

Tài liệu này dành cho người **chuẩn bị thư viện** (`library/`) và người **viết kịch bản .md**.
Mục tiêu: đặt tên sao cho Magic Fill tìm đúng ảnh/video/element, **không bỏ sót** và cũng
không chèn bừa.

Mọi luật dưới đây lấy đúng từ code đang chạy: [static/js/magic-fill-assets.js](../static/js/magic-fill-assets.js)
(luật khớp) và [static/js/editing-runtime.js:16815](../static/js/editing-runtime.js#L16815) (luật đặt lên timeline).

---

## 1. Magic Fill tìm asset bằng cách nào

Magic Fill **không hiểu nội dung file**. Nó chỉ so **tên file** với **chữ trong kịch bản**.
Có hai nguồn từ khoá trong kịch bản:

| Nguồn | Cú pháp trong .md | Dò loại asset nào | Thời gian xuất hiện |
|---|---|---|---|
| **Ghi chú** | `/* bé ốm, ho, khóc */` hoặc `*** bé ốm ***` | `[Vid]` + `[Icon]`/`[Illus]` | Trọn **dòng thoại** chứa ghi chú |
| **Cụm in đậm** | `**lợi khuẩn**` | **Chỉ** `[Icon]`/`[Illus]` | Đúng khoảng của cụm in đậm |

Chiều so khớp rất quan trọng: **từ khoá nằm trong TÊN FILE đi dò đoạn text của kịch bản**,
chứ không phải ngược lại. Nghĩa là:

> Chất lượng tên file quyết định recall. Ghi chú viết dài, viết nhiều biến thể thì chỉ **có
> lợi** (thêm chữ để dò), còn tên file viết sai kiểu là **bỏ sót ngay**.

---

## 2. Cú pháp tên file

```
[Tiền tố] từ khoá 1, từ khoá 2, từ khoá 3 - số.đuôi
```

Ví dụ thật trong `library/`:

```
[Vid] Be khoe, be tuoi cuoi - 1.mp4
[Illus] Giam phat trien chieu cao - 1.png
[Icon] Lactoferrin.png
[SFXs] Pop-UI-Sound.MP3
[Mus] Coconut-Groove.MP3
```

### 2.1. Tiền tố — quyết định CÁCH ĐẶT, không phải thư mục

| Tiền tố | Loại | Magic Fill làm gì |
|---|---|---|
| `[Vid]` | cover | Video **phủ kín khung** (cover-fit), nằm ở lane `Magic Fill Video` |
| `[Icon]` | inset | Giữ **nguyên 100% cỡ gốc**, đặt ở nửa khung **đối diện mặt người** |
| `[Illus]` | inset | Như `[Icon]` |
| `[SFXs]` | audio | **Không** dùng cho Magic Fill hình; dành cho Auto SFX |
| `[Mus]` | audio | Nhạc nền; dành cho Auto SFX |

Ba điều dễ sai:

1. **Thư mục không có ý nghĩa với luật khớp.** Magic Fill quét **đệ quy** toàn bộ `library/`
   (tối đa 6 cấp, bỏ `library/luts/` và mọi file/thư mục bắt đầu bằng `.`). Xếp thư mục thế
   nào cũng được — nhưng **tiền tố thì bắt buộc**.
2. **Thiếu tiền tố = suy đoán theo đuôi file** (video → cover, ảnh → inset). Ghi chú vẫn khớp
   được, nhưng **cụm in đậm thì không**: nhánh in đậm chỉ nhận file có tag đúng `icon` hoặc
   `illus`. Đây là nguyên nhân bỏ sót âm thầm phổ biến nhất.
3. **Tiền tố viết lạ coi như thiếu**: `(Icon)`, `Icon -`, `[icons]` (số nhiều), `[Icon 2]` →
   **không** nhận. Đúng phải là **dấu ngoặc vuông ở đầu tên**, bên trong đúng một trong 5 chữ
   trên. Hoa/thường, dấu tiếng Việt và khoảng trắng thừa thì không sao (`[ICON ]` vẫn nhận).

### 2.2. Hậu tố `- số` — cách duy nhất để có nhiều bản

Hậu tố chỉ bị cắt khi **có dấu gạch và chỉ toàn chữ số ở cuối**: `- 1`, `-2`, `– 3`.

```
[Vid] Be om, be gay - 1.mp4   ✅ nội dung = "Be om, be gay"
[Vid] Be om, be gay - 2.mp4   ✅ cùng nội dung → hai file luân phiên ngẫu nhiên
[Vid] Be om be gay 2.mp4      ❌ "2" thành một từ khoá rác trong nội dung
[Vid] Be di hoc - final v2 copy.mp4  ❌ "final v2 copy" bị tính là chữ của từ khoá
```

Ví dụ cuối là bẫy thật: với ghi chú `bé đi học`, độ khớp rơi từ **100% xuống 50%** → **bị loại**
(xem mục 3). Mọi chữ đuôi kiểu `final`, `copy`, `v2`, `1920x1080`, `edited` phải bỏ khỏi tên.

### 2.3. Đuôi file được nhận

- Video: `.mp4` `.mov` `.m4v` `.webm`
- Ảnh: `.png` `.jpg` `.jpeg` `.webp` `.svg`
- Âm thanh: `.mp3` `.wav` `.m4a` `.aac`

Đuôi khác (`.ai`, `.eps`, `.psd`, `.gif`, `.mkv`, …) **không xuất hiện trong thư viện** nên
Magic Fill không thấy — dù tên đặt đúng chuẩn.

---

## 3. Luật khớp — con số phải nhớ

Mỗi **từ khoá** (cụm giữa hai dấu phẩy trong tên file) được so **độc lập** với đoạn text.
Chỉ cần **một** từ khoá đạt là file được coi là khớp.

```
độ khớp của từ khoá = (số chữ của TỪ KHOÁ có trong đoạn text) / (số chữ của TỪ KHOÁ)
đạt khi độ khớp > 50%     ← LỚN HƠN, không phải "bằng"
```

Mẫu số là **độ dài của chính từ khoá trong tên file**. Từ khoá càng dài, càng khó đạt.

### 3.1. Bảng số chữ cần khớp

| Số chữ của từ khoá | Cần khớp tối thiểu | Ghi chú |
|---|---|---|
| 1 | 1 (100%) | Rất dễ khớp → dễ khớp bừa |
| **2** | **2 (100%)** | **Bất lợi nhất**: 1/2 = 50% là *chưa* đạt |
| 3 | 2 (67%) | Vùng an toàn |
| 4 | 3 (75%) | Vùng an toàn |
| 5 | 3 (60%) | Vùng an toàn |
| 6 | 4 (67%) | Bắt đầu khó |
| 7+ | > nửa | Nên tách bớt |

**Hệ quả quan trọng nhất:** từ khoá **2 chữ** đòi khớp tuyệt đối. `[Icon] Omega 3` + ghi chú
`bổ sung omega` = 1/2 = 50% → **bỏ sót**. Cách chữa: thêm biến thể 1 chữ →
`[Icon] Omega 3, Omega.png` → khớp 100%.

### 3.2. Chữ được chuẩn hoá thế nào

Trước khi so, cả tên file và text kịch bản đều bị:

1. hạ hoa thường; 2. **bỏ hết dấu tiếng Việt**; 3. `đ` → `d`; 4. **xoá mọi ký tự không phải a–z 0–9**.

Nên **không cần và không nên gõ dấu trong tên file**: `Be om` khớp `bé ốm` bình thường.
Dấu tách chữ gồm: khoảng trắng và `, . ; : ! ? ( ) [ ] { } " ' / \ _ + - – —`.

Và điều bắt buộc phải nhớ:

- **So khớp là NGUYÊN TỪ, không có gốc từ, không khớp một phần.**
  `khoe` khớp `khoẻ mạnh` (vì `khoẻ` là một từ riêng) nhưng **không** khớp `sứckhoẻ` viết liền.
- **Đồng nghĩa không tự hiểu.** `be` ≠ `tre` ≠ `con`; `om` ≠ `benh` ≠ `sot`. Muốn phủ hết thì
  **liệt kê bằng dấu phẩy** trong tên file.
- Số là một chữ riêng: `Omega 3` cần cả `omega` **và** `3` trong text.

---

## 4. Bảy quy tắc đặt tên để không bỏ sót

**1) Luôn có tiền tố đúng chuẩn.** Không tiền tố thì cụm in đậm sẽ không bao giờ tìm thấy file.

**2) Nhồi biến thể bằng dấu phẩy, đừng nhồi vào một cụm.**
Mỗi cụm được so độc lập nên thêm cụm là **thêm cơ hội**, còn thêm chữ vào một cụm là **tăng
mẫu số**, tự làm khó mình.

```
[Illus] Tang can cham, cham tang can, coi coc, suy dinh duong.png   ✅
[Illus] Tang can cham coi coc suy dinh duong.png                    ❌ 6 chữ, cần khớp 4
```

**3) Tránh cụm 2 chữ đứng một mình.** Hoặc rút còn 1 chữ đặc trưng, hoặc nới ra 3 chữ, hoặc
thêm cả hai biến thể: `[Icon] Loi khuan, Loi khuan duong ruot.png`.

**4) Không dùng từ khoá 1 chữ quá phổ thông.** `be`, `me`, `sua`, `con` khớp gần như mọi câu,
lại luôn đạt 100% nên **hất cả file cụ thể hơn ra khỏi vòng chọn** (Magic Fill chỉ giữ nhóm có
tỉ lệ khớp cao nhất rồi bốc ngẫu nhiên). Từ khoá 1 chữ chỉ nên là danh từ riêng/thành phần:
`Lactoferrin`, `Wellmune`, `Colostrum`.

**5) Bỏ mọi chữ không phải nội dung.** Không `final`, `v2`, `copy`, `edited`, `1080`, `ver3`,
tên khách hàng, ngày tháng. Cần phân biệt bản → chỉ dùng ` - 1`, ` - 2`.

**6) Không dùng dấu phẩy cho câu văn.** Dấu phẩy là **dấu tách từ khoá**, không phải dấu câu.
`[Vid] Be khoe, be tuoi cuoi` = 2 từ khoá (đúng), chứ không phải một câu dài.

**7) Đặt tên theo *cách kịch bản sẽ nói*, không theo cách kho ảnh phân loại.**
Tên nên là **chính chữ trong ghi chú/cụm in đậm** dự kiến. Kịch bản viết "chậm tăng cân" thì
tên phải có `Cham tang can`, không phải `Growth chart`.

### Ví dụ đối chiếu

| Tên file | Ghi chú kịch bản | Kết quả |
|---|---|---|
| `[Vid] Be om, be gay - 1.mp4` | `bé ốm/ ho/ khóc` | 2/2 = **100% → khớp** |
| `[Illus] Giam phat trien chieu cao - 1.png` | `giảm phát triển chiều cao` | 4/5 = **80% → khớp** |
| `[Illus] Giam phat trien chieu cao - 1.png` | `giảm số ngày ốm` | 1/5 = 20% → không khớp (đúng ý) |
| `[Icon] Omega 3.png` | `bổ sung omega` | 1/2 = 50% → **bỏ sót** |
| `[Icon] Omega 3, Omega.png` | `bổ sung omega` | **100% → khớp** |
| `[Vid] Be di hoc - final v2 copy.mp4` | `bé đi học` | 3/6 = 50% → **bỏ sót** |
| `[Vid] Be di hoc, tre den truong.mp4` | `bé đi học` | **100% → khớp** |

---

## 5. Phía kịch bản: viết ghi chú và in đậm cho khớp

- **Ghi chú viết dài, viết nhiều biến thể là có lợi.** Cả ghi chú là **một đoạn text** để dò,
  mẫu số nằm ở tên file → thêm chữ vào ghi chú **không bao giờ làm giảm** độ khớp.
  `/* bé ốm, hay ho, sốt, khóc đêm */` tốt hơn `/* bé ốm */`.
- **Ghi chú ở DÒNG ĐẦU bị bỏ qua.** Dòng có nội dung đầu tiên được coi là **câu hook**; ghi chú
  của nó (hoặc ghi chú mở đầu bằng `HOOK`/`CÂU HOOK`) **không dùng để so khớp**. Cần asset cho
  đoạn mở đầu thì đặt ghi chú ở dòng thứ hai trở đi.
- **Ghi chú phải nằm cùng dòng với câu thoại của nó** — thời gian hiện/mất của asset chính là
  khoảng thời gian dòng đó được nói.
- **Cụm in đậm chỉ ra `[Icon]`/`[Illus]`**, tối đa **3** cái cho một cụm, và dùng đúng luật > 50%.
  Muốn chèn video theo cụm in đậm thì phải viết ghi chú, in đậm không làm được.
- **Từ khoá đặc thù nên viết không dấu, đúng như tên file** khi có thể — tuy nhiên bỏ dấu là tự
  động nên `lợi khuẩn` và `loi khuan` như nhau.

### Giới hạn khi đặt lên timeline (biết để không tưởng là "bỏ sót")

- Mỗi **từ khoá ghi chú** giữ tối đa **1 `[Vid]` + 1 `[Icon]`/`[Illus]`** (nhiều cái cùng lúc
  sẽ che nhau).
- Nhiều `[Vid]` trên **cùng một dòng** → **chia đều** thời lượng dòng đó.
- Nhiều file bằng điểm cao nhất → **bốc ngẫu nhiên** (đây là lý do đặt ` - 1`, ` - 2`).
- **Cùng một file, thời gian chồng nhau** → chỉ giữ block đầu. Lặp ở các câu **khác** nhau thì
  vẫn được phép.
- Mỗi asset có thời lượng tối thiểu **0,8 giây**.

---

## 6. Checklist trước khi thả file vào `library/`

- [ ] Tên bắt đầu bằng `[Vid]`, `[Icon]`, `[Illus]`, `[SFXs]` hoặc `[Mus]` — ngoặc vuông, đúng chữ.
- [ ] Đuôi file nằm trong danh sách được nhận (mục 2.3).
- [ ] Không còn chữ rác: `final`, `copy`, `v2`, số đo, ngày, tên khách.
- [ ] Bản trùng nội dung được phân biệt bằng ` - 1`, ` - 2` (có dấu gạch).
- [ ] Mỗi từ khoá **không phải cụm 2 chữ** đứng một mình (nếu có, thêm biến thể).
- [ ] Có **≥ 2 biến thể** cách nói cho asset quan trọng, ngăn bằng dấu phẩy.
- [ ] Không có từ khoá 1 chữ phổ thông (`be`, `me`, `sua`, `con`, `nhe`).
- [ ] Đọc lại: từ khoá có **đúng chữ mà kịch bản sẽ nói** không?

---

## 7. Tự kiểm tra trước khi chạy Magic Fill

Đo trực tiếp độ khớp giữa một tên file và một đoạn ghi chú, không cần mở app:

```bash
node -e "const M=require('./static/js/magic-fill-assets.js'); console.log(M.noteMatchRatio('[Icon] Omega 3.png','bổ sung omega','media_image'))"
```

Kết quả `> 0.5` là khớp. Xem tên file được tách thành từ khoá thế nào:

```bash
node -e "const M=require('./static/js/magic-fill-assets.js'); console.log(JSON.stringify(M.describeAssetName('[Vid] Be khoe, be tuoi cuoi - 1.mp4','media_video'),null,2))"
```

Chạy bộ smoke test của luật khớp:

```bash
node tests/scripts/magic_fill_assets.js
```

Sau khi Magic Fill chạy, báo cáo trong app liệt kê `noAsset` (từ khoá không tìm được file) và
`noTime` (tìm được file nhưng không định được thời gian) — dùng nó để sửa **tên file** trước,
vì đó là chỗ recall bị mất.
