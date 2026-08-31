import { describe, expect, it, vi } from "vitest";
import { main, transcriptEventsUrl } from "../src/transcript.js";

const event = {
  v: 1 as const,
  seq: 0,
  ts: Date.UTC(2026, 7, 30, 12, 0, 0),
  authorId: "system",
  body: {
    type: "session_started" as const,
    payload: { sessionId: "demo", agent: "stub", sandboxProvider: "local" },
  },
  prevHash: "0".repeat(64),
  hash: "1".repeat(64),
};

describe("transcriptEventsUrl", () => {
  it("requests the complete log from a session URL", () => {
    expect(transcriptEventsUrl("https://side-street.example/session/demo/")).toBe(
      "https://side-street.example/session/demo/events?from=0",
    );
  });

  it("refuses non-http URLs", () => {
    expect(() => transcriptEventsUrl("file:///session/demo")).toThrow("Usage: transcript");
  });
});

describe("transcript main", () => {
  it("fetches from zero and writes the rendered Markdown", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      async json(): Promise<unknown> {
        return { events: [event] };
      },
    }));
    const write = vi.fn();

    await main(["http://localhost:8787/session/demo"], { fetchFn, write });

    expect(fetchFn).toHaveBeenCalledWith("http://localhost:8787/session/demo/events?from=0");
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).toContain("# Side Street session `demo`");
    expect(write.mock.calls[0]?.[0]).toContain("## Timeline");
  });

  it("validates the replay response before rendering it", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      async json(): Promise<unknown> {
        return { events: [{ definitely: "not an event" }] };
      },
    }));

    await expect(main(["http://localhost:8787/session/demo"], { fetchFn })).rejects.toThrow();
  });

  it("reports request failures and invalid arguments", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      async json(): Promise<unknown> {
        return {};
      },
    }));

    await expect(main(["http://localhost:8787/session/missing"], { fetchFn })).rejects.toThrow(
      "transcript request failed (404 Not Found)",
    );
    await expect(main([])).rejects.toThrow("Usage: transcript");
    await expect(main(["one", "two"])).rejects.toThrow("Usage: transcript");
  });
});
