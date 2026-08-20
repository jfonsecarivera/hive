// The transcript mirror — live state for sessions SOMETHING ELSE is driving (romp
// today, a plain terminal `claude` forever after). Claude Code's own transcript is
// the authoritative activity record whoever the controller is: a file being appended
// IS a running session. The mirror tails each dormant bean's transcript, streams new
// lines into its chat, lights the board "working", and drops back on the turn's own
// end marker (stop_reason) — an idle timeout is only the loud fallback for a driver
// that died mid-turn.
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { historyToEvents } from "./adopt";
import type { ChatEvent } from "./proto";

const CHUNK_CAP = 8 * 1024 * 1024;      // a growth burst bigger than this is skipped, not parsed
const IDLE_FALLBACK_MS = 120_000;       // driver died mid-turn: stop claiming "working"
const LOCATE_EVERY_MS = 30_000;

export function projectsDir(): string {
  return join(process.env.HOME || ".", ".claude", "projects");
}

// one raw transcript line → the SessionMessage shape historyToEvents consumes
export function lineToMsg(j: any): SessionMessage | null {
  if (!j || (j.type !== "user" && j.type !== "assistant")) return null;
  return {
    type: j.type,
    uuid: String(j.uuid || ""),
    session_id: String(j.sessionId || ""),
    message: j.message,
    parent_tool_use_id: null,
    parent_agent_id: j.isSidechain ? "sidechain" : null,   // historyToEvents drops subagent lines
  } as SessionMessage;
}

export interface ChunkRead {
  msgs: SessionMessage[];
  // the chunk's FINAL turn signal: an assistant end_turn/stop_sequence with nothing
  // after it means the turn finished; any later activity means it's running again
  endedTurn: boolean;
  sawActivity: boolean;
}

export function parseTranscriptChunk(lines: string[]): ChunkRead {
  const msgs: SessionMessage[] = [];
  let endedTurn = false;
  let sawActivity = false;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let j: any;
    try { j = JSON.parse(raw); } catch { continue; }
    const m = lineToMsg(j);
    if (!m) continue;
    if (!m.uuid) continue;
    msgs.push(m);
    if (m.parent_agent_id) continue;                        // sidechain noise is not a signal
    sawActivity = true;
    if (j.type === "assistant") {
      const stop = j.message?.stop_reason;
      endedTurn = stop === "end_turn" || stop === "stop_sequence";
    } else {
      endedTurn = false;                                    // a user line (re)opens the turn
    }
  }
  return { msgs, endedTurn, sawActivity };
}

// the mirror's view of one session — hub wires the callbacks to the AgentSession
export interface Mirrorable {
  sid: string;
  claudeSessionId: string | null;
  ended: boolean;
  mirrorBusy: boolean;
  driving(): boolean;
  mirrorEvents(evs: ChatEvent[]): void;
  mirrorActivity(working: boolean, newTools: number, endedTurn: boolean): void;
}

interface Tail {
  path: string | null;
  offset: number;
  rest: string;                          // partial trailing line between reads
  lastGrowth: number;
  locatedAt: number;
}

export class TranscriptMirror {
  private tails = new Map<string, Tail>();
  private carry = new Map<string, Map<string, Extract<ChatEvent, { k: "tool" }>>>();

  constructor(private sessions: () => Iterable<Mirrorable>, private dir = projectsDir()) {}

  start(intervalMs = 2000) {
    setInterval(() => { try { this.tick(Date.now()); } catch { /* one bad tick never kills the tail */ } }, intervalMs);
  }

  private locate(claudeId: string): string | null {
    try {
      for (const d of readdirSync(this.dir)) {
        const p = join(this.dir, d, claudeId + ".jsonl");
        if (existsSync(p)) return p;
      }
    } catch { /* no projects dir */ }
    return null;
  }

  tick(nowMs: number) {
    for (const s of this.sessions()) {
      if (s.ended || !s.claudeSessionId || s.driving()) continue;
      let t = this.tails.get(s.sid);
      if (!t) {
        t = { path: null, offset: -1, rest: "", lastGrowth: nowMs, locatedAt: 0 };
        this.tails.set(s.sid, t);
      }
      if (!t.path && nowMs - t.locatedAt >= LOCATE_EVERY_MS) {
        t.locatedAt = nowMs;
        t.path = this.locate(s.claudeSessionId);
      }
      if (!t.path) continue;
      let size: number;
      try { size = statSync(t.path).size; } catch { t.path = null; continue; }
      if (t.offset < 0) { t.offset = size; continue; }       // first sight: history is backfilled already
      if (size < t.offset) { t.offset = size; t.rest = ""; continue; }   // truncated/rotated — resync
      if (size === t.offset) {
        // no growth: the loud fallback for a driver that died mid-turn
        if (s.mirrorBusy && nowMs - t.lastGrowth > IDLE_FALLBACK_MS) s.mirrorActivity(false, 0, false);
        continue;
      }
      const grew = size - t.offset;
      if (grew > CHUNK_CAP) {                                // a monster burst: skip content, keep truth
        t.offset = size; t.rest = "";
        t.lastGrowth = nowMs;
        s.mirrorActivity(true, 0, false);
        continue;
      }
      const buf = Buffer.alloc(grew);
      try {
        const fd = openSync(t.path, "r");
        readSync(fd, buf, 0, grew, t.offset);
        closeSync(fd);
      } catch { continue; }
      t.offset = size;
      t.lastGrowth = nowMs;
      const text = t.rest + buf.toString("utf8");
      const lines = text.split("\n");
      t.rest = lines.pop() || "";
      const { msgs, endedTurn, sawActivity } = parseTranscriptChunk(lines);
      if (!sawActivity && !msgs.length) continue;
      let cm = this.carry.get(s.sid);
      if (!cm) { cm = new Map(); this.carry.set(s.sid, cm); }
      const before = cm.size;
      const evs = historyToEvents(msgs, Math.floor(nowMs / 1000), 1_000_000, cm);
      const newTools = cm.size - before;     // carry grows once per NEW tool call
      if (evs.length) s.mirrorEvents(evs);
      s.mirrorActivity(!endedTurn, newTools, endedTurn);
    }
  }
}
