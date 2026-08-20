import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fmtEvery, loadRoster, parseEvery, saveRoster, type RosterEntry } from "../server/roster";

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

// deliberately NO reconcile/auto-summon tests: the shelf never hires by itself —
// a specialist joins the board only through the user's own drag (hub.summon)
