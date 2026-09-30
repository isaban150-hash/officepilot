/**
 * FINANZ-CORE-DURABILITY-01D — Steuerberater-Monatsmappe: fachliches Modell.
 *
 * Reine Ableitung aus den kanonischen Finanzdaten. Kein eigener Speicher, keine
 * zweite Buchfuehrungswahrheit, keine Kontierung.
 *
 * Zuordnungsregel (eindeutig, keine Vermischung):
 *  - Ausgangsrechnung  -> Rechnungsdatum (`issueDate ?? date`)
 *  - Eingangsbeleg     -> Belegdatum (`issueDate`)
 *  - Zahlung           -> Zahlungsdatum (`date`), unabhaengig vom Monat des Belegs
 *
 * Finanz-Wahrheit:
 *  - Rechnungen: nur finalisierte (`vorbereitet`/`versendet`); Entwuerfe nie.
 *    Die Originalrechnung bleibt im Monat ihres Rechnungsdatums (bei Storno mit
 *    Status `storniert`, Betraege wie ausgestellt). 01D2: Der Storno selbst ist ein
 *    eigener Beleg (`rechnungsstorno`) im Monat des kanonischen Stornodatums
 *    `cancelledAt` (= `resolveCorrectionIssueDate`), mit negierten Betraegen und —
 *    bei `cancellationKind = 'correction'` — der Korrektur-PDF. Umsatz entsteht so
 *    genau einmal (+ im Original, - im Storno), nie doppelt.
 *  - Ausgaben: nur `gebucht` (aktiv) und `storniert` (als solche); Entwuerfe nie;
 *    Grabsteine (`sync.deleted`) nie; Demo-Ausgaben (`exp-00N`) nie. Ein Storno
 *    mit kanonischem `cancelledAt` erscheint als `ausgabenstorno` im Stornomonat;
 *    ohne `cancelledAt` (Altbestand) nur als Kennzeichnung am Original.
 *  - Zahlungen: `payments[]` ist bereits die lokale Projektion der append-only
 *    Cloud-Wahrheit — reversierte Zahlungen sind dort nicht mehr enthalten.
 *    Zahlungen stornierter Belege werden nicht als aktiv gefuehrt.
 */
import type { Expense, ExpensePayment } from '../../types/expense';
import type { CompanyDocument, InboxItem, InvoicePayment, PaymentMethod, VorgangInvoice } from '../../types/models';
import type { DocumentFileRef } from '../../types/documentFileRef';
import { isFinalizedInvoice } from '../invoiceArchiveService';
import { calculatePaymentSummary, getInvoicePayments } from '../invoicePaymentService';
import { calculateExpensePaymentSummary, getExpensePayments } from '../expensePaymentCalculations';
import { checkExpenseMoneyIntegrity } from '../expense/expenseMoneyIntegrity';
import { isEntitySyncActive } from '../sync/syncMetaService';
import { isCloudSyncBlockedMockExpenseId } from '../expense/expenseCloudSyncService';
import { isCloudSyncBlockedMockVorgangId } from '../storage/mockDataDetectionService';
import { negateMoney, resolveCorrectionIssueDate } from '../invoice/invoiceCorrectionModel';

export type MonatsmappeBelegart = 'ausgangsrechnung' | 'eingangsbeleg' | 'rechnungsstorno' | 'ausgabenstorno';
export type MonatsmappeBelegStatus = 'aktiv' | 'storniert' | 'storno';
/** `none`: Beleg hat fachlich kein eigenes Dokument (interner Storno) — kein Fehlzustand. */
export type MonatsmappeDocumentStatus = 'generated' | 'archived' | 'missing' | 'none';

export interface MonatsmappeDocumentSource {
  /** Was den Inhalt liefert — nie ein erfundenes Dokument. */
  kind: 'invoice_pdf' | 'invoice_correction_pdf' | 'file_ref';
  fileRefId?: string;
  /** Dateiname innerhalb des Pakets, deterministisch und kollisionsfrei. */
  fileName: string;
}

