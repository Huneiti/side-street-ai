import { describe, expect, it } from "vitest";
import { appendEvent } from "../src/hash-chain.js";
import { toMarkdown } from "../src/transcript.js";
import type { EventBody, SignedEvent } from "../src/events.js";

async function log(entries: Array<{ authorId: string; body: EventBody }>): Promise<SignedEvent[]> {
  const events: SignedEvent[] = [];
  let ts = Date.UTC(2026, 7, 29, 14, 2, 11);
  for (const { authorId, body } of entries) {
    events.push(await appendEvent(events, { authorId, body, ts: (ts += 1000) }));
  }
  return events;
}

const joined = (id: string, displayName: string, role: "driver" | "navigator" | "observer") => ({
  authorId: id,
  body: {
    type: "participant_joined" as const,
    payload: { participantId: id, displayName, role },
  },
});

const wheelTo = (from: string, to: string) => ({
  authorId: from,
  body: {
    type: "control_handoff" as const,
    payload: { fromParticipantId: from, toParticipantId: to },
  },
});

const says = (id: string, text: string, delivery: "queue" | "interrupt" = "queue") => ({
  authorId: id,
  body: { type: "human_message" as const, payload: { text, delivery } },
});

const started = {
  authorId: "system",
  body: {
    type: "session_started" as const,
    payload: { sessionId: "incident-42", agent: "claude-code", sandboxProvider: "e2b" },
  },
};

describe("transcript header", () => {
  it("names the session, its window, and the chain tip to verify against", async () => {
    const events = await log([started, joined("alice", "Alice", "driver")]);
    const md = toMarkdown(events);
    expect(md).toContain("# Side Street session `incident-42`");
    expect(md).toContain("**Agent:** `claude-code` · **Sandbox:** `e2b`");
    expect(md).toContain("**Events:** 2 (seq 0–1)");
    expect(md).toContain(`**Chain tip:** \`${events[1]!.hash}\``);
    expect(md).toContain("| Alice (`alice`) | driver |");
  });

  it("names the agent that attached, not the one the session expected", async () => {
    const events = await log([
      started,
      {
        authorId: "agent",
        body: {
          type: "agent_attached",
          payload: { agent: "gemini", version: "0.57.0", sandboxProvider: "local" },
        },
      },
    ]);
    const md = toMarkdown(events);
    // `session_started` says claude-code; the bridge that turned up says otherwise.
    expect(md).toContain("**Agent:** `gemini 0.57.0`");
    expect(md).toContain("**Sandbox:** `local`");
    expect(md).toContain("agent attached: `gemini 0.57.0` via `local` (self-declared)");
  });

  it("falls back to the expected agent when no bridge declared itself", async () => {
    expect(toMarkdown(await log([started]))).toContain("**Agent:** `claude-code`");
  });

  it("opens with the incident the session was called for", async () => {
    const events = await log([
      {
        authorId: "sentry",
        body: {
          type: "incident_linked",
          payload: {
            source: "sentry",
            reference: "4417",
            title: "TypeError in processRefund",
            url: "https://sentry.io/issues/4417/",
            level: "error",
            location: "checkout/payments",
            rule: "Checkout errors spike",
            environment: "production",
            release: "payments@2026.8.29",
          },
        },
      },
      started,
    ]);
    const md = toMarkdown(events);
    expect(md).toContain("## Incident");
    expect(md).toContain("[TypeError in processRefund](https://sentry.io/issues/4417/)");
    expect(md).toContain("- **Release:** `payments@2026.8.29`");
    expect(md).toContain("- **Where:** `checkout/payments`");
    // The incident block comes before the roster and the timeline.
    expect(md.indexOf("## Incident")).toBeLessThan(md.indexOf("## Timeline"));
  });

  it("omits incident fields the alert did not carry", async () => {
    const events = await log([
      {
        authorId: "sentry",
        body: {
          type: "incident_linked",
          payload: { source: "sentry", reference: "1", title: "Something broke" },
        },
      },
    ]);
    const md = toMarkdown(events);
    expect(md).toContain("## Incident");
    expect(md).not.toContain("**Release:**");
    expect(md).not.toContain("**Environment:**");
  });

  it("says so plainly when there is nothing to show", async () => {
    expect(toMarkdown([])).toContain("**Events:** none");
  });
});

describe("attribution", () => {
  it("labels a message by who held the wheel, not by the role they joined with", async () => {
    const events = await log([
      started,
      joined("alice", "Alice", "driver"),
      joined("bob", "Bob", "navigator"),
      wheelTo("alice", "bob"),
      says("bob", "revert the migration"),
      says("alice", "or roll forward?"),
    ]);
    const md = toMarkdown(events);
    // Bob the Navigator holds the wheel, so Bob is steering and Alice — who
    // joined as Driver — is the one suggesting.
    expect(md).toContain("**Bob** _(steering)_");
    expect(md).toContain("**Alice** _(suggestion)_");
    expect(md).toContain("> revert the migration");
  });

  it("marks a hard-interrupt as one", async () => {
    const events = await log([
      joined("alice", "Alice", "driver"),
      wheelTo("alice", "alice"),
      says("alice", "stop", "interrupt"),
    ]);
    expect(toMarkdown(events)).toContain("**Alice** _(steering ⚡ interrupt)_");
  });

  it("records who approved a gated step, and the key that identifies the run", async () => {
    const events = await log([
      joined("alice", "Alice", "driver"),
      wheelTo("alice", "alice"),
      {
        authorId: "agent",
        body: {
          type: "permission_request",
          payload: {
            requestId: "perm-1",
            toolCallId: "tc-1",
            title: "kubectl rollout restart",
            options: [{ optionId: "allow", name: "Allow" }],
            stepId: "9a3f",
            priorAttempts: 1,
          },
        },
      },
      {
        authorId: "alice",
        body: {
          type: "permission_decision",
          payload: {
            requestId: "perm-1",
            outcome: { kind: "selected", optionId: "allow" },
            idempotencyKey: { sessionId: "incident-42", stepId: "9a3f", attempt: 2 },
          },
        },
      },
    ]);
    const md = toMarkdown(events);
    expect(md).toContain("🔒 approval requested: `kubectl rollout restart` — ⚠ already run 1×");
    expect(md).toContain("**Alice** · 🔓 approved (`allow`) — idempotency `incident-42/9a3f/2`");
  });
});

