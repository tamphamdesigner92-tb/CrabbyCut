#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* MCP SERVER CỦA CRABBYCUT — cho Claude (Claude Code / Claude Desktop) điều khiển app đang chạy.
 *
 * Chạy qua stdio, KHÔNG phụ thuộc gói npm nào: tự cài giao thức MCP (JSON-RPC 2.0, mỗi thông
 * điệp một dòng). Nhờ vậy chạy được bằng `node` khi phát triển LẪN bằng chính tệp chạy của bản
 * đã cài với ELECTRON_RUN_AS_NODE=1 (cách backend vẫn được khởi động) — máy người dùng không
 * cần cài Node. Xem mcp/README.md.
 *
 * Nó không tự mở app: app phải đang chạy và đã bật Cài đặt › Chung › "Cho phép Claude điều
 * khiển (MCP)". App ghi cổng + token vào <appDataRoot>/automation/bridge-<pid>.json (cùng chỗ
 * cho bản dev và bản cài, xem electron/automation-bridge.js); server đọc tệp đó mỗi lượt gọi.
 *
 * Có nhiều bản cùng chạy (dev + bản cài) thì chọn bằng biến môi trường CRABBYCUT_TARGET:
 *   dev | packaged | <pid>   — bỏ trống = bản bật cầu nối gần nhất. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const SERVER_INFO = { name: 'crabbycut', version: '0.3.0' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const HTTP_TIMEOUT_MS = 35_000;
// Lệnh chạy lâu (nhập cả loạt tệp, lệnh gộp): app chờ renderer chừng này, HTTP chờ thêm 5 s.
// PHẢI khớp LONG_RPC_TIMEOUT_MS ở electron/automation-bridge.js.
const LONG_TIMEOUT_MS = 300_000;
const LONG_METHODS = new Set(['batch', 'add_media_batch', 'import_media', 'add_geocode', 'add_shape', 'subsequence']);

/* ---- Tìm app ---- */

// PHẢI khớp appDataRoot() ở scripts/runtime_paths.js — không require tệp đó để thư mục mcp/
// chép đi đâu cũng chạy được.
function appDataRoot() {
  if (process.env.CRAB_APP_DATA_DIR) return path.resolve(process.env.CRAB_APP_DATA_DIR);
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'CrabbyCut');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'CrabbyCut');
  return path.join(os.homedir(), '.local', 'share', 'CrabbyCut');
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function listBridges() {
  const dir = path.join(appDataRoot(), 'automation');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^bridge-\d+\.json$/.test(n)); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!processAlive(Number(info.pid))) { try { fs.unlinkSync(file); } catch (_) {} continue; }
      out.push(info);
    } catch (_) { /* tệp đang ghi dở */ }
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

function pickBridge() {
  const bridges = listBridges();
  const target = String(process.env.CRABBYCUT_TARGET || '').trim().toLowerCase();
  const match = !target ? bridges
    : bridges.filter((b) => (target === 'dev' ? !b.packaged
      : target === 'packaged' ? b.packaged
        : String(b.pid) === target));
  if (match.length) return match[0];
  const hint = bridges.length
    ? `Không có bản nào khớp CRABBYCUT_TARGET=${target}. Đang chạy: ${bridges.map(describe).join('; ')}`
    : 'Không tìm thấy CrabbyCut đang chạy với cầu nối bật. Mở app (bản dev hoặc bản đã cài), vào '
      + 'Cài đặt › Chung › Nâng cao, bật "Cho phép Claude điều khiển (MCP)".';
  throw new Error(hint);
}

function describe(b) {
  return `pid ${b.pid} (${b.packaged ? 'bản cài' : 'dev'} v${b.version}, ${b.platform})`;
}

/* Chạy job rồi CHỜ NGAY TRONG SERVER (hỏi job_status mỗi giây) — model nhận một kết quả cuối thay
 * vì phải gọi crabbycut_job_status nhiều lượt. Hết hạn chờ mà job còn chạy thì trả job_id để hỏi tiếp;
 * job lỗi thì ném lỗi (tool báo isError). */
async function runJob(kind, options, waitSeconds) {
  const wait = Math.max(0, Math.min(600, Number.isFinite(Number(waitSeconds)) ? Number(waitSeconds) : 50));
  let job = await rpc('start_job', { kind, options });
  const deadline = Date.now() + wait * 1000;
  while (job.state === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    job = await rpc('job_status', { job_id: job.id });
  }
  if (job.state === 'complete') return { job_id: job.id, state: 'complete', ...(job.result || {}) };
  if (job.state === 'failed') throw new Error(job.error || `${kind} thất bại`);
  if (job.state === 'cancelled') return { job_id: job.id, state: 'cancelled' };
  return {
    job_id: job.id, state: job.state, progress: job.progress, message: job.message,
    next: `still running — call crabbycut_job_status with job_id "${job.id}" and wait_seconds 25`,
  };
}

