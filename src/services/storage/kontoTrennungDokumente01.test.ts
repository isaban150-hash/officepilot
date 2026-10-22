/**
 * DOKUMENTE-01 N1 — Kontotrennung des lokalen Betriebsbestands.
 *
 * WEISS-Befund: Meldete sich im selben Browser nach dem Inhaber ein Mitglied an,
 * lud es den gemeinsamen Betriebsbestand — fremde Archivdokumente, Dateien,
 * Vorschauen, die Warteschlange mit fremden Schreibaufträgen und fünf
 * Papierregister-Einträge, die der Altbestand-Abgleich zum Senden einreihte.
 *
 * Geprüft wird über die echten Lade- und Speicherwege (Bootstrap, Persistenz,
 * IndexedDB):
 *   K1  Schlüssel je Konto und Sicht; Altbestand ausdrücklich; Notfall-Inventar.
 *   K2  Inhaber → Mitglied → Inhaber: keine fremden Dokumente, Aufträge, Dateien,
 *       Vorschauen oder Papiereinträge; Ungesendetes des Inhabers bleibt erhalten.
 *   K3  Altbestand: nur ein Konto mit voller Sicht übernimmt ihn, einmal; ein
 *       Mitglied nie und fasst ihn auch nicht an; nichts wird gelöscht. Geschäftsdaten
 *       aus dem Nutzerbereich bringt nur der Inhaber mit.
 *   K4  Rollenentzug und Aufstieg: Mitgliedssicht lädt nie den Bestand mit voller
 *       Sicht; Ungesendetes aus der Admin-Zeit bleibt und läuft bei voller Sicht weiter.
 *   K5  Papierregister-Abgleich: im Mitgliedsbestand gibt es nichts Fremdes zum Senden.
 *   K6  Hinweis-Auswahl gilt je Konto.
 *   K7  Sicht aus der Mitgliedschaft; Übernahme scheitert ohne Verlust.
 *   K8  Ein Synchronisationslauf, der nach dem Kontowechsel endet, schreibt nicht in den neuen Bereich.
 *   K9  Briefvorbelegung und Antwortübergabe im Navigationszustand gelten nur im eigenen Bereich.
 */
import { useDocumentBlobDatabaseReset } from '../../test/documentBlobTestReset';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetTestStores } from '../../test/resetStores';
import { bootstrapBusinessState, isolateBusinessStateOnLogout } from './storageBootstrapService';
import {
  LEGACY_QUARANTINE_PREFIX,
  buildLegacyWorkspaceStorageKey,
  buildStorageKey,
  getActiveStorageScope,
  resetStorageScopeForTests,
  setActiveStorageScope,
  type StorageAccess,
} from './storageScopeService';
import { buildDocumentBlobScopeKey, parseDocumentBlobScopeKey } from './documentBlobScopeService';
import {
  accessForMembership,
  prepareWorkspaceAccountStore,
  resolveSessionAccount,
} from './workspaceAccountStorageService';
import { listLocalScopeStorageKeys } from './localScopeInventoryService';
import { buildScopeKeyFromStorageKey } from './localScopeBlobInventoryService';
import { readDocumentBlob, saveDocumentBlob } from './documentBlobIndexedDbService';
import { buildPersistedStateSnapshot, createSeedState, persistAll, savePersistedStateToKey } from '../persistenceService';
import { applySyncPullCandidateSafely, captureSyncRunBase } from '../sync/syncPullPersistService';
import { createEmptySyncSimulationReport } from '../sync/syncSimulationReportService';
import type { SyncCoordinatorReport } from '../../types/sync';
import {
  createLetterDraftPrefillLocationState,
  readLetterDraftPrefillFromLocationState,
} from '../document/documentReplyBridgeService';
import {
  buildDocumentReplyDraftHandoffPayload,
  createDocumentReplyDraftHandoffLocationState,
  readDocumentReplyDraftHandoffFromLocationState,
} from '../documentReplyDraftHandoffService';
import { createAuftragInboxItem } from '../../test/fixtures';
import { getDocumentStoreSnapshot, hydrateDocumentStore } from '../documentService';
import { enqueueSyncOutbox, getSyncOutboxSnapshot } from '../sync/syncOutboxService';
import { buildBlobFallbackScopes } from '../documentFileStoreService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
} from '../documentFileRepresentationBindingStoreService';
import { dismissHomeHint, isHomeHintVisible } from '../homeHintDismissalService';
import { getPaperRegisterEntries } from '../officePilotMemoryService';
import { planPaperRegisterEntryBackfill } from '../memory/paperRegisterCloudService';
import { withNewEntitySync } from '../sync/syncMetaService';
import type { AppPersistedState, CompanyDocument } from '../../types/models';
import type { PaperRegisterEntry } from '../../types/memory';

