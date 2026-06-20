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
  RATE_LIMITED  = 'RATE_LIMITED',
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
  /** Per-account isolated HTTPS agent (local IP bind or proxy) for web API calls */
  httpsAgent:    HttpAgent;
  /**
   * The loaded maFile (when available). Carries shared_secret + identity_secret,
   * the latter being required to auto-confirm outgoing trades (Feature 3).
   */
  maFile?:       MaFile;
  steamId?:      string;
  webSession?:   WebSession;
  /** Steam wallet balance, captured from the client's 'wallet' event on login. */
  wallet?:       { hasWallet: boolean; currency: number; balance: number };
  loginAttempts: number;
  lastError?:    string;
  connectedAt?:  Date;
  loggedInAt?:   Date;
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
  stateChange:      (username: string, prev: SessionState, next: SessionState) => void;
  loggedIn:         (username: string, steamId: string) => void;
  webSession:       (username: string, session: WebSession) => void;
  error:            (username: string, err: Error) => void;
  disconnected:     (username: string, reason: string) => void;
  /** A session was torn down (logout/re-login) – release per-session resources. */
  sessionDestroyed: (username: string) => void;
}
