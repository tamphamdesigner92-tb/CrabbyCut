/**
 * Test ĐƯỜNG TRUYỀN CHUỖI KHUNG VÙNG CHUYỂN CẢNH khi export.
 *
 * Vì sao cần: khung chuyển cảnh full-res là dữ liệu nặng nhất của payload export (1 khung
 * 1080×1920 nén PNG ~9.5MB). Khi Magic Fill điền chuyển cảnh cho CẢ sequence, nhét chuỗi
 * khung vào editing_json làm JSON.stringify vượt trần chuỗi của V8 -> export chết. Bản sửa
 * gửi từng khung thành MỘT PHẦN FILE của multipart (`transition_frames`) và trong payload
 * chỉ để danh sách TÊN (`seq.frame_files`). Test này khoá hành vi đó:
 *   1) backend nhận được các phần file, đổi tên đúng thứ tự frame_%04d.<ext> và render ra
 *      video có ĐÚNG màu của khung đã gửi (tức chuỗi được ffmpeg dùng thật, không bị bỏ);
 *   2) chuỗi JPEG (khung đục của lane chính) chạy được — trước đây backend chỉ nhận PNG;
 *   3) đường base64 nội tuyến cũ vẫn hoạt động (không phá caller khác).
 *
 * Chạy: npm run test:transition-frames
 * KHÔNG dùng temp_uploads thật (đang giữ dự án của người dùng) — trỏ CRAB_TEMP_DIR sang
 * thư mục riêng của test.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-transition-'));
process.env.CRAB_TEMP_DIR = tempDir;
process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8127';

const { start } = require('../../backend/server');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  assert.strictEqual(result.status, 0, `${command} failed\n${result.stderr || result.stdout}`);
  return result;
}

// Màu trung bình của khung tại giây `seconds` (rgb24, hạ về 1 pixel)
function sampleRgb(filePath, seconds) {
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-ss', String(seconds), '-i', filePath,
    '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { cwd: projectRoot, encoding: 'buffer', maxBuffer: 1024 * 1024 });
  assert.strictEqual(result.status, 0, result.stderr?.toString('utf8'));
  return [...result.stdout.slice(0, 3)];
}

// Sinh 1 khung đơn sắc, trả Buffer đúng định dạng yêu cầu
function solidFrame(color, ext) {
  const file = path.join(tempDir, `gen_${color}.${ext}`);
  run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:d=1`, '-frames:v', '1', file]);
  const buf = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return buf;
}

async function main() {
  const sourcePath = path.join(tempDir, 'temp_input.mp4');
  run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=4:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-map', '0:v', '-map', '1:a', '-shortest', '-pix_fmt', 'yuv420p', sourcePath,
  ]);

  const server = start();
  const baseUrl = `http://127.0.0.1:${Number(process.env.BACKEND_PORT)}`;
  await new Promise((resolve) => setTimeout(resolve, 400));

  try {
    // ---------- (1)+(2) chuỗi JPEG gửi qua phần file multipart ----------
    // Overlay phủ kín khung, XANH LÁ đặc, từ giây 1 đến 2 -> khung xuất ra phải xanh lá.
    const FPS = 24;
    const frameCount = 13;                        // 0.5s @24fps + 1
    const seqId = 'maintrans_0';
    const greenJpeg = solidFrame('green', 'jpg');
    const jpegFrames = [];
    for (let i = 0; i < frameCount; i += 1) {
      jpegFrames.push({ name: `${seqId}__${String(i).padStart(4, '0')}.jpg`, buf: greenJpeg });
    }
    const editingJson = {
      version: 5,
      tracks: [{ id: 'track_main', type: 'main', order: 0, visible: true, volume: 100 }],
      items: [{
        id: seqId,
        type: 'text',
        track_id: 'track_main',
        timeline_start: 1,
        duration: frameCount / FPS,
        source_start: 0,
        transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 },
        // PNG 1×1 trong suốt: backend cần rendered_text_png để cho item qua guard asset,
        // animation_render mới ghi đè thành image_seq (đúng cơ chế bake đang dùng thật).
        rendered_text_png: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        rendered_text_width: 1,
        rendered_text_height: 1,
        animation_render: {
          fps: FPS,
          seq: {
            start: 0, duration: frameCount / FPS, width: 320, height: 180,
            frame_count: frameCount,
            frame_files: jpegFrames.map((f) => f.name),
          },
        },
      }],
      assets: [],
    };

    const form = new FormData();
    form.append('timeline_json', JSON.stringify([{ start: 0, end: 4, text: 'red', script_index: 0 }]));
    const settings = {
      resolution: 'sequence',
      sequence: { width: 320, height: 180, preset: 'custom', source_width: 160, source_height: 90, source_fps: String(FPS) },
      fps: String(FPS), codec: 'h264', quality: 'small', audio_bitrate: '128k',
    };
    form.append('export_settings', JSON.stringify(settings));
    form.append('sequence_settings', JSON.stringify(settings.sequence));
    form.append('export_preset', 'custom');
    form.append('export_fps', String(FPS));
    form.append('editing_json', JSON.stringify(editingJson));
    for (const f of jpegFrames) {
      form.append('transition_frames', new Blob([f.buf], { type: 'image/jpeg' }), f.name);
    }

    const response = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: form });
    // Chỉ đọc body khi LỖI — đọc trong message của assert thành công sẽ ngốn luôn body.
    if (response.status !== 200) assert.fail(`export thất bại: HTTP ${response.status} ${await response.text()}`);
    const outPath = path.join(tempDir, 'out_filepart.mp4');
    fs.writeFileSync(outPath, Buffer.from(await response.arrayBuffer()));

    const inside = sampleRgb(outPath, 1.25);   // giữa vùng overlay
    const before = sampleRgb(outPath, 0.3);    // trước overlay
    assert.ok(inside[1] > 100 && inside[0] < 90 && inside[2] < 90,
      `chuỗi khung JPEG gửi qua phần file KHÔNG được dùng (màu tại 1.25s = ${inside})`);
    assert.ok(before[0] > 100 && before[1] < 90,
      `ngoài vùng overlay phải là video nguồn màu đỏ (màu tại 0.3s = ${before})`);

    // Khung đã materialize phải nằm đúng thư mục chuỗi, và thư mục upload được dọn sạch.
    const seqDir = path.join(tempDir, 'editing_assets', 'generated_text', `animf_${seqId}_0`);
    assert.ok(fs.existsSync(path.join(seqDir, 'frame_0000.jpg')), 'thiếu frame_0000.jpg đã đổi tên');
    assert.ok(fs.existsSync(path.join(seqDir, `frame_${String(frameCount - 1).padStart(4, '0')}.jpg`)),
      'thiếu khung cuối của chuỗi');
    const uploadDir = path.join(tempDir, 'transition_frames_upload');
    const leftover = fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir) : [];
    assert.deepStrictEqual(leftover, [], `còn khung upload chưa dọn: ${leftover.join(', ')}`);

    // ---------- (3) đường base64 nội tuyến CŨ vẫn phải chạy ----------
    const pngB64 = solidFrame('blue', 'png').toString('base64');
    const inlineJson = JSON.parse(JSON.stringify(editingJson));
    inlineJson.items[0].id = 'maintrans_inline';
    inlineJson.items[0].animation_render.seq = {
      start: 0, duration: frameCount / FPS, width: 320, height: 180,
      frame_count: frameCount,
      frames: new Array(frameCount).fill(`data:image/png;base64,${pngB64}`),
    };
    const form2 = new FormData();
    form2.append('timeline_json', JSON.stringify([{ start: 0, end: 4, text: 'red', script_index: 0 }]));
    form2.append('export_settings', JSON.stringify(settings));
    form2.append('sequence_settings', JSON.stringify(settings.sequence));
    form2.append('export_preset', 'custom');
    form2.append('export_fps', String(FPS));
    form2.append('editing_json', JSON.stringify(inlineJson));

    const response2 = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: form2 });
    assert.strictEqual(response2.status, 200, `export nội tuyến thất bại: HTTP ${response2.status}`);
    const outPath2 = path.join(tempDir, 'out_inline.mp4');
    fs.writeFileSync(outPath2, Buffer.from(await response2.arrayBuffer()));
    const inside2 = sampleRgb(outPath2, 1.25);
    assert.ok(inside2[2] > 100 && inside2[0] < 90 && inside2[1] < 90,
      `chuỗi khung base64 nội tuyến KHÔNG được dùng (màu tại 1.25s = ${inside2})`);

    // ---------- (4) QUY MÔ THẬT: 13 chuyển cảnh trên timeline 44s ----------
    // Đúng hình dạng dự án đã làm chết export (Shop Yeu Con 1_Tap 1.crab). Cốt để chắc MỘT
    // lượt xuất sạch ở quy mô này ra file ĐỦ DÀI và ĐỌC ĐƯỢC — triệu chứng "video không
    // chuẩn" của người dùng là do 3 lượt xuất chạy song song ghi đè nhau, không phải do
    // bản thân quy mô.
    const scaleSrc = path.join(tempDir, 'temp_input.mp4');
    run('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=45:r=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=45',
      '-map', '0:v', '-map', '1:a', '-shortest', '-pix_fmt', 'yuv420p', scaleSrc,
    ]);
    const CUTS = 14;                   // 14 clip -> 13 điểm giao, đúng như dự án thật
    const CLIP_DUR = 45 / CUTS;
    const scaleTimeline = [];
    for (let i = 0; i < CUTS; i += 1) {
      scaleTimeline.push({ start: i * CLIP_DUR, end: (i + 1) * CLIP_DUR, text: `c${i}`, script_index: i });
    }
    const scaleItems = [];
    const scaleParts = [];
    let cursor = 0;
    for (let i = 0; i < CUTS - 1; i += 1) {
      cursor += CLIP_DUR;
      const id = `maintrans_${i}`;
      const names = [];
      for (let k = 0; k < frameCount; k += 1) names.push(`${id}__${String(k).padStart(4, '0')}.jpg`);
      names.forEach((n) => scaleParts.push({ name: n, buf: greenJpeg }));
      scaleItems.push({
        id,
        type: 'text',
        track_id: 'track_main',
        timeline_start: Math.max(0, cursor - (frameCount / FPS) / 2),
        duration: frameCount / FPS,
        source_start: 0,
        transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 },
        rendered_text_png: editingJson.items[0].rendered_text_png,
        rendered_text_width: 1,
        rendered_text_height: 1,
        animation_render: {
          fps: FPS,
          seq: {
            start: 0, duration: frameCount / FPS, width: 320, height: 180,
            frame_count: frameCount, frame_files: names,
          },
        },
      });
    }
    const form3 = new FormData();
    form3.append('timeline_json', JSON.stringify(scaleTimeline));
    form3.append('export_settings', JSON.stringify(settings));
    form3.append('sequence_settings', JSON.stringify(settings.sequence));
    form3.append('export_preset', 'custom');
    form3.append('export_fps', String(FPS));
    form3.append('editing_json', JSON.stringify({
      version: 5,
      tracks: editingJson.tracks,
      items: scaleItems,
      assets: [],
    }));
    for (const f of scaleParts) {
      form3.append('transition_frames', new Blob([f.buf], { type: 'image/jpeg' }), f.name);
    }
    assert.strictEqual(scaleParts.length, (CUTS - 1) * frameCount, 'số khung gửi đi phải khớp 13 × frameCount');

    // (5) Trong lúc lượt này đang chạy, lượt THỨ HAI phải bị TỪ CHỐI (409) — nếu không, hai
    // tiến trình cùng ghi final_cut.mp4 và ra file MP4 lỗi.
    const scalePromise = fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: form3 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const form4 = new FormData();
    form4.append('timeline_json', JSON.stringify(scaleTimeline));
    form4.append('export_settings', JSON.stringify(settings));
    form4.append('sequence_settings', JSON.stringify(settings.sequence));
    form4.append('editing_json', JSON.stringify({ version: 5, tracks: editingJson.tracks, items: [], assets: [] }));
    const concurrent = await fetch(`${baseUrl}/api/export-video`, { method: 'POST', body: form4 });
    assert.strictEqual(concurrent.status, 409,
      `lượt xuất chạy chồng phải bị từ chối 409, đang trả ${concurrent.status}`);
    await concurrent.text();

    const scaleResponse = await scalePromise;
    if (scaleResponse.status !== 200) assert.fail(`export quy mô thật thất bại: HTTP ${scaleResponse.status} ${await scaleResponse.text()}`);
    const scaleOut = path.join(tempDir, 'out_scale.mp4');
    fs.writeFileSync(scaleOut, Buffer.from(await scaleResponse.arrayBuffer()));

    // File phải ĐỦ DÀI (không phải 2s như file lỗi của người dùng) và giải mã sạch từ đầu tới cuối.
    const probe = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', scaleOut]);
    const outDur = Number(String(probe.stdout).trim());
    assert.ok(outDur > 44 && outDur < 46, `thời lượng video ra phải ~45s, đang là ${outDur}s`);
    const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', scaleOut, '-f', 'null', '-'], { encoding: 'utf8' });
    assert.strictEqual(decode.status, 0, `video ra giải mã lỗi:\n${decode.stderr}`);
    assert.strictEqual(String(decode.stderr).trim(), '', `video ra có cảnh báo giải mã:\n${decode.stderr}`);
    // 13 chuỗi khung đều phải được materialize
    for (let i = 0; i < CUTS - 1; i += 1) {
      const dir = path.join(tempDir, 'editing_assets', 'generated_text', `animf_maintrans_${i}_${i}`);
      assert.ok(fs.existsSync(path.join(dir, 'frame_0000.jpg')), `thiếu chuỗi khung của maintrans_${i}`);
    }

    console.log(`[transition-frames] OK — phần file multipart (JPEG) + base64 nội tuyến render đúng; `
      + `quy mô 13 chuyển cảnh ra video ${outDur.toFixed(2)}s giải mã sạch; lượt xuất chạy chồng bị chặn 409.`);
  } finally {
    server.close?.();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  fs.rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
});
