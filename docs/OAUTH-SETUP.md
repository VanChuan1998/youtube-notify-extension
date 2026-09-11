# Cấu hình OAuth để tải danh sách kênh đã đăng ký

Extension có hai cách thêm kênh:

- **Thêm thủ công** — dán URL kênh, `@handle` hoặc tên kênh. Chỉ cần **API key**, không cần OAuth. Dùng được ngay.
- **Tải từ Subscriptions** — lấy toàn bộ kênh bạn đã đăng ký trên tài khoản Google. Cần **OAuth client ID**, cấu hình theo hướng dẫn dưới đây.

Nếu chưa cấu hình, nút "Đăng nhập Google & tải danh sách đã subscribe" sẽ báo nhắc thay vì lỗi khó hiểu.

---

## Bước 1 — Lấy Redirect URI
 
OAuth client mới sẽ là loại *Web Application*, và nó cần một **Redirect URI** để trả kết quả về cho extension.
 
1. Mở `edge://extensions` (hoặc `chrome://extensions`).
2. Bật **Developer mode** (góc trên bên phải).
3. Bấm **Load unpacked**, chọn thư mục `extension/`.
4. Mở popup của extension lên, nhìn xuống phần **Lấy từ kênh đã đăng ký (Subscriptions)**.
5. Bạn sẽ thấy một dòng ghi **Redirect URI của bạn** (Ví dụ: `https://abcdefghijklmnopqrstuvwxyz123456.chromiumapp.org/`). Hãy copy chính xác đường link này.

> *Mẹo:* `extension/manifest.json` đã có sẵn trường `key` nên ID extension (và do đó Redirect URI) sẽ không đổi giữa các lần cài đặt. Đừng xóa trường `key` này.

## Bước 2 — Tạo Google Cloud project và bật API

1. Vào https://console.cloud.google.com/projectcreate — tạo project mới (tên gì cũng được)
2. Vào **APIs & Services → Library**, tìm **YouTube Data API v3**, bấm **Enable**

## Bước 3 — Cấu hình OAuth consent screen

1. **APIs & Services → OAuth consent screen**
2. User Type: chọn **External**
3. Điền tên ứng dụng, email hỗ trợ, email liên hệ nhà phát triển
4. Ở bước **Scopes**, bấm **Add or remove scopes**, thêm:
   ```
   https://www.googleapis.com/auth/youtube.readonly
   ```
5. Ở bước **Test users**, thêm chính địa chỉ Gmail của bạn

> App ở trạng thái **Testing** chỉ dùng được với các tài khoản có trong danh sách Test users, và token hết hạn sau 7 ngày. Muốn dùng lâu dài cho nhiều người thì phải bấm **Publish app** và qua quy trình xác minh của Google — quy trình này mất vài tuần vì scope `youtube.readonly` bị Google xếp loại nhạy cảm. Dùng cá nhân thì cứ để **Testing**, thỉnh thoảng đăng nhập lại.

## Bước 4 — Tạo OAuth client ID
 
1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: chọn **Web application** (Ứng dụng web)
3. Name: Tên tùy ý (Ví dụ: Edge Extension Client).
4. Ở mục **Authorized redirect URIs**, bấm **ADD URI** rồi dán cái URL mà bạn vừa copy ở Bước 1 vào.
5. Bấm **Create**, màn hình sẽ hiện lên **Client ID**. Hãy copy chuỗi Client ID (dạng `123456789-abcdef.apps.googleusercontent.com`).

## Bước 5 — Dán vào manifest
 
Mở `extension/manifest.json`, thay giá trị placeholder ở mục `google_oauth2`:
 
```json
"google_oauth2": {
  "client_id": "123456789-abcdef.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/youtube.readonly"]
}
```
 
Quay lại trang quản lý Extensions của trình duyệt, bấm nút **tải lại** (↻) trên extension. Mở popup, bấm "Đăng nhập Google & tải danh sách đã subscribe". Giao diện đăng nhập Google sẽ hiện ra!

---

## API key (bắt buộc, khác với OAuth)

API key dùng cho việc kiểm tra video mới — phần cốt lõi của extension, luôn cần có.

1. **APIs & Services → Credentials → Create Credentials → API key**
2. Copy key (dạng `AIza...`)
3. Mở popup extension, dán vào ô **YouTube Data API key**, bấm **Lưu cấu hình**

Nên bấm **Restrict key** và giới hạn key ở đúng **YouTube Data API v3** để tránh bị lạm dụng nếu lộ.

### Về hạn mức (quota)

Quota mặc định là **10.000 đơn vị/ngày**. Chi phí mỗi thao tác:

| Thao tác | Đơn vị |
|---|---|
| Kiểm tra video mới của 1 kênh (`playlistItems.list`) | 1 |
| Tra cứu thông tin kênh (`channels.list`) | 1 |
| Tìm kênh theo tên (`search.list`) | **100** |

Ví dụ: theo dõi 20 kênh, kiểm tra mỗi 10 phút → `20 × 6 × 24 = 2.880` đơn vị/ngày, thoải mái trong hạn mức.

Nếu gần chạm hạn mức thì tăng **Chu kỳ kiểm tra** trong popup. Lưu ý thêm kênh bằng *tên* tốn 100 đơn vị mỗi lần — dán thẳng URL kênh hoặc `@handle` thì rẻ hơn nhiều.
