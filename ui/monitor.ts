// Monitor/task-notification lines — the harness plumbing that carries them is ugly by
// construction (<task-notification> XML around a progress line). Parsed here into the
// bits a human wants: what's being watched, the latest event, and the progress if the
// line carries one. Pure; tested.

export interface MonitorLine {
  summary: string;              // what's being watched ("d26_r10 training…")
  event: string;                // the latest line
  pct: number | null;           // 0..100 when the event carries progress
}

export function parseMonitor(text: string): MonitorLine | null {
  if (!text.includes("<task-notification>")) return null;
  const grab = (tag: string) => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
    return m ? m[1].trim() : "";
  };
  const event = grab("event");
  let summary = grab("summary");
  // the summary often wraps the watcher description in quotes inside boilerplate
  const q = /"([^"]+)"/.exec(summary);
  if (q) summary = q[1];
  summary = summary.replace(/^Monitor event:\s*/i, "").trim();
  if (!event && !summary) return null;
  let pct: number | null = null;
  const p = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(event);
  if (p) pct = Math.min(100, Number(p[1]));
  else {
    const s = /step\s+0*(\d+)\s*\/\s*0*(\d+)/i.exec(event);
    if (s && Number(s[2]) > 0) pct = Math.min(100, (Number(s[1]) / Number(s[2])) * 100);
  }
  return { summary, event: event || summary, pct };
}
