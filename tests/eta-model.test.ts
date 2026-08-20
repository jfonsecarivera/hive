import { describe, expect, test } from "bun:test";
import type { EtaRow, SessionSnap } from "../server/proto";
import { agoText, cdText, effectiveStatus, rankEtas } from "../ui/eta-model";

const snap = (name: string, state = "working"): SessionSnap =>
  ({ name, state, sid: name, color: { bg: "#fff", fg: "#000" }, lastT: 0, goal: null, brief: null,
    narration: null, needsYou: false, needsYouT: 0, liveAsk: false, doneT: 0, todos: [], bg: [],
    duty: null, topIds: [], doneTopIds: [], model: "m", effort: "e", permMode: "p", cwd: "/", cost: 0 }) as SessionSnap;

const row = (name: string, over: Partial<EtaRow> = {}): EtaRow => ({ name, updatedT: 100, ...over });

describe("rankEtas", () => {
  test("blocked first, then not-live claims, then working; deadlines break ties", () => {
    const views = rankEtas([
      row("done-one", { status: "done" }),
      row("worker-b", { status: "working", etaIso: "2026-01-01T02:00:00Z" }),
      row("worker-a", { status: "working", etaIso: "2026-01-01T01:00:00Z" }),
      row("stuck", { status: "blocked" }),
      row("ghost", { status: "working" }),           // no live session → offline
    ], [snap("worker-a"), snap("worker-b"), snap("stuck")]);
    expect(views.map((v) => v.name)).toEqual(["stuck", "ghost", "worker-a", "worker-b", "done-one"]);
    expect(effectiveStatus(views[1])).toBe("offline");
  });

  test("a record about a session that exists is never offline", () => {
    const [v] = rankEtas([row("here", { status: "working" })], [snap("here", "ready")]);
    expect(v.offline).toBe(false);
  });
});

describe("cdText / agoText", () => {
  test("countdown shapes: m:ss, h mm, d h", () => {
    expect(cdText(187_000)).toBe("3:07");
    expect(cdText(2_832_000)).toBe("47:12");
    expect(cdText(7_500_000)).toBe("2h 05m");
    expect(cdText(101_000_000)).toBe("1d 4h");
  });

  test("ago phrasing", () => {
    expect(agoText(30)).toBe("just now");
    expect(agoText(600)).toBe("10m ago");
    expect(agoText(7200)).toBe("2h ago");
  });
});
