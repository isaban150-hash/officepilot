/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N02/D1) — eine Schlussrechnung zieht nur
 * beglichene Abschläge ab.
 *
 * Bis hierher zog sie jeden wirksamen Pauschalabschlag ab, ob bezahlt oder nicht,
 * und die E-Rechnung führte die Summe als bereits gezahlten Betrag (BT-113).
 * Abgerechnet und bezahlt sind aber zweierlei:
 *
 *   - § 14 Abs. 5 Satz 2 UStG verlangt in der Endrechnung den Abzug der
 *     **vereinnahmten** Teilentgelte samt ihrer Steuer.
 *   - BT-113 („Paid amount") ist der bereits gezahlte Betrag.
 *   - Nach der Schlussrechnung stünde der Anspruch auf einen unbezahlten Abschlag
 *     nur noch auf dem Abschlag selbst — die Schlussrechnung forderte ihn nicht mehr.
 *
 * Die Regel deshalb: Abgezogen wird nur ein **beglichener** Abschlag — voll bezahlt
 * oder fristgerecht mit dem Skonto des Abschlags beglichen; das ist genau die Regel
 * des offenen Betrags (`getOpenAmount`). Ein unbezahlter Abschlag wird bezahlt oder
 * storniert (dann berechnet die Schlussrechnung seinen Betrag selbst); ein
 * teilbezahlter wartet auf den Rest. Der Server prüft dasselbe
 * (`invoice_abschlag_unpaid`) — seit dem WEISS-Recheck (N02-R2) samt Skontofrist.
 *
 * WEISS-Recheck N02-R1: Mit der Freigabe friert die Schlussrechnung je Abzug ein, was
 * gezahlt und was als Skonto gewährt wurde (`freezeAbschlagDeductionSettlements`). PDF,
 * Ansicht und E-Rechnung lesen nur diese Aufteilung; der Server prüft sie.
 */
import type { AbschlagDeduction, VorgangInvoice } from '../../types/models';
import { getOpenAmount, getPaidAmount, isInvoiceCancelled } from '../invoicePaymentService';
import { fromCents, toCents } from '../invoiceMoney';
import type { AbschlagSettlementShare } from './abschlagSkontoSplit';

export interface AbschlagSettlement {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly abschlagNumber?: number;
  /** Der abgezogene Bruttobetrag. */
  readonly billed: number;
  /** Tatsächlich gezahlt, höchstens der abgezogene Betrag. */
  readonly paid: number;
  /** Mit dem Skonto des Abschlags gewährt — nur bei einem beglichenen Abschlag. */
  readonly skonto: number;
  /** Was auf dem Abschlag noch offen ist. */
  readonly open: number;
  readonly settled: boolean;
}

/** Wie ist dieser abgezogene Abschlag beglichen? Unbekannt oder storniert heisst: nicht. */
export function resolveAbschlagSettlement(
  deduction: AbschlagDeduction,
  abschlag: VorgangInvoice | undefined,
): AbschlagSettlement {
  const billedCents = toCents(deduction.amount);
  const base = {
    invoiceId: deduction.invoiceId,
    invoiceNumber: deduction.invoiceNumber,
    ...(deduction.abschlagNumber !== undefined ? { abschlagNumber: deduction.abschlagNumber } : {}),
    billed: fromCents(billedCents),
  };
  if (!abschlag || isInvoiceCancelled(abschlag)) {
    return { ...base, paid: 0, skonto: 0, open: fromCents(billedCents), settled: false };
  }
  const paidCents = Math.min(billedCents, Math.max(0, toCents(getPaidAmount(abschlag))));
  const openCents = Math.max(0, toCents(getOpenAmount(abschlag)));
  const settled = openCents === 0;
  return {
    ...base,
    paid: fromCents(paidCents),
    skonto: settled ? fromCents(billedCents - paidCents) : 0,
    open: fromCents(openCents),
    settled,
  };
}

/** Der Stand jedes abgezogenen Abschlags, in der Reihenfolge der Abzugsliste. */
export function resolveAbschlagSettlements(
  deductions: readonly AbschlagDeduction[] | undefined,
  findInvoice: (invoiceId: string) => VorgangInvoice | undefined,
): AbschlagSettlement[] {
  return (deductions ?? []).map((deduction) => resolveAbschlagSettlement(deduction, findInvoice(deduction.invoiceId)));
}

/** Nur die abgezogenen Abschläge, die (noch) nicht beglichen sind. */
export function findUnsettledAbschlagDeductions(
  deductions: readonly AbschlagDeduction[] | undefined,
  findInvoice: (invoiceId: string) => VorgangInvoice | undefined,
): AbschlagSettlement[] {
  return resolveAbschlagSettlements(deductions, findInvoice).filter((entry) => !entry.settled);
}

/**
 * WEISS-Recheck N02-R1 — die Aufteilung eines Abzugs nach dem aktuellen Zahlungsstand
 * (Vorschau eines Entwurfs). Nicht beglichen heisst: keine Aufteilung.
 */
export function liveSettlementShareOf(
  findInvoice: (invoiceId: string) => VorgangInvoice | undefined,
): (deduction: AbschlagDeduction) => AbschlagSettlementShare | null {
  return (deduction) => {
    const settlement = resolveAbschlagSettlement(deduction, findInvoice(deduction.invoiceId));
    return settlement.settled ? { paid: settlement.paid, skonto: settlement.skonto } : null;
  };
}

/**
 * WEISS-Recheck N02-R1 — bei der Freigabe einfrieren, wie jeder abgezogene Abschlag
 * beglichen ist: gezahlt und Skonto (zusammen der abgezogene Betrag). Ein nicht
 * beglichener Abschlag bleibt ohne Aufteilung — seine Freigabe ist ohnehin gesperrt,
 * und der Server weist sie ab.
 */
export function freezeAbschlagDeductionSettlements(
  deductions: readonly AbschlagDeduction[] | undefined,
  findInvoice: (invoiceId: string) => VorgangInvoice | undefined,
): AbschlagDeduction[] {
  return (deductions ?? []).map((deduction) => {
    const rest: AbschlagDeduction = { ...deduction };
    delete rest.paidAmount;
    delete rest.skontoAmount;
    const settlement = resolveAbschlagSettlement(deduction, findInvoice(deduction.invoiceId));
    return settlement.settled ? { ...rest, paidAmount: settlement.paid, skontoAmount: settlement.skonto } : rest;
  });
}
