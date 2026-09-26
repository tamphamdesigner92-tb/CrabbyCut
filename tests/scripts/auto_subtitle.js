/**
 * Smoke test cho Auto Subtitle (tab Văn bản) — BẢN WINDOWS.
 *
 * Canh bốn chỗ dễ hỏng ÂM THẦM nhất của tính năng:
 *
 *   1. KẾ HOẠCH TRỘN AUDIO (backend/subtitle-jobs.js). Một pad đầu vào của ffmpeg chỉ
 *      được TIÊU THỤ MỘT LẦN: lane chính 40 clip cùng đọc temp_input.mp4 mà viết
 *      "[0:a]" 40 lần là ffmpeg chết. Phải có `asplit` đúng số nhánh.
 *   2. `amix` MẶC ĐỊNH CHIA cho số đầu vào (normalize=1): timeline 10 block thì lời
 *      thoại nhỏ đi 10 lần và Whisper nghe thành im lặng — hỏng không một dòng lỗi.
 *   3. .srt PHẢI ĐÚNG CHUẨN SubRip. Sai một dấu phẩy/dấu chấm ở phần mili giây là cả
 *      tệp không trình phát nào đọc được, mà nhìn bằng mắt thì vẫn "trông đúng".
 *   4. (WINDOWS) Đường dẫn `C:\...` KHÔNG được lọt vào chuỗi filter của ffmpeg — trong
 *      cú pháp filtergraph, `\` là ký tự escape nên một đường dẫn Windows nhét vào đó
 *      là hỏng filter. Chúng phải đi bằng đối số `-i`.
 *
 * Chạy trên DOM giả, không cần trình duyệt, không cần ffmpeg.
 * Chạy: npm run test:auto-subtitle
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
// Phần `await` của mục 2b. Gán ở mục đó, gọi ở CUỐI tệp — xem ghi chú tại chỗ.
let runFinishJobChecks = async () => {};
// Tệp CÓ THẬT bất kỳ: normalizeEntries kiểm tra fs.existsSync trước khi nhận mảnh.
const REAL_FILE_A = path.join(ROOT, 'package.json');
const REAL_FILE_B = path.join(ROOT, 'requirements.txt');

/* ---------- 1. Kế hoạch trộn audio ---------- */
{
  const jobs = require(path.join(ROOT, 'backend', 'subtitle-jobs.js'));
  jobs.init({
    tempDir: path.join(ROOT, 'temp_uploads'),
    // Danh sách trắng thật nằm ở server.js; ở đây chỉ cần đi qua để kiểm phần số học.
    resolveSourcePath: (raw) => String(raw || ''),
  });

  const entries = jobs.normalizeEntries([
    // lane chính: 2 clip liền nhau, cùng đọc bản nối temp_input.mp4
    { source: 'main', source_start: 0, source_end: 4, timeline_start: 0, speed: 1, volume: 100 },
    { source: 'main', source_start: 10, source_end: 13, timeline_start: 4, speed: 1, volume: 100 },
    // lồng tiếng ở lane audio, đặt muộn hơn trên timeline
    { source: 'file', path: REAL_FILE_A, source_start: 0, source_end: 7, timeline_start: 1.5, speed: 1, volume: 80 },
    // nhạc nền đã tắt tiếng -> KHÔNG được bóc băng (nghe không thấy thì không có chữ)
    { source: 'file', path: REAL_FILE_B, source_start: 0, source_end: 30, timeline_start: 0, speed: 1, volume: 0 },
    // mảnh ngắn hơn 50ms: atrim ra khoảng rỗng, ffmpeg báo lỗi
    { source: 'file', path: REAL_FILE_A, source_start: 1, source_end: 1.01, timeline_start: 9, speed: 1, volume: 100 },
    // đường dẫn không tồn tại -> bỏ, không được làm hỏng cả lượt trộn
    { source: 'file', path: path.join(ROOT, 'khong', 'co', 'that.mp3'), source_start: 0, source_end: 5, timeline_start: 2, speed: 1, volume: 100 },
  ], path.join(ROOT, 'package-lock.json'));

  assert.strictEqual(entries.length, 3, `chỉ 3 mảnh hợp lệ, đang ${entries.length}`);
  assert.ok(entries.every((e, i) => i === 0 || e.timelineStart >= entries[i - 1].timelineStart),
    'mảnh phải được sắp theo mốc timeline');
  assert.ok(!entries.some((e) => e.volume === 0), 'block tắt tiếng phải bị loại');
  const voice = entries.find((e) => e.path === REAL_FILE_A);
  assert.ok(Math.abs(voice.volume - 0.8) < 1e-9, 'âm lượng phần trăm phải đổi sang hệ số 0..1');
  assert.ok(Math.abs(voice.timelineEnd - 8.5) < 1e-9, `mốc kết = 1.5 + 7, đang ${voice.timelineEnd}`);
  console.log('  ok  normalizeEntries: loại mảnh câm/ngắn/chết, giữ đúng thứ tự + âm lượng');

  const { filter, files } = jobs.buildMixFilter(entries);
  assert.strictEqual(files.length, 2, 'mỗi FILE một -i, không phải mỗi mảnh một -i');
  assert.ok(filter.includes('asplit=2'),
    'file dùng cho 2 mảnh phải asplit=2 — dùng lại "[0:a]" hai lần là ffmpeg chết');
  assert.ok(/amix=inputs=3[^;]*normalize=0/.test(filter),
    'amix PHẢI normalize=0, nếu không lời thoại bị chia nhỏ đi và Whisper nghe thành im lặng');
  assert.ok(filter.includes('adelay=1500:all=1'),
    'mảnh đặt ở 1.5s phải adelay 1500ms — đây là thứ giữ mốc ASR trùng mốc timeline');
  assert.ok(filter.includes('aresample=16000'), 'Whisper cần 16 kHz mono');
  assert.ok(filter.includes('alimiter'), 'giữ nguyên mức thì phải chặn đỉnh, cắt đỉnh cũng làm ASR sai');
  // Mảnh nằm ở mốc 0 KHÔNG được chèn adelay=0 (ffmpeg coi là lệnh vô nghĩa/nhiễu).
  assert.ok(!filter.includes('adelay=0:'), 'mảnh ở mốc 0 không cần adelay');
  console.log('  ok  buildMixFilter: asplit đúng số nhánh, adelay đúng mốc, amix không tự chia nhỏ');

  /* WINDOWS: đường dẫn phải đi bằng `-i`, TUYỆT ĐỐI không nằm trong chuỗi filter.
   * Trong cú pháp filtergraph, `\` là ký tự escape và `:` ngăn tham số — một đường dẫn
   * `C:\Users\...` nhét vào đó làm ffmpeg dựng sai filter, và thông báo lỗi của nó không
   * hề nhắc tới đường dẫn nên rất khó lần ra. */
  assert.ok(!filter.includes(REAL_FILE_A) && !filter.includes('package.json'),
    'đường dẫn nguồn KHÔNG được lọt vào filter_complex — chúng phải đi bằng đối số -i');
  assert.deepStrictEqual(files.map((f) => f.path).sort(),
    [path.join(ROOT, 'package-lock.json'), REAL_FILE_A].sort(),
    'danh sách -i phải đúng các file thật đang dùng');
  console.log('  ok  (Windows) đường dẫn đi bằng -i, không lọt vào chuỗi filter');

  // Tốc độ block: atempo chỉ nhận 0.5–2.0 mỗi lượt nên phải xâu chuỗi.
  assert.deepStrictEqual(jobs.atempoChain(1), [], 'tốc độ thường thì không thêm filter nào');
  assert.deepStrictEqual(jobs.atempoChain(4), ['atempo=2.0', 'atempo=2.000000']);
  assert.strictEqual(jobs.atempoChain(0.25)[0], 'atempo=0.5');
  console.log('  ok  atempoChain: tốc độ ngoài 0.5–2.0 được xâu chuỗi');

  /* Huỷ job phải giết CẢ CÂY tiến trình trên Windows: sidecar Python tự sinh ffmpeg để
   * tiền xử lý audio, mà kill(python) trên Windows KHÔNG giết ffmpeg con — nó sống tiếp và
   * giữ file WAV, lượt sau xoá file đó là EPERM. Ở đây chỉ canh HỢP ĐỒNG (hàm tồn tại và
   * nuốt được tiến trình đã chết); đường taskkill thật đo bằng tay. */
  assert.strictEqual(typeof jobs.killProcessTree, 'function', 'phải có đường giết cả cây tiến trình');
  assert.doesNotThrow(() => {
    jobs.killProcessTree(null);
    jobs.killProcessTree({ pid: 0, exitCode: 0 });   // đã thoát -> không được đụng vào
  }, 'killProcessTree không được ném với tiến trình rỗng / đã chết');
  console.log('  ok  killProcessTree: có mặt và không ném với tiến trình đã chết');
}

