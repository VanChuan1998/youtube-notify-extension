import { StorageAdapter } from "./StorageAdapter.js";

export const BadgeNotificationAdapter = {
  async updateBadge() {
    const pending = await StorageAdapter.getLocal("pending").then(r => r.pending || {});
    const now = Date.now();
    let waitingCount = 0;
    
    // We import Rules/isWaitingForLive from domain/Rules.js later, but here we can just count
    // Wait! This logic depends on domain rules. We'll pass it in or keep simple.
    // For now, let's just expose the raw chrome APIs.
  },

  async createTab(url, active = true) {
    return new Promise((resolve) => {
      chrome.tabs.create({ url, active }, (tab) => {
        resolve(tab);
      });
    });
  },

  async updateTab(tabId, options) {
    return new Promise((resolve) => {
      chrome.tabs.update(tabId, options, (tab) => {
        resolve(tab);
      });
    });
  },

  async createNotification(id, options) {
    return new Promise((resolve) => {
      chrome.notifications.create(id, options, (notificationId) => {
        resolve(notificationId);
      });
    });
  },
  
  async setBadgeText(text) {
    return new Promise((resolve) => {
      chrome.action.setBadgeText({ text }, resolve);
    });
  },

  async setBadgeBackgroundColor(color) {
    return new Promise((resolve) => {
      chrome.action.setBadgeBackgroundColor({ color }, resolve);
    });
  }
};
