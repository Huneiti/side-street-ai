/**
 * The issuing half of ADR-0005. The Worker verifies tokens; this makes them,
 * and a token it mints must be one the Worker accepts — so the round-trip is
 * the test that matters, not the argument parsing alone.
 */

import { describe, expect, it } from "vitest";
import { verifySessionToken } from "@side-street/core";
import { parseMintArgs } from "../src/mint-token.js";
import { mintSessionToken } from "@side-street/core";

const SECRET = "not-a-real-token-secret";

const args = (line: string): ReturnType<typeof parseMintArgs> => parseMintArgs(line.split(" "));

describe("what it accepts", () => {
  it("mints a viewer token the Worker then accepts", async () => {
    const parsed = args("--session demo --participant ada --role driver --name Ada");
    if ("error" in parsed) throw new Error(parsed.error);

    const token = await mintSessionToken(parsed, SECRET);
    const result = await verifySessionToken(token, SECRET, {
      sessionId: "demo",
      audience: "viewer",
    });
    expect(result).toMatchObject({
      ok: true,
      claims: { sid: "demo", sub: "ada", role: "driver", name: "Ada", aud: "viewer" },
    });
  });

  it("mints an agent token, which needs no role", async () => {
    const parsed = args("--session demo --participant sandbox-1 --audience agent");
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.role).toBeUndefined();

    const token = await mintSessionToken(parsed, SECRET);
    expect(
      await verifySessionToken(token, SECRET, { sessionId: "demo", audience: "agent" }),
    ).toMatchObject({ ok: true, claims: { sub: "sandbox-1", aud: "agent" } });
  });

  it("honours an explicit lifetime", async () => {
    const parsed = args("--session demo --participant ada --role observer --ttl 30");
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.ttlSeconds).toBe(30);
  });
});

describe("what it refuses to mint", () => {
  it("refuses a viewer token with no role", () => {
    // Minting one would produce a credential that can never open anything,
    // and connect time is a worse place to find that out.
    expect(args("--session demo --participant ada")).toEqual({
      error: "a viewer token needs --role",
    });
  });

  it("refuses an unknown role or audience", () => {
    expect(args("--session demo --participant ada --role admin")).toMatchObject({
      error: expect.stringContaining("--role must be"),
    });
    expect(args("--session demo --participant ada --audience sandbox")).toMatchObject({
      error: expect.stringContaining("--audience must be"),
    });
  });

  it("refuses a missing session or participant", () => {
    expect(args("--session demo")).toMatchObject({ error: expect.stringContaining("required") });
    expect(args("--participant ada --role driver")).toMatchObject({
      error: expect.stringContaining("required"),
    });
  });

  it("refuses a nonsense lifetime rather than minting something already expired", () => {
    for (const ttl of ["0", "-5", "soon", "1.5"]) {
      expect(args(`--session demo --participant ada --role driver --ttl ${ttl}`)).toMatchObject({
        error: expect.stringContaining("--ttl must be"),
      });
    }
  });

  it("refuses a dangling flag rather than silently dropping it", () => {
    expect(args("--session demo --participant ada --role driver --ttl")).toMatchObject({
      error: expect.stringContaining("--ttl needs a value"),
    });
  });
});
