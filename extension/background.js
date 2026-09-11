// background.js — service worker (Manifest V3)
//
// Hai vòng lặp tách rời:
//
//   1. PHÁT HIỆN (alarm "discover", mặc định 60 giây)
//      Tải RSS feed của từng kênh. Miễn phí, không tốn quota YouTube Data API,
//      không giới hạn số kênh. Video ID chưa từng thấy -> đẩy vào hàng chờ.
//
//   2. THEO DÕI TRẠNG THÁI LIVE (alarm "livecheck", 30 giây)
//      Gom toàn bộ ID đang chờ vào MỘT lệnh videos.list (1 unit, tối đa 50 ID)
//      để biết video là loại gì. Chỉ mở tab khi livestream thực sự lên sóng.
//
// Vì sao phải có vòng 2: livestream xuất hiện trong RSS ngay từ lúc được LÊN LỊCH,
// rất lâu trước khi lên sóng. Không có cơ chế push nào (kể cả WebSub) báo thời
// điểm chuyển sang live — bắt buộc phải poll trạng thái video.
//
// Khi hàng chờ rỗng thì vòng 2 không gọi API lần nào, nên quota gần như bằng 0
// trong phần lớn thời gian.

import { feedUrlForChannel, parseFeed, parseChannelInfo } from "./lib/rss.js";
import {
  findNewVideos,
  rememberSeen,
  classifyVideo,
  shouldOpenTab,
  shouldRecheck,
  isExpired,
  chunkIds,
} from "./lib/decide.js";

const ALARM_DISCOVER = "ytnotify_discover";
const ALARM_LIVECHECK = "ytnotify_livecheck";

const DEFAULT_DISCOVER_SECONDS = 60;
const DEFAULT_LIVECHECK_SECONDS = 30;

// Chrome không cho alarm chạy dày hơn 30 giây với extension đã đóng gói.
const MIN_ALARM_SECONDS = 30;

const API_BASE = "https://www.googleapis.com/youtube/v3";

// Số tab tối đa mở trong một vòng. Nếu máy tắt lâu ngày, nhiều kênh cùng có
// video mới -> tránh bung hàng chục tab một lúc. Phần còn lại vẫn báo notification.
const MAX_TABS_PER_RUN = 3;

// ---------- Storage ----------

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

function getSessionStorage(keys) {
  return new Promise((resolve) => chrome.storage.session.get(keys, resolve));
}

function setSessionStorage(items) {
  return new Promise((resolve) => chrome.storage.session.set(items, resolve));
}

function removeSessionStorage(keys) {
  return new Promise((resolve) => chrome.storage.session.remove(keys, resolve));
}

async function getCachedOAuthToken() {
  const { oauthToken, oauthTokenExpires } = await getSessionStorage({
    oauthToken: "",
    oauthTokenExpires: 0,
  });
  if (!oauthToken || !oauthTokenExpires || Date.now() >= oauthTokenExpires) {
    await removeSessionStorage(["oauthToken", "oauthTokenExpires"]);
    return "";
  }
  return oauthToken;
}

async function getChannels() {
  const { channels } = await getStorage({ channels: {} });
  return channels || {};
}

async function getPending() {
  const { pending } = await getStorage({ pending: {} });
  return pending || {};
}

async function getApiKey() {
  const { apiKey } = await getStorage({ apiKey: "" });
  return (apiKey || "").trim();
}

async function getIntervals() {
  const { discoverSeconds, liveCheckSeconds } = await getStorage({
    discoverSeconds: DEFAULT_DISCOVER_SECONDS,
    liveCheckSeconds: DEFAULT_LIVECHECK_SECONDS,
  });
  return {
    discoverSeconds: Math.max(MIN_ALARM_SECONDS, discoverSeconds || DEFAULT_DISCOVER_SECONDS),
    liveCheckSeconds: Math.max(MIN_ALARM_SECONDS, liveCheckSeconds || DEFAULT_LIVECHECK_SECONDS),
  };
}

async function setStatus(patch) {
  const cur = await getStorage({ status: {} });
  await setStorage({ status: { ...(cur.status || {}), ...patch } });
  await updateBadge();
}

