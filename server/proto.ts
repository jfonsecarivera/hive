// Wire protocol shared by the server and the UI. One WebSocket carries everything:
// the board snapshot fans out on the "hive" topic, each chat on "chat:<sid>".
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

// The board's state vocabulary. The wire stays OPEN on purpose: a state the CLI
// invents after this ships passes through as its raw string, and the UI renders it
// as an explicit "unknown state" rather than silently coercing it to ready
// (fail loudly — the romp rule this app inherits). Server-side, exhaustive
// Record<> maps over the SDK's own unions make `tsc` fail when an SDK upgrade
// grows the vocabulary, so drift is caught at typecheck time too.
export const KNOWN_STATES = [
  "opening", "working", "awaiting", "blocked", "retrying",
  "awaitingBg", "compacting", "clearing", "interrupting", "ready",
] as const;
export type HiveState = (typeof KNOWN_STATES)[number];
export type WireState = HiveState | (string & {});

export interface TodoItem { text: string; st: "pending" | "active" | "done" }
export interface BgTask { id: string; type: string; desc: string }

export interface SessionSnap {
  sid: string;
  name: string;
  color: { bg: string; fg: string };
  state: WireState;
  lastT: number;                  // last activity — "faded" derives from this at RENDER time
  goal: string | null;
  brief: string | null;
  narration: { since: number; toolUses: number } | null;
  needsYou: boolean;
  needsYouT: number;
  liveAsk: boolean;
  doneT: number;
  todos: TodoItem[];              // the agent's own to-do list (TodoWrite), latest write wins
  bg: BgTask[];                   // live background tasks (SDK replace-semantics set)
  duty: { everyS: number; nextT: number; selfPaced: boolean } | null;   // the standing job, when this bean has one
  topIds: string[];
  doneTopIds: string[];
  model: string;
  effort: string;
  permMode: string;
  cwd: string;
  cost: number;
}

export interface AskOption { label: string; description?: string }
export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

// Chat events are UPSERTS keyed by id: a streaming text block or a running tool
// re-sends the same id with more data, and the UI patches the node in place.
export type ChatEvent =
  | { k: "user"; id: string; t: number; text: string; steer?: boolean }
  | { k: "text"; id: string; t: number; text: string; done: boolean }
  | { k: "think"; id: string; t: number; text: string; done: boolean }
  | { k: "tool"; id: string; t: number; name: string; title: string;
      input?: string; output?: string; status: "run" | "ok" | "err"; elapsed?: number;
      img?: string }   // absolute path of an image this tool read — the UI shows it via /img

  | { k: "ask"; id: string; t: number; kind: "perm" | "question";
      title: string; subtitle?: string;
      preview?: { kind: "diff" | "plan"; text: string };
      canAlways?: boolean; questions?: AskQuestion[];
      status: "open" | "done"; answer?: string }
  | { k: "turn"; id: string; t: number; dur: number; cost?: number; note?: string }
  | { k: "sum"; id: string; t: number; text: string }   // the CLI's caption for a tool run
  | { k: "note"; id: string; t: number; text: string; tone: "info" | "err" };

// a session's live slash commands (dynamic: supportedCommands + commands_changed)
export interface CmdInfo { name: string; description: string; argumentHint: string }

// a saved specialist on the duty shelf
export interface ShelfItem { name: string; every: string; model?: string; live: boolean }

// one session's ETA record — written by agents via the hive_eta tool (modeled on the
// user's eta-dash: structured fields, machine-readable deadline, human confidence)
export interface EtaRow {
  name: string;                  // the session it's ABOUT (keeper duties write peers')
  gist?: string;                 // the one-liner the board leads with
  task?: string;
  etaText?: string;              // human phrasing ("~2:30 PM PT, after evals")
  etaIso?: string;               // machine deadline → the ticking countdown
  conf?: string;                 // "high" / "med" / …
  status?: string;               // working|pending|done|blocked|idle|gone (open vocab)
  detail?: string;
  milestone?: string;
  updatedT: number;              // last write (epoch s) — staleness is shown, never hidden
}

// the sky over the user's head — polled from Open-Meteo, ambience only. The code rides
// the wire verbatim (open vocab): one the UI doesn't know renders as "unknown" + the
// raw number, never coerced to clear.
export interface Weather {
  code: number;                  // WMO weather code
  tempC: number;
  cloud: number;                 // cover, 0..100
  windKmh: number;
  isDay: boolean;
  place: string;                 // city label for the chip
  rises: number[];               // sunrise/sunset epoch-seconds, today + tomorrow —
  sets: number[];                //   the dawn/dusk blend math needs the pair around now
  fetchedT: number;              // epoch s of the reading — staleness is shown, never hidden
}

export interface Defaults {
  model: string;
  effort: string;
  permMode: string;
  cwd: string;
}

export interface ModelChoice { value: string; label: string }

// client → server
export type ClientOp =
  | { op: "create"; name?: string; model?: string; effort?: string; cwd?: string; permMode?: string; prompt?: string }
  | { op: "send"; sid: string; text: string }
  | { op: "interrupt"; sid: string }
  | { op: "end"; sid: string }
  | { op: "rename"; sid: string; name: string }
  | { op: "answer"; sid: string; askId: string;
      allow?: boolean; always?: boolean; deny?: boolean;
      answers?: Record<string, string | string[]> }
  | { op: "watch"; sid: string }
  | { op: "unwatch"; sid: string }
  | { op: "summon"; name: string }        // hire a shelf specialist (duty tray drag)
  | { op: "unsave"; name: string }        // remove a specialist from the shelf for good
  | { op: "setDefaults"; model?: string; effort?: string; cwd?: string; permMode?: string };

// server → client
export type ServerMsg =
  | { type: "hive"; sessions: SessionSnap[] }
  | { type: "chat"; sid: string; reset?: boolean; events: ChatEvent[] }
  | { type: "caps"; sid: string; commands: CmdInfo[] }
  | { type: "etas"; etas: EtaRow[] }
  | { type: "weather"; w: Weather }
  | { type: "defaults"; host: string; defaults: Defaults; models: ModelChoice[]; efforts: string[];
      shelf: ShelfItem[] }
  | { type: "err"; sid?: string; title: string; text?: string }
  | { type: "warn"; sid?: string; text: string };

// Effort vocabulary, tripwired to the SDK's own union: when an SDK upgrade adds a
// level, this Record stops compiling — the drift is caught at typecheck, not in prod.
const EFFORT_SET: Record<EffortLevel, true> = {
  low: true, medium: true, high: true, xhigh: true, max: true,
};
export const EFFORTS = Object.keys(EFFORT_SET) as EffortLevel[];

// The static fallback shown before any live session has reported the real list —
// hub swaps in `supportedModels()` from the first session that connects.
export const MODELS: ModelChoice[] = [
  { value: "fable", label: "Fable" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];
