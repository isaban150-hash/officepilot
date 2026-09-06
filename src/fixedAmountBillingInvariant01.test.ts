/**
 * FIXED-AMOUNT-BILLING-INVARIANT-01B2 — ein pauschaler Abschlag darf den
 * abrechenbaren Auftragswert nicht ueberschreiten.
 *
 * Realbefund: Bei einem Netto-Auftragswert von 26.548,00 EUR liess sich eine
 * pauschale Abschlagsrechnung ueber 30.000,00 EUR finalisieren. Erst die
 * spaetere Schlussrechnung wurde durch `deductions_exceed_total` (3e6fde1)
 * blockiert — da war der Vorgang aber bereits in der Sackgasse.
 *
 * `quantity_based` ist ueber `getBillableOpenQuantity` bereits mengenmaessig
 * gedeckelt; `fixed_amount` kannte bis hierher nur `net > 0`.
 *
 * **Geprueft wird die produktive Approval- und Finalisierungsebene**, nicht der
 * neue Helper isoliert.
 *
 * Neutrale Beispieldaten, kein Kundenbezug.
 */
import { describe, expect, it } from 'vitest';

import { hydrateVorgangStore, getVorgangById } from './services/vorgangService';
import {
  buildAbschlagDraft,
  finalizeInvoiceDraft,
  setAbschlagDraftCalculationMode,
  updateInvoiceDraftFixedAmountNet,
  updateDraftPositionQuantity,
} from './services/invoiceService';
import { validateInvoiceDraftForApproval } from './services/invoiceValidationService';
import {
  getCountedAbschlagNetCents,
  getCurrentBillableOrderNetCents,
  getRemainingFixedAmountBillableNetCents,
} from './services/orderBillingRules';
import { createOrderPosition, createTestVorgang, testSetup } from './test/fixtures';
import type {
  InvoiceDraft,
  MaterialStandard,
  OrderPosition,
  Vorgang,
  VorgangInvoice,
} from './types/models';

const VORGANG_ID = 'v-test-1';

/** Eine COUNTED Abschlagsrechnung mit explizitem Nettobetrag (`subtotal`). */
function countedAbschlag(id: string, netAmount: number, abschlagNumber: number): VorgangInvoice {
  return {
    id,
    number: `AR-2026-0${abschlagNumber}`,
    type: 'abschlag',
    abschlagNumber,
    positions: [],
    calculationMode: 'fixed_amount',
    fixedAmountNet: netAmount,
    subtotal: netAmount,
    taxStatus: 'standard_19',
    // Bewusst brutto — die Invariante darf diesen Wert nicht heranziehen.
    amount: netAmount * 1.19,
    status: 'vorbereitet',
    date: '2026-03-01',
    createdAt: '2026-03-01T10:00:00.000Z',
  };
}

function setup(
  positions: OrderPosition[],
  invoices: VorgangInvoice[] = [],
  materialSource: MaterialStandard = 'betrieb',
): Vorgang {
  const vorgang = createTestVorgang({ orderPositions: positions, invoices, materialSource });
  hydrateVorgangStore([vorgang]);
  return vorgang;
}

/** Ein Auftrag mit genau einem abrechenbaren Nettowert. */
function order(netValue: number): OrderPosition[] {
  return [
    createOrderPosition({
      id: 'op-test-1',
      plannedQuantity: 1,
      unit: 'Pauschal',
      unitPrice: netValue,
      category: 'arbeit',
    }),
  ];
}

/**
 * Ein vollstaendiger Firmenblock. Ohne ihn blockiert `company_address` die
 * Finalisierung — pauschale Abschlaege durchlaufen die **volle**
 * Genehmigungspruefung. Das ist bestehendes Verhalten und nicht Gegenstand
 * dieses Blocks; der Firmenblock haelt die Fixture nur aus dem Weg.
 */
