import type { TranslationKey } from '../../i18n';

/**
 * EINRICHTUNG-01 (AP5; Vertrag 1.15, 1.16) — die eine Quelle für die Zielstruktur der Einstellungen.
 *
 * Gruppen, Ziele, Adressen, Namen und Sichtbarkeit stehen nur hier. Der Hub (`EinstellungenPage`), die Seitentitel
 * der Unterseiten und die Tests lesen diese Liste; nirgends sonst gibt es eine zweite Aufzählung. Jedes Ziel hat genau
 * einen Eintrag und einen Übersetzungsschlüssel: Hub-Eintrag und Seitentitel nutzen `titleKey`, der Rückweg führt mit
 * „Zu den Einstellungen“ in den Hub.
 *
 * Die Sichtbarkeit ist eine Komfortregel der Oberfläche. Der Server prüft jede Aktion selbst; eine direkt aufgerufene
 * Adresse ohne Recht zeigt den einheitlichen Hinweis (`SettingsAccessNotice`).
 */

export const SETTINGS_HUB_ROUTE = '/einstellungen';

export const SETTINGS_TARGET_PATHS = {
  account: '/einstellungen/konto',
  'account-security': '/einstellungen/konto/sicherheit',
  'account-language': '/einstellungen/konto/sprache',
  'account-sessions': '/einstellungen/konto/sitzungen',
  'account-delete': '/einstellungen/konto/loeschen',
  'company-profile': '/einstellungen/firma',
  logo: '/einstellungen/design',
  'team-members': '/einstellungen/team',
  'workspace-delete': '/einstellungen/betrieb/loeschen',
  invoices: '/einstellungen/rechnungen',
  offers: '/einstellungen/angebote',
  letters: '/einstellungen/briefe',
  'number-ranges': '/einstellungen/nummernkreise',
  communication: '/einstellungen/kommunikation',
  mailbox: '/einstellungen/postfach',
  'chart-of-accounts': '/einstellungen/kontenrahmen',
  backup: '/einstellungen/daten/sicherung',
  export: '/einstellungen/daten/export',
  device: '/einstellungen/daten/geraet',
  sync: '/synchronisation',
  imprint: '/impressum',
  privacy: '/datenschutz',
  terms: '/agb',
  license: '/lizenzbedingungen',
  version: '/einstellungen/version',
} as const;

export type SettingsTargetId = keyof typeof SETTINGS_TARGET_PATHS;

/** Alte Adresse der aufgelösten Seite „Betrieb“ (1.15) — leitet in den Hub. */
export const LEGACY_OPERATING_SETTINGS_ROUTE = '/einstellungen/betrieb';

/**
 * Wer ein Ziel im Hub sieht (1.15, 1.16):
 *  - `account`      jedes angemeldete Konto; nicht im lokalen Betrieb ohne Cloud
 *  - `account-or-local` jedes angemeldete Konto; im lokalen Betrieb ebenfalls (Sprache: dort Einstellung dieser
 *                   Einrichtung auf diesem Gerät, sonst wäre sie lokal nicht mehr erreichbar — dokumentierte Abweichung
 *                   von 1.16, Bericht 13)
 *  - `every-role`   jede Rolle im Betrieb; nicht im lokalen Betrieb
 *  - `owner`        nur der Inhaber; nicht im lokalen Betrieb
 *  - `owner-admin`  Inhaber und Admins; im lokalen Betrieb ebenfalls
 *  - `owner-admin-cloud` Inhaber und Admins; nicht im lokalen Betrieb
 *  - `everyone`     alle, auch im lokalen Betrieb
 */
export type SettingsAudience =
  | 'account'
  | 'account-or-local'
  | 'every-role'
  | 'owner'
  | 'owner-admin'
  | 'owner-admin-cloud'
  | 'everyone';

export type SettingsIconId =
  | 'user'
  | 'lock'
  | 'language'
  | 'sessions'
  | 'trash'
  | 'company'
  | 'design'
  | 'users'
  | 'invoice'
  | 'offer'
  | 'letter'
  | 'numbers'
  | 'communication'
  | 'mailbox'
  | 'accounting'
  | 'backup'
  | 'export'
  | 'device'
  | 'sync'
  | 'legal'
  | 'info';

export interface SettingsTargetConfig {
  id: SettingsTargetId;
  path: string;
  titleKey: TranslationKey;
  descriptionKey: TranslationKey;
  icon: SettingsIconId;
  audience: SettingsAudience;
  /** Ziel liegt außerhalb des App-Rahmens (Rechtsseiten); der Link trägt den Rückweg in den Hub mit. */
  external?: boolean;
}

export type SettingsGroupId = 'account' | 'workspace' | 'documents' | 'communication' | 'accounting' | 'data' | 'help';

export interface SettingsGroupConfig {
  id: SettingsGroupId;
  titleKey: TranslationKey;
  targets: readonly SettingsTargetConfig[];
}

function target(
  id: SettingsTargetId,
  icon: SettingsIconId,
  audience: SettingsAudience,
  extra: Partial<Pick<SettingsTargetConfig, 'external'>> = {},
): SettingsTargetConfig {
  return {
    id,
    path: SETTINGS_TARGET_PATHS[id],
    titleKey: `settings.target.${id}.title` as TranslationKey,
    descriptionKey: `settings.target.${id}.description` as TranslationKey,
    icon,
    audience,
    ...extra,
  };
}

