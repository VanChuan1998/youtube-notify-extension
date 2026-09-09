# YouTube Kênh Yêu Thích — Tự Mở Video Mới

Extension Chrome: chọn các kênh YouTube muốn theo dõi, extension tự động kiểm tra định kỳ
(mặc định 10 phút/lần) qua YouTube Data API. Khi kênh đăng video mới, extension sẽ:

- Mở 1 tab mới đến video đó
- Hiện thông báo desktop (notification) kèm tiêu đề video

Có 2 cách thêm kênh vào danh sách theo dõi:

1. Dán URL kênh / `@handle` / tên kênh vào ô "Thêm kênh theo dõi"
2. Bấm "Đăng nhập Google & tải danh sách đã subscribe" để lấy toàn bộ kênh bạn đã
   subscribe trên tài khoản Google, rồi bấm "+ Thêm" cho từng kênh muốn theo dõi

**ID cố định của extension này: `meifbaclchfimfdjmpgpkehniloimnfa`**
(đã được gắn sẵn trong `manifest.json` qua trường `"key"`, để ID không đổi mỗi lần bạn tải lại
extension — điều này bắt buộc cho bước cấu hình OAuth ở dưới).

---

## Bước 1 — Tạo API key (bắt buộc, dùng để kiểm tra video mới)

1. Vào https://console.cloud.google.com/ → tạo project mới (hoặc dùng project có sẵn)
2. Vào **APIs & Services → Library**, tìm **YouTube Data API v3** → bấm **Enable**
3. Vào **APIs & Services → Credentials** → **Create Credentials → API key**
4. Copy API key vừa tạo. (Nên bấm "Restrict key" → chọn "YouTube Data API v3" để giới hạn phạm vi cho an toàn)
5. Dán API key này vào ô **"YouTube Data API key"** trong popup của extension → bấm **Lưu cấu hình**

Lưu ý về quota: API miễn phí có 10.000 unit/ngày. Mỗi lần kiểm tra 1 kênh tốn ~1-2 unit
(playlistItems.list), nên theo dõi vài chục kênh, kiểm tra mỗi 10 phút vẫn thoải mái trong hạn mức.

---

## Bước 2 — Tạo OAuth Client ID (chỉ cần nếu muốn dùng nút "lấy danh sách đã subscribe")

Nếu bạn chỉ định thêm kênh bằng cách dán URL/tên kênh thủ công thì **có thể bỏ qua bước này**.

1. Trong cùng project ở Bước 1, vào **APIs & Services → OAuth consent screen**
   - Chọn **External**, điền tên app (vd "YouTube Kênh Yêu Thích"), email liên hệ
   - Ở phần **Scopes**, thêm scope `.../auth/youtube.readonly`
   - Ở phần **Test users**, thêm chính email Gmail bạn dùng để đăng nhập YouTube
     (khi app ở chế độ Testing, chỉ các email trong danh sách này mới đăng nhập được)
2. Vào **APIs & Services → Credentials → Create Credentials → OAuth client ID**
   - **Application type**: chọn **Chrome Extension**
   - **Application ID**: dán `meifbaclchfimfdjmpgpkehniloimnfa`
   - Bấm **Create**, copy **Client ID** dạng `xxxxxxxxxx.apps.googleusercontent.com`
3. Mở file `manifest.json` trong thư mục extension, thay dòng:
   ```json
   "client_id": "DÁN_OAUTH_CLIENT_ID_CỦA_BẠN_VÀO_ĐÂY.apps.googleusercontent.com"
   ```
   bằng Client ID vừa copy.
4. Vào `chrome://extensions` → bấm nút **Reload (⟳)** trên extension để áp dụng thay đổi.

---

## Bước 3 — Cài extension vào Chrome (chế độ Developer / unpacked)

1. Mở `chrome://extensions`
2. Bật **Developer mode** (góc trên bên phải)
3. Bấm **Load unpacked** → chọn thư mục `youtube-notify-extension` (thư mục chứa file `manifest.json`)
4. Extension xuất hiện trên thanh công cụ. Bấm icon để mở popup, nhập API key, thêm kênh.

---

## Cách hoạt động

- `background.js` chạy nền (service worker), dùng `chrome.alarms` để kiểm tra định kỳ
- Với mỗi kênh đang theo dõi, gọi API lấy playlist "uploads" của kênh rồi lấy video mới nhất
- Lần đầu thêm 1 kênh, extension chỉ **ghi nhận mốc** (video mới nhất hiện tại), không mở tab
  — tránh việc mở hàng loạt tab cho các video cũ. Từ lần kiểm tra sau, nếu có video mới hơn
  mốc đã lưu thì mới mở tab + thông báo
- Có thể bấm **"Kiểm tra ngay"** trong popup để test ngay lập tức thay vì chờ đến chu kỳ

## Xử lý sự cố

- Popup báo lỗi màu đỏ dưới ô API key → thường là API key sai, chưa bật YouTube Data API v3,
  hoặc đã hết quota trong ngày
- Nút đăng nhập Google báo lỗi `access_denied` hoặc `invalid_client` → kiểm tra lại Bước 2:
  Client ID đã dán đúng vào `manifest.json` và extension ID trong Google Cloud khớp với
  `meifbaclchfimfdjmpgpkehniloimnfa` chưa; email đăng nhập có nằm trong danh sách **Test users** không
- Nếu vẫn không lấy được token, thử vào `chrome://extensions`, gỡ và load lại extension sau khi sửa
  `manifest.json`
