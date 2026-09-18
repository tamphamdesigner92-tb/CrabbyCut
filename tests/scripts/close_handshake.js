/* =====================================================================
 * BẮT TAY MAIN ↔ RENDERER KHI ĐÓNG CỬA SỔ
 *
 * LỖI ĐÃ TRẢ GIÁ (báo cáo 2026-09-06): bấm nút đỏ khi dự án còn thay đổi chưa lưu thì
 * HAI hộp thoại hiện ra chồng nhau — hộp tự vẽ của renderer ("Rời khỏi dự án sẽ dọn dữ
 * liệu tạm...") và vài giây sau là hộp NATIVE màu trắng của main. Trả lời hộp trắng thì
 * app thoát hẳn, thay vì về Trang chủ như hộp kia hứa. Chỉ "Huỷ" mới không làm gì.
 *
 * NGUYÊN NHÂN: `askRenderer` đợi 4 giây rồi coi renderer là đã treo. Nhưng renderer không
 * treo — nó đang MỞ HỘP THOẠI VÀ CHỜ NGƯỜI DÙNG. Một cái timeout không phân biệt được hai
 * chuyện đó, mà hai chuyện đó đòi hai cách xử lý ngược nhau.
 *
 * CÁCH SỬA: renderer gửi `renderer-busy` NGAY khi nhận câu hỏi (trước `await`), main nhận
 * được thì gia hạn. Renderer treo thật thì không gửi gì và timeout ngắn vẫn chạy y như cũ
 * — vẫn không bao giờ kẹt không đóng được cửa sổ.
 *
 * CÁCH ĐO: nạp CHÍNH `askRenderer` + đường `renderer-reply`/`renderer-busy` của main.js
 * vào vm với ipcMain/mainWindow giả và ĐỒNG HỒ GIẢ (test nói về timeout — dùng đồng hồ
 * thật thì hoặc chậm hoặc giòn).
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const projectRoot = path.resolve(__dirname, '..', '..');
const mainSrc = fs.readFileSync(path.join(projectRoot, 'electron', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(projectRoot, 'electron', 'preload.js'), 'utf8');

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

function sliceBetween(src, from, to) {
    const a = src.indexOf(from);
    assert.notStrictEqual(a, -1, `không tìm thấy "${from}"`);
    const b = src.indexOf(to, a);
    assert.notStrictEqual(b, -1, `không tìm thấy "${to}"`);
    return src.slice(a, b);
}

function makeClock() {
    let now = 0;
    let seq = 0;
    const timers = new Map();
    return {
        setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
        clearTimeout: (id) => { timers.delete(id); },
        advance(ms) {
            const target = now + ms;
            for (;;) {
                let next = null;
                timers.forEach((t, id) => {
                    if (t.at <= target && (!next || t.at < next.t.at)) next = { id, t };
                });
                if (!next) break;
                timers.delete(next.id);
                now = next.t.at;
                next.t.fn();
            }
            now = target;
        },
    };
}

function makeMain() {
    const clock = makeClock();
    const ipcHandlers = new Map();
    const sent = [];
    const sandbox = {
        console,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        ipcMain: { on: (ch, fn) => ipcHandlers.set(ch, fn) },
        mainWindow: {
            isDestroyed: () => false,
            webContents: { send: (ch, payload) => sent.push({ ch, payload }) },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext([
        'let askSeq = 0;',
        'const pendingAsks = new Map();',
        'const pendingBusy = new Map();',
        `const ASK_BUSY_TIMEOUT_MS = ${mainSrc.match(/const ASK_BUSY_TIMEOUT_MS = ([^;]+);/)[1]};`,
        extractFunction(mainSrc, 'settleAsk'),
        sliceBetween(mainSrc, "ipcMain.on('renderer-reply'", 'function askRenderer'),
        extractFunction(mainSrc, 'askRenderer'),
        'globalThis.askRenderer = askRenderer;',
        'globalThis.pendingCount = () => pendingAsks.size + pendingBusy.size;',
    ].join('\n'), sandbox);
    return { sandbox, clock, ipcHandlers, sent };
}

// Promise đã settle chưa — dùng để khẳng định "CHƯA được bỏ cuộc".
function probe(p) {
    const state = { done: false, value: undefined };
    p.then((v) => { state.done = true; state.value = v; });
    return state;
}
const flush = () => new Promise((r) => setImmediate(r));

async function main() {
    // -----------------------------------------------------------------------
    // 1. Trả lời ngay -> nhận đúng giá trị
    // -----------------------------------------------------------------------
    {
        const { sandbox, clock, ipcHandlers, sent } = makeMain();
        const p = sandbox.askRenderer('ask-close-intent');
        assert.strictEqual(sent.length, 1, 'phải gửi câu hỏi sang renderer');
        ipcHandlers.get('renderer-reply')(null, { id: sent[0].payload.id, value: 'home' });
        assert.strictEqual(await p, 'home', 'phải nhận đúng câu trả lời của renderer');
        clock.advance(60 * 1000);
        assert.strictEqual(sandbox.pendingCount(), 0, 'phải dọn sạch state sau khi trả lời');
    }

    // -----------------------------------------------------------------------
    // 2. Renderer TREO -> timeout ngắn vẫn phải hoạt động (không kẹt cửa sổ)
    // -----------------------------------------------------------------------
    {
        const { sandbox, clock } = makeMain();
        const p = sandbox.askRenderer('ask-close-intent');
        const st = probe(p);
        clock.advance(3999);
        await flush();
        assert.strictEqual(st.done, false, 'chưa tới hạn thì chưa được bỏ cuộc');
        clock.advance(2);
        assert.strictEqual(await p, null, 'renderer treo thì phải bỏ cuộc để cửa sổ còn đóng được');
        assert.strictEqual(sandbox.pendingCount(), 0, 'bỏ cuộc rồi cũng phải dọn state');
    }

    // -----------------------------------------------------------------------
    // 3. ĐÂY LÀ LỖI ĐÃ BÁO: renderer báo bận rồi người dùng nghĩ lâu
    // -----------------------------------------------------------------------
    {
        const { sandbox, clock, ipcHandlers, sent } = makeMain();
        const p = sandbox.askRenderer('ask-close-intent');
        const { id } = sent[0].payload;
        const st = probe(p);

        // Renderer nhận câu hỏi -> báo bận NGAY (trước khi mở hộp thoại).
        ipcHandlers.get('renderer-busy')(null, { id });

        /* Người dùng ngắm hộp thoại 30 giây. Bản CŨ tới đây đã bỏ cuộc và bật hộp thoại
           native thứ hai — đúng thứ người dùng nhìn thấy. */
        clock.advance(30 * 1000);
        await flush();
        assert.strictEqual(st.done, false,
            'renderer đã báo bận mà main vẫn bỏ cuộc -> HAI hộp thoại chồng nhau');

        // Rồi người dùng bấm "Huỷ" -> renderer trả lời, main phải nhận đúng.
        ipcHandlers.get('renderer-reply')(null, { id, value: 'cancelled' });
        assert.strictEqual(await p, 'cancelled', 'phải nhận đúng lựa chọn của người dùng');
    }

    // -----------------------------------------------------------------------
    // 4. Báo bận nhưng rồi CHẾT HẲN -> vẫn phải có trần, không treo vĩnh viễn
    // -----------------------------------------------------------------------
    {
        const { sandbox, clock, ipcHandlers, sent } = makeMain();
        const p = sandbox.askRenderer('ask-close-intent');
        ipcHandlers.get('renderer-busy')(null, { id: sent[0].payload.id });
        const st = probe(p);
        clock.advance(9 * 60 * 1000);
        await flush();
        assert.strictEqual(st.done, false, 'trong hạn gia hạn thì chưa được bỏ cuộc');
        clock.advance(2 * 60 * 1000);
        assert.strictEqual(await p, null, 'quá hạn gia hạn thì vẫn phải bỏ cuộc');
    }

    // -----------------------------------------------------------------------
    // 5. Nhiều lượt hỏi song song không được lẫn mã lượt
    // -----------------------------------------------------------------------
    {
        const { sandbox, clock, ipcHandlers, sent } = makeMain();
        const a = sandbox.askRenderer('ask-close-intent');
        const b = sandbox.askRenderer('ask-project-dirty');
        const idA = sent[0].payload.id;
        const idB = sent[1].payload.id;
        assert.notStrictEqual(idA, idB, 'hai lượt hỏi phải mang hai mã khác nhau');

        ipcHandlers.get('renderer-busy')(null, { id: idA });   // chỉ A bận
        clock.advance(5000);                                    // B phải hết hạn, A thì không
        assert.strictEqual(await b, null, 'lượt KHÔNG báo bận phải hết hạn như thường');
        const stA = probe(a);
        await flush();
        assert.strictEqual(stA.done, false, 'gia hạn của A không được bị B kéo theo');
        ipcHandlers.get('renderer-reply')(null, { id: idA, value: 'home' });
        assert.strictEqual(await a, 'home', 'A vẫn phải nhận đúng câu trả lời');
    }

    // -----------------------------------------------------------------------
    // 6. Trả lời lạc mã / trả lời hai lần không được làm hỏng gì
    // -----------------------------------------------------------------------
    {
        const { sandbox, ipcHandlers, sent } = makeMain();
        const p = sandbox.askRenderer('ask-close-intent');
        const { id } = sent[0].payload;
        ipcHandlers.get('renderer-reply')(null, { id: id + 999, value: 'home' });   // mã lạ
        ipcHandlers.get('renderer-busy')(null, { id: id + 999 });                   // mã lạ
        ipcHandlers.get('renderer-reply')(null, { id, value: 'already-home' });
        ipcHandlers.get('renderer-reply')(null, { id, value: 'home' });             // lần hai
        assert.strictEqual(await p, 'already-home', 'chỉ câu trả lời ĐẦU TIÊN được tính');
    }

    // -----------------------------------------------------------------------
    // 7. Phía renderer: PHẢI báo bận TRƯỚC `await`, ở CẢ BA handler
    // -----------------------------------------------------------------------
    {
        const handlers = ['ask-project-dirty', 'ask-close-intent', 'ask-project-save'];
        handlers.forEach((ch) => {
            const at = preloadSrc.indexOf(`ipcRenderer.on('${ch}'`);
            assert.notStrictEqual(at, -1, `không tìm thấy handler ${ch}`);
            const body = preloadSrc.slice(at, at + 400);
            const busyAt = body.indexOf("send('renderer-busy'");
            const awaitAt = body.indexOf('await handler()');
            assert.notStrictEqual(busyAt, -1, `${ch} chưa báo bận`);
            assert.notStrictEqual(awaitAt, -1, `${ch} không thấy chỗ await handler()`);
            /* Gửi SAU `await` là vô dụng: chính cái chờ đó giữ lại tín hiệu, main vẫn hết
               hạn và vẫn bật hộp thoại thứ hai. */
            assert.ok(busyAt < awaitAt, `${ch} phải báo bận TRƯỚC await handler()`);
        });
    }

    console.log('close_handshake: OK');
    process.exitCode = 0;
}

/* ĐẶT HỎNG TRƯỚC, chỉ gỡ ở dòng cuối của main().
 *
 * Test này dùng ĐỒNG HỒ GIẢ, nên nếu một `await` không bao giờ settle thì vòng lặp sự kiện
 * rỗng và Node THOÁT ÊM với mã 0 — hỏng mà trông như xanh. Đã dính đúng bẫy này khi thử
 * phá: bỏ hạn trần của phần gia hạn thì `await p` treo vĩnh viễn mà test vẫn "đạt".
 * Có dòng này thì mọi lối thoát sớm đều thành mã lỗi. */
process.exitCode = 1;
main().catch((err) => { console.error(err); process.exit(1); });
