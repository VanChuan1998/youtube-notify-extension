// Logic quyết định thuần: không chạm chrome.*, không gọi mạng.
// Tách riêng để test được bằng `node --test` (xem tests/).

/** Số ID video gần nhất nhớ cho mỗi kênh. Feed chỉ trả 15 entry nên 40 là dư dả. */
export const SEEN_LIMIT = 40;

/** Tối đa ID gộp trong một lệnh videos.list. Vượt quá thì API từ chối. */
export const VIDEOS_LIST_BATCH = 50;

/** Còn hơn ngần này tới giờ phát thì chưa cần kiểm tra dày. */
export const NEAR_START_MS = 10 * 60 * 1000;

/** Kiểm tra thưa cho stream còn xa, để không đốt quota suốt nhiều ngày. */
export const FAR_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Bỏ theo dõi stream đã lên lịch nhưng không bao giờ diễn ra. */
export const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Tìm video chưa từng thấy ở kênh này.
 *
 * Không dùng "so với ID mới nhất" vì thứ tự entry trong feed đổi khi video cũ
 * được cập nhật — cách đó sẽ bắn nhầm video cũ như thể vừa đăng.
 */
export function findNewVideos(feedVideos, seenVideoIds) {
  const seen = new Set(seenVideoIds || []);
  return feedVideos.filter((v) => !seen.has(v.videoId));
}

/** Thêm ID vào danh sách đã thấy, giữ tối đa SEEN_LIMIT phần tử mới nhất. */
export function rememberSeen(seenVideoIds, newIds) {
  const merged = [...newIds, ...(seenVideoIds || [])];
  const unique = [];
  const seen = new Set();
  for (const id of merged) {
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  return unique.slice(0, SEEN_LIMIT);
}

/**
 * Chuẩn hoá một video resource từ videos.list thành trạng thái nội bộ.
 *
 * liveBroadcastContent một mình là chưa đủ: nó vẫn báo "live" trong khoảng ngắn
 * sau khi stream kết thúc. Có actualEndTime nghĩa là đã tàn, coi như video thường.
 */
export function classifyVideo(item) {
  const snippet = item.snippet || {};
  const live = item.liveStreamingDetails || {};
  const broadcast = snippet.liveBroadcastContent || "none";

  if (live.actualEndTime) return "ended";
  if (broadcast === "live" && live.actualStartTime) return "live";
  if (broadcast === "upcoming") return "upcoming";
  if (broadcast === "live") return "upcoming"; // báo live nhưng chưa thực sự bắt đầu

  // Một số livestream vừa kết thúc có thể chuyển liveBroadcastContent về "none"
  // trước khi actualEndTime xuất hiện ổn định. Nếu đã từng có actualStartTime thì
  // chắc chắn đây không còn là video "upcoming" nữa -> coi là ended để dọn hàng chờ.
  if (live.actualStartTime) return "ended";

  return "none";
}

/**
 * Có mở tab cho video này không?
 *
 * mode "liveOnly": chỉ mở khi livestream thực sự lên sóng.
 * mode "all"     : mở cho video thường và livestream đã lên sóng, nhưng không mở
 *                  cho stream mới lên lịch — mở lúc đó là mở vào màn hình đếm ngược.
 */
export function shouldOpenTab(state, mode) {
  if (state === "live") return true;
  if (state === "upcoming") return false;
  if (state === "ended") return mode !== "liveOnly";
  return mode !== "liveOnly"; // "none" — video thường
}

/**
 * Đã tới lúc kiểm tra lại video đang chờ chưa?
 *
 * Stream lên lịch vài ngày sau mà cứ kiểm tra 30 giây/lần thì phí quota vô ích.
 * Chỉ siết nhịp khi sắp tới giờ phát, hoặc khi không biết giờ phát.
 */
export function shouldRecheck(entry, now) {
  const last = entry.lastCheckedAt || 0;
  if (!entry.scheduledStartTime) return true; // không rõ giờ -> luôn kiểm tra

  const startsAt = Date.parse(entry.scheduledStartTime);
  if (Number.isNaN(startsAt)) return true;
  if (startsAt - now <= NEAR_START_MS) return true; // sắp tới giờ -> kiểm tra mọi vòng

  return now - last >= FAR_CHECK_INTERVAL_MS;
}

/** Video chờ quá lâu mà không lên sóng thì bỏ, tránh phình vô hạn. */
export function isExpired(entry, now) {
  return now - (entry.firstSeenAt || 0) > PENDING_TTL_MS;
}

/** Chia danh sách ID thành từng lô vừa giới hạn của videos.list. */
export function chunkIds(ids, size = VIDEOS_LIST_BATCH) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
