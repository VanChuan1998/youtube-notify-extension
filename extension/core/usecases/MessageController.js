import { StorageAdapter } from "../../adapters/StorageAdapter.js";
import { OAuthManager } from "./OAuthManager.js";
import { runMonitorTask, discoverNewVideos, checkPendingVideos, resolveChannelInput, initChannelBaseline, addTrackedChannel, updateTrackedChannel, ensureAlarms, getChannels, getPending, getApiKey, setStatus, updateBadge } from "./VideoUseCases.js";

export function setupMessages() {
  // ---------- Message từ popup ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Gói gọn các request có thể dùng chung cache/thao tác dài vào async block
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
            liveCheckSeconds: message.liveCheckSeconds,
          });
          await ensureAlarms();
          await runMonitorTask(() => checkPendingVideos({ force: true }));
          sendResponse({ ok: true });
          return;
        case "fetchSubscriptions": {
          try {
            const { forceConsentNextOAuth } = await StorageAdapter.getLocal({ forceConsentNextOAuth: false });
            let token = "";

            // Sau khi người dùng chọn “Đặt lại quyền Google”, bỏ qua silent restore
            // và buộc hiện lại cả account chooser + consent screen đúng một lần.
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

              // Khi người dùng chủ động bấm nút và silent restore không khả dụng,
              // mới mở OAuth UI. Không ép consent trong luồng sử dụng bình thường.
              if (message.forceInteractive || !token) {
                const authRes = await OAuthManager.getAuthToken(true, message.clientId);
                token = await OAuthManager.saveOAuthSession(authRes, message.clientId);
              }
            }

            if (!token) throw new Error("Chưa đăng nhập");
            const { subs, oauthUser } = await OAuthManager.loadOAuthAccountData(token);

            // OAuth vừa được xác nhận hợp lệ: xoá lỗi credential cũ và xử lý ngay
            // các video đang chờ, thay vì đợi alarm kế tiếp.
            await setStatus({ lastError: "" });
            await runMonitorTask(() => checkPendingVideos({ force: true }));

            sendResponse({ ok: true, subs, oauthUser });
          } catch (err) {
            if (err && err.status === 401) {
              await StorageAdapter.removeSession(["oauthToken", "oauthTokenExpires", "oauthUser", "fetchedSubs", "oauthDataFetchedAt"]);
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
          const cached = await StorageAdapter.getSession({ oauthToken: "", oauthTokenExpires: 0 });
          let token = cached.oauthToken;

          // Nếu token session đã hết nhưng grant còn tồn tại, thử lấy token mới âm thầm
          // chỉ để revoke. Không hiển thị UI ở bước reset.
          if ((!token || Date.now() >= cached.oauthTokenExpires) && message.clientId) {
            token = await OAuthManager.getCachedOAuthToken({ clientId: message.clientId, forceRefresh: true });
          }

          const revokeResult = await OAuthManager.revokeOAuthGrant(token);
          await runMonitorTask(() => OAuthManager.clearLocalOAuthState({ keepTrackedChannels: true }));

          // Đây là marker một lần, không chứa credential. Lần Connect tiếp theo sẽ
          // dùng prompt=consent select_account rồi tự xoá marker sau khi thành công.
          await StorageAdapter.setLocal({ forceConsentNextOAuth: true });
          await setStatus({ lastError: "" });

          sendResponse({ ok: true, warning: revokeResult.warning || "" });
          return;
        }
        case "revokeOAuth": {
          const cached = await StorageAdapter.getSession({ oauthToken: "", oauthTokenExpires: 0 });
          let token = cached.oauthToken;
          let revokeWarning = "";

          if ((!token || Date.now() >= cached.oauthTokenExpires) && message.clientId) {
            // Chỉ thử silent re-auth để lấy token phục vụ revoke; không bật UI chỉ
            // vì người dùng đang ngắt kết nối.
            token = await OAuthManager.getCachedOAuthToken({ clientId: message.clientId, forceRefresh: true });
          }

          const revokeResult = await OAuthManager.revokeOAuthGrant(token);
          revokeWarning = revokeResult.warning || "";
          if (!token && !revokeWarning) {
            revokeWarning = "Không có access token còn hiệu lực để thu hồi tự động. Hãy kiểm tra Google Account > Third-party connections nếu muốn xác nhận quyền đã bị gỡ.";
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
  return true; // giữ kênh message mở cho phản hồi bất đồng bộ
});
}
