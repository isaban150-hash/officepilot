/**
 * WV-LV-ROBUSTHEIT-01A-N1 — direkter Einheitennachweis am echten WV-LV-01-Ergebnis.
 *
 * Prüft ausschließlich Einheiten. Geldwerte und der bewusst erhaltene
 * Summenwiderspruch dieses Falls bleiben unangetastet.
 */
import { describe, expect, it } from 'vitest';
import { analyzeContractIntelligenceFromText } from './contractIntelligenceService';
import { findUnresolvedUnitPositions } from './intakeWorkflowService';
import { getDocumentCase } from '../test/document-cases/_lib/loadCases';

/** Eingabe kommt aus dem echten Dokumentfall, nicht aus einem Direktimport. */
function wvLv01Positions() {
  const documentCase = getDocumentCase('WV-LV-01');
  const intelligence = analyzeContractIntelligenceFromText(
    documentCase.ocrText,
    documentCase.pages,
  );
  return intelligence?.positions ?? [];
}

describe('WV-LV-ROBUSTHEIT-01A-N1 – WV-LV-01 Einheiten', () => {
  it('die PVC-Position wird gefunden', () => {
    const pvc = wvLv01Positions().find((position) => position.description.includes('PVC'));

    expect(pvc).toBeTruthy();
    expect(pvc?.quantity).toBe(4799);
  });

  it('die PVC-Position trägt die Roh-Einheit qm und die kanonische Einheit m²', () => {
    const pvc = wvLv01Positions().find((position) => position.description.includes('PVC'))!;

    expect(pvc.rawUnit).toBe('qm');
    expect(pvc.unit).toBe('m²');
    expect(pvc.unit).not.toBe('Stück');
  });

  it('keine qm-Position des LV wird als Stück geführt', () => {
    const positions = wvLv01Positions();
    const qmPositions = positions.filter((position) => position.rawUnit === 'qm');

    expect(qmPositions.length).toBeGreaterThanOrEqual(5);
    for (const position of qmPositions) {
      expect(position.unit).toBe('m²');
    }
  });

  it('lfdm-Positionen bleiben laufende Meter, Stück bleibt Stück', () => {
    const positions = wvLv01Positions();
    const traufanschluss = positions.find((position) => position.description.includes('Traufanschluss'));
    const lichtkuppel = positions.find((position) => position.description.includes('Lichtkuppel'));

    expect(traufanschluss?.rawUnit).toBe('lfdm');
    expect(traufanschluss?.unit).toBe('lfm');
    expect(lichtkuppel?.rawUnit).toBe('Stück');
    expect(lichtkuppel?.unit).toBe('Stück');
  });

  it('alle elf Positionen bleiben erhalten und ohne Einheitenkonflikt', () => {
    const positions = wvLv01Positions();

    expect(positions).toHaveLength(11);
    for (const position of positions) {
      expect(position.reviewReasons ?? []).not.toContain('unit_unknown');
      expect(position.reviewReasons ?? []).not.toContain('unit_ambiguous');
    }
  });

  it('der Fall wird nicht durch position.unitUnresolved blockiert', () => {
    expect(findUnresolvedUnitPositions(wvLv01Positions())).toEqual([]);
  });
});
