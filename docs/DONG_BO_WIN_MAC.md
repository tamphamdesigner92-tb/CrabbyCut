# Một mã nguồn cho cả Windows và macOS — quy trình và những bẫy đã gặp

> Lập 2026-10-05, khi gộp lại `main` để chạy trên cả hai máy. Đây là tài liệu QUY TRÌNH: đọc trước
> khi bắt đầu làm việc trên bất kỳ máy nào.

## 1. Nguyên tắc

1. **Chỉ một nhánh sống lâu: `main`.** Không có nhánh "bản Windows" / "bản Mac". Mọi tính năng
   viết một lần, chạy trên cả hai. Trước đây hai máy làm trên hai nhánh rồi chuyển mã tay
   (`TIMELINE_PORT_WIN_TO_MAC.md`) — cách đó đã làm rơi mất việc: 3 commit "Xoá logo" lên `main`
   bằng commit khác (nội dung bị sửa trong lúc chuyển), còn commit thứ 4 ("Xoá vật thể — LaMa")
   nằm lại trên `CrabbyCut_Remove-logo` không ai biết.
2. **Không cherry-pick qua lại giữa các nhánh.** Đưa việc lên `main` bằng merge (hoặc pull
   request), để git còn biết commit nào đã vào rồi.
3. **Mã riêng nền tảng phải có ĐỦ nhánh cho cả hai** (`#ifdef _WIN32 … #else …`, `process.platform`),
   hoặc dò tính năng lúc chạy. Một nhánh `#else` "chưa làm" là một lỗi của nền tảng kia đang chờ lộ.
4. **CI phải xanh trên CẢ macOS lẫn Windows** trước khi gộp (`.github/workflows/ci.yml`). Máy nào
   cũng chỉ thấy được nền tảng của mình — CI là nơi duy nhất thấy cả hai.

## 2. Quy trình mỗi lần làm việc (máy nào cũng vậy)

```bash
git switch main
git pull --rebase origin main        # lấy việc máy kia vừa đẩy lên
git switch -c <tên-việc>             # nhánh ngắn cho một việc
# … sửa …
npm run ffmpeg:install               # ffmpeg bản ghim của nền tảng này (không làm gì nếu đã đúng bản)
npm run build:native                 # build lại sidecar + addon từ nguồn của CHÍNH máy này
npm run test:all                     # toàn bộ test, mỗi test chạy riêng, bảng tổng ở cuối
git push -u origin <tên-việc>        # mở pull request vào main
```

- CI chạy trên pull request; xanh cả hai nền tảng thì gộp vào `main`, rồi máy kia `git pull`.
- Không đẩy thẳng lên `main` khi CI chưa chạy. Nên bật **branch protection** cho `main` trên
  GitHub (Settings › Branches: "Require status checks to pass" với hai job của CI).
- `native/sidecar/build/` và `native/addon/build/` KHÔNG nằm trong git: mỗi máy tự build. Sau mỗi
  lần `git pull` có đụng `native/`, chạy lại `npm run build:native` (build hỏng thì
  `build_sidecar.js` xoá binary cũ, không để test chạy nhầm bản cũ — xem mục 4).

## 3. Môi trường phải giống nhau

| | Windows | macOS | Ghi chú |
|---|---|---|---|
| Node | 22 | 22 | CI dùng 22 |
| ffmpeg | **bản ghim** `n8.1.1-crabbycut.2` win64 | **bản ghim** `n8.1.1-crabbycut.2` macOS arm64 | Cùng nguồn FFmpeg — mục 5 |
| Kết thúc dòng | LF | LF | `.gitattributes` (`* text=auto eol=lf`) |
| Python | runtime nhúng | `.venv` | 3 test Python chỉ chạy trên máy dev |

Khi `.gitattributes` mới về máy Windows từng bật `core.autocrlf=true`, nếu `git status` báo nhiều
tệp "đổi" mà `git diff` trống thì chạy `git add --renormalize .` một lần (không có thay đổi nội dung).

