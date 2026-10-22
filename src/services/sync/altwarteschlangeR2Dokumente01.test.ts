/**
 * DOKUMENTE-01 R2 — alte Aufträge unbekannter Herkunft gehen nie automatisch hinaus.
 *
 * WEISS-Endrecheck vom 20.10.2026 (R2): Nach der Übernahme einer alten gemeinsamen
 * Warteschlange sendete das übernehmende Konto deren Aufträge sofort unter seinem
 * Zugang — obwohl niemand nachweisen kann, wer sie eingereiht hat.
 *
 *  A1  Übernahme: offene Aufträge bleiben inhaltlich unverändert erhalten und sind
 *      gesperrt; ein Lauf sendet nichts davon (WEISS-Reproduktion). Endgültig
 *      abgewiesene, erledigte und nur-lokale Aufträge bleiben, wie sie sind
 *  A2  Neustart: die Sperre übersteht Speichern und Laden; Laden eines Kontobestands
 *      ohne Ursprungsangaben sperrt dessen offene Aufträge (Quelle „Laden")
 *  A3  neue Aufträge tragen ihr Ursprungskonto und gehen normal hinaus; ein Auftrag
 *      eines anderen Kontos, Betriebs oder mit breiterer Sicht wird nicht gesendet
 *  A4  bewusste Freigabe: nur das angemeldete Konto des Bestands, nur die geprüften
 *      Aufträge, mit Prüfspur; danach unter diesem Konto gesendet — genau einmal
 *  A5  Freigabe abgelehnt (anderes Konto angemeldet, kein Kontobestand, nichts
 *      Gesperrtes, Speichern scheitert): nichts verändert
 *  A6  ein Mitglied übernimmt den Altbestand nie; er bleibt bytegleich liegen
 *  A7  eine neue Änderung an einem gesperrten Auftrag gibt ihn nicht still frei
 *  A8  Anzeige: zurückgehaltene Aufträge zählen weder als wartend noch als Fehler,
 *      Status „zurückgehalten", Anzeige „Aktion erforderlich"; der Koordinator startet
 *      ihretwegen keinen Lauf
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState, CompanyDocument } from '../../types/models';
import type { SyncOutboxEntry, SyncOutboxOrigin } from '../../types/sync';
import { STORAGE_VERSION } from './syncMigrationService';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import { enqueueSyncOutbox, getSyncOutboxSnapshot, resetSyncOutboxForTests } from './syncOutboxService';
import { SupabaseSyncAdapter } from './supabaseSyncAdapter';
import { SyncCoordinator, resetSyncCoordinatorForTests } from './syncCoordinator';
import { buildOutboxOriginLogKey, heldOutboxReason, readOutboxOriginLog } from './syncOutboxOriginService';
import { getSyncUiSnapshot, releaseHeldOutboxEntriesFromUi, summarizeSyncStatus } from './syncUiService';
import { deriveSyncIndicatorState } from './syncIndicatorService';
import {
  buildLegacyWorkspaceStorageKey,
  buildStorageKey,
  resetStorageScopeForTests,
  setActiveStorageScope,
  type StorageAccess,
} from '../storage/storageScopeService';
import { prepareWorkspaceAccountStore } from '../storage/workspaceAccountStorageService';
import { switchToWorkspaceScope } from '../storage/storageBootstrapService';
import * as persistence from '../persistenceService';
import * as supabaseLib from '../../lib/supabase';
import { getDocumentFileRefStoreSnapshot } from '../documentFileStoreService';

const WS = 'ws-r2-dok01';
const INHABER = 'konto-inhaber-r2';
const MITGLIED = 'konto-mitglied-r2';
const JETZT = '2026-10-20T12:00:00.000Z';

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

function bereich(userId: string, access: StorageAccess): void {
  setActiveStorageScope({ type: 'workspace', workspaceId: WS, account: { userId, access } });
}

function kontoSchluessel(userId: string, access: StorageAccess): string {
  return buildStorageKey({ type: 'workspace', workspaceId: WS, account: { userId, access } });
}

function dokument(id: string): CompanyDocument {
  return {
    id,
    title: `R2 synthetisch ${id}`,
    category: 'sonstiges',
    issuer: 'R2 Prüfung',
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
    sync: { version: 0, updatedAt: JETZT, deleted: false, deviceId: 'geraet-r2', workspaceId: WS },
  } as unknown as CompanyDocument;
}

function auftrag(id: string, entityId: string, teil: Partial<SyncOutboxEntry> = {}): SyncOutboxEntry {
  return {
    id,
    entityType: 'document',
    entityId,
    operation: 'create',
    version: 0,
    queuedAt: JETZT,
    retryCount: 0,
    status: 'pending',
    ...teil,
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

/** Die alte gemeinsame Warteschlange: zwei offene Aufträge ohne Ursprung, dazu Abgewiesenes, Erledigtes, Lokales. */
function altbestand(): AppPersistedState {
  return zustand({
    documents: [dokument('doc-alt-1'), dokument('doc-alt-2'), dokument('doc-alt-3')],
    syncOutbox: [
      auftrag('alt-offen-1', 'doc-alt-1'),
      auftrag('alt-offen-2', 'doc-alt-2', { status: 'error', retryCount: 2, lastErrorMessage: 'Netzwerkfehler' }),
      auftrag('alt-abgewiesen', 'doc-alt-3', { status: 'failed', lastErrorMessage: 'Keine Schreibberechtigung', lastErrorRetryable: false }),
      auftrag('alt-erledigt', 'doc-alt-1', { status: 'completed' }),
      auftrag('alt-lokal', 'mail-alt', { entityType: 'mail_import' }),
    ],
  });
}

