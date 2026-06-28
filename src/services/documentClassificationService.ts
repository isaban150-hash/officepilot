import { PAPER_FOLDERS } from '../data/mockData';
import { getPaperFolderById } from './analysisService';
import { buildVorgangDraftFromInbox, findSimilarVorgaenge, getVorgangById } from './vorgangService';
import type {
  ClassifiedDocumentKind,
  DigitalFolder,
  DocumentClassificationInput,
  DocumentClassificationResult,
  DocumentType,
  InboxItem,
  InboxPriority,
  InboxTaskTemplate,
  PaperFilingRule,
  RecommendedAction,
  SuggestedDocumentAction,
  SuggestedVorgangLink,
  UploadDocumentKind,
} from '../types/models';

const UPLOAD_KIND_MAP: Record<UploadDocumentKind, ClassifiedDocumentKind> = {
  auftrag: 'auftrag',
  zahlungserinnerung: 'mahnung',
  materialrechnung: 'rechnung',
  bg_bau: 'bg_bau',
  werbung: 'sonstiges',
  kontoauszug: 'kontoauszug',
};

const DOCUMENT_TYPE_MAP: Record<ClassifiedDocumentKind, DocumentType> = {
  rechnung: 'eingangsrechnung',
  mahnung: 'eingangsrechnung',
  lieferschein: 'sonstiges',
  auftrag: 'kundenauftrag',
  angebot: 'kundenauftrag',
  bg_bau: 'behoerde',
  finanzamt: 'behoerde',
  aok: 'behoerde',
  krankenkasse: 'behoerde',
  berufsgenossenschaft: 'behoerde',
  versicherung: 'behoerde',
  gewerbeanmeldung: 'behoerde',
  freistellungsbescheinigung: 'behoerde',
  unbedenklichkeitsbescheinigung: 'behoerde',
  soka_bau: 'behoerde',
  handelsregister: 'behoerde',
  lohnunterlagen: 'sonstiges',
  kontoauszug: 'sonstiges',
  pruefprotokoll: 'sonstiges',
  brief: 'brief',
  foto: 'foto',
  sonstiges: 'sonstiges',
};

interface KindRule {
  kind: ClassifiedDocumentKind;
  pattern: RegExp;
}

const CLASSIFICATION_RULES: KindRule[] = [
  { kind: 'mahnung', pattern: /mahnung|zahlungserinnerung|zahlungsaufforderung|inkasso/ },
  { kind: 'freistellungsbescheinigung', pattern: /freistellungsbescheinigung|§48b|§48 b/ },
  { kind: 'unbedenklichkeitsbescheinigung', pattern: /unbedenklichkeitsbescheinigung|unbedenklichkeit/ },
  { kind: 'bg_bau', pattern: /bg[\s-]?bau|berufsgenossenschaft der bauwirtschaft/ },
  { kind: 'berufsgenossenschaft', pattern: /berufsgenossenschaft/ },
  { kind: 'soka_bau', pattern: /soka[\s-]?bau/ },
  { kind: 'aok', pattern: /\baok\b/ },
  { kind: 'krankenkasse', pattern: /krankenkasse|barmer|techniker[\s-]?kranken|dak[\s-]?gesundheit|ikk/ },
  { kind: 'finanzamt', pattern: /finanzamt|steuerbescheid|umsatzsteuer|lohnsteuer|steuernummer/ },
  { kind: 'gewerbeanmeldung', pattern: /gewerbeanmeldung|gewerbeamt|gewerbeanzeige/ },
  { kind: 'handelsregister', pattern: /handelsregister|hrb|hr a|amtsgericht.*register/ },
  { kind: 'lohnunterlagen', pattern: /lohnabrechnung|lohnunterlagen|gehaltsabrechnung|entgeltabrechnung/ },
  { kind: 'kontoauszug', pattern: /kontoauszug|kontoumsätze|kontobewegungen|sparkasse|volksbank|commerzbank/ },
  { kind: 'auftrag', pattern: /kundenauftrag|auftragsbestätigung|auftrag erteilt|auftragserteilung/ },
  { kind: 'angebot', pattern: /angebot|kostenvoranschlag|offerte/ },
  { kind: 'lieferschein', pattern: /lieferschein|wareneingang|lieferung/ },
  { kind: 'pruefprotokoll', pattern: /prüfprotokoll|pruefprotokoll|abnahmeprotokoll|prüfbericht/ },
  { kind: 'rechnung', pattern: /rechnung|invoice|rechnungsnummer|materialrechnung/ },
  { kind: 'versicherung', pattern: /versicherung|haftpflicht|allianz|policy|versicherungsschreiben/ },
  { kind: 'foto', pattern: /\.(jpg|jpeg|png|heic|webp)$/ },
  { kind: 'brief', pattern: /brief|schreiben|mitteilung|einladung/ },
];

