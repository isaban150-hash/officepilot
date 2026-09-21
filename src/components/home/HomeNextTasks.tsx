import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import type { HomeHint } from '../../services/homeHintService';
import type { TranslationKey } from '../../i18n';
import { Icon } from '../ui/Icon';
import { fillHint } from './HomeFocusTask';

/**
 * STARTSEITE-04B — „Danach": die nächsten Prioritäten, kompakt.
 *
 * Zahl gross, Aussage daneben, darunter der Bereich, in den der Eintrag
 * führt. Die Zahl ist der `count`-Parameter des Hinweises; steht sie schon
 * am Satzanfang, wird sie dort nicht wiederholt. Ohne Zahl bleibt der Satz.
 */
const ROUTE_LABEL: Record<string, TranslationKey> = {
  '/aufgaben': 'mehr.tasks',
  '/ablage': 'nav.eingang',
  '/rechnungen/offen': 'nav.rechnungen',
  '/ausgaben/offen': 'finanzen.openExpenses',
  '/dokumente': 'nav.dokumente',
  '/steuerberater': 'finanzen.steuerberater',
};

function split(text: string, count: string | number | undefined): { num: string | null; rest: string } {
  if (count === undefined) return { num: null, rest: text };
  const n = String(count);
  if (!text.startsWith(`${n} `)) return { num: null, rest: text };
  return { num: n, rest: text.slice(n.length + 1).replace(/\.$/, '') };
}

export function HomeNextTasks({ hints }: { hints: HomeHint[] }) {
  const { translate } = useApp();
  if (hints.length === 0) return null;

  return (
    <div className="heute-next" data-testid="home-next-tasks">
      <h3 className="heute-next__label">{translate('heute.work.next').replace(/:$/, '')}</h3>
      {hints.map((hint) => {
        const { num, rest } = split(fillHint(translate(hint.messageKey), hint.params), hint.params?.count);
        const bereich = hint.route ? ROUTE_LABEL[hint.route] : undefined;
        const inner = (
          <>
            {num ? <span className="heute-next__num">{num}</span> : null}
            <span className="heute-next__txt">
              {rest}
              {bereich ? <small>{translate(bereich)}</small> : null}
            </span>
            {hint.route ? (
              <span className="heute-next__arrow">
                <Icon id="chevron-right" size="sm" />
              </span>
            ) : null}
          </>
        );
        return hint.route ? (
          <Link key={hint.id} to={hint.route} className="heute-next__row">
            {inner}
          </Link>
        ) : (
          <div key={hint.id} className="heute-next__row">
            {inner}
          </div>
        );
      })}
    </div>
  );
}
