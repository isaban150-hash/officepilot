/**
 * FINANZ-CORE-01A (A4 / RE-06 / RE-10 Rest) — Geldeingaben auf Cent, deutsche Zahlen
 * auch im Positionsformular des Auftrags und im Nachtragseditor.
 *
 *  G1  Nachtragsparser: „1.200" ist 1200, „1.200,50" ist 1200,50; Exponent und Text abgewiesen
 *  G2  Centprüfung: 0,045 € hat Unter-Cent-Anteil, 12,34 € nicht
 *  G3  Positionsformular: „1.200" Menge wird 1200, „12,345" bleibt „12,34"; gespeichert wird genau das
 *  G4  Positionsformular: ein halber Zwischenstand („1,") sperrt „Speichern"
 *
 * Synthetische Daten, kein Netz.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { t } from '../../i18n';
import { createTestVorgang } from '../../test/fixtures';
import { getVorgangById, hydrateVorgangStore } from '../../services/vorgangService';
import { persistAll } from '../../services/persistenceService';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import type { Vorgang } from '../../types/models';
import { OrderPositionForm } from './OrderPositionForm';
import { hasSubCentPrecision, parseAmendmentDecimalInput } from './orderAmendmentUiHelpers';

const VORGANG_ID = 'v-geldeingabe-fc01a';

describe('G1/G2 — Nachtragsparser und Centprüfung', () => {
  it('G1: deutsche Tausenderpunkte; Exponent und Text werden abgewiesen', () => {
    expect(parseAmendmentDecimalInput('1.200')).toBe(1200);
    expect(parseAmendmentDecimalInput('1.200,50')).toBe(1200.5);
    expect(parseAmendmentDecimalInput('12,5')).toBe(12.5);
    expect(parseAmendmentDecimalInput('1.5')).toBe(1.5);
    expect(parseAmendmentDecimalInput('-2,5')).toBe(-2.5);
    expect(parseAmendmentDecimalInput(' 1 200 ')).toBe(1200);
    expect(parseAmendmentDecimalInput('1e3')).toBeNull();
    expect(parseAmendmentDecimalInput('abc')).toBeNull();
    expect(parseAmendmentDecimalInput('1,')).toBeNull();
    expect(parseAmendmentDecimalInput('')).toBeNull();
  });

  it('G2: Unter-Cent-Anteil erkannt', () => {
    expect(hasSubCentPrecision(0.045)).toBe(true);
    expect(hasSubCentPrecision(12.345)).toBe(true);
    expect(hasSubCentPrecision(12.34)).toBe(false);
    expect(hasSubCentPrecision(1200)).toBe(false);
    expect(hasSubCentPrecision(0)).toBe(false);
  });
});

describe('G3/G4 — Positionsformular des Auftrags', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    setActiveStorageScope({ type: 'guest' });
    localStorage.clear();
    const vorgang = createTestVorgang({ id: VORGANG_ID, orderPositions: [] });
    delete (vorgang as Partial<Vorgang>).contractConfirmation;
    hydrateVorgangStore([vorgang]);
    expect(persistAll().success).toBe(true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function zeige(): void {
    act(() => {
      root.render(
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(OrderPositionForm, {
            mode: 'add' as const,
            vorgang: getVorgangById(VORGANG_ID)!,
            onSaved: () => undefined,
            onClose: () => undefined,
          }),
        ),
      );
    });
  }

  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  function tippe(input: HTMLInputElement, text: string): void {
    act(() => input.focus());
    act(() => {
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    for (let length = 1; length <= text.length; length += 1) {
      act(() => {
        setter.call(input, text.slice(0, length));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
  }

  const feld = (id: string) => host.querySelector(`#${id}`) as HTMLInputElement;
  const speichern = () =>
    Array.from(host.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === t('common.save', 'de')) as HTMLButtonElement;

  it('G3: „1.200" Menge und „12,345" Preis — gespeichert werden 1200 und 12,34', () => {
    zeige();
    const beschreibung = host.querySelector('.edit-field input.input') as HTMLInputElement;
    act(() => {
      setter.call(beschreibung, 'Fliesen verlegen');
      beschreibung.dispatchEvent(new Event('input', { bubbles: true }));
    });
    tippe(feld('order-position-form-quantity'), '1.200');
    tippe(feld('order-position-form-unit-price'), '12,345');
    expect(feld('order-position-form-unit-price').value).toBe('12,34');

    act(() => speichern().click());
    const position = getVorgangById(VORGANG_ID)?.orderPositions.at(-1);
    expect(position?.description).toBe('Fliesen verlegen');
    expect(position?.plannedQuantity).toBe(1200);
    expect(position?.unitPrice).toBe(12.34);
  });

  it('G4: ein halber Zwischenstand sperrt „Speichern"', () => {
    zeige();
    expect(speichern().disabled).toBe(false);
    tippe(feld('order-position-form-unit-price'), '12,');
    expect(speichern().disabled).toBe(true);
    tippe(feld('order-position-form-unit-price'), '12,5');
    expect(speichern().disabled).toBe(false);
  });
});
