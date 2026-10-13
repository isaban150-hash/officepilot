/**
 * FINANZ-CORE-01A (RE-10) — deutsche Zahlen in der Geld- und Mengeneingabe.
 *
 * Bisher: „1.200" — in Deutschland eintausendzweihundert — wurde zu 1,2, und
 * der zweite Trenner von „1.200,50" liess sich im strengen Modus gar nicht
 * tippen. Bei einem Einzelpreis war das eine stille Umdeutung um den Faktor
 * 1000.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { NumericInput, parseNumericInput } from './NumericInput';

describe('RE-10 — parseNumericInput liest deutsche Schreibweise', () => {
  it.each([
    ['1.200', 1200],
    ['1.200,50', 1200.5],
    ['12.345.678,9', 12345678.9],
    ['1.200.000', 1200000],
    ['2,5', 2.5],
    ['0,125', 0.125],
    [',5', 0.5],
    // Tastatur ohne Komma: ein einzelner Punkt vor 1–2 oder mehr als 3 Stellen ist ein Dezimalpunkt.
    ['1.5', 1.5],
    ['12.50', 12.5],
    ['0.125', 0.125],
    ['1.2345', 1.2345],
    ['10', 10],
  ])('%s → %s', (text, expected) => {
    expect(parseNumericInput(text)).toBe(expected);
  });

  it.each([
    ['', 'leer'],
    ['2,', 'offenes Komma'],
    ['1.', 'offener Punkt'],
    ['.', 'nur Punkt'],
    ['1.200,', 'offenes Komma nach Tausendern'],
    ['1.20,5', 'Punkt vor Komma ohne gültige Tausendergruppe'],
    ['1.2.3', 'mehrere Punkte ohne Tausendergruppen'],
    ['1.200.', 'offene Tausendergruppe'],
    ['1,2,3', 'zwei Kommas'],
    ['1,2.5', 'Punkt nach dem Komma'],
  ])('%s (%s) ist keine vollständige Zahl', (text) => {
    expect(parseNumericInput(text)).toBeNull();
  });
});

describe('RE-10 — strenger Modus: tippen wie auf dem Telefon, Zeichen für Zeichen', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  function mount(initial: number) {
    const values: number[] = [];
    const validity: boolean[] = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(NumericInput, {
          id: 'preis',
          mode: 'decimal',
          strict: true,
          value: initial,
          onChange: (value: number) => values.push(value),
          onEditingValidityChange: (complete: boolean) => validity.push(complete),
          'data-testid': 'preis',
        }),
      );
    });
    const input = container.querySelector('[data-testid="preis"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    const tippe = (text: string) => {
      act(() => input.focus());
      for (let length = 1; length <= text.length; length += 1) {
        act(() => {
          setter.call(input, text.slice(0, length));
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
    };
    return { input, values, validity, tippe };
  }

  it('„1.200,50" ist tippbar und ergibt 1200,50 — nicht 1,2', () => {
    const { input, values, validity, tippe } = mount(0);
    tippe('1.200,50');
    expect(input.value).toBe('1.200,50');
    expect(values.at(-1)).toBe(1200.5);
    expect(validity.at(-1)).toBe(true);
    expect(values).not.toContain(1.2005);
  });

  it('„1.200" ergibt 1200', () => {
    const { values, tippe } = mount(0);
    tippe('1.200');
    expect(values.at(-1)).toBe(1200);
  });

  it('ein offener Zwischenstand überschreibt nichts und meldet „unvollständig"', () => {
    const { values, validity, tippe } = mount(0);
    tippe('1.200,');
    expect(values.at(-1)).toBe(1200);
    expect(validity.at(-1)).toBe(false);
  });

  it('„1,2,3" bleibt abgewiesen (zwei Kommas)', () => {
    const { input, values, tippe } = mount(0);
    tippe('1,2,3');
    expect(input.value).toBe('1,2');
    expect(values.at(-1)).toBe(1.2);
  });
});
