// Live smoke: drives one real Claude Code turn through AgentSession under bun.
// Run: bun run tests/smoke.ts   (uses the signed-in claude; haiku, low effort, /tmp)
import { AgentSession } from "../server/session";

const s = new AgentSession({
  sid: "smoke-1",
  name: "smoke",
  color: { bg: "#1EA1EB", fg: "#10141a" },
  model: "haiku",
  effort: "low",
  permMode: "bypassPermissions",
  cwd: "/tmp",
});

let done = false;
s.onEvent = (_sid, ev) => {
  const line = ev.k === "text" ? `text(${ev.done ? "done" : "…"}): ${ev.text.slice(0, 80)}`
    : ev.k === "turn" ? `turn: ${ev.dur}s cost=$${ev.cost?.toFixed(4)}${ev.note ? " note=" + ev.note : ""}`
    : ev.k === "note" ? `note[${ev.tone}]: ${ev.text}`
    : ev.k === "user" ? `user: ${ev.text}`
    : `${ev.k}: ${JSON.stringify(ev).slice(0, 100)}`;
  console.log("EV ", line);
  if (ev.k === "turn") done = true;
};
s.onChange = () => console.log("ST ", s.snap().state);

s.send("Reply with exactly the word: buzz. Do not use any tools.");

const t0 = Date.now();
while (!done && Date.now() - t0 < 90_000) {
  await Bun.sleep(250);
}
console.log("FINAL", JSON.stringify({ ...s.snap(), topIds: undefined, doneTopIds: undefined }));
s.shutdown();
process.exit(done ? 0 : 1);
