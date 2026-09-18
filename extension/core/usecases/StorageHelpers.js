// StorageHelpers.js — Constants, monitor queue, and storage accessors
//
// Trách nhiệm duy nhất: đọc/ghi chrome.storage cho các trường dùng chung
// (channels, pending, apiKey, status, badge) và serialize tất cả thao tác
// ghi thông qua một hàng chờ duy nhất (monitorQueue).

import { isWaitingForLive } from "../domain/Rules.js";
import { StorageAdapter } from "../../adapters/StorageAdapter.js";

// ---------- Constants ----------

export const ALARM_DISCOVER = "ytnotify_discover";
export const ALARM_LIVECHECK = "ytnotify_livecheck";

export const DEFAULT_DISCOVER_SECONDS = 60;
export const DEFAULT_LIVECHECK_SECONDS = 30;

// Chrome không cho alarm chạy dày hơn 30 giây với extension đã đóng gói.
export const MIN_ALARM_SECONDS = 30;

export const API_BASE = "https://www.googleapis.com/youtube/v3";

// Số tab tối đa mở trong một vòng. Nếu máy tắt lâu ngày, nhiều kênh cùng có
// video mới -> tránh bung hàng chục tab một lúc. Phần còn lại vẫn báo notification.
export const MAX_TABS_PER_RUN = 3;

// Khi browser vừa mở, probe một vài entry RSS gần nhất kể cả đã từng "seen".
// Mục đích duy nhất là bắt livestream đã bắt đầu trong lúc browser tắt.
export const STARTUP_LIVE_PROBE_PER_CHANNEL = 5;
export const ADD_CHANNEL_LIVE_PROBE_LIMIT = 15;

// ---------- Monitor Queue ----------

// Một chủ sở hữu cho channels/pending và các hiệu ứng tab/notification.
// Các hàm bên trong một job gọi nhau trực tiếp, không tự xếp hàng lần nữa.
let monitorQueue = Promise.resolve();
export function runMonitorTask(task) {
  const result = monitorQueue.then(task);
  monitorQueue = result.catch(() => {});
  return result;
}

export function reportMonitorError(err) {
  console.error("Live check failed:", err);
  return setStatus({ lastError: err?.message || String(err) });
}

// ---------- Storage Accessors ----------

export async function getChannels() {
  const { channels } = await StorageAdapter.getLocal({ channels: {} });
  return channels || {};
}

export async function getPending() {
  const { pending } = await StorageAdapter.getLocal({ pending: {} });
  return pending || {};
}

export async function getApiKey() {
  const { apiKey } = await StorageAdapter.getLocal({ apiKey: "" });
  return (apiKey || "").trim();
}

export async function getIntervals() {
  const { discoverSeconds, liveCheckSeconds } = await StorageAdapter.getLocal({
    discoverSeconds: DEFAULT_DISCOVER_SECONDS,
    liveCheckSeconds: DEFAULT_LIVECHECK_SECONDS,
  });
  return {
    discoverSeconds: Math.max(MIN_ALARM_SECONDS, discoverSeconds || DEFAULT_DISCOVER_SECONDS),
    liveCheckSeconds: Math.max(MIN_ALARM_SECONDS, liveCheckSeconds || DEFAULT_LIVECHECK_SECONDS),
  };
}

export async function setStatus(patch) {
  const cur = await StorageAdapter.getLocal({ status: {} });
  await StorageAdapter.setLocal({ status: { ...(cur.status || {}), ...patch } });
  await updateBadge();
}

export async function updateBadge() {
  const { status, pending, channels } = await StorageAdapter.getLocal({ status: {}, pending: {}, channels: {} });
  // Badge chỉ phản ánh đúng số livestream đang CHỜ lên sóng.
  const waiting = Object.values(pending || {}).filter((entry) => channels[entry?.channelId]?.watched && isWaitingForLive(entry)).length;

  if (status && status.lastError) {
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#e01e1e" });
  } else if (waiting > 0) {
    chrome.action.setBadgeText({ text: String(waiting) });
    chrome.action.setBadgeBackgroundColor({ color: "#1f7a3d" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

// ---------- Session Helpers ----------

export async function getLiveOpenedThisSession() {
  const { liveOpenedThisSession } = await StorageAdapter.getSession({ liveOpenedThisSession: {} });
  return liveOpenedThisSession || {};
}

export async function markLiveOpenedThisSession(videoId) {
  if (!videoId) return;
  const opened = await getLiveOpenedThisSession();
  if (opened[videoId]) return;
  opened[videoId] = Date.now();

  // Không loại ID còn thuộc phiên hiện tại: re-add kênh cũ cũng không mở lại.
  await StorageAdapter.setSession({ liveOpenedThisSession: opened });
}

// ---------- Alarms ----------

export async function ensureAlarms() {
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

export async function clearLegacyOAuthStorage() {
  // Trước v1.1.1 access token từng được lưu bền trong chrome.storage.local.
  // Từ v1.1.1 token chỉ nằm trong chrome.storage.session.
  await chrome.storage.local.remove(["oauthToken", "oauthTokenExpires"]);
}

