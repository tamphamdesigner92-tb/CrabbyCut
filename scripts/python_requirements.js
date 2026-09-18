#!/usr/bin/env node
/* BẢNG TRA: TÍNH NĂNG -> MODULE PYTHON THẬT SỰ ĐƯỢC IMPORT — NGUỒN SỰ THẬT DUY NHẤT.
 *
 * CỐ Ý KHÔNG parse `requirements.txt` để suy ra danh sách này. Tên gói phân phối KHÁC
 * tên import ở đúng những chỗ quan trọng nhất:
 *     opencv-contrib-python -> cv2        faster-whisper -> faster_whisper
 *     openai-whisper        -> whisper    huggingface-hub -> huggingface_hub
 * `nvidia-cublas-cu12` thì KHÔNG có tên import nào cả (nó chỉ là DLL được nạp theo PATH,
 * xem `_ensure_cuda_dll_path()` ở asr/windows_faster_whisper_sidecar.py), còn `flask` và
 * `requests` nằm trong requirements.txt nhưng KHÔNG được import ở đâu trong repo. Mọi phép
 * suy diễn tự động từ requirements.txt đều sai ở ít nhất một trong các ca trên.
 *
 * Mỗi module ghi kèm `source` — chỗ nó THẬT SỰ được import — để khi sửa mã nguồn thì biết
 * ngay phải sửa dòng nào của bảng này. Sai lệch giữa bảng và mã nguồn là lỗi của bảng.
 *
 * Bảng này được dùng ở CẢ HAI đường chạy: `scripts/preflight_python.js` (chạy từ mã nguồn,
 * qua `npm start`) và — về sau — cửa sổ thiết lập của bộ cài .exe. Viết một lần, dùng hai nơi.
 */
'use strict';

/* GIỚI HẠN PHIÊN BẢN PYTHON — RÀNG BUỘC THẬT, KHÔNG PHẢI SỞ THÍCH.
 * requirements.txt ghim `mediapipe==0.10.21` và `opencv-contrib-python<4.12` kèm marker
 * `python_version < "3.13"` vì mediapipe không có wheel cho 3.13+. Hậu quả rất khó truy nếu
 * không kiểm: dựng venv bằng Python 3.13/3.14 thì `pip install -r requirements.txt` vẫn
 * BÁO THÀNH CÔNG — nó chỉ lặng lẽ BỎ QUA hai gói đó vì marker không khớp — rồi Auto-Reframe
 * chết sau đó với "No module named 'cv2'" mà không ai hiểu tại sao bản cài "thành công" lại
 * thiếu gói. Trên máy này `py -0p` mặc định là 3.14, nên cái bẫy này rất dễ sập. */
const PYTHON_MIN = [3, 9];
const PYTHON_MAX_EXCLUSIVE = [3, 13];

/* CÀI THEO TÍNH NĂNG, KHÔNG CÀI MỘT CỤC.
 *
 * Cài hết trong lúc chạy bộ .exe thì người dùng phải ngồi chờ ~2,6 GB trước khi nhìn thấy
 * ứng dụng lần đầu — đo thật trên máy mạng chậm là hàng giờ. Mà phần lớn số đó KHÔNG cần để
 * mở app: dựng phim, cắt ghép, xem trước và xuất video chạy bằng Node + FFmpeg + C++
 * sidecar, không đụng tới Python một dòng nào.
 *
 * Nên bộ cài chỉ dựng phần LÕI (Python + pip + FFmpeg), còn mỗi nhóm dưới đây được tải về ở
 * lần ĐẦU TIÊN người dùng chạm vào đúng tính năng của nó. `trigger` là câu mô tả tính năng
 * đó để thông báo trong lúc tải nói được "đang tải thư viện cho việc gì", thay vì ném ra
 * tên gói pip mà không ai đoán được là dùng cho cái gì.
 *
 * `extraPip` = gói KHÔNG có tên import nào để dò, nên không thể suy ra từ `modules`.
 */
