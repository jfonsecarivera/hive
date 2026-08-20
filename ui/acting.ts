// Acting — pure pose math for the dwellers' bigger performances, kept out of the WebGL
// class so the choreography itself is testable: clock in, joint angles out. The working
// pose is the load-bearing one — "is my agent actually doing something" should be
// answered from across the room by how unmistakably this bean pounds the keys.

// ── the desk tableau: seat-back offset + desk placement that keep the keyboard OUT of
// the bean (the user, 2026-08-19: "the keyboard is IN the bean") at every lean the
// working and blocked performances reach. A fat round creature sits BACK from a desk;
// the poses lean over it from there. BELLY/FACE mirror the lathe profile and visor in
// hive.ts (widest ring, visor front); leanReach/leanHeight are the pure feet-pivot
// math, and the clearance tests pin the whole arrangement so no future pose can fold
// a bean back through its furniture. ─────────────────────────────────────────────────
export const SIT_BACK = 0.2;      // the bean's chair distance while typing
export const BLOCKED_SIT = 0.22;  // blocked sits at the desk too, just deflated
export const DESK_Z = 0.72;       // desk group offset from the pad center
export const DESK_W = 1.1;        // tabletop width — furniture FOR this creature, not doll-size
export const DESK_DEPTH = 0.4;    // tabletop depth — near edge at DESK_Z - DESK_DEPTH/2
export const DESK_TOP_Y = 0.62;   // tabletop height: ABOVE the belly's widest ring, so the
                                  // bean narrows where the desk crosses it (slab ±0.025)
export const SCREEN_OFF = 0.145;  // laptop screen's local z on the desk — plane at DESK_Z - SCREEN_OFF
export const WORK_LEAN = 0.12;    // typing hunch…
export const WORK_BOB = 0.02;     //   …plus the bob riding the beat
// The blocked slump stays SHALLOW on purpose: a deep fold puts the visor on the desk-edge
// pixels from the board's high camera and reads as clipping even when the trig clears
// (photographed 2026-08-19). Despair is carried by the dead screen, the hanging arms,
// the smoke and the weary pound — not by folding through furniture.
export const BLOCKED_LEAN = 0.12;
export const BLOCKED_POUND = 0.05;
export const BLOCKED_SINK = 0.02; // the deflated settle — kept tiny so the head clears the slab
export const BELLY_R = 0.48; export const BELLY_Y = 0.52;   // the lathe's widest ring
export const FACE_R = 0.41; export const FACE_Y = 0.78;     // the visor's front surface
export const HAT_R = 0.34; export const HAT_Y = 1.13;       // the hard-hat brim's front rim

// a body point (radius r at height y) after a feet-pivot lean, in pad space:
// how far forward it reaches, and how high it still sits
export function leanReach(lean: number, r: number, y: number, sit = SIT_BACK): number {
  return r * Math.cos(lean) + y * Math.sin(lean) - sit;
}
export function leanHeight(lean: number, r: number, y: number): number {
  return y * Math.cos(lean) - r * Math.sin(lean);
}

// hammer cadence: each hand strikes ~2.4x/s, alternating — ~5 keys/s of visible typing
const HAMMER = 15;

// The rhythm: hammer for ~8s, then a ~3.5s chin-scratch pause — thought, not a stall.
// Binary on purpose (a beat either is or isn't); the caller eases the transition so the
// pose glides between hammering and pondering instead of snapping.
export function workingThink(t: number, phase: number): number {
  return Math.sin(t * 0.55 + phase) > 0.55 ? 1 : 0;
}

export interface WorkPose {
  armLX: number; armRX: number;   // shoulder-X: hands driving at the keys
  armLZ: number; armRZ: number;   // shoulder-Z: out to the sides / overhead
  rotX: number; rotZ: number;     // torso: hunch-forward focus / think-tilt
  bounce: number;                 // body bob riding the strikes
  screen: number;                 // laptop emissive — runs hot under typing, idles in thought
}

export function workingPose(t: number, phase: number, stretch: number, think: number): WorkPose {
  const l = (a: number, b: number, k: number) => a + (b - a) * k;
  // alternating clipped-sine strikes: squared so the hit is sharp and the lift is slack —
  // pounding, not waving
  const swing = t * HAMMER + phase;
  const hitL = Math.max(0, Math.sin(swing)) ** 2;
  const hitR = Math.max(0, Math.sin(swing + Math.PI)) ** 2;

  // typing: hunched over the keys, both hands hammering, the whole body riding the beat
  let armLX = -1.05 - 0.55 * hitL, armRX = -1.05 - 0.55 * hitR;
  let armLZ = 0.12, armRZ = -0.12;
  let rotX = WORK_LEAN + WORK_BOB * Math.sin(t * 7.5 + phase);
  let rotZ = 0;
  let bounce = 0.02 * (hitL + hitR);
  // bright enough to flicker with the strikes, dim enough not to flashbang the face
  let screen = 0.45 + 0.28 * Math.max(hitL, hitR);

  // think: right hand up to the chin, head cocked, screen idling — reading, not stalled
  armLX = l(armLX, -0.55, think); armRX = l(armRX, -2.1, think);
  armLZ = l(armLZ, 0.3, think); armRZ = l(armRZ, -0.16, think);
  rotX = l(rotX, 0.03, think); rotZ = l(rotZ, 0.1, think);
  bounce *= 1 - think;
  screen = l(screen, 0.3 + 0.06 * Math.sin(t * 1.7), think);

  // stretch (the ~14s break) overrides everything: arms overhead, lean back, exhale
  armLX *= 1 - stretch; armRX *= 1 - stretch;
  armLZ = l(armLZ, 2.32, stretch); armRZ = l(armRZ, -2.32, stretch);
  rotX = l(rotX, -0.24, stretch); rotZ *= 1 - stretch;
  bounce *= 1 - stretch;
  screen = l(screen, 0.4, stretch);

  return { armLX, armRX, armLZ, armRZ, rotX, rotZ, bounce, screen };
}
