// Slash-command autocomplete logic — pure, tested. The list itself is DYNAMIC: it is
// whatever the live session reported (supportedCommands / commands_changed), never a
// hardcoded copy of some CLI version's menu.
import type { CmdInfo } from "../server/proto";

// The composer text is "command territory" only while the caret is still inside the
// leading /word — a slash mid-sentence, or a command already followed by arguments,
// must never pop a menu over what the user is typing.
export function commandPrefix(text: string): string | null {
  const m = /^\/([A-Za-z0-9:_-]*)$/.exec(text);
  return m ? m[1].toLowerCase() : null;
}

// Rank: exact > prefix > substring, then shorter names first — so "/c" puts /clear and
// /compact right at the top instead of whatever sorts alphabetically that day.
export function filterCommands(cmds: CmdInfo[], prefix: string, cap = 8): CmdInfo[] {
  const p = prefix.toLowerCase();
  const scored: { c: CmdInfo; s: number }[] = [];
  for (const c of cmds) {
    const n = c.name.replace(/^\//, "").toLowerCase();
    let s: number;
    if (n === p) s = 0;
    else if (n.startsWith(p)) s = 1;
    else if (p && n.includes(p)) s = 2;
    else if (!p) s = 1;
    else continue;
    scored.push({ c, s });
  }
  scored.sort((a, b) => a.s - b.s || a.c.name.length - b.c.name.length || a.c.name.localeCompare(b.c.name));
  return scored.slice(0, cap).map((x) => x.c);
}

// what accepting a suggestion leaves in the composer: the command, plus a trailing
// space only when it takes arguments (argumentHint says so)
export function acceptCommand(c: CmdInfo): string {
  const name = c.name.startsWith("/") ? c.name : "/" + c.name;
  return c.argumentHint ? name + " " : name;
}
