// Service worker: seeds default settings and relays popup <-> content messages.
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

// The popup asks the background to talk to the active tab's content script.
// Content scripts run in every frame, so try each frame and prefer the one
// that actually owns a <video>.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== "content") return;
  (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return sendResponse({ ok: false, error: "No active tab" });

    let frameIds = [0];
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      if (frames?.length) frameIds = frames.map((f) => f.frameId);
    } catch {
      /* fall back to the top frame only */
    }

    let best = null;
    for (const frameId of frameIds) {
      try {
        const r = await chrome.tabs.sendMessage(tab.id, msg.payload, { frameId });
        if (r && (best === null || r.hasVideo || r.inParty)) best = r;
        if (r?.hasVideo || r?.inParty) break;
      } catch {
        /* this frame has no content script */
      }
    }

    if (!best) {
      return sendResponse({
        ok: false,
        error: "Open a Hulu or Plex video page first (reload it if you just installed the extension).",
      });
    }
    sendResponse(best);
  })();
  return true;
});
