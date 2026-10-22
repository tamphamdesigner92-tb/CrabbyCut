/* =====================================================================
 * XUẤT VIDEO LỚP PHỦ CÓ BIẾN DẠNG (Distort) — trọn tuyến backend + sidecar.
 *
 * Video lớp phủ 160×90 có Wave Warp đang chạy (speed ≠ 0) đặt ở giữa khung 320×180, từ 0,5 s.
 * Kiểm:
 *   - sidecar uốn trước (DistortVideoPrepass) và bản xuất có HÌNH ĐÃ UỐN đúng chỗ, đúng khung:
 *     khung xuất so với ảnh tham chiếu dựng bằng CHÍNH distort.js (rasterMesh trên khung nguồn
 *     tương ứng) — sai số trung bình nhỏ, và nhỏ hơn hẳn so với ảnh KHÔNG uốn;
 *   - tiếng của lớp phủ vẫn còn (tách thành lớp audio đọc từ tệp gốc);
 *   - xuất lại dùng lại tệp đã uốn (distort_cache).
 *
 * Chạy: npm run test:export-distort   (cần sidecar đã build)
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8131';
const projectRoot = path.resolve(__dirname, '..', '..');
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR
  || path.join(projectRoot, 'test_temp', 'export_distort_video');
const tempDir = path.resolve(process.env.CRAB_TEMP_DIR);
const { start } = require('../../backend/server');
const D = require('../../static/js/distort.js');

const SEQ = { width: 320, height: 180, preset: 'custom', source_width: 320, source_height: 180, source_fps: '24' };
const FPS = 24;
const OV_W = 160;
const OV_H = 90;
const START = 0.5;
const DUR = 1.5;

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { cwd: projectRoot, maxBuffer: 64 * 1024 * 1024, ...opts });
  assert.strictEqual(result.status, 0, `${command} failed\n${(result.stderr || result.stdout || '').toString()}`);
  return result;
}

// Khung thứ n (đếm từ 0) của tệp, dạng điểm ảnh thô.
function frameAt(file, n, pixFmt, w, h) {
  const out = run('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', pixFmt, '-'], { encoding: 'buffer' }).stdout;
  const bpp = pixFmt === 'rgba' ? 4 : 3;
  assert.strictEqual(out.length, w * h * bpp, `khung ${n} của ${path.basename(file)} sai cỡ`);
  return out;
}

async function exportWith(baseUrl, editing) {
  const form = new FormData();
  form.append('timeline_json', JSON.stringify([{ start: 0, end: 2.5 }]));
  form.append('blank_base', '1');
  form.append('editing_json', JSON.stringify(editing));
  form.append('export_settings', JSON.stringify({
    resolution: 'sequence', sequence: SEQ, fps: String(FPS), codec: 'h264', quality: 'high', audio_bitrate: '128k',
  }));
  form.append('sequence_settings', JSON.stringify(SEQ));
  form.append('export_fps', String(FPS));
  const response = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: form });
  if (!response.ok) throw new Error(await response.text());
  await response.arrayBuffer();
  const reportPath = response.headers.get('x-project-report-path');
  if (reportPath) fs.rmSync(reportPath, { force: true });
  const outputPath = path.join(tempDir, 'final_cut.mp4');
  assert.ok(fs.existsSync(outputPath), 'không có tệp xuất');
  return outputPath;
}

async function main() {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  const server = start();
  const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    // Nguồn có chi tiết (testsrc2) để phép uốn hiện rõ; kèm tiếng sine.
    const src = path.join(tempDir, 'overlay_src.mp4');
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${OV_W}x${OV_H}:r=${FPS}:d=3`,
      '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);

    const item = {
      id: 'item_vid_1', type: 'media', track_id: 'track_video_1', asset_id: 'asset_vid_1',
      timeline_start: START, duration: DUR, source_start: 0,
      transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 },
      distort: [
        // Puppet đứng đầu: ghim trái đứng yên, ghim phải có keyframe (lưới đã giải gửi theo khung).
        { id: 'u1', type: 'puppet', enabled: true, params: { triangles: 150, pins: [
          { id: 'a', rest: [0.25, 0.5], pos: [0.25, 0.5] },
          { id: 'b', rest: [0.75, 0.5], pos: [0.8, 0.35] },
        ] } },
        { id: 'd1', type: 'wave', enabled: true,
          params: { wave_type: 'sine', height: 9, width: 36, direction: 90, speed: 1.2, pinning: 'none', phase: 0 } },
        // Bezier Warp xếp sau Wave: góc dưới-phải kéo ra, cạnh trên võng xuống.
        { id: 'd2', type: 'bezier', enabled: true,
          params: { br_vertex: [1.12, 1.08], tl_tangent: [0.33, 0.15], tr_tangent: [0.66, 0.15] } },
      ],
    };
    item.keyframes = { 'dst.u1.pin_b': [{ t: 0, v: [0.75, 0.5], e: 'ease-in-out' }, { t: 1, v: [0.8, 0.35] }] };
    item.distort_spec = D.exportSpec(item, OV_W, OV_H, FPS, DUR);
    const editing = {
      tracks: [
        { id: 'track_video_1', type: 'video', order: 0, visible: true },
        { id: 'track_main', type: 'main', order: 1, visible: true, volume: 100 },
      ],
      assets: [{ id: 'asset_vid_1', type: 'media_video', name: 'overlay_src.mp4', path: src,
        width: OV_W, height: OV_H, duration: 3, has_audio: true }],
      items: [item],
    };

    const out = await exportWith(baseUrl, editing);
    const cacheDir = path.join(tempDir, 'distort_cache');
    const cached = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir).filter((f) => f.endsWith('.mov')) : [];
    assert.strictEqual(cached.length, 1, 'sidecar phải dựng đúng một tệp đã uốn');

    // Tiếng của lớp phủ còn nguyên.
    const streams = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', out],
      { encoding: 'utf8' }).stdout;
    assert.ok(/audio/.test(streams), 'bản xuất mất tiếng của lớp phủ có Distort');

    // Khung xuất n = 24 (t = 1,0 s) <-> khung lớp phủ k = 12 (giây cục bộ 0,5).
    const n = 24;
    const k = n - Math.round(START * FPS);
    const outFrame = frameAt(out, n, 'rgb24', SEQ.width, SEQ.height);
    const srcFrame = frameAt(src, k, 'rgba', OV_W, OV_H);
    const spec = item.distort_spec;
    const grid = D.evalSpecStack(spec.stacks[spec.frames[k]], OV_W, OV_H, spec.grid, spec.meshes, spec.puppets);
    const size = D.outputSize(spec.ext, 1);
    const warped = new Uint8ClampedArray(size.width * size.height * 4);
    D.rasterMesh(new Uint8ClampedArray(srcFrame), OV_W, OV_H, spec.grid.cols, spec.grid.rows,
      D.gridToPixels(grid, 1, size.width, size.height), warped, size.width, size.height);
    // Ghép lên nền đen ở tâm khung -> ảnh tham chiếu.
    const ox = (SEQ.width - size.width) / 2;
    const oy = (SEQ.height - size.height) / 2;
    const ref = (x, y, c) => {
      const lx = x - ox;
      const ly = y - oy;
      if (lx < 0 || ly < 0 || lx >= size.width || ly >= size.height) return 0;
      const q = (ly * size.width + lx) * 4;
      return (warped[q + c] * warped[q + 3]) / 255;
    };
    const plain = (x, y, c) => {
      const lx = x - (SEQ.width - OV_W) / 2;
      const ly = y - (SEQ.height - OV_H) / 2;
      if (lx < 0 || ly < 0 || lx >= OV_W || ly >= OV_H) return 0;
      return srcFrame[(ly * OV_W + lx) * 4 + c];
    };
    let errWarp = 0;
    let errPlain = 0;
    let count = 0;
    // Khung đã nở có thể lớn hơn khung xuất -> chỉ so phần nằm trong khung.
    for (let y = Math.max(0, oy); y < Math.min(SEQ.height, oy + size.height); y += 1) {
      for (let x = Math.max(0, ox); x < Math.min(SEQ.width, ox + size.width); x += 1) {
        for (let c = 0; c < 3; c += 1) {
          const got = outFrame[(y * SEQ.width + x) * 3 + c];
          errWarp += Math.abs(got - ref(x, y, c));
          errPlain += Math.abs(got - plain(x, y, c));
          count += 1;
        }
      }
    }
    errWarp /= count;
    errPlain /= count;
    console.log(`  khung ${n}: lệch trung bình so với tham chiếu uốn ${errWarp.toFixed(2)}, so với ảnh không uốn ${errPlain.toFixed(2)}`);
    assert.ok(errWarp < 6, `hình đã uốn lệch tham chiếu quá nhiều (${errWarp.toFixed(2)})`);
    assert.ok(errPlain > errWarp * 2, 'bản xuất không thấy biến dạng');

    // Xuất lại không đổi gì -> dùng lại tệp đã uốn (không dựng thêm).
    const before = fs.statSync(path.join(cacheDir, cached[0])).mtimeMs;
    await exportWith(baseUrl, editing);
    assert.strictEqual(fs.statSync(path.join(cacheDir, cached[0])).mtimeMs, before, 'xuất lại phải dùng lại tệp đã uốn');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  console.log('export distort video ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
