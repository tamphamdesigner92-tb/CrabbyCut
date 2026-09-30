/**
 * Lúc xuất CHỈ hạ SDR cho video HDR mà item thật sự dùng (mục 1.15 của
 * docs/KE_HOACH_TOI_UU_EXPORT_WIN.md). Chạy: npm run test:export-hdr-asset-usage
 *
 * Vì sao có test này: `editing_json.assets` là cả THƯ VIỆN của dự án, gồm cả video nguồn lane
 * chính mà dự án tự đăng ký làm asset "liên kết". Trước bản sửa, sdrOverridesForEditingAssets
 * mã hoá lại MỌI video HDR trong đó. Đo 2026-09-28 trên "Bin Tom - Tap 3": 72,5 s trong tổng
 * 129 s của lượt xuất đầu là để hạ SDR một file 270 s mà không lớp phủ nào đọc. Hỏng kiểu này
 * không sai hình, chỉ chậm — nên không test nào khác bắt được.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
// Thư mục tạm riêng, đặt TRƯỚC khi require server (xem export_smoke.js).
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR
  || path.join(projectRoot, 'test_temp', 'export_hdr_asset_usage');
const tempDir = path.resolve(process.env.CRAB_TEMP_DIR);
// Cache bản SDR riêng của test — không ghi vào cache thật của người dùng (như CRAB_CONCAT_CACHE_DIR).
process.env.CRAB_SDR_CACHE_DIR = path.join(tempDir, '..', 'export_hdr_asset_usage_sdr_cache');
const sdrCacheDir = path.resolve(process.env.CRAB_SDR_CACHE_DIR);

/* Clip ngắn GẮN NHÃN HLG/BT.2020 — sourceIsHdr chỉ đọc nhãn màu, nên không cần nội dung HDR
 * thật. 10-bit nếu libx264 của bản ffmpeg này có, không thì 8-bit (nhãn vẫn là thứ quyết định).
 * Nhãn gắn lên KHUNG bằng `setparams`: cờ `-color_trc` ở đầu ra bị thuộc tính của khung lavfi
 * (unspecified) đè mất trên FFmpeg 8 — file ra chỉ còn colorspace, sourceIsHdr thấy SDR. */
