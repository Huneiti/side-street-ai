# Operating a deployment

What a running Side Street tells you about itself.

## Structured logs

The Durable Object emits one JSON object per line on stdout — what Workers Logs and
`wrangler tail` collect, and what any log pipeline can filter and aggregate:

```json
{
  "ts": 1756500000000,
  "level": "info",
  "event": "viewer.joined",
  "sessionId": "incident-42",
  "participantId": "alice",
  "role": "driver",
  "lastSeq": 41
}
```

```bash
npx wrangler tail --format json          # live
npx wrangler tail --status error         # only what went wrong
```

`event` is a dotted name so a dashboard groups by it without parsing prose — and so the prose
stays out of the line entirely.

| `event`                               | Level | Fields                                  | Why you want it                                                                                             |
| ------------------------------------- | ----- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `session.started`                     | info  | —                                       | A Durable Object woke for a session id nobody had used                                                      |
| `viewer.joined` / `viewer.left`       | info  | `participantId`, `role`, `lastSeq`      | Who was in the room, and how much history they replayed                                                     |
| `viewer.rejected` / `agent.rejected`  | warn  | `reason`                                | A connection turned away before it joined                                                                   |
| `agent.attached`                      | info  | `agent`, `version`, `queuedPrompts`     | Which agent turned up, and how much steering was waiting for it                                             |
| `agent.detached`                      | info  | `queuedPrompts`                         | The bridge exited. Expected on restart; a repeating pair with `agent.attached` is an agent that keeps dying |
| `permission.decided`                  | info  | `participantId`, `requestId`, `outcome` | The audit line for the approval gate                                                                        |
| `steer_rejected` / `handoff_rejected` | warn  | `participantId`, `reason`               | Every refusal of authority the session issued                                                               |
| `auth.insecure`                       | warn  | `reason`                                | **No token secret configured** — identity is asserted, not established. Once per session                    |
| `frame.rejected`                      | warn  | `from`, `participantId`, `reason`       | A malformed frame. A stream of these `from: "agent"` is the shape a prompt injection makes from outside     |

### Logs never carry content

Redaction (PLAN.md invariant 4) runs on the broadcast and replay paths. **A log line takes
neither.** Content reaching a log would be an exfiltration route around the entire redaction
pass — and logs outlive the session they came from.

So log fields are ids, counts, roles, and reason strings this codebase itself wrote. Never
message text, tool output, prompts, or anything a participant or the agent typed. In
particular, never log a zod `error.message`: it quotes the offending input back, which is the
one place a rejected frame's contents could leak.

The `LogFields` type admits only scalars, which stops an object of content being passed by
accident. What enforces the rule is a permanent red-team fixture: a session steers a declared
credential and a path through a real Durable Object, and the captured log is asserted to
contain none of it — while still containing the session's lifecycle, so the test cannot pass
by logging nothing.

### Errors

Failures land as `level: "error"` lines for a log-pipeline alert to match. There is no
error-tracking SDK: nothing here batches, because a Durable Object can be evicted between any
two lines and a batching transport loses exactly the lines that explain why it went away. When
issue grouping and stack aggregation are actually wanted, an SDK slots in behind the `LogSink`
interface in `packages/session-do/src/log.ts` without touching a call site.

## Per-session usage

`GET /session/:id/usage` returns the session's meter — steered-or-not, span and active time,
steering volume, approvals, unresolved steps. It is derived from the event log on demand, so it
cannot drift from the timeline it reports on, and any past session can be re-metered. See
[`protocol.md`](protocol.md#get-sessionidusage--session-meter).

## Cost dashboards — not built

The two spend lines are Durable Object wall-time and sandbox time. Neither has a dashboard yet,
and this is the honest state of it:

- **Per-session inputs exist.** `activeMs` from `/usage` is the closest thing to billable
  session time, and `agent.attached` / `agent.detached` bracket sandbox lifetime in the logs.
- **Aggregation does not.** Rolling those into a dashboard wants either Workers Analytics
  Engine (a binding, a schema, and a deployment to verify against) or shipping the logs
  somewhere that aggregates them. Both are choices about a deployment that does not exist yet,
  and guessing at them would produce configuration nobody has run.

What is missing is the aggregation layer, not the measurements.
