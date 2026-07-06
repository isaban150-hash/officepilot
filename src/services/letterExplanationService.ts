import { OFFICEPILOT_LEGAL_DISCLAIMER } from '../config/legalDisclaimer';
import { formatPaperFilingInstruction } from './paperFolderService';
import type { InboxItem, InboxPriority, WorkflowLetterSummary } from '../types/models';

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
  about: string;
  importance: string;
  deadline: string;
  nextSteps: string;
  digitalStorage: string;
  paperStorage: string;
  disclaimer: string;
}

const UNCERTAIN_HINT =
  'Bitte prüfen oder Steuerberater/Ansprechpartner fragen.';

const DISCLAIMER = OFFICEPILOT_LEGAL_DISCLAIMER;

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

function formatDeadline(item: InboxItem): string {
  const recognizedFrist =
    item.recognizedData.Frist ??
    item.recognizedData.frist ??
    item.recognizedData.Deadline;

  if (item.deadline) {
    return `Mögliche Frist erkannt: ${item.deadline}. Bitte im Originalschreiben verifizieren.`;
  }
  if (recognizedFrist) {
    return `Im Text erkannte Frist: ${recognizedFrist}. Bitte im Originalschreiben verifizieren.`;
  }
  return `Keine erkennbare Frist. ${UNCERTAIN_HINT}`;
}

function importanceFromPriority(priority: InboxPriority): string {
  switch (priority) {
    case 'kritisch':
      return 'Vermutlich zeitkritisch – bitte prioritär prüfen und Fristen im Schreiben kontrollieren.';
    case 'hoch':
      return 'Wahrscheinlich wichtig – zeitnah bearbeiten und nicht liegen lassen.';
    case 'mittel':
      return 'Möglicherweise relevant – in den nächsten Tagen prüfen.';
    case 'niedrig':
      return 'Priorität eher niedrig – dennoch kurz prüfen, ob Handlungsbedarf besteht.';
    default:
      return `Bedeutung unklar. ${UNCERTAIN_HINT}`;
  }
}

function subjectHint(item: InboxItem): string {
  return (
    item.recognizedData.Betreff ??
    item.recognizedData.betreff ??
    item.title
  );
}

function storageHints(item: InboxItem): { digital: string; paper: string } {
  return {
    digital: `${item.digitalFolder.name} → ${item.digitalFolder.path}`,
    paper: formatPaperFilingInstruction(item.paperFiling),
  };
}

type TemplateBuilder = (item: InboxItem) => {
  about: string;
  nextSteps: string;
};

const TEMPLATES: Record<LetterKind, TemplateBuilder> = {
  brief: (item) => ({
    about: `Es könnte sich um einen allgemeinen Brief handeln – vermutlich von „${item.sender}“. Betreff: „${subjectHint(item)}“.`,
    nextSteps:
      'Schreiben kurz durchlesen, ob eine Antwort, Unterschrift oder Ablage nötig ist. Bei unklarem Inhalt Rückfrage beim Absender oder intern klären.',
  }),
  behoerde: (item) => ({
    about: `Es könnte ein behördliches Schreiben sein – Absender: „${item.sender}“. Betreff: „${subjectHint(item)}“.`,
    nextSteps:
      'Inhalt und Frist prüfen, Original abheften und ggf. an zuständige Person oder Steuerberater weiterleiten – ohne automatische Antwort.',
  }),
  versicherung: (item) => ({
    about: `Es könnte ein Versicherungsschreiben sein (z. B. Police, Mahnung oder Mitteilung) von „${item.sender}“.`,
    nextSteps:
      'Prüfen, ob Beitrag, Laufzeit oder Deckung betroffen sind. Unterlagen abheften und bei Bedarf Versicherungsmakler kontaktieren.',
  }),
  krankenkasse: (item) => ({
    about: `Es könnte ein Schreiben der Krankenkasse (z. B. AOK) sein von „${item.sender}“. Betreff: „${subjectHint(item)}“.`,
    nextSteps:
      'Prüfen, ob Beiträge, Meldungen oder Fristen betroffen sind. Original abheften und bei Unklarheiten die Krankenkasse oder Lohnbuchhaltung fragen.',
  }),
  bg_bau: (item) => ({
    about: `Es könnte ein Schreiben der BG BAU (Berufsgenossenschaft) sein – z. B. Beitrag, Unbedenklichkeitsbescheinigung oder Mitteilung. Absender: „${item.sender}“.`,
    nextSteps:
      'Beitrag und Frist prüfen, Original abheften. Bei Beitragsbescheiden ggf. Steuerberater oder Lohnbuchhaltung einbeziehen.',
  }),
  finanzamt: (item) => ({
    about: `Es könnte ein Finanzamt-Schreiben sein (z. B. Steuerbescheid, Anfrage oder Fristsetzung) von „${item.sender}“.`,
    nextSteps:
      'Schreiben sorgfältig prüfen, Fristen notieren, Original abheften. Bei Steuerfragen Steuerberater hinzuziehen – keine eigenständige Bewertung vornehmen.',
  }),
  soka_bau: (item) => ({
    about: `Es könnte ein SOKA-BAU-Schreiben sein (Sozialkassen der Bauwirtschaft) von „${item.sender}“.`,
    nextSteps:
      'Prüfen, ob Beiträge, Bescheinigungen oder Meldepflichten betroffen sind. Original abheften und bei Unklarheiten SOKA-BAU oder Steuerberater fragen.',
  }),
  wichtiges_schreiben: (item) => ({
    about: `Es könnte ein wichtiges Schreiben sein – Absender: „${item.sender}“, Titel: „${item.title}“. Genauer Inhalt bitte manuell prüfen.`,
    nextSteps:
      'Kurz prüfen, ob Frist, Zahlung oder Antwort erforderlich ist. Bei Unsicherheit nicht allein entscheiden – Ansprechpartner oder Steuerberater einbeziehen.',
  }),
};

export function getLetterExplanation(item: InboxItem): LetterExplanation | null {
  const kind = detectLetterKind(item);
  if (!kind) return null;

  const storage = storageHints(item);
  const template = TEMPLATES[kind](item);

  return {
    kind,
    about: template.about,
    importance: importanceFromPriority(item.priority),
    deadline: formatDeadline(item),
    nextSteps: template.nextSteps,
    digitalStorage: storage.digital,
    paperStorage: storage.paper,
    disclaimer: `${DISCLAIMER} ${UNCERTAIN_HINT}`,
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
    disclaimer: `${DISCLAIMER} ${UNCERTAIN_HINT}`,
  };
}
