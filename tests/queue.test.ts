import { describe, expect, test } from "bun:test";
import { parseQueueCommand, pickWorker, queueStatus, splitTasks, type WorkerView } from "../server/queue";

describe("parseQueueCommand", () => {
  test("add, status, clear; non-queue text passes through", () => {
    expect(parseQueueCommand("/queue fix the flaky auth test"))
      .toEqual({ kind: "add", tasks: ["fix the flaky auth test"] });
    expect(parseQueueCommand("/queue")).toEqual({ kind: "status" });
    expect(parseQueueCommand("/queue clear")).toEqual({ kind: "clear" });
    expect(parseQueueCommand("/queuemore stuff")).toBeNull();
    expect(parseQueueCommand("try /queue later")).toBeNull();
    expect(parseQueueCommand("/loop every 10m x")).toBeNull();
  });

  test("a pasted list is a brain-dump — one task per line", () => {
    expect(parseQueueCommand("/queue - fix login\n* update deps\n3. write docs"))
      .toEqual({ kind: "add", tasks: ["fix login", "update deps", "write docs"] });
  });
});

describe("splitTasks", () => {
  test("only an all-bulleted paste splits; prose with newlines stays ONE task", () => {
    expect(splitTasks("- a\n- b")).toEqual(["a", "b"]);
    expect(splitTasks("1. a\n2) b")).toEqual(["a", "b"]);
    expect(splitTasks("fix the parser\nthen run the tests")).toEqual(["fix the parser\nthen run the tests"]);
    expect(splitTasks("- lone bullet")).toEqual(["- lone bullet"]);   // one line = one task, verbatim
  });
});

describe("pickWorker", () => {
  const w = (over: Partial<WorkerView>): WorkerView =>
    ({ sid: "x", state: "ready", duty: false, adopted: false, steering: false, lastT: 0, ...over });

  test("only a READY bean takes work; longest idle goes first", () => {
    expect(pickWorker([
      w({ sid: "a", state: "working", lastT: 1 }),
      w({ sid: "b", lastT: 5 }),
      w({ sid: "c", lastT: 2 }),
    ])).toBe("c");
  });

  test("duty, adopted, steering, awaiting, blocked, awaitingBg are never fed", () => {
    expect(pickWorker([
      w({ sid: "d", duty: true }),
      w({ sid: "e", adopted: true }),
      w({ sid: "f", steering: true }),
      w({ sid: "g", state: "awaiting" }),
      w({ sid: "h", state: "blocked" }),
      w({ sid: "i", state: "awaitingBg" }),
    ])).toBeNull();
    expect(pickWorker([])).toBeNull();
  });
});

describe("queueStatus", () => {
  test("empty says how to file; long queues show the head and the count", () => {
    expect(queueStatus([])).toContain("/queue <task>");
    const out = queueStatus(["a", "b", "c", "d", "e", "f", "g"]);
    expect(out).toContain("7 tasks in the queue");
    expect(out).toContain("1. a");
    expect(out).toContain("5. e");
    expect(out).not.toContain("6. f");
    expect(out).toContain("and 2 more");
  });
});
