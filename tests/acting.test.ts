import { describe, expect, test } from "bun:test";
import {
  BELLY_R, BELLY_Y, BLOCKED_LEAN, BLOCKED_POUND, BLOCKED_SINK, BLOCKED_SIT, DESK_DEPTH,
  DESK_TOP_Y, DESK_Z, FACE_R, FACE_Y, HAT_R, HAT_Y, leanHeight, leanReach, SCREEN_OFF,
  WORK_BOB, WORK_LEAN, workingPose, workingThink,
} from "../ui/acting";

// each hand's peak strike moment: sin(t*15 + phase) = ±1
const HAMMER = 15;
const L_PEAK = (Math.PI / 2) / HAMMER;
const R_PEAK = (3 * Math.PI / 2) / HAMMER;

describe("workingPose — the typing must read as typing", () => {
  test("the hands ALTERNATE strikes — pounding, never a symmetric wave", () => {
    const atL = workingPose(L_PEAK, 0, 0, 0);
    expect(atL.armLX).toBeLessThan(atL.armRX);          // left hand driven deeper
    const atR = workingPose(R_PEAK, 0, 0, 0);
    expect(atR.armRX).toBeLessThan(atR.armLX);
  });

  test("a strike is a real swing, not the old finger-hover", () => {
    const p = workingPose(L_PEAK, 0, 0, 0);
    expect(Math.abs(p.armLX - p.armRX)).toBeGreaterThan(0.4);
  });

  test("the body rides the beat: bounce and a hunched-forward focus while typing", () => {
    const p = workingPose(L_PEAK, 0, 0, 0);
    expect(p.bounce).toBeGreaterThan(0);
    expect(p.rotX).toBeGreaterThan(0.1);                // leaning INTO the desk
  });

  test("the screen flickers with the strikes and idles in thought — never a flashbang", () => {
    const typing = workingPose(L_PEAK, 0, 0, 0);
    const thinking = workingPose(L_PEAK, 0, 0, 1);
    expect(typing.screen).toBeGreaterThan(0.6);
    expect(typing.screen).toBeLessThan(0.9);            // photographed 2026-08-19: 1.25 washed out the face
    expect(thinking.screen).toBeLessThan(0.45);
  });

  test("full think is the chin-scratch: right hand up, head cocked, hands off the keys", () => {
    const p = workingPose(L_PEAK, 0, 0, 1);
    expect(p.armRX).toBeCloseTo(-2.1, 5);               // hand at the chin
    expect(p.rotZ).toBeGreaterThan(0);                  // the tilt
    expect(p.bounce).toBe(0);                           // no phantom typing while pondering
  });

  test("the stretch break overrides everything: arms overhead, lean back, still", () => {
    const p = workingPose(L_PEAK, 0, 1, 0);
    expect(p.armLZ).toBeCloseTo(2.32, 5);
    expect(p.armRZ).toBeCloseTo(-2.32, 5);
    expect(p.rotX).toBeLessThan(0);                     // leaning BACK
    expect(p.bounce).toBe(0);
    const midThink = workingPose(L_PEAK, 0, 1, 0.7);    // even mid-think, the stretch wins
    expect(midThink.armLZ).toBeCloseTo(2.32, 5);
  });
});

describe("the desk tableau — the keyboard is never IN the bean (the user, 2026-08-19)", () => {
  const nearEdge = DESK_Z - DESK_DEPTH / 2;
  const screenZ = DESK_Z + SCREEN_OFF;        // the laptop lid's plane, beyond the desk center

  test("working: belly, face and hard-hat all clear the desk at the deepest hunch", () => {
    const lean = WORK_LEAN + WORK_BOB;
    expect(leanReach(lean, BELLY_R, BELLY_Y)).toBeLessThan(nearEdge);
    expect(leanReach(lean, FACE_R, FACE_Y)).toBeLessThan(screenZ);
    expect(leanReach(lean, HAT_R, HAT_Y)).toBeLessThan(screenZ);
  });

  test("the tabletop crosses the bean where it NARROWS — above the widest ring", () => {
    expect(DESK_TOP_Y).toBeGreaterThan(BELLY_Y);
  });

  test("blocked: the slump keeps the head clearly ABOVE the tabletop and off the screen", () => {
    const fold = BLOCKED_LEAN + BLOCKED_POUND;
    expect(leanHeight(fold, FACE_R, FACE_Y) - BLOCKED_SINK).toBeGreaterThan(DESK_TOP_Y + 0.025);
    expect(leanReach(fold, FACE_R, FACE_Y, BLOCKED_SIT)).toBeLessThan(nearEdge);
    expect(leanReach(fold, BELLY_R, BELLY_Y, BLOCKED_SIT)).toBeLessThan(nearEdge);
    expect(leanReach(fold, HAT_R, HAT_Y, BLOCKED_SIT)).toBeLessThan(screenZ);
  });
});

describe("workingThink — the rhythm: mostly hammering, honest pauses", () => {
  test("both beats occur, and thought stays the minority (~a third)", () => {
    let think = 0, n = 0;
    for (let t = 0; t < 120; t += 0.05, n++) think += workingThink(t, 0);
    const frac = think / n;
    expect(frac).toBeGreaterThan(0.2);
    expect(frac).toBeLessThan(0.45);
  });

  test("pauses come in continuous stretches long enough to read, not flicker", () => {
    let longest = 0, run = 0;
    for (let t = 0; t < 60; t += 0.05) {
      run = workingThink(t, 0) ? run + 0.05 : 0;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeGreaterThan(2);                 // a real beat of thought
  });

  test("the phase offset desynchronizes neighbours — no metronome hive", () => {
    const a: number[] = [], b: number[] = [];
    for (let t = 0; t < 30; t += 0.5) { a.push(workingThink(t, 0)); b.push(workingThink(t, 2.5)); }
    expect(a.join("")).not.toBe(b.join(""));
  });
});
