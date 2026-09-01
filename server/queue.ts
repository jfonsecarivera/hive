// The work queue — the user's brain-dumped backlog, drained by idle beans. /queue <task>
// files work; the hub hands the FRONT of the queue to a bean the moment its state lands
// on "ready" (the state-change event — never a timer) or the moment a task is filed
// while one already sits ready. Feeding only, never hiring: the queue works the beans
// the user already dragged onto the board — it cannot summon (the shelf rule), and it
// only feeds hive-born beans — never an adopted one (someone else's conversation on
// display), never a spawned worker (its idle time belongs to its spawner), never a duty
// bean (its loop owns its idle time). Pure logic here (tested); hub owns the store and
// the triggers.

export type QueueCommand =
  | { kind: "add"; tasks: string[] }
  | { kind: "clear" }
  | { kind: "status" };

export function parseQueueCommand(text: string): QueueCommand | null {
  const t = text.trim();
  if (!/^\/queue(\s|$)/.test(t)) return null;
  const rest = t.slice("/queue".length).trim();
  if (!rest) return { kind: "status" };
  if (rest === "clear") return { kind: "clear" };
  return { kind: "add", tasks: splitTasks(rest) };
}

// a pasted list (every line bulleted or numbered) is a brain-dump: one task per line;
// anything else is ONE task, newlines and all
const ITEM = /^(?:[-*]|\d+[.)])\s+/;

export function splitTasks(rest: string): string[] {
  const lines = rest.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((l) => ITEM.test(l))) {
    return lines.map((l) => l.replace(ITEM, ""));
  }
  return [rest];
}

// Who takes the front of the queue: a READY bean, or an OPENING one — "opening" is a
// fresh bean with no work yet by construction (a prompt at birth flips it straight to
// working), and its client doesn't even spawn until a first message arrives, so a
// dragged-but-silent bean would otherwise never hatch into the backlog. Never awaiting
// (a question for the user outranks the backlog), blocked (new work would bury its own
// failure), or mid-anything — and no standing duty, not adopted, not holding a steer
// (the user's redirect outranks the queue). Longest idle goes first.
export interface WorkerView {
  sid: string;
  state: string;
  duty: boolean;
  origin: string;                // only "hive" beans take queue work
  steering: boolean;
  lastT: number;
}

export function pickWorker(ws: WorkerView[]): string | null {
  let best: WorkerView | null = null;
  for (const w of ws) {
    if ((w.state !== "ready" && w.state !== "opening") || w.duty || w.origin !== "hive" || w.steering) continue;
    if (!best || w.lastT < best.lastT) best = w;
  }
  return best ? best.sid : null;
}

export function queueStatus(tasks: string[]): string {
  if (!tasks.length) return 'the queue is empty — "/queue <task>" files work for the next idle bean';
  const head = tasks.slice(0, 5).map((task, i) => `${i + 1}. ${task.split("\n")[0].slice(0, 100)}`);
  const more = tasks.length > 5 ? `\n… and ${tasks.length - 5} more` : "";
  return `${tasks.length} task${tasks.length === 1 ? "" : "s"} in the queue:\n${head.join("\n")}${more}`;
}
