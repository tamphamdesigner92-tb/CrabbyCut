const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const { pythonCommand, pythonEnv } = require(path.join(root, 'scripts', 'python_command.js'));
const python = pythonCommand();
const outputPath = path.join(root, 'temp_uploads', 'asr_json_safety_output.json');

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.rmSync(outputPath, { force: true });

const result = spawnSync(
  python,
  [path.join(root, 'asr', 'mac_mlx_sidecar.py'), '--sanitize-smoke', outputPath],
  { cwd: root, encoding: 'utf8', env: pythonEnv() },
);

assert.strictEqual(result.status, 0, result.stderr || result.stdout);

const raw = fs.readFileSync(outputPath, 'utf8');
assert.strictEqual(raw.includes('NaN'), false);
assert.strictEqual(raw.includes('Infinity'), false);

const parsed = JSON.parse(raw);
assert.strictEqual(parsed.status, 'success');
assert.strictEqual(parsed.value, null);
assert.strictEqual(Array.isArray(parsed.segments), true);
assert.strictEqual(parsed.segments.length, 1);
assert.strictEqual(parsed.segments[0].avg_logprob, undefined);
assert.strictEqual(parsed.segments[0].compression_ratio, undefined);
assert.strictEqual(parsed.segments[0].tokens, undefined);
assert.deepStrictEqual(Object.keys(parsed.segments[0]).sort(), [
  'end',
  'loudness_dBFS',
  'quality_decision',
  'quality_flags',
  'start',
  'text',
  'words',
]);

console.log('asr json safety ok');
