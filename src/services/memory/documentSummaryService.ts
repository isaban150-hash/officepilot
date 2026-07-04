import type { ClassifiedDocumentKind, CompanyDocument, InboxItem } from '../../types/models';
import type {
  DocumentSummary,
  DocumentSummaryOrigin,
  MemoryRiskLevel,
  MemorySourceConfidence,
  ProofMemory,
  ProofType,
} from '../../types/memory';
import { PROOF_EXPIRY_WARNING_DAYS } from '../../types/memory';
import { analyzeContract, analyzeContractFromInbox } from '../contractAnalysisService';
import { buildExplanation } from '../documentClassificationCatalog';
import { formatPaperFilingInstruction } from '../paperFolderService';
import { detectAuthoritiesFromDocument, getAuthorityLabel } from './memoryAuthorityMapping';

function daysUntil(isoDate: string, todayIso: string): number {
  const today = new Date(`${todayIso.slice(0, 10)}T12:00:00`);
  const target = new Date(`${isoDate.slice(0, 10)}T12:00:00`);
  return Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
}

function proofStatusFromValidUntil(
  validUntil: string | null | undefined,
  todayIso?: string,
): 'valid' | 'expiring' | 'expired' | 'unknown' {
  if (!validUntil || !todayIso) return 'unknown';
  const days = daysUntil(validUntil, todayIso);
  if (days < 0) return 'expired';
  if (days <= PROOF_EXPIRY_WARNING_DAYS) return 'expiring';
  return 'valid';
}

const KIND_LABELS: Partial<Record<ClassifiedDocumentKind, string>> = {
  freistellungsbescheinigung: 'Freistellungsbescheinigung §48b',
  unbedenklichkeitsbescheinigung: 'Unbedenklichkeitsbescheinigung',
  bg_bau: 'BG BAU Schreiben',
  berufsgenossenschaft: 'Berufsgenossenschaft',
  soka_bau: 'SOKA-BAU Schreiben',
  finanzamt: 'Finanzamt-Schreiben',
  steuerbescheid: 'Steuerbescheid',
  umsatzsteuerbescheid: 'Umsatzsteuerbescheid',
  werkvertrag: 'Werkvertrag',
  subunternehmervertrag: 'Subunternehmervertrag',
  mahnung: 'Mahnung',
  zahlungserinnerung: 'Zahlungserinnerung',
  aok: 'AOK Schreiben',
  barmer: 'Barmer Schreiben',
  tk: 'TK Schreiben',
  ikk: 'IKK Schreiben',
  betriebshaftpflicht: 'Betriebshaftpflicht',
  versicherung: 'Versicherungsschreiben',
  versicherungsbescheid: 'Versicherungsbescheid',
  abnahmeprotokoll: 'Abnahmeprotokoll',
  kontoauszug: 'Kontoauszug',
};

const PROOF_TYPE_LABELS: Record<ProofType, string> = {
  freistellungsbescheinigung: 'Freistellungsbescheinigung §48b',
  bg_bau: 'BG BAU Unbedenklichkeitsbescheinigung',
  soka_bau: 'SOKA-BAU',
  betriebshaftpflicht: 'Betriebshaftpflicht',
};

const AMOUNT_PATTERN =
  /(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})\s*(?:€|eur|euro)?/gi;

export interface DocumentSummaryInput {
  document: CompanyDocument;
  classifiedKind?: ClassifiedDocumentKind;
  recognizedData?: Record<string, string>;
  proofMemory?: ProofMemory;
  todayIso?: string;
}

