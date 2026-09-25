/* =====================================================================
 * HÌNH HỌC BLOCK LANE CHÍNH: VÙNG ẢNH THẬT + "SCALE 100% = VỪA KHUNG"
 *
 * BỐI CẢNH. Lane chính chạy trên MỘT file đã nối (temp_input.mp4) mà khung của nó là KHUNG
 * BAO của mọi nguồn — nguồn khác khổ được đặt giữa khung, phần còn lại là viền đen NẰM
 * TRONG khung hình. Từ 2026-09-09, ba phía phải đồng ý với nhau về hai con số:
 *   - `content` : hình chữ nhật ảnh THẬT trong khung nối (backend khai ra ở bảng đoạn);
 *   - `fit`     : hệ số vừa-khung ở scale 100% (CapCut: clip khác khổ thì thấy TRỌN ảnh).
 * Ba phía đó là: file nối (backend), sprite preview (index.html), filtergraph export
 * (backend -> sidecar).
 *
 * VÌ SAO PHẢI CÓ TEST NÀY. Lệch hình học ở đây KHÔNG có lỗi nào báo: app vẫn chạy, chỉ là
 * bản xuất ra khác hình đang xem, hoặc bấm LQ/HQ là hình đổi cỡ. Đúng loại lỗi mà dự án này
 * đã trả giá nhiều lần. Test khoá lại 4 hợp đồng:
 *   1. số học thuần của MainLane (khung bao / vùng ảnh / hệ số vừa khung);
 *   2. preview và export dùng CÙNG một hệ số (cùng đi qua MainLane.fitScale);
 *   3. LQ và HQ vẽ ra CÙNG một khung hình (proxy nhỏ hơn nguồn);
 *   4. dự án mà mọi nguồn cùng khổ sequence -> hệ số = 1, tức KHÔNG đổi gì so với bản trước.
 *
 * Node không có layout engine nên test không dựng lại phép đo pixel — nó bóc chính các hàm
 * trong index.html ra rồi chạy với số liệu dựng sẵn (cùng lối mà preview_overlay_offset.js
 * đang dùng). Phần pixel thật do tests/scripts/mixed_orientation_export.js đo.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const MainLane = require(path.join(projectRoot, 'static', 'js', 'main-lane.js'));
const htmlSource = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
const serverSource = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');
const sidecarSource = fs.readFileSync(path.join(projectRoot, 'native', 'sidecar', 'core_process.cpp'), 'utf8');

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

/* Bốn hàm hình học của index.html, chạy với bảng đoạn + khổ khung + khổ sequence dựng sẵn.
 * Bóc nguyên văn từ file thật: sửa công thức trong app mà không sửa ở đây thì test đổ. */
const GEOMETRY_FNS = [
    'mainConcatFrameSize',
    'mainClipSegmentFor',
    'mainClipContentRect',
    'mainClipFitScale',
    'mainClipBaseSize',
    'mainDisplayScale',
];

function makeGeometry({ frame, segments, sequence }) {
    const body = [
        'let mainConcatFrame = FRAME;',
        'let mainConcatSegments = SEGMENTS;',
        'function getSequencePayload() { return PAYLOAD; }',
        ...GEOMETRY_FNS.map((name) => extractFunction(htmlSource, name)),
        `return { ${GEOMETRY_FNS.join(', ')} };`,
    ].join('\n');
    const factory = new Function('window', 'MainLane', 'FRAME', 'SEGMENTS', 'PAYLOAD', body);
    return factory({ MainLane }, MainLane, frame, segments, sequence);
}

// Bảng đoạn của một dự án DỌC + NGANG: khung bao 1920×1920, sequence dọc 1080×1920.
function mixedProject() {
    const frame = MainLane.concatFrameSize([
        { width: 1080, height: 1920 },
        { width: 1920, height: 1080 },
    ]);
    const segments = [
        {
            source_path: 'a.mp4', start: 0, end: 10, duration: 10,
            source_width: 1080, source_height: 1920,
            content: MainLane.contentRectIn(frame, 1080, 1920),
        },
        {
            source_path: 'b.mp4', start: 10, end: 15, duration: 5,
            source_width: 1920, source_height: 1080,
            content: MainLane.contentRectIn(frame, 1920, 1080),
        },
    ];
    const sequence = { width: 1080, height: 1920, source_width: 1080, source_height: 1920 };
    return { frame, segments, sequence, geo: makeGeometry({ frame, segments, sequence }) };
}

