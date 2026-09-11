// popup.js

const $ = (id) => document.getElementById(id);

const apiKeyInput = $("apiKeyInput");
const toggleKeyVisibility = $("toggleKeyVisibility");
const discoverInput = $("discoverInput");
const liveCheckInput = $("liveCheckInput");
const saveSettingsBtn = $("saveSettingsBtn");
const checkNowBtn = $("checkNowBtn");
const statusMsg = $("statusMsg");

const channelInput = $("channelInput");
const addChannelBtn = $("addChannelBtn");
const addMsg = $("addMsg");

const pendingCard = $("pendingCard");
const pendingList = $("pendingList");
const liveEvery = $("liveEvery");

const loadSubsBtn = $("loadSubsBtn");
const subsMsg = $("subsMsg");
const subsList = $("subsList");

const channelList = $("channelList");
const emptyMsg = $("emptyMsg");
const lastCheckInfo = $("lastCheckInfo");

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function setStorage(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      // Nếu service worker chết hoặc chưa kịp khởi động, callback được gọi với
      // res === undefined và lỗi nằm ở chrome.runtime.lastError.
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { ok: false, error: "Không nhận được phản hồi từ extension." });
    });
  });
}

function setMsg(el, text, kind) {
  el.textContent = text || "";
  el.className = "status" + (kind ? " " + kind : "");
}

// client_id mặc định trong manifest là chỗ giữ chỗ; OAuth chỉ chạy sau khi người
// dùng thay bằng client_id thật (xem docs/OAUTH-SETUP.md).
function isOAuthConfigured() {
  const oauth2 = chrome.runtime.getManifest().google_oauth2 || chrome.runtime.getManifest().oauth2;
  const id = (oauth2 && oauth2.client_id) || "";
  return !!id && id.endsWith(".apps.googleusercontent.com") && !/[^\x00-\x7F]/.test(id);
}

