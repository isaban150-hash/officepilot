import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { SettingsAccessNotice } from '../../components/settings/SettingsAccessNotice';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { Button } from '../../components/ui/Button';
import { SimpleConfirmDialog } from '../../components/ui/SimpleConfirmDialog';
import { useApp } from '../../context/AppContext';
import { formatDeletionDate, useWorkspaceDeletionInfo } from '../../hooks/useWorkspaceDeletionInfo';
import { useSettingsAccess } from '../../hooks/useSettingsAccess';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';
import { isSupabaseConfigured } from '../../lib/supabase';
import { failureText, type ShownFailure, type TranslationKey } from '../../i18n';
import { newRequestId } from '../../services/account/destructiveActionService';
import { getWorkspaceStoreSnapshot } from '../../services/workspace/workspaceStore';
import {
  requestWorkspaceDeletion,
  revokeWorkspaceDeletion,
  type WorkspaceDeletionRequestResult,
  type WorkspaceDeletionRevokeResult,
} from '../../services/workspace/workspaceDeletionService';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';

/**
 * EINRICHTUNG-01 (AP7; Verträge 1.26, 1.25a, 1.28; E11 b, E19, K1, K3) — „Betrieb › Betrieb löschen“.
 *
 * Nur der Inhaber (auch bei nicht wirksamer Lizenz, E19). Antragsseite: Export-Hinweis mit Link, Aufbewahrungshinweis
 * mit Ankreuzfeld, Folgen, genauer Firmenname und aktuelles Passwort für den serverseitigen Nachweis; Rückfrage im
 * Gefahrenstil. Die 30-Tage-Frist erscheint nicht als Erfüllung gesetzlicher Aufbewahrungsfristen. Ist die Löschung
 * beantragt: Stand mit Datum und Widerruf (nur im Zustand „beantragt“).
 */
export const WORKSPACE_DELETE_ROUTE = SETTINGS_TARGET_PATHS['workspace-delete'];

const ANTRAG_FEHLER: Record<Extract<WorkspaceDeletionRequestResult, { ok: false }>['reason'], TranslationKey> = {
  password_invalid: 'destructive.error.password',
  rate_limited: 'destructive.error.rateLimited',
  name_mismatch: 'workspaceDelete.error.name',
  notice_outdated: 'workspaceDelete.error.notice',
  forbidden: 'workspaceDelete.error.forbidden',
  confirmation_invalid: 'destructive.error.confirmation',
  session: 'destructive.error.session',
  unavailable: 'destructive.error.unavailable',
};

const WIDERRUF_FEHLER: Record<Extract<WorkspaceDeletionRevokeResult, { ok: false }>['reason'], TranslationKey> = {
  in_progress: 'workspaceDelete.error.inProgress',
  not_requested: 'destructive.error.unavailable',
  forbidden: 'workspaceDelete.error.forbidden',
  session: 'destructive.error.session',
  unavailable: 'destructive.error.unavailable',
};

