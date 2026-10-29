import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AuthLayout } from '../../components/auth/AuthLayout';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { Button } from '../../components/ui/Button';
import { SimpleConfirmDialog } from '../../components/ui/SimpleConfirmDialog';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';
import { isSupabaseConfigured } from '../../lib/supabase';
import { failureText, type ShownFailure, type TranslationKey } from '../../i18n';
import { deleteOwnAccount, forgetAccountDeletionRequestId, type AccountDeletionResult } from '../../services/account/accountDeletionService';
import { assessAccountDeletionDeviceRisk, type AccountDeletionDeviceState } from '../../services/storage/deviceDataService';
import { removeLocalAccountData } from '../../services/storage/localAccountDataService';
import { AccountLocalOnlyPage } from './AccountSettingsPage';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP7; Verträge 1.25, 1.25a, 1.28; E11 a, E20) — „Mein Konto › Konto löschen“.
 *
 * Bestätigung: eigene Anmelde-E-Mail (der Server vergleicht sie normalisiert) und aktuelles Passwort für den
 * serverseitigen Nachweis; Rückfrage im Gefahrenstil. Das Passwort bleibt nur bis zum Absenden im Formular und wird
 * danach geleert. Inhaber eines Betriebs (auch ohne Mitglieder, auch bei abgelaufener Lizenz) werden mit Liste und Wegen
 * abgewiesen. Nach Erfolg — auch nach „wird abgeschlossen“ — verlässt die App das Konto lokal und entfernt die Daten
 * dieses Kontos von diesem Gerät (1.29).
 *
 * Abschluss 23 (Entscheidung zu Bericht 22): Liegen auf diesem Gerät Daten dieses Kontos, die nachweislich nicht in der
 * Cloud gesichert sind (oder sich nicht prüfen lassen), warnt die Seite deutlich vor dem unwiederbringlichen Verlust —
 * auch in der Rückfrage. Abschluss 24: Ist nichts Offenes erkannt, aber in dieser Sitzung kein Abgleich nachgewiesen,
 * steht nur ein sachlicher Hinweis mit dem Weg zur Prüfung (kein Datenverlust behauptet, nichts in der Rückfrage).
 * Gesperrt wird die Löschung nie. Geprüft und genannt werden nur Bestände dieses Kontos.
 */
export const ACCOUNT_DELETE_ROUTE = SETTINGS_TARGET_PATHS['account-delete'];

const FEHLER: Record<Exclude<Extract<AccountDeletionResult, { ok: false }>['reason'], 'owner'>, TranslationKey> = {
  password_invalid: 'destructive.error.password',
  rate_limited: 'destructive.error.rateLimited',
  email_mismatch: 'accountDelete.error.emailMismatch',
  last_platform_admin: 'accountDelete.error.lastAdmin',
  account_blocked: 'destructive.error.blocked',
  confirmation_invalid: 'destructive.error.confirmation',
  session: 'destructive.error.session',
  request_mismatch: 'accountDelete.error.requestMismatch',
  unavailable: 'destructive.error.unavailable',
};

