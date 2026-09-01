// One Claude Code session driven over the Agent SDK. Translates the SDK stream into
// (a) the board's state vocabulary and (b) upsertable chat events. State moves on
// events only — session_state_changed, status, api_retry, result, a pending ask —
// never on timers (the romp design rule this app inherits).
import { existsSync, mkdirSync } from "node:fs";
import { query, type McpSdkServerConfigWithInstance, type ModelInfo, type Options, type PermissionResult, type PermissionUpdate, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { loadPreamble, prefixOutgoing } from "./preamble";
import type { AskQuestion, BgTask, ChatEvent, CmdInfo, ModelChoice, SessionSnap, TodoItem, WireState } from "./proto";

const INPUT_CAP = 2000;
const OUTPUT_CAP = 4000;
const TOPS_CAP = 50;

// ── SDK vocabulary tripwires ─────────────────────────────────────────────────────
// These Records are keyed by the SDK's OWN unions, exhaustively: when an SDK upgrade
// adds a message kind, a session state, or a status value, `bun x tsc` fails right
// here — the signal that Claude Code now says something this app doesn't know. At
// runtime the lookups stay stringly (the live CLI can be newer than the installed
// types); an unmapped value passes through visibly instead of being coerced:
// unknown STATES ride to the board verbatim, unknown MESSAGE KINDS surface once as
// a chat note (foreignKind) and are otherwise skipped.
type WireSessionState = Extract<SDKMessage, { type: "system"; subtype: "session_state_changed" }>["state"];
const SESSION_STATE_MAP: Record<WireSessionState, "run" | "idle" | "action"> = {
  running: "run",
  idle: "idle",
  requires_action: "action",
};
type WireStatus = NonNullable<Extract<SDKMessage, { type: "system"; subtype: "status" }>["status"]>;
const STATUS_MAP: Record<WireStatus, "compacting" | "requesting"> = {
  compacting: "compacting",
  requesting: "requesting",
};

// Every top-level message kind the installed SDK can emit. "handle" names have a case
// in onMsg; "ignore" is a DELIBERATE no-op (each with its reason). A kind in neither —
// a live CLI newer than the types — lands in foreignKind.
type WireTop = SDKMessage["type"];
const TOP_HANDLING: Record<WireTop, "handle" | "ignore"> = {
  system: "handle",
  assistant: "handle",
  user: "handle",
  result: "handle",
  stream_event: "handle",
  tool_progress: "handle",
  tool_use_summary: "handle",       // the CLI's own caption for a tool run → chat
  auth_status: "handle",            // credential trouble must never be silent
  conversation_reset: "handle",     // /clear completed
  rate_limit_event: "handle",       // approaching/hitting plan limits
  prompt_suggestion: "ignore",      // composer autofill hints — no surface for them here
};

// …and every system subtype. Same contract.
type WireSub = Extract<SDKMessage, { type: "system" }>["subtype"];
const SUB_HANDLING: Record<WireSub, "handle" | "ignore"> = {
  init: "handle",
  status: "handle",
  api_retry: "handle",
  session_state_changed: "handle",
  compact_boundary: "handle",
  background_tasks_changed: "handle",   // drives awaitingBg — the bean leaning back
  commands_changed: "handle",           // dynamic slash-command list
  notification: "handle",
  informational: "handle",
  local_command_output: "handle",
  model_refusal_fallback: "handle",
  model_refusal_no_fallback: "handle",
  permission_denied: "handle",
  task_notification: "handle",
  worker_shutting_down: "handle",
  mirror_error: "handle",
  // deliberately ignored, each for a reason:
  hook_started: "ignore",               // hook lifecycle — only emitted when opted into
  hook_progress: "ignore",
  hook_response: "ignore",
  files_persisted: "ignore",            // checkpointing bookkeeping
  memory_recall: "ignore",              // internal recall notices
  thinking_tokens: "ignore",            // token telemetry; cost rides the result
  plugin_install: "ignore",             // install progress spam
  elicitation_complete: "ignore",       // MCP elicitation — we don't run onElicitation
  control_request_progress: "ignore",   // control-channel plumbing
  task_started: "ignore",               // the changed-set (background_tasks_changed)
  task_updated: "ignore",               //   is the authoritative view of live tasks;
  task_progress: "ignore",              //   task_notification carries the outcome
};

export interface SessionInit {
  sid: string;
  name: string;
  color: { bg: string; fg: string };
  model: string;
  effort: string;
  permMode: string;
  cwd: string;
  origin?: string;                // "hive" (default) | "adopted" | "spawned" — only hive-born beans are fed queue work
  claudeSessionId?: string | null;
  createdT?: number;
  lastT?: number;
  doneT?: number;
  goal?: string | null;
  topIds?: string[];
  doneTopIds?: string[];
  cost?: number;
}

interface PendingAsk {
  id: string;
  resolve: (r: PermissionResult) => void;
  suggestions?: PermissionUpdate[];
  questions?: AskQuestion[];
  ev: Extract<ChatEvent, { k: "ask" }>;
}

export class AgentSession {
  sid: string;
  name: string;
  color: { bg: string; fg: string };
  model: string;
  effort: string;
  permMode: string;
  cwd: string;
  origin: string;
  claudeSessionId: string | null;
  createdT: number;
  lastT: number;
  doneT: number;
  goal: string | null;
  topIds: string[];
  doneTopIds: string[];
  ended = false;

  private state: WireState;
  private brief: string | null = null;
  private inflight = false;
  private interrupting = false;
  private retrying = false;
  private compacting = false;
  private foreignState: string | null = null;   // a wire state we don't recognize, verbatim
  private foreignSeen = new Set<string>();
  // MIRRORED liveness: some other controller (romp, a terminal claude) is appending this
  // session's transcript right now — the mirror drives this, never the SDK client
  mirrorBusy = false;
  private clearing = false;                     // a /clear in flight (send → conversation_reset)
  private bg: BgTask[] = [];                    // live background tasks (replace semantics)
  private todos: TodoItem[] = [];               // the agent's TodoWrite list, latest write wins
  commands: CmdInfo[] = [];                     // the session's dynamic slash commands
  private preambleSent = false;             // the standing preamble's full text went out this conversation
  private turnStart = 0;
  private turnTools = 0;
  private curTurnId: string | null = null;
  private asks = new Map<string, PendingAsk>();

  private q: Query | null = null;
  private abort: AbortController | null = null;
  private pending: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private inputsClosed = false;
  // messages sent WHILE a turn ran: a steer = interrupt + redirect. The turn is cut and
  // these deliver the moment it lands — priority:"now" alone proved to queue politely
  // behind the turn (measured live 2026-08-19: four sleeps ran to completion around it).
  private steerQueue: string[] = [];

  private costBase: number;
  private costLive = 0;

  // streaming text blocks: msgId:index → accumulated text, flushed on a short throttle
  private blocks = new Map<string, { ev: Extract<ChatEvent, { k: "text" | "think" }>; timer: Timer | null }>();
  private streamedMsgs = new Set<string>();
  private toolEvents = new Map<string, Extract<ChatEvent, { k: "tool" }>>();
  private evn = 0;

  onEvent: (sid: string, ev: ChatEvent) => void = () => {};
  onChange: (sid: string) => void = () => {};
  onCaps: (sid: string) => void = () => {};                 // commands list changed
  onModels: (models: ModelChoice[]) => void = () => {};     // the live model roster
  mcp: (() => McpSdkServerConfigWithInstance) | null = null;   // the hive board tools (hub injects)

  constructor(init: SessionInit) {
    this.sid = init.sid;
    this.name = init.name;
    this.color = init.color;
    this.model = init.model;
    this.effort = init.effort;
    this.permMode = init.permMode;
    this.cwd = init.cwd;
    this.origin = init.origin ?? "hive";
    this.claudeSessionId = init.claudeSessionId ?? null;
    this.createdT = init.createdT ?? now();
    this.lastT = init.lastT ?? this.createdT;
    this.doneT = init.doneT ?? 0;
    this.goal = init.goal ?? null;
    this.topIds = init.topIds ?? [];
    this.doneTopIds = init.doneTopIds ?? [];
    this.costBase = init.cost ?? 0;
    // a brand-new session (no claude session yet) is hatching; a revived one sits ready
    this.state = this.claudeSessionId ? "ready" : "opening";
  }

  snap(): SessionSnap {
    return {
      sid: this.sid, name: this.name, color: this.color,
      state: this.state, lastT: this.lastT,
      goal: this.goal, brief: this.brief,
      narration: (this.inflight || this.mirrorBusy) && this.turnStart
        ? { since: this.turnStart, toolUses: this.turnTools } : null,
      needsYou: this.asks.size > 0, needsYouT: this.newestAskT(), liveAsk: this.asks.size > 0,
      doneT: this.doneT, todos: this.todos, bg: this.bg, duty: null,   // hub overlays duty
      topIds: [...this.topIds].sort(), doneTopIds: [...this.doneTopIds].sort(),
      model: this.model, effort: this.effort, permMode: this.permMode, cwd: this.cwd,
      cost: this.costBase + this.costLive,
    };
  }

  cost(): number { return this.costBase + this.costLive; }

  private newestAskT(): number {
    let t = 0;
    for (const a of this.asks.values()) t = Math.max(t, a.ev.t);
    return t;
  }

  private setState(s: WireState, brief: string | null = null) {
    if (this.state === s && this.brief === brief) return;
    this.state = s;
    this.brief = brief;
    this.onChange(this.sid);
  }

  // the state the evidence supports right now, after any flag flips
  private settle() {
    if (this.ended) return;
    if (this.interrupting) return this.setState("interrupting");
    if (this.asks.size) {
      const first = [...this.asks.values()][0];
      return this.setState("awaiting", first.ev.title);
    }
    if (this.clearing) return this.setState("clearing");
    if (this.compacting) return this.setState("compacting");
    if (this.retrying) return this.setState("retrying", this.brief);
    if (this.foreignState) return this.setState(this.foreignState, this.brief);
    if (this.inflight) return this.setState("working");
    if (this.mirrorBusy) return this.setState("working");   // someone else is driving — still true
    if (this.bg.length > 0) return this.setState("awaitingBg");
    if (this.state !== "blocked") this.setState("ready", this.brief);
  }

  // a wire value beyond our vocabulary: pass it through visibly, say so once
  private foreign(raw: string) {
    this.foreignState = raw;
    if (!this.foreignSeen.has(raw)) {
      this.foreignSeen.add(raw);
      this.note(`the session reported a state this app doesn't know yet: "${raw}"`);
    }
    this.settle();
  }

  // a MESSAGE KIND beyond our vocabulary (live CLI newer than the installed SDK types):
  // say so once per kind, then skip its instances — never guess at unknown semantics
  private foreignKind(kind: string) {
    const key = "kind:" + kind;
    if (this.foreignSeen.has(key)) return;
    this.foreignSeen.add(key);
    this.note(`the session sent a ${kind} message this app doesn't know yet — shown nowhere else`);
  }

  private emit(ev: ChatEvent) { this.onEvent(this.sid, ev); }

  note(text: string, tone: "info" | "err" = "info") {
    this.emit({ k: "note", id: `n${++this.evn}-${Date.now().toString(36)}`, t: now(), text, tone });
  }

  stateNow(): string { return this.state; }

  // ── the SDK client ───────────────────────────────────────────────────────────

  private async *inputs(): AsyncGenerator<SDKUserMessage> {
    while (!this.inputsClosed) {
      while (this.pending.length) yield this.pending.shift()!;
      if (this.inputsClosed) return;
      await new Promise<void>((r) => { this.wake = r; });
    }
  }

  private ensureClient() {
    if (this.q || this.ended) return;
    // a missing cwd makes the CLI spawn die with a misleading "binary failed to launch"
    // (seen live 2026-08-19: a test session with an uncreated dir; adopted sessions whose
    // worktree was deleted hit the same wall) — create it and say so
    try {
      if (!existsSync(this.cwd)) {
        mkdirSync(this.cwd, { recursive: true });
        this.note(`its working directory was missing — recreated empty: ${this.cwd}`);
      }
    } catch { /* the spawn error below stays the honest signal */ }
    this.abort = new AbortController();
    this.inputsClosed = false;
    const opts: Options = {
      cwd: this.cwd,
      effort: this.effort as Options["effort"],
      // bypass is enforced in onCanUseTool, not via the mode: the real bypassPermissions
      // mode shadows canUseTool entirely, which would swallow AskUserQuestion pickers
      permissionMode: (this.permMode === "bypassPermissions" ? "default" : this.permMode) as Options["permissionMode"],
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      abortController: this.abort,
      canUseTool: (tool, input, o) => this.onCanUseTool(tool, input, o),
      env: cleanEnv(),
    };
    if (this.model && this.model !== "default") opts.model = this.model;
    if (this.claudeSessionId) opts.resume = this.claudeSessionId;
    if (this.mcp) opts.mcpServers = { hive: this.mcp() };
    this.q = query({ prompt: this.inputs(), options: opts });
    this.drain(this.q);
    // dynamic capabilities, from the session itself (never a hardcoded copy): the live
    // slash-command list (richer than init's bare names) and the model roster
    const q = this.q;
    q.supportedCommands().then((cmds) => {
      if (this.q !== q) return;
      this.commands = cmds.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }));
      this.onCaps(this.sid);
    }).catch(() => { /* a client that dies before init answers via teardown */ });
    q.supportedModels().then((ms: ModelInfo[]) => {
      if (this.q !== q) return;
      this.onModels(ms.map((m) => ({ value: m.value, label: m.displayName })));
    }).catch(() => { /* same */ });
  }

  private async drain(q: Query) {
    try {
      for await (const m of q) this.onMsg(m);
      if (!this.ended && this.q === q) {
        this.teardown("the session's process exited");
      }
    } catch (e) {
      if (!this.ended && this.q === q) {
        this.teardown(String((e as Error)?.message || e));
      }
    }
  }

  // the client died (crash, abort, CLI exit): fold costs, fail pending asks loudly,
  // and leave the session revivable — the next send resumes by claude session id
  private teardown(why: string) {
    this.costBase += this.costLive;
    this.costLive = 0;
    this.q = null;
    this.inputsClosed = true;
    this.wake?.();
    for (const a of [...this.asks.values()]) this.resolveAsk(a.id, { behavior: "deny", message: "Session ended before an answer arrived.", interrupt: false }, "cancelled");
    this.flushAllBlocks(true);
    const wasWorking = this.inflight;
    this.inflight = false;
    this.interrupting = false;
    this.retrying = false;
    this.compacting = false;
    this.clearing = false;
    this.foreignState = null;
    this.bg = [];                     // the tasks died with their client
    if (this.ended) return;
    if (wasWorking) {
      this.note(`stopped: ${why}`, "err");
      this.setState("blocked", why.slice(0, 200));
    } else {
      this.settle();
    }
    this.flushSteers();                   // a redirect survives even a dying client
  }

  // ── inbound SDK messages → chat events + state ──────────────────────────────

  private onMsg(m: SDKMessage) {
    if ((m as any).session_id) this.claudeSessionId = (m as any).session_id;
    switch (m.type) {
      case "system":
        if (m.subtype === "init") {
          // an adopted session starts as "default" — the init names the real model
          if ((!this.model || this.model === "default") && m.model) this.model = m.model;
          if (this.state === "opening") this.settle();
          this.onChange(this.sid);
        } else if (m.subtype === "status") {
          const mapped = m.status === null ? null : (STATUS_MAP as Record<string, string | undefined>)[m.status];
          this.compacting = mapped === "compacting";
          if (m.status !== null && mapped === undefined) this.foreign(String(m.status));
          else this.foreignState = null;
          if (m.compact_result === "success") this.note("context compacted");
          if (m.compact_result === "failed") this.note(`compaction failed${m.compact_error ? `: ${m.compact_error}` : ""}`, "err");
          this.settle();
        } else if (m.subtype === "api_retry") {
          this.retrying = true;
          const why = m.error_status ? `API ${m.error_status}` : "API error";
          this.brief = `${why} — retry ${m.attempt}/${m.max_retries} in ${Math.round(m.retry_delay_ms / 1000)}s`;
          this.setState("retrying", this.brief);
        } else if (m.subtype === "session_state_changed") {
          const mapped = (SESSION_STATE_MAP as Record<string, string | undefined>)[m.state];
          if (mapped === "run") { this.inflight = true; this.retrying = false; this.foreignState = null; }
          else if (mapped === "idle") { this.inflight = false; this.interrupting = false; this.foreignState = null; }
          else if (mapped === "action") { this.foreignState = null; }   // a pending ask already carries this
          else this.foreign(String(m.state));
          this.settle();
        } else if (m.subtype === "compact_boundary") {
          this.compacting = false;
          this.settle();
        } else if (m.subtype === "background_tasks_changed") {
          this.bg = (Array.isArray(m.tasks) ? m.tasks : []).map((x) => ({
            id: x.task_id, type: x.task_type, desc: x.description,
          }));
          this.settle();
          this.onChange(this.sid);
        } else if (m.subtype === "commands_changed") {
          this.commands = (m.commands || []).map((c) => ({
            name: c.name, description: c.description, argumentHint: c.argumentHint,
          }));
          this.onCaps(this.sid);
        } else if (m.subtype === "notification") {
          this.note(m.text);
        } else if (m.subtype === "informational") {
          // 'info' is transcript-mode noise by the SDK's own docs; the rest surface
          if (m.level !== "info") this.note(m.content, m.level === "warning" ? "err" : "info");
        } else if (m.subtype === "local_command_output") {
          if (m.content?.trim()) this.note(m.content);
        } else if (m.subtype === "model_refusal_fallback" || m.subtype === "model_refusal_no_fallback") {
          this.note(m.content || "the model refused this request", "err");
        } else if (m.subtype === "permission_denied") {
          this.note(`${m.tool_name} was denied${m.decision_reason ? ` — ${m.decision_reason}` : ""}`, "err");
        } else if (m.subtype === "task_notification") {
          if (!m.skip_transcript) {
            this.note(`background task ${m.status}: ${m.summary}`, m.status === "failed" ? "err" : "info");
          }
        } else if (m.subtype === "worker_shutting_down") {
          this.note(`the session's worker is shutting down (${m.reason})`, "err");
        } else if (m.subtype === "mirror_error") {
          this.note(`transcript mirror error: ${m.error}`, "err");
        } else {
          const h = (SUB_HANDLING as Record<string, string | undefined>)[(m as any).subtype];
          if (h === undefined) this.foreignKind(`system/${(m as any).subtype}`);
        }
        break;
      case "stream_event": {
        if (m.parent_tool_use_id) break;                     // subagent internals stay out of the chat
        this.retrying = false;
        const ev = m.event as any;
        if (ev.type === "content_block_start" && (ev.content_block?.type === "text" || ev.content_block?.type === "thinking")) {
          const kind = ev.content_block.type === "text" ? "text" : "think";
          const id = `${this.streamMsgId}:${ev.index}`;
          this.blocks.set(id, { ev: { k: kind, id, t: now(), text: "", done: false }, timer: null });
          this.streamedMsgs.add(this.streamMsgId);
        } else if (ev.type === "message_start") {
          this.streamMsgId = ev.message?.id || `m${++this.evn}`;
        } else if (ev.type === "content_block_delta") {
          const id = `${this.streamMsgId}:${ev.index}`;
          const b = this.blocks.get(id);
          if (b) {
            const d = ev.delta || {};
            if (typeof d.text === "string") b.ev.text += d.text;
            else if (typeof d.thinking === "string") b.ev.text += d.thinking;
            this.scheduleFlush(id);
          }
        } else if (ev.type === "content_block_stop") {
          this.finishBlock(`${this.streamMsgId}:${ev.index}`);
        }
        break;
      }
      case "assistant": {
        if (m.parent_tool_use_id) break;
        this.retrying = false;
        const msg = m.message as any;
        let ti = 0;
        for (const block of msg.content || []) {
          if (block.type === "tool_use") {
            this.turnTools++;
            // the agent's own to-do list is standing state, not just a tool row
            if (block.name === "TodoWrite") {
              this.todos = parseTodos(block.input);
              this.onChange(this.sid);
            }
            const img = imagePath(block.name, block.input || {}, this.cwd);
            const ev: Extract<ChatEvent, { k: "tool" }> = {
              k: "tool", id: block.id, t: now(), name: block.name,
              title: toolTitle(block.name, block.input || {}),
              input: clip(pretty(block.input), INPUT_CAP), status: "run",
              ...(img ? { img } : {}),
            };
            this.toolEvents.set(block.id, ev);
            this.emit(ev);
            this.onChange(this.sid);
          } else if ((block.type === "text" || block.type === "thinking") && !this.streamedMsgs.has(msg.id)) {
            // partials missed (or disabled): the complete block is the fallback source
            const kind = block.type === "text" ? "text" : "think";
            const text = block.type === "text" ? block.text : block.thinking;
            if (text?.trim()) this.emit({ k: kind, id: `${msg.id}:f${ti}`, t: now(), text, done: true });
          }
          ti++;
        }
        break;
      }
      case "user": {
        if (m.parent_tool_use_id) break;
        const content = (m.message as any)?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type !== "tool_result") continue;
            const ev = this.toolEvents.get(block.tool_use_id);
            if (!ev) continue;
            ev.status = block.is_error ? "err" : "ok";
            ev.output = clip(resultText(block.content), OUTPUT_CAP);
            this.emit(ev);
          }
        }
        break;
      }
      case "tool_progress": {
        const ev = this.toolEvents.get(m.tool_use_id);
        if (ev && ev.status === "run") {
          ev.elapsed = Math.round(m.elapsed_time_seconds);
          this.emit(ev);
        }
        break;
      }
      case "result": {
        this.flushAllBlocks(true);
        this.inflight = false;
        this.retrying = false;
        this.clearing = false;
        this.foreignState = null;
        const wasInterrupting = this.interrupting;
        this.interrupting = false;
        this.costLive = m.total_cost_usd ?? this.costLive;
        this.lastT = now();
        const clean = m.subtype === "success" && !m.is_error && !wasInterrupting;
        if (this.curTurnId) {
          if (clean) {
            if (!this.doneTopIds.includes(this.curTurnId)) this.doneTopIds.push(this.curTurnId);
            this.doneT = now();
          } else {
            this.topIds = this.topIds.filter((id) => id !== this.curTurnId);
          }
          this.trimTops();
          this.curTurnId = null;
        }
        this.emit({
          k: "turn", id: m.uuid || `r${++this.evn}`, t: now(),
          dur: Math.round((m.duration_ms || 0) / 1000),
          cost: this.costBase + this.costLive,
          note: wasInterrupting ? "interrupted" : (m.subtype !== "success" || m.is_error) ? m.subtype.replace(/_/g, " ") : undefined,
        });
        if (m.subtype !== "success") {
          this.setState("blocked", `turn failed: ${m.subtype.replace(/_/g, " ")}`);
        } else {
          this.settle();
        }
        this.onChange(this.sid);
        this.flushSteers();               // an interrupted turn's redirect goes out NOW
        break;
      }
      case "tool_use_summary":
        // the CLI's own one-line caption for the tool run it just finished — the group label
        this.emit({ k: "sum", id: m.uuid || `s${++this.evn}`, t: now(), text: m.summary });
        break;
      case "auth_status":
        if (m.error) {
          this.note(`authentication: ${m.error}`, "err");
          this.setState("blocked", `authentication: ${m.error}`.slice(0, 200));
        } else if (m.isAuthenticating) {
          this.note("authenticating…");
        }
        break;
      case "conversation_reset":
        this.clearing = false;
        this.preambleSent = false;          // a cleared context lost the standing preamble
        this.note("context cleared");
        this.settle();
        break;
      case "rate_limit_event": {
        const i = m.rate_limit_info;
        if (i && i.status !== "allowed") {
          const when = i.resetsAt ? ` — resets ${new Date(i.resetsAt * 1000).toLocaleTimeString()}` : "";
          this.note(i.status === "rejected" ? `rate limit hit${when}` : `nearing the rate limit${when}`,
            i.status === "rejected" ? "err" : "info");
        }
        break;
      }
      default: {
        const h = (TOP_HANDLING as Record<string, string | undefined>)[(m as any).type];
        if (h === undefined) this.foreignKind(`"${(m as any).type}"`);
        break;
      }
    }
  }

  private streamMsgId = "m0";

  private scheduleFlush(id: string) {
    const b = this.blocks.get(id);
    if (!b || b.timer) return;
    b.timer = setTimeout(() => {
      b.timer = null;
      this.emit({ ...b.ev });
    }, 80);
  }

  private finishBlock(id: string) {
    const b = this.blocks.get(id);
    if (!b) return;
    if (b.timer) clearTimeout(b.timer);
    b.ev.done = true;
    if (b.ev.text.trim()) this.emit({ ...b.ev });
    this.blocks.delete(id);
  }

  private flushAllBlocks(done: boolean) {
    for (const id of [...this.blocks.keys()]) {
      if (done) this.finishBlock(id);
    }
  }

  // ── permission / question asks ──────────────────────────────────────────────

  private onCanUseTool(tool: string, input: Record<string, unknown>, o: {
    signal: AbortSignal; suggestions?: PermissionUpdate[];
    title?: string; description?: string; toolUseID: string;
  }): Promise<PermissionResult> {
    // a question is never a permission — it always reaches the user; everything else
    // under a bypass session auto-allows right here (our callback IS the policy)
    if (tool !== "AskUserQuestion" && this.permMode === "bypassPermissions") {
      return Promise.resolve({ behavior: "allow" });
    }
    return new Promise<PermissionResult>((resolve) => {
      const id = `ask-${o.toolUseID}`;
      let ev: PendingAsk["ev"];
      if (tool === "AskUserQuestion") {
        const questions = ((input as any).questions || []) as AskQuestion[];
        ev = {
          k: "ask", id, t: now(), kind: "question",
          title: questions[0]?.question || "The session has a question",
          questions, status: "open",
        };
      } else {
        ev = {
          k: "ask", id, t: now(), kind: "perm",
          title: o.title || `Allow ${tool}?`,
          subtitle: o.description,
          preview: toolPreview(tool, input),
          canAlways: !!o.suggestions?.length,
          status: "open",
        };
      }
      const pending: PendingAsk = { id, resolve, suggestions: o.suggestions, questions: (input as any).questions, ev };
      this.asks.set(id, pending);
      o.signal.addEventListener("abort", () => {
        this.resolveAsk(id, { behavior: "deny", message: "Cancelled.", interrupt: false }, "cancelled");
      });
      this.emit(ev);
      this.settle();
    });
  }

  private resolveAsk(id: string, r: PermissionResult, answerLabel: string) {
    const a = this.asks.get(id);
    if (!a) return;
    this.asks.delete(id);
    a.ev.status = "done";
    a.ev.answer = answerLabel;
    this.emit(a.ev);
    a.resolve(r);
    this.settle();
  }

  answer(askId: string, body: { allow?: boolean; always?: boolean; deny?: boolean; answers?: Record<string, string | string[]> }) {
    const a = this.asks.get(askId);
    if (!a) throw new Error("that question is no longer waiting");
    if (a.ev.kind === "question") {
      const answers = body.answers || {};
      this.resolveAsk(askId, { behavior: "allow", updatedInput: { ...(a.questions ? { questions: a.questions } : {}), answers } }, summarizeAnswers(answers));
      return;
    }
    if (body.deny) {
      this.resolveAsk(askId, { behavior: "deny", message: "Denied by the user.", interrupt: false }, "denied");
    } else if (body.always && a.suggestions?.length) {
      this.resolveAsk(askId, { behavior: "allow", updatedPermissions: a.suggestions }, "allowed always");
    } else {
      this.resolveAsk(askId, { behavior: "allow" }, "allowed");
    }
  }

  // ── user-facing operations ───────────────────────────────────────────────────

  start(prompt?: string) {
    this.ensureClient();
    if (prompt?.trim()) this.send(prompt);
  }

  send(text: string) {
    if (this.ended) throw new Error("this session has ended");
    // taking over a session the mirror sees being driven: say so — two controllers on
    // one transcript interleave rather than corrupt, but the user should know
    if (this.mirrorBusy) {
      this.mirrorBusy = false;
      this.note("heads-up: another controller was driving this session moments ago — turns may interleave until it stops");
    }
    this.ensureClient();
    const t = now();
    this.lastT = t;
    // a message sent while a turn RUNS is a STEER: interrupt + redirect. The bubble
    // lands now; the message delivers the instant the cut turn's result arrives (the
    // user 2026-08-19, whose "run it on an H200" sat queued behind a running scp).
    if (this.inflight) {
      this.emit({ k: "user", id: `u${++this.evn}-${t.toString(36)}`, t, text, steer: true });
      this.steerQueue.push(text);
      void this.interrupt();
      return;
    }
    this.emit({ k: "user", id: `u${++this.evn}-${t.toString(36)}`, t, text });
    this.deliver(text, t);
  }

  private deliver(text: string, t: number) {
    const firstLine = text.trim().split("\n")[0].slice(0, 96);
    if (!firstLine.startsWith("/")) this.goal = firstLine;
    // context ops get their state the moment the user asks (instant feedback); the
    // deciding events (status/compact_boundary, conversation_reset, result) retire them
    const cmd = firstLine.split(/\s/)[0];
    if (cmd === "/clear") this.clearing = true;
    if (cmd === "/compact") this.compacting = true;
    if (!this.inflight) {
      this.curTurnId = `t${t.toString(36)}-${this.evn}`;
      this.topIds.push(this.curTurnId);
      this.trimTops();
      this.turnStart = t;
      this.turnTools = 0;
      this.inflight = true;
    }
    if (this.state === "blocked") this.brief = null;
    // the standing preamble rides the wire only — the chat bubble stays the user's words
    const pre = prefixOutgoing(text, loadPreamble(), this.preambleSent);
    if (pre.sentNow) {
      this.preambleSent = true;
      this.note("standing preamble rode ahead of this message (full text once per conversation, a one-line marker after — ~/.hive/preamble.md)");
    }
    this.pending.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: pre.wire }] },
      parent_tool_use_id: null,
      session_id: this.claudeSessionId ?? "",
    } as SDKUserMessage);
    this.wake?.();
    this.settle();
  }

  // QUEUED delivery — never interrupts: mid-turn it rides the CLI's own queue and fires
  // as the very next turn (measured 2026-08-19: a queued message ran immediately after
  // the running turn's result); idle it's an ordinary send. The cheer engine's lane.
  queueMessage(text: string) {
    if (this.ended) throw new Error("this session has ended");
    this.ensureClient();
    const t = now();
    this.lastT = t;
    this.emit({ k: "user", id: `u${++this.evn}-${t.toString(36)}`, t, text });
    if (!this.inflight) {
      this.deliver(text, t);
      return;
    }
    this.pending.push({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
      session_id: this.claudeSessionId ?? "",
    } as SDKUserMessage);
    this.wake?.();
  }

  // a steer is waiting to deliver — the user's redirect outranks any queued work
  steering(): boolean { return this.steerQueue.length > 0; }

  // the cut turn landed (or died): redirect with everything steered in the meantime
  private flushSteers() {
    if (!this.steerQueue.length || this.inflight || this.ended) return;
    const text = this.steerQueue.splice(0).join("\n\n");
    queueMicrotask(() => { if (!this.ended) this.deliver(text, now()); });
  }

  async interrupt() {
    if (!this.q || !this.inflight) return;
    this.interrupting = true;
    this.setState("interrupting");
    try {
      await this.q.interrupt();
    } catch {
      // an interrupt refused by a dying client resolves via teardown
    }
  }

  rename(name: string) {
    this.name = name;
    this.onChange(this.sid);
  }

  // ── the transcript mirror's hooks (mirror.ts): liveness for sessions SOMETHING ELSE
  // is driving. The mirror never runs while our own client does.
  driving(): boolean { return this.q !== null; }

  mirrorEvents(evs: ChatEvent[]) {
    for (const ev of evs) this.emit(ev);
  }

  mirrorActivity(working: boolean, newTools: number, endedTurn: boolean) {
    this.lastT = now();
    if (working) {
      if (!this.mirrorBusy) { this.mirrorBusy = true; this.turnStart = now(); this.turnTools = 0; }
      this.turnTools += newTools;
    } else {
      this.mirrorBusy = false;
      if (endedTurn) this.doneT = now();     // the outside turn finished — the ✓ can wait for a look
    }
    this.settle();
    this.onChange(this.sid);
  }

  // server going down: cut the client without archiving (end() is the user's gesture)
  shutdown() {
    this.inputsClosed = true;
    this.wake?.();
    try { this.abort?.abort(); } catch { /* already down */ }
  }

  end() {
    this.ended = true;
    this.inputsClosed = true;
    this.wake?.();
    for (const a of [...this.asks.values()]) {
      this.asks.delete(a.id);
      a.resolve({ behavior: "deny", message: "Session ended.", interrupt: true });
    }
    try { this.abort?.abort(); } catch { /* already down */ }
    this.q = null;
  }

  private trimTops() {
    if (this.topIds.length > TOPS_CAP) this.topIds = this.topIds.slice(-TOPS_CAP);
    if (this.doneTopIds.length > TOPS_CAP) this.doneTopIds = this.doneTopIds.slice(-TOPS_CAP);
    this.doneTopIds = this.doneTopIds.filter((id) => this.topIds.includes(id));
  }
}

