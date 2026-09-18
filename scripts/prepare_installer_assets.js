#!/usr/bin/env node
/* KÉO CÁC TỆP ĐƯỢC NHÚNG THẲNG VÀO BỘ CÀI — chạy trên máy DỰNG, trước electron-builder.
 *
 * VÌ SAO NHÚNG THAY VÌ ĐỂ MÁY NGƯỜI DÙNG TỰ TẢI: gói Python nhúng chỉ 11 MB, nhưng nó đến
 * từ python.org — nguồn CHẬM NHẤT trong toàn bộ luồng cài (đo trên máy thật: lúc 2,5 MB/s,
 * lúc 50 KB/s, tức 11 MB mất tới ~4 phút). Nhét 13 MB vào một bộ cài vốn đã ~210 MB thì gần
 * như không ai để ý, đổi lại bước "Cài đặt Python" chạy trong vài giây và KHÔNG còn phụ
 * thuộc vào mạng nữa.
 *
 * CỐ Ý KHÔNG THEO DÕI `vendor/` TRONG GIT: đây là nhị phân của bên thứ ba, tải lại được bất
 * cứ lúc nào từ một URL cố định. Đưa vào git là làm phình repo vĩnh viễn với thứ không phải
 * mã nguồn của dự án.
 *
 * FFMPEG CỐ Ý KHÔNG NHÚNG. Nó nặng ~180 MB — gần bằng toàn bộ phần còn lại của bộ cài — mà
 * phần lớn máy dựng phim đã có sẵn, và `detect_machine.js` dùng lại được bản có sẵn khi bản
 * đó đủ filter. Muốn nhúng thì thêm một mục vào ASSETS dưới đây; `stageFfmpeg()` đã biết
 * cách ưu tiên tệp nhúng rồi.
 */
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const { downloadFile, humanBytes } = require('./download_file.js');
const { PYTHON_VERSION, VENDOR_DIR, vendorAsset } = require('./vendor_assets.js');

const ASSETS = [
  {
    file: vendorAsset('python'),
    url: `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`,
    label: `Python ${PYTHON_VERSION} (bản nhúng, Windows x64)`,
    /* Kích thước tối thiểu để bắt file cụt/trang lỗi HTML mà server trả về với mã 200.
     * KHÔNG ghim SHA-256: python.org không phát hành lại cùng một phiên bản, nhưng ghim
     * hash thì mỗi lần nâng PYTHON_VERSION lại phải cập nhật tay một chuỗi 64 ký tự, và
     * quên cập nhật thì bước dựng chết với một thông báo không nói lên điều gì. */
    minBytes: 8 * 1024 * 1024,
  },
  {
    file: vendorAsset('getPip'),
    url: 'https://bootstrap.pypa.io/get-pip.py',
    label: 'get-pip',
    minBytes: 1024 * 1024,
  },
];

async function ensureAsset(asset) {
  const dest = path.join(VENDOR_DIR, asset.file);
  if (fs.existsSync(dest)) {
    const { size } = await fsp.stat(dest);
    if (size >= asset.minBytes) {
      console.log(`[assets] đã có ${asset.file} (${humanBytes(size)})`);
      return;
    }
    console.log(`[assets] ${asset.file} quá nhỏ (${humanBytes(size)}) — tải lại.`);
    await fsp.rm(dest, { force: true });
  }

  console.log(`[assets] tải ${asset.label}`);
  let lastTick = 0;
  await downloadFile(asset.url, dest, (received, total) => {
    const now = Date.now();
    if (now - lastTick < 500 && received !== total) return;
    lastTick = now;
    process.stdout.write(`\r  ${humanBytes(received)}${total ? ` / ${humanBytes(total)}` : ''}   `);
  });
  process.stdout.write('\n');

  const { size } = await fsp.stat(dest);
  if (size < asset.minBytes) {
    await fsp.rm(dest, { force: true });
    throw new Error(`${asset.file} tải về chỉ ${humanBytes(size)} — nguồn trả về nội dung sai.`);
  }
  const sha = crypto.createHash('sha256').update(await fsp.readFile(dest)).digest('hex');
  console.log(`[assets] xong ${asset.file} (${humanBytes(size)}, sha256 ${sha.slice(0, 16)}…)`);
}

async function main() {
  await fsp.mkdir(VENDOR_DIR, { recursive: true });
  for (const asset of ASSETS) await ensureAsset(asset);
  console.log('[assets] Tài nguyên nhúng vào bộ cài đã sẵn sàng.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[assets] LỖI: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main, ASSETS };
