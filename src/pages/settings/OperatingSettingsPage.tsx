import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Badge, PageHeader } from '../../components/ui/Card';
import { BackupExportPanel } from '../../components/settings/BackupExportPanel';
import { LanguageSwitcher } from '../../components/settings/LanguageSwitcher';
import { ChartOfAccountsSetting } from '../../components/accounting/ChartOfAccountsSetting';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { isSupabaseConfigured } from '../../lib/supabase';
import { BACKUP_SECTION_ID } from '../../services/backupSectionNavigation';
import { getSyncUiSnapshot, type SyncUiSnapshot } from '../../services/sync/syncUiService';
import { resolveWorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';
import type { TranslationKey } from '../../i18n';
import type { SyncState } from '../../types/sync';

/**
 * SETTINGS-01B5 — die Betriebsseite `/einstellungen/betrieb`.
 *
 * Betriebliche Einstellungen und Verwaltungswege, keine Rechnungsdaten:
 * Sprache, Datensicherung, Synchronisation, Verwaltung. Bewusst **kein**
 * gemeinsamer Speichern-Knopf — die Bausteine haben verschiedene
 * Persistenzmodelle und behalten sie: Die Sprache wirkt sofort
 * (`CompanySetup.language`, wie bisher), die Datensicherung ist eine Aktion,
 * Synchronisation und Benutzerverwaltung sind Verweise auf ihre bestehenden
 * Seiten. Keine zweite Sprach-, Backup- oder Sync-Engine.
 */
export const OPERATING_SETTINGS_ROUTE = '/einstellungen/betrieb';

/** Kanonischer Tiefenlink zur Datensicherung (ersetzt `/firmendaten#datensicherung`). */
export const OPERATING_SETTINGS_BACKUP_HREF = `${OPERATING_SETTINGS_ROUTE}#${BACKUP_SECTION_ID}`;

const SYNCING_STATES: SyncState[] = ['checking', 'uploading', 'downloading', 'merging'];

function syncTone(snapshot: SyncUiSnapshot): 'default' | 'success' | 'warning' | 'info' {
  if (snapshot.isOffline) return 'info';
  if (snapshot.status.syncState === 'synced') return 'success';
  if (snapshot.status.syncState === 'error') return 'warning';
  if (SYNCING_STATES.includes(snapshot.status.syncState)) return 'info';
  return 'default';
}

function formatTimestamp(value?: string): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleString('de-DE');
}

export function OperatingSettingsPage() {
  const { translate } = useApp();
  const { user, isAdmin } = useAuth();
  const location = useLocation();
  const [sync, setSync] = useState<SyncUiSnapshot>(() => getSyncUiSnapshot());

  const access = useMemo(
    () => resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: isSupabaseConfigured() }),
    [user?.id],
  );

  /* Der Status ist eine Momentaufnahme; beim Öffnen und bei Rückkehr in den Tab neu lesen. */
  useEffect(() => {
    const refresh = () => setSync(getSyncUiSnapshot());
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  /* `#datensicherung` — der bisherige Tiefenlink führt weiter direkt zum Backup. */
  useEffect(() => {
    if (location.hash.replace(/^#/, '') !== BACKUP_SECTION_ID) return;
    const frame = window.requestAnimationFrame(() => {
      const el = document.getElementById(BACKUP_SECTION_ID);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [location.hash, location.key]);

  const syncStatusKey = `sync.status.${sync.status.syncState}` as TranslationKey;

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-operating-page">
      <PageHeader
        title={translate('settings.operating.title')}
        subtitle={translate('settings.operating.page.subtitle')}
        backLabel={translate('settings.backToHub')}
        backHref="/einstellungen"
        backTestId="settings-operating-back"
      />

      {/* ---------------- Sprache ---------------- */}
      <section className="settings-form__section settings-operating__section" data-testid="settings-operating-language">
        <h2 className="settings-form__legend">{translate('settings.operating.section.language')}</h2>
        <p className="hint-text">{translate('settings.operating.language.hint')}</p>
        <LanguageSwitcher testId="settings-operating-language-switcher" />
      </section>

      {/* ---------------- Buchhaltung ---------------- */}
      {/*
        * STEUERBERATER-06A — der Kontenrahmen des Betriebs. Hier und nicht
        * bei den Rechnungen: Er betrifft Eingangsbelege genauso wie
        * Ausgangsrechnungen und ist eine Frage der Buchhaltung, nicht der
        * Rechnungsstellung.
        */}
      <section
        className="settings-form__section settings-operating__section"
        data-testid="settings-operating-accounting"
      >
        <h2 className="settings-form__legend">{translate('accounting.settings.section')}</h2>
        <p className="hint-text">{translate('accounting.settings.hint')}</p>
        <ChartOfAccountsSetting translate={translate} />
      </section>

      {/* ---------------- Datensicherung ---------------- */}
      <section className="settings-form__section settings-operating__section" data-testid="settings-operating-backup">
        <h2 className="settings-form__legend">{translate('settings.operating.section.backup')}</h2>
        <BackupExportPanel />
      </section>

      {/* ---------------- Synchronisation ---------------- */}
      <section className="settings-form__section settings-operating__section" data-testid="settings-operating-sync">
        <h2 className="settings-form__legend">{translate('settings.operating.section.sync')}</h2>
        <div className="data-row">
          <span className="data-row__label">{translate('sync.section.status')}</span>
          <span className="data-row__value" data-testid="settings-operating-sync-status">
            <Badge tone={syncTone(sync)}>{translate(syncStatusKey)}</Badge>
          </span>
        </div>
        <div className="data-row">
          <span className="data-row__label">{translate('sync.lastSync')}</span>
          <span className="data-row__value" data-testid="settings-operating-sync-last">{formatTimestamp(sync.status.lastSyncedAt)}</span>
        </div>
        <Link to="/synchronisation" className="btn btn--outline settings-operating__link" data-testid="settings-operating-sync-link">
          {translate('settings.operating.sync.manage')}
        </Link>
      </section>

      {/* ---------------- Verwaltung ---------------- */}
      <section className="settings-form__section settings-operating__section" data-testid="settings-operating-admin">
        <h2 className="settings-form__legend">{translate('settings.operating.section.admin')}</h2>
        {access.canWrite && access.reason !== 'local_only' ? (
          <p className="hint-text" data-testid="settings-operating-role">
            {translate('settings.operating.role.admin')}
          </p>
        ) : access.reason === 'member' ? (
          <p className="hint-text" data-testid="settings-operating-role">
            {translate('settings.operating.role.member')}
          </p>
        ) : null}
        {isAdmin ? (
          <Link to="/admin/users" className="btn btn--outline settings-operating__link" data-testid="settings-operating-users-link">
            {translate('settings.operating.admin.users')}
          </Link>
        ) : null}
        <Link to="/mehr" className="btn btn--ghost settings-operating__link" data-testid="settings-operating-more-link">
          {translate('settings.operating.admin.more')}
        </Link>
      </section>
    </div>
  );
}
