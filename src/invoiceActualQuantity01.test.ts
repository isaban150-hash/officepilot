/**
 * INVOICE-ACTUAL-QUANTITY-01B — die Planmenge ist kein Aufmass.
 *
 * Realbefund aus der Analyse: `initialQuantityForType` belegte fuer
 * `rechnung`, `teilrechnung` und `schluss` mit `getBillableOpenQuantity` vor —
 * und die Funktion faellt bei fehlender `executedQuantity` auf
 * `plannedQuantity` zurueck (im Code selbst als „legacy fallback" benannt).
 * Ein Auftrag ueber 420 m² ohne erfasste Ausfuehrung schlug damit 420 m² als
 * abzurechnende Menge vor.
 *
 * **`getBillableOpenQuantity` bleibt unveraendert.** Sie ist zugleich die
 * Eingabe-Obergrenze: Ohne sie koennte der Nutzer bei fehlender Ausfuehrung
 * ueberhaupt keine Menge mehr eintragen. Geaendert wird ausschliesslich die
 * **Vorbelegung**, nicht die Grenze.
 *
 * Neutrale Beispieldaten, kein Kundenbezug.
 */
import { describe, expect, it } from 'vitest';

import { hydrateVorgangStore } from './services/vorgangService';
import {
  applyAllOpenPositionsToDraft,
  buildInvoiceDraftForType,
  updateDraftPositionQuantity,
} from './services/invoiceService';
import { createOrderPosition, createTestVorgang, testSetup } from './test/fixtures';
import type { InvoiceDocumentType, InvoiceDraft, VorgangInvoice } from './types/models';

const VORGANG_ID = 'v-test-1';
const POSITION_ID = 'op-test-1';

/** Der Kontrollfall: 420 m² geplant zu 25,00 €. */
function seed(options: {
  executedQuantity?: number;
  invoices?: VorgangInvoice[];
}): void {
  hydrateVorgangStore([
    createTestVorgang({
      orderPositions: [
        createOrderPosition({
          id: POSITION_ID,
          description: 'Dachbahn verlegen',
          plannedQuantity: 420,
          unit: 'm2',
          unitPrice: 25,
          category: 'arbeit',
          ...(options.executedQuantity === undefined
            ? {}
            : { executedQuantity: options.executedQuantity }),
        }),
      ],
      invoices: options.invoices ?? [],
    }),
  ]);
}

/** Eine bereits gezählte Rechnung über `quantity` Einheiten derselben Position. */
function billed(quantity: number): VorgangInvoice {
  return {
    id: 'inv-billed-1',
    number: '2026-0001',
    type: 'abschlag',
    abschlagNumber: 1,
    positions: [
      {
        id: 'line-1',
        orderPositionId: POSITION_ID,
        description: 'Dachbahn verlegen',
        quantity,
        unit: 'm2',
        unitLabel: 'm²',
        unitPrice: 25,
        lineTotal: quantity * 25,
      },
    ],
    subtotal: quantity * 25,
    taxStatus: 'standard_19',
    amount: quantity * 25 * 1.19,
    status: 'vorbereitet',
    date: '2026-08-01',
    createdAt: '2026-08-01T08:00:00.000Z',
  } as VorgangInvoice;
}

function draftFor(type: InvoiceDocumentType): InvoiceDraft {
  const draft = buildInvoiceDraftForType(VORGANG_ID, testSetup, type);
  expect(draft, `Entwurf für ${type} konnte nicht gebaut werden`).not.toBeNull();
  return draft!;
}

function position(draft: InvoiceDraft) {
  const found = draft.positions.find((p) => p.orderPositionId === POSITION_ID);
  expect(found, 'Position fehlt im Entwurf').toBeDefined();
  return found!;
}

