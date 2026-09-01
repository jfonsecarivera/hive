import { describe, expect, test } from "bun:test";
import { SPAWN_MAX_LIVE, spawnPlan } from "../server/tools";

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
