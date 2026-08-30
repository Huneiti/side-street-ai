import { describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_SECONDS,
  TOKEN_SUBPROTOCOL_PREFIX,
  tokenFromSubprotocols,
  tokenSubprotocols,
  DEFAULT_TOKEN_TTL_SECONDS,
  mintSessionToken,
  timingSafeEqual,
  verifySessionToken,
  type MintInput,
} from "../src/session-token.js";

const SECRET = "not-a-real-token-secret";
const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);

const viewer: MintInput = {
  sessionId: "incident-42",
  participantId: "alice",
  audience: "viewer",
  displayName: "Alice",
  role: "driver",
  now: NOW,
};

const check = { sessionId: "incident-42", audience: "viewer", now: NOW } as const;

/** Re-encodes a claim set onto a token without re-signing it. */
function tamper(token: string, edit: (claims: Record<string, unknown>) => void): string {
  const [header, payload, signature] = token.split(".") as [string, string, string];
  const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<
    string,
    unknown
  >;
  edit(claims);
  const reencoded = btoa(JSON.stringify(claims))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${reencoded}.${signature}`;
}

describe("a token round-trips", () => {
  it("carries the identity and the granted role", async () => {
    const token = await mintSessionToken(viewer, SECRET);
    const result = await verifySessionToken(token, SECRET, check);
    expect(result).toMatchObject({
      ok: true,
      claims: { sid: "incident-42", sub: "alice", aud: "viewer", name: "Alice", role: "driver" },
    });
  });

  it("expires by default without anyone setting a lifetime", async () => {
    const token = await mintSessionToken(viewer, SECRET);
    const result = await verifySessionToken(token, SECRET, check);
    if (!result.ok) throw new Error("expected a valid token");
    expect(result.claims.exp - result.claims.iat).toBe(DEFAULT_TOKEN_TTL_SECONDS);
  });
});

describe("what it refuses", () => {
  it("refuses a signature made with another secret", async () => {
    const token = await mintSessionToken(viewer, "someone-elses-secret");
    expect(await verifySessionToken(token, SECRET, check)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("refuses claims edited after signing — including a self-promotion", async () => {
    const token = await mintSessionToken({ ...viewer, role: "observer" }, SECRET);
    // The whole point of the change: an Observer cannot rewrite themselves
    // into the Driver, which is exactly what a query parameter allowed.
    const promoted = tamper(token, (claims) => {
      claims["role"] = "driver";
    });
    expect(await verifySessionToken(promoted, SECRET, check)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("refuses a token minted for another session", async () => {
    const token = await mintSessionToken({ ...viewer, sessionId: "someone-elses" }, SECRET);
    expect(await verifySessionToken(token, SECRET, check)).toEqual({
      ok: false,
      reason: "wrong-session",
    });
  });

  it("refuses a viewer token on the agent socket, and the reverse", async () => {
    const viewerToken = await mintSessionToken(viewer, SECRET);
    expect(await verifySessionToken(viewerToken, SECRET, { ...check, audience: "agent" })).toEqual({
      ok: false,
      reason: "wrong-audience",
    });

    const agentToken = await mintSessionToken(
      { sessionId: "incident-42", participantId: "sandbox", audience: "agent", now: NOW },
      SECRET,
    );
    expect(await verifySessionToken(agentToken, SECRET, check)).toEqual({
      ok: false,
      reason: "wrong-audience",
    });
  });

  it("refuses an expired token, allowing for clock skew", async () => {
    const token = await mintSessionToken({ ...viewer, ttlSeconds: 60 }, SECRET);
    const justInside = NOW + (60 + CLOCK_SKEW_SECONDS - 5) * 1000;
    const wellPast = NOW + (60 + CLOCK_SKEW_SECONDS + 5) * 1000;
    expect(await verifySessionToken(token, SECRET, { ...check, now: justInside })).toMatchObject({
      ok: true,
    });
    expect(await verifySessionToken(token, SECRET, { ...check, now: wellPast })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("refuses a token from the future beyond skew", async () => {
    const token = await mintSessionToken({ ...viewer, now: NOW + 600_000 }, SECRET);
    expect(await verifySessionToken(token, SECRET, check)).toEqual({
      ok: false,
      reason: "not-yet-valid",
    });
  });

  it("refuses a viewer token carrying no role", async () => {
    // A role-less viewer token would land in the session with nothing to
    // enforce against, which is the state this whole mechanism removes.
    const token = await mintSessionToken({ ...viewer, role: undefined }, SECRET);
    expect(await verifySessionToken(token, SECRET, check)).toEqual({
      ok: false,
      reason: "missing-role",
    });
  });

  it("refuses `alg: none` and anything else it was not expecting", async () => {
    const token = await mintSessionToken(viewer, SECRET);
    const [, payload, signature] = token.split(".") as [string, string, string];
    const none = btoa(JSON.stringify({ alg: "none", typ: "JWT" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifySessionToken(`${none}.${payload}.`, SECRET, check)).toEqual({
      ok: false,
      reason: "unsupported-algorithm",
    });
    expect(await verifySessionToken(`${none}.${payload}.${signature}`, SECRET, check)).toEqual({
      ok: false,
      reason: "unsupported-algorithm",
    });
  });

  it("refuses anything that is not three segments", async () => {
    for (const bad of ["", "a", "a.b", "a.b.c.d", "....", "not a token at all"]) {
      expect(await verifySessionToken(bad, SECRET, check)).toMatchObject({ ok: false });
    }
  });

  it("refuses a well-signed token whose claims are not a claim set", async () => {
    // Signed by us, but the payload is not what we mint — a signing oracle
    // reused for something else must not open a session.
    const junk = btoa(JSON.stringify({ hello: "world" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const header = (await mintSessionToken(viewer, SECRET)).split(".")[0] as string;
    const signingInput = `${header}.${junk}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
    const encoded = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await verifySessionToken(`${signingInput}.${encoded}`, SECRET, check)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("timingSafeEqual", () => {
  it("compares without an early return on content", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    // Different lengths cannot be compared in constant time and are not equal.
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("the subprotocol a token travels under", () => {
  it("round-trips", () => {
    const offered = tokenSubprotocols("abc.def.ghi");
    expect(offered).toEqual([`${TOKEN_SUBPROTOCOL_PREFIX}abc.def.ghi`]);
    expect(tokenFromSubprotocols(offered)).toBe("abc.def.ghi");
  });

  it("offers nothing when there is no token, so an insecure deployment still connects", () => {
    expect(tokenSubprotocols(undefined)).toEqual([]);
    expect(tokenSubprotocols("")).toEqual([]);
    expect(tokenFromSubprotocols([])).toBeUndefined();
  });

  it("finds the token among other offered protocols, and tolerates whitespace", () => {
    expect(tokenFromSubprotocols(["chat", ` ${TOKEN_SUBPROTOCOL_PREFIX}xyz `, "superchat"])).toBe(
      "xyz",
    );
  });

  it("ignores a bare prefix carrying no token", () => {
    expect(tokenFromSubprotocols([TOKEN_SUBPROTOCOL_PREFIX])).toBeUndefined();
  });

  it("emits a value that is a legal subprotocol token", () => {
    // RFC 6455 subprotocol names are RFC 7230 tokens: no spaces, no commas,
    // and crucially no "=" — which is why the JWT base64url is unpadded.
    const [value] = tokenSubprotocols("aGVsbG8.d29ybGQ.c2ln-_x") as [string];
    expect(value).toMatch(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
  });
});
