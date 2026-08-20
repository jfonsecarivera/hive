import { describe, expect, test } from "bun:test";
import { skyLook, sunPhase, weatherGlyph, weatherKind, weatherLabel } from "../ui/sky-model";

const BASE = 1_000_000_000;
const DAY = 86_400;
const RISE = BASE + 6 * 3600, SET = BASE + 20 * 3600;
const rises = [RISE, RISE + DAY], sets = [SET, SET + DAY];

describe("sunPhase — where the clock sits between the horizon crossings", () => {
  test("noon is full day, deep night is none", () => {
    expect(sunPhase(BASE + 13 * 3600, rises, sets)).toEqual({ dayness: 1, warmth: 0 });
    expect(sunPhase(BASE + 3 * 3600, rises, sets)).toEqual({ dayness: 0, warmth: 0 });
  });

  test("a crossing is exactly half-light with the warm band at full", () => {
    const at = sunPhase(RISE, rises, sets);
    expect(at.dayness).toBeCloseTo(0.5, 5);
    expect(at.warmth).toBe(1);
    const dusk = sunPhase(SET, rises, sets);
    expect(dusk.dayness).toBeCloseTo(0.5, 5);
    expect(dusk.warmth).toBe(1);
  });

  test("the warm band dies out past the edge window; dayness saturates", () => {
    const later = sunPhase(RISE + 3600, rises, sets);
    expect(later.dayness).toBe(1);
    expect(later.warmth).toBe(0);
  });

  test("tomorrow's pair carries the blend across midnight", () => {
    expect(sunPhase(SET + 5 * 3600, rises, sets).dayness).toBe(0);       // 1am tonight
    expect(sunPhase(RISE + DAY + 4 * 3600, rises, sets).dayness).toBe(1); // 10am tomorrow
  });

  test("no sun data at all means deep night — the classic board", () => {
    expect(sunPhase(BASE, [], [])).toEqual({ dayness: 0, warmth: 0 });
  });
});

describe("weatherKind — WMO codes bucket, and the wire stays open", () => {
  test("the table", () => {
    expect(weatherKind(0)).toBe("clear");
    expect(weatherKind(2)).toBe("cloudy");
    expect(weatherKind(3)).toBe("overcast");
    expect(weatherKind(45)).toBe("fog");
    expect(weatherKind(53)).toBe("drizzle");
    expect(weatherKind(63)).toBe("rain");
    expect(weatherKind(81)).toBe("rain");
    expect(weatherKind(73)).toBe("snow");
    expect(weatherKind(85)).toBe("snow");
    expect(weatherKind(96)).toBe("thunder");
  });

  test("an unassigned code is UNKNOWN, labeled with the raw number — never coerced", () => {
    expect(weatherKind(42)).toBe("unknown");
    expect(weatherLabel("unknown", 42)).toBe("code 42");
    expect(weatherGlyph("unknown", true)).toBe("?");
  });

  test("clear shows a sun by day and a moon by night", () => {
    expect(weatherGlyph("clear", true)).toBe("☀");
    expect(weatherGlyph("clear", false)).toBe("☾");
  });
});

describe("skyLook — night-clear IS the app's classic look, everything else moves from it", () => {
  const night = skyLook(0, 0, "clear", 0);

  test("the baseline pins the scene constructor's exact values", () => {
    expect(night).toEqual({
      bg: 0x090b10, fogDensity: 0.013,
      hemiSky: 0x3b4a63, hemiGround: 0x0a0c10, hemiInt: 1.0,
      keyColor: 0xcfe0ff, keyInt: 1.0, rimInt: 0.7,
      rain: 0, snow: 0, lightning: false,
    });
  });

  test("day lifts the light", () => {
    const day = skyLook(1, 0, "clear", 0);
    expect(day.hemiInt).toBeGreaterThan(night.hemiInt);
    expect(day.keyInt).toBeGreaterThan(night.keyInt);
    expect(day.bg).not.toBe(night.bg);
  });

  test("the dawn band warms the key light toward amber", () => {
    const dawn = skyLook(0.5, 1, "clear", 0);
    expect((dawn.keyColor >> 16) & 255).toBeGreaterThan(dawn.keyColor & 255);
  });

  test("clouds dim the sun", () => {
    expect(skyLook(1, 0, "clear", 100).keyInt).toBeLessThan(skyLook(1, 0, "clear", 0).keyInt);
  });

  test("an overcast KIND reads overcast even with a low cover number", () => {
    expect(skyLook(1, 0, "overcast", 5).keyInt).toBeLessThan(skyLook(1, 0, "clear", 5).keyInt);
  });

  test("fog thickens the air", () => {
    expect(skyLook(0, 0, "fog", 80).fogDensity).toBeGreaterThan(night.fogDensity);
  });

  test("rain pours, drizzle only drizzles, snow snows and neither mixes", () => {
    expect(skyLook(0, 0, "rain", 90).rain).toBe(1);
    expect(skyLook(0, 0, "drizzle", 90).rain).toBeCloseTo(0.35, 5);
    const s = skyLook(0, 0, "snow", 90);
    expect(s.snow).toBe(1);
    expect(s.rain).toBe(0);
  });

  test("thunder pours AND flashes", () => {
    const t = skyLook(0, 0, "thunder", 100);
    expect(t.rain).toBe(1);
    expect(t.lightning).toBe(true);
  });

  test("unknown weather is neutral — no precipitation, nothing invented", () => {
    const u = skyLook(0.5, 0, "unknown", 50);
    expect(u.rain).toBe(0);
    expect(u.snow).toBe(0);
    expect(u.lightning).toBe(false);
  });
});
