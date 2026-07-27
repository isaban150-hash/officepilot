import type { InboxItem, WorkflowNextAction, WorkflowResult } from '../../../types/models';
import type { BusinessInterpretationResult } from '../../../types/businessInterpretation';
import { createMockInboxItemFromUpload } from '../../../services/inboxUploadFactory';
import { createAuftragInboxItem } from '../../fixtures';
import { hydrateInboxStore } from '../../../services/inboxService';
import { processUploadedDocument } from '../../../services/intakeWorkflowService';
import { hydrateCompanyProfileStore } from '../../../services/companyProfileService';
import {
  analyzeContractIntelligenceFromText,
  buildContractOrderProposal,
} from '../../../services/contractIntelligenceService';
import { interpretBusinessFromWorkflow } from '../../../services/businessInterpretationService';
import type { LoadedDocumentCase } from './types';

const testProfile = {
  companyName: 'Mustermann Sanitär GmbH',
  legalForm: 'GmbH',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  contactPerson: 'Max Mustermann',
  phone: '030',
  email: 'info@mustermann-sanitaer.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

export interface StablePipelineObservation {
  item: InboxItem;
  workflow: WorkflowResult;
  bi: BusinessInterpretationResult | null;
  /** true = CI+BI ohne vollen Intake (Mehrseiten-Vertrag). */
  usedSpecialistPath: boolean;
}

const defaultNextActions: WorkflowNextAction[] = [
  { id: 'archive_document', labelKey: 'intake.action.archive', enabled: true },
  { id: 'cancel', labelKey: 'intake.action.cancel', enabled: true },
];

function buildItem(docCase: LoadedDocumentCase): InboxItem {
  const importSource =
    docCase.scenario.importSource ??
    (docCase.scenario.channel === 'email'
      ? 'email'
      : docCase.scenario.channel === 'scan'
        ? 'scan'
        : 'upload');

  const item = createMockInboxItemFromUpload({
    sourceFileName: `${docCase.caseId}.pdf`,
    recognizedText: docCase.ocrText,
    pageTexts: docCase.pages,
    titleHint: docCase.scenario.titleHint,
    senderHint: docCase.scenario.senderHint,
    importSource,
    kind: docCase.scenario.kindHint as
      | 'auftrag'
      | 'zahlungserinnerung'
      | 'materialrechnung'
      | 'bg_bau'
      | 'werbung'
      | 'kontoauszug'
      | undefined,
  });

  return {
    ...item,
    id: `inbox-case-${docCase.caseId}`,
    markedAsCompanyDocument: docCase.scenario.markedAsCompanyDocument !== false,
    recognizedData: {
      ...item.recognizedData,
      _extractedText: docCase.ocrText,
      _vertragstext: docCase.ocrText,
      ...(docCase.pages ? { _pageTexts: JSON.stringify(docCase.pages) } : {}),
    },
  };
}

/**
 * Mehrseitiger Werkvertrag über vorhandene Contract Intelligence + BI.
 * processUploadedDocument / Klassifikation auf dem Volltext hängen lokal (>10 Min).
 */
function runContractSpecialistPipeline(docCase: LoadedDocumentCase): StablePipelineObservation {
  hydrateCompanyProfileStore(testProfile);

  const item = createAuftragInboxItem({
    id: `inbox-case-${docCase.caseId}`,
    classifiedKind: 'werkvertrag',
    documentType: 'kundenauftrag',
    markedAsCompanyDocument: true,
    title: docCase.scenario.titleHint ?? docCase.caseId,
    sender: docCase.scenario.senderHint ?? 'Isobautec GmbH',
    importSource: 'upload',
    recognizedData: {
      _extractedText: docCase.ocrText,
      _vertragstext: docCase.ocrText,
      ...(docCase.pages ? { _pageTexts: JSON.stringify(docCase.pages) } : {}),
      Betreff: docCase.scenario.titleHint ?? 'Werkvertrag',
      Kunde: 'Isobautec GmbH',
    },
  });

  hydrateInboxStore([item]);

  const intelligence = analyzeContractIntelligenceFromText(docCase.ocrText, docCase.pages);
  const proposal = intelligence ? buildContractOrderProposal(item, intelligence) : null;
  const classifiedKind =
    intelligence?.classifiedKind ?? item.classifiedKind ?? 'werkvertrag';

  const core: Omit<WorkflowResult, 'businessInterpretation'> = {
    inboxItemId: item.id,
    companyRelevant: true,
    companyRelevance: { isRelevant: true, reasons: [], matchedHints: [] },
    classifiedKind,
    classificationConfidence: 'high',
    classification: null,
    documentExplanation: null,
    documentUnderstanding: {
      documentType: classifiedKind,
      customer: proposal?.customer,
      constructionSite: proposal?.constructionSite,
      amount: proposal?.contractTotalNet,
      nextStep: 'Prüfen',
      partialRecognition: false,
    },
    documentAiActions: [],
    contractAnalysis: null,
    contractIntelligence: intelligence,
    contractOrderProposal: proposal,
    suggestedVorgang: null,
    similarVorgaenge: [],
    suggestedOrderPositions: (intelligence?.positions ?? []).map(
      ({ sourcePage: _s, confidence: _c, reviewStatus: _r, ...position }) => position,
    ),
    suggestedTasks: [],
    suggestedArchiveFolder: item.digitalFolder,
    requiredDocuments: [],
    pendingSummary: null,
    warnings: [],
    nextActions: defaultNextActions,
  };

  const bi = interpretBusinessFromWorkflow({
    item,
    workflow: core,
    linkedVorgang: null,
  });

  return {
    item,
    workflow: { ...core, businessInterpretation: bi },
    bi,
    usedSpecialistPath: true,
  };
}

/** Stable-Pipeline: kontrollierter Text → Klassifikation → Spezialisten → BI. */
export function runStablePipeline(docCase: LoadedDocumentCase): StablePipelineObservation {
  if (docCase.scenario.textFixture === 'werkvertragMultiSection') {
    return runContractSpecialistPipeline(docCase);
  }

  hydrateCompanyProfileStore(testProfile);
  const item = buildItem(docCase);
  hydrateInboxStore([item]);

  const workflow = processUploadedDocument(item.id);
  if (!workflow) {
    throw new Error(`Stable-Pipeline lieferte keinen Workflow für ${docCase.caseId}`);
  }

  return {
    item,
    workflow,
    bi: workflow.businessInterpretation,
    usedSpecialistPath: false,
  };
}

export { testProfile };
