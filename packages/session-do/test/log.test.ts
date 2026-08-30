import { describe, expect, it } from "vitest";
import { createLogger, type LogSink } from "../src/log.js";

function collector(): { sink: LogSink; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  return {
    sink: { write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>) },
    lines,
  };
}

describe("structured log lines", () => {
  it("emits one JSON object per line, stamped with level, event and session", () => {
    const { sink, lines } = collector();
    createLogger("sess-1", sink).info("viewer.joined", { participantId: "alice", role: "driver" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info",
      event: "viewer.joined",
      sessionId: "sess-1",
      participantId: "alice",
      role: "driver",
    });
    expect(typeof lines[0]!["ts"]).toBe("number");
  });

  it("drops undefined fields rather than emitting nulls a query has to handle", () => {
    const { sink, lines } = collector();
    createLogger("sess-1", sink).info("agent.attached", { agent: "codex", version: undefined });
    expect(lines[0]).not.toHaveProperty("version");
    expect(lines[0]).toHaveProperty("agent", "codex");
  });

  it("marks errors at a level a log pipeline can alert on", () => {
    const { sink, lines } = collector();
    const log = createLogger("sess-1", sink);
    log.warn("frame.rejected", { from: "agent" });
    log.error("boom", { reason: "unexpected" });
    expect(lines.map((l) => l["level"])).toEqual(["warn", "error"]);
  });

  it("writes valid JSON even when a field carries quotes or newlines", () => {
    const { sink, lines } = collector();
    // Reasons are our own constants, but a line that cannot be parsed would
    // take the whole log pipeline down with it, not just this entry.
    createLogger("sess-1", sink).warn("steer_rejected", { reason: 'not "the" driver\nyet' });
    expect(lines[0]).toHaveProperty("reason", 'not "the" driver\nyet');
  });
});
