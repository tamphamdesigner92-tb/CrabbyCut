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

## Việc đã làm (nhánh `win/v1.1.17`, chưa push)

| Commit | Nội dung |
|---|---|
| `1b4c5e9` | Nâng phiên bản lên 1.1.17. "Kịch bản" thành tab con cuối của tab "Văn bản". |
| `797af31` | Server TTS nhả model ngay khi mỗi lượt xong (kể cả nghe thử) và xoá cache CUDA/MPS/MLX. |
| `80246be` | VieNeu-TTS v3 Turbo thay F5-TTS. `setup_tts` tự chọn torch CUDA. Backend tắt server TTS sau mỗi lượt. |
| `774c374` | Nguồn "Văn bản" cho lồng tiếng, phụ đề sinh kèm, hồ sơ giọng trong Cài đặt. |
| `bb2dacd` | VieNeu v2 chạy GPU. Server tạm chuyển Hub sang offline trong lúc nạp model. |
| `5d9037e` | Sửa VoxCPM2 cho macOS (chưa kiểm trên Mac thật). Ghi log lỗi. Dọn model F5 cũ. |

### 1. Phiên bản và tab Kịch bản

- `package.json` và lock ở 1.1.17; `npm run test:app-version` PASS.
- Thêm `{id:'script'}` vào `EDIT_PANEL_SUBTABS.text`. `refreshScriptPane` chỉ vẽ khi `editPanelTab==='text' && editPanelTextSub==='script'`.
- Các câu hướng dẫn trỏ tới `tab "Văn bản → Kịch bản"`, có đủ vi/en/zh.
- Đã xem hình thật trong trình duyệt.

### 2. GPU và VRAM (đo trên GTX 1060 6 GB, Windows)

**Bóc băng:** không phải sửa. Chạy CUDA int8, VRAM 642 → ~1.870 → 643 MiB vì mỗi lượt là một tiến trình riêng và thoát khi xong.

**Lồng tiếng — GIỮ model, nhả khi cần (người dùng sửa lại 2026-10-11, thay cho "nhả sau mỗi lượt"):**
- Sau mỗi lượt, model được giữ trong VRAM để tạo giọng tiếp mà không phải nạp lại.
- Nhả bằng cách **tắt hẳn tiến trình server**. Cách này trả cả CUDA context, khoảng 160 MiB. Nó cũng là cách duy nhất trả sạch VRAM của Qwen3-TTS, vì nhả trong tiến trình thì Qwen còn giữ khoảng 4,4 GB.
- Server bị tắt trong ba trường hợp:
  1. **Lượt mới chọn model khác**, hoặc đổi chế độ Qwen3-TTS (`prepareServerFor`). Server của môi trường khác bị tắt; server cùng môi trường mà đang giữ model khác thì được khởi động lại.
  2. **Tính năng khác cần GPU bắt đầu**: route xuất video và mọi `runPythonSidecar` (bóc băng, lọc/sắp kịch bản, Auto-Reframe, xoá logo AI) gọi `ttsService.releaseAll()`. Nếu đang có lượt lồng tiếng chạy thì không giết giữa chừng; lượt đó xong là nhả ngay.
  3. **Rảnh 15 phút** (`IDLE_STOP_MS`, đổi được bằng `CRAB_TTS_IDLE_STOP_SECONDS`). Phía server cũng có `IDLE_UNLOAD_SECONDS` = 900 làm chốt chặn cuối.
- `CRAB_TTS_UNLOAD_AFTER_JOB=1` cho server nhả ngay sau mỗi lượt, dùng khi đo.

Đo thật trên GTX 1060 bằng cách gọi thẳng `tts-service`:

| Bước | Kết quả |
|---|---|
| VieNeu3 lượt 1 (bật server + nạp) | 44,6 s; VRAM 852 → 1.633 MiB |
| VieNeu3 lượt 2 | **0,8 s**, model còn ấm |
| Đổi sang Qwen3 | Server chính tắt, Qwen 5.623 MiB |
| `releaseAll` | **836 MiB** |
| Rảnh hết mốc (thử 20 s) | 825 MiB |
| `releaseAll` giữa lượt 6 câu | Lượt chạy xong đủ 6 câu, server tắt ngay sau đó |

