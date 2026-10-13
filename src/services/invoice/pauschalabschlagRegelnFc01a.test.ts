/**
 * FINANZ-CORE-01A (RE-04) — Pauschalabschlag: Obergrenze gegen alles bereits
 * Abgerechnete, keine „Rechnung" nach einem Pauschalabschlag.
 *
 *  P1  der Rest zieht Abschläge, Rechnungen und Teilrechnungen ab (Storno nicht)
 *  P2  Pauschalabschlag über dem Rest nach einer Teilrechnung wird blockiert
 *  P3  „Rechnung" nach Pauschalabschlag blockiert; Teilrechnung mit Hinweis;
 *      Schlussrechnung frei
 *  P4  stornierter Pauschalabschlag und mengenbasierter Abschlag sperren nicht
 *  P5  die Serverablehnung wird als Prüfbefund benannt (Entwurf bleibt bedienbar)
 *  P6  der nächste Schritt nach Pauschalabschlag ist die Schlussrechnung, nicht „Rechnung erstellen"
 */
import { describe, expect, it } from 'vitest';

import { getVorgangById, hydrateVorgangStore } from '../vorgangService';
import {
  buildAbschlagDraft,
  buildInvoiceDraftForType,
  setAbschlagDraftCalculationMode,
  updateInvoiceDraftFixedAmountNet,
} from '../invoiceService';
import { validateInvoiceDraftForApproval } from '../invoiceValidationService';
import {
  getPreFinalBilledNetCents,
  getRemainingFixedAmountBillableNetCents,
  hasDeductibleAbschlag,
} from '../orderBillingRules';
import { classifyInvoiceCloudErrorForTests } from './workspaceInvoiceCloudService';
import { mapCloudErrorForTests } from './invoicePreparedFinalizeService';
import { analyzeVorgangWorkflow } from '../brain/workflowIntelligenceService';
import { createOrderPosition, createTestVorgang, testSetup } from '../../test/fixtures';
import type { InvoiceDocumentType, InvoiceDraft, VorgangInvoice } from '../../types/models';

const VORGANG_ID = 'v-test-1';

function beleg(
  id: string,
  type: InvoiceDocumentType,
  subtotal: number,
  overrides: Partial<VorgangInvoice> = {},
): VorgangInvoice {
  return {
    id,
    number: `RE-2026-${id}`,
    type,
    positions: [],
    subtotal,
    taxStatus: 'standard_19',
    amount: Math.round(subtotal * 119) / 100,
    status: 'vorbereitet',
    date: '2026-03-01',
    createdAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  } as VorgangInvoice;
}

function pauschal(id: string, net: number, overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return beleg(id, 'abschlag', net, { calculationMode: 'fixed_amount', fixedAmountNet: net, abschlagNumber: 1, ...overrides });
}

/** Teil- oder Mengenbeleg über `menge` Einheiten der einen Auftragsposition (100 € je Einheit). */
function mengenBeleg(id: string, type: InvoiceDocumentType, menge: number, overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return beleg(id, type, menge * 100, {
    positions: [
      {
        id: `line-${id}`,
        orderPositionId: 'op-1',
        description: 'Montage',
        quantity: menge,
        unit: 'Stück',
        unitPrice: 100,
        lineTotal: menge * 100,
      },
    ],
    ...overrides,
  });
}

/** Auftrag: 100 Einheiten à 100 € = 10.000 € netto. */
function setup(invoices: VorgangInvoice[] = []): void {
  hydrateVorgangStore([
    createTestVorgang({
      id: VORGANG_ID,
      materialSource: 'betrieb',
      orderPositions: [
        createOrderPosition({ id: 'op-1', plannedQuantity: 100, unit: 'Stück', unitPrice: 100, category: 'arbeit' }),
      ],
      invoices,
    }),
  ]);
}

function withCompany(draft: InvoiceDraft): InvoiceDraft {
  return {
    ...draft,
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-20',
    servicePeriodConfirmed: true,
    companySnapshot: {
      ...draft.companySnapshot,
      companyName: 'Muster GmbH',
      street: 'Musterallee 5',
      zip: '30000',
      city: 'Musterstadt',
    },
  };
}

function check(draft: InvoiceDraft) {
  const result = validateInvoiceDraftForApproval(draft, draft.companySnapshot, getVorgangById(VORGANG_ID)!, {
    reverseCharge13bConfirmed: true,
  });
  return {
    blocking: result.blockingErrors.map((issue) => issue.code),
    warnings: result.warnings.map((issue) => issue.code),
  };
}

