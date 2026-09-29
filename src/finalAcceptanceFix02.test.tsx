/**
 * FINAL-ACCEPTANCE-FIX 02 — T1 Ansehen ist read-only, T2 Angebotsablauf.
 *
 * T1: Ein bestehendes Eingangsdokument (Liste, Detail, Heute, Assistent) zu
 *     öffnen schreibt kein Analyseergebnis, erzeugt keinen Sync-Auftrag und
 *     aktualisiert während des Renders keinen fremden Zustand. Legitime
 *     Schreibwege (erste Analyse eines neuen Dokuments, ausdrückliche Analyse)
 *     funktionieren weiter und behalten die Serverversion.
 * T2: Ablaufwarnungen nur für noch entscheidbare eigene Angebote.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { HeutePage } from './pages/HeutePage';
import { hydrateInboxStore, getInboxItemById } from './services/inboxService';
import {
  analyzeUploadedDocument,
  commitUploadedDocumentAnalysis,
  processUploadedDocument,
} from './services/intakeWorkflowService';
import {
  getDocumentWorkResult,
  upsertDocumentWorkResult,
} from './services/documentWorkResultService';
import { resetDocumentWorkResultStoreForTests } from './services/documentWorkResultStoreService';
import { buildProactiveHints } from './services/brain/companyProactiveHintsService';
import { buildDeskPriorities } from './services/deskIntelligenceService';
import { getCompanySession, recordInboxContext, resetCompanySessionForTests } from './services/brain/companySessionService';
import { createSyncClient, resetSyncClientForTests } from './services/sync/syncClientService';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests, subscribeSyncOutbox } from './services/sync/syncOutboxService';
import { resetSyncChangeTrackerForTests } from './services/sync/syncChangeTrackerService';
import * as persistenceService from './services/persistenceService';
import * as intakeCloudSyncService from './services/document/intakeCloudSyncService';
import { hydrateDocumentStore } from './services/documentService';
import { hydrateOffers } from './services/offer/offerService';
import { scanExpiringDocuments, scanPendingItems } from './services/pendingEngineService';
import { buildDailyPriorityAnswer } from './services/brain/dailyPriorityResolver';
import { resetTestStores } from './test/resetStores';
import { createAuftragInboxItem, createMaterialInboxItem } from './test/fixtures';
import type { InboxItem } from './types/models';
import type { Offer, OfferStatus } from './types/offer';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

/* ------------------------------------------------------------------ */
/* T1                                                                   */
/* ------------------------------------------------------------------ */

type Mount = { container: HTMLDivElement; root: Root };

async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(path: string, element: ReturnType<typeof createElement>, routePath: string): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          AppProvider,
          { initialSetup: setupComplete },
          createElement(Routes, null, createElement(Route, { path: routePath, element })),
        ),
      ),
    );
  });
  await settle();
  return { container, root };
}

function unmount(m: Mount): void {
  act(() => m.root.unmount());
  m.container.remove();
}

/** Ein echtes (nicht Demo-)Eingangsdokument — Demo-IDs „inbox-00N" gehen nie in die Outbox. */
function realItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return { ...createAuftragInboxItem(), id: 'inbox-real-t1', ...overrides } as InboxItem;
}

/** Cloud-Workspace mit aktiver Outbox; Tracker kennt den aktuellen Stand. */
function enableOutbox(): void {
  resetSyncClientForTests({ ...createSyncClient(), syncPolicy: 'cloud_ready', serverWorkspaceId: 'ws-t1', workspaceId: 'ws-t1' } as never);
  resetSyncOutboxForTests([]);
  resetSyncChangeTrackerForTests();
  persistenceService.seedSyncChangeTrackerFromCurrentStores();
}

