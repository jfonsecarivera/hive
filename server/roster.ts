// The duty SHELF — saved specialists, the ones the user always wants around (an eta
// tracker, a manager, a bottleneck hunter). A plain JSON file is the source of truth:
// ~/.hive/duties.json, editable by hand, by agents, by git.
//   { "eta": { "every": "10m", "prompt": "…", "model": "haiku", "effort": "low", "cwd": "~" } }
// The shelf shows in the tray; DRAGGING a specialist onto a hexagon hires it (session +
// duty + hat), trashing its bean dismisses the instance (the shelf keeps the
// specialist), and dragging the shelf chip itself to the trash removes it for good.
// /duty save adds the current session's job to the shelf.
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
    if (typeof e.every !== "string" || (e.every !== "self" && parseEvery(e.every) === null)) continue;
    // a hand-written entry may carry romp's /loop habit — duties already loop
    const prompt = e.prompt.replace(/^\s*\/loop\s+/, "");
    out.set(name.trim(), {
      every: e.every, prompt,
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

// NOTE deliberately ABSENT: auto-summon/reconcile. The shelf never hires by itself
// (the user 2026-08-19, who ended eta minutes after it self-summoned: "take them
// whenever I want") — a specialist joins the board only through the user's own drag.
