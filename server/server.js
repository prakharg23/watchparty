// WatchParty relay server.
// Rooms are in-memory. Each room stores the last known playback state so late
// joiners can sync immediately, plus a short chat history.

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const MAX_CHAT_HISTORY = 100;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000; // empty rooms are deleted after 6h
// Optional private access key. When set, only clients that send the matching
// "secret" on create/join can use this relay.
const PARTY_SECRET = (process.env.PARTY_SECRET || "").trim();

/** @type {Map<string, Room>} */
const rooms = new Map();

class Room {
  constructor(code) {
    this.code = code;
    this.clients = new Set();
    this.hostId = null;
    this.state = { paused: true, time: 0, updatedAt: Date.now(), url: null };
    this.urlUpdatedAt = 0;
    this.chat = [];
    this.emptySince = Date.now();
  }
}

function makeCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return rooms.has(code) ? makeCode() : code;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, except = null) {
  const data = JSON.stringify(msg);
  for (const c of room.clients) {
    if (c !== except && c.readyState === c.OPEN) c.send(data);
  }
}

function roster(room) {
  return [...room.clients].map((c) => ({
    id: c.id,
    name: c.name,
    isHost: c.id === room.hostId,
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
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("WatchParty relay server is running.\n");
});

const wss = new WebSocketServer({ server });
let nextId = 1;

wss.on("connection", (ws) => {
  ws.id = String(nextId++);
  ws.name = "Guest";
  ws.room = null;
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    switch (msg.type) {
      case "create": {
        if (!checkSecret(ws, msg)) return;
        leaveRoom(ws);
        const room = new Room(makeCode());
        rooms.set(room.code, room);
        joinRoom(ws, room, msg);
        break;
      }
      case "join": {
        if (!checkSecret(ws, msg)) return;
        const code = String(msg.code || "").trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: "error", text: `Party ${code} not found` });
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
        const time = Number(msg.time);
        if (!Number.isFinite(time)) return;
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
            action: msg.action,
            paused: room.state.paused,
            time,
            from: ws.name,
            fromId: ws.id,
            url: typeof msg.url === "string" ? msg.url.slice(0, 2000) : undefined,
          },
          ws
        );
        break;
      }
      case "heartbeat": {
        // Host sends periodic position so others can correct drift.
        const room = ws.room;
        if (!room || room.hostId !== ws.id) return;
        const time = Number(msg.time);
        if (!Number.isFinite(time)) return;
        room.state = { paused: !!msg.paused, time, updatedAt: Date.now(), url: room.state.url };
        broadcast(
          room,
          { type: "heartbeat", paused: room.state.paused, time, url: typeof msg.url === "string" ? msg.url.slice(0, 2000) : undefined },
          ws
        );
        // The host's heartbeat carries its page. If the host is somewhere the
        // room doesn't know about (a missed next-episode message), everyone
        // follows. A recent explicit "url" wins for 20s to avoid ping-pong.
        if (
          typeof msg.url === "string" &&
          msg.url !== room.state.url &&
          Date.now() - room.urlUpdatedAt > 20000
        ) {
          room.state.url = msg.url.slice(0, 2000);
          room.urlUpdatedAt = Date.now();
          broadcast(room, { type: "url", url: room.state.url, from: ws.name }, ws);
        }
        break;
      }
      case "url": {
        const room = ws.room;
        if (!room || typeof msg.url !== "string") return;
        // Someone moved to a new video (next episode). Everyone follows, and
        // the playback position starts over for the new video.
        room.state = { paused: false, time: 0, updatedAt: Date.now(), url: msg.url.slice(0, 2000) };
        room.urlUpdatedAt = Date.now();
        broadcast(room, { type: "url", url: room.state.url, from: ws.name }, ws);
        break;
      }
      case "chat": {
        const room = ws.room;
        if (!room) return;
        const text = String(msg.text || "").slice(0, 1000).trim();
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
        const name = String(msg.name || "").slice(0, 32).trim();
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
        send(ws, { type: "pong", t: msg.t });
        break;
    }
  });

  ws.on("close", () => leaveRoom(ws));
  ws.on("error", () => leaveRoom(ws));
});

function checkSecret(ws, msg) {
  if (!PARTY_SECRET) return true;
  if (String(msg.secret || "") === PARTY_SECRET) return true;
  send(ws, { type: "error", text: "Wrong access key for this relay server" });
  return false;
}

function joinRoom(ws, room, msg) {
  ws.name = String(msg.name || "Guest").slice(0, 32).trim() || "Guest";
  ws.room = room;
  room.clients.add(ws);
  if (!room.hostId) room.hostId = ws.id;
  if (typeof msg.url === "string" && !room.state.url) room.state.url = msg.url.slice(0, 2000);

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
}

// Keepalive + cleanup.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.clients.size === 0 && now - room.emptySince > ROOM_TTL_MS) rooms.delete(code);
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`WatchParty relay listening on port ${PORT}${PARTY_SECRET ? " (access key required)" : ""}`);
});
