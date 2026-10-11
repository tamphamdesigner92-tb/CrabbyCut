// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

/* HỒ SƠ GIỌNG (v1.1.17) — giọng mẫu để nhân bản (clone) trong "Lồng tiếng".
 *
 * Người dùng tạo trong Cài đặt → Hồ sơ giọng: đặt tên, chọn một tệp âm thanh có giọng người cần
 * nhân bản (3-10 giây, một người nói, không nhạc nền), tuỳ chọn gõ lời nói trong mẫu (engine nào
 * cần thì dùng — VieNeu v3 không cần). Panel Lồng tiếng chọn hồ sơ theo TÊN thay vì phải trỏ tới
 * tệp mỗi lần.
 *
 * CHỖ LƯU (người dùng chốt 2026-10-11): `<USER_DATA_ROOT>/voice_profiles/` — bản cài là
 * `%LOCALAPPDATA%\CrabbyCut\voice_profiles` (macOS: ~/Library/Application Support/CrabbyCut/…),
 * cạnh `settings/` và `tts_models/`. Thư mục cài đặt bị xoá sạch mỗi lần nâng cấp, còn chỗ này thì
 * không; bộ gỡ cài chỉ hỏi xoá `runtime/` (build/installer.nsh). Chạy từ mã nguồn thì
 * USER_DATA_ROOT là thư mục dự án (như settings/). Test trỏ đi chỗ khác bằng CRAB_VOICE_PROFILES_DIR.
 *
 * MỖI HỒ SƠ MỘT THƯ MỤC  `<id>/profile.json` + `<id>/reference.wav`
 *   · Tệp gốc được CHÉP + chuẩn hoá (WAV mono 44,1 kHz, cắt tối đa MAX_SECONDS) — không giữ đường
 *     dẫn tới tệp gốc: người dùng xoá/đổi tên tệp gốc thì hồ sơ vẫn chạy.
 *   · id không đổi khi đổi tên hồ sơ, nên prefs của panel (lưu id) không gãy.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PROFILE_FILE = 'profile.json';
const AUDIO_FILE = 'reference.wav';
const MAX_SECONDS = 20;
const MAX_NAME = 60;
const MAX_TEXT = 1000;
const SAMPLE_RATE = 44100;
const ID_RE = /^vp_[a-z0-9]{6,32}$/;

function createVoiceProfiles({ rootDir, ffmpeg = 'ffmpeg' } = {}) {
  const root = () => path.resolve(process.env.CRAB_VOICE_PROFILES_DIR || rootDir);

  function dirOf(id) {
    if (!ID_RE.test(String(id || ''))) {
      const error = new Error('Mã hồ sơ giọng không hợp lệ.');
      error.status = 400;
      throw error;
    }
    return path.join(root(), id);
  }

  function notFound() {
    const error = new Error('Không tìm thấy hồ sơ giọng này (có thể đã bị xoá).');
    error.status = 404;
    return error;
  }

  function badInput(message) {
    const error = new Error(message);
    error.status = 400;
    return error;
  }

  function cleanName(value) {
    const name = String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    if (!name) throw badInput('Hãy đặt tên cho hồ sơ giọng.');
    return name;
  }

  function cleanText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  }

  function wavSeconds(file) {
    try {
      // WAV PCM 16-bit mono do chính ffmpeg ghi: 44 byte đầu + 2 byte/mẫu.
      return Math.max(0, (fs.statSync(file).size - 44) / (SAMPLE_RATE * 2));
    } catch (_) {
      return 0;
    }
  }

  function readProfile(id) {
    const dir = dirOf(id);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(dir, PROFILE_FILE), 'utf8'));
    } catch (_) {
      return null;
    }
    const audio = path.join(dir, AUDIO_FILE);
    return {
      id,
      name: String(data.name || id),
      ref_text: String(data.ref_text || ''),
      source_name: String(data.source_name || ''),
      created_at: String(data.created_at || ''),
      updated_at: String(data.updated_at || data.created_at || ''),
      duration: Math.round(wavSeconds(audio) * 100) / 100,
      audio_ok: fs.existsSync(audio),
      dir,
    };
  }

  function writeProfile(id, data) {
    const dir = dirOf(id);
    const file = path.join(dir, PROFILE_FILE);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);   // ghi nguyên tử: tắt máy giữa chừng không để lại JSON cụt
  }

  function list() {
    let names = [];
    try { names = fs.readdirSync(root()); } catch (_) { return []; }
    return names
      .filter((name) => ID_RE.test(name))
      .map((id) => readProfile(id))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  }

  function get(id) {
    const profile = readProfile(id);
    if (!profile) throw notFound();
    return profile;
  }

  function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpeg, args, { windowsHide: true });
      let err = '';
      proc.stderr.on('data', (chunk) => { err = (err + chunk.toString('utf8')).slice(-2000); });
      proc.on('error', reject);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split(/\r?\n/).slice(-3).join(' ') || `ffmpeg thoát mã ${code}`))));
    });
  }

  async function create({ name, source_path: sourcePath, ref_text: refText } = {}) {
    const cleanedName = cleanName(name);
    const source = path.resolve(String(sourcePath || ''));
    if (!sourcePath || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
      throw badInput('Chọn một tệp âm thanh có giọng mẫu.');
    }
    const id = `vp_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    const dir = dirOf(id);
    fs.mkdirSync(dir, { recursive: true });
    const audio = path.join(dir, AUDIO_FILE);
    try {
      // Chỉ lấy luồng âm thanh (nhận cả video), mono 44,1 kHz PCM 16-bit, tối đa MAX_SECONDS.
      await runFfmpeg(['-hide_banner', '-v', 'error', '-y', '-i', source, '-vn', '-ac', '1',
        '-ar', String(SAMPLE_RATE), '-t', String(MAX_SECONDS), '-c:a', 'pcm_s16le', audio]);
      const seconds = wavSeconds(audio);
      if (seconds < 1) throw badInput('Tệp này không có đủ âm thanh để làm giọng mẫu (cần ít nhất 3 giây).');
      const now = new Date().toISOString();
      writeProfile(id, {
        id, name: cleanedName, ref_text: cleanText(refText), source_name: path.basename(source),
        created_at: now, updated_at: now,
      });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!error.status) {
        const wrapped = new Error(`Không đọc được âm thanh từ tệp này: ${error.message}`);
        wrapped.status = 400;
        throw wrapped;
      }
      throw error;
    }
    return get(id);
  }

  function update(id, patch = {}) {
    const current = get(id);
    const data = JSON.parse(fs.readFileSync(path.join(current.dir, PROFILE_FILE), 'utf8'));
    if (patch.name !== undefined) data.name = cleanName(patch.name);
    if (patch.ref_text !== undefined) data.ref_text = cleanText(patch.ref_text);
    data.updated_at = new Date().toISOString();
    writeProfile(id, data);
    return get(id);
  }

  function remove(id) {
    const dir = dirOf(id);
    if (!fs.existsSync(path.join(dir, PROFILE_FILE))) throw notFound();
    fs.rmSync(dir, { recursive: true, force: true });
    return { removed: id };
  }

  /* Cho lượt lồng tiếng: id -> đường dẫn giọng mẫu + lời mẫu. */
  function resolveForDubbing(id) {
    const profile = get(id);
    if (!profile.audio_ok) throw notFound();
    return { ref_audio: path.join(profile.dir, AUDIO_FILE), ref_text: profile.ref_text, name: profile.name };
  }

  function audioPath(id) {
    const file = path.join(dirOf(id), AUDIO_FILE);
    if (!fs.existsSync(file)) throw notFound();
    return file;
  }

  return { root, list, get, create, update, remove, resolveForDubbing, audioPath, MAX_SECONDS };
}

module.exports = { createVoiceProfiles };
