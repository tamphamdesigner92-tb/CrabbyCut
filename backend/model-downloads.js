// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* SỔ CÁC LƯỢT TẢI MODEL AI — nguồn dữ liệu của thanh tiến trình ở GÓC TRÁI THANH TRẠNG THÁI.
 *
 * Yêu cầu của người dùng (2026-09-27): MỌI model AI tải về lần đầu phải có thông báo kèm thanh
 * tiến trình ở thanh trạng thái. Trước đó mỗi tính năng tự lo (hoặc không lo): cài Whisper chỉ
 * có một câu "Đang setup model…" đứng im cả chục phút.
 *
 * Mỗi nơi tải (sidecar ASR, server TTS, cài gói lồng tiếng) chỉ việc báo vào đây:
 *     begin(id, { label, kind })  ->  update(id, { downloaded, total })  ->  end(id, { error })
 * Giao diện đọc qua GET /api/model-downloads (static/js/model-download-status.js). Lượt đã xong
 * được giữ thêm KEEP_DONE_MS để người dùng kịp thấy "đã tải xong" thay vì thanh biến mất cụt.
 *
 * Không có số byte (tải không biết tổng) -> `total` = 0, giao diện vẽ thanh chạy vô định.
 */
'use strict';

const KEEP_DONE_MS = 4000;
const KEEP_ERROR_MS = 15000;

const entries = new Map();

function now() { return Date.now(); }

function begin(id, info = {}) {
  const prev = entries.get(id);
  const entry = {
    id,
    label: info.label || prev?.label || id,
    kind: info.kind || prev?.kind || 'model',     // model | packages
    state: 'downloading',
    downloaded: Number(info.downloaded) || 0,
    total: Number(info.total) || 0,
    message: info.message || '',
    started_at: prev && prev.state === 'downloading' ? prev.started_at : now(),
    updated_at: now(),
    finished_at: null,
    error: '',
  };
  entries.set(id, entry);
  return entry;
}

function update(id, values = {}) {
  const entry = entries.get(id) || begin(id, values);
  if (values.label) entry.label = values.label;
  if (values.message !== undefined) entry.message = values.message;
  if (Number.isFinite(Number(values.total)) && Number(values.total) > 0) entry.total = Number(values.total);
  if (Number.isFinite(Number(values.downloaded))) {
    entry.downloaded = Math.max(0, Number(values.downloaded));
    if (entry.total) entry.downloaded = Math.min(entry.total, entry.downloaded);
  }
  entry.state = 'downloading';
  entry.updated_at = now();
  return entry;
}

function end(id, { error } = {}) {
  const entry = entries.get(id);
  if (!entry) return null;
  entry.state = error ? 'error' : 'done';
  entry.error = error ? String(error) : '';
  if (!error && entry.total) entry.downloaded = entry.total;
  entry.finished_at = now();
  entry.updated_at = entry.finished_at;
  return entry;
}

/* Đồng bộ từ một nguồn báo theo KIỂU ẢNH CHỤP (server TTS trả cả danh sách mỗi lần hỏi). */
function syncSnapshot(items = []) {
  for (const item of items) {
    if (!item || !item.id) continue;
    const state = String(item.state || '');
    if (state === 'preparing' || state === 'downloading') {
      if (!entries.has(item.id) || entries.get(item.id).state !== 'downloading') begin(item.id, item);
      update(item.id, item);
    } else if ((state === 'done' || state === 'error') && entries.get(item.id)?.state === 'downloading') {
      update(item.id, item);
      end(item.id, { error: state === 'error' ? (item.error || 'error') : '' });
    }
  }
}

function list() {
  const t = now();
  for (const [id, entry] of entries) {
    const keep = entry.state === 'error' ? KEEP_ERROR_MS : KEEP_DONE_MS;
    if (entry.finished_at && t - entry.finished_at > keep) entries.delete(id);
  }
  return Array.from(entries.values()).map((entry) => ({ ...entry }));
}

function activeCount() {
  let n = 0;
  for (const entry of entries.values()) if (entry.state === 'downloading') n += 1;
  return n;
}

function reset() { entries.clear(); }

module.exports = { begin, update, end, syncSnapshot, list, activeCount, reset, KEEP_DONE_MS };
