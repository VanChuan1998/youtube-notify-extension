# Auto Mở Live v1.1.7

## Sửa lỗi thêm kênh đang livestream

v1.1.6 chỉ chốt mốc RSS trong `initChannelBaseline()`: đưa video vào `seenVideoIds`,
không đưa vào `pending` và không gọi `videos.list`. Các lần discovery sau loại video
đã seen nên không đến bước notification/tab. Hàm còn trả về ngay nếu kênh đã initialized.

v1.1.7 thêm probe riêng cho đúng kênh khi thêm thủ công, thêm từ subscriptions hoặc
bật lại theo dõi. Probe lấy RSS không dùng conditional headers/cache, kiểm tra tối đa
15 video gần nhất kể cả đã seen, và ép phân loại pending của kênh đó ngay cả khi lịch
recheck chưa đến. Không cần chờ alarm hoặc transition upcoming → live.

- API xác nhận live: mở tab và thông báo theo mode hiện có; giữ live trong pending để theo dõi đến khi kết thúc.
- Upcoming: giữ pending; chỉ hiển thị upcoming trong card chờ.
- Normal/ended trong probe lịch sử: cập nhật title nếu đúng video mới nhất, không mở tab/thông báo lịch sử, kể cả mode all.
- Video mới xuất hiện về sau: giữ hành vi cũ của mode all/liveOnly.
- RSS lỗi: lưu ý định probe để discovery thử lại. API lỗi/thiếu credential: giữ pending; kết nối Google hoặc lưu API key hợp lệ sẽ phân loại lại ngay.
- `Kiểm tra ngay` và startup kiểm tra lại video gần đây đã seen (startup vẫn tối đa 5/kênh đã initialized).

## Các lỗi liên quan đã sửa

Background xử lý tuần tự các lượt monitoring và thao tác channel. Popup gửi yêu cầu
thêm/sửa/xóa đến background thay vì tự đọc rồi ghi đè toàn bộ channels. Re-add giữ mode
và seen IDs; thao tác Enter lặp trong lúc thêm bị chặn. Xóa/tắt theo dõi/ngắt kết nối
dọn pending thuộc các kênh liên quan; pending mồ côi không được mở tab.

Marker tab và notification tách riêng trong session; chỉ đánh dấu sau khi thao tác
thành công. Tab lỗi hoặc vượt trần 3 tab/lượt còn được thử lại mà không lặp notification.
Không loại marker cũ chỉ vì đã vượt 100 livestream trong cùng phiên. Worker restart
giữ marker; browser restart tạo phiên mới. Lỗi storage được truyền qua Promise.

Title cuối cùng vẫn được cập nhật khi API trả ended, cả trên probe, và stream cũ không
ghi đè title của video mới hơn. Live chuyển về normal cũng không phát lại thông báo.

OAuth vẫn dùng youtube.readonly, session token, persistent grant marker, silent restore,
retry 401 một lần và reset consent một lần. Không đổi client ID, key phát triển,
host permissions, privacy policy, website, Wrangler hay workflow Node 24.

## Kiểm thử

`npm test` trên môi trường Node 24 thông thường.
Trong sandbox Windows chặn tiến trình con: `node --test --test-isolation=none tests/*.test.js`.
Các tests chạy source worker/popup thật với Chrome API, DOM và phản hồi RSS/YouTube giả lập;
không gọi tài khoản Google hoặc mở tab trong trình duyệt của người dùng.

Kiểm tra thực tế sau khi cập nhật: thêm kênh hiện đang live và có video đó trong RSS,
kiểm tra notification/tab; bấm Kiểm tra ngay không mở lại; theo dõi stream đến khi end;
đóng hoàn toàn browser rồi mở lại trong lúc live vẫn chạy để kiểm tra mở lại một lần.

RSS có giới hạn lịch sử: livestream không nằm trong các entry được trả về và không có
trong pending sẽ không được phát hiện bởi probe RSS này. API key/OAuth hợp lệ và API
xác nhận live là điều kiện để tự mở. Giới hạn 3 tab/lượt vẫn được giữ.
