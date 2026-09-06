/**
 * FINAL-INVOICE-OVERPAYMENT-INTEGRITY-01B — eine Schlussrechnung darf einen
 * Ueberhang nicht verschlucken.
 *
 * Realbefund: Uebersteigen die bereits abgerechneten Abschlaege den
 * endgueltigen Leistungswert, klemmt OfficePilot die negative Differenz auf
 * 0,00 EUR, finalisiert eine 0-EUR-Schlussrechnung und markiert den Vorgang
 * danach als vollstaendig abgerechnet. Der Fehlbetrag verschwindet spurlos.
 *
 * **Geprueft wird die produktive Finalisierungsebene** — `finalizeInvoiceDraft`
 * gegen den echten Vorgangsspeicher, nicht `calculateInvoiceTotals` isoliert.
 * Genau diese Ebenenverwechslung hat in frueheren Bloecken gruene Tests bei
 * rotem Verhalten erzeugt.
 *
 * Neutrale Beispieldaten, kein Kundenbezug.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { hydrateVorgangStore, getVorgangById } from './services/vorgangService';
import {
  buildSchlussrechnungDraft,
  finalizeInvoiceDraft,
} from './services/invoiceService';
import { validateInvoiceDraftForApproval } from './services/invoiceValidationService';
import { hasSchlussrechnung, hasFinalSchlussrechnung } from './services/orderBillingRules';
import { createOrderPosition, createTestVorgang, testSetup } from './test/fixtures';
import type { InvoiceDraft, Vorgang, VorgangInvoice } from './types/models';

const VORGANG_ID = 'v-test-1';

/** 10 Stunden zu 65 EUR = 650,00 netto, 773,50 brutto. */
const GROSS_TOTAL = 773.5;

/**
 * Ein Abschlag **ohne** Positionszeilen: Er zieht Geld ab, ohne Menge zu
 * verbrauchen. So bleibt der Leistungswert der Schlussrechnung konstant und der
 * Ueberhang ist die einzige Variable im Test.
 */
function abschlag(amount: number, overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-abschlag-1',
    number: 'AR-2026-01',
    type: 'abschlag',
    abschlagNumber: 1,
    positions: [],
    subtotal: amount / 1.19,
    taxStatus: 'standard_19',
    amount,
    status: 'vorbereitet',
    date: '2026-03-01',
    createdAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  };
}

function vorgangWith(deduction: VorgangInvoice): Vorgang {
  return createTestVorgang({
    orderPositions: [createOrderPosition({ id: 'op-test-1' })],
    invoices: [deduction],
  });
}

/** Baut den Schlussrechnungsentwurf ueber die produktive API. */
function schlussDraft(): InvoiceDraft {
  const draft = buildSchlussrechnungDraft(VORGANG_ID, testSetup);
  expect(draft, 'Schlussrechnungsentwurf konnte nicht gebaut werden').not.toBeNull();
  return draft!;
}

function blockingCodes(draft: InvoiceDraft): string[] {
  const vorgang = getVorgangById(VORGANG_ID)!;
  return validateInvoiceDraftForApproval(draft, draft.companySnapshot, vorgang, {
    reverseCharge13bConfirmed: true,
  }).blockingErrors.map((issue) => issue.code);
}

/** Setzt Speicher und Entwurf für einen Abzugsbetrag auf. */
function prepare(deductionAmount: number, overrides: Partial<VorgangInvoice> = {}): InvoiceDraft {
  hydrateVorgangStore([vorgangWith(abschlag(deductionAmount, overrides))]);
  return schlussDraft();
}

