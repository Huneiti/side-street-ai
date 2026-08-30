/**
 * Identity at the socket (ADR-0005), with a token secret configured.
 *
 * Its own config and its own directory because the secret is a Worker
 * binding: `test/` runs in insecure mode, which is the `pnpm dev` path and
 * the behaviour most of the product is exercised under, and this runs the
 * verified path. A test cannot flip the binding at runtime — the Worker reads
 * it per request from the configured environment, not from the test's copy.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintSessionToken, type MintInput } from "@side-street/core";
import { BASE, connect, freshSession } from "../test/harness.js";

const SECRET = "not-a-real-token-secret";
const PREFIX = "side-street.token.";

const token = (input: MintInput, secret = SECRET): Promise<string> =>
  mintSessionToken(input, secret);

const viewer = (sessionId: string, over: Partial<MintInput> = {}): MintInput => ({
  sessionId,
  participantId: "alice",
  audience: "viewer",
  displayName: "Alice",
  role: "driver",
  ...over,
});

async function attempt(path: string, jwt?: string): Promise<Response> {
  return await SELF.fetch(`${BASE}${path}`, {
    headers: {
      Upgrade: "websocket",
      ...(jwt === undefined ? {} : { "Sec-WebSocket-Protocol": `${PREFIX}${jwt}` }),
    },
  });
}

describe("a viewer with a token", () => {
  it("joins as whoever the token says, and is told identity is verified", async () => {
    const sessionId = freshSession();
    const jwt = await token(viewer(sessionId));
    const alice = await connect(`/session/${sessionId}/ws`, {
      "Sec-WebSocket-Protocol": `${PREFIX}${jwt}`,
    });
    const welcome = await alice.waitFor((f) => f["type"] === "welcome");
    expect(welcome).toMatchObject({
      participantId: "alice",
      role: "driver",
      identityVerified: true,
    });
  });

  it("takes identity from the claims, never from the query string", async () => {
    const sessionId = freshSession();
    // The token says navigator; the URL asks for driver. The URL loses.
    const jwt = await token(viewer(sessionId, { participantId: "bob", role: "navigator" }));
    const bob = await connect(
      `/session/${sessionId}/ws?participantId=mallory&displayName=Mallory&role=driver`,
      { "Sec-WebSocket-Protocol": `${PREFIX}${jwt}` },
    );
    const welcome = await bob.waitFor((f) => f["type"] === "welcome");
    expect(welcome).toMatchObject({ participantId: "bob", role: "navigator" });
  });
});

describe("what the socket refuses once a secret is set", () => {
  it("refuses a connection with no token at all", async () => {
    const sessionId = freshSession();
    const response = await attempt(
      `/session/${sessionId}/ws?participantId=mallory&displayName=M&role=driver`,
    );
    expect(response.status).toBe(401);
  });

  it("refuses a token signed by someone else", async () => {
    const sessionId = freshSession();
    const jwt = await token(viewer(sessionId), "someone-elses-secret");
    expect((await attempt(`/session/${sessionId}/ws`, jwt)).status).toBe(401);
  });

  it("refuses a token minted for another session", async () => {
    const jwt = await token(viewer(freshSession()));
    expect((await attempt(`/session/${freshSession()}/ws`, jwt)).status).toBe(401);
  });

  it("refuses an expired token", async () => {
    const sessionId = freshSession();
    const jwt = await token(viewer(sessionId, { ttlSeconds: 1, now: Date.now() - 600_000 }));
    expect((await attempt(`/session/${sessionId}/ws`, jwt)).status).toBe(401);
  });

  it("refuses a viewer token on the agent socket", async () => {
    // The socket that had no authentication at all: with one, a viewer's
    // credential must not let them speak as the sandbox.
    const sessionId = freshSession();
    const jwt = await token(viewer(sessionId));
    expect((await attempt(`/session/${sessionId}/agent`, jwt)).status).toBe(401);
  });

  it("refuses an unauthenticated agent attach", async () => {
    const sessionId = freshSession();
    expect((await attempt(`/session/${sessionId}/agent?agent=stub`)).status).toBe(401);
  });

  it("lets a real agent token open the agent socket", async () => {
    const sessionId = freshSession();
    const jwt = await token({ sessionId, participantId: "sandbox", audience: "agent" });
    const response = await attempt(`/session/${sessionId}/agent?agent=stub`, jwt);
    expect(response.status).toBe(101);
    // A browser fails the connection unless the server names the protocol back.
    expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(`${PREFIX}${jwt}`);
  });
});

describe("replay is served at the caller's role", () => {
  it("gives an authenticated Driver their own view and everyone else the floor", async () => {
    const sessionId = freshSession();
    const jwt = await token(viewer(sessionId));
    const alice = await connect(`/session/${sessionId}/ws`, {
      "Sec-WebSocket-Protocol": `${PREFIX}${jwt}`,
    });
    await alice.waitFor((f) => f["type"] === "welcome");

    const authed = await SELF.fetch(`${BASE}/session/${sessionId}/events?from=0`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(authed.status).toBe(200);

    // No credential still works and still gets the Observer floor — replay has
    // never required one, and this must not become an authenticated-only path.
    const anonymous = await SELF.fetch(`${BASE}/session/${sessionId}/events?from=0`);
    expect(anonymous.status).toBe(200);
  });
});
