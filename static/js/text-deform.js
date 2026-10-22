// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* BIẾN DẠNG CHỮ (Warp kiểu After Effects › Effect › Distort › Warp) + CHỮ CHẠY THEO ĐƯỜNG.
 *
 * Cả hai chỉ là THUỘC TÍNH của style block chữ (khoá phẳng — đi qua patchTextStyle, lưu trong
 * .crab, MCP update_block sửa được như mọi thuộc tính chữ khác):
 *   warp_type   'none' | một id trong WARP_TYPES
 *   warp_bend   -100..100  (Bend của AE)
 *   warp_h      -100..100  (Horizontal Distortion)
 *   warp_v      -100..100  (Vertical Distortion)
 *   path_enabled  true = chữ chạy theo đường
 *   path_points   [{x, y, ix, iy, ox, oy}] — CÙNG mô hình đỉnh của shape Pen (editing-runtime.js
 *                 normalizePathPoints): x/y theo tỉ lệ 0..1 của box path_w × path_h, tay cầm Bezier
 *                 tương đối so với đỉnh, cùng đơn vị tỉ lệ
 *   path_closed   đường khép kín
 *   path_w / path_h  cỡ box của đường (px sequence, ở scale 100%)
 *   path_offset   -100..100 (% chiều dài đường) dời chữ dọc theo đường
 *   path_align    'left' | 'center' | 'right'
 *   path_flip     true = chữ nằm phía bên kia đường (đảo chiều đi)
 *   path_shift    px — nâng/hạ chân chữ so với đường
 *
 * MỘT ĐƯỜNG VẼ CHO MỌI NƠI: editing-runtime.js gọi deformMeasure() ngay trong measureTextItemBox
 * và drawDeformed() ngay đầu drawTextItemContent — hai cửa mà preview (lớp mực canvas), PNG xuất
 * và chuỗi khung hoạt ảnh đều đi qua. Nên preview và tệp xuất không thể lệch nhau.
 *
 * Hình học: hộp của chữ biến dạng ĐỐI XỨNG quanh tâm hộp chữ gốc (chữ theo đường: tâm box của
 * đường), nên position_x/y của block giữ nguyên nghĩa "tâm khối chữ" — bật/tắt hiệu ứng không làm
 * chữ nhảy chỗ, và backend/sidecar đặt PNG theo tâm như mọi block chữ.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.TextDeform = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const _t = (typeof globalThis !== 'undefined' && globalThis._t)
        || ((k, p) => (p ? String(k).replace(/\{(\w+)\}/g, (m, n) => (n in p ? p[n] : m)) : k));

    // Cùng danh sách kiểu của Warp trong After Effects (Effect › Distort › Warp).
    const WARP_TYPES = [
        { id: 'arc', label: 'Arc' },
        { id: 'arc_lower', label: 'Arc Lower' },
        { id: 'arc_upper', label: 'Arc Upper' },
        { id: 'arch', label: 'Arch' },
        { id: 'bulge', label: 'Bulge' },
        { id: 'shell_lower', label: 'Shell Lower' },
        { id: 'shell_upper', label: 'Shell Upper' },
        { id: 'flag', label: 'Flag' },
        { id: 'wave', label: 'Wave' },
        { id: 'fish', label: 'Fish' },
        { id: 'rise', label: 'Rise' },
        { id: 'fisheye', label: 'Fisheye' },
        { id: 'inflate', label: 'Inflate' },
        { id: 'squeeze', label: 'Squeeze' },
        { id: 'twist', label: 'Twist' },
    ];
    const WARP_IDS = new Set(WARP_TYPES.map((w) => w.id));

    const clampNum = (v, lo, hi, d = 0) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
    };

    /* ===================================================================== WARP */

    function normalizeWarp(style) {
        const type = String(style?.warp_type || 'none');
        if (!WARP_IDS.has(type)) return null;
        const w = {
            type,
            bend: clampNum(style.warp_bend, -100, 100, 50) / 100,
            h: clampNum(style.warp_h, -100, 100, 0) / 100,
            v: clampNum(style.warp_v, -100, 100, 0) / 100,
        };
        if (Math.abs(w.bend) < 1e-4 && Math.abs(w.h) < 1e-4 && Math.abs(w.v) < 1e-4) return null;
        return w;
    }

    /* Một điểm (x, y) — px TÍNH TỪ TÂM hộp chữ, y hướng xuống — sang vị trí sau biến dạng.
     * hw/hh = nửa bề rộng/cao của hộp chữ (không tính lề viền/bóng): biên độ của mọi kiểu tính
     * theo hộp chữ, nên đổi độ dày viền không làm dáng cong đổi theo. */
    function warpPoint(warp, x, y, hw, hh) {
        const b = warp.bend;
        const u = x / hw;
        const v = y / hh;
        const A = hh * 0.9;                       // biên độ dọc ở bend = 100%
        const s = Math.max(0, Math.min(1, (v + 1) / 2));   // 0 mép trên -> 1 mép dưới
        const uc = Math.max(-1, Math.min(1, u));
        const circ = Math.sqrt(Math.max(0, 1 - uc * uc)); // vòng cung
        const shell = Math.cos(uc * Math.PI / 2) ** 2;    // vỏ sò: dốc hơn ở hai đầu
        let X = x;
        let Y = y;
        switch (warp.type) {
            case 'arc': {
                if (Math.abs(b) > 1e-4) {
                    // Uốn cả khối quanh một tâm: tổng góc = bend × 180°, bán kính ở đường giữa
                    // = sao cho chiều dài cung giữ đúng bề rộng chữ.
                    const r0 = (2 * hw) / (b * Math.PI);
                    const th = x / r0;
                    X = (r0 - y) * Math.sin(th);
                    Y = r0 - (r0 - y) * Math.cos(th);
                }
                break;
            }
            case 'arc_lower': Y = y + b * A * s * circ; break;
            case 'arc_upper': Y = y - b * A * (1 - s) * circ; break;
            case 'arch': Y = y - b * A * circ; break;
            case 'bulge': Y = y + b * A * v * circ; break;
            case 'shell_lower': Y = y + b * A * s * shell; break;
            case 'shell_upper': Y = y - b * A * (1 - s) * shell; break;
            case 'flag': Y = y + b * A * 0.7 * Math.sin(uc * Math.PI); break;
            case 'wave': Y = y + b * A * 0.45 * Math.sin(uc * Math.PI * 2) * (1 + 0.35 * v); break;
            case 'fish': Y = y + b * A * v * Math.sin(Math.PI * (((uc + 1) / 2) ** 0.7)); break;
            case 'rise': Y = y - b * A * Math.sin(uc * Math.PI / 2); break;
            case 'fisheye': {
                const r = Math.min(1, Math.hypot(u, v) / Math.SQRT2);
                const k = 1 + b * 0.6 * (1 - r * r);
                X = x * k;
                Y = y * k;
                break;
            }
            case 'inflate': {
                const r = Math.min(1, Math.hypot(u, v) / Math.SQRT2);
                const k = b * 0.45 * Math.cos(r * Math.PI / 2);
                X = x * (1 + k * 0.5);
                Y = y * (1 + k);
                break;
            }
            case 'squeeze': {
                const vc = Math.max(-1, Math.min(1, v));
                X = x * (1 - b * 0.4 * (1 - vc * vc));
                Y = y * (1 + b * 0.3 * circ);
                break;
            }
            case 'twist': {
                const r = Math.min(1, Math.hypot(u, v) / Math.SQRT2);
                const ang = b * Math.PI * 0.6 * (1 - r);
                const c = Math.cos(ang);
                const sn = Math.sin(ang);
                X = x * c - (y * hw / hh) * sn;
                Y = (x * sn) * (hh / hw) + y * c;
                break;
            }
            default: break;
        }
        // Méo ngang/dọc (Horizontal/Vertical Distortion của AE): phối cảnh tuyến tính.
        if (warp.h) Y *= 1 + warp.h * Math.max(-1, Math.min(1, X / hw)) * 0.6;
        if (warp.v) X *= 1 + warp.v * Math.max(-1, Math.min(1, Y / hh)) * 0.6;
        return [X, Y];
    }

    // Lưới dùng để vẽ (và để đo): đủ dày cho Arc 180° / Twist không lộ cạnh gãy.
    const GRID_COLS = 40;
    const GRID_ROWS = 14;

    /* Nửa bề rộng/cao của hộp ĐỐI XỨNG quanh tâm chứa toàn bộ canvas gốc (hộp + lề) sau biến
     * dạng. cw/ch = cỡ canvas gốc (hộp + 2 × lề), hw/hh = nửa hộp chữ. */
    function warpExtents(warp, cw, ch, hw, hh) {
        let mx = 0;
        let my = 0;
        for (let i = 0; i <= GRID_COLS; i += 1) {
            for (let j = 0; j <= GRID_ROWS; j += 1) {
                const [X, Y] = warpPoint(warp, (i / GRID_COLS - 0.5) * cw, (j / GRID_ROWS - 0.5) * ch, hw, hh);
                mx = Math.max(mx, Math.abs(X));
                my = Math.max(my, Math.abs(Y));
            }
        }
        return { hx: Math.ceil(mx + 2), hy: Math.ceil(my + 2) };
    }

    /* Vẽ ảnh gốc lên ctx theo lưới (grid[j][i] = { s: điểm nguồn (đơn vị), d: điểm đích (đơn vị) }).
     * ÁNH XẠ NGƯỢC TỪNG PIXEL: mỗi pixel đích (hệ thiết bị của ctx) thuộc đúng MỘT tam giác của
     * lưới, toạ độ nguồn nội suy theo barycentric rồi lấy mẫu song tuyến tính trên alpha NHÂN SẴN.
     * Không có khe hay chồng mép giữa hai tam giác (vẽ bằng drawImage + clip thì viền khử răng cưa
     * của vùng cắt để lại đường lưới trên nền bán trong suốt). Dán một lần lên ctx -> giữ
     * globalAlpha của nơi gọi (fade của hoạt ảnh). */
    function rasterWarp(ctx, img, k, grid) {
        const tf = typeof ctx.getTransform === 'function' ? ctx.getTransform() : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        const dev = (p) => [tf.a * p[0] + tf.c * p[1] + tf.e, tf.b * p[0] + tf.d * p[1] + tf.f];
        const rows = grid.length - 1;
        const cols = grid[0].length - 1;
        const D = grid.map((row) => row.map((pt) => dev(pt.d)));
        let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
        D.forEach((row) => row.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }));
        x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
        x1 = Math.min(ctx.canvas.width, Math.ceil(x1)); y1 = Math.min(ctx.canvas.height, Math.ceil(y1));
        const W = x1 - x0;
        const H = y1 - y0;
        if (W <= 0 || H <= 0) return;
        const sw = img.width;
        const sh = img.height;
        const src = img.getContext('2d').getImageData(0, 0, sw, sh).data;
        const out = new ImageData(W, H);
        const o = out.data;
        const done = new Uint8Array(W * H);
        const sample = (sx, sy, idx) => {
            // Song tuyến tính, alpha nhân sẵn; ngoài ảnh = trong suốt.
            const fx = sx - 0.5; const fy = sy - 0.5;
            const ix = Math.floor(fx); const iy = Math.floor(fy);
            const tx = fx - ix; const ty = fy - iy;
            let r = 0; let g = 0; let b = 0; let a = 0;
            for (let dy = 0; dy < 2; dy += 1) {
                const yy = iy + dy;
                if (yy < 0 || yy >= sh) continue;
                const wy = dy ? ty : 1 - ty;
                for (let dx = 0; dx < 2; dx += 1) {
                    const xx = ix + dx;
                    if (xx < 0 || xx >= sw) continue;
                    const w = wy * (dx ? tx : 1 - tx);
                    const q = (yy * sw + xx) * 4;
                    const al = src[q + 3] * w;
                    if (!al) continue;
                    r += src[q] * al; g += src[q + 1] * al; b += src[q + 2] * al; a += al;
                }
            }
            if (a > 0) {
                o[idx] = r / a; o[idx + 1] = g / a; o[idx + 2] = b / a; o[idx + 3] = a;
            }
        };
        const tri = (d0, d1, d2, s0, s1, s2) => {
            const area = (d1[0] - d0[0]) * (d2[1] - d0[1]) - (d2[0] - d0[0]) * (d1[1] - d0[1]);
            if (Math.abs(area) < 1e-9) return;
            const bx0 = Math.max(x0, Math.floor(Math.min(d0[0], d1[0], d2[0])));
            const by0 = Math.max(y0, Math.floor(Math.min(d0[1], d1[1], d2[1])));
            const bx1 = Math.min(x1 - 1, Math.ceil(Math.max(d0[0], d1[0], d2[0])));
            const by1 = Math.min(y1 - 1, Math.ceil(Math.max(d0[1], d1[1], d2[1])));
            const eps = -1e-7;
            for (let py = by0; py <= by1; py += 1) {
                const cy = py + 0.5;
                for (let px = bx0; px <= bx1; px += 1) {
                    const p = (py - y0) * W + (px - x0);
                    if (done[p]) continue;
                    const cx = px + 0.5;
                    const w0 = ((d1[0] - cx) * (d2[1] - cy) - (d2[0] - cx) * (d1[1] - cy)) / area;
                    const w1 = ((d2[0] - cx) * (d0[1] - cy) - (d0[0] - cx) * (d2[1] - cy)) / area;
                    const w2 = 1 - w0 - w1;
                    if (w0 < eps || w1 < eps || w2 < eps) continue;
                    done[p] = 1;
                    sample((w0 * s0[0] + w1 * s1[0] + w2 * s2[0]) * k, (w0 * s0[1] + w1 * s1[1] + w2 * s2[1]) * k, p * 4);
                }
            }
        };
        for (let j = 0; j < rows; j += 1) {
            for (let i = 0; i < cols; i += 1) {
                const a0 = D[j][i]; const a1 = D[j][i + 1]; const a2 = D[j + 1][i]; const a3 = D[j + 1][i + 1];
                const s00 = grid[j][i].s; const s10 = grid[j][i + 1].s; const s01 = grid[j + 1][i].s; const s11 = grid[j + 1][i + 1].s;
                tri(a0, a1, a3, s00, s10, s11);
                tri(a0, a3, a2, s00, s11, s01);
            }
        }
        const tmp = document.createElement('canvas');
        tmp.width = W;
        tmp.height = H;
        tmp.getContext('2d').putImageData(out, 0, 0);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(tmp, x0, y0);
        ctx.restore();
    }

    /* ===================================================================== CHỮ THEO ĐƯỜNG */

    function normalizePathPoints(list) {
        if (!Array.isArray(list)) return [];
        return list.slice(0, 500)
            .filter((p) => p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
            .map((p) => ({
                x: clampNum(p.x, -1, 2), y: clampNum(p.y, -1, 2),
                ix: clampNum(p.ix, -10, 10), iy: clampNum(p.iy, -10, 10),
                ox: clampNum(p.ox, -10, 10), oy: clampNum(p.oy, -10, 10),
            }));
    }

    function normalizePath(style) {
        if (!style || style.path_enabled !== true) return null;
        const points = normalizePathPoints(style.path_points);
        if (points.length < 2) return null;
        return {
            points,
            closed: style.path_closed === true && points.length >= 2,
            w: clampNum(style.path_w, 10, 8000, 600),
            h: clampNum(style.path_h, 0, 8000, 200),
            offset: clampNum(style.path_offset, -100, 100, 0) / 100,
            align: ['left', 'right'].includes(style.path_align) ? style.path_align : 'center',
            flip: style.path_flip === true,
            shift: clampNum(style.path_shift, -500, 500, 0),
        };
    }

    // Đường -> đa giác lấy mẫu (px trong box w×h, gốc ở góc trái trên) + chiều dài tích luỹ.
    function samplePath(path) {
        const { points, closed, w, h } = path;
        const P = (p) => [p.x * w, p.y * h];
        const pts = [];
        const segs = closed ? points.length : points.length - 1;
        for (let i = 0; i < segs; i += 1) {
            const a = points[i];
            const b = points[(i + 1) % points.length];
            const p0 = P(a);
            const c1 = [p0[0] + a.ox * w, p0[1] + a.oy * h];
            const p3 = P(b);
            const c2 = [p3[0] + b.ix * w, p3[1] + b.iy * h];
            const steps = (a.ox || a.oy || b.ix || b.iy) ? 48 : 1;
            for (let k = (i === 0 ? 0 : 1); k <= steps; k += 1) {
                const t = k / steps;
                const mt = 1 - t;
                pts.push([
                    mt * mt * mt * p0[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * p3[0],
                    mt * mt * mt * p0[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * p3[1],
                ]);
            }
        }
        if (path.flip) pts.reverse();
        const cum = [0];
        for (let i = 1; i < pts.length; i += 1) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
        return { pts, cum, length: cum[cum.length - 1] || 0, closed };
    }

    // Điểm + góc tiếp tuyến tại khoảng cách s dọc đường (đường kín thì quay vòng). null = ngoài đường.
    function pointAt(sampled, s) {
        const { pts, cum, length, closed } = sampled;
        if (!(length > 0)) return null;
        let d = s;
        if (closed) d = ((s % length) + length) % length;
        else if (d < 0 || d > length) return null;
        let lo = 0;
        let hi = cum.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (cum[mid] <= d) lo = mid; else hi = mid;
        }
        const seg = (cum[hi] - cum[lo]) || 1;
        const t = (d - cum[lo]) / seg;
        const [x0, y0] = pts[lo];
        const [x1, y1] = pts[hi];
        return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, angle: Math.atan2(y1 - y0, x1 - x0) };
    }

    /* Vị trí từng ký tự: [{ ch, x, y, angle, w }] trong hệ px của box đường. `measureChar` đo bề
     * rộng một ký tự ở font đang đặt; letterPx cộng sau mỗi ký tự như letter-spacing của CSS. */
    function layoutPathGlyphs(path, text, measureChar, letterPx) {
        const sampled = samplePath(path);
        const chars = Array.from(String(text || ''));
        const widths = chars.map((c) => measureChar(c));
        const total = widths.reduce((a, b) => a + b, 0) + letterPx * Math.max(0, chars.length - 1);
        const L = sampled.length;
        let s0;
        if (path.align === 'left') s0 = 0;
        else if (path.align === 'right') s0 = L - total;
        else s0 = sampled.closed ? -total / 2 : (L - total) / 2;
        s0 += path.offset * L;
        const out = [];
        let s = s0;
        chars.forEach((ch, i) => {
            const w = widths[i];
            const p = pointAt(sampled, s + w / 2);
            if (p) out.push({ ch, x: p.x, y: p.y, angle: p.angle, w, index: i });
            s += w + letterPx;
        });
        return { glyphs: out, total, length: L };
    }

    // Mẫu đường cho subtab "Chữ theo đường" (đỉnh theo mô hình Pen, box w×h).
    const PATH_PRESETS = [
        { id: 'arc', label: 'Vòng cung', w: 760, h: 240, closed: false, points: [
            { x: 0, y: 1, ix: 0, iy: 0, ox: 0.16, oy: -0.62 },
            { x: 0.5, y: 0, ix: -0.27, iy: 0, ox: 0.27, oy: 0 },
            { x: 1, y: 1, ix: -0.16, iy: -0.62, ox: 0, oy: 0 },
        ] },
        { id: 'smile', label: 'Vòng cung ngửa', w: 760, h: 240, closed: false, points: [
            { x: 0, y: 0, ix: 0, iy: 0, ox: 0.16, oy: 0.62 },
            { x: 0.5, y: 1, ix: -0.27, iy: 0, ox: 0.27, oy: 0 },
            { x: 1, y: 0, ix: -0.16, iy: 0.62, ox: 0, oy: 0 },
        ] },
        { id: 'wave', label: 'Sóng', w: 860, h: 180, closed: false, points: [
            { x: 0, y: 0.5, ix: 0, iy: 0, ox: 0.12, oy: -0.75 },
            { x: 0.5, y: 0.5, ix: -0.12, iy: -0.75, ox: 0.12, oy: 0.75 },
            { x: 1, y: 0.5, ix: -0.12, iy: 0.75, ox: 0, oy: 0 },
        ] },
        { id: 'circle', label: 'Vòng tròn', w: 520, h: 520, closed: true, points: [
            { x: 0.5, y: 0, ix: -0.276, iy: 0, ox: 0.276, oy: 0 },
            { x: 1, y: 0.5, ix: 0, iy: -0.276, ox: 0, oy: 0.276 },
            { x: 0.5, y: 1, ix: 0.276, iy: 0, ox: -0.276, oy: 0 },
            { x: 0, y: 0.5, ix: 0, iy: 0.276, ox: 0, oy: -0.276 },
        ] },
        { id: 's_curve', label: 'Chữ S', w: 760, h: 260, closed: false, points: [
            { x: 0, y: 1, ix: 0, iy: 0, ox: 0.38, oy: 0 },
            { x: 1, y: 0, ix: -0.38, iy: 0, ox: 0, oy: 0 },
        ] },
        { id: 'rise', label: 'Đường xiên', w: 760, h: 220, closed: false, points: [
            { x: 0, y: 1, ix: 0, iy: 0, ox: 0, oy: 0 },
            { x: 1, y: 0, ix: 0, iy: 0, ox: 0, oy: 0 },
        ] },
    ];

    function presetStyle(id) {
        const p = PATH_PRESETS.find((x) => x.id === id);
        if (!p) return null;
        return {
            path_enabled: true,
            path_points: p.points.map((pt) => ({ ...pt })),
            path_closed: p.closed,
            path_w: p.w,
            path_h: p.h,
            path_offset: 0,
            path_align: 'center',
            path_flip: false,
            path_shift: 0,
        };
    }

    /* ===================================================================== ĐO + VẼ */

    /* Gọi từ measureTextItemBox với số đo của chữ THƯỜNG (`base`). Trả null khi không có hiệu
     * ứng — nơi gọi dùng nguyên `base`. Có hiệu ứng: cùng khuôn object, width/height = hộp mới
     * (đối xứng quanh tâm), `margin` giữ nguyên (lề viền/bóng), thêm `deform` cho khâu vẽ. */
    function deformMeasure(style, base, strokeOuterPx = 0) {
        const path = normalizePath(style);
        if (path) {
            const pad = Math.ceil(base.fontSize * 1.25 + strokeOuterPx + Math.abs(path.shift) + 4);
            return {
                ...base,
                width: Math.ceil(path.w + 2 * pad),
                height: Math.ceil(path.h + 2 * pad),
                contentWidth: Math.ceil(path.w + 2 * pad),
                displayLines: [base.displayLines.join(' ')],
                deform: { kind: 'path', path, pad, base },
            };
        }
        const warp = normalizeWarp(style);
        if (!warp) return null;
        const m = base.margin || 0;
        const hw = Math.max(1, base.width / 2);
        const hh = Math.max(1, base.height / 2);
        const ext = warpExtents(warp, base.width + 2 * m, base.height + 2 * m, hw, hh);
        return {
            ...base,
            width: Math.max(2, 2 * ext.hx - 2 * m),
            height: Math.max(2, 2 * ext.hy - 2 * m),
            deform: { kind: 'warp', warp, base },
        };
    }

    let srcCanvas = null;
    function scratchCanvas(w, h) {
        if (!srcCanvas) srcCanvas = document.createElement('canvas');
        if (srcCanvas.width !== w || srcCanvas.height !== h) { srcCanvas.width = w; srcCanvas.height = h; }
        const ctx = srcCanvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);
        return { canvas: srcCanvas, ctx };
    }

    function ctxScale(ctx) {
        const tf = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
        return tf ? Math.max(0.05, Math.hypot(tf.a, tf.b), Math.hypot(tf.c, tf.d)) : 1;
    }

    /* Vẽ chữ đã biến dạng / chạy theo đường. `drawBase(ctx2, baseMeasured, opts)` = drawTextItemContent
     * của runtime cho chữ THƯỜNG (warp vẽ chữ gốc rồi uốn). `helpers`: hexToRgba, strokeInner/Outer. */
    function drawDeformed(ctx, item, style, measured, opts, drawBase, helpers) {
        const d = measured.deform;
        const m = measured.margin || 0;
        const ox = (Number(opts.originX) || 0) + m;
        const oy = (Number(opts.originY) || 0) + m;
        const cx = ox + measured.width / 2;
        const cy = oy + measured.height / 2;
        if (d.kind === 'warp') {
            const base = d.base;
            const bw = base.width + 2 * m;
            const bh = base.height + 2 * m;
            // Canvas gốc dựng ở ĐÚNG độ phân giải đích (preview density / bake density).
            const k = Math.min(4, Math.max(1, ctxScale(ctx)));
            const { canvas, ctx: sctx } = scratchCanvas(Math.max(2, Math.ceil(bw * k)), Math.max(2, Math.ceil(bh * k)));
            sctx.setTransform(k, 0, 0, k, 0, 0);
            drawBase(sctx, base, { ...opts, originX: 0, originY: 0 });
            sctx.setTransform(1, 0, 0, 1, 0, 0);
            // Chụp ảnh gốc ra canvas riêng: drawBase (bóng) và lần vẽ sau có thể dùng lại scratch.
            const img = document.createElement('canvas');
            img.width = canvas.width; img.height = canvas.height;
            img.getContext('2d').drawImage(canvas, 0, 0);
            const hw = Math.max(1, base.width / 2);
            const hh = Math.max(1, base.height / 2);
            const grid = [];
            for (let j = 0; j <= GRID_ROWS; j += 1) {
                const row = [];
                for (let i = 0; i <= GRID_COLS; i += 1) {
                    const sx = (i / GRID_COLS) * bw;
                    const sy = (j / GRID_ROWS) * bh;
                    const [X, Y] = warpPoint(d.warp, sx - bw / 2, sy - bh / 2, hw, hh);
                    row.push({ s: [sx, sy], d: [cx + X, cy + Y] });
                }
                grid.push(row);
            }
            rasterWarp(ctx, img, k, grid);
            return;
        }
        // ---- Chữ theo đường: vẽ từng ký tự (nét vector, sắc ở mọi cỡ).
        const base = d.base;
        const path = d.path;
        const px0 = ox + d.pad;
        const py0 = oy + d.pad;
        const charLimit = Number.isFinite(opts.charLimit) ? Math.max(0, Math.floor(opts.charLimit)) : Infinity;
        ctx.save();
        ctx.font = base.fontShorthand;
        try { ctx.letterSpacing = '0px'; } catch (_) { /* trình duyệt cũ */ }
        const text = base.displayLines.join(' ');
        const lay = layoutPathGlyphs(path, text, (c) => ctx.measureText(c).width, base.letterPx || 0);
        ctx.restore();
        const glyphs = lay.glyphs.filter((g) => g.index < charLimit);
        const each = (c, fn) => {
            glyphs.forEach((g) => {
                c.save();
                c.translate(px0 + g.x, py0 + g.y);
                c.rotate(g.angle);
                fn(g);
                c.restore();
            });
        };
        const paint = (c, flat) => {
            c.font = base.fontShorthand;
            try { c.letterSpacing = '0px'; } catch (_) { /* trình duyệt cũ */ }
            c.textBaseline = 'alphabetic';
            c.textAlign = 'center';
            const lift = -path.shift;
            if (style.stroke_enabled && helpers.strokeOuter(style) > 0) {
                const w1 = helpers.strokeInner(style);
                const w2 = helpers.strokeOuter(style);
                c.lineJoin = 'round';
                c.miterLimit = 2;
                if (w2 > w1) {
                    c.strokeStyle = flat || style.stroke2_color || '#000000';
                    c.lineWidth = w2 * 2;
                    each(c, (g) => c.strokeText(g.ch, 0, lift));
                }
                if (w1 > 0) {
                    c.strokeStyle = flat || style.stroke_color || '#000000';
                    c.lineWidth = w1 * 2;
                    each(c, (g) => c.strokeText(g.ch, 0, lift));
                }
            }
            c.fillStyle = flat || style.color || '#ffffff';
            each(c, (g) => c.fillText(g.ch, 0, lift));
        };
        // Bóng: cùng cách của chữ thường — dựng nhãn một màu sang canvas phụ rồi hạ xuống một lần.
        if (style.shadow_enabled && ctx.canvas.width > 0 && ctx.canvas.height > 0) {
            const shOpacity = style.shadow_opacity == null ? 100 : Number(style.shadow_opacity);
            if (shOpacity > 0) {
                const dx = Number(style.shadow_dx) || 0;
                const dy = Number(style.shadow_dy) || 0;
                const blur = Math.max(0, Number(style.shadow_blur) || 0);
                const tf = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
                const [ta, tb, tc, td] = tf ? [tf.a, tf.b, tf.c, tf.d] : [1, 0, 0, 1];
                const kk = Math.hypot(ta, tb) || 1;
                const shade = document.createElement('canvas');
                shade.width = ctx.canvas.width;
                shade.height = ctx.canvas.height;
                const sc = shade.getContext('2d');
                if (tf) sc.setTransform(ta, tb, tc, td, tf.e, tf.f);
                paint(sc, style.shadow_color || '#000000');
                const baseAlpha = ctx.globalAlpha;
                ctx.save();
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.globalAlpha = baseAlpha * Math.min(1, shOpacity / 100);
                if (blur > 0 && 'filter' in ctx) ctx.filter = `blur(${(blur * kk) / 2}px)`;
                ctx.drawImage(shade, (ta * dx) + (tc * dy), (tb * dx) + (td * dy));
                ctx.restore();
            }
        }
        paint(ctx, null);
    }

    /* ===================================================================== GIAO DIỆN */

    const esc = (v) => String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    /* Mục "Biến dạng" + "Chữ theo đường" của Inspector › Văn bản › Biến đổi. Ô mang
     * data-text-deform="<khoá style>" — editing-runtime.js (updateEditingInspectorField) ghi qua
     * patchFromField + patchTextStyle, cùng cơ chế Hoàn tác với các ô chữ khác. */
    // CSS riêng của module (một lần) — không đụng stylesheet chung.
    function injectStyle() {
        if (typeof document === 'undefined' || document.getElementById('textDeformStyle')) return;
        const el = document.createElement('style');
        el.id = 'textDeformStyle';
        el.textContent = `
            .tdf-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; font-size: 12px; }
            .tdf-row > span:first-child { flex: 0 0 92px; opacity: .8; }
            .tdf-row select, .tdf-row > input[type=number] { flex: 1; min-width: 0; }
            .tdf-slider { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; }
            .tdf-slider input[type=range] { flex: 1; min-width: 0; }
            .tdf-slider input[type=number] { width: 56px; }
            .tdf-check { display: flex; align-items: center; gap: 6px; margin: 6px 0; font-size: 12px; }
            .ins-sec [data-text-path-remove] { margin-top: 6px; width: 100%; }
            .text-path-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
            .text-path-thumb { display: flex; align-items: center; justify-content: center; color: var(--accent, #f4b942); }
        `;
        document.head.appendChild(el);
    }

    /* Ô số kéo-chỉnh được như mọi ô của bảng thuộc tính (editing-runtime.js editingScrubConfig đọc
       data-scrub-*): kéo ngang để đổi, Shift = bước 1/10, Alt = bước ×10. */
    const scrub = (step, min, max, integer) => `data-scrub-axis="x" data-scrub-step="${step}" data-scrub-min="${min}" data-scrub-max="${max}"${integer ? ' data-scrub-integer="1"' : ''}`;

    function inspectorHtml(style) {
        injectStyle();
        const st = style || {};
        const type = WARP_IDS.has(st.warp_type) ? st.warp_type : 'none';
        const num = (key, d) => clampNum(st[key], -100, 100, d);
        const slider = (key, label, d) => `
            <label class="tdf-row">
                <span>${esc(label)}</span>
                <span class="tdf-slider">
                    <input type="range" min="-100" max="100" step="1" value="${num(key, d)}" data-text-deform="${key}" ${type === 'none' ? 'disabled' : ''}>
                    <input type="number" min="-100" max="100" step="1" value="${num(key, d)}" data-text-deform="${key}" ${scrub(1, -100, 100, true)} ${type === 'none' ? 'disabled' : ''}>
                </span>
            </label>`;
        const warpHtml = `
            <section class="ins-sec" data-ins-tab="text" data-ins-sub="transform" data-text-deform-section="warp">
                <div class="ins-sec-head"><span class="ins-sec-title">${esc(_t('Biến dạng chữ (Warp)'))}</span></div>
                <label class="tdf-row">
                    <span>${esc(_t('Kiểu'))}</span>
                    <select data-text-deform="warp_type">
                        <option value="none"${type === 'none' ? ' selected' : ''}>${esc(_t('Không'))}</option>
                        ${WARP_TYPES.map((w) => `<option value="${w.id}"${w.id === type ? ' selected' : ''}>${esc(w.label)}</option>`).join('')}
                    </select>
                </label>
                ${slider('warp_bend', _t('Độ uốn (Bend)'), 50)}
                ${slider('warp_h', _t('Méo ngang'), 0)}
                ${slider('warp_v', _t('Méo dọc'), 0)}
            </section>`;
        if (st.path_enabled !== true) return warpHtml;
        const align = ['left', 'right'].includes(st.path_align) ? st.path_align : 'center';
        const pathHtml = `
            <section class="ins-sec" data-ins-tab="text" data-ins-sub="transform" data-text-deform-section="path">
                <div class="ins-sec-head"><span class="ins-sec-title">${esc(_t('Chữ theo đường'))}</span></div>
                <label class="tdf-row">
                    <span>${esc(_t('Dời dọc đường'))}</span>
                    <span class="tdf-slider">
                        <input type="range" min="-100" max="100" step="0.5" value="${clampNum(st.path_offset, -100, 100, 0)}" data-text-deform="path_offset">
                        <input type="number" min="-100" max="100" step="0.5" value="${clampNum(st.path_offset, -100, 100, 0)}" data-text-deform="path_offset" ${scrub(0.5, -100, 100, false)}>
                    </span>
                </label>
                <label class="tdf-row">
                    <span>${esc(_t('Căn'))}</span>
                    <select data-text-deform="path_align">
                        <option value="left"${align === 'left' ? ' selected' : ''}>${esc(_t('Đầu đường'))}</option>
                        <option value="center"${align === 'center' ? ' selected' : ''}>${esc(_t('Giữa'))}</option>
                        <option value="right"${align === 'right' ? ' selected' : ''}>${esc(_t('Cuối đường'))}</option>
                    </select>
                </label>
                <label class="tdf-row">
                    <span>${esc(_t('Nâng chữ (px)'))}</span>
                    <input type="number" min="-500" max="500" step="1" value="${clampNum(st.path_shift, -500, 500, 0)}" data-text-deform="path_shift" ${scrub(1, -500, 500, true)}>
                </label>
                <label class="tdf-row">
                    <span>${esc(_t('Rộng đường (px)'))}</span>
                    <input type="number" min="10" max="8000" step="1" value="${Math.round(clampNum(st.path_w, 10, 8000, 600))}" data-text-deform="path_w" ${scrub(1, 10, 8000, true)}>
                </label>
                <label class="tdf-row">
                    <span>${esc(_t('Cao đường (px)'))}</span>
                    <input type="number" min="0" max="8000" step="1" value="${Math.round(clampNum(st.path_h, 0, 8000, 200))}" data-text-deform="path_h" ${scrub(1, 0, 8000, true)}>
                </label>
                <label class="tdf-check"><input type="checkbox" data-text-deform="path_flip"${st.path_flip ? ' checked' : ''}> ${esc(_t('Đảo phía chữ'))}</label>
                <label class="tdf-check"><input type="checkbox" data-text-deform="path_closed"${st.path_closed ? ' checked' : ''}> ${esc(_t('Đường khép kín'))}</label>
                <button class="btn btn-secondary" type="button" data-text-path-remove>${esc(_t('Bỏ đường (về chữ thường)'))}</button>
            </section>`;
        return pathHtml + warpHtml;
    }

    // Ô inspector -> patch style. Thanh trượt và ô số cùng khoá nên luôn khớp nhau.
    function patchFromField(target) {
        const key = target?.dataset?.textDeform;
        if (!key) return null;
        if (key === 'warp_type') return { warp_type: WARP_IDS.has(target.value) ? target.value : 'none' };
        if (key === 'path_align') return { path_align: ['left', 'right'].includes(target.value) ? target.value : 'center' };
        if (key === 'path_flip' || key === 'path_closed') return { [key]: !!target.checked };
        const lim = { path_shift: [-500, 500], path_w: [10, 8000], path_h: [0, 8000] }[key] || [-100, 100];
        return { [key]: clampNum(target.value, lim[0], lim[1], 0) };
    }

    // Đồng bộ thanh trượt <-> ô số trong cùng mục khi một bên đổi (không dựng lại inspector).
    function syncTwin(target) {
        const key = target?.dataset?.textDeform;
        const box = target?.closest?.('[data-text-deform-section]');
        if (!key || !box) return;
        box.querySelectorAll(`[data-text-deform="${key}"]`).forEach((el) => { if (el !== target && el.type !== 'checkbox') el.value = target.value; });
    }

    /* Subtab "Chữ theo đường" của tab Văn bản (bảng trái): chỉ để TẠO — chỉnh đường ở
     * Inspector › Văn bản › Biến đổi. `ctx.selectedShapePath` = đang chọn một shape Pen,
     * `ctx.selectedPathText` = đang chọn chữ theo đường. */
    function renderPaneHtml(ctx = {}) {
        injectStyle();
        const cards = PATH_PRESETS.map((p) => `
            <button class="edit-add-card" type="button" data-text-path-preset="${p.id}" title="${esc(_t(p.label))}">
                <div class="edit-add-card-preview text-path-thumb">${presetThumbSvg(p)}</div>
                <div class="edit-asset-name">${esc(_t(p.label))}</div>
            </button>`).join('');
        return `
            <div class="text-path-pane">
                <div class="edit-sub-hint">${esc(_t('Chữ chạy dọc theo một đường cong. Chọn mẫu đường, vẽ đường bằng Pen, hoặc đặt chữ lên hình Pen đang chọn. Chỉnh độ dời, căn và phía chữ ở Thuộc tính › Văn bản › Biến đổi.'))}</div>
                <div class="edit-card-grid">${cards}</div>
                <div class="text-path-actions">
                    <button class="btn btn-secondary" type="button" data-text-path-pen>${esc(ctx.selectedPathText ? _t('Vẽ lại đường bằng Pen') : _t('Vẽ đường bằng Pen'))}</button>
                    <button class="btn btn-secondary" type="button" data-text-path-from-shape ${ctx.selectedShapePath ? '' : 'disabled'}>${esc(_t('Đặt chữ lên hình Pen đang chọn'))}</button>
                </div>
            </div>`;
    }

    function presetThumbSvg(p) {
        const sampled = samplePath({ ...normalizePath(presetStyle(p.id)), w: 100, h: 100 * (p.h / p.w) });
        const H = 100 * (p.h / p.w);
        const d = sampled.pts.map((pt, i) => `${i ? 'L' : 'M'}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`).join(' ') + (p.closed ? ' Z' : '');
        return `<svg viewBox="-8 -8 116 ${(H + 16).toFixed(1)}" width="64" height="40" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`;
    }

    return {
        WARP_TYPES,
        PATH_PRESETS,
        normalizeWarp,
        warpPoint,
        warpExtents,
        normalizePath,
        samplePath,
        pointAt,
        layoutPathGlyphs,
        presetStyle,
        deformMeasure,
        drawDeformed,
        inspectorHtml,
        patchFromField,
        syncTwin,
        renderPaneHtml,
    };
}));
