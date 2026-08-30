/**
 * The stub agent as a real process on a real stdio pipe, driven by the real
 * ACP client. `FakeAgent` covers protocol logic in-process; this covers the
 * thing `pnpm dev` actually spawns, including the transport between them.
 */

import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AcpClient, type PermissionOutcome, type SessionUpdate } from "@side-street/acp-client";
import { spawnAgent, type AgentProcess } from "../src/stdio.js";

const STUB = fileURLToPath(new URL("../dist/stub-agent.js", import.meta.url));

let running: AgentProcess | undefined;
afterEach(() => {
  running?.kill();
  running = undefined;
});

function start(decide: () => Promise<PermissionOutcome>): {
  client: AcpClient;
  updates: SessionUpdate[];
  permissions: string[];
} {
  const agent = spawnAgent(process.execPath, [STUB]);
  running = agent;
  const updates: SessionUpdate[] = [];
  const permissions: string[] = [];
  const client = new AcpClient(agent.transport, {
    onSessionUpdate: (_sessionId, update) => updates.push(update),
    onPermissionRequest: (params) => {
      permissions.push(params.toolCall.title ?? "");
      return decide();
    },
  });
  return { client, updates, permissions };
}

const never = (): Promise<PermissionOutcome> => Promise.reject(new Error("unexpected"));

describe("the stub agent", () => {
  it("completes the handshake without any credential", async () => {
    const { client } = start(never);
    const handshake = await client.initialize();
    expect(handshake.protocolVersion).toBe(1);
    expect(handshake.authMethods).toEqual([]);
    expect(handshake.agentInfo).toMatchObject({ name: "stub" });
    expect(await client.newSession({ cwd: "." })).toBe("stub-session");
  });

  it("streams a turn and runs a read-only tool", async () => {
    const { client, updates } = start(never);
    await client.initialize();
    const sessionId = await client.newSession({ cwd: "." });
    const stopReason = await client.prompt(sessionId, [{ type: "text", text: "find the bug" }]);

    expect(stopReason).toBe("end_turn");
    const kinds = updates.map((u) => u.sessionUpdate);
    expect(kinds.filter((k) => k === "agent_message_chunk").length).toBeGreaterThan(1);
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_call_update");
  }, 15_000);

  it("asks permission before anything that reads like a side effect", async () => {
    const { client, permissions, updates } = start(() =>
      Promise.resolve({ outcome: "selected", optionId: "allow" }),
    );
    await client.initialize();
    const sessionId = await client.newSession({ cwd: "." });
    await client.prompt(sessionId, [{ type: "text", text: "deploy the fix" }]);

    // This is what makes the Driver-only gate demonstrable with no API key.
    expect(permissions).toHaveLength(1);
    expect(permissions[0]).toContain("deploy the fix");
    const final = updates.filter((u) => u.sessionUpdate === "tool_call_update");
    expect(final.at(-1)).toMatchObject({ status: "completed" });
  }, 15_000);

  it("does not run the tool when the driver denies", async () => {
    const { client, updates } = start(() => Promise.resolve({ outcome: "cancelled" }));
    await client.initialize();
    const sessionId = await client.newSession({ cwd: "." });
    await client.prompt(sessionId, [{ type: "text", text: "delete the branch" }]);
    const final = updates.filter((u) => u.sessionUpdate === "tool_call_update");
    expect(final.at(-1)).toMatchObject({ status: "cancelled" });
  }, 15_000);

  it("ends the turn as cancelled when interrupted mid-stream", async () => {
    const { client } = start(never);
    await client.initialize();
    const sessionId = await client.newSession({ cwd: "." });
    const turn = client.prompt(sessionId, [{ type: "text", text: "a long investigation" }]);
    // Chunks are paced so a human can interrupt; so can a test.
    await new Promise((resolve) => setTimeout(resolve, 500));
    client.cancel(sessionId);
    expect(await turn).toBe("cancelled");
  }, 15_000);
});
