# CrabbyCut

Ứng dụng dựng video tự động theo kịch bản, cho Windows.

Bạn đưa vào một **kịch bản** và các **video thô** đã quay. CrabbyCut bóc băng lời nói bằng
AI, so khớp từng câu nói với từng câu trong kịch bản, chọn lần đọc tốt nhất trong các lần
quay lặp, rồi dựng sẵn timeline theo đúng thứ tự kịch bản. Từ đó bạn chỉnh tiếp như một
trình dựng phim bình thường: lane phủ, chữ, hiệu ứng chuyển, chỉnh màu, phụ đề, xuất video.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3%20or%20later-blue.svg)](LICENSE)

> **Trạng thái:** đang phát triển. **Bộ cài đóng gói chỉ có cho Windows x64.** Chạy từ mã
> nguồn thì cả Windows lẫn **macOS** đều được — đường macOS bóc băng bằng `mlx_whisper`
> (Apple Silicon) thay cho `faster-whisper`, xem [Chạy từ mã nguồn](#chạy-từ-mã-nguồn).

---

## Mục lục

- [Tính năng](#tính-năng)
- [Cài đặt cho người dùng](#cài-đặt-cho-người-dùng)
- [Vì sao một số thư mục trong repo gần như trống](#vì-sao-một-số-thư-mục-trong-repo-gần-như-trống)
- [Thêm tài nguyên vào thư viện](#thêm-tài-nguyên-vào-thư-viện)
- [Chạy từ mã nguồn](#chạy-từ-mã-nguồn)
- [Đóng gói bộ cài](#đóng-gói-bộ-cài)
- [Kiến trúc](#kiến-trúc)
- [Dữ liệu của bạn nằm ở đâu](#dữ-liệu-của-bạn-nằm-ở-đâu)
- [Kiểm thử](#kiểm-thử)
- [Ủng hộ dự án](#ủng-hộ-dự-án)
- [Giấy phép](#giấy-phép)

---

## Tính năng

| Nhóm | Nội dung |
|---|---|
| **Theo kịch bản** | Bóc băng bằng Whisper, so khớp câu nói ↔ câu kịch bản, tự chọn lần đọc tốt nhất giữa nhiều take, dựng timeline theo thứ tự kịch bản |
| **Dựng phim** | Timeline nhiều lane (hình, chữ, khối, âm thanh), inspector, keyframe, tay cầm kiểu CapCut, xem trước khung chính xác |
| **Magic Fill** | Tự chọn và đặt tài nguyên thư viện (video chèn, icon, mẫu chữ) theo ghi chú trong kịch bản |
| **Auto-Reframe** | Dò người/khuôn mặt bằng MediaPipe, tự cắt khung theo chủ thể khi đổi tỉ lệ |
| **Retouch** | Làm mịn/chỉnh vùng khuôn mặt theo lưới landmark |
| **Màu** | Bộ LUT dựng sẵn, nhập `.cube` riêng, chỉnh HSL theo dải, tự động cân màu |
| **Âm thanh** | Khử ồn, trộn mức, sóng âm thật trên timeline, tự chèn hiệu ứng theo luật |
| **Phụ đề** | Sinh phụ đề tự động theo trục timeline, xuất `.srt` |
| **Xuất** | Ghép bằng FFmpeg, chính xác tới khung, hỗ trợ nguồn HDR (tonemap về SDR) |

---

## Cài đặt cho người dùng

Tải `CrabbyCut Setup <phiên bản>.exe` ở mục
[Releases](https://github.com/tamphamdesigner92-tb/CrabbyCut/releases) rồi chạy.

Bộ cài sẽ:

1. **Kiểm tra cấu hình máy** — GPU NVIDIA, FFmpeg sẵn có, Visual C++ Runtime, dung lượng đĩa.
2. **Dựng môi trường lõi** — Python 3.12 (nhúng sẵn trong bộ cài, không cần tải) và FFmpeg
   (dùng lại bản có sẵn trên máy nếu đủ filter, nếu không thì tải về).

Bước này mất khoảng **15 giây**. Bộ cài **không** tải thư viện AI lúc này.

### Thư viện AI tải ở lần đầu dùng tính năng

Phần dựng phim, cắt ghép, xem trước và xuất video **không dùng Python**, nên bắt bạn chờ
2,5 GB trước khi mở được ứng dụng là bắt bạn trả giá cho thứ có thể không bao giờ dùng tới.
Vì vậy mỗi nhóm thư viện chỉ được tải ở lần **đầu tiên** bạn chạm vào đúng tính năng cần nó:

| Nhóm | Tải khi | Dung lượng |
|---|---|---|
| `asr` | Lần đầu **Bóc băng** | ~350 MB (~770 MB nếu máy có GPU NVIDIA) |
| `script` | Lần đầu **Lọc / Sắp xếp theo kịch bản** | ~450 MB |
| `vision` | Lần đầu **Auto-Reframe / Retouch** | ~400 MB |

Tiến độ tải hiện ngay trong ứng dụng. Mạng đứt giữa chừng thì lượt sau tiếp tục từ chỗ dở,
không tải lại từ đầu.

Model Whisper (1–3 GB) vẫn tải riêng qua nút **Cài model** như trước.

### Yêu cầu máy

| | |
|---|---|
| Hệ điều hành | Windows 10/11 **64-bit** |
| Đĩa trống | ≥ 6 GB cho môi trường, chưa tính model và dự án |
| GPU | Không bắt buộc. Có GPU NVIDIA thì bóc băng nhanh hơn nhiều (CUDA qua CTranslate2) |
| Mạng | Cần cho bước thiết lập và lần đầu dùng mỗi tính năng AI |

Cài đặt ở chế độ **per-user** (`%LOCALAPPDATA%\Programs\CrabbyCut`), không cần quyền quản trị.

---

## Vì sao một số thư mục trong repo gần như trống

Clone repo về bạn sẽ thấy `library/` và `tests/fixtures/` gần như rỗng. **Đó không phải
repo hỏng** — đó là chủ ý.

| Thư mục | Trong repo | Lý do |
|---|---|---|
| `library/{Elements,Music,SFXs,Video}` | Chỉ khung thư mục | Nhạc và hiệu ứng âm thanh mua từ kho stock, mà gần như mọi giấy phép stock **cấm phân phối lại tệp gốc**. Video và icon là tài sản của khách hàng |
| `tests/fixtures/{matching,reorder}` | Không có | Kịch bản marketing và transcript lời nói người thật, thuộc về khách hàng |
| `settings/` | Không có | Cấu hình riêng của từng máy. Giá trị mặc định nằm trong mã |
| `native/*/build/` | Không có | Kết quả biên dịch, mỗi máy tự dựng. Tệp `.pdb` còn nhúng đường dẫn mã nguồn của máy build |

**GPL cấp phép cho *phần mềm*.** Nó không cho dự án quyền phát hành lại nội dung của người
khác, và việc mã nguồn là tự do không làm cho tài nguyên đi kèm trở thành tự do.

Ứng dụng **tự tạo lại các thư mục này nếu thiếu**, nên bản clone mới chạy được ngay — panel
Thư viện chỉ đơn giản là chưa có mục nào. Xem [`library/README.md`](library/README.md) và
[`tests/fixtures/README.md`](tests/fixtures/README.md) để biết cách tự nạp tài nguyên và tự
dựng bộ ca đo.

Ngoại lệ: `library/luts/` **có** trong repo — 22 tệp `.cube` đó do chính
`scripts/generate_preset_luts.js` của dự án sinh ra.

---

## Thêm tài nguyên vào thư viện

Kho tài nguyên (nhạc nền, hiệu ứng âm thanh, video chèn, icon/hình minh hoạ) **không đi kèm
ứng dụng** — lý do ở [mục trên](#vì-sao-một-số-thư-mục-trong-repo-gần-như-trống). Bạn tự
chép tệp của mình vào. Ứng dụng không có nút "nhập tài nguyên": cách duy nhất là chép thẳng
vào thư mục.

### Chép vào đâu

| Bạn đang dùng | Thư mục kho |
|---|---|
| **Bản cài `.exe` trên Windows** | `%LOCALAPPDATA%\CrabbyCut\library` |
| Chạy từ mã nguồn (Windows/macOS) | `library` ngay trong thư mục dự án |
| Bản cài trên macOS | `~/Library/Application Support/CrabbyCut/library` |

Dán thẳng dòng này vào thanh địa chỉ của File Explorer để mở đúng chỗ:

```
%LOCALAPPDATA%\CrabbyCut\library
```

> ⚠ **Đừng chép vào thư mục cài đặt** (`%LOCALAPPDATA%\Programs\CrabbyCut`). Trình gỡ cài
> do `electron-builder` sinh ra, khi chạy ở nhánh **tự cập nhật**, xoá `$INSTDIR` bằng
> `RMDir /r` **không chừa ngoại lệ nào** — tài nguyên bạn để trong đó sẽ mất sạch ở lần cập
> nhật đầu tiên, im lặng. Đây chính là lý do kho nằm ở `%LOCALAPPDATA%\CrabbyCut`.

Thư mục kho có bốn ngăn, ứng dụng **tự tạo lại nếu thiếu**:

```
library\
├─ Video\      video chèn
├─ Elements\   icon, hình minh hoạ, hình khối
├─ Music\      nhạc nền
├─ SFXs\       hiệu ứng âm thanh
└─ luts\       LUT màu .cube (bộ dựng sẵn + bản bạn nhập)
```

Đuôi tệp được nhận (`backend/server.js`):

| Loại | Đuôi |
|---|---|
| Video | `.mp4` `.mov` `.m4v` `.webm` |
| Âm thanh | `.mp3` `.wav` `.m4a` `.aac` |
| Hình ảnh | `.png` `.jpg` `.jpeg` `.webp` `.svg` |
| LUT màu | `.cube` |

Tệp đuôi khác bị **bỏ qua im lặng** — không có thông báo lỗi nào. Thấy tệp không hiện ra
thì kiểm đuôi trước tiên.

> **Đặt tệp ngay trong ngăn, đừng lồng thư mục con.** Hai đường đọc kho không giống nhau:
> panel Thư viện liệt kê **chỉ cấp đầu** của mỗi ngăn (`readdir`, không đệ quy), còn Magic
> Fill quét **đệ quy** cả kho. Nên `library\Video\Khach A\[Vid] ....mp4` vẫn được Magic
> Fill chọn nhưng **không bao giờ hiện trong panel** để bạn kéo tay — một kiểu "mất tích"
> rất khó đoán. Muốn phân loại thì gói thông tin vào **tên tệp**, đừng gói vào thư mục.

### Đặt tên thế nào để Magic Fill tìm được

Chép đúng thư mục là đủ để tài nguyên **hiện trong panel Thư viện** và kéo tay vào timeline.
Nhưng muốn **Magic Fill** tự chọn được thì tên tệp phải có **tiền tố trong ngoặc vuông**:

```
[Vid] Be khoe, be tuoi cuoi - 1.mp4
[Icon] Lactoferrin.png
[Illus] Giam phat trien chieu cao - 1.png
[SFXs] Pop-UI-Sound.MP3
[Mus] Coconut-Groove.MP3
```

| Tiền tố | Magic Fill làm gì |
|---|---|
| `[Vid]` | Video phủ kín khung, đặt ở lane *Magic Fill Video* |
| `[Icon]` / `[Illus]` | Giữ nguyên cỡ gốc, đặt ở nửa khung đối diện mặt người |
| `[SFXs]` / `[Mus]` | Dành cho Auto SFX, không dùng cho Magic Fill hình |

Ba điều dễ sai:

- **Thư mục không ảnh hưởng luật khớp.** Magic Fill quét đệ quy cả `library/` (tối đa 6 cấp,
  bỏ `luts/` và mọi thứ bắt đầu bằng dấu chấm). Xếp thư mục con thế nào cũng được — nhưng
  **tiền tố thì bắt buộc**.
- **Tiền tố viết lạ coi như không có**: `(Icon)`, `Icon -`, `[icons]`, `[Icon 2]` đều **không**
  nhận. Phải là ngoặc vuông ở đầu tên, bên trong đúng một trong năm chữ trên. Hoa/thường,
  dấu tiếng Việt, khoảng trắng thừa thì không sao — `[ICON ]` vẫn nhận.
- **Nhiều bản của cùng một nội dung phải đánh hậu tố `- số`**: `[Vid] Be om, be gay - 1.mp4`
  và `- 2.mp4` được coi là hai bản của cùng một nội dung và luân phiên ngẫu nhiên. Viết
  `[Vid] Be om be gay 2.mp4` thì số `2` bị tính thành một từ khoá rác.

Luật khớp đầy đủ — bao nhiêu chữ phải trùng, chữ được chuẩn hoá ra sao — nằm ở
[`docs/QUY_UOC_DAT_TEN_TAI_NGUYEN.md`](docs/QUY_UOC_DAT_TEN_TAI_NGUYEN.md).

### Chép xong rồi mà chưa thấy

Panel đọc lại thư mục ở **mỗi lần tải danh sách**, không cache, nên thường chỉ cần mở lại
panel là thấy. Chưa thấy thì kiểm theo thứ tự:

1. Đuôi tệp có trong bảng trên không?
2. Tệp có nằm **ngay trong** `Video` / `Elements` / `Music` / `SFXs` không, hay đang lọt vào
   một thư mục con?
3. Tên tệp có bắt đầu bằng dấu chấm không (bị bỏ qua)?
4. Đúng thư mục kho chưa — bản cài `.exe` đọc `%LOCALAPPDATA%\CrabbyCut\library`, **không**
   phải thư mục `library` trong mã nguồn.

### Về bản quyền

Chỉ chép vào repo công khai thứ **bạn tự tạo** hoặc thứ có giấy phép cho phép phân phối lại
(CC0/Public Domain). Tài nguyên trong máy bạn thì tuỳ bạn — nhưng đừng commit nhạc/video
mua từ kho stock lên repo: gần như mọi giấy phép stock cho phép *dùng* trong sản phẩm cuối
nhưng **cấm phân phối lại tệp gốc**. Xem [`library/README.md`](library/README.md).

---

## Chạy từ mã nguồn

### Cần có trước

| | Windows | macOS |
|---|---|---|
| **Node.js** | 20+ | 20+ |
| **Python** | 3.9–3.12 từ [python.org](https://www.python.org/downloads/) | 3.9–3.12 — `brew install python@3.12` |
| **Bóc băng (ASR)** | `faster-whisper` + CUDA | `mlx_whisper` — **chỉ Apple Silicon** |
| **Toolchain C++** | Visual Studio 2022 kèm workload *Desktop development with C++* | Xcode Command Line Tools — `xcode-select --install` |
| **FFmpeg** trên `PATH` | `winget install Gyan.FFmpeg` | `brew install ffmpeg` |

Hai cái bẫy đáng nhớ trước khi cài:

- **Đừng dùng Python 3.13+.** `mediapipe` chưa có wheel cho bản đó, và `requirements.txt`
  ghim `mediapipe` + `opencv-contrib-python` kèm marker `python_version < "3.13"`. Hậu quả
  không phải là một lỗi cài đặt mà là sự im lặng: `pip install` vẫn **báo thành công**, chỉ
  âm thầm bỏ qua hai gói đó, rồi Auto-Reframe chết sau với `No module named 'cv2'`. Cả
  `npm run setup` lẫn `npm run preflight` đều kiểm và chặn trước ca này.
- **FFmpeg cần có `zscale`.** Đường tonemap HDR dựa vào bộ lọc này, mà nó không có trong
  mọi bản build (bản *essentials* của gyan.dev và một số bản Homebrew đều thiếu). Thiếu thì
  chỉ clip HDR bị ảnh hưởng; `npm run setup` sẽ nói rõ bản trên máy bạn có hay không.

Native addon **bắt buộc** dùng MSVC trên Windows vì nó nạp cùng tiến trình với Electron.
C++ sidecar thì dễ tính hơn — nó là một tiến trình độc lập nói chuyện qua stdio nên biên
dịch được bằng MSVC, MinGW-w64 hay clang (đặt `CXX` để chỉ định).

### Các bước

```bash
git clone https://github.com/tamphamdesigner92-tb/CrabbyCut.git
cd CrabbyCut
npm start
```

Đúng một lệnh, giống hệt nhau trên Windows và macOS. `npm start` **tự kiểm và tự cài những
gì còn thiếu**, có sẵn thì bỏ qua và chạy luôn:

| Kiểm | Thiếu thì tự làm gì | Nếu bỏ qua bước này thì hỏng ra sao |
|---|---|---|
| `node_modules` + binary Electron | `npm install` | `Electron failed to install correctly` |
| Native addon, C++ sidecar | `node-gyp rebuild`, biên dịch sidecar | App vẫn mở, chỉ in một dòng `Cannot load native addon` rồi chạy đường dự phòng bằng JS — không ai đọc dòng đó |
| `.venv` + gói Python | dựng venv bằng interpreter hợp lệ, `pip install -r requirements.txt` | Lỗi nổ rất muộn, giữa lúc bấm nút bóc băng: `Missing Python package: …` |
| `ffmpeg` / `ffprobe` trên PATH | *chỉ báo* — không tự cài được | `backend/server.js` spawn `ffmpeg` bằng tên trần, thiếu là mọi đường xuất/preview chết bằng `ENOENT`, một lỗi không hề nhắc tới FFmpeg |

Máy đã đủ thì toàn bộ phép kiểm tốn khoảng **0,15 giây** và in đúng một dòng:

```
[setup] ✓ Môi trường đã đủ — không phải cài gì.
```

Lần đầu trên máy mới thì nó nói rõ đang làm gì và mất bao lâu trước khi bắt đầu. Riêng bước
Python nặng — `requirements.txt` kéo cả `torch` lẫn `openai-whisper`, lần đầu mất 5–20 phút.

Native addon **bắt buộc** dùng MSVC trên Windows vì nó nạp cùng tiến trình với Electron.
C++ sidecar dễ tính hơn — nó là tiến trình độc lập nói chuyện qua stdio nên biên dịch được
bằng MSVC, MinGW-w64 hay clang (đặt `CXX` để chỉ định).

### Khi muốn tự quyết thay vì để nó tự làm

```bash
npm run setup                        # chạy đúng phép kiểm đó nhưng in bảng trạng thái đầy đủ
npm run setup -- --skip-python       # chỉ dựng native, bỏ phần tải nặng
npm run setup -- --python=/đường/dẫn # chỉ định interpreter thay vì để nó tự dò

CRAB_SKIP_SETUP=1 npm start          # bỏ hẳn bước tự cài
CRAB_SKIP_PYTHON=1 npm start         # mở app ngay, chưa đụng tới phần AI
npm run electron:dev                 # chạy thẳng, CHỈ cảnh báo chứ không tự cài (hành vi cũ)
```

Script tự dò interpreter chứ không in một lệnh cứng: hướng dẫn kiểu `python3.12 -m venv .venv`
sẽ chết bằng `command not found` trên máy chỉ có 3.11, hoặc máy cài Python qua pyenv/uv. Nó
hỏi từng ứng viên phiên bản thật, và trên Windows ưu tiên launcher `py -3.12` vì `python`
trỏ vào bản mặc định — mà mặc định hiện nay thường là 3.13/3.14, bản mediapipe không có wheel.

### `npm start` tự kiểm những gì

```
setup_dev --auto → preflight (Python) → preflight:native → prepare:vendor → fix:electron-sign → electron .
```

- **`setup_dev --auto`** là bước tự cài nói ở trên. Nó **không bao giờ chặn**: hỏng bước nào
  thì báo bước đó rồi vẫn mở app.
- **`preflight`** dò lại gói Python và sinh `docs/MOI_TRUONG_PYTHON.md` khi còn thiếu — ghi
  rõ gói nào thuộc tính năng nào, được import ở dòng nào, rồi tự xoá tệp đó khi đã đủ.
- **`preflight:native`** kiểm addon + sidecar, kể cả ca `.cpp` **mới hơn** sản phẩm (sau
  `git pull` binary cũ vẫn nạp được, chỉ là hành vi không khớp mã nguồn đang đọc). Thêm
  `--no-build` để chỉ kiểm.
- **`fix:electron-sign`** ký lại ad-hoc binary Electron trên macOS. Chữ ký gốc hay hỏng sau
  khi npm giải nén, và triệu chứng là GPU/WebGL không chạy chứ không phải một lỗi rõ ràng.

### Bóc băng trên macOS

Trên macOS ứng dụng **luôn** dùng `mlx_whisper`, không có lựa chọn nào khác:
`normalizeAsrEngine()` trong `backend/server.js` bỏ qua giá trị người dùng gửi lên và trả
thẳng `mlx_whisper` cho mọi nền tảng không phải Windows. Model cố định là
`mlx-community/whisper-large-v3-turbo`, chạy qua `asr/mac_mlx_sidecar.py`. Windows đi đường
khác hẳn: `faster-whisper` + CUDA, qua `asr/windows_faster_whisper_sidecar.py`.

MLX chạy trên Metal của **Apple Silicon**; PyPI không có wheel x86_64 nào. Nên trên **Mac
Intel** phần bóc băng hiện chưa có engine — các phần còn lại (dựng phim, Auto-Reframe,
Retouch, xuất video) vẫn chạy.

### Chạy từ mã nguồn khác bản đã cài ở chỗ nào

Bản chạy từ mã nguồn dùng `.venv/` của dự án và giữ mọi thư mục dữ liệu **trong thư mục dự
án**. Nó **không** đụng tới môi trường mà bộ cài dựng ra, và cũng không mở cửa sổ thiết lập.
Điều đó do một biến duy nhất quyết định: `electron/main.js` chỉ đặt `CRAB_USER_DATA_DIR` khi
`app.isPackaged`.

Muốn thử cửa sổ thiết lập từ mã nguồn:

```bash
npx electron . --setup-runtime
```

---

## Đóng gói bộ cài

```bash
npm run dist:win
```

Lệnh này tự kéo tài nguyên nhúng (Python 3.12 embeddable + `get-pip.py`, ~13 MB) vào
`vendor/` trước khi gọi `electron-builder`. `vendor/` không được theo dõi trong git — đó là
nhị phân của bên thứ ba, tải lại được bất cứ lúc nào.

Bộ cài ra khoảng **157 MB**, trong đó ~156 MB là font Google.

Muốn xuất ra ngoài thư mục dự án:

```bash
npm run dist:win -- --config.directories.output=<thư mục>
```

### Cập nhật bản ghi công bên thứ ba

Sau mỗi lần đổi phụ thuộc:

```bash
npm run notices
```

Lệnh này đọc `node_modules` và `.venv` **thật** chứ không đọc lock file, rồi sinh lại
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). Đừng sửa tay tệp đó — một bản ghi công
lỗi thời không báo lỗi, nó chỉ âm thầm trở thành một tuyên bố sai về mặt pháp lý.

---

## Kiến trúc

Bốn runtime chạy cùng lúc:

```
┌─ Electron main ──────────────────────────────────────────────┐
│  electron/main.js — cửa sổ, IPC, đọc/ghi .crab, cửa sổ thiết │
│  lập môi trường                                              │
└───────────────┬──────────────────────────────────────────────┘
                │ spawn (ELECTRON_RUN_AS_NODE)
┌───────────────▼──────────────────────────────────────────────┐
│  backend/server.js — Node/Express, HTTP API                  │
│    ├─ spawn Python sidecar  → ASR, so khớp, Auto-Reframe     │
│    ├─ spawn C++ sidecar     → FFmpeg, export, sóng âm        │
│    └─ require native addon  → core_c.node                    │
└───────────────┬──────────────────────────────────────────────┘
                │ HTTP (127.0.0.1)
┌───────────────▼──────────────────────────────────────────────┐
│  Renderer — index.html + static/js/                          │
│  timeline, preview (PixiJS), inspector, Magic Fill           │
└──────────────────────────────────────────────────────────────┘
```

**Một số module `static/js/` được nạp bởi CẢ trình duyệt lẫn backend** (`main-lane.js`,
`color-adjust.js`, `clip-speed.js`, `audio-denoise.js`, `app-settings.js`). Đó là chủ ý:
khổ hình lane chính phải được tính bởi *đúng một* phép tính ở cả ba phía — file nối do
backend dựng, sprite preview, và filtergraph lúc export. Để mỗi phía tự tính thì lệch một
pixel là bản xuất ra **sai im lặng**. Sửa các module đó phải nhớ chúng chạy ở hai môi trường.

Chi tiết: [`docs/APP_STRUCTURE.md`](docs/APP_STRUCTURE.md) và
[`docs/APP_INTERNALS.md`](docs/APP_INTERNALS.md).
Riêng phần đóng gói và môi trường: [`docs/DONG_GOI_VA_MOI_TRUONG.md`](docs/DONG_GOI_VA_MOI_TRUONG.md).

---

## Dữ liệu của bạn nằm ở đâu

Ở bản đã cài, **không có gì của bạn nằm trong thư mục cài đặt**:

| Thứ | Nơi đặt |
|---|---|
| Ứng dụng | `%LOCALAPPDATA%\Programs\CrabbyCut` |
| Cài đặt, thư viện, báo cáo, cache | `%LOCALAPPDATA%\CrabbyCut` |
| Môi trường Python + FFmpeg | `%LOCALAPPDATA%\CrabbyCut\runtime` |
| Model Whisper | `%LOCALAPPDATA%\AI Video Auto Cutter\asr_models` |
| Dự án gần đây, autosave | Thư mục `userData` của Electron |

Đây là ràng buộc bắt buộc, không phải sở thích: trình gỡ cài do `electron-builder` sinh ra,
ở nhánh cập nhật, chạy `RMDir /r $INSTDIR` **không chừa ngoại lệ nào**. Bất cứ thứ gì của
người dùng để trong thư mục cài đặt sẽ mất sạch ở lần tự cập nhật đầu tiên.

Gỡ cài đặt sẽ **hỏi** trước khi xoá môi trường AI — giữ lại thì lần cài sau không phải tải
lại.

---

## Kiểm thử

73 bài test, chạy bằng Node thuần và Python, không cần framework:

```bash
npm test                    # toàn bộ (chạy build:native trước)
npm run test:matching       # bộ so khớp kịch bản
npm run test:backend        # smoke test backend
npm run test:export         # đường xuất video
```

Các bài cần bộ ca thật **tự bỏ qua** phần đó và vẫn báo đạt, vì bản clone công khai không có
fixtures. Không bài nào ném traceback vì thiếu dữ liệu.

---

## Ủng hộ dự án

CrabbyCut miễn phí và mã nguồn mở. Nếu nó giúp bạn tiết kiệm thời gian dựng video, bạn có
thể mời mình một ly cà phê — quét mã QR hoặc bấm vào ảnh:

<p align="center">
  <a href="https://buymeacoffee.com/tampham.92">
    <img src="docs/images/buy-me-a-coffee.jpg" alt="Buy Me A Coffee — buymeacoffee.com/tampham.92" width="360">
  </a>
</p>

Hoặc dùng nút **Sponsor** ở đầu trang repo trên GitHub.

---

## Giấy phép

Copyright © 2026 Tam Pham — <tampham.designer92@gmail.com>

CrabbyCut là phần mềm tự do: bạn được phép phân phối lại và/hoặc sửa đổi nó theo các điều khoản của
**GNU General Public License** do Free Software Foundation công bố, phiên bản 3 hoặc (tùy bạn
chọn) bất kỳ phiên bản nào mới hơn — xem [`LICENSE`](LICENSE).

Chương trình này được phát hành với hy vọng nó hữu ích, nhưng **không kèm theo bất kỳ bảo đảm
nào**, kể cả bảo đảm ngụ ý về KHẢ NĂNG THƯƠNG MẠI hay SỰ PHÙ HỢP CHO MỘT MỤC ĐÍCH CỤ THỂ.

GPLv2 **không** dùng được cho dự án này: tám gói phụ thuộc mang giấy phép Apache-2.0
(`torch`, `mediapipe`, `opencv-contrib-python`, `huggingface-hub`, `requests`, `tokenizers`,
`jax`, `jaxlib`), mà Apache-2.0 không tương thích ngược với GPLv2 — điều khoản sáng chế của
nó bị GPLv2 §6 coi là "hạn chế thêm". Bản FFmpeg mà bộ cài dùng cũng bật
`--enable-version3`, tức GPLv3.

Có một **ngoại lệ theo GPLv3 §7** cho thư viện CUDA của NVIDIA — xem
[`LICENSE-EXCEPTION.md`](LICENSE-EXCEPTION.md). CrabbyCut không phân phối lại chúng; `pip`
tải về máy người dùng, và chỉ khi phát hiện có GPU NVIDIA.

Ghi công đầy đủ phần mềm bên thứ ba: [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

**Tài nguyên media không thuộc giấy phép này.** Font trong `static/fonts/google/` giữ giấy
phép gốc (OFL-1.1, Apache-2.0, UFL-1.0 — xem
[`static/fonts/google/FONTS_MANIFEST.md`](static/fonts/google/FONTS_MANIFEST.md)). Tài
nguyên bạn tự nạp vào `library/` thuộc giấy phép của chính nó.

### FFmpeg

CrabbyCut **không liên kết** thư viện FFmpeg. Nó chạy `ffmpeg` và `ffprobe` như **tiến
trình riêng** qua dòng lệnh. Bản dựng mà bộ cài tải về khi máy chưa có FFmpeg đủ filter:
[BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (GPL-3.0-or-later), mã nguồn
FFmpeg tại [FFmpeg/FFmpeg](https://github.com/FFmpeg/FFmpeg).
