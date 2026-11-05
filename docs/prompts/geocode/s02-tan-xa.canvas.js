// S-02 · Vì sao bầu trời màu xanh? — GeoCode JavaScript canvas
// Khung 1080×1920, video 36 s, 30 fps; đặt ở giây 2 → 38 của timeline (sau thẻ câu lệnh).
// Chữ giải thích KHÔNG vẽ ở đây: thêm bằng crabbycut_add_text theo mốc lời đọc (crabbycut_dub trả clips[i]).
// Quy tắc vàng: mọi thứ tính từ t; hạt khí có seed cố định; nền tối là chủ ý (đây là lớp nền của short).
//
// Cảnh (giây cục bộ của block):
//   A 0–8    Mặt Trời phát ánh sáng trắng; tia sáng tách thành 7 dải màu
//   B 8–20   Tia đi vào khí quyển: sóng xanh (ngắn) dội ra mọi hướng, sóng đỏ (dài) đi thẳng
//   C 20–28  Người đứng dưới đất: ánh xanh tới mắt từ khắp bầu trời → trời xanh
//   D 28–36  Hoàng hôn: đường đi dài hơn, xanh bị tán hết, còn cam đỏ tới mắt

const SCENES = [0, 8, 20, 28, 36];
const SPECTRUM = ['#ff3b3b', '#ff8a2b', '#ffd23b', '#5ad19a', '#4fb3ff', '#4a6cff', '#9b5cff'];

function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(42);
const MOLS = Array.from({ length: 70 }, () => ({ x: 0.08 + R() * 0.84, y: 0.30 + R() * 0.32, ph: R() }));
const RAYS = Array.from({ length: 70 }, () => ({ a: R() * Math.PI * 2, d: 0.6 + R() * 0.8 }));

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const ease = (v) => { v = clamp(v); return v * v * (3 - 2 * v); };
const mix = (a, b, k) => {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const c = (s) => Math.round(((pa >> s) & 255) * (1 - k) + ((pb >> s) & 255) * k);
  return `rgb(${c(16)},${c(8)},${c(0)})`;
};

function sun(ctx, x, y, r, t, color) {
  const g = ctx.createRadialGradient(x, y, r * 0.3, x, y, r * 2.6);
  g.addColorStop(0, color); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r * (1 + 0.03 * Math.sin(2 * Math.PI * t)), 0, Math.PI * 2); ctx.fill();
}

function wave(ctx, x0, y0, x1, y1, wl, amp, t, color, width) {
  const len = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / len, uy = (y1 - y0) / len;
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
  for (let s = 0; s <= len; s += 4) {
    const o = amp * Math.sin(2 * Math.PI * (s / wl - t * 1.5));
    const x = x0 + ux * s - uy * o, y = y0 + uy * s + ux * o;
    s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function person(ctx, x, y, s) {
  ctx.fillStyle = '#23262f';
  ctx.beginPath(); ctx.arc(x, y - 150 * s, 34 * s, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.roundRect(x - 40 * s, y - 112 * s, 80 * s, 112 * s, 24 * s); ctx.fill();
}

function draw(ctx, t, W, H) {
  const ground = H * 0.80;
  const inC = ease((t - SCENES[2]) / 3), inD = ease((t - SCENES[3]) / 4);
  // Trời: tối → xanh (cảnh C) → cam (cảnh D)
  const top = inD > 0 ? mix('#2f6fe0', '#3b2457', inD) : mix('#0b0f1f', '#2f6fe0', inC);
  const low = inD > 0 ? mix('#8fd0ff', '#ff8a3d', inD) : mix('#141a33', '#8fd0ff', inC);
  const sky = ctx.createLinearGradient(0, 0, 0, ground);
  sky.addColorStop(0, top); sky.addColorStop(1, low);
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, ground);
  ctx.fillStyle = '#1d2a1f'; ctx.fillRect(0, ground, W, H - ground);

  // Vị trí Mặt Trời: trên cao (A–C) rồi hạ sát chân trời (D)
  const sx = W * (0.22 + 0.55 * inD), sy = H * (0.14 + 0.58 * inD);
  sun(ctx, sx, sy, 70, t, inD > 0.5 ? '#ffb347' : '#fff6d8');

  if (t < SCENES[1] + 1.5) {
    // A: tia trắng → tách 7 dải; mờ dần trong 1,5 s đầu cảnh B
    ctx.globalAlpha = 1 - ease((t - SCENES[1]) / 1.5);
    const grow = ease(t / 3), split = ease((t - 4) / 3);
    const ex = sx + (W * 0.9 - sx) * grow, ey = sy + (H * 0.42 - sy) * grow;
    if (split <= 0) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 18; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    } else {
      SPECTRUM.forEach((c, i) => {
        const off = (i - 3) * 16 * split;
        ctx.strokeStyle = c; ctx.lineWidth = 12;
        ctx.beginPath(); ctx.moveTo(sx, sy + off * 0.2); ctx.lineTo(ex, ey + off); ctx.stroke();
      });
    }
    ctx.globalAlpha = 1;
  }

  if (t >= SCENES[1] && t < SCENES[3]) {
    // B: phân tử khí + sóng xanh tán xạ, sóng đỏ đi thẳng
    const b = ease((t - SCENES[1]) / 2) * (1 - inC * 0.6);
    ctx.globalAlpha = b;
    for (const m of MOLS) {
      const r = 7 + 2 * Math.sin(2 * Math.PI * (t + m.ph));
      ctx.fillStyle = '#d7dde5'; ctx.beginPath(); ctx.arc(m.x * W, m.y * H, r, 0, Math.PI * 2); ctx.fill();
    }
    wave(ctx, 0, H * 0.36, W, H * 0.40, 220, 26, t, '#ff3b3b', 9);          // đỏ: bước sóng dài, đi thẳng
    wave(ctx, 0, H * 0.48, W * 0.5, H * 0.49, 70, 18, t, '#4fb3ff', 9);     // xanh: bước sóng ngắn
    const hit = { x: W * 0.5, y: H * 0.49 };
    RAYS.forEach((r, i) => {                                              // xanh dội ra mọi hướng
      const pulse = ((t * 0.8 + i / RAYS.length) % 1);
      const d = 40 + pulse * 380 * r.d;
      ctx.strokeStyle = `rgba(79,179,255,${(0.9 * (1 - pulse)).toFixed(3)})`; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(hit.x + Math.cos(r.a) * (d - 30), hit.y + Math.sin(r.a) * (d - 30));
      ctx.lineTo(hit.x + Math.cos(r.a) * d, hit.y + Math.sin(r.a) * d); ctx.stroke();
    });
    ctx.globalAlpha = 1;
  }

  if (t >= SCENES[2]) {
    // C, D: người nhìn lên; mũi tên ánh sáng tới mắt
    person(ctx, W * 0.5, ground, 1.2);
    const eye = { x: W * 0.5, y: ground - 190 };
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = Math.PI * (1.15 + 0.7 * i / (n - 1));
      const k = ((t * 0.7 + i / n) % 1);
      const d = 520 * (1 - k);
      const col = inD > 0.5 ? '#ff8a3d' : '#4fb3ff';
      ctx.fillStyle = col; ctx.globalAlpha = 0.25 + 0.75 * Math.sin(Math.PI * k);
      ctx.beginPath(); ctx.arc(eye.x + Math.cos(a) * d, eye.y + Math.sin(a) * d, 12, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
