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
  chrome.alarms.create(ALARM_DISCOVER, { periodInMinutes: discoverSeconds / 60 });
  chrome.alarms.create(ALARM_LIVECHECK, { periodInMinutes: liveCheckSeconds / 60 });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarms();
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarms();
  updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_DISCOVER) discoverNewVideos();
  else if (alarm.name === ALARM_LIVECHECK) checkPendingVideos();
});

// ---------- YouTube Data API ----------

async function apiFetch(path, params, keyOrToken) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  
  const headers = {};
  if (keyOrToken && keyOrToken.startsWith("ya29.")) {
     headers["Authorization"] = `Bearer ${keyOrToken}`;
  } else if (keyOrToken) {
     url.searchParams.set("key", keyOrToken);
  }

  const res = await fetch(url.toString(), { headers });
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data && data.error && data.error.message) || `HTTP ${res.status}`);
  }
  return data;
}

async function fetchChannelInfoById(channelId, apiKey) {
  const data = await apiFetch("/channels", { part: "snippet", id: channelId }, apiKey);
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
  const data = await apiFetch("/channels", { part: "snippet", mine: "true" }, token);
  return data.items || [];
}

async function fetchSubscriptions(token) {
  let items = [];
  let pageToken = "";
  do {
    const params = { part: "snippet", mine: "true", maxResults: "50" };
    if (pageToken) params.pageToken = pageToken;
    const data = await apiFetch("/subscriptions", params, token);
    if (data.items) {
      items.push(...data.items);
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return items;
}

// ---------- Phân giải input thành kênh ----------

const CHANNEL_ID_RE = /UC[0-9A-Za-z_-]{22}/;

// Lấy thông tin kênh chỉ bằng RSS — không cần API key. Đây là thứ khiến chế độ
// RSS-only dùng được thật sự chứ không chỉ là chế độ què.
async function channelInfoFromFeed(channelId) {
  const res = await fetch(feedUrlForChannel(channelId));
  if (!res.ok) throw new Error(`Không tải được feed của kênh (HTTP ${res.status})`);
  const info = parseChannelInfo(await res.text());
  if (!info.id) throw new Error("Feed không hợp lệ hoặc kênh không tồn tại");
  return { id: info.id, title: info.title || info.id, thumbnail: "" };
}

// Đổi @handle hoặc URL tuỳ biến thành channelId bằng cách đọc trang kênh.
// Chỉ chạy một lần lúc thêm kênh, không lặp trong vòng kiểm tra.
async function resolveChannelIdByScraping(pathSegment) {
  const res = await fetch(`https://www.youtube.com/${pathSegment}`);
  if (!res.ok) throw new Error(`Không mở được trang kênh (HTTP ${res.status})`);
  const html = await res.text();
  const m =
    html.match(/"channelId":"(UC[\w-]{22})"/) ||
    html.match(/"externalId":"(UC[\w-]{22})"/) ||
    html.match(/channel\/(UC[\w-]{22})/);
  if (!m) throw new Error("Không tìm thấy channel ID trong trang kênh");
  return m[1];
}

export async function resolveChannelInput(rawInput, apiKey) {
  const input = (rawInput || "").trim();
  if (!input) throw new Error("Vui lòng nhập URL hoặc tên kênh");

  // 1) Có sẵn channel ID trong input (kể cả nằm trong URL)
  const direct = input.match(CHANNEL_ID_RE);
  if (direct) {
    const id = direct[0];
    if (apiKey) {
      try {
        return await fetchChannelInfoById(id, apiKey);
      } catch (e) {
        // API lỗi hoặc hết quota -> vẫn thêm được kênh nhờ feed
      }
    }
    return await channelInfoFromFeed(id);
  }

  // 2) @handle hoặc URL kênh -> đọc trang kênh lấy channelId
  let segment = null;
  const trimmed = input.replace(/^https?:\/\/(www\.)?youtube\.com\//i, "");
  if (trimmed.startsWith("@")) {
    segment = trimmed.split(/[/?#]/)[0];
  } else if (/^(c|user)\//i.test(trimmed)) {
    segment = trimmed.split(/[?#]/)[0];
  } else if (input.startsWith("@")) {
    segment = input.split(/[/?#]/)[0];
  }

  if (segment) {
    const id = await resolveChannelIdByScraping(segment);
    if (apiKey) {
      try {
        return await fetchChannelInfoById(id, apiKey);
      } catch (e) {
        /* rơi xuống feed */
      }
    }
    return await channelInfoFromFeed(id);
  }

  // 3) Cuối cùng: tìm theo tên. Chỉ làm được khi có API key, và tốn 100 unit
  //    nên đây là lựa chọn cuối.
  if (!apiKey) {
    throw new Error(
      "Chưa có API key nên chỉ thêm được bằng URL kênh, @handle hoặc channel ID (UC...)."
    );
  }
  const search = await apiFetch(
    "/search",
    { part: "snippet", type: "channel", q: input, maxResults: 1 },
    apiKey
  );
  const first = search.items && search.items[0];
  if (!first) throw new Error("Không tìm thấy kênh phù hợp với: " + input);
  return await fetchChannelInfoById(first.snippet.channelId, apiKey);
}

// ---------- Vòng 1: phát hiện video mới qua RSS ----------

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

      const res = await fetch(feedUrlForChannel(ch.id), { headers });

      if (res.status === 304) {
        ch.lastError = "";
        continue;
      }
      if (res.status === 404) {
        throw new Error("Kênh bị YouTube chặn dữ liệu (404)");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

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
  const { oauthToken } = await getStorage({ oauthToken: "" });

  // Chế độ RSS-only: không có key thì không phân biệt được live/upcoming.
  // Coi mọi video như video thường và xử lý theo mode của kênh.
  if (!apiKey && !oauthToken) {
    // Chế độ không key/token: Scraping HTML trực tiếp để phát hiện livestream
    const classified = [];
    try {
      for (const e of due) {
        const res = await fetch(`https://www.youtube.com/watch?v=${e.videoId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        e.lastCheckedAt = now;
        
        let state = "none";
        if (html.includes('"isLiveNow":true') || html.includes('"isLive":true')) {
          state = "live";
        } else if (html.includes('"isUpcoming":true')) {
          state = "upcoming";
        }
        classified.push({ entry: e, state });
      }
      await handleClassified(classified, pending, channels);
      await setStatus({ lastError: "", lastLiveCheckAt: now });
    } catch (err) {
      // Nếu scrape lỗi, fallback coi như video thường
      await handleClassified(due.map((e) => ({ entry: e, state: "none" })), pending);
      await setStatus({ lastError: "Scrape lỗi: " + err.message, lastLiveCheckAt: now });
    }
    return;
  }

  const channels = await getChannels();
  const classified = [];

  try {
    for (const batch of chunkIds(due.map((e) => e.videoId))) {
      const data = await apiFetch(
        "/videos",
        { part: "snippet,liveStreamingDetails", id: batch.join(",") },
        apiKey || oauthToken
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
    // Hết quota hoặc key sai: giữ nguyên hàng chờ, thử lại vòng sau.
    await setStorage({ pending });
    await setStatus({ lastError: err.message || String(err), lastLiveCheckAt: now });
    return;
  }

  await handleClassified(classified, pending, channels);
  await setStatus({ lastError: "", lastLiveCheckAt: now });
}

// Mở tab / báo notification theo trạng thái và mode của kênh.
async function handleClassified(classified, pending, channelsArg) {
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
        await chrome.tabs.create({
          url: `https://www.youtube.com/watch?v=${entry.videoId}`,
          active: false,
        });
        tabsOpened++;
      }
      notify(entry, state, ch);
    } else if (state !== "upcoming" && mode === "liveOnly") {
      // Kênh chỉ quan tâm livestream: video thường vẫn báo, chỉ không mở tab.
      notify(entry, state, ch);
    }

    delete pending[entry.videoId];
  }

  await setStorage({ pending, channels });
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
          const info = await resolveChannelInput(message.input, await getApiKey());
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
            const { oauthToken, oauthTokenExpires } = await getStorage({ oauthToken: "", oauthTokenExpires: 0 });
            let token = oauthToken;
            
            if (message.prompt || !token || Date.now() >= oauthTokenExpires) {
              let authRes;
              try {
                authRes = await getAuthToken(false, message.clientId, message.prompt);
              } catch (err) {
                authRes = await getAuthToken(true, message.clientId, message.prompt);
              }
              token = authRes.token;
              await setStorage({ 
                oauthToken: token, 
                oauthTokenExpires: Date.now() + (authRes.expiresIn * 1000) - 60000 // trừ hao 1 phút
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
            
            await setStorage({ fetchedSubs: subs, oauthUser });
            sendResponse({ ok: true, subs, oauthUser });
          } catch (err) {
            sendResponse({ ok: false, error: err.message || String(err) });
          }
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
