# Hướng dẫn nộp lên Chrome Web Store

## 1. Tạo tài khoản Chrome Web Store Developer

1. Vào https://chrome.google.com/webstore/devconsole
2. Đăng nhập bằng tài khoản Google (nên dùng đúng email đã cấu hình ở Bước 1/2 trong README.md
   để dễ quản lý API key/OAuth client)
3. Đóng phí đăng ký nhà phát triển **5 USD** (thanh toán 1 lần duy nhất, không lặp lại)
4. Điền thông tin nhà phát triển (tên hiển thị công khai, email liên hệ)

## 2. Đóng gói bản để nộp

Repo này chứa cả extension lẫn landing page. Chrome Web Store chỉ nhận phần extension — nộp
kèm `web/`, `docs/` hay `.github/` sẽ bị từ chối vì chứa file không dùng đến.

Chạy script, nó lo phần lọc file:

```bash
./scripts/pack-extension.sh
```

Kết quả nằm ở `dist/youtube-kenh-yeu-thich-v<version>.zip`, chỉ chứa nội dung `extension/` với
`manifest.json` ở gốc archive (đúng cấu trúc Web Store yêu cầu):

```
manifest.json
background.js
popup.html
popup.js
popup.css
icons/icon16.png
icons/icon48.png
icons/icon128.png
```

Script cũng tự kiểm tra `manifest.json` hợp lệ và cảnh báo nếu `oauth2.client_id` còn là
placeholder.

Nếu không muốn chạy local: mỗi lần push lên `main`, workflow **CI** đã build sẵn file zip.
Vào tab **Actions** trên GitHub → chọn lần chạy mới nhất → tải artifact **extension-zip**.

⚠️ Trước khi nộp, nhớ đã dán **Client ID OAuth thật** vào `extension/manifest.json` (xem
[OAUTH-SETUP.md](OAUTH-SETUP.md)) — để nguyên placeholder thì chức năng "tải danh sách đã
subscribe" sẽ không dùng được với người khác.

## 3. Điền Store Listing (trang mô tả)

**Tên hiển thị (Title):**
```
YouTube Kênh Yêu Thích — Tự Mở Video Mới
```

**Mô tả ngắn (Summary, ≤132 ký tự):**
```
Theo dõi các kênh YouTube bạn chọn, tự mở tab và báo khi có video mới đăng.
```

**Mô tả chi tiết (Description):**
```
Chọn các kênh YouTube bạn quan tâm — dán URL/@handle hoặc nhập trực tiếp từ danh sách kênh bạn
đã subscribe. Extension tự động kiểm tra định kỳ (mặc định mỗi 10 phút) bằng YouTube Data API.

Khi một kênh bạn đang theo dõi đăng video mới, extension sẽ:
• Tự động mở 1 tab mới đến video đó
• Hiện thông báo desktop kèm tiêu đề video

Tính năng chính:
• Thêm kênh bằng URL, @handle hoặc tên kênh
• Nhập nhanh từ danh sách kênh đã đăng ký (subscriptions) trên tài khoản Google của bạn
• Tuỳ chỉnh chu kỳ kiểm tra
• Bật/tắt theo dõi từng kênh, xoá kênh dễ dàng
• Toàn bộ dữ liệu (API key, danh sách kênh) chỉ lưu cục bộ trên trình duyệt của bạn — không gửi
  về máy chủ nào khác ngoài Google

Yêu cầu: bạn cần tự tạo 1 YouTube Data API key miễn phí (hướng dẫn có trong trang GitHub của dự
án). Đây là extension mã nguồn mở, phi lợi nhuận, dành cho cá nhân sử dụng.
```

**Category:** Productivity (hoặc Tools/Social & Communication tuỳ danh mục hiển thị lúc nộp)

**Language:** Tiếng Việt (có thể thêm bản mô tả tiếng Anh nếu muốn tiếp cận rộng hơn)

## 4. Ảnh cần chuẩn bị

| Loại | Kích thước | Bắt buộc |
|---|---|---|
| Icon | 128×128 | Có sẵn ở `icons/icon128.png` |
| Screenshot | 1280×800 hoặc 640×400 | Bắt buộc, tối thiểu 1 ảnh — chụp popup extension đang hiển thị danh sách kênh |
| Small promo tile | 440×280 | Tuỳ chọn |

## 5. Privacy Policy URL

Dán URL trang chính sách bảo mật đã publish (đưa cho reviewer và hiển thị công khai trên store listing):

```
https://claude.ai/code/artifact/782ce632-ce4a-45ea-99f3-d7be45975872
```

## 6. Mục "Permissions justification" (phần review yêu cầu giải trình)

Chrome Web Store sẽ hỏi lý do cho từng permission — copy nội dung tương ứng:

| Permission | Giải trình |
|---|---|
| `storage` | Lưu API key, danh sách kênh theo dõi và cài đặt của người dùng ngay trên trình duyệt. |
| `alarms` | Đặt lịch kiểm tra định kỳ video mới của các kênh đã chọn. |
| `notifications` | Hiển thị thông báo desktop khi phát hiện video mới. |
| `tabs` | Mở tab mới đến video vừa được đăng khi phát hiện có video mới. |
| `identity` | Cho phép người dùng đăng nhập Google (tuỳ chọn) để đọc danh sách kênh họ đã subscribe. |
| Host permission `googleapis.com` | Gọi YouTube Data API v3 để lấy thông tin video/kênh. |

**Single purpose description:**
```
Theo dõi các kênh YouTube do người dùng chọn và tự động mở video mới khi phát hiện kênh đó
vừa đăng tải.
```

## 7. Mục "Data usage" (Privacy practices tab)

Trong phần chứng nhận sử dụng dữ liệu, chọn theo đúng thực tế:
- Không thu thập/bán dữ liệu cá nhân người dùng cho bên thứ ba
- Dữ liệu (API key, danh sách kênh) chỉ lưu local, không gửi về server của nhà phát triển
- Có sử dụng scope OAuth nhạy cảm `youtube.readonly` → cần khai đúng mục đích: "đọc danh sách
  kênh người dùng đã đăng ký để họ chọn theo dõi", tick chọn phù hợp với chính sách bảo mật đã dán ở bước 5

## 8. OAuth consent screen — trước khi submit

Vì extension dùng scope `youtube.readonly` (nhạy cảm), nếu để ở chế độ **Testing** trên Google
Cloud Console (như hướng dẫn ở README.md Bước 2), chỉ tối đa 100 email nằm trong danh sách
**Test users** mới đăng nhập được. Nếu muốn publish rộng rãi cho người dùng bất kỳ:
1. Vào OAuth consent screen → **Publish App**
2. Vì dùng scope nhạy cảm, Google có thể yêu cầu **xác minh (verification)** — cần nộp thêm
   video demo luồng OAuth, giải trình mục đích sử dụng dữ liệu. Quá trình này có thể mất vài
   ngày đến vài tuần.

Nếu chỉ dùng cho cá nhân/số ít người quen, có thể giữ nguyên chế độ Testing và chỉ thêm email
của họ vào Test users — không cần verification, không ảnh hưởng đến việc publish extension lên
Chrome Web Store (2 việc độc lập nhau).

## 9. Submit

Bấm **Submit for review**. Chrome Web Store thường duyệt trong 1-3 ngày (có thể lâu hơn với
extension xin nhiều quyền hoặc OAuth).
