/**
 * DOKUMENTE-01 R1 — Bindung eines Synchronisationslaufs an seine Ursprungsidentität.
 *
 * WEISS-Befund (Endrecheck N1/N2, R1): Ein Lauf las beim Start Bestand und
 * Warteschlange eines Kontos und schickte die Aufträge nacheinander ab. Jede
 * Sendung holte den Zugang neu aus der aktuellen Sitzung. Meldete sich
 * dazwischen ein anderes Konto an (etwa in einem zweiten Tab), gingen die
 * restlichen Aufträge des ersten Kontos unter dem Zugang des zweiten hinaus.
 *
 * Jetzt hält jeder Lauf beim Start fest, wem er gehört:
 *   - den Speicherbereich (Betrieb, Konto, Sicht) und
 *   - die Anmeldung (Konto): aus der Sitzung des Clients oder, bei eigenem
 *     Token-Lieferanten, aus dessen Token.
 *
 * Unmittelbar vor jeder einzelnen Anfrage — auch nach asynchronen
 * Zwischenschritten wie dem Lesen von Dateibytes oder einem vorangehenden
 * Teilschritt — prüft der gebundene Client, dass beides unverändert ist. Erst
 * danach entsteht die Anfrage überhaupt. Sie trägt den Zugang, den genau diese
 * Prüfung für das Ursprungskonto gelesen hat, nie einen später gelesenen; und
 * am tatsächlichen Netzaufruf blickt der Lauf ohne weiteres Warten ein letztes
 * Mal auf den Speicherbereich. Stellt der Lauf einen Wechsel fest, sendet er
 * nichts mehr; offene Aufträge bleiben unverändert beim Ursprungskonto.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getActiveStorageAccount,
  getActiveStorageKey,
  getActiveStorageScope,
  type StorageAccess,
} from '../storage/storageScopeService';

export interface SyncRunIdentity {
  /** Aktiver Speicherbereich beim Start (Betrieb, Konto, Sicht). */
  readonly storageKey: string;
  /** Betrieb, an den der Lauf sendet (Serverkennung). */
  readonly workspaceId: string;
  /** Betrieb des Speicherbereichs; `null` außerhalb eines Betriebsbereichs. */
  readonly scopeWorkspaceId: string | null;
  /** Konto und Sicht des Speicherbereichs; `null` ohne Kontobereich (Altbestand, Testgerüste). */
  readonly accountUserId: string | null;
  readonly access: StorageAccess | null;
  /**
   * Konto der Anmeldung beim Start: aus der Sitzung, bei eigenem Token-Lieferanten aus dem Token (oder dessen
   * Fingerabdruck, wenn es kein Konto nennt); `undefined`, wenn nichts davon lesbar war.
   */
  readonly sessionUserId: string | null | undefined;
  /** Bereich und Sitzung passten schon beim Start zusammen; sonst sendet der Lauf nichts. */
  readonly consistent: boolean;
  /**
   * Warum der Start nicht zusammenpasste: `start_unbestaetigt` — im Kontobereich war keine Anmeldung nachweisbar
   * (nicht lesbar, keine Sitzung, Token ohne lesbares Konto); `start_inkonsistent` — eine andere Anmeldung oder ein
   * Bereichswechsel beim Lesen. `null`, wenn der Start zusammenpasste.
   */
  readonly startProblem: 'start_unbestaetigt' | 'start_inkonsistent' | null;
  readonly capturedAt: string;
}

export type SyncRunIdentityChangeReason =
  | 'bereich'
  | 'sitzung'
  | 'sitzung_unlesbar'
  | 'start_inkonsistent'
  | 'start_unbestaetigt';

