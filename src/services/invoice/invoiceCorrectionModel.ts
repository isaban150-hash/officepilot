import type {
  InvoicePrintCorrectionContext,
  InvoicePrintModel,
  VorgangInvoice,
} from '../../types/models';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import { fromCents, toCents } from '../invoiceMoney';
import { toBusinessDay } from '../businessDateService';

/**
 * NORMAL-INVOICE-CANCELLATION-01B — die kanonische Darstellung eines
 * Korrekturbelegs (Vollstorno) zu einer versendeten Rechnung.
 *
 * Es gibt **keine zweite Rechnungsberechnung**: Das Modell ist das
 * Original-Druckmodell (`buildInvoicePrintModelFromInvoice`, dieselben
 * Rundungs-, Steuer- und Abzugsregeln), dessen Mengen und Beträge als
 * Gegenbuchung negiert werden. Deshalb sind die Korrekturwerte betragsmässig
 * exakt die Originalwerte — nur mit Gegenzeichen. Reverse Charge bleibt
 * Reverse Charge: Steuer 0 bleibt 0, die Hinweise des Originals reisen mit.
 *
 * Bezug, Datum und Grund kommen aus den Stornofakten des Originals bzw. aus
 * dem serverseitigen Korrekturbeleg — hier wird nichts erfunden.
 */
export const INVOICE_CORRECTION_DOCUMENT_TITLE = 'Rechnungskorrektur';

export interface InvoiceCancellationMetadata {
  cancelledAt: string;
  cancelReason: string;
  /** YYYY-MM-DD; fehlt es, gilt der Geschäftstag (Europe/Berlin) von `cancelledAt`. */
  correctionIssueDate?: string;
}

/** Der Gegenwert eines Betrags: 0 bleibt 0 (kein `-0`). */
export function negateMoney(value: number): number {
  const cents = toCents(value);
  return cents === 0 ? 0 : fromCents(-cents);
}

export function resolveCorrectionIssueDate(meta: InvoiceCancellationMetadata): string {
  const explicit = meta.correctionIssueDate?.trim();
  if (explicit) return explicit;
  /*
   * FINANZ-CORE-01A (STO-05) — der Geschäftstag, nicht der UTC-Tag. Ein Storno
   * zwischen 0 und 2 Uhr trug sonst den Vortag; am Monatsersten landete es im
   * Vormonat und damit im falschen Voranmeldungszeitraum. Die Seite zeigt
   * „Storniert am" bereits als Geschäftstag.
   */
  return toBusinessDay(meta.cancelledAt);
}

export function buildInvoiceCorrectionModel(
  original: VorgangInvoice,
  meta: InvoiceCancellationMetadata,
): InvoicePrintModel {
  const base = buildInvoicePrintModelFromInvoice(original);
  const correction: InvoicePrintCorrectionContext = {
    originalInvoiceNumber: original.number,
    originalIssueDate: original.issueDate ?? original.date,
    originalInvoiceId: original.id,
    correctionIssueDate: resolveCorrectionIssueDate(meta),
    cancelledAt: meta.cancelledAt,
    cancelReason: meta.cancelReason,
    // FINANZ-CORE-01A (SQL-11) — die eigene Nummer aus dem Rechnungskreis, wenn vergeben.
    ...(original.correctionNumber?.trim() ? { correctionNumber: original.correctionNumber.trim() } : {}),
  };

  return {
    ...base,
    documentTitle: INVOICE_CORRECTION_DOCUMENT_TITLE,
    issueDate: correction.correctionIssueDate,
    introText: `Storno der ${base.documentTitle} ${original.number} vom ${formatIsoDate(correction.originalIssueDate)}.`,
    closingText: '',
    // Gegenbuchung: Menge negiert, Einzelpreis bleibt — die Zeile trägt das Gegenzeichen.
    positions: base.positions.map((position) => ({
      ...position,
      // Mengen sind kein Geld: keine Cent-Rundung, nur das Vorzeichen.
      quantity: position.quantity === 0 ? 0 : -position.quantity,
      lineTotal: negateMoney(position.lineTotal),
    })),
    summary: {
      subtotalNet: negateMoney(base.summary.subtotalNet),
      taxRate: base.summary.taxRate,
      taxAmount: negateMoney(base.summary.taxAmount),
      grossTotal: negateMoney(base.summary.grossTotal),
      deductionLines: base.summary.deductionLines.map((line) => ({
        ...line,
        amount: negateMoney(line.amount),
      })),
      deductionsTotal: negateMoney(base.summary.deductionsTotal),
      /*
       * FC01A-Nacharbeit (A8) — Netto und USt der Abzüge stehen wie an den Zeilen (dort bleiben
       * `netAmount`/`taxAmount` unverändert, nur der Betrag trägt das Gegenzeichen). Bisher fielen
       * die Summen weg; die Summenzeile des Korrekturbelegs nannte als einzige keine Steuer.
       */
      ...(base.summary.deductionsNetTotal !== undefined ? { deductionsNetTotal: base.summary.deductionsNetTotal } : {}),
      ...(base.summary.deductionsTaxTotal !== undefined ? { deductionsTaxTotal: base.summary.deductionsTaxTotal } : {}),
      // FINANZ-CORE-01A (WEISS-Recheck N02-R1) — gezahlt und Skonto werden ebenso gegengebucht.
      ...(base.summary.skontoLines
        ? {
            skontoLines: base.summary.skontoLines.map((line) => ({ ...line, amount: negateMoney(line.amount) })),
          }
        : {}),
      ...(base.summary.deductionsPaidTotal !== undefined
        ? { deductionsPaidTotal: negateMoney(base.summary.deductionsPaidTotal) }
        : {}),
      ...(base.summary.skontoTotal !== undefined ? { skontoTotal: negateMoney(base.summary.skontoTotal) } : {}),
      amountDue: negateMoney(base.summary.amountDue),
    },
    // Ein Korrekturbeleg hat kein Zahlungsziel und keinen Skonto.
    paymentDueDate: '',
    paymentTermsText: '',
    skontoText: '',
    correction,
  };
}

function formatIsoDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return `${match[3]}.${match[2]}.${match[1]}`;
}
