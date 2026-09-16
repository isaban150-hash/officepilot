import { useApp } from '../../context/AppContext';
import type { TranslationKey } from '../../i18n';
import { RowList, RowListItem } from '../ui/Lists';
import { SectionHeader } from '../ui/Section';
import { NavIcon } from './NavIcon';
import type { NavGroupConfig, NavSecondaryItemConfig } from './navConfig';

/**
 * UIUX-FOUNDATION-01C/01D — gruppierte Navigationsliste.
 * Seit 01D auf den kanonischen Patterns `SectionHeader` + `RowList`
 * (vorher Settings-Row-Klassen). Wird von „Mehr“ und dem Finanzen-Hub
 * genutzt; rein navigierend.
 */
export function NavGroupList({ groups, testIdPrefix }: { groups: readonly NavGroupConfig[]; testIdPrefix: string }) {
  const { translate } = useApp();
  return (
    <>
      {groups.map((group) => (
        <section className="nav-group" key={group.id} data-testid={`${testIdPrefix}-group-${group.id}`}>
          <SectionHeader title={translate(group.titleKey)} level={2} className="nav-group__header" />
          <RowList>
            {group.items.map((item) => (
              <NavGroupRow key={item.to} item={item} testIdPrefix={testIdPrefix} />
            ))}
          </RowList>
        </section>
      ))}
    </>
  );
}

function NavGroupRow({ item, testIdPrefix }: { item: NavSecondaryItemConfig; testIdPrefix: string }) {
  const { translate } = useApp();
  const rowId = item.to.replace(/^\//, '').replace(/\//g, '-');
  return (
    <RowListItem
      to={item.to}
      icon={<NavIcon id={item.icon} />}
      title={translate(item.key as TranslationKey)}
      description={translate(item.descriptionKey)}
      testId={`${testIdPrefix}-link-${rowId}`}
      className="nav-group__row"
    />
  );
}
