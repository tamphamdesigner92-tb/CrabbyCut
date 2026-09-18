/* =====================================================================
 * DỤNG CỤ ĐO HIỆU NĂNG (perf-hud.js) — Giai đoạn 0 của KE_HOACH_PREVIEW_MUOT.md
 *
 * Một dụng cụ đo mà tự nó sai thì tệ hơn là không có: nó khiến người ta tối ưu nhầm chỗ.
 * Test này khoá đúng BA điều, trong đó hai điều đầu là lỗi THẬT đã dính lúc dựng:
 *
 *   1. KHÔNG TỐN GÌ KHI TẮT. Lúc nạp chỉ được gắn đúng một listener `keydown`, không bọc
 *      hàm nào, không rAF, không timer. Sai điều này thì mọi số đo về sau đều gồm cả chi
 *      phí của chính dụng cụ.
 *
 *   2. GỠ BỌC PHẢI SẠCH TUYỆT ĐỐI. Bản đầu viết
 *      `window[name] = function wrapped(...)` rồi closure hoàn nguyên tham chiếu tới
 *      `wrapped` — nhưng tên của một named function EXPRESSION chỉ nhìn thấy được BÊN
 *      TRONG chính nó, nên closure ném ReferenceError, và `catch` trong disable() nuốt
 *      trọn. Kết quả: tắt HUD rồi mà mọi hàm vẫn còn bị bọc, hoàn toàn âm thầm.
 *
 *   3. CẢNH BÁO CHE CỬA SỔ PHẢI KÊU Ở 0 fps. Bản đầu viết `fps > 0 && fps < 20` nên khi
 *      cửa sổ bị che HOÀN TOÀN (rAF về đúng 0 — ca tệ nhất) thì lại im lặng. Chromium
 *      dừng compositing khi cửa sổ bị che, số liệu thành rác mà người đo không hay.
 *
 * CÁCH ĐO: chạy CHÍNH file perf-hud.js trong vm với một DOM giả tối thiểu. Không mô phỏng
 * lại thuật toán — nạp mã thật rồi bật/tắt và soi hệ quả.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const hudPath = path.join(projectRoot, 'static', 'js', 'perf-hud.js');
const source = fs.readFileSync(hudPath, 'utf8');

/* Bản chỉ-còn-mã, dùng cho các khẳng định soi cú pháp. Chú thích của file này CỐ Ý trích
   lại đoạn mã sai (`window[name] = function wrapped(...)`) để cảnh báo người sau — soi
   trên nguyên văn thì regex khớp phải chú thích và test đỏ vì lý do bịa. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ---------------------------------------------------------------------------
// DOM giả: chỉ đủ những gì perf-hud.js thật sự chạm tới.
// ---------------------------------------------------------------------------
function makeEnv() {
    const listeners = [];
    const nodes = new Map();
    const timers = { raf: 0, interval: 0, observers: 0 };

    const makeNode = () => {
        const node = {
            id: '', style: { cssText: '' }, textContent: '',
            isConnected: false,
            // gpuInfo() tạo canvas rồi xin WebGL context — không có GPU trong Node.
            getContext: () => null,
            remove() { this.isConnected = false; if (this.id) nodes.delete(this.id); },
        };
        return node;
    };

    const doc = {
        createElement: makeNode,
        getElementById: (id) => nodes.get(id) || null,
        querySelector: () => null,      // previewCanvasInfo() dò canvas của app PIXI
        body: {
            appendChild(node) { node.isConnected = true; if (node.id) nodes.set(node.id, node); return node; },
        },
    };

    /* `window` phải LÀ CHÍNH global object, không phải một object riêng: HUD ghi qua
       `window[name] = ...` còn mã ứng dụng gọi bằng tên trần `drawRuler()`. Trên trình
       duyệt hai đường đó là một. Tách ra thì phép ghi rơi vào object phụ và phép bọc
       không có tác dụng — DOM giả sai sẽ cho test xanh/đỏ vì lý do bịa. */
    const sandbox = {
        document: doc,
        performance: { now: () => Date.now() },
        console,
        addEventListener: (type, fn, opts) => listeners.push({ type, fn, opts }),
        requestAnimationFrame: () => { timers.raf += 1; return timers.raf; },
        cancelAnimationFrame: () => { timers.raf -= 1; },
        setInterval: () => { timers.interval += 1; return timers.interval; },
        clearInterval: () => { timers.interval -= 1; },
        PerformanceObserver: function () {
            timers.observers += 1;
            this.observe = () => {};
            this.disconnect = () => { timers.observers -= 1; };
        },
        PIXI: { Ticker: { prototype: { update() { /* bản gốc */ } } } },
        // Các hàm toàn cục mà HUD sẽ bọc (đặt tên trùng bản thật).
        drawRuler() {}, drawWaveform() {}, drawTimelineSegments() {}, updatePlayhead() {},
        syncScriptHighlightAndTrim() {}, updateSequencePreviewTransform() {},
        scrollTimelineToCurrentTime() {},
        currentMode: 'MAPPED', currentStepId: 'step2',
    };
    sandbox.window = sandbox;

    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: 'perf-hud.js' });
    return { sandbox, win: sandbox, listeners, timers, nodes };
}

