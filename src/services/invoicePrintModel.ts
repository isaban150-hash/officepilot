import { isFixedAmountAbschlag, FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION } from './invoiceCalculationMode';
import { calculateInvoiceTotals } from './invoiceService';
import { getAbschlagDeductionsTotal } from './invoiceDeductions';
import { billingLineTotalMoney, fromCents, roundMoney, sumCents, taxCentsFromNet, toCents } from './invoiceMoney';
import { formatOrderUnitDisplay } from './orderUnitMapper';
import { getTaxRateForStatus } from './invoiceTaxService';
import { getInvoiceDocumentTitle, usesAbschlagDeductions } from './invoiceTypeService';
import { selectHistoricalInvoiceLogo } from './invoice/invoiceHistoricalLogo';
import { InvoiceNetUnresolvedError, resolveInvoiceNet } from './invoice/invoiceNetResolution';
import {
  frozenSettlementShare,
  reliableDeductionNetCents,
  splitAbschlagDeductions,
  type AbschlagSettlementShare,
} from './invoice/abschlagSkontoSplit';
import { DEFAULT_DOCUMENT_TEMPLATE } from '../types/branding';
import type {
  AbschlagDeduction,
  CompanySetup,
  InvoiceDraft,
  InvoicePrintDeductionLine,
  InvoicePrintModel,
  InvoicePrintPosition,
  InvoicePrintSummary,
  VorgangInvoice,
} from '../types/models';

export { getTaxStatusLabel } from './invoiceTaxService';

/**
 * FINANZ-CORE-01A (AUS-01) — Netto und Umsatzsteuer eines Abzugs aus dem
 * Abschlag selbst: Netto steht dort als `subtotal`, die Steuer ist der
 * Unterschied zum Brutto — beides auf Cent, keine Rückrechnung über einen Satz.
 */
function deductionTaxParts(
  item: AbschlagDeduction,
  taxRate: number,
): Pick<InvoicePrintDeductionLine, 'netAmount' | 'taxAmount'> {
  if (!Number.isFinite(item.subtotal) || !Number.isFinite(item.amount)) return {};
  // FC01A-P1-Restkorrektur (#8) — Netto und Steuer nur, wenn sie zum Satz passen; sonst nichts drucken.
  const netCents = reliableDeductionNetCents(item, taxRate);
  if (netCents === null) return {};
  return { netAmount: fromCents(netCents), taxAmount: fromCents(toCents(item.amount) - netCents) };
}

function deductionTotals(lines: InvoicePrintDeductionLine[]): Pick<InvoicePrintSummary, 'deductionsNetTotal' | 'deductionsTaxTotal'> {
  if (lines.length === 0 || lines.some((line) => line.netAmount === undefined || line.taxAmount === undefined)) return {};
  return {
    deductionsNetTotal: fromCents(sumCents(lines.map((line) => toCents(line.netAmount!)))),
    deductionsTaxTotal: fromCents(sumCents(lines.map((line) => toCents(line.taxAmount!)))),
  };
}

function deductionLabel(item: AbschlagDeduction, index: number): string {
  return item.abschlagNumber ? `Abschlag ${item.abschlagNumber}` : `Abschlag ${index + 1}`;
}

function billedDeductionLines(deductions: readonly AbschlagDeduction[], taxRate: number): InvoicePrintDeductionLine[] {
  return deductions.map((item, index) => ({
    label: deductionLabel(item, index),
    invoiceNumber: item.invoiceNumber,
    amount: item.amount,
    ...deductionTaxParts(item, taxRate),
  }));
}

/** Wie ein abgezogener Abschlag beglichen ist — unbekannt heisst: wie abgerechnet. */
export type DeductionSettlementOf = (deduction: AbschlagDeduction) => AbschlagSettlementShare | null;

type DeductionSummary = Pick<
  InvoicePrintSummary,
  | 'deductionLines'
  | 'deductionsNetTotal'
  | 'deductionsTaxTotal'
  | 'skontoLines'
  | 'deductionsPaidTotal'
  | 'skontoTotal'
  | 'skontoNetTotal'
  | 'skontoTaxTotal'
  | 'roundingAmount'