/* ---------- 2. Panel: .srt + chia phụ đề ---------- */
function makeEnv() {
  const el = () => ({
    innerHTML: '', id: '', dataset: {}, value: '',
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, appendChild: () => {}, closest: () => null,
  });
  const doc = {
    getElementById: () => null,
    createElement: () => el(),
    head: { appendChild: () => {} },
    querySelector: () => null,
  };
  const win = {
    document: doc,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, console,
    showToast: () => {},
    /* ER giả: chỉ cần splitTextToMaxLines (chunkSpansForScene dùng nó để chia mảnh).
     * Cắt sau từ thứ 3 = đóng vai "gói quá 2 dòng thì sang mảnh mới". */
    EditingRuntime: {
      splitTextToMaxLines: (text) => {
        const w = String(text).split(/\s+/).filter(Boolean);
        return w.length <= 3 ? [w.join(' ')] : [w.slice(0, 3).join(' '), w.slice(3).join(' ')];
      },
    },
  };
  win.window = win;
  return win;
}

function loadScript(win, relPath) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'console', 'API_BASE', src)(
    win, win.document, win.fetch, () => 0, () => {}, setTimeout, clearTimeout, console, '/api');
}

{
  const win = makeEnv();
  /* Nhánh Windows CHƯA có ai-video-panel.js, nên luật chia phụ đề (chunkSpansForScene) sống
   * ngay trong auto-subtitle.js — nạp MỘT tệp là đủ. Trên nhánh macOS hàm đó ở
   * ai-video-panel.js và auto-subtitle.js ưu tiên dùng bản của nó; hai bản phải khớp nhau. */
  loadScript(win, 'static/js/auto-subtitle.js');
  const panel = win.AutoSubtitlePanel;
  assert.ok(panel, 'auto-subtitle.js phải mở window.AutoSubtitlePanel');
  assert.strictEqual(typeof panel.chunkSpansForScene, 'function',
    'luật chia phụ đề phải có sẵn khi KHÔNG có ai-video-panel.js');

  /* --- mốc .srt --- */
  assert.strictEqual(panel.srtTimestamp(0), '00:00:00,000');
  assert.strictEqual(panel.srtTimestamp(1.5), '00:00:01,500');
  assert.strictEqual(panel.srtTimestamp(3661.234), '01:01:01,234');
  // Dấu PHẨY trước mili giây (SubRip), không phải dấu chấm (đó là WebVTT).
  assert.ok(panel.srtTimestamp(2.25).includes(','), 'SubRip dùng dấu phẩy cho mili giây');
  console.log('  ok  srtTimestamp: đúng khuôn HH:MM:SS,mmm');

  /* --- thân tệp .srt --- */
  const srt = panel.buildSrt([
    { start: 0.5, end: 2.0, text: 'Xin chào\ncác bạn' },
    { start: 2.0, end: 3.25, text: 'Hôm nay trời đẹp' },
    { start: 4, end: 5, text: '   ' },   // rỗng -> bỏ, KHÔNG được đánh số thừa
  ]);
  const blocks = srt.trim().split('\n\n');
  assert.strictEqual(blocks.length, 2, 'phụ đề rỗng phải bị loại');
  assert.strictEqual(blocks[0].split('\n')[0], '1', 'số thứ tự bắt đầu từ 1');
  assert.strictEqual(blocks[1].split('\n')[0], '2', 'số thứ tự phải LIỀN MẠCH sau khi loại câu rỗng');
  assert.strictEqual(blocks[0].split('\n')[1], '00:00:00,500 --> 00:00:02,000');
  assert.ok(blocks[0].endsWith('Xin chào\ncác bạn'), 'xuống dòng trong phụ đề phải giữ nguyên');
  console.log('  ok  buildSrt: đánh số liền mạch, mốc đúng khuôn, giữ 2 dòng');

  /* --- câu ASR -> phụ đề --- */
  const cues = panel.cuesFromSegments([
    {
      start: 0.2, end: 3.6, text: 'một hai ba bốn năm',
      words: [
        { text: 'một', start: 0.2, end: 0.6 },
        { text: 'hai', start: 0.6, end: 1.0 },
        { text: 'ba', start: 1.0, end: 1.4 },
        { text: 'bốn', start: 2.9, end: 3.2 },
        { text: 'năm', start: 3.2, end: 3.6 },
      ],
    },
    // Câu SAU bắt đầu TRƯỚC khi câu trước dứt (mốc ASR lệch là chuyện thường).
    { start: 3.4, end: 4.9, text: 'câu hai' },
    { start: 5.0, end: 5.2, text: '' },          // rỗng -> bỏ
    { start: 9.0, end: 8.0, text: 'mốc ngược' }, // end < start -> bỏ
  ]);
  assert.strictEqual(cues.length, 3, `2 mảnh của câu 1 + 1 câu 2 = 3, đang ${cues.length}`);
  assert.strictEqual(cues[0].text, 'một hai ba');
  assert.ok(Math.abs(cues[0].end - 1.4) < 1e-6, 'mảnh 1 tắt lúc từ "ba" dứt, không kéo qua khoảng lặng');
  assert.ok(Math.abs(cues[1].start - 2.9) < 1e-6, 'mảnh 2 bật đúng lúc từ "bốn" được đọc');
  for (let i = 1; i < cues.length; i += 1) {
    assert.ok(cues[i].start >= cues[i - 1].end - 1e-9,
      'phụ đề KHÔNG được chồng mốc — chồng là mỗi block bị đẩy sang một lane mới');
    assert.ok(cues[i].end > cues[i].start, 'mỗi phụ đề phải có thời lượng dương');
  }
  console.log('  ok  cuesFromSegments: chia theo mốc từng từ, ép đơn điệu, loại câu hỏng');

  /* --- câu KHÔNG có mốc từng từ: chia theo tỉ lệ ký tự, vẫn phải liền mạch --- */
  const noWords = panel.cuesFromSegments([{ start: 0, end: 4, text: 'một hai ba bốn năm sáu' }]);
  assert.strictEqual(noWords.length, 2, 'vẫn phải cắt thành 2 mảnh dù thiếu mốc từng từ');
  assert.ok(Math.abs(noWords[0].start - 0) < 1e-9 && Math.abs(noWords[1].end - 4) < 1e-9,
    'hai đầu của câu phải giữ nguyên');
  assert.ok(noWords[1].start >= noWords[0].end - 1e-9, 'không được chồng mốc');
  console.log('  ok  cuesFromSegments: thiếu mốc từng từ thì rơi về tỉ lệ ký tự');

  /* --- .srt phải đi theo BLOCK ĐANG CÓ, không theo ảnh chụp lúc bóc băng ---
   * Người dùng sửa chữ / kéo mốc từng block phụ đề sau khi tạo là chuyện bình thường.
   * Ghi .srt theo `subtitleState.cues` cũ thì tệp lệch với video ngay lần sửa đầu tiên. */
  win.EditingRuntime.getSubtitleState = () => ({
    cues: [{ start: 0, end: 2, text: 'BẢN CHỤP CŨ' }],
    item_ids: ['item_text_1'],
  });
  win.EditingRuntime.subtitleCuesFromItems = () => [
    { start: 0.4, end: 2.4, text: 'bản người dùng đã sửa' },
  ];
  const live = panel.currentCues();
  assert.strictEqual(live.length, 1);
  assert.strictEqual(live[0].text, 'bản người dùng đã sửa', 'phải ưu tiên block SỐNG trên timeline');
  // Dự án cũ / block đã bị xoá hết -> rơi về bản chụp thay vì trả tệp rỗng.
  win.EditingRuntime.subtitleCuesFromItems = () => [];
  assert.strictEqual(panel.currentCues()[0].text, 'BẢN CHỤP CŨ', 'không còn block thì rơi về cues đã lưu');
  console.log('  ok  currentCues: .srt bám theo block đang có, có bản dự phòng');

  /* --- .srt dựng từ chính các cue vừa chia: vòng khép kín --- */
  const roundTrip = panel.buildSrt(cues).trim().split('\n\n');
  assert.strictEqual(roundTrip.length, cues.length, 'mỗi cue một khối .srt');
  console.log('  ok  cue -> .srt khép kín');
}