const WS = 'ws-dok01-n1';
const INHABER = 'konto-inhaber-n1';
const MITGLIED = 'konto-mitglied-n1';
const ADMIN = 'konto-admin-n1';

useDocumentBlobDatabaseReset();

afterEach(() => {
  vi.restoreAllMocks();
  resetTestStores();
  resetStorageScopeForTests();
  localStorage.clear();
});

function anmelden(userId: string, access: StorageAccess) {
  return bootstrapBusinessState({ userId, workspaceId: WS, access });
}

function abmelden(): void {
  isolateBusinessStateOnLogout();
}

function dokument(id: string, title: string, fileRefId?: string): CompanyDocument {
  return withNewEntitySync(
    {
      id,
      title,
      category: 'sonstiges',
      issuer: 'Baustoffe Beispiel KG',
      recognizedText: `${title} — vertraulicher Inhalt`,
      issueDate: null,
      validUntil: null,
      digitalFolder: { id: 'rechnungen', name: 'Rechnungen', path: '/rechnungen' },
      paperFolder: { folderId: 'rechnungen', register: 'B', label: 'Rechnungen' },
      tags: [],
      linkedCompany: 'Baustoffe Beispiel KG',
      linkedVorgang: null,
      archived: false,
      createdAt: '2026-10-20T08:00:00.000Z',
      ...(fileRefId ? { fileRefId } : {}),
    },
    'document',
  );
}

/** Eine lokale Aktion: Dokument anlegen und zum Senden einreihen, dann speichern. */
function dokumentAnlegen(id: string, title: string): void {
  hydrateDocumentStore([...getDocumentStoreSnapshot(), dokument(id, title)]);
  enqueueSyncOutbox({ entityType: 'document', entityId: id, operation: 'create', version: 0 });
  persistAll();
}

function dokumentIds(): string[] {
  return getDocumentStoreSnapshot().map((doc) => doc.id).sort();
}

function auftragsIds(): string[] {
  return getSyncOutboxSnapshot().map((entry) => entry.entityId).sort();
}

function betriebsSchluessel(): string[] {
  return Object.keys(localStorage)
    .filter((key) => key.startsWith('officepilot-state:workspace:'))
    .filter((key) => /^officepilot-state:workspace:[^:]+(:account:[^:]+:(full|member))?$/.test(key))
    .sort();
}

function papierEintrag(documentId: string, version: number): PaperRegisterEntry {
  return {
    id: `paper-reg-${documentId}`,
    documentId,
    documentTitle: `Titel ${documentId}`,
    folderId: 'rechnungen',
    register: 'B',
    physicalFiled: false,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-20T08:00:00.000Z',
    sync: {
      updatedAt: '2026-10-20T08:00:00.000Z',
      version,
      deleted: false,
      deviceId: 'geraet-n1',
      workspaceId: WS,
    },
  };
}

/** Ein Betriebsbestand wie nach Abzug und Arbeit eines Kontos. */
function bestand(documents: CompanyDocument[], paper: PaperRegisterEntry[] = []): AppPersistedState {
  const seed = createSeedState();
  return {
    ...seed,
    documents,
    officePilotMemory: {
      documentMemories: [],
      proofMemories: [],
      relations: [],
      ...(seed.officePilotMemory ?? {}),
      paperRegisterEntries: paper,
    },
  };
}

