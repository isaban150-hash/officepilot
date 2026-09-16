/**
 * MANUAL-INVOICE-IOS-NUMERIC-INPUT-01B — verifizierte Eingabe für WebKit-E2E.
 *
 * 01A hat gezeigt: Unter iOS/WebKit geht ein per `fill()` gesetzter Wert
 * intermittierend verloren — der DOM-Wert fällt unmittelbar nach dem `fill()`
 * auf den alten Stand zurück, React und der Entwurf sehen die Eingabe nie
 * (Textarea, Text-, Numeric- und date-Felder gleichermaßen). `fill()` selbst
 * meldet dabei keinen Fehler.
 *
 * Dieser Helfer macht aus „fill() kam zurück" ein „der Wert steht wirklich im
 * Feld": Eingabe → sofortiger Readback → kurzer React-Zyklus → erneuter
 * Readback (optional nach Blur). Nur wenn der Wert nachweislich verloren ging,
 * wird **genau dieser Eingabeschritt** begrenzt wiederholt; danach schlägt der
 * Schritt klar fehl. Ein Wert, der im Feld steht, aber fachlich nicht
 * übernommen wird, wird hier bewusst **nicht** kaschiert — das prüfen die
 * Tests weiterhin über Entwurfs-/Summenanzeigen.
 */
import type { Locator } from '@playwright/test';

export interface FillVerifiedOptions {
  /** Gesamtzahl der Versuche (Erstversuch eingeschlossen). Standard 3. */
  attempts?: number;
  /**
   * Erwarteter Wert nach dem Verlassen des Feldes. `undefined` = kein Blur.
   * Für Felder, die beim Blur umformatieren (NumericInput: `2.5` → `2,5`),
   * hier den formatierten Wert übergeben.
   */
  expectAfterBlur?: string;
  /** Lesbarer Name für Fehlermeldungen. */
  label?: string;
}

/** Zwei Animation-Frames abwarten — ein React-Rerender ist dann sicher durch. */
async function settle(locator: Locator): Promise<void> {
  await locator.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}

/**
 * Wert eingeben und nachweisen, dass er im Feld angekommen ist.
 *
 * Verifikation je Versuch:
 *  1. `inputValue()` direkt nach `fill()`
 *  2. nach zwei Animation-Frames erneut (Rerender hat den Wert nicht zurückgesetzt)
 *  3. optional nach `blur()` erneut (`expectAfterBlur`)
 * Schlägt die Verifikation fehl, wird der Schritt wiederholt — höchstens
 * `attempts`-mal. Dann wirft der Helfer mit dem zuletzt gelesenen Wert.
 */
export async function fillVerified(locator: Locator, value: string, options: FillVerifiedOptions = {}): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const label = options.label ?? String(locator);
  let lastSeen: string | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await locator.fill(value);

    const immediate = await locator.inputValue();
    if (immediate !== value) {
      lastSeen = immediate;
      continue;
    }

    await settle(locator);
    const afterRender = await locator.inputValue();
    if (afterRender !== value) {
      lastSeen = afterRender;
      continue;
    }

    if (options.expectAfterBlur !== undefined) {
      await locator.blur();
      await settle(locator);
      const afterBlur = await locator.inputValue();
      if (afterBlur !== options.expectAfterBlur) {
        lastSeen = afterBlur;
        continue;
      }
    }
    return;
  }

  throw new Error(
    `fillVerified(${label}): Wert "${value}" nach ${attempts} Versuchen nicht im Feld (zuletzt gelesen: ${JSON.stringify(lastSeen)}).`,
  );
}
