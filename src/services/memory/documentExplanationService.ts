import type { AppLanguage, ClassifiedDocumentKind, CompanyDocument, InboxItem } from '../../types/models';
import type {
  DocumentExplanation,
  DocumentMemory,
  MemoryRiskLevel,
  MemorySourceConfidence,
} from '../../types/memory';
import { getCommunicationReplyStatus } from '../communicationHistoryService';
import { buildExplanation } from '../documentClassificationCatalog';
import { getDocumentById } from '../documentService';
import { getInboxItemById } from '../inboxService';
import {
  formatPaperLocationSummary,
  getPhysicalFilingStatusLabel,
  isAdvertisementContext,
  resolvePaperFiling,
} from '../paperFolderService';
import {
  getAllDocumentMemories,
  getDocumentMemoryByDocumentId,
  getPaperRegisterEntryForDocument,
  getProofMemories,
  getProofsForVorgang,
} from '../officePilotMemoryService';
import { getTodayIso } from '../taskNormalize';
import { getAuthorityLabel } from './memoryAuthorityMapping';
import {
  buildDocumentSummary,
  formatDigitalLocation,
  formatPaperLocation,
} from './documentSummaryService';
import { buildPremiumLetterExplanation } from './documentUnderstandingService';

import { OFFICEPILOT_LEGAL_DISCLAIMER } from '../../config/legalDisclaimer';

import type { TranslationKey } from '../../i18n';
import { t } from '../../i18n';

export const EXPLANATION_NO_DATA_KEY = 'documentExplanation.noData' as const satisfies TranslationKey;

export function getExplanationNoDataMessage(lang: AppLanguage = 'de'): string {
  return t(EXPLANATION_NO_DATA_KEY, lang);
}

/** @deprecated Use getExplanationNoDataMessage(lang) */
export const EXPLANATION_NO_DATA_MESSAGE = getExplanationNoDataMessage('de');

export function isExplanationNoDataMessage(message: string): boolean {
  return (
    message === getExplanationNoDataMessage('de') ||
    message === getExplanationNoDataMessage('tr') ||
    message === getExplanationNoDataMessage('bg')
  );
}

export const EXPLANATION_DISCLAIMER = OFFICEPILOT_LEGAL_DISCLAIMER;

export const FORBIDDEN_EXPLANATION_PHRASES = [
  'rechtlich verbindlich',
  'steuerlich sicher',
  'ich habe versendet',
  'sie müssen unbedingt',
] as const;

export type DocumentExplanationRef = { documentId?: string; inboxId?: string };

const REPLY_STATUS_LABELS: Record<string, string> = {
  needs_reply: 'Antwort offen',
  draft_ready: 'Entwurf vorbereitet',
  copied: 'Antwort kopiert – Versand prüfen',
  answered: 'Als erledigt markiert',
  no_reply_needed: 'Kein Antwortbedarf',
};

const PROOF_LABELS: Record<string, string> = {
  freistellungsbescheinigung: 'Freistellungsbescheinigung §48b',
  bg_bau: 'BG BAU Unbedenklichkeitsbescheinigung',
  soka_bau: 'SOKA-BAU',
  betriebshaftpflicht: 'Betriebshaftpflicht',
};

function formatRiskLabel(riskLevel: MemoryRiskLevel | undefined): string {
  switch (riskLevel) {
    case 'high':
      return 'Erhöht – zeitnah prüfen.';
    case 'medium':
      return 'Mittel – Frist und Nachweise im Blick behalten.';
    case 'low':
      return 'Gering – routinemäßig ablegen.';
    default:
      return 'Unklar – Inhalt bitte manuell prüfen.';
  }
}

function formatConfidenceNote(confidence: MemorySourceConfidence | undefined): string | undefined {
  if (confidence === 'low') {
    return 'Die Erkennung ist unsicher – bitte den Brief kurz gegenlesen.';
  }
  if (confidence === 'medium') {
    return 'Einige Angaben sind unvollständig – bei Unklarheit manuell prüfen.';
  }
  return undefined;
}