describe('K1 — Schlüssel je Konto und Sicht', () => {
  it('K1a Zustand und Dateien: Kontoschlüssel, geerbtes aktives Konto, ausdrücklicher Altbestand', () => {
    const konto = { userId: INHABER, access: 'full' as const };
    expect(buildStorageKey({ type: 'workspace', workspaceId: WS, account: konto })).toBe(
      `officepilot-state:workspace:${WS}:account:${INHABER}:full`,
    );
    expect(buildDocumentBlobScopeKey({ type: 'workspace', workspaceId: WS, account: konto })).toBe(
      `workspace:${WS}:account:${INHABER}:full`,
    );
    // Ohne aktives Konto: der bisherige Betriebsschlüssel (Altbestand, Tests).
    expect(buildStorageKey({ type: 'workspace', workspaceId: WS })).toBe(`officepilot-state:workspace:${WS}`);

    // Ist der Betrieb mit Konto aktiv, bilden Aufrufer ohne Kontoangabe (z. B. die
    // Rechnungsvorprüfung) denselben Kontoschlüssel — ausdrücklich `null` bleibt Altbestand.
    setActiveStorageScope({ type: 'workspace', workspaceId: WS, account: { userId: MITGLIED, access: 'member' } });
    expect(buildStorageKey({ type: 'workspace', workspaceId: WS })).toBe(
      `officepilot-state:workspace:${WS}:account:${MITGLIED}:member`,
    );
    expect(buildDocumentBlobScopeKey({ type: 'workspace', workspaceId: WS })).toBe(
      `workspace:${WS}:account:${MITGLIED}:member`,
    );
    expect(buildStorageKey({ type: 'workspace', workspaceId: WS, account: null })).toBe(
      buildLegacyWorkspaceStorageKey(WS),
    );
    // Ein anderer Betrieb erbt das aktive Konto nicht.
    expect(buildStorageKey({ type: 'workspace', workspaceId: 'ws-anderer' })).toBe(
      'officepilot-state:workspace:ws-anderer',
    );
    expect(parseDocumentBlobScopeKey(`workspace:${WS}:account:${MITGLIED}:member`)).toEqual({
      type: 'workspace',
      workspaceId: WS,
      userId: MITGLIED,
      access: 'member',
    });
  });

  it('K1b Notfall-Inventar erkennt Kontobestände, Anhänge zählen weiter nicht', () => {
    const kontoKey = `officepilot-state:workspace:${WS}:account:${INHABER}:full`;
    localStorage.setItem(kontoKey, JSON.stringify(bestand([])));
    localStorage.setItem(`${kontoKey}:invoice-finalize-intents`, '{}');
    expect(listLocalScopeStorageKeys()).toEqual([kontoKey]);
    expect(buildScopeKeyFromStorageKey(kontoKey)).toBe(`workspace:${WS}:account:${INHABER}:full`);
    expect(buildScopeKeyFromStorageKey(`${kontoKey}:invoice-finalize-intents`)).toBeNull();
  });
});

describe('K2 — Kontowechsel im selben Browser', () => {
  it('K2a Inhaber → Mitglied → Inhaber: nichts Fremdes sichtbar oder versandbereit, Ungesendetes bleibt', () => {
    anmelden(INHABER, 'full');
    dokumentAnlegen('doc-inhaber-rechnung', 'Eingangsrechnung Baustoffe');
    expect(auftragsIds()).toEqual(['doc-inhaber-rechnung']);
    abmelden();

    anmelden(MITGLIED, 'member');
    expect(dokumentIds(), 'fremde Dokumente sichtbar').toEqual([]);
    expect(auftragsIds(), 'fremde Aufträge versandbereit').toEqual([]);
    dokumentAnlegen('doc-mitglied-quittung', 'Tankquittung');
    abmelden();

    anmelden(INHABER, 'full');
    expect(dokumentIds()).toEqual(['doc-inhaber-rechnung']);
    expect(auftragsIds(), 'ungesendete Aktion des Inhabers verloren').toEqual(['doc-inhaber-rechnung']);
    expect(getSyncOutboxSnapshot()[0]?.status).toBe('pending');
    abmelden();

    anmelden(MITGLIED, 'member');
    expect(dokumentIds()).toEqual(['doc-mitglied-quittung']);
    expect(auftragsIds()).toEqual(['doc-mitglied-quittung']);

    expect(betriebsSchluessel()).toEqual([
      `officepilot-state:workspace:${WS}:account:${INHABER}:full`,
      `officepilot-state:workspace:${WS}:account:${MITGLIED}:member`,
    ]);
    expect(localStorage.getItem(buildLegacyWorkspaceStorageKey(WS)), 'gemeinsamer Bestand entstanden').toBeNull();
  });

  it('K2b Dateien und Vorschauen: Bytes und Vorschau-Bindungen des Inhabers erreicht das Mitglied nicht', async () => {
    anmelden(INHABER, 'full');
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    await saveDocumentBlob({
      fileRefId: 'file-inhaber-original',
      blob: new Blob([bytes], { type: 'application/pdf' }),
      mimeType: 'application/pdf',
      fileSize: bytes.byteLength,
      contentHash: 'a'.repeat(64),
      createdAt: '2026-10-20T08:00:00.000Z',
    });
    hydrateDocumentFileRepresentationBindingStore([
      { documentId: 'doc-inhaber-rechnung', kind: 'preview', fileRefId: 'file-inhaber-vorschau' },
    ]);
    persistAll();
    abmelden();

    anmelden(MITGLIED, 'member');
    expect(await readDocumentBlob('file-inhaber-original')).toBeNull();
    for (const quelle of buildBlobFallbackScopes(getActiveStorageScope(), MITGLIED)) {
      expect(await readDocumentBlob('file-inhaber-original', quelle), `Rückfallbereich ${JSON.stringify(quelle)}`).toBeNull();
    }
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([]);
    abmelden();

    anmelden(INHABER, 'full');
    expect(await readDocumentBlob('file-inhaber-original')).not.toBeNull();
    expect(getDocumentFileRepresentationBindingStoreSnapshot()).toEqual([
      { documentId: 'doc-inhaber-rechnung', kind: 'preview', fileRefId: 'file-inhaber-vorschau' },
    ]);
  });
});

