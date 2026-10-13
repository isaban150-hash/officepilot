/**
 * FINANZ-CORE-01A (WEISS-Recheck N02-R1) — gezahlt und Skonto getrennt.
 *
 * Eine Schlussrechnung zieht jeden beglichenen Abschlag ab. Ist er mit Skonto
 * beglichen, ist er nicht in voller Höhe gezahlt: Von 476,00 € sind etwa 466,48 €
 * vereinnahmt (§ 14 Abs. 5 Satz 2 UStG) und 9,52 € als Skonto gewährt — eine
 * Entgeltminderung (§ 17 UStG), keine Zahlung. Bis hierher stand der volle Betrag
 * als „bereits gezahlt" in BT-113; die Belegnotiz nannte das Skonto nur daneben.
 *
 * Hier entsteht die eine Aufteilung, die PDF, Ansicht und E-Rechnung gemeinsam
 * benutzen:
 *
 *   - **gezahlt** je Abschlag (brutto, netto, Steuer) — in der E-Rechnung BT-113;
 *   - **Skonto** je Abschlag (brutto, netto, Steuer) — in der E-Rechnung ein
 *     Nachlass auf Belegebene (BG-20, BT-92) mit derselben Steuerkategorie; er
 *     mindert die Bemessungsgrundlage (BT-109) und die Steuer (BT-110).
 *
 * Der Restbetrag (BT-115) bleibt, was der Beleg fordert. Die Steuer der
 * E-Rechnung muss ihre Bemessungsgrundlage mal Satz sein (BR-S-09); dafür wird
 * das Netto des Skontos so gewählt, dass Netto plus Steuerminderung genau das
 * Skonto ergibt. Geht das wegen der Rundung nicht auf, gleicht der
 * Rundungsbetrag (BT-114) den einen Cent aus.
 *
 * Ohne Skonto ändert sich nichts: gezahlt = abgezogen, kein Nachlass, keine Rundung.
 *
 * Rein: kein Zustand, keine Uhr. Woher die Aufteilung je Abschlag kommt, sagt der
 * Aufrufer (`shareOf`) — eingefroren an der freigegebenen Schlussrechnung
 * (`frozenSettlementShare`) oder, im Entwurf, aus dem aktuellen Zahlungsstand.
 */
import { fromCents, taxCentsFromNet, toCents } from '../invoiceMoney';
import type { AbschlagDeduction } from '../../types/models';

export interface AbschlagSettlementShare {
  /** Tatsächlich gezahlt (brutto, höchstens der abgezogene Betrag). */
  readonly paid: number;
  /** Als Skonto gewährt (brutto). */
  readonly skonto: number;
}

export interface AbschlagDeductionPart {
  readonly deduction: AbschlagDeduction;
  /** Abgezogen, wie abgerechnet (brutto/netto). */
  readonly billed: number;
  readonly billedNet: number;
  /** Davon gezahlt. */
  readonly paid: number;
  readonly paidNet: number;
  readonly paidTax: number;
  /** Davon als Skonto gewährt; 0 ohne Skonto. */
  readonly skonto: number;
  readonly skontoNet: number;
  readonly skontoTax: number;
}

export interface AbschlagSkontoSplit {
  readonly parts: readonly AbschlagDeductionPart[];
  readonly hasSkonto: boolean;
  readonly billedTotal: number;
  /** Summe der Zahlungen — BT-113. */
  readonly paidTotal: number;
  /** Summe des Skontos (brutto), wie gedruckt. */
  readonly skontoTotal: number;
  /** Netto des Skontos — der Nachlass BT-92/BT-107. */
  readonly skontoNetTotal: number;
  /** Steueranteil des Skontos, wie gedruckt (Skonto brutto − netto). */
  readonly skontoTaxTotal: number;
  /** Steuer der Schlussrechnung nach dem Nachlass — BT-110. */
  readonly taxAfterSkonto: number;
  /** Rundungsbetrag BT-114 (meist 0). */
  readonly roundingAmount: number;
}

/** Die eingefrorene Aufteilung eines Abzugs (freigegebene Schlussrechnung), sonst null. */
export function frozenSettlementShare(deduction: AbschlagDeduction): AbschlagSettlementShare | null {
  const { paidAmount, skontoAmount } = deduction;
  if (typeof paidAmount !== 'number' || typeof skontoAmount !== 'number') return null;
  if (!Number.isFinite(paidAmount) || !Number.isFinite(skontoAmount)) return null;
  return { paid: paidAmount, skonto: skontoAmount };
}

/** Trägt der Abzug eine eingefrorene Aufteilung? */
export function hasFrozenSettlement(deduction: AbschlagDeduction): boolean {
  return frozenSettlementShare(deduction) !== null;
}

/**
 * Das Netto des Skontos: so, dass Netto + (Steuer vorher − Steuer nachher) genau
 * das Skonto ergibt; sonst das nächstliegende — der Rest ist der Rundungsbetrag.
 */
