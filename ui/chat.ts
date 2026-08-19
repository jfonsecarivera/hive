// The chat dock — the conversation surface, rebuilt from scratch (the one piece of romp
// deliberately NOT ported). Principles it keeps from the board: progressive disclosure
// (tool runs are one-line rows that expand; thinking folds), click-safety (all actions
// delegated to the stable dock root), instant acknowledgement, and no romp-style pane
// shell — the dock lives on the same page as the world and switches sessions instantly.
//
// The feed renders UPSERTS: every event has an id and a node; a streaming text block or
// a running tool patches its node in place. Nothing is ever rebuilt wholesale, so there
// is no scroll jank and no mid-click DOM churn.
import { delegate } from "./actions";
import { isKnownState, stateLine, type HiveSession } from "./hive-model";
import { renderMarkdown } from "./markdown";
import type { AskQuestion, ChatEvent, ClientOp } from "../server/proto";

export const DOCK_W = 460;

interface Row { ev: ChatEvent; el: HTMLElement }

export class ChatDock {
  el: HTMLElement;
  sid: string | null = null;
  onOpenChange: (open: boolean) => void = () => {};
  private feed: HTMLElement;
  private rows = new Map<string, Row>();
  private order: string[] = [];
  private head: { dot: HTMLElement; name: HTMLElement; sub: HTMLElement; stop: HTMLButtonElement };
  private goalEl: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private jump: HTMLButtonElement;
  private pinned = true;                     // following the newest message
  private sess: HiveSession | null = null;
  private renaming = false;
  private askPicks = new Map<string, Map<number, { picks: Set<number>; custom: string }>>();

