# Đóng gói CrabbyCut thành bộ cài .exe + tự động cập nhật

## Context

CrabbyCut hiện **chỉ chạy được từ mã nguồn** (`npm start`). Không có bộ cài, không có
phiên bản trong code, không có cơ chế cập nhật. Muốn giao ứng dụng cho người dùng thật thì
phải giải quyết ba việc:

1. **Đóng gói** thành một file `.exe` cài đặt được.
2. **Bộ cài phải tự dựng môi trường** — vì ứng dụng có 4 runtime (Electron, Node/Express,
   Python, C++) và 3 phụ thuộc ngoài mà hiện tại đều là "phải tự cài trên máy dev":
   ffmpeg trên PATH, một môi trường Python 3.12 với faster-whisper/ctranslate2/mediapipe/opencv,
   và hai artifact C++ phải biên dịch bằng MSVC.
3. **Tự nhận biết bản mới** và cho người dùng cập nhật.

Ba trở ngại lớn nhất đã được xác minh trong lần khảo sát này (chi tiết ở mục *Hiện trạng*):
`PROJECT_ROOT` trộn lẫn tài nguyên chỉ-đọc với dữ liệu ghi-được nên sẽ chết trong
`Program Files`; repo nguồn đang **private** nên electron-updater không đọc được release;
và `core_logic.py` import `torch` ở top-level, kéo theo ~4.4 GB không cần thiết trên Windows.

Kết quả mong muốn: một file `CrabbyCut-Setup-1.1.1.exe` (~200–250 MB) mà người dùng
Windows bấm đúp, bộ cài tự kiểm tra máy, tự tải đủ thư viện, cài xong là chạy không lỗi;
và từ đó về sau app tự thông báo + tự cập nhật khi có bản mới.

---

## Quyết định đã chốt

| Hạng mục | Lựa chọn |
|---|---|
| Chiến lược đóng gói | Bộ cài nhỏ (~200–250 MB), **tải thư viện AI trong lúc cài** |
| GPU | Tự dò `nvidia-smi`; chỉ máy có NVIDIA mới tải gói CUDA (527 MB) |
| Cập nhật | **electron-updater** — tự kiểm tra, tải nền, "Khởi động lại để cập nhật" |
| Nơi phát hành | **Repo public riêng** `CrabbyCut-releases` (chỉ chứa file cài + `latest.yml`); repo nguồn vẫn private |
| Model Whisper (1.6 GB) | **Không** tải lúc cài — tải khi dùng lần đầu (đã có `POST /api/asr-models/setup`) |
| Ký số | Chưa có chứng chỉ → build bản không ký + kèm phần giải thích cách lấy chứng chỉ |

---

## Hiện trạng (đã xác minh, không phải phỏng đoán)

*Phần này ghi lại các dữ kiện quyết định thiết kế bên dưới — để lúc thực thi không phải khảo sát lại.*

**Kiến trúc:** `electron/main.js` (649 dòng) spawn backend `backend/server.js` (4899 dòng) qua
`process.execPath` + `ELECTRON_RUN_AS_NODE=1` trên cổng cố định 8000, health-poll `/api/status`
tối đa 30 s, rồi `mainWindow.loadURL('http://127.0.0.1:8000')` (main.js:177). UI là
`index.html` 771 KB do Express phục vụ (server.js:3792) — **không phải `file://`**.
Backend gọi tiếp: addon N-API `native/addon/build/Release/core_c.node` (server.js:167),
sidecar C++ `native/sidecar/build/core_process.exe` (server.js:1303-1305), các sidecar Python
`asr/*.py`, và `ffmpeg`/`ffprobe` **gọi trần từ PATH** (~32 chỗ trong server.js, thêm
`core_process.cpp` qua `std::system` và `core_logic.py`, `asr/auto_reframe_sidecar.py`).

**Trở ngại 1 — `PROJECT_ROOT` trộn đọc/ghi.** `backend/server.js:11`
`const PROJECT_ROOT = path.resolve(__dirname, '..')` dùng cho **cả hai** loại:
- *Chỉ đọc:* `static/` (122 MB, riêng `static/fonts/google` là 119.6 MB / 51 bộ font, backend
  đọc server-side qua `EDITING_FONT_FILES` server.js:78+), `index.html`, `native/`, `asr/`,
  `scripts/`, `core_logic.py`. Backend còn `require()` module dùng chung từ đây:
  `static/js/audio-denoise.js` (:176), `clip-speed.js` (:180), `app-settings.js` (:184),
  `color-adjust.js` (:187), `scripts/python_command.js` (:191).
- *Phải ghi được:* `temp_uploads/` (+ 6 thư mục con), `asr_cache/`, `peaks_cache/`,
  `reports/`, `settings/app_settings.json`, `progress.txt`. `ensureDirs()` (server.js:227-239)
  `mkdirSync` tất cả các thư mục này **cộng thêm** `STATIC_DIR`, `LIBRARY_DIR`, `LUT_DIR`.
- *Vừa đọc vừa ghi (ca khó nhất):* `library/` (58.5 MB) được đọc + `express.static('/library')`
  (:3788) + dùng làm **biên kiểm tra bảo mật đường dẫn** (:681-682 `abs.startsWith(LIBRARY_DIR + path.sep)`,
  :1845, :2697, :4615) — nhưng `library/luts` **bị ghi vào** ở :4362-4366 khi người dùng nhập LUT.

**Trở ngại 2 — repo private.** `tamphamdesigner92-tb/CrabbyCut` trả 404 qua GitHub API
(trong khi `/users/tamphamdesigner92-tb` trả 200, 18 repo public, rate-limit còn 54/60 →
404 là do private, không phải do bị chặn). electron-updater không đọc được asset của repo
private mà không có token; nhúng token vào app là rò rỉ quyền truy cập mã nguồn.

**Trở ngại 3 — `torch` ở top-level.** `core_logic.py:17-18` `import torch` / `import whisper`.
`torch` chỉ dùng ở 3 chỗ (`:153`, `:155`, `:180` — `torch.cuda.is_available()`,
`torch.cuda.get_device_name(0)`), `whisper` đúng 1 chỗ (`:547`, nhánh legacy/macOS).
Nhưng `asr/python_filter_sidecar.py` và `asr/python_reorder_sidecar.py` đều import
`core_logic` → hiện kéo `torch` vào mọi phiên lọc/sắp xếp trên Windows. torch cài trên máy
này chiếm **4.37 GB** (bản CUDA); wheel PyPI là 118 MB. `flask` và `requests` có trong
`requirements.txt` nhưng **không được import ở đâu cả**.

**Chưa có gì để dựa vào:**
- Không có phiên bản app trong code. `package.json:3` = `"0.1.0"`, tên `ai-video-auto-cutter-electron`
  — cả hai đều cũ, và `app.getVersion()` được gọi **0 lần**. `electron/preload.js:60-64`
  chỉ phơi `versions:{node,chrome,electron}` và **không ai đọc**. UI không hiển thị phiên bản ở đâu.
  Phiên bản thật chỉ nằm trong commit message + tên nhánh; **không có git tag nào**.
- Không có code cập nhật (0 hit: autoUpdater / electron-updater / api.github.com / checkForUpdates).
  `electron-updater` **chưa cài** (chỉ có `builder-util-runtime` do electron-builder kéo theo).
- Cấu hình electron-builder (`package.json:63-78`) là stub: chỉ có `appId`, `productName`,
  `fileAssociations` (`.crab`), `"win":{}`. **Không** có `files`/`extraResources`/`asarUnpack`/
  `target`/`nsis`/`icon`/`publish`. Không có file icon nào trong repo (cần `.ico` 256×256).
- Không có `.github/` → không có CI. Không có README. Không có `.bat`/`.sh`/`.ps1` nào.
- Có một thông báo "hãy cập nhật ứng dụng" **không có gì đứng sau** — `index.html:11150`,
  bắn khi `readCrabFile` trả `unsupported_version` (`electron/crab-format.js:37-39`).

**Máy build hiện tại:** Python 3.11/3.12/3.14, Node v24.16.0, ffmpeg ở `C:\ffmpeg\bin`
(bản static: `ffmpeg.exe` 193 MB + `ffprobe.exe` 192.8 MB → **phải dùng bản shared** cho
đóng gói). Chưa có PyInstaller/Inno Setup/NSIS. Python 3.12 đã có `flask/requests/pydub/
rapidfuzz/whisper/torch` nhưng **thiếu** `faster_whisper`, `ctranslate2`, `cv2`, `mediapipe`
→ ngay trên máy dev, nhánh ASR Windows và auto-reframe hiện **không chạy được**.

**Kích thước wheel win_amd64 thật (tra PyPI):** faster-whisper 1.1 MB · ctranslate2 18.3 MB ·
huggingface-hub 0.8 MB · tokenizers ~3 MB · onnxruntime 13.4 MB · av ~21 MB · numpy 11.9 MB ·
rapidfuzz 1.7 MB · pydub 0.03 MB · opencv-contrib-python ~53 MB · mediapipe 19.2 MB ·
protobuf 0.4 MB · **nvidia-cublas-cu12 527.5 MB** · torch 118 MB.
`requirements.txt` ghim `mediapipe==0.10.21` + `opencv-contrib-python<4.12` với
`python_version < "3.13"` → **buộc Python 3.12**.

**Tin tốt đã xác minh (loại bỏ được cả một lớp rủi ro):**
- Addon `native/addon` dùng **Node-API** (`#include <napi.h>` + `node-addon-api`,
  `binding.gyp` khai báo `NAPI_CPP_EXCEPTIONS`) → ABI **ổn định**, nên file `.node` build
  bằng Node 24 nạp được trong Electron 31 (Node 20.15). **Không cần `electron-rebuild`.**
- `POST /api/asr-models/setup` (server.js:3818) + UI gọi nó (index.html:6536-6571) **đã có sẵn**,
  kèm mẫu tiến trình dùng lại được: `startStatusPolling()` → `/api/status` đọc `progress.txt`,
  và `showToast(msg,{type})`.
- Docs (`APP_INTERNALS.md:3918-3920`) chốt ASR và Auto-Reframe là **hai sidecar độc lập** →
  tách gói tải về theo tính năng là hợp với kiến trúc, không phải sáng tạo thêm.
- Python 3.12 có bản nhúng được: embeddable 3.12.10 = 10.6 MB (bản binary cuối của dòng
  3.12), và `python-build-standalone` ~28 MB — chọn bản sau, lý do ở 4b.
- `library/` **chỉ-đọc trừ `library/luts`**: ba chỗ gọi `libraryCategoryDir()` (:4259, :4295,
  :4400) đều là đọc, và mọi thao tác ghi chạm `LIBRARY_DIR` chỉ là **hai `mkdirSync` vô nghĩa**
  trong `ensureDirs()`. → không cần gieo 58.5 MB (xem "Chốt: tách LUT").
- `static/fonts/google` có **276/618 tệp `.ttf` là italic, tổng 58 MB, không được mã nào tham
  chiếu** → cắt miễn phí.
- `tar.exe` có sẵn trong `C:\Windows\System32` từ Win10 1803 → không phải nhúng bộ giải nén.

---

## Kiến trúc đích

Tách một `PROJECT_ROOT` thành **ba** gốc, mỗi gốc một vai trò:

```
%LOCALAPPDATA%\Programs\CrabbyCut\          APP_ROOT — chỉ đọc, electron-updater thay toàn bộ
├─ CrabbyCut.exe, *.dll
└─ resources\
   ├─ app\                                  asar:false -> APP_ROOT = resources\app
   │  ├─ index.html  static\  library\  native\  asr\  backend\  electron\  scripts\
   │  └─ vendor\ffmpeg\bin\                 ffmpeg+ffprobe+DLL (bản SHARED gpl)
   ├─ vendor\python\…tar.gz                 CPython 3.12 relocatable (giải nén lúc thiết lập)
   └─ vcredist\VC_redist.x64.exe            chỉ chạy khi máy thiếu

%LOCALAPPDATA%\CrabbyCut\                   NGOÀI app dir — cập nhật app KHÔNG đụng tới
├─ runtime\python\Lib\site-packages\        các gói AI tải lúc cài (~1.2 GB)
│  └─ runtime.json                          phiên bản python + từng pack + GPU đã dò
├─ data\                                    DATA_ROOT — dữ liệu người dùng, GHI ĐƯỢC
│  ├─ temp_uploads\  asr_cache\  peaks_cache\  reports\  settings\  progress.txt
│  └─ luts\                                 .cube người dùng nhập (xem "Chốt: tách LUT")
└─ asr_models\                              model Whisper 1.6 GB (tải khi dùng lần đầu)

%APPDATA%\CrabbyCut\  (Roaming)             chỉ giữ thứ ĐÁNG roaming
└─ autosave\  recent-projects.json          (đã dùng app.getPath('userData') sẵn)
```

⚠️ **`DATA_ROOT` phải là `%LOCALAPPDATA%`, KHÔNG dùng `app.getPath('userData')`.** Trên
Windows `userData` = `%APPDATA%` = **Roaming**. Nhét `temp_uploads` (hàng chục GB video
nguồn của dự án) vào roaming profile là làm hỏng máy domain/roaming-profile và bắt mọi lần
đăng nhập phải đồng bộ. Dùng đúng khuôn đã có trong repo: `process.env.LOCALAPPDATA ||
path.join(os.homedir(),'AppData','Local')` (server.js:335, windows_faster_whisper_sidecar.py:186).
`userData` chỉ giữ thứ nhỏ và đáng roaming: autosave + `recent-projects.json`.