function chooseSkontoNet(
  skontoCents: number,
  lineNetCents: number,
  taxRate: number,
  taxBeforeCents: number,
): { netCents: number; taxAfterCents: number; residualCents: number } {
  const rate = Number.isFinite(taxRate) && taxRate > 0 ? taxRate : 0;
  const start = Math.round((skontoCents * 100) / (100 + rate));
  let best: { netCents: number; taxAfterCents: number; residualCents: number } | null = null;
  for (let netCents = start - 3; netCents <= start + 3; netCents += 1) {
    if (netCents < 0 || netCents > skontoCents || netCents > lineNetCents) continue;
    const taxAfterCents = taxCentsFromNet(lineNetCents - netCents, rate);
    const residualCents = skontoCents - (netCents + taxBeforeCents - taxAfterCents);
    if (
      !best ||
      Math.abs(residualCents) < Math.abs(best.residualCents) ||
      (Math.abs(residualCents) === Math.abs(best.residualCents) &&
        Math.abs(netCents - start) < Math.abs(best.netCents - start))
    ) {
      best = { netCents, taxAfterCents, residualCents };
    }
  }
  return best ?? { netCents: 0, taxAfterCents: taxBeforeCents, residualCents: skontoCents };
}

/**
 * Die Aufteilung aller Abzüge einer Schlussrechnung.
 *
 * `invoice` trägt das Netto der Positionen und den Steuersatz des Belegs; die
 * Steuer davor ist `taxCentsFromNet(Netto, Satz)` — dieselbe Rechnung wie überall.
 */
export function splitAbschlagDeductions(
  deductions: readonly AbschlagDeduction[] | undefined,
  invoice: { readonly subtotalNet: number; readonly taxRate: number },
  shareOf: (deduction: AbschlagDeduction) => AbschlagSettlementShare | null,
): AbschlagSkontoSplit {
  const lineNetCents = toCents(invoice.subtotalNet);
  const taxBeforeCents = taxCentsFromNet(lineNetCents, invoice.taxRate);

  const rows = (deductions ?? []).map((deduction) => {
    const billedCents = toCents(deduction.amount);
    const billedNetCents = Number.isFinite(deduction.subtotal) ? toCents(deduction.subtotal) : billedCents;
    const share = shareOf(deduction);
    let paidCents = billedCents;
    if (share && toCents(share.skonto) > 0) {
      paidCents = Math.min(billedCents, Math.max(0, toCents(share.paid)));
    }
    return { deduction, billedCents, billedNetCents, paidCents, skontoCents: billedCents - paidCents };
  });

  const skontoCents = rows.reduce((sum, row) => sum + row.skontoCents, 0);
  const choice =
    skontoCents > 0
      ? chooseSkontoNet(skontoCents, lineNetCents, invoice.taxRate, taxBeforeCents)
      : { netCents: 0, taxAfterCents: taxBeforeCents, residualCents: 0 };

  /* Das Netto des Skontos anteilig auf die Abschläge; der letzte nimmt den Rest. */
  const withSkonto = rows.filter((row) => row.skontoCents > 0);
  let restNetCents = choice.netCents;
  const netByRow = new Map<(typeof rows)[number], number>();
  withSkonto.forEach((row, index) => {
    const share =
      index === withSkonto.length - 1
        ? restNetCents
        : Math.min(row.skontoCents, Math.round((choice.netCents * row.skontoCents) / skontoCents));
    netByRow.set(row, share);
    restNetCents -= share;
  });

  const parts: AbschlagDeductionPart[] = rows.map((row) => {
    const skontoNetCents = netByRow.get(row) ?? 0;
    const paidNetCents = row.billedNetCents - skontoNetCents;
    return {
      deduction: row.deduction,
      billed: fromCents(row.billedCents),
      billedNet: fromCents(row.billedNetCents),
      paid: fromCents(row.paidCents),
      paidNet: fromCents(paidNetCents),
      paidTax: fromCents(row.paidCents - paidNetCents),
      skonto: fromCents(row.skontoCents),
      skontoNet: fromCents(skontoNetCents),
      skontoTax: fromCents(row.skontoCents - skontoNetCents),
    };
  });

  return {
    parts,
    hasSkonto: skontoCents > 0,
    billedTotal: fromCents(rows.reduce((sum, row) => sum + row.billedCents, 0)),
    paidTotal: fromCents(rows.reduce((sum, row) => sum + row.paidCents, 0)),
    skontoTotal: fromCents(skontoCents),
    skontoNetTotal: fromCents(choice.netCents),
    skontoTaxTotal: fromCents(skontoCents - choice.netCents),
    taxAfterSkonto: fromCents(choice.taxAfterCents),
    // BT-115 = BT-112 − BT-113 + BT-114: fehlt dem Nachlass ein Cent, steht er hier (sonst 0, nie −0).
    roundingAmount: choice.residualCents === 0 ? 0 : fromCents(-choice.residualCents),
  };
}
