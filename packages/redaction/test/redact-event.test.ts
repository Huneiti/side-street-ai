import { describe, expect, it } from "vitest";
import { appendEvent, verifyChain, type EventBody, type SignedEvent } from "@side-street/core";
import { redactEvent } from "../src/redact.js";
import { redactAll, redactEventForRole, redactExceptDriver } from "../src/policy.js";
import { placeholder } from "../src/patterns.js";

function event(body: EventBody, authorId = "agent"): Promise<SignedEvent> {
  return appendEvent([], { authorId, body, ts: 1 });
}

describe("redactEvent", () => {
  it("redacts secrets in a free-text payload field", async () => {
    // Assembled from parts so no complete key literal lands in source.
    const key = ["sk", "ant-api03", "B".repeat(24)].join("-");
    const e = await event({
      type: "agent_message_chunk",
      payload: { text: `Your key is ${key} now.` },
    });
    const redacted = redactEvent(e);
    expect(redacted.body.payload).toEqual({ text: `Your key is ${placeholder("api-key")} now.` });
  });

  it("leaves identifier and enum fields untouched", async () => {
    const e = await event({
      type: "tool_call",
      payload: { toolCallId: "tc-KEY-42", title: "Run node test.js", status: "pending" },
    });
    const redacted = redactEvent(e);
    expect(redacted.body.payload).toEqual({
      toolCallId: "tc-KEY-42",
      title: "Run node test.js",
      status: "pending",
    });
  });

  it("preserves envelope fields (seq, author, hash, prevHash)", async () => {
    const e = await event({
      type: "tool_call_update",
      payload: { toolCallId: "tc-1", status: "completed", output: "AKIAIOSFODNN7EXAMPLE" },
    });
    const redacted = redactEvent(e);
    expect(redacted.seq).toBe(e.seq);
    expect(redacted.authorId).toBe(e.authorId);
    expect(redacted.prevHash).toBe(e.prevHash);
    // Hash refers to the canonical event; the redacted view keeps it verbatim.
    expect(redacted.hash).toBe(e.hash);
    expect((redacted.body.payload as { output: string }).output).toBe(
      placeholder("aws-access-key"),
    );
  });

  it("is a no-op for events with no secrets, so they still verify", async () => {
    const genesis = await event({
      type: "session_started",
      payload: { sessionId: "s1", agent: "claude-code", sandboxProvider: "e2b" },
    });
    const redacted = redactEvent(genesis);
    expect(redacted).toEqual(genesis);
    await expect(verifyChain([redacted])).resolves.toEqual({ valid: true, length: 1 });
  });

  it("redacts a session-injected credential via knownSecrets", async () => {
    const cred = "session-token-9f8e7d6c5b4a";
    const e = await event({
      type: "agent_message_chunk",
      payload: { text: `Booting with ${cred}` },
    });
    const redacted = redactEvent(e, [cred]);
    expect((redacted.body.payload as { text: string }).text).toBe(
      `Booting with ${placeholder("secret")}`,
    );
  });
});

describe("redactEventForRole", () => {
  async function secretEvent(): Promise<SignedEvent> {
    return event({
      type: "agent_message_chunk",
      payload: { text: "token AKIAIOSFODNN7EXAMPLE" },
    });
  }

  it("redacts for every role under the default (redactAll) policy", async () => {
    const e = await secretEvent();
    for (const role of ["driver", "navigator", "observer"] as const) {
      const out = redactEventForRole(e, role);
      expect((out.body.payload as { text: string }).text).toContain(placeholder("aws-access-key"));
    }
  });

  it("redactExceptDriver spares the driver but not others", async () => {
    const e = await secretEvent();
    const config = { policy: redactExceptDriver };
    expect(redactEventForRole(e, "driver", config)).toEqual(e);
    for (const role of ["navigator", "observer"] as const) {
      const out = redactEventForRole(e, role, config);
      expect(out).not.toEqual(e);
      expect((out.body.payload as { text: string }).text).toContain(placeholder("aws-access-key"));
    }
  });

  it("redactAll never spares any role, including the observer floor", () => {
    expect(redactAll.redactsFor("observer")).toBe(true);
    expect(redactAll.redactsFor("driver")).toBe(true);
  });
});

describe("redaction cannot break the session it protects", () => {
  /**
   * A placeholder is longer than a short secret, so redaction can push a
   * string past a schema maximum. This runs on the broadcast *and* replay
   * paths, so an event that could not be redacted-and-parsed would take the
   * session's whole outbound side with it — on every reconnect, permanently.
   */
  it("collapses an overflowing field instead of throwing", async () => {
    // Within the 128 the agent socket accepts, but every `KEY=v` expands to a
    // placeholder five times its length.
    const agent = "KEY=v ".repeat(21).trim();
    expect(agent.length).toBeLessThanOrEqual(128);
    const e = await event({ type: "agent_attached", payload: { agent } });

    const redacted = redactEvent(e);
    const out = (redacted.body as { payload: { agent: string } }).payload.agent;
    expect(out).toBe("[redacted:secret]");
    expect(out.length).toBeLessThanOrEqual(128);
  });

  it("collapses only the strings it actually changed", async () => {
    const title = "KEY=v ".repeat(90).trim();
    const e = await event({
      type: "incident_linked",
      payload: { source: "sentry", reference: "4417", title, level: "error" },
    });

    const payload = (redactEvent(e).body as { payload: Record<string, string> }).payload;
    expect(payload["title"]).toBe("[redacted:secret]");
    // Untouched fields keep their values — collapse is per string, not per event.
    expect(payload["source"]).toBe("sentry");
    expect(payload["reference"]).toBe("4417");
    expect(payload["level"]).toBe("error");
  });

  it("still removes the secret when it collapses", async () => {
    const secret = "s1de-street-session-cred-9f2";
    const agent = `${secret} `.repeat(5).trim();
    const e = await event({ type: "agent_attached", payload: { agent } });
    const redacted = redactEvent(e, [secret]);
    expect(JSON.stringify(redacted)).not.toContain(secret);
  });
});
