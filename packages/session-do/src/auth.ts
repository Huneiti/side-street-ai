/**
 * The identity boundary (ADR-0005). Everything that opens a socket or reads a
 * session passes through here, and nothing downstream reads identity from a
 * query parameter again.
 *
 * Two modes, and the difference between them is one environment variable:
 *
 * - **Verified.** `SIDE_STREET_TOKEN_SECRET` is set. A signed token decides
 *   who a connection is and, for viewers, what role they hold. Anything
 *   unsigned, expired, for another session, or for the other audience is
 *   refused before the socket is accepted.
 * - **Insecure.** No secret is configured. Identity falls back to what the
 *   connection claims about itself — the pre-ADR-0005 behaviour — so
 *   `pnpm dev` still needs no credentials. It is not a quiet fallback: every
 *   session says so in the log and every viewer is told, so a deployment in
 *   this mode announces it rather than looking like a secure one.
 */

import {
  TOKEN_SUBPROTOCOL_PREFIX,
  joinParamsSchema,
  tokenFromSubprotocols,
  verifySessionToken,
  type Role,
  type TokenFailure,
} from "@side-street/core";

export interface ViewerIdentity {
  participantId: string;
  displayName: string;
  role: Role;
  /** False in insecure mode: the identity is asserted, not established. */
  verified: boolean;
}

export interface AgentIdentityCheck {
  participantId: string;
  verified: boolean;
}

export type AuthOutcome<T> =
  | { ok: true; identity: T }
  | {
      ok: false;
      reason: string;
      /** 400 for a malformed request, 401 for a credential problem. */
      status: 400 | 401;
    };

/**
 * Pulls the token out of a handshake. Returns the full subprotocol value too,
 * because a browser fails the connection unless the server echoes back the
 * exact protocol it selected.
 */
export function tokenFromRequest(
  request: Request,
): { token: string; subprotocol: string } | undefined {
  const offered = request.headers.get("Sec-WebSocket-Protocol");
  if (offered === null) {
    return undefined;
  }
  const token = tokenFromSubprotocols(offered.split(","));
  return token === undefined
    ? undefined
    : { token, subprotocol: `${TOKEN_SUBPROTOCOL_PREFIX}${token}` };
}

/** `Authorization: Bearer <token>` for the plain HTTP surfaces. */
export function bearerFromRequest(request: Request): string | undefined {
  const header = request.headers.get("Authorization");
  if (header === null || !/^Bearer /i.test(header)) {
    return undefined;
  }
  const token = header.slice("Bearer ".length).trim();
  return token === "" ? undefined : token;
}

/** Why a token was refused, in words a log line and an operator can both use. */
function explain(reason: TokenFailure): string {
  switch (reason) {
    case "expired":
      return "token expired";
    case "not-yet-valid":
      return "token not yet valid";
    case "wrong-session":
      return "token is for another session";
    case "wrong-audience":
      return "token is for another socket";
    case "missing-role":
      return "token grants no role";
    case "unsupported-algorithm":
      return "unsupported token algorithm";
    case "bad-signature":
      return "token signature does not verify";
    case "malformed":
      return "malformed token";
  }
}

/**
 * Who is opening a viewer socket.
 *
 * In verified mode the token is the only source of identity: `displayName` and
 * `role` come from the claims, never from the query string, so a participant
 * cannot name themselves the Driver on the way in.
 */
export async function authenticateViewer(
  request: Request,
  url: URL,
  sessionId: string,
  secret: string | undefined,
): Promise<AuthOutcome<ViewerIdentity>> {
  if (secret === undefined || secret === "") {
    const params = joinParamsSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!params.success) {
      return { ok: false, reason: "invalid join parameters", status: 400 };
    }
    return { ok: true, identity: { ...params.data, verified: false } };
  }

  const presented = tokenFromRequest(request);
  if (presented === undefined) {
    return { ok: false, reason: "no token presented", status: 401 };
  }
  const result = await verifySessionToken(presented.token, secret, {
    sessionId,
    audience: "viewer",
  });
  if (!result.ok) {
    return { ok: false, reason: explain(result.reason), status: 401 };
  }
  const { sub, name, role } = result.claims;
  if (role === undefined) {
    return { ok: false, reason: explain("missing-role"), status: 401 };
  }
  return {
    ok: true,
    identity: { participantId: sub, displayName: name ?? sub, role, verified: true },
  };
}

/**
 * Who is opening the agent socket. Audience is what does the work here: a
 * viewer token, however validly signed, must not be able to speak as the
 * sandbox.
 */
export async function authenticateAgent(
  request: Request,
  sessionId: string,
  secret: string | undefined,
): Promise<AuthOutcome<AgentIdentityCheck>> {
  if (secret === undefined || secret === "") {
    return { ok: true, identity: { participantId: "agent", verified: false } };
  }
  const presented = tokenFromRequest(request);
  if (presented === undefined) {
    return { ok: false, reason: "no token presented", status: 401 };
  }
  const result = await verifySessionToken(presented.token, secret, {
    sessionId,
    audience: "agent",
  });
  return result.ok
    ? { ok: true, identity: { participantId: result.claims.sub, verified: true } }
    : { ok: false, reason: explain(result.reason), status: 401 };
}

/**
 * The role a replay request may be served at. An authenticated caller gets
 * their own role; everyone else gets the Observer floor, which is what
 * `/events` has always served for want of knowing who was asking.
 */
export async function replayRole(
  request: Request,
  sessionId: string,
  secret: string | undefined,
): Promise<Role> {
  const token = secret === undefined || secret === "" ? undefined : bearerFromRequest(request);
  if (token === undefined) {
    return "observer";
  }
  const result = await verifySessionToken(token, secret as string, {
    sessionId,
    audience: "viewer",
  });
  // A refused token is not an error here — it just does not raise the floor.
  return result.ok ? (result.claims.role ?? "observer") : "observer";
}