function ersatzClient(sitzung: { konto: string | null }) {
  const sendungen: Array<{ konto: string | null; id: string | undefined }> = [];
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: sitzung.konto ? { user: { id: sitzung.konto }, access_token: `zugang-${sitzung.konto}` } : null },
      }),
    },
    rpc: async (_name: string, args: Record<string, unknown>) => {
      const payload = (args.p_payload ?? {}) as Record<string, unknown>;
      sendungen.push({ konto: sitzung.konto, id: payload.client_document_id as string | undefined });
      return { data: { row_version: 1, deleted: false, payload: args.p_payload }, error: null };
    },
  };
  return { client, sendungen };
}

function angemeldet(konto: string | null): void {
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    auth: { getSession: async () => ({ data: { session: konto ? { user: { id: konto } } : null } }) },
  } as never);
}

function ohneSperre(entry: SyncOutboxEntry): SyncOutboxEntry {
  const { hold: _hold, ...rest } = entry;
  return rest;
}

describe('DOKUMENTE-01 R2 — Übernahme und Laden', () => {
  it('A1 Übernahme: offene Aufträge unverändert erhalten und gesperrt; ein Lauf sendet nichts davon', async () => {
    const alt = altbestand();
    localStorage.setItem(buildLegacyWorkspaceStorageKey(WS), JSON.stringify(alt));

    expect(prepareWorkspaceAccountStore(WS, { userId: INHABER, access: 'full' })).toEqual({ action: 'adopted_legacy' });

    expect(localStorage.getItem(buildLegacyWorkspaceStorageKey(WS))).toBeNull();
    const uebernommen = JSON.parse(localStorage.getItem(kontoSchluessel(INHABER, 'full'))!) as AppPersistedState;
    const outbox = uebernommen.syncOutbox!;
    // Inhalt, Status, Versuche, Reihenfolge: unverändert — dazu nur die Sperre.
    expect(outbox.map(ohneSperre)).toEqual(alt.syncOutbox);
    expect(outbox.filter((entry) => entry.hold).map((entry) => entry.id)).toEqual(['alt-offen-1', 'alt-offen-2']);
    expect(outbox[0].hold).toMatchObject({ reason: 'origin_unknown', source: 'legacy_adoption' });
    expect(outbox.every((entry) => entry.origin === undefined)).toBe(true);
    const spur = readOutboxOriginLog(kontoSchluessel(INHABER, 'full'));
    expect(spur).toHaveLength(1);
    expect(spur[0]).toMatchObject({ action: 'held', source: 'legacy_adoption' });
    expect(spur[0].entries.map((entry) => entry.outboxId)).toEqual(['alt-offen-1', 'alt-offen-2']);

    // Der Inhaber ist angemeldet und synchronisiert: nichts aus dem Altbestand geht hinaus.
    bereich(INHABER, 'full');
    const { client, sendungen } = ersatzClient({ konto: INHABER });
    const ergebnis = await new SupabaseSyncAdapter(client as never).pushChanges({
      deviceId: 'geraet-r2',
      workspaceId: WS,
      state: uebernommen,
      outbox,
    });
    expect(sendungen).toEqual([]);
    expect(ergebnis.completedOutboxIds).toEqual(['alt-lokal']);
    expect(ergebnis.heldOutboxIds).toEqual(['alt-offen-1', 'alt-offen-2']);
    expect(ergebnis.state.syncOutbox!.filter((entry) => entry.id !== 'alt-lokal')).toEqual(outbox.filter((entry) => entry.id !== 'alt-lokal'));
  });

  it('A2 Neustart: die Sperre übersteht Speichern und Laden; ein Kontobestand ohne Ursprungsangaben wird beim Laden gesperrt', () => {
    localStorage.setItem(buildLegacyWorkspaceStorageKey(WS), JSON.stringify(altbestand()));
    switchToWorkspaceScope(INHABER, WS, 'full', INHABER);
    expect(getSyncOutboxSnapshot().filter((entry) => entry.hold).map((entry) => entry.id)).toEqual(['alt-offen-1', 'alt-offen-2']);

    // Neustart desselben Kontos.
    switchToWorkspaceScope(INHABER, WS, 'full', INHABER);
    const geladen = getSyncOutboxSnapshot();
    expect(geladen.filter((entry) => entry.hold).map((entry) => entry.id)).toEqual(['alt-offen-1', 'alt-offen-2']);
    expect(geladen.find((entry) => entry.id === 'alt-abgewiesen')?.status).toBe('failed');

    // Ein Kontobestand aus der Zeit vor den Ursprungsangaben (etwa vom Mitglied angelegt): gesperrt beim Laden.
    localStorage.setItem(
      kontoSchluessel(MITGLIED, 'member'),
      JSON.stringify(zustand({ documents: [dokument('doc-m-1')], syncOutbox: [auftrag('m-offen', 'doc-m-1')] })),
    );
    switchToWorkspaceScope(MITGLIED, WS, 'member', INHABER);
    const mitglied = getSyncOutboxSnapshot();
    expect(mitglied).toHaveLength(1);
    expect(mitglied[0].hold).toMatchObject({ reason: 'origin_unknown', source: 'load' });
    const gespeichert = JSON.parse(localStorage.getItem(kontoSchluessel(MITGLIED, 'member'))!) as AppPersistedState;
    expect(gespeichert.syncOutbox![0].hold?.source).toBe('load');
    expect(readOutboxOriginLog(kontoSchluessel(MITGLIED, 'member'))[0]).toMatchObject({ action: 'held', source: 'load' });
  });

  it('A9 Wartung und Speichern nach dem Laden machen aus dem Altbestand keine neuen Aufträge und lösen keine Abweisung ab', async () => {
    // Altbestand aus einer älteren Fassung: Den Dokumenten fehlen Felder, die das Laden heute ergänzt
    // (linkedInvoiceId, linkedLetterId, linkedOfferId) — ein reiner Formunterschied.
    const alt = altbestand();
    expect(alt.documents!.every((doc) => !('linkedInvoiceId' in doc))).toBe(true);
    localStorage.setItem(buildLegacyWorkspaceStorageKey(WS), JSON.stringify(alt));
    const wartung = vi.spyOn(persistence, 'persistAll');

    switchToWorkspaceScope(INHABER, WS, 'full', INHABER);
    const nachLaden = getSyncOutboxSnapshot();
    await vi.waitFor(() => expect(wartung).toHaveBeenCalled());
    persistence.persistAll();

    const danach = getSyncOutboxSnapshot();
    expect(danach.map((entry) => entry.id)).toEqual(nachLaden.map((entry) => entry.id));
    expect(danach).toEqual(nachLaden);
    expect(danach.find((entry) => entry.id === 'alt-abgewiesen')?.status).toBe('failed');
    expect(danach.filter((entry) => entry.origin)).toEqual([]);
  });

  it('A10 die Wartung nach dem Laden (Dateihash nachgetragen) löst eine endgültige Abweisung nicht ab', async () => {
    const datei = {
      id: 'ref-alt-1',
      originalFileName: 'alt-beleg.pdf',
      mimeType: 'application/pdf',
      fileSize: 9,
      storageType: 'local_data_url',
      localDataKey: 'blob-alt-1',
      createdAt: JETZT,
      lifecycleStatus: 'committed',
      committedAt: JETZT,
      sync: { version: 1, updatedAt: JETZT, deleted: false, deviceId: 'geraet-r2', workspaceId: WS },
    };
    const alt = zustand({
      documentFileRefs: [datei],
      documentFileBlobs: { 'blob-alt-1': 'data:application/pdf;base64,JVBERi0xLjQK' },
      syncOutbox: [
        auftrag('datei-abgewiesen', 'ref-alt-1', {
          entityType: 'document_file',
          operation: 'update',
          version: 1,
          status: 'failed',
          lastErrorMessage: 'Keine Schreibberechtigung',
          lastErrorRetryable: false,
        }),
      ],
    } as Partial<AppPersistedState>);
    localStorage.setItem(buildLegacyWorkspaceStorageKey(WS), JSON.stringify(alt));
    const speichern = vi.spyOn(persistence, 'persistAll');

    switchToWorkspaceScope(INHABER, WS, 'full', INHABER);
    await vi.waitFor(() => expect(speichern).toHaveBeenCalled());

    // Die Wartung hat wirklich etwas geändert (Hash nachgetragen) …
    expect(getDocumentFileRefStoreSnapshot().find((ref) => ref.id === 'ref-alt-1')?.contentHash).toBeTruthy();
    // … aber die endgültige Abweisung bleibt das letzte Wort: kein neuer, sendbarer Auftrag.
    const auftraege = getSyncOutboxSnapshot().filter((entry) => entry.entityId === 'ref-alt-1');
    expect(auftraege.map((entry) => [entry.id, entry.status])).toEqual([['datei-abgewiesen', 'failed']]);
  });

  it('A6 ein Mitglied übernimmt den Altbestand nie — er bleibt bytegleich liegen', () => {
    localStorage.setItem(buildLegacyWorkspaceStorageKey(WS), JSON.stringify(altbestand()));
    const vorher = localStorage.getItem(buildLegacyWorkspaceStorageKey(WS));

    expect(prepareWorkspaceAccountStore(WS, { userId: MITGLIED, access: 'member' })).toEqual({ action: 'kept_legacy' });
    expect(localStorage.getItem(buildLegacyWorkspaceStorageKey(WS))).toBe(vorher);
    expect(localStorage.getItem(kontoSchluessel(MITGLIED, 'member'))).toBeNull();
    expect(localStorage.getItem(buildOutboxOriginLogKey(kontoSchluessel(MITGLIED, 'member')))).toBeNull();
  });
});

