import { AuthAdapter } from "../../adapters/AuthAdapter.js";
import { StorageAdapter } from "../../adapters/StorageAdapter.js";

export const OAuthManager = {
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
        console.debug("Native getAuthToken ngầm thất bại:", err?.message || String(err));
      }
    }

    if (!forceRefresh) {
      const { oauthToken, oauthTokenExpires } = await StorageAdapter.getSession({ oauthToken: "", oauthTokenExpires: 0 });
      if (oauthToken && oauthTokenExpires && Date.now() < oauthTokenExpires) {
        if (clientId) await this.rememberOAuthAuthorization(clientId);
        return oauthToken;
      }
    }

    await StorageAdapter.removeSession(["oauthToken", "oauthTokenExpires"]);
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
    if (!token) throw new Error("Không lấy được access_token từ URL trả về");
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
    await StorageAdapter.setSession({
      oauthToken: token,
      oauthTokenExpires: Date.now() + (expiresIn * 1000) - 60000,
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

  async restoreOAuthOnStartup() {
    const { googleOAuthAuthorized } = await StorageAdapter.getLocal({ googleOAuthAuthorized: false });
    if (!googleOAuthAuthorized) return "";
    const token = await this.getCachedOAuthToken();
    if (token) {
      try {
        await this.loadOAuthAccountData(token);
      } catch (err) {
        console.debug("Không tải được dữ liệu tài khoản khi khởi động:", err?.message || String(err));
      }
    }
    return token;
  },

  async revokeOAuthGrant(token) {
    if (!token) return { success: false, warning: "Không có token" };
    try {
      const manifest = chrome.runtime.getManifest();
      if (manifest.oauth2) {
        await AuthAdapter.removeCachedAuthToken(token).catch(() => {});
      }
      const response = await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });
      if (!response.ok) return { success: false, warning: `Lỗi thu hồi token: ${response.status}` };
      return { success: true };
    } catch (err) {
      return { success: false, warning: `Lỗi khi thu hồi: ${err.message}` };
    }
  },

  async clearLocalOAuthState({ keepTrackedChannels = true } = {}) {
    await StorageAdapter.removeLocal(["googleOAuthAuthorized"]);
    await StorageAdapter.removeSession(["oauthToken", "oauthTokenExpires", "oauthUser", "fetchedSubs", "oauthDataFetchedAt"]);
    if (!keepTrackedChannels) {
      const { channels } = await StorageAdapter.getLocal({ channels: {} });
      const chs = channels || {};
      for (const [id, ch] of Object.entries(chs)) {
        if (ch && ch.source === "subscription") delete chs[id];
      }
      await StorageAdapter.setLocal({ channels: chs });
    }
  },
  
  async loadOAuthAccountData(token) {
    // This could also be a usecase or placed in YouTubeAdapter
    const [channelRes, subsRes] = await Promise.all([
      fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch("https://www.googleapis.com/youtube/v3/subscriptions?part=snippet&mine=true&maxResults=50", { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
    ]);
    if (channelRes.error) throw new Error(channelRes.error.message || "Failed to fetch channel");
    if (subsRes.error) throw new Error(subsRes.error.message || "Failed to fetch subscriptions");
    
    let oauthUser = null;
    if (channelRes.items && channelRes.items.length > 0) {
      const snippet = channelRes.items[0].snippet;
      oauthUser = { name: snippet.title, picture: snippet.thumbnails?.default?.url };
    }
    
    let subs = [];
    if (subsRes.items) {
      subs = subsRes.items.map(item => ({
        id: item.snippet.resourceId.channelId,
        title: item.snippet.title,
        thumbnail: item.snippet.thumbnails?.default?.url,
      }));
    }
    
    await StorageAdapter.setSession({ oauthUser, fetchedSubs: subs, oauthDataFetchedAt: Date.now() });
    await StorageAdapter.setLocal({ oauthUser }); // bền qua restart để popup hiển thị đúng avatar/tên
    return { subs, oauthUser };
  }
};
