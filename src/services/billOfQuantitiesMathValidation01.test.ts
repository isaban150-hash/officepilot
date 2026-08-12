/**
 * WV-LV-ROBUSTHEIT-01A — exakte Centprüfung statt relativer Toleranz.
 *
 * Die frühere 2-%-Regel bestätigte auf einer großen Zeile bis ~270 € Abweichung
 * als korrekt. Geprüft wird jetzt mit derselben Rundung wie in der Rechnung.
 */
import { describe, expect, it } from 'vitest';
import { extractBillOfQuantitiesPositions } from './billOfQuantitiesExtractionService';

function row(quantity: string, unitPrice: string, lineTotal?: string): string {
  const gp = lineTotal ? ` GP ${lineTotal} €` : '';
  return `1 ${quantity} qm Abdichtung EP ${unitPrice} €${gp}`;
}

function extract(quantity: string, unitPrice: string, lineTotal?: string) {
  return extractBillOfQuantitiesPositions(row(quantity, unitPrice, lineTotal), 1)[0];
}

describe('WV-LV-ROBUSTHEIT-01A – Positionsmathematik', () => {
  it('exakter Gesamtpreis wird bestätigt', () => {
    const position = extract('4.799,00', '2,80', '13.437,20');

    expect(position?.reviewStatus).toBe('confirmed');
    expect(position?.reviewReasons).toBeUndefined();
  });

  it.each(['13.437,21', '13.437,19'])('ein Cent Abweichung (%s) wird markiert', (lineTotal) => {
    const position = extract('4.799,00', '2,80', lineTotal);

    expect(position?.reviewStatus).toBe('review_required');
    expect(position?.reviewReasons).toContain('line_math_mismatch');
  });

  it('die früher tolerierte 2-%-Abweichung wird jetzt markiert', () => {
    // 13.700,00 statt 13.437,20 = 262,80 € Differenz, zuvor „confirmed".
    const position = extract('4.799,00', '2,80', '13.700,00');

    expect(position?.reviewStatus).toBe('review_required');
    expect(position?.reviewReasons).toContain('line_math_mismatch');
  });

  it('Position ohne ausgewiesenen Gesamtpreis erzeugt keinen Rechenkonflikt', () => {
    const position = extract('10,00', '5,00');

    expect(position?.lineTotal).toBe(50);
    expect(position?.reviewReasons ?? []).not.toContain('line_math_mismatch');
    expect(position?.reviewStatus).toBe('confirmed');
  });

  it('unbekannte Einheit und Rechenabweichung ergeben zwei Prüfgründe', () => {
    const position = extractBillOfQuantitiesPositions(
      '1 10,00 Zwirbel Sonderleistung EP 5,00 € GP 60,00 €',
      1,
    )[0];

    expect(position?.reviewReasons).toEqual(
      expect.arrayContaining(['unit_unknown', 'line_math_mismatch']),
    );
    expect(position?.reviewReasons).toHaveLength(2);
    expect(position?.rawUnit).toBe('Zwirbel');
    expect(position?.quantity).toBe(10);
  });

  it('kaufmännische Rundung einer krummen Menge bleibt bestätigt', () => {
    // 3,33 × 1,11 = 3,6963 → 3,70
    const position = extract('3,33', '1,11', '3,70');

    expect(position?.reviewStatus).toBe('confirmed');
  });
});