### Chốt: `asar: false`

Không dùng asar, và đây là lý do cụ thể (không phải sở thích). Ứng dụng giao **rất nhiều
đường dẫn tệp cho tiến trình ngoài** — ffmpeg, `python.exe`, `core_process.exe` — mà các
tiến trình đó **không hiểu asar** (chỉ Node/Electron mới hiểu, vì `fs` được vá):

| Tệp | Ai đọc | Bằng chứng |
|---|---|---|
| `static/fonts/google/*.ttf` (119.6 MB) | **ffmpeg** | server.js:3275 dựng `fontPath` → core_process.cpp:1700 `fontfile='…'` trong filter `drawtext` |
| `library/luts/*.cube` | **ffmpeg** | filter `lut3d` (server.js:2895-2904, :4362-4366) |
| `library/` media (Music/SFXs/Video) | **ffmpeg** | nguồn khi export |
| `native/addon/build/Release/core_c.node` | Node `require` | `.node` **không nạp được** từ asar (native/addon/index.js) |
| `native/sidecar/build/core_process.exe` | `spawn` | server.js:1303-1305 |
| `asr/*.py`, `core_logic.py` | **python.exe** | server.js:340, :1960-2008 |

Nghĩa là gần như mọi thứ nặng đều phải `asarUnpack`. Còn lại trong asar chỉ là ~3 MB mã
JS. Một glob `asarUnpack` bỏ sót sẽ gây lỗi **âm thầm và rất khó truy** (ví dụ: export chỉ
hỏng khi người dùng chọn đúng một bộ font nào đó). Asar cũng **không** bảo vệ mã nguồn —
giải nén bằng một lệnh. Vậy nên `asar: false` đổi lấy: mọi đường dẫn hoạt động y như lúc
chạy từ mã nguồn, không có lớp trừu tượng nào để hỏng.
*(Phương án thay thế nếu sau này cần: `asar: true` + `asarUnpack` cho toàn bộ hàng trong
bảng trên.)*

Ba nguyên tắc chi phối toàn bộ kế hoạch:
1. **App dir chỉ đọc** → mọi thứ ghi được phải rời khỏi nó, nếu không sẽ chết trong `Program Files`.
2. **Môi trường Python + model nằm ngoài app dir** → bản cập nhật 250 MB không kéo lại 2.8 GB.
3. **Chỉ đọc và ghi-được không được trộn trong cùng một biến** → đó chính là lỗi gốc của
   `PROJECT_ROOT` hiện tại.

---

## Giai đoạn 1 — Tách `PROJECT_ROOT` (việc nền tảng, phải làm trước)

Đây là phần **nhiều rủi ro nhất** và là điều kiện tiên quyết cho mọi thứ còn lại. Làm xong
giai đoạn này thì app vẫn chạy y nguyên từ mã nguồn (mặc định `DATA_ROOT = PROJECT_ROOT`),
nên có thể kiểm chứng bằng `npm test` trước khi đóng gói.

**Tệp mới `backend/paths.js`** — nguồn sự thật duy nhất cho hai gốc + phép dò ffmpeg:
```js
const APP_ROOT = path.resolve(__dirname, '..');
function resolveDataRoot() {
  if (process.env.CRABBYCUT_DATA_DIR) return path.resolve(process.env.CRABBYCUT_DATA_DIR);
  if (process.env.CRABBYCUT_PACKAGED === '1')                    // main.js chỉ đặt khi app.isPackaged
    return path.join(localAppData(), 'CrabbyCut', 'data');
  return APP_ROOT;                                               // chạy từ repo: Y NGUYÊN như cũ
}
```
Trong `backend/server.js` giữ `const PROJECT_ROOT = APP_ROOT;` làm **bí danh** — 12 chỗ dùng
nó đều là tài sản chỉ-đọc (`native/`, `asr/`, `scripts/`, `index.html`) nên **không phải sửa
chỗ nào**. Sau đó đúng **bảy** phép gán đổi gốc sang `DATA_ROOT`:

| Dòng | Hằng | Gốc mới |
|---|---|---|
| 17 | `TEMP_DIR` (nhánh không có `CRAB_TEMP_DIR`) | `DATA_ROOT/temp_uploads` |
| 22 | `ASR_CACHE_DIR` | `DATA_ROOT/asr_cache` |
| 26 | `REPORTS_DIR` | `DATA_ROOT/reports` |
| 30 | `LUT_DIR` | `DATA_ROOT/luts` ← xem "Chốt: tách LUT" |
| 44 | `PEAKS_CACHE_DIR` | `DATA_ROOT/peaks_cache` |
| 52 | `SETTINGS_DIR` | `DATA_ROOT/settings` |
| 54 | `PROGRESS_FILE` | `DATA_ROOT/progress.txt` |

`STATIC_DIR` (:24) và `LIBRARY_DIR` (:27) **ở lại `APP_ROOT`**, cùng các `require()` ở
:176/:180/:184/:187/:191, `native/addon` (:167), `core_process.exe` (:1303-1305),
`windowsAsrSidecarPath()` (:340), `index.html` (:3792).

**`cwd` của mọi tiến trình con → `DATA_ROOT`** (:1325 `runSidecar`, :1374 `runProcess`,
:1963 `runPythonSidecar`, :2008 `runPythonJson`). Đây là thứ bắt được các phép ghi
**tương đối theo cwd** trong `core_logic.py`: `open("progress.txt","w")` (:169),
`TEMP_AUDIO = "temp_clean_audio.wav"` (:24), `concat_list.txt` (:187). Lợi thêm: `progress.txt`
tương đối nay trỏ đúng vào tệp mà `PROGRESS_FILE` đang trỏ — điều nó vẫn luôn có ý định làm.

### Chốt: tách `LUT_DIR` ra, giữ `library/` chỉ-đọc (KHÔNG gieo, KHÔNG overlay)

Đã kiểm chứng: **`library/` hoàn toàn chỉ-đọc trừ `library/luts`.** Ba chỗ gọi
`libraryCategoryDir()` (:4259, :4295, :4400) đều là đọc; **không endpoint nào ghi vào
`library/<Category>/`** (media người dùng nhập đi vào `temp_uploads/editing_assets`). Toàn bộ
thao tác ghi chạm `LIBRARY_DIR` chỉ là **hai `mkdirSync` vô nghĩa** trong `ensureDirs()`
(:234, :239). Chỗ ghi thật duy nhất là `LUT_DIR` (:4366, người dùng nhập `.cube`).

Vậy nên: **`LUT_DIR` → `DATA_ROOT/luts`, còn `LIBRARY_DIR` ở lại `APP_ROOT` và thành
thật-sự-chỉ-đọc.** Thêm một hằng cạnh dòng 30:
```js
const BUILTIN_LUT_DIR = path.join(LIBRARY_DIR, 'luts');   // bộ dựng sẵn, chỉ đọc
```
Kèm 5 sửa đổi nhỏ: ba mount tĩnh ở :3788 (`/library/luts` → `LUT_DIR` trước,
`BUILTIN_LUT_DIR` sau, rồi `/library` → `LIBRARY_DIR`), `listColorLuts()` đọc `presets.json`
+ preset từ `BUILTIN_LUT_DIR` (:2895, :2899) còn `readdirSync` giữ ở `LUT_DIR` (:2904), bộ
đặt tên duy nhất khi import (:4362) phải kiểm **cả hai** thư mục (nếu không, import tên
`blush` sẽ che mất preset cùng tên), và `walkLibraryAssets` :697 đổi sang `BUILTIN_LUT_DIR`.
Một tiền tố URL `/library/luts/` duy nhất → **frontend và mọi tệp `.crab` cũ không biết có
gì đổi**.

*Vì sao bỏ phương án gieo 58.5 MB (ý ban đầu của tôi):* gieo thì đúng nhưng phải trả 58.5 MB
trùng lặp vĩnh viễn, 2–4 s ở lần chạy đầu, **và** khoảng 60 dòng logic hợp nhất 3 chiều khi
cập nhật (ghi đè tài sản dựng sẵn / giữ tệp người dùng đã sửa / không xoá tệp lạ) — mã mới,
sát bảo mật, cho một vấn đề mà phép tách LUT làm nó **biến mất**.
*Vì sao bỏ phương án overlay hai gốc:* `LIBRARY_DIR` là **biên bảo mật đường dẫn viết theo 4
cách khác nhau** (:681-682, :1845, :2695-2697, :4615). Đổi 4 vị từ `startsWith` một-gốc
thành "khớp bất kỳ gốc nào" chính là chỗ một cái sẽ ra khác đi và thành lỗ đọc tệp tuỳ ý —
`/api/retouch/track` (:4615) đưa thẳng kết quả cho sidecar mở tệp. Thêm nữa
`resolveRetouchSource` (:2686) gọi `fs.realpathSync` **trước**, nên một junction trong gốc
này trỏ sang gốc kia sẽ realpath **ra ngoài** gốc vừa được kiểm.

Kết quả: 4 vị từ bảo mật **giữ nguyên từng chữ** và vẫn chứng minh được là một-gốc; không
trùng lặp; không logic hợp nhất; URL không đổi.

Kèm theo, dọn `ensureDirs()`: **xoá** `mkdirSync(STATIC_DIR)` (:232), `mkdirSync(LIBRARY_DIR)`
(:234) và vòng lặp `LIBRARY_CATEGORIES` (:239) — cả ba nay nằm trong vùng chỉ-đọc; và
**thêm** `mkdirSync(SETTINGS_DIR)` (hiện đang thiếu, chỉ `writeAppSettings` mới tạo).

**Các sidecar Python** — dùng lại đúng tên biến repo đã có cho việc này là `CRAB_TEMP_DIR`
(server.js:14), không đặt tên mới:
- `asr/windows_faster_whisper_sidecar.py:17-18` — `TEMP_DIR = PROJECT_ROOT/"temp_uploads"`
  và **ghi vào đó** ở :438-439 (`windows_asr_input.wav`). Đây là **lỗi chặn cứng**: bản cài
  đặt sẽ hỏng **mọi** lượt bóc băng. Suy từ `__file__` nên đổi `cwd` không cứu được.
  ```python
  TEMP_DIR = Path(os.environ.get("CRAB_TEMP_DIR") or (PROJECT_ROOT / "temp_uploads"))
  ```
- `asr/python_filter_sidecar.py:48` — đường dẫn dự phòng `session_file`, cùng một mẫu.
- `asr/windows_faster_whisper_sidecar.py:181-188` `default_model_root()` — soi gương với
  `windowsAsrModelRoot()` (xem dưới), để một lần chạy tay bằng CLI không tải lại 1.6 GB.

`runPythonSidecar` truyền xuống: `env: pythonEnv({ CRAB_TEMP_DIR: TEMP_DIR })` —
`pythonEnv(extra)` đã nhận tham số phụ sẵn (`python_command.js:48`), **không đổi chữ ký**.
`from core_logic import …` **không cần sửa**: các sidecar tự `sys.path.insert(0, PROJECT_ROOT)`
(`python_filter_sidecar.py:7-9`, `python_reorder_sidecar.py:16-18`, `mac_mlx_sidecar.py:8-10`)
và `core_logic.py` vẫn nằm cạnh chúng trong `APP_ROOT`.
`asr/auto_reframe_sidecar.py` **không cần sửa** — `cwd=str(PROJECT_ROOT)` ở :145/:332/:699/
:755/:1032 là vô hại (mọi đường dẫn ffmpeg đều tuyệt đối) và nó chỉ ghi vào đường do bên gọi đưa.

**ffmpeg: sửa MỘT chỗ, tới được cả bốn runtime.** `runProcess` (:1374) và `runSidecar` (:1325)
đều spawn với `{...process.env}`, `runPythonSidecar` (:1963) dùng `pythonEnv()` cũng trải
`process.env`. Nên chỉ cần **prepend `vendor/ffmpeg/bin` vào `process.env.PATH`** một lần lúc
backend khởi động (`prependVendorPath()` trong `paths.js`) là tới được cả `spawn('ffmpeg')`,
`std::system("ffmpeg …")` trong `core_process.cpp`, lẫn `subprocess` trong `core_logic.py` và
`auto_reframe_sidecar.py`. **Không phải sửa ~32 chỗ gọi, không đụng C++, không đụng Python.**
Máy dev không có `vendor/` thì hàm trả `null` và dùng ffmpeg trên PATH như cũ.

**`windowsAsrModelRoot()` (:330-338)** — đổi tên sản phẩm nhưng **tìm chứ không dời**:
`%LOCALAPPDATA%\CrabbyCut\asr_models` là đích mới, nhưng nếu đích mới chưa có mà
`%LOCALAPPDATA%\AI Video Auto Cutter\asr_models` (tên cũ) đã có thì **dùng lại** — không ai
phải tải lại 1.6 GB. Dời 1.6 GB có thể hỏng giữa chừng và để lại hai nửa.

**Gieo duy nhất còn lại:** `settings/app_settings.json` (5 KB, copy-nếu-thiếu). Về lý thuyết
không bắt buộc — `readAppSettings()` (:154-160) đã rơi về `AppSettings.defaults()` — nhưng
tệp đi kèm có các nhóm `autoSfx` đã được soạn sẵn nên nên chép.

---

## Giai đoạn 2 — Bỏ `torch` khỏi đường Windows

