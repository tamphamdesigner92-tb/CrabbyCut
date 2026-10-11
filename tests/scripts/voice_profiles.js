/**
 * Test hồ sơ giọng (backend/voice-profiles.js) — Cài đặt → Hồ sơ giọng, v1.1.17:
 *   1. Tạo từ tệp âm thanh thật: chép + chuẩn hoá thành WAV mono 44,1 kHz, cắt tối đa 20 s.
 *   2. Danh sách sắp theo tên; đổi tên/lời mẫu giữ nguyên id; xoá là mất cả thư mục.
 *   3. Tệp gốc bị xoá sau khi tạo -> hồ sơ vẫn dùng được (không giữ đường dẫn gốc).
 *   4. Từ chối: tên rỗng, tệp không tồn tại, id lạ (chặn đi ra ngoài thư mục gốc).
 *
 * Cần ffmpeg trên PATH. Chạy: npm run test:voice-profiles
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const { createVoiceProfiles } = require(path.join(ROOT, 'backend', 'voice-profiles.js'));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-voice-'));
const store = createVoiceProfiles({ rootDir: path.join(work, 'voice_profiles') });

function makeTone(file, seconds) {
    const out = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i',
        `sine=frequency=220:duration=${seconds}:sample_rate=48000`, '-ac', '2', file], { windowsHide: true });
    assert.strictEqual(out.status, 0, `ffmpeg tạo tệp thử lỗi: ${out.stderr}`);
}

async function rejects(promiseOrFn, status, label) {
    try {
        await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
    } catch (error) {
        assert.strictEqual(error.status, status, `${label}: sai mã lỗi (${error.status}) — ${error.message}`);
        console.log(`  ok  ${label}`);
        return;
    }
    throw new Error(`${label}: lẽ ra phải lỗi`);
}

(async () => {
    const src = path.join(work, 'giọng mẫu.mp3');
    makeTone(src, 30);

    const b = await store.create({ name: '  Giọng   Bình  ', source_path: src, ref_text: 'Xin  chào' });
    assert.match(b.id, /^vp_[a-z0-9]+$/);
    assert.strictEqual(b.name, 'Giọng Bình', 'gộp khoảng trắng');
    assert.strictEqual(b.ref_text, 'Xin chào');
    assert.ok(b.duration > 19.9 && b.duration <= 20.01, `cắt còn 20 s (được ${b.duration})`);
    const header = fs.readFileSync(path.join(b.dir, 'reference.wav')).subarray(0, 44);
    assert.strictEqual(header.toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(header.readUInt16LE(22), 1, 'mono');
    assert.strictEqual(header.readUInt32LE(24), 44100, '44,1 kHz');
    console.log('  ok  tạo: chép + chuẩn hoá WAV mono 44,1 kHz, cắt 20 s');

    const a = await store.create({ name: 'An', source_path: src });
    assert.deepStrictEqual(store.list().map((p) => p.name), ['An', 'Giọng Bình']);
    console.log('  ok  danh sách sắp theo tên');

    const renamed = store.update(b.id, { name: 'Bình (kể chuyện)', ref_text: '' });
    assert.strictEqual(renamed.id, b.id);
    assert.strictEqual(renamed.name, 'Bình (kể chuyện)');
    assert.strictEqual(renamed.ref_text, '');
    console.log('  ok  đổi tên/lời mẫu giữ nguyên id');

    fs.unlinkSync(src);
    const ref = store.resolveForDubbing(b.id);
    assert.ok(fs.existsSync(ref.ref_audio), 'giọng mẫu vẫn còn sau khi xoá tệp gốc');
    assert.ok(ref.ref_audio.startsWith(path.join(work, 'voice_profiles')));
    console.log('  ok  xoá tệp gốc không làm hỏng hồ sơ');

    await rejects(store.create({ name: '   ', source_path: ref.ref_audio }), 400, 'tên rỗng bị từ chối');
    await rejects(store.create({ name: 'X', source_path: path.join(work, 'không có.wav') }), 400, 'tệp không tồn tại bị từ chối');
    await rejects(() => store.get('../settings'), 400, 'id lạ bị chặn');
    await rejects(() => store.get('vp_khongco123'), 404, 'id không có -> 404');

    store.remove(a.id);
    assert.ok(!fs.existsSync(a.dir), 'xoá cả thư mục');
    assert.deepStrictEqual(store.list().map((p) => p.id), [b.id]);
    console.log('  ok  xoá hồ sơ');

    fs.rmSync(work, { recursive: true, force: true });
    console.log('\nvoice_profiles: PASS');
})().catch((error) => {
    fs.rmSync(work, { recursive: true, force: true });
    console.error(error);
    process.exit(1);
});
