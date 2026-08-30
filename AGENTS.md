# AGENTS.md

**[`CLAUDE.md`](CLAUDE.md) is the working agreement, and it governs.** It is written for any
contributor, human or agent, and this file exists only so tools that look for `AGENTS.md` find
their way there rather than inventing their own conventions. Read it before starting.

Everything below is a pointer, not a second source of truth. Where the two ever disagree,
`CLAUDE.md` wins and this file is the bug.

## Before you start

`docs/PLAN.md` governs what gets built. Identify which phase and deliverable your task serves;
if it serves none, the plan needs an amendment PR first. Architecture decisions live in
`docs/adr/`.

## The commands

```bash
pnpm install
pnpm dev          # Worker + web UI + a stub agent — no credentials needed
pnpm test         # every package
pnpm typecheck
pnpm lint
pnpm format:check # Prettier is authoritative
```

CI runs the last four on every PR. Run them before opening one.

## The shape of the repo

| Package                  | What it is                                                            |
| ------------------------ | --------------------------------------------------------------------- |
| `core`                   | Event log, hash chain, steering engine, wire protocol, session tokens |
| `session`                | The session actor: single writer, roster, wheel, approval gates       |
| `session-do`             | Cloudflare Durable Object + Worker: sockets, replay, integrations     |
| `redaction`              | Per-role secret stripping, before anything is broadcast or replayed   |
| `acp-client` / `sandbox` | The backing agent: protocol client, bridge, runner, stub agent        |
| `web`                    | The viewer and steering UI                                            |

## What not to break

`CLAUDE.md` lists the invariants in full. The ones that catch people out:

- The event log is **append-only**. Corrections are new events, never edits.
- **Only the Driver is authoritative**, and authority follows the wheel rather than the
  join-time role. This is correctness, not polish.
- **Secrets never enter prompts or logs**, and redaction runs before any broadcast.
- The red-team fixtures in `packages/session-do/test*/` are permanent. If one fails, the
  product is broken, not the test — never weaken one to make a build pass.
