/**
 * Issues session tokens (ADR-0005) for a self-hosted deployment.
 *
 * The Worker verifies tokens; something has to make them. For the symmetric
 * mode that is this: an operator holding `SIDE_STREET_TOKEN_SECRET` mints a
 * short-lived grant and hands out the result. There are no accounts — who is
 * entitled to a token is the operator's judgement, exercised by choosing to
 * run this. That is the honest ceiling of link-sharing, and the ADR says so.
 *
 * It lives beside the bridge runner because the two are the same job seen from
 * both ends: the runner *presents* an agent token, this *issues* one. The
 * hosted control plane replaces this with an SSO issuer publishing a JWKS, and
 * nothing else changes.
 *
 * ponytail: prints a token, not a URL. Where it goes in a link is the web
 * app's business and it is not settled yet (see the `?server=` question in
 * issue #56); a CLI that guesses at that would have to be un-guessed later.
 */

import { DEFAULT_TOKEN_TTL_SECONDS, mintSessionToken, roleSchema } from "@side-street/core";
import type { Role, TokenAudience } from "@side-street/core";

export const SECRET_ENV = "SIDE_STREET_TOKEN_SECRET";

export interface MintArgs {
  sessionId: string;
  participantId: string;
  audience: TokenAudience;
  displayName?: string | undefined;
  role?: Role | undefined;
  ttlSeconds?: number | undefined;
}

export const USAGE = [
  "Usage: mint-token --session <id> --participant <id> [options]",
  "",
  "  --role <driver|navigator|observer>   required for a viewer token",
  "  --audience <viewer|agent>            default: viewer",
  "  --name <display name>                default: the participant id",
  `  --ttl <seconds>                      default: ${DEFAULT_TOKEN_TTL_SECONDS}`,
  "",
  `Reads the signing secret from ${SECRET_ENV}.`,
].join("\n");

/**
 * Parses argv, or returns why it could not. A viewer token without a role is
 * rejected here as well as at the verifier: minting one would produce a
 * credential that can never open anything, and finding that out at connect
 * time is a worse place to learn it.
 */
export function parseMintArgs(argv: readonly string[]): MintArgs | { error: string } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !flag.startsWith("--")) {
      return { error: `unexpected argument: ${String(flag)}` };
    }
    if (value === undefined) {
      return { error: `${flag} needs a value` };
    }
    flags.set(flag.slice(2), value);
  }

  const sessionId = flags.get("session");
  const participantId = flags.get("participant");
  if (sessionId === undefined || participantId === undefined) {
    return { error: "--session and --participant are required" };
  }

  const audience = flags.get("audience") ?? "viewer";
  if (audience !== "viewer" && audience !== "agent") {
    return { error: `--audience must be viewer or agent, not ${audience}` };
  }

  let role: Role | undefined;
  const rawRole = flags.get("role");
  if (rawRole !== undefined) {
    const parsed = roleSchema.safeParse(rawRole);
    if (!parsed.success) {
      return { error: `--role must be driver, navigator or observer, not ${rawRole}` };
    }
    role = parsed.data;
  }
  if (audience === "viewer" && role === undefined) {
    return { error: "a viewer token needs --role" };
  }

  let ttlSeconds: number | undefined;
  const rawTtl = flags.get("ttl");
  if (rawTtl !== undefined) {
    ttlSeconds = Number(rawTtl);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      return { error: `--ttl must be a positive whole number of seconds, not ${rawTtl}` };
    }
  }

  return {
    sessionId,
    participantId,
    audience,
    ...(flags.get("name") === undefined ? {} : { displayName: flags.get("name") }),
    ...(role === undefined ? {} : { role }),
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
  };
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  const args = parseMintArgs(argv);
  if ("error" in args) {
    console.error(`${args.error}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  const secret = env[SECRET_ENV];
  if (secret === undefined || secret === "") {
    // Refusing beats minting against an empty secret: a token signed with ""
    // verifies against a Worker configured the same way, which is a deployment
    // that believes it is secured and is not.
    console.error(`${SECRET_ENV} is not set. Nothing to sign with.\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  // The token goes to stdout alone so it can be piped; everything else is
  // stderr, so `mint-token … > token.txt` produces a file with a token in it.
  console.error(
    `${args.audience} token for ${args.participantId}` +
      `${args.role === undefined ? "" : ` as ${args.role}`} in session ${args.sessionId}, ` +
      `valid ${args.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS}s`,
  );
  console.log(await mintSessionToken(args, secret));
}
