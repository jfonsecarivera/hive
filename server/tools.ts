// The hive MCP server — the tools every hive session gets for working WITH the other
// agents on this board. This is what makes a standing "manager" duty real: it can see
// the board (live hub state, not scraping), read a teammate's recent chat, and drop a
// message into a teammate's turn. In-process (createSdkMcpServer): no sockets, no auth.
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ChatEvent } from "./proto";

// what the tools need from the hub — narrow on purpose, so this stays testable
export interface BoardAccess {
  list(): { name: string; state: string; goal: string | null; idleS: number; duty: boolean }[];
  read(name: string, n: number): ChatEvent[] | null;     // null = no such session
  send(from: string, name: string, message: string): string | null;   // error string | null = ok
  nextRound(fromSid: string, inS: number): string;       // self-pacing; returns the confirmation/error line
  notify(fromSid: string, message: string): Promise<string>;   // ping the USER (rate-limited)
  eta(fromSid: string, name: string | undefined, patch: Record<string, string | undefined>): string;
  spawn(fromSid: string, o: { name: string; prompt: string; model?: string; cwd?: string }): { ok: boolean; text: string };
}

// the notify spam guard — an agent loop must never be able to flood the user's phone.
// Sliding window, per session; pure so the policy is tested.
export const NOTIFY_MAX_PER_HOUR = 4;

export function notifyAllowed(sentAtMs: number[], nowMs: number): { ok: boolean; kept: number[] } {
  const kept = sentAtMs.filter((t) => nowMs - t < 3600_000);
  return { ok: kept.length < NOTIFY_MAX_PER_HOUR, kept };
}

// the spawn guard — an agent loop must never be able to flood the board with beans.
// Name collisions suffix rather than fail: two managers wanting "evals" both get one.
export const SPAWN_MAX_LIVE = 16;

export function spawnPlan(liveNames: string[], want: string, max = SPAWN_MAX_LIVE):
  { ok: true; name: string } | { ok: false; reason: string } {
  const name = want.trim();
  if (!name) return { ok: false, reason: "a spawned session needs a name" };
  if (liveNames.length >= max) {
    return { ok: false, reason: `the board is full (${liveNames.length} live sessions, cap ${max}) — a bean must finish and be dismissed first` };
  }
  const used = new Set(liveNames);
  if (!used.has(name)) return { ok: true, name };
  let n = 2;
  while (used.has(`${name}-${n}`)) n++;
  return { ok: true, name: `${name}-${n}` };
}

export function renderEvents(evs: ChatEvent[]): string {
  const lines: string[] = [];
  for (const ev of evs) {
    if (ev.k === "user") lines.push(`user: ${ev.text}`);
    else if (ev.k === "text") lines.push(`assistant: ${ev.text}`);
    else if (ev.k === "tool") lines.push(`  [tool] ${ev.title}${ev.status === "err" ? " (failed)" : ""}`);
    else if (ev.k === "note") lines.push(`  (${ev.text})`);
  }
  return lines.join("\n") || "(no recent messages)";
}

