import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { DocumentAddActions } from '../documents/DocumentAddActions';
import { NavIcon } from '../layout/NavIcon';

export function HomeDocumentAddCard() {
  const { translate } = useApp();

  return (
    <section className="mobile-home-card mobile-home-card--primary" data-testid="home-card-add-document">
      <Link to="/dokumente/hinzufuegen" className="mobile-home-card__link mobile-home-card__link--primary">
        <NavIcon id="documents" className="mobile-home-card__icon" />
        <span className="mobile-home-card__title">{translate('mobile.home.addDocument')}</span>
        <span className="mobile-home-card__hint">{translate('mobile.home.addDocumentHint')}</span>
      </Link>
      <DocumentAddActions variant="inline" />
    </section>
  );
}
