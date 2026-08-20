// hive — a small command center for Claude Code sessions. One Bun process: static UI,
// a /models endpoint, and one WebSocket per browser with topic fanout (hive board +
// per-session chats). Run it where the agents should live; open it from anywhere.
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cookieHeader, peek, verdict } from "./auth";
import { buildUi, ROOT } from "./build";
import { Hub } from "./hub";
import { EFFORTS, type ClientOp, type ServerMsg } from "./proto";

const PORT = Number(process.env.HIVE_PORT || 4483);

await buildUi();
const hub = new Hub();

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
      return finish(new Response(Bun.file(join(ROOT, "ui/index.html")), { headers: fresh }));
    }
    if (url.pathname === "/styles.css") {
      return finish(new Response(Bun.file(join(ROOT, "ui/styles.css")), { headers: fresh }));
    }
    if (url.pathname.startsWith("/dist/")) {
      const f = Bun.file(join(ROOT, "dist", url.pathname.slice(6)));
      return finish((await f.exists()) ? new Response(f, { headers: fresh }) : new Response("not found", { status: 404 }));
    }
    if (url.pathname === "/models") {
      const d = hub.store.getDefaults();
      return finish(Response.json({ models: hub.modelChoices(), efforts: EFFORTS.map((e) => ({ value: e })), defaults: { model: d.model, effort: d.effort } }));
    }
    if (url.pathname === "/healthz") return finish(Response.json({ ok: true, sessions: hub.sessions.size }));
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
      // hive's own composer commands (e.g. /duty) are handled here, never sent to the model
      if (hub.dutyCommand(op.sid, op.text)) break;
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
      ws.send(JSON.stringify({ type: "chat", sid: op.sid, reset: true, events: hub.history(op.sid) } satisfies ServerMsg));
      ws.send(hub.capsMsg(op.sid));
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

function bye() {
  hub.shutdown();
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", bye);
process.on("SIGTERM", bye);

console.log(`hive up — http://localhost:${server.port}  (${hub.sessions.size} session${hub.sessions.size === 1 ? "" : "s"} revived)`);