describe('INVOICE-ACTUAL-QUANTITY-01B — ohne erfasste Ausführung keine Vorbelegung', () => {
  it('Q1: eine Rechnung startet mit 0, die Obergrenze bleibt die Planmenge', () => {
    seed({});
    const pos = position(draftFor('rechnung'));

    expect(pos.quantity, 'Die Planmenge wurde als Rechnungsmenge vorbelegt').toBe(0);
    // Entscheidend: Der Nutzer kann weiterhin bis 420 eintragen.
    expect(pos.openQuantity, 'Die Eingabe-Obergrenze wurde mitverändert').toBe(420);
    expect(pos.plannedQuantity).toBe(420);
    expect(pos.executedQuantity).toBeUndefined();
  });

  it('Q2: eine Teilrechnung startet mit 0', () => {
    seed({});
    const pos = position(draftFor('teilrechnung'));

    expect(pos.quantity).toBe(0);
    expect(pos.openQuantity).toBe(420);
  });

  /*
   * Q3 — der schwerwiegendste Fall. Bei der Schlussrechnung soll der Nutzer
   * das endgültige Aufmass abrechnen; eine vorbelegte Planmenge wäre eine
   * stille Behauptung über die erbrachte Leistung.
   */
  it('Q3: eine Schlussrechnung übernimmt die Planmenge nicht als Endaufmaß', () => {
    seed({});
    const pos = position(draftFor('schluss'));

    expect(pos.quantity, 'Die Planmenge erschien als endgültiges Aufmaß').toBe(0);
    expect(pos.openQuantity).toBe(420);
  });

  it('Q4: ein mengenbasierter Abschlag bleibt wie bisher bei 0', () => {
    seed({});
    const pos = position(draftFor('abschlag'));

    expect(pos.quantity).toBe(0);
  });

  it('Q8: „Alle Positionen übernehmen" setzt ohne Ausführung keine Menge', () => {
    seed({});
    const applied = applyAllOpenPositionsToDraft(draftFor('rechnung'));

    expect(
      position(applied).quantity,
      'Der Sammelbutton übernahm die Planmenge',
    ).toBe(0);
  });
});

describe('INVOICE-ACTUAL-QUANTITY-01B — mit erfasster Ausführung unverändert', () => {
  it('Q5: die ausgeführte Menge wird vorgeschlagen', () => {
    for (const type of ['rechnung', 'teilrechnung', 'schluss'] as InvoiceDocumentType[]) {
      seed({ executedQuantity: 185 });
      const pos = position(draftFor(type));

      expect(pos.quantity, `${type} schlug nicht die ausgeführte Menge vor`).toBe(185);
      expect(pos.openQuantity).toBe(185);
    }
  });

  it('Q6: bereits abgerechnete Mengen werden abgezogen', () => {
    seed({ executedQuantity: 300, invoices: [billed(185)] });
    const pos = position(draftFor('rechnung'));

    expect(pos.quantity).toBe(115);
    expect(pos.openQuantity).toBe(115);
    expect(pos.billedQuantity).toBe(185);
  });

  it('Q7: eine Ausführung über der Planmenge bleibt auf den Plan gekappt', () => {
    seed({ executedQuantity: 500 });
    const pos = position(draftFor('rechnung'));

    expect(pos.quantity, 'Die Math.min-Kappung wurde verändert').toBe(420);
    expect(pos.openQuantity).toBe(420);
  });

  it('Q9: „Alle Positionen übernehmen" nutzt weiterhin die offene Ist-Menge', () => {
    seed({ executedQuantity: 185 });
    const applied = applyAllOpenPositionsToDraft(draftFor('rechnung'));

    expect(position(applied).quantity).toBe(185);
  });
});

describe('INVOICE-ACTUAL-QUANTITY-01B — bewusste Eingabe bleibt möglich', () => {
  /*
   * Q10 — der Kern der Abgrenzung: Der Fix verhindert die automatische
   * Vorbelegung, nicht die Eingabe. Ohne erfasste Ausführung bleibt die
   * Planmenge die Obergrenze.
   */
  it('Q10: der Nutzer kann ohne erfasste Ausführung bewusst eine Menge setzen', () => {
    seed({});
    const draft = draftFor('rechnung');
    expect(position(draft).quantity).toBe(0);

    const updated = updateDraftPositionQuantity(draft, position(draft).id, 185);

    expect(position(updated).quantity, 'Die bewusste Eingabe wurde verworfen').toBe(185);
  });

  it('Q11: die Obergrenze gilt unverändert weiter', () => {
    seed({});
    const draft = draftFor('rechnung');
    const updated = updateDraftPositionQuantity(draft, position(draft).id, 421);

    expect(position(updated).quantity, 'Ein Wert über der Grenze wurde übernommen').toBe(0);
  });

  /*
   * Q12 — der Entwurf wird als Rohtext gespeichert und verbatim
   * wiederhergestellt (`invoiceDraftDurabilityService`). Geprüft wird deshalb
   * genau dieser Serialisierungsvertrag; die echte Speicher-Suite läuft als
   * Regression mit.
   */
  it('Q12: eine eingetragene Menge überlebt Serialisierung und Resume', () => {
    seed({});
    const draft = draftFor('rechnung');
    const updated = updateDraftPositionQuantity(draft, position(draft).id, 185);
    const restored = JSON.parse(JSON.stringify(updated)) as InvoiceDraft;

    expect(position(restored).quantity, 'Der Resume fiel auf die Planmenge zurück').toBe(185);
  });
});
