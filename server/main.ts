// hive — a small command center for Claude Code sessions. One Bun process: static UI,
// a /models endpoint, and one WebSocket per browser with topic fanout (hive board +
// per-session chats). Run it where the agents should live; open it from anywhere.
import { join } from "node:path";
import { buildUi, ROOT } from "./build";
import { Hub } from "./hub";
import { EFFORTS, MODELS, type ClientOp, type ServerMsg } from "./proto";

const PORT = Number(process.env.HIVE_PORT || 4483);

await buildUi();
const hub = new Hub();

interface WsData { watching: Set<string> }

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: process.env.HIVE_BIND || "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      return srv.upgrade(req, { data: { watching: new Set<string>() } })
        ? undefined
        : new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(join(ROOT, "ui/index.html")));
    }
    if (url.pathname === "/styles.css") {
      return new Response(Bun.file(join(ROOT, "ui/styles.css")));
    }
    if (url.pathname.startsWith("/dist/")) {
      const f = Bun.file(join(ROOT, "dist", url.pathname.slice(6)));
      return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
    }
    if (url.pathname === "/models") {
      const d = hub.store.getDefaults();
      return Response.json({ models: MODELS, efforts: EFFORTS.map((e) => ({ value: e })), defaults: { model: d.model, effort: d.effort } });
    }
    if (url.pathname === "/healthz") return Response.json({ ok: true, sessions: hub.sessions.size });
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.subscribe("hive");
      ws.send(hub.defaultsMsg());
      ws.send(hub.hiveMsg());
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
      break;
    }
    case "unwatch":
      ws.data.watching.delete(op.sid);
      ws.unsubscribe(`chat:${op.sid}`);
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
