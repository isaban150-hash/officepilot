/**
 * REAL-PRODUCT-TEST-01D — Scrollregel beim Seitenwechsel.
 *
 * Gescrollt wird je nach Layout im Fenster (Desktop/Mobil, `.app-shell` wächst
 * mit dem Inhalt) oder im Inhaltsbereich `.app-shell__main` (`overflow-y:
 * auto`, wenn er eine feste Höhe bekommt). React Router lässt beide beim
 * Seitenwechsel stehen; der Browser stellt bei einer SPA nur beim Zurückgehen
 * etwas her — und das unzuverlässig. Ergebnis war: Neue Hauptseiten und
 * Detailseiten begannen mitten im Inhalt.
 *
 * Regel:
 *  - neue Seite (Vorwärtsnavigation, anderer Pfad) → oben beginnen
 *  - echter Rückweg (Browser-Zurück/Vor, `POP`)      → gemerkte Position der Zielseite
 *  - gleicher Pfad, nur Query/Hash (z. B. Assistent-Schritt) → Position lassen
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

interface ScrollPosition {
  window: number;
  main: number;
}

const positions = new Map<string, ScrollPosition>();

/**
 * Schlüssel eines Verlaufseintrags. `location.key` allein reicht nicht: Ohne
 * Router-Status im Verlauf (z. B. nach Reload) heißt jeder Eintrag „default",
 * und die Position der Zielseite würde beim Verlassen der Detailseite
 * überschrieben. Pfad und Query machen den Eintrag eindeutig genug.
 */
function entryKey(location: { key: string; pathname: string; search: string }): string {
  return `${location.key}|${location.pathname}${location.search}`;
}

function readPosition(main: HTMLElement | null): ScrollPosition {
  return { window: typeof window !== 'undefined' ? window.scrollY : 0, main: main?.scrollTop ?? 0 };
}

function applyPosition(main: HTMLElement | null, position: ScrollPosition): void {
  if (main) main.scrollTop = position.main;
  if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
    window.scrollTo(0, position.window);
  }
}

export function useMainScrollRestoration(mainRef: RefObject<HTMLElement | null>): void {
  const location = useLocation();
  const navigationType = useNavigationType();
  const previous = useRef<{ key: string; pathname: string } | null>(null);
  const currentKey = entryKey(location);
  /*
   * Position im Moment der Nutzeraktion (Tipp/Klick/Taste) merken: Zwischen
   * dem Klick auf einen Link und dem Einhängen der neuen Seite kann der
   * Browser die Fensterposition bereits verändert haben — dann wäre beim
   * Verlassen „0" statt der echten Position gespeichert worden.
   */
  const interaction = useRef<{ position: ScrollPosition; at: number } | null>(null);

  useLayoutEffect(() => {
    const remember = () => {
      interaction.current = { position: readPosition(mainRef.current), at: Date.now() };
    };
    document.addEventListener('pointerdown', remember, true);
    document.addEventListener('keydown', remember, true);
    return () => {
      document.removeEventListener('pointerdown', remember, true);
      document.removeEventListener('keydown', remember, true);
    };
  }, [mainRef]);

  useLayoutEffect(() => {
    /* Der Browser soll nicht parallel „mitraten" — die Regel hier ist die einzige. */
    if (typeof history !== 'undefined' && 'scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }
  }, []);

  useLayoutEffect(() => {
    const main = mainRef.current;
    const prev = previous.current;
    if (prev) {
      const recent = interaction.current && Date.now() - interaction.current.at < 1_500 ? interaction.current.position : null;
      positions.set(prev.key, recent ?? readPosition(main));
      interaction.current = null;
    }
    previous.current = { key: currentKey, pathname: location.pathname };

    if (navigationType === 'POP') {
      const target = positions.get(currentKey) ?? { window: 0, main: 0 };
      applyPosition(main, target);
      /* Inhalt kann erst nach dem ersten Frame seine Höhe haben — einmal nachziehen. */
      const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => applyPosition(main, target)) : 0;
      return () => { if (frame) cancelAnimationFrame(frame); };
    }
    if (!prev || prev.pathname !== location.pathname) {
      applyPosition(main, { window: 0, main: 0 });
    }
  }, [currentKey, location.pathname, navigationType, mainRef]);
}

/** Nur für Tests: gemerkte Positionen verwerfen. */
export function resetMainScrollPositionsForTests(): void {
  positions.clear();
}
