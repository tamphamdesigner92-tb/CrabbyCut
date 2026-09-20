/* PROXY & THUMBNAIL CHO ASSET ẢNH (xem imageThumbnailUrlFor / scaleImageTo trong server.js).
 *
 * VÌ SAO CÓ BÀI KIỂM NÀY. Trước đây ảnh KHÔNG có bản thu nhỏ ở bất kỳ đâu: panel Tệp phương
 * tiện và preview overlay đều nạp FILE GỐC. Với ảnh máy ảnh 21-45 MP, mỗi thẻ ~60px bắt
 * Chromium giải mã 208 ms và giữ 173 MB RGBA; một dự án 6 ảnh ≈ 640 MB. Công đó nằm ở LUỒNG
 * RASTER nên đồng hồ JS không thấy gì — HUD báo JS 1,7% và Long task 0 trong khi rAF tệ nhất
 * 500 ms và preview rớt 62% khung NGAY CẢ KHI ĐANG DỪNG.
 *
 * Cả bốn nhóm dưới đây đều là chỗ mà sai thì HỎNG ÂM THẦM — preview vẫn hiện ảnh, chỉ là
 * hiện bằng bản gốc, và không ai biết cho tới lần đo tiếp theo.
 *
 *   1) PROXY ẢNH: cạnh dài ≤ IMAGE_PROXY_MAX_EDGE, đuôi .jpg, kind='image'.
 *   2) KHÔNG BAO GIỜ PHÓNG TO: ảnh nhỏ hơn trần phải đi qua gần như nguyên vẹn. Sai chiều
 *      này là "tối ưu" biến thành phản tác dụng mà số đo vẫn đẹp.
 *   3) THUMBNAIL PANEL: đi qua /api/source-thumb và ra ảnh ≤ 320 — KHÔNG phải file gốc.
 *   4) HỢP ĐỒNG XUẤT BẢN: `url`/`path` của asset vẫn trỏ FILE GỐC. Proxy chỉ được đụng vào
 *      đường xem trước; lẫn sang đường xuất là người dùng nhận video 1920px từ ảnh 45 MP.
 *   5) ĐƯỜNG TIÊU THỤ Ở FRONTEND: preview phải THẬT SỰ nạp bản proxy đó.
 *
 * Kèm hai chốt chặn hồi quy: .svg (ffmpeg không giải mã được) và audio đều phải 'unsupported'.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8131';

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const TEMP_DIR = path.join(PROJECT_ROOT, 'temp_uploads');
const WORK_DIR = path.join(TEMP_DIR, 'image_proxy_smoke');
const PROXY_CACHE_DIR = path.join(PROJECT_ROOT, 'proxy_cache');

const MAX_EDGE = 1920;   // IMAGE_PROXY_MAX_EDGE
const THUMB_EDGE = 320;  // IMAGE_THUMB_MAX_EDGE

const { start } = require('../../backend/server');

function makeImage(dest, width, height) {
    const res = spawnSync('ffmpeg', [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=1`,
        '-frames:v', '1', dest,
    ]);
    assert.strictEqual(res.status, 0, `không dựng được ảnh mẫu: ${res.stderr}`);
}

function probeSize(file) {
    const out = spawnSync('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0:s=x', file,
    ], { encoding: 'utf8' });
    assert.strictEqual(out.status, 0, `ffprobe lỗi: ${out.stderr}`);
    const [w, h] = out.stdout.trim().split('x').map(Number);
    return { w, h };
}

async function askProxy(baseUrl, filePath) {
    const res = await fetch(`${baseUrl}/api/editing-assets/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
    });
    assert.strictEqual(res.status, 200);
    return res.json();
}

async function waitReady(baseUrl, filePath, timeoutMs = 60000) {
    const started = Date.now();
    for (;;) {
        const data = await askProxy(baseUrl, filePath);
        if (data.status === 'ready' && data.url) return data;
        assert.notStrictEqual(data.status, 'unsupported', `ảnh hợp lệ mà bị coi là unsupported: ${filePath}`);
        assert.ok(!data.error, `job proxy ảnh lỗi: ${data.error}`);
        assert.ok(Date.now() - started < timeoutMs, 'job proxy ảnh quá lâu');
        await new Promise((r) => setTimeout(r, 120));
    }
}

/* ===== 5) ĐƯỜNG TIÊU THỤ Ở FRONTEND (tĩnh, không cần backend/trình duyệt) =====
 *
 * VÌ SAO CÓ NHÓM NÀY. Bốn nhóm trên chỉ hỏi backend, nên chúng vẫn xanh trong suốt
 * quãng thời gian mà tính năng này KHÔNG chạy: backend dựng proxy 1920px đúng chuẩn,
 * cache đầy file .jpg, còn `makeMediaEl` thì gán `img.src = asset.url` — nhánh <video>
 * ngay phía trên dùng URL hiệu dụng, nhánh <img> thì không. Người dùng báo "preview giật
 * khi playhead tới block ảnh" và mọi bài kiểm đều bảo mọi thứ ổn.
 *
 * Node không có DOM nên kiểm ở mức NGUỒN: cắt đúng thân hàm rồi soi những phép gán quyết
 * định. Thô, nhưng bắt đúng loại hồi quy đã xảy ra thật. */
