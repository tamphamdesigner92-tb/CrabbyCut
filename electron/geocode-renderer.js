// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* GEOCODE — dựng ẢNH TĨNH hoặc CHUỖI KHUNG từ mã người dùng viết (HTML/CSS/JS, JavaScript
 * canvas, Python), ở kích thước pixel tuỳ chọn, để đặt lên lane Hình khối như một block.
 *
 * KẾT QUẢ LÀ CACHE: <geocodeCacheDir>/<khoá>/frame_00000.png … + meta.json (ghi CUỐI CÙNG =
 * dấu đã xong). Khoá = sha256(phiên bản engine, ngôn ngữ, mã, cỡ, loại, fps, thời lượng, nền),
 * nên cùng một mã luôn ra cùng một thư mục: mở lại dự án mà thiếu khung thì dựng lại từ mã.
 *
 * HTML / CANVAS — cửa sổ OFFSCREEN + CDP. Hai thứ ĐÃ ĐO trên Electron 31 trước khi chọn
 * (test_temp/geocode_spike, 2026-10-17):
 *   - Windows KẸP cỡ BrowserWindow về vùng làm việc của màn hình (1920×1080 thành 1920×1040,
 *     4K hỏng hẳn), kể cả cửa sổ ẩn. `Emulation.setDeviceMetricsOverride` cho trang khung nhìn
 *     đúng W×H (16×16 … 3840×2160) và chốt devicePixelRatio = 1 — máy HiDPI (Mac Retina,
 *     Windows 125–200 %) không làm khung to gấp đôi.
 *   - `capturePage().toBitmap()` trả BGRA ĐÃ NHÂN TRƯỚC alpha (đỏ 50 % ra R=128, A=128); nhồi
 *     thẳng vào ffmpeg `-pix_fmt bgra` là tối màu mọi vùng bán trong suốt. `Page.captureScreenshot`
 *     trả PNG alpha THẲNG (đỏ 50 % = 255,0,0,128) nên ghi thẳng ra tệp, không qua ffmpeg.
 *   Cửa sổ ẩn KHÔNG offscreen thì Chromium không vẽ -> chụp treo; phải offscreen.
 *
 * ĐỒNG HỒ ẢO — khung chính xác, không phụ thuộc tốc độ máy: script chèn TRƯỚC mã người dùng
 * thay requestAnimationFrame, performance.now, Date, setTimeout/Interval; CSS animation /
 * transition / element.animate() đi qua Web Animations API (pause + currentTime = t). Mỗi
 * khung: __geocodeSeek(t) -> đợi 2 rAF thật + document.fonts.ready -> chụp.
 *
 * PYTHON — Python THẬT của máy (quyết định đã chốt 2026-10-17): pythonCommand() chọn
 * interpreter (runtime của bản cài trên Windows, python3 hệ thống trên Mac).
 * scripts/geocode_py_harness.py gọi frame(t, width, height) và ghi RGBA thô ra stdout, nối ống
 * thẳng vào stdin ffmpeg (PIL cho alpha thẳng nên rawvideo rgba là đúng). Mã Python chạy với
 * TOÀN QUYỀN người dùng — khác HTML/JS (sandbox, session riêng, chặn file:// và localhost).
 *
 * Khung > 1280 px: dựng thêm bản proxy nhỏ (proxy/) cho preview. Bản xuất luôn dùng bản gốc. */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { BrowserWindow, session } = require('electron');
const RuntimePaths = require('../scripts/runtime_paths.js');
const { pythonCommand, pythonEnv, findOnPath, PROJECT_ROOT } = require('../scripts/python_command.js');
const { geocodeCacheDir, frameName, keyDir, FRAME_PATTERN, META_FILE } = require('../scripts/geocode_cache.js');
const { _t } = require('./i18n-main');

// Đổi bất cứ thứ gì làm khung ra khác đi (đồng hồ ảo, harness, cách chụp) thì tăng số này.
const ENGINE_VERSION = 'geocode-1';
const LANGS = ['html', 'canvas', 'python'];
const LIMITS = {
  MIN_SIDE: 16,
  MAX_SIDE: 4096,
  MIN_FPS: 1,
  MAX_FPS: 60,
  // = trần frame_count của sidecar và backend (image_seq): 60 s @60fps, 120 s @30fps.
  MAX_FRAMES: 3600,
  MAX_CODE_BYTES: 512 * 1024,
  PROXY_MAX_SIDE: 1280,
};
const LOAD_TIMEOUT_MS = 20_000;
const FRAME_TIMEOUT_MS = 8_000;
const PYTHON_FIRST_FRAME_TIMEOUT_MS = 60_000;
const PARTITION = 'geocode';

/* ---------------------------------------------------------------- đặc tả */

function fail(message) {
  const error = new Error(message);
  error.geocode = true;
  return error;
}

function intIn(value, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.round(n) !== n || n < min || n > max) {
    throw fail(_t('{label} phải là số nguyên từ {min} đến {max}', { label, min, max }));
  }
  return n;
}

