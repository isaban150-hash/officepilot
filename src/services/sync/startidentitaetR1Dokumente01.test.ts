/**
 * DOKUMENTE-01 R1-WEISS-START — ohne nachweisbare Startidentität sendet ein Lauf nichts.
 *
 * WEISS-Sicherheitsrecheck vom 21.10.2026: Ließ sich die Sitzung beim Start eines Laufs nicht lesen, galt der Lauf
 * trotzdem als zusammengehörig. Der Netzaufruf nahm dann den Zugang, den das SDK gerade lieferte — den eines
 * anderen, inzwischen angemeldeten Kontos.
 *
 *  T1  WEISS-Reproduktion: Sitzung beim Start nicht lesbar, danach B angemeldet → keine Anfrage, Grund
 *      `start_unbestaetigt`; die Warteschlange von A bleibt unverändert, die von B unberührt
 *  T2  keine Sitzung beim Start → keine Anfrage; T2b auch bei leerer Warteschlange kein Erfolg
 *  T3  Tokenquelle wirft → keine Anfrage
 *  T4  Tokenquelle liefert kein Token → keine Anfrage
 *  T5  Koordinator: kein Erfolg, Haltbericht, Fehlerzustand dieses Kontos, kein Abruf, nichts gespeichert; der
 *      Planer versucht es später erneut
 *  T6  neuer Lauf, nachdem die richtige Anmeldung wieder lesbar ist: genau die A-Aufträge, mit dem Zugang von A
 *  T7  normale Token-Erneuerung desselben Kontos mitten im Lauf: kein Halt, die nächste Anfrage trägt das neue Token
 *  T8  kein Rückfall: Liefert die Prüfung keinen Zugang, entsteht die Anfrage nicht — das SDK liest die Sitzung
 *      nicht selbst nach
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState, CompanyDocument } from '../../types/models';
import type { SyncOutboxEntry, SyncOutboxOrigin } from '../../types/sync';
import { STORAGE_VERSION } from './syncMigrationService';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import { resetSyncOutboxForTests } from './syncOutboxService';
import { SupabaseSyncAdapter } from './supabaseSyncAdapter';
import {
  SYNC_IDENTITY_CHANGED_REPORT_ID,
  SyncCoordinator,
  isSyncIdentityHaltReport,
  resetSyncCoordinatorForTests,
} from './syncCoordinator';
import { classifySyncRun } from './syncScheduler';
import {
  buildStorageKey,
  resetStorageScopeForTests,
  setActiveStorageScope,
  type StorageAccess,
} from '../storage/storageScopeService';
import * as supabaseLib from '../../lib/supabase';

const WS = 'ws-start-dok01';
const INHABER = 'konto-inhaber-start';
const MITGLIED = 'konto-mitglied-start';
const JETZT = '2026-10-21T12:00:00.000Z';

beforeEach(() => {
  localStorage.clear();
  resetStorageScopeForTests();
  resetSyncOutboxForTests([]);
  resetSyncClientForTests({ ...createSyncClient(), serverWorkspaceId: WS, workspaceId: WS });
  resetSyncCoordinatorForTests();
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetStorageScopeForTests();
});

/* ------------------------------------------------------------------ */
/* Bausteine                                                           */
/* ------------------------------------------------------------------ */

function bereich(userId: string, access: StorageAccess): void {
  setActiveStorageScope({ type: 'workspace', workspaceId: WS, account: { userId, access } });
}

function herkunft(userId: string, access: StorageAccess): SyncOutboxOrigin {
  return { userId, workspaceId: WS, access };
}

function dokument(id: string): CompanyDocument {
  return {
    id,
    title: `Startprüfung synthetisch ${id}`,
    category: 'sonstiges',
    issuer: 'Startprüfung',
    recognizedText: 'synthetisch',
    issueDate: null,
    validUntil: null,
    digitalFolder: { id: 'sonstiges', name: 'Sonstiges', path: '/sonstiges' },
    paperFolder: { folderId: 'sonstiges', register: 'S', label: 'Sonstiges' },
    tags: [],
    linkedCompany: null,
    linkedVorgang: null,
    archived: false,
    createdAt: JETZT,
    sync: { version: 0, updatedAt: JETZT, deleted: false, deviceId: 'geraet-start', workspaceId: WS },
  } as unknown as CompanyDocument;
}

