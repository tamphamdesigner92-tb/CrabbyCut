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
const REQUIREMENTS_MAC = path.join(PROJECT_ROOT, 'requirements-tts-mac.txt');
const SERVER_SCRIPT = path.join(PROJECT_ROOT, 'tts', 'server.py');
const MARKER = '.crab-tts-ready.json';
/* Đổi số này khi bộ gói đổi tới mức môi trường cũ KHÔNG chạy được bản mới -> marker cũ bị coi là
 * chưa cài, panel hiện lại nút "Cài đặt". 2 = v1.1.17: VieNeu v3 Turbo, gỡ F5, torch 2.11 CUDA. */
const ENV_REVISION = 2;
/* torch ghim cứng: torchaudio dừng ở 2.11.0, để pip tự chọn là kéo torch 2.14 + torchaudio 2.11
 * lệch nhau (đúng thứ .venv-tts của máy tác giả từng bị). 2.11.0 có cả cu126 (còn Pascal sm_6x —
 * từ torch 2.8 bản cu128 đã bỏ GTX 10xx) lẫn cu128 (có RTX 50 sm_120). */
const TORCH_VERSION = '2.11.0';
const STALL_MS = 5 * 60 * 1000;
/* Sau dòng "Installing collected packages" pip IM LẶNG tới khi xong cả lượt: chép torch +
 * transformers… (hàng chục nghìn tệp, Defender quét từng tệp) vào thư mục tạm rồi chuyển sang
 * --target. Máy tác giả mất ~5 phút; máy người dùng bị watchdog 5 phút giết giữa chừng ->
 * tts-site trống. Pha này chỉ còn chặn treo thật bằng ngưỡng dài. */
const INSTALL_STALL_MS = 60 * 60 * 1000;

/* MỖI ENGINE NẶNG PHỤ THUỘC MỘT MÔI TRƯỜNG RIÊNG (v1.1.17, người dùng chốt 2026-10-11).
 * Chatterbox ghim torch 2.6 + numpy<2, Qwen3-TTS ghim transformers 4.57 — cả hai xung đột với môi
 * trường chính (torch 2.11, transformers 5.x, numpy 2 của vieneu). Mỗi môi trường chạy CHÍNH
 * tts/server.py bằng python của nó, chỉ mở engine của mình (CRAB_TTS_ENGINES) trên cổng riêng —
 * backend/tts-service.js gửi job tới đúng server theo engine.
 *   main        VieNeu v3/v2 (+ VoxCPM2, Qwen3-TTS, Chatterbox qua MLX trên Mac — mlx-audio chạy được
 *               cả ba nên Mac KHÔNG cần môi trường riêng).
 *   qwen        Qwen3-TTS (gói qwen-tts) — chỉ Windows/Linux.
 *   chatterbox  Chatterbox Multilingual (gói chatterbox-tts) — chỉ Windows/Linux. torch 2.6 không có
 *               bản cu128 nên mọi card NVIDIA đều lấy cu126 (RTX 50 chưa được torch 2.6 hỗ trợ).
 * `revision` của từng môi trường: tăng khi bộ gói đổi tới mức bản cũ không chạy được. */
const ENVS = {
  main: {
    label: 'lồng tiếng', venv: '.venv-tts', site: 'tts-site', requirements: REQUIREMENTS,
    torch: TORCH_VERSION, revision: ENV_REVISION,
  },
  qwen: {
    label: 'Qwen3-TTS', venv: '.venv-tts-qwen', site: 'tts-site-qwen',
    requirements: path.join(PROJECT_ROOT, 'requirements-tts-qwen.txt'),
    torch: '2.11.0', revision: 1, platforms: ['win32', 'linux'], size_mb: 3500,
  },
  chatterbox: {
    label: 'Chatterbox Multilingual', venv: '.venv-tts-chatterbox', site: 'tts-site-chatterbox',
    requirements: path.join(PROJECT_ROOT, 'requirements-tts-chatterbox.txt'),
    torch: '2.6.0', maxCuda: 'cu126', revision: 1, platforms: ['win32', 'linux'], size_mb: 3800,
  },
};
function envSpec(envId) {
  const spec = ENVS[envId || 'main'];
  if (!spec) throw new Error(`Không có môi trường lồng tiếng "${envId}"`);
  return spec;
}
function envSupported(envId) {
  const spec = envSpec(envId);
  return !spec.platforms || spec.platforms.includes(process.platform);
}
function venvDir(envId = 'main') { return path.join(PROJECT_ROOT, envSpec(envId).venv); }
function venvPython(envId = 'main') {
  const dir = venvDir(envId);
  return process.platform === 'win32' ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python');
}
function siteDir(envId = 'main') { return path.join(RuntimePaths.runtimeRoot(), envSpec(envId).site); }

