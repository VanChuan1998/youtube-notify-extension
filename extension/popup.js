// popup.js
import { isWaitingForLive, hasStreamStarted, UPCOMING_GRACE_MS } from "./core/domain/Rules.js";

const OAUTH_CLIENT_ID = "736665623723-ovim8oer8j3n4de3otggf72oebgeursn.apps.googleusercontent.com";

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
const pendingStatus = $("pendingStatus");
const unconfirmedCard = $("unconfirmedCard");
const unconfirmedList = $("unconfirmedList");
const unconfirmedSummary = $("unconfirmedSummary");
const liveEvery = $("liveEvery");
let pendingRefreshing = true;
let pendingRefreshError = "";
let pendingRenderVersion = 0;

const userInfoContainer = $("userInfoContainer");
const userAvatar = $("userAvatar");
const userName = $("userName");
const logoutBtn = $("logoutBtn");

const loadSubsBtn = $("loadSubsBtn");
const resetOAuthBtn = $("resetOAuthBtn");
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

function getSessionStorage(keys) {
  return new Promise((resolve) => chrome.storage.session.get(keys, resolve));
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

// OAuth chỉ chạy sau khi có client_id hợp lệ.
function isOAuthConfigured() {
  const id = OAUTH_CLIENT_ID;
  return !!id && id.endsWith(".apps.googleusercontent.com") && !/[^\x00-\x7F]/.test(id) && !id.includes("MÃ_CLIENT_ID");
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

  if (status && status.lastError) {
    setMsg(statusMsg, "Lỗi: " + status.lastError, "error");
  } else {
    // Xoá thông báo lỗi cũ khi background đã phục hồi credential/thành công.
    setMsg(statusMsg, "", "");
  }

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
  if (res?.ok) pendingRefreshError = "";
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
  if (!input || addChannelBtn.disabled) return;

  addChannelBtn.disabled = true;
  setMsg(addMsg, "Đang tìm kênh...", "");
  const res = await sendMessage({ type: "resolveChannel", input });

  if (!res || !res.ok) {
    addChannelBtn.disabled = false;
    setMsg(addMsg, "Không tìm thấy: " + (res && res.error), "error");
    return;
  }

  const ch = res.channel;
  channelInput.value = "";
  setMsg(addMsg, `Đang thêm ${ch.title} và kiểm tra livestream...`, "");
  const init = await sendMessage({ type: "addChannel", channel: ch, source: "manual" });
  addChannelBtn.disabled = false;
  setMsg(
    addMsg,
    init && init.ok ? `Đã thêm: ${ch.title}` : `Chưa hoàn tất kiểm tra ${ch.title}: ${init && init.error}`,
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
      const result = await sendMessage({ type: "updateChannel", channelId: ch.id, patch: { mode: mode.value } });
      if (!result?.ok) setMsg(statusMsg, "Lỗi: " + result?.error, "error");
    });
    info.appendChild(mode);

    item.appendChild(info);

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = !!ch.watched;
    toggle.title = "Bật/tắt theo dõi";
    toggle.addEventListener("change", async () => {
      const result = await sendMessage({ type: "updateChannel", channelId: ch.id, patch: { watched: toggle.checked } });
      if (!result?.ok) setMsg(statusMsg, "Lỗi: " + result?.error, "error");
    });
    item.appendChild(toggle);

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "✕";
    removeBtn.title = "Xoá kênh";
    removeBtn.addEventListener("click", async () => {
      const result = await sendMessage({ type: "removeChannel", channelId: ch.id });
      if (!result?.ok) setMsg(statusMsg, "Lỗi: " + result?.error, "error");
      await renderChannelList();
    });
    item.appendChild(removeBtn);

    channelList.appendChild(item);
  }
}

// ---------- Đang chờ lên sóng ----------

