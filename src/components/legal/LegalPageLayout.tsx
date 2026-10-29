import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuthPageText } from '../../hooks/useAuthPageText';
import { t } from '../../i18n';
import {
  SETTINGS_HUB_ROUTE,
  isSettingsReturnState,
  settingsTargetTitleKey,
  type SettingsTargetId,
} from '../../pages/settings/settingsHubConfig';
import { LegalFooterLinks } from './LegalFooterLinks';
import { SkipLink } from '../system/SkipLink';

type LegalTarget = Extract<SettingsTargetId, 'imprint' | 'privacy' | 'terms' | 'license'>;

interface LegalPageLayoutProps {
  /** EINRICHTUNG-01 (AP5; 1.15) — der Titel kommt aus demselben Schlüssel wie der Hub-Eintrag. */
  target: LegalTarget;
  children: ReactNode;
  testId: string;
}

/**
 * Rechtsseiten liegen außerhalb des App-Rahmens und erscheinen auch ohne Anmeldung. Kommt man aus dem Hub
 * („Hilfe und Rechtliches“), führt „Zurück“ wieder dorthin (N-01.2); sonst wie bisher zur Startseite der Anmeldung.
 *
 * EINRICHTUNG-01 (AP9; 1.31) — der Rahmen folgt der Oberflächensprache; die Rechtstexte selbst liegen nur auf Deutsch
 * vor (Ausnahme, rechtlich geprüfte Übersetzungen fehlen) — außerhalb von de sagt die Seite das.
 */
export function LegalPageLayout({ target, children, testId }: LegalPageLayoutProps) {
  const { language, text } = useAuthPageText();
  const location = useLocation();
  const fromSettings = isSettingsReturnState(location.state);
  const title = t(settingsTargetTitleKey(target), language);

  return (
    <div className="legal-page" data-testid={testId}>
      {/* EINRICHTUNG-01 (AP9; 1.32) — erstes fokussierbares Element: Sprung zur Überschrift. */}
      <SkipLink href="#legal-title" label={text('a11y.skipToContent')} findTarget={() => document.getElementById('legal-title')} />
      <div className="legal-page__inner">
        <p className="legal-page__draft-banner" role="note" data-testid="legal-draft-notice">
          {text('legal.draftNotice')}
        </p>
        {language !== 'de' ? (
          <p className="legal-page__draft-banner" role="note" lang={language} data-testid="legal-german-only">
            {text('legal.germanOnly')}
          </p>
        ) : null}
        <header className="legal-page__header">
          {fromSettings ? (
            <Link to={SETTINGS_HUB_ROUTE} className="legal-page__back" data-testid="legal-back-settings">
              ← {t('settings.backToHub', language)}
            </Link>
          ) : (
            <Link to="/login" className="legal-page__back" data-testid="legal-back">
              ← OfficeTakt
            </Link>
          )}
          <h1 className="legal-page__title" id="legal-title" tabIndex={-1}>
            {title}
          </h1>
        </header>
        <div className="legal-page__body" lang="de">
          {children}
        </div>
        <LegalFooterLinks className="legal-page__footer" />
      </div>
    </div>
  );
}