function rpc(method, params) {
  const bridge = pickBridge();
  const long = LONG_METHODS.has(method);
  const payload = long ? { ...(params || {}), timeout_ms: LONG_TIMEOUT_MS } : (params || {});
  const body = JSON.stringify({ method, params: payload });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: bridge.port,
      path: '/rpc',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${bridge.token}`,
      },
      timeout: long ? LONG_TIMEOUT_MS + 5_000 : HTTP_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {
          return reject(new Error(`Phản hồi không hợp lệ từ app (HTTP ${res.statusCode})`));
        }
        if (parsed.ok) resolve(parsed.result);
        else reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('App không trả lời kịp')));
    req.on('error', (error) => reject(new Error(`Không kết nối được app (${describe(bridge)}): ${error.message}`)));
    req.end(body);
  });
}

/* ---- Danh mục tool ----
 * Mô tả viết bằng tiếng Anh (model đọc), nhắc rõ ràng buộc "chỉ ở bước Editing" để model
 * không gọi bừa rồi phải đoán lỗi. */

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };

/* Mảnh schema dùng chung cho update_block / add_media_batch / batch. */
const KEYFRAME_POINT = {
  type: 'object',
  properties: {
    t: { type: 'number', description: 'Seconds from the block start (or sequence seconds with keyframe_time "timeline").' },
    v: { description: 'Value: px for position_x/y, % for scale/opacity/volume, degrees for rotation, -100..100 for most colour params. For "position" pass [x, y] or use x/y.' },
    x: { type: 'number' },
    y: { type: 'number' },
    e: { type: 'string', enum: ['linear', 'ease-in', 'ease-out', 'ease-in-out', 'back', 'spring', 'bounce'], description: 'Easing of the segment LEAVING this keyframe (default ease-in-out).' },
  },
  required: ['t'],
};
const KEYFRAMES_SCHEMA = {
  type: 'object',
  description: 'Keyframes per field: { field: [{t, v, e}] }. Fields: position (both axes, {t, x, y}), position_x, position_y, scale, rotation, opacity, volume, and keyframable colour params (e.g. "basic.exposure", "basic.saturation", "lut.intensity", "effects.vignette"; see crabbycut_catalog color_params). Interpolated between keyframes, held before the first and after the last.',
  additionalProperties: { type: 'array', items: KEYFRAME_POINT },
};
const KEYFRAME_MODE = { type: 'string', enum: ['merge', 'replace'], default: 'merge', description: 'merge = insert/overwrite the given keyframes; replace = the listed fields get exactly these keyframes ([] clears the field).' };
const KEYFRAME_TIME = { type: 'string', enum: ['local', 'timeline'], default: 'local', description: 't measured from the block start (local) or on the sequence (timeline).' };
const TRANSFORM_SCHEMA = { type: 'object', additionalProperties: { type: ['number', 'boolean'] }, description: 'position_x, position_y (px from centre), scale (%), rotation (deg), opacity (%), flip_x, flip_y.' };
const ANIM_SIDE = { type: 'object', properties: { type: { type: 'string' }, duration: { type: 'number' }, easing: { type: 'string' } } };
const ANIMATION_SCHEMA = { type: 'object', properties: { combo: { type: 'string' }, combo_duration: { type: 'number' }, in: ANIM_SIDE, out: ANIM_SIDE } };
const WAIT_SECONDS = { type: 'number', minimum: 0, maximum: 600, default: 50, description: 'How long the server waits for the job before returning (still running -> job_id for crabbycut_job_status).' };
const PLACEMENT_PROPS = {
  start: { type: 'number', minimum: 0 },
  track_id: { type: 'string' },
  transform: TRANSFORM_SCHEMA,
  keyframes: KEYFRAMES_SCHEMA,
  keyframe_mode: KEYFRAME_MODE,
  keyframe_time: KEYFRAME_TIME,
  animation: ANIMATION_SCHEMA,
};
const GEOCODE_BLOCK_PROPS = {
  lang: { type: 'string', enum: ['html', 'canvas', 'python'] },
  code: { type: 'string', minLength: 1 },
  preset: { type: 'string' },
  width: { type: 'integer', minimum: 16, maximum: 4096 },
  height: { type: 'integer', minimum: 16, maximum: 4096 },
  kind: { type: 'string', enum: ['image', 'video'], default: 'image' },
  duration: { type: 'number', exclusiveMinimum: 0, description: 'Video length in seconds (kind video).' },
  fps: { type: 'integer', minimum: 1, maximum: 60 },
  bg: { type: 'string', description: '"transparent" (default) or #rrggbb.' },
  loop: { type: 'boolean', default: true, description: 'Loop the video when the block is longer than it (otherwise hold the last frame).' },
  block_duration: { type: 'number', exclusiveMinimum: 0, description: 'Block length on the timeline (default: video length, or 5 s for an image).' },
  ...PLACEMENT_PROPS,
};
const SHAPE_PROPS = {
  shape_type: { type: 'string', enum: ['rectangle', 'square', 'circle', 'triangle', 'trapezoid', 'polygon', 'star', 'line', 'path'] },
  width: { type: 'number', minimum: 20, maximum: 4000 },
  height: { type: 'number', minimum: 20, maximum: 4000 },
  fill_color: { type: 'string' },
  stroke_color: { type: 'string' },
  stroke_width: { type: 'number', minimum: 0, maximum: 100 },
  stroke_position: { type: 'string', enum: ['inside', 'center', 'outside'] },
  corner_radius: { type: 'number', minimum: 0 },
  outer_corner_radius: { type: 'number', minimum: 0 },
  inner_corner_radius: { type: 'number', minimum: 0 },
  sides: { type: 'integer', minimum: 3 },
  points: { type: 'integer', minimum: 3 },
  path_points: { type: 'array', items: { type: 'object' } },
  path_closed: { type: 'boolean' },
  duration: { type: 'number', exclusiveMinimum: 0 },
  ...PLACEMENT_PROPS,
};

const TOOLS = [
  {
    name: 'crabbycut_status',
    description: 'Check the connection to the running CrabbyCut app and return a short project state: step, mode, project path/name, unsaved flag, duration, playhead, playing, clip counts, undo/redo depth, and in_subsequence / subsequence_path when the user (or you) is editing inside a Subsequence. Call this first.',
    inputSchema: NO_ARGS,
    run: async () => {
      const ping = await rpc('ping');
      const state = await rpc('get_state');
      return json({ app: ping, instances: listBridges().map(describe), state });
    },
  },
  {
    name: 'crabbycut_get_timeline',
    description: 'Return the timeline: main-lane clips (index, timeline_start/end in sequence seconds, source start/end, text) and, optionally, overlay tracks and items (text/media/audio blocks with id, track_id, timeline_start, duration). Times are in seconds. Subsequence (nest) blocks and main-lane rows carry subsequence {asset_id, name}. When in_subsequence is true this is the INSIDE of the open Subsequence (no main lane) — crabbycut_subsequence exit to return.',
    inputSchema: {
      type: 'object',
      properties: { include_overlays: { type: 'boolean', default: true } },
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('get_timeline', args)),
  },
  {
    name: 'crabbycut_screenshot',
    description: 'Capture the CrabbyCut window as an image to see the preview, timeline and panels. If the window is minimized the image is the last frame before minimizing (reported as stale); pass restore: true to un-minimize it without stealing focus.',
    inputSchema: {
      type: 'object',
      properties: { restore: { type: 'boolean', default: false } },
      additionalProperties: false,
    },
    run: async (args) => {
      const shot = await rpc('screenshot', args);
      return {
        content: [
          { type: 'image', data: shot.data, mimeType: shot.mimeType },
          { type: 'text', text: `${shot.width}x${shot.height} px — use these pixel coordinates with crabbycut_ui_* tools.${shot.stale ? ' WARNING: the window is minimized, so this image is STALE (last frame before minimizing). Call again with restore: true to see the current state.' : ''}` },
        ],
      };
    },
  },
  {
    name: 'crabbycut_seek',
    description: 'Move the playhead to a sequence time in seconds.',
    inputSchema: {
      type: 'object',
      properties: { time: { type: 'number', minimum: 0 } },
      required: ['time'],
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('seek', args)),
  },
  {
    name: 'crabbycut_playback',
    description: 'Play or pause the preview.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['play', 'pause'] } },
      required: ['action'],
      additionalProperties: false,
    },
    run: async ({ action }) => json(await rpc(action === 'play' ? 'play' : 'pause')),
  },
  {
    name: 'crabbycut_undo',
    description: 'Undo or redo the last edit (same as Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z).',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['undo', 'redo'], default: 'undo' } },
      additionalProperties: false,
    },
    run: async ({ action }) => json(await rpc(action === 'redo' ? 'redo' : 'undo')),
  },
  {
    name: 'crabbycut_select',
    description: 'Editing step only. Select one main-lane clip by index, or one overlay item by id. Pass neither to clear the selection.',
    inputSchema: {
      type: 'object',
      properties: { main_index: { type: 'integer', minimum: 0 }, item_id: { type: 'string' } },
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('select', args)),
  },
  {
    name: 'crabbycut_split',
    description: 'Editing step only. Split at a sequence time (default: playhead). Without item_id it cuts the main-lane clip under that time; with item_id it cuts that overlay item. Undoable.',
    inputSchema: {
      type: 'object',
      properties: { time: { type: 'number', minimum: 0 }, item_id: { type: 'string' } },
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('split', args)),
  },
  {
    name: 'crabbycut_delete_selected',
    description: 'Editing step only. Delete the selected clips/items (select them first with crabbycut_select). Undoable.',
    inputSchema: NO_ARGS,
    run: async () => json(await rpc('delete_selected')),
  },
  {
    name: 'crabbycut_add_text',
    description: 'Editing step only. Add a text block on an overlay track — with its look in the SAME call (one undo step): style (font_family, font_size, color, font_weight, letter_spacing, font_kerning auto|none, align, stroke_*, bg_*, shadow_*), warp (After Effects style text warp: type arc | arc_lower | arc_upper | arch | bulge | shell_lower | shell_upper | flag | wave | fish | rise | fisheye | inflate | squeeze | twist, bend/horizontal/vertical -100..100), path (text running along a curve: preset arc | smile | wave | circle | s_curve | rise, or points in the Pen model; width/height of the path box, x/y its centre in px from the frame centre, offset, align, flip, shift), transform, keyframes, animation. start defaults to the playhead, duration to 5 s. Warp types: crabbycut_catalog text_warps. Change them later with crabbycut_update_block style {warp_*, path_*}.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1 },
        start: { type: 'number', minimum: 0 },
        duration: { type: 'number', exclusiveMinimum: 0 },
        track_id: { type: 'string' },
        style: { type: 'object', description: 'Text style fields (see crabbycut_update_block).' },
        warp: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['none', 'arc', 'arc_lower', 'arc_upper', 'arch', 'bulge', 'shell_lower', 'shell_upper', 'flag', 'wave', 'fish', 'rise', 'fisheye', 'inflate', 'squeeze', 'twist'] },
            bend: { type: 'number', minimum: -100, maximum: 100 },
            horizontal: { type: 'number', minimum: -100, maximum: 100 },
            vertical: { type: 'number', minimum: -100, maximum: 100 },
          },
          required: ['type'],
        },
        path: {
          type: 'object',
          properties: {
            preset: { type: 'string', enum: ['arc', 'smile', 'wave', 'circle', 's_curve', 'rise'] },
            points: { type: 'array', items: { type: 'object' } },
            closed: { type: 'boolean' },
            width: { type: 'number', minimum: 10 },
            height: { type: 'number', minimum: 0 },
            x: { type: 'number' },
            y: { type: 'number' },
            offset: { type: 'number', minimum: -100, maximum: 100 },
            align: { type: 'string', enum: ['left', 'center', 'right'] },
            flip: { type: 'boolean' },
            shift: { type: 'number' },
          },
        },
        transform: TRANSFORM_SCHEMA,
        keyframes: KEYFRAMES_SCHEMA,
        keyframe_mode: KEYFRAME_MODE,
        keyframe_time: KEYFRAME_TIME,
        animation: ANIMATION_SCHEMA,
      },
      required: ['text'],
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('add_text', args)),
  },
  {
    name: 'crabbycut_save_project',
    description: 'Save the open project to its existing .crab file. Fails if the project was never saved (the user must pick a location once).',
    inputSchema: NO_ARGS,
    run: async () => json(await rpc('save_project')),
  },
  {
    name: 'crabbycut_open_project',
    description: 'Open a .crab project by absolute path. Refuses while the current project has unsaved changes.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('open_project', args)),
  },

  /* ---- Dự án & media ---- */
  {
    name: 'crabbycut_new_project',
    description: 'Start a new blank project in the Editing step, optionally putting videos (absolute paths) on the main lane. Refuses while the current project has unsaved changes.',
    inputSchema: {
      type: 'object',
      properties: { video_paths: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('new_project', args)),
  },
  {
    name: 'crabbycut_add_main_videos',
    description: 'Append videos (absolute paths) to the main lane of the open project.',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' }, minItems: 1 } },
      required: ['paths'],
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('add_main_videos', args)),
  },
  {
    name: 'crabbycut_import_media',
    description: 'Editing step only. Import files (absolute paths) into the project media panel. kind "media" = video/image, "audio" = audio. mode "copy" copies into the project, "link" references in place (also accepts folders). With add_to_timeline the imported assets are placed one after another on overlay tracks starting at start (default playhead).',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, minItems: 1 },
        kind: { type: 'string', enum: ['media', 'audio'], default: 'media' },
        mode: { type: 'string', enum: ['copy', 'link'], default: 'copy' },
        add_to_timeline: { type: 'boolean', default: false },
        start: { type: 'number', minimum: 0 },
        track_id: { type: 'string' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('import_media', args)),
  },
  {
    name: 'crabbycut_list_assets',
    description: 'List project media assets (ids for crabbycut_add_asset) and main-lane sources. With library_category (video | elements | sfxs | music) also lists the built-in library.',
    inputSchema: {
      type: 'object',
      properties: { library_category: { type: 'string', enum: ['video', 'elements', 'sfxs', 'music'] } },
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('list_assets', args)),
  },
  {
    name: 'crabbycut_add_asset',
    description: 'Editing step only. Place a project asset (asset_id) or a library item ({category, name}) on an overlay track at start (default playhead). trim_start/trim_end are source seconds. Undoable.',
    inputSchema: {
      type: 'object',
      properties: {
        asset_id: { type: 'string' },
        library: { type: 'object', properties: { category: { type: 'string' }, name: { type: 'string' } }, required: ['category', 'name'] },
        start: { type: 'number', minimum: 0 },
        track_id: { type: 'string' },
        trim_start: { type: 'number', minimum: 0 },
        trim_end: { type: 'number', minimum: 0 },
        duration: { type: 'number', exclusiveMinimum: 0 },
      },
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('add_asset', args)),
  },
  {
    name: 'crabbycut_catalog',
    description: 'Look up valid ids/values before editing: transitions, animations, text_styles, text_effects, luts, color_params, export_options, subtitle, library_categories, geocode (languages, size presets, limits), shapes (shape types + style fields), voices (dubbing engines, voices, cloned voice profiles), text_warps (text warp types + text-on-path presets), distort (After Effects style distort effects wave | bezier | mesh | puppet | liquify: every param with its range/options/default and whether it can be keyframed).',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['transitions', 'animations', 'text_styles', 'text_effects', 'luts', 'color_params', 'export_options', 'subtitle', 'library_categories', 'geocode', 'shapes', 'voices', 'text_warps', 'distort'] } },
      required: ['kind'],
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('catalog', args)),
  },

  /* ---- Sửa block ---- */
  {
    name: 'crabbycut_update_block',
    description: 'Editing step only. Change properties of ONE block: a main-lane clip (main_index) or an overlay item (item_id). transform: position_x, position_y, scale, rotation, opacity, flip_x, flip_y (fields with keyframes get a keyframe at the playhead). keyframes animates fields over time, e.g. {"position": [{"t": 0, "x": -400, "y": 0}, {"t": 2, "x": 0, "y": 0, "e": "ease-out"}], "scale": [{"t": 0, "v": 80}, {"t": 2, "v": 100}]}. volume is percent (100 = original). speed is a rate (1 = normal). Overlay items also accept timeline_start, duration, muted, text (text blocks) and style (text: font_family, font_size, color, font_weight, letter_spacing, font_kerning auto|none, line_height, align, stroke_*, bg_*, shadow_*, warp_*, path_*). Media (image/video) and shape items also accept distort: the After Effects style distort stack [{id?, type wave|bezier|mesh|puppet|liquify, enabled, params}] in order — entries with an existing id keep their other params and keyframes, entries without id are new effects, effects left out are removed ([] clears); animate a param with keyframes {"dst.<effect id>.<param>": [{t, v, e}]} (ids are returned in the result; params, ranges and keyframable flags: crabbycut_catalog distort). One undo step.',
    inputSchema: {
      type: 'object',
      properties: {
        main_index: { type: 'integer', minimum: 0 },
        item_id: { type: 'string' },
        transform: TRANSFORM_SCHEMA,
        keyframes: KEYFRAMES_SCHEMA,
        keyframe_mode: KEYFRAME_MODE,
        keyframe_time: KEYFRAME_TIME,
        volume: { type: 'number', minimum: 0, maximum: 1000 },
        speed: { type: 'number', minimum: 0.1, maximum: 100 },
        pitch_correct: { type: 'boolean' },
        timeline_start: { type: 'number', minimum: 0 },
        duration: { type: 'number', exclusiveMinimum: 0 },
        muted: { type: 'boolean' },
        text: { type: 'string' },
        style: { type: 'object' },
        distort: {
          type: 'array',
          maxItems: 8,
          description: 'Distort effects (media/shape items only), the whole new stack in order. See crabbycut_catalog distort.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Existing effect id to keep/modify (e.g. "d1"); omit for a new effect.' },
              type: { type: 'string', enum: ['wave', 'bezier', 'mesh', 'puppet', 'liquify'], description: 'Required for a new effect.' },
              enabled: { type: 'boolean' },
              params: { type: 'object', description: 'Only the params to set, e.g. wave {"wave_type": "sine", "height": 20, "width": 120, "direction": 90, "speed": 1, "pinning": "none", "phase": 0}; bezier {"tl_vertex": [0, 0], ...} as box fractions; puppet {"pins": [{"id": "a", "rest": [0.5, 0.2], "pos": [0.6, 0.1]}]}.' },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('update_block', args)),
  },
  {
    name: 'crabbycut_apply_text_preset',
    description: 'Editing step only. Apply a text style preset (style_preset, e.g. "p3") and/or a text effect (effect, e.g. "fx7", or "none" to clear) to a text block. Ids come from crabbycut_catalog text_styles / text_effects.',
    inputSchema: {
      type: 'object',
      properties: { item_id: { type: 'string' }, style_preset: { type: 'string' }, effect: { type: 'string' } },
      required: ['item_id'],
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('apply_text_preset', args)),
  },
  {
    name: 'crabbycut_set_animation',
    description: 'Editing step only. Set in/out animation of a block (main_index or item_id). Either combo (e.g. "pop_fade", "none" to clear) with optional combo_duration (total seconds), or in/out objects {type, duration 0.2-2, easing}. Values from crabbycut_catalog animations.',
    inputSchema: {
      type: 'object',
      properties: {
        main_index: { type: 'integer', minimum: 0 },
        item_id: { type: 'string' },
        combo: { type: 'string' },
        combo_duration: { type: 'number' },
        in: ANIM_SIDE,
        out: ANIM_SIDE,
      },
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('set_animation', args)),
  },
  {
    name: 'crabbycut_set_transition',
    description: 'Editing step only. Set the transition AFTER a block: main_index i = between main clips i and i+1; item_id = to the overlay item that touches it on the right on the same track. type from crabbycut_catalog transitions ("none" removes). duration seconds (capped by both blocks, max 2).',
    inputSchema: {
      type: 'object',
      properties: {
        main_index: { type: 'integer', minimum: 0 },
        item_id: { type: 'string' },
        type: { type: 'string' },
        duration: { type: 'number', exclusiveMinimum: 0 },
      },
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('set_transition', args)),
  },
  {
    name: 'crabbycut_set_color',
    description: 'Editing step only. Colour-grade a main clip (main_index) or a media / adjustment-layer item (item_id). lut_id from crabbycut_catalog luts ("" removes), lut_intensity 0-100, params like {"basic.exposure": 20, "basic.saturation": -30, "effects.vignette": 40} (paths from crabbycut_catalog color_params).',
    inputSchema: {
      type: 'object',
      properties: {
        main_index: { type: 'integer', minimum: 0 },
        item_id: { type: 'string' },
        lut_id: { type: 'string' },
        lut_intensity: { type: 'number', minimum: 0, maximum: 100 },
        params: { type: 'object', additionalProperties: { type: 'number' } },
      },
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('set_color', args)),
  },
  {
    name: 'crabbycut_subsequence',
    description: 'Editing step only. Subsequences (Premiere-style nested sequences): action "list" (all Subsequences with instance counts); "create" packs item_ids (any overlay lanes) and/or main_indexes (adjacent main-lane clips; slow — renders a file) into ONE Subsequence block, optional name; "enter" opens one (item_id or main_index) so every timeline/editing tool then works INSIDE it; "exit" goes back (levels, or all: true); "rename" (item_id | main_index | asset_id, name); "duplicate" an item_id (independent: false = shares content, true = own copy); "make_unique" gives an item_id its own copy of the content; "unnest" puts the content back on this timeline (discard_effects: true needed when the block has its own transform/effects/colour/volume, which are lost). Each edit is one undo step; enter/exit are navigation only. Export and crabbycut_add_main_videos leave Subsequences automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'enter', 'exit', 'rename', 'duplicate', 'make_unique', 'unnest'] },
        item_ids: { type: 'array', items: { type: 'string' }, description: 'create: overlay blocks to pack.' },
        main_indexes: { type: 'array', items: { type: 'integer', minimum: 0 }, description: 'create: adjacent main-lane clips to pack.' },
        item_id: { type: 'string', description: 'The Subsequence block.' },
        main_index: { type: 'integer', minimum: 0, description: 'A Subsequence row on the main lane (enter, rename).' },
        asset_id: { type: 'string', description: 'rename: the Subsequence asset (from list / subsequence_path).' },
        name: { type: 'string', maxLength: 60 },
        levels: { type: 'integer', minimum: 1, default: 1 },
        all: { type: 'boolean', description: 'exit: back to the root timeline.' },
        independent: { type: 'boolean', default: false },
        discard_effects: { type: 'boolean', default: false },
      },
      required: ['action'],
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('subsequence', args)),
  },

  /* ---- Lệnh gộp: cả lô = MỘT bước Hoàn tác + MỘT lượt vẽ ---- */
  {
    name: 'crabbycut_add_media_batch',
    description: 'Editing step only. Put MANY images/videos/audio files on the timeline in ONE call and ONE undo step — use this instead of repeated import_media/add_asset/update_block calls. Each item: exactly one of path (absolute file path, imported once), asset_id or library {category, name}; start (seconds; default right after the previous item + gap, the first item at the batch start or the playhead), duration, track_id, trim_start/trim_end (source seconds), transform, keyframes (+ keyframe_mode, keyframe_time), animation {combo, combo_duration} or {in, out}, transition {type, duration} to the next block on the same track, color {lut_id, lut_intensity, params}, volume, muted. defaults are merged into every item. on_error "abort" (default) rolls back the whole batch on any failure; "continue" skips failed items. Returns [{index, item_id, asset_id, track_id, timeline_start, duration, error?}].',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              asset_id: { type: 'string' },
              library: { type: 'object', properties: { category: { type: 'string' }, name: { type: 'string' } }, required: ['category', 'name'] },
              start: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'string', enum: ['after_previous'] }] },
              duration: { type: 'number', exclusiveMinimum: 0 },
              track_id: { type: 'string' },
              trim_start: { type: 'number', minimum: 0 },
              trim_end: { type: 'number', minimum: 0 },
              transform: TRANSFORM_SCHEMA,
              keyframes: KEYFRAMES_SCHEMA,
              keyframe_mode: KEYFRAME_MODE,
              keyframe_time: KEYFRAME_TIME,
              animation: { type: 'object', properties: { combo: { type: 'string' }, combo_duration: { type: 'number' }, in: ANIM_SIDE, out: ANIM_SIDE } },
              transition: { type: 'object', properties: { type: { type: 'string' }, duration: { type: 'number' } } },
              color: { type: 'object', properties: { lut_id: { type: 'string' }, lut_intensity: { type: 'number' }, params: { type: 'object', additionalProperties: { type: 'number' } } } },
              volume: { type: 'number', minimum: 0, maximum: 1000 },
              muted: { type: 'boolean' },
            },
          },
        },
        defaults: { type: 'object', description: 'Fields merged into every item (item values win; nested objects merge one level).' },
        mode: { type: 'string', enum: ['copy', 'link'], default: 'copy', description: 'copy files into the project, or link them in place.' },
        start: { type: 'number', minimum: 0, description: 'Start of the first item (default playhead).' },
        gap: { type: 'number', minimum: 0, default: 0, description: 'Seconds between consecutive auto-placed items.' },
        track_id: { type: 'string', description: 'Preferred track for every item (falls back to a free track of the right type).' },
        on_error: { type: 'string', enum: ['abort', 'continue'], default: 'abort' },
      },
      required: ['items'],
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('add_media_batch', args)),
  },
  {
    name: 'crabbycut_batch',
    description: 'Editing step only. Run many EDIT commands in one call and ONE undo step, in order. ops: [{tool, args}] where tool is one of add_text, update_block, apply_text_preset, set_animation, set_transition, set_color, split, select, delete_selected, seek, add_asset, import_media, add_media_batch, add_geocode (waits for the render), add_shape (with or without the crabbycut_ prefix) and args are the arguments of that tool. Reference an earlier result with a string "$<index>.<path>", e.g. {"tool": "add_text", "args": {"text": "Hi"}} then {"tool": "update_block", "args": {"item_id": "$0.item_id", "keyframes": {...}}}. UI tools, screenshots and jobs are not allowed. on_error "abort" (default) rolls back everything on the first failure; "continue" rolls back only the failed op.',
    inputSchema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          minItems: 1,
          maxItems: 500,
          items: {
            type: 'object',
            properties: { tool: { type: 'string' }, args: { type: 'object' } },
            required: ['tool'],
          },
        },
        on_error: { type: 'string', enum: ['abort', 'continue'], default: 'abort' },
      },
      required: ['ops'],
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('batch', args)),
  },

  /* ---- GeoCode: dựng ảnh/video từ mã ----
   * Mọi tool dựng lâu (GeoCode, lồng tiếng) TỰ CHỜ job trong server (runJob) rồi trả kết quả gọn:
   * model khỏi gọi crabbycut_job_status nhiều lượt — mỗi lượt là một vòng token. */
  {
    name: 'crabbycut_add_geocode',
    description: 'Editing step only. Render images/videos from CODE at an exact pixel size and place them as GeoCode blocks on a shape track (scale 100% = exactly width x height px; transparent background by default). lang: "html" (HTML/CSS/JS page, CSS animations and timers run on a virtual clock), "canvas" (define function draw(ctx, t, width, height, frame)) or "python" (define def frame(t, width, height) returning a PIL.Image / numpy array / matplotlib Figure; runs with the machine\'s real Python and FULL user permissions — the user sees a notification). Size: width + height, or preset (crabbycut_catalog geocode). kind "video" needs duration (s) and fps (default: sequence fps, max 3600 frames). ONE block: pass the fields at top level. MANY blocks (cheaper — one call, one undo step): items[] + defaults; put the shared code ONCE in template with {{name}} slots and give each item only vars (or its own code). Items without start follow the previous one (+ gap). The server waits for the render (wait_seconds, default 50) and returns item_id(s); if still running you get job_id — continue with crabbycut_job_status. Logs are returned only for warnings/errors (verbose_logs for all). Inside crabbycut_batch use tool "add_geocode" (one block).',
    inputSchema: {
      type: 'object',
      properties: {
        ...GEOCODE_BLOCK_PROPS,
        items: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', properties: { ...GEOCODE_BLOCK_PROPS, vars: { type: 'object', description: 'Values for the {{name}} slots of template.' } } } },
        template: { type: 'string', description: 'Shared code with {{name}} slots, filled from each item\'s vars (items without code).' },
        defaults: { type: 'object', description: 'Fields merged into every item (lang, width, height, kind, fps, bg, animation…).' },
        gap: { type: 'number', minimum: 0, default: 0, description: 'Seconds between items placed one after another.' },
        on_error: { type: 'string', enum: ['abort', 'continue'], default: 'abort' },
        verbose_logs: { type: 'boolean', default: false },
        wait_seconds: WAIT_SECONDS,
      },
      additionalProperties: false,
    },
    run: async ({ wait_seconds, ...args }) => {
      if (!(Array.isArray(args.items) && args.items.length) && !(args.lang && args.code)) {
        throw new Error('Pass lang + code for one block, or items[] (with template/vars or code) for many');
      }
      return json(await runJob('geocode', args, wait_seconds));
    },
  },
  {
    name: 'crabbycut_update_geocode',
    description: 'Editing step only. Change an existing GeoCode block WITHOUT resending its code: replace [{find, with, all}] patches the code stored in the block (or pass a new code), and/or change width, height, kind, fps, duration, bg, loop; then it is re-rendered in place keeping position, transform, keyframes and animation. block_duration only changes the block length (no re-render). read: true returns the current code (alone: no change). Waits for the render like crabbycut_add_geocode.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        code: { type: 'string', minLength: 1 },
        replace: { type: 'array', items: { type: 'object', properties: { find: { type: 'string', minLength: 1 }, with: { type: 'string' }, all: { type: 'boolean', default: false } }, required: ['find'] } },
        width: { type: 'integer', minimum: 16, maximum: 4096 },
        height: { type: 'integer', minimum: 16, maximum: 4096 },
        kind: { type: 'string', enum: ['image', 'video'] },
        fps: { type: 'integer', minimum: 1, maximum: 60 },
        duration: { type: 'number', exclusiveMinimum: 0 },
        bg: { type: 'string' },
        loop: { type: 'boolean' },
        block_duration: { type: 'number', exclusiveMinimum: 0 },
        read: { type: 'boolean', default: false },
        verbose_logs: { type: 'boolean', default: false },
        wait_seconds: WAIT_SECONDS,
      },
      required: ['item_id'],
      additionalProperties: false,
    },
    run: async ({ wait_seconds, ...args }) => {
      const rebuild = args.code !== undefined || (Array.isArray(args.replace) && args.replace.length)
        || ['width', 'height', 'kind', 'fps', 'duration', 'bg', 'loop'].some((k) => args[k] !== undefined);
      if (!rebuild) return json(await rpc('update_geocode', args));
      return json(await runJob('geocode_update', args, wait_seconds));
    },
  },

  /* ---- Shape (Hình học › Hình dạng) ---- */
  {
    name: 'crabbycut_add_shape',
    description: 'Editing step only. Add vector shapes on a shape track in ONE call and ONE undo step: one shape (fields at top level) or items[] + defaults. shape_type rectangle | square | circle | triangle | trapezoid | polygon | star | line | path; width/height px, fill_color/stroke_color #rrggbb, stroke_width, stroke_position, corner_radius, outer/inner_corner_radius (star), sides (polygon), points (star), path_points for "path" (see crabbycut_catalog shapes). Plus start, duration (default 5 s), track_id, transform, keyframes, animation. Items without start follow the previous one (+ gap). Returns item_id(s). Also usable inside crabbycut_batch as "add_shape".',
    inputSchema: {
      type: 'object',
      properties: {
        ...SHAPE_PROPS,
        items: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'object', properties: SHAPE_PROPS } },
        defaults: { type: 'object', description: 'Fields merged into every item.' },
        gap: { type: 'number', minimum: 0, default: 0 },
        on_error: { type: 'string', enum: ['abort', 'continue'], default: 'abort' },
      },
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('add_shape', args)),
  },

  /* ---- Lồng tiếng (Âm thanh › Lồng tiếng) ---- */
  {
    name: 'crabbycut_dub',
    description: 'Editing step only. AI voice-over placed on the "Lồng tiếng" audio track, in one call: text (split into sentences, read one after another with gap seconds between, starting at start) or sentences[] (exact sentences, no splitting) — both also create matching subtitles unless make_subtitles is false; or cues[] {start, end, text} timed on the timeline (timing_mode auto_fit | dynamic_shift | fixed_duration). engine/voice default to the user\'s choice in the Dubbing panel; list them with crabbycut_catalog voices (voice_profile = a cloned voice id). replace (default true) swaps the previous dub with the same name. The server waits for the job (wait_seconds, default 50; first run may download a model) and returns the timeline start/end of every sentence (clips[i]) — use them to time GeoCode/text/shapes to the speech without reading the timeline again.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        sentences: { type: 'array', items: { type: 'string' }, maxItems: 500 },
        cues: { type: 'array', maxItems: 2000, items: { type: 'object', properties: { start: { type: 'number', minimum: 0 }, end: { type: 'number' }, text: { type: 'string' } }, required: ['start', 'end', 'text'] } },
        start: { type: 'number', minimum: 0, default: 0, description: 'Timeline offset (s) added to every sentence/cue.' },
        gap: { type: 'number', minimum: 0, maximum: 5, default: 0.4 },
        engine: { type: 'string' },
        voice: { type: 'string' },
        voice_profile: { type: 'string' },
        engine_options: { type: 'object', description: 'qwen3: {mode custom|clone|design, language, instruct}; chatterbox: {language, exaggeration, cfg_weight}.' },
        speed: { type: 'number', minimum: 0.5, maximum: 2 },
        timing_mode: { type: 'string', enum: ['auto_fit', 'dynamic_shift', 'fixed_duration'] },
        max_speed: { type: 'number', minimum: 1, maximum: 2 },
        split: { type: 'boolean', default: false, description: 'One audio block per sentence instead of one block for the whole read.' },
        make_subtitles: { type: 'boolean', default: true },
        replace: { type: 'boolean', default: true },
        name: { type: 'string', description: 'Name of this dub (default "MCP"); same name + replace swaps the old one.' },
        wait_seconds: WAIT_SECONDS,
      },
      additionalProperties: false,
    },
    run: async ({ wait_seconds, ...args }) => json(await runJob('dub', args, wait_seconds)),
  },

  /* ---- Job chạy lâu ---- */
  {
    name: 'crabbycut_start_job',
    description: 'Start a long-running task and return a job immediately; then poll crabbycut_job_status. Prefer crabbycut_add_geocode / crabbycut_update_geocode / crabbycut_dub, which wait for the job themselves. kinds: "geocode" (same options as crabbycut_add_geocode), "geocode_update" (same as crabbycut_update_geocode), "dub" (same as crabbycut_dub), "auto_subtitle" (options: scope all|main|overlay, language vi|en|zh|ja|ko|auto), "magic_fill" (needs a script loaded), "export" (options: output_path REQUIRED absolute file path, video bool, audio bool, resolution, fps, codec, bitrate, bitrate_mbps, audio_bitrate, audio_format, audio_file_bitrate — values from crabbycut_catalog export_options). Editing step only.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['auto_subtitle', 'magic_fill', 'export', 'geocode', 'geocode_update', 'dub'] },
        options: { type: 'object' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    run: async ({ kind, options = {} }) => {
      if (kind === 'export') {
        if (!options.output_path) throw new Error('options.output_path is required for export');
        await rpc('export_set_output', { path: options.output_path });
      }
      return json(await rpc('start_job', { kind, options }));
    },
  },
  {
    name: 'crabbycut_job_status',
    description: 'Get a job\'s state (running | complete | failed | cancelled), progress, message and result. wait_seconds (max 25) waits for the job to finish before answering, to poll less often. Without job_id lists all jobs.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' }, wait_seconds: { type: 'number', minimum: 0, maximum: 25 } },
      additionalProperties: false,
    },
    run: async ({ job_id, wait_seconds = 0 }) => {
      if (!job_id) return json(await rpc('list_jobs'));
      const deadline = Date.now() + Math.min(25, Number(wait_seconds) || 0) * 1000;
      let job = await rpc('job_status', { job_id });
      while (job.state === 'running' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        job = await rpc('job_status', { job_id });
      }
      return json(job);
    },
  },
  {
    name: 'crabbycut_cancel_job',
    description: 'Cancel a running job (auto_subtitle can be cancelled; magic_fill and export cannot).',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('cancel_job', args)),
  },

  /* ---- Giao diện: bấm/gõ như người dùng ----
   * Dùng khi không có tool chuyên biệt. Toạ độ = pixel trên ảnh crabbycut_screenshot. */
  {
    name: 'crabbycut_ui_snapshot',
    description: 'List visible clickable/editable UI elements (buttons, inputs, selects, tabs, timeline blocks, asset cards…) with a ref, role, label, value/state and box {x,y,w,h} in screenshot pixels. Use refs with the other crabbycut_ui_* tools. query filters by label/id text. Elements hidden behind a modal are skipped unless include_covered.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
        include_covered: { type: 'boolean', default: false },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const { css_per_pixel: k } = await rpc('ui_scale');
      const snap = await rpc('ui_snapshot', args);
      const px = (v) => Math.round(v / (k || 1));
      const lines = snap.elements.map((e) => {
        const flags = [e.disabled && 'disabled', e.active && 'active', e.covered && 'covered'].filter(Boolean);
        return `${e.ref} ${e.role} "${e.label}" @${px(e.x)},${px(e.y)} ${px(e.w)}x${px(e.h)}${e.id ? ` #${e.id}` : ''}${flags.length ? ` [${flags.join(',')}]` : ''}`;
      });
      const header = `viewport ${px(snap.viewport.w)}x${px(snap.viewport.h)} (screenshot px), focused: ${snap.focused || '-'}, ${lines.length} elements`;
      return { content: [{ type: 'text', text: [header, ...lines].join('\n') }] };
    },
  },
  {
    name: 'crabbycut_ui_click',
    description: 'Click like a real mouse: by ref (from crabbycut_ui_snapshot) or x,y in screenshot pixels. button left|right|middle, clicks 1-3 (2 = double-click), modifiers e.g. ["shift"], ["alt"], ["cmd"] (= Ctrl on Windows).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
        clicks: { type: 'integer', minimum: 1, maximum: 3, default: 1 },
        modifiers: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const at = await pointFor(args.ref, args);
      const out = await rpc('ui_click', { ...args, ...at });
      return json({ ...out, ref: args.ref, label: at.label });
    },
  },
  {
    name: 'crabbycut_ui_drag',
    description: 'Drag with the left mouse button (move blocks, trim edges, sliders, drop assets onto the timeline). from/to are refs or {x,y} in screenshot pixels.',
    inputSchema: {
      type: 'object',
      properties: {
        from_ref: { type: 'string' },
        from: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        to_ref: { type: 'string' },
        to: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        steps: { type: 'integer', minimum: 2, maximum: 60, default: 12 },
        modifiers: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const from = await pointFor(args.from_ref, args.from || {});
      const to = await pointFor(args.to_ref, args.to || {});
      return json(await rpc('ui_drag', { from, to, steps: args.steps, modifiers: args.modifiers, space: 'css' }));
    },
  },
  {
    name: 'crabbycut_ui_scroll',
    description: 'Scroll the mouse wheel over a ref or x,y (screenshot pixels). dy > 0 scrolls down, dx > 0 scrolls right; ~100 per notch. modifiers e.g. ["cmd"] for zoom where the app supports it.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        dx: { type: 'number', default: 0 },
        dy: { type: 'number', default: 0 },
        modifiers: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const at = await pointFor(args.ref, args);
      return json(await rpc('ui_scroll', { ...args, ...at }));
    },
  },
  {
    name: 'crabbycut_ui_key',
    description: 'Press a key or shortcut on the app, e.g. "Space", "Delete", "Escape", "Enter", "Left", "Cmd+Z", "Cmd+Shift+Z", "Cmd+K", "Alt+[", "S". "Cmd" maps to Ctrl on Windows and ⌘ on macOS. repeat up to 50.',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'string' }, repeat: { type: 'integer', minimum: 1, maximum: 50, default: 1 } },
      required: ['keys'],
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('ui_key', args)),
  },
  {
    name: 'crabbycut_ui_type',
    description: 'Type text (Unicode, Vietnamese OK) into the focused field, or into ref (focused and its current text selected, so typing replaces it). Press Enter afterwards with crabbycut_ui_key to commit numeric fields.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, ref: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    run: async ({ text, ref }) => {
      if (ref) {
        const at = await pointFor(ref, {});
        await rpc('ui_click', { ...at });
        await rpc('ui_focus', { ref });
      }
      return json(await rpc('ui_type', { text }));
    },
  },
];

/* ref -> toạ độ CSS (renderer tự cuộn phần tử vào khung nhìn); không có ref thì x,y là toạ
 * độ ảnh chụp, để main tự đổi. */
async function pointFor(ref, { x, y } = {}) {
  if (ref) {
    const at = await rpc('ui_resolve', { ref });
    return { x: at.x, y: at.y, space: 'css', label: at.label };
  }
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new Error('Pass a ref or both x and y');
  const { css_per_pixel: k } = await rpc('ui_scale');
  return { x: Math.round(Number(x) * (k || 1)), y: Math.round(Number(y) * (k || 1)), space: 'css' };
}

function json(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/* ---- Giao thức MCP qua stdio ---- */

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case 'initialize': {
      const asked = params?.protocolVersion;
      reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Controls a running CrabbyCut video editor. Call crabbycut_status first. '
          + 'Editing tools work only in the Editing step (state.editing_ready = true). '
          + 'Prefer the feature tools (update_block, set_transition, set_color, import_media, start_job…); '
          + 'for several edits at once use crabbycut_add_media_batch (many files + keyframes/animation) or '
          + 'crabbycut_batch (any edit commands) — one call, one undo step. '
          + 'To draw graphics (buttons, lower thirds, animated badges, charts) at an exact pixel size, write code '
          + 'with crabbycut_add_geocode (HTML/CSS/JS, canvas or Python) — several blocks in ONE call via items + a shared '
          + 'template with {{vars}}; fix one later with crabbycut_update_geocode (find/replace, no need to resend the code). '
          + 'Subsequences (nested sequences): crabbycut_subsequence; crabbycut_status shows in_subsequence '
          + 'when the user is editing inside one — timeline tools then act on its content. '
          + 'Vector shapes: crabbycut_add_shape. Voice-over: crabbycut_dub (returns the timeline time of every sentence — '
          + 'time visuals to it without re-reading the timeline). These wait for their render themselves. '
          + 'look up valid ids with crabbycut_catalog. For anything without a dedicated tool, drive the UI '
          + 'like a user: crabbycut_screenshot + crabbycut_ui_snapshot, then crabbycut_ui_click / ui_type / '
          + 'ui_key / ui_drag / ui_scroll, and screenshot again to verify. Native OS dialogs (file pickers) '
          + 'cannot be clicked — use the path-based tools instead. Long tasks (subtitles, Magic Fill, export) '
          + 'run as jobs: crabbycut_start_job then crabbycut_job_status with wait_seconds. '
          + 'Every edit is undoable with crabbycut_undo.',
      });
      return;
    }
    case 'ping':
      if (isRequest) reply(id, {});
      return;
    case 'tools/list':
      reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      return;
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) { fail(id, -32602, `Unknown tool: ${params?.name}`); return; }
      try {
        reply(id, await tool.run(params.arguments || {}));
      } catch (error) {
        // Lỗi của TOOL trả về như kết quả (isError) để model đọc được và tự sửa cách gọi.
        reply(id, { content: [{ type: 'text', text: error?.message || String(error) }], isError: true });
      }
      return;
    }
    default:
      if (method?.startsWith('notifications/')) return;
      if (isRequest) fail(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = '';
// Lệnh đang chạy dở: stdin đóng thì đợi chúng trả lời xong rồi mới thoát.
const inflight = new Set();
let stdinEnded = false;
function exitIfIdle() { if (stdinEnded && inflight.size === 0) process.exit(0); }
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch (_) { fail(null, -32700, 'Parse error'); continue; }
    const task = handle(message).catch((error) => {
      if (message.id !== undefined) fail(message.id, -32603, error?.message || String(error));
    }).finally(() => { inflight.delete(task); exitIfIdle(); });
    inflight.add(task);
  }
});
process.stdin.on('end', () => { stdinEnded = true; exitIfIdle(); });
