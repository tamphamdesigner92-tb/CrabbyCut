#!/usr/bin/env node
/* Chạy một script Python bằng interpreter của dự án.
 *
 * Ưu tiên .venv trong repo (nơi có rapidfuzz/torch/whisper); không có thì rơi về
 * python hệ thống. Có helper này thì npm script không phải viết cứng đường dẫn
 * .venv/bin/python — thứ chỉ đúng trên macOS/Linux. */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { pythonCommand, pythonEnv, PROJECT_ROOT: projectRoot } = require('./python_command.js');

const python = pythonCommand();

const args = process.argv.slice(2);
if (!args.length) {
  console.error('usage: node scripts/run_python.js <script.py> [args...]');
  process.exit(2);
}

const result = spawnSync(python, args, { cwd: projectRoot, stdio: 'inherit', env: pythonEnv() });
process.exit(result.status === null ? 1 : result.status);
