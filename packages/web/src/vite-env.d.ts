/// <reference types="vite/client" />

/**
 * Build-time configuration. `VITE_SIDE_STREET_SERVER` names the API origin
 * this deployment is allowed to send a session token to — see
 * `lib/session-credential.ts` and issue #56.
 */
interface ImportMetaEnv {
  readonly VITE_SIDE_STREET_SERVER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
