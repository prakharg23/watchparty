// The chat box runs in its own extension frame. Keystrokes in a separate
// document never reach the streaming site's player, which otherwise grabs them
// for its own shortcuts (space, arrows, letters) and makes typing impossible.
//
// Messages go to the content script through the extension's own channel when it
// is available, so chat text never passes through the host page. The postMessage
// path is the fallback (and what the local dev harness uses).

const box = document.getElementById("box");
const sendBtn = document.getElementById("send");

const hasRuntime = typeof chrome !== "undefined" && !!chrome.runtime?.id;

let typing = false;
let typingTimer = null;

function post(msg) {
  const payload = { wpCompose: true, ...msg };
  if (hasRuntime) {
    try {
      chrome.runtime.sendMessage(payload);
      return;
    } catch {
      /* the extension context went away; fall through */
    }
  }
  parent.postMessage(payload, "*");
}

function setTyping(on) {
  if (on === typing) return;
  typing = on;
  post({ type: "typing", typing: on });
}

function send() {
  const text = box.value.trim();
  if (!text) return;
  box.value = "";
  setTyping(false);
  post({ type: "send", text });
  box.focus();
}

box.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

box.addEventListener("input", () => {
  setTyping(box.value.length > 0);
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => setTyping(false), 1500);
});

box.addEventListener("blur", () => setTyping(false));
sendBtn.addEventListener("click", send);

window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || m.wpComposeCmd !== true) return;
  if (m.type === "focus") box.focus();
  if (m.type === "clear") box.value = "";
});

post({ type: "ready" });
