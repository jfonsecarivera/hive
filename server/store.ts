// Persistence — one bun:sqlite file under ~/.hive (HIVE_HOME overrides). Chat events
// are upserted by (sid, id) so a streaming block updates its one row instead of
// appending a tick-by-tick log; `seq` preserves first-arrival order for replay.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ChatEvent, Defaults } from "./proto";

export interface SessionRow {
  sid: string;
  name: string;
  color_bg: string;
  color_fg: string;
  model: string;
  effort: string;
  perm_mode: string;
  cwd: string;
  claude_session_id: string | null;
  created_t: number;
  last_t: number;
  done_t: number;
  goal: string | null;
  top_ids: string;
  done_top_ids: string;
  cost: number;
  archived: number;
}

export class Store {
  db: Database;
  private seq: number;

  constructor(dir = process.env.HIVE_HOME || join(process.env.HOME || ".", ".hive")) {
    mkdirSync(dir, { recursive: true });
    this.db = new Database(join(dir, "hive.db"), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions(
        sid TEXT PRIMARY KEY, name TEXT NOT NULL, color_bg TEXT, color_fg TEXT,
        model TEXT, effort TEXT, perm_mode TEXT, cwd TEXT,
        claude_session_id TEXT, created_t INTEGER, last_t INTEGER, done_t INTEGER DEFAULT 0,
        goal TEXT, top_ids TEXT DEFAULT '[]', done_top_ids TEXT DEFAULT '[]',
        cost REAL DEFAULT 0, archived INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS chat(
        sid TEXT, id TEXT, t INTEGER, seq INTEGER, json TEXT,
        PRIMARY KEY(sid, id)
      );
      CREATE INDEX IF NOT EXISTS chat_sid_seq ON chat(sid, seq);
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
    `);
    this.seq = (this.db.query("SELECT COALESCE(MAX(seq),0) AS m FROM chat").get() as any).m;
  }

  upsertSession(r: SessionRow) {
    this.db.query(`
      INSERT INTO sessions(sid,name,color_bg,color_fg,model,effort,perm_mode,cwd,
        claude_session_id,created_t,last_t,done_t,goal,top_ids,done_top_ids,cost,archived)
      VALUES($sid,$name,$color_bg,$color_fg,$model,$effort,$perm_mode,$cwd,
        $claude_session_id,$created_t,$last_t,$done_t,$goal,$top_ids,$done_top_ids,$cost,$archived)
      ON CONFLICT(sid) DO UPDATE SET
        name=$name, color_bg=$color_bg, color_fg=$color_fg, model=$model, effort=$effort,
        perm_mode=$perm_mode, cwd=$cwd, claude_session_id=$claude_session_id,
        last_t=$last_t, done_t=$done_t, goal=$goal, top_ids=$top_ids,
        done_top_ids=$done_top_ids, cost=$cost, archived=$archived
    `).run({
      $sid: r.sid, $name: r.name, $color_bg: r.color_bg, $color_fg: r.color_fg,
      $model: r.model, $effort: r.effort, $perm_mode: r.perm_mode, $cwd: r.cwd,
      $claude_session_id: r.claude_session_id, $created_t: r.created_t, $last_t: r.last_t,
      $done_t: r.done_t, $goal: r.goal, $top_ids: r.top_ids, $done_top_ids: r.done_top_ids,
      $cost: r.cost, $archived: r.archived,
    });
  }

  liveSessions(): SessionRow[] {
    return this.db.query("SELECT * FROM sessions WHERE archived = 0 ORDER BY created_t").all() as SessionRow[];
  }

  // every claude session id hive has EVER tracked, archived included: a bean the user
  // trashed must stay gone — adoption never resurrects a deliberate end
  allClaudeIds(): Set<string> {
    const rows = this.db.query(
      "SELECT claude_session_id AS id FROM sessions WHERE claude_session_id IS NOT NULL",
    ).all() as { id: string }[];
    return new Set(rows.map((r) => r.id));
  }

  putEvent(sid: string, ev: ChatEvent) {
    this.db.query(`
      INSERT INTO chat(sid,id,t,seq,json) VALUES($sid,$id,$t,$seq,$json)
      ON CONFLICT(sid,id) DO UPDATE SET json=$json, t=$t
    `).run({ $sid: sid, $id: ev.id, $t: ev.t, $seq: ++this.seq, $json: JSON.stringify(ev) });
  }

  events(sid: string, limit = 500): ChatEvent[] {
    const rows = this.db.query(
      "SELECT json FROM chat WHERE sid = $sid ORDER BY seq DESC LIMIT $limit",
    ).all({ $sid: sid, $limit: limit }) as { json: string }[];
    return rows.reverse().map((r) => JSON.parse(r.json) as ChatEvent);
  }

  kvGet(k: string): string | null {
    const row = this.db.query("SELECT v FROM kv WHERE k = $k").get({ $k: k }) as { v: string } | null;
    return row ? row.v : null;
  }

  kvSet(k: string, v: string) {
    this.db.query("INSERT INTO kv(k,v) VALUES($k,$v) ON CONFLICT(k) DO UPDATE SET v=$v").run({ $k: k, $v: v });
  }

  getDefaults(): Defaults {
    const row = this.db.query("SELECT v FROM kv WHERE k = 'defaults'").get() as { v: string } | null;
    const base: Defaults = {
      model: "fable", effort: "max", permMode: "bypassPermissions",
      cwd: process.env.HOME || process.cwd(),
    };
    if (!row) return base;
    try { return { ...base, ...JSON.parse(row.v) }; } catch { return base; }
  }

  setDefaults(d: Defaults) {
    this.db.query(
      "INSERT INTO kv(k,v) VALUES('defaults',$v) ON CONFLICT(k) DO UPDATE SET v=$v",
    ).run({ $v: JSON.stringify(d) });
  }
}
