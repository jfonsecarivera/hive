import { describe, expect, test } from "bun:test";
import { parseGeo, parseLatLon, parseMeteo } from "../server/weather";

describe("parseLatLon — the HIVE_LATLON pin", () => {
  test("lat,lon with an optional label", () => {
    expect(parseLatLon("52.52, 13.41")).toEqual({ lat: 52.52, lon: 13.41, place: "52.5,13.4" });
    expect(parseLatLon("37.77,-122.42,home")).toEqual({ lat: 37.77, lon: -122.42, place: "home" });
  });

  test("junk and out-of-range coordinates are refused, not guessed", () => {
    expect(parseLatLon(undefined)).toBeNull();
    expect(parseLatLon("berlin")).toBeNull();
    expect(parseLatLon("99,0")).toBeNull();
    expect(parseLatLon("0,190")).toBeNull();
  });
});

describe("parseGeo — both providers' shapes, junk refused", () => {
  test("ipapi.co shape, city lowercased for the chip", () => {
    expect(parseGeo({ latitude: 37.77, longitude: -122.42, city: "San Francisco" }))
      .toEqual({ lat: 37.77, lon: -122.42, place: "san francisco" });
  });

  test("ipwho.is failure arrives inside a 200 — it must not become coordinates", () => {
    expect(parseGeo({ success: false, latitude: 0, longitude: 0, message: "reserved range" })).toBeNull();
  });

  test("a missing city falls back to the raw coordinates", () => {
    expect(parseGeo({ latitude: 1.5, longitude: 2.5 })).toEqual({ lat: 1.5, lon: 2.5, place: "1.5,2.5" });
  });

  test("junk is null", () => {
    expect(parseGeo(null)).toBeNull();
    expect(parseGeo("nope")).toBeNull();
    expect(parseGeo({ latitude: "x", longitude: 3 })).toBeNull();
  });
});

describe("parseMeteo — the Open-Meteo reply becomes the wire record or nothing", () => {
  const NOW = 1_766_000_000;
  const reply = {
    current: { temperature_2m: 21.4, weather_code: 61, cloud_cover: 87, wind_speed_10m: 14.2, is_day: 1 },
    daily: {
      sunrise: ["2026-08-19T06:12", "2026-08-20T06:13"],
      sunset: ["2026-08-19T20:21", "2026-08-20T20:19"],
    },
  };

  test("a full reply parses, sun times ordered, code verbatim", () => {
    const w = parseMeteo(reply, NOW, "berlin")!;
    expect(w).not.toBeNull();
    expect(w.code).toBe(61);
    expect(w.tempC).toBe(21.4);
    expect(w.cloud).toBe(87);
    expect(w.isDay).toBe(true);
    expect(w.place).toBe("berlin");
    expect(w.fetchedT).toBe(NOW);
    expect(w.rises).toHaveLength(2);
    expect(w.sets).toHaveLength(2);
    expect(w.rises[0]).toBeLessThan(w.sets[0]);
    expect(w.rises[0]).toBeLessThan(w.rises[1]);
  });

  test("a reply missing its pieces is null — no weather beats made-up weather", () => {
    expect(parseMeteo(null, NOW, "x")).toBeNull();
    expect(parseMeteo({}, NOW, "x")).toBeNull();
    expect(parseMeteo({ current: reply.current }, NOW, "x")).toBeNull();
    expect(parseMeteo({ current: { ...reply.current, temperature_2m: "?" }, daily: reply.daily }, NOW, "x")).toBeNull();
    expect(parseMeteo({ current: reply.current, daily: { sunrise: [], sunset: [] } }, NOW, "x")).toBeNull();
  });
});
