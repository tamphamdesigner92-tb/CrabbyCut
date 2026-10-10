/* =====================================================================
 * DỰ ÁN CŨ CÒN ASSET .svg -> VẼ RA PNG KHI NẠP (migrateLegacyVectorAssets, editing-runtime.js)
 *
 * Người dùng gặp (dự án "Shop Yêu Con", nhập SVG từ tháng 8, trước khi có bước vẽ lúc nhập):
 * asset vẫn trỏ vào tệp .svg -> sidecar đưa thẳng vào ffmpeg -> "no decoder found for: svg",
 * lượt xuất chết ở mọi bản ffmpeg (bản ghim không có librsvg). test:vector-asset chỉ phủ đường
 * NHẬP; bài này phủ đường MỞ DỰ ÁN CŨ. Hàm thật chạy trong VM, chỗ vẽ (Chromium) được giả lập.
 *
 * Chốt:
 *   A. asset .svg thành PNG, GIỮ id (block trỏ asset_id không đổi), giữ cỡ cũ, không gửi
 *      replace_path (undo về trạng thái cũ vẫn cần tệp .svg);
 *   B. vẽ hỏng -> giữ nguyên asset; trạng thái đổi giữa chừng (undo) -> không ghi đè;
 *      không có .svg -> không làm gì;
 *   C. restoreEditingHistoryState gọi việc này SAU khi nạp editingAssets; exportPayload chờ nó
 *      rồi báo lỗi rõ ràng nếu block còn trỏ vào .svg (thay vì để ffmpeg chết).
 *
 * Chạy: npm run test:legacy-vector
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME = fs.readFileSync(path.join(ROOT, 'static', 'js', 'editing-runtime.js'), 'utf8');

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

function makeSandbox(assets, rasterize) {
  const sandbox = { editingAssets: assets, rasterCalls: [], renders: 0, rasterize };
  vm.createContext(sandbox);
  vm.runInContext([
    "const VECTOR_ASSET_RE = /\\.svg$/i;",
    'let legacyVectorMigration = null;',
    'function renderEditPanel() { globalThis.renders += 1; }',
    'function renderAll() {}',
    'async function rasterizeVectorAssets(raws, kind) { globalThis.rasterCalls.push({ raws, kind }); return globalThis.rasterize(raws); }',
    extractFunction(RUNTIME, 'isVectorAssetRecord'),
    extractFunction(RUNTIME, 'migrateLegacyVectorAssets'),
    'globalThis.api = { isVectorAssetRecord, migrateLegacyVectorAssets, pending: () => legacyVectorMigration };',
  ].join('\n'), sandbox);
  return sandbox;
}

const svgAsset = () => ({
  id: 'bc813725fe79982b', type: 'media_image', name: 'logistics-service-van.svg',
  url: '/temp_uploads/editing_assets/logistics-service-van.svg?v=1',
  thumbnail_url: '/temp_uploads/editing_assets/logistics-service-van.svg?v=1',
  path: '/proj/temp_uploads/editing_assets/logistics-service-van.svg',
  source_path: '/Users/x/Downloads/logistics-service-van.svg', linked: false, width: 1760, height: 1760,
});
const pngAsset = () => ({ id: 'png1', type: 'media_image', name: 'logo.png', url: '/temp_uploads/editing_assets/logo.png', path: '/proj/temp_uploads/editing_assets/logo.png', width: 10, height: 10 });
// Giả lập endpoint /rasterize: trả asset PNG mới (id do backend băm khác — hàm thật phải giữ id cũ).
const okRaster = (raws) => raws.map((raw) => ({
  id: 'from-backend', type: 'media_image', name: raw.name,   // backend giữ tên hiển thị .svg
  url: '/temp_uploads/editing_assets/logistics-service-van.png?v=2',
  thumbnail_url: '/temp_uploads/editing_assets/logistics-service-van.png?v=2',
  path: '/proj/temp_uploads/editing_assets/logistics-service-van.png', width: 3520, height: 3520,
}));

async function main() {
  // --- A: chuyển đúng, giữ id + cỡ, không dọn .svg ---
  {
    const assets = [svgAsset(), pngAsset()];
    const sb = makeSandbox(assets, okRaster);
    assert.strictEqual(sb.api.isVectorAssetRecord(assets[0]), true);
    assert.strictEqual(sb.api.isVectorAssetRecord(assets[1]), false);
    assert.strictEqual(sb.api.isVectorAssetRecord({ name: 'x', url: '/a/b.SVG?v=3' }), true, 'nhận .svg qua url có query');
    assert.strictEqual(sb.api.isVectorAssetRecord({ name: 'logo.svg', path: '/a/logo.png', url: '/a/logo.png' }), false,
      'bản PNG giữ tên hiển thị .svg KHÔNG được coi là vector (nếu không: chuyển lại mãi, xuất báo lỗi oan)');
    await sb.api.migrateLegacyVectorAssets();
    assert.strictEqual(sb.rasterCalls.length, 1);
    assert.strictEqual(sb.rasterCalls[0].raws.length, 1, 'chỉ asset .svg được gửi đi vẽ');
    assert.strictEqual(sb.rasterCalls[0].raws[0].path, '', 'không gửi replace_path: tệp .svg phải còn cho các trạng thái undo');
    const a = assets[0];
    assert.strictEqual(a.id, 'bc813725fe79982b', 'giữ id: block trỏ asset_id không phải đổi');
    assert.strictEqual(a.path.endsWith('.png'), true, 'asset phải trỏ vào PNG');
    assert.strictEqual(a.url.includes('.png'), true);
    assert.strictEqual(a.thumbnail_url.includes('.png'), true);
    assert.strictEqual(a.name, 'logistics-service-van.svg', 'tên hiển thị giữ nguyên');
    assert.strictEqual(a.width, 1760, 'giữ cỡ cũ (block đã dựng theo cỡ này, PNG cùng tỉ lệ)');
    assert.strictEqual(sb.api.isVectorAssetRecord(a), false);
    assert.strictEqual(assets[1].path, '/proj/temp_uploads/editing_assets/logo.png', 'asset PNG không bị đụng');
    assert.strictEqual(sb.renders, 1, 'vẽ lại panel sau khi đổi');
    assert.strictEqual(sb.api.pending(), null, 'xong thì nhả cờ đang chạy');
    console.log('  ok  .svg -> PNG, giữ id + cỡ + tên, không dọn tệp .svg');
  }

  // --- B: vẽ hỏng / trạng thái đổi giữa chừng / không có .svg ---
  {
    const assets = [svgAsset()];
    const sb = makeSandbox(assets, (raws) => raws);   // rasterizeVectorAssets hỏng -> trả raw
    await sb.api.migrateLegacyVectorAssets();
    assert.strictEqual(sb.api.isVectorAssetRecord(assets[0]), true, 'vẽ hỏng: giữ nguyên asset');
    assert.strictEqual(sb.renders, 0);

    const assets2 = [svgAsset()];
    const sb2 = makeSandbox(assets2, okRaster);
    const job = sb2.api.migrateLegacyVectorAssets();
    sb2.editingAssets.length = 0;                     // undo giữa chừng: trạng thái mới không còn asset đó
    sb2.editingAssets.push({ ...svgAsset(), id: 'other' });
    await job;
    assert.strictEqual(sb2.editingAssets[0].id, 'other');
    assert.strictEqual(sb2.api.isVectorAssetRecord(sb2.editingAssets[0]), true, 'không ghi vào asset khác id');

    const sb3 = makeSandbox([pngAsset()], okRaster);
    assert.strictEqual(sb3.api.migrateLegacyVectorAssets(), null, 'không có .svg: không làm gì');
    assert.strictEqual(sb3.rasterCalls.length, 0);
    console.log('  ok  vẽ hỏng giữ nguyên; undo giữa chừng không ghi đè; không có .svg thì bỏ qua');
  }

  // --- C: nối vào đường nạp trạng thái và đường xuất ---
  {
    const restore = extractFunction(RUNTIME, 'restoreEditingHistoryState');
    const at = restore.indexOf('migrateLegacyVectorAssets()');
    assert.ok(at > 0, 'restoreEditingHistoryState phải gọi migrateLegacyVectorAssets');
    assert.ok(at > restore.indexOf('editingAssets = '), 'gọi SAU khi editingAssets đã nạp');
    const exp = extractFunction(RUNTIME, 'exportPayload');
    const wait = exp.indexOf('await legacyVectorMigration');
    assert.ok(wait > 0, 'exportPayload phải chờ việc chuyển .svg');
    assert.ok(/isVectorAssetRecord\(findAsset\(item\.asset_id\)\)/.test(exp), 'exportPayload kiểm block còn trỏ .svg');
    assert.ok(exp.indexOf('throw new Error(_t(') > wait && exp.indexOf('throw new Error(_t(') < exp.indexOf('ensureMainTrack()'),
      'báo lỗi rõ ràng TRƯỚC khi dựng payload');
    console.log('  ok  mở dự án gọi chuyển đổi; xuất chờ nó và báo lỗi rõ nếu còn .svg');
  }
  console.log('legacy vector assets ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
