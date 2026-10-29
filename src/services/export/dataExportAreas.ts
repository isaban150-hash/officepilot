/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.24 „Inhalt des ZIP“, D-06.1, D-08) — die CSV-Dateien des lesbaren Exports, je Bereich
 * eine, aus einem Bestandsstand (frischer Abzug) und den geladenen E-Mails. Rein: kein Speicher, kein Netz.
 *
 * Jede Zeile trägt eine Spalte „Cloud-Status“ (D-05.9): „bestätigt“, „nicht in der Cloud bestätigt“ (offener oder
 * abgewiesener Auftrag, unbestätigte Zahlung, Rechnungsentwurf) oder „nur lokal“ (Betrieb ohne Cloud). Gelöschte
 * Datensätze (Grabsteine) stehen nicht im Export. Mitarbeiterzahlungen erzeugt der Baustein nur für Inhaber und Admins
 * bzw. den lokalen Betrieb (D-08) — für jede andere Rolle verweigert er den Bereich.
 */
import { amount, buildCsv, date, datetime, integer, text, yesNo, type CsvColumn } from './dataExportFormat';
import type { AppPersistedState, Customer, StoredInvoiceEntry, VorgangInvoice } from '../../types/models';
import type { Expense, ExpensePayment } from '../../types/expense';
import {
  expenseBookingAmounts,
  resolveExpenseInputTaxDeduction,
  resolveExpenseTaxSplitState,
  type ExpenseTaxSplitState,
} from '../expense/expenseTaxSplit';
import type { EmailMessage } from '../../types/emailMessage';
import type { EmployeePayment } from '../../types/employee';
import type { SyncEntityType } from '../../types/sync';

export type DataExportRole = 'owner' | 'admin' | 'local';

export type CloudStatus = 'confirmed' | 'unconfirmed' | 'local';

/** P1-KORREKTURBLOCK A-04 — die Steueraufteilung einer Ausgabe, wie `ausgaben.csv` sie benennt. */
const STEUERAUFTEILUNG_TEXT: Record<ExpenseTaxSplitState, string> = {
  belegt: 'belegt',
  gemischt: 'belegt, gemischte Steuersätze',
  steuerfrei: 'ohne Umsatzsteuer (laut Steuerstatus)',
  offen: 'offen – Netto und Vorsteuer nicht belegt',
  altbestand_pruefen: 'Altbestand – bitte prüfen (0,00 Steuer bei Regelsteuersatz)',
};

/** A-04 — abziehbare Vorsteuer: voll = Steuer, teilweise = angegebener Betrag, keiner = 0; sonst leer. */
function abziehbareVorsteuer(expense: Expense): number | null {
  const abzug = resolveExpenseInputTaxDeduction(expense);
  if (abzug === 'voll') return expense.taxAmount;
  if (abzug === 'teilweise') return typeof expense.deductibleTaxAmount === 'number' ? expense.deductibleTaxAmount : null;
  if (abzug === 'keiner') return 0;
  return null;
}

export const CLOUD_STATUS_TEXT: Record<CloudStatus, string> = {
  confirmed: 'bestätigt',
  unconfirmed: 'nicht in der Cloud bestätigt',
  local: 'nur lokal',
};

/** Ob ein Datensatz in der Cloud bestätigt ist (aus Warteschlange und Zahlungsvermerken des Bestands). */
export interface CloudStatusLookup {
  entity(entityType: SyncEntityType, entityId: string): CloudStatus;
  invoice(invoice: VorgangInvoice): CloudStatus;
  invoicePayment(invoice: VorgangInvoice, paymentId: string): CloudStatus;
  expensePayment(expense: Expense, payment: ExpensePayment): CloudStatus;
}

export type DataExportArea =
  | 'kunden'
  | 'vorgaenge'
  | 'angebote'
  | 'angebotspositionen'
  | 'rechnungen'
  | 'rechnungspositionen'
  | 'zahlungseingaenge'
  | 'ausgaben'
  | 'ausgabenzahlungen'
  | 'dokumente'
  | 'briefe'
  | 'emails_gesendet'
  | 'aufgaben'
  | 'wissen'
  | 'bankumsaetze'
  | 'mitarbeiter'
  | 'mitarbeiterzahlungen'
  | 'kontierungen';