>;

/**
 * FINANZ-CORE-01A (WEISS-Recheck N02-R1) — die Abzüge einer Schlussrechnung samt Skonto.
 *
 * Ohne Skonto unverändert: je Abschlag der abgerechnete Betrag mit Netto und Steuer.
 * Mit Skonto steht je Abschlag der **gezahlte** Teil (vereinnahmtes Teilentgelt samt
 * Steuer, § 14 Abs. 5 Satz 2 UStG) und daneben das gewährte Skonto als eigene Zeile —
 * dieselbe Aufteilung, aus der die E-Rechnung BT-113 und den Nachlass bildet
 * (`splitAbschlagDeductions`). „Bereits berechnet" und der Restbetrag bleiben, was
 * abgerechnet wurde.
 */
function buildDeductionSummary(
  deductions: readonly AbschlagDeduction[],
  invoice: { subtotalNet: number; taxRate: number },
  settlementOf: DeductionSettlementOf,
): DeductionSummary {
  const billed = billedDeductionLines(deductions, invoice.taxRate);
  const split = splitAbschlagDeductions(deductions, invoice, settlementOf);
  if (!split.hasSkonto) return { deductionLines: billed, ...deductionTotals(billed) };
  return {
    deductionLines: split.parts.map((part, index) =>
      part.skonto > 0
        ? {
            label: deductionLabel(part.deduction, index),
            invoiceNumber: part.deduction.invoiceNumber,
            amount: part.paid,
            /*
             * FC01A-P1-Restkorrektur (#8, Altformat) — steht das Netto des Abschlags nicht fest
             * (umsatzsteuerpflichtig ohne gespeichertes Netto), werden Netto und Steuer des
             * gezahlten Teils nicht gedruckt; bisher stand hier Brutto als Netto (468,00 €/−1,52 €).
             */
            ...(part.paidNet === null || part.paidTax === null ? {} : { netAmount: part.paidNet, taxAmount: part.paidTax }),
            paidPart: true,
          }
        : billed[index]!,
    ),
    ...deductionTotals(billed),
    skontoLines: split.parts.flatMap((part, index) =>
      part.skonto > 0
        ? [
            {
              label: `Skonto auf ${deductionLabel(part.deduction, index)}`,
              invoiceNumber: part.deduction.invoiceNumber,
              amount: part.skonto,
              netAmount: part.skontoNet,
              taxAmount: part.skontoTax,
            },
          ]
        : [],
    ),
    deductionsPaidTotal: split.paidTotal,
    skontoTotal: split.skontoTotal,
    skontoNetTotal: split.skontoNetTotal,
    skontoTaxTotal: split.skontoTaxTotal,
    roundingAmount: split.roundingAmount,
  };
}

function buildPositions(draft: InvoiceDraft): InvoicePrintPosition[] {
  if (isFixedAmountAbschlag(draft)) {
    const net = draft.fixedAmountNet ?? 0;
    if (!(net > 0)) return [];
    return [
      {
        index: 1,
        description: FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION,
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: net,
        lineTotal: net,
      },
    ];
  }
  return draft.positions
    .filter((position) => position.quantity > 0)
    .map((position, index) => ({
      index: index + 1,
      description: position.description,
      quantity: position.quantity,
      unit: formatOrderUnitDisplay(position.unit, position.unitLabel),
      // FINANZ-CORE-01A — dieselbe Zeile wie Freigabe und Server: Preis auf Cent, exakt gerechnet.
      unitPrice: roundMoney(position.unitPrice),
      lineTotal: billingLineTotalMoney(position.quantity, position.unitPrice),
    }));
}

