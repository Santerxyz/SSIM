import type SteamUser from 'steam-user';
import type { AccountConfig, MaFile } from './account';
import type { HttpAgent } from '../network/AgentFactory';

// ─── State Machine ─────────────────────────────────────────────────────────────

export enum SessionState {
  DISCONNECTED  = 'DISCONNECTED',
  CONNECTING    = 'CONNECTING',
  LOGGING_IN    = 'LOGGING_IN',
  LOGGED_IN     = 'LOGGED_IN',
  ERROR         = 'ERROR',
  // (Removed the unreachable RATE_LIMITED member — it was declared but never assigned
  //  or read; rate limits are classified 'connection' and surface as ERROR/retry. Every
  //  declared state is now reachable. INV-A7 / A-7.)
}

// ─── Session Data ─────────────────────────────────────────────────────────────

export interface WebSession {
  sessionId:   string;
  cookies:     string[];
  obtainedAt:  Date;
}

export interface ManagedSession {
  account:       AccountConfig;
  client:        SteamUser;
  state:         SessionState;
  /** HTTPS agent for web API calls. Proxy accounts: per-account instance. Local-IP accounts: SHARED pooled https.Agent per bind IP (AgentFactory.localIpPool) — NEVER call destroy() on it directly; all teardown must go through AgentFactory.destroyIfDisposable, which refuses to destroy shared pool members. */
  httpsAgent:    HttpAgent;
  /**
   * The loaded maFile (when available). Carries shared_secret + identity_secret,
   * the latter being required to auto-confirm outgoing trades (Feature 3).
   */
  maFile?:       MaFile;
  steamId?:      string;
  webSession?:   WebSession;
  /** Steam wallet, from steam-user's 'wallet' event. UNIT: steam-user divides the CM protobuf minor-unit balance by 100 unconditionally (components/account.js), so 'balance' is a float in MAJOR units for 2-decimal currencies (12.34 = €12.34). For 0-decimal wallet currencies the effective unit is unverified (B18). Convert to minor units ONLY via knownCurrencyInfo (S64 — unknown codes fail closed on money paths). 'currency' is the numeric ECurrencyCode. */
  wallet?:       { hasWallet: boolean; currency: number; balance: number };
  lastError?:    string;
  loggedInAt?:   Date;
  /** Last time a GENUINE operation used this session (markUsed). Drives the idle-session
   *  reaper (B40): a session untouched for the TTL is logged out to free the resident slot.
   *  Maintenance (the proactive cookie refresh) deliberately does NOT update this. */
  lastActivityAt?: Date;
  /**
   * Handle of the scheduled proactive web-cookie refresh. Owned by
   * SessionManager; MUST be cleared in destroySession, otherwise the timer
   * keeps the dead client + session closure alive for up to 20 minutes.
   */
  cookieRefreshTimer?: NodeJS.Timeout;
  /**
   * In-flight web-session refresh (webLogOn) dedup. The proactive 20-min timer and an
   * ad-hoc refreshWebSession() must not fire two concurrent webLogOn() calls with
   * mismatched 'webSession' listeners — they share this one promise instead (#30).
   */
  webRefreshInFlight?: Promise<void>;
}

// ─── Typed EventEmitter surface ────────────────────────────────────────────────

export interface SessionManagerEvents {
  loggedIn:         (username: string, steamId: string) => void;
  webSession:       (username: string, session: WebSession) => void;
  error:            (username: string, err: Error) => void;
  disconnected:     (username: string, reason: string) => void;
  /** A session was torn down (logout/re-login) – release per-session resources. */
  sessionDestroyed: (username: string) => void;
}
