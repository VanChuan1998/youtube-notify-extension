export const YouTubeAdapter = {
  async apiFetch(path, params, token) {
    const url = new URL(`https://www.googleapis.com/youtube/v3${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, v);
        }
      }
    }
    const headers = {};
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const resp = await fetch(url.toString(), { headers });
    if (!resp.ok) {
      const errorText = await resp.text();
      let msg = `${resp.status} ${resp.statusText}`;
      try {
        const parsed = JSON.parse(errorText);
        if (parsed.error && parsed.error.message) {
          msg += `: ${parsed.error.message}`;
        }
      } catch (e) {
        msg += `: ${errorText}`;
      }
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }
};
