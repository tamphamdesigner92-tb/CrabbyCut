#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* MÔI TRƯỜNG PYTHON RIÊNG CHO "LỒNG TIẾNG" (tts/server.py).
 *
 * Vì sao riêng: xem đầu requirements-tts.txt (numpy 2 của vieneu đụng mediapipe của .venv chính,
 * và ~1,5 GB gói mà đa số người dùng không cần).
 *
 * HAI KIỂU, tự chọn theo interpreter đang có:
 *   · venv  — chạy từ mã nguồn: tạo `.venv-tts/` cạnh `.venv/` (python -m venv).
 *   · site  — bản cài .exe: Python NHÚNG không có module `venv`, nên cài bằng
 *             `pip install --target runtime/tts-site` rồi server tự thêm thư mục đó vào
 *             sys.path (CRAB_TTS_SITE). PYTHONPATH không dùng được vì tệp ._pth của bản nhúng
 *             khoá sys.path.
 *
 * Dùng được theo hai đường: `npm run setup:tts` (in tiến trình ra terminal) và
 * backend/tts-service.js (nút "Cài đặt" trong panel Lồng tiếng — tiến trình lên thanh trạng thái).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pythonCommand, PROJECT_ROOT } = require('./python_command.js');
const RuntimePaths = require('./runtime_paths.js');

const REQUIREMENTS = path.join(PROJECT_ROOT, 'requirements-tts.txt');
const SERVER_SCRIPT = path.join(PROJECT_ROOT, 'tts', 'server.py');
const MARKER = '.crab-tts-ready.json';
const STALL_MS = 5 * 60 * 1000;

function venvDir() { return path.join(PROJECT_ROOT, '.venv-tts'); }
function venvPython() {
  const dir = venvDir();
  return process.platform === 'win32' ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python');
}
function siteDir() { return path.join(RuntimePaths.runtimeRoot(), 'tts-site'); }

function usingProvisionedRuntime() {
  try {
    return path.resolve(pythonCommand()) === path.resolve(RuntimePaths.runtimePython());
  } catch (_) {
    return false;
  }
}

/* Interpreter + cách chạy server. `ready` = đã cài xong ít nhất một lần (có marker) hoặc
 * người phát triển tự dựng .venv-tts bằng tay và nó import được gói lõi. */
let importCheckCache = null;
function ttsEnv() {
  const override = process.env.CRAB_TTS_PYTHON;
  if (override && fs.existsSync(override)) {
    return { mode: 'custom', python: override, site: '', ready: true, location: override };
  }
  if (fs.existsSync(venvPython())) {
    const marker = fs.existsSync(path.join(venvDir(), MARKER));
    if (!marker && importCheckCache === null) {
      const probe = spawnSync(venvPython(), ['-c', 'import fastapi, uvicorn, soundfile, huggingface_hub'], { windowsHide: true, timeout: 30000 });
      importCheckCache = probe.status === 0;
    }
    return { mode: 'venv', python: venvPython(), site: '', ready: marker || !!importCheckCache, location: venvDir() };
  }
  if (usingProvisionedRuntime()) {
    const site = siteDir();
    return {
      mode: 'site',
      python: RuntimePaths.runtimePython(),
      site,
      ready: fs.existsSync(path.join(site, MARKER)),
      location: site,
    };
  }
  return { mode: 'venv', python: venvPython(), site: '', ready: false, location: venvDir() };
}

function humanBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

