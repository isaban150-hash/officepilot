/**
 * DOCUMENT-WORK-RESULT-01A / FIX-01 — projection, upsert, restore, overlay preserve, hydration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateDocumentStore } from './documentService';
import {
  buildDocumentWorkResultSourceFingerprint,
  buildWorkflowResultFromDocumentWorkResult,
  deserializeDocumentWorkResult,
  flushDocumentWorkResultPersistence,
  getDocumentWorkResult,
  getDocumentWorkResultForItem,
  hydrateDocumentWorkResultStore,
  isDocumentWorkResultUsableForDisplay,
  isRestoredDocumentWorkResultWorkflow,
  mergeDocumentWorkResultOnReanalysis,
  persistDocumentWorkResultFromWorkflow,
  projectDocumentWorkResultFromWorkflow,
  resetDocumentWorkResultStoreForTests,
  resolveDocumentWorkResultOverlaySlot,
  serializeDocumentWorkResult,
  upsertDocumentWorkResult,
  upsertDocumentWorkResultFromWorkflow,
  upsertDocumentWorkResultOverlayEntry,
} from './documentWorkResultService';
import { getDocumentWorkResultStoreSnapshot } from './documentWorkResultStoreService';
import { getInboxItemById, hydrateInboxStore, removeStagedInboxItemById } from './inboxService';
import { processUploadedDocument } from './intakeWorkflowService';
import {
  buildPersistedStateSnapshot,
  hydrateStoresFromStorage,
  persistAll,
  savePersistedState,
} from './persistenceService';
import * as persistenceService from './persistenceService';
import { setTaskStoreForTests } from './taskStore';
import { hydrateVorgangStore } from './vorgangService';
import { getDocumentCase } from '../test/document-cases/_lib/loadCases';
import { runStablePipeline, testProfile } from '../test/document-cases/_lib/runStablePipeline';
import type { DocumentWorkResult } from '../types/documentWorkResult';
import type { WorkflowResult } from '../types/models';
import { DOCUMENT_WORK_RESULT_ANALYSIS_VERSION } from '../types/documentWorkResult';

function seedHotelInbox() {
  const docCase = getDocumentCase('HOTEL-01');
  const observation = runStablePipeline(docCase);
  hydrateInboxStore([observation.item]);
  const workflow = processUploadedDocument(observation.item.id) ?? observation.workflow;
  const item = getInboxItemById(observation.item.id)!;
  return { workflow, item };
}

describe('DOCUMENT-WORK-RESULT-01A', () => {
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

  it('projiziert deterministisch aus WorkflowResult', () => {
    const { workflow, item } = seedHotelInbox();
    const a = projectDocumentWorkResultFromWorkflow({
      workflow,
      inboxItem: item,
      analyzedAt: '2026-07-28T12:00:00.000Z',
      analysisVersion: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
      workspaceId: 'ws-1',
    });
    const b = projectDocumentWorkResultFromWorkflow({
      workflow,
      inboxItem: item,
      analyzedAt: '2026-07-28T12:00:00.000Z',
      analysisVersion: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
      workspaceId: 'ws-1',
    });
    expect(a).toEqual(b);
    expect(a.inboxItemId).toBe(item.id);
    expect(a.businessInterpretation?.operational.primaryCase).toMatch(/expense_/);
    expect(a.overlay).toEqual([]);
    expect(a.specialistRefs.companyRelevant).toBe(true);
  });

  it('serialisiert und lädt unverändert', () => {
    const { workflow, item } = seedHotelInbox();
    const projected = projectDocumentWorkResultFromWorkflow({ workflow, inboxItem: item });
    const roundTrip = deserializeDocumentWorkResult(serializeDocumentWorkResult(projected));
    expect(roundTrip).toEqual(projected);
  });

  it('aktualisiert und persistiert DWR nach processUploadedDocument', () => {
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const { item } = seedHotelInbox();
    expect(getDocumentWorkResult(item.id)).not.toBeNull();
    expect(persistSpy).toHaveBeenCalled();

    resetDocumentWorkResultStoreForTests();
    expect(getDocumentWorkResult(item.id)).toBeNull();

    hydrateStoresFromStorage();
    const restored = getDocumentWorkResult(item.id);
    expect(restored?.businessInterpretation?.operational.primaryCase).toMatch(/expense_/);
  });

  it('expliziter Flush schreibt DocumentWorkResults dauerhaft', () => {
    const { item } = seedHotelInbox();
    // Analysis already flushed; verify reload still works after another flush.
    expect(getDocumentWorkResult(item.id)).not.toBeNull();

    const result = flushDocumentWorkResultPersistence();
    expect(result.success).toBe(true);

    resetDocumentWorkResultStoreForTests();
    hydrateStoresFromStorage();
    expect(getDocumentWorkResult(item.id)).not.toBeNull();
  });

  it('stellt nach simuliertem State-Verlust Snapshot wieder her (nicht ausführbar)', () => {
    const { item, workflow } = seedHotelInbox();
    const saved = getDocumentWorkResult(item.id)!;
    const shell = buildWorkflowResultFromDocumentWorkResult(saved, item);
    expect(shell.inboxItemId).toBe(item.id);
    expect(shell.businessInterpretation?.operational.primaryCase).toBe(
      workflow.businessInterpretation?.operational.primaryCase,
    );
    expect(isDocumentWorkResultUsableForDisplay(saved, item)).toBe(true);
    expect(isRestoredDocumentWorkResultWorkflow(shell)).toBe(true);
    expect(shell.contractOrderProposal).toBeNull();
    expect(shell.suggestedTasks).toEqual([]);
    expect(shell.warnings.some((w) => w.id === 'document_work_result_restored_snapshot')).toBe(
      true,
    );
  });

  it('akzeptiert unvollständiges WorkflowResult und fehlende Specialists (Memory-Upsert)', () => {
    const { item } = seedHotelInbox();
    const incomplete: WorkflowResult = {
      inboxItemId: item.id,
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
      suggestedArchiveFolder: item.digitalFolder,
      requiredDocuments: [],
      pendingSummary: null,
      warnings: [],
      nextActions: [],
      businessInterpretation: null,
    };
    const projected = projectDocumentWorkResultFromWorkflow({
      workflow: incomplete,
      inboxItem: item,
    });
    expect(projected.businessInterpretation).toBeNull();
    expect(projected.specialistRefs.hasContractIntelligence).toBe(false);
    // Low-level memory upsert still allows null BI; analysis commit path must not.
    const merged = upsertDocumentWorkResultFromWorkflow(incomplete, item);
    expect(merged.businessInterpretation).toBeNull();
  });

  it('bewahrt Overlay bei Re-Analyse (confirmed/corrected/discarded) ohne BI zu überschreiben', () => {
    const { workflow, item } = seedHotelInbox();
    let current = projectDocumentWorkResultFromWorkflow({ workflow, inboxItem: item });
    current = upsertDocumentWorkResultOverlayEntry(current, {
      slotId: 'operational.nextStep',
      status: 'user_confirmed',
      value: 'Manuell bestätigt',
      updatedAt: '2026-07-28T10:00:00.000Z',
      analysisVersionAtWrite: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    current = upsertDocumentWorkResultOverlayEntry(current, {
      slotId: 'facts.money.0',
      status: 'user_corrected',
      value: { amount: 1 },
      updatedAt: '2026-07-28T10:01:00.000Z',
    });
    current = upsertDocumentWorkResultOverlayEntry(current, {
      slotId: 'facts.parties.counterparty',
      status: 'discarded',
      value: null,
      updatedAt: '2026-07-28T10:02:00.000Z',
    });
    upsertDocumentWorkResult(current);

    const nextProjected = projectDocumentWorkResultFromWorkflow({
      workflow: {
        ...workflow,
        businessInterpretation: workflow.businessInterpretation
          ? {
              ...workflow.businessInterpretation,
              operational: {
                ...workflow.businessInterpretation.operational,
                nextStep: 'Neuer Analyse-Vorschlag',
              },
            }
          : null,
      },
      inboxItem: item,
      analyzedAt: '2026-07-28T11:00:00.000Z',
    });
    const merged = mergeDocumentWorkResultOnReanalysis(current, nextProjected);
    expect(resolveDocumentWorkResultOverlaySlot(merged, 'operational.nextStep')?.status).toBe(
      'user_confirmed',
    );
    expect(resolveDocumentWorkResultOverlaySlot(merged, 'operational.nextStep')?.value).toBe(
      'Manuell bestätigt',
    );
    expect(resolveDocumentWorkResultOverlaySlot(merged, 'facts.money.0')?.status).toBe(
      'user_corrected',
    );
    expect(resolveDocumentWorkResultOverlaySlot(merged, 'facts.parties.counterparty')?.status).toBe(
      'discarded',
    );
    // FIX-01: overlay is preserved only — analysis BI core is not rewritten by overlay.
    expect(merged.businessInterpretation?.operational.nextStep).toBe('Neuer Analyse-Vorschlag');
    expect(merged.overlay).toHaveLength(3);
  });

  it('markiert Overlay-Konflikt bei geändertem Fingerprint ohne Duplikate', () => {
    const { workflow, item } = seedHotelInbox();
    let current = projectDocumentWorkResultFromWorkflow({ workflow, inboxItem: item });
    current = upsertDocumentWorkResultOverlayEntry(current, {
      slotId: 'operational.nextStep',
      status: 'user_confirmed',
      value: 'Alt bestätigt',
      updatedAt: '2026-07-28T10:00:00.000Z',
    });
    const nextProjected: DocumentWorkResult = {
      ...projectDocumentWorkResultFromWorkflow({ workflow, inboxItem: item }),
      sourceFingerprint: 'hash:totally-different',
      analyzedAt: '2026-07-28T12:00:00.000Z',
    };
    const merged = mergeDocumentWorkResultOnReanalysis(current, nextProjected);
    const slot = resolveDocumentWorkResultOverlaySlot(merged, 'operational.nextStep');
    expect(slot?.status).toBe('user_confirmed');
    expect(slot?.value).toBe('Alt bestätigt');
    expect(slot?.reviewConflict).toBe(true);
    expect(slot?.conflictReason).toBe('source_fingerprint_changed');
    expect(merged.overlay).toHaveLength(1);

    // Second merge with same fingerprint delta must not duplicate overlay rows.
    const mergedAgain = mergeDocumentWorkResultOnReanalysis(merged, {
      ...nextProjected,
      analyzedAt: '2026-07-28T13:00:00.000Z',
    });
    expect(mergedAgain.overlay).toHaveLength(1);
    expect(mergedAgain.overlay[0]?.reviewConflict).toBe(true);
    expect(mergedAgain.overlay[0]?.conflictReason).toBe('source_fingerprint_changed');
  });

  it('aktualisiert analysisVersion ohne Overlay zu verlieren', () => {
    const { workflow, item } = seedHotelInbox();
    let current = projectDocumentWorkResultFromWorkflow({ workflow, inboxItem: item });
    current = upsertDocumentWorkResultOverlayEntry(current, {
      slotId: 'operational.nextStep',
      status: 'user_confirmed',
      value: 'Bleibt',
      updatedAt: '2026-07-28T10:00:00.000Z',
    });
    const next = projectDocumentWorkResultFromWorkflow({
      workflow,
      inboxItem: item,
      analysisVersion: '01a.2-test',
    });
    const merged = mergeDocumentWorkResultOnReanalysis(current, next);
    expect(merged.analysisVersion).toBe('01a.2-test');
    expect(merged.overlay).toHaveLength(1);
    expect(merged.overlay[0]?.status).toBe('user_confirmed');
    expect(merged.overlay[0]?.value).toBe('Bleibt');
  });

  it('isoliert Snapshots pro Inbox-ID und entfernt sie beim Löschen', () => {
    const first = seedHotelInbox();
    const secondCase = getDocumentCase('HOTEL-01');
    const secondObs = runStablePipeline(secondCase);
    const secondItem = {
      ...secondObs.item,
      id: `${secondObs.item.id}-b`,
    };
    hydrateInboxStore([first.item, secondItem]);
    processUploadedDocument(secondItem.id);
    expect(getDocumentWorkResult(first.item.id)).not.toBeNull();
    expect(getDocumentWorkResult(secondItem.id)).not.toBeNull();

    removeStagedInboxItemById(first.item.id);
    expect(getDocumentWorkResult(first.item.id)).toBeNull();
    expect(getDocumentWorkResult(secondItem.id)).not.toBeNull();
  });

  it('lehnt fremden Workspace-Snapshot ab, akzeptiert fehlenden workspaceId', () => {
    const { workflow, item } = seedHotelInbox();
    const withWs = projectDocumentWorkResultFromWorkflow({
      workflow,
      inboxItem: item,
      workspaceId: 'ws-a',
    });
    upsertDocumentWorkResult(withWs);
    expect(getDocumentWorkResult(item.id, { workspaceId: 'ws-b' })).toBeNull();
    expect(getDocumentWorkResult(item.id, { workspaceId: 'ws-a' })?.workspaceId).toBe('ws-a');

    const legacy = { ...withWs, workspaceId: null };
    upsertDocumentWorkResult(legacy);
    expect(getDocumentWorkResult(item.id, { workspaceId: 'ws-b' })?.inboxItemId).toBe(item.id);
  });

  it('Fingerprint ist stabil für denselben Inbox-Inhalt', () => {
    const { item } = seedHotelInbox();
    expect(buildDocumentWorkResultSourceFingerprint(item)).toBe(
      buildDocumentWorkResultSourceFingerprint(item),
    );
  });

  it('hydrate ersetzt Store vollständig (Reset-Konvention)', () => {
    const { item } = seedHotelInbox();
    expect(getDocumentWorkResultStoreSnapshot().length).toBeGreaterThan(0);
    hydrateDocumentWorkResultStore([]);
    expect(getDocumentWorkResult(item.id)).toBeNull();
  });

  it('Hydration überspringt ungültige Einträge ohne App-Abbruch', () => {
    const { workflow, item } = seedHotelInbox();
    const valid = projectDocumentWorkResultFromWorkflow({
      workflow,
      inboxItem: item,
      analyzedAt: '2026-07-28T12:00:00.000Z',
    });
    const otherItemId = `${item.id}-other`;
    const validOther = {
      ...valid,
      inboxItemId: otherItemId,
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(() =>
      hydrateDocumentWorkResultStore([
        valid,
        { schemaVersion: 99, inboxItemId: 'bad-version' },
        { not: 'a result' },
        null,
        validOther,
      ] as never),
    ).not.toThrow();

    expect(getDocumentWorkResult(item.id)?.inboxItemId).toBe(item.id);
    expect(getDocumentWorkResult(otherItemId)?.inboxItemId).toBe(otherItemId);
    expect(warnSpy).toHaveBeenCalled();

    resetDocumentWorkResultStoreForTests();
    savePersistedState({
      ...buildPersistedStateSnapshot(),
      documentWorkResults: undefined,
    });
    expect(() => hydrateStoresFromStorage()).not.toThrow();
    expect(getDocumentWorkResultStoreSnapshot()).toEqual([]);
  });

  it('persistDocumentWorkResultFromWorkflow persistiert nur bei persist:true', () => {
    const { workflow, item } = seedHotelInbox();
    const spy = vi.spyOn(persistenceService, 'persistAll');
    spy.mockClear();
    persistDocumentWorkResultFromWorkflow(workflow, item);
    expect(spy).not.toHaveBeenCalled();
    persistDocumentWorkResultFromWorkflow(workflow, item, { persist: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('getDocumentWorkResultForItem isoliert Dokumente', () => {
    const first = seedHotelInbox();
    expect(getDocumentWorkResultForItem(first.item.id)?.inboxItemId).toBe(first.item.id);
    expect(getDocumentWorkResultForItem(`${first.item.id}-missing`)).toBeNull();
  });

  it('Reset leert DocumentWorkResults über persistAll-Reset-Pfad', () => {
    const { item } = seedHotelInbox();
    expect(getDocumentWorkResult(item.id)).not.toBeNull();
    persistAll();
    resetDocumentWorkResultStoreForTests();
    expect(getDocumentWorkResult(item.id)).toBeNull();
  });
});