function auftrag(id: string, entityId: string, origin: SyncOutboxOrigin, sequence: number): SyncOutboxEntry {
  return {
    id,
    entityType: 'document',
    entityId,
    operation: 'create',
    version: 0,
    queuedAt: JETZT,
    sequence,
    retryCount: 0,
    status: 'pending',
    origin,
  };
}

function zustand(teil: Partial<AppPersistedState>): AppPersistedState {
  return {
    version: STORAGE_VERSION,
    invoiceEntries: [],
    syncClient: { ...createSyncClient(), serverWorkspaceId: WS, workspaceId: WS },
    syncOutbox: [],
    setup: DEFAULT_SETUP,
    vorgaenge: [],
    customers: [],
    inboxItems: [],
    tasks: [],
    documents: [],
    savedAt: JETZT,
    ...teil,
  } as AppPersistedState;
}

/** Ein offener Auftrag von A samt Dokument. */
function auftragVonA(id = 'doc-start-a') {
  const docs = [dokument(id)];
  const outbox = [auftrag(`out-${id}`, id, herkunft(INHABER, 'full'), 1)];
  return { docs, outbox, state: zustand({ documents: docs, syncOutbox: outbox }) };
}

/** Feste, weit entfernte Ablaufzeit; `fassung` unterscheidet erneuerte Token desselben Kontos. */
const ABLAUF = 4102444800;

function synthetischesToken(konto: string, fassung = 1): string {
  const teil = (wert: object) => Buffer.from(JSON.stringify(wert)).toString('base64url');
  return `${teil({ alg: 'HS256', typ: 'JWT' })}.${teil({ sub: konto, role: 'authenticated', exp: ABLAUF, fassung })}.synthetisch`;
}

function sitzungFuer(konto: string, fassung = 1) {
  return {
    access_token: synthetischesToken(konto, fassung),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: ABLAUF,
    refresh_token: `synthetisch-erneuerung-${konto}-${fassung}`,
    user: {
      id: konto,
      aud: 'authenticated',
      role: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-10-20T00:00:00.000Z',
    },
  };
}

const SITZUNGSSCHLUESSEL = 'start-sdk-sitzung';

/** Realtime wird hier nie verbunden; die Testumgebung hat nur keinen WebSocket-Konstruktor. */
class OhneVerbindung {
  readonly readyState = 3;
  close(): void {}
  send(): void {}
}

interface NetzAnfrage {
  pfad: string;
  zugang: string | null;
}

