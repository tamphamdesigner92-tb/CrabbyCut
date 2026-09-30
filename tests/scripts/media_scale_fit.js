/* =====================================================================
 * "SCALE 100%" CỦA BLOCK MEDIA Ở LANE OVERLAY = VỪA KHUNG, NHƯ LANE CHÍNH (2026-09-30)
 *
 * Người dùng báo (dự án Test.crab): CÙNG nguồn DSCF3442.MOV 3840×2160 trên sequence 1920×1080 —
 * block lane chính 107% trông bằng block lane overlay 55%. Lane chính lấy VỪA KHUNG làm 100%
 * (MainLane.fitScale, theo CapCut), overlay lại lấy SỐ PIXEL CỦA TỆP. Nay overlay cũng vừa khung.
 *
 * Chốt:
 *   A. renderer (hàm thật chạy trong VM): cỡ nền media = cỡ gốc × hệ số vừa khung, bằng đúng cỡ
 *      nền của block lane chính cùng nguồn; dự án cũ quy đổi scale/keyframe để cỡ trên canvas y hệt;
 *      trạng thái mới mang dấu `mediaScaleBasis: 'fit'` nên không quy đổi hai lần.
 *   B. sidecar (xuất thật): scale 100 + fit_scale 0,5 cho ra Y HỆT từng khung bản scale 50 kiểu cũ,
 *      cả nhánh tĩnh lẫn nhánh keyframe; không có fit_scale (payload cũ, ảnh chữ) thì như trước.
 *
 * Chạy: npm run test:media-scale-fit
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME = fs.readFileSync(path.join(ROOT, 'static', 'js', 'editing-runtime.js'), 'utf8');
const MainLane = require(path.join(ROOT, 'static', 'js', 'main-lane.js'));
const SIDECAR = path.join(ROOT, 'native', 'sidecar', 'build', process.platform === 'win32' ? 'core_process.exe' : 'core_process');
const TEST_DIR = path.join(ROOT, 'test_temp', 'media_scale_fit');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `không tìm thấy hàm ${name}() trong nguồn`);
  const bodyStart = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = bodyStart; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`không đóng được thân hàm ${name}()`);
}

function makeSandbox(items, assets, seq = { width: 1920, height: 1080 }) {
  const sandbox = { editingItems: items, editingAssets: assets, window: { MainLane }, MainLane, latestTimeline: [], selectedTimelineClipIndex: -1 };
  vm.createContext(sandbox);
  vm.runInContext([
    'function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, Number(v) || 0)); }',
    `function payloadSequence() { return ${JSON.stringify(seq)}; }`,
    'function normalizeShapeStyle(s) { return s; }',
    'function measureTextItemBox() { return { width: 10, height: 10 }; }',
    'function mainLaneBaseSize() { return { width: 0, height: 0 }; }',
    extractFunction(RUNTIME, 'findAsset'),
    extractFunction(RUNTIME, 'isMainLaneBoxItem'),
    extractFunction(RUNTIME, 'scaleKeyframeField'),
    extractFunction(RUNTIME, 'mediaAssetFitScale'),
    extractFunction(RUNTIME, 'itemNativeSize'),
    extractFunction(RUNTIME, 'itemBaseSize'),
    extractFunction(RUNTIME, 'migrateMediaScaleToFit'),
    'globalThis.api = { itemBaseSize, itemNativeSize, mediaAssetFitScale, migrateMediaScaleToFit };',
  ].join('\n'), sandbox);
  return sandbox;
}

function testRenderer() {
  const assets = [
    { id: 'uhd', width: 3840, height: 2160 },
    { id: 'hd720', width: 1280, height: 720 },
    { id: 'portrait', width: 1080, height: 1920 },
    { id: 'logo', width: 200, height: 100 },
    { id: 'unknown' },
  ];
  const media = (id, assetId, scale, keyframes) => ({ id, type: 'media', asset_id: assetId, transform: { position_x: 0, position_y: 0, scale }, ...(keyframes ? { keyframes } : {}) });
  const items = [
    media('ov_uhd', 'uhd', 55, { scale: [{ t: 0, v: 50 }, { t: 1, v: 60 }] }),
    media('ov_720', 'hd720', 100),
    media('ov_portrait', 'portrait', 100),
    media('ov_logo', 'logo', 100),
    media('ov_unknown', 'unknown', 80),
    { id: 'tx', type: 'text', asset_id: '', transform: { scale: 100 } },
  ];
  const box = makeSandbox(items, assets);
  // Object sinh trong VM mang prototype của realm khác -> deepStrictEqual coi là khác; chuyển về object thường.
  const plain = (o) => JSON.parse(JSON.stringify(o));
  const itemBaseSize = (...a) => plain(box.api.itemBaseSize(...a));
  const itemNativeSize = (...a) => plain(box.api.itemNativeSize(...a));
  const base = (i) => itemBaseSize(items[i], assets.find((a) => a.id === items[i].asset_id));
  assert.deepStrictEqual(base(0), { width: 1920, height: 1080 }, '4K trên 1080p: 100% = vừa khung');
  assert.deepStrictEqual(base(1), { width: 1920, height: 1080 }, '720p trên 1080p: 100% = phóng vừa khung');
  assert.deepStrictEqual(base(2), { width: 607.5, height: 1080 }, 'nguồn dọc trên khung ngang: vừa chiều cao');
  assert.deepStrictEqual(base(4), { width: 1920 * 0.45, height: 1080 * 0.25 }, 'chưa biết cỡ asset: khung dự phòng như cũ');
  assert.deepStrictEqual(itemNativeSize(items[0], assets[0]), { width: 3840, height: 2160 }, 'cỡ gốc giữ nguyên số pixel của tệp');
  // Cùng nguồn -> cùng cỡ nền với block lane chính (đúng lỗi người dùng báo).
  assert.deepStrictEqual(MainLane.clipBaseSize({ x: 0, y: 0, width: 3840, height: 2160 }, 1920, 1080), base(0),
    'block overlay và block lane chính CÙNG nguồn phải có cùng cỡ nền ở 100%');
  console.log('  ok  cỡ nền media overlay = vừa khung, bằng lane chính cùng nguồn');

  // Dự án cũ: scale tính trên cỡ gốc -> quy đổi để cỡ trên canvas y hệt.
  const before = items.map((it) => {
    const a = assets.find((x) => x.id === it.asset_id);
    const sz = it.type === 'media' ? itemNativeSize(it, a) : null;   // cách tính CŨ: cỡ gốc × scale
    return sz ? { w: sz.width * it.transform.scale / 100, h: sz.height * it.transform.scale / 100 } : null;
  });
  box.api.migrateMediaScaleToFit();
  assert.strictEqual(items[0].transform.scale, 110, 'block 4K 55% (cỡ gốc) -> 110% (vừa khung)');
  assert.deepStrictEqual(items[0].keyframes.scale.map((k) => k.v), [100, 120], 'keyframe scale cũng quy đổi');
  assert.ok(Math.abs(items[3].transform.scale - 100 / 9.6) < 1e-9, 'logo 200×100 giữ cỡ gốc: 100% -> ~10,4%');
  assert.strictEqual(items[4].transform.scale, 80, 'chưa biết cỡ asset: không đổi');
  assert.strictEqual(items[5].transform.scale, 100, 'block chữ không bị đụng tới');
  items.forEach((it, i) => {
    if (!before[i] || it.asset_id === 'unknown') return;
    const sz = base(i);
    const w = sz.width * it.transform.scale / 100;
    const h = sz.height * it.transform.scale / 100;
    assert.ok(Math.abs(w - before[i].w) < 1e-6 && Math.abs(h - before[i].h) < 1e-6,
      `${it.id}: cỡ trên canvas phải y hệt sau quy đổi (${before[i].w}×${before[i].h} -> ${w}×${h})`);
  });
  console.log('  ok  quy đổi dự án cũ: cỡ trên canvas y hệt, logo giữ cỡ gốc, chữ không đổi');

  // Dấu mốc trong trạng thái: có mới không quy đổi lại (undo/redo, mở lại dự án mới).
  const hist = extractFunction(RUNTIME, 'getHistoryState');
  assert.ok(/mediaScaleBasis:\s*'fit'/.test(hist), "getHistoryState phải ghi mediaScaleBasis: 'fit'");
  const restore = extractFunction(RUNTIME, 'restoreEditingHistoryState');
  assert.ok(/state\.mediaScaleBasis !== 'fit'\) migrateMediaScaleToFit\(\)/.test(restore),
    'restoreEditingHistoryState chỉ quy đổi khi thiếu dấu mốc');
  assert.ok(restore.indexOf('migrateMediaScaleToFit') > restore.indexOf('editingAssets = '),
    'quy đổi phải chạy SAU khi editingAssets đã nạp (cần cỡ asset)');
  console.log('  ok  dấu mốc mediaScaleBasis: quy đổi đúng một lần');
}

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}
function mustRun(cmd, args, what) {
  const r = run(cmd, args);
  assert.strictEqual(r.status, 0, `${what}:\n${r.stderr || r.stdout}`);
  return r;
}
function frameHashes(file) {
  return mustRun('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v', '-f', 'framemd5', '-'], 'framemd5')
    .stdout.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => l.split(',').pop().trim());
}

function testSidecar() {
  if (!fs.existsSync(SIDECAR) || run('ffmpeg', ['-version']).status !== 0) {
    console.log('  (bỏ qua phần xuất: chưa build sidecar hoặc thiếu ffmpeg)');
    return;
  }
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const base = path.join(TEST_DIR, 'base.mp4');
  const ovl = path.join(TEST_DIR, 'ovl.mp4');
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x305070:s=320x180:r=25:d=2',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', base], 'nền');
  // Nguồn lớp phủ GẤP ĐÔI khung (640×360 trên sequence 320×180) -> hệ số vừa khung 0,5.
  mustRun('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=2',
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', ovl], 'lớp phủ');
  const exportWith = (tag, overlayFields) => {
    const timeline = {
      version: 5, sequence: { width: 320, height: 180, fps: '25' },
      intervals: [{ index: 0, start: 0, end: 2, audio_volume: 100 }],
      overlays: [{ index: 0, id: 'ov', type: 'media', asset_type: 'media_video', asset_path: ovl,
        timeline_start: 0.2, duration: 1.4, source_start: 0, muted: true, has_audio: false,
        position_x: 12, position_y: -8, rotation: 0, opacity: 100, ...overlayFields }],
      settings: { resolution: 'sequence', width: 320, height: 180, fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '128k' },
    };
    const p = path.join(TEST_DIR, `${tag}.json`);
    fs.writeFileSync(p, JSON.stringify(timeline));
    const out = path.join(TEST_DIR, `${tag}.mp4`);
    const r = spawnSync(SIDECAR, ['export-video', base, out, p, TEST_DIR, 'sequence', '25'],
      { encoding: 'utf8', maxBuffer: 20 << 20, env: { ...process.env, FFMPEG_EXPORT_HW: '0' } });
    assert.strictEqual(r.status, 0, `sidecar lỗi (${tag}):\n${r.stdout}\n${r.stderr}`);
    return frameHashes(out);
  };
  const cases = [
    ['tĩnh', { scale: 100, fit_scale: 0.5 }, { scale: 50 }],
    ['tĩnh 130%', { scale: 130, fit_scale: 0.5 }, { scale: 65 }],
    ['keyframe', { scale: 100, fit_scale: 0.5, kf_scale_expr: '100+40*LOCALT' }, { scale: 50, kf_scale_expr: '50+20*LOCALT' }],
  ];
  for (const [name, fitFields, oldFields] of cases) {
    const a = exportWith(`${name.replace(/\W+/g, '_')}_fit`, fitFields);
    const b = exportWith(`${name.replace(/\W+/g, '_')}_old`, oldFields);
    assert.strictEqual(a.length, b.length, `${name}: số khung lệch`);
    const diff = a.findIndex((h, i) => h !== b[i]);
    assert.strictEqual(diff, -1, `${name}: khung ${diff} khác nhau giữa mốc vừa khung và mốc cỡ gốc tương đương`);
    console.log(`  ok  sidecar ${name}: ${a.length} khung trùng framemd5 với bản mốc cỡ gốc tương đương`);
  }
  // Không có fit_scale (payload cũ / ảnh chữ): như trước — scale 100 là cỡ gốc (khác bản 50).
  const legacy = exportWith('legacy', { scale: 100 });
  const half = exportWith('half', { scale: 50 });
  assert.ok(legacy.some((h, i) => h !== half[i]), 'không có fit_scale thì scale 100 phải là cỡ gốc như cũ');
  console.log('  ok  sidecar: thiếu fit_scale giữ nghĩa cũ');
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

try {
  testRenderer();
  testSidecar();
  console.log('media_scale_fit: OK');
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
