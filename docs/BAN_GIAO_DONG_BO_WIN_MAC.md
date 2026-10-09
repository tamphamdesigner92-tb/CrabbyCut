# Bàn giao — Một `main` cho cả Windows và macOS

> Mục đích: mở một phiên làm việc mới (trên máy nào cũng vậy) là đọc **đúng file này** rồi làm
> tiếp được ngay. Quy trình lâu dài và các bẫy nền tảng nằm ở [DONG_BO_WIN_MAC.md](DONG_BO_WIN_MAC.md);
> file này chỉ ghi **đợt việc 2026-10-05**: đã làm gì, đang ở đâu, còn gì.
> Xoá file này khi PR #2 đã gộp, máy Windows đã kéo về và chạy xanh.

Cập nhật: 2026-10-05 · Nhánh `sync/main-mac-win` (tách từ `main` `c31311e`) · PR
[#2](https://github.com/tamphamdesigner92-tb/CrabbyCut/pull/2) đang mở, **chưa gộp**.

---

## 1. Tình trạng một dòng

Đến 2026-10-04, `main` (do máy Windows đẩy lên) **không biên dịch được** trên Mac và có 24 test
đỏ. Sau đợt này, trên Mac (M1 Pro, macOS 26) và cùng một mã nguồn: **102/104 test xanh, 0 đỏ,
2 lỗ hổng đã biết** (§5). Máy Windows **chưa chạy** nhánh này; CI của PR #2 là lần đầu phần sửa
C++ được biên dịch trên Windows (§4).

---

## 2. Đã xong (đã commit + đẩy lên `sync/main-mac-win`)

| Commit | Nội dung |
|---|---|
| `ad7d679` | **Sidecar** biên dịch và chạy đúng trên macOS: `mtime` ép `long long` (libc++ dùng `__int128`); `RunIn` POSIX bằng `posix_spawn` + `cd` (trước đây bỏ qua thư mục làm việc); chạy song song nhánh POSIX trong `RunBatchJobs`; `RunQuiet` POSIX có hạn giờ; chuyển tiếp SIGTERM/SIGINT cho ffmpeg con; `threads=1` cho `scale` nhánh lớp phủ (macOS trần 4096 luồng/tiến trình — 131 phụ đề làm VideoToolbox treo); VideoToolbox `-realtime 0` khi xuất (trần ~66 → ~194 khung/s); `build_sidecar.js` xoá binary cũ trước khi biên dịch |
| `b1c40ed` | **Backend**: `pathIsInsideDir()` realpath cả gốc (`/var` → `/private/var`); đặt mtime giữa mili giây (APFS lưu nano giây) |
| `393dc1a` | **Test** không phụ thuộc nền tảng: proxy all-intra (VideoToolbox gắn SEI mọi khung), định danh khung retouch bằng cả bộ RGB |
| `de1bf88` | **CI** macOS + Windows (`.github/workflows/ci.yml`); `npm run test:all` (`scripts/run_tests.js`: mỗi test chạy riêng, có hạn giờ, bảng tổng); `tests/known-platform-gaps.json`; `.gitattributes` (LF mọi tệp); tài liệu quy trình [DONG_BO_WIN_MAC.md](DONG_BO_WIN_MAC.md) |
| `5f2cbe3` `358030e` `f78a731` `7d31750` `564674a` `211c6d5` | Gộp nhánh `CrabbyCut_Remove-logo` (Xoá logo, Xoá vật thể LaMa) — commit LaMa trước đó nằm lại trên nhánh đó, chưa vào `main` |
| `78e5995` | Số đo thật trên Mac vào Bước M của [KE_HOACH_TOI_UU_EXPORT_WIN.md](KE_HOACH_TOI_UU_EXPORT_WIN.md) (Bin Tom 30,0 → 10,2 s) |
| `694ca41` | **ffmpeg ghim cho macOS** (§3): `scripts/ffmpeg_pin.js` theo nền tảng (`pinFor()`), `npm run ffmpeg:install` (`scripts/install_ffmpeg.js`, thay `ci_install_ffmpeg.js`), `run_tests.js` dùng cùng ffmpeg với backend + cảnh báo khi không phải bản ghim |

Mỗi bẫy kèm hậu quả và cách sửa: bảng ở [DONG_BO_WIN_MAC.md](DONG_BO_WIN_MAC.md) mục 4.

---

## 3. ffmpeg: hai máy chạy cùng một FFmpeg

| | Windows | macOS |
|---|---|---|
| Bản | `n8.1.1-crabbycut.2` win64 | `n8.1.1-crabbycut.2` macOS arm64 (macOS 11+) |
| Dựng bằng | `build.sh` (MSYS2) | `build-macos.sh` — repo [ffmpeg-for-CrabbyCut](https://github.com/tamphamdesigner92-tb/ffmpeg-for-CrabbyCut) `8532671` |
| Release | [n8.1.1-crabbycut.2](https://github.com/tamphamdesigner92-tb/ffmpeg-for-CrabbyCut/releases/tag/n8.1.1-crabbycut.2) | [n8.1.1-crabbycut.2-macos](https://github.com/tamphamdesigner92-tb/ffmpeg-for-CrabbyCut/releases/tag/n8.1.1-crabbycut.2-macos) — đã tải lại kiểm SHA-256 `37feb81d…` khớp |
| Tăng tốc | CUDA/NVENC (+ bộ lọc `crabgeo_cuda`/`crabblend_cuda`) | VideoToolbox; không `libplacebo` → tonemap HDR đi `zscale` |

Cùng commit FFmpeg (`239f2c7`), cùng 3 bản vá, cùng phiên bản thư viện ngoài. Bản Mac dựng tĩnh, chỉ
phụ thuộc thư viện hệ thống; dựng sạch ~5 phút; hai lượt dựng độc lập cho đầu ra trùng từng byte.
`npm run ffmpeg:install` cài bản ghim vào thư mục runtime mà backend và `test:all` nối vào đầu PATH
(`~/Library/Application Support/CrabbyCut/runtime/ffmpeg/bin`, `%LOCALAPPDATA%\CrabbyCut\runtime\ffmpeg\bin`).
Mac dev đã cài; ffmpeg Homebrew còn trên máy nhưng CrabbyCut không gọi nữa.

---

## 4. Việc tiếp theo

1. ~~**Xem CI của PR #2**~~ — **XONG**: cả `macos-14` và `windows-2022` xanh trên head `f812d1a`.
2. ~~**Gộp PR #2**~~ — **XONG 2026-10-09**, merge commit `10179f7` (app 1.1.16). Còn lại: nên bật
   branch protection cho `main` (Settings › Branches, bắt buộc hai job CI) — chưa làm.
3. **Trên máy Windows**, sau khi gộp:
   ```bash
   git switch main
   git pull --rebase origin main
   npm run ffmpeg:install
   npm run build:native
   npm run test:all
   ```
   `ffmpeg:install` báo "Đã có" nếu bộ cài đã đặt đúng bản ghim. Nếu `git status` báo nhiều tệp đổi
   mà `git diff` trống (máy bật `core.autocrlf=true`): `git add --renormalize .` một lần.
   Kết quả test:all trên Windows ghi vào §6 của file này.
4. ~~Nhánh cũ `mac/export-wip-20261004`~~ — **ĐÃ XOÁ 2026-10-09** (không gộp; commit WIP `76efd66`,
   lấy lại trong hạn reflog: `git branch mac/export-wip-20261004 76efd66`).

---

## 5. Đã quyết: hai ngưỡng test chuyển sang so tương đối (2026-10-05)

Hai ngưỡng chỉnh trên x86 mà Apple Silicon không đạt (làm tròn SIMD x86 ≠ ARM/C, đo dưới Rosetta —
[DONG_BO_WIN_MAC.md](DONG_BO_WIN_MAC.md) mục 6). Người dùng duyệt đổi sang so tương đối:
- `test:export-fast-path` (ProRes): so bản chuẩn, mới không kém cũ ở mặt phẳng nào (Mac: luma
  44,6 → 66,4 dB so bản chuẩn).
- `test:retouch-export`: mép mềm giảm bậc nhảy ≥ 3 lần so với mép cứng (Mac 8 → 2, Windows 4 → 1).

`tests/known-platform-gaps.json` trống. Trên Mac: 104/104 (trừ test Python khi `--skip-python`).

**CI lần đầu (cũng 2026-10-05)** lộ ra các test dựa vào thứ chỉ máy dev có — đã sửa: ngôn ngữ của
updater, tài nguyên `library/` không nằm trong git, môi trường Python AI (`--skip-python` →
`CRABBYCUT_TEST_SKIP_PYTHON=1`), đuôi `.exe`, chờ cứng 700 ms, `fs.cpSync` thư mục tên có dấu làm Node
chết native trên Windows. **Còn theo dõi:** `test:media-scale-fit` ca keyframe đỏ MỘT lần trên runner
Windows (khung 8 khác nhau), hai lượt khác xanh, Mac 8/8 lần xanh — chưa rõ nguồn không tất định.

**Chưa làm (ngoài phạm vi đợt này):**
- Bộ cài macOS: `scripts/setup_runtime.js` mới chỉ hỗ trợ Windows (Python nhúng, tải ffmpeg). Bản
  Mac đóng gói chưa tự dựng runtime; `pinFor('darwin','arm64')` đã sẵn cho việc đó.
- Mac Intel: chưa có bản ghim (`pinFor` trả `null`, `ffmpeg:install` báo rõ).
- `THIRD-PARTY-NOTICES` (`generate_third_party_notices.js`) mới ghi bản ffmpeg Windows.

---

## 6. Nhật ký kết quả

| Ngày | Máy | ffmpeg | test:all |
|---|---|---|---|
| 2026-10-04 | Mac M1 Pro | Homebrew 8.1 | `main` không biên dịch được; 24 đỏ |
| 2026-10-05 | Mac M1 Pro | Homebrew 8.1 | 101/104 xanh, 3 lỗ hổng |
| 2026-10-05 | Mac M1 Pro | ghim `n8.1.1-crabbycut.2` | 102/104 xanh, 2 lỗ hổng; sau khi đổi ngưỡng (§5): **104/104** |
| | Windows | ghim `n8.1.1-crabbycut.2` | *chưa chạy* |