function isAdvertisementDocument(
  document: CompanyDocument,
  classifiedKind?: ClassifiedDocumentKind,
  inboxItem?: InboxItem,
): boolean {
  if (inboxItem?.isAdvertisement) return true;
  const haystack = `${document.title} ${document.issuer} ${document.recognizedText}`.toLowerCase();
  if (/werbung|reklame|prospekt|newsletter|aktionsmail/.test(haystack)) return true;
  return isAdvertisementContext({
    classifiedKind,
    documentType: inboxItem?.documentType,
    issuer: document.issuer,
    isAdvertisement: inboxItem?.isAdvertisement,
  });
}

function buildWhyImportant(
  classifiedKind: ClassifiedDocumentKind | undefined,
  document: CompanyDocument,
): string {
  switch (classifiedKind) {
    case 'bg_bau':
    case 'berufsgenossenschaft':
    case 'unbedenklichkeitsbescheinigung':
      return 'BG-BAU-Nachweise werden bei Aufträgen und Prüfungen häufig angefordert.';
    case 'finanzamt':
    case 'steuerbescheid':
    case 'umsatzsteuerbescheid':
      return 'Finanzamt-Schreiben können Fristen und Pflichten betreffen – Aufbewahrung ist wichtig.';
    case 'freistellungsbescheinigung':
      return 'Die Freistellungsbescheinigung wird bei Subunternehmer-Aufträgen oft verlangt.';
    case 'werkvertrag':
    case 'subunternehmervertrag':
      return 'Verträge regeln Leistungen, Nachweise und Haftung – relevant für den laufenden Auftrag.';
    case 'betriebshaftpflicht':
    case 'versicherung':
    case 'versicherungsbescheid':
      return 'Versicherungsnachweise sichern den Betrieb bei Schadensfällen ab.';
    case 'eingangsrechnung':
    case 'rechnung':
      return 'Eingangsrechnungen gehören zur Buchhaltung und können steuerlich relevant sein.';
    case 'mahnung':
    case 'zahlungserinnerung':
      return 'Mahnungen betreffen offene Zahlungen – zeitnahe Klärung vermeidet Mehrkosten.';
    default:
      if (document.validUntil) {
        return 'Das Dokument hat ein Ablaufdatum – Gültigkeit im Blick behalten.';
      }
      return 'Für die Ordnerstruktur und spätere Rückfragen ist eine saubere Ablage sinnvoll.';
  }
}

function buildActionRequiredText(
  classifiedKind: ClassifiedDocumentKind | undefined,
  summaryDeadline: string | null | undefined,
  requiredDocuments: string[],
  isAdvertisement: boolean,
  confidence: MemorySourceConfidence | undefined,
): string {
  if (isAdvertisement) {
    return 'Nein – Werbung kann entsorgt werden, nicht dauerhaft abheften.';
  }
  if (classifiedKind === 'mahnung' || classifiedKind === 'zahlungserinnerung') {
    return 'Ja – offene Forderung prüfen und bei Bedarf reagieren.';
  }
  if (summaryDeadline) {
    return confidence === 'low'
      ? 'Es sieht nach einer Frist aus – bitte im Brief gegenprüfen.'
      : 'Ja – Frist oder Gültigkeit beachten.';
  }
  if (requiredDocuments.length > 0) {
    return 'Ja – fehlende Nachweise bereithalten oder vervollständigen.';
  }
  if (
    classifiedKind === 'freistellungsbescheinigung' ||
    classifiedKind === 'bg_bau' ||
    classifiedKind === 'unbedenklichkeitsbescheinigung'
  ) {
    return 'Ja – Nachweis bereithalten und Gültigkeit prüfen.';
  }
  return 'Nein – vorerst ablegen und bei Bedarf nachlesen.';
}

