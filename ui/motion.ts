// Motion — the game-feel toolbox behind the board's juice: tiny, pure, allocation-free
// curves shared by hive.ts. Everything here is deterministic (no Date, no random) so the
// feel of the board is pinned by tests: springs settle, pops overshoot and land on 1,
// beats stay inside their window. The world calls these per frame; keep them branch-light.

// One velocity step of a damped spring toward `target` — the caller then integrates
// `x += v·dt` with the NEW velocity (semi-implicit Euler, stable for the board's fixed
// 60Hz sim up to its 6-step catch-up while omega·dt < 2). Split this way so the frame
// loop stays allocation-free: no tuple, two plain number assignments at the call site.
// zeta < 1 overshoots and wobbles (jelly); zeta ≥ 1 settles without crossing.
export function springVel(
  x: number, v: number, target: number, dt: number, omega: number, zeta: number,
): number {
  return v + (-omega * omega * (x - target) - 2 * zeta * omega * v) * dt;
}

// The arrival pop, 0→1: rises fast, overshoots ~20%, dips, lands on exactly 1. The shape
// every "something new appeared" scale animation shares.
export function popOut(s: number): number {
  if (s <= 0) return 0;
  if (s >= 1) return 1;
  return 1 - Math.pow(2, -7 * s) * Math.cos(s * Math.PI * 3);
}

// The classic back-out ease, 0→1 with one ~10% overshoot — for small pop-ins (the !, ✓
// and ? bubbles) where the full elastic settle would be too busy.
export function backOut(s: number, k = 1.70158): number {
  const u = s - 1;
  return 1 + (k + 1) * u * u * u + k * u * u;
}

// A periodic beat: 0 except for a sine bump (0→1→0) in the first `width` seconds of
// every `period`. THE shape of idle micro-animation — a stretch break, an egg's wobble
// burst, a proud hop — action, then rest, so characters read as alive, not metronomic.
// Callers de-sync neighbours by offsetting `t` with their own phase.
export function cycleBeat(t: number, period: number, width: number): number {
  const c = t % period;
  return c < width ? Math.sin((c / width) * Math.PI) : 0;
}
