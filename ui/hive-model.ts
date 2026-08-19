// Hive model (ported from romp-hive, simplified): the server now sends the per-session
// snapshot directly — no ledger folding — so this file keeps only the pure pieces the
// scene animates from: the diff between snapshots, the unseen-done / unseen-ask latches,
// the trash-drop latch, and the one-line state phrasing. The scene animates ONLY from
// diff events, never by re-deriving per push: an identical payload twice yields zero
// events, so nothing on the board can move without new information.

import { KNOWN_STATES, type SessionSnap } from "../server/proto";

export type HiveSession = SessionSnap;
export type { WireState } from "../server/proto";

const STATES: ReadonlySet<string> = new Set(KNOWN_STATES);
export function isKnownState(s: string): boolean { return STATES.has(s); }

export interface HiveDiff {
  added: string[];
  removed: string[];
  stateChanged: { sid: string; from: string; to: string }[];
  goalDone: string[];                       // sids where a KNOWN top goal newly completed
}

// Compact age for state lines ("2m", "1h").
export function hiveAge(secs: number): string {
  secs = Math.max(0, Math.floor(secs));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

// The one-line state, in the user's terms: what the session is doing and, when it
// matters, for how long. An unrecognized state names itself rather than hiding.
export function stateLine(s: HiveSession, now: number): string {
  switch (s.state) {
    case "working": {
      const n = s.narration;
      return n ? `working — ${n.toolUses} tool${n.toolUses === 1 ? "" : "s"} in, ${hiveAge(now - n.since)}`
               : "working";
    }
    case "awaiting":
      return s.liveAsk || !s.needsYouT
        ? "needs you — waiting on your answer"
        : `needs you — asked ${hiveAge(now - s.needsYouT)} ago`;
    case "blocked": return s.brief ? `stopped — ${s.brief}` : "stopped on an error";
    case "retrying": return s.brief || "hitting API errors, retrying";
    case "awaitingBg": return "idle, waiting on background work";
    case "compacting": return "compacting its context";
    case "clearing": return "clearing its context";
    case "interrupting": return "stopping…";
    case "opening": return "starting up";
    case "ready": return s.faded ? "idle for a while" : "ready";
    default:
      return `in a state hive doesn't know: "${s.state}"`;
  }
}

export function finishedLine(s: HiveSession, now: number): string {
  return `finished working — ${hiveAge(now - s.doneT)} ago`;
}

// ── the unseen-finished latch ────────────────────────────────────────────────────
// Per sid, the completion watermark the user has LOOKED at; a session whose doneT is
// past it wears the finished cue until an actual look gesture advances the watermark.
// First sight of a sid seeds its watermark to the current doneT: arriving with old
// completions is HISTORY, not an event. Absent sids keep their stamps (a revived
// session must not celebrate its past) until the record outgrows 200 entries.
export type SeenDone = Record<string, number>;

export function foldSeenDone(prev: SeenDone, sessions: HiveSession[]):
    { seen: SeenDone; unseen: Set<string>; changed: boolean } {
  const seen: SeenDone = { ...prev };
  const unseen = new Set<string>();
  let changed = false;
  const live = new Set<string>();
  for (const s of sessions) {
    live.add(s.sid);
    if (!(s.sid in seen)) { seen[s.sid] = s.doneT; changed = true; }
    else if (s.doneT > seen[s.sid]) unseen.add(s.sid);
  }
  let extra = Object.keys(seen).length - 200;
  if (extra > 0) {
    for (const k of Object.keys(seen)) {
      if (extra <= 0) break;
      if (!live.has(k)) { delete seen[k]; changed = true; extra--; }
    }
  }
  return { seen, unseen, changed };
}

// The unseen-ASK twin: a filed needs-you SHOUTS (bang/sonar/wave) only until the user
// has gone to look — then the pad keeps its honest red but stops shouting. ONE
// deliberate difference from foldSeenDone: NO first-sight seeding. A completion is
// news (history can be swallowed); a filed question is a DEBT — it must survive
// reloads and fresh browsers, so an unknown sid compares against 0 and shouts until
// the first real look.
export function foldSeenAsk(prev: SeenDone, sessions: HiveSession[]):
    { seen: SeenDone; unseen: Set<string>; changed: boolean } {
  const seen: SeenDone = { ...prev };
  const unseen = new Set<string>();
  let changed = false;
  const live = new Set<string>();
  for (const s of sessions) {
    live.add(s.sid);
    if (s.needsYouT > (seen[s.sid] ?? 0)) unseen.add(s.sid);
  }
  let extra = Object.keys(seen).length - 200;
  if (extra > 0) {
    for (const k of Object.keys(seen)) {
      if (extra <= 0) break;
      if (!live.has(k)) { delete seen[k]; changed = true; extra--; }
    }
  }
  return { seen, unseen, changed };
}

// The event stream between two snapshots. `prev` null means "first payload": everything
// is `added`, and no state/goal events fire (there is no earlier world to compare).
export function diffSessions(prev: HiveSession[] | null, next: HiveSession[]): HiveDiff {
  const d: HiveDiff = { added: [], removed: [], stateChanged: [], goalDone: [] };
  const pm = new Map((prev || []).map((s) => [s.sid, s] as const));
  const nm = new Map(next.map((s) => [s.sid, s] as const));
  for (const s of next) if (!pm.has(s.sid)) d.added.push(s.sid);
  if (prev) {
    for (const s of prev) if (!nm.has(s.sid)) d.removed.push(s.sid);
    for (const s of next) {
      const p = pm.get(s.sid);
      if (!p) continue;
      if (p.state !== s.state) d.stateChanged.push({ sid: s.sid, from: p.state, to: s.state });
      // goalDone: a top the previous world already KNEW (id in p.topIds) moved into the
      // done set — the observed transition, once per completion, never re-derived. A
      // brand-new id arriving already-done is history, not an event.
      const prevDone = new Set(p.doneTopIds), prevKnown = new Set(p.topIds);
      if (s.doneTopIds.some((id) => !prevDone.has(id) && prevKnown.has(id))) d.goalDone.push(s.sid);
    }
  }
  return d;
}

// Trash-drop suppression. The drop is optimistic: the bean bursts and the tile sinks the
// moment the user decides — but the next payload was usually BUILT before the server's
// kill landed, still listed the sid, and a fresh pad would pop back up. A dropped sid is
// therefore held OUT of payloads until one ARRIVES WITHOUT it — the server's
// authoritative confirm, the deciding event, never a timer. The one timed piece is the
// LOUD-FAILURE backstop: payloads still carrying the sid past ENDING_ACK_MS mean the end
// didn't take, so it stops being hidden and the caller says so.
export const ENDING_ACK_MS = 15_000;

export function foldEnding(ending: Map<string, number>, present: Set<string>, nowMs: number):
    { drop: Set<string>; failed: string[] } {
  const drop = new Set<string>();
  const failed: string[] = [];
  for (const [sid, armedAt] of [...ending]) {
    if (!present.has(sid)) { ending.delete(sid); continue; }             // confirmed gone → latch retires
    if (nowMs - armedAt > ENDING_ACK_MS) { ending.delete(sid); failed.push(sid); continue; }
    drop.add(sid);
  }
  return { drop, failed };
}
