/**
 * OFFICEPILOT-BUSINESS-STATE-DIRECT-CONFIRMATION-01B
 *
 * Ein bereits geschlossener Vertrag muss nicht neu verhandelt werden. Bisher war
 * `in_verhandlung` die einzige Vorstufe der kaufmännischen Bestätigung, sodass
 * der Nutzer auch bei einem unterschriebenen Subunternehmervertrag zuerst eine
 * Preisverhandlung eröffnen musste.
 *
 * Der zweite Weg ist bewusst eng: er entscheidet nach Geschäftszustand, nicht
 * nach Dokumentnamen, und er bestätigt nichts von selbst. Ein Angebot behält den
 * Verhandlungsweg, und bei unklarer Rolle gilt Sicherheit vor Komfort.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
import { confirmContractOrder } from './contractConfirmationService';
import { startContractNegotiation } from './contractNegotiationService';
import { isContractPlanLocked } from './orderPlanIntegrityService';
import { orderPositionsMatchSnapshot } from './contractPositionAlignService';
import { startOrderExecution } from './orderExecutionStartService';
import { resolveOrderConfirmationPath } from './orderConfirmationPathService';
import type { OrderConfirmationPathSignals } from './orderConfirmationPathService';

/** Ein vollständig dokumentierter Subunternehmervertrag, eigene Firma beauftragt. */
const BOUND_CONTRACT: OrderConfirmationPathSignals = {
  classifiedKind: 'subunternehmervertrag',
  contractFamily: 'subunternehmervertrag',
  ownCompanyRole: 'auftragnehmer',
  counterpartyName: 'NordWest Dachbau GmbH',
  positionCount: 11,
  positionsUsable: true,
};

function seedContractVorgang(id: string) {
  hydrateVorgangStore([
    createTestVorgang({
      id,
      status: 'eingegangen',
      customer: 'NordWest Dachbau GmbH',
      baustelle: 'Carl-Bertelsmann-Straße 211',
      title: 'Dachsanierung Halle 3',
      orderPositions: [
        createOrderPosition({
          id: 'op-1',
          description: 'Abdichtung herstellen',
          unit: 'm²',
          plannedQuantity: 100,
          unitPrice: 5,
        }),
        createOrderPosition({
          id: 'op-2',
          description: 'Dampfsperre verlegen',
          unit: 'm²',
          plannedQuantity: 250,
          unitPrice: 4,
        }),
      ],
    }),
  ]);
}

