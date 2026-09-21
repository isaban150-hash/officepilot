import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { getSteuerberaterMonthOverview } from '../../services/steuerberaterOverviewService';

/**
 * VISUAL-DESIGN-02B / STARTSEITE-04B — die Monatsmappe als Zustand, nicht
 * als Aufgabe.
 *
 * Der Betrieb soll die Mappe nicht selbst zusammenstellen; OfficeTakt tut
 * das. Die Startseite sagt deshalb nur, wie weit sie ist: der Ring zeigt die
 * Vollständigkeit aus dem vorhandenen Monatsüberblick, die Zahl darin die
 * Belege, die noch eine Prüfung brauchen. Es gibt keine zweite Zählung.
 *
 * Was hier bewusst **nicht** steht: „An Steuerberater senden". Einen
 * Versand aus der Mappe heraus gibt es in OfficeTakt heute nicht; ein Knopf
 * dafür wäre eine Zusage ohne Funktion. Die Aktion führt in die Mappe.
 */
const RING_R = 30;
const RING_UMFANG = 2 * Math.PI * RING_R;

export function HomeMonatsmappe() {
  const { translate, language } = useApp();
  const locale = language === 'tr' ? 'tr-TR' : language === 'bg' ? 'bg-BG' : 'de-DE';
  const mappe = useMemo(() => getSteuerberaterMonthOverview(new Date(), locale), [locale]);

  const zustand =
    mappe.state === 'ready'
      ? translate('heute.pilot.folderReady')
      : mappe.state === 'empty'
        ? translate('heute.pilot.folderEmpty')
        : mappe.openCount === 1
          ? translate('heute.pilot.folderOpenOne')
          : translate('heute.pilot.folderOpen').replace('{count}', String(mappe.openCount));

  const aktion =
    mappe.state === 'open'
      ? translate('heute.pilot.folderCheck')
      : translate('heute.pilot.folderOpenAction');

  const anteil = mappe.state === 'empty' ? 0 : mappe.completenessPercent / 100;
  const ringZahl = mappe.state === 'open' ? String(mappe.openCount) : mappe.state === 'ready' ? '✓' : '–';

  return (
    <section className="heute-panel heute-panel--folder" data-testid="home-monatsmappe">
      <div className="heute-panel__head">
        <h3>{translate('heute.pilot.folderTitle').replace('{month}', mappe.monthLabel)}</h3>
        <Link to="/steuerberater" data-testid="home-monatsmappe-action">
          {aktion}
        </Link>
      </div>
      <div className="heute-ring">
        <svg viewBox="0 0 72 72" aria-hidden>
          <circle cx="36" cy="36" r={RING_R} className="heute-ring__track" />
          <circle
            cx="36"
            cy="36"
            r={RING_R}
            className={`heute-ring__value${mappe.state === 'ready' ? ' heute-ring__value--ready' : ''}`}
            strokeDasharray={RING_UMFANG}
            strokeDashoffset={RING_UMFANG * (1 - anteil)}
            transform="rotate(-90 36 36)"
          />
          <text x="36" y="41" textAnchor="middle" className="heute-ring__num">
            {ringZahl}
          </text>
        </svg>
        <div>
          <b>{zustand}</b>
          <span>{translate('heute.work.folderSub')}</span>
        </div>
      </div>
    </section>
  );
}