async function updateBadge() {
  const { status, pending } = await getStorage({ status: {}, pending: {} });
  const waiting = Object.keys(pending || {}).length;

  if (status && status.lastError) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#e01e1e" });
  } else if (waiting > 0) {
    // Cho biết đang canh mấy livestream sắp lên sóng.
    chrome.action.setBadgeText({ text: String(waiting) });
    chrome.action.setBadgeBackgroundColor({ color: "#1f7a3d" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// ---------- Alarms ----------

async function ensureAlarms() {
  const { discoverSeconds, liveCheckSeconds } = await getIntervals();
  // Dùng get() trước khi create() — nếu alarm đã tồn tại với đúng chu kì thì bỏ qua,
  // tránh reset vòng đếm hiện tại khi popup mở lại.
  const existing = await new Promise((r) => chrome.alarms.getAll(r));
  const existingMap = Object.fromEntries(existing.map((a) => [a.name, a]));
  const discoverMinutes = discoverSeconds / 60;
  const liveMinutes = liveCheckSeconds / 60;
  if (!existingMap[ALARM_DISCOVER] || Math.abs((existingMap[ALARM_DISCOVER].periodInMinutes || 0) - discoverMinutes) > 0.01) {
    chrome.alarms.create(ALARM_DISCOVER, { periodInMinutes: discoverMinutes });
  }
  if (!existingMap[ALARM_LIVECHECK] || Math.abs((existingMap[ALARM_LIVECHECK].periodInMinutes || 0) - liveMinutes) > 0.01) {
    chrome.alarms.create(ALARM_LIVECHECK, { periodInMinutes: liveMinutes });
  }
}

async function clearLegacyOAuthStorage() {
  // Trước v1.1.1 access token từng được lưu bền trong chrome.storage.local.
  // Từ bản này token chỉ nằm trong chrome.storage.session và mất khi Chrome đóng.
  await chrome.storage.local.remove(["oauthToken", "oauthTokenExpires", "oauthUser", "fetchedSubs", "oauthDataFetchedAt"]);
}

chrome.runtime.onInstalled.addListener(() => {
  clearLegacyOAuthStorage();
  ensureAlarms();
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  clearLegacyOAuthStorage();
  ensureAlarms();
  updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_DISCOVER) discoverNewVideos();
  else if (alarm.name === ALARM_LIVECHECK) checkPendingVideos();
});

// ---------- YouTube Data API ----------

async function apiFetch(path, params, credential = {}) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const headers = {};
  if (credential.oauthToken) {
    headers["Authorization"] = `Bearer ${credential.oauthToken}`;
  } else if (credential.apiKey) {
    url.searchParams.set("key", credential.apiKey);
  }

  const res = await fetch(url.toString(), { headers });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error(`HTTP ${res.status}: phản hồi không phải JSON`);
    err.status = res.status;
    throw err;
  }
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function fetchChannelInfoById(channelId, credential = {}) {
  const data = await apiFetch("/channels", { part: "snippet", id: channelId }, credential);
  const item = data.items && data.items[0];
  if (!item) throw new Error("Không tìm thấy kênh với ID: " + channelId);
  const thumbs = item.snippet.thumbnails || {};
  return {
    id: item.id,
    title: item.snippet.title,
    thumbnail: (thumbs.default || thumbs.medium || {}).url || "",
  };
}

function getAuthToken(interactive, clientId, prompt) {
  return new Promise((resolve, reject) => {
    const scopes = ["https://www.googleapis.com/auth/youtube.readonly"];
    const redirectUrl = chrome.identity.getRedirectURL();
    let authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(
      clientId
    )}&redirect_uri=${encodeURIComponent(
      redirectUrl
    )}&response_type=token&scope=${encodeURIComponent(scopes.join(" "))}`;
    if (prompt) {
      authUrl += `&prompt=${encodeURIComponent(prompt)}`;
    }

    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive },
      (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(new Error(chrome.runtime.lastError?.message || "Đăng nhập thất bại"));
          return;
        }
        try {
          const url = new URL(responseUrl);
          const params = new URLSearchParams(url.hash.substring(1));
          const token = params.get("access_token");
          const expiresIn = parseInt(params.get("expires_in"), 10) || 3600;
          if (token) {
            resolve({ token, expiresIn });
          } else {
            reject(new Error("Không tìm thấy access token trong phản hồi"));
          }
        } catch (err) {
          reject(err);
        }
      }
    );
  });
}

async function fetchUserInfo(token) {
  const data = await apiFetch("/channels", { part: "snippet", mine: "true" }, { oauthToken: token });
  return data.items || [];
}

async function fetchSubscriptions(token) {
  let items = [];
  let pageToken = "";
  let pages = 0;
  const MAX_PAGES = 20; // tối đa 1000 kênh (20 trang x 50) — tránh vòng lặp vô hạn nếu API trả nextPageToken liên tục
  do {
    const params = { part: "snippet", mine: "true", maxResults: "50" };
    if (pageToken) params.pageToken = pageToken;
    const data = await apiFetch("/subscriptions", params, { oauthToken: token });
    if (data.items) {
      items.push(...data.items);
    }
    pageToken = data.nextPageToken || "";
    pages++;
  } while (pageToken && pages < MAX_PAGES);
  return items;
}

// ---------- Phân giải input thành kênh ----------

const CHANNEL_ID_RE = /UC[0-9A-Za-z_-]{22}/;

// Với channel ID đã biết, RSS công khai đủ để lấy tên kênh mà không cần tài khoản Google.
async function channelInfoFromFeed(channelId) {
  const res = await fetch(feedUrlForChannel(channelId));
  if (!res.ok) throw new Error(`Không tải được feed của kênh (HTTP ${res.status})`);
  const info = parseChannelInfo(await res.text());
  if (!info.id) throw new Error("Feed không hợp lệ hoặc kênh không tồn tại");
  return { id: info.id, title: info.title || info.id, thumbnail: "" };
}

async function fetchChannelInfoByHandle(handle, credential) {
  const clean = handle.replace(/^@/, "");
  const data = await apiFetch("/channels", { part: "snippet", forHandle: clean }, credential);
  const item = data.items && data.items[0];
  if (!item) throw new Error("Không tìm thấy kênh với @handle: " + handle);
  const thumbs = item.snippet.thumbnails || {};
  return {
    id: item.id,
    title: item.snippet.title,
    thumbnail: (thumbs.default || thumbs.medium || {}).url || "",
  };
}

async function fetchChannelInfoByUsername(username, credential) {
  const data = await apiFetch("/channels", { part: "snippet", forUsername: username }, credential);
  const item = data.items && data.items[0];
  if (!item) throw new Error("Không tìm thấy kênh với username: " + username);
  const thumbs = item.snippet.thumbnails || {};
  return {
    id: item.id,
    title: item.snippet.title,
    thumbnail: (thumbs.default || thumbs.medium || {}).url || "",
  };
}

export async function resolveChannelInput(rawInput, credential = {}) {
  const input = (rawInput || "").trim();
  if (!input) throw new Error("Vui lòng nhập URL hoặc tên kênh");

  const hasApiCredential = !!(credential.apiKey || credential.oauthToken);

  // 1) Channel ID trực tiếp (kể cả nằm trong URL) luôn dùng được.
  const direct = input.match(CHANNEL_ID_RE);
  if (direct) {
    const id = direct[0];
    if (hasApiCredential) {
      try {
        return await fetchChannelInfoById(id, credential);
      } catch {
        // API lỗi/hết quota: vẫn có thể lấy dữ liệu cơ bản từ RSS công khai.
      }
    }
    return await channelInfoFromFeed(id);
  }

  const trimmed = input.replace(/^https?:\/\/(www\.)?youtube\.com\//i, "");
  const firstSegment = trimmed.split(/[/?#]/)[0];

  // 2) @handle: dùng channels.list?forHandle — không scrape HTML trang YouTube.
  if (input.startsWith("@") || firstSegment.startsWith("@")) {
    if (!hasApiCredential) {
      throw new Error("Để thêm bằng @handle, hãy kết nối Google hoặc nhập YouTube Data API key. Bạn vẫn có thể dán URL /channel/UC... hoặc channel ID trực tiếp.");
    }
    return await fetchChannelInfoByHandle(input.startsWith("@") ? input : firstSegment, credential);
  }

  // 3) URL /user/... cũ: dùng bộ lọc forUsername chính thức.
  if (/^user\//i.test(trimmed)) {
    if (!hasApiCredential) {
      throw new Error("Để thêm URL /user/..., hãy kết nối Google hoặc nhập YouTube Data API key.");
    }
    return await fetchChannelInfoByUsername(trimmed.split(/[/?#]/)[1] || "", credential);
  }

  // 4) Tên kênh hoặc URL /c/...: tìm bằng YouTube Data API (100 quota units).
  if (!hasApiCredential) {
    throw new Error("Không thể tìm theo tên khi chưa có API credential. Hãy kết nối Google, nhập API key, hoặc dán channel ID (UC...).");
  }
  const query = /^c\//i.test(trimmed) ? (trimmed.split(/[/?#]/)[1] || input) : input;
  const search = await apiFetch(
    "/search",
    { part: "snippet", type: "channel", q: query, maxResults: 1 },
    credential
  );
  const first = search.items && search.items[0];
  if (!first) throw new Error("Không tìm thấy kênh phù hợp với: " + input);
  return await fetchChannelInfoById(first.snippet.channelId, credential);
}

// ---------- Vòng 1: phát hiện video mới qua RSS ----------

// Fetch với retry — YouTube đôi khi trả 404/503 tạm thời do rate-limit.
// Thử lại tối đa maxRetries lần trước khi bỏ cuộc.
async function fetchWithRetry(url, options = {}, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s, 2s — tránh hammer server
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    try {
      const res = await fetch(url, options);
      // Chỉ retry với 404 và 5xx (lỗi phía server), không retry 4xx khác
      if ((res.status === 404 || res.status >= 500) && attempt < maxRetries) {
        lastErr = res;
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) continue;
    }
  }
  // lastErr có thể là Response hoặc Error
  if (lastErr && typeof lastErr.status === "number") return lastErr;
  throw lastErr;
}

async function discoverNewVideos() {
  const channels = await getChannels();
  const watched = Object.values(channels).filter((c) => c.watched);
  if (watched.length === 0) {
    await setStatus({ lastError: "", lastDiscoverAt: Date.now() });
    return;
  }

  const pending = await getPending();
  let foundCount = 0;

  for (const ch of watched) {
    try {
      const headers = {};
      // Conditional GET: phần lớn lần gọi trả 304 rỗng, gần như không tốn băng thông.
      if (ch.etag) headers["If-None-Match"] = ch.etag;
      else if (ch.lastModified) headers["If-Modified-Since"] = ch.lastModified;

      const res = await fetchWithRetry(feedUrlForChannel(ch.id), { headers });

      if (res.status === 304) {
        ch.lastError = "";
        ch.consecutiveErrors = 0;
        continue;
      }
      if (res.status === 404) {
        // Sau khi đã retry 2 lần vẫn 404 → đây mới là lỗi thật.
        // Ghi nhận nhưng chỉ hiển thị sau 3 vòng liên tiếp — tránh báo sai khi YouTube chặn tạm.
        ch.consecutiveErrors = (ch.consecutiveErrors || 0) + 1;
        if (ch.consecutiveErrors >= 3) {
          ch.lastError = "Đã thử lại nhưng YouTube vẫn chặn kênh này (404). Kênh có thể bị xóa hoặc khóa feed.";
        } else {
          ch.lastError = "";
        }
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      ch.consecutiveErrors = 0;

      ch.etag = res.headers.get("etag") || "";
      ch.lastModified = res.headers.get("last-modified") || "";

      const videos = parseFeed(await res.text());
      if (videos.length === 0) {
        ch.lastError = "";
        continue;
      }

      const fresh = findNewVideos(videos, ch.seenVideoIds);

      if (!ch.initialized) {
        // Lần đầu theo dõi: chỉ chốt mốc, không mở tab cho video cũ.
        ch.seenVideoIds = rememberSeen([], videos.map((v) => v.videoId));
        ch.initialized = true;
        ch.lastCheckedTitle = videos[0].title;
      } else if (fresh.length) {
        for (const v of fresh) {
          pending[v.videoId] = {
            videoId: v.videoId,
            channelId: ch.id,
            title: v.title,
            thumbnail: v.thumbnail,
            state: "unknown",
            scheduledStartTime: "",
            firstSeenAt: Date.now(),
            lastCheckedAt: 0,
          };
        }
        ch.seenVideoIds = rememberSeen(ch.seenVideoIds, fresh.map((v) => v.videoId));
        ch.lastCheckedTitle = fresh[0].title;
        foundCount += fresh.length;
      }

      ch.lastError = "";
    } catch (err) {
      ch.consecutiveErrors = (ch.consecutiveErrors || 0) + 1;
      ch.lastError = err.message || String(err);
    }
  }

  await setStorage({ channels, pending });
  await setStatus({ lastError: "", lastDiscoverAt: Date.now() });

  // Có video mới thì phân loại ngay, không đợi hết chu kỳ vòng 2.
  if (foundCount > 0) await checkPendingVideos();
}

// ---------- Vòng 2: phân loại và theo dõi trạng thái live ----------

async function checkPendingVideos() {
  const pending = await getPending();
  const now = Date.now();

  // Dọn các mục quá hạn trước, để không kéo theo chúng vào lệnh gọi API.
  let changed = false;
  for (const [id, entry] of Object.entries(pending)) {
    if (isExpired(entry, now)) {
      delete pending[id];
      changed = true;
    }
  }

  const due = Object.values(pending).filter((e) => shouldRecheck(e, now));
  if (due.length === 0) {
    if (changed) await setStorage({ pending });
    await updateBadge();
    return;
  }

  const apiKey = await getApiKey();
  const oauthToken = await getCachedOAuthToken();

  const channels = await getChannels();

  // Không scrape HTML trang YouTube. Nếu chưa có API key hoặc kết nối Google,
  // RSS vẫn phát hiện video mới nhưng extension giữ chúng trong hàng chờ cho tới
  // khi có credential để phân loại chính xác video thường/live/upcoming.
  if (!apiKey && !oauthToken) {
    await setStorage({ pending });
    await setStatus({
      lastError: "Cần API key hoặc kết nối Google để phân loại chính xác video/livestream đang chờ.",
      lastLiveCheckAt: now,
    });
    return;
  }
  const classified = [];

  try {
    for (const batch of chunkIds(due.map((e) => e.videoId))) {
      const data = await apiFetch(
        "/videos",
        { part: "snippet,liveStreamingDetails", id: batch.join(",") },
        { apiKey, oauthToken: apiKey ? "" : oauthToken }
      );

      const byId = new Map((data.items || []).map((it) => [it.id, it]));

      for (const videoId of batch) {
        const entry = pending[videoId];
        if (!entry) continue;

        const item = byId.get(videoId);
        if (!item) {
          // Video bị xoá, đặt riêng tư, hoặc ID sai -> ngừng theo dõi.
          delete pending[videoId];
          changed = true;
          continue;
        }

        entry.lastCheckedAt = now;
        entry.title = (item.snippet && item.snippet.title) || entry.title;
        entry.scheduledStartTime =
          (item.liveStreamingDetails && item.liveStreamingDetails.scheduledStartTime) || "";

        classified.push({ entry, state: classifyVideo(item) });
      }
    }
  } catch (err) {
    // Token OAuth không còn hợp lệ: xoá credential/session data tạm thời nhưng
    // không tự xoá cấu hình theo dõi của người dùng (chỉ nút Disconnect làm việc đó).
    if (err && err.status === 401 && !apiKey && oauthToken) {
      await removeSessionStorage(["oauthToken", "oauthTokenExpires", "oauthUser", "fetchedSubs", "oauthDataFetchedAt"]);
    }
    // Hết quota/key sai/token hết hạn: giữ hàng chờ và thử lại sau khi người dùng
    // cung cấp credential hợp lệ.
    await setStorage({ pending });
    await setStatus({ lastError: err.message || String(err), lastLiveCheckAt: now });
    return;
  }

  await handleClassified(classified, pending, channels);
  await setStatus({ lastError: "", lastLiveCheckAt: now });
}

// Mở tab / báo notification theo trạng thái và mode của kênh.
async function handleClassified(classified, pending, channelsArg) {
  // Không dùng channelsArg để ghi lại storage — nó là snapshot cũ.
  // Chỉ dùng để đọc mode/title của kênh; tải lại mới nhất trước khi lưu.
  const channels = channelsArg || (await getChannels());
  let tabsOpened = 0;

  for (const { entry, state } of classified) {
    const ch = channels[entry.channelId] || {};
    const mode = ch.mode === "liveOnly" ? "liveOnly" : "all";

    if (state === "upcoming") {
      // Chưa lên sóng: giữ lại trong hàng chờ, kiểm tra tiếp ở vòng sau.
      entry.state = "upcoming";
      pending[entry.videoId] = entry;
      continue;
    }

    if (shouldOpenTab(state, mode)) {
      if (tabsOpened < MAX_TABS_PER_RUN) {
        try {
          await chrome.tabs.create({
            url: `https://www.youtube.com/watch?v=${entry.videoId}`,
            active: false,
          });
          tabsOpened++;
        } catch (tabErr) {
          // Service worker có thể bị suspend lúc mở tab; ghi lỗi nhưng không dừng.
          console.error("Mở tab thất bại:", tabErr);
        }
      }
      notify(entry, state, ch);
    } else if (state !== "upcoming" && mode === "liveOnly") {
      // Kênh chỉ quan tâm livestream: video thường vẫn báo, chỉ không mở tab.
      notify(entry, state, ch);
    }

    delete pending[entry.videoId];
  }

  // Chỉ lưu pending (truyền vào từ caller) — không ghi lại channels để tránh ghi è dữ liệu mới hơn.
  await setStorage({ pending });
  await updateBadge();
}

