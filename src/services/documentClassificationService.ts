import { PAPER_FOLDERS } from '../data/mockData';
import { getPaperFolderById } from './paperFolderService';
import { buildVorgangDraftFromInbox, findSimilarVorgaenge } from './vorgangMatchingService';
import { getAllVorgaenge, getVorgangById } from './vorgangService';
import {
  hasEmploymentBaSignals,
  hasStrongPaymentDemandEvidence,
} from '../config/documentIntelligenceConfig';
import { UNKNOWN_SENDER_CANONICAL } from '../i18n/resolveStoredText';
import {
  buildDigitalFolderSpec,
  buildExplanation,
  buildNextTask,
  CLASSIFICATION_RULES,
  defaultPriority,
  defaultRecommendedAction,
  getActionsForKind,
  isKnownClassifiedKind,
  mapKindToDocumentType,
  suggestProcessType,
} from './documentClassificationCatalog';
import { shouldBlockHealthInsuranceKind } from './documentProfileService';
import { resolvePaperFiling, suggestPaperFolder } from './paperFolderService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import { runLegacyDocumentAnalysisShadow } from './documentAnalysisShadowService';
import { resolveHybridClassification } from './documentClassificationHybridService';
import { extractFieldsFromText, mergeExtractedFields } from './documentFieldExtractionService';
import { resolvePrimaryTargetObjectForKind } from './documentPrimaryTargetService';
import { buildDocumentSemanticCore } from './document/documentSemanticCoreService';
import { detectFinanceDocumentMarkers, resolveFinanceReviewReason } from './document/financeDocumentMarkers';
import { resolveInstitutionalLetterhead, resolveInstitutionalSenderTruth } from './document/institutionalSenderTruth';
import { mainDocumentTextFromPages, resolveMainDocumentPageScope } from './document/mainDocumentPageScope';
import { isComplaintLetter } from './document/complaintLetter';
import { getCompanyProfile } from './companyProfileService';
import { hasContractFamilyTitle, hasDocumentTitleLine } from './contractIntelligenceExtraction';
import type { ContractFamily } from '../types/documentIntelligence';
import { toCanonicalIsoDay } from '../utils/documentDateDisplay';
import type { BusinessDeadlineType } from '../types/businessInterpretation';
import {
  buildEvidenceBasedRecognizedData,
  shouldUseEvidenceBasedRecognizedData,
} from './documentRecognizedDataService';
import type {
  ClassifiedDocumentKind,
  DigitalFolder,
  DocumentClassificationInput,
  DocumentClassificationResult,
  InboxFinanceReviewReason,
  InboxItem,
  InboxTaskTemplate,
  PaperFilingRule,
  SuggestedDocumentAction,
  SuggestedVorgangLink,
  UploadDocumentKind,
} from '../types/models';

export {
  CLASSIFIED_DOCUMENT_KINDS,
  mapKindToDocumentType,
} from './documentClassificationCatalog';

const INVOICE_KINDS = new Set<ClassifiedDocumentKind>([
  'eingangsrechnung',
  'rechnung',
  'ausgangsrechnung',
  'gutschrift',
]);

/** Specific invoice subtypes evaluated on the strong-invoice fast path (before generic ER). */
const INVOICE_FAST_PATH_KINDS = new Set<ClassifiedDocumentKind>([
  ...INVOICE_KINDS,
  'reparaturrechnung',
]);

const CONTRACT_PAYMENT_TERMS = /schlussrechnung|abschlagsrechnung|teilrechnung/i;

/** Utility / telecom / hotel invoice titles — strong even without Rechnungsnummer. */
const SECTOR_INVOICE_TITLE =
  /(?:strom|gas|wasser|abwasser|energie|fernwärme|fernwaerme|mobilfunk|festnetz|internet|hotel|material)rechnung/i;
const SECTOR_INVOICE_ISSUER =
  /\b(?:stadtwerke|versorger|energieversorger|wasserwerke|telekom|vodafone|\bo2\b|1\s*&\s*1|congstar|hotel)\b/i;

/*
 * EINGANG-01A — Werbemerkmale. „Werbungskosten" (Steuer) und „Bewerbung" sind
 * keine Werbung; der frühere reine Teilwort-Treffer machte daraus Werbung.
 */
const ADVERTISEMENT_TERMS =
  /(?<!be)werbung(?!skosten)|reklame|prospekt|newsletter|aktionsmail/;
/*
 * Geschäftsdokumente tragen solche Wörter oft nur in der Fußzeile
 * („Newsletter abonnieren"). Diese Merkmale überstimmen den Werbetreffer.
 */
const BUSINESS_DOCUMENT_MARKERS =
  /\b(?:mahnung|zahlungserinnerung|inkasso|lieferschein|aktenzeichen|bescheid)\b/;

function looksLikeAdvertisement(input: DocumentClassificationInput): boolean {
  if (input.kindHint === 'werbung') return true;
  const haystack = buildHaystack(input);
  if (!ADVERTISEMENT_TERMS.test(haystack)) return false;
  return !hasStrongInvoiceSignals(haystack) && !BUSINESS_DOCUMENT_MARKERS.test(haystack);
}

