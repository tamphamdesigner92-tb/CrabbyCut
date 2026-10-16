#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* =====================================================================
 * CÀI FFMPEG BẢN GHIM CỦA NỀN TẢNG NÀY — MÁY DEV VÀ CI DÙNG CHUNG
 *   npm run ffmpeg:install                     cài vào thư mục runtime (nếu chưa đúng bản)
 *   node scripts/install_ffmpeg.js --check     chỉ kiểm; mã thoát 1 nếu chưa phải bản ghim
 *   node scripts/install_ffmpeg.js --ci        cài + in thư mục bin vào $GITHUB_PATH
 *   node scripts/install_ffmpeg.js --from=<zip>  cài từ zip có sẵn (vd. zip vừa dựng, trước khi phát
 *                                              hành) — vẫn phải khớp SHA-256 của bản ghim
 *
 * CÀI VÀO ĐÂU: RuntimePaths.ffmpegDir() — đúng thư mục mà bộ cài Windows dùng và backend/server.js
 * nối vào ĐẦU PATH. Cài xong thì `npm start`/`npm run backend:dev` và `npm run test:all`
 * (scripts/run_tests.js nối cùng thư mục đó) đều chạy bản ghim, ffmpeg Homebrew/winget của máy
 * không còn được dùng. Không đụng gì ngoài thư mục đó.
 *
 * VÌ SAO: Windows và macOS phải chạy CÙNG một FFmpeg thì cùng mã nguồn mới cho cùng kết quả —
 * ffmpeg Homebrew 8.1 làm tròn khác bản ghim 8.1.1 và thiếu zscale, đã làm 3 test chỉ đỏ trên Mac
 * (docs/DONG_BO_WIN_MAC.md). Bản ghim từng nền tảng ở scripts/ffmpeg_pin.js; đổi bản ghim thì
 * chạy lại lệnh này (run_tests.js nhắc nếu quên).
 *
 * Dấu `pin.json` cạnh thư mục bin cùng định dạng với scripts/setup_runtime.js, nên bộ cài và lệnh
 * này nhận ra bản của nhau, không tải lại.
 * ===================================================================== */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const RuntimePaths = require('./runtime_paths.js');
const { pinFor } = require('./ffmpeg_pin.js');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} lỗi:\n${r.stderr || r.stdout || r.error}`);
  return r.stdout;
}

// Dòng đầu của `ffmpeg -version`, hoặc null nếu không chạy được.
function versionOf(exe) {
  const r = spawnSync(exe, ['-hide_banner', '-version'], { encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout).split(/\r?\n/)[0].trim() : null;
}

function markerPath() {
  return path.join(path.dirname(RuntimePaths.ffmpegDir()), 'pin.json');
}

function installedVersion(pin) {
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(markerPath(), 'utf8')); } catch (_) { return null; }
  if (marker?.id !== pin.id) return null;
  const version = versionOf(RuntimePaths.ffmpegBinary('ffmpeg'));
  return version?.startsWith(pin.versionPrefix) && fs.existsSync(RuntimePaths.ffmpegBinary('ffprobe'))
    ? version : null;
}

function findBinDir(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === EXE) return root;
    if (entry.isDirectory()) {
      const hit = findBinDir(full);
      if (hit) return hit;
    }
  }
  return null;
}

function install(pin, fromZip) {
  const cache = RuntimePaths.downloadCacheDir();
  fs.mkdirSync(cache, { recursive: true });
  const zip = fromZip || path.join(cache, pin.fileName);
  const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (fromZip) {
    const got = sha256(zip);
    if (got !== pin.sha256) throw new Error(`${zip}: SHA-256 ${got} không khớp bản ghim ${pin.sha256}`);
  } else if (!fs.existsSync(zip) || sha256(zip) !== pin.sha256) {
    console.log(`Tải ${pin.url}`);
    // curl có sẵn trên macOS và Windows 10+; -L theo chuyển hướng của GitHub Releases.
    run('curl', ['-fsSL', '--retry', '3', '-o', `${zip}.part`, pin.url]);
    fs.renameSync(`${zip}.part`, zip);
    const got = sha256(zip);
    if (got !== pin.sha256) {
      fs.rmSync(zip, { force: true });
      throw new Error(`SHA-256 lệch: ${got} != ${pin.sha256}`);
    }
  }

  const staging = path.join(RuntimePaths.runtimeRoot(), 'ffmpeg-staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  /* bsdtar giải được zip. Trên Windows gọi ĐÚNG tar.exe của System32: `tar` trần có thể là GNU tar
   * của Git for Windows (đứng trước trên PATH của shell Git/CI), mà GNU tar không đọc zip. */
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  run(IS_WIN && fs.existsSync(systemTar) ? systemTar : 'tar', ['-xf', zip, '-C', staging]);
  const bin = findBinDir(staging);
  if (!bin) throw new Error(`không thấy ${EXE} trong gói`);
  // Kiểm gói TRƯỚC khi đụng vào bản đang cài: gói hỏng thì bản cũ vẫn còn nguyên.
  const version = versionOf(path.join(bin, EXE));
  if (!version?.startsWith(pin.versionPrefix)) throw new Error(`gói báo phiên bản lạ: ${version || 'không chạy được'}`);

  const target = RuntimePaths.ffmpegDir();
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  // Chép CẢ thư mục bin: bản `-shared` để thư viện (DLL / dylib) nằm cạnh ffmpeg.
  for (const name of fs.readdirSync(bin)) fs.copyFileSync(path.join(bin, name), path.join(target, name));
  if (!IS_WIN) for (const name of ['ffmpeg', 'ffprobe']) fs.chmodSync(path.join(target, name), 0o755);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.writeFileSync(markerPath(), JSON.stringify({
    id: pin.id, sha256: pin.sha256, version, installed_at: new Date().toISOString(),
  }, null, 2), 'utf8');
  return version;
}

function main() {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const from = argv.find((a) => a.startsWith('--from='))?.slice('--from='.length);
  const pin = pinFor();
  if (!pin) throw new Error(`chưa có ffmpeg ghim cho ${process.platform}/${process.arch} (scripts/ffmpeg_pin.js)`);
  let version = installedVersion(pin);
  if (args.has('--check')) {
    console.log(version ? `ffmpeg bản ghim: ${version}` : `chưa cài bản ghim ${pin.id} — chạy: npm run ffmpeg:install`);
    process.exit(version ? 0 : 1);
  }
  if (version && !from) console.log(`Đã có bản ghim: ${version}`);
  else version = install(pin, from && path.resolve(from));
  const bin = RuntimePaths.ffmpegDir();
  console.log(`ffmpeg: ${version}\nbin: ${bin}`);
  if (args.has('--ci') && process.env.GITHUB_PATH) fs.appendFileSync(process.env.GITHUB_PATH, `${bin}\n`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
