/**
 * The bridge runner: the process that turns the tested-in-isolation pieces
 * into a live session. It spawns a real ACP agent — Claude Code by default,
 * or any other by name or command — authenticates if that agent asks, opens
 * the session's `/agent` WebSocket, and wires both into AgentBridge. This is
 * what runs inside the sandbox in production and on a dev machine for the
 * Phase 1 exit benchmark.
 */

import { AcpClient, AcpError, type PermissionOutcome } from "@side-street/acp-client";
import { tokenSubprotocols } from "@side-street/core";
import { AgentBridge, type SessionSocket } from "./bridge.js";
import { secretsFromEnv } from "./credentials.js";
import { spawnAgent } from "./stdio.js";
import { fileURLToPath } from "node:url";

/** Ships beside the built runner, so `pnpm dev` needs no credentials. */
const STUB_AGENT = fileURLToPath(new URL("./stub-agent.js", import.meta.url));

/**
 * Boot-env variable carrying this sandbox's agent token. The launcher mints it
 * and injects it; the bridge presents it and never logs it.
 */
export const SESSION_TOKEN_ENV = "SIDE_STREET_SESSION_TOKEN";

/** What the runner tells the session it is. Declared, never verified. */
export interface AgentIdentity {
  agent: string;
  version?: string | undefined;
  sandboxProvider?: string | undefined;
}

/**
 * `http(s)://host/session/:id` → `ws(s)://host/session/:id/agent`, carrying
 * what this bridge is. The session records the declaration so a transcript
 * names the agent that actually ran rather than the one the session expected.
 */