function hasStrongInvoiceSignals(haystack: string): boolean {
  // EINGANG-02B — auch ein gerichtlicher Mahnbescheid ist keine Rechnung.
  if (/mahnung|zahlungserinnerung|inkasso|mahnbescheid/.test(haystack)) {
    return false;
  }
  if (SECTOR_INVOICE_TITLE.test(haystack)) {
    return true;
  }
  if (SECTOR_INVOICE_ISSUER.test(haystack) && /\brechnung\b/.test(haystack)) {
    return true;
  }
  if (/\b(?:ausgangsrechnung|eingangsrechnung|honorarrechnung|werkstattrechnung|reparaturrechnung)\b/i.test(haystack)) {
    return true;
  }
  // Numbered progress/final invoices — not payment-term prose ("Schlussrechnung nach Abnahme").
  if (/\b(?:abschlagsrechnung|schlussrechnung|teilrechnung)\s*(?:nr\.?|nummer|#)\s*[a-z0-9]/i.test(haystack)) {
    return true;
  }
  // "Rechnung RE-2026-11842" / "Rechnung Nr. …" without the label "Rechnungsnummer"
  if (/\brechnung\s+(?:nr\.?|nummer)?\s*[a-z0-9][\w./-]{2,}/i.test(haystack)) {
    return true;
  }
  if (/\brechnung\b/i.test(haystack) && /(?:netto|ust|mwst|umsatzsteuer).*(?:brutto|gesamt)/i.test(haystack)) {
    return true;
  }
  const invoiceMarkers = [
    /rechnungsnummer/i,
    /rechnungsdatum/i,
    /rechnungsempfänger|rechnungsempfaenger/i,
    /leistungsdatum/i,
    /leistungszeitraum/i,
    /(?:netto|umsatzsteuer|mehrwertsteuer|ust).*(?:brutto|gesamt)/i,
    /zahlungsaufforderung/i,
    /rechnungsaussteller/i,
    /bankverbindung.*rechnung/i,
  ];
  const hits = invoiceMarkers.filter((pattern) => pattern.test(haystack)).length;
  if (hits >= 2) return true;
  return /rechnungsnummer/i.test(haystack) && /(?:netto|brutto|umsatzsteuer)/i.test(haystack);
}

function hasContractPrioritySignals(
  haystack: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): boolean {
  const intro = pageTexts?.length
    ? pageTexts
        .slice(0, 3)
        .map((page) => page.text)
        .join('\n')
        .toLowerCase()
    : haystack.slice(0, 4000);

  return /werkvertrag|bau[\s-]?subunternehmer|subunternehmervertrag|auftraggeber.*subunternehmer/i.test(intro);
}

function hasBillOfQuantitiesSignals(
  haystack: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): boolean {
  if (/leistungsverzeichnis|\bpos\.\s+menge|einzelpreis.*gesamt/i.test(haystack)) return true;
  return Boolean(
    pageTexts?.some((page) =>
      /leistungsverzeichnis|pos\.\s|einzelpreis|gesamtsumme\s+netto/i.test(page.text),
    ),
  );
}

/** True when the document itself is an invoice, not merely mentions invoice terms. */
function isInvoiceDocumentTitle(haystack: string): boolean {
  if (/\b(?:ausgangsrechnung|eingangsrechnung|honorarrechnung|werkstattrechnung|reparaturrechnung)\b/i.test(haystack)) {
    return true;
  }
  return /\b(?:abschlagsrechnung|schlussrechnung|teilrechnung)\s*(?:nr\.?|nummer|#)\s*[a-z0-9]/i.test(
    haystack,
  );
}

function detectContractPriorityKind(
  haystack: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): DetectionResult | null {
  // Invoices that only *reference* a Werkvertrag must not become contracts.
  if (isInvoiceDocumentTitle(haystack)) {
    return null;
  }

  if (!hasContractPrioritySignals(haystack, pageTexts)) return null;

  if (/subunternehmervertrag|subunternehmer/i.test(haystack)) {
    return {
      kind: 'subunternehmervertrag',
      reasonKey: hasBillOfQuantitiesSignals(haystack, pageTexts)
        ? 'classification.detect.werkvertragMitLv'
        : 'classification.detect.subunternehmer',
    };
  }

  if (/nachunternehmervertrag|nachunternehmer/i.test(haystack)) {
    return {
      kind: 'nachunternehmervertrag',
      reasonKey: 'classification.detect.nachunternehmer',
    };
  }

  return {
    kind: 'werkvertrag',
    reasonKey: hasBillOfQuantitiesSignals(haystack, pageTexts)
      ? 'classification.detect.werkvertragMitLv'
      : 'classification.detect.werkvertrag',
  };
}

function shouldSkipInvoiceRule(kind: ClassifiedDocumentKind, haystack: string): boolean {
  if (!INVOICE_KINDS.has(kind)) return false;
  if (hasStrongInvoiceSignals(haystack)) return false;
  if (
    /eingangsrechnung|ausgangsrechnung|rechnungsnummer|materialrechnung|hotelrechnung|honorarrechnung|gutschrift|stromrechnung|gasrechnung|wasserrechnung|abwasserrechnung|energierechnung|mobilfunkrechnung|festnetzrechnung/i.test(
      haystack,
    )
  ) {
    return false;
  }
  if (CONTRACT_PAYMENT_TERMS.test(haystack) && hasContractPrioritySignals(haystack)) return true;
  if (kind === 'rechnung' && /werkvertrag|leistungsverzeichnis|auftraggeber/i.test(haystack)) return true;
  return !hasStrongInvoiceSignals(haystack);
}

/** Delivery-note refs on invoices must not beat the invoice itself. */
function shouldSkipDeliveryNoteRule(kind: ClassifiedDocumentKind, haystack: string): boolean {
  if (kind !== 'lieferschein') return false;
  if (hasStrongInvoiceSignals(haystack)) return true;
  return (
    /\brechnung\b/i.test(haystack) && /(?:netto|brutto|ust|zahlungsziel|\bre-\d)/i.test(haystack)
  );
}

/** Payroll line-items on fee/advisor invoices must not become lohnabrechnung. */
function shouldSkipPayrollRule(kind: ClassifiedDocumentKind, haystack: string): boolean {
  if (kind !== 'lohnabrechnung') return false;
  if (/\bhonorarrechnung\b/i.test(haystack)) return true;
  return (
    /\b(?:steuerberater|steuerberatung|buchführung|buchhaltung)\b/i.test(haystack) &&
    /\brechnung\b/i.test(haystack) &&
    /(?:netto|brutto|ust)/i.test(haystack)
  );
}

/** Generic "Schreiben" must not beat named Krankenkasse correspondence. */
function shouldSkipGenericBriefRule(kind: ClassifiedDocumentKind, haystack: string): boolean {
  if (kind !== 'brief') return false;
  return /\b(?:aok|barmer|dak|ikk|knappschaft|pflegekasse|krankenkasse|techniker\s+kranken)\b/i.test(
    haystack,
  );
}

/** Generic Prüfbericht must not beat HU/AU / TÜV vehicle reports. */
function shouldSkipGenericPruefberichtRule(kind: ClassifiedDocumentKind, haystack: string): boolean {
  if (kind !== 'pruefprotokoll') return false;
  return (
    /(?:tüv|tuev|hauptuntersuchung|\bhu\s*\/\s*au\b|\bnächste\s+hu\b)/i.test(haystack) &&
    /(?:prüfbericht|fahrzeug|kennzeichen|\bhu\b|\bau\b)/i.test(haystack)
  );
}

/** Skip legacy Mahnung/ZE when BA/employment docs lack a real payment demand. */
function shouldSkipPaymentRule(kind: ClassifiedDocumentKind, haystack: string): boolean {
  if (kind !== 'mahnung' && kind !== 'zahlungserinnerung') return false;
  if (!hasEmploymentBaSignals(haystack)) return false;
  return !hasStrongPaymentDemandEvidence(haystack);
}

/**
 * OFFICEPILOT-RECEIPT-PRIMARY-DOCUMENT-TYPE-FIX-01 — `ec_beleg` und
 * `kreditkartenbeleg` beschreiben nur die Zahlungsart. Da `CLASSIFICATION_RULES`
 * per First-Match arbeitet und beide vor `tankbeleg` stehen, verdrängte ein
 * eingebetteter Terminalblock die vorhandene fachliche Hauptart.
 */
const GENERIC_PAYMENT_RECEIPT_KINDS = new Set<ClassifiedDocumentKind>([
  'ec_beleg',
  'kreditkartenbeleg',
]);

/**
 * OFFICEPILOT-RECEIPT-PRIMARY-DOCUMENT-TYPE-FIX-01D — echte Kraftstoff-Sachevidenz.
 * Dieselbe Wortmenge wie `FUEL_MARKER_PATTERN` in der Feature-Extraktion und wie
 * der Tankbeleg-Cutover-Guard; bewusst lokal gehalten, um keinen Importzyklus
 * zwischen Klassifikation und Feature-Extraktion zu erzeugen. Ein gezielter Test
 * hält beide Wege auf demselben fachlichen Vertrag.
 */
const STRONG_FUEL_EVIDENCE = /\b(kraftstoff|diesel|benzin|super|e10|adblue|erdgas|cng|lpg)\b/i;

/**
 * Manche Regelmuster enthalten neben fachlichen Begriffen auch reine Standort-
 * oder Händlerwörter — `tankstelle` ist ein solches. Gegen eine generische
 * Zahlungsart zählt ein Treffer daher nur mit zusätzlicher Sachevidenz.
 */
function hasStrongPrimaryEvidenceAgainstPayment(
  kind: ClassifiedDocumentKind,
  haystack: string,
): boolean {
  if (kind === 'tankbeleg') {
    return STRONG_FUEL_EVIDENCE.test(haystack);
  }
  return true;
}

/**
 * Prüft, ob derselbe Text von einer konkreten Nicht-Zahlungsart klassifiziert
 * werden kann. Bewusst kein rekursiver Aufruf des Klassifizierers: dieselbe
 * Regelliste wird einmal ohne die Zahlungsarten ausgewertet, unter denselben
 * bestehenden Skip-Verträgen. `sonstiges` gilt nicht als Kandidat.
 */
function hasSpecificNonPaymentCandidate(haystack: string): boolean {
  for (const rule of CLASSIFICATION_RULES) {
    if (GENERIC_PAYMENT_RECEIPT_KINDS.has(rule.kind)) continue;
    if (rule.kind === 'sonstiges') continue;
    if (!hasStrongPrimaryEvidenceAgainstPayment(rule.kind, haystack)) continue;
    if (shouldSkipInvoiceRule(rule.kind, haystack)) continue;
    if (shouldSkipDeliveryNoteRule(rule.kind, haystack)) continue;
    if (shouldSkipPayrollRule(rule.kind, haystack)) continue;
    if (shouldSkipGenericBriefRule(rule.kind, haystack)) continue;
    if (shouldSkipGenericPruefberichtRule(rule.kind, haystack)) continue;
    if (shouldSkipPaymentRule(rule.kind, haystack)) continue;
    if (shouldSkipHealthInsuranceRule(rule.kind, haystack)) continue;
    if (rule.pattern.test(haystack)) return true;
  }
  return false;
}

/**
 * Eine generische Zahlungsart wird nur übersprungen, wenn tatsächlich eine
 * fachliche Zielart existiert, die anschließend gewinnt. Fehlt sie — etwa bei
 * Waren-, Restaurant- oder Baumarktbons ohne eigene Regel —, bleibt der
 * Zahlungsbeleg das Ergebnis; er darf nicht auf `sonstiges` verschlechtert
 * werden.
 */
function shouldSkipGenericPaymentReceiptRule(
  kind: ClassifiedDocumentKind,
  haystack: string,
): boolean {
  if (!GENERIC_PAYMENT_RECEIPT_KINDS.has(kind)) return false;
  return hasSpecificNonPaymentCandidate(haystack);
}

/** Skip generic KK / Knappschaft legacy hits on BA employment forms without KK correspondence. */
function shouldSkipHealthInsuranceRule(kind: ClassifiedDocumentKind, haystack: string): boolean {
  return shouldBlockHealthInsuranceKind(kind, haystack);
}

const UPLOAD_KIND_MAP: Record<UploadDocumentKind, ClassifiedDocumentKind> = {
  auftrag: 'auftrag',
  zahlungserinnerung: 'zahlungserinnerung',
  materialrechnung: 'eingangsrechnung',
  bg_bau: 'bg_bau',
  werbung: 'sonstiges',
  kontoauszug: 'kontoauszug',
};

const SECURITY_DEFAULT = 'inbox.securityHintBody';

function paperFolder(folderId: string, register: string): PaperFilingRule {
  const folder = getPaperFolderById(folderId) ?? PAPER_FOLDERS[4];
  return { folderId: folder.id, register, label: folder.name };
}

function buildHaystack(input: DocumentClassificationInput): string {
  return [
    input.sourceFileName ?? '',
    input.titleHint ?? '',
    input.senderHint ?? '',
    input.recognizedText ?? '',
    input.kindHint ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

function resolveKindFromHint(kindHint?: UploadDocumentKind | ClassifiedDocumentKind): ClassifiedDocumentKind | null {
  if (!kindHint) return null;
  if (kindHint in UPLOAD_KIND_MAP) {
    return UPLOAD_KIND_MAP[kindHint as UploadDocumentKind];
  }
  if (isKnownClassifiedKind(kindHint)) {
    return kindHint;
  }
  return null;
}

export interface DetectionResult {
  kind: ClassifiedDocumentKind;
  reasonKey: string;
}

/*
 * EINGANG-01D-1 — Korrektur/Storno und Abrechnungsgutschrift haben keine
 * eigene eingehende Dokumentart (`rechnungskorrektur` gehört der eigenen
 * Ausgangsseite). Sie bleiben `sonstiges` und gehen in den bestehenden
 * Klären-Pfad; der Grund steht im Erkennungsschlüssel und als
 * `financeReviewReason` am Eingang.
 */
const FINANCE_REVIEW_REASON_KEYS: Record<InboxFinanceReviewReason, string> = {
  invoice_correction: 'classification.detect.invoiceCorrection',
  self_billing_credit: 'classification.detect.selfBillingCredit',
};
const CREDIT_NOTE_REASON_KEY = 'classification.detect.gutschrift';
/* EINGANG-02C — Beschwerde/Reklamation/Mängelanzeige am Titel erkannt. */
const COMPLAINT_REASON_KEY = 'classification.detect.complaint';

function detectFinanceDocumentKind(
  recognizedText: string | undefined,
  firstPageText?: string,
): DetectionResult | null {
  const markers = detectFinanceDocumentMarkers(recognizedText, { firstPageText });
  const review = resolveFinanceReviewReason(markers);
  if (review) return { kind: 'sonstiges', reasonKey: FINANCE_REVIEW_REASON_KEYS[review] };
  if (markers.creditNoteHeader) return { kind: 'gutschrift', reasonKey: CREDIT_NOTE_REASON_KEY };
  return null;
}

function financeReviewReasonFromDetection(reasonKey: string): InboxFinanceReviewReason | undefined {
  return (Object.keys(FINANCE_REVIEW_REASON_KEYS) as InboxFinanceReviewReason[]).find(
    (reason) => FINANCE_REVIEW_REASON_KEYS[reason] === reasonKey,
  );
}

const FINANCE_REVIEW_TITLE: Record<InboxFinanceReviewReason, string> = {
  invoice_correction: 'Rechnungskorrektur',
  self_billing_credit: 'Abrechnungsgutschrift',
};
const FINANCE_REVIEW_EXPLANATION: Record<InboxFinanceReviewReason, string> = {
  invoice_correction:
    'Rechnungskorrektur oder Storno erkannt. Sie bezieht sich auf eine vorhandene Rechnung und wird nicht als neue Ausgabe gebucht — bitte den Bezug prüfen.',
  self_billing_credit:
    'Gutschrift im Abrechnungsverfahren erkannt: Hier rechnet der Kunde über unsere Leistung ab. Das ist keine Ausgabe — bitte prüfen.',
};
const FINANCE_REVIEW_NEXT_TASK: Record<InboxFinanceReviewReason, string> = {
  invoice_correction: 'Korrektur prüfen',
  self_billing_credit: 'Abrechnungsgutschrift prüfen',
};

const ACTION_DEADLINE_TYPES: ReadonlySet<string> = new Set<BusinessDeadlineType>([
  'payment_due',
  'response_due',
  'document_submission_due',
  'service_due',
  'termination_notice',
]);

function asActionDeadlineType(type: string | undefined): BusinessDeadlineType | undefined {
  return type && ACTION_DEADLINE_TYPES.has(type) ? (type as BusinessDeadlineType) : undefined;
}

/*
 * EINGANG-02A-1 Nacharbeit 2 — ein Behörden- oder Versicherungsschreiben, das
 * einen Vertrag nur erwähnt („Ihr Auftraggeber … aus dem Werkvertrag",
 * „Bitte legen Sie den Subunternehmervertrag vor"), ist kein Vertrag.
 *
 * Vertragsvorrang und Katalog erkennen diese Arten schon an der bloßen
 * Erwähnung, und beide stehen vor den Behördenregeln. Deshalb: Stammt der
 * Briefkopf von einer Behörde oder Versicherung (`resolveInstitutionalLetterhead`)
 * und steht die Vertragsfamilie nicht als
 * echte Titelzeile im Dokument (`hasContractFamilyTitle`, dieselbe Wahrheit
 * wie im Vertrags-Gate), gilt die institutionelle Art. Ein echter Vertrag mit
 * Titelzeile — auch von einer Stadt oder Versicherung — bleibt Vertrag.
 */
const MENTION_PRONE_CONTRACT_KINDS: ReadonlyMap<ClassifiedDocumentKind, readonly ContractFamily[]> = new Map([
  ['werkvertrag', ['werkvertrag', 'subunternehmervertrag']],
  ['subunternehmervertrag', ['subunternehmervertrag', 'werkvertrag']],
  ['nachunternehmervertrag', ['subunternehmervertrag', 'werkvertrag']],
  ['leasingvertrag', ['leasingvertrag']],
  // Nacharbeit 3 — gewinnt im Katalog vor den Versicherungsregeln; gilt fachlich als Vertragsart.
  ['arbeitsvertrag', ['arbeitsvertrag']],
] as const);

/*
 * Nacharbeit 3 — Protokolle stehen im Katalog vor allen Behördenregeln und
 * lösen Abnahme-/Rechnungswege aus („Bitte senden Sie uns das
 * Abnahmeprotokoll"). Titel ist hier der Begriff der Katalogregel selbst.
 */
const MENTION_PRONE_DOCUMENT_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'abnahmeprotokoll',
  'maengelprotokoll',
  'uebergabeprotokoll',
]);

function hasOwnDocumentTitle(text: string, kind: ClassifiedDocumentKind): boolean {
  const families = MENTION_PRONE_CONTRACT_KINDS.get(kind);
  if (families) return families.some((family) => hasContractFamilyTitle(text, family));
  const rule = CLASSIFICATION_RULES.find((candidate) => candidate.kind === kind);
  return rule ? hasDocumentTitleLine(text, new RegExp(rule.pattern.source, 'i')) : true;
}

function detectInstitutionalLetterheadKind(input: DocumentClassificationInput): DetectionResult | null {
  // Nacharbeit 3 — dieselbe Briefkopf-Wahrheit wie Vertrags-Gate und Vertragsanalyse.
  const letterhead = resolveInstitutionalLetterhead(input.recognizedText, {
    senderHint: input.senderHint,
    ownCompanyName: input.ownCompanyName,
  });
  if (!letterhead) return null;
  if (letterhead.kind && letterhead.reasonKey) return { kind: letterhead.kind, reasonKey: letterhead.reasonKey };
  // Kommunaler Briefkopf ohne eigene Katalogart („Stadt Musterstadt"): ein Schreiben, kein Vertrag.
  return { kind: 'brief', reasonKey: 'classification.detect.brief' };
}

function guardInstitutionalContractMention(
  input: DocumentClassificationInput,
  detection: DetectionResult,
): DetectionResult {
  if (detection.reasonKey === 'classification.detect.uploadHint') return detection;
  if (!MENTION_PRONE_CONTRACT_KINDS.has(detection.kind) && !MENTION_PRONE_DOCUMENT_KINDS.has(detection.kind)) {
    return detection;
  }
  if (hasOwnDocumentTitle(input.recognizedText ?? '', detection.kind)) return detection;
  return detectInstitutionalLetterheadKind(input) ?? detection;
}

export function detectClassifiedKindWithReason(input: DocumentClassificationInput): DetectionResult {
  return guardInstitutionalContractMention(input, detectClassifiedKindCore(input));
}

function detectClassifiedKindCore(input: DocumentClassificationInput): DetectionResult {
  const fromHint = resolveKindFromHint(input.kindHint);
  if (fromHint && input.kindHint !== 'werbung') {
    return { kind: fromHint, reasonKey: 'classification.detect.uploadHint' };
  }

  const haystack = buildHaystack(input);

  if (looksLikeAdvertisement(input)) {
    return { kind: 'sonstiges', reasonKey: 'classification.detect.advertisement' };
  }

  const contractPriority = detectContractPriorityKind(haystack, input.pageTexts);
  if (contractPriority) {
    return contractPriority;
  }

  /*
   * EINGANG-01D-1 — Gutschrift, Korrektur und Abrechnungsgutschrift vor der
   * Rechnungs-Schnellspur: Sonst würde jede von ihnen zur Eingangsrechnung und
   * damit zu einer neuen Verbindlichkeit. Nach der Vertragspriorität, weil
   * Verträge das Gutschriftsverfahren als Abrechnungsweg nur erwähnen.
   */
  const financeDetection = detectFinanceDocumentKind(input.recognizedText, input.pageTexts?.[0]?.text);
  if (financeDetection) {
    return financeDetection;
  }

  /*
   * EINGANG-02C — ein Schreiben mit sicherem Beschwerdetitel im Kopf
   * („Mängelanzeige", „Beschwerde", „Reklamation", „Auftrag AU-… –
   * Mängelanzeige") ist keine Rechnung und kein Auftrag, auch wenn es eine
   * Rechnungs- oder Auftragsnummer zitiert. Es bleibt bei der neutralen
   * Grundart; die Beschwerde-Bedeutung trägt der semantische Kern. Ein Wort
   * im Fliesstext oder in einer Rechnungsposition genügt nicht.
   */
  /* Nacharbeit 1 — ein Behörden-/Versicherungsbriefkopf (02A-1) behält seine Art. */
  if (isComplaintLetter(input.recognizedText ?? '')) {
    return { kind: 'sonstiges', reasonKey: COMPLAINT_REASON_KEY };
  }

  if (hasStrongInvoiceSignals(haystack)) {
    // Contract docs with LV prices / payment-term prose must not take the invoice fast path.
    const contractDoc =
      hasContractPrioritySignals(haystack, input.pageTexts) && !isInvoiceDocumentTitle(haystack);
    if (!contractDoc) {
      for (const rule of CLASSIFICATION_RULES) {
        if (!INVOICE_FAST_PATH_KINDS.has(rule.kind)) continue;
        if (rule.pattern.test(haystack)) {
          return { kind: rule.kind, reasonKey: rule.reasonKey };
        }
      }
    }
  }

  for (const rule of CLASSIFICATION_RULES) {
    if (shouldSkipInvoiceRule(rule.kind, haystack)) continue;
    if (shouldSkipDeliveryNoteRule(rule.kind, haystack)) continue;
    if (shouldSkipPayrollRule(rule.kind, haystack)) continue;
    if (shouldSkipGenericBriefRule(rule.kind, haystack)) continue;
    if (shouldSkipGenericPruefberichtRule(rule.kind, haystack)) continue;
    if (shouldSkipPaymentRule(rule.kind, haystack)) continue;
    if (shouldSkipGenericPaymentReceiptRule(rule.kind, haystack)) continue;
    if (shouldSkipHealthInsuranceRule(rule.kind, haystack)) continue;
    if (rule.pattern.test(haystack)) {
      return { kind: rule.kind, reasonKey: rule.reasonKey };
    }
  }

  return { kind: 'sonstiges', reasonKey: 'classification.detect.fallback' };
}

export function detectClassifiedKind(input: DocumentClassificationInput): ClassifiedDocumentKind {
  return detectClassifiedKindWithReason(input).kind;
}

export function suggestDigitalFolder(
  kind: ClassifiedDocumentKind,
  context: { customer?: string; vorgangTitle?: string; sender?: string } = {},
): DigitalFolder {
  const spec = buildDigitalFolderSpec(kind, context);
  return {
    id: `dig-${kind}-${Date.now()}`,
    name: spec.name,
    path: spec.path,
  };
}

export { suggestPaperFolder } from './paperFolderService';

export function suggestPaperFolderForKind(
  kind: ClassifiedDocumentKind,
  context: { issuer?: string; linkedVorgangId?: string } = {},
): PaperFilingRule | null {
  return suggestPaperFolder(kind, context);
}

function buildRecognizedData(
  kind: ClassifiedDocumentKind,
  input: DocumentClassificationInput,
): Record<string, string> {
  if (shouldUseEvidenceBasedRecognizedData(kind)) {
    return buildEvidenceBasedRecognizedData({
      classifiedKind: kind,
      recognizedText: input.recognizedText,
      pageTexts: input.pageTexts,
    });
  }

  const base: Record<string, string> = {
    Dokumentart: kind,
  };

  /*
   * EINGANG-01A (P0) — hier standen Beispielwerte (`RE-2026-0001`,
   * `342,16 €`, `85,40 €`, `ca. 5.000 €`, „Sanierungsarbeiten" …), die
   * ohne Beleg im Text in `recognizedData` landeten und von dort bis in echte
   * Ausgaben gelangen konnten. Übrig bleibt nur, was aus der Eingabe selbst
   * stammt (Absenderhinweis) oder aus der Dokumentart folgt. Auch der
   * Dateititel wird nicht mehr als `Vorgang` eingetragen — er ist kein Beleg
   * für einen Vorgang und verstärkte sonst die eigene Vorgangs-Vermutung.
   */
  const fromSender = (key: string): Record<string, string> =>
    input.senderHint?.trim() ? { [key]: input.senderHint.trim() } : {};
  const profiles: Partial<Record<ClassifiedDocumentKind, Record<string, string>>> = {
    eingangsrechnung: fromSender('Lieferant'),
    rechnung: fromSender('Lieferant'),
    auftrag: fromSender('Kunde'),
    aok: {
      Betreff: 'Mitteilung Krankenkasse',
      Krankenkasse: 'AOK',
    },
    krankenkasse: {
      Betreff: 'Mitteilung Krankenkasse',
    },
    kontoauszug: {},
    angebot: fromSender('Kunde'),
    lieferschein: fromSender('Lieferant'),
    stundenzettel: {},
    tankbeleg: fromSender('Tankstelle'),
    abnahmeprotokoll: {
      Status: 'Abnahme',
    },
  };

  return mergeExtractedFields(
    { ...base, ...(profiles[kind] ?? { Betreff: input.titleHint ?? 'Dokument' }) },
    input.recognizedText ? extractFieldsFromText(input.recognizedText) : {},
  );
}

function buildTaskTemplate(
  kind: ClassifiedDocumentKind,
  title: string,
  deadline: string | null,
): InboxTaskTemplate | undefined {
  if (kind === 'sonstiges' || kind === 'foto' || kind === 'baustellenfoto') return undefined;

  const type =
    kind === 'kontoauszug' || kind === 'finanzamt' || kind === 'lohnunterlagen' || kind === 'lohnabrechnung'
      ? 'steuerberater_export'
      : kind === 'brief' || kind === 'schriftverkehr'
        ? 'brief_abheften'
        : 'dokument_pruefen';

  return {
    type,
    title: buildNextTask(kind),
    description: title,
    dueDate: deadline ?? undefined,
  };
}

export function suggestActions(
  kind: ClassifiedDocumentKind,
  item?: Pick<InboxItem, 'isAdvertisement' | 'vorgangLinkStatus'>,
): SuggestedDocumentAction[] {
  if (item?.isAdvertisement) {
    return [
      { id: 'confirm_filing', labelKey: 'classification.action.confirmDispose', variant: 'outline' },
    ];
  }

  const actions = getActionsForKind(kind);

  if (item?.vorgangLinkStatus === 'linked' || item?.vorgangLinkStatus === 'created') {
    return actions.filter((action) => action.id !== 'link_vorgang' && action.id !== 'create_vorgang');
  }

  return actions;
}

export function suggestRelatedVorgang(
  recognizedData: Record<string, string>,
  sender: string,
  title: string,
): SuggestedVorgangLink | null {
  const draftItem: InboxItem = {
    id: 'classification-draft',
    title,
    documentType: 'sonstiges',
    sender,
    priority: 'mittel',
    deadline: null,
    recommendedAction: 'zuordnen',
    digitalFolder: { id: 'dig-temp', name: 'Temp', path: '/' },
    paperFiling: paperFolder('folder-1', 'A'),
    status: 'neu',
    receivedAt: new Date().toISOString().slice(0, 10),
    recognizedData,
    officePilotSuggestion: '',
    nextTaskLabel: '',
    securityHint: '',
    vorgangTitle: recognizedData.Vorgang ?? recognizedData.Leistung ?? title,
  };

  const draft = buildVorgangDraftFromInbox(draftItem, 'betrieb');
  const matches = findSimilarVorgaenge(draft, getAllVorgaenge());
  if (matches.length === 0) return null;

  const best = matches[0];
  const customerNorm = draft.customer.toLowerCase();
  const sameCustomer = best.customer.toLowerCase() === customerNorm;
  const vorgangInData = recognizedData.Vorgang?.toLowerCase() ?? '';
  const titleMatch = vorgangInData && best.title.toLowerCase().includes(vorgangInData);

  let confidence: SuggestedVorgangLink['confidence'] = 'low';
  let reasonKey = 'classification.vorgang.reason.similar';

  if (titleMatch || (sameCustomer && draft.baustelle && best.baustelle === draft.baustelle)) {
    confidence = 'high';
    reasonKey = 'classification.vorgang.reason.explicit';
  } else if (sameCustomer) {
    confidence = 'medium';
    reasonKey = 'classification.vorgang.reason.customer';
  }

  return {
    vorgangId: best.id,
    vorgangTitle: best.title,
    customer: best.customer,
    confidence,
    reasonKey,
  };
}

/**
 * EINGANG-01A (P0) — die eine Handlungsfrist eines Eingangs, immer
 * `JJJJ-MM-TT` oder `null`.
 *
 * Vorrang hat die semantische Handlungsfrist (`primaryActionDeadline`): Sie
 * weiß, ob wir handeln müssen. Sonst gilt das erkannte Feld (`Frist` /
 * `Fälligkeit`), aber nur eindeutig lesbar — und nicht, wenn der Kern genau
 * dieses Datum als Gültigkeitsende erkannt hat. Ein vom Kern nur als
 * „informational" (unsicher) gelesenes Datum sperrt das Feld nicht: Das hieße
 * nicht „keine Handlung", sondern „nicht verstanden".
 */
/**
 * EINGANG-01D-1 Nacharbeit 3 — die Frist einer Gutschrift gehört der Gutschrift.
 *
 * Eine Gutschrift fordert keine Zahlung; ein „Zahlbar bis" stammt bei ihr aus
 * einer angehängten oder zitierten Originalrechnung und würde sonst zur
 * Handlungsfrist (und zur fälligen Aufgabe) der Gutschrift. Deshalb:
 *   - mit echten Seitentexten nur Seite 1 (das Hauptdokument) lesen;
 *   - `payment_due` nie übernehmen — ohne Seitengrenzen fail closed;
 *   - kein Rückfall auf das erkannte Feld `Frist`, dessen Art und Herkunft
 *     ungesichert sind.
 * Andere echte Handlungsfristen der Gutschrift (Antwort, Unterlagen …) bleiben.
 */
export function resolveCreditNoteActionDeadline(
  input: DocumentClassificationInput,
): { deadline: string | null; deadlineType?: BusinessDeadlineType } {
  const firstPage = input.pageTexts?.[0]?.text?.trim();
  const text = firstPage || input.recognizedText?.trim() || '';
  if (!text) return { deadline: null };
  const core = buildDocumentSemanticCore({ text, companyProfile: null });
  const candidates = [core.primaryActionDeadline, ...core.deadlines].filter(
    (frist): frist is NonNullable<typeof frist> => Boolean(frist),
  );
  for (const frist of candidates) {
    const type = asActionDeadlineType(frist.type);
    const day = toCanonicalIsoDay(frist.date);
    if (type && type !== 'payment_due' && day) return { deadline: day, deadlineType: type };
  }
  return { deadline: null };
}

function resolveCanonicalActionDeadline(
  input: DocumentClassificationInput,
  recognizedData: Record<string, string>,
  classifiedKind?: ClassifiedDocumentKind,
): { deadline: string | null; deadlineType?: BusinessDeadlineType } {
  if (classifiedKind === 'gutschrift') return resolveCreditNoteActionDeadline(input);
  const text = input.recognizedText?.trim() ?? '';
  const core = text ? buildDocumentSemanticCore({ text, companyProfile: null }) : null;
  const semantic = toCanonicalIsoDay(core?.primaryActionDeadline?.date);
  if (semantic) {
    // EINGANG-01D-1 — die Art reist mit, aber nur eine echte Handlungsfrist-Art.
    return { deadline: semantic, deadlineType: asActionDeadlineType(core?.primaryActionDeadline?.type) };
  }
  const field = toCanonicalIsoDay(recognizedData.Frist) ?? toCanonicalIsoDay(recognizedData.Fälligkeit);
  if (!field) return { deadline: null };
  /*
   * EINGANG-02C — ein eigenes Schreiben (eigener Briefkopf) setzt dem
   * Empfänger Fristen, nicht uns; ebenso ist die Zusage der Gegenseite
   * („Wir melden uns bis …") keine eigene Frist. Das Feld darf sie nicht
   * wieder zur Handlungsfrist machen.
   */
  if (core?.complaint?.direction === 'outgoing') return { deadline: null };
  const sameDay = core?.deadlines.filter((frist) => toCanonicalIsoDay(frist.date) === field) ?? [];
  if (sameDay.length > 0 && sameDay.every((frist) => !frist.actionRequired && frist.appliesTo === 'Zusage der Gegenseite')) {
    return { deadline: null };
  }
  const isValidityEnd = sameDay.some((frist) => frist.type === 'validity_period_end');
  if (isValidityEnd) return { deadline: null };
  /*
   * EINGANG-01D-1 — aus dem Feld allein ist die Art nicht sicher. Nur wenn der
   * Kern genau diesen Tag eindeutig einer Handlungsfrist-Art zuordnet, wird sie
   * übernommen; sonst bleibt sie offen.
   */
  const types = [...new Set(sameDay.map((frist) => asActionDeadlineType(frist.type)).filter(Boolean))];
  return { deadline: field, deadlineType: types.length === 1 ? types[0] : undefined };
}

/**
 * EINGANG-02A-3 — ein institutionelles Schreiben mit sicher abgegrenzter
 * Fremdanlage wird nur auf seinen Hauptseiten klassifiziert; Rechnungs- oder
 * Angebotssignale der Anlage bestimmen weder Art noch Felder. Ohne Seiten oder
 * ohne sichere Anlage bleibt die Eingabe unverändert.
 */
function projectClassificationInputToMainDocument(input: DocumentClassificationInput): DocumentClassificationInput {
  const pages = input.pageTexts?.map((page) => page.text ?? '');
  const scope = resolveMainDocumentPageScope(pages);
  const mainText = mainDocumentTextFromPages(pages, scope);
  if (!scope || !mainText) return input;
  const haupt = new Set(scope.mainPageNumbers);
  return {
    ...input,
    recognizedText: mainText,
    pageTexts: input.pageTexts?.filter((_, index) => haupt.has(index + 1)),
  };
}

/*
 * EINGANG-02A-3 — Belegarten, die ein institutionelles Hauptschreiben nur
 * erwähnt („Anbei erhalten Sie die Werkstattrechnung zur Kenntnis"), während
 * der Beleg selbst als Fremdanlage abgegrenzt ist.
 */
const ATTACHMENT_MENTION_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'eingangsrechnung',
  'rechnung',
  'reparaturrechnung',
  'angebot',
  'auftragsbestaetigung',
  'lieferschein',
]);

