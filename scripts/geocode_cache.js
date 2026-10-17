// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* THƯ MỤC CACHE KHUNG GEOCODE — NGUỒN SỰ THẬT DUY NHẤT cho hai tiến trình:
 *   - electron/geocode-renderer.js (main) GHI khung vào đây;
 *   - backend/server.js PHỤC VỤ khung cho preview (/geocode_cache) và trỏ bản xuất vào đây.
 * Hai bên tự tính đường dẫn thì sớm muộn cũng lệch (dev vs bản cài, test đặt biến môi trường
 * riêng) — preview đen mà không lỗi nào báo.
 *
 * Khung là CACHE TÁI TẠO ĐƯỢC: block GeoCode trong .crab giữ MÃ, thiếu khung thì app tự dựng
 * lại. Nên thư mục này nằm cạnh các cache khác (gốc dữ liệu người dùng), không nằm trong dự án.
 *
 * Gốc: CRAB_GEOCODE_CACHE_DIR (test) > CRAB_USER_DATA_DIR (bản cài, do main.js đặt) > thư mục
 * dự án (chạy từ mã nguồn — cùng quy ước với USER_DATA_ROOT ở backend/server.js). */
'use strict';
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const FRAME_DIGITS = 5;
const FRAME_PATTERN = `frame_%0${FRAME_DIGITS}d.png`;
const META_FILE = 'meta.json';
// Khoá render: hex sha256 rút gọn — không bao giờ chứa ký tự đường dẫn.
const KEY_RE = /^[0-9a-f]{32}$/;

function geocodeCacheDir() {
  if (process.env.CRAB_GEOCODE_CACHE_DIR) return path.resolve(process.env.CRAB_GEOCODE_CACHE_DIR);
  const root = process.env.CRAB_USER_DATA_DIR ? path.resolve(process.env.CRAB_USER_DATA_DIR) : PROJECT_ROOT;
  return path.join(root, 'geocode_cache');
}

function frameName(index) {
  return `frame_${String(Math.max(0, Math.floor(index))).padStart(FRAME_DIGITS, '0')}.png`;
}

// Thư mục khung của một khoá; null nếu khoá sai dạng (chặn "../" từ payload).
function keyDir(key) {
  return KEY_RE.test(String(key || '')) ? path.join(geocodeCacheDir(), String(key)) : null;
}

module.exports = { geocodeCacheDir, frameName, keyDir, FRAME_PATTERN, META_FILE, KEY_RE };