function usingProvisionedRuntime() {
  try {
    return path.resolve(pythonCommand()) === path.resolve(RuntimePaths.runtimePython());
  } catch (_) {
    return false;
  }
}

/* Bản torch hợp với máy này:
 *   · CRAB_TTS_TORCH_INDEX đặt tay -> dùng đúng chỉ mục đó.
 *   · Windows/Linux có card NVIDIA -> CUDA (người dùng chốt 2026-10-11: tự cài, không hỏi).
 *     compute capability < 7.5 (Pascal/Volta) lấy cu126, còn lại cu128.
 *   · Còn lại (kể cả macOS: torch PyPI cho Mac đã có MPS) -> PyPI thường.
 * Đọc compute_cap bằng nvidia-smi (đi kèm driver). Máy không có driver NVIDIA thì lệnh không có
 * -> CPU. Kết quả cache theo tiến trình. */
let torchVariantCache = null;
/* Card NVIDIA mạnh nhất: compute capability + VRAM (MiB). Không có driver -> { cap: 0, memMib: 0 }.
 * Cache theo tiến trình. Dùng cho chọn bản torch và cho "Thiết kế giọng" của Qwen3-TTS (cần >= Volta +
 * >= 7,5 GiB) — panel phải biết trước cả khi server Qwen chưa bật. */
let nvidiaInfoCache = null;
function nvidiaInfo() {
  if (nvidiaInfoCache) return nvidiaInfoCache;
  nvidiaInfoCache = { cap: 0, memMib: 0 };
  if (process.platform === 'darwin') return nvidiaInfoCache;
  try {
    const out = spawnSync('nvidia-smi', ['--query-gpu=compute_cap,memory.total', '--format=csv,noheader,nounits'], {
      windowsHide: true, timeout: 15000, encoding: 'utf8',
    });
    if (out.status !== 0) return nvidiaInfoCache;
    for (const line of String(out.stdout || '').split(/\r?\n/)) {
      const [cap, mem] = line.split(',').map((x) => Number.parseFloat(x));
      if (cap > nvidiaInfoCache.cap) nvidiaInfoCache = { cap, memMib: Number.isFinite(mem) ? mem : 0 };
    }
  } catch (_) { /* không có nvidia-smi */ }
  return nvidiaInfoCache;
}
function nvidiaComputeCap() {
  return nvidiaInfo().cap;
}
function torchVariant() {
  if (torchVariantCache) return torchVariantCache;
  const forced = String(process.env.CRAB_TTS_TORCH_INDEX || '').trim();
  if (forced) {
    const tag = (forced.match(/\/(cu\d+|cpu|rocm[\d.]+)\/?$/) || [])[1] || 'custom';
    torchVariantCache = { id: tag, index: forced, cap: 0 };
  } else {
    const cap = nvidiaComputeCap();
    if (cap > 0) {
      const id = cap < 7.5 ? 'cu126' : 'cu128';
      torchVariantCache = { id, index: `https://download.pytorch.org/whl/${id}`, cap };
    } else {
      torchVariantCache = { id: 'default', index: '', cap: 0 };
    }
  }
  return torchVariantCache;
}

