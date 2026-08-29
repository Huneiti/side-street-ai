/**
 * Which steering controls a viewer may actually use, mirroring the rules the
 * server enforces in `SteeringController` and `SessionActor`.
 *
 * The server stays the authority — nothing here is a security boundary. The
 * point is that the UI should not offer a button whose only outcome is a
 * rejection frame: an Observer shown Send/Interrupt/Take-the-wheel is being
 * lied to about their role.
 */

import { canSteer, canSuggest, type Role } from "@side-street/core";
import type { RosterEntry } from "./derive.js";

export interface Controls {
  /** Submit a message at all — an instruction if driving, a suggestion if not. */
  canSend: boolean;
  /** Cancel the running turn and jump the queue: the wheel-holder alone. */
  canInterrupt: boolean;
  /** Claim a free wheel, or ask for it. */
  canClaimWheel: boolean;
  /** Why the composer is unavailable, or null when it is available. */
  blockedReason: string | null;
}

export function controlsFor(role: Role, isDriver: boolean): Controls {
  if (!canSuggest(role)) {
    return {
      canSend: false,
      canInterrupt: false,
      canClaimWheel: false,
      blockedReason: "Observers are read-only — you can watch, but not steer.",
    };
  }
  // A Driver-role participant who is not holding the wheel is blocked outright
  // rather than demoted to suggestions: `submit` answers them with "not the
  // current driver — take the wheel first".
  const idle = canSteer(role) && !isDriver;
  return {
    canSend: !idle,
    canInterrupt: isDriver,
    canClaimWheel: !isDriver,
    blockedReason: idle ? "Take the wheel to steer." : null,
  };
}

/** Whether the wheel can be handed to this participant right now. */
export function canHandWheelTo(self: string, isDriver: boolean, target: RosterEntry): boolean {
  return isDriver && target.id !== self && canSuggest(target.role);
}
