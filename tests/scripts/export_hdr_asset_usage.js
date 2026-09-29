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

async function main() {
  fs.rmSync(tempDir, { recursive: true, force: true });
  const mediaDir = path.join(tempDir, 'library');
  fs.mkdirSync(mediaDir, { recursive: true });
  const usedPath = path.join(mediaDir, 'hdr_used.mp4');
  const unusedPath = path.join(mediaDir, 'hdr_unused.mp4');
  makeHdrClip(usedPath, 'red');
  makeHdrClip(unusedPath, 'blue');

  const { sdrOverridesForEditingAssets } = require('../../backend/server');
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

  // 2. Không item nào dùng video -> không mã hoá gì, dù thư viện đầy video HDR.
  fs.rmSync(path.join(tempDir, 'editing_assets', 'sdr'), { recursive: true, force: true });
  const none = await sdrOverridesForEditingAssets({ tracks: [], items: [], assets });
  assert.strictEqual(none.size, 0);
  assert.deepStrictEqual(sdrOutputs(), [], 'dự án không lớp phủ video thì lượt xuất không được hạ SDR gì');
  console.log('  ok  không item dùng video -> không hạ SDR file nào');

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('export hdr asset usage ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 100));
