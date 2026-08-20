import { describe, expect, test } from "bun:test";
import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { adoptGoal, adoptMode, adoptName, historyToEvents, pickAdoptable } from "../server/adopt";

describe("adoptMode — adoption is a migration aid, not a standing sync", () => {
  test("romp present → mirror it (the overlap window)", () => {
    expect(adoptMode(75, false, undefined)).toBe("romp");
    expect(adoptMode(75, true, undefined)).toBe("romp");
  });

  test("romp gone after the cold start → SKIP: hive's store owns the board", () => {
    expect(adoptMode(0, true, undefined)).toBe("skip");
  });

  test("no romp, never seeded → one generic cold-start scan", () => {
    expect(adoptMode(0, false, undefined)).toBe("generic");
  });

  test("HIVE_ADOPT=0 disables; =force rescans regardless of the stamp", () => {
    expect(adoptMode(75, false, "0")).toBe("skip");
    expect(adoptMode(0, true, "force")).toBe("generic");
    expect(adoptMode(75, true, "force")).toBe("romp");
  });
});

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

  test("the cap bounds the BOARD: known ids inside the top-N never slide the window deeper", () => {
    const infos = [1, 2, 3, 4].map((n) => info({ sessionId: "s" + n, lastModified: NOW - n * DAY }));
    // first scan adopted s1+s2; a rescan must adopt NOTHING, not s3+s4
    const picks = pickAdoptable(infos, new Set(["s1", "s2"]), { nowMs: NOW, days: 7, max: 2 });
    expect(picks).toEqual([]);
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

  test("keeps the full main-thread story: text, thinking, tools with results", () => {
    const evs = historyToEvents([
      msg("user", "build the parser"),
      msg("assistant", [
        { type: "thinking", thinking: "plan it out" },
        { type: "text", text: "On it." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "make parser" } },
      ]),
      msg("user", [{ type: "tool_result", tool_use_id: "t1", content: "built fine" }]),
      msg("assistant", [{ type: "text", text: "sub" }], { parent_agent_id: "agent-1" }),
      msg("user", "<command-name>/clear</command-name>"),
      msg("user", "Caveat: local commands below"),
      msg("assistant", [{ type: "text", text: "Done — parser builds." }]),
    ], 500);
    expect(evs.map((e) => e.k)).toEqual(["user", "think", "text", "tool", "text"]);
    const tool = evs[3] as any;
    expect(tool.title).toBe("$ make parser");
    expect(tool.status).toBe("ok");
    expect(tool.output).toBe("built fine");
    expect(evs.every((e) => e.t === 500)).toBe(true);
  });

  test("a failed tool result marks the row err; a resultless tool stays ok", () => {
    const evs = historyToEvents([
      msg("assistant", [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/b" } },
      ]),
      msg("user", [{ type: "tool_result", tool_use_id: "t1", content: "no such file", is_error: true }]),
    ], 1);
    expect((evs[0] as any).status).toBe("err");
    expect((evs[1] as any).status).toBe("ok");
  });

  test("caps to the tail", () => {
    const many = Array.from({ length: 80 }, (_, i) => msg("user", "m" + i));
    const evs = historyToEvents(many, 1, 10);
    expect(evs.length).toBe(10);
    expect((evs[9] as any).text).toBe("m79");
  });
});
