import { Button } from '../../components/ui/Button';

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

export function ServerErrorPage({ onRetry, devDetails }: ServerErrorPageProps) {
  const showDevDetails = Boolean(import.meta.env.DEV && devDetails);

  return (
    <div className="system-page" data-testid="server-error-page">
      <div className="system-page__card">
        <p className="system-page__code">500</p>
        <h1 className="system-page__title">Etwas ist schiefgelaufen</h1>
        <p className="system-page__text">
          Die Anwendung ist vorübergehend nicht verfügbar. Bitte laden Sie die Seite neu.
        </p>
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
          Erneut versuchen
        </Button>

        {showDevDetails && devDetails ? (
          <section className="system-page__dev" data-testid="server-error-dev-details">
            <h2 className="system-page__dev-title">Technische Details</h2>
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
