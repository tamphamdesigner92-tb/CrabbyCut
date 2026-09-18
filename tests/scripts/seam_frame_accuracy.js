/* =====================================================================
 * ĐIỂM NỐI CẢNH PHẢI SẠCH ĐÚNG ĐẾN TỪNG KHUNG
 *
 * LỖI ĐÃ TRẢ GIÁ (người dùng báo 2026-09-09, dự án `Test_lech fps_ver 2.crab`):
 * "đoạn chuyển cảnh trong video lại xuất hiện lỗi" — file xuất ra có ĐÚNG MỘT khung mang
 * ẢNH của cảnh TRƯỚC nhưng được vẽ bằng HÌNH HỌC của cảnh SAU, tại mỗi điểm nối.
 *
 * NGUYÊN NHÂN. `concatSegmentTable` (backend) dựng mốc block bằng cách CỘNG DỒN thời lượng
 * nguồn, tức giờ 0-BASED. Nhưng concat demuxer + `-c copy` sinh ra file mà LUỒNG HÌNH bắt
 * đầu ở PTS > 0 (đo được 0.021s trên dự án thật) còn luồng tiếng vẫn ở 0. `trim=start=<mốc
 * block>` vì thế nhả ra khung CUỐI của cảnh trước.
 * Cùng mốc lệch đó còn phá cả preview: Chromium CỘNG nó vào timeline của <video> (đo được
 * `duration` = nội dung + 0.021), nên đầu block sau vẫn hiện khung cảnh trước.
 *
 * BẢN SỬA có hai lớp, test này chốt CẢ HAI:
 *   1. HỢP ĐỒNG: file nối phải bắt đầu ở PTS 0 (RestampVideoStartToZero, sidecar).
 *   2. CỬA SỔ CẮT: cộng mốc bắt đầu thật của luồng + lùi nửa khung NGUỒN, để mốc cắt luôn
 *      rơi giữa hai khung (WriteClipVideoFilters).
 *
 * Nguồn dựng bằng MÀU ĐẶC và KHÁC KHỔ NHAU: khác khổ thì bắt buộc đi qua bước chuẩn hoá +
 * khung bao (đúng đường của dự án thật), còn màu đặc thì mỗi khung xuất ra tự khai nó thuộc
 * cảnh nào — không phải đoán bằng mắt.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8139';

const projectRoot = path.resolve(__dirname, '..', '..');
/* THƯ MỤC TẠM RIÊNG CHO TEST — BẮT BUỘC và phải đặt TRƯỚC khi require server: trỏ vào thư
 * mục tạm mặc định là xoá sạch dữ liệu của dự án người dùng đang mở. */
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR
  || path.join(projectRoot, 'test_temp', 'seam_frame_accuracy');
process.env.CRAB_CONCAT_CACHE_DIR = process.env.CRAB_CONCAT_CACHE_DIR
  || path.join(projectRoot, 'test_temp', 'seam_frame_accuracy_concat');
const tempDir = path.resolve(process.env.CRAB_TEMP_DIR);
const concatDir = path.resolve(process.env.CRAB_CONCAT_CACHE_DIR);
const { start } = require('../../backend/server');

function run(command, args) {
  const r = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  assert.strictEqual(r.status, 0, `${command} failed\n${r.stderr || r.stdout}`);
  return r;
}

function probeField(file, entries, stream = 'v:0') {
  return run('ffprobe', ['-v', 'error', '-select_streams', stream,
    '-show_entries', `stream=${entries}`, '-of', 'csv=p=0', file]).stdout.trim();
}

/* Màu ở TÂM khung của từng khung xuất ra. Tâm khung luôn nằm trong vùng ảnh của block đang
 * hiện (cả hai nguồn đều được đặt GIỮA khung bao), nên nó nhận diện được cảnh mà không phụ
 * thuộc vào viền đen hay hệ số vừa-khung. */