export function hiveMcpServer(self: string, board: BoardAccess): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "hive",
    version: "1.0.0",
    tools: [
      tool(
        "hive_board",
        "List every agent session on this machine's hive board: name, current state, what it's on, how long it has been idle, and whether it runs a standing duty.",
        {},
        async () => {
          const rows = board.list().map((s) =>
            `${s.name}${s.duty ? " [duty]" : ""} — ${s.state}${s.idleS > 60 ? ` (idle ${Math.round(s.idleS / 60)}m)` : ""}` +
            (s.goal ? ` — on: ${s.goal}` : ""));
          return { content: [{ type: "text", text: rows.join("\n") || "(empty board)" }] };
        },
      ),
      tool(
        "hive_read",
        "Read the recent conversation of another session on the board, newest last. Use it to understand what a teammate is doing before acting on it.",
        { name: z.string().describe("the session's name as hive_board lists it"),
          count: z.number().int().min(1).max(30).default(15) },
        async (a) => {
          const evs = board.read(a.name, a.count);
          if (evs === null) return { content: [{ type: "text", text: `no session named "${a.name}" on this board` }], isError: true };
          return { content: [{ type: "text", text: renderEvents(evs) }] };
        },
      ),
      tool(
        "hive_eta",
        "Publish or update an ETA record on the user's board. Only the fields you pass change; pass an empty string to clear one. Write your OWN eta (omit name) or a teammate's (an eta-keeper duty does this for everyone). eta_iso drives a live countdown on the user's phone — set it whenever you can estimate a real finish time.",
        {
          name: z.string().optional().describe("which session this is about; omit for yourself"),
          gist: z.string().max(200).optional().describe("the one-liner the board leads with"),
          task: z.string().max(200).optional(),
          eta_text: z.string().max(200).optional().describe('human phrasing, e.g. "~2:30 PM PT, after evals"'),
          eta_iso: z.string().max(40).optional().describe("machine deadline, ISO-8601 UTC, e.g. 2026-08-20T21:30:00Z"),
          conf: z.string().max(20).optional().describe("high / med / low"),
          status: z.string().max(20).optional().describe("working | pending | done | blocked | idle | gone"),
          detail: z.string().max(600).optional(),
          milestone: z.string().max(600).optional(),
        },
        async (a) => {
          const { name, ...rest } = a;
          return { content: [{ type: "text", text: board.eta(self, name, rest as Record<string, string | undefined>) }] };
        },
      ),
      tool(
        "hive_notify",
        "Send a short notification to the USER'S PHONE. This interrupts a human: use it only when something truly needs them — a failure they must know about, work blocked on a decision only they can make, or a completion they explicitly asked to be told about. Routine progress never qualifies; the board already shows it. Rate-limited.",
        { message: z.string().min(1).max(500).describe("1-3 lines: lead with status (done / failed / needs you), then what and where") },
        async (a) => ({ content: [{ type: "text", text: await board.notify(self, a.message) }] }),
      ),
      tool(
        "hive_next_round",
        "Only meaningful if you run a standing duty (a job on a loop). Call it at the END of a round to choose when your next round fires, based on what you just saw — e.g. a build 50 minutes from done deserves one check in 30m, not six on the default cadence. One call bends one interval; your standing cadence stays the fallback. Bounds: 1 minute to 24 hours.",
        { in_seconds: z.number().int().min(1).describe("seconds until your next round"),
          reason: z.string().max(200).describe("one short line: why this timing") },
        async (a) => ({ content: [{ type: "text", text: board.nextRound(self, a.in_seconds) }] }),
      ),
      tool(
        "hive_spawn",
        "Create a NEW session on this hive board — a real bean the user can see, watch, and steer. Use this instead of in-process subagents whenever you delegate work: delegated work must be visible on the board. The new session starts on your prompt immediately and shares NONE of your context, so the prompt must carry the full brief. Tell it to report back to you by name with hive_send. It runs in your working directory unless you pass another. A taken name gets a numeric suffix; the result names the bean actually created.",
        { name: z.string().min(1).max(40).describe("short kebab-case name for the bean, e.g. welfare-evals"),
          prompt: z.string().min(1).max(8000).describe("the full task brief, self-contained — the new session knows nothing you don't tell it"),
          model: z.string().optional().describe("fable | opus | sonnet | haiku — omit for the hive default"),
          cwd: z.string().optional().describe("working directory; omit to use your own") },
        async (a) => {
          const r = board.spawn(self, { name: a.name, prompt: a.prompt, model: a.model, cwd: a.cwd });
          return { content: [{ type: "text", text: r.text }], ...(r.ok ? {} : { isError: true }) };
        },
      ),
      tool(
        "hive_send",
        "Send a message into another session on the board. It lands as a normal request in their conversation, marked as coming from you. Starts their turn if they were idle. Never message yourself.",
        { name: z.string().describe("the target session's name"),
          message: z.string().min(1).max(4000) },
        async (a) => {
          const err = board.send(self, a.name, a.message);
          if (err) return { content: [{ type: "text", text: err }], isError: true };
          return { content: [{ type: "text", text: `delivered to ${a.name}` }] };
        },
      ),
    ],
  });
}
