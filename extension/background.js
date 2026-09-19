// Service worker: seeds default settings, tells content scripts their tab id
// (so a party can be remembered per tab across next-episode navigation), and
// forgets a tab's party when the tab closes. Nothing long-running lives here.
importScripts("config.js");

const DEFAULTS = {
  serverUrl: WP_CONFIG.DEFAULT_SERVER_URL,
  secret: WP_CONFIG.DEFAULT_SECRET,
  nickname: "",
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.sync.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (current[k] === undefined) patch[k] = v;
  }
  if (Object.keys(patch).length) await chrome.storage.sync.set(patch);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "tabId") {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return false;
  }
  // Relay the chat box's messages from its frame to the page's content script,
  // so what you type never passes through the streaming site's own page.
  if (msg?.wpCompose === true && sender.tab?.id != null) {
    chrome.tabs.sendMessage(sender.tab.id, msg, { frameId: 0 }).catch(() => {});
    return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.remove("party:" + tabId);
});
