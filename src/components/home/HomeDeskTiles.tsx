import { Link } from 'react-router-dom';
import { useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import type { TranslationKey } from '../../i18n';

export interface DeskTileConfig {
  id: string;
  emoji: string;
  titleKey: TranslationKey;
  descKey: TranslationKey;
  route: string;
}

const DESK_TILES: DeskTileConfig[] = [
  {
    id: 'documents',
    emoji: '📥',
    titleKey: 'home.tile.documents.title',
    descKey: 'home.tile.documents.desc',
    route: '/ablage',
  },
  {
    id: 'orders',
    emoji: '📂',
    titleKey: 'home.tile.orders.title',
    descKey: 'home.tile.orders.desc',
    route: '/vorgaenge',
  },
  {
    id: 'assistant',
    emoji: '🤖',
    titleKey: 'home.tile.assistant.title',
    descKey: 'home.tile.assistant.desc',
    route: '/assistent',
  },
  {
    id: 'customers',
    emoji: '👥',
    titleKey: 'home.tile.customers.title',
    descKey: 'home.tile.customers.desc',
    route: '/kunden',
  },
  {
    id: 'tax',
    emoji: '🧾',
    titleKey: 'home.tile.tax.title',
    descKey: 'home.tile.tax.desc',
    route: '/steuerberater',
  },
  {
    id: 'more',
    emoji: '⚙️',
    titleKey: 'home.tile.more.title',
    descKey: 'home.tile.more.desc',
    route: '/mehr',
  },
];

export function HomeDeskTiles() {
  const { translate } = useApp();
  const tiles = useMemo(() => DESK_TILES, []);

  return (
    <section className="home-desk-tiles" data-testid="home-desk-tiles">
      <h2 className="home-desk-tiles__title">{translate('home.tilesTitle')}</h2>
      <div className="home-desk-tiles__grid">
        {tiles.map((tile) => (
          <Link
            key={tile.id}
            to={tile.route}
            className="home-desk-tile"
            data-testid={`home-tile-${tile.id}`}
          >
            <span className="home-desk-tile__emoji" aria-hidden>
              {tile.emoji}
            </span>
            <span className="home-desk-tile__title">{translate(tile.titleKey)}</span>
            <span className="home-desk-tile__desc">{translate(tile.descKey)}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
