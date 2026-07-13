import { PAPER_FOLDERS } from '../data/mockData';
import { getPaperFolderById } from './paperFolderService';
import { buildVorgangDraftFromInbox, findSimilarVorgaenge } from './vorgangMatchingService';
import { getAllVorgaenge, getVorgangById } from './vorgangService';
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
import { resolvePaperFiling, suggestPaperFolder } from './paperFolderService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import { extractFieldsFromText, mergeExtractedFields } from './documentFieldExtractionService';
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

const CONTRACT_PAYMENT_TERMS = /schlussrechnung|abschlagsrechnung|teilrechnung/i;

function hasStrongInvoiceSignals(haystack: string): boolean {
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

function detectContractPriorityKind(
  haystack: string,
  pageTexts?: DocumentClassificationInput['pageTexts'],
): DetectionResult | null {
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
  if (/eingangsrechnung|ausgangsrechnung|rechnungsnummer|materialrechnung|hotelrechnung|gutschrift/i.test(haystack)) {
    return false;
  }
  if (CONTRACT_PAYMENT_TERMS.test(haystack) && hasContractPrioritySignals(haystack)) return true;
  if (kind === 'rechnung' && /werkvertrag|leistungsverzeichnis|auftraggeber/i.test(haystack)) return true;
  return !hasStrongInvoiceSignals(haystack);
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
    for (const rule of CLASSIFICATION_RULES) {
      if (!INVOICE_KINDS.has(rule.kind)) continue;
      if (rule.pattern.test(haystack)) {
        return { kind: rule.kind, reasonKey: rule.reasonKey };
      }
    }
  }

  for (const rule of CLASSIFICATION_RULES) {
    if (shouldSkipInvoiceRule(rule.kind, haystack)) continue;
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
    mahnung: {
      Rechnungsnummer: 'BZ-2026-8842',
      Betrag: '1.247,80 €',
      Fälligkeit: '30.03.2026',
      Hinweis: 'Mahnung',
    },
    zahlungserinnerung: {
      Rechnungsnummer: 'BZ-2026-8842',
      Betrag: '1.247,80 €',
      Fälligkeit: '30.03.2026',
      Hinweis: 'Zahlungserinnerung',
    },
    werkvertrag: {
      Kunde: input.senderHint ?? 'Unbekannt',
      Vertragsart: 'Werkvertrag',
      Baustelle: 'Baustelle laut Vertrag',
    },
    auftrag: {
      Kunde: input.senderHint ?? 'Unbekannt',
      Leistung: 'Sanierungsarbeiten',
      Baustelle: 'Baustelle laut Auftrag',
    },
    bg_bau: {
      Betreff: 'Beitragsbescheid',
      Frist: '10.04.2026',
      Ansprechpartner: 'BG BAU Service',
    },
    finanzamt: {
      Betreff: 'Steuerschreiben',
      Frist: '10.04.2026',
    },
    aok: {
      Betreff: 'Mitteilung Krankenkasse',
      Krankenkasse: 'AOK',
    },
    krankenkasse: {
      Betreff: 'Mitteilung Krankenkasse',
    },
    freistellungsbescheinigung: {
      Betreff: 'Freistellungsbescheinigung §48b',
      Gültig_bis: '31.12.2026',
    },
    unbedenklichkeitsbescheinigung: {
      Betreff: 'Unbedenklichkeitsbescheinigung',
      Aussteller: input.senderHint ?? 'BG BAU',
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
  const detection = detectClassifiedKindWithReason(input);
  const classifiedKind = detection.kind;
  const isAdvertisement =
    input.kindHint === 'werbung' ||
    /werbung|reklame|prospekt|aktionsmail|newsletter/.test(buildHaystack(input));

  const recognizedData = buildRecognizedData(classifiedKind, input);
  const sender =
    input.senderHint ??
    recognizedData.Lieferant ??
    recognizedData.Kunde ??
    recognizedData.Krankenkasse ??
    'Unbekannter Absender';

  const title =
    input.titleHint ??
    `${classifiedKind.charAt(0).toUpperCase()}${classifiedKind.slice(1).replace(/_/g, ' ')} – ${sender}`;

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
  const deadline =
    recognizedData.Frist ??
    recognizedData.Fälligkeit ??
    (classifiedKind === 'mahnung' || classifiedKind === 'zahlungserinnerung' ? '2026-03-30' : null);

  const explanation = buildExplanation(classifiedKind, sender);
  const priority = isAdvertisement ? 'niedrig' : defaultPriority(classifiedKind);
  const recommendedAction = isAdvertisement ? 'entsorgen' : defaultRecommendedAction(classifiedKind);
  const processType = isAdvertisement ? 'archive_only' : suggestProcessType(classifiedKind);

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
    nextTaskLabel: isAdvertisement ? 'Keine Aufgabe nötig' : buildNextTask(classifiedKind),
    securityHint: SECURITY_DEFAULT,
    taskTemplate: isAdvertisement ? undefined : buildTaskTemplate(classifiedKind, title, deadline),
    isAdvertisement,
    suggestedVorgang: suggestedVorgangRaw ?? undefined,
    actions: suggestActions(classifiedKind, { isAdvertisement }),
  };

  if (
    suggestedVorgangRaw &&
    ['eingangsrechnung', 'rechnung', 'lieferschein', 'mahnung', 'zahlungserinnerung'].includes(classifiedKind)
  ) {
    result.recognizedData.Vorgang = suggestedVorgangRaw.vorgangTitle;
  }

  return result;
}

function buildRecognizedTextFromItem(item: InboxItem): string {
  const extracted = getInboxExtractedDocumentText(item);
  const visible = Object.entries(item.recognizedData)
    .filter(([key]) => !key.startsWith('_'))
    .map(([, value]) => value)
    .join(' ');
  return [extracted, visible].filter(Boolean).join('\n');
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
    vorgangId: classification.suggestedVorgang?.vorgangId,
    vorgangTitle: classification.suggestedVorgang?.vorgangTitle,
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
