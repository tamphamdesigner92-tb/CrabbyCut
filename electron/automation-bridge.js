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
const { ipcMain, screen } = require('electron');

const RPC_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 1024 * 1024;
const SCREENSHOT_MAX_WIDTH = 1600;
const EXPORT_OUTPUT_TTL_MS = 2 * 60_000;

/* PHÍM — tên Claude hay gửi -> keyCode của Electron (accelerator). Chữ/số/F1… đi thẳng. */
const KEY_ALIASES = {
  esc: 'Escape', escape: 'Escape', enter: 'Enter', return: 'Enter', tab: 'Tab', space: 'Space',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
  comma: ',', period: '.', slash: '/', minus: '-', equal: '=',
  bracketleft: '[', bracketright: ']',
};
const MODIFIER_ALIASES = {
  ctrl: 'control', control: 'control', shift: 'shift', alt: 'alt', option: 'alt',
  meta: 'meta', win: 'meta', super: 'meta',
};

/* "Cmd" của app = Ctrl trên Windows/Linux, ⌘ trên macOS (xem static/js/shortcuts.js) — Claude
 * gõ "Cmd+Z" thì phải ra đúng phím mà app đang nghe trên nền tảng này. */
function modifierName(raw) {
  const lower = String(raw).toLowerCase();
  if (lower === 'cmd' || lower === 'command' || lower === 'mod') return process.platform === 'darwin' ? 'meta' : 'control';
  return MODIFIER_ALIASES[lower] || '';
}

function parseKeyCombo(combo) {
  const parts = String(combo || '').split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Thiếu phím');
  const modifiers = new Set();
  for (const raw of parts.slice(0, -1)) {
    const mod = modifierName(raw);
    if (!mod) throw new Error(`Phím bổ trợ lạ: ${raw}`);
    modifiers.add(mod);
  }
  const last = parts[parts.length - 1];
  const keyCode = KEY_ALIASES[last.toLowerCase()] || (last.length === 1 ? last.toUpperCase() : last);
  return { keyCode, modifiers: Array.from(modifiers), printable: last.length === 1 };
}

