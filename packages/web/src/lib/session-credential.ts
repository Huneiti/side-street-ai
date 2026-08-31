/**
 * Getting a session token into the browser, and keeping it from going
 * anywhere else (ADR-0005, issue #56).
 *
 * A token arrives in the URL **fragment**, not the query string:
 *
 *     https://side-street.example/#token=<jwt>&session=incident-4417
 *
 * A fragment is never sent to a server, never lands in an access log, and
 * never appears in a `Referer`. A query parameter does all three, which is the
 * same reason `docs/ops.md` refuses to put credentials in URLs server-side —
 * the rule should not weaken just because this end is a browser.
 *
 * It is still a credential in a link. That is the honest ceiling of the
 * symmetric mode: link-sharing, short-lived, no accounts (ADR-0005). What this
 * module can do is stop the link outliving its use and stop the token being
 * sent anywhere the deployment did not nominate.
 */

/** Where the app is allowed to send a token, beyond its own origin. */
const CONFIGURED_SERVER: string | undefined = import.meta.env.VITE_SIDE_STREET_SERVER;

export interface Credential {
  token: string;
  /** Anything else the link carried, so one link can seed the whole join. */
  sessionId?: string | undefined;
}

/**
 * Reads a credential out of a URL fragment. Returns undefined for the ordinary
 * case of a page opened without one.
 */
export function credentialFromHash(hash: string): Credential | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("token")?.trim();
  if (token === undefined || token === "") {
    return undefined;
  }
  const sessionId = params.get("session")?.trim();
  return { token, ...(sessionId === undefined || sessionId === "" ? {} : { sessionId }) };
}

/**
 * Takes the credential out of the address bar once it has been read.
 *
 * The token stays in memory for the life of the tab; the URL stops carrying
 * it, so it is not in the address bar over someone's shoulder, not in a
 * screenshot of a shared session, and not left in history for the next person
 * on the machine. It does not un-send the link, and nothing here pretends it
 * does.
 */
export function stripCredentialFromUrl(location: Location, history: History): void {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  if (!params.has("token")) {
    return;
  }
  params.delete("token");
  const rest = params.toString();
  history.replaceState(
    null,
    "",
    `${location.pathname}${location.search}${rest === "" ? "" : `#${rest}`}`,
  );
}

/**
 * Whether a token may be sent to this server.
 *
 * The join form's server is prefillable from a link (`?server=`), so without
 * this a crafted link would point the app at an attacker's host and the token
 * would follow — issue #56. A token therefore goes only to the page's own
 * origin, or to one the deployment nominated at build time through
 * `VITE_SIDE_STREET_SERVER`.
 *
 * A link may still *select* a server; it just cannot make this app hand a
 * credential to it. The connection then fails as unauthenticated, which is the
 * correct direction to fail in.
 */
export function mayPresentTokenTo(baseUrl: string, pageOrigin: string): boolean {
  let target: string;
  try {
    target = new URL(baseUrl).origin;
  } catch {
    return false;
  }
  if (target === pageOrigin) {
    return true;
  }
  if (CONFIGURED_SERVER === undefined || CONFIGURED_SERVER === "") {
    return false;
  }
  try {
    return target === new URL(CONFIGURED_SERVER).origin;
  } catch {
    return false;
  }
}

/** Why a token was withheld, for the notice line. */
export const WITHHELD_REASON =
  "Not sending your token: this server is not the one this app was configured for.";
