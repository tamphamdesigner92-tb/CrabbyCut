/* FILE VECTOR (.svg) trong panel "Tệp phương tiện" — kiểm phần backend.
 *
 * Vì sao có test này: ffmpeg/ffprobe KHÔNG có bộ giải mã SVG (ffprobe trả 0×0, export
 * dừng với "no decoder found for: svg"), trong khi Chromium lại vẽ SVG được. Nên preview
 * "có vẻ chạy" còn export thì chết — đúng kiểu lỗi chỉ lộ ra ở khâu cuối. Cách chốt:
 * lúc NHẬP, frontend vẽ SVG ra PNG rồi gửi lên /api/editing-assets/rasterize; từ đó trở
 * đi asset là ảnh raster bình thường.
 *
 * Đo 3 điều:
 *   1. .svg được nhận là asset ảnh hợp lệ (còn .ai/.eps thì KHÔNG — không rasterize nổi);
 *   2. /api/editing-assets/rasterize cất PNG vào editing_assets, giữ TÊN HIỂN THỊ .svg,
 *      trả về số đo thật và dọn bản .svg mà /import-local vừa chép;
 *   3. asset trả về trỏ vào file PNG có thật và phát được qua /temp_uploads.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8141';
const TEST_TEMP = path.join(__dirname, '..', '..', 'test_temp', 'vector_asset_raster');
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || TEST_TEMP;

const { start } = require('../../backend/server');

const FIXTURE_ROOT = path.join(TEST_TEMP, 'fixture');
const ASSET_DIR = path.join(TEST_TEMP, 'editing_assets');

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">'
  + '<rect width="120" height="60" fill="#0a84ff"/></svg>';

// PNG 2×1 hợp lệ — đóng vai "ảnh frontend vừa vẽ từ SVG" (backend chỉ cất file, việc vẽ
// nằm ở Chromium nên test này không dựng canvas).
const PNG_2x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEklEQVR4nGP8z8Dwn4GBgYEBAA8EAgEuOZgGAAAAAElFTkSuQmCC',
  'base64',
);

async function main() {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
  const svgPath = path.join(FIXTURE_ROOT, 'logo.svg');
  fs.writeFileSync(svgPath, SVG, 'utf8');
  const aiPath = path.join(FIXTURE_ROOT, 'logo.ai');
  fs.writeFileSync(aiPath, Buffer.alloc(64, 5));

  const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
  const server = start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    // --- 1: .svg vào được, .ai bị loại ---
    const importRes = await fetch(`${baseUrl}/api/editing-assets/import-local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'media', paths: [svgPath, aiPath] }),
    });
    assert.strictEqual(importRes.ok, true, 'import .svg phải thành công');
    const imported = (await importRes.json()).assets;
    assert.strictEqual(imported.length, 1, '.ai không được nhận (không rasterize nổi)');
    const rawAsset = imported[0];
    assert.strictEqual(rawAsset.type, 'media_image', '.svg phải được coi như ảnh');
    assert.strictEqual(rawAsset.width, null, 'ffprobe không đọc nổi SVG -> chưa có số đo');
    assert.strictEqual(fs.existsSync(rawAsset.path), true);

    // --- 2: rasterize thay bản .svg bằng PNG, giữ tên hiển thị ---
    const form = new FormData();
    form.append('file', new Blob([PNG_2x1], { type: 'image/png' }), 'logo.png');
    form.append('display_name', 'logo.svg');
    form.append('kind', 'media');
    form.append('source_path', svgPath);
    form.append('replace_path', rawAsset.path);
    const rasterRes = await fetch(`${baseUrl}/api/editing-assets/rasterize`, { method: 'POST', body: form });
    assert.strictEqual(rasterRes.ok, true, 'rasterize phải thành công');
    const asset = (await rasterRes.json()).asset;
    assert.strictEqual(asset.name, 'logo.svg', 'panel vẫn hiện tên file gốc');
    assert.strictEqual(asset.type, 'media_image');
    assert.strictEqual(asset.source_path, svgPath, 'giữ nguồn để relink lúc mở lại dự án');
    assert.strictEqual(path.extname(asset.path), '.png', 'file thật phải là PNG');
    assert.strictEqual(path.dirname(asset.path), ASSET_DIR);
    assert.strictEqual(asset.width, 2, 'ffprobe đọc được PNG -> có số đo thật');
    assert.strictEqual(asset.height, 1);
    assert.strictEqual(fs.existsSync(rawAsset.path), false, 'bản .svg đã chép phải bị dọn');
    assert.strictEqual(fs.existsSync(svgPath), true, 'KHÔNG được đụng vào file gốc của người dùng');

    // --- 3: URL trả về phát được ---
    const fileRes = await fetch(`${baseUrl}${asset.url}`);
    assert.strictEqual(fileRes.ok, true, 'asset phải phát được qua /temp_uploads');
    assert.strictEqual(fileRes.headers.get('content-type'), 'image/png');

    console.log('vector asset raster ok');
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
