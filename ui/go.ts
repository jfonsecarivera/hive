// hive/go — the phone page: the manager in your pocket and everyone's ETA above it.
// Reuses the full ChatDock (asks, steering, interrupt, slash menu) restyled for one
// column; the board strip up top switches which session you're talking to.
import { ChatDock } from "./chat";
import { isFaded } from "./hive-model";
import { renderMarkdown } from "./markdown";
import { net } from "./net";
import type { ServerMsg, SessionSnap } from "../server/proto";

const strip = document.getElementById("go-strip")!;
const hostEl = document.getElementById("go-host")!;
const etaBody = document.getElementById("go-eta-body")!;
const etaAge = document.getElementById("go-eta-age")!;
const etaHead = document.getElementById("go-eta-head")!;

const dock = new ChatDock((o) => net.op(o));
dock.el.classList.add("go-mode");            // one-column restyle; never slides away
dock.onOpenChange = () => { /* the phone page IS the chat — closing is a no-op */ };

let target = localStorage.getItem("hive:goTarget") || "manager";
let sessions: SessionSnap[] = [];

function stateColor(s: SessionSnap): string {
  const now = Math.floor(Date.now() / 1000);
  switch (s.state) {
    case "working": return "#e0b020";
    case "awaiting": case "blocked": return "#e5484d";
    case "retrying": return "#e08020";
    case "awaitingBg": return "#54b204";
    case "compacting": case "clearing": return "#14b8a6";
    case "ready": return isFaded(s, now) ? "#3a4a5c" : "#2b7fb8";
    default: return "#d8dee8";
  }
}

function renderStrip() {
  strip.replaceChildren(...sessions.map((s) => {
    const b = document.createElement("button");
    b.className = "go-chip" + (s.name === target ? " on" : "");
    b.innerHTML = `<i style="background:${stateColor(s)}"></i>${esc(s.name)}${s.duty ? " ⛑" : ""}`;
    b.onclick = () => {
      target = s.name;
      try { localStorage.setItem("hive:goTarget", target); } catch { /* private mode */ }
      dock.open(s.sid);
      renderStrip();
    };
    return b;
  }));
}

net.on((m: ServerMsg) => {
  if (m.type === "hive") {
    sessions = m.sessions;
    renderStrip();
    dock.refresh(m.sessions);
    // follow the target by NAME: a summoned/revived bean reattaches automatically
    const t = m.sessions.find((s) => s.name === target);
    if (t && dock.sid !== t.sid) dock.open(t.sid);
  }
  if (m.type === "chat") dock.apply(m.sid, m.events, m.reset);
  if (m.type === "caps") dock.setCaps(m.sid, m.commands);
  if (m.type === "defaults") {
    hostEl.textContent = "⬡ " + m.host;
    document.title = "hive · " + m.host;
    // the target's not on the board but IS on the shelf → offer the hire right here
    const shelfHasTarget = m.shelf.some((x) => x.name === target && !x.live);
    let btn = document.getElementById("go-summon") as HTMLButtonElement | null;
    if (shelfHasTarget && !btn) {
      btn = document.createElement("button");
      btn.id = "go-summon";
      btn.textContent = `⛑ summon ${target}`;
      btn.onclick = () => { net.op({ op: "summon", name: target }); btn!.disabled = true; btn!.textContent = "summoning…"; };
      document.getElementById("go-chat-slot")!.appendChild(btn);
    } else if (!shelfHasTarget && btn) btn.remove();
  }
  if (m.type === "err") dock.apply(dock.sid || "", [], undefined);   // errors surface via chat notes server-side
});

// the ETA card: what the eta duty writes, fetched fresh on load / focus / every 30s
let etaTimer: Timer | null = null;
async function loadEta() {
  try {
    const r = await fetch("/eta", { cache: "no-store" });
    const d = await r.json();
    if (d.md) {
      etaBody.innerHTML = renderMarkdown(d.md);
      const age = Math.max(0, Math.floor(Date.now() / 1000) - d.mtime);
      etaAge.textContent = age < 90 ? "just now" : age < 3600 ? `${Math.round(age / 60)}m ago` : `${Math.round(age / 3600)}h ago`;
    } else {
      etaBody.innerHTML = '<p class="go-dim">no ETA file yet — summon <b>eta</b> from the shelf and its rounds will write one</p>';
      etaAge.textContent = "";
    }
  } catch { /* offline blip; the next tick retries */ }
}
etaHead.addEventListener("click", () => {
  const closed = etaBody.classList.toggle("closed");
  (etaHead.querySelector("i") as HTMLElement).textContent = closed ? "▸" : "▾";
  try { localStorage.setItem("hive:goEtaFold", closed ? "1" : "0"); } catch { /* private mode */ }
});
if (localStorage.getItem("hive:goEtaFold") === "1") {
  etaBody.classList.add("closed");
  (etaHead.querySelector("i") as HTMLElement).textContent = "▸";
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) loadEta(); });
etaTimer = setInterval(loadEta, 30_000);
void etaTimer;
loadEta();

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

net.connect();