/* Chuẩn hoá + KIỂM đặc tả. Sai thì báo lỗi rõ, không âm thầm kẹp: một nút 450×200 bị kẹp
 * thành cỡ khác là lỗi người dùng chỉ thấy khi nhìn bản xuất. */
function normalizeSpec(raw = {}) {
  const lang = String(raw.lang || '');
  if (!LANGS.includes(lang)) throw fail(_t('Ngôn ngữ GeoCode không hợp lệ: {lang}', { lang }));
  const code = String(raw.code ?? '');
  if (!code.trim()) throw fail(_t('Mã đang trống'));
  if (Buffer.byteLength(code, 'utf8') > LIMITS.MAX_CODE_BYTES) throw fail(_t('Mã quá dài (tối đa 512 KB)'));
  const width = intIn(raw.width, LIMITS.MIN_SIDE, LIMITS.MAX_SIDE, _t('Chiều rộng'));
  const height = intIn(raw.height, LIMITS.MIN_SIDE, LIMITS.MAX_SIDE, _t('Chiều cao'));
  const kind = raw.kind === 'video' ? 'video' : 'image';
  let fps = 0;
  let duration = 0;
  if (kind === 'video') {
    fps = intIn(raw.fps ?? 30, LIMITS.MIN_FPS, LIMITS.MAX_FPS, 'FPS');
    duration = Number(raw.duration);
    const maxDuration = LIMITS.MAX_FRAMES / fps;
    if (!Number.isFinite(duration) || duration < 1 / fps || duration > maxDuration + 1e-9) {
      throw fail(_t('Thời lượng phải từ {min} đến {max} giây ở {fps} fps',
        { min: Math.round((1 / fps) * 1000) / 1000, max: Math.round(maxDuration * 100) / 100, fps }));
    }
    duration = Math.round(duration * 1000) / 1000;
  }
  const bgRaw = String(raw.bg || 'transparent').trim().toLowerCase();
  const bg = bgRaw === 'transparent' ? 'transparent' : (/^#[0-9a-f]{6}$/.test(bgRaw) ? bgRaw : null);
  if (!bg) throw fail(_t('Màu nền phải là "transparent" hoặc dạng #rrggbb'));
  return { lang, code, width, height, kind, fps, duration, bg };
}

function frameCountOf(spec) {
  return spec.kind === 'video' ? Math.max(1, Math.min(LIMITS.MAX_FRAMES, Math.round(spec.duration * spec.fps))) : 1;
}

function renderKey(spec) {
  const payload = JSON.stringify([ENGINE_VERSION, spec.lang, spec.code, spec.width, spec.height,
    spec.kind, spec.fps, spec.duration, spec.bg]);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32);
}

function proxySize(spec) {
  const side = Math.max(spec.width, spec.height);
  if (side <= LIMITS.PROXY_MAX_SIDE) return null;
  const k = LIMITS.PROXY_MAX_SIDE / side;
  // Cạnh chẵn cho bộ co của ffmpeg; tối thiểu 2.
  const even = (v) => Math.max(2, Math.round((v * k) / 2) * 2);
  return { width: even(spec.width), height: even(spec.height) };
}

function readMeta(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8'));
    if (!meta || !Number.isInteger(meta.frame_count) || meta.frame_count < 1) return null;
    // Khung đầu và cuối phải còn trên đĩa (người dùng dọn cache tay giữa chừng).
    if (!fs.existsSync(path.join(dir, frameName(0))) || !fs.existsSync(path.join(dir, frameName(meta.frame_count - 1)))) return null;
    return meta;
  } catch (_) {
    return null;
  }
}

