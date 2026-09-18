/* Chế độ `retouch_track` của sidecar trên ẢNH TĨNH.
 *
 * BỐI CẢNH: đường video đọc frame TUẦN TỰ qua `FrameStream` và trả một mảng landmark dài
 * theo thời gian. Ảnh tĩnh không có trục thời gian — nó phải trả ĐÚNG MỘT khung, và
 * frontend kẹp chỉ số khung về 0 (`retouchFacesAt`). Nếu ảnh vô tình đi vào đường video
 * thì `FrameStream` vẫn "mở" được (ffmpeg đọc ảnh ra 1 frame rồi hết) nhưng số khung và
 * cờ `still` sẽ sai, và frontend sẽ chỉ retouch được đúng khung đầu của block.
 *
 * TEST NÀY KHÔNG ĐÒI PHẢI NHẬN RA MẶT — nó canh HÌNH DẠNG kết quả và việc rẽ nhánh:
 *   · ảnh -> `still: true`, đúng 1 khung, `frames` dài đúng 1;
 *   · không thấy mặt -> `frames[0] === null` chứ không phải lỗi hay mảng rỗng (frontend
 *     đọc null là "khung này không retouch", còn mảng rỗng thì lọt qua mọi guard);
 *   · video -> vẫn `still: false` và NHIỀU khung, tức nới cho ảnh không kéo theo video.
 * Nhờ vậy test chạy được cả khi máy chưa cài MediaPipe (thiếu nó thì mọi khung đều là
 * null, các bất biến trên vẫn đúng) — chỉ cần python3 + ffmpeg.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const SIDECAR = path.join(PROJECT_ROOT, 'asr', 'auto_reframe_sidecar.py');

// Cùng interpreter VÀ cùng env UTF-8 với backend — dùng chung một module, không chép lại.
const { pythonCommand, pythonEnv } = require(path.join(PROJECT_ROOT, 'scripts', 'python_command.js'));

function run(command, args, label) {
  const r = spawnSync(command, args, {
    cwd: PROJECT_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: pythonEnv(),
  });
  assert.strictEqual(r.status, 0, `${label} failed\n${r.stderr || r.stdout}`);
  return r;
}

function track(workDir, sourcePath, clip) {
  const payload = path.join(workDir, 'in.json');
  const out = path.join(workDir, 'out.json');
  fs.writeFileSync(payload, JSON.stringify({
    video_path: sourcePath,
    mode: 'retouch_track',
    clips: [clip],
    options: { fps: 30, detect_width: 384, max_faces: 4, smooth_alpha: 0.45 },
  }));
  run(pythonCommand(), [SIDECAR, payload, out], 'retouch_track');
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function main() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crab_retouch_still_'));
  try {
    // Ảnh KHÔNG có mặt: đủ để kiểm hình dạng kết quả, và không cần fixture ảnh người
    // trong repo (ảnh mặt thật là dữ liệu cá nhân, không nên nằm trong mã nguồn).
    const png = path.join(workDir, 'plain.png');
    const jpg = path.join(workDir, 'plain.jpg');
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=640x480',
      '-frames:v', '1', png], 'make png');
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=640x480',
      '-frames:v', '1', '-q:v', '3', jpg], 'make jpg');

    for (const [label, src] of [['PNG', png], ['JPEG', jpg]]) {
      const res = track(workDir, src, { index: 0, start: 0, end: 1 });
      assert.strictEqual(res.status, 'success', `${label}: sidecar không trả success`);
      assert.strictEqual(res.still, true, `${label}: phải nhận ra đây là ảnh tĩnh`);
      const clip = res.clips[0];
      assert.strictEqual(clip.still, true, `${label}: clip phải mang cờ still`);
      assert.strictEqual(clip.frame_count, 1, `${label}: ảnh tĩnh phải ra ĐÚNG 1 khung`);
      assert.strictEqual(clip.frames.length, 1, `${label}: mảng frames phải dài đúng 1`);
      assert.strictEqual(clip.frames[0], null,
        `${label}: ảnh không có mặt phải là null, không phải mảng rỗng`);
      assert.strictEqual(clip.detected_frames, 0, `${label}: không có mặt thì detected = 0`);
      assert.ok(!clip.error, `${label}: không được báo lỗi (${clip.error})`);
      // fps vẫn phải có mặt trong kết quả: frontend dùng chung một hàm đọc cho cả hai
      // đường, nó chỉ rẽ nhánh ở chỗ kẹp chỉ số.
      assert.ok(Number(clip.fps) > 0, `${label}: thiếu fps trong kết quả`);
      console.log(`  ok  ${label}: still=true, đúng 1 khung, không mặt -> frames[0]=null`);
    }

    // VIDEO vẫn đi đường cũ — nới cho ảnh không được kéo video theo.
    const mp4 = path.join(workDir, 'clip.mp4');
    run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=640x480:d=0.5:r=30',
      '-pix_fmt', 'yuv420p', mp4], 'make mp4');
    const vid = track(workDir, mp4, { index: 0, start: 0, end: 0.4 });
    assert.strictEqual(vid.still, false, 'video KHÔNG được nhận nhầm là ảnh tĩnh');
    assert.strictEqual(vid.clips[0].still, undefined, 'clip video không mang cờ still');
    assert.ok(vid.clips[0].frame_count > 1,
      `video phải ra nhiều khung, nhận ${vid.clips[0].frame_count}`);
    console.log(`  ok  video vẫn đi đường cũ: still=false, ${vid.clips[0].frame_count} khung`);

    console.log('retouch still track ok');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main();
