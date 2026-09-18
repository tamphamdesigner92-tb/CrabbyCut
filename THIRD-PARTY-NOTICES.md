# Ghi công phần mềm của bên thứ ba

CrabbyCut phát hành theo **GNU General Public License v3.0 hoặc mới hơn** — xem
[`LICENSE`](LICENSE) và [`LICENSE-EXCEPTION.md`](LICENSE-EXCEPTION.md).

Tài liệu này liệt kê phần mềm của bên thứ ba mà CrabbyCut **đóng gói hoặc cài đặt**, kèm
giấy phép của chúng. Bản quyền của từng thành phần thuộc về tác giả tương ứng.

> Tệp này được **sinh tự động** bởi `scripts/generate_third_party_notices.js`.
> Đừng sửa tay — sửa script rồi chạy `npm run notices`.
> Sinh lúc: 2026-09-18T04:31:00.551Z


## 1. FFmpeg

CrabbyCut **không liên kết** thư viện FFmpeg. Nó chạy `ffmpeg` và `ffprobe` như **tiến
trình riêng** qua dòng lệnh (xem `native/sidecar/core_process.cpp` — chỉ `#include`
header chuẩn của C++ và `<windows.h>`, không có `libavcodec`/`libavformat`).

Nếu máy người dùng chưa có bản FFmpeg đủ filter, bước thiết lập tải build sau về:

- **Bản dựng:** `ffmpeg-master-latest-win64-gpl` của BtbN
- **Trang phát hành:** https://github.com/BtbN/FFmpeg-Builds/releases
- **Mã nguồn bộ dựng:** https://github.com/BtbN/FFmpeg-Builds
- **Mã nguồn FFmpeg:** https://github.com/FFmpeg/FFmpeg
- **Giấy phép:** GPL-3.0-or-later (build này bật `--enable-gpl --enable-version3`)

Electron cũng kèm `ffmpeg.dll` bản LGPL của riêng nó; xem `LICENSE.electron.txt` và
`LICENSES.chromium.html` trong thư mục cài đặt.

## 2. Electron, Chromium, Node.js

Bản cài đặt được dựng trên Electron (MIT), bao gồm Chromium và Node.js với tập giấy phép
riêng của chúng. Văn bản đầy đủ nằm cạnh tệp thực thi sau khi cài:
`LICENSE.electron.txt` và `LICENSES.chromium.html`.

## 3. Python

Bước thiết lập tải bản Python nhúng chính thức từ python.org, phát hành theo
**PSF License Agreement** — https://docs.python.org/3/license.html


## 4. Gói npm được đóng gói (144)

Chỉ tính phụ thuộc `production`. `devDependencies` (electron-builder, node-gyp…) không
đi kèm bản phát hành.

### Tổng hợp theo giấy phép

| Giấy phép | Số gói |
|---|---|
| MIT | 130 |
| ISC | 5 |
| BSD-2-Clause | 4 |
| BSD-3-Clause | 2 |
| BSD | 1 |
| (MIT OR GPL-3.0-or-later) | 1 |
| (MIT AND Zlib) | 1 |

### Danh sách đầy đủ

