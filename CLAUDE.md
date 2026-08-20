# hive — repo instructions

A single-user command center for Claude Code sessions: romp's hive board (the 3D
honeycomb, ported nearly verbatim from ../romp-hive) on a drastically simpler stack,
with a chat rebuilt from scratch. One Bun process, no kernel, no tmux, no panes.

## Architecture

- **`server/`** — Bun. `main.ts` (Bun.serve: static + one WebSocket with topic pub/sub),
  `hub.ts` (session registry + fanout), `session.ts` (one Claude Code session over
  `@anthropic-ai/claude-agent-sdk`; SDK stream → board states + upsertable chat events),
  `store.ts` (bun:sqlite under `~/.hive`), `proto.ts` (the wire types, shared with the UI),
  `build.ts` (Bun.build of the UI, run at every server boot).
- **`ui/`** — browser. `hive.ts` (the WebGL world: pads, beans, tray, trash, rename),
  `hive-layout.ts` + `hive-model.ts` (pure, tested), `chat.ts` (the dock), `markdown.ts`
  (safe renderer), `net.ts` (the socket), `boot.ts` (glue), `index.html`, `styles.css`.
- Run: `bun start` (or `bun dev` for watch). Test: `bun test`. Types: `bun run typecheck`.
  Live checks that cost a haiku turn: `bun run tests/smoke.ts`, `bun run tests/e2e.ts`.

## Rules inherited from romp (they earned them)

- **Events over heuristics.** State moves on SDK events (`session_state_changed`,
  `status`, `api_retry`, `result`, a pending ask) — never timers. The board animates only
  from `diffSessions` events; an identical payload twice must yield zero events.
- **Fail loudly, never degrade silently.** An unknown wire state passes through verbatim
  and renders as an explicit "unknown state" (? bubble, named in the tip/card) — never
  coerced to ready. The `Record<WireSessionState, …>` maps in `session.ts` are exhaustive
  over the SDK's unions so `tsc` breaks when an SDK upgrade grows the vocabulary.
- **Click-safety** (`ui/actions.ts`): actions delegate to stable roots via `data-act`;
  every activation flashes immediately, before any round-trip.
- **Latches, not flaps**: unseen-done ✓ / unseen-ask shout clear only on the user's own
  look gesture; trash-drop suppression holds a sid out until a payload omits it
  (`foldEnding`), with a loud backstop if the end didn't take.
- **Drag and drop only** (the user, 2026-08-19): sessions are created by dragging a model
  bean from the tray onto a hexagon. No picker, no modal, anywhere.

## Romp is a MIGRATION SOURCE, never a dependency (the user, 2026-08-19)

Romp is being retired. `server/romp.ts` is a delete-safe shim that reads romp's state
registry (`~/.local/state/romp/names` + `sdk/`) only to DISCOVER sessions during the
overlap window; everything imported lives in hive's own store from that moment on.
`adoptMode` (server/adopt.ts, tested) is the policy: romp present → mirror its set;
romp absent after the cold-start stamp → adopt nothing, ever — deleting romp's state
dir must be a non-event for the board. When romp is finally gone, `server/romp.ts`
and its call sites can be deleted outright. Do not add any new code path that reads
romp state, mimics romp wire formats, or assumes romp exists.

## Session backend

SDK only (the user, 2026-08-19: one backend, whichever is best). It runs the same
`claude` binary and writes real transcripts under `~/.claude/projects`, so any hive
session can be resumed from a terminal with `claude --resume <claude_session_id>`.
`bypassPermissions` is enforced in our `canUseTool` callback (auto-allow) rather than via
the SDK mode — the real mode shadows the callback and would swallow AskUserQuestion.
When hive itself runs inside a Claude Code shell, `cleanEnv()` strips the parent's
CLAUDE_CODE_* identity and its scoped ANTHROPIC_API_KEY (it 401s for direct use).

## Testing

Every bug fix or feature lands with a test beside the pure logic it pins (`tests/`).
Keep `bun test` hermetic (no network, no claude); the live checks stay in plain scripts.
