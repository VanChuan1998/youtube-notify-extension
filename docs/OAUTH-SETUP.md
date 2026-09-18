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
response_type=code + PKCE (code_challenge/code_verifier, S256)
access_type=offline
redirect URI = chrome.identity.getRedirectURL()
```

Client ID nằm tại:

```text
extension/popup.js → OAUTH_CLIENT_ID
```

**Client secret KHÔNG nằm trong extension.** Việc đổi authorization code / refresh token lấy
access token đi qua một Cloudflare Worker proxy (`worker/index.js`), deploy cùng domain với
website (`youtube-notification.chuan-nv.com`):

```text
POST https://youtube-notification.chuan-nv.com/oauth/exchange   (code -> access_token + refresh_token)
POST https://youtube-notification.chuan-nv.com/oauth/refresh    (refresh_token -> access_token)
```

Worker giữ `OAUTH_CLIENT_SECRET` dưới dạng Cloudflare secret (không commit vào repo, set bằng
`wrangler secret put OAUTH_CLIENT_SECRET`), và `OAUTH_CLIENT_ID` công khai trong `wrangler.jsonc`.
Worker chỉ chuyển tiếp request sang `oauth2.googleapis.com/token`, không lưu trữ token hay dữ
liệu người dùng ở đâu — xem code đầy đủ trong `worker/index.js`.

> Lý do có Worker này: Authorization Code flow chuẩn của Google luôn yêu cầu client_secret ở bước
> đổi code/refresh, kể cả với client loại "installed app". Vì extension chạy hoàn toàn phía
> client, bất kỳ secret nào nhúng trực tiếp vào extension đều đọc được nếu unpack. Đưa bước gọi
> Google token endpoint ra một Worker nhỏ giữ secret ở server side loại bỏ rủi ro đó — attacker chỉ
> có thể lợi dụng Worker nếu có `code`/`refresh_token` hợp lệ, mà `code` chỉ được Google cấp cho
> đúng `redirect_uri` dạng `https://<extension-id>.chromiumapp.org/` (chỉ extension mới nhận được).

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

5. Trong Cloudflare Worker (không phải trong extension), cấu hình:

```jsonc
// wrangler.jsonc → vars (giá trị công khai)
"OAUTH_CLIENT_ID": "YOUR_CLIENT_ID.apps.googleusercontent.com"
```

```bash
# Secret thật — KHÔNG commit vào repo
wrangler secret put OAUTH_CLIENT_SECRET
```

6. Deploy Worker (`npm run deploy` / `wrangler deploy`), reload extension.

> Không commit client secret. Đây vẫn là ràng buộc gốc của dự án — nó chỉ được đáp ứng bằng cách
> đưa bước cần secret ra khỏi extension, sang Worker (mục 2), thay vì nhúng thẳng vào code extension.

## 6. Token và dữ liệu OAuth

Bản hiện tại (v1.1.9+, sau khi chuyển sang Authorization Code + PKCE):

- giữ access token trong `chrome.storage.session` (không bền qua restart, theo thiết kế);
- giữ `refresh_token` trong `chrome.storage.local` (`googleOAuthRefreshToken`) — bền qua restart
  trình duyệt/PC. Đây là điểm khác biệt cốt lõi so với bản implicit-flow cũ;
- lưu `googleOAuthAuthorized` và OAuth client ID trong `chrome.storage.local` để biết có nên thử
  khôi phục kết nối;
- khi cần token mới (session hết hạn hoặc vừa restart), **ưu tiên gọi thẳng
  `POST /oauth/refresh` trên Worker proxy** — không cần mở `launchWebAuthFlow`, không phụ
  thuộc cookie đăng nhập Google hay chính sách chặn cookie bên thứ ba của trình duyệt (đây chính
  là nguyên nhân khiến bản cũ hay báo "không có access token hợp lệ" sau khi restart PC trên Edge,
  vì Edge có thể chặn cookie cần thiết cho `launchWebAuthFlow({interactive:false, prompt:"none"})`);
- chỉ khi chưa có `refresh_token` (ví dụ tài khoản nâng cấp từ bản cũ) mới thử lại
  `launchWebAuthFlow({ interactive: false })` với `prompt=none` như phương án dự phòng;
- nếu YouTube Data API trả HTTP 401, xoá session token, thử renew (refresh token trước, silent
  webflow sau) và retry request đúng một lần;
- nếu cả hai cách đều thất bại, không tự bật cửa sổ OAuth ở background; người dùng chỉ cần bấm
  **Kết nối Google** khi muốn kết nối lại;
- giữ subscriptions vừa tải và thông tin kênh tài khoản trong session;
- khi người dùng bấm **Ngắt kết nối**, thu hồi `refresh_token` (nếu có, ưu tiên vì thu hồi toàn bộ
  grant) qua `https://oauth2.googleapis.com/revoke`, xoá OAuth session data, `googleOAuthRefreshToken`,
  marker kết nối cục bộ và các kênh đã thêm trực tiếp từ subscriptions;
- Privacy Policy (`web/privacy-policy.html`, bản tiếng Việt và tiếng Anh) đã cập nhật để mô tả đúng các hành vi trên, gồm việc `refresh_token` được lưu cục bộ.

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