/** Anzeigenamen der Bereiche (Übersicht, Lückenliste). */
export const DATA_EXPORT_AREA_LABEL: Record<DataExportArea, string> = {
  kunden: 'Kunden',
  vorgaenge: 'Vorgänge',
  angebote: 'Angebote',
  angebotspositionen: 'Angebotspositionen',
  rechnungen: 'Rechnungen',
  rechnungspositionen: 'Rechnungspositionen',
  zahlungseingaenge: 'Zahlungseingänge',
  ausgaben: 'Ausgaben',
  ausgabenzahlungen: 'Zahlungen zu Ausgaben',
  dokumente: 'Dokumente (Metadaten)',
  briefe: 'Briefe',
  emails_gesendet: 'Gesendete E-Mails',
  aufgaben: 'Aufgaben',
  wissen: 'Wissenseinträge',
  bankumsaetze: 'Bankumsätze',
  mitarbeiter: 'Mitarbeiter',
  mitarbeiterzahlungen: 'Mitarbeiterzahlungen',
  kontierungen: 'Kontierungen',
};

export interface DataExportCsvFile {
  area: DataExportArea;
  path: string;
  rows: number;
  content: string;
}

/** Eine Datei des Exports, wie sie in `dokumente.csv` verzeichnet wird. */
export interface DataExportFileEntry {
  documentId: string;
  fileRefId: string;
  role: string;
  originalName: string;
  zipPath: string | null;
  sizeBytes: number;
  mimeType: string;
}

export class DataExportRoleError extends Error {
  constructor() {
    super('employee_payments_forbidden');
    this.name = 'DataExportRoleError';
  }
}

const CURRENCY_FALLBACK = 'EUR';

function active<T extends { sync?: { deleted?: boolean } }>(items: readonly T[] | undefined): T[] {
  return (items ?? []).filter((item) => !item.sync?.deleted);
}

function status(lookup: CloudStatusLookup, entityType: SyncEntityType, id: string) {
  return text(CLOUD_STATUS_TEXT[lookup.entity(entityType, id)]);
}

function csv<T>(area: DataExportArea, columns: readonly CsvColumn<T>[], rows: readonly T[]): DataExportCsvFile {
  return { area, path: `csv/${area}.csv`, rows: rows.length, content: buildCsv(columns, rows) };
}

function invoiceTax(invoice: VorgangInvoice, netCents: number | null): number | null {
  if (netCents === null || !Number.isFinite(invoice.amount)) return null;
  return Math.round(invoice.amount * 100 - netCents) / 100;
}

export interface DataExportAreaInput {
  state: AppPersistedState;
  /** Gesendete E-Mails des Betriebs (Serverstand); im Betrieb ohne Cloud leer. */
  sentEmails: readonly EmailMessage[];
  role: DataExportRole;
  lookup: CloudStatusLookup;
  files: readonly DataExportFileEntry[];
  /** Netto je Rechnung in Cent (aus `resolveInvoiceNet`), `null` = nicht eindeutig ermittelbar. */
  invoiceNetCents: (invoice: VorgangInvoice) => number | null;
  /** Offener Betrag je Rechnung (`getOpenAmount`). */
  invoiceOpenAmount: (invoice: VorgangInvoice) => number;
}