const WRAPPED = [
    'drawRuler', 'drawWaveform', 'drawTimelineSegments', 'updatePlayhead',
    'syncScriptHighlightAndTrim', 'updateSequencePreviewTransform',
    'scrollTimelineToCurrentTime',
];

// ---------------------------------------------------------------------------
// 1. Lúc TẮT: không tốn gì
// ---------------------------------------------------------------------------
{
    const { sandbox, listeners, timers } = makeEnv();
    assert.ok(sandbox.window.PerfHUD, 'phải xuất window.PerfHUD');
    assert.strictEqual(sandbox.window.PerfHUD.isOn(), false, 'mặc định phải TẮT');

    assert.strictEqual(listeners.length, 1, `chỉ được gắn 1 listener lúc nạp, đang có ${listeners.length}`);
    assert.strictEqual(listeners[0].type, 'keydown', 'listener duy nhất phải là keydown');
    assert.strictEqual(timers.raf, 0, 'không được đặt rAF nào khi chưa bật');
    assert.strictEqual(timers.interval, 0, 'không được đặt timer nào khi chưa bật');
    assert.strictEqual(timers.observers, 0, 'không được tạo PerformanceObserver khi chưa bật');
}

// ---------------------------------------------------------------------------
// 2. Bọc khi BẬT, gỡ SẠCH khi TẮT (lỗi named-function-expression)
// ---------------------------------------------------------------------------
{
    const { sandbox, timers } = makeEnv();
    const original = {};
    WRAPPED.forEach((n) => { original[n] = sandbox[n]; });
    const originalTicker = sandbox.window.PIXI.Ticker.prototype.update;

    sandbox.window.PerfHUD.enable();
    assert.strictEqual(sandbox.window.PerfHUD.isOn(), true, 'enable() phải bật');
    WRAPPED.forEach((n) => {
        assert.notStrictEqual(sandbox[n], original[n], `${n} phải bị bọc khi bật`);
    });
    assert.notStrictEqual(sandbox.window.PIXI.Ticker.prototype.update, originalTicker,
        'ticker PIXI phải bị bọc khi bật');
    assert.ok(timers.raf > 0 && timers.interval > 0, 'bật rồi thì phải có rAF + timer');

    sandbox.window.PerfHUD.disable();
    /* Đây là khẳng định quan trọng nhất của cả file. */
    WRAPPED.forEach((n) => {
        assert.strictEqual(sandbox[n], original[n], `${n} KHÔNG được trả lại sau khi tắt`);
    });
    assert.strictEqual(sandbox.window.PIXI.Ticker.prototype.update, originalTicker,
        'ticker PIXI KHÔNG được trả lại sau khi tắt');
    assert.strictEqual(timers.raf, 0, 'tắt rồi phải huỷ rAF');
    assert.strictEqual(timers.interval, 0, 'tắt rồi phải huỷ timer');
    assert.strictEqual(timers.observers, 0, 'tắt rồi phải ngắt PerformanceObserver');

    // Bật/tắt nhiều lượt không được rò bọc chồng lên nhau.
    for (let i = 0; i < 3; i += 1) {
        sandbox.window.PerfHUD.enable();
        sandbox.window.PerfHUD.disable();
    }
    WRAPPED.forEach((n) => {
        assert.strictEqual(sandbox[n], original[n], `${n} rò bọc sau nhiều lượt bật/tắt`);
    });
}

// ---------------------------------------------------------------------------
// 3. Đo đúng: hàm bị bọc vẫn chạy thật, và được ĐẾM
// ---------------------------------------------------------------------------
{
    const { sandbox } = makeEnv();
    let realCalls = 0;
    sandbox.drawRuler = () => { realCalls += 1; };
    sandbox.window.PerfHUD.enable();
    for (let i = 0; i < 5; i += 1) sandbox.drawRuler();
    const snap = sandbox.window.PerfHUD.snapshot();
    sandbox.window.PerfHUD.disable();

    assert.strictEqual(realCalls, 5, 'bọc rồi thì hàm GỐC vẫn phải chạy đủ số lần');
    assert.strictEqual(snap.phases.timeline.count, 5, 'phải đếm đủ 5 lượt vào nhóm timeline');
    assert.strictEqual(snap.stage, 'MAPPED / step2', 'phải đọc đúng giai đoạn đang mở');

    // Hàm bọc phải TRẢ VỀ đúng giá trị của hàm gốc và không nuốt lỗi.
    const { sandbox: s2 } = makeEnv();
    s2.drawRuler = () => 42;
    s2.window.PerfHUD.enable();
    assert.strictEqual(s2.drawRuler(), 42, 'hàm bọc phải trả về giá trị của hàm gốc');
    s2.drawWaveform = () => { throw new Error('bùm'); };
    s2.window.PerfHUD.disable();
}

