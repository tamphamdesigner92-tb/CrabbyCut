#!/usr/bin/env node
/* DỰNG MÔI TRƯỜNG PHÁT TRIỂN BẰNG MỘT LỆNH — `npm run setup`.
 *
 * VÌ SAO CẦN: `npm install` chỉ kéo gói Node và chạy `prepare:vendor`. Ba thứ còn lại mà
 * ứng dụng THẬT SỰ cần để chạy từ mã nguồn đều KHÔNG nằm trong đó:
 *   - native addon (`native/addon/build/Release/core_c.node`) và C++ sidecar — thiếu thì
 *     backend vẫn lên nhưng in "Cannot load native addon" rồi chạy đường chậm, không ai
 *     đọc dòng log đó giữa lúc app đang mở;
 *   - `.venv/` + gói Python — thiếu thì lỗi chỉ nổ ra RẤT MUỘN, giữa lúc bấm nút bóc băng;
 *   - `ffmpeg` trên PATH — backend spawn bằng TÊN TRẦN (backend/server.js), thiếu thì mọi
 *     đường xuất/preview chết bằng ENOENT.
 * Mỗi thứ nằm một tài liệu khác nhau, và người mới clone về không có cách nào biết mình
 * còn thiếu cái nào cho tới khi vấp phải. Script này gom cả bốn bước vào một lệnh, chạy
 * được y hệt nhau trên macOS và Windows.
 *
 * KHÔNG gộp vào `postinstall`. `requirements.txt` kéo `torch` + `openai-whisper` (hàng trăm
 * MB tới vài GB); treo mười mấy phút bên trong một lệnh tên là `npm install` thì không ai
 * đoán được chuyện gì đang xảy ra. Việc cài nặng phải là một lệnh người dùng chủ động gõ —
 * cùng lý do đã ghi ở đầu scripts/preflight_python.js.
 *
 * KHÔNG DỪNG Ở BƯỚC HỎNG ĐẦU TIÊN. Thiếu compiler C++ không có lý do gì ngăn cài gói
 * Python. Mỗi bước tự báo ✓/✗ rồi đi tiếp, và phần tổng kết ở cuối liệt kê đúng những việc
 * còn phải làm tay — thay vì bắt chạy lại `npm run setup` bốn lần để lộ dần bốn vấn đề.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { findOnPath, pythonEnv, PROJECT_ROOT } = require('./python_command.js');
const { nativeTargets } = require('./preflight_native.js');
const {
  modulesForPlatform,
  groupsForPlatform,
  pythonVersionOk,
  PYTHON_MIN,
  PYTHON_MAX_EXCLUSIVE,
} = require('./python_requirements.js');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const SKIP_PYTHON = process.argv.includes('--skip-python') || process.env.CRAB_SKIP_PYTHON === '1';
const SKIP_NATIVE = process.argv.includes('--skip-native') || process.env.CRAB_SKIP_NATIVE === '1';
const pythonFlag = process.argv.find((arg) => arg.startsWith('--python='));

/* CHẾ ĐỘ --auto: nằm trên đường đi của MỌI lần `npm start`.
 *
 * Khác biệt duy nhất so với `npm run setup` gõ tay là ĐỘ ỒN. Máy đã đủ môi trường thì cả
 * bảng ✓ dài mười mấy dòng in ra trước mỗi lần mở app chỉ là nhiễu — lần thứ ba nhìn thấy
 * là không ai đọc nữa, và đó chính là lúc một dòng ✗ lẫn vào giữa sẽ bị bỏ qua. Nên ở chế
 * độ này mọi dòng được GIỮ TRONG BỘ ĐỆM, và chỉ xả ra khi thật sự có việc phải làm (cài,
 * build) hoặc có vấn đề. Không có gì để làm thì chỉ một dòng duy nhất.
 */
const AUTO = process.argv.includes('--auto');

const VENV_DIR = path.join(PROJECT_ROOT, '.venv');
const VENV_PYTHON = IS_WIN
  ? path.join(VENV_DIR, 'Scripts', 'python.exe')
  : path.join(VENV_DIR, 'bin', 'python');
const ADDON = path.join(PROJECT_ROOT, 'native', 'addon', 'build', 'Release', 'core_c.node');
const SIDECAR = path.join(PROJECT_ROOT, 'native', 'sidecar', 'build', IS_WIN ? 'core_process.exe' : 'core_process');

