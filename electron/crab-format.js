// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Tam Pham <tampham.designer92@gmail.com>

// Định dạng tệp dự án .crab:
// [0..8) magic "CRABPRJ\0" | [8..10) version uint16 LE | [10..12) reserved
// [12..44) SHA-256 của phần gzip | [44..) gzip(JSON payload)
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

const CRAB_MAGIC = Buffer.from('CRABPRJ\0', 'ascii');
const CRAB_FORMAT_VERSION = 1;
const CRAB_HEADER_SIZE = 44;

function writeCrabFile(targetPath, payloadJson) {
  const gzipped = zlib.gzipSync(Buffer.from(payloadJson, 'utf8'));
  const checksum = crypto.createHash('sha256').update(gzipped).digest();
  const header = Buffer.alloc(CRAB_HEADER_SIZE);
  CRAB_MAGIC.copy(header, 0);
  header.writeUInt16LE(CRAB_FORMAT_VERSION, 8);
  header.writeUInt16LE(0, 10);
  checksum.copy(header, 12);
  const tmpPath = `${targetPath}.tmp`;
  fs.writeFileSync(tmpPath, Buffer.concat([header, gzipped]));
  fs.renameSync(tmpPath, targetPath);
  return fs.statSync(targetPath).size;
}

function readCrabFile(filePath) {
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    return { error: 'read_failed', detail: String(error?.message || error) };
  }
  if (buffer.length < CRAB_HEADER_SIZE || !buffer.subarray(0, 8).equals(CRAB_MAGIC)) {
    return { error: 'corrupt' };
  }
  const version = buffer.readUInt16LE(8);
  if (version > CRAB_FORMAT_VERSION) {
    return { error: 'unsupported_version', version };
  }
  const storedChecksum = buffer.subarray(12, 44);
  const gzipped = buffer.subarray(CRAB_HEADER_SIZE);
  const actualChecksum = crypto.createHash('sha256').update(gzipped).digest();
  if (!storedChecksum.equals(actualChecksum)) {
    return { error: 'corrupt' };
  }
  let payloadJson;
  try {
    payloadJson = zlib.gunzipSync(gzipped).toString('utf8');
  } catch {
    return { error: 'corrupt' };
  }
  return { path: filePath, payloadJson };
}

// Fingerprint nhanh cho file media lớn: sha256(64KB đầu + 64KB cuối + size).
function fingerprintFile(filePath, stat) {
  const CHUNK = 64 * 1024;
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(Math.min(CHUNK, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    hash.update(head);
    if (stat.size > CHUNK) {
      const tail = Buffer.alloc(Math.min(CHUNK, stat.size - CHUNK));
      fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length);
      hash.update(tail);
    }
  } finally {
    fs.closeSync(fd);
  }
  hash.update(String(stat.size));
  return hash.digest('hex');
}

module.exports = {
  CRAB_FORMAT_VERSION,
  CRAB_HEADER_SIZE,
  writeCrabFile,
  readCrabFile,
  fingerprintFile,
};
