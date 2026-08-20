// Weather — the real sky over the user's actual head. One loop: locate once (pinned by
// HIVE_LATLON, else IP-geolocated and cached in the store's kv), then poll Open-Meteo
// every 15 minutes and fan the reading out on the hive topic. Ambience only: nothing
// here touches session state, and a failed fetch means NO weather layer (the classic
// night board) plus a loud log line — never a made-up sky. Timers are correct here:
// the events-over-heuristics rule governs board state, and the actual sky moves on
// wall clock, not on SDK events.
import type { Weather } from "./proto";

export interface GeoLoc { lat: number; lon: number; place: string }

// HIVE_LATLON="52.52,13.41[,label]" pins the location without any IP lookup
export function parseLatLon(env: string | undefined): GeoLoc | null {
  if (!env) return null;
  const parts = env.split(",").map((s) => s.trim());
  const lat = Number(parts[0]), lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, place: parts[2] || `${lat.toFixed(1)},${lon.toFixed(1)}` };
}

// both geolocation providers' shapes (ipapi.co / ipwho.is) parse here; junk returns null
export function parseGeo(j: unknown): GeoLoc | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (o.success === false) return null;      // ipwho.is reports failure inside a 200
  const lat = Number(o.latitude), lon = Number(o.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const place = typeof o.city === "string" && o.city ? o.city.toLowerCase() : `${lat.toFixed(1)},${lon.toFixed(1)}`;
  return { lat, lon, place };
}

// Open-Meteo current + daily → the wire record. Sunrise/sunset are requested as
// timeformat=unixtime (epoch numbers) so the math is timezone-independent — hive's
// server may run on a remote box in a different zone than the sky it's describing
// (the devbox, 2026-08-19). Local-ISO strings are still accepted as a fallback.
export function parseMeteo(j: unknown, nowS: number, place: string): Weather | null {
  const o = j as { current?: Record<string, unknown>; daily?: Record<string, unknown> } | null;
  const c = o?.current, d = o?.daily;
  if (!c || !d) return null;
  const code = Number(c.weather_code), tempC = Number(c.temperature_2m);
  const cloud = Number(c.cloud_cover), windKmh = Number(c.wind_speed_10m);
  if (![code, tempC, cloud, windKmh].every(Number.isFinite)) return null;
  const toS = (s: unknown) => {
    if (typeof s === "number" && Number.isFinite(s)) return Math.floor(s);
    const t = typeof s === "string" ? new Date(s).getTime() : NaN;
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  };
  const rises = (Array.isArray(d.sunrise) ? d.sunrise : []).map(toS).filter((x): x is number => x !== null);
  const sets = (Array.isArray(d.sunset) ? d.sunset : []).map(toS).filter((x): x is number => x !== null);
  if (!rises.length || !sets.length) return null;
  return { code, tempC, cloud, windKmh, isDay: c.is_day === 1, place, rises, sets, fetchedT: nowS };
}

interface Kv { kvGet(k: string): string | null; kvSet(k: string, v: string): void }

const GEO_URLS = ["https://ipapi.co/json/", "https://ipwho.is/"];
const meteoUrl = (g: GeoLoc) =>
  `https://api.open-meteo.com/v1/forecast?latitude=${g.lat}&longitude=${g.lon}` +
  "&current=temperature_2m,weather_code,cloud_cover,wind_speed_10m,is_day" +
  "&daily=sunrise,sunset&timezone=auto&timeformat=unixtime&forecast_days=2";

async function locate(kv: Kv): Promise<GeoLoc | null> {
  const pinned = parseLatLon(process.env.HIVE_LATLON);
  if (pinned) return pinned;
  const cached = kv.kvGet("weather.loc");
  if (cached) {
    try {
      const g = JSON.parse(cached) as GeoLoc & { t: number };
      if (Date.now() / 1000 - g.t < 7 * 86400) return g;
    } catch { /* refetch below */ }
  }
  for (const url of GEO_URLS) {
    try {
      const g = parseGeo(await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json());
      if (g) {
        kv.kvSet("weather.loc", JSON.stringify({ ...g, t: Math.floor(Date.now() / 1000) }));
        return g;
      }
    } catch { /* try the next provider */ }
  }
  return null;
}

export function startWeather(kv: Kv, onWeather: (w: Weather) => void): void {
  let loc: GeoLoc | null = null;
  const tick = async () => {
    try {
      loc ||= await locate(kv);
      if (!loc) {
        console.warn("[weather] no location — set HIVE_LATLON=lat,lon[,label] to pin one");
        return;
      }
      const res = await fetch(meteoUrl(loc), { signal: AbortSignal.timeout(10_000) });
      const w = parseMeteo(await res.json(), Math.floor(Date.now() / 1000), loc.place);
      if (!w) {
        console.warn("[weather] open-meteo reply not understood");
        return;
      }
      onWeather(w);
    } catch (e) {
      console.warn("[weather] fetch failed:", String((e as Error)?.message || e));
    }
  };
  void tick();
  setInterval(() => void tick(), 15 * 60 * 1000);
}
