// LifecycleController.js — Chrome lifecycle + alarm event handlers
//
// Trách nhiệm duy nhất: đăng ký các listener cho onInstalled, onStartup, onAlarm.

import { runMonitorTask, reportMonitorError, ensureAlarms, clearLegacyOAuthStorage, updateBadge } from "./StorageHelpers.js";
import { discoverNewVideos } from "./DiscoverUseCase.js";
import { checkPendingVideos } from "./PendingUseCase.js";
import { OAuthManager } from "./OAuthManager.js";

const ALARM_DISCOVER = "ytnotify_discover";
const ALARM_LIVECHECK = "ytnotify_livecheck";
const ALARM_TOKEN_REFRESH = "ytnotify_token_refresh";
const TOKEN_REFRESH_PERIOD_MINUTES = 45;

async function ensureTokenRefreshAlarm() {
  const existing = await new Promise((r) => chrome.alarms.getAll(r));
  if (!existing.some((a) => a.name === ALARM_TOKEN_REFRESH)) {
    chrome.alarms.create(ALARM_TOKEN_REFRESH, { periodInMinutes: TOKEN_REFRESH_PERIOD_MINUTES });
  }
}

async function refreshOAuthToken() {
  try {
    await OAuthManager.getCachedOAuthToken({ forceRefresh: true });
  } catch (err) {
    console.debug("Token refresh alarm thất bại, chờ lần tiếp theo:", err?.message || String(err));
  }
}

async function runStartupChecks() {
  await clearLegacyOAuthStorage();
  await OAuthManager.restoreOAuthOnStartup();
  await ensureAlarms();
  await ensureTokenRefreshAlarm();
  await updateBadge();

  // Không chờ alarm đầu tiên. Khi Edge/Chrome vừa mở, quét RSS ngay rồi phân loại
  // toàn bộ pending. Nhờ vậy nếu livestream đã bắt đầu trong lúc trình duyệt tắt,
  // extension vẫn nhận ra trạng thái live và mở tab ngay sau khi browser khởi động.
  await discoverNewVideos({
    classifyImmediately: false,
    probeRecentForLive: true,
  });
  await checkPendingVideos({ force: true });
}

export function setupLifecycle() {
  chrome.runtime.onInstalled.addListener(() => {
    return runMonitorTask(runStartupChecks).catch(reportMonitorError);
  });

  chrome.runtime.onStartup.addListener(() => {
    return runMonitorTask(runStartupChecks).catch(reportMonitorError);
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_DISCOVER) return runMonitorTask(discoverNewVideos).catch(reportMonitorError);
    if (alarm.name === ALARM_LIVECHECK) return runMonitorTask(() => checkPendingVideos({ force: true })).catch(reportMonitorError);
    if (alarm.name === ALARM_TOKEN_REFRESH) return runMonitorTask(refreshOAuthToken).catch(reportMonitorError);
  });
}
