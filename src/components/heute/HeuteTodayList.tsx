import { useNavigate } from 'react-router-dom';
import { Card, CardTitle } from '../ui/Card';
import { useApp } from '../../context/AppContext';
import type { PendingItem } from '../../types/models';

interface HeuteTodayListProps {
  items: PendingItem[];
}

export function HeuteTodayList({ items }: HeuteTodayListProps) {
  const { translate } = useApp();
  const navigate = useNavigate();

  if (items.length === 0) {
    return (
      <Card className="heute-today-list" data-testid="heute-today-list">
        <CardTitle>{translate('heute.listTitle')}</CardTitle>
        <p className="empty-state">{translate('heute.listEmpty')}</p>
      </Card>
    );
  }

  return (
    <Card className="heute-today-list" data-testid="heute-today-list">
      <CardTitle>{translate('heute.listTitle')}</CardTitle>
      <ul className="heute-today-list__items">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="heute-today-list__item"
              onClick={() => navigate(item.route)}
            >
              <span className="heute-today-list__item-title">{item.title}</span>
              {item.description && (
                <span className="heute-today-list__item-desc">{item.description}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
