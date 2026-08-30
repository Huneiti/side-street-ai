import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  summarizeUsage,
  type PermissionOutcome,
  type Role,
  type SignedEvent,
  type UsageSummary,
} from "@side-street/core";
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
  onVerify,
  onExport,
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
  onVerify(): void;
  onExport(): void;
  onLeave(): void;
}): ReactElement {
  const { timeline, roster, driverId, pendingPermissions } = useMemo(
    () => deriveSession(events),
    [events],
  );
  const usage = useMemo(() => summarizeUsage(events), [events]);
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
          <button className="ghost" onClick={onVerify} title="Verify the stored hash chain">
            Verify log
          </button>
          <button className="ghost" onClick={onExport} title="Download the attributed timeline">
            Export
          </button>
          <button className="ghost" onClick={onLeave}>
            Leave
          </button>
        </div>
      </header>

      <SessionMeter usage={usage} />

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

function SessionMeter({ usage }: { usage: UsageSummary }): ReactElement {
  return (
    <section className="session-meter" aria-label="Session usage">
      <strong>
        {usage.steered ? `Steered by ${usage.steerers.join(", ")}` : "Not steered yet"}
      </strong>
      <span>Active {formatDuration(usage.activeMs)}</span>
      <span>Span {formatDuration(usage.spanMs)}</span>
      <span>{count(usage.humanMessages, "steer")}</span>
      <span>{count(usage.interrupts, "interrupt")}</span>
      <span>{count(usage.handoffs, "handoff")}</span>
      <span>{count(usage.toolCalls, "tool call")}</span>
      <span>
        {usage.approvals.granted} approved · {usage.approvals.denied} denied
      </span>
      <strong className={usage.unresolvedSteps > 0 ? "meter-warning" : undefined}>
        {usage.unresolvedSteps > 0 ? "⚠ " : ""}
        {count(usage.unresolvedSteps, "unresolved step")}
      </strong>
    </section>
  );
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function count(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
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
          {!request.options.some((option) => option.kind?.startsWith("reject")) && (
            <button
              className="ghost"
              onClick={() => onDecide(request.requestId, { kind: "cancelled" })}
            >
              Deny
            </button>
          )}
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
