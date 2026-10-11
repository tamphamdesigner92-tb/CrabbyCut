# Kế hoạch CrabbyCut v1.1.17

Nhánh: `win/v1.1.17` (tách từ `main` `099f30b`). Bắt đầu 2026-10-11.

## Mục tiêu (người dùng giao)

1. Nâng phiên bản lên 1.1.17.
2. Dời tab "Kịch bản" vào tab "Văn bản", làm tab con.
3. Lồng tiếng và bóc băng: mô hình phải chạy trên GPU (nạp vào VRAM) và được xoá khỏi VRAM ngay khi xong mỗi lượt.
4. Hồ sơ giọng clone nằm trong Cài đặt: đặt tên được, có nhiều hồ sơ, dữ liệu không mất khi cài lại hoặc nâng cấp.
5. VoxCPM2 trên macOS không tạo được giọng: tìm nguyên nhân và đề xuất cách sửa.
6. Tìm mô hình tiếng Việt tốt hơn F5-TTS (có giọng mặc định, clone tốt, nhẹ).
7. Lồng tiếng nhận văn bản bất kỳ (gõ tay hoặc .txt/.doc…), cho chọn tốc độ và phong cách khi văn bản không có mốc thời gian.

## Quyết định đã chốt (2026-10-11, người dùng chọn)

| Câu hỏi | Chọn | Ghi chú |
|---|---|---|
| Mô hình tiếng Việt | **VieNeu-TTS v3 Turbo, gỡ F5-TTS** | Giữ VieNeu v2 và VoxCPM2. Weights F5 tiếng Việt gần như chắc là CC-BY-NC (base F5 huấn luyện trên Emilia). |
| Nơi lưu hồ sơ giọng | `%LOCALAPPDATA%\CrabbyCut\voice_profiles` (macOS: `~/Library/Application Support/CrabbyCut/voice_profiles`) | Cạnh `settings/` và `tts_models/`. Bộ gỡ cài chỉ hỏi xoá `runtime/`, nên thư mục này sống sót. Trong Cài đặt có nút "Mở thư mục". |
| GPU cho lồng tiếng trên Windows | **Tự cài torch CUDA khi thấy card NVIDIA** | Thêm yêu cầu: **macOS phải chạy GPU** (MPS/MLX), không chạy CPU. |
| Văn bản không có mốc thời gian | **Tạo audio kèm phụ đề khớp tiếng; có ô tắt, mặc định bật** | Tách câu, đọc nối tiếp từ playhead, chỉnh được tốc độ, giọng/phong cách, khoảng nghỉ giữa câu. |

## Dữ kiện đã đo

- **Bóc băng (Windows, GTX 1060 6 GB):** chạy CUDA int8. Trong lúc chạy VRAM lên từ 642 tới khoảng 1.870 MiB, xong thì về 643 MiB vì mỗi lượt là một tiến trình riêng và tiến trình thoát khi xong. Đạt yêu cầu, không phải sửa. Đo bằng `nvidia-smi` mỗi 0,5 s, tệp 13 s.
- **Lồng tiếng trước khi sửa:**
  - Model được giữ thêm 5 phút sau mỗi lượt.
  - Môi trường TTS trên Windows dùng `torch 2.14.0+cpu` + `torchaudio 2.11.0` (lệch phiên bản), `torch_index: null`, nên F5 chạy CPU.
  - VieNeu v2 bị ghim CPU: nạp 68 s, một câu tổng cộng 112 s.
- **Torch CUDA cho Pascal (GTX 10xx, sm_61):**
  - Từ torch 2.8, các bản cu128/cu129 đã bỏ Pascal; CUDA 13 chỉ hỗ trợ từ sm_75 trở lên.
  - Cặp khớp nhau là `torch==2.11.0` + `torchaudio==2.11.0` (torchaudio dừng ở 2.11).
  - Chọn index theo card: compute capability < 7.5 dùng `cu126`, ≥ 7.5 dùng `cu128`.
  - Gói torch tải khoảng 2,6 GB.