async function renderPending() {
  const renderVersion = ++pendingRenderVersion;
  const { pending, channels } = await getStorage({ pending: {}, channels: {} });
  // Callback đọc storage cũ về muộn không được dựng lại hàng chờ đã bị dọn.
  if (renderVersion !== pendingRenderVersion) return;
  const candidates = Object.values(pending || {}).filter((entry) =>
    entry && channels[entry.channelId]?.watched && !entry.actualEndTime &&
    (entry.state === "upcoming" || entry.state === "unknown")
  );
  const ready = entry => !pendingRefreshing && !pendingRefreshError && isWaitingForLive(entry);
  const list = candidates.filter(ready).sort(
    (a, b) => {
      const ta = a.scheduledStartTime ? Date.parse(a.scheduledStartTime) : Infinity;
      const tb = b.scheduledStartTime ? Date.parse(b.scheduledStartTime) : Infinity;
      return ta - tb;
    }
  );
  const uncertain = candidates.filter(entry => !ready(entry));
  pendingStatus.textContent = pendingRefreshing ? "Đang kiểm tra lại trạng thái video..." : pendingRefreshError;
  pendingStatus.style.display = pendingStatus.textContent ? "block" : "none";
  unconfirmedCard.style.display = uncertain.length ? "block" : "none";
  unconfirmedSummary.textContent = `Cần kiểm tra lại (${uncertain.length})`;
  unconfirmedList.innerHTML = "";
  for (const entry of uncertain) {
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
    subtitle.textContent = pendingRefreshing ? "Đang kiểm tra lại..." :
      entry.verificationError || pendingRefreshError ||
      (hasStreamStarted(entry) ? "Đã từng lên sóng; đang xác minh trạng thái hiện tại." :
        !Number.isFinite(Date.parse(entry.scheduledStartTime || "")) ? "YouTube chưa cung cấp lịch phát được xác nhận." :
        Date.now() > Date.parse(entry.scheduledStartTime) + UPCOMING_GRACE_MS ? "Đã quá giờ dự kiến; chưa xác nhận đang phát." :
        "Trạng thái đã cũ; cần kiểm tra lại.");
    info.appendChild(subtitle);
    item.appendChild(info);
    const open = document.createElement("a");
    open.className = "secondary btn-link";
    open.textContent = "Mở";
    open.href = `https://www.youtube.com/watch?v=${entry.videoId}`;
    open.target = "_blank";
    item.appendChild(open);
    unconfirmedList.appendChild(item);
  }

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
      addBtn.disabled = true;
      addBtn.textContent = "Đang kiểm tra live...";
      const result = await sendMessage({ type: "addChannel", channel: sub, source: "subscription" });
      addBtn.textContent = result?.ok ? "Đã thêm" : "Thử kiểm tra lại";
      addBtn.disabled = !!result?.ok;
      if (!result?.ok) setMsg(subsMsg, "Chưa hoàn tất kiểm tra: " + result?.error, "error");
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
      "Chưa cấu hình OAuth client ID. Bạn cần dán Client ID vào biến OAUTH_CLIENT_ID ở đầu file popup.js rồi Tải lại (Reload) extension.",
      "error"
    );
    return;
  }

  loadSubsBtn.disabled = true;
  setMsg(subsMsg, "Đang mở cửa sổ đăng nhập Google...", "");
  
  // Access token chỉ nằm trong chrome.storage.session. Nếu đã có refresh token
  // hợp lệ, background tự lấy access token mới mà không cần mở UI; chỉ khi đó
  // thất bại (chưa từng kết nối, refresh token bị revoke...) mới mở UI OAuth.
  // Không ép prompt=consent để tránh hỏi lại không cần thiết.
  chrome.runtime.sendMessage({ type: "fetchSubscriptions", clientId: OAUTH_CLIENT_ID }, async (response) => {
    if (chrome.runtime.lastError) {
      console.error("Lỗi khi tải danh sách kênh:", chrome.runtime.lastError);
      setMsg(subsMsg, "Lỗi: " + chrome.runtime.lastError.message, "error");
      loadSubsBtn.disabled = false;
      return;
    }
    if (response.error) {
      console.error("Lỗi từ background:", response.error);
      setMsg(subsMsg, "Lỗi: " + response.error, "error");
      loadSubsBtn.disabled = false;
    } else {
      setMsg(subsMsg, `Tìm thấy ${response.subs.length} kênh. Đang hiển thị...`, "ok");
      
      if (response.oauthUser) {
        userInfoContainer.style.display = "flex";
        userAvatar.src = response.oauthUser.picture || "";
        userName.textContent = response.oauthUser.name || "Kênh YouTube";
        loadSubsBtn.textContent = "Làm mới kênh đã đăng ký (Đã kết nối)";
      }
      
      await renderChannelList(); // Gọi renderChannelList để cập nhật UI nếu bị xoá các kênh cũ do đổi tài khoản
      await renderSubsList(response.subs);
      loadSubsBtn.disabled = false;
    }
  });
});

resetOAuthBtn.addEventListener("click", async () => {
  if (!isOAuthConfigured()) {
    setMsg(subsMsg, "OAuth client ID chưa được cấu hình.", "error");
    return;
  }

  if (!confirm(
    "Đặt lại quyền Google sẽ thu hồi quyền OAuth hiện tại khi có thể và xoá dữ liệu OAuth cục bộ. " +
    "Lần kết nối tiếp theo sẽ hiển thị lại màn hình chọn tài khoản và xác nhận quyền. " +
    "Các kênh đang theo dõi sẽ được giữ nguyên. Tiếp tục?"
  )) return;

  resetOAuthBtn.disabled = true;
  loadSubsBtn.disabled = true;
  setMsg(subsMsg, "Đang đặt lại quyền Google...", "");

  const res = await sendMessage({ type: "resetOAuthForConsent", clientId: OAUTH_CLIENT_ID });

  resetOAuthBtn.disabled = false;
  loadSubsBtn.disabled = false;
  userInfoContainer.style.display = "none";
  loadSubsBtn.textContent = "Kết nối Google & tải kênh đã đăng ký";
  subsList.innerHTML = "";

  if (res && res.ok) {
    const suffix = res.warning ? ` ${res.warning}` : "";
    setMsg(
      subsMsg,
      "Đã đặt lại quyền. Bắt đầu quay video rồi bấm “Kết nối Google & tải kênh đã đăng ký”; Google sẽ hiển thị lại account chooser và consent screen." + suffix,
      res.warning ? "" : "ok"
    );
  } else {
    setMsg(subsMsg, "Không thể đặt lại quyền: " + (res && res.error ? res.error : "Không rõ lỗi"), "error");
  }
});