const REASON_TEXT: Record<SyncRunIdentityChangeReason, string> = {
  bereich: 'Betrieb, Konto oder Sicht hat gewechselt',
  sitzung: 'ein anderes Konto ist angemeldet',
  sitzung_unlesbar: 'die Anmeldung ist nicht mehr lesbar',
  start_inkonsistent: 'Anmeldung und Speicherbereich gehörten schon beim Start nicht zusammen',
  start_unbestaetigt: 'die Anmeldung dieses Kontos ließ sich beim Start nicht bestätigen',
};

/** Hält der Lauf schon beim Start an (Startidentität nicht nachweisbar oder fremd)? */
export function isStartIdentityProblem(reason: SyncRunIdentityChangeReason | null | undefined): boolean {
  return reason === 'start_unbestaetigt' || reason === 'start_inkonsistent';
}

export class SyncRunIdentityChangedError extends Error {
  readonly code = 'sync_run_identity_changed' as const;

  constructor(readonly reason: SyncRunIdentityChangeReason) {
    super(`Synchronisation angehalten: ${REASON_TEXT[reason]}.`);
    this.name = 'SyncRunIdentityChangedError';
  }
}

/**
 * Am Netzaufruf selbst abgelehnt. Der Name folgt der Fetch-Konvention für eine nicht ausgeführte Anfrage: Die
 * Bibliotheken wiederholen sie dann nicht und melden sie sofort als Fehler.
 */
class SyncRunRequestRefusedError extends SyncRunIdentityChangedError {
  constructor(reason: SyncRunIdentityChangeReason) {
    super(reason);
    this.name = 'AbortError';
  }
}

export function isSyncRunIdentityChangedError(error: unknown): error is SyncRunIdentityChangedError {
  return (
    error instanceof SyncRunIdentityChangedError ||
    (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'sync_run_identity_changed')
  );
}

/** Text für Bericht und Protokoll. */
export function describeSyncRunIdentityChange(reason: SyncRunIdentityChangeReason): string {
  return `Synchronisation angehalten: ${REASON_TEXT[reason]}.`;
}

interface SessionRead {
  readable: boolean;
  userId: string | null;
  accessToken: string | null;
  /**
   * Woher die Identität stammt: Sitzung des Clients, Konto aus dem Token eines eigenen Token-Lieferanten, oder —
   * bei einem Token ohne lesbares Konto — das Token selbst. Nur die ersten beiden lassen sich einem Konto zuordnen.
   */
  source: 'session' | 'token_subject' | 'opaque_token' | 'none';
}

type SessionCapableClient = {
  auth?: {
    getSession?: () => Promise<{
      data?: { session?: { user?: { id?: string } | null; access_token?: string } | null };
    }>;
  };
  /** Eigener Token-Lieferant (Option `accessToken` des SDK); dann ist `auth` gesperrt. */
  accessToken?: () => Promise<string | null>;
};

/** Fingerabdruck eines Tokens ohne lesbares Konto — das Token selbst bleibt nur dort, wo es gesendet wird. */
function tokenFingerprint(token: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `token:${hash.toString(16)}:${token.length}`;
}

/** Konto (`sub`) eines JWT; `null`, wenn das Token keines erkennen lässt. */
function tokenSubject(token: string): string | null {
  const teil = token.split('.')[1];
  if (!teil) return null;
  try {
    const base64 = teil.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(teil.length / 4) * 4, '=');
    const claims = JSON.parse(atob(base64)) as { sub?: unknown };
    return typeof claims.sub === 'string' && claims.sub ? claims.sub : null;
  } catch {
    return null;
  }
}

async function readTokenProvider(client: SessionCapableClient): Promise<SessionRead> {
  const unreadable: SessionRead = { readable: false, userId: null, accessToken: null, source: 'none' };
  const provider = client.accessToken;
  if (typeof provider !== 'function') return unreadable;
  try {
    const token = await provider.call(client);
    if (typeof token !== 'string' || !token) return { readable: true, userId: null, accessToken: null, source: 'token_subject' };
    const subject = tokenSubject(token);
    return subject
      ? { readable: true, userId: subject, accessToken: token, source: 'token_subject' }
      : // Ohne lesbares Konto steht das Token für die Identität (als Fingerabdruck): Ein anderes heißt ein Wechsel.
        { readable: true, userId: tokenFingerprint(token), accessToken: token, source: 'opaque_token' };
  } catch {
    return unreadable;
  }
}

