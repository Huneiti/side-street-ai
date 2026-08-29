/**
 * The session artifact (PLAN.md Phase 3): the event log rendered as an
 * attributed Markdown timeline — the trail a team pastes into a postmortem.
 *
 * A projection of the log, so it lives beside the schema it projects: adding
 * an event body without deciding how it reads in a postmortem is how a
 * transcript quietly starts omitting things.
 *
 * Two properties carry the whole point of the artifact:
 *
 * - **Attribution.** Every line names the identity that authored it, taken
 *   from the sealed envelope rather than anything a message claims about
 *   itself. Gaps (a compacted replay, an unresolved step) are printed, never
 *   smoothed over — a postmortem trail that hides its own holes is worse than
 *   no trail.
 * - **Verifiability.** The header carries the chain tip, so a reader can check
 *   the export against `GET /session/:id/verify` rather than trusting it.
 *
 * Redaction is *not* applied here: this renders whatever events it is given.
 * Callers pass events that already went through `redactEventForRole` on their
 * way out of the Durable Object (PLAN.md invariant 4 — redaction happens
 * before anything leaves).
 */

import type { SignedEvent } from "./events.js";
import type { Role } from "./roles.js";

export interface TranscriptOptions {
  /**
   * Longest tool output reproduced verbatim, in characters; the rest is
   * elided with a marker naming what was dropped.
   * ponytail: a flat character cap, not a smart summary. A postmortem reader
   * scrolling past a 40k-line test log is the failure mode being avoided; if
   * per-tool limits ever matter, key it off the tool name here.
   */
  maxOutputChars?: number;
}

const DEFAULT_MAX_OUTPUT_CHARS = 2000;

/** Renders a session's event log as an attributed Markdown transcript. */
export function toMarkdown(
  events: readonly SignedEvent[],
  options: TranscriptOptions = {},
): string {
  const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const roster = new Map<string, { displayName: string; role: Role }>();
  const entries: string[] = [];
  /** Index in `entries` of each tool call, so its updates rewrite it in place. */
  const toolEntries = new Map<string, { index: number; title: string }>();
  let started: { sessionId: string; agent: string; sandboxProvider: string } | undefined;
  let driverId: string | null = null;
  /** Index into `entries` of the open agent paragraph, so chunks merge. */
  let openAgentText: number | undefined;

  const name = (id: string): string => roster.get(id)?.displayName ?? id;

  for (const event of events) {
    const at = `\`${clockOf(event.ts)}\``;
    const body = event.body;
    if (body.type !== "agent_message_chunk") {
      openAgentText = undefined;
    }
    switch (body.type) {
      case "session_started":
        started = body.payload;
        entries.push(
          `${at} **system** · session started — agent ${code(body.payload.agent)}, sandbox ${code(
            body.payload.sandboxProvider,
          )}`,
        );
        break;
      case "participant_joined":
        roster.set(body.payload.participantId, {
          displayName: body.payload.displayName,
          role: body.payload.role,
        });
        entries.push(
          `${at} **${escape(body.payload.displayName)}** · joined as ${body.payload.role}`,
        );
        break;
      case "participant_left":
        entries.push(`${at} **${escape(name(body.payload.participantId))}** · left`);
        if (driverId === body.payload.participantId) {
          driverId = null;
        }
        break;
      case "role_changed": {
        const entry = roster.get(body.payload.participantId);
        if (entry) {
          entry.role = body.payload.role;
        }
        entries.push(
          `${at} **${escape(name(body.payload.participantId))}** · role changed to ${
            body.payload.role
          }`,
        );
        break;
      }
      case "control_handoff":
        driverId = body.payload.toParticipantId;
        entries.push(
          `${at} **${escape(name(event.authorId))}** · 🛞 wheel to **${escape(
            name(body.payload.toParticipantId),
          )}**`,
        );
        break;
      case "human_message": {
        // Authority follows the wheel, not the join-time role, so the label
        // reports who was actually steering when the message landed.
        const steering = event.authorId === driverId ? "steering" : "suggestion";
        const bang = body.payload.delivery === "interrupt" ? " ⚡ interrupt" : "";
        entries.push(
          `${at} **${escape(name(event.authorId))}** _(${steering}${bang})_\n\n${quote(
            body.payload.text,
          )}`,
        );
        break;
      }
      case "agent_message_chunk": {
        const index = openAgentText;
        const open = index === undefined ? undefined : entries[index];
        if (index !== undefined && open !== undefined) {
          entries[index] = `${open}${quoteContinuation(body.payload.text)}`;
          break;
        }
        openAgentText = entries.length;
        entries.push(`${at} **agent**\n\n${quote(body.payload.text)}`);
        break;
      }
      case "tool_call":
        toolEntries.set(body.payload.toolCallId, {
          index: entries.length,
          title: body.payload.title,
        });
        entries.push(toolLine(at, body.payload.title, body.payload.status));
        break;
      case "tool_call_update": {
        // Collapsed to one entry per tool, carrying its final status and its
        // output, at the time it started. A postmortem reader wants the tool
        // that ran, not the three events it took to say so.
        const output =
          body.payload.output === undefined
            ? ""
            : `\n\n${fence(truncate(body.payload.output, maxOutputChars))}`;
        const open = toolEntries.get(body.payload.toolCallId);
        if (open === undefined) {
          // No opening event: a transcript that starts after the tool began.
          entries.push(toolLine(at, body.payload.toolCallId, body.payload.status, output));
          break;
        }
        entries[open.index] = toolLine(
          entryClock(entries[open.index]) ?? at,
          open.title,
          body.payload.status,
          output,
        );
        break;
      }
      case "permission_request": {
        const repeat =
          body.payload.priorAttempts > 0
            ? ` — ⚠ already run ${body.payload.priorAttempts}× this session`
            : "";
        entries.push(
          `${at} **agent** · 🔒 approval requested: ${code(body.payload.title)}${repeat}`,
        );
        break;
      }
      case "permission_decision": {
        const outcome =
          body.payload.outcome.kind === "selected"
            ? `🔓 approved (${code(body.payload.outcome.optionId)})`
            : "🚫 denied";
        const key = body.payload.idempotencyKey;
        const keyNote =
          key === undefined
            ? ""
            : ` — idempotency ${code(`${key.sessionId}/${key.stepId}/${key.attempt}`)}`;
        entries.push(`${at} **${escape(name(event.authorId))}** · ${outcome}${keyNote}`);
        break;
      }
      case "turn_ended":
        if (body.payload.stopReason !== "end_turn") {
          entries.push(`${at} **agent** · turn ended (${body.payload.stopReason})`);
        }
        break;
      case "step_unresolved":
        entries.push(
          `${at} **system** · ${
            body.payload.state === "approved_unfinished"
              ? `⚠ approved but never finished: ${code(body.payload.title)} — the agent restarted holding this step`
              : `⊘ never decided: ${code(body.payload.title)} — the agent restarted before anyone answered`
          }`,
        );
        break;
      case "checkpoint":
        for (const entry of body.payload.roster) {
          roster.set(entry.participantId, {
            displayName: entry.displayName,
            role: entry.role,
          });
        }
        driverId = body.payload.driverId;
        // Only a transcript that *starts* at a checkpoint is missing history;
        // mid-stream the checkpoint restates what the reader just read.
        if (entries.length === 0) {
          entries.push(`${at} **system** · ⋯ ${escape(body.payload.summary)}`);
        }
        break;
    }
  }

  return [header(events, started, roster), "## Timeline", "", entries.join("\n\n"), ""].join("\n");
}

