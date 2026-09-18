/* =====================================================================
 * PREVIEW CUTS — GỘP ĐOẠN LIỀN NHAU ĐỂ BỎ LỆNH TUA VÔ NGHĨA
 *
 * LỖI ĐÃ TRẢ GIÁ (đo 2026-09-06 trên dự án thật, Match Script):
 *   - Preview Cuts BẬT  -> rớt 10,5% và 30,0% khung hình, nhịp UI 19-22 fps
 *   - Play thường       -> rớt 0,0% (1/6261), nhịp UI 60 fps — trên nguồn HQ 5,31 MP,
 *                          tức NẶNG GẤP 18 LẦN bản proxy 0,29 MP dùng lúc bị giật
 * Bản nặng hơn nhiều lại mượt tuyệt đối, nên giải mã / GPU / hợp thành / PIXI / JS đều bị
 * loại. Toàn bộ chênh lệch nằm ở các lệnh tua của `runJumpCutLogic`.
 *
 * NGUYÊN NHÂN: hàm đó tua ở MỖI mép chunk. Nhưng ở Match Script người dùng chọn nhiều
 * chunk LIÊN TIẾP, mà hai chunk liên tiếp có `chunk[i].end === chunk[i+1].start` — lệnh tua
 * nhảy tới đúng chỗ video đang đứng. Vô nghĩa, nhưng trình duyệt vẫn xả sạch hàng đợi khung
 * đã giải mã. Với chunk cỡ câu là một lần xả mỗi 1-2 giây.
 *
 * QUYẾT ĐỊNH SẢN PHẨM (người dùng chốt 2026-09-06): ưu tiên CHÍNH XÁC TUYỆT ĐỐI. Không bao
 * giờ được phát nội dung đã bỏ chọn, kể cả khi khe rất ngắn. Vì vậy bản sửa chỉ gộp các
 * đoạn THẬT SỰ LIỀN NHAU — mọi khe đã bỏ chọn vẫn bị nhảy qua y như cũ.
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(
    path.join(projectRoot, 'static', 'js', 'perf-runtime.js'), 'utf8');

function extractFunction(src, name) {
    const start = src.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `không tìm thấy hàm ${name}()`);
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

function extractConst(src, name) {
    const m = src.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
    assert.ok(m, `không tìm thấy hằng ${name}`);
    return m[1].trim();
}

function makeSandbox(chunks) {
    const sandbox = {
        currentMode: 'MAPPED',
        globalMappedChunks: chunks,
        latestTimeline: [],
        video: { currentTime: 0, seeking: false },
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext([
        `const SPAN_JOIN_EPS = ${extractConst(source, 'SPAN_JOIN_EPS')};`,
        `const playbackState = ${extractConst(source, 'playbackState')};`,
        extractFunction(source, 'getMappedSelectedChunks'),
        extractFunction(source, 'getMappedPlaybackSpans'),
        extractFunction(source, 'getActiveChunksForPlayback'),
        extractFunction(source, 'seekPlayback'),
        `globalThis.api = { getMappedPlaybackSpans, getActiveChunksForPlayback, seekPlayback,
                            markDirty: () => { playbackState.mappedSelectionDirty = true; } };`,
    ].join('\n'), sandbox);
    return sandbox;
}

const sel = (start, end) => ({ start, end, is_selected: true });
const unsel = (start, end) => ({ start, end, is_selected: false });
/* Trải sang mảng của realm NÀY: mảng do vm trả về mang Array.prototype khác nên
   deepStrictEqual báo lệch dù nội dung y hệt. */
const shape = (spans) => [...spans].map((s) => [s.start, s.end]);

// ---------------------------------------------------------------------------
// 1. Chunk LIỀN NHAU phải gộp làm một — đây là toàn bộ mục đích của bản sửa
// ---------------------------------------------------------------------------
{
    const s = makeSandbox([sel(0, 2), sel(2, 4), sel(4, 6)]);
    const spans = s.api.getMappedPlaybackSpans();
    assert.deepStrictEqual(shape(spans), [[0, 6]],
        'ba chunk liền nhau phải thành MỘT đoạn — nếu không, vẫn còn 2 lệnh tua vô nghĩa');
}