/* Đã có khung cho đặc tả này chưa — không dựng gì. */
function cacheInfo(rawSpec) {
  const spec = normalizeSpec(rawSpec);
  const key = renderKey(spec);
  const dir = keyDir(key);
  const meta = readMeta(dir);
  return { key, dir, cached: !!meta, meta };
}

/* ---------------------------------------------------------------- HTML / canvas */

/* Chạy TRƯỚC mọi mã của người dùng (thẻ <script> đầu tiên trong <head>). Giữ tham chiếu tới rAF
 * THẬT để đợi trình duyệt vẽ xong sau mỗi lần tua. */
function clockScript(spec) {
  const cfg = JSON.stringify({ fps: spec.fps || 0, duration: spec.duration || 0, width: spec.width, height: spec.height });
  return `(() => {
  const cfg = ${cfg};
  const realRaf = window.requestAnimationFrame.bind(window);
  const RealDate = Date;
  const epoch = RealDate.now();
  let now = 0;
  let timerSeq = 0;
  const timers = new Map();
  let rafQueue = [];
  let rafSeq = 0;
  const frameCbs = [];
  const born = new WeakMap();
  performance.now = () => now;
  function VDate(...args) {
    if (!(this instanceof VDate)) return new RealDate(epoch + now).toString();
    return args.length ? new RealDate(...args) : new RealDate(epoch + now);
  }
  VDate.prototype = RealDate.prototype;
  VDate.now = () => epoch + now;
  VDate.parse = RealDate.parse;
  VDate.UTC = RealDate.UTC;
  window.Date = VDate;
  window.requestAnimationFrame = (cb) => { const id = ++rafSeq; rafQueue.push({ id, cb }); return id; };
  window.cancelAnimationFrame = (id) => { rafQueue = rafQueue.filter((r) => r.id !== id); };
  window.setTimeout = (fn, ms, ...args) => { const id = ++timerSeq; timers.set(id, { due: now + Math.max(0, Number(ms) || 0), fn, args, every: 0 }); return id; };
  window.setInterval = (fn, ms, ...args) => { const id = ++timerSeq; const every = Math.max(1, Number(ms) || 0); timers.set(id, { due: now + every, fn, args, every }); return id; };
  window.clearTimeout = (id) => { timers.delete(id); };
  window.clearInterval = (id) => { timers.delete(id); };
  // Hoạt ảnh CSS/WAAPI: đóng dấu "sinh lúc" theo giờ ảo lần đầu thấy nó.
  function stamp(at) {
    for (const a of document.getAnimations()) if (!born.has(a)) born.set(a, at);
  }
  function runTimersUntil(target) {
    for (let guard = 0; guard < 200000; guard += 1) {
      let pick = null;
      for (const [id, tm] of timers) {
        if (tm.due <= target && (!pick || tm.due < pick[1].due || (tm.due === pick[1].due && id < pick[0]))) pick = [id, tm];
      }
      if (!pick) return;
      const [id, tm] = pick;
      now = tm.due;
      if (tm.every) tm.due += tm.every; else timers.delete(id);
      try { if (typeof tm.fn === 'function') tm.fn(...tm.args); } catch (e) { console.error(e); }
      stamp(now);
    }
  }
  const api = {
    t: 0, frame: 0, fps: cfg.fps, duration: cfg.duration, width: cfg.width, height: cfg.height,
    onFrame(cb) { if (typeof cb === 'function') frameCbs.push(cb); },
  };
  window.geocode = api;
  window.__geocodeSeek = async (t, frame) => {
    const target = Math.max(0, Number(t) || 0) * 1000;
    if (frame === 0) stamp(0);
    runTimersUntil(target);
    now = target;
    api.t = target / 1000;
    api.frame = frame;
    const queue = rafQueue;
    rafQueue = [];
    for (const r of queue) { try { r.cb(target); } catch (e) { console.error(e); } }
    for (const cb of frameCbs) { try { await cb(api.t, frame); } catch (e) { console.error(e); } }
    stamp(target);
    for (const a of document.getAnimations()) {
      try { a.pause(); a.currentTime = Math.max(0, target - (born.get(a) || 0)); } catch (_) {}
    }
    try { await document.fonts.ready; } catch (_) {}
    await new Promise((r) => realRaf(() => realRaf(r)));
    return true;
  };
})();`;
}

