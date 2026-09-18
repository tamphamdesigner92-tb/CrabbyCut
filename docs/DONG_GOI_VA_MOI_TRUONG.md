# Đóng gói bản cài đặt và thiết lập môi trường tự động

Tài liệu này mô tả bộ cài `.exe` của CrabbyCut trên Windows: nó đóng gói những gì, và nó
dựng môi trường chạy trên máy người dùng như thế nào.

## 1. Vì sao cần một bước thiết lập riêng

Bản đóng gói mang theo toàn bộ mã nguồn, giao diện, thư viện Node, native addon và C++
sidecar. Nó **không** mang theo hai thứ:

- **Môi trường Python.** `.venv/` gắn cứng đường dẫn tuyệt đối của máy dựng, chép sang máy
  khác là hỏng. Ngoài ra nó nặng ~2,6 GB — nhét vào installer thì mỗi bản cập nhật app
  (vài chục MB mã nguồn) cũng bắt người dùng tải lại toàn bộ.
- **FFmpeg.** Toàn bộ backend gọi `ffmpeg`/`ffprobe` bằng tên trần, trông chờ vào PATH của
  máy. Máy dev có sẵn nên chưa bao giờ lộ ra.

Bản cài đầu tiên (không có bước thiết lập) vì thế mở được giao diện nhưng mọi thứ chạm tới
Python đều chết với `spawn python ENOENT`.

## 2. Hai tầng: lõi khi cài, thư viện AI khi dùng

Bước cài đặt **không** tải thư viện AI. Cài hết một cục thì người dùng phải chờ ~2,6 GB
trước khi nhìn thấy ứng dụng lần đầu — đo thật trên mạng chậm là hàng giờ. Mà phần lớn số đó
không cần để mở app: dựng phim, cắt ghép, xem trước và xuất video chạy bằng Node + FFmpeg +
C++ sidecar, **không đụng tới Python một dòng nào**.

| Tầng | Gồm gì | Khi nào | Đo được |
|---|---|---|---|
| **Lõi** | Python 3.12 nhúng + pip + FFmpeg | Lúc chạy bộ cài | **3,1 phút / 32 MB** (máy đã có FFmpeg) |
| `script` | rapidfuzz, pydub, torch (CPU), openai-whisper | Lần đầu Lọc/Sắp xếp theo kịch bản | ~450 MB |
| `asr` | faster-whisper, ctranslate2, huggingface-hub (+ nvidia-cublas-cu12 nếu có GPU NVIDIA) | Lần đầu Bóc băng | ~350 MB / ~770 MB có GPU |
| `vision` | opencv-contrib-python, numpy, mediapipe | Lần đầu Auto-Reframe / Retouch | ~400 MB |

Máy chưa có FFmpeg thì tầng lõi cộng thêm ~180 MB.

```
CrabbyCut Setup.exe
  └─ NSIS chép tệp vào %LOCALAPPDATA%\Programs\CrabbyCut
  └─ build/installer.nsh :: customInstall
       └─ ExecWait "CrabbyCut.exe --setup-runtime"      ← chờ ở đây
            └─ electron/setup-window.js  (cửa sổ tiến độ)
                 └─ scripts/setup_runtime.js :: setupRuntime()
                      ├─ scripts/detect_machine.js   dò cấu hình
                      ├─ tải + cài Python 3.12 nhúng
                      ├─ cài pip
                      ├─ tải + cài FFmpeg (nếu máy chưa có bản đủ filter)
                      └─ kiểm lại: Python chạy được? FFmpeg chạy được?

... về sau, lần đầu người dùng bấm một tính năng cần Python:

backend/server.js :: runPythonSidecar({ feature: 'asr' })
  └─ ensureFeatureInstalled('asr')
       └─ scripts/setup_runtime.js :: installFeature('asr')
            ├─ requirementsForFeature() lọc requirements.txt còn đúng gói của nhóm
            ├─ pip install (torch lấy từ index CPU nếu nhóm có torch)
            ├─ import THẬT từng module để xác nhận
            └─ RuntimePaths.markFeature('asr', {installed: true})
```

