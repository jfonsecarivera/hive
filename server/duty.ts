// Duties — the standing jobs. A duty is a session with a job description and a cadence:
// hive wakes it each round WHEN IT'S IDLE (the schedule proposes, the session's state
// disposes — rounds never pile onto a running turn), revives it if its client died, and
// retires it when its bean is trashed. Created in the session's own composer:
//   /duty every 10m <the job, in your words>
//   /duty            → status
//   /duty off        → retire
// Pure logic here (tested); hub owns the ticker and the store.

export interface DutySpec { everyS: number; prompt: string }

export type DutyCommand =
  | { kind: "set"; spec: DutySpec }
  | { kind: "save" }
  | { kind: "off" }
  | { kind: "status" }
  | { kind: "error"; message: string };

const UNIT_S: Record<string, number> = { s: 1, m: 60, h: 3600 };
export const DUTY_MIN_S = 60;

export function parseDutyCommand(text: string): DutyCommand | null {
  const t = text.trim();
  if (!/^\/duty(\s|$)/.test(t)) return null;
  const rest = t.slice("/duty".length).trim();
  if (!rest) return { kind: "status" };
  if (rest === "off" || rest === "stop") return { kind: "off" };
  if (rest === "save") return { kind: "save" };
  const m = /^every\s+(\d+)\s*(s|m|h)\s+([\s\S]+)$/.exec(rest);
  if (!m) {
    return { kind: "error", message: 'usage: "/duty every 10m <the job>" · "/duty save" · "/duty off" · "/duty"' };
  }
  const everyS = Number(m[1]) * UNIT_S[m[2]];
  if (everyS < DUTY_MIN_S) return { kind: "error", message: "the shortest round is every 1m" };
  const prompt = m[3].trim();
  if (!prompt) return { kind: "error", message: "a duty needs the job written out" };
  return { kind: "set", spec: { everyS, prompt } };
}

// May this round fire now? The deciding facts: the cadence is due, and the session is
// IDLE. A working/compacting session keeps its round for the next tick (no pile-ups);
// an awaiting one holds too — a question for the user outranks the schedule.
const IDLE_STATES = new Set(["ready", "awaitingBg", "blocked"]);

export function dutyDue(lastRunT: number, everyS: number, state: string, nowS: number): boolean {
  if (nowS - lastRunT < everyS) return false;
  return IDLE_STATES.has(state);
}

export function dutyLine(everyS: number, lastRunT: number, nowS: number): string {
  const next = Math.max(0, lastRunT + everyS - nowS);
  const fmt = (s: number) => s >= 3600 ? `${Math.round(s / 3600)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
  return `on duty, every ${fmt(everyS)} — next round in ${fmt(next)}`;
}