async function readSession(client: SupabaseClient | null | undefined): Promise<SessionRead> {
  const unreadable: SessionRead = { readable: false, userId: null, accessToken: null, source: 'none' };
  if (!client) return unreadable;
  const capable = client as unknown as SessionCapableClient;
  try {
    // Mit eigenem Token-Lieferanten wirft schon der Zugriff auf `auth.getSession` — dann zählt der Lieferant.
    const auth = capable.auth;
    if (auth && typeof auth.getSession === 'function') {
      const { data } = await auth.getSession();
      const session = data?.session ?? null;
      return { readable: true, userId: session?.user?.id ?? null, accessToken: session?.access_token ?? null, source: 'session' };
    }
  } catch {
    // weiter mit dem Token-Lieferanten
  }
  return readTokenProvider(capable);
}

function activeScopeWorkspaceId(): string | null {
  const scope = getActiveStorageScope();
  return scope.type === 'workspace' ? scope.workspaceId : null;
}

/**
 * Hält die Ursprungsidentität fest. Der Speicherbereich wird vor dem Lesen der Sitzung gelesen und danach
 * erneut verglichen: Wechselt er dazwischen, gilt der Lauf von Anfang an als nicht zusammengehörig.
 *
 * DOKUMENTE-01 R1-WEISS-START — im Kontobereich nur mit **nachweisbarer** Startidentität: Die Anmeldung ist lesbar
 * und nennt genau das Konto dieses Bereichs (Sitzung oder Konto aus dem Token). Nicht lesbare Sitzung oder
 * Tokenquelle, keine Sitzung und ein Token ohne lesbares Konto weisen nichts nach: Der Lauf hält dann an, statt
 * später den Zugang zu nehmen, den das SDK gerade liefert. Erst ein neuer Lauf mit bestätigter Identität sendet.
 * Außerhalb eines Kontobereichs (nur Testgerüste) bleibt es beim bisherigen Weg.
 */
export async function captureSyncRunIdentity(
  client: SupabaseClient | null | undefined,
  workspaceId: string,
): Promise<SyncRunIdentity> {
  const storageKey = getActiveStorageKey();
  const scopeWorkspaceId = activeScopeWorkspaceId();
  const account = getActiveStorageAccount();
  const session = await readSession(client);
  const scopeStable = getActiveStorageKey() === storageKey;
  const provable = session.readable && session.source !== 'opaque_token' && session.userId !== null;
  const startProblem: SyncRunIdentity['startProblem'] = !scopeStable
    ? 'start_inkonsistent'
    : !account
      ? null
      : !provable
        ? 'start_unbestaetigt'
        : session.userId !== account.userId
          ? 'start_inkonsistent'
          : null;
  return Object.freeze({
    storageKey,
    workspaceId,
    scopeWorkspaceId,
    accountUserId: account?.userId ?? null,
    access: account?.access ?? null,
    sessionUserId: session.readable ? session.userId : undefined,
    consistent: startProblem === null,
    startProblem,
    capturedAt: new Date().toISOString(),
  });
}