/* PYTHON CHO .venv-tts TRÊN macOS (v1.1.17 — một nguyên nhân khả dĩ của lỗi VoxCPM2).
 * Bản Mac không có Python nhúng, nên venv được tạo từ `python3` trên PATH. App mở từ Finder chỉ
 * có PATH tối thiểu -> đó thường là /usr/bin/python3 của Xcode CLT = 3.9, trong khi mlx-audio
 * cần >= 3.10 (vieneu cũng vậy). Dò thêm các chỗ Homebrew / python.org hay cài, lấy bản đầu
 * tiên >= 3.10; không có thì báo lỗi rõ ràng thay vì để pip chết giữa chừng. */
function pythonAtLeast310(candidate) {
  try {
    const out = spawnSync(candidate, ['-c', 'import sys; print(int(sys.version_info[:2] >= (3, 10)))'], {
      windowsHide: true, timeout: 15000, encoding: 'utf8',
    });
    return out.status === 0 && String(out.stdout || '').trim() === '1';
  } catch (_) {
    return false;
  }
}
function venvBasePython() {
  if (process.platform !== 'darwin') return pythonCommand();
  const minors = ['3.13', '3.12', '3.11', '3.10'];
  const candidates = [
    pythonCommand(),
    ...minors.map((v) => `/opt/homebrew/bin/python${v}`),
    '/opt/homebrew/bin/python3',
    ...minors.map((v) => `/usr/local/bin/python${v}`),
    ...minors.map((v) => `/Library/Frameworks/Python.framework/Versions/${v}/bin/python3`),
  ];
  const found = candidates.find((c) => (c.includes('/') ? fs.existsSync(c) : true) && pythonAtLeast310(c));
  if (!found) {
    throw new Error('Lồng tiếng cần Python 3.10 trở lên, máy này chỉ có bản cũ hơn. Cài Python 3.12 '
      + '(ví dụ `brew install python@3.12` hoặc từ python.org) rồi bấm cài lại.');
  }
  return found;
}

/* Mac chip Apple + macOS 14 -> có wheel MLX cho VoxCPM2. */
function macCanUseMlx() {
  if (process.platform !== 'darwin') return false;
  const arm = process.arch === 'arm64'
    || String(spawnSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).stdout || '').trim() === '1';
  const major = Number.parseInt(String(require('os').release()).split('.')[0], 10);   // Darwin 23 = macOS 14
  return arm && Number.isFinite(major) && major >= 23;
}

/* Bản torch CỦA MỘT MÔI TRƯỜNG: như torchVariant() nhưng hạ xuống trần CUDA của bản torch đó
 * (torch 2.6 không có cu128 -> cu126). */
function envTorchVariant(envId = 'main') {
  const spec = envSpec(envId);
  const base = torchVariant();
  if (spec.maxCuda && base.id === 'cu128') {
    return { ...base, id: spec.maxCuda, index: `https://download.pytorch.org/whl/${spec.maxCuda}` };
  }
  return base;
}

/* Marker còn dùng được không: cùng `revision` và cùng bản torch mà máy này cần. Máy vừa lắp
 * card NVIDIA (hoặc nâng từ bản <= 1.1.16, vốn luôn cài torch CPU) -> cài lại để lên CUDA. */
function markerUsable(file, envId = 'main') {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number(data.revision || 1) < envSpec(envId).revision) return false;
    return String(data.torch_variant || 'default') === envTorchVariant(envId).id;
  } catch (_) {
    return false;
  }
}

/* Interpreter + cách chạy server. `ready` = đã cài xong ít nhất một lần (có marker) hoặc
 * người phát triển tự dựng .venv-tts bằng tay và nó import được gói lõi. */
