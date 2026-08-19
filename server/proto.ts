// Wire protocol shared by the server and the UI. One WebSocket carries everything:
// the board snapshot fans out on the "hive" topic, each chat on "chat:<sid>".

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

export interface SessionSnap {
  sid: string;
  name: string;
  color: { bg: string; fg: string };
  state: WireState;
  faded: boolean;
  goal: string | null;
  brief: string | null;
  narration: { since: number; toolUses: number } | null;
  needsYou: boolean;
  needsYouT: number;
  liveAsk: boolean;
  doneT: number;
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
  | { k: "user"; id: string; t: number; text: string }
  | { k: "text"; id: string; t: number; text: string; done: boolean }
  | { k: "think"; id: string; t: number; text: string; done: boolean }
  | { k: "tool"; id: string; t: number; name: string; title: string;
      input?: string; output?: string; status: "run" | "ok" | "err"; elapsed?: number }
  | { k: "ask"; id: string; t: number; kind: "perm" | "question";
      title: string; subtitle?: string;
      preview?: { kind: "diff" | "plan"; text: string };
      canAlways?: boolean; questions?: AskQuestion[];
      status: "open" | "done"; answer?: string }
  | { k: "turn"; id: string; t: number; dur: number; cost?: number; note?: string }
  | { k: "note"; id: string; t: number; text: string; tone: "info" | "err" };

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
  | { op: "setDefaults"; model?: string; effort?: string; cwd?: string; permMode?: string };

// server → client
export type ServerMsg =
  | { type: "hive"; sessions: SessionSnap[] }
  | { type: "chat"; sid: string; reset?: boolean; events: ChatEvent[] }
  | { type: "defaults"; defaults: Defaults; models: ModelChoice[]; efforts: string[] }
  | { type: "err"; sid?: string; title: string; text?: string }
  | { type: "warn"; sid?: string; text: string };

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const MODELS: ModelChoice[] = [
  { value: "fable", label: "Fable" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];
