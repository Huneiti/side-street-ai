import { describe, expect, it } from "vitest";
import {
  AGENT_PRESETS,
  agentSocketUrl,
  parseArgs,
  sessionSocketFromWebSocket,
  type WebSocketLike,
} from "../src/runner.js";

describe("agentSocketUrl", () => {
  it("maps http session URLs to ws agent URLs", () => {
    expect(agentSocketUrl("http://localhost:8787/session/demo")).toBe(
      "ws://localhost:8787/session/demo/agent",
    );
  });

  it("maps https to wss and tolerates a trailing slash", () => {
    expect(agentSocketUrl("https://example.com/session/demo/")).toBe(
      "wss://example.com/session/demo/agent",
    );
  });
});

class FakeWebSocket implements WebSocketLike {
  readonly sent: string[] = [];
  private listener: ((event: { data: unknown }) => void) | undefined;
  send(data: string): void {
    this.sent.push(data);
  }
  addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listener = listener;
  }
  receive(data: unknown): void {
    this.listener?.({ data });
  }
}

describe("sessionSocketFromWebSocket", () => {
  it("serializes outbound frames and parses inbound ones", () => {
    const ws = new FakeWebSocket();
    const socket = sessionSocketFromWebSocket(ws);
    const frames: unknown[] = [];
    socket.onFrame((frame) => frames.push(frame));

    socket.send({ type: "turn_ended", stopReason: "end_turn" });
    ws.receive('{"type":"cancel"}');

    expect(ws.sent).toEqual(['{"type":"turn_ended","stopReason":"end_turn"}']);
    expect(frames).toEqual([{ type: "cancel" }]);
  });

  it("passes malformed inbound data through for the bridge to reject", () => {
    const ws = new FakeWebSocket();
    const socket = sessionSocketFromWebSocket(ws);
    const frames: unknown[] = [];
    socket.onFrame((frame) => frames.push(frame));

    ws.receive("not json");

    expect(frames).toEqual(["not json"]);
  });
});

describe("parseArgs", () => {
  const base = ["http://localhost:8787/session/demo", "../repo"];

  it("defaults to Claude Code when no agent is named", () => {
    expect(parseArgs(base)).toEqual({
      sessionUrl: base[0],
      workspace: base[1],
      agent: "claude-code",
      command: AGENT_PRESETS["claude-code"],
      authMethodId: undefined,
    });
  });

  it("resolves a preset name to its command", () => {
    expect(parseArgs([...base, "--agent", "gemini"])).toMatchObject({
      agent: "gemini",
      command: ["npx", "--yes", "@google/gemini-cli", "--acp"],
    });
  });

  it("takes an arbitrary agent command after --, preset or not", () => {
    expect(parseArgs([...base, "--", "my-agent", "--stdio"])).toMatchObject({
      command: ["my-agent", "--stdio"],
    });
  });

  it("still accepts a bare trailing command, as the Phase 1 runbook uses", () => {
    expect(parseArgs([...base, "my-agent", "--stdio"])).toMatchObject({
      command: ["my-agent", "--stdio"],
    });
  });

  it("carries the auth method through, and keeps the flags out of the command", () => {
    expect(parseArgs([...base, "--auth", "oauth", "--agent", "codex"])).toMatchObject({
      agent: "codex",
      command: AGENT_PRESETS.codex,
      authMethodId: "oauth",
    });
  });

  it("rejects an unknown agent name rather than silently running the default", () => {
    // Silently falling back would run Claude Code while the operator believes
    // they are testing another agent — the one failure that would make an
    // agent-agnosticism claim untrue.
    expect(parseArgs([...base, "--agent", "not-an-agent"])).toBeUndefined();
  });

  it("rejects a flag with nothing after it, and a missing workspace", () => {
    expect(parseArgs([...base, "--agent"])).toBeUndefined();
    expect(parseArgs(["http://localhost:8787/session/demo"])).toBeUndefined();
  });
});
