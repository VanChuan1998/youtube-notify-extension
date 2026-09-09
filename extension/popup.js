// popup.js

const apiKeyInput = document.getElementById("apiKeyInput");
const toggleKeyVisibility = document.getElementById("toggleKeyVisibility");
const intervalInput = document.getElementById("intervalInput");
const saveSettingsBtn = document.getElementById("saveSettingsBtn");
const checkNowBtn = document.getElementById("checkNowBtn");
const statusMsg = document.getElementById("statusMsg");

const channelInput = document.getElementById("channelInput");
const addChannelBtn = document.getElementById("addChannelBtn");
const addMsg = document.getElementById("addMsg");

const loadSubsBtn = document.getElementById("loadSubsBtn");
const subsMsg = document.getElementById("subsMsg");
const subsList = document.getElementById("subsList");

const channelList = document.getElementById("channelList");
const emptyMsg = document.getElementById("emptyMsg");
const lastCheckInfo = document.getElementById("lastCheckInfo");

function getStorage(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function setStorage(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}
function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

function setMsg(el, text, kind) {
  el.textContent = text || "";
  el.className = "status" + (kind ? " " + kind : "");
}

// ---------- Cấu hình ----------

async function loadSettings() {
  const { apiKey, intervalMinutes, lastError, lastCheckAt } = await getStorage({
    apiKey: "",
    intervalMinutes: 10,
    lastError: "",
    lastCheckAt: 0,
  });
  apiKeyInput.value = apiKey || "";
  intervalInput.value = intervalMinutes || 10;
  if (lastError) setMsg(statusMsg, "Lỗi: " + lastError, "error");
  if (lastCheckAt) {
    lastCheckInfo.textContent = "Lần kiểm tra gần nhất: " + new Date(lastCheckAt).toLocaleString("vi-VN");
  }
}

toggleKeyVisibility.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
});

saveSettingsBtn.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  const minutes = Math.max(1, parseInt(intervalInput.value, 10) || 10);
  await setStorage({ apiKey });
  await sendMessage({ type: "updateInterval", minutes });
  setMsg(statusMsg, "Đã lưu cấu hình.", "ok");
});

checkNowBtn.addEventListener("click", async () => {
  setMsg(statusMsg, "Đang kiểm tra...", "");
  checkNowBtn.disabled = true;
  const res = await sendMessage({ type: "checkNow" });
  checkNowBtn.disabled = false;
  if (res && res.ok) {
    setMsg(statusMsg, "Đã kiểm tra xong.", "ok");
  } else {
    setMsg(statusMsg, "Lỗi: " + (res && res.error), "error");
  }
  await loadSettings();
  await renderChannelList();
});

// ---------- Thêm kênh thủ công ----------

addChannelBtn.addEventListener("click", async () => {
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

  const { channels } = await getStorage({ channels: {} });
  const ch = res.channel;
  channels[ch.id] = {
    id: ch.id,
    title: ch.title,
    thumbnail: ch.thumbnail,
    uploadsPlaylistId: ch.uploadsPlaylistId,
    watched: true,
    initialized: false,
    lastVideoId: null,
    addedAt: Date.now(),
  };
  await setStorage({ channels });
  channelInput.value = "";
  setMsg(addMsg, `Đã thêm: ${ch.title}`, "ok");
  await renderChannelList();
});

// ---------- Danh sách kênh đang theo dõi ----------

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
    const subtitle = document.createElement("div");
    subtitle.className = "subtitle";
    subtitle.textContent = ch.lastError
      ? "Lỗi: " + ch.lastError
      : ch.lastCheckedTitle
      ? "Mới nhất: " + ch.lastCheckedTitle
      : "Chưa kiểm tra";
    info.appendChild(title);
    info.appendChild(subtitle);
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

// ---------- Lấy danh sách kênh đã subscribe (OAuth) ----------

function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : "Không lấy được token"));
      } else {
        resolve(token);
      }
    });
  });
}

async function fetchAllSubscriptions(token) {
  let subs = [];
  let pageToken = "";
  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
    url.searchParams.set("part", "snippet");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("order", "alphabetical");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
    }
    for (const item of data.items || []) {
      subs.push({
        id: item.snippet.resourceId.channelId,
        title: item.snippet.title,
        thumbnail:
          (item.snippet.thumbnails &&
            (item.snippet.thumbnails.default || item.snippet.thumbnails.medium) || {}).url || "",
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
        uploadsPlaylistId: null,
        watched: true,
        initialized: false,
        lastVideoId: null,
        addedAt: Date.now(),
      };
      await setStorage({ channels: latest });
      addBtn.textContent = "Đã thêm";
      addBtn.disabled = true;
      await renderChannelList();
    });
    item.appendChild(addBtn);

    subsList.appendChild(item);
  }
}

loadSubsBtn.addEventListener("click", async () => {
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

(async function init() {
  await loadSettings();
  await renderChannelList();
})();
