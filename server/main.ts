// hive — a small command center for Claude Code sessions. One Bun process: static UI,
// a /models endpoint, and one WebSocket per browser with topic fanout (hive board +
// per-session chats). Run it where the agents should live; open it from anywhere.
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cookieHeader, peek, verdict } from "./auth";
import { buildUi, ROOT } from "./build";
import { Hub } from "./hub";
import { servableImage } from "./session";
import { EFFORTS, type ClientOp, type ServerMsg } from "./proto";
import { startWeather } from "./weather";

const PORT = Number(process.env.HIVE_PORT || 4483);

await buildUi();
const hub = new Hub();
let skyMsg: string | null = null;   // the latest weather reading, retained for new sockets

interface WsData { watching: Set<string> }

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: process.env.HIVE_BIND || "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url);
    // the token gate (HIVE_TOKEN): everything — pages, data, the socket — sits behind it
    // when armed. ?key= once → a year-long cookie; deliberately no localhost bypass.
    const v = verdict(peek(req), process.env.HIVE_TOKEN);
    if (v === "deny") return new Response("hive: locked", { status: 401 });
    const setCookie = v === "setCookie" ? { "Set-Cookie": cookieHeader(process.env.HIVE_TOKEN!) } : undefined;
    const finish = (r: Response) => {
      if (setCookie) r.headers.set("Set-Cookie", setCookie["Set-Cookie"]);
      return r;
    };
    if (url.pathname === "/ws") {
      return srv.upgrade(req, { data: { watching: new Set<string>() } })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/go") {
      return finish(new Response(Bun.file(join(ROOT, "ui/go.html")), { headers: { "Cache-Control": "no-cache" } }));
    }
    if (url.pathname === "/eta") {
      // what the eta duty writes for the user — served as data, rendered by the page
      const p = process.env.HIVE_ETA_FILE || join(process.env.HOME || ".", "hive-eta.md");
      try {
        const st = statSync(p);
        return finish(Response.json({ md: readFileSync(p, "utf8").slice(0, 20_000), mtime: Math.floor(st.mtimeMs / 1000) }));
      } catch {
        return finish(Response.json({ md: "", mtime: 0 }));
      }
    }
    // no-cache everywhere: a redeployed hive must never leave a browser holding a
    // stale bundle that quietly misrepresents the board
    const fresh = { "Cache-Control": "no-cache" };
    if (url.pathname === "/" || url.pathname === "/index.html") {
      // one URL, right page per device: a phone at the root gets the pocket view
      // (the WebGL board + desktop dock read as a mess on 390px); /board forces desktop
      const ua = req.headers.get("user-agent") || "";
      if (/iPhone|Android.*Mobile|Mobile.*Safari/i.test(ua)) {
        return finish(new Response(null, { status: 302, headers: { Location: "/go" + url.search } }));
      }
      return finish(new Response(Bun.file(join(ROOT, "ui/index.html")), { headers: fresh }));
    }
    if (url.pathname === "/board") {
      return finish(new Response(Bun.file(join(ROOT, "ui/index.html")), { headers: fresh }));
    }
    if (url.pathname === "/styles.css") {
      return finish(new Response(Bun.file(join(ROOT, "ui/styles.css")), { headers: fresh }));
    }
    if (url.pathname.startsWith("/dist/")) {
      const f = Bun.file(join(ROOT, "dist", url.pathname.slice(6)));
      return finish((await f.exists()) ? new Response(f, { headers: fresh }) : new Response("not found", { status: 404 }));
    }
    if (url.pathname === "/img") {
      // an image a session Read, shown in its chat. Absolute path + image extension
      // only; the token gate above is the trust boundary (single-user app — the same
      // gate already exposes every chat and the power to drive sessions). CSP sandbox
      // keeps a directly-opened SVG inert.
      const p = url.searchParams.get("p") || "";
      if (!servableImage(p)) return new Response("not an image path", { status: 400 });
      const f = Bun.file(p);
      if (!(await f.exists())) return new Response("image not found", { status: 404 });
      return finish(new Response(f, { headers: { "Cache-Control": "no-cache", "Content-Security-Policy": "sandbox" } }));
    }
    if (url.pathname === "/models") {
      const d = hub.store.getDefaults();
      return finish(Response.json({ models: hub.modelChoices(), efforts: EFFORTS.map((e) => ({ value: e })), defaults: { model: d.model, effort: d.effort } }));
    }
    if (url.pathname === "/healthz") return finish(Response.json({ ok: true, sessions: hub.sessions.size, busy: hub.busyCount() }));
    if (url.pathname === "/perf" && req.method === "POST") {
      // the client's measured frame stats — the authoritative answer to "is it laggy",
      // logged AND kept in ~/.hive/perf.log so any machine's numbers can be read later
      const line = `${new Date().toISOString()} ${(await req.text()).slice(0, 400)}`;
      console.log("[perf]", line);
      try { appendFileSync(join(process.env.HIVE_HOME || join(process.env.HOME || ".", ".hive"), "perf.log"), line + "\n"); } catch { /* log only */ }
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.subscribe("hive");
      ws.send(hub.defaultsMsg());
      ws.send(hub.hiveMsg());
      ws.send(hub.etasMsg());
      if (skyMsg) ws.send(skyMsg);
    },
    message(ws, raw) {
      let op: ClientOp;
      try {
        op = JSON.parse(String(raw));
      } catch {
        ws.send(err("that message was not understood"));
        return;
      }
      try {
        handle(ws, op);
      } catch (e) {
        ws.send(err(String((e as Error)?.message || e), (op as any)?.sid));
      }
    },
    close(ws) {
      for (const sid of ws.data.watching) ws.unsubscribe(`chat:${sid}`);
    },
  },
});

