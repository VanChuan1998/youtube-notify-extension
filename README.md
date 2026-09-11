# Auto Mở Live Youtube

Extension Chrome: chọn các kênh YouTube muốn theo dõi, extension tự động kiểm tra định kỳ
(mặc định 10 phút/lần) qua YouTube Data API. Khi kênh đăng video mới, extension sẽ:

- Mở 1 tab mới đến video đó (tối đa 3 tab mỗi vòng kiểm tra)
- Hiện thông báo desktop kèm tiêu đề video

**Bắt đúng lúc livestream lên sóng.** Kênh lên lịch stream trước cả tuần thì extension
không mở tab ngay — nó ghi vào danh sách chờ và canh, rồi mở tab **trong vòng 30 giây**
kể từ lúc stream thực sự bắt đầu phát.

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
├── background.js       service worker: hai vòng lặp hẹn giờ, mở tab
├── lib/
│   ├── rss.js          parse RSS feed của kênh
│   └── decide.js       logic phân loại và quyết định (được test)
├── popup.html/js/css   giao diện quản lý kênh
└── icons/

tests/              test chạy bằng `node --test`, không nằm trong bản nộp Store
├── rss.test.js
├── decide.test.js
└── fixtures/

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

Hai vòng lặp chạy độc lập trong service worker:

**Vòng 1 — phát hiện video mới (mặc định 60 giây)**
Tải RSS feed `youtube.com/feeds/videos.xml?channel_id=…` của từng kênh. Feed này **miễn phí,
không cần API key và không tính vào quota**, nên theo dõi bao nhiêu kênh cũng được. Dùng
`If-None-Match` nên phần lớn lần gọi trả 304 rỗng. Video ID chưa từng thấy → đẩy vào hàng chờ.

**Vòng 2 — theo dõi trạng thái live (mặc định 30 giây)**
Gom toàn bộ ID đang chờ vào **một** lệnh `videos.list` (1 unit, tối đa 50 ID mỗi lần):

| Trạng thái | Hành động |
|---|---|
| Video thường | Mở tab (nếu kênh đặt "Mọi video") |
| Livestream **đang phát** | **Mở tab ngay** + thông báo 🔴 |
| Livestream **mới lên lịch** | Giữ trong hàng chờ, canh tiếp |
| Video bị xoá/ẩn | Bỏ khỏi hàng chờ |

Vì sao phải có vòng 2: livestream xuất hiện trong RSS **ngay từ lúc được lên lịch**, rất lâu
trước khi lên sóng. Không cơ chế push nào — kể cả WebSub/PubSubHubbub — báo thời điểm chuyển
sang live, nên bắt buộc phải poll trạng thái video. Mở tab lúc thấy trong feed sẽ chỉ mở vào
màn hình đếm ngược.

**Quota:** khi hàng chờ rỗng thì vòng 2 không gọi API lần nào. Thực tế phần lớn thời gian tốn
**0 unit**; trường hợp xấu nhất ~2.880 unit/ngày, **không phụ thuộc số kênh** (hạn mức 10.000).
Stream lên lịch còn xa thì chỉ kiểm tra mỗi 5 phút, chỉ siết xuống 30 giây khi sắp tới giờ.

**Chế độ theo từng kênh:** mỗi kênh chọn *Mọi video* hoặc *Chỉ livestream* trong popup.

**Không có API key?** Vẫn chạy được — vòng 1 hoạt động bình thường, chỉ là không phân biệt
được livestream đã lên sóng hay chưa. Thêm kênh bằng URL, `@handle` hoặc `UC…` đều được.

**Giới hạn Chrome:** `chrome.alarms` không cho chạy dày hơn 30 giây với extension đã đóng gói.

## Phát triển

```bash
npm test                      # chạy test (node --test, không cần cài gì thêm)
./scripts/pack-extension.sh   # tạo dist/*.zip để nộp Web Store
./scripts/fetch-fonts.sh      # tải lại font cho web/ (chỉ khi đổi bộ font)
npx wrangler deploy           # deploy web/ thủ công lên Cloudflare
```

Mỗi lần push lên `main`, CI chạy test, kiểm tra manifest, cú pháp JS, `<meta charset>` của các
trang web, và build sẵn file zip (tải ở tab **Actions** → artifact `extension-zip`).

Logic thuần nằm ở `extension/lib/` để test được bằng Node mà không cần môi trường Chrome.
Fixture là feed RSS thật — trong đó có một lỗi của chính YouTube: thẻ `<yt:channelId>` ở cấp
feed bị thiếu tiền tố `UC`, nên parser phải lấy ID từ `<link>` thay vì tin thẻ đó.

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