// ---- 1. SỐ HỌC THUẦN ----
{
    // Khung bao: max từng cạnh, KHÔNG phải khổ nguồn đầu tiên (bản trước lấy nguồn đầu và
    // vì thế nén clip ngang 1920×1080 còn 1080×607 — mất 68% pixel, vĩnh viễn).
    assert.deepStrictEqual(
        MainLane.concatFrameSize([{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }]),
        { width: 1920, height: 1920 },
    );
    // Mọi nguồn cùng khổ -> khung bao ĐÚNG BẰNG khổ đó (không phình khung, không đổi gì).
    assert.deepStrictEqual(
        MainLane.concatFrameSize([{ width: 1080, height: 1920 }, { width: 1080, height: 1920 }]),
        { width: 1080, height: 1920 },
    );
    // Cạnh lẻ -> làm chẵn XUỐNG (yuv420p không nhận cạnh lẻ; làm tròn LÊN là phải phóng ảnh).
    assert.deepStrictEqual(
        MainLane.concatFrameSize([{ width: 1081, height: 1921 }]),
        { width: 1080, height: 1920 },
    );
    assert.strictEqual(MainLane.concatFrameSize([]), null, 'không có nguồn nào đo được -> null');

    const frame = { width: 1920, height: 1920 };
    // Vùng ảnh đặt GIỮA, và KHÔNG bị thu nhỏ: số pixel giữ nguyên bằng nguồn.
    assert.deepStrictEqual(MainLane.contentRectIn(frame, 1080, 1920), { x: 420, y: 0, width: 1080, height: 1920 });
    assert.deepStrictEqual(MainLane.contentRectIn(frame, 1920, 1080), { x: 0, y: 420, width: 1920, height: 1080 });
    // Lề luôn CHẴN: `pad` với lề lẻ đẩy kênh màu lệch nửa khối 2×2 của yuv420p.
    for (const [w, h] of [[1078, 1918], [1000, 1000], [1234, 566]]) {
        const rect = MainLane.contentRectIn(frame, w, h);
        assert.strictEqual(rect.x % 2, 0, `lề x phải chẵn (nguồn ${w}×${h})`);
        assert.strictEqual(rect.y % 2, 0, `lề y phải chẵn (nguồn ${w}×${h})`);
    }
    /* NGUỒN VỪA KHÍT KHUNG -> không có viền, kể cả cạnh LẺ. Ca này là đường phổ biến nhất:
     * mọi nguồn cùng khổ thì bước chuẩn hoá bị BỎ QUA hẳn nên khung nối chính là khổ nguồn,
     * chưa qua `scale`/`pad` nào. Không chốt thì nguồn 1081×1920 bị khai vùng ảnh 1080 rộng
     * trong khung 1081 — lệch 1 pixel ở MỌI khâu phía sau. */
    assert.deepStrictEqual(
        MainLane.contentRectIn({ width: 1081, height: 1920 }, 1081, 1920),
        { x: 0, y: 0, width: 1081, height: 1920 },
    );
    /* Nguồn KHÔNG lọt khung -> thu vừa khung, tuyệt đối không phóng lên. (Với khung BAO thì
     * ca này không xảy ra; hàm vẫn phải đúng cho khung do nơi khác đưa vào.)
     * 1920×1080 vào khung 1080×1080: hệ số 0.5625 -> 1080×607.5, làm chẵn thành 608. Lệch
     * nửa pixel là giới hạn của cạnh chẵn (yuv420p), tỉ lệ sai 0.08% — không nhìn ra được. */
    const shrunk = MainLane.contentRectIn({ width: 1080, height: 1080 }, 1920, 1080);
    assert.deepStrictEqual(shrunk, { x: 0, y: 236, width: 1080, height: 608 });
    assert.ok(shrunk.y + shrunk.height <= 1080, 'vùng ảnh phải nằm TRỌN trong khung');

    // Hệ số vừa khung + cỡ gốc trên canvas.
    assert.strictEqual(MainLane.fitScale({ width: 1920, height: 1080 }, 1080, 1920), 0.5625);
    assert.strictEqual(MainLane.fitScale({ width: 1080, height: 1920 }, 1080, 1920), 1);
    assert.deepStrictEqual(
        MainLane.clipBaseSize({ width: 1920, height: 1080 }, 1080, 1920),
        { width: 1080, height: 607.5 },
    );
    // Dữ liệu thiếu -> 1 (không nhân gì), để nơi gọi không phải xử lý ca riêng.
    assert.strictEqual(MainLane.fitScale(null, 1080, 1920), 1);
    assert.strictEqual(MainLane.fitScale({ width: 100, height: 100 }, 0, 0), 1);
    console.log('  ok  số học khung bao / vùng ảnh / hệ số vừa khung');
}

