// LifecycleController.js — Chrome lifecycle + alarm event handlers
//
// Trách nhiệm duy nhất: đăng ký các listener cho onInstalled, onStartup, onAlarm.

import { runMonitorTask, reportMonitorError, ensureAlarms, clearLegacyOAuthStorage, updateBadge } from "./StorageHelpers.js";
import { discoverNewVideos } from "./DiscoverUseCase.js";
import { checkPendingVideos } from "./PendingUseCase.js";

const ALARM_DISCOVER = "ytnotify_discover";
const ALARM_LIVECHECK = "ytnotify_livecheck";

async function runStartupChecks() {
  await clearLegacyOAuthStorage();
  await ensureAlarms();
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
  });
}
