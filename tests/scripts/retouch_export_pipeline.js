/* Test HỢP ĐỒNG XUẤT của Retouch — preview và bản xuất phải cho ra cùng một ảnh.
 *
 * BỐI CẢNH: retouch KHÔNG được cài lại trong C++ sidecar (một thuật toán, một bản cài
 * đặt). Bản xuất lấy hình bằng cách bake ở frontend, qua ĐÚNG hàm mà preview gọi, rồi
 * VÁ ĐÈ vùng mặt lên khung. Vì vậy WYSIWYG ở đây không phụ thuộc vào việc hai công thức
 * có khớp nhau không (chúng là MỘT), mà phụ thuộc vào hai điều khác — và đây là hai điều
 * mà test này canh:
 *
 *   1. MIẾNG VÁ PHẢI PHỦ HẾT phần bị đổi. Cắt hụt một dải là mất hiệu ứng ở rìa và lộ
 *      đường ghép ngay mép hàm. `Retouch.touchedBounds` là thứ quyết định chỗ cắt, nên
 *      test chạy TRỌN chuỗi tham chiếu CPU trên cả khung rồi đòi: mọi pixel bị đổi đều
 *      nằm trong hộp đó.
 *   2. MIẾNG VÁ PHẢI ĐƯỢC CHỈNH MÀU CÙNG BỘ LỌC với phần khung quanh nó. Frontend gửi
 *      khung CHƯA chỉnh màu kèm cờ `color_source:'raw'`; backend phải áp chuỗi màu cho
 *      chuỗi khung đó — trong khi chuỗi khung của CHUYỂN CẢNH (đã bake sẵn màu) thì
 *      tuyệt đối không được áp, nếu không là chỉnh màu hai lần.
 */
const assert = require('assert');
const { spawnSync } = require('child_process');
const TRANSPARENT_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const fs = require('fs');
const path = require('path');

// Phải đặt TRƯỚC khi require backend/server.js: cổng được đọc lúc nạp module.
// Cổng riêng để không đụng backend dev đang chạy ở 8000.
process.env.BACKEND_PORT = process.env.BACKEND_PORT || '8124';

const PROJECT_ROOT = path.join(__dirname, '..', '..');
// filterPath: escape đường dẫn nằm TRONG filtergraph y như production.
const ColorAdjust = require(path.join(PROJECT_ROOT, 'static', 'js', 'color-adjust.js'));
/* THƯ MỤC TẠM RIÊNG CHO TEST — cũng phải đặt TRƯỚC khi require server.
 * testRetouchSourceKinds GHI file thử vào TEMP_DIR để kiểm cổng nhận nguồn. Trỏ vào thư
 * mục tạm mặc định là rải rác file lạ vào dữ liệu của DỰ ÁN NGƯỜI DÙNG ĐANG MỞ.
 * Tên không được bắt đầu bằng dấu chấm — xem ghi chú ở tests/scripts/export_smoke.js. */
process.env.CRAB_TEMP_DIR = process.env.CRAB_TEMP_DIR
  || path.join(PROJECT_ROOT, 'test_temp', 'retouch_export');
fs.mkdirSync(process.env.CRAB_TEMP_DIR, { recursive: true });
const Retouch = require(path.join(PROJECT_ROOT, 'static', 'js', 'retouch.js'));
const FACE = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'tests', 'fixtures', 'face_landmarks.json'), 'utf8')).face;

// ---------------------------------------------------------------------------
// 1. MIẾNG VÁ PHỦ HẾT PHẦN BỊ ĐỔI
// ---------------------------------------------------------------------------

// Ảnh thử: có cả tần số thấp lẫn cao để nhóm tách tần số thật sự có việc để làm.
const W = 180, H = 320, A = W / H;
function pixel(x, y, c) {
    const u = x / W, v = y / H;
    return Math.min(1, Math.max(0,
        0.45 + 0.22 * Math.sin(u * 9 + c) + 0.16 * Math.cos(v * 7 - c * 0.6)
        + 0.07 * Math.sin(x * 1.7 + c) * Math.sin(y * 1.5)));
}

