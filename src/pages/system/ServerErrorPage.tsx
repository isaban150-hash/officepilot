import { Button } from '../../components/ui/Button';

interface ServerErrorPageProps {
  onRetry?: () => void;
}

export function ServerErrorPage({ onRetry }: ServerErrorPageProps) {
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
      </div>
    </div>
  );
}