/* ---------- 2b. finishJob: CHẠY THẬT đường sau khi bóc băng xong ----------
 *
 * VÌ SAO PHẢI CÓ RIÊNG MỤC NÀY. Mọi assert phía trên đều gọi các hàm THUẦN
 * (buildSrt / cuesFromSegments / currentCues). `finishJob` thì không thuần — nó dựng block
 * lên timeline — nên trước đây không test nào chạm vào nó, và một `ReferenceError` sống
 * trong đó đã ra tới tay người dùng: biến `language` bị DÙNG ở dòng trên dòng `const` khai
 * nó. `const` không hoisting, nên JS ném "Cannot access 'language' before initialization"
 * — và ném ĐÚNG LÚC job đã chạy xong 100%, tức người dùng chờ trọn lượt bóc băng rồi mới
 * thấy một dòng đỏ và không có phụ đề nào. `node --check` KHÔNG bắt được lỗi này (nó đúng
 * cú pháp); chỉ có chạy thật mới bắt được.
 *
 * Nên: chạy finishJob với một EditingRuntime giả đủ dùng, cho cả hai ngôn ngữ Latin và CJK.
 */
{
  const win = makeEnv();
  const placed = [];
  let subtitleState = null;
  const ER = win.EditingRuntime;
  ER.subtitleTextStyle = (lang) => ({
    font_family: lang === 'zh' ? 'Noto Sans SC' : 'Nunito',
    font_size: 58,
    font_weight: 600,
    bg_enabled: true,
  });
  ER.beginHistoryBatch = () => () => {};
  ER.removeSubtitleItems = () => 0;
  ER.addTextItem = (placement, options) => {
    placed.push({ start: placement.start, text: options.text, style: options.style });
    return { id: `item_text_${placed.length}`, duration: options.duration };
  };
  ER.setSubtitleState = (next) => { subtitleState = next; return next; };
  ER.getSubtitleState = () => subtitleState;
  ER.subtitleCuesFromItems = () => [];
  ER.renderAll = () => {};
  ER.renderEditPanel = () => {};

  loadScript(win, 'static/js/auto-subtitle.js');
  const panel = win.AutoSubtitlePanel;
  assert.strictEqual(typeof panel.finishJob, 'function', 'finishJob phải mở ra để test chạy được');

  const job = {
    warnings: [],
    result: {
      engine: 'faster_whisper',
      language: 'zh',
      cache_hit: false,
      segments: [{ start: 0, end: 3, text: 'một hai ba bốn năm sáu', words: [] }],
    },
  };
  /* finishJob là `async`, mà mục 3 phía dưới chạy đồng bộ — nên phần await được gói vào một
     hàm và gọi ở CUỐI tệp, sau khi mọi mục đồng bộ đã chạy xong. Đừng đổi thành `return`:
     tệp này là CommonJS nên `return` ở đây hợp lệ về cú pháp, nhưng nó thoát cả module và
     mục 3 sẽ bị bỏ qua trong im lặng — test xanh mà không kiểm gì. */
  runFinishJobChecks = async () => {
    // Không được ném. Đây chính là assert đã thiếu.
    await panel.finishJob(job);
    assert.strictEqual(panel.state.lastError, '', `finishJob không được để lại lỗi: ${panel.state.lastError}`);
    assert.ok(placed.length >= 1, 'phải dựng được ít nhất một block phụ đề');

    /* Ngôn ngữ dùng để chọn font phải là ngôn ngữ BACKEND BÁO VỀ ('zh'), không phải ô đang
       chọn trong menu (mặc định 'vi'). Sai chỗ này là video tiếng Trung ra 300 block ô vuông. */
    assert.strictEqual(placed[0].style.font_family, 'Noto Sans SC',
      'font phải theo job.result.language, không theo ô đang chọn trong menu');
    assert.strictEqual(subtitleState.language, 'zh', 'ngôn ngữ thật phải được ghi vào subtitleState');
    assert.strictEqual(subtitleState.sync_style, true, 'bộ phụ đề mới phải bật sẵn "Đồng bộ các subtitle"');
    assert.strictEqual(subtitleState.item_ids.length, placed.length, 'phải nhớ id của mọi block vừa dựng');
    console.log('  ok  finishJob chạy trọn vẹn: dựng block, font theo ngôn ngữ backend báo về');

    /* "Tự nhận diện": ô menu là chuỗi 'auto' — KHÔNG được dùng nó để chọn font. */
    placed.length = 0;
    panel.state.language = 'auto';
    await panel.finishJob({ warnings: [], result: { ...job.result, language: 'vi' } });
    assert.strictEqual(panel.state.lastError, '', 'lượt "Tự nhận diện" cũng không được ném');
    assert.strictEqual(placed[0].style.font_family, 'Nunito',
      '"Tự nhận diện" phải lấy font theo ngôn ngữ Whisper nghe ra, không theo chuỗi "auto"');
    console.log('  ok  "Tự nhận diện" lấy font theo ngôn ngữ Whisper nghe ra');

    /* Backend cũ / whisper.cpp không trả `language` -> rơi về ô đang chọn, vẫn không ném. */
    placed.length = 0;
    panel.state.language = 'vi';
    await panel.finishJob({ warnings: [], result: { engine: 'x', segments: job.result.segments } });
    assert.strictEqual(panel.state.lastError, '', 'thiếu `language` trong job.result cũng không được ném');
    assert.strictEqual(placed[0].style.font_family, 'Nunito', 'thiếu `language` thì rơi về ô đang chọn');
    console.log('  ok  job.result thiếu `language` vẫn chạy, rơi về ô đang chọn');
  };
}