const GROUPS = [
  {
    id: 'script',
    label: 'Lọc + Sắp xếp theo kịch bản',
    trigger: 'Lọc và sắp xếp cảnh theo kịch bản',
    /* core_logic.py import BỐN gói này ở TOP-LEVEL (dòng 16-19), nên thiếu bất kỳ cái nào là
     * `import core_logic` chết ngay — kéo theo cả python_filter_sidecar.py lẫn
     * python_reorder_sidecar.py. Đây là lý do `rapidfuzz` thiếu thì hỏng nhiều hơn vẻ ngoài.
     * (Kế hoạch đóng gói, giai đoạn 2, dự định đưa torch/whisper vào import lười để đường
     * Windows khỏi phải kéo ~4 GB; khi làm xong thì chuyển hai dòng đó xuống nhóm riêng.) */
    modules: [
      { module: 'rapidfuzz', pip: 'rapidfuzz', source: 'core_logic.py:16' },
      { module: 'pydub', pip: 'pydub', source: 'core_logic.py:19' },
      { module: 'torch', pip: 'torch', source: 'core_logic.py:17' },
      { module: 'whisper', pip: 'openai-whisper', source: 'core_logic.py:18' },
    ],
  },
  {
    id: 'asr',
    label: 'Bóc băng (ASR)',
    trigger: 'Bóc băng bằng AI Whisper',
    platforms: ['win32'],
    /* cuBLAS không có tên import — nó chỉ là bộ DLL mà ctranslate2 nạp theo PATH (xem
     * `_ensure_cuda_dll_path()` ở asr/windows_faster_whisper_sidecar.py). Chỉ tải khi máy
     * thật sự có GPU NVIDIA; xem `requirementsForFeature()` ở scripts/setup_runtime.js. */
    extraPip: [{ pip: 'nvidia-cublas-cu12', needsNvidia: true }],
    /* Sidecar tự thăm dò ba gói này trong `check_imports()` rồi từ chối cài model nếu thiếu
     * ("Missing Python package: faster-whisper."). Preflight bắt sớm hơn để lỗi không nổ ra
     * giữa lúc người dùng đang bấm nút trong UI. */
    modules: [
      { module: 'faster_whisper', pip: 'faster-whisper', source: 'asr/windows_faster_whisper_sidecar.py:222' },
      { module: 'ctranslate2', pip: 'ctranslate2', source: 'asr/windows_faster_whisper_sidecar.py:223' },
      { module: 'huggingface_hub', pip: 'huggingface-hub', source: 'asr/windows_faster_whisper_sidecar.py:224' },
    ],
  },
  {
    id: 'asr_mac',
    label: 'Bóc băng (ASR)',
    trigger: 'Bóc băng bằng AI Whisper',
    platforms: ['darwin'],
    modules: [
      { module: 'mlx_whisper', pip: 'mlx-whisper', source: 'asr/mac_mlx_sidecar.py' },
    ],
  },
  {
    id: 'vision',
    label: 'Auto-Reframe / Retouch',
    trigger: 'Auto-Reframe và Retouch',
    /* auto_reframe_sidecar.py import BÊN TRONG hàm (dòng 249-263) và tự nuốt lỗi vào
     * `self.import_errors` — nên thiếu gói KHÔNG làm sidecar chết, nó chỉ âm thầm suy giảm
     * chất lượng dò khuôn mặt. Kiểu hỏng im lặng đó chính là thứ preflight cần phơi ra. */
    modules: [
      { module: 'cv2', pip: 'opencv-contrib-python', source: 'asr/auto_reframe_sidecar.py:249' },
      { module: 'numpy', pip: 'numpy', source: 'asr/auto_reframe_sidecar.py:256' },
      { module: 'mediapipe', pip: 'mediapipe', source: 'asr/auto_reframe_sidecar.py:263' },
    ],
  },
];

/* Lọc theo nền tảng đang chạy. Không có `platforms` = cần ở mọi nền tảng. */
function groupsForPlatform(platform = process.platform) {
  return GROUPS.filter((group) => !group.platforms || group.platforms.includes(platform));
}

/* Danh sách module phẳng, đã khử trùng lặp — dùng làm argv cho phép dò Python. */
function modulesForPlatform(platform = process.platform) {
  const seen = new Set();
  const out = [];
  for (const group of groupsForPlatform(platform)) {
    for (const item of group.modules) {
      if (seen.has(item.module)) continue;
      seen.add(item.module);
      out.push(item.module);
    }
  }
  return out;
}

function groupById(id, platform = process.platform) {
  return groupsForPlatform(platform).find((group) => group.id === id) || null;
}

/* Chuẩn hoá tên gói theo PEP 503: `opencv_contrib_python`, `OpenCV-Contrib-Python` và
 * `opencv-contrib-python` là MỘT. Không chuẩn hoá thì phép đối chiếu giữa bảng này và
 * requirements.txt trượt ở đúng những gói có gạch dưới — và trượt im lặng: gói không được
 * cài, không có lỗi nào, tính năng chết sau đó với "No module named". */
function normalizePipName(name) {
  return String(name || '').trim().toLowerCase().replace(/[-_.]+/g, '-');
}

/* Mọi tên gói pip mà một nhóm cần. Gộp tên suy ra từ `modules` với `extraPip`.
 * `hasNvidia` quyết định có lấy các gói chỉ có ích khi có GPU NVIDIA hay không. */
function pipNamesForGroup(id, { platform = process.platform, hasNvidia = false } = {}) {
  const group = groupById(id, platform);
  if (!group) return [];
  const names = group.modules.map((item) => item.pip);
  for (const extra of group.extraPip || []) {
    if (extra.needsNvidia && !hasNvidia) continue;
    names.push(extra.pip);
  }
  return [...new Set(names.map(normalizePipName))];
}

/* Các nhóm được tải theo yêu cầu (không nằm trong bước cài đặt). Hiện là TẤT CẢ: bước cài
 * chỉ dựng Python + pip + FFmpeg. Tách thành hàm riêng để sau này muốn kéo một nhóm vào
 * phần lõi thì chỉ sửa một chỗ. */
function onDemandGroups(platform = process.platform) {
  return groupsForPlatform(platform);
}

function pythonVersionOk(versionTuple) {
  if (!Array.isArray(versionTuple) || versionTuple.length < 2) return false;
  const [major, minor] = versionTuple;
  const atLeastMin = major > PYTHON_MIN[0] || (major === PYTHON_MIN[0] && minor >= PYTHON_MIN[1]);
  const belowMax = major < PYTHON_MAX_EXCLUSIVE[0]
    || (major === PYTHON_MAX_EXCLUSIVE[0] && minor < PYTHON_MAX_EXCLUSIVE[1]);
  return atLeastMin && belowMax;
}

module.exports = {
  GROUPS,
  PYTHON_MIN,
  PYTHON_MAX_EXCLUSIVE,
  groupsForPlatform,
  modulesForPlatform,
  groupById,
  normalizePipName,
  pipNamesForGroup,
  onDemandGroups,
  pythonVersionOk,
};
