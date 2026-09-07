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
 * Geaendert wurde ausschliesslich die **Vorbelegung**.
 *
 * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — inzwischen ist auch die Grenze
 * gefallen: `getBillableOpenQuantity` ist der Planrest und keine
 * Eingabe-Obergrenze mehr. Q7 und Q11 sind deshalb bewusst umgedreht; der
 * Sicherheitsvertrag „ohne erfasste Ausfuehrung keine Vorbelegung" bleibt
 * unangetastet.
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
  it('Q1: eine Rechnung startet mit 0, der Planrest bleibt sichtbar', () => {
    seed({});
    const pos = position(draftFor('rechnung'));

    expect(pos.quantity, 'Die Planmenge wurde als Rechnungsmenge vorbelegt').toBe(0);
    // Der Planrest bleibt als Referenz erhalten — er ist keine Eingabegrenze.
    expect(pos.openQuantity, 'Der Planrest wurde mitverändert').toBe(420);
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
      // `openQuantity` ist der Planrest und folgt der Ausführung nicht.
      expect(pos.openQuantity).toBe(420);
    }
  });

  it('Q6: bereits abgerechnete Mengen werden abgezogen', () => {
    seed({ executedQuantity: 300, invoices: [billed(185)] });
    const pos = position(draftFor('rechnung'));

    expect(pos.quantity).toBe(115);
    expect(pos.openQuantity, 'Planrest 420 − 185').toBe(235);
    expect(pos.billedQuantity).toBe(185);
  });

  /*
   * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — bewusst umgedreht. Q7 sicherte bis
   * hierher die `Math.min`-Kappung („bleibt auf den Plan gekappt", erwartet
   * 420). Die Planmenge ist die Vertragsmenge, nicht das Aufmass: Wer 500
   * ausgeführte Einheiten dokumentiert hat, muss 500 abrechnen können.
   */
  it('Q7: eine Ausführung über der Planmenge wird vollständig vorgeschlagen', () => {
    seed({ executedQuantity: 500 });
    const pos = position(draftFor('rechnung'));

    expect(pos.quantity, 'Die Ausführung wurde auf den Plan gekappt').toBe(500);
    expect(pos.openQuantity, 'Der Planrest ist davon unabhängig').toBe(420);
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
   * Vorbelegung, nicht die Eingabe.
   */
  it('Q10: der Nutzer kann ohne erfasste Ausführung bewusst eine Menge setzen', () => {
    seed({});
    const draft = draftFor('rechnung');
    expect(position(draft).quantity).toBe(0);

    const updated = updateDraftPositionQuantity(draft, position(draft).id, 185);

    expect(position(updated).quantity, 'Die bewusste Eingabe wurde verworfen').toBe(185);
  });

  /*
   * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — bewusst umgedreht. Q11 hiess „die
   * Obergrenze gilt unverändert weiter" und erwartete, dass 421 bei Plan 420
   * verworfen wird. Ein Auftrag über 420 m² kann 1.420 m² Leistung
   * hervorbringen; die Überschreitung ist ein Fall für den Bestätigungspfad,
   * kein Eingabefehler.
   */
  it('Q11: eine bewusste Menge über der Planmenge wird angenommen', () => {
    seed({});
    const draft = draftFor('rechnung');

    expect(
      position(updateDraftPositionQuantity(draft, position(draft).id, 421)).quantity,
      'Ein Wert über der Planmenge wurde verworfen',
    ).toBe(421);
    expect(position(updateDraftPositionQuantity(draft, position(draft).id, 1420)).quantity).toBe(
      1420,
    );
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