export function buildEmployeePaymentsCsv(rows: readonly EmployeePayment[], role: DataExportRole | string, lookup: CloudStatusLookup): DataExportCsvFile {
  // D-08 — zusätzlich zur Seitensperre: der Erzeuger selbst verweigert den Bereich für jede andere Rolle.
  if (role !== 'owner' && role !== 'admin' && role !== 'local') throw new DataExportRoleError();
  return csv<EmployeePayment>('mitarbeiterzahlungen', [
    { header: 'Kennung', cell: (p) => text(p.id) },
    { header: 'Mitarbeiter', cell: (p) => text(p.employeeName) },
    { header: 'Personalnummer', cell: (p) => text(p.personnelNumber) },
    { header: 'Art', cell: (p) => text(p.kind) },
    { header: 'Datum', cell: (p) => date(p.paymentDate) },
    { header: 'Betrag', cell: (p) => amount(p.amount) },
    { header: 'Währung', cell: () => text(CURRENCY_FALLBACK) },
    { header: 'Zahlungsart', cell: (p) => text(p.paymentMethod) },
    { header: 'Lohnmonat', cell: (p) => text(p.wageMonth) },
    { header: 'Zweck', cell: (p) => text(p.purpose) },
    { header: 'Belegnummer', cell: (p) => text(p.receiptReference) },
    { header: 'Storniert am', cell: (p) => datetime(p.reversedAt) },
    { header: 'Stornogrund', cell: (p) => text(p.reversalReason) },
    { header: 'Erfasst am', cell: (p) => datetime(p.createdAt) },
    { header: 'Cloud-Status', cell: (p) => status(lookup, 'employee_payment', p.id) },
  ], rows);
}

