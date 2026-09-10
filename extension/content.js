// WatchParty content script.
// Runs on Hulu and Plex pages. Finds the <video>, mirrors play/pause/seek to
// the relay server, applies remote events, follows the party to the next
// episode, and renders a chat sidebar.

(() => {
  if (window.__watchPartyLoaded) return;
  window.__watchPartyLoaded = true;

  const SEEK_TOLERANCE = 1.0; // seconds; ignore drift smaller than this on events
  const DRIFT_TOLERANCE = 2.0; // seconds; correct drift larger than this on heartbeats
  const HEARTBEAT_MS = 5000;
  const ECHO_SUPPRESS_MS = 800;
  const URL_POLL_MS = 1000;
  const PARTY_MEMORY_MS = 12 * 60 * 60 * 1000; // rejoin a remembered party for up to 12h
  const FOLLOW_QUIET_MS = 15000; // after following someone, don't rebroadcast our URL for a while

  const site = /hulu\.com$/.test(location.hostname) ? "hulu" : "plex";
  const isTop = window.top === window;

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let ws = null;
  let serverUrl = (typeof WP_CONFIG !== "undefined" && WP_CONFIG.DEFAULT_SERVER_URL) || "ws://localhost:8080";
  let secret = (typeof WP_CONFIG !== "undefined" && WP_CONFIG.DEFAULT_SECRET) || "";
  let nickname = "";
  let party = null; // { code, id, hostId, users }
  let video = null;
  let suppressUntil = 0; // timestamp; ignore local play/pause until then (echo prevention)
  let ignoreSeekTarget = null; // seconds; swallow the local 'seeked' our own remote-applied seek produces
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let pendingJoin = null; // { type: 'create'|'join', code? } to send once socket opens
  let pendingResolve = null;
  let pendingError = null; // last create/join failure, surfaced to the popup
  let unread = 0;
  let typingTimer = null;
  let typingUsers = new Map();
  let tabId = null;
  let lastPageKey = null;
  let followQuietUntil = 0;
  let navigatingTo = null;

  // ---------------------------------------------------------------------------
  // URL helpers
  // ---------------------------------------------------------------------------
  const PARTY_PARAMS = ["wp", "s", "k"];

  // The page URL without our own party parameters.
  function cleanUrl(href) {
    const u = new URL(href);
    for (const p of PARTY_PARAMS) u.searchParams.delete(p);
    // Old-style links carried the party in the hash.
    if (/^#?wp=/.test(u.hash)) u.hash = "";
    return u.toString();
  }

  // What counts as "the same page". Hulu routes by path. Plex routes inside the
  // hash, so the hash is part of the identity there.
  function pageKey(href) {
    const u = new URL(cleanUrl(href));
    return site === "hulu" ? u.origin + u.pathname : u.origin + u.pathname + u.hash;
  }

  // Invite link: the current page plus the party code, relay address, and key
  // in the query string, so friends never have to configure anything.
  function inviteLink(code) {
    const u = new URL(cleanUrl(location.href));
    u.searchParams.set("wp", code);
    u.searchParams.set("s", serverUrl);
    if (secret) u.searchParams.set("k", secret);
    return u.toString();
  }

  function partyFromUrl() {
    const search = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
    const src = search.has("wp") ? search : hash.has("wp") ? hash : null;
    if (!src) return null;
    const code = (src.get("wp") || "").toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return null;
    return { code, server: src.get("s"), key: src.has("k") ? src.get("k") : null };
  }

  // ---------------------------------------------------------------------------
  // Party memory (survives next-episode navigation and reloads in this tab)
  // ---------------------------------------------------------------------------
  async function getTabId() {
    if (tabId !== null) return tabId;
    try {
      const r = await chrome.runtime.sendMessage({ type: "tabId" });
      tabId = r?.tabId ?? null;
    } catch {
      tabId = null;
    }
    return tabId;
  }

  async function rememberParty(code) {
    const id = await getTabId();
    if (id === null) return;
    const key = "party:" + id;
    const existing = (await chrome.storage.local.get(key))[key];
    await chrome.storage.local.set({
      [key]: {
        code,
        serverUrl,
        secret,
        at: Date.now(),
        followedAt: navigatingTo ? Date.now() : existing?.followedAt || 0,
      },
    });
  }

  async function forgetParty() {
    const id = await getTabId();
    if (id === null) return;
    await chrome.storage.local.remove("party:" + id);
  }

  async function rememberedParty() {
    const id = await getTabId();
    if (id === null) return null;
    const r = await chrome.storage.local.get("party:" + id);
    const p = r["party:" + id];
    if (!p || Date.now() - p.at > PARTY_MEMORY_MS) return null;
    return p;
  }

  // ---------------------------------------------------------------------------
  // Video discovery
  // ---------------------------------------------------------------------------
  function findVideo() {
    const vids = [...document.querySelectorAll("video")];
    if (!vids.length) return null;
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
    setTimeout(() => attachVideo(findVideo()), 500);
  }

  const observer = new MutationObserver(() => {
    const v = findVideo();
    if (v && v !== video) attachVideo(v);
    else if (!v && video && !document.contains(video)) detachVideo();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  attachVideo(findVideo());

  function waitForVideo(ms) {
    return new Promise((resolve) => {
      const started = Date.now();
      const t = setInterval(() => {
        if (!video) attachVideo(findVideo());
        if (video || Date.now() - started > ms) {
          clearInterval(t);
          resolve(!!video);
        }
      }, 500);
    });
  }

  // ---------------------------------------------------------------------------
  // Local -> remote
  // ---------------------------------------------------------------------------
  function suppressed() {
    return Date.now() < suppressUntil;
  }

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function sendState(action) {
    if (!party || !video) return;
    wsSend({ type: "state", action, paused: video.paused, time: video.currentTime, url: cleanUrl(location.href) });
  }

  // True when a sync message is about a different video than the one on
  // screen. Applying it would pause or seek the wrong episode.
  function otherPage(msg) {
    return typeof msg.url === "string" && pageKey(msg.url) !== pageKey(location.href);
  }

  function atEnd() {
    if (!video) return false;
    if (video.ended) return true;
    return Number.isFinite(video.duration) && video.duration > 0 && video.currentTime >= video.duration - 0.5;
  }

  function onLocalPlay() {
    if (suppressed()) return;
    sendState("play");
  }
  function onLocalPause() {
    if (suppressed()) return;
    if (navigatingTo) return; // the old episode pausing as we leave it is not a user action
    if (atEnd()) return; // episode finished on its own; not a user pause
    sendState("pause");
  }
  function onLocalSeeked() {
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
      if (!party || !video || party.hostId !== party.id || navigatingTo) return;
      wsSend({ type: "heartbeat", paused: video.paused, time: video.currentTime, url: cleanUrl(location.href) });
    }, HEARTBEAT_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // Watch for in-page navigation (Hulu autoplaying the next episode, clicking
  // another title, Plex changing its hash route) and tell the party.
  setInterval(async () => {
    if (!isTop) return;
    const key = pageKey(location.href);
    if (lastPageKey === null) {
      lastPageKey = key;
      return;
    }
    if (key === lastPageKey) return;
    lastPageKey = key;
    if (!party || navigatingTo || Date.now() < followQuietUntil) return;
    // Only drag the party along if the new page is (or becomes) a video page.
    // Hulu watch pages are obvious from the path; elsewhere wait for a player,
    // generously, since ads and spinners can delay it.
    const isWatchPage = site === "hulu" && /^\/watch\//.test(location.pathname);
    const hasVideo = isWatchPage || (await waitForVideo(30000));
    if (!hasVideo || !party || pageKey(location.href) !== key) return;
    wsSend({ type: "url", url: cleanUrl(location.href) });
    sysMessage("You moved to a new video. Everyone is following.", true);
  }, URL_POLL_MS);

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
        p.catch(() => toast("Click the video once to allow autoplay, then you'll stay in sync."));
      }
    }
    if (announce) sysMessage(announce, true);
  }

  function followTo(url, who) {
    if (navigatingTo) return;
    if (pageKey(url) === pageKey(location.href)) return;
    navigatingTo = url;
    toast(`Following ${who} to the next video...`);
    sysMessage(`Following ${who}...`, true);
    // The party is remembered per tab, so the new page rejoins on its own.
    rememberParty(party.code).finally(() => {
      location.assign(url);
    });
    setTimeout(() => {
      if (navigatingTo !== url) return;
      if (pageKey(location.href) === pageKey(url)) {
        navigatingTo = null;
        return;
      }
      location.assign(url);
      setTimeout(() => {
        if (navigatingTo === url) navigatingTo = null;
      }, 10000);
    }, 10000);
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
  document.addEventListener("securitypolicyviolation", (e) => {
    try {
      if (!/connect-src|default-src/.test(e.violatedDirective || "")) return;
      if (!e.blockedURI || !serverUrl.includes(new URL(e.blockedURI).host)) return;
      failPending(`This page's security policy blocked the connection to ${serverUrl}.`);
    } catch {
      /* blockedURI wasn't a URL */
    }
  });

  function failPending(text) {
    pendingError = text;
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      pendingJoin = null;
      r({ ok: false, error: text });
    }
    clearTimeout(reconnectTimer);
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {}
      ws = null;
    }
    setConn(false, "Failed");
  }

  function joinPayload(base) {
    return { ...base, name: nickname || "Guest", url: cleanUrl(location.href), secret };
  }

  function connect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try {
      ws = new WebSocket(serverUrl);
    } catch {
      setConn(false, "Bad server URL");
      return;
    }
    setConn(false, "Connecting...");

    ws.onopen = () => {
      setConn(true, "Connected");
      if (pendingJoin) {
        ws.send(JSON.stringify(joinPayload(pendingJoin)));
        pendingJoin = null;
      } else if (party) {
        ws.send(JSON.stringify(joinPayload({ type: "join", code: party.code })));
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
    ws.onerror = () => setConn(false, "Can't reach server");
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
    forgetParty();
    renderRoot();
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "joined": {
        const rejoined = !!party && party.code === msg.code;
        party = { code: msg.code, id: msg.id, hostId: msg.hostId, users: msg.users };
        rememberParty(msg.code);
        renderRoot();
        setConn(true, "Connected");
        if (!rejoined) {
          clearMessages();
          for (const c of msg.chat || []) chatMessage(c);
          sysMessage(`You joined party ${msg.code}`);
        }
        const others = msg.users.length > 1;
        if (others && msg.state?.url && party.hostId !== party.id && pageKey(msg.state.url) !== pageKey(location.href)) {
          // The party is on a different video than we are. Go there.
          followTo(msg.state.url, "the party");
        } else if (others && msg.state && video && !otherPage(msg.state)) {
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
        pendingError = msg.text;
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
        if (navigatingTo || otherPage(msg)) break;
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
        if (party && party.hostId !== party.id && !navigatingTo && !otherPage(msg)) {
          applyState(msg, { tolerance: DRIFT_TOLERANCE });
        }
        break;
      case "url":
        if (typeof msg.url === "string") followTo(msg.url, msg.from || "the party");
        break;
      case "chat":
        chatMessage(msg);
        if (msg.id !== party?.id && collapsed) {
          unread++;
          renderBadge();
        }
        break;
      case "typing":
        if (msg.typing) typingUsers.set(msg.id, msg.name);
        else typingUsers.delete(msg.id);
        renderTyping();
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Popup messaging
  // ---------------------------------------------------------------------------
  function statusPayload() {
    return {
      ok: true,
      site,
      hasVideo: !!video,
      inParty: !!party,
      code: party?.code || null,
      users: party?.users?.length || 0,
      inviteUrl: party ? inviteLink(party.code) : null,
      pendingError,
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
          return sendResponse({ ok: true });
        default:
          return sendResponse(statusPayload());
      }
    })();
    return true;
  });

  function startParty(kind, code) {
    return new Promise((resolve) => {
      pendingError = null;
      pendingResolve = resolve;
      pendingJoin = kind === "create" ? { type: "create" } : { type: "join", code };
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(joinPayload(pendingJoin)));
        pendingJoin = null;
      } else {
        connect();
      }
      setTimeout(() => {
        if (pendingResolve === resolve) {
          pendingResolve = null;
          pendingJoin = null;
          pendingError = `Could not reach relay server at ${serverUrl}. Is it running?`;
          resolve({ ok: false, error: pendingError });
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
  let collapsed = true;

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
        await navigator.clipboard.writeText(inviteLink(party.code));
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
    };
    statusEl.appendChild(leave);
    root.appendChild(statusEl);
    const open = ws?.readyState === WebSocket.OPEN;
    setConn(open, open ? "Connected" : "Connecting...");

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
      const chip = el(
        "span",
        "wp-user" + (u.id === party.hostId ? " wp-host" : ""),
        u.id === party.id ? `${u.name} (you)` : u.name
      );
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
    if (!text) return;
    wsSend({ type: "chat", text });
    inputEl.value = "";
    sendTyping(false);
  }

  function sendTyping(typing) {
    wsSend({ type: "typing", typing });
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
    if (!isTop) return; // only the top frame runs the party; iframes stay quiet
    buildUI();
    await loadSettings();
    lastPageKey = pageKey(location.href);

    // 1. Invite link: ?wp=CODE&s=wss://relay&k=key (old links used the hash).
    const fromUrl = partyFromUrl();
    // 2. Otherwise a party this tab was already in (next episode, reload).
    const remembered = fromUrl ? null : await rememberedParty();
    if (!fromUrl && !remembered) return;

    let code;
    if (fromUrl) {
      code = fromUrl.code;
      const patch = {};
      if (fromUrl.server && /^wss?:\/\//.test(fromUrl.server)) {
        serverUrl = fromUrl.server;
        patch.serverUrl = serverUrl;
      }
      if (fromUrl.key !== null) {
        secret = fromUrl.key;
        patch.secret = secret;
      }
      if (Object.keys(patch).length) chrome.storage.sync.set(patch);
      // Tidy the address bar so the party parameters don't get shared by accident.
      try {
        history.replaceState(null, "", cleanUrl(location.href));
      } catch {}
    } else {
      code = remembered.code;
      serverUrl = remembered.serverUrl || serverUrl;
      secret = remembered.secret ?? secret;
      if (remembered.followedAt && Date.now() - remembered.followedAt < FOLLOW_QUIET_MS) {
        followQuietUntil = Date.now() + FOLLOW_QUIET_MS;
      }
    }

    const hasVideo = await waitForVideo(60000);
    if (!hasVideo) return;
    if (!nickname) {
      const n = prompt("WatchParty: what's your name?", "Guest");
      if (n) {
        nickname = n.trim().slice(0, 32);
        chrome.storage.sync.set({ nickname });
      }
    }
    const r = await startParty("join", code);
    if (r.ok) setCollapsed(false);
    else if (remembered) forgetParty();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.serverUrl) serverUrl = changes.serverUrl.newValue;
    if (changes.secret) secret = changes.secret.newValue || "";
    if (changes.nickname) {
      nickname = changes.nickname.newValue;
      if (party) wsSend({ type: "rename", name: nickname });
    }
  });

  boot();
})();
