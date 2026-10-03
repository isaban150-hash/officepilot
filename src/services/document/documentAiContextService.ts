import { analyzeContractFromInbox } from '../contractAnalysisService';
import { getLetterExplanation } from '../letterExplanationService';
import { MAX_RECOGNIZED_TEXT_LENGTH } from '../communicationConstants';
import { sanitizeAiText, containsSensitiveFactKey } from '../ai/aiTextSanitizer';
import { t, type TranslationKey } from '../../i18n';
import { formatMessage } from '../../i18n/formatMessage';
import { getCachedSetup } from '../persistenceService';
import type { ExplanationTextBlock } from '../../i18n/types';
import type { DocumentFieldFillConfirmRow } from '../../types/documentFieldFillConfirm';
import type { AppLanguage, CompanyDocument, InboxItem, WorkflowResult } from '../../types/models';
import type { DocumentAiContext } from '../../types/areaAi';
import type { DocumentWorkTruthView } from '../../types/documentWorkTruth';
import { buildDocumentWorkTruthAssistContextLines } from '../documentWorkResultResolveService';
import { buildPrioritizedDocumentGuidance } from '../documentGuidanceService';
import {
  buildDocumentWorkTruthViewForInboxItem,
  resolveDocumentWorkTruthViewForCompanyDocument,
} from '../documentWorkResultTruthOrchestration';
import { detectDocumentNature } from './documentAiDocumentNature';
import { buildDocumentSemanticCore } from './documentSemanticCoreService';
import { buildSemanticAllowedSourceText } from './documentAiSemanticPromptLines';
import { findSemanticPartyCandidates } from './documentSemanticPartyMatchService';
import { getCompanyProfileStoreSnapshot } from '../companyProfileService';
import { getCustomerStoreSnapshot } from '../customerStoreService';
import { getAllVorgaenge } from '../vorgangService';
import type { DocumentSemanticCore, SemanticDeadline } from '../../types/documentSemanticCore';
import type { MeaningMainDocument } from './documentMeaningPresentationService';
import { hasStructuredDeadlineEvidence } from './documentAiEvidence';
import { resolveCreditNoteNumber } from '../officeActionService';
import { getAllExpenses } from '../expenseService';
import { getInboxItemById } from '../inboxService';
import { getInboxExtractedDocumentText } from '../inboxDocumentText';
import { mainDocumentTextFromPages, resolveMainDocumentPageScope } from './mainDocumentPageScope';
import { resolveCreditNoteNextStepLabelKey } from './intakeAssessmentService';
import { detectFinanceDocumentMarkers, resolveFinanceReviewReason } from './financeDocumentMarkers';
import {
  alignSemanticCoreWithCreditNote,
  creditNotePageOneTextOfItem,
  parsePageTextList,
  projectCreditNoteCoreToPageOne,
  resolveCreditNoteDeadline,
} from './creditNotePageTruth';

function blockToPlainText(block: ExplanationTextBlock): string {
  const lang = getCachedSetup()?.language ?? 'de';
  return formatMessage((key) => t(key as TranslationKey, lang), block);
}

