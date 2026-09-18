/* =====================================================================
 * PROXY PREVIEW — BỀ RỘNG PHẢI CHIA HẾT CHO 16
 *
 * VÌ SAO: `scale=-2` chỉ đảm bảo số CHẴN. Nguồn dọc 1728×3072 ra proxy rộng 406px — chẵn
 * nhưng không chia hết cho 4/8/16. Bộ giải mã phần cứng làm việc theo macroblock 16×16;
 * bề rộng không căn hàng buộc thêm bước bù, và ở một số driver là rơi hẳn về giải mã
 * phần mềm.
 *
 * SỐ LIỆU DẪN TỚI ĐÂY (máy người dùng, 2026-09-06, 10 lượt đo):
 *   proxy 406×720  (0,29 MP) -> rớt 10-30% khung, rAF 19-30 fps
 *   gốc  1728×3072 (5,31 MP) -> rớt 0-6%,        rAF 60 fps chằn chặn
 * Bản nhỏ hơn 18 lần lại tệ hơn hẳn. Độ phân giải không giải thích được; căn hàng thì có
 * thể — và 1728/3072 đều chia hết cho 16.
 *
 * ⚠️ ĐÂY LÀ BẢN SỬA THEO THÔNG LỆ, CHƯA PHẢI THEO SỐ ĐO. Vấn đề chỉ lộ ra ở tầng hợp
 * thành của cửa sổ THẬT; môi trường đo tự động (pane ẩn) không dựng tầng đó nên 4 biến thể
 * proxy đều giải mã như nhau ở đó. Nếu đo lại trên máy thật mà không cải thiện, hãy revert
 * — đừng để nó nằm lại như một "bản sửa" không ai kiểm chứng.
 *
 * ⚠️ MỘT GIẢ THUYẾT ĐÃ BỊ BÁC BỎ, ghi lại để không ai đi lại: từng nghi proxy dài hơn
 * nguồn 11ms làm lệch mốc chunk. SAI — 11ms đó nằm ở luồng AUDIO (đệm của bộ mã hoá AAC);
 * luồng VIDEO giống hệt nguồn (cùng số khung, cùng duration, cùng start_time). Test dưới
 * đây khoá luôn điều đó.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..', '..');
const cppPath = path.join(projectRoot, 'native', 'sidecar', 'core_process.cpp');
const cpp = fs.readFileSync(cppPath, 'utf8');

function extractFunction(src, name) {
    const start = src.indexOf(`${name}(`);
    assert.notStrictEqual(start, -1, `không tìm thấy ${name}()`);
    const bodyStart = src.indexOf('{', start);
    let depth = 0;
    for (let i = bodyStart; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`không đóng được ${name}()`);
}

// ---------------------------------------------------------------------------
// 1. Nguồn C++: nhánh CPU căn 16, nhánh macOS CỐ Ý giữ -2
// ---------------------------------------------------------------------------
{
    const fn = extractFunction(cpp, 'std::vector<std::string> BuildPreviewProxyCommand');

    const cpuLine = fn.split('\n').find((l) => l.includes('scale=w=if(gt(ih'));
    assert.ok(cpuLine, 'không tìm thấy bộ lọc scale của nhánh CPU');
    assert.ok(cpuLine.includes('-16'),
        'nhánh CPU phải căn bề rộng theo bội số 16 (`-16`), không phải chỉ số chẵn (`-2`)');

    /* Nhánh VideoToolbox giữ `-2` là CÓ CHỦ Ý: không có máy macOS để kiểm `scale_vt` có
       nhận cú pháp `-16` không. Sai ở đó thì proxy hỏng hẳn trên Mac — đắt hơn cái được.
       Khẳng định này tồn tại để ai đó "dọn cho đồng bộ" phải đọc lý do trước. */
    const vtLine = fn.split('\n').find((l) => l.includes('scale_vt=w='));
    assert.ok(vtLine, 'không tìm thấy bộ lọc scale_vt của nhánh macOS');
    assert.ok(vtLine.includes('-2'),
        'nhánh macOS phải GIỮ `-2` cho tới khi có người kiểm chứng `-16` trên scale_vt thật');
    assert.ok(/CHƯA KIỂM CHỨNG ĐƯỢC|chưa phải theo số đo/.test(cpp),
        'phải giữ ghi chú rằng đây là bản sửa theo thông lệ, chưa có số đo xác nhận');
}

// ---------------------------------------------------------------------------
// 2. Chạy THẬT: binary sinh ra proxy có bề rộng chia hết cho 16
// ---------------------------------------------------------------------------
const exeName = process.platform === 'win32' ? 'core_process.exe' : 'core_process';
const exe = path.join(projectRoot, 'native', 'sidecar', 'build', exeName);
const sampleDir = path.join(projectRoot, 'library', 'Video');