function buildOriginalFiledStatus(documentId: string, memory?: DocumentMemory): string {
  const entry = getPaperRegisterEntryForDocument(documentId);
  const physicalFiled = memory?.physicalFiled ?? entry?.physicalFiled ?? false;
  const filedAt = memory?.filedAt ?? entry?.filedAt;
  const label = getPhysicalFilingStatusLabel(physicalFiled, filedAt);
  if (label.statusKey === 'document.filing.statusFiled' && label.filedAtLabel) {
    return `Original abgeheftet am ${label.filedAtLabel}.`;
  }
  return physicalFiled ? 'Original abgeheftet.' : 'Original noch nicht als abgeheftet markiert.';
}

function buildCommunicationStatus(documentId: string): string | undefined {
  const status = getCommunicationReplyStatus({ type: 'document', id: documentId });
  if (status === 'no_reply_needed') return undefined;
  return REPLY_STATUS_LABELS[status] ?? status;
}

function collectMissingProofsForVorgang(vorgangId: string | undefined): string[] {
  if (!vorgangId) return [];
  const missing = getProofsForVorgang(vorgangId).filter((item) => item.status === 'missing');
  return missing.map((item) => PROOF_LABELS[item.proofType] ?? item.proofType);
}

function buildNextSteps(
  document: CompanyDocument,
  memory: DocumentMemory | undefined,
  classifiedKind: ClassifiedDocumentKind | undefined,
  isAdvertisement: boolean,
  missingProofs: string[],
  communicationStatus?: string,
): string[] {
  const steps: string[] = [];

  if (isAdvertisement) {
    steps.push('Werbung entsorgen – nicht im Papierordner abheften.');
    return steps;
  }

  if (communicationStatus === 'Antwort offen') {
    steps.push('Antwort vorbereiten oder als erledigt markieren.');
  } else if (communicationStatus === 'Entwurf vorbereitet') {
    steps.push('Entwurf prüfen und versenden oder Status aktualisieren.');
  }

  const entry = getPaperRegisterEntryForDocument(document.id);
  const physicalFiled = memory?.physicalFiled ?? entry?.physicalFiled ?? false;
  if (!physicalFiled && (memory?.paperFolder?.folderId || document.paperFolder?.folderId)) {
    steps.push('Original im Papierordner abheften und in OfficePilot bestätigen.');
  }

  if (missingProofs.length > 0) {
    steps.push(`Fehlende Nachweise beschaffen: ${missingProofs.join(', ')}.`);
  }

  if (memory?.nextAction) {
    steps.push(memory.nextAction);
  } else if (classifiedKind) {
    steps.push(buildExplanation(classifiedKind, document.issuer || 'Absender'));
  }

  if (classifiedKind === 'freistellungsbescheinigung' && document.validUntil) {
    steps.push(`Gültigkeit bis ${document.validUntil.slice(0, 10)} im Kalender behalten.`);
  }

  return [...new Set(steps)].slice(0, 5);
}

function buildAdvertisementExplanation(document: CompanyDocument): DocumentExplanation {
  return {
    shortAnswer: 'Es handelt sich vermutlich um Werbung – nicht dauerhaft ablegen.',
    whatIsIt: 'Werbung oder Prospekt ohne betrieblichen Nachweischarakter.',
    whyImportant: 'Werbung muss nicht archiviert werden und bindet keinen Platz im Ordner.',
    actionRequired: 'Nein – entsorgen, nicht abheften.',
    deadline: 'Keine Frist.',
    requiredDocuments: [],
    risk: 'Gering – kein Handlungsbedarf.',
    recommendation: 'Digital löschen oder Papier entsorgen.',
    digitalLocation: formatDigitalLocation(document),
    paperLocation: 'Kein Papierordner – Entsorgen.',
    register: '—',
    originalFiledStatus: 'Nicht erforderlich.',
    nextSteps: ['Werbung entsorgen – nicht im Papierordner abheften.'],
    uncertaintyNote: 'Bitte kurz prüfen, ob doch ein Rechnungs- oder Vertragsbezug besteht.',
    disclaimer: EXPLANATION_DISCLAIMER,
    sourceDocumentId: document.id,
    sourceTitle: document.title,
  };
}

