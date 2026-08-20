// The duty roster — SAVED duties, the ones the user always wants (an eta tracker, a
// board steward). A plain JSON file is the source of truth: ~/.hive/duties.json,
// editable by hand, by agents, by git. Hive RECONCILES against it at boot and on a
// slow tick — a saved duty whose bean is missing gets re-summoned, hat and all.
//   { "eta": { "every": "10m", "prompt": "…", "model": "haiku", "effort": "low", "cwd": "~" } }
// Composer and file stay in sync: /duty save writes an entry, /duty off (and trashing
// the bean) removes it, editing the file applies within a reconcile tick.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RosterEntry {
  every: string;                 // "10m" / "2h" / "90s"
  prompt: string;
  model?: string;
  effort?: string;
  cwd?: string;
}

const UNIT_S: Record<string, number> = { s: 1, m: 60, h: 3600 };

export function parseEvery(v: string): number | null {
  const m = /^(\d+)\s*(s|m|h)$/.exec(v.trim());
  if (!m) return null;
  const s = Number(m[1]) * UNIT_S[m[2]];
  return s >= 60 ? s : null;
}

export function fmtEvery(everyS: number): string {
  return everyS % 3600 === 0 ? `${everyS / 3600}h` : everyS % 60 === 0 ? `${everyS / 60}m` : `${everyS}s`;
}

export function rosterPath(): string {
  return join(process.env.HIVE_HOME || join(process.env.HOME || ".", ".hive"), "duties.json");
}

export function loadRoster(path = rosterPath()): Map<string, RosterEntry> {
  const out = new Map<string, RosterEntry>();
  let raw: string;
  try { raw = readFileSync(path, "utf8"); } catch { return out; }   // no roster yet
  let d: unknown;
  try { d = JSON.parse(raw); } catch {
    console.error(`roster: ${path} is not valid JSON — leaving it alone, running without saved duties`);
    return out;
  }
  if (!d || typeof d !== "object") return out;
  for (const [name, v] of Object.entries(d as Record<string, unknown>)) {
    const e = v as Partial<RosterEntry>;
    if (!name.trim() || !e || typeof e.prompt !== "string" || !e.prompt.trim()) continue;
    if (typeof e.every !== "string" || parseEvery(e.every) === null) continue;
    out.set(name.trim(), {
      every: e.every, prompt: e.prompt,
      ...(typeof e.model === "string" && e.model ? { model: e.model } : {}),
      ...(typeof e.effort === "string" && e.effort ? { effort: e.effort } : {}),
      ...(typeof e.cwd === "string" && e.cwd ? { cwd: e.cwd } : {}),
    });
  }
  return out;
}

export function saveRoster(m: Map<string, RosterEntry>, path = rosterPath()) {
  const o: Record<string, RosterEntry> = {};
  for (const [k, v] of m) o[k] = v;
  writeFileSync(path, JSON.stringify(o, null, 2) + "\n");
}

// What reconciliation should DO, given the roster and the live world — pure, tested.
// The file is authoritative for saved duties: a missing bean is summoned, a missing or
// drifted duty is (re)applied. Live sessions the roster doesn't name are untouched.
export interface LiveDutyView { name: string; everyS: number | null; prompt: string | null }
export type RosterAction =
  | { act: "summon"; name: string; entry: RosterEntry }
  | { act: "apply"; name: string; everyS: number; prompt: string };

export function reconcileActions(roster: Map<string, RosterEntry>, live: LiveDutyView[]): RosterAction[] {
  const byName = new Map(live.map((l) => [l.name, l] as const));
  const out: RosterAction[] = [];
  for (const [name, entry] of roster) {
    const everyS = parseEvery(entry.every);
    if (everyS === null) continue;
    const l = byName.get(name);
    if (!l) { out.push({ act: "summon", name, entry }); continue; }
    if (l.everyS !== everyS || l.prompt !== entry.prompt) {
      out.push({ act: "apply", name, everyS, prompt: entry.prompt });
    }
  }
  return out;
}
