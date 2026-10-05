#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* =====================================================================
 * CHẠY TOÀN BỘ TEST — CÙNG MỘT LỆNH TRÊN WINDOWS, macOS VÀ CI
 *   npm run test:all                     (mọi test của `npm test` + `test:export-all`)
 *   npm run test:all -- --skip-python    (bỏ 3 test Python cần torch/whisper — CI dùng)
 *   npm run test:all -- --only=test:seam,test:export
 *
 * VÌ SAO KHÔNG CHỈ `npm test`: chuỗi `a && b && c` DỪNG ở test đỏ đầu tiên, nên một máy
 * (Mac hay Windows) có 20 test hỏng chỉ thấy cái đầu, sửa xong mới lộ cái thứ hai. Ở đây mỗi
 * test chạy riêng, có giới hạn thời gian (macOS không có lệnh `timeout`), log riêng ở
 * test_temp/test-logs/, và cuối cùng in bảng tổng.
 *
 * LỖ HỔNG NỀN TẢNG ĐÃ BIẾT (tests/known-platform-gaps.json): test đỏ vì MÔI TRƯỜNG của một nền
 * tảng (vd. ffmpeg Homebrew thiếu zscale), có ghi lý do và việc cần làm để gỡ. Chúng được báo
 * riêng và không làm lệnh thoát lỗi — nhưng nếu một test trong danh sách lại XANH thì lệnh báo
 * để xoá nó khỏi danh sách (lỗ hổng đã được vá thì không được nằm đó che lỗi mới).
 *
 * Mã thoát: 0 = mọi test xanh (trừ lỗ hổng đã biết), 1 = có test đỏ.
 * ===================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function parseArgs(argv) {
  const opts = { skipPython: false, only: null, timeoutS: 900, build: false };
  for (const arg of argv) {
    const [key, ...rest] = arg.replace(/^--/, '').split('=');
    const value = rest.join('=');
    if (key === 'skip-python') opts.skipPython = true;
    else if (key === 'only') opts.only = value.split(',').filter(Boolean);
    else if (key === 'timeout') opts.timeoutS = Math.max(10, Number(value) || 900);
    else if (key === 'build') opts.build = true;
    else throw new Error(`tuỳ chọn lạ: ${arg}`);
  }
  return opts;
}

// Tên các script trong một chuỗi `npm run a && npm run b …`.
function chain(scriptName) {
  return String(pkg.scripts[scriptName] || '')
    .split('&&').map((s) => s.trim())
    .filter((s) => s.startsWith('npm run '))
    .map((s) => s.slice('npm run '.length).trim());
}

function testList(opts) {
  if (opts.only) return opts.only;
  const seen = new Set();
  const out = [];
  for (const name of [...chain('test'), ...chain('test:export-all')]) {
    if (name === 'build:native' || !name.startsWith('test:') || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/* Chạy THẲNG lệnh `node …` của script (không qua npm): khỏi phụ thuộc shell của từng nền tảng
 * (npm.cmd trên Windows cần shell, Node >= 20 từ chối spawn .cmd không shell) và nhanh hơn. */
function commandOf(name) {
  const cmd = String(pkg.scripts[name] || '').trim();
  if (!cmd.startsWith('node ')) return null;
  return cmd.slice('node '.length).split(/\s+/).filter(Boolean);
}

function loadKnownGaps() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'known-platform-gaps.json'), 'utf8'));
    return data[process.platform] || {};
  } catch (_) {
    return {};
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const logDir = path.join(ROOT, 'test_temp', 'test-logs');
  fs.mkdirSync(logDir, { recursive: true });
  if (opts.build) {
    const b = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:native'],
      { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if (b.status !== 0) process.exit(1);
  }
  const gaps = loadKnownGaps();
  const results = [];
  for (const name of testList(opts)) {
    const args = commandOf(name);
    if (!args) { results.push({ name, status: 'BỎ', note: 'không phải lệnh node' }); continue; }
    if (opts.skipPython && args[0].replace(/\\/g, '/').endsWith('scripts/run_python.js')) {
      results.push({ name, status: 'BỎ', note: '--skip-python' });
      continue;
    }
    const t0 = Date.now();
    const r = spawnSync(process.execPath, args, {
      cwd: ROOT, encoding: 'utf8', timeout: opts.timeoutS * 1000, maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const seconds = (Date.now() - t0) / 1000;
    fs.writeFileSync(path.join(logDir, `${name.replace(/[:]/g, '_')}.log`),
      `${r.stdout || ''}\n${r.stderr || ''}${r.error ? `\n${r.error}` : ''}`);
    let status = r.error?.code === 'ETIMEDOUT' ? 'QUÁ GIỜ' : (r.status === 0 ? 'XANH' : 'ĐỎ');
    let note = '';
    if (gaps[name]) {
      if (status === 'XANH') note = 'đã XANH — xoá khỏi tests/known-platform-gaps.json';
      else { status = 'LỖ HỔNG'; note = gaps[name]; }
    }
    results.push({ name, status, seconds, note });
    console.log(`${status.padEnd(8)} ${name.padEnd(36)} ${seconds.toFixed(0).padStart(4)}s${note ? `  — ${note}` : ''}`);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  const failed = results.filter((r) => r.status === 'ĐỎ' || r.status === 'QUÁ GIỜ');
  const staleGaps = results.filter((r) => r.status === 'XANH' && gaps[r.name]);
  console.log(`\n${process.platform}/${process.arch} · ${results.length} test: ${count('XANH')} xanh, ${failed.length} đỏ, `
    + `${count('LỖ HỔNG')} lỗ hổng đã biết, ${count('BỎ')} bỏ qua · log: ${path.relative(ROOT, logDir)}`);
  if (failed.length) console.log(`ĐỎ: ${failed.map((r) => r.name).join(', ')}`);
  if (staleGaps.length) console.log(`Lỗ hổng đã được vá (xoá khỏi danh sách): ${staleGaps.map((r) => r.name).join(', ')}`);
  process.exit(failed.length || staleGaps.length ? 1 : 0);
}

main();
