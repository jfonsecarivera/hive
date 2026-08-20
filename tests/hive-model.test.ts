import { describe, expect, test } from "bun:test";
import { diffSessions, ENDING_ACK_MS, foldEnding, foldSeenAsk, foldSeenDone, isKnownState, stateLine, type HiveSession } from "../ui/hive-model";

function sess(over: Partial<HiveSession> = {}): HiveSession {
  return {
    sid: "s1", name: "web", color: { bg: "#1EA1EB", fg: "#10141a" },
    state: "ready", lastT: 9_990, goal: null, brief: null, narration: null,
    needsYou: false, needsYouT: 0, liveAsk: false, doneT: 0, todos: [], bg: [], duty: null,
    topIds: [], doneTopIds: [], model: "fable", effort: "max",
    permMode: "bypassPermissions", cwd: "/tmp", cost: 0,
    ...over,
  };
}

describe("diffSessions", () => {
  test("first payload: everything added, no state/goal events", () => {
    const d = diffSessions(null, [sess(), sess({ sid: "s2" })]);
    expect(d.added.sort()).toEqual(["s1", "s2"]);
    expect(d.stateChanged).toEqual([]);
    expect(d.goalDone).toEqual([]);
  });

  test("no-flap invariant: identical payload twice yields zero events", () => {
    const a = [sess({ state: "working", topIds: ["t1"], doneTopIds: [] })];
    const d = diffSessions(a, a.map((s) => ({ ...s })));
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.stateChanged).toEqual([]);
    expect(d.goalDone).toEqual([]);
  });

  test("state changes and removals are reported", () => {
    const d = diffSessions(
      [sess({ state: "working" }), sess({ sid: "s2" })],
      [sess({ state: "ready" })],
    );
    expect(d.stateChanged).toEqual([{ sid: "s1", from: "working", to: "ready" }]);
    expect(d.removed).toEqual(["s2"]);
  });

  test("goalDone fires once per KNOWN top's done transition; arriving-done is history", () => {
    const before = [sess({ topIds: ["t1", "t2"], doneTopIds: [] })];
    const after = [sess({ topIds: ["t1", "t2"], doneTopIds: ["t1"] })];
    expect(diffSessions(before, after).goalDone).toEqual(["s1"]);
    // same payload again: no re-fire
    expect(diffSessions(after, after.map((s) => ({ ...s }))).goalDone).toEqual([]);
    // a brand-new id arriving already done is not an event
    const grow = [sess({ topIds: ["t1", "t2", "t9"], doneTopIds: ["t1", "t9"] })];
    expect(diffSessions(after, grow).goalDone).toEqual([]);
  });
});

describe("stateLine", () => {
  const now = 10_000;
  test("phrases every known state in the user's terms", () => {
    expect(stateLine(sess({ state: "working", narration: { since: now - 120, toolUses: 3 } }), now))
      .toBe("working — 3 tools in, 2m");
    expect(stateLine(sess({ state: "awaiting", liveAsk: true }), now))
      .toBe("needs you — waiting on your answer");
    expect(stateLine(sess({ state: "awaiting", liveAsk: false, needsYouT: now - 3600 * 9 }), now))
      .toBe("needs you — asked 9h ago");
    expect(stateLine(sess({ state: "blocked", brief: "API 500" }), now)).toBe("stopped — API 500");
    // faded DERIVES from lastT at render time — no pushed flag, no timer
    expect(stateLine(sess({ state: "ready", lastT: now - 7200 }), now)).toBe("idle for a while");
    expect(stateLine(sess({ state: "ready", lastT: now - 60 }), now)).toBe("ready");
    const bg = (n: number) => Array.from({ length: n }, (_, i) => ({ id: "b" + i, type: "task", desc: "d" }));
    expect(stateLine(sess({ state: "awaitingBg", bg: bg(2) }), now))
      .toBe("idle — 2 background tasks running");
    expect(stateLine(sess({ state: "awaitingBg", bg: bg(1) }), now))
      .toBe("idle — 1 background task running");
  });

  test("an unknown wire state names itself instead of hiding", () => {
    const s = sess({ state: "hyperspace" });
    expect(isKnownState(s.state)).toBe(false);
    expect(stateLine(s, now)).toBe('in a state hive doesn\'t know: "hyperspace"');
  });
});

describe("foldSeenDone", () => {
  test("first sight seeds (history is not news); later doneT advances are unseen", () => {
    const r1 = foldSeenDone({}, [sess({ doneT: 500 })]);
    expect(r1.unseen.size).toBe(0);
    expect(r1.seen.s1).toBe(500);
    const r2 = foldSeenDone(r1.seen, [sess({ doneT: 900 })]);
    expect(r2.unseen.has("s1")).toBe(true);
  });

  test("absent sids keep their stamps under the 200 cap", () => {
    const r = foldSeenDone({ gone: 5 }, [sess()]);
    expect(r.seen.gone).toBe(5);
  });
});

describe("foldSeenAsk", () => {
  test("NO first-sight seeding: a filed question is a debt that survives fresh state", () => {
    const r = foldSeenAsk({}, [sess({ needsYouT: 700 })]);
    expect(r.unseen.has("s1")).toBe(true);
  });

  test("acked asks stay quiet until a NEWER ask files", () => {
    const r1 = foldSeenAsk({ s1: 700 }, [sess({ needsYouT: 700 })]);
    expect(r1.unseen.size).toBe(0);
    const r2 = foldSeenAsk({ s1: 700 }, [sess({ needsYouT: 900 })]);
    expect(r2.unseen.has("s1")).toBe(true);
  });
});

describe("foldEnding", () => {
  test("drops the sid until a payload omits it (the confirm), then retires the latch", () => {
    const ending = new Map([["s1", 1000]]);
    const r1 = foldEnding(ending, new Set(["s1", "s2"]), 2000);
    expect(r1.drop.has("s1")).toBe(true);
    const r2 = foldEnding(ending, new Set(["s2"]), 3000);
    expect(r2.drop.size).toBe(0);
    expect(ending.size).toBe(0);
  });

  test("past the ack window the failure surfaces loudly", () => {
    const ending = new Map([["s1", 1000]]);
    const r = foldEnding(ending, new Set(["s1"]), 1000 + ENDING_ACK_MS + 1);
    expect(r.failed).toEqual(["s1"]);
    expect(r.drop.size).toBe(0);
    expect(ending.size).toBe(0);
  });
});
