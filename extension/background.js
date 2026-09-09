// background.js — service worker (Manifest V3)
// Định kỳ kiểm tra video mới nhất của các kênh YouTube đã chọn theo dõi.
// Nếu có video mới -> mở tab mới đến video đó + hiện thông báo hệ điều hành.

const ALARM_NAME = "ytnotify_check";
const DEFAULT_INTERVAL_MINUTES = 10;
const API_BASE = "https://www.googleapis.com/youtube/v3";
// Số tab tối đa được mở trong 1 vòng kiểm tra. Nếu máy tắt lâu ngày, nhiều kênh
// cùng có video mới -> tránh bung hàng chục tab một lúc. Phần còn lại chỉ báo notification.
const MAX_TABS_PER_RUN = 3;

// ---------- Storage helpers ----------

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

async function saveChannels(channels) {
  await setStorage({ channels });
}

async function getApiKey() {
  const { apiKey } = await getStorage({ apiKey: "" });
  return apiKey || "";
}

async function getIntervalMinutes() {
  const { intervalMinutes } = await getStorage({ intervalMinutes: DEFAULT_INTERVAL_MINUTES });
  return intervalMinutes || DEFAULT_INTERVAL_MINUTES;
}

async function setLastError(message) {
  await setStorage({ lastError: message || "", lastCheckAt: Date.now() });
  await updateBadge();
}

async function updateBadge() {
  const { lastError } = await getStorage({ lastError: "" });
  if (lastError) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#e01e1e" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// ---------- Alarm setup ----------

async function ensureAlarm() {
  const minutes = await getIntervalMinutes();
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: Math.max(1, minutes) });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  updateBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkAllChannels();
  }
});

// ---------- YouTube API helpers ----------

async function apiFetch(path, params, apiKey) {
  const url = new URL(`${API_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set("key", apiKey);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// Lấy uploadsPlaylistId + thông tin cơ bản của 1 kênh theo channelId
async function fetchChannelInfoById(channelId, apiKey) {
  const data = await apiFetch("/channels", { part: "snippet,contentDetails", id: channelId }, apiKey);
  const item = data.items && data.items[0];
  if (!item) throw new Error("Không tìm thấy kênh với ID: " + channelId);
  return {
    id: item.id,
    title: item.snippet.title,
    thumbnail: (item.snippet.thumbnails && (item.snippet.thumbnails.default || item.snippet.thumbnails.medium) || {}).url || "",
    uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
  };
}

// Phân giải 1 input do người dùng nhập (URL kênh, @handle, tên tuỳ ý, hoặc channelId) thành thông tin kênh
async function resolveChannelInput(rawInput, apiKey) {
  const input = rawInput.trim();
  if (!input) throw new Error("Vui lòng nhập URL hoặc tên kênh");
  if (!apiKey) throw new Error("Chưa nhập API key");

  // 1) Channel ID trực tiếp (UCxxxxxxxxxxxxxxxxxxxxxx)
  const idMatch = input.match(/UC[0-9A-Za-z_-]{22}/);
  if (idMatch) {
    return await fetchChannelInfoById(idMatch[0], apiKey);
  }

  // 2) URL dạng /channel/UCxxxx đã bắt ở trên; kiểm tra các dạng khác
  let handle = null;
  let username = null;
  let customOrQuery = null;

  try {
    const url = new URL(input.startsWith("http") ? input : `https://${input}`);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] && parts[0].startsWith("@")) {
      handle = parts[0].slice(1);
    } else if (parts[0] === "user" && parts[1]) {
      username = parts[1];
    } else if (parts[0] === "c" && parts[1]) {
      customOrQuery = parts[1];
    } else if (parts[0] && !parts[0].startsWith("http")) {
      customOrQuery = parts[0];
    }
  } catch (e) {
    // Không phải URL hợp lệ -> coi như handle hoặc tên tìm kiếm
    if (input.startsWith("@")) {
      handle = input.slice(1);
    } else {
      customOrQuery = input;
    }
  }

  // 3) Thử theo handle (API mới hỗ trợ forHandle)
  if (handle) {
    try {
      const data = await apiFetch("/channels", { part: "snippet,contentDetails", forHandle: handle }, apiKey);
      const item = data.items && data.items[0];
      if (item) {
        return {
          id: item.id,
          title: item.snippet.title,
          thumbnail: (item.snippet.thumbnails && (item.snippet.thumbnails.default || item.snippet.thumbnails.medium) || {}).url || "",
          uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
        };
      }
    } catch (e) {
      // rơi xuống tìm kiếm bên dưới
    }
    customOrQuery = customOrQuery || handle;
  }

  // 4) Thử theo username cũ (forUsername)
  if (username) {
    try {
      const data = await apiFetch("/channels", { part: "snippet,contentDetails", forUsername: username }, apiKey);
      const item = data.items && data.items[0];
      if (item) {
        return {
          id: item.id,
          title: item.snippet.title,
          thumbnail: (item.snippet.thumbnails && (item.snippet.thumbnails.default || item.snippet.thumbnails.medium) || {}).url || "",
          uploadsPlaylistId: item.contentDetails.relatedPlaylists.uploads,
        };
      }
    } catch (e) {
      // rơi xuống tìm kiếm bên dưới
    }
    customOrQuery = customOrQuery || username;
  }

  // 5) Cuối cùng: tìm kiếm gần đúng bằng search.list rồi lấy channel đầu tiên
  const query = customOrQuery || input;
  const searchData = await apiFetch(
    "/search",
    { part: "snippet", type: "channel", q: query, maxResults: 1 },
    apiKey
  );
  const first = searchData.items && searchData.items[0];
  if (!first) throw new Error("Không tìm thấy kênh phù hợp với: " + input);
  return await fetchChannelInfoById(first.snippet.channelId, apiKey);
}

