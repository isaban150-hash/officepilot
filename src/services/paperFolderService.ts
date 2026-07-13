import { PAPER_FOLDERS } from '../data/mockData';
import type {
  AppLanguage,
  ClassifiedDocumentKind,
  DocumentType,
  InboxItem,
  PaperFilingRule,
  PaperFolder,
} from '../types/models';
import {
  formatPaperFilingInstruction as formatPaperFilingInstructionLocalized,
  formatPaperLocationSummary as formatPaperLocationSummaryLocalized,
} from './paperFolderDisplayService';
import { getCachedSetup } from './persistenceService';
import { getTodayIso } from './taskNormalize';

export interface PaperFilingContext {
  classifiedKind?: ClassifiedDocumentKind;
  documentType?: DocumentType;
  issuer?: string;
  sender?: string;
  isAdvertisement?: boolean;
  linkedVorgangId?: string;
  year?: number;
}

export interface PaperFilingResolution {
  rule: PaperFilingRule | null;
  skipPhysicalFiling: boolean;
}

const KRANKENKASSE_KINDS = new Set<ClassifiedDocumentKind>([
  'aok',
  'barmer',
  'tk',
  'dak',
  'ikk',
  'knappschaft',
  'pflegekasse',
  'krankenkasse',
]);

const EXPENSE_KINDS = new Set<ClassifiedDocumentKind>([
  'eingangsrechnung',
  'rechnung',
  'quittung',
  'kassenbeleg',
  'ec_beleg',
  'kreditkartenbeleg',
  'tankbeleg',
  'reparaturrechnung',
  'mahnung',
  'zahlungserinnerung',
]);

const CUSTOMER_KINDS = new Set<ClassifiedDocumentKind>([
  'werkvertrag',
  'subunternehmervertrag',
  'nachunternehmervertrag',
  'auftrag',
  'angebot',
  'auftragsbestaetigung',
  'leistungsverzeichnis',
  'nachtrag',
  'lieferschein',
  'abnahmeprotokoll',
]);

const EMPLOYEE_KINDS = new Set<ClassifiedDocumentKind>([
  'arbeitsvertrag',
  'lohnabrechnung',
  'lohnunterlagen',
  'stundenzettel',
  'urlaubsantrag',
  'krankmeldung',
  'arbeitsunfaehigkeitsbescheinigung',
]);

const VEHICLE_KINDS = new Set<ClassifiedDocumentKind>([
  'fahrzeugversicherung',
  'tuev_bericht',
  'reparaturrechnung',
  'tankbeleg',
]);

function currentYear(): number {
  return new Date().getFullYear();
}

function buildRule(folderId: string, register: string): PaperFilingRule {
  const folder = getPaperFolderById(folderId) ?? PAPER_FOLDERS[0]!;
  return {
    folderId: folder.id,
    register,
    label: folder.name,
  };
}

export function getPaperFolderById(folderId: string): PaperFolder | undefined {
  return PAPER_FOLDERS.find((folder) => folder.id === folderId);
}

export function getAllPaperFolders(): PaperFolder[] {
  return PAPER_FOLDERS;
}

export function formatPaperFilingInstruction(
  rule: PaperFilingRule,
  lang: AppLanguage = getCachedSetup()?.language ?? 'de',
): string {
  return formatPaperFilingInstructionLocalized(rule, lang);
}

export function formatPaperLocationSummary(
  rule: PaperFilingRule,
  lang: AppLanguage = getCachedSetup()?.language ?? 'de',
): string {
  return formatPaperLocationSummaryLocalized(rule, lang);
}

export function isAdvertisementContext(context: PaperFilingContext): boolean {
  if (context.isAdvertisement) return true;
  if (context.classifiedKind === 'sonstiges' && context.documentType === 'sonstiges') {
    const haystack = `${context.issuer ?? ''} ${context.sender ?? ''}`.toLowerCase();
    return /werbung|reklame|prospekt|newsletter/.test(haystack);
  }
  return false;
}

function krankenkasseRegister(kind: ClassifiedDocumentKind, issuer?: string): string {
  if (kind === 'aok' || /aok/i.test(issuer ?? '')) return 'AOK';
  if (kind === 'barmer' || /barmer/i.test(issuer ?? '')) return 'Barmer';
  if (kind === 'tk' || /techniker|(\btk\b)/i.test(issuer ?? '')) return 'TK';
  if (kind === 'ikk' || /ikk/i.test(issuer ?? '')) return 'IKK';
  return issuer?.trim() || 'Sonstiges';
}

