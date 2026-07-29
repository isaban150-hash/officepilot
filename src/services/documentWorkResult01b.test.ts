/**
 * DOCUMENT-WORK-RESULT-01B — resolve TruthView, Overview + Assist consumers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateDocumentStore } from './documentService';
import { buildInboxDocumentAssistant } from './documentAssistantService';
import { buildDocumentAiContextFromInbox } from './document/documentAiContextService';
import { buildDocumentAiPrompt } from './document/documentAiPromptBuilder';
import {
  buildDocumentWorkTruthAssistContextLines,
  buildDocumentWorkTruthConflictDisplayLines,
  buildDocumentWorkTruthViewForInboxItem,
  projectDocumentWorkResultFromWorkflow,
  resetDocumentWorkResultStoreForTests,
  resolveDocumentWorkResult,
  upsertDocumentWorkResult,
  upsertDocumentWorkResultOverlayEntry,
} from './documentWorkResultService';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { processUploadedDocument } from './intakeWorkflowService';
import {
  buildOperationalOverviewView,
  buildOperationalOverviewViewFromTruth,
} from './operationalOverviewView';
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

function baseDwr(workflow: WorkflowResult, item: ReturnType<typeof getInboxItemById>): DocumentWorkResult {
  return projectDocumentWorkResultFromWorkflow({
    workflow,
    inboxItem: item!,
    analyzedAt: '2026-07-28T12:00:00.000Z',
    analysisVersion: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
  });
}

describe('DOCUMENT-WORK-RESULT-01B', () => {
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

  describe('Resolver', () => {
    it('user_confirmed ersetzt bekannten KI-Wert (nextStep)', () => {
      const { workflow, item } = seedHotelInbox();
      let dwr = baseDwr(workflow, item);
      const analysisNext = dwr.businessInterpretation!.operational.nextStep;
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'operational.nextStep',
        status: 'user_confirmed',
        value: 'Manuell bestätigt',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      const truth = resolveDocumentWorkResult({
        documentWorkResult: dwr,
        liveBusinessInterpretation: workflow.businessInterpretation,
      })!;
      expect(truth.source).toBe('live_merged');
      expect(truth.businessInterpretation?.operational.nextStep).toBe('Manuell bestätigt');
      expect(truth.slots[0]?.provenance).toBe('user_confirmed');
      expect(truth.slots[0]?.analysisValue).toBe(analysisNext);
      expect(dwr.businessInterpretation?.operational.nextStep).toBe(analysisNext);
      expect(workflow.businessInterpretation?.operational.nextStep).toBe(analysisNext);
    });

    it('user_corrected ersetzt bekannten KI-Wert (counterparty, money, deadline, summary, confirm)', () => {
      const { workflow, item } = seedHotelInbox();
      let dwr = baseDwr(workflow, item);
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.parties.counterparty',
        status: 'user_corrected',
        value: 'Korrigierte Firma GmbH',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.money.0',
        status: 'user_corrected',
        value: { amount: 42, currency: 'EUR' },
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.timeline.deadline',
        status: 'user_corrected',
        value: '31.12.2026',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'meaning.summary',
        status: 'user_corrected',
        value: 'Korrigierte Zusammenfassung',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'operational.confirmRequirement',
        status: 'user_corrected',
        value: 'Bitte Betrag prüfen',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.parties.ownCompany',
        status: 'user_corrected',
        value: 'Mein Betrieb UG',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });

      const truth = resolveDocumentWorkResult({
        documentWorkResult: dwr,
        liveBusinessInterpretation: workflow.businessInterpretation,
      })!;
      expect(truth.businessInterpretation?.facts.parties.counterparty?.name).toBe(
        'Korrigierte Firma GmbH',
      );
      expect(truth.businessInterpretation?.facts.money[0]?.amount).toBe(42);
      expect(truth.businessInterpretation?.facts.timeline.deadline?.value).toBe('31.12.2026');
      expect(truth.businessInterpretation?.meaning.summary).toBe('Korrigierte Zusammenfassung');
      expect(truth.businessInterpretation?.operational.confirmRequirement).toBe(
        'Bitte Betrag prüfen',
      );
      expect(truth.businessInterpretation?.facts.parties.ownCompany?.name).toBe('Mein Betrieb UG');
      expect(truth.slots.every((s) => s.provenance === 'user_corrected')).toBe(true);
    });

    it('discarded entfernt Vorschlag und verändert keine Nachbarfelder', () => {
      const { workflow, item } = seedHotelInbox();
      let dwr = baseDwr(workflow, item);
      const moneyBefore = dwr.businessInterpretation!.facts.money.length;
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'operational.nextStep',
        status: 'discarded',
        value: null,
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.parties.counterparty',
        status: 'discarded',
        value: null,
        updatedAt: '2026-07-28T10:01:00.000Z',
      });
      const truth = resolveDocumentWorkResult({
        documentWorkResult: dwr,
        liveBusinessInterpretation: workflow.businessInterpretation,
      })!;
      expect(truth.businessInterpretation?.operational.nextStep).toBe('');
      expect(truth.businessInterpretation?.facts.parties.counterparty).toBeUndefined();
      expect(truth.businessInterpretation?.facts.money.length).toBe(moneyBefore);
      expect(truth.slots.filter((s) => s.provenance === 'discarded')).toHaveLength(2);
    });

    it('discarded money.0 entfernt nur den primären Geldwert', () => {
      const { workflow, item } = seedHotelInbox();
      let dwr = baseDwr(workflow, item);
      const bi = dwr.businessInterpretation!;
      dwr = {
        ...dwr,
        businessInterpretation: {
          ...bi,
          facts: {
            ...bi.facts,
            money: [
              {
                kind: 'other',
                amount: 10,
                certainty: 'proposed',
                source: 'understanding',
              },
              {
                kind: 'other',
                amount: 20,
                certainty: 'proposed',
                source: 'understanding',
              },
            ],
          },
        },
      };
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.money.0',
        status: 'discarded',
        value: null,
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      const truth = resolveDocumentWorkResult({
        documentWorkResult: dwr,
        liveBusinessInterpretation: dwr.businessInterpretation,
      })!;
      expect(truth.businessInterpretation?.facts.money).toHaveLength(1);
      expect(truth.businessInterpretation?.facts.money[0]?.amount).toBe(20);
    });

    it('unbekannter Slot wirft nicht und wird protokolliert', () => {
      const { workflow, item } = seedHotelInbox();
      let dwr = baseDwr(workflow, item);
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'ops.unknown.slot',
        status: 'user_confirmed',
        value: true,
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      expect(() =>
        resolveDocumentWorkResult({
          documentWorkResult: dwr,
          liveBusinessInterpretation: workflow.businessInterpretation,
        }),
      ).not.toThrow();
      const truth = resolveDocumentWorkResult({
        documentWorkResult: dwr,
        liveBusinessInterpretation: workflow.businessInterpretation,
      })!;
      expect(truth.ignoredUnknownSlotIds).toContain('ops.unknown.slot');
      expect(truth.businessInterpretation).toEqual(
        expect.objectContaining({
          operational: expect.objectContaining({
            nextStep: workflow.businessInterpretation?.operational.nextStep,
          }),
        }),
      );
    });

    it('ungültiger Slot-Wert wirft nicht und behält Analysewert', () => {
      const { workflow, item } = seedHotelInbox();
      let dwr = baseDwr(workflow, item);
      const analysisNext = dwr.businessInterpretation!.operational.nextStep;
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'operational.nextStep',
        status: 'user_confirmed',
        value: { not: 'a string' },
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      const truth = resolveDocumentWorkResult({
        documentWorkResult: dwr,
        liveBusinessInterpretation: workflow.businessInterpretation,
      })!;
      expect(truth.businessInterpretation?.operational.nextStep).toBe(analysisNext);
      expect(truth.slots[0]?.valueInvalid).toBe(true);
    });

    it('deterministische Ausgabe und keine Mutation der Eingaben', () => {
      const { workflow, item } = seedHotelInbox();
      let dwr = baseDwr(workflow, item);
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'operational.nextStep',
        status: 'user_confirmed',
        value: 'Stabil',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      const dwrBefore = JSON.parse(JSON.stringify(dwr));
      const liveBefore = JSON.parse(JSON.stringify(workflow.businessInterpretation));
      const a = resolveDocumentWorkResult({
        documentWorkResult: dwr,
        liveBusinessInterpretation: workflow.businessInterpretation,
      });
      const b = resolveDocumentWorkResult({
        documentWorkResult: dwr,
        liveBusinessInterpretation: workflow.businessInterpretation,
      });
      expect(a).toEqual(b);
      expect(dwr).toEqual(dwrBefore);
      expect(workflow.businessInterpretation).toEqual(liveBefore);
    });

    it('analysisVersion ohne Fingerprint-Wechsel behält Overlay; Konflikt bei Fingerprint', () => {
      const { workflow, item } = seedHotelInbox();
      let dwr = baseDwr(workflow, item);
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'operational.nextStep',
        status: 'user_confirmed',
        value: 'Bleibt',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      const withNewVersion: DocumentWorkResult = {
        ...dwr,
        analysisVersion: '01a.2-test',
      };
      const kept = resolveDocumentWorkResult({
        documentWorkResult: withNewVersion,
        liveBusinessInterpretation: workflow.businessInterpretation,
      })!;
      expect(kept.businessInterpretation?.operational.nextStep).toBe('Bleibt');

      const conflicted: DocumentWorkResult = {
        ...dwr,
        overlay: dwr.overlay.map((entry) => ({
          ...entry,
          reviewConflict: true,
          conflictReason: 'source_fingerprint_changed',
        })),
      };
      const conflictTruth = resolveDocumentWorkResult({
        documentWorkResult: conflicted,
        liveBusinessInterpretation: workflow.businessInterpretation,
      })!;
      expect(conflictTruth.businessInterpretation?.operational.nextStep).toBe(
        workflow.businessInterpretation?.operational.nextStep,
      );
      expect(conflictTruth.unresolvedConflicts).toHaveLength(1);
      expect(conflictTruth.slots[0]?.provenance).toBe('conflict');
      expect(conflictTruth.unresolvedConflicts[0]?.userValue).toBe('Bleibt');
      expect(conflictTruth.unresolvedConflicts[0]?.analysisValue).toBe(
        workflow.businessInterpretation?.operational.nextStep,
      );

      const again = resolveDocumentWorkResult({
        documentWorkResult: conflicted,
        liveBusinessInterpretation: workflow.businessInterpretation,
      })!;
      expect(again.unresolvedConflicts).toHaveLength(1);
    });

    it('Snapshot-Quelle und Live-Quelle werden korrekt markiert', () => {
      const { workflow, item } = seedHotelInbox();
      const dwr = baseDwr(workflow, item);
      const live = resolveDocumentWorkResult({
        documentWorkResult: dwr,
        liveBusinessInterpretation: workflow.businessInterpretation,
      })!;
      expect(live.source).toBe('live_merged');
      const snap = resolveDocumentWorkResult({
        documentWorkResult: dwr,
        liveBusinessInterpretation: null,
      })!;
      expect(snap.source).toBe('snapshot');
    });
  });

  describe('Overview', () => {
    it('zeigt bestätigte/korrigierte Werte und verwirft Hauptwerte; Konflikte sichtbar', () => {
      const { workflow, item } = seedHotelInbox();
      let dwr = baseDwr(workflow, item);
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'operational.nextStep',
        status: 'user_confirmed',
        value: 'Bestätigter Schritt',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.parties.counterparty',
        status: 'user_corrected',
        value: 'Neue Gegenpartei',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.money.0',
        status: 'user_corrected',
        value: { amount: 99, amountFormatted: '99,00 EUR', currency: 'EUR' },
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      upsertDocumentWorkResult(dwr);

      const truth = buildDocumentWorkTruthViewForInboxItem({
        item,
        liveWorkflow: workflow,
      })!;
      const overview = buildOperationalOverviewView(workflow, {
        senderFallback: item.sender,
        inboxItem: item,
        displayBusinessInterpretation: truth.businessInterpretation,
        unresolvedConflictLines: buildDocumentWorkTruthConflictDisplayLines(truth),
        includePlanPreview: true,
      });
      expect(overview.nextStep).toBe('Bestätigter Schritt');
      expect(overview.counterparty).toBe('Neue Gegenpartei');
      expect(overview.moneyLabel).toMatch(/99/);

      let discarded = baseDwr(workflow, item);
      discarded = upsertDocumentWorkResultOverlayEntry(discarded, {
        slotId: 'operational.nextStep',
        status: 'discarded',
        value: null,
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      discarded = upsertDocumentWorkResultOverlayEntry(discarded, {
        slotId: 'facts.parties.counterparty',
        status: 'discarded',
        value: null,
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      const discardedTruth = resolveDocumentWorkResult({
        documentWorkResult: discarded,
        liveBusinessInterpretation: workflow.businessInterpretation,
      })!;
      const discardedOverview = buildOperationalOverviewView(workflow, {
        displayBusinessInterpretation: discardedTruth.businessInterpretation,
        includePlanPreview: true,
      });
      expect(discardedOverview.nextStep).toBeUndefined();
      expect(discardedOverview.counterparty).toBeUndefined();

      const conflicted: DocumentWorkResult = {
        ...dwr,
        overlay: [
          {
            slotId: 'operational.nextStep',
            status: 'user_confirmed',
            value: 'Alt',
            updatedAt: '2026-07-28T10:00:00.000Z',
            reviewConflict: true,
            conflictReason: 'source_fingerprint_changed',
          },
        ],
      };
      const conflictTruth = resolveDocumentWorkResult({
        documentWorkResult: conflicted,
        liveBusinessInterpretation: workflow.businessInterpretation,
      })!;
      const conflictOverview = buildOperationalOverviewView(workflow, {
        displayBusinessInterpretation: conflictTruth.businessInterpretation,
        unresolvedConflictLines: buildDocumentWorkTruthConflictDisplayLines(conflictTruth),
      });
      expect(conflictOverview.uncertaintyLines.some((line) => /Erneut prüfen/i.test(line))).toBe(
        true,
      );
      expect(conflictOverview.uncertaintyLines.join(' ')).not.toMatch(/operational\.nextStep/);
    });

    it('Snapshot kann Overview anzeigen ohne Plan-Preview; Live hat Vorrang', () => {
      const { workflow, item } = seedHotelInbox();
      let dwr = baseDwr(workflow, item);
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'operational.nextStep',
        status: 'user_confirmed',
        value: 'Nur Snapshot',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      const snapTruth = resolveDocumentWorkResult({
        documentWorkResult: dwr,
        liveBusinessInterpretation: null,
      })!;
      const snapOverview = buildOperationalOverviewViewFromTruth(
        {
          businessInterpretation: snapTruth.businessInterpretation,
          unresolvedConflictLines: buildDocumentWorkTruthConflictDisplayLines(snapTruth),
        },
        { senderFallback: item.sender, inboxItem: item },
      );
      expect(snapOverview.present).toBe(true);
      expect(snapOverview.nextStep).toBe('Nur Snapshot');
      expect(snapOverview.planPreviewRows).toEqual([]);

      const liveDifferent = {
        ...workflow.businessInterpretation!,
        operational: {
          ...workflow.businessInterpretation!.operational,
          nextStep: 'Live Schritt',
        },
      };
      const liveTruth = resolveDocumentWorkResult({
        documentWorkResult: dwr,
        liveBusinessInterpretation: liveDifferent,
      })!;
      // Overlay confirmed still wins over live analysis nextStep when no conflict.
      expect(liveTruth.source).toBe('live_merged');
      expect(liveTruth.businessInterpretation?.operational.nextStep).toBe('Nur Snapshot');
    });

    it('anderes Dokument liefert keinen Snapshot; Plan-Preview bleibt live-only', () => {
      const first = seedHotelInbox();
      let dwr = baseDwr(first.workflow, first.item);
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'operational.nextStep',
        status: 'user_confirmed',
        value: 'Nur A',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      upsertDocumentWorkResult(dwr);

      const otherCase = getDocumentCase('HOTEL-01');
      const otherObs = runStablePipeline(otherCase);
      const otherItem = { ...otherObs.item, id: `${otherObs.item.id}-other` };
      hydrateInboxStore([first.item, otherItem]);
      const otherWorkflow = processUploadedDocument(otherItem.id)!;

      const foreign = buildDocumentWorkTruthViewForInboxItem({
        item: otherItem,
        liveWorkflow: otherWorkflow,
      });
      // other doc may have its own DWR from analysis, but must not carry overlay from A
      expect(foreign?.businessInterpretation?.operational.nextStep).not.toBe('Nur A');

      const overview = buildOperationalOverviewView(first.workflow, {
        displayBusinessInterpretation: first.workflow.businessInterpretation,
        includePlanPreview: true,
        inboxItem: first.item,
      });
      // Live plan preview may be empty or filled — but includePlanPreview true uses live workflow.
      expect(overview.planPreviewTitleKey).toBeTruthy();
    });
  });

  describe('Document Assist + freie Fragen', () => {
    it('Assist-Kontext enthält bestätigte/korrigierte Fakten und schließt discarded aus', () => {
      const { workflow, item } = seedHotelInbox();
      let dwr = baseDwr(workflow, item);
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.parties.counterparty',
        status: 'user_confirmed',
        value: 'Bestätigte Gegenpartei',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.money.0',
        status: 'user_corrected',
        value: { amount: 55, amountFormatted: '55,00 EUR' },
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.timeline.deadline',
        status: 'user_confirmed',
        value: '01.08.2026',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'operational.nextStep',
        status: 'user_corrected',
        value: 'Korrigierter Schritt',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'meaning.summary',
        status: 'discarded',
        value: null,
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      upsertDocumentWorkResult(dwr);

      const assistant = buildInboxDocumentAssistant(item, workflow);
      expect(assistant.documentWorkTruthFactLines?.join('\n')).toMatch(/Bestätigte Gegenpartei/);
      expect(assistant.documentWorkTruthFactLines?.join('\n')).toMatch(/55/);
      expect(assistant.documentWorkTruthFactLines?.join('\n')).toMatch(/01\.08\.2026/);
      expect(assistant.documentWorkTruthFactLines?.join('\n')).toMatch(/Korrigierter Schritt/);
      expect(assistant.documentWorkTruthFactLines?.join('\n') ?? '').not.toMatch(
        /Zusammenfassung: .{1,}/,
      );

      const conflicted: DocumentWorkResult = {
        ...dwr,
        overlay: dwr.overlay.map((entry) =>
          entry.slotId === 'operational.nextStep'
            ? {
                ...entry,
                reviewConflict: true,
                conflictReason: 'source_fingerprint_changed',
              }
            : entry,
        ),
      };
      upsertDocumentWorkResult(conflicted);
      const conflictAssistant = buildInboxDocumentAssistant(item, workflow);
      expect(conflictAssistant.documentWorkTruthConflictLines?.join('\n')).toMatch(
        /UNGELÖSTER KONFLIKT/,
      );
      expect(conflictAssistant.documentWorkTruthConflictLines?.join('\n')).toMatch(/Erneut prüfen/);
      expect(conflictAssistant.documentWorkTruthConflictLines?.join('\n') ?? '').not.toMatch(
        /Konflikt ist (gelöst|entschieden)|automatisch entschieden/i,
      );
    });

    it('freie Frage nutzt denselben Dokumentkontext; Isolation A≠B', () => {
      const { workflow, item } = seedHotelInbox();
      let dwr = baseDwr(workflow, item);
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.parties.counterparty',
        status: 'user_confirmed',
        value: 'Nur Dokument A',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      upsertDocumentWorkResult(dwr);

      const ctxA = buildDocumentAiContextFromInbox(item, { liveWorkflow: workflow });
      expect(ctxA.documentWorkTruthFactLines?.join('\n')).toMatch(/Nur Dokument A/);
      const prompt = buildDocumentAiPrompt('Was ist die Gegenpartei?', ctxA, 'de');
      expect(prompt).toMatch(/Aufgelöste Dokumentwahrheit/);
      expect(prompt).toMatch(/Nur Dokument A/);

      const otherCase = getDocumentCase('HOTEL-01');
      const otherObs = runStablePipeline(otherCase);
      const otherItem = { ...otherObs.item, id: `${otherObs.item.id}-b` };
      hydrateInboxStore([item, otherItem]);
      const otherWorkflow = processUploadedDocument(otherItem.id)!;
      const ctxB = buildDocumentAiContextFromInbox(otherItem, { liveWorkflow: otherWorkflow });
      expect(ctxB.documentWorkTruthFactLines?.join('\n') ?? '').not.toMatch(/Nur Dokument A/);
    });

    it('bestätigter Nutzerwert wird nicht durch KI-Wert verdrängt', () => {
      const { workflow, item } = seedHotelInbox();
      let dwr = baseDwr(workflow, item);
      dwr = upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'operational.nextStep',
        status: 'user_confirmed',
        value: 'Nutzer hat Vorrang',
        updatedAt: '2026-07-28T10:00:00.000Z',
      });
      const liveBi = {
        ...workflow.businessInterpretation!,
        operational: {
          ...workflow.businessInterpretation!.operational,
          nextStep: 'Neuer KI-Vorschlag',
        },
      };
      const lines = buildDocumentWorkTruthAssistContextLines(
        resolveDocumentWorkResult({
          documentWorkResult: dwr,
          liveBusinessInterpretation: liveBi,
        })!,
      );
      expect(lines.factLines.join('\n')).toMatch(/Nutzer hat Vorrang/);
      expect(lines.factLines.join('\n')).not.toMatch(/Neuer KI-Vorschlag/);
    });
  });
});
