# Deploy landing page lên Cloudflare (youtube.chuan-nv.com)

Cloudflare hiện khuyến nghị dùng **Workers Static Assets** thay vì Pages cho project mới (Pages
vẫn chạy nhưng không còn được đầu tư tính năng mới). Hướng dẫn dưới đây deploy 2 file tĩnh
(`site/index.html` — landing page, `site/privacy-policy.html`) lên 1 Worker, rồi gắn subdomain
riêng trỏ vào domain `chuan-nv.com` bạn đang quản lý trên Cloudflare.

Thư mục `site/` và file `wrangler.jsonc` đã có sẵn trong repo, không cần tạo project mới bằng
`create-cloudflare`.

## Yêu cầu

- Node.js đã cài trên máy bạn
- Domain `chuan-nv.com` đã thêm vào tài khoản Cloudflare (nameservers trỏ về Cloudflare) — nếu
  domain chưa nằm trong Cloudflare, cần thêm zone trước ở **Websites → Add a domain**

## Bước 1 — Đăng nhập Wrangler

```bash
cd youtube-notify-extension
npx wrangler login
```

Lệnh này mở trình duyệt để bạn đăng nhập & cấp quyền cho Wrangler CLI trên máy bạn.

## Bước 2 — Deploy

```bash
npx wrangler deploy
```

Wrangler đọc `wrangler.jsonc` (đã cấu hình `assets.directory: "./site"`) và deploy 2 file HTML
lên Worker tên `youtube-kenh-yeu-thich`. Sau khi chạy xong, bạn sẽ nhận được URL dạng:

```
https://youtube-kenh-yeu-thich.<subdomain-tài-khoản>.workers.dev
```

Mở thử URL này để kiểm tra trang đã lên đúng chưa trước khi gắn domain riêng.

## Bước 3 — Gắn subdomain youtube.chuan-nv.com

1. Vào https://dash.cloudflare.com → **Workers & Pages**
2. Chọn Worker `youtube-kenh-yeu-thich`
3. Tab **Settings → Domains & Routes** → **Add → Custom Domain**
4. Nhập `youtube.chuan-nv.com` → **Add Domain**

Vì `chuan-nv.com` đã quản lý DNS trên Cloudflare, hệ thống tự tạo bản ghi DNS cần thiết (thường
là CNAME/AAAA proxy) và cấp SSL — không cần vào tab DNS thêm thủ công. Sau vài phút,
`https://youtube.chuan-nv.com` sẽ hoạt động.

## Cập nhật trang sau này

Sửa file trong `site/index.html` hoặc `site/privacy-policy.html`, rồi chạy lại:

```bash
npx wrangler deploy
```

Domain tuỳ chỉnh vẫn giữ nguyên, không cần cấu hình lại.

## Nếu muốn dùng Cloudflare Pages thay vì Workers

Vẫn được hỗ trợ, chỉ khác ở bước tạo project: **Workers & Pages → Create application → Pages
→ Upload assets**, kéo thả thư mục `site/` vào, rồi cũng vào **Custom domains** để gắn
`youtube.chuan-nv.com` tương tự Bước 3.
