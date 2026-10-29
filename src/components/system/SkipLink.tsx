import type { MouseEvent } from 'react';

interface SkipLinkProps {
  /** Sprungziel als Anker (für Bildschirmleser und ohne JavaScript); die Adresse ändert sich beim Klick nicht. */
  href: string;
  label: string;
  /** Element, das den Fokus erhält — meist die Seitenüberschrift. */
  findTarget: () => HTMLElement | null | undefined;
}

/**
 * EINRICHTUNG-01 (AP9; Vertrag 1.32, Q-04.2) — „Zum Inhalt springen“ als erstes fokussierbares Element. Unsichtbar, bis
 * er den Tastaturfokus hat; der Sprung setzt den Fokus auf das Ziel, ohne die Adresse (und damit den Router) zu ändern.
 */
export function SkipLink({ href, label, findTarget }: SkipLinkProps) {
  const springen = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const ziel = findTarget();
    if (!ziel) return;
    if (!ziel.hasAttribute('tabindex')) ziel.setAttribute('tabindex', '-1');
    ziel.focus();
  };
  return (
    <a href={href} className="skip-link" onClick={springen} data-testid="skip-link">
      {label}
    </a>
  );
}
