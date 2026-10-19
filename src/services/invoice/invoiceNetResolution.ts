/**
 * FC01A-P1-Restkorrektur (lokaler Altbestand) — das Netto einer freigegebenen Rechnung, nur aus
 * nachweislich verlässlichen, eingefrorenen Angaben.
 *
 * Bisher setzte die Hydratisierung ein fehlendes `subtotal` auf das Brutto (`amount`). Ein lokal
 * gespeicherter Altabschlag mit 476,00 € brutto bei 19 % stand danach mit 476,00 € netto da; der
 * Nachdruck wies 90,44 € USt und 566,44 € fällig aus, der Steuerberaterexport 476,00 / 0,00 /
 * 476,00. Ein unbekanntes Netto wird deshalb nicht mehr ersetzt, sondern hier aufgelöst:
 *
 *  1. Ein gespeichertes Netto gilt, wenn es den gespeicherten Betrag ergibt:
 *     Netto + USt(Netto) − Abzüge = `amount` (Schlussrechnung: nicht unter 0, wie bei der
 *     Freigabe). Ein Pauschalabschlag muss zudem sein Pauschalnetto tragen.
 *  2. Fehlt es oder widerspricht es, zählt ein eingefrorener Kandidat — das Pauschalnetto eines
 *     Pauschalabschlags oder die Summe der Positionen (Menge × Einzelpreis, wie bei der
 *     Freigabe) —, wenn er genau diesen Betrag ergibt. Zwei unabhängige eingefrorene Angaben
 *     stimmen dann überein.
 *     Ein widersprechendes gespeichertes Netto wird dabei nur übergangen, wenn es genau dem
 *     Betrag gleicht: Das ist die Spur der alten Ersatzregel (Netto := Brutto), die ein
 *     normalisierter Altbestand bereits gespeichert haben kann. Jeder andere Widerspruch bleibt
 *     ungeklärt.
 *  3. Ohne gespeichertes Netto und ohne Kandidaten ist nur eine ausdrücklich steuerfreie
 *     Rechnung (§ 19, § 13b, steuerfrei) eindeutig: Netto = Betrag + Abzüge. „Unklar" zählt
 *     nicht.
 *  4. Sonst bleibt das Netto ungeklärt. Es wird nie aus dem Brutto über einen Steuersatz
 *     zurückgerechnet: Der Steuerstatus eines Altbelegs kann selbst ergänzt sein.
 *
 * Gespeichert wird nichts; die Rechnung bleibt unverändert. Druck, PDF, E-Rechnung,
 * Steuerberaterexport und Abschlagsabzug lesen dieselbe Auflösung; ist sie ungeklärt, sperren
 * sie mit Hinweis (`invoice_net_unresolved`).
 */
import { isFixedAmountAbschlag } from '../invoiceCalculationMode';
import { billingLineTotalCents, fromCents, isValidMoneyNumber, sumCents, taxCentsFromNet, toCents } from '../invoiceMoney';
import { getTaxRateForStatus } from '../invoiceTaxService';
import { usesAbschlagDeductions } from '../invoiceTypeService';
import type { VorgangInvoice } from '../../types/models';

export type InvoiceNetSource = 'stored' | 'fixed_amount' | 'positions' | 'tax_free_amount';

export type InvoiceNetResolution =
  | { readonly ok: true; readonly netCents: number; readonly source: InvoiceNetSource }
  | { readonly ok: false; readonly reason: 'amount_missing' | 'net_missing' | 'net_contradicts' };

export type InvoiceNetInput = Pick<
  VorgangInvoice,
  'type' | 'subtotal' | 'amount' | 'taxStatus' | 'calculationMode' | 'fixedAmountNet' | 'positions' | 'previousAbschlagDeductions'
>;

/** Ausdrücklich ohne Umsatzsteuer — nur hier ist ein fehlendes Netto aus dem Betrag eindeutig. */
const EXPLICIT_TAX_FREE: ReadonlySet<string> = new Set(['kleinunternehmer_19', 'reverse_charge_13b', 'tax_free']);

function finiteCents(value: unknown): number | null {
  if (typeof value !== 'number' || !isValidMoneyNumber(value)) return null;
  const cents = toCents(value);
  return Number.isFinite(cents) ? cents : null;
}

/** Abzüge wie bei der Freigabe (`calculateInvoiceTotals`): Summe der Abschlagsbeträge. */
function deductionCentsOf(invoice: InvoiceNetInput): number {
  return sumCents(
    (invoice.previousAbschlagDeductions ?? [])
      .map((deduction) => finiteCents(deduction.amount))
      .filter((cents): cents is number => cents !== null),
  );
}