**torch:**
- Ghim `2.11.0`. Máy NVIDIA có compute capability < 7.5 lấy `cu126`, còn lại lấy `cu128`. Máy không có NVIDIA và macOS lấy torch từ PyPI (Mac đã có MPS).
- Cài bằng MỘT lệnh pip. Với `--target`, hai lệnh riêng làm torch CPU ghi đè bản CUDA.
- `ENV_REVISION=2`: môi trường cũ bị coi là chưa cài, panel hiện lại nút cài. Máy NVIDIA tải khoảng 3,5 GB.
- Đã chạy thật `npm run setup:tts`: torch giữ `2.11.0+cu126`, CUDA True.

**Tốc độ, mỗi lượt gồm khởi động server + nạp + một câu:**

| Engine | Trước | Sau |
|---|---|---|
| VieNeu v3 GPU | — | nạp 11,5 s, cả lượt 17 s |
| VieNeu v3 CPU (ONNX) | — | nạp 9 s |
| VieNeu v2 | CPU 118 s | GPU 38 s |

Tăng tốc lúc nạp nhờ `_hub_offline()`: thư viện vẫn gọi Hub dù model đã nằm trên đĩa.

**Pascal:** VieNeu v3 trên sm < 7.0 bị ép fp32, vì bf16 trên Pascal chỉ là giả lập và fp16 chạy ở 1/64 tốc độ.

### 3. Mô hình tiếng Việt: VieNeu-TTS v3 Turbo (engine `vieneu3`, mặc định)

- Đường GPU dùng PyTorch: `vieneu3-torch` + `moss-nano`, ~420 MB. Đường CPU dùng ONNX: `vieneu3-onnx` + `moss-nano-onnx`, ~650 MB.
- SDK tự tải codec về `~/.cache/huggingface`. Lượt tải đó bị chặn và trỏ về `model_store`; đã kiểm, cache HF trống.
- 25 giọng có sẵn. Dropdown lọc được theo "Phong cách đọc": tự nhiên, tin tức, kể chuyện, đọc truyện.
- Clone từ hồ sơ giọng, không cần lời mẫu. Đã chạy thật: tạo hồ sơ từ một mp3 13 s rồi lồng tiếng 3 câu, có tiếng.
- Mẫu nghe thử ở `reports/v1.1.17_mau_giong/`: giọng có sẵn "Mai Anh" và giọng clone.
- F5-TTS đã gỡ khỏi server, model_store, requirements, UI và test. Prefs cũ trỏ `f5` tự chuyển sang `vieneu3`. Thư mục `f5-vi/` và `vocos/` trong kho model bị xoá một lần, chỉ khi có marker của model_store.

### 4. Hồ sơ giọng (Cài đặt → Hồ sơ giọng)

- Lưu ở `USER_DATA_ROOT/voice_profiles/<id>/{profile.json, reference.wav}`. Bản cài là `%LOCALAPPDATA%\CrabbyCut\voice_profiles`.
- Tệp gốc được chép và chuẩn hoá về WAV mono 44,1 kHz, tối đa 20 s; hồ sơ vẫn chạy khi tệp gốc bị xoá.
- Làm được: tạo, nghe, đổi tên, sửa lời mẫu, xoá, mở thư mục. Thay đổi ghi ngay, không cần bấm Lưu.
- API `/api/voice-profiles` (GET/POST/PATCH/DELETE, `/:id/audio`). Panel lồng tiếng chỉ gửi `voice_profile: id`.
- Test: `npm run test:voice-profiles`.

### 5. Lồng tiếng từ văn bản

