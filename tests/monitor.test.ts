import { describe, expect, test } from "bun:test";
import { parseMonitor } from "../ui/monitor";

const NOTIF = `<task-notification>
<task-id>bg7eqavdi</task-id>
<summary>Monitor event: "training run: every-500-step lines + eval"</summary>
<event>step 06500/08758 (74.22%) | loss: 2.513330 | tok/sec: 688,053 | eta: 60.6m</event>
</task-notification>`;

describe("parseMonitor", () => {
  test("extracts the watcher description, the event, and the percent", () => {
    const m = parseMonitor(NOTIF)!;
    expect(m.summary).toBe("training run: every-500-step lines + eval");
    expect(m.event).toContain("step 06500/08758");
    expect(m.pct).toBeCloseTo(74.22);
  });

  test("derives percent from step X/Y when no % is present", () => {
    const m = parseMonitor("<task-notification><summary>w</summary><event>step 25/100 done</event></task-notification>")!;
    expect(m.pct).toBeCloseTo(25);
  });

  test("plain text is not a monitor line", () => {
    expect(parseMonitor("just words with 50% in them")).toBeNull();
  });
});