function notify(entry, state, ch) {
  const nhan = state === "live" ? "🔴 ĐANG LIVE" : "Video mới";
  chrome.notifications.create(`ytnotify_${entry.videoId}`, {
    type: "basic",
    // iconUrl phải là đường dẫn trong extension: service worker MV3 không tải
    // được ảnh remote (https://...) cho notification.
    iconUrl: "icons/icon128.png",
    title: `${nhan} — ${ch.title || "Kênh đã theo dõi"}`,
    message: entry.title || entry.videoId,
    priority: 2,
  });
}

// Bấm vào notification thì mở video (hữu ích khi tab không được mở tự động).
chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith("ytnotify_")) return;
  const videoId = id.slice("ytnotify_".length);
  chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}`, active: true });
  chrome.notifications.clear(id);
});

// ---------- Chốt mốc cho kênh vừa thêm ----------

async function initChannelBaseline(channelId) {
  const channels = await getChannels();
  const ch = channels[channelId];
  if (!ch || ch.initialized) return;

  const res = await fetch(feedUrlForChannel(channelId));
  if (!res.ok) throw new Error(`Không tải được feed (HTTP ${res.status})`);

  const videos = parseFeed(await res.text());
  ch.seenVideoIds = rememberSeen([], videos.map((v) => v.videoId));
  ch.initialized = true;
  ch.consecutiveErrors = 0;
  ch.lastCheckedTitle = videos.length ? videos[0].title : "";
  ch.lastError = "";
  await setStorage({ channels });
}

// ---------- Message từ popup ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "resolveChannel": {
          const apiKey = await getApiKey();
          const oauthToken = await getCachedOAuthToken();
          const info = await resolveChannelInput(message.input, { apiKey, oauthToken: apiKey ? "" : oauthToken });
          sendResponse({ ok: true, channel: info });
          return;
        }
        case "initChannel":
          await initChannelBaseline(message.channelId);
          sendResponse({ ok: true });
          return;
        case "checkNow":
          await discoverNewVideos();
          await checkPendingVideos();
          sendResponse({ ok: true });
          return;
        case "updateIntervals":
          await setStorage({
            discoverSeconds: message.discoverSeconds,
            liveCheckSeconds: message.liveCheckSeconds,
          });
          await ensureAlarms();
          sendResponse({ ok: true });
          return;
        case "fetchSubscriptions": {
          try {
            const cached = await getSessionStorage({ oauthToken: "", oauthTokenExpires: 0 });
            let token = cached.oauthToken;

            if (message.prompt || !token || Date.now() >= cached.oauthTokenExpires) {
              let authRes;
              try {
                authRes = await getAuthToken(false, message.clientId, message.prompt);
              } catch {
                authRes = await getAuthToken(true, message.clientId, message.prompt);
              }
              token = authRes.token;
              await setSessionStorage({
                oauthToken: token,
                oauthTokenExpires: Date.now() + (authRes.expiresIn * 1000) - 60000,
              });
            }
            
            const rawSubs = await fetchSubscriptions(token);
            const subs = rawSubs.map(item => ({
              id: item.snippet.resourceId.channelId,
              title: item.snippet.title,
              thumbnail: (item.snippet.thumbnails?.default || item.snippet.thumbnails?.medium || {}).url || ""
            }));

            const userInfoData = await fetchUserInfo(token);
            let oauthUser = null;
            if (userInfoData && userInfoData.length > 0) {
              const profile = userInfoData[0].snippet;
              oauthUser = {
                name: profile.title,
                picture: profile.thumbnails?.default?.url || ""
              };
            }
            
            await setSessionStorage({ fetchedSubs: subs, oauthUser, oauthDataFetchedAt: Date.now() });
            sendResponse({ ok: true, subs, oauthUser });
          } catch (err) {
            if (err && err.status === 401) {
              await removeSessionStorage(["oauthToken", "oauthTokenExpires"]);
              await removeSessionStorage(["oauthUser", "fetchedSubs", "oauthDataFetchedAt"]);
            }
            sendResponse({ ok: false, error: err.message || String(err) });
          }
          return;
        }
        case "revokeOAuth": {
          const cached = await getSessionStorage({ oauthToken: "", oauthTokenExpires: 0 });
          let token = cached.oauthToken;
          let revokeWarning = "";

          if ((!token || Date.now() >= cached.oauthTokenExpires) && message.clientId) {
            try {
              const authRes = await getAuthToken(false, message.clientId);
              token = authRes.token;
            } catch {
              // Không bật cửa sổ đăng nhập chỉ để ngắt kết nối. Người dùng vẫn có
              // thể thu hồi quyền từ trang Google Account được liên kết trong UI.
            }
          }

          if (token) {
            try {
              const body = new URLSearchParams({ token }).toString();
              const res = await fetch("https://oauth2.googleapis.com/revoke", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
              });
              if (!res.ok) {
                revokeWarning = `Google trả HTTP ${res.status} khi thu hồi token; dữ liệu OAuth cục bộ vẫn đã được xoá. Bạn có thể kiểm tra quyền trong Google Account > Third-party connections.`;
              }
            } catch (err) {
              revokeWarning = "Không thể xác nhận thu hồi quyền với Google: " + (err.message || String(err));
            }
          } else {
            revokeWarning = "Không có access token còn hiệu lực để thu hồi tự động. Hãy kiểm tra Google Account > Third-party connections nếu muốn xác nhận quyền đã bị gỡ.";
          }

          await removeSessionStorage(["oauthToken", "oauthTokenExpires"]);
          const channels = await getChannels();
          for (const [id, ch] of Object.entries(channels)) {
            if (ch && ch.source === "subscription") delete channels[id];
          }
          await setStorage({ channels });
          await removeSessionStorage(["oauthUser", "fetchedSubs", "oauthDataFetchedAt"]);
          sendResponse({ ok: true, warning: revokeWarning });
          return;
        }
        default:
          sendResponse({ ok: false, error: "Unknown message type: " + message.type });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // giữ kênh message mở cho phản hồi bất đồng bộ
});