export interface SyncRunGuard {
  readonly identity: SyncRunIdentity;
  /** Erster erkannter Unterschied; danach sendet der Lauf nichts mehr. */
  readonly tripped: SyncRunIdentityChangeReason | null;
  /** Prüft Bereich und Sitzung gegen den Start; `false` heißt: nichts mehr senden. */
  check(): Promise<boolean>;
  /** Wie `check`, wirft aber `SyncRunIdentityChangedError`. */
  assert(): Promise<void>;
  /**
   * Schlussblick am Netzaufruf, ohne zu warten: Lauf nicht angehalten und Speicherbereich unverändert. Die Sitzung
   * hat die unmittelbar vorangehende Prüfung gelesen; ihr Zugang ist an die Anfrage geheftet.
   */
  assertScopeNow(): void;
  /** Zugang des Ursprungskontos aus der letzten bestandenen Prüfung (`Bearer …`), sonst `null`. */
  authorization(): string | null;
  /** Am Netzaufruf ohne geprüften Zugang: anhalten und die Anfrage nicht entstehen lassen. */
  refuseWithoutVerifiedAccess(): never;
}

export function createSyncRunGuard(
  identity: SyncRunIdentity,
  client: SupabaseClient | null | undefined,
): SyncRunGuard {
  let tripped: SyncRunIdentityChangeReason | null = identity.consistent
    ? null
    : (identity.startProblem ?? 'start_inkonsistent');
  let verifiedAccessToken: string | null = null;
  const trip = (reason: SyncRunIdentityChangeReason): false => {
    if (!tripped) tripped = reason;
    verifiedAccessToken = null;
    return false;
  };
  const check = async (): Promise<boolean> => {
    if (tripped) return false;
    if (getActiveStorageKey() !== identity.storageKey) return trip('bereich');
    if (identity.sessionUserId !== undefined) {
      const now = await readSession(client);
      if (tripped) return false;
      if (!now.readable) return trip('sitzung_unlesbar');
      if (now.userId !== identity.sessionUserId) return trip('sitzung');
      // Nach dem Warten erneut: Der Bereich kann inzwischen gewechselt haben.
      if (getActiveStorageKey() !== identity.storageKey) return trip('bereich');
      // Derselbe Nutzer, gegebenenfalls mit erneuertem Token — genau dieser geht mit der nächsten Anfrage hinaus.
      verifiedAccessToken = now.accessToken;
    }
    return true;
  };
  return {
    identity,
    get tripped() {
      return tripped;
    },
    check,
    async assert() {
      if (!(await check())) throw new SyncRunIdentityChangedError(tripped ?? 'bereich');
    },
    assertScopeNow() {
      if (!tripped && getActiveStorageKey() !== identity.storageKey) trip('bereich');
      if (tripped) throw new SyncRunRequestRefusedError(tripped);
    },
    authorization() {
      return verifiedAccessToken ? `Bearer ${verifiedAccessToken}` : null;
    },
    refuseWithoutVerifiedAccess(): never {
      trip('sitzung_unlesbar');
      throw new SyncRunRequestRefusedError(tripped ?? 'sitzung_unlesbar');
    },
  };
}

type AnyFunction = (...args: unknown[]) => unknown;
type Chainable = Record<PropertyKey, unknown>;
type FetchLike = (input: unknown, init?: Record<string, unknown>) => Promise<unknown>;

/**
 * Der Netzaufruf eines Laufs: Schlussblick ohne Warten, dann mit dem geprüften Zugang des Ursprungskontos. Die
 * Supabase-Bibliotheken übernehmen einen vorhandenen `Authorization`-Kopf, statt den der Sitzung zu lesen.
 *
 * DOKUMENTE-01 R1-WEISS-START — im Kontobereich nie ohne diesen Zugang: Ohne ihn läse das SDK die Sitzung, die
 * gerade gilt — womöglich die eines anderen Kontos. Die Anfrage entsteht dann nicht, der Lauf hält an.
 */
function bindFetch(fetchFn: FetchLike, guard: SyncRunGuard): FetchLike {
  return async (input, init) => {
    guard.assertScopeNow();
    const authorization = guard.authorization();
    if (!authorization && guard.identity.accountUserId !== null) guard.refuseWithoutVerifiedAccess();
    if (!authorization) return fetchFn(input, init);
    const headers = new Headers((init?.headers as HeadersInit | undefined) ?? undefined);
    headers.set('Authorization', authorization);
    return fetchFn(input, { ...(init ?? {}), headers });
  };
}

