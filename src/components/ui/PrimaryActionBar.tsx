import type { ReactNode } from 'react';

/**
 * UIUX-FOUNDATION-01B — Container für genau eine Hauptaktion.
 *
 * Reihenfolge im DOM: Hinweis → Sekundäraktionen → Primary. Mobil klebt die
 * Leiste über der Bottom-Navigation (Safe-Area berücksichtigt), ab Desktop
 * steht sie im Fluss der Seite. Sekundäraktionen sollen `outline`/`ghost`
 * sein — die Komponente erzwingt keine Varianten, aber genau einen
 * `primary`-Slot.
 */
export interface PrimaryActionBarProps {
  primary: ReactNode;
  secondary?: ReactNode;
  /** Kurzer Hinweis über den Aktionen (z. B. „Erst Freigeben vergibt die Nummer.“). */
  note?: ReactNode;
  /** Standard `true`: mobil sticky. `false` für Dialoge/Inline-Kontexte. */
  sticky?: boolean;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}

export function PrimaryActionBar({
  primary,
  secondary,
  note,
  sticky = true,
  className = '',
  testId = 'primary-action-bar',
  ariaLabel,
}: PrimaryActionBarProps) {
  return (
    <div
      className={['primary-action-bar', sticky ? 'primary-action-bar--sticky' : '', className].filter(Boolean).join(' ')}
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {note ? (
        <p className="primary-action-bar__note" data-testid={`${testId}-note`}>
          {note}
        </p>
      ) : null}
      <div className="primary-action-bar__actions">
        {secondary ? (
          <div className="primary-action-bar__secondary" data-testid={`${testId}-secondary`}>
            {secondary}
          </div>
        ) : null}
        <div className="primary-action-bar__primary" data-testid={`${testId}-primary`}>
          {primary}
        </div>
      </div>
    </div>
  );
}