const runtimeJs = fs.readFileSync(path.join(PROJECT_ROOT, 'static', 'js', 'editing-runtime.js'), 'utf8');
const serverJs = fs.readFileSync(path.join(PROJECT_ROOT, 'backend', 'server.js'), 'utf8');

// Cắt thân khối `{...}` mở ra ngay sau `marker`, đếm ngoặc để lấy đúng phạm vi hàm.
function blockAfter(src, marker) {
    const start = src.indexOf(marker);
    assert.notStrictEqual(start, -1, `không tìm thấy trong nguồn: ${marker}`);
    const open = src.indexOf('{', start + marker.length - 1);
    let depth = 0;
    for (let i = open; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    throw new Error(`khối không đóng: ${marker}`);
}

{
    // 5a. Thẻ media của preview: CẢ HAI nhánh (video và ảnh) phải nạp URL hiệu dụng.
    const makeMediaEl = blockAfter(runtimeJs, 'const makeMediaEl = () => {');
    const srcAssigns = makeMediaEl.match(/\w+\.src\s*=\s*[^;]+;/g) || [];
    assert.strictEqual(srcAssigns.length, 2,
        `makeMediaEl phải có đúng 2 lượt gán src (video + ảnh), thấy ${srcAssigns.length}`);
    srcAssigns.forEach((line) => {
        assert.ok(line.includes('mediaUrl'),
            `gán src phải ưu tiên mediaUrl (URL đã tính LQ/HQ), thấy: ${line.trim()}`);
    });

    // 5b. Khung đứng yên của chuyển cảnh cũng là đường XEM TRƯỚC -> nạp bản preview trước.
    const drawable = blockAfter(runtimeJs, 'function ensureItemDrawable(item, mode) {');
    const stillBranch = drawable.slice(0, drawable.indexOf('if (isVideo)'));
    assert.ok(stillBranch.includes('previewAssetUrl(asset)'),
        'nhánh ảnh tĩnh của ensureItemDrawable phải đi qua previewAssetUrl');
    const firstLoad = (stillBranch.match(/loadImageAsync\(([^)]*)\)/) || [])[1];
    assert.ok(firstLoad && firstLoad.trim() !== 'asset.url',
        'lượt nạp ĐẦU TIÊN phải là bản preview, không phải file gốc (Image full-res nằm lại trong cache)');

    // 5c. Mở lại .crab: không có lượt ensureAssetProbed nào chạy -> phải tự kick proxy.
    const restore = blockAfter(runtimeJs, 'function restoreEditingHistoryState(state) {');
    assert.ok(restore.includes('prewarmProxiesForUsedAssets()'),
        'nạp lại state phải kick proxy, nếu không thì dự án cũ mở lên là phát file gốc');
    const prewarmFront = blockAfter(runtimeJs, 'function prewarmProxiesForUsedAssets() {');
    assert.ok(prewarmFront.includes('ensureAssetProxy(asset)'),
        'prewarmProxiesForUsedAssets phải thật sự gọi ensureAssetProxy');

    // 5d. Prewarm phía backend không được loại ảnh ra (queueAssetProxy đã dựng được ảnh).
    const prewarmBack = blockAfter(serverJs, 'function prewarmAssetProxiesForAssets(assets) {');
    assert.ok(!prewarmBack.includes('media_image'),
        'prewarm của backend không được bỏ qua ảnh: ảnh máy ảnh là nguồn giật nặng nhất');
}

