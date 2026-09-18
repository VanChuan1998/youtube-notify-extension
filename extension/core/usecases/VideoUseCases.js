// VideoUseCases.js — Barrel re-export
//
// File này giữ backward compatibility cho tất cả consumer hiện tại
// (MessageController, LifecycleController, test harness).
// Logic thực tế đã được tách thành các module con theo clean architecture.

// StorageHelpers: constants, monitor queue, storage accessors
export {
  runMonitorTask, reportMonitorError,
  getChannels, getPending, getApiKey, setStatus, updateBadge,
  ensureAlarms, clearLegacyOAuthStorage,
} from "./StorageHelpers.js";

// YouTubeApiClient: API fetch, channel resolution
export { apiFetch, resolveChannelInput } from "./YouTubeApiClient.js";

// DiscoverUseCase: RSS discovery loop
export { discoverNewVideos } from "./DiscoverUseCase.js";

// PendingUseCase: classification + live state tracking
export { checkPendingVideos } from "./PendingUseCase.js";

// ChannelUseCase: init/add/update/remove tracked channels
export { initChannelBaseline, addTrackedChannel, updateTrackedChannel } from "./ChannelUseCase.js";
