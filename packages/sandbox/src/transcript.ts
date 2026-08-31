/** Terminal entry point for the same Observer-redacted transcript the web UI exports. */

import { replayResponseSchema, toMarkdown } from "@side-street/core";

interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}

export interface TranscriptDependencies {
  fetchFn?(url: string): Promise<FetchResponse>;
  write?(markdown: string): void;
}

const USAGE = [
  "Usage: transcript <session-url>",
  "  e.g. transcript http://localhost:8787/session/demo > postmortem.md",
].join("\n");

/** Build the full-log endpoint. The server always applies Observer-floor redaction. */
export function transcriptEventsUrl(sessionUrl: string): string {
  let url: URL;
  try {
    url = new URL(sessionUrl);
  } catch {
    throw new Error(USAGE);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(USAGE);
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/events`;
  url.search = "";
  url.searchParams.set("from", "0");
  url.hash = "";
  return url.toString();
}

/** Fetch a session's complete redacted log and print its Markdown transcript. */
export async function main(
  argv: readonly string[],
  dependencies: TranscriptDependencies = {},
): Promise<void> {
  if (argv.length !== 1) {
    throw new Error(USAGE);
  }

  const eventsUrl = transcriptEventsUrl(argv[0] as string);
  const fetchFn = dependencies.fetchFn ?? ((url: string) => fetch(url));
  const response = await fetchFn(eventsUrl);
  if (!response.ok) {
    const status = [response.status, response.statusText].filter(Boolean).join(" ");
    throw new Error(`transcript request failed${status === "" ? "" : ` (${status})`}`);
  }

  const replay = replayResponseSchema.parse(await response.json());
  const write =
    dependencies.write ??
    ((markdown: string): void => {
      process.stdout.write(markdown);
    });
  write(toMarkdown(replay.events));
}
