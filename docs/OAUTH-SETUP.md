# Google OAuth, YouTube Data API và OAuth Verification

Tài liệu này mô tả **implementation hiện tại** của Auto Mở Live và các giá trị cần đồng bộ trong Google Cloud.

## 1. Hai loại credential độc lập

### YouTube Data API key — tuỳ chọn

API key do người dùng tự nhập trong popup. Nó cho phép:

- tra cứu channel từ `@handle`, username hoặc tên;
- gọi `videos.list` để phân loại video thường / live / upcoming.

Không có API key vẫn có thể thêm channel ID `UC...` trực tiếp và phát hiện ID video mới từ feed, nhưng extension sẽ không phân loại hàng chờ cho tới khi có API key hoặc OAuth session.

### Google OAuth — tuỳ chọn

OAuth chỉ bắt đầu khi người dùng bấm **Kết nối Google & tải kênh đã đăng ký**. Scope duy nhất:

```text
https://www.googleapis.com/auth/youtube.readonly
```

Extension dùng scope này để tải danh sách subscriptions, lấy thông tin cơ bản của kênh thuộc tài khoản và gọi YouTube Data API cho chức năng phân loại trong phiên hiện tại. Scope là chỉ đọc.

## 2. Implementation OAuth hiện tại

Source hiện tại dùng:

```text
chrome.identity.launchWebAuthFlow()
response_type=token
redirect URI = chrome.identity.getRedirectURL()
```

Client ID nằm tại:

```text
extension/popup.js → OAUTH_CLIENT_ID
```

Không dán client ID vào `manifest.json`: implementation hiện tại không có `manifest.oauth2`.

> Chrome/Google cũng có luồng dành riêng cho Chrome Extension credential qua `chrome.identity.getAuthToken()`. Đó là một migration riêng vì cần credential mới. Không đổi loại client ID giữa chừng nếu chưa chuẩn bị và kiểm thử credential mới.

## 3. Lấy Redirect URI

1. Load thư mục `extension/` tại `chrome://extensions` hoặc `edge://extensions`.
2. Bật Developer mode.
3. Mở popup.
4. Nếu OAuth client chưa cấu hình, popup hiển thị Redirect URI; hoặc đọc bằng `chrome.identity.getRedirectURL()`.
5. Copy **chính xác** URI dạng:

```text
https://<extension-id>.chromiumapp.org/
```

Manifest local có trường `key` nhằm giữ extension ID ổn định khi phát triển. Bản ZIP nộp Store do `scripts/pack-extension.sh` tạo sẽ bỏ trường này.

## 4. Google Cloud

### Bật YouTube Data API v3

Trong Google Cloud Console, chọn đúng project rồi bật **YouTube Data API v3**.

### OAuth Branding

Dùng chính xác:

```text
App name: Auto Mở Live
Homepage URL: https://youtube-notification.chuan-nv.com/
Privacy policy URL: https://youtube-notification.chuan-nv.com/privacy-policy.html
Terms of service URL: https://youtube-notification.chuan-nv.com/terms.html
Authorized domain: chuan-nv.com
```

Giữ App name là `Auto Mở Live`; “YouTube” có thể xuất hiện trong mô tả chức năng, nhưng không dùng thương hiệu đó như một phần của tên tổng thể của ứng dụng.

Homepage phải mở công khai mà không cần sign-in. Website hiện được thiết kế để nói rõ:

- trang chủ công khai, không phải login page;
- Google sign-in là tuỳ chọn;
- nút OAuth chỉ phục vụ import subscriptions / YouTube Data API;
- scope `youtube.readonly` và mục đích sử dụng;
- link Privacy Policy và Terms.

### Search Console

Xác minh quyền sở hữu top private domain:

```text
chuan-nv.com
```

Tài khoản xác minh domain nên có quyền phù hợp trên Google Cloud project dùng cho OAuth verification.

### Data access / Scope

Chỉ yêu cầu:

```text
https://www.googleapis.com/auth/youtube.readonly
```

Không thêm scope rộng hơn nếu code không cần.

## 5. Client ID cho implementation hiện tại

Nếu tiếp tục dùng `launchWebAuthFlow()` hiện tại:

1. Tạo OAuth client theo loại phù hợp với luồng mà Google Cloud cho phép cho project của bạn.
2. Đăng ký chính xác Redirect URI `https://<extension-id>.chromiumapp.org/` nếu loại client yêu cầu redirect URI.
3. Copy client ID.
4. Sửa:

```js
// extension/popup.js
const OAUTH_CLIENT_ID = "YOUR_CLIENT_ID.apps.googleusercontent.com";
```

5. Reload extension.

Không commit client secret. Luồng extension không được nhúng client secret.

## 6. Token và dữ liệu OAuth

Bản hiện tại (v1.1.3):

- giữ access token trong `chrome.storage.session`, không phải local storage bền;
- lưu `googleOAuthAuthorized` và OAuth client ID (không phải secret/token) trong `chrome.storage.local` để biết có nên thử khôi phục kết nối;
- sau browser restart hoặc khi token hết hạn, thử `launchWebAuthFlow({ interactive: false })` với `prompt=none`; nếu grant và Google browser session vẫn hợp lệ, Google cấp access token mới mà không hiện consent/login;
- nếu YouTube Data API trả HTTP 401, xoá session token, thử silent re-auth và retry request đúng một lần;
- nếu silent re-auth thất bại, không tự bật cửa sổ OAuth ở background; người dùng chỉ cần bấm **Kết nối Google** khi muốn kết nối lại;
- giữ subscriptions vừa tải và thông tin kênh tài khoản trong session;
- khi người dùng bấm **Ngắt kết nối**, gọi `https://oauth2.googleapis.com/revoke`, xoá OAuth session data, marker kết nối cục bộ và các kênh đã thêm trực tiếp từ subscriptions;
- Privacy Policy mô tả đúng các hành vi trên.

Đây vẫn là implicit access-token flow (`response_type=token`), không có refresh token và không có backend. Silent restore phụ thuộc vào việc grant OAuth chưa bị thu hồi và Google browser session vẫn cho phép xác thực không tương tác.

## 7. Request verification lại

Trước khi request:

1. Deploy `web/` mới.
2. Mở `https://youtube-notification.chuan-nv.com/` trong Incognito và xác nhận HTTP 200, nội dung đầy đủ, không login.
3. Kiểm tra Branding dùng URL **không có `www`**.
4. App name = `Auto Mở Live`.
5. Privacy/Terms URL đúng như trên.
6. Developer contact email là mailbox bạn thực sự kiểm tra.
7. Submit **Request re-verification**; nếu giao diện có lựa chọn cho kết quả sai, dùng **Request additional review**.

Nếu Verification Center nói phải reply Trust & Safety nhưng không có thread email, tìm cả Inbox/Spam/All Mail với `api-oauth-support@google.com`; sau khi đã sửa mọi issue, dùng nút re-verification/additional review trong Console khi có thay vì chờ một email không tồn tại.

## 8. Test trước khi submit

```text
A. Incognito → homepage → đọc được App Purpose + Google Account Access + Privacy link, không sign-in.
B. Load unpacked → popup mở được không Google login.
C. Add channel ID UC... → hoạt động.
D. Kết nối Google → consent chỉ có youtube.readonly.
E. Import subscriptions → chọn một channel để thêm.
F. Ngắt kết nối → OAuth session data biến mất và các channel source=subscription bị xoá.
G. API key hoặc OAuth → video mới được phân loại bằng videos.list.
```
