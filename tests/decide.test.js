import test from "node:test";
import assert from "node:assert/strict";

import {
  findNewVideos,
  rememberSeen,
  classifyVideo,
  shouldOpenTab,
  shouldRecheck,
  isExpired,
  chunkIds,
  SEEN_LIMIT,
  NEAR_START_MS,
  FAR_CHECK_INTERVAL_MS,
  PENDING_TTL_MS,
} from "../extension/lib/decide.js";

const v = (id) => ({ videoId: id, title: id });

// ---------- findNewVideos ----------

test("chỉ trả video chưa từng thấy", () => {
  const got = findNewVideos([v("a"), v("b"), v("c")], ["b"]);
  assert.deepEqual(got.map((x) => x.videoId), ["a", "c"]);
});

test("danh sách đã thấy rỗng hoặc thiếu -> tất cả đều mới", () => {
  assert.equal(findNewVideos([v("a"), v("b")], []).length, 2);
  assert.equal(findNewVideos([v("a")], undefined).length, 1);
});

test("video cũ được cập nhật, nhảy lên đầu feed, KHÔNG bị coi là mới", () => {
  // Đây là lý do dùng tập ID thay vì so với một lastVideoId: YouTube đổi thứ tự
  // entry khi video cũ được sửa, cách cũ sẽ bắn nhầm và mở tab video cũ.
  const feedSauKhiSapXepLai = [v("cu"), v("moi_nhat"), v("cu2")];
  const daThay = ["moi_nhat", "cu", "cu2"];
  assert.deepEqual(findNewVideos(feedSauKhiSapXepLai, daThay), []);
});

// ---------- rememberSeen ----------

test("ID mới đứng trước, không trùng lặp", () => {
  assert.deepEqual(rememberSeen(["b", "c"], ["a", "b"]), ["a", "b", "c"]);
});

test("cắt bớt để không phình vô hạn", () => {
  const cu = Array.from({ length: SEEN_LIMIT + 20 }, (_, i) => `v${i}`);
  const got = rememberSeen(cu, ["moi"]);
  assert.equal(got.length, SEEN_LIMIT);
  assert.equal(got[0], "moi", "ID mới nhất phải được giữ lại");
});

// ---------- classifyVideo ----------

test("video thường", () => {
  assert.equal(classifyVideo({ snippet: { liveBroadcastContent: "none" } }), "none");
  assert.equal(classifyVideo({ snippet: {} }), "none");
  assert.equal(classifyVideo({}), "none");
});

test("livestream đã lên lịch nhưng chưa phát -> upcoming", () => {
  assert.equal(
    classifyVideo({
      snippet: { liveBroadcastContent: "upcoming" },
      liveStreamingDetails: { scheduledStartTime: "2026-09-10T12:00:00Z" },
    }),
    "upcoming"
  );
});

test("livestream đang phát -> live", () => {
  assert.equal(
    classifyVideo({
      snippet: { liveBroadcastContent: "live" },
      liveStreamingDetails: { actualStartTime: "2026-09-09T12:00:00Z" },
    }),
    "live"
  );
});

test('báo "live" nhưng chưa có actualStartTime thì vẫn coi là upcoming', () => {
  // Tránh mở tab vào màn hình đếm ngược.
  assert.equal(
    classifyVideo({ snippet: { liveBroadcastContent: "live" }, liveStreamingDetails: {} }),
    "upcoming"
  );
});


test('livestream đã từng bắt đầu nhưng broadcast đã về "none" -> ended', () => {
  assert.equal(
    classifyVideo({
      snippet: { liveBroadcastContent: "none" },
      liveStreamingDetails: { actualStartTime: "2026-09-09T10:00:00Z" },
    }),
    "ended"
  );
});

test("stream đã kết thúc -> ended, kể cả khi API còn báo live", () => {
  // API vẫn trả liveBroadcastContent "live" một lúc sau khi stream tàn.
  assert.equal(
    classifyVideo({
      snippet: { liveBroadcastContent: "live" },
      liveStreamingDetails: {
        actualStartTime: "2026-09-09T10:00:00Z",
        actualEndTime: "2026-09-09T12:00:00Z",
      },
    }),
    "ended"
  );
});

// ---------- shouldOpenTab ----------

test('mode "all" mở tab cho video thường và stream đã lên sóng', () => {
  assert.equal(shouldOpenTab("none", "all"), true);
  assert.equal(shouldOpenTab("live", "all"), true);
  assert.equal(shouldOpenTab("ended", "all"), true);
});

test('mode "all" KHÔNG mở tab cho stream mới lên lịch', () => {
  assert.equal(shouldOpenTab("upcoming", "all"), false);
});

test('mode "liveOnly" chỉ mở tab khi stream thực sự lên sóng', () => {
  assert.equal(shouldOpenTab("live", "liveOnly"), true);
  assert.equal(shouldOpenTab("none", "liveOnly"), false);
  assert.equal(shouldOpenTab("upcoming", "liveOnly"), false);
  assert.equal(shouldOpenTab("ended", "liveOnly"), false);
});

// ---------- shouldRecheck ----------

const now = Date.parse("2026-09-09T12:00:00Z");
const iso = (ms) => new Date(now + ms).toISOString();

test("không biết giờ phát -> luôn kiểm tra", () => {
  assert.equal(shouldRecheck({ lastCheckedAt: now }, now), true);
  assert.equal(shouldRecheck({ scheduledStartTime: "rác", lastCheckedAt: now }, now), true);
});

test("sắp tới giờ phát -> kiểm tra mọi vòng", () => {
  const entry = { scheduledStartTime: iso(NEAR_START_MS - 1000), lastCheckedAt: now };
  assert.equal(shouldRecheck(entry, now), true);
});

test("giờ phát còn xa -> giãn nhịp để tiết kiệm quota", () => {
  const xa = { scheduledStartTime: iso(3 * 24 * 60 * 60 * 1000), lastCheckedAt: now };
  assert.equal(shouldRecheck(xa, now), false, "vừa kiểm tra xong thì chưa cần kiểm tra lại");

  const daLau = { ...xa, lastCheckedAt: now - FAR_CHECK_INTERVAL_MS - 1 };
  assert.equal(shouldRecheck(daLau, now), true);
});

test("stream quá giờ phát mà chưa lên sóng vẫn được kiểm tra", () => {
  const treGio = { scheduledStartTime: iso(-60 * 1000), lastCheckedAt: now };
  assert.equal(shouldRecheck(treGio, now), true);
});

// ---------- isExpired ----------

test("bỏ theo dõi stream lên lịch rồi không bao giờ diễn ra", () => {
  assert.equal(isExpired({ firstSeenAt: now - PENDING_TTL_MS - 1 }, now), true);
  assert.equal(isExpired({ firstSeenAt: now - 1000 }, now), false);
});

// ---------- chunkIds ----------

test("chia lô đúng giới hạn của videos.list", () => {
  const ids = Array.from({ length: 120 }, (_, i) => `v${i}`);
  const lo = chunkIds(ids);
  assert.deepEqual(lo.map((c) => c.length), [50, 50, 20]);
  assert.deepEqual(lo.flat(), ids, "không được mất hay đổi thứ tự ID");
});

test("danh sách rỗng -> không có lô nào, tức là không gọi API lần nào", () => {
  assert.deepEqual(chunkIds([]), []);
});
