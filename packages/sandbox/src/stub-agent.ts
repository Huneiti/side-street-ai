/**
 * A stub ACP agent, so the whole product runs with no credentials.
 *
 * Side Street's value is the layer around the agent, and every part of it —
 * streaming, mid-turn steering, hard-interrupt, the approval gate, the
 * attributed log — can be shown without a real model behind it. This speaks
 * enough ACP to drive that: it streams a reply slowly enough to interrupt, it
 * runs a tool, and it asks permission before anything that reads like a side
 * effect, which is what makes the Driver-only gate demonstrable.
 *
 * It is not a mock in the test sense — the tests use `FakeAgent` in-process.
 * This is a real process on a real stdio pipe, so `pnpm dev` exercises the
 * same transport a production agent uses.
 *
 * ponytail: canned replies, no model, no config. It exists so the demo needs
 * no API key; the moment anyone wants it to *do* something, they want a real
 * agent, and `--agent claude-code` is right there.
 */

import { createInterface } from "node:readline";

interface Frame {
  jsonrpc: "2.0";
  id?: string | number | undefined;
  method?: string | undefined;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string } | undefined;
}

/** Slow enough that a human can interrupt mid-turn, fast enough to watch. */
const CHUNK_DELAY_MS = 300;

/** Prompts that read like a side effect get an approval gate, as a real agent would. */
const SIDE_EFFECTING = /\b(deploy|delete|drop|migrate|rollback|restart|revert|rm)\b/i;

const send = (frame: Frame): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let cancelled = false;
let nextRequestId = 1;
const pendingPermissions = new Map<string | number, (allowed: boolean) => void>();

function askPermission(sessionId: string, title: string): Promise<boolean> {
  const id = `perm-${nextRequestId++}`;
  return new Promise((resolve) => {
    pendingPermissions.set(id, resolve);
    send({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall: { toolCallId: `tool-${id}`, title },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });
  });
}

function update(sessionId: string, payload: Record<string, unknown>): void {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: payload } });
}

async function runTurn(id: string | number, params: unknown): Promise<void> {
  const { sessionId, prompt } = params as {
    sessionId: string;
    prompt?: Array<{ text?: string }>;
  };
  const text = (prompt ?? [])
    .map((block) => block.text ?? "")
    .join(" ")
    .trim();
  cancelled = false;

  const words = [
    "Reading",
    "the",
    "repository",
    "and",
    "working",
    "on:",
    text === "" ? "(nothing in particular)" : text,
  ];
  for (const word of words) {
    await sleep(CHUNK_DELAY_MS);
    if (cancelled) {
      send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
      return;
    }
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `${word} ` },
    });
  }

  if (SIDE_EFFECTING.test(text)) {
    const title = `run \`${text.slice(0, 60)}\``;
    const allowed = await askPermission(sessionId, title);
    if (cancelled) {
      send({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
      return;
    }
    const toolCallId = `tool-${nextRequestId}`;
    update(sessionId, { sessionUpdate: "tool_call", toolCallId, title, status: "pending" });
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: allowed ? "completed" : "cancelled",
      content: [
        {
          type: "text",
          text: allowed ? "done (this is a stub — nothing ran)" : "denied by the driver",
        },
      ],
    });
  } else {
    const toolCallId = `tool-read-${nextRequestId++}`;
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "grep -rn TODO .",
      status: "pending",
    });
    await sleep(CHUNK_DELAY_MS);
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      content: [{ type: "text", text: "src/index.ts:12: TODO: this is a stub agent" }],
    });
  }

  send({ jsonrpc: "2.0", id, result: { stopReason: cancelled ? "cancelled" : "end_turn" } });
}

function handle(frame: Frame): void {
  if (frame.method === undefined && frame.id !== undefined) {
    const resolve = pendingPermissions.get(frame.id);
    if (resolve !== undefined) {
      pendingPermissions.delete(frame.id);
      const outcome = (frame.result as { outcome?: { outcome?: string } } | undefined)?.outcome;
      resolve(outcome?.outcome === "selected");
    }
    return;
  }
  switch (frame.method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          // No auth methods: the point of the stub is that nothing is needed.
          authMethods: [],
          agentInfo: { name: "stub", version: "0.0.0" },
        },
      });
      return;
    case "session/new":
      send({ jsonrpc: "2.0", id: frame.id, result: { sessionId: "stub-session" } });
      return;
    case "session/prompt":
      void runTurn(frame.id as string | number, frame.params);
      return;
    case "session/cancel":
      cancelled = true;
      // A pending gate is dead once the turn is cancelled; treat it as denied
      // so nothing waits forever on a decision nobody will make.
      for (const [id, resolve] of pendingPermissions) {
        pendingPermissions.delete(id);
        resolve(false);
      }
      return;
    default:
      if (frame.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32601, message: `method not supported: ${frame.method ?? "?"}` },
        });
      }
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") {
    return;
  }
  try {
    handle(JSON.parse(line) as Frame);
  } catch {
    process.stderr.write(`stub-agent: unparseable frame\n`);
  }
});

process.stderr.write("stub-agent: ready (no credentials needed)\n");
