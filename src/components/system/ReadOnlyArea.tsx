import type { ReactNode } from 'react';

interface ReadOnlyAreaProps {
  /** Nur-Lesen aktiv (Betriebslizenz nicht wirksam). */
  active: boolean;
  children: ReactNode;
  testId?: string;
}

/**
 * EINRICHTUNG-01 (AP1, Z-08.1; Vertrag 1.3) — ein Schreibbereich im Nur-Lesen-Betrieb.
 *
 * Ein deaktiviertes `fieldset` sperrt alle enthaltenen Bedienelemente auf einmal (Knöpfe, Felder, Auswahlen) —
 * auch die tief in Unterbausteinen, die die Auskunft selbst nicht lesen. Links und reine Anzeigen bleiben bedienbar.
 * Ohne Nur-Lesen bleibt der Baum unverändert. Das Layout ändert sich nicht (`display: contents`).
 */
export function ReadOnlyArea({ active, children, testId }: ReadOnlyAreaProps) {
  if (!active) return <>{children}</>;
  return (
    <fieldset disabled className="read-only-area" data-testid={testId} data-read-only="true">
      {children}
    </fieldset>
  );
}
