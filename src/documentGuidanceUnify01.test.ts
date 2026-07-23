import { describe, expect, it, afterEach } from 'vitest';
import { t, type TranslationKey } from './i18n';
import {
  buildDocumentGuidance,
  guidanceHasSoftWording,
  guidanceIsInternallyConsistent,
} from './services/documentGuidanceService';
import { buildInboxDocumentAssistant } from './services/documentAssistantService';
import { getLetterExplanation } from './services/letterExplanationService';
import { resolvePaperFilingFromInbox } from './services/paperFolderService';
import { createAuftragInboxItem } from './test/fixtures';
import { createMockInboxItemFromUpload } from './services/inboxUploadFactory';
import { withInboxExtractedDocumentText } from './services/inboxDocumentText';
import { resetTestStores } from './test/resetStores';
import type { InboxItem, WorkflowResult } from './types/models';

function translateBlock(
  block: { key: TranslationKey; params?: Record<string, string | number> },
  lang: 'de' = 'de',
): string {
  let text = t(block.key, lang);
  if (!block.params) return text;
  for (const [name, value] of Object.entries(block.params)) {
    if (name === 'typeKey' || name === 'originalKey' || name === 'storageKey') {
      text = text.replace(`{${name}}`, t(value as TranslationKey, lang));
    } else {
      text = text.replace(`{${name}}`, String(value));
    }
  }
  return text;
}

function minimalWorkflow(item: InboxItem, overrides: Partial<WorkflowResult> = {}): WorkflowResult {
  return {
    inboxItemId: item.id,
    companyRelevant: true,
    companyRelevance: { status: 'relevant', reasons: [] },
    classifiedKind: item.classifiedKind ?? 'sonstiges',
    classificationConfidence: 'high',
    classification: {
      documentType: item.documentType,
      classifiedKind: item.classifiedKind ?? 'sonstiges',
      digitalFolder: item.digitalFolder,
      paperFiling: item.paperFiling,
      recommendedAction: item.recommendedAction,
      suggestedVorgang: null,
    },
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
    ...overrides,
  } as WorkflowResult;
}

function assertSingleConsistentGuidance(item: InboxItem, workflow?: WorkflowResult | null) {
  const guidance = buildDocumentGuidance(item, workflow, 'de');
  const answers = [
    translateBlock(guidance.what),
    translateBlock(guidance.whyReceived),
    translateBlock(guidance.mustAct),
    translateBlock(guidance.deadline),
    translateBlock(guidance.mustReply),
    translateBlock(guidance.retain),
    translateBlock(guidance.paperFolder),
    ...guidance.actions.map((action) => t(action.labelKey, 'de')),
  ];

  expect(guidance).toBeTruthy();
  expect(guidanceIsInternallyConsistent(guidance)).toBe(true);
  expect(guidance.sources.assistant).toBe(true);
  expect(guidance.sources.paper).toBe(true);
  expect(guidance.sources.understanding).toBe(true);
  expect(guidance.sources.storage).toBe(true);
  expect(guidance.disclaimerKey).toBe('legal.disclaimer');
  expect(guidanceHasSoftWording(answers)).toBe(true);

  // Reused services stay aligned with composed guidance.
  const assistant = buildInboxDocumentAssistant(item, workflow, 'de');
  expect(assistant.documentTypeLabelKey).toBeTruthy();
  const paper = resolvePaperFilingFromInbox(item);
  if (paper.skipPhysicalFiling) {
    expect(guidance.paperFolder.key).toBe('docGuidance.paper.skip');
  } else {
    expect(guidance.paperFolder.key).toBe('docGuidance.paper.recommended');
  }

  return guidance;
}

