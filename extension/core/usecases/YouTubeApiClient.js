// YouTubeApiClient.js — YouTube Data API wrapper + channel resolution
//
// Trách nhiệm duy nhất: giao tiếp với YouTube Data API (fetch, retry 401,
// phân giải input người dùng thành channel info).

import { OAuthManager } from "./OAuthManager.js";
import { feedUrlForChannel, parseChannelInfo } from "../../lib/rss.js";
import { API_BASE } from "./StorageHelpers.js";

// ---------- Core API Fetch ----------

export async function apiFetch(path, params, credential = {}, options = {}) {
  const requestOnce = async (activeCredential) => {
    const url = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const headers = {};
    if (activeCredential.oauthToken) {
      headers["Authorization"] = `Bearer ${activeCredential.oauthToken}`;
    } else if (activeCredential.apiKey) {
      url.searchParams.set("key", activeCredential.apiKey);
    }

    const res = await fetch(url.toString(), { headers, ...(path === "/videos" ? { cache: "no-store" } : {}) });
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
  };

  try {
    return await requestOnce(credential);
  } catch (err) {
    // Access token có thể hết hạn trước mốc local hoặc bị Google vô hiệu hoá.
    // Thử silent re-auth đúng một lần rồi retry request.
    if (
      err &&
      err.status === 401 &&
      credential.oauthToken &&
      options.retryOAuth !== false
    ) {
      const refreshedToken = await OAuthManager.getCachedOAuthToken({ forceRefresh: true });
      if (refreshedToken) {
        return requestOnce({ ...credential, oauthToken: refreshedToken });
      }
    }
    throw err;
  }
}

// ---------- Channel Info Fetchers ----------

export async function fetchChannelInfoById(channelId, credential = {}) {
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

export async function fetchUserInfo(token) {
  const data = await apiFetch("/channels", { part: "snippet", mine: "true" }, { oauthToken: token });
  return data.items || [];
}

export async function fetchSubscriptions(token) {
  let items = [];
  let pageToken = "";
  let pages = 0;
  const MAX_PAGES = 20; // tối đa 1000 kênh (20 trang x 50)
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

// Với channel ID đã biết, RSS công khai đủ để lấy tên kênh mà không cần API key.
async function channelInfoFromFeed(channelId) {
  const res = await fetch(feedUrlForChannel(channelId));
  if (!res.ok) throw new Error(`Không tải được feed của kênh (HTTP ${res.status})`);
  const info = parseChannelInfo(await res.text());
  if (!info.id) throw new Error("Feed không hợp lệ hoặc kênh không tồn tại");
  return { id: info.id, title: info.title || info.id, thumbnail: "" };
}

// ---------- Fetch with Retry ----------

// Fetch với retry — YouTube đôi khi trả 404/503 tạm thời do rate-limit.
export async function fetchWithRetry(url, options = {}, maxRetries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    try {
      const res = await fetch(url, options);
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
  if (lastErr && typeof lastErr.status === "number") return lastErr;
  throw lastErr;
}

// ---------- Channel Input Resolution ----------

const CHANNEL_ID_RE = /UC[0-9A-Za-z_-]{22}/;

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

  // 2) @handle: dùng channels.list?forHandle
  if (input.startsWith("@") || firstSegment.startsWith("@")) {
    if (!hasApiCredential) {
      throw new Error("Để thêm bằng @handle, hãy kết nối Google hoặc nhập YouTube Data API key. Bạn vẫn có thể dán URL /channel/UC... hoặc channel ID trực tiếp.");
    }
    return await fetchChannelInfoByHandle(input.startsWith("@") ? input : firstSegment, credential);
  }

  // 3) URL /user/... cũ
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