/**
 * Ist eine Fremdanlage abgegrenzt und trägt das Hauptschreiben selbst keinen
 * Belegtitel, gilt der institutionelle Briefkopf — wie der 02A-1-Schutz für
 * erwähnte Verträge, nur für diesen einen Fall.
 */
function guardInstitutionalAttachmentMention(
  input: DocumentClassificationInput,
  scoped: boolean,
  detection: DetectionResult,
): DetectionResult {
  if (!scoped || detection.reasonKey === 'classification.detect.uploadHint') return detection;
  if (!ATTACHMENT_MENTION_KINDS.has(detection.kind)) return detection;
  if (hasOwnDocumentTitle(input.recognizedText ?? '', detection.kind)) return detection;
  return detectInstitutionalLetterheadKind(input) ?? detection;
}

export function classifyDocument(rawInput: DocumentClassificationInput): DocumentClassificationResult {
  const input = projectClassificationInputToMainDocument(rawInput);
  const scoped = input !== rawInput;
  const legacyDetection = guardInstitutionalAttachmentMention(input, scoped, detectClassifiedKindWithReason(input));
  const hybridContext = resolveHybridClassification(input, legacyDetection);
  /*
   * EINGANG-01D-1 — eine am Belegkopf erkannte Gutschrift, Korrektur oder
   * Abrechnungsgutschrift darf keine Schnellspur mehr zur Eingangsrechnung
   * machen. Die Regel-Entscheidung gilt dann auch nach dem Hybrid-Abgleich.
   */
  const financeDecided =
    legacyDetection.reasonKey === CREDIT_NOTE_REASON_KEY ||
    /* EINGANG-02C — der Beschwerdetitel entscheidet wie ein Belegkopf. */
    legacyDetection.reasonKey === COMPLAINT_REASON_KEY ||
    Boolean(financeReviewReasonFromDetection(legacyDetection.reasonKey));
  const detection = guardInstitutionalAttachmentMention(
    input,
    scoped,
    financeDecided ? legacyDetection : hybridContext.resolution.detection,
  );
  const financeReviewReason = financeReviewReasonFromDetection(detection.reasonKey);
  const documentProfile = hybridContext.documentProfile;
  const classifiedKind = detection.kind;
  const needsKindReview =
    Boolean(financeReviewReason) ||
    Boolean(documentProfile?.needsKindReview) ||
    detection.reasonKey === 'classification.detect.kindReviewRequired';
  const isAdvertisement = looksLikeAdvertisement(input);

  const extractedData = buildRecognizedData(classifiedKind, input);
  const profileSender = documentProfile?.senderEntity?.trim();
  const extractedSender =
    input.senderHint ??
    profileSender ??
    extractedData.Absender ??
    extractedData.Lieferant ??
    extractedData.Kunde ??
    extractedData.Krankenkasse ??
    extractedData.Aussteller ??
    UNKNOWN_SENDER_CANONICAL;
  /*
   * EINGANG-02A-1 — ein Behörden- oder Versicherungsschreiben hat nie die
   * eigene Firma aus dem Empfängerblock als Absender. Absender, Absender-Feld
   * und Profil-Absender werden gemeinsam korrigiert, damit jede Anzeige
   * dieselbe Wahrheit liest.
   */
  const institutionalSender = resolveInstitutionalSenderTruth({
    classifiedKind,
    recognizedText: input.recognizedText,
    senderHint: input.senderHint,
    sender: extractedSender,
    recognizedData: extractedData,
    senderEntity: profileSender,
    ownCompanyName: getCompanyProfile().companyName,
    unknownSender: UNKNOWN_SENDER_CANONICAL,
  });
  const recognizedData = institutionalSender?.recognizedData ?? extractedData;
  const sender = institutionalSender?.sender ?? extractedSender;
  const resolvedDocumentProfile =
    institutionalSender && documentProfile
      ? { ...documentProfile, senderEntity: institutionalSender.senderEntity }
      : documentProfile;

  const title =
    input.titleHint ??
    (financeReviewReason
      ? `${FINANCE_REVIEW_TITLE[financeReviewReason]} – ${sender}`
      : needsKindReview
        ? `Dokument – ${sender}`
        : `${classifiedKind.charAt(0).toUpperCase()}${classifiedKind.slice(1).replace(/_/g, ' ')} – ${sender}`);

  const suggestedVorgangRaw = suggestRelatedVorgang(recognizedData, sender, title);
  const digitalFolder = suggestDigitalFolder(classifiedKind, {
    customer: recognizedData.Kunde ?? sender,
    vorgangTitle: recognizedData.Vorgang ?? suggestedVorgangRaw?.vorgangTitle,
    sender,
  });
  const paperResolution = resolvePaperFiling({
    classifiedKind,
    isAdvertisement,
    issuer: sender,
    sender,
  });
  const paperFiling =
    paperResolution.rule ??
    ({ folderId: '', register: '—', label: 'Entsorgen' } satisfies PaperFilingRule);
  const { deadline, deadlineType } = resolveCanonicalActionDeadline(input, recognizedData, classifiedKind);

  const explanation = financeReviewReason
    ? `${FINANCE_REVIEW_EXPLANATION[financeReviewReason]} Absender: „${sender}“.`
    : needsKindReview
      ? `Dokumentart bitte prüfen. Mehrere Dokumentarten möglich. Absender: „${sender}“.`
      : buildExplanation(classifiedKind, sender);
  const priority = isAdvertisement
    ? 'niedrig'
    : needsKindReview
      ? 'mittel'
      : defaultPriority(classifiedKind);
  const recommendedAction = isAdvertisement
    ? 'entsorgen'
    : needsKindReview
      ? 'klaeren'
      : defaultRecommendedAction(classifiedKind);
  const primaryTargetObject = resolvePrimaryTargetObjectForKind(classifiedKind);
  const processType = isAdvertisement
    ? 'archive_only'
    : needsKindReview
      ? 'review_required'
      : suggestProcessType(classifiedKind, primaryTargetObject);

  // EINGANG-01D-1 — ein Finanz-Prüffall schlägt keine Rechnungsart zur Übernahme vor.
  const suggestedKinds = financeReviewReason
    ? []
    : (documentProfile?.topCandidates ?? [])
        .map((candidate) => candidate.kind)
        .filter((kind, index, all) => all.indexOf(kind) === index)
        .slice(0, 2);

  const result: DocumentClassificationResult = {
    classifiedKind,
    documentType: mapKindToDocumentType(classifiedKind),
    processType,
    detectionReasonKey: detection.reasonKey,
    title,
    sender,
    explanation,
    priority,
    deadline,
    ...(deadline && deadlineType ? { deadlineType } : {}),
    ...(financeReviewReason ? { financeReviewReason } : {}),
    recommendedAction,
    digitalFolder,
    paperFiling,
    recognizedData,
    officePilotSuggestion: explanation,
    nextTaskLabel: isAdvertisement
      ? 'Keine Aufgabe nötig'
      : financeReviewReason
        ? FINANCE_REVIEW_NEXT_TASK[financeReviewReason]
        : needsKindReview
          ? 'Dokumentart bitte prüfen'
          : buildNextTask(classifiedKind),
    securityHint: SECURITY_DEFAULT,
    taskTemplate: isAdvertisement || needsKindReview
      ? undefined
      : buildTaskTemplate(classifiedKind, title, deadline),
    isAdvertisement,
    suggestedVorgang: suggestedVorgangRaw ?? undefined,
    actions: needsKindReview
      ? [
          {
            id: 'confirm_filing',
            labelKey: 'classification.action.confirmFiling',
            variant: 'primary',
          },
        ]
      : suggestActions(classifiedKind, { isAdvertisement }),
    documentProfile: resolvedDocumentProfile ?? undefined,
    needsKindReview: needsKindReview || undefined,
    suggestedKinds: suggestedKinds.length > 0 ? suggestedKinds : undefined,
  };

  /*
   * EINGANG-01A (P1) — der vermutete Vorgangstitel wird nicht mehr in
   * `recognizedData.Vorgang` geschrieben. Er war eine Vermutung und stand
   * danach wie ein erkannter Wert da; beim nächsten Lauf lieferte er selbst den
   * „Titeltreffer" für dieselbe Vermutung. Der Vorschlag bleibt in
   * `suggestedVorgang` — als Vorschlag.
   */

  runLegacyDocumentAnalysisShadow(result, input, {
    legacyDetection,
    hybridContext,
  });

  return result;
}