- Chuyển nguồn bằng hai nút "Phụ đề (có mốc thời gian)" / "Văn bản".
- Nhập văn bản bằng cách gõ tay, nạp .txt/.md/.docx, hoặc kéo thả. Tệp .doc kiểu cũ thì báo lưu sang .docx.
- Câu được tách theo dấu câu và xuống dòng, câu dài quá 220 ký tự bị cắt tiếp.
- Server dùng chế độ `sequential`: các câu nối tiếp nhau, khoảng nghỉ 0,2–1,2 s. Điểm bắt đầu là đầu timeline hoặc playhead.
- Phụ đề khớp tiếng được bật sẵn và có ô tắt. Chúng tạo qua `LocalSubtitlePanel.importCues`; câu dài hơn 84 ký tự chia thành nhiều block theo tỉ lệ ký tự.
- Đã chạy thật trong trình duyệt: 3 câu, nghỉ 0,4 s, 3 block phụ đề đúng mốc.

### 6. Xuất riêng âm thanh — hai ô Video / Audio kiểu CapCut (thêm 2026-10-11)

Quyết định của người dùng:
- Mặc định LUÔN chỉ tích Video, xuất như cũ (video có cả hình lẫn tiếng).
- Tích Video + Audio: xuất video bình thường, cộng thêm một tệp âm thanh riêng cùng tên, đặt cạnh video. Nếu đã có tệp trùng tên thì ghi đè, như hộp lưu đã hỏi.
- Chỉ tích Audio: chỉ xuất tệp âm thanh.
- Định dạng MP3 / WAV / AAC (.m4a) / FLAC, mặc định MP3. MP3 và AAC chọn được bitrate 128/192/320k. WAV là PCM 16-bit, FLAC nén không mất dữ liệu.

Cách làm:
- **Sidecar**, lệnh mới `export-audio`: chạy đúng MỘT lượt `AudioOnly`, dùng chung `WriteFilterScript` và `OverlaysForAudioPass` với lượt tiếng của export-video. Vì vậy tệp riêng nghe y hệt tiếng trong video.
  - Bộ mã hoá chọn theo `settings.audio_format`.
  - Lượt này không dò GPU và không giải mã hình.
- **Backend** (`/api/export-video`):
  - Đọc thêm `export_video`, `export_audio`, `audio_file_format`, `audio_file_bitrate`.
  - Khoá `audio_format` chỉ ghi vào tệp timeline riêng của lượt export-audio, vì sidecar dò khoá này trong cả tệp.
  - Kiểm độ dài tệp âm thanh như với video.
  - Chỉ Audio thì đường dẫn đã ký phải có đuôi âm thanh.
- **main.js**: `export-pick-output` nhận thêm đuôi mp3, wav, m4a, flac.
- **Giao diện**:
  - Ô tích nằm trong `<legend>`, nên `fieldset disabled` khoá các ô còn lại mà không khoá chính nó.
  - Nhãn nút đổi theo lựa chọn: "Xuất video ngay", "Xuất âm thanh ngay", "Xuất video + âm thanh".
- **Chỉ Audio thì bỏ hết khâu vẽ trước phần hình** (chữ, chuyển cảnh, retouch, màu, xoá logo AI).
  - Vẫn giữ keyframe âm lượng.
  - Vẫn cắt item ở vùng chuyển cảnh overlay, vì lượt xuất video cũng cắt cả tiếng ở đó (`appendOverlayTransitionItems(…, {trimOnly})`).

Đã kiểm:
- `npm run test:export-audio-file` (mới):
  - Đủ 4 định dạng: đúng codec, không có luồng hình, dài đúng timeline với 2 đoạn cắt.
  - Video + Audio: mức âm của tệp riêng bằng tiếng trong video (-21,1 / -21,1 dB).
  - Từ chối đúng: sai đuôi, hoặc bỏ cả hai ô.
- Không vỡ test cũ: `export`, `export-output-path`, `audio-mix`, `audio-denoise`, `clip-speed`, `export-render-cache`, `export-parallel`.
- Giao diện thật trong trình duyệt, timeline 30 s có block lồng tiếng: chỉ Audio WAV mất khoảng 1 s, đoạn có lồng tiếng -16,9 dB, đoạn chỉ có lane chính -21,1 dB.

