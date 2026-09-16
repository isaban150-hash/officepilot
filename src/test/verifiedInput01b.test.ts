/**
 * MANUAL-INVOICE-IOS-NUMERIC-INPUT-01B — `fillVerified` gegen einen simulierten Locator.
 *
 *  A  Erfolg beim ersten Versuch: genau ein fill(), kein Blur ohne Auftrag
 *  B  Das 01A-Race (Wert fällt nach fill() zurück) wird erkannt und begrenzt wiederholt
 *  C  Verlust nach dem Rerender (erst korrekt, dann zurückgesetzt) wird ebenso erkannt
 *  D  Blur-Erwartung: umformatierter Wert wird akzeptiert, abweichender nicht
 *  E  Nach `attempts` Fehlversuchen: klarer Fehler mit zuletzt gelesenem Wert
 */
import { describe, expect, it } from 'vitest';
import type { Locator } from '@playwright/test';
import { fillVerified } from '../../tests/e2e/support/verifiedInput';

interface FakeField {
  value: string;
  fills: number;
  blurs: number;
  /** Anzahl der fill()-Aufrufe, die (wie im 01A-Race) sofort verloren gehen. */
  loseImmediately: number;
  /** Anzahl der fill()-Aufrufe, die erst nach dem Rerender zurückfallen. */
  loseAfterRender: number;
  /** Wert, den das Feld nach blur() zeigt (z. B. `2,5` statt `2.5`). */
  blurFormat?: (value: string) => string;
}

function fakeLocator(field: FakeField): Locator {
  let pendingReset = false;
  const locator = {
    async fill(value: string) {
      field.fills += 1;
      if (field.loseImmediately > 0) {
        field.loseImmediately -= 1;
        return; // Wert kommt nie an — DOM bleibt beim alten Stand.
      }
      field.value = value;
      if (field.loseAfterRender > 0) {
        field.loseAfterRender -= 1;
        pendingReset = true;
      }
    },
    async inputValue() {
      return field.value;
    },
    async evaluate() {
      // "Rerender": ein ausstehender Rückfall wird jetzt wirksam.
      if (pendingReset) {
        pendingReset = false;
        field.value = '';
      }
      return undefined;
    },
    async blur() {
      field.blurs += 1;
      if (field.blurFormat) field.value = field.blurFormat(field.value);
    },
    toString() {
      return 'fake';
    },
  };
  return locator as unknown as Locator;
}

describe('MANUAL-INVOICE-IOS-NUMERIC-INPUT-01B — fillVerified', () => {
  it('A: erster Versuch genügt, kein Blur ohne Auftrag', async () => {
    const field: FakeField = { value: '', fills: 0, blurs: 0, loseImmediately: 0, loseAfterRender: 0 };
    await fillVerified(fakeLocator(field), 'Monteurstunden');
    expect(field.value).toBe('Monteurstunden');
    expect(field.fills).toBe(1);
    expect(field.blurs).toBe(0);
  });

  it('B: sofortiger Verlust wird erkannt und genau dieser Schritt wiederholt', async () => {
    const field: FakeField = { value: '', fills: 0, blurs: 0, loseImmediately: 2, loseAfterRender: 0 };
    await fillVerified(fakeLocator(field), '2.5');
    expect(field.value).toBe('2.5');
    expect(field.fills).toBe(3);
  });

  it('C: Rückfall nach dem Rerender wird erkannt', async () => {
    const field: FakeField = { value: '', fills: 0, blurs: 0, loseImmediately: 0, loseAfterRender: 1 };
    await fillVerified(fakeLocator(field), '2026-09-05');
    expect(field.value).toBe('2026-09-05');
    expect(field.fills).toBe(2);
  });

  it('D: Blur-Erwartung akzeptiert die Umformatierung und lehnt Abweichungen ab', async () => {
    const ok: FakeField = { value: '', fills: 0, blurs: 0, loseImmediately: 0, loseAfterRender: 0, blurFormat: (v) => v.replace('.', ',') };
    await fillVerified(fakeLocator(ok), '2.5', { expectAfterBlur: '2,5' });
    expect(ok.value).toBe('2,5');
    expect(ok.blurs).toBe(1);

    const wrong: FakeField = { value: '', fills: 0, blurs: 0, loseImmediately: 0, loseAfterRender: 0, blurFormat: () => '' };
    await expect(fillVerified(fakeLocator(wrong), '58', { expectAfterBlur: '58', attempts: 2 })).rejects.toThrow(
      /nach 2 Versuchen nicht im Feld \(zuletzt gelesen: ""\)/,
    );
    expect(wrong.fills).toBe(2);
  });

  it('E: dauerhafter Verlust schlägt nach den erlaubten Versuchen klar fehl', async () => {
    const field: FakeField = { value: 'alt', fills: 0, blurs: 0, loseImmediately: 99, loseAfterRender: 0 };
    await expect(fillVerified(fakeLocator(field), 'neu', { label: 'Beschreibung' })).rejects.toThrow(
      'fillVerified(Beschreibung): Wert "neu" nach 3 Versuchen nicht im Feld (zuletzt gelesen: "alt").',
    );
    expect(field.fills).toBe(3);
  });
});