// ---- 2. PREVIEW ĐỌC ĐÚNG BẢNG ĐOẠN, VÀ KHỚP HỆ SỐ CỦA EXPORT ----
{
    const { frame, segments, sequence, geo } = mixedProject();
    assert.deepStrictEqual(geo.mainConcatFrameSize(), frame);

    // Block do người dùng CẮT BẰNG DAO vẫn nằm trong đoạn của nguồn nó thuộc về -> vẫn tra
    // ra đúng vùng ảnh. Đây là lý do dò theo VỊ TRÍ chứ không theo source_path của row.
    const portraitClip = { start: 3, end: 6 };
    const landscapeClip = { start: 11, end: 13 };
    assert.deepStrictEqual(geo.mainClipContentRect(portraitClip), segments[0].content);
    assert.deepStrictEqual(geo.mainClipContentRect(landscapeClip), segments[1].content);

    // Hệ số của preview phải TRÙNG con số mà export tính (cùng hàm MainLane.fitScale).
    [[portraitClip, segments[0]], [landscapeClip, segments[1]]].forEach(([clip, seg]) => {
        assert.strictEqual(
            geo.mainClipFitScale(clip),
            MainLane.fitScale(seg.content, sequence.width, sequence.height),
            'preview và export phải dùng CÙNG hệ số vừa khung',
        );
    });

    // Cỡ ảnh trên canvas ở 100%: clip dọc phủ trọn khung, clip ngang letterbox.
    assert.deepStrictEqual(geo.mainClipBaseSize(portraitClip), { width: 1080, height: 1920 });
    assert.deepStrictEqual(geo.mainClipBaseSize(landscapeClip), { width: 1080, height: 607.5 });

    // Không có bảng đoạn (dự án cũ / luồng bóc băng) -> coi cả khung là ảnh, không ném lỗi.
    const bare = makeGeometry({ frame: { width: 0, height: 0 }, segments: [], sequence });
    assert.deepStrictEqual(bare.mainClipContentRect(portraitClip),
        { x: 0, y: 0, width: sequence.source_width, height: sequence.source_height });
    assert.strictEqual(bare.mainClipFitScale(portraitClip), 1);
    console.log('  ok  preview tra đúng vùng ảnh (kể cả block đã cắt) và khớp hệ số của export');
}

// ---- 3. LQ VÀ HQ PHẢI VẼ RA CÙNG MỘT KHUNG HÌNH ----
{
    const { frame, segments, sequence, geo } = mixedProject();
    // Khung xem trước 270×480 -> previewScale = 0.25 pixel-preview trên mỗi pixel-sequence.
    const previewScale = Math.min(270 / sequence.width, 480 / sequence.height);
    // Proxy LQ: sidecar hạ chiều cao về 720 (xem CommandPreviewProxy) -> 720×720 cho khung vuông.
    const cases = [
        { label: 'HQ (nguồn)', texW: frame.width, texH: frame.height },
        { label: 'LQ (proxy 720)', texW: 720, texH: 720 },
    ];
    [{ start: 3, end: 6 }, { start: 11, end: 13 }].forEach((clip) => {
        const drawn = cases.map(({ texW, texH }) => {
            const s = geo.mainDisplayScale(clip, texW, texH, previewScale);
            return { width: texW * s, height: texH * s };
        });
        assert.ok(Math.abs(drawn[0].width - drawn[1].width) < 1e-9
            && Math.abs(drawn[0].height - drawn[1].height) < 1e-9,
            `LQ và HQ phải vẽ cùng cỡ: ${JSON.stringify(drawn)} (clip ${clip.start}s)`);
        // Và cỡ đó đúng bằng "khung nối × hệ số vừa khung × previewScale".
        const want = frame.width * geo.mainClipFitScale(clip) * previewScale;
        assert.ok(Math.abs(drawn[0].width - want) < 1e-9,
            `cỡ vẽ phải là khung nối × fit × previewScale: ${drawn[0].width} vs ${want}`);
    });
    console.log('  ok  LQ và HQ vẽ ra cùng một khung hình');
}