Đổi 2 dòng import thành lazy, tiết kiệm **~1.2 GB** trong gói tải về (wheel 118 MB, giải
nén ~450 MB; bản CUDA trên máy này là 4.37 GB). Đây là thay đổi nhỏ nhưng lợi nhất trong
cả kế hoạch.

**`core_logic.py`** — bỏ `import torch` và `import whisper` ở dòng 17-18, chuyển vào trong
hàm tại đúng 4 chỗ dùng:
- `:153`, `:155`, `:180` — `torch.cuda.is_available()` / `torch.cuda.get_device_name(0)`.
  Thay bằng phép dò `nvidia-smi` (backend **đã có sẵn** `collectNvidiaGpuInfo()` /
  `collectGpuInfo()`, và `asr/windows_faster_whisper_sidecar.py` có `probe_nvidia()` — dùng
  lại một trong hai thay vì viết mới). Nếu muốn giữ nguyên hành vi tuyệt đối trên máy có
  torch thì bọc `try: import torch … except ImportError:` rồi rơi về `nvidia-smi`.
- `:547` — `whisper.load_model("large", device=device)`: `import whisper` ngay trong nhánh đó.
  Đây là nhánh legacy/macOS, Windows đi qua `faster_whisper` nên không bao giờ chạm tới.

Vì sao đáng làm: `asr/python_filter_sidecar.py` và `asr/python_reorder_sidecar.py` chỉ cần
`deterministic_filter_pipeline` / `align_blocks_to_script` (tức chỉ cần `rapidfuzz` + `pydub`),
nhưng vì import cả module nên hiện **kéo torch vào mọi phiên lọc/sắp xếp trên Windows**.

**`requirements.txt`** — bỏ `flask` và `requests` (không được import ở đâu cả), và đánh dấu
`openai-whisper` + `torch` thành `platform_system == "Darwin"` cho khớp thực tế.

⚠️ `core_logic.py` **dùng chung với nhánh Mac** (`docs/TIMELINE_PORT_WIN_TO_MAC.md` §4 liệt
kê nó là tệp có phần AI Hub chỉ tồn tại trên nhánh Mac). Lazy import không đổi hành vi trên
macOS, nhưng khi merge phải cẩn thận vùng dòng 17-18 và 534-568.

---

## Giai đoạn 3 — Cổng động thay cho 8000 cố định

Hai bản cài trên cùng máy, hoặc bất kỳ app nào đang giữ cổng 8000, sẽ làm CrabbyCut
**nạp giao diện của tiến trình lạ** — vì `ensureBackendReady()` (main.js:98-104) thấy
cổng 8000 có người trả lời là coi như backend của mình (`isExternalBackend = true`) rồi
`loadURL` vào đó luôn.

**Tin tốt:** frontend dùng đường dẫn **tương đối** — `API_BASE = "/api"` (index.html:4116,
static/js/app-settings.js:395, settings-panel.js:16) → **không cần sửa một dòng frontend nào**.
Chuỗi `8000` chỉ cứng ở `electron/main.js:20` và `.claude/launch.json`.

**Cách làm: backend bind cổng 0, rồi IN cổng thật ra stdout.** Tốt hơn "main tự dò cổng
trống rồi giao xuống" vì không có khe hở TOCTOU nào (giữa lúc dò và lúc bind, ai cũng có thể
chiếm cổng đó).
- `backend/server.js` `start()` (:4822-4833): `PORT = process.env.BACKEND_PORT === '0' ? 0 : …`,
  rồi sau `listen` in `CRABBYCUT_BACKEND_READY {"port":<thật>,"pid":…}`.
- `electron/main.js` **dò dòng đó ngay trong ống stdout đã có sẵn** (:89-91) — không cần
  kênh IPC mới. `BACKEND_ORIGIN` thành hàm, `loadURL(backendOrigin())` (:177).
- **Chữ ký nhận dạng** trên `/api/status` (:3800): thêm `app:'crabbycut'`, `pid`, `version`.
  `checkBackendHealth()` (:46-67) phải **đọc body** và chỉ nhận khi `app === 'crabbycut'`.
  Đây là thứ chặn một tiến trình lạ trả 200 (một app Express khác, hay một captive-portal /
  proxy công ty trả 200 cho mọi thứ — chuyện này xảy ra thật) bị nhận làm backend của mình.
- Cửa hậu dev: `BACKEND_PORT=8000` hoặc `CRABBYCUT_DEV=1` → giữ nguyên lối cũ (dò cổng đó,
  thấy backend đang chạy thì dùng luôn và không tắt lúc thoát). Ngoài dev thì
  `isExternalBackend` **luôn** `false` → luôn tự tắt backend lúc thoát.

### Kèm theo: sửa lỗi bỏ sót tiến trình con trên Windows

Phát hiện trong lúc khảo sát, là **lỗi có sẵn** nhưng đóng gói sẽ biến nó thành cơn đau hỗ trợ:
`stopBackendSidecar()` (:123-141) gọi `proc.kill('SIGTERM')`, mà **Windows không có SIGTERM
thật** — nó quy về `TerminateProcess`. Hàm `shutdown()` của backend (:4853) chỉ được nối vào
SIGINT/SIGTERM (:4871-4876) nên **không bao giờ chạy**, kéo theo `killActiveChildren()` cũng
không chạy → `ffmpeg.exe` / `python.exe` / `core_process.exe` thành **tiến trình mồ côi**.
Người dùng đóng app mà một lượt export 4 GB vẫn đang ngốn CPU, không còn cửa sổ nào để tắt.

Sửa: thêm `POST /api/shutdown` (localhost-only, gọi `shutdown('SIGTERM')` có sẵn) → main gọi
nó trước, chờ tối đa 4 s, rồi mới `taskkill /pid <pid> /T /F`. Phải `/T` (cả cây) vì
`core_process.cpp` gọi ffmpeg qua `std::system` → có một `cmd.exe` trung gian mà
`proc.kill()` không với tới. Việc này cũng là **điều kiện cần cho cập nhật** (xem Giai đoạn 7).

---

## Giai đoạn 4 — Nhúng phụ thuộc + dựng các "pack" Python

### 4a. ffmpeg (nhúng vào bộ cài)

Dùng **`ffmpeg-master-latest-win64-gpl-shared.zip` = 73.4 MB** (tra GitHub BtbN/FFmpeg-Builds).
Bản *shared* thay vì *static* vì static là 162.8 MB, và trên máy này `ffmpeg.exe` +
`ffprobe.exe` bản static chiếm 386 MB đĩa.

Phải là bản **gpl**, không phải lgpl — ứng dụng dùng cứng `libx264` và `libx265`, hai encoder
chỉ có trong build GPL: `native/sidecar/core_process.cpp:664-666` (`libx265` cho hevc,
`libx264` mặc định), `backend/server.js:1609`, `core_logic.py:182/3176/3231`. Bản lgpl-shared
(64.6 MB) **sẽ làm chết hẳn** export HEVC và export H.264 bằng CPU.

⚠️ **Giấy phép — cần bạn quyết định, tôi không thay bạn quyết được.** Kèm binary GPL vào
cùng một bộ cài với một app đóng mã là rủi ro pháp lý thật. Hai đường:
- **(a) Giữ bản GPL** và coi ffmpeg là chương trình riêng, không sửa đổi, chỉ gọi qua
  `CreateProcess`/stdio; kèm license text + lời đề nghị cung cấp mã nguồn. Đây là thông lệ
  phổ biến của ngành nhưng **vẫn bị tranh luận về pháp lý** — nếu phát hành thương mại thì
  nên hỏi luật sư, đừng lấy ý kiến của tôi làm căn cứ.
- **(b) Chuyển sang bản LGPL** và thay đường CPU: ưu tiên `h264_nvenc`/`h264_qsv`/`h264_amf`
  (**đã có sẵn** ở `core_process.cpp:696-701`) rồi rơi về `libopenh264` thay vì `libx264` —
  sửa `core_process.cpp:666` và `:1901`. Phải xác nhận bản LGPL chọn dùng có đủ
  `libopenh264`, `drawtext` (freetype), `lut3d`, `afftdn`, `anlmdn`, `dynaudnorm`, `loudnorm`
  — mà `scripts/prepare_dist.js` đã kiểm đúng danh sách đó nên phép kiểm là miễn phí. Chất
  lượng đường CPU giảm phần nào.

Nếu ứng dụng này bán/phát hành thương mại, tôi nghiêng về **(b)**; chọn **(a)** chỉ khi đã có
xác nhận pháp lý.

**Thay lời gọi trần bằng đường dẫn tường minh.** ffmpeg/ffprobe đang được gọi bằng tên trần
ở ~32 chỗ trong `backend/server.js`, trong `core_process.cpp` (qua `std::system`), trong
`core_logic.py` và `asr/auto_reframe_sidecar.py`. Cách sửa gọn nhất, ít chạm nhất:
đặt `env.FFMPEG_DIR` (APP_ROOT/ffmpeg) rồi **prepend vào `PATH`** của mọi tiến trình con —
làm một lần ở `electron/main.js` (chỗ dựng env cho backend, :73-82) và ở
`scripts/python_command.js` `pythonEnv()`. Như vậy `spawn('ffmpeg', …)`, `std::system("ffmpeg …")`
và `subprocess` trong Python đều tự tìm đúng bản nhúng, **không phải sửa 32 chỗ gọi**.
Vẫn thêm một biến `CRABBYCUT_FFMPEG` để chẩn đoán và cho phép trỏ sang bản khác.

### 4b. Python runtime (nhúng vào bộ cài, ~28 MB)

Buộc **Python 3.12** vì `requirements.txt` ghim `mediapipe==0.10.21` +
`opencv-contrib-python<4.12` với `python_version < "3.13"` (mediapipe không có wheel cho
3.13+; docs `APP_INTERNALS.md:3917` cũng đã chốt). Đây là **ràng buộc**, không phải sở thích.

Dùng **`python-build-standalone`** (`cpython-3.12.x-x86_64-pc-windows-msvc-install_only.tar.gz`,
~28 MB nén) **thay vì bản embeddable** (10.6 MB). Đắt hơn 17 MB nhưng đổi lấy ba thứ đáng:
- **Có sẵn pip + venv** → giữ được đường thoát khẩn cấp `--from-pypi` (xem 4c).
- **Stdlib là tệp thật, không phải zip.** Quan trọng cụ thể: `sysconfig.get_paths()['purelib']`
  chính là đường dự phòng mà `_ensure_cuda_dll_path()` dùng để tìm `site-packages/nvidia`
  (`windows_faster_whisper_sidecar.py:60-68`); và **MediaPipe legacy Solutions** nạp
  `.tflite`/`binarypb` theo `__file__` từ trong cây gói (`auto_reframe_sidecar.py:271-282`),
  `cv2.data.haarcascades` (:288) cũng vậy.
- **Không phải mổ `._pth`.** Bản embeddable bắt buộc phải sửa `python312._pth` (thêm
  `Lib\site-packages` **và** bỏ comment `import site`, thiếu một trong hai là `site-packages`
  không bao giờ vào `sys.path`) — một tệp không tài liệu, dễ sai, khó truy.

Archive nằm **trong bộ cài** (`vendor/python/`), giải nén sang `%LOCALAPPDATA%\CrabbyCut\
runtime\python` lúc thiết lập → **interpreter luôn có, không cần mạng**. Nghĩa là mạng hỏng
cũng không bao giờ để người dùng không có Python nào cả.

`scripts/python_command.js` `pythonCommand()` (:36-44) thêm ứng viên theo thứ tự: (1)
`process.env.CRABBYCUT_PYTHON` nếu tồn tại, (2) `.venv` trong repo **giữ trước mọi phép dò
khác** để `npm test` và máy dev chạy y hệt hôm nay, (3)
`%LOCALAPPDATA%\CrabbyCut\runtime\python\python.exe` cho trường hợp gọi tay, (4) `python`
hệ thống như cũ.

### 4c. Các pack Python (tải lúc cài)

**Cách làm: dựng sẵn từng "pack" là một ZIP site-packages đã giải quyết xong phụ thuộc**,
đẩy lên release, bộ cài chỉ tải + giải nén. Không chạy `pip install` trên máy người dùng.

Vì sao không pip: pip cần mạng tới PyPI ổn định, tự giải phụ thuộc (kết quả có thể **khác
nhau giữa các máy và theo thời gian** — chính `requirements.txt` đã ghi lại hai lần bị
resolver làm chết ứng dụng: `mlx-whisper` không có bản Windows làm dừng cả file, và
`whisperx` ghim `ctranslate2<4.5.0` kéo theo `pkg_resources` chết trên Windows). Pack dựng
sẵn thì **byte-for-byte giống nhau trên mọi máy** và đã được kiểm thử.

Chia 4 pack theo tính năng (docs `APP_INTERNALS.md:3918-3920` xác nhận ASR và Auto-Reframe
là hai sidecar độc lập, nên chia thế này khớp kiến trúc):

| Pack | Nội dung | Tải về | Bắt buộc? |
|---|---|---|---|
| `core` | rapidfuzz 1.7, pydub 0.03, numpy 11.9 | ~15 MB | Có — lọc/sắp xếp theo kịch bản |
| `asr` | faster-whisper 1.1, ctranslate2 18.3, huggingface-hub 0.8, tokenizers ~3, onnxruntime 13.4 (Silero VAD), av ~21 | ~75 MB | Có (mặc định) |
| `vision` | opencv-contrib-python ~53, mediapipe 19.2, protobuf 0.4 | ~85 MB | Có (mặc định) — Auto-Reframe, Retouch |
| `cuda` | nvidia-cublas-cu12 | **527 MB** | **Chỉ khi dò thấy NVIDIA** |

