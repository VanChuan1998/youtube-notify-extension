import test from "node:test";
import assert from "node:assert/strict";
import { harness, channelA as A, channelB as B, channel, video, pendingEntry, apiVideo } from "./helpers/background-harness.js";
const v = video(1);
const make = (extra = {}) => harness({ local: { channels: { [A]: channel() } },
  feeds: { [A]: [v] }, items: { [v]: apiVideo(v) }, ...extra });

test("initChannel immediately classifies baseline live and delivers without alarm", async () => {
  const s = make();
  assert.equal((await s.message({ type: "initChannel", channelId: A })).ok, true);
  assert.equal(s.tabs.length, 1); assert.equal(s.notifications.length, 1);
  assert.equal(s.local.pending[v].state, "live");
  assert.equal(s.session.liveOpenedThisSession[v] > 0, true);
});

test("already seen initialized channel is reprobed without conditional RSS headers", async () => {
  const s = make({ local: { channels: { [A]: channel(A, { initialized: true, seenVideoIds: [v], etag: "old", lastModified: "old" }) } } });
  await s.message({ type: "initChannel", channelId: A });
  assert.equal(s.tabs.length, 1);
  assert.deepEqual(s.requests[0].headers, {}); assert.equal(s.requests[0].cache, "no-store");
});

for (const source of ["manual", "subscription"]) test(`addChannel ${source} probes immediately`, async () => {
  const s = make({ local: { channels: {} } });
  assert.equal((await s.message({ type: "addChannel", channel: channel(), source })).ok, true);
  assert.equal(s.tabs.length, 1); assert.equal(s.notifications.length, 1);
  assert.equal(s.local.channels[A].source, source);
});

test("add probe reaches RSS item 15 and only calls API for this channel", async () => {
  const ids = Array.from({ length: 15 }, (_, i) => video(i + 1));
  const s = harness({ local: { channels: { [A]: channel(), [B]: channel(B) }, pending: { other: pendingEntry("other", B) } },
    feeds: { [A]: ids }, items: Object.fromEntries(ids.map((id, i) => [id, apiVideo(id, i === 14 ? "live" : "none")])) });
  await s.message({ type: "initChannel", channelId: A });
  assert.equal(s.tabs.length, 1); assert.ok(s.tabs[0].url.endsWith(ids[14]));
  assert.equal(s.apiRequests().length, 1);
  assert.equal(new URL(s.apiRequests()[0].url).searchParams.get("id").split(",").length, 15);
  assert.ok(s.local.pending.other); assert.equal(s.notifications.length, 1);
});

test("probe forces existing far-future pending classification even outside RSS", async () => {
  const s = make({ local: { channels: { [A]: channel() }, pending: { [v]: pendingEntry(v, A, {
    state: "upcoming", lastCheckedAt: Date.now(), scheduledStartTime: new Date(Date.now() + 86400000).toISOString() }) } }, feeds: { [A]: [] } });
  await s.message({ type: "initChannel", channelId: A }); assert.equal(s.tabs.length, 1);
});

for (const mode of ["all", "liveOnly"]) for (const state of ["none", "ended", "upcoming"]) {
  test(`add probe ${mode}/${state}: no historical delivery; upcoming remains pending`, async () => {
    const s = make({ local: { channels: { [A]: channel(A, { mode }) } }, items: { [v]: apiVideo(v, state) } });
    await s.message({ type: "initChannel", channelId: A });
    assert.equal(s.tabs.length, 0); assert.equal(s.notifications.length, 0);
    assert.equal(!!s.local.pending[v], state === "upcoming");
    if (state === "upcoming") assert.equal(s.badge, "1");
    else assert.equal(s.local.channels[A].lastCheckedTitle, `API ${v}`);
  });
}

test("upcoming -> live -> ended updates title and clears pending without repeat", async () => {
  const s = make({ items: { [v]: apiVideo(v, "upcoming") } });
  await s.message({ type: "initChannel", channelId: A });
  s.items[v] = apiVideo(v, "live");
  await s.message({ type: "checkNow" });
  assert.equal(s.tabs.length, 1); assert.equal(s.badge, "");
  s.items[v] = apiVideo(v, "ended", "Final title");
  await s.alarm();
  assert.equal(s.tabs.length, 1); assert.equal(s.notifications.length, 1);
  assert.equal(s.local.pending[v], undefined); assert.equal(s.local.channels[A].lastCheckedTitle, "Final title");
});

