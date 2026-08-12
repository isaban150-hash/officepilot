/**
 * WV-LV-ROBUSTHEIT-01A — zentrale Einheitenauflösung.
 *
 * Eine nicht unterstützte Einheit darf niemals zu Stück werden: das würde still
 * ändern, was abgerechnet wird.
 */
import { describe, expect, it } from 'vitest';
import { isResolvedUnit, resolveOrderUnit } from './orderUnitMapper';
import type { OrderUnit } from '../types/models';

const KNOWN: Array<[string, OrderUnit, string | undefined]> = [
  ['qm', 'm²', undefined],
  ['m²', 'm²', undefined],
  ['m2', 'm²', undefined],
  ['QM', 'm²', undefined],
  ['lfm', 'Meter', 'lfm'],
  ['lfdm', 'Meter', 'lfm'],
  ['lfdm.', 'Meter', 'lfm'],
  ['m', 'Meter', undefined],
  ['Stück', 'Stück', undefined],
  ['Stk.', 'Stück', undefined],
  ['St.', 'Stück', undefined],
  ['stk', 'Stück', undefined],
  ['Pauschal', 'Pauschal', undefined],
  ['psch', 'Pauschal', undefined],
  ['Std.', 'Stunden', undefined],
  ['h', 'Stunden', undefined],
];

const UNSUPPORTED = ['kg', 't', 'Sack', 'Zwirbel', 'Rolle', 'Liter', ''];

describe('WV-LV-ROBUSTHEIT-01A – resolveOrderUnit', () => {
  it.each(KNOWN)('erkennt „%s" als %s', (raw, unit, unitLabel) => {
    const resolved = resolveOrderUnit(raw);

    expect(resolved.state).toBe('known');
    expect(resolved.unit).toBe(unit);
    expect(resolved.unitLabel).toBe(unitLabel);
    expect(resolved.rawUnit).toBe(raw.trim());
  });

  it.each(UNSUPPORTED)('lässt „%s" ungelöst und niemals Stück werden', (raw) => {
    const resolved = resolveOrderUnit(raw);

    expect(resolved.state).toBe('unknown');
    expect(resolved.unit).toBeUndefined();
    expect(isResolvedUnit(resolved)).toBe(false);
    expect(resolved.rawUnit).toBe(raw.trim());
  });

  it('mehrdeutige Schreibweise wird als ambiguous geführt', () => {
    const resolved = resolveOrderUnit('Stk/m');

    expect(resolved.state).toBe('ambiguous');
    expect(resolved.unit).toBeUndefined();
  });

  it('der Rohwert bleibt exakt erhalten', () => {
    expect(resolveOrderUnit('  Zwirbel  ').rawUnit).toBe('Zwirbel');
    expect(resolveOrderUnit('lfdm.').rawUnit).toBe('lfdm.');
  });
});
