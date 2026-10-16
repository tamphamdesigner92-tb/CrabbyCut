/* =====================================================================
 * H.265 TỰ CHỌN KHI XUẤT 4K (index.html, syncExportCodecForFrame — người dùng chốt 2026-10-10:
 * khung xuất 4K, macOS và Windows có HEVC phần cứng, tay chọn giữ theo từng dự án). Đo M1 Pro,
 * "Forever Inside" 4K cắt 300 s: H.264 120,6 s -> H.265 89,2 s (−26%); H.265 so với H.264 51 dB,
 * file nhỏ hơn 15%.
 *
 * Hàm thật chạy trong VM (DOM giả):
 *   A. có HEVC phần cứng: khung xuất cạnh dài >= 3840 (preset hoặc sequence khi "Theo Sequence")
 *      -> hevc, nhỏ hơn -> h264; đổi xong thì cập nhật ô Bitrate;
 *   B. người dùng đã tự chọn codec -> không đụng; ProRes không bao giờ bị đổi;
 *   C. không có HEVC phần cứng (libx265 trên CPU chậm hơn libx264) -> không đụng;
 *   D. mở/tạo dự án (chỉ khi có HEVC phần cứng): bỏ lựa chọn tay của dự án trước, về H.264 rồi chọn
 *      lại theo khung xuất; không có HEVC phần cứng thì giữ suốt phiên như trước;
 *   E. nối vào: đổi "Độ phân giải", mở hộp thoại xuất (class `active`), `change` của ô Codec,
 *      mở/tạo dự án, và hỏi /api/export-encoder;
 *   F. backend thật + sidecar thật: /api/export-encoder trả đúng bộ mã hoá; tắt mã hoá phần cứng
 *      (FFMPEG_EXPORT_HW=0) -> libx265, hardware=false.
 *
 * Chạy: npm run test:export-auto-hevc
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `không tìm thấy hàm ${name}()`);
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

function extractConst(src, name) {
  const start = src.indexOf(`const ${name} = {`);
  assert.notStrictEqual(start, -1, `không tìm thấy const ${name}`);
  const end = src.indexOf('};', start);
  return src.slice(start, end + 2);
}

function sandbox({ hw, resolution = 'source', codec = 'h264', seq = { width: 1920, height: 1080 }, touched = false }) {
  const els = {
    exportResolution: { value: resolution },
    exportCodec: { value: codec },
  };
  const sb = {
    bitrateSyncs: 0,
    document: { getElementById: (id) => els[id] || null },
    getSequencePayload: () => seq,
    syncExportBitrateUi() { sb.bitrateSyncs += 1; },
  };
  vm.createContext(sb);
  vm.runInContext([
    extractConst(INDEX, 'EXPORT_PRESET_FRAMES'),
    `let exportAutoHevc = ${hw ? 'true' : 'false'};`,
    `let exportCodecTouched = ${touched ? 'true' : 'false'};`,
    extractFunction(INDEX, 'exportFrameIs4k'),
    extractFunction(INDEX, 'syncExportCodecForFrame'),
    extractFunction(INDEX, 'resetExportCodecForProject'),
    'globalThis.sync = syncExportCodecForFrame; globalThis.reset = resetExportCodecForProject;',
    'globalThis.isTouched = () => exportCodecTouched;',
  ].join('\n'), sb);
  sb.els = els;
  return sb;
}

// --- A ---
{
  const cases = [
    { resolution: 'source', seq: { width: 3840, height: 1646 }, want: 'hevc', why: 'sequence 3840×1646 (Forever Inside)' },
    { resolution: 'source', seq: { width: 2160, height: 3840 }, want: 'hevc', why: 'sequence dọc 4K' },
    { resolution: 'source', seq: { width: 1080, height: 1920 }, want: 'h264', why: 'sequence 1080×1920' },
    { resolution: 'p2160', seq: { width: 1920, height: 1080 }, want: 'hevc', why: 'preset UHD 4K' },
    { resolution: 'vertical_2160', seq: { width: 1080, height: 1920 }, want: 'hevc', why: 'preset dọc 4K' },
    { resolution: 'p1080', seq: { width: 3840, height: 2160 }, want: 'h264', why: 'sequence 4K nhưng xuất 1080p' },
    { resolution: 'p1440', seq: { width: 3840, height: 2160 }, want: 'h264', why: 'xuất 1440p' },
  ];
  for (const c of cases) {
    const sb = sandbox({ hw: true, resolution: c.resolution, seq: c.seq });
    sb.sync();
    assert.strictEqual(sb.els.exportCodec.value, c.want, `${c.why}: phải là ${c.want}`);
  }
  // Về lại dưới 4K -> trả về H.264 (chỉ khi người dùng chưa tự chọn).
  const back = sandbox({ hw: true, resolution: 'p1080', codec: 'hevc' });
  back.sync();
  assert.strictEqual(back.els.exportCodec.value, 'h264', 'đổi về 1080p: trả lại H.264');
  assert.strictEqual(back.bitrateSyncs, 1, 'đổi codec thì cập nhật ô Bitrate');
  const same = sandbox({ hw: true, resolution: 'p1080', codec: 'h264' });
  same.sync();
  assert.strictEqual(same.bitrateSyncs, 0, 'không đổi gì thì không đụng ô Bitrate');
  const noSeq = sandbox({ hw: true, resolution: 'source', seq: null });
  noSeq.sync();
  assert.strictEqual(noSeq.els.exportCodec.value, 'h264', 'chưa có sequence: giữ H.264');
  console.log('  ok  có HEVC phần cứng: khung xuất 4K -> H.265, dưới 4K -> H.264, cập nhật Bitrate khi đổi');
}

// --- B, C ---
{
  const touched = sandbox({ hw: true, resolution: 'p2160', codec: 'h264', touched: true });
  touched.sync();
  assert.strictEqual(touched.els.exportCodec.value, 'h264', 'người dùng đã tự chọn: giữ nguyên');
  const prores = sandbox({ hw: true, resolution: 'p2160', codec: 'prores' });
  prores.sync();
  assert.strictEqual(prores.els.exportCodec.value, 'prores', 'ProRes không bao giờ bị đổi');
  const win = sandbox({ hw: false, resolution: 'p2160', codec: 'h264' });
  win.sync();
  assert.strictEqual(win.els.exportCodec.value, 'h264', 'không có HEVC phần cứng: không tự đổi');
  console.log('  ok  tôn trọng lựa chọn tay + ProRes; không có HEVC phần cứng thì không tự đổi');
}

// --- D: theo từng dự án ---
{
  const a = sandbox({ hw: true, resolution: 'source', codec: 'h264', touched: true, seq: { width: 3840, height: 2160 } });
  a.reset();
  assert.strictEqual(a.isTouched(), false, 'mở dự án khác: bỏ dấu đã chọn tay');
  assert.strictEqual(a.els.exportCodec.value, 'hevc', 'dự án mới 4K: tự chọn lại H.265');
  const p = sandbox({ hw: true, resolution: 'source', codec: 'prores', touched: true, seq: { width: 1080, height: 1920 } });
  p.reset();
  assert.strictEqual(p.els.exportCodec.value, 'h264', 'ProRes chọn tay ở dự án trước không đi theo sang dự án mới');
  const n = sandbox({ hw: false, resolution: 'source', codec: 'prores', touched: true });
  n.reset();
  assert.strictEqual(n.els.exportCodec.value, 'prores', 'không có HEVC phần cứng: giữ lựa chọn suốt phiên như trước');
  assert.strictEqual(n.isTouched(), true, 'không có HEVC phần cứng: không bỏ dấu đã chọn tay');
  console.log('  ok  mở/tạo dự án: bỏ lựa chọn tay của dự án trước, chọn lại theo khung xuất');
}

// --- E ---
{
  assert.ok(/fetch\(`\$\{API_BASE\}\/export-encoder\?codec=hevc`\)[\s\S]{0,200}exportAutoHevc = data\?\.hardware === true;/.test(INDEX),
    'bật theo /api/export-encoder (HEVC phần cứng)');
  assert.strictEqual((INDEX.match(/exportFileNameTouched = false;\n\s*resetExportCodecForProject\(\);/g) || []).length, 2,
    'mở dự án và tạo dự án mới đều phải gọi resetExportCodecForProject');
  assert.ok(/getElementById\('exportCodec'\)\?\.addEventListener\('change', \(\) => \{ exportCodecTouched = true; \}\)/.test(INDEX),
    'đổi tay ô Codec phải đánh dấu đã chọn');
  assert.ok(/getElementById\('exportResolution'\)\?\.addEventListener\('change', syncExportCodecForFrame\)/.test(INDEX),
    'đổi Độ phân giải phải chọn lại codec');
  assert.ok(/classList\.contains\('active'\)\) syncExportCodecForFrame\(\)/.test(INDEX)
    && /getElementById\('exportModalPanel'\)/.test(INDEX), 'mở hộp thoại xuất phải chọn lại codec');
  console.log('  ok  nối vào: đổi Độ phân giải, mở hộp thoại xuất, đổi tay ô Codec, mở/tạo dự án, hỏi backend');
}

// --- F: backend + sidecar thật ---
async function backendCheck() {
  const SIDECAR = path.join(ROOT, 'native', 'sidecar', 'build', process.platform === 'win32' ? 'core_process.exe' : 'core_process');
  if (!fs.existsSync(SIDECAR)) {
    console.log('  --  chưa build sidecar: bỏ qua phần backend');
    return;
  }
  const { spawnSync } = require('child_process');
  const run = (env) => {
    const r = spawnSync(SIDECAR, ['export-encoder', 'hevc'], { encoding: 'utf8', env: { ...process.env, ...env } });
    return JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop());
  };
  const off = run({ FFMPEG_EXPORT_HW: '0' });
  assert.deepStrictEqual([off.type, off.message], ['result', 'libx265'], 'tắt mã hoá phần cứng: libx265');
  const bad = spawnSync(SIDECAR, ['export-encoder', 'vp9'], { encoding: 'utf8' });
  assert.strictEqual(bad.status, 2, 'codec lạ: mã thoát 2');

  process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8147';
  process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || path.join(ROOT, 'test_temp', 'export_auto_hevc');
  const { start } = require('../../backend/server');
  const server = start();
  try {
    await new Promise((r) => setTimeout(r, 300));
    const res = await fetch(`http://127.0.0.1:${process.env.BACKEND_PORT}/api/export-encoder?codec=hevc`);
    assert.strictEqual(res.ok, true);
    const data = await res.json();
    const expected = run({}).message;
    assert.strictEqual(data.encoder, expected, 'backend trả đúng bộ mã hoá sidecar chọn');
    assert.strictEqual(data.hardware, !expected.startsWith('lib'), 'hardware = không phải bộ mã hoá CPU');
    if (process.platform === 'darwin') assert.strictEqual(data.encoder, 'hevc_videotoolbox', 'macOS: VideoToolbox');
    const again = await (await fetch(`http://127.0.0.1:${process.env.BACKEND_PORT}/api/export-encoder?codec=bogus`)).json();
    assert.strictEqual(again.codec, 'h264', 'codec lạ -> h264');
    console.log(`  ok  backend + sidecar: hevc -> ${data.encoder} (hardware=${data.hardware}); tắt HW -> libx265`);
  } finally {
    server.close();
  }
}

backendCheck().then(() => {
  console.log('export auto hevc ok');
  process.exit(0);
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
