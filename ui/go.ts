// hive/go — the pocket board (eta-dash's shape): the ETA board IS the page, the
// session strip switches focus, and chat is a full-screen slide-over you enter by
// tapping a session (or the manager button) and leave with ✕. The full ChatDock
// powers the chat — asks, steering, interrupt, /loop — restyled to one column.
import { ChatDock } from "./chat";
import { agoText, cdText, effectiveStatus, rankEtas, STATUS_WORD, type EtaView } from "./eta-model";
import { isFaded } from "./hive-model";
import { net } from "./net";
import type { EtaRow, ServerMsg, SessionSnap, ShelfItem } from "../server/proto";

const strip = document.getElementById("go-strip")!;
const hostEl = document.getElementById("go-host")!;
const metaEl = document.getElementById("go-meta")!;
const mgrBtn = document.getElementById("go-mgr") as HTMLButtonElement;
const board = document.getElementById("go-board")!;
const etaBody = document.getElementById("go-eta-body")!;
const chatOverlay = document.getElementById("go-chat")!;

const dock = new ChatDock((o) => net.op(o));
document.getElementById("go-chat-slot")!.appendChild(dock.el);
dock.el.classList.add("go-mode");
// the dock's own ✕ is the way back to the board
dock.onOpenChange = (open) => { chatOverlay.hidden = !open; };

let sessions: SessionSnap[] = [];
let etaRows: EtaRow[] = [];
let shelf: ShelfItem[] = [];

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

function openChatFor(name: string) {
  const s = sessions.find((x) => x.name === name);
  if (!s) return;
  dock.open(s.sid);
  renderStrip();
}

mgrBtn.addEventListener("click", () => {
  if (sessions.some((s) => s.name === "manager")) openChatFor("manager");
  else if (shelf.some((x) => x.name === "manager" && !x.live)) {
    net.op({ op: "summon", name: "manager" });
    mgrBtn.textContent = "summoning…";
  }
});

function renderStrip() {
  strip.replaceChildren(...sessions.map((s) => {
    const b = document.createElement("button");
    b.className = "go-chip" + (dock.sid === s.sid && !chatOverlay.hidden ? " on" : "");
    b.innerHTML = `<i style="background:${stateColor(s)}"></i>${esc(s.name)}${s.duty ? " ⛑" : ""}`;
    b.onclick = () => openChatFor(s.name);
    return b;
  }));
}

// ── the ETA board (the page itself): ranked rows, live countdowns, honest dots ──
const openRows = new Set<string>(JSON.parse(localStorage.getItem("hive:goEtaOpen") || "[]"));
const rowEls = new Map<string, HTMLElement>();

function statusDot(v: EtaView): string {
  if (v.offline) return "#ec835a";
  switch (v.status || "pending") {
    case "working": return v.live ? stateColor(v.live) : "#0ca30c";
    case "done": return "#0ca30c";
    case "blocked": return "#d03b3b";
    default: return "#898781";
  }
}