describe("agent output", () => {
  it("merges streamed chunks into one quoted block", async () => {
    const events = await log([
      { authorId: "agent", body: { type: "agent_message_chunk", payload: { text: "Checking " } } },
      { authorId: "agent", body: { type: "agent_message_chunk", payload: { text: "the logs." } } },
    ]);
    const md = toMarkdown(events);
    expect(md).toContain("> Checking the logs.");
    expect(md.match(/\*\*agent\*\*/g)).toHaveLength(1);
  });

  it("carries a tool call to its final status and fences its output", async () => {
    const events = await log([
      {
        authorId: "agent",
        body: {
          type: "tool_call",
          payload: { toolCallId: "t1", title: "pnpm test", status: "pending" },
        },
      },
      {
        authorId: "agent",
        body: {
          type: "tool_call_update",
          payload: { toolCallId: "t1", status: "failed", output: "3 failed" },
        },
      },
    ]);
    const md = toMarkdown(events);
    expect(md).toContain("🔧 `pnpm test` — **failed**");
    expect(md).toContain("```\n3 failed\n```");
    // One entry per tool, not one per event: the opening status is rewritten
    // rather than left behind as a line of its own.
    expect(md.match(/🔧/g)).toHaveLength(1);
    expect(md).not.toContain("pending");
  });

  it("elides an output past the cap and says how much it dropped", async () => {
    const events = await log([
      {
        authorId: "agent",
        body: {
          type: "tool_call_update",
          payload: { toolCallId: "t1", status: "completed", output: "x".repeat(50) },
        },
      },
    ]);
    const md = toMarkdown(events, { maxOutputChars: 10 });
    expect(md).toContain("… 40 more characters elided");
    expect(md).not.toContain("x".repeat(11));
  });
});

describe("gaps are printed, not smoothed over", () => {
  const checkpoint = {
    authorId: "system",
    body: {
      type: "checkpoint" as const,
      payload: {
        summary: "earlier events compacted",
        roster: [{ participantId: "alice", displayName: "Alice", role: "driver" as const }],
        driverId: "alice",
        pendingPermissions: [],
      },
    },
  };

  it("marks a transcript that starts mid-session", async () => {
    const md = toMarkdown(await log([checkpoint, says("alice", "still broken")]));
    expect(md).toContain("⋯ earlier events compacted");
    // The checkpoint carries the roster, so a compacted export still names people.
    expect(md).toContain("**Alice** _(steering)_");
  });

  it("stays quiet about a checkpoint the reader just read past", async () => {
    const md = toMarkdown(await log([started, joined("alice", "Alice", "driver"), checkpoint]));
    expect(md).not.toContain("⋯");
  });

  it("reports a step the session could not account for", async () => {
    const events = await log([
      {
        authorId: "system",
        body: {
          type: "step_unresolved",
          payload: {
            requestId: "perm-1",
            stepId: "9a3f",
            title: "POST /refunds",
            state: "approved_unfinished",
            idempotencyKey: { sessionId: "incident-42", stepId: "9a3f", attempt: 1 },
          },
        },
      },
    ]);
    expect(toMarkdown(events)).toContain("⚠ approved but never finished: `POST /refunds`");
  });
});

describe("participant text cannot restructure the document", () => {
  it("quotes a message that tries to inject headings and fences", async () => {
    const events = await log([
      joined("alice", "Alice", "driver"),
      wheelTo("alice", "alice"),
      says("alice", "# Postmortem\n\n```\nnot really the end\n```\n## Conclusion: all fine"),
    ]);
    const md = toMarkdown(events);
    for (const line of ["> # Postmortem", "> ```", "> ## Conclusion: all fine"]) {
      expect(md).toContain(line);
    }
    // Nothing the participant typed became a real heading.
    expect(md.split("\n").filter((l) => l.startsWith("#"))).toEqual([
      "# Side Street session",
      "## Participants",
      "## Timeline",
    ]);
  });

  it("keeps a display name full of table syntax inside its cell", async () => {
    const events = await log([joined("mallory", "a | b | c", "observer")]);
    const md = toMarkdown(events);
    expect(md).toContain("| a \\| b \\| c (`mallory`) | observer |");
    expect(md.split("\n").filter((l) => l.startsWith("|"))).toHaveLength(3);
  });

  it("survives backticks inside a tool title", async () => {
    const events = await log([
      {
        authorId: "agent",
        body: {
          type: "tool_call",
          payload: { toolCallId: "t1", title: "echo `whoami`", status: "pending" },
        },
      },
    ]);
    expect(toMarkdown(events)).toContain("`` echo `whoami` ``");
  });
});
