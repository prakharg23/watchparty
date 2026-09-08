const $ = (id) => document.getElementById(id);

async function contentRequest(payload) {
  try {
    return await chrome.runtime.sendMessage({ target: "content", payload });
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

async function refresh() {
  const settings = await chrome.storage.sync.get(["nickname", "serverUrl", "secret"]);
  $("nickname").value = settings.nickname || "";
  $("serverUrl").value = settings.serverUrl || WP_CONFIG.DEFAULT_SERVER_URL;
  $("secret").value = settings.secret || WP_CONFIG.DEFAULT_SECRET;

  const r = await contentRequest({ type: "status" });
  if (!r || !r.ok) {
    showSetup();
    setStatus(r?.error || "Open a Hulu or Plex video page first.", "err");
    $("create").disabled = true;
    $("join").disabled = true;
    return;
  }
  $("create").disabled = false;
  $("join").disabled = false;
  if (r.inParty) {
    showParty(r);
  } else {
    showSetup();
    setStatus(
      r.hasVideo ? "Video detected. Ready to party." : "No video found yet. Start playing something first.",
      r.hasVideo ? "ok" : ""
    );
  }
}

async function saveNick() {
  const nickname = $("nickname").value.trim();
  await chrome.storage.sync.set({ nickname });
  return nickname;
}

$("create").onclick = async () => {
  const nickname = await saveNick();
  setStatus("Creating party... (a sleeping free server can take up to a minute to wake)");
  const r = await contentRequest({ type: "create", nickname });
  if (r?.ok && r.inParty) showParty(r);
  else setStatus(r?.error || "Could not create party. Is the relay server running?", "err");
};

$("join").onclick = async () => {
  const nickname = await saveNick();
  const code = $("code").value.trim().toUpperCase();
  if (code.length !== 6) return setStatus("Enter the 6-character party code.", "err");
  setStatus("Joining... (a sleeping free server can take up to a minute to wake)");
  const r = await contentRequest({ type: "join", code, nickname });
  if (r?.ok && r.inParty) showParty(r);
  else setStatus(r?.error || "Could not join party.", "err");
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
  setStatus("Server saved.", "ok");
};

$("code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("join").click();
});
$("nickname").addEventListener("change", saveNick);

refresh();
