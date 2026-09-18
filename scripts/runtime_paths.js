#!/usr/bin/env node
/* VỊ TRÍ MÔI TRƯỜNG CHẠY DO BỘ CÀI DỰNG RA — NGUỒN SỰ THẬT DUY NHẤT.
 *
 * VÌ SAO KHÔNG ĐẶT TRONG THƯ MỤC CÀI ĐẶT: bản cài đặt nằm ở
 * `%LOCALAPPDATA%\Programs\CrabbyCut`, và electron-builder XOÁ SẠCH thư mục đó mỗi lần
 * nâng cấp phiên bản. Để môi trường Python (~2 GB, tải mất mười mấy phút) ở trong đó thì
 * mỗi lần cập nhật app là người dùng phải tải lại từ đầu. Tách ra `%LOCALAPPDATA%\CrabbyCut`
 * thì môi trường sống qua được mọi lần nâng cấp; gỡ cài đặt muốn dọn thì gọi riêng.
 *
 * VÌ SAO KHÔNG DÙNG `app.getPath('userData')`: tệp này được nạp ở CẢ hai phía — tiến trình
 * main của Electron (có `app`) lẫn backend chạy dưới `ELECTRON_RUN_AS_NODE` và các script
 * Node thuần (không có `app`). Tự dựng đường dẫn từ biến môi trường là cách duy nhất cho
 * ra CÙNG một kết quả ở cả ba nơi.
 */
'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');

/* Bump khi bố cục thư mục runtime hoặc danh sách gói đổi theo cách bản cũ không dùng được
 * nữa. `verifyRuntimeQuick()` so số này với manifest và coi bản cũ là "chưa thiết lập",
 * nên người dùng được dựng lại thay vì chạy tiếp trên một môi trường lệch. */
const RUNTIME_SCHEMA = 1;

/* GỐC DỮ LIỆU CỦA ỨNG DỤNG TRÊN MÁY NGƯỜI DÙNG — %LOCALAPPDATA%\CrabbyCut và tương đương.
 *
 * MỌI THỨ PHẢI SỐNG QUA MỘT LƯỢT CẬP NHẬT ĐỀU NẰM DƯỚI ĐÂY.
 * Trình gỡ cài đặt do electron-builder sinh ra, khi chạy ở nhánh cập nhật, dời TOÀN BỘ
 * $INSTDIR sang thư mục tạm rồi `RMDir /r $INSTDIR` — không chừa một ngoại lệ nào
 * (xem node_modules/app-builder-lib/templates/nsis/uninstaller.nsh). Nên bất cứ thứ gì của
 * NGƯỜI DÙNG mà để trong thư mục cài đặt là mất sạch ở lần cập nhật đầu tiên: cài đặt ứng
 * dụng, thư viện tài nguyên họ tự thêm, báo cáo dự án, cache bóc băng.
 */
function appDataRoot() {
  if (process.env.CRAB_APP_DATA_DIR) return path.resolve(process.env.CRAB_APP_DATA_DIR);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'CrabbyCut');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'CrabbyCut');
  }
  return path.join(os.homedir(), '.local', 'share', 'CrabbyCut');
}

/* Nơi đặt cài đặt, thư viện tài nguyên, báo cáo và cache của NGƯỜI DÙNG.
 *
 * `CRAB_USER_DATA_DIR` do electron/main.js đặt, và CHỈ khi `app.isPackaged`. Chạy từ mã
 * nguồn thì biến này không có, backend giữ nguyên các thư mục trong thư mục dự án — nếu
 * không thì `npm start` sẽ đột ngột không thấy thư viện mà người phát triển đang dùng.
 * Một biến, một chỗ quyết định; xem USER_DATA_ROOT ở backend/server.js. */
function userDataRoot() {
  if (process.env.CRAB_USER_DATA_DIR) return path.resolve(process.env.CRAB_USER_DATA_DIR);
  return appDataRoot();
}

function runtimeRoot() {
  if (process.env.CRAB_RUNTIME_DIR) return path.resolve(process.env.CRAB_RUNTIME_DIR);
  return path.join(appDataRoot(), 'runtime');
}

