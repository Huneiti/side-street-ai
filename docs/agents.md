# Backing agents

> **The claim** (PLAN.md §3): the backing agent is a swappable interface, never a vendor
> dependency. Side Street never builds its own coding agent (ADR-0002) — it speaks the
> [Agent Client Protocol](https://agentclientprotocol.com) and wraps whatever does.

A claim like that is only worth what you can demonstrate, so this is the runbook for pointing a
session at a different agent.

## Run it

The bridge runner spawns the agent and connects it to a session:

```bash
runner <session-url> <workspace-dir> [--agent <name>] [--auth <methodId>] \
  [--sandbox-provider <name>] [-- <command...>]
```

| `--agent`     | Spawns                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| `claude-code` | `npx @agentclientprotocol/claude-agent-acp` (default)                  |
| `codex`       | `npx @zed-industries/codex-acp`                                        |
| `gemini`      | `npx @google/gemini-cli --acp`                                         |
| `stub`        | A canned agent in this repo — no credentials, for demos and `pnpm dev` |

```bash
# The default
pnpm --filter @side-street/sandbox runner http://localhost:8787/session/demo ../sample-repo

# Another agent, same session, same everything else
pnpm --filter @side-street/sandbox runner http://localhost:8787/session/demo ../sample-repo \
  --agent gemini

# The bridge is running in E2B rather than the default local process
runner https://worker.example/session/demo /workspace --sandbox-provider e2b
```

`stub` is not a real agent: canned replies over a real stdio pipe, so the whole product —
streaming, mid-turn steering, hard-interrupt, the approval gate, the attributed log — can be
run and demonstrated with no API key. It asks permission before anything that reads like a side
effect (`deploy`, `delete`, `migrate`, …), which is what makes the Driver-only gate visible in a
demo. The moment you want it to actually _do_ something, you want a real agent.

The presets are a convenience, not the interface. Any ACP agent works — pass its command after
`--`, and nothing else changes:

```bash
runner http://localhost:8787/session/demo ../sample-repo -- my-agent --stdio
```

An unknown `--agent` name is an error rather than a fallback to the default: silently running
Claude Code while you believe you are testing something else is the one bug that would make this
whole page untrue.

## Authentication

Agents hold their own credentials; Side Street never sees them. Most want a login before they
will open a session, and this is the wall you hit first with a new agent.

`initialize` tells us which methods an agent accepts, and `session/new` answers `auth_required`
(JSON-RPC `-32000`) when it has none. The runner turns that into the command that fixes it:

```
$ runner http://localhost:8787/session/demo ../repo --agent gemini
gemini needs credentials. Rerun with one of:
  --auth oauth-personal   (Log in with Google)
  --auth gemini-api-key   (Use a Gemini API key)
```

`--auth <methodId>` calls ACP `authenticate` before opening the session. Some agents instead
expect you to have logged in with their own CLI first; for those, do that and rerun with no
`--auth` at all.

## What does and does not change with the agent

**Unchanged — it is all on our side of the socket.** The hash-chained event log and attribution,
per-role redaction, Driver-only approval gates, idempotency keys, checkpointing and replay, and
every red-team fixture. Swapping the agent swaps one process at the end of a stdio pipe.

**Agent-dependent.** Which tools it offers and therefore which approvals a Driver sees; how
chatty its streaming is; and which ACP update kinds it emits. Kinds we do not model yet (agent
thoughts, plans, diffs) arrive as `unknown_update` and are dropped rather than rendered — a
deliberate forward-compatibility choice in `packages/acp-client/src/protocol.ts`, so an agent
ahead of us degrades instead of breaking the session.

**Recorded.** The bridge declares what it is when it connects, and the session logs it as
`agent_attached` — from the agent's own ACP `agentInfo` when it reports one, otherwise the
name you asked for. It also declares the sandbox provider (`local` by default, or the value of
`--sandbox-provider`). An exported transcript therefore names the agent and sandbox that
actually ran, marked as self-declared, because a sandbox reporting on itself is exactly as
trustworthy as that sounds.

**Not yet.** Prompts are text-only content blocks: an agent advertising image or audio prompt
capabilities gets text anyway.

## Where the automated coverage is

`packages/acp-client/test/client.test.ts` drives the handshake, the auth path (advertised
methods, `auth_required`, `authenticate`, then a session), a full streamed turn, cancellation and
permission requests against an in-memory ACP agent. `packages/sandbox/test/runner.test.ts` covers
preset resolution and argument parsing.

What no test can cover is a real second agent on real credentials — that is the Phase 3 exit
benchmark, and it is a human running the two commands above and steering both.