export function WorkspaceDeletePage() {
  const { translate, language } = useApp();
  const { isOwner, access } = useSettingsAccess();
  const deletion = useWorkspaceDeletionInfo();
  const workspace = getWorkspaceStoreSnapshot();
  const workspaceName = workspace?.name ?? '';
  const [confirmed, setConfirmed] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ShownFailure | null>(null);
  const [info, setInfo] = useState<TranslationKey | null>(null);
  const [dialog, setDialog] = useState<'request' | 'revoke' | null>(null);
  const requestIdRef = useRef<string>(newRequestId());
  const submitRef = useRef<HTMLButtonElement | null>(null);
  // EINRICHTUNG-01 (AP8; 1.27) — begonnene Eingaben schützen vor dem Verlassen (Passwörter nie als Entwurf).
  useLeaveGuard(!deletion.pending && (confirmed || typedName.trim() !== '' || password !== ''), false);

  if (!isSupabaseConfigured() || access.reason === 'local_only') {
    return (
      <div className="page settings-page settings-subpage" data-testid="settings-workspace-delete-page">
        <SettingsPageHeader target="workspace-delete" subtitle={translate('workspaceDelete.subtitle')} />
        <p className="hint-text" data-testid="settings-workspace-delete-local">{translate('workspaceDelete.localOnly')}</p>
      </div>
    );
  }
  if (!isOwner || !workspace) {
    return (
      <div className="page settings-page settings-subpage" data-testid="settings-workspace-delete-page">
        <SettingsPageHeader target="workspace-delete" subtitle={translate('workspaceDelete.subtitle')} />
        <SettingsAccessNotice variant="role" kind="ownerOnly" testId="settings-workspace-delete-not-allowed" />
      </div>
    );
  }

  const ready = confirmed && typedName.trim().length > 0 && password.length > 0 && !busy;

  const runRequest = async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setInfo(null);
    const passwort = password;
    setPassword('');
    try {
      const result = await requestWorkspaceDeletion({ workspaceId: workspace.id, typedName, password: passwort, requestId: requestIdRef.current });
      setDialog(null);
      if (result.ok) {
        setInfo('workspaceDelete.requested');
        requestIdRef.current = newRequestId();
      } else {
        setError({ errorKey: ANTRAG_FEHLER[result.reason], ref: result.ref });
        // Ein neuer Nachweis gehört zu einer neuen Anfrage; ein fachlich abgewiesener Antrag darf erneut versucht werden.
        if (result.reason !== 'unavailable') requestIdRef.current = newRequestId();
      }
      return true;
    } finally {
      setBusy(false);
    }
  };

  const runRevoke = async (): Promise<boolean> => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const result = await revokeWorkspaceDeletion(workspace.id);
      setDialog(null);
      if (result.ok) setInfo('workspaceDelete.revoked');
      else setError({ errorKey: WIDERRUF_FEHLER[result.reason], ref: result.ref });
      return true;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-workspace-delete-page">
      <SettingsPageHeader target="workspace-delete" subtitle={translate('workspaceDelete.subtitle')} />
      {info ? (
        <p className="auth-form__success" role="status" data-testid="settings-workspace-delete-info">{translate(info)}</p>
      ) : null}
      {error ? (
        <p className="auth-form__error" role="alert" data-testid="settings-workspace-delete-error">{failureText(language, error)}</p>
      ) : null}

      {deletion.pending ? (
        <section className="settings-form__section" data-testid="settings-workspace-delete-status" data-state={deletion.inProgress ? 'deleting' : 'open'}>
          <p className="hint-text">
            {deletion.inProgress
              ? translate('workspaceDelete.status.deleting')
              : translate('workspaceDelete.status.open').replace('{date}', formatDeletionDate(deletion.executeAfter, language))}
          </p>
          {!deletion.inProgress ? (
            <div className="form-actions">
              <Button type="button" variant="outline" disabled={busy} onClick={() => setDialog('revoke')} data-testid="settings-workspace-delete-revoke">
                {translate('workspaceDelete.revoke')}
              </Button>
            </div>
          ) : null}
        </section>
      ) : (
        <section className="settings-form__section" data-testid="settings-workspace-delete-form">
          <p className="hint-text" data-testid="settings-workspace-delete-export">
            {translate('workspaceDelete.exportHint')}{' '}
            <Link to={SETTINGS_TARGET_PATHS.export} data-testid="settings-workspace-delete-export-link">{translate('workspaceDelete.exportLink')}</Link>
          </p>
          <p className="settings-form__notice" data-testid="settings-workspace-delete-retention">{translate('workspaceDelete.retention')}</p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
              data-testid="settings-workspace-delete-retention-confirm"
            />
            {translate('workspaceDelete.retentionConfirm')}
          </label>
          <div data-testid="settings-workspace-delete-consequences">
            <p className="settings-form__legend">{translate('workspaceDelete.consequences.title')}</p>
            <ul className="hint-list">
              <li>{translate('workspaceDelete.consequences.members')}</li>
              <li>{translate('workspaceDelete.consequences.mailbox')}</li>
              <li>{translate('workspaceDelete.consequences.data')}</li>
            </ul>
            <p className="hint-text">{translate('workspaceDelete.period')}</p>
          </div>
          <div className="settings-form__field">
            <label htmlFor="settings-workspace-delete-name">{translate('workspaceDelete.name.label').replace('{name}', workspaceName)}</label>
            <input
              id="settings-workspace-delete-name"
              className="input"
              type="text"
              autoComplete="off"
              value={typedName}
              disabled={busy}
              onChange={(event) => setTypedName(event.target.value)}
              data-testid="settings-workspace-delete-name"
            />
          </div>
          <div className="settings-form__field">
            <label htmlFor="settings-workspace-delete-password">{translate('destructive.password.label')}</label>
            <input
              id="settings-workspace-delete-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
              data-testid="settings-workspace-delete-password"
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
              onClick={() => setDialog('request')}
              data-testid="settings-workspace-delete-submit"
            >
              {translate('workspaceDelete.submit')}
            </Button>
          </div>
        </section>
      )}

      <SimpleConfirmDialog
        open={dialog === 'request'}
        title={translate('workspaceDelete.dialog.title')}
        message={translate('workspaceDelete.dialog.text')}
        confirmLabel={translate('workspaceDelete.submit')}
        cancelLabel={translate('common.cancel')}
        confirmVariant="danger"
        confirmTestId="settings-workspace-delete-confirm"
        cancelTestId="settings-workspace-delete-cancel"
        dialogTestId="settings-workspace-delete-dialog"
        returnFocusRef={submitRef}
        onConfirm={runRequest}
        onCancel={() => setDialog(null)}
      />
      <SimpleConfirmDialog
        open={dialog === 'revoke'}
        title={translate('workspaceDelete.revoke.dialog.title')}
        message={translate('workspaceDelete.revoke.dialog.text')}
        confirmLabel={translate('workspaceDelete.revoke')}
        cancelLabel={translate('common.cancel')}
        confirmTestId="settings-workspace-delete-revoke-confirm"
        cancelTestId="settings-workspace-delete-revoke-cancel"
        dialogTestId="settings-workspace-delete-revoke-dialog"
        onConfirm={runRevoke}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}