describe('DOKUMENTE-01 R2 — Ursprung neuer Aufträge', () => {
  it('A3 neue Aufträge tragen ihr Konto und gehen hinaus; fremdes Konto, fremder Betrieb, breitere Sicht nicht', async () => {
    bereich(INHABER, 'full');
    const neu = enqueueSyncOutbox({ entityType: 'document', entityId: 'doc-neu', operation: 'create', version: 0 });
    expect(neu.origin).toEqual({ userId: INHABER, workspaceId: WS, access: 'full' });

    const identitaet = { accountUserId: INHABER, sessionUserId: INHABER, scopeWorkspaceId: WS, access: 'full' as const };
    expect(heldOutboxReason({ origin: { userId: MITGLIED, workspaceId: WS, access: 'member' } }, identitaet)).toBe('foreign_origin');
    expect(heldOutboxReason({ origin: { userId: INHABER, workspaceId: 'ws-anders', access: 'full' } }, identitaet)).toBe('foreign_workspace');
    expect(
      heldOutboxReason({ origin: { userId: INHABER, workspaceId: WS, access: 'full' } }, { ...identitaet, access: 'member' }),
    ).toBe('foreign_access');
    // Ein Auftrag, der sein Konto nennt, geht nur in einem Lauf hinaus, der dieses Konto nachweist.
    expect(
      heldOutboxReason({ origin: { userId: INHABER } }, { accountUserId: null, sessionUserId: undefined, scopeWorkspaceId: null, access: null }),
    ).toBe('foreign_origin');

    const fremd: SyncOutboxOrigin = { userId: MITGLIED, workspaceId: WS, access: 'member' };
    const outbox = [{ ...neu }, auftrag('fremd-1', 'doc-fremd', { origin: fremd })];
    const { client, sendungen } = ersatzClient({ konto: INHABER });
    const ergebnis = await new SupabaseSyncAdapter(client as never).pushChanges({
      deviceId: 'geraet-r2',
      workspaceId: WS,
      state: zustand({ documents: [dokument('doc-neu'), dokument('doc-fremd')], syncOutbox: outbox }),
      outbox,
    });
    expect(sendungen).toEqual([{ konto: INHABER, id: 'doc-neu' }]);
    expect(ergebnis.heldOutboxIds).toEqual(['fremd-1']);
  });

  it('A7 eine neue Änderung an einem gesperrten Auftrag gibt ihn nicht still frei', async () => {
    localStorage.setItem(buildLegacyWorkspaceStorageKey(WS), JSON.stringify(altbestand()));
    switchToWorkspaceScope(INHABER, WS, 'full', INHABER);

    const zusammengefuehrt = enqueueSyncOutbox({ entityType: 'document', entityId: 'doc-alt-1', operation: 'update', version: 3 });
    expect(zusammengefuehrt.id).toBe('alt-offen-1');
    expect(zusammengefuehrt.hold).toMatchObject({ reason: 'origin_unknown' });
    expect(zusammengefuehrt.origin).toBeUndefined();

    const { client, sendungen } = ersatzClient({ konto: INHABER });
    await new SupabaseSyncAdapter(client as never).pushChanges({
      deviceId: 'geraet-r2',
      workspaceId: WS,
      state: persistence.buildPersistedStateSnapshot(),
      outbox: getSyncOutboxSnapshot(),
    });
    expect(sendungen).toEqual([]);
  });
});

