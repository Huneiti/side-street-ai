# Side Street — Project Plan

> **This document is the single source of truth for what we build, in what order, and why.**
> All work in this repository must map to a phase and deliverable below. If work doesn't fit
> the plan, the plan gets amended first (via PR), then the work happens.
>
> Grounding research: [`docs/research/2026-07-multiplayer-ai-foundation.md`](research/2026-07-multiplayer-ai-foundation.md)

---

## 1. Vision

**Side Street is the open-source multiplayer layer for coding agents.**

Anyone on a team can drop into the same live agent session — watch it work token-by-token,
steer it, hand it off, and audit exactly who told the agent what — the way they'd collaborate
with any human teammate. We do **not** build a coding agent. We wrap the best existing agents
(Claude Code, Codex, Gemini CLI) through the Agent Client Protocol (ACP) and own the
**collaboration surface**: shared durable sessions, multi-human steering, and tamper-evident
attribution.

### The one-line pitch

> _Google Docs for agent sessions: watch, steer, and hand off a live coding agent with your
> whole team — no matter which lab's agent you run._

### Why now

- Agents run tasks lasting hours to weeks, but every session is trapped on one person's laptop.
- Every shipping agent (Claude Code, Codex, Cursor) solved _single-user_ steering the same way
  (queue → inject at tool-call boundary → hard interrupt). **Nobody has shipped multi-human
  steering of one agent.** That's the gap.
- Incumbents (GitHub Ace, Anthropic Claude Tag, Zed) are circling but haven't shipped it, and
  none of them will be agent-agnostic — that's structurally against their interests. We are.

### What we are NOT building

- ❌ A coding agent or model harness (the labs out-model everyone every quarter)
- ❌ A collaborative code editor (Zed owns that)
- ❌ A parallel-agent orchestrator (Conductor owns that)
- ❌ A general CRDT document platform

---

## 2. Positioning & differentiation

| Competitor                | What they are                                        | Why we win against them                                                                                       |
| ------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GitHub Ace                | Multiplayer agent workspace prototype, GitHub-locked | Agent-agnostic; steering/roles/attribution model they haven't prioritized; ships now, not "technical preview" |
| Anthropic Claude Tag      | Async, Slack-thread-shaped shared Claude             | We're live/synchronous, token-level, any agent — not one lab's model in one chat surface                      |
| Conductor                 | One human → many agents                              | We're many humans → one agent; complementary, not competitive                                                 |
| Zed                       | Humans co-edit code, agent is an assistant           | We make the _agent session_ the shared object, not the buffer                                                 |
| Screen-share + copy/paste | The status-quo workaround                            | Real steering rights, replay, audit trail, no "can you scroll up?"                                            |

**Three defensible bets (the moat is the combination + speed):**

1. **Agent-agnostic** — teams standardize on our collaboration/audit layer regardless of which lab wins.
2. **The steering, role & tamper-evident attribution model** — genuine engineering nobody else has prioritized.
3. **Vertical incident-response workflow** — PagerDuty/Sentry-triggered shared sessions that horizontal platforms won't build early.

**Wedge market:** engineering incident response, on-call debugging, and senior-steers-junior
mentoring — moments teams _already_ crowd around one problem. Not greenfield coding.

---

## 3. Architecture (target state)

```
                    ┌──────────────────────────────────────────┐
   Browser viewers  │  Cloudflare Durable Object (per session)  │     Per-session microVM
  ┌──────────┐      │  ─ append-only SQLite event log           │    ┌──────────────────┐
  │ Driver   │◄─WS──┤    (seq, ts, author, type, payload,       │    │  Sandbox (E2B /  │
  │ Navigator│◄─WS──┤     prev_hash, hash)                      ├───►│  CF Sandbox)     │
  │ Observer │◄─WS──┤  ─ participant roster + roles             │ACP │  running Claude  │
  └──────────┘      │  ─ WebSocket Hibernation fan-out          │    │  Code / Codex /  │
        ▲           │  ─ intervention queue                     │    │  Gemini CLI      │
        │           │  ─ redaction pass before broadcast        │    └──────────────────┘
   offset-based     └──────────────────────────────────────────┘
   late-join replay
```