function timeAgo(ts) {
  if (!ts) return "chưa chạy";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s} giây trước`;
  if (s < 3600) return `${Math.round(s / 60)} phút trước`;
  return new Date(ts).toLocaleString("vi-VN");
}

// ---------- Cấu hình ----------

async function loadSettings() {
  const { apiKey, discoverSeconds, liveCheckSeconds, status } = await getStorage({
    apiKey: "",
    discoverSeconds: 60,
    liveCheckSeconds: 30,
    status: {},
  });

  apiKeyInput.value = apiKey || "";
  discoverInput.value = discoverSeconds || 60;
  liveCheckInput.value = liveCheckSeconds || 30;
  liveEvery.textContent = liveCheckSeconds || 30;

  if (status && status.lastError) setMsg(statusMsg, "Lỗi: " + status.lastError, "error");

  const parts = [];
  if (status && status.lastDiscoverAt) parts.push("Quét kênh: " + timeAgo(status.lastDiscoverAt));
  if (status && status.lastLiveCheckAt) parts.push("Kiểm tra live: " + timeAgo(status.lastLiveCheckAt));
  lastCheckInfo.textContent = parts.join(" · ");
}

toggleKeyVisibility.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
});

saveSettingsBtn.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  const discoverSeconds = Math.max(30, parseInt(discoverInput.value, 10) || 60);
  const liveCheckSeconds = Math.max(30, parseInt(liveCheckInput.value, 10) || 30);

  discoverInput.value = discoverSeconds;
  liveCheckInput.value = liveCheckSeconds;
  liveEvery.textContent = liveCheckSeconds;

  await setStorage({ apiKey });
  const res = await sendMessage({ type: "updateIntervals", discoverSeconds, liveCheckSeconds });
  setMsg(
    statusMsg,
    res && res.ok ? "Đã lưu cấu hình." : "Lỗi: " + (res && res.error),
    res && res.ok ? "ok" : "error"
  );
});

checkNowBtn.addEventListener("click", async () => {
  setMsg(statusMsg, "Đang kiểm tra...", "");
  checkNowBtn.disabled = true;
  const res = await sendMessage({ type: "checkNow" });
  checkNowBtn.disabled = false;
  setMsg(
    statusMsg,
    res && res.ok ? "Đã kiểm tra xong." : "Lỗi: " + (res && res.error),
    res && res.ok ? "ok" : "error"
  );
  await refresh();
});

// ---------- Thêm kênh ----------

addChannelBtn.addEventListener("click", addChannel);
channelInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addChannel();
});

async function addChannel() {
  const input = channelInput.value.trim();
  if (!input) return;

  addChannelBtn.disabled = true;
  setMsg(addMsg, "Đang tìm kênh...", "");
  const res = await sendMessage({ type: "resolveChannel", input });
  addChannelBtn.disabled = false;

  if (!res || !res.ok) {
    setMsg(addMsg, "Không tìm thấy: " + (res && res.error), "error");
    return;
  }

  const ch = res.channel;
  const { channels } = await getStorage({ channels: {} });
  channels[ch.id] = {
    id: ch.id,
    title: ch.title,
    thumbnail: ch.thumbnail,
    watched: true,
    mode: "all",
    initialized: false,
    seenVideoIds: [],
    etag: "",
    lastModified: "",
    addedAt: Date.now(),
  };
  await setStorage({ channels });

  channelInput.value = "";
  setMsg(addMsg, `Đã thêm: ${ch.title}. Đang chốt mốc...`, "ok");
  await renderChannelList();

  const init = await sendMessage({ type: "initChannel", channelId: ch.id });
  setMsg(
    addMsg,
    init && init.ok ? `Đã thêm: ${ch.title}` : `Đã thêm: ${ch.title} (chưa chốt được mốc: ${init && init.error})`,
    init && init.ok ? "ok" : "error"
  );
  await renderChannelList();
}

// ---------- Danh sách kênh ----------

async function renderChannelList() {
  const { channels } = await getStorage({ channels: {} });
  const list = Object.values(channels || {}).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));

  channelList.innerHTML = "";
  emptyMsg.style.display = list.length ? "none" : "block";

  for (const ch of list) {
    const item = document.createElement("div");
    item.className = "channel-item";

    const img = document.createElement("img");
    img.src = ch.thumbnail || "icons/icon48.png";
    item.appendChild(img);

    const info = document.createElement("div");
    info.className = "info";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = ch.title || ch.id;
    info.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "subtitle";
    subtitle.textContent = ch.lastError
      ? "Lỗi: " + ch.lastError
      : ch.lastCheckedTitle
      ? "Mới nhất: " + ch.lastCheckedTitle
      : "Chưa kiểm tra";
    info.appendChild(subtitle);

    // Chọn hành vi riêng cho từng kênh: kênh hay livestream thì đặt "Chỉ livestream"
    // để video thường không mở tab.
    const mode = document.createElement("select");
    mode.className = "mode-select";
    for (const [value, label] of [["all", "Mọi video"], ["liveOnly", "Chỉ livestream"]]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      mode.appendChild(opt);
    }
    mode.value = ch.mode === "liveOnly" ? "liveOnly" : "all";
    mode.addEventListener("change", async () => {
      const { channels: latest } = await getStorage({ channels: {} });
      if (latest[ch.id]) {
        latest[ch.id].mode = mode.value;
        await setStorage({ channels: latest });
      }
    });
    info.appendChild(mode);

    item.appendChild(info);

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = !!ch.watched;
    toggle.title = "Bật/tắt theo dõi";
    toggle.addEventListener("change", async () => {
      const { channels: latest } = await getStorage({ channels: {} });
      if (latest[ch.id]) {
        latest[ch.id].watched = toggle.checked;
        await setStorage({ channels: latest });
      }
    });
    item.appendChild(toggle);

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "✕";
    removeBtn.title = "Xoá kênh";
    removeBtn.addEventListener("click", async () => {
      const { channels: latest } = await getStorage({ channels: {} });
      delete latest[ch.id];
      await setStorage({ channels: latest });
      await renderChannelList();
    });
    item.appendChild(removeBtn);

    channelList.appendChild(item);
  }
}

// ---------- Đang chờ lên sóng ----------

async function renderPending() {
  const { pending, channels } = await getStorage({ pending: {}, channels: {} });
  const list = Object.values(pending || {}).sort(
    (a, b) => Date.parse(a.scheduledStartTime || 0) - Date.parse(b.scheduledStartTime || 0)
  );

  pendingCard.style.display = list.length ? "block" : "none";
  pendingList.innerHTML = "";

  for (const entry of list) {
    const ch = (channels || {})[entry.channelId] || {};

    const item = document.createElement("div");
    item.className = "channel-item";

    const info = document.createElement("div");
    info.className = "info";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = entry.title || entry.videoId;
    info.appendChild(title);

    const subtitle = document.createElement("div");
    subtitle.className = "subtitle";
    const when = entry.scheduledStartTime
      ? "Dự kiến " + new Date(entry.scheduledStartTime).toLocaleString("vi-VN")
      : "Chưa rõ giờ phát";
    subtitle.textContent = `${ch.title || entry.channelId} · ${when}`;
    info.appendChild(subtitle);

    item.appendChild(info);

    const open = document.createElement("a");
    open.className = "secondary btn-link";
    open.textContent = "Mở";
    open.href = `https://www.youtube.com/watch?v=${entry.videoId}`;
    open.target = "_blank";
    item.appendChild(open);

    pendingList.appendChild(item);
  }
}

