/* Đọc tệp phụ đề có sẵn (Văn bản → Local Subtitle): .srt, .vtt, .ass/.ssa, .xml/.ttml/.dfxp,
 * .lrc, .sbv → danh sách cue { start, end, text } tính bằng GIÂY.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * BA QUYẾT ĐỊNH, ĐỌC TRƯỚC KHI SỬA
 *
 * 1. HÀM THUẦN, KHÔNG ĐỤNG DOM. TTML/DFXP là XML nhưng vẫn đọc bằng regex chứ không bằng
 *    DOMParser: nhờ vậy test chạy được bằng node trần (tests/scripts/subtitle_import.js),
 *    và một tệp XML hơi lệch chuẩn (thiếu namespace, thực thể lạ) không làm cả lượt nhập
 *    chết vì "parsererror" — phụ đề xuất từ các phần mềm khác nhau lệch chuẩn là chuyện
 *    thường ngày.
 *
 * 2. KHÔNG CÓ HAI CUE CHỒNG NHAU TRONG MỘT BỘ (xem tidyCues). Premiere cũng cấm caption
 *    chồng nhau trên cùng một track. Ở CrabbyCut lý do còn cụ thể hơn: hai block text chồng
 *    mốc là block sau bị đẩy sang một lane mới, và tệp .srt làm tròn mili giây thường chồng
 *    nhau 1–40 ms ở MỌI chỗ chuyển câu → timeline thành cái thang. Chồng một chút = cắt đuôi
 *    câu trước; bắt đầu gần như cùng lúc (hai người nói) = gộp thành một block hai dòng —
 *    không câu chữ nào bị mất.
 *
 * 3. MÃ HOÁ KÝ TỰ: BOM trước, rồi UTF-8 "nghiêm", rồi mới hạ xuống Windows-1258 — và BÁO
 *    cho người dùng biết khi phải hạ. Tệp .srt tiếng Việt đời cũ hay lưu bằng bảng mã
 *    Windows; đọc nó như UTF-8 là ra một rừng ký tự "�" mà không lỗi nào.
 * ────────────────────────────────────────────────────────────────────────────
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SubtitleFormats = api;
}(typeof window !== 'undefined' ? window : null, function () {
    'use strict';

    const EXTENSIONS = ['srt', 'vtt', 'ass', 'ssa', 'xml', 'ttml', 'dfxp', 'lrc', 'sbv'];
    const ACCEPT = EXTENSIONS.map((ext) => `.${ext}`).join(',');

    // ── Mã hoá ký tự ────────────────────────────────────────────────────────

    /* `bytes` = Uint8Array | ArrayBuffer. Trả { text, encoding, fallback } — `fallback` = đã
     * phải đoán bảng mã, nơi gọi nên nói cho người dùng biết. */
    function decodeSubtitleBytes(input) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
        const decode = (label, view, fatal) => new TextDecoder(label, { fatal: !!fatal }).decode(view);
        if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
            return { text: decode('utf-8', bytes.subarray(3)), encoding: 'utf-8', fallback: false };
        }
        if (bytes[0] === 0xFF && bytes[1] === 0xFE) {
            return { text: decode('utf-16le', bytes.subarray(2)), encoding: 'utf-16le', fallback: false };
        }
        if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
            return { text: decode('utf-16be', bytes.subarray(2)), encoding: 'utf-16be', fallback: false };
        }
        /* UTF-16 KHÔNG BOM (Notepad đời cũ, vài phần mềm làm phụ đề): chữ Latin mã hoá thành
           cặp [ký tự, 0x00]. Nửa số byte lẻ là 0 thì gần như chắc chắn là UTF-16LE — một tệp
           văn bản 8-bit thật không bao giờ chứa byte 0. */
        const sample = Math.min(bytes.length, 4000);
        if (sample >= 4) {
            let zeroOdd = 0;
            let zeroEven = 0;
            for (let i = 0; i < sample; i += 1) {
                if (bytes[i] !== 0) continue;
                if (i % 2) zeroOdd += 1; else zeroEven += 1;
            }
            if (zeroOdd > sample * 0.3) return { text: decode('utf-16le', bytes), encoding: 'utf-16le', fallback: false };
            if (zeroEven > sample * 0.3) return { text: decode('utf-16be', bytes), encoding: 'utf-16be', fallback: false };
        }
        try {
            return { text: decode('utf-8', bytes, true), encoding: 'utf-8', fallback: false };
        } catch (_) {
            return { text: decode('windows-1258', bytes), encoding: 'windows-1258', fallback: true };
        }
    }

    // ── Tiện ích chung ─────────────────────────────────────────────────────

    const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    function decodeEntities(text) {
        return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
            if (name[0] === '#') {
                const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
                return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
            }
            const hit = ENTITIES[name.toLowerCase()];
            return hit == null ? whole : hit;
        });
    }

    /* Thẻ định dạng kiểu HTML trong SRT/VTT (<i>, <b>, <font color>, <c.vang>, <v Người nói>)
     * và khối override ASS lọt vào SRT ({\an8}). Block text của CrabbyCut không có định dạng
     * từng đoạn, nên giữ CHỮ, bỏ THẺ. <rt> (phiên âm ruby) bỏ cả nội dung: giữ lại là chữ
     * phiên âm bị dán liền vào chữ gốc. */
    function stripMarkup(text) {
        return String(text || '')
            .replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]*>/g, '')
            .replace(/\{\\[^}]*\}/g, '');
    }

    /* Chữ của một cue: bỏ khoảng trắng thừa trong từng dòng, bỏ dòng trống, GIỮ xuống dòng
     * của tệp — người làm phụ đề ngắt dòng có chủ ý (song ngữ một dòng một thứ tiếng). */
    function cleanCueText(text) {
        return String(text || '')
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map((line) => line.replace(/[\t  ]+/g, ' ').trim())
            .filter(Boolean)
            .join('\n');
    }

    /* "01:02:03,456" | "02:03.456" | "1:02:03.45" | "01:02:03:12" (khung, cần fps) → giây.
     * Phần lẻ có bao nhiêu chữ số thì là bấy nhiêu phần của giây (".5" = 500 ms, ".45" = 450
     * ms): SRT viết tay hay thiếu số 0 ở cuối, đọc nó như mili giây là lệch gấp mười lần. */
    function parseClock(raw, fps) {
        const str = String(raw || '').trim();
        let m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d+))?$/.exec(str);
        if (m) {
            const h = Number(m[1] || 0);
            const frac = m[4] ? Number(`0.${m[4]}`) : 0;
            return (h * 3600) + (Number(m[2]) * 60) + Number(m[3]) + frac;
        }
        m = /^(\d+):(\d{1,2}):(\d{1,2}):(\d{1,3})(?:\.\d+)?$/.exec(str);
        if (m) {
            const rate = Number(fps) > 0 ? Number(fps) : 30;
            return (Number(m[1]) * 3600) + (Number(m[2]) * 60) + Number(m[3]) + (Number(m[4]) / rate);
        }
        return NaN;
    }

    function linesOf(text) {
        return String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    }

    // ── SubRip (.srt) & WebVTT (.vtt) ──────────────────────────────────────

    const ARROW_RE = /^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/;

    /* Chung một bộ đọc cho SRT và VTT: cả hai là "dòng mốc có mũi tên, rồi các dòng chữ tới
     * dòng trống". Không dựa vào dòng số thứ tự của SRT — tệp thực tế hay thiếu, lặp hoặc sai
     * số thứ tự, và mốc thời gian mới là thứ quyết định. */
    function parseArrowCues(text, { vtt = false } = {}) {
        const lines = linesOf(text);
        const cues = [];
        let i = 0;
        if (vtt) {
            // Bỏ phần đầu "WEBVTT ..." tới dòng trống đầu tiên.
            while (i < lines.length && lines[i].trim()) i += 1;
        }
        while (i < lines.length) {
            const line = lines[i];
            if (vtt && /^(NOTE|STYLE|REGION)\b/.test(line.trim())) {
                while (i < lines.length && lines[i].trim()) i += 1;
                continue;
            }
            const m = ARROW_RE.exec(line);
            if (!m) { i += 1; continue; }
            const start = parseClock(m[1]);
            const end = parseClock(m[2]);
            i += 1;
            const body = [];
            while (i < lines.length && lines[i].trim() && !ARROW_RE.test(lines[i])) {
                body.push(lines[i]);
                i += 1;
            }
            /* Dòng cuối của khối có thể là SỐ THỨ TỰ của cue kế tiếp khi tệp thiếu dòng trống
               giữa hai cue — gặp mũi tên ngay dòng sau thì dòng số đó không phải chữ. */
            if (!vtt && body.length && /^\d+$/.test(body[body.length - 1].trim()) && ARROW_RE.test(lines[i] || '')) {
                body.pop();
            }
            let raw = body.join('\n');
            if (vtt) raw = raw.replace(/<\d{1,2}:\d{2}(?::\d{2})?\.\d+>/g, '');
            if (Number.isFinite(start) && Number.isFinite(end)) {
                cues.push({ start, end, text: cleanCueText(decodeEntities(stripMarkup(raw))) });
            }
        }
        return cues;
    }

    // ── Advanced SubStation Alpha (.ass / .ssa) ────────────────────────────

    /* Chữ của một dòng Dialogue: bỏ khối override {…}, \N \n → xuống dòng, \h → dấu cách.
     * Khối ở chế độ vẽ ({\p1}…{\p0}) là HÌNH VECTOR viết bằng lệnh "m 0 0 l 100 0…", không
     * phải chữ — để lọt thì phụ đề hiện ra một chuỗi toạ độ. */
    function assText(raw) {
        let out = '';
        let drawing = false;
        const re = /\{([^}]*)\}|([^{]+)/g;
        let m;
        while ((m = re.exec(raw))) {
            if (m[1] != null) {
                const p = /\\p(\d+)/.exec(m[1]);
                if (p) drawing = Number(p[1]) > 0;
                continue;
            }
            if (!drawing) out += m[2];
        }
        return out.replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ');
    }

    function parseAss(text) {
        const lines = linesOf(text);
        const cues = [];
        let inEvents = false;
        let fields = null;
        for (const line of lines) {
            const trimmed = line.trim();
            if (/^\[.+\]$/.test(trimmed)) {
                inEvents = /^\[events\]$/i.test(trimmed);
                continue;
            }
            if (!inEvents) continue;
            if (/^format\s*:/i.test(trimmed)) {
                fields = trimmed.replace(/^format\s*:/i, '').split(',').map((f) => f.trim().toLowerCase());
                continue;
            }
            if (!/^dialogue\s*:/i.test(trimmed)) continue;   // "Comment:" là ghi chú của người làm phụ đề
            const order = fields || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
            const body = trimmed.replace(/^dialogue\s*:\s*/i, '');
            /* Tách ĐÚNG (số trường − 1) dấu phẩy: trường Text đứng cuối và được phép chứa dấu
               phẩy — tách hết là câu bị cụt ở dấu phẩy đầu tiên. */
            const parts = [];
            let rest = body;
            for (let k = 0; k < order.length - 1; k += 1) {
                const at = rest.indexOf(',');
                if (at < 0) break;
                parts.push(rest.slice(0, at));
                rest = rest.slice(at + 1);
            }
            parts.push(rest);
            const get = (name) => {
                const idx = order.indexOf(name);
                return idx >= 0 ? parts[idx] : undefined;
            };
            const start = parseClock(get('start'));
            const end = parseClock(get('end'));
            const raw = get('text');
            if (!Number.isFinite(start) || !Number.isFinite(end) || raw == null) continue;
            cues.push({ start, end, text: cleanCueText(assText(raw)) });
        }
        return cues;
    }

    // ── Timed Text (.xml / .ttml / .dfxp) ──────────────────────────────────

    function xmlAttr(tag, name) {
        // Bỏ qua tiền tố namespace: "ttp:frameRate" và "frameRate" cùng khớp "frameRate".
        const re = new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
        const m = re.exec(tag);
        return m ? (m[2] != null ? m[2] : m[3]) : null;
    }

    /* Biểu thức thời gian TTML: clock-time ("00:00:01.500", "00:00:01:12" theo khung) hoặc
     * offset-time ("1.5s", "1500ms", "36f", "10000000t"). Khung và tick phải tra frameRate /
     * tickRate trên thẻ <tt> — thiếu thì theo mặc định của chuẩn (30 fps; tick = frameRate ×
     * subFrameRate, hoặc 1 nếu không khai frameRate). */
    function ttmlTime(raw, rates) {
        const str = String(raw || '').trim();
        if (!str) return NaN;
        const m = /^([\d.]+)(h|m|s|ms|f|t)$/.exec(str);
        if (m) {
            const n = Number(m[1]);
            switch (m[2]) {
                case 'h': return n * 3600;
                case 'm': return n * 60;
                case 's': return n;
                case 'ms': return n / 1000;
                case 'f': return n / rates.frameRate;
                case 't': return n / rates.tickRate;
                default: return NaN;
            }
        }
        return parseClock(str, rates.frameRate);
    }

    function parseTtml(text) {
        const src = String(text || '');
        const ttTag = (/<(?:[\w-]+:)?tt\b[^>]*>/i.exec(src) || [''])[0];
        const frameRateAttr = Number(xmlAttr(ttTag, 'frameRate'));
        const multiplier = String(xmlAttr(ttTag, 'frameRateMultiplier') || '').split(/\s+/).map(Number);
        let frameRate = frameRateAttr > 0 ? frameRateAttr : 30;
        if (multiplier.length === 2 && multiplier[0] > 0 && multiplier[1] > 0) frameRate = frameRate * multiplier[0] / multiplier[1];
        const subFrameRate = Number(xmlAttr(ttTag, 'subFrameRate')) > 0 ? Number(xmlAttr(ttTag, 'subFrameRate')) : 1;
        const tickRate = Number(xmlAttr(ttTag, 'tickRate')) > 0
            ? Number(xmlAttr(ttTag, 'tickRate'))
            : (frameRateAttr > 0 ? frameRate * subFrameRate : 1);
        const rates = { frameRate, tickRate };

        const cues = [];
        const re = /<((?:[\w-]+:)?p)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;
        let m;
        while ((m = re.exec(src))) {
            const attrs = m[2];
            const start = ttmlTime(xmlAttr(attrs, 'begin'), rates);
            let end = ttmlTime(xmlAttr(attrs, 'end'), rates);
            if (!Number.isFinite(end)) {
                const dur = ttmlTime(xmlAttr(attrs, 'dur'), rates);
                if (Number.isFinite(start) && Number.isFinite(dur)) end = start + dur;
            }
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            /* Xuống dòng trong TTML là <br/>, còn ký tự xuống dòng thật trong mã nguồn XML chỉ
               là khoảng trắng để thụt lề — phải gộp chúng thành dấu cách TRƯỚC khi đổi <br/>,
               nếu không một câu được thụt lề đẹp trong tệp sẽ vỡ thành nhiều dòng. */
            const body = m[3].replace(/\s*[\r\n]+\s*/g, ' ').replace(/<(?:[\w-]+:)?br\b[^>]*\/?>/gi, '\n');
            cues.push({ start, end, text: cleanCueText(decodeEntities(body.replace(/<[^>]*>/g, ''))) });
        }
        return cues;
    }

    // ── Lời bài hát (.lrc) ─────────────────────────────────────────────────

    /* LRC chỉ có mốc BẮT ĐẦU của mỗi dòng: dòng kéo dài tới mốc của dòng kế tiếp. Dòng rỗng
     * có mốc là dấu "hết câu" (nhiều trình soạn lời xuất như vậy) — dùng làm mốc kết rồi bỏ.
     * Dòng cuối cùng không có gì chặn sau nên cho LRC_LAST_LINE_SECONDS.
     * `[offset:+500]` = hiện lời SỚM hơn 500 ms (đúng chuẩn LRC: số dương đẩy lời lên trước). */
    const LRC_LAST_LINE_SECONDS = 4;

    function parseLrc(text) {
        const stamps = [];
        let offset = 0;
        for (const line of linesOf(text)) {
            const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(line);
            if (off) { offset = Number(off[1]) / 1000; continue; }
            const times = [];
            let rest = line;
            let m;
            while ((m = /^\s*\[(\d+):(\d{1,2})(?:[.:](\d+))?\]/.exec(rest))) {
                times.push((Number(m[1]) * 60) + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0));
                rest = rest.slice(m[0].length);
            }
            if (!times.length) continue;
            // Lời "enhanced" có mốc từng từ <00:12.34> — bỏ mốc, giữ chữ.
            const words = cleanCueText(rest.replace(/<\d+:\d{1,2}(?:[.:]\d+)?>/g, ''));
            times.forEach((t) => stamps.push({ time: t - offset, text: words }));
        }
        stamps.sort((a, b) => a.time - b.time);
        const cues = [];
        stamps.forEach((stamp, index) => {
            if (!stamp.text) return;
            const next = stamps[index + 1];
            const end = next ? next.time : stamp.time + LRC_LAST_LINE_SECONDS;
            cues.push({ start: stamp.time, end, text: stamp.text });
        });
        return cues;
    }

    // ── YouTube SubViewer (.sbv) ───────────────────────────────────────────

    function parseSbv(text) {
        const lines = linesOf(text);
        const cues = [];
        let i = 0;
        while (i < lines.length) {
            const m = /^\s*([\d:.]+)\s*,\s*([\d:.]+)\s*$/.exec(lines[i]);
            i += 1;
            if (!m) continue;
            const body = [];
            while (i < lines.length && lines[i].trim()) { body.push(lines[i]); i += 1; }
            const start = parseClock(m[1]);
            const end = parseClock(m[2]);
            if (Number.isFinite(start) && Number.isFinite(end)) {
                cues.push({ start, end, text: cleanCueText(body.join('\n').replace(/\[br\]/gi, '\n')) });
            }
        }
        return cues;
    }

    // ── Nhận diện định dạng ────────────────────────────────────────────────

    const FORMAT_LABELS = {
        srt: 'SubRip (.srt)',
        vtt: 'WebVTT (.vtt)',
        ass: 'Advanced SubStation (.ass/.ssa)',
        ttml: 'Timed Text (.xml/.ttml/.dfxp)',
        lrc: 'Lời bài hát (.lrc)',
        sbv: 'YouTube SubViewer (.sbv)',
    };

    /* NỘI DUNG quyết định trước, đuôi tệp chỉ để phân xử: tệp .txt chứa SRT, hay .srt thực ra
     * là WebVTT, đều gặp thường xuyên. Riêng .xml phải soi kỹ — Premiere/Final Cut cũng xuất
     * cả DỰ ÁN ra .xml (xmeml/fcpxml), mà đó không phải tệp phụ đề. */
    function detectFormat(text, fileName) {
        const head = String(text || '').replace(/^﻿/, '').slice(0, 4000);
        const ext = String(fileName || '').toLowerCase().split('.').pop();
        if (/^\s*WEBVTT/.test(head)) return 'vtt';
        if (/^\s*\[script info\]/im.test(head) || /^\s*\[v4\+? styles\]/im.test(head)) return 'ass';
        if (/<(?:[\w-]+:)?tt[\s>]/i.test(head)) return 'ttml';
        if (/<xmeml[\s>]|<fcpxml[\s>]/i.test(head)) return 'nle_xml';
        if (/^\s*[\d:.,]+\s*-->\s*[\d:.,]+/m.test(head)) return ext === 'vtt' ? 'vtt' : 'srt';
        if (/^\s*\[\d+:\d{1,2}(?:[.:]\d+)?\]/m.test(head)) return 'lrc';
        if (/^\s*\d+:\d{2}:\d{2}\.\d+\s*,\s*\d+:\d{2}:\d{2}\.\d+\s*$/m.test(head)) return 'sbv';
        if (ext === 'ssa') return 'ass';
        if (ext === 'dfxp' || ext === 'ttml') return 'ttml';
        if (FORMAT_LABELS[ext]) return ext;
        return '';
    }

    // ── Dọn danh sách cue ──────────────────────────────────────────────────

    /* Cue sát nhau hơn mức này (bắt đầu gần như cùng lúc) được GỘP thay vì cắt: cắt đuôi câu
     * trước còn lại vài chục ms là một block nháy lên rồi tắt, không ai đọc kịp. */
    const SAME_START_SECONDS = 0.25;
    const MIN_CUE_SECONDS = 0.1;

    function tidyCues(list) {
        const sorted = (Array.isArray(list) ? list : [])
            .map((cue) => ({ start: Number(cue.start), end: Number(cue.end), text: cleanCueText(cue.text) }))
            .filter((cue) => cue.text && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
            .map((cue) => ({ ...cue, start: Math.max(0, cue.start) }))
            .filter((cue) => cue.end - cue.start >= MIN_CUE_SECONDS)
            .sort((a, b) => (a.start - b.start) || (a.end - b.end));
        const out = [];
        let trimmed = 0;
        let merged = 0;
        for (const cue of sorted) {
            const prev = out[out.length - 1];
            if (prev && cue.start < prev.end) {
                if (cue.start - prev.start < SAME_START_SECONDS) {
                    if (cue.text !== prev.text) prev.text = `${prev.text}\n${cue.text}`;
                    prev.end = Math.max(prev.end, cue.end);
                    merged += 1;
                    continue;
                }
                prev.end = cue.start;
                trimmed += 1;
            }
            out.push({ ...cue });
        }
        return { cues: out, trimmed, merged };
    }

    /* Ngôn ngữ đoán từ CHỮ VIẾT, chỉ để chọn font: Nunito không có glyph CJK nào, nên phụ đề
     * tiếng Trung/Nhật/Hàn đặt trên Nunito ra một hàng ô vuông. Có kana thì chắc chắn là
     * tiếng Nhật (tiếng Nhật trộn Hán tự với kana); chỉ có Hán tự thì là tiếng Trung. Trả ''
     * cho chữ Latin — font mặc định đã đủ. */
    function detectLanguage(cues) {
        const sample = (Array.isArray(cues) ? cues : []).slice(0, 400).map((c) => c.text).join('\n');
        const count = (re) => (sample.match(re) || []).length;
        const hangul = count(/[가-힯ᄀ-ᇿ㄰-㆏]/g);
        const kana = count(/[぀-ヿㇰ-ㇿ]/g);
        const han = count(/[㐀-䶿一-鿿豈-﫿]/g);
        if (hangul && hangul >= kana) return 'ko';
        if (kana) return 'ja';
        if (han) return 'zh';
        return '';
    }

    const PARSERS = {
        srt: (t) => parseArrowCues(t),
        vtt: (t) => parseArrowCues(t, { vtt: true }),
        ass: parseAss,
        ttml: parseTtml,
        lrc: parseLrc,
        sbv: parseSbv,
    };

    /* Điểm vào duy nhất. Ném Error với câu tiếng Việt đọc được khi không đọc nổi tệp — nơi
     * gọi hiện thẳng message đó cho người dùng. */
    function parseSubtitleText(text, fileName) {
        const format = detectFormat(text, fileName);
        if (format === 'nle_xml') {
            throw new Error('Đây là tệp XML dự án (Premiere/Final Cut), không phải tệp phụ đề. '
                + 'Hãy xuất phụ đề ra .srt hoặc .xml dạng DFXP/TTML rồi nhập lại.');
        }
        if (!format) {
            throw new Error('Không nhận ra định dạng phụ đề. Hỗ trợ: .srt, .vtt, .ass/.ssa, .xml/.ttml/.dfxp, .lrc, .sbv.');
        }
        const tidy = tidyCues(PARSERS[format](text));
        if (!tidy.cues.length) {
            throw new Error(`Tệp ${FORMAT_LABELS[format]} không có câu phụ đề nào đọc được.`);
        }
        return {
            format,
            formatLabel: FORMAT_LABELS[format],
            cues: tidy.cues,
            trimmed: tidy.trimmed,
            merged: tidy.merged,
            language: detectLanguage(tidy.cues),
        };
    }

    return {
        EXTENSIONS,
        ACCEPT,
        FORMAT_LABELS,
        decodeSubtitleBytes,
        detectFormat,
        detectLanguage,
        parseSubtitleText,
        parseClock,
        tidyCues,
        // Từng bộ đọc riêng, mở ra cho test.
        parseArrowCues,
        parseAss,
        parseTtml,
        parseLrc,
        parseSbv,
    };
}));
