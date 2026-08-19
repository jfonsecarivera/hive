import { describe, expect, test } from "bun:test";
import { toolPreview, toolTitle } from "../server/session";

describe("toolTitle", () => {
  test("names the common tools by their salient argument", () => {
    expect(toolTitle("Bash", { command: "ls -la\nmore" })).toBe("$ ls -la");
    expect(toolTitle("Read", { file_path: "/a/b.ts" })).toBe("Read /a/b.ts");
    expect(toolTitle("Grep", { pattern: "foo" })).toBe("Grep foo");
    expect(toolTitle("WebSearch", { query: "bun sqlite" })).toBe('Search "bun sqlite"');
    expect(toolTitle("mcp__github__create_pr", {})).toBe("github: create_pr");
    expect(toolTitle("Task", { description: "audit auth" })).toBe("Agent — audit auth");
  });

  test("long paths shorten from the left", () => {
    const p = "/very/long/path/that/goes/on/forever/and/ever/src/deep/module/file.ts";
    expect(toolTitle("Read", { file_path: p })).toBe("Read …/deep/module/file.ts");
  });
});

describe("toolPreview", () => {
  test("Edit becomes -/+ lines headed by the path", () => {
    const p = toolPreview("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" })!;
    expect(p.kind).toBe("diff");
    expect(p.text).toBe("a.ts\n-x\n+y");
  });

  test("Write is all additions; ExitPlanMode is the plan text; others are undefined", () => {
    expect(toolPreview("Write", { file_path: "n.md", content: "hi\nthere" })!.text)
      .toBe("n.md\n+hi\n+there");
    expect(toolPreview("ExitPlanMode", { plan: "Step 1" })!.kind).toBe("plan");
    expect(toolPreview("Bash", { command: "ls" })).toBeUndefined();
  });
});
