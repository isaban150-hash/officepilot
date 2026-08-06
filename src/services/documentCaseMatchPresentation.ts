/**
 * VORGANG-INTELLIGENCE — map DocumentCaseMatch into DocumentSummary presentation.
 */
import type { TranslationKey } from '../i18n';
import type { DocumentCaseMatch, DocumentCaseMatchReasonId } from '../types/documentCaseMatch';
import type {
  DocumentSummary,
  DocumentSummaryActionRef,
} from '../types/documentSummary';
import type { InboxItem } from '../types/models';
import { buildDocumentCaseMatch } from './documentCaseMatchService';
import { getVorgangById } from './vorgangService';

const REASON_LABEL_KEYS: Record<DocumentCaseMatchReasonId, TranslationKey> = {
  same_customer: 'vorgangIntelligence.reason.sameCustomer',
  same_site: 'vorgangIntelligence.reason.sameSite',
  same_project: 'vorgangIntelligence.reason.sameProject',
  same_contract_number: 'vorgangIntelligence.reason.sameContractNumber',
  same_invoice_number: 'vorgangIntelligence.reason.sameInvoiceNumber',
  same_supplier: 'vorgangIntelligence.reason.sameSupplier',
  same_subject: 'vorgangIntelligence.reason.sameSubject',
  same_reference: 'vorgangIntelligence.reason.sameReference',
  known_link: 'vorgangIntelligence.reason.knownLink',
};

export function resolveDocumentCaseMatchReasonLabel(
  reason: DocumentCaseMatchReasonId,
  translate: (key: TranslationKey) => string,
): string {
  return translate(REASON_LABEL_KEYS[reason]);
}

export function primaryActionForCaseMatch(match: DocumentCaseMatch): DocumentSummaryActionRef {
  switch (match.matchStatus) {
    case 'exact':
      return {
        id: 'open_vorgang',
        labelKey: 'documentExperience.action.openCase',
        enabled: true,
      };
    case 'likely':
      return {
        id: 'link_vorgang',
        labelKey: 'vorgangIntelligence.action.assign',
        enabled: true,
      };
    case 'multiple':
      return {
        id: 'select_vorgang',
        labelKey: 'vorgangIntelligence.action.select',
        enabled: true,
      };
    case 'none':
    default:
      return {
        id: 'create_vorgang',
        labelKey: 'vorgangIntelligence.action.create',
        enabled: true,
      };
  }
}

/**
 * Attach case match + (optionally) override primary CTA.
 * Never overrides Accept (contract order) — business path stays unchanged.
 */
export function attachDocumentCaseMatch(
  summary: DocumentSummary,
  item: InboxItem,
  options?: { preservePrimary?: boolean },
): DocumentSummary {
  const caseMatch = buildDocumentCaseMatch(item);
  const shouldBackfillSite = summary.family === 'invoice_in' || summary.family === 'delivery';
  const hasSiteFact = summary.facts.some((fact) => fact.id === 'site' && fact.value.trim());
  const caseIdForSite =
    caseMatch.matchStatus === 'exact' && caseMatch.matchedCaseId ? caseMatch.matchedCaseId : null;
  const siteFromCase = caseIdForSite ? getVorgangById(caseIdForSite)?.baustelle?.trim() : '';
  const preservePrimary =
    options?.preservePrimary === true || summary.primaryAction.id === 'accept_contract_order';

  const enrichedFacts =
    shouldBackfillSite && !hasSiteFact && siteFromCase
      ? [
          ...summary.facts,
          {
            id: 'site',
            labelKey: 'documentExperience.fact.site' as TranslationKey,
            value: siteFromCase,
          },
        ]
      : summary.facts;

  return {
    ...summary,
    facts: enrichedFacts,
    caseMatch,
    primaryAction: preservePrimary
      ? summary.primaryAction
      : primaryActionForCaseMatch(caseMatch),
  };
}