function header(
  events: readonly SignedEvent[],
  started: { sessionId: string; agent: string; sandboxProvider: string } | undefined,
  roster: Map<string, { displayName: string; role: Role }>,
): string {
  const first = events[0];
  const last = events[events.length - 1];
  const title =
    started === undefined
      ? "Side Street session"
      : `Side Street session ${code(started.sessionId)}`;
  const lines = [`# ${title}`, ""];
  if (started !== undefined) {
    lines.push(
      `- **Agent:** ${code(started.agent)} · **Sandbox:** ${code(started.sandboxProvider)}`,
    );
  }
  if (first === undefined || last === undefined) {
    lines.push("- **Events:** none — this session has no log to show.", "");
    return lines.join("\n");
  }
  lines.push(
    `- **Window:** ${new Date(first.ts).toISOString()} → ${new Date(last.ts).toISOString()}`,
    `- **Events:** ${events.length} (seq ${first.seq}–${last.seq})`,
    `- **Chain tip:** ${code(last.hash)}`,
    "",
    "Rendered from an append-only, hash-chained event log. Every line is attributed to the",
    "identity that sealed it; check this export against the session's `/verify` endpoint",
    "before relying on it.",
    "",
  );
  if (roster.size > 0) {
    lines.push(
      "## Participants",
      "",
      "| Participant | Joined as |",
      "| --- | --- |",
      ...[...roster.entries()].map(
        ([id, entry]) => `| ${escape(entry.displayName)} (${code(id)}) | ${entry.role} |`,
      ),
      "",
    );
  }
  return lines.join("\n");
}

function toolLine(at: string, title: string, status: string, output = ""): string {
  return `${at} **agent** · 🔧 ${code(title)} — **${status}**${output}`;
}

/** The timestamp an entry already carries, so a rewrite keeps its start time. */
function entryClock(entry: string | undefined): string | undefined {
  return entry?.match(/^`\d\d:\d\d:\d\d`/)?.[0];
}

/** `HH:MM:SS` in UTC — deterministic, unlike a locale-formatted time. */
function clockOf(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

/**
 * Inline code that survives backticks in the value: the fence is one longer
 * than the longest run inside, padded so a leading or trailing backtick is not
 * absorbed by the fence (CommonMark §6.1).
 */
function code(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
}

/** A fenced block whose fence is longer than any backtick run in the body. */
function fence(value: string): string {
  const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map((m) => m[0].length));
  const bar = "`".repeat(longest + 1);
  return `${bar}\n${value}\n${bar}`;
}

/**
 * Verbatim participant and agent text as a blockquote. Quoting every line
 * keeps arbitrary Markdown — a stray heading, a table, a fence — from
 * restructuring the document around it.
 */
function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Appends streamed text to an already-quoted paragraph. */
function quoteContinuation(text: string): string {
  return text.split("\n").join("\n> ");
}

/** Escapes the few characters that would break out of a table cell or line. */
function escape(text: string): string {
  return text.replace(/([\\`*_[\]|])/g, "\\$1").replace(/\n/g, " ");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}\n… ${value.length - max} more characters elided`;
}
