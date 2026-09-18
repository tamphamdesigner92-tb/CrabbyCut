// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* Job model cho "Auto Subtitle" (tab Âm thanh) — trộn audio timeline rồi bóc băng.
 *
 * VÌ SAO LẠI LÀ JOB CHỨ KHÔNG PHẢI MỘT REQUEST ĐỒNG BỘ như /api/transcribe:
 * người dùng đòi THANH TIẾN TRÌNH. Kênh cũ (`progress.txt` + poll `/api/status`)
 * chỉ có MỘT chuỗi toàn cục, không phần trăm, không job id — vẽ được dòng chữ
 * nhưng không vẽ được thanh. Ở đây mỗi job có `progress` 0-100 thật:
 *   ·  0 →  4 %  chuẩn bị + dựng kế hoạch trộn
 *   ·  4 → 22 %  ffmpeg trộn audio      (đọc `time=` của ffmpeg / tổng thời lượng)
 *   · 22 → 96 %  ASR                    (đọc thanh tqdm của mlx_whisper trên stderr)
 *   · 96 → 100 % chuẩn hoá kết quả
 * Hai khoảng giữa là SỐ THẬT do chính tiến trình con báo về, không phải đồng hồ
 * đếm giả — cache trúng thì nhảy thẳng 22 → 96 trong một nhịp, đúng như nó vốn thế.
 *
 * MỘT JOB TẠI MỘT THỜI ĐIỂM: Whisper large-v3-turbo là model nặng, chạy hai lượt
 * song song trên máy 16 GB là tự bắn vào chân mình (cùng lý do với shortvideo-jobs).
 *
 * BẢN WINDOWS. Ba chỗ phải khác nhánh macOS, đều là chuyện của nền tảng chứ không
 * phải sở thích:
 *   1. HUỶ PHẢI GIẾT CẢ CÂY TIẾN TRÌNH (killProcessTree). Trên Windows, giết tiến
 *      trình cha KHÔNG giết con: sidecar Python tự sinh ffmpeg để tiền xử lý audio,
 *      nên kill(python) để lại một ffmpeg chạy mồ côi giữ file WAV — lượt sau xoá
 *      file đó là EPERM. `taskkill /T` giết cả cây.
 *   2. XOÁ FILE PHẢI CÓ RETRY. Windows không cho xoá file đang có handle mở; job
 *      sóng âm/proxy đọc nền nên `rm` trần thỉnh thoảng ném EPERM (đã đo ở
 *      stopMainVideoReaders của server.js).
 *   3. `windowsHide` khi spawn, nếu không mỗi lượt trộn nháy một cửa sổ console đen
 *      trước mặt người dùng.
 * Đường dẫn KHÔNG bao giờ đi vào chuỗi filter (chúng là đối số `-i`), nên dấu \ của
 * Windows không phải escape — đó cũng là lý do giữ nguyên `-filter_complex_script`.
 *
 * TRỤC THỜI GIAN: bản trộn được dựng theo ĐÚNG trục timeline (mỗi mảnh `adelay` về
 * đúng `timeline_start` của nó), nên mốc ASR trả về DÙNG ĐƯỢC NGAY làm mốc phụ đề —
 * không phải quy đổi lần nữa. Đây là khác biệt so với Magic Fill (nối liền các
 * khoảng, trục = tổng độ dài các khoảng).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const jobs = new Map();
let activeJobId = null;

/* server.js tiêm vào: nó giữ TEMP_DIR, danh sách trắng đường dẫn, hàm bóc băng và
 * sổ tiến trình con. Module này KHÔNG require ngược server.js (require vòng tròn). */
let ctx = {
  tempDir: '',
  setStatus: () => {},
  trackChild: () => {},
  untrackChild: () => {},
  resolveSourcePath: () => null,
  transcribe: async () => { throw new Error('subtitle-jobs: chưa tiêm hàm transcribe'); },
};
function init(hooks) { ctx = { ...ctx, ...(hooks || {}) }; }

/* Xoá file tạm, có RETRY — xem ghi chú (2) ở đầu tệp. maxRetries/retryDelay là tuỳ chọn
 * sẵn có của fs.rm; Node tự ngủ giữa các lượt nên không phải tự viết vòng chờ. */
