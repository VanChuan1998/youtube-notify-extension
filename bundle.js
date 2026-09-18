(() => {
  // extension/core/domain/Rules.js
  var SEEN_LIMIT = 40;
  var VIDEOS_LIST_BATCH = 50;
  var NEAR_START_MS = 10 * 60 * 1e3;
  var FAR_CHECK_INTERVAL_MS = 5 * 60 * 1e3;
  var PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
  var UPCOMING_GRACE_MS = 2 * 60 * 60 * 1e3;
  var VERIFIED_STATE_TTL_MS = 10 * 60 * 1e3;
  function hasStreamStarted(entry = {}) {
    return !!(entry.actualStartTime || entry.liveHandledAt || entry.state === "live");
  }
  function isWaitingForLive(entry, now = Date.now()) {
    if (!entry || entry.state !== "upcoming" || entry.actualEndTime || hasStreamStarted(entry) || entry.verificationError) return false;
    const startsAt = Date.parse(entry.scheduledStartTime || "");
    const checkedAt = Number(entry.lastVerifiedAt || 0);
    return Number.isFinite(startsAt) && now <= startsAt + UPCOMING_GRACE_MS && checkedAt > 0 && now - checkedAt <= VERIFIED_STATE_TTL_MS;
  }
  function findNewVideos(feedVideos, seenVideoIds) {
    const seen = new Set(seenVideoIds || []);
    return feedVideos.filter((v) => !seen.has(v.videoId));
  }
  function rememberSeen(seenVideoIds, newIds) {
    const merged = [...newIds, ...seenVideoIds || []];
    const unique = [];
    const seen = /* @__PURE__ */ new Set();
    for (const id of merged) {
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(id);
      }
    }
    return unique.slice(0, SEEN_LIMIT);
  }
  function classifyVideo(item, previous = {}, now = Date.now()) {
    const snippet = item.snippet || {};
    const live = item.liveStreamingDetails || {};
    const broadcast = snippet.liveBroadcastContent || "none";
    if (live.actualEndTime || previous.actualEndTime || previous.state === "ended") return "ended";
    if (broadcast === "live" && live.actualStartTime) return "live";
    if ((broadcast === "live" || broadcast === "upcoming") && (live.actualStartTime || hasStreamStarted(previous))) return "unknown";
    if (broadcast === "upcoming") {
      if (!live.scheduledStartTime && snippet.publishedAt) {
        if (now - Date.parse(snippet.publishedAt) > PENDING_TTL_MS) {
          return "ended";
        }
      }
      return "upcoming";
    }
    if (broadcast === "live") return "upcoming";
    if (live.actualStartTime || hasStreamStarted(previous)) return "ended";
    return "none";
  }
  function shouldOpenTab(state, mode) {
    if (state === "live") return true;
    if (state === "upcoming") return false;
    if (state === "ended") return mode !== "liveOnly";
    return mode !== "liveOnly";
  }
  function shouldRecheck(entry, now) {
    if (entry.state === "unknown" || entry.verificationError || hasStreamStarted(entry)) return true;
    const last = entry.lastCheckedAt || 0;
    if (!entry.scheduledStartTime) return true;
    const startsAt = Date.parse(entry.scheduledStartTime);
    if (Number.isNaN(startsAt)) return true;
    if (startsAt - now <= NEAR_START_MS) return true;
    return now - last >= FAR_CHECK_INTERVAL_MS;
  }
  function isExpired(entry, now) {
    return now - (entry.firstSeenAt || 0) > PENDING_TTL_MS;
  }
  function chunkIds(ids, size = VIDEOS_LIST_BATCH) {
    const out = [];
    for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
    return out;
  }

  // extension/adapters/StorageAdapter.js
  var StorageAdapter = {
    getLocal(keys) {
      return chrome.storage.local.get(keys);
    },
    setLocal(items) {
      return chrome.storage.local.set(items);
    },
    removeLocal(keys) {
      return chrome.storage.local.remove(keys);
    },
    getSession(keys) {
      return chrome.storage.session.get(keys);
    },
    setSession(items) {
      return chrome.storage.session.set(items);
    },
    removeSession(keys) {
      return chrome.storage.session.remove(keys);
    }
  };

  // extension/adapters/AuthAdapter.js
  var AuthAdapter = {
    async getAuthTokenNative(interactive) {
      return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive }, (token) => {
          if (chrome.runtime.lastError || !token) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(token);
          }
        });
      });
    },
    async removeCachedAuthToken(token) {
      return new Promise((resolve) => {
        chrome.identity.removeCachedAuthToken({ token }, resolve);
      });
    },
    async launchWebAuthFlow(url, interactive) {
      return new Promise((resolve, reject) => {
        chrome.identity.launchWebAuthFlow({ url, interactive }, (redirectUrl) => {
          if (chrome.runtime.lastError || !redirectUrl) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(redirectUrl);
          }
        });
      });
    },
    getRedirectURL() {
      return chrome.identity.getRedirectURL();
    }
  };

  // extension/core/usecases/OAuthManager.js
  var OAuthManager = {
    async getCachedOAuthToken({ clientId = "", forceRefresh = false } = {}) {
      const manifest = chrome.runtime.getManifest();
      if (manifest.oauth2) {
        try {
          if (forceRefresh) {
            const currentToken = await AuthAdapter.getAuthTokenNative(false).catch(() => null);
            if (currentToken) {
              await AuthAdapter.removeCachedAuthToken(currentToken);
            }
          }
          const nativeToken = await AuthAdapter.getAuthTokenNative(false);
          if (nativeToken) {
            if (clientId) await this.rememberOAuthAuthorization(clientId);
            return nativeToken;
          }
        } catch (err) {
          console.debug("Native getAuthToken ng\u1EA7m th\u1EA5t b\u1EA1i:", err?.message || String(err));
        }
      }
      if (!forceRefresh) {
        const { oauthToken, oauthTokenExpires } = await StorageAdapter.getLocal({ oauthToken: "", oauthTokenExpires: 0 });
        if (oauthToken && oauthTokenExpires && Date.now() < oauthTokenExpires) {
          if (clientId) await this.rememberOAuthAuthorization(clientId);
          return oauthToken;
        }
      }
      await StorageAdapter.removeLocal(["oauthToken", "oauthTokenExpires"]);
      const restored = await this.restoreOAuthTokenSilently(clientId);
      if (!restored) await this.clearOAuthSessionView();
      return restored;
    },
    async getAuthToken(interactive, clientId, prompt) {
      const manifest = chrome.runtime.getManifest();
      if (manifest.oauth2) {
        try {
          const nativeToken = await AuthAdapter.getAuthTokenNative(interactive);
          return { token: nativeToken, expiresIn: 3600 };
        } catch (err) {
          console.debug("Native getAuthToken failed, falling back to WebAuthFlow", err);
        }
      }
      return await this.getAuthTokenWebFlow(interactive, clientId, prompt);
    },
    async getAuthTokenWebFlow(interactive, clientId, prompt) {
      const scopes = ["https://www.googleapis.com/auth/youtube.readonly"];
      const redirectUrl = AuthAdapter.getRedirectURL();
      let authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUrl)}&response_type=token&scope=${encodeURIComponent(scopes.join(" "))}&include_granted_scopes=true`;
      if (prompt) {
        authUrl += `&prompt=${encodeURIComponent(prompt)}`;
      }
      const responseUrl = await AuthAdapter.launchWebAuthFlow(authUrl, interactive);
      const params = new URLSearchParams(new URL(responseUrl).hash.substring(1));
      const token = params.get("access_token");
      if (!token) throw new Error("Kh\xF4ng l\u1EA5y \u0111\u01B0\u1EE3c access_token t\u1EEB URL tr\u1EA3 v\u1EC1");
      return { token, expiresIn: parseInt(params.get("expires_in") || "3600", 10) };
    },
    async restoreOAuthTokenSilently(clientIdOverride = "") {
      const { googleOAuthAuthorized, googleOAuthClientId } = await StorageAdapter.getLocal({ googleOAuthAuthorized: false, googleOAuthClientId: "" });
      const clientId = (clientIdOverride || googleOAuthClientId || "").trim();
      if (!googleOAuthAuthorized || !clientId) return "";
      try {
        const authRes = await this.getAuthTokenWebFlow(false, clientId, "none");
        return await this.saveOAuthSession(authRes, clientId);
      } catch (err) {
        console.debug("Silent Google OAuth restore unavailable:", err?.message || String(err));
        return "";
      }
    },
    async saveOAuthSession(authRes, clientId) {
      const token = authRes?.token || "";
      if (!token) return "";
      const expiresIn = Number(authRes.expiresIn) || 3600;
      await StorageAdapter.setLocal({
        oauthToken: token,
        oauthTokenExpires: Date.now() + expiresIn * 1e3 - 6e4
      });
      await this.rememberOAuthAuthorization(clientId);
      return token;
    },
    async rememberOAuthAuthorization(clientId) {
      const normalized = (clientId || "").trim();
      if (!normalized) return;
      await StorageAdapter.setLocal({ googleOAuthAuthorized: true, googleOAuthClientId: normalized });
    },
    async clearOAuthSessionView() {
      await StorageAdapter.removeSession(["oauthUser", "fetchedSubs", "oauthDataFetchedAt"]);
    },
    async revokeOAuthGrant(token) {
      if (!token) return { success: false, warning: "Kh\xF4ng c\xF3 token" };
      try {
        const manifest = chrome.runtime.getManifest();
        if (manifest.oauth2) {
          await AuthAdapter.removeCachedAuthToken(token).catch(() => {
          });
        }
        const response = await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" }
        });
        if (!response.ok) return { success: false, warning: `L\u1ED7i thu h\u1ED3i token: ${response.status}` };
        return { success: true };
      } catch (err) {
        return { success: false, warning: `L\u1ED7i khi thu h\u1ED3i: ${err.message}` };
      }
    },
    async clearLocalOAuthState({ keepTrackedChannels = true } = {}) {
      await StorageAdapter.removeLocal(["oauthToken", "oauthTokenExpires", "googleOAuthAuthorized"]);
      await StorageAdapter.removeSession(["oauthUser", "fetchedSubs", "oauthDataFetchedAt"]);
      if (!keepTrackedChannels) {
        await StorageAdapter.removeLocal(["channels"]);
      }
    },
    async loadOAuthAccountData(token) {
      const [channelRes, subsRes] = await Promise.all([
        fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()),
        fetch("https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=50", { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json())
      ]);
      if (channelRes.error) throw new Error(channelRes.error.message || "Failed to fetch channel");
      if (subsRes.error) throw new Error(subsRes.error.message || "Failed to fetch subscriptions");
      let oauthUser = null;
      if (channelRes.items && channelRes.items.length > 0) {
        const snippet = channelRes.items[0].snippet;
        oauthUser = { name: snippet.title, thumbnail: snippet.thumbnails?.default?.url };
      }
      let subs = [];
      if (subsRes.items) {
        subs = subsRes.items.map((item) => ({
          id: item.snippet.resourceId.channelId,
          title: item.snippet.title,
          thumbnail: item.snippet.thumbnails?.default?.url
        }));
      }
      await StorageAdapter.setSession({ oauthUser, fetchedSubs: subs, oauthDataFetchedAt: Date.now() });
      return { subs, oauthUser };
    }
  };

  // extension/background.js
  var ALARM_DISCOVER = "ytnotify_discover";
  var ALARM_LIVECHECK = "ytnotify_livecheck";
  var DEFAULT_DISCOVER_SECONDS = 60;
  var DEFAULT_LIVECHECK_SECONDS = 30;
  var MIN_ALARM_SECONDS = 30;
  var API_BASE = "https://www.googleapis.com/youtube/v3";
  var MAX_TABS_PER_RUN = 3;
  var STARTUP_LIVE_PROBE_PER_CHANNEL = 5;
  var ADD_CHANNEL_LIVE_PROBE_LIMIT = 15;
  var monitorQueue = Promise.resolve();
  function runMonitorTask(task) {
    const result = monitorQueue.then(task);
    monitorQueue = result.catch(() => {
    });
    return result;
  }
  function reportMonitorError(err) {
    console.error("Live check failed:", err);
    return setStatus({ lastError: err?.message || String(err) });
  }
  async function getLiveOpenedThisSession() {
    const { liveOpenedThisSession } = await StorageAdapter.getSession({ liveOpenedThisSession: {} });
    return liveOpenedThisSession || {};
  }
  async function markLiveOpenedThisSession(videoId) {
    if (!videoId) return;
    const opened = await getLiveOpenedThisSession();
    if (opened[videoId]) return;
    opened[videoId] = Date.now();
    await StorageAdapter.setSession({ liveOpenedThisSession: opened });
  }
  async function getChannels() {
    const { channels } = await StorageAdapter.getLocal({ channels: {} });
    return channels || {};
  }
  async function getPending() {
    const { pending } = await StorageAdapter.getLocal({ pending: {} });
    return pending || {};
  }
  async function getApiKey() {
    const { apiKey } = await StorageAdapter.getLocal({ apiKey: "" });
    return (apiKey || "").trim();
  }
  async function getIntervals() {
    const { discoverSeconds, liveCheckSeconds } = await StorageAdapter.getLocal({
      discoverSeconds: DEFAULT_DISCOVER_SECONDS,
      liveCheckSeconds: DEFAULT_LIVECHECK_SECONDS
    });
    return {
      discoverSeconds: Math.max(MIN_ALARM_SECONDS, discoverSeconds || DEFAULT_DISCOVER_SECONDS),
      liveCheckSeconds: Math.max(MIN_ALARM_SECONDS, liveCheckSeconds || DEFAULT_LIVECHECK_SECONDS)
    };
  }
  async function setStatus(patch) {
    const cur = await StorageAdapter.getLocal({ status: {} });
    await StorageAdapter.setLocal({ status: { ...cur.status || {}, ...patch } });
    await updateBadge();
  }
  async function updateBadge() {
    const { status, pending, channels } = await StorageAdapter.getLocal({ status: {}, pending: {}, channels: {} });
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
  async function ensureAlarms() {
    const { discoverSeconds, liveCheckSeconds } = await getIntervals();
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
  async function clearLegacyOAuthStorage() {
    await chrome.storage.local.remove(["oauthToken", "oauthTokenExpires", "oauthUser", "fetchedSubs", "oauthDataFetchedAt"]);
  }
  chrome.runtime.onInstalled.addListener(() => {
    return runMonitorTask(runStartupChecks).catch(reportMonitorError);
  });
  async function runStartupChecks() {
    await clearLegacyOAuthStorage();
    await ensureAlarms();
    await updateBadge();
    await discoverNewVideos({
      classifyImmediately: false,
      probeRecentForLive: true
    });
    await checkPendingVideos({ force: true });
  }
  chrome.runtime.onStartup.addListener(() => {
    return runMonitorTask(runStartupChecks).catch(reportMonitorError);
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_DISCOVER) return runMonitorTask(discoverNewVideos).catch(reportMonitorError);
    if (alarm.name === ALARM_LIVECHECK) return runMonitorTask(checkPendingVideos).catch(reportMonitorError);
  });
  async function apiFetch(path, params, credential = {}, options = {}) {
    const requestOnce = async (activeCredential) => {
      const url = new URL(`${API_BASE}${path}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const headers = {};
      if (activeCredential.oauthToken) {
        headers["Authorization"] = `Bearer ${activeCredential.oauthToken}`;
      } else if (activeCredential.apiKey) {
        url.searchParams.set("key", activeCredential.apiKey);
      }
      const res = await fetch(url.toString(), { headers, ...path === "/videos" ? { cache: "no-store" } : {} });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const err = new Error(`HTTP ${res.status}: ph\u1EA3n h\u1ED3i kh\xF4ng ph\u1EA3i JSON`);
        err.status = res.status;
        throw err;
      }
      if (!res.ok) {
        const err = new Error(data && data.error && data.error.message || `HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    };
    try {
      return await requestOnce(credential);
    } catch (err) {
      if (err && err.status === 401 && credential.oauthToken && options.retryOAuth !== false) {
        const refreshedToken = await OAuthManager.getCachedOAuthToken({ forceRefresh: true });
        if (refreshedToken) {
          return requestOnce({ ...credential, oauthToken: refreshedToken });
        }
      }
      throw err;
    }
  }
  async function fetchChannelInfoById(channelId, credential = {}) {
    const data = await apiFetch("/channels", { part: "snippet", id: channelId }, credential);
    const item = data.items && data.items[0];
    if (!item) throw new Error("Kh\xF4ng t\xECm th\u1EA5y k\xEAnh v\u1EDBi ID: " + channelId);
    const thumbs = item.snippet.thumbnails || {};
    return {
      id: item.id,
      title: item.snippet.title,
      thumbnail: (thumbs.default || thumbs.medium || {}).url || ""
    };
  }
  var CHANNEL_ID_RE = /UC[0-9A-Za-z_-]{22}/;
  async function channelInfoFromFeed(channelId) {
    const res = await fetch(feedUrlForChannel(channelId));
    if (!res.ok) throw new Error(`Kh\xF4ng t\u1EA3i \u0111\u01B0\u1EE3c feed c\u1EE7a k\xEAnh (HTTP ${res.status})`);
    const info = parseChannelInfo(await res.text());
    if (!info.id) throw new Error("Feed kh\xF4ng h\u1EE3p l\u1EC7 ho\u1EB7c k\xEAnh kh\xF4ng t\u1ED3n t\u1EA1i");
    return { id: info.id, title: info.title || info.id, thumbnail: "" };
  }
  async function fetchChannelInfoByHandle(handle, credential) {
    const clean = handle.replace(/^@/, "");
    const data = await apiFetch("/channels", { part: "snippet", forHandle: clean }, credential);
    const item = data.items && data.items[0];
    if (!item) throw new Error("Kh\xF4ng t\xECm th\u1EA5y k\xEAnh v\u1EDBi @handle: " + handle);
    const thumbs = item.snippet.thumbnails || {};
    return {
      id: item.id,
      title: item.snippet.title,
      thumbnail: (thumbs.default || thumbs.medium || {}).url || ""
    };
  }
  async function fetchChannelInfoByUsername(username, credential) {
    const data = await apiFetch("/channels", { part: "snippet", forUsername: username }, credential);
    const item = data.items && data.items[0];
    if (!item) throw new Error("Kh\xF4ng t\xECm th\u1EA5y k\xEAnh v\u1EDBi username: " + username);
    const thumbs = item.snippet.thumbnails || {};
    return {
      id: item.id,
      title: item.snippet.title,
      thumbnail: (thumbs.default || thumbs.medium || {}).url || ""
    };
  }
  async function resolveChannelInput(rawInput, credential = {}) {
    const input = (rawInput || "").trim();
    if (!input) throw new Error("Vui l\xF2ng nh\u1EADp URL ho\u1EB7c t\xEAn k\xEAnh");
    const hasApiCredential = !!(credential.apiKey || credential.oauthToken);
    const direct = input.match(CHANNEL_ID_RE);
    if (direct) {
      const id = direct[0];
      if (hasApiCredential) {
        try {
          return await fetchChannelInfoById(id, credential);
        } catch {
        }
      }
      return await channelInfoFromFeed(id);
    }
    const trimmed = input.replace(/^https?:\/\/(www\.)?youtube\.com\//i, "");
    const firstSegment = trimmed.split(/[/?#]/)[0];
    if (input.startsWith("@") || firstSegment.startsWith("@")) {
      if (!hasApiCredential) {
        throw new Error("\u0110\u1EC3 th\xEAm b\u1EB1ng @handle, h\xE3y k\u1EBFt n\u1ED1i Google ho\u1EB7c nh\u1EADp YouTube Data API key. B\u1EA1n v\u1EABn c\xF3 th\u1EC3 d\xE1n URL /channel/UC... ho\u1EB7c channel ID tr\u1EF1c ti\u1EBFp.");
      }
      return await fetchChannelInfoByHandle(input.startsWith("@") ? input : firstSegment, credential);
    }
    if (/^user\//i.test(trimmed)) {
      if (!hasApiCredential) {
        throw new Error("\u0110\u1EC3 th\xEAm URL /user/..., h\xE3y k\u1EBFt n\u1ED1i Google ho\u1EB7c nh\u1EADp YouTube Data API key.");
      }
      return await fetchChannelInfoByUsername(trimmed.split(/[/?#]/)[1] || "", credential);
    }
    if (!hasApiCredential) {
      throw new Error("Kh\xF4ng th\u1EC3 t\xECm theo t\xEAn khi ch\u01B0a c\xF3 API credential. H\xE3y k\u1EBFt n\u1ED1i Google, nh\u1EADp API key, ho\u1EB7c d\xE1n channel ID (UC...).");
    }
    const query = /^c\//i.test(trimmed) ? trimmed.split(/[/?#]/)[1] || input : input;
    const search = await apiFetch(
      "/search",
      { part: "snippet", type: "channel", q: query, maxResults: 1 },
      credential
    );
    const first = search.items && search.items[0];
    if (!first) throw new Error("Kh\xF4ng t\xECm th\u1EA5y k\xEAnh ph\xF9 h\u1EE3p v\u1EDBi: " + input);
    return await fetchChannelInfoById(first.snippet.channelId, credential);
  }
  async function fetchWithRetry(url, options = {}, maxRetries = 2) {
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1e3 * attempt));
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
  async function discoverNewVideos({
    classifyImmediately = true,
    probeRecentForLive = false,
    channelId = "",
    probeLimit = STARTUP_LIVE_PROBE_PER_CHANNEL
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
    const credential = apiKey ? { apiKey } : oauthToken ? { oauthToken } : null;
    for (const ch of watched) {
      try {
        const needsProbe = probeRecentForLive || ch.needsLiveProbe || !ch.initialized;
        let items = [];
        let apiSuccess = false;
        if (credential) {
          try {
            const uulId = "UUL" + ch.id.substring(2);
            const data = await apiFetch("/playlistItems", { part: "snippet", playlistId: uulId, maxResults: 15 }, credential);
            if (data.items) {
              items = data.items.map((item) => ({
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
        const headers = {};
        if (!needsProbe && !apiSuccess) {
          if (ch.etag) headers["If-None-Match"] = ch.etag;
          else if (ch.lastModified) headers["If-Modified-Since"] = ch.lastModified;
        }
        const res = await fetchWithRetry(feedUrlForChannel(ch.id), {
          headers,
          ...needsProbe ? { cache: "no-store" } : {}
        });
        if (res.status === 304 && !apiSuccess) {
          ch.lastError = "";
          ch.consecutiveErrors = 0;
          continue;
        }
        if (res.status === 404 && !apiSuccess) {
          ch.consecutiveErrors = (ch.consecutiveErrors || 0) + 1;
          if (ch.consecutiveErrors >= 3) {
            ch.lastError = "\u0110\xE3 th\u1EED l\u1EA1i nh\u01B0ng YouTube v\u1EABn ch\u1EB7n k\xEAnh n\xE0y (404). K\xEAnh c\xF3 th\u1EC3 b\u1ECB x\xF3a ho\u1EB7c kh\xF3a feed.";
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
        const seenIds = /* @__PURE__ */ new Set();
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
              startupLiveProbe: true
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
              lastCheckedAt: 0
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
    if (foundCount > 0 && classifyImmediately) await checkPendingVideos({ channelId });
  }
  async function checkPendingVideos({ channelId = "", force = false } = {}) {
    const pending = await getPending();
    const channels = await getChannels();
    const now = Date.now();
    let changed = false;
    const knownEndedTitles = [];
    for (const [id, entry] of Object.entries(pending)) {
      if (!entry || !channels[entry.channelId]?.watched) {
        delete pending[id];
        changed = true;
        continue;
      }
      if (channelId && entry.channelId !== channelId) continue;
      if (entry.state === "ended" || entry.actualEndTime || entry.state === "none" || (channels[entry.channelId].endedVideoIds || []).includes(entry.videoId)) {
        if (!(channels[entry.channelId].endedVideoIds || []).includes(entry.videoId)) {
          knownEndedTitles.push({
            channelId: entry.channelId,
            videoId: entry.videoId,
            title: entry.title,
            ended: entry.state === "ended" || !!entry.actualEndTime
          });
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
    const due = Object.values(pending).filter(
      (e) => (!channelId || e.channelId === channelId) && (force || shouldRecheck(e, now))
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
      for (const entry of validDue) entry.verificationError = "Ch\u01B0a c\xF3 k\u1EBFt n\u1ED1i \u0111\u1EC3 ki\u1EC3m tra l\u1EA1i tr\u1EA1ng th\xE1i.";
      await StorageAdapter.setLocal({ pending });
      await setStatus({
        lastError: googleOAuthAuthorized ? "K\u1EBFt n\u1ED1i Google hi\u1EC7n kh\xF4ng c\xF3 access token h\u1EE3p l\u1EC7. M\u1EDF extension v\xE0 b\u1EA5m K\u1EBFt n\u1ED1i Google/L\xE0m m\u1EDBi \u0111\u1EC3 x\xE1c th\u1EF1c l\u1EA1i." : "C\u1EA7n API key ho\u1EB7c k\u1EBFt n\u1ED1i Google \u0111\u1EC3 ph\xE2n lo\u1EA1i ch\xEDnh x\xE1c video/livestream \u0111ang ch\u1EDD.",
        lastLiveCheckAt: now
      });
      return;
    }
    const classified = [];
    let tabsOpened = 0;
    let deliveredTabs = false;
    try {
      for (const batch of chunkIds(validDue.map((e) => e.videoId))) {
        const data = await apiFetch(
          "/videos",
          { part: "snippet,liveStreamingDetails", id: batch.join(",") },
          { apiKey, oauthToken: apiKey ? "" : oauthToken }
        );
        if (!Array.isArray(data.items)) throw new Error("YouTube tr\u1EA3 d\u1EEF li\u1EC7u video kh\xF4ng h\u1EE3p l\u1EC7; s\u1EBD ki\u1EC3m tra l\u1EA1i.");
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
          entry.title = item.snippet && item.snippet.title || entry.title;
          entry.scheduledStartTime = item.liveStreamingDetails && item.liveStreamingDetails.scheduledStartTime || "";
          const state = classifyVideo(item, entry);
          entry.actualStartTime = item.liveStreamingDetails?.actualStartTime || entry.actualStartTime || "";
          entry.actualEndTime = item.liveStreamingDetails?.actualEndTime || entry.actualEndTime || "";
          classified.push({ entry, state });
        }
      }
    } catch (err) {
      if (err && err.status === 401 && !apiKey && oauthToken) {
        await StorageAdapter.removeLocal(["oauthToken", "oauthTokenExpires", "oauthUser", "fetchedSubs", "oauthDataFetchedAt"]);
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
  async function handleClassified(classified, pending, channelsArg) {
    const channels = channelsArg || await getChannels();
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
                active: false
              });
              console.error("TAB_CREATED", entry.videoId);
              tabsOpened++;
              liveOpenedThisSession[entry.videoId] = Date.now();
              await markLiveOpenedThisSession(entry.videoId);
            } catch (tabErr) {
              console.error("M\u1EDF tab th\u1EA5t b\u1EA1i:", tabErr);
              deliveryErrors.push("Kh\xF4ng m\u1EDF \u0111\u01B0\u1EE3c tab: " + (tabErr.message || String(tabErr)));
            }
          }
        }
        if (!liveNotifiedThisSession[entry.videoId]) {
          try {
            await notify(entry, state, ch);
            liveNotifiedThisSession[entry.videoId] = Date.now();
            await StorageAdapter.setSession({ liveNotifiedThisSession });
          } catch (err) {
            deliveryErrors.push("Kh\xF4ng g\u1EEDi \u0111\u01B0\u1EE3c th\xF4ng b\xE1o: " + (err.message || String(err)));
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
          ended: state === "ended"
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
              active: false
            });
            tabsOpened++;
          } catch (tabErr) {
            console.error("M\u1EDF tab th\u1EA5t b\u1EA1i:", tabErr);
          }
        }
        try {
          await notify(entry, state, ch);
        } catch (err) {
          deliveryErrors.push("Kh\xF4ng g\u1EEDi \u0111\u01B0\u1EE3c th\xF4ng b\xE1o: " + (err.message || String(err)));
        }
      } else if (state !== "upcoming" && mode === "liveOnly") {
        try {
          await notify(entry, state, ch);
        } catch (err) {
          deliveryErrors.push("Kh\xF4ng g\u1EEDi \u0111\u01B0\u1EE3c th\xF4ng b\xE1o: " + (err.message || String(err)));
        }
      }
      delete pending[entry.videoId];
    }
    await StorageAdapter.setLocal({ pending });
    await updateLatestTitlesFromApi(latestTitleUpdates);
    await updateBadge();
    return deliveryErrors.join("; ");
  }
  function notify(entry, state, ch) {
    const nhan = state === "live" ? "\u{1F534} \u0110ANG LIVE" : "Video m\u1EDBi";
    return chrome.notifications.create(`ytnotify_${entry.videoId}`, {
      type: "basic",
      // iconUrl phải là đường dẫn trong extension: service worker MV3 không tải
      // được ảnh remote (https://...) cho notification.
      iconUrl: "icons/icon128.png",
      title: `${nhan} \u2014 ${ch.title || "K\xEAnh \u0111\xE3 theo d\xF5i"}`,
      message: entry.title || entry.videoId,
      priority: 2
    });
  }
  chrome.notifications.onClicked.addListener((id) => {
    if (!id.startsWith("ytnotify_")) return;
    const videoId = id.slice("ytnotify_".length);
    chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}`, active: true });
    chrome.notifications.clear(id);
  });
  async function initChannelBaseline(channelId) {
    const channels = await getChannels();
    const ch = channels[channelId];
    if (!ch?.watched) return;
    ch.needsLiveProbe = true;
    await StorageAdapter.setLocal({ channels });
    await discoverNewVideos({
      channelId,
      probeRecentForLive: true,
      probeLimit: ADD_CHANNEL_LIVE_PROBE_LIMIT,
      classifyImmediately: false
    });
    await checkPendingVideos({ channelId, force: true });
    const latest = (await getChannels())[channelId];
    if (latest?.lastError) throw new Error(latest.lastError);
  }
  async function addTrackedChannel(info, source) {
    if (!info || !/^UC[0-9A-Za-z_-]{22}$/.test(info.id || "")) throw new Error("Channel ID kh\xF4ng h\u1EE3p l\u1EC7");
    const channels = await getChannels();
    channels[info.id] = {
      id: info.id,
      title: info.title || info.id,
      thumbnail: info.thumbnail || "",
      mode: "all",
      initialized: false,
      seenVideoIds: [],
      etag: "",
      lastModified: "",
      addedAt: Date.now(),
      source: source === "subscription" ? "subscription" : "manual",
      ...channels[info.id],
      watched: true,
      needsLiveProbe: true
    };
    await StorageAdapter.setLocal({ channels });
    await initChannelBaseline(info.id);
  }
  async function updateTrackedChannel(channelId, patch, remove = false) {
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
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
      try {
        switch (message.type) {
          case "resolveChannel": {
            const apiKey = await getApiKey();
            const oauthToken = apiKey ? "" : await OAuthManager.getCachedOAuthToken();
            const info = await resolveChannelInput(message.input, { apiKey, oauthToken: apiKey ? "" : oauthToken });
            sendResponse({ ok: true, channel: info });
            return;
          }
          case "initChannel":
            await runMonitorTask(() => initChannelBaseline(message.channelId));
            sendResponse({ ok: true });
            return;
          case "addChannel":
            await runMonitorTask(() => addTrackedChannel(message.channel, message.source));
            sendResponse({ ok: true });
            return;
          case "updateChannel":
            await runMonitorTask(() => updateTrackedChannel(message.channelId, message.patch || {}));
            sendResponse({ ok: true });
            return;
          case "removeChannel":
            await runMonitorTask(() => updateTrackedChannel(message.channelId, {}, true));
            sendResponse({ ok: true });
            return;
          case "checkNow":
            await runMonitorTask(async () => {
              await discoverNewVideos({ classifyImmediately: false, probeRecentForLive: true });
              await checkPendingVideos({ force: true });
            });
            sendResponse({ ok: true });
            return;
          case "refreshPending":
            await runMonitorTask(() => checkPendingVideos({ force: true }));
            sendResponse({ ok: true });
            return;
          case "updateIntervals":
            await StorageAdapter.setLocal({
              discoverSeconds: message.discoverSeconds,
              liveCheckSeconds: message.liveCheckSeconds
            });
            await ensureAlarms();
            await runMonitorTask(() => checkPendingVideos({ force: true }));
            sendResponse({ ok: true });
            return;
          case "fetchSubscriptions": {
            try {
              const { forceConsentNextOAuth } = await StorageAdapter.getLocal({ forceConsentNextOAuth: false });
              let token = "";
              if (forceConsentNextOAuth || message.forceConsent) {
                const authRes = await OAuthManager.getAuthToken(
                  true,
                  message.clientId,
                  "consent select_account"
                );
                token = await OAuthManager.saveOAuthSession(authRes, message.clientId);
                await StorageAdapter.removeLocal(["forceConsentNextOAuth"]);
              } else {
                token = await OAuthManager.getCachedOAuthToken({ clientId: message.clientId });
                if (message.forceInteractive || !token) {
                  const authRes = await OAuthManager.getAuthToken(true, message.clientId);
                  token = await OAuthManager.saveOAuthSession(authRes, message.clientId);
                }
              }
              const { subs, oauthUser } = await OAuthManager.loadOAuthAccountData(token);
              await setStatus({ lastError: "" });
              await runMonitorTask(() => checkPendingVideos({ force: true }));
              sendResponse({ ok: true, subs, oauthUser });
            } catch (err) {
              if (err && err.status === 401) {
                await StorageAdapter.removeLocal(["oauthToken", "oauthTokenExpires", "oauthUser", "fetchedSubs", "oauthDataFetchedAt"]);
              }
              sendResponse({ ok: false, error: err.message || String(err) });
            }
            return;
          }
          case "restoreOAuthSession": {
            try {
              const token = await OAuthManager.getCachedOAuthToken({ clientId: message.clientId });
              if (!token) {
                sendResponse({ ok: true, connected: false });
                return;
              }
              const { subs, oauthUser } = await OAuthManager.loadOAuthAccountData(token);
              await setStatus({ lastError: "" });
              await runMonitorTask(() => checkPendingVideos({ force: true }));
              sendResponse({ ok: true, connected: true, subs, oauthUser });
            } catch (err) {
              sendResponse({ ok: true, connected: false, error: err.message || String(err) });
            }
            return;
          }
          case "resetOAuthForConsent": {
            const cached = await StorageAdapter.getLocal({ oauthToken: "", oauthTokenExpires: 0 });
            let token = cached.oauthToken;
            if ((!token || Date.now() >= cached.oauthTokenExpires) && message.clientId) {
              token = await OAuthManager.getCachedOAuthToken({ clientId: message.clientId, forceRefresh: true });
            }
            const revokeResult = await OAuthManager.revokeOAuthGrant(token);
            await runMonitorTask(() => clearLocalOAuthState({ keepTrackedChannels: true }));
            await StorageAdapter.setLocal({ forceConsentNextOAuth: true });
            await setStatus({ lastError: "" });
            sendResponse({ ok: true, warning: revokeResult.warning || "" });
            return;
          }
          case "revokeOAuth": {
            const cached = await StorageAdapter.getLocal({ oauthToken: "", oauthTokenExpires: 0 });
            let token = cached.oauthToken;
            let revokeWarning = "";
            if ((!token || Date.now() >= cached.oauthTokenExpires) && message.clientId) {
              token = await OAuthManager.getCachedOAuthToken({ clientId: message.clientId, forceRefresh: true });
            }
            const revokeResult = await OAuthManager.revokeOAuthGrant(token);
            revokeWarning = revokeResult.warning || "";
            if (!token && !revokeWarning) {
              revokeWarning = "Kh\xF4ng c\xF3 access token c\xF2n hi\u1EC7u l\u1EF1c \u0111\u1EC3 thu h\u1ED3i t\u1EF1 \u0111\u1ED9ng. H\xE3y ki\u1EC3m tra Google Account > Third-party connections n\u1EBFu mu\u1ED1n x\xE1c nh\u1EADn quy\u1EC1n \u0111\xE3 b\u1ECB g\u1EE1.";
            }
            await runMonitorTask(async () => {
              await OAuthManager.clearLocalOAuthState({ keepTrackedChannels: false });
              const channels = await getChannels();
              const pending = await getPending();
              for (const [id, entry] of Object.entries(pending)) {
                if (!channels[entry.channelId]?.watched) delete pending[id];
              }
              await StorageAdapter.setLocal({ pending });
              await updateBadge();
            });
            await StorageAdapter.removeLocal(["forceConsentNextOAuth"]);
            sendResponse({ ok: true, warning: revokeWarning });
            return;
          }
          default:
            sendResponse({ ok: false, error: "Unknown message type: " + message.type });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
    })();
    return true;
  });
})();
