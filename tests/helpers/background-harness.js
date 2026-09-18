import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import esbuild from "esbuild";
import * as rss from "../../extension/lib/rss.js";
import * as decide from "../../extension/core/domain/Rules.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bundle the extension background script to memory so `vm` can execute ES imports as a flat string.
const backgroundFile = process.env.AUTO_MO_LIVE_TEST_ROOT
  ? path.join(process.env.AUTO_MO_LIVE_TEST_ROOT, "extension/background.js")
  : path.join(__dirname, "../../extension/background.js");
const buildResult = esbuild.buildSync({
  entryPoints: [backgroundFile],
  bundle: true,
  write: false,
  format: "iife", // IIFE format works perfectly in vm.runInContext
});
const code = buildResult.outputFiles[0].text;

export const channelA = "UCaaaaaaaaaaaaaaaaaaaaaa";
export const channelB = "UCbbbbbbbbbbbbbbbbbbbbbb";
export const video = (n) => `video${String(n).padStart(6, "0")}`;
export const channel = (id = channelA, extra = {}) => ({ id, title: id,
  watched: true, mode: "liveOnly", initialized: false, seenVideoIds: [], ...extra });
export const pendingEntry = (id, channelId = channelA, extra = {}) => ({
  videoId: id, channelId, title: id, state: "unknown", firstSeenAt: Date.now(),
  lastCheckedAt: 0, ...extra,
});
export function apiVideo(id, state = "live", title = `API ${id}`) {
  return { id, snippet: { title, liveBroadcastContent:
    state === "ended" || state === "none" ? "none" : state },
    liveStreamingDetails: state === "none" ? {} : state === "upcoming"
      ? { scheduledStartTime: new Date(Date.now() + 86400000).toISOString() }
      : { actualStartTime: "2026-09-14T00:00:00Z", ...(state === "ended"
        ? { actualEndTime: "2026-09-14T01:00:00Z" } : {}) } };
}
function feed(ids, channelId) {
  return `<feed><title>Channel</title><link href="https://www.youtube.com/channel/${channelId}"/>${ids.map(id =>
    `<entry><yt:videoId>${id}</yt:videoId><yt:channelId>${channelId}</yt:channelId><title>RSS ${id}</title></entry>`).join("")}</feed>`;
}
export function harness({ local = {}, session = {}, feeds = {}, items = {} } = {}) {
  const state = { local: structuredClone({ apiKey: "test-key", channels: {}, pending: {}, ...local }),
    session: structuredClone(session), feeds, items, requests: [], tabs: [], notifications: [],
    authCalls: [], logs: [], failTabs: 0, failNotifications: 0, apiStatus: 200, rssStatus: 200,
    authFails: false, revokeStatus: 200, badge: "" };
  const events = {};
  const event = (name) => ({ addListener(fn) { events[name] = fn; } });
  function area(name) {
    return {
      get(keys, cb) {
        const data = state[name];
        const result = keys == null ? data : typeof keys === "string" ? { [keys]: data[keys] }
          : Array.isArray(keys) ? Object.fromEntries(keys.filter(k => k in data).map(k => [k, data[k]]))
          : { ...keys, ...Object.fromEntries(Object.keys(keys).filter(k => k in data).map(k => [k, data[k]])) };
        const copy = structuredClone(result);
        return Promise.resolve().then(() => { cb?.(copy); return copy; });
      },
      set(data, cb) { const copy = structuredClone(data); return Promise.resolve().then(() => {
        Object.assign(state[name], copy); cb?.();
      }); },
      remove(keys, cb) { return Promise.resolve().then(() => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete state[name][key]; cb?.();
      }); },
    };
  }
  const chrome = {
    storage: { local: area("local"), session: area("session") },
    runtime: { onMessage: event("message"), onInstalled: event("installed"), onStartup: event("startup"), getManifest: () => ({}) },
    alarms: { onAlarm: event("alarm"), getAll(cb) { cb([]); }, create() {} },
    action: { setBadgeText({ text }) { state.badge = text; }, setBadgeBackgroundColor() {} },
    setBadgeBackgroundColor() {},
    tabs: { async create(options) {
      await Promise.resolve();
      if (state.failTabs-- > 0) throw new Error("tab temporarily unavailable");
      state.tabs.push(structuredClone(options)); return { id: state.tabs.length };
    } },
    notifications: { onClicked: event("notification"), async create(id, options) {
      if (state.failNotifications-- > 0) throw new Error("notification temporarily unavailable");
      state.notifications.push({ id, ...structuredClone(options) }); return id;
    }, clear() {} },
    identity: { getRedirectURL() { return "https://test.chromiumapp.org/"; },
      getAuthToken(options, cb) {
        state.authCalls.push({ url: "chrome.identity.getAuthToken", interactive: options.interactive });
        if (state.authFails) cb(undefined);
        else cb("mock-session-token");
      },
      launchWebAuthFlow(options, cb) {
        state.authCalls.push(structuredClone(options));
        if (state.authFails) cb(undefined);
        else cb("https://test.chromiumapp.org/?code=mock-auth-code");
      } },
  };
  const context = vm.createContext({ chrome, ...rss, ...decide, URL, URLSearchParams,
    crypto: globalThis.crypto, btoa: globalThis.btoa, atob: globalThis.atob, TextEncoder,
    console: { error: (...args) => state.logs.push(args), debug: (...args) => state.logs.push(args) },
    setTimeout: (fn) => { queueMicrotask(fn); },
    fetch: async (input, options = {}) => {
      const url = new URL(input);
      const bodyStr = options.body != null ? String(options.body) : undefined;
      state.requests.push({ url: String(url), ...structuredClone({ ...options, body: undefined }), body: bodyStr });
      if (state.beforeFetch) await state.beforeFetch(url, options);
      if (url.pathname === "/oauth/exchange" || url.pathname === "/oauth/refresh") {
        const json = { access_token: "mock-session-token", expires_in: 3600 };
        if (url.pathname === "/oauth/exchange") json.refresh_token = "mock-refresh-token";
        return Response.json(json);
      }
      if (url.pathname === "/revoke") return new Response("", { status: state.revokeStatus });
      if (url.pathname === "/feeds/videos.xml") {
        if (state.rssStatus !== 200) return new Response(null, { status: state.rssStatus });
        const id = url.searchParams.get("channel_id");
        return new Response(feed(state.feeds[id] || [], id), { headers: { etag: "test-etag" } });
      }
      if (url.pathname.endsWith("/videos")) {
        if (state.apiStatus !== 200) return new Response(JSON.stringify({ error: { message: "test API failure" } }), { status: state.apiStatus });
        return Response.json({ items: url.searchParams.get("id").split(",").map(id => state.items[id]).filter(Boolean) });
      }
      if (url.pathname.endsWith("/playlistItems")) {
        if (state.apiStatus !== 200) return new Response(JSON.stringify({ error: { message: "test API failure" } }), { status: state.apiStatus });
        const items = Object.values(state.items).map(item => ({
          snippet: { resourceId: { videoId: item.id }, channelId: "UCtest", title: item.snippet.title, channelTitle: "Test", publishedAt: "2026-09-14T00:00:00Z", thumbnails: {} }
        }));
        return Response.json({ items });
      }
      if (url.pathname.endsWith("/subscriptions")) return Response.json({ items: [] });
      if (url.pathname.endsWith("/channels")) return Response.json({ items: [] });
      throw new Error(`Unexpected request: ${url}`);
    } });
  const sourceFile = process.env.AUTO_MO_LIVE_TEST_ROOT
    ? path.join(process.env.AUTO_MO_LIVE_TEST_ROOT, "extension/background.js")
    : new URL("../../extension/background.js", import.meta.url);
  function boot() { vm.runInContext(code, context, { filename: "background.js" }); }
  boot();
  state.message = (message) => new Promise(resolve => events.message(message, {}, resolve));
  state.chrome = chrome;
  state.alarm = (name = "ytnotify_livecheck") => events.alarm({ name });
  state.startup = () => events.startup();
  state.installed = () => events.installed();
  state.apiRequests = () => state.requests.filter(r => new URL(r.url).pathname.endsWith("/videos"));
  state.restartWorker = () => harness({ local: state.local, session: state.session, feeds: state.feeds, items: state.items });
  return state;
}
