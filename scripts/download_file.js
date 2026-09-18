#!/usr/bin/env node
/* TẢI MỘT FILE QUA HTTPS — NGUỒN SỰ THẬT DUY NHẤT.
 *
 * Dùng ở HAI đường hoàn toàn khác nhau, nên phải tách ra khỏi cả hai:
 *   - scripts/prepare_installer_assets.js  (lúc DỰNG bộ cài, trên máy phát triển)
 *   - scripts/setup_runtime.js             (lúc CÀI, trên máy người dùng)
 * Chép tay thành hai bản là chắc chắn có ngày một bản thiếu phần đi theo redirect hoặc
 * phần ghi file tạm — và cả hai lỗi đó đều chỉ lộ ra rất muộn, dưới dạng một file hỏng.
 */
'use strict';
const fs = require('fs');
const https = require('https');

/* GHI RA FILE TẠM RỒI MỚI ĐỔI TÊN.
 * Ghi thẳng vào tên đích thì một lần tải đứt mạng để lại file cụt, và lần chạy sau
 * `fs.existsSync` thấy "đã có" rồi dùng luôn file hỏng đó — kiểu lỗi chỉ hiện ra lúc giải
 * nén, với thông báo không liên quan gì tới mạng.
 *
 * TỰ ĐI THEO REDIRECT: python.org, GitHub Releases và aka.ms đều trả 302.
 */
function downloadFile(url, destPath, onProgress, redirectsLeft = 6) {
  return new Promise((resolve, reject) => {
    const tmpPath = `${destPath}.part`;
    const request = https.get(url, {
      headers: { 'User-Agent': 'CrabbyCut-Setup' },
      timeout: 60_000,
    }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) { reject(new Error(`Quá nhiều lần chuyển hướng: ${url}`)); return; }
        const next = new URL(response.headers.location, url).toString();
        downloadFile(next, destPath, onProgress, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Tải thất bại (HTTP ${status}): ${url}`));
        return;
      }
      const total = Number(response.headers['content-length']) || 0;
      let received = 0;
      const file = fs.createWriteStream(tmpPath);
      response.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      response.pipe(file);
      file.on('error', reject);
      file.on('finish', () => {
        file.close(() => {
          try {
            fs.renameSync(tmpPath, destPath);
            resolve(destPath);
          } catch (error) { reject(error); }
        });
      });
    });

    /* Thông báo phải nêu ĐÍCH DANH URL. Các bên gọi lấy đồ từ bốn nguồn khác nhau
     * (python.org, PyPI, GitHub, download.pytorch.org) và mạng công ty thường chỉ chặn MỘT
     * trong số đó — "lỗi mạng" chung chung thì không ai biết phải mở đường cho cái gì.
     *
     * KHÔNG hỗ trợ proxy: Node không tự đọc HTTPS_PROXY cho `https.get`. Nêu proxy trong
     * thông báo để người gặp hiểu vì sao. */
    const netError = (error) => reject(new Error(
      `Không tải được ${url}\n(${error?.message || error})\n`
      + 'Kiểm tra kết nối mạng, tường lửa hoặc proxy của công ty đối với địa chỉ trên.',
    ));
    request.on('timeout', () => { request.destroy(new Error('hết thời gian chờ sau 60 giây')); });
    request.on('error', netError);
  });
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

module.exports = { downloadFile, humanBytes };
