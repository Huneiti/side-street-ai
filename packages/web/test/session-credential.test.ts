/**
 * Getting a token into the browser without letting it leave for somewhere it
 * should not go (ADR-0005, issue #56).
 */

import { describe, expect, it } from "vitest";
import {
  credentialFromHash,
  mayPresentTokenTo,
  stripCredentialFromUrl,
} from "../src/lib/session-credential.js";

describe("reading a credential from a link", () => {
  it("takes the token and the session the link carried", () => {
    expect(credentialFromHash("#token=abc.def.ghi&session=incident-4417")).toEqual({
      token: "abc.def.ghi",
      sessionId: "incident-4417",
    });
  });

  it("works without the leading hash and without a session", () => {
    expect(credentialFromHash("token=abc.def.ghi")).toEqual({ token: "abc.def.ghi" });
  });

  it("finds nothing in an ordinary URL", () => {
    for (const hash of ["", "#", "#section-2", "#token=", "#token=%20"]) {
      expect(credentialFromHash(hash)).toBeUndefined();
    }
  });
});

describe("taking the credential out of the address bar", () => {
  function fakeUrl(hash: string): { location: Location; history: History; replaced: string[] } {
    const replaced: string[] = [];
    return {
      location: { hash, pathname: "/", search: "" } as Location,
      history: {
        replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url),
      } as unknown as History,
      replaced,
    };
  }

  it("removes the token and keeps everything else", () => {
    const { location, history, replaced } = fakeUrl("#token=abc.def.ghi&session=incident-4417");
    stripCredentialFromUrl(location, history);
    expect(replaced).toEqual(["/#session=incident-4417"]);
  });

  it("leaves no empty fragment behind when the token was all there was", () => {
    const { location, history, replaced } = fakeUrl("#token=abc.def.ghi");
    stripCredentialFromUrl(location, history);
    expect(replaced).toEqual(["/"]);
  });

  it("does not touch a URL that carries no token", () => {
    const { location, history, replaced } = fakeUrl("#section-2");
    stripCredentialFromUrl(location, history);
    expect(replaced).toEqual([]);
  });
});

describe("where a token may be sent", () => {
  const page = "https://side-street.example";

  it("allows the page's own origin", () => {
    expect(mayPresentTokenTo("https://side-street.example", page)).toBe(true);
    expect(mayPresentTokenTo("https://side-street.example/session/x", page)).toBe(true);
  });

  it("refuses a server a link chose", () => {
    // Issue #56: `?server=` prefills the join form, so without this a crafted
    // link would point the app at an attacker's host and the token follows.
    expect(mayPresentTokenTo("https://evil.example", page)).toBe(false);
    expect(mayPresentTokenTo("http://side-street.example", page)).toBe(false);
    expect(mayPresentTokenTo("https://side-street.example.evil.test", page)).toBe(false);
  });

  it("refuses anything that is not a URL rather than guessing", () => {
    for (const bad of ["", "not a url", "//evil.example", "javascript:alert(1)"]) {
      expect(mayPresentTokenTo(bad, page)).toBe(false);
    }
  });

  it("refuses a cross-origin server when the build nominated none", () => {
    // VITE_SIDE_STREET_SERVER is unset under test, which is the default for a
    // deployment that has not opted in to a separate API origin.
    expect(mayPresentTokenTo("http://localhost:8787", "http://localhost:5173")).toBe(false);
  });
});