const SECURITY_DEFAULT =
  'OfficePilot trifft keine endgültigen Entscheidungen und versendet nichts ohne Ihre Bestätigung.';

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
  return kindHint as ClassifiedDocumentKind;
}

export function detectClassifiedKind(input: DocumentClassificationInput): ClassifiedDocumentKind {
  const fromHint = resolveKindFromHint(input.kindHint);
  if (fromHint && input.kindHint !== 'werbung') {
    return fromHint;
  }

  const haystack = buildHaystack(input);

  if (input.kindHint === 'werbung' || /werbung|reklame|prospekt|newsletter|aktionsmail/.test(haystack)) {
    return 'sonstiges';
  }

  for (const rule of CLASSIFICATION_RULES) {
    if (rule.pattern.test(haystack)) {
      return rule.kind;
    }
  }

  return 'sonstiges';
}

export function mapKindToDocumentType(kind: ClassifiedDocumentKind): DocumentType {
  return DOCUMENT_TYPE_MAP[kind];
}

export function suggestDigitalFolder(
  kind: ClassifiedDocumentKind,
  context: { customer?: string; vorgangTitle?: string; sender?: string } = {},
): DigitalFolder {
  const year = new Date().getFullYear();
  const customerSlug = (context.customer ?? context.sender ?? 'Allgemein').replace(/\s+/g, '-').slice(0, 30);
  const vorgangSlug = (context.vorgangTitle ?? 'Neu').replace(/\s+/g, '-').slice(0, 30);

  const folders: Record<ClassifiedDocumentKind, DigitalFolder> = {
    rechnung: {
      id: `dig-rechnung-${Date.now()}`,
      name: 'Eingangsrechnungen',
      path: `/Eingang/Rechnungen/${customerSlug}/`,
    },
    mahnung: {
      id: `dig-mahnung-${Date.now()}`,
      name: 'Mahnungen',
      path: `/Eingang/Mahnungen/${customerSlug}/`,
    },
    auftrag: {
      id: `dig-auftrag-${Date.now()}`,
      name: 'Kundenaufträge',
      path: `/Vorgänge/Neu/${vorgangSlug}/`,
    },
    angebot: {
      id: `dig-angebot-${Date.now()}`,
      name: 'Angebote',
      path: `/Vorgänge/Angebote/${customerSlug}/`,
    },
    lieferschein: {
      id: `dig-lieferschein-${Date.now()}`,
      name: 'Lieferscheine',
      path: `/Vorgänge/${vorgangSlug}/Lieferscheine/`,
    },
    bg_bau: {
      id: `dig-bg-bau-${Date.now()}`,
      name: 'BG BAU',
      path: `/Behörden/BG-BAU/${year}/`,
    },
    berufsgenossenschaft: {
      id: `dig-bg-${Date.now()}`,
      name: 'Berufsgenossenschaft',
      path: `/Behörden/Berufsgenossenschaft/${year}/`,
    },
    soka_bau: {
      id: `dig-soka-${Date.now()}`,
      name: 'SOKA-BAU',
      path: `/Behörden/SOKA-BAU/${year}/`,
    },
    finanzamt: {
      id: `dig-finanzamt-${Date.now()}`,
      name: 'Finanzamt',
      path: `/Steuerberater/${year}/Finanzamt/`,
    },
    freistellungsbescheinigung: {
      id: `dig-freistellung-${Date.now()}`,
      name: 'Steuer',
      path: `/Steuerberater/${year}/Freistellungsbescheinigungen/`,
    },
    unbedenklichkeitsbescheinigung: {
      id: `dig-unbedenklich-${Date.now()}`,
      name: 'Unbedenklichkeit',
      path: `/Behörden/Unbedenklichkeit/${year}/`,
    },
    aok: {
      id: `dig-aok-${Date.now()}`,
      name: 'AOK',
      path: `/Personal/Krankenkassen/AOK/${year}/`,
    },
    krankenkasse: {
      id: `dig-kk-${Date.now()}`,
      name: 'Krankenkassen',
      path: `/Personal/Krankenkassen/${year}/`,
    },
    versicherung: {
      id: `dig-vers-${Date.now()}`,
      name: 'Versicherungen',
      path: `/Versicherungen/${year}/`,
    },
    gewerbeanmeldung: {
      id: `dig-gewerbe-${Date.now()}`,
      name: 'Gewerbe',
      path: `/Firma/Gewerbe/${year}/`,
    },
    handelsregister: {
      id: `dig-hr-${Date.now()}`,
      name: 'Handelsregister',
      path: `/Firma/Handelsregister/${year}/`,
    },
    lohnunterlagen: {
      id: `dig-lohn-${Date.now()}`,
      name: 'Lohnunterlagen',
      path: `/Personal/Lohn/${year}/`,
    },
    kontoauszug: {
      id: `dig-konto-${Date.now()}`,
      name: 'Kontoauszüge',
      path: `/Steuerberater/${year}/Kontoauszüge/`,
    },
    pruefprotokoll: {
      id: `dig-protokoll-${Date.now()}`,
      name: 'Protokolle',
      path: `/Vorgänge/${vorgangSlug}/Protokolle/`,
    },
    brief: {
      id: `dig-brief-${Date.now()}`,
      name: 'Briefe',
      path: `/Firma/Briefe/${year}/`,
    },
    foto: {
      id: `dig-foto-${Date.now()}`,
      name: 'Fotos',
      path: `/Vorgänge/${vorgangSlug}/Fotos/`,
    },
    sonstiges: {
      id: `dig-sonst-${Date.now()}`,
      name: 'Eingang',
      path: `/Eingang/Sonstiges/${year}/`,
    },
  };

  return folders[kind];
}