function resolveExplanationContext(ref: DocumentExplanationRef): {
  document: CompanyDocument;
  memory?: DocumentMemory;
  inboxItem?: InboxItem;
} | null {
  if (ref.documentId) {
    const document = getDocumentById(ref.documentId);
    if (!document) return null;
    const memory = getDocumentMemoryByDocumentId(ref.documentId);
    const inboxItem = memory?.inboxId ? getInboxItemById(memory.inboxId) : undefined;
    return { document, memory, inboxItem };
  }

  if (ref.inboxId) {
    const inboxItem = getInboxItemById(ref.inboxId);
    const memory = getAllDocumentMemories().find((item) => item.inboxId === ref.inboxId);
    if (memory?.documentId) {
      const document = getDocumentById(memory.documentId);
      if (document) return { document, memory, inboxItem };
    }
    return null;
  }

  return null;
}

export function buildDocumentExplanation(
  ref: DocumentExplanationRef,
  todayIso: string = getTodayIso(),
): DocumentExplanation | null {
  const context = resolveExplanationContext(ref);
  if (!context) return null;

  const { document, memory, inboxItem } = context;
  const classifiedKind = memory?.classifiedKind ?? inboxItem?.classifiedKind;

  if (isAdvertisementDocument(document, classifiedKind, inboxItem)) {
    return buildAdvertisementExplanation(document);
  }

  const proofMemory = getProofMemories().find(
    (item) => item.documentId === document.id && item.status !== 'missing',
  );

  const summary =
    memory?.summary ??
    buildDocumentSummary({
      document,
      classifiedKind,
      recognizedData: inboxItem?.recognizedData,
      proofMemory,
      todayIso,
    });

  const letter =
    memory?.letterExplanation ??
    buildPremiumLetterExplanation(document, summary, classifiedKind, inboxItem?.recognizedData);

  const registerEntry = getPaperRegisterEntryForDocument(document.id);
  const paperResolution = resolvePaperFiling({
    classifiedKind,
    documentType: inboxItem?.documentType,
    issuer: document.issuer,
    linkedVorgangId: memory?.linkedVorgangId ?? document.linkedVorgang?.vorgangId,
    isAdvertisement: inboxItem?.isAdvertisement,
  });

  const paperFolder = memory?.paperFolder ?? document.paperFolder;
  const paperLocation =
    paperResolution.skipPhysicalFiling
      ? 'Kein Papierordner – Entsorgen oder manuell ablegen.'
      : letter.paperStorage || formatPaperLocation(document);

  const register =
    registerEntry?.register ??
    paperFolder?.register ??
    paperResolution.rule?.register ??
    '—';

  const missingProofs = collectMissingProofsForVorgang(
    memory?.linkedVorgangId ?? document.linkedVorgang?.vorgangId,
  );

  const requiredDocuments = [
    ...new Set([
      ...(summary.requiredDocuments ?? []),
      ...(memory?.requiredDocuments ?? []),
      ...missingProofs,
    ]),
  ].filter((item) => item && !item.startsWith('Keine'));

  const communicationStatus = buildCommunicationStatus(document.id);
  const originalFiledStatus = buildOriginalFiledStatus(document.id, memory);
  const uncertaintyNote = formatConfidenceNote(summary.sourceConfidence);

  const nextSteps = buildNextSteps(
    document,
    memory,
    classifiedKind,
    false,
    missingProofs,
    communicationStatus,
  );

  const deadline = summary.deadline ?? letter.deadline ?? 'Keine Frist erkannt.';
  const actionRequired = buildActionRequiredText(
    classifiedKind,
    summary.deadline,
    requiredDocuments,
    false,
    summary.sourceConfidence,
  );

  return {
    shortAnswer: letter.shortExplanation || summary.shortSummary,
    whatIsIt: letter.whatIsItAbout || summary.topic,
    whyImportant: buildWhyImportant(classifiedKind, document),
    actionRequired,
    deadline: deadline === 'Keine Frist erkannt.' ? 'Keine Frist erkannt.' : deadline,
    requiredDocuments:
      requiredDocuments.length > 0 ? requiredDocuments : ['Keine zusätzlichen Unterlagen erkannt.'],
    risk: letter.risks || formatRiskLabel(summary.riskLevel ?? memory?.riskLevel),
    recommendation: letter.recommendation || summary.nextAction,
    digitalLocation: letter.digitalStorage || formatDigitalLocation(document),
    paperLocation:
      paperResolution.rule && !paperResolution.skipPhysicalFiling
        ? formatPaperLocationSummary(paperResolution.rule)
        : paperLocation,
    register,
    originalFiledStatus,
    communicationStatus,
    nextSteps,
    uncertaintyNote,
    disclaimer: EXPLANATION_DISCLAIMER,
    sourceDocumentId: document.id,
    sourceTitle: document.title,
  };
}

