export const StorageAdapter = {
  getLocal(keys) {
    return chrome.storage.local.get(keys);
  },
  setLocal(items) {
    return chrome.storage.local.set(items);
  },
  removeLocal(keys) {
    return chrome.storage.local.remove(keys);
  },
  getSession(keys) {
    return chrome.storage.session.get(keys);
  },
  setSession(items) {
    return chrome.storage.session.set(items);
  },
  removeSession(keys) {
    return chrome.storage.session.remove(keys);
  }
};
