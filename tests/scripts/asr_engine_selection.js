const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const { pythonCommand, pythonEnv } = require(path.join(projectRoot, 'scripts', 'python_command.js'));
const python = pythonCommand();
const sidecar = path.join(projectRoot, 'asr', 'mac_mlx_sidecar.py');

/* mlx-whisper CHỈ có trên macOS Apple Silicon (không có wheel cho Windows/Linux), mà
 * test này khẳng định `imports.mlx_whisper === true` — tức nó không bao giờ xanh được
 * ở nơi khác. Trước đây nó vẫn nằm trong `npm test` không điều kiện nên trên Windows
 * cả suite luôn đỏ vì một lý do KHÔNG PHẢI lỗi sản phẩm. Bỏ qua cho đúng phạm vi:
 * đường ASR của Windows đã có windows_asr_sidecar_smoke.js lo. */
if (process.platform !== 'darwin') {
  console.log('asr engine selection: bỏ qua (mlx-whisper chỉ có trên macOS)');
  process.exit(0);
}

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
assert.strictEqual(imports.core_logic, true);
assert.strictEqual(imports.mlx_whisper, true);

assert.strictEqual(runJson(['--resolve-engine', 'mlx-whisper']).resolved, 'mlx_whisper');
assert.strictEqual(runJson(['--resolve-engine', 'legacy_disabled']).resolved, 'mlx_whisper');

console.log('asr engine selection ok');