function centreColours(file, frames) {
  const r = run('ffmpeg', ['-v', 'error', '-i', file,
    '-vf', `select='lt(n\\,${frames})',crop=2:2:(iw-2)/2:(ih-2)/2,scale=1:1`,
    '-frames:v', String(frames), '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const buf = Buffer.from(r.stdout, 'binary');
  const out = [];
  for (let i = 0; i + 2 < buf.length; i += 3) out.push([buf[i], buf[i + 1], buf[i + 2]]);
  return out;
}
const isRed = (p) => p[0] > 90 && p[0] > p[1] + 40 && p[0] > p[2] + 40;
const isGreen = (p) => p[1] > 60 && p[1] > p[0] + 30 && p[1] > p[2] + 30;

async function main() {
  for (const d of [tempDir, concatDir]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }
  const reportsDir = path.join(projectRoot, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportsBefore = new Set(fs.readdirSync(reportsDir));

  // Hai nguồn KHÁC KHỔ -> buộc đi qua chuẩn hoá + khung bao, đúng đường của dự án thật.
  const srcA = path.join(tempDir, 'src_a.mp4');
  const srcB = path.join(tempDir, 'src_b.mp4');
  run('ffmpeg', ['-y', '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1.2:r=60000/1001',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2',
    '-map', '0:v', '-map', '1:a', '-shortest', '-pix_fmt', 'yuv420p', srcA]);
  run('ffmpeg', ['-y', '-hide_banner', '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=green:s=240x320:d=1.2:r=60000/1001',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1.2',
    '-map', '0:v', '-map', '1:a', '-shortest', '-pix_fmt', 'yuv420p', srcB]);

  const server = start();
  const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
  await new Promise((resolve) => setTimeout(resolve, 300));

  const reports = [];
  try {
    const ingest = await fetch(`${baseUrl}/api/project/reingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_paths: [srcA, srcB], preserve_order: true }),
    });
    const ingestBody = await ingest.json();
    assert.ok(ingest.ok, `reingest lỗi: ${JSON.stringify(ingestBody)}`);
    const segments = ingestBody.segments;
    assert.strictEqual(segments.length, 2, 'phải có đúng 2 đoạn');

    const concatPath = path.join(tempDir, 'temp_input.mp4');

    /* CHỐT 1 — HỢP ĐỒNG "FILE NỐI BẮT ĐẦU Ở PTS 0".
     * Đây là chốt chặn gốc: còn lệch ở đây thì mọi phép tính mốc phía sau (trim khi xuất,
     * currentTime của <video> khi xem trước) đều nói một chuyện khác với bảng đoạn. */
    const startTime = Number(probeField(concatPath, 'start_time'));
    assert.ok(Math.abs(startTime) < 0.0005,
      `luồng hình của file nối phải bắt đầu ở 0, đo được ${startTime}`);
    console.log(`  ok  file nối bắt đầu ở PTS 0 (start_time=${startTime})`);

    /* CHỐT 2 — BẢNG ĐOẠN KHỚP ĐÚNG CHỖ ĐỔI NỘI DUNG THẬT TRONG FILE.
     * Đo bằng chính file: khung cuối cùng còn màu đỏ phải là khung NGAY TRƯỚC mốc mà bảng
     * đoạn khai, không xê dịch khung nào. */
    const boundary = Number(segments[1].start);
    const concatFps = 60000 / 1001;
    const concatColours = centreColours(concatPath, Math.round((boundary + 0.05) * concatFps) + 2);
    let firstGreen = concatColours.findIndex(isGreen);
    assert.ok(firstGreen > 0, 'không thấy khung nào của nguồn thứ hai trong file nối');
    const measuredBoundary = firstGreen / concatFps;
    assert.ok(Math.abs(measuredBoundary - boundary) < (0.75 / concatFps),
      `bảng đoạn khai mốc ${boundary} nhưng nội dung đổi ở ${measuredBoundary}`);
    console.log(`  ok  bảng đoạn khớp chỗ đổi nội dung thật (khai ${boundary.toFixed(6)},`
      + ` đo ${measuredBoundary.toFixed(6)}, lệch < 1 khung)`);

    /* CHỐT 3 — MỖI KHUNG XUẤT RA PHẢI THUỘC ĐÚNG MỘT CẢNH.
     * Chạy ở HAI nhịp khung: 30 (nhịp KHÁC nguồn -> phải resample, đúng ca người dùng gặp)
     * và 59.94 (trùng nguồn). Lỗi cũ cho đúng 1 khung sai ở CẢ HAI. */
    for (const [fpsText, fpsValue] of [['30', 30], ['59.94', 60000 / 1001]]) {
      const blockDur = 0.8;
      const sequence = {
        width: 320, height: 240, preset: 'custom',
        source_width: 320, source_height: 240, source_fps: '60000/1001', fps: fpsText,
      };
      const timeline = [
        { start: 0, end: boundary, text: 'red', script_index: 0, content: segments[0].content },
        { start: boundary, end: boundary + blockDur, text: 'green', script_index: 1, content: segments[1].content },
      ];
      const form = new FormData();
      form.append('timeline_json', JSON.stringify(timeline));
      form.append('export_settings', JSON.stringify({
        resolution: 'sequence', sequence, fps: 'source',
        codec: 'h264', quality: 'small', audio_bitrate: '128k',
      }));
      form.append('sequence_settings', JSON.stringify(sequence));
      form.append('client_started_at_ms', String(Date.now()));
      const resp = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: form });
      if (!resp.ok) throw new Error(await resp.text());
      await resp.arrayBuffer();
      reports.push(resp.headers.get('x-project-report-path'));

      const outPath = path.join(tempDir, 'final_cut.mp4');
      const total = Number(probeField(outPath, 'nb_frames'));
      const colours = centreColours(outPath, total);
      const seam = Math.round(boundary * fpsValue);

      const wrong = [];
      colours.forEach((pixel, index) => {
        const want = index < seam ? 'red' : 'green';
        const ok = want === 'red' ? isRed(pixel) : isGreen(pixel);
        if (!ok) wrong.push({ index, want, pixel });
      });
      assert.strictEqual(wrong.length, 0,
        `${fpsText}fps: ${wrong.length} khung sai cảnh, đầu tiên là khung `
        + `${wrong[0]?.index} (chờ ${wrong[0]?.want}, nhận rgb ${wrong[0]?.pixel})`);
      console.log(`  ok  ${fpsText}fps: ${total} khung, mép ở khung ${seam},`
        + ' không khung nào lẫn cảnh');
      fs.rmSync(outPath, { force: true });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const reportPath of reports) if (reportPath) fs.rmSync(reportPath, { force: true });
    for (const name of fs.readdirSync(reportsDir)) {
      if (!reportsBefore.has(name) && /^report_project_\d{8}_\d{6}\.txt$/.test(name)) {
        fs.rmSync(path.join(reportsDir, name), { force: true });
      }
    }
  }

  console.log('seam frame accuracy ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
