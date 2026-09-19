// WatchParty relay server.
//
// Rooms live in memory. A party code is treated as a durable room *name*, not a
// handle to a server-side object: clients reconnecting to a code they were
// already using will recreate the room if it is gone. That way a restart, a
// redeploy, or a crash costs everyone a few seconds instead of ending the party
// with "party not found".
//
// Nothing a client sends may take the process down. Every message is handled
// inside a try/catch, every value is coerced defensively, and the process-level
// guards at the bottom are the last line of defence.

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const MAX_CHAT_HISTORY = 100;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // empty rooms are dropped after 6h
const MAX_ROOMS = 5000;
const MAX_MEMBERS = 50;
const MAX_PAYLOAD = 256 * 1024;

// Token bucket per connection. Normal use is a couple of messages a second, so
// this only ever bites a runaway or hostile client.
const RATE_CAPACITY = 240;
const RATE_PER_SEC = 120;
const RATE_DROP_LIMIT = 5000;

// Optional private access key. When set, only clients that send the matching
// "secret" on create/join can use this relay.
const PARTY_SECRET = (process.env.PARTY_SECRET || "").trim();

const CODE_RE = /^[A-Z0-9]{6}$/;

/** @type {Map<string, Room>} */
const rooms = new Map();

let nextId = 1;
const stats = { created: 0, rejoinsCreated: 0, dropped: 0, errors: 0, started: Date.now() };

class Room {
  constructor(code) {
    this.code = code;
    this.clients = new Set();
    this.hostId = null;
    this.state = { paused: true, time: 0, updatedAt: Date.now(), url: null };
    this.urlUpdatedAt = 0;
    this.lastPositions = 0;
    this.chat = [];
    this.emptySince = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Defensive coercion. None of these can throw, whatever a client sends.
// ---------------------------------------------------------------------------
function safeStr(v, max = 200) {
  if (typeof v === "string") return v.length > max ? v.slice(0, max) : v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
    return String(v).slice(0, max);
  }
  return ""; // objects, symbols, null, undefined: never stringify, never throw
}

function safeNum(v) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function safeCode(v) {
  const s = safeStr(v, 16).trim().toUpperCase();
  return CODE_RE.test(s) ? s : null;
}

function safeUrl(v) {
  const s = safeStr(v, 2000).trim();
  return s ? s : null;
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------
function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  return null; // astronomically unlikely; caller reports it rather than looping
}

function send(ws, msg) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  } catch {
    /* the socket died mid-write; its close handler will clean up */
  }
}

function broadcast(room, msg, except = null) {
  let data;
  try {
    data = JSON.stringify(msg);
  } catch {
    return;
  }
  for (const c of room.clients) {
    if (c === except) continue;
    try {
      if (c.readyState === c.OPEN) c.send(data);
    } catch {
      /* skip this client, keep serving the rest */
    }
  }
}

function roster(room) {
  return [...room.clients].map((c) => ({
    id: c.id,
    name: c.name,
    isHost: c.id === room.hostId,
  }));
}

// Where each person is right now, for the sidebar's sync readout.
function positions(room) {
  return [...room.clients].map((c) => ({
    id: c.id,
    time: c.pos ? c.pos.time : null,
    paused: c.pos ? c.pos.paused : true,
    url: c.pos ? c.pos.url : null,
  }));
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  room.clients.delete(ws);
  ws.room = null;
  if (room.hostId === ws.id) {
    const next = room.clients.values().next().value;
    room.hostId = next ? next.id : null;
  }
  if (room.clients.size === 0) {
    room.emptySince = Date.now();
  } else {
    broadcast(room, { type: "system", text: `${ws.name} left the party` });
    broadcast(room, { type: "roster", users: roster(room), hostId: room.hostId });
    broadcast(room, { type: "positions", users: positions(room) });
  }
}

function checkSecret(ws, msg) {
  if (!PARTY_SECRET) return true;
  if (safeStr(msg.secret, 200) === PARTY_SECRET) return true;
  send(ws, { type: "error", code: "bad_key", text: "Wrong access key for this relay server" });
  return false;
}

