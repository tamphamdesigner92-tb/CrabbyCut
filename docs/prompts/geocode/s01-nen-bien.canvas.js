// S-01 · Nền bãi biển lúc hoàng hôn — GeoCode JavaScript canvas
// Khung 1080×1920, video 20 s, 30 fps. Lớp DƯỚI CÙNG: vẽ kín khung là chủ ý (đây là cảnh nền).
// Quy tắc vàng: mọi chuyển động tính từ t; ngẫu nhiên có seed; sóng lặp theo chu kỳ chia hết 20 s.
// S-07 "Sửa bằng lời" vá đúng các hằng số dưới đây bằng crabbycut_update_geocode replace.

const DUR = 20;                 // thời lượng video (s)
const TIME_OF_DAY = 'sunset';   // 'sunset' | 'night'  ← S-07 lần 1: "đổi sang ban đêm"
const WAVE_PERIOD = 4;          // giây cho một nhịp sóng (20 / 4 = 5 nhịp, lặp mượt)

const PALETTES = {
  sunset: { skyTop: '#2b1d4f', skyMid: '#c2456b', skyLow: '#ffb020', sun: '#ffd27a',
            sea: '#3b4f8f', seaLight: '#ff9f6b', foam: '#fff4e0', sand: '#e9b98a', sandDark: '#c98f62' },
  night:  { skyTop: '#05081a', skyMid: '#14214a', skyLow: '#2c3f7a', sun: '#f1f4ff',
            sea: '#0d1a3d', seaLight: '#8fa7ff', foam: '#cfd9ff', sand: '#5b5470', sandDark: '#433d57' },
};

function rng(seed) {             // mulberry32 — cùng seed thì cùng chuỗi số
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(2026);
const STARS = Array.from({ length: 140 }, () => ({ x: R(), y: R() * 0.55, r: 1 + R() * 2.2, ph: R() }));
const SHELLS = Array.from({ length: 14 }, () => ({ x: R(), y: 0.78 + R() * 0.2, s: 8 + R() * 10 }));

function draw(ctx, t, W, H) {
  const P = PALETTES[TIME_OF_DAY] || PALETTES.sunset;
  const horizon = H * 0.56;
  const night = TIME_OF_DAY === 'night';

  // Trời
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, P.skyTop); sky.addColorStop(0.6, P.skyMid); sky.addColorStop(1, P.skyLow);
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, horizon);

  if (night) {                   // sao nhấp nháy, chu kỳ 2 s (chia hết 20)
    for (const s of STARS) {
      const a = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (t / 2 + s.ph)));
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Mặt trời (hoặc trăng) lặn dần trong 20 s: từ 0.30H xuống chạm đường chân trời
  const k = Math.min(1, t / DUR);
  const sunY = H * 0.30 + (horizon - H * 0.30 + 40) * k;
  const sunR = W * 0.16;
  const glow = ctx.createRadialGradient(W / 2, sunY, sunR * 0.4, W / 2, sunY, sunR * 3);
  glow.addColorStop(0, night ? 'rgba(220,230,255,0.35)' : 'rgba(255,200,120,0.55)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, horizon);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, W, horizon); ctx.clip();
  ctx.fillStyle = P.sun;
  ctx.beginPath(); ctx.arc(W / 2, sunY, sunR, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Biển: 4 dải sóng, mỗi dải lệch pha
  const seaBottom = H * 0.74;
  ctx.fillStyle = P.sea; ctx.fillRect(0, horizon, W, seaBottom - horizon);
  for (let i = 0; i < 4; i++) {
    const y0 = horizon + (seaBottom - horizon) * (0.15 + i * 0.22);
    ctx.strokeStyle = P.seaLight; ctx.globalAlpha = 0.35 - i * 0.05; ctx.lineWidth = 4;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 12) {
      const y = y0 + 8 * Math.sin(2 * Math.PI * (x / 360 + t / WAVE_PERIOD + i * 0.25));
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // vệt phản chiếu mặt trời trên nước
  for (let i = 0; i < 9; i++) {
    const y = horizon + 18 + i * 34;
    const w = (W * 0.32) * (1 - i / 11) * (0.8 + 0.2 * Math.sin(2 * Math.PI * (t / 2 + i * 0.13)));
    ctx.fillStyle = night ? 'rgba(220,230,255,0.35)' : 'rgba(255,220,150,0.45)';
    ctx.fillRect(W / 2 - w / 2, y, w, 6);
  }

  // Sóng vỗ bờ: mép bọt tiến lên rồi rút, chu kỳ WAVE_PERIOD
  const phase = (t % WAVE_PERIOD) / WAVE_PERIOD;
  const reach = Math.sin(Math.PI * phase);           // 0 → 1 → 0
  const shore = seaBottom + 60 * reach;
  ctx.fillStyle = P.sand; ctx.fillRect(0, seaBottom, W, H - seaBottom);
  ctx.fillStyle = P.sea;
  ctx.beginPath(); ctx.moveTo(0, seaBottom);
  for (let x = 0; x <= W; x += 10) ctx.lineTo(x, shore + 14 * Math.sin(x / 70 + 2 * Math.PI * phase));
  ctx.lineTo(W, seaBottom); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = P.foam; ctx.lineWidth = 10; ctx.lineCap = 'round';
  ctx.globalAlpha = 0.5 + 0.5 * reach;
  ctx.beginPath();
  for (let x = 0; x <= W; x += 10) {
    const y = shore + 14 * Math.sin(x / 70 + 2 * Math.PI * phase);
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.globalAlpha = 1;

  // Cát: vỏ sò tĩnh (seed cố định)
  ctx.fillStyle = P.sandDark;
  for (const s of SHELLS) {
    ctx.beginPath(); ctx.ellipse(s.x * W, s.y * H, s.s, s.s * 0.6, 0, 0, Math.PI * 2); ctx.fill();
  }
}
