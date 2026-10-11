/**
 * LỒNG TIẾNG KHÔNG ĐƯỢC MẤT SAU KHI LƯU + MỞ LẠI DỰ ÁN (lỗi người dùng báo 2026-10-11).
 *
 * WAV lồng tiếng do server TTS ghi vào thư mục TẠM `temp_uploads/editing_assets/dubbing/<lượt>/`,
 * mà mỗi lượt mở dự án xoá sạch thư mục tạm trước khi nạp lại tài sản -> mất. Bản sửa
 * (electron/project-package.js relocateDubbingAudio): lúc Lưu chép sang "<Tên>_TTS/" cạnh .crab và ghi
 * đường dẫn TƯƠNG ĐỐI; lúc mở resolvePayloadPaths giải lại theo thư mục chứa .crab.
 *
 * Chốt:
 *   1. Lưu: chép đúng tệp tạm, đổi source_path ở CẢ manifest lẫn editingState, tên theo lượt (hai lượt
 *      cùng tên tệp không đè nhau), đường dẫn tương đối; tệp gốc của người dùng không bị đụng.
 *   2. Xoá thư mục tạm (mô phỏng reset-project) rồi mở: source_path trỏ đúng tệp còn tồn tại.
 *   3. Chép cả thư mục dự án sang chỗ khác: vẫn mở đúng.
 *   4. Lưu lại sau khi mở (đường dẫn tuyệt đối trong _TTS/) -> lại thành tương đối; WAV mồ côi bị dọn.
 *   5. Lượt mở (prune:false) chỉ cứu tệp, không dọn gì.
 *
 * Chạy: npm run test:dubbing-project-persist
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const { relocateDubbingAudio, resolvePayloadPaths, isTempDubbingPath } = require(path.join(ROOT, 'electron', 'project-package.js'));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-tts-persist-'));
const temp = path.join(work, 'temp_uploads');
const run1 = path.join(temp, 'editing_assets', 'dubbing', '20261011030116_ymrs');
const run2 = path.join(temp, 'editing_assets', 'dubbing', '20261011030404_tenn');
fs.mkdirSync(run1, { recursive: true });
fs.mkdirSync(run2, { recursive: true });
const wav1 = path.join(run1, 'Văn bản (lồng tiếng).wav');
const wav2 = path.join(run2, 'Văn bản (lồng tiếng).wav');   // CÙNG tên, khác lượt
fs.writeFileSync(wav1, 'RIFF-một');
fs.writeFileSync(wav2, 'RIFF-hai');
const userMusic = path.join(work, 'Nhạc của tôi', 'nen.mp3');
fs.mkdirSync(path.dirname(userMusic), { recursive: true });
fs.writeFileSync(userMusic, 'ID3');

const projectDir = path.join(work, 'Dự án');
fs.mkdirSync(projectDir, { recursive: true });
const crab = path.join(projectDir, 'Phim thử.crab');

/* KHÔNG dùng fs.cpSync: trên runner Windows, cpSync (C++ của Node 22) chép thư mục tên có dấu làm Node
 * chết native 0xC0000409 không in một chữ (CI 2026-10-11, như project_package.js 2026-10-05). */
function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDir(from, to);
        else fs.copyFileSync(from, to);
    }
}

function payloadWith(p1, p2) {
    return JSON.stringify({
        media: {
            editingAssets: [
                { asset_id: 'a1', kind: 'audio', name: 'Văn bản (lồng tiếng).wav', source_path: p1 },
                { asset_id: 'a2', kind: 'audio', name: 'Văn bản (lồng tiếng).wav', source_path: p2 },
                { asset_id: 'a3', kind: 'audio', name: 'nen.mp3', source_path: userMusic },
            ],
        },
        project: { history: { editingState: { editingAssets: [
            { id: 'a1', source_path: p1 }, { id: 'a2', source_path: p2 }, { id: 'a3', source_path: userMusic },
        ] } } },
    });
}