function allow(ws) {
  const now = Date.now();
  const elapsed = (now - ws.rateAt) / 1000;
  ws.rateAt = now;
  ws.tokens = Math.min(RATE_CAPACITY, ws.tokens + elapsed * RATE_PER_SEC);
  if (ws.tokens < 1) {
    ws.dropped++;
    stats.dropped++;
    if (ws.dropped > RATE_DROP_LIMIT) {
      try {
        ws.close(1008, "too many messages");
      } catch {}
    }
    return false;
  }
  ws.tokens -= 1;
  return true;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  try {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          rooms: rooms.size,
          clients: wss ? wss.clients.size : 0,
          uptimeSec: Math.round((Date.now() - stats.started) / 1000),
          created: stats.created,
          recreated: stats.rejoinsCreated,
          droppedMessages: stats.dropped,
          handledErrors: stats.errors,
        })
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("WatchParty relay server is running.\n");
  } catch {
    try {
      res.writeHead(500);
      res.end();
    } catch {}
  }
});

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

wss.on("connection", (ws) => {
  ws.id = String(nextId++);
  ws.name = "Guest";
  ws.room = null;
  ws.pos = null;
  ws.isAlive = true;
  ws.tokens = RATE_CAPACITY;
  ws.rateAt = Date.now();
  ws.dropped = 0;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    // Nothing below may escape. A single bad message must never end the party
    // for everyone else on this server.
    try {
      if (!allow(ws)) return;
      let msg;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
      if (typeof msg.type !== "string") return;
      handle(ws, msg);
    } catch (e) {
      stats.errors++;
      console.error("handler error:", e && e.message ? e.message : e);
    }
  });

  ws.on("close", () => {
    try {
      leaveRoom(ws);
    } catch (e) {
      stats.errors++;
    }
  });
  ws.on("error", () => {
    try {
      leaveRoom(ws);
    } catch {}
  });
});

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
function handle(ws, msg) {
  switch (msg.type) {
    case "create": {
      if (!checkSecret(ws, msg)) return;
      if (rooms.size >= MAX_ROOMS) {
        send(ws, { type: "error", code: "busy", text: "This relay is at capacity, try again shortly" });
        return;
      }
      const code = makeCode();
      if (!code) {
        send(ws, { type: "error", code: "busy", text: "Could not allocate a party code, try again" });
        return;
      }
      leaveRoom(ws);
      const room = new Room(code);
      rooms.set(code, room);
      stats.created++;
      joinRoom(ws, room, msg);
      break;
    }

    case "join": {
      if (!checkSecret(ws, msg)) return;
      const code = safeCode(msg.code);
      if (!code) {
        send(ws, { type: "error", code: "bad_code", text: "That party code doesn't look right" });
        return;
      }
      let room = rooms.get(code);
      if (!room) {
        // Reconnects, invite links and remembered parties ask to recreate the
        // room, so a server restart doesn't strand anybody.
        if (msg.create !== true) {
          send(ws, { type: "error", code: "not_found", text: `Party ${code} not found` });
          return;
        }
        if (rooms.size >= MAX_ROOMS) {
          send(ws, { type: "error", code: "busy", text: "This relay is at capacity, try again shortly" });
          return;
        }
        room = new Room(code);
        rooms.set(code, room);
        stats.rejoinsCreated++;
      }
      if (room.clients.size >= MAX_MEMBERS && !room.clients.has(ws)) {
        send(ws, { type: "error", code: "full", text: "That party is full" });
        return;
      }
      leaveRoom(ws);
      joinRoom(ws, room, msg);
      break;
    }

    case "leave":
      leaveRoom(ws);
      break;

    case "state": {
      // play / pause / seek from a member; relay to everyone else.
      const room = ws.room;
      if (!room) return;
      const time = safeNum(msg.time);
      if (time === null) return;
      room.state = {
        paused: !!msg.paused,
        time,
        updatedAt: Date.now(),
        url: room.state.url,
      };
      broadcast(
        room,
        {
          type: "state",
          action: safeStr(msg.action, 16),
          paused: room.state.paused,
          time,
          from: ws.name,
          fromId: ws.id,
          url: safeUrl(msg.url) || undefined,
        },
        ws
      );
      break;
    }

    case "heartbeat": {
      // Host sends periodic position so others can correct drift.
      const room = ws.room;
      if (!room || room.hostId !== ws.id) return;
      const time = safeNum(msg.time);
      if (time === null) return;
      room.state = { paused: !!msg.paused, time, updatedAt: Date.now(), url: room.state.url };
      const url = safeUrl(msg.url);
      broadcast(room, { type: "heartbeat", paused: room.state.paused, time, url: url || undefined }, ws);
      // The host's heartbeat carries its page. If the host is somewhere the
      // room doesn't know about (a missed next-episode message), everyone
      // follows. A recent explicit "url" wins for 20s to avoid ping-pong.
      if (url && url !== room.state.url && Date.now() - room.urlUpdatedAt > 20000) {
        room.state.url = url;
        room.urlUpdatedAt = Date.now();
        broadcast(room, { type: "url", url, from: ws.name }, ws);
      }
      break;
    }

    case "url": {
      const room = ws.room;
      if (!room) return;
      const url = safeUrl(msg.url);
      if (!url) return;
      // Someone moved to a new video (next episode). Everyone follows, and
      // the playback position starts over for the new video.
      room.state = { paused: false, time: 0, updatedAt: Date.now(), url };
      room.urlUpdatedAt = Date.now();
      broadcast(room, { type: "url", url, from: ws.name }, ws);
      break;
    }

    case "position": {
      const room = ws.room;
      if (!room) return;
      const time = safeNum(msg.time);
      if (time === null) return;
      ws.pos = { time, paused: !!msg.paused, url: safeUrl(msg.url) };
      const now = Date.now();
      if (now - room.lastPositions > 900) {
        room.lastPositions = now;
        broadcast(room, { type: "positions", users: positions(room) });
      }
      break;
    }

    case "chat": {
      const room = ws.room;
      if (!room) return;
      const text = safeStr(msg.text, 1000).trim();
      if (!text) return;
      const entry = { type: "chat", id: ws.id, name: ws.name, text, ts: Date.now() };
      room.chat.push(entry);
      if (room.chat.length > MAX_CHAT_HISTORY) room.chat.shift();
      broadcast(room, entry);
      break;
    }

    case "typing": {
      const room = ws.room;
      if (!room) return;
      broadcast(room, { type: "typing", id: ws.id, name: ws.name, typing: !!msg.typing }, ws);
      break;
    }

    case "rename": {
      const name = safeStr(msg.name, 32).trim();
      if (!name) return;
      const old = ws.name;
      ws.name = name;
      if (ws.room) {
        broadcast(ws.room, { type: "system", text: `${old} is now ${name}` });
        broadcast(ws.room, { type: "roster", users: roster(ws.room), hostId: ws.room.hostId });
      }
      break;
    }

    case "ping":
      send(ws, { type: "pong", t: safeNum(msg.t) });
      break;
  }
}