function formatKindLabel(kind?: ClassifiedDocumentKind, fallbackTitle?: string): string {
  if (kind && KIND_LABELS[kind]) return KIND_LABELS[kind]!;
  if (kind) {
    return kind
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
  return fallbackTitle?.trim() || 'Dokument';
}

function buildHaystack(
  document: CompanyDocument,
  recognizedData?: Record<string, string>,
): string {
  return [
    document.title,
    document.issuer,
    document.recognizedText,
    document.linkedCompany,
    document.tags.join(' '),
    ...(recognizedData ? Object.values(recognizedData) : []),
  ]
    .filter(Boolean)
    .join(' ');
}

function extractAmounts(haystack: string, recognizedData?: Record<string, string>): string[] {
  const amounts = new Set<string>();
  const betrag = recognizedData?.Betrag ?? recognizedData?.betrag ?? recognizedData?.Amount;
  if (betrag?.trim()) amounts.add(betrag.trim());

  for (const match of haystack.matchAll(AMOUNT_PATTERN)) {
    const value = match[1]?.trim();
    if (value) amounts.add(`${value} €`);
  }

  return [...amounts].slice(0, 5);
}

function extractDeadline(
  document: CompanyDocument,
  recognizedData?: Record<string, string>,
): string | null {
  const fromData =
    recognizedData?.Frist ??
    recognizedData?.frist ??
    recognizedData?.Deadline ??
    recognizedData?.deadline ??
    recognizedData?.['Gültig bis'] ??
    recognizedData?.['Gueltig bis'];
  if (fromData?.trim()) return fromData.trim();
  if (document.validUntil) return document.validUntil.slice(0, 10);
  return null;
}

function extractRequiredDocuments(
  document: CompanyDocument,
  classifiedKind?: ClassifiedDocumentKind,
  inboxItem?: InboxItem,
): string[] {
  if (inboxItem && (classifiedKind === 'werkvertrag' || classifiedKind === 'subunternehmervertrag')) {
    const analysis = analyzeContractFromInbox(inboxItem);
    if (analysis.requiredDocuments.length > 0) {
      return analysis.requiredDocuments.map((item) => item.reason || item.type);
    }
  }

  if (classifiedKind === 'werkvertrag' || classifiedKind === 'subunternehmervertrag') {
    const analysis = analyzeContract({
      recognizedText: document.recognizedText,
      kindHint: classifiedKind,
    });
    if (analysis.requiredDocuments.length > 0) {
      return analysis.requiredDocuments.map((item) => item.reason || item.type);
    }
  }

  return [];
}

function deriveTopic(
  document: CompanyDocument,
  classifiedKind?: ClassifiedDocumentKind,
  recognizedData?: Record<string, string>,
): string {
  const fromData =
    recognizedData?.Dokument ??
    recognizedData?.Betreff ??
    recognizedData?.Thema ??
    recognizedData?.Subject;
  if (fromData?.trim()) return fromData.trim();

  const authorities = detectAuthoritiesFromDocument(
    buildHaystack(document, recognizedData),
    classifiedKind,
  );
  if (authorities.length > 0) {
    return `Schreiben von ${getAuthorityLabel(authorities[0]!)}`;
  }

  if (document.issuer.trim()) {
    return `Dokument von ${document.issuer.trim()}`;
  }

  return document.title.trim() || 'Archiviertes Dokument';
}

function deriveNextAction(
  document: CompanyDocument,
  classifiedKind?: ClassifiedDocumentKind,
): string {
  if (classifiedKind) {
    return buildExplanation(classifiedKind, document.issuer || 'Absender unbekannt');
  }

  if (document.validUntil) {
    return 'Gültigkeit prüfen und rechtzeitig erneuern.';
  }

  return 'Im Archiv abgelegt – bei Bedarf öffnen und prüfen.';
}

function deriveRiskLevel(
  classifiedKind?: ClassifiedDocumentKind,
  proofMemory?: ProofMemory,
  todayIso?: string,
): MemoryRiskLevel {
  if (classifiedKind === 'mahnung' || classifiedKind === 'zahlungserinnerung') {
    return 'high';
  }

  if (proofMemory && todayIso) {
    const status = proofStatusFromValidUntil(proofMemory.validUntil, todayIso);
    if (status === 'expired') return 'high';
    if (status === 'expiring') return 'medium';
  }

  if (
    classifiedKind === 'freistellungsbescheinigung' ||
    classifiedKind === 'unbedenklichkeitsbescheinigung' ||
    classifiedKind === 'bg_bau' ||
    classifiedKind === 'soka_bau'
  ) {
    return 'medium';
  }

  return 'low';
}

function deriveSourceConfidence(
  document: CompanyDocument,
  classifiedKind?: ClassifiedDocumentKind,
  recognizedData?: Record<string, string>,
): MemorySourceConfidence {
  let score = 0;
  if (classifiedKind) score += 2;
  if (document.issuer.trim()) score += 1;
  if (document.validUntil) score += 1;
  if (recognizedData && Object.keys(recognizedData).length > 0) score += 1;
  if (document.recognizedText.trim().length > 40) score += 1;

  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

function buildShortSummary(
  document: CompanyDocument,
  classifiedKind?: ClassifiedDocumentKind,
  topic?: string,
  deadline?: string | null,
): string {
  const kindLabel = formatKindLabel(classifiedKind, document.title);
  const issuerPart = document.issuer.trim() ? ` von ${document.issuer.trim()}` : '';
  const deadlinePart = deadline ? ` Frist/Gültigkeit: ${deadline}.` : '';
  return `${kindLabel}${issuerPart}. ${topic ?? document.title}.${deadlinePart}`.replace(/\s+/g, ' ').trim();
}

export function buildDocumentSummary(input: DocumentSummaryInput): DocumentSummary {
  const { document, classifiedKind, recognizedData, proofMemory, todayIso } = input;
  const haystack = buildHaystack(document, recognizedData);
  const deadline = extractDeadline(document, recognizedData);
  const topic = deriveTopic(document, classifiedKind, recognizedData);
  const proofType = proofMemory?.proofType;
  const requiredDocuments = extractRequiredDocuments(document, classifiedKind);
  if (proofType && !requiredDocuments.includes(PROOF_TYPE_LABELS[proofType])) {
    requiredDocuments.unshift(PROOF_TYPE_LABELS[proofType]);
  }

  return {
    documentKindLabel: formatKindLabel(classifiedKind, document.title),
    issuer: document.issuer.trim() || 'Unbekannt',
    topic,
    shortSummary: buildShortSummary(document, classifiedKind, topic, deadline),
    deadline,
    amounts: extractAmounts(haystack, recognizedData),
    requiredDocuments,
    nextAction: deriveNextAction(document, classifiedKind),
    riskLevel: deriveRiskLevel(classifiedKind, proofMemory, todayIso),
    sourceConfidence: deriveSourceConfidence(document, classifiedKind, recognizedData),
    origin: 'rules',
    generatedAt: new Date().toISOString(),
  };
}

export type DocumentSummaryMergeMode = 'replace-rules' | 'fill-gaps' | 'overlay';

function mergeStringField(
  base: string,
  patch: string | undefined,
  mode: DocumentSummaryMergeMode,
): string {
  if (!patch?.trim()) return base;
  if (mode === 'fill-gaps' && base.trim()) return base;
  return patch.trim();
}

function mergeArrayField<T extends string>(
  base: T[],
  patch: T[] | undefined,
  mode: DocumentSummaryMergeMode,
): T[] {
  if (!patch?.length) return base;
  if (mode === 'fill-gaps' && base.length > 0) return base;
  return patch;
}

/** Zentrale Merge-Stelle für Regeln und künftige KI-Verbesserungen (AI-01). */
export function mergeDocumentSummaries(
  base: DocumentSummary,
  patch: Partial<DocumentSummary>,
  options: { mode?: DocumentSummaryMergeMode; origin?: DocumentSummaryOrigin } = {},
): DocumentSummary {
  const mode = options.mode ?? 'overlay';
  const generatedAt = new Date().toISOString();

  if (mode === 'replace-rules') {
    return {
      ...base,
      ...patch,
      origin: 'rules',
      generatedAt,
    };
  }

  const merged: DocumentSummary = {
    documentKindLabel: mergeStringField(base.documentKindLabel, patch.documentKindLabel, mode),
    issuer: mergeStringField(base.issuer, patch.issuer, mode),
    topic: mergeStringField(base.topic, patch.topic, mode),
    shortSummary: mergeStringField(base.shortSummary, patch.shortSummary, mode),
    deadline:
      mode === 'fill-gaps' && base.deadline
        ? base.deadline
        : patch.deadline !== undefined
          ? patch.deadline
          : base.deadline,
    amounts: mergeArrayField(base.amounts, patch.amounts, mode),
    requiredDocuments: mergeArrayField(base.requiredDocuments, patch.requiredDocuments, mode),
    nextAction: mergeStringField(base.nextAction, patch.nextAction, mode),
    riskLevel:
      mode === 'fill-gaps' && base.riskLevel !== 'unknown'
        ? base.riskLevel
        : patch.riskLevel ?? base.riskLevel,
    sourceConfidence:
      mode === 'fill-gaps' && base.sourceConfidence !== 'low'
        ? base.sourceConfidence
        : patch.sourceConfidence ?? base.sourceConfidence,
    origin:
      options.origin ??
      (mode === 'overlay' && base.origin === 'rules' ? 'ai' : 'hybrid'),
    generatedAt,
  };

  return merged;
}

/** Regeln beim Re-Archivieren: überschreibt reine Regel-Summary, respektiert KI-Anteile. */
export function mergeRulesIntoMemorySummary(
  existing: DocumentSummary | undefined,
  rules: DocumentSummary,
): DocumentSummary {
  if (!existing) return rules;
  if (existing.origin === 'rules') {
    return { ...rules, origin: 'rules', generatedAt: new Date().toISOString() };
  }
  return mergeDocumentSummaries(existing, rules, { mode: 'fill-gaps', origin: 'hybrid' });
}

/** Hook für AI-01: verbessert dieselben Felder, ohne parallele Summary-Struktur. */
export function applyAiSummaryEnhancement(
  existing: DocumentSummary,
  aiPatch: Partial<DocumentSummary>,
): DocumentSummary {
  return mergeDocumentSummaries(existing, aiPatch, {
    mode: 'overlay',
    origin: existing.origin === 'rules' ? 'ai' : 'hybrid',
  });
}

export function formatDigitalLocation(document: CompanyDocument): string {
  if (!document.digitalFolder?.path) return 'Kein digitaler Speicherort hinterlegt.';
  const name = document.digitalFolder.name?.trim();
  return name
    ? `${name} (${document.digitalFolder.path})`
    : document.digitalFolder.path;
}

export function formatPaperLocation(document: CompanyDocument): string {
  if (!document.paperFolder?.folderId && !document.paperFolder?.label) {
    return 'Kein Papierordner hinterlegt – bitte Ablage prüfen.';
  }
  return formatPaperFilingInstruction(document.paperFolder);
}
