// Cloudflare Worker: giữ OAuth client_secret phía server, dùng làm proxy đổi
// authorization code / refresh token với Google thay cho extension. Extension
// không bao giờ nhúng client_secret; Worker chỉ chuyển tiếp request tới Google,
// không lưu trữ token hay dữ liệu người dùng ở đâu cả.
//
// Bí mật OAUTH_CLIENT_SECRET được set bằng: wrangler secret put OAUTH_CLIENT_SECRET
// (không commit giá trị thật vào repo). OAUTH_CLIENT_ID là giá trị công khai,
// có thể để trong wrangler.jsonc "vars".

const REDIRECT_SUFFIX = ".chromiumapp.org/";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function forwardToGoogle(params) {
  const upstream = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const json = await upstream.json().catch(() => ({}));
  return { json, status: upstream.status };
}

async function handleExchange(request, env) {
  const body = await readJsonBody(request);
  const { code, redirect_uri: redirectUri, code_verifier: codeVerifier } = body || {};
  if (!code || !redirectUri || !codeVerifier) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }
  if (!redirectUri.endsWith(REDIRECT_SUFFIX)) {
    return jsonResponse({ error: "invalid_redirect_uri" }, 400);
  }

  const { json, status } = await forwardToGoogle({
    code,
    client_id: env.OAUTH_CLIENT_ID,
    client_secret: env.OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });
  return jsonResponse(json, status);
}

async function handleRefresh(request, env) {
  const body = await readJsonBody(request);
  const { refresh_token: refreshToken } = body || {};
  if (!refreshToken) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  const { json, status } = await forwardToGoogle({
    refresh_token: refreshToken,
    client_id: env.OAUTH_CLIENT_ID,
    client_secret: env.OAUTH_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  return jsonResponse(json, status);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/oauth/exchange" || url.pathname === "/oauth/refresh") {
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders() });
      }
      if (request.method !== "POST") {
        return jsonResponse({ error: "method_not_allowed" }, 405);
      }
      return url.pathname === "/oauth/exchange"
        ? handleExchange(request, env)
        : handleRefresh(request, env);
    }

    // Mọi request khác: phục vụ static site như trước (web/).
    return env.ASSETS.fetch(request);
  },
};
