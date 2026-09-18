import test from "node:test";
import assert from "node:assert/strict";
import { classifyVideo, isWaitingForLive, shouldRecheck, UPCOMING_GRACE_MS, VERIFIED_STATE_TTL_MS } from "../extension/lib/decide.js";
import { harness, channelA as A, channel, video, apiVideo, pendingEntry } from "./helpers/background-harness.js";
const v = "ZM6xYUYPgPY";
const future = new Date(Date.now() + 86400000).toISOString();
const waiting = (extra = {}) => pendingEntry(v, A, { state: "upcoming", scheduledStartTime: future, lastCheckedAt: Date.now(), lastVerifiedAt: Date.now(), ...extra });

test("refreshPending forces ended check despite far-future cached schedule", async () => {
  const s = harness({ local: { channels: { [A]: channel(A, { lastCheckedVideoId: v }) }, pending: { [v]: waiting() } },
    items: { [v]: apiVideo(v, "ended", "Final API title") } });
  await s.message({ type: "refreshPending" });
  assert.equal(s.local.pending[v], undefined); assert.equal(s.local.channels[A].lastCheckedTitle, "Final API title");
  assert.equal(s.tabs.length, 0); assert.equal(s.apiRequests()[0].cache, "no-store");
});

test("later batch failure cannot retain ended items already confirmed in earlier batch", async () => {
  const ids = [v, ...Array.from({ length: 50 }, (_, i) => video(i))];
  const s = harness({ local: { channels: { [A]: channel(A, { lastCheckedVideoId: v }) },
    pending: Object.fromEntries(ids.map(id => [id, pendingEntry(id, A, { state: "upcoming" })])) },
    items: Object.fromEntries(ids.map(id => [id, apiVideo(id, "ended", "Final API title")])) });
  s.beforeFetch = async url => {
    if (url.pathname.endsWith("/videos")) s.apiStatus = url.searchParams.get("id").includes(v) ? 200 : 503;
  };
  await s.alarm();
  assert.equal(s.local.pending[v], undefined); assert.equal(Object.keys(s.local.pending).length, 1);
  assert.equal(s.local.channels[A].lastCheckedTitle, "Final API title");
  assert.ok(s.local.pending[ids[50]].verificationError); assert.ok(s.local.status.lastError);
});

test("known end evidence is cleaned without credential or network", async () => {
  for (const extra of [{ actualEndTime: "2026-09-14T01:00:00Z" }, { state: "ended" }]) {
    const s = harness({ local: { apiKey: "", channels: { [A]: channel() }, pending: { [v]: waiting(extra) } } });
    await s.message({ type: "refreshPending" });
    assert.equal(s.local.pending[v], undefined); assert.equal(s.requests.length, 0); assert.equal(s.badge, "");
  }
});

test("prior live cannot regress to waiting when API returns upcoming", async () => {
  const s = harness({ local: { channels: { [A]: channel() }, pending: { [v]: waiting({ state: "live", liveHandledAt: 1 }) } }, items: { [v]: apiVideo(v, "upcoming") } });
  await s.alarm(); assert.equal(s.local.pending[v].state, "unknown"); assert.equal(s.badge, "");
  assert.equal(s.tabs.length, 0); assert.equal(s.notifications.length, 0);
  s.items[v] = apiVideo(v, "ended"); await s.alarm(); assert.equal(s.local.pending[v], undefined);
});

test("actualStartTime plus contradictory upcoming is uncertain, not waiting or assumed ended", () => {
  const item = apiVideo(v, "upcoming"); item.liveStreamingDetails.actualStartTime = "2026-09-14T00:00:00Z";
  assert.equal(classifyVideo(item), "unknown");
  item.liveStreamingDetails.actualEndTime = "2026-09-14T01:00:00Z";
  assert.equal(classifyVideo(item), "ended");
});

test("missing schedule or overdue upcoming is not displayed as a valid waiting event", () => {
  assert.equal(isWaitingForLive(waiting()), true);
  for (const scheduledStartTime of ["", "invalid", new Date(Date.now() - UPCOMING_GRACE_MS - 1000).toISOString()]) {
    assert.equal(isWaitingForLive(waiting({ scheduledStartTime })), false);
  }
  assert.equal(isWaitingForLive(waiting({ scheduledStartTime: new Date(Date.now() - 300000).toISOString() })), true);
});

test("old, failed, started or ended evidence never counts as waiting", () => {
  for (const extra of [{ lastVerifiedAt: 0 }, { lastVerifiedAt: Date.now() - VERIFIED_STATE_TTL_MS - 1 },
    { verificationError: "offline" }, { liveHandledAt: 1 }, { actualStartTime: "2026-09-14T00:00:00Z" },
    { actualEndTime: "2026-09-14T01:00:00Z" }]) assert.equal(isWaitingForLive(waiting(extra)), false);
});

test("unconfirmed upcoming remains monitored and can later open as confirmed live", async () => {
  const offlineLike = apiVideo(v, "upcoming"); offlineLike.liveStreamingDetails = {};
  // Model the offline/waiting ambiguity; this is not a captured videos.list response.
  const s = harness({ local: { channels: { [A]: channel() }, pending: { [v]: waiting() } }, items: { [v]: offlineLike } });
  await s.message({ type: "refreshPending" }); assert.ok(s.local.pending[v]);
  assert.equal(isWaitingForLive(s.local.pending[v]), false); assert.equal(s.badge, "");
  s.items[v] = apiVideo(v, "live"); await s.alarm(); await s.alarm();
  assert.equal(s.tabs.length, 1); assert.equal(s.notifications.length, 1);
});

test("recheck retries uncertain/failed/prior-live records despite a future schedule", () => {
  for (const extra of [{ state: "unknown" }, { verificationError: "temporary error" }, { state: "live" }])
    assert.equal(shouldRecheck(waiting(extra), Date.now()), true);
});

test("confirmed end survives restart and stale RSS/API cannot reinsert that video", async () => {
  const s = harness({ local: { channels: { [A]: channel(A, { initialized: true, seenVideoIds: [v], lastCheckedVideoId: v }) },
    pending: { [v]: waiting() } }, feeds: { [A]: [v] }, items: { [v]: apiVideo(v, "ended", "Final title") } });
  await s.message({ type: "refreshPending" });
  assert.deepEqual(s.local.channels[A].endedVideoIds, [v]);
  const next = s.restartWorker(); next.items[v] = apiVideo(v, "upcoming", "Stale title");
  await next.startup(); await next.message({ type: "checkNow" });
  assert.equal(next.local.pending[v], undefined); assert.equal(next.apiRequests().length, 0);
  assert.equal(next.local.channels[A].lastCheckedTitle, "Final title"); assert.equal(next.badge, "");
});

test("older ended ID is remembered without overwriting newer title", async () => {
  const s = harness({ local: { channels: { [A]: channel(A, { lastCheckedVideoId: video(1), lastCheckedTitle: "Newer title" }) },
    pending: { [v]: waiting() } }, items: { [v]: apiVideo(v, "ended", "Old final title") } });
  await s.message({ type: "refreshPending" });
  assert.deepEqual(s.local.channels[A].endedVideoIds, [v]); assert.equal(s.local.channels[A].lastCheckedTitle, "Newer title");
});