// Lấy video mới nhất trong playlist "uploads" của 1 kênh
async function fetchLatestVideo(uploadsPlaylistId, apiKey) {
  const data = await apiFetch(
    "/playlistItems",
    { part: "snippet,contentDetails", playlistId: uploadsPlaylistId, maxResults: 1 },
    apiKey
  );
  const item = data.items && data.items[0];
  if (!item) return null;
  return {
    videoId: item.contentDetails.videoId,
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle,
    thumbnail:
      (item.snippet.thumbnails &&
        (item.snippet.thumbnails.medium || item.snippet.thumbnails.default) || {}).url || "",
    publishedAt: item.contentDetails.videoPublishedAt || item.snippet.publishedAt,
  };
}

// ---------- Vòng kiểm tra chính ----------

async function checkAllChannels() {
  const apiKey = await getApiKey();
  if (!apiKey) {
    await setLastError("Chưa cấu hình API key. Mở popup extension để nhập.");
    return;
  }

  const channels = await getChannels();
  const watchedIds = Object.keys(channels).filter((id) => channels[id].watched);

  if (watchedIds.length === 0) {
    await setLastError("");
    return;
  }

  let anyError = "";
  let tabsOpened = 0;

  for (const channelId of watchedIds) {
    const ch = channels[channelId];
    try {
      // Đảm bảo có uploadsPlaylistId
      if (!ch.uploadsPlaylistId) {
        const info = await fetchChannelInfoById(channelId, apiKey);
        ch.uploadsPlaylistId = info.uploadsPlaylistId;
        ch.title = info.title || ch.title;
        ch.thumbnail = info.thumbnail || ch.thumbnail;
      }

      const latest = await fetchLatestVideo(ch.uploadsPlaylistId, apiKey);
      if (!latest) continue;

      if (!ch.initialized) {
        // Lần đầu theo dõi: chỉ lưu mốc, không mở tab video cũ
        ch.lastVideoId = latest.videoId;
        ch.initialized = true;
        ch.lastCheckedTitle = latest.title;
      } else if (latest.videoId !== ch.lastVideoId) {
        // Có video mới thật sự -> mở tab + thông báo
        ch.lastVideoId = latest.videoId;
        ch.lastCheckedTitle = latest.title;

        if (tabsOpened < MAX_TABS_PER_RUN) {
          await chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${latest.videoId}`, active: false });
          tabsOpened++;
        }

        // iconUrl phải là đường dẫn trong extension: service worker MV3 không tải
        // được ảnh remote (https://...) cho notification -> notification sẽ không hiện.
        chrome.notifications.create(`ytnotify_${channelId}_${latest.videoId}`, {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: `Video mới từ ${latest.channelTitle || ch.title}`,
          message: latest.title,
          priority: 2,
        });
      }

      ch.lastError = "";
    } catch (err) {
      ch.lastError = err.message || String(err);
      anyError = ch.lastError;
    }
  }

  await saveChannels(channels);
  await setLastError(anyError);
}

// Chốt mốc "video mới nhất hiện tại" cho một kênh vừa được thêm.
// Không có bước này, kênh mới chỉ được khởi tạo ở lần alarm kế tiếp (tối đa vài chục
// phút sau) và hành vi trong khoảng chờ đó khó đoán.
async function initChannelBaseline(channelId) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error("Chưa cấu hình API key.");

  const channels = await getChannels();
  const ch = channels[channelId];
  if (!ch || ch.initialized) return;

  if (!ch.uploadsPlaylistId) {
    const info = await fetchChannelInfoById(channelId, apiKey);
    ch.uploadsPlaylistId = info.uploadsPlaylistId;
    ch.title = info.title || ch.title;
    ch.thumbnail = info.thumbnail || ch.thumbnail;
  }

  const latest = await fetchLatestVideo(ch.uploadsPlaylistId, apiKey);
  if (latest) {
    ch.lastVideoId = latest.videoId;
    ch.lastCheckedTitle = latest.title;
  }
  ch.initialized = true;
  await saveChannels(channels);
}

// ---------- Nhận message từ popup ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "resolveChannel") {
        const apiKey = await getApiKey();
        const info = await resolveChannelInput(message.input, apiKey);
        sendResponse({ ok: true, channel: info });
        return;
      }

      if (message.type === "initChannel") {
        await initChannelBaseline(message.channelId);
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "checkNow") {
        await checkAllChannels();
        sendResponse({ ok: true });
        return;
      }

      if (message.type === "updateInterval") {
        await setStorage({ intervalMinutes: message.minutes });
        await ensureAlarm();
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown message type" });
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // giữ kênh message mở cho phản hồi bất đồng bộ
});
