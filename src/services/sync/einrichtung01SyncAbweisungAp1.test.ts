/**
 * EINRICHTUNG-01 (AP1, Verträge 1.7 bis 1.9) — die neuen Serverabweisungen der zentralen Zugriffsregel im Sync.
 *
 * Geprüft am echten Sendeweg (SupabaseSyncAdapter mit Ersatz-Client: Sitzung lesbar, `rpc` antwortet wie der
 * Server) und an der echten Einordnung der Cloud-Fehler (`rpcUpsertWorkspaceSyncEntity`):
 *
 *   V1 (N-Z4.4) Abweisung `license_not_effective`: kein lokaler Erfolg, Auftrag endgültig abgewiesen (`failed`)
 *      mit Herkunft und unverändertem Inhalt.
 *   V2 (N-Z4.5) danach Lizenz verlängert, der Server nimmt wieder an: Weitere Läufe holen den Auftrag nicht nach.
 *      Eine neue, bewusste Änderung ist ein neuer Auftrag und geht hinaus.
 *   V3 ebenso die Lizenzcodes der Finanzwege und die fehlende Freigabe.
 *   V4 (Vertrag 1.8) beendete Sitzung `session_not_active`: nie endgültig. Der Auftrag bleibt beim Ursprung,
 *      kein automatischer Wiederholungstakt; nach der Anmeldung desselben Kontos geht er genau einmal hinaus,
 *      unter einem anderen Konto nie.
 *   V5 (Vertrag 1.9) gleichzeitige Rechteänderung `workspace_access_changed` (40001): wiederholbar.
 *   V6 Einordnung der Servermeldung selbst.
 *
 * Kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { AppPersistedState, CompanyDocument } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';
import { STORAGE_VERSION } from './syncMigrationService';
import { createSyncClient, resetSyncClientForTests } from './syncClientService';
import { enqueueSyncOutbox, getSyncOutboxSnapshot, resetSyncOutboxForTests } from './syncOutboxService';
import { SupabaseSyncAdapter } from './supabaseSyncAdapter';
import { resetSyncCoordinatorForTests } from './syncCoordinator';
import { classifySyncRun } from './syncScheduler';
import {
  isFinalPermissionDenialMessage,
  isFinallyDeniedOutboxEntry,
  isRoleDenialMessage,
  isSessionNotActiveMessage,
  isWorkspaceAccessChangedMessage,
} from './syncRoleDenial';
import { resetStorageScopeForTests, setActiveStorageScope } from '../storage/storageScopeService';
import { WorkspaceCloudError, rpcUpsertWorkspaceSyncEntity } from '../workspace/workspaceCloudService';
import * as supabaseLib from '../../lib/supabase';

const WS = 'ws-ein01-ap1-sync';
const KONTO = 'konto-ein01-a1';
const ANDERES_KONTO = 'konto-ein01-b1';
const JETZT = '2026-10-23T12:00:00.000Z';

const LIZENZ = 'license_not_effective: Die Lizenz des Betriebs ist nicht wirksam';
const SITZUNG = 'session_not_active: Die Sitzung ist beendet';
const GLEICHZEITIG = 'workspace_access_changed: Die Rechte wurden gleichzeitig geaendert';

type ServerAntwort = 'ok' | { message: string; code: string };

beforeEach(() => {
  localStorage.clear();
  resetStorageScopeForTests();
  resetSyncOutboxForTests([]);
  resetSyncClientForTests({ ...createSyncClient(), serverWorkspaceId: WS, workspaceId: WS });
  resetSyncCoordinatorForTests();
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  setActiveStorageScope({ type: 'workspace', workspaceId: WS, account: { userId: KONTO, access: 'full' } });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetStorageScopeForTests();
});

function dokument(id: string): CompanyDocument {
  return {
    id,
    title: `EINRICHTUNG-01 synthetisch ${id}`,
    category: 'sonstiges',
    issuer: 'AP1 Prüfung',
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
    sync: { version: 0, updatedAt: JETZT, deleted: false, deviceId: 'geraet-ein01', workspaceId: WS },
  } as unknown as CompanyDocument;
}

function zustand(outbox: SyncOutboxEntry[], documents: CompanyDocument[]): AppPersistedState {
  return {
    version: STORAGE_VERSION,
    invoiceEntries: [],
    syncClient: { ...createSyncClient(), serverWorkspaceId: WS, workspaceId: WS },
    syncOutbox: outbox,
    setup: DEFAULT_SETUP,
    vorgaenge: [],
    customers: [],
    inboxItems: [],
    tasks: [],
    documents,
    savedAt: JETZT,
  } as AppPersistedState;
}

/** Der Server und die Sitzung des Geräts; beides lässt sich zwischen den Läufen ändern. */
function geraet() {
  const lage: { konto: string | null; antwort: ServerAntwort } = { konto: KONTO, antwort: 'ok' };
  const sendungen: Array<{ konto: string | null; dokument: string }> = [];
  const client = {
    auth: {
      getSession: async () => ({
        data: { session: lage.konto ? { user: { id: lage.konto }, access_token: `zugang-${lage.konto}` } : null },
      }),
    },
    rpc: async (_name: string, args: Record<string, unknown>) => {
      const payload = (args.p_payload ?? {}) as Record<string, unknown>;
      sendungen.push({ konto: lage.konto, dokument: String(payload.client_document_id) });
      if (lage.antwort === 'ok') return { data: { row_version: 1, deleted: false, payload: args.p_payload }, error: null };
      return { data: null, error: lage.antwort };
    },
  };
  const adapter = new SupabaseSyncAdapter(client as never);
  let documents = [dokument('doc-1')];
  return {
    lage,
    sendungen,
    /** Ein automatischer Lauf über die gespeicherte Warteschlange; das Ergebnis wird wie in der App übernommen. */
    async lauf() {
      const outbox = getSyncOutboxSnapshot();
      const ergebnis = await adapter.pushChanges({ deviceId: 'geraet-ein01', workspaceId: WS, state: zustand(outbox, documents), outbox });
      resetSyncOutboxForTests(ergebnis.state.syncOutbox ?? []);
      documents = (ergebnis.state.documents ?? documents) as CompanyDocument[];
      return ergebnis;
    },
    dokument: () => documents.find((doc) => doc.id === 'doc-1')!,
  };
}

