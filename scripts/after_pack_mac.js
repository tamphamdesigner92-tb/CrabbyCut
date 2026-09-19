#!/usr/bin/env node
/* KÝ AD-HOC BẢN ĐÓNG GÓI macOS KHI MÁY DỰNG KHÔNG CÓ CHỨNG CHỈ APPLE.
 *
 * VÌ SAO CẦN: trên Apple Silicon, nhân macOS TỪ CHỐI CHẠY mọi mã không có chữ ký hợp lệ.
 * electron-builder chép tệp của ta vào trong Electron.app — làm hỏng con dấu tài nguyên của
 * chữ ký gốc — rồi BỎ QUA bước ký vì không tìm thấy "Developer ID Application". Kết quả là
 * một bản .app mở lên bị giết ngay bằng SIGKILL (thoát 137), KHÔNG một dòng lỗi nào trong
 * log ứng dụng. Đây đúng là căn bệnh mà scripts/fix_electron_signature.js chữa cho bản
 * Electron trong node_modules; bản đóng gói cần liều thuốc y hệt.
 *
 * VÌ SAO LÀ `afterPack` CHỨ KHÔNG PHẢI `afterSign`: electron-builder chỉ gọi `afterSign` khi
 * đã thực sự ký được (xem platformPackager.js — nó còn in hẳn cảnh báo "skipping afterSign
 * hook as no signing occurred, perhaps you intended afterPack?"). Mà trường hợp ta cần can
 * thiệp CHÍNH LÀ lúc không ký được, nên `afterSign` sẽ không bao giờ chạy.
 *
 * VÌ SAO AN TOÀN KHI SAU NÀY CÓ CHỨNG CHỈ THẬT: `afterPack` chạy TRƯỚC `signApp`. Có chứng
 * chỉ thì script này tự đứng ngoài, và dù có ký thì chữ ký ad-hoc cũng bị bước ký thật ghi
 * đè ngay sau đó. Không có đường nào để nó phá hỏng một bản phát hành đã ký đúng.
 *
 * CHỮ KÝ AD-HOC KHÔNG THAY THẾ ĐƯỢC CHỮ KÝ THẬT. Nó chỉ đủ để app chạy TRÊN CHÍNH MÁY DỰNG.
 * Bản .dmg gửi cho người khác vẫn bị Gatekeeper chặn ("ứng dụng bị hỏng") vì tệp tải về mang
 * cờ quarantine. Muốn gửi được cho người dùng thì phải có Developer ID + notarize.
 */
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

/* Máy đã có chứng chỉ phát hành chưa? Có thì KHÔNG đụng vào — để electron-builder ký thật. */
function hasDeveloperId() {
  try {
    const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
    return /Developer ID Application/.test(out);
  } catch (_) {
    return false;
  }
}

function sign(target, extraArgs = []) {
  execFileSync('codesign', ['--force', '--sign', '-', ...extraArgs, target], { stdio: 'inherit' });
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  if (hasDeveloperId()) {
    console.log('[afterPack] có Developer ID — nhường bước ký cho electron-builder.');
    return;
  }

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`[afterPack] không có Developer ID — ký ad-hoc: ${path.basename(appPath)}`);

  /* Xoá quarantine/provenance trước khi ký. Còn xattr thì codesign vẫn chạy nhưng macOS lại
   * đánh giá app theo đường Gatekeeper và chặn tiếp — sạch xattr rồi mới ký thì dứt điểm. */
  execFileSync('xattr', ['-cr', appPath], { stdio: 'inherit' });

  /* Ký hai nhị phân native TRƯỚC. `--deep` niêm phong chúng như TÀI NGUYÊN chứ không ký
   * riêng, mà core_c.node là dylib do Node nạp lúc chạy — thiếu chữ ký của chính nó thì
   * Library Validation chặn nạp ("library load denied by system policy"). */
  const nested = [
    path.join(appPath, 'Contents/Resources/app/native/addon/build/Release/core_c.node'),
    path.join(appPath, 'Contents/Resources/app/native/sidecar/build/core_process'),
  ];
  for (const binary of nested) {
    try {
      sign(binary);
    } catch (error) {
      console.warn(`[afterPack] cảnh báo: không ký được ${path.basename(binary)} — ${error.message}`);
    }
  }

  // Rồi mới ký toàn bộ bundle. `--deep` lo các framework và tiến trình Helper của Electron.
  sign(appPath, ['--deep']);

  /* KIỂM LẠI NGAY. Một chữ ký hỏng không báo lỗi lúc ký — nó báo bằng SIGKILL lúc mở app,
   * tức là sau khi đã nén xong .dmg 400 MB. Bắt ở đây rẻ hơn nhiều. */
  execFileSync('codesign', ['--verify', '--strict', appPath], { stdio: 'inherit' });
  console.log('[afterPack] ký ad-hoc xong, chữ ký hợp lệ.');
};