Tổng tải về: **~175 MB** (máy không NVIDIA) hoặc **~700 MB** (có NVIDIA).
Giải nén ra đĩa: ~600 MB / ~2 GB.

Layout đích, **ngoài** app dir để cập nhật app không xoá:
```
%LOCALAPPDATA%\CrabbyCut\runtime\python\Lib\site-packages\
%LOCALAPPDATA%\CrabbyCut\runtime\python\…                 interpreter đã giải nén
%LOCALAPPDATA%\CrabbyCut\runtime\runtime.json             {python, packs:{id:{version,sha256}}, gpu}
%LOCALAPPDATA%\CrabbyCut\runtime\downloads\               *.part đang tải (resume được)
```
`runtime.json` được ghi **atomically** (`.tmp` → `rename`, cùng kỷ luật với `writeAppSettings`
server.js:167-174) và **chỉ sau khi** một pack đã tải xong + kiểm hash + giải nén xong — nên
trạng thái không bao giờ nửa đúng. Riêng cuBLAS **không cần** thêm gì:
`asr/windows_faster_whisper_sidecar.py:22-77` `_ensure_cuda_dll_path()` đã tự prepend
`site-packages/nvidia/*/bin` vào `PATH` trước khi `import ctranslate2` (comment ghi rõ
`os.add_dll_directory()` **không** hiệu quả, và đo được 1.6 s GPU vs 25.0 s CPU) — chỉ cần
site-packages nằm đúng chỗ là nó chạy.

**Script dựng pack** (mới, `scripts/build_python_packs.js`, chạy trên máy dev):
`pip install --target <dir> --only-binary=:all: --python-version 3.12 --platform win_amd64 …`
cho từng nhóm → zip → in ra SHA-256. Cờ `--only-binary` là chốt chặn: không có wheel thì
**hỏng lúc dựng gói** chứ không hỏng trên máy người dùng.

---

## Giai đoạn 5 — electron-builder + NSIS

**Cần tạo trước:** `build/icon.ico` (256×256, hiện **không có icon nào trong repo**).

**`package.json`** — sửa `name` (`ai-video-auto-cutter-electron` → `crabbycut`), `version`
(`0.1.0` → `1.1.1`), và thay khối `build` stub (:63-78) bằng cấu hình đủ:

```jsonc
"build": {
  "appId": "com.crabbycut.app",
  "productName": "CrabbyCut",
  "asar": false,                       // xem mục "Chốt: asar: false"
  "directories": { "output": "dist", "buildResources": "build" },
  "npmRebuild": false,                 // xem ghi chú dưới — postinstall sẽ NÉM
  "compression": "maximum",
  "electronLanguages": ["en-US", "vi"],   // bỏ ~40 .pak locale không dùng (~10 MB)
  "files": [
    "package.json", "electron/**", "backend/**", "index.html",
    "static/**", "!static/fonts/google/**/*_Italic.ttf",   // ← cắt 58 MB, xem dưới
    "library/**", "asr/**/*.py", "core_logic.py",
    "scripts/python_command.js", "scripts/run_python.js",
    "settings/app_settings.json",
    "native/addon/index.js", "native/addon/build/Release/core_c.node",
    "native/sidecar/build/core_process.exe",
    "vendor/ffmpeg/bin/**",
    "node_modules/**",
    "!node_modules/pixi.js/**", "!node_modules/mammoth/**",   // đã vendor sang static/vendor
    "!node_modules/node-addon-api/**",                        // chỉ là header lúc build
    "!native/node_modules/**", "!native/addon/src/**", "!native/sidecar/*.cpp",
    "!native/addon/build/**/obj/**",
    "!**/{*.obj,*.pdb,*.ilk,*.exp,*.lib,*.pyc,.DS_Store}", "!**/__pycache__/**",
    "!{tests,docs,reports,temp_uploads,peaks_cache,asr_cache,test_temp,.venv,.claude}/**",
    "!{progress.txt,requirements.txt,package-lock.json}"
  ],
  "extraResources": [
    { "from": "vendor/python",  "to": "vendor/python" },      // CPython relocatable .tar.gz
    { "from": "vendor/vcredist/VC_redist.x64.exe", "to": "vcredist/VC_redist.x64.exe" },
    { "from": "build/packs.json", "to": "packs.json" }
  ],
  "fileAssociations": [ /* giữ nguyên .crab */ ],
  "win": {
    "target": [{ "target": "nsis", "arch": ["x64"] }],
    "icon": "build/icon.ico",
    "artifactName": "CrabbyCut-Setup-${version}.${ext}"
  },
  "nsis": {
    "oneClick": false,
    "perMachine": false,                 // ← quyết định quan trọng nhất khi CHƯA ký số
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true,
    "shortcutName": "CrabbyCut",
    "include": "build/installer.nsh",
    "deleteAppDataOnUninstall": false,
    "differentialPackage": true          // sinh .blockmap -> cập nhật chỉ tải phần khác
  },
  "publish": {
    "provider": "github", "owner": "tamphamdesigner92-tb", "repo": "CrabbyCut-releases",
    "vPrefixedTagName": true, "publishAutoUpdate": true
  }
}
```

**Vì sao `perMachine: false` là quyết định quan trọng nhất khi chưa có chứng chỉ:** cài theo
**từng người dùng** vào `%LOCALAPPDATA%\Programs\CrabbyCut` → **không cần UAC**. Chọn
`perMachine: true` thì **mỗi lần cập nhật** bung một hộp UAC vàng "Publisher: Unknown" —
auto-update coi như vô nghĩa. (Bản cập nhật vẫn cài **im lặng** dù `oneClick: false`, vì
electron-updater chạy bộ cài với cờ `/S --updated`; giữ `oneClick: false` để **lần cài đầu**
có wizard hiện các bước kiểm tra máy như bạn yêu cầu.)

`differentialPackage` sinh `.blockmap` để electron-updater chỉ tải phần khác. **Phải upload
`.blockmap` cùng release** (`--publish` tự làm). Đừng hứa trước con số delta: `.node`/`.exe`
bản địa và `editing-runtime.js` 1 MB nén lại làm đổi hàng loạt block, nên delta thực tế có
thể vẫn 60–120 MB.

**Ba loại trừ đáng tiền:**
- **`*_Italic.ttf` — cắt 58 MB miễn phí.** Đã đếm: 276/618 tệp `.ttf` là italic, tổng 58 MB,
  và **không có một tham chiếu nào trong mã** (`editingFontFile()` ở `editing-runtime.js:72-75`
  dựng tên `<folder>_<weight><Name>.ttf` không có biến thể italic; `EDITING_FONT_FILES`
  (server.js:74+) chỉ map `_400Regular.ttf`). Kiểm chứng sau khi build: còn đúng **342** tệp `.ttf`.
- **`native/`** là 14 MB nhưng artifact thật chỉ ~0.8 MB — phần còn lại là `core_process.obj`
  (2.4 MB) và cây build của node-gyp. Liệt kê đúng hai tệp cần thay vì `native/**`.
- **`pixi.js` + `mammoth`** (~17 MB): đã được `sync_vendor_assets.js` copy sang
  `static/vendor/` (đó là **đường duy nhất** chúng tới được renderer, `index.html:10-11`),
  nên bản trong `node_modules` là dư.

**`npmRebuild: false`** — bắt buộc, không phải tối ưu. `postinstall` chạy
`sync_vendor_assets.js`, mà script đó **đọc từ `node_modules`** và **`throw`** khi không tìm
thấy nguồn (`sync_vendor_assets.js:16-19`). electron-builder khi `npmRebuild` bật sẽ chạy
`npm install --production` trong thư mục staging — nơi `node_modules/pixi.js` có thể không có
→ build chết. Không có native npm dep nào cần rebuild (`node-addon-api` chỉ là header), nên
tắt là thuần lợi.

**`perMachine: false`** (cài vào `%LOCALAPPDATA%\Programs\CrabbyCut`) — **không cần UAC**, và
điều này còn quan trọng hơn một lý do nữa (xem Giai đoạn 6): chỉ ở chế độ này thì bước thiết
lập do trình cài gọi mới chạy **dưới đúng tài khoản người dùng** và dựng môi trường vào
`%LOCALAPPDATA%` đúng chỗ.

**Về VC++ Redistributable:** đã xác minh binary của **chính mình không cần** nó — cả
`core_c.node` lẫn `core_process.exe` đều **link CRT tĩnh** (không import
`vcruntime`/`msvcp`/`ucrtbase`, chỉ `kernel32.dll` + `libnode.dll` do Electron cấp). Yêu cầu
redist đến từ **wheel Python**: `ctranslate2`, `onnxruntime`, `opencv`. Vẫn **nhúng**
`VC_redist.x64.exe` (~25 MB) thay vì tải: đây là nguyên nhân số một của kiểu lỗi "app mở lên
bình thường mà không làm gì được", và tải nó đòi mạng đúng lúc mạng đang là thứ đáng nghi.
Bước thiết lập kiểm registry `HKLM\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64`
→ `Installed=1`; chỉ khi thiếu mới chạy, và đó là lần UAC duy nhất.

**Addon không bị ràng buộc phiên bản Electron.** Đã xác minh `native/addon` dùng **Node-API**
(`#include <napi.h>` + `node-addon-api`, `binding.gyp` khai `NAPI_CPP_EXCEPTIONS`) → ABI ổn
định, `.node` build bằng Node 24 nạp được trong Electron 31. **Không cần `electron-rebuild`**,
và nâng Electron về sau không buộc build lại addon.

**Đường dẫn tài nguyên nhúng:** với `asar:false`, `APP_ROOT` = `resources/app`, còn
`extraResources` nằm ở `resources/`. Đừng lần theo `..` từ backend — `electron/main.js` có
`process.resourcesPath`, nên truyền tường minh xuống backend cạnh các biến đã inject (:73-82):
```js
env.CRABBYCUT_FFMPEG_DIR = path.join(process.resourcesPath, 'ffmpeg', 'bin');
env.CRABBYCUT_PYTHON     = path.join(process.resourcesPath, 'python', 'python.exe');
env.CRABBYCUT_PACKAGED   = app.isPackaged ? '1' : '0';   // paths.js tự suy DATA_ROOT từ đây
env.CRABBYCUT_RUNTIME    = path.join(app.getPath('appData'), '..', 'Local', 'CrabbyCut', 'runtime');
```
Khi chạy từ mã nguồn các biến này không được đặt → mọi thứ rơi về hành vi hiện tại.

**Trình tự build** (native phải xong TRƯỚC electron-builder):
```
npm ci → npm run build:native → node scripts/fetch_vendor.js → electron-builder --win
```
`scripts/fetch_vendor.js` (mới) tải + kiểm SHA-256 CPython relocatable, ffmpeg gpl-shared và
`VC_redist.x64.exe` vào `vendor/` (thêm `vendor/` + `dist/` vào `.gitignore`). `build:native`
cần MSVC ("Desktop development with C++") — chỉ trên máy build, không phải máy người dùng.

⚠️ **Không** thêm `scripts/fix_electron_signature.js` vào chuỗi `dist`. Nó là macOS-only (thoát
0 trên Windows) và chỉ ký lại bản Electron **trong `node_modules`** cho Library Validation của
macOS khi chạy dev (xem comment `main.js:9-14`). electron-builder tự ký theo cấu hình `win`;
trộn hai thứ này là một lỗi thật.

### 5b. Dự toán kích thước — thẳng thắn: **~276 MB**, hơi vượt mục tiêu 200–250 MB

| Thành phần | Giải nén | Trong NSIS (LZMA) |
|---|---|---|
| Electron 31 x64 (đã cắt locale) | ~200 MB | ~85 MB |
| `static/` — font **62 MB** (đã bỏ italic) + js/vendor 4 MB | ~66 MB | ~30 MB |
| `library/` (Video 50, Music 6, luts 3, SFX+Elements 2) | 59 MB | ~56 MB (media nén không lại) |
| `vendor/ffmpeg/bin` (bản shared) | ~120 MB | ~48 MB |
| `vendor/python` (.tar.gz) | 28 MB | 28 MB (đã nén sẵn) |
| `vendor/vcredist` | 25 MB | 25 MB (đã nén sẵn) |
| Mã app + native artifact + `node_modules` production | ~8 MB | ~4 MB |
| **Tổng** | **~506 MB đã cài** | **≈ 276 MB** |

Các đòn bẩy nếu bạn muốn ép về đúng 250 MB, xếp theo mức đáng tiếc:
1. Dùng bản embeddable thay `python-build-standalone` → **−17 MB (~259 MB)**. Mất đường thoát
   `--from-pypi` và thêm rủi ro `._pth` (xem 4b).
2. Tải `VC_redist` thay vì nhúng → **−25 MB (~234 MB)**. Mất bảo đảm offline cho đúng cái lỗi
   khởi động phổ biến nhất. **Tôi khuyên trả 25 MB này.**
3. Cắt bớt `library/Video` (50 MB stock footage) — nên **cắt bớt ngay trong bộ cài** (chọn lọc
   xuống ~10 MB) chứ **đừng** biến nó thành gói tải riêng: tải riêng thì phải giải nén vào
   `DATA_ROOT`, tức làm sống lại đúng cái overlay hai gốc mà phép tách LUT vừa loại bỏ.

**Khuyến nghị: chấp nhận ~276 MB, hoặc lấy đòn bẩy 1 để về ~259 MB.** Đánh đổi bảo đảm
offline của VC++ hay tính một-gốc của `library/` để lấy đúng con số 250 MB là món hời ngược.