### Core decisions (locked unless the plan is amended)

| Concern                   | Decision                                                                                                                                                                                                     | Rationale (see research doc)                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session spine             | Cloudflare Durable Objects (one DO per session)                                                                                                                                                              | Single-threaded actor + embedded SQLite + WebSocket Hibernation + Alarms; idle sessions cost ~nothing                                                                                      |
| Event model               | Append-only, hash-chained event log in DO SQLite                                                                                                                                                             | Single-writer bulk stream + bursty human input = event sourcing, **not** a CRDT problem                                                                                                    |
| Late joiners / reconnects | Offset-based replay (checkpoint + tail from `seq` offset) against SQLite                                                                                                                                     | Avoids Redis; covers tab-switch/multi-device gaps that `resumable-stream` doesn't                                                                                                          |
| Agent intelligence        | External agents driven over **ACP** (we are the ACP client)                                                                                                                                                  | Never compete with the labs; provider-agnostic is the durable position                                                                                                                     |
| Tools                     | Consume **MCP**; ignore A2A for now                                                                                                                                                                          | Settled 2026 protocol landscape                                                                                                                                                            |
| Execution                 | Per-session microVM sandbox (E2B default; Cloudflare Sandbox as tight-integration option); swappable layer                                                                                                   | Isolation-strict, persistent multi-hour sessions, snapshot/restore                                                                                                                         |
| Steering model            | Driver / Navigator / Observer roles; intervention queue drained at tool-call boundaries; explicit hard-interrupt (`session/cancel` + re-prompt); explicit control handoff ("take the wheel")                 | Extends the proven single-user consensus mechanism with identity; concurrent injection into one context window is incoherence, so single-Driver authority is a **correctness** requirement |
| Side effects              | Compensation (sagas + idempotency keys), never blind rollback, for anything that touched a remote system                                                                                                     | Checkpoint illusion is a known failure mode                                                                                                                                                |
| Security                  | Per-viewer/role redaction before fan-out; session-scoped short-lived credentials injected at sandbox boot (never in prompts); ACP `request_permission` gates on side-effecting tools; hash-chained audit log | Prompt injection succeeds 63% at 100 attempts in Anthropic's own measurement — approval gates are the load-bearing control                                                                 |
| Co-edited surfaces        | Yjs for shared plan/scratchpad only                                                                                                                                                                          | The only place a CRDT earns its complexity                                                                                                                                                 |
| Language/runtime          | TypeScript everywhere (Workers + Node), strict mode                                                                                                                                                          | Solo-founder velocity; Cloudflare Agents SDK is TS-native                                                                                                                                  |

### Architecture invariants (enforced in code review, restated in CLAUDE.md)

1. The event log is **append-only**. No event is ever mutated or deleted; corrections are new events.
2. Every event carries an **author identity** and is **hash-chained** (`hash = H(prev_hash || event)`).
3. The Durable Object does **minimal work per message** (append + broadcast); heavy work lives in the sandbox.
4. **Secrets never enter prompts** and never leave the redaction pass un-scanned.
5. Redaction runs **before** broadcast, per role — an Observer must never see raw env vars/tokens even if the agent prints them.
6. Only the **Driver's** messages and approvals are authoritative; the role model is not optional polish.
7. Anything that hit a remote system gets **compensation, not rollback**; every side-effecting tool call carries an idempotency key `(session_id, step_id, attempt)`.
8. The sandbox provider and the backing agent are **swappable interfaces**, never hard-coded dependencies.

---

## 4. Repository layout (target)

pnpm monorepo, Turborepo for task orchestration:

