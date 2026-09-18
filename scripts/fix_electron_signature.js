#!/usr/bin/env node
/*
 * macOS: bản Electron trong node_modules đôi khi có chữ ký ad-hoc BỊ HỎNG (và có xattr
 * com.apple.provenance/quarantine). Khi đó macOS Library Validation từ chối nạp các dylib
 * (libEGL/libGLESv2...) với lỗi "library load denied by system policy" -> GPU/WebGL chết,
 * app crash "GPU process isn't usable. Goodbye." (SIGTRAP) ngay khi npm start.
 *
 * Script này (chạy trước `electron .` trong npm start, và ở postinstall) sẽ KIỂM TRA chữ ký;
 * nếu hỏng thì xoá xattr + ký lại ad-hoc (deep). Không cần sudo, chỉ tác động binary cục bộ.
 * Chỉ chạy trên macOS; các nền tảng khác bỏ qua.
 */
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

if (process.platform !== 'darwin') process.exit(0);

const appPath = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');
if (!fs.existsSync(appPath)) {
  // Chưa cài electron (vd chạy postinstall của gói khác) -> bỏ qua yên lặng.
  process.exit(0);
}

function signatureValid() {
  try {
    execFileSync('codesign', ['--verify', '--deep', appPath], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

if (signatureValid()) {
  process.exit(0); // Ổn rồi, không làm gì (giữ npm start nhanh).
}

console.log('[electron-sign] Chữ ký Electron không hợp lệ -> xoá xattr + ký lại ad-hoc…');
try { execFileSync('xattr', ['-cr', appPath], { stdio: 'ignore' }); } catch (_) { /* no-op */ }
try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'ignore' });
  console.log(signatureValid()
    ? '[electron-sign] Đã ký lại (hợp lệ). GPU/WebGL sẽ hoạt động.'
    : '[electron-sign] Đã ký lại nhưng verify vẫn báo lỗi — nếu app vẫn crash GPU, đặt CRABBYCUT_DISABLE_GPU=1.');
} catch (e) {
  console.warn('[electron-sign] Ký lại thất bại:', e.message,
    '\n[electron-sign] Nếu app crash GPU, chạy tay: codesign --force --deep --sign - "' + appPath + '"');
}
