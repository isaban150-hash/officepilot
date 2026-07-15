import { describe, expect, it } from 'vitest';
import { t } from './i18n';
import { buildInboxDocumentAssistant } from './services/documentAssistantService';
import {
  getDocumentQuestionSuggestionsForItem,
} from './services/documentAssistantQuestionService';
import { buildDigitalFolderSpec } from './services/documentClassificationCatalog';
import {
  classifyDocument,
  suggestDigitalFolder,
} from './services/documentClassificationService';
import { buildDocumentReviewChecks } from './services/documentReviewViewService';
import { createMockInboxItemFromUpload } from './services/inboxUploadFactory';
import { createAuftragInboxItem } from './test/fixtures';
import type { ClassifiedDocumentKind, InboxItem, WorkflowResult } from './types/models';

function createWorkflow(item: InboxItem, kind: ClassifiedDocumentKind): WorkflowResult {
  return {
    inboxItemId: item.id,
    companyRelevant: true,
    companyRelevance: {
      isRelevant: true,
      reasons: [],
      matchedHints: [],
    },
    classifiedKind: kind,
    classificationConfidence: 'high',
    classification: null,
    documentExplanation: null,
    documentUnderstanding: {
      documentType: kind,
      sender: item.sender,
      customer: item.recognizedData.Kunde,
      constructionSite: item.recognizedData.Baustelle,
      nextStep: 'Prüfen',
      partialRecognition: false,
    },
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
  };
}

describe('CUSTOMER-RESULT-CONSISTENCY-01', () => {
  it('auftrag ohne Kunde -> assign_customer status, review check customer, not confident-only', () => {
    const item = createMockInboxItemFromUpload({
      kind: 'auftrag',
      recognizedText: 'Kundenauftrag Sanierung Badezimmer',
      senderHint: 'Familie Müller',
    });
    const assistant = buildInboxDocumentAssistant(item);
    const workflow = createWorkflow(item, 'auftrag');
    const checks = buildDocumentReviewChecks(item, workflow);

    expect(assistant.recognitionStatus).toBe('assign_customer');
    expect(assistant.recognitionStatusKey).toBe('docAssistant.trust.assignCustomer');
    expect(t(assistant.recognitionStatusKey, 'de')).toBe('Erkannt – Kunde bitte zuordnen');
    expect(t(assistant.recognitionStatusKey, 'tr')).toBe('Tanındı – lütfen müşteri atayın');
    expect(t(assistant.recognitionStatusKey, 'bg')).toBe('Разпознато – моля, присвоете клиент');
    expect(assistant.uncertainFields.some((field) => field.labelKey === 'docAssistant.check.customer')).toBe(
      true,
    );
    expect(assistant.recognitionStatus).not.toBe('confident');
    expect(checks.some((check) => check.id === 'customer')).toBe(true);
  });

  it('brief uses auftragDocument key', () => {
    const item = createMockInboxItemFromUpload({
      kind: 'auftrag',
      recognizedText: 'Kundenauftrag 2026',
      senderHint: 'Müller GmbH',
    });
    const assistant = buildInboxDocumentAssistant(item);

    expect(assistant.briefLines.some((line) => line.key === 'docAssistant.brief.auftragDocument')).toBe(true);
    expect(assistant.briefLines.some((line) => line.key === 'docAssistant.brief.orderDocument')).toBe(false);
  });

  it('digital folder /Aufträge/ not /Verträge/', () => {
    const spec = buildDigitalFolderSpec('auftrag', { customer: 'Müller GmbH', sender: 'Müller GmbH' });
    expect(spec.path).toContain('/Aufträge/');
    expect(spec.path).not.toContain('/Verträge/');

    const classified = classifyDocument({
      recognizedText: 'Kundenauftrag Sanierung',
      senderHint: 'Müller GmbH',
    });
    expect(classified.classifiedKind).toBe('auftrag');
    expect(classified.digitalFolder.path).toContain('/Aufträge/');
    expect(classified.digitalFolder.path).not.toContain('/Verträge/');

    const folder = suggestDigitalFolder('auftrag', { customer: 'Müller GmbH' });
    expect(folder.path).toContain('/Aufträge/');
  });

  it('steuerberater not_relevant for auftrag', () => {
    const item = createMockInboxItemFromUpload({
      kind: 'auftrag',
      recognizedText: 'Kundenauftrag',
    });
    const assistant = buildInboxDocumentAssistant(item);

    expect(assistant.steuerberaterStatus).toBe('not_relevant');
  });

  it('no pay question for auftrag, has order questions', () => {
    const suggestions = getDocumentQuestionSuggestionsForItem('auftrag');
    const ids = suggestions.map((entry) => entry.id);

    expect(ids).not.toContain('pay');
    expect(ids).toContain('orderWhat');
    expect(ids).toContain('orderSite');
    expect(ids).toContain('orderDeadline');
    expect(ids).toContain('orderConfirm');
    expect(ids).toContain('orderNextSteps');
  });

  it('review and assistant consistency for missing customer', () => {
    const item = createAuftragInboxItem({
      classifiedKind: 'auftrag',
      recognizedData: { Leistung: 'Sanierung' },
    });
    const assistant = buildInboxDocumentAssistant(item);
    const workflow = createWorkflow(item, 'auftrag');
    const checks = buildDocumentReviewChecks(item, workflow);

    expect(assistant.recognitionStatus).toBe('assign_customer');
    expect(checks.some((check) => check.id === 'customer')).toBe(true);
  });

  it('angebot ohne Kunde requires customer assignment', () => {
    const item = createAuftragInboxItem({
      classifiedKind: 'angebot',
      recognizedData: {},
    });
    const assistant = buildInboxDocumentAssistant(item);
    const workflow = createWorkflow(item, 'angebot');
    const checks = buildDocumentReviewChecks(item, workflow);

    expect(assistant.recognitionStatus).toBe('assign_customer');
    expect(checks.some((check) => check.id === 'customer')).toBe(true);
    expect(assistant.briefLines.some((line) => line.key === 'docAssistant.brief.angebotDocument')).toBe(true);
    expect(assistant.steuerberaterStatus).toBe('not_relevant');
  });

  it('werkvertrag ohne Kunde requires customer assignment and steuerberater check', () => {
    const item = createAuftragInboxItem({
      classifiedKind: 'werkvertrag',
      recognizedData: {},
    });
    const assistant = buildInboxDocumentAssistant(item);
    const workflow = createWorkflow(item, 'werkvertrag');
    const checks = buildDocumentReviewChecks(item, workflow);

    expect(assistant.recognitionStatus).toBe('assign_customer');
    expect(checks.some((check) => check.id === 'customer')).toBe(true);
    expect(assistant.briefLines.some((line) => line.key === 'docAssistant.brief.werkvertragDocument')).toBe(true);
    expect(assistant.steuerberaterStatus).toBe('check');
  });

  it('rechnung has pay question', () => {
    const suggestions = getDocumentQuestionSuggestionsForItem('rechnung');
    expect(suggestions.map((entry) => entry.id)).toContain('pay');
  });

  it('mahnung has pay question', () => {
    const suggestions = getDocumentQuestionSuggestionsForItem('mahnung');
    expect(suggestions.map((entry) => entry.id)).toContain('pay');
  });
});