function auftragZu(id: string): SyncOutboxEntry {
  const entry = getSyncOutboxSnapshot().find((item) => item.id === id);
  if (!entry) throw new Error(`Auftrag ${id} fehlt`);
  return entry;
}

function lageNach(report: Awaited<ReturnType<ReturnType<typeof geraet>['lauf']>>) {
  return classifySyncRun(
    { errorCount: report.failedOutbox.length, errors: report.failedOutbox.map((f) => ({ outboxId: f.outboxId, message: f.message })) } as never,
    getSyncOutboxSnapshot(),
  );
}

describe('EINRICHTUNG-01 AP1 — Lizenzabweisung ist endgültig (Vertrag 1.7)', () => {
  it('V1 (N-Z4.4) license_not_effective: kein lokaler Erfolg, endgültig abgewiesen mit Herkunft und unverändertem Inhalt', async () => {
    const g = geraet();
    const neu = enqueueSyncOutbox({ entityType: 'document', entityId: 'doc-1', operation: 'create', version: 0 });
    expect(neu.origin).toEqual({ userId: KONTO, workspaceId: WS, access: 'full' });

    g.lage.antwort = { message: LIZENZ, code: '42501' };
    const ergebnis = await g.lauf();

    expect(ergebnis.failedOutbox).toEqual([{ outboxId: neu.id, message: LIZENZ, retryable: false }]);
    expect(ergebnis.completedOutboxIds).not.toContain(neu.id);
    const danach = auftragZu(neu.id);
    expect(danach).toMatchObject({ status: 'failed', lastErrorMessage: LIZENZ, lastErrorRetryable: false });
    expect(isFinallyDeniedOutboxEntry(danach)).toBe(true);
    // Herkunft und Inhalt des Auftrags bleiben, nur Status und Ablehnung kommen dazu.
    const { status: _s, retryCount: _r, lastErrorMessage: _m, lastErrorAt: _a, lastErrorRetryable: _x, ...kernDanach } = danach;
    const { status: _s0, retryCount: _r0, ...kernVorher } = neu;
    expect(kernDanach).toEqual(kernVorher);
    // Kein lokaler Erfolg: Die Synchronisationsangaben des Dokuments bleiben unbestätigt.
    expect(g.dokument().sync?.version).toBe(0);
    // Kein Wiederholungstakt für diese Abweisung.
    expect(lageNach(ergebnis)).toBe('stop');
  });

  it('V2 (N-Z4.5) nach der Lizenzverlängerung wird der Auftrag nicht nachgeholt; eine neue bewusste Änderung geht hinaus', async () => {
    const g = geraet();
    const alt = enqueueSyncOutbox({ entityType: 'document', entityId: 'doc-1', operation: 'create', version: 0 });
    g.lage.antwort = { message: LIZENZ, code: '42501' };
    await g.lauf();
    expect(g.sendungen).toHaveLength(1);

    // Lizenz verlängert: Der Server nähme jetzt an. Automatische Läufe senden den alten Auftrag trotzdem nicht.
    g.lage.antwort = 'ok';
    await g.lauf();
    await g.lauf();
    expect(g.sendungen).toHaveLength(1);
    expect(auftragZu(alt.id).status).toBe('failed');

    // Eine neue, bewusste Änderung ist ein neuer Auftrag mit Herkunft; sie löst die Abweisung ab und geht hinaus.
    const neu = enqueueSyncOutbox({ entityType: 'document', entityId: 'doc-1', operation: 'update', version: 0 });
    expect(neu.id).not.toBe(alt.id);
    expect(neu.origin).toEqual({ userId: KONTO, workspaceId: WS, access: 'full' });
    const ergebnis = await g.lauf();
    expect(ergebnis.completedOutboxIds).toContain(neu.id);
    expect(g.sendungen).toEqual([
      { konto: KONTO, dokument: 'doc-1' },
      { konto: KONTO, dokument: 'doc-1' },
    ]);
  });

  it('V3 ebenso endgültig: Lizenzcodes der Finanzwege und fehlende Freigabe', async () => {
    for (const antwort of [
      { message: 'finance_license_expired: Lizenz ist abgelaufen', code: 'P0001' },
      { message: 'finance_license_inactive: Keine aktive Lizenz', code: 'P0001' },
      { message: 'account_not_approved: Konto ist nicht freigegeben', code: '42501' },
    ]) {
      resetSyncOutboxForTests([]);
      const g = geraet();
      const auftrag = enqueueSyncOutbox({ entityType: 'document', entityId: 'doc-1', operation: 'create', version: 0 });
      g.lage.antwort = antwort;
      await g.lauf();
      expect(auftragZu(auftrag.id), antwort.message).toMatchObject({ status: 'failed', lastErrorRetryable: false });
      g.lage.antwort = 'ok';
      await g.lauf();
      expect(g.sendungen, antwort.message).toHaveLength(1);
    }
  });
});

