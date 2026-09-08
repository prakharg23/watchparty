// WatchParty content script.
// Runs on Hulu and Plex pages. Finds the <video>, mirrors play/pause/seek to
// the relay server, applies remote events, and renders a chat sidebar.

(() => {
  if (window.__watchPartyLoaded) return;
  window.__watchPartyLoaded = true;

  const SEEK_TOLERANCE = 1.0; // seconds; ignore drift smaller than this on events
  const DRIFT_TOLERANCE = 2.0; // seconds; correct drift larger than this on heartbeats
  const HEARTBEAT_MS = 5000;
  const ECHO_SUPPRESS_MS = 800;

  const site = /hulu\.com$/.test(location.hostname) ? "hulu" : "plex";

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let ws = null;
  let serverUrl = (typeof WP_CONFIG !== "undefined" && WP_CONFIG.DEFAULT_SERVER_URL) || "ws://localhost:8080";
  let secret = (typeof WP_CONFIG !== "undefined" && WP_CONFIG.DEFAULT_SECRET) || "";
  let nickname = "";
  let party = null; // { code, id, hostId, users }
  let video = null;
  let suppressUntil = 0; // timestamp; ignore local events until then (echo prevention)
  let ignoreSeekTarget = null; // seconds; swallow the local 'seeked' that our own remote-applied seek produces
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let pendingJoin = null; // { type: 'create'|'join', code? } to send once socket opens
  let unread = 0;
  let typingTimer = null;
  let typingUsers = new Map();

  // ---------------------------------------------------------------------------
  // Video discovery
  // ---------------------------------------------------------------------------
  function findVideo() {
    const vids = [...document.querySelectorAll("video")];
    if (!vids.length) return null;
    // Prefer the largest visible video with a real duration.
    vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    return vids.find((v) => v.clientWidth > 0) || vids[0];
  }

  function attachVideo(v) {
    if (v === video) return;
    if (video) detachVideo();
    video = v;
    if (!video) return;
    video.addEventListener("play", onLocalPlay);
    video.addEventListener("pause", onLocalPause);
    video.addEventListener("seeked", onLocalSeeked);
    video.addEventListener("emptied", onVideoGone);
  }

  function detachVideo() {
    if (!video) return;
    video.removeEventListener("play", onLocalPlay);
    video.removeEventListener("pause", onLocalPause);
    video.removeEventListener("seeked", onLocalSeeked);
    video.removeEventListener("emptied", onVideoGone);
    video = null;
  }

  function onVideoGone() {
    // The player swapped media (next episode etc.). Rebind on next tick.
    setTimeout(() => attachVideo(findVideo()), 500);
  }

  const observer = new MutationObserver(() => {
    const v = findVideo();
    if (v && v !== video) attachVideo(v);
    else if (!v && video && !document.contains(video)) detachVideo();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  attachVideo(findVideo());

  // ---------------------------------------------------------------------------
  // Local -> remote
  // ---------------------------------------------------------------------------
  function suppressed() {
    return Date.now() < suppressUntil;
  }

  function sendState(action) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !party || !video) return;
    ws.send(JSON.stringify({ type: "state", action, paused: video.paused, time: video.currentTime }));
  }

  function onLocalPlay() {
    if (suppressed()) return;
    sendState("play");
  }
  function onLocalPause() {
    if (suppressed()) return;
    // Hulu fires pause right before an ad break or at the end of media; still relay it.
    sendState("pause");
  }
  function onLocalSeeked() {
    // A seek we applied from a remote event fires 'seeked' locally, sometimes
    // seconds later on DRM streams. Match it by target position, not by time.
    if (ignoreSeekTarget !== null && video && Math.abs(video.currentTime - ignoreSeekTarget) < 0.75) {
      ignoreSeekTarget = null;
      return;
    }
    ignoreSeekTarget = null;
    if (suppressed()) return;
    sendState("seek");
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN || !party || !video) return;
      if (party.hostId !== party.id) return;
      ws.send(JSON.stringify({ type: "heartbeat", paused: video.paused, time: video.currentTime }));
    }, HEARTBEAT_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // ---------------------------------------------------------------------------
  // Remote -> local
  // ---------------------------------------------------------------------------
  function applyState({ paused, time }, { tolerance = SEEK_TOLERANCE, announce = null } = {}) {
    if (!video) return;
    suppressUntil = Date.now() + ECHO_SUPPRESS_MS;
    if (Number.isFinite(time) && Math.abs(video.currentTime - time) > tolerance) {
      ignoreSeekTarget = time;
      video.currentTime = time;
    }
    if (paused && !video.paused) {
      video.pause();
    } else if (!paused && video.paused) {
      const p = video.play();
      if (p && p.catch) {
        p.catch(() => {
          toast("Click the video once to allow autoplay, then you'll stay in sync.");
        });
      }
    }
    if (announce) sysMessage(announce, true);
  }

  function fmt(t) {
    t = Math.max(0, Math.floor(t || 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
  }

  // ---------------------------------------------------------------------------
  // WebSocket
  // ---------------------------------------------------------------------------
  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try {
      ws = new WebSocket(serverUrl);
    } catch (e) {
      setConn(false, "Bad server URL");
      return;
    }
    setConn(false, "Connecting...");

    ws.onopen = () => {
      setConn(true, "Connected");
      if (pendingJoin) {
        ws.send(JSON.stringify({ ...pendingJoin, name: nickname || "Guest", url: location.href, secret }));
        pendingJoin = null;
      } else if (party) {
        // Reconnect into the same room.
        ws.send(JSON.stringify({ type: "join", code: party.code, name: nickname || "Guest", url: location.href, secret }));
      }
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleMessage(msg);
    };

    ws.onclose = () => {
      setConn(false, "Disconnected");
      stopHeartbeat();
      if (party || pendingJoin) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, pendingJoin ? 3000 : 2000);
      }
    };
    ws.onerror = () => {
      setConn(false, "Can't reach server");
    };
  }

  function disconnect() {
    clearTimeout(reconnectTimer);
    stopHeartbeat();
    pendingJoin = null;
    if (ws) {
      try {
        ws.send(JSON.stringify({ type: "leave" }));
      } catch {}
      ws.onclose = null;
      ws.close();
    }
    ws = null;
    party = null;
    unread = 0;
    typingUsers.clear();
    renderRoot();
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "joined": {
        party = { code: msg.code, id: msg.id, hostId: msg.hostId, users: msg.users };
        history.replaceState(null, "", withPartyHash(location.href, msg.code));
        renderRoot();
        setConn(true, "Connected");
        clearMessages();
        for (const c of msg.chat || []) chatMessage(c);
        sysMessage(`You joined party ${msg.code}`);
        if (msg.state && msg.users.length > 1) {
          // Someone else is already here: snap to their position.
          applyState(msg.state, { announce: `Synced to ${fmt(msg.state.time)}` });
        }
        startHeartbeat();
        pendingResolve?.({ ok: true });
        pendingResolve = null;
        break;
      }
      case "error":
        sysMessage(msg.text);
        toast(msg.text);
        pendingResolve?.({ ok: false, error: msg.text });
        pendingResolve = null;
        pendingJoin = null;
        break;
      case "roster":
        if (party) {
          party.users = msg.users;
          party.hostId = msg.hostId;
          renderUsers();
        }
        break;
      case "system":
        sysMessage(msg.text);
        break;
      case "state": {
        const label =
          msg.action === "play"
            ? `${msg.from} played at ${fmt(msg.time)}`
            : msg.action === "pause"
            ? `${msg.from} paused at ${fmt(msg.time)}`
            : `${msg.from} jumped to ${fmt(msg.time)}`;
        applyState(msg, { announce: label });
        break;
      }
      case "heartbeat":
        if (party && party.hostId !== party.id) {
          applyState(msg, { tolerance: DRIFT_TOLERANCE });
        }
        break;
      case "url":
        sysMessage(`${msg.from} is now watching a different video.`);
        break;
      case "chat":
        chatMessage(msg);
        if (msg.id !== party?.id) {
          if (collapsed) {
            unread++;
            renderBadge();
          }
        }
        break;
      case "typing":
        if (msg.typing) typingUsers.set(msg.id, msg.name);
        else typingUsers.delete(msg.id);
        renderTyping();
        break;
    }
  }

  function withPartyHash(url, code) {
    const u = new URL(url);
    if (!code) {
      u.hash = "";
      return u.toString();
    }
    // The invite link carries the relay address and access key so friends
    // never have to configure anything.
    const params = new URLSearchParams();
    params.set("wp", code);
    params.set("s", serverUrl);
    if (secret) params.set("k", secret);
    u.hash = params.toString();
    return u.toString();
  }

  // ---------------------------------------------------------------------------
  // Popup / background messaging
  // ---------------------------------------------------------------------------
  let pendingResolve = null;

  function statusPayload() {
    return {
      ok: true,
      site,
      hasVideo: !!video,
      inParty: !!party,
      code: party?.code || null,
      users: party?.users?.length || 0,
      inviteUrl: party ? withPartyHash(location.href, party.code) : null,
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      switch (msg?.type) {
        case "status":
          return sendResponse(statusPayload());
        case "create":
        case "join": {
          if (!video) {
            return sendResponse({ ok: false, error: "No video on this page. Start playing something first." });
          }
          await loadSettings();
          if (msg.nickname) nickname = msg.nickname;
          const result = await startParty(msg.type, msg.code);
          if (!result.ok) return sendResponse(result);
          return sendResponse(statusPayload());
        }
        case "leave":
          disconnect();
          history.replaceState(null, "", withPartyHash(location.href, null));
          return sendResponse({ ok: true });
        default:
          return sendResponse(statusPayload());
      }
    })();
    return true;
  });

  function startParty(kind, code) {
    return new Promise((resolve) => {
      pendingResolve = resolve;
      pendingJoin = kind === "create" ? { type: "create" } : { type: "join", code };
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ ...pendingJoin, name: nickname || "Guest", url: location.href, secret }));
        pendingJoin = null;
      } else {
        connect();
      }
      setTimeout(() => {
        if (pendingResolve === resolve) {
          pendingResolve = null;
          pendingJoin = null;
          resolve({ ok: false, error: `Could not reach relay server at ${serverUrl}. Is it running?` });
        }
      }, 90000);
    });
  }

  async function loadSettings() {
    const s = await chrome.storage.sync.get(["serverUrl", "nickname", "secret"]);
    if (s.serverUrl) serverUrl = s.serverUrl;
    if (s.secret !== undefined) secret = s.secret;
    if (s.nickname) nickname = s.nickname;
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  let root, toggle, messagesEl, usersEl, statusEl, typingEl, inputEl, badgeEl;
  let collapsed = false;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function buildUI() {
    if (root) return;
    root = el("div");
    root.id = "wp-root";
    root.className = "wp-collapsed";
    toggle = el("button");
    toggle.id = "wp-toggle";
    toggle.className = "wp-collapsed";
    toggle.title = "WatchParty chat";
    toggle.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12z"/></svg>';
    badgeEl = el("span", "wp-badge");
    toggle.appendChild(badgeEl);
    toggle.onclick = () => setCollapsed(!collapsed);
    collapsed = true;
    document.documentElement.appendChild(root);
    document.documentElement.appendChild(toggle);
    renderRoot();
  }

  function setCollapsed(c) {
    collapsed = c;
    root.classList.toggle("wp-collapsed", c);
    toggle.classList.toggle("wp-collapsed", c);
    if (!c) {
      unread = 0;
      renderBadge();
      setTimeout(() => inputEl?.focus(), 250);
    }
  }

  function renderBadge() {
    if (!badgeEl) return;
    badgeEl.textContent = unread > 99 ? "99+" : String(unread);
    badgeEl.classList.toggle("wp-show", unread > 0);
  }

  function renderRoot() {
    if (!root) return;
    root.textContent = "";
    if (!party) {
      const empty = el("div", "wp-empty");
      empty.appendChild(el("div", "", "\u{1F37F}"));
      const b = el("div");
      b.innerHTML = "<b>Not in a party</b>";
      empty.appendChild(b);
      empty.appendChild(el("div", "", "Click the WatchParty icon in your toolbar to start or join a party."));
      root.appendChild(empty);
      toggle.style.display = "none";
      return;
    }
    toggle.style.display = "";

    const header = el("div", "wp-header");
    const title = el("div", "wp-title");
    title.appendChild(el("span", "wp-dot"));
    title.appendChild(document.createTextNode("WatchParty"));
    header.appendChild(title);
    const code = el("span", "wp-code", party.code);
    code.title = "Click to copy invite link";
    code.onclick = async () => {
      try {
        await navigator.clipboard.writeText(withPartyHash(location.href, party.code));
        toast("Invite link copied");
      } catch {
        toast("Party code: " + party.code);
      }
    };
    header.appendChild(code);
    root.appendChild(header);

    statusEl = el("div", "wp-status");
    statusEl.appendChild(el("span", "wp-conn", "Connected"));
    const leave = el("a", "", "Leave");
    leave.href = "#";
    leave.style.color = "var(--wp-muted)";
    leave.onclick = (e) => {
      e.preventDefault();
      disconnect();
      history.replaceState(null, "", withPartyHash(location.href, null));
    };
    statusEl.appendChild(leave);
    root.appendChild(statusEl);
    setConn(ws?.readyState === WebSocket.OPEN, ws?.readyState === WebSocket.OPEN ? "Connected" : "Connecting...");

    usersEl = el("div", "wp-users");
    root.appendChild(usersEl);
    renderUsers();

    messagesEl = el("div", "wp-messages");
    root.appendChild(messagesEl);

    typingEl = el("div", "wp-typing");
    root.appendChild(typingEl);

    const compose = el("div", "wp-compose");
    inputEl = document.createElement("textarea");
    inputEl.placeholder = "Say something...";
    inputEl.rows = 1;
    inputEl.addEventListener("keydown", (e) => {
      e.stopPropagation(); // keep Hulu/Plex hotkeys (space, arrows) from firing while typing
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });
    inputEl.addEventListener("keyup", (e) => e.stopPropagation());
    inputEl.addEventListener("keypress", (e) => e.stopPropagation());
    inputEl.addEventListener("input", () => {
      sendTyping(true);
      clearTimeout(typingTimer);
      typingTimer = setTimeout(() => sendTyping(false), 1500);
    });
    const send = el("button", "", "➤");
    send.title = "Send";
    send.onclick = sendChat;
    compose.appendChild(inputEl);
    compose.appendChild(send);
    root.appendChild(compose);
  }

  function renderUsers() {
    if (!usersEl || !party) return;
    usersEl.textContent = "";
    for (const u of party.users || []) {
      const chip = el("span", "wp-user" + (u.id === party.hostId ? " wp-host" : ""), u.id === party.id ? `${u.name} (you)` : u.name);
      if (u.id === party.hostId) chip.title = "Host (keeps everyone in sync)";
      usersEl.appendChild(chip);
    }
  }

  function setConn(online, text) {
    if (!statusEl) return;
    statusEl.classList.toggle("wp-online", online);
    const conn = statusEl.querySelector(".wp-conn");
    if (conn) conn.textContent = text;
  }

  function renderTyping() {
    if (!typingEl) return;
    const names = [...typingUsers.values()];
    typingEl.textContent = names.length
      ? names.length === 1
        ? `${names[0]} is typing...`
        : `${names.slice(0, 2).join(", ")}${names.length > 2 ? " and others" : ""} are typing...`
      : "";
  }

  function clearMessages() {
    if (messagesEl) messagesEl.textContent = "";
  }

  function scrollBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function chatMessage(m) {
    if (!messagesEl) return;
    const mine = m.id === party?.id;
    const wrap = el("div", "wp-msg" + (mine ? " wp-mine" : ""));
    if (!mine) wrap.appendChild(el("div", "wp-name", m.name));
    wrap.appendChild(el("div", "wp-bubble", m.text));
    messagesEl.appendChild(wrap);
    scrollBottom();
  }

  function sysMessage(text, isEvent = false) {
    if (!messagesEl) return;
    messagesEl.appendChild(el("div", "wp-sys" + (isEvent ? " wp-event" : ""), text));
    scrollBottom();
  }

  function sendChat() {
    const text = inputEl.value.trim();
    if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "chat", text }));
    inputEl.value = "";
    sendTyping(false);
  }

  function sendTyping(typing) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "typing", typing }));
  }

  let toastEl = null;
  function toast(text) {
    if (toastEl) toastEl.remove();
    toastEl = el("div", "wp-toast", text);
    document.documentElement.appendChild(toastEl);
    setTimeout(() => toastEl?.remove(), 2600);
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function boot() {
    // Only build UI in the top frame (the sidebar should not appear inside iframes).
    if (window.top === window) buildUI();
    await loadSettings();

    // Auto-join from an invite link: https://...#wp=ABC123&s=wss://relay&k=key
    const hashParams = new URLSearchParams(location.hash.replace(/^#/, ""));
    const m = (hashParams.get("wp") || "").match(/^[A-Z0-9]{6}$/i);
    if (m && window.top === window) {
      const code = m[0].toUpperCase();
      const patch = {};
      const linkServer = hashParams.get("s");
      if (linkServer && /^wss?:\/\//.test(linkServer)) {
        serverUrl = linkServer;
        patch.serverUrl = linkServer;
      }
      if (hashParams.has("k")) {
        secret = hashParams.get("k");
        patch.secret = secret;
      }
      if (Object.keys(patch).length) chrome.storage.sync.set(patch);
      const waitForVideo = () =>
        new Promise((resolve) => {
          const started = Date.now();
          const t = setInterval(() => {
            if (video || Date.now() - started > 60000) {
              clearInterval(t);
              resolve();
            }
          }, 500);
        });
      await waitForVideo();
      if (!nickname) {
        const n = prompt("WatchParty: what's your name?", "Guest");
        if (n) {
          nickname = n.trim().slice(0, 32);
          chrome.storage.sync.set({ nickname });
        }
      }
      const r = await startParty("join", code);
      if (r.ok) setCollapsed(false);
    }
  }

  // Keep the settings fresh if changed from the popup.
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.serverUrl) serverUrl = changes.serverUrl.newValue;
    if (changes.secret) secret = changes.secret.newValue || "";
    if (changes.nickname) {
      nickname = changes.nickname.newValue;
      if (ws && ws.readyState === WebSocket.OPEN && party) ws.send(JSON.stringify({ type: "rename", name: nickname }));
    }
  });

  boot();
})();
