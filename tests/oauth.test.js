import test from "node:test";
import assert from "node:assert/strict";
import { harness, channelA as A, channelB as B, channel, video, pendingEntry, apiVideo } from "./helpers/background-harness.js";
const v = video(1);
const clientId = "test-client.apps.googleusercontent.com";
const oauthLocal = { apiKey: "", googleOAuthAuthorized: true, googleOAuthClientId: clientId,
  channels: { [A]: channel() }, pending: { [v]: pendingEntry(v) } };

test("expired OAuth silently restores; access token remains exclusively in session", async () => {
  const s = harness({ local: oauthLocal, session: { oauthToken: "expired", oauthTokenExpires: 1 }, items: { [v]: apiVideo(v) } });
  await s.alarm(); assert.equal(s.tabs.length, 1); assert.equal(s.authCalls.length, 1);
  assert.equal(s.authCalls[0].interactive, false);
  assert.equal(new URL(s.authCalls[0].url).searchParams.get("prompt"), "none");
  assert.equal(s.session.oauthToken, "mock-session-token"); assert.equal(s.local.oauthToken, undefined);
  assert.equal(s.local.googleOAuthAuthorized, true); assert.equal(s.local.googleOAuthClientId, clientId);
});

test("API key avoids unnecessary OAuth restoration during immediate probe", async () => {
  const s = harness({ local: { ...oauthLocal, apiKey: "test-key" }, feeds: { [A]: [v] }, items: { [v]: apiVideo(v) } });
  s.authFails = true; await s.message({ type: "initChannel", channelId: A });
  assert.equal(s.authCalls.length, 0); assert.equal(s.tabs.length, 1);
});

test("401 retries once using silently renewed token", async () => {
  const s = harness({ local: oauthLocal, session: { oauthToken: "stale", oauthTokenExpires: Date.now() + 3600000 }, items: { [v]: apiVideo(v) } });
  s.beforeFetch = async (url, options) => {
    if (url.pathname.endsWith("/videos")) s.apiStatus = options.headers?.Authorization === "Bearer stale" ? 401 : 200;
  };
  await s.alarm(); assert.equal(s.apiRequests().length, 2); assert.equal(s.authCalls.length, 1); assert.equal(s.tabs.length, 1);
});

test("failed silent OAuth keeps watched channels and pending, clears disconnected session UI", async () => {
  const s = harness({ local: oauthLocal, session: { oauthUser: { name: "old" }, fetchedSubs: [1] } });
  s.authFails = true; await s.alarm(); assert.ok(s.local.channels[A]); assert.ok(s.local.pending[v]);
  assert.equal(s.session.oauthUser, undefined); assert.equal(s.session.fetchedSubs, undefined);
  assert.equal(s.tabs.length, 0); assert.ok(s.local.status.lastError);
});

test("reset preserves tracked channels and forces consent once; next connect uses cached token", async () => {
  const s = harness({ local: { apiKey: "", channels: { [A]: channel() }, googleOAuthAuthorized: true, googleOAuthClientId: clientId },
    session: { oauthToken: "old-token", oauthTokenExpires: Date.now() + 3600000, oauthUser: { name: "old" }, fetchedSubs: [1] } });
  const reset = await s.message({ type: "resetOAuthForConsent", clientId });
  assert.equal(reset.ok, true); assert.ok(s.local.channels[A]);
  assert.equal(s.session.oauthToken, undefined); assert.equal(s.local.googleOAuthAuthorized, undefined);
  assert.equal(s.local.forceConsentNextOAuth, true);
  assert.equal((await s.message({ type: "fetchSubscriptions", clientId })).ok, true);
  assert.equal(new URL(s.authCalls[0].url).searchParams.get("prompt"), "consent select_account");
  assert.equal(s.authCalls[0].interactive, true); assert.equal(s.local.forceConsentNextOAuth, undefined);
  await s.message({ type: "fetchSubscriptions", clientId }); assert.equal(s.authCalls.length, 1);
});

test("revoke failure still clears credentials; disconnect removes subscription pending only", async () => {
  const s = harness({ local: { ...oauthLocal, channels: { [A]: channel(A, { source: "subscription" }), [B]: channel(B, { source: "manual" }) },
    pending: { [v]: pendingEntry(v), other: pendingEntry("other", B) } }, session: { oauthToken: "old-token", oauthTokenExpires: Date.now() + 3600000 } });
  s.revokeStatus = 503;
  const result = await s.message({ type: "revokeOAuth", clientId });
  assert.equal(result.ok, true); assert.match(result.warning, /503/);
  assert.equal(s.session.oauthToken, undefined); assert.equal(s.local.googleOAuthAuthorized, undefined);
  assert.equal(s.local.channels[A], undefined); assert.ok(s.local.channels[B]);
  assert.equal(s.local.pending[v], undefined); assert.ok(s.local.pending.other);
});

test("startup clears legacy persistent OAuth secrets and restores existing grant", async () => {
  const s = harness({ local: { ...oauthLocal, oauthToken: "legacy", oauthTokenExpires: 9999999999999, fetchedSubs: [1], oauthUser: { name: "legacy" } },
    feeds: { [A]: [v] }, items: { [v]: apiVideo(v) } });
  await s.startup(); assert.equal(s.local.oauthToken, undefined);
  // oauthUser bền qua restart — startup tự silent-restore và lưu lại vào local (Fix 2/3).
  // clearLegacyOAuthStorage chỉ xoá đúng 2 key legacy (Fix 5); leftover fetchedSubs vô hại, không bị đụng.
  assert.equal(s.local.oauthUser, null); assert.deepEqual(s.local.fetchedSubs, [1]);
  assert.equal(s.session.oauthToken, "mock-session-token"); assert.equal(s.tabs.length, 1);
});
