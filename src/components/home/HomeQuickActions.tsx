import { Link } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { DOCUMENT_ADD_ACTIONS } from '../documents/DocumentAddActions';
import { Icon } from '../ui/Icon';

/**
 * VISUAL-POLISH-01B — „Schnell erledigen": die vier Aufnahmewege als kompakte
 * Symbol-/Textaktionen in einer Zeile (Teal-Icon, Ghost-Optik). Keine graue
 * Kachelleiste, keine Karte in der Karte. Routen unverändert.
 */
export function HomeQuickActions() {
  const { translate } = useApp();
  return (
    <section className="home-quick-add quick-actions" data-testid="home-quick-add" aria-label={translate('mobile.home.addDocument')}>
      <ul className="quick-actions__list">
        {DOCUMENT_ADD_ACTIONS.map((action) => (
          <li key={action.id} className="quick-actions__item">
            <Link to={action.route} className="quick-actions__link" data-testid={`home-quick-${action.id}`}>
              <span className="quick-actions__icon" aria-hidden>
                <Icon id={action.icon} size="md" />
              </span>
              <span className="quick-actions__label">{translate(action.titleKey)}</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="quick-actions__hint">{translate('mobile.home.addDocumentHint')}</p>
    </section>
  );
}
