# Quy Trình Sửa Code — Bắt Buộc Kiểm Tra Bằng `regression-guard`

Tài liệu này áp dụng cho **mọi tác vụ sửa mã code** trong CrabbyCut (Win lẫn Mac, frontend
`static/`, `electron/`, `backend/`, `native/`, `scripts/`, `tests/`…), dù do người hay do
Claude Code thực hiện.

Mục tiêu: sửa đúng cái được yêu cầu và **không làm hỏng hay thay đổi hành vi** của bất kỳ
tính năng nào khác khi chưa được cho phép.

---

## 1. Quy tắc

1. **Chỉ sửa đúng phạm vi được yêu cầu.** Không refactor, đổi tên, format lại, đổi giá trị
   mặc định, nâng version thư viện hay "tiện tay" sửa tính năng khác.
2. **Hỏi trước khi chạm vào code dùng chung.** Nếu phải đổi hành vi của code mà tính năng
   khác đang dùng (utils, services, store, model, API, schema, style toàn cục, cấu hình,
   pipeline export/preview…), dừng lại, liệt kê tính năng bị ảnh hưởng và xin phép trước.
   Ưu tiên cách làm không ảnh hưởng tính năng khác.
3. **Bắt buộc gọi agent `regression-guard`** sau khi sửa code xong, **trước khi** báo "xong"
   hoặc commit.
4. **Không xoá, vô hiệu hoá hay sửa test để test pass**, trừ khi người dùng đồng ý rõ ràng.

> Chỉ sửa tài liệu (`.md`) thuần tuý thì không cần chạy `regression-guard`. Có đụng tới bất kỳ
> file code / cấu hình nào thì **bắt buộc**.

---

## 2. Gọi `regression-guard` thế nào

Agent được định nghĩa ở `~/.claude/agents/regression-guard.md`. Khi gọi phải truyền:

- **Nguyên văn yêu cầu của người dùng**, kèm những gì người dùng đã cho phép thêm trong cuộc
  trò chuyện.
- **Danh sách file đã sửa** và mô tả ngắn từng thay đổi.

Ví dụ nội dung truyền vào:

```text
Yêu cầu gốc: "Sửa dự án cũ có ảnh SVG không xuất được (no decoder found for: svg)"
Cho phép thêm: không có.
File đã sửa:
- backend/export/...: rasterize SVG sang PNG trước khi đưa vào ffmpeg
- tests/...: thêm test cho dự án cũ có SVG
```

---

## 3. Xử lý kết quả

| Kết quả | Việc phải làm |
|---|---|
| ❌ **KHÔNG ĐẠT** | Sửa lại vấn đề, rồi gọi lại `regression-guard` cho tới khi hết lỗi. |
| ⚠️ **CẦN XÁC NHẬN** | Trình bày các điểm đó cho người dùng và chờ quyết định. Không tự ý giữ thay đổi ngoài phạm vi. |
| ✅ **ĐẠT** | Báo "xong" cho người dùng, kèm tóm tắt ngắn kết quả kiểm tra. Lúc này mới được commit. |

---

## 4. Checklist trước khi commit

- [ ] Thay đổi chỉ nằm trong phạm vi yêu cầu (hoặc phần mở rộng đã được người dùng cho phép).
- [ ] Code dùng chung bị đụng tới đã được người dùng duyệt.
- [ ] Đã chạy `regression-guard` và kết quả là ✅ ĐẠT.
- [ ] Không có test nào bị xoá / tắt / sửa cho pass mà chưa được đồng ý.