/**
 * Eine Anfrage, die erst nach bestandener Prüfung entsteht. Verkettete Methoden (`.select()`, `.single()` …)
 * werden aufgezeichnet und danach auf der echten Anfrage nachgespielt. So sendet auch ein Client, der schon
 * beim Aufruf losschickt, nie vor der Prüfung.
 */
function deferredRequest(create: () => unknown, guard: SyncRunGuard): unknown {
  const chain: Array<{ method: PropertyKey; args: unknown[] }> = [];
  const handle: unknown = new Proxy(Object.create(null) as object, {
    get(_target, prop) {
      if (prop === 'then') {
        return (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
          guard
            .assert()
            .then(() => {
              let request = create() as Chainable;
              for (const { method, args } of chain) {
                request = (request[method] as AnyFunction).apply(request, args) as Chainable;
              }
              if (request && typeof request.fetch === 'function') {
                // Supabase-Abfrage: Netzaufruf an den Lauf binden (Schlussblick und geprüfter Zugang).
                request.fetch = bindFetch(request.fetch as FetchLike, guard);
              } else {
                const authorization = guard.authorization();
                if (authorization && request && typeof request.setHeader === 'function') {
                  (request.setHeader as AnyFunction).call(request, 'Authorization', authorization);
                }
              }
              return request;
            })
            .then(onFulfilled, onRejected);
      }
      if (typeof prop === 'symbol' || prop === 'toJSON') return undefined;
      return (...args: unknown[]) => {
        chain.push({ method: prop, args });
        return handle;
      };
    },
  });
  return handle;
}

/** Netzwerkaufrufe der Dateiablage; alles andere (etwa `getPublicUrl`) bleibt synchron und unberührt. */
const STORAGE_NETWORK_METHODS = new Set<PropertyKey>([
  'upload',
  'update',
  'uploadToSignedUrl',
  'download',
  'remove',
  'move',
  'copy',
  'list',
  'info',
  'exists',
  'createSignedUrl',
  'createSignedUrls',
  'createSignedUploadUrl',
]);

function bindStorage(storage: unknown, guard: SyncRunGuard): unknown {
  if (!storage || typeof storage !== 'object') return storage;
  return new Proxy(storage as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (bucket: string) => {
        const files = (target as { from: (name: string) => object }).from(bucket) as Record<PropertyKey, unknown>;
        // Jede Methode der Dateiablage sendet über `this.fetch`: Die gebundene Ableitung trägt den Lauf-Netzaufruf.
        const bound =
          typeof files.fetch === 'function'
            ? Object.create(files, { fetch: { value: bindFetch(files.fetch as FetchLike, guard), writable: true } })
            : files;
        return new Proxy(files, {
          get(fileTarget, method, fileReceiver) {
            const value = Reflect.get(fileTarget, method, fileReceiver);
            if (typeof value !== 'function' || !STORAGE_NETWORK_METHODS.has(method)) return value;
            return async (...args: unknown[]) => {
              await guard.assert();
              return (value as AnyFunction).apply(bound, args);
            };
          },
        });
      };
    },
  });
}

/**
 * Ein Client, dessen Anfragen an den Lauf gebunden sind: `rpc`, Tabellenzugriffe und Dateiablage prüfen
 * unmittelbar vor dem Versand die Ursprungsidentität und tragen deren Zugang. Alles andere reicht er durch.
 */
