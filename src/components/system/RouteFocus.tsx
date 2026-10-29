import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';

/** Bereich, in dem nach einem Seitenwechsel die Überschrift gesucht wird (App-Rahmen, Anmeldekarte, Rechtsseite). */
const BEREICHE = ['#app-main', '.auth-card', '.legal-page', '.setup-page', 'main'];

/**
 * EINRICHTUNG-01 (AP9; Vertrag 1.32, Q-04.2) — beim Seitenwechsel springt der Fokus auf die Seitenüberschrift (`h1`,
 * `tabindex="-1"`), damit Tastatur und Bildschirmleser auf der neuen Seite beginnen. Nicht beim ersten Aufbau, nicht
 * bei einem Anker in der Adresse (dort führt der Anker zum Feld), nicht bei offenem Dialog und nicht, wenn die neue
 * Seite selbst schon ein Element im Inhalt fokussiert hat.
 */
export function RouteFocus() {
  const { pathname, hash } = useLocation();
  const vorherigerPfad = useRef<string | null>(null);

  useEffect(() => {
    const vorher = vorherigerPfad.current;
    vorherigerPfad.current = pathname;
    if (vorher === null || vorher === pathname || hash) return undefined;
    const frame = window.requestAnimationFrame(() => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const bereich = BEREICHE.map((selektor) => document.querySelector<HTMLElement>(selektor)).find(Boolean) ?? document.body;
      const aktiv = document.activeElement;
      if (aktiv && aktiv !== document.body && bereich.contains(aktiv)) return;
      const ueberschrift = bereich.querySelector<HTMLElement>('h1') ?? document.querySelector<HTMLElement>('h1');
      if (!ueberschrift) return;
      if (!ueberschrift.hasAttribute('tabindex')) ueberschrift.setAttribute('tabindex', '-1');
      ueberschrift.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pathname, hash]);

  return null;
}