export interface MonatsmappeBeleg {
  belegart: MonatsmappeBelegart;
  id: string;
  belegnummer: string;
  datum: string;
  gegenpartei: string;
  netto: number;
  steuer: number;
  brutto: number;
  status: MonatsmappeBelegStatus;
  zahlungsstatus: string;
  zahlungssumme: number;
  documentStatus: MonatsmappeDocumentStatus;
  documents: MonatsmappeDocumentSource[];
  hinweis?: string;
  /**
   * 02B — offener Betrag zum Monatsende (nur Originalbelege). Ein Storno oder
   * eine Zahlung nach dem Monatsende ändert ihn nicht.
   */
  offenerBetrag?: number;
  /**
   * 02B — der Beleg wurde erst **nach** dem Monatsende storniert. Er ist in
   * diesem Monat aktiv; der Storno gehört in den Stornomonat. Nur für die
   * Rückwärtskompatibilität alter Abschlüsse (Fingerprint v1) mitgeführt.
   */
  spaeterStorniertAm?: string;
}

export interface MonatsmappeZahlung {
  /** 02B — optional; fehlt sie, ist sie nicht erfasst. */
  zahlungsart?: PaymentMethod;
  belegart: MonatsmappeBelegart;
  belegId: string;
  belegnummer: string;
  zahlungId: string;
  datum: string;
  betrag: number;
  referenz: string;
  gegenpartei: string;
}

/** 02B — ein offener Posten zum Monatsende (Forderung bzw. Verbindlichkeit). */
export interface MonatsmappeOffenerPosten {
  belegart: 'ausgangsrechnung' | 'eingangsbeleg';
  belegId: string;
  belegnummer: string;
  datum: string;
  gegenpartei: string;
  brutto: number;
  bezahlt: number;
  offen: number;
  faelligAm: string;
  zahlungsstatus: string;
}

export interface MonatsmappeModel {
  monthKey: string;
  ausgangsrechnungen: MonatsmappeBeleg[];
  eingangsbelege: MonatsmappeBeleg[];
  zahlungenAusgang: MonatsmappeZahlung[];
  zahlungenEingang: MonatsmappeZahlung[];
  /** 01D2 — Stornos/Korrekturen im Monat ihres Stornodatums. */
  stornos: MonatsmappeBeleg[];
  /** Belege ohne verfuegbares Dokument — sichtbar, nie still. */
  fehlendeDokumente: Array<{ belegart: MonatsmappeBelegart; id: string; belegnummer: string }>;
  /** 01D2 — stornierte Ausgaben ohne kanonisches Stornodatum (Datenmodell-Luecke, sichtbar). */
  stornosOhneDatum: Array<{ belegart: MonatsmappeBelegart; id: string; belegnummer: string }>;
  /** 02B — offene Posten zum Monatsende, über alle Belegmonate bis dahin. */
  offenePostenMonatsende?: MonatsmappeOffenerPosten[];
  isEmpty: boolean;
}

export interface MonatsmappeInput {
  monthKey: string;
  invoices: Array<{ invoice: VorgangInvoice; vorgangId: string | null }>;
  expenses: Expense[];
  documents: CompanyDocument[];
  inboxItems: InboxItem[];
  fileRefs: DocumentFileRef[];
}

export function isValidMonthKey(monthKey: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(monthKey);
}

export function monthKeyOf(iso: string | undefined | null): string {
  return (iso ?? '').slice(0, 7);
}