hub.publish = (topic, data) => { server.publish(topic, data); };

// the sky: real weather over the user's head, fanned out like any other topic. Ambience
// only — a failed fetch means the board keeps its classic night, loudly logged, and
// HIVE_WEATHER=0 turns the whole loop off.
if (process.env.HIVE_WEATHER !== "0") {
  startWeather(hub.store, (w) => {
    skyMsg = JSON.stringify({ type: "weather", w } satisfies ServerMsg);
    server.publish("hive", skyMsg);
  });
}

function err(text: string, sid?: string): string {
  return JSON.stringify({ type: "err", sid, title: text } satisfies ServerMsg);
}

function handle(ws: Bun.ServerWebSocket<WsData>, op: ClientOp) {
  switch (op.op) {
    case "create": {
      hub.create(op);
      break;
    }
    case "send":
      // hive's own composer commands (/loop, /queue) are handled here, never sent to the model
      if (hub.dutyCommand(op.sid, op.text)) break;
      if (hub.queueCommand(op.sid, op.text)) break;
      hub.must(op.sid).send(op.text);
      break;
    case "interrupt":
      void hub.must(op.sid).interrupt();
      break;
    case "end":
      hub.end(op.sid);
      break;
    case "rename": {
      const name = op.name.trim();
      if (!name) throw new Error("a session needs a name");
      hub.must(op.sid).rename(name);
      break;
    }
    case "answer":
      hub.must(op.sid).answer(op.askId, op);
      break;
    case "watch": {
      ws.data.watching.add(op.sid);
      ws.subscribe(`chat:${op.sid}`);
      const tail = hub.historyTail(op.sid);
      ws.send(JSON.stringify({ type: "chat", sid: op.sid, reset: true, more: tail.more, events: tail.events } satisfies ServerMsg));
      ws.send(hub.capsMsg(op.sid));
      break;
    }
    case "older": {
      const page = hub.historyBefore(op.sid, op.before);
      ws.send(JSON.stringify({ type: "chat", sid: op.sid, older: true, more: page.more, events: page.events } satisfies ServerMsg));
      break;
    }
    case "unwatch":
      ws.data.watching.delete(op.sid);
      ws.unsubscribe(`chat:${op.sid}`);
      break;
    case "summon":
      hub.summon(op.name);
      break;
    case "unsave":
      hub.unsave(op.name);
      break;
    case "setDefaults": {
      hub.setDefaults(op);
      server.publish("hive", hub.defaultsMsg());
      break;
    }
    default:
      throw new Error("unknown op");
  }
}

// Graceful drain: a restart WAITS for mid-turn sessions to land before cutting clients
// (every cut turn orphans the agent's background tasks — a duty three restarts deep
// called this "why does this keep happening", 2026-08-19). systemd's TimeoutStopSec
// must exceed HIVE_DRAIN_S; a second signal skips the wait.
let draining = false;
async function bye() {
  if (draining) { hub.shutdown(); server.stop(true); process.exit(0); }
  draining = true;
  const deadline = Date.now() + Number(process.env.HIVE_DRAIN_S || 150) * 1000;
  let n = hub.busyCount();
  if (n > 0) console.log(`draining: waiting for ${n} mid-turn session${n === 1 ? "" : "s"} (signal again to skip)`);
  while (n > 0 && Date.now() < deadline) {
    await Bun.sleep(1000);
    n = hub.busyCount();
  }
  if (n > 0) console.log(`drain timeout — cutting ${n} mid-turn session${n === 1 ? "" : "s"}`);
  hub.shutdown();
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", () => void bye());
process.on("SIGTERM", () => void bye());

console.log(`hive up — http://localhost:${server.port}  (${hub.sessions.size} session${hub.sessions.size === 1 ? "" : "s"} revived)`);
