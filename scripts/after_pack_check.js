#!/usr/bin/env node
/* CHỐT CUỐI CỦA ĐÓNG GÓI: bản đóng gói thiếu tệp bắt buộc thì DỪNG, không ra bộ cài.
 *
 * VÌ SAO (bản v1.1.14 phát hành hỏng, người dùng báo 2026-10-09): `static/vendor/` (PIXI vẽ
 * timeline + mammoth đọc .docx) KHÔNG nằm trong git — `.gitignore` có `vendor/` — mà được
 * `npm run prepare:vendor` chép ra từ node_modules lúc `postinstall`. Bản 1.1.14 dựng từ một
 * git worktree sạch với node_modules LIÊN KẾT sang (không `npm install`), nên postinstall
 * không chạy và bộ cài thiếu cả hai tệp. Server trả trang 404 thay cho JS -> "PIXI runtime is
 * missing" -> mã khởi động của trang dừng giữa chừng: Trang chủ trống, mọi nút chết, không
 * mở được dự án nào. electron-builder vẫn báo build THÀNH CÔNG — không có gì chặn lại.
 *
 * Danh sách vendor SUY RA từ chính index.html (mọi <script src="/static/vendor/…">), nên
 * thêm một thư viện vendor mới là tự được canh, không phải nhớ sửa file này.
 * Chạy ở `afterPack`: sau khi chép tệp, TRƯỚC khi đóng thành bộ cài.
 */
'use strict';
const fs = require('fs');
const path = require('path');

function appDirOf(context) {
  const packager = context && context.packager;
  if (packager && typeof packager.getResourcesDir === 'function') {
    return path.join(packager.getResourcesDir(context.appOutDir), 'app');
  }
  return path.join(context.appOutDir, 'resources', 'app');
}

function requiredFiles(appDir, platform) {
  const html = fs.readFileSync(path.join(appDir, 'index.html'), 'utf8');
  const vendor = [...html.matchAll(/<script\s+src="\/(static\/vendor\/[^"?]+)/g)].map((m) => m[1]);
  return [
    ...vendor,
    'native/addon/build/Release/core_c.node',
    platform === 'win32' ? 'native/sidecar/build/core_process.exe' : 'native/sidecar/build/core_process',
  ];
}

function checkPackedApp(appDir, platform) {
  const missing = requiredFiles(appDir, platform).filter((rel) => {
    try { return !(fs.statSync(path.join(appDir, rel)).size > 0); } catch (_) { return true; }
  });
  return { missing };
}

async function afterPack(context) {
  const platform = context.electronPlatformName || process.platform;
  const appDir = appDirOf(context);
  const { missing } = checkPackedApp(appDir, platform);
  if (missing.length) {
    throw new Error(
      `Bản đóng gói THIẾU tệp bắt buộc (app sẽ mở lên trống trơn):\n  - ${missing.join('\n  - ')}\n`
      + 'static/vendor/*: chạy `npm run prepare:vendor` (cần node_modules đã cài đủ). '
      + 'native/*: chạy `npm run build:native`.',
    );
  }
  console.log(`  • after-pack check  ok (${appDir})`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.checkPackedApp = checkPackedApp;
module.exports.requiredFiles = requiredFiles;
