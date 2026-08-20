// Adoption — existing Claude Code sessions on this machine (terminal, romp, anything
// that wrote a transcript) become beans, so the board shows the agents you actually
// have, not just the ones hive spawned. Pure logic here (tested); hub drives it.
//
// Adopted beans are DORMANT: no client is started until the user sends something —
// hive never elbows into a session some other process might be driving right now.
import { basename } from "node:path";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { toolTitle } from "./session";
import type { ChatEvent } from "./proto";

export interface AdoptRules {
  nowMs: number;
  days: number;     // only sessions touched this recently
  max: number;      // newest-first cap — a board, not an archive
}

// scratch/test cwds whose sessions are noise by construction (our own e2e runs in /tmp)
const SCRATCH_CWD = /^(\/private)?\/tmp(\/|$)|^\/var\/folders\//;

export function pickAdoptable(
  infos: SDKSessionInfo[],
  knownClaudeIds: ReadonlySet<string>,
  rules: AdoptRules,
): SDKSessionInfo[] {
  const cutoff = rules.nowMs - rules.days * 86_400_000;
  // the cap bounds the BOARD, not the scan: only the newest `max` of the window are
  // ever adoptable, and known ids inside that set adopt nothing — they must NOT slide
  // the window deeper (each rescan used to adopt the next `max` down, compounding
  // 12 → 23 across restarts; seen live on 2026-08-19)
  return infos
    .filter((i) => i.sessionId && (i.lastModified || 0) >= cutoff)
    .filter((i) => !!i.cwd && !SCRATCH_CWD.test(i.cwd))
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))
    .slice(0, rules.max)
    .filter((i) => !knownClaudeIds.has(i.sessionId));
}

// The adoption POLICY — pure, tested. Adoption is a MIGRATION AID, not a standing
// sync: while a romp registry exists (the overlap window), scans mirror romp's set;
// on a machine without romp, ONE cold-start scan seeds the board from transcripts;
// after that, hive's own store is the sole owner of the board — deleting romp (or
// this shim's source registry) changes nothing and re-adopts nothing.
export type AdoptMode = "romp" | "generic" | "skip";
export function adoptMode(rompSize: number, coldStartDone: boolean, env: string | undefined): AdoptMode {
  if (env === "0") return "skip";
  if (env === "force") return rompSize > 0 ? "romp" : "generic";
  if (rompSize > 0) return "romp";
  return coldStartDone ? "skip" : "generic";
}

// The romp merge: the board mirrors what romp's dashboard actually SHOWS — the
// sessions its kernel holds (`alive` on the sdk record), plus any session whose
// transcript is STILL BEING WRITTEN (tmux-backend sessions have no sdk record at all;
// an actively-driven one keeps its mtime fresh forever). Measured live 2026-08-19:
// alive gave 12 of the visible 13, the 13th was at 0.0h, and every unwanted straggler
// was ≥2.8h stale — one hour splits them cleanly. Named-but-dead-and-stale sessions
// are romp's past, not its board. Cap bounds it, newest-first, and known ids never
// slide the window deeper.
export const ROMP_GRACE_MS = Number(process.env.HIVE_ROMP_GRACE_H || 1) * 3600_000;

export function pickRompAdoptable(
  infos: SDKSessionInfo[],
  registry: ReadonlyMap<string, { alive: boolean }>,
  knownClaudeIds: ReadonlySet<string>,
  rules: Pick<AdoptRules, "max" | "nowMs">,
): SDKSessionInfo[] {
  return infos
    .filter((i) => {
      const r = i.sessionId ? registry.get(i.sessionId) : undefined;
      return !!r && (r.alive || (i.lastModified || 0) >= rules.nowMs - ROMP_GRACE_MS);
    })
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))
    .slice(0, rules.max)
    .filter((i) => !knownClaudeIds.has(i.sessionId));
}

// a bean's name: the user's own title when they set one, else the project directory —
// short, spatial, how romp users already think of their sessions ("web", "api")
export function adoptName(info: SDKSessionInfo, used: ReadonlySet<string>): string {
  const raw = (info.customTitle || "").trim() || basename(info.cwd || "").trim() || "bee";
  const base = raw.slice(0, 24);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function adoptGoal(info: SDKSessionInfo): string | null {
  // the first line that SAYS something — banner lines of #/=/- decoration carry nothing
  for (const src of [info.summary, info.firstPrompt]) {
    for (const line of (src || "").split("\n")) {
      const t = line.trim();
      if (/[A-Za-z0-9]/.test(t)) return t.slice(0, 96);
    }
  }
  return null;
}

// harness plumbing that reads as noise in a chat backfill (command echoes, caveats)
function isPlumbing(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<command-") || t.startsWith("<local-command") ||
    t.startsWith("Caveat:") || t.startsWith("<system-reminder>") ||
    t.startsWith("[Request interrupted");
}

// The transcript tail as chat events — the SAME vocabulary a live session streams:
// user/assistant text, thinking folds, and tool rows with their inputs and results
// (matched by tool_use_id). The agent keeps the full transcript on resume regardless
// of how much we render.
export function historyToEvents(msgs: SessionMessage[], t: number, cap = 120): ChatEvent[] {
  const out: ChatEvent[] = [];
  const tools = new Map<string, Extract<ChatEvent, { k: "tool" }>>();
  for (const m of msgs) {
    if (m.parent_tool_use_id || m.parent_agent_id) continue;      // subagent internals
    if (m.type !== "user" && m.type !== "assistant") continue;
    const content = (m.message as any)?.content;
    if (typeof content === "string") {
      const text = content.trim();
      if (!text || isPlumbing(text)) continue;
      out.push(m.type === "user"
        ? { k: "user", id: "h-" + m.uuid, t, text: text.slice(0, 4000) }
        : { k: "text", id: "h-" + m.uuid, t, text: text.slice(0, 8000), done: true });
      continue;
    }
    if (!Array.isArray(content)) continue;
    let bi = 0;
    for (const b of content) {
      const id = "h-" + m.uuid + ":" + bi++;
      if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
        const text = b.text.trim();
        if (isPlumbing(text)) continue;
        out.push(m.type === "user"
          ? { k: "user", id, t, text: text.slice(0, 4000) }
          : { k: "text", id, t, text: text.slice(0, 8000), done: true });
      } else if (b?.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
        out.push({ k: "think", id, t, text: b.thinking.trim().slice(0, 8000), done: true });
      } else if (b?.type === "tool_use" && typeof b.id === "string") {
        const ev: Extract<ChatEvent, { k: "tool" }> = {
          k: "tool", id: "h-" + b.id, t, name: String(b.name || "tool"),
          title: toolTitle(String(b.name || "tool"), b.input || {}),
          input: histClip(pretty(b.input), 2000),
          status: "ok",                       // history: assume completed unless the result says otherwise
        };
        tools.set(b.id, ev);
        out.push(ev);
      } else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
        const ev = tools.get(b.tool_use_id);
        if (ev) {
          ev.status = b.is_error ? "err" : "ok";
          ev.output = histClip(resultText(b.content), 4000);
        }
      }
    }
  }
  return out.slice(-cap);
}

function pretty(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? "(image)" : ""))
      .filter(Boolean).join("\n");
  }
  return "";
}

function histClip(s: string, cap: number): string {
  s = s.replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]{64,}/g, "(base64 data)");
  return s.length > cap ? s.slice(0, cap) + `\n… (${s.length - cap} more chars)` : s;
}