function mouseModifiers(list) {
  return (Array.isArray(list) ? list : []).map(modifierName).filter(Boolean);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createAutomationBridge({ getWindow, discoveryDir, appInfo }) {
  let server = null;
  let token = '';
  let discoveryFile = '';
  let callSeq = 0;
  const pending = new Map();
  // Toạ độ ảnh chụp -> toạ độ CSS của trang. Ảnh bị thu nhỏ khi cửa sổ rộng hơn 1600px.
  let cssPerShotPx = 1;
  // Đường dẫn xuất video do MCP chọn trước (xem takeExportOutput) — dùng một lần, có hạn.
  let pendingExportOutput = null;

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

  function windowState() {
    const win = getWindow();
    if (!win || win.isDestroyed()) return { open: false };
    return { open: true, minimized: win.isMinimized(), visible: win.isVisible(), focused: win.isFocused() };
  }

  /* Cửa sổ THU NHỎ thì Chromium ngừng vẽ: thao tác vẫn chạy nhưng ảnh chụp là khung cuối
   * trước khi thu nhỏ. `restore` mở lại cửa sổ bằng showInactive — không cướp focus khỏi ứng
   * dụng người dùng đang gõ; mặc định KHÔNG tự làm, chỉ báo `stale`. */
  async function screenshot({ restore = false } = {}) {
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('Cửa sổ chính chưa mở');
    let stale = win.isMinimized();
    if (stale && restore) {
      win.showInactive();
      await delay(500);
      stale = win.isMinimized();
    }
    let image = await win.webContents.capturePage();
    /* Cửa sổ bị thu nhỏ/che khuất thì Chromium ngừng vẽ và capturePage trả ảnh rỗng: ép vẽ
     * lại một khung (stayHidden = không bật cửa sổ lên trước mặt người dùng) rồi chụp lại. */
    if (image.isEmpty()) {
      win.webContents.invalidate();
      await delay(200);
      image = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    }
    if (image.isEmpty()) {
      throw new Error(win.isMinimized()
        ? 'Cửa sổ CrabbyCut đang thu nhỏ nên không chụp được — mở lại cửa sổ.'
        : 'Không chụp được cửa sổ (ảnh rỗng).');
    }
    // Đưa ảnh về đúng khổ CSS của trang (bỏ hệ số HiDPI) để toạ độ trên ảnh = toạ độ click;
    // chỉ thu nhỏ thêm khi trang rộng hơn SCREENSHOT_MAX_WIDTH.
    // Khổ CSS suy từ CHÍNH ảnh chụp: getContentSize() trả 0 khi cửa sổ đang thu nhỏ.
    const scaleFactor = (screen.getDisplayMatching(win.getBounds()).scaleFactor || 1) * (win.webContents.getZoomFactor() || 1);
    const cssWidth = Math.max(1, Math.round(image.getSize().width / scaleFactor));
    const targetWidth = Math.min(cssWidth, SCREENSHOT_MAX_WIDTH);
    if (image.getSize().width !== targetWidth) image = image.resize({ width: targetWidth, quality: 'good' });
    const size = image.getSize();
    cssPerShotPx = cssWidth / size.width;
    return {
      mimeType: 'image/jpeg',
      data: image.toJPEG(80).toString('base64'),
      width: size.width,
      height: size.height,
      css_per_pixel: cssPerShotPx,
      stale,
    };
  }

  /* ---- THAO TÁC GIAO DIỆN NHƯ NGƯỜI DÙNG ----
   * sendInputEvent đi qua đúng đường của chuột/bàn phím thật (Chromium tự sinh mousedown/
   * click/keydown…), nên mọi handler của app — kể cả kéo-thả, capture-phase — chạy y như khi
   * người dùng bấm. Toạ độ nhận theo ẢNH CHỤP gần nhất trừ khi `space: 'css'`. */

  function contents() {
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('Cửa sổ chính chưa mở');
    return win.webContents;
  }

  function toCss({ x, y, space } = {}) {
    const nx = Number(x);
    const ny = Number(y);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error('Thiếu toạ độ x, y');
    const k = space === 'css' ? 1 : cssPerShotPx;
    return { x: Math.round(nx * k), y: Math.round(ny * k) };
  }

  async function uiClick(params) {
    const wc = contents();
    const { x, y } = toCss(params);
    const button = ['left', 'right', 'middle'].includes(params.button) ? params.button : 'left';
    const clicks = Math.max(1, Math.min(3, Number(params.clicks) || 1));
    const modifiers = mouseModifiers(params.modifiers);
    wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers });
    for (let n = 1; n <= clicks; n += 1) {
      wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: n, modifiers });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: n, modifiers });
    }
    await delay(150);
    return { clicked: { x, y, button, clicks } };
  }

  async function uiDrag(params) {
    const wc = contents();
    const from = toCss({ ...params.from, space: params.space });
    const to = toCss({ ...params.to, space: params.space });
    const steps = Math.max(2, Math.min(60, Number(params.steps) || 12));
    const modifiers = mouseModifiers(params.modifiers);
    wc.sendInputEvent({ type: 'mouseMove', x: from.x, y: from.y, modifiers });
    wc.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1, modifiers });
    for (let i = 1; i <= steps; i += 1) {
      const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
      const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
      wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers: [...modifiers, 'leftButtonDown'] });
      await delay(16);
    }
    wc.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1, modifiers });
    await delay(150);
    return { dragged: { from, to } };
  }

  async function uiScroll(params) {
    const wc = contents();
    const { x, y } = toCss(params);
    // dy > 0 = cuộn xuống / dx > 0 = sang phải. Bánh xe của Electron dùng dấu ngược lại.
    const deltaX = -Number(params.dx || 0);
    const deltaY = -Number(params.dy || 0);
    const modifiers = mouseModifiers(params.modifiers);
    wc.sendInputEvent({ type: 'mouseMove', x, y, modifiers });
    wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX, deltaY, canScroll: true, modifiers });
    await delay(150);
    return { scrolled: { x, y, dx: params.dx || 0, dy: params.dy || 0 } };
  }

  async function uiKey(params) {
    const wc = contents();
    const repeat = Math.max(1, Math.min(50, Number(params.repeat) || 1));
    const { keyCode, modifiers, printable } = parseKeyCombo(params.keys);
    const typesChar = printable && !modifiers.some((m) => m === 'control' || m === 'meta' || m === 'alt');
    for (let i = 0; i < repeat; i += 1) {
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      if (typesChar) wc.sendInputEvent({ type: 'char', keyCode: modifiers.includes('shift') ? keyCode : keyCode.toLowerCase(), modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    }
    await delay(150);
    return { pressed: params.keys, repeat };
  }

  async function uiType(params) {
    const text = String(params.text ?? '');
    if (!text) throw new Error('Thiếu "text"');
    // insertText = đường của bộ gõ (IME): ra đúng tiếng Việt có dấu, bắn sự kiện `input`.
    await contents().insertText(text);
    await delay(80);
    return { typed: text.length };
  }

  function setExportOutput({ path: target } = {}) {
    const file = String(target || '');
    if (!path.isAbsolute(file)) throw new Error('"path" phải là đường dẫn tuyệt đối');
    if (!fs.existsSync(path.dirname(file))) throw new Error(`Thư mục không tồn tại: ${path.dirname(file)}`);
    pendingExportOutput = { file, expires: Date.now() + EXPORT_OUTPUT_TTL_MS };
    return { output: file };
  }

  /* Gọi từ handler 'export-pick-output' ở main.js: có đường dẫn MCP đặt trước thì dùng nó thay
   * cho hộp thoại Lưu. Đuôi tệp luôn theo loại xuất (mp4/mov/âm thanh) — backend kiểm cả đuôi. */
  function takeExportOutput(extension) {
    const entry = pendingExportOutput;
    pendingExportOutput = null;
    if (!entry || entry.expires < Date.now()) return '';
    const ext = `.${extension}`;
    if (path.extname(entry.file).toLowerCase() === ext) return entry.file;
    const parsed = path.parse(entry.file);
    return path.join(parsed.dir, `${parsed.name}${ext}`);
  }

  // Lệnh main tự xử lý; còn lại chuyển cho renderer (static/js/automation-bridge.js).
  const MAIN_METHODS = {
    ping: async () => ({ pong: true, ...appInfo(), window: windowState() }),
    screenshot,
    ui_scale: async () => ({ css_per_pixel: cssPerShotPx }),
    ui_click: uiClick,
    ui_drag: uiDrag,
    ui_scroll: uiScroll,
    ui_key: uiKey,
    ui_type: uiType,
    export_set_output: async (params) => setExportOutput(params),
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

  return { start, stop, isRunning: () => !!server, takeExportOutput };
}

module.exports = { createAutomationBridge };
