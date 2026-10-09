# CrabbyCut: Sửa lỗi tải NeuCodec bị chặn (gated)

09/10/2026 · Tam Pham

## Nguyên nhân

Bấm "Tạo lồng tiếng" với engine VieNeu-TTS báo lỗi 401 vì repo `neuphonic/neucodec-onnx-decoder-int8` đã bị khoá (gated) từ ngày 26/08/2026. Người dùng không làm gì sai.

- Repo bật `gated: auto`: muốn tải phải đăng nhập HuggingFace, điền Affiliation và Role, rồi bấm đồng ý điều khoản. Bản không nén `neuphonic/neucodec-onnx-decoder` cũng bị khoá y như vậy.
- `tts/model_store.py` dòng 269 gọi `hf_hub_download` mà không có token, nên mọi máy chưa có model đều nhận lỗi 401. Máy của tác giả cũng không có sẵn model: thư mục `%LOCALAPPDATA%\CrabbyCut\tts_models\neucodec-onnx` đang trống.
- File cần tải là `model.onnx`, nặng 312.292.102 byte (khoảng 312 MB).
- Model dùng giấy phép **Apache-2.0**, được phép phân phối lại nếu giữ file LICENSE và ghi nguồn. Cổng khoá chỉ để Neuphonic thu thông tin người tải, không phải hạn chế về bản quyền.
- Model đi kèm `pnnbao-ump/VieNeu-TTS-v2` không bị khoá, vẫn tải bình thường. Các repo còn lại trong `MODELS` chưa được kiểm tra.

## Cách không nên làm và phương án tạm

**Không nhúng token HuggingFace vào app.** Ai giải nén bộ cài cũng lấy được token. Làm vậy cũng là lách đúng cái cổng Neuphonic cố ý đặt cho từng người tải.

**Không bắt người dùng chạy `hf auth login`.** Người dùng cuối không biết làm việc này, và mỗi máy lại phải làm lại từ đầu.

**Phương án tạm, không khuyến nghị lâu dài:** dùng bản mirror công khai do người khác đăng, `aoiandroid/neuphonic-neucodec-onnx-decoder-int8-mirror`.

- Repo này không bị khoá, giấy phép Apache-2.0, `model.onnx` cũng nặng đúng 312.292.102 byte.
- SHA256 của file trong mirror: `3ddd9e56396e6029e0e948ac0255c89c803f981f23dcf4c154f50820bd74a6b3`.
- Repo gốc giấu mã hash nên chưa kiểm được nội dung có giống hệt không. Người đăng có thể sửa hoặc xoá repo bất cứ lúc nào.
- Chỉ dùng mirror này sau khi đã tải file gốc và so khớp SHA256 (bước 1 ở phần dưới).

## Các bước thực hiện

Hướng sửa: tác giả tự lưu một bản mirror công khai, không khoá. App tải từ mirror đó trước, kiểm SHA256, và chỉ thử repo gốc khi mirror hỏng.

1. **Tải file gốc một lần (tác giả làm tay).**
   - Mở https://huggingface.co/neuphonic/neucodec-onnx-decoder-int8, đăng nhập, điền Affiliation/Role và bấm đồng ý. Repo tự duyệt ngay.
   - Chạy `hf auth login`, rồi `hf download neuphonic/neucodec-onnx-decoder-int8 model.onnx README.md meta.yaml --local-dir <thư mục tạm>`.
   - Chạy `sha256sum model.onnx` và ghi lại kết quả. So với SHA256 của mirror bên thứ ba ở phần trên để biết bản đó có dùng dự phòng được không.
2. **Tạo repo mirror công khai (đăng dưới tài khoản của tác giả, cần tác giả xác nhận).**
   - Ví dụ `<tài-khoản-HF>/neucodec-onnx-decoder-int8`, để Public và **không** bật gated.
   - Đưa lên `model.onnx`, `meta.yaml`, file `LICENSE` (Apache-2.0) và README ghi rõ: bản sao nguyên vẹn từ `neuphonic/neucodec-onnx-decoder-int8`, bản quyền thuộc Neuphonic, kèm SHA256.
   - Lệnh mẫu: `hf repo create <tài-khoản-HF>/neucodec-onnx-decoder-int8` rồi `hf upload <tài-khoản-HF>/neucodec-onnx-decoder-int8 <thư mục tạm>`.
   - Phương án khác: đưa file lên GitHub Release của CrabbyCut. Khi đó bước 3 phải thêm đường tải HTTP thường thay cho `hf_hub_download`.
