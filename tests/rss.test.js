import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseFeed, parseChannelInfo, feedUrlForChannel } from "../extension/lib/rss.js";

const here = dirname(fileURLToPath(import.meta.url));
// Feed thật tải từ kênh Lofi Girl, chứa đủ ba trường hợp: video thường,
// livestream đang phát, và livestream đã lên lịch nhưng chưa lên sóng.
const FEED = readFileSync(join(here, "fixtures", "channel-feed.xml"), "utf-8");

test("feedUrlForChannel dựng đúng URL và escape id", () => {
  assert.equal(
    feedUrlForChannel("UCSJ4gkVC6NrvII8umztf0Ow"),
    "https://www.youtube.com/feeds/videos.xml?channel_id=UCSJ4gkVC6NrvII8umztf0Ow"
  );
  assert.ok(feedUrlForChannel("a b").endsWith("a%20b"));
});

test("parseFeed đọc được toàn bộ entry", () => {
  const videos = parseFeed(FEED);
  assert.equal(videos.length, 15, "feed YouTube luôn trả 15 entry");
});

test("parseFeed bóc đúng các trường của một entry", () => {
  const first = parseFeed(FEED)[0];
  assert.match(first.videoId, /^[\w-]{11}$/);
  assert.equal(first.channelId, "UCSJ4gkVC6NrvII8umztf0Ow");
  assert.ok(first.title.length > 0);
  assert.match(first.published, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(first.thumbnail, /^https:\/\//);
});

test("parseFeed không trả entry thiếu videoId", () => {
  for (const v of parseFeed(FEED)) {
    assert.ok(v.videoId, "mọi entry phải có videoId");
  }
});

test("videoId là duy nhất trong feed", () => {
  const ids = parseFeed(FEED).map((v) => v.videoId);
  assert.equal(new Set(ids).size, ids.length);
});

test("parseChannelInfo lấy tên kênh mà không cần API key", () => {
  const info = parseChannelInfo(FEED);
  assert.equal(info.id, "UCSJ4gkVC6NrvII8umztf0Ow");
  assert.ok(info.title.length > 0);
  // Phải là tên KÊNH ở cấp feed, không phải title của entry đầu tiên
  assert.notEqual(info.title, parseFeed(FEED)[0].title);
});

test("giải mã thực thể XML, không giải mã hai lần", () => {
  const xml = `<feed><entry>
    <yt:videoId>abc12345678</yt:videoId>
    <title>Tom &amp;amp; Jerry &lt;3 &quot;hay&quot;</title>
  </entry></feed>`;
  // &amp;amp; phải ra "&amp;" chứ không phải "&" — nếu giải mã hai lần sẽ sai
  assert.equal(parseFeed(xml)[0].title, 'Tom &amp; Jerry <3 "hay"');
});

test("feed rỗng hoặc rác không làm vỡ parser", () => {
  assert.deepEqual(parseFeed(""), []);
  assert.deepEqual(parseFeed("<feed></feed>"), []);
  assert.deepEqual(parseFeed("không phải xml"), []);
});

test("KHÔNG tin thẻ yt:channelId ở cấp feed — YouTube trả thiếu tiền tố UC", () => {
  // Lỗi có thật trong feed của YouTube: thẻ cấp feed trả "SJ4gk..." còn thẻ
  // trong entry trả "UCSJ4gk...". Nếu parser tin thẻ cấp feed thì chế độ
  // RSS-only sẽ lưu sai channelId và mọi lần tải feed sau đều 404.
  assert.match(FEED, /<yt:channelId>SJ4gkVC6NrvII8umztf0Ow<\/yt:channelId>/,
    "fixture phải giữ nguyên lỗi này của YouTube để test còn ý nghĩa");
  assert.equal(parseChannelInfo(FEED).id, "UCSJ4gkVC6NrvII8umztf0Ow");
});

test("lấy được channelId ngay cả khi chỉ có link alternate", () => {
  const xml = `<feed>
    <link rel="alternate" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"/>
    <title>Kênh Thử</title>
  </feed>`;
  assert.deepEqual(parseChannelInfo(xml), { id: "UCabcdefghijklmnopqrstuv", title: "Kênh Thử" });
});

test("không tìm được channelId thì trả chuỗi rỗng, không ném lỗi", () => {
  assert.equal(parseChannelInfo("<feed><title>X</title></feed>").id, "");
});
