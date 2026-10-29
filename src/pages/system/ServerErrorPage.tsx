import { Button } from '../../components/ui/Button';
import { DocumentLanguage } from '../../components/system/DocumentLanguage';
import { SkipLink } from '../../components/system/SkipLink';
import { t, type TranslationKey } from '../../i18n';
import { getPersonalUiLanguageOwner, readPersonalUiLanguage } from '../../services/auth/personalUiLanguage';
import { getCachedSetup } from '../../services/persistenceService';
import type { AppLanguage } from '../../types/models';

/**
 * CORE-REALTEST-BLOCKER-01B — technical details of a caught render error.
 * Only ever rendered while `import.meta.env.DEV` is true; production keeps the
 * generic page without any internal information.
 */
export interface ServerErrorDevDetails {
  message: string;
  stack?: string;
  componentStack?: string;
}

interface ServerErrorPageProps {
  onRetry?: () => void;
  devDetails?: ServerErrorDevDetails | null;
}

/**
 * EINRICHTUNG-01 (AP9-Nacharbeit; 1.14, 1.31) — die Fehlergrenze ist eine B2-Fläche und steht außerhalb aller Provider
 * (main.tsx). Sprache wie vor dem App-Rahmen (persönliche Sprache, dann zuletzt gespeicherte Betriebssprache, sonst
 * Deutsch), hier ohne Hook und mit Rückfall: Die Fehlerseite darf nie selbst an einem beschädigten Speicher scheitern.
 */
function errorPageLanguage(): AppLanguage {
  try {
    return readPersonalUiLanguage(getPersonalUiLanguageOwner()) ?? getCachedSetup()?.language ?? 'de';
  } catch {
    return 'de';
  }
}

export function ServerErrorPage({ onRetry, devDetails }: ServerErrorPageProps) {
  const showDevDetails = Boolean(import.meta.env.DEV && devDetails);
  const language = errorPageLanguage();
  const tr = (key: TranslationKey) => t(key, language);

  return (
    <div className="system-page" data-testid="server-error-page">
      <DocumentLanguage language={language} />
      {/* EINRICHTUNG-01 (AP9-Nacharbeit; 1.32) — erstes fokussierbares Element: Sprung zur Überschrift. */}
      <SkipLink
        href="#server-error-title"
        label={tr('a11y.skipToContent')}
        findTarget={() => document.getElementById('server-error-title')}
      />
      <div className="system-page__card">
        <p className="system-page__code">500</p>
        <h1 className="system-page__title" id="server-error-title" tabIndex={-1}>
          {tr('serverError.title')}
        </h1>
        <p className="system-page__text">{tr('serverError.text')}</p>
        <Button
          fullWidth
          onClick={() => {
            if (onRetry) {
              onRetry();
              return;
            }
            window.location.reload();
          }}
          data-testid="server-error-retry"
        >
          {tr('serverError.retry')}
        </Button>

        {showDevDetails && devDetails ? (
          <section className="system-page__dev" data-testid="server-error-dev-details">
            <h2 className="system-page__dev-title">{tr('serverError.devDetails')}</h2>
            <p
              className="system-page__dev-message"
              data-testid="server-error-dev-message"
              style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
            >
              {devDetails.message}
            </p>
            {devDetails.stack ? (
              <pre
                className="system-page__dev-stack"
                data-testid="server-error-dev-stack"
                style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {devDetails.stack}
              </pre>
            ) : null}
            {devDetails.componentStack ? (
              <pre
                className="system-page__dev-component-stack"
                data-testid="server-error-dev-component-stack"
                style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
              >
                {devDetails.componentStack}
              </pre>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
