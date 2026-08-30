/**
 * Usage metering (PLAN.md Phase 3): what a session cost and what it was worth,
 * derived from the event log.
 *
 * Derived, not counted. A session's meter is a projection of the same
 * append-only log everything else reads, so there are no counters to keep in
 * sync, nothing to lose when a Durable Object is evicted, and no way for the
 * bill to disagree with the timeline it is billed from. It is also
 * re-derivable: the numbers for any past session can be recomputed from the
 * log at any time, and checked against the chain like any other claim.
 *
 * The plan's two units are `steeredSessions` and session-hours. The first is a
 * question the log answers exactly — did a human steer this agent, or did it
 * run alone. The second is a judgement, so it is reported two ways rather than
 * one: see `activeMs`.
 */

import type { SignedEvent } from "./events.js";

export interface UsageOptions {
  /**
   * Gap after which a session counts as idle rather than running, in ms.
   * A session left open overnight should not bill as eight hours of agent
   * time, and a pause between two humans thinking is not a pause in the work.
   * ponytail: one flat threshold, applied to every gap. If the split between
   * "agent working" and "humans deliberating" ever needs different rates, it
   * is derivable from the same log — the event types on each side of the gap
   * say which was happening.
   */
  idleAfterMs?: number;
}

/** Five minutes: longer than a slow tool call, shorter than a coffee break. */
export const DEFAULT_IDLE_AFTER_MS = 5 * 60 * 1000;

export interface UsageSummary {
  /** From `session_started`, when the log still contains it. */
  sessionId: string | undefined;
  /** The agent that attached, as it declared itself; undefined if none did. */
  agent: string | undefined;
  firstEventAt: number | undefined;
  lastEventAt: number | undefined;
  /** Wall-clock first event to last: what the session spanned. */
  spanMs: number;
  /**
   * Span minus every gap longer than `idleAfterMs`: what the session was
   * plausibly doing something. Always <= `spanMs`; both are reported because
   * which one a price should key off is a business decision, not a fact.
   */
  activeMs: number;
  /**
   * The plan's headline unit: did a human steer this agent at all. A session
   * nobody steered is one our collaboration layer added nothing to, and
   * charging for it would be charging for the wrong thing.
   */
  steered: boolean;
  /** Distinct humans whose steering reached the log, in first-seen order. */
  steerers: string[];
  /** Distinct humans who joined, whether or not they steered. */
  participants: string[];
  humanMessages: number;
  /** Hard-interrupts: the expensive kind of steering, since they cancel a turn. */
  interrupts: number;
  /** Times the wheel changed hands — the multiplayer signal. */
  handoffs: number;
  agentTurns: number;
  toolCalls: number;
  approvals: { granted: number; denied: number };
  /**
   * Steps an agent restart left unaccounted for. Not a cost, but the thing to
   * watch: a deployment where this climbs is losing work, not saving it.
   */
  unresolvedSteps: number;
  events: number;
}

/** Meters one session from its log. Pure: same events, same numbers, forever. */
export function summarizeUsage(
  events: readonly SignedEvent[],
  options: UsageOptions = {},
): UsageSummary {
  const idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
  const steerers = new Set<string>();
  const participants = new Set<string>();
  const summary: UsageSummary = {
    sessionId: undefined,
    agent: undefined,
    firstEventAt: events[0]?.ts,
    lastEventAt: events[events.length - 1]?.ts,
    spanMs: 0,
    activeMs: 0,
    steered: false,
    steerers: [],
    participants: [],
    humanMessages: 0,
    interrupts: 0,
    handoffs: 0,
    agentTurns: 0,
    toolCalls: 0,
    approvals: { granted: 0, denied: 0 },
    unresolvedSteps: 0,
    events: events.length,
  };

  let previousTs: number | undefined;
  for (const event of events) {
    if (previousTs !== undefined) {
      const gap = event.ts - previousTs;
      // A clock that went backwards contributes nothing rather than a
      // negative: the DO is the single writer, but a restored log is data.
      if (gap > 0 && gap <= idleAfterMs) {
        summary.activeMs += gap;
      }
    }
    previousTs = event.ts;

    const body = event.body;
    switch (body.type) {
      case "session_started":
        summary.sessionId = body.payload.sessionId;
        break;
      case "agent_attached":
        summary.agent = body.payload.agent;
        break;
      case "participant_joined":
        participants.add(body.payload.participantId);
        break;
      case "human_message":
        summary.humanMessages++;
        steerers.add(event.authorId);
        if (body.payload.delivery === "interrupt") {
          summary.interrupts++;
        }
        break;
      case "control_handoff":
        summary.handoffs++;
        break;
      case "turn_ended":
        summary.agentTurns++;
        break;
      case "tool_call":
        summary.toolCalls++;
        break;
      case "permission_decision":
        if (body.payload.outcome.kind === "selected") {
          summary.approvals.granted++;
        } else {
          summary.approvals.denied++;
        }
        break;
      case "step_unresolved":
        summary.unresolvedSteps++;
        break;
      case "checkpoint":
        // The roster a compacted replay starts from: these people were here,
        // even though their join events are no longer in front of us.
        for (const entry of body.payload.roster) {
          participants.add(entry.participantId);
        }
        break;
    }
  }

  if (summary.firstEventAt !== undefined && summary.lastEventAt !== undefined) {
    summary.spanMs = Math.max(0, summary.lastEventAt - summary.firstEventAt);
  }
  summary.steerers = [...steerers];
  summary.participants = [...participants];
  summary.steered = steerers.size > 0;
  return summary;
}
