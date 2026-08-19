# hive

A command center for running many Claude Code sessions in parallel — a 3D honeycomb
board where each session is a little character on its own hex pad, acting out what it's
doing right now, with a chat dock one click away.

The board is a port of [romp](https://github.com/romp-on/romp)'s hive view onto a
deliberately tiny stack: **one Bun process** (server + WebSocket + SQLite + UI build),
sessions driven over the **Claude Agent SDK**, nothing else.

## What it does

- **One glance, every session.** Pads glow their status (working / needs-you / blocked /
  retrying / compacting / idle); the beans act it out — typing at a desk, waving when a
  question waits on you, head-in-hands on an API error, meditating through a compaction.
- **Drag and drop everything.** Drag a model bean from the tray onto any hexagon to
  spawn a session there. Drag a session's bean to the trash dock to end it, or to
  another hex to move it home. Click a nameplate to rename in place.
- **Chat that stays out of the way.** Click any bean: a dock slides in with streaming
  markdown, folded thinking, tool runs grouped into one-line expandable rows,
  permission/question cards answered inline (with diff previews), cost per turn, and
  steer-while-running.
- **Honest state.** Everything moves on real SDK events, never timers. A state this app
  doesn't recognize shows up as itself (pale pad, "?" overhead) instead of being coerced
  — and typechecking fails when an SDK upgrade grows the vocabulary.
- **Sessions survive.** Real Claude Code transcripts on disk; any session can be resumed
  from a terminal with `claude --resume <id>`. Kill the server, restart it, everything
  revives.

## Run it

Needs [Bun](https://bun.sh) and a signed-in [Claude Code](https://claude.com/claude-code).

```bash
bun install
bun start          # http://localhost:4483
```

`HIVE_PORT` / `HIVE_BIND` / `HIVE_HOME` override the port, bind address, and data dir.
Keep the bind on 127.0.0.1 and reach a remote machine over an SSH tunnel:

```bash
ssh -N -L 4484:localhost:4483 yourbox   # then open http://localhost:4484
```

## Develop

```bash
bun dev            # watch mode
bun test           # unit tests (hermetic)
bun run typecheck
bun run tests/e2e.ts   # live end-to-end (costs one tiny haiku turn)
```

## License

Apache-2.0
