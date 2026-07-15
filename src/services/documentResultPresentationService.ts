import type { TranslationKey } from '../i18n';
import { isDatevRelevantKind } from './brain/financeIntelligenceService';
import type {
  ClassifiedDocumentKind,
  DocumentType,
  DocumentUnderstandingSummary,
  InboxItem,
} from '../types/models';

export type SteuerberaterRelevanceStatus = 'mark' | 'not_relevant' | 'check';

export type RecognitionStatus = 'confident' | 'assign_customer' | 'review';

export interface DocumentQuestionSuggestion {
  id: string;
  labelKey: TranslationKey;
}

export interface PresentationCheck {
  id: string;
  labelKey: TranslationKey;
}

export interface PresentationContext {
  kind: ClassifiedDocumentKind;
  documentType?: DocumentType;
  customer?: string | null;
  site?: string | null;
}

const CUSTOMER_ASSIGNMENT_KINDS = new Set<ClassifiedDocumentKind>(['auftrag', 'angebot', 'werkvertrag']);

const SITE_CHECK_KINDS = new Set<ClassifiedDocumentKind>([
  'werkvertrag',
  'auftrag',
  'lieferschein',
  'abnahmeprotokoll',
]);

const PAYMENT_KINDS = new Set<ClassifiedDocumentKind>([
  'mahnung',
  'zahlungserinnerung',
  'eingangsrechnung',
  'rechnung',
]);

const UNKNOWN_VALUES = /^(unbekannt|unknown|—|-)$/i;

export function isUnknownPresentationValue(value?: string | null): boolean {
  if (!value?.trim()) return true;
  return UNKNOWN_VALUES.test(value.trim());
}

export function requiresCustomerAssignment(kind: ClassifiedDocumentKind): boolean {
  return CUSTOMER_ASSIGNMENT_KINDS.has(kind);
}

export function resolvePresentationCustomer(
  summary?: DocumentUnderstandingSummary | null,
  recognizedData?: Record<string, string | undefined>,
): string | undefined {
  const customer = summary?.customer ?? recognizedData?.Kunde;
  return isUnknownPresentationValue(customer) ? undefined : customer?.trim();
}

export function isCustomerAssignmentMissing(context: PresentationContext): boolean {
  if (!requiresCustomerAssignment(context.kind) && context.documentType !== 'kundenauftrag') {
    return false;
  }
  if (!requiresCustomerAssignment(context.kind) && context.documentType === 'kundenauftrag') {
    return isUnknownPresentationValue(context.customer);
  }
  return isUnknownPresentationValue(context.customer);
}

const ORDER_QUESTIONS: DocumentQuestionSuggestion[] = [
  { id: 'orderWhat', labelKey: 'docAssistant.question.orderWhat' },
  { id: 'orderSite', labelKey: 'docAssistant.question.orderSite' },
  { id: 'orderDeadline', labelKey: 'docAssistant.question.orderDeadline' },
  { id: 'orderConfirm', labelKey: 'docAssistant.question.orderConfirm' },
  { id: 'orderNextSteps', labelKey: 'docAssistant.question.orderNextSteps' },
];

const DEFAULT_QUESTIONS: DocumentQuestionSuggestion[] = [
  { id: 'pay', labelKey: 'docAssistant.question.pay' },
  { id: 'why', labelKey: 'docAssistant.question.why' },
  { id: 'deadline', labelKey: 'docAssistant.question.deadline' },
  { id: 'ignore', labelKey: 'docAssistant.question.ignore' },
  { id: 'tax', labelKey: 'docAssistant.question.tax' },
  { id: 'file', labelKey: 'docAssistant.question.file' },
  { id: 'dispose', labelKey: 'docAssistant.question.dispose' },
];

const DEFAULT_WITHOUT_PAY = DEFAULT_QUESTIONS.filter((entry) => entry.id !== 'pay');

export function getDocumentQuestionSuggestions(kind: ClassifiedDocumentKind): DocumentQuestionSuggestion[] {
  if (kind === 'auftrag') {
    return [...ORDER_QUESTIONS, ...DEFAULT_WITHOUT_PAY];
  }
  if (PAYMENT_KINDS.has(kind)) {
    return DEFAULT_QUESTIONS;
  }
  return DEFAULT_WITHOUT_PAY;
}

export function getBriefLineKeyForKind(kind: ClassifiedDocumentKind): TranslationKey | undefined {
  if (kind === 'auftrag') return 'docAssistant.brief.auftragDocument';
  if (kind === 'werkvertrag') return 'docAssistant.brief.werkvertragDocument';
  if (kind === 'angebot') return 'docAssistant.brief.angebotDocument';
  return undefined;
}

export function resolveSteuerberaterPresentation(
  kind: ClassifiedDocumentKind,
): { status: SteuerberaterRelevanceStatus; reasonKey: TranslationKey } {
  if (
    isDatevRelevantKind(kind) ||
    kind === 'freistellungsbescheinigung' ||
    kind === 'lohnabrechnung' ||
    kind === 'lohnunterlagen' ||
    kind === 'kontoauszug' ||
    kind === 'steuerbescheid' ||
    kind === 'umsatzsteuerbescheid'
  ) {
    return {
      status: 'mark',
      reasonKey: 'docAssistant.steuerberater.markReason',
    };
  }
  if (
    kind === 'aok' ||
    kind === 'barmer' ||
    kind === 'tk' ||
    kind === 'dak' ||
    kind === 'ikk' ||
    kind === 'krankenkasse' ||
    kind === 'knappschaft' ||
    kind === 'pflegekasse'
  ) {
    return {
      status: 'check',
      reasonKey: 'docAssistant.steuerberater.checkReason',
    };
  }
  if (kind === 'werkvertrag' || kind === 'lieferschein') {
    return {
      status: 'check',
      reasonKey: 'docAssistant.steuerberater.checkReason',
    };
  }
  return {
    status: 'not_relevant',
    reasonKey: 'docAssistant.steuerberater.notReason',
  };
}

export function buildPresentationContext(
  item: InboxItem,
  summary?: DocumentUnderstandingSummary | null,
  kind?: ClassifiedDocumentKind,
): PresentationContext {
  const resolvedKind = (kind ?? item.classifiedKind ?? summary?.documentType ?? 'sonstiges') as ClassifiedDocumentKind;
  return {
    kind: resolvedKind,
    documentType: item.documentType,
    customer: summary?.customer ?? item.recognizedData.Kunde,
    site: summary?.constructionSite ?? item.recognizedData.Baustelle ?? item.vorgangTitle,
  };
}

export function buildPresentationChecks(context: PresentationContext): PresentationCheck[] {
  const checks: PresentationCheck[] = [];

  if (isCustomerAssignmentMissing(context)) {
    checks.push({ id: 'customer', labelKey: 'reviewWorkflow.check.selectCustomer' });
  }

  if (isUnknownPresentationValue(context.site) && SITE_CHECK_KINDS.has(context.kind)) {
    checks.push({ id: 'site', labelKey: 'reviewWorkflow.check.confirmSite' });
  }

  return checks;
}

export function resolveRecognitionStatus(
  context: PresentationContext,
  uncertainFieldCount: number,
): RecognitionStatus {
  if (isCustomerAssignmentMissing(context)) {
    return 'assign_customer';
  }
  if (uncertainFieldCount > 0) {
    return 'review';
  }
  return 'confident';
}

export function recognitionStatusKey(status: RecognitionStatus): TranslationKey {
  if (status === 'assign_customer') return 'docAssistant.trust.assignCustomer';
  if (status === 'review') return 'docAssistant.trust.review';
  return 'docAssistant.trust.confident';
}
