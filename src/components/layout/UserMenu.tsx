import { useMemo } from 'react';
import { DropdownMenu, type DropdownMenuItem } from '../ui/DropdownMenu';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';

function ChevronDownIcon() {
  return (
    <svg className="user-menu__chevron" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 10.939l3.71-3.71a.75.75 0 111.06 1.061l-4.24 4.25a.75.75 0 01-1.06 0l-4.24-4.25a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}

export function UserMenu() {
  const { translate } = useApp();
  const { user, logout, isAdmin } = useAuth();

  const displayName = user ? `${user.firstName} ${user.lastName}`.trim() : 'Benutzer';

  const items = useMemo((): DropdownMenuItem[] => {
    const menuItems: DropdownMenuItem[] = [
      {
        id: 'company',
        label: translate('companyProfile.shortLink'),
        href: '/firmendaten',
        testId: 'user-menu-company',
      },
      {
        id: 'settings',
        label: translate('mehr.title'),
        href: '/mehr',
        testId: 'user-menu-settings',
      },
    ];

    if (isAdmin) {
      menuItems.push({
        id: 'admin',
        label: 'Admin',
        href: '/admin/users',
        testId: 'user-menu-admin',
      });
    }

    menuItems.push({
      id: 'logout',
      label: 'Abmelden',
      destructive: true,
      onSelect: logout,
      testId: 'logout-button',
    });

    return menuItems;
  }, [isAdmin, logout, translate]);

  if (!user) return null;

  return (
    <div className="user-menu" data-testid="user-menu">
      <DropdownMenu
        testId="user-menu-dropdown"
        ariaLabel="Benutzermenü"
        align="end"
        trigger={
          <>
            <span className="user-menu__name" data-testid="app-shell-user">
              {displayName}
            </span>
            <ChevronDownIcon />
          </>
        }
        items={items}
      />
    </div>
  );
}