```
side-street-ai/
├── CLAUDE.md                  # Working agreement — binds all work to this plan
├── README.md                  # Public face: pitch, demo GIF, quickstart
├── LICENSE                    # AGPL-3.0 (see ADR-0003)
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── SECURITY.md                # Vuln disclosure policy (we're a security product; this is table stakes)
├── .github/
│   ├── workflows/ci.yml       # lint + typecheck + test + build on every PR
│   ├── ISSUE_TEMPLATE/
│   └── pull_request_template.md
├── docs/
│   ├── PLAN.md                # ← this file
│   ├── research/              # Grounding research, ADR inputs
│   ├── adr/                   # Architecture Decision Records (template + numbered ADRs)
│   └── protocol.md            # Our session/event wire protocol spec
├── packages/
│   ├── core/                  # Event types, hash chain, steering engine, protocol schemas (zod)
│   ├── session/               # Runtime-agnostic session actor (log + roster + steering + replay behind ports)
│   ├── session-do/            # Cloudflare Worker + Durable Object wrapper binding @side-street/session
│   ├── acp-client/            # ACP client driving backing agents over stdio/WebSocket
│   ├── sandbox/               # Sandbox provider interface + E2B / CF Sandbox adapters
│   ├── redaction/             # Secret scanning + per-role redaction pipeline
│   └── web/                   # Viewer/steering UI (React + Vite)
└── examples/                  # Runnable demos (the marketing asset)
```

---

## 5. Phases

Each phase has **deliverables** and an **exit benchmark**. A phase is done when its benchmark
passes, not when its code merges.

### Phase 0 — Foundation (week 0–1)

_Goal: a contributor (or Claude) can clone, install, test, and ship a PR with zero friction._

