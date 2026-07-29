/**
 * DOCUMENT-ASSIST-02A — Single Truth for document assist (Fill-Confirm → TruthView → Prompt).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateDocumentStore } from './documentService';
import { buildInboxDocumentAssistant } from './documentAssistantService';
import { buildDocumentAiContextFromInbox } from './document/documentAiContextService';
import { buildDocumentAiPrompt } from './document/documentAiPromptBuilder';
import { mapFillConfirmRowsToSessionTruthOverlay } from './documentFieldFillConfirmTruthBridge';
import {
  buildDocumentWorkTruthAssistContextLines,
  buildDocumentWorkTruthViewForInboxItem,
  mergeDocumentWorkResultOverlayWithSession,
  projectDocumentWorkResultFromWorkflow,
  resetDocumentWorkResultStoreForTests,
  resolveDocumentWorkResult,
  upsertDocumentWorkResult,
  upsertDocumentWorkResultOverlayEntry,
} from './documentWorkResultService';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { processUploadedDocument } from './intakeWorkflowService';
import { buildOperationalOverviewView } from './operationalOverviewView';
import { setTaskStoreForTests } from './taskStore';
import { hydrateVorgangStore } from './vorgangService';
import { getDocumentCase } from '../test/document-cases/_lib/loadCases';
import { runStablePipeline, testProfile } from '../test/document-cases/_lib/runStablePipeline';
import type { DocumentFieldFillConfirmRow } from '../types/documentFieldFillConfirm';
import { DOCUMENT_WORK_RESULT_ANALYSIS_VERSION } from '../types/documentWorkResult';

function seedHotelInbox() {
  const docCase = getDocumentCase('HOTEL-01');
  const observation = runStablePipeline(docCase);
  hydrateInboxStore([observation.item]);
  const workflow = processUploadedDocument(observation.item.id) ?? observation.workflow;
  const item = getInboxItemById(observation.item.id)!;
  return { workflow, item };
}

function confirmedRow(
  fieldKey: DocumentFieldFillConfirmRow['fieldKey'],
  proposed: string,
  confirmed: string,
): DocumentFieldFillConfirmRow {
  return Object.freeze({
    fieldKey,
    label: fieldKey,
    proposedValue: proposed,
    status: 'confirmed' as const,
    confirmedValue: confirmed,
  });
}

describe('DOCUMENT-ASSIST-02A Single Truth', () => {
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

  it('Fill-Confirm bestätigt Betrag → TruthView + Overview + Assist teilen denselben Wert', () => {
    const { workflow, item } = seedHotelInbox();
    const dwr = projectDocumentWorkResultFromWorkflow({
      workflow,
      inboxItem: item,
      analyzedAt: '2026-07-28T12:00:00.000Z',
      analysisVersion: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    upsertDocumentWorkResult(dwr);

    const rows = [confirmedRow('Betrag', '100,00 EUR', '999,00 EUR')];
    const truth = buildDocumentWorkTruthViewForInboxItem({
      item,
      liveWorkflow: workflow,
      sessionFillConfirmRows: rows,
    });
    expect(truth).not.toBeNull();
    const money = truth!.businessInterpretation?.facts.money[0];
    expect(money?.amountFormatted).toContain('999');
    expect(
      truth!.slots.some(
        (s) => s.slotId === 'facts.money.0' && s.provenance === 'user_corrected',
      ),
    ).toBe(true);

    const overview = buildOperationalOverviewView(workflow, {
      displayBusinessInterpretation: truth!.businessInterpretation,
      includePlanPreview: true,
    });
    expect(overview.present).toBe(true);

    const assistant = buildInboxDocumentAssistant(item, workflow, 'de', {
      sessionFillConfirmRows: rows,
    });
    const amountField = assistant.confidentFields.find(
      (f) => f.labelKey === 'docAssistant.check.amount',
    );
    expect(amountField?.value).toContain('999');

    const ctx = buildDocumentAiContextFromInbox(item, {
      liveWorkflow: workflow,
      sessionFillConfirmRows: rows,
    });
    expect(ctx.suppressAmountHint).toBe(true);
    expect(ctx.amountHint).toBeNull();
    expect(ctx.confirmedUserFactLines?.some((l) => l.includes('999'))).toBe(true);
  });

  it('Prompt priorisiert bestätigte Nutzerdaten vor OCR-Betrag', () => {
    const { workflow, item } = seedHotelInbox();
    const mutated = {
      ...item,
      recognizedData: {
        ...item.recognizedData,
        Betrag: '111,00 EUR',
      },
    };
    hydrateInboxStore([mutated]);
    const liveItem = getInboxItemById(mutated.id)!;
    const dwr = projectDocumentWorkResultFromWorkflow({
      workflow,
      inboxItem: liveItem,
      analyzedAt: '2026-07-28T12:00:00.000Z',
      analysisVersion: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    upsertDocumentWorkResult(dwr);

    const rows = [confirmedRow('Betrag', '111,00 EUR', '777,00 EUR')];
    const ctx = buildDocumentAiContextFromInbox(liveItem, {
      liveWorkflow: workflow,
      sessionFillConfirmRows: rows,
    });
    const prompt = buildDocumentAiPrompt('Welcher Betrag gilt?', ctx, 'de');

    expect(prompt).toContain('BESTÄTIGTE NUTZERDATEN');
    expect(prompt).toContain('777,00 EUR');
    expect(prompt).toContain('OCR-Text (nur Beleg');
    expect(prompt).toMatch(/Betrag: siehe bestätigte Nutzerdaten|BESTÄTIGTE NUTZERDATEN/);
    // Competing OCR amount must not appear as structured amountHint.
    expect(ctx.amountHint).toBeNull();
    expect(ctx.recognizedDataLines.every((l) => !l.startsWith('Betrag:'))).toBe(true);
  });

  it('Session-Overlay gewinnt gegen gespeicherten Overlay-Slot', () => {
    const { workflow, item } = seedHotelInbox();
    let dwr = projectDocumentWorkResultFromWorkflow({
      workflow,
      inboxItem: item,
      analyzedAt: '2026-07-28T12:00:00.000Z',
      analysisVersion: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
      slotId: 'facts.parties.counterparty',
      status: 'user_confirmed',
      value: 'Alter Overlay-Name',
      updatedAt: '2026-07-28T10:00:00.000Z',
    });
    upsertDocumentWorkResult(dwr);

    const rows = [confirmedRow('Absender', 'Hotel', 'Neuer Fill-Name')];
    const truth = buildDocumentWorkTruthViewForInboxItem({
      item,
      liveWorkflow: workflow,
      sessionFillConfirmRows: rows,
    });
    expect(truth!.businessInterpretation?.facts.parties.counterparty?.name).toBe(
      'Neuer Fill-Name',
    );
  });

  it('mergeDocumentWorkResultOverlayWithSession: Session ersetzt gleichen Slot', () => {
    const merged = mergeDocumentWorkResultOverlayWithSession(
      [
        {
          slotId: 'facts.timeline.deadline',
          status: 'user_confirmed',
          value: '2026-01-01',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      [
        {
          slotId: 'facts.timeline.deadline',
          status: 'user_corrected',
          value: '2026-12-31',
          updatedAt: '2026-07-29T00:00:00.000Z',
        },
      ],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.value).toBe('2026-12-31');
    expect(merged[0]?.status).toBe('user_corrected');
  });

  it('Extra Fill-Confirm-Felder ohne Slot erscheinen als bestätigte Assist-Fakten', () => {
    const { workflow, item } = seedHotelInbox();
    const dwr = projectDocumentWorkResultFromWorkflow({
      workflow,
      inboxItem: item,
      analyzedAt: '2026-07-28T12:00:00.000Z',
      analysisVersion: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    upsertDocumentWorkResult(dwr);

    const rows = [confirmedRow('Aktenzeichen', 'AZ-1', 'AZ-BESTÄTIGT-99')];
    const bridge = mapFillConfirmRowsToSessionTruthOverlay(rows);
    expect(bridge.sessionOverlayEntries).toHaveLength(0);
    expect(bridge.sessionConfirmedExtraFacts[0]?.value).toBe('AZ-BESTÄTIGT-99');

    const truth = buildDocumentWorkTruthViewForInboxItem({
      item,
      liveWorkflow: workflow,
      sessionFillConfirmRows: rows,
    });
    const lines = buildDocumentWorkTruthAssistContextLines(truth!);
    expect(lines.factLines.some((l) => l.includes('AZ-BESTÄTIGT-99'))).toBe(true);
    expect(lines.factLines[0]).toContain('Nutzerbestätigung');
  });

  it('Resolver bleibt deterministisch und mutiert Inputs nicht', () => {
    const { workflow, item } = seedHotelInbox();
    const dwr = projectDocumentWorkResultFromWorkflow({
      workflow,
      inboxItem: item,
      analyzedAt: '2026-07-28T12:00:00.000Z',
      analysisVersion: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    const session = mapFillConfirmRowsToSessionTruthOverlay([
      confirmedRow('Frist', 'morgen', '2026-08-15'),
    ]);
    const before = JSON.stringify(dwr);
    const a = resolveDocumentWorkResult({
      documentWorkResult: dwr,
      liveBusinessInterpretation: workflow.businessInterpretation,
      sessionOverlayEntries: session.sessionOverlayEntries,
      sessionConfirmedExtraFacts: session.sessionConfirmedExtraFacts,
    });
    const b = resolveDocumentWorkResult({
      documentWorkResult: dwr,
      liveBusinessInterpretation: workflow.businessInterpretation,
      sessionOverlayEntries: session.sessionOverlayEntries,
      sessionConfirmedExtraFacts: session.sessionConfirmedExtraFacts,
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(dwr)).toBe(before);
    expect(a?.businessInterpretation?.facts.timeline.deadline?.value).toBe('2026-08-15');
  });
});
