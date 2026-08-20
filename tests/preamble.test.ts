import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPreamble, prefixOutgoing } from "../server/preamble";

describe("prefixOutgoing — the standing preamble rides the wire, marked", () => {
  test("first send carries the FULL text, framed apart from the user's words", () => {
    const { wire, sentNow } = prefixOutgoing("fix the tests", "# rules\nlead with the action", false);
    expect(sentNow).toBe(true);
    expect(wire).toContain("STANDING INSTRUCTIONS");
    expect(wire).toContain("lead with the action");
    expect(wire).toContain("[The user's message:]\n\nfix the tests");
    expect(wire.indexOf("lead with the action")).toBeLessThan(wire.indexOf("fix the tests"));
  });

  test("later sends carry a one-line marker, never the body again", () => {
    const { wire, sentNow } = prefixOutgoing("now the docs", "# rules\nbig body", true);
    expect(sentNow).toBe(false);
    expect(wire).toContain("remain in force");
    expect(wire).not.toContain("big body");
    expect(wire.endsWith("now the docs")).toBe(true);
  });

  test("a slash command stays a slash command; no body means no prefix", () => {
    expect(prefixOutgoing("/compact", "body", false)).toEqual({ wire: "/compact", sentNow: false });
    expect(prefixOutgoing("  /clear", "body", true).wire).toBe("  /clear");
    expect(prefixOutgoing("hello", "", false)).toEqual({ wire: "hello", sentNow: false });
  });
});

describe("loadPreamble", () => {
  test("reads and trims the file; a missing file disables the feature", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-pre-"));
    const p = join(dir, "preamble.md");
    writeFileSync(p, "\n# shape\nrules here\n\n");
    expect(loadPreamble(p)).toBe("# shape\nrules here");
    expect(loadPreamble(join(dir, "absent.md"))).toBe("");
  });

  test("edits are picked up (mtime cache, not read-once)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-pre-"));
    const p = join(dir, "preamble.md");
    writeFileSync(p, "v1");
    expect(loadPreamble(p)).toBe("v1");
    // a same-millisecond rewrite can share an mtime — nudge it
    const bump = Date.now() / 1000 + 2;
    writeFileSync(p, "v2");
    require("node:fs").utimesSync(p, bump, bump);
    expect(loadPreamble(p)).toBe("v2");
  });

  test("HIVE_PREAMBLE=0 force-disables", () => {
    const dir = mkdtempSync(join(tmpdir(), "hive-pre-"));
    const p = join(dir, "preamble.md");
    writeFileSync(p, "body");
    process.env.HIVE_PREAMBLE = "0";
    try { expect(loadPreamble(p)).toBe(""); }
    finally { delete process.env.HIVE_PREAMBLE; }
  });
});