export function bindClientToSyncRun<T extends SupabaseClient | null | undefined>(client: T, guard: SyncRunGuard): T {
  if (!client) return client;
  return new Proxy(client as object, {
    get(target, prop, receiver) {
      if (prop === 'rpc') {
        // Die Argumente unverändert weiterreichen (gleiche Anzahl wie beim Aufruf).
        return (...args: unknown[]) =>
          deferredRequest(() => (target as unknown as { rpc: AnyFunction }).rpc(...args), guard);
      }
      if (prop === 'from') {
        return (...args: unknown[]) =>
          deferredRequest(() => (target as unknown as { from: AnyFunction }).from(...args), guard);
      }
      if (prop === 'storage') {
        return bindStorage(Reflect.get(target, prop, receiver), guard);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}

/* -------------------------------------------------------------------------- */
/* Direkte Vorgänge                                                            */
/* -------------------------------------------------------------------------- */

/**
 * DOKUMENTE-01 (DOK-WEISS-DIREKT) — ein direkter Vorgang (etwa eine Löschung aus der Oberfläche) gehört dem
 * Bereich (Betrieb, Konto, Sicht), in dem er aufgerufen wurde. Zwischen Aufruf und Änderung liegen Rückfragen an
 * den Server; wechselt in dieser Zeit das Konto, darf der Vorgang weder im neuen Bestand ändern noch dort einen
 * Auftrag einreihen, noch Erfolg melden.
 */
export interface DirectOperationBinding {
  /**
   * Client für die Anfragen des Vorgangs. Mit bestätigter Anmeldung an ihn gebunden (Prüfung vor jeder Anfrage,
   * geprüfter Zugang). Ohne bestätigte Anmeldung der übergebene Client — dann nur für lesende Rückfragen.
   */
  readonly client: SupabaseClient | null | undefined;
  /** Die Anmeldung nennt nachweislich das Konto dieses Bereichs. Ohne das im Kontobereich keine Cloud-Mutation. */
  readonly confirmed: boolean;
  /** Synchron, unmittelbar vor einer lokalen Mutation: noch derselbe Bereich, nichts angehalten. */
  scopeStillActive(): boolean;
  /** Nach einer asynchronen Grenze: derselbe Bereich, und angemeldet ist kein anderes Konto als beim Aufruf. */
  stillValid(): Promise<boolean>;
}

/**
 * Bindet einen direkten Vorgang an den Bereich, den der Aufrufer **vor** seiner ersten asynchronen Grenze
 * festgehalten hat (`startStorageKey`). `null`: Der Vorgang gehört schon nicht mehr dem aktiven Bereich, oder ein
 * anderes Konto ist angemeldet — sofort abbrechen.
 */
export async function bindDirectOperation(
  client: SupabaseClient | null | undefined,
  startStorageKey: string,
): Promise<DirectOperationBinding | null> {
  const identity = await captureSyncRunIdentity(client, activeScopeWorkspaceId() ?? '');
  if (identity.storageKey !== startStorageKey || getActiveStorageKey() !== startStorageKey) return null;
  if (identity.startProblem === 'start_inkonsistent') return null;
  if (identity.consistent) {
    const guard = createSyncRunGuard(identity, client);
    return {
      client: bindClientToSyncRun(client, guard),
      confirmed: true,
      scopeStillActive: () => !guard.tripped && getActiveStorageKey() === startStorageKey,
      stillValid: () => guard.check(),
    };
  }
  // Im Kontobereich ohne nachweisbare Anmeldung: lesen ja, ändern nur lokal im eigenen Bereich, nie in der Cloud.
  const startSessionUserId = identity.sessionUserId;
  let angehalten = false;
  const anhalten = (): false => {
    angehalten = true;
    return false;
  };
  return {
    client,
    confirmed: false,
    scopeStillActive: () => !angehalten && getActiveStorageKey() === startStorageKey,
    async stillValid() {
      if (angehalten || getActiveStorageKey() !== startStorageKey) return anhalten();
      const now = await readSession(client);
      if (getActiveStorageKey() !== startStorageKey) return anhalten();
      // Wer jetzt angemeldet ist, war es beim Aufruf nicht nachweislich: eine neue Anmeldung ist ein Wechsel.
      if (now.readable && now.userId !== null && now.userId !== startSessionUserId) return anhalten();
      return true;
    },
  };
}