const importCheckCache = {};
function ttsEnv(envId = 'main') {
  const override = process.env.CRAB_TTS_PYTHON;
  if (envId === 'main' && override && fs.existsSync(override)) {
    return { id: envId, mode: 'custom', python: override, site: '', ready: true, location: override };
  }
  if (!envSupported(envId)) {
    return { id: envId, mode: 'unsupported', python: '', site: '', ready: false, location: '' };
  }
  const python = venvPython(envId);
  if (fs.existsSync(python)) {
    const markerFile = path.join(venvDir(envId), MARKER);
    // Có marker mà marker cũ (bản trước / thiếu CUDA) -> chưa sẵn sàng, KHÔNG rơi về dò import.
    if (fs.existsSync(markerFile)) {
      return { id: envId, mode: 'venv', python, site: '', ready: markerUsable(markerFile, envId), location: venvDir(envId) };
    }
    // Không có marker = người phát triển tự dựng: chỉ môi trường chính được đoán bằng dò import.
    if (envId === 'main' && importCheckCache[envId] === undefined) {
      const probe = spawnSync(python, ['-c', 'import fastapi, uvicorn, soundfile, huggingface_hub'], { windowsHide: true, timeout: 30000 });
      importCheckCache[envId] = probe.status === 0;
    }
    return { id: envId, mode: 'venv', python, site: '', ready: !!importCheckCache[envId], location: venvDir(envId) };
  }
  if (usingProvisionedRuntime()) {
    const site = siteDir(envId);
    return {
      id: envId,
      mode: 'site',
      python: RuntimePaths.runtimePython(),
      site,
      ready: markerUsable(path.join(site, MARKER), envId),
      location: site,
    };
  }
  return { id: envId, mode: 'venv', python, site: '', ready: false, location: venvDir(envId) };
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
    let stallMs = STALL_MS;
    let stalled = false;
    const arm = () => {
      clearTimeout(stall);
      stall = setTimeout(() => {
        stalled = true;
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true });
          else child.kill('SIGKILL');
        } catch (_) { /* no-op */ }
      }, stallMs);
    };
    arm();
    const bufs = { out: '', err: '' };
    const pump = (key, chunk) => {
      const merged = bufs[key] + chunk.toString('utf8');
      const lines = merged.split(/\r\n|\r|\n/);   // pip ghi đè dòng tiến độ bằng \r
      bufs[key] = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        if (/^\s*Installing collected packages/i.test(line)) stallMs = INSTALL_STALL_MS;
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
      else if (stalled) reject(new Error(`${path.basename(command)} ${args.slice(0, 3).join(' ')} bị dừng vì không có tiến triển trong ${Math.round(stallMs / 60000)} phút\n${tail.slice(-10).join('\n')}`));
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

const running = {};

/* Cài (hoặc cài lại) một môi trường. Gọi lúc đang cài thì trả về đúng Promise đang chạy. */
function setupTts({ onEvent, env: envId = 'main' } = {}) {
  if (running[envId]) return running[envId];
  const spec = envSpec(envId);
  const emit = (event) => { try { if (onEvent) onEvent(event); } catch (_) { /* no-op */ } };
  running[envId] = (async () => {
    if (!envSupported(envId)) throw new Error(`${spec.label} không cài trên ${process.platform} (máy Mac dùng bản MLX trong môi trường chính).`);
    const env = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
    };
    const baseFlags = ['--no-warn-script-location', '--timeout', '30', '--retries', '5'];
    // pip đi kèm Python cũ (23.x) chưa có `--progress-bar raw`: chỉ dùng cờ đó SAU khi đã nâng pip.
    const pipFlags = [...baseFlags, '--progress-bar', 'raw'];
    const provisioned = !(envId === 'main' && process.env.CRAB_TTS_PYTHON) && !fs.existsSync(venvPython(envId))
      && usingProvisionedRuntime();
    let python;
    let target = [];
    let markerDir;
    if (provisioned) {
      python = RuntimePaths.runtimePython();
      fs.mkdirSync(siteDir(envId), { recursive: true });
      target = ['--target', siteDir(envId), '--upgrade'];
      markerDir = siteDir(envId);
      env.PIP_CACHE_DIR = path.join(RuntimePaths.runtimeRoot(), 'pip-cache');
    } else {
      if (!fs.existsSync(venvPython(envId))) {
        emit({ type: 'progress', stage: 'venv', message: `Đang tạo môi trường Python cho ${spec.label} (${spec.venv})…` });
        await run(venvBasePython(), ['-m', 'venv', venvDir(envId)], { env });
      }
      python = venvPython(envId);
      markerDir = venvDir(envId);
      emit({ type: 'progress', stage: 'pip', message: 'Đang cập nhật pip…' });
      await run(python, ['-m', 'pip', 'install', '--upgrade', 'pip', ...baseFlags], { env });
    }
    const onLine = pipReader(emit);
    const variant = envTorchVariant(envId);
    const torchVersion = spec.torch;
    // MỘT lệnh pip cho cả torch lẫn phần còn lại. Hai lệnh (torch CUDA trước, `-r` sau) hỏng ở
    // chế độ `--target`: pip không coi gói đã nằm trong thư mục đích là "đã cài" nên lượt `-r`
    // kéo torch CPU từ PyPI về ghi đè bản CUDA vừa cài.
    const torchSpecs = variant.index
      ? [`torch==${torchVersion}+${variant.id}`, `torchaudio==${torchVersion}+${variant.id}`]
      : [`torch==${torchVersion}`, `torchaudio==${torchVersion}`];
    if (variant.id === 'custom') torchSpecs.splice(0, 2, `torch==${torchVersion}`, `torchaudio==${torchVersion}`);
    const indexFlags = variant.index ? ['--extra-index-url', variant.index] : [];
    emit({
      type: 'progress', stage: 'packages',
      message: variant.index
        ? `Đang tải thư viện ${spec.label} + torch GPU (${variant.id}, ~2,6 GB)…`
        : `Đang tải thư viện ${spec.label}…`,
    });
    await run(python, ['-m', 'pip', 'install', ...pipFlags, ...target, ...indexFlags, ...torchSpecs, '-r', spec.requirements], { env, onLine });
    // VoxCPM2 (MLX) cài riêng và KHÔNG được làm hỏng cả lượt: lỗi thì chỉ engine đó báo thiếu gói.
    let voxcpmError = null;
    if (envId === 'main' && macCanUseMlx()) {
      emit({ type: 'progress', stage: 'packages', message: 'Đang tải thư viện VoxCPM2 (MLX)…' });
      try {
        await run(python, ['-m', 'pip', 'install', ...pipFlags, ...target, '-r', REQUIREMENTS_MAC], { env, onLine });
      } catch (error) {
        voxcpmError = String(error?.message || error).slice(-500);
        emit({ type: 'progress', stage: 'packages', message: `Không cài được VoxCPM2 (MLX) — các giọng khác vẫn dùng được. ${voxcpmError}` });
      }
    }
    fs.writeFileSync(path.join(markerDir, MARKER), JSON.stringify({
      installed_at: new Date().toISOString(),
      python,
      mode: provisioned ? 'site' : 'venv',
      env: envId,
      revision: spec.revision,
      torch_variant: variant.id,
      torch_index: variant.index || null,
      torch_version: torchVersion,
      voxcpm_error: voxcpmError,
    }, null, 2));
    delete importCheckCache[envId];
    emit({ type: 'done', message: `Đã cài xong môi trường ${spec.label}.` });
    return ttsEnv(envId);
  })().finally(() => { delete running[envId]; });
  return running[envId];
}

function setupInProgress(envId = 'main') { return !!running[envId]; }

module.exports = {
  ttsEnv, setupTts, setupInProgress, torchVariant, envTorchVariant, envSupported, nvidiaInfo, ENVS,
  SERVER_SCRIPT, REQUIREMENTS, humanBytes, ENV_REVISION, TORCH_VERSION,
};

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
  // `node scripts/setup_tts.js --env qwen` — cài môi trường riêng của một engine.
  const envFlag = process.argv.indexOf('--env');
  const envId = envFlag > 0 ? process.argv[envFlag + 1] : 'main';
  setupTts({
    env: envId,
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
