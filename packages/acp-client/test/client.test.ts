import { describe, expect, it } from "vitest";
import { AcpClient, AcpError } from "../src/client.js";
import type { PermissionOutcome, SessionUpdate } from "../src/protocol.js";
import { createTransportPair } from "../src/transport.js";
import { FakeAgent } from "../src/fake-agent.js";

interface Recorded {
  updates: SessionUpdate[];
  errors: Error[];
}

function setup(options?: {
  requestPermissionAfterChunks?: number;
  decide?: () => Promise<PermissionOutcome>;
  authMethods?: Array<{ id: string; name: string }>;
  requireAuth?: boolean;
}): { client: AcpClient; agent: FakeAgent; recorded: Recorded } {
  const [clientSide, agentSide] = createTransportPair();
  const recorded: Recorded = { updates: [], errors: [] };
  const agent = new FakeAgent(agentSide, {
    ...(options?.requestPermissionAfterChunks === undefined
      ? {}
      : { requestPermissionAfterChunks: options.requestPermissionAfterChunks }),
    ...(options?.authMethods === undefined ? {} : { authMethods: options.authMethods }),
    ...(options?.requireAuth === undefined ? {} : { requireAuth: options.requireAuth }),
  });
  const client = new AcpClient(clientSide, {
    onSessionUpdate: (_sessionId, update) => recorded.updates.push(update),
    onPermissionRequest: options?.decide ?? (() => Promise.reject(new Error("unexpected"))),
    onError: (error) => recorded.errors.push(error),
  });
  return { client, agent, recorded };
}

describe("AcpClient", () => {
  it("initializes, opens a session, and streams a full turn", async () => {
    const { client, recorded } = setup();
    await client.initialize();
    const sessionId = await client.newSession({ cwd: "/repo" });
    expect(sessionId).toBe("sess-1");

    const stopReason = await client.prompt(sessionId, [{ type: "text", text: "fix the bug" }]);
    expect(stopReason).toBe("end_turn");
    expect(recorded.updates.map((u) => u.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
    ]);
    expect(recorded.errors).toEqual([]);
  });

  it("cancel() resolves the in-flight prompt with stopReason cancelled", async () => {
    const { client, recorded } = setup();
    await client.initialize();
    const sessionId = await client.newSession({ cwd: "/repo" });

    const turn = client.prompt(sessionId, [{ type: "text", text: "long task" }]);
    client.cancel(sessionId);
    expect(await turn).toBe("cancelled");
    // The turn stopped early: not all scripted updates arrived.
    expect(recorded.updates.length).toBeLessThan(3);
  });

  it("routes permission requests to the handler and returns the decision", async () => {
    const { client, agent } = setup({
      requestPermissionAfterChunks: 2,
      decide: () => Promise.resolve({ outcome: "selected", optionId: "allow" }),
    });
    await client.initialize();
    const sessionId = await client.newSession({ cwd: "/repo" });
    await client.prompt(sessionId, [{ type: "text", text: "run the tests" }]);
    expect(agent.permissionOutcomes).toEqual([
      { outcome: { outcome: "selected", optionId: "allow" } },
    ]);
  });

  it("denies (cancelled), never allows, when the permission handler fails", async () => {
    const { client, agent, recorded } = setup({
      requestPermissionAfterChunks: 1,
      decide: () => Promise.reject(new Error("driver disconnected")),
    });
    await client.initialize();
    const sessionId = await client.newSession({ cwd: "/repo" });
    await client.prompt(sessionId, [{ type: "text", text: "run the tests" }]);
    expect(agent.permissionOutcomes).toEqual([{ outcome: { outcome: "cancelled" } }]);
    expect(recorded.errors.map((e) => e.message)).toContain("driver disconnected");
  });

  it("surfaces malformed frames via onError without crashing the session", async () => {
    const [clientSide, agentSide] = createTransportPair();
    const errors: Error[] = [];
    new AcpClient(clientSide, {
      onSessionUpdate: () => undefined,
      onPermissionRequest: () => Promise.resolve({ outcome: "cancelled" }),
      onError: (error) => errors.push(error),
    });
    agentSide.send({ not: "jsonrpc" });
    agentSide.send({ jsonrpc: "2.0", method: "session/update", params: { bad: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(2);
  });

  it("rejects pending requests when closed", async () => {
    const { client } = setup();
    await client.initialize();
    const sessionId = await client.newSession({ cwd: "/repo" });
    const turn = client.prompt(sessionId, [{ type: "text", text: "task" }]);
    client.close();
    await expect(turn).rejects.toThrow("ACP client closed");
  });
});

describe("authentication", () => {
  const login = [{ id: "oauth", name: "Log in with OAuth" }];

  it("reports the agent's advertised auth methods from the handshake", async () => {
    const { client } = setup({ authMethods: login });
    const result = await client.initialize();
    expect(result.authMethods).toEqual(login);
  });

  it("reports no methods for an agent that needs none", async () => {
    const { client } = setup();
    expect((await client.initialize()).authMethods).toEqual([]);
  });

  it("surfaces auth_required as itself, not as an opaque agent error", async () => {
    const { client } = setup({ authMethods: login, requireAuth: true });
    await client.initialize();
    const error = await client.newSession({ cwd: "/repo" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AcpError);
    expect(error).toMatchObject({ code: -32000, isAuthRequired: true });
  });

  it("opens a session once credentials are presented", async () => {
    const { client, agent } = setup({ authMethods: login, requireAuth: true });
    await client.initialize();
    await client.authenticate("oauth");
    expect(agent.authenticatedWith).toBe("oauth");
    expect(await client.newSession({ cwd: "/repo" })).toBe("sess-1");
  });

  it("treats only auth_required as an auth prompt", () => {
    // A method-not-found or a transport failure must not send a caller off to
    // authenticate; only -32000 means "present credentials".
    expect(new AcpError(-32000, "Authentication required").isAuthRequired).toBe(true);
    expect(new AcpError(-32601, "method not found").isAuthRequired).toBe(false);
    expect(new AcpError(-32603, "internal error").isAuthRequired).toBe(false);
  });
});
