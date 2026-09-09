// Service worker: seeds default settings on install. The popup talks to the
// page's content script directly, so nothing long-running lives here (Chrome
// stops idle service workers after ~30s, which would drop a slow request).
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
