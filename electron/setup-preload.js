// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* Cầu nối cho cửa sổ thiết lập. Giữ đúng quy ước của electron/preload.js: contextIsolation
 * bật, renderer KHÔNG chạm tới `require` — chỉ thấy đúng những kênh liệt kê ở đây. */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crabSetup', {
  onInit: (fn) => ipcRenderer.on('setup:init', (_event, payload) => fn(payload)),
  onEvent: (fn) => ipcRenderer.on('setup:event', (_event, payload) => fn(payload)),
  onReset: (fn) => ipcRenderer.on('setup:reset', () => fn()),
  start: () => ipcRenderer.send('setup:start'),
  retry: () => ipcRenderer.send('setup:retry'),
  cancel: () => ipcRenderer.send('setup:cancel'),
  finish: () => ipcRenderer.send('setup:finish'),
  openLog: () => ipcRenderer.send('setup:open-log'),
});
