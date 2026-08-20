import { describe, expect, test } from "bun:test";
import { dutyDue, dutyLine, parseDutyCommand } from "../server/duty";
import { renderEvents } from "../server/tools";

describe("parseDutyCommand", () => {
  test("set / off / status / error forms", () => {
    expect(parseDutyCommand("/duty every 10m Check every session and unstick the blocked ones."))
      .toEqual({ kind: "set", spec: { everyS: 600, prompt: "Check every session and unstick the blocked ones." } });
    expect(parseDutyCommand("/duty every 2h summarize the board")).toEqual(
      { kind: "set", spec: { everyS: 7200, prompt: "summarize the board" } });
    expect(parseDutyCommand("/duty off")).toEqual({ kind: "off" });
    expect(parseDutyCommand("/duty save")).toEqual({ kind: "save" });
    expect(parseDutyCommand("/duty")).toEqual({ kind: "status" });
    expect(parseDutyCommand("/duty every tuesday do things")!.kind).toBe("error");
    expect(parseDutyCommand("/duty every 30s too fast")!.kind).toBe("error");   // 1m floor
  });

  test("non-duty text passes through untouched", () => {
    expect(parseDutyCommand("hello /duty")).toBeNull();
    expect(parseDutyCommand("/dutyfree shopping")).toBeNull();
    expect(parseDutyCommand("/compact")).toBeNull();
  });
});

describe("dutyDue", () => {
  test("the cadence proposes; the session's state disposes", () => {
    expect(dutyDue(0, 600, "ready", 700)).toBe(true);
    expect(dutyDue(0, 600, "ready", 500)).toBe(false);          // not due yet
    expect(dutyDue(0, 600, "working", 700)).toBe(false);        // never pile onto a turn
    expect(dutyDue(0, 600, "awaiting", 700)).toBe(false);       // a question for the user outranks the job
    expect(dutyDue(0, 600, "blocked", 700)).toBe(true);         // a round revives a stopped session
    expect(dutyDue(0, 600, "awaitingBg", 700)).toBe(true);
  });
});

describe("dutyLine", () => {
  test("says the cadence and the countdown", () => {
    expect(dutyLine(600, 1000, 1300)).toBe("on duty, every 10m — next round in 5m");
    expect(dutyLine(7200, 0, 7300)).toBe("on duty, every 2h — next round in 0s");
  });
});

describe("renderEvents (what hive_read hands a teammate)", () => {
  test("keeps the conversation, compresses tools to their titles", () => {
    const out = renderEvents([
      { k: "user", id: "1", t: 1, text: "fix the tests" },
      { k: "tool", id: "2", t: 2, name: "Bash", title: "$ bun test", status: "err" },
      { k: "text", id: "3", t: 3, text: "Two failures, on it.", done: true },
    ]);
    expect(out).toBe("user: fix the tests\n  [tool] $ bun test (failed)\nassistant: Two failures, on it.");
  });
});
