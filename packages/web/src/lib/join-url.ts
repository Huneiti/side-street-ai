import { roleSchema, type Role } from "@side-street/core";

export interface JoinDefaults {
  baseUrl: string;
  sessionId: string;
  role: Role;
}

const defaults: JoinDefaults = {
  baseUrl: "http://localhost:8787",
  sessionId: "demo",
  role: "observer",
};

/**
 * Prefills the join form from a shareable session URL.
 *
 * Query parameters take precedence over the `/session/:id` path form so a
 * caller can link to a room without depending on how the web app is hosted.
 * Invalid or empty values fall back to the ordinary local-demo defaults.
 */
export function joinDefaultsFromUrl(input: string | URL): JoinDefaults {
  const url = typeof input === "string" ? new URL(input) : input;
  const role = roleSchema.safeParse(nonEmpty(url.searchParams.get("role")));

  return {
    baseUrl: nonEmpty(url.searchParams.get("server")) ?? defaults.baseUrl,
    sessionId:
      nonEmpty(url.searchParams.get("session")) ??
      sessionFromPath(url.pathname) ??
      defaults.sessionId,
    role: role.success ? role.data : defaults.role,
  };
}

function sessionFromPath(pathname: string): string | undefined {
  const match = /^\/session\/([^/]+)\/?$/.exec(pathname);
  if (match?.[1] === undefined) return undefined;

  try {
    return nonEmpty(decodeURIComponent(match[1]));
  } catch {
    return undefined;
  }
}

function nonEmpty(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
