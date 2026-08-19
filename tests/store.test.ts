import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import type { ChatEvent } from "../server/proto";

function freshStore(): Store {
  return new Store(mkdtempSync(join(tmpdir(), "hive-test-")));
}

describe("Store", () => {
  test("chat events upsert by id and replay in first-arrival order", () => {
    const st = freshStore();
    const t1: ChatEvent = { k: "text", id: "a", t: 1, text: "hel", done: false };
    st.putEvent("s1", t1);
    st.putEvent("s1", { k: "tool", id: "b", t: 2, name: "Bash", title: "$ ls", status: "run" });
    st.putEvent("s1", { ...t1, text: "hello", done: true });   // streaming upsert
    const evs = st.events("s1");
    expect(evs.map((e) => e.id)).toEqual(["a", "b"]);          // order kept, no duplicate
    expect((evs[0] as any).text).toBe("hello");
  });

  test("sessions upsert and archive filters liveSessions", () => {
    const st = freshStore();
    const row = {
      sid: "s1", name: "web", color_bg: "#1EA1EB", color_fg: "#10141a",
      model: "fable", effort: "max", perm_mode: "bypassPermissions", cwd: "/tmp",
      claude_session_id: null, created_t: 1, last_t: 1, done_t: 0,
      goal: null, top_ids: "[]", done_top_ids: "[]", cost: 0, archived: 0,
    };
    st.upsertSession(row);
    st.upsertSession({ ...row, name: "web-2" });
    expect(st.liveSessions().map((r) => r.name)).toEqual(["web-2"]);
    st.upsertSession({ ...row, archived: 1 });
    expect(st.liveSessions()).toEqual([]);
  });

  test("defaults round-trip with sane fallbacks", () => {
    const st = freshStore();
    expect(st.getDefaults().model).toBe("fable");
    st.setDefaults({ model: "haiku", effort: "low", permMode: "default", cwd: "/x" });
    expect(st.getDefaults()).toEqual({ model: "haiku", effort: "low", permMode: "default", cwd: "/x" });
  });
});
