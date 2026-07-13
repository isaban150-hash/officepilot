import type { ExplanationTextBlock } from '../i18n/types';
import type { TranslationKey } from '../i18n';
import { formatPaperFilingInstruction } from './paperFolderService';
import { getCachedSetup } from './persistenceService';
import type { AppLanguage, InboxItem, InboxPriority, WorkflowLetterSummary } from '../types/models';

export type LetterKind =
  | 'brief'
  | 'behoerde'
  | 'versicherung'
  | 'krankenkasse'
  | 'bg_bau'
  | 'finanzamt'
  | 'soka_bau'
  | 'wichtiges_schreiben';

export interface LetterExplanation {
  kind: LetterKind;
  about: ExplanationTextBlock;
  importance: ExplanationTextBlock;
  deadline: ExplanationTextBlock;
  nextSteps: ExplanationTextBlock;
  digitalStorage: string;
  paperStorage: string;
  legalDisclaimerKey: TranslationKey;
  disclaimer: ExplanationTextBlock[];
}

const ABOUT_KEYS: Record<LetterKind, string> = {
  brief: 'letter.explain.about.brief',
  behoerde: 'letter.explain.about.behoerde',
  versicherung: 'letter.explain.about.versicherung',
  krankenkasse: 'letter.explain.about.krankenkasse',
  bg_bau: 'letter.explain.about.bgBau',
  finanzamt: 'letter.explain.about.finanzamt',
  soka_bau: 'letter.explain.about.sokaBau',
  wichtiges_schreiben: 'letter.explain.about.wichtig',
};

const NEXT_STEP_KEYS: Record<LetterKind, string> = {
  brief: 'letter.explain.nextSteps.brief',
  behoerde: 'letter.explain.nextSteps.behoerde',
  versicherung: 'letter.explain.nextSteps.versicherung',
  krankenkasse: 'letter.explain.nextSteps.krankenkasse',
  bg_bau: 'letter.explain.nextSteps.bgBau',
  finanzamt: 'letter.explain.nextSteps.finanzamt',
  soka_bau: 'letter.explain.nextSteps.sokaBau',
  wichtiges_schreiben: 'letter.explain.nextSteps.wichtig',
};

function normalizedHaystack(item: InboxItem): string {
  return [
    item.title,
    item.sender,
    item.officePilotSuggestion,
    ...Object.values(item.recognizedData),
  ]
    .join(' ')
    .toLowerCase();
}

function isInvoiceOrOrder(item: InboxItem): boolean {
  return (
    item.documentType === 'eingangsrechnung' ||
    item.documentType === 'kundenauftrag' ||
    item.documentType === 'ausgangsrechnung'
  );
}

export function detectLetterKind(item: InboxItem): LetterKind | null {
  if (item.isAdvertisement || item.documentType === 'foto') return null;
  if (isInvoiceOrOrder(item)) return null;

  const text = normalizedHaystack(item);

  if (item.documentType === 'brief') return 'brief';
  if (/bg[\s-]?bau|berufsgenossenschaft/.test(text)) return 'bg_bau';
  if (/finanzamt|steuerbescheid|lohnsteuer|umsatzsteuer/.test(text)) return 'finanzamt';
  if (/soka[\s-]?bau/.test(text)) return 'soka_bau';
  if (/aok|krankenkasse|gesundheitskasse|barmer|tk[\s-]|techniker[\s-]?kranken/.test(text)) {
    return 'krankenkasse';
  }
  if (/versicherung|allianz|haftpflicht|policy|versicherungsschreiben/.test(text)) {
    return 'versicherung';
  }
  if (item.documentType === 'behoerde') return 'behoerde';
  if (item.documentType === 'sonstiges') return 'wichtiges_schreiben';

  return null;
}

export function isExplainableLetter(item: InboxItem): boolean {
  return detectLetterKind(item) !== null;
}

function subjectHint(item: InboxItem): string {
  return (
    item.recognizedData.Betreff ??
    item.recognizedData.betreff ??
    item.title
  );
}

function buildDeadlineBlock(item: InboxItem): ExplanationTextBlock {
  const recognizedFrist =
    item.recognizedData.Frist ??
    item.recognizedData.frist ??
    item.recognizedData.Deadline;

  if (item.deadline) {
    return {
      key: 'letter.explain.deadline.recognized',
      params: { deadline: item.deadline },
    };
  }
  if (recognizedFrist) {
    return {
      key: 'letter.explain.deadline.fromText',
      params: { deadline: String(recognizedFrist) },
    };
  }
  return { key: 'letter.explain.deadline.none' };
}

function importanceBlock(priority: InboxPriority): ExplanationTextBlock {
  switch (priority) {
    case 'kritisch':
      return { key: 'letter.explain.importance.critical' };
    case 'hoch':
      return { key: 'letter.explain.importance.high' };
    case 'mittel':
      return { key: 'letter.explain.importance.medium' };
    case 'niedrig':
      return { key: 'letter.explain.importance.low' };
    default:
      return { key: 'letter.explain.importance.unclear' };
  }
}

function storageHints(item: InboxItem, lang: AppLanguage): { digital: string; paper: string } {
  return {
    digital: `${item.digitalFolder.name} → ${item.digitalFolder.path}`,
    paper: formatPaperFilingInstruction(item.paperFiling, lang),
  };
}

function buildAboutBlock(kind: LetterKind, item: InboxItem): ExplanationTextBlock {
  const sender = item.sender || '—';
  const subject = subjectHint(item);
  if (kind === 'wichtiges_schreiben') {
    return {
      key: ABOUT_KEYS[kind],
      params: { sender, title: item.title },
    };
  }
  return {
    key: ABOUT_KEYS[kind],
    params: { sender, subject },
  };
}

export function getLetterExplanation(
  item: InboxItem,
  lang: AppLanguage = getCachedSetup()?.language ?? 'de',
): LetterExplanation | null {
  const kind = detectLetterKind(item);
  if (!kind) return null;

  const storage = storageHints(item, lang);

  return {
    kind,
    about: buildAboutBlock(kind, item),
    importance: importanceBlock(item.priority),
    deadline: buildDeadlineBlock(item),
    nextSteps: { key: NEXT_STEP_KEYS[kind] },
    digitalStorage: storage.digital,
    paperStorage: storage.paper,
    legalDisclaimerKey: 'legal.disclaimer',
    disclaimer: [{ key: 'letter.explain.uncertainHint' }],
  };
}

export function letterExplanationFromWorkflow(
  summary: WorkflowLetterSummary | null | undefined,
): LetterExplanation | null {
  if (!summary) return null;

  return {
    kind: summary.kind as LetterKind,
    about: summary.about,
    importance: summary.importance,
    deadline: summary.deadline,
    nextSteps: summary.nextSteps,
    digitalStorage: summary.digitalStorage,
    paperStorage: summary.paperStorage,
    legalDisclaimerKey: 'legal.disclaimer',
    disclaimer: summary.disclaimer ?? [{ key: 'letter.explain.uncertainHint' }],
  };
}
