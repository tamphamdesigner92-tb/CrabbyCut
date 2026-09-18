/* =====================================================================
 * BẢN PROXY XEM TRƯỚC ĐI KÈM DỰ ÁN ("<Tên dự án>.proxy.mp4" cạnh .crab)
 *
 * Proxy được dựng từ `temp_input.mp4` — FILE NỐI, mà file nối bị dựng LẠI ở mỗi lượt mở dự
 * án. Dùng lại một proxy đã lưu vì thế là một phép đánh cược, và bài test này canh đúng cái
 * chốt khiến phép đánh cược đó an toàn: DANH TÍNH.
 *
 * NGUY CƠ NẾU LÀM SAI: proxy của một bản nối KHÁC được nhận vào -> khung xem trước chiếu một
 * phim, bản xuất ra một phim khác. Không có thông báo nào, và người dùng chỉ phát hiện sau
 * khi xuất xong. Đổi lại, từ chối nhầm chỉ tốn vài phút encode. Nên mọi phép so ở đây phải
 * CHẶT, và bài test phải bắt được mọi nỗ lực nới lỏng chúng.
 *
 * Chạy: npm run test:preview-proxy
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const serverSrc = read('backend', 'server.js');
const indexSrc = read('index.html');
const mainSrc = read('electron', 'main.js');
const pkgSrc = read('electron', 'project-package.js');

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `không tìm thấy hàm ${name}() trong nguồn`);
    const bodyStart = src.indexOf('{', src.indexOf(')', start));
    let depth = 0;
    for (let i = bodyStart; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`không đóng được thân hàm ${name}()`);
}

/* ---------- 1. Phép so danh tính phải CHẶT ---------- */
{
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction(serverSrc, 'previewProxyIdentityMatches'), sandbox);
    const { previewProxyIdentityMatches: matches } = sandbox;

    const base = { version: 1, concat_version: 5, size_bytes: 244772649, duration_ms: 964667, width: 2560, height: 1440 };
    assert.strictEqual(matches(base, { ...base }), true, 'hai danh tính y hệt phải khớp');

    /* TỪNG TRƯỜNG phải có sức phủ quyết riêng. Bỏ sót một trường nghĩa là một cách đổi bản
     * nối mà phép so không nhìn thấy — đúng loại lỗ để proxy sai lọt qua. */
    for (const key of Object.keys(base)) {
        const drifted = { ...base, [key]: Number(base[key]) + 1 };
        assert.strictEqual(matches(base, drifted), false, `lệch '${key}' mà vẫn khớp -> proxy sai lọt qua`);
    }
    // Lệch MỘT BYTE cũng phải trượt: đây chính là chỗ bắt "ffmpeg đổi phiên bản".
    assert.strictEqual(matches(base, { ...base, size_bytes: base.size_bytes + 1 }), false,
        'lệch một byte ở file nối cũng phải từ chối proxy');
    // Lệch MỘT mili giây cũng phải trượt.
    assert.strictEqual(matches(base, { ...base, duration_ms: base.duration_ms + 1 }), false);

    assert.strictEqual(matches(null, base), false, 'thiếu danh tính = không khớp');
    assert.strictEqual(matches(base, null), false);
    assert.strictEqual(matches(undefined, undefined), false, 'hai bên cùng rỗng KHÔNG được coi là khớp');
    console.log('  ok  danh tính so chặt: lệch bất kỳ trường nào (kể cả 1 byte) là từ chối');
}

/* ---------- 2. Năm cửa của tryAdoptPreviewProxy ---------- */
{
    const fn = extractFunction(serverSrc, 'tryAdoptPreviewProxy');

    assert.ok(/\.mp4'\s*\)\s*return null|extname\(resolved\)\.toLowerCase\(\) !== '\.mp4'/.test(fn),
        'cửa 1: chỉ nhận tệp .mp4');
    assert.ok(/previewProxyIdentityMatches\(descriptor\?\.identity, current\)/.test(fn),
        'cửa 2: danh tính phải khớp file nối VỪA DỰNG, không phải file nối lúc lưu');
    /* CỬA 3 — DUNG LƯỢNG. Đây là cửa DUY NHẤT bắt được tệp chép hụt, và nó được thêm vào
     * SAU KHI đo thấy lỗ: một tệp proxy bị cắt cụt còn 40KB vẫn lọt qua cửa thời lượng, vì
     * MP4 để `moov` ở đầu nên ffprobe đọc ra đủ 6,023s từ METADATA dù dữ liệu đã mất. Thời
     * lượng là thứ tệp TỰ KHAI; dung lượng thì không nói dối được. Gỡ cửa này ra là mở lại
     * đúng cái lỗ đó. */
    assert.ok(/stat\.size !== expectedSize/.test(fn),
        'cửa 3: dung lượng phải khớp TỪNG BYTE — không có nó, tệp chép hụt lọt qua');
    assert.ok(/Number\(descriptor\?\.size_bytes\)/.test(fn), 'cửa 3: dung lượng mong đợi lấy từ descriptor');
    /* Cửa 4 bắt một thứ khác hẳn: tệp proxy HOÀN CHỈNH nhưng của bản nối khác mà tình cờ
       cùng dung lượng. Hai cửa không thay thế được cho nhau. */
    assert.ok(/mediaDurationSeconds\(resolved\)/.test(fn), 'cửa 4: phải đo thời lượng của chính tệp proxy');
    assert.ok(/Math\.abs\(proxyDuration - concatDuration\) > 0\.05/.test(fn),
        'cửa 4: dung sai phải chặt hơn một khung hình (0,05s)');
    assert.ok(/copyFileSync\(resolved, outputPath\)/.test(fn), 'cửa 5: chép vào temp_uploads');
    // Renderer phải THẬT SỰ gửi dung lượng xuống, nếu không cửa 3 từ chối mọi proxy.
    assert.ok(/size_bytes: readyProxy\.size_bytes/.test(indexSrc),
        'payload phải lưu cả dung lượng proxy, nếu không cửa dung lượng từ chối tất');

    // Hỏng ở đây CHỈ ĐƯỢC làm chậm, không được làm mở dự án thất bại.
    assert.ok(/catch \(error\)[\s\S]*return null;/.test(fn), 'mọi lỗi phải nuốt và trả null để rơi về encode lại');
    assert.ok(!/throw /.test(fn), 'đường tối ưu này tuyệt đối không được ném');
    console.log('  ok  tryAdoptPreviewProxy: đủ năm cửa (có cửa dung lượng), và không bao giờ ném');
}

