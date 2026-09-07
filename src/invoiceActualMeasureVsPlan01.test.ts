/**
 * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — Planmenge ist Referenz, nicht Grenze.
 *
 * Auf einer Baustelle ist die Mengenabweichung der Regelfall, nicht die
 * Ausnahme: Ein Auftrag ueber 420 m² kann 1.420 m² Leistung hervorbringen, ein
 * Aufmass ueber 50.000 m² kann bei 51.200 m² enden. Bis hierher beantwortete
 * eine einzige Zeile — `Math.min(planned, executed ?? planned) − billed` — drei
 * verschiedene Fragen gleichzeitig und machte die Vertragsmenge damit zur
 * harten Obergrenze der Rechnung.
 *
 * Diese Suite haelt die drei Groessen auseinander:
 *
 *   - **Planrest**  `max(0, planned − billed)` — was laut Auftrag offen ist
 *   - **Ist-Rest**  `max(0, executed − billed)`, `undefined` ohne Aufmass
 *   - **Rechnungsmenge** — die bewusste Entscheidung des Nutzers
 *
 * Neutrale Beispieldaten, kein Kundenbezug.
 */
import { describe, expect, it } from 'vitest';

import { hydrateVorgangStore, getVorgangById } from './services/vorgangService';
import {
  applyAllOpenPositionsToDraft,
  buildInvoiceDraftForType,
  getBillableOpenQuantity,
  getExecutedRemainingQuantity,
  getOverbillingEvidenceKeys,
  getOverbillingWarnings,
  getPositionBillingStatus,
  isPositionStillOpen,
  updateDraftPositionQuantity,
} from './services/invoiceService';
import { analyzeVorgangWorkflow } from './services/brain/workflowIntelligenceService';
import { buildHandwerkAdviceForVorgang } from './services/brain/handwerkContextAdvisor';
import { recordVorgangContext } from './services/brain/companySessionService';
import { createOrderPosition, createTestVorgang, testSetup } from './test/fixtures';
import type {
  InvoiceDocumentType,
  InvoiceDraft,
  OrderUnit,
  Vorgang,
  VorgangInvoice,
} from './types/models';

const VORGANG_ID = 'v-test-1';
const POSITION_ID = 'op-test-1';

interface Scenario {
  plannedQuantity: number;
  executedQuantity?: number;
  billedQuantity?: number;
  unit?: OrderUnit;
}

function seed({ plannedQuantity, executedQuantity, billedQuantity, unit }: Scenario): Vorgang {
  hydrateVorgangStore([
    createTestVorgang({
      status: 'in_bearbeitung',
      orderPositions: [
        createOrderPosition({
          id: POSITION_ID,
          description: 'Leistung',
          plannedQuantity,
          unit: unit ?? 'm2',
          unitPrice: 25,
          category: 'arbeit',
          ...(executedQuantity === undefined ? {} : { executedQuantity }),
        }),
      ],
      invoices: billedQuantity === undefined ? [] : [billedInvoice(billedQuantity, unit ?? 'm2')],
    }),
  ]);
  return getVorgangById(VORGANG_ID)!;
}

