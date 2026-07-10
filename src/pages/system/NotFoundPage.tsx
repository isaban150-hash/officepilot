import { Link } from 'react-router-dom';
import { Button } from '../../components/ui/Button';

export function NotFoundPage() {
  return (
    <div className="system-page" data-testid="not-found-page">
      <div className="system-page__card">
        <p className="system-page__code">404</p>
        <h1 className="system-page__title">Seite nicht gefunden</h1>
        <p className="system-page__text">
          Die angeforderte Seite existiert nicht oder wurde verschoben.
        </p>
        <Link to="/">
          <Button fullWidth>Zur Startseite</Button>
        </Link>
      </div>
    </div>
  );
}