function buildRecognizedTextFromItem(item: InboxItem): string {
  return getInboxExtractedDocumentText(item);
}

export function getClassifiedKindFromItem(item: InboxItem): ClassifiedDocumentKind {
  if (item.classifiedKind) return item.classifiedKind;

  if (item.recognizedData.Dokumentart && isKnownClassifiedKind(item.recognizedData.Dokumentart)) {
    return item.recognizedData.Dokumentart;
  }

  return detectClassifiedKind({
    sourceFileName: item.sourceFileName,
    titleHint: item.title,
    senderHint: item.sender,
    recognizedText: buildRecognizedTextFromItem(item),
  });
}

export function buildInboxItemFromClassification(
  classification: DocumentClassificationResult,
  options: { sourceFileName?: string; prefixTitle?: boolean } = {},
): Omit<InboxItem, 'id' | 'status' | 'receivedAt'> {
  const title = options.prefixTitle
    ? `Gerade erfasst: ${classification.title}`
    : classification.title;

  return {
    title,
    documentType: classification.documentType,
    classifiedKind: classification.classifiedKind,
    sender: classification.sender,
    priority: classification.priority,
    deadline: classification.deadline,
    // EINGANG-01D-1 — Fristart und Finanz-Prüfhinweis reisen nur mit, wenn belegt.
    ...(classification.deadline && classification.deadlineType ? { deadlineType: classification.deadlineType } : {}),
    ...(classification.financeReviewReason ? { financeReviewReason: classification.financeReviewReason } : {}),
    recommendedAction: classification.recommendedAction,
    digitalFolder: { ...classification.digitalFolder },
    paperFiling: { ...classification.paperFiling },
    recognizedData: { ...classification.recognizedData },
    officePilotSuggestion: classification.explanation,
    nextTaskLabel: classification.nextTaskLabel,
    securityHint: classification.securityHint,
    taskTemplate: classification.taskTemplate ? { ...classification.taskTemplate } : undefined,
    isAdvertisement: classification.isAdvertisement,
    sourceFileName: options.sourceFileName,
    vorgangId: undefined,
    vorgangTitle: undefined,
  };
}

