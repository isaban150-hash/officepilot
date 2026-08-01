/**
 * REFERENZVERTRAG V1 – SPRINT A
 * „Auftrag annehmen“ → vollständiger Vorgang inkl. CI-Stammdaten, Archiv und DOC-LINK.
 * Reuses existing archive / create / apply / bind helpers — no new engine or Vorgang model.
 */
import { analyzeContractFromInbox } from './contractAnalysisService';
import {
  buildRequiredDocumentsFromContractIntelligence,
  toRequiredDocuments,
} from './contractProofRequirementsFromIntelligence';
import { buildBillingPreparationPatch } from './contractBillingPreparationService';
import {
  deriveContractScope,
  encodeHauptleistungen,
} from './contractScopeDerivationService';
import { confirmProposedDocumentFilingDecision } from './documentFilingDecisionService';
import { getDocumentById, updateDocument } from './documentService';
import {
  getInboxItemById,
  patchInboxItem,
  updateInboxItemRecognizedData,
} from './inboxService';
import { executeArchiveAtom } from './intakeExecutionAtoms';
import {
  createVorgangFromInboxWithContract,
  importSuggestedPositionsToVorgang,
} from './intakeWorkflowService';
import { syncContractProofRequirements } from './officePilotMemoryService';
import { persistAll } from './persistenceService';
import { buildVorgangDraftFromInbox } from './vorgangMatchingService';
import {
  applyContractAcceptFieldsToVorgang,
  getVorgangById,
} from './vorgangService';
import type {
  ContractOrderProposal,
  EnhancedDetectedOrderPosition,
} from '../types/documentIntelligence';
import type {
  ContractExtractedFields,
  InboxItem,
  MaterialStandard,
  Vorgang,
  VorgangDraft,
  WorkflowExecutionFailure,
  WorkflowExecutionStepId,
  WorkflowWarning,
} from '../types/models';

export type AcceptContractOrderResult =
  | {
      success: true;
      vorgang: Vorgang;
      inbox: InboxItem;
      archiveDocumentId?: string;
      positionsAdded: number;
      createdNewVorgang: boolean;
      successSteps: WorkflowExecutionStepId[];
    }
  | { success: false; errorKey: string };

