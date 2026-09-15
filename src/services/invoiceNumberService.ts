import { listInvoices } from './invoice/invoiceRegistryService';
import { persistAll } from './persistenceService';
import type { InvoiceNumberFormat, InvoiceNumberSequence, VorgangInvoice } from '../types/models';

export const INVOICE_DRAFT_LABEL = 'ENTWURF';

let sequence: InvoiceNumberSequence = {
  year: new Date().getFullYear(),
  lastIssuedNumber: 0,
};

function cloneSequence(value: InvoiceNumberSequence): InvoiceNumberSequence {
  return { ...value };
}

export function getInvoiceNumberSequenceSnapshot(): InvoiceNumberSequence {
  return cloneSequence(sequence);
}

export function hydrateInvoiceNumberSequence(value: InvoiceNumberSequence): void {
  sequence = cloneSequence(value);
}

export function resetInvoiceNumberSequence(): void {
  sequence = {
    year: new Date().getFullYear(),
    lastIssuedNumber: 0,
  };
}

export function getCurrentInvoiceYear(): number {
  return new Date().getFullYear();
}

/* ------------------------------------------------------------------------ */
/* PRODUCT-BASIS-FIRMENPROFIL-01C — Nummernformat (Spiegel der SQL-Regeln)   */
/* ------------------------------------------------------------------------ */

export const DEFAULT_INVOICE_NUMBER_FORMAT: InvoiceNumberFormat = { prefix: '', yearInNumber: true, padding: 4 };
export const INVOICE_NUMBER_PREFIX_MAX_LENGTH = 10;
export const INVOICE_NUMBER_PADDING_MIN = 3;
export const INVOICE_NUMBER_PADDING_MAX = 8;
const PREFIX_PATTERN = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/;

export type InvoiceNumberFormatError = 'invoiceNumberFormat.prefixInvalid' | 'invoiceNumberFormat.paddingInvalid';

/** Spiegel von `validate_workspace_invoice_number_format`. */
export function validateInvoiceNumberFormat(format: InvoiceNumberFormat): InvoiceNumberFormatError | null {
  const prefix = format.prefix ?? '';
  if (prefix !== '' && (prefix !== prefix.trim() || prefix.length > INVOICE_NUMBER_PREFIX_MAX_LENGTH || !PREFIX_PATTERN.test(prefix))) {
    return 'invoiceNumberFormat.prefixInvalid';
  }
  if (!Number.isInteger(format.padding) || format.padding < INVOICE_NUMBER_PADDING_MIN || format.padding > INVOICE_NUMBER_PADDING_MAX) {
    return 'invoiceNumberFormat.paddingInvalid';
  }
  return null;
}

/** Spiegel von `build_workspace_invoice_number` — nur fuer Vorschau/Lokalbetrieb. */
export function buildInvoiceNumber(format: InvoiceNumberFormat, year: number, number: number): string {
  const digits = String(number);
  return `${format.prefix ? `${format.prefix}-` : ''}${format.yearInNumber ? `${year}-` : ''}${digits.padStart(Math.max(format.padding, digits.length), '0')}`;
}

export function getInvoiceNumberFormat(): InvoiceNumberFormat {
  return { ...(sequence.format ?? DEFAULT_INVOICE_NUMBER_FORMAT) };
}

/**
 * 01C2 — das fuer `year` wirksame Format: die eingefrorene Kopie, sobald das
 * Jahr lokal Nummern traegt; sonst das Standardformat. Spiegel der Serverregel
 * (`workspace_invoice_sequences.format_locked_at`).
 */
export function getEffectiveInvoiceNumberFormat(year: number): InvoiceNumberFormat {
  if (sequence.year === year && sequence.lockedFormat) return { ...sequence.lockedFormat };
  return getInvoiceNumberFormat();
}

/**
 * Format-Cache setzen (Cloud-Antwort) bzw. lokale Einstellung (ohne Cloud).
 * Keine Nummernvergabe, keine Aenderung bestehender Nummern.
 */
export function setInvoiceNumberFormat(format: InvoiceNumberFormat): void {
  sequence = { ...sequence, format: { prefix: format.prefix ?? '', yearInNumber: Boolean(format.yearInNumber), padding: format.padding } };
}

/**
 * 01C2 — Serverstand in einen Zustand uebernehmen (Sync-Pull / Einstellungen),
 * ohne Store-Zugriff: Standardformat als Vorschau-Cache und — falls das
 * laufende Jahr serverseitig eingefroren ist — dessen Kopie als `lockedFormat`,
 * damit die Vorschau des laufenden Jahres der Serververgabe entspricht.
 */
export function withInvoiceNumberFormat(
  seq: InvoiceNumberSequence | undefined,
  format: InvoiceNumberFormat,
  currentYear: number = getCurrentInvoiceYear(),
  lockedFormat?: InvoiceNumberFormat,
): InvoiceNumberSequence {
  const sameYear = seq?.year === currentYear;
  return {
    year: currentYear,
    lastIssuedNumber: sameYear ? seq?.lastIssuedNumber ?? 0 : 0,
    format: { ...format },
    lockedFormat: lockedFormat ? { ...lockedFormat } : sameYear ? seq?.lockedFormat : undefined,
  };
}

