// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* Cầu nối cho cửa sổ thiết lập. Giữ đúng quy ước của electron/preload.js: contextIsolation
 * bật, renderer KHÔNG chạm tới `require` — chỉ thấy đúng những kênh liệt kê ở đây. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/* Ngôn ngữ + từ điển (xem setupI18nPayload ở setup-window.js). Hỏi ĐỒNG BỘ để có ngay trước
 * khi script của setup.html chạy — dựng danh sách bước là dịch luôn lúc đó. */
let i18n = { locale: 'vi', dict: {} };
try { i18n = ipcRenderer.sendSync('setup:i18n') || i18n; } catch (_) { /* giữ tiếng Việt */ }

contextBridge.exposeInMainWorld('crabSetup', {
  i18n,
  onInit: (fn) => ipcRenderer.on('setup:init', (_event, payload) => fn(payload)),
  onEvent: (fn) => ipcRenderer.on('setup:event', (_event, payload) => fn(payload)),
  onReset: (fn) => ipcRenderer.on('setup:reset', () => fn()),
  start: () => ipcRenderer.send('setup:start'),
  retry: () => ipcRenderer.send('setup:retry'),
  cancel: () => ipcRenderer.send('setup:cancel'),
  finish: () => ipcRenderer.send('setup:finish'),
  openLog: () => ipcRenderer.send('setup:open-log'),
});