- [x] `docs/PLAN.md` (this document) and `docs/research/` grounding
- [x] `CLAUDE.md` working agreement
- [x] Monorepo scaffold: pnpm workspaces, Turborepo, TypeScript strict, ESLint + Prettier, Vitest
- [x] CI: GitHub Actions running lint/typecheck/test/build on every PR (branch protection on `main` is a repo setting — enable in GitHub UI)
- [x] OSS hygiene: AGPL-3.0 `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates
- [x] ADR process: `docs/adr/0000-template.md` + ADR-0001 (Durable Objects spine) + ADR-0002 (ACP client, no own agent) + ADR-0003 (AGPL-3.0 licensing)
- [x] `packages/core`: event types, zod schemas, hash-chain utilities — fully unit-tested

**Exit benchmark:** `pnpm install && pnpm test && pnpm build` green locally and in CI; a
hash-chained event log can be built, verified, and detected-as-tampered in unit tests.

### Phase 1 — Prove the interaction, not the infra (weeks 1–4)

_Goal: the thinnest vertical slice that answers the existential question: can two engineers
co-steer one debugging session without producing incoherent agent behavior?_

- [x] Steering v1 engine (`@side-street/core`): Driver/Navigator/Observer authority, attributed intervention queue drained at tool-call boundaries, hard-interrupt with single-cancel semantics, "take the wheel" handoff — unit-tested as a pure state machine
- [x] Session actor (`@side-street/session`): append-only hash-chained log with fan-out, roster, steering integration, offset replay, snapshot/restore — runtime-agnostic behind storage/broadcast/agent ports
- [x] `acp-client`: JSON-RPC 2.0 over pluggable transports; `session/prompt` / `session/update` streaming / `session/cancel`; `request_permission` routing (handler failure denies, never allows); update→event translation — tested against an in-process fake agent
- [x] `session-do`: Durable Object wrapper binding `@side-street/session` to SQLite + WebSocket Hibernation; viewer + agent-bridge sockets with durable prompt buffering; WS wire protocol documented in `docs/protocol.md`; tested in workerd via vitest-pool-workers (v0 identity is unauthenticated query params — authentication is a Phase 2 deliverable)
- [x] `sandbox` agent bridge: connects an ACP agent to the session's `/agent` socket; realizes boundary injection as cancel-then-reprompt with the internal cancel invisible to the session; hard-interrupt vs injection disambiguated; suggestion attribution in prompt formatting — tested against both a scripted agent and a real `AcpClient`+`FakeAgent` pair
- [x] `sandbox` E2B adapter: boot a per-session microVM with a cloned repo behind the `SandboxProvider` interface — integration-tested against the live E2B API (tests skip without `E2B_API_KEY`)
- [x] `web`: join screen (name/role/session), live timeline (merged agent chunks, tool-call status, attributed human messages, wheel changes), steer/interrupt/take-the-wheel controls, rejection notices
- [x] Late-joiner replay v1: `SessionClient` connects, replays from its cursor, buffers live frames during replay, deduplicates by `seq`, and resumes reconnects with only the delta — tested; the in-browser run happens with the exit benchmark

**Exit benchmark:** two humans in different browsers co-steer one real debugging session
(seeded bug in a sample repo) to a fix, with the full attributed timeline visible.
**If concurrent steering degrades agent output even with the role model, that is a pivot
signal (see §8) — surface it immediately, do not push through.**

### Phase 2 — Make it safe and durable (weeks 5–10)

_Goal: the session layer is trustworthy enough to hold real credentials in front of multiple viewers._

- [x] Hash-chained attributed event log wired end-to-end (Phase 0 utilities → production path) + verification endpoint (`GET /session/:id/verify`)
- [x] `redaction`: secret scanning on every outbound event; per-role redaction; Observers never see raw secrets — `@side-street/redaction` wired into the DO broadcast **and replay** paths (default policy redacts for all roles; injected credentials feed `knownSecrets` via the bridge's `register_secrets` frame)
- [x] Session-scoped, short-lived credentials injected at sandbox boot; never in prompts; automatic expiry — `CredentialIssuer` grants are injected only as sandbox boot env, expire on both the launcher's timer and the provider's own deadline, and are declared to the redaction pass so an echoed credential never reaches a viewer (the shipped issuer is the static dev/self-host one; a minting issuer — GitHub App, STS — drops in behind the interface)
- [x] ACP `request_permission` approval gates on side-effecting tools, surfaced to the Driver only — bridge routes ACP requests through the session; only the wheel-holding Driver decides; the tool stays blocked until then; Driver approve/deny UI in `web`
- [x] Checkpointing + compaction: periodic session snapshots so late joiners load checkpoint + tail, not thousands of events — every 100 events the session appends a `checkpoint` carrying the roster, the wheel, and any still-blocked permission requests; `GET /events?from=checkpoint` serves that plus the tail, and a client with no cursor asks for it. The state rides in-band as a chained event, so a compacted replay is as tamper-evident as a full one; the log itself is never compacted
- [x] Compensation framework for side-effecting tools: idempotency keys, replay-or-fork decision on restore — every approval mints `(sessionId, stepId, attempt)` into the log, where `stepId` hashes the approval prompt rather than the `toolCallId` an agent re-mints on every retry (ADR-0004); the Driver is warned before approving a step this session already ran. When a new agent bridge attaches, orphaned steps are logged as `step_unresolved` (`approved_unfinished` with its key, or `never_decided`) and stale decisions/cancels are dropped from the outbox while undelivered prompts stand — replay is re-approving (next attempt), fork is steering elsewhere, and neither happens silently. The key is recorded and surfaced, not injected: ACP carries no field for it, so server-side dedupe waits on a Side Street-aware tool wrapper
- [x] Reconnect hardening: tab-switch, multi-device, network-drop resume from offset — explicitly tested: `SessionClient` retries any socket it did not close itself on a capped backoff and resumes from its cursor, with `online`/`visibilitychange` short-circuiting the wait for a throttled background tab; a participant stays present while any device holds a socket. Tested at both levels (client backoff/resume/no-retry-after-leave; DO multi-device presence and a verifiable post-drop delta). A drop that outlives the retries is a real departure — the wheel frees and reconnecting is a fresh join; holding the departure behind a DO alarm is the upgrade if blips prove disruptive
- [x] Red-team suite as CI fixtures: prompt-injection attempts via (a) a steerer and (b) a poisoned repo file — `packages/session-do/test/red-team.test.ts`, permanent in CI and never weakened to make a build pass. It assumes injection already succeeded (we don't own the agent, so we can't test its resistance) and asserts the layer we own holds: no secret reaches an Observer live or on replay, no non-Driver gains authority or approves a tool, and neither a viewer nor the sandbox can forge another party's attribution. Driving the fixtures through a live agent in a genuinely poisoned repo comes with the phase exit benchmark

**Exit benchmark:** the red-team suite passes — no injection path exfiltrates a secret to an
Observer; a session survives DO eviction, sandbox pause/resume, and 24h of wall-clock time
with replay intact.
_Automated: the red-team half runs in CI on every PR; the durability half is
`pnpm --filter @side-street/session-do benchmark` against a running Worker — see
`docs/benchmarks/phase-2.md`. Passing locally against `wrangler dev` (including a full
cold-restart of the server); the 24h soak against a deployment is still to run._

> **Amendment (2026-08-30): authentication was named here and never listed.** §5 said v0
> identity is unauthenticated query params and called authentication a Phase 2 deliverable, but
> no Phase 2 checkbox ever covered it, so it was never built and the phase closed around the
> gap. It is now a Phase 3½ deliverable below, because it blocks the launch rather than the
> safety work: everything Phase 2 shipped — redaction, gates, the chain, compensation — is
> correct and is enforced against identities nobody verifies. See ADR-0005.

### Phase 3 — The vertical wedge (weeks 11–16)

_Goal: an on-call team resolves a real incident faster with shared steering than with
screen-share + copy-paste._

- [ ] One incident-response integration (pick **Sentry first** — better OSS developer motion than PagerDuty): alert → spin up a shared session preloaded with the error context, repo, and recent deploys — **the alert-to-session path has landed**: `POST /integrations/sentry` verifies Sentry's HMAC over the raw body in constant time, derives one session per _issue_ (repeat alerts join the room the team is already in rather than splitting an incident across four), and writes `incident_linked` into the log before anyone joins, so the first arrival reads what broke and the exported postmortem opens with it. Fails closed throughout: unconfigured is off not open, an unverified signature is refused before the body is read, and the path that writes the context is absent from the Worker's public routes so a forged incident cannot be posted. Setup and the full refusal table in `docs/integrations/sentry.md`. **Remaining: repo and recent deploys**, which need an authenticated Sentry API call with an org token — the release string from the alert is what lands today
- [x] Session artifacts: exportable attributed timeline (the postmortem trail) as Markdown — `toMarkdown` in `@side-street/core` renders the log as a dated, attributed transcript: who steered and who only suggested (by the wheel at that moment, not the join-time role), which tool ran with what output, who approved each gated step and under which idempotency key, and every step the session could not account for. The header carries the chain tip so a reader can check the artifact against `/verify` instead of trusting it, and a compacted export says where its history starts rather than beginning mid-incident silently. Exported from the web viewer, which re-fetches the whole log via `GET /events?from=0` — that endpoint redacts at the Observer floor whoever asks, so the artifact is safe to paste into a document read by people who were never in the session. Participant and agent text is quoted, so nothing typed into a session can restructure the postmortem around it
- [ ] Second backing agent over ACP (Codex via `codex-acp` or Gemini CLI) — prove agent-agnosticism publicly. The client side is in place: the runner takes `--agent claude-code|codex|gemini` (or any command after `--`), and the ACP client now negotiates authentication — it reads the agent's advertised `authMethods` from the handshake, recognises `auth_required` (`-32000`) from `session/new` as itself rather than an opaque error, and can present credentials with `authenticate`, which is the wall a second agent hits first. Runbook in `docs/agents.md`; the automated coverage runs against an in-memory ACP agent. **What remains is the proof itself**: a live session steered through a second agent on real credentials, which no test can stand in for
- [x] Usage metering scaffolding (session-hours / steered-sessions) — even if free, measure from day one. `summarizeUsage` derives the meter from the event log rather than counting alongside it, and `GET /session/:id/usage` serves it: steered-or-not with the distinct steerers, session time as both span and active (span minus gaps over an idle threshold, because a session left open overnight is not eight hours of work), steering volume and interrupts, handoffs, agent turns, tool calls, granted vs denied approvals, and the unresolved-step count — the number that says a deployment is losing work. Derivation is the point: the meter cannot drift from the timeline it bills, an evicted DO loses no counters, and any past session can be re-metered and checked against `/verify`. What price keys off which number is left open on purpose
- [ ] Ops: structured logging, error tracking, cost dashboards for DO + sandbox spend — structured logging and error levels have landed: the Durable Object emits one JSON line per event (`session.started`, `viewer.joined`/`left`, `agent.attached`/`detached`, `permission.decided`, every authority refusal, every rejected frame) with failures at `level: "error"` for a pipeline alert to match, and no SDK, because a DO can be evicted between any two lines and a batching transport loses exactly the ones that explain why. Logs never carry content — they bypass the redaction pass by construction and outlive the session — which a permanent red-team fixture enforces. Runbook in `docs/ops.md`. **Cost dashboards remain**: the per-session inputs exist (`activeMs` from `/usage`, and the attach/detach pair bracketing sandbox lifetime), but aggregating them wants Analytics Engine or a log pipeline, and both are choices about a deployment that does not exist yet

**Exit benchmark:** a pilot team (recruit 2–3 from the OSS community) runs ≥1 real incident
through Side Street and reports it beat their status-quo workflow; the same session works with
two different backing agents.
_Neither half automates: see `docs/benchmarks/phase-3.md`. The agent-agnostic half is a ten-minute
checklist you can run now; the pilot needs a deployment the team can reach, which waits on Phase
3½ (identity)._

### Phase 3½ — Identity (blocks the launch gate)

_Goal: the attribution the log has always carried is attribution somebody verified. Sized as a
half-phase because nothing else waits on it and it touches one seam — who a socket is —
rather than the session model._

- [x] Signed session tokens verified at the Worker edge, replacing self-asserted
      `participantId` / `displayName` / `role` on the viewer socket (ADR-0005) — the claims are
      the only source of identity; the query string is ignored
- [x] **Role granted, not requested** — the steering engine is unchanged; only the source of
      `role` moves, from a query parameter to a verified claim
- [x] The agent socket authenticated too: `/session/:id/agent` currently accepts any upgrade, so
      an unauthorized party can _be_ the sandbox — stream fabricated agent output, raise
      permission requests a Driver is asked to approve, and displace the real bridge on attach
- [ ] A swappable `TokenIssuer` mirroring `CredentialIssuer`: symmetric HMAC for dev and
      self-host, asymmetric + JWKS for the hosted control plane's SSO — the symmetric half
      ships as a mint command (`pnpm --filter @side-street/sandbox token`); the interface and
      the asymmetric issuer behind it are what remain
- [ ] Clients present tokens — the **bridge runner does**, from `SIDE_STREET_SESSION_TOKEN`
      in its boot environment. The **web viewer does not**, so a deployment that configures a
      secret still locks out its browsers; that and issue #56 (a `?server=` link must not be
      able to redirect a credential) are the remaining half
- [x] Tokens in the WebSocket subprotocol rather than the query string, so a credential never
      reaches an edge access log (`docs/ops.md` promises logs carry no secrets) — the selected
      protocol is echoed back, which a browser requires
- [x] Per-role replay on `GET /events`, which serves the Observer floor to everyone today only
      because it cannot tell who is asking — an unauthenticated caller still gets the floor, so
      replay never became an authenticated-only path
- [x] `pnpm dev` still one command with no credentials: an explicit insecure mode that says so
      per session, in the log (`auth.insecure`) and in `welcome`'s `identityVerified`. The
      on-screen half lands with the client work
- [x] Red-team fixtures for the cases the suite could not express — unauthorized agent attach,
      a viewer token on the agent socket, a forged role claim, a wrong-secret signature, a
      token for another session, and an expired one (`packages/session-do/test-auth/`)

**Exit benchmark:** a deployment reachable from the public internet where an uninvited party can
neither join a session nor attach as its agent, and where the role in every logged event is one
an issuer granted rather than one the participant asked for.

### Phase 4 — Open-source launch (overlaps Phase 2–3; launch gate after Phase 2)

_Goal: Side Street is a credible, adoptable open-source project with a public story._

- [x] README with 60-second demo GIF (the single highest-leverage marketing asset) — `docs/assets/demo.gif`, above the fold. Captured against a real running stack, not mocked: two participants on real sockets, the Navigator's message landing as a suggestion behind the Driver, the Driver's instruction reaching the agent with the suggestion riding along, and the approval gate stopping a side-effecting step until the wheel-holder answers. Recorded against the stub agent, so anyone can reproduce it with `pnpm dev` and no credentials
- [ ] One-command local dev story (`pnpm dev` boots DO emulation + sandbox stub + web UI) and a hosted demo instance — **`pnpm dev` is done**: one command brings up the Worker (DO emulation), the web UI, and a stub ACP agent that needs no credentials, with the bridge waiting out the startup race rather than losing it. Verified end to end — steer, stream, approval gate, Driver approves, tool runs, `/verify` valid, `/usage` reporting the steer — with no API key anywhere. The **hosted demo instance remains**, and it is gated on the authentication deliverable: v0 identity is unauthenticated query params, so a public instance would be a public session anyone can drive
- [ ] Public roadmap (GitHub Projects mirroring this plan) + "good first issue" seeding — **seeding done**: five labelled issues, each a real gap with the file to start in, the existing pattern to follow, and the one thing about it that is easy to get wrong (deep-linking a session from the Sentry response, surfacing `/verify` and `/usage`, declaring the sandbox provider the way the agent is, and a transcript CLI). **GitHub Projects remains** — this file is the roadmap today, and mirroring it into Projects is worth doing when there are contributors to coordinate rather than to advertise to
- [ ] Versioning & releases: changesets, semver, signed tags, GitHub Releases with changelogs — the mechanism is in place: changesets configured across the six publishable packages (the web app is ignored), root `changeset` / `changeset:version` / `release` scripts, a contributor step in CONTRIBUTING, and a runbook in `docs/releasing.md` covering the signed tag and the GitHub Release. Deliberately manual for now — publishing needs an npm token and signed tags need a key, and a documented sequence someone runs beats CI configuration nobody has executed. **The first release has not been cut**, which is what this box is waiting on; the changeset for it is written
- [ ] Launch sequence: (1) soft-launch to the communities already asking for this — Claude Code issue #60082 thread, ACP community, Zed/Cursor discords; (2) Show HN with the demo; (3) launch blog post: _"Every coding agent solved single-user steering the same way. Nobody solved multiplayer. Here's how we did."_
- [x] Licensing boundary stated publicly from day one: **everything in this repo is AGPL-3.0 — permanently open, freely self-hostable, but network copyleft means resellers must open their modifications.** The commercial layer is our hosted control plane, SSO/SCIM, and managed compliance features, offered under a commercial license (contributors sign a CLA so we retain dual-licensing rights). Honesty here is the community moat. — stated in the README: everything here is AGPL-3.0 with no feature held back, network copyleft named as what keeps closed resale off the table, and the commercial line drawn explicitly at a hosted control plane rather than left to be discovered. `CONTRIBUTING.md` covers the CLA — and now says a maintainer will ask rather than claiming a bot that does not exist

**Exit benchmark:** 500 GitHub stars or 10 external self-hosted deployments or 3 external
contributors — any one signals real pull.

### Phase 5 — Grow and monetize (week 16+)

- [ ] Hosted cloud beta (waitlist from launch traffic)
- [ ] Pricing experiment: free self-host + free small-team cloud tier; paid per steered-session-hour for teams (collaboration-layer monetization is unproven — Conductor's still-free status says treat pricing as an experiment, not a plan)
- [ ] Second vertical integration (PagerDuty) once Sentry motion is proven
- [ ] Content flywheel: monthly deep-dive posts on the genuinely novel engineering (multi-human steering theory, hash-chained attribution, redaction pipeline) — the topics incumbents can't credibly write about
- [ ] Community: Discord, monthly community call, RFC process for protocol changes

---

## 6. Engineering practices (binding)

- **Branching:** trunk-based. `main` is protected; all work via short-lived feature branches → PR → squash-merge. Branch names: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
- **Commits:** [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`). Imperative mood, ≤72-char subject.
- **PRs:** small and focused (< ~400 lines diff where possible); description says _what_ and _why_; CI must be green; every PR maps to a plan deliverable or an amendment to this plan.
- **Testing:** Vitest. New logic ships with tests; the hash chain, redaction, steering queue, and replay logic require exhaustive tests — they are the product. Red-team fixtures live in CI permanently.
- **Types:** TypeScript `strict`; no `any` in `packages/core`, `redaction`, or protocol code; zod schemas at every trust boundary (WebSocket messages, ACP frames, sandbox I/O).
- **Decisions:** any change to a "locked" decision in §3 requires an ADR in `docs/adr/` and an amendment PR to this plan.
- **Docs:** the wire protocol lives in `docs/protocol.md` and is versioned; breaking protocol changes require an RFC issue before implementation.
- **Security:** no secrets in the repo, ever (CI secret-scan); `SECURITY.md` disclosure policy from day one; dependencies pinned, Dependabot on.
- **Releases:** changesets → semver → signed tag → GitHub Release with changelog. No manual version bumps.