function bilinear(buf, g, lu, lv, ch, stride) {
    const fx = Math.min(g - 1, Math.max(0, lu * g - 0.5));
    const fy = Math.min(g - 1, Math.max(0, lv * g - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(g - 1, x0 + 1), y1 = Math.min(g - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const at = (x, y) => buf[(y * g + x) * stride + ch];
    return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty)
         + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
}

/* Chuỗi tham chiếu CPU đầy đủ: biến dạng -> tách tần số -> màu cục bộ, đúng thứ tự đã
 * chốt. Trả về hàm đọc màu ra tại một pixel. */
function referenceRenderer(cfg) {
    const r = Retouch.normalize(cfg);
    const raster = Retouch.rasterizeMasks([FACE], { aspect: A });
    const B = raster.bounds;
    const G = Retouch.FREQ_GRID;
    const local = new Float32Array(G * G * 3);
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
        const u = B.x0 + (i + 0.5) / G * B.width, v = B.y0 + (j + 0.5) / G * B.height;
        const sx = Math.min(W - 1, Math.max(0, Math.floor(u * W)));
        const sy = Math.min(H - 1, Math.max(0, Math.floor(v * H)));
        for (let c = 0; c < 3; c++) local[(j * G + i) * 3 + c] = pixel(sx, sy, c);
    }
    const rad = Retouch.freqRadiiOnGrid(FACE, B, G);
    const lf = Retouch.blurRgbBoxCascade(local, G, G, rad.fine);
    const lc = Retouch.blurRgbBoxCascade(local, G, G, rad.coarse);
    const ctrl = Retouch.warpControlPoints(FACE, r.params, A);

    return function at(x, y) {
        const u = (x + 0.5) / W, v = (y + 0.5) / H;
        const [du, dv] = ctrl.length ? Retouch.displaceUv(u, v, ctrl, A) : [u, v];
        const sx = Math.min(W - 1, Math.max(0, Math.floor(du * W)));
        const sy = Math.min(H - 1, Math.max(0, Math.floor(dv * H)));
        let c = [pixel(sx, sy, 0), pixel(sx, sy, 1), pixel(sx, sy, 2)];
        const lu = (u - B.x0) / B.width, lv = (v - B.y0) / B.height;
        if (lu >= 0 && lu < 1 && lv >= 0 && lv < 1) {
            const m = {};
            Retouch.MASK_LAYOUT.forEach((l) => {
                m[l.name] = bilinear(raster.textures[l.tex], G, lu, lv, l.ch, 4) / 255;
            });
            const S = (b) => [0, 1, 2].map((ch) => bilinear(b, G, lu, lv, ch, 3));
            c = Retouch.applyFreqOps(c, S(lf), S(lc), cfg, m);
            c = Retouch.applyColorOps(c, cfg, m);
        }
        return c;
    };
}

const CASES = [
    ['chỉ BIẾN DẠNG (kéo hết)', { enabled: true, params: { facelift: 100, plump: 100 } }],
    ['chỉ TÁCH TẦN SỐ', { enabled: true, params: { smooth: 80, dewrinkle: 60, smileLines: 70, even: 40 } }],
    ['chỉ MÀU CỤC BỘ', { enabled: true, params: { whitening: 70, darkCircles: 60, brightEye: 50, whiteTeeth: 60 } }],
    ['cả 13 thanh', { enabled: true, params: Object.fromEntries(Retouch.PARAM_KEYS.map((k) => [k, 70])),
                      skinTone: '#c8926b', skinToneAmount: 50 }],
];

function testPatchCoversEveryChangedPixel() {
    CASES.forEach(([name, cfg]) => {
        const box = Retouch.touchedBounds([FACE], Retouch.normalize(cfg).params, A);
        assert.ok(box, `${name}: không tính được vùng chạm tới`);
        const at = referenceRenderer(cfg);
        let changed = 0, outside = 0, worstOutside = 0, worstAt = null;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const c = at(x, y);
            let d = 0;
            for (let ch = 0; ch < 3; ch++) d = Math.max(d, Math.abs(c[ch] - pixel(x, y, ch)) * 255);
            if (d <= 0.5) continue;   // dưới nửa bậc lượng tử 8-bit thì không ai thấy
            changed++;
            const u = (x + 0.5) / W, v = (y + 0.5) / H;
            if (u < box.x0 || u > box.x1 || v < box.y0 || v > box.y1) {
                outside++;
                if (d > worstOutside) { worstOutside = d; worstAt = `${x},${y}`; }
            }
        }
        assert.ok(changed > 200, `${name}: phép thử vô nghĩa, chỉ ${changed} pixel bị đổi`);
        assert.strictEqual(outside, 0,
            `${name}: ${outside} pixel bị đổi NẰM NGOÀI miếng vá (nặng nhất ${worstOutside.toFixed(1)}/255 tại ${worstAt})`
            + ' -> bản xuất sẽ cắt cụt hiệu ứng và lộ mép');
        const area = (box.x1 - box.x0) * (box.y1 - box.y0);
        console.log(`  ok  ${name}: ${changed} pixel đổi, tất cả trong vùng vá (vùng = ${(area * 100).toFixed(1)}% khung)`);
    });
}

