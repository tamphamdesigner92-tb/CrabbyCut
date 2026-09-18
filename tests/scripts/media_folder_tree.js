/* Panel "Tệp phương tiện" theo THƯ MỤC — kiểm phần backend.
 *
 * Đo 4 điều mà UI dựa hẳn vào:
 *   1. /api/video-sources/scan quét ĐỆ QUY và trả đúng `group_path` cho từng cấp;
 *   2. scan KHÔNG ffprobe / không trích thumbnail (listing phải rẻ) -> width/height rỗng,
 *      thumbnail_url trỏ endpoint lười;
 *   3. /api/source-file và /api/source-thumb CHẶN đường dẫn chưa đăng ký (403) và phát
 *      được đường dẫn đã đăng ký;
 *   4. /api/editing-assets/link giữ nguyên cây thư mục và KHÔNG chép file.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8137';
const TEST_TEMP = path.join(__dirname, '..', '..', 'test_temp', 'media_folder_tree');
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR || TEST_TEMP;

const { start } = require('../../backend/server');

const FIXTURE_ROOT = path.join(TEST_TEMP, 'fixture');
const FOOTAGE = path.join(FIXTURE_ROOT, 'Footage');

// Video giả: đủ để fs.statSync + phần mở rộng hợp lệ. Test này không giải mã gì —
// ffprobe đã bị tách khỏi listing đúng theo thiết kế đang kiểm.
function writeFake(relPath) {
  const full = path.join(FOOTAGE, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.alloc(64, 7));
  return full;
}

async function main() {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  const rootClip = writeFake('intro.mp4');
  const day1Clip = writeFake(path.join('Day1', 'a.mp4'));
  const deepClip = writeFake(path.join('Day1', 'Cam2', 'b.mov'));
  writeFake(path.join('Day1', 'notes.txt')); // không phải video -> phải bị bỏ qua
  const outsider = path.join(TEST_TEMP, 'outside.mp4');
  fs.writeFileSync(outsider, Buffer.alloc(32, 3));

  const port = Number(process.env.BACKEND_PORT);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    // --- 1 & 2: quét đệ quy, giữ cây, không ffprobe ---
    const scanRes = await fetch(`${baseUrl}/api/video-sources/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_paths: [FOOTAGE] }),
    });
    assert.strictEqual(scanRes.ok, true, 'scan phải thành công');
    const scan = await scanRes.json();
    const byName = new Map(scan.videos.map((v) => [v.name, v]));
    assert.strictEqual(scan.videos.length, 3, 'phải thấy 3 video, bỏ qua .txt');
    assert.deepStrictEqual(byName.get('intro.mp4').group_path, ['Footage']);
    assert.deepStrictEqual(byName.get('a.mp4').group_path, ['Footage', 'Day1']);
    assert.deepStrictEqual(byName.get('b.mov').group_path, ['Footage', 'Day1', 'Cam2']);
    assert.strictEqual(byName.get('a.mp4').width, null, 'listing KHÔNG được ffprobe');
    assert.ok(
      byName.get('a.mp4').thumbnail_url.startsWith('/api/source-thumb?path='),
      'thumbnail phải là endpoint lười',
    );

    // --- 3: danh sách trắng ---
    const denied = await fetch(`${baseUrl}/api/source-file?path=${encodeURIComponent(outsider)}`);
    assert.strictEqual(denied.status, 403, 'đường dẫn chưa đăng ký phải bị chặn');
    const deniedThumb = await fetch(`${baseUrl}/api/source-thumb?path=${encodeURIComponent(outsider)}`);
    assert.strictEqual(deniedThumb.status, 403, 'thumbnail cũng phải chặn');

    const allowed = await fetch(`${baseUrl}/api/source-file?path=${encodeURIComponent(day1Clip)}`);
    assert.strictEqual(allowed.status, 200, 'file trong thư mục đã đăng ký phải phát được');
    assert.strictEqual((await allowed.arrayBuffer()).byteLength, 64);

    // Leo ../ ra ngoài thư mục đã đăng ký cũng phải bị chặn.
    const escapePath = path.join(FOOTAGE, '..', '..', 'outside.mp4');
    const escaped = await fetch(`${baseUrl}/api/source-file?path=${encodeURIComponent(escapePath)}`);
    assert.strictEqual(escaped.status, 403, 'không được leo ra ngoài bằng ../');

    // --- 4: link thư mục vào panel Editing, không chép ---
    const linkRes = await fetch(`${baseUrl}/api/editing-assets/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'media', paths: [FOOTAGE] }),
    });
    assert.strictEqual(linkRes.ok, true, 'link phải thành công');
    const link = await linkRes.json();
    assert.strictEqual(link.assets.length, 3);
    const linkedRoot = link.assets.find((a) => a.name === 'intro.mp4');
    assert.deepStrictEqual(linkedRoot.group_path, ['Footage']);
    assert.strictEqual(linkedRoot.linked, true);
    assert.strictEqual(linkedRoot.path, rootClip, 'asset phải trỏ THẲNG vào file nguồn');
    assert.ok(linkedRoot.url.startsWith('/api/source-file?path='));
    const editingAssetDir = path.join(path.resolve(process.env.CRAB_TEMP_DIR), 'editing_assets');
    const copied = fs.existsSync(editingAssetDir) ? fs.readdirSync(editingAssetDir) : [];
    assert.strictEqual(copied.length, 0, 'link KHÔNG được chép file vào editing_assets');

    // id ổn định theo path+size+mtime: nạp lại cùng thư mục phải ra cùng id, nếu không
    // block trên timeline (giữ asset_id) sẽ trỏ vào asset không còn tồn tại.
    const again = await (await fetch(`${baseUrl}/api/editing-assets/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'media', paths: [FOOTAGE] }),
    })).json();
    assert.strictEqual(again.assets.find((a) => a.name === 'intro.mp4').id, linkedRoot.id);

    // --- 5: probe lười trả số đo cho đúng 1 file ---
    const probe = await fetch(`${baseUrl}/api/media-probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: deepClip }),
    });
    assert.strictEqual(probe.ok, true, 'probe file đã đăng ký phải trả 200');
    const probeDenied = await fetch(`${baseUrl}/api/media-probe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: outsider }),
    });
    assert.strictEqual(probeDenied.status, 403, 'probe cũng phải theo danh sách trắng');

    console.log('media folder tree ok');
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
