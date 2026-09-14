# Google OAuth Verification checklist — Auto Mở Live

## Giá trị phải nhập trong Google Auth Platform

```text
App name: Auto Mở Live
Homepage: https://youtube-notification.chuan-nv.com/
Privacy Policy: https://youtube-notification.chuan-nv.com/privacy-policy.html
Terms of Service: https://youtube-notification.chuan-nv.com/terms.html
Authorized domain: chuan-nv.com
Scope: https://www.googleapis.com/auth/youtube.readonly
```

Homepage dùng **không-www**.

## Trước khi submit lại

- Deploy toàn bộ `web/` mới.
- Mở homepage bằng Incognito/không đăng nhập Google; phải đọc được App Purpose, phần Google Account access, Privacy và Terms.
- Xác minh `chuan-nv.com` trong Google Search Console bằng tài khoản có quyền phù hợp với Cloud project.
- Đảm bảo User support email và Developer contact email là mailbox đang hoạt động.
- App logo/naming không giả dạng hoặc dùng branding tổng thể của YouTube; tên sản phẩm là **Auto Mở Live**.
- OAuth consent chỉ yêu cầu `youtube.readonly`.
- Video demo cho thấy popup dùng được trước login, OAuth chỉ bật sau khi bấm nút, sau đó có thể Disconnect.

## Nếu Google vẫn báo “Your home page is behind a login page”

Sau khi deploy bản mới, kiểm tra URL chính xác:

```bash
curl -I https://youtube-notification.chuan-nv.com/
curl -IL https://youtube-notification.chuan-nv.com/
```

Không được redirect tới login hoặc hostname khác. Trong Verification Center/Branding, dùng **Request re-verification**. Nếu giao diện cung cấp lựa chọn cho issue bị nhận định sai, chọn **Request additional review**.

Nếu màn hình yêu cầu reply Trust & Safety nhưng bạn không có email thread, kiểm tra Inbox/Spam/All Mail với người gửi `api-oauth-support@google.com`; đồng thời dùng luồng re-verification/additional review trong Console khi khả dụng.

## Nội dung đề xuất gửi reviewer

```text
Hello Google Trust & Safety team,

We have resolved the homepage and branding issues for Auto Mở Live.

The public homepage is:
https://youtube-notification.chuan-nv.com/

It is accessible without signing in and now clearly explains the app's purpose, that Google authorization is optional, the exact youtube.readonly scope, how Google user data is used, and links to the public Privacy Policy and Terms of Service.

We also updated the extension so Google authorization starts only after an explicit user action, OAuth session data is kept in Chrome session storage, users can disconnect/revoke access, and the app does not scrape YouTube HTML for API-derived functionality.

Privacy Policy:
https://youtube-notification.chuan-nv.com/privacy-policy.html

Terms:
https://youtube-notification.chuan-nv.com/terms.html

Please re-review the application. The prior finding that the homepage is behind a login page does not match the current public homepage.

Thank you.
```


## Re-recording the OAuth demo after a previous grant

If Google no longer shows the consent screen because the test account already granted access:

1. Open the extension popup.
2. Expand **Quản lý quyền Google**.
3. Click **Đặt lại quyền Google** and confirm. This clears local OAuth state and attempts to revoke the current Google OAuth grant.
4. Start screen recording **before** reconnecting.
5. Click **Kết nối Google & tải kênh đã đăng ký**. The next authorization is intentionally requested with `prompt=consent select_account`, so Google should show the account chooser and consent screen again.
6. On the Google consent screen, switch the UI language to **English** if necessary. Record the complete consent screen and the requested `youtube.readonly` permission.
7. Approve access, return to Auto Mở Live, show the loaded subscriptions, add a channel, and demonstrate the user-facing monitoring functionality that uses the scope.
8. Keep the OAuth client ID/address bar visible where practical, and do not edit the video in a way that hides the consent flow.

If Google revocation has not propagated yet, wait briefly and retry. As a fallback, remove Auto Mở Live from Google Account > Third-party connections, then use the reset action again before recording.
