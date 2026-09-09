# YouTube Kênh Yêu Thích — Tự Mở Video Mới

Extension Chrome: chọn các kênh YouTube muốn theo dõi, extension tự động kiểm tra định kỳ
(mặc định 10 phút/lần) qua YouTube Data API. Khi kênh đăng video mới, extension sẽ:

- Mở 1 tab mới đến video đó (tối đa 3 tab mỗi vòng kiểm tra)
- Hiện thông báo desktop kèm tiêu đề video

Có 2 cách thêm kênh vào danh sách theo dõi:

1. Dán URL kênh / `@handle` / tên kênh vào ô "Thêm kênh theo dõi" — chỉ cần API key
2. Bấm "Đăng nhập Google & tải danh sách đã subscribe" — cần thêm OAuth client ID,
   xem [docs/OAUTH-SETUP.md](docs/OAUTH-SETUP.md)

---

## Cấu trúc repo

Repo chứa hai thứ tách bạch, mỗi thứ có vòng đời triển khai riêng:

```
extension/          Mã nguồn Chrome extension → nộp Chrome Web Store
├── manifest.json
├── background.js       service worker: hẹn giờ, gọi API, mở tab
├── popup.html/js/css   giao diện quản lý kênh
└── icons/

web/                Landing page + chính sách bảo mật → deploy Cloudflare
├── index.html
├── privacy-policy.html
├── 404.html
├── fonts.css           sinh tự động, đừng sửa tay
└── fonts/              font self-host (.woff2)

docs/
├── OAUTH-SETUP.md          tạo API key và OAuth client ID trên Google Cloud
├── PUBLISHING.md           nộp lên Chrome Web Store
└── DEPLOY-CLOUDFLARE.md    deploy web + cấu hình auto-deploy

scripts/
├── pack-extension.sh   đóng gói extension/ thành zip nộp Web Store
└── fetch-fonts.sh      tải lại font từ Google Fonts về web/fonts/

.github/workflows/
├── ci.yml              kiểm tra extension + web mỗi lần push, build sẵn zip
└── deploy.yml          tự deploy web/ lên Cloudflare khi push lên main

wrangler.jsonc      cấu hình Cloudflare Workers (assets → ./web)
```

**Vì sao chung một repo:** Chrome Web Store bắt buộc có URL chính sách bảo mật công khai, mà
nội dung chính sách đó phải mô tả đúng hành vi của extension. Hai thứ luôn phải đổi cùng lúc —
tách repo chỉ tạo cơ hội cho chúng lệch nhau. Script `pack-extension.sh` đảm bảo file zip nộp
Web Store không lẫn phần web.

---

## Bắt đầu nhanh

### 1. Lấy API key

Bắt buộc — extension dùng nó để kiểm tra video mới. Xem
[docs/OAUTH-SETUP.md](docs/OAUTH-SETUP.md#api-key-bắt-buộc-khác-với-oauth).

### 2. Cài extension vào Chrome

1. Mở `chrome://extensions`
2. Bật **Developer mode** (góc trên bên phải)
3. Bấm **Load unpacked** → chọn thư mục **`extension/`** (thư mục chứa `manifest.json`)
4. Bấm icon extension để mở popup, dán API key, bấm **Lưu cấu hình**, rồi thêm kênh

Extension ID cố định là **`meifbaclchfimfdjmpgpkehniloimnfa`** — nhờ trường `"key"` trong
`manifest.json`, ID không đổi giữa các lần cài lại. OAuth client ID gắn với ID này nên
**đừng xoá trường `key`**.

### 3. (Tuỳ chọn) Bật tính năng tải danh sách đã subscribe

Làm theo [docs/OAUTH-SETUP.md](docs/OAUTH-SETUP.md). Bỏ qua cũng được — thêm kênh thủ công
vẫn đủ dùng, và popup sẽ hiện nhắc nhở thay vì báo lỗi khó hiểu.

---

## Cách hoạt động

- `background.js` chạy nền (service worker), dùng `chrome.alarms` kiểm tra theo chu kỳ
- Với mỗi kênh, gọi API lấy playlist "uploads" rồi so video mới nhất với mốc đã lưu
- Lần đầu thêm kênh, extension **chốt mốc ngay** (video mới nhất hiện tại) và không mở tab —
  tránh mở hàng loạt tab cho video cũ. Từ đó về sau, có video mới hơn mốc thì mới mở tab
- Mỗi vòng kiểm tra mở **tối đa 3 tab**; kênh có video mới ngoài giới hạn đó vẫn được báo
  notification. Giới hạn này tránh việc bung hàng chục tab khi máy tắt lâu ngày
- Bấm **"Kiểm tra ngay"** trong popup để chạy ngay thay vì chờ hết chu kỳ

## Phát triển

```bash
./scripts/pack-extension.sh   # tạo dist/*.zip để nộp Web Store
./scripts/fetch-fonts.sh      # tải lại font cho web/ (chỉ khi đổi bộ font)
npx wrangler deploy           # deploy web/ thủ công lên Cloudflare
```

Mỗi lần push lên `main`, CI tự kiểm tra manifest, cú pháp JS, `<meta charset>` của các trang
web, và build sẵn file zip (tải ở tab **Actions** → artifact `extension-zip`).

## Xử lý sự cố

**Chrome không load được extension** → kiểm tra `manifest.json` có khai báo `default_locale`
mà thiếu thư mục `_locales/` không. CI đã có bước chặn lỗi này.

**Popup báo lỗi đỏ dưới ô API key** → API key sai, chưa bật YouTube Data API v3, hoặc hết
quota ngày. Tăng chu kỳ kiểm tra trong popup nếu hay chạm hạn mức.

**Nút đăng nhập Google báo `access_denied` / `invalid_client`** → xem lại
[docs/OAUTH-SETUP.md](docs/OAUTH-SETUP.md): client ID đã dán đúng chưa, Extension ID trong
Google Cloud có khớp `meifbaclchfimfdjmpgpkehniloimnfa` không, email đăng nhập có trong danh
sách **Test users** không. Sửa `manifest.json` xong phải bấm **Reload (⟳)** ở
`chrome://extensions`.

**Không thấy notification** → kiểm tra quyền thông báo của Chrome ở cấp hệ điều hành
(macOS: System Settings → Notifications → Google Chrome).

**Trang web hiện chữ tiếng Việt vỡ (`KÃªnh`)** → thiếu `<meta charset="UTF-8">` trong file
HTML. CI có bước chặn lỗi này trước khi deploy.