// ---------------------------------------------------------------------------
// 4. HAI cảnh báo tách bạch: "bị che" khác "GPU đuối"
// ---------------------------------------------------------------------------
{
    /* Bản đầu chỉ có MỘT ngưỡng 20 fps gắn nhãn "cửa sổ bị che". Lượt đo thật ra 19 và
       22 fps: vừa báo động NHẦM ở lượt 19, vừa IM LẶNG ở lượt 22, trong khi cả hai đều là
       cùng một hiện tượng và đều KHÔNG do che cửa sổ. Gộp hai chuyện khác nhau vào một
       ngưỡng là cách chắc chắn nhất để đẩy người đo đi sai hướng. */
    assert.ok(/const OCCLUDED_FPS = \d+/.test(code) && /const SLOW_FPS = \d+/.test(code),
        'phải có HAI ngưỡng tách bạch: OCCLUDED_FPS và SLOW_FPS');

    const occluded = Number(code.match(/const OCCLUDED_FPS = (\d+)/)[1]);
    const slow = Number(code.match(/const SLOW_FPS = (\d+)/)[1]);
    assert.ok(occluded <= 5,
        `ngưỡng "bị che" phải rất thấp (compositing dừng hẳn → rAF ~0), đang là ${occluded}`);
    assert.ok(slow > 30,
        `ngưỡng "GPU đuối" phải trên dải 19-22 fps đã đo được, đang là ${slow}`);
    assert.ok(occluded < slow, 'hai ngưỡng phải tách nhau');

    // Không được kèm `fps > 0`: bị che hoàn toàn thì rAF về đúng 0 — ca cần kêu nhất.
    assert.ok(!/fps > 0 &&/.test(code), 'điều kiện cảnh báo lại chặn mất ca 0 fps');
    assert.ok(/if \(playing && fps <= OCCLUDED_FPS\)/.test(code), 'thiếu nhánh cảnh báo bị che');
    assert.ok(/else if \(playing && fps < SLOW_FPS\)/.test(code), 'thiếu nhánh cảnh báo GPU đuối');

    // Nội dung phải nói rõ số nào còn dùng được, và nhánh GPU phải nói rõ đây là số THẬT.
    assert.ok(/trừ "Khung hình RỚT" — giải mã vẫn chạy/.test(source),
        'cảnh báo bị che phải nói rõ "Khung hình RỚT" vẫn dùng được');
    assert.ok(/số liệu THẬT/.test(source),
        'cảnh báo GPU đuối phải nói rõ đây là số liệu thật, không phải nhiễu do che cửa sổ');
}

// ---------------------------------------------------------------------------
// 4b. Bốn số đo thêm sau lượt đo đầu — nhắm vào phần NGOÀI JS
// ---------------------------------------------------------------------------
{
    /* Lượt đo đầu: JS chỉ chiếm ~4,5% một giây mà vẫn rớt 30% khung. Nút thắt nằm ngoài
       JS, nên HUD bắt buộc phải soi được GPU / nguồn video / số điểm ảnh mỗi khung. */
    ['gpuInfo', 'sourceInfo', 'previewCanvasInfo'].forEach((fn) => {
        assert.ok(new RegExp(`function ${fn}\\s*\\(`).test(code), `thiếu hàm ${fn}()`);
    });
    assert.ok(/swiftshader\|llvmpipe/i.test(code),
        'phải phát hiện được render bằng PHẦN MỀM (SwiftShader/llvmpipe)');
    assert.ok(/preview_proxy/.test(code),
        'phải phân biệt được đang phát proxy LQ hay bản gốc HQ');
    // Đầu dò nhịp khung TỆP phải được HUỶ khi tắt — bỏ sót là rò một vòng rVFC vĩnh viễn.
    assert.ok(/cancelVideoFrameCallback/.test(code),
        'đầu dò requestVideoFrameCallback phải được huỷ khi tắt HUD');
    assert.ok(/function startVideoFrameProbe/.test(code), 'thiếu đầu dò nhịp khung tệp');
    assert.ok(/TỔNG JS/.test(source),
        'phải hiện TỔNG JS cạnh 1000ms — nếu không, không ai thấy JS chỉ chiếm vài phần trăm');

    // Và các số đó phải có mặt trong snapshot() để dán vào báo cáo.
    const { sandbox } = makeEnv();
    sandbox.window.PerfHUD.enable();
    const snap = sandbox.window.PerfHUD.snapshot();
    sandbox.window.PerfHUD.disable();
    ['gpu', 'source', 'previewCanvas', 'decodedFps', 'onScreenFps'].forEach((k) => {
        assert.ok(k in snap, `snapshot() thiếu trường ${k}`);
    });
}

