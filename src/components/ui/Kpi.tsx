import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';

/**
 * VISUAL-POLISH-01B — Kennzahlen (Navy Trust).
 *
 * `KpiRow` ist eine ruhige Fläche mit gleich breiten Kacheln; auf schmalen
 * Bildschirmen scrollt sie horizontal statt umzubrechen. `KpiTile` zeigt den
 * Wert stark (Navy), das Label schwach; optional ein Teal-Fortschrittsbalken
 * und ein Hinweis. Keine Karte in der Karte, keine Schatten.
 */

export type KpiTone = 'neutral' | 'positive' | 'warning' | 'critical';

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  /** Fortschritt 0–100 → Teal-Balken. */
  progress?: number;
  tone?: KpiTone;
  to?: string;
  testId?: string;
}

export function KpiRow({ children, className = '', testId, ariaLabel }: { children: ReactNode; className?: string; testId?: string; ariaLabel?: string }) {
  return (
    <div className={`kpi-row ${className}`.trim()} data-testid={testId} role="list" aria-label={ariaLabel}>
      {children}
    </div>
  );
}

export function KpiTile({ label, value, hint, progress, tone = 'neutral', to, testId }: KpiTileProps) {
  const body = (
    <>
      <span className="kpi-tile__label">{label}</span>
      <span className="kpi-tile__value">{value}</span>
      {typeof progress === 'number' ? (
        <span className="kpi-tile__progress" aria-hidden>
          <span className="kpi-tile__progress-bar" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
        </span>
      ) : null}
      {hint ? <span className="kpi-tile__hint">{hint}</span> : null}
      {to ? <Icon id="chevron-right" size="sm" className="kpi-tile__chevron" /> : null}
    </>
  );
  const className = `kpi-tile kpi-tile--${tone}${to ? ' kpi-tile--interactive' : ''}`;
  if (to) {
    return (
      <Link to={to} className={className} data-testid={testId} role="listitem">
        {body}
      </Link>
    );
  }
  return (
    <div className={className} data-testid={testId} role="listitem">
      {body}
    </div>
  );
}
