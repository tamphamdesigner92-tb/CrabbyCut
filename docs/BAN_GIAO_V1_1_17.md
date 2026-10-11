# Bàn giao CrabbyCut v1.1.17 — 2026-10-11

Chi tiết đầy đủ, gồm quyết định, số đo và nguyên nhân VoxCPM2, nằm ở [KE_HOACH_V1_1_17.md](KE_HOACH_V1_1_17.md). Tệp này chỉ tóm lại trạng thái để làm tiếp.

## Trạng thái

- Nhánh `win/v1.1.17` có 9 commit trên `main` `099f30b`. **Chưa push, chưa PR, chưa đóng gói.**
- Thêm sau nữa: **Qwen3-TTS + Chatterbox Multilingual** cho lồng tiếng, mỗi engine một môi trường Python riêng (`.venv-tts-qwen`, `.venv-tts-chatterbox`) và server riêng (cổng 4125/4126) — mục 7 của kế hoạch. Đã chạy thật cả hai trên GTX 1060; chưa kiểm Mac (MLX), bản 1.7B và bộ cài .exe.
- Thêm sau: **xuất riêng âm thanh** (hai ô Video / Audio kiểu CapCut, MP3/WAV/AAC/FLAC), commit `a777704`, mục 6 của kế hoạch. Đã build lại sidecar (`npm run build:sidecar`); CI Mac phải build lại cho bản Mac.
- Đã làm xong cả 7 mục người dùng giao. Riêng VoxCPM2 trên macOS mới **sửa theo nguyên nhân khả dĩ**, chưa chạy trên Mac thật.
- Test đã chạy và PASS:
  - Node: `export-audio-file` (mới), `export`, `export-output-path`, `audio-mix`, `audio-denoise`, `clip-speed`, `export-render-cache`, `export-parallel`, `dubbing-panel`, `voice-profiles` (mới), `subtitle-import`, `auto-subtitle`, `app-settings`, `app-version`, `model-downloads`.
  - Python: `dubbing-core`, `tts-model-store`.
  - i18n: `i18n`, `i18n:check` (en/zh 1852/1852).
  - Chưa chạy cả bộ `npm test`.
- Đã chạy thật trên Windows (GTX 1060):
  - VieNeu v3 trên GPU và CPU, VieNeu v2 trên GPU.
  - Lồng tiếng văn bản kèm phụ đề.
  - Hồ sơ giọng: tạo rồi lồng tiếng bằng giọng clone.
  - VRAM về đúng mức nền sau mỗi lượt.
  - `npm run setup:tts` dựng lại được `.venv-tts` với `torch 2.11.0+cu126`.

## Việc tiếp theo, theo thứ tự

1. Nghe hai mẫu trong `reports/v1.1.17_mau_giong/`: giọng có sẵn và giọng clone. Đánh giá chất lượng tiếng Việt của VieNeu v3.
2. Thử trên Mac (Apple Silicon, macOS ≥ 14):
   - Xuất riêng âm thanh MP3: kiểm ffmpeg bản Mac có `libmp3lame`.
   - Qwen3-TTS và Chatterbox qua mlx-audio (giọng có sẵn, nhân bản, thiết kế giọng 1.7B).
   - Cài lại môi trường lồng tiếng. Bản cũ sẽ tự hiện nút cài vì `ENV_REVISION=2`.
   - Chạy VieNeu v3 trên MPS và VoxCPM2.
   - Nếu lỗi, lấy `~/Library/Application Support/CrabbyCut/logs/tts_errors.log`.
3. Push nhánh, mở PR vào `main` (ruleset bắt buộc CI Win+Mac), rồi đóng gói `dist:win`.
4. Ghi trong ghi chú phát hành:
   - Người dùng có card NVIDIA phải cài lại thư viện lồng tiếng một lần, tải khoảng 3,5 GB.
   - F5-TTS đã bị gỡ.

## Lưu ý khi sửa tiếp

- Server TTS **tắt sau mỗi lượt**, kể cả nghe thử. Muốn giữ server sống khi đo hoặc thử nhiều lượt liền thì đặt `CRAB_TTS_KEEP_LOADED=1`.
- Kho model nằm ở `%LOCALAPPDATA%\CrabbyCut\tts_models`. Hồ sơ giọng nằm ở `USER_DATA_ROOT/voice_profiles`; chạy từ mã nguồn thì đó là thư mục dự án, đã đưa vào `.gitignore`.
- Script đo VRAM nằm ở scratchpad của phiên, không lưu lại. Cách đo: bật `tts/server.py` bằng `.venv-tts`, POST `/v1/dub/jobs`, poll, lấy mẫu `nvidia-smi` mỗi giây.
