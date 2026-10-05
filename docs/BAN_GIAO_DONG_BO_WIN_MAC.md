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

1. **Xem CI của PR #2** (job `macos-14` và `windows-2022`). Job Windows là lần đầu các nhánh
   `#ifdef` mới của `core_process.cpp` qua MSVC — đỏ ở bước build thì sửa ở đó trước.
2. **Gộp PR #2** khi CI xanh (cả hai job). Không đẩy thẳng lên `main`; nên bật branch protection
   cho `main` (Settings › Branches, bắt buộc hai job CI).
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
4. Nhánh cũ `mac/export-wip-20261004` (chỉ có trên máy Mac, chưa đẩy) đã bị thay thế bởi cách làm
   của `main` — **không gộp**; xoá khi chắc không cần.

---

## 5. Còn mở — cần quyết định

**Hai ngưỡng test chỉnh trên x86, Mac (ARM) không đạt** — ghi ở `tests/known-platform-gaps.json`,
phân tích ở [DONG_BO_WIN_MAC.md](DONG_BO_WIN_MAC.md) mục 6:

| Test | Mac | Windows | Ngưỡng |
|---|---|---|---|
| `test:export-fast-path` (ProRes, luma mới/cũ) | 44,59 dB | ≥ 45 | ≥ 45 dB |
| `test:retouch-export` (mép miếng vá) | cứng 8 → mềm 2/255 | 4 → 1/255 | mềm ≤ 1/255 |

Không phải do ffmpeg hay encoder: đã đo với bản ghim, ép `prores_ks`, tắt SIMD, và chạy bản x86_64
cùng nguồn dưới Rosetta — bản C và ARM cho 44,59 dB, chỉ SIMD x86 cho 45,52 dB. **Đề xuất:** đổi sang
so tương đối (ProRes so bản chuẩn; miếng vá so tỉ lệ mép mềm/mép cứng — cả hai máy đều giảm 4 lần),
rồi xoá hai mục khỏi danh sách lỗ hổng. Chưa sửa vì đây là ngưỡng người dùng đặt.

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
| 2026-10-05 | Mac M1 Pro | ghim `n8.1.1-crabbycut.2` | **102/104 xanh**, 0 đỏ, 2 lỗ hổng (§5) |
| | Windows | ghim `n8.1.1-crabbycut.2` | *chưa chạy* |
