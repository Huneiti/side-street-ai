import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { roleSchema, type PermissionOutcome, type Role, type SignedEvent } from "@side-street/core";
import { SessionClient, type SessionStatus } from "./lib/session-client.js";
import { joinDefaultsFromUrl, type JoinDefaults } from "./lib/join-url.js";
import {
  WITHHELD_REASON,
  credentialFromHash,
  mayPresentTokenTo,
  stripCredentialFromUrl,
} from "./lib/session-credential.js";
import { SessionView } from "./SessionView.js";

interface JoinDetails {
  baseUrl: string;
  sessionId: string;
  participantId: string;
  role: Role;
  /** Session token, if this viewer has one (ADR-0005). */
  token?: string | undefined;
}

export function App(): ReactElement {
  const [details, setDetails] = useState<JoinDetails | null>(null);
  // Read once, on the way in. The token then lives in memory for the life of
  // the tab and leaves the address bar immediately: not over a shoulder, not
  // in a screenshot of a shared session, not in history for the next person on
  // the machine. It does not un-send the link, and nothing here pretends to.
  const [credential] = useState(() => {
    const found = credentialFromHash(window.location.hash);
    stripCredentialFromUrl(window.location, window.history);
    return found;
  });

  const defaults = joinDefaultsFromUrl(window.location.href);
  return details === null ? (
    <JoinForm
      defaults={
        credential?.sessionId === undefined
          ? defaults
          : { ...defaults, sessionId: credential.sessionId }
      }
      token={credential?.token}
      onJoin={setDetails}
    />
  ) : (
    <Session details={details} onLeave={() => setDetails(null)} />
  );
}

function JoinForm({
  defaults,
  token: linkToken,
  onJoin,
}: {
  defaults: JoinDefaults;
  token?: string | undefined;
  onJoin(details: JoinDetails): void;
}): ReactElement {
  const [baseUrl, setBaseUrl] = useState(defaults.baseUrl);
  const [sessionId, setSessionId] = useState(defaults.sessionId);
  const [participantId, setParticipantId] = useState("");
  const [role, setRole] = useState<Role>(defaults.role);
  // A pasted token is the fallback for anyone who was sent one out of band.
  const [token, setToken] = useState(linkToken ?? "");

  return (
    <main className="join">
      <h1>Side Street</h1>
      <p className="tagline">Drop into a live agent session.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (participantId.trim() === "") return;
          onJoin({
            baseUrl,
            sessionId,
            participantId: participantId.trim(),
            role,
            ...(token.trim() === "" ? {} : { token: token.trim() }),
          });
        }}
      >
        <label>
          Server
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        <label>
          Session
          <input value={sessionId} onChange={(e) => setSessionId(e.target.value)} />
        </label>
        <label>
          Your name
          <input
            value={participantId}
            onChange={(e) => setParticipantId(e.target.value)}
            placeholder="ada"
            autoFocus
          />
        </label>
        <label>
          Session token <span className="hint">optional; verified deployments require one</span>
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="paste if you were sent one"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(roleSchema.parse(e.target.value))}>
            <option value="driver">Driver — steer and approve</option>
            <option value="navigator">Navigator — suggest</option>
            <option value="observer">Observer — watch</option>
          </select>
        </label>
        <button type="submit">Join session</button>
      </form>
    </main>
  );
}

function Session({ details, onLeave }: { details: JoinDetails; onLeave(): void }): ReactElement {
  const [events, setEvents] = useState<SignedEvent[]>([]);
  const [status, setStatus] = useState<SessionStatus>("connecting");
  const [notice, setNotice] = useState<string | null>(null);
  const clientRef = useRef<SessionClient | null>(null);

  // Issue #56: the server is prefillable from a link, so a crafted one could
  // point this app at another host. It may select a server; it may not make us
  // hand a credential to it.
  const present =
    details.token !== undefined && mayPresentTokenTo(details.baseUrl, window.location.origin);

  useEffect(() => {
    if (details.token !== undefined && !present) {
      setNotice(WITHHELD_REASON);
    }
    const client = new SessionClient({
      baseUrl: details.baseUrl,
      sessionId: details.sessionId,
      participantId: details.participantId,
      displayName: details.participantId,
      role: details.role,
      ...(present ? { token: details.token } : {}),
      onEvent: (event) => setEvents((prev) => [...prev, event]),
      onStatus: setStatus,
      onRejection: (_messageId, reason) => setNotice(reason),
      onHandoffRejected: setNotice,
      onError: (error) => setNotice(error.message),
    });
    clientRef.current = client;
    client.connect();
    return () => {
      clientRef.current = null;
      client.close();
    };
  }, [details]);

  // The client retries on its own ladder; these are the two moments the
  // browser knows a retry is worth attempting right now. Timers in a
  // background tab are throttled, so a foregrounded tab can be sitting on a
  // long-expired backoff.
  useEffect(() => {
    const onOnline = (): void => clientRef.current?.resume();
    const onVisible = (): void => {
      if (document.visibilityState === "visible") clientRef.current?.resume();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const steer = useCallback((text: string, delivery: "queue" | "interrupt") => {
    setNotice(null);
    clientRef.current?.steer(text, delivery);
  }, []);
  const handoff = useCallback((toParticipantId: string) => {
    setNotice(null);
    clientRef.current?.takeWheel(toParticipantId);
  }, []);
  const decide = useCallback((requestId: string, outcome: PermissionOutcome) => {
    setNotice(null);
    clientRef.current?.decide(requestId, outcome);
  }, []);
  const exportTranscript = useCallback(() => {
    setNotice(null);
    clientRef.current
      ?.transcript()
      .then((markdown) => download(`side-street-${details.sessionId}.md`, markdown))
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error));
      });
  }, [details.sessionId]);
  const verifySession = useCallback(() => {
    const client = clientRef.current;
    if (client === null) return;
    setNotice("Verifying the stored hash chain…");
    client
      .verify()
      .then((result) => {
        setNotice(
          result.valid
            ? `Hash chain verified (${result.length} events)`
            : `Hash chain failed at event ${result.firstInvalidSeq}: ${result.reason}`,
        );
      })
      .catch((error: unknown) => {
        setNotice(error instanceof Error ? error.message : String(error));
      });
  }, []);

  return (
    <SessionView
      events={events}
      status={status}
      notice={notice}
      self={details.participantId}
      selfRole={details.role}
      onSteer={steer}
      onHandoff={handoff}
      onDecide={decide}
      onVerify={verifySession}
      onExport={exportTranscript}
      onLeave={onLeave}
    />
  );
}

/** Hands the viewer a file. The transcript is built client-side, so there is
 * nothing to fetch it from but an object URL. */
function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
