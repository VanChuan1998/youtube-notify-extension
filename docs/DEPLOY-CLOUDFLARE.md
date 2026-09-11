# Deploy website lên Cloudflare

Website public của dự án:

```text
https://youtube-notification.chuan-nv.com/
```

`wrangler.jsonc` đang phục vụ static assets từ `./web` và gắn custom domain `youtube-notification.chuan-nv.com`.

## Deploy thủ công

```bash
npm install   # chỉ nếu môi trường chưa có wrangler/npx cần dependency
npx wrangler@4 deploy
```

Sau deploy, kiểm tra:

```bash
curl -I https://youtube-notification.chuan-nv.com/
curl -I https://youtube-notification.chuan-nv.com/privacy-policy.html
curl -I https://youtube-notification.chuan-nv.com/terms.html
curl -IL https://youtube-notification.chuan-nv.com/
```

Homepage phải trả nội dung public mà không có redirect tới login hoặc domain khác.

## GitHub Actions

Workflow `.github/workflows/deploy.yml` deploy khi `web/` hoặc `wrangler.jsonc` thay đổi trên `main`.

Repository secrets cần có:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

API token chỉ cần quyền tối thiểu đủ để deploy Worker/static assets và quản lý route/domain của project này. Không commit token vào repo.

## Custom domain

Trong Cloudflare Workers & Pages, custom domain phải là:

```text
youtube-notification.chuan-nv.com
```

Không khai báo `www.youtube-notification.chuan-nv.com` trong Google OAuth Branding trừ khi bạn thật sự cấu hình hostname đó hoạt động và phục vụ cùng website. Với cấu hình hiện tại, OAuth Homepage dùng bản không có `www`.

## Checklist sau deploy cho OAuth Verification

- Homepage hiển thị tên `Auto Mở Live`.
- Có mô tả chức năng trước khi login.
- Có câu nói rõ homepage công khai và Google sign-in là tuỳ chọn.
- Có phần giải thích `youtube.readonly`.
- Privacy và Terms mở trực tiếp.
- Không có redirect bất ngờ.
- App name/URL trong Google Cloud trùng 100% với website production.