function testPatchIsNotWastefullyLarge() {
    // Phủ hết là điều kiện CẦN; nếu phủ bằng cách lấy cả khung thì test trên vẫn xanh mà
    // tính năng thì mất hết lợi ích (bake vùng mặt rẻ hơn bake cả khung 10 lần).
    const cfg = { enabled: true, params: { smooth: 70, whitening: 50 } };
    const box = Retouch.touchedBounds([FACE], Retouch.normalize(cfg).params, A);
    const area = (box.x1 - box.x0) * (box.y1 - box.y0);
    assert.ok(area < 0.25, `vùng vá phải nhỏ hơn 25% khung, đang là ${(area * 100).toFixed(1)}%`);
    // Có biến dạng thì vùng PHẢI nở ra — bán kính ảnh hưởng vươn ngoài hộp mặt nạ.
    const warped = Retouch.touchedBounds([FACE],
        Retouch.normalize({ enabled: true, params: { facelift: 100 } }).params, A);
    const warpedArea = (warped.x1 - warped.x0) * (warped.y1 - warped.y0);
    assert.ok(warpedArea > area * 1.05,
        `bật Thon mặt phải NỚI vùng vá (${(area * 100).toFixed(1)}% -> ${(warpedArea * 100).toFixed(1)}%)`);
    console.log(`  ok  vùng vá bám sát: ${(area * 100).toFixed(1)}% khung, nở lên ${(warpedArea * 100).toFixed(1)}% khi bật biến dạng`);
}

// ---------------------------------------------------------------------------
// 2. CỔNG MÀU CỦA CHUỖI KHUNG — 'raw' phải được chỉnh, đã bake thì không
// ---------------------------------------------------------------------------

function seqItem(id, colorSource) {
    const frames = [
        'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
        'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    ];
    const item = {
        id,
        type: 'text',
        track_id: 'track_main',
        timeline_start: 0,
        duration: 2,
        source_start: 0,
        transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 },
        rendered_text_png: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        rendered_text_width: 1,
        rendered_text_height: 1,
        animation_render: { fps: 30, seq: { start: 0, duration: 2, width: 64, height: 64, frame_count: 2, frames } },
        color_adjust: { filters: ['eq=contrast=1.2'] },
    };
    if (colorSource) item.animation_render.color_source = colorSource;
    return item;
}

function testColorSourceGate() {
    const { normalizeEditingPayload } = require(path.join(PROJECT_ROOT, 'backend', 'server.js'));
    const build = (item) => normalizeEditingPayload({
        version: 5,
        tracks: [{ id: 'track_main', type: 'main', order: 0, visible: true }],
        items: [item],
        assets: [],
    }, 10, 30);

    const raw = build(seqItem('retouch_0', 'raw'));
    const baked = build(seqItem('trans_0', null));
    const findSeq = (p) => p.overlays.find((o) => o.asset_type === 'image_seq');

    const rawOv = findSeq(raw);
    const bakedOv = findSeq(baked);
    assert.ok(rawOv, "không dựng được overlay image_seq cho ca 'raw'");
    assert.ok(bakedOv, 'không dựng được overlay image_seq cho ca đã bake màu');

    const hasFilters = (ov) => typeof ov.adj_filters === 'string' && ov.adj_filters.length > 0;
    assert.ok(hasFilters(rawOv),
        "chuỗi khung 'raw' (miếng vá Retouch) PHẢI được sidecar chỉnh màu, nếu không miếng vá"
        + ' giữ màu gốc trong khi phần khung quanh nó đã đổi màu -> lộ hình chữ nhật');
    assert.ok(!hasFilters(bakedOv),
        'chuỗi khung đã bake sẵn màu (chuyển cảnh) KHÔNG được chỉnh màu lần nữa');
    console.log('  ok  cổng màu: chuỗi khung \'raw\' được chỉnh màu, chuỗi đã bake thì không');
}