/* HAI MỨC, KHÔNG PHẢI MỘT.
 * `todo` = thứ đang HỎNG và phải sửa mới dùng được đúng tính năng đó.
 * `notes` = thứ vẫn chạy được, chỉ là có thể tốt hơn (vd bản ffmpeg không có zscale: chỉ
 * clip HDR bị ảnh hưởng). Gộp chung hai loại thì một ghi chú vặt cũng đủ kéo cả bảng dài
 * in ra trước MỌI lần `npm start`, và chỉ vài lần là không ai đọc bảng đó nữa — đúng lúc
 * một dòng ✗ thật sự lẫn vào giữa sẽ bị bỏ qua.
 * Mỗi mục là một câu hành động cụ thể, không phải mô tả triệu chứng. */
const todo = [];
const notes = [];
let failed = 0;
/* Bỏ qua theo yêu cầu KHÔNG phải là "đã đủ". Dòng tổng kết một câu ở chế độ --auto phải nói
 * đúng chuyện gì đã xảy ra, nếu không thì lần sau ASR chết mà người dùng vẫn đinh ninh môi
 * trường đầy đủ vì `npm start` vừa in ✓. */
let skippedPython = false;

let buffer = [];
let flushed = false;

function emit(line) {
  if (!AUTO || flushed) console.log(line);
  else buffer.push(line);
}

/* Gọi NGAY TRƯỚC mỗi việc thật sự tốn thời gian (npm install, node-gyp, pip install).
 * Xả bộ đệm ra để người dùng thấy được bối cảnh: biết vì sao `npm start` đang đứng im. */
function flush() {
  if (!AUTO || flushed) return;
  flushed = true;
  for (const line of buffer) console.log(line);
  buffer = [];
}

function step(title) { emit(''); emit(`── ${title}`); }
function ok(msg) { emit(`   ✓ ${msg}`); }
function warn(msg) { flush(); console.log(`   ✗ ${msg}`); failed += 1; }
function info(msg) { emit(`   · ${msg}`); }

/* Báo "sắp làm một việc lâu" — xả đệm rồi mới in, để dòng này không bao giờ đứng trơ trọi
 * không có phần trên nó giải thích đang ở bước nào. */
function acting(msg) { flush(); console.log(`   · ${msg}`); }

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    env: pythonEnv(),
    windowsHide: true,
    /* npm/npx trên Windows là .cmd — không phải file thực thi PE, nên spawn không shell sẽ
     * EINVAL. Bên gọi bật cờ này cho đúng những lệnh đó. */
    shell: opts.shell === true,
    ...opts,
  });
  return !result.error && result.status === 0;
}

function capture(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: PROJECT_ROOT, encoding: 'utf8', env: pythonEnv(), windowsHide: true });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || '').trim();
}

/* ─────────────────────────── 1. Node + gói Node ─────────────────────────── */

function stepNode() {
  step('Node.js và gói npm');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) {
    ok(`Node ${process.versions.node}`);
  } else {
    warn(`Node ${process.versions.node} — cần 20 trở lên (electron 31 và node-gyp 12 đều đòi)`);
    todo.push('Nâng Node lên bản 20+ rồi chạy lại `npm run setup`.');
  }

  if (fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', 'electron'))) {
    ok('node_modules đã có');
  } else {
    acting('node_modules chưa có hoặc chưa đủ → chạy npm install…');
    if (run(IS_WIN ? 'npm.cmd' : 'npm', ['install'], { shell: IS_WIN })) ok('npm install xong');
    else { warn('npm install thất bại'); todo.push('Chạy `npm install` và đọc lỗi của nó.'); }
  }

  /* Binary Electron do postinstall của chính gói electron tải về. Ai lỡ cài bằng
   * `--ignore-scripts` thì thư mục dist trống, và lỗi lộ ra rất muộn dưới dạng
   * "Electron failed to install correctly" ngay lúc `npm start`. */
  const electronDist = path.join(PROJECT_ROOT, 'node_modules', 'electron', 'dist');
  if (fs.existsSync(electronDist)) {
    ok('Electron binary đã tải');
  } else if (fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', 'electron', 'install.js'))) {
    acting('Electron binary chưa có (cài bằng --ignore-scripts?) → tải…');
    if (run(process.execPath, ['install.js'], { cwd: path.join(PROJECT_ROOT, 'node_modules', 'electron') })) ok('Đã tải Electron binary');
    else { warn('Không tải được Electron binary'); todo.push('Xoá node_modules/electron rồi `npm install` lại.'); }
  }
}