// ---- 4. DỰ ÁN CÙNG KHỔ: KHÔNG ĐỔI GÌ SO VỚI BẢN TRƯỚC ----
{
    // Đây là đa số dự án thật. Hệ số = 1 và vùng ảnh = cả khung, nên mọi công thức rút về
    // đúng bản trước 2026-09-09 (vẽ khung nối theo đúng số pixel của nó trên canvas).
    const frame = MainLane.concatFrameSize([{ width: 1080, height: 1920 }, { width: 1080, height: 1920 }]);
    const segments = [0, 1].map((i) => ({
        source_path: `s${i}.mp4`, start: i * 10, end: (i + 1) * 10, duration: 10,
        source_width: 1080, source_height: 1920,
        content: MainLane.contentRectIn(frame, 1080, 1920),
    }));
    const sequence = { width: 1080, height: 1920, source_width: 1080, source_height: 1920 };
    const geo = makeGeometry({ frame, segments, sequence });
    [{ start: 1, end: 5 }, { start: 12, end: 18 }].forEach((clip) => {
        assert.strictEqual(geo.mainClipFitScale(clip), 1);
        assert.deepStrictEqual(geo.mainClipContentRect(clip), { x: 0, y: 0, width: 1080, height: 1920 });
        assert.deepStrictEqual(geo.mainClipBaseSize(clip), { width: 1080, height: 1920 });
    });
    console.log('  ok  dự án cùng khổ: hệ số = 1, hình học y như bản trước');
}

/* ---- 5. HỢP ĐỒNG GIỮA BACKEND VÀ SIDECAR ----
 * Ba điều dưới đây không đo được bằng số ở Node (một bên là C++, một bên cần cả một lượt
 * export), nhưng chúng đúng là những chỗ mà một lần "dọn dẹp" sau này rất dễ làm hỏng. */
{
    // Backend phải tính hệ số bằng CHÍNH MainLane.fitScale — không được chép công thức.
    assert.ok(/MainLane\.fitScale\(/.test(serverSource),
        'backend phải gọi MainLane.fitScale (chép lại công thức là hai phía sớm muộn lệch nhau)');
    assert.ok(/MainLane\.contentRectIn\(/.test(serverSource),
        'backend phải gọi MainLane.contentRectIn cho CẢ filter pad LẪN bảng đoạn');
    assert.ok(/fit_scale: fitScale/.test(serverSource),
        'payload gửi sidecar phải mang fit_scale');

    /* Sidecar phải nhân hệ số vào CẢ hai nhánh scale. Bỏ sót nhánh keyframe là clip có
     * keyframe scale nhảy cỡ ngay khung đầu — và chỉ lộ ra ở bản xuất. */
    assert.ok(/\(item\.scale \/ 100\.0\) \* fitScale/.test(sidecarSource),
        'sidecar: nhánh TĨNH phải nhân fitScale');
    assert.ok(/staticScale \/ 100\.0\) \* fit\)/.test(sidecarSource),
        'sidecar: nhánh keyframe phải nhân fit vào giá trị tĩnh');
    assert.ok(/\)\/100\*" \+ FfmpegDouble\(fit\)/.test(sidecarSource),
        'sidecar: nhánh keyframe phải nhân fit vào BIỂU THỨC keyframe');
    console.log('  ok  hợp đồng backend <-> sidecar còn nguyên');
}

