// Live end-to-end: boots the real server on a scratch port + scratch HIVE_HOME, connects
// as a ws client, creates a session (the tray-drop op), sends a prompt, and verifies the
// board states and chat events flow. Costs one tiny haiku turn.
// Run: bun run tests/e2e.ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HIVE_PORT = "4519";
process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-e2e-"));

const srv = Bun.spawn([process.execPath, "run", join(import.meta.dir, "../server/main.ts")], {
  stdout: "pipe", stderr: "pipe",
  env: { ...process.env },
});
await Bun.sleep(1500);

const seen = { states: new Set<string>(), kinds: new Set<string>(), text: "" };
let sid = "";
const ws = new WebSocket("ws://127.0.0.1:4519/ws");
const done = new Promise<void>((resolve) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === "hive") {
      for (const s of m.sessions) {
        seen.states.add(s.state);
        if (!sid && s.sid) {
          sid = s.sid;
          ws.send(JSON.stringify({ op: "watch", sid }));
          ws.send(JSON.stringify({ op: "send", sid, text: "Reply with exactly: honeycomb. No tools." }));
        }
      }
    }
    if (m.type === "chat") {
      for (const ev of m.events) {
        seen.kinds.add(ev.k);
        if (ev.k === "text") seen.text = ev.text;
        if (ev.k === "turn") resolve();
      }
    }
  };
  ws.onopen = () => {
    ws.send(JSON.stringify({ op: "create", model: "haiku", effort: "low", cwd: "/tmp" }));
  };
});

const timeout = new Promise<void>((r) => setTimeout(r, 90_000));
await Promise.race([done, timeout]);

// rename + end round-trip
ws.send(JSON.stringify({ op: "rename", sid, name: "e2e-bee" }));
await Bun.sleep(300);
ws.send(JSON.stringify({ op: "end", sid }));
await Bun.sleep(500);

const health = await fetch("http://127.0.0.1:4519/healthz").then((r) => r.json());
const models = await fetch("http://127.0.0.1:4519/models").then((r) => r.json());
const page = await fetch("http://127.0.0.1:4519/").then((r) => r.text());
const js = await fetch("http://127.0.0.1:4519/dist/boot.js").then((r) => r.status);

console.log("states seen:", [...seen.states].join(", "));
console.log("event kinds:", [...seen.kinds].join(", "));
console.log("final text: ", JSON.stringify(seen.text).slice(0, 80));
console.log("healthz:    ", JSON.stringify(health));
console.log("models:     ", models.models.map((m: any) => m.value).join(","));
console.log("index ok:   ", page.includes("hive-root"), " boot.js:", js);

const ok = seen.states.has("working") && seen.kinds.has("user") && seen.kinds.has("text")
  && seen.kinds.has("turn") && seen.text.toLowerCase().includes("honeycomb")
  && health.sessions === 0 && js === 200;
console.log(ok ? "E2E OK" : "E2E FAILED");
srv.kill();
process.exit(ok ? 0 : 1);