// ── pure helpers ───────────────────────────────────────────────────────────────

// The child claude must never inherit a PARENT Claude Code session's identity: when
// hive itself runs inside a Claude Code shell, the harness exports CLAUDE_CODE_* and
// a scoped ANTHROPIC_API_KEY that 401s for direct use (seen live, 2026-08-19). The
// session vars always describe the parent, so they always go; the API key goes only
// when CLAUDECODE marks it as the parent's.
function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const nested = !!env.CLAUDECODE;
  for (const k of Object.keys(env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT" || k === "AI_AGENT") delete env[k];
  }
  if (nested) delete env.ANTHROPIC_API_KEY;
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "hive/0.1.0";
  return env;
}

function now(): number { return Math.floor(Date.now() / 1000); }

function pretty(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function clip(s: string, cap: number): string {
  s = s.replace(/data:[a-z/+.-]+;base64,[A-Za-z0-9+/=]{64,}/g, "(base64 data)");
  return s.length > cap ? s.slice(0, cap) + `\n… (${s.length - cap} more chars)` : s;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === "text" ? c.text : c?.type === "image" ? "(image)" : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function firstLine(s: string, cap = 90): string {
  const l = (s || "").trim().split("\n")[0];
  return l.length > cap ? l.slice(0, cap - 1) + "…" : l;
}

// A Read of an image is worth SHOWING, not describing. The tool event carries the
// absolute path only — the UI asks /img for the pixels on demand, so the store and the
// wire never swallow base64 (clip() already redacts blobs for the same reason).
const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

export function servableImage(p: string): boolean {
  return p.startsWith("/") && IMG_EXT.test(p);
}

// cwd resolves a relative Read; pass "" where the cwd is unknown (mirrored history) —
// a relative path there stays undecorated rather than guessing
export function imagePath(name: string, input: Record<string, any>, cwd: string): string | undefined {
  if (name !== "Read") return undefined;
  const p = String(input?.file_path || input?.path || "");
  if (!p || !IMG_EXT.test(p)) return undefined;
  const abs = p.startsWith("/") ? p : cwd ? cwd.replace(/\/+$/, "") + "/" + p : "";
  return servableImage(abs) ? abs : undefined;
}

export function toolTitle(name: string, input: Record<string, any>): string {
  switch (name) {
    case "Bash": return "$ " + firstLine(input.command || input.description || "");
    case "Read": return "Read " + shortPath(input.file_path || input.path || "");
    case "Write": return "Write " + shortPath(input.file_path || input.path || "");
    case "Edit": case "MultiEdit": case "NotebookEdit":
      return "Edit " + shortPath(input.file_path || input.notebook_path || input.path || "");
    case "Grep": return `Grep ${firstLine(input.pattern || "", 50)}`;
    case "Glob": return `Glob ${firstLine(input.pattern || "", 50)}`;
    case "WebFetch": return "Fetch " + firstLine(input.url || "", 70);
    case "WebSearch": return `Search "${firstLine(input.query || "", 60)}"`;
    case "Task": case "Agent": return "Agent — " + firstLine(input.description || input.prompt || "", 60);
    case "Skill": return "Skill " + firstLine(input.skill || "", 40);
    case "TodoWrite": return "Update to-dos";
    case "ExitPlanMode": return "Present plan";
    case "AskUserQuestion": return "Ask a question";
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]}: ${mcp[2]}`;
  const arg = input.file_path || input.path || input.command || input.query || input.url || "";
  return arg ? `${name} ${firstLine(String(arg), 50)}` : name;
}

function shortPath(p: string): string {
  if (p.length <= 60) return p;
  const parts = p.split("/");
  return parts.length > 3 ? "…/" + parts.slice(-3).join("/") : p.slice(-60);
}

// what the user is approving, visualized: Edit → -/+ lines, Write → all +, plan → text
export function toolPreview(tool: string, input: Record<string, any>): { kind: "diff" | "plan"; text: string } | undefined {
  const cap = (s: string) => clip(s, 3000);
  if (tool === "ExitPlanMode" && input.plan) return { kind: "plan", text: cap(String(input.plan)) };
  if ((tool === "Edit" || tool === "NotebookEdit") && (input.old_string || input.new_string)) {
    const path = input.file_path || input.notebook_path || "";
    const minus = String(input.old_string || "").split("\n").map((l: string) => "-" + l);
    const plus = String(input.new_string || "").split("\n").map((l: string) => "+" + l);
    return { kind: "diff", text: cap([path, ...minus, ...plus].join("\n")) };
  }
  if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    const path = input.file_path || "";
    const lines: string[] = [path];
    for (const e of input.edits) {
      lines.push(...String(e.old_string || "").split("\n").map((l: string) => "-" + l));
      lines.push(...String(e.new_string || "").split("\n").map((l: string) => "+" + l));
      lines.push("");
    }
    return { kind: "diff", text: cap(lines.join("\n")) };
  }
  if (tool === "Write" && input.content != null) {
    const path = input.file_path || input.path || "(file)";
    return { kind: "diff", text: cap([path, ...String(input.content).split("\n").map((l: string) => "+" + l)].join("\n")) };
  }
  return undefined;
}

// TodoWrite input → the standing checklist. The agent writes the WHOLE list each call
// (replace semantics), so the latest write is the truth.
export function parseTodos(input: unknown): TodoItem[] {
  const raw = (input as any)?.todos;
  if (!Array.isArray(raw)) return [];
  const out: TodoItem[] = [];
  for (const t of raw.slice(0, 30)) {
    const text = String(t?.content ?? "").trim();
    if (!text) continue;
    const st = t?.status === "completed" ? "done" : t?.status === "in_progress" ? "active" : "pending";
    // the active item reads best in its activeForm ("Building the parser")
    out.push({ text: st === "active" && t?.activeForm ? String(t.activeForm) : text, st });
  }
  return out;
}

function summarizeAnswers(answers: Record<string, string | string[]>): string {
  const vals = Object.values(answers).flat().filter(Boolean);
  return vals.length ? vals.join(", ").slice(0, 120) : "answered";
}
