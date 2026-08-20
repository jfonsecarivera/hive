// hive/go — the phone page: the manager in your pocket and everyone's ETA above it.
// Reuses the full ChatDock (asks, steering, interrupt, slash menu) restyled for one
// column; the board strip up top switches which session you're talking to.
import { ChatDock } from "./chat";
import { agoText, cdText, effectiveStatus, rankEtas, STATUS_WORD, type EtaView } from "./eta-model";
import { isFaded } from "./hive-model";
import { net } from "./net";
import type { EtaRow, ServerMsg, SessionSnap } from "../server/proto";

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
  if (m.type === "etas") {
    etaRows = m.etas;
    renderEtas();
  }
  if (m.type === "hive") {
    sessions = m.sessions;
    renderStrip();
    renderEtas();                          // live-state merge (dots, offline flags)
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

// ── the ETA board (modeled on eta-dash): ranked rows, live countdowns, honest dots ──
// Pushed over the ws (agents write via hive_eta); rows are UPSERTED so open folds and
// the ticking countdowns survive every update.
let etaRows: EtaRow[] = [];
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
  etaAge.textContent = views.length ? `${views.length} tracked` : "";
  if (!views.length) {
    etaBody.innerHTML = '<p class="go-dim">nothing tracked yet — the <b>eta</b> duty writes this board with its hive_eta tool</p>';
    rowEls.clear();
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
        '<div class="er-mile"></div><div class="er-upd"></div></div>';
      el.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest(".er-fold")) return;
        const open = el!.classList.toggle("open");
        if (open) openRows.add(v.name); else openRows.delete(v.name);
        try { localStorage.setItem("hive:goEtaOpen", JSON.stringify([...openRows])); } catch { /* private mode */ }
      });
      rowEls.set(v.name, el);
    }
    // ordered insert without rebuilding: move only when out of place
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
    cd.dataset.iso = v.etaIso || "";
    paintCd(cd, v, now);
    (el.querySelector(".er-eta") as HTMLElement).textContent = v.etaText ? `eta: ${v.etaText}${v.conf ? ` · ${v.conf}` : ""}` : (v.conf ? `confidence: ${v.conf}` : "");
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

// the countdowns tick every second — text-only writes on stable nodes, no re-render
setInterval(() => {
  const now = Date.now();
  const views = rankEtas(etaRows, sessions);
  for (const v of views) {
    const el = rowEls.get(v.name);
    if (el) paintCd(el.querySelector(".er-cd") as HTMLElement, v, now);
  }
}, 1000);

etaHead.addEventListener("click", () => {
  const closed = etaBody.classList.toggle("closed");
  (etaHead.querySelector("i") as HTMLElement).textContent = closed ? "▸" : "▾";
  try { localStorage.setItem("hive:goEtaFold", closed ? "1" : "0"); } catch { /* private mode */ }
});
if (localStorage.getItem("hive:goEtaFold") === "1") {
  etaBody.classList.add("closed");
  (etaHead.querySelector("i") as HTMLElement).textContent = "▸";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

net.connect();
