#!/usr/bin/env node
/* SINH build/icon.icns TỪ build/icon.ico — chạy trên máy DỰNG (macOS), trước electron-builder.
 *
 * VÌ SAO CẦN MỘT TỆP RIÊNG THAY VÌ ĐƯA THẲNG .ico CHO electron-builder: macOS không đọc
 * định dạng .ico. electron-builder chấp nhận một tấm PNG và tự dựng .icns, nhưng NÓ ĐÒI
 * TỐI THIỂU 512×512 — mà tấm lớn nhất trong icon.ico chỉ có 256×256, nên bước dựng sẽ chết
 * với "image must be at least 512x512". Tự dựng .icns ở đây thì ta kiểm soát được phép
 * phóng to và app có đủ mọi cỡ Retina mà Finder/Dock cần.
 *
 * VÌ SAO KHÔNG GIỮ MỘT TỆP .icns DỰNG SẴN RỒI THÔI: icon.ico là bản gốc duy nhất đang được
 * theo dõi trong git. Đổi logo mà quên dựng lại .icns thì bản Windows và bản macOS mang hai
 * logo khác nhau — một lỗi không ai phát hiện cho tới khi người dùng nhìn thấy. Một lệnh
 * `npm run icon:mac` sinh lại từ đúng cái gốc đó.
 *
 * GIỚI HẠN ĐÃ BIẾT: bản gốc 256×256 nên hai cỡ lớn nhất (512 và 1024) là ẢNH PHÓNG TO, nhìn
 * hơi mềm ở cỡ xem trước lớn trong Finder. Khi nào có tệp logo gốc ≥1024×1024, đặt nó vào
 * build/icon-master.png — script tự ưu tiên dùng bản đó và hết mềm.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD_DIR = path.join(ROOT, 'build');
const MASTER_PNG = path.join(BUILD_DIR, 'icon-master.png');
const SOURCE_ICO = path.join(BUILD_DIR, 'icon.ico');
const OUTPUT = path.join(BUILD_DIR, 'icon.icns');

/* Bộ cỡ BẮT BUỘC của một iconset hợp lệ. Thiếu một dòng thì `iconutil` vẫn chạy nhưng macOS
 * rơi về cỡ gần nhất và icon bị răng cưa ở đúng chỗ đó (thường là Dock ở màn Retina). */
const SIZES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${cmd} lỗi: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function main() {
  if (process.platform !== 'darwin') {
    /* KHÔNG ném lỗi: script này nằm trong `dist:mac`, mà `dist:mac` chỉ chạy trên macOS.
     * Nhưng nó cũng bị gọi gián tiếp khi ai đó chạy `npm run icon:mac` trên Windows để xem
     * thử — báo rồi thoát êm thì dễ hiểu hơn là một stack trace. */
    console.log('[icon] bỏ qua: chỉ dựng được .icns trên macOS (cần sips + iconutil).');
    return;
  }

  // Ưu tiên bản gốc độ phân giải cao nếu có; nếu không thì bóc tấm lớn nhất từ .ico.
  const hasMaster = fs.existsSync(MASTER_PNG);
  if (!hasMaster && !fs.existsSync(SOURCE_ICO)) {
    throw new Error(`Không thấy ${path.relative(ROOT, MASTER_PNG)} lẫn ${path.relative(ROOT, SOURCE_ICO)}.`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crabbycut-icon-'));
  const iconset = path.join(work, 'icon.iconset');
  fs.mkdirSync(iconset);

  try {
    let source;
    if (hasMaster) {
      source = MASTER_PNG;
      console.log(`[icon] nguồn: ${path.relative(ROOT, MASTER_PNG)}`);
    } else {
      source = path.join(work, 'base.png');
      run('sips', ['-s', 'format', 'png', SOURCE_ICO, '--out', source]);
      console.log(`[icon] nguồn: ${path.relative(ROOT, SOURCE_ICO)} (bóc ra PNG)`);
    }

    for (const [name, size] of SIZES) {
      /* `-z H W` ép ĐÚNG cỡ, khác `--resampleWidth` là giữ tỉ lệ. Icon luôn vuông nên hai
       * cách cho cùng kết quả, nhưng ép cỡ thì một tấm gốc lỡ méo cũng không làm hỏng
       * iconset (iconutil từ chối iconset có tấm sai kích thước). */
      run('sips', ['-z', String(size), String(size), source, '--out', path.join(iconset, name)]);
    }

    run('iconutil', ['-c', 'icns', iconset, '-o', OUTPUT]);
    const { size } = fs.statSync(OUTPUT);
    console.log(`[icon] xong ${path.relative(ROOT, OUTPUT)} (${(size / 1024).toFixed(0)} KB, ${SIZES.length} cỡ)`);
    if (!hasMaster) {
      console.log('[icon] LƯU Ý: gốc chỉ 256×256 nên cỡ 512/1024 là ảnh phóng to.');
      console.log('[icon]        Có logo ≥1024×1024 thì đặt vào build/icon-master.png rồi chạy lại.');
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[icon] LỖI: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { main, SIZES };