Chưa kiểm:
- **macOS**: ffmpeg của bản Mac có `libmp3lame` không.
- Hộp lưu Electron thật (đã kiểm qua đường ký HMAC trong test).

Biết sẵn từ trước, không thuộc đợt này:
- Tắt tiếng lane chính không áp vào bản xuất (cả video lẫn âm thanh).
- Track media bị ẩn thì mất luôn tiếng của nó.

### 7. Thêm Qwen3-TTS và Chatterbox Multilingual (thêm 2026-10-11)

Quyết định của người dùng:
- **Mỗi engine một môi trường Python riêng.**
- **Qwen3-TTS:** bản 0.6B cho mọi máy. Bản 1.7B (thiết kế giọng) chỉ mở khi máy có GPU RTX 20 trở lên và từ 8 GB VRAM, hoặc là Mac.
- **Chatterbox:** chỉ dùng bản chính thức. Bản tiếng Việt cộng đồng "Viterbox" có giấy phép CC BY-NC nên không đưa vào.
- **Cách cài:** mỗi engine có nút "Cài thêm" riêng trong panel.

Dữ kiện đã kiểm:
- Cả hai mô hình **không có tiếng Việt**. Qwen3-TTS có 10 ngôn ngữ, Chatterbox có 23.
- Gói ghim phiên bản cứng nên không chung môi trường được:
  - `qwen-tts` 0.1.1 ghim transformers 4.57.3.
  - `chatterbox-tts` 0.1.7 ghim torch 2.6.0, numpy < 2, transformers 5.2.0, diffusers 0.29.0.
- Gói `chatterbox-tts` 0.1.7 trên PyPI nạp **Multilingual V2**: `t3_mtl23ls_v2` + `s3gen.pt` + `ve.pt`. V3 mới chỉ có trên nhánh main ở GitHub. Bản Mac dùng mlx-community `chatterbox-multilingual-v3`.
- Mọi tệp Chatterbox xuất ra đều có watermark Perth, panel có ghi chú việc này.
- Qwen trên Windows in cảnh báo "SoX not found" nhưng vẫn chạy bình thường.

Cách làm:
- **`scripts/setup_tts.js` có bảng `ENVS`:**

  | Môi trường | Thư mục | Thư viện chính |
  |---|---|---|
  | main | `.venv-tts` / `runtime/tts-site` | — |
  | qwen | `.venv-tts-qwen` | torch 2.11 |
  | chatterbox | `.venv-tts-chatterbox` | torch 2.6, luôn cu126 vì torch 2.6 không có cu128 |

  - Marker và `revision` tính riêng cho từng môi trường. Lệnh cài: `node scripts/setup_tts.js --env qwen|chatterbox`.
  - Hàm `nvidiaInfo()` đọc compute capability + VRAM để quyết định có mở chế độ thiết kế giọng hay không.
- **`tts/server.py`:**
  - Mỗi môi trường chạy chung tệp này. `CRAB_TTS_ENV` lọc engine: Windows/Linux đặt Qwen3/Chatterbox ở môi trường riêng; Mac để cả năm engine ở môi trường chính, chạy bằng mlx-audio.
  - `Qwen3Engine`:
    - Ba chế độ, mỗi chế độ một checkpoint: custom = 0.6B CustomVoice với 9 giọng + instruct; clone = 0.6B Base, dùng lời mẫu nếu có, không có thì dùng x-vector; design = 1.7B VoiceDesign.
    - dtype fp32 trước Volta, fp16 từ Volta, bf16 từ Ampere.
  - `ChatterboxEngine`:
    - 23 ngôn ngữ, giọng mặc định hoặc hồ sơ giọng, hai thanh `exaggeration` và `cfg_weight`.
    - `Cangjie5_TC.json` được trỏ về kho model thay vì để gói tự tải vào cache HF.
  - Mọi lệnh MLX đi qua `_mlx_run`, một luồng dùng chung cho VoxCPM, Qwen và Chatterbox.
