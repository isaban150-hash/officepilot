/**
 * DOCUMENT-SUMMARY-ROLL-OUT — shared presentation helpers.
 * Compact UIs must not project RD/Understanding/Letter themselves.
 */
import { t, type TranslationKey } from '../i18n';
import type { DocumentSummary } from '../types/documentSummary';
import type { BusinessInterpretationResult } from '../types/businessInterpretation';
import type {
  AppLanguage,
  CompanyDocument,
  DocumentType,
  InboxItem,
} from '../types/models';
import { getCachedSetup } from './persistenceService';
import {
  buildDocumentSummary,
  buildInboxDocumentSummary,
  resolveDocumentSummaryAlertLabel,
  resolveDocumentSummaryFactLabel,
} from './documentSummary';
import { getLetterExplanation } from './letterExplanationService';
import { getInboxItemById } from './inboxService';

export type DocumentSummaryCompactView = {
  title: string;
  headline: string;
  subtitle: string;
  facts: Array<{ id: string; label: string; value: string }>;
  alerts: Array<{ id: string; label: string }>;
  factsLine: string;
  alertsLine: string;
  primaryActionLabel: string;
  secondaryActionLabels: string[];
  summary: DocumentSummary;
};

function resolveLang(language?: AppLanguage): AppLanguage {
  return language ?? getCachedSetup()?.language ?? 'de';
}

export function createPresentationTranslate(
  language?: AppLanguage,
): (key: TranslationKey) => string {
  const lang = resolveLang(language);
  return (key) => t(key, lang);
}

/** Map archive category → coarse DocumentType for label fallback only. */
function categoryToDocumentType(category: CompanyDocument['category']): DocumentType {
  switch (category) {
    case 'ausgangsrechnung':
      return 'ausgangsrechnung';
    case 'vertrag':
      return 'kundenauftrag';
    case 'behoerde':
    case 'steuer':
      return 'behoerde';
    default:
      return 'sonstiges';
  }
}

/**
 * Project a CompanyDocument into an InboxItem-shaped carrier for DocumentSummary.
 * Uses only existing archive fields — no OCR/CI.
 */
export function companyDocumentToInboxCarrier(doc: CompanyDocument): InboxItem {
  const linked = doc.sourceInboxItemId ? getInboxItemById(doc.sourceInboxItemId) : null;
  if (linked) return linked;

  return {
    id: doc.id,
    title: doc.title,
    documentType: categoryToDocumentType(doc.category),
    sender: doc.issuer?.trim() || '',
    priority: 'mittel',
    deadline: doc.validUntil,
    recommendedAction: 'klaeren',
    digitalFolder: doc.digitalFolder,
    paperFiling: doc.paperFolder,
    status: 'geprueft',
    receivedAt: doc.createdAt,
    recognizedData: {
      Absender: doc.issuer ?? '',
      Lieferant: doc.issuer ?? '',
      Datum: doc.documentDate ?? doc.issueDate ?? '',
      Betreff: doc.title,
      Projekt: doc.linkedVorgang?.vorgangTitle ?? '',
      Vorgang: doc.linkedVorgang?.vorgangTitle ?? '',
    },
    officePilotSuggestion: '',
    nextTaskLabel: '',
    securityHint: '',
    classifiedKind: doc.classifiedKind,
    vorgangId: doc.linkedVorgang?.vorgangId,
    vorgangTitle: doc.linkedVorgang?.vorgangTitle,
  };
}

export function buildSummaryForInboxItem(
  item: InboxItem,
  options?: {
    language?: AppLanguage;
    translate?: (key: TranslationKey) => string;
    /**
     * DASHBOARD-CONTRACT-CARD-FIELD-MAPPING-01B1 — already stored analysis and a
     * confirmed customer link. Resolved by the calling component; this service
     * reads no store and starts no analysis.
     */
    displayBusinessInterpretation?: BusinessInterpretationResult | null;
    confirmedCustomerName?: string | null;
  },
): DocumentSummary {
  const translate = options?.translate ?? createPresentationTranslate(options?.language);
  const language = resolveLang(options?.language);
  const letter = getLetterExplanation(item, language);
  return buildInboxDocumentSummary(item, {
    translate,
    letter,
    language,
    displayBusinessInterpretation: options?.displayBusinessInterpretation ?? null,
    confirmedCustomerName: options?.confirmedCustomerName ?? null,
  });
}

export function buildSummaryForCompanyDocument(
  doc: CompanyDocument,
  options?: { language?: AppLanguage; translate?: (key: TranslationKey) => string },
): DocumentSummary {
  return buildSummaryForInboxItem(companyDocumentToInboxCarrier(doc), options);
}

export function toDocumentSummaryCompactView(
  summary: DocumentSummary,
  translate: (key: TranslationKey) => string,
): DocumentSummaryCompactView {
  const facts = summary.facts.slice(0, 6).map((f) => ({
    id: f.id,
    label: resolveDocumentSummaryFactLabel(f, translate),
    value: f.value,
  }));
  const alerts = summary.alerts.slice(0, 3).map((a) => ({
    id: a.id,
    label: resolveDocumentSummaryAlertLabel(a, translate),
  }));
  const title = translate(summary.documentTypeLabelKey);
  const subtitle = facts
    .slice(0, 2)
    .map((f) => f.value)
    .filter(Boolean)
    .join(' · ');
  return {
    title,
    headline: summary.headline || title,
    subtitle,
    facts,
    alerts,
    factsLine: facts.map((f) => `${f.label}: ${f.value}`).join(' · '),
    alertsLine: alerts.map((a) => a.label).join(' · '),
    primaryActionLabel: translate(summary.primaryAction.labelKey),
    secondaryActionLabels: summary.secondaryActions.map((a) => translate(a.labelKey)),
    summary,
  };
}

/** Search / assistant / notification display fields from DocumentSummary only. */
export function presentDocumentSummaryForSnippet(
  summary: DocumentSummary,
  translate: (key: TranslationKey) => string,
): { title: string; subtitle: string; snippet: string; actionLabel: string } {
  const view = toDocumentSummaryCompactView(summary, translate);
  const snippetParts = [
    view.factsLine,
    view.alertsLine,
  ].filter(Boolean);
  return {
    title: view.title,
    subtitle: view.subtitle || view.facts[0]?.value || '',
    snippet: snippetParts.join(' — ') || view.headline,
    actionLabel: view.primaryActionLabel,
  };
}

/**
 * Detail-path summary (optional workflow) for review hero fallbacks.
 */
export function buildDetailDocumentSummary(
  item: InboxItem,
  workflow: Parameters<typeof buildDocumentSummary>[1],
  options: {
    translate: (key: TranslationKey) => string;
    language?: AppLanguage;
  },
): DocumentSummary {
  const letter = getLetterExplanation(item, resolveLang(options.language));
  return buildDocumentSummary(item, workflow, {
    translate: options.translate,
    letter,
  });
}