// ---------------------------------------------------------------------------
// 2. Khe đã BỎ CHỌN phải giữ nguyên — lời hứa "chính xác tuyệt đối"
// ---------------------------------------------------------------------------
{
    /* Đây là khẳng định QUAN TRỌNG NHẤT về mặt đúng-sai. Gộp quá tay là Preview Cuts phát
       cả nội dung người dùng đã cắt bỏ — đúng thứ người dùng đã chọn KHÔNG đánh đổi. */
    const s = makeSandbox([sel(0, 2), unsel(2, 5), sel(5, 7), sel(7, 9)]);
    const spans = s.api.getMappedPlaybackSpans();
    assert.deepStrictEqual(shape(spans), [[0, 2], [5, 9]],
        'khe bỏ chọn 2-5s phải được giữ, và hai chunk sau nó phải gộp');
    spans.forEach((sp) => {
        assert.ok(!(sp.start < 5 && sp.end > 2 && sp.start !== 0),
            'không đoạn nào được trùm lên vùng đã bỏ chọn');
    });
}

// ---------------------------------------------------------------------------
// 3. Ngưỡng nối: sát nhau thì gộp, cách xa thì không
// ---------------------------------------------------------------------------
{
    // Mép do ASR sinh nên hiếm khi trùng tuyệt đối — chênh 20ms vẫn phải coi là liền.
    const near = makeSandbox([sel(0, 2), sel(2.02, 4)]);
    assert.deepStrictEqual(shape(near.api.getMappedPlaybackSpans()), [[0, 4]],
        'chênh 20ms (dưới ngưỡng) phải coi là liền nhau');

    // Cách 0,5s là một khe THẬT -> phải giữ, nếu không là phát nội dung đã cắt.
    const far = makeSandbox([sel(0, 2), sel(2.5, 4)]);
    assert.deepStrictEqual(shape(far.api.getMappedPlaybackSpans()), [[0, 2], [2.5, 4]],
        'khe 0,5s là khe thật, KHÔNG được gộp');

    const eps = Number(extractConst(source, 'SPAN_JOIN_EPS'));
    assert.ok(eps > 0 && eps <= 0.1,
        `ngưỡng nối phải nhỏ (cỡ một khung hình), đang là ${eps}s`);
}

// ---------------------------------------------------------------------------
// 4. Chunk chồng lấn / dữ liệu hỏng
// ---------------------------------------------------------------------------
{
    const overlap = makeSandbox([sel(0, 3), sel(2, 5)]);
    assert.deepStrictEqual(shape(overlap.api.getMappedPlaybackSpans()), [[0, 5]],
        'chunk chồng lấn phải gộp và lấy mép xa nhất');

    // Chunk bị bao trọn không được làm CO NGẮN đoạn đang có.
    const nested = makeSandbox([sel(0, 10), sel(2, 4)]);
    assert.deepStrictEqual(shape(nested.api.getMappedPlaybackSpans()), [[0, 10]],
        'chunk nằm gọn bên trong không được cắt ngắn đoạn bao ngoài');

    const bad = makeSandbox([sel(0, 2), sel(5, 5), sel(6, 3), { start: NaN, end: 9, is_selected: true }, sel(8, 10)]);
    assert.deepStrictEqual(shape(bad.api.getMappedPlaybackSpans()), [[0, 2], [8, 10]],
        'chunk rỗng / ngược / NaN phải bị bỏ, không được sinh đoạn rác');

    const empty = makeSandbox([unsel(0, 5)]);
    assert.deepStrictEqual(shape(empty.api.getMappedPlaybackSpans()), [],
        'không chọn gì thì không có đoạn nào');
}

// ---------------------------------------------------------------------------
// 5. Nhận dạng mảng phải ỔN ĐỊNH giữa các lượt gọi
// ---------------------------------------------------------------------------
{
    /* `runJumpCutLogic` so `playbackState.jumpChunksRef !== activeChunks` để biết có phải
       đổi lựa chọn không. Trả mảng MỚI mỗi lượt gọi là con trỏ đoạn bị reset về 0 mỗi
       khung hình — hỏng âm thầm. */
    const s = makeSandbox([sel(0, 2), sel(2, 4)]);
    const a = s.api.getActiveChunksForPlayback();
    const b = s.api.getActiveChunksForPlayback();
    assert.strictEqual(a, b, 'hai lượt gọi liên tiếp phải trả về CÙNG một mảng');

    // Nhưng đổi lựa chọn thì phải dựng lại.
    s.globalMappedChunks = [sel(0, 9)];
    s.api.markDirty();
    const c = s.api.getActiveChunksForPlayback();
    assert.notStrictEqual(c, a, 'đổi lựa chọn phải dựng lại danh sách đoạn');
    assert.deepStrictEqual(shape(c), [[0, 9]], 'đoạn mới phải theo lựa chọn mới');
}

