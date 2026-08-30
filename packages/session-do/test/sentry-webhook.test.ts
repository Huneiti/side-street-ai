/**
 * The Sentry webhook end to end: a signed alert arriving at the Worker leaves
 * a session already open on the problem.
 */

import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { SignedEvent } from "@side-street/core";
import { BASE } from "./harness.js";

const SECRET = "not-a-real-client-secret";

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let issueSeq = 9000;
function alertBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "triggered",
    installation: { uuid: "inst-1" },
    data: {
      event: {
        event_id: "ev-1",
        issue_id: String(issueSeq++),
        title: "TypeError: cannot read properties of undefined",
        culprit: "checkout/payments in processRefund",
        level: "error",
        environment: "production",
        release: "payments@2026.8.29",
        web_url: "https://sentry.io/organizations/acme/issues/x/",
        ...overrides,
      },
      triggered_rule: "Checkout errors spike",
    },
  });
}

async function post(body: string, headers: Record<string, string | undefined>): Promise<Response> {
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) defined[key] = value;
  }
  return await SELF.fetch(`${BASE}/integrations/sentry`, {
    method: "POST",
    body,
    headers: defined,
  });
}

describe("a signed alert opens a session", () => {
  it("seeds the log with the incident before anyone joins", async () => {
    const body = alertBody();
    const response = await post(body, {
      "sentry-hook-signature": await sign(body),
      "sentry-hook-resource": "event_alert",
    });
    expect(response.status).toBe(200);
    const { sessionId } = (await response.json()) as { sessionId: string };
    expect(sessionId).toMatch(/^sentry-\d+$/);

    const replay = await SELF.fetch(`${BASE}/session/${sessionId}/events?from=0`);
    const { events } = (await replay.json()) as { events: SignedEvent[] };
    const incident = events.find((e) => e.body.type === "incident_linked");
    expect(incident?.body).toMatchObject({
      type: "incident_linked",
      payload: {
        source: "sentry",
        title: "TypeError: cannot read properties of undefined",
        level: "error",
        location: "checkout/payments in processRefund",
        rule: "Checkout errors spike",
        release: "payments@2026.8.29",
      },
    });
    // Attributed to the integration. A webhook is not a participant, and
    // nothing it writes should read like something a person said.
    expect(incident?.authorId).toBe("sentry");
    expect(events.some((e) => e.body.type === "human_message")).toBe(false);
  });

  it("puts repeat alerts for one issue in the same room", async () => {
    const first = alertBody();
    const issueId = (JSON.parse(first) as { data: { event: { issue_id: string } } }).data.event
      .issue_id;
    const again = alertBody({ issue_id: issueId, event_id: "ev-2" });

    const a = await post(first, {
      "sentry-hook-signature": await sign(first),
      "sentry-hook-resource": "event_alert",
    });
    const b = await post(again, {
      "sentry-hook-signature": await sign(again),
      "sentry-hook-resource": "event_alert",
    });
    expect((await a.json()) as unknown).toEqual(await b.json());

    // An issue firing twice during an incident is one incident, and the team
    // already in that session sees the second alert arrive.
    const replay = await SELF.fetch(`${BASE}/session/sentry-${issueId}/events?from=0`);
    const { events } = (await replay.json()) as { events: SignedEvent[] };
    expect(events.filter((e) => e.body.type === "incident_linked")).toHaveLength(2);
  });
});

describe("what it refuses", () => {
  it("refuses an unsigned request", async () => {
    const body = alertBody();
    const response = await post(body, { "sentry-hook-resource": "event_alert" });
    expect(response.status).toBe(401);
  });

  it("refuses a signature that does not match the body it arrived with", async () => {
    const body = alertBody();
    const signature = await sign(body);
    const response = await post(body.replace("processRefund", "processRefunds"), {
      "sentry-hook-signature": signature,
      "sentry-hook-resource": "event_alert",
    });
    expect(response.status).toBe(401);
  });

  it("refuses a signature made with the wrong secret", async () => {
    const body = alertBody();
    const response = await post(body, {
      "sentry-hook-signature": await sign(body, "someone-elses"),
      "sentry-hook-resource": "event_alert",
    });
    expect(response.status).toBe(401);
  });

  it("writes nothing for a request it refused", async () => {
    const body = alertBody();
    const issueId = (JSON.parse(body) as { data: { event: { issue_id: string } } }).data.event
      .issue_id;
    await post(body, { "sentry-hook-resource": "event_alert" });
    const replay = await SELF.fetch(`${BASE}/session/sentry-${issueId}/events?from=0`);
    const { events } = (await replay.json()) as { events: SignedEvent[] };
    expect(events.some((e) => e.body.type === "incident_linked")).toBe(false);
  });

  it("accepts and ignores a resource it does not act on, rather than 4xx-ing a retry loop", async () => {
    const body = JSON.stringify({ action: "created", data: {} });
    const response = await post(body, {
      "sentry-hook-signature": await sign(body),
      "sentry-hook-resource": "installation",
    });
    expect(response.status).toBe(202);
  });

  it("refuses a GET", async () => {
    const response = await SELF.fetch(`${BASE}/integrations/sentry`);
    expect(response.status).toBe(405);
  });

  it("keeps the incident path unreachable from outside", async () => {
    // The Worker writes incident context after verifying a signature. If the
    // path were routable, anyone could forge the reason a session exists.
    const response = await SELF.fetch(`${BASE}/session/sentry-1/incident`, {
      method: "POST",
      body: JSON.stringify({ source: "sentry", reference: "1", title: "forged" }),
    });
    expect(response.status).toBe(404);
  });
});