function trimOrUndefined(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function fieldValue(proposal: ContractOrderProposal, key: string): string | undefined {
  const field = proposal.intelligence.contractFields[key];
  return trimOrUndefined(field?.value);
}

/** CI first, inbox fallback — never invent empty placeholders. */
export function buildVorgangDraftFromContractProposal(
  item: InboxItem,
  proposal: ContractOrderProposal,
  materialDefault: MaterialStandard = 'unclear',
): VorgangDraft {
  const inboxDraft = buildVorgangDraftFromInbox(item, materialDefault);
  const project =
    fieldValue(proposal, 'bauvorhaben') ||
    trimOrUndefined(item.recognizedData.Projekt) ||
    trimOrUndefined(item.vorgangTitle);
  const customer =
    trimOrUndefined(proposal.customer) ||
    fieldValue(proposal, 'auftraggeber') ||
    trimOrUndefined(item.recognizedData.Kunde);
  const siteAddress =
    fieldValue(proposal, 'baustelle') ||
    trimOrUndefined(proposal.constructionSite) ||
    trimOrUndefined(item.recognizedData.Baustellenadresse);

  return {
    title: project || inboxDraft.title,
    customer: customer || inboxDraft.customer,
    baustelle: siteAddress || inboxDraft.baustelle,
    materialSource: materialDefault,
  };
}

export function buildContractFieldsFromProposal(
  item: InboxItem,
  proposal: ContractOrderProposal,
): ContractExtractedFields {
  const draft = buildVorgangDraftFromContractProposal(item, proposal);
  return {
    auftraggeber: trimOrUndefined(draft.customer),
    bauvorhaben: trimOrUndefined(draft.title),
    projektname: trimOrUndefined(draft.title),
    baustellenadresse: trimOrUndefined(draft.baustelle),
    vertragsdatum:
      trimOrUndefined(proposal.contractDate) ||
      fieldValue(proposal, 'vertragsdatum') ||
      trimOrUndefined(item.recognizedData.Vertragsdatum),
    ansprechpartner: trimOrUndefined(item.recognizedData.Ansprechpartner),
    telefon: trimOrUndefined(item.recognizedData.Telefon),
    email: trimOrUndefined(item.recognizedData.EMail ?? item.recognizedData['E-Mail']),
  };
}

function resolveObjekt(item: InboxItem, proposal: ContractOrderProposal): string | undefined {
  return (
    fieldValue(proposal, 'vertragsgegenstand') ||
    trimOrUndefined(item.recognizedData.Objekt) ||
    trimOrUndefined(item.recognizedData.Leistung)
  );
}

function enrichInboxFromProposal(
  item: InboxItem,
  proposal: ContractOrderProposal,
): InboxItem {
  const draft = buildVorgangDraftFromContractProposal(item, proposal);
  const objekt = resolveObjekt(item, proposal);
  const vertragsdatum =
    trimOrUndefined(proposal.contractDate) ||
    fieldValue(proposal, 'vertragsdatum') ||
    trimOrUndefined(item.recognizedData.Vertragsdatum);
  const auftragssumme =
    trimOrUndefined(proposal.contractTotalNet) ||
    trimOrUndefined(item.recognizedData.Auftragssumme);
  const classifiedKind = proposal.intelligence.classifiedKind ?? item.classifiedKind;
  const dokumentart =
    classifiedKind === 'subunternehmervertrag' ||
    classifiedKind === 'nachunternehmervertrag' ||
    classifiedKind === 'werkvertrag'
      ? classifiedKind
      : trimOrUndefined(item.recognizedData.Dokumentart);

  const recognizedPatch: Record<string, string> = {};
  const setIf = (key: string, value: string | undefined) => {
    if (value) recognizedPatch[key] = value;
  };

  setIf('Kunde', draft.customer);
  setIf('Baustelle', draft.baustelle);
  setIf('Baustellenadresse', draft.baustelle);
  setIf('Projekt', draft.title);
  setIf('Vorgang', draft.title);
  setIf('Objekt', objekt);
  setIf('Leistung', objekt);
  setIf('Vertragsdatum', vertragsdatum);
  setIf('Auftragssumme', auftragssumme);
  setIf('Dokumentart', dokumentart);

  const scope = deriveContractScope({
    intelligence: proposal.intelligence,
    vertragsgegenstand: objekt,
    positions: proposal.positions,
  });
  setIf('Gewerk', scope.gewerk);
  setIf('Hauptleistungen', encodeHauptleistungen(scope.hauptleistungen));

  const billingPatch = buildBillingPreparationPatch({
    intelligence: proposal.intelligence,
    proposal,
    item,
  });
  for (const [key, value] of Object.entries(billingPatch)) {
    setIf(key, value);
  }

  const patched = updateInboxItemRecognizedData(item.id, {
    recognizedData: recognizedPatch,
    vorgangTitle: draft.title,
    sender: draft.customer || item.sender,
  });

  let current = patched ?? getInboxItemById(item.id) ?? item;

  if (
    classifiedKind &&
    (current.classifiedKind !== classifiedKind || current.documentType !== 'kundenauftrag')
  ) {
    current =
      patchInboxItem(current.id, {
        classifiedKind,
        documentType: 'kundenauftrag',
      }) ?? current;
  }

  return current;
}

function ensureFilingConfirmed(item: InboxItem): InboxItem {
  if (item.filingDecision?.status === 'confirmed') return item;
  return confirmProposedDocumentFilingDecision(item) ?? item;
}

function archiveForAccept(
  item: InboxItem,
  companyName: string,
): { item: InboxItem; archiveDocumentId?: string; ok: boolean; errorKey?: string } {
  const successSteps: WorkflowExecutionStepId[] = [];
  const failedSteps: WorkflowExecutionFailure[] = [];
  const warnings: WorkflowWarning[] = [];
  const outcome = executeArchiveAtom(
    item,
    { companyName, duplicateMode: 'update' },
    successSteps,
    failedSteps,
    warnings,
  );

  const archiveDocumentId =
    outcome.archiveDocumentId ?? outcome.item.archiveDocumentId ?? undefined;

  if (archiveDocumentId && getDocumentById(archiveDocumentId)) {
    return { item: outcome.item, archiveDocumentId, ok: true };
  }

  const message = failedSteps.find((step) => step.step === 'archive_document')?.message;
  return {
    item: outcome.item,
    archiveDocumentId,
    ok: false,
    errorKey: message ?? 'inbox.importToArchive.markFailed',
  };
}

function syncArchiveDocumentMeta(
  archiveDocumentId: string | undefined,
  item: InboxItem,
  fields: ContractExtractedFields,
): void {
  if (!archiveDocumentId) return;
  const doc = getDocumentById(archiveDocumentId);
  if (!doc) return;

  const contractDate = trimOrUndefined(fields.vertragsdatum);
  updateDocument(archiveDocumentId, {
    linkedVorgang: item.vorgangId
      ? {
          vorgangId: item.vorgangId,
          vorgangTitle: item.vorgangTitle ?? doc.linkedVorgang?.vorgangTitle ?? '',
        }
      : doc.linkedVorgang,
    ...(contractDate ? { documentDate: contractDate } : {}),
    ...(item.classifiedKind ? { classifiedKind: item.classifiedKind } : {}),
  });
}

export function acceptContractOrderFromProposal(input: {
  item: InboxItem;
  proposal: ContractOrderProposal;
  selectedPositions: EnhancedDetectedOrderPosition[];
  companyName: string;
  materialStandard?: MaterialStandard;
}): AcceptContractOrderResult {
  const material = input.materialStandard ?? 'unclear';
  // Empty positions allowed for contract accept without LV — still enrich / archive / proofs / billing.

  let item = getInboxItemById(input.item.id) ?? input.item;
  item = enrichInboxFromProposal(item, input.proposal);
  item = ensureFilingConfirmed(item);

  const draft = buildVorgangDraftFromContractProposal(item, input.proposal, material);
  const fields = buildContractFieldsFromProposal(item, input.proposal);
  const objekt = resolveObjekt(item, input.proposal);
  const successSteps: WorkflowExecutionStepId[] = [];

  const archived = archiveForAccept(item, input.companyName);
  if (!archived.ok) {
    return {
      success: false,
      errorKey: archived.errorKey ?? 'inbox.importToArchive.markFailed',
    };
  }
  item = archived.item;
  successSteps.push('archive_document');

  let vorgang: Vorgang;
  let createdNewVorgang = false;
  let positionsAdded = 0;

  if (item.vorgangId) {
    const existing = getVorgangById(item.vorgangId);
    if (!existing) {
      return { success: false, errorKey: 'documentIntelligence.createOrderFailed' };
    }
    if (input.selectedPositions.length > 0) {
      const imported = importSuggestedPositionsToVorgang(item.vorgangId, input.selectedPositions);
      if (imported.errorKey) {
        return { success: false, errorKey: imported.errorKey };
      }
      // 0 neue Positionen ist ok (Idempotenz) — Nachweise können trotzdem aktualisiert werden.
      if (imported.added === 0 && imported.skipped === 0) {
        return { success: false, errorKey: 'documentIntelligence.createOrderFailed' };
      }
      positionsAdded = imported.added;
      if (imported.added > 0) {
        successSteps.push('import_positions');
      }
    }
    vorgang = getVorgangById(item.vorgangId)!;
    item = getInboxItemById(item.id) ?? item;
  } else {
    const created = createVorgangFromInboxWithContract(item, draft, material, {
      confirmedPositions: input.selectedPositions,
    });
    if (!created) {
      return { success: false, errorKey: 'documentIntelligence.createOrderFailed' };
    }
    createdNewVorgang = true;
    vorgang = created.vorgang;
    item = created.inbox;
    positionsAdded = vorgang.orderPositions?.length ?? input.selectedPositions.length;
    successSteps.push('create_vorgang', 'import_positions');
  }

  item = getInboxItemById(item.id) ?? item;
  syncArchiveDocumentMeta(archived.archiveDocumentId, item, fields);

  const applied = applyContractAcceptFieldsToVorgang(vorgang.id, fields, {
    contractDate: fields.vertragsdatum,
    objekt,
  });
  if (!applied.success) {
    return { success: false, errorKey: applied.errorKey };
  }
  successSteps.push('apply_contract_fields');

  // Sprint B: Nachweise aus CI (führend) + Analyse-Fallback, idempotent upsert.
  const fallbackAnalysis = analyzeContractFromInbox(item);
  const requiredProofs = toRequiredDocuments(
    buildRequiredDocumentsFromContractIntelligence(
      input.proposal.intelligence,
      fallbackAnalysis.isContract ? fallbackAnalysis.requiredDocuments : [],
    ),
  );
  if (requiredProofs.length > 0) {
    syncContractProofRequirements(vorgang.id, item.id, requiredProofs);
    persistAll();
  }

  const freshVorgang = getVorgangById(vorgang.id)!;
  const freshInbox = getInboxItemById(item.id) ?? item;

  return {
    success: true,
    vorgang: freshVorgang,
    inbox: freshInbox,
    archiveDocumentId: archived.archiveDocumentId ?? freshInbox.archiveDocumentId,
    positionsAdded,
    createdNewVorgang,
    successSteps,
  };
}
