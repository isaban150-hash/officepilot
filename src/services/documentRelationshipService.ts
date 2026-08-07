import type { InboxItem, WorkflowResult, Vorgang } from '../types/models';
import { getVorgangById } from './vorgangService';

export type DocumentRelationType =
  | 'reminder_invoice'
  | 'contract_amendment'
  | 'amendment_contract'
  | 'contract_abschlag'
  | 'contract_schluss';

export type DocumentRelationCertainty = 'confirmed' | 'probable';

export interface DocumentRelationship {
  relationType: DocumentRelationType;
  relatedDocumentId?: string;
  relatedDocumentTitle: string;
  certainty: DocumentRelationCertainty;
  evidence: string;
  source: 'vorgang' | 'vorgangRef' | 'businessInterpretation' | 'documentUnderstanding';
}

export interface DocumentRelationshipInput {
  item: InboxItem;
  workflow?: WorkflowResult | null;
  truthBusinessInterpretation?: WorkflowResult['businessInterpretation'] | null;
}

function pickFirstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function resolveKnownVorgang(
  input: DocumentRelationshipInput,
): { vorgang: Vorgang | null; certainty: DocumentRelationCertainty } {
  const bi = input.truthBusinessInterpretation ?? input.workflow?.businessInterpretation ?? null;
  const ref = bi?.vorgangRef;
  if (ref?.status === 'linked' && ref.linkedVorgangId) {
    return {
      vorgang: getVorgangById(ref.linkedVorgangId) ?? null,
      certainty: 'confirmed',
    };
  }
  if (ref?.status === 'suggested' && ref.suggested?.vorgangId) {
    return {
      vorgang: getVorgangById(ref.suggested.vorgangId) ?? null,
      certainty: 'probable',
    };
  }
  if (input.item.vorgangId) {
    return {
      vorgang: getVorgangById(input.item.vorgangId) ?? null,
      certainty: 'confirmed',
    };
  }
  return { vorgang: null, certainty: 'probable' };
}

function resolveInvoiceNumber(input: DocumentRelationshipInput): string | undefined {
  return pickFirstNonEmpty(
    input.workflow?.documentUnderstanding?.invoiceNumber,
    input.item.recognizedData.Rechnungsnummer,
    input.item.recognizedData.Belegnummer,
  );
}

function isReminderLike(input: DocumentRelationshipInput): boolean {
  const kind = input.workflow?.classifiedKind ?? input.item.classifiedKind;
  return kind === 'mahnung' || kind === 'zahlungserinnerung';
}

function isContractLike(input: DocumentRelationshipInput): boolean {
  const kind = input.workflow?.classifiedKind ?? input.item.classifiedKind;
  return kind === 'werkvertrag' || kind === 'subunternehmervertrag' || kind === 'nachunternehmervertrag';
}

function isAmendmentLike(input: DocumentRelationshipInput): boolean {
  const kind = input.workflow?.classifiedKind ?? input.item.classifiedKind;
  return kind === 'nachtrag';
}

function resolveContractFamilyLabel(input: DocumentRelationshipInput): string | undefined {
  const family = input.truthBusinessInterpretation?.contractFamily ?? input.workflow?.businessInterpretation?.contractFamily;
  if (!family) return undefined;
  switch (family) {
    case 'werkvertrag':
      return 'Werkvertrag';
    case 'subunternehmervertrag':
      return 'Subunternehmervertrag';
    case 'wartungsvertrag':
      return 'Wartungsvertrag';
    case 'mietvertrag':
      return 'Mietvertrag';
    default:
      return undefined;
  }
}

export function buildDocumentRelationships(input: DocumentRelationshipInput): DocumentRelationship[] {
  const relationships: DocumentRelationship[] = [];
  const { vorgang, certainty } = resolveKnownVorgang(input);
  if (!vorgang) return relationships;

  if (isReminderLike(input)) {
    const invoiceNumber = resolveInvoiceNumber(input);
    if (invoiceNumber) {
      const invoice = vorgang.invoices.find((entry) => entry.number.trim() === invoiceNumber);
      if (invoice) {
        relationships.push({
          relationType: 'reminder_invoice',
          relatedDocumentId: invoice.id,
          relatedDocumentTitle: invoice.number,
          certainty,
          evidence: invoice.number,
          source: 'vorgang',
        });
      }
    }
  }

  if (isContractLike(input)) {
    const confirmedAmendment = vorgang.confirmedOrderAmendments?.[0];
    const draftAmendment = vorgang.orderAmendments?.[0];
    const amendment = confirmedAmendment ?? draftAmendment;
    if (amendment?.title?.trim()) {
      relationships.push({
        relationType: 'contract_amendment',
        relatedDocumentId: 'cloudId' in amendment ? amendment.cloudId : amendment.id,
        relatedDocumentTitle: amendment.title.trim(),
        certainty: confirmedAmendment ? 'confirmed' : certainty,
        evidence: amendment.title.trim(),
        source: 'vorgang',
      });
    }

    const abschlag = vorgang.invoices.find((invoice) => invoice.type === 'abschlag');
    if (abschlag) {
      relationships.push({
        relationType: 'contract_abschlag',
        relatedDocumentId: abschlag.id,
        relatedDocumentTitle: abschlag.number,
        certainty: 'confirmed',
        evidence: abschlag.number,
        source: 'vorgang',
      });
    }

    const schluss = vorgang.invoices.find((invoice) => invoice.type === 'schluss');
    if (schluss) {
      relationships.push({
        relationType: 'contract_schluss',
        relatedDocumentId: schluss.id,
        relatedDocumentTitle: schluss.number,
        certainty: 'confirmed',
        evidence: schluss.number,
        source: 'vorgang',
      });
    }
  }

  if (isAmendmentLike(input)) {
    const contractFamilyLabel = resolveContractFamilyLabel(input);
    if (contractFamilyLabel) {
      relationships.push({
        relationType: 'amendment_contract',
        relatedDocumentId: vorgang.id,
        relatedDocumentTitle: contractFamilyLabel,
        certainty,
        evidence: contractFamilyLabel,
        source: 'businessInterpretation',
      });
    }
  }

  return relationships;
}

export function buildDocumentRelationshipNarrative(
  relation: DocumentRelationship | undefined,
): string | undefined {
  if (!relation) return undefined;

  switch (relation.relationType) {
    case 'reminder_invoice':
      return relation.certainty === 'confirmed'
        ? `Diese Mahnung bezieht sich auf die Rechnung ${relation.relatedDocumentTitle}.`
        : `Diese Mahnung könnte sich auf die Rechnung ${relation.relatedDocumentTitle} beziehen.`;
    case 'contract_amendment':
      return relation.certainty === 'confirmed'
        ? `Zu diesem Werkvertrag liegt bereits der Nachtrag „${relation.relatedDocumentTitle}“ vor.`
        : `Zu diesem Werkvertrag liegt wahrscheinlich der Nachtrag „${relation.relatedDocumentTitle}“ vor.`;
    case 'amendment_contract':
      return relation.certainty === 'confirmed'
        ? `Dieser Nachtrag bezieht sich auf den bestehenden ${relation.relatedDocumentTitle}.`
        : `Dieser Nachtrag bezieht sich wahrscheinlich auf den bestehenden ${relation.relatedDocumentTitle}.`;
    case 'contract_abschlag':
      return `Zu diesem Vertrag existiert bereits die Abschlagsrechnung ${relation.relatedDocumentTitle}.`;
    case 'contract_schluss':
      return `Zu diesem Vertrag existiert bereits die Schlussrechnung ${relation.relatedDocumentTitle}.`;
    default:
      return undefined;
  }
}
