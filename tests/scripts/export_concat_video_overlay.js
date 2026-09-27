/* =============================================================================
 * XUẤT KHÔNG ĐƯỢC TREO: lane chính nhiều clip + VIDEO lớp phủ đổi thông số giữa chừng
 *
 * LỖI ĐÃ XẢY RA (tái hiện 2026-09-27 trên BtbN N-123955, Gyan 8.1.1 và BtbN master
 * 2026-09-26): ffmpeg đứng im vĩnh viễn — 0% CPU, không lỗi, không thoát — và người dùng
 * chỉ thấy thanh tiến độ không chạy nữa.
 *
 * ĐIỀU KIỆN CẦN ĐỦ (đo bằng cách bỏ từng thứ một):
 *   - lane chính `concat` từ 3 clip trở lên (1 clip thì không treo);
 *   - một VIDEO lớp phủ mà luồng hình của CHÍNH NÓ đổi pix_fmt / color_range / colorspace
 *     giữa chừng, và đoạn được dùng vắt qua chỗ đổi đó.
 * File kiểu này rất thường gặp: bản nối `-c copy` nhiều nguồn (concat_cache của chính
 * CrabbyCut, hay clip người dùng ghép bằng công cụ khác) đổi `yuv420p/tv/bt709` sang
 * `yuvj420p/pc/bt470bg` ngay tại chỗ nối.
 *
 * VÌ SAO TREO: input lớp phủ không có `-reinit_filter 0`, nên khi khung đổi thông số,
 * fftools DỰNG LẠI CẢ filtergraph giữa lúc `concat` đang chạy — và bộ lập lịch kẹt ở đó.
 * Lane chính đã có cờ này từ lâu (vì lỗi chớp đen, xem ExportBatch), lớp phủ thì chưa.
 *
 * Test dựng đúng loại file đó bằng lavfi (hai đoạn khác thông số màu, nối `-c copy`), rồi
 * xuất một dự án 3 clip có lớp phủ vắt qua chỗ đổi. Ngoài "không treo", còn đo MÀU ở hai
 * phía chỗ đổi: đoạn sau là full range, đọc nhầm thành limited range thì xám 200 ra ~214.
 *
 * Chạy: node tests/scripts/export_concat_video_overlay.js
 *       (cần ffmpeg trong PATH + sidecar đã build bằng `npm run build:sidecar`)
 * ========================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SIDECAR = path.join(ROOT, 'native', 'sidecar', 'build', 'core_process');
// Bình thường xuất xong trong vài giây. Quá hạn = treo; phải giết CẢ CÂY tiến trình,
// vì giết mỗi sidecar thì ffmpeg con vẫn đứng đó giữ file.
const TIMEOUT_MS = 90 * 1000;

const W = 320;
const H = 240;
const MAIN_RGB = [0x20, 0x40, 0xa0];   // lane chính: xanh dương
const SEG_A_RGB = [0xd0, 0x40, 0x40];  // lớp phủ, đoạn đầu: đỏ, yuv420p limited range
const SEG_B_GRAY = 200;                // lớp phủ, đoạn sau: xám, yuvj420p FULL range

function ffmpeg(args) {
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { cwd: ROOT });
}

const hex = (rgb) => `0x${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function samplePixel(videoPath, seconds) {
    const out = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', videoPath,
        '-frames:v', '1', '-vf', `crop=16:16:${W / 2 - 8}:${H / 2 - 8},scale=1:1`,
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer' });
    assert.strictEqual(out.status, 0, out.stderr?.toString('utf8'));
    return [out.stdout[0], out.stdout[1], out.stdout[2]];
}

function probeDuration(videoPath) {
    const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'csv=p=0', videoPath], { encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    return Number(out.stdout.trim());
}

function killTree(pid) {
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
        try { process.kill(-pid, 'SIGKILL'); } catch (_) { /* đã chết */ }
    }
}

