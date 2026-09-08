# WatchParty for Hulu & Plex

Watch Hulu and Plex in sync with friends, Teleparty-style. Play, pause, and seek are
mirrored to everyone in the party, and a chat sidebar sits next to the video.

It has two pieces:

- **Relay server** (`server/`): a tiny Node.js WebSocket server that hosts parties.
  You run one copy. It is locked with an access key so only your friends can use it.
- **Chrome extension** (`extension/`): everyone installs this. It syncs the player
  and shows the chat.

Everyone still needs their own Hulu / Plex login. The extension only shares
playback position and chat, never video or passwords.

---

## Setup (you, once)

### 1. Put the relay server online

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/prakharg23/watchparty)

1. Click the button above and sign in to Render with GitHub (free, no card needed).
2. Accept the defaults and click **Apply**. Render builds the server and generates a
   random access key (`PARTY_SECRET`) for you.
3. When it finishes, open the service. Copy two things:
   - the URL at the top, e.g. `https://watchparty-relay.onrender.com`
   - the **Environment** tab -> `PARTY_SECRET` value

That's it for hosting. The free plan sleeps after 15 idle minutes and takes about a
minute to wake up on the first connection. The extension waits for it.

Want it on your own domain? In Render, open **Settings -> Custom Domains**, add
something like `party.yourdomain.com`, and create the CNAME it shows you at your
DNS provider. Then use `wss://party.yourdomain.com` below.

### 2. Install the extension

1. Download **watchparty-extension.zip** from the
   [latest release](https://github.com/prakharg23/watchparty/releases/latest) and unzip it.
2. In Chrome open `chrome://extensions`, turn on **Developer mode** (top right),
   click **Load unpacked**, and pick the unzipped folder.
3. Pin the WatchParty icon to your toolbar.

### 3. Point the extension at your server

Click the WatchParty icon, open **Server settings**, and enter:

- Relay server URL: your Render URL with `wss://` instead of `https://`,
  e.g. `wss://watchparty-relay.onrender.com`
- Access key: the `PARTY_SECRET` value

Click **Save**. Only you do this. Invite links carry the server and key to friends.

---

## Watching together

1. Open a video on **hulu.com** or **app.plex.tv** and start playing it.
2. Click the WatchParty icon, type your name, click **Start a party**.
3. Click **Copy invite link** and send it to your friends.

Your friends:

1. Install the extension (step 2 above). One time only.
2. Click your invite link. It opens the same video, asks for a name, and joins the
   party. Their player jumps to where you are.

Anyone can play, pause, or seek and everyone follows. The chat slides out from the
right edge. The starred person is the host and keeps everyone aligned with a
position heartbeat every 5 seconds.

---

## Good to know

- **Hulu ads** are inserted per account and are not synced. Everyone re-aligns on the
  next play, pause, seek, or heartbeat.
- **Plex** works with app.plex.tv, `*.plex.direct`, and `localhost:32400`. Friends
  need access to the same library item so the invite link opens for them.
- **Autoplay**: if the browser blocks a remote play, you'll see a toast. Click the
  video once and you'll re-sync on the next event.
- **Privacy**: the relay refuses anyone without the access key. To rotate it, change
  `PARTY_SECRET` in Render, then update it in your extension settings and send new
  invite links.

## Run the server yourself instead

```bash
cd server
npm install
PARTY_SECRET=pick-something-long npm start
```

It listens on port 8080 (set `PORT` to change). A `Dockerfile` is included for
any container host. Set the same `PARTY_SECRET` and use `wss://` behind TLS.

## Dev harness

`test/harness.html` stands in for a Hulu / Plex page so you can test sync without an
account. It shims the `chrome.*` API, generates a local 20-second test clip, and
loads the real `extension/content.js`. Serve the repo root with any static server
(for example `python -m http.server 8422`), open the harness in two tabs, create a
party in one and join from the other. Rebuild icons with `node make-icons.mjs`.
