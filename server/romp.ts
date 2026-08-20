// Romp interop — when this machine runs (or ran) romp, its state directory is the
// authoritative registry of the user's sessions: names/<claude-session-id> holds
// "name⇥cwd⇥#bg⇥fg", and sdk/<sid>.json adds model/effort/mode/spawnedAt for
// SDK-backed ones. Mirroring it means hive's board shows THE SAME sessions, wearing
// THE SAME names and colors, as the romp dashboard the user is switching from.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RompSession {
  id: string;                 // the claude session id (names/ filename)
  ids: string[];              // every claude id this session has worn (sid + lastSid)
  name: string;
  cwd: string;
  bg: string;                 // identity color; "" when unparsable
  fg: string;
  model?: string;
  effort?: string;
  permMode?: string;
  spawnedAt?: number;         // epoch seconds
}

const FG_WORDS: Record<string, string> = { black: "#10141a", white: "#ffffff" };

export function rompStateDir(): string {
  return process.env.HIVE_ROMP_DIR || join(process.env.HOME || ".", ".local/state/romp");
}

export function readRompRegistry(dir = rompStateDir()): Map<string, RompSession> {
  const out = new Map<string, RompSession>();
  let files: string[];
  try { files = readdirSync(join(dir, "names")); } catch { return out; }   // no romp here
  for (const f of files) {
    if (!/^[0-9a-f-]{36}$/i.test(f)) continue;
    try {
      // split BEFORE trimming: a whole-line trim eats an empty leading field and
      // shifts every column over
      const [name, cwd, bg, fg] = readFileSync(join(dir, "names", f), "utf8")
        .split("\n")[0].split("\t").map((v) => (v || "").trim());
      if (!name) continue;
      const rec: RompSession = {
        id: f, ids: [f], name, cwd: cwd || "",
        bg: /^#[0-9a-fA-F]{6}$/.test(bg) ? bg : "",
        fg: FG_WORDS[fg] || (fg.startsWith("#") ? fg : "#ffffff"),
      };
      let lastSid = "";
      try {
        const sdk = JSON.parse(readFileSync(join(dir, "sdk", f + ".json"), "utf8"));
        if (typeof sdk.model === "string" && sdk.model) rec.model = sdk.model;
        if (typeof sdk.effort === "string" && sdk.effort) rec.effort = sdk.effort;
        if (typeof sdk.mode === "string" && sdk.mode) rec.permMode = sdk.mode;
        if (Number.isFinite(sdk.spawnedAt)) rec.spawnedAt = Number(sdk.spawnedAt);
        if (typeof sdk.lastSid === "string") lastSid = sdk.lastSid;
      } catch { /* a tmux-backend session: the names line is all there is */ }
      out.set(f, rec);
      // a /clear (or certain restarts) moves the LIVE transcript to a new claude id —
      // romp tracks it as lastSid; index it too so the current transcript still matches
      if (lastSid && lastSid !== f && !out.has(lastSid)) {
        rec.ids.push(lastSid);
        out.set(lastSid, rec);
      }
    } catch { /* one unreadable entry never blocks the rest */ }
  }
  return out;
}