---

## Giai đoạn 6 — Thiết lập môi trường lúc cài (phần người dùng thấy)

**Cách làm:** NSIS **không** tự tải 700 MB. `build/installer.nsh` dùng macro `customInstall`
chạy chính app vừa cài với một cờ rồi **đợi**, và mã thoát báo kết quả về cho NSIS
(0 = xong, 2 = người dùng hoãn, khác = lỗi):
```nsis
!macro customInstall
  ; ... kiểm VC++ qua registry, chạy resources\vcredist nếu thiếu ...
  ${If} $installMode == "CurrentUser"
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --first-run-setup --from-installer' $2
  ${Else}
    ; CÀI THEO MÁY = trình cài đang chạy NÂNG QUYỀN -> chạy app ở đây sẽ dựng môi trường
    ; vào %LOCALAPPDATA% của TÀI KHOẢN ADMIN, không phải của người dùng thật. BỎ QUA,
    ; để lần mở app đầu tiên của TỪNG người dùng tự dựng (cùng một mã).
    DetailPrint "Cài theo máy: môi trường sẽ dựng khi mỗi người dùng mở app lần đầu."
  ${EndIf}
!macroend
```
Nhờ vậy phần thiết lập là một **cửa sổ Electron thật**: tiếng Việt, thanh tiến trình từng
pack, thử lại được, báo lỗi rõ ràng — thay vì cố nhồi logic tải/giải nén vào NSIS script
(nơi không có UI tử tế và gần như không debug được). `setup.html` nạp bằng `win.loadFile()`,
**không** qua Express — bước thiết lập phải chạy được cả khi backend không khởi động nổi,
đó là một nửa lý do nó tồn tại.

Trình gỡ cài phải bọc phần hỏi-xoá trong `${IfNot} ${isUpdated}` — nếu không thì **mỗi lần
cập nhật app là xoá mất 1.2 GB + 1.6 GB** rồi tải lại.

**Tệp mới:** `electron/setup-window.js` + `electron/setup.html`. `electron/main.js` phân
nhánh sớm trong `app.whenReady()`: nếu `process.argv` có `--first-run-setup` thì mở cửa sổ
thiết lập và **không** dựng backend (backend chưa cần gì lúc này).

**Các bước thiết lập, đúng thứ tự:**

1. **Kiểm tra máy (preflight)** — hiển thị thành bảng, cái nào đạt thì tick xanh:
   - Windows 10 1809+ / 11, x64
   - Đĩa trống: **≥ 3 GB** (không NVIDIA) / **≥ 5 GB** (có NVIDIA) — chưa tính 1.6 GB model về sau
   - `MSVCP140.dll` (chỉ mời cài redist nếu thiếu)
   - Ghi được vào `%APPDATA%\CrabbyCut` và `%LOCALAPPDATA%\CrabbyCut`
   - ffmpeg nhúng chạy được (`ffmpeg -version`) — bắt lỗi thiếu DLL của bản shared ngay tại đây
   - GPU: `nvidia-smi` → có thì hiện tên card + VRAM + phiên bản driver và **tự tích** gói CUDA
     (dùng lại `collectNvidiaGpuInfo()` ở `backend/server.js`, đừng viết mới)
   - Python nhúng chạy được (`python.exe -c "import sys"`)
   - `core_c.node` **nạp được** và `core_process.exe` **chạy được** — phân biệt
     `ERR_DLOPEN_FAILED` (thiếu VC++) với `ENOENT` (bị antivirus cách ly) và nói rõ cái nào
   - **Loopback thông** — bind một `http.Server` cổng tạm trên `127.0.0.1` rồi tự gọi. Tường
     lửa/LSP chặn loopback là cả ứng dụng không bao giờ chạy được, mà chẩn đoán từ triệu chứng
     "cửa sổ trắng" thì rất khổ
   - `arm64` → **chặn cứng** kèm lời giải thích: không có wheel `win_arm64` cho
     ctranslate2/mediapipe/opencv-contrib, và `core_c.node` là x64
2. **Chọn thành phần** — checkbox: Bóc băng (ASR), Auto-Reframe/Retouch (vision),
   Tăng tốc NVIDIA (cuda, chỉ hiện khi dò thấy card). Ghi rõ dung lượng từng cái.
3. **Tải + giải nén** — tuần tự, mỗi pack một thanh tiến trình. Bốn chi tiết bắt buộc:
   - Tải bằng **`net.request` của Electron**, không phải `https` — nó tôn trọng proxy/PAC của
     Windows, thứ rất hay gặp ở mạng công ty và trường học.
   - **Resume bằng `Range: bytes=<đã có>-`** vào `<id>.zip.part` → gói CUDA 527 MB đứt ở 80%
     thì tiếp từ 80%, không tải lại từ đầu.
   - **Kiểm SHA-256 trước khi giải nén**; lệch thì xoá `.part`, thử lại **một lần từ byte 0**,
     rồi báo lỗi nói thẳng nghi vấn proxy/captive-portal (đó chính là dấu hiệu của nó).
   - Giải nén bằng **`C:\Windows\System32\tar.exe`** (có sẵn từ Win10 1803, dưới mốc 1809 của
     ta nên không phải nhúng gì) vào `site-packages.new` rồi **đổi tên** vào chỗ — hỏng giữa
     chừng không bao giờ để lại `site-packages` nửa vời (thứ sẽ import được rồi nổ ở đâu đó sâu).
   - Một pack hỏng **không** làm hỏng các pack khác (CUDA lỗi không được cướp đi một bản cài
     CPU đang chạy tốt). Nút "Thử lại" cho từng pack.
4. **Tự kiểm tra thật sự dùng được**, không chỉ "đã giải nén xong":
   - `asr/windows_faster_whisper_sidecar.py --check-imports` (**đã có sẵn**, :768-769, và
     `server.js:2096` đã dùng) + một lệnh `import cv2, mediapipe`.
   - ⚠️ **CUDA phải kiểm khác.** `import ctranslate2` thành công **không chứng minh gì**:
     `cublas64_12.dll` chỉ được `LoadLibrary` nạp **muộn, lúc `model.encode()`**, nên mọi
     phép thăm dò đều báo "CUDA sẵn sàng" rồi bóc băng chết giữa chừng với
     `Library cublas64_12.dll is not found` — đúng cái bẫy mà
     `windows_faster_whisper_sidecar.py:29-36` đã ghi lại. Nên phải **gọi chính
     `_ensure_cuda_dll_path()` của sidecar** rồi `ctypes.WinDLL("cublas64_12.dll")` để chứng
     minh DLL nạp được. **Không viết lại logic PATH đó** — import và gọi hàm có sẵn.
   - Toàn bộ phép dò phải chạy với đúng kỷ luật UTF-8 của `scripts/python_command.js:33-37`
     (`PYTHONUTF8=1`, `PYTHONIOENCODING=utf-8`), nếu không một thông báo lỗi tiếng Việt sẽ
     giết tiến trình dò bằng `UnicodeEncodeError` — đúng cái bẫy tệp đó đã ghi.
5. **Ghi `.pack-manifest.json`** + báo cáo kết thúc.

**Hỏng giữa đường / người dùng huỷ:** không sao — manifest chỉ ghi pack nào **đã xác minh
xong**. App vẫn cài xong và mở được; các tính năng thiếu pack sẽ bị vô hiệu hoá **kèm lý do
và nút "Thiết lập lại"**, chứ không nổ lỗi Python khó hiểu. Mọi lần khởi động bình thường
đều đối chiếu `.pack-manifest.json` với yêu cầu của phiên bản hiện tại; lệch thì mời chạy
lại thiết lập (cùng cửa sổ đó, mở từ trong app).

**Trình gỡ cài đặt:** `deleteAppDataOnUninstall: false` để không xoá dự án/cài đặt của người
dùng. Thêm `customUnInstall` **hỏi** có xoá `%LOCALAPPDATA%\CrabbyCut\runtime` (~1.2 GB) và
`asr_models` (~1.6 GB) không — mặc định **không**, để cài lại không phải tải lại 2.8 GB.

---

## Giai đoạn 7 — Phiên bản + tự động cập nhật

### 7a. Một nguồn sự thật cho số phiên bản

Hiện **không có phiên bản trong code**; nó chỉ nằm trong commit message và tên nhánh.
`package.json` `"version"` là thứ **cả electron-builder lẫn electron-updater đều đọc**, nên
nó phải trở thành nguồn sự thật: sửa `0.1.0` → `1.1.1`.

**Sơ đồ semver — bỏ hậu tố `-Win`.** electron-updater bắt buộc semver nghiêm, và
`1.1.1-Win` vỡ theo **hai** cách cụ thể:
1. `-Win` là đoạn **prerelease** → chỉ được chào khi `allowPrerelease: true`, mà bật cờ đó
   thì mọi bản nháp `1.2.0-beta.1` cũng bị đẩy cho người dùng cuối.
2. Nặng hơn: `GitHubProvider` **suy ra "channel" từ đoạn prerelease** → `1.1.1-Win` làm nó
   đi tìm `latest-Win.yml`, trong khi electron-builder sinh ra `latest.yml`. Cập nhật
   **im lặng không bao giờ tìm thấy gì** — loại lỗi tệ nhất vì trông như "chưa có bản mới".

Vì vậy: `package.json` giữ `1.1.1` **trơn**; nền tảng thể hiện ở tên tệp
(`CrabbyCut-1.1.1-win-x64-setup.exe`) và tên nhánh git, **không** nằm trong số phiên bản.
Tag git: `v1.1.1` (repo hiện chưa có tag nào).

⚠️ **`productName` phải giữ nguyên `"CrabbyCut"`.** `app.getPath('userData')` bám
`productName`/`appId`, nên đổi nó là **mất `recent-projects.json` + toàn bộ autosave** của
người dùng cũ. Đổi `name` trong `package.json` (`ai-video-auto-cutter-electron` → `crabbycut`)
thì **an toàn** — đó chỉ là tên package npm nội bộ.

Đường số phiên bản đi tới từng nơi:
- **Main process:** `app.getVersion()` (hiện được gọi **0 lần**).
- **Backend** chạy như tiến trình con `ELECTRON_RUN_AS_NODE` nên **không gọi được**
  `app.getVersion()` → inject cạnh các biến đã có (`electron/main.js:73-82`):
  `env.CRABBYCUT_VERSION = app.getVersion()`. Dự phòng cho `npm run backend:dev`: đọc
  `package.json`.
- **Renderer:** mở rộng đúng cái object `versions` đang chết ở `electron/preload.js:60-64`
  (thêm `app`), chứ không tạo API song song.
- **Báo cáo dự án:** `writeProjectReport()` (server.js:945) thêm `app_version` vào khối
  `<HARDWARE>` và nâng `schema_version` 2 → 3. Đây là thứ làm mọi báo lỗi về sau truy được
  ngay ra phiên bản.

### 7b. Phụ thuộc + hai chi tiết dễ sai

`npm i electron-updater --save` → phải vào **`dependencies`**, **không** phải
`devDependencies`: main process `require()` nó lúc chạy, mà electron-builder loại
devDependencies khỏi bundle → bản đóng gói chết với `Cannot find module 'electron-updater'`.
Ghép phiên bản: repo đang có `builder-util-runtime@9.2.4` (từ `electron-builder@24.13.3`);
nếu `electron-updater@6.3.x` báo xung đột peer thì hạ về `6.1.8` (cùng dòng
`builder-util-runtime` 9.2.x). **Không nâng `electron-builder`** ở đợt này — lên 25/26 kéo
theo đổi API `nsis`/`sign`, là việc riêng.

**`releaseNotes` là HTML thô từ mạng.** GitHub trả nội dung release dưới dạng HTML do người
viết gõ. Repo **không có bộ lọc HTML nào**, nên tuyệt đối không `innerHTML` thẳng. Lọc ở
**main process** trước khi gửi state đi (escape hết rồi dựng lại xuống dòng/danh sách),
renderer chỉ nhận text đã sạch và hiển thị bằng `textContent`; kèm nút "Xem toàn bộ ghi chú"
mở trang release thật bằng `shell.openExternal`. Đặt hàm lọc trong module thuần
`electron/update-policy.js` (không import `electron`) để test được bằng node — đúng khuôn
`electron/crab-format.js` và `electron/recent-projects.js` đang dùng.

### 7c. Nơi đặt giao diện cập nhật

Ứng dụng **cố ý không có menu bar** (`Menu.setApplicationMenu(null)`, main.js:149, vì Alt là
phím bổ trợ của timeline), nên **không thể** dùng menu "About / Check for updates". Ba bề mặt:

1. **Bảng Cài đặt** — thêm mục "Giới thiệu & Cập nhật" vào `static/js/settings-panel.js`
   (hiện chưa có phần About nào): số phiên bản, nút "Kiểm tra cập nhật", dòng trạng thái,
   và ô "Tự động tải bản cập nhật" (mặc định **bật**).
2. **Toast** khi tìm thấy bản mới — dùng lại `showToast(msg,{type})` có sẵn.
3. **Sửa thông báo cụt hiện tại** ở `index.html:11150` (mở tệp `.crab` của bản mới hơn):
   hiện chỉ nói "Hãy cập nhật ứng dụng" mà **không có gì đứng sau** → nối vào luồng kiểm tra
   cập nhật thật.