function buildPositionsFromInvoice(invoice: VorgangInvoice, netCents: number): InvoicePrintPosition[] {
  if (isFixedAmountAbschlag(invoice)) {
    // FC01A-P1-Restkorrektur (lokaler Altbestand) — die eine Zeile ist das aufgelöste Netto.
    const net = fromCents(netCents);
    if (!(net > 0)) return [];
    return [
      {
        index: 1,
        description: FIXED_AMOUNT_ABSCHLAG_PRINT_DESCRIPTION,
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: net,
        lineTotal: net,
      },
    ];
  }
  return invoice.positions.map((position, index) => ({
    index: index + 1,
    description: position.description,
    quantity: position.quantity,
    unit: formatOrderUnitDisplay(position.unit, position.unitLabel),
    unitPrice: position.unitPrice,
    lineTotal: position.lineTotal,
  }));
}

export function buildInvoicePrintModelFromInvoice(invoice: VorgangInvoice): InvoicePrintModel {
  if (!invoice.companySnapshot || !invoice.customerSnapshot) {
    throw new Error('Invoice snapshots missing – cannot render finalized invoice.');
  }

  /*
   * FC01A-P1-Restkorrektur (lokaler Altbestand) — Netto nur aus verlässlichen, eingefrorenen
   * Angaben (`resolveInvoiceNet`). Ungeklärt entsteht kein Druckmodell: Sonst stünden Steuer und
   * Bruttobetrag eines erfundenen Nettos auf dem Beleg (WEISS: 476,00 netto, 566,44 fällig).
   * Die Ausgabewege prüfen das vorher (`validateFinalizedInvoiceForPdf`).
   */
  const net = resolveInvoiceNet(invoice);
  if (!net.ok) throw new InvoiceNetUnresolvedError(invoice.number);
  const subtotalNet = fromCents(net.netCents);
  const taxRate = getTaxRateForStatus(invoice.taxStatus);
  const subtotalCents = net.netCents;
  const taxCents = taxCentsFromNet(subtotalCents, taxRate);
  const taxAmount = fromCents(taxCents);
  const grossTotal = fromCents(subtotalCents + taxCents);
  const deductions = invoice.previousAbschlagDeductions ?? [];
  const deductionsTotal = getAbschlagDeductionsTotal(deductions);
  const amountDue = usesAbschlagDeductions(invoice.type)
    ? Math.max(0, fromCents(subtotalCents + taxCents - toCents(deductionsTotal)))
    : fromCents(subtotalCents + taxCents);

  return {
    type: invoice.type,
    documentTitle: getInvoiceDocumentTitle(invoice.type, invoice.abschlagNumber),
    invoiceNumber: invoice.number,
    issueDate: invoice.issueDate ?? invoice.date,
    company: { ...invoice.companySnapshot },
    // BRANDING-01F-3 — die historische Quelle des Dokuments, keine Bytes.
    logo: selectHistoricalInvoiceLogo(invoice),
    customer: { ...invoice.customerSnapshot },
    /*
     * MANUAL-INVOICE-01B2c — ohne Auftrag gibt es kein Bauvorhaben. Leer
     * heisst „nicht vorhanden", und der Block wird dann nicht gerendert; ein
     * `'—'` wäre ein Platzhalter, der ein Projektfeld behauptet.
     */
    projectTitle: invoice.vorgangTitle ?? '',
    projectSite: invoice.baustelle ?? '',
    servicePeriodFrom: invoice.servicePeriodFrom ?? invoice.issueDate ?? invoice.date,
    servicePeriodTo: invoice.servicePeriodTo ?? invoice.issueDate ?? invoice.date,
    introText: invoice.introText ?? '',
    closingText: invoice.closingText ?? '',
    positions: buildPositionsFromInvoice(invoice, subtotalCents),
    summary: {
      subtotalNet,
      taxRate,
      taxAmount,
      grossTotal,
      deductionsTotal,
      // N02-R1 — die freigegebene Schlussrechnung liest nur ihre eingefrorene Aufteilung.
      ...buildDeductionSummary(deductions, { subtotalNet, taxRate }, frozenSettlementShare),
      amountDue,
    },
    taxStatus: invoice.taxStatus,
    taxNotices: [...(invoice.legalNotices ?? [])],
    paymentDueDate: invoice.paymentDueDate ?? '',
    paymentTermsText: invoice.paymentTermsText ?? '',
    skontoText: invoice.skontoText ?? '',
    footerNotes: invoice.companySnapshot.invoiceFooterNotes,
    documentTemplate: invoice.brandingSnapshot?.documentTemplate ?? DEFAULT_DOCUMENT_TEMPLATE,
  };
}

