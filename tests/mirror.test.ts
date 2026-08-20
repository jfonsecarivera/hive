import { describe, expect, test } from "bun:test";
import { historyToEvents } from "../server/adopt";
import { lineToMsg, parseTranscriptChunk } from "../server/mirror";
import type { ChatEvent } from "../server/proto";

const line = (o: Record<string, unknown>) => JSON.stringify(o);

describe("lineToMsg", () => {
  test("maps user/assistant lines; sidechain marks the subagent lane; others null", () => {
    const m = lineToMsg({ type: "assistant", uuid: "u1", message: { content: [] } })!;
    expect(m.type).toBe("assistant");
    expect(m.parent_agent_id).toBeNull();
    expect(lineToMsg({ type: "assistant", uuid: "u2", isSidechain: true, message: {} })!.parent_agent_id)
      .toBe("sidechain");
    expect(lineToMsg({ type: "summary", uuid: "u3" })).toBeNull();
    expect(lineToMsg(null)).toBeNull();
  });
});

describe("parseTranscriptChunk", () => {
  test("an assistant end_turn with nothing after it ends the turn; later activity reopens", () => {
    const ended = parseTranscriptChunk([
      line({ type: "user", uuid: "a", message: { role: "user", content: "go" } }),
      line({ type: "assistant", uuid: "b", message: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } }),
    ]);
    expect(ended.endedTurn).toBe(true);
    expect(ended.sawActivity).toBe(true);

    const reopened = parseTranscriptChunk([
      line({ type: "assistant", uuid: "b", message: { content: [], stop_reason: "end_turn" } }),
      line({ type: "user", uuid: "c", message: { role: "user", content: "more" } }),
    ]);
    expect(reopened.endedTurn).toBe(false);
  });

  test("mid-turn tool traffic keeps the turn open; garbage lines are skipped", () => {
    const r = parseTranscriptChunk([
      "not json{{{",
      line({ type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], stop_reason: "tool_use" } }),
    ]);
    expect(r.endedTurn).toBe(false);
    expect(r.msgs.length).toBe(1);
  });

  test("sidechain lines carry no turn signal", () => {
    const r = parseTranscriptChunk([
      line({ type: "assistant", uuid: "a", isSidechain: true, message: { content: [], stop_reason: "end_turn" } }),
    ]);
    expect(r.sawActivity).toBe(false);
    expect(r.endedTurn).toBe(false);
  });
});

describe("carry across chunks", () => {
  test("a result landing in a later chunk re-emits the earlier tool row, updated", () => {
    const carry = new Map<string, Extract<ChatEvent, { k: "tool" }>>();
    const c1 = parseTranscriptChunk([
      line({ type: "assistant", uuid: "a", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "make" } }] } }),
    ]);
    const e1 = historyToEvents(c1.msgs, 1, 1000, carry);
    expect(e1.length).toBe(1);
    expect((e1[0] as any).output).toBeUndefined();

    const c2 = parseTranscriptChunk([
      line({ type: "user", uuid: "b", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "built" }] } }),
    ]);
    const e2 = historyToEvents(c2.msgs, 2, 1000, carry);
    expect(e2.length).toBe(1);
    expect(e2[0].id).toBe(e1[0].id);         // same id → the UI upserts the row in place
    expect((e2[0] as any).output).toBe("built");
    expect((e2[0] as any).status).toBe("ok");
  });
});
