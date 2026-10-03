import type { TranslationKey } from '../i18n';
import type {
  ClassifiedDocumentKind,
  ContractAnalysisResult,
  ContractSuggestedAction,
  DocumentActionId,
  InboxItem,
} from '../types/models';
import type { ExpenseInput } from '../types/expense';
import { getClassificationForItem } from './documentClassificationService';
import { mapClassifiedKindToExpenseCategory } from './expenseCategoryMapping';
import { addExpense, getAllExpenses } from './expenseService';
import {
  isFinanceReferenceOnlyKind,
  resolveDocumentFinanceReference,
} from './documentFinanceReferenceService';
import { getInboxItemById, patchInboxItem } from './inboxService';
import { buildInvoiceCreatePath } from './invoiceNavigation';
import { MANUAL_INVOICE_ROUTE } from './invoice/manualInvoiceFlow';
import { createTaskForItem } from './inboxTaskService';
import { parseSafeDocumentDate } from '../utils/documentDateDisplay';
import { isClassificationKindWithTasks } from './taskEngineService';
import { getTodayIso } from './taskNormalize';
import { scanPendingItems } from './pendingEngineService';
import { getAllVorgaenge } from './vorgangService';
import { analyzeUploadedDocument } from './intakeWorkflowService';
import { resolveAccountingGate } from './document/documentAccountingGateService';
import { buildDocumentSemanticCore } from './document/documentSemanticCoreService';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import { resolveInboxDocumentText } from './document/documentSourceTextService';
import { getCompanyProfileStoreSnapshot } from './companyProfileService';
import { isOwnCompanyName } from './customerOwnCompanyGuard';
import {
  resolvePrimaryTargetObjectForDocumentType,
  resolvePrimaryTargetObjectForKind,
} from './documentPrimaryTargetService';

function inboxKommunikationPath(inboxId: string): string {
  return `/kommunikation?context=inbox&id=${encodeURIComponent(inboxId)}`;
}

export type OfficeActionDelegate =
  | 'confirmFiling'
  | 'importArchive'
  | 'createTask'
  | 'openVorgangDialog'
  | 'dispose'
  | 'saveAnyway'
  | 'expandDetails'
  /**
   * DUNNING-CHECK-PAYMENT-EXECUTION-01B — zeigt auf den Bezugsbeleg-Bereich.
   *
   * Bewusst ein eigener Wert statt einer Umdeutung von `expandDetails`: Der
   * wird auch ausserhalb dieses Flusses genutzt (`executeScanResultAction`) und
   * behält seine Bedeutung unverändert.
   */
  | 'focusFinanceReference'
  | 'goBack';

export type OfficeActionResult =
  | {
      ok: true;
      kind: 'navigate';
      route: string;
      messageKey?: TranslationKey;
    }
  | {
      ok: true;
      kind: 'delegate';
      delegate: OfficeActionDelegate;
    }
  | {
      ok: true;
      kind: 'done';
      messageKey: TranslationKey;
      updatedItem?: InboxItem;
    }
  | {
      ok: false;
      errorKey: TranslationKey;
    };

function parseGermanAmount(value: string | undefined): number | null {
  if (!value?.trim()) return null;
  const cleaned = value.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) && parsed !== 0 ? parsed : null;
}

function resolveClassifiedKind(item: InboxItem): ClassifiedDocumentKind | undefined {
  const workflow = analyzeUploadedDocument(item.id);
  return workflow?.classifiedKind ?? item.classifiedKind;
}

function resolvePrimaryTargetForInboxItem(
  item: InboxItem,
  kind?: ClassifiedDocumentKind,
) {
  if (kind) return resolvePrimaryTargetObjectForKind(kind);
  return resolvePrimaryTargetObjectForDocumentType(item.documentType);
}

/**
 * DOCUMENT-BELEGNUMMER-CONSISTENCY-01 — die fünf Belegarten (tankbeleg,
 * ec_beleg, kassenbeleg, kreditkartenbeleg, quittung) legen ihren erkannten
 * Identifikator bewusst unter `Belegnummer` ab; nur Rechnungsdokumente nutzen
 * `Rechnungsnummer`. Ohne diesen Rückfall ging die erkannte Nummer beim
 * Anlegen einer Ausgabe verloren und der Dedupe-Schlüssel kollabierte auf
 * `<lieferant>|` — der **zweite** Beleg desselben Lieferanten wurde dann als
 * Duplikat abgelehnt.
 *
 * Dieselbe Vorrangregel gilt bereits in `documentSummary.rd(item,
 * 'Rechnungsnummer', 'Belegnummer')`. Bewusst lokal gehalten: kein neuer
 * exportierter Helfer, keine globale Normalisierung.
 */
function resolveExpenseIdentifier(item: InboxItem): string {
  const candidates = [
    item.recognizedData.Rechnungsnummer,
    item.recognizedData.rechnungsnummer,
    item.recognizedData.Belegnummer,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    // Ein reiner Whitespace-Wert darf den nächsten sinnvollen Wert nicht blockieren.
    if (trimmed) return trimmed;
  }
  return '';
}

