import { useEffect, useState, type FormEvent } from 'react';
import { SettingsAccessNotice } from '../../components/settings/SettingsAccessNotice';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { SettingsSaveBar } from '../../components/settings/SettingsSaveBar';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { isSupabaseConfigured } from '../../lib/supabase';
import { updateOwnProfile } from '../../services/auth/profileService';
import { listOwnMemberships, type OwnMembership } from '../../services/auth/accountService';
import type { TranslationKey } from '../../i18n';
import { SETTINGS_TARGET_PATHS, type SettingsTargetId } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP3; L1, K-01 bis K-05) — „Mein Konto“. Seit AP5 (Vertrag 1.15) in fünf Ziele aufgeteilt:
 *  - Profil (`/einstellungen/konto`, diese Seite): Name, Telefon, eigene Zustimmungen und Mitgliedschaften
 *  - Anmeldung und Sicherheit (`AccountSecurityPage`): E-Mail mit doppelter Bestätigung, Passwort
 *  - Sprache (`AccountLanguagePage`), Sitzungen (`AccountSessionsPage`), Konto löschen (`AccountDeletePage`)
 *
 * Alles hier betrifft nur die eigene Person (Ausnahme B): Es gibt keinen Firmen-Schreibauftrag, und die Seiten bleiben
 * auch im Nur-Lesen-Betrieb vollständig bedienbar (Z-08.4, K-04.2). Die AP3-Test-IDs bleiben auf den Unterseiten
 * erhalten. Im lokalen Betrieb ohne Cloud gibt es kein Benutzerkonto (1.16): Die Seiten zeigen dann nur den Hinweis.
 */
export const ACCOUNT_SETTINGS_ROUTE = SETTINGS_TARGET_PATHS.account;

export function formatAccountDate(value: string | undefined | null): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString('de-DE');
}

export type AccountInfo = { ok: boolean; key: TranslationKey } | null;

export function AccountInfoLine({ value, testId }: { value: AccountInfo; testId: string }) {
  const { translate } = useApp();
  if (!value) return null;
  return (
    <p className={value.ok ? 'auth-form__success' : 'auth-form__error'} role={value.ok ? 'status' : 'alert'} data-testid={testId}>
      {translate(value.key)}
    </p>
  );
}

/** Kontoziele ohne Cloud: nur der Hinweis (1.16). */
export function AccountLocalOnlyPage({ target, testId }: { target: SettingsTargetId; testId: string }) {
  return (
    <div className="page settings-page settings-subpage" data-testid={testId}>
      <SettingsPageHeader target={target} />
      <SettingsAccessNotice variant="localOnly" kind="hidden" testId={`${testId}-local-only`} />
    </div>
  );
}

export function AccountSettingsPage() {
  const { translate } = useApp();
  const { user, refreshAuth } = useAuth();

  const [firstName, setFirstName] = useState(user?.firstName ?? '');
  const [lastName, setLastName] = useState(user?.lastName ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [personalBusy, setPersonalBusy] = useState(false);
  const [personalInfo, setPersonalInfo] = useState<AccountInfo>(null);
  const [memberships, setMemberships] = useState<OwnMembership[] | null | 'loading'>('loading');

  useEffect(() => {
    if (!isSupabaseConfigured()) return undefined;
    let active = true;
    void listOwnMemberships().then((rows) => {
      if (active) setMemberships(rows);
    });
    return () => {
      active = false;
    };
  }, [user?.id]);

  if (!isSupabaseConfigured()) return <AccountLocalOnlyPage target="account" testId="settings-account-page" />;
  if (!user) return null;

  const dirty = firstName !== (user.firstName ?? '') || lastName !== (user.lastName ?? '') || phone !== (user.phone ?? '');

  const discard = () => {
    setFirstName(user.firstName ?? '');
    setLastName(user.lastName ?? '');
    setPhone(user.phone ?? '');
    setPersonalInfo(null);
  };

  const savePersonal = async (event: FormEvent) => {
    event.preventDefault();
    if (personalBusy) return;
    setPersonalBusy(true);
    setPersonalInfo(null);
    try {
      const result = await updateOwnProfile({
        companyName: user.companyName,
        firstName,
        lastName,
        phone,
        industry: user.industry,
      });
      if (!result.success) {
        // K-01.4 — kein Erfolg gemeldet; die Eingaben bleiben stehen.
        setPersonalInfo({ ok: false, key: 'account.saveFailed' });
        return;
      }
      await refreshAuth();
      setPersonalInfo({ ok: true, key: 'account.saved' });
    } catch {
      setPersonalInfo({ ok: false, key: 'account.saveFailed' });
    } finally {
      setPersonalBusy(false);
    }
  };

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-account-page">
      <SettingsPageHeader
        target="account"
        subtitle={translate('settings.account.profile.subtitle')}
        backTestId="settings-account-back"
      />

      <form className="settings-form__section" onSubmit={(event) => void savePersonal(event)} data-testid="account-personal">
        <h2 className="settings-form__legend">{translate('account.section.personal')}</h2>
        <label className="edit-field">
          <span className="edit-field__label">{translate('account.field.firstName')}</span>
          <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} maxLength={120} autoComplete="given-name" data-testid="account-first-name" />
        </label>
        <label className="edit-field">
          <span className="edit-field__label">{translate('account.field.lastName')}</span>
          <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} maxLength={120} autoComplete="family-name" data-testid="account-last-name" />
        </label>
        <label className="edit-field">
          <span className="edit-field__label">{translate('account.field.phone')}</span>
          <input className="input" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={60} autoComplete="tel" data-testid="account-phone" />
        </label>
        <AccountInfoLine value={personalInfo} testId="account-personal-info" />
        <SettingsSaveBar dirty={dirty} saving={personalBusy} onDiscard={discard} testIdPrefix="account-personal" />
      </form>

      <section className="settings-form__section" data-testid="account-consent">
        <h2 className="settings-form__legend">{translate('account.section.consent')}</h2>
        <div className="data-row">
          <span className="data-row__label">{translate('account.consent.terms')}</span>
          <span className="data-row__value">{user.acceptedTermsVersion ?? '—'}</span>
        </div>
        <div className="data-row">
          <span className="data-row__label">{translate('account.consent.privacy')}</span>
          <span className="data-row__value">{user.acceptedPrivacyVersion ?? '—'}</span>
        </div>
        <div className="data-row">
          <span className="data-row__label">{translate('account.consent.license')}</span>
          <span className="data-row__value">{user.acceptedLicenseVersion ?? '—'}</span>
        </div>
        <div className="data-row">
          <span className="data-row__label">{translate('account.consent.at')}</span>
          <span className="data-row__value" data-testid="account-consent-at">{formatAccountDate(user.legalAcceptedAt)}</span>
        </div>
      </section>

      <section className="settings-form__section" data-testid="account-memberships">
        <h2 className="settings-form__legend">{translate('account.section.memberships')}</h2>
        {memberships === 'loading' ? null : memberships === null ? (
          <p className="hint-text" data-testid="account-memberships-failed">{translate('account.memberships.failed')}</p>
        ) : memberships.length === 0 ? (
          <p className="hint-text" data-testid="account-memberships-empty">{translate('account.memberships.empty')}</p>
        ) : (
          memberships.map((row) => (
            <div className="data-row" key={row.workspaceId} data-testid={`account-membership-${row.workspaceId}`}>
              <span className="data-row__label">{row.workspaceName || '—'}</span>
              <span className="data-row__value">{translate(`account.role.${row.role}` as TranslationKey)}</span>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
