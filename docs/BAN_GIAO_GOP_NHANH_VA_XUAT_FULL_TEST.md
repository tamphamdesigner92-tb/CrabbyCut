# Bàn giao: gộp nhánh + xuất lại Full Test (2026-10-23)

## Gộp nhánh

Git và GitHub giờ chỉ còn `main` và `feat/port-studio-wiggle-distort-nest-text-gif-mcp`.

- Đã gộp vào nhánh feat: `feat/timeline-capcut-lane` (PR #21), `claude/render-perf-gtx1060-slow-bdd140`
  (PR #22, xếp lượt GPU theo VRAM), `fix/sendfile-dot-dirs` (PR #23), `fix/export-download-404`,
  `docs/ban-giao-x264-avx512`. Commit gộp cuối: `295d04c`.
- Xung đột duy nhất: dòng `"test"` trong `package.json` — giữ dòng của nhánh feat và thêm
  `npm run test:send-file-dot-dirs` sau `test:media-folders`.
- PR #21, #23 đã đóng kèm ghi chú; #22 GitHub tự đánh dấu "merged" (base là nhánh feat).
  PR #20 (nhánh feat → main) còn mở, có bình luận liệt kê nội dung đã gộp.
- Đã xoá các nhánh/worktree cũ ở máy và nhánh thừa trên GitHub. Remote `private` không đụng tới.
- Chưa chạy bộ test đầy đủ trên bản gộp — chờ CI của PR #20.

## Xuất lại Full Test (code nhánh feat, `295d04c`)

Dự án: `G:\Work\AI\Test CrabbyCut\Full Test\Forever Inside - Sci-Fi Short Film.crab`, mở và xuất qua
MCP (`crabbycut_start_job export`, cài đặt mặc định của dự án). Máy: GTX 1060 6 GB, Ryzen 7 2700X.

| Phần | Thời gian |
| --- | --- |
| Prebake | 25,1 s |
| Sidecar (14 batch hình + tiếng) | 426,8 s (ghép 33,0 s) |
| **Tổng** | **457,8 s (7 phút 38 giây)** |

- File ra: `G:\Work\AI\Test CrabbyCut\Full Test\Forever Inside - Full Test (feat 295d04c).mp4` —
  5,45 GB, HEVC (hevc_nvenc) 3840×1646 24 fps, 56.756 khung, AAC, dài 2364,83 s.
- 14/14 batch GPU, không lùi CPU, không lỗi. Có dòng "Chờ VRAM trống…" — phép chặn theo VRAM
  hoạt động. VRAM đỉnh (nvidia-smi mỗi 5 s) 5.368/6.144 MiB.
- Batch 5, 6, 11, 12 chậm nhất (~53 s); còn lại 28–38 s.
- Khớp số đo khi sửa VRAM (sidecar 425–437 s).
- Báo cáo: `reports/report_project_20261023_020244.txt`.

## Trạng thái máy

- Checkout chính đang ở nhánh `feat/port-studio-wiggle-distort-nest-text-gif-mcp` (không phải `main`).
- `native` đã build lại từ nhánh feat (addon + `core_process.exe`).
