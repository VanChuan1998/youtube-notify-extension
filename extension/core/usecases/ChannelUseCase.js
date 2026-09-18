// ChannelUseCase.js — Quản lý kênh: thêm, cập nhật, xoá, khởi tạo baseline
//
// Trách nhiệm duy nhất: CRUD tracked channels và chốt baseline khi thêm kênh mới.

import { StorageAdapter } from "../../adapters/StorageAdapter.js";
import { getChannels, getPending, updateBadge, ADD_CHANNEL_LIVE_PROBE_LIMIT } from "./StorageHelpers.js";
import { discoverNewVideos } from "./DiscoverUseCase.js";
import { checkPendingVideos } from "./PendingUseCase.js";

// ---------- Channel Baseline ----------

export async function initChannelBaseline(channelId) {
  const channels = await getChannels();
  const ch = channels[channelId];
  if (!ch?.watched) return;
  // Lưu ý định probe trước I/O: nếu RSS lỗi hoặc worker dừng, discovery sẽ thử lại.
  ch.needsLiveProbe = true;
  await StorageAdapter.setLocal({ channels });
  await discoverNewVideos({ channelId, probeRecentForLive: true,
    probeLimit: ADD_CHANNEL_LIVE_PROBE_LIMIT, classifyImmediately: false });
  await checkPendingVideos({ channelId, force: true });
  const latest = (await getChannels())[channelId];
  if (latest?.lastError) throw new Error(latest.lastError);
}

// ---------- Add Channel ----------

export async function addTrackedChannel(info, source) {
  if (!info || !/^UC[0-9A-Za-z_-]{22}$/.test(info.id || "")) throw new Error("Channel ID không hợp lệ");
  const channels = await getChannels();
  // Re-add không xoá mode, seen IDs, title hoặc nguồn nhập của kênh đã có.
  channels[info.id] = {
    id: info.id, title: info.title || info.id, thumbnail: info.thumbnail || "",
    mode: "all", initialized: false, seenVideoIds: [], etag: "", lastModified: "",
    addedAt: Date.now(), source: source === "subscription" ? "subscription" : "manual",
    ...channels[info.id], watched: true, needsLiveProbe: true,
  };
  await StorageAdapter.setLocal({ channels });
  await initChannelBaseline(info.id);
}

// ---------- Update / Remove Channel ----------

export async function updateTrackedChannel(channelId, patch, remove = false) {
  const channels = await getChannels();
  if (!channels[channelId]) return;
  const wasWatched = channels[channelId].watched;
  if (remove) delete channels[channelId];
  else {
    if (typeof patch.watched === "boolean") channels[channelId].watched = patch.watched;
    if (["all", "liveOnly"].includes(patch.mode)) channels[channelId].mode = patch.mode;
  }
  const pending = await getPending();
  if (!channels[channelId]?.watched) {
    for (const [id, entry] of Object.entries(pending)) {
      if (entry.channelId === channelId) delete pending[id];
    }
  }
  await StorageAdapter.setLocal({ channels, pending });
  await updateBadge();
  if (!wasWatched && channels[channelId]?.watched) await initChannelBaseline(channelId);
}
