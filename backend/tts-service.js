// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* "LỒNG TIẾNG" (tab Âm thanh) — phía Node: bật/tắt server tts/server.py, cài môi trường Python
 * riêng của nó, chuyển tiếp job lồng tiếng, và chép tiến trình TẢI MODEL của server vào sổ
 * backend/model-downloads.js để thanh trạng thái hiện được.
 *
 * VÒNG ĐỜI SERVER:
 *   · Bật LƯỜI ở lượt lồng tiếng / nghe thử / tải model đầu tiên — mở panel thôi thì không bật
 *     (import torch mất vài giây và giữ ~300 MB RAM dù chưa nạp model nào).
 *   · Server nhả model NGAY khi mỗi lượt xong, và backend TẮT luôn tiến trình sau khi panel đọc
 *     kết quả (v1.1.17 — trả cả CUDA context; xem scheduleIdleStop). CRAB_TTS_KEEP_LOADED=1 giữ
 *     server + model ấm như cũ (model tự nhả sau IDLE_UNLOAD_SECONDS).
 *   · Backend tắt -> stop(); backend chết bất thường -> server tự thoát nhờ --parent-pid.
 *
 * CỔNG 4124, không phải 4123 của bản Private: hai bản cùng chạy trên máy tác giả không được
 * giành cổng của nhau — và `health()` còn kiểm chữ ký `app` để khỏi nhận nhầm server lạ.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { pythonEnv } = require('../scripts/python_command.js');
const RuntimePaths = require('../scripts/runtime_paths.js');
const SetupTts = require('../scripts/setup_tts.js');

const _t = (k, p) => ((typeof globalThis._t === 'function')
  ? globalThis._t(k, p)
  : (p ? String(k).replace(/\{(\w+)\}/g, (m, n) => (n in p ? p[n] : m)) : k));

const PORT = Number(process.env.CRAB_TTS_PORT || 4124);
const HOST = '127.0.0.1';
const BOOT_TIMEOUT_MS = 180000;   // lần đầu import torch + vieneu trên HDD có thể mất cả phút

/* Mô tả TĨNH của engine — dùng khi server chưa bật (mở panel không bật server). Phải khớp
 * ENGINES + model_store.MODELS ở phía Python; `size_mb` chỉ để báo "cần tải ~… lần đầu". */
const ENGINES = [
  {
    /* Mặc định từ v1.1.17 (thay F5-TTS). Bộ tệp model theo máy: GPU (CUDA/MPS) dùng đường
     * PyTorch, không có GPU dùng ONNX — khớp VieNeu3Engine.models ở server.py. */
    id: 'vieneu3', label: 'VieNeu-TTS v3 Turbo',
    models_gpu: ['vieneu3-torch', 'moss-nano'], size_mb_gpu: 420,
    models_cpu: ['vieneu3-onnx', 'moss-nano-onnx'], size_mb_cpu: 650,
    clone: true, clone_needs_text: false, voices: [],
  },
  {
    id: 'vieneu', label: 'VieNeu-TTS', models: ['vieneu-tts', 'neucodec-onnx'], size_mb: 900,
    clone: false, voices: ['Ly', 'Ngoc', 'Tuyen', 'Binh', 'Vinh', 'Doan', 'Sơn'],
  },
  {
    id: 'voxcpm', label: 'VoxCPM2', models: ['voxcpm2-8bit'], size_mb: 3300, platforms: ['darwin'],
    clone: false, voices: [], describe: true,
  },
];

let ctx = {
  tempDir: '',
  setStatus: () => {},
  trackChild: () => {},
  untrackChild: () => {},
  publicTempUrl: (p) => p,
  modelDownloads: null,
};
function init(hooks) { ctx = { ...ctx, ...(hooks || {}) }; }

function modelDir() {
  return process.env.CRAB_TTS_MODEL_DIR || path.join(RuntimePaths.appDataRoot(), 'tts_models');
}

let child = null;
let booting = null;
let setupError = '';

// ── HTTP tới server Python ──────────────────────────────────────────────────

