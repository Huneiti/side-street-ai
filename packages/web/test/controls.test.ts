import { describe, expect, it } from "vitest";
import { canHandWheelTo, controlsFor } from "../src/lib/controls.js";
import type { RosterEntry } from "../src/lib/derive.js";

const entry = (id: string, role: RosterEntry["role"]): RosterEntry => ({
  id,
  displayName: id,
  role,
});

describe("what the composer offers", () => {
  it("offers an Observer nothing to press", () => {
    expect(controlsFor("observer", false)).toEqual({
      canSend: false,
      canInterrupt: false,
      canClaimWheel: false,
      blockedReason: "Observers are read-only — you can watch, but not steer.",
    });
  });

  it("gives the wheel-holder the full set, whatever role they joined with", () => {
    for (const role of ["driver", "navigator"] as const) {
      expect(controlsFor(role, true)).toEqual({
        canSend: true,
        canInterrupt: true,
        canClaimWheel: false,
        blockedReason: null,
      });
    }
  });

  it("lets a Navigator suggest without the wheel, but never interrupt", () => {
    expect(controlsFor("navigator", false)).toEqual({
      canSend: true,
      canInterrupt: false,
      canClaimWheel: true,
      blockedReason: null,
    });
  });

  it("blocks a Driver-role participant who is not holding the wheel", () => {
    // The server answers them with "not the current driver — take the wheel
    // first", so the composer would only ever produce a rejection.
    expect(controlsFor("driver", false)).toEqual({
      canSend: false,
      canInterrupt: false,
      canClaimWheel: true,
      blockedReason: "Take the wheel to steer.",
    });
  });
});

describe("handing the wheel to a participant", () => {
  it("is offered only by the wheel-holder, and never to an Observer or themselves", () => {
    expect(canHandWheelTo("alice", true, entry("bob", "navigator"))).toBe(true);
    expect(canHandWheelTo("alice", true, entry("dave", "driver"))).toBe(true);
    expect(canHandWheelTo("alice", true, entry("carol", "observer"))).toBe(false);
    expect(canHandWheelTo("alice", true, entry("alice", "driver"))).toBe(false);
    expect(canHandWheelTo("alice", false, entry("bob", "navigator"))).toBe(false);
  });
});
