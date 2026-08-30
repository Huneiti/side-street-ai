/**
 * Session tokens (ADR-0005): the assertion that says who a socket is.
 *
 * Every identity in the log was self-asserted until this existed — a viewer
 * named themselves *and their role*, so every authority rule was enforced
 * against a claim the claimant made. A token moves `role` from something
 * requested to something granted, without changing what a role means: the
 * steering engine is untouched, only the source of its input moves.
 *
 * The wire format is a JWT, not because we need JWT's generality but because
 * the hosted path in ADR-0005 is an SSO issuer publishing a JWKS. Shipping our
 * own envelope now would mean writing a second parser later; a signed JWS
 * compact serialization costs no more today and the asymmetric issuer drops
 * into the same verify path.
 *
 * ponytail: HS256 hand-rolled on WebCrypto, no library. It is one HMAC and a
 * base64url split, it runs unchanged in workerd, Node and a browser, and the
 * alternative is a dependency in the one package that must not carry them.
 * The moment an asymmetric issuer lands, `verifySessionToken` grows an `alg`
 * branch rather than a rewrite.
 */

import { z } from "zod";
import { roleSchema } from "./roles.js";

/** What a token is for. A viewer token must never open the agent socket. */
export const tokenAudienceSchema = z.enum(["viewer", "agent"]);
export type TokenAudience = z.infer<typeof tokenAudienceSchema>;

/**
 * The claim set. Deliberately small: this is an assertion the Worker verifies
 * and discards, not a user record. Who is entitled to one is the issuer's
 * problem (ADR-0005) — nothing here is stored.
 */
export const sessionClaimsSchema = z.object({
  /** Session this token is good for. A token for one session opens no other. */
  sid: z.string().min(1).max(64),
  /** Participant id — becomes the `authorId` on everything they write. */
  sub: z.string().min(1).max(128),
  aud: tokenAudienceSchema,
  /** Display name, carried so the roster needs no second lookup. */
  name: z.string().min(1).max(128).optional(),
  /** Granted, never requested. Absent for agent tokens, which hold no role. */
  role: roleSchema.optional(),
  /** Seconds since the epoch, as JWT counts them. */
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
});
export type SessionClaims = z.infer<typeof sessionClaimsSchema>;

/** Ten minutes: long enough to open a session, short enough that a leaked link goes stale. */
export const DEFAULT_TOKEN_TTL_SECONDS = 10 * 60;

/**
 * Clock skew allowed on `exp` and `iat`. A viewer's laptop and the edge do not
 * agree to the second, and a token rejected for being from the future is a
 * confusing failure with no security value at this scale.
 */
export const CLOCK_SKEW_SECONDS = 60;

export type TokenFailure =
  | "malformed"
  | "unsupported-algorithm"
  | "bad-signature"
  | "expired"
  | "not-yet-valid"
  | "wrong-session"
  | "wrong-audience"
  | "missing-role";

export type VerifyResult =
  { ok: true; claims: SessionClaims } | { ok: false; reason: TokenFailure };

export interface MintInput {
  sessionId: string;
  participantId: string;
  audience: TokenAudience;
  displayName?: string | undefined;
  /** Required for viewer tokens; meaningless for agent tokens. */
  role?: SessionClaims["role"];
  ttlSeconds?: number;
  /** Epoch ms; injectable so tests are not clock-dependent. */
  now?: number;
}

const HEADER = { alg: "HS256", typ: "JWT" } as const;

/** Signs a claim set. The secret never leaves the issuer and the verifier. */
export async function mintSessionToken(input: MintInput, secret: string): Promise<string> {
  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  const claims: SessionClaims = sessionClaimsSchema.parse({
    sid: input.sessionId,
    sub: input.participantId,
    aud: input.audience,
    ...(input.displayName === undefined ? {} : { name: input.displayName }),
    ...(input.role === undefined ? {} : { role: input.role }),
    iat: nowSeconds,
    exp: nowSeconds + (input.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS),
  });
  const signingInput = `${encode(HEADER)}.${encode(claims)}`;
  return `${signingInput}.${base64url(await hmac(signingInput, secret))}`;
}

export interface VerifyOptions {
  /** The session the socket is trying to open. A token for another is refused. */
  sessionId: string;
  audience: TokenAudience;
  now?: number;
}

/**
 * Verifies a token and returns its claims, or the reason it was refused.
 *
 * Returns a reason rather than throwing because every caller is a request
 * handler that has to answer something, and because the reason is what gets
 * logged — a session where nobody can connect should say which of the eight
 * ways it is failing.
 */
export async function verifySessionToken(
  token: string,
  secret: string,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed" };
  }
  const [encodedHeader, encodedClaims, signature] = parts as [string, string, string];

  const header = decode(encodedHeader);
  if (header === undefined || (header as { alg?: unknown }).alg !== HEADER.alg) {
    // Refusing an unexpected `alg` by name is the point: accepting whatever
    // the token asks for is how "alg: none" happens.
    return { ok: false, reason: "unsupported-algorithm" };
  }

  const expected = base64url(await hmac(`${encodedHeader}.${encodedClaims}`, secret));
  if (!timingSafeEqual(expected, signature)) {
    return { ok: false, reason: "bad-signature" };
  }

  // Only after the signature holds is the payload worth reading.
  const parsed = sessionClaimsSchema.safeParse(decode(encodedClaims));
  if (!parsed.success) {
    return { ok: false, reason: "malformed" };
  }
  const claims = parsed.data;

  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  if (claims.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  if (claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) {
    return { ok: false, reason: "not-yet-valid" };
  }
  if (claims.sid !== options.sessionId) {
    return { ok: false, reason: "wrong-session" };
  }
  if (claims.aud !== options.audience) {
    // A viewer token must not open the agent socket, whoever signed it.
    return { ok: false, reason: "wrong-audience" };
  }
  if (claims.aud === "viewer" && claims.role === undefined) {
    return { ok: false, reason: "missing-role" };
  }
  return { ok: true, claims };
}

async function hmac(input: string, secret: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
}

function encode(value: unknown): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

function decode(segment: string): unknown {
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Constant-time comparison. A length-independent early return leaks the
 * expected signature roughly one character per request to anyone willing to
 * make enough of them.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}
