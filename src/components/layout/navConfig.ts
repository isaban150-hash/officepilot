import type { TranslationKey } from '../../i18n';
import type { NavIconId } from './NavIcon';

/**
 * UIUX-FOUNDATION-01C — eine zentrale, semantische Navigationsquelle.
 *
 * Aus `PRIMARY_NAV` werden Desktop-Sidebar (alle Hauptbereiche) und Mobile-
 * Bottom-Nav (die als `mobile` markierten + „Mehr“) abgeleitet. `SECONDARY_NAV`
 * speist die Sekundärzone der Sidebar und die gruppierte „Mehr“-Seite.
 * Nirgends sonst existiert eine zweite Liste von Navigationszielen.
 *
 * Routen bleiben die bestehenden technischen Pfade (`/ablage` = Eingang,
 * `/vorgaenge` = Aufträge, `/rechnungen/offen` = beste vorhandene
 * Rechnungsoberfläche) — keine kosmetischen URL-Änderungen.
 */
export interface NavItemConfig {
  to: string;
  key: TranslationKey;
  icon: NavIconId;
  end?: boolean;
  featured?: boolean;
  /** Erscheint in der mobilen Bottom-Navigation (max. 4 + „Mehr“). */
  mobile?: boolean;
  testId?: string;
}

export const FINANZEN_ROUTE = '/finanzen';
export const MEHR_ROUTE = '/mehr';
export const ASSISTENT_ROUTE = '/assistent';

/** Hauptbereiche in Produktreihenfolge. */
export const PRIMARY_NAV: readonly NavItemConfig[] = [
  { to: '/', key: 'nav.heute', icon: 'home', end: true, mobile: true, testId: 'home' },
  { to: '/ablage', key: 'nav.eingang', icon: 'inbox', mobile: true },
  { to: '/vorgaenge', key: 'nav.auftraege', icon: 'orders', mobile: true },
  { to: '/rechnungen/offen', key: 'nav.rechnungen', icon: 'invoice', mobile: true },
  { to: FINANZEN_ROUTE, key: 'nav.finanzen', icon: 'finance' },
  { to: '/dokumente', key: 'nav.dokumente', icon: 'folder' },
];

const MEHR_ITEM: NavItemConfig = { to: MEHR_ROUTE, key: 'nav.mehr', icon: 'more', mobile: true };

export interface NavGroupConfig {
  id: string;
  titleKey: TranslationKey;
  items: readonly NavSecondaryItemConfig[];
}

export interface NavSecondaryItemConfig extends NavItemConfig {
  descriptionKey: TranslationKey;
  /** Nur mit bestehender Admin-Berechtigung sichtbar (`useAuth().isAdmin`). */
  adminOnly?: boolean;
  /** In der Desktop-Sidebar-Sekundärzone anzeigen. */
  sidebar?: boolean;
}

/**
 * Sekundäre Ziele, gruppiert. Jede Route existiert bereits in App.tsx;
 * es werden keine neuen Funktionen verlinkt.
 *
 * Bewusst NICHT enthalten: Einstellungen (nur Zahnrad + Benutzermenü) und
 * der Assistent (nur das globale Header-Werkzeug) — keine Doppel-Einstiege.
 */