/** 02B — letzter Kalendertag eines Monats (`YYYY-MM-DD`). */
export function monthEndOf(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${monthKey}-${String(lastDay).padStart(2, '0')}`;
}

/**
 * 02B — die deterministische Exportidentität eines Belegs.
 *
 * Original und Storno derselben Rechnung tragen dieselbe fachliche `id`
 * (Kontierung und Dokumente hängen daran), sind aber zwei Buchungen. Die
 * Belegart unterscheidet sie stabil — ohne zufällige Kennung. Buchungsexport
 * und Periodenmanifest verwenden genau diese Identität.
 */
export function belegExportKey(beleg: Pick<MonatsmappeBeleg, 'belegart' | 'id'>): string {
  return `${beleg.belegart}:${beleg.id}`;
}

/**
 * 02B — dieselbe Identität in lesbarer Form für die Übergabedateien: die
 * Beleg-ID, beim Storno mit dem Zusatz „-Storno“. Keine technischen Werte im CSV.
 */
export function belegBuchungsId(beleg: Pick<MonatsmappeBeleg, 'belegart' | 'id'>): string {
  return beleg.belegart === 'rechnungsstorno' || beleg.belegart === 'ausgabenstorno' ? `${beleg.id}-Storno` : beleg.id;
}

export function resolveInvoiceBelegDatum(invoice: VorgangInvoice): string {
  return (invoice.issueDate ?? invoice.date ?? '').slice(0, 10);
}

/** Kanonisches Stornodatum einer Rechnung — dieselbe Regel wie die Korrektur-PDF. */
export function resolveInvoiceStornoDatum(invoice: VorgangInvoice): string | null {
  if (!invoice.cancelledAt) return null;
  return resolveCorrectionIssueDate({ cancelledAt: invoice.cancelledAt, cancelReason: invoice.cancelReason ?? '' });
}

/** Kanonisches Stornodatum einer Ausgabe — nur `cancelledAt`, nie ein technisches Datum. */
export function resolveExpenseStornoDatum(expense: Expense): string | null {
  return expense.cancelledAt ? expense.cancelledAt.slice(0, 10) : null;
}

/** Filesystem-sicherer Namensteil: ASCII, keine Pfadzeichen, begrenzt. */
export function safeFileNamePart(value: string, maxLength = 40): string {
  const replaced = value
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .normalize('NFKD')
    // kombinierende Akzente (U+0300–U+036F) entfernen
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return (replaced || 'ohne-nummer').slice(0, maxLength);
}

function shortId(id: string): string {
  return safeFileNamePart(id.replace(/^(inv|exp|file-ref)-/, ''), 12);
}

function extensionForMime(mimeType: string | undefined, fallbackName?: string): string {
  const fromName = (fallbackName ?? '').match(/\.([A-Za-z0-9]{2,5})$/)?.[1]?.toLowerCase();
  const mime = (mimeType ?? '').toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/heic') return 'heic';
  if (mime === 'image/webp') return 'webp';
  return fromName ?? 'bin';
}

function invoiceGegenpartei(invoice: VorgangInvoice): string {
  const snapshot = invoice.customerSnapshot as { name?: string; companyName?: string } | undefined;
  return (snapshot?.companyName ?? snapshot?.name ?? '').trim();
}

/**
 * 02B — die Rechnung, wie sie am Monatsende stand: nur Zahlungen bis dahin,
 * storniert nur bei einem Storno bis dahin.
 */
function invoiceAsOf(invoice: VorgangInvoice, monthEnd: string, cancelledAsOf: boolean): VorgangInvoice {
  const payments = getInvoicePayments(invoice).filter((payment) => payment.date.slice(0, 10) <= monthEnd);
  if (cancelledAsOf) return { ...invoice, payments };
  return { ...invoice, payments, cancelledAt: undefined, paymentStatus: undefined };
}

function isInvoiceCancelledAsOf(invoice: VorgangInvoice, monthEnd: string): boolean {
  const stornoDatum = resolveInvoiceStornoDatum(invoice);
  return Boolean(stornoDatum) && stornoDatum! <= monthEnd;
}

function buildInvoiceBeleg(invoice: VorgangInvoice): MonatsmappeBeleg {
  const monthEnd = monthEndOf(monthKeyOf(resolveInvoiceBelegDatum(invoice)));
  // 02B — ein Storno nach dem Monatsende ist ein Vorgang des Stornomonats.
  const cancelled = isInvoiceCancelledAsOf(invoice, monthEnd);
  const summary = calculatePaymentSummary(invoiceAsOf(invoice, monthEnd, cancelled), monthEnd);
  const netto = Number(invoice.subtotal ?? 0);
  const brutto = Number(invoice.amount ?? 0);
  const base = `${safeFileNamePart(invoice.number)}_${shortId(invoice.id)}`;
  // Die Korrektur-PDF gehoert in die Periode des Stornos (siehe buildInvoiceStornoBeleg).
  const documents: MonatsmappeDocumentSource[] = [{ kind: 'invoice_pdf', fileName: `${base}.pdf` }];
  const stornoDatum = resolveInvoiceStornoDatum(invoice);
  return {
    belegart: 'ausgangsrechnung',
    id: invoice.id,
    belegnummer: invoice.number,
    datum: resolveInvoiceBelegDatum(invoice),
    gegenpartei: invoiceGegenpartei(invoice),
    netto,
    steuer: Math.round((brutto - netto) * 100) / 100,
    brutto,
    status: cancelled ? 'storniert' : 'aktiv',
    zahlungsstatus: cancelled ? 'storniert' : summary.status,
    zahlungssumme: cancelled ? 0 : summary.paidAmount,
    documentStatus: 'generated',
    documents,
    hinweis: cancelled
      ? invoice.cancellationKind === 'correction'
        ? `Storniert am ${stornoDatum}, Korrektur ${invoice.correctionNumber ?? `zu ${invoice.number}`}`
        : `Storniert am ${stornoDatum}`
      : undefined,
    offenerBetrag: cancelled ? 0 : summary.openAmount,
    ...(!cancelled && stornoDatum ? { spaeterStorniertAm: stornoDatum } : {}),
  };
}

/**
 * 01D2 — Storno/Korrektur als eigener Beleg im Monat des Stornodatums.
 * Betraege negiert (Gegenbuchung), Dokument = Korrektur-PDF bei `correction`,
 * kein Dokument bei internem Storno (fachlich korrekt, kein Fehlzustand).
 */
function buildInvoiceStornoBeleg(invoice: VorgangInvoice, stornoDatum: string): MonatsmappeBeleg {
  /*
   * `cancellationKind` ist die kanonische Semantik (SQL: vorbereitet -> internal,
   * versendet -> correction). `correctionNumber` ist bislang nur vorbereitet (null)
   * und darf deshalb nicht ueber das Vorhandensein des Korrekturbelegs entscheiden.
   */
  const isCorrection = invoice.cancellationKind === 'correction';
  const correctionLabel = invoice.correctionNumber ?? `Korrektur-${invoice.number}`;
  const netto = negateMoney(Number(invoice.subtotal ?? 0));
  const brutto = negateMoney(Number(invoice.amount ?? 0));
  const base = `${safeFileNamePart(invoice.number)}_${shortId(invoice.id)}`;
  return {
    belegart: 'rechnungsstorno',
    id: invoice.id,
    belegnummer: isCorrection ? correctionLabel : invoice.number,
    datum: stornoDatum,
    gegenpartei: invoiceGegenpartei(invoice),
    netto,
    steuer: Math.round((brutto - netto) * 100) / 100,
    brutto,
    status: 'storno',
    zahlungsstatus: 'storniert',
    zahlungssumme: 0,
    documentStatus: isCorrection ? 'generated' : 'none',
    documents: isCorrection ? [{ kind: 'invoice_correction_pdf', fileName: `Korrektur_zu_${base}.pdf` }] : [],
    hinweis: isCorrection
      ? `Rechnungskorrektur zu ${invoice.number} vom ${resolveInvoiceBelegDatum(invoice)}`
      : `Interner Storno zu ${invoice.number} vom ${resolveInvoiceBelegDatum(invoice)} (kein Korrekturbeleg)`,
  };
}

function resolveExpenseFileRef(expense: Expense, input: MonatsmappeInput): DocumentFileRef | undefined {
  const refById = new Map(input.fileRefs.map((ref) => [ref.id, ref]));
  const candidates: Array<string | undefined> = [];
  if (expense.archiveDocumentId) {
    const document = input.documents.find((d) => d.id === expense.archiveDocumentId && isEntitySyncActive(d));
    candidates.push(document?.fileRefId);
  }
  if (expense.linkedInboxId) {
    const item = input.inboxItems.find((i) => i.id === expense.linkedInboxId && isEntitySyncActive(i));
    candidates.push(item?.fileRefId);
  }
  for (const id of candidates) {
    if (!id) continue;
    const ref = refById.get(id);
    if (ref && ref.lifecycleStatus !== 'temp') return ref;
  }
  return undefined;
}

/**
 * FINANZCORE-05B — der Hinweis am Beleg, in fester Reihenfolge.
 *
 * Ein widersprüchlicher Geldbetrag ist der schwerwiegendste dieser Hinweise und
 * steht deshalb vorn: Wer die Übersicht liest, soll ihn nicht hinter einem
 * fehlenden Originaldokument suchen müssen.
 *
 * Seit 05B kann **kein neuer** Beleg mehr widersprüchliche Beträge tragen; das
 * hier betrifft ausschliesslich Altbestand. Der wird sichtbar gemacht und
 * ausdrücklich **nicht** gerechnet, gerundet oder repariert — die Zahlen im
 * Export bleiben exakt die gespeicherten.
 */
function resolveExpenseBelegHinweis(expense: Expense, hasDocument: boolean, cancelledAsOf = expense.status === 'storniert'): string | undefined {
  const hinweise: string[] = [];

  const money = checkExpenseMoneyIntegrity(expense);
  if (!money.ok) {
    hinweise.push(
      `Beträge widersprüchlich (${money.issues.map((issue) => issue.code).join(', ')}) – bitte prüfen`,
    );
  }

  if (cancelledAsOf) {
    const stornoDatum = resolveExpenseStornoDatum(expense);
    hinweise.push(stornoDatum ? `Storniert am ${stornoDatum}` : 'Storniert (Stornodatum nicht erfasst)');
  } else if (!hasDocument) {
    hinweise.push('Kein Originaldokument vorhanden');
  }

  return hinweise.length > 0 ? hinweise.join(' · ') : undefined;
}

/** 02B — die Ausgabe am Monatsende (siehe `invoiceAsOf`). */
function expenseAsOf(expense: Expense, monthEnd: string, cancelledAsOf: boolean): Expense {
  const payments = getExpensePayments(expense).filter((payment) => payment.date.slice(0, 10) <= monthEnd);
  if (cancelledAsOf || expense.status !== 'storniert') return { ...expense, payments };
  // `paymentStatus` ist nur ein Cache; er darf den Storno nicht vorwegnehmen.
  return { ...expense, payments, status: 'gebucht', cancelledAt: undefined, paymentStatus: 'offen' };
}

/** Ohne Stornodatum (Altbestand) bleibt es konservativ beim Storno. */
function isExpenseCancelledAsOf(expense: Expense, monthEnd: string): boolean {
  if (expense.status !== 'storniert') return false;
  const stornoDatum = resolveExpenseStornoDatum(expense);
  return !stornoDatum || stornoDatum <= monthEnd;
}

function buildExpenseBeleg(expense: Expense, input: MonatsmappeInput): MonatsmappeBeleg {
  const monthEnd = monthEndOf(monthKeyOf(expense.issueDate));
  const cancelled = isExpenseCancelledAsOf(expense, monthEnd);
  const summary = calculateExpensePaymentSummary(expenseAsOf(expense, monthEnd, cancelled), monthEnd);
  const stornoDatum = resolveExpenseStornoDatum(expense);
  const ref = resolveExpenseFileRef(expense, input);
  const base = `${expense.issueDate.slice(0, 10)}_${safeFileNamePart(expense.supplierName, 24)}_${safeFileNamePart(expense.invoiceNumber || 'ohne-nummer', 24)}_${shortId(expense.id)}`;
  return {
    belegart: 'eingangsbeleg',
    id: expense.id,
    belegnummer: expense.invoiceNumber ?? '',
    datum: expense.issueDate.slice(0, 10),
    gegenpartei: expense.supplierName,
    netto: expense.netAmount,
    steuer: expense.taxAmount,
    brutto: expense.grossAmount,
    status: cancelled ? 'storniert' : 'aktiv',
    zahlungsstatus: cancelled ? 'storniert' : summary.status,
    zahlungssumme: cancelled ? 0 : summary.paidAmount,
    documentStatus: ref ? 'archived' : 'missing',
    documents: ref ? [{ kind: 'file_ref', fileRefId: ref.id, fileName: `${base}.${extensionForMime(ref.mimeType, ref.originalFileName)}` }] : [],
    hinweis: resolveExpenseBelegHinweis(expense, Boolean(ref), cancelled),
    offenerBetrag: cancelled ? 0 : summary.openAmount,
    ...(!cancelled && expense.status === 'storniert' && stornoDatum ? { spaeterStorniertAm: stornoDatum } : {}),
  };
}

/** 01D2 — Ausgabenstorno im Monat des kanonischen `cancelledAt`; Betraege negiert. */
function buildExpenseStornoBeleg(expense: Expense, stornoDatum: string): MonatsmappeBeleg {
  return {
    belegart: 'ausgabenstorno',
    id: expense.id,
    belegnummer: expense.invoiceNumber ?? '',
    datum: stornoDatum,
    gegenpartei: expense.supplierName,
    netto: negateMoney(expense.netAmount),
    steuer: negateMoney(expense.taxAmount),
    brutto: negateMoney(expense.grossAmount),
    status: 'storno',
    zahlungsstatus: 'storniert',
    zahlungssumme: 0,
    documentStatus: 'none',
    documents: [],
    hinweis: `Storno zu Eingangsbeleg vom ${expense.issueDate.slice(0, 10)}${expense.cancelReason ? ` — ${expense.cancelReason}` : ''}`,
  };
}

function invoicePaymentsOfMonth(invoice: VorgangInvoice, monthKey: string): InvoicePayment[] {
  if (invoice.cancelledAt) return [];
  return getInvoicePayments(invoice).filter((payment) => monthKeyOf(payment.date) === monthKey);
}

function expensePaymentsOfMonth(expense: Expense, monthKey: string): ExpensePayment[] {
  if (expense.status === 'storniert') return [];
  return getExpensePayments(expense).filter((payment) => monthKeyOf(payment.date) === monthKey);
}

/** Echte, aktive Finanzdaten — die gemeinsame Vorauswahl fuer Belege und Zahlungen. */
function eligibleInvoices(input: MonatsmappeInput): VorgangInvoice[] {
  const seen = new Set<string>();
  const result: VorgangInvoice[] = [];
  for (const entry of input.invoices) {
    const invoice = entry.invoice;
    if (seen.has(invoice.id)) continue;
    if (!isFinalizedInvoice(invoice)) continue;
    if (isCloudSyncBlockedMockVorgangId(entry.vorgangId)) continue;
    seen.add(invoice.id);
    result.push(invoice);
  }
  return result;
}

function eligibleExpenses(input: MonatsmappeInput): Expense[] {
  const seen = new Set<string>();
  const result: Expense[] = [];
  for (const expense of input.expenses) {
    if (seen.has(expense.id)) continue;
    if (!isEntitySyncActive(expense)) continue;
    if (isCloudSyncBlockedMockExpenseId(expense.id)) continue;
    if (expense.status === 'entwurf') continue;
    seen.add(expense.id);
    result.push(expense);
  }
  return result;
}

export function buildMonatsmappeModel(input: MonatsmappeInput): MonatsmappeModel {
  if (!isValidMonthKey(input.monthKey)) throw new Error(`Ungueltiger Monat: ${input.monthKey}`);
  const monthKey = input.monthKey;

  const invoices = eligibleInvoices(input);
  const expenses = eligibleExpenses(input);

  const ausgangsrechnungen = invoices
    .filter((invoice) => monthKeyOf(resolveInvoiceBelegDatum(invoice)) === monthKey)
    .map(buildInvoiceBeleg)
    .sort((a, b) => a.datum.localeCompare(b.datum) || a.belegnummer.localeCompare(b.belegnummer) || a.id.localeCompare(b.id));

  const eingangsbelege = expenses
    .filter((expense) => monthKeyOf(expense.issueDate) === monthKey)
    .map((expense) => buildExpenseBeleg(expense, input))
    .sort((a, b) => a.datum.localeCompare(b.datum) || a.gegenpartei.localeCompare(b.gegenpartei) || a.id.localeCompare(b.id));

  const zahlungenAusgang: MonatsmappeZahlung[] = [];
  for (const invoice of invoices) {
    for (const payment of invoicePaymentsOfMonth(invoice, monthKey)) {
      zahlungenAusgang.push({
        belegart: 'ausgangsrechnung', belegId: invoice.id, belegnummer: invoice.number, zahlungId: payment.id,
        datum: payment.date.slice(0, 10), betrag: payment.amount, referenz: payment.reference ?? '', gegenpartei: invoiceGegenpartei(invoice),
        ...(payment.method ? { zahlungsart: payment.method } : {}),
      });
    }
  }
  const zahlungenEingang: MonatsmappeZahlung[] = [];
  for (const expense of expenses) {
    for (const payment of expensePaymentsOfMonth(expense, monthKey)) {
      zahlungenEingang.push({
        belegart: 'eingangsbeleg', belegId: expense.id, belegnummer: expense.invoiceNumber ?? '', zahlungId: payment.id,
        datum: payment.date.slice(0, 10), betrag: payment.amount, referenz: payment.reference ?? '', gegenpartei: expense.supplierName,
        ...(payment.method ? { zahlungsart: payment.method } : {}),
      });
    }
  }
  const byDate = (a: MonatsmappeZahlung, b: MonatsmappeZahlung) => a.datum.localeCompare(b.datum) || a.zahlungId.localeCompare(b.zahlungId);
  zahlungenAusgang.sort(byDate);
  zahlungenEingang.sort(byDate);

  /* 01D2 — Stornos im Monat ihres kanonischen Stornodatums (auch ueber Monatsgrenzen). */
  const stornos: MonatsmappeBeleg[] = [];
  const stornosOhneDatum: MonatsmappeModel['stornosOhneDatum'] = [];
  for (const invoice of invoices) {
    const stornoDatum = resolveInvoiceStornoDatum(invoice);
    if (stornoDatum && monthKeyOf(stornoDatum) === monthKey) stornos.push(buildInvoiceStornoBeleg(invoice, stornoDatum));
  }
  for (const expense of expenses) {
    if (expense.status !== 'storniert') continue;
    const stornoDatum = resolveExpenseStornoDatum(expense);
    if (!stornoDatum) {
      if (monthKeyOf(expense.issueDate) === monthKey) stornosOhneDatum.push({ belegart: 'eingangsbeleg', id: expense.id, belegnummer: expense.invoiceNumber ?? '' });
      continue;
    }
    if (monthKeyOf(stornoDatum) === monthKey) stornos.push(buildExpenseStornoBeleg(expense, stornoDatum));
  }
  stornos.sort((a, b) => a.datum.localeCompare(b.datum) || a.belegart.localeCompare(b.belegart) || a.id.localeCompare(b.id));

  /* 02B — offene Posten zum Monatsende: alle Belege bis dahin, Stand Monatsende. */
  const monthEnd = monthEndOf(monthKey);
  const offenePostenMonatsende: MonatsmappeOffenerPosten[] = [];
  for (const invoice of invoices) {
    const datum = resolveInvoiceBelegDatum(invoice);
    if (!datum || datum > monthEnd) continue;
    const cancelledAsOf = isInvoiceCancelledAsOf(invoice, monthEnd);
    if (cancelledAsOf) continue;
    const summary = calculatePaymentSummary(invoiceAsOf(invoice, monthEnd, false), monthEnd);
    if (summary.openAmount <= 0.005) continue;
    offenePostenMonatsende.push({
      belegart: 'ausgangsrechnung', belegId: invoice.id, belegnummer: invoice.number, datum,
      gegenpartei: invoiceGegenpartei(invoice), brutto: Number(invoice.amount ?? 0),
      bezahlt: summary.paidAmount, offen: summary.openAmount, faelligAm: (invoice.paymentDueDate ?? '').slice(0, 10),
      zahlungsstatus: summary.status,
    });
  }
  for (const expense of expenses) {
    const datum = expense.issueDate.slice(0, 10);
    if (!datum || datum > monthEnd) continue;
    if (isExpenseCancelledAsOf(expense, monthEnd)) continue;
    if (expense.status !== 'gebucht' && expense.status !== 'storniert') continue;
    const summary = calculateExpensePaymentSummary(expenseAsOf(expense, monthEnd, false), monthEnd);
    if (summary.openAmount <= 0.005) continue;
    offenePostenMonatsende.push({
      belegart: 'eingangsbeleg', belegId: expense.id, belegnummer: expense.invoiceNumber ?? '', datum,
      gegenpartei: expense.supplierName, brutto: expense.grossAmount,
      bezahlt: summary.paidAmount, offen: summary.openAmount, faelligAm: (expense.paymentDueDate ?? '').slice(0, 10),
      zahlungsstatus: summary.status,
    });
  }
  offenePostenMonatsende.sort(
    (a, b) => a.belegart.localeCompare(b.belegart) || a.datum.localeCompare(b.datum) || a.belegId.localeCompare(b.belegId),
  );

  const fehlendeDokumente = [...ausgangsrechnungen, ...eingangsbelege, ...stornos]
    .filter((beleg) => beleg.documentStatus === 'missing')
    .map((beleg) => ({ belegart: beleg.belegart, id: beleg.id, belegnummer: beleg.belegnummer }));

  return {
    monthKey,
    ausgangsrechnungen,
    eingangsbelege,
    zahlungenAusgang,
    zahlungenEingang,
    stornos,
    fehlendeDokumente,
    stornosOhneDatum,
    offenePostenMonatsende,
    isEmpty:
      ausgangsrechnungen.length === 0 &&
      eingangsbelege.length === 0 &&
      stornos.length === 0 &&
      zahlungenAusgang.length === 0 &&
      zahlungenEingang.length === 0,
  };
}

// ---------------------------------------------------------------------------
// CSV — Semikolon, Dezimalkomma, UTF-8 (Excel/DATEV-uebliche Basis)
// ---------------------------------------------------------------------------

function csvCell(value: string | number): string {
  const text = typeof value === 'number' ? value.toFixed(2).replace('.', ',') : value;
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvLine(cells: Array<string | number>): string {
  return cells.map(csvCell).join(';');
}

/** 02B — Zahlungsart in Klartext; nicht erfasst bleibt leer, nie „Bank“. */
export const ZAHLUNGSART_LABEL: Record<PaymentMethod, string> = {
  bank: 'Bank',
  cash: 'Bar',
  other: 'Sonstige',
};

/** 02B — Zahlungsstatus in Klartext für Übergabedateien. */
export const ZAHLUNGSSTATUS_LABEL: Record<string, string> = {
  offen: 'Offen',
  teilbezahlt: 'Teilbezahlt',
  bezahlt: 'Bezahlt',
  ueberbezahlt: 'Überbezahlt',
  ueberfaellig: 'Überfällig',
  storniert: 'Storniert',
  gutschrift: 'Gutschrift',
};

export const BELEGART_LABEL: Record<MonatsmappeBelegart, string> = {
  ausgangsrechnung: 'Ausgangsrechnung',
  eingangsbeleg: 'Eingangsbeleg',
  rechnungsstorno: 'Rechnungsstorno',
  ausgabenstorno: 'Ausgabenstorno',
};

/** Ordner im Paket je Belegart. */
export const BELEGART_FOLDER: Record<MonatsmappeBelegart, string> = {
  ausgangsrechnung: 'Ausgangsrechnungen',
  eingangsbeleg: 'Eingangsbelege',
  rechnungsstorno: 'Stornos_Korrekturen',
  ausgabenstorno: 'Stornos_Korrekturen',
};

export function buildUebersichtCsv(model: MonatsmappeModel): string {
  const lines = [csvLine(['Belegart', 'Interne ID', 'Belegnummer', 'Datum', 'Gegenpartei', 'Netto', 'Steuer', 'Brutto', 'Status', 'Zahlungsstatus', 'Zahlungssumme', 'Dokument vorhanden', 'Dokumentdatei', 'Hinweis'])];
  for (const beleg of [...model.ausgangsrechnungen, ...model.eingangsbelege, ...model.stornos]) {
    lines.push(csvLine([
      BELEGART_LABEL[beleg.belegart], beleg.id, beleg.belegnummer, beleg.datum, beleg.gegenpartei,
      beleg.netto, beleg.steuer, beleg.brutto, beleg.status, beleg.zahlungsstatus, beleg.zahlungssumme,
      beleg.documentStatus === 'missing' ? 'nein' : beleg.documentStatus === 'none' ? 'kein Beleg' : 'ja',
      beleg.documents.map((d) => `${BELEGART_FOLDER[beleg.belegart]}/${d.fileName}`).join(' | '),
      beleg.hinweis ?? '',
    ]));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function buildZahlungenCsv(model: MonatsmappeModel): string {
  const lines = [csvLine(['Belegart', 'Beleg-ID', 'Belegnummer', 'Zahlungs-ID', 'Zahlungsdatum', 'Betrag', 'Referenz', 'Gegenpartei', 'Zahlungsart'])];
  for (const zahlung of [...model.zahlungenAusgang, ...model.zahlungenEingang]) {
    lines.push(csvLine([
      BELEGART_LABEL[zahlung.belegart], zahlung.belegId, zahlung.belegnummer, zahlung.zahlungId, zahlung.datum, zahlung.betrag, zahlung.referenz, zahlung.gegenpartei,
      zahlung.zahlungsart ? ZAHLUNGSART_LABEL[zahlung.zahlungsart] : '',
    ]));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** 02B — offene Posten zum Monatsende (Forderungen und Verbindlichkeiten). */
export function buildOffenePostenCsv(model: MonatsmappeModel): string {
  const lines = [csvLine(['Art', 'Beleg-ID', 'Belegnummer', 'Belegdatum', 'Gegenpartei', 'Brutto', 'Bezahlt bis Monatsende', 'Offen zum Monatsende', 'Fällig am', 'Zahlungsstatus zum Monatsende'])];
  for (const posten of model.offenePostenMonatsende ?? []) {
    lines.push(csvLine([
      posten.belegart === 'ausgangsrechnung' ? 'Forderung' : 'Verbindlichkeit',
      posten.belegId, posten.belegnummer, posten.datum, posten.gegenpartei,
      posten.brutto, posten.bezahlt, posten.offen, posten.faelligAm,
      ZAHLUNGSSTATUS_LABEL[posten.zahlungsstatus] ?? posten.zahlungsstatus,
    ]));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