export function agentSocketUrl(sessionUrl: string, identity?: AgentIdentity): string {
  const url = new URL(sessionUrl);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/agent`;
  if (identity !== undefined) {
    url.searchParams.set("agent", identity.agent);
    if (identity.version !== undefined) {
      url.searchParams.set("agentVersion", identity.version);
    }
    if (identity.sandboxProvider !== undefined) {
      url.searchParams.set("sandboxProvider", identity.sandboxProvider);
    }
  }
  return url.toString();
}

/** The structural slice of WebSocket the runner needs (keeps tests socket-free). */
export interface WebSocketLike {
  send(data: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export function sessionSocketFromWebSocket(ws: WebSocketLike): SessionSocket {
  return {
    send(frame): void {
      ws.send(JSON.stringify(frame));
    },
    onFrame(handler): void {
      ws.addEventListener("message", (event) => {
        let frame: unknown = event.data;
        if (typeof event.data === "string") {
          try {
            frame = JSON.parse(event.data);
          } catch {
            // Deliver raw; the bridge's schema layer reports it as malformed.
          }
        }
        handler(frame);
      });
    },
  };
}

/**
 * Backing agents we ship a command for. The interface is the protocol, not
 * this table — any ACP agent works if you pass its command after `--` — but a
 * name nobody has to look up is what makes "swap the agent" a real option
 * rather than a claim (PLAN.md Phase 3: prove agent-agnosticism publicly).
 * ponytail: a flat map, not a plugin registry. It exists to save typing an
 * incantation; if an agent ever needs per-agent wiring, that is the moment for
 * something bigger than a lookup.
 */
export const AGENT_PRESETS = {
  "claude-code": ["npx", "--yes", "@agentclientprotocol/claude-agent-acp"],
  codex: ["npx", "--yes", "@zed-industries/codex-acp"],
  gemini: ["npx", "--yes", "@google/gemini-cli", "--acp"],
  // Not a real agent: canned replies over a real stdio pipe, so the product
  // can be run and demonstrated with no API key. See stub-agent.ts.
  stub: ["node", STUB_AGENT],
} as const satisfies Record<string, readonly string[]>;

export type AgentName = keyof typeof AGENT_PRESETS;

export const DEFAULT_AGENT: AgentName = "claude-code";
export const DEFAULT_SANDBOX_PROVIDER = "local";

export interface RunnerArgs {
  sessionUrl: string;
  workspace: string;
  /** What to call the agent in logs: a preset name, or the command's own name. */
  agent: string;
  command: readonly string[];
  /** Auth method to present before opening a session, if the agent wants one. */
  authMethodId: string | undefined;
  /** Where this bridge says it is running. Declared, never verified. */
  sandboxProvider: string;
}

/**
 * `runner <session-url> <workspace> [--agent <name>] [--auth <methodId>] [--sandbox-provider <name>] [-- <command...>]`
 *
 * A bare trailing command with no `--` is still accepted: that was the
 * original form, and the Phase 1 benchmark runbook uses it.
 */
export function parseArgs(argv: readonly string[]): RunnerArgs | undefined {
  const positional: string[] = [];
  let agent: string | undefined;
  let authMethodId: string | undefined;
  let sandboxProvider = DEFAULT_SANDBOX_PROVIDER;
  let command: readonly string[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      command = argv.slice(i + 1);
      break;
    }
    if (arg === "--agent" || arg === "--auth" || arg === "--sandbox-provider") {
      const value = argv[i + 1];
      if (value === undefined) {
        return undefined;
      }
      if (arg === "--agent") {
        agent = value;
      } else if (arg === "--sandbox-provider") {
        sandboxProvider = value;
      } else {
        authMethodId = value;
      }
      i++;
      continue;
    }
    positional.push(arg);
  }

  const [sessionUrl, workspace, ...rest] = positional;
  if (sessionUrl === undefined || workspace === undefined) {
    return undefined;
  }
  // An explicit command wins over a preset; a preset name is only shorthand
  // for one of these lists, so an unknown name with no command is an error
  // rather than a silent fallback to the default agent.
  const literal = command ?? (rest.length > 0 ? rest : undefined);
  const name = agent ?? DEFAULT_AGENT;
  const preset: readonly string[] | undefined = AGENT_PRESETS[name as AgentName];
  const resolved = literal ?? preset;
  if (resolved === undefined || resolved.length === 0) {
    return undefined;
  }
  return { sessionUrl, workspace, agent: name, command: resolved, authMethodId, sandboxProvider };
}

const USAGE = [
  "Usage: runner <session-url> <workspace-dir> [--agent <name>] [--auth <methodId>] [--sandbox-provider <name>] [-- <command...>]",
  `  agents: ${Object.keys(AGENT_PRESETS).join(", ")} (default: ${DEFAULT_AGENT})`,
  "  e.g. runner http://localhost:8787/session/demo ../sample-repo --agent codex",
].join("\n");

export async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed === undefined) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const { sessionUrl, workspace, authMethodId } = parsed;
  const [command, ...args] = parsed.command;

  const agent = spawnAgent(command as string, args, {
    cwd: workspace,
    shell: process.platform === "win32",
  });
  void agent.exited.then((code) => {
    console.error(`agent process exited (${code ?? "signal"})`);
    process.exit(code ?? 1);
  });

  let bridge: AgentBridge | undefined = undefined;
  const client = new AcpClient(agent.transport, {
    onSessionUpdate(_sessionId, update): void {
      bridge?.onSessionUpdate(update);
    },
    onPermissionRequest(params): Promise<PermissionOutcome> {
      console.error(
        `permission ${params.toolCall.toolCallId} (${params.toolCall.title ?? "untitled"}): awaiting driver`,
      );
      // Route to the Driver through the session; the tool stays blocked until
      // a decision arrives. Before the bridge connects there is no session to
      // ask, so deny — the safe default for a gate.
      return bridge?.requestPermission(params) ?? Promise.resolve({ outcome: "cancelled" });
    },
    onError(error): void {
      console.error(`acp: ${error.message}`);
    },
  });

  const handshake = await client.initialize();
  if (authMethodId !== undefined) {
    await client.authenticate(authMethodId);
  }
  const acpSessionId = await openSession(client, workspace, handshake.authMethods, parsed.agent);
  console.error(`agent ready: ${parsed.agent} (acp session ${acpSessionId})`);

  // The agent's own `agentInfo` when it reports one; otherwise the name the
  // operator asked for, which is at least what they believe they ran.
  const wsUrl = agentSocketUrl(sessionUrl, {
    agent: handshake.agentInfo?.name ?? parsed.agent,
    version: handshake.agentInfo?.version,
    sandboxProvider: parsed.sandboxProvider,
  });
  // The session token this sandbox booted with (ADR-0005). Injected as boot
  // env like every other session-scoped credential, so it inherits the same
  // lifetime and the same declaration to the redaction pass. Absent means the
  // deployment runs unauthenticated, which is what `pnpm dev` does.
  const ws = await openSessionSocket(wsUrl, process.env[SESSION_TOKEN_ENV]);
  ws.addEventListener("close", () => {
    // ponytail: exit on disconnect and rerun; the DO buffers prompts while
    // the bridge is away. In-process reconnect can come with the E2B adapter.
    console.error("session socket closed");
    agent.kill();
    process.exit(1);
  });

  // The credentials this sandbox booted with, declared to the session so the
  // redaction pass strips them from anything the agent echoes.
  const secrets = secretsFromEnv(process.env);
  bridge = new AgentBridge({
    socket: sessionSocketFromWebSocket(ws),
    agent: client,
    acpSessionId,
    secrets,
    onError(error): void {
      console.error(`bridge: ${error.message}`);
    },
  });
  console.error(`declared ${secrets.length} session credential(s) to the redaction pass`);
  console.error(`bridge connected to ${wsUrl}`);
}

/**
 * Opens the ACP session, turning the one failure a new agent actually hits —
 * "this agent has no credentials yet" — into the command that fixes it.
 * Without it, pointing the runner at a second agent for the first time fails
 * with a bare JSON-RPC code and no hint that a login exists.
 */
async function openSession(
  client: AcpClient,
  workspace: string,
  authMethods: readonly { id: string; name: string }[],
  agentName: string,
): Promise<string> {
  try {
    return await client.newSession({ cwd: workspace });
  } catch (error) {
    if (!(error instanceof AcpError) || !error.isAuthRequired) {
      throw error;
    }
    if (authMethods.length === 0) {
      throw new Error(
        `${agentName} wants authentication but advertised no method for it — ` +
          "log in with the agent's own CLI, then rerun",
      );
    }
    throw new Error(
      [
        `${agentName} needs credentials. Rerun with one of:`,
        ...authMethods.map((method) => `  --auth ${method.id}   (${method.name})`),
      ].join("\n"),
    );
  }
}

/**
 * Connects to the session, retrying a refused connection for a few seconds.
 * `pnpm dev` starts the Worker and this process together, and losing that
 * race should not be the difference between a working demo and a stack trace.
 * A socket that opens and later drops is a different matter: the bridge exits
 * and is rerun, so the session sees a clean detach.
 */
async function openSessionSocket(wsUrl: string, token?: string): Promise<WebSocket> {
  const deadline = Date.now() + 15_000;
  const protocols = tokenSubprotocols(token);
  for (let attempt = 0; ; attempt++) {
    const ws = new WebSocket(wsUrl, protocols);
    const opened = await new Promise<boolean>((resolve) => {
      ws.addEventListener("open", () => resolve(true), { once: true });
      ws.addEventListener("error", () => resolve(false), { once: true });
    });
    if (opened) {
      return ws;
    }
    if (Date.now() >= deadline) {
      throw new Error(`cannot connect to ${wsUrl}`);
    }
    if (attempt === 0) {
      console.error(`waiting for ${wsUrl}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