describe('K3 — Altbestand aus der Zeit vor der Kontotrennung', () => {
  it('K3a Mitglied übernimmt nie; der Inhaber (volle Sicht) einmal; danach beginnt ein Admin frisch', () => {
    const legacyKey = buildLegacyWorkspaceStorageKey(WS);
    savePersistedStateToKey(
      { type: 'workspace', workspaceId: WS, account: null },
      bestand([dokument('doc-alt-inhaber', 'Altbestand Rechnung')]),
    );
    const legacyRaw = localStorage.getItem(legacyKey);
    expect(legacyRaw).not.toBeNull();

    anmelden(MITGLIED, 'member');
    expect(dokumentIds(), 'Mitglied sieht Altbestand').toEqual([]);
    expect(localStorage.getItem(legacyKey), 'Altbestand verändert').toBe(legacyRaw);
    abmelden();

    anmelden(INHABER, 'full');
    expect(dokumentIds()).toEqual(['doc-alt-inhaber']);
    expect(localStorage.getItem(legacyKey), 'Altbestand doppelt').toBeNull();
    abmelden();

    anmelden(ADMIN, 'full');
    expect(dokumentIds(), 'Altbestand zweimal übernommen').toEqual([]);
  });

  it('K3b scheitert das Schreiben, bleibt der Altbestand unberührt und wird beim nächsten Mal übernommen', () => {
    const legacyKey = buildLegacyWorkspaceStorageKey(WS);
    localStorage.setItem(legacyKey, JSON.stringify(bestand([dokument('doc-alt', 'Alt')])));
    const legacyRaw = localStorage.getItem(legacyKey);
    const original = localStorage.setItem.bind(localStorage);
    const setItemSpy = vi.spyOn(localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key.includes(':account:')) throw new Error('QuotaExceeded');
      original(key, value);
    });

    expect(prepareWorkspaceAccountStore(WS, { userId: INHABER, access: 'full' })).toEqual({ action: 'write_failed' });
    expect(localStorage.getItem(legacyKey)).toBe(legacyRaw);

    setItemSpy.mockRestore();
    expect(prepareWorkspaceAccountStore(WS, { userId: INHABER, access: 'full' })).toEqual({ action: 'adopted_legacy' });
    expect(localStorage.getItem(`officepilot-state:workspace:${WS}:account:${INHABER}:full`)).toBe(legacyRaw);
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });

  it('K3c globaler Altbestand des Betriebs: das Mitglied lässt ihn liegen (keine Quarantäne), der Inhaber übernimmt ihn', () => {
    const global = {
      ...bestand([dokument('doc-global-alt', 'Bestand aus der Zeit vor den Konten')]),
      workspace: {
        id: WS,
        name: 'Beispiel Betrieb',
        ownerUserId: INHABER,
        createdAt: '2026-01-01T08:00:00.000Z',
        updatedAt: '2026-01-01T08:00:00.000Z',
        version: 1,
      },
    };
    localStorage.setItem('officepilot-state', JSON.stringify(global));
    const globalRaw = localStorage.getItem('officepilot-state');
    const quarantaene = () => Object.keys(localStorage).filter((key) => key.startsWith(LEGACY_QUARANTINE_PREFIX));

    anmelden(MITGLIED, 'member');
    expect(dokumentIds()).toEqual([]);
    expect(localStorage.getItem('officepilot-state'), 'globaler Altbestand angefasst').toBe(globalRaw);
    expect(quarantaene()).toEqual([]);
    abmelden();

    anmelden(INHABER, 'full');
    expect(dokumentIds()).toEqual(['doc-global-alt']);
    expect(localStorage.getItem('officepilot-state')).toBeNull();
  });

  it('K3d Nutzerbereich mit Geschäftsdaten: nur der Inhaber bringt ihn mit; Admin und Mitglied lassen ihn liegen', () => {
    const alterBetrieb = (userId: string) => {
      savePersistedStateToKey(
        { type: 'user', userId },
        bestand([dokument(`doc-nutzerbereich-${userId}`, 'Beleg aus einem eigenen früheren Betrieb')]),
      );
      return localStorage.getItem(`officepilot-state:user:${userId}`);
    };

    for (const [userId, access] of [
      [MITGLIED, 'member'],
      [ADMIN, 'full'],
    ] as const) {
      const vorher = alterBetrieb(userId);
      expect(vorher).not.toBeNull();
      bootstrapBusinessState({ userId, workspaceId: WS, access, ownerUserId: INHABER });
      expect(dokumentIds(), `${access}: Nutzerbereich in den Betrieb übernommen`).toEqual([]);
      expect(localStorage.getItem(`officepilot-state:user:${userId}`), `${access}: Nutzerbereich verändert`).toBe(vorher);
      abmelden();
    }

    alterBetrieb(INHABER);
    bootstrapBusinessState({ userId: INHABER, workspaceId: WS, access: 'full', ownerUserId: INHABER });
    expect(dokumentIds()).toEqual([`doc-nutzerbereich-${INHABER}`]);
    expect(localStorage.getItem(`officepilot-state:user:${INHABER}`)).toBeNull();
  });
});

