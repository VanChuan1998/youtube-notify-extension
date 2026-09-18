// PendingUseCase.js — Vòng 2: phân loại + theo dõi trạng thái live
//
// Gom toàn bộ ID đang chờ vào MỘT lệnh videos.list (1 unit, tối đa 50 ID)
// để biết video là loại gì. Chỉ mở tab khi livestream thực sự lên sóng.

import {
  classifyVideo, shouldOpenTab, shouldRecheck, isExpired,
  chunkIds, hasStreamStarted, rememberSeen,
} from "../domain/Rules.js";
import { StorageAdapter } from "../../adapters/StorageAdapter.js";
import { OAuthManager } from "./OAuthManager.js";
import {
  getChannels, getPending, getApiKey, setStatus, updateBadge,
  getLiveOpenedThisSession, markLiveOpenedThisSession,
  MAX_TABS_PER_RUN,
} from "./StorageHelpers.js";
import { apiFetch } from "./YouTubeApiClient.js";

// ---------- Vòng 2: phân loại và theo dõi trạng thái live ----------

export async function checkPendingVideos({ channelId = "", force = false } = {}) {
  const pending = await getPending();
  const channels = await getChannels();
  const now = Date.now();

  // Dọn các mục quá hạn trước, để không kéo theo chúng vào lệnh gọi API.
  let changed = false;
  const knownEndedTitles = [];
  for (const [id, entry] of Object.entries(pending)) {
    if (!entry || !channels[entry.channelId]?.watched) {
      delete pending[id];
      changed = true;
      continue;
    }
    if (channelId && entry.channelId !== channelId) continue;
    if (entry.state === "ended" || entry.actualEndTime || entry.state === "none" ||
        (channels[entry.channelId].endedVideoIds || []).includes(entry.videoId)) {
      if (!(channels[entry.channelId].endedVideoIds || []).includes(entry.videoId)) {
        knownEndedTitles.push({ channelId: entry.channelId, videoId: entry.videoId, title: entry.title,
          ended: entry.state === "ended" || !!entry.actualEndTime });
      }
      delete pending[id];
      changed = true;
      continue;
    }
    if (!hasStreamStarted(entry) && isExpired(entry, now)) {
      delete pending[id];
      changed = true;
    }
  }
  await updateLatestTitlesFromApi(knownEndedTitles);

  const due = Object.values(pending).filter((e) =>
    (!channelId || e.channelId === channelId) && (force || shouldRecheck(e, now))
  );
  if (due.length === 0) {
    if (changed) {
      await StorageAdapter.setLocal({ pending, channels });
    }
    await updateBadge();
    return;
  }

  const apiKey = await getApiKey();
  const oauthToken = apiKey ? "" : await OAuthManager.getCachedOAuthToken();

  const validDue = [];
  for (const e of due) {
    const ch = channels[e.channelId];
    if (!ch || ch.mode === "disabled" || !ch.watched) {
      delete pending[e.videoId];
      changed = true;
    } else {
      validDue.push(e);
    }
  }

  if (validDue.length === 0) {
    console.error("CHECK_PENDING_EARLY_RETURN", pending, changed);
    if (changed) await StorageAdapter.setLocal({ pending, channels });
    await updateBadge();
    return;
  }

  if (!apiKey && !oauthToken) {
    const { googleOAuthAuthorized } = await StorageAdapter.getLocal({ googleOAuthAuthorized: false });
    for (const entry of validDue) entry.verificationError = "Chưa có kết nối để kiểm tra lại trạng thái.";
    await StorageAdapter.setLocal({ pending });
    await setStatus({
      lastError: googleOAuthAuthorized
        ? "Kết nối Google hiện không có access token hợp lệ. Mở extension và bấm Kết nối Google/Làm mới để xác thực lại."
        : "Cần API key hoặc kết nối Google để phân loại chính xác video/livestream đang chờ.",
      lastLiveCheckAt: now,
    });
    return;
  }

  const classified = [];

  try {
    for (const batch of chunkIds(validDue.map((e) => e.videoId))) {
      const data = await apiFetch(
        "/videos",
        { part: "snippet,liveStreamingDetails", id: batch.join(",") },
        { apiKey, oauthToken: apiKey ? "" : oauthToken }
      );

      if (!Array.isArray(data.items)) throw new Error("YouTube trả dữ liệu video không hợp lệ; sẽ kiểm tra lại.");

      const byId = new Map((data.items || []).map((it) => [it.id, it]));

      for (const videoId of batch) {
        const entry = pending[videoId];
        if (!entry) continue;

        const item = byId.get(videoId);
        if (!item) {
          delete pending[videoId];
          changed = true;
          continue;
        }

        entry.lastCheckedAt = now;
        entry.lastVerifiedAt = Date.now();
        delete entry.verificationError;
        entry.title = (item.snippet && item.snippet.title) || entry.title;
        entry.scheduledStartTime =
          (item.liveStreamingDetails && item.liveStreamingDetails.scheduledStartTime) || "";

        const state = classifyVideo(item, entry);
        entry.actualStartTime = item.liveStreamingDetails?.actualStartTime || entry.actualStartTime || "";
        entry.actualEndTime = item.liveStreamingDetails?.actualEndTime || entry.actualEndTime || "";
        classified.push({ entry, state });
      }
    }
  } catch (err) {
    if (err && err.status === 401 && !apiKey && oauthToken) {
      // Token hết hạn nằm trong session — xoá ở đó để getCachedOAuthToken tự restore.
      await StorageAdapter.removeSession(["oauthToken", "oauthTokenExpires"]);
    }
    const completed = new Set(classified.map(({ entry }) => entry.videoId));
    for (const entry of due) {
      if (pending[entry.videoId] && !completed.has(entry.videoId)) entry.verificationError = err.message || String(err);
    }
    await handleClassified(classified, pending, channels);
    await setStatus({ lastError: err.message || String(err), lastLiveCheckAt: now });
    return;
  }

  const deliveryError = await handleClassified(classified, pending, channels);
  await setStatus({ lastError: deliveryError, lastLiveCheckAt: now });
}

