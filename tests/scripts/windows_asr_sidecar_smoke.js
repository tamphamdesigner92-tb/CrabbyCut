const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const { pythonCommand, pythonEnv } = require(path.join(projectRoot, 'scripts', 'python_command.js'));
const python = pythonCommand();
const sidecar = path.join(projectRoot, 'asr', 'windows_faster_whisper_sidecar.py');

function runJson(args) {
  const result = spawnSync(python, [sidecar, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: pythonEnv(),
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
}

const imports = runJson(['--check-imports']);
assert.strictEqual(imports.status, 'success');
assert.strictEqual(typeof imports.faster_whisper, 'boolean');
assert.strictEqual(typeof imports.ctranslate2, 'boolean');
assert.strictEqual(typeof imports.huggingface_hub, 'boolean');

// Windows chỉ còn MỘT model: mọi bí danh phải quy về large-v3-turbo.
for (const alias of ['turbo', 'large-v3-turbo', 'whisper-large-v3-turbo', 'default', 'large_v3_turbo']) {
  assert.strictEqual(runJson(['--resolve-model', alias]).resolved, 'large-v3-turbo',
    `bí danh '${alias}' phải quy về large-v3-turbo`);
}

/* TÊN CŨ CỦA DISTIL PHẢI VẪN NHẬN, và quy về Turbo — KHÔNG được raise. Dự án .crab cũ và
 * settings đã lưu còn mang 'distil-large-v3'; nếu sidecar từ chối thì mở dự án cũ lên là
 * chết bóc băng. Đây là phần dễ vỡ nhất khi bỏ một model, nên khoá lại bằng test. */
for (const legacy of ['distil', 'distil-large', 'distil-large-v3']) {
  assert.strictEqual(runJson(['--resolve-model', legacy]).resolved, 'large-v3-turbo',
    `tên cũ '${legacy}' phải quy về large-v3-turbo, không được lỗi`);
}

// Turbo là lựa chọn duy nhất nên phải LUÔN eligible (kể cả máy không GPU) — nếu không thì
// có máy Windows không còn model nào dùng được.
const probe = runJson(['--check-imports']);
assert.strictEqual(probe.status, 'success');

console.log('windows asr sidecar smoke ok');