| Gói | Phiên bản | Giấy phép |
|---|---|---|
| [@pixi/accessibility](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/app](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/assets](https://github.com/pixijs/pixijs#readme) | 7.4.3 | MIT |
| [@pixi/color](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/colord](omgovich/colord) | 2.9.6 | MIT |
| [@pixi/compressed-textures](https://github.com/pixijs/pixijs#readme) | 7.4.3 | MIT |
| [@pixi/constants](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/core](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/display](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/events](https://github.com/pixijs/pixijs#readme) | 7.4.3 | MIT |
| [@pixi/extensions](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/extract](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/filter-alpha](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/filter-blur](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/filter-color-matrix](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/filter-displacement](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/filter-fxaa](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/filter-noise](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/graphics](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/math](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/mesh](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/mesh-extras](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/mixin-cache-as-bitmap](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/mixin-get-child-by-name](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/mixin-get-global-position](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/particle-container](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/prepare](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/runner](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/settings](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/sprite](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/sprite-animated](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/sprite-tiling](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/spritesheet](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/text](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/text-bitmap](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/text-html](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/ticker](http://pixijs.com/) | 7.4.3 | MIT |
| [@pixi/utils](http://pixijs.com/) | 7.4.3 | MIT |
| [@types/css-font-loading-module](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/css-font-loading-module) | 0.0.12 | MIT |
| [@types/earcut](https://github.com/DefinitelyTyped/DefinitelyTyped/tree/master/types/earcut) | 2.1.4 | MIT |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | 0.8.13 | MIT |
| [accepts](jshttp/accepts) | 2.0.0 | MIT |
| [append-field](http://github.com/LinusU/node-append-field) | 1.0.0 | MIT |
| [argparse](nodeca/argparse) | 1.0.10 | MIT |
| [base64-js](https://github.com/beatgammit/base64-js) | 1.5.1 | MIT |
| [bluebird](https://github.com/petkaantonov/bluebird) | 3.4.7 | MIT |
| [body-parser](expressjs/body-parser) | 2.2.2 | MIT |
| [buffer-from](LinusU/buffer-from) | 1.1.2 | MIT |
| [busboy](http://github.com/mscdex/busboy) | 1.6.0 | MIT |
| [bytes](visionmedia/bytes.js) | 3.1.2 | MIT |
| [call-bind-apply-helpers](https://github.com/ljharb/call-bind-apply-helpers#readme) | 1.0.2 | MIT |
| [call-bound](https://github.com/ljharb/call-bound#readme) | 1.0.4 | MIT |
| [concat-stream](http://github.com/maxogden/concat-stream) | 2.0.0 | MIT |
| [content-disposition](jshttp/content-disposition) | 1.1.0 | MIT |
| [content-type](jshttp/content-type) | 1.0.5 | MIT |
| [cookie](jshttp/cookie) | 0.7.2 | MIT |
| [cookie-signature](https://github.com/visionmedia/node-cookie-signature) | 1.2.2 | MIT |
| [core-util-is](git://github.com/isaacs/core-util-is) | 1.0.3 | MIT |
| [debug](git://github.com/debug-js/debug) | 4.4.3 | MIT |
| [depd](dougwilson/nodejs-depd) | 2.0.0 | MIT |
| [dingbat-to-unicode](https://github.com/mwilliamson/dingbat-to-unicode#readme) | 1.0.1 | BSD-2-Clause |
| [duck](https://github.com/mwilliamson/duck.js) | 0.1.12 | BSD |
| [dunder-proto](https://github.com/es-shims/dunder-proto#readme) | 1.0.1 | MIT |
| [earcut](git://github.com/mapbox/earcut) | 2.2.4 | ISC |
| [ee-first](jonathanong/ee-first) | 1.1.1 | MIT |
| [encodeurl](pillarjs/encodeurl) | 2.0.0 | MIT |
| [es-define-property](https://github.com/ljharb/es-define-property#readme) | 1.0.1 | MIT |
| [es-errors](https://github.com/ljharb/es-errors#readme) | 1.3.0 | MIT |
| [es-object-atoms](https://github.com/ljharb/es-object-atoms#readme) | 1.1.2 | MIT |
| [escape-html](component/escape-html) | 1.0.3 | MIT |
| [etag](jshttp/etag) | 1.8.1 | MIT |
| [eventemitter3](git://github.com/primus/eventemitter3) | 4.0.7 | MIT |
| [express](https://expressjs.com/) | 5.2.1 | MIT |
| [finalhandler](pillarjs/finalhandler) | 2.1.1 | MIT |
| [forwarded](jshttp/forwarded) | 0.2.0 | MIT |
| [fresh](jshttp/fresh) | 2.0.0 | MIT |
| [function-bind](https://github.com/Raynos/function-bind) | 1.1.2 | MIT |
| [get-intrinsic](https://github.com/ljharb/get-intrinsic#readme) | 1.3.0 | MIT |
| [get-proto](https://github.com/ljharb/get-proto#readme) | 1.0.1 | MIT |
| [gopd](https://github.com/ljharb/gopd#readme) | 1.2.0 | MIT |
| [has-symbols](https://github.com/ljharb/has-symbols#readme) | 1.1.0 | MIT |
| [hasown](https://github.com/inspect-js/hasOwn#readme) | 2.0.4 | MIT |
| [http-errors](jshttp/http-errors) | 2.0.1 | MIT |
| [iconv-lite](https://github.com/pillarjs/iconv-lite) | 0.7.2 | MIT |
| [immediate](git://github.com/calvinmetcalf/immediate) | 3.0.6 | MIT |
| [inherits](git://github.com/isaacs/inherits) | 2.0.4 | ISC |
| [ipaddr.js](git://github.com/whitequark/ipaddr.js) | 1.9.1 | MIT |
| [is-promise](https://github.com/then/is-promise) | 4.0.0 | MIT |
| [isarray](https://github.com/juliangruber/isarray) | 1.0.0 | MIT |
| [ismobilejs](https://github.com/kaimallea/isMobile) | 1.1.1 | MIT |
| [jszip](https://github.com/Stuk/jszip) | 3.10.1 | (MIT OR GPL-3.0-or-later) |
| [lie](https://github.com/calvinmetcalf/lie) | 3.3.0 | MIT |
| [lop](https://github.com/mwilliamson/lop) | 0.4.2 | BSD-2-Clause |
| [mammoth](https://github.com/mwilliamson/mammoth.js) | 1.12.0 | BSD-2-Clause |
| [math-intrinsics](https://github.com/es-shims/math-intrinsics#readme) | 1.1.0 | MIT |
| [media-typer](jshttp/media-typer) | 1.1.0 | MIT |
| [merge-descriptors](sindresorhus/merge-descriptors) | 2.0.0 | MIT |
| [mime-db](jshttp/mime-db) | 1.54.0 | MIT |
| [mime-types](jshttp/mime-types) | 3.0.2 | MIT |
| [ms](vercel/ms) | 2.1.3 | MIT |
| [multer](expressjs/multer) | 2.1.1 | MIT |
| [negotiator](jshttp/negotiator) | 1.0.0 | MIT |
| [node-addon-api](https://github.com/nodejs/node-addon-api) | 8.8.0 | MIT |
| [object-inspect](https://github.com/inspect-js/object-inspect) | 1.13.4 | MIT |
| [on-finished](jshttp/on-finished) | 2.4.1 | MIT |
| [once](git://github.com/isaacs/once) | 1.4.0 | ISC |
| [option](https://github.com/mwilliamson/node-options) | 0.2.4 | BSD-2-Clause |
| [pako](https://github.com/nodeca/pako) | 1.0.11 | (MIT AND Zlib) |
| [parseurl](pillarjs/parseurl) | 1.3.3 | MIT |
| [path-is-absolute](sindresorhus/path-is-absolute) | 1.0.1 | MIT |
| [path-to-regexp](https://github.com/pillarjs/path-to-regexp) | 8.4.2 | MIT |
| [pixi.js](http://www.pixijs.com/) | 7.4.3 | MIT |
| [process-nextick-args](https://github.com/calvinmetcalf/process-nextick-args) | 2.0.1 | MIT |
| [proxy-addr](jshttp/proxy-addr) | 2.0.7 | MIT |
| [punycode](https://mths.be/punycode) | 1.4.1 | MIT |
| [qs](https://github.com/ljharb/qs) | 6.15.2 | BSD-3-Clause |
| [range-parser](jshttp/range-parser) | 1.2.1 | MIT |
| [raw-body](stream-utils/raw-body) | 3.0.2 | MIT |
| [readable-stream](git://github.com/nodejs/readable-stream) | 2.3.8 | MIT |
| [router](pillarjs/router) | 2.2.0 | MIT |
| [safe-buffer](https://github.com/feross/safe-buffer) | 5.1.2 | MIT |
| [safer-buffer](https://github.com/ChALkeR/safer-buffer) | 2.1.2 | MIT |
| [send](pillarjs/send) | 1.2.1 | MIT |
| [serve-static](expressjs/serve-static) | 2.2.1 | MIT |
| [setimmediate](YuzuJS/setImmediate) | 1.0.5 | MIT |
| [setprototypeof](https://github.com/wesleytodd/setprototypeof) | 1.2.0 | ISC |
| [side-channel](https://github.com/ljharb/side-channel#readme) | 1.1.0 | MIT |
| [side-channel-list](https://github.com/ljharb/side-channel-list#readme) | 1.0.1 | MIT |
| [side-channel-map](https://github.com/ljharb/side-channel-map#readme) | 1.0.1 | MIT |
| [side-channel-weakmap](https://github.com/ljharb/side-channel-weakmap#readme) | 1.0.2 | MIT |
| [sprintf-js](https://github.com/alexei/sprintf.js) | 1.0.3 | BSD-3-Clause |
| [statuses](jshttp/statuses) | 2.0.2 | MIT |
| [streamsearch](http://github.com/mscdex/streamsearch) | 1.1.0 | MIT |
| [string_decoder](https://github.com/nodejs/string_decoder) | 1.1.1 | MIT |
| [toidentifier](component/toidentifier) | 1.0.1 | MIT |
| [type-is](jshttp/type-is) | 2.1.0 | MIT |
| [typedarray](https://github.com/substack/typedarray) | 0.0.6 | MIT |
| [underscore](https://underscorejs.org) | 1.13.8 | MIT |
| [unpipe](stream-utils/unpipe) | 1.0.0 | MIT |
| [url](https://github.com/defunctzombie/node-url) | 0.11.4 | MIT |
| [util-deprecate](https://github.com/TooTallNate/util-deprecate) | 1.0.2 | MIT |
| [vary](jshttp/vary) | 1.1.2 | MIT |
| [wrappy](https://github.com/npm/wrappy) | 1.0.2 | ISC |
| [xmlbuilder](http://github.com/oozcitak/xmlbuilder-js) | 10.1.1 | MIT |

## 5. Gói Python (72)

CrabbyCut **không phân phối lại** các gói này. Chúng do `pip` tải từ PyPI về máy người
dùng trong bước thiết lập theo yêu cầu (xem `scripts/setup_runtime.js`), và chỉ tải nhóm
nào ứng với tính năng người dùng thật sự dùng tới.

Riêng `nvidia-cublas-cu12` và `nvidia-cuda-nvrtc-cu12` mang giấy phép **độc quyền của
NVIDIA**, không phải mã nguồn mở; xem [`LICENSE-EXCEPTION.md`](LICENSE-EXCEPTION.md).

### Tổng hợp theo giấy phép

| Giấy phép | Số gói |
|---|---|
| MIT | 15 |
| BSD License | 12 |
| BSD-3-Clause | 11 |
| MIT License | 7 |
| Apache-2.0 | 6 |
| Apache Software License | 6 |
| Mozilla Public License 2.0 (MPL 2.0) | 1 |
| MIT-0 | 1 |
| BSD-2-Clause AND Apache-2.0 WITH LLVM-exception | 1 |
| Python Software Foundation License | 1 |
| LicenseRef-NVIDIA-Proprietary | 1 |
| Other/Proprietary License | 1 |
| Apache-2.0 OR BSD-2-Clause | 1 |
| MIT-CMU | 1 |
| 3-Clause BSD License | 1 |
| BSD License; Apache Software License | 1 |
| Apache-2.0 AND CNRI-Python | 1 |
| (xem gói) | 1 |
| Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT | 1 |
| MPL-2.0 AND MIT | 1 |
| PSF-2.0 | 1 |

### Danh sách đầy đủ

| Gói | Phiên bản | Giấy phép |
|---|---|---|
| absl-py | 2.5.0 | Apache-2.0 |
| anyio | 4.15.1 | MIT |
| attrs | 26.1.0 | MIT |
| av | 18.1.0 | BSD-3-Clause |
| blinker | 1.9.0 | MIT License |
| certifi | 2026.7.22 | Mozilla Public License 2.0 (MPL 2.0) |
| cffi | 2.1.1 | MIT-0 |
| charset-normalizer | 3.5.1 | MIT |
| click | 8.5.0 | BSD-3-Clause |
| colorama | 0.4.6 | BSD License |
| contourpy | 1.3.3 | BSD License |
| ctranslate2 | 4.8.2 | MIT |
| cycler | 0.12.1 | BSD License |
| faster-whisper | 1.2.1 | MIT License |
| filelock | 3.32.5 | MIT |
| Flask | 3.1.3 | BSD-3-Clause |
| flatbuffers | 25.12.19 | Apache Software License |
| fonttools | 4.64.0 | MIT |
| fsspec | 2026.7.0 | BSD-3-Clause |
| h11 | 0.16.0 | MIT License |
| hf-xet | 1.6.0 | Apache-2.0 |
| httpcore | 1.0.9 | BSD-3-Clause |
| httpx | 0.28.1 | BSD License |
| huggingface_hub | 1.30.0 | Apache Software License |
| idna | 3.19 | BSD-3-Clause |
| itsdangerous | 2.2.0 | BSD License |
| jax | 0.7.1 | Apache-2.0 |
| jaxlib | 0.7.1 | Apache-2.0 |
| Jinja2 | 3.1.6 | BSD License |
| kiwisolver | 1.5.1 | BSD License |
| llvmlite | 0.49.0 | BSD-2-Clause AND Apache-2.0 WITH LLVM-exception |
| MarkupSafe | 3.0.3 | BSD-3-Clause |
| matplotlib | 3.11.1 | Python Software Foundation License |
| mediapipe | 0.10.21 | Apache Software License |
| ml_dtypes | 0.5.4 | Apache-2.0 |
| more-itertools | 11.1.0 | MIT |
| mpmath | 1.3.0 | BSD License |
| networkx | 3.6.1 | BSD-3-Clause |
| numba | 0.67.0 | BSD License |
| numpy | 1.26.4 | BSD License |
| nvidia-cublas-cu12 | 12.9.2.10 | LicenseRef-NVIDIA-Proprietary |
| nvidia-cuda-nvrtc-cu12 | 12.9.86 | Other/Proprietary License |
| onnxruntime | 1.29.0 | MIT License |
| openai-whisper | 20250625 | MIT |
| opencv-contrib-python | 4.11.0.86 | Apache Software License |
| opt_einsum | 3.4.0 | MIT |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause |
| pillow | 12.3.0 | MIT-CMU |
| pip | 26.2.1 | MIT |
| protobuf | 4.25.9 | 3-Clause BSD License |
| psutil | 7.2.2 | BSD-3-Clause |
| pycparser | 3.0 | BSD-3-Clause |
| pydub | 0.25.1 | MIT License |
| pyparsing | 3.3.2 | MIT |
| python-dateutil | 2.9.0.post0 | BSD License; Apache Software License |
| PyYAML | 6.0.3 | MIT License |
| RapidFuzz | 3.14.6 | MIT |
| regex | 2026.9.3 | Apache-2.0 AND CNRI-Python |
| requests | 2.34.2 | Apache Software License |
| scipy | 1.17.1 | BSD License |
| sentencepiece | 0.2.2 | Apache-2.0 |
| setuptools | 84.0.0 | MIT |
| six | 1.17.0 | MIT License |
| sounddevice | 0.5.6 | MIT |
| sympy | 1.14.0 | BSD License |
| tiktoken | 0.14.0 | (xem gói) |
| tokenizers | 0.23.2 | Apache Software License |
| torch | 2.14.0 | Apache-2.0 AND Apache-2.0 WITH LLVM-exception AND BSD-2-Clause AND BSD-3-Clause AND BSL-1.0 AND MIT |
| tqdm | 4.70.0 | MPL-2.0 AND MIT |
| typing_extensions | 4.16.0 | PSF-2.0 |
| urllib3 | 2.7.0 | MIT |
| Werkzeug | 3.1.8 | BSD-3-Clause |

## 6. Font

Thư mục `static/fonts/google/` chứa font từ dự án Google Fonts. Giấy phép theo từng họ
font được ghi trong `static/fonts/google/FONTS_MANIFEST.md`; văn bản giấy phép nằm cùng
thư mục:

| Tệp | Áp dụng cho |
|---|---|
| `LICENSE-OFL-1.1.txt` | Phần lớn các họ font (SIL Open Font License 1.1) |
| `LICENSE-Apache-2.0.txt` | Roboto Slab |
| `LICENSE-UFL-1.0.txt` | Ubuntu (Ubuntu Font Licence 1.0) |

## 7. Tài nguyên media

Kho tài nguyên (`library/`) **không đi kèm mã nguồn công khai**. Nhạc, hiệu ứng âm thanh,
video và hình ảnh mẫu có giấy phép riêng và phần lớn giấy phép stock **cấm phân phối lại**
tệp gốc. Xem `library/README.md`.

Ngoại lệ: các tệp `.cube` trong `library/luts/` do chính
`scripts/generate_preset_luts.js` của dự án sinh ra, nên thuộc giấy phép của CrabbyCut.

