# Deploy landing page lên Cloudflare (youtube.chuan-nv.com)

Cloudflare hiện khuyến nghị dùng **Workers Static Assets** thay vì Pages cho project mới (Pages
vẫn chạy nhưng không còn được đầu tư tính năng mới). Hướng dẫn dưới đây deploy 2 file tĩnh
(`web/index.html` — landing page, `web/privacy-policy.html`) lên 1 Worker, rồi gắn subdomain
riêng trỏ vào domain `chuan-nv.com` bạn đang quản lý trên Cloudflare.

Thư mục `web/` và file `wrangler.jsonc` đã có sẵn trong repo, không cần tạo project mới bằng
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

Sửa file trong `web/`, commit và push lên `main`. **GitHub Actions tự deploy** — xem mục dưới.

Muốn deploy thủ công thì vẫn được:

```bash
npx wrangler deploy
```

Domain tuỳ chỉnh vẫn giữ nguyên, không cần cấu hình lại.

## Tự động deploy bằng GitHub Actions

Workflow `.github/workflows/deploy.yml` chạy mỗi khi push lên `main` có thay đổi trong `web/`
hoặc `wrangler.jsonc`. Cần khai báo 2 secret một lần duy nhất.

### Lấy Account ID

1. Vào https://dash.cloudflare.com
2. Chọn **Workers & Pages** ở menu bên trái
3. Account ID hiện ở cột bên phải — bấm để copy

### Tạo API token

1. Vào https://dash.cloudflare.com/profile/api-tokens
2. **Create Token** → chọn template **Edit Cloudflare Workers** → **Use template**
3. Ở **Account Resources**, giới hạn đúng account của bạn
4. Ở **Zone Resources**, chọn `chuan-nv.com` (cần cho việc gắn custom domain)
5. **Continue to summary** → **Create Token** → copy chuỗi token

> Token chỉ hiện đúng một lần. Copy ngay, và **đừng commit vào repo hay dán vào chat** —
> nó cho phép sửa mọi Worker trong account. Nếu lỡ lộ, quay lại trang trên và bấm **Roll**
> để đổi token mới.

### Dán vào GitHub

Trong repo trên GitHub: **Settings → Secrets and variables → Actions → New repository secret**,
tạo lần lượt 2 secret:

| Tên secret | Giá trị |
|---|---|
| `CLOUDFLARE_API_TOKEN` | token vừa tạo |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID vừa copy |

Xong. Lần push tiếp theo chạm `web/` sẽ tự deploy. Muốn chạy tay thì vào tab **Actions** →
**Deploy web lên Cloudflare** → **Run workflow**.

Nếu thiếu secret, workflow dừng ngay ở bước đầu với thông báo rõ ràng thay vì để `wrangler`
báo lỗi xác thực khó hiểu.

## Nếu muốn dùng Cloudflare Pages thay vì Workers

Vẫn được hỗ trợ, chỉ khác ở bước tạo project: **Workers & Pages → Create application → Pages
→ Upload assets**, kéo thả thư mục `web/` vào, rồi cũng vào **Custom domains** để gắn
`youtube.chuan-nv.com` tương tự Bước 3.