/** Der Betrag, den ein Netto bei der Freigabe ergeben hätte (`calculateInvoiceTotals`). */
function amountCentsForNet(invoice: InvoiceNetInput, netCents: number, rate: number, deductionCents: number): number {
  const raw = netCents + taxCentsFromNet(netCents, rate) - deductionCents;
  return usesAbschlagDeductions(invoice.type) ? Math.max(0, raw) : raw;
}

function fixedAmountCandidate(invoice: InvoiceNetInput): number | null {
  if (!isFixedAmountAbschlag(invoice)) return null;
  const cents = finiteCents(invoice.fixedAmountNet);
  return cents !== null && cents > 0 ? cents : null;
}

function positionsCandidate(invoice: InvoiceNetInput): number | null {
  if (isFixedAmountAbschlag(invoice)) return null;
  const lines = (invoice.positions ?? []).filter(
    (position) => typeof position.quantity === 'number' && position.quantity > 0,
  );
  if (lines.length === 0) return null;
  const cents = lines.map((position) => billingLineTotalCents(position.quantity, position.unitPrice));
  return cents.every(Number.isFinite) ? sumCents(cents) : null;
}

export function resolveInvoiceNet(invoice: InvoiceNetInput): InvoiceNetResolution {
  const amountCents = finiteCents(invoice.amount);
  if (amountCents === null) return { ok: false, reason: 'amount_missing' };
  const rate = getTaxRateForStatus(invoice.taxStatus);
  const deductionCents = deductionCentsOf(invoice);
  const yieldsAmount = (netCents: number) =>
    amountCentsForNet(invoice, netCents, rate, deductionCents) === amountCents;

  const fixedCents = fixedAmountCandidate(invoice);
  const storedCents = finiteCents(invoice.subtotal);
  if (storedCents !== null && yieldsAmount(storedCents)) {
    // Ein Pauschalabschlag ist genau eine Zeile: Netto und Pauschalnetto müssen gleich sein.
    if (fixedCents !== null && fixedCents !== storedCents) return { ok: false, reason: 'net_contradicts' };
    return { ok: true, netCents: storedCents, source: 'stored' };
  }
  // Ein anderes widersprechendes Netto als die Spur der alten Ersatzregel bleibt ungeklärt.
  if (storedCents !== null && storedCents !== amountCents) return { ok: false, reason: 'net_contradicts' };

  const candidates: Array<[InvoiceNetSource, number | null]> = [
    ['fixed_amount', fixedCents],
    ['positions', positionsCandidate(invoice)],
  ];
  for (const [source, cents] of candidates) {
    if (cents !== null && yieldsAmount(cents)) return { ok: true, netCents: cents, source };
  }
  const hasCandidate = candidates.some(([, cents]) => cents !== null);

  if (
    storedCents === null &&
    !hasCandidate &&
    EXPLICIT_TAX_FREE.has(invoice.taxStatus) &&
    // Eine auf 0 begrenzte Schlussrechnung verrät ihr Netto nicht.
    (amountCents > 0 || deductionCents === 0)
  ) {
    return { ok: true, netCents: amountCents + deductionCents, source: 'tax_free_amount' };
  }
  return { ok: false, reason: storedCents === null && !hasCandidate ? 'net_missing' : 'net_contradicts' };
}

/** Das verlässliche Netto in Euro — oder `null`, wenn es ungeklärt ist. */
export function resolvedInvoiceNet(invoice: InvoiceNetInput): number | null {
  const resolution = resolveInvoiceNet(invoice);
  return resolution.ok ? fromCents(resolution.netCents) : null;
}

/** Ist das Netto dieser Rechnung ungeklärt? Dann gibt es keinen Beleg und keinen Export mit Beträgen. */
export function hasUnresolvedInvoiceNet(invoice: InvoiceNetInput): boolean {
  return !resolveInvoiceNet(invoice).ok;
}

/**
 * Für Abrechnungsgrenzen und den Auftragsfortschritt: das verlässliche Netto, sonst höchstens das
 * Brutto der Rechnung vor Abzügen. Das ist eine Obergrenze (die Umsatzsteuer ist nie negativ), kein
 * Netto: Sie verhindert, dass über einen Altbeleg hinweg mehr abgerechnet wird, als der Auftrag
 * hergibt, und wird nie als Netto gedruckt, exportiert oder gespeichert.
 */
export function invoiceNetCentsForBillingLimit(invoice: InvoiceNetInput): number {
  const resolution = resolveInvoiceNet(invoice);
  if (resolution.ok) return resolution.netCents;
  const amountCents = finiteCents(invoice.amount);
  return amountCents === null ? 0 : amountCents + deductionCentsOf(invoice);
}

/** Wird beim Bau eines Belegs mit ungeklärtem Netto geworfen — Aufrufer prüfen vorher. */
export class InvoiceNetUnresolvedError extends Error {
  constructor(readonly invoiceNumber: string) {
    super(`invoice_net_unresolved:${invoiceNumber}`);
    this.name = 'InvoiceNetUnresolvedError';
  }
}
