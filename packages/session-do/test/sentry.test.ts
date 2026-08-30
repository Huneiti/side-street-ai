import { describe, expect, it } from "vitest";
import {
  incidentFromAlert,
  issueAlertSchema,
  sessionIdForIssue,
  verifySignature,
} from "../src/sentry.js";

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

/** Shaped after Sentry's documented issue-alert payload. */
const ALERT = {
  action: "triggered",
  installation: { uuid: "inst-1" },
  data: {
    event: {
      event_id: "ev-1",
      issue_id: "4417",
      title: "TypeError: cannot read properties of undefined",
      culprit: "checkout/payments in processRefund",
      level: "error",
      environment: "production",
      release: "payments@2026.8.29",
      web_url: "https://sentry.io/organizations/acme/issues/4417/",
      issue_url: "https://sentry.io/api/0/issues/4417/",
      tags: [
        ["level", "error"],
        ["browser", "Chrome"],
      ],
    },
    triggered_rule: "Checkout errors spike",
  },
};

describe("signature verification", () => {
  it("accepts a signature over the exact bytes received", async () => {
    const body = JSON.stringify(ALERT);
    expect(await verifySignature(body, await sign(body), SECRET)).toBe(true);
  });

  it("refuses a body that changed after signing, by a single byte", async () => {
    const body = JSON.stringify(ALERT);
    const signature = await sign(body);
    expect(await verifySignature(`${body} `, signature, SECRET)).toBe(false);
    expect(await verifySignature(body.replace("4417", "4418"), signature, SECRET)).toBe(false);
  });

  it("refuses a signature made with a different secret", async () => {
    const body = JSON.stringify(ALERT);
    expect(await verifySignature(body, await sign(body, "someone-elses"), SECRET)).toBe(false);
  });

  it("refuses a missing or empty signature rather than skipping the check", async () => {
    const body = JSON.stringify(ALERT);
    expect(await verifySignature(body, null, SECRET)).toBe(false);
    expect(await verifySignature(body, "", SECRET)).toBe(false);
    expect(await verifySignature(body, "  ", SECRET)).toBe(false);
  });

  it("tolerates casing and surrounding whitespace in the header", async () => {
    const body = JSON.stringify(ALERT);
    const signature = await sign(body);
    expect(await verifySignature(body, ` ${signature.toUpperCase()} `, SECRET)).toBe(true);
  });
});

describe("reading an alert", () => {
  it("pulls the context an on-call actually opens with", () => {
    const alert = issueAlertSchema.parse(ALERT);
    expect(incidentFromAlert(alert)).toEqual({
      sessionId: "sentry-4417",
      source: "sentry",
      reference: "4417",
      title: "TypeError: cannot read properties of undefined",
      url: "https://sentry.io/organizations/acme/issues/4417/",
      level: "error",
      location: "checkout/payments in processRefund",
      rule: "Checkout errors spike",
      environment: "production",
      release: "payments@2026.8.29",
    });
  });

  it("falls back to tags and the API url when the event omits fields", () => {
    const alert = issueAlertSchema.parse({
      action: "triggered",
      data: {
        event: {
          issue_id: 99,
          issue_url: "https://sentry.io/api/0/issues/99/",
          tags: [
            ["level", "warning"],
            ["environment", "staging"],
            ["release", "web@1.2.3"],
          ],
        },
      },
    });
    expect(incidentFromAlert(alert)).toMatchObject({
      reference: "99",
      title: "Sentry issue 99",
      url: "https://sentry.io/api/0/issues/99/",
      level: "warning",
      environment: "staging",
      release: "web@1.2.3",
    });
  });

  it("reads a release sent as an object rather than a string", () => {
    const alert = issueAlertSchema.parse({
      action: "triggered",
      data: { event: { issue_id: "7", release: { version: "api@9.9.9", dateCreated: "..." } } },
    });
    expect(incidentFromAlert(alert)).toMatchObject({ release: "api@9.9.9" });
  });

  it("declines an alert that names no issue rather than opening a room per alert", () => {
    const alert = issueAlertSchema.parse({ action: "triggered", data: { event: {} } });
    expect(incidentFromAlert(alert)).toBeUndefined();
  });

  it("accepts a payload carrying fields we do not model", () => {
    expect(() =>
      issueAlertSchema.parse({
        action: "triggered",
        data: { event: { issue_id: "1", something_new: { nested: true } }, future_field: 1 },
      }),
    ).not.toThrow();
  });
});

describe("session id derivation", () => {
  it("puts every alert for one issue in one session", () => {
    expect(sessionIdForIssue("4417")).toBe("sentry-4417");
    expect(sessionIdForIssue("4417")).toBe(sessionIdForIssue("4417"));
    expect(sessionIdForIssue("4418")).not.toBe(sessionIdForIssue("4417"));
  });

  it("cannot widen the Worker's route charset or its length limit", () => {
    // The route accepts [A-Za-z0-9_-]{1,64}. An id that could smuggle a slash
    // or a query string past it would address a different session entirely.
    const hostile = sessionIdForIssue("../../admin?x=1&y=/etc/passwd");
    expect(hostile).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(sessionIdForIssue("9".repeat(200))).toHaveLength(64);
  });
});