**Hợp đồng IPC** (thêm vào `electron/preload.js` + `electron/main.js`, theo đúng lối
`ipcRenderer.invoke` mà file này đang dùng):
| Kênh | Chiều | Payload |
|---|---|---|
| `app-version` | invoke → string | `"1.1.1"` |
| `update-check` | invoke | khởi động một lượt kiểm tra thủ công |
| `update-install` | invoke | xác nhận rồi `quitAndInstall()` |
| `update-state` | main → renderer | `{state, version?, percent?, notes?, message?}` với `state` ∈ `checking / available / not-available / downloading / downloaded / error` |

**Câu chữ tiếng Việt** cho từng trạng thái:
- `checking` — "Đang kiểm tra bản cập nhật…"
- `not-available` — "CrabbyCut đã là bản mới nhất (1.1.1)."
- `available` — "Đã có CrabbyCut 1.1.2." + hiển thị `releaseNotes`
- `downloading` — "Đang tải bản 1.1.2… 43%"
- `downloaded` — "Bản 1.1.2 đã tải xong." + nút **"Khởi động lại để cập nhật"**
- `error` — "Không kiểm tra được bản cập nhật. Kiểm tra kết nối mạng rồi thử lại."

### 7d. Chính sách cập nhật

- **Kiểm tra lúc khởi động, nhưng phải hoãn.** `ensureBackendReady()` đã poll tới 30 s
  (main.js:107-120) và lúc đó app đang dựng cửa sổ + nạp `index.html` 771 KB. Đặt lượt kiểm
  tra sau `did-finish-load` (main.js:168-175) thêm ~20 s để không giành băng thông/CPU.
- `autoDownload: true` (theo lựa chọn đã chốt) + ô tắt trong Cài đặt cho người dùng mạng
  giới hạn — bộ cài 250 MB là không nhỏ.
- **Không được chen ngang khi đang export / bóc băng.** Thêm `GET /api/busy` **riêng**, không
  nhồi vào `/api/status` (:3798) vì đó là đường nóng của health-poll.
  ⚠️ **Không dùng `projectMetrics.activity`** (server.js:198): cờ đó nghĩa là "dự án này đã
  từng làm gì", bật từ lần nhập video đầu và **không bao giờ tắt** cho tới `/api/reset-project`
  → lấy làm cổng bận là **chặn cập nhật vĩnh viễn**. Nguồn thật: `exportInFlight` (:150) và
  số tiến trình con đang sống (:145) **trừ** `peaksRunning` (:1820) — job sóng âm chạy nền
  liên tục và sinh lại được, tính nó là bận thì không bao giờ rảnh.
  Khi không hỏi được thì **fail-open** (`busy:false`): backend chết thì chẳng có việc gì
  đang chạy, còn fail-closed sẽ khoá cập nhật vĩnh viễn khi endpoint lỗi.
- `autoDownload` để `false` ở tầng electron-updater, "tự động" ở **tầng chính sách**:
  `autoDownload:true` bắt đầu tải **ngay trong** `update-available`, không có chỗ chen điều
  kiện. Tự gọi `downloadUpdate()` khi `/api/busy` báo rảnh → người dùng vẫn thấy "tự động"
  nhưng không bao giờ tải chen vào một lượt export 4K.

**Hai cạm bẫy mất dữ liệu — đây là phần dễ sai nhất của cả kế hoạch:**

1. **`quitAndInstall()` chạy bộ cài TRƯỚC khi thoát.** `BaseUpdater.quitAndInstall()` gọi
   `install()` trước (spawn bộ cài NSIS detached, cờ `/S`), rồi mới `app.quit()` trong
   `setImmediate`. Nếu ta gọi nó rồi để handler `mainWindow.on('close')` (:185-217)
   `preventDefault()` vì người dùng bấm **Huỷ** → app sống tiếp **trong khi bộ cài đang ghi
   đè `$INSTDIR` ngay dưới chân nó**. App hỏng giữa phiên, dự án chưa lưu bay.
   → **Bắt buộc: hỏi trước, `quitAndInstall()` sau.** Hộp thoại riêng cho cập nhật
   (`['Lưu và cập nhật', 'Không lưu, cập nhật luôn', 'Huỷ']`), chỉ khi người dùng xác nhận
   mới đặt `forceClose = true` rồi gọi `quitAndInstall(true, true)`.
2. **Phải tắt backend trước khi cài.** Backend sidecar được spawn bằng `process.execPath`
   (:71) — tức **chính `CrabbyCut.exe` đang bị cài đè** → nó **giữ handle** trên tệp trong
   `$INSTDIR`. Còn sống thì NSIS không ghi đè được và bản cập nhật **thất bại im lặng**:
   người dùng thấy app khởi động lại mà vẫn phiên bản cũ. Gọi `stopBackendSidecar()`
   (:123-141) trước `quitAndInstall()`. May là hàm đó đặt `backendProcess = null` ngay đầu,
   nên nhánh `before-quit` (:587-598) sẽ `return` sớm và không tranh chấp.

`autoInstallOnAppQuit: true` thì **an toàn và nên bật**: electron-updater cài trong
`app.on('quit')`, tức chỉ sau khi quit không bị chặn — sau khi hộp thoại "Còn thay đổi chưa
lưu" (:200-208) đã được trả lời. Ai không bấm nút thì lần tắt app sau tự có bản mới.

### 7e. An toàn khi lên phiên bản mới

electron-updater **thay toàn bộ app dir**. Những thứ sau phải sống sót — và theo thiết kế ở
Giai đoạn 1 & 4 thì chúng đã nằm ngoài app dir, đây là phần xác nhận + xử lý phần còn lại:

| Dữ liệu | Nơi ở | Ghi chú |
|---|---|---|
| `app_settings.json`, các cache, `reports/` | `%APPDATA%\CrabbyCut` | Ngoài app dir → an toàn |
| `autosave/`, `recent-projects.json` | `app.getPath('userData')` | Đã đúng chỗ từ trước |
| Môi trường Python (~1.2 GB) | `%LOCALAPPDATA%\CrabbyCut\runtime` | Ngoài app dir → **không tải lại** |
| Model ASR (~1.6 GB) | `%LOCALAPPDATA%\...\asr_models` | Đổi tên sản phẩm **có dự phòng** đọc thư mục cũ |
| LUT người dùng nhập | `%APPDATA%\CrabbyCut\library\luts` | Gieo lại library **không xoá tệp lạ** |

**Kiểm tra tương thích pack** — đây là hệ quả của việc để runtime ngoài app dir: app mới có
thể gặp runtime **cũ**. App khai báo `REQUIRED_PACKS = { core: 1, asr: 2, vision: 1 }`, đối
chiếu với `.pack-manifest.json` mỗi lần khởi động; lệch thì hiện "Cần cập nhật môi trường"
và mở lại đúng cửa sổ thiết lập ở Giai đoạn 6 (chỉ tải pack nào lệch).

**Bước di trú một lần cho mỗi phiên bản** (`electron/migrations.js`, mới): lưu
`lastRunVersion` trong userData; khi thấy phiên bản tăng thì chạy các bước di trú tương ứng
rồi ghi lại. `PEAKS_FORMAT_VERSION` / `ASR_CACHE_VERSION` đã tự vô hiệu cache qua khoá nên
không cần làm gì thêm cho chúng.

---

## Giai đoạn 8 — Quy trình phát hành

Repo nguồn **private**, nên phát hành đi qua một repo public chỉ chứa bản build:

**Tạo `tamphamdesigner92-tb/CrabbyCut-releases`** (public) — chỉ chứa `README` + các
GitHub Release. Không có mã nguồn. `publish` trong electron-builder trỏ vào đây (xem Giai
đoạn 5). electron-updater đọc `releases.atom` + `latest.yml` + `.exe` từ repo này,
**không cần token** vì repo public → app **không mang theo bí mật nào**, và cũng không dính
hạn 60 request/giờ của REST API.

Hai chi tiết dễ vướng:
- **Phải commit `README.md` đầu tiên.** electron-builder tạo release với tag trên
  `target_commitish` = nhánh mặc định; repo rỗng **không có nhánh nào** để gắn tag.
- **Token:** PAT **fine-grained**, chỉ repo `CrabbyCut-releases`, quyền `Contents:
  Read and write`, đặt trong env `GH_TOKEN` của máy build. Điểm quan trọng: token này
  **không đọc được mã nguồn private**, nên rò rỉ cũng không mất mã. Thêm một chốt trong
  script phát hành: từ chối chạy nếu `publish.repo === 'CrabbyCut'`.
- Tắt Issues/Wiki ở repo release (đây không phải kênh hỗ trợ).

**Không dùng GitHub Actions** cho việc build: workflow trong repo public không truy cập được
mã nguồn private, mà build lại **buộc phải có MSVC** cho `core_c.node`. Nên build tại máy
dev bằng một script, đó cũng là cách ít khâu nhất:

`scripts/release.js` (mới) — chạy tuần tự và dừng ngay khi có bước lỗi:
1. Kiểm cây git sạch + đang ở nhánh phát hành.
2. Nâng `package.json` version; tạo git tag `v1.1.2` (**hiện repo chưa có tag nào**).
3. `npm ci && npm run build:native && npm test` — không xanh thì không phát hành.
4. `node scripts/fetch_vendor.js` (Python + ffmpeg) và `node scripts/build_python_packs.js`
   (chỉ khi phiên bản pack đổi).
5. `electron-builder --win --publish always` với `GH_TOKEN` trỏ repo public.
6. Đẩy các pack ZIP + SHA-256 lên cùng release.
7. Ghi release notes tiếng Việt (đây chính là `releaseNotes` mà app hiển thị ở 7c).
8. **Để release ở trạng thái DRAFT** (electron-builder tạo draft theo mặc định) → kiểm đủ
   3 asset `.exe` + `.exe.blockmap` + `latest.yml` → cài thử trên VM sạch → **rồi mới bấm
   Publish**. Draft **không** xuất hiện trong `releases.atom`, nên không ai nhận được bản
   cập nhật trước khi ta kiểm xong. Thiếu `.blockmap` là mất delta; thiếu `latest.yml` là
   updater không thấy gì.
9. `Get-FileHash <setup.exe> -Algorithm SHA256` → dán vào release notes + `SHA256SUMS.txt`.

**Lộ trình CI về sau:** khi quy trình đã chạy tay vài lần, chuyển bước build/publish vào
`.github/workflows/release-win.yml` **trong repo private** (`on: push: tags: ['v*']`), dùng
`GITHUB_TOKEN` để checkout chính nó và một secret `RELEASES_TOKEN` để đẩy asset sang repo
public. Runner `windows-latest` có VS 2022 nên `build:native` chạy được. Đây sẽ là tệp CI
đầu tiên của dự án (`.github/` hiện **không tồn tại**).

---

## Ký số (bạn đã hỏi cách lấy chứng chỉ)

**Không ký thì cụ thể sẽ ra sao:**
- Tải `.exe` từ trình duyệt: Chrome/Edge cảnh báo "không thường được tải" hoặc chặn.
- Chạy lần đầu: **SmartScreen "Windows protected your PC"** → phải bấm
  *More info* → *Run anyway*.
- Uy tín SmartScreen tích luỹ theo **mã băm từng tệp**, nên **mỗi bản phát hành mới lại từ
  số 0** → cảnh báo tái diễn ở mọi bản. (Có chứng chỉ thì uy tín tích theo **chứng chỉ**,
  mọi bản sau thừa hưởng.)
- Antivirus báo giả nhiều hơn rõ rệt, nhất là app có sidecar `.exe` + Python.

**Tin quan trọng nhất: auto-update KHÔNG ký VẪN CHẠY trên Windows** — và đây là lý do cụ thể:
1. **Toàn vẹn luôn được kiểm:** electron-updater đối chiếu **SHA-512** của tệp tải về với
   `latest.yml`, không khớp thì **từ chối cài**. Đây là lớp bảo vệ thật, không phụ thuộc ký số.
2. **Bước kiểm chữ ký bị bỏ qua đúng cách:** `NsisUpdater` chỉ chạy
   `Get-AuthenticodeSignature` khi `publisherName` có trong `app-update.yml`, mà
   electron-builder chỉ ghi trường đó **khi có cấu hình ký**. Không ký → không có
   `publisherName` → không kiểm → cập nhật chạy bình thường.
3. **Không gặp SmartScreen ở đường cập nhật:** electron-updater tự tải bằng HTTP rồi tự
   spawn, **không** đặt Mark-of-the-Web (`Zone.Identifier`) như trình duyệt. Cộng với
   `perMachine: false`, việc cài bản mới là **im lặng, không prompt**.

→ **Chỉ lần cài ĐẦU TIÊN gặp SmartScreen; từ đó về sau mọi bản cập nhật đều êm.** Vì vậy làm
auto-update ngay bây giờ là hoàn toàn đáng, dù chưa có chứng chỉ.

**Các lựa chọn chứng chỉ (giá tham khảo, thay đổi theo nhà cung cấp):**

| Loại | Giá/năm | Bỏ cảnh báo SmartScreen ngay? | Ghi chú |
|---|---|---|---|
| **Azure Trusted Signing** | ~**$120/năm** ($9.99/tháng) | Gần như ngay | Rẻ và gọn nhất hiện nay; Microsoft giữ khoá trên HSM nên **không cần mua token cứng**. Yêu cầu tổ chức đã hoạt động ≥3 năm (có đường cho cá nhân/doanh nghiệp mới nhưng xét kỹ hơn). **Nên xem xét đầu tiên.** |
| **OV** (Organization Validation) | ~$200–400 | **Không** — phải gây dựng uy tín dần | Từ 2023 khoá **buộc** nằm trên token cứng/HSM (YubiKey hoặc HSM đám mây) → thêm phí và thêm khâu khi build |
| **EV** (Extended Validation) | ~$400–700 | **Có, ngay lập tức** | Bắt buộc token cứng; thẩm định tổ chức ngặt hơn |

