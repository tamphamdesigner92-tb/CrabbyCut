#!/usr/bin/env node
/* KIỂM (VÀ TỰ BUILD) PHẦN NATIVE TRƯỚC KHI MỞ APP — chạy trong chuỗi `npm start`.
 *
 * VÌ SAO CẦN: `npm install` KHÔNG build native addon lẫn C++ sidecar (`postinstall` chỉ
 * chạy `prepare:vendor`), mà thiếu chúng thì app VẪN MỞ BÌNH THƯỜNG — chỉ có một dòng log
 * trôi qua giữa lúc backend khởi động:
 *     [backend] Cannot load native addon: Cannot find module '…/core_c.node'
 * Không ai đọc dòng đó. Hậu quả là người mới clone repo về tưởng mọi thứ đã đúng, rồi kết
 * luận sai về hiệu năng vì đang chạy nguyên đường dự phòng bằng JS.
 *
 * KHÁC preflight_python.js ở một điểm: ở đây TỰ BUILD LUÔN thay vì chỉ in hướng dẫn. Lý do
 * khiến preflight_python cố ý không tự chạy `pip install` — nặng vài GB, resolver không
 * ghim phiên bản nên mỗi lần cài là một lần rủi ro — đều KHÔNG đúng với native: build mất
 * khoảng một phút cho lần đầu, không tải gì từ mạng, và kết quả hoàn toàn xác định từ mã
 * nguồn trong repo. Thứ rẻ và chắc chắn thì nên tự làm; thứ nặng và bấp bênh thì phải để
 * người dùng chủ động.
 *
 * KHÔNG CHẶN khi build hỏng. Thiếu toolchain C++ không phải lý do để cấm mở app sửa UI.
 * Cùng quy ước với preflight_python.js: cảnh báo, nêu đúng lệnh cần chạy, rồi đi tiếp.
 *
 * KHÔNG LIÊN QUAN TỚI BẢN ĐÓNG GÓI. Tệp này chỉ được gọi từ script npm `electron:dev`;
 * `electron-builder` không chạy nó, và bản .exe đã có sẵn hai tệp native do `build.files`
 * chép vào nên không bao giờ cần build lúc chạy.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { findOnPath, PROJECT_ROOT } = require('./python_command.js');

const IS_WIN = process.platform === 'win32';
const NO_BUILD = process.argv.includes('--no-build');

const ADDON_SRC = path.join(PROJECT_ROOT, 'native', 'addon', 'src', 'core_c.cpp');
const ADDON_OUT = path.join(PROJECT_ROOT, 'native', 'addon', 'build', 'Release', 'core_c.node');
const SIDECAR_SRC = path.join(PROJECT_ROOT, 'native', 'sidecar', 'core_process.cpp');
const SIDECAR_OUT = path.join(PROJECT_ROOT, 'native', 'sidecar', 'build', IS_WIN ? 'core_process.exe' : 'core_process');

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch (_) { return null; }
}

/* Ba trạng thái, không phải hai: 'ok' | 'missing' | 'stale'.
 * 'stale' (mã nguồn .cpp mới hơn sản phẩm) là ca âm thầm nhất — sau `git pull` có sửa
 * core_c.cpp, binary cũ vẫn nạp được nên không lỗi gì cả, chỉ là hành vi không khớp mã
 * nguồn đang đọc. Đó đúng kiểu lỗi ngốn cả buổi để truy. */
function state(src, out) {
  const outTime = mtime(out);
  if (outTime === null) return 'missing';
  const srcTime = mtime(src);
  if (srcTime !== null && srcTime > outTime) return 'stale';
  return 'ok';
}

/* Kiểm toolchain TRƯỚC khi gọi build: node-gyp thiếu Xcode CLT chết bằng
 * `xcrun: error: invalid active developer path` — một câu không hề nhắc tới việc phải cài
 * gì, lại nằm lẫn giữa mấy chục dòng gyp. Thà không build còn hơn ném đống đó vào `npm start`. */
