import { describe, expect, it } from "vitest";
import { appendEvent } from "../src/hash-chain.js";
import { DEFAULT_IDLE_AFTER_MS, summarizeUsage } from "../src/usage.js";
import type { EventBody, SignedEvent } from "../src/events.js";

/** Builds a log where each entry may set its own gap from the previous one. */
async function log(
  entries: Array<{ authorId: string; body: EventBody; afterMs?: number }>,
): Promise<SignedEvent[]> {
  const events: SignedEvent[] = [];
  let ts = Date.UTC(2026, 7, 29, 9, 0, 0);
  for (const { authorId, body, afterMs } of entries) {
    ts += afterMs ?? 1000;
    events.push(await appendEvent(events, { authorId, body, ts }));
  }
  return events;
}

const started = {
  authorId: "system",
  body: {
    type: "session_started" as const,
    payload: { sessionId: "incident-42", agent: "claude-code", sandboxProvider: "e2b" },
  },
};

const joined = (id: string) => ({
  authorId: id,
  body: {
    type: "participant_joined" as const,
    payload: { participantId: id, displayName: id, role: "driver" as const },
  },
});

const says = (id: string, delivery: "queue" | "interrupt" = "queue", afterMs?: number) => ({
  authorId: id,
  body: { type: "human_message" as const, payload: { text: "do the thing", delivery } },
  ...(afterMs === undefined ? {} : { afterMs }),
});

describe("steered sessions", () => {
  it("counts a session nobody steered as unsteered", async () => {
    const events = await log([
      started,
      joined("alice"),
      { authorId: "agent", body: { type: "turn_ended", payload: { stopReason: "end_turn" } } },
    ]);
    const usage = summarizeUsage(events);
    expect(usage.steered).toBe(false);
    expect(usage.steerers).toEqual([]);
    expect(usage.participants).toEqual(["alice"]);
  });

  it("names every distinct steerer once, in first-seen order", async () => {
    const events = await log([
      started,
      joined("alice"),
      joined("bob"),
      says("bob"),
      says("alice"),
      says("bob"),
    ]);
    const usage = summarizeUsage(events);
    expect(usage.steered).toBe(true);
    expect(usage.steerers).toEqual(["bob", "alice"]);
    expect(usage.humanMessages).toBe(3);
  });

  it("counts the multiplayer signals: interrupts and handoffs", async () => {
    const events = await log([
      started,
      joined("alice"),
      {
        authorId: "alice",
        body: {
          type: "control_handoff",
          payload: { fromParticipantId: "alice", toParticipantId: "alice" },
        },
      },
      says("alice", "interrupt"),
      says("alice"),
    ]);
    const usage = summarizeUsage(events);
    expect(usage).toMatchObject({ interrupts: 1, handoffs: 1, humanMessages: 2 });
  });
});

describe("session time", () => {
  it("reports the span, and excludes idle gaps from active time", async () => {
    const events = await log([
      started,
      says("alice", "queue", 60_000),
      // Everyone goes to lunch.
      says("alice", "queue", 60 * 60_000),
      says("alice", "queue", 30_000),
    ]);
    const usage = summarizeUsage(events);
    expect(usage.spanMs).toBe(60_000 + 60 * 60_000 + 30_000);
    // The hour-long gap is not work; the two short ones are.
    expect(usage.activeMs).toBe(90_000);
    expect(usage.activeMs).toBeLessThan(usage.spanMs);
  });

  it("counts everything as active when nothing exceeds the threshold", async () => {
    const events = await log([started, says("alice", "queue", 1000), says("alice", "queue", 2000)]);
    const usage = summarizeUsage(events);
    expect(usage.activeMs).toBe(3000);
    expect(usage.activeMs).toBe(usage.spanMs);
  });

  it("takes the idle threshold from the caller", async () => {
    const events = await log([started, says("alice", "queue", 10 * 60_000)]);
    expect(summarizeUsage(events).activeMs).toBe(0);
    expect(summarizeUsage(events, { idleAfterMs: 15 * 60_000 }).activeMs).toBe(10 * 60_000);
    expect(DEFAULT_IDLE_AFTER_MS).toBe(5 * 60_000);
  });

  it("ignores a clock that went backwards rather than billing negative time", async () => {
    const events = await log([started, says("alice"), says("alice")]);
    // Rewrite the middle timestamp as if a restored log disagreed with itself.
    const tampered = events.map((event, index) =>
      index === 1 ? { ...event, ts: event.ts - 60_000 } : event,
    );
    const usage = summarizeUsage(tampered);
    expect(usage.activeMs).toBeGreaterThanOrEqual(0);
    expect(usage.spanMs).toBeGreaterThanOrEqual(0);
  });

  it("reports zeroes for an empty log rather than failing", () => {
    expect(summarizeUsage([])).toMatchObject({
      spanMs: 0,
      activeMs: 0,
      steered: false,
      events: 0,
      firstEventAt: undefined,
    });
  });
});

describe("what the session did", () => {
  it("separates granted from denied approvals and counts unresolved steps", async () => {
    const events = await log([
      started,
      joined("alice"),
      {
        authorId: "agent",
        body: {
          type: "tool_call",
          payload: { toolCallId: "t1", title: "deploy", status: "pending" },
        },
      },
      {
        authorId: "alice",
        body: {
          type: "permission_decision",
          payload: { requestId: "p1", outcome: { kind: "selected", optionId: "allow" } },
        },
      },
      {
        authorId: "alice",
        body: {
          type: "permission_decision",
          payload: { requestId: "p2", outcome: { kind: "cancelled" } },
        },
      },
      {
        authorId: "system",
        body: {
          type: "step_unresolved",
          payload: { requestId: "p3", stepId: "s3", title: "refund", state: "never_decided" },
        },
      },
    ]);
    expect(summarizeUsage(events)).toMatchObject({
      toolCalls: 1,
      approvals: { granted: 1, denied: 1 },
      unresolvedSteps: 1,
    });
  });

  it("reports the agent that attached, not the one the session expected", async () => {
    const events = await log([
      started,
      { authorId: "agent", body: { type: "agent_attached", payload: { agent: "codex" } } },
    ]);
    expect(summarizeUsage(events)).toMatchObject({ sessionId: "incident-42", agent: "codex" });
  });

  it("credits participants a compacted replay only knows from the checkpoint", async () => {
    const events = await log([
      {
        authorId: "system",
        body: {
          type: "checkpoint",
          payload: {
            summary: "earlier events compacted",
            roster: [
              { participantId: "alice", displayName: "Alice", role: "driver" },
              { participantId: "bob", displayName: "Bob", role: "observer" },
            ],
            driverId: "alice",
            pendingPermissions: [],
          },
        },
      },
      says("alice"),
    ]);
    const usage = summarizeUsage(events);
    expect(usage.participants).toEqual(["alice", "bob"]);
    expect(usage.steerers).toEqual(["alice"]);
  });
});