function request(method, urlPath, body, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: HOST, port: PORT, path: urlPath, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { detail: text }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else {
          const error = new Error((data && data.detail) || `TTS server HTTP ${res.statusCode}`);
          error.status = res.statusCode;
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('TTS server timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function health() {
  try {
    const data = await request('GET', '/health', undefined, 1500);
    return data && data.app === 'crabbycut-tts' ? data : null;
  } catch (_) {
    return null;
  }
}

function envMissingError() {
  const error = new Error(_t('Chưa cài môi trường lồng tiếng. Bấm "Cài thư viện lồng tiếng" trong panel Lồng tiếng (hoặc chạy npm run setup:tts).'));
  error.code = 'TTS_ENV_MISSING';
  error.status = 409;
  return error;
}

/* Bật server nếu chưa chạy. Gọi đồng thời nhiều lần thì chung một lượt khởi động. */
function ensureServer() {
  if (booting) return booting;
  booting = (async () => {
    if (await health()) return;
    const env = SetupTts.ttsEnv();
    if (!env.ready) throw envMissingError();
    fs.mkdirSync(modelDir(), { recursive: true });
    const proc = spawn(env.python, [SetupTts.SERVER_SCRIPT, '--port', String(PORT), '--parent-pid', String(process.pid)], {
      cwd: path.dirname(SetupTts.SERVER_SCRIPT),
      env: pythonEnv({
        CRAB_TTS_MODEL_DIR: modelDir(),
        ...(env.site ? { CRAB_TTS_SITE: env.site } : {}),
        HF_HUB_DISABLE_PROGRESS_BARS: '1',
        HF_HUB_DISABLE_XET: '1',   // xem đầu tts/model_store.py: xet làm thanh tiến trình đứng im
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = proc;
    ctx.trackChild(proc);
    const tail = [];
    const onData = (prefix) => (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 25) tail.shift();
        // server.py tự gắn "[tts]" cho dòng của nó — đừng gắn thêm lần nữa.
        process.stdout.write(line.startsWith('[tts]') ? `${line}\n` : `${prefix} ${line}\n`);
      }
    };
    proc.stdout.on('data', onData('[tts]'));
    proc.stderr.on('data', onData('[tts:err]'));
    let exited = null;
    proc.on('exit', (code) => {
      exited = code;
      ctx.untrackChild(proc);
      if (child === proc) child = null;
    });
    proc.on('error', (error) => { exited = error.message; });
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited !== null) {
        throw new Error(_t('Server lồng tiếng thoát ngay khi khởi động (mã {code}):\n{log}', { code: exited, log: tail.slice(-8).join('\n') }));
      }
      if (await health()) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    killTree(proc);
    throw new Error(_t('Server lồng tiếng không phản hồi sau {s} giây.', { s: Math.round(BOOT_TIMEOUT_MS / 1000) }));
  })().finally(() => { booting = null; });
  return booting;
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    else proc.kill('SIGTERM');
  } catch (_) { /* no-op */ }
}

async function stop() {
  if (!child) return;
  const proc = child;
  try { await request('POST', '/shutdown', {}, 2000); } catch (_) { /* rơi xuống kill */ }
  setTimeout(() => killTree(proc), 1500);
}

// ── Trạng thái cho panel ────────────────────────────────────────────────────

/* Máy này sẽ chạy VieNeu v3 bằng đường nào — đoán KHÔNG cần bật server: macOS dùng MPS, máy có
 * card NVIDIA (theo setup_tts) dùng CUDA. Server là nguồn đúng khi đã chạy (/v1/engines). */
function gpuPath() {
  return process.platform === 'darwin' || SetupTts.torchVariant().id.startsWith('cu');
}
function staticModels(meta) {
  if (meta.models_gpu) return gpuPath() ? meta.models_gpu : meta.models_cpu;
  return meta.models || [];
}
function staticSizeMb(meta) {
  if (meta.models_gpu) return gpuPath() ? meta.size_mb_gpu : meta.size_mb_cpu;
  return meta.size_mb || 0;
}

/* Danh sách giọng có sẵn của VieNeu v3 đọc thẳng từ tệp JSON của gói `vieneu` đã cài — để panel
 * hiện được giọng mà không phải bật server (import torch mất vài giây + ~300 MB RAM). */
let v3VoicesCache = null;
function vieneu3Voices() {
  if (v3VoicesCache) return v3VoicesCache;
  const env = SetupTts.ttsEnv();
  const roots = [];
  if (env.site) roots.push(env.site);
  if (env.mode === 'venv' && env.location) {
    roots.push(path.join(env.location, 'Lib', 'site-packages'));
    try {
      for (const name of fs.readdirSync(path.join(env.location, 'lib'))) {
        roots.push(path.join(env.location, 'lib', name, 'site-packages'));
      }
    } catch (_) { /* không có lib/ (Windows) */ }
  }
  for (const root of roots) {
    const file = path.join(root, 'vieneu', 'assets', 'voices_v3_turbo.json');
    try {
      const presets = JSON.parse(fs.readFileSync(file, 'utf8')).presets || {};
      const names = Object.keys(presets).sort((a, b) => {
        const fa = presets[a].featured; const fb = presets[b].featured;
        if ((fa == null) !== (fb == null)) return fa == null ? 1 : -1;
        return (fa || 0) - (fb || 0);
      });
      v3VoicesCache = names.map((n) => ({ id: n, label: n, description: String(presets[n].description || '') }));
      return v3VoicesCache;
    } catch (_) { /* thử chỗ kế */ }
  }
  return [];
}

function modelReadyLocally(key) {
  return fs.existsSync(path.join(modelDir(), key, '.crab-model.json'));
}

async function status() {
  const env = SetupTts.ttsEnv();
  const live = await health();
  let engines = null;
  if (live) {
    try { engines = (await request('GET', '/v1/engines', undefined, 60000)).engines; } catch (_) { engines = null; }
  }
  if (!engines) {
    engines = ENGINES.map((e) => {
      const platformOk = !e.platforms || e.platforms.includes(process.platform);
      return {
        id: e.id,
        label: e.label,
        available: platformOk,
        reason: platformOk ? '' : _t('{name} chỉ chạy trên macOS (MLX).', { name: e.label }),
        loaded: false,
        voices: e.id === 'vieneu3' ? vieneu3Voices().map((v) => v.id) : e.voices,
        voice_details: e.id === 'vieneu3' ? vieneu3Voices() : e.voices.map((v) => ({ id: v, label: v, description: '' })),
        models: staticModels(e).map((key) => ({ key, ready: modelReadyLocally(key) })),
      };
    });
  }
  return {
    env: {
      ready: env.ready,
      mode: env.mode,
      location: env.location,
      setup_in_progress: SetupTts.setupInProgress(),
      setup_error: setupError,
    },
    server: { running: !!live, port: PORT, model_root: modelDir() },
    engines: engines.map((e) => {
      const meta = ENGINES.find((s) => s.id === e.id) || {};
      return {
        ...e,
        size_mb: staticSizeMb(meta),
        clone: e.clone != null ? !!e.clone : !!meta.clone,
        clone_needs_text: e.clone_needs_text != null ? !!e.clone_needs_text : !!meta.clone_needs_text,
        describe: !!meta.describe,
      };
    }),
  };
}

// ── Cài môi trường ──────────────────────────────────────────────────────────

const SETUP_DOWNLOAD_ID = 'tts:packages';

function startSetup() {
  if (SetupTts.setupInProgress()) return { started: false, running: true };
  setupError = '';
  const reg = ctx.modelDownloads;
  reg?.begin(SETUP_DOWNLOAD_ID, { label: _t('Thư viện lồng tiếng'), kind: 'packages', message: _t('Đang chuẩn bị…') });
  SetupTts.setupTts({
    onEvent: (event) => {
      if (event.type !== 'progress') return;
      reg?.update(SETUP_DOWNLOAD_ID, {
        message: event.package || '',
        downloaded: event.file_downloaded || 0,
        total: event.file_total || 0,
      });
    },
  }).then(() => {
    reg?.end(SETUP_DOWNLOAD_ID);
    ctx.setStatus(_t('Đã cài xong môi trường lồng tiếng.'));
  }).catch((error) => {
    setupError = String(error.message || error).slice(-1500);
    reg?.end(SETUP_DOWNLOAD_ID, { error: setupError });
    console.error('[tts] setup failed:', error.message);
  });
  return { started: true, running: true };
}

// ── Tải model / job lồng tiếng ──────────────────────────────────────────────

/* Chép tiến trình tải của server vào sổ chung. Gọi mỗi lượt giao diện hỏi /api/model-downloads,
 * nên không cần đồng hồ riêng. Server chưa bật thì kết nối bị từ chối ngay — rẻ. Không chỉ hỏi
 * khi `child` có mặt: người phát triển hay bật server tay bằng `npm run tts:serve`. */
async function syncDownloads() {
  const live = await health();
  if (live && Array.isArray(live.downloads)) ctx.modelDownloads?.syncSnapshot(live.downloads);
}

async function ensureModels(engine) {
  await ensureServer();
  const data = await request('POST', '/v1/models/ensure', { engine });
  await syncDownloads();
  return data;
}

function jobOutputDir() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return path.join(ctx.tempDir, 'editing_assets', 'dubbing', `${stamp}_${Math.random().toString(36).slice(2, 6)}`);
}

async function createJob(params = {}) {
  cancelIdleStop();
  await ensureServer();
  const body = {
    engine: String(params.engine || 'vieneu'),
    voice: params.voice ? String(params.voice) : '',
    ref_audio: params.ref_audio ? String(params.ref_audio) : '',
    ref_text: params.ref_text ? String(params.ref_text) : '',
    speed: Number(params.speed) || 1,
    timing_mode: String(params.timing_mode || 'auto_fit'),
    max_speed: Number(params.max_speed) || 1.45,
    split_clips: !!params.split_clips,
    preview: !!params.preview,
    text: params.text ? String(params.text) : '',
    name: params.name ? String(params.name).slice(0, 80) : '',
    cues: Array.isArray(params.cues) ? params.cues.slice(0, 20000).map((c) => ({
      start: Number(c.start), end: Number(c.end), text: String(c.text || ''),
    })) : [],
    output_dir: jobOutputDir(),
  };
  const job = await request('POST', '/v1/dub/jobs', body);
  return decorate(job);
}

function decorate(job) {
  if (!job || !job.result) return job;
  const withUrl = (item) => (item && item.path ? { ...item, url: ctx.publicTempUrl(item.path) } : item);
  return {
    ...job,
    result: {
      ...job.result,
      full: withUrl(job.result.full),
      clips: (job.result.clips || []).map(withUrl),
    },
  };
}

/* TẮT SERVER SAU MỖI LƯỢT (v1.1.17, người dùng yêu cầu VRAM phải được trả hết khi xong).
 * server.py đã nhả model ngay khi lượt xong, nhưng đo thật trên GTX 1060: VRAM còn dư ~160 MiB
 * (764 -> đỉnh 1556 -> 926 MiB) — đó là CUDA context của tiến trình Python, chỉ mất khi tiến
 * trình thoát. Nên lượt nào xong (panel đã đọc được kết quả) thì tắt hẳn server; lượt sau bật lại
 * (vài giây import). Chờ một nhịp để panel kịp poll lần cuối; không tắt khi đang tải model hay
 * đã có lượt mới. CRAB_TTS_KEEP_LOADED=1 giữ server sống như cũ. */
const IDLE_STOP_DELAY_MS = 3000;
let idleStopTimer = null;
function keepLoaded() {
  return ['1', 'true', 'yes'].includes(String(process.env.CRAB_TTS_KEEP_LOADED || '').trim().toLowerCase());
}
function cancelIdleStop() {
  if (idleStopTimer) clearTimeout(idleStopTimer);
  idleStopTimer = null;
}
function scheduleIdleStop() {
  if (keepLoaded() || !child) return;
  cancelIdleStop();
  idleStopTimer = setTimeout(async () => {
    idleStopTimer = null;
    const live = await health();
    if (!live || live.active_job) return;
    if ((live.downloads || []).some((d) => d.state === 'downloading' || d.state === 'preparing')) return;
    await stop();
  }, IDLE_STOP_DELAY_MS);
}

async function getJob(id) {
  const job = await request('GET', `/v1/dub/jobs/${encodeURIComponent(id)}`);
  await syncDownloads();
  if (job && ['done', 'error', 'cancelled'].includes(job.state)) scheduleIdleStop();
  return decorate(job);
}

async function cancelJob(id) {
  return request('POST', `/v1/dub/jobs/${encodeURIComponent(id)}/cancel`, {});
}

module.exports = {
  init,
  status,
  startSetup,
  ensureServer,
  ensureModels,
  createJob,
  getJob,
  cancelJob,
  syncDownloads,
  stop,
  health,
  modelDir,
  PORT,
  ENGINES,
};
