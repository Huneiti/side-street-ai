/**
 * Worker entry: routes /session/:id/* to that session's Durable Object.
 * One DO per session id (ADR-0001); everything else is the DO's business.
 */

import { SessionDurableObject, type Env } from "./session-do.js";
import {
  ISSUE_ALERT_RESOURCE,
  RESOURCE_HEADER,
  SIGNATURE_HEADER,
  incidentFromAlert,
  issueAlertSchema,
  verifySignature,
} from "./sentry.js";

export { SessionDurableObject };
export type { Env };

const SESSION_PATH = /^\/session\/([A-Za-z0-9_-]{1,64})\/(events|verify|usage|ws|agent)$/;

/**
 * Public paths are exactly the ones in SESSION_PATH. The DO also answers
 * `/incident`, which is deliberately absent from that list: incident context
 * is written by this Worker after it has verified a webhook signature, and
 * must not be forgeable by anyone who can reach the origin.
 */
const INCIDENT_PATH = "incident";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/integrations/sentry") {
      return await handleSentryWebhook(request, env);
    }
    const match = SESSION_PATH.exec(url.pathname);
    if (match === null) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const sessionId = match[1] as string;
    const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

/**
 * Sentry issue alert -> a shared session already open on the problem.
 *
 * Fails closed at every step. No configured secret means the integration is
 * off, not open; an unverified signature is refused before the body is parsed
 * as anything meaningful; and a resource we do not act on is accepted and
 * ignored rather than rejected, because a 4xx to Sentry's installation hooks
 * is a retry loop rather than a fix.
 */
async function handleSentryWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const secret = env.SENTRY_CLIENT_SECRET;
  if (secret === undefined || secret === "") {
    return Response.json({ error: "integration not configured" }, { status: 503 });
  }
  const rawBody = await request.text();
  const verified = await verifySignature(rawBody, request.headers.get(SIGNATURE_HEADER), secret);
  if (!verified) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }
  if (request.headers.get(RESOURCE_HEADER) !== ISSUE_ALERT_RESOURCE) {
    return Response.json({ ignored: true }, { status: 202 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "body is not valid JSON" }, { status: 400 });
  }
  const alert = issueAlertSchema.safeParse(parsed);
  if (!alert.success) {
    return Response.json({ error: "unrecognised alert payload" }, { status: 400 });
  }
  const incident = incidentFromAlert(alert.data);
  if (incident === undefined) {
    return Response.json({ error: "alert names no issue to open a session for" }, { status: 400 });
  }

  const { sessionId, ...context } = incident;
  const origin = new URL(request.url).origin;
  const stub = env.SESSIONS.get(env.SESSIONS.idFromName(sessionId));
  const response = await stub.fetch(
    new Request(`${origin}/session/${sessionId}/${INCIDENT_PATH}`, {
      method: "POST",
      body: JSON.stringify(context),
      headers: { "Content-Type": "application/json" },
    }),
  );
  if (!response.ok) {
    return Response.json({ error: "could not open the session" }, { status: 502 });
  }
  // Sentry surfaces this response, so hand back the room to walk into.
  return Response.json({ sessionId, session: `/session/${sessionId}` }, { status: 200 });
}