describe('K4 — Rollenentzug und Aufstieg', () => {
  it('K4a Admin → Mitglied: eigener Mitgliedsbestand; zurück zu Admin: Ungesendetes läuft weiter', () => {
    anmelden(ADMIN, 'full');
    dokumentAnlegen('doc-fremd-sichtbar-als-admin', 'Rechnung eines anderen Kontos');
    abmelden();
    const vollerBestand = localStorage.getItem(`officepilot-state:workspace:${WS}:account:${ADMIN}:full`);

    anmelden(ADMIN, 'member');
    expect(dokumentIds(), 'nach Rollenentzug noch Admin-Bestand sichtbar').toEqual([]);
    expect(auftragsIds(), 'Admin-Aufträge laufen in Mitgliedssicht weiter').toEqual([]);
    abmelden();
    expect(localStorage.getItem(`officepilot-state:workspace:${WS}:account:${ADMIN}:full`)).toBe(vollerBestand);

    anmelden(ADMIN, 'full');
    expect(dokumentIds()).toEqual(['doc-fremd-sichtbar-als-admin']);
    expect(auftragsIds()).toEqual(['doc-fremd-sichtbar-als-admin']);
  });

  it('K4b Mitglied → Admin ohne vorigen Admin-Bestand: der Mitgliedsbestand wird übernommen', () => {
    anmelden(MITGLIED, 'member');
    dokumentAnlegen('doc-eigenes', 'Eigene Quittung');
    abmelden();

    anmelden(MITGLIED, 'full');
    expect(dokumentIds()).toEqual(['doc-eigenes']);
    expect(auftragsIds()).toEqual(['doc-eigenes']);
    expect(localStorage.getItem(`officepilot-state:workspace:${WS}:account:${MITGLIED}:member`)).toBeNull();
  });
});

