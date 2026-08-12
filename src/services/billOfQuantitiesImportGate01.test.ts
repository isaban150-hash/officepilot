/**
 * WV-LV-ROBUSTHEIT-01A — atomare Import-Blockade bei ungelöster Einheit.
 *
 * Eine unbekannte Einheit darf nicht als Stück im Auftrag landen. Der Batch
 * wird vor der ersten Mutation geprüft: entweder alles oder nichts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { importSuggestedPositionsToVorgang, findUnresolvedUnitPositions } from './intakeWorkflowService';
import { extractBillOfQuantitiesPositions } from './billOfQuantitiesExtractionService';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
import { createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import type { DetectedOrderPosition } from '../types/models';

function position(
  overrides: Partial<DetectedOrderPosition> & { description: string; unit: string },
): DetectedOrderPosition {
  return {
    positionNumber: overrides.positionNumber ?? '1',
    description: overrides.description,
    unit: overrides.unit,
    quantity: overrides.quantity ?? 10,
    unitPrice: overrides.unitPrice ?? 5,
    lineTotal: overrides.lineTotal ?? 50,
  };
}

const VORGANG_ID = 'v-import-gate';

function seedVorgang() {
  hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID, orderPositions: [] })]);
}

describe('WV-LV-ROBUSTHEIT-01A – Import-Blockade', () => {
  beforeEach(() => {
    resetTestStores();
    seedVorgang();
  });

  it('saubere Positionen werden weiterhin importiert', () => {
    const result = importSuggestedPositionsToVorgang(VORGANG_ID, [
      position({ positionNumber: '1', description: 'PE-Folie verlegen', unit: 'qm' }),
      position({ positionNumber: '2', description: 'Traufanschluss', unit: 'lfdm' }),
    ]);

    expect(result.success).toBe(true);
    expect(result.added).toBe(2);
    const positions = getVorgangById(VORGANG_ID)?.orderPositions ?? [];
    expect(positions.map((entry) => entry.unit)).toEqual(['m²', 'Meter']);
    expect(positions[1]?.unitLabel).toBe('lfm');
  });

  it('unbekannte Einheit blockiert den Import vollständig', () => {
    const result = importSuggestedPositionsToVorgang(VORGANG_ID, [
      position({ positionNumber: '1', description: 'Sonderleistung', unit: 'Zwirbel' }),
    ]);

    expect(result.success).toBe(false);
    expect(result.added).toBe(0);
    expect(result.errorKey).toBe('position.unitUnresolved');
    expect(result.unresolvedUnits).toEqual([
      { positionNumber: '1', description: 'Sonderleistung', rawUnit: 'Zwirbel' },
    ]);
    expect(getVorgangById(VORGANG_ID)?.orderPositions ?? []).toHaveLength(0);
  });

  it('eine ungelöste Einheit verhindert auch den Import gültiger Nachbarpositionen', () => {
    const result = importSuggestedPositionsToVorgang(VORGANG_ID, [
      position({ positionNumber: '1', description: 'PE-Folie verlegen', unit: 'qm' }),
      position({ positionNumber: '2', description: 'Schüttgut liefern', unit: 'kg' }),
      position({ positionNumber: '3', description: 'Traufanschluss', unit: 'lfm' }),
    ]);

    expect(result.success).toBe(false);
    expect(result.added).toBe(0);
    expect(result.unresolvedUnits).toHaveLength(1);
    expect(result.unresolvedUnits?.[0]?.rawUnit).toBe('kg');
    expect(getVorgangById(VORGANG_ID)?.orderPositions ?? []).toHaveLength(0);
  });

  it('bestehende Positionen bleiben bei blockiertem Import unverändert', () => {
    importSuggestedPositionsToVorgang(VORGANG_ID, [
      position({ positionNumber: '1', description: 'PE-Folie verlegen', unit: 'qm' }),
    ]);
    const before = getVorgangById(VORGANG_ID)?.orderPositions ?? [];
    expect(before).toHaveLength(1);

    const result = importSuggestedPositionsToVorgang(VORGANG_ID, [
      position({ positionNumber: '2', description: 'Schüttgut liefern', unit: 'Sack' }),
      position({ positionNumber: '3', description: 'Traufanschluss', unit: 'lfm' }),
    ]);

    expect(result.success).toBe(false);
    const after = getVorgangById(VORGANG_ID)?.orderPositions ?? [];
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(before[0]?.id);
    expect(after[0]?.unit).toBe('m²');
  });

  it('bereits zu Stück normalisierte Position mit rawUnit kg blockiert trotzdem', () => {
    const gefaehrlich = {
      positionNumber: '1',
      description: 'Schüttgut liefern',
      // Gefährlicher Zustand: unit sieht abrechenbar aus, der Rohwert nicht.
      unit: 'Stück',
      rawUnit: 'kg',
      quantity: 10,
      unitPrice: 5,
      lineTotal: 50,
      confidence: 'medium' as const,
      reviewStatus: 'review_required' as const,
      reviewReasons: ['unit_unknown' as const],
    };

    const result = importSuggestedPositionsToVorgang(VORGANG_ID, [gefaehrlich]);

    expect(result.success).toBe(false);
    expect(result.added).toBe(0);
    expect(result.errorKey).toBe('position.unitUnresolved');
    expect(result.unresolvedUnits?.[0]?.rawUnit).toBe('kg');
    expect(getVorgangById(VORGANG_ID)?.orderPositions ?? []).toHaveLength(0);
  });

  it('reviewReasons allein genügen zur Blockade', () => {
    const nurReason = {
      positionNumber: '1',
      description: 'Sonderleistung',
      unit: 'Stück',
      rawUnit: 'Stück',
      quantity: 10,
      unitPrice: 5,
      lineTotal: 50,
      confidence: 'medium' as const,
      reviewStatus: 'review_required' as const,
      reviewReasons: ['unit_ambiguous' as const],
    };

    const result = importSuggestedPositionsToVorgang(VORGANG_ID, [nurReason]);

    expect(result.success).toBe(false);
    expect(getVorgangById(VORGANG_ID)?.orderPositions ?? []).toHaveLength(0);
  });

  it('echter Weg: Extraktion → Import blockiert und trägt rawUnit/reviewReasons', () => {
    const positions = extractBillOfQuantitiesPositions(
      [
        '1 100,00 qm PE-Folie verlegen EP 0,35 € GP 35,00 €',
        '2 12,00 kg Schüttgut liefern EP 5,00 € GP 60,00 €',
      ].join('\n'),
      8,
    );

    expect(positions).toHaveLength(2);
    const kgPosition = positions.find((entry) => entry.positionNumber === '2')!;
    expect(kgPosition.rawUnit).toBe('kg');
    expect(kgPosition.reviewReasons).toContain('unit_unknown');

    const result = importSuggestedPositionsToVorgang(VORGANG_ID, positions);

    expect(result.success).toBe(false);
    expect(result.added).toBe(0);
    expect(result.unresolvedUnits?.map((entry) => entry.rawUnit)).toEqual(['kg']);
    expect(getVorgangById(VORGANG_ID)?.orderPositions ?? []).toHaveLength(0);
  });

  it('findUnresolvedUnitPositions meldet alle betroffenen Zeilen strukturiert', () => {
    const unresolved = findUnresolvedUnitPositions([
      position({ positionNumber: '1', description: 'PE-Folie verlegen', unit: 'qm' }),
      position({ positionNumber: '2', description: 'Schüttgut', unit: 'kg' }),
      position({ positionNumber: '3', description: 'Sonderleistung', unit: 'Zwirbel' }),
    ]);

    expect(unresolved.map((entry) => entry.rawUnit)).toEqual(['kg', 'Zwirbel']);
  });
});