// ---------- Title Updates ----------

async function updateLatestTitlesFromApi(updates) {
  if (!updates.length) return;

  const latestChannels = await getChannels();
  let changed = false;

  for (const { channelId, videoId, title, ended } of updates) {
    const ch = latestChannels[channelId];
    if (!ch) continue;
    if (ended && !(ch.endedVideoIds || []).includes(videoId)) {
      ch.endedVideoIds = rememberSeen(ch.endedVideoIds, [videoId]);
      changed = true;
    }
    if (!title) continue;

    const newestKnownId = ch.lastCheckedVideoId || (Array.isArray(ch.seenVideoIds) ? ch.seenVideoIds[0] : "");
    if (newestKnownId && newestKnownId !== videoId) continue;

    if (ch.lastCheckedVideoId !== videoId) {
      ch.lastCheckedVideoId = videoId;
      changed = true;
    }
    if (ch.lastCheckedTitle !== title) {
      ch.lastCheckedTitle = title;
      changed = true;
    }
  }

  if (changed) await StorageAdapter.setLocal({ channels: latestChannels });
}

// ---------- Handle Classified ----------

async function handleClassified(classified, pending, channelsArg) {
  const channels = channelsArg || (await getChannels());
  const liveOpenedThisSession = await getLiveOpenedThisSession();
  const { liveNotifiedThisSession = {} } = await StorageAdapter.getSession({ liveNotifiedThisSession: {} });
  let tabsOpened = 0;
  const latestTitleUpdates = [];
  const deliveryErrors = [];

  for (const { entry, state } of classified) {
    const ch = channels[entry.channelId] || {};
    if (!ch.watched) {
      delete pending[entry.videoId];
      continue;
    }
    const mode = ch.mode === "liveOnly" ? "liveOnly" : "all";
    const previousState = entry.state || "unknown";

    if (state === "unknown") {
      entry.state = "unknown";
      pending[entry.videoId] = entry;
      continue;
    }

    if (state === "upcoming") {
      entry.state = "upcoming";
      pending[entry.videoId] = entry;
      continue;
    }

    if (state === "live") {
      entry.state = "live";
      delete entry.startupLiveProbe;
      const alreadyOpenedThisSession = !!liveOpenedThisSession[entry.videoId];

      if (!alreadyOpenedThisSession) {
        console.error("HANDLE_LIVE", entry.videoId, mode, tabsOpened);
        if (shouldOpenTab(state, mode) && tabsOpened < MAX_TABS_PER_RUN) {
          try {
            await chrome.tabs.create({
              url: `https://www.youtube.com/watch?v=${entry.videoId}`,
              active: false,
            });
            console.error("TAB_CREATED", entry.videoId);
            tabsOpened++;
            liveOpenedThisSession[entry.videoId] = Date.now();
            await markLiveOpenedThisSession(entry.videoId);
          } catch (tabErr) {
            console.error("Mở tab thất bại:", tabErr);
            deliveryErrors.push("Không mở được tab: " + (tabErr.message || String(tabErr)));
          }
        }
      }

      if (!liveNotifiedThisSession[entry.videoId]) {
        try {
          await notify(entry, state, ch);
          liveNotifiedThisSession[entry.videoId] = Date.now();
          await StorageAdapter.setSession({ liveNotifiedThisSession });
        } catch (err) {
          deliveryErrors.push("Không gửi được thông báo: " + (err.message || String(err)));
        }
      }

      if (!entry.liveHandledAt) entry.liveHandledAt = Date.now();
      pending[entry.videoId] = entry;
      continue;
    }

    if (state === "ended" || state === "none") {
      latestTitleUpdates.push({
        channelId: entry.channelId,
        videoId: entry.videoId,
        title: entry.title || "",
        ended: state === "ended",
      });
    }

    if (entry.startupLiveProbe && (state === "none" || state === "ended")) {
      delete pending[entry.videoId];
      continue;
    }

    const wasAlreadyLive = previousState === "live" || !!entry.liveHandledAt;

    if ((state === "ended" || state === "none") && wasAlreadyLive) {
      delete pending[entry.videoId];
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
          console.error("Mở tab thất bại:", tabErr);
        }
      }
      try { await notify(entry, state, ch); }
      catch (err) { deliveryErrors.push("Không gửi được thông báo: " + (err.message || String(err))); }
    } else if (state !== "upcoming" && mode === "liveOnly") {
      try { await notify(entry, state, ch); }
      catch (err) { deliveryErrors.push("Không gửi được thông báo: " + (err.message || String(err))); }
    }

    delete pending[entry.videoId];
  }

  await StorageAdapter.setLocal({ pending });
  await updateLatestTitlesFromApi(latestTitleUpdates);
  await updateBadge();
  return deliveryErrors.join("; ");
}

// ---------- Notification ----------

function notify(entry, state, ch) {
  const nhan = state === "live" ? "🔴 ĐANG LIVE" : "Video mới";
  return chrome.notifications.create(`ytnotify_${entry.videoId}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `${nhan} — ${ch.title || "Kênh đã theo dõi"}`,
    message: entry.title || entry.videoId,
    priority: 2,
  });
}

// Bấm vào notification thì mở video.
chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith("ytnotify_")) return;
  const videoId = id.slice("ytnotify_".length);
  chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}`, active: true });
  chrome.notifications.clear(id);
});