// ---------------------------------------------------------------------------
// 4c. Bộ đếm lúc PHÁT + phép thử A/B — thêm sau lượt đo 2
// ---------------------------------------------------------------------------
{
    /* Lượt 2 (lúc DỪNG) loại trừ gần hết: GPU thật, proxy LQ 406x720, canvas 0,13 MP,
       rAF 60 fps chằn chặn. Nút thắt chỉ xuất hiện LÚC PHÁT, nên HUD phải đếm được ba
       thứ tách bạch ba giả thuyết còn lại. */
    ['seeking', 'waiting', 'stalled'].forEach((ev) => {
        assert.ok(code.includes(`addEventListener('${ev}'`),
            `thiếu bộ đếm sự kiện '${ev}' của thẻ video`);
    });
    assert.ok(/removeEventListener\('seeking'/.test(code),
        'listener của thẻ video phải được GỠ khi tắt HUD');
    assert.ok(/buffered/.test(code), 'phải đo được lượng dữ liệu đệm sẵn');

    /* Phép thử A/B là thứ DỨT ĐIỂM nhất trong cả bộ đo: tắt ticker PIXI ngay trong lúc
       phát để biết đường hợp thành preview có phải thủ phạm không, thay vì suy đoán. */
    assert.ok(/function setPixiPaused/.test(code), 'thiếu phép thử A/B setPixiPaused');
    assert.ok(/event\.key === 'F10' && on/.test(code),
        'F10 chỉ được có tác dụng khi HUD đang bật, không cướp phím của ứng dụng');

    const { sandbox } = makeEnv();
    let stopped = 0;
    let started = 0;
    const fakeTicker = { stop: () => { stopped += 1; }, start: () => { started += 1; } };
    sandbox.window.PerfHUD.enable();
    // Giả một lượt tick để HUD ghi nhận ticker vào danh sách A/B.
    sandbox.window.PIXI.Ticker.prototype.update.call(fakeTicker);
    sandbox.window.PerfHUD.setPixiPaused(true);
    assert.strictEqual(stopped, 1, 'A/B bật lên phải DỪNG ticker đã gặp');
    assert.strictEqual(sandbox.window.PerfHUD.isPixiPaused(), true, 'phải nhớ trạng thái A/B');

    /* Tắt HUD khi đang ở giữa phép thử A/B PHẢI bật lại ticker — bỏ sót là preview đứng
       hình vĩnh viễn và người dùng tưởng app hỏng. */
    sandbox.window.PerfHUD.disable();
    assert.strictEqual(started, 1, 'tắt HUD giữa phép thử A/B phải BẬT LẠI ticker');
    assert.strictEqual(sandbox.window.PerfHUD.isPixiPaused(), false, 'phải xoá trạng thái A/B khi tắt');
}

// ---------------------------------------------------------------------------
// 5. Không được dùng named function expression cho hàm bọc (nguyên nhân gốc của lỗi 2)
// ---------------------------------------------------------------------------
{
    assert.ok(!/window\[name\] = function \w+\(/.test(code),
        'wrapGlobal dùng lại named function expression — closure hoàn nguyên sẽ ném ReferenceError');
    assert.ok(!/T\.update = function \w+\(/.test(code),
        'wrapPixiTickers dùng lại named function expression');
    assert.ok(/const wrapped = function \(/.test(code) && /const wrappedUpdate = function \(/.test(code),
        'hàm bọc phải gán vào const rồi mới gán vào đích');

    // disable() phải KÊU khi gỡ bọc lỗi, không nuốt im lặng như bản đầu.
    assert.ok(/catch \(err\) \{ console\.error\('PerfHUD: gỡ bọc thất bại/.test(code),
        'disable() không được nuốt im lặng lỗi gỡ bọc');
}

// ---------------------------------------------------------------------------
// 6. Đã nối dây vào index.html, và nạp SAU perf-runtime.js
// ---------------------------------------------------------------------------
{
    const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
    const iPerf = html.indexOf('static/js/perf-runtime.js');
    const iHud = html.indexOf('static/js/perf-hud.js');
    assert.notStrictEqual(iHud, -1, 'index.html chưa nạp perf-hud.js');
    assert.ok(iHud > iPerf,
        'perf-hud.js phải nạp SAU perf-runtime.js — perf-runtime gán đè drawRuler/'
        + 'drawTimelineSegments/scrollTimelineToCurrentTime, nạp trước là bọc phải bản cũ');
}

console.log('perf_hud: OK');
