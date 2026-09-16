import { useApp } from '../../context/AppContext';
import { RowList, RowListItem } from '../ui/Lists';
import { NavIcon } from '../layout/NavIcon';

/** UIUX-FOUNDATION-01E — „Mehr“ als Zeile statt Kachel. */
export function HomeMoreCard() {
  const { translate } = useApp();
  return (
    <RowList>
      <RowListItem
        to="/mehr"
        icon={<NavIcon id="more" />}
        title={translate('mobile.home.moreTitle')}
        description={translate('mobile.home.moreDesc')}
        testId="home-card-more"
      />
    </RowList>
  );
}