function joinRoom(ws, room, msg) {
  ws.name = safeStr(msg.name, 32).trim() || "Guest";
  ws.room = room;
  room.clients.add(ws);
  if (!room.hostId) room.hostId = ws.id;

  const url = safeUrl(msg.url);
  if (url && !room.state.url) room.state.url = url;

  // Project the stored state forward so a late joiner lands at the right spot.
  const s = room.state;
  const projected = s.paused ? s.time : s.time + (Date.now() - s.updatedAt) / 1000;

  send(ws, {
    type: "joined",
    code: room.code,
    id: ws.id,
    hostId: room.hostId,
    users: roster(room),
    state: { paused: s.paused, time: projected, url: s.url },
    chat: room.chat,
  });
  broadcast(room, { type: "system", text: `${ws.name} joined the party` }, ws);
  broadcast(room, { type: "roster", users: roster(room), hostId: room.hostId }, ws);
  broadcast(room, { type: "positions", users: positions(room) });
}

// ---------------------------------------------------------------------------
// Keepalive and cleanup
// ---------------------------------------------------------------------------
setInterval(() => {
  try {
    for (const ws of wss.clients) {
      try {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      } catch {
        /* one bad socket must not stop the sweep */
      }
    }
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.clients.size === 0 && now - room.emptySince > ROOM_TTL_MS) rooms.delete(code);
    }
    // If we are somehow over the cap, drop the longest-empty rooms first.
    if (rooms.size > MAX_ROOMS) {
      const empties = [...rooms.values()]
        .filter((r) => r.clients.size === 0)
        .sort((a, b) => a.emptySince - b.emptySince);
      for (const r of empties) {
        if (rooms.size <= MAX_ROOMS) break;
        rooms.delete(r.code);
      }
    }
  } catch (e) {
    stats.errors++;
    console.error("sweep error:", e && e.message ? e.message : e);
  }
}, 30_000);

// ---------------------------------------------------------------------------
// Last line of defence: stay up.
// ---------------------------------------------------------------------------
process.on("uncaughtException", (e) => {
  stats.errors++;
  console.error("uncaught exception (staying up):", e && e.stack ? e.stack : e);
});
process.on("unhandledRejection", (e) => {
  stats.errors++;
  console.error("unhandled rejection (staying up):", e);
});

server.on("clientError", (err, socket) => {
  try {
    socket.destroy();
  } catch {}
});

server.listen(PORT, () => {
  console.log(`WatchParty relay listening on port ${PORT}${PARTY_SECRET ? " (access key required)" : ""}`);
});