logoutBtn.addEventListener("click", async () => {
  if (!confirm("Ngắt kết nối sẽ thu hồi quyền OAuth khi có thể, xoá dữ liệu tải từ tài khoản Google trong phiên này và xoá các kênh đã thêm trực tiếp từ danh sách subscriptions. Tiếp tục?")) return;

  logoutBtn.disabled = true;
  setMsg(subsMsg, "Đang ngắt kết nối và thu hồi quyền...", "");
  const res = await sendMessage({ type: "revokeOAuth", clientId: OAUTH_CLIENT_ID });
  logoutBtn.disabled = false;

  userInfoContainer.style.display = "none";
  loadSubsBtn.textContent = "Kết nối Google & tải kênh đã đăng ký";
  subsList.innerHTML = "";
  await renderChannelList();

  if (res && res.ok) {
    setMsg(subsMsg, res.warning ? `Đã xoá dữ liệu cục bộ. ${res.warning}` : "Đã ngắt kết nối Google và xoá dữ liệu OAuth cục bộ.", res.warning ? "" : "ok");
  } else {
    setMsg(subsMsg, "Lỗi khi ngắt kết nối: " + (res && res.error ? res.error : "Không rõ lỗi"), "error");
  }
});

// ---------- Khởi tạo ----------

async function refresh() {
  await loadSettings();
  await renderPending();
  await renderChannelList();
  
  const { fetchedSubs, oauthUser } = await getSessionStorage({ fetchedSubs: null, oauthUser: null });
  
  if (oauthUser) {
    userInfoContainer.style.display = "flex";
    userAvatar.src = oauthUser.picture || "";
    userName.textContent = oauthUser.name || "Kênh YouTube";
  } else {
    userInfoContainer.style.display = "none";
  }
 
  if (fetchedSubs) {
    loadSubsBtn.textContent = "Làm mới kênh đã đăng ký (Đã kết nối)";
    setMsg(subsMsg, `Đã tải ${fetchedSubs.length} kênh ở lần trước.`, "ok");
    await renderSubsList(fetchedSubs);
  } else {
    loadSubsBtn.textContent = "Kết nối Google & tải kênh đã đăng ký";
  }
}

async function tryRestoreGoogleSessionSilently() {
  if (!isOAuthConfigured()) return false;

  const { oauthUser } = await getSessionStorage({ oauthUser: null });
  if (oauthUser) return true;

  const res = await sendMessage({ type: "restoreOAuthSession", clientId: OAUTH_CLIENT_ID });
  if (!res || !res.ok || !res.connected) return false;

  await refresh();
  return true;
}

(async function init() {
  await refresh();
  if (isOAuthConfigured()) {
    // Sau khi Edge/Chrome restart, storage.session trống. Thử lấy access token mới
    // bằng grant Google hiện có mà không hiện cửa sổ đăng nhập.
    await tryRestoreGoogleSessionSilently();
  }
  // Revalidate kể cả khi oauthUser đã cached hoặc chỉ dùng API key.
  const pendingResult = await sendMessage({ type: "refreshPending" });
  pendingRefreshError = pendingResult?.ok ? "" : "Không kiểm tra lại được trạng thái: " + (pendingResult?.error || "mất kết nối");
  pendingRefreshing = false;
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

// Nếu API ngừng cập nhật, nhãn upcoming hết hạn mà không cần đóng/mở popup.
setInterval(() => { void renderPending(); }, 30000);

// Cập nhật popup khi service worker ghi trạng thái mới trong lúc popup đang mở.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.pending || changes.status || changes.channels)) {
    refresh();
    return;
  }

  // Đồng bộ UI với token/account data thật trong session. Nếu token hết hạn và
  // silent restore thất bại, background xoá oauthUser/fetchedSubs để popup không
  // tiếp tục hiển thị sai trạng thái “Đã kết nối”.
  if (area === "session" && (changes.oauthUser || changes.fetchedSubs || changes.oauthToken)) {
    refresh();
  }
});
