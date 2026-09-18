# Bộ dữ liệu đo (`tests/fixtures/`)

## Vì sao thư mục này gần như trống

Hai thư mục `matching/` và `reorder/` **không được theo dõi trong git**.

Chúng chứa dữ liệu từ **dự án thật của khách hàng**: kịch bản marketing, transcript lời
nói của người thật, tên thương hiệu và tên sản phẩm. Đó là tài sản trí tuệ của khách, và
một số còn thuộc phạm vi thoả thuận bảo mật.

GPL cấp phép cho *phần mềm*. Nó không cho dự án quyền phát hành nội dung của người khác.

Một tệp đã bị **xoá hẳn** chứ không chỉ gỡ khỏi git: `face.jpg` — một khung hình cắt từ
video của khách, có mặt người nhận diện được và nhãn hiệu bên thứ ba hiện rõ. Ngoài bản
quyền, đó còn là dữ liệu cá nhân. Không mã nào trong dự án dùng tới nó.

## Cái gì CÓ trong repo

| Tệp | Vì sao giữ được |
|---|---|
| `face_landmarks.json` | 478 cặp toạ độ đã chuẩn hoá về [0,1], **không kèm hình**. Không tái nhận diện được ai. Bộ test Retouch (`npm run test:retouch`) cần nó để khoá các bất biến hình học của FaceMesh |

## Ảnh hưởng tới việc chạy test

Các bài test **tự bỏ qua** phần cần bộ ca thật và vẫn báo đạt:

| Lệnh | Khi không có fixtures |
|---|---|
| `npm run test:matching` | Chạy đủ phần tổng hợp; bỏ phần đối chiếu ca thật |
| `npm run test:script-reorder-align` | In `(bỏ qua: không có tests/fixtures/matching)` rồi chạy tiếp phần tổng hợp |
| `npm run test:retouch` | Chạy đầy đủ (dùng `face_landmarks.json`) |
| `npm run eval:matching` | Dừng với thông báo rõ, mã thoát 2 |
| `npm run label:matching` | Dừng với thông báo rõ, mã thoát 2 |

Không bài nào ném traceback vì thiếu dữ liệu.

## Tự dựng bộ ca của bạn

`scripts/build_matching_fixtures.py` sinh fixture từ chính cache ASR của một dự án bạn đã
chạy trong app:

```bash
npm run fixtures:matching
```

Mỗi ca là một thư mục dưới `matching/`:

| Tệp | Nội dung |
|---|---|
| `script.txt` | Kịch bản chuẩn |
| `segments.json` | Segment ASR kèm word-timestamps |
| `takes.json` | Các take ứng viên |
| `labels.json` | Nhãn đúng/sai do người gán (`npm run label:matching`) |
| `meta.json` | Siêu dữ liệu: số segment, thời lượng, sha1 kịch bản |
| `review.md` | Ghi chú rà soát của người gán nhãn |

Ca `reorder/` là tệp JSON đơn lẻ gồm `reference_script`, `blocks` và
`expected_script_indices`.

**Nếu bạn định đóng góp fixture vào repo công khai:** chỉ dùng nội dung **bạn tự viết**,
hoặc nội dung có giấy phép cho phép phát hành lại. Đừng dùng lời thoại, kịch bản hay hình
ảnh của người khác — kể cả khi bạn có quyền dùng chúng trong sản phẩm của mình.
