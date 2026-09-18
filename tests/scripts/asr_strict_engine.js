const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const { pythonCommand, pythonEnv } = require(path.join(projectRoot, 'scripts', 'python_command.js'));
const python = pythonCommand();
const sidecar = path.join(projectRoot, 'asr', 'mac_mlx_sidecar.py');
const tempDir = path.join(projectRoot, 'temp_uploads');
fs.mkdirSync(tempDir, { recursive: true });

const inputPath = path.join(tempDir, 'asr_strict_input.json');
const outputPath = path.join(tempDir, 'asr_strict_output.json');
fs.writeFileSync(inputPath, JSON.stringify({
  video_path: path.join(tempDir, 'missing_for_strict_test.mp4'),
  audio_path: path.join(tempDir, 'missing_for_strict_test.mp4'),
  reference_script: '',
  transcribe_mode: 'vi_smart',
  asr_engine: 'legacy_disabled',
}), 'utf8');
fs.rmSync(outputPath, { force: true });

const result = spawnSync(python, [sidecar, inputPath, outputPath], {
  cwd: projectRoot,
  encoding: 'utf8',
  env: pythonEnv({ MAC_ASR_FORCE_ENGINE_FAILURE: 'mlx_whisper' }),
});

assert.notStrictEqual(result.status, 0);
const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
assert.strictEqual(payload.status, 'error');
assert.strictEqual(payload.requested_engine, 'mlx_whisper');
assert.strictEqual(payload.engine, null);
assert.ok(payload.detail.includes("ASR engine 'mlx_whisper' failed"));

fs.rmSync(inputPath, { force: true });
fs.rmSync(outputPath, { force: true });
console.log('asr strict engine ok');