export function resolvePaperFiling(context: PaperFilingContext): PaperFilingResolution {
  if (isAdvertisementContext(context)) {
    return { rule: null, skipPhysicalFiling: true };
  }

  const kind = context.classifiedKind;
  const year = String(context.year ?? currentYear());
  const issuer = context.issuer ?? context.sender ?? '';

  if (!kind) {
    return { rule: buildRule('paper-sonstiges', 'A'), skipPhysicalFiling: false };
  }

  if (kind === 'finanzamt' || kind === 'steuerbescheid' || kind === 'umsatzsteuerbescheid') {
    return { rule: buildRule('paper-behoerden', 'Finanzamt'), skipPhysicalFiling: false };
  }
  if (kind === 'bg_bau' || kind === 'berufsgenossenschaft' || kind === 'soka_bau') {
    return { rule: buildRule('paper-behoerden', 'BG BAU'), skipPhysicalFiling: false };
  }
  if (kind === 'unbedenklichkeitsbescheinigung') {
    return { rule: buildRule('paper-behoerden', 'Unbedenklichkeit'), skipPhysicalFiling: false };
  }
  if (kind === 'freistellungsbescheinigung') {
    return { rule: buildRule('folder-4', 'Freistellungsbescheinigungen'), skipPhysicalFiling: false };
  }
  if (KRANKENKASSE_KINDS.has(kind)) {
    return {
      rule: buildRule('paper-krankenkassen', krankenkasseRegister(kind, issuer)),
      skipPhysicalFiling: false,
    };
  }
  if (kind === 'werkvertrag' || kind === 'subunternehmervertrag' || kind === 'nachunternehmervertrag') {
    return { rule: buildRule('folder-2', 'Verträge'), skipPhysicalFiling: false };
  }
  if (kind === 'eingangsrechnung' || (EXPENSE_KINDS.has(kind) && kind !== 'ausgangsrechnung')) {
    return { rule: buildRule('folder-1', year), skipPhysicalFiling: false };
  }
  if (kind === 'ausgangsrechnung') {
    return { rule: buildRule('folder-3', year), skipPhysicalFiling: false };
  }
  if (kind === 'betriebshaftpflicht' || kind === 'versicherung' || kind === 'versicherungsbescheid') {
    return { rule: buildRule('paper-versicherungen', 'Betriebshaftpflicht'), skipPhysicalFiling: false };
  }
  if (kind === 'lieferschein') {
    if (context.linkedVorgangId) {
      return { rule: buildRule('paper-baustellen', 'Lieferscheine'), skipPhysicalFiling: false };
    }
    return { rule: buildRule('paper-lieferanten', year), skipPhysicalFiling: false };
  }
  if (kind === 'kontoauszug') {
    return { rule: buildRule('folder-4', 'Monat 01'), skipPhysicalFiling: false };
  }
  if (EMPLOYEE_KINDS.has(kind)) {
    return { rule: buildRule('paper-personal', 'Lohn'), skipPhysicalFiling: false };
  }
  if (VEHICLE_KINDS.has(kind)) {
    return { rule: buildRule('paper-fahrzeuge', year), skipPhysicalFiling: false };
  }
  if (CUSTOMER_KINDS.has(kind)) {
    return { rule: buildRule('folder-2', 'Aufträge'), skipPhysicalFiling: false };
  }

  return { rule: buildRule('folder-5', 'A'), skipPhysicalFiling: false };
}

export function suggestPaperFolderId(kind: ClassifiedDocumentKind): string {
  return resolvePaperFiling({ classifiedKind: kind }).rule?.folderId ?? 'paper-sonstiges';
}

export function suggestPaperFolder(
  kind: ClassifiedDocumentKind,
  context: Omit<PaperFilingContext, 'classifiedKind'> = {},
): PaperFilingRule | null {
  return resolvePaperFiling({ ...context, classifiedKind: kind }).rule;
}

export function resolvePaperFilingFromInbox(item: InboxItem): PaperFilingResolution {
  return resolvePaperFiling({
    classifiedKind: item.classifiedKind,
    documentType: item.documentType,
    issuer: item.sender,
    sender: item.sender,
    isAdvertisement: item.isAdvertisement,
    linkedVorgangId: item.vorgangId,
  });
}

export function getPhysicalFilingStatusLabel(
  physicalFiled: boolean | undefined,
  filedAt?: string,
): { statusKey: 'document.filing.statusPending' | 'document.filing.statusFiled'; filedAtLabel?: string } {
  if (physicalFiled) {
    const date = filedAt ? new Date(filedAt).toLocaleDateString('de-DE') : undefined;
    return { statusKey: 'document.filing.statusFiled', filedAtLabel: date };
  }
  return { statusKey: 'document.filing.statusPending' };
}

export function filingTimestamp(): string {
  return getTodayIso();
}
