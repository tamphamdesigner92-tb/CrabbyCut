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
- ~~Repo gốc giấu mã hash~~ — **đính chính 09/10/2026:** repo gốc vẫn công bố hash LFS cho người chưa đăng nhập qua `HfApi().model_info(repo, files_metadata=True)`: `3ddd9e56…a6b3`, **trùng** với mirror. Đã tải `model.onnx` từ chính repo gốc (tài khoản `TamPham92` đã được duyệt) và `sha256sum` ra đúng giá trị đó.
- Người đăng mirror có thể sửa hoặc xoá repo bất cứ lúc nào — app kiểm SHA256 sau khi tải nên file bị tráo sẽ bị từ chối, và repo mất thì app thử nguồn kế.

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

- [x] Đã tải `model.onnx` gốc và ghi lại SHA256 — `3ddd9e56396e6029e0e948ac0255c89c803f981f23dcf4c154f50820bd74a6b3` (09/10/2026)
- [ ] Đã tạo repo mirror công khai, có LICENSE và README ghi nguồn — **chờ tác giả quyết** (đăng công khai dưới tài khoản của tác giả). Trong lúc chờ, `mirrors` chỉ có bản mirror bên thứ ba `aoiandroid/…-mirror`, đã đối chiếu hash.
- [x] Mirror bên thứ ba tải được KHÔNG cần token (thử thật, `token=False`, 312 MB trong 27 s)
- [x] Đã sửa `model_store.py`: danh sách nguồn, kiểm SHA256, câu báo lỗi mới. Thay cho biến môi trường `HF_HUB_DISABLE_IMPLICIT_TOKEN` (hub chỉ đọc lúc import), mirror được gọi với `token=False` theo từng lượt.
- [x] Test không cần mạng: `npm run test:tts-model-store` (hub giả: 404, 401, sai hash, model có sẵn, mất mạng)
- [x] Thử thật trên máy không token (`HF_HUB_DISABLE_IMPLICIT_TOKEN=1`, `HF_TOKEN_PATH` trống, thư mục model riêng): tải từ mirror → `.crab-model.json` ghi `repo` = mirror
- [x] Tạo lồng tiếng VieNeu ra âm thanh trên "máy sạch" (không token, thư mục model trống): gọi thẳng `VieNeuEngine` của `tts/server.py` — tải đủ model, nạp 118 s (CPU), sinh 3,58 s tiếng (peak 0,97, RMS 0,14). Chưa thử qua giao diện app.
- [x] Tạm sửa `sha256` thành giá trị sai: file bị xoá, thử sang repo gốc, báo lỗi "Không tải được NeuCodec decoder từ mọi nguồn…", không để lại `model.onnx`
- [x] Tạm đổi tên mirror thành repo không tồn tại: thử sang repo gốc (401 khi không token) và hiện câu báo lỗi mới, không còn "`hf auth login`"
- [x] Những máy đã có model từ trước (có `.crab-model.json`) vẫn dùng được ngay, không tải lại (0,0 s, không gọi mạng)
- [x] Đóng gói bản 1.1.16 bằng `dist:win` (09/10/2026): `dist/CrabbyCut-Setup-1.1.16.exe` 165.676.573 byte, after-pack check ok. Bản này gồm cả sửa zoom timeline ở Match Script.
- [ ] Cài thử trên một máy người dùng đã gặp lỗi
- [x] Commit (local `main`: `00925dc` sửa tải, `231a709` sửa zoom, `3fa4cec` nâng 1.1.16)
- [ ] Push + phát hành GitHub Release v1.1.16 — **chờ tác giả cho phép** (cùng câu hỏi mirror riêng ở trên; nếu tạo mirror riêng thì thêm nó vào ĐẦU `mirrors` rồi đóng gói lại)