function toolchainHint() {
  if (process.platform === 'darwin') {
    const probe = spawnSync('xcode-select', ['-p'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return 'Cài Xcode Command Line Tools: xcode-select --install';
    return null;
  }
  if (IS_WIN) {
    if (findOnPath('cl')) return null;
    const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (fs.existsSync(vswhere)) {
      const found = spawnSync(vswhere, ['-latest', '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
        { encoding: 'utf8', windowsHide: true });
      if (!found.error && found.status === 0 && String(found.stdout || '').trim()) return null;
    }
    return 'Cài Visual Studio 2022 kèm workload "Desktop development with C++"';
  }
  if (['g++', 'clang++', 'c++'].some(findOnPath)) return null;
  return 'Cài compiler C++ (build-essential hoặc clang)';
}

function build(label, script) {
  console.log(`[native] ${label} — build lần này mất khoảng một phút, các lần sau bỏ qua…`);
  const result = spawnSync(IS_WIN ? 'npm.cmd' : 'npm', ['run', script], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    shell: IS_WIN, // npm trên Windows là .cmd, spawn không shell sẽ EINVAL
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

/* Bảng mục tiêu tách riêng để scripts/setup_dev.js dùng LẠI ĐÚNG phép kiểm này thay vì
 * chép sang một bản thứ hai — hai bản chép nhau rồi lệch nhau là đúng thứ file
 * python_command.js đã phải đi gom lại. */
function nativeTargets() {
  return [
    { name: 'native addon', out: ADDON_OUT, script: 'build:addon', state: state(ADDON_SRC, ADDON_OUT) },
    { name: 'C++ sidecar', out: SIDECAR_OUT, script: 'build:sidecar', state: state(SIDECAR_SRC, SIDECAR_OUT) },
  ];
}

function main() {
  const targets = nativeTargets();
  const pending = targets.filter((t) => t.state !== 'ok');

  if (!pending.length) {
    console.log('[native] ✓ addon + sidecar đã có và mới hơn mã nguồn.');
  } else if (NO_BUILD) {
    for (const t of pending) console.error(`[native] ✗ ${t.name}: ${t.state === 'missing' ? 'chưa build' : 'cũ hơn mã nguồn'}`);
    console.error('[native]   Chạy `npm run build:native` để build.');
  } else {
    const hint = toolchainHint();
    if (hint) {
      for (const t of pending) console.error(`[native] ✗ ${t.name}: ${t.state === 'missing' ? 'chưa build' : 'cũ hơn mã nguồn'}`);
      console.error(`[native]   Không thấy toolchain C++ → bỏ qua bước build. ${hint}`);
      console.error('[native]   App vẫn mở được; phần xử lý native chạy đường dự phòng bằng JS (chậm hơn).');
    } else {
      for (const t of pending) {
        if (!build(`${t.name} ${t.state === 'missing' ? 'chưa build' : 'cũ hơn mã nguồn'}`, t.script)) {
          console.error(`[native] ✗ Build ${t.name} thất bại — chạy \`npm run ${t.script}\` để xem lỗi đầy đủ.`);
          console.error('[native]   App vẫn mở được; phần xử lý native chạy đường dự phòng bằng JS.');
        }
      }
    }
  }

  /* FFmpeg: backend/server.js spawn bằng TÊN TRẦN nên thiếu là mọi đường xuất/preview chết
   * bằng ENOENT — lỗi không hề nhắc tới FFmpeg. Chỉ quét PATH, không spawn: phải rẻ vì đây
   * nằm trên đường đi của mọi lần `npm start`. */
  if (!findOnPath('ffmpeg') || !findOnPath('ffprobe')) {
    console.error('[native] ✗ Không thấy ffmpeg/ffprobe trên PATH — xuất video và preview sẽ lỗi ENOENT.');
    console.error(process.platform === 'darwin'
      ? '[native]   Cài: brew install ffmpeg'
      : '[native]   Cài: winget install Gyan.FFmpeg  (rồi mở lại terminal cho PATH cập nhật)');
  }

  /* Luôn thoát 0: đây là preflight, không phải cổng chặn. */
}

module.exports = { nativeTargets, toolchainHint, build };

/* Chỉ chạy khi được gọi thẳng (`node scripts/preflight_native.js`). Khi setup_dev.js
 * require vào để dùng nativeTargets(), KHÔNG được tự build thêm lần nữa. */
if (require.main === module) main();
