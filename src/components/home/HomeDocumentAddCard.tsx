import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { DocumentAddActions } from '../documents/DocumentAddActions';

export function HomeDocumentAddCard() {
  const { translate } = useApp();

  return (
    <section className="mobile-home-card mobile-home-card--primary" data-testid="home-card-add-document">
      <Link to="/dokumente/hinzufuegen" className="mobile-home-card__link mobile-home-card__link--primary">
        <span className="mobile-home-card__emoji" aria-hidden>
          📥
        </span>
        <span className="mobile-home-card__title">{translate('mobile.home.addDocument')}</span>
        <span className="mobile-home-card__hint">{translate('mobile.home.addDocumentHint')}</span>
      </Link>
      <DocumentAddActions variant="inline" />
    </section>
  );
}
