/* =====================================================================
 * CỔNG BACKEND & CHỮ KÝ NHẬN DẠNG
 *
 * VÌ SAO CÓ TEST NÀY — hai lỗi cùng một gốc, cả hai đều KHÔNG báo gì khi hỏng:
 *   1. Cổng khai ở HAI file (backend/server.js và electron/main.js). Lệch nhau là Electron
 *      dò một cổng còn sidecar nghe cổng khác -> health-check timeout 30s rồi hiện hộp
 *      "Không thể khởi động backend", trong khi backend vẫn chạy ngon lành.
 *   2. `checkBackendHealth()` bản cũ nhận mọi mã 200..499 nên một tiến trình lạ giữ cổng
 *      (đo được: "Dynamic AI Learning Hub" chạy `python backend.py`, trả 404 cho
 *      /api/status) bị coi là backend của mình -> CrabbyCut nạp giao diện của app kia.
 *      Chữ ký `app:'crabbycut'` là thứ chặn chuyện đó, và nó phải có ở CẢ hai đầu.
 *
 * CÁCH ĐO: dựng backend thật trên một cổng riêng rồi gọi /api/status; phần hằng số thì
 * đọc thẳng nguồn (hợp đồng giữa hai file, không cần chạy Electron).
 * ================================================================== */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const EXPECTED_PORT = 17219;

// ---- 1) Hằng số cổng phải KHỚP nhau ở cả hai file -------------------------
const serverSrc = fs.readFileSync(path.join(projectRoot, 'backend', 'server.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(projectRoot, 'electron', 'main.js'), 'utf8');

const serverPort = /const DEFAULT_BACKEND_PORT = (\d+);/.exec(serverSrc);
assert.ok(serverPort, 'không tìm thấy DEFAULT_BACKEND_PORT trong backend/server.js');
assert.strictEqual(Number(serverPort[1]), EXPECTED_PORT,
    `backend/server.js phải mặc định cổng ${EXPECTED_PORT}`);

const mainPort = /const BACKEND_PORT = Number\(process\.env\.BACKEND_PORT \|\| (\d+)\);/.exec(mainSrc);
assert.ok(mainPort, 'không tìm thấy BACKEND_PORT trong electron/main.js');
assert.strictEqual(Number(mainPort[1]), EXPECTED_PORT,
    'electron/main.js phải dùng CÙNG cổng mặc định với backend/server.js');

/* 8000 không được quay lại: nó là cổng mặc định của python -m http.server, Django,
   FastAPI/uvicorn… — chính chỗ đã đụng app khác trên máy dev. */
assert.ok(!/BACKEND_PORT \|\| 8000/.test(serverSrc + mainSrc),
    'cổng 8000 đã bị bỏ vì hay đụng app khác — đừng đặt lại làm mặc định');

// Cửa hậu BACKEND_PORT phải còn: đụng cổng lần nữa thì người dùng tự đổi được, không phải sửa mã.
assert.ok(/process\.env\.BACKEND_PORT/.test(serverSrc) && /process\.env\.BACKEND_PORT/.test(mainSrc),
    'cả hai file phải nhường biến môi trường BACKEND_PORT');

// Cổng nằm ngoài dải cổng động của Windows (bắt đầu 49152) — nếu không, hệ điều hành có
// thể đã mượn tạm đúng cổng đó cho một kết nối ra ngoài và backend không bind được.
assert.ok(EXPECTED_PORT > 1024 && EXPECTED_PORT < 49152,
    'cổng phải nằm trong khoảng 1025..49151');

// ---- 2) checkBackendHealth phải ĐỌC BODY, không chỉ xem mã HTTP -----------
const healthFn = mainSrc.slice(mainSrc.indexOf('function checkBackendHealth('),
    mainSrc.indexOf('function startBackendSidecar('));
assert.ok(healthFn.includes("'crabbycut'"),
    'checkBackendHealth() phải kiểm CHỮ KÝ app:"crabbycut" — chỉ xem mã HTTP thì một tiến '
    + 'trình lạ giữ cổng sẽ bị nhận làm backend của mình');
assert.ok(!/statusCode >= 200 && res\.statusCode < 500/.test(healthFn),
    'không được nhận mã 4xx là "backend đã sống" (app lạ trả 404 cho /api/status)');

// ---- 3) /api/status thật sự trả chữ ký ------------------------------------
process.env.BACKEND_PORT = process.env.BACKEND_PORT || '17777';
const port = Number(process.env.BACKEND_PORT);
const { start } = require(path.join(projectRoot, 'backend', 'server.js'));

async function main() {
    const server = start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/status`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.app, 'crabbycut', '/api/status phải mang chữ ký app');
        assert.strictEqual(body.port, port, 'chữ ký phải nói đúng cổng đang nghe');
        assert.strictEqual(typeof body.pid, 'number');
        // `message` là hợp đồng cũ (backend_smoke.js và các chỗ đọc progress.txt) — không được mất.
        assert.strictEqual(typeof body.message, 'string',
            '/api/status vẫn phải trả `message` như trước, chữ ký chỉ là trường cộng thêm');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
    console.log('backend_port_signature: OK');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
