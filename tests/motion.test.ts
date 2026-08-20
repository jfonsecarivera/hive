// The board's game-feel primitives (ui/motion.ts): springs settle, pops overshoot and
// land on exactly 1, beats stay inside their window and repeat cleanly. These curves are
// what every scale/lift/hop in the world rides — pin the shape, not the frames.
import { describe, expect, test } from "bun:test";
import { backOut, cycleBeat, popOut, springStep } from "../ui/motion";

function runSpring(omega: number, zeta: number, dt: number, steps: number) {
  let x = 0, v = 0, peak = -Infinity;
  for (let i = 0; i < steps; i++) {
    [x, v] = springStep(x, v, 1, dt, omega, zeta);
    peak = Math.max(peak, x);
  }
  return { x, v, peak };
}

describe("springStep", () => {
  test("converges to the target and comes to rest", () => {
    const { x, v } = runSpring(16, 0.6, 1 / 60, 600);
    expect(Math.abs(x - 1)).toBeLessThan(1e-3);
    expect(Math.abs(v)).toBeLessThan(1e-2);
  });

  test("underdamped overshoots (the jelly); critically damped doesn't", () => {
    expect(runSpring(16, 0.5, 1 / 60, 600).peak).toBeGreaterThan(1.05);
    expect(runSpring(16, 1, 1 / 60, 600).peak).toBeLessThan(1.005);
  });

  test("stable at the sim's worst catch-up step (dt = 3/60)", () => {
    const { x } = runSpring(16, 0.6, 3 / 60, 400);
    expect(Number.isFinite(x)).toBe(true);
    expect(Math.abs(x - 1)).toBeLessThan(0.01);
  });
});

describe("popOut", () => {
  test("pinned endpoints, clamped outside [0,1]", () => {
    expect(popOut(0)).toBe(0);
    expect(popOut(-1)).toBe(0);
    expect(popOut(1)).toBe(1);
    expect(popOut(2)).toBe(1);
  });

  test("rises fast, overshoots ~20%, settles near 1", () => {
    expect(popOut(0.15)).toBeGreaterThan(0.7);
    let peak = 0;
    for (let s = 0; s <= 1; s += 0.001) peak = Math.max(peak, popOut(s));
    expect(peak).toBeGreaterThan(1.1);
    expect(peak).toBeLessThan(1.3);
    expect(Math.abs(popOut(0.98) - 1)).toBeLessThan(0.03);
  });
});

describe("backOut", () => {
  test("endpoints pinned, one modest overshoot", () => {
    expect(backOut(0)).toBeCloseTo(0, 10);
    expect(backOut(1)).toBeCloseTo(1, 10);
    let peak = 0;
    for (let s = 0; s <= 1; s += 0.001) peak = Math.max(peak, backOut(s));
    expect(peak).toBeGreaterThan(1.05);
    expect(peak).toBeLessThan(1.2);
  });
});

describe("cycleBeat", () => {
  test("active only inside the window, peaking mid-window", () => {
    expect(cycleBeat(0.5, 10, 1)).toBeCloseTo(1, 5);
    expect(cycleBeat(2, 10, 1)).toBe(0);
    expect(cycleBeat(9.99, 10, 1)).toBe(0);
  });

  test("repeats with its period", () => {
    for (const t of [0.2, 0.7, 3, 9]) {
      expect(cycleBeat(t + 10, 10, 1)).toBeCloseTo(cycleBeat(t, 10, 1), 8);
    }
  });

  test("never negative over many cycles", () => {
    for (let t = 0; t < 20; t += 0.01) {
      expect(cycleBeat(t, 3.3, 0.7)).toBeGreaterThanOrEqual(0);
    }
  });
});