/** Zielstruktur 1.15 — Gruppen und Ziele in dieser Reihenfolge. */
export const SETTINGS_HUB_GROUPS: readonly SettingsGroupConfig[] = [
  {
    id: 'account',
    titleKey: 'settings.hub.group.account',
    targets: [
      target('account', 'user', 'account'),
      target('account-security', 'lock', 'account'),
      target('account-language', 'language', 'account-or-local'),
      target('account-sessions', 'sessions', 'account'),
      target('account-delete', 'trash', 'account'),
    ],
  },
  {
    id: 'workspace',
    titleKey: 'settings.hub.group.workspace',
    targets: [
      target('company-profile', 'company', 'owner-admin'),
      target('logo', 'design', 'owner-admin'),
      target('team-members', 'users', 'every-role'),
      target('workspace-delete', 'trash', 'owner'),
    ],
  },
  {
    id: 'documents',
    titleKey: 'settings.hub.group.documents',
    targets: [
      target('invoices', 'invoice', 'owner-admin'),
      target('offers', 'offer', 'owner-admin'),
      target('letters', 'letter', 'owner-admin'),
      target('number-ranges', 'numbers', 'owner-admin'),
    ],
  },
  {
    id: 'communication',
    titleKey: 'settings.hub.group.communication',
    targets: [
      target('communication', 'communication', 'owner-admin'),
      target('mailbox', 'mailbox', 'owner-admin-cloud'),
    ],
  },
  {
    id: 'accounting',
    titleKey: 'settings.hub.group.accounting',
    targets: [target('chart-of-accounts', 'accounting', 'owner-admin')],
  },
  {
    id: 'data',
    titleKey: 'settings.hub.group.data',
    targets: [
      target('backup', 'backup', 'owner-admin'),
      target('export', 'export', 'owner-admin'),
      target('device', 'device', 'everyone'),
    ],
  },
  {
    id: 'help',
    titleKey: 'settings.hub.group.help',
    targets: [
      target('sync', 'sync', 'every-role'),
      target('imprint', 'legal', 'everyone', { external: true }),
      target('privacy', 'legal', 'everyone', { external: true }),
      target('terms', 'legal', 'everyone', { external: true }),
      target('license', 'legal', 'everyone', { external: true }),
      target('version', 'info', 'everyone'),
    ],
  },
];

export const SETTINGS_TARGETS: readonly SettingsTargetConfig[] = SETTINGS_HUB_GROUPS.flatMap((group) => group.targets);

export function getSettingsTarget(id: SettingsTargetId): SettingsTargetConfig {
  const found = SETTINGS_TARGETS.find((item) => item.id === id);
  if (!found) throw new Error(`Unbekanntes Einstellungsziel: ${id}`);
  return found;
}

/** Hub-Eintrag und Seitentitel nutzen denselben Schlüssel (1.15 „Ein Einstieg, ein Name“). */
export function settingsTargetTitleKey(id: SettingsTargetId): TranslationKey {
  return getSettingsTarget(id).titleKey;
}

/**
 * Wer den Hub ansieht. `role` ist die Rolle im aktiven Betrieb; in der Cloud bedeutet `null` „Rolle unbekannt“ und
 * zählt fail-closed wie ein Mitglied. `cloud` ist false im bewusst lokalen Betrieb ohne Server.
 */
export interface SettingsHubViewer {
  cloud: boolean;
  role: 'owner' | 'admin' | 'member' | null;
}

export function isSettingsTargetVisible(audience: SettingsAudience, viewer: SettingsHubViewer): boolean {
  if (!viewer.cloud) return audience === 'owner-admin' || audience === 'everyone' || audience === 'account-or-local';
  const manages = viewer.role === 'owner' || viewer.role === 'admin';
  switch (audience) {
    case 'account':
    case 'account-or-local':
    case 'every-role':
    case 'everyone':
      return true;
    case 'owner':
      return viewer.role === 'owner';
    case 'owner-admin':
    case 'owner-admin-cloud':
      return manages;
  }
}

/**
 * Sichtbare Gruppen für den Hub. Lizenz, Löschantrag, unbestätigte Rechte und Offline-Betrieb ändern die Auswahl nicht
 * (1.16, K7): Jede Rolle sieht genau ihre Ziele; die Seiten selbst zeigen den Nur-Lesen-Hinweis.
 */
export function resolveSettingsHubGroups(viewer: SettingsHubViewer): SettingsGroupConfig[] {
  return SETTINGS_HUB_GROUPS.map((group) => ({
    ...group,
    targets: group.targets.filter((item) => isSettingsTargetVisible(item.audience, viewer)),
  })).filter((group) => group.targets.length > 0);
}

/** Navigationszustand der Hub-Links auf Rechtsseiten: Dort führt „Zurück“ wieder in den Hub. */
export interface SettingsReturnState {
  settingsReturn: typeof SETTINGS_HUB_ROUTE;
}

export const SETTINGS_RETURN_STATE: SettingsReturnState = Object.freeze({ settingsReturn: SETTINGS_HUB_ROUTE });

export function isSettingsReturnState(value: unknown): value is SettingsReturnState {
  return Boolean(
    value && typeof value === 'object' && (value as { settingsReturn?: unknown }).settingsReturn === SETTINGS_HUB_ROUTE,
  );
}
