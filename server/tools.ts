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