/* ---------- 3. (WINDOWS) Kênh tiến độ thật của faster-whisper ---------- */
{
  /* Trên Windows, ASR chạy bằng faster-whisper — KHÔNG có thanh tqdm nào để đọc như nhánh
   * macOS. Sidecar phát `{"type":"progress","ratio":…}` trên kênh NDJSON sẵn có, và
   * runPythonSidecar đọc `ratio` ở đó. Canh HAI ĐẦU của hợp đồng này vì lệch một đầu là
   * thanh tiến trình đứng im mà không có lỗi nào báo. */
  const sidecarSrc = fs.readFileSync(path.join(ROOT, 'asr', 'windows_faster_whisper_sidecar.py'), 'utf8');
  assert.ok(/def emit_ratio\(/.test(sidecarSrc), 'sidecar Windows phải có emit_ratio');
  assert.ok(/print\(json\.dumps\(\{"type": "progress", "ratio": value\}\), flush=True\)/.test(sidecarSrc),
    'ratio phải đi bằng NDJSON có flush — không flush thì Node không thấy gì tới lúc sidecar thoát');
  assert.ok(/for seg in segments:/.test(sidecarSrc),
    'phải DUYỆT TAY generator segment: list-comprehension không có chỗ nào để phát tiến độ');
  assert.ok(/PROGRESS_RATIO_ENABLED = os\.getenv\("CRAB_ASR_PROGRESS"\) == "1"/.test(sidecarSrc),
    'chỉ phát khi backend xin — luồng Upload/Magic Fill không được thêm dòng nào vào stdout');
  assert.ok(/reset_ratio\(\)/.test(sidecarSrc),
    'OOM làm lượt giải mã chạy lại từ đầu -> phải đặt lại mốc nhịp, nếu không thanh đứng im');

  const serverSrc = fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8');
  assert.ok(/Number\.isFinite\(Number\(evt\.ratio\)\)/.test(serverSrc),
    'runPythonSidecar phải đọc khoá `ratio` của NDJSON');
  assert.ok(/CRAB_ASR_PROGRESS: '1'/.test(serverSrc),
    'chỉ bật biến môi trường khi người gọi truyền onProgress');
  assert.ok(/windowsHide: true/.test(serverSrc),
    'spawn sidecar phải windowsHide, nếu không mỗi lượt bóc băng nháy một cửa sổ console đen');
  assert.ok(/runWindowsFasterWhisper\(videoPath, referenceScript, transcribeMode, asrModel, options\)/.test(serverSrc),
    'nhánh Windows của transcribeVideo phải chuyền options xuống — thiếu là thanh mất phần trăm');
  console.log('  ok  (Windows) hợp đồng tiến độ sidecar <-> backend còn nguyên hai đầu');
}

runFinishJobChecks()
    .then(() => console.log('auto_subtitle: PASS'))
    .catch((error) => { console.error(error); process.exitCode = 1; });
