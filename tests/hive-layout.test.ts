import { describe, expect, test } from "bun:test";
import { assignSlots, axialToXZ, frameDt, HEX_SIZE, hexDistance, latticeSegments, ringOf, slotOfAxial, spiralSlot, xzToAxial } from "../ui/hive-layout";

describe("spiral", () => {
  test("slot 0 is the origin; ring k holds 6k slots", () => {
    expect(spiralSlot(0)).toEqual({ q: 0, r: 0 });
    for (let k = 1; k <= 4; k++) {
      for (let i = 3 * k * (k - 1) + 1; i <= 3 * k * (k + 1); i++) {
        expect(hexDistance(spiralSlot(i), { q: 0, r: 0 })).toBe(k);
      }
    }
  });

  test("spiral slots are unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i <= 200; i++) {
      const a = spiralSlot(i);
      const key = a.q + "," + a.r;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test("slotOfAxial inverts spiralSlot; ringOf matches", () => {
    for (let i = 0; i <= 120; i++) {
      expect(slotOfAxial(spiralSlot(i))).toBe(i);
      expect(ringOf(i)).toBe(hexDistance(spiralSlot(i), { q: 0, r: 0 }));
    }
  });

  test("xzToAxial inverts axialToXZ, including off-center points", () => {
    for (let i = 0; i <= 60; i++) {
      const a = spiralSlot(i);
      const { x, z } = axialToXZ(a, HEX_SIZE);
      expect(xzToAxial(x, z, HEX_SIZE)).toEqual(a);
      expect(xzToAxial(x + 0.4, z - 0.3, HEX_SIZE)).toEqual(a);
    }
  });
});

describe("assignSlots", () => {
  test("keeps prior slots, fills lowest free, never moves the placed", () => {
    const prev = new Map([["a", 0], ["b", 3]]);
    const out = assignSlots(prev, ["a", "b", "c", "d"]);
    expect(out.get("a")).toBe(0);
    expect(out.get("b")).toBe(3);
    expect(out.get("c")).toBe(1);
    expect(out.get("d")).toBe(2);
  });

  test("a departed sid frees its slot for future arrivals only", () => {
    const first = assignSlots(new Map(), ["a", "b"]);
    const second = assignSlots(first, ["b"]);
    expect(second.get("b")).toBe(1);           // b stays put
    const third = assignSlots(second, ["b", "c"]);
    expect(third.get("c")).toBe(0);            // c takes the freed 0
  });

  test("corrupt duplicate slots: first claim wins", () => {
    const prev = new Map([["a", 2], ["b", 2]]);
    const out = assignSlots(prev, ["a", "b"]);
    expect(out.get("a")).toBe(2);
    expect(out.get("b")).toBe(0);
  });
});

describe("lattice", () => {
  test("shared edges are emitted once", () => {
    // rings 0..1 = 7 cells; 7*6=42 raw edges, interior shared edges collapse.
    // Euler for the hex patch: edges = (42 + boundary)/2 with 18 boundary edges → 30.
    const seg = latticeSegments(1, HEX_SIZE);
    expect(seg.length / 4).toBe(30);
  });
});

describe("frameDt", () => {
  test("clamps huge steps, floors non-positive and bogus steps", () => {
    expect(frameDt(1000, 900)).toBeCloseTo(0.1);    // a 100ms frame still runs at true speed
    expect(frameDt(1000, 700)).toBeCloseTo(0.1);    // …but a real freeze is clamped (sheds time)
    expect(frameDt(1000, 990)).toBeCloseTo(0.01);
    expect(frameDt(900, 1000)).toBeCloseTo(1 / 60);
    expect(frameDt(NaN, 0)).toBeCloseTo(1 / 60);
    expect(frameDt(1000, -5)).toBeCloseTo(1 / 60);
  });
});