export function suggestPaperFolder(kind: ClassifiedDocumentKind): PaperFilingRule {
  switch (kind) {
    case 'rechnung':
    case 'mahnung':
    case 'lieferschein':
      return paperFolder('folder-1', 'A');
    case 'auftrag':
    case 'angebot':
      return paperFolder('folder-2', 'A');
    case 'kontoauszug':
    case 'finanzamt':
    case 'freistellungsbescheinigung':
    case 'lohnunterlagen':
      return paperFolder('folder-4', 'Monat 01');
    case 'foto':
    case 'pruefprotokoll':
      return paperFolder('folder-2', 'B');
    default:
      return paperFolder('folder-5', 'A');
  }
}

function buildRecognizedData(
  kind: ClassifiedDocumentKind,
  input: DocumentClassificationInput,
): Record<string, string> {
  const base: Record<string, string> = {
    Dokumentart: kind,
  };

  const profiles: Partial<Record<ClassifiedDocumentKind, Record<string, string>>> = {
    rechnung: {
      Rechnungsnummer: 'RE-2026-0001',
      Betrag: '342,16 €',
      Lieferant: input.senderHint ?? 'Unbekannt',
    },
    mahnung: {
      Rechnungsnummer: 'BZ-2026-8842',
      Betrag: '1.247,80 €',
      Fälligkeit: '30.03.2026',
      Hinweis: 'Zahlungserinnerung',
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
  };

  return { ...base, ...(profiles[kind] ?? { Betreff: input.titleHint ?? 'Dokument' }) };
}

function defaultPriority(kind: ClassifiedDocumentKind): InboxPriority {
  if (kind === 'mahnung') return 'kritisch';
  if (['finanzamt', 'bg_bau', 'freistellungsbescheinigung', 'auftrag'].includes(kind)) return 'hoch';
  if (['rechnung', 'kontoauszug', 'unbedenklichkeitsbescheinigung'].includes(kind)) return 'mittel';
  return 'niedrig';
}

function defaultRecommendedAction(kind: ClassifiedDocumentKind): RecommendedAction {
  switch (kind) {
    case 'rechnung':
    case 'lieferschein':
      return 'zuordnen';
    case 'mahnung':
      return 'zahlung_pruefen';
    case 'auftrag':
    case 'angebot':
      return 'auftrag_annehmen';
    case 'kontoauszug':
    case 'finanzamt':
    case 'lohnunterlagen':
      return 'steuerberater_vorbereiten';
    case 'foto':
      return 'archivieren';
    case 'sonstiges':
      return 'klaeren';
    default:
      return 'abheften';
  }
}

function buildExplanation(kind: ClassifiedDocumentKind, sender: string): string {
  const explanations: Record<ClassifiedDocumentKind, string> = {
    rechnung: `Eingangsrechnung von „${sender}“ erkannt. Bitte Betrag prüfen und einem Vorgang zuordnen.`,
    mahnung: `Mahnung oder Zahlungserinnerung von „${sender}“ erkannt. Zahlungsstatus prüfen.`,
    auftrag: `Kundenauftrag von „${sender}“ erkannt. Umfang und Termine prüfen.`,
    angebot: `Angebot von „${sender}“ erkannt. Leistungen und Preise prüfen.`,
    bg_bau: `BG-BAU-Schreiben erkannt. Beitrag und Frist prüfen, im BG-BAU-Ordner ablegen.`,
    berufsgenossenschaft: `Schreiben der Berufsgenossenschaft erkannt. Fristen und Beiträge prüfen.`,
    finanzamt: `Finanzamt-Schreiben erkannt. Frist beachten – ggf. Steuerberater einbeziehen.`,
    aok: `AOK-Schreiben erkannt. Im Krankenkassenordner speichern.`,
    krankenkasse: `Krankenkassen-Schreiben erkannt. Beiträge und Meldungen prüfen.`,
    versicherung: `Versicherungsschreiben erkannt. Deckung und Fristen prüfen.`,
    freistellungsbescheinigung: `Freistellungsbescheinigung erkannt. Im Steuerordner ablegen und ggf. an Auftraggeber senden.`,
    unbedenklichkeitsbescheinigung: `Unbedenklichkeitsbescheinigung erkannt. Für Auftraggeber bereithalten.`,
    soka_bau: `SOKA-BAU-Schreiben erkannt. Beiträge und Bescheinigungen prüfen.`,
    gewerbeanmeldung: `Gewerbeanmeldung erkannt. Im Firmenordner ablegen.`,
    handelsregister: `Handelsregister-Schreiben erkannt. Original abheften.`,
    lohnunterlagen: `Lohnunterlagen erkannt. Vertraulich aufbewahren.`,
    kontoauszug: `Kontoauszug erkannt. Für Steuerberater vorbereiten.`,
    lieferschein: `Lieferschein erkannt. Wareneingang und Vorgang prüfen.`,
    pruefprotokoll: `Prüf- oder Abnahmeprotokoll erkannt. Dem Vorgang zuordnen.`,
    brief: `Brief von „${sender}“ erkannt. Inhalt und Frist prüfen.`,
    foto: `Foto erkannt. Baustelle oder Vorgang zuordnen.`,
    sonstiges: `Dokument erkannt. Bitte Inhalt manuell prüfen.`,
  };
  return explanations[kind];
}

function buildNextTask(kind: ClassifiedDocumentKind): string {
  const tasks: Partial<Record<ClassifiedDocumentKind, string>> = {
    rechnung: 'Rechnung prüfen und Vorgang zuordnen',
    mahnung: 'Zahlung prüfen',
    auftrag: 'Auftrag prüfen oder Rückfrage stellen',
    bg_bau: 'BG-BAU-Schreiben prüfen und Frist beachten',
    freistellungsbescheinigung: 'Freistellungsbescheinigung ablegen und weiterleiten',
    aok: 'AOK-Schreiben prüfen und ablegen',
    kontoauszug: 'Kontoauszug für Steuerberater vorbereiten',
  };
  return tasks[kind] ?? 'Dokument prüfen und ablegen';
}

function buildTaskTemplate(
  kind: ClassifiedDocumentKind,
  title: string,
  deadline: string | null,
): InboxTaskTemplate | undefined {
  if (kind === 'sonstiges' || kind === 'foto') return undefined;

  const type =
    kind === 'kontoauszug' || kind === 'finanzamt' || kind === 'lohnunterlagen'
      ? 'steuerberater_export'
      : kind === 'brief'
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

  const common: SuggestedDocumentAction[] = [
    { id: 'confirm_filing', labelKey: 'classification.action.confirmFiling', variant: 'outline' },
  ];

  const byKind: Record<ClassifiedDocumentKind, SuggestedDocumentAction[]> = {
    bg_bau: [
      { id: 'save_bg_bau_folder', labelKey: 'classification.action.saveBgBauFolder', variant: 'primary' },
      { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'secondary' },
      { id: 'show_contact', labelKey: 'classification.action.showContact', variant: 'outline' },
    ],
    berufsgenossenschaft: [
      { id: 'save_bg_bau_folder', labelKey: 'classification.action.saveBgBauFolder', variant: 'primary' },
      { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'secondary' },
    ],
    rechnung: [
      { id: 'link_vorgang', labelKey: 'classification.action.linkVorgang', variant: 'primary' },
      { id: 'check_payment', labelKey: 'classification.action.checkPayment', variant: 'secondary' },
      { id: 'archive', labelKey: 'classification.action.archive', variant: 'outline' },
    ],
    mahnung: [
      { id: 'mark_important', labelKey: 'classification.action.markImportant', variant: 'primary' },
      { id: 'check_payment', labelKey: 'classification.action.checkPayment', variant: 'secondary' },
      { id: 'link_vorgang', labelKey: 'classification.action.linkVorgang', variant: 'outline' },
    ],
    freistellungsbescheinigung: [
      { id: 'save_tax_folder', labelKey: 'classification.action.saveTaxFolder', variant: 'primary' },
      { id: 'send_to_customer', labelKey: 'classification.action.sendToCustomer', variant: 'secondary' },
    ],
    unbedenklichkeitsbescheinigung: [
      { id: 'save_tax_folder', labelKey: 'classification.action.saveTaxFolder', variant: 'primary' },
      { id: 'send_to_customer', labelKey: 'classification.action.sendToCustomer', variant: 'secondary' },
    ],
    aok: [
      { id: 'save_health_folder', labelKey: 'classification.action.saveHealthFolder', variant: 'primary' },
      { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'outline' },
    ],
    krankenkasse: [
      { id: 'save_health_folder', labelKey: 'classification.action.saveHealthFolder', variant: 'primary' },
      { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'outline' },
    ],
    auftrag: [
      { id: 'create_vorgang', labelKey: 'classification.action.createVorgang', variant: 'primary' },
      { id: 'import_positions', labelKey: 'classification.action.importPositions', variant: 'secondary' },
    ],
    angebot: [
      { id: 'create_vorgang', labelKey: 'classification.action.createVorgang', variant: 'primary' },
      { id: 'archive', labelKey: 'classification.action.archive', variant: 'outline' },
    ],
    finanzamt: [
      { id: 'save_tax_folder', labelKey: 'classification.action.saveTaxFolder', variant: 'primary' },
      { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'secondary' },
    ],
    kontoauszug: [
      { id: 'save_tax_folder', labelKey: 'classification.action.saveTaxFolder', variant: 'primary' },
      { id: 'archive', labelKey: 'classification.action.archive', variant: 'outline' },
    ],
    lieferschein: [
      { id: 'link_vorgang', labelKey: 'classification.action.linkVorgang', variant: 'primary' },
      { id: 'confirm_filing', labelKey: 'classification.action.confirmFiling', variant: 'outline' },
    ],
    brief: [
      { id: 'confirm_filing', labelKey: 'classification.action.confirmFiling', variant: 'primary' },
      { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'outline' },
    ],
    versicherung: [
      { id: 'confirm_filing', labelKey: 'classification.action.confirmFiling', variant: 'primary' },
      { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'outline' },
    ],
    soka_bau: [
      { id: 'save_bg_bau_folder', labelKey: 'classification.action.saveSokaFolder', variant: 'primary' },
      { id: 'check_deadline', labelKey: 'classification.action.checkDeadline', variant: 'outline' },
    ],
    gewerbeanmeldung: [
      { id: 'archive', labelKey: 'classification.action.archive', variant: 'primary' },
    ],
    handelsregister: [
      { id: 'archive', labelKey: 'classification.action.archive', variant: 'primary' },
    ],
    lohnunterlagen: [
      { id: 'save_tax_folder', labelKey: 'classification.action.saveTaxFolder', variant: 'primary' },
    ],
    pruefprotokoll: [
      { id: 'link_vorgang', labelKey: 'classification.action.linkVorgang', variant: 'primary' },
    ],
    foto: [
      { id: 'link_vorgang', labelKey: 'classification.action.linkVorgang', variant: 'primary' },
      { id: 'archive', labelKey: 'classification.action.archive', variant: 'outline' },
    ],
    sonstiges: common,
  };

  const actions = byKind[kind] ?? common;

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
  const matches = findSimilarVorgaenge(draft);
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
  const classifiedKind = detectClassifiedKind(input);
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
  const paperFiling = suggestPaperFolder(classifiedKind);
  const deadline =
    recognizedData.Frist ??
    recognizedData.Fälligkeit ??
    (classifiedKind === 'mahnung' ? '2026-03-30' : null);

  const explanation = buildExplanation(classifiedKind, sender);
  const priority = isAdvertisement ? 'niedrig' : defaultPriority(classifiedKind);
  const recommendedAction = isAdvertisement ? 'entsorgen' : defaultRecommendedAction(classifiedKind);

  const result: DocumentClassificationResult = {
    classifiedKind,
    documentType: mapKindToDocumentType(classifiedKind),
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

  if (suggestedVorgangRaw && ['rechnung', 'lieferschein', 'mahnung'].includes(classifiedKind)) {
    result.recognizedData.Vorgang = suggestedVorgangRaw.vorgangTitle;
  }

  return result;
}

export function getClassifiedKindFromItem(item: InboxItem): ClassifiedDocumentKind {
  if (item.classifiedKind) return item.classifiedKind;

  if (item.recognizedData.Dokumentart) {
    const kind = item.recognizedData.Dokumentart as ClassifiedDocumentKind;
    if (kind in DOCUMENT_TYPE_MAP) return kind;
  }

  return detectClassifiedKind({
    sourceFileName: item.sourceFileName,
    titleHint: item.title,
    senderHint: item.sender,
    recognizedText: Object.values(item.recognizedData).join(' '),
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

export function getClassificationForItem(item: InboxItem): DocumentClassificationResult {
  const kind = getClassifiedKindFromItem(item);
  return {
    classifiedKind: kind,
    documentType: item.documentType,
    title: item.title,
    sender: item.sender,
    explanation: item.officePilotSuggestion,
    priority: item.priority,
    deadline: item.deadline,
    recommendedAction: item.recommendedAction,
    digitalFolder: item.digitalFolder,
    paperFiling: item.paperFiling,
    recognizedData: item.recognizedData,
    officePilotSuggestion: item.officePilotSuggestion,
    nextTaskLabel: item.nextTaskLabel,
    securityHint: item.securityHint,
    taskTemplate: item.taskTemplate,
    isAdvertisement: item.isAdvertisement,
    suggestedVorgang: getSuggestedVorgangForItem(item) ?? undefined,
    actions: suggestActions(kind, item),
  };
}

export const CLASSIFIED_DOCUMENT_KINDS: ClassifiedDocumentKind[] = [
  'rechnung',
  'brief',
  'bg_bau',
  'finanzamt',
  'aok',
  'krankenkasse',
  'berufsgenossenschaft',
  'versicherung',
  'gewerbeanmeldung',
  'freistellungsbescheinigung',
  'unbedenklichkeitsbescheinigung',
  'soka_bau',
  'handelsregister',
  'lohnunterlagen',
  'kontoauszug',
  'mahnung',
  'angebot',
  'auftrag',
  'lieferschein',
  'pruefprotokoll',
  'foto',
  'sonstiges',
];