describe('FINAL-ACCEPTANCE-FIX 02 / T1 — Ansehen schreibt nicht', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetTestStores();
    resetDocumentWorkResultStoreForTests();
    resetCompanySessionForTests();
    consoleError = vi.spyOn(console, 'error');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
    resetDocumentWorkResultStoreForTests();
    resetCompanySessionForTests();
    resetSyncOutboxForTests([]);
  });

  /** Bestehendes Dokument mit gespeichertem Analyseergebnis (Serverversion 3). */
  function seedAnalyzedItem(): InboxItem {
    hydrateInboxStore([realItem()]);
    expect(processUploadedDocument('inbox-real-t1')).not.toBeNull(); // ausdrückliche Erstanalyse
    const stored = getDocumentWorkResult('inbox-real-t1')!;
    upsertDocumentWorkResult({
      ...stored,
      analyzedAt: '2026-09-01T10:00:00.000Z',
      sync: { updatedAt: '2026-09-01T10:00:00.000Z', version: 3, deleted: false, deviceId: 'dev-1', workspaceId: 'ws-t1' } as never,
    });
    persistenceService.persistAll();
    enableOutbox();
    return getInboxItemById('inbox-real-t1')!;
  }

  it('A/B/G: Eingangsdetail öffnen → kein Analyse-Write, kein Queue-Eintrag, kein Upsert', async () => {
    seedAnalyzedItem();
    const before = JSON.stringify(getDocumentWorkResult('inbox-real-t1'));
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const upsertSpy = vi.spyOn(intakeCloudSyncService, 'rpcUpsertWorkspaceIntakeEntity');

    const m = await mount('/ablage/inbox-real-t1', createElement(EingangDetailPage), '/ablage/:id');
    expect(m.container.querySelector('[data-testid="ablage-detail-page"]')).not.toBeNull();

    expect(JSON.stringify(getDocumentWorkResult('inbox-real-t1'))).toBe(before); // auch analyzedAt unverändert
    expect(getSyncOutboxSnapshot().filter((e) => e.entityType === 'document_work_result')).toEqual([]);
    expect(getSyncOutboxSnapshot()).toEqual([]);
    expect(persistSpy).not.toHaveBeenCalled();
    expect(upsertSpy).not.toHaveBeenCalled();
    unmount(m);
  });

  it('C: Heute und Hinweise lesen nur — kein verstecktes Analyseergebnis', async () => {
    const material = { ...createMaterialInboxItem(), id: 'inbox-real-material' };
    hydrateInboxStore([material]);
    recordInboxContext(material.id, 'upload_document');
    enableOutbox();
    expect(getDocumentWorkResult(material.id)).toBeNull();

    // Die Hinweise analysieren das zuletzt hochgeladene Dokument — früher mit Speichern.
    buildProactiveHints(getCompanySession());
    buildDeskPriorities();
    expect(getDocumentWorkResult(material.id)).toBeNull();

    const m = await mount('/', createElement(HeutePage), '/');
    expect(getDocumentWorkResult(material.id)).toBeNull();
    expect(getSyncOutboxSnapshot().filter((e) => e.entityType === 'document_work_result')).toEqual([]);
    unmount(m);
  });

  it('D: abweichende Darstellung (Formatierung, Schlüsselreihenfolge, analyzedAt) wird beim Öffnen nicht gespeichert', async () => {
    seedAnalyzedItem();
    const stored = getDocumentWorkResult('inbox-real-t1')!;
    // Simuliert den Serverstand: andere Schlüsselreihenfolge, alte Betragsdarstellung.
    const reordered = JSON.parse(JSON.stringify(stored, Object.keys(stored).sort()));
    if (reordered.businessInterpretation?.facts?.money?.[0]) {
      reordered.businessInterpretation.facts.money[0].amountFormatted = '240,00 EUR';
    }
    upsertDocumentWorkResult(reordered);
    persistenceService.persistAll();
    enableOutbox();
    const before = JSON.stringify(getDocumentWorkResult('inbox-real-t1'));

    const m = await mount('/ablage/inbox-real-t1', createElement(EingangDetailPage), '/ablage/:id');
    expect(JSON.stringify(getDocumentWorkResult('inbox-real-t1'))).toBe(before);
    expect(getSyncOutboxSnapshot()).toEqual([]);
    unmount(m);
  });

  it('E: legitime Schreibwege bleiben — Erstanalyse eines neuen Dokuments und ausdrückliche Analyse (mit Serverversion)', () => {
    // Neues Dokument ohne Ergebnis: Das erste Ergebnis wird gespeichert.
    hydrateInboxStore([realItem({ id: 'inbox-real-new' })]);
    enableOutbox();
    const fresh = analyzeUploadedDocument('inbox-real-new')!;
    expect(getDocumentWorkResult('inbox-real-new')).toBeNull(); // reine Analyse schreibt nicht
    commitUploadedDocumentAnalysis(fresh, 'onlyIfMissing');
    expect(getDocumentWorkResult('inbox-real-new')).not.toBeNull();
    expect(getSyncOutboxSnapshot().some((e) => e.entityType === 'document_work_result' && e.entityId === 'inbox-real-new')).toBe(true);

    // Schon vorhanden + Ansehen: nichts.
    resetSyncOutboxForTests([]);
    commitUploadedDocumentAnalysis(analyzeUploadedDocument('inbox-real-new')!, 'onlyIfMissing');
    expect(getSyncOutboxSnapshot()).toEqual([]);
  });

  it('E2: ausdrückliche Analyse behält die Serverversion (kein „Versionskonflikt …:1")', () => {
    seedAnalyzedItem();
    commitUploadedDocumentAnalysis(analyzeUploadedDocument('inbox-real-t1')!, 'explicit');
    expect(getDocumentWorkResult('inbox-real-t1')?.sync?.version).toBe(3);
  });

  it('F: kein Zustands-Update während des Renders (SyncStatusIndicator) — Eingangsdetail und Heute', async () => {
    seedAnalyzedItem();
    const material = { ...createMaterialInboxItem(), id: 'inbox-real-material' };
    hydrateInboxStore([getInboxItemById('inbox-real-t1')!, material]);
    recordInboxContext(material.id, 'upload_document');
    const outboxEvents: number[] = [];
    const unsubscribe = subscribeSyncOutbox(() => outboxEvents.push(1));

    const detail = await mount('/ablage/inbox-real-t1', createElement(EingangDetailPage), '/ablage/:id');
    unmount(detail);
    const heute = await mount('/', createElement(HeutePage), '/');
    unmount(heute);
    unsubscribe();

    const logged = consoleError.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(logged).not.toMatch(/Cannot update a component/);
    expect(outboxEvents).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* T2                                                                   */
/* ------------------------------------------------------------------ */

const TODAY = '2026-09-29';

function offer(id: string, status: OfferStatus, number?: string): Offer {
  return {
    id,
    workspaceId: 'ws-t2',
    offerNumber: number,
    status,
    customer: { name: 'Beispiel Bau GmbH', contactPerson: '', street: 'Weg 1', zip: '33330', city: 'Beispielstadt', email: '', phone: '' },
    title: 'Dachsanierung',
    baustelle: '',
    positions: [],
    taxStatus: 'standard_19',
    offerDate: '2026-09-01',
    validUntil: '2026-10-21',
    introText: '',
    closingText: '',
    paymentTermsText: '',
    createdAt: '2026-09-01T10:00:00.000Z',
  } as Offer;
}

function offerDocument(id: string, offerId: string | undefined, title: string, validUntil: string) {
  return {
    id,
    title,
    category: 'angebot',
    classifiedKind: 'angebot',
    issuer: 'Beispielbetrieb',
    recognizedText: 'Angebot',
    issueDate: '2026-09-01',
    validUntil,
    digitalFolder: { id: 'dig-a', name: 'Angebote', path: '/Angebote/' },
    paperFolder: { folderId: 'folder-1', register: 'A', label: 'Angebote' },
    tags: [],
    linkedCompany: '',
    linkedVorgang: null,
    ...(offerId ? { linkedOfferId: offerId } : {}),
    archived: true,
    createdAt: '2026-09-01T10:00:00.000Z',
  } as never;
}

describe('FINAL-ACCEPTANCE-FIX 02 / T2 — Ablaufwarnung nur für entscheidbare Angebote', () => {
  beforeEach(() => resetTestStores());
  afterEach(() => resetTestStores());

  const kinds = (docs: ReturnType<typeof offerDocument>[], offers: Offer[]) => {
    hydrateOffers(offers);
    hydrateDocumentStore(docs);
    return scanExpiringDocuments(TODAY).filter((item) => item.kind === 'document_expiring' || item.kind === 'document_expired');
  };

  it.each([
    ['freigegeben', 1],
    ['versendet', 1],
    ['angenommen', 0],
    ['abgelehnt', 0],
    ['storniert', 0],
    ['ersetzt', 0],
  ] as const)('Status %s → %i Ablaufwarnung(en)', (status, expected) => {
    const items = kinds([offerDocument('doc-an-1', 'off-1', 'AN-2026-0001 – Angebot', '2026-10-21')], [offer('off-1', status, 'AN-2026-0001')]);
    expect(items).toHaveLength(expected);
  });

  it('angenommenes, bereits abgelaufenes Angebot → auch kein „abgelaufen"', () => {
    const items = kinds([offerDocument('doc-an-2', 'off-2', 'AN-2026-0002 – Angebot', '2026-09-01')], [offer('off-2', 'angenommen', 'AN-2026-0002')]);
    expect(items).toEqual([]);
  });

  it('offenes, abgelaufenes Angebot → weiterhin „abgelaufen"', () => {
    const items = kinds([offerDocument('doc-an-3', 'off-3', 'AN-2026-0003 – Angebot', '2026-09-01')], [offer('off-3', 'versendet', 'AN-2026-0003')]);
    expect(items.map((i) => i.kind)).toEqual(['document_expired']);
  });

  it('ohne Verknüpfung oder unbekanntes Angebot → bisherige Warnung; ohne Nummer keine erfundene', () => {
    const items = kinds(
      [offerDocument('doc-fremd', undefined, 'Angebot', '2026-10-01'), offerDocument('doc-unbekannt', 'off-weg', 'Angebot', '2026-10-01')],
      [],
    );
    expect(items).toHaveLength(2);
    const text = buildDailyPriorityAnswer(TODAY).answer.bullets.join('\n');
    expect(text).toContain('Bald: Angebot läuft in 2 Tagen ab');
    expect(text).not.toMatch(/AN-\d{4}-\d{4}/);
  });

  it('Heute und Assistent: dieselbe Grundlage — angenommenes Angebot fehlt in beiden, offenes steht in beiden', () => {
    hydrateOffers([offer('off-1', 'angenommen', 'AN-2026-0001'), offer('off-9', 'versendet', 'AN-2026-0009')]);
    hydrateDocumentStore([
      offerDocument('doc-an-1', 'off-1', 'AN-2026-0001 – Angebot', '2026-10-21'),
      offerDocument('doc-an-9', 'off-9', 'AN-2026-0009 – Angebot', '2026-10-21'),
    ]);
    const heute = scanPendingItems(TODAY, { readOnly: true }).items.filter((item) => item.kind === 'document_expiring');
    expect(heute.map((item) => item.metadata?.proofLabel)).toEqual(['AN-2026-0009 – Angebot']);
    const assistant = buildDailyPriorityAnswer(TODAY).answer.bullets.join('\n');
    expect(assistant).toContain('AN-2026-0009 – Angebot läuft in 22 Tagen ab');
    expect(assistant).not.toContain('AN-2026-0001');
  });
});