describe('EINRICHTUNG-01 AP1 — beendete Sitzung und gleichzeitige Rechteänderung sind nie endgültig', () => {
  it('V4 (Vertrag 1.8) session_not_active: Auftrag bleibt beim Ursprung; nach der Anmeldung desselben Kontos genau einmal gesendet', async () => {
    const g = geraet();
    const auftrag = enqueueSyncOutbox({ entityType: 'document', entityId: 'doc-1', operation: 'create', version: 0 });

    g.lage.antwort = { message: SITZUNG, code: '42501' };
    const abgewiesen = await g.lauf();
    expect(abgewiesen.failedOutbox).toEqual([{ outboxId: auftrag.id, message: SITZUNG, retryable: false }]);
    const danach = auftragZu(auftrag.id);
    expect(danach).toMatchObject({ status: 'error', lastErrorRetryable: false, origin: auftrag.origin });
    expect(isFinallyDeniedOutboxEntry(danach)).toBe(false);
    // Kein automatischer Wiederholungstakt, solange die Anmeldung fehlt.
    expect(lageNach(abgewiesen)).toBe('stop');

    // Ein anderes Konto meldet sich an: Der Auftrag geht unter dessen Zugang nicht hinaus (DOKUMENTE-01 R1).
    g.lage.konto = ANDERES_KONTO;
    g.lage.antwort = 'ok';
    await g.lauf();
    expect(g.sendungen).toHaveLength(1);
    expect(auftragZu(auftrag.id).status).toBe('error');

    // Dasselbe Konto meldet sich wieder an: Der Auftrag geht genau einmal hinaus.
    g.lage.konto = KONTO;
    const erfolgreich = await g.lauf();
    expect(erfolgreich.completedOutboxIds).toContain(auftrag.id);
    await g.lauf();
    expect(g.sendungen).toEqual([
      { konto: KONTO, dokument: 'doc-1' },
      { konto: KONTO, dokument: 'doc-1' },
    ]);
  });

  it('V5 (Vertrag 1.9) workspace_access_changed (40001): wiederholbar, der nächste Lauf sendet erneut', async () => {
    const g = geraet();
    const auftrag = enqueueSyncOutbox({ entityType: 'document', entityId: 'doc-1', operation: 'create', version: 0 });
    g.lage.antwort = { message: GLEICHZEITIG, code: '40001' };
    const ergebnis = await g.lauf();
    expect(ergebnis.failedOutbox).toEqual([{ outboxId: auftrag.id, message: GLEICHZEITIG, retryable: true }]);
    expect(auftragZu(auftrag.id)).toMatchObject({ status: 'error', lastErrorRetryable: true });
    expect(lageNach(ergebnis)).toBe('retryable');

    g.lage.antwort = 'ok';
    const danach = await g.lauf();
    expect(danach.completedOutboxIds).toContain(auftrag.id);
    expect(g.sendungen).toHaveLength(2);
  });
});

