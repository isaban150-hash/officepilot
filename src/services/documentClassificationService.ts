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
import {
  buildEvidenceBasedRecognizedData,
  shouldUseEvidenceBasedRecognizedData,
} from './documentRecognizedDataService';
import type {
  ClassifiedDocumentKind,
  DigitalFolder,
  DocumentClassificationInput,
  DocumentClassificationResult,
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

function hasStrongInvoiceSignals(haystack: string): boolean {
  if (/mahnung|zahlungserinnerung|inkasso/.test(haystack)) {
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

export function detectClassifiedKindWithReason(input: DocumentClassificationInput): DetectionResult {
  const fromHint = resolveKindFromHint(input.kindHint);
  if (fromHint && input.kindHint !== 'werbung') {
    return { kind: fromHint, reasonKey: 'classification.detect.uploadHint' };
  }

  const haystack = buildHaystack(input);

  if (input.kindHint === 'werbung' || /werbung|reklame|prospekt|newsletter|aktionsmail/.test(haystack)) {
    return { kind: 'sonstiges', reasonKey: 'classification.detect.advertisement' };
  }

  const contractPriority = detectContractPriorityKind(haystack, input.pageTexts);
  if (contractPriority) {
    return contractPriority;
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

  const profiles: Partial<Record<ClassifiedDocumentKind, Record<string, string>>> = {
    eingangsrechnung: {
      Rechnungsnummer: 'RE-2026-0001',
      Betrag: '342,16 €',
      Lieferant: input.senderHint ?? 'Unbekannt',
    },
    rechnung: {
      Rechnungsnummer: 'RE-2026-0001',
      Betrag: '342,16 €',
      Lieferant: input.senderHint ?? 'Unbekannt',
    },
    auftrag: {
      Kunde: input.senderHint ?? 'Unbekannt',
      Leistung: 'Sanierungsarbeiten',
      Baustelle: 'Baustelle laut Auftrag',
    },
    aok: {
      Betreff: 'Mitteilung Krankenkasse',
      Krankenkasse: 'AOK',
    },
    krankenkasse: {
      Betreff: 'Mitteilung Krankenkasse',
    },
    kontoauszug: {
      Zeitraum: `${new Date().getFullYear()}`,
      Konto: 'Geschäftskonto',
    },
    angebot: {
      Kunde: input.senderHint ?? 'Interessent',
      Angebotssumme: 'ca. 5.000 €',
    },
    lieferschein: {
      Lieferant: input.senderHint ?? 'Lieferant',
      Vorgang: input.titleHint ?? '',
    },
    stundenzettel: {
      Zeitraum: `${new Date().getFullYear()}`,
      Mitarbeiter: 'Mitarbeiter',
    },
    tankbeleg: {
      Betrag: '85,40 €',
      Tankstelle: input.senderHint ?? 'Tankstelle',
    },
    abnahmeprotokoll: {
      Vorgang: input.titleHint ?? '',
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

export function classifyDocument(input: DocumentClassificationInput): DocumentClassificationResult {
  const legacyDetection = detectClassifiedKindWithReason(input);
  const hybridContext = resolveHybridClassification(input, legacyDetection);
  const { detection } = hybridContext.resolution;
  const documentProfile = hybridContext.documentProfile;
  const classifiedKind = detection.kind;
  const needsKindReview =
    Boolean(documentProfile?.needsKindReview) ||
    detection.reasonKey === 'classification.detect.kindReviewRequired';
  const isAdvertisement =
    input.kindHint === 'werbung' ||
    /werbung|reklame|prospekt|aktionsmail|newsletter/.test(buildHaystack(input));

  const recognizedData = buildRecognizedData(classifiedKind, input);
  const profileSender = documentProfile?.senderEntity?.trim();
  const sender =
    input.senderHint ??
    profileSender ??
    recognizedData.Absender ??
    recognizedData.Lieferant ??
    recognizedData.Kunde ??
    recognizedData.Krankenkasse ??
    recognizedData.Aussteller ??
    UNKNOWN_SENDER_CANONICAL;

  const title =
    input.titleHint ??
    (needsKindReview
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
  const deadline = recognizedData.Frist ?? recognizedData.Fälligkeit ?? null;

  const explanation = needsKindReview
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

  const suggestedKinds = (documentProfile?.topCandidates ?? [])
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
    recommendedAction,
    digitalFolder,
    paperFiling,
    recognizedData,
    officePilotSuggestion: explanation,
    nextTaskLabel: isAdvertisement
      ? 'Keine Aufgabe nötig'
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
    documentProfile: documentProfile ?? undefined,
    needsKindReview: needsKindReview || undefined,
    suggestedKinds: suggestedKinds.length > 0 ? suggestedKinds : undefined,
  };

  if (
    suggestedVorgangRaw &&
    ['eingangsrechnung', 'rechnung', 'lieferschein', 'mahnung', 'zahlungserinnerung'].includes(classifiedKind)
  ) {
    result.recognizedData.Vorgang = suggestedVorgangRaw.vorgangTitle;
  }

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

  return {
    ...reclassified,
    title: item.title,
    sender: item.sender,
    priority: item.priority,
    deadline: item.deadline,
    digitalFolder: item.digitalFolder,
    paperFiling: item.paperFiling,
    recognizedData: item.recognizedData,
    officePilotSuggestion: item.officePilotSuggestion || reclassified.explanation,
    nextTaskLabel: item.nextTaskLabel || reclassified.nextTaskLabel,
    suggestedVorgang: getSuggestedVorgangForItem(item) ?? reclassified.suggestedVorgang,
    actions: suggestActions(reclassified.classifiedKind, item),
  };
}