describe('DOC-GUIDANCE-UNIFY-01', () => {
  afterEach(() => {
    resetTestStores();
  });

  it('Guidance für Werkvertrag', () => {
    const item = createAuftragInboxItem({
      id: 'guidance-werkvertrag',
      title: 'Werkvertrag Sanierung',
      classifiedKind: 'werkvertrag',
      documentType: 'kundenauftrag',
      sender: 'Bau GmbH',
      recognizedData: { Betreff: 'Werkvertrag', Kunde: 'Bau GmbH' },
    });
    const guidance = assertSingleConsistentGuidance(item, minimalWorkflow(item, {
      documentAiActions: [
        { id: 'create_order', labelKey: 'document.aiAction.createOrder', recommended: true },
        { id: 'archive_document', labelKey: 'document.aiAction.archive', recommended: true },
      ],
    }));

    expect(translateBlock(guidance.what)).toMatch(/Werkvertrag|Wahrscheinlich/i);
    expect(guidance.actions.some((a) => a.labelKey === 'docGuidance.action.checkContract')).toBe(true);
    expect(guidance.actions.some((a) => a.labelKey === 'docGuidance.action.createVorgang')).toBe(true);
    expect(guidance.mustAct.key).toBe('docGuidance.act.likely');
  });

  it('Guidance für Finanzamt', () => {
    const item = createAuftragInboxItem({
      id: 'guidance-finanzamt',
      title: 'Finanzamt Schreiben',
      sender: 'Finanzamt München',
      classifiedKind: 'finanzamt',
      documentType: 'behoerde',
      deadline: '2026-08-15',
      recognizedData: { Absender: 'Finanzamt München', Betreff: 'Steuerliche Mitteilung' },
    });
    const guidance = assertSingleConsistentGuidance(item);
    expect(getLetterExplanation(item)).not.toBeNull();
    expect(guidance.sources.letter).toBe(true);
    expect(guidance.mustReply.key).toBe('docGuidance.reply.likely');
    expect(guidance.deadline.key).toBe('docGuidance.deadline.known');
    expect(translateBlock(guidance.whyReceived).length).toBeGreaterThan(10);
  });

  it('Guidance für BG BAU', () => {
    const item = createMockInboxItemFromUpload({
      sourceFileName: 'bg-bau.pdf',
      kind: 'bg_bau',
      recognizedText: 'BG BAU Berufsgenossenschaft Beitrag',
      senderHint: 'BG BAU',
    });
    const guidance = assertSingleConsistentGuidance(item);
    expect(item.classifiedKind === 'bg_bau' || /bg/i.test(item.sender + item.title)).toBe(true);
    expect(guidance.whyReceived.key === 'docGuidance.why.authority' || guidance.sources.letter).toBe(
      true,
    );
    expect(guidance.mustAct.key).not.toBe('docGuidance.act.probablyNot');
  });

  it('Guidance für Werbung', () => {
    const item = createMockInboxItemFromUpload({
      sourceFileName: 'flyer.pdf',
      kind: 'werbung',
      recognizedText: 'Sonderangebot Prospekt Werbung',
      senderHint: 'Werbepartner',
    });
    const guidance = assertSingleConsistentGuidance(item);
    expect(item.isAdvertisement).toBe(true);
    expect(guidance.whyReceived.key).toBe('docGuidance.why.advertisement');
    expect(guidance.mustAct.key).toBe('docGuidance.act.probablyNot');
    expect(guidance.mustReply.key).toBe('docGuidance.reply.probablyNot');
    expect(guidance.paperFolder.key).toBe('docGuidance.paper.skip');
    expect(guidance.actions.some((a) => a.labelKey === 'reviewWorkflow.recommend.dispose')).toBe(
      true,
    );
  });

  it('Guidance für Rechnung', () => {
    const item = createAuftragInboxItem({
      id: 'guidance-rechnung',
      title: 'Materialrechnung',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      sender: 'Großhandel GmbH',
      recognizedData: { Rechnungsnummer: 'R-100', Betrag: '250,00 €' },
    });
    const guidance = assertSingleConsistentGuidance(item);
    expect(guidance.whyReceived.key).toBe('docGuidance.why.invoice');
    expect(guidance.actions.some((a) => a.labelKey === 'docGuidance.action.checkInvoice')).toBe(
      true,
    );
    expect(guidance.mustAct.key).toBe('docGuidance.act.likely');
  });

  it('Guidance ohne OCR', () => {
    const base = createAuftragInboxItem({
      id: 'guidance-no-ocr',
      title: 'Unleserlicher Scan',
      classifiedKind: 'sonstiges',
      documentType: 'sonstiges',
      sender: 'Unbekannter Absender',
      recognizedData: {},
    });
    const item = withInboxExtractedDocumentText(base, '');
    const guidance = assertSingleConsistentGuidance(item);
    expect(guidance.what.key).toMatch(/docGuidance\.what\./);
    expect([
      'docGuidance.deadline.unknown',
      'letter.explain.deadline.none',
    ]).toContain(guidance.deadline.key);
    expect(guidance.actions.length).toBeGreaterThan(0);
    expect(guidanceIsInternallyConsistent(guidance)).toBe(true);
  });

  it('genau eine Guidance ohne widersprüchliche Aussagen', () => {
    const cases: InboxItem[] = [
      createAuftragInboxItem({ classifiedKind: 'werkvertrag', documentType: 'kundenauftrag' }),
      createAuftragInboxItem({
        classifiedKind: 'finanzamt',
        documentType: 'behoerde',
        sender: 'Finanzamt',
        deadline: '2026-09-01',
      }),
      createMockInboxItemFromUpload({ kind: 'werbung', recognizedText: 'Werbung Prospekt' }),
    ];

    for (const item of cases) {
      const first = buildDocumentGuidance(item, null, 'de');
      const second = buildDocumentGuidance(item, null, 'de');
      expect(first).toEqual(second);
      expect(guidanceIsInternallyConsistent(first)).toBe(true);
      expect(first.actions.length).toBeGreaterThan(0);
    }
  });
});