function run(command, args, { env, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: PROJECT_ROOT, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const tail = [];
    let stall = null;
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
          else child.kill('SIGKILL');
        } catch (_) { /* no-op */ }
      }, STALL_MS);
    };
    arm();
    const bufs = { out: '', err: '' };
    const pump = (key, chunk) => {
      const merged = bufs[key] + chunk.toString('utf8');
      const lines = merged.split(/\r\n|\r|\n/);   // pip ghi đè dòng tiến độ bằng \r
      bufs[key] = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        arm();
        if (!/^\s*Progress\s+\d+\s+of\s+\d+/i.test(line)) {
          tail.push(line);
          if (tail.length > 30) tail.shift();
        }
        if (onLine) onLine(line);
      }
    };
    child.stdout.on('data', (c) => pump('out', c));
    child.stderr.on('data', (c) => pump('err', c));
    child.on('error', (error) => { clearTimeout(stall); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(stall);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} ${args.slice(0, 3).join(' ')} thoát với mã ${code}\n${tail.slice(-10).join('\n')}`));
    });
  });
}

/* Đọc dòng pip thành sự kiện tiến trình. `--progress-bar raw` in "Progress <đã tải> of <tổng>"
 * cho TỪNG gói, nên cộng dồn theo gói để có con số tổng đã tải của cả lượt. */
function pipReader(emit) {
  let pkg = '';
  let finishedBytes = 0;
  let currentDone = 0;
  let currentTotal = 0;
  return (line) => {
    const raw = line.match(/^\s*Progress\s+(\d+)\s+of\s+(\d+)/i);
    if (raw) {
      currentDone = Number(raw[1]);
      currentTotal = Number(raw[2]);
      emit({
        type: 'progress', stage: 'download', package: pkg,
        downloaded: finishedBytes + currentDone,
        file_downloaded: currentDone, file_total: currentTotal,
        message: `Đang tải ${pkg ? `${pkg} — ` : ''}${humanBytes(currentDone)} / ${humanBytes(currentTotal)}`,
      });
      return;
    }
    const collecting = line.match(/^\s*(?:Collecting|Downloading)\s+([^\s<>=;(]+)/i);
    if (collecting) {
      if (currentTotal && currentDone >= currentTotal) finishedBytes += currentTotal;
      currentDone = 0;
      currentTotal = 0;
      pkg = collecting[1].replace(/-\d.*$/, '');
      emit({ type: 'progress', stage: 'resolve', package: pkg, downloaded: finishedBytes, message: `Đang tải ${pkg}` });
    } else if (/^\s*Installing collected packages/i.test(line)) {
      emit({ type: 'progress', stage: 'install', downloaded: finishedBytes, message: 'Đang cài đặt các gói đã tải…' });
    }
  };
}

let running = null;

/* Cài (hoặc cài lại) môi trường. Gọi lúc đang cài thì trả về đúng Promise đang chạy. */
function setupTts({ onEvent } = {}) {
  if (running) return running;
  const emit = (event) => { try { if (onEvent) onEvent(event); } catch (_) { /* no-op */ } };
  running = (async () => {
    const env = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
    };
    const baseFlags = ['--no-warn-script-location', '--timeout', '30', '--retries', '5'];
    // pip đi kèm Python cũ (23.x) chưa có `--progress-bar raw`: chỉ dùng cờ đó SAU khi đã nâng pip.
    const pipFlags = [...baseFlags, '--progress-bar', 'raw'];
    const provisioned = !process.env.CRAB_TTS_PYTHON && !fs.existsSync(venvPython()) && usingProvisionedRuntime();
    let python;
    let target = [];
    let markerDir;
    if (provisioned) {
      python = RuntimePaths.runtimePython();
      fs.mkdirSync(siteDir(), { recursive: true });
      target = ['--target', siteDir(), '--upgrade'];
      markerDir = siteDir();
      env.PIP_CACHE_DIR = path.join(RuntimePaths.runtimeRoot(), 'pip-cache');
    } else {
      if (!fs.existsSync(venvPython())) {
        emit({ type: 'progress', stage: 'venv', message: 'Đang tạo môi trường Python cho lồng tiếng (.venv-tts)…' });
        await run(pythonCommand(), ['-m', 'venv', venvDir()], { env });
      }
      python = venvPython();
      markerDir = venvDir();
      emit({ type: 'progress', stage: 'pip', message: 'Đang cập nhật pip…' });
      await run(python, ['-m', 'pip', 'install', '--upgrade', 'pip', ...baseFlags], { env });
    }
    const onLine = pipReader(emit);
    const torchIndex = String(process.env.CRAB_TTS_TORCH_INDEX || '').trim();
    if (torchIndex) {
      // Cài torch TRƯỚC từ chỉ mục CUDA; lượt -r sau thấy torch đã thoả nên không kéo bản CPU.
      emit({ type: 'progress', stage: 'torch', message: `Đang tải torch (${torchIndex})…` });
      await run(python, ['-m', 'pip', 'install', ...pipFlags, ...target, '--index-url', torchIndex, 'torch', 'torchaudio'], { env, onLine });
    }
    emit({ type: 'progress', stage: 'packages', message: 'Đang tải thư viện lồng tiếng (F5-TTS, VieNeu)…' });
    await run(python, ['-m', 'pip', 'install', ...pipFlags, ...target, '-r', REQUIREMENTS], { env, onLine });
    fs.writeFileSync(path.join(markerDir, MARKER), JSON.stringify({
      installed_at: new Date().toISOString(),
      python,
      mode: provisioned ? 'site' : 'venv',
      torch_index: torchIndex || null,
    }, null, 2));
    importCheckCache = null;
    emit({ type: 'done', message: 'Đã cài xong môi trường lồng tiếng.' });
    return ttsEnv();
  })().finally(() => { running = null; });
  return running;
}

function setupInProgress() { return !!running; }

module.exports = { ttsEnv, setupTts, setupInProgress, SERVER_SCRIPT, REQUIREMENTS, humanBytes };

if (require.main === module && process.argv.includes('--serve')) {
  /* `npm run tts:serve`: chạy server tay (gỡ lỗi) bằng đúng interpreter mà backend sẽ dùng. */
  const env = ttsEnv();
  if (!env.ready) {
    process.stderr.write('Chưa có môi trường lồng tiếng — chạy `npm run setup:tts` trước.\n');
    process.exit(1);
  }
  const extra = process.argv.slice(2).filter((a) => a !== '--serve');
  const child = spawn(env.python, [SERVER_SCRIPT, ...extra], {
    cwd: path.dirname(SERVER_SCRIPT),
    stdio: 'inherit',
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      ...(env.site ? { CRAB_TTS_SITE: env.site } : {}),
      CRAB_TTS_MODEL_DIR: process.env.CRAB_TTS_MODEL_DIR || path.join(RuntimePaths.appDataRoot(), 'tts_models'),
    },
  });
  child.on('exit', (code) => process.exit(code || 0));
} else if (require.main === module) {
  let last = '';
  let lastAt = 0;
  setupTts({
    onEvent: (event) => {
      // Dòng tiến độ tải đổi vài lần mỗi giây — in thưa lại cho terminal còn đọc được.
      if (event.stage === 'download' && Date.now() - lastAt < 3000) return;
      if (event.message && event.message !== last) {
        last = event.message;
        lastAt = Date.now();
        process.stdout.write(`${event.message}\n`);
      }
    },
  }).then((env) => {
    process.stdout.write(`\nXong: ${env.location}\n`);
  }).catch((error) => {
    process.stderr.write(`\nCài môi trường lồng tiếng thất bại:\n${error.message}\n`);
    process.exit(1);
  });
}