function scriptTag(js) {
  // Mã chèn của ta không bao giờ chứa "</script"; mã người dùng (canvas) thì có thể -> tách.
  return `<script>${String(js).replace(/<\/script/gi, '<\\/script')}</script>`;
}

function baseStyle(spec) {
  const bg = spec.bg === 'transparent' ? 'transparent' : spec.bg;
  return `<style>html,body{margin:0;padding:0;width:${spec.width}px;height:${spec.height}px;overflow:hidden;background:${bg}}</style>`;
}

/* Trang dựng từ mã: HTML -> chèn đồng hồ + style nền vào đầu <head> (style của người dùng đứng
 * sau nên thắng); canvas -> trang có sẵn <canvas> đúng cỡ, gọi draw(ctx, t, width, height, frame)
 * ở mỗi khung (xoá canvas trước). */
function buildPage(spec) {
  const head = `<meta charset="utf-8">${scriptTag(clockScript(spec))}${baseStyle(spec)}`;
  if (spec.lang === 'canvas') {
    const prelude = `const canvas = document.getElementById('geocode-canvas');
const ctx = canvas.getContext('2d');
const width = ${spec.width};
const height = ${spec.height};`;
    const hook = `if (typeof draw === 'function') {
  geocode.onFrame((t, frame) => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, width, height); ctx.restore(); return draw(ctx, t, width, height, frame); });
} else { console.error('GeoCode: chưa khai báo function draw(ctx, t, width, height, frame)'); }`;
    // Mã người dùng + hook chung MỘT thẻ <script>: `draw` khai bằng const/let vẫn thấy được.
    return `<!doctype html><html><head>${head}</head><body><canvas id="geocode-canvas" width="${spec.width}" height="${spec.height}" style="display:block"></canvas>${scriptTag(`${prelude}\n${spec.code}\n;${hook}`)}</body></html>`;
  }
  const code = spec.code;
  if (/<head[^>]*>/i.test(code)) return code.replace(/<head[^>]*>/i, (m) => `${m}${head}`);
  if (/<html[^>]*>/i.test(code)) return code.replace(/<html[^>]*>/i, (m) => `${m}<head>${head}</head>`);
  return `<!doctype html><html><head>${head}</head><body>${code}</body></html>`;
}

let sessionReady = false;

/* Session RIÊNG cho mã người dùng: không cookie/bộ nhớ chung với app, không đọc tệp cục bộ,
 * không gọi được backend/cổng localhost của app; thư viện + phông qua https thì được. */
