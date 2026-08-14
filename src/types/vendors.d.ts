// ─── node-machine-id (matches the package's own signature) ───────────────────

declare module 'node-machine-id' {
  /** Synchronous OS machine GUID. original=true → raw (not app-hashed). */
  export function machineIdSync(original?: boolean): string;
  /** Async variant. */
  export function machineId(original?: boolean): Promise<string>;
}

// ─── steam-totp (no bundled types) ───────────────────────────────────────────

declare module 'steam-totp' {
  /**
   * Generates a TOTP auth code for Steam from a base64-encoded shared_secret.
   * @param secret   The shared_secret from the .maFile (base64 or Buffer)
   * @param timeOffset  Offset in seconds to apply to the current time (default 0)
   */
  export function generateAuthCode(
    secret:     string | Buffer,
    timeOffset?: number,
  ): string;

  /** Alias of generateAuthCode – the 5-char Steam Guard TOTP from the shared_secret. */
  export function getAuthCode(
    secret:     string | Buffer,
    timeOffset?: number,
  ): string;

  /** Calls back with the local↔Steam clock OFFSET in seconds (add to local time via time(offset)); the
   *  third arg is the QueryTime round-trip latency in ms. NOTE: patched process-wide by
   * installSteamTotpTimeout to bound the raw QueryTime request. */
  export function getTimeOffset(
    callback: (err: Error | null, offset: number, latency?: number) => void,
  ): void;

  /** Generates a base64 confirmation key for the mobile-confirmation endpoints. */
  export function getConfirmationKey(
    identitySecret: string | Buffer,
    time:           number,
    tag:            string,
  ): string;

  /** Current LOCAL unix time (seconds) plus timeOffset. Pass the offset from getTimeOffset to obtain Steam-server-aligned time for getConfirmationKey. */
  export function time(timeOffset?: number): number;
}

// ─── request (legacy http client used internally by steamcommunity) ───────────

declare module 'request' {
  interface RequestApi {
    (...args: unknown[]): unknown;
    defaults(options: Record<string, unknown>): RequestApi;
    jar(): unknown;
    cookie(str: string): unknown;
  }
  const request: RequestApi;
  export = request;
}

// ─── steamcommunity (no bundled types) ────────────────────────────────────────

declare module 'steamcommunity' {
  import { EventEmitter } from 'events';

  interface SteamCommunityOptions {
    request?:      unknown;       // a `request` instance (used to inject our per-account agent)
    timeout?:      number;
    userAgent?:    string;
    localAddress?: string;
  }

  class SteamCommunity extends EventEmitter {
    constructor(options?: SteamCommunityOptions);

    steamID: { getSteamID64(): string } | null;
    request: { defaults(opts: Record<string, unknown>): unknown };

    setCookies(cookies: string[]): void;

    /** Resolves the logged-in account's own trade URL (and raw token). */
    getTradeURL(callback: (err: Error | null, url: string, token: string) => void): void;

    /** Auto-confirms a pending mobile confirmation for the given object id. */
    acceptConfirmationForObject(
      identitySecret: string | Buffer,
      objectID:       string,
      callback:       (err: Error | null) => void,
    ): void;

    [key: string]: unknown;
  }

  export = SteamCommunity;
}

// ─── steam-tradeoffer-manager (no bundled types) ──────────────────────────────

declare module 'steam-tradeoffer-manager' {
  import { EventEmitter } from 'events';
  import SteamUser from 'steam-user';
  import SteamCommunity from 'steamcommunity';

  interface TradeOfferManagerOptions {
    steam?:         SteamUser;
    community?:     SteamCommunity;
    domain?:        string;
    language?:      string;
    pollInterval?:  number;
    cancelTime?:    number;
    dataDirectory?: string | null;
    [key: string]: unknown;
  }

  interface SteamID {
    getSteamID64(): string;
  }

  /** A single inventory item / asset as understood by the manager. */
  interface EconItem {
    assetid:     string;
    appid:       number;
    contextid:   string;
    amount?:     number;
    market_hash_name?: string;
    /** Post-trade asset id in the RECEIVER's inventory (GetTradeStatus only). */
    new_assetid?: string;
    [key: string]: unknown;
  }

  class TradeOffer {
    id:              string;
    partner:         SteamID;
    state:           number;
    isOurOffer:      boolean;
    itemsToGive:     EconItem[];
    itemsToReceive:  EconItem[];
    message:         string;
    /** Set once the offer was accepted (links the offer to its trade record). */
    tradeID:         string | null;
    created:         Date | null;
    updated:         Date | null;

    addMyItem(item: Partial<EconItem>): boolean;
    addMyItems(items: Array<Partial<EconItem>>): number;
    addTheirItem(item: Partial<EconItem>): boolean;
    addTheirItems(items: Array<Partial<EconItem>>): number;
    setMessage(message: string): void;

