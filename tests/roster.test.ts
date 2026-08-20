import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fmtEvery, loadRoster, parseEvery, reconcileActions, saveRoster, type RosterEntry } from "../server/roster";

describe("parseEvery / fmtEvery", () => {
  test("round-trips human cadences; floors at 1m", () => {
    expect(parseEvery("10m")).toBe(600);
    expect(parseEvery("2h")).toBe(7200);
    expect(parseEvery("90s")).toBe(90);
    expect(parseEvery("30s")).toBeNull();
    expect(parseEvery("tuesday")).toBeNull();
    expect(fmtEvery(600)).toBe("10m");
    expect(fmtEvery(7200)).toBe("2h");
    expect(fmtEvery(90)).toBe("90s");
  });
});

describe("roster file", () => {
  test("save → load round-trip; junk entries are skipped", () => {
    const p = join(mkdtempSync(join(tmpdir(), "hive-roster-")), "duties.json");
    const m = new Map<string, RosterEntry>([
      ["eta", { every: "10m", prompt: "track everyone's eta", model: "haiku", effort: "low", cwd: "~" }],
    ]);
    saveRoster(m, p);
    const back = loadRoster(p);
    expect(back.get("eta")).toEqual(m.get("eta"));
    expect(loadRoster("/nonexistent/duties.json").size).toBe(0);
  });

  test("a hand-edited file with bad entries loads the good ones only", () => {
    const p = join(mkdtempSync(join(tmpdir(), "hive-roster-")), "duties.json");
    Bun.write(p, JSON.stringify({
      good: { every: "5m", prompt: "do the thing" },
      "no-prompt": { every: "5m" },
      "bad-every": { every: "sometimes", prompt: "x" },
    }));
    return new Promise((r) => setTimeout(r, 20)).then(() => {
      const m = loadRoster(p);
      expect([...m.keys()]).toEqual(["good"]);
    });
  });
});

describe("reconcileActions — the file is authoritative for saved duties", () => {
  const roster = new Map<string, RosterEntry>([
    ["eta", { every: "10m", prompt: "track etas" }],
    ["steward", { every: "1h", prompt: "tend the board" }],
  ]);

  test("missing bean → summon; drifted duty → apply; in-sync → nothing", () => {
    const acts = reconcileActions(roster, [
      { name: "eta", everyS: 600, prompt: "track etas" },        // in sync
      { name: "unrelated", everyS: null, prompt: null },          // not the roster's business
    ]);
    expect(acts).toEqual([{ act: "summon", name: "steward", entry: roster.get("steward")! }]);

    const drift = reconcileActions(roster, [
      { name: "eta", everyS: 600, prompt: "OLD prompt" },
      { name: "steward", everyS: 3600, prompt: "tend the board" },
    ]);
    expect(drift).toEqual([{ act: "apply", name: "eta", everyS: 600, prompt: "track etas" }]);
  });

  test("a bean present but with NO duty gets the roster's applied", () => {
    const acts = reconcileActions(roster, [
      { name: "eta", everyS: null, prompt: null },
      { name: "steward", everyS: 3600, prompt: "tend the board" },
    ]);
    expect(acts).toEqual([{ act: "apply", name: "eta", everyS: 600, prompt: "track etas" }]);
  });
});