// ---------------------------------------------------------------------------
// 6. Guard tua: không ra lệnh mới khi lệnh cũ còn dở
// ---------------------------------------------------------------------------
{
    const s = makeSandbox([sel(0, 2)]);
    s.video.currentTime = 0;

    s.video.seeking = false;
    assert.strictEqual(s.api.seekPlayback(5), true, 'rảnh thì phải tua');
    assert.strictEqual(s.video.currentTime, 5, 'tua rồi thì currentTime phải đổi');

    s.video.seeking = true;
    assert.strictEqual(s.api.seekPlayback(9), false, 'đang tua dở thì KHÔNG được tua chồng');
    assert.strictEqual(s.video.currentTime, 5, 'lệnh tua bị bỏ không được đụng currentTime');

    s.video.seeking = false;
    assert.strictEqual(s.api.seekPlayback(NaN), false, 'giá trị hỏng phải bị từ chối');
    assert.strictEqual(s.video.currentTime, 5, 'giá trị hỏng không được ghi vào currentTime');
}

// ---------------------------------------------------------------------------
// 7. ĐỊNH LƯỢNG: bao nhiêu lệnh tua được bỏ trên một lựa chọn kiểu Match Script
// ---------------------------------------------------------------------------
{
    /* Dựng đúng thế trận đã gây ra 30% rớt khung: transcript chia nhỏ cỡ câu (~1,5s),
       người dùng chọn gần hết và bỏ vài chỗ. Số lệnh tua = số mép phải nhảy. */
    const chunks = [];
    for (let i = 0; i < 60; i += 1) {
        const start = i * 1.5;
        // Bỏ chọn 3 chỗ rải rác -> đúng 3 khe thật.
        const dropped = i === 12 || i === 30 || i === 47;
        chunks.push(dropped ? unsel(start, start + 1.5) : sel(start, start + 1.5));
    }
    const s = makeSandbox(chunks);
    const spans = s.api.getMappedPlaybackSpans();

    const seeksTruoc = chunks.filter((c) => c.is_selected).length - 1;  // mỗi mép chunk = 1 lệnh tua
    const seeksSau = spans.length - 1;                                   // chỉ còn mép khe THẬT
    assert.strictEqual(spans.length, 4, `3 khe bỏ chọn phải cho 4 đoạn, nhận ${spans.length}`);
    assert.strictEqual(seeksSau, 3, 'chỉ còn đúng 3 lệnh tua — bằng số khe thật');
    assert.ok(seeksTruoc >= 50, `thế trận phải đủ dày để có ý nghĩa, đang là ${seeksTruoc}`);
    /* 56 -> 3 lệnh tua cho một lượt phát 90 giây. Đây là con số giải thích chênh lệch
       10,5-30,0% rớt khung so với 0,0% của Play thường. */
    assert.ok(seeksSau < seeksTruoc / 10,
        `phải bỏ được ít nhất 90% lệnh tua, đang ${seeksTruoc} -> ${seeksSau}`);
}

// ---------------------------------------------------------------------------
// 8. Đường FINAL không được đụng tới
// ---------------------------------------------------------------------------
{
    /* FINAL phát theo THỨ TỰ SEQUENCE (mảng có thể đã đảo), mỗi clip mang tốc độ riêng —
       gộp ở đó là phá logic con trỏ clip và tốc độ. Chỉ MAPPED mới được gộp. */
    const s = makeSandbox([sel(0, 2), sel(2, 4)]);
    s.currentMode = 'FINAL';
    s.latestTimeline = [{ start: 5, end: 7 }, { start: 7, end: 9 }];
    const active = s.api.getActiveChunksForPlayback();
    assert.strictEqual(active, s.latestTimeline,
        'ở FINAL phải trả về latestTimeline nguyên vẹn, không gộp gì');

    const fn = extractFunction(source, 'runJumpCutLogic');
    assert.ok(!/video\.currentTime = /.test(fn),
        'mọi lệnh tua trong runJumpCutLogic phải đi qua seekPlayback()');
    assert.strictEqual((fn.match(/seekPlayback\(/g) || []).length, 4,
        'phải có đúng 4 lối tua đi qua guard (2 nhánh FINAL, 2 nhánh MAPPED)');
}

console.log('preview_cuts_seeks: OK');
