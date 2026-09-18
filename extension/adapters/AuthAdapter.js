function base64UrlEncode(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

// Đổi code/refresh token qua proxy Cloudflare Worker của chính dự án — proxy giữ
// client_secret phía server, extension không bao giờ nhúng secret (xem worker/index.js).
const OAUTH_PROXY_BASE = "https://youtube-notification.chuan-nv.com";

async function postToProxy(path, body) {
  const res = await fetch(`${OAUTH_PROXY_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || `Yêu cầu token thất bại (${res.status})`);
    err.status = res.status;
    err.code = json.error;
    throw err;
  }
  return json;
}

export const AuthAdapter = {
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
  },

  // ---------- Authorization Code + PKCE (cho phép nhận refresh_token) ----------

  async createPkcePair() {
    const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
    const verifier = base64UrlEncode(verifierBytes);
    const challenge = await sha256Base64Url(verifier);
    return { verifier, challenge };
  },

  async exchangeCodeForToken({ code, redirectUri, codeVerifier }) {
    return postToProxy("/oauth/exchange", {
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
  },

  async refreshAccessToken({ refreshToken }) {
    return postToProxy("/oauth/refresh", {
      refresh_token: refreshToken,
    });
  },
};
