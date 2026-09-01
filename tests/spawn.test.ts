import { describe, expect, test } from "bun:test";
import { rosterWithDefault, SPAWN_MAX_LIVE, spawnModelOk, spawnPlan } from "../server/tools";

describe("rosterWithDefault — the tray never lags the user's default", () => {
  const roster = [{ value: "claude-fable-5[1m]", label: "Fable" }, { value: "haiku", label: "Haiku" }];
  test("an unlisted default is prepended as a chip; a listed or 'default' one changes nothing", () => {
    expect(rosterWithDefault(roster, "claude-fable-5-1")[0]).toEqual({ value: "claude-fable-5-1", label: "fable-5-1" });
    expect(rosterWithDefault(roster, "haiku")).toBe(roster);
    expect(rosterWithDefault(roster, "default")).toBe(roster);
    expect(rosterWithDefault(roster, "")).toBe(roster);
  });
});

describe("spawnModelOk — roster values, classic aliases, and full ids", () => {
  const roster = ["default", "opus[1m]", "claude-fable-5[1m]", "sonnet", "haiku"];
  test("classic aliases survive roster renames; full claude-* ids pass to the API", () => {
    expect(spawnModelOk(undefined, roster)).toBe(true);
    expect(spawnModelOk("fable", roster)).toBe(true);
    expect(spawnModelOk("claude-fable-5-1", roster)).toBe(true);
    expect(spawnModelOk("claude-fable-5[1m]", roster)).toBe(true);
    expect(spawnModelOk("gpt-5", roster)).toBe(false);
    expect(spawnModelOk("fabel", roster)).toBe(false);
  });
});

describe("spawnPlan — the hive_spawn guard", () => {
  test("a free name passes verbatim", () => {
    expect(spawnPlan(["manager"], "welfare-evals")).toEqual({ ok: true, name: "welfare-evals" });
    expect(spawnPlan([], "  padded  ")).toEqual({ ok: true, name: "padded" });
  });

  test("a taken name suffixes instead of failing, skipping taken suffixes", () => {
    expect(spawnPlan(["evals"], "evals")).toEqual({ ok: true, name: "evals-2" });
    expect(spawnPlan(["evals", "evals-2", "evals-3"], "evals")).toEqual({ ok: true, name: "evals-4" });
  });

  test("no name, no bean", () => {
    expect(spawnPlan([], "   ")).toEqual({ ok: false, reason: "a spawned session needs a name" });
  });

  test("a full board refuses loudly — an agent loop can never flood the hive", () => {
    const full = Array.from({ length: SPAWN_MAX_LIVE }, (_, i) => `bean-${i}`);
    const r = spawnPlan(full, "one-more");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("full");
    expect(spawnPlan(full.slice(1), "fits")).toEqual({ ok: true, name: "fits" });
  });
});