---

## 7. Marketing & community plan

**Narrative:** _"Agent-agnostic multiplayer for coding agents — watch, steer, hand off, audit."_
Lead every asset with the demo, not the architecture.

1. **Pre-launch (now → end of Phase 2):** build in public — a short thread/post per shipped milestone; engage (helpfully, not promotionally) in Claude Code #60082, ACP, and agent-tooling communities; collect a waitlist.
2. **Launch (Phase 4):** demo GIF + Show HN + launch post; personal outreach to the people who commented on #60082 and similar threads — they are the pre-qualified early adopters.
3. **Post-launch:** monthly engineering deep-dives; conference/meetup talks on multi-human steering (nobody else has production data on it — our usage data becomes the content moat); comparison pages ("Side Street vs screen-sharing", "vs GitHub Ace") kept scrupulously fair.
4. **Positioning discipline:** never bash the labs — we _amplify_ their agents. "Works with Claude Code, Codex, and Gemini" is the headline, not the footnote.

---

## 8. Risks & pivot triggers (check at every phase boundary)

| Trigger                                                                  | Response                                                                                                                                       |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Concurrent steering proves incoherent regardless of role model (Phase 1) | Pivot to high-fidelity synchronous **observation** + explicit single-driver handoff — less ambitious, still valuable                           |
| Anthropic ships live multi-user Claude Code sessions, or GitHub GAs Ace  | Abandon the horizontal play; go all-in on the agent-agnostic **audit layer + vertical workflows** they won't build                             |
| DO or sandbox costs dominate unit economics at pilot scale               | Move agent execution to Fly.io Machines / self-hosted Firecracker; keep only the session actor on Cloudflare                                   |
| ACP adoption stalls or fragments                                         | Our `acp-client` is an interface; add a direct-harness adapter (Claude Agent SDK) behind the same interface                                    |
| Monetization of collaboration layer fails (the Conductor signal)         | Monetize the **compliance/audit** story (tamper-evident logs, SSO, retention) — teams pay for audit even when they won't pay for collaboration |

**Standing re-verification duty:** pricing, model versions, agent steering behavior, and
sandbox specs in the research doc are mid-2026 snapshots. Re-verify against primary docs
before committing code that depends on them.

---

## 9. Success metrics

| Horizon | Metric                                                                                      |
| ------- | ------------------------------------------------------------------------------------------- |
| Phase 1 | 2-human co-steered session completes a real debugging task coherently                       |
| Phase 2 | Red-team suite green; 24h session survival with replay                                      |
| Phase 3 | 1 pilot team resolves a real incident faster than status quo; 2 backing agents work         |
| Phase 4 | 500 stars / 10 self-hosted deploys / 3 external contributors (any one)                      |
| Phase 5 | 5 teams in hosted beta; first paid conversion; steered-session-hours growing week-over-week |

---

_Last amended: 2026-07-25 (Phase 1 layering: the steering engine lives in `core`, the
session actor is runtime-agnostic in `packages/session`, and `session-do` becomes the thin
Durable Object wrapper binding it — keeps the ADR-0001 Cloudflare-exit hatch real and the
product logic exhaustively testable). Amend via PR; every amendment updates this line._