- **VieNeu v3 Turbo** (`pnnbao-ump/VieNeu-TTS-v3-Turbo`, Apache-2.0, không gated):
  - 25 giọng có sẵn (Bắc/Trung/Nam; tự nhiên, tin tức, kể chuyện, đọc truyện).
  - Clone qua `ref_audio`. Ra 48 kHz. Codec MOSS-Audio-Tokenizer-Nano (Apache-2.0).
  - Đường GPU (PyTorch) cần khoảng 410 MB, đường CPU (ONNX) khoảng 640 MB.
  - SDK `vieneu` 3.8.3 đã có trong môi trường.

## Việc đã làm

- [x] Nâng 1.1.17 (`package.json` + lock), `npm run test:app-version` PASS.
- [x] Dời "Kịch bản" thành tab con cuối cùng của "Văn bản".
  - Sửa luôn chỗ chặn ở `refreshScriptPane` và các câu hướng dẫn trỏ tới `tab "Văn bản → Kịch bản"` (vi/en/zh).
  - Đã xem hình thật trong trình duyệt. `i18n:check`, `subtitle_import`, `auto_subtitle`, `dubbing_panel` đều PASS.
- [x] TTS server nhả model ngay khi mỗi lượt xong, kể cả lượt nghe thử, rồi xoá cache CUDA/MPS/MLX.
  - Việc nhả nằm trong cổng job, nên không lượt mới nào bị mất model giữa chừng.
  - `CRAB_TTS_KEEP_LOADED=1` để giữ kiểu cũ.
  - Đã chạy thật với VieNeu: xong thì `/health` báo `loaded: False`.

## VoxCPM2 trên macOS: nguyên nhân khả dĩ (chưa có log, chưa tái hiện được trên Mac)

Mã gọi API đúng với mlx-audio hiện tại: `mlx_audio.tts.load_model`, `generate(text=, instruct=)`, kết quả `GenerationResult.audio` là float32. Các nguyên nhân xếp theo khả năng:

1. **MLX gắn GPU stream với luồng (mlx ≥ 0.31.2).**
   - Server mở một `threading.Thread` mới cho mỗi job, nên lượt sau chạy ở luồng khác lượt nạp và chết với lỗi `There is no Stream(gpu, 0) in current thread` (ml-explore/mlx#3727, Blaizzy/mlx-audio#744).
   - Sửa: mọi lệnh MLX của VoxCPM (import, nạp, sinh, xoá cache) chạy trên một luồng cố định (`ThreadPoolExecutor(max_workers=1)`).
2. **Môi trường Mac không cài được mlx-audio.**
   - Bản Mac không có Python nhúng, nên `setup_tts.js` lấy `python3` trên PATH. Với app GUI đó thường là `/usr/bin/python3` 3.9, trong khi mlx-audio cần ≥ 3.10.
   - MLX chỉ có wheel cho arm64 và macOS ≥ 14.
   - Lệnh `pip -r` chung nên hỏng một gói là đổ cả lượt.
   - Sửa: marker `platform_machine == "arm64"`, kiểm arm64 + macOS 14 trong `availability()`, kiểm Python ≥ 3.10 trước khi tạo venv, cài mlx-audio bằng lệnh riêng.
3. Thiếu extra `mlx-audio[tts]` (sentencepiece…).
4. Máy 8 GB thiếu RAM: model 3,2 GB lại bị nạp lại mỗi lượt.
5. Ghi traceback của job ra tệp log để lần sau có bằng chứng.

## Việc còn lại

- [ ] Engine `vieneu3`: GPU khi có CUDA (Windows) hoặc MPS (macOS), ONNX CPU chỉ khi không có GPU. Đặt làm mặc định.
- [ ] Gỡ F5 khỏi server, model_store, requirements, UI và test.
- [ ] Hồ sơ giọng: backend lưu trữ + API, mục Cài đặt (tạo, đặt tên, nghe thử, xoá, mở thư mục), panel lồng tiếng chọn được hồ sơ.
- [ ] Nguồn "Văn bản" cho lồng tiếng: gõ tay hoặc nạp tệp, tách câu, đọc nối tiếp, sinh phụ đề kèm.
- [ ] `setup_tts.js`: tự cài torch 2.11.0 CUDA (cu126/cu128 theo compute capability) bằng một lệnh pip, ghim torch/torchaudio.
- [ ] VoxCPM: áp các sửa ở trên (chưa kiểm được trên Mac).
