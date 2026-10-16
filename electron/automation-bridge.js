// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* CẦU NỐI TỰ ĐỘNG HOÁ — cho MCP server (mcp/crabbycut-mcp.js) điều khiển app đang chạy.
 *
 * TẮT MẶC ĐỊNH. Renderer bật/tắt theo Cài đặt › Chung › "Cho phép Claude điều khiển"
 * (general.automationBridge) qua IPC `automation-set-enabled`. Tắt = không có cổng nào mở.
 *
 * GIAO THỨC. HTTP trên 127.0.0.1, cổng NGẪU NHIÊN (listen(0)), mỗi lượt bật một token mới:
 *   POST /rpc  { method, params }  -> { ok: true, result } | { ok: false, error }
 *   Header bắt buộc: Authorization: Bearer <token>
 * Cổng + token ghi vào <appDataRoot>/automation/bridge-<pid>.json — CÙNG một thư mục cho bản
 * chạy từ mã nguồn lẫn bản đã cài (appDataRoot không phụ thuộc isPackaged), nên MCP server tìm
 * được cả hai mà không cần cấu hình. Tệp bị xoá khi tắt cầu nối hoặc thoát app.
 *
 * VÌ SAO KHÔNG ĐỂ MCP SERVER GỌI THẲNG BACKEND (cổng 17219). Trạng thái dựng phim (timeline,
 * lane overlay, undo) sống trong RENDERER, backend chỉ xử lý media không giữ trạng thái. Lệnh
 * nào đụng timeline phải đi vào renderer — main chỉ chuyển tiếp, trừ vài lệnh main tự làm
 * được (ping, chụp màn hình cửa sổ).
 *
 * AN TOÀN. Chỉ nghe 127.0.0.1; từ chối Host lạ (chặn DNS rebinding từ trang web) và mọi yêu
 * cầu sai token; tệp khám phá chỉ chủ tài khoản đọc được (0600 trên macOS/Linux; Windows để
 * dưới %LOCALAPPDATA% vốn đã riêng tư theo người dùng). */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ipcMain } = require('electron');

const RPC_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;
const SCREENSHOT_MAX_WIDTH = 1600;

function createAutomationBridge({ getWindow, discoveryDir, appInfo }) {
  let server = null;
  let token = '';
  let discoveryFile = '';
  let callSeq = 0;
  const pending = new Map();

  ipcMain.on('automation-reply', (_event, { id, ok, result, error } = {}) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    if (ok) entry.resolve(result);
    else entry.reject(new Error(String(error || 'renderer error')));
  });

  function callRenderer(method, params) {
    const win = getWindow();
    if (!win || win.isDestroyed()) return Promise.reject(new Error('Cửa sổ chính chưa mở'));
    const id = `a${++callSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Renderer không trả lời "${method}" sau ${RPC_TIMEOUT_MS / 1000}s`));
      }, RPC_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      win.webContents.send('automation-call', { id, method, params: params || {} });
    });
  }

  async function screenshot() {
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('Cửa sổ chính chưa mở');
    let image = await win.webContents.capturePage();
    const { width } = image.getSize();
    if (width > SCREENSHOT_MAX_WIDTH) image = image.resize({ width: SCREENSHOT_MAX_WIDTH, quality: 'good' });
    const size = image.getSize();
    return { mimeType: 'image/jpeg', data: image.toJPEG(80).toString('base64'), width: size.width, height: size.height };
  }

  // Lệnh main tự xử lý; còn lại chuyển cho renderer (static/js/automation-bridge.js).
  const MAIN_METHODS = {
    ping: async () => ({ pong: true, ...appInfo() }),
    screenshot,
  };

  async function dispatch(method, params) {
    if (typeof method !== 'string' || !method) throw new Error('Thiếu "method"');
    if (Object.prototype.hasOwnProperty.call(MAIN_METHODS, method)) return MAIN_METHODS[method](params || {});
    return callRenderer(method, params);
  }

  function sendJson(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  function tokenMatches(header) {
    const given = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(token);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  function handleRequest(req, res) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') return sendJson(res, 403, { ok: false, error: 'host' });
    if (!tokenMatches(req.headers.authorization)) return sendJson(res, 401, { ok: false, error: 'token' });
    if (req.method !== 'POST' || req.url !== '/rpc') return sendJson(res, 404, { ok: false, error: 'not found' });

    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {
        return sendJson(res, 400, { ok: false, error: 'JSON không hợp lệ' });
      }
      try {
        const result = await dispatch(body.method, body.params);
        sendJson(res, 200, { ok: true, result: result === undefined ? null : result });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: error?.message || String(error) });
      }
    });
  }

  function writeDiscovery(port) {
    fs.mkdirSync(discoveryDir, { recursive: true });
    discoveryFile = path.join(discoveryDir, `bridge-${process.pid}.json`);
    const info = { port, token, pid: process.pid, startedAt: new Date().toISOString(), ...appInfo() };
    fs.writeFileSync(discoveryFile, JSON.stringify(info, null, 2), { mode: 0o600 });
  }

  function removeDiscovery() {
    if (!discoveryFile) return;
    try { fs.unlinkSync(discoveryFile); } catch (_) { /* đã xoá */ }
    discoveryFile = '';
  }

  function start() {
    if (server) return Promise.resolve();
    token = crypto.randomBytes(24).toString('hex');
    server = http.createServer(handleRequest);
    return new Promise((resolve, reject) => {
      server.once('error', (error) => { server = null; reject(error); });
      server.listen(0, '127.0.0.1', () => {
        try { writeDiscovery(server.address().port); } catch (error) { console.error('[automation] discovery:', error); }
        console.log(`[automation] bridge on 127.0.0.1:${server.address().port}`);
        resolve();
      });
    });
  }

  function stop() {
    removeDiscovery();
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Cầu nối đã tắt'));
      pending.delete(id);
    }
    if (!server) return;
    server.close();
    server = null;
    token = '';
  }

  ipcMain.handle('automation-set-enabled', async (_event, enabled) => {
    try {
      if (enabled) await start();
      else stop();
      return { enabled: !!server };
    } catch (error) {
      return { enabled: false, error: error?.message || String(error) };
    }
  });

  return { start, stop, isRunning: () => !!server };
}

module.exports = { createAutomationBridge };
