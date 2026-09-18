(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ScriptMarkdown = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function rotateLeft(value, bits) {
        return (value << bits) | (value >>> (32 - bits));
    }

    function sha1Text(value) {
        const text = String(value || '');
        const bytes = [];
        for (let i = 0; i < text.length; i += 1) {
            let code = text.charCodeAt(i);
            if (code < 0x80) {
                bytes.push(code);
            } else if (code < 0x800) {
                bytes.push(0xc0 | (code >>> 6), 0x80 | (code & 0x3f));
            } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
                const next = text.charCodeAt(i + 1);
                if (next >= 0xdc00 && next <= 0xdfff) {
                    i += 1;
                    code = 0x10000 + (((code & 0x3ff) << 10) | (next & 0x3ff));
                    bytes.push(
                        0xf0 | (code >>> 18),
                        0x80 | ((code >>> 12) & 0x3f),
                        0x80 | ((code >>> 6) & 0x3f),
                        0x80 | (code & 0x3f),
                    );
                }
            } else {
                bytes.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 0x3f), 0x80 | (code & 0x3f));
            }
        }

        const bitLength = bytes.length * 8;
        bytes.push(0x80);
        while ((bytes.length % 64) !== 56) bytes.push(0);
        for (let shift = 56; shift >= 0; shift -= 8) {
            bytes.push((bitLength / Math.pow(2, shift)) & 0xff);
        }

        let h0 = 0x67452301;
        let h1 = 0xefcdab89;
        let h2 = 0x98badcfe;
        let h3 = 0x10325476;
        let h4 = 0xc3d2e1f0;
        const words = new Array(80);

        for (let offset = 0; offset < bytes.length; offset += 64) {
            for (let i = 0; i < 16; i += 1) {
                const j = offset + (i * 4);
                words[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
            }
            for (let i = 16; i < 80; i += 1) {
                words[i] = rotateLeft(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1) >>> 0;
            }

            let a = h0;
            let b = h1;
            let c = h2;
            let d = h3;
            let e = h4;
            for (let i = 0; i < 80; i += 1) {
                let f;
                let k;
                if (i < 20) {
                    f = (b & c) | ((~b) & d);
                    k = 0x5a827999;
                } else if (i < 40) {
                    f = b ^ c ^ d;
                    k = 0x6ed9eba1;
                } else if (i < 60) {
                    f = (b & c) | (b & d) | (c & d);
                    k = 0x8f1bbcdc;
                } else {
                    f = b ^ c ^ d;
                    k = 0xca62c1d6;
                }
                const temp = (rotateLeft(a, 5) + f + e + k + words[i]) >>> 0;
                e = d;
                d = c;
                c = rotateLeft(b, 30) >>> 0;
                b = a;
                a = temp;
            }
            h0 = (h0 + a) >>> 0;
            h1 = (h1 + b) >>> 0;
            h2 = (h2 + c) >>> 0;
            h3 = (h3 + d) >>> 0;
            h4 = (h4 + e) >>> 0;
        }

        return [h0, h1, h2, h3, h4].map((part) => part.toString(16).padStart(8, '0')).join('');
    }

    function normalizeRawText(value) {
        return String(value || '')
            .replace(/^\ufeff/, '')
            .replace(/\r\n?/g, '\n')
            .replace(/[\u00a0\u202f]/g, ' ');
    }

    function lineColumnForOffset(text, offset) {
        let line = 1;
        let column = 1;
        const safeOffset = Math.max(0, Math.min(Number(offset) || 0, text.length));
        for (let i = 0; i < safeOffset; i += 1) {
            if (text[i] === '\n') {
                line += 1;
                column = 1;
            } else {
                column += 1;
            }
        }
        return { line, column };
    }

    function appendNormalChar(intermediate, raw, index, boldId) {
        intermediate.push({
            ch: raw[index],
            rawIndex: index,
            boldId: Number.isInteger(boldId) ? boldId : null,
        });
    }

    function cleanIntermediate(intermediate) {
        const finalChars = [];
        const interToFinal = new Array(intermediate.length + 1);
        let lineHasContent = false;
        let pendingSpaces = [];

        function mapPendingSpaces() {
            for (const item of pendingSpaces) {
                interToFinal[item.interIndex] = finalChars.length;
            }
            pendingSpaces = [];
        }

        function flushPendingSpace() {
            if (!lineHasContent || pendingSpaces.length === 0) {
                mapPendingSpaces();
                return;
            }
            const boldIds = new Set();
            for (const item of pendingSpaces) {
                if (Number.isInteger(item.boldId)) boldIds.add(item.boldId);
            }
            finalChars.push({
                ch: ' ',
                interIndex: pendingSpaces[0].interIndex,
                boldIds,
            });
            mapPendingSpaces();
        }

        for (let i = 0; i < intermediate.length; i += 1) {
            const item = intermediate[i];
            interToFinal[i] = finalChars.length;
            if (item.ch === '\n') {
                mapPendingSpaces();
                finalChars.push({ ch: '\n', interIndex: i, boldIds: new Set() });
                lineHasContent = false;
                continue;
            }
            if (/[ \t\f\v]/.test(item.ch)) {
                pendingSpaces.push({ interIndex: i, boldId: item.boldId });
                continue;
            }
            flushPendingSpace();
            finalChars.push({
                ch: item.ch,
                interIndex: i,
                boldIds: Number.isInteger(item.boldId) ? new Set([item.boldId]) : new Set(),
            });
            lineHasContent = true;
        }
        interToFinal[intermediate.length] = finalChars.length;
        mapPendingSpaces();

        return {
            cleanText: finalChars.map((item) => item.ch).join(''),
            finalChars,
            interToFinal,
        };
    }

    function normalizeMarkdownScript(markdownText, options = {}) {
        const raw = normalizeRawText(markdownText);
        const notes = [];
        const boldCandidates = [];
        const intermediate = [];
        let activeBold = null;
        let nextBoldId = 0;
        let i = 0;

        while (i < raw.length) {
            // Ghi chú (note) kiểu chú thích /* ... */ (định dạng .md mới): nằm CÙNG DÒNG với câu
            // thoại tương ứng. Ứng dụng BỎ QUA nội dung ghi chú khỏi kịch bản chuẩn (để phân đoạn
            // so khớp như cũ) nhưng GHI NHỚ vị trí thật (raw_start/end, line/column, clean_insert_offset)
            // để lưu vào dữ liệu nội bộ cho tính năng tương lai. Không phụ thuộc dấu *, nên kiểm trước.
            if (raw.startsWith('/*', i)) {
                const close = raw.indexOf('*/', i + 2);
                if (close >= 0) {
                    const noteText = raw.slice(i + 2, close).trim();
                    const loc = lineColumnForOffset(raw, i);
                    notes.push({
                        text: noteText,
                        raw_start: i,
                        raw_end: close + 2,
                        _inter_insert_offset: intermediate.length,
                        line: loc.line,
                        column: loc.column,
                    });
                    i = close + 2;
                    continue;
                }
            }

            // Ghi chú (note) dùng cặp *** ... *** — phải kiểm tra TRƯỚC bold (**)
            // để cụm 3 sao không bị hiểu nhầm là bold mở (longest-match-first).
            // Ngoại lệ: đang trong bold mà *** dính liền chữ phía trước (vd "**GOS***")
            // thì đó là dấu ĐÓNG bold + sao thừa, không phải note mở — nếu không,
            // note sẽ nuốt luôn dấu đóng và làm mất cụm bold.
            if (raw.startsWith('***', i)) {
                const prevCh = i > 0 ? raw[i - 1] : '';
                const noteAllowed = !activeBold || prevCh === '' || /\s/.test(prevCh);
                const close = noteAllowed ? raw.indexOf('***', i + 3) : -1;
                if (close >= 0) {
                    const noteText = raw.slice(i + 3, close).trim();
                    const loc = lineColumnForOffset(raw, i);
                    notes.push({
                        text: noteText,
                        raw_start: i,
                        raw_end: close + 3,
                        _inter_insert_offset: intermediate.length,
                        line: loc.line,
                        column: loc.column,
                    });
                    i = close + 3;
                    continue;
                }
            }

            if (raw.startsWith('**', i)) {
                if (activeBold) {
                    activeBold.raw_end = i + 2;
                    boldCandidates.push(activeBold);
                    activeBold = null;
                    i += 2;
                    // Sao lẻ dính liền dấu đóng (vd "**GOS***") -> bỏ qua, không cho lọt vào clean text
                    if (raw[i] === '*' && raw[i + 1] !== '*') i += 1;
                    continue;
                }
                // Bold phải đóng trong CÙNG một dòng: nếu dấu ** lẻ (typo) mà cho phép
                // bắt cặp vắt qua dòng thì mọi cặp bold phía sau sẽ lệch dây chuyền.
                // Dấu mở cũng phải DÍNH LIỀN chữ phía sau (flanking) để ** đóng-mồ-côi
                // không bị hiểu nhầm thành dấu mở mới.
                const opensOnText = i + 2 < raw.length && !/\s/.test(raw[i + 2]);
                const lineEnd = raw.indexOf('\n', i + 2);
                const close = raw.indexOf('**', i + 2);
                if (opensOnText && close >= 0 && (lineEnd < 0 || close < lineEnd)) {
                    const loc = lineColumnForOffset(raw, i);
                    activeBold = {
                        id: nextBoldId,
                        raw_start: i,
                        raw_end: null,
                        line: loc.line,
                        column: loc.column,
                    };
                    nextBoldId += 1;
                    i += 2;
                    continue;
                }
            }

            appendNormalChar(intermediate, raw, i, activeBold ? activeBold.id : null);
            i += 1;
        }

        const { cleanText, finalChars, interToFinal } = cleanIntermediate(intermediate);
        const boldRanges = [];
        for (const candidate of boldCandidates) {
            const positions = [];
            for (let index = 0; index < finalChars.length; index += 1) {
                if (finalChars[index].boldIds.has(candidate.id)) positions.push(index);
            }
            if (!positions.length) continue;
            const cleanStart = positions[0];
            const cleanEnd = positions[positions.length - 1] + 1;
            const text = cleanText.slice(cleanStart, cleanEnd).trim();
            if (!text) continue;
            const leadingTrim = cleanText.slice(cleanStart, cleanEnd).search(/\S/);
            const trailingTrim = cleanText.slice(cleanStart, cleanEnd).match(/\s*$/)?.[0]?.length || 0;
            boldRanges.push({
                text,
                raw_start: candidate.raw_start,
                raw_end: candidate.raw_end,
                clean_start: cleanStart + Math.max(leadingTrim, 0),
                clean_end: cleanEnd - trailingTrim,
                line: candidate.line,
                column: candidate.column,
            });
        }

        const metadata = {
            source_type: options.sourceType || 'md',
            source_name: options.sourceName || '',
            raw_sha1: sha1Text(raw),
            clean_sha1: sha1Text(cleanText),
            stale: false,
            notes: notes.map((note) => ({
                text: note.text,
                raw_start: note.raw_start,
                raw_end: note.raw_end,
                clean_insert_offset: interToFinal[Math.min(note._inter_insert_offset, interToFinal.length - 1)] || 0,
                line: note.line,
                column: note.column,
            })),
            bold_ranges: boldRanges,
        };

        return {
            raw_text: raw,
            clean_text: cleanText,
            metadata,
        };
    }

    function metadataForCurrentText(metadata, cleanText) {
        if (!metadata || typeof metadata !== 'object') return null;
        const next = {
            ...metadata,
            notes: Array.isArray(metadata.notes) ? metadata.notes.map((item) => ({ ...item })) : [],
            bold_ranges: Array.isArray(metadata.bold_ranges) ? metadata.bold_ranges.map((item) => ({ ...item })) : [],
        };
        next.stale = sha1Text(String(cleanText || '')) !== String(metadata.clean_sha1 || '');
        return next;
    }

    return {
        metadataForCurrentText,
        normalizeMarkdownScript,
        normalizeRawText,
        sha1Text,
    };
});
