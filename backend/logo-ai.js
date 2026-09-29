// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* XOÁ LOGO BẰNG AI — hàng đợi job, cache miếng vá và phần xuất của chế độ 'ai'.
 *
 * Chế độ 'ai' (tab Retouch > Xoá logo) không phải công thức pixel như delogo/làm mờ/khảm: nó
 * là MỘT LƯỢT XỬ LÝ TRƯỚC do asr/logo_inpaint_sidecar.py chạy (mô hình MI-GAN), ra các miếng
 * vá PNG theo đúng PTS từng khung của đoạn nguồn. Module này:
 *   - nhận yêu cầu từ frontend, kiểm nguồn/vùng, băm thành KHOÁ (nguồn + mtime/size + vùng +
 *     khổ khung + phiên bản mô hình),
 *   - xếp hàng MỘT job tại một thời điểm (mô hình ăn hết CPU; hai job song song chỉ chậm cả hai),
 *   - lưu kết quả ở `<cacheDir>/<khoá>/<run>/` và trả lại lượt đã có nếu nó PHỦ được khoảng xin,
 *   - dựng field cho sidecar xuất (`logo_ai_dir/rects/t0`) — từ index trên đĩa, không tin số
 *     nào của client.
 *
 * MỘT KHOÁ, NHIỀU LƯỢT: các block cắt từ cùng một file và cùng vùng logo có chung khoá nhưng
 * nằm ở những khoảng nguồn khác nhau. Gộp tất cả thành một khoảng bao là xử lý cả phần giữa
 * không ai dùng (hai block cách nhau 8 phút = 8 phút video chạy AI vô ích). Nên mỗi khoảng là
 * một lượt riêng; chỉ gộp khi hai khoảng chồng/sát nhau (< RANGE_MERGE_GAP).
 *
 * Tách khỏi server.js để test gọi thẳng được với bộ chạy giả (không cần Python/model).
 */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const LOGO_AI_VERSION = 1;
// MI-GAN (Picsart AI Research, MIT). Ghim theo COMMIT của repo và mã băm: tải lại đúng từng
// byte đã đo, không phải "bản mới nhất" mà ai đó đẩy lên sau.
const MODEL = {
  name: 'migan-pipeline-v2',
  file: 'migan_pipeline_v2.onnx',
  url: 'https://huggingface.co/andraniksargsyan/migan/resolve/406830d0fa60666da0071c342ad2fbc8f30c5c64/migan_pipeline_v2.onnx',
  sha256: '6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b',
  bytes: 28079181,
};
const MAX_RECTS = 4;
const RANGE_MERGE_GAP = 2.0;
const KEEP_JOB_MS = 10 * 60 * 1000;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const KEY_RE = /^[0-9a-f]{24}$/;
const RUN_RE = /^run_[0-9a-z]{6,24}$/;
const FILE_RE = /^r[0-3]_\d{6}\.png$/;

