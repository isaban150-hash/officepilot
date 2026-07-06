import { useNavigate, Link } from 'react-router-dom';
import { Card } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import type { PendingItem } from '../../types/models';

interface HeuteOpenItemsProps {
  items: PendingItem[];
}

export function HeuteOpenItems({ items }: HeuteOpenItemsProps) {
  const { translate } = useApp();
  const navigate = useNavigate();

  if (items.length === 0) {
    return null;
  }

  return (
    <section className="heute-open-items" data-testid="heute-open-items">
      <div className="heute-open-items__header">
        <h2 className="heute-section-title">{translate('heute.openItemsTitle')}</h2>
        <Link to="/ablage" className="heute-open-items__link">
          {translate('heute.openItemsShowAll')}
        </Link>
      </div>
      <Card>
        <ul className="heute-open-items__list">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="heute-open-items__item"
                onClick={() => navigate(item.route)}
              >
                <span className="heute-open-items__item-title">{item.title}</span>
                {item.description && (
                  <span className="heute-open-items__item-desc">{item.description}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