function geocodeSession() {
  const ses = session.fromPartition(PARTITION);
  if (sessionReady) return ses;
  sessionReady = true;
  ses.webRequest.onBeforeRequest((details, callback) => {
    let blocked = false;
    try {
      const u = new URL(details.url);
      if (u.protocol === 'file:') blocked = true;
      else if (/^(https?|wss?):$/.test(u.protocol)) {
        const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127\./.test(host)) blocked = true;
      }
    } catch (_) { blocked = true; }
    callback({ cancel: blocked });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.on('will-download', (event) => event.preventDefault());
  return ses;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(fail(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/* Dựng khung bằng trình duyệt. `times` = danh sách giây cần chụp; `writeFrame(i, pngBuffer)`. */
async function renderBrowser(spec, times, { writeFrame, onLog, isCancelled }) {
  geocodeSession();
  const win = new BrowserWindow({
    show: false,
    transparent: true,
    frame: false,
    // Cỡ cửa sổ không quan trọng (khung nhìn do CDP đặt), chỉ cần không vượt màn hình.
    width: Math.min(spec.width, 800),
    height: Math.min(spec.height, 600),
    useContentSize: true,
    skipTaskbar: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: PARTITION,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  const wc = win.webContents;
  wc.setFrameRate(60);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event) => event.preventDefault());
  wc.on('console-message', (_event, level, message, line) => {
    onLog?.({ level: ['debug', 'info', 'warn', 'error'][level] || 'info', message: String(message), line });
  });
  let crashed = '';
  wc.on('render-process-gone', (_event, details) => { crashed = details?.reason || 'crashed'; });
  const dbg = wc.debugger;
  try {
    dbg.attach('1.3');
    const html = buildPage(spec);
    // Nạp trang TRƯỚC rồi mới giả lập cỡ: gửi lệnh Emulation khi chưa có trang làm sập (đã đo).
    await withTimeout(wc.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`),
      LOAD_TIMEOUT_MS, _t('Trang GeoCode không nạp xong sau {s} giây', { s: LOAD_TIMEOUT_MS / 1000 }));
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', { width: spec.width, height: spec.height, deviceScaleFactor: 1, mobile: false });
    await dbg.sendCommand('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    for (let i = 0; i < times.length; i += 1) {
      if (isCancelled()) throw fail(_t('Đã huỷ'));
      if (crashed) throw fail(_t('Trang GeoCode bị sập ({reason})', { reason: crashed }));
      await withTimeout(wc.executeJavaScript(`window.__geocodeSeek(${JSON.stringify(times[i])}, ${i})`, true),
        FRAME_TIMEOUT_MS, _t('Khung {n} chạy quá {s} giây (vòng lặp vô hạn?)', { n: i, s: FRAME_TIMEOUT_MS / 1000 }));
      const shot = await withTimeout(dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        optimizeForSpeed: true,
        fromSurface: true,
        clip: { x: 0, y: 0, width: spec.width, height: spec.height, scale: 1 },
      }), FRAME_TIMEOUT_MS, _t('Không chụp được khung {n}', { n: i }));
      await writeFrame(i, Buffer.from(shot.data, 'base64'));
    }
  } finally {
    try { dbg.detach(); } catch (_) { /* đã tháo */ }
    if (!win.isDestroyed()) win.destroy();
  }
}

/* ---------------------------------------------------------------- Python */

function ffmpegPath() {
  const bundled = RuntimePaths.ffmpegBinary('ffmpeg');
  if (fs.existsSync(bundled)) return bundled;
  return findOnPath('ffmpeg') || 'ffmpeg';
}

function harnessPath() {
  return path.join(PROJECT_ROOT, 'scripts', 'geocode_py_harness.py');
}

/* Kiểm trước khi chạy: có Python không, có Pillow không. Thiếu thì báo kèm lệnh cài (chủ yếu
 * cho Mac — Windows có runtime riêng của bản cài). */
function checkPython() {
  const cmd = pythonCommand();
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, ['-c', 'import sys, PIL; print(sys.version.split()[0], PIL.__version__)'], { env: pythonEnv(), windowsHide: true });
    } catch (error) {
      resolve({ ok: false, cmd, error: error.message });
      return;
    }
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', (error) => resolve({ ok: false, cmd, error: error.message }));
    child.on('close', (code) => resolve(code === 0 ? { ok: true, cmd, version: out.trim() } : { ok: false, cmd, error: out.trim() }));
  });
}

function pythonInstallHint(cmd) {
  const py = process.platform === 'win32' ? 'python' : 'python3';
  return _t('Cài Python 3 và thư viện Pillow rồi thử lại: {command}', { command: `${py} -m pip install pillow numpy` })
    + (cmd ? ` (${_t('đang dùng')}: ${cmd})` : '');
}

/* Python -> stdout (RGBA thô, W×H×4 byte mỗi khung) -> stdin ffmpeg -> PNG. Ống nối thẳng nên
 * Python vẽ khung n+1 trong lúc ffmpeg nén khung n. */
async function renderPython(spec, outDir, frameCount, { onLog, onFrameDone, isCancelled, registerKill, startT = 0 }) {
  const check = await checkPython();
  if (!check.ok) throw fail(`${_t('Không chạy được Python')}: ${String(check.error || '').split('\n').slice(-1)[0]}. ${pythonInstallHint(check.cmd)}`);
  onLog?.({ level: 'info', message: _t('Mã Python chạy bằng {cmd} (Python {version}) với toàn quyền của người dùng.', { cmd: check.cmd, version: check.version }) });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'crabbycut-geocode-'));
  const codeFile = path.join(work, 'geocode_user.py');
  await fsp.writeFile(codeFile, spec.code, 'utf8');
  const frameBytes = spec.width * spec.height * 4;
  const py = spawn(check.cmd, ['-u', harnessPath(), '--code', codeFile, '--width', String(spec.width), '--height', String(spec.height),
    '--frames', String(frameCount), '--fps', String(spec.fps || 30), '--kind', spec.kind, '--bg', spec.bg,
    '--start', String(startT)],
  { cwd: work, env: pythonEnv(), windowsHide: true });
  const ff = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${spec.width}x${spec.height}`, '-r', String(spec.fps || 30), '-i', '-',
    '-start_number', '0', '-c:v', 'png', '-pix_fmt', 'rgba', '-compression_level', '1', path.join(outDir, FRAME_PATTERN)],
  { windowsHide: true });
  const killAll = () => { try { py.kill(); } catch (_) {} try { ff.kill(); } catch (_) {} };
  registerKill(killAll);
  let ffErr = '';
  ff.stderr.on('data', (c) => { ffErr += c; });
  let stderrBuf = '';
  const tail = [];
  py.stderr.setEncoding('utf8');
  py.stderr.on('data', (chunk) => {
    stderrBuf += chunk;
    let nl;
    while ((nl = stderrBuf.indexOf('\n')) >= 0) {
      const line = stderrBuf.slice(0, nl).replace(/\r$/, '');
      stderrBuf = stderrBuf.slice(nl + 1);
      if (line.startsWith('@@geocode ')) continue;   // dòng điều khiển của harness
      tail.push(line);
      if (tail.length > 40) tail.shift();
      onLog?.({ level: 'info', message: line });
    }
  });
  // Đếm khung theo SỐ BYTE đã qua ống — tiến độ thật, không phụ thuộc harness tự báo.
  let passed = 0;
  let lastReported = 0;
  let firstFrameTimer = setTimeout(() => {
    if (passed < frameBytes) { onLog?.({ level: 'error', message: _t('Khung đầu tiên quá {s} giây — đã dừng.', { s: PYTHON_FIRST_FRAME_TIMEOUT_MS / 1000 }) }); killAll(); }
  }, PYTHON_FIRST_FRAME_TIMEOUT_MS);
  py.stdout.on('data', (chunk) => {
    passed += chunk.length;
    if (!ff.stdin.write(chunk)) {
      py.stdout.pause();
      ff.stdin.once('drain', () => py.stdout.resume());
    }
    const done = Math.floor(passed / frameBytes);
    if (done > lastReported) {
      lastReported = done;
      if (firstFrameTimer) { clearTimeout(firstFrameTimer); firstFrameTimer = null; }
      onFrameDone?.(Math.min(done, frameCount));
    }
    if (isCancelled()) killAll();
  });
  py.stdout.on('end', () => { try { ff.stdin.end(); } catch (_) {} });
  ff.stdin.on('error', () => { /* ffmpeg chết sớm: lỗi báo ở exit code */ });
  const exit = (child) => new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: -1, error }));
    child.on('close', (code) => resolve({ code }));
  });
  const [pyExit, ffExit] = await Promise.all([exit(py), exit(ff)]);
  if (firstFrameTimer) clearTimeout(firstFrameTimer);
  fsp.rm(work, { recursive: true, force: true }).catch(() => {});
  if (isCancelled()) throw fail(_t('Đã huỷ'));
  if (pyExit.code !== 0) {
    const reason = pyExit.error ? pyExit.error.message : tail.filter(Boolean).slice(-6).join('\n');
    throw fail(`${_t('Mã Python lỗi')}:\n${reason || `exit ${pyExit.code}`}`);
  }
  if (ffExit.code !== 0) throw fail(`${_t('ffmpeg không ghi được khung')}: ${(ffExit.error?.message || ffErr).trim().slice(-400)}`);
  if (passed !== frameBytes * frameCount) {
    throw fail(_t('Python trả {got} byte, cần {want} ({n} khung × {w}×{h}×4)',
      { got: passed, want: frameBytes * frameCount, n: frameCount, w: spec.width, h: spec.height }));
  }
}