/** Echtes Supabase-SDK; ersetzt sind nur die Sitzungsablage und das Netz. */
function echterClient(ablage: Map<string, string>, beiAnfrage?: (pfad: string) => void) {
  const anfragen: NetzAnfrage[] = [];
  const netz = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const pfad = new URL(String(input)).pathname;
    anfragen.push({ pfad, zugang: new Headers(init?.headers).get('Authorization') });
    beiAnfrage?.(pfad);
    const body = pfad.endsWith('/pull_workspace_sync_state')
      ? {}
      : pfad.endsWith('/pull_workspace_order_amendments') || pfad.endsWith('/pull_workspace_documents')
        ? []
        : { row_version: 1, deleted: false, payload: {} };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const client = createClient('http://127.0.0.1:54321', 'synthetischer-anon-schluessel', {
    realtime: { transport: OhneVerbindung as never },
    auth: {
      storage: {
        getItem: (key: string) => ablage.get(key) ?? null,
        setItem: (key: string, value: string) => void ablage.set(key, value),
        removeItem: (key: string) => void ablage.delete(key),
      },
      storageKey: SITZUNGSSCHLUESSEL,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { fetch: netz as typeof fetch },
  });
  return { client, anfragen };
}

function melde(ablage: Map<string, string>, konto: string, fassung = 1): void {
  ablage.set(SITZUNGSSCHLUESSEL, JSON.stringify(sitzungFuer(konto, fassung)));
}

/** Echtes SDK mit eigenem Token-Lieferanten (Option `accessToken`). */
function clientMitTokenLieferant(lieferant: () => Promise<string | null>) {
  const anfragen: NetzAnfrage[] = [];
  const client = createClient('http://127.0.0.1:54321', 'synthetischer-anon-schluessel', {
    realtime: { transport: OhneVerbindung as never },
    accessToken: lieferant,
    global: {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        anfragen.push({ pfad: new URL(String(input)).pathname, zugang: new Headers(init?.headers).get('Authorization') });
        return new Response(JSON.stringify({ row_version: 1, deleted: false, payload: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }) as typeof fetch,
    },
  });
  return { client, anfragen };
}

/** Ein angehaltener Lauf: nichts gesendet, nichts erledigt oder verworfen, Warteschlange unverändert. */
function erwarteHaltOhneVersand(
  ergebnis: Awaited<ReturnType<SupabaseSyncAdapter['pushChanges']>>,
  outbox: SyncOutboxEntry[],
  anfragen: NetzAnfrage[],
): void {
  expect(anfragen).toEqual([]);
  expect(ergebnis.success).toBe(false);
  expect(ergebnis.identityChanged).toBe(true);
  expect(ergebnis.identityChangeReason).toBe('start_unbestaetigt');
  expect(ergebnis.runIdentity?.consistent).toBe(false);
  expect(ergebnis.runIdentity?.startProblem).toBe('start_unbestaetigt');
  expect(ergebnis.completedOutboxIds).toEqual([]);
  expect(ergebnis.failedOutbox).toEqual([]);
  expect(ergebnis.state.syncOutbox).toEqual(outbox);
}

/* ------------------------------------------------------------------ */
/* T1–T4: Start ohne nachweisbare Identität                             */
/* ------------------------------------------------------------------ */

describe('DOKUMENTE-01 R1-WEISS-START — Start ohne nachweisbare Identität', () => {
  it('T1 WEISS-Reproduktion: Startsitzung nicht lesbar, danach B angemeldet → keine Anfrage, A-Auftrag bleibt offen', async () => {
    bereich(INHABER, 'full');
    const { client, anfragen } = echterClient(new Map());
    let lesungen = 0;
    client.auth.getSession = (async () => {
      lesungen += 1;
      if (lesungen === 1) throw new Error('synthetisch: Sitzung beim Laufstart nicht lesbar');
      return { data: { session: sitzungFuer(MITGLIED) }, error: null };
    }) as typeof client.auth.getSession;
    const { outbox, state } = auftragVonA();
    // Bestand von B mit eigenem offenem Auftrag: Er muss danach Zeichen für Zeichen derselbe sein.
    const schluesselB = buildStorageKey({ type: 'workspace', workspaceId: WS, account: { userId: MITGLIED, access: 'member' } });
    const bestandB = JSON.stringify(
      zustand({
        documents: [dokument('doc-start-b')],
        syncOutbox: [auftrag('out-doc-start-b', 'doc-start-b', herkunft(MITGLIED, 'member'), 1)],
      }),
    );
    localStorage.setItem(schluesselB, bestandB);

    const ergebnis = await new SupabaseSyncAdapter(client).pushChanges({ deviceId: 'geraet-start', workspaceId: WS, state, outbox });

    erwarteHaltOhneVersand(ergebnis, outbox, anfragen);
    // Kein Netzaufruf, also auch kein Nachlesen der Sitzung durch das SDK (WEISS: die zweite Lesung lieferte B).
    expect(lesungen).toBe(1);
    expect(ergebnis.runIdentity?.sessionUserId).toBeUndefined();
    expect(localStorage.getItem(schluesselB)).toBe(bestandB);
  });

  it('T2 keine Sitzung beim Start → keine Anfrage', async () => {
    bereich(INHABER, 'full');
    const { client, anfragen } = echterClient(new Map());
    const { outbox, state } = auftragVonA();

    const ergebnis = await new SupabaseSyncAdapter(client).pushChanges({ deviceId: 'geraet-start', workspaceId: WS, state, outbox });

    erwarteHaltOhneVersand(ergebnis, outbox, anfragen);
    expect(ergebnis.runIdentity?.sessionUserId).toBeNull();
  });

  it('T2b leere Warteschlange: auch ohne Auftrag kein Erfolg — der Lauf hält an, bevor er etwas tut', async () => {
    bereich(INHABER, 'full');
    const { client, anfragen } = echterClient(new Map());

    const ergebnis = await new SupabaseSyncAdapter(client).pushChanges({
      deviceId: 'geraet-start',
      workspaceId: WS,
      state: zustand({}),
      outbox: [],
    });

    erwarteHaltOhneVersand(ergebnis, [], anfragen);
  });

  it('T3 Tokenquelle wirft → keine Anfrage', async () => {
    bereich(INHABER, 'full');
    const { client, anfragen } = clientMitTokenLieferant(async () => {
      throw new Error('synthetisch: Tokenquelle nicht lesbar');
    });
    const { outbox, state } = auftragVonA();

    const ergebnis = await new SupabaseSyncAdapter(client).pushChanges({ deviceId: 'geraet-start', workspaceId: WS, state, outbox });

    erwarteHaltOhneVersand(ergebnis, outbox, anfragen);
    expect(ergebnis.runIdentity?.sessionUserId).toBeUndefined();
  });

  it('T4 Tokenquelle liefert kein Token → keine Anfrage', async () => {
    bereich(INHABER, 'full');
    const { client, anfragen } = clientMitTokenLieferant(async () => null);
    const { outbox, state } = auftragVonA();

    const ergebnis = await new SupabaseSyncAdapter(client).pushChanges({ deviceId: 'geraet-start', workspaceId: WS, state, outbox });

    erwarteHaltOhneVersand(ergebnis, outbox, anfragen);
  });
});

/* ------------------------------------------------------------------ */
/* T5–T8: Koordinator, Fortsetzung, Erneuerung, kein Rückfall           */
/* ------------------------------------------------------------------ */

describe('DOKUMENTE-01 R1-WEISS-START — Koordinator, Fortsetzung und Token-Erneuerung', () => {
  it('T5 Koordinator: kein Erfolg, Haltbericht, Fehlerzustand dieses Kontos, kein Abruf; der Planer versucht es später', async () => {
    bereich(INHABER, 'full');
    const { client, anfragen } = echterClient(new Map());
    client.auth.getSession = (async () => {
      throw new Error('synthetisch: Sitzung beim Laufstart nicht lesbar');
    }) as typeof client.auth.getSession;
    const { outbox, state } = auftragVonA();
    const koordinator = new SyncCoordinator(new SupabaseSyncAdapter(client));

    const ergebnis = await koordinator.runSync(state);

    expect(anfragen).toEqual([]);
    expect(ergebnis.success).toBe(false);
    expect(ergebnis.skipPersist).toBe(true);
    expect(ergebnis.state).toBe(state);
    expect(isSyncIdentityHaltReport(ergebnis.report)).toBe(true);
    expect(ergebnis.report.errorCount).toBe(1);
    expect(ergebnis.report.syncedEntities).toEqual([]);
    expect(ergebnis.report.errors.map((fehler) => fehler.outboxId)).toEqual([SYNC_IDENTITY_CHANGED_REPORT_ID]);
    expect(koordinator.getStatus().syncState).toBe('error');
    expect(koordinator.getStatus().lastError).toMatch(/beim Start nicht bestätigen/);
    // Kein endgültiger Fehler: Ein späterer Lauf mit bestätigter Identität setzt fort.
    expect(classifySyncRun(ergebnis.report, outbox)).toBe('retryable');
    expect(localStorage.length).toBe(0);
  });

  it('T6 neuer Lauf mit wieder lesbarer, richtiger Anmeldung: genau die A-Aufträge, mit dem Zugang von A', async () => {
    bereich(INHABER, 'full');
    const ablage = new Map<string, string>();
    const { client, anfragen } = echterClient(ablage);
    const echtesLesen = client.auth.getSession.bind(client.auth);
    let lesbar = false;
    client.auth.getSession = (async () => {
      if (!lesbar) throw new Error('synthetisch: Sitzung beim Laufstart nicht lesbar');
      return echtesLesen();
    }) as typeof client.auth.getSession;
    const docs = [dokument('doc-start-a1'), dokument('doc-start-a2')];
    const outbox = docs.map((doc, index) => auftrag(`out-${doc.id}`, doc.id, herkunft(INHABER, 'full'), index + 1));
    const adapter = new SupabaseSyncAdapter(client);

    const erster = await adapter.pushChanges({
      deviceId: 'geraet-start',
      workspaceId: WS,
      state: zustand({ documents: docs, syncOutbox: outbox }),
      outbox,
    });
    expect(erster.identityChangeReason).toBe('start_unbestaetigt');
    expect(anfragen).toEqual([]);

    // Die Anmeldung von A ist wieder lesbar: Erst dieser neue Lauf sendet — nur die Aufträge von A, mit A-Zugang.
    melde(ablage, INHABER);
    lesbar = true;
    const zweiter = await adapter.pushChanges({ deviceId: 'geraet-start', workspaceId: WS, state: erster.state, outbox: erster.state.syncOutbox });

    expect(zweiter.success).toBe(true);
    expect(zweiter.identityChanged ?? false).toBe(false);
    expect(zweiter.runIdentity?.consistent).toBe(true);
    expect(zweiter.completedOutboxIds).toEqual(outbox.map((entry) => entry.id));
    expect(anfragen.map((anfrage) => anfrage.zugang)).toEqual([
      `Bearer ${synthetischesToken(INHABER)}`,
      `Bearer ${synthetischesToken(INHABER)}`,
    ]);
  });

  it('T7 Token-Erneuerung desselben Kontos mitten im Lauf: kein Halt, die nächste Anfrage trägt das erneuerte Token', async () => {
    bereich(INHABER, 'full');
    const ablage = new Map<string, string>();
    melde(ablage, INHABER, 1);
    const { client, anfragen } = echterClient(ablage, () => {
      // Nach der ersten Sendung erneuert das SDK die Sitzung desselben Kontos (neues Zugangstoken).
      if (anfragen.length === 1) melde(ablage, INHABER, 2);
    });
    const docs = [dokument('doc-start-e1'), dokument('doc-start-e2')];
    const outbox = docs.map((doc, index) => auftrag(`out-${doc.id}`, doc.id, herkunft(INHABER, 'full'), index + 1));

    const ergebnis = await new SupabaseSyncAdapter(client).pushChanges({
      deviceId: 'geraet-start',
      workspaceId: WS,
      state: zustand({ documents: docs, syncOutbox: outbox }),
      outbox,
    });

    expect(ergebnis.success).toBe(true);
    expect(ergebnis.identityChanged ?? false).toBe(false);
    expect(ergebnis.completedOutboxIds).toEqual(outbox.map((entry) => entry.id));
    expect(anfragen.map((anfrage) => anfrage.zugang)).toEqual([
      `Bearer ${synthetischesToken(INHABER, 1)}`,
      `Bearer ${synthetischesToken(INHABER, 2)}`,
    ]);
  });

  it('T8 kein Rückfall: Prüfung ohne lesbaren Zugang → keine Anfrage, das SDK liest die Sitzung nicht selbst nach', async () => {
    bereich(INHABER, 'full');
    const { client, anfragen } = echterClient(new Map());
    let lesungen = 0;
    let sdkLesungen = 0;
    client.auth.getSession = (async () => {
      lesungen += 1;
      // Entsteht eine Anfrage ohne Zugang, liest das SDK selbst nach — und bekäme die Sitzung, die gerade gilt: B.
      if (new Error().stack?.includes('_getAccessToken')) {
        sdkLesungen += 1;
        return { data: { session: sitzungFuer(MITGLIED) }, error: null };
      }
      // Start: A mit Zugang · jede Prüfung danach: A, aber ohne lesbaren Zugang.
      return { data: { session: lesungen === 1 ? sitzungFuer(INHABER) : { user: { id: INHABER } } }, error: null };
    }) as unknown as typeof client.auth.getSession;
    const { outbox, state } = auftragVonA();

    const ergebnis = await new SupabaseSyncAdapter(client).pushChanges({ deviceId: 'geraet-start', workspaceId: WS, state, outbox });

    expect(anfragen).toEqual([]);
    expect(sdkLesungen).toBe(0);
    expect(ergebnis.success).toBe(false);
    expect(ergebnis.identityChanged).toBe(true);
    expect(ergebnis.identityChangeReason).toBe('sitzung_unlesbar');
    expect(ergebnis.completedOutboxIds).toEqual([]);
    expect(ergebnis.failedOutbox).toEqual([]);
    expect(ergebnis.state.syncOutbox).toEqual(outbox);

    // Gegenprobe ohne Bindung: Dieselbe Anfrage direkt am SDK liest die Sitzung selbst nach und trüge den Zugang von B.
    await client.rpc('upsert_workspace_intake_entity', {});
    expect(sdkLesungen).toBe(1);
    expect(anfragen).toEqual([
      { pfad: '/rest/v1/rpc/upsert_workspace_intake_entity', zugang: `Bearer ${synthetischesToken(MITGLIED)}` },
    ]);
  });
});
