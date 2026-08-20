import { describe, expect, test } from "bun:test";
import { cookieHeader, peek, verdict } from "../server/auth";

const T = "a".repeat(32);

function req(over: { url?: string; cookie?: string; auth?: string } = {}): Request {
  const h = new Headers();
  if (over.cookie) h.set("cookie", over.cookie);
  if (over.auth) h.set("authorization", over.auth);
  return new Request(over.url || "http://x/", { headers: h });
}

describe("token gate", () => {
  test("no token configured → open", () => {
    expect(verdict(peek(req()), undefined)).toBe("open");
  });

  test("cookie or bearer match → ok; ?key match → setCookie; anything else → deny", () => {
    expect(verdict(peek(req({ cookie: `hive_key=${T}` })), T)).toBe("ok");
    expect(verdict(peek(req({ auth: `Bearer ${T}` })), T)).toBe("ok");
    expect(verdict(peek(req({ url: `http://x/go?key=${T}` })), T)).toBe("setCookie");
    expect(verdict(peek(req({ url: "http://x/go" })), T)).toBe("deny");
    expect(verdict(peek(req({ cookie: `hive_key=${"b".repeat(32)}` })), T)).toBe("deny");
    expect(verdict(peek(req({ url: `http://x/?key=${T.slice(0, 31)}` })), T)).toBe("deny");
  });

  test("cookie header round-trips through peek", () => {
    const set = cookieHeader(T);
    const value = set.split(";")[0];
    expect(verdict(peek(req({ cookie: value })), T)).toBe("ok");
  });

  test("localhost gets NO bypass — private proxies arrive as localhost", () => {
    expect(verdict(peek(req({ url: "http://127.0.0.1:4483/" })), T)).toBe("deny");
  });
});
