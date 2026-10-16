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

const SERVER_INFO = { name: 'crabbycut', version: '0.1.0' };
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const HTTP_TIMEOUT_MS = 35_000;

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

function rpc(method, params) {
  const bridge = pickBridge();
  const body = JSON.stringify({ method, params: params || {} });
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
      timeout: HTTP_TIMEOUT_MS,
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

const TOOLS = [
  {
    name: 'crabbycut_status',
    description: 'Check the connection to the running CrabbyCut app and return a short project state: step, mode, project path/name, unsaved flag, duration, playhead, playing, clip counts, undo/redo depth. Call this first.',
    inputSchema: NO_ARGS,
    run: async () => {
      const ping = await rpc('ping');
      const state = await rpc('get_state');
      return json({ app: ping, instances: listBridges().map(describe), state });
    },
  },
  {
    name: 'crabbycut_get_timeline',
    description: 'Return the timeline: main-lane clips (index, timeline_start/end in sequence seconds, source start/end, text) and, optionally, overlay tracks and items (text/media/audio blocks with id, track_id, timeline_start, duration). Times are in seconds.',
    inputSchema: {
      type: 'object',
      properties: { include_overlays: { type: 'boolean', default: true } },
      additionalProperties: false,
    },
    run: async (args) => json(await rpc('get_timeline', args)),
  },
  {
    name: 'crabbycut_screenshot',
    description: 'Capture the CrabbyCut window as an image to see the preview, timeline and panels.',
    inputSchema: NO_ARGS,
    run: async () => {
      const shot = await rpc('screenshot');
      return { content: [{ type: 'image', data: shot.data, mimeType: shot.mimeType }] };
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
    description: 'Editing step only. Add a text block on an overlay track. start defaults to the playhead, duration to 5 s. Undoable.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1 },
        start: { type: 'number', minimum: 0 },
        duration: { type: 'number', exclusiveMinimum: 0 },
        track_id: { type: 'string' },
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
];

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
          + 'Every edit is undoable with crabbycut_undo. Use crabbycut_screenshot to verify visually.',
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