Nhà cung cấp thường gặp: DigiCert, Sectigo, SSL.com, GlobalSign, Certum.
⚠️ Gói **Certum "Open Source Code Signing"** rất rẻ (~30 EUR/năm) nhưng **đòi dự án mã nguồn
mở** — mã nguồn CrabbyCut là private nên **không đủ điều kiện**.

**Ràng buộc phần cứng từ 01/06/2023** (dễ bỏ sót khi lập ngân sách): CA/Browser Forum bắt
buộc khoá riêng của chứng chỉ ký mã — **kể cả OV**, không chỉ EV — phải nằm trong thiết bị
FIPS 140-2 Level 2 / CC EAL4+. Hệ quả thực tế:
- **Không còn nhà cấp nào phát `.pfx` tải về** cho chứng chỉ mới.
- Nhận qua **USB token** (YubiKey FIPS, SafeNet eToken — thêm ~50–100 USD) hoặc **cloud
  HSM** của nhà cấp (SSL.com eSigner, DigiCert KeyLocker — có phụ phí).
- Token vật lý nghĩa là **mỗi lần build phải cắm token + nhập PIN** → **không tự động hoá
  được trong CI**. Đây chính là lý do Azure Trusted Signing hấp dẫn nhất cho một người phát
  triển đơn lẻ.

**Khi đã có chứng chỉ, cắm vào đâu** — không phải sửa gì khác trong kế hoạch:
- **`.pfx`** (chỉ nếu bạn đã có chứng chỉ cũ trước 06/2023): gọn nhất là **không sửa file
  nào**, chỉ đặt env trước khi build — `CSC_LINK` (đường dẫn hoặc base64 của .pfx) +
  `CSC_KEY_PASSWORD`.
- **USB token / cert store Windows** (không xuất được `.pfx`):
  `"win": { "certificateSubjectName": "Tên Công Ty" }` → electron-builder gọi
  `signtool /n`; token bung hộp nhập PIN mỗi artifact.
- **Azure Trusted Signing:** `azureSignOptions` **chỉ có từ electron-builder ≥ 25**, repo
  đang ở `24.13.3`. Nếu chọn hướng này thì **phải lên kế hoạch nâng electron-builder cùng
  lúc** (kéo theo đổi cấu hình `nsis`/`sign`, phải kiểm lại) — hoặc viết hook `win.sign`
  gọi `signtool` với dlib Trusted Signing.

⚠️ **Bẫy di trú, phải đọc TRƯỚC khi ký lần đầu:**
- Không ký → có ký: **an toàn**. Máy đang chạy bản không ký không có `publisherName` nên nó
  nhận bản có ký bình thường.
- Có ký (cert A) → đổi sang cert B có CN khác: máy đang chạy bản A kiểm `publisherName`
  **không khớp** → **TỪ CHỐI cập nhật**, người dùng kẹt vĩnh viễn, phải cài tay. Cách chống:
  `publisherName` nhận **mảng** — liệt kê **cả CN cũ và mới** trong ít nhất một bản chuyển tiếp.
- `publisherName` phải khớp **từng ký tự** CN của chứng chỉ. Sai một dấu là auto-update đứng.

**Trong lúc chưa ký, nói gì với người dùng:**
- Kèm một đoạn hướng dẫn ngắn tiếng Việt trong README của repo release: bấm **More info →
  Run anyway**, và mô tả đúng cái hộp thoại họ sẽ thấy để họ biết đó là bình thường.
- **Công bố SHA-256** của mỗi bộ cài trong release notes — để người dùng cẩn thận tự đối
  chiếu, và để phân biệt bản thật với bản bị chèn.

---

## Các tệp phải sửa / tạo mới

**Sửa (theo mức độ chạm vào):**

| Tệp | Việc |
|---|---|
| `backend/server.js` | Dùng `paths.js`, 7 hằng đổi sang `DATA_ROOT` (:11-54), tách `BUILTIN_LUT_DIR` + 3 mount tĩnh (:3788) + `listColorLuts` (:2895-2904) + bộ đặt tên import (:4362), `ensureDirs()` dọn (:227-239), `cwd`→`DATA_ROOT` ở 4 chỗ spawn (:1325/:1374/:1963/:2008), `windowsAsrModelRoot()` (:330-338), `/api/status` thêm chữ ký + `app_version` (:3798), `/api/busy` + `/api/shutdown` mới, `writeProjectReport()` (:945), `start()` in cổng thật (:4822-4833) |
| `electron/main.js` | Bắt tay cổng qua stdout (:19-24, :46-121, :177), `stopBackendSidecar` + `taskkill /T` (:123-141), inject `CRABBYCUT_*` env (:73-82), cổng môi trường + nhánh `--first-run-setup` trong `whenReady` (:617-626), wiring electron-updater, nối `quitAndInstall` vào luồng đóng cửa sổ (:185-217) |
| `package.json` | `name`, `version` → 1.1.1, khối `build` đầy đủ, thêm `electron-updater`, script `dist:win` / `release` |
| `core_logic.py` | Lazy import `torch`/`whisper` (:17-18), thay `torch.cuda` (:153/:155/:180), `import whisper` cục bộ (:547) |
| `scripts/python_command.js` | `pythonCommand()` thêm 2 ứng viên (:36-44); `pythonEnv()` thêm `PYTHONPATH` + `CRAB_TEMP_DIR` (:48-50) |
| `asr/windows_faster_whisper_sidecar.py` | `CRAB_TEMP_DIR` cho `TEMP_DIR` (:17-18) — **lỗi chặn cứng**; `default_model_root()` (:181-188) |
| `asr/python_filter_sidecar.py` | Đường dẫn dự phòng `session_file` (:48) |
| `native/sidecar/core_process.cpp` | **Chỉ nếu chọn ffmpeg LGPL:** `libx264`→`libopenh264` (:666, :1901) |
| `electron/preload.js` | Mở rộng object `versions` đang chết (:60-64) + 4 kênh IPC cập nhật |
| `static/js/settings-panel.js` | Mục "Giới thiệu & Cập nhật" |
| `index.html` | Nối thông báo cụt (:11150) vào luồng cập nhật; hiển thị phiên bản |
| `requirements.txt` | Bỏ `flask`/`requests`; `torch`+`openai-whisper` → `platform_system == "Darwin"` |
| `.gitignore` | Thêm `vendor/`, `dist/` |
| `docs/APP_INTERNALS.md` | Ghi lại kiến trúc 3 gốc + quy trình phát hành |

**Tạo mới:**

| Tệp | Việc |
|---|---|
| `backend/paths.js` | `APP_ROOT` / `DATA_ROOT` / `RUNTIME_ROOT` + `prependVendorPath()` — nguồn sự thật duy nhất |
| `build/icon.ico` | Icon 256×256 đa phân giải — **hiện repo không có icon nào**, và electron-builder cần nó |
| `build/installer.nsh` | `customInstall` (VC++ + gọi `--first-run-setup`, có nhánh `$installMode`) + `customUnInstall` (bọc `${IfNot} ${isUpdated}`) |
| `electron/runtime-spec.js` | Danh sách pack, phiên bản, URL, SHA-256, kích thước, `min_driver` |
| `electron/runtime-manager.js` | `checkEnvironment()` / `installPack()` / `verifyImports()` / `repair()` — **không UI** |
| `electron/preflight.js` | Các phép kiểm cấu hình máy |
| `electron/setup-window.js` + `electron/setup/*` | Cửa sổ thiết lập tiếng Việt (nạp bằng `loadFile`, không qua Express) |
| `electron/updater.js` | Bọc electron-updater + phát `update-state` |
| `electron/update-policy.js` | Module thuần (lọc release notes, `installGate`, `isStrictSemver`) — test được bằng node |
| `electron/migrations.js` | Di trú một lần cho mỗi phiên bản (`lastRunVersion`) |
| `scripts/fetch_vendor.js` | Tải + kiểm SHA-256 CPython & ffmpeg & VC++ redist vào `vendor/` |
| `scripts/prepare_dist.js` | Cổng fail-fast trước electron-builder (xem dưới) |
| `scripts/build_python_packs.js` | Dựng 4 pack với `pip --target --only-binary=:all:` + ghi `packs.json` |
| `scripts/release.js` | Quy trình phát hành (Giai đoạn 8) |
| Repo `CrabbyCut-releases` | Repo public chỉ chứa bản build + `latest.yml` |

**`scripts/prepare_dist.js`** đáng gọi riêng — nó là thứ chặn việc phát hành một bộ cài hỏng.
Kiểm theo thứ tự, dừng ngay khi lỗi: `core_c.node` tồn tại **và `require()` được**;
`core_process.exe` chạy được; `sync_vendor_assets.js` đã sinh `static/vendor/*`; ffmpeg nhúng
có **đủ encoder/filter** cần thiết (soi gương `HasFfmpegEncoder`/`HasFfmpegFilter` ở
`core_process.cpp:636-641` — bắt được bản ffmpeg sai **lúc build** thay vì lúc người dùng
export lần đầu); `vendor/python` + `vendor/vcredist` có mặt; `build/icon.ico` ≥256×256;
`packs.json` parse được và mọi pack có `sha256` + `size_bytes`.

---

## Thứ tự thực thi

Bốn mốc, mỗi mốc **kiểm được độc lập** trước khi sang mốc sau. Trong Mốc 1, **không đảo thứ
tự 1→5**:

1. **Mốc 1 — Dọn nền** (Giai đoạn 1-3), theo đúng thứ tự:
   1. `backend/paths.js` + 7 hằng đổi gốc + dọn `ensureDirs()`.
      *Kiểm: `npm test` vẫn xanh đủ 38; `CRABBYCUT_PACKAGED=1 node backend/server.js` tạo
      `%LOCALAPPDATA%\CrabbyCut\data\*` và **không** tạo gì trong repo.*
   2. Tách LUT (`BUILTIN_LUT_DIR`, 3 mount, `listColorLuts`, bộ đặt tên import).
      *Kiểm: `/api/color-luts` liệt kê 23 preset; nhập một `.cube` tên `blush` → thành
      `blush_2`, nằm ở `data\luts`, phục vụ ở `/library/luts/blush_2.cube`;
      `test:color-adjust` + `test:auto-grade` xanh.*
   3. `CRAB_TEMP_DIR` trong sidecar Python + `cwd`→`DATA_ROOT` ở 4 chỗ spawn.
      *Kiểm: `npm run test:windows-asr`, rồi một lượt bóc băng đầy đủ với repo đặt chỉ-đọc.*
   4. Lazy `torch`/`whisper` trong `core_logic.py` + marker trong `requirements.txt`.
      *Kiểm: trong một venv sạch **không có torch**, chạy `test:matching`,
      `test:script-reorder-align`, và `python -c "import core_logic; print(
      core_logic.get_detailed_hardware_info(), core_logic.get_system_config())"`.*
   5. Cổng động + chữ ký `/api/status` + `/api/shutdown` + `taskkill /T`.
      *Kiểm: lượt tranh cổng và lượt tiến trình mồ côi — **làm ở dev, trước khi đóng gói**.*

   Chưa có bộ cài nào ở mốc này, nhưng đây là phần rủi ro nhất và phải xong trước.
2. **Mốc 2 — Ra được file .exe** (Giai đoạn 4-5): nhúng ffmpeg + Python, cấu hình
   electron-builder, dựng pack. *Kiểm: cài trên VM sạch, app mở được.*
3. **Mốc 3 — Bộ cài tự dựng môi trường** (Giai đoạn 6): cửa sổ thiết lập + preflight + repair.
   *Kiểm: 6 lượt trên VM ở mục Kiểm chứng.* Đến đây yêu cầu 1 & 2 của bạn coi như xong.
4. **Mốc 4 — Tự cập nhật** (Giai đoạn 7-8): phiên bản, electron-updater, repo release.
   *Kiểm: publish một bản 1.1.2 nháp rồi cập nhật thật từ 1.1.1.*

---

## Kiểm chứng

Điểm mấu chốt: **mỗi giai đoạn phải kiểm được trước khi sang giai đoạn sau**, vì lỗi đóng
gói rất khó truy khi đã nằm trong bộ cài.

### Giai đoạn 1-3 — kiểm ngay trên máy dev, chưa cần đóng gói

Ba giai đoạn đầu được thiết kế để **hành vi chạy từ mã nguồn không đổi** (`DATA_ROOT` mặc
định = `APP_ROOT`, `CRABBYCUT_*` không đặt). Nên bộ test hiện có chính là lưới an toàn:

```bash
npm test
```
38 test script, trong đó các test đi qua đúng những đường vừa sửa: `test:backend`,
`test:native`, `test:windows-asr`, `test:audio-peaks`, `test:export`, `test:app-settings`,
`test:auto-sfx`, `test:vector-asset`, `test:color-adjust`. Chúng gọi ffmpeg thật + Python thật.

