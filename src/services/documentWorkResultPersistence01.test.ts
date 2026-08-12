import { importInboxDocumentForTests } from '../test/confirmFilingDecisionForTests';
/**
 * DOCUMENT-WORK-RESULT-PERSISTENCE-01 — analysis flush, rollback, usable-core guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { getDocumentById, hydrateDocumentStore, importInboxDocument } from './documentService';
import {
  buildDocumentWorkResultSourceFingerprint,
  commitDocumentWorkResultFromAnalysis,
  getDocumentWorkResult,
  getDocumentWorkResultForItem,
  hydrateDocumentWorkResultStore,
  isDocumentWorkResultCoreUsable,
  mergeDocumentWorkResultOnReanalysis,
  projectDocumentWorkResultFromWorkflow,
  resetDocumentWorkResultStoreForTests,
  upsertDocumentWorkResult,
  upsertDocumentWorkResultOverlayEntry,
} from './documentWorkResultService';
import { markInboxImportedToArchive, getInboxItemById, hydrateInboxStore } from './inboxService';
import { processUploadedDocument } from './intakeWorkflowService';
import {
  buildPersistedStateSnapshot,
  hydrateStoresFromStorage,
  persistAll,
} from './persistenceService';
import * as persistenceService from './persistenceService';
import { setTaskStoreForTests } from './taskStore';
import {
  hydrateVorgangStore,
  isInboxLinkedToVorgang,
  linkInboxToExistingVorgang,
} from './vorgangService';
import { getDocumentCase } from '../test/document-cases/_lib/loadCases';
import { runStablePipeline, testProfile } from '../test/document-cases/_lib/runStablePipeline';
import { createAuftragInboxItem, createTestVorgang } from '../test/fixtures';
import { DOCUMENT_WORK_RESULT_ANALYSIS_VERSION } from '../types/documentWorkResult';
import type { InboxItem, WorkflowResult } from '../types/models';

function seedHotelInbox() {
  const docCase = getDocumentCase('HOTEL-01');
  const observation = runStablePipeline(docCase);
  hydrateInboxStore([observation.item]);
  const workflow = processUploadedDocument(observation.item.id) ?? observation.workflow;
  const item = getInboxItemById(observation.item.id)!;
  return { workflow, item };
}

function incompleteWorkflow(itemId: string, digitalFolder: WorkflowResult['suggestedArchiveFolder']): WorkflowResult {
  return {
    inboxItemId: itemId,
    companyRelevant: true,
    companyRelevance: { isRelevant: true, reasons: [], matchedHints: [] },
    classifiedKind: 'sonstiges',
    classificationConfidence: 'low',
    classification: null,
    documentExplanation: null,
    documentUnderstanding: null,
    documentAiActions: [],
    contractAnalysis: null,
    contractIntelligence: null,
    contractOrderProposal: null,
    suggestedVorgang: null,
    similarVorgaenge: [],
    suggestedOrderPositions: [],
    suggestedTasks: [],
    suggestedArchiveFolder: digitalFolder,
    requiredDocuments: [],
    pendingSummary: null,
    warnings: [{ id: 'business_interpretation_failed', message: 'fail' }],
    nextActions: [],
    businessInterpretation: null,
  };
}

describe('DOCUMENT-WORK-RESULT-PERSISTENCE-01', () => {
  beforeEach(() => {
    localStorage.clear();
    setTaskStoreForTests([]);
    hydrateDocumentStore([]);
    hydrateVorgangStore([]);
    hydrateCompanyProfileStore(testProfile);
    resetDocumentWorkResultStoreForTests();
  });

  afterEach(() => {
    resetDocumentWorkResultStoreForTests();
    vi.restoreAllMocks();
  });

  it('1 — Analyse erzeugt DWR und persistiert es', () => {
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const { item } = seedHotelInbox();
    expect(getDocumentWorkResult(item.id)?.businessInterpretation).not.toBeNull();
    expect(persistSpy).toHaveBeenCalled();
    expect(
      buildPersistedStateSnapshot().documentWorkResults?.some((entry) => entry.inboxItemId === item.id),
    ).toBe(true);
  });

  it('2 — Reload/Hydrate stellt dasselbe DWR wieder her', () => {
    const { item } = seedHotelInbox();
    const before = getDocumentWorkResult(item.id)!;
    const fingerprint = before.sourceFingerprint;
    const primaryCase = before.businessInterpretation?.operational.primaryCase;

    resetDocumentWorkResultStoreForTests();
    expect(getDocumentWorkResult(item.id)).toBeNull();
    hydrateStoresFromStorage();

    const restored = getDocumentWorkResult(item.id)!;
    expect(restored.sourceFingerprint).toBe(fingerprint);
    expect(restored.businessInterpretation?.operational.primaryCase).toBe(primaryCase);
    expect(isDocumentWorkResultCoreUsable(restored)).toBe(true);
  });

  it('3 — Re-Analyse aktualisiert Core und erhält Overlay', () => {
    const { workflow, item } = seedHotelInbox();
    let current = getDocumentWorkResult(item.id)!;
    current = upsertDocumentWorkResultOverlayEntry(current, {
      slotId: 'operational.nextStep',
      status: 'user_confirmed',
      value: 'Manuell bestätigt',
      updatedAt: '2026-07-28T10:00:00.000Z',
      analysisVersionAtWrite: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    upsertDocumentWorkResult(current);
    persistAll();

    const outcome = commitDocumentWorkResultFromAnalysis(workflow, item);
    expect(outcome.persisted).toBe(true);
    expect(outcome.reason).toBe('ok');

    const after = getDocumentWorkResult(item.id)!;
    expect(after.overlay.some((entry) => entry.slotId === 'operational.nextStep')).toBe(true);
    expect(after.overlay.find((entry) => entry.slotId === 'operational.nextStep')?.value).toBe(
      'Manuell bestätigt',
    );
    expect(after.businessInterpretation).not.toBeNull();
  });

  it('4 — Fehlgeschlagene Analyse zerstört vorheriges gültiges DWR nicht', () => {
    const { item } = seedHotelInbox();
    const before = getDocumentWorkResult(item.id)!;
    expect(before.businessInterpretation).not.toBeNull();

    const outcome = commitDocumentWorkResultFromAnalysis(
      incompleteWorkflow(item.id, item.digitalFolder),
      item,
    );
    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toBe('unusable_projection');
    expect(outcome.persisted).toBe(false);

    const after = getDocumentWorkResult(item.id)!;
    expect(after.businessInterpretation?.operational.primaryCase).toBe(
      before.businessInterpretation?.operational.primaryCase,
    );
    expect(after.sourceFingerprint).toBe(before.sourceFingerprint);
  });

  it('5 — Leere Analyse erzeugt kein leeres persistiertes DWR', () => {
    const docCase = getDocumentCase('HOTEL-01');
    const observation = runStablePipeline(docCase);
    const item = { ...observation.item, id: 'inbox-dwr-empty-guard' };
    hydrateInboxStore([item]);
    expect(getDocumentWorkResult(item.id)).toBeNull();

    const outcome = commitDocumentWorkResultFromAnalysis(
      incompleteWorkflow(item.id, item.digitalFolder),
      item,
    );
    expect(outcome.skipped).toBe(true);
    expect(getDocumentWorkResult(item.id)).toBeNull();

    hydrateStoresFromStorage();
    expect(getDocumentWorkResult(item.id)).toBeNull();
  });

  it('6 — Persistenzfehler stellt vorherigen DWR-Zustand wieder her', () => {
    const { workflow, item } = seedHotelInbox();
    const before = getDocumentWorkResult(item.id)!;
    const withOverlay = upsertDocumentWorkResultOverlayEntry(before, {
      slotId: 'facts.money.0',
      status: 'user_corrected',
      value: { amount: 42 },
      updatedAt: '2026-07-28T11:00:00.000Z',
      analysisVersionAtWrite: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    upsertDocumentWorkResult(withOverlay);
    persistAll();

    vi.spyOn(persistenceService, 'persistAll').mockReturnValueOnce({
      success: false,
      failure: { reason: 'unknown_persist_error' },
    });

    const outcome = commitDocumentWorkResultFromAnalysis(workflow, item);
    expect(outcome.reason).toBe('persist_failed');
    expect(outcome.persisted).toBe(false);

    const rolledBack = getDocumentWorkResult(item.id)!;
    expect(rolledBack.overlay.find((entry) => entry.slotId === 'facts.money.0')?.value).toEqual({
      amount: 42,
    });
  });

  it('7 — Persistenzfehler ohne vorheriges DWR entfernt Memory-Eintrag', () => {
    const docCase = getDocumentCase('HOTEL-01');
    const observation = runStablePipeline(docCase);
    const item = { ...observation.item, id: 'inbox-dwr-rollback-empty' };
    hydrateInboxStore([item]);
    // Build a usable workflow without going through analysis commit first.
    const live = processUploadedDocument(item.id)!;
    // Remove durable + memory so the next commit is a first write.
    resetDocumentWorkResultStoreForTests();
    localStorage.clear();
    expect(getDocumentWorkResult(item.id)).toBeNull();

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });

    const outcome = commitDocumentWorkResultFromAnalysis(live, getInboxItemById(item.id)!);
    expect(outcome.reason).toBe('persist_failed');
    expect(getDocumentWorkResult(item.id)).toBeNull();
  });

  it('8 — Filing-Entscheidung bleibt unverändert', () => {
    const { item: seeded } = seedHotelInbox();
    const withFiling = {
      ...seeded,
      filingDecision: {
        status: 'confirmed' as const,
        scope: 'company' as const,
        companyAreaId: 'rechnungen' as const,
        specialty: 'hotel_travel' as const,
        documentKindLabelKey: 'filingDecision.kind.hotelrechnung',
        companyAreaLabelKey: 'filingDecision.area.hotelTravel',
        digitalPath: seeded.digitalFolder.path,
        digitalFolderName: seeded.digitalFolder.name,
        skipPhysicalFiling: false,
        confirmedAt: '2026-07-30T12:00:00.000Z',
      },
    };
    hydrateInboxStore([withFiling]);
    processUploadedDocument(withFiling.id);
    const after = getInboxItemById(withFiling.id)!;
    expect(after.filingDecision?.status).toBe('confirmed');
    expect(after.filingDecision?.specialty).toBe('hotel_travel');
    expect(after.filingDecision?.digitalPath).toBe(seeded.digitalFolder.path);
  });

  it('9 — Bestätigte Fill-/Overlay-Daten bleiben bei Re-Analyse erhalten', () => {
    const { workflow, item } = seedHotelInbox();
    let current = getDocumentWorkResult(item.id)!;
    current = upsertDocumentWorkResultOverlayEntry(current, {
      slotId: 'operational.nextStep',
      status: 'user_confirmed',
      value: 'Overlay bleibt',
      updatedAt: '2026-07-28T12:00:00.000Z',
      analysisVersionAtWrite: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    upsertDocumentWorkResult(current);

    const nextProjected = projectDocumentWorkResultFromWorkflow({ workflow, inboxItem: item });
    const merged = mergeDocumentWorkResultOnReanalysis(current, nextProjected);
    expect(merged.overlay.find((entry) => entry.slotId === 'operational.nextStep')?.value).toBe(
      'Overlay bleibt',
    );

    commitDocumentWorkResultFromAnalysis(workflow, item);
    expect(
      getDocumentWorkResult(item.id)?.overlay.find((entry) => entry.slotId === 'operational.nextStep')
        ?.value,
    ).toBe('Overlay bleibt');
  });

  it('10 — Workspace-Mismatch bleibt geschützt', () => {
    const { item } = seedHotelInbox();
    const dwr = getDocumentWorkResult(item.id)!;
    upsertDocumentWorkResult({ ...dwr, workspaceId: 'ws-foreign' });
    expect(getDocumentWorkResultForItem(item.id, { workspaceId: 'ws-local' })).toBeNull();
    expect(getDocumentWorkResult(item.id, { workspaceId: 'ws-foreign' })?.workspaceId).toBe(
      'ws-foreign',
    );
  });

  it('11 — Archiv unmittelbar nach Analyse verliert kein DWR', () => {
    const { item } = seedHotelInbox();
    const fingerprint = getDocumentWorkResult(item.id)!.sourceFingerprint;

    const imported = importInboxDocumentForTests(item, testProfile.companyName);
    expect(imported.success).toBe(true);
    markInboxImportedToArchive(item.id, imported.document!.id);

    resetDocumentWorkResultStoreForTests();
    hydrateStoresFromStorage();
    expect(getDocumentWorkResult(item.id)?.sourceFingerprint).toBe(fingerprint);
    expect(getDocumentById(imported.document!.id)?.sourceInboxItemId).toBe(item.id);
  });

  /**
   * R03-Restpunkt: der vorgeschlagene Vorgangskontext darf nach einem echten Reload
   * nicht als bestaetigt erscheinen, und nach bestaetigter Verknuepfung muss der
   * bestaetigte Zustand seinerseits einen Reload ueberleben.
   * Aufbau wie in vorgangSuggestionConfirmFirst01: exact ueber Projekt + Baustelle,
   * Dokumentkunde bewusst abweichend, keine Vorgangs-ID im Dokument.
   */
  it('13 — suggested bleibt nach Reload proposed, bestaetigt bleibt nach Reload linked', () => {
    const VORGANG_ID = 'v-dwr-two-bootstraps';
    const VORGANG_TITLE = 'Neubau Kirchheide Halle 3';
    const VORGANG_SITE = 'Industriering 8, 32657 Lemgo';
    const VORGANG_CUSTOMER = 'Nordwerk Immobilien GmbH';

    hydrateVorgangStore([
      createTestVorgang({
        id: VORGANG_ID,
        title: VORGANG_TITLE,
        customer: VORGANG_CUSTOMER,
        baustelle: VORGANG_SITE,
      } as never),
    ]);

    const item = {
      ...createAuftragInboxItem(),
      id: 'inbox-dwr-two-bootstraps',
      title: `Angebot ${VORGANG_TITLE}`,
      classifiedKind: 'angebot',
      documentType: 'angebot',
      sender: testProfile.companyName,
      vorgangId: undefined,
      vorgangTitle: undefined,
      vorgangLinkStatus: undefined,
      recognizedData: {
        Dokumentart: 'angebot',
        Absender: testProfile.companyName,
        Lieferant: testProfile.companyName,
        Bauvorhaben: VORGANG_TITLE,
        Baustelle: VORGANG_SITE,
        Kunde: 'Bauherrengemeinschaft Kirchheide GbR',
        Auftraggeber: 'Bauherrengemeinschaft Kirchheide GbR',
        Datum: '01.04.2026',
      },
    } as unknown as InboxItem;
    hydrateInboxStore([item]);

    // 1) suggested-only analysieren und persistieren
    expect(processUploadedDocument(item.id)).toBeTruthy();
    expect(isInboxLinkedToVorgang(getInboxItemById(item.id)!)).toBe(false);

    // 2) erster echter Reload
    resetDocumentWorkResultStoreForTests();
    expect(getDocumentWorkResult(item.id)).toBeNull();
    hydrateStoresFromStorage();

    const afterFirst = getDocumentWorkResult(item.id)!;
    expect(afterFirst.businessInterpretation?.facts.parties.counterparty?.certainty).toBe(
      'proposed',
    );
    expect(afterFirst.businessInterpretation?.vorgangRef.status).toBe('suggested');

    // 3) produktive Verknuepfung ueber den Confirm-first-Pfad
    expect(linkInboxToExistingVorgang(getInboxItemById(item.id)!, VORGANG_ID)).toBeTruthy();
    expect(isInboxLinkedToVorgang(getInboxItemById(item.id)!)).toBe(true);

    // 4) Analyse und DWR produktiv aktualisieren
    expect(processUploadedDocument(item.id)).toBeTruthy();

    // 5) zweiter echter Reload
    resetDocumentWorkResultStoreForTests();
    hydrateStoresFromStorage();

    const afterSecond = getDocumentWorkResult(item.id)!;
    expect(afterSecond.businessInterpretation?.facts.parties.counterparty?.certainty).toBe(
      'confirmed_by_existing_state',
    );
    expect(afterSecond.businessInterpretation?.vorgangRef.status).toBe('linked');
    expect(afterSecond.businessInterpretation?.vorgangRef.linkedVorgangId).toBe(VORGANG_ID);
    expect(getInboxItemById(item.id)?.vorgangId).toBe(VORGANG_ID);
  });

  it('12 — Mehrfaches Speichern bleibt idempotent', () => {
    const { workflow, item } = seedHotelInbox();
    const first = commitDocumentWorkResultFromAnalysis(workflow, item);
    const second = commitDocumentWorkResultFromAnalysis(workflow, item);
    expect(first.reason).toBe('ok');
    expect(second.reason).toBe('ok');

    const a = getDocumentWorkResult(item.id)!;
    const b = getDocumentWorkResult(item.id)!;
    expect(a.sourceFingerprint).toBe(b.sourceFingerprint);
    expect(a.businessInterpretation?.operational.primaryCase).toBe(
      b.businessInterpretation?.operational.primaryCase,
    );
    expect(buildDocumentWorkResultSourceFingerprint(item)).toBe(a.sourceFingerprint);

    hydrateDocumentWorkResultStore(buildPersistedStateSnapshot().documentWorkResults ?? []);
    expect(getDocumentWorkResult(item.id)?.sourceFingerprint).toBe(a.sourceFingerprint);
  });
});