function withCompany(draft: InvoiceDraft): InvoiceDraft {
  return {
    ...draft,
    /*
     * INVOICE-SERVICE-PERIOD-01B2 — gültige, bestätigte Metadatenbasis.
     * Diese Suite prüft die Abschlagsobergrenze, nicht den Leistungszeitraum;
     * bis 01B lieferte der Entwurfsbauer ihn selbst.
     */
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

/** Baut den pauschalen Abschlagsentwurf über die produktive API. */
function fixedDraft(net: number): InvoiceDraft {
  const base = buildAbschlagDraft(VORGANG_ID, testSetup);
  expect(base, 'Abschlagsentwurf konnte nicht gebaut werden').not.toBeNull();
  const fixed = setAbschlagDraftCalculationMode(base!, 'fixed_amount', testSetup);
  return withCompany(updateInvoiceDraftFixedAmountNet(fixed, net));
}

function blockingCodes(draft: InvoiceDraft): string[] {
  const vorgang = getVorgangById(VORGANG_ID)!;
  return validateInvoiceDraftForApproval(draft, draft.companySnapshot, vorgang, {
    reverseCharge13bConfirmed: true,
  }).blockingErrors.map((issue) => issue.code);
}

const CODE = 'abschlag_exceeds_order_value';

describe('FIXED-AMOUNT-BILLING-INVARIANT-01B2 — zu hohe Pauschalabschläge', () => {
  it('R1: ein einzelner Pauschalabschlag über dem Auftragswert wird blockiert', () => {
    setup(order(26548));
    const draft = fixedDraft(30000);

    expect(blockingCodes(draft), 'Der Überhang erzeugte keinen blockierenden Fehler').toContain(
      CODE,
    );

    const result = finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);
    expect(result.ok, 'Ein zu hoher Pauschalabschlag wurde finalisiert').toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('validation_failed');
    expect(getVorgangById(VORGANG_ID)!.invoices).toHaveLength(0);
  });

  it('R3: ein Cent über dem Restwert wird blockiert', () => {
    setup(order(100000), [
      countedAbschlag('inv-a1', 40000, 1),
      countedAbschlag('inv-a2', 35000, 2),
    ]);
    const draft = fixedDraft(25000.01);

    expect(blockingCodes(draft), 'Ein Cent Überhang blieb unbemerkt').toContain(CODE);
    expect(finalizeInvoiceDraft(VORGANG_ID, draft, testSetup).ok).toBe(false);
  });

  it('R4: die Kumulation stammt aus den COUNTED Abschlägen, nicht aus dem Einzelbetrag', () => {
    setup(order(100000), [
      countedAbschlag('inv-a1', 40000, 1),
      countedAbschlag('inv-a2', 35000, 2),
    ]);
    // 30.000 allein liegt weit unter 100.000 — erst 40 + 35 + 30 > 100 blockiert.
    const draft = fixedDraft(30000);

    expect(
      blockingCodes(draft),
      'Es wurde nur der Einzelbetrag gegen den Auftragswert geprüft',
    ).toContain(CODE);
    expect(finalizeInvoiceDraft(VORGANG_ID, draft, testSetup).ok).toBe(false);
  });

  /*
   * R10 — ein partieller Vorgang darf nicht abstürzen.
   *
   * `orderPositions` und `invoices` sind zwar als Pflichtfelder typisiert, aber
   * Alt-, Import- und Cloud-Daten koennen sie verlieren; derselbe
   * Finalisierungsbereich schreibt an mehreren Stellen `?? []`. Ohne diesen
   * Schutz warf die Validierung einen TypeError, den der Aufrufer nur als
   * `invalid_candidate` sah.
   *
   * Fehlende Auftragspositionen ergeben 0 € Basis — das sperrt **strenger**,
   * statt einen Pauschalabschlag durchzulassen.
   */
  it('R10: ein Vorgang ohne orderPositions/invoices blockiert statt abzustürzen', () => {
    // Der Entwurf entsteht am vollständigen Vorgang — `buildAbschlagDraft`
    // verlangt Positionen. Erst danach verliert der Speicher die Arrays, wie
    // es bei Alt- oder Importdaten geschieht.
    setup(order(100000));
    const draft = fixedDraft(1000);

    const partial = createTestVorgang({ orderPositions: [], invoices: [] });
    delete (partial as unknown as Record<string, unknown>).orderPositions;
    delete (partial as unknown as Record<string, unknown>).invoices;
    hydrateVorgangStore([partial]);

    expect(
      () => blockingCodes(draft),
      'Der partielle Vorgang liess die Validierung abstürzen',
    ).not.toThrow();
    expect(blockingCodes(draft)).toContain(CODE);

    const result = finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('validation_failed');
    expect(getVorgangById(VORGANG_ID)!.invoices ?? []).toHaveLength(0);
  });

  it('R8: ein bereits überzogener Bestandsvorgang nimmt keinen weiteren Abschlag an', () => {
    setup(order(100000), [
      countedAbschlag('inv-a1', 60000, 1),
      countedAbschlag('inv-a2', 45000, 2),
    ]);
    const draft = fixedDraft(1000);

    expect(
      blockingCodes(draft),
      'Ein überzogener Vorgang liess sich weiter erhöhen',
    ).toContain(CODE);
    expect(finalizeInvoiceDraft(VORGANG_ID, draft, testSetup).ok).toBe(false);
  });

  /*
   * R9 — der abrechenbare Auftragswert ist nicht der sichtbare Vertragswert.
   * Stellt der Auftraggeber das Material, ist diese Position nicht abrechenbar
   * (`isPositionBillable`) und zählt nicht zur Grenze.
   */
  it('R9: nicht abrechenbares Material zählt nicht zur Grenze', () => {
    const positions = [
      createOrderPosition({
        id: 'op-arbeit',
        plannedQuantity: 1,
        unit: 'Pauschal',
        unitPrice: 7610,
        category: 'arbeit',
      }),
      createOrderPosition({
        id: 'op-material',
        plannedQuantity: 1,
        unit: 'Pauschal',
        unitPrice: 2400,
        category: 'material',
      }),
    ];

    setup(positions, [], 'auftraggeber');
    expect(
      blockingCodes(fixedDraft(7610)),
      'Der abrechenbare Wert 7.610 wurde nicht ausgeschöpft',
    ).not.toContain(CODE);

    setup(positions, [], 'auftraggeber');
    expect(
      blockingCodes(fixedDraft(7610.01)),
      'Die Grenze folgte dem Vertragswert 10.010 statt dem abrechenbaren 7.610',
    ).toContain(CODE);
  });
});

describe('FIXED-AMOUNT-BILLING-INVARIANT-01B2 — Schutzfälle', () => {
  it('R2: exakt ausgeschöpft bleibt zulässig', () => {
    setup(order(100000), [
      countedAbschlag('inv-a1', 40000, 1),
      countedAbschlag('inv-a2', 35000, 2),
    ]);
    const draft = fixedDraft(25000);

    expect(blockingCodes(draft), 'Die exakte Ausschöpfung wurde blockiert').not.toContain(CODE);

    const result = finalizeInvoiceDraft(VORGANG_ID, draft, testSetup);
    expect(result.ok, 'Der exakt passende Abschlag wurde nicht finalisiert').toBe(true);
  });

  it('R5: der eigene Entwurf zählt nicht zusätzlich gegen sich selbst', () => {
    setup(order(100000));
    // Ohne Doppelzählung sind 100.000 exakt zulässig; mit wären es 200.000.
    expect(blockingCodes(fixedDraft(100000))).not.toContain(CODE);
  });

  /*
   * S1 — die angezeigte Grenze und die blockierende Grenze stammen aus
   * derselben Quelle. `RechnungPage` liest genau diesen Helper und klemmt nur
   * für die Anzeige bei 0; die Validierung liest ihn ungeklammert.
   */
  it('S1: der Anzeigewert stammt aus demselben SSOT wie die Sperre', () => {
    setup(order(100000), [countedAbschlag('inv-a1', 40000, 1)]);
    const vorgang = getVorgangById(VORGANG_ID)!;

    expect(getCurrentBillableOrderNetCents(vorgang)).toBe(10_000_000);
    expect(getCountedAbschlagNetCents(vorgang)).toBe(4_000_000);
    expect(getRemainingFixedAmountBillableNetCents(vorgang)).toBe(6_000_000);

    // Exakt an der angezeigten Grenze zulässig, einen Cent darüber nicht.
    expect(blockingCodes(fixedDraft(60000))).not.toContain(CODE);
    setup(order(100000), [countedAbschlag('inv-a1', 40000, 1)]);
    expect(blockingCodes(fixedDraft(60000.01))).toContain(CODE);
  });

  it('S2: ein überzogener Vorgang liefert einen negativen Restwert für die Sperre', () => {
    setup(order(100000), [
      countedAbschlag('inv-a1', 60000, 1),
      countedAbschlag('inv-a2', 45000, 2),
    ]);
    const remaining = getRemainingFixedAmountBillableNetCents(getVorgangById(VORGANG_ID)!);

    expect(remaining, 'Der negative Zustand wurde vorzeitig weggeklemmt').toBe(-500_000);
    // Die Anzeige darf 0,00 € zeigen — die Sperre darf das nicht.
    expect(Math.max(0, remaining)).toBe(0);
  });

  it('R6: ein mengenbasierter Abschlag bleibt unverändert finalisierbar', () => {
    setup([
      createOrderPosition({ id: 'op-test-1', plannedQuantity: 10, unitPrice: 65 }),
    ]);
    const base = withCompany(buildAbschlagDraft(VORGANG_ID, testSetup)!);
    const draft = updateDraftPositionQuantity(base, base.positions[0].id, 4);

    expect(blockingCodes(draft)).not.toContain(CODE);
    expect(finalizeInvoiceDraft(VORGANG_ID, draft, testSetup).ok).toBe(true);
  });

  /*
   * R7 — die Vorwärtssperre darf keine Zukunftskenntnis modellieren. Ein
   * Abschlag über 90.000 ist gegen 100.000 Planwert zulässig, auch wenn die
   * Ausführung später nur 80.000 ergibt. Diesen Überhang fängt allein der
   * Schlussrechnungs-P0 `deductions_exceed_total` aus 3e6fde1.
   */
  it('R7: spätere Minderleistung macht einen zulässigen Abschlag nicht rückwirkend falsch', () => {
    setup([
      createOrderPosition({
        id: 'op-test-1',
        plannedQuantity: 1,
        unit: 'Pauschal',
        unitPrice: 100000,
        category: 'arbeit',
        executedQuantity: 0.8,
      }),
    ]);

    expect(
      blockingCodes(fixedDraft(90000)),
      'Die Vorwärtssperre hat die ausgeführte Menge herangezogen',
    ).not.toContain(CODE);
    expect(finalizeInvoiceDraft(VORGANG_ID, fixedDraft(90000), testSetup).ok).toBe(true);
  });
});
