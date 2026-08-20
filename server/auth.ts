// The token gate — armed by setting HIVE_TOKEN. Every HTTP route and the WebSocket
// upgrade require the token; a browser presents it ONCE (?key=… on any URL) and gets a
// year-long cookie, so the phone bookmark is just the URL with the key. Without
// HIVE_TOKEN nothing changes (the localhost-only dev setup stays frictionless).
//
// No localhost bypass ON PURPOSE: private exposure proxies (tailscale serve, an SSH
// tunnel) arrive AS localhost — a bypass would hollow the gate out exactly when it
// matters. Pure check; main.ts wires it.

export const TOKEN_COOKIE = "hive_key";

export interface AuthPeek {
  urlToken: string | null;       // ?key=…
  cookie: string | null;         // hive_key=…
  bearer: string | null;         // Authorization: Bearer …
}

export function peek(req: Request): AuthPeek {
  const url = new URL(req.url);
  const cookies = req.headers.get("cookie") || "";
  const m = new RegExp(`(?:^|;\\s*)${TOKEN_COOKIE}=([^;]+)`).exec(cookies);
  const auth = req.headers.get("authorization") || "";
  const b = /^Bearer\s+(.+)$/i.exec(auth);
  return {
    urlToken: url.searchParams.get("key"),
    cookie: m ? decodeURIComponent(m[1]) : null,
    bearer: b ? b[1] : null,
  };
}

// constant-time-ish compare (token lengths are fixed and secrets are random hex —
// a timing oracle on length is useless, but don't leak content matches early)
function eq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export type AuthVerdict = "open" | "ok" | "setCookie" | "deny";

export function verdict(p: AuthPeek, token: string | undefined): AuthVerdict {
  if (!token) return "open";
  if (p.cookie && eq(p.cookie, token)) return "ok";
  if (p.bearer && eq(p.bearer, token)) return "ok";
  if (p.urlToken && eq(p.urlToken, token)) return "setCookie";
  return "deny";
}

export function cookieHeader(token: string): string {
  // SameSite=Lax + HttpOnly; Secure is omitted so an SSH-tunnel http://localhost
  // still works — the private-network exposure (tailscale serve) terminates TLS itself
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
}