/** Alle CSV-Dateien in fester Reihenfolge. */
export function buildDataExportCsvFiles(input: DataExportAreaInput): DataExportCsvFile[] {
  const { state, lookup } = input;
  // Rechnungen und Mitarbeiterzahlungen kennen keine Grabsteine: Stornos bleiben als Zeile mit Datum (Prüfspur).
  const invoices: StoredInvoiceEntry[] = [...(state.invoiceEntries ?? [])];
  const vorgangTitle = new Map((state.vorgaenge ?? []).map((v) => [v.id, v.title]));
  const expenses = active(state.expenses);
  const files = new Map<string, DataExportFileEntry[]>();
  for (const entry of input.files) {
    const list = files.get(entry.documentId) ?? [];
    list.push(entry);
    files.set(entry.documentId, list);
  }

  const result: DataExportCsvFile[] = [];

  result.push(csv<Customer>('kunden', [
    { header: 'Kennung', cell: (c) => text(c.id) },
    { header: 'Name', cell: (c) => text(c.name) },
    { header: 'Ansprechpartner', cell: (c) => text(c.contactPerson) },
    { header: 'Straße', cell: (c) => text(c.street) },
    { header: 'PLZ', cell: (c) => text(c.zip) },
    { header: 'Ort', cell: (c) => text(c.city) },
    { header: 'Land', cell: (c) => text(c.countryCode) },
    { header: 'E-Mail', cell: (c) => text(c.email) },
    { header: 'Telefon', cell: (c) => text(c.phone) },
    { header: 'USt-IdNr.', cell: (c) => text(c.vatId) },
    { header: 'Leitweg-ID', cell: (c) => text(c.leitwegId) },
    { header: 'Angelegt am', cell: (c) => datetime(c.createdAt) },
    { header: 'Cloud-Status', cell: (c) => status(lookup, 'customer', c.id) },
  ], active(state.customers)));

  result.push(csv('vorgaenge', [
    { header: 'Kennung', cell: (v) => text(v.id) },
    { header: 'Vorgangsnummer', cell: (v) => text(v.vorgangNumber) },
    { header: 'Titel', cell: (v) => text(v.title) },
    { header: 'Kunde', cell: (v) => text(v.customer) },
    { header: 'Kunden-Kennung', cell: (v) => text(v.customerId) },
    { header: 'Baustelle', cell: (v) => text(v.baustelle) },
    { header: 'Status', cell: (v) => text(v.status) },
    { header: 'Auftragsnummer', cell: (v) => text(v.orderNumber) },
    { header: 'Auftragsdatum', cell: (v) => date(v.orderDate) },
    { header: 'Positionen', cell: (v) => integer(v.orderPositions?.length ?? 0) },
    { header: 'Cloud-Status', cell: (v) => status(lookup, 'vorgang', v.id) },
  ], active(state.vorgaenge)));

  const offers = active(state.offers);
  result.push(csv('angebote', [
    { header: 'Kennung', cell: (o) => text(o.id) },
    { header: 'Angebotsnummer', cell: (o) => text(o.offerNumber) },
    { header: 'Status', cell: (o) => text(o.status) },
    { header: 'Titel', cell: (o) => text(o.title) },
    { header: 'Kunde', cell: (o) => text(o.customer?.name) },
    { header: 'Kunden-Kennung', cell: (o) => text(o.customerId) },
    { header: 'Angebotsdatum', cell: (o) => date(o.offerDate) },
    { header: 'Gültig bis', cell: (o) => date(o.validUntil) },
    { header: 'Netto', cell: (o) => amount(o.totals?.subtotal) },
    { header: 'Umsatzsteuer', cell: (o) => amount(o.totals?.tax) },
    { header: 'Brutto', cell: (o) => amount(o.totals?.total) },
    { header: 'Währung', cell: () => text(CURRENCY_FALLBACK) },
    { header: 'Freigegeben am', cell: (o) => datetime(o.finalizedAt) },
    { header: 'Gesendet am', cell: (o) => datetime(o.sentAt) },
    { header: 'Cloud-Status', cell: (o) => status(lookup, 'offer', o.id) },
  ], offers));

  const offerLines = offers.flatMap((offer) => (offer.positions ?? []).map((position, index) => ({ offer, position, index })));
  result.push(csv('angebotspositionen', [
    { header: 'Angebot', cell: (r) => text(r.offer.offerNumber || r.offer.id) },
    { header: 'Position', cell: (r) => integer(r.index + 1) },
    { header: 'Beschreibung', cell: (r) => text(r.position.description) },
    { header: 'Menge', cell: (r) => amount(r.position.quantity, 3) },
    { header: 'Einheit', cell: (r) => text(r.position.unitLabel || r.position.unit) },
    { header: 'Einzelpreis', cell: (r) => amount(r.position.unitPrice) },
    { header: 'Gesamt', cell: (r) => amount(Math.round(r.position.quantity * r.position.unitPrice * 100) / 100) },
    { header: 'Währung', cell: () => text(CURRENCY_FALLBACK) },
  ], offerLines));

  result.push(csv<StoredInvoiceEntry>('rechnungen', [
    { header: 'Kennung', cell: (e) => text(e.invoice.id) },
    { header: 'Rechnungsnummer', cell: (e) => text(e.invoice.number) },
    { header: 'Art', cell: (e) => text(e.invoice.type) },
    { header: 'Status', cell: (e) => text(e.invoice.status) },
    { header: 'Rechnungsdatum', cell: (e) => date(e.invoice.issueDate || e.invoice.date) },
    { header: 'Leistung von', cell: (e) => date(e.invoice.servicePeriodFrom) },
    { header: 'Leistung bis', cell: (e) => date(e.invoice.servicePeriodTo) },
    { header: 'Fällig am', cell: (e) => date(e.invoice.paymentDueDate) },
    { header: 'Kunde', cell: (e) => text(e.invoice.customerSnapshot?.name) },
    { header: 'Kunden-Kennung', cell: (e) => text(e.invoice.customerId) },
    { header: 'Vorgang', cell: (e) => text(e.vorgangId ? vorgangTitle.get(e.vorgangId) ?? e.vorgangId : '') },
    { header: 'Netto', cell: (e) => { const n = input.invoiceNetCents(e.invoice); return amount(n === null ? null : n / 100); } },
    { header: 'Umsatzsteuer', cell: (e) => amount(invoiceTax(e.invoice, input.invoiceNetCents(e.invoice))) },
    { header: 'Brutto', cell: (e) => amount(e.invoice.amount) },
    { header: 'Offen', cell: (e) => amount(input.invoiceOpenAmount(e.invoice)) },
    { header: 'Währung', cell: (e) => text(e.invoice.currencyCode || CURRENCY_FALLBACK) },
    { header: 'Steuerstatus', cell: (e) => text(e.invoice.taxStatus) },
    { header: 'Gesendet am', cell: (e) => datetime(e.invoice.sentAt) },
    { header: 'Storniert am', cell: (e) => datetime(e.invoice.cancelledAt) },
    { header: 'Cloud-Status', cell: (e) => text(CLOUD_STATUS_TEXT[lookup.invoice(e.invoice)]) },
  ], invoices));

  const invoiceLines = invoices.flatMap((entry) => (entry.invoice.positions ?? []).map((position, index) => ({ invoice: entry.invoice, position, index })));
  result.push(csv('rechnungspositionen', [
    { header: 'Rechnung', cell: (r) => text(r.invoice.number || r.invoice.id) },
    { header: 'Position', cell: (r) => integer(r.index + 1) },
    { header: 'Beschreibung', cell: (r) => text(r.position.description) },
    { header: 'Menge', cell: (r) => amount(r.position.quantity, 3) },
    { header: 'Einheit', cell: (r) => text(r.position.unitLabel || r.position.unit) },
    { header: 'Einzelpreis', cell: (r) => amount(r.position.unitPrice) },
    { header: 'Gesamt', cell: (r) => amount(r.position.lineTotal) },
    { header: 'Währung', cell: (r) => text(r.invoice.currencyCode || CURRENCY_FALLBACK) },
  ], invoiceLines));

  const invoicePayments = invoices.flatMap((entry) => (entry.invoice.payments ?? []).map((payment) => ({ invoice: entry.invoice, payment })));
  result.push(csv('zahlungseingaenge', [
    { header: 'Kennung', cell: (r) => text(r.payment.id) },
    { header: 'Rechnung', cell: (r) => text(r.invoice.number || r.invoice.id) },
    { header: 'Datum', cell: (r) => date(r.payment.date) },
    { header: 'Betrag', cell: (r) => amount(r.payment.amount) },
    { header: 'Währung', cell: (r) => text(r.invoice.currencyCode || CURRENCY_FALLBACK) },
    { header: 'Zahlungsart', cell: (r) => text(r.payment.method) },
    { header: 'Verwendungszweck', cell: (r) => text(r.payment.reference) },
    { header: 'Notiz', cell: (r) => text(r.payment.note) },
    { header: 'Cloud-Status', cell: (r) => text(CLOUD_STATUS_TEXT[lookup.invoicePayment(r.invoice, r.payment.id)]) },
  ], invoicePayments));

  result.push(csv<Expense>('ausgaben', [
    { header: 'Kennung', cell: (x) => text(x.id) },
    { header: 'Status', cell: (x) => text(x.status) },
    { header: 'Lieferant', cell: (x) => text(x.supplierName) },
    { header: 'Rechnungsnummer', cell: (x) => text(x.invoiceNumber) },
    { header: 'Titel', cell: (x) => text(x.title) },
    { header: 'Kategorie', cell: (x) => text(x.category) },
    { header: 'Belegdatum', cell: (x) => date(x.issueDate) },
    { header: 'Fällig am', cell: (x) => date(x.paymentDueDate) },
    /*
     * P1-KORREKTURBLOCK A-04 — bei offener Steueraufteilung bleiben Netto und Umsatzsteuer leer: gespeichert sind nur
     * Platzhalter, keine belegten Werte. Die Spalten zur Steueraufteilung sagen, warum.
     */
    { header: 'Netto', cell: (x) => amount(expenseBookingAmounts(x).netto) },
    { header: 'Umsatzsteuer', cell: (x) => amount(expenseBookingAmounts(x).steuer) },
    { header: 'Brutto', cell: (x) => amount(x.grossAmount) },
    { header: 'Währung', cell: (x) => text(x.currency || CURRENCY_FALLBACK) },
    { header: 'Zahlungsstatus', cell: (x) => text(x.paymentStatus) },
    { header: 'Gutschrift', cell: (x) => yesNo(x.isCreditNote) },
    { header: 'Storniert am', cell: (x) => datetime(x.cancelledAt) },
    { header: 'Steuerstatus', cell: (x) => text(x.taxStatus) },
    { header: 'Steueraufteilung', cell: (x) => text(STEUERAUFTEILUNG_TEXT[resolveExpenseTaxSplitState(x)]) },
    { header: 'Vorsteuerabzug', cell: (x) => text(resolveExpenseInputTaxDeduction(x) ?? '') },
    { header: 'Abziehbare Vorsteuer', cell: (x) => amount(abziehbareVorsteuer(x)) },
    { header: 'Cloud-Status', cell: (x) => status(lookup, 'expense', x.id) },
  ], expenses));

  const expensePayments = expenses.flatMap((expense) => (expense.payments ?? []).map((payment) => ({ expense, payment })));
  result.push(csv('ausgabenzahlungen', [
    { header: 'Kennung', cell: (r) => text(r.payment.id) },
    { header: 'Ausgabe', cell: (r) => text(r.expense.invoiceNumber || r.expense.title || r.expense.id) },
    { header: 'Lieferant', cell: (r) => text(r.expense.supplierName) },
    { header: 'Datum', cell: (r) => date(r.payment.date) },
    { header: 'Betrag', cell: (r) => amount(r.payment.amount) },
    { header: 'Währung', cell: (r) => text(r.expense.currency || CURRENCY_FALLBACK) },
    { header: 'Zahlungsart', cell: (r) => text(r.payment.method) },
    { header: 'Verwendungszweck', cell: (r) => text(r.payment.reference) },
    { header: 'Cloud-Status', cell: (r) => text(CLOUD_STATUS_TEXT[lookup.expensePayment(r.expense, r.payment)]) },
  ], expensePayments));

  result.push(csv('dokumente', [
    { header: 'Kennung', cell: (d) => text(d.id) },
    { header: 'Titel', cell: (d) => text(d.title) },
    { header: 'Kategorie', cell: (d) => text(d.category) },
    { header: 'Art', cell: (d) => text(d.classifiedKind) },
    { header: 'Aussteller', cell: (d) => text(d.issuer) },
    { header: 'Belegdatum', cell: (d) => date(d.documentDate || d.issueDate) },
    { header: 'Vorgang', cell: (d) => text(d.linkedVorgang?.vorgangTitle) },
    { header: 'Originalname', cell: (d) => text((files.get(d.id) ?? []).map((f) => f.originalName).join(' | ') || d.originalFileName) },
    { header: 'Datei im Export', cell: (d) => text((files.get(d.id) ?? []).map((f) => f.zipPath ?? 'fehlt (siehe luecken.csv)').join(' | ')) },
    { header: 'Erfasst am', cell: (d) => datetime(d.uploadedAt || d.createdAt) },
    { header: 'Cloud-Status', cell: (d) => status(lookup, 'document', d.id) },
  ], active(state.documents)));

  result.push(csv('briefe', [
    { header: 'Kennung', cell: (l) => text(l.id) },
    { header: 'Datum', cell: (l) => date(l.letterDate) },
    { header: 'Betreff', cell: (l) => text(l.subject) },
    { header: 'Empfänger', cell: (l) => text([l.recipient?.company, l.recipient?.name].filter(Boolean).join(', ')) },
    { header: 'Straße', cell: (l) => text(l.recipient?.street) },
    { header: 'PLZ', cell: (l) => text(l.recipient?.zip) },
    { header: 'Ort', cell: (l) => text(l.recipient?.city) },
    { header: 'Status', cell: (l) => text(l.status) },
    { header: 'Text', cell: (l) => text(l.body) },
    { header: 'Cloud-Status', cell: (l) => status(lookup, 'business_letter', l.id) },
  ], active(state.businessLetters)));

  result.push(csv<EmailMessage>('emails_gesendet', [
    { header: 'Kennung', cell: (m) => text(m.id) },
    { header: 'Erstellt am', cell: (m) => datetime(m.createdAt) },
    { header: 'Angenommen am', cell: (m) => datetime(m.providerAcceptedAt) },
    { header: 'Status', cell: (m) => text(m.status) },
    { header: 'Absender', cell: (m) => text([m.fromName || m.senderName, m.fromAddress].filter(Boolean).join(' ')) },
    { header: 'An', cell: (m) => text((m.to ?? []).join(', ')) },
    { header: 'Kopie', cell: (m) => text((m.cc ?? []).join(', ')) },
    { header: 'Betreff', cell: (m) => text(m.subject) },
    { header: 'Text', cell: (m) => text(m.bodyText) },
    { header: 'Anhänge', cell: (m) => text((m.attachments ?? []).map((a) => a.originalFilename || a.filename).join(' | ')) },
    { header: 'Cloud-Status', cell: () => text(CLOUD_STATUS_TEXT.confirmed) },
  ], input.sentEmails));

  result.push(csv('aufgaben', [
    { header: 'Kennung', cell: (t) => text(t.id) },
    { header: 'Titel', cell: (t) => text(t.title) },
    { header: 'Beschreibung', cell: (t) => text(t.description) },
    { header: 'Status', cell: (t) => text(t.status) },
    { header: 'Priorität', cell: (t) => text(t.priority) },
    { header: 'Fällig am', cell: (t) => date(t.dueDate) },
    { header: 'Vorgang', cell: (t) => text(t.linkedVorgangTitle) },
    { header: 'Erstellt am', cell: (t) => datetime(t.createdAt) },
    { header: 'Erledigt am', cell: (t) => datetime(t.completedAt) },
    { header: 'Cloud-Status', cell: (t) => status(lookup, 'task', t.id) },
  ], active(state.tasks)));

  result.push(csv('wissen', [
    { header: 'Kennung', cell: (k) => text(k.id) },
    { header: 'Bereich', cell: (k) => text(k.scopeLabel || k.scope) },
    { header: 'Kategorie', cell: (k) => text(k.category) },
    { header: 'Eintrag', cell: (k) => text(k.displayText) },
    { header: 'Aktiv', cell: (k) => yesNo(k.active) },
    { header: 'Bestätigt am', cell: (k) => datetime(k.confirmedAt) },
    { header: 'Cloud-Status', cell: (k) => status(lookup, 'knowledge_fact', k.id) },
  ], active(state.knowledgeFacts)));

  result.push(csv('bankumsaetze', [
    { header: 'Kennung', cell: (b) => text(b.id) },
    { header: 'Konto', cell: (b) => text(b.accountKey) },
    { header: 'Buchungstag', cell: (b) => date(b.bookingDate) },
    { header: 'Wertstellung', cell: (b) => date(b.valueDate) },
    { header: 'Betrag', cell: (b) => amount(Number.isFinite(b.amountCents) ? b.amountCents / 100 : null) },
    { header: 'Währung', cell: (b) => text(b.currency || CURRENCY_FALLBACK) },
    { header: 'Gegenseite', cell: (b) => text(b.counterparty) },
    { header: 'IBAN Gegenseite', cell: (b) => text(b.counterpartyIban) },
    { header: 'Verwendungszweck', cell: (b) => text(b.purpose) },
    { header: 'Auszugsdatei', cell: (b) => text(b.fileName) },
    { header: 'Eingelesen am', cell: (b) => datetime(b.importedAt) },
    { header: 'Cloud-Status', cell: (b) => status(lookup, 'bank_transaction', b.id) },
  ], active(state.bankTransactions)));

  result.push(csv('mitarbeiter', [
    { header: 'Kennung', cell: (e) => text(e.id) },
    { header: 'Name', cell: (e) => text(e.name) },
    { header: 'Personalnummer', cell: (e) => text(e.personnelNumber) },
    { header: 'Aktiv', cell: (e) => yesNo(e.active) },
    { header: 'Angelegt am', cell: (e) => datetime(e.createdAt) },
    { header: 'Cloud-Status', cell: (e) => status(lookup, 'employee', e.id) },
  ], active(state.employees)));

  result.push(buildEmployeePaymentsCsv(state.employeePayments ?? [], input.role, lookup));

  result.push(csv('kontierungen', [
    { header: 'Kennung', cell: (a) => text(a.id) },
    { header: 'Belegart', cell: (a) => text(a.sourceType === 'invoice' ? 'Rechnung' : 'Ausgabe') },
    { header: 'Beleg-Kennung', cell: (a) => text(a.sourceId) },
    { header: 'Kontenrahmen', cell: (a) => text(a.chartOfAccounts) },
    { header: 'Konto', cell: (a) => text(a.accountNumber) },
    { header: 'Kontobezeichnung', cell: (a) => text(a.accountLabel) },
    { header: 'Steuerbehandlung', cell: (a) => text(a.taxTreatment) },
    { header: 'Buchungstext', cell: (a) => text(a.bookingText) },
    { header: 'Status', cell: (a) => text(a.status) },
    { header: 'Bestätigt am', cell: (a) => datetime(a.confirmedAt) },
    { header: 'Cloud-Status', cell: (a) => status(lookup, 'accounting_assignment', a.id) },
  ], active(state.accountingAssignments)));

  return result;
}