## 4. Những bẫy nền tảng đã gặp khi đưa `main` sang Mac (2026-10-05)

Mỗi bẫy dưới đây làm test ĐỎ trên Mac trong khi XANH trên Windows — không máy nào tự thấy được.

| Bẫy | Hậu quả trên Mac | Sửa |
|---|---|---|
| libc++ dùng `__int128` cho đồng hồ `std::filesystem`, MSVC dùng `long long` | `std::to_string(mtime.count())` mơ hồ — **sidecar không biên dịch được** | ép `long long` |
| `RunIn()` nhánh POSIX bỏ qua thư mục làm việc (std::system ở cwd của sidecar) | mọi lượt xuất có lớp phủ/tiếng trong thư mục tạm chết "No such file" | `posix_spawn` + `cd` |
| macOS giới hạn **4096 luồng mỗi tiến trình** | 131 phụ đề: mỗi `scale` của ffmpeg 8 mở ~10 luồng + 11 luồng giải mã mỗi ảnh → chạm trần, VideoToolbox treo 600 s | `threads=1` cho `scale` nhánh lớp phủ, `-threads 1` cho bộ giải mã ảnh |
| `os.tmpdir()` = `/var/folders/…` là symlink tới `/private/var/…` | cổng an toàn đường dẫn so realpath với gốc chưa realpath → từ chối tệp hợp lệ | `pathIsInsideDir()` realpath cả gốc |
| APFS lưu mtime tới nano giây | `utimes(…088)` thành `…0879998` → lệch 1 ms → trượt cache | đặt mtime ở giữa mili giây |
| VideoToolbox gắn SEI vào mọi khung; ffprobe 8 in side data chung dòng CSV | đếm khung I ra 0 | lấy trường CSV đầu |
| Mức xám định danh khung quay vòng (khung 14 và 71 cách nhau 1 mức) | ffmpeg 8.1 làm tròn khác 8.1.1 một đơn vị → tra nhầm khung | định danh bằng cả bộ RGB |
| Chạy song song (mục 1.8) chỉ có nhánh Windows | Mac luôn chạy nối tiếp | nhánh POSIX trong `RunBatchJobs` |
| `RunQuiet` POSIX bỏ qua giới hạn thời gian | một lệnh dò treo là treo cả lượt xuất | `waitpid` + hạn giờ |
| `h264_videotoolbox -realtime 1` | xuất bị chặn ở ~66 khung/s (trần thật ~194) | `-realtime 0` khi xuất |
| ffmpeg Homebrew (8.1, rồi 9.x) ≠ bản ghim 8.1.1 của Windows | thiếu `zscale`, làm tròn khác — 3 test đỏ | bản ghim cho Mac (mục 5) |
| SIMD x86 làm tròn khác ARM/C | 2 ngưỡng chỉnh trên Windows không đạt trên Mac | còn mở — mục 6 |

## 5. ffmpeg: một bản ghim cho mỗi nền tảng, cùng mã nguồn

Đến 2026-10-05 Windows chạy bản CrabbyCut tự dựng (n8.1.1 + bộ lọc CUDA), Mac chạy ffmpeg Homebrew —
khác phiên bản, khác bộ thư viện. Đo được trên Mac (Homebrew 8.1): thiếu `zscale` nên lớp phủ HDR
không hạ được về SDR, vài phép làm tròn khác 8.1.1 một đơn vị (mép mềm 2/255, ProRes 44,59 dB) —
3 test chỉ đỏ trên Mac. Và một lần `brew upgrade` là Mac sang ffmpeg 9 trong khi Windows vẫn 8.1.1.