async function rmQuiet(filePath) {
  try {
    await fsp.rm(filePath, { force: true, maxRetries: 5, retryDelay: 120 });
  } catch (_) { /* xoá hụt file tạm không đáng để làm hỏng cả job */ }
}

/* Giết CẢ CÂY tiến trình — xem ghi chú (1) ở đầu tệp.
 *
 * `taskkill` chứ không phải `child.kill()`: trên Windows, Node dịch MỌI signal thành
 * TerminateProcess trên ĐÚNG tiến trình đó, con cháu của nó sống tiếp. Trên nền tảng
 * khác giữ nguyên SIGTERM rồi SIGKILL sau 3 giây (ffmpeg/python đang bận phớt lờ
 * SIGTERM được — cùng lý do với shortvideo-jobs). */
function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    if (!child.pid) return;
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => { try { child.kill(); } catch (_) { /* đã chết */ } });
    } catch (_) {
      try { child.kill(); } catch (__) { /* đã chết */ }
    }
    return;
  }
  try { child.kill('SIGTERM'); } catch (_) { return; }
  setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* đã chết */ } }, 3000).unref();
}

const JOB_TTL_MS = 6 * 60 * 60 * 1000;

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.id === activeJobId) continue;
    if (now - (job.finishedAt || job.createdAt || now) > JOB_TTL_MS) jobs.delete(id);
  }
}

function publicJob(job) {
  if (!job) return null;
  return {
    job_id: job.id,
    state: job.state,
    stage: job.stage,
    progress: Math.max(0, Math.min(100, Math.round(job.progress))),
    message: job.message,
    error: job.error,
    warnings: job.warnings,
    result: job.result,
    created_at: job.createdAt,
    finished_at: job.finishedAt || null,
    elapsed_ms: (job.finishedAt || Date.now()) - job.createdAt,
  };
}

function newJob(params) {
  const id = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    params,
    state: 'queued',
    stage: 'queued',
    progress: 0,
    message: 'Đang xếp hàng',
    error: null,
    warnings: [],
    result: null,
    createdAt: Date.now(),
    finishedAt: null,
    child: null,
    cancelled: false,
  };
  jobs.set(id, job);
  return job;
}

function setPhase(job, stage, progress, message) {
  job.stage = stage;
  job.progress = Math.max(job.progress, progress);
  job.message = message;
  ctx.setStatus(`Auto Subtitle: ${message}`);
}

// ---------------------------------------------------------------------------
// Kế hoạch trộn
// ---------------------------------------------------------------------------

/* Một "mảnh" = một đoạn audio có thật trên timeline.
 *   source: 'main' (lane chính, đọc từ temp_input.mp4) | 'file' (asset overlay/audio)
 *   source_start/source_end: mốc trong FILE NGUỒN (giây)
 *   timeline_start: mốc trên TIMELINE nơi mảnh này bắt đầu phát (giây)
 *   speed: tốc độ block (1 = thường). Độ dài timeline = (end-start)/speed.
 *   volume: phần trăm (100 = nguyên bản)
 */
function normalizeEntries(raw, mainAudioPath) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const sourceStart = Math.max(0, Number(item?.source_start) || 0);
    const sourceEnd = Number(item?.source_end);
    const timelineStart = Math.max(0, Number(item?.timeline_start) || 0);
    if (!Number.isFinite(sourceEnd) || sourceEnd - sourceStart < 0.05) continue;

    let filePath = null;
    if (String(item?.source || 'file') === 'main') {
      filePath = mainAudioPath;
    } else {
      filePath = ctx.resolveSourcePath(item?.path);
    }
    if (!filePath || !fs.existsSync(filePath)) continue;

    const speedRaw = Number(item?.speed);
    const speed = Number.isFinite(speedRaw) && speedRaw > 0 ? Math.min(8, Math.max(0.125, speedRaw)) : 1;
    const volumeRaw = Number(item?.volume);
    const volume = Number.isFinite(volumeRaw) ? Math.max(0, Math.min(400, volumeRaw)) / 100 : 1;
    if (volume <= 0) continue;   // block đã tắt tiếng: không nghe thấy thì không bóc băng

    out.push({
      path: filePath,
      sourceStart,
      sourceEnd,
      timelineStart,
      speed,
      volume,
      timelineEnd: timelineStart + ((sourceEnd - sourceStart) / speed),
    });
  }
  return out.sort((a, b) => a.timelineStart - b.timelineStart);
}

