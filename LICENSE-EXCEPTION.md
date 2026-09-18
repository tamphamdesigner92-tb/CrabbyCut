# Additional permission under GNU GPL version 3 section 7

*(Bản tiếng Việt ở cuối trang — the Vietnamese text below is a courtesy translation;
the English text above is the operative one.)*

Copyright © 2026 Tam Pham <tampham.designer92@gmail.com>

CrabbyCut is licensed under the GNU General Public License, version 3 or (at your
option) any later version. See [`LICENSE`](LICENSE).

## Grant

As a special exception, Tam Pham, the copyright holder of CrabbyCut, gives you permission to
combine CrabbyCut with, link CrabbyCut against, and distribute CrabbyCut together
with the software listed under **Covered components** below, whose licenses are not
compatible with the GNU GPL, and to convey the resulting work.

You must obey the GNU GPL in all respects for all of the code used other than the
components listed below. If you modify this file, you may extend this exception to
your version of the file, but you are not obligated to do so. If you do not wish to
do so, delete this exception statement from your version.

## Covered components

### 1. NVIDIA CUDA runtime libraries

Distributed by NVIDIA Corporation under the NVIDIA Software License Agreement
(`LicenseRef-NVIDIA-Proprietary`), including but not limited to:

| Package | Purpose in CrabbyCut |
|---|---|
| `nvidia-cublas-cu12` | cuBLAS, loaded at run time by CTranslate2 for GPU transcription |
| `nvidia-cuda-nvrtc-cu12` | Pulled in as a dependency of the above |

**Why this exception is needed.** On Windows, CTranslate2 (MIT) loads `cublas64_12.dll`
from `PATH` at run time when a CUDA device is available. Without cuBLAS present,
transcription fails mid-run with `Library cublas64_12.dll is not found` while every
capability probe still reports CUDA as ready. CrabbyCut itself contains no CUDA source
code and never calls the CUDA API directly.

**How CrabbyCut obtains these libraries.** CrabbyCut does **not** redistribute them.
They are fetched by `pip` from PyPI onto the end user's machine during the on-demand
setup step (see `scripts/setup_runtime.js`), and only when an NVIDIA GPU is detected.
This exception exists to remove any doubt about the resulting combination, not because
CrabbyCut ships NVIDIA software.

### 2. Operating system components

The standard system libraries of Microsoft Windows and macOS, including the Microsoft
Visual C++ Runtime (`msvcp140.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`), which
OpenCV and MediaPipe load at import time.

This is ordinarily covered by the GPL's own **System Libraries** exception
(GPLv3 section 1); it is restated here only for clarity.

## What this exception does NOT cover

- It does **not** permit combining CrabbyCut with any other proprietary software.
- It does **not** permit distributing CrabbyCut in a form where the corresponding
  source of the GPL-covered parts is withheld.
- It does **not** apply to media assets. Fonts, music, sound effects, video and image
  assets carry their own licenses; see [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)
  and `library/README.md`.

---

# Bản dịch tiếng Việt (tham khảo)

## Nội dung cho phép thêm

Theo điều 7 của GNU GPL phiên bản 3, Tam Pham — chủ sở hữu bản quyền CrabbyCut — cho phép bạn kết
hợp, liên kết và phân phối CrabbyCut cùng với các thành phần liệt kê dưới đây — những
thành phần có giấy phép không tương thích với GNU GPL — và phân phối tác phẩm kết hợp
thu được.

Bạn vẫn phải tuân thủ GNU GPL với **toàn bộ phần mã còn lại**.

## Thành phần được miễn trừ

**1. Thư viện CUDA của NVIDIA** — `nvidia-cublas-cu12`, `nvidia-cuda-nvrtc-cu12`, phát
hành theo giấy phép độc quyền của NVIDIA.

*Vì sao cần:* trên Windows, CTranslate2 (giấy phép MIT) nạp `cublas64_12.dll` theo
`PATH` lúc chạy khi máy có GPU. Thiếu nó thì việc bóc băng chết **giữa chừng** với
thông báo `Library cublas64_12.dll is not found`, trong khi mọi phép thăm dò vẫn báo
CUDA sẵn sàng. Bản thân CrabbyCut không chứa mã CUDA nào và không gọi thẳng API CUDA.

*Cách CrabbyCut có được chúng:* CrabbyCut **không phân phối lại** hai gói này. Chúng do
`pip` tải từ PyPI về máy người dùng cuối trong bước thiết lập theo yêu cầu (xem
`scripts/setup_runtime.js`), và chỉ khi phát hiện có GPU NVIDIA. Điều khoản này tồn tại
để xoá vùng xám về mặt pháp lý, không phải vì CrabbyCut có mang theo phần mềm NVIDIA.

**2. Thành phần của hệ điều hành** — thư viện hệ thống chuẩn của Windows và macOS, gồm
Microsoft Visual C++ Runtime mà OpenCV và MediaPipe nạp lúc import. Phần này vốn đã
thuộc ngoại lệ "System Libraries" của chính GPLv3 (điều 1); nhắc lại ở đây cho rõ.

## Điều khoản này KHÔNG bao gồm

- Không cho phép kết hợp CrabbyCut với bất kỳ phần mềm độc quyền nào khác.
- Không cho phép phân phối CrabbyCut mà giấu mã nguồn của các phần thuộc GPL.
- Không áp dụng cho tài nguyên media. Font, nhạc, hiệu ứng âm thanh, video và hình ảnh
  có giấy phép riêng — xem `THIRD-PARTY-NOTICES.md` và `library/README.md`.
