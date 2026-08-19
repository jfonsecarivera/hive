// Adoption — existing Claude Code sessions on this machine (terminal, romp, anything
// that wrote a transcript) become beans, so the board shows the agents you actually
// have, not just the ones hive spawned. Pure logic here (tested); hub drives it.
//
// Adopted beans are DORMANT: no client is started until the user sends something —
// hive never elbows into a session some other process might be driving right now.
import { basename } from "node:path";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
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
  return infos
    .filter((i) => i.sessionId && !knownClaudeIds.has(i.sessionId))
    .filter((i) => (i.lastModified || 0) >= cutoff)
    .filter((i) => !!i.cwd && !SCRATCH_CWD.test(i.cwd))
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))
    .slice(0, rules.max);
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
  const g = (info.summary || info.firstPrompt || "").trim().split("\n")[0].slice(0, 96);
  return g || null;
}

// harness plumbing that reads as noise in a chat backfill (command echoes, caveats)
function isPlumbing(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("<command-") || t.startsWith("<local-command") ||
    t.startsWith("Caveat:") || t.startsWith("<system-reminder>") ||
    t.startsWith("[Request interrupted");
}

function textOf(message: unknown): string {
  const m = message as any;
  const c = m?.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text).join("\n");
}

// The transcript tail as chat events: main-thread user/assistant text only — enough to
// recognize the conversation at a glance. The full mechanics live in the transcript
// itself, and the agent keeps ALL of it on resume regardless of what we show.
export function historyToEvents(msgs: SessionMessage[], t: number, cap = 60): ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const m of msgs) {
    if (m.parent_tool_use_id || m.parent_agent_id) continue;      // subagent internals
    if (m.type !== "user" && m.type !== "assistant") continue;
    const text = textOf(m.message).trim();
    if (!text || isPlumbing(text)) continue;
    out.push(m.type === "user"
      ? { k: "user", id: "h-" + m.uuid, t, text: text.slice(0, 4000) }
      : { k: "text", id: "h-" + m.uuid, t, text: text.slice(0, 8000), done: true });
  }
  return out.slice(-cap);
}