describe('K5 — Papierregister-Abgleich nach dem Kontowechsel', () => {
  it('K5a im Mitgliedsbestand gibt es keine fremden Einträge, also keinen fremden Versand', () => {
    const inhaberEintraege = ['doc-a', 'doc-b', 'doc-c', 'doc-d', 'doc-e'].map((id) => papierEintrag(id, 1));
    savePersistedStateToKey(
      { type: 'workspace', workspaceId: WS, account: { userId: INHABER, access: 'full' } },
      bestand([], inhaberEintraege),
    );
    const mitgliedsZeilen = [
      {
        client_entry_id: 'paper-reg-doc-mitglied',
        client_document_id: 'doc-mitglied',
        payload: {},
        row_version: 1,
        deleted: false,
      },
    ];
    // Gegenprobe: wären die Inhaber-Einträge geladen, reihte der Abgleich alle fünf ein (WEISS-Befund).
    expect(planPaperRegisterEntryBackfill(inhaberEintraege, mitgliedsZeilen as never)).toHaveLength(5);

    anmelden(MITGLIED, 'member');
    expect(getPaperRegisterEntries()).toEqual([]);
    expect(planPaperRegisterEntryBackfill(getPaperRegisterEntries(), mitgliedsZeilen as never)).toEqual([]);
    abmelden();

    anmelden(INHABER, 'full');
    expect(getPaperRegisterEntries().map((entry) => entry.id).sort()).toEqual(
      inhaberEintraege.map((entry) => entry.id).sort(),
    );
  });
});

describe('K6 — Hinweis-Auswahl je Konto', () => {
  it('K6a „erledigt" des Inhabers verbirgt dem Mitglied nichts; der gemeinsame Schlüssel bleibt unangetastet', () => {
    const hinweis = 'home.hint.paperFile::title=Eingangsrechnung Baustoffe';
    localStorage.setItem('officepilot_home_hint_dismissals', JSON.stringify({ alt: { action: 'done', at: 'x' } }));
    const altRaw = localStorage.getItem('officepilot_home_hint_dismissals');

    anmelden(INHABER, 'full');
    dismissHomeHint(hinweis, 'done');
    expect(isHomeHintVisible(hinweis)).toBe(false);
    abmelden();

    anmelden(MITGLIED, 'member');
    expect(isHomeHintVisible(hinweis)).toBe(true);
    abmelden();

    anmelden(INHABER, 'full');
    expect(isHomeHintVisible(hinweis)).toBe(false);
    expect(localStorage.getItem('officepilot_home_hint_dismissals')).toBe(altRaw);
  });
});

describe('K8 — Synchronisationslauf über einen Kontowechsel hinweg', () => {
  const leererBericht = (): SyncCoordinatorReport => ({
    ...createEmptySyncSimulationReport('2026-10-20T08:00:00.000Z'),
    retryAttempts: 0,
    uploadCount: 0,
    downloadCount: 0,
  });

  it('K8a ein Lauf des Inhabers, der erst nach dem Wechsel endet, schreibt nichts in den Mitgliedsbereich', () => {
    anmelden(INHABER, 'full');
    dokumentAnlegen('doc-inhaber-lauf', 'Rechnung während des Laufs');
    // Laufstart im Bereich des Inhabers; sein Kandidat trägt Bestand und Warteschlange des Inhabers.
    const base = captureSyncRunBase();
    const kandidat = buildPersistedStateSnapshot();
    const inhaberKey = `officepilot-state:workspace:${WS}:account:${INHABER}:full`;
    const inhaberRaw = localStorage.getItem(inhaberKey);
    abmelden();

    anmelden(MITGLIED, 'member');
    const mitgliedKey = `officepilot-state:workspace:${WS}:account:${MITGLIED}:member`;
    const mitgliedRaw = localStorage.getItem(mitgliedKey);
    const ergebnis = applySyncPullCandidateSafely({ state: kandidat, report: leererBericht(), base });

    expect(ergebnis.persisted).toBe(false);
    expect(ergebnis.report.errors.map((entry) => entry.outboxId)).toEqual(['storage-scope-changed']);
    expect(ergebnis.report.errorCount, 'Fehlermeldung im neuen Konto').toBe(0);
    expect(dokumentIds(), 'Inhaberdokument im Mitgliedsbestand').toEqual([]);
    expect(auftragsIds(), 'Inhaberauftrag in der Mitgliedswarteschlange').toEqual([]);
    expect(localStorage.getItem(mitgliedKey)).toBe(mitgliedRaw);
    expect(localStorage.getItem(inhaberKey)).toBe(inhaberRaw);
  });

  it('K8b im selben Bereich wird der Kandidat wie bisher übernommen', () => {
    anmelden(INHABER, 'full');
    const base = captureSyncRunBase();
    const kandidat = { ...buildPersistedStateSnapshot(), documents: [dokument('doc-aus-cloud', 'Aus der Cloud')] };
    const ergebnis = applySyncPullCandidateSafely({ state: kandidat, report: leererBericht(), base });
    expect(ergebnis.persisted).toBe(true);
    expect(dokumentIds()).toEqual(['doc-aus-cloud']);
  });
});

