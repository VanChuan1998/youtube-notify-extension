import { AuthAdapter } from "../../adapters/AuthAdapter.js";
import { StorageAdapter } from "../../adapters/StorageAdapter.js";

// KHÔNG nhúng client_secret ở đây. Việc đổi authorization code / refresh token
// lấy access token đi qua proxy Cloudflare Worker của dự án (worker/index.js),
// nơi giữ client_secret phía server. Xem docs/OAUTH-SETUP.md mục 6.

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

    // Ưu tiên refresh_token: bền qua restart trình duyệt/PC và không phụ thuộc
    // cookie đăng nhập Google hay tracking prevention của Edge (khác với silent
    // launchWebAuthFlow trước đây, vốn thất bại có hệ thống trên Edge).
    const restored = await this.restoreOAuthTokenWithRefreshToken(clientId);
    if (restored) return restored;

    // Dự phòng cho user cũ chưa có refresh_token (nâng cấp từ implicit flow):
    // thử một lần silent code-flow để lấy refresh_token mới.
    const restoredSilently = await this.restoreOAuthTokenSilently(clientId);
    if (!restoredSilently) await this.clearOAuthSessionView();
    return restoredSilently;
  },

  async restoreOAuthTokenWithRefreshToken(clientIdOverride = "") {
    const { googleOAuthAuthorized, googleOAuthClientId, googleOAuthRefreshToken } = await StorageAdapter.getLocal({
      googleOAuthAuthorized: false,
      googleOAuthClientId: "",
      googleOAuthRefreshToken: "",
    });
    const clientId = (clientIdOverride || googleOAuthClientId || "").trim();
    if (!googleOAuthAuthorized || !clientId || !googleOAuthRefreshToken) return "";

    try {
      const json = await AuthAdapter.refreshAccessToken({
        refreshToken: googleOAuthRefreshToken,
      });
      return await this.saveOAuthSession(
        { token: json.access_token, expiresIn: json.expires_in },
        clientId
      );
    } catch (err) {
      // invalid_grant nghĩa là refresh token đã bị revoke/hết hiệu lực: xoá để
      // không thử lại vô ích, người dùng cần kết nối lại thủ công.
      if (err?.code === "invalid_grant") {
        await StorageAdapter.removeLocal(["googleOAuthRefreshToken"]);
      }
      console.debug("Làm mới access token bằng refresh_token thất bại:", err?.message || String(err));
      return "";
    }
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
    const { verifier, challenge } = await AuthAdapter.createPkcePair();

    let authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUrl)}&response_type=code&access_type=offline&scope=${encodeURIComponent(scopes.join(" "))}&include_granted_scopes=true&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256`;
    if (prompt) {
      authUrl += `&prompt=${encodeURIComponent(prompt)}`;
    }

    const responseUrl = await AuthAdapter.launchWebAuthFlow(authUrl, interactive);
    const params = new URL(responseUrl).searchParams;
    if (params.get("error")) throw new Error(params.get("error_description") || params.get("error"));
    const code = params.get("code");
    if (!code) throw new Error("Không lấy được authorization code từ URL trả về");

    const json = await AuthAdapter.exchangeCodeForToken({
      code,
      redirectUri: redirectUrl,
      codeVerifier: verifier,
    });
    return {
      token: json.access_token,
      expiresIn: parseInt(json.expires_in || "3600", 10),
      refreshToken: json.refresh_token || "",
    };
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
    if (authRes.refreshToken) {
      // Bền qua restart: đây là thứ thay thế hoàn toàn nhu cầu silent
      // launchWebAuthFlow dựa vào cookie trình duyệt.
      await StorageAdapter.setLocal({ googleOAuthRefreshToken: authRes.refreshToken });
    }
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

    // Ngay lúc PC vừa khởi động, mạng có thể chưa sẵn sàng khi onStartup bắn ra,
    // khiến việc gọi token endpoint thất bại dù refresh_token vẫn còn hiệu lực.
    // Thử lại vài lần trước khi báo lỗi "cần kết nối lại" cho người dùng.
    const RETRY_DELAYS_MS = [2000, 5000, 10000];
    let token = await this.getCachedOAuthToken();
    for (let i = 0; !token && i < RETRY_DELAYS_MS.length; i++) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
      token = await this.getCachedOAuthToken();
    }
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
    const { googleOAuthRefreshToken } = await StorageAdapter.getLocal({ googleOAuthRefreshToken: "" });
    // Thu hồi refresh_token (nếu có) sẽ vô hiệu hoá toàn bộ grant, bao gồm mọi
    // access token đang tồn tại; ưu tiên nó hơn access token đơn lẻ.
    const tokenToRevoke = googleOAuthRefreshToken || token;
    if (!tokenToRevoke) return { success: false, warning: "Không có token" };
    try {
      const manifest = chrome.runtime.getManifest();
      if (manifest.oauth2 && token) {
        await AuthAdapter.removeCachedAuthToken(token).catch(() => { });
      }
      const response = await fetch(`https://oauth2.googleapis.com/revoke?token=${tokenToRevoke}`, {
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
    await StorageAdapter.removeLocal(["googleOAuthAuthorized", "googleOAuthRefreshToken"]);
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