function truncateText(text: string, max = MAX_RECOGNIZED_TEXT_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function buildRecognizedDataLines(data: Record<string, string>): string[] {
  return Object.entries(data)
    .filter(([key]) => !containsSensitiveFactKey(key))
    .map(([key, value]) => `${key}: ${sanitizeAiText(value)}`);
}

function note(key: TranslationKey, lang: AppLanguage): string {
  return t(key, lang);
}

function pickAmountHint(data: Record<string, string> | undefined): string | null {
  if (!data) return null;
  const keys = ['Betrag', 'Gesamtbetrag', 'Brutto', 'Netto', 'Amount', 'Summe'];
  for (const key of keys) {
    const value = data[key]?.trim();
    if (value) return sanitizeAiText(value);
  }
  return null;
}

/** Confirmed/corrected and not in unresolvedConflicts — suppress competing structured hints. */
function slotIsUserOwned(truth: DocumentWorkTruthView, slotId: string): boolean {
  const conflicted = truth.unresolvedConflicts.some((c) => c.slotId === slotId);
  if (conflicted) return false;
  const slot = truth.slots.find((entry) => entry.slotId === slotId);
  return slot?.provenance === 'user_confirmed' || slot?.provenance === 'user_corrected';
}

function slotIsDiscarded(truth: DocumentWorkTruthView, slotId: string): boolean {
  return truth.slots.find((entry) => entry.slotId === slotId)?.provenance === 'discarded';
}

type DocumentAiTruthPromptFields = {
  documentWorkTruthFactLines?: string[];
  documentWorkTruthConflictLines?: string[];
  confirmedUserFactLines?: string[];
  suppressAmountHint: boolean;
  suppressStructuredDeadline: boolean;
  suppressIssuerHint: boolean;
};

/**
 * Shared TruthView → DocumentAiContext prompt fields (inbox + archive).
 * Confirmed/corrected drive suppress flags; discarded never appears in fact lines (mapper).
 */
function buildDocumentAiTruthPromptFields(
  truth: DocumentWorkTruthView | null,
): DocumentAiTruthPromptFields {
  if (!truth) {
    return {
      suppressAmountHint: false,
      suppressStructuredDeadline: false,
      suppressIssuerHint: false,
    };
  }
  const truthLines = buildDocumentWorkTruthAssistContextLines(truth);
  const confirmedUserFactLines = truthLines.factLines.filter(
    (line) => line.includes('[Nutzerbestätigung]') || line.includes('[Nutzerkorrektur]'),
  );
  return {
    documentWorkTruthFactLines: truthLines.factLines,
    documentWorkTruthConflictLines: truthLines.conflictLines,
    confirmedUserFactLines,
    suppressAmountHint: slotIsUserOwned(truth, 'facts.money.0'),
    suppressStructuredDeadline: slotIsUserOwned(truth, 'facts.timeline.deadline'),
    suppressIssuerHint: slotIsUserOwned(truth, 'facts.parties.counterparty'),
  };
}

function withTestNatureNote(
  uncertainFieldNotes: string[],
  documentNature: 'test_or_sample' | 'unknown',
  lang: AppLanguage,
): string[] {
  if (documentNature !== 'test_or_sample') return uncertainFieldNotes;
  const testNote = note('document.freeQuestion.note.testOrSample', lang);
  if (uncertainFieldNotes.includes(testNote)) return uncertainFieldNotes;
  return [testNote, ...uncertainFieldNotes];
}

function collectInboxQualityNotes(
  item: InboxItem,
  lang: AppLanguage,
  flags?: {
    suppressAmountHint?: boolean;
    suppressStructuredDeadline?: boolean;
    suppressIssuerHint?: boolean;
  },
): { uncertainFieldNotes: string[]; missingFieldNotes: string[] } {
  const uncertainFieldNotes: string[] = [];
  const missingFieldNotes: string[] = [];
  const textBudget = [
    item.title,
    item.sender,
    ...Object.values(item.recognizedData ?? {}),
  ]
    .join(' ')
    .trim();

  if (!textBudget) {
    missingFieldNotes.push(note('document.freeQuestion.note.noRecognizedText', lang));
  }
  if (
    !flags?.suppressStructuredDeadline &&
    !item.deadline &&
    !item.recognizedData.Frist
  ) {
    missingFieldNotes.push(note('document.freeQuestion.note.noDeadline', lang));
  }
  if (!flags?.suppressIssuerHint && !item.sender?.trim()) {
    missingFieldNotes.push(note('document.freeQuestion.note.noSender', lang));
  }
  if (!item.vorgangId && !item.vorgangTitle) {
    uncertainFieldNotes.push(note('document.freeQuestion.note.customerUncertain', lang));
  } else if (item.vorgangLinkStatus === 'none' || (!item.vorgangId && item.vorgangTitle)) {
    uncertainFieldNotes.push(note('document.freeQuestion.note.customerUncertain', lang));
  }
  if (item.classifiedKind === 'sonstiges' || !item.classifiedKind) {
    uncertainFieldNotes.push(note('document.freeQuestion.note.documentTypeUncertain', lang));
  }
  if (!flags?.suppressAmountHint && pickAmountHint(item.recognizedData)) {
    uncertainFieldNotes.push(note('document.freeQuestion.note.amountNeedsReview', lang));
  }

  return { uncertainFieldNotes, missingFieldNotes };
}

function pushUniqueText(target: string[], text: string | undefined): void {
  const normalized = text?.trim();
  if (!normalized) return;
  if (!target.includes(normalized)) target.push(normalized);
}

function collectDocumentQualityNotes(
  document: CompanyDocument,
  lang: AppLanguage,
  flags?: {
    suppressStructuredDeadline?: boolean;
    suppressIssuerHint?: boolean;
    /** Discarded counterparty — do not demand a sender as "missing". */
    issuerDiscarded?: boolean;
    deadlineDiscarded?: boolean;
  },
): { uncertainFieldNotes: string[]; missingFieldNotes: string[] } {
  const uncertainFieldNotes: string[] = [];
  const missingFieldNotes: string[] = [];

  if (!document.recognizedText?.trim()) {
    missingFieldNotes.push(note('document.freeQuestion.note.noRecognizedText', lang));
  }
  // issueDate / documentDate alone are not deadline evidence.
  if (
    !flags?.suppressStructuredDeadline &&
    !flags?.deadlineDiscarded &&
    !document.validUntil
  ) {
    missingFieldNotes.push(note('document.freeQuestion.note.noDeadline', lang));
  }
  if (
    !flags?.suppressIssuerHint &&
    !flags?.issuerDiscarded &&
    !document.issuer?.trim()
  ) {
    missingFieldNotes.push(note('document.freeQuestion.note.noSender', lang));
  }
  if (!document.linkedVorgang?.vorgangId) {
    uncertainFieldNotes.push(note('document.freeQuestion.note.customerUncertain', lang));
  }
  if (!document.classifiedKind || document.classifiedKind === 'sonstiges') {
    uncertainFieldNotes.push(note('document.freeQuestion.note.documentTypeUncertain', lang));
  }

  return { uncertainFieldNotes, missingFieldNotes };
}

/**
 * EINGANG-02A-3 Nacharbeit 1 — der Kern eines archivierten Nicht-Gutschrift-
 * Dokuments für Dokumentfragen. Eine Wahrheit mit Eingang, DWR und
 * Archiv-Bedeutung: zuerst der gespeicherte Kern, sonst der archivierte
 * Hauptdokumenttext (`resolveArchivedMainDocumentText`, dieselben
 * Seitenrollen), erst ohne Seitenwahrheit der archivierte Gesamttext.
 */
function resolveArchivedDocumentSemanticCore(
  document: CompanyDocument,
  fromInterpretation: DocumentSemanticCore | null,
): DocumentSemanticCore | undefined {
  return resolveSemanticCore({
    fromInterpretation,
    text: resolveArchivedMainDocumentText(document) ?? document.recognizedText,
    sender: document.issuer,
  });
}

function buildLegacyDocumentAiContextFromDocument(
  document: CompanyDocument,
  lang: AppLanguage,
): DocumentAiContext {
  const quality = collectDocumentQualityNotes(document, lang);
  const confirmedLink = Boolean(document.linkedVorgang?.vorgangId);
  const recognizedText = document.recognizedText
    ? sanitizeAiText(truncateText(document.recognizedText))
    : undefined;
  const documentNature = detectDocumentNature({
    title: document.title,
    recognizedText: document.recognizedText,
  });

  return {
    sourceType: 'document',
    /* 01E — Archivdokumente tragen keinen gespeicherten Kern; er wird aus dem erkannten Text gelesen. */
    semantic:
      document.classifiedKind === 'gutschrift'
        ? resolveArchivedCreditNoteSemanticCore(
            readArchivedSourceText(document, undefined),
            document,
            null,
            deriveArchivedCreditNoteDeadline(readArchivedSourceText(document, undefined)),
          )
        : resolveArchivedDocumentSemanticCore(document, null),
    title: document.title,
    issuerOrSender: document.issuer,
    category: document.category,
    classifiedKind: document.classifiedKind ?? null,
    issueDate: document.issueDate,
    validUntil: document.validUntil,
    documentNature,
    recognizedText,
    recognizedDataLines: document.tags.map((tag) => `Tag: ${sanitizeAiText(tag)}`),
    linkedVorgangId: confirmedLink ? document.linkedVorgang!.vorgangId : null,
    linkedVorgangTitle: confirmedLink ? document.linkedVorgang!.vorgangTitle : undefined,
    digitalFolderPath: document.digitalFolder?.path,
    paperFolderLabel: document.paperFolder?.label,
    missingDocuments: [],
    tags: document.tags,
    uncertainFieldNotes: withTestNatureNote(quality.uncertainFieldNotes, documentNature, lang),
    missingFieldNotes: quality.missingFieldNotes,
  };
}

/**
 * DOCUMENT-ARCHIVE-TRUTH-03A3 — archive free-question context with shared TruthView when usable.
 * Fallback: previous CompanyDocument / OCR context when adapter returns no truthView.
 */
/**
 * DOKUMENT-ASSISTENT-01E — der semantische Kern fuer den Assistenten.
 *
 * Beim Eingangsposten ist er bereits berechnet und liegt am Arbeitsstand; er
 * wird nur durchgereicht. Beim Archivdokument gibt es keinen gespeicherten
 * Kern, wohl aber den erkannten Text — daraus liest ihn derselbe Dienst aus
 * 01B. Es entsteht keine zweite Auswertung und keine zweite Wahrheit.
 */
/**
 * EINGANG-01D-2 — der KI-Kontext einer Gutschrift folgt der Hauptdokument-Wahrheit.
 *
 * Der Kern liest den ganzen Text; eine angehängte oder zitierte Rechnung
 * brächte ihre Zahlungsfrist und Forderung mit. Für eine Gutschrift entfallen
 * deshalb Zahlungsfristen und Forderungsbeträge — die übrigen Angaben bleiben
 * als Kontext erhalten. Andere Dokumentarten bleiben unverändert.
 */
/**
 * EINGANG-01D-2 Nacharbeit 1 — die aufgelöste DocumentWorkTruth einer Gutschrift.
 *
 * Die Wahrheitszeilen stammen aus dem gespeicherten Analyseergebnis über den
 * ganzen Text. Hängt die Originalrechnung an, stünden ihre Frist, ihr
 * Rechnungs-Arbeitsschritt und ihre Forderung als „aufgelöste Wahrheit" der
 * Gutschrift im Prompt. Projiziert wird deshalb auf die kanonische
 * Hauptdokument-Wahrheit: Frist nur die kanonische, nächster Schritt aus der
 * Einschätzung, keine Rechnungsnummer, keine Rechnungs-/Zahlungsaussage.
 * Vom Nutzer bestätigte oder korrigierte Zeilen bleiben unverändert.
 * Das gespeicherte Analyseergebnis wird nicht verändert.
 */
const USER_OWNED_TRUTH_LINE = /\[Nutzer(?:bestätigung|korrektur)\]$/;
const INVOICE_OR_PAYMENT_WORDING = /rechnung|forderung|zahlbar|zu zahlen|zahlung|fällig|faellig|mahn/i;

function toDisplayDay(iso: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return parts ? `${parts[3]}.${parts[2]}.${parts[1]}` : iso;
}

export function projectCreditNoteTruthFactLines(
  lines: readonly string[] | undefined,
  options: { canonicalDeadline?: string | null; nextStepLabel?: string },
): string[] | undefined {
  if (!lines) return undefined;
  const projected: string[] = [];
  for (const line of lines) {
    if (USER_OWNED_TRUTH_LINE.test(line)) {
      projected.push(line);
      continue;
    }
    const label = line.split(':')[0]!.trim();
    if (label === 'Frist' || label === 'Nächster Schritt') continue;
    if (/rechnungsnummer/i.test(line)) continue;
    if ((label === 'Zusammenfassung' || label === 'Bestätigungserfordernis') && INVOICE_OR_PAYMENT_WORDING.test(line)) {
      continue;
    }
    projected.push(line);
  }
  const deadline = options.canonicalDeadline?.trim();
  if (deadline && !projected.some((line) => line.startsWith('Frist:'))) projected.push(`Frist: ${toDisplayDay(deadline)}`);
  if (options.nextStepLabel) projected.push(`Nächster Schritt: ${options.nextStepLabel}`);
  return projected;
}

/** Was die Projektion einer Gutschrift braucht: kanonische Frist und nächster Schritt der Einschätzung. */
type CreditNoteFrame = { canonicalDeadline: string | null | undefined; nextStepLabel?: string };

function creditNoteNextStepLabel(item: InboxItem, lang: AppLanguage): string | undefined {
  const nextStepKey = resolveCreditNoteNextStepLabelKey(
    item,
    getCompanyProfileStoreSnapshot()?.companyName,
    getAllExpenses().some((expense) => expense.linkedInboxId === item.id),
  );
  return nextStepKey ? t(nextStepKey, lang) : undefined;
}

/** Gutschrift im Eingang (oder Archiv mit vorhandenem Eingangselement): Frame aus der kanonischen Eingangswahrheit. */
function creditNoteFrameFromInbox(item: InboxItem | undefined, lang: AppLanguage): CreditNoteFrame | null {
  if (!item || item.classifiedKind !== 'gutschrift') return null;
  return { canonicalDeadline: item.deadline, nextStepLabel: creditNoteNextStepLabel(item, lang) };
}

/** Bei einer Gutschrift folgt die aufgelöste Wahrheit dem Hauptdokument (kanonische Frist, Einschätzung). */
function alignTruthFieldsWithCreditNote<T extends { documentWorkTruthFactLines?: string[] }>(
  fields: T,
  frame: CreditNoteFrame | null,
): T {
  if (!frame) return fields;
  return {
    ...fields,
    documentWorkTruthFactLines: projectCreditNoteTruthFactLines(fields.documentWorkTruthFactLines, frame),
  };
}

/*
 * EINGANG-01D-2 Nacharbeit 2 — Archiv-Parität.
 *
 * Ein abgelegter Eingang trägt seine erkannten Felder als `Schlüssel: Wert`-
 * Zeilen im Archivtext — darunter strukturierte Felder einer angehängten
 * Rechnung („Frist", „Rechnungsnummer") und den Originaltext (`_extractedText`,
 * `_pageTexts`). Für Bedeutung und kanonische Frist zählt wie im Eingang nur
 * der Originaltext, nie die Feldliste.
 */
/** `pageCount` nur bei echter, gelesener Seitenstruktur — nie geschätzt. */
type ArchivedSourceText = { text?: string; firstPage?: string; pageCount?: number };

const ARCHIVED_FIELD_START = /\n_[A-Za-z0-9]+: /;

function readArchivedField(archived: string | undefined, key: string): string | undefined {
  if (!archived) return undefined;
  const marker = `${key}: `;
  const at = archived.startsWith(marker) ? 0 : archived.indexOf(`\n${marker}`) + 1;
  if (at === 0 && !archived.startsWith(marker)) return undefined;
  const rest = archived.slice(at + marker.length);
  const end = rest.search(ARCHIVED_FIELD_START);
  const value = (end >= 0 ? rest.slice(0, end) : rest).trim();
  return value || undefined;
}

/*
 * Nacharbeit 3 — `_pageTexts` ist `JSON.stringify(...)` und damit genau eine
 * Zeile (Zeilenumbrüche der Seiten sind escaped). Dahinter folgen im Archivtext
 * weitere Felder und der angehängte Vorschlagstext; gelesen wird deshalb nur
 * die eigene Zeile. Nur ein gültiges Seiten-JSON zählt als Seitenstruktur.
 */
function readArchivedPageTexts(archived: string | undefined): string[] | undefined {
  if (!archived) return undefined;
  const marker = '_pageTexts: ';
  let at = archived.startsWith(marker) ? 0 : archived.indexOf(`\n${marker}`);
  while (at >= 0) {
    const start = at === 0 && archived.startsWith(marker) ? marker.length : at + 1 + marker.length;
    const lineEnd = archived.indexOf('\n', start);
    const pages = parsePageTextList(archived.slice(start, lineEnd >= 0 ? lineEnd : undefined));
    if (pages) return pages;
    at = archived.indexOf(`\n${marker}`, start);
  }
  return undefined;
}

function readArchivedSourceText(document: CompanyDocument, sourceItem: InboxItem | undefined): ArchivedSourceText {
  const pages =
    parsePageTextList(sourceItem?.recognizedData._pageTexts) ?? readArchivedPageTexts(document.recognizedText);
  const text =
    sourceItem?.recognizedData._extractedText?.trim() ||
    pages?.join('\n').trim() ||
    readArchivedField(document.recognizedText, '_extractedText');
  return {
    ...(text ? { text } : {}),
    ...(pages?.[0]?.trim() ? { firstPage: pages[0]!.trim(), pageCount: pages.length } : {}),
  };
}

/**
 * Kanonische Frist einer abgelegten Gutschrift ohne Eingangselement —
 * Paritätsfix 1: exakt die 01D-1-Regel der Aufnahme (nur Seite 1, sonst der
 * Originaltext; keine Zahlungsfrist; kein Rückgriff auf das Feld „Frist").
 */
function deriveArchivedCreditNoteDeadline(source: ArchivedSourceText): string | null {
  if (!source.text && !source.firstPage) return null;
  return resolveCreditNoteDeadline({ recognizedText: source.text, firstPage: source.firstPage }).deadline;
}

/** Gutschrift im Archiv ohne Eingangselement: Frame allein aus dem archivierten Dokument. */
function creditNoteFrameFromArchive(
  document: CompanyDocument,
  source: ArchivedSourceText,
  lang: AppLanguage,
): CreditNoteFrame | null {
  if (document.classifiedKind !== 'gutschrift') return null;
  const markers = detectFinanceDocumentMarkers(source.text ?? document.recognizedText, {
    firstPageText: source.firstPage ?? null,
  });
  const financeReviewReason = resolveFinanceReviewReason(markers) ?? undefined;
  const sourceId = document.sourceInboxItemId ?? document.archiveTruthSnapshot?.sourceInboxItemId;
  const archivedItem = {
    id: sourceId ?? document.id,
    classifiedKind: 'gutschrift',
    sender: document.issuer,
    ...(financeReviewReason ? { financeReviewReason } : {}),
  } as InboxItem;
  return {
    canonicalDeadline: deriveArchivedCreditNoteDeadline(source),
    nextStepLabel: creditNoteNextStepLabel(archivedItem, lang),
  };
}

/**
 * Bedeutung einer abgelegten Gutschrift: aus dem Originaltext, mit demselben
 * Abgleich wie im Eingang (keine Zahlungsfrist, keine Forderung an uns).
 *
 * Nacharbeit 4 — zwei Ebenen: Die operative Hauptfrist (`Frist:` der Truth)
 * ist genau eine; die Bedeutung darf mehrere eigene Pflichten des
 * Hauptdokuments tragen. Fremd sind nur Pflichten und Termine späterer Seiten.
 * Mit echter Seitenstruktur kommen Fristen, Pflichten und Anliegen deshalb von
 * Seite 1 (dieselbe Kern-Engine); die kanonische Frist eines Eingangselements
 * bleibt sichtbar, auch wenn sie nicht auf Seite 1 steht. Ohne Seitenstruktur
 * wird nichts weiter entfernt — es wird keine Seitengrenze erfunden. Ohne
 * Originaltext (nur Feldliste) bleibt es bei der kanonischen Frist.
 */
function resolveArchivedCreditNoteSemanticCore(
  source: ArchivedSourceText,
  document: CompanyDocument,
  fromInterpretation: DocumentSemanticCore | null,
  canonicalDeadline: string | null | undefined,
): DocumentSemanticCore | undefined {
  const core = alignSemanticCoreWithCreditNote(
    resolveSemanticCore({
      fromInterpretation,
      text: source.text ?? document.recognizedText,
      sender: document.issuer,
    }),
    'gutschrift',
  );
  if (!core) return core;
  const canonical = canonicalDeadline?.trim().slice(0, 10) || null;
  /*
   * Ohne Originaltext liest der Kern nur die erkannte Feldliste — darunter
   * Felder einer angehängten Rechnung („Frist"). Daraus entsteht keine eigene
   * Pflicht: Handlungsbedarf nur für die kanonische Frist (fail closed wie
   * bisher).
   */
  if (!source.text) {
    const { primaryActionDeadline, ...rest } = core;
    const keepsCanonical = (frist: SemanticDeadline) => !frist.actionRequired || frist.date.slice(0, 10) === canonical;
    return {
      ...rest,
      ...(primaryActionDeadline && keepsCanonical(primaryActionDeadline) ? { primaryActionDeadline } : {}),
      deadlines: core.deadlines.filter(keepsCanonical),
      obligations: core.obligations.filter(
        (pflicht) => pflicht.who !== 'own_company' || !pflicht.byWhen || pflicht.byWhen.slice(0, 10) === canonical,
      ),
    };
  }
  if (!source.firstPage || (source.pageCount ?? 0) < 2) return core;
  // Paritätsfix 1 — dieselbe Seite-1-Projektion wie im Eingang.
  return projectCreditNoteCoreToPageOne(core, source.firstPage, canonical);
}

/**
 * Paritätsfix 1 — die Bedeutung einer Gutschrift mit Seitenstruktur folgt im
 * Eingang derselben Seite-1-Projektion wie im Archiv (kanonisch: `item.deadline`).
 */
function alignInboxSemanticCoreWithCreditNote(
  core: DocumentSemanticCore | undefined,
  item: InboxItem,
): DocumentSemanticCore | undefined {
  const pageOne = core ? creditNotePageOneTextOfItem(item) : undefined;
  return core && pageOne ? projectCreditNoteCoreToPageOne(core, pageOne, item.deadline) : core;
}

function resolveSemanticCore(input: {
  fromInterpretation?: DocumentSemanticCore | null;
  text?: string;
  sender?: string;
}): DocumentSemanticCore | undefined {
  if (input.fromInterpretation) return input.fromInterpretation;
  const text = input.text?.trim();
  if (!text) return undefined;
  const core = buildDocumentSemanticCore({
    text,
    companyProfile: getCompanyProfileStoreSnapshot() ?? null,
  });
  const kandidaten = findSemanticPartyCandidates({
    text,
    sender: input.sender,
    customers: getCustomerStoreSnapshot(),
    vorgaenge: getAllVorgaenge(),
  });
  return {
    ...core,
    customerCandidates: kandidaten.customerCandidates,
    vorgangCandidates: kandidaten.vorgangCandidates,
  };
}

/**
 * EINGANG-01D-2 Archiv-Detailfix 1 — Quelle der sichtbaren Bedeutung einer
 * archivierten Gutschrift mit Seitenstruktur: Seite 1 als Text und die
 * kanonische Frist aus demselben Frame wie der Archiv-KI-Kontext (mit
 * Eingangselement dessen Wahrheit, sonst das archivierte Dokument). Nur
 * lesend; ohne echte Seitenstruktur oder bei anderen Dokumentarten `null`.
 */
/**
 * EINGANG-02A-3 — der Hauptdokumenttext eines archivierten institutionellen
 * Schreibens mit sicher abgegrenzter Fremdanlage; sonst `null`. Dieselben
 * Seitenrollen wie im Eingang (`mainDocumentPageScope`), dieselben Seitentexte
 * wie bei der Gutschrift (01D-2), keine neue Leseregel.
 */
export function resolveArchivedMainDocumentText(document: CompanyDocument): string | null {
  const sourceItem = document.sourceInboxItemId ? getInboxItemById(document.sourceInboxItemId) : undefined;
  const pages = parsePageTextList(sourceItem?.recognizedData._pageTexts) ?? readArchivedPageTexts(document.recognizedText);
  return mainDocumentTextFromPages(pages, resolveMainDocumentPageScope(pages)) ?? null;
}

export function resolveArchivedCreditNoteMeaningSource(
  document: CompanyDocument,
): { text: string; mainDocument: MeaningMainDocument } | null {
  const lang = getCachedSetup()?.language ?? 'de';
  const sourceItem = document.sourceInboxItemId ? getInboxItemById(document.sourceInboxItemId) : undefined;
  const source = readArchivedSourceText(document, sourceItem);
  if (!source.firstPage || (source.pageCount ?? 0) < 2) return null;
  const frame = sourceItem ? creditNoteFrameFromInbox(sourceItem, lang) : creditNoteFrameFromArchive(document, source, lang);
  if (!frame) return null;
  return {
    text: source.firstPage,
    mainDocument: { classifiedKind: 'gutschrift', deadline: frame.canonicalDeadline ?? null },
  };
}

export function buildDocumentAiContextFromDocument(document: CompanyDocument): DocumentAiContext {
  const lang = getCachedSetup()?.language ?? 'de';
  const { truthView: truth } = resolveDocumentWorkTruthViewForCompanyDocument({ document });
  if (!truth) {
    return buildLegacyDocumentAiContextFromDocument(document, lang);
  }

  const sourceItem = document.sourceInboxItemId ? getInboxItemById(document.sourceInboxItemId) : undefined;
  const archivedSource = readArchivedSourceText(document, sourceItem);
  // Mit Eingangselement gilt dessen kanonische Wahrheit, sonst das archivierte Dokument selbst (Snapshot).
  const creditFrame = sourceItem
    ? creditNoteFrameFromInbox(sourceItem, lang)
    : creditNoteFrameFromArchive(document, archivedSource, lang);
  const truthFields = alignTruthFieldsWithCreditNote(buildDocumentAiTruthPromptFields(truth), creditFrame);
  const bi = truth.businessInterpretation;
  const issuerDiscarded = slotIsDiscarded(truth, 'facts.parties.counterparty');
  const deadlineDiscarded = slotIsDiscarded(truth, 'facts.timeline.deadline');

  const quality = collectDocumentQualityNotes(document, lang, {
    suppressStructuredDeadline: truthFields.suppressStructuredDeadline,
    suppressIssuerHint: truthFields.suppressIssuerHint,
    issuerDiscarded,
    deadlineDiscarded,
  });
  const confirmedLink = Boolean(document.linkedVorgang?.vorgangId);
  const recognizedText = document.recognizedText
    ? sanitizeAiText(truncateText(document.recognizedText))
    : undefined;
  const documentNature = detectDocumentNature({
    title: document.title,
    recognizedText: document.recognizedText,
  });

  // Confirmed/corrected: same suppress as inbox. Discarded: clear structured hints without
  // setting suppress flags (avoids prompt text "siehe bestätigte Nutzerdaten").
  let issuerOrSender = document.issuer;
  if (truthFields.suppressIssuerHint) {
    issuerOrSender = bi?.facts.parties.counterparty?.name?.trim() || document.issuer;
  } else if (issuerDiscarded) {
    issuerOrSender = '';
  }

  let validUntil = document.validUntil;
  let deadline: string | undefined;
  if (truthFields.suppressStructuredDeadline) {
    deadline = bi?.facts.timeline.deadline?.value?.trim() || undefined;
    validUntil = null;
  } else if (deadlineDiscarded) {
    validUntil = null;
  }

  return {
    sourceType: 'document',
    /* 01E — Archivdokumente tragen keinen gespeicherten Kern; er wird aus dem erkannten Text gelesen. */
    semantic: creditFrame
      ? resolveArchivedCreditNoteSemanticCore(archivedSource, document, bi?.semantic ?? null, creditFrame.canonicalDeadline)
      : resolveArchivedDocumentSemanticCore(document, bi?.semantic ?? null),
    title: document.title,
    issuerOrSender,
    category: document.category,
    classifiedKind: document.classifiedKind ?? null,
    issueDate: document.issueDate,
    validUntil,
    deadline,
    // No structured archive amountHint — avoids re-injecting discarded/confirmed OCR amounts.
    amountHint: null,
    documentNature,
    recognizedText,
    recognizedDataLines: document.tags.map((tag) => `Tag: ${sanitizeAiText(tag)}`),
    linkedVorgangId: confirmedLink ? document.linkedVorgang!.vorgangId : null,
    linkedVorgangTitle: confirmedLink ? document.linkedVorgang!.vorgangTitle : undefined,
    digitalFolderPath: document.digitalFolder?.path,
    paperFolderLabel: document.paperFolder?.label,
    missingDocuments: [],
    tags: document.tags,
    uncertainFieldNotes: withTestNatureNote(quality.uncertainFieldNotes, documentNature, lang),
    missingFieldNotes: quality.missingFieldNotes,
    documentWorkTruthFactLines: truthFields.documentWorkTruthFactLines,
    documentWorkTruthConflictLines: truthFields.documentWorkTruthConflictLines,
    confirmedUserFactLines: truthFields.confirmedUserFactLines,
    suppressAmountHint: truthFields.suppressAmountHint,
    suppressStructuredDeadline: truthFields.suppressStructuredDeadline,
    suppressIssuerHint: truthFields.suppressIssuerHint,
  };
}

export function buildDocumentAiContextFromInbox(
  item: InboxItem,
  options?: {
    liveWorkflow?: WorkflowResult | null;
    sessionFillConfirmRows?: readonly DocumentFieldFillConfirmRow[] | null;
  },
): DocumentAiContext {
  const lang = getCachedSetup()?.language ?? 'de';
  const vertragstext =
    item.recognizedData._vertragstext ?? item.recognizedData.Vertragstext ?? '';
  const recognizedText = truncateText(
    [item.title, item.sender, item.officePilotSuggestion, vertragstext]
      .concat(
        Object.entries(item.recognizedData)
          .filter(([key]) => key !== '_vertragstext' && key !== 'Vertragstext')
          .map(([, value]) => value),
      )
      .filter(Boolean)
      .join('\n'),
  );

  const explanation = getLetterExplanation(item);
  const contract = analyzeContractFromInbox(item);
  const confirmedLink = Boolean(item.vorgangId);
  const documentNature = detectDocumentNature({
    title: item.title,
    recognizedText,
  });

  const truth = buildDocumentWorkTruthViewForInboxItem({
    item,
    liveWorkflow: options?.liveWorkflow ?? null,
    sessionFillConfirmRows: options?.sessionFillConfirmRows ?? null,
  });
  const truthFields = alignTruthFieldsWithCreditNote(
    buildDocumentAiTruthPromptFields(truth),
    creditNoteFrameFromInbox(item, lang),
  );

  const quality = collectInboxQualityNotes(item, lang, {
    suppressAmountHint: truthFields.suppressAmountHint,
    suppressStructuredDeadline: truthFields.suppressStructuredDeadline,
    suppressIssuerHint: truthFields.suppressIssuerHint,
  });

  const bi = truth?.businessInterpretation;
  const issuerOrSender = truthFields.suppressIssuerHint
    ? bi?.facts.parties.counterparty?.name?.trim() || item.sender
    : item.sender;
  // EINGANG-01D-2 — bei einer Gutschrift gilt nur die kanonische Frist des Hauptdokuments.
  const isCreditNote = item.classifiedKind === 'gutschrift';
  const deadline = truthFields.suppressStructuredDeadline
    ? bi?.facts.timeline.deadline?.value?.trim() || undefined
    : isCreditNote
      ? item.deadline ?? undefined
      : item.deadline ?? item.recognizedData.Frist ?? undefined;
  const amountHint = truthFields.suppressAmountHint ? null : pickAmountHint(item.recognizedData);

  const recognizedDataForLines = { ...item.recognizedData };
  if (truthFields.suppressIssuerHint) {
    delete recognizedDataForLines.Absender;
    delete recognizedDataForLines.Kunde;
    delete recognizedDataForLines.Lieferant;
  }
  if (truthFields.suppressStructuredDeadline) {
    delete recognizedDataForLines.Frist;
  }
  if (isCreditNote) {
    // Frist und Rechnungsnummer können aus einer zitierten Rechnung stammen; die Gutschrift trägt ihre eigene Nummer.
    delete recognizedDataForLines.Frist;
    delete recognizedDataForLines.Rechnungsnummer;
    delete recognizedDataForLines.rechnungsnummer;
    const creditNumber = resolveCreditNoteNumber(item.recognizedData._extractedText);
    if (creditNumber) recognizedDataForLines.Gutschriftsnummer = creditNumber;
    // Nacharbeit 1 — der Volltext steht als Quelltext im OCR-Abschnitt, nicht unter den erkannten Daten.
    for (const key of Object.keys(recognizedDataForLines)) {
      if (key.startsWith('_')) delete recognizedDataForLines[key];
    }
  }
  if (truthFields.suppressAmountHint) {
    delete recognizedDataForLines.Betrag;
    delete recognizedDataForLines.Gesamtbetrag;
    delete recognizedDataForLines.Brutto;
    delete recognizedDataForLines.Netto;
    delete recognizedDataForLines.Amount;
    delete recognizedDataForLines.Summe;
  }

  let letterSummary = explanation
    ? {
        about: sanitizeAiText(blockToPlainText(explanation.about)),
        deadline: sanitizeAiText(blockToPlainText(explanation.deadline)),
        nextSteps: sanitizeAiText(blockToPlainText(explanation.nextSteps)),
      }
    : undefined;
  if (letterSummary && truthFields.suppressStructuredDeadline) {
    letterSummary = {
      ...letterSummary,
      deadline: '(durch Nutzer bestätigt — siehe bestätigte Fakten)',
    };
  }

  const prioritized = buildPrioritizedDocumentGuidance(item, options?.liveWorkflow ?? null, lang, {
    sessionFillConfirmRows: options?.sessionFillConfirmRows ?? null,
  });
  const missingFieldNotes = [...quality.missingFieldNotes];
  for (const line of prioritized.missing) {
    pushUniqueText(missingFieldNotes, line.text);
  }

  return {
    sourceType: 'inbox',
    /* 01E — aus 01B berechnet, durch 01C ueber das Wiederoeffnen gerettet. */
    semantic: alignInboxSemanticCoreWithCreditNote(
      alignSemanticCoreWithCreditNote(
        resolveSemanticCore({
          fromInterpretation: bi?.semantic ?? null,
          // EINGANG-02A-3 — bei abgegrenzter Fremdanlage nur das Hauptschreiben.
          text: getInboxExtractedDocumentText(item) || vertragstext,
          sender: item.sender,
        }),
        item.classifiedKind,
      ),
      item,
    ),
    title: item.title,
    issuerOrSender,
    category: item.documentType,
    classifiedKind: item.classifiedKind ?? null,
    deadline,
    amountHint,
    documentNature,
    recognizedText: sanitizeAiText(recognizedText),
    recognizedDataLines: buildRecognizedDataLines(recognizedDataForLines),
    linkedVorgangId: confirmedLink ? item.vorgangId : null,
    linkedVorgangTitle: confirmedLink ? item.vorgangTitle : undefined,
    digitalFolderPath: item.digitalFolder?.path,
    paperFolderLabel: item.paperFiling?.label,
    letterSummary,
    missingDocuments: contract.isContract
      ? contract.requiredDocuments.map((doc) => doc.reason || doc.type.replace(/_/g, ' '))
      : [],
    tags: [],
    uncertainFieldNotes: withTestNatureNote(quality.uncertainFieldNotes, documentNature, lang),
    missingFieldNotes,
    documentWorkTruthFactLines: truthFields.documentWorkTruthFactLines,
    documentWorkTruthConflictLines: truthFields.documentWorkTruthConflictLines,
    confirmedUserFactLines: truthFields.confirmedUserFactLines,
    suppressAmountHint: truthFields.suppressAmountHint,
    suppressStructuredDeadline: truthFields.suppressStructuredDeadline,
    suppressIssuerHint: truthFields.suppressIssuerHint,
  };
}

export function buildDocumentAiAllowedSourceText(context: DocumentAiContext): string {
  return [
    /* 01F — Betriebsdaten sind ebenfalls erlaubte Quelle. */
    ...(context.operationalLines ?? []),
    /* 01E — was der semantische Kern belegt, ist erlaubte Quelle. */
    buildSemanticAllowedSourceText(context.semantic),
    context.title,
    context.issuerOrSender,
    context.category,
    context.classifiedKind ?? '',
    context.documentNature ?? '',
    context.deadline ?? '',
    context.validUntil ?? '',
    context.issueDate ?? '',
    context.amountHint ?? '',
    context.recognizedText ?? '',
    ...context.recognizedDataLines,
    context.linkedVorgangId ?? '',
    context.linkedVorgangTitle ?? '',
    context.digitalFolderPath ?? '',
    context.paperFolderLabel ?? '',
    context.letterSummary?.about ?? '',
    context.letterSummary?.deadline ?? '',
    context.letterSummary?.nextSteps ?? '',
    ...context.missingDocuments,
    ...context.tags,
    ...context.uncertainFieldNotes,
    ...context.missingFieldNotes,
    ...(context.confirmedUserFactLines ?? []),
    ...(context.documentWorkTruthFactLines ?? []),
    ...(context.documentWorkTruthConflictLines ?? []),
    hasStructuredDeadlineEvidence(context) ? 'structured_deadline_evidence' : '',
  ].join('\n');
}