describe('OFFICEPILOT-BUSINESS-STATE-DIRECT-CONFIRMATION-01B', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('A: ein bereits beauftragender Vertrag erhält den direkten Prüfweg', () => {
    expect(resolveOrderConfirmationPath(BOUND_CONTRACT)).toBe('direct_confirmation_review');
  });

  it('B: nach der Vorgangsanlage ist noch nichts bestätigt', () => {
    seedContractVorgang('v-direct-b');
    const vorgang = getVorgangById('v-direct-b');

    expect(vorgang?.contractConfirmation).toBeUndefined();
    expect(vorgang?.status).toBe('eingegangen');
  });

  it('C: die direkte Bestätigung friert den Auftrag korrekt ein', () => {
    seedContractVorgang('v-direct-c');

    const result = confirmContractOrder('v-direct-c', { path: BOUND_CONTRACT });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const vorgang = getVorgangById('v-direct-c');
    expect(vorgang?.status).toBe('beauftragt');
    const snapshot = vorgang?.contractConfirmation;
    expect(snapshot?.immutable).toBe(true);
    expect(snapshot?.positions.map((p) => p.description)).toEqual([
      'Abdichtung herstellen',
      'Dampfsperre verlegen',
    ]);
    expect(snapshot?.positions.map((p) => p.plannedQuantity)).toEqual([100, 250]);
    expect(snapshot?.positions.map((p) => p.unitPrice)).toEqual([5, 4]);
    expect(snapshot?.customer).toBe('NordWest Dachbau GmbH');
    expect(snapshot?.baustelle).toBe('Carl-Bertelsmann-Straße 211');
  });

  it('N: eine direkte Bestätigung erfindet keine Verhandlungshistorie', () => {
    seedContractVorgang('v-direct-n');
    confirmContractOrder('v-direct-n', { path: BOUND_CONTRACT });

    const vorgang = getVorgangById('v-direct-n');
    const summary = vorgang?.contractConfirmation?.negotiation;

    expect(summary?.conducted).toBe(false);
    expect(summary?.notes).toEqual([]);
    expect(summary?.priceProposals).toEqual([]);
    expect(summary?.drafts).toEqual([]);
    // Kein erfundener Verhandlungsbeginn am Vorgang.
    expect(vorgang?.negotiation?.startedAt).toBeUndefined();
  });

  it('D: der Snapshot trägt danach die Nachtragsbaseline', () => {
    seedContractVorgang('v-direct-d');
    confirmContractOrder('v-direct-d', { path: BOUND_CONTRACT });

    const vorgang = getVorgangById('v-direct-d')!;
    expect(isContractPlanLocked(vorgang)).toBe(true);
    expect(orderPositionsMatchSnapshot(vorgang.orderPositions, vorgang.contractConfirmation!)).toBe(
      true,
    );
  });

  it('E: der Ausführungsstart wird erst nach der Bestätigung zulässig', () => {
    seedContractVorgang('v-direct-e');
    expect(startOrderExecution('v-direct-e').success).toBe(false);

    confirmContractOrder('v-direct-e', { path: BOUND_CONTRACT });

    const started = startOrderExecution('v-direct-e');
    expect(started.success).toBe(true);
    expect(getVorgangById('v-direct-e')?.status).toBe('in_bearbeitung');
  });

  it('C2: ein zweiter Bestätigungsversuch prallt ab', () => {
    seedContractVorgang('v-direct-c2');
    confirmContractOrder('v-direct-c2', { path: BOUND_CONTRACT });

    const second = confirmContractOrder('v-direct-c2', { path: BOUND_CONTRACT });
    expect(second.success).toBe(false);
    if (second.success) return;
    expect(second.errorKey).toBe('confirmation.alreadyExists');
  });

  it('G: ein Angebot bekommt den direkten Weg nicht, auch mit vollständigen Daten', () => {
    const angebot: OrderConfirmationPathSignals = {
      ...BOUND_CONTRACT,
      classifiedKind: 'angebot',
      contractFamily: 'unknown',
    };

    expect(resolveOrderConfirmationPath(angebot)).toBe('negotiation');
  });

  it('G2: ein Angebot lässt sich auch nicht direkt bestätigen', () => {
    seedContractVorgang('v-direct-g2');

    const result = confirmContractOrder('v-direct-g2', {
      path: { ...BOUND_CONTRACT, classifiedKind: 'angebot', contractFamily: 'unknown' },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('confirmation.notInNegotiation');
    expect(getVorgangById('v-direct-g2')?.contractConfirmation).toBeUndefined();
  });

  it('H: Auftrag und Auftragsbestätigung dokumentieren ebenfalls einen erteilten Auftrag', () => {
    for (const classifiedKind of ['auftrag', 'auftragsbestaetigung'] as const) {
      expect(
        resolveOrderConfirmationPath({ ...BOUND_CONTRACT, classifiedKind, contractFamily: 'unknown' }),
      ).toBe('direct_confirmation_review');
    }
  });

  it('I: bei unklarer eigener Parteirolle gibt es keinen Shortcut', () => {
    expect(
      resolveOrderConfirmationPath({ ...BOUND_CONTRACT, ownCompanyRole: undefined }),
    ).toBe('unclear');
  });

  it('I2: ohne verwertbare Positionen gibt es keinen Shortcut', () => {
    expect(
      resolveOrderConfirmationPath({ ...BOUND_CONTRACT, positionCount: 0, positionsUsable: false }),
    ).toBe('unclear');
  });

  it('I3: ohne erkannte Gegenpartei gibt es keinen Shortcut', () => {
    expect(
      resolveOrderConfirmationPath({ ...BOUND_CONTRACT, counterpartyName: '   ' }),
    ).toBe('unclear');
  });

  it('K: der bestehende Verhandlungsweg bleibt unverändert', () => {
    seedContractVorgang('v-nego');

    expect(startContractNegotiation('v-nego').success).toBe(true);
    expect(getVorgangById('v-nego')?.status).toBe('in_verhandlung');

    const result = confirmContractOrder('v-nego');
    expect(result.success).toBe(true);
    if (!result.success) return;

    const vorgang = getVorgangById('v-nego');
    expect(vorgang?.status).toBe('beauftragt');
    expect(vorgang?.contractConfirmation?.negotiation.conducted).toBe(true);
    expect(vorgang?.negotiation?.closed).toBe(true);
  });

  it('K2: ohne zulässigen Business State bleibt der Verhandlungsweg Pflicht', () => {
    seedContractVorgang('v-guard');

    const result = confirmContractOrder('v-guard');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('confirmation.notInNegotiation');
  });
});
