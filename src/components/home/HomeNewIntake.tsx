import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { filterActiveItems, getInboxItems } from '../../services/inboxService';
import type { TranslationKey } from '../../i18n';
import { Icon } from '../ui/Icon';

/**
 * STARTSEITE-04B — „Neu im Eingang" als ruhiges Statusfeld.
 *
 * Jede Zeile zeigt nur, was am Eingang wirklich steht: Titel, Absender,
 * Datum und — falls vorhanden — die empfohlene Handlung (`recommendedAction`)
 * als kleine Marke. Fehlt eine Empfehlung, steht auch keine da; es wird
 * nichts abgeleitet oder erraten. Der Titel des Feldes führt in den Eingang.
 *
 * Desktop zeigt vier Zeilen, mobil drei (die vierte blendet das CSS aus).
 */
const MAX_ROWS = 4;

export function HomeNewIntake() {
  const { translate, language } = useApp();
  const locale = language === 'tr' ? 'tr-TR' : language === 'bg' ? 'bg-BG' : 'de-DE';

  const neue = useMemo(
    () =>
      filterActiveItems(getInboxItems())
        .filter((item) => item.status === 'neu')
        .sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? '')),
    [],
  );
  const items = neue.slice(0, MAX_ROWS);

  return (
    <section className="heute-panel heute-panel--inbox" data-testid="heute-section-new">
      <div className="heute-panel__head">
        <h3>{translate('heute.work.inboxTitle')}</h3>
        {neue.length > 0 ? (
          <Link to="/ablage" data-testid="home-new-intake-all">
            {translate('heute.work.inboxAll').replace('{count}', String(neue.length))}
          </Link>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="heute-panel__quiet" data-testid="home-new-intake-empty">
          {translate('heute.pilot.newInEmpty')}
        </p>
      ) : (
        <ul className="heute-doclist" data-testid="home-new-intake">
          {items.map((item) => {
            const datum = item.receivedAt
              ? new Date(item.receivedAt).toLocaleDateString(locale, { day: 'numeric', month: 'short' })
              : '';
            const meta = [item.sender, datum].filter(Boolean).join(' · ');
            const vorschlag = item.recommendedAction
              ? translate(`action.${item.recommendedAction}` as TranslationKey)
              : '';
            const dringend = item.recommendedAction === 'zahlung_pruefen';
            return (
              <li key={item.id}>
                <Link to={`/ablage/${item.id}`} className="heute-doclist__row">
                  <span className="heute-doclist__ic" aria-hidden>
                    <Icon id="file" size="sm" />
                  </span>
                  <span className="heute-doclist__body">
                    <b>{item.title}</b>
                    {meta ? <span>{meta}</span> : null}
                  </span>
                  {vorschlag ? (
                    <span
                      className={`heute-tag${dringend ? ' heute-tag--amber' : ''}`}
                      data-testid={`home-new-intake-hint-${item.id}`}
                    >
                      {dringend ? vorschlag : translate('heute.work.suggestion').replace('{text}', vorschlag)}
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