export interface InvoicePrintModelOptions {
  /**
   * FINANZ-CORE-01A (WEISS-Recheck N02-R1) — der aktuelle Zahlungsstand der abgezogenen
   * Abschläge, damit die Vorschau schon zeigt, was die Freigabe einfriert. Ohne Angabe
   * steht jeder Abzug wie abgerechnet da.
   */
  settlementOf?: DeductionSettlementOf;
}

export function buildInvoicePrintModel(
  draft: InvoiceDraft,
  setup: CompanySetup,
  options: InvoicePrintModelOptions = {},
): InvoicePrintModel {
  const totals = calculateInvoiceTotals(draft, setup);
  const grossTotal = fromCents(toCents(totals.subtotal) + toCents(totals.tax));
  const deductionsTotal = getAbschlagDeductionsTotal(draft.previousAbschlagDeductions);
  const amountDue = Math.max(0, fromCents(toCents(grossTotal) - toCents(deductionsTotal)));

  return {
    type: draft.type,
    documentTitle: getInvoiceDocumentTitle(draft.type, draft.abschlagNumber),
    invoiceNumber: draft.invoiceNumberPreview || 'ENTWURF',
    issueDate: draft.issueDate,
    company: { ...draft.companySnapshot },
    // BRANDING-01F-3 — im Entwurf dieselbe Regel wie in der fertigen Rechnung.
    logo: selectHistoricalInvoiceLogo(draft),
    customer: { ...draft.customerBilling },
    // MANUAL-INVOICE-01B1 — eine freie Rechnung hat kein Projekt; leer statt erfunden.
    projectTitle: draft.vorgangTitle ?? '',
    projectSite: draft.baustelle,
    servicePeriodFrom: draft.servicePeriodFrom,
    servicePeriodTo: draft.servicePeriodTo,
    introText: draft.introText,
    closingText: draft.closingText,
    positions: buildPositions(draft),
    summary: {
      subtotalNet: totals.subtotal,
      taxRate: totals.taxRate,
      taxAmount: totals.tax,
      grossTotal,
      deductionsTotal,
      ...buildDeductionSummary(
        draft.previousAbschlagDeductions,
        { subtotalNet: totals.subtotal, taxRate: totals.taxRate },
        options.settlementOf ?? (() => null),
      ),
      amountDue: usesAbschlagDeductions(draft.type) ? amountDue : grossTotal,
    },
    taxStatus: draft.taxStatus,
    taxNotices: [...draft.legalNotices],
    paymentDueDate: draft.paymentDueDate,
    paymentTermsText: draft.paymentTermsText,
    skontoText: draft.skontoText,
    footerNotes: draft.companySnapshot.invoiceFooterNotes,
    documentTemplate: draft.brandingSnapshot?.documentTemplate ?? DEFAULT_DOCUMENT_TEMPLATE,
  };
}

export function formatInvoiceCurrency(value: number): string {
  return `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

export function formatInvoiceDate(value: string): string {
  if (!value) return '—';
  /*
   * FINANZ-CORE-01A (AUS-19) — ein reines Datum wird als Kalendertag gelesen, nicht als
   * UTC-Mitternacht: In einer Zeitzone westlich von UTC stand sonst der Vortag da. Und ein
   * unlesbarer Wert erscheint als er selbst statt als „Invalid Date".
   */
  const tag = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (tag) {
    const datum = new Date(Number(tag[1]), Number(tag[2]) - 1, Number(tag[3]), 12);
    if (!Number.isNaN(datum.getTime())) return datum.toLocaleDateString('de-DE');
  }
  try {
    const datum = new Date(value);
    return Number.isNaN(datum.getTime()) ? value : datum.toLocaleDateString('de-DE');
  } catch {
    return value;
  }
}
