// The one socket. Auto-reconnects with backoff; on every (re)connect the server
// re-sends defaults + the full board snapshot, and we re-watch the open chat, so a
// dropped connection heals without losing the user's place.
import type { ClientOp, ServerMsg } from "../server/proto";

type Handler = (m: ServerMsg) => void;

export class Net {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private queue: string[] = [];
  private backoff = 400;
  private rewatch = new Set<string>();
  onStatus: (up: boolean) => void = () => {};

  connect() {
    const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 400;
      this.onStatus(true);
      for (const sid of this.rewatch) ws.send(JSON.stringify({ op: "watch", sid }));
      for (const m of this.queue.splice(0)) ws.send(m);
    };
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try { m = JSON.parse(e.data); } catch { return; }
      for (const h of this.handlers) h(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onStatus(false);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(8000, this.backoff * 1.7);
    };
    ws.onerror = () => ws.close();
  }

  on(h: Handler) { this.handlers.add(h); }

  op(o: ClientOp) {
    if (o.op === "watch") this.rewatch.add(o.sid);
    if (o.op === "unwatch") this.rewatch.delete(o.sid);
    const s = JSON.stringify(o);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(s);
    else if (o.op !== "watch" && o.op !== "unwatch") this.queue.push(s);
  }
}

export const net = new Net();
