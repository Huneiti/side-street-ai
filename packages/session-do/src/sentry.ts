/**
 * Sentry incident-response integration (PLAN.md Phase 3, the vertical wedge):
 * an alert fires and a shared session is already open, preloaded with what
 * broke, so an on-call team steers an agent at it instead of pasting stack
 * traces into a call.
 *
 * Two things make this safe to expose. The endpoint is unauthenticated by
 * nature — Sentry has no credential of ours to present — so it authenticates
 * the *request* instead, by HMAC over the exact bytes received, and refuses
 * everything it cannot verify. And it writes one event into the session log,
 * attributed to the integration rather than to a person: a webhook is not a
 * participant, and nothing it says should ever look like something a human
 * said.
 */

import { z } from "zod";

export const SIGNATURE_HEADER = "sentry-hook-signature";
export const RESOURCE_HEADER = "sentry-hook-resource";

/** The only resource we act on. Sentry also posts installation lifecycle hooks. */
export const ISSUE_ALERT_RESOURCE = "event_alert";

/**
 * Issue-alert payload, kept to the fields we use and tolerant of the rest:
 * a webhook that grows a field must not start failing verification.
 */
export const issueAlertSchema = z.object({
  action: z.string(),
  data: z.object({
    event: z
      .object({
        event_id: z.string().optional(),
        issue_id: z.union([z.string(), z.number()]).optional(),
        title: z.string().optional(),
        culprit: z.string().nullish(),
        level: z.string().nullish(),
        environment: z.string().nullish(),
        release: z.union([z.string(), z.object({ version: z.string() }).passthrough()]).nullish(),
        web_url: z.string().optional(),
        issue_url: z.string().optional(),
        tags: z.array(z.tuple([z.string(), z.string()]).rest(z.unknown())).optional(),
      })
      .passthrough(),
    triggered_rule: z.string().nullish(),
  }),
});
export type IssueAlert = z.infer<typeof issueAlertSchema>;

export interface Incident {
  /** Deterministic from the issue, so repeat alerts land in the same session. */
  sessionId: string;
  source: string;
  reference: string;
  title: string;
  url?: string;
  level?: string;
  location?: string;
  rule?: string;
  environment?: string;
  release?: string;
}

/**
 * One session per Sentry issue, not per alert. An issue that fires four times
 * during an incident is one incident, and the team already in that session
 * should see the fourth alert arrive rather than be split across four rooms.
 */
export function sessionIdForIssue(issueId: string): string {
  // The Worker's route only accepts [A-Za-z0-9_-]{1,64}; Sentry issue ids are
  // numeric, but a hostile or future id must not be able to widen that.
  return `sentry-${issueId.replace(/[^A-Za-z0-9_-]/g, "")}`.slice(0, 64);
}

/** Reads an alert into the shape the session log stores. */
export function incidentFromAlert(alert: IssueAlert): Incident | undefined {
  const event = alert.data.event;
  const issueId = event.issue_id === undefined ? undefined : String(event.issue_id);
  if (issueId === undefined || issueId === "") {
    // Nothing to key a session on. Better to decline than to open a room per
    // alert and split an incident across all of them.
    return undefined;
  }
  const tags = new Map((event.tags ?? []).map(([key, value]) => [key, value]));
  const release =
    typeof event.release === "string" ? event.release : (event.release?.version ?? undefined);
  return {
    sessionId: sessionIdForIssue(issueId),
    source: "sentry",
    reference: issueId,
    title: event.title ?? `Sentry issue ${issueId}`,
    ...optional("url", event.web_url ?? event.issue_url),
    ...optional("level", event.level ?? tags.get("level")),
    ...optional("location", event.culprit),
    ...optional("rule", alert.data.triggered_rule),
    ...optional("environment", event.environment ?? tags.get("environment")),
    ...optional("release", release ?? tags.get("release")),
  };
}

function optional(key: string, value: string | null | undefined): Record<string, string> {
  return value === undefined || value === null || value === "" ? {} : { [key]: value };
}

/**
 * Verifies Sentry's HMAC over the **raw** body. Not over a re-serialization of
 * the parsed JSON: what was signed is the bytes that arrived, and any
 * round-trip through a parser is a chance to differ from them.
 */
export async function verifySignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (signature === null || signature === "") {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return timingSafeEqual(hex(digest), signature.trim().toLowerCase());
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time comparison. A length-independent early return would leak the
 * digest one character per request to anyone willing to make enough of them.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}