/* ─────────────────────────── 2. Vendor assets ─────────────────────────── */

function stepVendor() {
  step('Vendor assets (mammoth, pixi)');
  if (run(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'sync_vendor_assets.js')], { stdio: 'pipe' })) {
    ok('static/vendor đã đồng bộ');
  } else {
    warn('Không đồng bộ được vendor assets');
    todo.push('Chạy `npm run prepare:vendor` và đọc lỗi của nó.');
  }
}

/* ─────────────────────────── 3. Toolchain + native ─────────────────────────── */

/* Toolchain phải kiểm TRƯỚC khi build, không phải để node-gyp tự chết. Lỗi thật của
 * node-gyp khi thiếu Xcode CLT trên macOS là `xcrun: error: invalid active developer path`
 * — không hề nhắc tới việc phải cài gì, và nằm lẫn giữa mấy chục dòng gyp. */
function checkToolchain() {
  if (IS_MAC) {
    const developerDir = capture('xcode-select', ['-p']);
    if (!developerDir) {
      warn('Chưa có Xcode Command Line Tools (node-gyp và sidecar C++ đều cần)');
      todo.push('Cài Command Line Tools: `xcode-select --install` (một lần cho cả máy).');
      return false;
    }
    ok(`Xcode CLT: ${developerDir}`);
    return true;
  }
  if (IS_WIN) {
    /* `cl` chỉ nằm trên PATH bên trong "Developer Command Prompt". Từ terminal thường phải
     * hỏi vswhere — đúng cách mà scripts/build_sidecar.js dùng, giữ hai nơi hiểu giống nhau. */
    if (findOnPath('cl')) { ok('MSVC (cl) có trên PATH'); return true; }
    const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    if (fs.existsSync(vswhere)) {
      const found = capture(vswhere, ['-latest', '-products', '*',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']);
      if (found) { ok(`Visual Studio C++: ${found.split(/\r?\n/)[0]}`); return true; }
    }
    warn('Chưa có toolchain C++ của Visual Studio');
    todo.push('Cài Visual Studio 2022 kèm workload "Desktop development with C++" (native addon BUỘC dùng MSVC vì nạp cùng tiến trình với Electron).');
    return false;
  }
  if (['g++', 'clang++', 'c++'].some(findOnPath)) { ok('Có compiler C++ trên PATH'); return true; }
  warn('Không thấy compiler C++ nào trên PATH');
  todo.push('Cài build-essential (hoặc clang) rồi chạy lại.');
  return false;
}

function stepNative() {
  step('Native addon + C++ sidecar');
  if (SKIP_NATIVE) { info('Bỏ qua theo cờ --skip-native'); return; }

  /* Dùng LẠI phép kiểm của preflight_native.js thay vì chép sang bản thứ hai. Nó phân biệt
   * 'missing' với 'stale' (mã nguồn .cpp mới hơn sản phẩm) — ca thứ hai âm thầm hơn hẳn:
   * sau `git pull` binary cũ vẫn nạp được, chỉ là hành vi không khớp mã nguồn đang đọc. */
  const pending = nativeTargets().filter((t) => t.state !== 'ok');
  if (!pending.length) { ok('addon + sidecar đã có và mới hơn mã nguồn'); return; }

  if (!checkToolchain()) {
    info('Bỏ qua bước build vì thiếu toolchain — app vẫn mở được, chỉ chạy đường chậm hơn.');
    return;
  }
  for (const target of pending) {
    acting(`${target.name}: ${target.state === 'missing' ? 'chưa build' : 'cũ hơn mã nguồn'} → build (lần đầu mất khoảng một phút)…`);
    if (run(IS_WIN ? 'npm.cmd' : 'npm', ['run', target.script], { shell: IS_WIN })) ok(path.relative(PROJECT_ROOT, target.out));
    else { warn(`Build ${target.name} thất bại`); todo.push(`Chạy \`npm run ${target.script}\` để xem lỗi đầy đủ.`); }
  }
}

/* ─────────────────────────── 4. Python ─────────────────────────── */

/* TÌM INTERPRETER HỢP LỆ THAY VÌ IN MỘT LỆNH CỨNG.
 * Hướng dẫn cũ bảo gõ `python3.12 -m venv .venv`, và trên máy chỉ có 3.11 (hoặc cài qua
 * pyenv/uv, nơi không tồn tại tên `python3.12`) thì câu đó chết bằng "command not found" —
 * người dùng không có cách nào biết 3.11 cũng hợp lệ. Ở đây dò lần lượt rồi HỎI CHÍNH
 * INTERPRETER phiên bản của nó, vì tên file không bảo đảm điều gì (`python3` trỏ 3.14 là
 * chuyện thường trên máy có Homebrew).
 */
function pythonCandidates() {
  const names = ['python3.12', 'python3.11', 'python3.10', 'python3.9'];
  const out = [];
  if (pythonFlag) out.push({ cmd: pythonFlag.slice('--python='.length), args: [] });
  if (process.env.CRAB_PYTHON) out.push({ cmd: process.env.CRAB_PYTHON, args: [] });
  if (IS_WIN) {
    /* Launcher `py` là cách DUY NHẤT chọn đúng bản trên Windows: `python` trỏ vào bản mặc
     * định, mà mặc định trên nhiều máy đang là 3.13/3.14 — bản mà mediapipe không có wheel. */
    for (const ver of ['3.12', '3.11', '3.10', '3.9']) out.push({ cmd: 'py', args: [`-${ver}`] });
  }
  for (const name of names) out.push({ cmd: name, args: [] });
  out.push({ cmd: IS_WIN ? 'python' : 'python3', args: [] });
  return out;
}

function interpreterVersion(cmd, args) {
  const probe = spawnSync(cmd, [...args, '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'],
    { encoding: 'utf8', windowsHide: true, env: pythonEnv() });
  if (probe.error || probe.status !== 0) return null;
  const raw = String(probe.stdout || '').trim();
  const parts = raw.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
  return { label: raw, tuple: parts };
}

function findUsablePython() {
  const rejected = [];
  for (const candidate of pythonCandidates()) {
    const version = interpreterVersion(candidate.cmd, candidate.args);
    if (!version) continue;
    if (pythonVersionOk(version.tuple)) return { ...candidate, version };
    rejected.push(`${candidate.cmd}${candidate.args.length ? ' ' + candidate.args.join(' ') : ''} (${version.label})`);
  }
  return { rejected };
}

/* Phép dò y hệt preflight_python.js dùng: find_spec, không import thật — nhanh và không kéo
 * torch vào RAM chỉ để hỏi một câu. */
function missingModules(python) {
  const modules = modulesForPlatform();
  const probe = spawnSync(python, ['-c', [
    'import importlib.util, json, sys',
    'print(json.dumps({n: importlib.util.find_spec(n) is not None for n in sys.argv[1:]}))',
  ].join('\n'), ...modules], { cwd: PROJECT_ROOT, encoding: 'utf8', env: pythonEnv(), windowsHide: true });
  if (probe.error || probe.status !== 0) return null;
  try {
    const found = JSON.parse(String(probe.stdout || '').trim());
    return modules.filter((name) => !found[name]);
  } catch (_) { return null; }
}

function installPython(reason) {
  /* Đây là việc lâu nhất trong cả script — và ở chế độ --auto nó nằm bên trong một lệnh tên
   * là `npm start`. Không nói trước thì người dùng chỉ thấy terminal đứng im mười mấy phút
   * và sẽ Ctrl-C giữa chừng (bỏ lại một venv cài dở, lần sau càng khó hiểu). Nên báo rõ:
   * vì sao, mất bao lâu, chỉ một lần, và cách bỏ qua nếu đang vội. */
  acting(reason);
  if (AUTO) {
    info('Lần đầu có thể mất 5–20 phút (requirements.txt kéo cả torch). Các lần sau bỏ qua bước này.');
    info('Đang vội? Ctrl-C rồi chạy: CRAB_SKIP_PYTHON=1 npm start — app vẫn mở, chỉ tính năng AI là chưa chạy.');
  }
  run(VENV_PYTHON, ['-m', 'pip', 'install', '--upgrade', 'pip', '--quiet']);
  if (run(VENV_PYTHON, ['-m', 'pip', 'install', '-r', 'requirements.txt'])) return true;
  warn('pip install thất bại');
  todo.push(`Chạy tay \`${path.relative(PROJECT_ROOT, VENV_PYTHON)} -m pip install -r requirements.txt\` để xem lỗi.`);
  return false;
}

function stepPython() {
  step('Python và gói AI (.venv)');
  if (SKIP_PYTHON) {
    skippedPython = true;
    info('Bỏ qua theo yêu cầu — app mở được, nhưng bóc băng / Auto-Reframe / Retouch sẽ không chạy.');
    return;
  }

  if (fs.existsSync(VENV_PYTHON)) {
    const current = interpreterVersion(VENV_PYTHON, []);
    if (current && !pythonVersionOk(current.tuple)) {
      /* Đây là cái bẫy tốn nhiều giờ nhất của dự án: venv dựng bằng 3.13+ thì
       * `pip install -r requirements.txt` vẫn BÁO THÀNH CÔNG, chỉ lặng lẽ bỏ qua
       * mediapipe/opencv vì marker `python_version < "3.13"`. Phải chặn ở đây, chứ để
       * `pip install` chạy tiếp là đưa người dùng vào đúng cái bẫy đó. */
      warn(`.venv đang dùng Python ${current.label} — ngoài khoảng ${PYTHON_MIN.join('.')} … <${PYTHON_MAX_EXCLUSIVE.join('.')}`);
      info('pip sẽ vẫn báo "thành công" nhưng ÂM THẦM bỏ mediapipe + opencv, rồi Auto-Reframe chết với No module named \'cv2\'.');
      todo.push(`Xoá .venv rồi chạy lại \`npm run setup\`: ${IS_WIN ? 'rmdir /s /q .venv' : 'rm -rf .venv'}`);
      return;
    }

    /* THĂM DÒ TRƯỚC, CHỈ CÀI KHI THIẾU.
     * Bản đầu của script này chạy `pip install -r requirements.txt` vô điều kiện. Kể cả khi
     * đã đủ gói, pip vẫn phải giải lại toàn bộ đồ thị phụ thuộc — mất khoảng một phút cho
     * MỖI lần. Một phút nằm trước mỗi lần `npm start` là không chấp nhận được. Phép dò
     * find_spec dưới đây tốn ~130 ms. */
    const missing = missingModules(VENV_PYTHON);
    if (missing === null) { warn('Không thăm dò được gói Python trong .venv'); return; }
    if (missing.length === 0) {
      ok(`.venv đủ gói (Python ${current ? current.label : '?'}) — ${groupsForPlatform().map((g) => g.label).join(', ')}`);
      return;
    }
    if (!installPython(`.venv thiếu: ${missing.join(', ')} → cài…`)) return;
  } else {
    const found = findUsablePython();
    if (!found.cmd) {
      warn(`Không tìm thấy Python nào trong khoảng ${PYTHON_MIN.join('.')} … <${PYTHON_MAX_EXCLUSIVE.join('.')}`);
      if (found.rejected.length) info(`Đã thử nhưng sai phiên bản: ${found.rejected.join(', ')}`);
      todo.push(IS_MAC
        ? 'Cài Python 3.12: `brew install python@3.12` rồi chạy lại `npm run setup`.'
        : 'Cài Python 3.12 từ python.org (nhớ tick "Add python.exe to PATH") rồi chạy lại `npm run setup`.');
      return;
    }
    acting(`Chưa có .venv → dựng bằng ${found.cmd} ${found.args.join(' ')} (${found.version.label})…`);
    if (!run(found.cmd, [...found.args, '-m', 'venv', '.venv'])) {
      warn('Không dựng được .venv');
      todo.push('Chạy tay `' + found.cmd + ' ' + found.args.join(' ') + ' -m venv .venv` để xem lỗi.');
      return;
    }
    ok('.venv đã dựng');
    if (!installPython('pip install -r requirements.txt…')) return;
  }

  const missing = missingModules(VENV_PYTHON);
  if (missing === null) { warn('Không thăm dò được gói sau khi cài'); return; }
  if (missing.length === 0) {
    ok(`Đủ gói cho: ${groupsForPlatform().map((g) => g.label).join(', ')}`);
  } else {
    warn(`Cài xong nhưng vẫn thiếu: ${missing.join(', ')}`);
    todo.push('Đọc `npm run preflight` để biết gói nào thuộc tính năng nào.');
  }
}

/* ─────────────────────────── 5. FFmpeg ─────────────────────────── */

/* backend/server.js spawn `ffmpeg` bằng TÊN TRẦN, nên thiếu nó thì mọi đường xuất/preview
 * chết bằng ENOENT — một lỗi không hề nhắc tới FFmpeg. Chưa có preflight nào kiểm việc này. */
function stepFfmpeg() {
  step('FFmpeg');
  const ffmpeg = findOnPath('ffmpeg');
  const ffprobe = findOnPath('ffprobe');
  if (!ffmpeg || !ffprobe) {
    warn(`Thiếu ${!ffmpeg ? 'ffmpeg' : ''}${!ffmpeg && !ffprobe ? ' và ' : ''}${!ffprobe ? 'ffprobe' : ''} trên PATH`);
    todo.push(IS_MAC
      ? 'Cài FFmpeg: `brew install ffmpeg`.'
      : 'Cài FFmpeg: `winget install Gyan.FFmpeg` rồi mở lại terminal cho PATH cập nhật.');
    return;
  }
  ok(`ffmpeg: ${ffmpeg}`);

  /* `zscale` là bộ lọc của zimg, KHÔNG có trong mọi bản build. Đường tonemap HDR
   * (backend/server.js: HDR_TONEMAP_ZSCALE) dựa vào nó, và thiếu thì lỗi chỉ nổ ra khi
   * người dùng nhập đúng một clip HDR — rất muộn và rất khó đoán. */
  const filters = capture('ffmpeg', ['-hide_banner', '-filters']);
  if (filters && /\bzscale\b/.test(filters)) ok('bản build có zscale (cần cho tonemap HDR)');
  else {
    info('bản build KHÔNG có zscale — clip HDR sẽ không tonemap được, phần còn lại vẫn chạy.');
    notes.push(IS_MAC
      ? 'Muốn tonemap HDR: cài bản ffmpeg có zimg (`brew install ffmpeg` bản full).'
      : 'Muốn tonemap HDR: dùng bản ffmpeg "full" của gyan.dev (bản essentials không có zscale).');
  }
}

/* ─────────────────────────── Tổng kết ─────────────────────────── */

function main() {
  if (process.env.CRAB_SKIP_SETUP === '1') {
    console.log('[setup] Bỏ qua theo CRAB_SKIP_SETUP=1.');
    return;
  }
  emit('');
  emit(`CrabbyCut — dựng môi trường phát triển (${process.platform} ${os.arch()})`);
  emit(`Thư mục dự án: ${PROJECT_ROOT}`);

  stepNode();
  stepVendor();
  stepNative();
  stepPython();
  stepFfmpeg();

  /* Đường ĐI QUA HÀNG NGÀY: đã đủ mọi thứ, chưa phải làm gì, và đang nằm trong `npm start`.
   * Một dòng là đủ — bảng ✓ đầy đủ chỉ in khi gõ `npm run setup` để xem trạng thái máy. */
  if (AUTO && !flushed && !todo.length) {
    console.log(skippedPython
      ? '[setup] ✓ Phần Node/native đủ; phần Python bỏ qua theo yêu cầu (AI sẽ không chạy).'
      : '[setup] ✓ Môi trường đã đủ — không phải cài gì.');
    return;
  }

  flush();
  console.log('');
  if (!todo.length) {
    console.log(AUTO ? '✓ Môi trường đã đủ — mở app…' : '✓ Môi trường đã đủ. Chạy `npm start`.');
    if (notes.length) {
      console.log('');
      console.log('Ghi chú (không chặn gì, chỉ là có thể tốt hơn):');
      notes.forEach((item) => console.log(`  · ${item}`));
    }
    console.log('');
    return;
  }
  console.log(`Còn ${todo.length} việc phải làm tay:`);
  todo.forEach((item, i) => console.log(`  ${i + 1}. ${item}`));
  if (notes.length) {
    console.log('');
    console.log('Ghi chú (không chặn gì):');
    notes.forEach((item) => console.log(`  · ${item}`));
  }
  console.log('');
  console.log(AUTO
    ? 'App vẫn mở được; những việc trên chỉ ảnh hưởng đúng phần tính năng đã nêu.'
    : '`npm start` vẫn mở được app; những việc trên chỉ ảnh hưởng đúng phần tính năng đã nêu.');
  console.log('');
  /* KHÔNG exit code khác 0: `npm run setup` "hoàn thành" đúng nghĩa là đã kiểm và đã báo
   * hết. Trả lỗi ở đây sẽ làm npm in thêm một khối ERR! che mất chính danh sách trên. */
}

main();