function testRetouchItemSurvivesPayload() {
    const { normalizeEditingPayload } = require(path.join(PROJECT_ROOT, 'backend', 'server.js'));
    // Miếng vá là một MẢNH của khung nên có kích thước riêng và vị trí lệch tâm; hai thứ
    // đó phải đi qua payload nguyên vẹn, nếu không miếng vá dán sai chỗ.
    const item = seqItem('retouch_3', 'raw');
    item.transform.position_x = -137;
    item.transform.position_y = 212;
    const payload = normalizeEditingPayload({
        version: 5,
        tracks: [{ id: 'track_main', type: 'main', order: 0, visible: true }],
        items: [item],
        assets: [],
    }, 10, 30);
    const ov = payload.overlays.find((o) => o.asset_type === 'image_seq');
    assert.strictEqual(ov.position_x, -137, 'vị trí X của miếng vá bị đổi khi qua payload');
    assert.strictEqual(ov.position_y, 212, 'vị trí Y của miếng vá bị đổi khi qua payload');
    assert.strictEqual(ov.scale, 100, 'miếng vá phải giữ scale 100 (đã ở đúng cỡ pixel khung)');
    assert.strictEqual(ov.frame_count, 2);
    console.log('  ok  miếng vá giữ nguyên vị trí lệch tâm và scale khi qua payload');
}

// ---------------------------------------------------------------------------
// 3. NGUỒN LANDMARK — media overlay dùng asset riêng, và chặn đường dẫn lạ
// ---------------------------------------------------------------------------

/* MIẾNG VÁ CỦA OVERLAY VIDEO PHẢI NẰM NGAY TRÊN ITEM CỦA NÓ.
 *
 * Sidecar vẽ overlay theo THỨ TỰ MẢNG mà backend trả về, và backend sắp mảng đó theo
 * `track_order` rồi tới `index`. Miếng vá lấy CÙNG track_id với item gốc và được đẩy vào
 * CUỐI danh sách item, nên nó phải:
 *   · nằm SAU item gốc  -> vá đè lên mặt chưa retouch, chứ không bị item gốc đè lại;
 *   · nằm TRƯỚC mọi item ở track phía trên -> không nhảy lên che thứ đáng lẽ ở trên nó.
 * Cả hai đều là hệ quả của phép SẮP XẾP ở backend, nên phải kiểm ở đây chứ không phải
 * đọc mã frontend rồi tin.
 */
function testOverlayPatchStacking() {
    const { normalizeEditingPayload } = require(path.join(PROJECT_ROOT, 'backend', 'server.js'));
    const media = (id, trackId) => ({
        id,
        type: 'media',
        asset_id: 'asset_v',
        track_id: trackId,
        timeline_start: 1,
        duration: 2,
        source_start: 0,
        transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 },
    });
    const patch = seqItem('rtov_ov_low', 'raw');
    patch.track_id = 'track_low';
    patch.timeline_start = 1;
    patch.duration = 2;

    const payload = normalizeEditingPayload({
        version: 5,
        tracks: [
            { id: 'track_low', type: 'visual', order: 2, visible: true },
            { id: 'track_high', type: 'visual', order: 1, visible: true },
        ],
        // Thứ tự trong `items` cố ý giống lúc chạy thật: item gốc trước, item của track
        // khác ở giữa, miếng vá đẩy vào CUỐI.
        items: [media('ov_low', 'track_low'), media('ov_high', 'track_high'), patch],
        assets: [{ id: 'asset_v', type: 'media_video', path: '/tmp/x.mp4', width: 320, height: 240, has_audio: true }],
    }, 10, 30);

    const order = payload.overlays.filter((o) => o.type === 'media' || o.type === 'text').map((o) => o.id);
    const at = (id) => order.findIndex((x) => x === id);
    assert.ok(at('ov_low') >= 0 && at('rtov_ov_low_anim') >= 0 && at('ov_high') >= 0,
        `thiếu overlay trong kết quả: ${order.join(',')}`);
    assert.ok(at('rtov_ov_low_anim') > at('ov_low'),
        `miếng vá phải vẽ SAU item gốc, đang là ${order.join(' -> ')}`);
    assert.ok(at('rtov_ov_low_anim') < at('ov_high'),
        `miếng vá phải vẽ TRƯỚC item của track trên, đang là ${order.join(' -> ')}`);
    console.log(`  ok  z-order miếng vá overlay: ${order.join(' -> ')}`);
}