try {
    assert.ok(isTempDubbingPath(wav1) && !isTempDubbingPath(userMusic));

    // 1. Lưu.
    const saved = relocateDubbingAudio(payloadWith(wav1, wav2), crab);
    assert.strictEqual(saved.copied, 2);
    assert.deepStrictEqual(saved.failed, []);
    const p = JSON.parse(saved.payloadJson);
    const [m1, m2, m3] = p.media.editingAssets.map((e) => e.source_path);
    assert.strictEqual(m1, 'Phim thử_TTS/Văn bản (lồng tiếng) (20261011030116_ymrs).wav');
    assert.strictEqual(m2, 'Phim thử_TTS/Văn bản (lồng tiếng) (20261011030404_tenn).wav');
    assert.strictEqual(m3, userMusic, 'tệp của người dùng giữ nguyên đường dẫn');
    assert.deepStrictEqual(p.project.history.editingState.editingAssets.map((a) => a.source_path), [m1, m2, userMusic]);
    const ttsDir = path.join(projectDir, 'Phim thử_TTS');
    assert.strictEqual(fs.readFileSync(path.join(projectDir, m1), 'utf8'), 'RIFF-một');
    assert.strictEqual(fs.readFileSync(path.join(projectDir, m2), 'utf8'), 'RIFF-hai', 'hai lượt cùng tên không đè nhau');
    console.log('  ok  lưu: chép WAV tạm vào "<Tên>_TTS/", đường dẫn tương đối, tên theo lượt');

    // 2. Mở lại sau khi thư mục tạm bị xoá (reset-project).
    fs.writeFileSync(crab, saved.payloadJson);
    fs.rmSync(temp, { recursive: true, force: true });
    const reopened = JSON.parse(resolvePayloadPaths(fs.readFileSync(crab, 'utf8'), crab));
    const paths = reopened.media.editingAssets.map((e) => e.source_path);
    assert.ok(paths.slice(0, 2).every((x) => path.isAbsolute(x) && fs.existsSync(x)), `mở lại phải thấy tệp: ${paths}`);
    console.log('  ok  mở lại sau khi thư mục tạm bị xoá: tệp lồng tiếng vẫn còn');

    // 3. Chép cả thư mục dự án sang chỗ khác.
    const moved = path.join(work, 'Máy khác', 'Dự án');
    copyDir(projectDir, moved);
    const movedCrab = path.join(moved, 'Phim thử.crab');
    const movedPaths = JSON.parse(resolvePayloadPaths(fs.readFileSync(movedCrab, 'utf8'), movedCrab)).media.editingAssets.map((e) => e.source_path);
    assert.ok(movedPaths.slice(0, 2).every((x) => x.startsWith(moved) && fs.existsSync(x)), `chép đi chỗ khác: ${movedPaths}`);
    console.log('  ok  chép cả thư mục dự án sang chỗ khác vẫn mở đúng');

    // 4. Lưu lại sau khi mở: tuyệt đối trong _TTS -> tương đối; bỏ một clip -> WAV mồ côi bị dọn.
    const onlyFirst = JSON.parse(JSON.stringify(reopened));
    onlyFirst.media.editingAssets = onlyFirst.media.editingAssets.filter((e) => e.asset_id !== 'a2');
    onlyFirst.project.history.editingState.editingAssets = onlyFirst.project.history.editingState.editingAssets.filter((a) => a.id !== 'a2');
    fs.writeFileSync(path.join(ttsDir, 'ghi chú.txt'), 'không phải WAV');
    const resaved = relocateDubbingAudio(JSON.stringify(onlyFirst), crab);
    assert.strictEqual(JSON.parse(resaved.payloadJson).media.editingAssets[0].source_path, m1, 'lại thành tương đối');
    assert.strictEqual(resaved.removed, 1);
    assert.ok(!fs.existsSync(path.join(projectDir, m2)), 'WAV không còn asset nào dùng bị dọn');
    assert.ok(fs.existsSync(path.join(ttsDir, 'ghi chú.txt')), 'chỉ dọn .wav');
    console.log('  ok  lưu lại: giữ tương đối, dọn WAV mồ côi (chỉ .wav)');

    // 4b. Xoá clip -> Lưu (WAV bị dọn) -> Ctrl+Z lấy lại clip -> Lưu: chép lại từ bản làm việc `path`.
    const working = path.join(work, 'temp2', 'editing_assets', 'Văn bản (lồng tiếng).wav');
    fs.mkdirSync(path.dirname(working), { recursive: true });
    fs.writeFileSync(working, 'RIFF-hai-làm-việc');
    const undone = JSON.parse(JSON.stringify(reopened));
    undone.project.history.editingState.editingAssets[1].path = working;
    const again = relocateDubbingAudio(JSON.stringify(undone), crab);
    assert.ok(fs.existsSync(path.join(projectDir, m2)), 'WAV đã bị dọn được chép lại từ bản làm việc');
    assert.strictEqual(fs.readFileSync(path.join(projectDir, m2), 'utf8'), 'RIFF-hai-làm-việc');
    assert.ok(again.copied >= 1);
    console.log('  ok  Ctrl+Z lấy lại clip sau khi WAV bị dọn: chép lại từ bản làm việc');

    // 5. Lượt mở (cứu tệp) không dọn gì.
    fs.mkdirSync(run1, { recursive: true });
    fs.writeFileSync(wav1, 'RIFF-cứu');
    fs.writeFileSync(path.join(ttsDir, 'cũ.wav'), 'x');
    const rescued = relocateDubbingAudio(payloadWith(wav1, ''), crab, { prune: false });
    assert.strictEqual(rescued.copied, 1);
    assert.strictEqual(rescued.removed, 0);
    assert.ok(fs.existsSync(path.join(ttsDir, 'cũ.wav')), 'lượt mở không dọn');
    console.log('  ok  lượt mở: cứu tệp còn trong thư mục tạm, không dọn gì');

    // 6. BẢN TỰ LƯU: thư mục _TTS riêng trong "CrabbyCut Auto-Save", tự đủ.
    const { isAutosaveTtsPath, pruneTtsDir, ttsReferences } = require(path.join(ROOT, 'electron', 'project-package.js'));
    const autoDir = path.join(projectDir, 'CrabbyCut Auto-Save');
    const autoTts = path.join(autoDir, 'Phim thử_TTS');
    const projTts = path.join(projectDir, 'Phim thử_TTS');
    fs.mkdirSync(run2, { recursive: true });
    fs.writeFileSync(wav2, 'RIFF-tạm-mới');
    const projWav = path.join(projTts, path.basename(m1));   // WAV đã nằm trong _TTS của bản Lưu chính
    const auto1 = path.join(autoDir, 'Phim thử_20261011-120000.crab');
    const autoOut = relocateDubbingAudio(payloadWith(projWav, wav2), auto1, {
        ttsDir: autoTts, prune: false,
        adopt: (abs) => isAutosaveTtsPath(abs) || path.dirname(abs).toLowerCase() === projTts.toLowerCase(),
    });
    const ap = JSON.parse(autoOut.payloadJson).media.editingAssets.map((e) => e.source_path);
    assert.strictEqual(ap[0], `Phim thử_TTS/${path.basename(m1)}`, 'WAV của bản Lưu chính được CHÉP sang bản tự lưu');
    assert.strictEqual(ap[1], 'Phim thử_TTS/Văn bản (lồng tiếng) (20261011030404_tenn).wav');
    assert.ok(fs.existsSync(path.join(autoTts, path.basename(m1))) && fs.existsSync(path.join(autoTts, path.basename(ap[1]))));
    assert.ok(fs.existsSync(projWav), 'không đụng _TTS của bản Lưu chính');
    fs.writeFileSync(auto1, autoOut.payloadJson);
    fs.rmSync(temp, { recursive: true, force: true });
    const fromAuto = JSON.parse(resolvePayloadPaths(fs.readFileSync(auto1, 'utf8'), auto1)).media.editingAssets.map((e) => e.source_path);
    assert.ok(fromAuto.slice(0, 2).every((x) => x.startsWith(autoTts) && fs.existsSync(x)), `mở bản tự lưu: ${fromAuto}`);
    console.log('  ok  bản tự lưu: WAV vào "CrabbyCut Auto-Save/<Tên>_TTS/", tự đủ, mở được sau khi xoá thư mục tạm');

    // 7. Dọn theo MỌI bản tự lưu còn giữ: WAV bản cũ còn cần thì giữ.
    const auto2Json = JSON.stringify({ media: { editingAssets: [{ asset_id: 'a1', source_path: ap[0] }] } });
    const refs = new Set([...ttsReferences(auto2Json, 'Phim thử_TTS')]);
    fs.writeFileSync(path.join(autoTts, 'mồ côi.wav'), 'x');
    assert.strictEqual(pruneTtsDir(autoTts, refs), 2, 'chỉ bản mới còn lại -> dọn WAV bản cũ + mồ côi');
    ttsReferences(fs.readFileSync(auto1, 'utf8'), 'Phim thử_TTS').forEach((n) => refs.add(n));
    fs.writeFileSync(path.join(autoTts, path.basename(ap[1])), 'RIFF-tạm-mới');
    assert.strictEqual(pruneTtsDir(autoTts, refs), 0, 'còn bản tự lưu cũ trỏ tới -> giữ');
    console.log('  ok  dọn WAV của bản tự lưu theo mọi bản còn giữ');

    // 8. Khôi phục từ bản tự lưu rồi LƯU dự án: WAV chép từ Auto-Save sang _TTS của dự án.
    const restored = JSON.parse(resolvePayloadPaths(fs.readFileSync(auto1, 'utf8'), auto1));
    const savedFromAuto = relocateDubbingAudio(JSON.stringify(restored), crab);
    const sp = JSON.parse(savedFromAuto.payloadJson).media.editingAssets.map((e) => e.source_path);
    assert.ok(sp.slice(0, 2).every((x) => x.startsWith('Phim thử_TTS/') && fs.existsSync(path.join(projectDir, x))), `lưu sau khôi phục: ${sp}`);
    console.log('  ok  khôi phục từ bản tự lưu rồi Lưu: WAV chép sang _TTS của dự án');

    // 9. Mở một bản tự lưu: cứu tệp vào "<Tên>_TTS/" CHUNG của thư mục tự lưu, không đẻ thư mục theo từng bản.
    const { ttsDirForCrab } = require(path.join(ROOT, 'electron', 'project-package.js'));
    assert.strictEqual(ttsDirForCrab(auto1), autoTts);
    assert.strictEqual(ttsDirForCrab(crab), projTts);
    const reopenAuto = relocateDubbingAudio(JSON.stringify(restored), auto1, { prune: false, adopt: () => false, ttsDir: ttsDirForCrab(auto1) });
    assert.strictEqual(reopenAuto.copied, 0, 'mở bản tự lưu: WAV đã ở đúng chỗ, không chép thêm');
    assert.deepStrictEqual(fs.readdirSync(autoDir).filter((n) => /_TTS$/.test(n)), ['Phim thử_TTS'], 'không có thư mục _TTS theo từng bản');
    console.log('  ok  mở bản tự lưu: dùng chung "<Tên>_TTS/" của thư mục tự lưu');

    console.log('\ndubbing_project_persist: PASS');
} finally {
    fs.rmSync(work, { recursive: true, force: true });
}
