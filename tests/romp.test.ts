import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { pickRompAdoptable } from "../server/adopt";
import { readRompRegistry } from "../server/romp";

const SID_A = "11111111-2222-3333-4444-555555555555";
const SID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SID_C = "99999999-8888-7777-6666-555555555555";

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hive-romp-"));
  mkdirSync(join(dir, "names"), { recursive: true });
  mkdirSync(join(dir, "sdk"), { recursive: true });
  writeFileSync(join(dir, "names", SID_A), "web\t/home/user/dev/notes-api\t#98998A\tblack\n");
  writeFileSync(join(dir, "sdk", SID_A + ".json"), JSON.stringify({
    sid: SID_A, name: "web", mode: "bypassPermissions", effort: "max", model: "fable", spawnedAt: 1700000000,
    alive: true, lastSid: "12121212-3434-5656-7878-909090909090",
  }));
  writeFileSync(join(dir, "names", SID_B), "api\t/home/user/dev/notes-api\t#F85B5A\twhite\n");
  writeFileSync(join(dir, "names", "not-a-session-id"), "junk\t/x\t#000000\twhite\n");
  writeFileSync(join(dir, "names", SID_C), "\t/missing-name\t#000000\twhite\n");
  return dir;
}

describe("readRompRegistry", () => {
  test("parses names + sdk meta (incl. alive), maps fg words, indexes lastSid, skips junk", () => {
    const reg = readRompRegistry(fixtureDir());
    expect(reg.size).toBe(3);                  // web (by sid AND by lastSid) + api
    expect(reg.get("12121212-3434-5656-7878-909090909090")?.name).toBe("web");
    const a = reg.get(SID_A)!;
    expect(a).toEqual({
      id: SID_A, ids: [SID_A, "12121212-3434-5656-7878-909090909090"],
      name: "web", cwd: "/home/user/dev/notes-api", bg: "#98998A", fg: "#10141a", alive: true,
      model: "fable", effort: "max", permMode: "bypassPermissions", spawnedAt: 1700000000,
    });
    const b = reg.get(SID_B)!;                 // tmux-backend: names line only, never alive
    expect(b.fg).toBe("#ffffff");
    expect(b.model).toBeUndefined();
    expect(b.alive).toBe(false);
  });

  test("no romp on the machine → empty map, no throw", () => {
    expect(readRompRegistry("/nonexistent/romp").size).toBe(0);
  });
});

describe("pickRompAdoptable", () => {
  const DAY = 86_400_000;
  const HOUR = 3_600_000;
  const NOW = 1_000 * DAY;
  const info = (sessionId: string, age: number): SDKSessionInfo =>
    ({ sessionId, summary: "s", lastModified: NOW - age, cwd: "/tmp/somewhere" } as SDKSessionInfo);
  const reg = new Map([
    [SID_A, { alive: true }],                // held by romp's kernel
    [SID_B, { alive: false }],               // named but dead
  ]);

  test("alive sessions adopt at ANY age; dead ones only while still being written", () => {
    const infos = [
      info(SID_A, 30 * DAY),                 // alive, idle a month → in (never lose the thread)
      info(SID_B, HOUR / 2),                 // no sdk record but writing right now → in (tmux-live)
      info(SID_C, HOUR / 4),                 // not romp's at all → out
    ];
    expect(pickRompAdoptable(infos, reg, new Set(), { max: 10, nowMs: NOW })
      .map((i) => i.sessionId)).toEqual([SID_B, SID_A]);
    expect(pickRompAdoptable(infos, reg, new Set([SID_A, SID_B]), { max: 10, nowMs: NOW })).toEqual([]);
  });

  test("dead AND stale is romp's past, not its board", () => {
    expect(pickRompAdoptable([info(SID_B, 3 * HOUR)], reg, new Set(), { max: 10, nowMs: NOW })).toEqual([]);
  });
});
