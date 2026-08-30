/**
 * Structured logging (PLAN.md Phase 3, ops).
 *
 * One JSON object per line on stdout, which is what Workers Logs and
 * `wrangler tail` collect and what any log pipeline can filter and aggregate.
 * No transport, no SDK, no buffering: a Durable Object can be evicted between
 * any two lines, so anything that batches loses exactly the lines that explain
 * why it went away.
 *
 * **Never log content.** Redaction runs on the broadcast and replay paths; a
 * log line takes neither, so message text, tool output, prompts and anything
 * a participant or the agent typed must not appear here. Fields are ids,
 * counts, roles, and reasons this codebase itself wrote. In particular, never
 * log a zod `error.message` — it quotes the offending input back, which is the
 * one place a rejected frame's contents could leak into a log.
 *
 * ponytail: console + JSON, not an SDK. Errors land as `level: "error"` lines
 * for a log-pipeline alert to match; when someone actually wants issue
 * grouping and stack aggregation, an error-tracking SDK slots in behind
 * `LogSink` without touching a call site.
 */

export type LogLevel = "info" | "warn" | "error";

/** Scalars only — the type is the guardrail against logging an object of content. */
export type LogFields = Record<string, string | number | boolean | undefined>;

/** Where lines go. Injectable so tests read them instead of the console. */
export interface LogSink {
  write(line: string): void;
}

const consoleSink: LogSink = {
  write(line) {
    console.log(line);
  },
};

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/**
 * A logger bound to one session. `event` is a dotted name — `session.started`,
 * `agent.attached`, `frame.rejected` — so a dashboard groups by it without
 * parsing prose, and the prose stays out of the line entirely.
 */
export function createLogger(sessionId: string, sink: LogSink = consoleSink): Logger {
  const emit = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    const line: Record<string, unknown> = { ts: Date.now(), level, event, sessionId };
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        line[key] = value;
      }
    }
    sink.write(JSON.stringify(line));
  };
  return {
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}