function makeHdrClip(target, color) {
  const base = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=160x90:d=1:r=24`,
    '-vf', 'setparams=color_primaries=bt2020:color_trc=arib-std-b67:colorspace=bt2020nc',
    '-c:v', 'libx264', '-preset', 'ultrafast'];
  let r = spawnSync('ffmpeg', [...base, '-pix_fmt', 'yuv420p10le', target], { encoding: 'utf8' });
  if (r.status !== 0) r = spawnSync('ffmpeg', [...base, '-pix_fmt', 'yuv420p', target], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}

function sdrOutputs() {
  const dir = path.join(tempDir, 'editing_assets', 'sdr');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((key) => fs.readdirSync(path.join(dir, key)));
}

function cacheEntries() {
  if (!fs.existsSync(sdrCacheDir)) return [];
  return fs.readdirSync(sdrCacheDir).flatMap((key) => fs.readdirSync(path.join(sdrCacheDir, key))
    .filter((name) => name.endsWith('.mp4')));
}

async function main() {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(sdrCacheDir, { recursive: true, force: true });
  const mediaDir = path.join(tempDir, 'library');
  fs.mkdirSync(mediaDir, { recursive: true });
  const usedPath = path.join(mediaDir, 'hdr_used.mp4');
  const unusedPath = path.join(mediaDir, 'hdr_unused.mp4');
  makeHdrClip(usedPath, 'red');
  makeHdrClip(unusedPath, 'blue');

  const { sdrOverridesForEditingAssets, ensureSdrAsset, pruneSdrCache } = require('../../backend/server');
  const assets = [
    { id: 'asset_used', type: 'media_video', name: 'hdr_used.mp4', path: usedPath },
    { id: 'asset_unused', type: 'media_video', name: 'hdr_unused.mp4', path: unusedPath },
  ];

  // 1. Thư viện có hai video HDR, item chỉ dùng một -> chỉ một bản SDR.
  const overrides = await sdrOverridesForEditingAssets({
    tracks: [{ id: 'track_main', type: 'main', order: 0 }, { id: 'track_v1', type: 'visual', order: 1 }],
    items: [{ id: 'item_1', type: 'media', track_id: 'track_v1', asset_id: 'asset_used', timeline_start: 0, duration: 1 }],
    assets,
  });
  assert.deepStrictEqual([...overrides.keys()], [usedPath], 'chỉ asset có item mới được đổi sang bản SDR');
  assert.ok(fs.existsSync(overrides.get(usedPath)), 'bản SDR của asset được dùng phải có trên đĩa');
  assert.deepStrictEqual(sdrOutputs(), ['hdr_used.mp4'], 'KHÔNG được mã hoá lại video HDR mà không item nào dùng');
  console.log('  ok  thư viện 2 video HDR, item dùng 1 -> hạ SDR đúng 1 file');

  /* 1b. Cache lâu dài (người dùng chốt 2026-09-29): bản SDR sống qua lần mở lại dự án.
   * /api/reset-project xoá sạch temp_uploads -> giả lập bằng cách xoá editing_assets. Lượt sau
   * phải lấy lại từ cache (cached: true) chứ không mã hoá lại. */
  assert.deepStrictEqual(cacheEntries(), ['hdr_used.mp4'], 'bản SDR vừa dựng phải được cất vào cache lâu dài');
  const firstBytes = fs.statSync(overrides.get(usedPath)).size;
  fs.rmSync(path.join(tempDir, 'editing_assets'), { recursive: true, force: true });
  const t0 = Date.now();
  const again = await ensureSdrAsset(usedPath);
  assert.ok(again.tonemapped && again.cached, `mở lại dự án phải lấy bản SDR từ cache, được ${JSON.stringify(again)}`);
  assert.strictEqual(fs.statSync(again.path).size, firstBytes, 'bản lấy từ cache phải y hệt bản đã dựng');
  assert.ok(again.path.replace(/\\/g, '/').includes('/editing_assets/sdr/'),
    'bản dùng thật vẫn phải nằm dưới editing_assets/ (isTempEditingAssetRecord nhận asset dự án bằng đường dẫn đó)');
  console.log(`  ok  mở lại dự án: lấy bản SDR từ cache sau ${Date.now() - t0} ms, không mã hoá lại`);

  // 1c. Dọn cache: vượt trần thì bỏ; quá hạn thì bỏ. Bản đang dùng trong temp_uploads vẫn còn.
  pruneSdrCache({ maxBytes: firstBytes * 10 });
  assert.deepStrictEqual(cacheEntries(), ['hdr_used.mp4'], 'dưới trần dung lượng thì không được dọn');
  pruneSdrCache({ maxBytes: 1 });
  assert.deepStrictEqual(cacheEntries(), [], 'vượt trần dung lượng thì phải dọn');
  assert.ok(fs.existsSync(again.path), 'dọn cache không được xoá bản đang dùng trong temp_uploads');
  fs.rmSync(path.join(tempDir, 'editing_assets'), { recursive: true, force: true });
  await ensureSdrAsset(usedPath);
  /* Dọn lặp tới khi sạch (tối đa ~2 s): bản mp4 VỪA dựng có lúc còn bị giữ handle một nhịp
   * (ffmpeg chưa nhả hẳn / trình quét virus) nên lượt xoá đầu thất bại và pruneSdrCache bỏ qua
   * mục đó — trong app nó được dọn ở lượt sau, vô hại; đòi sạch ngay lần đầu là test chập chờn. */
  for (let i = 0; i < 20 && cacheEntries().length; i += 1) {
    pruneSdrCache({ ttlMs: -1 });
    if (cacheEntries().length) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.deepStrictEqual(cacheEntries(), [], 'quá hạn dùng thì phải dọn');
  console.log('  ok  dọn cache SDR theo trần dung lượng và hạn dùng');

  // 2. Không item nào dùng video -> không mã hoá gì, dù thư viện đầy video HDR.
  fs.rmSync(path.join(tempDir, 'editing_assets', 'sdr'), { recursive: true, force: true });
  const none = await sdrOverridesForEditingAssets({ tracks: [], items: [], assets });
  assert.strictEqual(none.size, 0);
  assert.deepStrictEqual(sdrOutputs(), [], 'dự án không lớp phủ video thì lượt xuất không được hạ SDR gì');
  console.log('  ok  không item dùng video -> không hạ SDR file nào');

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(sdrCacheDir, { recursive: true, force: true });
  console.log('export hdr asset usage ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