function pythonHome() {
  return path.join(runtimeRoot(), 'python');
}

/* Bố cục interpreter khác nhau giữa bản nhúng (Windows: python.exe nằm ngay gốc) và venv
 * POSIX (bin/python). Giữ cùng quy ước với scripts/python_command.js. */
function runtimePython() {
  return process.platform === 'win32'
    ? path.join(pythonHome(), 'python.exe')
    : path.join(pythonHome(), 'bin', 'python');
}

function ffmpegDir() {
  return path.join(runtimeRoot(), 'ffmpeg', 'bin');
}

function ffmpegBinary(name) {
  return path.join(ffmpegDir(), process.platform === 'win32' ? `${name}.exe` : name);
}

function manifestPath() {
  return path.join(runtimeRoot(), 'runtime.json');
}

function downloadCacheDir() {
  return path.join(runtimeRoot(), 'downloads');
}

function setupLogPath() {
  return path.join(runtimeRoot(), 'setup.log');
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeManifest(data) {
  const dir = runtimeRoot();
  fs.mkdirSync(dir, { recursive: true });
  /* Ghi NGUYÊN TỬ (tmp -> rename): tắt máy giữa lúc ghi manifest mà để lại file JSON cụt
   * thì lần mở sau `readManifest()` trả null và người dùng bị bắt cài lại toàn bộ ~2 GB. */
  const tmp = `${manifestPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, manifestPath());
}

/* Ghi lại "nhóm tính năng này đã cài xong" vào manifest.
 *
 * ĐỌC-SỬA-GHI thay vì giữ manifest trong bộ nhớ: lượt cài một nhóm chạy trong tiến trình
 * BACKEND, còn manifest ban đầu do tiến trình THIẾT LẬP ghi ra. Hai tiến trình khác nhau,
 * nên bản duy nhất đáng tin là bản trên đĩa. */
function markFeature(featureId, state) {
  const manifest = readManifest() || { schema: RUNTIME_SCHEMA, completed: false };
  manifest.features = manifest.features || {};
  manifest.features[featureId] = {
    ...(manifest.features[featureId] || {}),
    ...state,
    updated_at: new Date().toISOString(),
  };
  writeManifest(manifest);
  return manifest.features[featureId];
}

function featureState(featureId) {
  return readManifest()?.features?.[featureId] || null;
}

/* PHÉP KIỂM RẺ — chạy ở MỖI lần mở app, nên không được gọi Python.
 * Chỉ trả lời "đã thiết lập xong chưa", KHÔNG trả lời "có chạy đúng không": phép kiểm sâu
 * (import thật từng gói) tốn vài giây và nằm ở scripts/setup_runtime.js --verify. */
function verifyRuntimeQuick() {
  const manifest = readManifest();
  if (!manifest) return { ok: false, reason: 'no_manifest' };
  if (manifest.schema !== RUNTIME_SCHEMA) return { ok: false, reason: 'schema_changed', manifest };
  if (!manifest.completed) return { ok: false, reason: 'incomplete', manifest };
  if (!fs.existsSync(runtimePython())) return { ok: false, reason: 'python_missing', manifest };
  /* ffmpeg có thể là bản CỦA MÁY (manifest.ffmpeg.source === 'system') — khi đó không có
   * thư mục nào của ta để kiểm, và việc nó còn sống hay không thuộc về phép kiểm sâu. */
  if (manifest.ffmpeg?.source === 'bundled' && !fs.existsSync(ffmpegBinary('ffmpeg'))) {
    return { ok: false, reason: 'ffmpeg_missing', manifest };
  }
  return { ok: true, manifest };
}

module.exports = {
  RUNTIME_SCHEMA,
  appDataRoot,
  userDataRoot,
  runtimeRoot,
  pythonHome,
  runtimePython,
  ffmpegDir,
  ffmpegBinary,
  manifestPath,
  downloadCacheDir,
  setupLogPath,
  readManifest,
  markFeature,
  featureState,
  writeManifest,
  verifyRuntimeQuick,
};
