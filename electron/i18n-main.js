// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* ĐA NGÔN NGỮ CHO TIẾN TRÌNH MAIN (hộp thoại gốc, updater, cửa sổ Setup).
 *
 * Dùng CHÍNH static/js/i18n.js + từ điển static/i18n/*.json như renderer và backend. Ngôn ngữ
 * đọc từ settings/app_settings.json theo đúng luật của backend (readAppSettings): chưa có file
 * = cài mới -> 'auto' (theo hệ điều hành); có file mà chưa có mục ngôn ngữ = người dùng cũ ->
 * 'vi'. refresh() được gọi lại mỗi lần cửa sổ chính nạp xong trang, nên đổi ngôn ngữ trong
 * Cài đặt (tải lại giao diện) thì hộp thoại gốc cũng đổi theo mà không phải mở lại app.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const I18n = require('../static/js/i18n.js');

const PROJECT_ROOT = path.resolve(__dirname, '..');

I18n.SUPPORTED.filter((loc) => loc !== 'vi').forEach((loc) => {
  try {
    I18n.register(loc, JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'static', 'i18n', `${loc}.json`), 'utf8')));
  } catch (_) { /* thiếu từ điển -> tiếng Việt */ }
});

function systemLocale() {
  try {
    const list = app.getPreferredSystemLanguages?.() || [];
    if (list[0]) return list[0];
  } catch (_) { /* Electron cũ */ }
  try { return app.getLocale() || ''; } catch (_) { return ''; }
}

// Cùng gốc với backend: CRAB_USER_DATA_DIR (bản đóng gói, đặt ở đầu main.js) hoặc thư mục dự án.
function settingsFile() {
  const root = process.env.CRAB_USER_DATA_DIR ? path.resolve(process.env.CRAB_USER_DATA_DIR) : PROJECT_ROOT;
  return path.join(root, 'settings', 'app_settings.json');
}

function refresh() {
  let language = 'auto';
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    language = raw?.general?.language || 'vi';
  } catch (_) { /* chưa có file -> cài mới */ }
  I18n.setLocale(I18n.resolve(language, systemLocale()));
  initialized = true;
  return I18n.getLocale();
}

/* CHỐT LƯỜI ở lần dịch đầu tiên, không chốt lúc require: updater/setup-window… require file
 * này TRƯỚC khi main.js kịp đặt CRAB_USER_DATA_DIR, chốt sớm là đọc nhầm file cài đặt. */
let initialized = false;
function _t(key, params) {
  if (!initialized) { initialized = true; refresh(); }
  return I18n.t(key, params);
}

module.exports = {
  _t,
  refresh,
  systemLocale,
  getLocale: () => (initialized ? I18n.getLocale() : refresh()),
};
