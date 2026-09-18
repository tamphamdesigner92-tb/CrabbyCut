/* ĐÓNG GÓI DỰ ÁN (electron/project-package.js) — kiểu "Collect Files and Copy" của Premiere.
 *
 * Chạy bằng node thuần nhờ factory createProjectPackager(): không cần dựng Electron, không
 * đụng thư mục thật nào ngoài test_temp/.
 *
 * Đo 6 điều — mỗi điều là một cách bản đã gói có thể HỎNG MÀ KHÔNG BÁO:
 *   1. mọi media được chép vào Media/ và ĐƯỜNG DẪN trong payload thành tương đối;
 *   2. viết lại ĐỦ 5 CHỖ có đường dẫn (thiếu một chỗ là còn một nhánh trỏ về máy cũ, chỉ lộ
 *      ra khi người dùng chạm đúng nhánh đó — vd thêm video vào lane chính đọc source_path
 *      của clip, không đọc media.sources);
 *   3. hai file TRÙNG TÊN ở hai thư mục khác nhau (DJI/GoPro đánh số lại mỗi thẻ) không được
 *      đè nhau;
 *   4. một file được nhiều trường cùng trỏ tới chỉ chép MỘT lần;
 *   5. file không còn trên đĩa: bỏ qua, GIỮ NGUYÊN đường dẫn tuyệt đối (viết thành tương đối
 *      là biến "thiếu file, re-link được" thành "trỏ vào chỗ chưa từng có file");
 *   6. CHÉP chứ không DI CHUYỂN — footage gốc phải còn nguyên.
 * Cộng chiều ngược: resolvePayloadPaths() giải lại đúng theo thư mục chứa tệp .crab.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { createProjectPackager } = require('../../electron/project-package.js');

const TEST_DIR = path.join(__dirname, '..', '..', 'test_temp', 'project_package');
const SRC_A = path.join(TEST_DIR, 'Cam A');
const SRC_B = path.join(TEST_DIR, 'Cam B');
const DEST = path.join(TEST_DIR, 'dest');

function writeFake(dir, name, byte) {
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, name);
    fs.writeFileSync(full, Buffer.alloc(1024, byte));
    return full;
}

function main() {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    const clip1 = writeFake(SRC_A, 'DJI_0001.MP4', 1);
    const clip2 = writeFake(SRC_B, 'DJI_0001.MP4', 2);   // TRÙNG TÊN, khác thư mục
    const clip3 = writeFake(SRC_A, 'b-roll.mp4', 3);
    const overlay = writeFake(SRC_B, 'logo.png', 4);
    const ghost = path.join(SRC_A, 'da-xoa.mp4');        // có trong dự án, không còn trên đĩa

    const payload = {
        format_version: 1,
        project: {
            name: 'Yêu Con 1',
            history: {
                latestTimeline: [
                    { start: 0, end: 5, source_path: clip1 },
                    { start: 5, end: 9, source_path: clip2 },
                    { start: 9, end: 12, source_path: ghost },
                ],
                projectVideoLibrary: [
                    { name: 'DJI_0001.MP4', source_path: clip1 },
                    { name: 'DJI_0001.MP4', source_path: clip2 },
                    { name: 'b-roll.mp4', source_path: clip3 },
                ],
                /* Auto Subtitle: sổ phụ đề nằm trong history.editingState. `srt_path` trỏ vào
                 * thư mục dự án CŨ — đây chính là thứ phải được viết lại khi đóng gói. */
                editingState: {
                    subtitleState: {
                        id: 'sub_abc',
                        language: 'vi',
                        sync_style: true,
                        item_ids: ['item_text_1'],
                        cues: [{ start: 0, end: 2, text: 'Xin chào' }],
                        srt_path: path.join(SRC_A, 'Du an cu.srt'),
                    },
                },
            },
        },
        media: {
            sources: [
                { index: 0, path: clip1 }, { index: 1, path: clip2 },
                { index: 2, path: clip3 }, { index: 3, path: ghost },
            ],
            editingAssets: [{ asset_id: 'a1', source_path: overlay, linked: true }],
            main_lane_concat: [clip1, clip2, ghost],
            /* BẢNG ĐOẠN của file nối — chỗ này ĐÃ TỪNG BỊ BỎ SÓT và hậu quả là lane chính
             * rỗng trắng khi mở bản đã gói (xem eachMirrorPathSite). Mốc phải khớp
             * main_lane_concat: rebaseRows() ghép bảng cũ với bảng mới THEO source_path. */
            main_lane_segments: [
                { source_path: clip1, start: 0, end: 5, duration: 5 },
                { source_path: clip2, start: 5, end: 9, duration: 4 },
                { source_path: ghost, start: 9, end: 12, duration: 3 },
            ],
        },
    };
    // Bản sao chiếu trong editingState (asset thư viện dựng sẵn KHÔNG được gói vào Media/).
    const libraryAsset = 'C:\\App\\CrabbyCut\\library\\elements\\sparkle.png';
    payload.project.history.editingState.editingAssets = [
        { id: 'a1', source: 'project', source_path: overlay, path: '/tmp/runtime/overlay.png' },
        { id: 'a2', source: 'library', source_path: libraryAsset, path: '/tmp/runtime/sparkle.png' },
    ];

    const { packageProject, resolvePayloadPaths } = createProjectPackager();
    const SRT_TEXT = '1\n00:00:00,000 --> 00:00:02,000\nXin chào\n';
    const result = packageProject({
        payloadJson: JSON.stringify(payload),
        destDir: DEST,
        projectName: 'Yêu Con 1',
        subtitleSrt: SRT_TEXT,
    });
    const packed = JSON.parse(result.payloadJson);
    const mediaDir = path.join(result.projectDir, 'Media');

    // --- 1 & 4: chép đủ, không chép trùng ---
    assert.strictEqual(result.copied, 4, 'phải chép đúng 4 file (clip1 bị 4 trường cùng trỏ tới)');
    assert.deepStrictEqual(result.missing, [ghost], 'file đã mất phải được báo ra');
    assert.strictEqual(fs.readdirSync(mediaDir).length, 4, 'Media/ phải có đúng 4 file');
    assert.strictEqual(result.crabPath, path.join(result.projectDir, 'Yêu Con 1.crab'));

    // --- 3: trùng tên không được đè nhau (nội dung phải khác nhau) ---
    const packedSources = packed.media.sources.map((s) => s.path);
    assert.notStrictEqual(packedSources[0], packedSources[1], 'hai file trùng tên phải ra hai tên khác nhau');
    const read = (rel) => fs.readFileSync(path.join(result.projectDir, rel))[0];
    assert.strictEqual(read(packedSources[0]), 1, 'nội dung clip A phải nguyên vẹn');
    assert.strictEqual(read(packedSources[1]), 2, 'nội dung clip B phải nguyên vẹn (không bị đè)');

    // --- 2: viết lại ĐỦ 5 chỗ ---
    const rel = (p) => !path.isAbsolute(p);
    assert.ok(packed.media.sources.slice(0, 3).every((s) => rel(s.path)), 'media.sources phải tương đối');
    assert.ok(rel(packed.media.editingAssets[0].source_path), 'media.editingAssets phải tương đối');
    assert.ok(packed.media.main_lane_concat.slice(0, 2).every(rel), 'media.main_lane_concat phải tương đối');
    assert.ok(packed.project.history.latestTimeline.slice(0, 2).every((r) => rel(r.source_path)),
        'clip lane chính phải tương đối');
    assert.ok(packed.project.history.projectVideoLibrary.every((i) => rel(i.source_path)),
        'sổ nguồn phải tương đối');
    // Cùng một file vật lý -> mọi trường phải trỏ về CÙNG một tên trong Media/.
    assert.strictEqual(packed.project.history.latestTimeline[0].source_path, packed.media.sources[0].path);
    assert.strictEqual(packed.media.main_lane_concat[0], packed.media.sources[0].path);

    // --- 5: file đã mất giữ nguyên đường dẫn tuyệt đối ---
    assert.strictEqual(packed.media.sources[3].path, ghost, 'file mất phải giữ nguyên đường dẫn cũ');
    assert.strictEqual(packed.project.history.latestTimeline[2].source_path, ghost);
    assert.strictEqual(packed.media.main_lane_concat[2], ghost);

    // --- 6: CHÉP, không di chuyển ---
    [clip1, clip2, clip3, overlay].forEach((p) => {
        assert.strictEqual(fs.existsSync(p), true, `footage gốc phải còn nguyên: ${p}`);
    });

    // --- chiều mở: giải tương đối -> tuyệt đối theo thư mục chứa .crab ---
    const moved = path.join(TEST_DIR, 'moved');   // gói bị copy sang chỗ khác
    fs.cpSync(result.projectDir, moved, { recursive: true });
    const movedCrab = path.join(moved, 'Yêu Con 1.crab');
    const resolved = JSON.parse(resolvePayloadPaths(result.payloadJson, movedCrab));
    assert.strictEqual(resolved.media.sources[0].path, path.join(moved, packedSources[0].split('/').join(path.sep)),
        'mở ở vị trí mới phải trỏ vào Media/ của CHÍNH vị trí đó');
    assert.strictEqual(fs.existsSync(resolved.media.sources[0].path), true, 'file phải tồn tại ở vị trí đã giải');
    assert.strictEqual(resolved.project.history.latestTimeline[0].source_path, resolved.media.sources[0].path,
        'clip lane chính và sổ nguồn phải giải ra CÙNG một đường dẫn');
    assert.strictEqual(resolved.media.sources[3].path, ghost, 'đường dẫn tuyệt đối sẵn có không bị đụng');

    // Payload không có đường dẫn tương đối nào -> trả về nguyên văn, không đụng gì.
    const plainJson = JSON.stringify({ media: { sources: [{ path: clip1 }] } });
    assert.strictEqual(resolvePayloadPaths(plainJson, movedCrab), plainJson,
        'tệp .crab thường (đường dẫn tuyệt đối) phải đi qua không đổi');

    /* ===== BẢNG ĐOẠN LANE CHÍNH: chỗ bỏ sót từng làm lane chính RỖNG TRẮNG =====
     *
     * Lỗi đo trên dự án thật (2026-09-14): `main_lane_segments[].source_path` không được viết
     * lại nên vẫn trỏ về máy cũ. Mở bản đã gói: bảng đoạn CŨ mang đường dẫn máy cũ, bảng đoạn
     * MỚI (backend vừa nối) mang đường dẫn trong gói -> rebaseRows() ghép hai bảng theo
     * source_path, không khớp dòng nào, bỏ TOÀN BỘ clip -> lane chính rỗng, và vì timeline
     * mất độ dài nên mọi block phụ đề dồn về mốc 0. Không một dòng lỗi nào. */
    assert.ok(packed.media.main_lane_segments.slice(0, 2).every((s) => rel(s.source_path)),
        'main_lane_segments phải được viết lại thành tương đối — bỏ sót là lane chính rỗng trắng');
    // Và phải ra ĐÚNG cái tên mà main_lane_concat đã nhận, nếu không rebaseRows vẫn trượt.
    assert.strictEqual(packed.media.main_lane_segments[0].source_path, packed.media.main_lane_concat[0],
        'bảng đoạn và thứ tự nối phải trỏ về CÙNG một tên trong Media/');
    assert.strictEqual(packed.media.main_lane_segments[1].source_path, packed.media.main_lane_concat[1]);
    assert.strictEqual(packed.media.main_lane_segments[2].source_path, ghost, 'file mất vẫn giữ đường dẫn cũ');
    console.log('  ok  main_lane_segments được viết lại, khớp tên với main_lane_concat');

    // --- bản sao chiếu trong editingState: asset dự án viết lại, asset THƯ VIỆN thì không ---
    const packedAssets = packed.project.history.editingState.editingAssets;
    assert.ok(rel(packedAssets[0].source_path), 'asset của dự án phải được viết lại như media.editingAssets');
    assert.strictEqual(packedAssets[0].source_path, packed.media.editingAssets[0].source_path,
        'hai bản ghi của CÙNG một tệp phải trỏ về cùng một chỗ');
    assert.strictEqual(packedAssets[1].source_path, libraryAsset,
        'asset thư viện KHÔNG đi đường của Media/ (nó đi đường Library/ theo rel_path — xem khối cuối tệp)');
    assert.strictEqual(fs.existsSync(path.join(mediaDir, 'sparkle.png')), false,
        'không được chép asset thư viện vào Media/');
    assert.strictEqual(packedAssets[0].path, '/tmp/runtime/overlay.png',
        '`path` (temp_uploads runtime) phải để nguyên — nó được dựng lại lúc mở, không có trong gói');
    console.log('  ok  editingState.editingAssets: asset dự án viết lại, asset thư viện giữ nguyên');

    /* CHỐT CHẶN TỔNG: quét TOÀN BỘ payload đã gói, không được còn đường dẫn tuyệt đối nào
     * ngoài những tệp đã mất và asset thư viện. Đây là bài kiểm tra DUY NHẤT bắt được một
     * chỗ mới phát sinh mà không ai nhớ thêm vào eachPathSite() — mọi assert ở trên đều phải
     * biết trước tên khoá, bài này thì không. */
    {
        const ABS = /^[A-Za-z]:[\\/]|^\/(Users|home|Volumes|tmp)\//;
        const allowed = new Set([ghost, libraryAsset, '/tmp/runtime/overlay.png', '/tmp/runtime/sparkle.png']);
        const leaks = [];
        (function walk(node, trail) {
            if (typeof node === 'string') {
                if (ABS.test(node) && !allowed.has(node)) leaks.push(`${trail} = ${node}`);
                return;
            }
            if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${trail}[${i}]`)); return; }
            if (node && typeof node === 'object') { Object.keys(node).forEach((k) => walk(node[k], `${trail}.${k}`)); }
        })(packed, '');
        assert.deepStrictEqual(leaks, [], `còn đường dẫn tuyệt đối chưa được viết lại:\n  ${leaks.join('\n  ')}`);
        console.log('  ok  quét toàn payload: không còn đường dẫn nào trỏ về máy cũ');
    }

    /* ================= AUTO SUBTITLE: .srt đi cùng gói + re-link ================= */
    const subOf = (p) => p.project.history.editingState.subtitleState;

    // --- .srt được GHI vào gói, cạnh .crab, mang đúng tên gói ---
    const packedSrt = path.join(result.projectDir, 'Yêu Con 1.srt');
    assert.strictEqual(result.srtPath, packedSrt, 'packageProject phải báo lại nơi đã ghi .srt');
    assert.strictEqual(fs.existsSync(packedSrt), true, '.srt phải nằm CẠNH .crab trong gói');
    const srtRaw = fs.readFileSync(packedSrt, 'utf8');
    assert.ok(srtRaw.startsWith('﻿'), '.srt trong gói phải có BOM UTF-8');
    assert.ok(srtRaw.includes('\r\n'), '.srt trong gói phải dùng CRLF');
    assert.ok(!/\r\r/.test(srtRaw), 'không được đẻ ra \\r\\r\\n');
    assert.ok(srtRaw.includes('Xin chào'), 'nội dung phụ đề phải đúng bản truyền vào');
    // Đường dẫn trong payload thành TƯƠNG ĐỐI như mọi thứ khác trong gói.
    assert.strictEqual(subOf(packed).srt_path, 'Yêu Con 1.srt', 'srt_path phải ghi tương đối');
    // Phần còn lại của sổ phụ đề không được đụng tới.
    assert.strictEqual(subOf(packed).sync_style, true, 'cờ đồng bộ phải giữ nguyên');
    assert.deepStrictEqual(subOf(packed).item_ids, ['item_text_1'], 'item_ids phải giữ nguyên');
    console.log('  ok  .srt được gói kèm (BOM + CRLF), srt_path ghi tương đối');

    // --- chiều mở: srt_path tương đối -> tuyệt đối theo chỗ đặt gói ---
    const resolvedSub = subOf(JSON.parse(resolvePayloadPaths(result.payloadJson, movedCrab)));
    assert.strictEqual(resolvedSub.srt_path, path.join(moved, 'Yêu Con 1.srt'),
        'mở bản đã gói ở chỗ khác thì .srt phải trỏ vào chính chỗ đó');
    assert.strictEqual(fs.existsSync(resolvedSub.srt_path), true, '.srt phải tồn tại ở vị trí đã giải');
    console.log('  ok  mở bản đã gói: srt_path giải đúng theo thư mục chứa .crab');

    /* --- RE-LINK: người dùng KÉO tệp .crab sang thư mục khác trong Explorer ---
     * Đây là đường hay gặp nhất và là đường mà đường dẫn TUYỆT ĐỐI cũ không còn đúng. */
    const dragged = path.join(TEST_DIR, 'keo-tay');
    fs.mkdirSync(dragged, { recursive: true });
    const draggedCrab = path.join(dragged, 'Yêu Con 1.crab');
    fs.writeFileSync(draggedCrab, 'x');
    fs.writeFileSync(path.join(dragged, 'Yêu Con 1.srt'), 'x');   // .srt được kéo theo
    const stalePayload = JSON.stringify({
        project: { history: { editingState: { subtitleState: { srt_path: path.join(SRC_A, 'Du an cu.srt') } } } },
    });
    const relinked = subOf(JSON.parse(resolvePayloadPaths(stalePayload, draggedCrab)));
    assert.strictEqual(relinked.srt_path, path.join(dragged, 'Yêu Con 1.srt'),
        'srt_path chết phải tự re-link sang .srt cùng tên nằm cạnh .crab');
    console.log('  ok  re-link: .srt cùng tên cạnh .crab được nhận tự động');

    /* --- Không tìm thấy .srt ở đâu cả -> XOÁ khoá, KHÔNG giữ đường dẫn chết.
     * Khác chính sách của media (media thiếu thì giữ để re-link tay) vì .srt dựng lại được
     * từ timeline ở lượt Lưu kế tiếp; giữ lại chỉ để panel hiện một đường dẫn trỏ vào hư vô. */
    const orphanDir = path.join(TEST_DIR, 'khong-co-srt');
    fs.mkdirSync(orphanDir, { recursive: true });
    const orphanCrab = path.join(orphanDir, 'Du an.crab');
    fs.writeFileSync(orphanCrab, 'x');
    const orphan = subOf(JSON.parse(resolvePayloadPaths(stalePayload, orphanCrab)));
    assert.strictEqual('srt_path' in orphan, false, 'không tìm thấy .srt thì phải XOÁ khoá, không giữ đường dẫn chết');
    console.log('  ok  không tìm thấy .srt thì xoá khoá thay vì giữ đường dẫn chết');

    // --- Dự án KHÔNG có phụ đề: không ghi .srt, và xoá luôn srt_path cũ nếu có ---
    const noSub = packageProject({
        payloadJson: JSON.stringify(payload),
        destDir: path.join(TEST_DIR, 'dest-khong-phu-de'),
        projectName: 'Khong Phu De',
        subtitleSrt: '',
    });
    assert.strictEqual(noSub.srtPath, null, 'không có phụ đề thì không ghi tệp .srt nào');
    assert.strictEqual(fs.existsSync(path.join(noSub.projectDir, 'Khong Phu De.srt')), false,
        'không được tạo tệp .srt rỗng');
    assert.strictEqual('srt_path' in subOf(JSON.parse(noSub.payloadJson)), false,
        'không có phụ đề thì srt_path của máy cũ phải bị xoá khỏi gói');
    console.log('  ok  dự án không có phụ đề: không đẻ .srt rỗng, không gói đường dẫn cũ');

    /* ================= BẢN PROXY XEM TRƯỚC ĐI KÈM DỰ ÁN ================= */
    {
        const proxySrc = writeFake(SRC_A, 'preview_proxy.mp4', 9);
        const IDENTITY = { version: 1, concat_version: 5, size_bytes: 12345, duration_ms: 964667, width: 2560, height: 1440 };
        const withProxy = JSON.parse(JSON.stringify(payload));
        withProxy.media.preview_proxy = { identity: IDENTITY };

        const res = packageProject({
            payloadJson: JSON.stringify(withProxy),
            destDir: path.join(TEST_DIR, 'dest-proxy'),
            projectName: 'Co Proxy',
            subtitleSrt: SRT_TEXT,
            previewProxyPath: proxySrc,
        });
        const expected = path.join(res.projectDir, 'Co Proxy.proxy.mp4');
        assert.strictEqual(res.proxyPath, expected, 'proxy phải nằm cạnh .crab và mang đúng tên .crab');
        assert.strictEqual(fs.existsSync(expected), true, 'tệp proxy phải có thật trong gói');
        assert.strictEqual(fs.readFileSync(expected)[0], 9, 'nội dung proxy phải nguyên vẹn');
        assert.strictEqual(fs.existsSync(path.join(res.projectDir, 'Media', 'preview_proxy.mp4')), false,
            'proxy KHÔNG được ném vào Media/ — giao ước là nằm cạnh .crab, cùng tên');

        const packedProxy = JSON.parse(res.payloadJson).media.preview_proxy;
        assert.deepStrictEqual(packedProxy.identity, IDENTITY, 'danh tính phải đi theo nguyên vẹn');
        assert.strictEqual('path' in packedProxy, false,
            'payload chỉ mang DANH TÍNH — đường dẫn suy ra từ chỗ đặt .crab lúc mở');

        // --- chiều mở: gắn lại đường dẫn theo chỗ đặt .crab ---
        const opened = JSON.parse(resolvePayloadPaths(res.payloadJson, res.crabPath));
        assert.strictEqual(opened.media.preview_proxy.path, expected,
            'mở lên phải tìm ra tệp proxy nằm cạnh .crab');

        // Mang cả thư mục gói sang chỗ khác -> proxy vẫn được tìm đúng.
        const movedDir = path.join(TEST_DIR, 'proxy-da-chuyen');
        fs.cpSync(res.projectDir, movedDir, { recursive: true });
        const movedOpened = JSON.parse(resolvePayloadPaths(res.payloadJson, path.join(movedDir, 'Co Proxy.crab')));
        assert.strictEqual(movedOpened.media.preview_proxy.path, path.join(movedDir, 'Co Proxy.proxy.mp4'),
            'chép gói đi chỗ khác thì proxy phải trỏ vào chính chỗ đó');

        /* Tệp proxy BỊ XOÁ: phải bỏ hẳn khoá `path`, KHÔNG để lại đường dẫn chết. Backend chỉ
           cần phân biệt "có tệp để thử" với "không có" — một đường dẫn trỏ vào hư vô bắt nó
           phải đoán thêm một trạng thái thứ ba. */
        fs.rmSync(path.join(movedDir, 'Co Proxy.proxy.mp4'));
        const noFile = JSON.parse(resolvePayloadPaths(res.payloadJson, path.join(movedDir, 'Co Proxy.crab')));
        assert.strictEqual('path' in noFile.media.preview_proxy, false,
            'mất tệp proxy thì bỏ khoá path, danh tính vẫn giữ');
        assert.deepStrictEqual(noFile.media.preview_proxy.identity, IDENTITY);
        console.log('  ok  proxy gói kèm cạnh .crab, mở ở đâu cũng tìm đúng, mất tệp thì bỏ khoá');

        /* Không có tệp proxy lúc gói -> bỏ LUÔN danh tính. Giữ danh tính mà không có tệp là
           hứa với lượt mở sau một thứ không có trong gói. */
        const noProxy = packageProject({
            payloadJson: JSON.stringify(withProxy),
            destDir: path.join(TEST_DIR, 'dest-proxy-thieu'),
            projectName: 'Thieu Proxy',
            previewProxyPath: path.join(SRC_A, 'khong-ton-tai.mp4'),
        });
        assert.strictEqual(noProxy.proxyPath, null, 'không có tệp proxy thì không gói gì');
        assert.strictEqual('preview_proxy' in JSON.parse(noProxy.payloadJson).media, false,
            'không gói được proxy thì phải bỏ luôn danh tính');
        console.log('  ok  không có tệp proxy: bỏ cả danh tính, không hứa suông');
    }

    /* ================= TÀI NGUYÊN THƯ VIỆN (library/) ĐI CÙNG GÓI =================
     *
     * Asset thư viện KHÔNG đi theo đường của media: nó được trỏ bằng `rel_path` trong library/
     * + URL công khai `/library/...`, còn LUT thì trong payload CHỈ CÓ `adjustments.lut.id`,
     * không có một đường dẫn nào để viết lại. Giao ước đó chỉ đúng khi máy nào cũng có ĐÚNG bộ
     * thư viện ấy — mà thư viện thì được bổ sung dần, nên mở gói trên máy có thư viện cũ hơn là
     * block overlay/nhạc/SFX im lặng và LUT không được áp, KHÔNG MỘT DÒNG LỖI NÀO.
     *
     * Đo 5 điều:
     *   1. tài nguyên đang dùng (kể cả .cube của LUT) được chép vào `Library/` GIỮ NGUYÊN
     *      rel_path — không vào `Media/`, vì uniqueName() ở Media/ đổi tên là mất chính cái
     *      khoá dùng để nhận ra "máy đích đã có sẵn";
     *   2. `path` tuyệt đối của máy cũ bị XOÁ khỏi gói (nó được dựng lại lúc mở);
     *   3. mở trên máy TRẮNG thư viện: tệp được khôi phục vào library/ của máy đó và `path`
     *      trỏ đúng vào đấy;
     *   4. máy ĐÃ CÓ sẵn tài nguyên: không chép đè, chỉ gắn lại `path`;
     *   5. rel_path độc (`..`) không được ghi ra ngoài library/ — .crab là tệp người khác gửi tới.
     */
    {
        const LIB_A = path.join(TEST_DIR, 'library-may-A');       // thư viện của máy ĐANG GÓI
        const LIB_B = path.join(TEST_DIR, 'library-may-B');       // máy đích, chưa có gì
        writeFake(path.join(LIB_A, 'SFXs'), 'click.mp3', 11);
        writeFake(path.join(LIB_A, 'Video'), 'be di hoc.mp4', 12);
        writeFake(path.join(LIB_A, 'luts'), 'blush.cube', 13);

        const libPayload = {
            project: {
                history: {
                    editingState: {
                        editingAssets: [
                            {
                                id: 'lib1', source: 'library', rel_path: 'SFXs/click.mp3',
                                url: '/library/SFXs/click.mp3',
                                path: 'D:\\MayCu\\CrabbyCut\\library\\SFXs\\click.mp3',
                            },
                            // Dự án ĐỜI CŨ: chưa có `rel_path`, chỉ có URL công khai (đã mã hoá).
                            {
                                id: 'lib2', source: 'library',
                                url: '/library/Video/be%20di%20hoc.mp4?v=9',
                                path: 'D:\\MayCu\\CrabbyCut\\library\\Video\\be di hoc.mp4',
                            },
                            // rel_path ĐỘC: `..` phải bị bỏ qua, không được chép ra ngoài library/.
                            { id: 'lib3', source: 'library', rel_path: '../../ngoai-vung.txt' },
                        ],
                        // LUT: chỉ có id — `blush` có thật, `khong-co` thì không.
                        editingItems: [
                            { id: 'it1', adjustments: { lut: { id: 'blush', intensity: 100 } } },
                            { id: 'it2', adjustments: { lut: { id: 'khong-co', intensity: 50 } } },
                        ],
                    },
                },
            },
            media: { sources: [], editingAssets: [], main_lane_concat: [] },
        };

        const packerA = createProjectPackager({ libraryDir: LIB_A });
        const res = packerA.packageProject({
            payloadJson: JSON.stringify(libPayload),
            destDir: path.join(TEST_DIR, 'dest-library'),
            projectName: 'Co Thu Vien',
        });
        const packedLib = JSON.parse(res.payloadJson);
        const inPack = (rel) => fs.existsSync(path.join(res.projectDir, 'Library', ...rel.split('/')));

        // --- 1: chép vào Library/, giữ nguyên rel_path, KHÔNG vào Media/ ---
        assert.ok(inPack('SFXs/click.mp3'), 'asset thư viện phải nằm trong Library/ theo đúng rel_path');
        assert.ok(inPack('Video/be di hoc.mp4'), 'dự án đời cũ (chỉ có URL) vẫn phải suy ra được rel_path');
        assert.ok(inPack('luts/blush.cube'), '.cube của LUT đang dùng phải đi cùng gói');
        assert.strictEqual(fs.existsSync(path.join(res.projectDir, 'Media', 'click.mp3')), false,
            'tài nguyên thư viện KHÔNG được ném vào Media/ (uniqueName ở đó đổi tên là mất khoá rel_path)');
        assert.deepStrictEqual(res.libraryMissing, ['luts/khong-co.cube'],
            'LUT không có trong library/ của máy đang gói phải được báo ra');
        assert.strictEqual(res.libraryCopied.length, 3, 'phải gói đúng 3 tài nguyên thư viện');
        assert.ok(res.libraryCopied.every((rel) => !rel.includes('..')),
            'rel_path có `..` phải bị bỏ, không được dựng thành đường dẫn nào');
        assert.ok(res.bytes >= 3 * 1024, 'dung lượng tài nguyên thư viện phải tính vào tổng của gói');

        // --- 2: `path` của máy cũ bị xoá khỏi gói ---
        const packedAssets = packedLib.project.history.editingState.editingAssets;
        assert.strictEqual('path' in packedAssets[0], false,
            '`path` tuyệt đối của máy cũ phải bị xoá — nó được dựng lại từ rel_path lúc mở');
        assert.strictEqual('path' in packedAssets[1], false);
        assert.strictEqual(packedAssets[0].rel_path, 'SFXs/click.mp3', 'rel_path phải giữ nguyên vẹn');
        assert.strictEqual(packedAssets[0].url, '/library/SFXs/click.mp3', 'URL công khai không được đụng');
        console.log('  ok  tài nguyên thư viện (kể cả .cube của LUT) gói vào Library/, xoá path máy cũ');

        // --- 3: mở trên máy TRẮNG thư viện -> khôi phục vào library/ của máy đó ---
        const packerB = createProjectPackager({ libraryDir: LIB_B });
        const report = { restored: [], missing: [], failed: [] };
        const openedB = JSON.parse(packerB.resolvePayloadPaths(res.payloadJson, res.crabPath, { library: report }));
        const localClick = path.join(LIB_B, 'SFXs', 'click.mp3');
        assert.strictEqual(fs.existsSync(localClick), true, 'tệp phải được khôi phục vào library/ của máy đích');
        assert.strictEqual(fs.readFileSync(localClick)[0], 11, 'nội dung tệp khôi phục phải nguyên vẹn');
        assert.strictEqual(fs.existsSync(path.join(LIB_B, 'luts', 'blush.cube')), true,
            '.cube phải được khôi phục — payload không có đường dẫn LUT nào để viết lại, tệp phải CÓ THẬT');
        const openedAssets = openedB.project.history.editingState.editingAssets;
        assert.strictEqual(openedAssets[0].path, localClick,
            '`path` phải trỏ vào library/ của CHÍNH máy này (backend chặn mọi đường dẫn ngoài đó)');
        assert.strictEqual(openedAssets[1].path, path.join(LIB_B, 'Video', 'be di hoc.mp4'));
        assert.strictEqual(report.restored.length, 3, 'phải báo đúng 3 tài nguyên đã khôi phục');
        assert.deepStrictEqual(report.missing, ['luts/khong-co.cube'],
            'thứ không có trong gói lẫn máy đích phải được báo ra — nếu không thì block chỉ im lặng');
        assert.strictEqual(fs.existsSync(path.join(LIB_A, 'SFXs', 'click.mp3')), true,
            'thư viện của máy gói phải còn nguyên (chép, không di chuyển)');
        assert.strictEqual(fs.existsSync(path.join(TEST_DIR, 'ngoai-vung.txt')), false,
            'rel_path có `..` không được ghi ra ngoài library/');
        console.log('  ok  mở trên máy chưa có thư viện: khôi phục vào library/ máy đó, path gắn lại đúng');

        // --- 4: máy ĐÃ CÓ sẵn -> không chép đè, chỉ gắn lại `path` ---
        fs.writeFileSync(localClick, Buffer.alloc(1024, 99));   // bản của máy đích, khác nội dung
        const report2 = { restored: [], missing: [], failed: [] };
        const opened2 = JSON.parse(packerB.resolvePayloadPaths(res.payloadJson, res.crabPath, { library: report2 }));
        assert.strictEqual(fs.readFileSync(localClick)[0], 99,
            'máy đích đã có tệp thì KHÔNG được chép đè — bản của họ có thể mới hơn');
        assert.deepStrictEqual(report2.restored, [], 'lượt mở thứ hai không phải khôi phục gì nữa');
        assert.strictEqual(opened2.project.history.editingState.editingAssets[0].path, localClick);
        console.log('  ok  máy đã có sẵn tài nguyên: không chép đè, chỉ gắn lại path');

        /* --- 5: tệp .crab THƯỜNG (không gói) chép sang máy khác cũng phải được gắn lại path.
         * Đây là đường hay gặp hơn cả đường đóng gói: người dùng chỉ gửi mỗi tệp .crab. */
        const plainLib = JSON.stringify({
            project: { history: { editingState: { editingAssets: [
                { id: 'lib1', source: 'library', rel_path: 'SFXs/click.mp3', url: '/library/SFXs/click.mp3',
                  path: 'D:\\MayCu\\CrabbyCut\\library\\SFXs\\click.mp3' },
            ] } } },
        });
        const loneDir = path.join(TEST_DIR, 'crab-le-loi');
        fs.mkdirSync(loneDir, { recursive: true });
        const relinkedLib = JSON.parse(packerB.resolvePayloadPaths(plainLib, path.join(loneDir, 'Le Loi.crab')));
        assert.strictEqual(relinkedLib.project.history.editingState.editingAssets[0].path, localClick,
            'tệp .crab thường cũng phải được gắn lại path theo library/ của máy đang mở');
        console.log('  ok  .crab thường (không đóng gói) vẫn được gắn lại path thư viện');
    }

    console.log('project package ok');
}

try {
    main();
} catch (error) {
    console.error(error);
    process.exit(1);
}
