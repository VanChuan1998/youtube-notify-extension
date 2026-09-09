// Parse RSS feed của kênh YouTube: https://www.youtube.com/feeds/videos.xml?channel_id=UC...
//
// Feed này miễn phí, không cần API key và không tính vào quota YouTube Data API,
// nên là cách rẻ nhất để phát hiện video mới. Đổi lại nó KHÔNG cho biết video có
// phải livestream hay không — livestream xuất hiện trong feed ngay khi được lên
// lịch, còn rất lâu trước lúc lên sóng. Việc phân biệt do lib/decide.js lo.
//
// Service worker không có DOMParser, nên parse bằng regex. Feed do YouTube sinh
// ra nên định dạng ổn định và phẳng; đây không phải parser XML tổng quát.

const FEED_URL = "https://www.youtube.com/feeds/videos.xml";

export function feedUrlForChannel(channelId) {
  return `${FEED_URL}?channel_id=${encodeURIComponent(channelId)}`;
}

// Giải mã các thực thể XML mà YouTube dùng trong title/description.
function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&"); // phải cuối cùng, nếu không sẽ giải mã hai lần
}

function tagContent(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? decodeEntities(m[1].trim()) : "";
}

function attr(xml, tag, name) {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : "";
}

/**
 * Bóc thông tin kênh từ feed. Dùng để lấy tên kênh mà không cần API key —
 * cần cho chế độ RSS-only.
 *
 * CẢNH BÁO: thẻ <yt:channelId> ở CẤP FEED của YouTube bị thiếu tiền tố "UC"
 * (trả "SJ4gk..." thay vì "UCSJ4gk..."), trong khi thẻ cùng tên bên trong mỗi
 * <entry> lại đầy đủ. Vì vậy phải lấy ID từ <link> hoặc từ entry, tuyệt đối
 * không dùng thẻ cấp feed. Xem tests/rss.test.js.
 */
export function parseChannelInfo(xml) {
  // <author><name> nằm ở cấp feed, nhưng mỗi <entry> cũng có <author><name>
  // riêng. Cắt bỏ phần entry trước khi đọc để không lấy nhầm.
  const head = xml.split("<entry>")[0];

  const fromLink = head.match(/channel_id=(UC[\w-]{22})/) || head.match(/\/channel\/(UC[\w-]{22})/);
  const fromEntry = xml.match(/<yt:channelId>(UC[\w-]{22})<\/yt:channelId>/);

  return {
    id: (fromLink && fromLink[1]) || (fromEntry && fromEntry[1]) || "",
    title: tagContent(head, "title") || tagContent(head, "name"),
  };
}

/**
 * Bóc danh sách video từ feed, mới nhất trước.
 *
 * Lưu ý về `published` và `updated`: YouTube cập nhật `updated` khi video được
 * sửa, nên thứ tự entry trong feed có thể đổi mà không có video nào mới. Vì vậy
 * không được dựa vào "entry đầu tiên" để phát hiện video mới — phải so bằng tập
 * ID đã thấy (xem decide.js:findNewVideos).
 */
export function parseFeed(xml) {
  const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  return entries
    .map((entry) => ({
      videoId: tagContent(entry, "yt:videoId"),
      channelId: tagContent(entry, "yt:channelId"),
      title: tagContent(entry, "title"),
      author: tagContent(entry, "name"),
      published: tagContent(entry, "published"),
      updated: tagContent(entry, "updated"),
      thumbnail: attr(entry, "media:thumbnail", "url"),
    }))
    .filter((v) => v.videoId);
}