3. **Sửa `tts/model_store.py`.**
   - Trong `MODELS["neucodec-onnx"]`, thêm `"mirrors": ["<tài-khoản-HF>/neucodec-onnx-decoder-int8"]` và `"sha256": {"model.onnx": "<hash ở bước 1>"}`. Giữ `"repo"` là repo gốc.
   - Viết hàm nhỏ trả danh sách nguồn theo thứ tự: các `mirrors` trước, `repo` sau cùng.
   - Trong `_download`, lặp qua từng nguồn: gọi `_remote_files` và `hf_hub_download` với repo đó. Nguồn lỗi (401, 404, mất mạng) thì ghi lại lỗi và thử nguồn kế. Chỉ báo lỗi khi mọi nguồn đều hỏng.
   - Sau khi tải xong, tính SHA256 từng file có trong `sha256`. Sai hash thì xoá file đó và coi nguồn này là hỏng.
   - Ghi vào `.crab-model.json` repo thực sự đã dùng (`"repo": <nguồn>`), không phải luôn là `spec["repo"]`.
   - Đặt biến `HF_HUB_DISABLE_IMPLICIT_TOKEN=1` khi tải từ mirror, để máy có token cũ hỏng không làm hỏng lượt tải công khai.
4. **Sửa câu báo lỗi trong `_friendly_error`.**
   - Bỏ lời khuyên "Chạy `hf auth login`".
   - Thay bằng câu người dùng hiểu được, ví dụ: "Không tải được NeuCodec decoder từ mọi nguồn. Hãy cập nhật CrabbyCut lên bản mới nhất hoặc báo cho tác giả."
   - Giữ phần đuôi kỹ thuật (`text[-200:]`) để còn tra lỗi được.
5. **Nâng phiên bản và đóng gói.** Tăng phiên bản lên 1.1.16, chạy `dist:win` ngay trong thư mục dự án; bộ cài nằm ở `dist/`.

Không cần sửa `tts/server.py` hay `backend/tts-service.js`: hai file này chỉ gọi model theo khoá `neucodec-onnx` và đọc `model.onnx` trong thư mục đã tải.

## Kiểm thử và checklist

Bản sửa đạt khi một máy sạch, không đăng nhập HuggingFace, bấm "Tạo lồng tiếng" là tự tải đủ 312 MB và ra được giọng.

- [ ] Đã tải `model.onnx` gốc và ghi lại SHA256
- [ ] Đã tạo repo mirror công khai, có LICENSE và README ghi nguồn
- [ ] Mở link `https://huggingface.co/<mirror>/resolve/main/model.onnx` bằng trình duyệt ẩn danh, tải được, không bị 401
- [ ] Đã sửa `model_store.py`: danh sách nguồn, kiểm SHA256, câu báo lỗi mới
- [ ] Xoá thư mục `%LOCALAPPDATA%\CrabbyCut\tts_models\neucodec-onnx`, chạy `hf auth logout`, rồi tạo lồng tiếng VieNeu: thanh tiến trình chạy tới 100% và ra âm thanh
- [ ] Tạm sửa `sha256` thành giá trị sai: app phải từ chối file và báo lỗi, không dùng file sai
- [ ] Tạm đổi tên mirror thành repo không tồn tại: app phải thử sang repo gốc và hiện câu báo lỗi mới, không còn câu "`hf auth login`"
- [ ] Những máy đã có model từ trước (có `.crab-model.json`) vẫn dùng được ngay, không tải lại
- [ ] Đóng gói bản 1.1.16 bằng `dist:win`, cài thử trên một máy người dùng đã gặp lỗi
- [ ] Commit và phát hành
