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
 *
 * NHIỀU SERVER (v1.1.17): Qwen3-TTS và Chatterbox có môi trường Python RIÊNG (xem ENVS ở
 * scripts/setup_tts.js) -> mỗi môi trường một tiến trình server.py trên cổng riêng (4124 chính,
 * 4125 Qwen, 4126 Chatterbox), chỉ mở engine của mình. Mọi hàm ở đây nhận `envId`; job được gửi
 * tới server của engine (engineEnv) và id job được nhớ kèm môi trường để poll/huỷ đúng chỗ.
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
const ENV_PORTS = { main: PORT, qwen: PORT + 1, chatterbox: PORT + 2 };
const ENV_IDS = Object.keys(ENV_PORTS);
/* Engine sống ở môi trường nào — khớp engine_home() ở tts/server.py. Mac chạy Qwen3-TTS và
 * Chatterbox bằng mlx-audio trong môi trường chính. */
function engineEnv(engineId) {
  if (process.platform === 'darwin') return 'main';
  if (engineId === 'qwen3') return 'qwen';
  if (engineId === 'chatterbox') return 'chatterbox';
  return 'main';
}
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
  /* v1.1.17 (người dùng chốt 2026-10-11). Danh sách giọng/ngôn ngữ/chế độ phải khớp Qwen3Engine và
   * ChatterboxEngine ở tts/server.py — dùng khi server của chúng chưa bật. */
  {
    id: 'qwen3', label: 'Qwen3-TTS', clone: true, clone_needs_text: false, instruct: true,
    models: process.platform === 'darwin' ? ['qwen3-0.6b-custom-mlx'] : ['qwen3-0.6b-custom'], size_mb: 2500,
    voices: ['Vivian', 'Serena', 'Uncle_Fu', 'Dylan', 'Eric', 'Ryan', 'Aiden', 'Ono_Anna', 'Sohee'],
    voice_descriptions: {
      Vivian: 'Nữ · tiếng Trung · trẻ, sáng', Serena: 'Nữ · tiếng Trung · dịu dàng',
      Uncle_Fu: 'Nam · tiếng Trung · trầm, từng trải', Dylan: 'Nam · tiếng Trung (Bắc Kinh)',
      Eric: 'Nam · tiếng Trung (Tứ Xuyên)', Ryan: 'Nam · tiếng Anh · khoẻ, nhịp nhanh',
      Aiden: 'Nam · tiếng Anh · trẻ, tươi', Ono_Anna: 'Nữ · tiếng Nhật', Sohee: 'Nữ · tiếng Hàn · ấm',
    },
    languages: ['Auto', 'Chinese', 'English', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian'],
    modes: ['custom', 'clone', 'design'],
  },
  {
    id: 'chatterbox', label: 'Chatterbox Multilingual', clone: true, clone_needs_text: false,
    emotion: true, watermark: true,
    models: process.platform === 'darwin' ? ['chatterbox-mtl-v3-mlx'] : ['chatterbox-mtl'], size_mb: 3200,
    voices: ['default'], voice_labels: { default: 'Giọng mặc định' },
    languages: [
      ['ar', 'Tiếng Ả Rập'], ['da', 'Tiếng Đan Mạch'], ['de', 'Tiếng Đức'], ['el', 'Tiếng Hy Lạp'], ['en', 'Tiếng Anh'],
      ['es', 'Tiếng Tây Ban Nha'], ['fi', 'Tiếng Phần Lan'], ['fr', 'Tiếng Pháp'], ['he', 'Tiếng Do Thái'], ['hi', 'Tiếng Hindi'],
      ['it', 'Tiếng Ý'], ['ja', 'Tiếng Nhật'], ['ko', 'Tiếng Hàn'], ['ms', 'Tiếng Mã Lai'], ['nl', 'Tiếng Hà Lan'],
      ['no', 'Tiếng Na Uy'], ['pl', 'Tiếng Ba Lan'], ['pt', 'Tiếng Bồ Đào Nha'], ['ru', 'Tiếng Nga'], ['sv', 'Tiếng Thụy Điển'],
      ['sw', 'Tiếng Swahili'], ['tr', 'Tiếng Thổ Nhĩ Kỳ'], ['zh', 'Tiếng Trung'],
    ],
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

// Trạng thái từng server (theo môi trường).
const servers = Object.fromEntries(ENV_IDS.map((id) => [id, { child: null, booting: null, idleStopTimer: null }]));
const setupErrors = Object.fromEntries(ENV_IDS.map((id) => [id, '']));
const jobEnvs = new Map();   // job_id -> envId

// ── HTTP tới server Python ──────────────────────────────────────────────────

function request(method, urlPath, body, timeoutMs = 15000, envId = 'main') {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: HOST, port: ENV_PORTS[envId] || PORT, path: urlPath, method,
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

async function health(envId = 'main') {
  try {
    const data = await request('GET', '/health', undefined, 1500, envId);
    return data && data.app === 'crabbycut-tts' ? data : null;
  } catch (_) {
    return null;
  }
}

function envMissingError(envId = 'main') {
  const error = new Error(envId === 'main'
    ? _t('Chưa cài môi trường lồng tiếng. Bấm "Cài thư viện lồng tiếng" trong panel Lồng tiếng (hoặc chạy npm run setup:tts).')
    : _t('Chưa cài {name}. Bấm "Cài thêm {name}" trong panel Lồng tiếng.', { name: SetupTts.ENVS[envId]?.label || envId }));
  error.code = 'TTS_ENV_MISSING';
  error.status = 409;
  return error;
}

/* Bật server của một môi trường nếu chưa chạy. Gọi đồng thời nhiều lần thì chung một lượt. */
function ensureServer(envId = 'main') {
  const server = servers[envId];
  if (server.booting) return server.booting;
  server.booting = (async () => {
    if (await health(envId)) return;
    const env = SetupTts.ttsEnv(envId);
    if (!env.ready) throw envMissingError(envId);
    fs.mkdirSync(modelDir(), { recursive: true });
    const proc = spawn(env.python, [SetupTts.SERVER_SCRIPT, '--port', String(ENV_PORTS[envId]), '--parent-pid', String(process.pid)], {
      cwd: path.dirname(SetupTts.SERVER_SCRIPT),
      env: pythonEnv({
        CRAB_TTS_ENV: envId,
        CRAB_TTS_MODEL_DIR: modelDir(),
        ...(env.site ? { CRAB_TTS_SITE: env.site } : {}),
        HF_HUB_DISABLE_PROGRESS_BARS: '1',
        HF_HUB_DISABLE_XET: '1',   // xem đầu tts/model_store.py: xet làm thanh tiến trình đứng im
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    server.child = proc;
    ctx.trackChild(proc);
    const tail = [];
    const onData = (prefix) => (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 25) tail.shift();
        // server.py tự gắn "[tts]" cho dòng của nó — đừng gắn thêm lần nữa.
        const tag = envId === 'main' ? '' : `[${envId}] `;
        process.stdout.write(line.startsWith('[tts]') ? `${tag}${line}\n` : `${tag}${prefix} ${line}\n`);
      }
    };
    proc.stdout.on('data', onData('[tts]'));
    proc.stderr.on('data', onData('[tts:err]'));
    let exited = null;
    proc.on('exit', (code) => {
      exited = code;
      ctx.untrackChild(proc);
      if (server.child === proc) server.child = null;
    });
    proc.on('error', (error) => { exited = error.message; });
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited !== null) {
        throw new Error(_t('Server lồng tiếng thoát ngay khi khởi động (mã {code}):\n{log}', { code: exited, log: tail.slice(-8).join('\n') }));
      }
      if (await health(envId)) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    killTree(proc);
    throw new Error(_t('Server lồng tiếng không phản hồi sau {s} giây.', { s: Math.round(BOOT_TIMEOUT_MS / 1000) }));
  })().finally(() => { server.booting = null; });
  return server.booting;
}

function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    else proc.kill('SIGTERM');
  } catch (_) { /* no-op */ }
}

// Không truyền envId = tắt mọi server do backend bật (backend đóng).
async function stop(envId) {
  if (!envId) {
    await Promise.all(ENV_IDS.map((id) => stop(id)));
    return;
  }
  const proc = servers[envId].child;
  if (!proc) return;
  try { await request('POST', '/shutdown', {}, 2000, envId); } catch (_) { /* rơi xuống kill */ }
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

/* Model của engine ĐÃ GỠ (F5-TTS ở v1.1.17: Vi-F5-TTS 1,35 GB + Vocos) nằm lại trong kho model của
 * app sau khi nâng cấp — không còn gì dùng tới. Dọn một lần mỗi phiên, CHỈ thư mục do model_store
 * tạo (có marker .crab-model.json) để không bao giờ xoá nhầm thứ người dùng tự đặt vào. */
const OBSOLETE_MODELS = ['f5-vi', 'vocos'];
let obsoletePruned = false;
function pruneObsoleteModels() {
  if (obsoletePruned) return;
  obsoletePruned = true;
  for (const key of OBSOLETE_MODELS) {
    const dir = path.join(modelDir(), key);
    try {
      if (!fs.existsSync(path.join(dir, '.crab-model.json'))) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[tts] đã dọn model của engine đã gỡ: ${dir}`);
    } catch (error) {
      console.warn(`[tts] không dọn được ${dir}: ${error.message}`);
    }
  }
}

function staticEngine(e) {
  const platformOk = !e.platforms || e.platforms.includes(process.platform);
  const voiceDetails = e.id === 'vieneu3' ? vieneu3Voices()
    : (e.voices || []).map((v) => ({
      id: v, label: e.voice_labels?.[v] || String(v).replace(/_/g, ' '), description: e.voice_descriptions?.[v] || '',
    }));
  const out = {
    id: e.id,
    label: e.label,
    available: platformOk,
    reason: platformOk ? '' : _t('{name} chỉ chạy trên macOS (MLX).', { name: e.label }),
    loaded: false,
    voices: voiceDetails.map((v) => v.id),
    voice_details: voiceDetails,
    models: staticModels(e).map((key) => ({ key, ready: modelReadyLocally(key) })),
  };
  if (e.languages) out.languages = e.languages.map((l) => (Array.isArray(l) ? { id: l[0], label: l[1] } : { id: l, label: l }));
  if (e.modes) {
    // Khớp Qwen3Engine.design_available ở server.py: Mac, hoặc GPU từ Volta (fp16/bf16) có >= 7,5 GiB.
    const gpu = SetupTts.nvidiaInfo();
    const designOk = process.platform === 'darwin' || (gpu.cap >= 7.0 && gpu.memMib >= 7.5 * 1024);
    out.modes = e.modes.map((id) => ({
      id,
      available: id !== 'design' || designOk,
      reason: id === 'design' && !designOk
        ? _t('Thiết kế giọng (Qwen3-TTS 1.7B) cần GPU NVIDIA RTX 20 trở lên có từ 8 GB VRAM, hoặc máy Mac chip Apple.')
        : '',
    }));
  }
  if (e.instruct) out.instruct = true;
  if (e.emotion) out.emotion = true;
  if (e.watermark) out.watermark = true;
  return out;
}

function envState(envId) {
  const env = SetupTts.ttsEnv(envId);
  return {
    id: envId,
    ready: env.ready,
    supported: env.mode !== 'unsupported',
    mode: env.mode,
    location: env.location,
    setup_in_progress: SetupTts.setupInProgress(envId),
    torch_variant: SetupTts.envTorchVariant(envId).id,
    setup_error: setupErrors[envId],
    label: SetupTts.ENVS[envId]?.label || envId,
    size_mb: SetupTts.ENVS[envId]?.size_mb || 0,
  };
}

async function status() {
  pruneObsoleteModels();
  const mainEnv = envState('main');
  const envs = {};
  const liveByEnv = {};
  const enginesByEnv = {};
  await Promise.all(ENV_IDS.map(async (envId) => {
    envs[envId] = envState(envId);
    const live = await health(envId);
    liveByEnv[envId] = !!live;
    if (live) {
      try { enginesByEnv[envId] = (await request('GET', '/v1/engines', undefined, 60000, envId)).engines; } catch (_) { /* tĩnh */ }
    }
  }));
  const engines = ENGINES.map((meta) => {
    const envId = engineEnv(meta.id);
    const live = (enginesByEnv[envId] || []).find((e) => e.id === meta.id);
    const e = live || staticEngine(meta);
    return {
      ...e,
      env_id: envId,
      env_ready: envs[envId].ready,
      env_supported: envs[envId].supported,
      env_setup_in_progress: envs[envId].setup_in_progress,
      env_setup_error: envs[envId].setup_error,
      env_size_mb: envId === 'main' ? 0 : envs[envId].size_mb,
      size_mb: staticSizeMb(meta),
      clone: e.clone != null ? !!e.clone : !!meta.clone,
      clone_needs_text: e.clone_needs_text != null ? !!e.clone_needs_text : !!meta.clone_needs_text,
      describe: !!meta.describe,
    };
  });
  return {
    env: {
      ready: mainEnv.ready,
      mode: mainEnv.mode,
      location: mainEnv.location,
      setup_in_progress: mainEnv.setup_in_progress,
      // 'cu126' | 'cu128' | 'default'… — panel báo trước dung lượng tải khi máy sẽ lấy torch GPU.
      torch_variant: mainEnv.torch_variant,
      setup_error: mainEnv.setup_error,
    },
    envs,
    server: { running: liveByEnv.main, port: PORT, model_root: modelDir(), running_envs: liveByEnv },
    engines,
  };
}

// ── Cài môi trường ──────────────────────────────────────────────────────────

function startSetup(envId = 'main') {
  if (!ENV_PORTS[envId]) {
    const error = new Error(`Không có môi trường lồng tiếng "${envId}"`);
    error.status = 400;
    throw error;
  }
  if (SetupTts.setupInProgress(envId)) return { started: false, running: true };
  setupErrors[envId] = '';
  const reg = ctx.modelDownloads;
  const SETUP_DOWNLOAD_ID = envId === 'main' ? 'tts:packages' : `tts:packages:${envId}`;
  const label = envId === 'main' ? _t('Thư viện lồng tiếng') : _t('Thư viện {name}', { name: SetupTts.ENVS[envId].label });
  reg?.begin(SETUP_DOWNLOAD_ID, { label, kind: 'packages', message: _t('Đang chuẩn bị…') });
  SetupTts.setupTts({
    env: envId,
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
    ctx.setStatus(envId === 'main' ? _t('Đã cài xong môi trường lồng tiếng.') : _t('Đã cài xong {name}.', { name: SetupTts.ENVS[envId].label }));
  }).catch((error) => {
    setupErrors[envId] = String(error.message || error).slice(-1500);
    reg?.end(SETUP_DOWNLOAD_ID, { error: setupErrors[envId] });
    console.error(`[tts] setup ${envId} failed:`, error.message);
  });
  return { started: true, running: true };
}

// ── Tải model / job lồng tiếng ──────────────────────────────────────────────

/* Chép tiến trình tải của server vào sổ chung. Gọi mỗi lượt giao diện hỏi /api/model-downloads,
 * nên không cần đồng hồ riêng. Server chưa bật thì kết nối bị từ chối ngay — rẻ. Không chỉ hỏi
 * khi `child` có mặt: người phát triển hay bật server tay bằng `npm run tts:serve`. */
async function syncDownloads() {
  await Promise.all(ENV_IDS.map(async (envId) => {
    const live = await health(envId);
    if (live && Array.isArray(live.downloads)) ctx.modelDownloads?.syncSnapshot(live.downloads);
  }));
}

async function ensureModels(engine, engineOptions) {
  const envId = engineEnv(engine);
  await ensureServer(envId);
  const data = await request('POST', '/v1/models/ensure', { engine, engine_options: plainOptions(engineOptions) }, 15000, envId);
  await syncDownloads();
  return data;
}

/* Tuỳ chọn riêng của engine (ngôn ngữ, chế độ Qwen, cảm xúc Chatterbox…): chỉ nhận khoá chữ và giá
 * trị nguyên thuỷ, chuỗi tối đa 500 ký tự — server.py tự kiểm từng khoá nó dùng. */
function plainOptions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw).slice(0, 20)) {
    if (!/^[a-z_]{1,32}$/.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 500);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

function jobOutputDir() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return path.join(ctx.tempDir, 'editing_assets', 'dubbing', `${stamp}_${Math.random().toString(36).slice(2, 6)}`);
}

async function createJob(params = {}) {
  const engine = String(params.engine || 'vieneu');
  const envId = engineEnv(engine);
  cancelIdleStop(envId);
  await ensureServer(envId);
  const body = {
    engine,
    voice: params.voice ? String(params.voice) : '',
    ref_audio: params.ref_audio ? String(params.ref_audio) : '',
    ref_text: params.ref_text ? String(params.ref_text) : '',
    speed: Number(params.speed) || 1,
    timing_mode: String(params.timing_mode || 'auto_fit'),
    max_speed: Number(params.max_speed) || 1.45,
    // Nghỉ giữa câu khi đọc văn bản không mốc (timing_mode "sequential"); kẹp 0-3 s.
    ...(params.gap != null && Number.isFinite(Number(params.gap)) ? { gap: Math.max(0, Math.min(3, Number(params.gap))) } : {}),
    split_clips: !!params.split_clips,
    preview: !!params.preview,
    text: params.text ? String(params.text) : '',
    name: params.name ? String(params.name).slice(0, 80) : '',
    cues: Array.isArray(params.cues) ? params.cues.slice(0, 20000).map((c) => ({
      start: Number(c.start), end: Number(c.end), text: String(c.text || ''),
    })) : [],
    output_dir: jobOutputDir(),
    engine_options: plainOptions(params.engine_options),
  };
  const job = await request('POST', '/v1/dub/jobs', body, 15000, envId);
  if (job?.job_id) jobEnvs.set(job.job_id, envId);
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
function keepLoaded() {
  return ['1', 'true', 'yes'].includes(String(process.env.CRAB_TTS_KEEP_LOADED || '').trim().toLowerCase());
}
function cancelIdleStop(envId = 'main') {
  const server = servers[envId];
  if (server.idleStopTimer) clearTimeout(server.idleStopTimer);
  server.idleStopTimer = null;
}
function scheduleIdleStop(envId = 'main') {
  const server = servers[envId];
  if (keepLoaded() || !server.child) return;
  cancelIdleStop(envId);
  server.idleStopTimer = setTimeout(async () => {
    server.idleStopTimer = null;
    const live = await health(envId);
    if (!live || live.active_job) return;
    if ((live.downloads || []).some((d) => d.state === 'downloading' || d.state === 'preparing')) return;
    await stop(envId);
  }, IDLE_STOP_DELAY_MS);
}

async function getJob(id) {
  const envId = jobEnvs.get(id) || 'main';
  const job = await request('GET', `/v1/dub/jobs/${encodeURIComponent(id)}`, undefined, 15000, envId);
  await syncDownloads();
  if (job && ['done', 'error', 'cancelled'].includes(job.state)) {
    jobEnvs.delete(id);
    scheduleIdleStop(envId);
  }
  return decorate(job);
}

async function cancelJob(id) {
  return request('POST', `/v1/dub/jobs/${encodeURIComponent(id)}/cancel`, {}, 15000, jobEnvs.get(id) || 'main');
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
  engineEnv,
  PORT,
  ENV_PORTS,
  ENGINES,
};
