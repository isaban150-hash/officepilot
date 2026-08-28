/**
 * OFFICEPILOT-INVOICE-CREATE-ROUTE-TYPE-01 — Route und Versprechen müssen
 * zusammenpassen.
 *
 * Die Empfehlungsdienste boten „Abschlagsrechnung erstellen" und
 * „Schlussrechnung erstellen" an, verlinkten aber auf die Anlege-Route **ohne**
 * `?type=`. `parseInvoiceDocumentType(null)` macht daraus still `rechnung` —
 * der Nutzer landete im falschen Rechnungstyp und erzeugte dort einen leeren
 * Entwurfsdatensatz.
 *
 * Diese Naht war bisher von keinem Test gedeckt: Label und Route wurden nie
 * gemeinsam zugesichert. Genau das holen diese Fälle nach.
 *
 * Neutrale Beispieldaten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeVorgangWorkflow } from './brain/workflowIntelligenceService';
import { executeDocumentAction, executeScanResultAction } from './officeActionService';
import { tryResolveHandwerkKnowledgeQuestion } from './brain/handwerkKnowledgeResolver';
import {
  recordVorgangContext,
  resetCompanySessionForTests,
} from './brain/companySessionService';
import { hydrateInboxStore } from './inboxService';
import { hydrateVorgangStore } from './vorgangService';
import {
  createAbschlagInvoice,
  createAuftragInboxItem,
  createOrderPosition,
  createTestVorgang,
} from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import type { Vorgang } from '../types/models';

/** Auftrag mit Werkvertrag, der Abschlagszahlungen ausdrücklich zulässt. */
function seedAbschlagCase(): Vorgang {
  const item = createAuftragInboxItem();
  item.id = 'inbox-route-abschlag';
  item.vorgangId = 'v-route-abschlag';
  item.title = 'Werkvertrag Beispielprojekt';
  /*
   * Die Vertragsanalyse liest `_extractedText`, nicht `rawText`, und leitet
   * `progressBillingAllowed` aus genau dieser Formulierung ab.
   */
  item.recognizedData = {
    ...item.recognizedData,
    _extractedText: 'Werkvertrag. Abschlagsrechnungen sind vereinbart.',
  };
  hydrateInboxStore([item]);

  const vorgang = createTestVorgang({
    id: 'v-route-abschlag',
    title: 'Beispielauftrag Abschlag',
    createdFromInboxId: item.id,
    orderPositions: [createOrderPosition({ id: 'op-route-1', plannedQuantity: 10 })],
  });
  hydrateVorgangStore([vorgang]);
  return vorgang;
}

/** Auftrag, dessen Positionen vollständig abgerechnet sind. */
function seedSchlussCase(): Vorgang {
  const vorgang = createTestVorgang({
    id: 'v-route-schluss',
    title: 'Beispielauftrag Schluss',
    orderPositions: [createOrderPosition({ id: 'op-route-2', plannedQuantity: 8 })],
    invoices: [createAbschlagInvoice('op-route-2', 8, { id: 'inv-route-full' })],
  });
  hydrateVorgangStore([vorgang]);
  return vorgang;
}

/** Auftrag ohne Rechnung und ohne Abschlagsvereinbarung. */
function seedPlainCase(): Vorgang {
  const vorgang = createTestVorgang({
    id: 'v-route-plain',
    title: 'Beispielauftrag Rechnung',
    orderPositions: [createOrderPosition({ id: 'op-route-3', plannedQuantity: 5 })],
  });
  hydrateVorgangStore([vorgang]);
  return vorgang;
}

function routeOf(vorgangId: string, recommendationId: string): string | undefined {
  return analyzeVorgangWorkflow(vorgangId)?.recommendations.find((r) => r.id === recommendationId)
    ?.route;
}

describe('OFFICEPILOT-INVOICE-CREATE-ROUTE-TYPE-01 — workflowIntelligence', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('create_abschlag verlinkt auf den Abschlagstyp', () => {
    seedAbschlagCase();
    expect(routeOf('v-route-abschlag', 'create_abschlag')).toBe(
      '/vorgaenge/v-route-abschlag/rechnung?type=abschlag',
    );
  });

  it('create_schluss verlinkt auf den Schlusstyp', () => {
    seedSchlussCase();
    expect(routeOf('v-route-schluss', 'create_schluss')).toBe(
      '/vorgaenge/v-route-schluss/rechnung?type=schluss',
    );
  });

  it('create_invoice verlinkt auf die normale Rechnung', () => {
    seedPlainCase();
    expect(routeOf('v-route-plain', 'create_invoice')).toBe(
      '/vorgaenge/v-route-plain/rechnung?type=rechnung',
    );
  });
});

describe('OFFICEPILOT-INVOICE-CREATE-ROUTE-TYPE-01 — handwerkKnowledge', () => {
  beforeEach(() => {
    resetTestStores();
    resetCompanySessionForTests();
  });

  it('der Schlussrechnungs-Schritt trägt den Schlusstyp', () => {
    seedSchlussCase();
    recordVorgangContext('v-route-schluss');
    const resolution = tryResolveHandwerkKnowledgeQuestion(
      'Brauche ich hier eine Schlussrechnung?',
    );
    const step = resolution?.suggestedNextSteps?.find((s) => s.id === 'open_schluss');
    expect(step?.route).toBe('/vorgaenge/v-route-schluss/rechnung?type=schluss');
  });
});

describe('OFFICEPILOT-INVOICE-CREATE-ROUTE-TYPE-01 — officeAction', () => {
  beforeEach(() => {
    resetTestStores();
  });

  function seedActionItem(actionId: string) {
    const item = createAuftragInboxItem();
    item.id = `inbox-action-${actionId}`;
    item.vorgangId = 'v-route-action';
    hydrateInboxStore([item]);
    return item;
  }

  function routeOfResult(result: ReturnType<typeof executeScanResultAction>): string {
    return result.ok && result.kind === 'navigate' ? result.route : '';
  }

  function routeFor(actionId: 'import_hours' | 'suggest_schlussrechnung'): string {
    return routeOfResult(executeDocumentAction(actionId, seedActionItem(actionId)));
  }

  it('die normale Rechnungsaktion trägt den Rechnungstyp', () => {
    // Die generische Rechnungsaktion liegt im Scan-Ergebnis, nicht im Dokumentmenü.
    const route = routeOfResult(executeScanResultAction('invoice', seedActionItem('invoice')));
    expect(route).toBe('/vorgaenge/v-route-action/rechnung?type=rechnung');
  });

  it('die Stundenübernahme trägt den Abschlagstyp', () => {
    expect(routeFor('import_hours')).toBe('/vorgaenge/v-route-action/rechnung?type=abschlag');
  });

  it('der Schlussrechnungsvorschlag trägt den Schlusstyp', () => {
    expect(routeFor('suggest_schlussrechnung')).toBe(
      '/vorgaenge/v-route-action/rechnung?type=schluss',
    );
  });
});