function renderEtas() {
  const views = rankEtas(etaRows, sessions);
  const now = Date.now();
  metaEl.textContent = views.length ? `${views.length} tracked` : "";
  if (!views.length) {
    rowEls.clear();
    const canSummon = shelf.some((x) => x.name === "eta" && !x.live);
    etaBody.innerHTML = '<div class="go-empty"><b>nothing tracked yet</b>' +
      '<span>the ⛑ eta agent writes this board as it watches everyone</span>' +
      (canSummon ? '<button id="go-summon-eta">⛑ summon eta</button>'
                 : '<span class="go-dim">its bean is on the board — records land as its round finishes</span>') +
      "</div>";
    document.getElementById("go-summon-eta")?.addEventListener("click", (e) => {
      net.op({ op: "summon", name: "eta" });
      (e.target as HTMLButtonElement).disabled = true;
      (e.target as HTMLButtonElement).textContent = "summoning — first round takes a few minutes…";
    });
    return;
  }
  if (!etaBody.querySelector(".eta-list")) { etaBody.innerHTML = '<div class="eta-list"></div>'; rowEls.clear(); }
  const list = etaBody.querySelector(".eta-list") as HTMLElement;
  const seen = new Set<string>();
  let prev: HTMLElement | null = null;
  for (const v of views) {
    seen.add(v.name);
    let el = rowEls.get(v.name);
    if (!el) {
      el = document.createElement("div");
      el.className = "eta-row";
      el.innerHTML = '<div class="er-line"><i class="er-dot"></i><b class="er-name"></b>' +
        '<span class="er-cd"></span></div><div class="er-gist"></div>' +
        '<div class="er-fold"><div class="er-eta"></div><div class="er-detail"></div>' +
        '<div class="er-mile"></div><div class="er-actions"><span class="er-upd"></span>' +
        '<button class="er-chat">open chat ›</button></div></div>';
      el.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest(".er-chat")) { openChatFor(v.name); return; }
        const open = el!.classList.toggle("open");
        if (open) openRows.add(v.name); else openRows.delete(v.name);
        try { localStorage.setItem("hive:goEtaOpen", JSON.stringify([...openRows])); } catch { /* private mode */ }
      });
      rowEls.set(v.name, el);
    }
    if (prev ? prev.nextElementSibling !== el : list.firstElementChild !== el) {
      prev ? prev.after(el) : list.prepend(el);
    }
    prev = el;
    el.classList.toggle("open", openRows.has(v.name));
    el.classList.toggle("dim", ["done", "gone", "idle"].includes(effectiveStatus(v)));
    (el.querySelector(".er-dot") as HTMLElement).style.background = statusDot(v);
    (el.querySelector(".er-name") as HTMLElement).textContent = v.name;
    (el.querySelector(".er-gist") as HTMLElement).textContent = v.gist || v.task || "";
    const cd = el.querySelector(".er-cd") as HTMLElement;
    paintCd(cd, v, now);
    (el.querySelector(".er-eta") as HTMLElement).textContent =
      v.etaText ? `eta: ${v.etaText}${v.conf ? ` · ${v.conf}` : ""}` : (v.conf ? `confidence: ${v.conf}` : "");
    (el.querySelector(".er-detail") as HTMLElement).textContent = v.detail || "";
    (el.querySelector(".er-mile") as HTMLElement).textContent = v.milestone ? `milestone: ${v.milestone}` : "";
    (el.querySelector(".er-upd") as HTMLElement).textContent = `updated ${agoText(Date.now() / 1000 - v.updatedT)}`;
  }
  for (const [name, el] of rowEls) if (!seen.has(name)) { el.remove(); rowEls.delete(name); }
}

function paintCd(cd: HTMLElement, v: EtaView, now: number) {
  const st = effectiveStatus(v);
  if (v.etaIso && (st === "working" || st === "pending" || st === "offline")) {
    const left = Date.parse(v.etaIso) - now;
    cd.textContent = left >= 0 ? cdText(left) : `+${cdText(left)}`;
    cd.classList.toggle("late", left < 0);
    cd.classList.remove("word");
  } else {
    cd.textContent = STATUS_WORD[st] || "";
    cd.classList.add("word");
    cd.classList.remove("late");
  }
}

// countdowns tick every second — text-only writes on stable nodes
setInterval(() => {
  const now = Date.now();
  for (const v of rankEtas(etaRows, sessions)) {
    const el = rowEls.get(v.name);
    if (el) paintCd(el.querySelector(".er-cd") as HTMLElement, v, now);
  }
}, 1000);

net.on((m: ServerMsg) => {
  if (m.type === "etas") { etaRows = m.etas; renderEtas(); }
  if (m.type === "hive") {
    sessions = m.sessions;
    renderStrip();
    renderEtas();
    dock.refresh(m.sessions);
  }
  if (m.type === "chat") dock.apply(m.sid, m.events, m.reset);
  if (m.type === "caps") dock.setCaps(m.sid, m.commands);
  if (m.type === "defaults") {
    hostEl.textContent = "⬡ " + m.host;
    document.title = "hive · " + m.host;
    shelf = m.shelf;
    if (mgrBtn.textContent === "summoning…" && sessions.some((s) => s.name === "manager")) {
      mgrBtn.textContent = "manager ›";
    }
    renderEtas();
  }
});

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

net.connect();