test("ending older live never overwrites newer video's title", async () => {
  const s = make({ local: { channels: { [A]: channel(A, { lastCheckedVideoId: video(2), lastCheckedTitle: "Newer" }) },
    pending: { [v]: pendingEntry(v, A, { state: "live", liveHandledAt: 1 }) } }, items: { [v]: apiVideo(v, "ended") } });
  await s.alarm(); assert.equal(s.local.channels[A].lastCheckedTitle, "Newer"); assert.equal(s.tabs.length, 0);
});

test("startup reopens live once in new session, not after worker restart", async () => {
  const s = make({ local: { channels: { [A]: channel(A, { initialized: true, seenVideoIds: [v] }) } } });
  await s.startup(); assert.equal(s.tabs.length, 1);
  const worker = s.restartWorker(); await worker.message({ type: "checkNow" });
  assert.equal(worker.tabs.length, 0); assert.equal(worker.notifications.length, 0);
  const browser = harness({ local: worker.local, feeds: worker.feeds, items: worker.items });
  await browser.startup(); assert.equal(browser.tabs.length, 1); assert.equal(browser.notifications.length, 1);
});

test("overlapping init, startup, alarms and manual checks deliver live once", async () => {
  const s = make();
  await Promise.all([s.message({ type: "initChannel", channelId: A }), s.startup(), s.alarm(),
    s.alarm("ytnotify_discover"), s.message({ type: "checkNow" })]);
  assert.equal(s.tabs.length, 1); assert.equal(s.notifications.length, 1);
});

test("simultaneous channel additions preserve both channels and pending records", async () => {
  const other = video(2);
  const s = harness({ feeds: { [A]: [v], [B]: [other] }, items: { [v]: apiVideo(v), [other]: apiVideo(other) } });
  await Promise.all([s.message({ type: "addChannel", channel: channel(A) }), s.message({ type: "addChannel", channel: channel(B) })]);
  assert.equal(Object.keys(s.local.channels).length, 2); assert.equal(Object.keys(s.local.pending).length, 2);
  assert.equal(s.tabs.length, 2);
});

test("re-add preserves mode and does not reopen after delete or worker restart", async () => {
  const s = make(); await s.message({ type: "initChannel", channelId: A });
  await s.message({ type: "addChannel", channel: channel() });
  assert.equal(s.local.channels[A].mode, "liveOnly"); assert.equal(s.tabs.length, 1);
  await s.message({ type: "removeChannel", channelId: A });
  assert.equal(s.local.pending[v], undefined);
  const worker = s.restartWorker(); await worker.message({ type: "addChannel", channel: channel() });
  assert.equal(worker.tabs.length, 0); assert.equal(worker.notifications.length, 0);
});

test("disabled/deleted channels never deliver orphan pending; enabling probes immediately", async () => {
  const s = make({ local: { channels: { [A]: channel(A, { watched: false }) }, pending: { [v]: pendingEntry(v), other: pendingEntry("other", B) } } });
  await s.alarm(); assert.equal(s.apiRequests().length, 0); assert.equal(Object.keys(s.local.pending).length, 0);
  await s.message({ type: "updateChannel", channelId: A, patch: { watched: true } }); assert.equal(s.tabs.length, 1);
  await s.message({ type: "updateChannel", channelId: A, patch: { watched: false } });
  assert.equal(s.local.pending[v], undefined);
});

test("tab failure retries tab without repeating successful notification", async () => {
  const s = make(); s.failTabs = 1;
  await s.message({ type: "initChannel", channelId: A });
  assert.equal(s.session.liveOpenedThisSession?.[v], undefined); assert.equal(s.notifications.length, 1);
  assert.match(s.local.status.lastError, /tab/);
  await s.alarm(); assert.equal(s.tabs.length, 1); assert.equal(s.notifications.length, 1);
});