function toIsoDay(value: string | null | undefined): string | undefined {
  const parsed = parseSafeDocumentDate(value);
  if (!parsed) return undefined;
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${parsed.getFullYear()}-${month}-${day}`;
}

/*
 * EINGANG-01A (P0) — die Beispielwerte, die die Erkennung früher ohne Beleg
 * eintrug. Ältere Eingänge können sie noch tragen.
 */
const LEGACY_SAMPLE_AMOUNTS = new Set(['342,16 €', '85,40 €']);
const LEGACY_SAMPLE_INVOICE_NUMBERS = new Set(['RE-2026-0001']);

function amountSpellings(amount: number): string[] {
  const fixed = amount.toFixed(2);
  const [whole, cents] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return [`${whole},${cents}`, `${grouped},${cents}`, fixed];
}

/**
 * EINGANG-01A (P0) — Ist der Betrag, der gebucht würde, belegt?
 *
 * Nicht belegt ist ein Betrag, der als früherer Beispielwert (oder als
 * „ca."-Schätzung) im Eingang steht und nicht im Dokumenttext vorkommt, und
 * jeder Betrag, der im vorhandenen Dokumenttext gar nicht vorkommt. Dasselbe
 * gilt für die frühere Beispiel-Rechnungsnummer. Ohne gespeicherten Text bleibt
 * es bei der bisherigen Prüfung (Betrag lesbar) — ein erfundener Beispielwert
 * wird aber auch dann nicht still gebucht.
 */
export function isInboxBookingDataEvidenced(item: InboxItem, grossAmount: number): boolean {
  const rawAmount = (item.recognizedData.Betrag ?? item.recognizedData.betrag ?? '').trim();
  const invoiceNumber = resolveExpenseIdentifier(item);
  const text = getInboxExtractedDocumentText(item);
  const compactText = text.replace(/\s+/g, '');

  const amountInText = text
    ? amountSpellings(grossAmount).some((spelling) => compactText.includes(spelling))
    : false;
  if (text && !amountInText) return false;
  if ((LEGACY_SAMPLE_AMOUNTS.has(rawAmount) || /^ca\./i.test(rawAmount)) && !amountInText) {
    return false;
  }
  if (LEGACY_SAMPLE_INVOICE_NUMBERS.has(invoiceNumber) && !text.includes(invoiceNumber)) {
    return false;
  }
  return true;
}

/**
 * EINGANG-01D-1 Nacharbeit — Gesamtbetrag einer Lieferantengutschrift.
 *
 * Bewusst eng und nur für Gutschriften: Die vorhandenen Betragsfakten tragen
 * diese Bedeutung nicht eindeutig (im semantischen Kern ist `credit_amount`
 * jeder negative Betrag, auch eine Position; die allgemeine Gesamtbetrag-
 * Erkennung kennt „Gutschriftsbetrag"/„Gutschrift brutto" nicht). Gelesen
 * werden nur ausdrücklich beschriftete Gesamtbeträge. Ergeben sie nicht genau
 * einen Wert, gibt es keinen — das Formular bleibt dann leer.
 */
/*
 * WEISS-Nacharbeit — gedruckt wird auch „Gutschriftbetrag" ohne Fugen-s
 * (realer Fall MB-GS-2026-0311). Ohne diese Schreibweise blieb der
 * Gesamtbetrag leer und die Anzeige fiel auf den Nettobetrag zurück.
 */
const CREDIT_TOTAL_LABELED =
  /(?:gesamtbetrag|gutschrifts?betrag|gutschrift\s+brutto|bruttobetrag|brutto)\s*[:=]?\s*(?:eur\s*|€\s*)?(-?\s?\d{1,3}(?:\.\d{3})*,\d{2}|-?\s?\d+,\d{2})/gi;

/**
 * EINGANG-01D-1 Nacharbeit 2/3 (P1) — beschriftete Gesamtbeträge einer
 * Rechnung bzw. eines Belegs. Zwischen- und Nettosummen zählen nicht — auch
 * nicht mit Trennzeichen („Netto-Summe", „Netto Summe").
 *
 * Ein bloßes „Summe" ist kein sicheres Gesamtlabel: Es steht ebenso vor der
 * Nettosumme („Summe 200 / MwSt 38 / zusammen 238"). Ein Beleg mit nur einem
 * Geldbetrag („SUMME 92,95") bleibt über die Einzelbetrag-Regel sicher.
 */
const GROSS_TOTAL_LABELED =
  /(?<!(?:zwischen|netto)[\s-]*)(?:gesamtbetrag|gesamtsumme|rechnungsbetrag|rechnungssumme|bruttobetrag|brutto|zahlbetrag|endbetrag|endsumme|zu\s+zahlen|gesamt|total)(?![\s-]*netto)\s*[:=]?\s*(?:eur\s*|€\s*)?(-?\s?\d{1,3}(?:\.\d{3})*,\d{2}|-?\s?\d+,\d{2})/gi;
const ANY_MONEY_AMOUNT = /-?\s?\d{1,3}(?:\.\d{3})*,\d{2}|-?\s?\d+,\d{2}/g;

function normalizeDashes(text: string): string {
  return text.replace(/[‐-―−]/g, '-');
}

function collectAbsoluteAmounts(matches: Iterable<string>): Set<number> {
  const values = new Set<number>();
  for (const raw of matches) {
    const value = parseGermanAmount(raw.replace(/\s/g, ''));
    if (value !== null && value !== 0) values.add(Math.round(Math.abs(value) * 100) / 100);
  }
  return values;
}

/** Genau ein beschrifteter Gesamtbetrag, sonst keiner. */
function resolveUniqueLabeledTotal(text: string, pattern: RegExp): number | null {
  const values = collectAbsoluteAmounts(Array.from(normalizeDashes(text).matchAll(pattern), (match) => match[1]!));
  return values.size === 1 ? [...values][0]! : null;
}

/**
 * EINGANG-01D-1 Nacharbeit 3 (P2) — die eigene Nummer einer Gutschrift.
 *
 * Nur eine als Zeilenbeschriftung ausgewiesene Gutschriftsnummer
 * („Gutschriftsnummer: GS-1", „Gutschrift-Nr. GS-1", „Gutschrift Nr. GS-1").
 * Eine im Fließtext erwähnte oder die zitierte Rechnungsnummer zählt nicht.
 * Mehrdeutig oder nicht vorhanden → leer (nicht raten).
 */
const CREDIT_NUMBER_LABELED =
  /^[ \t]*gutschrift(?:s)?(?:nummer|[ \t-]*nr\.?)[ \t]*[:#]?[ \t]*([a-z0-9][a-z0-9/-]*)/gim;

export function resolveCreditNoteNumber(text: string | undefined | null): string {
  if (!text?.trim()) return '';
  const numbers = new Set(
    Array.from(normalizeDashes(text).matchAll(CREDIT_NUMBER_LABELED), (match) => match[1]!.replace(/[-/]+$/, ''))
      .filter((value) => /\d/.test(value)),
  );
  return numbers.size === 1 ? [...numbers][0]! : '';
}

export function resolveCreditNoteGrossTotal(text: string | undefined | null): number | null {
  if (!text?.trim()) return null;
  return resolveUniqueLabeledTotal(text, CREDIT_TOTAL_LABELED);
}

/**
 * EINGANG-01D-1 Nacharbeit 2 (P1) — welcher Bruttobetrag darf aus dem Text
 * gebucht bzw. vorbelegt werden?
 *
 * Der erkannte `Betrag` kann der erste Betrag im Text sein („Material 200"
 * vor „Gesamtbetrag 238"). Deshalb mit vorhandenem Volltext:
 *   - genau ein beschrifteter Gesamtbetrag → dieser;
 *   - sonst nur dann der erkannte Betrag, wenn im Text überhaupt nur ein
 *     Geldbetrag steht;
 *   - sonst keiner (0): keine automatische Buchung, Formular ohne Betrag.
 * Ohne Volltext (Altbestand, Zweitgerät) bleibt das bisherige Verhalten.
 */
function resolveSafeGrossAmount(item: InboxItem, printedAmount: number): number {
  const text = getInboxExtractedDocumentText(item);
  if (!text) return printedAmount;
  const labeled = resolveUniqueLabeledTotal(text, GROSS_TOTAL_LABELED);
  if (labeled !== null) return printedAmount < 0 ? -labeled : labeled;
  const amounts = collectAbsoluteAmounts(normalizeDashes(text).match(ANY_MONEY_AMOUNT) ?? []);
  return amounts.size <= 1 ? printedAmount : 0;
}

/**
 * EINGANG-01D-1 Nacharbeit 2 (P2) — eine Gutschrift, die der eigene Betrieb
 * ausgestellt hat (Gutschrift an einen Kunden), ist keine Ausgabe. Belegt nur
 * über den erkannten Absender gegen das Firmenprofil — nie über Dateinamen
 * oder Rollenwissen. Ist der Absender unklar, wird nichts behauptet.
 */
function isOwnCompanyIssuedDocument(item: InboxItem): boolean {
  const profile = getCompanyProfileStoreSnapshot();
  const companyName = profile?.companyName?.trim();
  if (!companyName) return false;
  return isOwnCompanyName(item.sender, companyName);
}

export function buildExpenseInputFromInbox(
  item: InboxItem,
  classifiedKind?: ClassifiedDocumentKind,
): ExpenseInput {
  const kind = classifiedKind ?? resolveClassifiedKind(item);
  const printedAmount =
    parseGermanAmount(item.recognizedData.Betrag) ??
    parseGermanAmount(item.recognizedData.betrag) ??
    parseGermanAmount(item.recognizedData.Amount) ??
    0;
  /*
   * EINGANG-01D-1 (P1) — eine Lieferantengutschrift ist eine Gutschrift, auch
   * wenn ihr Betrag positiv gedruckt ist. Bisher entschied allein das
   * Vorzeichen, und eine positiv gedruckte Gutschrift wurde zur offenen
   * Verbindlichkeit. Die bestehende Semantik bleibt: Gutschrift = negativer
   * Bruttobetrag (`isCreditNoteExpense`). Ein bereits negativer Betrag bleibt
   * negativ — keine doppelte Umkehr.
   */
  const isSupplierCreditNote = kind === 'gutschrift' && !item.financeReviewReason;
  /*
   * EINGANG-01D-1 Nacharbeit (P1) — der Gutschriftbetrag ist der beschriftete
   * Gesamtbetrag, nie der erste gefundene Betrag („Netto 100" vor „Gesamtbetrag
   * 119"). Ohne eindeutigen Gesamtbetrag bleibt das Feld leer — kein Raten.
   */
  /*
   * WEISS-Nacharbeit — ein gespeicherter Eingang trägt seinen Volltext nicht
   * mehr; er liegt im Arbeitsstand der Analyse. Gelesen wird über die
   * bestehende Quelle (`resolveInboxDocumentText`, Hauptdokument), sonst bliebe
   * die Vorbelegung nach dem Neuladen leer.
   */
  const gutschriftText = isSupplierCreditNote ? resolveInboxDocumentText(item) : '';
  const creditTotal = isSupplierCreditNote ? resolveCreditNoteGrossTotal(gutschriftText) : null;
  const grossAmount = isSupplierCreditNote
    ? creditTotal === null
      ? 0
      : -creditTotal
    : resolveSafeGrossAmount(item, printedAmount);

  return {
    title: item.title,
    supplierName: item.sender.trim() || 'Unbekannt',
    // Nacharbeit 3 — eine Gutschrift trägt ihre eigene Nummer, nie die der zitierten Rechnung.
    invoiceNumber: isSupplierCreditNote
      ? resolveCreditNoteNumber(gutschriftText)
      : resolveExpenseIdentifier(item),
    description: item.officePilotSuggestion ?? '',
    issueDate:
      /*
       * F-15 — erkannte Daten kommen auch als TT.MM.JJJJ; `slice(0, 10)` gab
       * sie ungeprüft als ISO weiter (10.02.2026 → „2.10.2026"). Nur eindeutige
       * Werte (ISO / TT.MM.JJJJ) werden übernommen, sonst greift der Fallback.
       */
      /*
       * EINGANG-01D-1 — eine Handlungsfrist ist kein Rechnungsdatum. Der frühere
       * Rückfall auf `item.deadline` machte aus „zahlbar bis" das Belegdatum.
       */
      toIsoDay(item.recognizedData.Datum) ??
      toIsoDay(item.recognizedData.datum) ??
      getTodayIso().slice(0, 10),
    /*
     * EINGANG-01A / 01D-1 — das Zahlungsziel nur aus einer echten Zahlungsfrist.
     * Antwort-, Unterlagen- oder Kündigungsfristen sind kein Zahlungsziel.
     */
    // Eine Gutschrift hat kein Zahlungsziel (Nacharbeit).
    paymentDueDate:
      !isSupplierCreditNote && item.deadlineType === 'payment_due' ? toIsoDay(item.deadline) : undefined,
    ...(isSupplierCreditNote ? { isCreditNote: true } : {}),
    grossAmount,
    category: kind ? mapClassifiedKindToExpenseCategory(kind) : 'material',
    linkedInboxId: item.id,
    classifiedKind: kind,
    recognizedData: { ...item.recognizedData },
    digitalFolder: { ...item.digitalFolder },
    paperFolder: item.paperFiling ? { ...item.paperFiling } : undefined,
  };
}

/**
 * DOCUMENT-ACCOUNTING-REFERENCE-SAFETY-01B — der sichere Weg für Dokumente, die
 * auf einen bestehenden Beleg **verweisen**.
 *
 * Eine Mahnung ist kein Beleg. Sie erinnert an einen, der bereits existiert.
 * Bis hierher landete „Zahlung prüfen" auf `createExpenseFromInbox` und legte
 * eine zweite Verbindlichkeit an — eine stille finanzielle Änderung ohne
 * Bestätigung. Der Weg endet jetzt in der Ansicht des gefundenen Belegs oder,
 * wenn nichts eindeutig ist, in der Dokumentprüfung. Angelegt wird nichts.
 */
function openFinanceReferenceForInbox(item: InboxItem): OfficeActionResult {
  const match = resolveDocumentFinanceReference(item);
  if (
    (match.status === 'exact' || match.status === 'already_linked') &&
    match.matched
  ) {
    return { ok: true, kind: 'navigate', route: `/ausgaben/${match.matched.targetId}` };
  }
  /*
   * DUNNING-CHECK-PAYMENT-EXECUTION-01B — alles Uneindeutige bleibt beim
   * Dokument, führt den Nutzer aber sichtbar dorthin.
   *
   * Realbefund iPhone/Safari: `expandDetails` klappte „Weitere Optionen" auf —
   * technisch aktiv, aber unterhalb des Sichtfelds und ohne Bezug zur
   * Zahlungsfrage. Für den Nutzer wirkte der Knopf kaputt.
   *
   * Der berechnete Bezugszustand bleibt unverändert die Wahrheit; hier ändert
   * sich nur, wohin die Oberfläche zeigt.
   */
  return { ok: true, kind: 'delegate', delegate: 'focusFinanceReference' };
}

/**
 * DOKUMENTVERSTAENDNIS-01B — die bedeutungsbasierte Buchungsschranke (P0).
 *
 * Sie steht vor **jedem** Weg, der aus eingegangener Post eine neue Ausgabe
 * macht. Der bisherige Schutz war eine Liste von zwei Dokumentarten und hing
 * damit an der Klassifikation; ein als „Sonstiges" erkanntes Schreiben mit
 * einem Betrag war ungeschuetzt.
 *
 * Gelesen wird jetzt zuerst der Text: Fordert das Schreiben ueberhaupt Geld von
 * uns, oder kommt der Betrag nur vor? Die Artenliste bleibt daneben bestehen
 * und kann die Entscheidung nur verschaerfen, nie lockern.
 */
function resolveInboxAccountingGate(item: InboxItem) {
  const text = getInboxExtractedDocumentText(item);
  const core = text.trim()
    ? buildDocumentSemanticCore({ text, companyProfile: getCompanyProfileStoreSnapshot() ?? null })
    : null;
  return resolveAccountingGate({ core, classifiedKind: resolveClassifiedKind(item) });
}

export function createExpenseFromInbox(item: InboxItem): OfficeActionResult {
  /*
   * DOKUMENTVERSTAENDNIS-01B — erste und wichtigste Verteidigungslinie.
   *
   * Ein Schreiben ohne Forderung an uns wird hier nie zu einer Ausgabe, und
   * ein Schreiben, das auf einen vorhandenen Beleg verweist, fuehrt zu diesem
   * Beleg statt zu einem zweiten. Nur ein echter Belegkandidat darf weiter —
   * und auch der nur bis zur Bestaetigung durch den Benutzer.
   */
  /*
   * EINGANG-01D-1 — Rechnungskorrektur/Storno und Abrechnungsgutschrift werden
   * nie automatisch gebucht: Die eine wäre eine zweite Verbindlichkeit, die
   * andere ist ein Erlös. Nur verschärfend, wie die Schranke darunter.
   */
  if (item.financeReviewReason) {
    return { ok: false, errorKey: 'document.accounting.financeReviewRequired' as TranslationKey };
  }
  /*
   * EINGANG-01D-1 Nacharbeit — eine Lieferantengutschrift wird nie aus OCR
   * gebucht, aber auch nie stillschweigend nur archiviert. Sie führt immer in
   * das bestätigte Ausgabenformular (negativer Gesamtbetrag, ohne
   * Zahlungsziel), auch wenn die Schranke sie als „keine Forderung" oder
   * „Bezug" einordnet: Eine Gutschrift fordert nichts — genau das ist ihr
   * finanzieller Effekt, und der Nutzer bestätigt ihn selbst.
   */
  if (resolveClassifiedKind(item) === 'gutschrift') {
    // Nacharbeit 2 — die eigene Gutschrift an einen Kunden ist keine Ausgabe.
    if (isOwnCompanyIssuedDocument(item)) {
      return { ok: false, errorKey: 'document.accounting.ownCreditNoteReview' as TranslationKey };
    }
    const existingCredit = getAllExpenses().find((expense) => expense.linkedInboxId === item.id);
    if (existingCredit) return { ok: true, kind: 'navigate', route: `/ausgaben/${existingCredit.id}` };
    return { ok: true, kind: 'navigate', route: `/ausgaben/neu?inboxId=${encodeURIComponent(item.id)}` };
  }
  const schranke = resolveInboxAccountingGate(item);
  if (schranke.decision === 'reference_only') return openFinanceReferenceForInbox(item);
  if (schranke.decision === 'blocked') {
    return { ok: false, errorKey: 'document.accounting.notABookingDocument' as TranslationKey };
  }
  /*
   * Zweite Verteidigungslinie: Selbst wenn ein noch unbekannter Aufrufer diesen
   * Weg für ein Bezugsdokument wählt, entsteht keine Ausgabe.
   */
  /*
   * Zweite Verteidigungslinie: Selbst wenn ein noch unbekannter Aufrufer diesen
   * Weg für ein Bezugsdokument wählt, entsteht keine Ausgabe.
   */
  if (isFinanceReferenceOnlyKind(resolveClassifiedKind(item))) {
    return openFinanceReferenceForInbox(item);
  }

  /*
   * PRODUCT-ACCEPTANCE-FIX-01B (F-15) — Idempotenz am Eingangsbezug: Für ein
   * Eingangsdokument entsteht höchstens **eine** Ausgabe. Wiederholung
   * (Doppelklick, erneuter Versuch, Reload, Wiederaufnahme) führt zum
   * bestehenden Beleg statt zu einer Dublette — unabhängig davon, ob eine
   * Belegnummer für den nummernbasierten Duplikatschlüssel vorliegt.
   */
  const alreadyCreated = getAllExpenses().find((expense) => expense.linkedInboxId === item.id);
  if (alreadyCreated) {
    return { ok: true, kind: 'navigate', route: `/ausgaben/${alreadyCreated.id}` };
  }

  const input = buildExpenseInputFromInbox(item);

  /*
   * EINGANG-01A (P0) — ohne belegten Betrag keine stille Buchung: Der Weg
   * führt in das vorhandene Formular, vorbefüllt aus dem Eingang, und der
   * Nutzer bestätigt dort selbst.
   */
  // EINGANG-01D-1 — belegt wird die gedruckte Zahl; die Gutschrift-Richtung ändert sie nicht.
  /*
   * EINGANG-01D-1 Nacharbeit 2 (P1) — automatisch gebucht wird nur, wenn der
   * sichere Gesamtbetrag aus dem Text und der erkannte Betrag übereinstimmen.
   * Weichen sie ab (erkannt „Material 200", beschriftet „Gesamtbetrag 238"),
   * bestätigt der Nutzer im Formular — vorbelegt mit dem sicheren Betrag.
   */
  const recognizedAmount =
    parseGermanAmount(item.recognizedData.Betrag) ??
    parseGermanAmount(item.recognizedData.betrag) ??
    parseGermanAmount(item.recognizedData.Amount);
  const amountAgrees = recognizedAmount !== null && Math.abs(recognizedAmount) === Math.abs(input.grossAmount);
  if (!input.grossAmount || !amountAgrees || !isInboxBookingDataEvidenced(item, Math.abs(input.grossAmount))) {
    return {
      ok: true,
      kind: 'navigate',
      route: `/ausgaben/neu?inboxId=${encodeURIComponent(item.id)}`,
    };
  }

  const result = addExpense(input);
  if (!result.success) {
    if (result.errorKey === 'expense.duplicate') {
      const existing = getAllExpenses().find((expense) => expense.linkedInboxId === item.id);
      if (existing) {
        return { ok: true, kind: 'navigate', route: `/ausgaben/${existing.id}` };
      }
    }
    return { ok: false, errorKey: result.errorKey as TranslationKey };
  }

  return {
    ok: true,
    kind: 'navigate',
    route: `/ausgaben/${result.expense.id}`,
    messageKey: 'action.expense.created',
  };
}

export function markInboxAsImportant(inboxId: string): OfficeActionResult {
  const updated = patchInboxItem(inboxId, { priority: 'hoch' });
  if (!updated) return { ok: false, errorKey: 'inbox.notFound' as TranslationKey };
  return {
    ok: true,
    kind: 'done',
    messageKey: 'action.inbox.markedImportant',
    updatedItem: updated,
  };
}

export function isDocumentActionAvailable(
  actionId: DocumentActionId,
  item: InboxItem,
  classifiedKind?: ClassifiedDocumentKind,
): boolean {
  const kind = classifiedKind ?? resolveClassifiedKind(item);
  const primaryTarget = resolvePrimaryTargetForInboxItem(item, kind);

  switch (actionId) {
    case 'confirm_filing':
      return !item.isAdvertisement;
    case 'check_deadline':
    case 'monitor_validity':
      return Boolean(item.taskTemplate) || (kind ? isClassificationKindWithTasks(kind) : false);
    case 'record_expense':
      /*
       * Ein Bezugsdokument bietet die Ausgabenanlage gar nicht erst an — sonst
       * bliebe der gefährliche Weg als Schaltfläche sichtbar. „Zahlung prüfen"
       * bleibt verfügbar und führt zur Belegprüfung.
       */
      if (isFinanceReferenceOnlyKind(kind)) return false;
      return (
        primaryTarget === 'expense' ||
        (kind ? mapClassifiedKindToExpenseCategory(kind) !== 'sonstiges' : false)
      );
    case 'check_payment':
      return (
        primaryTarget === 'expense' ||
        (kind ? mapClassifiedKindToExpenseCategory(kind) !== 'sonstiges' : false) ||
        kind === 'mahnung' ||
        kind === 'zahlungserinnerung'
      );
    case 'send_to_customer':
      return Boolean(item.vorgangId) || Boolean(item.recognizedData.Auftraggeber);
    case 'suggest_schlussrechnung':
      return Boolean(item.vorgangId);
    case 'import_hours':
      return Boolean(item.vorgangId) || kind === 'stundenzettel';
    case 'check_proof_requirements':
      return kind === 'werkvertrag' || kind === 'subunternehmervertrag' || kind === 'nachunternehmervertrag';
    case 'mark_important':
      return kind === 'mahnung' || kind === 'zahlungserinnerung' || item.priority !== 'hoch';
    case 'show_contact':
      return false;
    default:
      return true;
  }
}

export function executeDocumentAction(
  actionId: DocumentActionId,
  item: InboxItem,
  options?: { classifiedKind?: ClassifiedDocumentKind },
): OfficeActionResult {
  const classifiedKind = options?.classifiedKind ?? resolveClassifiedKind(item);

  switch (actionId) {
    case 'save_bg_bau_folder':
    case 'save_tax_folder':
    case 'save_health_folder':
    case 'confirm_filing':
      return { ok: true, kind: 'delegate', delegate: 'confirmFiling' };
    case 'check_deadline':
    case 'monitor_validity':
      if (item.taskTemplate || (classifiedKind && isClassificationKindWithTasks(classifiedKind))) {
        return { ok: true, kind: 'delegate', delegate: 'createTask' };
      }
      return { ok: false, errorKey: 'taskEngine.noTaskAvailable' };
    case 'link_vorgang':
    case 'create_vorgang':
    case 'import_positions':
      return { ok: true, kind: 'delegate', delegate: 'openVorgangDialog' };
    case 'import_hours':
      if (item.vorgangId) {
        return {
          ok: true,
          kind: 'navigate',
          route: buildInvoiceCreatePath(item.vorgangId, 'abschlag'),
        };
      }
      return { ok: true, kind: 'delegate', delegate: 'openVorgangDialog' };
    case 'check_proof_requirements':
      if (item.vorgangId) {
        return { ok: true, kind: 'navigate', route: `/vorgaenge/${item.vorgangId}` };
      }
      return { ok: true, kind: 'delegate', delegate: 'openVorgangDialog' };
    case 'suggest_schlussrechnung':
      if (item.vorgangId) {
        return {
          ok: true,
          kind: 'navigate',
          route: buildInvoiceCreatePath(item.vorgangId, 'schluss'),
        };
      }
      return { ok: false, errorKey: 'intake.positionsNeedsVorgang' };
    case 'check_payment':
    case 'record_expense':
      /*
       * DOCUMENT-ACCOUNTING-REFERENCE-SAFETY-01B — „Zahlung prüfen" heisst
       * prüfen, nicht buchen. Beide Aktionen führten bisher in dieselbe
       * Ausgabenanlage; für Bezugsdokumente ist das der belegte Fehler.
       */
      if (isFinanceReferenceOnlyKind(classifiedKind)) {
        return openFinanceReferenceForInbox(item);
      }
      return createExpenseFromInbox(item);
    case 'archive':
      return { ok: true, kind: 'delegate', delegate: 'importArchive' };
    case 'send_to_customer':
      return {
        ok: true,
        kind: 'navigate',
        route: inboxKommunikationPath(item.id),
      };
    case 'mark_important':
      return markInboxAsImportant(item.id);
    case 'create_task':
      return { ok: true, kind: 'delegate', delegate: 'createTask' };
    default:
      return { ok: false, errorKey: 'action.unsupported' as TranslationKey };
  }
}

export function isContractActionAvailable(
  actionId: ContractSuggestedAction['id'],
  _item: InboxItem,
): boolean {
  switch (actionId) {
    case 'send_freistellung':
    case 'send_aok':
      return true;
    case 'check_bg_bau':
      return true;
    default:
      return true;
  }
}

export function executeContractAction(
  actionId: ContractSuggestedAction['id'],
  item: InboxItem,
  analysis?: ContractAnalysisResult,
): OfficeActionResult {
  switch (actionId) {
    case 'create_vorgang':
    case 'import_positions':
      return { ok: true, kind: 'delegate', delegate: 'openVorgangDialog' };
    case 'archive_contract':
      return { ok: true, kind: 'delegate', delegate: 'importArchive' };
    case 'send_freistellung':
      return {
        ok: true,
        kind: 'navigate',
        route: inboxKommunikationPath(item.id),
        messageKey: 'action.communication.openForProof',
      };
    case 'send_aok':
      return {
        ok: true,
        kind: 'navigate',
        route: inboxKommunikationPath(item.id),
        messageKey: 'action.communication.openForProof',
      };
    case 'check_bg_bau':
      if (item.archiveDocumentId) {
        return {
          ok: true,
          kind: 'navigate',
          route: `/dokumente/${item.archiveDocumentId}`,
        };
      }
      if (analysis?.requiredDocuments.some((doc) => doc.type === 'bg_bau')) {
        return { ok: true, kind: 'delegate', delegate: 'importArchive' };
      }
      return { ok: true, kind: 'navigate', route: '/dokumente' };
    default:
      return { ok: false, errorKey: 'action.unsupported' as TranslationKey };
  }
}

export function isScanResultActionAvailable(actionId: string, item: InboxItem): boolean {
  switch (actionId) {
    case 'payment':
      {
        const kind = resolveClassifiedKind(item);
        const primaryTarget = resolvePrimaryTargetForInboxItem(item, kind);
        return primaryTarget === 'expense' || item.recommendedAction === 'zahlung_pruefen';
      }
    case 'openOrder':
      return Boolean(item.vorgangId);
    case 'invoice':
      return item.recommendedAction === 'rechnung_vorbereiten' || item.documentType === 'kundenauftrag';
    default:
      return true;
  }
}

export function executeScanResultAction(actionId: string, item: InboxItem): OfficeActionResult {
  switch (actionId) {
    case 'filing':
      return { ok: true, kind: 'delegate', delegate: 'confirmFiling' };
    case 'dispose':
      return { ok: true, kind: 'delegate', delegate: 'dispose' };
    case 'save':
      return { ok: true, kind: 'delegate', delegate: 'saveAnyway' };
    case 'assign':
      return { ok: true, kind: 'delegate', delegate: 'openVorgangDialog' };
    case 'invoice':
      if (item.vorgangId) {
        return {
          ok: true,
          kind: 'navigate',
          route: buildInvoiceCreatePath(item.vorgangId, 'rechnung'),
        };
      }
      return { ok: true, kind: 'delegate', delegate: 'openVorgangDialog' };
    case 'openOrder':
      if (item.vorgangId) {
        return { ok: true, kind: 'navigate', route: `/vorgaenge/${item.vorgangId}` };
      }
      return { ok: false, errorKey: 'vorgang.notFound' };
    case 'payment':
      // Derselbe Schutz auf dem Vertrags-Aktionsweg.
      if (isFinanceReferenceOnlyKind(resolveClassifiedKind(item))) {
        return openFinanceReferenceForInbox(item);
      }
      return createExpenseFromInbox(item);
    case 'review':
      return { ok: true, kind: 'delegate', delegate: 'expandDetails' };
    default:
      return { ok: false, errorKey: 'action.unsupported' as TranslationKey };
  }
}

export function resolveHeuteQuickActionRoute(key: TranslationKey): string | null {
  switch (key) {
    case 'heute.action.understandLetter':
      return '/scan';
    case 'heute.action.captureExpense':
      return '/ausgaben/neu';
    case 'heute.action.writeMessage':
      return '/kommunikation';
    case 'heute.action.askOfficePilot':
      return '/assistent';
    case 'heute.action.writeInvoice': {
      const pending = scanPendingItems().items;
      const invoicePending = pending.find((entry) => entry.kind.startsWith('invoice'));
      if (invoicePending) return invoicePending.route;

      const activeVorgang = getAllVorgaenge().find((entry) => entry.status === 'in_bearbeitung');
      if (activeVorgang) {
        return buildInvoiceCreatePath(activeVorgang.id, 'abschlag');
      }
      /*
       * MANUAL-INVOICE-UI-01B1B — „Rechnung schreiben" endet nicht mehr in der
       * Übersicht, sondern beim Schreiben: die Rechnung ohne Auftrag. Laufende
       * Rechnungen und aktive Vorgänge behalten ihren Vorrang.
       */
      return MANUAL_INVOICE_ROUTE;
    }
    case 'heute.action.openOrder': {
      const pending = scanPendingItems().items;
      const orderPending = pending.find(
        (entry) => entry.route.startsWith('/vorgaenge/') && !entry.route.includes('/rechnungen/'),
      );
      if (orderPending) return orderPending.route;

      const activeVorgang = getAllVorgaenge().find((entry) => entry.status === 'in_bearbeitung');
      if (activeVorgang) return `/vorgaenge/${activeVorgang.id}`;
      return null;
    }
    default:
      return null;
  }
}

export function filterAvailableDocumentActions(item: InboxItem) {
  const classification = getClassificationForItem(item);
  return classification.actions.filter((action) =>
    isDocumentActionAvailable(action.id, item, classification.classifiedKind),
  );
}

export interface ApplyOfficeActionContext {
  navigate: (route: string) => void;
  translate: (key: TranslationKey) => string;
  showToast: (message: string) => void;
  onItemUpdated?: (item: InboxItem) => void;
  delegates: Partial<Record<OfficeActionDelegate, () => void>>;
}

export function applyOfficeActionResult(
  result: OfficeActionResult,
  context: ApplyOfficeActionContext,
): void {
  if (!result.ok) {
    context.showToast(context.translate(result.errorKey));
    return;
  }

  if (result.kind === 'navigate') {
    if (result.messageKey) {
      context.showToast(context.translate(result.messageKey));
    }
    context.navigate(result.route);
    return;
  }

  if (result.kind === 'delegate') {
    context.delegates[result.delegate]?.();
    return;
  }

  if (result.updatedItem) {
    context.onItemUpdated?.(result.updatedItem);
  }
  context.showToast(context.translate(result.messageKey));
}

export function runCreateTaskDelegate(inboxId: string): OfficeActionResult {
  const taskResult = createTaskForItem(inboxId);
  if (!taskResult) {
    return { ok: false, errorKey: 'taskEngine.noTaskAvailable' };
  }
  return {
    ok: true,
    kind: 'done',
    messageKey: 'action.task.created',
    updatedItem: taskResult.item,
  };
}

export function getExpensePrefillForInbox(inboxId: string): ExpenseInput | null {
  const item = getInboxItemById(inboxId);
  if (!item) return null;
  // EINGANG-01D-1 Nacharbeit — ein Finanz-Prüffall bekommt keine finanzielle Vorentscheidung.
  if (item.financeReviewReason) return null;
  const kind = resolveClassifiedKind(item);
  if (kind === 'gutschrift' && isOwnCompanyIssuedDocument(item)) return null;
  return buildExpenseInputFromInbox(item, kind);
}
