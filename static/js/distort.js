// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* BIẾN DẠNG (Distort) KIỂU AFTER EFFECTS cho block ảnh / video / Shape.
 *
 * DỮ LIỆU — một danh sách hiệu ứng có thứ tự (như ngăn Effect của AE), lưu thẳng trong block nên
 * .crab và Hoàn tác tự có:
 *   item.distort = [{ id: 'd1', type: 'wave', enabled: true, params: { ... } }]
 *   Keyframe:  item.keyframes['dst.<id>.<param>'] = [{ t, v, e }]   (cùng mô hình {t,v,e} của
 *   text-animations.js; thuộc tính kiểu liệt kê giữ (hold) như AE).
 *
 * HÌNH HỌC — mọi hiệu ứng chỉ là cách tính VỊ TRÍ ĐÍCH cho các đỉnh của một lưới đều phủ ảnh
 * nguồn. Toạ độ đích tính theo "đơn vị hộp" (px của block ở scale 100 %), gốc ở TÂM hộp — nên
 * position_x/y vẫn là tâm block và bật/tắt hiệu ứng không làm block nhảy chỗ (như Warp chữ).
 *
 * VẼ — kéo ảnh nguồn lên lưới tam giác đã biến dạng: affine từng tam giác + lấy mẫu song tuyến
 * tính trên alpha NHÂN SẴN, ngoài ảnh = trong suốt (đúng phép của TextDeform.rasterWarp). Ba bản
 * cùng một phép toán:
 *   - WebGL2 (preview, MeshRenderer)          — kéo tay nắm / phát mượt;
 *   - JS CPU (rasterMesh)                     — bake PNG ảnh/Shape khi xuất, và test;
 *   - C++ (native/sidecar/core_process.cpp)   — video khi xuất (DistortVideoPrepass).
 * Tam giác chồng nhau (lưới tự gấp) thì tam giác vẽ SAU thắng, ở cả ba bản.
 *
 * XUẤT VIDEO — lưới của Wave trên video 1080p có thể tới hàng trăm nghìn đỉnh, gửi từng khung là
 * quá nặng, nên frontend chỉ gửi THAM SỐ đã nội suy của từng khung (exportSpec) và sidecar tự
 * dựng lưới bằng CÙNG công thức (gridSpec / evalGrid được viết lại 1-1 bằng C++; test
 * tests/scripts/distort.js so số của hai bản).
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.Distort = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const _t = (typeof globalThis !== 'undefined' && globalThis._t)
        || ((k, p) => (p ? String(k).replace(/\{(\w+)\}/g, (m, n) => (n in p ? p[n] : m)) : k));
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    const KF_PREFIX = 'dst.';
    const MAX_EFFECTS = 8;
    // Trần số ô lưới mỗi trục — PHẢI trùng kDistortMaxCells của sidecar.
    const MAX_CELLS = 512;
    const MIN_CELLS = 8;

    const clampNum = (v, lo, hi, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
    };

    /* ===================================================================== THAM SỐ */

    // Cùng danh sách và cùng tên với Wave Warp của After Effects.
    const WAVE_SHAPES = [
        { id: 'sine', label: 'Sine' },
        { id: 'square', label: 'Square' },
        { id: 'triangle', label: 'Triangle' },
        { id: 'sawtooth', label: 'Sawtooth' },
        { id: 'circle', label: 'Circle' },
        { id: 'semicircle', label: 'Semicircle' },
        { id: 'uncircle', label: 'Uncircle' },
        { id: 'noise', label: 'Noise' },
        { id: 'smooth_noise', label: 'Smooth Noise' },
    ];
    const WAVE_PINNING = [
        { id: 'none', label: 'None' },
        { id: 'all_edges', label: 'All Edges' },
        { id: 'center', label: 'Center' },
        { id: 'left', label: 'Left Edge' },
        { id: 'top', label: 'Top Edge' },
        { id: 'right', label: 'Right Edge' },
        { id: 'bottom', label: 'Bottom Edge' },
        { id: 'horizontal_edges', label: 'Horizontal Edges' },
        { id: 'vertical_edges', label: 'Vertical Edges' },
    ];

    /* Bezier Warp: 12 điểm, mỗi điểm một thông số keyframe RIÊNG như AE. Toạ độ CHUẨN HOÁ theo hộp
     * (0..1, gốc trên-trái) — đổi cỡ Shape / đổi nguồn không làm lệch biến dạng; Inspector hiện px.
     * Bốn cạnh là bốn đường cong bậc ba:
     *   trên  : tl_vertex, tl_tangent, tr_tangent, rt_vertex
     *   phải  : rt_vertex, rt_tangent, rb_tangent, br_vertex
     *   dưới  : lb_vertex, bl_tangent, br_tangent, br_vertex   (trái -> phải)
     *   trái  : tl_vertex, lt_tangent, lb_tangent, lb_vertex   (trên -> dưới) */
    const T1 = 1 / 3;
    const T2 = 2 / 3;
    const BEZIER_POINTS = [
        { key: 'tl_vertex', label: 'Top Left Vertex', def: [0, 0], vertex: true },
        { key: 'tl_tangent', label: 'Top Left Tangent', def: [T1, 0] },
        { key: 'tr_tangent', label: 'Top Right Tangent', def: [T2, 0] },
        { key: 'rt_vertex', label: 'Right Top Vertex', def: [1, 0], vertex: true },
        { key: 'rt_tangent', label: 'Right Top Tangent', def: [1, T1] },
        { key: 'rb_tangent', label: 'Right Bottom Tangent', def: [1, T2] },
        { key: 'br_vertex', label: 'Bottom Right Vertex', def: [1, 1], vertex: true },
        { key: 'br_tangent', label: 'Bottom Right Tangent', def: [T2, 1] },
        { key: 'bl_tangent', label: 'Bottom Left Tangent', def: [T1, 1] },
        { key: 'lb_vertex', label: 'Left Bottom Vertex', def: [0, 1], vertex: true },
        { key: 'lb_tangent', label: 'Left Bottom Tangent', def: [0, T2] },
        { key: 'lt_tangent', label: 'Left Top Tangent', def: [0, T1] },
    ];
    // Kéo đỉnh thì hai tiếp tuyến kề nó đi theo (như AE).
    const BEZIER_VERTEX_TANGENTS = {
        tl_vertex: ['tl_tangent', 'lt_tangent'],
        rt_vertex: ['tr_tangent', 'rt_tangent'],
        br_vertex: ['rb_tangent', 'br_tangent'],
        lb_vertex: ['bl_tangent', 'lb_tangent'],
    };
    // Mỗi đỉnh lưới Mesh Warp = 10 số: x, y, rồi 4 tay cầm (TƯƠNG ĐỐI so với đỉnh) trái, phải, lên, xuống.
    const MESH_STRIDE = 10;

    /* Bảng thông số theo loại hiệu ứng. `kind`: 'num' nội suy, 'enum' giữ (hold), 'vec2' / 'mesh'
     * nội suy từng số. Thông số nào có đồng hồ bấm giờ trong AE thì có ◆; `noKf` = không (Quality,
     * Rows, Columns). `slider` = dải thanh trượt (ô số vẫn nhận tới min/max). */
    const EFFECT_DEFS = {
        wave: {
            label: 'Wave Warp',
            params: [
                { key: 'wave_type', label: 'Wave Type', kind: 'enum', options: WAVE_SHAPES, def: 'sine' },
                { key: 'height', label: 'Wave Height', kind: 'num', def: 10, min: -2000, max: 2000, slider: [-100, 100], step: 1, unit: 'px' },
                { key: 'width', label: 'Wave Width', kind: 'num', def: 40, min: 1, max: 4000, slider: [1, 400], step: 1, unit: 'px' },
                { key: 'direction', label: 'Direction', kind: 'num', def: 90, min: -3600, max: 3600, slider: [0, 360], step: 1, unit: '°' },
                { key: 'speed', label: 'Wave Speed', kind: 'num', def: 1, min: -100, max: 100, slider: [-10, 10], step: 0.1, unit: '' },
                { key: 'pinning', label: 'Pinning', kind: 'enum', options: WAVE_PINNING, def: 'none' },
                { key: 'phase', label: 'Phase', kind: 'num', def: 0, min: -36000, max: 36000, slider: [0, 360], step: 1, unit: '°' },
            ],
        },
        bezier: {
            label: 'Bezier Warp',
            handles: true,
            params: [
                ...BEZIER_POINTS.map((p) => ({ key: p.key, label: p.label, kind: 'vec2', def: p.def })),
                { key: 'quality', label: 'Quality', kind: 'num', def: 8, min: 1, max: 10, slider: [1, 10], step: 1, unit: '', noKf: true },
            ],
        },
        mesh: {
            label: 'Mesh Warp',
            handles: true,
            params: [
                { key: 'rows', label: 'Rows', kind: 'num', def: 7, min: 1, max: 31, slider: [1, 31], step: 1, unit: '', noKf: true },
                { key: 'cols', label: 'Columns', kind: 'num', def: 7, min: 1, max: 31, slider: [1, 31], step: 1, unit: '', noKf: true },
                { key: 'quality', label: 'Quality', kind: 'num', def: 8, min: 1, max: 10, slider: [1, 10], step: 1, unit: '', noKf: true },
                { key: 'mesh', label: 'Distortion Mesh', kind: 'mesh', def: null },
            ],
        },
    };
    const TYPE_IDS = Object.keys(EFFECT_DEFS);

    function paramDef(type, key) {
        const def = EFFECT_DEFS[type];
        return def ? def.params.find((p) => p.key === key) || null : null;
    }

    function normalizeParam(def, value) {
        if (def.kind === 'vec2') {
            if (!Array.isArray(value) || value.length !== 2) return def.def.slice();
            const x = Number(value[0]);
            const y = Number(value[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return def.def.slice();
            return [Math.max(-50, Math.min(50, x)), Math.max(-50, Math.min(50, y))];
        }
        if (def.kind === 'mesh') {
            // Độ dài được đối chiếu với Rows/Columns ở normalizeEffect / meshArray.
            if (!Array.isArray(value) || !value.length || value.length > 32 * 32 * MESH_STRIDE) return null;
            const out = value.map(Number);
            return out.every(Number.isFinite) ? out.map((v) => Math.max(-50, Math.min(50, v))) : null;
        }
        if (def.step === 1 && def.noKf) return Math.round(clampNum(value, def.min, def.max, def.def));
        if (def.kind === 'enum') {
            const v = String(value == null ? '' : value);
            return def.options.some((o) => o.id === v) ? v : def.def;
        }
        return clampNum(value, def.min, def.max, def.def);
    }

    /* ===================================================================== DỮ LIỆU */

    function normalizeEffect(raw, index = 0) {
        if (!raw || typeof raw !== 'object' || !EFFECT_DEFS[raw.type]) return null;
        const id = /^[A-Za-z0-9_-]{1,24}$/.test(String(raw.id || '')) ? String(raw.id) : `d${index + 1}`;
        const params = {};
        EFFECT_DEFS[raw.type].params.forEach((def) => {
            params[def.key] = normalizeParam(def, raw.params ? raw.params[def.key] : undefined);
        });
        if (raw.type === 'mesh' && params.mesh && params.mesh.length !== meshLength(params.rows, params.cols)) params.mesh = null;
        return { id, type: raw.type, enabled: raw.enabled !== false, params };
    }

    function normalizeStack(list) {
        if (!Array.isArray(list)) return [];
        const seen = new Set();
        const out = [];
        list.slice(0, MAX_EFFECTS).forEach((raw, i) => {
            const fx = normalizeEffect(raw, i);
            if (!fx) return;
            while (seen.has(fx.id)) fx.id = `${fx.id}x`;
            seen.add(fx.id);
            out.push(fx);
        });
        return out;
    }

    function supportsItem(item) {
        return !!item && (item.type === 'media' || item.type === 'shape');
    }

    // Block có ít nhất một hiệu ứng đang BẬT. Quyết định loại thẻ preview (canvas) nên chỉ xét
    // cấu hình, không xét thời điểm — như itemHasColorAdjust.
    function isActive(item) {
        if (!supportsItem(item) || !Array.isArray(item.distort)) return false;
        return normalizeStack(item.distort).some((fx) => fx.enabled);
    }

    function newEffectId(item) {
        const used = new Set((Array.isArray(item?.distort) ? item.distort : []).map((fx) => String(fx?.id || '')));
        for (let n = 1; n < 1000; n += 1) {
            if (!used.has(`d${n}`)) return `d${n}`;
        }
        return `d${Date.now()}`;
    }

    function createEffect(item, type) {
        if (!EFFECT_DEFS[type]) return null;
        return normalizeEffect({ id: newEffectId(item), type, enabled: true, params: {} });
    }

    /* ===================================================================== KEYFRAME */

    const kfField = (effectId, key) => `${KF_PREFIX}${effectId}.${key}`;
    const isKfField = (field) => String(field || '').startsWith(KF_PREFIX);
    function parseKfField(field) {
        const m = /^dst\.([A-Za-z0-9_-]+)\.([a-z_]+)$/.exec(String(field || ''));
        return m ? { effectId: m[1], key: m[2] } : null;
    }

    function easeFn(name) {
        const E = (typeof globalThis !== 'undefined' && globalThis.TextAnimations && globalThis.TextAnimations.EASINGS)
            || null;
        if (E && E[name]) return E[name];
        if (E && E['ease-in-out']) return E['ease-in-out'];
        return (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
    }

    /* Nội suy một thông số tại t (giây cục bộ). Giữ mép như evalKeyframeField; số -> easing của
     * keyframe TRÁI; liệt kê -> giữ giá trị keyframe trái (Hold của AE). null = không có keyframe. */
    function evalParamKeyframes(list, t, def) {
        if (!Array.isArray(list) || !list.length) return null;
        const arr = list.slice().sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
        const time = Number(t) || 0;
        const val = (k) => normalizeParam(def, k.v);
        const vector = def.kind === 'vec2' || def.kind === 'mesh';
        const mix = (a, b, k) => {
            if (!vector) return a + (b - a) * k;
            if (!a || !b || a.length !== b.length) return a;   // lưới khác cỡ: giữ (Hold)
            return a.map((x, i) => x + (b[i] - x) * k);
        };
        if (arr.length === 1 || time <= Number(arr[0].t)) return val(arr[0]);
        const last = arr[arr.length - 1];
        if (time >= Number(last.t)) return val(last);
        for (let i = 0; i < arr.length - 1; i += 1) {
            const a = arr[i];
            const b = arr[i + 1];
            const ta = Number(a.t);
            const tb = Number(b.t);
            if (time >= ta && time <= tb) {
                if (def.kind === 'enum') return val(time >= tb ? b : a);
                const p = Math.min(1, Math.max(0, (time - ta) / Math.max(1e-6, tb - ta)));
                const k = easeFn(a.e)(p);
                return mix(val(a), val(b), k);
            }
        }
        return val(last);
    }

    // Thông số HIỆU DỤNG của một hiệu ứng tại t (đã áp keyframe).
    function effectParamsAt(item, fx, t) {
        const out = { ...fx.params };
        const kfs = item && item.keyframes;
        if (!kfs || typeof kfs !== 'object') return out;
        EFFECT_DEFS[fx.type].params.forEach((def) => {
            if (def.noKf) return;
            const v = evalParamKeyframes(kfs[kfField(fx.id, def.key)], t, def);
            if (v != null) out[def.key] = v;
        });
        if (fx.type === 'mesh' && out.mesh && out.mesh.length !== meshLength(out.rows, out.cols)) out.mesh = fx.params.mesh;
        return out;
    }

    // Danh sách hiệu ứng BẬT với thông số tại t: [{ type, params }].
    function stackAt(item, t) {
        return normalizeStack(item && item.distort)
            .filter((fx) => fx.enabled)
            .map((fx) => ({ type: fx.type, params: effectParamsAt(item, fx, t) }));
    }

    function hasDistortKeyframes(item) {
        const kfs = item && item.keyframes;
        if (!kfs || typeof kfs !== 'object') return false;
        return Object.keys(kfs).some((k) => isKfField(k) && Array.isArray(kfs[k]) && kfs[k].length > 0);
    }

    // Kết quả có đổi theo thời gian không (keyframe, hoặc sóng đang chạy).
    function isTimeVarying(item) {
        const stack = normalizeStack(item && item.distort).filter((fx) => fx.enabled);
        if (!stack.length) return false;
        if (stack.some((fx) => {
            const kfs = item.keyframes || {};
            return EFFECT_DEFS[fx.type].params.some((def) => Array.isArray(kfs[kfField(fx.id, def.key)])
                && kfs[kfField(fx.id, def.key)].length > 1);
        })) return true;
        return stack.some((fx) => fx.type === 'wave' && (Math.abs(Number(fx.params.speed) || 0) > 1e-9
            || ((item.keyframes || {})[kfField(fx.id, 'speed')] || []).some((k) => Math.abs(Number(k.v) || 0) > 1e-9)));
    }

    // Mọi giá trị một thông số số có thể nhận (tĩnh + keyframe) — để tính lưới/biên ổn định cả clip.
    function paramValues(item, fx, key) {
        const def = paramDef(fx.type, key);
        const list = (item && item.keyframes && item.keyframes[kfField(fx.id, key)]) || [];
        const vals = list.length ? list.map((k) => normalizeParam(def, k.v)) : [fx.params[key]];
        return vals.map(Number).filter(Number.isFinite);
    }
    const paramKeyframed = (item, fx, key) => {
        const list = item && item.keyframes && item.keyframes[kfField(fx.id, key)];
        return Array.isArray(list) && list.length > 0;
    };

    /* ===================================================================== WAVE WARP */

    // Hàm băm số nguyên 32 bit — viết lại y hệt ở sidecar (DistortHash) để Noise khớp từng bit.
    function hash32(n) {
        let x = Math.imul(n | 0, 0x27d4eb2d);
        x ^= x >>> 15;
        x = Math.imul(x, 0x85ebca6b);
        x ^= x >>> 13;
        x = Math.imul(x, 0xc2b2ae35);
        x ^= x >>> 16;
        return ((x >>> 0) / 4294967295) * 2 - 1;
    }

    // Dạng sóng theo pha u (chu kỳ 1). Biên độ trong [-1, 1].
    function waveShape(type, u) {
        const f = u - Math.floor(u);
        switch (type) {
            case 'square': return f < 0.5 ? 1 : -1;
            case 'triangle': return f < 0.25 ? 4 * f : (f < 0.75 ? 2 - 4 * f : 4 * f - 4);
            case 'sawtooth': return f < 0.5 ? 2 * f : 2 * f - 2;
            case 'circle': {
                const a = f < 0.5 ? 4 * f - 1 : 4 * f - 3;
                const s = Math.sqrt(Math.max(0, 1 - a * a));
                return f < 0.5 ? s : -s;
            }
            case 'semicircle': {
                const a = 2 * f - 1;
                return Math.sqrt(Math.max(0, 1 - a * a));
            }
            case 'uncircle': {
                const a = 2 * f - 1;
                return 1 - Math.sqrt(Math.max(0, 1 - a * a));
            }
            case 'noise': return hash32(Math.floor(2 * u));
            case 'smooth_noise': {
                const v = 2 * u;
                const n = Math.floor(v);
                const k = (1 - Math.cos((v - n) * Math.PI)) / 2;
                const a = hash32(n);
                return a + (hash32(n + 1) - a) * k;
            }
            default: return Math.sin(2 * Math.PI * u);
        }
    }

    // Trọng số ghim theo vị trí chuẩn hoá (nx, ny ∈ [0,1]); 0 = đứng yên.
    function pinWeight(pinning, nx, ny) {
        switch (pinning) {
            case 'all_edges': return Math.sin(Math.PI * nx) * Math.sin(Math.PI * ny);
            case 'center': return Math.min(1, 2 * Math.hypot(nx - 0.5, ny - 0.5));
            case 'left': return nx;
            case 'right': return 1 - nx;
            case 'top': return ny;
            case 'bottom': return 1 - ny;
            case 'horizontal_edges': return Math.sin(Math.PI * ny);
            case 'vertical_edges': return Math.sin(Math.PI * nx);
            default: return 1;
        }
    }

    /* Hướng theo la bàn của AE: 0° = lên, 90° = sang phải. Sóng CHẠY theo `dir`, điểm dời theo
     * phương VUÔNG GÓC `nrm` (sóng ngang). Pha đo từ góc trên-trái của hộp. */
    function waveFrame(p, t) {
        const rad = (Number(p.direction) || 0) * Math.PI / 180;
        return {
            dx: Math.sin(rad),
            dy: -Math.cos(rad),
            nx: Math.cos(rad),
            ny: Math.sin(rad),
            invW: 1 / Math.max(1, Math.abs(Number(p.width) || 1)),
            shift: (Number(p.speed) || 0) * (Number(t) || 0) - (Number(p.phase) || 0) / 360,
            h: Number(p.height) || 0,
        };
    }

    /* ===================================================================== BEZIER / MESH WARP */

    const meshLength = (rows, cols) => (Math.round(rows) + 1) * (Math.round(cols) + 1) * MESH_STRIDE;

    // Lưới Mesh Warp chưa uốn: đỉnh chia đều, tay cầm bằng 1/3 cạnh ô -> mọi ô là ánh xạ đồng nhất.
    function meshIdentity(rows, cols) {
        const r = Math.round(rows);
        const c = Math.round(cols);
        const out = new Array(meshLength(r, c));
        for (let j = 0, q = 0; j <= r; j += 1) {
            for (let i = 0; i <= c; i += 1, q += MESH_STRIDE) {
                out[q] = i / c; out[q + 1] = j / r;
                out[q + 2] = -1 / (3 * c); out[q + 3] = 0;
                out[q + 4] = 1 / (3 * c); out[q + 5] = 0;
                out[q + 6] = 0; out[q + 7] = -1 / (3 * r);
                out[q + 8] = 0; out[q + 9] = 1 / (3 * r);
            }
        }
        return out;
    }

    function meshArray(p) {
        const m = p && Array.isArray(p.mesh) ? p.mesh : null;
        return m && m.length === meshLength(p.rows, p.cols) ? m : meshIdentity(p.rows, p.cols);
    }

    const cubic = (a, b, c, d, t) => {
        const s = 1 - t;
        return s * s * s * a + 3 * s * s * t * b + 3 * s * t * t * c + t * t * t * d;
    };

    /* Mặt Coons từ bốn cạnh bậc ba (toạ độ chuẩn hoá). k = [p00x,p00y, p10.., p01.., p11..,
     * trên a/b, dưới a/b, trái a/b, phải a/b] — 20 số. (u, v) có thể ra ngoài [0,1] (ngoại suy). */
    function coons(k, u, v) {
        const out = [0, 0];
        for (let c = 0; c < 2; c += 1) {
            const p00 = k[c]; const p10 = k[2 + c]; const p01 = k[4 + c]; const p11 = k[6 + c];
            const top = cubic(p00, k[8 + c], k[10 + c], p10, u);
            const bot = cubic(p01, k[12 + c], k[14 + c], p11, u);
            const lft = cubic(p00, k[16 + c], k[18 + c], p01, v);
            const rgt = cubic(p10, k[20 + c], k[22 + c], p11, v);
            out[c] = (1 - v) * top + v * bot + (1 - u) * lft + u * rgt
                - ((1 - u) * (1 - v) * p00 + u * (1 - v) * p10 + (1 - u) * v * p01 + u * v * p11);
        }
        return out;
    }

    // 24 số của mặt Coons Bezier Warp (cùng thứ tự với `coons`).
    function bezierPatch(p) {
        const P = (key) => p[key];
        return [
            ...P('tl_vertex'), ...P('rt_vertex'), ...P('lb_vertex'), ...P('br_vertex'),
            ...P('tl_tangent'), ...P('tr_tangent'),
            ...P('bl_tangent'), ...P('br_tangent'),
            ...P('lt_tangent'), ...P('lb_tangent'),
            ...P('rt_tangent'), ...P('rb_tangent'),
        ];
    }

    // 24 số của ô (i, j) trong Mesh Warp.
    function meshCellPatch(m, cols, i, j) {
        const at = (ii, jj) => (jj * (cols + 1) + ii) * MESH_STRIDE;
        const a = at(i, j); const b = at(i + 1, j); const c = at(i, j + 1); const d = at(i + 1, j + 1);
        return [
            m[a], m[a + 1], m[b], m[b + 1], m[c], m[c + 1], m[d], m[d + 1],
            m[a] + m[a + 4], m[a + 1] + m[a + 5], m[b] + m[b + 2], m[b + 1] + m[b + 3],   // trên: phải của a, trái của b
            m[c] + m[c + 4], m[c + 1] + m[c + 5], m[d] + m[d + 2], m[d + 1] + m[d + 3],   // dưới
            m[a] + m[a + 8], m[a + 1] + m[a + 9], m[c] + m[c + 6], m[c + 1] + m[c + 7],   // trái: xuống của a, lên của c
            m[b] + m[b + 8], m[b + 1] + m[b + 9], m[d] + m[d + 6], m[d + 1] + m[d + 7],   // phải
        ];
    }

    // Ánh xạ một điểm chuẩn hoá (U, V) qua Mesh Warp: tìm ô, toạ độ cục bộ (ngoại suy ở mép).
    function meshMap(m, rows, cols, U, V, cache) {
        const ci = Math.max(0, Math.min(cols - 1, Math.floor(U * cols)));
        const cj = Math.max(0, Math.min(rows - 1, Math.floor(V * rows)));
        const key = cj * cols + ci;
        let k = cache[key];
        if (!k) { k = meshCellPatch(m, cols, ci, cj); cache[key] = k; }
        return coons(k, U * cols - ci, V * rows - cj);
    }

    /* ===================================================================== LƯỚI */

    /* Số ô lưới mỗi trục cho cả clip (KHÔNG đổi theo thời gian, để preview và bản xuất cùng một
     * lưới). Sóng: ~8 ô mỗi bước sóng theo phương sóng chạy; trục vuông góc với phương chạy gần như
     * không đổi nên ít ô. Hướng có keyframe thì coi cả hai trục đều cần dày. */
    function gridSpec(item, boxW, boxH) {
        let cx = MIN_CELLS;
        let cy = MIN_CELLS;
        normalizeStack(item && item.distort).filter((fx) => fx.enabled).forEach((fx) => {
            if (fx.type === 'wave') {
                const wMin = Math.max(1, Math.min(...paramValues(item, fx, 'width').map(Math.abs)));
                let ax = 1;
                let ay = 1;
                if (!paramKeyframed(item, fx, 'direction')) {
                    const rad = (Number(fx.params.direction) || 0) * Math.PI / 180;
                    ax = Math.max(0.02, Math.abs(Math.sin(rad)));
                    ay = Math.max(0.02, Math.abs(Math.cos(rad)));
                }
                cx = Math.max(cx, Math.ceil((boxW * ax * 8) / wMin));
                cy = Math.max(cy, Math.ceil((boxH * ay * 8) / wMin));
            } else if (fx.type === 'bezier') {
                // Quality của AE (1..10) -> 4..40 ô mỗi trục.
                cx = Math.max(cx, 4 * fx.params.quality);
                cy = Math.max(cy, 4 * fx.params.quality);
            } else if (fx.type === 'mesh') {
                cx = Math.max(cx, fx.params.cols * Math.max(2, fx.params.quality));
                cy = Math.max(cy, fx.params.rows * Math.max(2, fx.params.quality));
            }
        });
        return {
            cols: Math.max(MIN_CELLS, Math.min(MAX_CELLS, cx)),
            rows: Math.max(MIN_CELLS, Math.min(MAX_CELLS, cy)),
        };
    }

    /* Đỉnh đích của lưới (cols+1)×(rows+1), toạ độ theo TÂM hộp, đơn vị hộp. `stack` = stackAt().
     * Hiệu ứng áp lần lượt lên toạ độ (thứ tự = thứ tự trong ngăn hiệu ứng). */
    function evalGrid(stack, boxW, boxH, spec, t, out = null) {
        const { cols, rows } = spec;
        const n = (cols + 1) * (rows + 1) * 2;
        const pts = out && out.length === n ? out : new Float64Array(n);
        for (let j = 0, q = 0; j <= rows; j += 1) {
            const y = (j / rows - 0.5) * boxH;
            for (let i = 0; i <= cols; i += 1, q += 2) {
                pts[q] = (i / cols - 0.5) * boxW;
                pts[q + 1] = y;
            }
        }
        /* Hiệu ứng nối tiếp: hiệu ứng sau nhận vị trí ĐÃ dời của hiệu ứng trước (p -> f2(f1(p))).
         * `fx.t` (nếu có) là thời gian riêng của mục đó trong exportSpec; không thì dùng t. */
        stack.forEach((fx) => {
            if (fx.type === 'wave') {
                const wf = waveFrame(fx.params, fx.t != null ? fx.t : t);
                if (Math.abs(wf.h) < 1e-9) return;
                for (let q = 0; q < n; q += 2) {
                    const px = pts[q] + boxW / 2;
                    const py = pts[q + 1] + boxH / 2;
                    const u = (px * wf.dx + py * wf.dy) * wf.invW - wf.shift;
                    const d = wf.h * waveShape(fx.params.wave_type, u) * pinWeight(fx.params.pinning, px / boxW, py / boxH);
                    pts[q] += wf.nx * d;
                    pts[q + 1] += wf.ny * d;
                }
            } else if (fx.type === 'bezier' || fx.type === 'mesh') {
                const p = fx.params;
                const patch = fx.type === 'bezier' ? bezierPatch(p) : null;
                const m = fx.type === 'mesh' ? meshArray(p) : null;
                const cache = {};
                for (let q = 0; q < n; q += 2) {
                    const U = pts[q] / boxW + 0.5;
                    const V = pts[q + 1] / boxH + 0.5;
                    const r = patch ? coons(patch, U, V) : meshMap(m, p.rows, p.cols, U, V, cache);
                    pts[q] = (r[0] - 0.5) * boxW;
                    pts[q + 1] = (r[1] - 0.5) * boxH;
                }
            }
        });
        return pts;
    }

    /* Nửa bề rộng/cao của hộp ĐỐI XỨNG quanh tâm chứa trọn nội dung đã biến dạng, cho CẢ clip (cỡ
     * khung xuất phải cố định). Tính theo cận giải tích nên không phải dựng lưới từng khung; nhân
     * 1.15 cho easing vượt đích (Bật lại / Đàn hồi). */
    function maxExtents(item, boxW, boxH) {
        let padX = 0;
        let padY = 0;
        normalizeStack(item && item.distort).filter((fx) => fx.enabled).forEach((fx) => {
            if (fx.type === 'wave') {
                const hMax = Math.max(...paramValues(item, fx, 'height').map(Math.abs)) * 1.15;
                let ax = 1;
                let ay = 1;
                if (!paramKeyframed(item, fx, 'direction')) {
                    const rad = (Number(fx.params.direction) || 0) * Math.PI / 180;
                    ax = Math.abs(Math.cos(rad));
                    ay = Math.abs(Math.sin(rad));
                }
                padX += hMax * ax;
                padY += hMax * ay;
            } else if (fx.type === 'bezier' || fx.type === 'mesh') {
                /* Mặt Coons nằm trong bao lồi của các điểm điều khiển. Lấy mọi điểm điều khiển ở mọi
                 * keyframe; khi có keyframe cộng 15 % khoảng chênh (easing vượt đích). Hiệu ứng ĐỨNG
                 * TRƯỚC đã nở hộp bao nhiêu thì cộng thêm bấy nhiêu (ngoại suy theo mép). */
                const ctrl = controlSnapshots(item, fx);
                let mx = 0.5;
                let my = 0.5;
                let lo = [Infinity, Infinity];
                let hi = [-Infinity, -Infinity];
                ctrl.forEach((pts) => {
                    for (let q = 0; q < pts.length; q += 2) {
                        mx = Math.max(mx, Math.abs(pts[q] - 0.5));
                        my = Math.max(my, Math.abs(pts[q + 1] - 0.5));
                        lo = [Math.min(lo[0], pts[q]), Math.min(lo[1], pts[q + 1])];
                        hi = [Math.max(hi[0], pts[q]), Math.max(hi[1], pts[q + 1])];
                    }
                });
                const over = ctrl.length > 1 ? 0.15 : 0;
                const ex = (mx + over * (hi[0] - lo[0])) * boxW;
                const ey = (my + over * (hi[1] - lo[1])) * boxH;
                padX = Math.max(0, ex - boxW / 2) + padX;
                padY = Math.max(0, ey - boxH / 2) + padY;
            }
        });
        return { hx: boxW / 2 + padX + 1, hy: boxH / 2 + padY + 1 };
    }

    /* Toạ độ chuẩn hoá của MỌI điểm điều khiển (đỉnh + tay cầm tuyệt đối) của một Bezier/Mesh Warp,
     * một mảng cho giá trị tĩnh và một mảng cho mỗi keyframe. */
    function controlSnapshots(item, fx) {
        const kfs = (item && item.keyframes) || {};
        const snaps = [];
        if (fx.type === 'bezier') {
            const times = new Set([null]);
            BEZIER_POINTS.forEach((b) => (kfs[kfField(fx.id, b.key)] || []).forEach((k) => times.add(Number(k.t) || 0)));
            times.forEach((t) => {
                const p = t == null ? fx.params : effectParamsAt(item, fx, t);
                snaps.push(BEZIER_POINTS.flatMap((b) => p[b.key]));
            });
        } else {
            const list = kfs[kfField(fx.id, 'mesh')] || [];
            const meshes = [meshArray(fx.params)];
            list.forEach((k) => {
                const v = normalizeParam(paramDef('mesh', 'mesh'), k.v);
                if (v && v.length === meshLength(fx.params.rows, fx.params.cols)) meshes.push(v);
            });
            const { rows, cols } = fx.params;
            meshes.forEach((m) => {
                const pts = [];
                for (let j = 0, q = 0; j <= rows; j += 1) {
                    for (let i = 0; i <= cols; i += 1, q += MESH_STRIDE) {
                        pts.push(m[q], m[q + 1]);
                        // Tay cầm hướng RA NGOÀI mép lưới không thuộc ô nào -> bỏ.
                        if (i > 0) pts.push(m[q] + m[q + 2], m[q + 1] + m[q + 3]);
                        if (i < cols) pts.push(m[q] + m[q + 4], m[q + 1] + m[q + 5]);
                        if (j > 0) pts.push(m[q] + m[q + 6], m[q + 1] + m[q + 7]);
                        if (j < rows) pts.push(m[q] + m[q + 8], m[q + 1] + m[q + 9]);
                    }
                }
                snaps.push(pts);
            });
        }
        return snaps;
    }

    /* ===================================================================== VẼ (CPU) */

    /* src: RGBA THẲNG (ImageData.data) cỡ sw×sh. pts: đỉnh đích theo PIXEL CỦA ẢNH RA. Ghi vào
     * out (RGBA thẳng, outW×outH, đã xoá). Đỉnh (i,j) lấy mẫu nguồn tại (i/cols·sw, j/rows·sh).
     * Phép lấy mẫu giống hệt TextDeform.rasterWarp; khác ở chỗ tam giác SAU thắng (khớp WebGL). */
    function rasterMesh(src, sw, sh, cols, rows, pts, out, outW, outH) {
        const sample = (sx, sy, idx) => {
            const fx = sx - 0.5;
            const fy = sy - 0.5;
            const ix = Math.floor(fx);
            const iy = Math.floor(fy);
            const tx = fx - ix;
            const ty = fy - iy;
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
                out[idx] = r / a; out[idx + 1] = g / a; out[idx + 2] = b / a; out[idx + 3] = a;
            } else {
                out[idx] = 0; out[idx + 1] = 0; out[idx + 2] = 0; out[idx + 3] = 0;
            }
        };
        const tri = (x0, y0, x1, y1, x2, y2, u0, v0, u1, v1, u2, v2) => {
            const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
            if (Math.abs(area) < 1e-9) return;
            const bx0 = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
            const by0 = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
            const bx1 = Math.min(outW - 1, Math.ceil(Math.max(x0, x1, x2)));
            const by1 = Math.min(outH - 1, Math.ceil(Math.max(y0, y1, y2)));
            const eps = -1e-7;
            for (let py = by0; py <= by1; py += 1) {
                const cy = py + 0.5;
                for (let px = bx0; px <= bx1; px += 1) {
                    const cx = px + 0.5;
                    const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
                    const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
                    const w2 = 1 - w0 - w1;
                    if (w0 < eps || w1 < eps || w2 < eps) continue;
                    sample(w0 * u0 + w1 * u1 + w2 * u2, w0 * v0 + w1 * v1 + w2 * v2, (py * outW + px) * 4);
                }
            }
        };
        const stride = cols + 1;
        for (let j = 0; j < rows; j += 1) {
            const v0 = (j / rows) * sh;
            const v1 = ((j + 1) / rows) * sh;
            for (let i = 0; i < cols; i += 1) {
                const u0 = (i / cols) * sw;
                const u1 = ((i + 1) / cols) * sw;
                const a = (j * stride + i) * 2;
                const b = a + 2;
                const c = a + stride * 2;
                const d = c + 2;
                tri(pts[a], pts[a + 1], pts[b], pts[b + 1], pts[d], pts[d + 1], u0, v0, u1, v0, u1, v1);
                tri(pts[a], pts[a + 1], pts[d], pts[d + 1], pts[c], pts[c + 1], u0, v0, u1, v1, u0, v1);
            }
        }
        return out;
    }

    /* Đỉnh lưới (đơn vị hộp, theo tâm) -> pixel ảnh ra cỡ outW×outH có tâm trùng tâm hộp; k = số
     * pixel ảnh ra trên một đơn vị hộp. */
    function gridToPixels(pts, k, outW, outH, dst = null) {
        const res = dst && dst.length === pts.length ? dst : new Float64Array(pts.length);
        const ox = outW / 2;
        const oy = outH / 2;
        for (let q = 0; q < pts.length; q += 2) {
            res[q] = pts[q] * k + ox;
            res[q + 1] = pts[q + 1] * k + oy;
        }
        return res;
    }

    // Cỡ ảnh ra (pixel, chẵn) cho nửa-hộp (hx, hy) ở mật độ k.
    function outputSize(ext, k) {
        return {
            width: Math.max(2, 2 * Math.ceil(ext.hx * k)),
            height: Math.max(2, 2 * Math.ceil(ext.hy * k)),
        };
    }

    /* Vẽ biến dạng bằng CPU lên một canvas mới (dùng khi bake ảnh/Shape để xuất). `source` là bất
     * kỳ thứ gì drawImage nhận, kéo về đúng cỡ srcW×srcH (pixel nguồn); hộp là boxW×boxH đơn vị. */
    function warpToCanvas(item, source, srcW, srcH, boxW, boxH, t, opts = {}) {
        const k = srcW / Math.max(1e-6, boxW);
        const ext = opts.extents || maxExtents(item, boxW, boxH);
        const size = outputSize(ext, k);
        const canvas = opts.canvas || document.createElement('canvas');
        if (canvas.width !== size.width) canvas.width = size.width;
        if (canvas.height !== size.height) canvas.height = size.height;
        const ctx = canvas.getContext('2d');
        /* Điểm ảnh nguồn: đọc lại mỗi lần là getImageData cả ảnh (chậm với ảnh lớn). Caller dựng
         * chuỗi khung từ CÙNG một nguồn tĩnh thì truyền `opts.srcCache` ({}) để đọc đúng một lần. */
        const sw = Math.max(1, Math.round(srcW));
        const sh = Math.max(1, Math.round(srcH));
        const cache = opts.srcCache || null;
        let src = cache && cache.source === source && cache.w === sw && cache.h === sh ? cache.data : null;
        if (!src) {
            const srcCanvas = document.createElement('canvas');
            srcCanvas.width = sw;
            srcCanvas.height = sh;
            const sctx = srcCanvas.getContext('2d', { willReadFrequently: true });
            sctx.drawImage(source, 0, 0, sw, sh);
            src = sctx.getImageData(0, 0, sw, sh).data;
            if (cache) Object.assign(cache, { source, w: sw, h: sh, data: src });
        }
        const spec = opts.spec || gridSpec(item, boxW, boxH);
        const pts = gridToPixels(evalGrid(stackAt(item, t), boxW, boxH, spec, t), k, size.width, size.height);
        const img = ctx.createImageData(size.width, size.height);
        rasterMesh(src, sw, sh, spec.cols, spec.rows, pts, img.data, size.width, size.height);
        ctx.putImageData(img, 0, 0);
        return { canvas, width: size.width, height: size.height, boxWidth: size.width / k, boxHeight: size.height / k };
    }

    /* ===================================================================== VẼ (WebGL2, preview) */

    const VS = `#version 300 es
        in vec2 aDst; in vec2 aSrc; uniform vec2 uOut; out vec2 vSrc;
        void main() {
            vSrc = aSrc;
            vec2 c = aDst / uOut * 2.0 - 1.0;
            gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
        }`;
    /* Song tuyến tính TỰ VIẾT bằng texelFetch: điểm ngoài ảnh = trong suốt (đúng như rasterMesh),
     * thay vì CLAMP_TO_EDGE của phần cứng làm mép ảnh kéo dài ra. Texture đã nhân sẵn alpha nên
     * tổng có trọng số chính là màu nhân sẵn mà canvas premultipliedAlpha cần. */
    const FS = `#version 300 es
        precision highp float; precision highp int;
        uniform sampler2D uTex; uniform ivec2 uSize; in vec2 vSrc; out vec4 o;
        vec4 tap(ivec2 p) {
            if (p.x < 0 || p.y < 0 || p.x >= uSize.x || p.y >= uSize.y) return vec4(0.0);
            return texelFetch(uTex, p, 0);
        }
        void main() {
            vec2 f = vSrc - 0.5;
            vec2 fl = floor(f);
            vec2 t = f - fl;
            ivec2 i = ivec2(fl);
            o = mix(mix(tap(i), tap(i + ivec2(1, 0)), t.x), mix(tap(i + ivec2(0, 1)), tap(i + ivec2(1, 1)), t.x), t.y);
        }`;

    class MeshRenderer {
        constructor(canvas) {
            this.canvas = canvas;
            this.gl = canvas.getContext('webgl2', {
                alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
                // Giữ khung đã vẽ: bấm chọn đọc alpha của canvas (overlayAlphaAt) bằng drawImage.
                preserveDrawingBuffer: true,
            });
            if (!this.gl) return;
            const gl = this.gl;
            const sh = (type, src) => {
                const s = gl.createShader(type);
                gl.shaderSource(s, src);
                gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
                return s;
            };
            const prog = gl.createProgram();
            gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
            gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
            this.prog = prog;
            this.loc = {
                dst: gl.getAttribLocation(prog, 'aDst'),
                src: gl.getAttribLocation(prog, 'aSrc'),
                out: gl.getUniformLocation(prog, 'uOut'),
                size: gl.getUniformLocation(prog, 'uSize'),
                tex: gl.getUniformLocation(prog, 'uTex'),
            };
            this.vao = gl.createVertexArray();
            this.dstBuf = gl.createBuffer();
            this.srcBuf = gl.createBuffer();
            this.idxBuf = gl.createBuffer();
            this.tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.tex);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.topo = '';
            this.indexCount = 0;
            this.dstScratch = null;
        }

        get ok() { return !!this.gl && !!this.prog; }

        // Đỉnh nguồn + chỉ số tam giác chỉ dựng lại khi lưới hoặc cỡ nguồn đổi.
        ensureTopology(cols, rows, sw, sh) {
            const key = `${cols}x${rows}|${sw}x${sh}`;
            if (key === this.topo) return;
            const gl = this.gl;
            const src = new Float32Array((cols + 1) * (rows + 1) * 2);
            for (let j = 0, q = 0; j <= rows; j += 1) {
                for (let i = 0; i <= cols; i += 1, q += 2) {
                    src[q] = (i / cols) * sw;
                    src[q + 1] = (j / rows) * sh;
                }
            }
            const stride = cols + 1;
            const count = cols * rows * 6;
            const idx = (cols + 1) * (rows + 1) > 65535 ? new Uint32Array(count) : new Uint16Array(count);
            for (let j = 0, q = 0; j < rows; j += 1) {
                for (let i = 0; i < cols; i += 1) {
                    const a = j * stride + i;
                    const b = a + 1;
                    const c = a + stride;
                    const d = c + 1;
                    // Cùng thứ tự với rasterMesh: (a,b,d) rồi (a,d,c) — tam giác sau thắng.
                    idx[q++] = a; idx[q++] = b; idx[q++] = d;
                    idx[q++] = a; idx[q++] = d; idx[q++] = c;
                }
            }
            gl.bindVertexArray(this.vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.srcBuf);
            gl.bufferData(gl.ARRAY_BUFFER, src, gl.STATIC_DRAW);
            gl.enableVertexAttribArray(this.loc.src);
            gl.vertexAttribPointer(this.loc.src, 2, gl.FLOAT, false, 0, 0);
            gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
            gl.bindVertexArray(null);
            this.indexType = idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
            this.indexCount = count;
            this.topo = key;
        }

        /* source: <video>/<img>/<canvas> cỡ sw×sh; pts: đỉnh đích theo PIXEL của canvas này. */
        draw(source, sw, sh, cols, rows, pts) {
            if (!this.ok) return false;
            const gl = this.gl;
            const W = this.canvas.width;
            const H = this.canvas.height;
            gl.viewport(0, 0, W, H);
            gl.clearColor(0, 0, 0, 0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            this.ensureTopology(cols, rows, sw, sh);
            gl.bindTexture(gl.TEXTURE_2D, this.tex);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            try {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            } catch (_) {
                return false;
            }
            if (!this.dstScratch || this.dstScratch.length !== pts.length) this.dstScratch = new Float32Array(pts.length);
            this.dstScratch.set(pts);
            gl.useProgram(this.prog);
            gl.bindVertexArray(this.vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.dstBuf);
            gl.bufferData(gl.ARRAY_BUFFER, this.dstScratch, gl.DYNAMIC_DRAW);
            gl.enableVertexAttribArray(this.loc.dst);
            gl.vertexAttribPointer(this.loc.dst, 2, gl.FLOAT, false, 0, 0);
            gl.uniform2f(this.loc.out, W, H);
            // Cỡ texture THẬT (video/ảnh có thể khác sw×sh khi caller kéo về cỡ khác).
            const tw = source.videoWidth || source.naturalWidth || source.width || sw;
            const th = source.videoHeight || source.naturalHeight || source.height || sh;
            gl.uniform2i(this.loc.size, tw, th);
            gl.uniform1i(this.loc.tex, 0);
            gl.activeTexture(gl.TEXTURE0);
            gl.disable(gl.BLEND);
            gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
            gl.bindVertexArray(null);
            return true;
        }

        destroy() {
            const gl = this.gl;
            if (!gl) return;
            try {
                gl.deleteBuffer(this.dstBuf); gl.deleteBuffer(this.srcBuf); gl.deleteBuffer(this.idxBuf);
                gl.deleteTexture(this.tex); gl.deleteVertexArray(this.vao); gl.deleteProgram(this.prog);
                const lose = gl.getExtension('WEBGL_lose_context');
                if (lose) lose.loseContext();
            } catch (_) { /* context đã mất */ }
            this.gl = null;
        }
    }

    /* ===================================================================== XUẤT VIDEO */

    /* Spec cho sidecar: tham số của TỪNG khung (đã nội suy keyframe) ở nhịp xuất, khử trùng lặp
     * (khung đứng yên chỉ là một chỉ số). Khung k lấy mẫu tại GIỮA khung ((k+0.5)/fps) — như
     * renderAnimationSequence, khớp cách ffmpeg hiển thị khung đó.
     *   box: đơn vị hộp; ext: nửa-hộp chứa nội dung (đơn vị hộp); grid: số ô; t: giây cục bộ. */
    /* Lưới Mesh tại t dưới dạng TRỘN hai lưới gốc { a, b, k }: lưới = a + (b − a)·k — đúng phép của
     * evalParamKeyframes (k đã qua easing). Nhờ vậy spec xuất chỉ mang MỖI lưới keyframe một lần,
     * mỗi khung chỉ còn ba số; gửi nguyên lưới từng khung thì Mesh 31×31 có keyframe dài 60 s là
     * ~240 MB JSON (vượt trần body của /api/export-video). */
    function meshMixAt(item, fx, t, cache = new Map()) {
        const len = meshLength(fx.params.rows, fx.params.cols);
        // `cache` (giữ suốt một lượt exportSpec): cùng keyframe -> CÙNG mảng, để gộp theo tham chiếu.
        if (!cache.has('base')) cache.set('base', meshArray(fx.params));
        const base = cache.get('base');
        const list = item && item.keyframes ? item.keyframes[kfField(fx.id, 'mesh')] : null;
        if (!Array.isArray(list) || !list.length) return { a: base, b: base, k: 0 };
        const def = paramDef('mesh', 'mesh');
        const arr = list.slice().sort((x, y) => (Number(x.t) || 0) - (Number(y.t) || 0));
        const raw = (kf) => {
            if (!cache.has(kf)) cache.set(kf, normalizeParam(def, kf.v));
            return cache.get(kf);
        };
        const ok = (v) => (v && v.length === len ? v : base);
        const time = Number(t) || 0;
        const last = arr[arr.length - 1];
        if (arr.length === 1 || time <= Number(arr[0].t)) { const v = ok(raw(arr[0])); return { a: v, b: v, k: 0 }; }
        if (time >= Number(last.t)) { const v = ok(raw(last)); return { a: v, b: v, k: 0 }; }
        for (let i = 0; i < arr.length - 1; i += 1) {
            const ta = Number(arr[i].t);
            const tb = Number(arr[i + 1].t);
            if (time >= ta && time <= tb) {
                const ra = raw(arr[i]);
                const rb = raw(arr[i + 1]);
                // Khác cỡ: giữ (Hold) như evalParamKeyframes; kết quả sai cỡ thì về lưới tĩnh.
                if (!ra || !rb || ra.length !== rb.length) { const v = ok(ra); return { a: v, b: v, k: 0 }; }
                if (ra.length !== len) return { a: base, b: base, k: 0 };
                const p = Math.min(1, Math.max(0, (time - ta) / Math.max(1e-6, tb - ta)));
                return { a: ra, b: rb, k: easeFn(arr[i].e)(p) };
            }
        }
        const v = ok(raw(last));
        return { a: v, b: v, k: 0 };
    }

    function exportSpec(item, boxW, boxH, fps, duration) {
        const spec = gridSpec(item, boxW, boxH);
        const ext = maxExtents(item, boxW, boxH);
        const rate = Math.max(1, Number(fps) || 30);
        const count = Math.max(1, Math.round(Math.max(0.01, Number(duration) || 0) * rate));
        const stacks = [];
        const keys = new Map();
        const frames = new Array(count);
        const meshes = [];
        const meshIndex = new Map();   // mảng lưới (theo tham chiếu) -> chỉ số trong `meshes`
        const meshRef = (m) => {
            let at = meshIndex.get(m);
            if (at === undefined) { at = meshes.length; meshes.push(m); meshIndex.set(m, at); }
            return at;
        };
        const enabled = normalizeStack(item && item.distort).filter((fx) => fx.enabled);
        const mixCaches = enabled.map(() => new Map());
        for (let k = 0; k < count; k += 1) {
            const t = (k + 0.5) / rate;
            // Thời gian chỉ đi vào hình khi sóng đang chạy; sóng đứng yên ghi t = 0 để các khung
            // giống nhau gộp được thành một mục.
            const stack = stackAt(item, t).map((fx, i) => {
                if (fx.type === 'mesh') {
                    const mix = meshMixAt(item, enabled[i], t, mixCaches[i]);
                    const { mesh: _m, ...rest } = fx.params;
                    return { type: 'mesh', t: 0, params: rest, mesh_ref: [meshRef(mix.a), meshRef(mix.b), mix.k] };
                }
                return {
                    type: fx.type,
                    t: fx.type === 'wave' && Math.abs(Number(fx.params.speed) || 0) > 1e-9 ? t : 0,
                    params: fx.params,
                };
            });
            const key = JSON.stringify(stack);
            let at = keys.get(key);
            if (at === undefined) {
                at = stacks.length;
                stacks.push(stack);
                keys.set(key, at);
            }
            frames[k] = at;
        }
        return {
            version: 1,
            box: { w: boxW, h: boxH },
            ext: { hx: ext.hx, hy: ext.hy },
            grid: spec,
            fps: rate,
            frames,
            stacks,
            meshes,
        };
    }

    // Lưới của một mục trong exportSpec (test so khớp với sidecar dùng). Mesh dựng lại từ mesh_ref.
    function evalSpecStack(specStack, boxW, boxH, grid, meshes = []) {
        const stack = specStack.map((fx) => {
            if (fx.type !== 'mesh' || !fx.mesh_ref) return fx;
            const [ia, ib, k] = fx.mesh_ref;
            const a = meshes[ia];
            const b = meshes[ib];
            return { ...fx, params: { ...fx.params, mesh: a.map((x, i) => x + (b[i] - x) * k) } };
        });
        return evalGrid(stack, boxW, boxH, grid, 0);
    }

    /* ===================================================================== TAY NẮM (preview) */

    const BEZIER_TANGENT_ANCHOR = {
        tl_tangent: 'tl_vertex', lt_tangent: 'tl_vertex',
        tr_tangent: 'rt_vertex', rt_tangent: 'rt_vertex',
        rb_tangent: 'br_vertex', br_tangent: 'br_vertex',
        bl_tangent: 'lb_vertex', lb_tangent: 'lb_vertex',
    };
    const MESH_PARTS = { l: 2, r: 4, u: 6, d: 8 };

    /* Tay nắm + đường của một Bezier/Mesh Warp, toạ độ CHUẨN HOÁ (0..1 theo hộp):
     *   handles: [{ id, kind: 'vertex'|'tangent', x, y, ax, ay (đỉnh mà tiếp tuyến bám), vertex }]
     *   segs:    [[x0,y0, x1,y1, x2,y2, x3,y3]] — đường cong bậc ba để vẽ khung/lưới.
     * Mesh: id 'v<chỉ số đỉnh>:p' (đỉnh) và 'v<chỉ số>:l|r|u|d' (tay cầm). */
    function handleModel(fx, p) {
        const handles = [];
        const segs = [];
        if (fx.type === 'bezier') {
            BEZIER_POINTS.forEach((b) => {
                const [x, y] = p[b.key];
                const anchor = BEZIER_TANGENT_ANCHOR[b.key];
                handles.push(anchor
                    ? { id: b.key, kind: 'tangent', x, y, ax: p[anchor][0], ay: p[anchor][1], vertex: anchor }
                    : { id: b.key, kind: 'vertex', x, y, vertex: b.key });
            });
            const seg = (a, b, c, d) => segs.push([...p[a], ...p[b], ...p[c], ...p[d]]);
            seg('tl_vertex', 'tl_tangent', 'tr_tangent', 'rt_vertex');
            seg('rt_vertex', 'rt_tangent', 'rb_tangent', 'br_vertex');
            seg('lb_vertex', 'bl_tangent', 'br_tangent', 'br_vertex');
            seg('tl_vertex', 'lt_tangent', 'lb_tangent', 'lb_vertex');
        } else if (fx.type === 'mesh') {
            const m = meshArray(p);
            const { rows, cols } = p;
            const at = (i, j) => (j * (cols + 1) + i) * MESH_STRIDE;
            for (let j = 0; j <= rows; j += 1) {
                for (let i = 0; i <= cols; i += 1) {
                    const q = at(i, j);
                    const v = `v${j * (cols + 1) + i}`;
                    handles.push({ id: `${v}:p`, kind: 'vertex', x: m[q], y: m[q + 1], vertex: v });
                    const parts = [];
                    if (i > 0) parts.push('l');
                    if (i < cols) parts.push('r');
                    if (j > 0) parts.push('u');
                    if (j < rows) parts.push('d');
                    parts.forEach((part) => {
                        const o = MESH_PARTS[part];
                        handles.push({ id: `${v}:${part}`, kind: 'tangent', x: m[q] + m[q + o], y: m[q + 1] + m[q + o + 1], ax: m[q], ay: m[q + 1], vertex: v });
                    });
                    if (i < cols) {
                        const b = at(i + 1, j);
                        segs.push([m[q], m[q + 1], m[q] + m[q + 4], m[q + 1] + m[q + 5], m[b] + m[b + 2], m[b + 1] + m[b + 3], m[b], m[b + 1]]);
                    }
                    if (j < rows) {
                        const c = at(i, j + 1);
                        segs.push([m[q], m[q + 1], m[q] + m[q + 8], m[q + 1] + m[q + 9], m[c] + m[c + 6], m[c + 1] + m[c + 7], m[c], m[c + 1]]);
                    }
                }
            }
        }
        return { handles, segs };
    }

    /* Kéo tay nắm `id` tới điểm chuẩn hoá (nx, ny). Trả patch { thông số: giá trị mới } — caller ghi
     * qua đường auto-keyframe (thông số đang có keyframe thì ghi keyframe tại playhead). */
    function dragHandle(fx, p, id, nx, ny) {
        if (fx.type === 'bezier') {
            if (!p[id]) return {};
            const patch = { [id]: [nx, ny] };
            const tangents = BEZIER_VERTEX_TANGENTS[id];
            if (tangents) {
                const dx = nx - p[id][0];
                const dy = ny - p[id][1];
                tangents.forEach((k) => { patch[k] = [p[k][0] + dx, p[k][1] + dy]; });
            }
            return patch;
        }
        if (fx.type === 'mesh') {
            const mm = /^v(\d+):([plrud])$/.exec(String(id));
            if (!mm) return {};
            const m = meshArray(p).slice();
            const q = Number(mm[1]) * MESH_STRIDE;
            if (q < 0 || q + MESH_STRIDE > m.length) return {};
            if (mm[2] === 'p') {
                m[q] = nx; m[q + 1] = ny;   // tay cầm TƯƠNG ĐỐI nên tự đi theo đỉnh
            } else {
                const o = MESH_PARTS[mm[2]];
                m[q + o] = nx - m[q];
                m[q + o + 1] = ny - m[q + 1];
            }
            return { mesh: m };
        }
        return {};
    }

    /* ===================================================================== INSPECTOR */

    function injectStyle() {
        if (typeof document === 'undefined' || document.getElementById('distortStyle')) return;
        const el = document.createElement('style');
        el.id = 'distortStyle';
        el.textContent = `
            .dst-add { display: flex; gap: 6px; align-items: center; margin: 4px 0 10px; }
            .dst-add select { flex: 1; min-width: 0; }
            .dst-fx { border: 1px solid var(--border-color, rgba(255,255,255,.12)); border-radius: 8px; padding: 6px 8px; margin: 8px 0; }
            .dst-fx.is-off { opacity: .55; }
            .dst-head { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
            .dst-head .dst-name { flex: 1; }
            .dst-head button { min-width: 24px; padding: 0 6px; }
            .dst-row { display: flex; align-items: center; gap: 6px; margin: 6px 0; font-size: 12px; }
            .dst-row > span:first-child { flex: 0 0 88px; opacity: .8; }
            .dst-row select { flex: 1; min-width: 0; }
            .dst-slider { flex: 1; display: flex; align-items: center; gap: 6px; min-width: 0; }
            .dst-slider input[type=range] { flex: 1; min-width: 0; }
            .dst-slider input[type=text] { width: 56px; }
            .dst-empty { font-size: 12px; opacity: .7; margin: 6px 0; }
        `;
        document.head.appendChild(el);
    }

    const scrubAttrs = (def) => `data-scrub-axis="x" data-scrub-step="${def.step}" data-scrub-min="${def.min}" data-scrub-max="${def.max}"${Number.isInteger(def.step) ? ' data-scrub-integer="1"' : ''}`;

    function fmt(def, v) {
        const n = Number(v) || 0;
        return Number.isInteger(def.step) ? String(Math.round(n)) : String(Math.round(n * 100) / 100);
    }

    /* Mục "Biến dạng" của Inspector. `t` = giây cục bộ tại playhead (ô hiện giá trị HIỆU DỤNG).
     * `kfGroup(field, label)` do editing-runtime cung cấp để nút ◂ ◆ ▸ giống mọi chỗ khác. */
    function inspectorHtml(item, t, helpers = {}) {
        injectStyle();
        const kfGroup = typeof helpers.kfGroup === 'function' ? helpers.kfGroup : () => '';
        const stack = normalizeStack(item && item.distort);
        const effects = stack.map((fx, index) => {
            const def = EFFECT_DEFS[fx.type];
            const eff = effectParamsAt(item, fx, t);
            const box = helpers.box || { w: 1, h: 1 };
            const rows = def.params.map((p) => {
                const field = kfField(fx.id, p.key);
                const name = `${fx.id}|${p.key}`;
                const kf = p.noKf ? '' : kfGroup(field, _t(p.label));
                if (p.kind === 'vec2') {
                    // Hiện px theo hộp (như AE), lưu chuẩn hoá.
                    const v = eff[p.key];
                    return `
                    <div class="dst-row">
                        <span>${esc(_t(p.label))}</span>
                        <span class="dst-slider">
                            <input type="text" inputmode="decimal" value="${Math.round(v[0] * box.w * 10) / 10}" data-distort-param="${name}" data-distort-axis="0" ${scrubAttrs({ step: 1, min: -100000, max: 100000 })} aria-label="X">
                            <input type="text" inputmode="decimal" value="${Math.round(v[1] * box.h * 10) / 10}" data-distort-param="${name}" data-distort-axis="1" ${scrubAttrs({ step: 1, min: -100000, max: 100000 })} aria-label="Y">
                        </span>
                        ${kf}
                    </div>`;
                }
                if (p.kind === 'mesh') {
                    return `
                    <div class="dst-row">
                        <span>${esc(_t(p.label))}</span>
                        <span class="dst-slider"><button type="button" class="btn btn-secondary" data-distort-action="reset-mesh" data-distort-id="${fx.id}">${esc(_t('Đặt lại lưới'))}</button></span>
                        ${kf}
                    </div>`;
                }
                if (p.kind === 'enum') {
                    return `
                    <div class="dst-row">
                        <span>${esc(_t(p.label))}</span>
                        <select data-distort-param="${name}">
                            ${p.options.map((o) => `<option value="${o.id}"${o.id === eff[p.key] ? ' selected' : ''}>${esc(_t(o.label))}</option>`).join('')}
                        </select>
                        ${kf}
                    </div>`;
                }
                const lo = Math.max(p.min, p.slider[0]);
                const hi = Math.min(p.max, p.slider[1]);
                return `
                    <div class="dst-row">
                        <span>${esc(_t(p.label))}${p.unit ? ` (${esc(p.unit)})` : ''}</span>
                        <span class="dst-slider">
                            <input type="range" min="${lo}" max="${hi}" step="${p.step}" value="${fmt(p, eff[p.key])}" data-distort-param="${name}">
                            <input type="text" inputmode="decimal" value="${fmt(p, eff[p.key])}" data-distort-param="${name}" ${scrubAttrs(p)}>
                        </span>
                        ${kf}
                    </div>`;
            }).join('');
            return `
                <div class="dst-fx${fx.enabled ? '' : ' is-off'}" data-distort-fx="${fx.id}">
                    <div class="dst-head">
                        <input type="checkbox" data-distort-enable="${fx.id}"${fx.enabled ? ' checked' : ''} title="${esc(_t('Bật/tắt hiệu ứng'))}">
                        <span class="dst-name">${esc(_t(def.label))}</span>
                        ${def.handles ? `<button type="button" class="btn btn-secondary${helpers.editingId === fx.id ? ' is-active' : ''}" data-distort-action="edit" data-distort-id="${fx.id}" title="${esc(_t('Sửa trên preview (Esc để thoát)'))}">✎</button>` : ''}
                        <button type="button" class="btn btn-secondary" data-distort-action="up" data-distort-id="${fx.id}" ${index === 0 ? 'disabled' : ''} title="${esc(_t('Lên trên'))}">↑</button>
                        <button type="button" class="btn btn-secondary" data-distort-action="down" data-distort-id="${fx.id}" ${index === stack.length - 1 ? 'disabled' : ''} title="${esc(_t('Xuống dưới'))}">↓</button>
                        <button type="button" class="btn btn-secondary" data-distort-action="remove" data-distort-id="${fx.id}" title="${esc(_t('Xoá hiệu ứng'))}">×</button>
                    </div>
                    ${rows}
                </div>`;
        }).join('');
        return `
            <div class="ins-sec" data-ins-tab="distort" data-ins-sub="basic" data-distort-section="1">
                <div class="ins-sec-head"><span class="ins-sec-title">${esc(_t('Biến dạng (Distort)'))}</span></div>
                <div class="dst-add">
                    <select data-distort-add-type>
                        ${TYPE_IDS.map((id) => `<option value="${id}">${esc(_t(EFFECT_DEFS[id].label))}</option>`).join('')}
                    </select>
                    <button type="button" class="btn btn-secondary" data-distort-action="add" ${stack.length >= MAX_EFFECTS ? 'disabled' : ''}>${esc(_t('Thêm'))}</button>
                </div>
                ${effects || `<div class="dst-empty">${esc(_t('Chưa có hiệu ứng. Chọn một hiệu ứng rồi bấm Thêm.'))}</div>`}
            </div>`;
    }

    // Ô inspector -> { effectId, key, value } đã kẹp đúng khoảng; null nếu không phải ô Distort.
    function readField(target) {
        const name = target && target.dataset && target.dataset.distortParam;
        if (!name) return null;
        const [effectId, key] = String(name).split('|');
        const axis = target.dataset.distortAxis;
        return { effectId, key, raw: target.value, axis: axis === undefined ? null : Number(axis) };
    }

    /* Giá trị MỚI của một thông số từ ô Inspector. vec2: ô X/Y nhận px -> đổi về chuẩn hoá theo hộp,
     * giữ nguyên trục còn lại (giá trị hiệu dụng tại t). */
    function fieldValue(item, fx, field, box, t) {
        const def = paramDef(fx.type, field.key);
        if (!def) return null;
        if (def.kind === 'vec2') {
            const n = Number(String(field.raw).replace(',', '.'));
            if (!Number.isFinite(n)) return null;
            const cur = effectParamsAt(item, fx, t)[field.key].slice();
            cur[field.axis === 1 ? 1 : 0] = n / Math.max(1e-6, field.axis === 1 ? box.h : box.w);
            return normalizeParam(def, cur);
        }
        if (def.kind === 'mesh') return null;
        return normalizeParam(def, field.raw);
    }

    function coerceValue(type, key, raw) {
        const def = paramDef(type, key);
        return def ? normalizeParam(def, raw) : null;
    }

    // Đồng bộ thanh trượt <-> ô số cùng thông số (không dựng lại inspector).
    function syncTwin(target) {
        const name = target && target.dataset && target.dataset.distortParam;
        const box = target && target.closest && target.closest('[data-distort-fx]');
        if (!name || !box) return;
        box.querySelectorAll(`[data-distort-param="${name}"]`).forEach((el) => {
            // Ô X và Y của một điểm cùng tên thông số — chỉ đồng bộ ô CÙNG trục.
            if (el !== target && el.dataset.distortAxis === target.dataset.distortAxis) el.value = target.value;
        });
    }

    /* Ô đang hiện giá trị HIỆU DỤNG tại playhead (bám playhead như bảng transform). Bỏ qua ô
     * đang được gõ/kéo (document.activeElement). */
    function syncPanelValues(root, item, t, box = { w: 1, h: 1 }) {
        if (!root || !item) return;
        const stack = normalizeStack(item.distort);
        root.querySelectorAll('[data-distort-param]').forEach((el) => {
            if (typeof document !== 'undefined' && el === document.activeElement) return;
            const [effectId, key] = String(el.dataset.distortParam).split('|');
            const fx = stack.find((f) => f.id === effectId);
            const def = fx && paramDef(fx.type, key);
            if (!def) return;
            const v = effectParamsAt(item, fx, t)[key];
            if (def.kind === 'mesh') return;
            let next;
            if (def.kind === 'vec2') {
                const ax = Number(el.dataset.distortAxis) === 1 ? 1 : 0;
                next = String(Math.round(v[ax] * (ax ? box.h : box.w) * 10) / 10);
            } else next = def.kind === 'enum' ? String(v) : fmt(def, v);
            if (el.value !== next) el.value = next;
        });
    }

    return {
        KF_PREFIX,
        MAX_EFFECTS,
        MAX_CELLS,
        MIN_CELLS,
        EFFECT_DEFS,
        TYPE_IDS,
        WAVE_SHAPES,
        WAVE_PINNING,
        paramDef,
        normalizeParam,
        normalizeEffect,
        normalizeStack,
        supportsItem,
        isActive,
        createEffect,
        kfField,
        isKfField,
        parseKfField,
        evalParamKeyframes,
        effectParamsAt,
        stackAt,
        hasDistortKeyframes,
        isTimeVarying,
        hash32,
        waveShape,
        pinWeight,
        waveFrame,
        gridSpec,
        evalGrid,
        maxExtents,
        rasterMesh,
        gridToPixels,
        outputSize,
        warpToCanvas,
        MeshRenderer,
        exportSpec,
        evalSpecStack,
        meshMixAt,
        inspectorHtml,
        readField,
        fieldValue,
        handleModel,
        dragHandle,
        meshIdentity,
        meshArray,
        meshLength,
        coons,
        bezierPatch,
        BEZIER_POINTS,
        MESH_STRIDE,
        coerceValue,
        syncTwin,
        syncPanelValues,
    };
}));
