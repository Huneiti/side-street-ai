/**
 * The controls a role is actually shown. `controls.test.ts` covers the rules;
 * this checks the rendered footer honours them, because the bug being guarded
 * against was a correct server refusing buttons the UI still offered.
 *
 * Static rendering only — no DOM, no effects, no test-renderer dependency.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { appendEvent, type EventBody, type Role, type SignedEvent } from "@side-street/core";
import { SessionView } from "../src/SessionView.js";

async function log(entries: Array<{ authorId: string; body: EventBody }>): Promise<SignedEvent[]> {
  const events: SignedEvent[] = [];
  let ts = 0;
  for (const { authorId, body } of entries) {
    events.push(await appendEvent(events, { authorId, body, ts: ts++ }));
  }
  return events;
}

/** Alice drives, Bob navigates, Carol observes; Alice holds the wheel. */
function seed(): Promise<SignedEvent[]> {
  const joins: Array<[string, Role]> = [
    ["alice", "driver"],
    ["bob", "navigator"],
    ["carol", "observer"],
  ];
  return log([
    ...joins.map(([id, role]) => ({
      authorId: id,
      body: {
        type: "participant_joined" as const,
        payload: { participantId: id, displayName: id, role },
      },
    })),
    {
      authorId: "alice",
      body: {
        type: "control_handoff",
        payload: { fromParticipantId: "alice", toParticipantId: "alice" },
      },
    },
  ]);
}

function render(events: SignedEvent[], self: string, selfRole: Role): string {
  return renderToStaticMarkup(
    <SessionView
      events={events}
      status="live"
      notice={null}
      self={self}
      selfRole={selfRole}
      onSteer={() => {}}
      onHandoff={() => {}}
      onDecide={() => {}}
      onExport={() => {}}
      onLeave={() => {}}
    />,
  );
}

describe("the footer an Observer sees", () => {
  it("offers no steering affordance at all", async () => {
    const markup = render(await seed(), "carol", "observer");
    expect(markup).toContain("Observers are read-only");
    expect(markup).not.toContain("Send");
    expect(markup).not.toContain("Interrupt");
    expect(markup).not.toContain("Take the wheel");
    expect(markup).not.toContain("<input");
  });
});

describe("the live session meter", () => {
  it("shows active and wall-clock time and makes unresolved steps prominent", async () => {
    const events = await seed();
    events.push(
      await appendEvent(events, {
        authorId: "bob",
        ts: 60_003,
        body: { type: "human_message", payload: { text: "stop", delivery: "interrupt" } },
      }),
    );
    events.push(
      await appendEvent(events, {
        authorId: "system",
        ts: 600_003,
        body: {
          type: "step_unresolved",
          payload: {
            requestId: "perm-1",
            stepId: "0123456789abcdef",
            title: "Publish the release",
            state: "approved_unfinished",
          },
        },
      }),
    );

    const markup = render(events, "carol", "observer");
    expect(markup).toContain("Steered by bob");
    expect(markup).toContain("Active 1m");
    expect(markup).toContain("Span 10m");
    expect(markup).toContain("1 interrupt");
    expect(markup).toContain('class="meter-warning">⚠ 1 unresolved step</strong>');
  });
});

describe("the footer a steering participant sees", () => {
  it("gives the wheel-holder send and interrupt, and nothing to claim", async () => {
    const markup = render(await seed(), "alice", "driver");
    expect(markup).toContain("Send");
    expect(markup).toContain("Interrupt");
    expect(markup).not.toContain("Take the wheel");
  });

  it("lets a Navigator suggest and claim, but not interrupt", async () => {
    const markup = render(await seed(), "bob", "navigator");
    expect(markup).toContain("Send");
    expect(markup).toContain("Take the wheel");
    expect(markup).not.toContain("Interrupt");
  });
});

describe("handing the wheel from the roster", () => {
  it("makes a Driver's chips buttons, except their own and the Observer's", async () => {
    const markup = render(await seed(), "alice", "driver");
    expect(markup).toContain("Hand the wheel to bob");
    expect(markup).not.toContain("Hand the wheel to carol");
    expect(markup).not.toContain("Hand the wheel to alice");
  });

  it("leaves every chip inert for a non-Driver", async () => {
    const markup = render(await seed(), "bob", "navigator");
    expect(markup).not.toContain("Hand the wheel to");
  });
});
