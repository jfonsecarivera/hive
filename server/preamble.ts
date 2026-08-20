// The standing preamble — instructions the user wants riding ahead of everything they
// say (the ask, 2026-08-20: ADHD output shaping on every message). The FULL text goes
// out once per conversation and again after every /clear; every later message carries a
// clearly-marked one-line reminder instead — repeating 5KB of instructions on every turn
// would bury the very conversation the model is supposed to be reading. The source of
// truth is ~/.hive/preamble.md (hand-editable, like duties.json): an absent or empty
// file disables the feature, HIVE_PREAMBLE=0 force-disables it. Pure logic here
// (tested); session.ts applies it at the single outgoing funnel.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export function preamblePath(): string {
  return join(process.env.HIVE_HOME || join(process.env.HOME || ".", ".hive"), "preamble.md");
}

let cache: { path: string; body: string; mtimeMs: number } | null = null;

export function loadPreamble(path = preamblePath()): string {
  if (process.env.HIVE_PREAMBLE === "0") return "";
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (!cache || cache.path !== path || cache.mtimeMs !== mtimeMs) {
      cache = { path, body: readFileSync(path, "utf8").trim(), mtimeMs };
    }
    return cache.body;
  } catch {
    cache = null;
    return "";
  }
}

// what actually goes on the wire for one outgoing message. The framing marks the
// injected part unmistakably, so the model never confuses it with the user's own words.
export function prefixOutgoing(
  text: string, body: string, alreadySent: boolean,
): { wire: string; sentNow: boolean } {
  // a slash command must stay a slash command — a prefixed /compact would land as prose
  if (!body || text.trimStart().startsWith("/")) return { wire: text, sentNow: false };
  if (alreadySent) {
    return {
      wire: "(Standing instructions from the user, sent earlier in this conversation, remain in force — shape this reply by them.)\n\n" + text,
      sentNow: false,
    };
  }
  return {
    wire: "[The user has requested the following STANDING INSTRUCTIONS. They govern how you " +
      "shape every reply for the rest of this conversation. The user's actual message " +
      "follows after the divider.]\n\n" + body + "\n\n---\n\n[The user's message:]\n\n" + text,
    sentNow: true,
  };
}