/* ---------------------------------------------------------------- proxy + job */

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(fail(`ffmpeg: ${err.trim().slice(-400)}`))));
  });
}

async function buildProxy(dir, spec) {
  const size = proxySize(spec);
  if (!size) return null;
  const out = path.join(dir, 'proxy');
  await fsp.mkdir(out, { recursive: true });
  await runFfmpeg(['-start_number', '0', '-i', path.join(dir, FRAME_PATTERN),
    '-vf', `scale=${size.width}:${size.height}:flags=bicubic`, '-start_number', '0', '-c:v', 'png', '-pix_fmt', 'rgba',
    '-compression_level', '1', path.join(out, FRAME_PATTERN)]);
  return size;
}

const jobs = new Map();
let queue = Promise.resolve();

/* Dựng (hoặc lấy cache) cho một đặc tả. Chạy TUẦN TỰ (một cửa sổ offscreen / một Python mỗi
 * lúc) — dựng song song vài bản 4K là đủ ngốn hết RAM. */
function render(rawSpec, { jobId = '', onProgress, onLog } = {}) {
  const spec = normalizeSpec(rawSpec);
  const key = renderKey(spec);
  const dir = keyDir(key);
  const job = { id: jobId || key, cancelled: false, kill: null };
  if (jobId) jobs.set(jobId, job);
  const run = async () => {
    try {
      const cached = readMeta(dir);
      if (cached) return { key, dir, cached: true, ...cached };
      const total = frameCountOf(spec);
      const tmp = `${dir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
      await fsp.mkdir(tmp, { recursive: true });
      const started = Date.now();
      try {
        onProgress?.({ stage: 'frames', done: 0, total });
        const isCancelled = () => job.cancelled;
        if (spec.lang === 'python') {
          await renderPython(spec, tmp, total, {
            onLog,
            isCancelled,
            onFrameDone: (done) => onProgress?.({ stage: 'frames', done, total }),
            registerKill: (fn) => { job.kill = fn; },
          });
        } else {
          const times = Array.from({ length: total }, (_, i) => (spec.kind === 'video' ? i / spec.fps : 0));
          await renderBrowser(spec, times, {
            onLog,
            isCancelled,
            writeFrame: async (i, png) => {
              await fsp.writeFile(path.join(tmp, frameName(i)), png);
              onProgress?.({ stage: 'frames', done: i + 1, total });
            },
          });
        }
        if (job.cancelled) throw fail(_t('Đã huỷ'));
        onProgress?.({ stage: 'proxy', done: total, total });
        const proxy = await buildProxy(tmp, spec);
        const meta = {
          key, engine: ENGINE_VERSION, lang: spec.lang, kind: spec.kind, width: spec.width, height: spec.height,
          fps: spec.fps, duration: spec.duration, frame_count: total, proxy, render_ms: Date.now() - started,
          created: new Date().toISOString(),
        };
        await fsp.writeFile(path.join(tmp, META_FILE), JSON.stringify(meta, null, 1));
        // Đổi tên = công bố nguyên khối. Có bản khác vừa dựng xong cùng khoá thì dùng bản đó.
        try {
          await fsp.rename(tmp, dir);
        } catch (error) {
          if (!readMeta(dir)) throw error;
          await fsp.rm(tmp, { recursive: true, force: true });
        }
        return { key, dir, cached: false, ...(readMeta(dir) || meta) };
      } catch (error) {
        await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    } finally {
      if (jobId) jobs.delete(jobId);
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

function cancel(jobId) {
  const job = jobs.get(String(jobId || ''));
  if (!job) return false;
  job.cancelled = true;
  try { job.kill?.(); } catch (_) { /* đã thoát */ }
  return true;
}

/* XEM THỬ: dựng MỘT khung ở giây `t` (không ghi cache) để sửa mã cho nhanh. */
async function previewFrame(rawSpec, t = 0, { onLog } = {}) {
  const spec = normalizeSpec({ ...rawSpec });
  const at = spec.kind === 'video' ? Math.max(0, Math.min(Number(t) || 0, spec.duration)) : 0;
  if (spec.lang === 'python') {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'crabbycut-geocode-preview-'));
    try {
      await renderPython(spec, tmp, 1, { onLog, isCancelled: () => false, registerKill: () => {}, startT: at });
      return { png: await fsp.readFile(path.join(tmp, frameName(0))), t: at };
    } finally {
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  let png = null;
  await renderBrowser(spec, [at], { onLog, isCancelled: () => false, writeFrame: async (_i, buf) => { png = buf; } });
  return { png, t: at };
}

module.exports = {
  ENGINE_VERSION,
  LIMITS,
  normalizeSpec,
  renderKey,
  frameCountOf,
  proxySize,
  buildPage,
  cacheInfo,
  render,
  cancel,
  previewFrame,
  checkPython,
  geocodeCacheDir,
};