describe('DOKUMENTE-01 R2 — bewusste Prüfung und Freigabe', () => {
  function uebernehmenUndLaden(): void {
    localStorage.setItem(buildLegacyWorkspaceStorageKey(WS), JSON.stringify(altbestand()));
    switchToWorkspaceScope(INHABER, WS, 'full', INHABER);
  }

  it('A4 Freigabe durch das angemeldete Konto: nur die geprüften Aufträge, mit Prüfspur, danach genau einmal gesendet', async () => {
    uebernehmenUndLaden();
    angemeldet(INHABER);

    const vorschau = getSyncUiSnapshot().heldOutboxEntries ?? [];
    expect(vorschau.map((entry) => [entry.id, entry.entityType, entry.operation, entry.source])).toEqual([
      ['alt-offen-1', 'document', 'create', 'legacy_adoption'],
      ['alt-offen-2', 'document', 'create', 'legacy_adoption'],
    ]);
    expect(vorschau[0].label).toBe('R2 synthetisch doc-alt-1');

    await expect(releaseHeldOutboxEntriesFromUi(['alt-offen-1'])).resolves.toEqual({ ok: true, released: 1 });

    const freigegeben = getSyncOutboxSnapshot().find((entry) => entry.id === 'alt-offen-1')!;
    expect(freigegeben.hold).toBeUndefined();
    expect(freigegeben.origin).toEqual({ userId: INHABER, workspaceId: WS, access: 'full' });
    expect(freigegeben.originAssignment).toMatchObject({ by: INHABER, previous: 'origin_unknown' });
    expect(freigegeben.status).toBe('pending');
    expect(getSyncOutboxSnapshot().find((entry) => entry.id === 'alt-offen-2')?.hold).toBeDefined();
    // Gespeichert, bevor gemeldet wird.
    const gespeichert = JSON.parse(localStorage.getItem(kontoSchluessel(INHABER, 'full'))!) as AppPersistedState;
    expect(gespeichert.syncOutbox!.find((entry) => entry.id === 'alt-offen-1')?.origin?.userId).toBe(INHABER);
    const spur = readOutboxOriginLog(kontoSchluessel(INHABER, 'full'));
    expect(spur.at(-1)).toMatchObject({ action: 'released', by: INHABER });
    expect(spur.at(-1)!.entries.map((entry) => entry.outboxId)).toEqual(['alt-offen-1']);

    const { client, sendungen } = ersatzClient({ konto: INHABER });
    const adapter = new SupabaseSyncAdapter(client as never);
    const erster = await adapter.pushChanges({
      deviceId: 'geraet-r2',
      workspaceId: WS,
      state: persistence.buildPersistedStateSnapshot(),
      outbox: getSyncOutboxSnapshot(),
    });
    expect(sendungen).toEqual([{ konto: INHABER, id: 'doc-alt-1' }]);
    expect(erster.heldOutboxIds).toEqual(['alt-offen-2']);
    await adapter.pushChanges({
      deviceId: 'geraet-r2',
      workspaceId: WS,
      state: persistence.buildPersistedStateSnapshot(),
      outbox: getSyncOutboxSnapshot(),
    });
    expect(sendungen).toHaveLength(1);
  });

  it('A5 abgelehnt: anderes Konto angemeldet, kein Kontobestand, nichts Gesperrtes, Speichern scheitert — nichts verändert', async () => {
    const speichern = vi.spyOn(persistence, 'persistAll');
    uebernehmenUndLaden();
    // Die Wartung nach dem Laden speichert einmal (aufbereitet); erst danach gilt der Vergleichsstand.
    await vi.waitFor(() => expect(speichern).toHaveBeenCalled());
    const vorher = getSyncOutboxSnapshot();
    const gespeicherteWarteschlange = () =>
      (JSON.parse(localStorage.getItem(kontoSchluessel(INHABER, 'full'))!) as AppPersistedState).syncOutbox;
    const gespeichertVorher = gespeicherteWarteschlange();

    angemeldet(MITGLIED);
    await expect(releaseHeldOutboxEntriesFromUi(['alt-offen-1'])).resolves.toEqual({ ok: false, reason: 'session_mismatch' });
    angemeldet(null);
    await expect(releaseHeldOutboxEntriesFromUi(['alt-offen-1'])).resolves.toEqual({ ok: false, reason: 'session_mismatch' });

    angemeldet(INHABER);
    await expect(releaseHeldOutboxEntriesFromUi(['alt-abgewiesen', 'gibt-es-nicht'])).resolves.toEqual({
      ok: false,
      reason: 'nothing_held',
    });

    speichern.mockReturnValue({ success: false });
    await expect(releaseHeldOutboxEntriesFromUi(['alt-offen-1'])).resolves.toEqual({ ok: false, reason: 'persist_failed' });

    expect(getSyncOutboxSnapshot()).toEqual(vorher);
    expect(gespeicherteWarteschlange()).toEqual(gespeichertVorher);
    expect(readOutboxOriginLog(kontoSchluessel(INHABER, 'full')).some((event) => event.action === 'released')).toBe(false);

    setActiveStorageScope({ type: 'guest' });
    await expect(releaseHeldOutboxEntriesFromUi(['alt-offen-1'])).resolves.toEqual({ ok: false, reason: 'no_account' });
  });
});