/** Eine bereits gezaehlte Rechnung ueber `quantity` Einheiten derselben Position. */
function billedInvoice(quantity: number, unit: OrderUnit): VorgangInvoice {
  return {
    id: 'inv-billed-1',
    number: '2026-0001',
    type: 'abschlag',
    abschlagNumber: 1,
    positions: [
      {
        id: 'line-1',
        orderPositionId: POSITION_ID,
        description: 'Leistung',
        quantity,
        unit,
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

function firstPosition(draft: InvoiceDraft) {
  const found = draft.positions.find((p) => p.orderPositionId === POSITION_ID);
  expect(found, 'Position fehlt im Entwurf').toBeDefined();
  return found!;
}

/** Setzt eine Menge und gibt den Entwurf zurueck — die Annahme wird mitgeprueft. */
function withQuantity(draft: InvoiceDraft, quantity: number): InvoiceDraft {
  const updated = updateDraftPositionQuantity(draft, firstPosition(draft).id, quantity);
  expect(firstPosition(updated).quantity, `Die Menge ${quantity} wurde verworfen`).toBe(quantity);
  return updated;
}

describe('INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — keine Plan-Obergrenze', () => {
  it('M1: ohne Aufmass darf ueber die Planmenge hinaus abgerechnet werden', () => {
    seed({ plannedQuantity: 420 });
    const draft = draftFor('rechnung');

    expect(firstPosition(draft).quantity, 'Ohne Aufmass wurde vorbelegt').toBe(0);
    expect(firstPosition(draft).openQuantity, 'Planrest').toBe(420);
    withQuantity(draft, 421);
  });

  it('M2: ein ausgeschoepfter Planrest sperrt keine weitere Menge', () => {
    seed({ plannedQuantity: 420, billedQuantity: 420 });
    const draft = draftFor('rechnung');

    expect(firstPosition(draft).openQuantity, 'Planrest ist ausgeschoepft').toBe(0);
    expect(firstPosition(draft).billable, 'Die Position bleibt abrechenbar').toBe(true);
    withQuantity(draft, 100);
  });

  it('M3: Planrest und Ist-Rest werden sauber getrennt gefuehrt', () => {
    const vorgang = seed({
      plannedQuantity: 50_000,
      executedQuantity: 51_200,
      billedQuantity: 40_000,
    });

    expect(getBillableOpenQuantity(vorgang, POSITION_ID), 'Planrest').toBe(10_000);
    expect(getExecutedRemainingQuantity(vorgang, POSITION_ID), 'Ist-Rest').toBe(11_200);
    expect(firstPosition(draftFor('rechnung')).openQuantity, 'Entwurf zeigt den Planrest').toBe(
      10_000,
    );
  });
});

describe('INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — Vorschlaege je Rechnungsart', () => {
  const overPlan: Scenario = {
    plannedQuantity: 50_000,
    executedQuantity: 51_200,
    billedQuantity: 40_000,
  };

  it('M4: die normale Rechnung schlaegt den vollen Ist-Rest vor', () => {
    seed(overPlan);
    expect(firstPosition(draftFor('rechnung')).quantity).toBe(11_200);
  });

  it('M5: die Teilrechnung schlaegt den vollen Ist-Rest vor', () => {
    seed(overPlan);
    expect(firstPosition(draftFor('teilrechnung')).quantity).toBe(11_200);
  });

  it('M6: die Schlussrechnung schlaegt den vollen Ist-Rest vor', () => {
    seed(overPlan);
    expect(firstPosition(draftFor('schluss')).quantity).toBe(11_200);
  });

  /*
   * Ein Abschlag ist eine Vorauszahlung auf den Auftrag, keine
   * Aufmassabrechnung. Er wird deshalb ausdruecklich **nicht** mit den
   * uebrigen Typen gleichgesetzt — auch nicht, wenn ein Aufmass vorliegt.
   */
  it('M7: der mengenbasierte Abschlag startet weiterhin bei 0', () => {
    seed(overPlan);
    const draft = draftFor('abschlag');

    expect(firstPosition(draft).quantity).toBe(0);
    // Eine bewusste Eingabe bleibt trotzdem moeglich.
    withQuantity(draft, 5_000);
  });

  it('M8: ein Aufmass unter Plan begrenzt den Vorschlag auf das Aufmass', () => {
    seed({ plannedQuantity: 50_000, executedQuantity: 49_000, billedQuantity: 40_000 });
    const draft = draftFor('schluss');

    expect(firstPosition(draft).quantity, 'Ist-Rest, nicht Planrest').toBe(9_000);
    expect(firstPosition(draft).openQuantity, 'Planrest bleibt sichtbar').toBe(10_000);
    // Der Nutzer darf bewusst darueber hinausgehen — das Aufmass kann veraltet sein.
    withQuantity(draft, 11_000);
  });

  it('M9: ohne Aufmass wird nichts vorbelegt, auch nicht der Planrest', () => {
    seed({ plannedQuantity: 50_000, billedQuantity: 40_000 });
    const draft = draftFor('schluss');

    expect(firstPosition(draft).quantity, 'Der Planrest wurde vorbelegt').toBe(0);
    expect(firstPosition(draft).openQuantity).toBe(10_000);
    expect(applyAllOpenPositionsToDraft(draft).positions[0].quantity, 'Sammelbutton').toBe(0);
  });

  it('M9b: „Alle Positionen uebernehmen" nutzt den vollen Ist-Rest', () => {
    seed(overPlan);
    const applied = applyAllOpenPositionsToDraft(draftFor('rechnung'));

    expect(firstPosition(applied).quantity, 'Der Sammelbutton kappte am Plan').toBe(11_200);
  });
});

/*
 * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B4 — „vollständig abgerechnet" und „noch
 * offen" aus einer Quelle.
 *
 * Zwei einfachere Fassungen sind gescheitert, jede an der Hälfte der Fälle:
 * `billed >= planned` hielt FB5 für erledigt und unterschlug 1.200
 * dokumentierte Einheiten; `billed >= (executed ?? planned)` hielt FB1–FB3 für
 * erledigt — also jede laufende Baustelle, deren Fortschritt gepflegt wird.
 * Erledigt ist nur, was nach **beiden** Maßstäben erledigt ist.
 */
describe('INVOICE-ACTUAL-MEASURE-VS-PLAN-01B4 — Statusaussage', () => {
  interface StatusCase extends Scenario {
    name: string;
    fullyBilled: boolean;
  }

  const statusCases: StatusCase[] = [
    // Laufende Baustelle: Fortschritt erfasst und fakturiert, 40.000 beauftragt.
    { name: 'FB1', plannedQuantity: 50_000, executedQuantity: 10_000, billedQuantity: 10_000, fullyBilled: false },
    // Nichts ausgeführt, nichts abgerechnet — `executed: 0` ist nicht „unbekannt".
    { name: 'FB2', plannedQuantity: 50_000, executedQuantity: 0, fullyBilled: false },
    // Ist vollständig fakturiert, aber 1.000 laut Auftrag offen: unentscheidbar,
    // also keine Behauptung. Siehe EXECUTION-COMPLETION-FINAL-MEASURE-01A.
    { name: 'FB3', plannedQuantity: 50_000, executedQuantity: 49_000, billedQuantity: 49_000, fullyBilled: false },
    { name: 'FB4', plannedQuantity: 50_000, executedQuantity: 49_000, billedQuantity: 50_000, fullyBilled: true },
    // Mehr ausgeführt als beauftragt — 1.200 bekannte Restleistung.
    { name: 'FB5', plannedQuantity: 50_000, executedQuantity: 51_200, billedQuantity: 50_000, fullyBilled: false },
    { name: 'FB6', plannedQuantity: 50_000, executedQuantity: 51_200, billedQuantity: 51_200, fullyBilled: true },
    { name: 'FB7', plannedQuantity: 50_000, billedQuantity: 50_000, fullyBilled: true },
    { name: 'FB8', plannedQuantity: 50_000, billedQuantity: 40_000, fullyBilled: false },
  ];

  for (const testCase of statusCases) {
    const { name, fullyBilled, ...scenario } = testCase;
    it(`${name}: fullyBilled=${fullyBilled}, stillOpen=${!fullyBilled}`, () => {
      const vorgang = seed(scenario);

      expect(getPositionBillingStatus(vorgang, POSITION_ID)?.isFullyBilled).toBe(fullyBilled);
      expect(isPositionStillOpen(vorgang, POSITION_ID)).toBe(!fullyBilled);
    });
  }

  /*
   * Der eigentliche Schutz: Solange beide Aussagen aus derselben Ableitung
   * stammen, können Billing-Status und Brain-Hinweise nicht wieder
   * auseinanderlaufen — genau das war der Fehler, den 01B4 behoben hat.
   */
  it('FB-Vertrag: isFullyBilled ist über alle Fälle die exakte Negation von isPositionStillOpen', () => {
    for (const { name, ...scenario } of statusCases) {
      const vorgang = seed(scenario);
      const status = getPositionBillingStatus(vorgang, POSITION_ID);

      expect(status?.isFullyBilled, `${name} widerspricht sich`).toBe(
        !isPositionStillOpen(vorgang, POSITION_ID),
      );
    }
  });

  it('FB9: der Planrest bleibt neben dem Ist-Rest sichtbar', () => {
    const vorgang = seed({
      plannedQuantity: 50_000,
      executedQuantity: 51_200,
      billedQuantity: 50_000,
    });

    expect(getPositionBillingStatus(vorgang, POSITION_ID)?.openQuantity, 'Planrest').toBe(0);
    expect(getExecutedRemainingQuantity(vorgang, POSITION_ID), 'Ist-Rest').toBe(1_200);
  });
});

/*
 * Die Statusaussage bleibt nicht in der Positionskarte: Sie steuert den Rat
 * „Schlussrechnung fällig" und die Abschlusslogik. Ein falsches „vollständig
 * abgerechnet" führt dazu, dass der Nutzer den Vorgang abschliesst — und
 * danach sperrt `hasFinalSchlussrechnung` die Positionen.
 */
describe('INVOICE-ACTUAL-MEASURE-VS-PLAN-01B4 — Brain und Workflow', () => {
  const F1: Scenario = { plannedQuantity: 50_000, executedQuantity: 10_000, billedQuantity: 10_000 };
  const F5: Scenario = { plannedQuantity: 50_000, executedQuantity: 51_200, billedQuantity: 50_000 };
  const F6: Scenario = { plannedQuantity: 50_000, executedQuantity: 51_200, billedQuantity: 51_200 };

  function openPositionsRisk() {
    return (analyzeVorgangWorkflow(VORGANG_ID)?.risks ?? []).find(
      (risk) => risk.id === 'open_positions',
    );
  }

  it('W-F1: bei 20 % Baufortschritt meldet der Workflow die Position als offen', () => {
    seed(F1);
    const risk = openPositionsRisk();

    expect(risk, 'Der Workflow hielt den Vorgang für erledigt').toBeDefined();
    expect(risk?.params?.count).toBe(1);
  });

  it('W-F5: bekannte Restleistung über Plan bleibt im Workflow offen', () => {
    seed(F5);
    const risk = openPositionsRisk();

    expect(risk, 'Die bekannten 1.200 wurden unterschlagen').toBeDefined();
    expect(risk?.params?.count).toBe(1);
  });

  it('W-F6: ist beides ausgeschöpft, meldet der Workflow nichts Offenes', () => {
    seed(F6);
    expect(openPositionsRisk()).toBeUndefined();
  });

  it('A-F1/A-F5: der Kontext-Ratgeber meldet keine vollständige Abrechnung', () => {
    for (const [name, scenario] of [
      ['F1', F1],
      ['F5', F5],
    ] as const) {
      seed(scenario);
      recordVorgangContext(VORGANG_ID);
      const advice = buildHandwerkAdviceForVorgang(getVorgangById(VORGANG_ID)!);

      expect(
        advice.some((item) => item.messageKey === 'handwerkKnowledge.hint.positionFullyBilled'),
        `${name}: „Position vollständig abgerechnet" mit hoher Sicherheit`,
      ).toBe(false);
    }
  });

  it('A-F6: ist alles abgerechnet, darf der Hinweis erscheinen', () => {
    seed(F6);
    const advice = buildHandwerkAdviceForVorgang(getVorgangById(VORGANG_ID)!);

    expect(
      advice.some((item) => item.messageKey === 'handwerkKnowledge.hint.positionFullyBilled'),
    ).toBe(true);
  });
});

/*
 * Der Deckel war in keiner Einheit fachlich begruendet — er traf jede gleich.
 */
describe('INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — einheitenunabhaengig', () => {
  const cases: Array<{ unit: OrderUnit; planned: number; executed: number }> = [
    { unit: 'Stück', planned: 100, executed: 108 },
    { unit: 'Meter', planned: 2_000, executed: 2_450 },
    { unit: 'Stunden', planned: 120, executed: 145 },
    { unit: 'm2', planned: 50_000, executed: 60_000 },
  ];

  for (const { unit, planned, executed } of cases) {
    it(`M11–M14: ${unit} — ${executed} von ${planned} wird nicht gedeckelt`, () => {
      const vorgang = seed({ plannedQuantity: planned, executedQuantity: executed, unit });

      expect(getExecutedRemainingQuantity(vorgang, POSITION_ID)).toBe(executed);
      expect(getBillableOpenQuantity(vorgang, POSITION_ID), 'Planrest').toBe(planned);
      expect(firstPosition(draftFor('rechnung')).quantity).toBe(executed);
    });
  }
});

/*
 * Der Bestaetigungspfad war vollstaendig gebaut — Warnung, Dialog, kanonischer
 * Nachweis, Fail-closed-Pruefung — und blieb allein deshalb unerreichbar, weil
 * `updateDraftPositionQuantity` die Eingabe vorher verwarf.
 */
describe('INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — Warnung statt Sperre', () => {
  it('W1: ein durch das Aufmass gedeckter Betrag warnt nicht wegen des Planrests', () => {
    seed({ plannedQuantity: 50_000, executedQuantity: 51_200, billedQuantity: 40_000 });
    const draft = withQuantity(draftFor('schluss'), 11_200);

    expect(firstPosition(draft).openQuantity, 'Planrest liegt darunter').toBe(10_000);
    expect(getOverbillingWarnings(draft), 'Der Ist-Stand deckt die Menge').toEqual([]);
    expect(getOverbillingEvidenceKeys(draft)).toEqual([]);
  });

  it('W2: ueber dem Ist-Rest wird gewarnt, aber nicht blockiert', () => {
    seed({ plannedQuantity: 50_000, executedQuantity: 51_200, billedQuantity: 40_000 });
    const draft = withQuantity(draftFor('schluss'), 15_000);

    expect(getOverbillingWarnings(draft)).toHaveLength(1);
    // Der Nachweis nennt dieselbe Referenz wie die Warnung — sonst schluege die
    // Fail-closed-Pruefung im Freigabepfad an.
    expect(getOverbillingEvidenceKeys(draft)[0]).toContain(':15000:11200');
  });

  it('W3: ohne Aufmass ist der Planrest die Referenz — Hinweis, keine Sperre', () => {
    seed({ plannedQuantity: 420 });
    const draft = withQuantity(draftFor('rechnung'), 1_420);

    expect(getOverbillingWarnings(draft)).toHaveLength(1);
    expect(getOverbillingEvidenceKeys(draft)[0]).toContain(':1420:420');
  });

  it('W3b: eine nicht abrechenbare Position erzeugt keine Warnung', () => {
    seed({ plannedQuantity: 420 });
    const draft = draftFor('rechnung');
    const notBillable: InvoiceDraft = {
      ...draft,
      positions: draft.positions.map((p) => ({ ...p, billable: false, quantity: 999 })),
    };

    expect(getOverbillingWarnings(notBillable)).toEqual([]);
  });
});

describe('INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — was Grenze bleibt', () => {
  it('negative und ungueltige Mengen werden weiterhin verworfen', () => {
    seed({ plannedQuantity: 420, executedQuantity: 185 });
    const draft = draftFor('rechnung');
    const id = firstPosition(draft).id;

    expect(firstPosition(updateDraftPositionQuantity(draft, id, -1)).quantity).toBe(185);
    expect(firstPosition(updateDraftPositionQuantity(draft, id, Number.NaN)).quantity).toBe(185);
    expect(
      firstPosition(updateDraftPositionQuantity(draft, id, Number.POSITIVE_INFINITY)).quantity,
    ).toBe(185);
    // 0 ist eine gueltige Aussage und muss ankommen.
    expect(firstPosition(updateDraftPositionQuantity(draft, id, 0)).quantity).toBe(0);
  });

  it('eine nicht abrechenbare Position nimmt keine Menge an', () => {
    seed({ plannedQuantity: 420 });
    const draft = draftFor('rechnung');
    const locked: InvoiceDraft = {
      ...draft,
      positions: draft.positions.map((p) => ({ ...p, billable: false })),
    };

    expect(
      firstPosition(updateDraftPositionQuantity(locked, firstPosition(locked).id, 10)).quantity,
    ).toBe(0);
  });
});