describe('EINRICHTUNG-01 AP1 — Einordnung der Servermeldung', () => {
  async function einordnung(error: { message: string; code: string }) {
    const client = { rpc: async () => ({ data: null, error }) };
    try {
      await rpcUpsertWorkspaceSyncEntity(WS, 'document', {}, 0, client as never);
    } catch (fehler) {
      expect(fehler).toBeInstanceOf(WorkspaceCloudError);
      const cloud = fehler as WorkspaceCloudError;
      return { code: cloud.code, retryable: cloud.retryable };
    }
    throw new Error('keine Abweisung');
  }

  it('V6 Sitzung → Anmeldung; gleichzeitige Änderung → wiederholbar; Entzugs- und Lizenzcodes → nicht wiederholbar', async () => {
    expect(await einordnung({ message: SITZUNG, code: '42501' })).toEqual({ code: 'auth', retryable: false });
    expect(await einordnung({ message: GLEICHZEITIG, code: '40001' })).toEqual({ code: 'unknown', retryable: true });
    expect(await einordnung({ message: 'could not serialize access', code: '40001' })).toEqual({ code: 'unknown', retryable: true });
    for (const message of [
      LIZENZ,
      'account_not_approved: Konto ist nicht freigegeben',
      'account_blocked: Konto ist gesperrt',
      'workspace_not_member: Kein Zugriff auf Workspace',
      'workspace_forbidden_role: Keine Schreibberechtigung',
    ]) {
      expect(await einordnung({ message, code: '42501' }), message).toEqual({ code: 'rls', retryable: false });
    }
    expect(await einordnung({ message: 'Nicht angemeldet', code: '42501' })).toEqual({ code: 'auth', retryable: false });
  });

  it('V6b die Meldungsregeln: Sitzung und gleichzeitige Änderung sind weder endgültig noch Rollenabweisung', () => {
    for (const message of [SITZUNG, `${SITZUNG} (Kein Zugriff auf Workspace)`, GLEICHZEITIG]) {
      expect(isFinalPermissionDenialMessage(message), message).toBe(false);
      expect(isRoleDenialMessage(message), message).toBe(false);
    }
    expect(isSessionNotActiveMessage(SITZUNG)).toBe(true);
    expect(isWorkspaceAccessChangedMessage(GLEICHZEITIG)).toBe(true);
    for (const message of [LIZENZ, 'finance_license_expired: Lizenz ist abgelaufen', 'account_not_approved: Konto ist nicht freigegeben']) {
      expect(isFinalPermissionDenialMessage(message), message).toBe(true);
    }
  });
});
