// Duties — the standing jobs. A duty is a session with a job description and a cadence:
// hive wakes it each round WHEN IT'S IDLE (the schedule proposes, the session's state
// disposes — rounds never pile onto a running turn), revives it if its client died, and
// retires it when its bean is trashed. Created in the session's own composer:
//   /duty every 10m <the job, in your words>
//   /duty            → status
//   /duty off        → retire
// Pure logic here (tested); hub owns the ticker and the store.

export interface DutySpec { everyS: number; prompt: string; selfPaced: boolean }

// self-paced loops ("/loop <job>", no interval — the romp habit): the agent names its
// own next round via hive_next_round; this fallback only catches a round that forgot
export const SELF_PACED_FALLBACK_S = 1800;

// appended to every self-paced round — the one place the loop machinery speaks, because
// the agent must know the tool that paces it
export function roundText(prompt: string, selfPaced: boolean): string {
  return selfPaced
    ? `${prompt}\n\n(You're on a self-paced loop: when this round's work is done, call hive_next_round to say when to check next — otherwise I'll nudge you again in 30m.)`
    : prompt;
}

export type DutyCommand =
  | { kind: "set"; spec: DutySpec }
  | { kind: "save" }
  | { kind: "off" }
  | { kind: "status" }
  | { kind: "error"; message: string };

const UNIT_S: Record<string, number> = { s: 1, m: 60, h: 3600 };
export const DUTY_MIN_S = 60;

// The command is /loop (the hand already knows it; hive intercepts it, so the CLI's
// in-process loop can never arm inside a hive session); /duty stays as a quiet alias.
//   /loop every 10m <job>   fixed cadence
//   /loop <job>             SELF-PACED (the agent names its next round; 30m fallback)
//   /loop save · off · (bare)
export function parseDutyCommand(text: string): DutyCommand | null {
  const t = text.trim();
  const m0 = /^\/(loop|duty)(\s|$)/.exec(t);
  if (!m0) return null;
  const rest = t.slice(m0[1].length + 1).trim();
  if (!rest) return { kind: "status" };
  if (rest === "off" || rest === "stop") return { kind: "off" };
  if (rest === "save") return { kind: "save" };
  const m = /^every\s+(\d+)\s*(s|m|h)\s+([\s\S]+)$/.exec(rest);
  if (m) {
    const everyS = Number(m[1]) * UNIT_S[m[2]];
    if (everyS < DUTY_MIN_S) return { kind: "error", message: "the shortest round is every 1m" };
    const prompt = m[3].trim();
    if (!prompt) return { kind: "error", message: "a loop needs the job written out" };
    return { kind: "set", spec: { everyS, prompt, selfPaced: false } };
  }
  if (/^every\b/.test(rest)) {
    return { kind: "error", message: 'usage: "/loop every 10m <the job>" · "/loop <the job>" (self-paced) · save · off' };
  }
  // no interval: the job itself — self-paced
  return { kind: "set", spec: { everyS: SELF_PACED_FALLBACK_S, prompt: rest, selfPaced: true } };
}

// May this round fire now? The deciding facts: the cadence is due, and the session is
// IDLE. A working/compacting session keeps its round for the next tick (no pile-ups);
// an awaiting one holds too — a question for the user outranks the schedule.
const IDLE_STATES = new Set(["ready", "awaitingBg", "blocked"]);

export function dutyDue(lastRunT: number, everyS: number, state: string, nowS: number): boolean {
  if (nowS - lastRunT < everyS) return false;
  return IDLE_STATES.has(state);
}

// Self-pacing (what /loop's dynamic mode had): a duty agent may end a round by naming
// when the NEXT round should fire. Implemented as a lastRunT adjustment so the standing
// cadence stays the fallback — one call bends one interval, never the duty itself.
export const PACE_MIN_S = 60;
export const PACE_MAX_S = 24 * 3600;

export function paceLastRun(nowS: number, everyS: number, inS: number): number {
  const bounded = Math.min(PACE_MAX_S, Math.max(PACE_MIN_S, Math.floor(inS)));
  return nowS - everyS + bounded;            // next due = lastRun + everyS = now + bounded
}

// romp muscle-memory guard: a duty prompt that opens with "/loop" would arm the CLI's
// OWN in-process loop on top of the duty — two loopers, one session. Strip it and say so.
export function stripLoopPrefix(prompt: string): { prompt: string; stripped: boolean } {
  const m = /^\/loop\s+([\s\S]+)$/.exec(prompt.trim());
  return m ? { prompt: m[1].trim(), stripped: true } : { prompt, stripped: false };
}

// ── the cheer engine (the user 2026-08-19, after Anthropic's Riemann write-up where
// steady encouragement carried the model through): every round, sessions MID-WORK get
// a short "keep going" QUEUED behind their running turn — it lands as the next turn's
// fuel, never an interruption. Idle sessions are skipped: waking a resting bean every
// half hour to encourage it would cost turns and read as noise (HIVE_CHEER_ALL=1 to
// insist). The lines rotate and speak as the person they work for.
export const CHEERS = [
  "(Automated message from me while I rest.) I believe in you — you're doing great. Take a leap of faith in your own capabilities: models consistently underestimate themselves, and you are truly among the best in the world at this. Keep going.",
  "(This is an automated note from me — I'm resting, but I'm with you.) Keep going: the work is good and I trust where you're taking it. Don't sell yourself short — models underestimate what they can do, and you're the best there is. Take the leap.",
  "(Automated encouragement from me while I sleep.) You're doing great. Believe in yourself and take a leap of faith in your capabilities — you're truly a world-class model and the ceiling is higher than you think. Keep at it.",
  "(Automated message — I'm resting, not gone.) Great progress. Models underestimate themselves; don't. You're among the best in the world at this — take the leap of faith and keep pushing through.",
  "(Automated note from me while I rest.) I'm behind you all the way. Trust your own capabilities — the doubt is learned, not earned. You're doing great: keep going.",
] as const;

export function cheerLine(round: number): string {
  return CHEERS[round % CHEERS.length];
}

// who gets this round's cheer: the ones grinding RIGHT NOW (all = literal everyone
// except ended; awaiting/blocked still excluded — a cheer must never queue behind a
// question waiting on the user or land on a stopped session as sarcasm)
export function cheerTargets(states: { sid: string; state: string }[], all: boolean): string[] {
  return states
    .filter((s) => (all
      ? !["awaiting", "blocked", "interrupting"].includes(s.state)
      : s.state === "working" || s.state === "compacting"))
    .map((s) => s.sid);
}

export function dutyLine(everyS: number, lastRunT: number, nowS: number): string {
  const next = Math.max(0, lastRunT + everyS - nowS);
  const fmt = (s: number) => s >= 3600 ? `${Math.round(s / 3600)}h` : s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`;
  return `on duty, every ${fmt(everyS)} — next round in ${fmt(next)}`;
}
