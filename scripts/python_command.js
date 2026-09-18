#!/usr/bin/env node
/* CHỌN INTERPRETER PYTHON + ENV CHO MỌI SIDECAR — NGUỒN SỰ THẬT DUY NHẤT.
 *
 * Phép chọn này trước đây được CHÉP TAY ở 7 chỗ (backend/server.js, scripts/run_python.js
 * và 5 test script), và mỗi bản chép lại thiếu một mảnh khác nhau: bản thì chỉ dò
 * `.venv/bin/python` (bố cục POSIX) nên trên Windows venv của dự án bị bỏ qua âm thầm, bản
 * thì rơi thẳng về `python3` — cái mà Windows KHÔNG có (chỉ có shim của Microsoft Store,
 * trả exit 9009 kèm lời mời cài từ Store). Gộp về một chỗ để backend và test không bao giờ
 * chạy bằng hai interpreter khác nhau.
 *
 * HAI BỐ CỤC .venv: `bin/python` (macOS/Linux) và `Scripts/python.exe` (Windows).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

/* STDIO CỦA PYTHON PHẢI LÀ UTF-8, KHÔNG ĐƯỢC ĐỂ MẶC ĐỊNH.
 * Trên Windows `sys.stdout` mặc định dùng code page ANSI (cp1252/cp437), nên `print()` một
 * chuỗi tiếng Việt là UnicodeEncodeError GIẾT LUÔN tiến trình:
 *   'charmap' codec can't encode character 'Đ' in position 33  (chữ "Đ")
 * Sidecar chết giữa đường, bên gọi chỉ thấy exit code != 0 — không hề lộ ra rằng nguyên
 * nhân chỉ là ENCODING. Kể cả khi không chết thì bên Node vẫn `toString('utf8')`, nên byte
 * cp1252 về tới đó thành mojibake và NDJSON parse trượt.
 *   - PYTHONIOENCODING chốt stdin/stdout/stderr.
 *   - PYTHONUTF8=1 (UTF-8 mode) chốt luôn phần ĐỌC/GHI FILE của sidecar — payload JSON có
 *     tên tệp tiếng Việt cũng cần.
 */
const PYTHON_ENV = {
  PYTHONUNBUFFERED: '1',
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
};

/* TÌM TRÊN PATH BẰNG TAY, TRẢ VỀ ĐƯỜNG DẪN TUYỆT ĐỐI — KHÔNG giao tên trần cho spawn.
 *
 * VÌ SAO: `spawn('python')` trên Windows đi qua phép dò PATH của libuv, và phép dò đó DỪNG
 * ở file đầu tiên trùng tên rồi gọi CreateProcess. Nếu file đó không chạy được, libuv trả
 * ENOENT và KHÔNG tìm tiếp — Python thật ở các mục PATH phía sau không bao giờ được tới.
 *
 * Ca đã gặp thật (bản cài 1.1.8, lỗi "Cài model ASR thất bại: spawn python ENOENT"): PATH
 * của người dùng còn sót `C:\Users\<tài khoản khác>\AppData\Local\Microsoft\WindowsApps`.
 * Thư mục đó chứa `python.exe` là App Execution Alias — reparse point 0 byte, thuộc hồ sơ
 * của tài khoản khác nên tài khoản hiện tại không thực thi được. Máy có sẵn Python 3.11 và
 * 3.12 cài đàng hoàng, `where python` liệt kê đủ, nhưng spawn vẫn ENOENT.
 *
 * Lọc theo KÍCH THƯỚC là cách phân biệt: alias luôn 0 byte, interpreter thật cả trăm KB.
 */
function findOnPath(command) {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && stat.size > 0) return candidate;
      } catch (_) { /* mục PATH không tồn tại là chuyện thường */ }
    }
  }
  return null;
}

function pythonCommand(projectRoot = PROJECT_ROOT) {
  /* Cho phép ghi đè tuyệt đối — dùng khi gỡ lỗi và khi test cần chốt một interpreter. */
  if (process.env.CRAB_PYTHON && fs.existsSync(process.env.CRAB_PYTHON)) {
    return process.env.CRAB_PYTHON;
  }

  /* .venv của dự án đứng TRƯỚC môi trường do bộ cài dựng: chạy từ mã nguồn (`npm start`)
   * thì thứ người phát triển vừa `pip install` vào phải là thứ được dùng, nếu không thì
   * sửa gói xong chạy lại vẫn thấy hành vi cũ. Bản đóng gói không có .venv nên không đụng. */
  const venvCandidates = [
    path.join(projectRoot, '.venv', 'bin', 'python'),
    path.join(projectRoot, '.venv', 'Scripts', 'python.exe'),
  ];
  const venv = venvCandidates.find((candidate) => fs.existsSync(candidate));
  if (venv) return venv;

  /* Môi trường do bộ cài .exe dựng ra (xem scripts/setup_runtime.js). Đây là đường đi của
   * MỌI máy người dùng cuối. */
  try {
    const runtimePython = require('./runtime_paths.js').runtimePython();
    if (fs.existsSync(runtimePython)) return runtimePython;
  } catch (_) { /* thiếu module thì rơi xuống nhánh PATH */ }

  const onPath = findOnPath(process.platform === 'win32' ? 'python' : 'python3');
  if (onPath) return onPath;

  /* Không tìm được gì: trả tên trần để thông báo lỗi của bên gọi vẫn đọc được
   * ("spawn python ENOENT") thay vì ném từ đây. */
  return process.platform === 'win32' ? 'python' : 'python3';
}

/* env đầy đủ để truyền thẳng vào spawn/spawnSync. Nhận thêm `extra` để bên gọi chèn biến
 * riêng (vd BACKEND_PORT) mà không phải tự nhớ trải PYTHON_ENV. */
function pythonEnv(extra = {}) {
  return { ...process.env, ...PYTHON_ENV, ...extra };
}

module.exports = { pythonCommand, pythonEnv, findOnPath, PYTHON_ENV, PROJECT_ROOT };