/* atempo chỉ nhận 0.5–2.0 mỗi lượt; tốc độ ngoài khoảng đó phải xâu chuỗi.
 * (Bản ffmpeg mới nới rộng hơn, nhưng chuỗi này chạy được trên MỌI bản.) */
function atempoChain(speed) {
  if (Math.abs(speed - 1) < 1e-3) return [];
  const parts = [];
  let remaining = speed;
  while (remaining > 2.0) { parts.push('atempo=2.0'); remaining /= 2.0; }
  while (remaining < 0.5) { parts.push('atempo=0.5'); remaining /= 0.5; }
  parts.push(`atempo=${remaining.toFixed(6)}`);
  return parts;
}

/* Dựng filter_complex cho bản trộn.
 *
 * MỘT `-i` CHO MỖI FILE, KHÔNG PHẢI MỖI MẢNH: một pad đầu vào của ffmpeg chỉ được
 * TIÊU THỤ MỘT LẦN. Lane chính 40 clip cùng đọc temp_input.mp4 mà viết `[0:a]` 40 lần
 * thì ffmpeg báo lỗi "Filtergraph ... has an unconnected output"/"reuse". Vì vậy mỗi
 * file được `asplit` ra đúng số mảnh cần.
 */
function buildMixFilter(entries) {
  const files = [];
  const indexByPath = new Map();
  for (const entry of entries) {
    if (!indexByPath.has(entry.path)) {
      indexByPath.set(entry.path, files.length);
      files.push({ path: entry.path, count: 0 });
    }
    files[indexByPath.get(entry.path)].count += 1;
  }

  const lines = [];
  const splitCursor = new Map();
  files.forEach((file, index) => {
    if (file.count === 1) {
      lines.push(`[${index}:a]anull[src${index}_0]`);
    } else {
      const outs = Array.from({ length: file.count }, (_, k) => `[src${index}_${k}]`).join('');
      lines.push(`[${index}:a]asplit=${file.count}${outs}`);
    }
    splitCursor.set(index, 0);
  });

  const mixLabels = [];
  entries.forEach((entry, i) => {
    const fileIndex = indexByPath.get(entry.path);
    const branch = splitCursor.get(fileIndex);
    splitCursor.set(fileIndex, branch + 1);
    const delayMs = Math.round(entry.timelineStart * 1000);
    const chain = [
      `atrim=start=${entry.sourceStart.toFixed(3)}:end=${entry.sourceEnd.toFixed(3)}`,
      'asetpts=PTS-STARTPTS',
      ...atempoChain(entry.speed),
      'aresample=16000',
      'aformat=sample_fmts=fltp:channel_layouts=mono',
    ];
    if (Math.abs(entry.volume - 1) > 1e-3) chain.push(`volume=${entry.volume.toFixed(4)}`);
    // `all=1` để mọi kênh cùng trễ; nguồn đã ép về mono nên đây chỉ là phòng xa.
    if (delayMs > 0) chain.push(`adelay=${delayMs}:all=1`);
    lines.push(`[src${fileIndex}_${branch}]${chain.join(',')}[mix${i}]`);
    mixLabels.push(`[mix${i}]`);
  });

  if (mixLabels.length === 1) {
    // amix một đầu vào vẫn chạy nhưng thừa; `apad` để đuôi im lặng không bị cắt mất.
    lines.push(`${mixLabels[0]}anull[out]`);
  } else {
    /* normalize=0: amix mặc định CHIA cho số đầu vào, nên timeline 10 block thì lời
     * thoại nhỏ đi 10 lần và Whisper nghe thành im lặng. Giữ nguyên mức rồi chặn
     * đỉnh bằng alimiter — cắt đỉnh (clipping) cũng làm ASR sai. */
    lines.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0:normalize=0[mixed]`);
    lines.push('[mixed]alimiter=limit=0.95[out]');
  }

  return { filter: lines.join(';'), files };
}

function runFfmpeg(job, args, { totalSeconds = 0, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    job.child = child;
    ctx.trackChild(child);
    const errorLines = [];
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      errorLines.push(text);
      if (errorLines.length > 200) errorLines.splice(0, errorLines.length - 200);
      if (!totalSeconds || typeof onProgress !== 'function') return;
      // `-progress pipe:2` in ra "out_time_ms=1234567" mỗi khoảng — số THẬT của ffmpeg.
      const matches = text.match(/out_time_ms=(\d+)/g);
      if (!matches || !matches.length) return;
      const lastMs = Number(String(matches[matches.length - 1]).split('=')[1]);
      if (Number.isFinite(lastMs)) onProgress(Math.min(1, (lastMs / 1000000) / totalSeconds));
    });
    child.on('error', (error) => { ctx.untrackChild(child); job.child = null; reject(error); });
    child.on('exit', (code) => {
      ctx.untrackChild(child);
      job.child = null;
      if (code === 0) { resolve(); return; }
      if (job.cancelled) { reject(new Error('Đã huỷ')); return; }
      reject(new Error(`ffmpeg trộn audio thất bại (mã ${code}): ${errorLines.join('').trim().split('\n').pop()}`));
    });
  });
}

async function mixTimelineAudio(job, entries, outputPath) {
  const { filter, files } = buildMixFilter(entries);
  const filterPath = path.join(ctx.tempDir, `subtitle_mix_${job.id}.txt`);
  await fsp.writeFile(filterPath, filter, 'utf8');
  await rmQuiet(outputPath);
  const totalSeconds = entries.reduce((max, e) => Math.max(max, e.timelineEnd), 0);

  const args = ['-y', '-hide_banner', '-v', 'error', '-progress', 'pipe:2', '-nostats'];
  for (const file of files) args.push('-i', file.path);
  args.push(
    '-filter_complex_script', filterPath,
    '-map', '[out]',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    outputPath,
  );

  await runFfmpeg(job, args, {
    totalSeconds,
    onProgress: (ratio) => {
      job.progress = Math.max(job.progress, 4 + (ratio * 18));
    },
  });
  await rmQuiet(filterPath);

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size <= 1024) {
    throw new Error('Không trộn được audio của timeline (bản trộn rỗng).');
  }
  return { path: outputPath, duration: totalSeconds };
}

// ---------------------------------------------------------------------------
// Vòng đời job
// ---------------------------------------------------------------------------

async function runJob(job) {
  job.state = 'running';
  setPhase(job, 'plan', 1, 'đang dựng kế hoạch trộn audio');

  const mainAudioPath = path.join(ctx.tempDir, 'temp_input.mp4');
  const entries = normalizeEntries(job.params.entries, mainAudioPath);
  if (!entries.length) {
    throw new Error('Không tìm thấy đoạn audio nào trên timeline để bóc băng. '
      + 'Hãy đưa video lên lane chính hoặc thêm một tệp âm thanh rồi thử lại.');
  }
  if (job.cancelled) throw new Error('Đã huỷ');

  const audioPath = path.join(ctx.tempDir, `subtitle_mix_${job.id}.wav`);
  setPhase(job, 'mix', 4, `đang trộn ${entries.length} đoạn audio theo trục timeline`);
  const mixed = await mixTimelineAudio(job, entries, audioPath);
  if (job.cancelled) throw new Error('Đã huỷ');

  setPhase(job, 'asr', 22, 'đang bóc băng bằng Whisper');
  const asr = await ctx.transcribe(mixed.path, {
    referenceScript: String(job.params.reference_script || ''),
    transcribeMode: String(job.params.transcribe_mode || 'vi_smart'),
    // Ngôn ngữ người dùng chọn ở menu Auto Subtitle ('auto' = để Whisper tự nhận diện).
    language: String(job.params.language || 'vi'),
    asrEngine: job.params.asr_engine,
    asrModel: job.params.asr_model,
    /* Khoá cache = KẾ HOẠCH TRỘN đã chuẩn hoá, không phải file WAV (mtime của nó
     * luôn mới nên không khoá được gì). Timeline không đổi + cùng cài đặt ASR =
     * trúng cache, bấm "Tạo phụ đề" lần hai trả kết quả trong một nhịp. */
    planKey: JSON.stringify(entries.map((e) => [
      e.path, Math.round(e.sourceStart * 1000), Math.round(e.sourceEnd * 1000),
      Math.round(e.timelineStart * 1000), e.speed, e.volume,
    ])),
    onProgress: (ratio) => {
      job.progress = Math.max(job.progress, 22 + (Math.max(0, Math.min(1, ratio)) * 74));
    },
    onChild: (child) => { job.child = child; },
  });
  if (job.cancelled) throw new Error('Đã huỷ');

  setPhase(job, 'finalize', 96, 'đang dựng phụ đề từ dữ liệu bóc băng');
  const segments = (Array.isArray(asr?.segments) ? asr.segments : [])
    .map((seg) => ({
      start: Number(seg.start) || 0,
      end: Number(seg.end) || 0,
      text: String(seg.text || '').trim(),
      words: (Array.isArray(seg.words) ? seg.words : [])
        .map((w) => ({
          text: String(w.word ?? w.text ?? '').trim(),
          start: Number(w.start),
          end: Number(w.end),
        }))
        .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end)),
    }))
    .filter((seg) => seg.text && seg.end > seg.start);

  // Bản trộn là file tạm to (16 kHz mono ~ 2 MB/phút) và đã hết việc.
  try { await rmQuiet(mixed.path); } catch (_) { /* dọn hụt không sao */ }

  job.result = {
    segments,
    engine: asr?.engine || null,
    /* Ngôn ngữ THẬT của bản bóc băng (với "Tự nhận diện" là thứ Whisper nghe ra, không
     * phải thứ người dùng chọn). Renderer lấy đúng số này để chọn font cho block phụ đề —
     * chọn theo giá trị trong menu thì lựa "Tự nhận diện" luôn ra font Latin, và phụ đề
     * tiếng Trung/Nhật/Hàn thành một hàng ô vuông. */
    language: String(asr?.language || job.params.language || 'vi'),
    cache_hit: asr?.cache_hit === true,
    timeline_duration: mixed.duration,
    entry_count: entries.length,
  };
  if (!segments.length) {
    job.warnings.push('Không nghe thấy lời thoại nào trong audio của timeline.');
  }
}

function startRun(job) {
  job.finishedAt = null;
  runJob(job)
    .then(() => {
      if (job.cancelled) { job.state = 'cancelled'; job.message = 'Đã huỷ'; return; }
      job.state = 'complete';
      job.progress = 100;
      job.message = job.result?.segments?.length
        ? `Xong — ${job.result.segments.length} câu`
        : 'Xong — không có lời thoại';
    })
    .catch((err) => {
      if (job.cancelled) { job.state = 'cancelled'; job.message = 'Đã huỷ'; return; }
      job.state = 'failed';
      job.error = String(err?.message || err);
      job.message = job.error;
    })
    .finally(() => {
      job.finishedAt = Date.now();
      if (activeJobId === job.id) activeJobId = null;
    });
}

async function create(params) {
  pruneJobs();
  if (activeJobId && jobs.get(activeJobId)?.state === 'running') {
    const err = new Error('Đang có một lượt tạo phụ đề chạy. Chờ nó xong hoặc huỷ trước.');
    err.statusCode = 409;
    throw err;
  }
  const job = newJob(params || {});
  activeJobId = job.id;
  startRun(job);
  return job;
}

function get(id) { return jobs.get(id) || null; }

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return null;
  job.cancelled = true;
  if (job.child) killProcessTree(job.child);
  job.state = 'cancelled';
  job.message = 'Đã huỷ';
  job.finishedAt = Date.now();
  if (activeJobId === id) activeJobId = null;
  return job;
}

module.exports = {
  init,
  create,
  get,
  cancel,
  publicJob,
  // mở ra cho test: hai hàm này là phần dễ sai nhất và không cần ffmpeg mới kiểm được
  normalizeEntries,
  buildMixFilter,
  atempoChain,
  killProcessTree,
};