/** 01C2 — Serverstand direkt in den Store uebernehmen (Einstellungsseite). */
export function applyInvoiceNumberFormatFromServer(format: InvoiceNumberFormat, currentYear: number, lockedFormat?: InvoiceNumberFormat): void {
  sequence = withInvoiceNumberFormat(sequence, format, currentYear, lockedFormat);
}

/**
 * Lokale Sperrregel (Vorschau/Lokalbetrieb): Sobald fuer ein Jahr eine Rechnung
 * nummeriert wurde, ist das Format dieses Jahres festgelegt. Serverseitig gilt
 * `workspace_invoice_sequences.format_locked_at`.
 */
export function isInvoiceNumberFormatLockedForYear(year: number, invoices: VorgangInvoice[] = getAllInvoices()): boolean {
  return sequence.year === year && sequence.lastIssuedNumber > 0 || getMaxSequenceNumberForYear(year, invoices) > 0;
}

/** Vorschau/Lokalbetrieb — die verbindliche Nummer vergibt ausschliesslich der Server. */
export function formatInvoiceNumber(year: number, number: number): string {
  return buildInvoiceNumber(getEffectiveInvoiceNumberFormat(year), year, number);
}

/** Legacy-Ableitung fuer Rechnungen ohne `invoiceSequenceNumber` (Format YYYY-NNNN). */
function parseFormattedInvoiceNumber(value: string): { year: number; number: number } | null {
  const match = /^(\d{4})-(\d+)$/.exec(value.trim());
  if (!match) return null;
  return { year: Number(match[1]), number: Number(match[2]) };
}

export function collectIssuedInvoiceNumbers(invoices: VorgangInvoice[] = getAllInvoices()): Set<string> {
  return new Set(invoices.map((inv) => inv.number));
}

/**
 * INVOICE-REGISTRY-01B — dieselbe Menge, nur nicht mehr selbst zusammengesucht.
 *
 * Hier stand `getVorgangStoreSnapshot().flatMap((v) => v.invoices ?? [])`: Der
 * Nummernkreis musste wissen, dass Rechnungen in Vorgängen liegen. Die Registry
 * liefert exakt dieselben Rechnungen in exakt derselben Reihenfolge — die
 * Ableitung von Jahr und Höchstnummer bleibt dadurch unberührt.
 */
export function getAllInvoices(): VorgangInvoice[] {
  return listInvoices();
}

function getMaxSequenceNumberForYear(
  year: number,
  invoices: VorgangInvoice[],
): number {
  let max = 0;

  for (const invoice of invoices) {
    if (typeof invoice.invoiceSequenceNumber === 'number') {
      const invoiceYear = invoice.issueDate
        ? Number(invoice.issueDate.slice(0, 4))
        : Number(invoice.date.slice(0, 4));
      if (invoiceYear === year) {
        max = Math.max(max, invoice.invoiceSequenceNumber);
      }
      continue;
    }

    const parsed = parseFormattedInvoiceNumber(invoice.number);
    if (parsed && parsed.year === year) {
      max = Math.max(max, parsed.number);
    }
  }

  return max;
}

function ensureSequenceYear(currentYear: number): void {
  if (sequence.year !== currentYear) {
    // 01C — der Format-Cache ueberlebt den Jahreswechsel; die eingefrorene Kopie gehoert dem alten Jahr.
    sequence = { year: currentYear, lastIssuedNumber: 0, format: sequence.format };
  }
}

function computeNextSequenceNumber(currentYear: number, invoices: VorgangInvoice[]): number {
  ensureSequenceYear(currentYear);
  const maxFromInvoices = getMaxSequenceNumberForYear(currentYear, invoices);
  return Math.max(sequence.lastIssuedNumber, maxFromInvoices) + 1;
}

export function getNextInvoiceNumberPreview(): string {
  const currentYear = getCurrentInvoiceYear();
  const invoices = getAllInvoices();
  const nextNumber = computeNextSequenceNumber(currentYear, invoices);
  return formatInvoiceNumber(currentYear, nextNumber);
}

export interface InvoiceNumberReservation {
  year: number;
  sequenceNumber: number;
  formatted: string;
}

export function reserveNextInvoiceNumber(): InvoiceNumberReservation {
  const currentYear = getCurrentInvoiceYear();
  const invoices = getAllInvoices();
  const issuedNumbers = collectIssuedInvoiceNumbers(invoices);

  let nextNumber = computeNextSequenceNumber(currentYear, invoices);
  let formatted = formatInvoiceNumber(currentYear, nextNumber);

  while (issuedNumbers.has(formatted)) {
    nextNumber += 1;
    formatted = formatInvoiceNumber(currentYear, nextNumber);
  }

  // 01C2 — erste Nummer des Jahres friert das Standardformat lokal ein (Spiegel der Serverregel).
  const lockedFormat = sequence.lastIssuedNumber > 0 && sequence.lockedFormat ? sequence.lockedFormat : getInvoiceNumberFormat();
  sequence = { year: currentYear, lastIssuedNumber: nextNumber, format: sequence.format, lockedFormat };
  persistAll();

  return { year: currentYear, sequenceNumber: nextNumber, formatted };
}
