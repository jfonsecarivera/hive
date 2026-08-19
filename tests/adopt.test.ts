import { describe, expect, test } from "bun:test";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { adoptGoal, adoptName, historyToEvents, pickAdoptable } from "../server/adopt";

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

function info(over: Partial<SDKSessionInfo>): SDKSessionInfo {
  return {
    sessionId: "11111111-2222-3333-4444-555555555555",
    summary: "Fix the flaky import test",
    lastModified: NOW - DAY,
    cwd: "/home/user/dev/notes-api",
    ...over,
  } as SDKSessionInfo;
}

describe("pickAdoptable", () => {
  test("windows by recency, caps newest-first, skips known ids and scratch cwds", () => {
    const infos = [
      info({ sessionId: "a1", lastModified: NOW - DAY }),
      info({ sessionId: "a2", lastModified: NOW - 30 * DAY }),          // too old
      info({ sessionId: "a3", lastModified: NOW - 2 * DAY }),
      info({ sessionId: "known", lastModified: NOW }),                  // hive already has it
      info({ sessionId: "a4", cwd: "/tmp", lastModified: NOW }),        // scratch
      info({ sessionId: "a5", cwd: "/private/tmp/x", lastModified: NOW }),
      info({ sessionId: "a6", cwd: "", lastModified: NOW }),            // no cwd → skip
    ];
    const picks = pickAdoptable(infos, new Set(["known"]), { nowMs: NOW, days: 7, max: 10 });
    expect(picks.map((p) => p.sessionId)).toEqual(["a1", "a3"]);
  });

  test("cap keeps the newest", () => {
    const infos = [1, 2, 3].map((n) => info({ sessionId: "s" + n, lastModified: NOW - n * DAY }));
    const picks = pickAdoptable(infos, new Set(), { nowMs: NOW, days: 7, max: 2 });
    expect(picks.map((p) => p.sessionId)).toEqual(["s1", "s2"]);
  });
});

describe("adoptName / adoptGoal", () => {
  test("customTitle wins, else the project directory; collisions suffix", () => {
    expect(adoptName(info({ customTitle: "web" }), new Set())).toBe("web");
    expect(adoptName(info({}), new Set())).toBe("notes-api");
    expect(adoptName(info({}), new Set(["notes-api", "notes-api-2"]))).toBe("notes-api-3");
  });

  test("goal is the summary's first MEANINGFUL line, else the first prompt's", () => {
    expect(adoptGoal(info({}))).toBe("Fix the flaky import test");
    expect(adoptGoal(info({ summary: "", firstPrompt: "add retry logic\nplease" })))
      .toBe("add retry logic");
    expect(adoptGoal(info({ summary: "#####\n=====\nreal task here" }))).toBe("real task here");
    expect(adoptGoal(info({ summary: "####", firstPrompt: "do the thing" }))).toBe("do the thing");
    expect(adoptGoal(info({ summary: "", firstPrompt: "" }))).toBeNull();
  });
});

describe("historyToEvents", () => {
  const msg = (type: "user" | "assistant", content: unknown, over: Partial<SessionMessage> = {}): SessionMessage => ({
    type, uuid: "u-" + Math.random().toString(36).slice(2, 8), session_id: "s",
    message: { role: type, content }, parent_tool_use_id: null, parent_agent_id: null,
    ...over,
  } as SessionMessage);

  test("keeps main-thread text, drops tool results, subagents, and plumbing", () => {
    const evs = historyToEvents([
      msg("user", "build the parser"),
      msg("assistant", [{ type: "text", text: "On it." }, { type: "tool_use", id: "t", name: "Bash", input: {} }]),
      msg("user", [{ type: "tool_result", tool_use_id: "t", content: "ok" }]),   // no text → dropped
      msg("assistant", [{ type: "text", text: "sub" }], { parent_agent_id: "agent-1" }),
      msg("user", "<command-name>/clear</command-name>"),
      msg("user", "Caveat: local commands below"),
      msg("assistant", [{ type: "text", text: "Done — parser builds." }]),
    ], 500);
    expect(evs.map((e) => e.k)).toEqual(["user", "text", "text"]);
    expect((evs[0] as any).text).toBe("build the parser");
    expect((evs[2] as any).text).toBe("Done — parser builds.");
    expect(evs.every((e) => e.t === 500)).toBe(true);
  });

  test("caps to the tail", () => {
    const many = Array.from({ length: 80 }, (_, i) => msg("user", "m" + i));
    const evs = historyToEvents(many, 1, 10);
    expect(evs.length).toBe(10);
    expect((evs[9] as any).text).toBe("m79");
  });
});