Tiến độ tải đi ra bằng `setStatus()` — kênh mà giao diện **vốn đã** đọc qua `/api/status`.
Nhờ vậy không phải sửa một dòng nào trong `index.html`: người dùng thấy
`Đang tải faster-whisper — 45 MB / 420 MB` ngay tại chỗ vẫn hiện thông báo tiến độ.

Hai chốt chặn quan trọng:

- **`probe` không kích hoạt tải.** Mỗi lần giao diện mở bảng ASR là một lượt `probe` chỉ để
  hỏi "máy này chạy được model nào". Tải 420 MB vì một cú mở bảng là điều cuối cùng người
  dùng mong đợi — và nhánh đó đã có sẵn đường suy giảm êm khi thiếu gói.
- **Một lượt cài mỗi nhóm.** Bấm Bóc băng hai lần liên tiếp mà không khoá thì hai tiến trình
  pip cùng ghi vào một `site-packages`, hỏng gói một cách ngẫu nhiên và rất khó truy.
  `featureInstallLocks` cho người đến sau chờ chung kết quả.
- **Chỉ áp dụng khi chạy bằng môi trường do bộ cài dựng.** Chạy từ mã nguồn thì interpreter
  là `.venv` của dự án; đụng vào vừa vô ích vừa nguy hiểm. `usingProvisionedRuntime()` so
  đường dẫn interpreter để phân biệt hai đường chạy.

Mã thoát của `--setup-runtime`, do `electron/main.js` quy định và `installer.nsh` đọc:

| Mã | Ý nghĩa |
|----|---------|
| 0 | Môi trường đầy đủ |
| 2 | Cài xong nhưng thiếu vài thành phần (ví dụ người dùng từ chối UAC của Visual C++) |
| khác | Hỏng hoặc bị huỷ |

**Không mã nào làm hỏng lượt cài đặt.** App tự kiểm lại môi trường ở mỗi lần mở
(`ensureRuntimeReady()` trong `electron/main.js`) và mở lại cửa sổ thiết lập khi cần. Chặn
lượt cài ở đây chỉ để lại một máy không có app lẫn không có môi trường.

Lượt cài im lặng (`/S`, triển khai hàng loạt) **bỏ qua** bước này — cửa sổ thiết lập cần
người bấm khi có lỗi, mở nó trong một lượt cài không người trông là `ExecWait` treo vĩnh
viễn. App sẽ tự chạy thiết lập ở lần mở đầu tiên.

## 3. Cấu hình máy quyết định tải gì

`scripts/detect_machine.js` không dò cho vui — mỗi phép dò gắn với một nhánh cài đặt thật:

| Dò được | Quyết định |
|---------|-----------|
| GPU NVIDIA (qua `nvidia-smi`) | Có cài `nvidia-cublas-cu12` hay không (~420 MB). Thiếu nó trên máy có GPU thì ctranslate2 chết **giữa** phiên bóc băng với `cublas64_12.dll is not found`, trong khi mọi phép thăm dò vẫn báo CUDA sẵn sàng. |
| FFmpeg của máy | Dùng lại nếu **đủ filter**, nếu không thì tải bản riêng (~180 MB). Chỉ `ffmpeg -version` chạy được là chưa đủ: build thiếu `zscale` vẫn qua được phép kiểm rồi chết lúc export. |
| Visual C++ Runtime | `mediapipe`/`opencv` nạp `msvcp140.dll` ngay lúc import. Máy Windows sạch thường không có, và lỗi hiện ra là `DLL load failed while importing cv2` — không hề nhắc tới VC++. |
| Đĩa trống | Báo trước thay vì chết giữa chừng lúc pip đã tải 1,5 GB. Ngưỡng 6 GB. |
| Kiến trúc CPU | Từ chối sớm nếu không phải x64. |

## 4. Vì sao dùng Python nhúng thay vì Python của máy

Hai lý do, cả hai đều đã thành sự thật ở dự án này:

