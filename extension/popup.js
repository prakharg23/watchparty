const $ = (id) => document.getElementById(id);

let activeTabId = null;
let pollTimer = null;
let waitTimer = null;

// Talk to the content script in the active tab directly. Content scripts run in
// every frame, so try each frame and keep the answer from the one with a player.
async function contentRequest(payload) {
  try {
    if (activeTabId === null) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { ok: false, error: "No active tab" };
      activeTabId = tab.id;
    }
    let frameIds = [0];
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId: activeTabId });
      if (frames?.length) frameIds = frames.map((f) => f.frameId);
    } catch {
      /* top frame only */
    }
    let best = null;
    for (const frameId of frameIds) {
      try {
        const r = await chrome.tabs.sendMessage(activeTabId, payload, { frameId });
        if (r && (best === null || r.hasVideo || r.inParty)) best = r;
        if (r?.hasVideo || r?.inParty) break;
      } catch {
        /* no content script in this frame */
      }
    }
    return best || { ok: false, error: "Open a Hulu or Plex video page first. If you just installed the extension, reload the page." };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + kind;
}

function showParty(info) {
  $("setup").classList.add("hidden");
  $("party").classList.add("active");
  $("bigcode").textContent = info.code;
  $("link").textContent = info.inviteUrl || "";
  setStatus(`In party ${info.code} · ${info.users} watching`, "ok");
}

function showSetup() {
  $("setup").classList.remove("hidden");
  $("party").classList.remove("active");
}

function setBusy(busy) {
  $("create").disabled = busy;
  $("join").disabled = busy;
}

// Ping the relay over plain HTTPS from the popup. This wakes a sleeping free
// host even before the page opens its WebSocket, and tells us if the URL is dead.
async function wakeServer(serverUrl) {
  const httpUrl = serverUrl.replace(/^ws/, "http").replace(/\/+$/, "") + "/health";
  const started = Date.now();
  try {
    // no-cors: we only care that the host answered, and this needs no extra
    // host permissions. A sleeping Render service wakes on this request.
    await fetch(httpUrl, { cache: "no-store", mode: "no-cors" });
    return { ok: true, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: String(e?.message || e) };
  }
}

function startWaitTicker(label) {
  const started = Date.now();
  clearInterval(waitTimer);
  waitTimer = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    setStatus(`${label} ${s}s. A sleeping free server can take up to a minute.`);
  }, 1000);
}

function stopWaitTicker() {
  clearInterval(waitTimer);
  waitTimer = null;
}

async function refresh() {
  const settings = await chrome.storage.sync.get(["nickname", "serverUrl", "secret"]);
  $("nickname").value = settings.nickname || "";
  $("serverUrl").value = settings.serverUrl || WP_CONFIG.DEFAULT_SERVER_URL;
  $("secret").value = settings.secret || WP_CONFIG.DEFAULT_SECRET;

  const r = await contentRequest({ type: "status" });
  if (!r || !r.ok) {
    showSetup();
    setStatus(r?.error || "Open a Hulu or Plex video page first.", "err");
    setBusy(true);
    return false;
  }
  setBusy(false);
  if (r.inParty) {
    showParty(r);
    return true;
  }
  showSetup();
  if (!waitTimer) {
    setStatus(
      r.hasVideo ? "Video detected. Ready to party." : "No video found yet. Start playing something first.",
      r.hasVideo ? "ok" : ""
    );
  }
  return false;
}

// While a create/join is in flight, poll the page so the popup shows the real
// state even if the original request is lost (popup closed and reopened, etc).
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const r = await contentRequest({ type: "status" });
    if (r?.ok && r.inParty) {
      stopWaitTicker();
      clearInterval(pollTimer);
      showParty(r);
      setBusy(false);
    } else if (r?.ok && r.pendingError) {
      stopWaitTicker();
      clearInterval(pollTimer);
      setStatus(r.pendingError, "err");
      setBusy(false);
    }
  }, 1500);
}

async function saveNick() {
  const nickname = $("nickname").value.trim();
  await chrome.storage.sync.set({ nickname });
  return nickname;
}

async function startOrJoin(type, code) {
  const nickname = await saveNick();
  const serverUrl = $("serverUrl").value.trim() || WP_CONFIG.DEFAULT_SERVER_URL;
  setBusy(true);

  setStatus("Waking up the relay server...");
  const wake = await wakeServer(serverUrl);
  if (!wake.ok) {
    setBusy(false);
    return setStatus(`Can't reach ${serverUrl}. Check Server settings below.`, "err");
  }

  startWaitTicker(type === "create" ? "Creating party..." : "Joining...");
  startPolling();
  const r = await contentRequest({ type, code, nickname });
  stopWaitTicker();
  clearInterval(pollTimer);
  setBusy(false);
  if (r?.ok && r.inParty) showParty(r);
  else setStatus(r?.error || (type === "create" ? "Could not create party." : "Could not join party."), "err");
}

$("create").onclick = () => startOrJoin("create");

$("join").onclick = () => {
  const code = $("code").value.trim().toUpperCase();
  if (code.length !== 6) return setStatus("Enter the 6-character party code.", "err");
  startOrJoin("join", code);
};

$("leave").onclick = async () => {
  await contentRequest({ type: "leave" });
  showSetup();
  setStatus("Left the party.");
};

$("copy").onclick = async () => {
  const text = $("link").textContent;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Invite link copied. Send it to your friends.", "ok");
  } catch {
    setStatus("Copy failed. Select the link text and copy manually.", "err");
  }
};

$("saveServer").onclick = async () => {
  const url = $("serverUrl").value.trim();
  if (!/^wss?:\/\//.test(url)) return setStatus("Server URL must start with ws:// or wss://", "err");
  await chrome.storage.sync.set({ serverUrl: url, secret: $("secret").value.trim() });
  setStatus("Checking server...");
  const wake = await wakeServer(url);
  setStatus(wake.ok ? `Server saved and reachable (${wake.ms} ms).` : `Saved, but ${url} did not answer. Double-check the URL.`, wake.ok ? "ok" : "err");
};

$("code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("join").click();
});
$("nickname").addEventListener("change", saveNick);

refresh();