/* ---------- 3. Nhận và dựng lại phải đi CHUNG một lượt gọi ---------- */
{
    /* Tách thành hai lượt gọi thì giữa chúng có một khoảng mà queuePreviewProxy đã chạy rồi,
     * và hai đường cùng ghi vào temp_uploads/preview_proxy.mp4 — kết quả tuỳ lượt nào xong
     * sau, tức là không tất định. */
    assert.ok(/tryAdoptPreviewProxy\(req\.body\?\.preview_proxy, concatPath\)\s*\|\|\s*queuePreviewProxy\(concatPath\)/.test(serverSrc),
        'reingest phải thử nhận TRƯỚC rồi mới rơi về encode, trong cùng một biểu thức');
    assert.ok(/previewProxyState\.identity = previewProxyIdentityFor\(videoPath\)/.test(serverSrc),
        'encode xong phải ghi lại danh tính, nếu không lượt Lưu sau không có gì để lưu');
    console.log('  ok  nhận / dựng lại đi chung một lượt gọi, không có cửa sổ tranh ghi');
}

/* ---------- 4. Giao ước đặt tên và đường đi của tệp ---------- */
{
    const { projectSidecarPath, SIDECAR_PREVIEW_PROXY, SIDECAR_SUBTITLE } = require(path.join(ROOT, 'electron', 'project-package.js'));
    const crab = path.join('D:', 'Phim', 'Du an cua toi.crab');
    assert.strictEqual(projectSidecarPath(crab, SIDECAR_PREVIEW_PROXY), path.join('D:', 'Phim', 'Du an cua toi.proxy.mp4'));
    assert.strictEqual(projectSidecarPath(crab, SIDECAR_SUBTITLE), path.join('D:', 'Phim', 'Du an cua toi.srt'));
    // Chữ hoa/thường của đuôi .crab không được làm hỏng phép cắt tên.
    assert.strictEqual(projectSidecarPath(path.join('D:', 'X.CRAB'), SIDECAR_SUBTITLE), path.join('D:', 'X.srt'));
    console.log('  ok  .srt và .proxy.mp4 dùng CHUNG một hàm dựng tên');

    // Payload lưu DANH TÍNH, không lưu đường dẫn.
    assert.ok(/preview_proxy: \{ identity: readyProxy\.identity, size_bytes: readyProxy\.size_bytes \}/.test(indexSrc),
        'payload lưu danh tính + dung lượng, KHÔNG lưu đường dẫn — đường dẫn suy ra lúc mở');
    assert.ok(/preview_proxy: payload\.media\?\.preview_proxy \|\| null/.test(indexSrc),
        'lúc mở phải gửi descriptor xuống reingest');
    assert.ok(/function resolvePreviewProxyPath/.test(pkgSrc),
        'main process phải gắn đường dẫn thật vào payload lúc đọc .crab');
    console.log('  ok  payload mang danh tính, đường dẫn do main process gắn lúc mở');
}

/* ---------- 5. Lưu không được chậm đi vì proxy ---------- */
{
    /* Nguyên tắc sẵn có của dự án: "Đóng gói là hành động riêng, Lưu vẫn nhẹ như cũ"
     * (electron/project-package.js). Chép ~100MB trong lượt Lưu mà bắt chờ là phá nguyên tắc
     * đó, nên lời gọi phải KHÔNG có `await`. */
    const save = indexSrc.slice(indexSrc.indexOf('async function saveProject('));
    const body = save.slice(0, save.indexOf('\n    }\n'));
    assert.ok(/\n\s*saveProjectProxySidecar\(result\.path\);/.test(body),
        'Lưu phải gọi chép proxy KHÔNG await — chép trăm MB không được chặn người dùng');
    assert.ok(!/await\s+saveProjectProxySidecar/.test(body), 'không được await lượt chép proxy');

    // Lượt Lưu thứ hai trở đi không chép lại: so theo KÍCH THƯỚC (chép làm mới mtime).
    assert.ok(/fs\.statSync\(target\)\.size === srcStat\.size/.test(mainSrc),
        'đã có bản đúng dung lượng thì bỏ qua, đừng chép lại trăm MB mỗi lượt Lưu');
    /* Ghi .part rồi rename: "tệp tồn tại" phải ĐỒNG NGHĨA "đã chép xong", nếu không tắt ứng
       dụng giữa chừng để lại một mp4 cụt và lượt mở sau nhận đúng nó. */
    assert.ok(/\$\{target\}\.part/.test(mainSrc) && /rename\(partPath, target\)/.test(mainSrc),
        'phải chép ra .part rồi rename, không ghi thẳng vào tệp đích');
    console.log('  ok  Lưu vẫn nhẹ: chép ngầm, bỏ qua khi đã có, ghi .part rồi rename');
}

console.log('preview_proxy_sidecar: PASS');
