# Auto Mở Live v1.1.8 — dọn trạng thái chờ cũ

## Trường hợp báo lỗi

Người dùng báo video `ZM6xYUYPgPY` còn nằm trong danh sách chờ trên v1.1.7.
Khi kiểm tra trực tiếp trang YouTube, trang hiển thị `Live stream offline`,
`Live stream currently offline` và `1 waiting`. Đây là trạng thái công khai quan sát
được, chưa phải xác nhận `actualEndTime` từ YouTube Data API. Không hardcode video ID
trong code extension; ID chỉ dùng làm tình huống kiểm thử.

## Thay đổi

- Mỗi lần mở popup đều ép kiểm tra pending, cả khi tài khoản còn cached hoặc dùng API key. Không cần chờ alarm/nhịp kiểm tra của lịch phát ở xa.
- `videos.list` dùng `cache: no-store`. Lô API thành công được áp dụng ngay cả khi lô sau lỗi; kết quả ended không bị bỏ lại trong pending.
- Dọn entry có end evidence đã lưu mà không cần mạng; lưu tối đa 40 ID đã kết thúc cho mỗi kênh để RSS/probe không đưa các video gần đây đó trở lại.
- Lưu actualStartTime/actualEndTime và thời điểm xác minh. Stream đã phát không được lùi về upcoming khi phản hồi mới mâu thuẫn; giữ unknown để kiểm tra tiếp.
- Popup/badge dùng cùng tiêu chí hàng chờ: upcoming chưa từng phát, có lịch hợp lệ, không quá lịch 2 giờ, được xác minh trong 10 phút và không có lỗi kiểm tra.
- Mục thiếu lịch, quá lịch, lỗi API hoặc cần xác minh nằm trong phần thu gọn “Cần kiểm tra lại”, không đếm là chờ lên sóng. Chúng vẫn được theo dõi để mở khi API xác nhận live; không suy đoán ended từ việc quá giờ hay từ chữ offline.
- Chặn callback đọc storage cũ trả về muộn dựng lại hàng chờ đã dọn. Popup cập nhật điều kiện hết hạn mỗi 30 giây.
- Giữ immediate add probe, session deduplication, live end/title cleanup, OAuth persistence/reset, privacy và CI Node24.

## Xác minh

87 tests PASS (72 tests trước + 15 tests mới), gồm popup với tài khoản cached,
pending ended, phản hồi API mâu thuẫn, lô API thành công trước lô lỗi, stale UI callback,
no-schedule/overdue upcoming, ghi nhớ ended qua worker restart và tiếp tục mở live từ
mục chưa xác nhận. 11 file JavaScript đã kiểm tra syntax.

Tests API dùng fixture, không phải phản hồi videos.list thực tế của video người dùng.
Trạng thái offline/waiting trên trang YouTube không đủ để khẳng định video đã ended.
Sau khi cập nhật, mở popup để tự revalidate; API xác nhận ended thì mục bị dọn,
còn lịch/trạng thái không xác định thì chuyển sang “Cần kiểm tra lại”.

Nguồn: [YouTube videos resource](https://developers.google.com/youtube/v3/docs/videos#liveStreamingDetails.actualEndTime)
mô tả actualEndTime chỉ có sau khi stream kết thúc, còn scheduledEndTime là thời gian dự kiến.
