import { describe, expect, test } from "bun:test";
import { cheerLine, cheerTargets, dutyDue, dutyLine, paceLastRun, parseDutyCommand, stripLoopPrefix } from "../server/duty";
import { renderEvents } from "../server/tools";

describe("self-pacing (paceLastRun)", () => {
  test("bends ONE interval to the requested delay, bounded 1m..24h", () => {
    // everyS 600: asking for 1800s → next due = now + 1800
    expect(paceLastRun(10_000, 600, 1800) + 600).toBe(10_000 + 1800);
    expect(paceLastRun(10_000, 600, 5) + 600).toBe(10_000 + 60);           // floor
    expect(paceLastRun(10_000, 600, 999_999) + 600).toBe(10_000 + 86_400); // ceiling
  });
});

describe("stripLoopPrefix — duties already loop", () => {
  test("drops a leading /loop, leaves everything else", () => {
    expect(stripLoopPrefix("/loop check the fleet")).toEqual({ prompt: "check the fleet", stripped: true });
    expect(stripLoopPrefix("check /loop docs")).toEqual({ prompt: "check /loop docs", stripped: false });
  });
});

describe("parseDutyCommand — /loop is the command, /duty the alias", () => {
  test("fixed-cadence, self-paced, off, save, status, error forms", () => {
    expect(parseDutyCommand("/loop every 10m Check every session and unstick the blocked ones."))
      .toEqual({ kind: "set", spec: { everyS: 600, prompt: "Check every session and unstick the blocked ones.", selfPaced: false } });
    expect(parseDutyCommand("/duty every 2h summarize the board")).toEqual(
      { kind: "set", spec: { everyS: 7200, prompt: "summarize the board", selfPaced: false } });
    // the romp habit: no interval → SELF-PACED with the fallback cadence
    expect(parseDutyCommand("/loop watch the training run and keep my eta file fresh")).toEqual(
      { kind: "set", spec: { everyS: 1800, prompt: "watch the training run and keep my eta file fresh", selfPaced: true } });
    expect(parseDutyCommand("/loop off")).toEqual({ kind: "off" });
    expect(parseDutyCommand("/loop save")).toEqual({ kind: "save" });
    expect(parseDutyCommand("/loop")).toEqual({ kind: "status" });
    expect(parseDutyCommand("/loop every tuesday do things")!.kind).toBe("error");
    expect(parseDutyCommand("/loop every 30s too fast")!.kind).toBe("error");   // 1m floor
  });

  test("non-loop text passes through untouched", () => {
    expect(parseDutyCommand("hello /loop")).toBeNull();
    expect(parseDutyCommand("/loophole in the spec")).toBeNull();
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

describe("the cheer engine", () => {
  test("lines rotate and speak as the person", () => {
    const a = cheerLine(0), b = cheerLine(1);
    expect(a).not.toBe(b);
    expect(cheerLine(5)).toBe(a);              // wraps
    expect(a.toLowerCase()).toContain("keep going");
  });

  test("targets the grinding; never the awaiting/blocked; ALL spares those too", () => {
    const states = [
      { sid: "w", state: "working" }, { sid: "c", state: "compacting" },
      { sid: "r", state: "ready" }, { sid: "a", state: "awaiting" },
      { sid: "b", state: "blocked" },
    ];
    expect(cheerTargets(states, false)).toEqual(["w", "c"]);
    expect(cheerTargets(states, true)).toEqual(["w", "c", "r"]);
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
