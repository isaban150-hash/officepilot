/**
 * Persistenz-/Reload-Smoke für WV-LV-01.
 * Speichert Inbox inkl. OCR-Text, leert Stores, lädt neu, re-analysiert via CI+BI.
 * Hinweis: voller processUploadedDocument mit Mehrseiten-Fixture hängt lokal (>10 Min) —
 * deshalb Re-Analyse über vorhandene Contract-Intelligence + Business Interpretation.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { hydrateVorgangStore } from '../../services/vorgangService';
import { getInboxItemById } from '../../services/inboxService';
import {
  applyStateToStores,
  loadPersistedState,
  persistAll,
} from '../../services/persistenceService';
import { resetTestStores } from '../resetStores';
import { getDocumentCase } from './_lib/loadCases';
import { runStablePipeline, testProfile } from './_lib/runStablePipeline';
import { hydrateCompanyProfileStore } from '../../services/companyProfileService';
import {
  analyzeContractIntelligenceFromText,
  buildContractOrderProposal,
} from '../../services/contractIntelligenceService';
import { interpretBusinessFromWorkflow } from '../../services/businessInterpretationService';
import { amountsClose, nameContainsExpected, parseAmountNumber } from './_lib/normalize';
import type { WorkflowResult } from '../../types/models';

describe('REAL-DOCUMENT-TEST-FOUNDATION-01A — Persistenz-Smoke WV-LV-01', () => {
  beforeEach(() => {
    hydrateVorgangStore([]);
  });

  it('schützt Datenverlust: Geld/Parteien/Positionen nach Speichern und Reload per Re-Analyse', () => {
    const docCase = getDocumentCase('WV-LV-01');
    const first = runStablePipeline(docCase);
    const bi1 = first.workflow.businessInterpretation;
    expect(bi1).not.toBeNull();
    expect(first.usedSpecialistPath).toBe(true);

    const moneyBefore = (bi1!.facts.money ?? [])
      .map((m) => m.amount ?? parseAmountNumber(m.amountFormatted))
      .filter((n): n is number => n != null);
    const positionsBefore = bi1!.facts.positions.length;
    const counterpartyBefore = bi1!.facts.parties.counterparty?.name;

    expect(moneyBefore.length).toBeGreaterThan(0);
    expect(positionsBefore).toBeGreaterThanOrEqual(10);

    const persistResult = persistAll();
    expect(persistResult.success).toBe(true);

    resetTestStores();
    hydrateCompanyProfileStore(testProfile);
    const loaded = loadPersistedState();
    expect(loaded).not.toBeNull();
    applyStateToStores(loaded!);

    const reloadedItem = getInboxItemById(first.item.id);
    expect(reloadedItem).toBeTruthy();
    const extracted =
      reloadedItem!.recognizedData._extractedText ||
      reloadedItem!.recognizedData._vertragstext;
    expect(extracted && extracted.length > 100).toBe(true);

    const pagesRaw = reloadedItem!.recognizedData._pageTexts;
    const pages = pagesRaw
      ? (JSON.parse(pagesRaw) as Array<{ pageNumber: number; text: string }>)
      : docCase.pages;

    const intelligence = analyzeContractIntelligenceFromText(extracted!, pages);
    const proposal = intelligence
      ? buildContractOrderProposal(reloadedItem!, intelligence)
      : null;
    const core: Omit<WorkflowResult, 'businessInterpretation'> = {
      inboxItemId: reloadedItem!.id,
      companyRelevant: true,
      companyRelevance: { isRelevant: true, reasons: [], matchedHints: [] },
      classifiedKind: intelligence?.classifiedKind ?? 'werkvertrag',
      classificationConfidence: 'high',
      classification: null,
      documentExplanation: null,
      documentUnderstanding: null,
      documentAiActions: [],
      contractAnalysis: null,
      contractIntelligence: intelligence,
      contractOrderProposal: proposal,
      suggestedVorgang: null,
      similarVorgaenge: [],
      suggestedOrderPositions: [],
      suggestedTasks: [],
      suggestedArchiveFolder: reloadedItem!.digitalFolder,
      requiredDocuments: [],
      pendingSummary: null,
      warnings: [],
      nextActions: [
        { id: 'archive_document', labelKey: 'intake.action.archive', enabled: true },
        { id: 'cancel', labelKey: 'intake.action.cancel', enabled: true },
      ],
    };
    const bi2 = interpretBusinessFromWorkflow({
      item: reloadedItem!,
      workflow: core,
      linkedVorgang: null,
    });

    const moneyAfter = (bi2.facts.money ?? [])
      .map((m) => m.amount ?? parseAmountNumber(m.amountFormatted))
      .filter((n): n is number => n != null);
    expect(moneyAfter.length).toBeGreaterThan(0);
    expect(
      moneyBefore.some((before) => moneyAfter.some((after) => amountsClose(before, after))),
    ).toBe(true);
    expect(bi2.facts.positions.length).toBeGreaterThanOrEqual(10);

    if (counterpartyBefore) {
      expect(
        nameContainsExpected(bi2.facts.parties.counterparty?.name, counterpartyBefore) ||
          bi2.facts.parties.others.some((p) =>
            nameContainsExpected(p.name, counterpartyBefore),
          ),
      ).toBe(true);
    }

    // Architekturbruch: BI-facts werden nicht selbst persistiert (nur OCR/Inbox).
    expect(loaded!.inboxItems.some((i) => i.id === first.item.id)).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(loaded!, 'businessInterpretation')).toBe(
      false,
    );
  });
});