export function classifyInboxItem(input: DocumentClassificationInput): InboxItem {
  const classification = classifyDocument(input);
  const receivedAt = new Date().toISOString().slice(0, 10);
  const timestamp = Date.now();
  const base = buildInboxItemFromClassification(classification, {
    sourceFileName: input.sourceFileName,
    prefixTitle: true,
  });

  return {
    ...base,
    id: `inbox-upload-${timestamp}`,
    status: 'neu',
    receivedAt,
    isNewUpload: true,
    digitalFolder: {
      ...base.digitalFolder,
      id: `dig-upload-${timestamp}`,
    },
  };
}

/**
 * EINGANG-01A (P1) — nur der ausdrücklich am Eingang gesetzte Vorgang
 * (`vorgangId` + Titel, vom Nutzer gewählt), ohne jede Ähnlichkeitssuche.
 */
export function getExplicitVorgangForItem(item: InboxItem): SuggestedVorgangLink | null {
  if (item.vorgangLinkStatus === 'linked' || item.vorgangLinkStatus === 'created') {
    return null;
  }

  if (item.vorgangId && item.vorgangTitle) {
    const vorgang = getVorgangById(item.vorgangId);
    if (vorgang) {
      return {
        vorgangId: vorgang.id,
        vorgangTitle: vorgang.title,
        customer: vorgang.customer,
        confidence: 'high',
        reasonKey: 'classification.vorgang.reason.explicit',
        basis: 'stored',
      };
    }
  }
  return null;
}

