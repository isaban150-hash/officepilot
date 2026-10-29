import { Link } from 'react-router-dom';
import { useOptionalApp } from '../../context/AppContext';
import { t, type TranslationKey } from '../../i18n';

/**
 * EINRICHTUNG-01 (AP9-Nacharbeit; 1.14, 1.31–1.33) — B2-Fehlerseite: übersetzt und mit genau einem Bedienelement
 * (Link im Knopfstil, mindestens 44 px; vorher ein Knopf innerhalb eines Links, zwei Tabulatorstopps, Link 19 px hoch).
 */
export function NotFoundPage() {
  // Wie ReplyToConfirmPage: in der App deren Sprache, ohne App-Rahmen (z. B. im Test) Deutsch.
  const app = useOptionalApp();
  const translate = (key: TranslationKey) => (app ? app.translate(key) : t(key, 'de'));
  return (
    <div className="system-page" data-testid="not-found-page">
      <div className="system-page__card">
        <p className="system-page__code">404</p>
        <h1 className="system-page__title">{translate('notFound.title')}</h1>
        <p className="system-page__text">{translate('notFound.text')}</p>
        <Link to="/" className="btn btn--primary btn--full" data-testid="not-found-home">
          {translate('notFound.home')}
        </Link>
      </div>
    </div>
  );
}
