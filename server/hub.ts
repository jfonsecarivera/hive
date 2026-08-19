// The session registry: creates/revives sessions, persists every change, and fans
// snapshots out to the board ("hive" topic) and chat events to watchers ("chat:<sid>").
import { randomUUID } from "node:crypto";
import { AgentSession } from "./session";
import { Store, type SessionRow } from "./store";
import { EFFORTS, MODELS, type ChatEvent, type ClientOp, type Defaults, type ServerMsg, type SessionSnap } from "./proto";

// romp's identity palette — the same swatches the user's sessions already wear
const PALETTE = ["#1EA1EB", "#54B204", "#4EA8A9", "#DD42FF", "#E87221",
                 "#98998A", "#F85B5A", "#F9D849", "#9088F0"];

function fgFor(bg: string): string {
  const n = parseInt(bg.slice(1), 16);
  const y = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return y > 0.62 ? "#10141a" : "#ffffff";
}

export class Hub {
  store = new Store();
  sessions = new Map<string, AgentSession>();
  publish: (topic: string, data: string) => void = () => {};
  private hiveTimer: Timer | null = null;

  constructor() {
    for (const row of this.store.liveSessions()) {
      const s = new AgentSession({
        sid: row.sid, name: row.name, color: { bg: row.color_bg, fg: row.color_fg },
        model: row.model, effort: row.effort, permMode: row.perm_mode, cwd: row.cwd,
        claudeSessionId: row.claude_session_id, createdT: row.created_t, lastT: row.last_t,
        doneT: row.done_t, goal: row.goal, topIds: parse(row.top_ids), doneTopIds: parse(row.done_top_ids),
        cost: row.cost,
      });
      this.wire(s);
      this.sessions.set(s.sid, s);
    }
    // faded is time-derived (ready >1h): a slow re-publish keeps the doze cue honest
    setInterval(() => this.publishHive(), 60_000);
  }

  private wire(s: AgentSession) {
    s.onEvent = (sid, ev) => {
      this.store.putEvent(sid, ev);
      this.publish(`chat:${sid}`, JSON.stringify({ type: "chat", sid, events: [ev] } satisfies ServerMsg));
    };
    s.onChange = (sid) => {
      this.persist(sid);
      this.scheduleHive();
    };
  }

  private persist(sid: string) {
    const s = this.sessions.get(sid);
    if (!s) return;
    this.store.upsertSession(this.row(s));
  }

  private row(s: AgentSession): SessionRow {
    return {
      sid: s.sid, name: s.name, color_bg: s.color.bg, color_fg: s.color.fg,
      model: s.model, effort: s.effort, perm_mode: s.permMode, cwd: s.cwd,
      claude_session_id: s.claudeSessionId, created_t: s.createdT, last_t: s.lastT,
      done_t: s.doneT, goal: s.goal, top_ids: JSON.stringify(s.topIds),
      done_top_ids: JSON.stringify(s.doneTopIds), cost: s.cost(), archived: s.ended ? 1 : 0,
    };
  }

  snapshot(): SessionSnap[] {
    return [...this.sessions.values()].map((s) => s.snap());
  }

  hiveMsg(): string {
    return JSON.stringify({ type: "hive", sessions: this.snapshot() } satisfies ServerMsg);
  }

  defaultsMsg(): string {
    return JSON.stringify({
      type: "defaults", defaults: this.store.getDefaults(),
      models: MODELS, efforts: [...EFFORTS],
    } satisfies ServerMsg);
  }

  private scheduleHive() {
    if (this.hiveTimer) return;
    this.hiveTimer = setTimeout(() => {
      this.hiveTimer = null;
      this.publishHive();
    }, 30);
  }

  publishHive() {
    this.publish("hive", this.hiveMsg());
  }

  history(sid: string): ChatEvent[] {
    return this.store.events(sid);
  }

  create(op: Extract<ClientOp, { op: "create" }>): AgentSession {
    const d = this.store.getDefaults();
    const model = op.model || d.model;
    const used = new Set([...this.sessions.values()].map((x) => x.color.bg));
    const bg = PALETTE.find((c) => !used.has(c)) || PALETTE[hash(randomUUID()) % PALETTE.length];
    const s = new AgentSession({
      sid: randomUUID(),
      name: op.name?.trim() || this.autoName(model),
      color: { bg, fg: fgFor(bg) },
      model,
      effort: op.effort || d.effort,
      permMode: op.permMode || d.permMode,
      cwd: expandHome(op.cwd?.trim() || d.cwd),
    });
    this.wire(s);
    this.sessions.set(s.sid, s);
    this.persist(s.sid);
    this.publishHive();
    s.start(op.prompt);
    return s;
  }

  autoName(alias: string): string {
    const used = new Set([...this.sessions.values()].map((s) => s.name));
    let n = 1;
    while (used.has(`${alias}-${n}`)) n++;
    return `${alias}-${n}`;
  }

  end(sid: string) {
    const s = this.must(sid);
    s.end();
    this.persist(sid);
    this.sessions.delete(sid);
    this.publishHive();
  }

  must(sid: string): AgentSession {
    const s = this.sessions.get(sid);
    if (!s) throw new Error("no such session");
    return s;
  }

  setDefaults(op: Extract<ClientOp, { op: "setDefaults" }>): Defaults {
    const d = this.store.getDefaults();
    if (op.model) d.model = op.model;
    if (op.effort) d.effort = op.effort;
    if (op.cwd) d.cwd = expandHome(op.cwd);
    if (op.permMode) d.permMode = op.permMode;
    this.store.setDefaults(d);
    return d;
  }

  // server going down: cut clients without archiving — every session revives on restart
  shutdown() {
    for (const s of this.sessions.values()) {
      s.shutdown();
      this.persist(s.sid);
    }
  }
}

function parse(v: string): string[] {
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? (process.env.HOME || "") + p.slice(1) : p;
}
