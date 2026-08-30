# ADR-0005: Identity is a signed session token, minted by a swappable issuer

- **Status:** Accepted
- **Date:** 2026-08-30
- **Deciders:** project founder

## Context

Side Street's pitch is that you can "audit exactly who told the agent what". The log delivers
half of that today and not the other half. It is append-only and hash-chained, so **nobody can
rewrite what was said** — but every identity in it is self-asserted. A viewer connects with
`?participantId=alice&displayName=Alice&role=driver` and the session takes all three at face
value. The chain proves the log was not tampered with; it does not prove Alice is Alice.

That gap is not evenly distributed. Three surfaces, in ascending order of severity:

**Viewers pick their own identity.** Anyone who can reach the Worker can be anyone. Attribution
is therefore a record of what a socket claimed, not of who acted.

**Viewers pick their own role**, which makes the Driver/Navigator/Observer model advisory. The
engine enforces it correctly — ADR-0004's gates, the wheel, the Observer floor — but a
participant who wants to be the Driver simply says so at join time. Every authority rule we
have is enforced against a claim the claimant made.

**The agent socket is not authenticated at all.** `/session/:id/agent` accepts any WebSocket
upgrade. The red-team suite proves an injected sandbox cannot forge a human's attribution — but
nothing stops an unauthorized party from _being_ the sandbox: streaming fabricated agent output
into the log, raising permission requests a Driver will be asked to approve, and (because a
second attach is read as the first agent having died) knocking the real bridge's in-flight steps
into `step_unresolved` on the way in.

The plan has always treated this as pending — `PLAN.md` §5 says v0 identity is unauthenticated
query params and calls authentication a Phase 2 deliverable. It was never listed as one, so it
was never built, and Phase 2 closed around the gap. It now blocks the hosted demo instance, per-role
replay (`/events` serves the Observer floor to everyone precisely because it cannot tell who is
asking), and the Phase 4 launch: a public deployment today is a public session anyone can drive.

The forces on any answer:

- **Self-hosting cannot require an identity provider.** AGPL and "freely self-hostable" (ADR-0003)
  mean a single operator on a laptop has to be able to run this.
- **The Durable Object should not become a user database.** It is the session spine (ADR-0001);
  storing accounts in it makes every session a partial replica of an identity system.
- **The hosted control plane will have SSO/SCIM**, which the README now states publicly. Whatever
  self-hosters use must not be a different mechanism that the hosted path replaces.
- **`pnpm dev` must stay one command with no credentials.** Phase 4's dev story is a deliverable,
  and an auth design that turns the first five minutes into key management undoes it.

## Decision

Identity is a **short-lived signed token, presented at connect time and verified at the Worker
edge before a socket is accepted.** The token binds `sessionId`, `participantId`, `displayName`,
`role`, an audience (`viewer` or `agent`), and an expiry. The Durable Object stops reading
identity from query parameters and trusts only verified claims.

**Role is granted, not requested.** This is the load-bearing half. Today's authority rules are
enforced against a self-declared role; after this they are enforced against a role someone with
authority issued. The steering engine does not change — `canSteer`, `canSuggest`, the wheel and
the gates all keep working exactly as they do — because the change is in where `role` comes
from, not in what it means.

Tokens come from a **swappable `TokenIssuer`**, deliberately mirroring the `CredentialIssuer` in
`packages/sandbox/src/credentials.ts` — the same shape, for the same reason, so there is one
pattern in this codebase for "a secret whose issuance is someone else's business":

- **Dev and self-host: symmetric.** HMAC-SHA256 over a shared secret the operator sets once
  (`SIDE_STREET_TOKEN_SECRET`), with a small minting command. No key management, no external
  dependency, no accounts — the operator hands out links.
- **Hosted: asymmetric.** The control plane mints EdDSA tokens after SSO and publishes a JWKS;
  the Worker verifies with a public key and holds no shared secret across a trust boundary. Same
  token shape, same verification path, different issuer — SCIM group membership becomes a `role`
  claim rather than a second mechanism.

**The agent socket takes an `audience: "agent"` token**, issued as part of the sandbox launch.
`launchSessionSandbox` already injects session-scoped secrets as boot environment and declares
them to the redaction pass; the session token rides the same path and inherits both properties.

**Tokens travel in the WebSocket subprotocol, not the query string.** A browser cannot set
headers on a WebSocket handshake, which leaves the query string or `Sec-WebSocket-Protocol`.
Query strings land in edge access logs and proxy logs, and we have just committed in
`docs/ops.md` to logs that carry no secrets — putting the credential in the URL would break that
promise at the one layer we do not control. `GET /events` and the other HTTP surfaces take a
normal `Authorization: Bearer` header.

**`pnpm dev` keeps working with no setup, loudly.** With no secret configured the Worker runs in
an explicit insecure mode: it mints and accepts anything, logs `auth.insecure` at `warn` on every
session, and the UI carries a banner saying identity is not verified. It is not a fallback that
can be reached by accident in production — a deployment with no secret configured is one that
says so on every session and every screen.

## Consequences

**What becomes true.** The invariant "every event carries an author identity" stops being
aspirational. `/events` can serve per-role redaction to an authenticated caller instead of the
Observer floor to everyone. The hosted demo becomes possible. The red-team suite gains the case
it cannot express today: an unauthorized party attaching as the agent.

**What becomes harder.** Every connect path grows a verification step and a failure mode, and
self-hosters acquire one piece of configuration they did not have. The insecure dev mode is a
real risk surface — it exists to protect the dev story, and it earns that only if it is
impossible to be in accidentally and silently, which is why the warning is per-session and
on-screen rather than a startup log line nobody reads.

**What we are explicitly not doing.** No user accounts, no password handling, no session cookies,
no identity storage in the Durable Object. The token is an assertion the Worker verifies and
discards; who is entitled to one is the issuer's problem. Self-hosters get link-sharing, not user
management, and that is the honest ceiling of the symmetric mode.

**Revocation is by expiry only.** A short TTL is the whole mechanism; there is no revocation list.
Kicking a participant mid-session therefore ends at the socket, not at the token — the same
trade `CredentialIssuer` already makes, and the same upgrade path if it stops being acceptable.

We revisit if self-hosters turn out to want real user management (which would mean an identity
service, not a bigger token), or if the dev-mode warning proves ignorable enough that someone
deploys through it — that would be the signal to refuse to start without a secret and accept the
cost to the dev story.