function finite(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toInt(v, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
}

/* `resolveSource(raw)` -> đường dẫn tuyệt đối đã kiểm an toàn hoặc null (server truyền vào
 * resolveRetouchSource: cùng danh sách trắng thư mục như Retouch). */
function createLogoAi(options) {
  const {
    cacheDir,
    modelDir,
    scriptPath,
    runSidecar,          // (script, inputPath, outputPath, { feature, onProgress, onChild, downloadLabel }) -> payload
    resolveSource,
    tempJsonPath,
    setStatus = () => {},
    logStatus = () => {},
    t = (s, p) => String(s).replace(/\{(\w+)\}/g, (_, k) => (p && k in p ? p[k] : `{${k}}`)),
  } = options;

  const jobs = new Map();        // id -> job
  const queue = [];
  let running = null;
  const indexCache = new Map();  // dir -> { mtimeMs, index }

  // ------------------------------------------------------------------ yêu cầu
  function normalizeRequest(body) {
    const b = body && typeof body === 'object' ? body : {};
    const still = b.still === true;
    const sourcePath = resolveSource(b.source_path);
    if (!sourcePath) {
      const err = new Error(t('Nguồn cho Xoá logo AI không hợp lệ hoặc nằm ngoài thư mục dự án.'));
      err.status = 400;
      throw err;
    }
    const frameW = toInt(b.frame_w, 16, 16384);
    const frameH = toInt(b.frame_h, 16, 16384);
    if (frameW === null || frameH === null) {
      const err = new Error(t('Thiếu kích thước khung cho Xoá logo AI.'));
      err.status = 400;
      throw err;
    }
    const rects = (Array.isArray(b.rects) ? b.rects : []).slice(0, MAX_RECTS).map((r) => {
      const x = toInt(r?.x, 0, frameW - 2);
      const y = toInt(r?.y, 0, frameH - 2);
      if (x === null || y === null) return null;
      const w = toInt(r?.w, 0, frameW - x);
      const h = toInt(r?.h, 0, frameH - y);
      if (w === null || h === null || w < 6 || h < 6) return null;
      return { x, y, w, h };
    }).filter(Boolean);
    if (!rects.length) {
      const err = new Error(t('Chưa có vùng logo hợp lệ để xử lý AI.'));
      err.status = 400;
      throw err;
    }
    let start = 0;
    let end = 0;
    if (!still) {
      start = Math.max(0, finite(b.start));
      end = finite(b.end);
      if (!(end > start + 0.01)) {
        const err = new Error(t('Khoảng thời gian cho Xoá logo AI không hợp lệ.'));
        err.status = 400;
        throw err;
      }
    }
    return { sourcePath, still, frameW, frameH, rects, start, end };
  }

  function keyFor(req) {
    let stamp = 'nostat';
    try {
      const st = fs.statSync(req.sourcePath);
      stamp = `${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch (_) { /* nguồn biến mất -> khoá riêng, lượt chạy sẽ tự báo lỗi */ }
    const text = JSON.stringify({
      v: LOGO_AI_VERSION,
      model: MODEL.name,
      src: path.resolve(req.sourcePath),
      stamp,
      still: req.still,
      frame: [req.frameW, req.frameH],
      rects: req.rects.map((r) => [r.x, r.y, r.w, r.h]),
    });
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 24);
  }

  // ------------------------------------------------------------------ cache trên đĩa
  function readIndex(dir) {
    const file = path.join(dir, 'index.json');
    let st;
    try { st = fs.statSync(file); } catch (_) { indexCache.delete(dir); return null; }
    const hit = indexCache.get(dir);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.index;
    try {
      const index = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!index || !Array.isArray(index.times) || !Array.isArray(index.rects)) return null;
      indexCache.set(dir, { mtimeMs: st.mtimeMs, index });
      return index;
    } catch (_) {
      return null;
    }
  }

  function listRuns(key) {
    const keyDir = path.join(cacheDir, key);
    let names = [];
    try { names = fs.readdirSync(keyDir); } catch (_) { return []; }
    return names.filter((n) => RUN_RE.test(n)).map((run) => {
      const index = readIndex(path.join(keyDir, run));
      return index ? { run, index } : null;
    }).filter(Boolean);
  }

  const covers = (a, req) => req.still || (a.start <= req.start + 1e-3 && a.end >= req.end - 1e-3);

  function findRun(key, req) {
    const runs = listRuns(key).filter((r) => covers(r.index, req));
    // Nhiều lượt cùng phủ (lượt cũ chưa kịp dọn) -> lấy lượt MỚI nhất (tên run tăng dần).
    runs.sort((a, b) => (a.run < b.run ? 1 : -1));
    return runs[0] || null;
  }

  // ------------------------------------------------------------------ job
  function view(job) {
    return {
      state: job.state,
      job_id: job.id,
      key: job.key,
      progress: Math.round((job.progress || 0) * 1000) / 1000,
      message: job.message || '',
      error: job.error || '',
      ...(job.state === 'done' ? { run: job.run, index: job.index } : {}),
    };
  }

  function activeJobFor(key) {
    let found = null;
    for (const job of jobs.values()) {
      if (job.key === key && (job.state === 'queued' || job.state === 'running')) found = job;
    }
    return found;
  }

  function newJobId() {
    return `la_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
  }

  function pruneJobs() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.finishedAt && now - job.finishedAt > KEEP_JOB_MS) jobs.delete(id);
    }
  }

  /* Trạng thái (run = false) hoặc xin chạy (run = true) cho MỘT block. */
  function request(body, { run = false } = {}) {
    pruneJobs();
    const req = normalizeRequest(body);
    const key = keyFor(req);
    const hit = findRun(key, req);
    if (hit) return { state: 'done', key, run: hit.run, index: hit.index };
    const active = activeJobFor(key);
    if (active && covers(active.req, req)) return view(active);
    if (!run) return { state: 'none', key };
    if (active && active.state === 'queued') {
      // Chưa chạy -> nới khoảng của nó ra luôn, khỏi xếp thêm một lượt.
      active.req.start = Math.min(active.req.start, req.start);
      active.req.end = Math.max(active.req.end, req.end);
      return view(active);
    }
    // Gộp với lượt đã có khi CHỒNG/SÁT nhau: kéo dài block một chút không phải chạy lại
    // riêng một mẩu, còn lượt cũ bị lượt mới phủ trọn sẽ được dọn khi xong.
    const merged = { ...req };
    if (!req.still) {
      for (const r of listRuns(key)) {
        if (r.index.start <= merged.end + RANGE_MERGE_GAP && r.index.end >= merged.start - RANGE_MERGE_GAP) {
          merged.start = Math.min(merged.start, r.index.start);
          merged.end = Math.max(merged.end, r.index.end);
        }
      }
    }
    const job = {
      id: newJobId(),
      key,
      req: merged,
      state: 'queued',
      progress: 0,
      message: '',
      error: '',
      createdAt: Date.now(),
    };
    jobs.set(job.id, job);
    queue.push(job);
    setImmediate(pump);
    return view(job);
  }

  function jobStatus(id) {
    const job = jobs.get(String(id || ''));
    return job ? view(job) : null;
  }

  function cancel(id) {
    const job = jobs.get(String(id || ''));
    if (!job) return null;
    if (job.state === 'queued') {
      const i = queue.indexOf(job);
      if (i >= 0) queue.splice(i, 1);
      job.state = 'canceled';
      job.finishedAt = Date.now();
    } else if (job.state === 'running') {
      job.canceled = true;
      try { job.child?.kill(); } catch (_) { /* đã thoát */ }
    }
    return view(job);
  }

  async function pump() {
    if (running || !queue.length) return;
    const job = queue.shift();
    running = job;
    job.state = 'running';
    job.message = t('Đang chuẩn bị xoá logo bằng AI...');
    const runId = `run_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    const outDir = path.join(cacheDir, job.key, runId);
    const inputPath = tempJsonPath('logo_ai_input');
    const outputPath = tempJsonPath('logo_ai_output');
    try {
      await fsp.mkdir(outDir, { recursive: true });
      await fsp.writeFile(inputPath, JSON.stringify({
        source_path: job.req.sourcePath,
        still: job.req.still,
        start: job.req.start,
        end: job.req.end,
        frame_w: job.req.frameW,
        frame_h: job.req.frameH,
        rects: job.req.rects,
        out_dir: outDir,
        model_path: path.join(modelDir, MODEL.file),
        model_url: MODEL.url,
        model_sha256: MODEL.sha256,
      }), 'utf8');
      setStatus(t('Đang xoá logo bằng AI...'));
      const payload = await runSidecar(scriptPath, inputPath, outputPath, {
        feature: 'logo_ai',
        downloadLabel: 'MI-GAN',
        onProgress: (ratio) => {
          job.progress = ratio;
          // Thanh trạng thái (/api/status) đọc câu này mỗi giây — kể cả lúc chờ AI trước khi xuất.
          const pct = Math.floor(ratio * 100);
          if (pct !== job.lastPct) {
            job.lastPct = pct;
            setStatus(t('Đang xoá logo bằng AI… {pct}%', { pct }));
          }
        },
        onChild: (child) => { job.child = child; },
      });
      if (job.canceled) throw Object.assign(new Error('canceled'), { canceled: true });
      const index = readIndex(outDir) || payload?.index;
      if (!index) throw new Error(t('Sidecar không trả kết quả.'));
      job.index = index;
      job.run = runId;
      job.progress = 1;
      job.state = 'done';
      job.message = t('Đã xoá logo bằng AI.');
      setStatus(t('Đã xoá logo bằng AI ({n} khung).', { n: index.times.length }));
      // Lượt cũ bị lượt này phủ trọn -> dọn (preview đang giữ đường dẫn cũ sẽ hỏi lại trạng thái).
      for (const r of listRuns(job.key)) {
        if (r.run === runId) continue;
        if (job.req.still || (r.index.start >= index.start - 1e-3 && r.index.end <= index.end + 1e-3)) {
          await fsp.rm(path.join(cacheDir, job.key, r.run), { recursive: true, force: true }).catch(() => {});
          indexCache.delete(path.join(cacheDir, job.key, r.run));
        }
      }
    } catch (error) {
      await fsp.rm(outDir, { recursive: true, force: true }).catch(() => {});
      if (job.canceled || error?.canceled) {
        job.state = 'canceled';
        job.message = t('Đã huỷ xoá logo bằng AI.');
        setStatus(job.message);
      } else {
        job.state = 'error';
        job.error = String(error?.sidecarPayload?.detail || error?.message || error);
        job.message = job.error;
        setStatus(t('Lỗi khi xoá logo bằng AI!'));
        logStatus(`[logo-ai] ${job.error}`);
      }
    } finally {
      job.child = null;
      job.finishedAt = Date.now();
      running = null;
      await fsp.rm(inputPath, { force: true }).catch(() => {});
      await fsp.rm(outputPath, { force: true }).catch(() => {});
      setImmediate(pump);
    }
  }

  // ------------------------------------------------------------------ phục vụ file
  function patchPath(key, run, file) {
    if (!KEY_RE.test(String(key)) || !RUN_RE.test(String(run)) || !FILE_RE.test(String(file))) return null;
    const p = path.join(cacheDir, key, run, file);
    return fs.existsSync(p) ? p : null;
  }

  /* Field cho sidecar xuất từ `{ mode:'ai', key, run }` của frontend. null = không dùng được
   * (lượt đã bị dọn, ảnh tĩnh — ảnh đi đường bake ở frontend) -> caller rơi về delogo. */
  function exportFields(raw) {
    if (!raw || raw.mode !== 'ai') return null;
    const key = String(raw.key || '');
    const run = String(raw.run || '');
    if (!KEY_RE.test(key) || !RUN_RE.test(run)) return null;
    const dir = path.join(cacheDir, key, run);
    const index = readIndex(dir);
    if (!index || index.still || !index.times.length) return null;
    const W = toInt(index.width, 1, 16384);
    const H = toInt(index.height, 1, 16384);
    const rects = [];
    for (let k = 0; k < Math.min(MAX_RECTS, index.rects.length); k++) {
      const box = index.rects[k]?.box;
      if (!fs.existsSync(path.join(dir, `r${k}.ffconcat`))) return null;
      const x = toInt(box?.x, 0, W);
      const y = toInt(box?.y, 0, H);
      if (x === null || y === null) return null;
      rects.push(`${x}:${y}`);
    }
    if (!rects.length) return null;
    const t0 = finite(index.times[0], NaN);
    if (!Number.isFinite(t0)) return null;
    return { logo_ai_dir: dir, logo_ai_rects: rects.join('|'), logo_ai_t0: Math.max(0, t0) };
  }

  // Dọn khoá lâu không dùng (mỗi khoá có thể vài chục MB miếng vá). Chạy nền, lỗi thì thôi.
  async function pruneCache(now = Date.now()) {
    let names = [];
    try { names = await fsp.readdir(cacheDir); } catch (_) { return; }
    for (const name of names) {
      if (!KEY_RE.test(name)) continue;
      const dir = path.join(cacheDir, name);
      try {
        const st = await fsp.stat(dir);
        if (now - st.mtimeMs > CACHE_TTL_MS && !activeJobFor(name)) {
          await fsp.rm(dir, { recursive: true, force: true });
        }
      } catch (_) { /* bỏ qua */ }
    }
  }

  function cancelAll() {
    for (const job of jobs.values()) {
      if (job.state === 'queued' || job.state === 'running') cancel(job.id);
    }
  }

  return { request, jobStatus, cancel, cancelAll, patchPath, exportFields, pruneCache, keyFor, normalizeRequest };
}

module.exports = { createLogoAi, MODEL, LOGO_AI_VERSION };