1. Cài gói vào Python của người dùng là làm bẩn môi trường họ đang dùng cho việc khác, và
   rước nguyên một lớp xung đột phiên bản mà ta không kiểm soát được.
2. `requirements.txt` ghim `mediapipe==0.10.21` + `opencv-contrib-python<4.12` kèm marker
   `python_version < "3.13"`. Máy mặc định 3.13/3.14 thì `pip install` vẫn **báo thành
   công**, chỉ lặng lẽ bỏ qua hai gói đó, rồi Auto-Reframe chết sau với
   `No module named 'cv2'`.

Phiên bản được ghim cứng ở `PYTHON_VERSION` trong `scripts/setup_runtime.js`. Muốn nâng thì
phải nâng cả `PYTHON_MAX_EXCLUSIVE` ở `scripts/python_requirements.js` và kiểm lại
mediapipe/opencv đã có wheel chưa.

Một chi tiết dễ sập: bản nhúng mặc định **không thấy** `site-packages`. File
`python312._pth` chốt cứng `sys.path` và để `import site` ở dạng chú thích. Giữ nguyên thì
pip cài xong, gói nằm đúng chỗ, mà `import faster_whisper` vẫn báo không tìm thấy — không
có thông báo nào nhắc tới `._pth`. `stagePython()` ghi đè file này.

## 5. torch bản CPU

`requirements.txt` ghi `torch` trần, và bản mặc định trên PyPI cho Windows là bản CUDA
(~2,5 GB). Đường ASR trên Windows chạy bằng `faster-whisper`/`ctranslate2` chứ **không**
dùng torch — torch chỉ có mặt vì `core_logic.py` import nó ở top-level.

`stagePackages()` vì thế cài torch **trước** từ index CPU của PyTorch, rồi mới chạy
`-r requirements.txt`; tới lượt đó pip thấy `torch` đã thoả và bỏ qua. Tiết kiệm ~2,3 GB.

GPU vẫn được dùng cho bóc băng — qua `nvidia-cublas-cu12` + ctranslate2, không qua torch.

## 6. Vị trí và vòng đời

| Thứ | Nơi đặt |
|-----|---------|
| Ứng dụng | `%LOCALAPPDATA%\Programs\CrabbyCut` |
| Môi trường | `%LOCALAPPDATA%\CrabbyCut\runtime` |
| Nhật ký thiết lập | `%LOCALAPPDATA%\CrabbyCut\runtime\setup.log` |
| Manifest | `%LOCALAPPDATA%\CrabbyCut\runtime\runtime.json` |

Môi trường nằm **ngoài** thư mục cài đặt vì electron-builder xoá sạch thư mục đó mỗi lần
nâng cấp phiên bản. Tách ra thì môi trường sống qua được mọi lần cập nhật app.

Trình gỡ cài đặt **hỏi** trước khi xoá môi trường (mặc định là giữ): gỡ để cài lại bản mới
là việc rất thường, giữ lại thì lần sau không phải tải lại.

Cài đặt ở chế độ **per-user** (`nsis.perMachine: false`), không phải Program Files. Đây là
ràng buộc bắt buộc: backend ghi `temp_uploads/`, `asr_cache/`, `proxy_cache/`,
`concat_cache/`, `peaks_cache/`, `reports/`, `settings/` ngay trong thư mục cài đặt. Đưa vào
Program Files thì các thư mục này không ghi được và app hỏng.

## 7. Bẫy `spawn python ENOENT`

Nguyên nhân gốc của lỗi ở bản cài 1.1.8, đã xử lý trong `scripts/python_command.js`.

`spawn('python')` trên Windows đi qua phép dò PATH của libuv, và phép dò đó **dừng ở file
đầu tiên trùng tên** rồi gọi `CreateProcess`. Nếu file đó không chạy được, libuv trả
`ENOENT` và **không tìm tiếp**.

