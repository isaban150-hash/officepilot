/**
 * ARCHIVE-TRUTH-DURABILITY-01 — durable archive truth snapshot on CompanyDocument.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDocumentArchiveTruthDisplayView } from './documentArchiveTruthDisplayService';
import {
  buildDocumentWorkResultSourceFingerprint,
  getDocumentWorkResult,
  mergeDocumentWorkResultOnReanalysis,
  projectDocumentWorkResultFromWorkflow,
  removeDocumentWorkResultForInboxItem,
  resolveDocumentWorkTruthViewForCompanyDocument,
  upsertDocumentWorkResult,
  upsertDocumentWorkResultOverlayEntry,
} from './documentWorkResultService';
import { withInboxExtractedDocumentText } from './inboxDocumentText';
import {
  getInboxItemById,
  hydrateInboxStore,
  markInboxImportedToArchive,
} from './inboxService';
import { processUploadedDocument } from './intakeWorkflowService';
import {
  getDocumentById,
  hydrateDocumentStore,
  importInboxDocument,
  updateDocumentFromInbox,
} from './documentService';
import { buildDocumentAiContextFromDocument } from './document/documentAiContextService';
import * as persistenceService from './persistenceService';
import { confirmFilingDecisionForTests } from '../test/confirmFilingDecisionForTests';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { setWorkspace } from './workspace/workspaceStore';
import {
  DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
  DOCUMENT_WORK_RESULT_SCHEMA_VERSION,
  type DocumentWorkResult,
} from '../types/documentWorkResult';
import type { CompanyDocument, InboxItem } from '../types/models';
import type { DocumentArchiveTruthSnapshot } from '../types/documentArchiveTruthSnapshot';

function itemWithText(text: string, overrides: Partial<InboxItem> = {}): InboxItem {
  const base = createAuftragInboxItem({
    id: 'inbox-archive-truth-durability',
    sender: '',
    deadline: null,
    title: 'Archive Truth Durability',
    ...overrides,
  });
  return {
    ...base,
    recognizedData: withInboxExtractedDocumentText(base.recognizedData, text),
  };
}

function seedAnalyzedInbox(
  text: string,
  overrides: Partial<InboxItem> = {},
): { item: InboxItem; dwr: DocumentWorkResult } {
  const item = itemWithText(text, overrides);
  hydrateInboxStore([item]);
  const workflow = processUploadedDocument(item.id);
  expect(workflow).not.toBeNull();
  const dwr = getDocumentWorkResult(item.id);
  expect(dwr).not.toBeNull();
  return { item: getInboxItemById(item.id)!, dwr: dwr! };
}

function archiveFromInbox(item: InboxItem): CompanyDocument {
  const fresh = getInboxItemById(item.id) ?? item;
  const withFiling =
    fresh.filingDecision?.status === 'confirmed'
      ? fresh
      : confirmFilingDecisionForTests(fresh.id);
  const imported = importInboxDocument(withFiling, 'Test GmbH');
  expect(imported.success).toBe(true);
  if (!imported.success) throw new Error('import failed');
  markInboxImportedToArchive(withFiling.id, imported.document.id);
  return imported.document;
}

describe('ARCHIVE-TRUTH-DURABILITY-01', () => {
  beforeEach(() => {
    resetTestStores();
    setWorkspace({
      id: 'ws-archive-truth',
      name: 'Archive Truth WS',
      createdAt: '2026-01-01T00:00:00.000Z',
      createdByDeviceId: 'device-test',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1 — Archivierung erzeugt einen Archive-Truth-Snapshot', () => {
    const { item } = seedAnalyzedInbox(
      'Absender: Müller GmbH\nBetrag: 1.250,00 EUR\nRechnungsnummer: R-100',
    );
    const doc = archiveFromInbox(item);
    expect(doc.archiveTruthSnapshot).toBeDefined();
    expect(doc.archiveTruthSnapshot?.sourceInboxItemId).toBe(item.id);
    expect(doc.archiveTruthSnapshot?.businessInterpretation).not.toBeNull();
    expect(doc.archiveTruthSnapshot?.sourceFingerprint).toBeTruthy();
    expect(doc.archiveTruthSnapshot?.createdAt).toBeTruthy();
  });

  it('2 — Snapshot enthält bestätigte/korrigierte Overlay-Werte', () => {
    const { item } = seedAnalyzedInbox('Absender: Alt AG\nBetrag: 100,00 EUR');
    const dwr = getDocumentWorkResult(item.id)!;
    const withOverlay = upsertDocumentWorkResultOverlayEntry(dwr, {
      slotId: 'facts.money.0',
      status: 'user_corrected',
      value: {
        kind: 'other',
        amount: 250,
        amountFormatted: '250,00 EUR',
        certainty: 'confirmed',
        source: 'understanding',
      },
      updatedAt: '2026-07-30T12:00:00.000Z',
      analysisVersionAtWrite: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    upsertDocumentWorkResult(withOverlay);
    persistenceService.persistAll();

    const doc = archiveFromInbox(getInboxItemById(item.id)!);
    expect(doc.archiveTruthSnapshot?.overlay.length).toBeGreaterThan(0);
    const money = doc.archiveTruthSnapshot?.overlay.find((e) => e.slotId === 'facts.money.0');
    expect(money?.status).toBe('user_corrected');
    expect(money?.value).toMatchObject({ amount: 250, amountFormatted: '250,00 EUR' });
  });

  it('3 — Snapshot enthält Unsicherheiten und Provenienz über BI/Overlay', () => {
    const { item, dwr } = seedAnalyzedInbox(
      'Absender: Unklar GmbH\nBetrag: ca. 500 EUR\nFrist: möglicherweise 2026-08-01',
    );
    expect(dwr.businessInterpretation).not.toBeNull();
    const doc = archiveFromInbox(item);
    const snap = doc.archiveTruthSnapshot!;
    expect(snap.businessInterpretation).not.toBeNull();
    expect(snap.analyzedAt).toBe(dwr.analyzedAt);
    expect(snap.analysisVersion).toBe(dwr.analysisVersion);
    expect(snap.sourceFingerprint).toBe(dwr.sourceFingerprint);
  });

  it('4 — Snapshot enthält relevante Filing-Entscheidungsmetadaten', () => {
    const { item } = seedAnalyzedInbox('Hotelrechnung Berlin\nBetrag: 189,00 EUR', {
      id: 'inbox-archive-filing',
      title: 'Hotel Berlin',
      classifiedKind: 'hotelrechnung',
    });
    const confirmed = confirmFilingDecisionForTests(item.id);
    expect(confirmed.filingDecision?.status).toBe('confirmed');
    const doc = archiveFromInbox(confirmed);
    expect(doc.archiveTruthSnapshot?.filingDecision?.status).toBe('confirmed');
    expect(doc.archiveTruthSnapshot?.filingDecision?.scope).toBeTruthy();
    expect(doc.archiveTruthSnapshot?.filingDecision?.confirmedAt).toBeTruthy();
  });

  it('5 — Nach Entfernung des InboxItems bleibt die Archiv-Truth sichtbar', () => {
    const { item } = seedAnalyzedInbox('Absender: Sichtbar AG\nBetrag: 77,00 EUR');
    const doc = archiveFromInbox(item);
    hydrateInboxStore([]);
    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.reason).toBe('source_inbox_missing');
    expect(result.truthView).not.toBeNull();
    expect(result.truthView?.businessInterpretation).not.toBeNull();
    const display = buildDocumentArchiveTruthDisplayView(doc);
    expect(display).not.toBeNull();
    expect(display!.facts.length).toBeGreaterThan(0);
  });

  it('6 — Nach Entfernung des inbox-keyed DWR bleibt die Archiv-Truth sichtbar', () => {
    const { item } = seedAnalyzedInbox('Absender: DWR weg\nBetrag: 88,00 EUR');
    const doc = archiveFromInbox(item);
    removeDocumentWorkResultForInboxItem(item.id);
    expect(getDocumentWorkResult(item.id)).toBeNull();
    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.truthView).not.toBeNull();
    expect(result.truthView?.businessInterpretation).not.toBeNull();
  });

  it('7 — Reload/Hydrate stellt denselben Snapshot und dieselben Fakten wieder her', () => {
    const { item } = seedAnalyzedInbox('Absender: Persist AG\nBetrag: 99,00 EUR');
    const doc = archiveFromInbox(item);
    const snapBefore = JSON.parse(JSON.stringify(doc.archiveTruthSnapshot));
    const factsBefore = buildDocumentArchiveTruthDisplayView(doc)?.facts ?? [];

    hydrateDocumentStore([]);
    expect(getDocumentById(doc.id)).toBeUndefined();
    hydrateDocumentStore([doc]);
    const restored = getDocumentById(doc.id)!;
    expect(restored.archiveTruthSnapshot).toEqual(snapBefore);
    hydrateInboxStore([]);
    const factsAfter = buildDocumentArchiveTruthDisplayView(restored)?.facts ?? [];
    expect(factsAfter).toEqual(factsBefore);
  });

  it('8 — source_inbox_missing mit gültigem Snapshot liefert keine leere Facts-Card', () => {
    const { item } = seedAnalyzedInbox('Absender: Facts Card\nBetrag: 120,00 EUR');
    const doc = archiveFromInbox(item);
    hydrateInboxStore([]);
    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.reason).toBe('source_inbox_missing');
    expect(result.truthView).not.toBeNull();
    const display = buildDocumentArchiveTruthDisplayView(doc);
    expect(display).not.toBeNull();
    expect(display!.facts.length).toBeGreaterThan(0);
  });

  it('9 — AI-Kontext verwendet bei fehlender Inbox den Snapshot statt nur OCR', () => {
    const { item } = seedAnalyzedInbox('Absender: AI Snapshot GmbH\nBetrag: 333,00 EUR');
    const dwr = getDocumentWorkResult(item.id)!;
    const withOverlay = upsertDocumentWorkResultOverlayEntry(dwr, {
      slotId: 'facts.parties.counterparty',
      status: 'user_corrected',
      value: {
        name: 'AI Snapshot GmbH',
        role: 'counterparty',
        certainty: 'confirmed',
        source: 'understanding',
      },
      updatedAt: '2026-07-30T12:00:00.000Z',
      analysisVersionAtWrite: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    upsertDocumentWorkResult(withOverlay);
    persistenceService.persistAll();

    const doc = archiveFromInbox(getInboxItemById(item.id)!);
    hydrateInboxStore([]);
    const ctx = buildDocumentAiContextFromDocument(doc);
    expect(ctx.documentWorkTruthFactLines?.length ?? 0).toBeGreaterThan(0);
  });

  it('10 — Spätere Re-Analyse des InboxItems verändert den Snapshot nicht', () => {
    const { item } = seedAnalyzedInbox('Absender: Freeze AG\nBetrag: 10,00 EUR');
    const doc = archiveFromInbox(item);
    const frozen = JSON.parse(
      JSON.stringify(doc.archiveTruthSnapshot),
    ) as DocumentArchiveTruthSnapshot;

    const retext = itemWithText('Absender: Changed AG\nBetrag: 9999,00 EUR', {
      id: item.id,
      title: item.title,
    });
    hydrateInboxStore([{ ...getInboxItemById(item.id)!, ...retext, recognizedData: retext.recognizedData }]);
    const live = processUploadedDocument(item.id)!;
    const previous = getDocumentWorkResult(item.id);
    const projected = projectDocumentWorkResultFromWorkflow({
      workflow: live,
      inboxItem: getInboxItemById(item.id)!,
      workspaceId: 'ws-archive-truth',
    });
    upsertDocumentWorkResult(mergeDocumentWorkResultOnReanalysis(previous, projected));

    const still = getDocumentById(doc.id)!;
    expect(still.archiveTruthSnapshot).toEqual(frozen);
  });

  it('11 — Spätere Overlay-/Fill-Änderung im InboxItem verändert den Snapshot nicht', () => {
    const { item } = seedAnalyzedInbox('Absender: Overlay Freeze\nBetrag: 55,00 EUR');
    const doc = archiveFromInbox(item);
    const frozenOverlay = JSON.parse(JSON.stringify(doc.archiveTruthSnapshot?.overlay));

    const dwr = getDocumentWorkResult(item.id)!;
    upsertDocumentWorkResult(
      upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.money.0',
        status: 'user_corrected',
        value: {
          kind: 'other',
          amount: 1,
          amountFormatted: '1,00 EUR',
          certainty: 'confirmed',
          source: 'understanding',
        },
        updatedAt: '2026-07-30T18:00:00.000Z',
        analysisVersionAtWrite: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
      }),
    );

    expect(getDocumentById(doc.id)!.archiveTruthSnapshot?.overlay).toEqual(frozenOverlay);
  });

  it('12 — Workspace-Mismatch blockiert Snapshot-Daten', () => {
    const { item } = seedAnalyzedInbox('Absender: WS Guard\nBetrag: 11,00 EUR');
    const doc = archiveFromInbox(item);
    hydrateInboxStore([]);
    const foreign: CompanyDocument = {
      ...doc,
      archiveTruthSnapshot: {
        ...doc.archiveTruthSnapshot!,
        workspaceId: 'ws-foreign',
      },
    };
    const result = resolveDocumentWorkTruthViewForCompanyDocument({
      document: foreign,
      workspaceId: 'ws-archive-truth',
    });
    expect(result.truthView).toBeNull();
  });

  it('13 — Wiederholte Archivierung bleibt idempotent (kein Snapshot-No-op-Replace)', () => {
    const { item } = seedAnalyzedInbox('Absender: Idempotent\nBetrag: 22,00 EUR');
    const first = archiveFromInbox(item);
    const frozen = JSON.parse(JSON.stringify(first.archiveTruthSnapshot));

    removeDocumentWorkResultForInboxItem(item.id);
    const second = updateDocumentFromInbox(first.id, getInboxItemById(item.id)!, 'Test GmbH');
    expect(second.success).toBe(true);
    if (second.success) {
      expect(second.document.archiveTruthSnapshot).toEqual(frozen);
    }
  });

  it('14 — Bestehender gültiger Snapshot wird nicht durch leere/schlechtere Daten ersetzt', () => {
    const { item } = seedAnalyzedInbox('Absender: Keep Good\nBetrag: 44,00 EUR');
    const first = archiveFromInbox(item);
    expect(first.archiveTruthSnapshot).toBeDefined();
    const frozen = JSON.parse(JSON.stringify(first.archiveTruthSnapshot));

    removeDocumentWorkResultForInboxItem(item.id);
    const updated = updateDocumentFromInbox(first.id, getInboxItemById(item.id)!, 'Test GmbH');
    expect(updated.success).toBe(true);
    if (updated.success) {
      expect(updated.document.archiveTruthSnapshot).toEqual(frozen);
    }
  });

  it('15 — Persistenzfehler hinterlässt keinen teilweise archivierten Truth-Zustand', () => {
    const { item } = seedAnalyzedInbox('Absender: Persist Fail\nBetrag: 66,00 EUR');
    confirmFilingDecisionForTests(item.id);
    const beforeIds = new Set(
      persistenceService.buildPersistedStateSnapshot().documents.map((d) => d.id),
    );

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });

    const imported = importInboxDocument(getInboxItemById(item.id)!, 'Test GmbH');
    expect(imported.success).toBe(false);
    if (!imported.success) {
      expect(imported.errorKey).toBe('document.persistFailed');
    }

    const afterDocs = hydrateAndListDocs();
    for (const doc of afterDocs) {
      if (!beforeIds.has(doc.id) && doc.sourceInboxItemId === item.id) {
        expect.fail('partial archive document must not remain after persist failure');
      }
    }
  });

  it('16 — Alte CompanyDocuments ohne Snapshot funktionieren weiterhin über Fallbacks', () => {
    const legacy: CompanyDocument = {
      id: 'doc-legacy-no-snap',
      title: 'Legacy OCR',
      category: 'sonstiges',
      issuer: 'Legacy Issuer',
      recognizedText: 'Nur OCR Text',
      issueDate: null,
      validUntil: null,
      digitalFolder: { id: 'd', name: 'F', path: '/F/' },
      paperFolder: { folderId: 'f', register: 'A', label: 'L' },
      tags: [],
      linkedCompany: 'Test GmbH',
      linkedVorgang: null,
      archived: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceInboxItemId: 'inbox-missing-legacy',
    };
    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: legacy });
    expect(result.truthView).toBeNull();
    expect(result.reason).toBe('source_inbox_missing');
    const ctx = buildDocumentAiContextFromDocument(legacy);
    expect(ctx.documentWorkTruthFactLines ?? []).toHaveLength(0);
    expect(ctx.recognizedText).toContain('Nur OCR Text');
  });

  it('17 — Archivierung ohne verwertbares DWR erzeugt keinen erfundenen Snapshot', () => {
    const item = itemWithText('Kurzer Text ohne Analyse');
    hydrateInboxStore([item]);
    expect(getDocumentWorkResult(item.id)).toBeNull();
    const confirmed = confirmFilingDecisionForTests(item.id);
    const imported = importInboxDocument(confirmed, 'Test GmbH');
    expect(imported.success).toBe(true);
    if (imported.success) {
      expect(imported.document.archiveTruthSnapshot).toBeUndefined();
    }
  });
});

function hydrateAndListDocs(): CompanyDocument[] {
  // Read from in-memory store after failed import (no hydrate from disk).
  return persistenceService.buildPersistedStateSnapshot().documents;
}

// Touch fingerprint helper so unused-import lint stays quiet in slim builds.
void buildDocumentWorkResultSourceFingerprint;
void DOCUMENT_WORK_RESULT_SCHEMA_VERSION;
