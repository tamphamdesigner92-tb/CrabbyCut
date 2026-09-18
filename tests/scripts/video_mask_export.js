/* =============================================================================
 * MẶT NẠ CẮT HÌNH (tab Video) — ĐỐI CHIẾU PREVIEW ↔ BẢN XUẤT
 *
 * Chốt điều DUY NHẤT đáng chốt của tính năng này: hình mà sidecar cắt ra phải TRÙNG
 * với hình mà preview cắt. Cả hai đọc cùng một `maskValueAt`, nhưng đi hai đường rất
 * khác nhau (preview: canvas/CSS/Pixi; xuất: ảnh PNG xám + chuỗi filter ffmpeg), nên
 * chỉ đo bằng CHÍNH bản xuất mới biết chúng có khớp không.
 *
 * Phép đo: mặt nạ "Tách" xoay -90° = ranh giới DỌC, giữ nửa trái. Clip lane chính được
 * phủ lên nền ĐEN, nên nửa bị cắt phải ra đen còn nửa giữ lại phải nguyên màu nguồn.
 * Đo màu tại một điểm mỗi nửa là đủ và không phụ thuộc codec.
 *
 * Chạy: node tests/scripts/video_mask_export.js   (cần ffmpeg trong PATH + sidecar đã build)
 * ========================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SIDECAR = path.join(ROOT, 'native', 'sidecar', 'build', 'core_process');
const ColorAdjust = require(path.join(ROOT, 'static', 'js', 'color-adjust.js'));

function maskPngFromEngine(mask, W, H, workDir, name) {
    // Test chạy trong Node (không có canvas) -> bake ra dữ liệu xám thô rồi để ffmpeg
    // đóng gói thành PNG. Dữ liệu xám vẫn do CHÍNH engine sinh, nên vẫn là phép đo
    // của công thức thật.
    const baked = ColorAdjust.renderMaskGray(mask, W, H);
    const rawPath = path.join(workDir, `${name}.gray`);
    fs.writeFileSync(rawPath, Buffer.from(baked.gray));
    const pngPath = path.join(workDir, `${name}.png`);
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-i', rawPath,
        '-frames:v', '1', pngPath]);
    return { pngPath, baked };
}

function samplePixel(videoPath, x, y) {
    const out = spawnSync('ffmpeg', ['-v', 'error', '-ss', '0.6', '-i', videoPath,
        '-frames:v', '1', '-vf', `crop=8:8:${x}:${y},scale=1:1`,
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
    assert.strictEqual(out.status, 0, out.stderr?.toString('utf8'));
    return [out.stdout[0], out.stdout[1], out.stdout[2]];
}

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function run() {
    assert.ok(fs.existsSync(SIDECAR), `chưa build sidecar: ${SIDECAR} (chạy npm run build:sidecar)`);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmask-'));
    const W = 320;
    const H = 240;
    const SRC = [0x50, 0x90, 0xd0];   // màu nguồn, sáng rõ để phân biệt với nền đen

    // ---- Ca 1: CLIP LANE CHÍNH ----
    // "Tách" xoay -90°: nửa TRÁI giữ lại, nửa PHẢI bị cắt (đúng quy ước của maskValueAt)
    const mask = ColorAdjust.normalizeMask({
        enabled: true, type: 'split', rotation: -90, feather: 0,
    });
    const { pngPath, baked } = maskPngFromEngine(mask, W, H, workDir, 'vmask');
    // Chốt CHÍNH ảnh mặt nạ trước — nếu nó không chia hai nửa thì phép đo sau vô nghĩa
    assert.notStrictEqual(baked.gray[120 * W + 40], baked.gray[120 * W + 280],
        'ảnh mặt nạ phải chia hai nửa khác nhau');
    const keepLeft = baked.gray[120 * W + 40] > baked.gray[120 * W + 280];

    const srcVideo = path.join(workDir, 'src.mp4');
    const hex = `0x${SRC.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=${hex}:s=${W}x${H}:d=2:r=25`,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo:d=2', '-shortest',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
        srcVideo]);

    const payload = {
        resolution: 'source', width: W, height: H,
        fps: '25', render_fps: '25', codec: 'h264', quality: 'high', audio_bitrate: '192k',
        intervals: [{
            index: 0, start: 0.2, end: 1.8, position_x: 0, position_y: 0,
            scale: 100, rotation: 0, opacity: 100, audio_volume: 100,
            video_mask_path: pngPath,
        }],
    };
    const payloadPath = path.join(workDir, 'timeline.json');
    fs.writeFileSync(payloadPath, JSON.stringify(payload));
    const outPath = path.join(workDir, 'out.mp4');
    const result = spawnSync(SIDECAR, ['export-video', srcVideo, outPath, payloadPath, workDir, 'high', '25'],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.strictEqual(result.status, 0,
        `sidecar lỗi khi có mặt nạ cắt hình:\n${result.stdout}\n${result.stderr}`);

    const kept = samplePixel(outPath, keepLeft ? 40 : 272, 120);
    const cut = samplePixel(outPath, keepLeft ? 272 : 40, 120);
    console.log(`  mặt nạ cắt hình (lane chính)  nguồn ${SRC} -> giữ lại ${kept} · bị cắt ${cut}`);

    // Vùng GIỮ LẠI phải gần nguyên màu nguồn (chỉ lệch do yuv420 + nén)
    assert.ok(Math.abs(lum(kept) - lum(SRC)) < 14,
        `vùng giữ lại phải nguyên màu nguồn: đo ${lum(kept).toFixed(0)} vs nguồn ${lum(SRC).toFixed(0)}`);
    // Vùng BỊ CẮT phải ra nền đen — đây chính là chỗ chứng minh alpha đã bị nhân
    assert.ok(lum(cut) < 18,
        `vùng bị cắt phải trong suốt (lộ nền đen), đo được ${lum(cut).toFixed(0)}`);
    assert.ok(lum(kept) - lum(cut) > 60,
        `hai vùng phải khác hẳn: giữ=${lum(kept).toFixed(0)} cắt=${lum(cut).toFixed(0)}`);

    // ---- Ca 2: RANH GIỚI ĐÚNG CHỖ ----
    // Mặt nạ hình chữ nhật hẹp ở GIỮA: hai mép ngoài phải bị cắt, giữa phải giữ.
    // Bắt được ca "mặt nạ bị lật/lệch trục" mà ca 1 (nửa mặt phẳng) không thấy.
    const rect = ColorAdjust.normalizeMask({
        enabled: true, type: 'rect', width: 0.25, height: 2, feather: 0,
    });
    const r2 = maskPngFromEngine(rect, W, H, workDir, 'vmask2');
    const payload2 = { ...payload, intervals: [{ ...payload.intervals[0], video_mask_path: r2.pngPath }] };
    const payloadPath2 = path.join(workDir, 'timeline2.json');
    fs.writeFileSync(payloadPath2, JSON.stringify(payload2));
    const outPath2 = path.join(workDir, 'out2.mp4');
    const res2 = spawnSync(SIDECAR, ['export-video', srcVideo, outPath2, payloadPath2, workDir, 'high', '25'],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.strictEqual(res2.status, 0, `sidecar lỗi (rect):\n${res2.stdout}\n${res2.stderr}`);

    const mid = samplePixel(outPath2, 156, 116);
    const edgeL = samplePixel(outPath2, 8, 116);
    const edgeR = samplePixel(outPath2, 304, 116);
    console.log(`  mặt nạ cắt hình (chữ nhật)    giữa ${mid} · mép trái ${edgeL} · mép phải ${edgeR}`);
    assert.ok(Math.abs(lum(mid) - lum(SRC)) < 14, 'giữa chữ nhật phải giữ màu nguồn');
    assert.ok(lum(edgeL) < 18 && lum(edgeR) < 18, 'hai mép ngoài chữ nhật phải bị cắt');

    // ---- Ca 3: KHÔNG CÓ MẶT NẠ = KHÔNG ĐỔI GÌ ----
    // Chốt rằng nhánh mới là no-op tuyệt đối với mọi dự án không dùng mặt nạ.
    const payload3 = { ...payload, intervals: [{ ...payload.intervals[0], video_mask_path: undefined }] };
    delete payload3.intervals[0].video_mask_path;
    const payloadPath3 = path.join(workDir, 'timeline3.json');
    fs.writeFileSync(payloadPath3, JSON.stringify(payload3));
    const outPath3 = path.join(workDir, 'out3.mp4');
    const res3 = spawnSync(SIDECAR, ['export-video', srcVideo, outPath3, payloadPath3, workDir, 'high', '25'],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.strictEqual(res3.status, 0, `sidecar lỗi (không mặt nạ):\n${res3.stdout}\n${res3.stderr}`);
    const noMaskL = samplePixel(outPath3, 40, 120);
    const noMaskR = samplePixel(outPath3, 272, 120);
    console.log(`  không mặt nạ                  trái ${noMaskL} · phải ${noMaskR}`);
    assert.ok(Math.abs(lum(noMaskL) - lum(noMaskR)) < 8, 'không có mặt nạ thì hai nửa phải như nhau');
    assert.ok(Math.abs(lum(noMaskL) - lum(SRC)) < 14, 'không có mặt nạ thì giữ nguyên màu nguồn');

    // ---- Ca 4: MEDIA OVERLAY ----
    // Nhánh overlay đi đường filter KHÁC lane chính (có feather alpha, keyframe, đặt lớp),
    // và là chỗ khó nhất: nguồn overlay CÓ THỂ đã mang alpha riêng. Đo bằng overlay phủ
    // KÍN khung trên nền lane chính màu khác — vùng bị cắt phải lộ màu của lane chính,
    // tức mặt nạ nhân vào alpha chứ không ghi đè.
    const OVL = [0xe0, 0x40, 0x40];   // overlay đỏ
    const ovlVideo = path.join(workDir, 'ovl.mp4');
    const ovlHex = `0x${OVL.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `color=c=${ovlHex}:s=${W}x${H}:d=2:r=25`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ovlVideo]);

    const ovlPayload = {
        version: 5,
        sequence: { width: W, height: H, preset: 'custom', source_width: W, source_height: H, source_fps: '25' },
        intervals: [{ index: 0, start: 0.2, end: 1.8, audio_volume: 100 }],
        overlays: [{
            index: 0, id: 'ov_mask', type: 'media', asset_type: 'media_video',
            asset_path: ovlVideo, timeline_start: 0, duration: 1.5, source_start: 0,
            muted: true, has_audio: false,
            position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100,
            video_mask_path: pngPath,     // "Tách" -90°, giữ một nửa
        }],
        settings: {
            resolution: 'sequence', width: W, height: H, fps: '25', render_fps: '25',
            codec: 'h264', quality: 'high', audio_bitrate: '128k',
        },
    };
    const ovlPath = path.join(workDir, 'ovl_timeline.json');
    fs.writeFileSync(ovlPath, JSON.stringify(ovlPayload));
    const ovlOut = path.join(workDir, 'ovl_out.mp4');
    const tmpDir = path.join(workDir, 'tmp_ovl');
    fs.mkdirSync(tmpDir, { recursive: true });
    const res4 = spawnSync(SIDECAR, ['export-video', srcVideo, ovlOut, ovlPath, tmpDir, 'sequence', '25'],
        { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    assert.strictEqual(res4.status, 0, `sidecar lỗi (overlay có mặt nạ):\n${res4.stdout}\n${res4.stderr}`);

    const ovlKept = samplePixel(ovlOut, keepLeft ? 40 : 272, 120);
    const ovlCut = samplePixel(ovlOut, keepLeft ? 272 : 40, 120);
    console.log(`  mặt nạ cắt hình (overlay)     overlay ${OVL} / dưới ${SRC} -> giữ ${ovlKept} · cắt ${ovlCut}`);
    // Nửa giữ lại = màu OVERLAY; nửa bị cắt = màu LANE CHÍNH bên dưới (không phải đen,
    // không phải đỏ) — đó mới chứng minh alpha bị NHÂN chứ không bị GHI ĐÈ.
    assert.ok(Math.abs(lum(ovlKept) - lum(OVL)) < 16,
        `nửa giữ lại phải là màu overlay: đo ${lum(ovlKept).toFixed(0)} vs ${lum(OVL).toFixed(0)}`);
    assert.ok(Math.abs(lum(ovlCut) - lum(SRC)) < 16,
        `nửa bị cắt phải lộ lane chính bên dưới: đo ${lum(ovlCut).toFixed(0)} vs ${lum(SRC).toFixed(0)}`);

    fs.rmSync(workDir, { recursive: true, force: true });
    console.log('video mask export ok');
}

run();