export function getSuggestedVorgangForItem(item: InboxItem): SuggestedVorgangLink | null {
  if (item.vorgangLinkStatus === 'linked' || item.vorgangLinkStatus === 'created') {
    return null;
  }

  if (item.vorgangId && item.vorgangTitle) {
    const vorgang = getVorgangById(item.vorgangId);
    if (vorgang) {
      return {
        vorgangId: vorgang.id,
        vorgangTitle: vorgang.title,
        customer: vorgang.customer,
        confidence: 'high',
        reasonKey: 'classification.vorgang.reason.explicit',
      };
    }
  }

  return suggestRelatedVorgang(item.recognizedData, item.sender, item.title);
}

function parsePageTextsFromItem(item: InboxItem): DocumentClassificationInput['pageTexts'] {
  const raw = item.recognizedData._pageTexts;
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as DocumentClassificationInput['pageTexts'];
  } catch {
    return undefined;
  }
}

export function getClassificationForItem(item: InboxItem): DocumentClassificationResult {
  const dokumentart = item.recognizedData.Dokumentart;
  const kindFromData = dokumentart && isKnownClassifiedKind(dokumentart) ? dokumentart : undefined;

  const reclassified = classifyDocument({
    sourceFileName: item.sourceFileName,
    titleHint: item.title,
    senderHint: item.sender,
    recognizedText: buildRecognizedTextFromItem(item),
    kindHint: item.classifiedKind ?? kindFromData,
    pageTexts: parsePageTextsFromItem(item),
  });

  const result: DocumentClassificationResult = {
    ...reclassified,
    title: item.title,
    sender: item.sender,
    priority: item.priority,
    deadline: item.deadline,
    deadlineType: item.deadline ? item.deadlineType : undefined,
    financeReviewReason: item.financeReviewReason,
    digitalFolder: item.digitalFolder,
    paperFiling: item.paperFiling,
    recognizedData: item.recognizedData,
    officePilotSuggestion: item.officePilotSuggestion || reclassified.explanation,
    nextTaskLabel: item.nextTaskLabel || reclassified.nextTaskLabel,
    suggestedVorgang: getSuggestedVorgangForItem(item) ?? reclassified.suggestedVorgang,
    actions: suggestActions(reclassified.classifiedKind, item),
  };
  /*
   * EINGANG-01D-1 — der gespeicherte Prüfhinweis gilt weiter: Die erneute
   * Klassifikation läuft mit der gespeicherten Art als Hinweis und sähe ihn
   * sonst nicht. Ein Prüffall bleibt ein Prüffall — ohne Aufgabe, ohne Buchung.
   */
  if (item.financeReviewReason) {
    return {
      ...result,
      needsKindReview: true,
      recommendedAction: 'klaeren',
      processType: 'review_required',
      taskTemplate: undefined,
      suggestedKinds: undefined,
      actions: [{ id: 'confirm_filing', labelKey: 'classification.action.confirmFiling', variant: 'primary' }],
    };
  }
  return result;
}
