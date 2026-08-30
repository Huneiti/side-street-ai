/**
 * The redaction pass (PLAN.md §3, invariant 5): rewrite secret spans out of
 * an event before it is broadcast. Two detection sources, applied in order:
 *
 *  1. Known literals — the session-scoped credentials injected at sandbox
 *     boot. We know their exact values, so exact-match redaction is precise
 *     and complete for the secrets we care about most.
 *  2. Built-in patterns — for secrets we did NOT inject but the agent
 *     surfaced anyway (printing a repo token, echoing an env file).
 *
 * Only string *contents* change; structure is preserved, so a redacted event
 * still satisfies its schema variant. The event keeps its original `hash`,
 * which refers to the canonical (unredacted) event stored in the log — a
 * redacted viewer therefore cannot re-hash locally and must rely on the
 * server-side `/verify` endpoint. Events with no secrets are unchanged and
 * verify normally.
 */

import { signedEventSchema, type SignedEvent } from "@side-street/core";
import { BUILTIN_PATTERNS, placeholder, type SecretPattern } from "./patterns.js";

/** Known literals shorter than this are ignored, to avoid over-redacting. */
export const MIN_KNOWN_SECRET_LENGTH = 4;

const KNOWN_SECRET_LABEL = "secret";

/** Redact every known literal and pattern match from a single string. */
export function redactString(
  text: string,
  knownSecrets: readonly string[] = [],
  patterns: readonly SecretPattern[] = BUILTIN_PATTERNS,
): string {
  let out = text;
  // Known literals first: exact and highest-precision. Longest first so a
  // secret that contains a shorter one is redacted whole, not in pieces.
  const literals = [...new Set(knownSecrets)]
    .filter((s) => s.length >= MIN_KNOWN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const secret of literals) {
    out = out.split(secret).join(placeholder(KNOWN_SECRET_LABEL));
  }
  for (const pattern of patterns) {
    const render = pattern.render ?? ((): string => placeholder(pattern.label));
    out = out.replace(pattern.regex, (match) => render(match));
  }
  return out;
}

function redactValue(
  value: unknown,
  knownSecrets: readonly string[],
  patterns: readonly SecretPattern[],
  collapse = false,
): unknown {
  if (typeof value === "string") {
    const redacted = redactString(value, knownSecrets, patterns);
    // Collapse mode: a string that had anything redacted out of it becomes a
    // single placeholder instead of a rewrite. Same secrets removed, bounded
    // length. See `redactEvent`.
    return collapse && redacted !== value ? placeholder(KNOWN_SECRET_LABEL) : redacted;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, knownSecrets, patterns, collapse));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactValue(item, knownSecrets, patterns, collapse);
    }
    return out;
  }
  return value;
}

/**
 * Redact secrets from every string in an event's payload, recursively. Ids and
 * enums pass through untouched — they never match a secret literal or pattern —
 * so walking all strings needs no per-event-type field list to maintain.
 */
export function redactEvent(
  event: SignedEvent,
  knownSecrets: readonly string[] = [],
  patterns: readonly SecretPattern[] = BUILTIN_PATTERNS,
): SignedEvent {
  const sealed = (payload: unknown): { ok: true; event: SignedEvent } | { ok: false } => {
    const parsed = signedEventSchema.safeParse({
      ...event,
      body: { type: event.body.type, payload },
    });
    return parsed.success ? { ok: true, event: parsed.data } : { ok: false };
  };

  // redactValue preserves structure, so the redacted body normally still
  // parses as its variant; re-parsing guarantees we never broadcast a
  // malformed event.
  const rewritten = sealed(redactValue(event.body.payload, knownSecrets, patterns));
  if (rewritten.ok) {
    return rewritten.event;
  }

  // Redaction can make a string *longer* — a placeholder is longer than a
  // short secret — so a field near a schema maximum can overflow it. That must
  // not throw: this runs on the broadcast and replay paths, so an event that
  // cannot be redacted-and-parsed would take the session's whole outbound side
  // with it, on every reconnect, permanently. Collapse each affected string to
  // one placeholder instead: same secrets gone, bounded length.
  const collapsed = sealed(redactValue(event.body.payload, knownSecrets, patterns, true));
  if (collapsed.ok) {
    return collapsed.event;
  }

  // Nothing we can do produces a valid event. Fail closed: the caller gets an
  // exception rather than an unredacted broadcast.
  throw new Error(`cannot redact event seq ${event.seq} into a valid event`);
}