    /** status is 'pending' (needs mobile confirmation) or 'sent'. */
    send(callback: (err: Error | null, status: 'pending' | 'sent') => void): void;
    /**
     * Resolves the underlying trade (IEconService/GetTradeStatus): exact init
     * time + the received/sent assets including their post-trade `new_assetid`.
     */
    getExchangeDetails(
      callback: (err: Error | null, status: number, tradeInitTime: Date,
                 receivedItems: EconItem[], sentItems: EconItem[]) => void,
    ): void;
    getExchangeDetails(
      getDetailsIfFailed: boolean,
      callback: (err: Error | null, status: number, tradeInitTime: Date,
                 receivedItems: EconItem[], sentItems: EconItem[]) => void,
    ): void;
    accept(callback: (err: Error | null, status: string) => void): void;
    accept(skipStateUpdate: boolean, callback: (err: Error | null, status: string) => void): void;
    decline(callback: (err: Error | null) => void): void;
    cancel(callback: (err: Error | null) => void): void;

    [key: string]: unknown;
  }

  class TradeOfferManager extends EventEmitter {
    constructor(options?: TradeOfferManagerOptions);

    steamID: SteamID | null;

    setCookies(cookies: string[], callback?: (err: Error | null) => void): void;
    /** partner is a SteamID64 or a full trade URL. */
    createOffer(partner: string, token?: string): TradeOffer;
    getOffer(id: string, callback: (err: Error | null, offer: TradeOffer) => void): void;
    /** filter is a TradeOfferManager.EOfferFilter value (ActiveOnly/HistoricalOnly/All). */
    getOffers(
      filter: number,
      callback: (err: Error | null, sent: TradeOffer[], received: TradeOffer[]) => void,
    ): void;
    getOffers(
      filter: number,
      historicalCutoff: Date,
      callback: (err: Error | null, sent: TradeOffer[], received: TradeOffer[]) => void,
    ): void;
    getInventoryContents(
      appid: number, contextid: number, tradableOnly: boolean,
      callback: (err: Error | null, inventory: EconItem[]) => void,
    ): void;
    shutdown(): void;

    on(event: 'newOffer', listener: (offer: TradeOffer) => void): this;
    on(event: 'sentOfferChanged', listener: (offer: TradeOffer, oldState: number) => void): this;
    on(event: 'receivedOfferChanged', listener: (offer: TradeOffer, oldState: number) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;

    static ETradeOfferState: Record<string, number | string>;
    static EOfferFilter:     Record<string, number>;
    static ETradeStatus:     Record<string, number>;
  }

  export = TradeOfferManager;
}

// ─── steam-user (no bundled types) ───────────────────────────────────────────

declare module 'steam-user' {
  import { EventEmitter } from 'events';

  interface SteamID {
    getSteamID64(): string;
    getSteamID3(): string;
    accountid: number;
    universe: number;
    type: number;
    instance: number;
  }

  interface SteamUserOptions {
    dataDirectory?:     string | null;
    autoRelogin?:       boolean;
    singleSentryfile?:  boolean;
    enablePicsCache?:   boolean;
    httpProxy?:         string;
    localAddress?:      string;
    protocol?:          number;
    // Add more as needed
    [key: string]:      unknown;
  }

  interface LogOnDetails {
    accountName?:      string;
    password?:         string;
    twoFactorCode?:    string;
    rememberPassword?: boolean;
    loginKey?:         string;
    /** Auth-v2 refresh token – logs in without password/2FA, survives restarts. */
    refreshToken?:     string;
    [key: string]:     unknown;
  }

  class SteamUser extends EventEmitter {
    steamID: SteamID | null;

    constructor(options?: SteamUserOptions);

    logOn(details: LogOnDetails): void;
    logOff(): void;
    webLogOn(): void;
    /** Sets the games this account is "playing" (appids). [] = stop playing.
     *  Required to establish a CS2 Game Coordinator session (gamesPlayed([730])). */
    gamesPlayed(apps: number[] | number | string | string[]): void;

    // Typed event overloads
    on(event: 'loggedOn',    listener: (details: { client_supplied_steamid?: string }) => void): this;
    on(event: 'error',       listener: (err: Error & { eresult?: number }) => void): this;
    on(event: 'webSession',  listener: (sessionId: string, cookies: string[]) => void): this;
    on(event: 'steamGuard',  listener: (domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) => void): this;
    on(event: 'disconnected',listener: (eresult: number, msg?: string) => void): this;
    on(event: 'refreshToken',listener: (token: string) => void): this;
    on(event: 'wallet',      listener: (hasWallet: boolean, currency: number, balance: number) => void): this;
    on(event: string,        listener: (...args: unknown[]) => void): this;

    once(event: 'loggedOn',   listener: (details: { client_supplied_steamid?: string }) => void): this;
    once(event: 'error',      listener: (err: Error & { eresult?: number }) => void): this;
    once(event: 'webSession', listener: (sessionId: string, cookies: string[]) => void): this;
    once(event: string,       listener: (...args: unknown[]) => void): this;

    removeListener(event: 'webSession', listener: (sessionId: string, cookies: string[]) => void): this;
    removeListener(event: string, listener: (...args: unknown[]) => void): this;
  }

  export = SteamUser;
}