describe('K9 — Inhalte im Navigationszustand des Tabs', () => {
  it('K9a Briefvorbelegung und Antwortübergabe gelten nur im Bereich, in dem sie entstanden', () => {
    anmelden(INHABER, 'full');
    const brief = createLetterDraftPrefillLocationState({
      subject: 'Ihr Schreiben vom 05.10.2026',
      body: 'Vertraulicher Antworttext des Inhabers',
      recipient: { name: 'Bauamt Musterstadt' },
    });
    const payload = buildDocumentReplyDraftHandoffPayload({
      item: createAuftragInboxItem({ id: 'inbox-inhaber-n1', title: 'Anfrage Bauvorhaben' }),
      draft: { body: 'Antwortentwurf des Inhabers', considered: [], notIncluded: [] },
      coreMessage: 'Antwortentwurf des Inhabers',
    });
    expect(payload).not.toBeNull();
    const antwort = createDocumentReplyDraftHandoffLocationState(payload!);
    expect(readLetterDraftPrefillFromLocationState(brief)?.body).toBe('Vertraulicher Antworttext des Inhabers');
    expect(readDocumentReplyDraftHandoffFromLocationState(antwort)?.draftText).toBe('Antwortentwurf des Inhabers');
    abmelden();

    // „Zurück" nach dem Kontowechsel: derselbe Verlaufseintrag, anderes Konto.
    anmelden(MITGLIED, 'member');
    expect(readLetterDraftPrefillFromLocationState(brief), 'Briefvorbelegung des Inhabers beim Mitglied').toBeNull();
    expect(readDocumentReplyDraftHandoffFromLocationState(antwort), 'Antwortentwurf des Inhabers beim Mitglied').toBeNull();
    // Ein Zustand ohne Stempel (Verlauf aus der Zeit vor N1) wird ebenfalls nicht übernommen.
    expect(
      readLetterDraftPrefillFromLocationState({
        officetaktLetterDraftPrefill: { subject: 'x', body: 'y', recipient: { name: 'z' } },
      }),
    ).toBeNull();
    abmelden();

    anmelden(INHABER, 'full');
    expect(readLetterDraftPrefillFromLocationState(brief)?.body).toBe('Vertraulicher Antworttext des Inhabers');
  });
});

describe('K7 — Sicht aus der Mitgliedschaft', () => {
  it('K7a nur aktive Mitgliedschaften; Inhaber und Admin voll, Mitglied eingeschränkt', () => {
    expect(accessForMembership({ role: 'owner', status: 'active' })).toBe('full');
    expect(accessForMembership({ role: 'admin', status: 'active' })).toBe('full');
    expect(accessForMembership({ role: 'member', status: 'active' })).toBe('member');
    expect(accessForMembership({ role: 'admin', status: 'removed' })).toBeNull();
    expect(accessForMembership({ role: 'member', status: 'invited' })).toBeNull();
    expect(accessForMembership(null)).toBeNull();
  });

  it('K7b das Konto muss genau einmal in der Liste stehen', () => {
    const zeile = (userId: string, role: 'owner' | 'admin' | 'member') => ({ userId, role, status: 'active' as const });
    expect(resolveSessionAccount([zeile(INHABER, 'owner'), zeile(MITGLIED, 'member')], MITGLIED)).toEqual({
      userId: MITGLIED,
      access: 'member',
    });
    expect(resolveSessionAccount([zeile(INHABER, 'owner')], MITGLIED)).toBeNull();
    expect(resolveSessionAccount([zeile(MITGLIED, 'admin'), zeile(MITGLIED, 'member')], MITGLIED)).toBeNull();
    expect(resolveSessionAccount([zeile(INHABER, 'owner')], null)).toBeNull();
  });
});
