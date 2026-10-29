import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.18, F-01.2) — der Sprung aus der Fehlerliste einer anderen Einstellungsseite landet am
 * Feld: Trägt die Adresse einen Hash, der die ID eines Elements dieser Seite ist, wird es nach dem Aufbau sichtbar
 * gemacht und fokussiert. Ohne passenden Hash geschieht nichts.
 *
 * Nur Kennungen aus Buchstaben, Ziffern, Binde- und Unterstrich werden gesucht (kein Selektor aus der Adresse).
 */
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,120}$/;

export function useFocusFieldFromHash(ready = true): void {
  const { hash, key } = useLocation();
  useEffect(() => {
    if (!ready) return undefined;
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    if (!id || !SAFE_ID.test(id)) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const element = document.getElementById(id);
      if (!element) return;
      if (typeof element.scrollIntoView === 'function') element.scrollIntoView({ block: 'center' });
      if (typeof (element as HTMLElement).focus === 'function') (element as HTMLElement).focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [hash, key, ready]);
}