- **`backend/tts-service.js`:**
  - Ba server trên ba cổng: 4124 (chính), 4125 (Qwen), 4126 (Chatterbox).
  - `engineEnv()` định tuyến job; mỗi `job_id` được nhớ kèm môi trường. Server nào cũng tắt sau mỗi lượt.
  - Trạng thái gửi cho panel có `envs` và các trường `env_*` của từng engine. `/api/tts/setup` nhận `{env}`.
- **Panel:** nút "Cài thêm …" khi môi trường chưa cài; chọn chế độ, ngôn ngữ và instruct cho Qwen; chọn ngôn ngữ, giọng hoặc hồ sơ, và hai thanh trượt cho Chatterbox.

Đo trên GTX 1060 6 GB (Windows), một câu tiếng Anh:

| | Nạp | Sinh | Đỉnh VRAM | Sau khi tắt server |
|---|---|---|---|---|
| Qwen3 0.6B CustomVoice | 11,9 s | ~15 s cho 3,8 s tiếng | 5.631 MiB (sát 6 GB) | 820 MiB (về nền) |
| Qwen3 0.6B Base (clone, x-vector) | 11,8 s | ~32 s cho 3 s tiếng | 5.654 MiB | 812 MiB |
| Chatterbox Multilingual | 46,5 s | — | 4.367 MiB | 778 MiB |

- Qwen nhả model trong tiến trình chỉ về khoảng 4,4 GB. Có thể thư viện còn giữ tham chiếu ở đâu đó, chưa tìm ra. Vì vậy khi đổi model, backend tắt hẳn server thay vì chỉ nhả model trong tiến trình (xem mục 2).
- Đã chạy trọn vòng qua giao diện thật: văn bản → Qwen3 (Aiden, English) và văn bản → Chatterbox (en). Cả hai lượt đều có audio và phụ đề, server tự tắt, VRAM về khoảng 790 MiB.
- Mẫu nghe ở `reports/v1.1.17_mau_giong/`: `qwen3_*`, `chatterbox_mac_dinh.wav`.
- Test: `test:tts-engines` (mới; sổ engine theo môi trường, chế độ Qwen, ngôn ngữ Chatterbox) và `test:dubbing-panel` (thêm mục 5).

Chưa kiểm:
- **Mac**: đường MLX của Qwen3 và Chatterbox.
- **Bản 1.7B VoiceDesign**: máy này không đủ sức chạy.
- **Bộ cài .exe** (chế độ `site`, `pip --target` với Python nhúng) cho hai môi trường mới.
- **RTX 50**: Chatterbox sẽ không chạy được GPU, vì torch 2.6 không có sm_120.

## Chưa làm, chưa kiểm, cần biết

- **Chưa push và chưa tạo PR.** `main` có ruleset nên phải đi PR và qua CI Win+Mac. **Chưa đóng gói** `dist:win`.
- **Chưa thử trên Mac thật:** các sửa VoxCPM2, VieNeu v3 trên MPS, tìm Python ≥ 3.10, cài mlx-audio riêng.
  - Lần tới trên Mac: nếu còn lỗi, gửi `~/Library/Application Support/CrabbyCut/logs/tts_errors.log`.
- **Chưa thử** đường `cu128` (RTX 20 trở lên) và RTX 50.
- **Nghe thử cũng tắt server sau lượt**, theo yêu cầu trả VRAM. Mỗi lần nghe thử nạp lại khoảng 12–15 s trên GPU.
- **Undo:** audio lồng tiếng và phụ đề sinh kèm là hai bước Ctrl+Z riêng.
- Lồng tiếng văn bản vẫn cần có video trên lane chính; audio bị kẹp ở cuối timeline.
- VoxCPM2 chưa nối clone bằng giọng mẫu. Thẻ cảm xúc thử nghiệm của VieNeu v3 (`[cười]`…) chưa đưa ra giao diện.
- Có từ trước, không thuộc đợt này: `addSourcePathsToMainLane` không nhận đường dẫn 8.3 (`THANHT~1`).

## VoxCPM2 trên macOS: nguyên nhân khả dĩ và cách đã sửa (`5d9037e`, chưa kiểm trên Mac thật)

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

