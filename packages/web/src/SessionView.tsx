import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { PermissionOutcome, Role, SignedEvent } from "@side-street/core";
import { canHandWheelTo, controlsFor } from "./lib/controls.js";
import {
  deriveSession,
  type PendingPermission,
  type RosterEntry,
  type TimelineItem,
} from "./lib/derive.js";
import type { SessionStatus } from "./lib/session-client.js";

export function SessionView({
  events,
  status,
  notice,
  self,
  selfRole,
  onSteer,
  onHandoff,
  onDecide,
  onLeave,
}: {
  events: SignedEvent[];
  status: SessionStatus;
  notice: string | null;
  self: string;
  /** Role we joined with; the roster overrides it once our join replays. */
  selfRole: Role;
  onSteer(text: string, delivery: "queue" | "interrupt"): void;
  onHandoff(toParticipantId: string): void;
  onDecide(requestId: string, outcome: PermissionOutcome): void;
  onLeave(): void;
}): ReactElement {
  const { timeline, roster, driverId, pendingPermissions } = useMemo(
    () => deriveSession(events),
    [events],
  );
  const isDriver = driverId === self;
  const role = roster.find((p) => p.id === self)?.role ?? selfRole;
  const controls = controlsFor(role, isDriver);
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timeline.length]);

  const submit = (delivery: "queue" | "interrupt"): void => {
    const text = draft.trim();
    if (text === "") return;
    onSteer(text, delivery);
    setDraft("");
  };

  return (
    <main className="session">
      <header>
        <div>
          <strong>Side Street</strong>
          <span className={`status status-${status}`}>{status}</span>
        </div>
        <div className="roster">
          {roster.map((p) => (
            <ParticipantChip
              key={p.id}
              participant={p}
              isWheelHolder={p.id === driverId}
              onHandoff={canHandWheelTo(self, isDriver, p) ? onHandoff : undefined}
            />
          ))}
          <button className="ghost" onClick={onLeave}>
            Leave
          </button>
        </div>
      </header>

      <section className="timeline">
        {timeline.map((item) => (
          <TimelineRow key={item.key} item={item} />
        ))}
        <div ref={bottomRef} />
      </section>

      {pendingPermissions.length > 0 && (
        <section className="approvals">
          {pendingPermissions.map((request) => (
            <PermissionPrompt
              key={request.requestId}
              request={request}
              isDriver={isDriver}
              onDecide={onDecide}
            />
          ))}
        </section>
      )}

      {notice !== null && <div className="notice">{notice}</div>}

      <footer>
        {controls.canClaimWheel && (
          <button className="ghost" onClick={() => onHandoff(self)} title="Become the Driver">
            🛞 Take the wheel
          </button>
        )}
        {controls.blockedReason !== null ? (
          <span className="read-only">{controls.blockedReason}</span>
        ) : (
          <>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit("queue");
                }
              }}
              placeholder={isDriver ? "Steer the agent…" : "Suggest to the driver…"}
            />
            <button onClick={() => submit("queue")}>Send</button>
            {controls.canInterrupt && (
              <button
                className="danger"
                onClick={() => submit("interrupt")}
                title="Cancel the running turn and send now"
              >
                Interrupt
              </button>
            )}
          </>
        )}
      </footer>
    </main>
  );
}

function ParticipantChip({
  participant,
  isWheelHolder,
  onHandoff,
}: {
  participant: RosterEntry;
  isWheelHolder: boolean;
  onHandoff?: ((toParticipantId: string) => void) | undefined;
}): ReactElement {
  const label = `${isWheelHolder ? "🛞 " : ""}${participant.displayName}`;
  if (onHandoff === undefined) {
    return (
      <span className={`chip chip-${participant.role}`} title={participant.role}>
        {label}
      </span>
    );
  }
  return (
    <button
      className={`chip chip-${participant.role} chip-handoff`}
      title={`Hand the wheel to ${participant.displayName}`}
      onClick={() => onHandoff(participant.id)}
    >
      {label}
    </button>
  );
}

function TimelineRow({ item }: { item: TimelineItem }): ReactElement {
  switch (item.kind) {
    case "agent_text":
      return <div className="row agent">{item.text}</div>;
    case "human":
      return (
        <div className={`row human ${item.steering ? "human-steering" : "human-suggestion"}`}>
          <span className="author">
            {item.authorId}
            {item.steering ? "" : " (suggestion)"}
            {item.delivery === "interrupt" ? " ⚡" : ""}
          </span>
          {item.text}
        </div>
      );
    case "tool":
      return (
        <div className={`row tool tool-${item.status}`}>
          <span className="tool-status">{toolIcon(item.status)}</span>
          {item.title}
          {item.output !== undefined && <pre>{item.output}</pre>}
        </div>
      );
    case "system":
      return <div className="row system">{item.text}</div>;
  }
}

function PermissionPrompt({
  request,
  isDriver,
  onDecide,
}: {
  request: PendingPermission;
  isDriver: boolean;
  onDecide(requestId: string, outcome: PermissionOutcome): void;
}): ReactElement {
  return (
    <div className="approval">
      <span className="approval-title">🔒 Agent wants to: {request.title}</span>
      {request.priorAttempts > 0 && (
        <span className="approval-repeat">
          ⚠ this session already ran this exact step{" "}
          {request.priorAttempts === 1 ? "once" : `${request.priorAttempts} times`} — approving
          again runs it again
        </span>
      )}
      {isDriver ? (
        <div className="approval-actions">
          {request.options.map((option) => (
            <button
              key={option.optionId}
              className={option.kind?.startsWith("allow") ? "" : "danger"}
              onClick={() =>
                onDecide(request.requestId, { kind: "selected", optionId: option.optionId })
              }
            >
              {option.name}
            </button>
          ))}
          <button
            className="ghost"
            onClick={() => onDecide(request.requestId, { kind: "cancelled" })}
          >
            Deny
          </button>
        </div>
      ) : (
        <span className="approval-wait">awaiting the Driver's decision…</span>
      )}
    </div>
  );
}

function toolIcon(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "⊘";
    default:
      return "…";
  }
}