/* ---- 6. ĐƯỜNG VẼ CANVAS 2D (bake Retouch, bake chuyển cảnh lane chính) ----
 * Mọi khung dựng bằng canvas của lane chính đi qua drawMainClipLayer: cỡ vẽ lấy từ
 * mainLaneFrameDrawSize (khung nối × hệ số vừa khung), phép đặt lấy từ mainClipPlacement
 * (scale %, vị trí, xoay). Hệ số vừa khung phải được nhân ĐÚNG MỘT LẦN:
 *   - thiếu -> nguồn 1728x3072 trên sequence 1080x1920 vẽ to 1.6 lần: miếng vá Retouch hiện
 *     thành ô mặt PHÓNG TO (lỗi người dùng báo ở nhánh macOS 2026-09-25, nhánh đó vẽ theo cỡ
 *     texture nên sửa bằng cách nhân fit trong mainClipPlacement — commit aa127e6);
 *   - thừa -> ô mặt THU NHỎ còn 0.625 lần. Đo thật 2026-09-26 trên nhánh này (nguồn gradient
 *     toạ độ 1728x3072, sequence 1080x1920): mã hiện tại cho miếng vá hệ số x0.997/y1.004,
 *     |vá − nền| TB 0.88/255; tạm áp nguyên hunk của aa127e6 thì hệ số x0.71/y0.62,
 *     |vá − nền| TB 37.6, max 117.
 * Chạy CHÍNH các hàm của editing-runtime.js + index.html với ca đó, đòi cỡ trên canvas trùng
 * công thức của sidecar (khung × fit × scale). */
{
    const runtimeSource = fs.readFileSync(path.join(projectRoot, 'static', 'js', 'editing-runtime.js'), 'utf8');
    const makeCanvasPath = (geo) => new Function('mainConcatFrameSize', 'mainClipFitScale', `
        const window = {};
        const normalizeTransform = (t) => ({ position_x: 0, position_y: 0, scale: 100, rotation: 0, opacity: 100, ...(t || {}) });
        ${extractFunction(runtimeSource, 'mainLaneFrameDrawSize')}
        ${extractFunction(runtimeSource, 'layerPlacement')}
        ${extractFunction(runtimeSource, 'mainClipPlacement')}
        return { mainLaneFrameDrawSize, mainClipPlacement };
    `)(geo.mainConcatFrameSize, geo.mainClipFitScale);

    const onCanvas = ({ frame, sequence }) => {
        const segments = [{
            source_path: 'a.mp4', start: 0, end: 10, duration: 10,
            source_width: frame.width, source_height: frame.height,
            content: MainLane.contentRectIn(frame, frame.width, frame.height),
        }];
        const geo = makeGeometry({ frame, segments, sequence });
        const rt = makeCanvasPath(geo);
        const clip = { start: 2, end: 6, transform: { scale: 80 } };
        const draw = rt.mainLaneFrameDrawSize(clip);
        const place = rt.mainClipPlacement({ clip, duration: 4 }, 0,
            sequence.width, sequence.height, geo.mainClipBaseSize(clip).height);
        return {
            fit: geo.mainClipFitScale(clip),
            sx: place.sx,
            width: draw.width * place.sx,
            height: draw.height * place.sy,
        };
    };

    const tall = onCanvas({
        frame: { width: 1728, height: 3072 },
        sequence: { width: 1080, height: 1920, source_width: 1728, source_height: 3072 },
    });
    assert.strictEqual(tall.fit, 0.625);
    assert.ok(Math.abs(tall.width - 1728 * 0.625 * 0.8) < 1e-9 && Math.abs(tall.height - 3072 * 0.625 * 0.8) < 1e-9,
        `cỡ vẽ canvas phải là khung × fit × scale = 864x1536 (được ${tall.width}x${tall.height})`);
    assert.strictEqual(tall.sx, 0.8,
        'mainClipPlacement KHÔNG được nhân fit ở nhánh này — mainLaneFrameDrawSize đã nhân rồi. '
        + 'Hunk tương ứng của nhánh macOS (aa127e6) bê sang là nhân HAI lần: miếng vá Retouch thu còn 0.625 lần');

    const same = onCanvas({
        frame: { width: 1080, height: 1920 },
        sequence: { width: 1080, height: 1920, source_width: 1080, source_height: 1920 },
    });
    assert.deepStrictEqual([same.fit, same.width, same.height], [1, 864, 1536], 'cùng khổ (fit = 1) -> y như trước');

    // Hộp cắt miếng vá và hình vẽ phải dùng CÙNG cỡ lớp, không thì miếng vá cắt lệch chỗ.
    assert.ok(/mainLaneFrameDrawSize\(clip\)/.test(extractFunction(runtimeSource, 'drawMainClipLayer')),
        'drawMainClipLayer phải lấy cỡ vẽ từ mainLaneFrameDrawSize');
    assert.ok(/mainLaneFrameDrawSize\(clip\)/.test(extractFunction(runtimeSource, 'bakeRetouchSequence')),
        'hộp vá Retouch phải tính trên cùng cỡ lớp mainLaneFrameDrawSize');
    console.log('  ok  đường vẽ canvas (Retouch, chuyển cảnh) nhân hệ số vừa khung đúng một lần');
}

console.log('main lane fit geometry ok');
