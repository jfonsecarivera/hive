// Boot — wires the three pieces together on one page: the world (WebGL board), the
// tray (drag-to-spawn), and the chat dock. No modals anywhere: sessions are created
// by dragging a model bean onto a hexagon, and clicking any bean opens its chat.
import { ChatDock } from "./chat";
import { HiveWorld, Tray, type Bridge } from "./hive";
import { net } from "./net";
import type { ServerMsg } from "../server/proto";

const root = document.getElementById("hive-root")!;
const splash = document.getElementById("splash");

const bridge: Bridge = {
  op: (o) => net.op(o),
  openChat: (sid) => dock.open(sid),
};

const world = new HiveWorld(root, bridge);
const tray = new Tray(world, bridge);
const dock = new ChatDock((o) => net.op(o));
// closing the chat ends the portrait; opening happens through world.openChat itself
dock.onOpenChange = (open) => { if (!open) world.exitPortrait(); };

// the reconnect chip: honest about a dead server, quiet otherwise
const conn = document.createElement("div");
conn.id = "conn";
conn.textContent = "reconnecting…";
document.body.appendChild(conn);
net.onStatus = (up) => conn.classList.toggle("show", !up);

// which machine's hive this tab is — two boards in two tabs are otherwise identical
const badge = document.createElement("div");
badge.id = "host-badge";
document.body.appendChild(badge);

let first = true;
net.on((m: ServerMsg) => {
  switch (m.type) {
    case "hive":
      world.sync(m.sessions, first);
      dock.refresh(m.sessions);
      if (first && splash) splash.classList.add("gone");
      first = false;
      break;
    case "chat":
      dock.apply(m.sid, m.events, m.reset);
      break;
    case "caps":
      dock.setCaps(m.sid, m.commands);
      break;
    case "defaults":
      tray.setChoices(m.models, m.efforts, m.defaults);
      document.title = "hive @ " + m.host;
      badge.textContent = m.host;
      break;
    case "err":
      if (world.card.sid && (!m.sid || m.sid === world.card.sid)) {
        world.card.error(m.title, m.text || "");
      } else {
        world.note(m.title + (m.text ? " — " + m.text : ""));
      }
      break;
    case "warn":
      world.note(m.text);
      break;
  }
});

net.connect();