Trên máy gặp lỗi, PATH còn sót
`C:\Users\<tài khoản khác>\AppData\Local\Microsoft\WindowsApps`. Thư mục đó chứa
`python.exe` là App Execution Alias — reparse point 0 byte thuộc hồ sơ của tài khoản khác,
tài khoản hiện tại không thực thi được. Máy có sẵn Python 3.11 và 3.12 cài đàng hoàng,
`where python` liệt kê đủ, nhưng spawn vẫn `ENOENT`.

Cách xử lý: `pythonCommand()` không bao giờ trả về tên trần nữa. Nó tự duyệt PATH, **bỏ qua
file 0 byte** (alias luôn 0 byte, interpreter thật cả trăm KB) và trả về đường dẫn tuyệt
đối. Thứ tự ưu tiên:

1. `CRAB_PYTHON` (ghi đè thủ công, dùng khi gỡ lỗi)
2. `.venv/` của dự án — chạy từ mã nguồn
3. Môi trường do bộ cài dựng — máy người dùng cuối
4. Duyệt PATH an toàn

## 8. Bẫy "treo ở 49%"

Đã gặp thật trong lúc chạy thử: cửa sổ thiết lập đứng nguyên ở
`Đang tải nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl` (gói 420 MB) hàng chục phút.
Đo được lúc đó: file `.whl` đứng ở **0 byte**, và **không còn một kết nối TCP nào** từ tiến
trình CrabbyCut. Kết nối tới PyPI đã chết sau khi bắt tay xong, còn pip thì ngồi chờ mãi.

Ba nguyên nhân độc lập, đã xử lý cả ba:

| Nguyên nhân | Cách xử lý |
|---|---|
| pip mặc định chỉ đặt hạn 15 giây cho lượt **kết nối**; socket chết **sau** khi đã bắt tay thì không ai tính giờ | `--timeout 30` áp hạn cho cả lượt đọc, `--retries 5` để nối lại |
| pip **chỉ vẽ thanh tiến độ khi stdout là terminal**. Ở đây stdout là ống dẫn nên pip im lặng hoàn toàn suốt lượt tải 420 MB — người dùng không có cách nào phân biệt "chậm" với "chết" | `--progress-bar raw` in ra `Progress <đã tải> of <tổng>` dạng văn bản thuần, đọc được qua ống dẫn |
| Không có lưới đỡ nào khi pip treo kiểu không thể phục hồi | Đồng hồ chết đứng trong `runStreaming()`: im lặng quá 5 phút thì giết tiến trình con, và `pipInstallWithRetry()` chạy lại (tối đa 3 lần) |

Ngưỡng 5 phút được chọn rộng rãi có chủ ý: giải nén torch hoặc biên dịch `openai-whisper`
im lặng vài phút vẫn là bình thường.

Lượt thử lại rất rẻ vì `PIP_CACHE_DIR` trỏ vào `runtime/pip-cache`: mọi wheel đã tải xong
đều còn đó, pip bỏ qua chúng và đi thẳng tới gói đang dở.

## 9. Chạy tay

```bash
npm run detect:machine     # in cấu hình máy dưới dạng JSON
npm run setup:runtime      # dựng môi trường, in NDJSON tiến độ
```

Đóng gói:

```bash
npx electron-builder --win --config.directories.output=<thư mục ngoài dự án>
```

## 10. Những gì bộ cài **không** bảo đảm

- **Cần mạng.** Bước thiết lập tải hơn 1 GB từ python.org, PyPI, GitHub và
  download.pytorch.org. Máy trong mạng công ty chặn các nguồn này sẽ thất bại — nhật ký ở
  `setup.log` ghi rõ URL nào hỏng.
- **Model ASR tải riêng.** Bộ cài dựng môi trường chạy được `faster-whisper`; bản thân
  model (`distil-large-v3`…) vẫn tải ở trong app như trước, qua nút "Cài model".
- **Visual C++ Runtime cần quyền quản trị.** Người dùng bấm "No" ở UAC thì Auto-Reframe và
  Retouch sẽ thiếu `cv2`/`mediapipe`; phần dựng phim và bóc băng vẫn chạy. Cửa sổ thiết lập
  báo rõ phần nào thiếu thay vì im lặng.