export function AccountDeleteForm({ testIdPrefix = 'account-delete' }: { testIdPrefix?: string }) {
  const { translate, language } = useApp();
  const { user, logoutAfterAccountDeletion } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ShownFailure | null>(null);
  const [owned, setOwned] = useState<Array<{ id: string; name: string }> | null>(null);
  const [done, setDone] = useState<'completed' | 'completing' | null>(null);
  const submitRef = useRef<HTMLButtonElement | null>(null);
  // EINRICHTUNG-01 (AP8; 1.27) — begonnene Eingaben schützen vor dem Verlassen (Passwörter nie als Entwurf).
  useLeaveGuard(!done && (email.trim() !== '' || password !== ''), false);
  const [geraeteStand, setGeraeteStand] = useState<AccountDeletionDeviceState>({ risiko: [], unklar: [] });
  const geraeteRisiko = geraeteStand.risiko;
  const kontoId = user?.id ?? null;
  useEffect(() => {
    if (!kontoId) return undefined;
    let aktiv = true;
    void assessAccountDeletionDeviceRisk(kontoId)
      .then((risiko) => {
        if (aktiv) setGeraeteStand(risiko);
      })
      .catch(() => undefined);
    return () => {
      aktiv = false;
    };
  }, [kontoId]);

  if (!user) return null;
  const userId = user.id;
  const ready = email.trim().length > 0 && password.length > 0 && !busy && !done;

  const runDelete = async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setOwned(null);
    const passwort = password;
    setPassword('');
    try {
      const result = await deleteOwnAccount({ userId, email: email.trim(), password: passwort });
      if (result.ok) {
        setDone(result.state);
        setDialogOpen(false);
        forgetAccountDeletionRequestId(userId);
        // 1.25 — lokal abmelden (Hinweis auf der Anmeldeseite), dann die Daten dieses Kontos von diesem Gerät entfernen.
        await logoutAfterAccountDeletion();
        await removeLocalAccountData(userId).catch(() => undefined);
        return true;
      }
      if (result.reason === 'owner') {
        setOwned(result.workspaces);
      } else {
        setError({ errorKey: FEHLER[result.reason], ref: result.ref });
      }
      setDialogOpen(false);
      return true;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-form__section" data-testid={`${testIdPrefix}-section`}>
      <p className="hint-text">{translate('accountDelete.intro')}</p>
      <p className="hint-text">{translate('accountDelete.ownerHint')}</p>
      {done ? (
        <p className="auth-form__success" role="status" data-testid={`${testIdPrefix}-result`} data-state={done}>
          {translate(done === 'completed' ? 'accountDelete.result.completed' : 'accountDelete.result.completing')}
        </p>
      ) : null}
      {geraeteRisiko.length > 0 && !done ? (
        <div className="auth-form__error" role="alert" data-testid={`${testIdPrefix}-device-warning`}>
          <p>
            <strong>{translate('accountDelete.deviceWarning.title')}</strong>
          </p>
          <p>{translate('accountDelete.deviceWarning.text')}</p>
          <ul className="hint-list">
            {geraeteRisiko.map((area) => (
              <li key={area.storageKey} data-testid={`${testIdPrefix}-device-warning-${area.workspaceId ?? 'account'}`}>
                {area.workspaceId === null ? translate('accountDelete.deviceWarning.accountArea') : area.name || '—'}
              </li>
            ))}
          </ul>
          <p>
            <Link to={SETTINGS_TARGET_PATHS.sync} data-testid={`${testIdPrefix}-device-warning-sync`}>{translate('accountDelete.deviceWarning.sync')}</Link>
          </p>
        </div>
      ) : null}
      {geraeteRisiko.length === 0 && geraeteStand.unklar.length > 0 && !done ? (
        <p className="hint-text" role="note" data-testid={`${testIdPrefix}-device-note`}>
          {translate('accountDelete.deviceNote.text')}{' '}
          <Link to={SETTINGS_TARGET_PATHS.device} data-testid={`${testIdPrefix}-device-note-link`}>{translate('accountDelete.deviceNote.link')}</Link>
        </p>
      ) : null}
      {owned ? (
        <div className="auth-form__error" role="alert" data-testid={`${testIdPrefix}-owner`}>
          <p>{translate('accountDelete.error.owner').replace('{list}', owned.map((w) => w.name || '—').join(', '))}</p>
          <p>
            <Link to={SETTINGS_TARGET_PATHS['team-members']} data-testid={`${testIdPrefix}-owner-transfer`}>{translate('accountDelete.error.ownerTransfer')}</Link>
            {' · '}
            <Link to={SETTINGS_TARGET_PATHS['workspace-delete']} data-testid={`${testIdPrefix}-owner-delete`}>{translate('accountDelete.error.ownerDelete')}</Link>
          </p>
        </div>
      ) : null}
      {error ? (
        <p className="auth-form__error" role="alert" data-testid={`${testIdPrefix}-error`}>{failureText(language, error)}</p>
      ) : null}
      <div className="settings-form__field">
        <label htmlFor={`${testIdPrefix}-email`}>{translate('accountDelete.email.label')}</label>
        <input
          id={`${testIdPrefix}-email`}
          className="input"
          type="email"
          autoComplete="email"
          value={email}
          disabled={busy || Boolean(done)}
          onChange={(event) => setEmail(event.target.value)}
          data-testid={`${testIdPrefix}-email`}
        />
      </div>
      <div className="settings-form__field">
        <label htmlFor={`${testIdPrefix}-password`}>{translate('destructive.password.label')}</label>
        <input
          id={`${testIdPrefix}-password`}
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          disabled={busy || Boolean(done)}
          onChange={(event) => setPassword(event.target.value)}
          data-testid={`${testIdPrefix}-password`}
        />
        <p className="form-hint">{translate('destructive.password.hint')}</p>
      </div>
      <div className="form-actions">
        <Button
          ref={submitRef}
          type="button"
          variant="danger"
          disabled={!ready}
          loading={busy}
          onClick={() => setDialogOpen(true)}
          data-testid={`${testIdPrefix}-submit`}
        >
          {translate('accountDelete.submit')}
        </Button>
      </div>
      <SimpleConfirmDialog
        open={dialogOpen}
        title={translate('accountDelete.dialog.title')}
        message={geraeteRisiko.length > 0 ? `${translate('accountDelete.dialog.text')} ${translate('accountDelete.deviceWarning.dialog')}` : translate('accountDelete.dialog.text')}
        confirmLabel={translate('accountDelete.submit')}
        cancelLabel={translate('common.cancel')}
        confirmVariant="danger"
        confirmTestId={`${testIdPrefix}-confirm`}
        cancelTestId={`${testIdPrefix}-cancel`}
        dialogTestId={`${testIdPrefix}-dialog`}
        returnFocusRef={submitRef}
        onConfirm={runDelete}
        onCancel={() => setDialogOpen(false)}
      />
    </section>
  );
}

export function AccountDeletePage() {
  const { translate } = useApp();
  if (!isSupabaseConfigured()) {
    return <AccountLocalOnlyPage target="account-delete" testId="settings-account-delete-page" />;
  }
  return (
    <div className="page settings-page settings-subpage" data-testid="settings-account-delete-page">
      <SettingsPageHeader target="account-delete" subtitle={translate('accountDelete.subtitle')} />
      <AccountDeleteForm />
    </div>
  );
}

/** EINRICHTUNG-01 (AP7; 1.25, L-01.6) — Kontolöschung von der Warteseite; die Route liegt nur bei den Warte-Routen. */
export const WAITING_ACCOUNT_DELETE_ROUTE = '/waiting-approval/konto-loeschen';

/**
 * Ein wartendes Konto löscht sich selbst mit demselben Formular und Nachweis (1.25a). Die Seite steht außerhalb der
 * App-Hülle: kein Betrieb, keine Geschäftsdaten, kein Weg dorthin (K1).
 */
export function WaitingAccountDeletePage() {
  const { translate } = useApp();
  return (
    <AuthLayout title={translate('accountDelete.waiting.title')} subtitle={translate('accountDelete.subtitle')} testId="waiting-account-delete-page">
      <AccountDeleteForm testIdPrefix="waiting-account-delete" />
      <p className="auth-form__links">
        <Link to="/waiting-approval" data-testid="waiting-account-delete-back">{translate('accountDelete.waiting.back')}</Link>
      </p>
    </AuthLayout>
  );
}
