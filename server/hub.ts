// The session registry: creates/revives sessions, persists every change, and fans
// snapshots out to the board ("hive" topic) and chat events to watchers ("chat:<sid>").
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { adoptGoal, adoptMode, adoptName, historyToEvents, pickAdoptable, pickRompAdoptable } from "./adopt";
import { TranscriptMirror } from "./mirror";
import { readRompRegistry } from "./romp";
import { AgentSession } from "./session";
import { Store, type SessionRow } from "./store";
import { EFFORTS, MODELS, type ChatEvent, type ClientOp, type Defaults, type ModelChoice, type ServerMsg, type SessionSnap } from "./proto";

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
  // the model roster: the static fallback until any live session reports the real list
  // (supportedModels) — then every tray everywhere gets the truth
  private models: ModelChoice[] = MODELS;

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
    // (no display-refresh timer: "faded" derives client-side from lastT at render time)
    // adopt the machine's existing Claude Code sessions (romp, terminal, anything) as
    // dormant beans — at boot and then on a slow rescan for sessions born elsewhere
    void this.adopt();
    setInterval(() => void this.adopt(), 600_000);
    // …and MIRROR the ones something else is driving: a transcript being appended is a
    // running session, whoever the controller — the board and chat show it live
    new TranscriptMirror(() => this.sessions.values()).start();
  }

  private async adopt() {
    // Adoption is a migration aid, never a standing sync (adoptMode owns the policy):
    // romp's registry drives scans only while it exists — hive's own store owns the
    // board the rest of the time, so removing romp is a non-event.
    const romp = readRompRegistry();
    const mode = adoptMode(romp.size, this.store.kvGet("adoptColdStart") === "1", process.env.HIVE_ADOPT);
    if (mode === "skip") return;
    let infos;
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      infos = await sdk.listSessions();
    } catch (e) {
      console.error("adopt: could not list existing sessions:", e);
      return;
    }
    const known = this.store.allClaudeIds();
    for (const s of this.sessions.values()) if (s.claudeSessionId) known.add(s.claudeSessionId);
    const rules = {
      nowMs: Date.now(),
      days: Number(process.env.HIVE_ADOPT_DAYS || 7),
      max: Number(process.env.HIVE_ADOPT_MAX || (mode === "romp" ? 24 : 12)),
    };
    const picks = mode === "romp"
      ? pickRompAdoptable(infos, romp, known, rules)
      : pickAdoptable(infos, known, rules);
    // any completed scan IS the cold start — from here on the board is hive's own
    this.store.kvSet("adoptColdStart", "1");
    if (!picks.length) return;
    const used = new Set([...this.sessions.values()].map((s) => s.name));
    const d = this.store.getDefaults();
    const takenRomp = new Set<string>();     // one bean per romp session, however many ids it wore
    for (const info of picks) {
      const r = romp.get(info.sessionId);
      if (r && (takenRomp.has(r.id) || r.ids.some((id) => known.has(id)))) continue;
      if (r) { takenRomp.add(r.id); for (const id of r.ids) known.add(id); }
      let name = r?.name || adoptName(info, used);
      if (used.has(name)) name = adoptName({ ...info, customTitle: name }, used);
      used.add(name);
      const usedColors = new Set([...this.sessions.values()].map((x) => x.color.bg));
      const bg = r?.bg || PALETTE.find((c) => !usedColors.has(c)) || PALETTE[hash(info.sessionId) % PALETTE.length];
      const s = new AgentSession({
        sid: randomUUID(), name,
        color: { bg, fg: r?.bg ? r.fg : fgFor(bg) },
        model: r?.model || "default",
        effort: r?.effort || d.effort,
        permMode: r?.permMode || d.permMode,
        cwd: r?.cwd || info.cwd || process.env.HOME || process.cwd(),
        claudeSessionId: info.sessionId,
        createdT: r?.spawnedAt || Math.floor((info.createdAt || info.lastModified) / 1000),
        lastT: Math.floor(info.lastModified / 1000),
        goal: adoptGoal(info),
      });
      this.wire(s);
      this.sessions.set(s.sid, s);
      this.persist(s.sid);
      const t = Math.floor(info.lastModified / 1000);
      this.store.putEvent(s.sid, {
        k: "note", id: "adopted", t,
        text: `adopted from an existing Claude Code session on this machine — recent history below; ` +
          `sending a message resumes it with its full context (claude --resume ${info.sessionId})`,
        tone: "info",
      });
      // backfill the readable tail, unless the transcript is huge (adoption must stay cheap)
      if ((info.fileSize ?? 0) < 20 * 1024 * 1024) {
        try {
          const sdk = await import("@anthropic-ai/claude-agent-sdk");
          const msgs = await sdk.getSessionMessages(info.sessionId);
          for (const ev of historyToEvents(msgs, t)) this.store.putEvent(s.sid, ev);
        } catch { /* the note above still explains where the history lives */ }
      }
    }
    console.log(`adopted ${picks.length} existing session${picks.length === 1 ? "" : "s"}`);
    this.publishHive();
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
    s.onCaps = (sid) => {
      this.publish(`chat:${sid}`, this.capsMsg(sid));
    };
    s.onModels = (models) => {
      if (!models.length || JSON.stringify(models) === JSON.stringify(this.models)) return;
      this.models = models;
      this.publish("hive", this.defaultsMsg());
    };
  }

  modelChoices(): ModelChoice[] { return this.models; }

  capsMsg(sid: string): string {
    const s = this.sessions.get(sid);
    return JSON.stringify({ type: "caps", sid, commands: s ? s.commands : [] } satisfies ServerMsg);
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
    // which machine's hive this is — two identical boards in two tabs are
    // indistinguishable without it (the user 2026-08-19, whose empty devbox board
    // read as their local beans having vanished)
    return JSON.stringify({
      type: "defaults", host: (process.env.HIVE_NAME || hostname()).replace(/\.local$/, ""),
      defaults: this.store.getDefaults(),
      models: this.models, efforts: [...EFFORTS],
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
