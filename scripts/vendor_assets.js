#!/usr/bin/env node
/* TÊN VÀ VỊ TRÍ CỦA CÁC TỆP NHÚNG SẴN TRONG BỘ CÀI — NGUỒN SỰ THẬT DUY NHẤT.
 *
 * Hai bên phải hiểu GIỐNG HỆT nhau, nếu không thì bước dựng ghi ra một tên còn bước cài đi
 * tìm một tên khác — và hỏng đó KHÔNG báo lỗi: `stagePython()` chỉ lặng lẽ rơi về nhánh tải
 * từ mạng, tức là mất trắng cái lợi của việc nhúng mà không ai biết.
 *   - scripts/prepare_installer_assets.js  ghi vào đây (máy dựng)
 *   - scripts/setup_runtime.js             đọc từ đây (máy người dùng)
 *
 * PHIÊN BẢN PYTHON CŨNG NẰM Ở ĐÂY vì tên tệp chứa nó. 3.12 là bản CAO NHẤT còn nằm dưới
 * ngưỡng PYTHON_MAX_EXCLUSIVE = 3.13 của scripts/python_requirements.js (mediapipe chưa có
 * wheel cho 3.13+). Nâng số này thì phải nâng cả ngưỡng bên đó, kiểm lại mediapipe/opencv đã
 * có wheel chưa, VÀ chạy lại `npm run assets:installer` để kéo gói mới về.
 */
'use strict';
const path = require('path');

const PYTHON_VERSION = '3.12.10';

// `vendor/` nằm ở gốc dự án nên rơi vào luật bao-tất-cả của electron-builder và được đóng
// gói theo app; .gitignore bỏ qua nó (nhị phân bên thứ ba, tải lại được bất cứ lúc nào).
const VENDOR_DIR = path.resolve(__dirname, '..', 'vendor');

const FILES = {
  python: `python-${PYTHON_VERSION}-embed-amd64.zip`,
  getPip: 'get-pip.py',
};

function vendorAsset(key) {
  const file = FILES[key];
  if (!file) throw new Error(`Không có tài nguyên nhúng tên "${key}".`);
  return file;
}

function vendorPath(key) {
  return path.join(VENDOR_DIR, vendorAsset(key));
}

module.exports = { PYTHON_VERSION, VENDOR_DIR, FILES, vendorAsset, vendorPath };
