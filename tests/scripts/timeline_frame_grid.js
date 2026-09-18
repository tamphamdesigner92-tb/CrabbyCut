/* =====================================================================
 * LƯỚI KHUNG HÌNH CỦA TIMELINE — mốc overlay phải TRÙNG biên block
 *
 * LỖI ĐÃ TRẢ GIÁ (bản xuất 2026-08-06): mỗi block khai độ dài theo GIÂY, `fps` phát ra
 * CEIL(giây × fps) khung, nên mốc bắt đầu THẬT của block là tổng dồn các CEIL — trong
 * khi frontend/backend đặt overlay theo tổng dồn SỐ THỰC (làm tròn từng mốc một). Hai
 * lưới trôi ra xa nhau ~1 khung mỗi block; đo được 7.04 khung ở block cuối của một dự
 * án 14 block. Hậu quả: cửa sổ `enable` của miếng vá Retouch bắt đầu SỚM hơn block của
 * chính nó -> miếng vá của block N+1 dán lên khung CUỐI của block N. Mỗi block có
 * transform Auto-Reframe riêng nên miếng vá lạc chỗ hiện thành MỘT HÌNH CHỮ NHẬT lệch
 * khung quanh mặt.
 *
 * TEST NÀY DỰNG LẠI ĐÚNG THẾ TRẬN ĐÓ rồi đòi hai điều:
 *   1. biên MỌI block rơi đúng `round(mốc_tích_luỹ × fps)`, và tổng số khung khớp;
 *   2. chuỗi khung overlay đặt ở mốc block phủ ĐÚNG các khung của block đó — không rỉ
 *      sang block trước, không hụt khung cuối.
 *
 * VÌ SAO PHẢI CHẠY FFMPEG THẬT, không kiểm bằng số học: nguyên nhân số 2 của lỗi chỉ lộ
 * ra khi chạy — `overlay` đồng bộ theo framesync và chạy tới input DÀI NHẤT, chứ không
 * dừng ở input thứ nhất. Chốt độ dài nền `color` thôi là CHƯA đủ; nhánh clip cũng phải
 * bị kẹp. Số học không nhìn thấy điều đó.
 *
 * Thời lượng các block cố ý chọn lẻ (không chia hết cho khung) để lưới CEIL và lưới
 * ROUND phải khác nhau — block giống nhau chằn chặn thì test luôn xanh dù lỗi còn nguyên.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const sidecar = path.join(projectRoot, 'native', 'sidecar', 'build',
  process.platform === 'win32' ? 'core_process.exe' : 'core_process');

const FPS = 30;
const SEQ_W = 160;
const SEQ_H = 120;
// Nguồn 59.94fps giống footage thật: số khung nhánh clip nhả ra sau `fps=30` phụ thuộc
// mốc thời gian THẬT của khung nguồn, chính chỗ làm segment dài thêm 1 khung.
const SRC_FPS = '60000/1001';
// Thời lượng lẻ: tổng dồn CEIL và tổng dồn ROUND phải tách nhau ra.
const DURATIONS = [1.991793, 3.307010, 1.838949, 2.401913, 1.067127, 1.838949];

function run(command, args, label) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.strictEqual(result.status, 0, `${label} failed\n${result.stderr || result.stdout}`);
  return result;
}

// Lưới mà backend (`snapT`) dùng để đặt mốc overlay — và mà sidecar phải dựng theo.
function frameGrid(durations, fps) {
  const boundaries = [0];
  let cumulative = 0;
  let placed = 0;
  for (const duration of durations) {
    cumulative += duration;
    placed += Math.max(1, Math.round(cumulative * fps) - placed);
    boundaries.push(placed);
  }
  return boundaries;
}

// Chuỗi màu đặc thay cho chuỗi miếng vá Retouch: chỉ cần biết nó hiện ở NHỮNG KHUNG NÀO.
function writeMarkerSequence(dir, color, frameCount) {
  fs.mkdirSync(dir, { recursive: true });
  run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=${(frameCount + 2) / FPS}:r=${FPS}`,
    '-frames:v', String(frameCount),
    '-q:v', '2',
    path.join(dir, 'frame_%04d.jpg'),
  ], `marker ${color}`);
  const written = fs.readdirSync(dir).filter((n) => n.endsWith('.jpg')).length;
  assert.strictEqual(written, frameCount, `chuỗi ${color} ra ${written} khung, cần ${frameCount}`);
}

// Phân loại MỘT điểm ảnh ở tâm khung cho từng khung của video -> chuỗi ký tự.
function centerMarkerPerFrame(videoPath) {
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-i', videoPath,
    '-vf', `crop=16:16:${(SEQ_W - 16) / 2}:${(SEQ_H - 16) / 2},scale=1:1`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { cwd: projectRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(result.status, 0, result.stderr?.toString('utf8'));
  const buffer = result.stdout;
  let out = '';
  for (let i = 0; i + 2 < buffer.length; i += 3) {
    const [r, g, b] = [buffer[i], buffer[i + 1], buffer[i + 2]];
    if (r > 150 && b > 150 && g < 110) out += 'M';
    else if (g > 150 && b > 150 && r < 110) out += 'C';
    else out += '.';
  }
  return out;
}

function runOf(marks, ch) {
  const first = marks.indexOf(ch);
  const last = marks.lastIndexOf(ch);
  assert.notStrictEqual(first, -1, `không thấy marker ${ch} trong bản xuất`);
  const contiguous = marks.slice(first, last + 1).split('').every((c) => c === ch);
  assert.ok(contiguous, `marker ${ch} bị ngắt quãng giữa f${first}..f${last}`);
  return { first, last };
}

function main() {
  assert.ok(fs.existsSync(sidecar), `chưa build sidecar: ${sidecar} (npm run build:sidecar)`);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crab_frame_grid_'));
  try {
    const total = DURATIONS.reduce((a, b) => a + b, 0);
    const sourcePath = path.join(workDir, 'source.mp4');
    run('ffmpeg', [
      '-y', '-v', 'error',
      // Nền XÁM TRƠN: bộ phân loại marker chỉ được thấy màu do marker vẽ ra. `testsrc2`
      // có sẵn mảng lục-lam nên tâm khung tự nhận nhầm thành marker.
      '-f', 'lavfi', '-i', `color=c=gray:s=${SEQ_W}x${SEQ_H}:d=${(total + 2).toFixed(3)}:r=${SRC_FPS}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${(total + 2).toFixed(3)}`,
      '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      sourcePath,
    ], 'source');

    const grid = frameGrid(DURATIONS, FPS);
    // Marker cho block 1 và block 3 (đủ để bắt cả rỉ-sang-trước lẫn hụt-khung-cuối,
    // và cách nhau một block nên không dính nhau).
    const markers = [
      { id: 'markA', block: 1, color: 'magenta', ch: 'M', dir: path.join(workDir, 'segA') },
      { id: 'markC', block: 3, color: 'cyan', ch: 'C', dir: path.join(workDir, 'segC') },
    ];

    let cumulative = 0;
    const intervals = DURATIONS.map((duration, index) => {
      const item = {
        index,
        start: Number(cumulative.toFixed(6)),
        end: Number((cumulative + duration).toFixed(6)),
        audio_volume: 100,
      };
      cumulative += duration;
      return item;
    });

    // Mốc overlay = tổng dồn SỐ THỰC rồi snap về lưới khung — ĐÚNG cách backend làm.
    const snap = (t) => Math.round(t * FPS) / FPS;
    const overlays = markers.map((marker, i) => {
      const startSeconds = DURATIONS.slice(0, marker.block).reduce((a, b) => a + b, 0);
      const frames = grid[marker.block + 1] - grid[marker.block];
      writeMarkerSequence(marker.dir, marker.color, frames);
      return {
        index: i,
        id: marker.id,
        type: 'media',
        asset_type: 'image_seq',
        asset_path: path.join(marker.dir, 'frame_%04d.jpg'),
        seq_fps: FPS,
        frame_count: frames,
        timeline_start: snap(startSeconds),
        duration: snap(startSeconds + DURATIONS[marker.block]) - snap(startSeconds),
        source_start: 0,
        position_x: 0,
        position_y: 0,
        scale: 100,
        rotation: 0,
        opacity: 100,
      };
    });

    const payloadPath = path.join(workDir, 'payload.json');
    fs.writeFileSync(payloadPath, JSON.stringify({
      version: 5,
      sequence: { width: SEQ_W, height: SEQ_H, preset: 'custom', source_width: SEQ_W, source_height: SEQ_H, source_fps: SRC_FPS },
      intervals,
      overlays,
      settings: {
        resolution: 'sequence', width: SEQ_W, height: SEQ_H,
        fps: String(FPS), render_fps: String(FPS),
        codec: 'h264', quality: 'small', audio_bitrate: '128k',
      },
    }));

    const outputPath = path.join(workDir, 'out.mp4');
    const sidecarTemp = path.join(workDir, 'tmp');
    fs.mkdirSync(sidecarTemp, { recursive: true });   // sidecar ghi filter script vào đây, không tự tạo
    run(sidecar, [
      'export-video', sourcePath, outputPath, payloadPath, sidecarTemp, 'sequence', String(FPS),
    ], 'export-video');
    assert.ok(fs.existsSync(outputPath), 'sidecar không tạo được file xuất');

    // ---- 1. Biên block phải rơi đúng lưới ----
    const marks = centerMarkerPerFrame(outputPath);
    const expectedTotal = grid[grid.length - 1];
    assert.strictEqual(marks.length, expectedTotal,
      `bản xuất ${marks.length} khung, lưới đòi ${expectedTotal} (lệch ${marks.length - expectedTotal})`);
    console.log(`  ok  tổng số khung = ${expectedTotal} (lưới round), không phải ${
      DURATIONS.reduce((n, d) => n + Math.ceil(d * FPS), 0)} (lưới ceil cũ)`);

    // ---- 2. Marker phủ ĐÚNG block của nó ----
    for (const marker of markers) {
      const want = { first: grid[marker.block], last: grid[marker.block + 1] - 1 };
      const got = runOf(marks, marker.ch);
      assert.deepStrictEqual(got, want,
        `${marker.id} phủ f${got.first}..f${got.last}, block ${marker.block} là f${want.first}..f${want.last}`);
      console.log(`  ok  ${marker.id} phủ đúng block ${marker.block}: f${want.first}..f${want.last} (${want.last - want.first + 1} khung)`);
    }

    // Không khung nào của block TRƯỚC bị marker chạm vào — chính là lỗi đã gặp.
    for (const marker of markers) {
      const before = grid[marker.block] - 1;
      assert.notStrictEqual(marks[before], marker.ch,
        `${marker.id} rỉ sang khung cuối (f${before}) của block ${marker.block - 1}`);
    }
    console.log('  ok  không marker nào rỉ sang khung cuối của block liền trước');

    console.log('timeline frame grid ok');
  } finally {
    // CRAB_KEEP_WORKDIR=1 để giữ payload + bản xuất lại mà soi khi test đỏ (sidecar tự
    // xoá filter script của nó, nên payload và file ra là thứ duy nhất còn để đối chiếu).
    if (process.env.CRAB_KEEP_WORKDIR) console.log('  workDir giữ lại:', workDir);
    else fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main();