test("notification failure retries notification without repeating successful tab", async () => {
  const s = make(); s.failNotifications = 1;
  await s.message({ type: "initChannel", channelId: A }); await s.alarm();
  assert.equal(s.tabs.length, 1); assert.equal(s.notifications.length, 1);
});

test("three-tab cap defers remaining live tabs instead of marking them opened", async () => {
  const ids = [1, 2, 3, 4].map(video);
  const s = make({ feeds: { [A]: ids }, items: Object.fromEntries(ids.map(id => [id, apiVideo(id)])) });
  await s.message({ type: "initChannel", channelId: A });
  assert.equal(s.tabs.length, 3); assert.equal(s.notifications.length, 4);
  assert.equal(s.session.liveOpenedThisSession[ids[3]], undefined);
  await s.alarm(); assert.equal(s.tabs.length, 4); assert.equal(s.notifications.length, 4);
});

test("RSS error persists probe intent and next discovery recovers", async () => {
  const s = make(); s.rssStatus = 503;
  assert.equal((await s.message({ type: "initChannel", channelId: A })).ok, false);
  assert.equal(s.local.channels[A].needsLiveProbe, true);
  s.rssStatus = 200; await s.alarm("ytnotify_discover");
  assert.equal(s.tabs.length, 1); assert.equal(s.local.channels[A].needsLiveProbe, undefined);
});

test("API quota error and missing credentials retain pending for later confirmation", async () => {
  for (const missingCredential of [false, true]) {
    const s = make(); if (missingCredential) s.local.apiKey = ""; else s.apiStatus = 403;
    await s.message({ type: "initChannel", channelId: A });
    assert.ok(s.local.pending[v]); assert.equal(s.tabs.length, 0); assert.ok(s.local.status.lastError);
    s.apiStatus = 200; s.local.apiKey = "test-key"; await s.alarm(); assert.equal(s.tabs.length, 1);
  }
});

test("private/deleted API item is removed without delivery", async () => {
  const s = make({ items: {} }); await s.message({ type: "initChannel", channelId: A });
  assert.equal(s.local.pending[v], undefined); assert.equal(s.tabs.length, 0);
});

test("new normal upload still opens in all mode, not in liveOnly", async () => {
  for (const mode of ["all", "liveOnly"]) {
    const s = make({ local: { channels: { [A]: channel(A, { mode, initialized: true, seenVideoIds: [video(2)] }) } }, items: { [v]: apiVideo(v, "none") } });
    await s.alarm("ytnotify_discover"); assert.equal(s.tabs.length, mode === "all" ? 1 : 0);
    assert.equal(s.notifications.length, 1);
  }
});

test("saving a valid API key immediately processes earlier unclassified add probe", async () => {
  const s = make(); s.local.apiKey = "";
  await s.message({ type: "initChannel", channelId: A }); assert.equal(s.tabs.length, 0);
  s.local.apiKey = "test-key";
  await s.message({ type: "updateIntervals", discoverSeconds: 60, liveCheckSeconds: 30 });
  assert.equal(s.tabs.length, 1);
});

test("session deduplication retains earlier IDs beyond 100 livestreams", async () => {
  const earlier = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [video(i + 2), i + 1]));
  const s = make({ session: { liveOpenedThisSession: earlier, liveNotifiedThisSession: earlier } });
  await s.message({ type: "initChannel", channelId: A });
  assert.equal(Object.keys(s.session.liveOpenedThisSession).length, 102);
  assert.equal(s.session.liveOpenedThisSession[video(2)], 1);
});

test("API classification batches at most 50 IDs and keeps all live records", async () => {
  const ids = Array.from({ length: 51 }, (_, i) => video(i + 1));
  const s = make({ local: { channels: { [A]: channel() }, pending: Object.fromEntries(ids.map(id => [id, pendingEntry(id)])) },
    items: Object.fromEntries(ids.map(id => [id, apiVideo(id)])) });
  await s.alarm();
  assert.deepEqual(s.apiRequests().map(r => new URL(r.url).searchParams.get("id").split(",").length), [50, 1]);
  assert.equal(Object.keys(s.local.pending).length, 51); assert.equal(s.notifications.length, 51);
  assert.equal(s.tabs.length, 3);
});