Nay mỗi nền tảng có một bản ghim trong `scripts/ffmpeg_pin.js` (`pinFor()`), dựng từ CÙNG nguồn ở
repo `ffmpeg-for-CrabbyCut`: FFmpeg n8.1.1 cùng commit + cùng bản vá, cùng chuỗi `ffmpeg -version`,
thư viện ngoài cùng phiên bản. `build.sh` dựng bản Windows (MSYS2), `build-macos.sh` dựng bản Mac
(Apple Silicon, macOS 11+, chỉ phụ thuộc thư viện hệ thống). Khác nhau chỉ ở phần tăng tốc phần
cứng: CUDA/NVENC trên Windows, VideoToolbox trên Mac; Mac không có `libplacebo` nên tonemap HDR đi
`zscale` — đúng đường của máy Windows không có driver Vulkan.

- `npm run ffmpeg:install` (scripts/install_ffmpeg.js) tải bản ghim của máy, kiểm SHA-256 và chuỗi
  phiên bản, cài vào thư mục runtime (`~/Library/Application Support/CrabbyCut/runtime/ffmpeg/bin`,
  `%LOCALAPPDATA%\CrabbyCut\runtime\ffmpeg\bin`). backend/server.js và scripts/run_tests.js nối thư
  mục đó vào đầu PATH, nên app chạy từ mã nguồn lẫn test đều dùng bản ghim; ffmpeg Homebrew vẫn nằm
  trên máy nhưng không được gọi nữa. CI cài bằng cùng lệnh (`--ci`).
- `npm run test:all` in bản ffmpeg đang dùng ở dòng đầu và cảnh báo nếu không phải bản ghim.
- Đổi bản ghim: dựng cả hai bản từ cùng tag, chạy `npm run test:all` trên cả hai máy, sửa cả hai mục
  của `FFMPEG_PINS`.

Đo trên Mac sau khi chuyển sang bản ghim (2026-10-05): 102/104 test xanh. `test:export-hdr-asset-usage`
xanh lại (có `zscale`). Hai test còn lại KHÔNG đỏ vì ffmpeg — xem mục 6.

## 6. Cùng mã, cùng ffmpeg, vẫn khác: làm tròn SIMD theo kiến trúc CPU

Windows chạy x86_64, Mac chạy arm64. FFmpeg (swscale và một số bộ lọc) có mã SIMD riêng cho từng
kiến trúc, và mã SIMD x86 KHÔNG làm tròn giống bản C; mã ARM thì trùng bản C. Đo trên cùng đồ thị lọc
của `test:export-fast-path` (ProRes, luma mới/cũ), cùng nguồn FFmpeg n8.1.1-crabbycut.2:

| Bản dựng | luma mới/cũ |
|---|---|
| arm64 (Mac), có hoặc không SIMD | 44,59 dB |
| x86_64, tắt SIMD (`-cpuflags 0`) | 44,59 dB |
| x86_64, bật SIMD (SSE4.2, chạy dưới Rosetta) | 45,52 dB |

Ngưỡng 45 dB được chỉnh trên máy Windows, tức là chỉ qua được nhờ cách làm tròn của SIMD x86; bản C
chính xác cũng chỉ 44,59. Tương tự với mép mềm miếng vá của `test:retouch-export`: Mac đo 8 → 2/255
(ép `prores_ks`, tắt SIMD, chạy bản x86 không AVX2 đều như vậy), Windows đo 4 → 1/255, mà ngưỡng
là ≤ 1. Hai test này nằm trong `tests/known-platform-gaps.json` cùng số đo. Muốn gỡ thì sửa NGƯỠNG
cho khỏi phụ thuộc kiến trúc: ProRes so với bản chuẩn thay vì ngưỡng tuyệt đối sát 45 dB; mép miếng
vá so tỉ lệ mép mềm / mép cứng (cả hai máy đều giảm 4 lần) thay vì ≤ 1/255.

Bài học cho test mới: một ngưỡng chỉnh cho vừa khít số đo trên MỘT máy sẽ hỏng ở kiến trúc kia. Hoặc
chừa biên cho sai khác làm tròn (1–2 mức 8-bit, ~1 dB PSNR), hoặc so tương đối (tỉ lệ, so bản chuẩn).