function draftFor(type: InvoiceDocumentType): InvoiceDraft {
  const draft = buildInvoiceDraftForType(VORGANG_ID, testSetup, type);
  expect(draft, `Entwurf ${type} konnte nicht gebaut werden`).not.toBeNull();
  return withCompany(draft!);
}

function fixedDraft(net: number): InvoiceDraft {
  const base = buildAbschlagDraft(VORGANG_ID, testSetup);
  expect(base).not.toBeNull();
  return withCompany(updateInvoiceDraftFixedAmountNet(setAbschlagDraftCalculationMode(base!, 'fixed_amount', testSetup), net));
}

describe('RE-04 — Obergrenze des Pauschalabschlags', () => {
  it('P1: abgezogen werden Abschläge, Rechnungen und Teilrechnungen — stornierte nicht', () => {
    setup([
      pauschal('ab1', 1000),
      mengenBeleg('teil1', 'teilrechnung', 30),
      mengenBeleg('re1', 'rechnung', 20),
      pauschal('ab-storno', 500, { abschlagNumber: 2, cancelledAt: '2026-04-01T10:00:00.000Z', paymentStatus: 'storniert' }),
    ]);
    const vorgang = getVorgangById(VORGANG_ID)!;
    expect(getPreFinalBilledNetCents(vorgang)).toBe(600_000);
    expect(getRemainingFixedAmountBillableNetCents(vorgang)).toBe(1_000_000 - 600_000);
  });

  it('P2: nach einer Teilrechnung über 8.000 € ist ein Pauschalabschlag nur bis 2.000 € zulässig', () => {
    setup([mengenBeleg('teil1', 'teilrechnung', 80)]);
    expect(check(fixedDraft(2000.01)).blocking).toContain('abschlag_exceeds_order_value');
    expect(check(fixedDraft(2000)).blocking).not.toContain('abschlag_exceeds_order_value');
  });
});

describe('RE-04 — Rechnungsart nach Pauschalabschlag', () => {
  it('P3: „Rechnung" blockiert, Teilrechnung mit Hinweis, Schlussrechnung ohne Einwand', () => {
    setup([pauschal('ab1', 1500)]);
    expect(hasDeductibleAbschlag(getVorgangById(VORGANG_ID)!)).toBe(true);

    expect(check(draftFor('rechnung')).blocking).toContain('fixed_abschlag_requires_schluss');

    const teil = check(draftFor('teilrechnung'));
    expect(teil.blocking).not.toContain('fixed_abschlag_requires_schluss');
    expect(teil.warnings).toContain('fixed_abschlag_deducted_in_schluss');

    const schluss = check(draftFor('schluss'));
    expect(schluss.blocking).not.toContain('fixed_abschlag_requires_schluss');
    expect(schluss.warnings).not.toContain('fixed_abschlag_deducted_in_schluss');
  });

  it('P4: ein stornierter Pauschalabschlag und ein Mengenabschlag sperren die Rechnung nicht', () => {
    setup([pauschal('ab-storno', 1500, { cancelledAt: '2026-04-01T10:00:00.000Z', paymentStatus: 'storniert' })]);
    expect(check(draftFor('rechnung')).blocking).not.toContain('fixed_abschlag_requires_schluss');

    setup([mengenBeleg('ab-menge', 'abschlag', 10, { abschlagNumber: 1 })]);
    expect(hasDeductibleAbschlag(getVorgangById(VORGANG_ID)!)).toBe(false);
    expect(check(draftFor('rechnung')).blocking).not.toContain('fixed_abschlag_requires_schluss');
  });

  it('P6: nach dem Pauschalabschlag empfiehlt der Ablauf die Schlussrechnung', () => {
    setup([pauschal('ab1', 1500)]);
    const ids = analyzeVorgangWorkflow(VORGANG_ID)?.recommendations.map((r) => r.id) ?? [];
    expect(ids).toContain('create_schluss');
    expect(ids).not.toContain('create_invoice');

    setup([]);
    const ohne = analyzeVorgangWorkflow(VORGANG_ID)?.recommendations.map((r) => r.id) ?? [];
    expect(ohne).not.toContain('create_schluss');
  });

  it('P5: die Serverablehnung ist ein Prüfbefund, nichts wurde geschrieben', () => {
    for (const message of [
      'invoice_requires_final_after_fixed_abschlag',
      'invoice_fixed_amount_exceeds_remaining: 250000 > 200000',
    ]) {
      const error = classifyInvoiceCloudErrorForTests({ message, code: 'P0001' });
      expect(error.code).toBe('totals_mismatch');
      expect(mapCloudErrorForTests(error.code, message)).toEqual({
        reason: 'server_integrity_rejected',
        cloudState: 'not_committed',
      });
    }
  });
});