(async () => {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const bigPath = path.join(WORK_DIR, 'big.jpg');
    const smallPath = path.join(WORK_DIR, 'small.jpg');
    const svgPath = path.join(WORK_DIR, 'vector.svg');
    const audioPath = path.join(WORK_DIR, 'tone.mp3');

    // 6000x4000 — cùng hạng với ảnh máy ảnh thật đã đo (6240x3512 / 8256x5504).
    makeImage(bigPath, 6000, 4000);
    // 800x600 — nhỏ hơn trần, dùng cho nhóm 2.
    makeImage(smallPath, 800, 600);
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    const tone = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
        'sine=frequency=440:duration=1', audioPath]);
    assert.strictEqual(tone.status, 0, 'không dựng được audio mẫu');

    const created = [bigPath, smallPath, svgPath, audioPath];
    const server = await start();
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const proxyFiles = [];

    try {
        await fetch(`${baseUrl}/api/source-access/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: created }),
        });

        // ---- 1) PROXY ẢNH ----
        const ready = await waitReady(baseUrl, bigPath);
        assert.strictEqual(ready.kind, 'image', 'job phải tự nhận là ảnh');
        assert.ok(ready.url.endsWith('.jpg'), `proxy ảnh phải là .jpg, nhận: ${ready.url}`);
        const proxyFile = path.join(PROXY_CACHE_DIR, path.basename(ready.url));
        proxyFiles.push(proxyFile);
        assert.ok(fs.existsSync(proxyFile), 'file proxy phải nằm trong proxy_cache');
        const big = probeSize(proxyFile);
        assert.ok(Math.max(big.w, big.h) <= MAX_EDGE,
            `cạnh dài của proxy phải ≤ ${MAX_EDGE}, nhận ${big.w}x${big.h}`);
        assert.ok(Math.abs((big.w / big.h) - (6000 / 4000)) < 0.02, 'proxy phải giữ đúng tỉ lệ');

        // Cache hit: lần 2 trả ngay cùng key, không dựng lại.
        const again = await askProxy(baseUrl, bigPath);
        assert.strictEqual(again.status, 'ready');
        assert.strictEqual(again.url, ready.url, 'lần 2 phải là cache hit cùng key');

        // ---- 2) KHÔNG BAO GIỜ PHÓNG TO ----
        const smallReady = await waitReady(baseUrl, smallPath);
        const smallProxyFile = path.join(PROXY_CACHE_DIR, path.basename(smallReady.url));
        proxyFiles.push(smallProxyFile);
        const small = probeSize(smallProxyFile);
        assert.ok(small.w <= 800 && small.h <= 600,
            `ảnh nhỏ hơn trần KHÔNG được phóng to, nhận ${small.w}x${small.h}`);

        // ---- 3) THUMBNAIL PANEL ----
        const linkRes = await fetch(`${baseUrl}/api/editing-assets/link`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: [bigPath] }),
        });
        assert.strictEqual(linkRes.status, 200);
        const linked = (await linkRes.json()).assets || [];
        const asset = linked.find((a) => a.path === bigPath);
        assert.ok(asset, 'link phải trả về asset của ảnh');
        assert.strictEqual(asset.type, 'media_image');
        assert.notStrictEqual(asset.thumbnail_url, asset.url,
            'THUMBNAIL KHÔNG ĐƯỢC LÀ FILE GỐC — đây chính là lỗi đang sửa');
        assert.ok(asset.thumbnail_url.startsWith('/api/source-thumb'),
            `thumbnail phải đi qua /api/source-thumb, nhận: ${asset.thumbnail_url}`);

        const thumbRes = await fetch(`${baseUrl}${asset.thumbnail_url}`, { redirect: 'follow' });
        assert.strictEqual(thumbRes.status, 200, 'source-thumb của ảnh phải trả được file');
        const thumbBytes = Buffer.from(await thumbRes.arrayBuffer());
        const thumbTmp = path.join(WORK_DIR, 'thumb_check.jpg');
        fs.writeFileSync(thumbTmp, thumbBytes);
        created.push(thumbTmp);
        const thumb = probeSize(thumbTmp);
        assert.ok(Math.max(thumb.w, thumb.h) <= THUMB_EDGE,
            `thumbnail phải ≤ ${THUMB_EDGE}, nhận ${thumb.w}x${thumb.h}`);
        assert.ok(thumbBytes.length < fs.statSync(bigPath).size / 10,
            'thumbnail phải nhỏ hơn hẳn file gốc');

        // ---- 4) HỢP ĐỒNG XUẤT BẢN ----
        assert.strictEqual(asset.path, bigPath, 'path của asset phải vẫn là FILE GỐC');
        assert.ok(asset.url.includes('source-file'),
            `url của asset phải vẫn trỏ file gốc, nhận: ${asset.url}`);
        assert.ok(!asset.url.includes('/proxy_cache/'),
            'url của asset TUYỆT ĐỐI không được trỏ vào proxy — bản xuất sẽ dùng nó');

        // ---- CHỐT CHẶN HỒI QUY ----
        const svg = await askProxy(baseUrl, svgPath);
        assert.strictEqual(svg.status, 'unsupported',
            '.svg không được dựng proxy: ffmpeg không giải mã được, job sẽ hỏng im lặng');
        const audio = await askProxy(baseUrl, audioPath);
        assert.strictEqual(audio.status, 'unsupported', 'audio vẫn phải là unsupported');
        const outside = await askProxy(baseUrl, path.join(PROJECT_ROOT, 'package.json'));
        assert.strictEqual(outside.status, 'unsupported', 'đường dẫn ngoài danh sách trắng phải bị chặn');
    } finally {
        server.close();
        for (const file of created) fs.rmSync(file, { force: true });
        for (const file of proxyFiles) fs.rmSync(file, { force: true });
        fs.rmSync(WORK_DIR, { recursive: true, force: true });
    }

    console.log('image_proxy ok');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
