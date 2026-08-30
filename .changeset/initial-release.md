---
"@side-street/acp-client": minor
"@side-street/redaction": minor
"@side-street/session-do": minor
"@side-street/sandbox": minor
"@side-street/session": minor
"@side-street/core": minor
---

First published release: the multiplayer session layer as it stands at the end of Phase 3.

- `core` — the hash-chained attributed event log, the three-role steering engine, the wire
  protocol, compensation keys, and two projections of a session: an attributed Markdown
  transcript and a usage meter.
- `session` — the session actor: single writer of the log, owner of the roster, the wheel, and
  the approval gates.
- `session-do` — the Cloudflare Durable Object and Worker: SQLite event log, hibernating
  WebSockets, replay and checkpoint compaction, structured ops logging, and the Sentry
  incident webhook.
- `redaction` — per-role secret scanning applied before anything is broadcast or replayed.
- `acp-client` — the Agent Client Protocol client, including authentication negotiation, so any
  ACP agent can back a session.
- `sandbox` — the agent bridge and runner, the E2B provider, session-scoped credentials, and a
  stub agent for running the whole thing without credentials.

Pre-1.0: the wire protocol and these APIs may still change between minors. Identity is not yet
authenticated — see the README's status note before exposing a deployment.