describe('FINAL-INVOICE-OVERPAYMENT-INTEGRITY-01B — zulässige Schlussrechnungen', () => {
  it('R1: Abschläge unter dem Leistungswert lassen einen positiven Rest zu', () => {
    const draft = prepare(400);

    expect(blockingCodes(draft)).not.toContain('deductions_exceed_total');

    const result = finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);
    expect(result.ok, 'Eine normale Schlussrechnung wurde blockiert').toBe(true);
    if (!result.ok) return;
    expect(result.invoice.amount).toBeCloseTo(GROSS_TOTAL - 400, 2);
  });

  /**
   * S1 — Blast-Radius-Schutz.
   *
   * Mengenbasierte Schlussrechnungen durchlaufen historisch bewusst **nicht**
   * die vollstaendige Genehmigungsvalidierung. `company_address` ist in dieser
   * Baseline als blockierender Fehler vorhanden und hat die Finalisierung
   * trotzdem nie verhindert. Dieser Block darf daran nichts aendern: Nur
   * `deductions_exceed_total` wird neu fail-closed geschaltet.
   */
  it('S1: ein unbeteiligter Approval-Blocker härtet die Finalisierung nicht', () => {
    const draft = prepare(400);

    expect(
      blockingCodes(draft),
      'Die Baseline enthält company_address nicht mehr — Schutztest ist wirkungslos',
    ).toContain('company_address');

    const result = finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);
    expect(
      result.ok,
      'Ein unbeteiligter Approval-Blocker blockiert jetzt die Finalisierung',
    ).toBe(true);
  });

  it('R2: Abschläge exakt in Höhe des Leistungswerts bleiben eine gültige 0-EUR-Schlussrechnung', () => {
    const draft = prepare(GROSS_TOTAL);

    const codes = blockingCodes(draft);
    expect(codes, 'Der 0-EUR-Fall wurde als Überhang behandelt').not.toContain(
      'deductions_exceed_total',
    );
    expect(codes).not.toContain('totals_negative');
    expect(codes).not.toContain('zero_billable_value');

    const result = finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);
    expect(result.ok, 'Die gültige 0-EUR-Schlussrechnung wurde blockiert').toBe(true);
    if (!result.ok) return;
    expect(result.invoice.amount).toBeCloseTo(0, 2);
  });
});

describe('FINAL-INVOICE-OVERPAYMENT-INTEGRITY-01B — Überabrechnung wird blockiert', () => {
  beforeEach(() => {
    hydrateVorgangStore([]);
  });

  /**
   * Der Kernfall. Ein Ueberhang darf nicht als 0-EUR-Schlussrechnung
   * durchgehen: Das Geld verschwindet, und der Vorgang verriegelt sich
   * anschliessend ueber `hasSchlussrechnung`.
   */
  it('R3: ein echter Überhang blockiert die Finalisierung', () => {
    const draft = prepare(GROSS_TOTAL + 226.5);

    expect(blockingCodes(draft), 'Der Überhang erzeugte keinen blockierenden Fehler').toContain(
      'deductions_exceed_total',
    );

    const result = finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);
    expect(result.ok, 'Eine überabgerechnete Schlussrechnung wurde finalisiert').toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('validation_failed');
  });

  it('R3b: nach dem Block existiert keine Schlussrechnung und der Vorgang bleibt offen', () => {
    const draft = prepare(GROSS_TOTAL + 226.5);
    finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);

    const stored = getVorgangById(VORGANG_ID)!;
    expect(
      stored.invoices.filter((invoice) => invoice.type === 'schluss'),
      'Es wurde trotz Blockade eine Schlussrechnung angelegt',
    ).toHaveLength(0);
    expect(hasSchlussrechnung(stored)).toBe(false);
    expect(hasFinalSchlussrechnung(stored)).toBe(false);
  });

  it('R4: ein Überhang von einem Cent wird genauso blockiert', () => {
    const draft = prepare(GROSS_TOTAL + 0.01);

    expect(blockingCodes(draft), 'Ein Cent Überhang blieb unbemerkt').toContain(
      'deductions_exceed_total',
    );

    const result = finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);
    expect(result.ok).toBe(false);
  });

  /**
   * R5 misst nur, ob der pauschale Abschlag denselben Schutz erreicht. Dieser
   * Block baut **keine** Summeninvariante beim Finalisieren eines Abschlags —
   * das ist der nachgelagerte fixed_amount-P1.
   */
  it('R5: ein pauschaler Abschlag über dem Leistungswert erreicht denselben Block', () => {
    const draft = prepare(GROSS_TOTAL + 226.5, {
      calculationMode: 'fixed_amount',
      fixedAmountNet: (GROSS_TOTAL + 226.5) / 1.19,
    });

    expect(blockingCodes(draft)).toContain('deductions_exceed_total');

    const result = finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);
    expect(result.ok).toBe(false);
  });
});
