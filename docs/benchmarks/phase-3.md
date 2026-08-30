# Phase 3 exit benchmark — runbook

> **The claim** (PLAN.md §5): a pilot team (2–3 recruited from the OSS community) runs ≥1 real
> incident through Side Street and reports it beat their status-quo workflow; the same session
> works with two different backing agents.

Two halves, and neither can be automated — that is the point of them. Every other benchmark in
this repo asks whether the code does what it says. This one asks whether the thing is worth
using, which only people can answer.

| Half           | What it proves                               | Who runs it                     |
| -------------- | -------------------------------------------- | ------------------------------- |
| Agent-agnostic | The backing agent is a swappable interface   | You, in about ten minutes       |
| The pilot      | Shared steering beats screen-share and paste | 2–3 external people, once, live |

The first is a prerequisite for the second: recruit a team, then discover the agent they use is
the one you never tried, and you have spent your one first impression on a bug.

## Half 1 — the same session, two agents

The automated coverage runs against an in-memory ACP agent, which cannot prove this: what it
proves is that our client speaks the protocol, not that two real agents both do. Ten minutes.

```bash
pnpm install && pnpm build

# Terminal 1 — Worker + web UI (the stub agent starts too; ignore it)
pnpm dev
```

Then, per agent, in a second terminal — stopping the previous one first, since a second attach
displaces the first:

```bash
cd packages/sandbox

# Agent A
pnpm run runner http://127.0.0.1:8787/session/pilot ../../ --agent claude-code

# Agent B
pnpm run runner http://127.0.0.1:8787/session/pilot ../../ --agent codex
#   or                                                   --agent gemini
```

Each will refuse the first time if it has no credentials, and tell you how:

```
gemini needs credentials. Rerun with one of:
  --auth oauth-personal   (Log in with Google)
```

Join `pilot` in the browser as a Driver and, **for each agent**, check:

- [ ] It attaches — the timeline shows `🤖 agent attached: <name> <version>`, self-declared
- [ ] A steer reaches it and the reply streams token-by-token, not in one block
- [ ] **Interrupt** mid-turn stops it (this is the one most likely to differ between agents)
- [ ] A side-effecting request opens the approval gate, and denying it stops the tool
- [ ] Export produces a transcript naming the agent that actually ran, not `claude-code`
- [ ] `curl 127.0.0.1:8787/session/pilot/verify` → `{"valid":true,...}` across both attaches

**The half passes** when one session, one log and one chain carry both agents end to end. The
same log having two `agent_attached` events with different names _is_ the proof — it is one
session that outlived the agent inside it.

Unmodelled ACP updates (agent thoughts, plans, diffs) are dropped rather than rendered, by
design. An agent that streams mostly those will look quiet; that is a known gap, not a failure
of this benchmark — note it and move on.

## Half 2 — the pilot

### Before you recruit

Do not run this on `pnpm dev`. It needs a deployment the team can reach, which today means
**Phase 3½ (identity)**: v0 identity is unauthenticated query params and the agent socket
accepts any connection, so a public instance is a public session anyone can drive. Until that
lands, the honest options are a private network, a tunnel to one machine, or an IP-allowlisted
deployment — say which you used when you report the result.

Recruit where people have already asked for this: the Claude Code issue #60082 thread, the ACP
community, Zed and Cursor Discords. Ask for **an incident they were going to work anyway** —
a staged one measures whether people can follow instructions, not whether this is better.

### Running it

Set up before the incident, not during: the deployment reachable, the sandbox pointed at their
repo, everyone joined once, and the wheel handed round once so nobody meets the concept for the
first time under pressure.

Then get out of the way. Do not coach. What you are measuring is whether the model — one Driver,
Navigators suggesting, everyone watching the same stream — survives contact with people who did
not design it.

### What to capture

**From the session, automatically:**

```bash
curl -s <base>/session/<id>/usage   # steered, steerers, spanMs vs activeMs, approvals, unresolvedSteps
curl -s <base>/session/<id>/verify
```

Plus the exported Markdown transcript — that is the incident's own record, and the artifact the
team keeps whether or not they keep using Side Street.

**From the people, afterwards.** Five questions, asked once, in their words:

1. Did it beat what you would have done otherwise — screen-share, or one person pasting?
2. Who ended up steering, and did the wheel get in the way or hold the line?
3. Did you ever want to interrupt and not, or interrupt and regret it?
4. Did an approval gate stop something you were glad it stopped, or only slow you down?
5. Would you use it again next week, unprompted?

Question 5 is the benchmark. Everything else explains the answer.

### What counts as passing

The claim is "reports it beat their status-quo workflow", so a pass is **question 5, yes, from a
team who ran a real incident**. Not "it worked" — it working is the floor.

Watch for these, which pass the checklist and fail the point:

- **One person drove the whole time and nobody else spoke.** Then it was a screen-share with
  extra steps, and the multiplayer premise is unproven.
- **`unresolvedSteps > 0`.** An agent restart left approved work unaccounted for during a live
  incident. That is the failure mode ADR-0004 exists for, and it happening in a pilot is worth
  more than a passing survey.
- **`activeMs` far below `spanMs`.** The session was mostly idle — people left and came back,
  which usually means the session was not where the work was happening.

Record the answer either way, in a `docs/benchmarks/results/` note or the PLAN.md checkbox. A
pilot that says no is the most valuable result this project can get at this stage, and PLAN.md
§8 already names the pivot it would trigger.