Sau đó kiểm **riêng đường packaged-like** bằng cách ép các biến môi trường mà chưa cần cài:
```bash
CRABBYCUT_DATA_DIR=C:/temp/crab-data npm start
```
Phải thấy: `C:/temp/crab-data` mọc ra `temp_uploads/ asr_cache/ peaks_cache/ reports/
settings/ luts/ progress.txt`, và **không** có tệp nào mới sinh trong repo (kể cả
`library/` — nó phải ở nguyên `APP_ROOT` và không bị chạm).
Kiểm cụ thể 3 việc dễ vỡ nhất: nhập một LUT `.cube` (ghi vào `DATA_ROOT/luts`, phục vụ ở
`/library/luts/…`, và **không che** preset cùng tên), export một block có **chữ** (ffmpeg
phải đọc được font từ `APP_ROOT/static/fonts/google`), và chạy Auto-Reframe (sidecar Python
phải ghi vào `DATA_ROOT/temp_uploads`, không phải cạnh `asr/`).

Giai đoạn 2 (bỏ torch): xác nhận bằng cách gỡ torch khỏi môi trường rồi chạy
`npm run test:matching` + `test:script-reorder-align` — trước đây sẽ chết ở `import torch`,
sau khi sửa phải xanh.

Giai đoạn 3 (cổng động): mở app, xem `netstat` thấy cổng ngẫu nhiên; rồi chiếm sẵn 8000
bằng `node -e "require('http').createServer((q,s)=>s.end('hi')).listen(8000)"` và mở app —
app phải **vẫn mở đúng giao diện của mình**, không nạp trang lạ.

### Giai đoạn 4-5 — kiểm ngay tại máy build, trước khi đụng tới VM

```bash
npm run build:native && npm run prepare:dist && npx electron-builder --win --dir
```
Kiểm trên `dist/win-unpacked`:
- `resources/app/static/fonts/google/**/*.ttf` → **đúng 342 tệp** (italic đã bị loại).
- Không còn `*.obj`, `*.pdb`, `native/node_modules`, `node_modules/pixi.js`, `tests/`,
  `docs/`, `reports/`, `progress.txt`, `__pycache__`.
- `vendor/ffmpeg/bin/ffmpeg.exe -filters` chứa đủ `drawtext, lut3d, afftdn, anlmdn,
  dynaudnorm, loudnorm`; `-encoders` chứa `libx264` (hoặc `libopenh264` nếu chọn phương án LGPL).

**Phép thử giá trị nhất, và rẻ nhất — diễn tập thư mục chỉ-đọc:**
```bash
icacls dist\win-unpacked /deny "%USERNAME%":(W) /T
```
rồi chạy app. Bất kỳ phép ghi nào còn sót vào `APP_ROOT` sẽ **hỏng ầm ĩ ngay tại đây**, thay
vì hỏng trên máy khách hàng cài vào `Program Files`. Kỳ vọng: app mở được, backend chạy,
bóc băng chạy, export chạy, nhập LUT chạy. **Đây là phép thử phơi ra mọi chỗ tôi có thể đã
bỏ sót ở Giai đoạn 1.**

Rồi `CRABBYCUT_PACKAGED=1 node resources/app/backend/server.js` và xác nhận nó tạo
`%LOCALAPPDATA%\CrabbyCut\data\{temp_uploads,asr_cache,peaks_cache,reports,settings,luts}`
và **không tạo gì** trong `resources/app`.

### Giai đoạn 4-6 — phải kiểm trên máy sạch

Kiểm trên máy dev là **không đủ**: máy này đã có Python 3.12 với torch/whisper/flask,
ffmpeg ở `C:\ffmpeg\bin` trong PATH, và MSVC. Chính những thứ đó sẽ che đúng loại lỗi mà bộ
cài phải xử lý. Cần **máy ảo Windows 11 sạch** (snapshot lại để chạy nhiều lượt):

1. **Lượt cơ bản** — cài trên VM sạch, có mạng, không NVIDIA. Kỳ vọng: không UAC, các bước
   preflight đạt, tải `core`+`asr`+`vision` (~175 MB), tự kiểm tra xanh, app mở được, dựng
   được timeline, export được video có chữ. Đây là lượt chứng minh "chạy không lỗi gì".
2. **Lượt không mạng** — ba mức, vì chúng hỏng khác nhau:
   (a) rút cáp mạng; (b) DNS trỏ vào `127.0.0.1` (đường lỗi `ENOTFOUND` khác `ECONNREFUSED`);
   (c) **proxy cắt ngang** — chạy một proxy cục bộ trả 10 MB đầu của một pack rồi đóng, đặt
   làm proxy hệ thống. Đây là ca thực tế và khó chịu nhất (captive portal ở trường/công ty).
   Kỳ vọng: SHA-256 bắt được, tự thử lại từ 0, và thông báo cuối **nêu đích danh** nghi vấn
   proxy. Ở cả ba mức: interpreter Python **vẫn cài được** (vì nó nằm trong bộ cài), bộ cài
   vẫn **thành công**, app mở được, timeline/màu/**export vẫn chạy** (chúng chỉ cần
   `core_process.exe` + ffmpeg, không cần Python) — chỉ ASR/so khớp kịch bản/auto-reframe bị
   vô hiệu hoá **kèm lý do**, không nổ traceback Python.
   (d) giết app giữa lúc tải gói CUDA ở ~30%, mở lại → phải **tiếp từ ~30%**, không phải từ 0.
3. **Lượt có NVIDIA** — VM/máy có card. Kỳ vọng: preflight hiện tên card + VRAM, gói `cuda`
   được tự tích, và sau khi cài thì bóc băng chạy **trên GPU** (đối chiếu
   `windows_asr_device` trong `reports/report_project_*.txt` phải là cuda, và so thời gian
   với mốc 1.6 s vs 25.0 s đã ghi trong sidecar).
4. **Lượt đường dẫn có dấu và dấu cách** — cài vào `D:\Thư mục của tôi\CrabbyCut`, mở dự án
   có tên tiếng Việt. Đây là chỗ dễ vỡ nhất của cả ffmpeg filtergraph lẫn `PYTHONUTF8`
   (`scripts/python_command.js:19-34` ghi lại đúng loại lỗi này).
5. **Lượt Program Files** — chọn cài per-machine vào `C:\Program Files\CrabbyCut` để chứng
   minh việc tách `APP_ROOT`/`DATA_ROOT` thật sự đúng (đây là lượt sẽ phơi ra bất kỳ chỗ
   ghi vào app dir còn sót).
6. **Lượt gỡ cài** — gỡ rồi cài lại; kỳ vọng: dự án + cài đặt + runtime + model còn nguyên,
   lần cài thứ hai **không tải lại** 175 MB. Cài đè bản mới (đường `${isUpdated}`) phải
   **không hỏi** câu xoá runtime.
7. **Lượt tiến trình mồ côi** — bắt đầu một lượt export dài rồi đóng app. Task Manager phải
   còn **0** tiến trình `ffmpeg.exe`, `python.exe`, `core_process.exe`, `electron.exe`.
   Đây là phép kiểm cho phần sửa `taskkill /T` ở Giai đoạn 3.
8. **Lượt tranh cổng** — chạy `python -m http.server 8000` rồi mở app: app phải lấy cổng
   riêng và nạp **giao diện của chính nó**. Rồi chạy một tiến trình trả 200 cho mọi đường dẫn
   (`node -e "require('http').createServer((q,s)=>s.end('{}')).listen(8000)"`) — chữ ký
   `app:'crabbycut'` phải **từ chối** nó.
9. **Lượt người dùng thường (không phải admin)** — cài per-user không cần admin, và bước VC++
   (nếu thiếu) xin nâng quyền đúng lúc.
10. **Lượt driver NVIDIA cũ** — giả lập `nvidia-smi` trả `driver_version 511.23`. Cổng driver
    phải **mời dùng CPU** thay vì cài một cuBLAS chắc chắn sẽ chết giữa phiên bóc băng.

### Giai đoạn 7-8 — kiểm tự cập nhật

Không thể kiểm updater bằng bản chạy từ mã nguồn (electron-updater từ chối chạy khi app
chưa đóng gói), nên:

1. Đặt `dev-app-update.yml` trỏ tới repo release để chạy thử lượt **kiểm tra** mà chưa cần cài.
2. Phát hành **1.1.1** lên `CrabbyCut-releases`, cài trên VM sạch, thiết lập môi trường xong.
3. Phát hành **1.1.2** (chỉ đổi một dòng chữ để dễ nhận biết).
4. Mở app 1.1.1 trên VM → phải thấy tuần tự: toast "Đã có CrabbyCut 1.1.2" → thanh tải →
   "Khởi động lại để cập nhật". Bấm vào phải đi qua hộp thoại "Còn thay đổi chưa lưu" nếu
   dự án đang bẩn — **đây là ca dễ mất dữ liệu nhất, phải thử cả 3 nhánh Lưu/Không lưu/Huỷ**.
5. Sau khi cập nhật, xác nhận **không bị tải lại** môi trường Python và model: mở Cài đặt
   thấy 1.1.2, bóc băng chạy ngay không cần tải gì, LUT tự nhập vẫn còn, dự án gần đây vẫn còn.
6. Thử ca chen ngang: bắt đầu một lượt export dài rồi ép kiểm tra cập nhật — phải **không**
   mời khởi động lại giữa lúc đang export.

Trong mỗi lượt, `reports/report_project_*.txt` là công cụ chẩn đoán có sẵn — nó đã ghi
`<HARDWARE>` (os/cpu/gpu/vram/cuda/arch) và toàn bộ trường `windows_asr_*`, nên chỉ cần đọc
báo cáo là biết môi trường đã dựng đúng chưa.

---

## Rủi ro

| Rủi ro | Mức | Xử lý |
|---|---|---|
| **Không ký số → SmartScreen + antivirus** | **Cao** (trải nghiệm) | Không có cách nào bằng mã. `core_process.exe` không ký, spawn `cmd.exe` → `ffmpeg.exe` là dấu hiệu heuristic kinh điển, Defender có thể cách ly. Đây sẽ là nguồn hỗ trợ lớn hơn mọi hạng mục kỹ thuật cộng lại. Xem mục Ký số. |
| Sót một chỗ ghi vào `APP_ROOT` → chết trong `Program Files` | **Cao** | Diễn tập `icacls /deny (W)` ở Giai đoạn 4-5 phơi ra ngay tại máy build; cộng lượt VM #5 |
| Giấy phép GPL của ffmpeg/x264/x265 | **Cao** nếu thương mại | Chọn phương án (a) có xác nhận pháp lý hoặc (b) chuyển LGPL + `libopenh264` |
| Vượt mục tiêu kích thước (~276 MB so với 200–250 MB) | Trung bình | Đã nêu 3 đòn bẩy ở 5b; khuyến nghị chấp nhận hoặc lấy đòn bẩy 1 |
| Wheel Python cần `MSVCP140.dll` mà máy không có | Trung bình | Nhúng redist + kiểm registry; binary của mình đã link tĩnh nên không liên quan |
| Bản ffmpeg *shared* thiếu DLL / bị AV cách ly | Trung bình | `prepare_dist.js` kiểm lúc build, preflight kiểm lại lúc cài |
| Antivirus quét 1.2 GB DLL mới giải nén (cuBLAS rất lớn) | Trung bình | Không tự thêm exclusion (cần admin, tư thế bảo mật xấu); ghi vào tài liệu xử lý sự cố, và log thiết lập phải nói rõ khi giải nén hỏng vì sharing violation |
| 1.2 GB + 1.6 GB **cho mỗi người dùng** trên máy dùng chung | Thấp–TB | Không có giải pháp tốt (runtime dùng chung trong Program Files thì người dùng thường không ghi được lúc chạy đầu). Ghi vào tài liệu; cân nhắc tuỳ chọn "đường runtime dùng chung" về sau |
| `mediapipe==0.10.21` buộc dính Python 3.12 | Thấp–TB | `runtime-spec.js` phải **khẳng định** phiên bản interpreter — biến một điều bí ẩn thành một thông báo |
| `core_logic.py` dùng chung nhánh Mac → xung đột merge | Thấp | Trên Apple Silicon **không một sửa đổi nào chạm tới** (`get_detailed_hardware_info` return ở :151-153, `get_system_config` ở :177-178, `transcribe_audio` đi nhánh `mlx_whisper`) → no-op thuần. Ghi chú trong `docs/TIMELINE_PORT_WIN_TO_MAC.md` |
| Máy dev đang **thiếu** `faster_whisper`/`ctranslate2`/`cv2`/`mediapipe` | Trung bình | Phải dựng được môi trường 3.12 đầy đủ **trước** khi dựng pack, nếu không không có gì để kiểm thử |

**Những thứ tôi cho là không nên/không thể làm:**
- **Nhúng model Whisper 1.6 GB vào bộ cài** — bạn đã quyết không; ghi lại cho rõ: bộ cài
  1.9 GB cộng thế đứng về giấy phép/phân phối lại của HF làm phương án này bất khả.
- **Ép bộ cài xuống dưới ~200 MB mà vẫn nhúng `library/` + ffmpeg shared + interpreter** —
  sàn là Electron ~85 + ffmpeg ~48 + library ~56 = **189 MB trước một byte font nào**.
- **Một lệnh `pip install` chạy đúng trên mọi máy mà không cần compiler** — đó chính là thứ
  các pack tồn tại để tránh.
- **Làm cả app chạy được với zero Python** — timeline/màu/âm thanh/export thì được (chúng là
  `core_process.exe` + ffmpeg), nhưng ASR, so khớp kịch bản và auto-reframe/retouch là
  Python-only. Nên **nói thật** điều đó trong UI thiết lập thay vì suy giảm âm thầm.