  constructor(private op: (o: ClientOp) => void) {
    const el = document.createElement("aside");
    el.id = "chat-dock";
    el.innerHTML =
      '<header class="cd-head">' +
      '<span class="cd-dot"></span>' +
      '<div class="cd-id"><span class="cd-name" data-act="rename" title="Rename"></span>' +
      '<span class="cd-sub"></span></div>' +
      '<button class="cd-stop" data-act="stop" title="Interrupt the running turn">■ stop</button>' +
      '<button class="cd-x" data-act="close" title="Close (Esc)" aria-label="Close">×</button>' +
      "</header>" +
      '<div class="cd-goal" hidden></div>' +
      '<div class="cd-feed"></div>' +
      '<button class="cd-jump" data-act="jump" hidden>↓ latest</button>' +
      '<footer class="cd-compose">' +
      '<textarea class="cd-input" rows="1" placeholder="Say something…"></textarea>' +
      '<button class="cd-send" data-act="send" title="Send (Enter)">Send</button>' +
      "</footer>";
    document.body.appendChild(el);
    this.el = el;
    this.feed = el.querySelector(".cd-feed") as HTMLElement;
    this.goalEl = el.querySelector(".cd-goal") as HTMLElement;
    this.head = {
      dot: el.querySelector(".cd-dot") as HTMLElement,
      name: el.querySelector(".cd-name") as HTMLElement,
      sub: el.querySelector(".cd-sub") as HTMLElement,
      stop: el.querySelector(".cd-stop") as HTMLButtonElement,
    };
    this.input = el.querySelector(".cd-input") as HTMLTextAreaElement;
    this.sendBtn = el.querySelector(".cd-send") as HTMLButtonElement;
    this.jump = el.querySelector(".cd-jump") as HTMLButtonElement;

    delegate(el, {
      close: () => this.close(),
      send: () => this.send(),
      stop: () => this.interrupt(),
      jump: () => this.scrollToEnd(true),
      rename: () => this.startRename(),
      fold: (btn) => {
        const body = btn.parentElement?.querySelector(".t-body") as HTMLElement | null;
        if (body) body.hidden = !body.hidden;
        btn.closest(".t-row")?.classList.toggle("open", body ? !body.hidden : false);
      },
      "ask-opt": (btn) => this.onAskOption(btn),
      "ask-submit": (btn) => this.onAskSubmit(btn),
      "ask-deny": (btn) => this.answerAsk(btn.closest<HTMLElement>(".m-ask")!.dataset.ask!, { deny: true }),
      "ask-allow": (btn) => this.answerAsk(btn.closest<HTMLElement>(".m-ask")!.dataset.ask!, { allow: true }),
      "ask-always": (btn) => this.answerAsk(btn.closest<HTMLElement>(".m-ask")!.dataset.ask!, { allow: true, always: true }),
      copy: (btn) => {
        const pre = btn.parentElement?.querySelector("code");
        if (pre) navigator.clipboard?.writeText(pre.textContent || "");
        btn.textContent = "copied";
        setTimeout(() => { btn.textContent = "copy"; }, 900);
      },
    });

    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation();                   // typing never orbits the camera
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.send(); }
      if (e.key === "Escape") { e.preventDefault(); this.close(); }
    });
    this.input.addEventListener("input", () => this.autosize());
    this.feed.addEventListener("scroll", () => {
      const nearEnd = this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 90;
      this.pinned = nearEnd;
      this.jump.hidden = nearEnd;
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen() && !this.renaming
          && document.activeElement !== this.input) this.close();
    });
  }

  isOpen(): boolean { return this.el.classList.contains("open"); }

  open(sid: string) {
    const fresh = this.sid !== sid;
    if (fresh) {
      if (this.sid) this.op({ op: "unwatch", sid: this.sid });
      this.sid = sid;
      this.rows.clear();
      this.order = [];
      this.feed.replaceChildren();
      this.askPicks.clear();
      this.op({ op: "watch", sid });
      this.pinned = true;
    }
    this.el.classList.add("open");
    this.onOpenChange(true);
    this.input.focus();
  }

  close() {
    if (!this.isOpen()) return;
    this.el.classList.remove("open");
    this.onOpenChange(false);
    if (this.sid) this.op({ op: "unwatch", sid: this.sid });
    this.sid = null;
    this.sess = null;
  }

  // the board push keeps the header honest (state line, model, cost) — updated in place
  refresh(sessions: HiveSession[]) {
    if (!this.sid) return;
    const s = sessions.find((x) => x.sid === this.sid);
    if (!s) {
      this.head.sub.textContent = "this session has ended";
      this.head.stop.classList.remove("show");
      return;
    }
    this.sess = s;
    const now = Math.floor(Date.now() / 1000);
    this.head.dot.style.background = s.color.bg;
    if (!this.renaming) this.head.name.textContent = s.name;
    this.head.name.style.color = s.color.bg;
    const bits = [stateLine(s, now), s.model + " · " + s.effort];
    if (s.cost > 0) bits.push("$" + (s.cost < 10 ? s.cost.toFixed(2) : s.cost.toFixed(1)));
    this.head.sub.textContent = bits.join("  ·  ");
    this.head.sub.dataset.state = isKnownState(s.state) ? s.state : "unknown";
    this.goalEl.hidden = !s.goal;
    if (s.goal) this.goalEl.textContent = s.goal;
    const busy = s.state === "working" || s.state === "compacting" || s.state === "retrying";
    this.head.stop.classList.toggle("show", busy);
    this.input.placeholder = busy ? "Steer — lands in the running turn…" : "Say something…";
  }

  // ── events in (reset = full history replay) ────────────────────────────────────
  apply(sid: string, events: ChatEvent[], reset?: boolean) {
    if (sid !== this.sid) return;
    if (reset) {
      this.rows.clear();
      this.order = [];
      this.feed.replaceChildren();
    }
    for (const ev of events) this.upsert(ev);
    if (this.pinned) this.scrollToEnd(false);
  }

  private upsert(ev: ChatEvent) {
    const existing = this.rows.get(ev.id);
    if (existing) {
      this.patch(existing, ev);
      existing.ev = ev;
      return;
    }
    const el = this.build(ev);
    this.rows.set(ev.id, { ev, el });
    this.order.push(ev.id);
    // consecutive tool rows share one activity group — the feed reads as prose
    // punctuated by compact "what it did" blocks, not a wall of tool noise
    if (ev.k === "tool") {
      const last = this.feed.lastElementChild;
      if (last && last.classList.contains("m-act")) {
        last.appendChild(el);
        return;
      }
      const group = document.createElement("div");
      group.className = "m-act";
      group.appendChild(el);
      this.feed.appendChild(group);
      return;
    }
    this.feed.appendChild(el);
  }

  private build(ev: ChatEvent): HTMLElement {
    const d = document.createElement("div");
    switch (ev.k) {
      case "user":
        d.className = "m-user";
        d.textContent = ev.text;
        break;
      case "text":
        d.className = "m-asst md" + (ev.done ? "" : " streaming");
        d.innerHTML = renderMarkdown(ev.text);
        this.decorateCode(d);
        break;
      case "think": {
        d.className = "m-think" + (ev.done ? "" : " streaming");
        d.innerHTML = '<button class="th-head" data-act="fold"><span class="th-tw">▸</span> <span class="th-label"></span></button>' +
          '<div class="t-body md" hidden></div>';
        (d.querySelector(".th-label") as HTMLElement).textContent = ev.done ? "thought" : "thinking…";
        (d.querySelector(".t-body") as HTMLElement).innerHTML = renderMarkdown(ev.text);
        break;
      }
      case "tool":
        d.className = "t-row";
        d.dataset.status = ev.status;
        d.innerHTML = '<button class="t-head" data-act="fold">' +
          '<i class="t-dot"></i><span class="t-title"></span><span class="t-meta"></span></button>' +
          '<div class="t-body" hidden><pre class="t-in"></pre><pre class="t-out" hidden></pre></div>';
        this.patchTool(d, ev);
        break;
      case "ask":
        d.className = "m-ask";
        d.dataset.ask = ev.id;
        d.dataset.status = ev.status;
        this.buildAsk(d, ev);
        break;
      case "turn": {
        d.className = "m-turn";
        const bits = [ev.dur >= 60 ? `${Math.floor(ev.dur / 60)}m${ev.dur % 60}s` : `${ev.dur}s`];
        if (ev.cost != null) bits.push("$" + (ev.cost < 10 ? ev.cost.toFixed(2) : ev.cost.toFixed(1)));
        if (ev.note) bits.push(ev.note);
        d.innerHTML = `<span>${escText(bits.join(" · "))}</span>`;
        if (ev.note) d.classList.add("odd");
        break;
      }
      case "note":
        d.className = "m-note";
        d.dataset.tone = ev.tone;
        d.textContent = ev.text;
        break;
    }
    return d;
  }

  private patch(row: Row, ev: ChatEvent) {
    const el = row.el;
    if (ev.k === "text") {
      el.className = "m-asst md" + (ev.done ? "" : " streaming");
      el.innerHTML = renderMarkdown(ev.text);
      this.decorateCode(el);
    } else if (ev.k === "think") {
      el.classList.toggle("streaming", !ev.done);
      (el.querySelector(".th-label") as HTMLElement).textContent = ev.done ? "thought" : "thinking…";
      (el.querySelector(".t-body") as HTMLElement).innerHTML = renderMarkdown(ev.text);
    } else if (ev.k === "tool") {
      this.patchTool(el, ev);
    } else if (ev.k === "ask") {
      el.dataset.status = ev.status;
      if (ev.status === "done") this.collapseAsk(el, ev);
    } else if (ev.k === "user") {
      el.textContent = ev.text;
    }
  }

  private patchTool(el: HTMLElement, ev: Extract<ChatEvent, { k: "tool" }>) {
    el.dataset.status = ev.status;
    (el.querySelector(".t-title") as HTMLElement).textContent = ev.title;
    const meta = el.querySelector(".t-meta") as HTMLElement;
    meta.textContent = ev.status === "run" ? (ev.elapsed ? `${ev.elapsed}s` : "") :
      ev.status === "err" ? "failed" : "";
    const inEl = el.querySelector(".t-in") as HTMLElement;
    if (ev.input && !inEl.textContent) inEl.textContent = ev.input;
    inEl.hidden = !ev.input;
    const outEl = el.querySelector(".t-out") as HTMLElement;
    if (ev.output != null) {
      outEl.textContent = ev.output || "(no output)";
      outEl.hidden = false;
    }
  }

  // ── ask cards: permissions and questions, answered right in the flow ───────────
  private buildAsk(el: HTMLElement, ev: Extract<ChatEvent, { k: "ask" }>) {
    if (ev.status === "done") { this.collapseAsk(el, ev); return; }
    let html = `<div class="ask-title">${escText(ev.title)}</div>`;
    if (ev.subtitle) html += `<div class="ask-sub">${escText(ev.subtitle)}</div>`;
    if (ev.preview) {
      html += `<pre class="ask-preview" data-kind="${ev.preview.kind}">` +
        ev.preview.text.split("\n").map((l) =>
          `<span class="${l.startsWith("+") ? "pl" : l.startsWith("-") ? "mn" : ""}">${escText(l)}</span>`,
        ).join("\n") + "</pre>";
    }
    if (ev.kind === "question" && ev.questions?.length) {
      const multiQ = ev.questions.length > 1;
      ev.questions.forEach((q, qi) => {
        if (multiQ || q.header) html += `<div class="ask-qhead">${escText(q.header || `question ${qi + 1}`)}</div>`;
        if (multiQ) html += `<div class="ask-q">${escText(q.question)}</div>`;
        html += '<div class="ask-opts">';
        q.options.forEach((o, oi) => {
          html += `<button class="ask-opt" data-act="ask-opt" data-q="${qi}" data-o="${oi}">` +
            `<span class="ao-label">${escText(o.label)}</span>` +
            (o.description ? `<span class="ao-desc">${escText(o.description)}</span>` : "") +
            "</button>";
        });
        html += `<input class="ask-custom" data-q="${qi}" placeholder="or type your own…">`;
        html += "</div>";
      });
      // a single single-select question answers on the option click itself (fast path);
      // everything else gets an explicit submit
      if (multiQ || ev.questions.some((q) => q.multiSelect)) {
        html += '<div class="ask-actions"><button class="ask-go" data-act="ask-submit">Answer</button></div>';
      }
    } else {
      html += '<div class="ask-actions">' +
        '<button class="ask-allow" data-act="ask-allow">Allow</button>' +
        (ev.canAlways ? '<button class="ask-always" data-act="ask-always">Always allow</button>' : "") +
        '<button class="ask-deny" data-act="ask-deny">Deny</button></div>';
    }
    el.innerHTML = html;
    el.querySelectorAll<HTMLInputElement>(".ask-custom").forEach((inp) => {
      inp.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); this.onAskSubmit(inp); }
      });
      inp.addEventListener("input", () => {
        const st = this.pickState(el.dataset.ask!, Number(inp.dataset.q));
        st.custom = inp.value;
      });
    });
  }

  private collapseAsk(el: HTMLElement, ev: Extract<ChatEvent, { k: "ask" }>) {
    el.innerHTML = `<div class="ask-done"><span class="ask-check">✓</span>` +
      `<span class="ask-done-title">${escText(ev.title)}</span>` +
      `<span class="ask-done-answer">${escText(ev.answer || "answered")}</span></div>`;
  }

  private pickState(askId: string, qi: number) {
    let m = this.askPicks.get(askId);
    if (!m) { m = new Map(); this.askPicks.set(askId, m); }
    let st = m.get(qi);
    if (!st) { st = { picks: new Set(), custom: "" }; m.set(qi, st); }
    return st;
  }

  private onAskOption(btn: HTMLElement) {
    const card = btn.closest<HTMLElement>(".m-ask");
    if (!card || card.dataset.status === "done") return;
    const askId = card.dataset.ask!;
    const row = this.rows.get(askId);
    const ev = row?.ev as Extract<ChatEvent, { k: "ask" }> | undefined;
    if (!ev?.questions) return;
    const qi = Number(btn.dataset.q), oi = Number(btn.dataset.o);
    const q = ev.questions[qi];
    const st = this.pickState(askId, qi);
    if (q.multiSelect) {
      if (st.picks.has(oi)) st.picks.delete(oi);
      else st.picks.add(oi);
      btn.classList.toggle("picked", st.picks.has(oi));
      return;
    }
    st.picks.clear();
    st.picks.add(oi);
    card.querySelectorAll(`.ask-opt[data-q="${qi}"]`).forEach((b) => b.classList.remove("picked"));
    btn.classList.add("picked");
    // single question, single select → the click IS the answer
    if (ev.questions.length === 1) this.onAskSubmit(btn);
  }

  private onAskSubmit(from: HTMLElement) {
    const card = from.closest<HTMLElement>(".m-ask");
    if (!card || card.dataset.status === "done") return;
    const askId = card.dataset.ask!;
    const row = this.rows.get(askId);
    const ev = row?.ev as Extract<ChatEvent, { k: "ask" }> | undefined;
    if (!ev?.questions) return;
    const answers: Record<string, string | string[]> = {};
    ev.questions.forEach((q, qi) => {
      const st = this.pickState(askId, qi);
      const labels = [...st.picks].map((oi) => q.options[oi]?.label).filter(Boolean) as string[];
      const custom = st.custom.trim() ||
        (card.querySelector<HTMLInputElement>(`.ask-custom[data-q="${qi}"]`)?.value.trim() ?? "");
      if (custom) labels.push(custom);
      if (!labels.length) return;
      answers[q.question] = q.multiSelect ? labels : labels[0];
    });
    if (!Object.keys(answers).length) return;   // nothing picked anywhere — nothing to say yet
    this.answerAsk(askId, { answers });
  }

  private answerAsk(askId: string, body: { allow?: boolean; always?: boolean; deny?: boolean; answers?: Record<string, string | string[]> }) {
    if (!this.sid) return;
    const card = this.rows.get(askId)?.el;
    card?.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
    this.op({ op: "answer", sid: this.sid, askId, ...body });
  }

  // ── compose ────────────────────────────────────────────────────────────────────
  private send() {
    const text = this.input.value.trim();
    if (!text || !this.sid) return;
    this.op({ op: "send", sid: this.sid, text });
    this.input.value = "";
    this.autosize();
    this.pinned = true;
    this.scrollToEnd(false);
  }

  private interrupt() {
    if (!this.sid) return;
    this.op({ op: "interrupt", sid: this.sid });
    this.head.stop.textContent = "■ stopping…";
    setTimeout(() => { this.head.stop.textContent = "■ stop"; }, 1600);
  }

  private startRename() {
    if (!this.sid || this.renaming || !this.sess) return;
    const sid = this.sid;
    const base = this.sess.name;
    const input = document.createElement("input");
    input.className = "cd-rename";
    input.value = base;
    input.spellcheck = false;
    this.renaming = true;
    this.head.name.style.display = "none";
    this.head.name.after(input);
    let fin = false;
    const done = (commit: boolean) => {
      if (fin) return;
      fin = true;
      const v = input.value.trim();
      input.remove();
      this.head.name.style.display = "";
      this.renaming = false;
      if (commit && v && v !== base) this.op({ op: "rename", sid, name: v });
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); done(true); }
      else if (e.key === "Escape") { e.preventDefault(); done(false); }
    });
    input.addEventListener("blur", () => done(true));
    input.focus();
    input.select();
  }

  private autosize() {
    this.input.style.height = "auto";
    this.input.style.height = Math.min(180, this.input.scrollHeight) + "px";
  }

  private scrollToEnd(smooth: boolean) {
    this.feed.scrollTo({ top: this.feed.scrollHeight, behavior: smooth ? "smooth" : "auto" });
    this.pinned = true;
    this.jump.hidden = true;
  }

  private decorateCode(el: HTMLElement) {
    el.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".code-copy")) return;
      const b = document.createElement("button");
      b.className = "code-copy";
      b.dataset.act = "copy";
      b.textContent = "copy";
      pre.appendChild(b);
    });
  }
}

function escText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
