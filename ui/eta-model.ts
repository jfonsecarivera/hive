// The ETA board's pure logic (modeled on the user's eta-dash): rank what needs eyes
// first, tick countdowns to eta_iso, and merge the WRITTEN record with the LIVE board —
// a record claiming "working" about a session that isn't on the board (or isn't
// working) wears an honest "not live" flag instead of a stale green dot.
import type { EtaRow, SessionSnap } from "../server/proto";

export interface EtaView extends EtaRow {
  live: SessionSnap | null;      // the session on the board right now, if any
  offline: boolean;              // record says working, the board says otherwise
}

const RANK: Record<string, number> = {
  blocked: 0, offline: 1, working: 2, pending: 3, idle: 4, done: 5, gone: 6,
};

export function effectiveStatus(v: EtaView): string {
  return v.offline ? "offline" : (v.status || "pending");
}

export function rankEtas(rows: EtaRow[], sessions: SessionSnap[]): EtaView[] {
  const byName = new Map(sessions.map((s) => [s.name, s] as const));
  return rows
    .map((r) => {
      const live = byName.get(r.name) || null;
      const claimsLive = r.status === "working" || r.status === "pending";
      return { ...r, live, offline: claimsLive && !live } as EtaView;
    })
    .sort((a, b) => {
      const ra = RANK[effectiveStatus(a)] ?? 3;
      const rb = RANK[effectiveStatus(b)] ?? 3;
      if (ra !== rb) return ra - rb;
      // inside a rank, the nearest deadline first, then the freshest write
      const da = a.etaIso ? Date.parse(a.etaIso) : Infinity;
      const db = b.etaIso ? Date.parse(b.etaIso) : Infinity;
      if (da !== db) return da - db;
      return b.updatedT - a.updatedT;
    });
}

// countdown text for a deadline: "3:07" / "47:12" / "2h 05m" / "1d 4h"; late shows the
// overrun the same way (the caller styles it)
export function cdText(msLeft: number): string {
  const s = Math.floor(Math.abs(msLeft) / 1000);
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  const m = Math.floor(s / 60), ss = s % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
}

export function agoText(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const STATUS_WORD: Record<string, string> = {
  pending: "—", done: "✓ done", blocked: "⛔ blocked", idle: "⏸ idle",
  gone: "✕ gone", offline: "⚠ not live",
};
