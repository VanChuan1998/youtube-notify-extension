// DiscoverUseCase.js — Vòng 1: phát hiện video mới qua RSS + API playlist
//
// Tải RSS feed của từng kênh. Miễn phí, không tốn quota YouTube Data API,
// không giới hạn số kênh. Video ID chưa từng thấy -> đẩy vào hàng chờ.

import { findNewVideos, rememberSeen } from "../domain/Rules.js";
import { StorageAdapter } from "../../adapters/StorageAdapter.js";
import { OAuthManager } from "./OAuthManager.js";
import { feedUrlForChannel, parseFeed } from "../../lib/rss.js";
import {
  getChannels, getPending, getApiKey, setStatus,
  STARTUP_LIVE_PROBE_PER_CHANNEL, ADD_CHANNEL_LIVE_PROBE_LIMIT,
} from "./StorageHelpers.js";
import { apiFetch, fetchWithRetry } from "./YouTubeApiClient.js";
import { checkPendingVideos } from "./PendingUseCase.js";

export async function discoverNewVideos({
  classifyImmediately = true,
  probeRecentForLive = false,
  channelId = "",
  probeLimit = STARTUP_LIVE_PROBE_PER_CHANNEL,
} = {}) {
  const channels = await getChannels();
  const watched = Object.values(channels).filter((c) => c.watched && (!channelId || c.id === channelId));
  if (watched.length === 0) {
    await setStatus({ lastError: "", lastDiscoverAt: Date.now() });
    return;
  }

  const pending = await getPending();
  let foundCount = 0;
  
  const apiKey = await getApiKey();
  const oauthToken = apiKey ? "" : await OAuthManager.getCachedOAuthToken();
  const credential = apiKey ? { apiKey } : (oauthToken ? { oauthToken } : null);

  for (const ch of watched) {
    try {
      const needsProbe = probeRecentForLive || ch.needsLiveProbe || !ch.initialized;
      let items = [];
      let apiSuccess = false;

      // 1. Quét API UUL nếu có credential (ưu tiên cao nhất)
      if (credential) {
        try {
          const uulId = "UULV" + ch.id.substring(2);
          const data = await apiFetch("/playlistItems", { part: "snippet", playlistId: uulId, maxResults: 15 }, credential);
          if (data.items) {
            items = data.items.map(item => ({
              videoId: item.snippet.resourceId.videoId,
              channelId: item.snippet.channelId,
              title: item.snippet.title,
              author: item.snippet.channelTitle,
              published: item.snippet.publishedAt,
              updated: item.snippet.publishedAt,
              thumbnail: (item.snippet.thumbnails.high || item.snippet.thumbnails.default || {}).url || ""
            }));
            apiSuccess = true;
          }
        } catch (err) {
          console.debug("UUL fetch failed for", ch.id, err);
        }
      }

      // 2. Fallback hoặc lấy thêm từ RSS
      const headers = {};
      if (!needsProbe && !apiSuccess) {
        if (ch.etag) headers["If-None-Match"] = ch.etag;
        else if (ch.lastModified) headers["If-Modified-Since"] = ch.lastModified;
      }

      const res = await fetchWithRetry(feedUrlForChannel(ch.id), {
        headers,
        ...(needsProbe ? { cache: "no-store" } : {}),
      });

      if (res.status === 304 && !apiSuccess) {
        ch.lastError = "";
        ch.consecutiveErrors = 0;
        continue;
      }
      if (res.status === 404 && !apiSuccess) {
        ch.consecutiveErrors = (ch.consecutiveErrors || 0) + 1;
        if (ch.consecutiveErrors >= 3) {
          ch.lastError = "Đã thử lại nhưng YouTube vẫn chặn kênh này (404). Kênh có thể bị xóa hoặc khóa feed.";
        } else {
          ch.lastError = "";
        }
        continue;
      }
      if (!res.ok && !apiSuccess && res.status !== 304) {
        throw new Error(`HTTP ${res.status}`);
      }

      if (res.ok) {
        ch.consecutiveErrors = 0;
        ch.etag = res.headers.get("etag") || "";
        ch.lastModified = res.headers.get("last-modified") || "";
      }

      const rssVideos = res.ok ? parseFeed(await res.text()) : [];
      
      const seenIds = new Set();
      const combined = [];
      for (const v of [...items, ...rssVideos]) {
        if (!seenIds.has(v.videoId)) {
          seenIds.add(v.videoId);
          combined.push(v);
        }
      }

      const fresh = findNewVideos(combined, ch.seenVideoIds);
      if (typeof globalThis.debugDiscoverLogs === "undefined") globalThis.debugDiscoverLogs = [];
      globalThis.debugDiscoverLogs.push({ fresh, combined, items, rssVideos, resOk: res.ok, channelId: ch.id });

      if (combined.length === 0) {
        ch.lastError = "";
        continue;
      }

      if (needsProbe) {
        const seen = new Set(ch.seenVideoIds || []);
        const limit = ch.needsLiveProbe || !ch.initialized ? ADD_CHANNEL_LIVE_PROBE_LIMIT : probeLimit;
        for (const v of combined.slice(0, limit)) {
          if ((ch.endedVideoIds || []).includes(v.videoId)) continue;
          if (pending[v.videoId]) {
            pending[v.videoId].lastCheckedAt = 0;
            continue;
          }
          if (ch.initialized && !ch.needsLiveProbe && !channelId && !seen.has(v.videoId)) continue;
          pending[v.videoId] = {
            videoId: v.videoId,
            channelId: ch.id,
            title: v.title,
            thumbnail: v.thumbnail,
            state: "unknown",
            scheduledStartTime: "",
            firstSeenAt: Date.now(),
            lastCheckedAt: 0,
            startupLiveProbe: true,
          };
          foundCount++;
        }
      }

      if (!ch.initialized) {
        ch.seenVideoIds = rememberSeen([], combined.map((v) => v.videoId));
        ch.initialized = true;
        ch.lastCheckedVideoId = combined[0].videoId;
        ch.lastCheckedTitle = combined[0].title;
      } else if (fresh.length) {
        for (const v of fresh) {
          if ((ch.endedVideoIds || []).includes(v.videoId)) continue;
          if (pending[v.videoId]) continue;
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
        ch.lastCheckedVideoId = fresh[0].videoId;
        ch.lastCheckedTitle = fresh[0].title;
        foundCount += fresh.length;
      } else if (!ch.lastCheckedVideoId && combined[0]) {
        ch.lastCheckedVideoId = combined[0].videoId;
      }

      delete ch.needsLiveProbe;
      ch.lastError = "";
    } catch (err) {
      ch.consecutiveErrors = (ch.consecutiveErrors || 0) + 1;
      ch.lastError = err.message || String(err);
    }
  }

  await StorageAdapter.setLocal({ channels, pending });
  await setStatus({ lastError: "", lastDiscoverAt: Date.now() });

  // Có video mới thì phân loại ngay, không đợi hết chu kỳ vòng 2.
  if (foundCount > 0 && classifyImmediately) await checkPendingVideos({ channelId });
}
