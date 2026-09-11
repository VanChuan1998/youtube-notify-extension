# Phát hành Auto Mở Live

## 1. Kiểm tra trước khi đóng gói

```bash
npm test
node --check extension/background.js
node --check extension/popup.js
python3 -m json.tool extension/manifest.json >/dev/null
./scripts/pack-extension.sh
```

ZIP nộp store được tạo trong `dist/` và chỉ chứa nội dung `extension/`.

## 2. Tên và listing

Tên sản phẩm:

```text
Auto Mở Live
```

Mô tả ngắn gợi ý:

```text
Theo dõi các kênh YouTube bạn chọn, thông báo và tự mở tab khi có video mới hoặc livestream bắt đầu.
```

Không dùng “YouTube”, “YT” hoặc biến thể làm một phần của **tên tổng thể** của extension. Có thể dùng “YouTube” trong mô tả để nói sản phẩm hoạt động với dịch vụ nào.

## 3. Privacy URLs

```text
Homepage: https://youtube-notification.chuan-nv.com/
Privacy: https://youtube-notification.chuan-nv.com/privacy-policy.html
Terms: https://youtube-notification.chuan-nv.com/terms.html
```

Các URL này phải public và không yêu cầu login.

## 4. Permission justification

- `storage`: lưu cấu hình theo dõi/API key cục bộ và OAuth session data tạm thời.
- `alarms`: lập lịch phát hiện video và kiểm tra trạng thái live.
- `notifications`: thông báo video/livestream.
- `identity`: luồng OAuth Google tuỳ chọn.
- `youtube.com`: đọc feed video của channel đã chọn.
- `www.googleapis.com`: YouTube Data API v3.
- `accounts.google.com`: trang OAuth/consent do Google cung cấp.
- `oauth2.googleapis.com`: thu hồi OAuth token khi người dùng ngắt kết nối.

Không có remote code. Không tải JavaScript từ CDN.

## 5. OAuth disclosure trong listing

Nên nói rõ:

> Google sign-in is optional. If the user chooses “Connect Google & load subscribed channels,” Auto Mở Live requests the read-only `youtube.readonly` scope to retrieve subscriptions and use the YouTube Data API. The extension does not upload, edit, or delete YouTube content. OAuth access tokens are kept only in Chrome session storage and are not sent to a developer-operated server.

## 6. Screenshots/video cho verification

Nên quay một video ngắn theo thứ tự:

1. Mở homepage ở Incognito, cho thấy không login.
2. Cuộn tới phần Google Account & YouTube Data Access.
3. Mở extension; popup hoạt động trước khi sign-in.
4. Bấm Connect Google, cho thấy consent + scope.
5. Import subscriptions.
6. Bấm Disconnect và cho thấy dữ liệu import biến mất.

## 7. Sau khi upload Store

Bản Store không chứa trường `key` vì script đóng gói tự xoá trường này. Extension ID trên Store do store quyết định. Nếu OAuth credential phụ thuộc extension ID/redirect URI, xác nhận credential production dùng đúng ID production trước khi phát hành rộng rãi.
