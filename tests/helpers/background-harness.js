import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import * as rss from "../../extension/lib/rss.js";
import * as decide from "../../extension/lib/decide.js";

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
    runtime: { onMessage: event("message"), onInstalled: event("installed"), onStartup: event("startup") },
    alarms: { onAlarm: event("alarm"), getAll(cb) { cb([]); }, create() {} },
    action: { setBadgeText({ text }) { state.badge = text; }, setBadgeBackgroundColor() {} },
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
      launchWebAuthFlow(options, cb) {
        state.authCalls.push(structuredClone(options));
        if (state.authFails) cb(undefined);
        else cb("https://test.chromiumapp.org/#access_token=mock-session-token&expires_in=3600");
      } },
  };
  const context = vm.createContext({ chrome, ...rss, ...decide, URL, URLSearchParams,
    console: { error: (...args) => state.logs.push(args), debug: (...args) => state.logs.push(args) },
    setTimeout: (fn) => { queueMicrotask(fn); },
    fetch: async (input, options = {}) => {
      const url = new URL(input);
      state.requests.push({ url: String(url), ...structuredClone(options) });
      if (state.beforeFetch) await state.beforeFetch(url, options);
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
      if (url.pathname.endsWith("/subscriptions")) return Response.json({ items: [] });
      if (url.pathname.endsWith("/channels")) return Response.json({ items: [] });
      throw new Error(`Unexpected request: ${url}`);
    } });
  const sourceFile = process.env.AUTO_MO_LIVE_TEST_ROOT
    ? path.join(process.env.AUTO_MO_LIVE_TEST_ROOT, "extension/background.js")
    : new URL("../../extension/background.js", import.meta.url);
  // Run the production worker with only ESM linkage replaced by its real pure modules.
  const source = fs.readFileSync(sourceFile, "utf8").replace(/^import [\s\S]*? from "[^"\n]+";\r?\n/gm, "")
    .replace(/^export /gm, "");
  function boot() { vm.runInContext(source, context, { filename: "background.js" }); }
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
