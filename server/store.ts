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
      CREATE TABLE IF NOT EXISTS duties(
        sid TEXT PRIMARY KEY, every_s INTEGER NOT NULL, prompt TEXT NOT NULL,
        last_run_t INTEGER DEFAULT 0, created_t INTEGER
      );
    `);
    try { this.db.exec("ALTER TABLE duties ADD COLUMN self_paced INTEGER DEFAULT 0"); }
    catch { /* column already there */ }
    this.db.exec(`CREATE TABLE IF NOT EXISTS etas(
      name TEXT PRIMARY KEY, gist TEXT, task TEXT, eta_text TEXT, eta_iso TEXT,
      conf TEXT, status TEXT, detail TEXT, milestone TEXT, updated_t INTEGER
    );`);
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

  setDuty(sid: string, everyS: number, prompt: string, nowT: number, selfPaced = false) {
    this.db.query(`INSERT INTO duties(sid, every_s, prompt, last_run_t, created_t, self_paced)
      VALUES($sid,$e,$p,$t,$t,$sp)
      ON CONFLICT(sid) DO UPDATE SET every_s=$e, prompt=$p, self_paced=$sp`)
      .run({ $sid: sid, $e: everyS, $p: prompt, $t: nowT, $sp: selfPaced ? 1 : 0 });
  }

  delDuty(sid: string) {
    this.db.query("DELETE FROM duties WHERE sid = $sid").run({ $sid: sid });
  }

  touchDuty(sid: string, t: number) {
    this.db.query("UPDATE duties SET last_run_t = $t WHERE sid = $sid").run({ $sid: sid, $t: t });
  }

  allDuties(): { sid: string; every_s: number; prompt: string; last_run_t: number; self_paced: number }[] {
    return this.db.query("SELECT sid, every_s, prompt, last_run_t, self_paced FROM duties").all() as any;
  }

  // ETA records: a partial write changes only the fields given; "" clears a field
  setEta(name: string, patch: Record<string, string | undefined>, nowT: number) {
    const cur = (this.db.query("SELECT * FROM etas WHERE name = $n").get({ $n: name }) || {}) as Record<string, unknown>;
    const cols = ["gist", "task", "eta_text", "eta_iso", "conf", "status", "detail", "milestone"];
    const next: Record<string, string | null> = {};
    for (const c of cols) {
      const v = patch[c];
      next[c] = v === undefined ? ((cur[c] as string) ?? null) : (v === "" ? null : v);
    }
    this.db.query(`INSERT INTO etas(name,gist,task,eta_text,eta_iso,conf,status,detail,milestone,updated_t)
      VALUES($n,$gist,$task,$eta_text,$eta_iso,$conf,$status,$detail,$milestone,$t)
      ON CONFLICT(name) DO UPDATE SET gist=$gist, task=$task, eta_text=$eta_text, eta_iso=$eta_iso,
        conf=$conf, status=$status, detail=$detail, milestone=$milestone, updated_t=$t`)
      .run({ $n: name, $gist: next.gist, $task: next.task, $eta_text: next.eta_text, $eta_iso: next.eta_iso,
             $conf: next.conf, $status: next.status, $detail: next.detail, $milestone: next.milestone, $t: nowT });
  }

  rmEta(name: string) {
    this.db.query("DELETE FROM etas WHERE name = $n").run({ $n: name });
  }

  allEtas(): { name: string; gist: string | null; task: string | null; eta_text: string | null;
    eta_iso: string | null; conf: string | null; status: string | null; detail: string | null;
    milestone: string | null; updated_t: number }[] {
    return this.db.query("SELECT * FROM etas ORDER BY name").all() as any;
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
