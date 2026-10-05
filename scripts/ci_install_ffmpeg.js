#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* =====================================================================
 * CÀI FFMPEG CHO CI (.github/workflows/ci.yml) — CÙNG BẢN NGƯỜI DÙNG CHẠY
 *
 * Windows: đúng bản ghim của bộ cài (scripts/ffmpeg_pin.js) — tải, KIỂM SHA-256, giải nén, kiểm
 *   chuỗi `ffmpeg -version`. CI mà chạy một ffmpeg khác bản người dùng thì "CI xanh" chẳng chứng
 *   minh được gì (hai hồi quy thật đã đến từ đúng chuyện lệch bản — xem ffmpeg_pin.js).
 * macOS: CHƯA có bản ghim (repo ffmpeg-for-CrabbyCut mới có bản win64) -> Homebrew `ffmpeg@8`
 *   (keg-only, không trôi lên 9.x như formula `ffmpeg`). Lệch bản với Windows được ghi ở
 *   tests/known-platform-gaps.json; có bản ghim macOS thì thay nhánh này bằng tải bản ghim.
 *
 * In thư mục `bin` vào $GITHUB_PATH (bước sau của job thấy `ffmpeg`/`ffprobe` trên PATH). Chạy
 * ngoài CI thì chỉ in đường dẫn ra màn hình.
 * ===================================================================== */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { FFMPEG_PIN } = require('./ffmpeg_pin.js');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} lỗi:\n${r.stderr || r.stdout || r.error}`);
  return r.stdout;
}

function findBinDir(root, exe) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === exe) return root;
    if (entry.isDirectory()) {
      const hit = findBinDir(full, exe);
      if (hit) return hit;
    }
  }
  return null;
}

function installWindows() {
  const work = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'crab-ffmpeg');
  fs.mkdirSync(work, { recursive: true });
  const zip = path.join(work, FFMPEG_PIN.fileName);
  // curl.exe có sẵn trên Windows 10+/runner GitHub; -L theo chuyển hướng của Releases.
  run('curl', ['-fsSL', '--retry', '3', '-o', zip, FFMPEG_PIN.url]);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  if (sha !== FFMPEG_PIN.sha256) throw new Error(`SHA-256 lệch: ${sha} != ${FFMPEG_PIN.sha256}`);
  const out = path.join(work, 'x');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  run('tar', ['-xf', zip, '-C', out]);   // bsdtar của Windows giải được zip
  const bin = findBinDir(out, 'ffmpeg.exe');
  if (!bin) throw new Error('không thấy ffmpeg.exe trong gói');
  const version = run(path.join(bin, 'ffmpeg.exe'), ['-hide_banner', '-version']).split('\n')[0];
  if (!version.startsWith(FFMPEG_PIN.versionPrefix)) throw new Error(`sai bản: ${version}`);
  return { bin, version };
}

function installMac() {
  run('brew', ['install', 'ffmpeg@8']);
  const prefix = run('brew', ['--prefix', 'ffmpeg@8']).trim();
  const bin = path.join(prefix, 'bin');
  const version = run(path.join(bin, 'ffmpeg'), ['-hide_banner', '-version']).split('\n')[0];
  return { bin, version };
}

function main() {
  const { bin, version } = process.platform === 'win32' ? installWindows() : installMac();
  console.log(`ffmpeg: ${version}\nbin: ${bin}`);
  if (process.env.GITHUB_PATH) fs.appendFileSync(process.env.GITHUB_PATH, `${bin}\n`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
