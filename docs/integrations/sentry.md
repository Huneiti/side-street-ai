# Sentry

> **The wedge** (PLAN.md Phase 3): an on-call team resolves a real incident faster with shared
> steering than with screen-share and copy-paste. An alert fires and the room is already open,
> already knowing what broke.

## What happens

A Sentry issue alert posts to `POST /integrations/sentry`. Side Street verifies the signature,
derives a session id from the issue, and writes the incident into that session's log as
`incident_linked` — before anyone joins. Whoever arrives first reads what broke instead of
asking, and the exported postmortem opens with the thing being post-mortemed.

The response carries the room to walk into:

```json
{ "sessionId": "sentry-4417", "session": "/session/sentry-4417" }
```

**One session per issue, not per alert.** An issue that fires four times during an incident is
one incident; the team already in that session sees the fourth alert arrive rather than being
split across four rooms. Each alert appends its own `incident_linked`, because "this fired
again" is usually the fact you want.

## Setup

Create a Sentry [internal integration](https://docs.sentry.io/organization/integrations/integration-platform/internal-integration/)
with the **Issue** webhook and an alert rule action pointing at your deployment:

```
https://<your-worker>/integrations/sentry
```

Then give the Worker the integration's Client Secret:

```bash
npx wrangler secret put SENTRY_CLIENT_SECRET
```

Until that secret is set the endpoint answers `503` — **the integration is off, not open.**

## What it refuses

The endpoint is unauthenticated by nature: Sentry has no credential of ours to present. So it
authenticates the _request_ instead, and fails closed at every step.

| Situation                     | Response | Why                                                                        |
| ----------------------------- | -------- | -------------------------------------------------------------------------- |
| No `SENTRY_CLIENT_SECRET` set | `503`    | Unconfigured means off, never open                                         |
| Missing or wrong signature    | `401`    | Refused before the body is read as anything meaningful                     |
| Body altered after signing    | `401`    | The HMAC covers the exact bytes received                                   |
| A resource we do not act on   | `202`    | Sentry also posts installation hooks; a `4xx` there is a retry loop        |
| Alert naming no issue         | `400`    | Nothing to key a session on — better to decline than open a room per alert |
| `GET`                         | `405`    |                                                                            |

The signature is HMAC-SHA256 over the **raw** body, not over a re-serialization of the parsed
JSON: what was signed is the bytes that arrived, and a round-trip through a parser is a chance
to differ from them. The comparison is constant-time — a length-independent early return leaks
the digest one character per request to anyone willing to make enough of them.

The issue id is scrubbed to the Worker's own route charset before it becomes a session id, so
an id carrying a slash or a query string cannot address a different session.

`/session/:id/incident`, which writes the context, is deliberately absent from the Worker's
public route list. Only a request this Worker built — after verifying a signature — reaches it.
A forged incident would be a forged reason for a session to exist.

## What lands in the session

`incident_linked`, attributed to `sentry` rather than to a person: a webhook is not a
participant, and nothing it writes should read like something a human said.

| Field                    | From                                      |
| ------------------------ | ----------------------------------------- |
| `title`                  | `data.event.title`                        |
| `url`                    | `web_url`, falling back to `issue_url`    |
| `level`                  | `level`, falling back to the `level` tag  |
| `location`               | `culprit` — where it broke                |
| `rule`                   | `data.triggered_rule` — which alert fired |
| `environment`, `release` | the event, falling back to tags           |

`release` is the deploy in play, which is the first thing an on-call asks about.

The payload is deliberately not Sentry-shaped — `source`, `reference`, `title`, `url` and the
rest are what any alerting system has, so PagerDuty (Phase 5) needs a reader, not a new event
type.

## Not yet: repo and recent deploys

The plan's deliverable also names the repo and recent deploys. What an issue alert carries is
the release string, and that is what lands. Fetching the repo and the deploy history around it
needs an authenticated call to the Sentry API with an org token — a second credential, a second
set of response shapes, and nothing to verify them against without an account. That slice is
still open; the alert-to-session path is not waiting on it.