describe('DOKUMENTE-01 R2 — Anzeige und Koordinator', () => {
  it('A8 zurückgehalten zählt weder als wartend noch als Fehler; „Aktion erforderlich"; kein Lauf ihretwegen', async () => {
    localStorage.setItem(buildLegacyWorkspaceStorageKey(WS), JSON.stringify(altbestand()));
    switchToWorkspaceScope(INHABER, WS, 'full', INHABER);

    const snapshot = getSyncUiSnapshot();
    expect(snapshot.outboxCounts).toMatchObject({ pending: 1, error: 1, held: 2 });
    expect(snapshot.pendingOutboxEntries.map((entry) => entry.id)).toEqual(['alt-lokal']);
    expect(snapshot.failedOutboxEntries.map((entry) => entry.id)).toEqual(['alt-abgewiesen']);
    expect(snapshot.hasRetryableErrors).toBe(false);

    const ohneAbgewiesenes = getSyncOutboxSnapshot().filter((entry) => entry.id !== 'alt-abgewiesen');
    const summary = summarizeSyncStatus({ ...snapshot, outbox: ohneAbgewiesenes, status: { ...snapshot.status, syncState: 'synced' } });
    expect(summary).toMatchObject({ kind: 'held', heldCount: 2, waitingCount: 0, failedCount: 0 });
    expect(
      deriveSyncIndicatorState({ online: true, staleTab: false, summary, outbox: ohneAbgewiesenes, scheduler: null }),
    ).toBe('action');

    const pushChanges = vi.fn();
    const koordinator = new SyncCoordinator({ pushChanges } as never);
    const nurGesperrt = zustand({ syncOutbox: ohneAbgewiesenes.filter((entry) => entry.hold) });
    const ergebnis = await koordinator.runPushOnly(nurGesperrt);
    expect(pushChanges).not.toHaveBeenCalled();
    expect(ergebnis.skipPersist).toBe(true);
  });
});