/* ẢNH TĨNH được phép làm nguồn landmark, mọi thứ khác thì không.
 *
 * Kiểm THẲNG `resolveRetouchSource` chứ không qua HTTP: đường "được phép" nếu gọi qua
 * endpoint là sẽ khởi động sidecar và chạy MediaPipe thật — chậm, và biến một test về
 * CỔNG AN TOÀN thành test phụ thuộc python.
 */
function testRetouchSourceKinds() {
    const { resolveRetouchSource } = require(path.join(PROJECT_ROOT, 'backend', 'server.js'));
    const tempDir = path.resolve(process.env.CRAB_TEMP_DIR);
    const dir = path.join(tempDir, 'retouch_src_kinds');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    try {
        const make = (name) => {
            const p = path.join(dir, name);
            fs.writeFileSync(p, 'x');
            return p;
        };
        // Nội dung không quan trọng: cổng này xét ĐUÔI FILE + THƯ MỤC, còn việc đọc được
        // hay không là chuyện của ffmpeg ở sidecar.
        const allowed = ['a.mp4', 'a.mov', 'a.webm', 'b.png', 'b.jpg', 'b.jpeg', 'b.webp'];
        const denied = ['c.mp3', 'c.wav', 'c.txt', 'c.json', 'c.svg'];
        for (const name of allowed) {
            const p = make(name);
            assert.strictEqual(resolveRetouchSource(p), fs.realpathSync(p),
                `"${name}" phải được nhận làm nguồn Retouch`);
        }
        for (const name of denied) {
            assert.strictEqual(resolveRetouchSource(make(name)), null,
                `"${name}" KHÔNG phải nguồn hình — phải bị từ chối`);
        }
        // Ảnh nằm NGOÀI thư mục cho phép vẫn bị chặn: nới loại file không được nới chỗ.
        const outside = path.join(PROJECT_ROOT, 'tests', 'fixtures', 'face_landmarks.json');
        assert.strictEqual(resolveRetouchSource(outside), null);
        const outsideImage = path.join(PROJECT_ROOT, 'outside_retouch_probe.png');
        fs.writeFileSync(outsideImage, 'x');
        try {
            assert.strictEqual(resolveRetouchSource(outsideImage), null,
                'ảnh NGOÀI TEMP_DIR/LIBRARY_DIR vẫn phải bị từ chối');
        } finally {
            fs.rmSync(outsideImage, { force: true });
        }
        console.log('  ok  nhận video + ảnh tĩnh làm nguồn, chặn mọi loại khác và mọi chỗ khác');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

/* Ảnh tĩnh có retouch đi đường chuỗi khung 2 khung với cờ `color_source: 'raw'` — cùng
 * cơ chế và cùng lý do với miếng vá của lane chính. Đòi backend áp chuỗi màu cho nó:
 * frontend cố ý KHÔNG bake màu vào khung, nên bỏ qua là ảnh mất hết chỉnh màu. */
function testStillImageSeqGetsColor() {
    const { normalizeEditingPayload } = require(path.join(PROJECT_ROOT, 'backend', 'server.js'));
    const item = seqItem('img_1', 'raw');
    item.type = 'media';
    item.asset_id = 'asset_img';
    delete item.rendered_text_png;
    const payload = normalizeEditingPayload({
        version: 5,
        tracks: [{ id: 'track_v1', type: 'visual', order: 1, visible: true }],
        items: [{ ...item, track_id: 'track_v1' }],
        assets: [{ id: 'asset_img', type: 'media_image', path: '/tmp/x.png', width: 64, height: 64 }],
    }, 10, 30);
    const ov = payload.overlays.find((o) => o.asset_type === 'image_seq');
    assert.ok(ov, 'ảnh tĩnh có retouch phải ra overlay image_seq');
    assert.ok(typeof ov.adj_filters === 'string' && ov.adj_filters.length > 0,
        "chuỗi khung 'raw' của ảnh tĩnh PHẢI được sidecar chỉnh màu");
    assert.strictEqual(ov.frame_count, 2,
        'ảnh tĩnh chỉ cần 2 khung — eof_action=repeat giữ khung cuối suốt block');
    console.log('  ok  ảnh tĩnh: chuỗi 2 khung, sidecar vẫn áp chuỗi màu');
}

async function testTrackSourceGuard() {
    // /api/retouch/track nhận `source_path` để media overlay bám mặt trên CHÍNH file
    // asset của nó. Chuỗi đó đến từ request rồi đi thẳng cho sidecar mở, nên endpoint
    // phải từ chối mọi đường dẫn ngoài thư mục dự án — nếu không nó là một cách đọc
    // file tuỳ ý trên máy.
    const { start } = require(path.join(PROJECT_ROOT, 'backend', 'server.js'));
    const port = Number(process.env.BACKEND_PORT);
    const server = start();
    await new Promise((r) => setTimeout(r, 400));
    try {
        const post = async (body) => {
            const res = await fetch(`http://127.0.0.1:${port}/api/retouch/track`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            return { status: res.status, json: await res.json().catch(() => ({})) };
        };
        const timeline = [{ index: 0, start: 0, end: 0.2 }];
        for (const bad of ['/etc/passwd', '../../../../etc/hosts', '/etc/hosts',
                           path.join(PROJECT_ROOT, 'package.json')]) {
            const r = await post({ timeline, source_path: bad });
            assert.strictEqual(r.status, 400,
                `đường dẫn "${bad}" phải bị TỪ CHỐI (HTTP 400), nhận ${r.status}`);
        }
        console.log('  ok  chặn nguồn ngoài thư mục dự án và file không phải hình');
    } finally {
        await new Promise((r) => server.close(r));
    }
}

/* ---------------------------------------------------------------------------
 * 3. MÉP MIẾNG VÁ PHẢI MỀM — chống lộ hình chữ nhật quanh khuôn mặt.
 *
 * VÌ SAO: pixel của miếng vá do TRÌNH DUYỆT giải mã, pixel quanh nó do FFMPEG giải mã
 * CÙNG file. Hai bộ giải mã lệch nhau chút ít — đo trên nguồn thật của người dùng
 * (1080x1920, bt709/tv, lấy bằng `-c copy` nên không phải do mã hoá lại): trung bình
 * khung lệch +2.28/+1.78/+2.12 trên R/G/B và lệch ĐỀU khắp khung (ramp xám thuần thì
 * hai bên khớp tuyệt đối). Chuỗi LUT + tương phản khuếch đại bậc nhảy đó tới ngưỡng mắt
 * thấy được, hiện thành một hình chữ nhật quanh mặt.
 *
 * Test dựng đúng tình huống đó: miếng vá sáng hơn nền ĐÚNG 2/255, cùng đi qua một chuỗi
 * màu có LUT, rồi ĐO BẬC NHẢY LỚN NHẤT giữa hai pixel kề nhau tại mép.
 * ------------------------------------------------------------------------- */
async function testPatchEdgeIsFeathered() {
    if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
        console.log('  [!] không có ffmpeg -> bỏ qua phép đo mép miếng vá');
        return;
    }
    const W = 256; const H = 256; const PW = 96; const PH = 96;
    const lut = path.join(PROJECT_ROOT, 'library', 'luts', 'airy_white.cube');
    /* PHẢI dùng ĐÚNG thư mục tạm mà server đang chạy trên đó: server.js chốt TEMP_DIR
     * ngay lúc require, nên đổi CRAB_TEMP_DIR ở đây là vô tác dụng — file dựng ra sẽ nằm
     * một nơi còn export lại đọc một nơi khác. */
    const tmp = path.resolve(process.env.CRAB_TEMP_DIR);
    fs.mkdirSync(tmp, { recursive: true });
    const sh = (cmd, args) => {
        const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1e8 });
        assert.strictEqual(r.status, 0, cmd + '\n' + r.stderr);
    };
    sh('ffmpeg', ['-nostdin', '-y', '-v', 'error',
        '-f', 'lavfi', '-i', 'color=c=0x8a9aa8:s=' + W + 'x' + H + ':d=1:r=30',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
        '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '0',
        path.join(tmp, 'temp_input.mp4')]);
    const patchPng = path.join(tmp, 'patch.png');
    // +2/255 trên mỗi kênh — đúng độ lệch đã đo giữa hai bộ giải mã.
    sh('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi',
        '-i', 'color=c=0x8c9caa:s=' + PW + 'x' + PH + ':d=1:r=30', '-frames:v', '1', patchPng]);
    const frame = 'data:image/png;base64,' + fs.readFileSync(patchPng).toString('base64');
    /* ĐÚNG ĐƯỜNG CỦA PRODUCTION: frontend chỉ đặt CHỖ TRỐNG `__LUT3D__` rồi gửi NỘI
     * DUNG cube; backend ghi ra file và tự ghép `lut3d=file='…'` (có escape `:` của ổ
     * đĩa). Nếu test tự nhét đường dẫn thật vào chuỗi filter thì bộ lọc ký tự của
     * normalizeColorAdjustFields xoá `\\` (cố ý, chống chèn filter lạ) -> trên Windows
     * `E\\:/…` thành `E:/…` và filtergraph vỡ ở `:`. */
    const cubeText = fs.readFileSync(lut, 'utf8');
    const adj = [ColorAdjust.LUT3D_SLOT, 'eq=contrast=1.234226:brightness=-0.062887:saturation=1.29'];
    const seq = { width: W, height: H, preset: 'custom', source_width: W, source_height: H, source_fps: '30' };

    const { start } = require(path.join(PROJECT_ROOT, 'backend', 'server.js'));
    const port = Number(process.env.BACKEND_PORT);
    const server = start();
    await new Promise((r) => setTimeout(r, 300));
    const steps = {};
    try {
        for (const feather of [0, 6]) {
            const form = new FormData();
            form.append('timeline_json', JSON.stringify([{ start: 0, end: 1, text: 't', script_index: 0,
                transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 },
                color_adjust: { filters: adj, cube: cubeText } }]));
            form.append('editing_json', JSON.stringify({
                tracks: [{ id: 'track_main', type: 'main', order: 0, visible: true }],
                items: [{ id: 'retouch_0', type: 'text', track_id: 'track_main', timeline_start: 0, duration: 1,
                    source_start: 0, feather_px: feather,
                    transform: { position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100 },
                    rendered_text_png: TRANSPARENT_1PX,
                    rendered_text_width: 1, rendered_text_height: 1,
                    animation_render: { fps: 30, color_source: 'raw',
                        seq: { start: 0, duration: 1, width: PW, height: PH, frame_count: 2, frames: [frame, frame] } },
                    color_adjust: { filters: adj, cube: cubeText } }],
                assets: [],
            }));
            form.append('export_settings', JSON.stringify({ resolution: 'sequence', sequence: seq,
                fps: '30', codec: 'prores', quality: 'high', audio_bitrate: '192k' }));
            form.append('sequence_settings', JSON.stringify(seq));
            const res = await fetch('http://127.0.0.1:' + port + '/api/export-video', { method: 'POST', body: form });
            if (!res.ok) throw new Error(await res.text());
            await res.arrayBuffer();
            const outMov = path.join(tmp, 'final_cut.mov');
            const file = fs.existsSync(outMov) ? outMov : path.join(tmp, 'final_cut.mp4');
            const r = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-ss', '0.3', '-i', file,
                '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
                { encoding: 'buffer', maxBuffer: 1e8 });
            assert.strictEqual(r.status, 0, r.stderr && r.stderr.toString('utf8'));
            const row = [];
            for (let x = 0; x < W; x++) row.push(r.stdout[((H / 2) * W + x) * 3]);
            const x0 = (W - PW) / 2;
            steps[feather] = Math.max(...[0, 1, 2, 3].map((k) => Math.abs(row[x0 + k] - row[x0 - 1 - k])));
        }
    } finally {
        await new Promise((r) => server.close(r));
        // Chỉ dọn file của MÌNH — thư mục tạm này dùng chung với các mục test khác.
        for (const name of ['temp_input.mp4', 'patch.png', 'final_cut.mov', 'final_cut.mp4', 'export_timeline.json']) {
            fs.rmSync(path.join(tmp, name), { force: true });
        }
    }
    /* CHỐT ĐỘ NHẠY: mép cứng phải còn LỘ bậc nhảy, nếu không thì hai phép kiểm dưới
     * thành vô nghĩa (0 <= 1 luôn đúng). Ngưỡng là 1 chứ không phải 2: chênh lệch
     * fixture là 2/255 nhưng nó phải đi qua prores 10-bit + lut3d + eq + vòng về
     * rgb24, và LÀM TRÒN của từng bản ffmpeg khác nhau — bản Windows đo được 1/255
     * (mép mềm 0/255) trong khi bản macOS đo 2/255. Nâng chênh lệch fixture lên KHÔNG
     * cứu được: đo thử với 16/255 thì mép mềm còn 7/255, tức phải chỉnh luôn cả ngưỡng
     * `steps[6] <= 1` — hai hằng số này gắn với nhau. Giữ fixture, hạ ĐÚNG chốt này:
     * cặp `steps[6] < steps[0]` + `steps[6] <= 1` vẫn buộc mép mềm về 0. */
    assert.ok(steps[0] >= 1, 'mép CỨNG lẽ ra phải lộ bậc nhảy (đo ' + steps[0] + '/255) — test mất khả năng phát hiện');
    assert.ok(steps[6] < steps[0], 'mép mềm không làm giảm bậc nhảy (' + steps[0] + ' -> ' + steps[6] + ')');
    assert.ok(steps[6] <= 1, 'mép mềm vẫn còn bậc nhảy ' + steps[6] + '/255 tại mép miếng vá');
    console.log('  ok  mép miếng vá: bậc nhảy ' + steps[0] + '/255 (mép cứng) -> ' + steps[6] + '/255 (mép mềm)');
}

