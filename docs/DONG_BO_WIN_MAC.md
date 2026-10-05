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
| ffmpeg | **bản ghim** `n8.1.1-crabbycut.2` (`scripts/ffmpeg_pin.js`) | **Homebrew** (chưa ghim) | Lỗ hổng lớn nhất — mục 5 |
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

## 5. Lỗ hổng còn lại: ffmpeg trên Mac chưa ghim

Windows chạy bản ffmpeg CrabbyCut tự dựng (n8.1.1 + bộ lọc CUDA), Mac chạy ffmpeg Homebrew — khác
phiên bản, khác bộ thư viện. Hệ quả đo được trên Mac (Homebrew 8.1): thiếu `zscale`/`libplacebo`
nên lớp phủ HDR không hạ được về SDR; vài phép làm tròn khác bản 8.1.1 một đơn vị. Và Homebrew đã
lên 9.0.2: một lần `brew upgrade` là Mac chạy ffmpeg 9 trong khi Windows vẫn 8.1.1.

Các test đỏ chỉ vì lỗ hổng này được ghi ở `tests/known-platform-gaps.json` (có lý do) để CI vẫn có
ích trong lúc chờ. Muốn hai máy chạy CÙNG một ffmpeg: dựng bản macOS arm64 từ đúng nguồn
`ffmpeg-for-CrabbyCut` (n8.1.1 + các bản vá không phụ thuộc CUDA), phát hành ở cùng Release, thêm
mục darwin vào `scripts/ffmpeg_pin.js`, rồi cho bản Mac tải nó như Windows. Xong thì xoá các mục
tương ứng trong `known-platform-gaps.json` — `npm run test:all` sẽ nhắc nếu quên.