// ---------- Subscriptions (OAuth) ----------

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    const manifest = chrome.runtime.getManifest();
    const oauth2 = manifest.google_oauth2 || manifest.oauth2;
    if (!oauth2 || !oauth2.client_id) {
      return reject(new Error("Không tìm thấy cấu hình OAuth trong manifest."));
    }

    const clientId = oauth2.client_id;
    const scopes = (oauth2.scopes || []).join(' ');
    const redirectUrl = chrome.identity.getRedirectURL();

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'token');
    authUrl.searchParams.set('redirect_uri', redirectUrl);
    authUrl.searchParams.set('scope', scopes);
    if (interactive) {
      authUrl.searchParams.set('prompt', 'consent');
    }

    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive },
      (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : "Đăng nhập bị hủy hoặc thất bại."));
          return;
        }
        const url = new URL(responseUrl);
        const params = new URLSearchParams(url.hash.substring(1));
        const token = params.get('access_token');
        if (token) {
          resolve(token);
        } else {
          reject(new Error("Không tìm thấy access token trong kết quả trả về."));
        }
      }
    );
  });
}

async function fetchAllSubscriptions(token) {
  const subs = [];
  let pageToken = "";
  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("order", "alphabetical");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);

    for (const item of data.items || []) {
      const thumbs = item.snippet.thumbnails || {};
      subs.push({
        id: item.snippet.resourceId.channelId,
        title: item.snippet.title,
        thumbnail: (thumbs.default || thumbs.medium || {}).url || "",
      });
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return subs;
}

async function renderSubsList(subs) {
  const { channels } = await getStorage({ channels: {} });
  subsList.innerHTML = "";

  for (const sub of subs) {
    const alreadyAdded = !!channels[sub.id];

    const item = document.createElement("div");
    item.className = "channel-item";

    const img = document.createElement("img");
    img.src = sub.thumbnail || "icons/icon48.png";
    item.appendChild(img);

    const info = document.createElement("div");
    info.className = "info";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = sub.title;
    info.appendChild(title);
    item.appendChild(info);

    const addBtn = document.createElement("button");
    addBtn.className = "secondary";
    addBtn.textContent = alreadyAdded ? "Đã thêm" : "+ Thêm";
    addBtn.disabled = alreadyAdded;
    addBtn.addEventListener("click", async () => {
      const { channels: latest } = await getStorage({ channels: {} });
      latest[sub.id] = {
        id: sub.id,
        title: sub.title,
        thumbnail: sub.thumbnail,
        watched: true,
        mode: "all",
        initialized: false,
        seenVideoIds: [],
        etag: "",
        lastModified: "",
        addedAt: Date.now(),
      };
      await setStorage({ channels: latest });
      addBtn.textContent = "Đã thêm";
      addBtn.disabled = true;
      await renderChannelList();
      await sendMessage({ type: "initChannel", channelId: sub.id });
      await renderChannelList();
    });
    item.appendChild(addBtn);

    subsList.appendChild(item);
  }
}

loadSubsBtn.addEventListener("click", async () => {
  if (!isOAuthConfigured()) {
    setMsg(
      subsMsg,
      "Chưa cấu hình OAuth client ID. Xem docs/OAUTH-SETUP.md trong mã nguồn để tạo " +
        "client ID trên Google Cloud, dán vào oauth2.client_id trong manifest.json rồi tải lại extension.",
      "error"
    );
    return;
  }

  loadSubsBtn.disabled = true;
  setMsg(subsMsg, "Đang đăng nhập Google...", "");
  try {
    const token = await getAuthToken(true);
    setMsg(subsMsg, "Đang tải danh sách kênh đã đăng ký...", "");
    const subs = await fetchAllSubscriptions(token);
    setMsg(subsMsg, `Tìm thấy ${subs.length} kênh.`, "ok");
    await renderSubsList(subs);
  } catch (err) {
    setMsg(subsMsg, "Lỗi: " + err.message, "error");
  } finally {
    loadSubsBtn.disabled = false;
  }
});

// ---------- Khởi tạo ----------

async function refresh() {
  await loadSettings();
  await renderPending();
  await renderChannelList();
}

(async function init() {
  await refresh();
  if (!isOAuthConfigured()) {
    loadSubsBtn.title = "Cần cấu hình OAuth client ID trước — xem docs/OAUTH-SETUP.md";
    setMsg(subsMsg, "Tính năng này cần OAuth client ID (xem docs/OAUTH-SETUP.md).", "");
    const redirectUriInfo = $("redirectUriInfo");
    if (redirectUriInfo) {
      redirectUriInfo.style.display = "block";
      redirectUriInfo.innerHTML = `<strong>Redirect URI của bạn:</strong><br>${chrome.identity.getRedirectURL()}`;
    }
  }
})();

// Cập nhật popup khi service worker ghi trạng thái mới trong lúc popup đang mở.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.pending || changes.status || changes.channels) refresh();
});
