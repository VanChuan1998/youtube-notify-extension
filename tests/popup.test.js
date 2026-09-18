import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import * as decide from "../extension/lib/decide.js";
import { harness, channelA as A, channel, video, apiVideo, pendingEntry } from "./helpers/background-harness.js";

class Element {
  constructor(tag = "div") { this.tagName = tag; this.children = []; this.events = {}; this.style = {}; this.value = ""; this.disabled = false; }
  set innerHTML(value) { this.children = []; this.html = value; }
  appendChild(el) { this.children.push(el); }
  addEventListener(name, fn) { this.events[name] = fn; }
  async fire(name) { return this.events[name]?.({ key: "Enter" }); }
}
async function popup(s) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const sent = [];
  s.chrome.storage.onChanged = { addListener() {} };
  s.chrome.runtime.sendMessage = (message, cb) => {
    sent.push(message);
    if (message.type === "resolveChannel") queueMicrotask(() => cb({ ok: true, channel: channel() }));
    else s.message(message).then(cb);
  };
  const context = vm.createContext({ chrome: s.chrome, document: { getElementById: get, createElement: tag => new Element(tag) },
    confirm: () => true, console, ...decide, setInterval: () => 0 });
  vm.runInContext(fs.readFileSync(new URL("../extension/popup.js", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, ""), context);
  await vm.runInContext("refresh()", context);
  await new Promise(resolve => setImmediate(resolve));
  return { get, sent, context };
}

test("manual popup click reaches background add/probe and blocks duplicate Enter", async () => {
  const v = video(1), s = harness({ feeds: { [A]: [v] }, items: { [v]: apiVideo(v) } });
  const p = await popup(s); p.get("channelInput").value = A;
  await Promise.all([p.get("addChannelBtn").fire("click"), p.get("channelInput").fire("keydown")]);
  assert.equal(p.sent.filter(m => m.type === "addChannel").length, 1);
  assert.equal(s.tabs.length, 1); assert.equal(s.notifications.length, 1);
  assert.equal(p.get("addChannelBtn").disabled, false);
});

test("subscription popup click reaches immediate probe", async () => {
  const v = video(1), s = harness({ session: { fetchedSubs: [channel()], oauthUser: { name: "Test" } },
    feeds: { [A]: [v] }, items: { [v]: apiVideo(v) } });
  const p = await popup(s);
  await p.get("subsList").children[0].children.at(-1).fire("click");
  assert.equal(s.local.channels[A].source, "subscription"); assert.equal(s.tabs.length, 1);
});

test("popup mode, disable and remove persist through background messages", async () => {
  const s = harness({ local: { channels: { [A]: channel() } } });
  const p = await popup(s), row = p.get("channelList").children[0];
  const mode = row.children[1].children.at(-1); mode.value = "all"; await mode.fire("change");
  assert.equal(s.local.channels[A].mode, "all");
  const toggle = row.children[2]; toggle.checked = false; await toggle.fire("change");
  assert.equal(s.local.channels[A].watched, false);
  await row.children[3].fire("click"); assert.equal(s.local.channels[A], undefined);
  assert.deepEqual(p.sent.filter(m => ["updateChannel", "removeChannel"].includes(m.type)).map(m => m.type),
    ["updateChannel", "updateChannel", "removeChannel"]);
});

test("pending card renders only upcoming, never live/ended/unknown", async () => {
  const pending = Object.fromEntries(["upcoming", "live", "ended", "unknown"].map((state, i) => [video(i), pendingEntry(video(i), A, { state })]));
  const items = { [video(0)]: apiVideo(video(0), "upcoming"), [video(1)]: apiVideo(video(1), "live") };
  const s = harness({ local: { channels: { [A]: channel() }, pending }, items });
  const p = await popup(s); assert.equal(p.get("pendingList").children.length, 1);
  assert.equal(p.get("pendingCard").style.display, "block");
});

test("opening popup with cached account rechecks and removes an ended waiting item", async () => {
  const v = "ZM6xYUYPgPY";
  const s = harness({ session: { oauthUser: { name: "Cached account" } }, local: { channels: { [A]: channel() },
    pending: { [v]: pendingEntry(v, A, { state: "upcoming", scheduledStartTime: new Date(Date.now() + 86400000).toISOString(), lastCheckedAt: Date.now() }) } },
    items: { [v]: apiVideo(v, "ended") } });
  const p = await popup(s); assert.equal(s.local.pending[v], undefined);
  assert.equal(p.get("pendingList").children.length, 0); assert.equal(p.get("unconfirmedList").children.length, 0);
  assert.ok(p.sent.some(m => m.type === "refreshPending")); assert.equal(s.apiRequests().length, 1);
});

test("offline-like upcoming with no schedule goes to unconfirmed section, not waiting", async () => {
  const v = "ZM6xYUYPgPY", item = apiVideo(v, "upcoming"); item.liveStreamingDetails = {};
  const s = harness({ local: { channels: { [A]: channel() }, pending: { [v]: pendingEntry(v, A, { state: "upcoming" }) } }, items: { [v]: item } });
  const p = await popup(s); assert.equal(p.get("pendingList").children.length, 0);
  assert.equal(p.get("unconfirmedList").children.length, 1);
  assert.equal(s.local.pending[v].state, "upcoming");
});

test("failed verification does not present cached upcoming as currently waiting", async () => {
  const v = video(1);
  const s = harness({ session: { oauthUser: { name: "Cached" } }, local: { channels: { [A]: channel() },
    pending: { [v]: pendingEntry(v, A, { state: "upcoming", scheduledStartTime: new Date(Date.now() + 86400000).toISOString(), lastVerifiedAt: Date.now() }) } } });
  s.apiStatus = 403;
  const p = await popup(s); assert.equal(p.get("pendingList").children.length, 0);
  assert.equal(p.get("unconfirmedList").children.length, 1); assert.ok(s.local.pending[v]);
});

test("late storage snapshot cannot resurrect a waiting row after cleanup", async () => {
  const s = harness(), p = await popup(s), v = video(1);
  const snapshot = { channels: { [A]: channel() }, pending: { [v]: pendingEntry(v, A, { state: "upcoming",
    scheduledStartTime: new Date(Date.now() + 86400000).toISOString(), lastVerifiedAt: Date.now() }) } };
  const originalGet = s.chrome.storage.local.get;
  let resume, held = false;
  s.chrome.storage.local.get = (keys, cb) => {
    if (!held && keys.pending) {
      held = true; return new Promise(resolve => { resume = () => { cb(snapshot); resolve(snapshot); }; });
    }
    return originalGet(keys, cb);
  };
  const slow = vm.runInContext("renderPending()", p.context);
  await vm.runInContext("renderPending()", p.context);
  resume(); await slow;
  assert.equal(p.get("pendingList").children.length, 0); assert.equal(p.get("pendingCard").style.display, "none");
});