export const SECONDARY_NAV_GROUPS: readonly NavGroupConfig[] = [
  {
    id: 'work',
    titleKey: 'mehr.group.work',
    items: [
      { to: '/kunden', key: 'mehr.customers', descriptionKey: 'mehr.customersDesc', icon: 'customers', sidebar: true },
      { to: '/aufgaben', key: 'mehr.tasks', descriptionKey: 'mehr.tasksDesc', icon: 'tasks', sidebar: true },
      { to: '/schreiben', key: 'businessLetter.area.title', descriptionKey: 'businessLetter.area.subtitle', icon: 'documents', sidebar: true },
      { to: '/kommunikation', key: 'mehr.communication', descriptionKey: 'mehr.communicationDesc', icon: 'messages', sidebar: true },
      { to: '/mail-import', key: 'mehr.mailImport', descriptionKey: 'mehr.mailImportDesc', icon: 'inbox' },
    ],
  },
  {
    id: 'finance',
    titleKey: 'mehr.group.finance',
    items: [
      { to: FINANZEN_ROUTE, key: 'nav.finanzen', descriptionKey: 'mehr.financeDesc', icon: 'finance' },
      { to: '/dokumente', key: 'mehr.documents', descriptionKey: 'mehr.documentsDesc', icon: 'folder' },
      { to: '/papierarchiv', key: 'mehr.paperArchive', descriptionKey: 'mehr.paperArchiveDesc', icon: 'archive' },
    ],
  },
  {
    id: 'officepilot',
    titleKey: 'mehr.group.officepilot',
    items: [
      { to: '/wissen', key: 'mehr.knowledge', descriptionKey: 'mehr.knowledgeDesc', icon: 'knowledge', sidebar: true },
    ],
  },
  {
    id: 'system',
    titleKey: 'mehr.group.system',
    items: [
      { to: '/synchronisation', key: 'mehr.sync', descriptionKey: 'mehr.syncDesc', icon: 'more' },
      { to: '/admin/users', key: 'mehr.adminUsers', descriptionKey: 'mehr.adminUsersDesc', icon: 'customers', adminOnly: true },
    ],
  },
];

/**
 * Finanzen-Hub: reine Navigation zu bereits vorhandenen Finanzbereichen.
 * Keine Kennzahlen, keine Aggregation, keine neue Fachlogik.
 */
export const FINANZEN_HUB_GROUPS: readonly NavGroupConfig[] = [
  {
    id: 'expenses',
    titleKey: 'finanzen.group.expenses',
    items: [
      { to: '/ausgaben', key: 'finanzen.expenses', descriptionKey: 'finanzen.expensesDesc', icon: 'finance' },
      { to: '/ausgaben/offen', key: 'finanzen.openExpenses', descriptionKey: 'finanzen.openExpensesDesc', icon: 'tasks' },
    ],
  },
  {
    id: 'income',
    titleKey: 'finanzen.group.income',
    items: [
      { to: '/rechnungen/offen', key: 'finanzen.openInvoices', descriptionKey: 'finanzen.openInvoicesDesc', icon: 'invoice' },
    ],
  },
  {
    id: 'tax',
    titleKey: 'finanzen.group.tax',
    items: [
      { to: '/steuerberater', key: 'finanzen.steuerberater', descriptionKey: 'finanzen.steuerberaterDesc', icon: 'tax' },
    ],
  },
];

/** Desktop sidebar: alle Hauptbereiche. */
export const DESKTOP_NAV_ITEMS: NavItemConfig[] = [...PRIMARY_NAV];

/** Mobile bottom nav: exakt 5 — vier Hauptbereiche + „Mehr“. */
export const MOBILE_BOTTOM_NAV_ITEMS: NavItemConfig[] = [
  ...PRIMARY_NAV.filter((item) => item.mobile),
  MEHR_ITEM,
];

/** Sekundärzone der Desktop-Sidebar (flach, ohne Gruppentitel). */
export const DESKTOP_SECONDARY_NAV_ITEMS: NavSecondaryItemConfig[] = SECONDARY_NAV_GROUPS.flatMap((group) =>
  group.items.filter((item) => item.sidebar),
);

/** Sichtbare Gruppen für „Mehr“ nach bestehender Rollenlogik. */
export function resolveMehrGroups(input: { isAdmin: boolean }): NavGroupConfig[] {
  return SECONDARY_NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.adminOnly || input.isAdmin),
  })).filter((group) => group.items.length > 0);
}

export function navLinkTestId(item: NavItemConfig): string {
  return item.testId ?? item.to.replace(/^\//, '').replace(/\//g, '-');
}

/** @deprecated Use DESKTOP_NAV_ITEMS or MOBILE_BOTTOM_NAV_ITEMS */
export const MAIN_NAV_ITEMS = DESKTOP_NAV_ITEMS;
