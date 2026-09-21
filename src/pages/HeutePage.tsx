import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { DeskSuccesses } from '../components/home/DeskSuccesses';
import { HomeAssistantPrompt } from '../components/home/HomeAssistantPrompt';
import { HomeFocusTask } from '../components/home/HomeFocusTask';
import { HomeMonatsmappe } from '../components/home/HomeMonatsmappe';
import { HomeNewIntake } from '../components/home/HomeNewIntake';
import { HomeNextTasks } from '../components/home/HomeNextTasks';
import { Icon } from '../components/ui/Icon';
import { Page } from '../components/ui/Page';
import { useApp } from '../context/AppContext';
import {
  buildDeskGreeting,
  buildDeskPriorities,
  buildDeskRecommendation,
  buildDeskSuccesses,
  type DeskRecommendation,
} from '../services/deskIntelligenceService';
import type { HomeHint } from '../services/homeHintService';
import type { TranslationKey } from '../i18n';

/**
 * STARTSEITE-04B — die Startseite nach dem freigegebenen Prototyp 04A
 * (`docs/prototypes/04a-startseite`), angeschlossen an die echten Dienste.
 *
 * Komposition (Desktop):
 *   Ansprache
 *   ┌ Fokusfläche: wichtigste Priorität ┐ ┌ Danach ┐
 *   │                                   │ │ Upload │
 *   └───────────────────────────────────┘ └────────┘
 *   Auftrag an OfficeTakt (bestehender Assistent)
 *   Neu im Eingang │ Monatsmappe │ Heute erledigt (nur mit Daten)
 *
 * Mobil stapeln sich dieselben Bausteine in dieser Reihenfolge; Danach und
 * Upload folgen direkt auf die Fokusfläche, das Auftragsfeld danach.
 *
 * Datenquellen unverändert: `buildDeskPriorities` (Reihenfolge = Priorität),
 * `dismissHomeHint`/`snoozeHomeHint`, `buildDeskRecommendation`,
 * `buildDeskSuccesses`, Eingang, Monatsüberblick, Assistent über `/assistent`.
 *
 * Datenschutz: Hinweise mit Betrags-Parametern werden ausgefiltert (03B);
 * die Startseite zeigt keine Geldbeträge.
 */
const ASK_EXAMPLES: readonly TranslationKey[] = [
  'heute.work.ask1',
  'heute.work.ask2',
  'heute.work.ask3',
  'heute.work.ask4',
];

const BETRAGS_PARAMETER = /betrag|amount|sum|total|euro/i;

function traegtBetrag(params?: Record<string, string | number>): boolean {
  if (!params) return false;
  if (Object.keys(params).some((name) => BETRAGS_PARAMETER.test(name))) return true;
  return Object.values(params).some((value) => /€|EUR/.test(String(value)));
}

function ohneBetraege(hints: HomeHint[]): HomeHint[] {
  return hints.filter((hint) => !traegtBetrag(hint.params));
}

function betragsfrei(rec: DeskRecommendation | null): DeskRecommendation | null {
  if (!rec || !rec.route || traegtBetrag(rec.params)) return null;
  return rec;
}

export function HeutePage() {
  const { translate, companyProfile, language } = useApp();
  const greeting = useMemo(() => {
    const contactFirstName = companyProfile.contactPerson?.trim().split(/\s+/)[0];
    return buildDeskGreeting(contactFirstName);
  }, [companyProfile.contactPerson]);
  const greetingText = greeting.firstName
    ? `${translate(greeting.messageKey)}, ${greeting.firstName}.`
    : `${translate(greeting.messageKey)}.`;
  const locale = language === 'tr' ? 'tr-TR' : language === 'bg' ? 'bg-BG' : 'de-DE';
  const dateLabel = useMemo(
    () => new Date().toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    [locale],
  );

  const [priorities, setPriorities] = useState(() => ohneBetraege(buildDeskPriorities()));
  const refresh = useCallback(() => setPriorities(ohneBetraege(buildDeskPriorities())), []);
  const recommendation = useMemo(
    () => (priorities.length === 0 ? betragsfrei(buildDeskRecommendation()) : null),
    [priorities.length],
  );
  const hasSuccesses = useMemo(() => buildDeskSuccesses().length > 0, []);
  const [current, ...rest] = priorities;

  const countLine =
    priorities.length === 0
      ? translate('heute.work.noneNeeded')
      : priorities.length === 1
        ? translate('heute.work.countOne')
        : translate('heute.work.countMany').replace('{count}', String(priorities.length));

  return (
    <Page className="heute-page heute-04b mobile-first-page" testId="heute-page">
      <div className="heute-04b__flow" data-testid="mobile-first-home">
        <p className="heute-04b__date">{dateLabel}</p>

        <header className="heute-04b__greet" data-testid="desk-greeting-header">
          <h1>{greetingText}</h1>
          <p>
            {translate('heute.work.checked')}{' '}
            <b data-testid="heute-summary">{countLine}</b>
          </p>
        </header>

        <section className="heute-04b__work" aria-label={translate('heute.work.nowLabel')}>
          <HomeFocusTask current={current} recommendation={recommendation} onChange={refresh} />
          <div className="heute-04b__aside">
            <HomeNextTasks hints={rest} />
            <Link to="/dokumente/hinzufuegen" className="heute-drop" data-testid="home-card-add-document">
              <span className="heute-drop__icon" aria-hidden>
                <Icon id="upload" />
              </span>
              <b>{translate('heute.pilot.upload')}</b>
              <span>{translate('heute.work.uploadHint')}</span>
            </Link>
          </div>
        </section>

        <section className="heute-command" data-testid="heute-section-assistant">
          <div className="heute-command__head">
            <h2>{translate('heute.work.askTitle')}</h2>
            <span className="heute-command__hint">{translate('heute.work.commandHint')}</span>
          </div>
          <HomeAssistantPrompt
            exampleKeys={ASK_EXAMPLES}
            placeholderKey="heute.work.askPlaceholder"
            mobilePlaceholderKey="heute.work.askPlaceholderMobile"
            showMic={false}
            sendLabelKey="heute.work.send"
          />
        </section>

        <section className="heute-04b__status">
          <HomeNewIntake />
          <HomeMonatsmappe />
          {hasSuccesses ? (
            <section className="heute-panel heute-panel--done" data-testid="heute-section-done">
              <div className="heute-panel__head">
                <h3>{translate('heute.work.doneTitle')}</h3>
              </div>
              <DeskSuccesses />
            </section>
          ) : null}
        </section>
      </div>
    </Page>
  );
}
