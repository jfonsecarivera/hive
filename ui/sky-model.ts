// Sky — the pure math behind the board's time-of-day + weather ambience. The scene's
// classic TRON night IS the baseline: skyLook at (night, clear) returns exactly the
// constructor's pinned lighting, so a hive with no weather reading looks the way hive
// has always looked. Numbers in, numbers out; tested in tests/sky-model.test.ts.

export type WeatherKind =
  | "clear" | "cloudy" | "overcast" | "fog" | "drizzle" | "rain" | "snow" | "thunder"
  | "unknown";

// WMO weather code → bucket. The wire stays open (the states rule, applied to weather):
// a code outside the table is "unknown" — neutral visuals, the raw code printed on the
// chip — never silently coerced to clear.
export function weatherKind(code: number): WeatherKind {
  if (code === 0 || code === 1) return "clear";
  if (code === 2) return "cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95 && code <= 99) return "thunder";
  return "unknown";
}

export function weatherLabel(kind: WeatherKind, code: number): string {
  return kind === "unknown" ? `code ${code}` : kind;
}

export function weatherGlyph(kind: WeatherKind, isDay: boolean): string {
  switch (kind) {
    case "clear": return isDay ? "☀" : "☾";
    case "cloudy": return "⛅";
    case "overcast": return "☁";
    case "fog": return "≋";
    case "drizzle": return "☂";
    case "rain": return "☔";
    case "snow": return "❄";
    case "thunder": return "⚡";
    case "unknown": return "?";
  }
}

// dawn/dusk half-width: the sky turns over ~40 minutes around each horizon crossing
const EDGE_S = 2400;

function smooth(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

// dayness: 0 deep night → 1 full day, smoothstepped through every sunrise/sunset the
// forecast lists (today + tomorrow, so the pair straddling midnight just works).
// warmth: the amber horizon band — 1 exactly AT a crossing, gone EDGE_S away from it.
// No sun data at all (no reading yet, polar edge) → deep night, the classic board.
export function sunPhase(nowS: number, rises: number[], sets: number[]): { dayness: number; warmth: number } {
  let dayness = 0;
  for (let i = 0; i < rises.length; i++) {
    const up = smooth((nowS - rises[i] + EDGE_S) / (2 * EDGE_S));
    const down = i < sets.length ? smooth((nowS - sets[i] + EDGE_S) / (2 * EDGE_S)) : 0;
    dayness = Math.max(dayness, up * (1 - down));
  }
  let band = 0;
  for (const e of [...rises, ...sets]) {
    band = Math.max(band, 1 - Math.abs(nowS - e) / EDGE_S);
  }
  return { dayness, warmth: smooth(band) };
}

export interface SkyLook {
  bg: number;              // the air: clear color + fog color, one value
  fogDensity: number;
  hemiSky: number; hemiGround: number; hemiInt: number;
  keyColor: number; keyInt: number;
  rimInt: number;
  rain: number;            // 0..1 fall-layer intensities
  snow: number;
  lightning: boolean;
}

function lerpC(a: number, b: number, t: number): number {
  const r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t);
  const g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t);
  const bl = Math.round((a & 255) + ((b & 255) - (a & 255)) * t);
  return (r << 16) | (g << 8) | bl;
}

// The three keyframes the clock blends between. NIGHT is the app's classic look,
// verbatim from the scene constructor. DAY stays a dark world on purpose — full
// daylight would kill the neon; day here reads as the studio letting the sky in.
// GOLD is the dawn/dusk tint, mixed in by warmth.
const NIGHT = { bg: 0x090b10, fog: 0.013, hs: 0x3b4a63, hg: 0x0a0c10, hi: 1.0, kc: 0xcfe0ff, ki: 1.0, ri: 0.7 };
const DAY = { bg: 0x121a24, fog: 0.011, hs: 0x8fb2d4, hg: 0x161c24, hi: 1.45, kc: 0xfff1d6, ki: 1.6, ri: 0.45 };
const GOLD = { bg: 0x171019, fog: 0.014, hs: 0x9a5f6e, hg: 0x120e14, hi: 1.15, kc: 0xffa066, ki: 1.35, ri: 0.6 };

// how much cloud a kind implies even when the cover number is low — an overcast code
// with a stale 10% cover figure must still look overcast
const KIND_CLOUD: Record<WeatherKind, number> = {
  clear: 0, cloudy: 0.45, overcast: 0.9, fog: 0.75, drizzle: 0.75,
  rain: 0.75, snow: 0.75, thunder: 0.85, unknown: 0.5,
};

export function skyLook(dayness: number, warmth: number, kind: WeatherKind, cloud: number): SkyLook {
  const w = warmth * 0.65;                    // the gold is a tint, never the whole sky
  const col = (n: number, d: number, g: number) => lerpC(lerpC(n, d, dayness), g, w);
  const num = (n: number, d: number, g: number) => { const m = n + (d - n) * dayness; return m + (g - m) * w; };

  let bg = col(NIGHT.bg, DAY.bg, GOLD.bg);
  let hemiSky = col(NIGHT.hs, DAY.hs, GOLD.hs);
  let hemiGround = col(NIGHT.hg, DAY.hg, GOLD.hg);
  let keyColor = col(NIGHT.kc, DAY.kc, GOLD.kc);
  let fogDensity = num(NIGHT.fog, DAY.fog, GOLD.fog);
  const hemiInt = num(NIGHT.hi, DAY.hi, GOLD.hi);
  let keyInt = num(NIGHT.ki, DAY.ki, GOLD.ki);
  const rimInt = num(NIGHT.ri, DAY.ri, GOLD.ri);

  // clouds mute the sun: the key dims and greys, the sky flattens
  const cl = Math.max(Math.min(1, Math.max(0, cloud / 100)), KIND_CLOUD[kind]);
  keyInt *= 1 - 0.45 * cl;
  keyColor = lerpC(keyColor, 0xb9c3cf, cl * 0.7);
  hemiSky = lerpC(hemiSky, 0x59626e, cl * 0.55);

  let rain = 0, snow = 0, lightning = false;
  switch (kind) {
    case "fog": fogDensity += 0.021; break;
    case "drizzle": rain = 0.35; break;
    case "rain": rain = 1; fogDensity += 0.004; keyInt *= 0.85; bg = lerpC(bg, 0x06070b, 0.35); break;
    case "snow": snow = 1; fogDensity += 0.003; hemiGround = lerpC(hemiGround, 0x232b34, 0.6); break;
    case "thunder": rain = 1; lightning = true; keyInt *= 0.7; bg = lerpC(bg, 0x05060a, 0.5); break;
  }

  return { bg, fogDensity, hemiSky, hemiGround, hemiInt, keyColor, keyInt, rimInt, rain, snow, lightning };
}