function runSidecar(args, cwd) {
    return new Promise((resolve) => {
        const child = spawn(SIDECAR, args, {
            cwd, windowsHide: true, detached: process.platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, TIMEOUT_MS);
        child.on('exit', (code) => {
            clearTimeout(timer);
            resolve({ code, timedOut, stdout, stderr });
        });
    });
}

async function run() {
    assert.ok(fs.existsSync(SIDECAR) || fs.existsSync(`${SIDECAR}.exe`),
        `chưa build sidecar: ${SIDECAR} (chạy npm run build:sidecar)`);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concat-vov-'));
    try {
        // Lane chính: 12 s xanh dương có tiếng, một file liền (thông số không đổi).
        const mainVideo = path.join(workDir, 'main.mp4');
        ffmpeg(['-f', 'lavfi', '-i', `color=c=${hex(MAIN_RGB)}:s=${W}x${H}:d=12:r=25`,
            '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=12', '-shortest',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_range', 'tv',
            '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
            '-c:a', 'aac', mainVideo]);

        // Lớp phủ: hai đoạn 3 s khác thông số màu, nối `-c copy` — y như concat_cache.
        const segA = path.join(workDir, 'segA.mp4');
        const segB = path.join(workDir, 'segB.mp4');
        ffmpeg(['-f', 'lavfi', '-i', `color=c=${hex(SEG_A_RGB)}:s=${W}x${H}:d=3:r=25`,
            '-f', 'lavfi', '-i', 'sine=f=660:r=48000:d=3', '-shortest',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_range', 'tv',
            '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
            '-c:a', 'aac', segA]);
        const gray = SEG_B_GRAY.toString(16).padStart(2, '0');
        ffmpeg(['-f', 'lavfi', '-i', `color=c=0x${gray}${gray}${gray}:s=${W}x${H}:d=3:r=25`,
            '-f', 'lavfi', '-i', 'sine=f=990:r=48000:d=3', '-shortest',
            '-vf', 'scale=out_range=pc:out_color_matrix=bt601',
            '-c:v', 'libx264', '-pix_fmt', 'yuvj420p', '-color_range', 'pc',
            '-colorspace', 'bt470bg', '-c:a', 'aac', segB]);
        const list = path.join(workDir, 'ovl_list.txt');
        fs.writeFileSync(list, `file '${segA.replace(/\\/g, '/')}'\nfile '${segB.replace(/\\/g, '/')}'\n`);
        const ovlVideo = path.join(workDir, 'ovl_switch.mp4');
        ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ovlVideo]);

        // Chốt chính fixture: phải THẬT SỰ đổi thông số ở giây 3, không thì test vô nghĩa.
        const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'frame=pix_fmt,color_range', '-of', 'csv=p=0', ovlVideo], { encoding: 'utf8' });
        const kinds = new Set(probe.stdout.split(/\r?\n/).filter(Boolean).map((l) => l.trim()));
        assert.ok(kinds.size >= 2, `fixture lớp phủ phải đổi thông số giữa chừng, đo được: ${[...kinds].join(' | ')}`);

        /* Dự án: 3 clip × 2 s (sequence 6 s, hai điểm nối ở 2 s và 4 s). Lớp phủ phủ kín
         * khung từ 1 s tới 5 s, lấy nguồn 1..5 s — tức vắt qua CẢ hai điểm nối lẫn chỗ đổi
         * thông số (nguồn 3 s = timeline 3 s). Có tiếng để đi qua cả nhánh amix. */
        const payload = {
            version: 5,
            sequence: { width: W, height: H, preset: 'custom', source_width: W, source_height: H, source_fps: '25' },
            intervals: [
                { index: 0, start: 0.0, end: 2.0, audio_volume: 100 },
                { index: 1, start: 4.0, end: 6.0, audio_volume: 100 },
                { index: 2, start: 8.0, end: 10.0, audio_volume: 100 },
            ],
            overlays: [{
                index: 0, id: 'ov_switch', type: 'media', asset_type: 'media_video',
                asset_path: ovlVideo, timeline_start: 1.0, duration: 4.0, source_start: 1.0,
                muted: false, has_audio: true, volume: 100,
                position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100,
            }],
            settings: {
                resolution: 'sequence', width: W, height: H, fps: '25', render_fps: '25',
                codec: 'h264', quality: 'high', audio_bitrate: '128k',
            },
        };
        const payloadPath = path.join(workDir, 'timeline.json');
        fs.writeFileSync(payloadPath, JSON.stringify(payload));
        const outPath = path.join(workDir, 'out.mp4');
        const tmpDir = path.join(workDir, 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true });

        const started = Date.now();
        const result = await runSidecar(['export-video', mainVideo, outPath, payloadPath, tmpDir, 'sequence', '25'], ROOT);
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        assert.ok(!result.timedOut,
            `ffmpeg TREO: quá ${TIMEOUT_MS / 1000} s không xong (3 clip + video lớp phủ đổi thông số giữa chừng).\n${result.stdout.slice(-2000)}`);
        assert.strictEqual(result.code, 0, `sidecar lỗi:\n${result.stdout}\n${result.stderr}`);
        console.log(`  3 clip + video lớp phủ đổi thông số giữa chừng: xong sau ${seconds} s`);

        const duration = probeDuration(outPath);
        assert.ok(Math.abs(duration - 6.0) < 0.15, `bản xuất phải dài ~6 s, đo được ${duration}`);

        const before = samplePixel(outPath, 0.5);
        const segAOut = samplePixel(outPath, 2.5);
        const segBOut = samplePixel(outPath, 4.5);
        const after = samplePixel(outPath, 5.5);
        console.log(`  màu: trước lớp phủ ${before} · đoạn A ${segAOut} · đoạn B ${segBOut} · sau lớp phủ ${after}`);
        assert.ok(Math.abs(lum(before) - lum(MAIN_RGB)) < 12, 'trước lớp phủ phải là lane chính');
        assert.ok(Math.abs(lum(after) - lum(MAIN_RGB)) < 12, 'sau lớp phủ phải là lane chính');
        assert.ok(Math.abs(lum(segAOut) - lum(SEG_A_RGB)) < 12,
            `đoạn A (limited range) sai màu: ${lum(segAOut).toFixed(0)} vs ${lum(SEG_A_RGB).toFixed(0)}`);
        // Full range đọc nhầm thành limited: 200 -> (200-16)*255/219 ≈ 214. Đúng thì ~200.
        assert.ok(Math.abs(lum(segBOut) - SEG_B_GRAY) < 8,
            `đoạn B (full range, sau chỗ đổi) sai màu: ${lum(segBOut).toFixed(0)} vs ${SEG_B_GRAY}`);
        console.log('export concat + video overlay ok');
    } finally {
        // Sau một lượt treo bị giết, Windows nhả handle file chậm vài trăm ms: thử lại, và
        // không để lỗi dọn dẹp che mất lỗi thật của test.
        try {
            fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch (error) {
            console.warn(`  (không dọn được ${workDir}: ${error.message})`);
        }
    }
}

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
