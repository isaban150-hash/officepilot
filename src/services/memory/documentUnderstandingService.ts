import type { ClassifiedDocumentKind, CompanyDocument, InboxItem } from '../../types/models';
import type {
  DocumentMemory,
  DocumentSummary,
  MemoryRiskLevel,
  PremiumLetterExplanation,
} from '../../types/memory';
import { OFFICEPILOT_LEGAL_DISCLAIMER } from '../../config/legalDisclaimer';
import { buildExplanation } from '../documentClassificationCatalog';
import { getTodayIso } from '../taskNormalize';
import {
  enrichDocumentMemory,
  getDocumentMemoryByDocumentId,
  getProofMemories,
} from '../officePilotMemoryService';
import { detectAuthoritiesFromDocument, getAuthorityLabel } from './memoryAuthorityMapping';
import {
  buildDocumentSummary,
  formatDigitalLocation,
  formatPaperLocation,
  mergeRulesIntoMemorySummary,
} from './documentSummaryService';

const DISCLAIMER = OFFICEPILOT_LEGAL_DISCLAIMER;

export interface UnderstandDocumentOptions {
  inboxItem?: InboxItem;
  documentMemory?: DocumentMemory;
  todayIso?: string;
}

function mergeSummary(existing: DocumentSummary | undefined, incoming: DocumentSummary): DocumentSummary {
  return mergeRulesIntoMemorySummary(existing, incoming);
}

function deriveMemoryStatus(summary: DocumentSummary): DocumentMemory['memoryStatus'] {
  if (summary.sourceConfidence === 'high') return 'understood';
  if (summary.sourceConfidence === 'medium') return 'partial';
  return 'pending';
}

function formatRiskText(riskLevel: MemoryRiskLevel): string {
  switch (riskLevel) {
    case 'high':
      return 'Erhöhtes Risiko – zeitnah prüfen.';
    case 'medium':
      return 'Mittleres Risiko – Frist und Nachweise beachten.';
    case 'low':
      return 'Geringes Risiko – routinemäßig ablegen und im Blick behalten.';
    default:
      return 'Risiko unklar – Inhalt manuell prüfen.';
  }
}

function buildWhyReceived(
  document: CompanyDocument,
  classifiedKind?: ClassifiedDocumentKind,
  recognizedData?: Record<string, string>,
): string {
  const authorities = detectAuthoritiesFromDocument(
    [
      document.title,
      document.issuer,
      document.recognizedText,
      ...(recognizedData ? Object.values(recognizedData) : []),
    ].join(' '),
    classifiedKind,
  );

  if (authorities.length > 0) {
    return `Das Schreiben stammt von ${getAuthorityLabel(authorities[0]!)} und betrifft Ihre betrieblichen Pflichten oder Nachweise.`;
  }

  if (document.linkedCompany) {
    return `Das Dokument hängt mit ${document.linkedCompany} zusammen und wurde für Ihre Ablage archiviert.`;
  }

  if (document.issuer.trim()) {
    return `${document.issuer.trim()} hat Ihnen dieses Schreiben zugesandt.`;
  }

  return 'Der Absender ist nicht eindeutig erkennbar – bitte kurz prüfen.';
}

function buildActionRequired(summary: DocumentSummary, classifiedKind?: ClassifiedDocumentKind): string {
  if (classifiedKind === 'mahnung' || classifiedKind === 'zahlungserinnerung') {
    return 'Ja – Zahlung oder Klärung zeitnah prüfen.';
  }
  if (summary.deadline) {
    return 'Ja – Frist oder Gültigkeit beachten und ggf. reagieren.';
  }
  if (summary.requiredDocuments.length > 0) {
    return 'Ja – benötigte Nachweise bereithalten oder vervollständigen.';
  }
  return 'Nein – vorerst nur ablegen und bei Bedarf nachlesen.';
}

export function buildPremiumLetterExplanation(
  document: CompanyDocument,
  summary: DocumentSummary,
  classifiedKind?: ClassifiedDocumentKind,
  recognizedData?: Record<string, string>,
): PremiumLetterExplanation {
  const about =
    classifiedKind != null
      ? buildExplanation(classifiedKind, document.issuer || 'Absender unbekannt')
      : summary.topic;

  return {
    shortExplanation: summary.shortSummary,
    whatIsItAbout: about,
    whyReceived: buildWhyReceived(document, classifiedKind, recognizedData),
    actionRequired: buildActionRequired(summary, classifiedKind),
    deadline: summary.deadline ?? 'Keine Frist erkannt.',
    requiredDocuments:
      summary.requiredDocuments.length > 0
        ? summary.requiredDocuments
        : ['Keine zusätzlichen Unterlagen erkannt.'],
    risks: formatRiskText(summary.riskLevel),
    recommendation: summary.nextAction,
    digitalStorage: formatDigitalLocation(document),
    paperStorage: formatPaperLocation(document),
    disclaimer: DISCLAIMER,
  };
}

export function understandArchivedDocument(
  document: CompanyDocument,
  options?: UnderstandDocumentOptions,
): DocumentMemory | null {
  const classifiedKind = options?.inboxItem?.classifiedKind ?? options?.documentMemory?.classifiedKind;
  const recognizedData = options?.inboxItem?.recognizedData;
  const todayIso = options?.todayIso ?? getTodayIso();
  const proofMemory = getProofMemories().find(
    (item) => item.documentId === document.id && item.status !== 'missing',
  );

  const summary = buildDocumentSummary({
    document,
    classifiedKind,
    recognizedData,
    proofMemory,
    todayIso,
  });

  const letterExplanation = buildPremiumLetterExplanation(
    document,
    summary,
    classifiedKind,
    recognizedData,
  );

  const authorities = detectAuthoritiesFromDocument(
    [document.title, document.issuer, document.recognizedText].join(' '),
    classifiedKind,
  );

  const relatedCustomers = document.linkedCompany ? [document.linkedCompany] : [];
  const relatedProofs = proofMemory?.proofType ? [proofMemory.proofType] : [];

  const existing = getDocumentMemoryByDocumentId(document.id);
  const mergedSummary = mergeSummary(existing?.summary, summary);

  return enrichDocumentMemory(document.id, {
    summary: mergedSummary,
    topic: mergedSummary.topic,
    nextAction: mergedSummary.nextAction,
    riskLevel: mergedSummary.riskLevel,
    requiredDocuments: mergedSummary.requiredDocuments,
    relatedAuthorities: authorities,
    relatedCustomers,
    relatedProofs,
    letterExplanation,
    memoryStatus: deriveMemoryStatus(mergedSummary),
  });
}

export function getDocumentUnderstanding(documentId: string): DocumentMemory | undefined {
  return getDocumentMemoryByDocumentId(documentId);
}