export function documentExplanationToMemoryQueryAnswer(
  explanation: DocumentExplanation,
): import('../../types/memory').MemoryQueryAnswer {
  return {
    shortAnswer: explanation.shortAnswer,
    source: `Firmen-Gedächtnis: ${explanation.sourceTitle ?? 'Dokument'}`,
    digitalLocation: explanation.digitalLocation,
    paperLocation: explanation.paperLocation,
    register: explanation.register,
    status: [
      explanation.actionRequired,
      explanation.originalFiledStatus,
      explanation.communicationStatus,
    ]
      .filter(Boolean)
      .join(' · '),
    nextStep: explanation.nextSteps[0] ?? explanation.recommendation,
    uncertainty: explanation.uncertaintyNote,
  };
}

export function findDocumentForExplanationQuestion(question: string): DocumentExplanation | null {
  const q = question.toLowerCase();

  if (/freistellung/.test(q)) {
    const memory = getAllDocumentMemories().find(
      (item) =>
        item.proofType === 'freistellungsbescheinigung' ||
        item.classifiedKind === 'freistellungsbescheinigung' ||
        /freistellung/i.test(item.title),
    );
    if (memory) return buildDocumentExplanation({ documentId: memory.documentId });
  }

  if (/bg[\s-]?bau|unbedenklichkeit/.test(q)) {
    const memory = getAllDocumentMemories().find(
      (item) =>
        item.classifiedKind === 'bg_bau' ||
        item.proofType === 'bg_bau' ||
        /bg[\s-]?bau|unbedenklichkeit/i.test(`${item.title} ${item.issuer}`),
    );
    if (memory) return buildDocumentExplanation({ documentId: memory.documentId });
  }

  if (/finanzamt/.test(q)) {
    const memory = getAllDocumentMemories().find(
      (item) =>
        item.relatedAuthorities?.includes('finanzamt') ||
        item.classifiedKind === 'finanzamt' ||
        /finanzamt/i.test(item.issuer),
    );
    if (memory) return buildDocumentExplanation({ documentId: memory.documentId });
  }

  if (/werkvertrag|vertrag/.test(q)) {
    const memory = getAllDocumentMemories().find(
      (item) =>
        item.classifiedKind === 'werkvertrag' ||
        item.classifiedKind === 'subunternehmervertrag',
    );
    if (memory) return buildDocumentExplanation({ documentId: memory.documentId });
  }

  const first = getAllDocumentMemories()[0];
  if (first) return buildDocumentExplanation({ documentId: first.documentId });

  return null;
}

export function containsForbiddenExplanationPhrase(text: string): boolean {
  const normalized = text.toLowerCase();
  return FORBIDDEN_EXPLANATION_PHRASES.some((phrase) => normalized.includes(phrase));
}

export function explanationKindLabel(classifiedKind?: ClassifiedDocumentKind): string {
  if (!classifiedKind) return 'Dokument';
  if (classifiedKind === 'bg_bau' || classifiedKind === 'berufsgenossenschaft') {
    return getAuthorityLabel('bg_bau');
  }
  if (classifiedKind === 'finanzamt' || classifiedKind === 'steuerbescheid') {
    return getAuthorityLabel('finanzamt');
  }
  return classifiedKind.replace(/_/g, ' ');
}