function testFeatherSurvivesPayload() {
    const { normalizeEditingPayload } = require(path.join(PROJECT_ROOT, 'backend', 'server.js'));
    const build = (item) => normalizeEditingPayload({ version: 5,
        tracks: [{ id: 'track_main', type: 'main', order: 0, visible: true }],
        items: [item], assets: [] }, 10, 30).overlays.find((o) => o.asset_type === 'image_seq');
    const patched = seqItem('retouch_0', 'raw');
    patched.feather_px = 18;
    assert.strictEqual(build(patched).feather_px, 18, 'feather_px của miếng vá không tới được sidecar');
    assert.strictEqual(build(seqItem('trans_0', null)).feather_px, 0,
        'overlay thường không được tự mọc mép mềm');
    console.log('  ok  feather_px đi qua payload và chỉ áp cho miếng vá');
}

function main() {
    console.log('retouch export: miếng vá phủ hết phần bị đổi');
    testPatchCoversEveryChangedPixel();
    testPatchIsNotWastefullyLarge();
    console.log('retouch export: hợp đồng payload với backend');
    testColorSourceGate();
    testRetouchItemSurvivesPayload();
    testStillImageSeqGetsColor();
    testOverlayPatchStacking();
    return (async () => {
        console.log('retouch export: nguồn landmark');
        testRetouchSourceKinds();
        await testTrackSourceGuard();
        console.log('retouch export: mép miếng vá');
        testFeatherSurvivesPayload();
        await testPatchEdgeIsFeathered();
        console.log('retouch export pipeline ok');
    })();
}

main().catch((error) => { console.error(error); process.exit(1); });
