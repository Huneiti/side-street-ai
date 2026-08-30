import { describe, expect, it } from "vitest";
import { joinDefaultsFromUrl } from "../src/lib/join-url.js";

describe("join form URL defaults", () => {
  it("keeps the local demo defaults for an ordinary app URL", () => {
    expect(joinDefaultsFromUrl("http://localhost:5173")).toEqual({
      baseUrl: "http://localhost:8787",
      sessionId: "demo",
      role: "observer",
    });
  });

  it("reads a session, server, and role from query parameters", () => {
    expect(
      joinDefaultsFromUrl(
        "https://side-street.example/?session=sentry-4417&server=https%3A%2F%2Fapi.example&role=navigator",
      ),
    ).toEqual({
      baseUrl: "https://api.example",
      sessionId: "sentry-4417",
      role: "navigator",
    });
  });

  it("reads and decodes a session from a /session/:id path", () => {
    expect(joinDefaultsFromUrl("https://side-street.example/session/incident%2042").sessionId).toBe(
      "incident 42",
    );
  });

  it("lets an explicit query session override the path", () => {
    expect(
      joinDefaultsFromUrl("https://side-street.example/session/from-path?session=from-query")
        .sessionId,
    ).toBe("from-query");
  });

  it("falls back safely for empty values and an unknown role", () => {
    expect(
      joinDefaultsFromUrl("https://side-street.example/?session=&server=%20&role=admin"),
    ).toEqual({
      baseUrl: "http://localhost:8787",
      sessionId: "demo",
      role: "observer",
    });
  });
});