function findSample() {
    if (!fs.existsSync(sampleDir)) return null;
    // Cần nguồn CAO hơn 720 thì nhánh scale mới chạy; thấp hơn là giữ nguyên kích thước.
    for (const name of fs.readdirSync(sampleDir)) {
        if (!/\.(mp4|mov|m4v)$/i.test(name)) continue;
        const file = path.join(sampleDir, name);
        try {
            const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
                '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
            const [w, h] = out.trim().split(',').map(Number);
            if (h > 720 && w % 16 !== 0) return { file, w, h };   // ưu tiên nguồn LỘ ra lỗi
        } catch (_) { /* bỏ qua tệp hỏng */ }
    }
    return null;
}

let sample = null;
try { sample = fs.existsSync(exe) ? findSample() : null; } catch (_) { sample = null; }

if (!sample) {
    /* Không có binary hoặc không có nguồn phù hợp -> BÁO RÕ là đã bỏ qua. Test im lặng bỏ
       qua rồi in "OK" là cách chắc chắn nhất để một bản sửa hỏng trôi qua. */
    console.log('proxy_alignment: OK (phần chạy binary ĐÃ BỎ QUA — thiếu core_process hoặc nguồn >720p)');
} else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crab-proxy-'));
    const out = path.join(tmp, 'preview_proxy.mp4');
    const res = spawnSync(exe, ['preview-proxy', sample.file, out], { encoding: 'utf8', timeout: 120000 });
    assert.strictEqual(res.status, 0, `sidecar dựng proxy lỗi:\n${res.stderr || res.stdout}`);
    assert.ok(fs.existsSync(out), 'sidecar không sinh ra tệp proxy');

    /* Đọc theo TÊN TRƯỜNG, không theo vị trí cột: ffprobe trả các trường theo thứ tự của
       CHÍNH NÓ, không theo thứ tự mình hỏi. Bản đầu dùng `csv=p=0` rồi đọc theo chỉ số nên
       `nb_frames` và `duration` bị hoán chỗ — test vẫn xanh (vì hai bên hoán như nhau) mà
       thông báo in ra "8.3 khung". Xanh vì lý do sai còn nguy hơn đỏ. */
    const probeStream = (file) => {
        const raw = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,nb_frames,duration', '-of', 'default=nw=1', file],
            { encoding: 'utf8' });
        const map = {};
        raw.trim().split(/\r?\n/).forEach((line) => {
            const i = line.indexOf('=');
            if (i > 0) map[line.slice(0, i)] = Number(line.slice(i + 1));
        });
        return map;
    };
    const p = probeStream(out);
    const w = p.width;
    const h = p.height;
    const frames = p.nb_frames;
    const dur = p.duration;

    assert.strictEqual(w % 16, 0, `bề rộng proxy phải chia hết cho 16, nhận ${w}`);
    assert.strictEqual(h, 720, `chiều cao proxy phải là 720, nhận ${h}`);
    assert.ok(w > 0 && w < sample.w, 'proxy phải nhỏ hơn nguồn');

    /* ALL-INTRA LÀ CÓ CHỦ Ý — khẳng định này khoá lại một thí nghiệm ĐÃ THẤT BẠI.
       Đổi sang `-g 30` nghe rất xuôi (bitrate 3,40 -> 1,81 Mbps, khung I 249 -> 9) nhưng
       đo trên máy thật thì khung GIẢI MÃ mỗi giây TĂNG từ 63 lên 77-87 và rớt khung tệ
       hơn. Lý do: Xem trước bản cắt tua 2-4 lần mỗi giây, và mỗi lệnh tua với `-g 30` phải
       giải mã lại tới 30 khung thay vì 1. Xem chú thích ở AppendPreviewEncoderArgs. */
    const iFrames = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-show_frames', '-show_entries', 'frame=pict_type', '-of', 'csv=p=0', out],
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
        .split('\n').filter((l) => l.trim() === 'I').length;
    assert.strictEqual(iFrames, frames,
        `proxy PHẢI là all-intra (${frames} khung, ${iFrames} khung I). Đổi sang GOP thường `
        + 'đã thử và làm TỆ HƠN — đo được khung giải mã 63 -> 77-87 fps.');

    const src = probeStream(sample.file);
    assert.strictEqual(frames, src.nb_frames,
        `proxy phải có ĐÚNG số khung của nguồn (${src.nb_frames}), nhận ${frames}`);
    assert.ok(Math.abs(dur - src.duration) < 0.005,
        `thời lượng LUỒNG VIDEO của proxy phải khớp nguồn (${src.duration}s), nhận ${dur}s`);

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`proxy_alignment: OK (nguồn ${sample.w}x${sample.h} -> proxy ${w}x${h}, ${frames} khung, ${iFrames} khung I)`);
}
