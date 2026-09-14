# Auto Mở Live

Auto Mở Live là Chrome extension giúp theo dõi các kênh YouTube do người dùng tự chọn, phát hiện nội dung mới, thông báo và có thể tự mở tab khi video/livestream phù hợp xuất hiện.

Ứng dụng độc lập, không liên kết, tài trợ hoặc bảo trợ bởi YouTube hay Google LLC.

## Cách hoạt động

Extension có hai vòng kiểm tra:

1. **Phát hiện nội dung mới** — đọc feed video của từng channel ID theo chu kỳ (mặc định 60 giây). ID video mới được đưa vào hàng chờ.
2. **Phân loại trạng thái** — dùng YouTube Data API v3 qua **API key của người dùng** hoặc **OAuth Google tuỳ chọn** để gọi `videos.list`, xác định video thường / livestream đang phát / livestream sắp phát. Mặc định kiểm tra hàng chờ mỗi 30 giây.
3. **Kiểm tra ngay khi trình duyệt khởi động** — extension tải lại RSS và probe tối đa 5 entry gần nhất của mỗi kênh bằng `videos.list`. Nếu một livestream đã bắt đầu trong lúc Edge/Chrome tắt, tab của livestream đó sẽ tự mở một lần trong phiên trình duyệt mới. Các video thường hoặc livestream đã kết thúc chỉ được probe để xác định trạng thái và không bị mở lại.

Không còn cơ chế tải HTML của trang kênh hoặc trang `watch` để suy đoán dữ liệu. Các thao tác tra cứu handle/tên kênh và phân loại video dùng endpoint chính thức của YouTube Data API.

### Thêm kênh

- Dán channel ID dạng `UC...` hoặc URL `/channel/UC...`: dùng được không cần Google sign-in; extension lấy thông tin cơ bản từ feed.
- Dán `@handle`, URL `/user/...`, `/c/...` hoặc tìm theo tên: cần API key hoặc một phiên OAuth Google đang kết nối để tra cứu bằng YouTube Data API.
- Chọn **Kết nối Google & tải kênh đã đăng ký**: hoàn toàn tuỳ chọn. Extension yêu cầu duy nhất scope chỉ đọc `https://www.googleapis.com/auth/youtube.readonly` để tải subscriptions và gọi YouTube Data API trong phiên hiện tại.

Google sign-in **không phải** đăng nhập vào Auto Mở Live và không cần thiết để mở extension hoặc website.

## Quyền riêng tư và OAuth

- Không có backend của nhà phát triển nhận Google user data.
- OAuth access token chỉ được giữ trong `chrome.storage.session` và bị xoá khi phiên Chrome/Edge kết thúc hoặc người dùng chọn **Ngắt kết nối**.
- Sau khi trình duyệt khởi động lại, extension chỉ lưu một marker không nhạy cảm cho biết người dùng từng cấp quyền và thử `prompt=none` + `interactive:false` để lấy access token mới từ grant/session Google hiện có. Access token không được ghi vào `chrome.storage.local`.
- Nếu silent re-auth không khả dụng (đã logout Google, xoá cookie, revoke quyền...), extension yêu cầu người dùng kết nối lại.
- Danh sách subscriptions vừa tải và thông tin kênh của tài khoản cũng chỉ giữ tạm trong session.
- Khi ngắt kết nối, extension gửi token hiện có tới endpoint thu hồi của Google, xoá dữ liệu OAuth cục bộ và xoá các kênh đã được thêm trực tiếp từ danh sách subscriptions.
- API key do người dùng nhập được lưu trong `chrome.storage.local` cho tới khi người dùng xoá/gỡ extension.

Privacy Policy: https://youtube-notification.chuan-nv.com/privacy-policy.html  
Terms: https://youtube-notification.chuan-nv.com/terms.html

## Cấu trúc repo

```text
extension/          Chrome extension
├── manifest.json
├── background.js   service worker, OAuth, API, alarms, notifications
├── popup.html/js/css
├── lib/            logic parse/decision có test
└── icons/

tests/              node --test
web/                homepage + Privacy Policy + Terms
scripts/            pack extension / fetch fonts
docs/               OAuth, publishing, Cloudflare
.github/workflows/  CI + deploy web
wrangler.jsonc      Cloudflare Workers static assets
```

## Chạy local

```bash
npm test
./scripts/pack-extension.sh
```

Load unpacked:

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked** và trỏ tới `extension/`.
4. Mở popup, thêm channel ID trực tiếp hoặc cấu hình API key / OAuth theo `docs/OAUTH-SETUP.md`.

Manifest hiện giữ trường `key` để extension ID local ổn định. Script đóng gói bản Store sẽ tự bỏ `key` khỏi ZIP phát hành.

## Cấu hình Google Cloud

Xem [docs/OAUTH-SETUP.md](docs/OAUTH-SETUP.md). Các giá trị branding phải đồng bộ:

```text
App name: Auto Mở Live
Homepage: https://youtube-notification.chuan-nv.com/
Privacy Policy: https://youtube-notification.chuan-nv.com/privacy-policy.html
Terms: https://youtube-notification.chuan-nv.com/terms.html
Authorized domain: chuan-nv.com
OAuth scope: https://www.googleapis.com/auth/youtube.readonly
```

Không dùng hostname `www.youtube-notification.chuan-nv.com` trong OAuth Branding nếu hostname đó không phục vụ cùng website.

## Lưu ý về OAuth implementation

Source hiện tại dùng `chrome.identity.launchWebAuthFlow()` và client ID nằm ở hằng số `OAUTH_CLIENT_ID` trong `extension/popup.js`. Không có `manifest.oauth2` trong implementation hiện tại.

Google/Chrome cũng hỗ trợ mô hình Chrome Extension OAuth client + `chrome.identity.getAuthToken()`. Chuyển sang mô hình đó cần tạo **credential mới** trong Google Cloud nên không được tự động thay trong patch này, tránh làm hỏng client ID đang dùng. Nếu muốn migrate, tạo credential mới trước rồi thay luồng một cách có kiểm thử.

## Kiểm thử

```bash
npm test
node --check extension/background.js
node --check extension/popup.js
python3 -m json.tool extension/manifest.json >/dev/null
bash -n scripts/pack-extension.sh
./scripts/pack-extension.sh
```

CI còn kiểm tra branding quan trọng, homepage/Privacy URL và ngăn việc đưa lại cách scrape HTML vào source.

## Xử lý sự cố

**Thêm `@handle` báo cần credential** — đây là hành vi chủ đích. Hãy nhập API key, kết nối Google, hoặc dán channel ID `UC...` trực tiếp.

**Video nằm trong hàng chờ nhưng chưa được mở** — extension cần API key hoặc OAuth session để phân loại chính xác trạng thái bằng `videos.list`; nó không tải HTML trang YouTube để đoán trạng thái.

**OAuth báo `redirect_uri_mismatch` / `invalid_client`** — kiểm tra client ID trong `extension/popup.js` và Redirect URI hiển thị ở popup theo `docs/OAUTH-SETUP.md`.

**OAuth Verification báo homepage nằm sau login** — kiểm tra Cloud Console dùng chính xác `https://youtube-notification.chuan-nv.com/`, mở URL đó ở Incognito và xác nhận nội dung app + Privacy Policy hiện công khai mà không cần sign-in.
