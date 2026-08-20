// The queue demo — six tasks brain-dumped in ONE /queue command, three haiku beans
// hired to drain them. Boots a REAL hive on a scratch board (port 4499, throwaway
// HIVE_HOME) so your own board is untouched; the workshop cwd lives under the OS temp
// dir, which adoption ignores by construction. Costs ~6 tiny haiku turns.
//
// Run:  bun run demo          → leaves the board up to play with; ctrl-c ends it
//       bun run demo --exit   → tears everything down once the queue is drained
//
// The arc: bean one hatches and the brain-dump lands (it grabs the front instantly);
// two more beans hatch straight into the backlog; every bean that finishes a task
// pulls the next — the ready TRANSITION drains the queue, no timers anywhere.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 4499;
const EXIT = process.argv.includes("--exit");
const workshop = mkdtempSync(join(tmpdir(), "hive-demo-work-"));

process.env.HIVE_PORT = String(PORT);
process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), "hive-demo-"));
process.env.HIVE_ADOPT = "0";                 // a demo board starts empty, always

// absolute paths on purpose: a haiku bean told just "haiku.txt" writes it to $HOME
// rather than a temp-looking cwd (all six did, verified live 2026-08-19)
const TASKS = [
  `Write a haiku about worker bees to ${workshop}/haiku.txt. Create the file, no commentary, no questions.`,
  `Draw ASCII art of a bee (10-15 lines) and save it to ${workshop}/bee.txt. No commentary, no questions.`,
  `Write a limerick about a lazy drone bee to ${workshop}/limerick.txt. No commentary, no questions.`,
  `Write one punchy paragraph on why hexagons are the optimal cell shape to ${workshop}/hexagons.txt. No questions.`,
  `Invent three names for a bee-themed programming language with a one-line pitch each; save to ${workshop}/names.txt. No questions.`,
  `Write five lines of fortune-cookie advice as spoken by a queen bee to ${workshop}/advice.txt. No commentary, no questions.`,
];
const BEANS = ["buzz", "clover", "nectar"];

console.log("🐝 hive queue demo — one brain-dump, three beans, zero babysitting");
console.log(`   workshop: ${workshop}`);

const srv = Bun.spawn([process.execPath, "run", join(import.meta.dir, "../server/main.ts")], {
  stdout: "pipe", stderr: "inherit",
  env: { ...process.env },
});

// the server is up when /healthz answers — no fixed sleep
for (let i = 0; ; i++) {
  try { await fetch(`http://127.0.0.1:${PORT}/healthz`); break; }
  catch {
    if (i > 100) { console.error("the demo server never came up"); srv.kill(); process.exit(1); }
    await Bun.sleep(200);
  }
}
console.log(`\n   open http://localhost:${PORT}/board and watch the swarm\n`);

const names = new Map<string, string>();      // sid → name
const states = new Map<string, string>();     // sid → last printed state
let queued = false;
let hired = 1;
let tasksDone = 0;

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const drained = new Promise<void>((resolve) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === "hive") {
      for (const s of m.sessions) {
        if (!names.has(s.sid)) {
          names.set(s.sid, s.name);
          ws.send(JSON.stringify({ op: "watch", sid: s.sid }));
        }
        const was = states.get(s.sid);
        if (was !== s.state) {
          states.set(s.sid, s.state);
          console.log(`   ${s.name}: ${was ?? "…"} → ${s.state}`);
        }
        // the first bean is on the board → brain-dump the whole backlog in ONE command
        // (it takes the front instantly), then hire the rest — each hatches straight
        // into the backlog
        if (!queued) {
          queued = true;
          ws.send(JSON.stringify({ op: "send", sid: s.sid, text: "/queue " + TASKS.map((t) => "- " + t).join("\n") }));
          console.log(`\n🍯 brain-dumped ${TASKS.length} tasks with one /queue — hiring two more beans\n`);
          for (; hired < BEANS.length; hired++) {
            ws.send(JSON.stringify({ op: "create", name: BEANS[hired], model: "haiku", effort: "low", cwd: workshop }));
          }
        }
      }
    }
    if (m.type === "chat") {
      const name = names.get(m.sid) ?? m.sid;
      for (const ev of m.events) {
        if (m.reset) continue;
        if (ev.k === "user" && !ev.text.startsWith("/")) {
          console.log(`→ ${name} picked up: ${ev.text.replaceAll(workshop + "/", "").split("\n")[0].slice(0, 70)}`);
        }
        if (ev.k === "turn") {
          tasksDone++;
          console.log(`✓ ${name} finished (${ev.dur}s) — ${tasksDone}/${TASKS.length}`);
          if (tasksDone >= TASKS.length) resolve();
        }
      }
    }
  };
  ws.onopen = () => {
    ws.send(JSON.stringify({ op: "create", name: BEANS[0], model: "haiku", effort: "low", cwd: workshop }));
  };
});

await Promise.race([drained, Bun.sleep(600_000)]);

console.log("\n── what the swarm made ──────────────────────────────");
for (const f of readdirSync(workshop).sort()) {
  console.log(`\n· ${f}`);
  try { console.log(readFileSync(join(workshop, f), "utf8").trimEnd().replace(/^/gm, "    ")); }
  catch { /* a straggler mid-write shows up on the board instead */ }
}

if (tasksDone >= TASKS.length) {
  console.log(`\n🐝 queue drained: ${TASKS.length} tasks, ${BEANS.length} beans, one command.`);
} else {
  console.log(`\n⚠ timed out with ${tasksDone}/${TASKS.length} done — the board tells the rest`);
}

if (EXIT) {
  srv.kill();
  process.exit(tasksDone >= TASKS.length ? 0 : 1);
}
console.log(`   the board stays up at http://localhost:${PORT}/board — ctrl-c to end it`);
process.on("SIGINT", () => { srv.kill(); process.exit(0); });
await new Promise(() => { /* hold the board open */ });
