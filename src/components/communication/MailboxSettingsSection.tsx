/**
 * E-MAIL-07E-MSA — Postfach-Bereich unter Einstellungen → Kommunikation.
 *
 * Microsoft-Postfach (auch persönliche Konten wie Hotmail/Outlook.com) per
 * OAuth verbinden, Status zeigen (nicht verbunden / verbunden / neu
 * verbinden), Verbindung trennen. Es gibt hier bewusst KEIN Passwortfeld: die
 * Anmeldung passiert ausschließlich bei Microsoft, Tokens bleiben auf dem
 * Server. Hat sich bei Microsoft ein anderes Konto angemeldet, wird erst nach
 * ausdrücklicher Bestätigung verbunden.
 *
 * Rückkehr von Microsoft: `?postfach=verbunden|fehler|bestaetigen` (+ `grund`
 * bzw. `oauth`) — nur Ergebnis und Kennung, nie Code, Token oder Adresse.
 *
 * 07E-MSA-FIX1: Testphase — der Importordner ist fest „OfficeTakt-Test" (kein
 * Eingabefeld, kein Systemordner wählbar). Server, Datenbank und Abruf-Adapter
 * erzwingen dieselbe Regel; mehrere erlaubte Ordner (später Firmenkunden)
 * schalten wieder auf ein Eingabefeld um.
 *
 * 07E-PF: intern providerneutral (Anbieter, Quelle Ordner/Label). Angeboten
 * wird nur, was `CONNECTABLE_PROVIDERS` freigibt — derzeit Microsoft;
 * google_gmail ist vorbereitet, aber noch nicht wählbar.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import { useOptionalAuth } from '../../context/AuthContext';
import type { TranslationKey } from '../../i18n';
import { isSupabaseConfigured } from '../../lib/supabase';
import {
  rpcDisconnectMailbox,
  rpcGetMailboxOAuthPending,
  rpcListMailboxConnections,
  rpcResolveMailboxOAuthPending,
  startMailboxOAuth,
  type StartMailboxOAuthResult,
} from '../../services/email/emailMessageCloudService';
import { resolveDeliveryWorkspaceId } from '../../services/delivery/sendDocumentOrchestrator';
import { resolveWorkspaceWriteAccess } from '../../services/workspace/workspaceRoleService';
import type { MailboxConnection, MailboxOAuthPending, MailboxOAuthProviderType } from '../../types/emailMessage';
import { formatDisplayDateTime } from '../../utils/displayFormat';
import { mailboxConnectionErrorKey } from './mailboxErrorText';
import { StatusBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { SimpleConfirmDialog } from '../ui/SimpleConfirmDialog';

export const MAILBOX_DEFAULT_FOLDER = 'OfficeTakt-Test';
/** 07E-MSA-FIX1: erlaubte Importordner (spiegelt Server/DB). Genau einer = fest angezeigt, nicht wählbar. */
export const MAILBOX_ALLOWED_SOURCE_FOLDERS: readonly string[] = [MAILBOX_DEFAULT_FOLDER];
const FIXED_SOURCE_FOLDER = MAILBOX_ALLOWED_SOURCE_FOLDERS.length === 1 ? MAILBOX_ALLOWED_SOURCE_FOLDERS[0] : null;
/** Im UI wählbare OAuth-Anbieter (Server-Register muss sie ebenfalls freigeben). */
export const CONNECTABLE_PROVIDERS: readonly MailboxOAuthProviderType[] = ['microsoft_graph'];
const OAUTH_PROVIDER_TYPES: readonly string[] = ['microsoft_graph', 'google_gmail'];
export const MAILBOX_IMPORT_DAY_OPTIONS = [0, 7, 30] as const;

const KNOWN_ERRORS = new Set([
  'consent_denied',
  'state_expired',
  'state_used',
  'state_unknown',
  'scope_missing_mail_read',
  'scope_excessive',
  'oauth_not_configured',
  'not_deployed',
  'not_configured',
  'unauthenticated',
  'forbidden',
  'invalid_address',
  'invalid_source',
  'provider_not_available',
  'source_not_allowed',
  'invalid_import_window',
  'server_unavailable',
]);

export type MailboxDisplayState = 'connected' | 'disconnected' | 'reconnect' | 'error' | 'syncing';

/** Status für die Anzeige: fehlender/abgelehnter Zugang heißt „neu verbinden". */
export function mailboxDisplayState(connection: MailboxConnection): MailboxDisplayState {
  if (connection.status === 'disconnected') return 'disconnected';
  if (!connection.hasCredentials && connection.authMode === 'delegated') return 'reconnect';
  if (connection.errorCategory === 'auth' || connection.errorCategory === 'reauthorize') return 'reconnect';
  if (connection.status === 'error') return 'error';
  if (connection.status === 'syncing') return 'syncing';
  return 'connected';
}

export function mailboxOAuthErrorKey(code: string | null | undefined): string {
  return code && KNOWN_ERRORS.has(code) ? `mailboxOAuth.error.${code}` : 'mailboxOAuth.error.generic';
}

type ConnectionsResult = { ok: true; connections: MailboxConnection[] } | { ok: false; error: string };

function workspace(): string | null {
  if (!isSupabaseConfigured()) return null;
  return resolveDeliveryWorkspaceId() || null;
}

type StartInput = { provider: MailboxOAuthProviderType; expectedAddress: string; sourceName: string; importDays: number };

interface Props {
  /** Nur zum Testen ersetzbar. */
  loadConnections?: () => Promise<ConnectionsResult>;
  start?: (input: StartInput) => Promise<StartMailboxOAuthResult>;
  loadPending?: (stateId: string) => Promise<MailboxOAuthPending | null>;
  resolvePending?: (stateId: string, decision: 'confirm' | 'cancel') => Promise<{ ok: boolean; expired?: boolean }>;
  disconnect?: (connectionId: string) => Promise<boolean>;
  /** Weiterleitung zu Microsoft (Standard: gleiche Registerkarte). */
  navigate?: (url: string) => void;
}

const defaults = {
  async loadConnections(): Promise<ConnectionsResult> {
    const workspaceId = workspace();
    if (!workspaceId) return { ok: false, error: 'cloud_only' };
    return rpcListMailboxConnections({ workspaceId });
  },
  async start(input: StartInput): Promise<StartMailboxOAuthResult> {
    const workspaceId = workspace();
    if (!workspaceId) return { ok: false, error: 'not_configured' };
    return startMailboxOAuth({ workspaceId, ...input });
  },
  async loadPending(stateId: string): Promise<MailboxOAuthPending | null> {
    const workspaceId = workspace();
    if (!workspaceId) return null;
    const result = await rpcGetMailboxOAuthPending({ workspaceId, stateId });
    return result.ok ? result.pending : null;
  },
  async resolvePending(stateId: string, decision: 'confirm' | 'cancel'): Promise<{ ok: boolean; expired?: boolean }> {
    const workspaceId = workspace();
    if (!workspaceId) return { ok: false };
    const result = await rpcResolveMailboxOAuthPending({ workspaceId, stateId, decision });
    return result.ok ? { ok: true } : { ok: false, expired: result.error === 'expired' };
  },
  async disconnect(connectionId: string): Promise<boolean> {
    const workspaceId = workspace();
    if (!workspaceId) return false;
    return (await rpcDisconnectMailbox({ workspaceId, connectionId })).ok;
  },
  navigate(url: string) {
    window.location.assign(url);
  },
};

const UUID = /^[0-9a-f-]{36}$/i;

export function MailboxSettingsSection({
  loadConnections = defaults.loadConnections,
  start = defaults.start,
  loadPending = defaults.loadPending,
  resolvePending = defaults.resolvePending,
  disconnect = defaults.disconnect,
  navigate = defaults.navigate,
}: Props) {
  const { translate } = useApp();
  const t = (key: string) => translate(key as TranslationKey);
  const user = useOptionalAuth()?.user ?? null;
  const canWrite = resolveWorkspaceWriteAccess({ userId: user?.id, cloudConfigured: isSupabaseConfigured() }).canWrite;
  const [searchParams, setSearchParams] = useSearchParams();
  const [connections, setConnections] = useState<ConnectionsResult | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [folder, setFolder] = useState(MAILBOX_DEFAULT_FOLDER);
  const [importDays, setImportDays] = useState<number>(0);
  const [starting, setStarting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; key: string } | null>(null);
  const [pending, setPending] = useState<MailboxOAuthPending | null>(null);
  const [pendingBusy, setPendingBusy] = useState(false);
  const [disconnectTarget, setDisconnectTarget] = useState<MailboxConnection | null>(null);
  const disconnectButtonRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(() => {
    let cancelled = false;
    void loadConnections().then((result) => {
      if (!cancelled) setConnections(result);
    });
    return () => {
      cancelled = true;
    };
  }, [loadConnections]);

  useEffect(() => refresh(), [refresh]);

  // Rückkehr von Microsoft auswerten; Parameter danach aus der URL entfernen.
  const outcome = searchParams.get('postfach');
  const reason = searchParams.get('grund');
  const oauthId = searchParams.get('oauth');
  useEffect(() => {
    if (outcome !== 'verbunden' && outcome !== 'fehler' && outcome !== 'bestaetigen') return;
    const clear = () => {
      const next = new URLSearchParams(searchParams);
      ['postfach', 'grund', 'oauth'].forEach((name) => next.delete(name));
      setSearchParams(next, { replace: true });
    };
    if (outcome === 'verbunden') {
      setNotice({ tone: 'info', key: 'mailboxOAuth.result.connected' });
      clear();
      return;
    }
    if (outcome === 'fehler') {
      setNotice({ tone: 'error', key: mailboxOAuthErrorKey(reason) });
      clear();
      return;
    }
    if (!oauthId || !UUID.test(oauthId)) {
      setNotice({ tone: 'error', key: 'mailboxOAuth.confirm.expired' });
      clear();
      return;
    }
    let cancelled = false;
    void loadPending(oauthId).then((result) => {
      if (cancelled) return;
      if (result) setPending(result);
      else setNotice({ tone: 'error', key: 'mailboxOAuth.confirm.expired' });
    });
    return () => {
      cancelled = true;
    };
  }, [outcome, reason, oauthId, loadPending, searchParams, setSearchParams]);

  const clearOAuthParams = () => {
    const next = new URLSearchParams(searchParams);
    ['postfach', 'grund', 'oauth'].forEach((name) => next.delete(name));
    setSearchParams(next, { replace: true });
  };

  const handlePending = async (decision: 'confirm' | 'cancel') => {
    if (!pending || pendingBusy) return;
    setPendingBusy(true);
    try {
      const result = await resolvePending(pending.stateId, decision);
      setPending(null);
      clearOAuthParams();
      if (result.ok) setNotice({ tone: 'info', key: decision === 'confirm' ? 'mailboxOAuth.result.confirmed' : 'mailboxOAuth.result.cancelled' });
      else setNotice({ tone: 'error', key: result.expired ? 'mailboxOAuth.confirm.expired' : 'mailboxOAuth.error.generic' });
      refresh();
    } finally {
      setPendingBusy(false);
    }
  };

  const openForm = (prefill?: MailboxConnection) => {
    setAddress(prefill?.mailboxAddress ?? '');
    setFolder(FIXED_SOURCE_FOLDER ?? prefill?.mailboxSourceName ?? MAILBOX_DEFAULT_FOLDER);
    setImportDays(0);
    setFormError(null);
    setNotice(null);
    setFormOpen(true);
  };

  const handleConnect = async (event: React.FormEvent) => {
    event.preventDefault();
    if (starting) return;
    const expectedAddress = address.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(expectedAddress)) {
      setFormError('invalid_address');
      return;
    }
    const sourceName = (FIXED_SOURCE_FOLDER ?? folder).trim();
    if (!sourceName || sourceName.length > 100 || /[/\\]/.test(sourceName)) {
      setFormError('invalid_source');
      return;
    }
    setStarting(true);
    setFormError(null);
    try {
      const result = await start({ provider: CONNECTABLE_PROVIDERS[0], expectedAddress, sourceName, importDays });
      if (result.ok) {
        navigate(result.authorizeUrl);
        return;
      }
      setFormError(result.error);
      setStarting(false);
    } catch {
      setFormError('server_unavailable');
      setStarting(false);
    }
  };

  const handleDisconnect = async (): Promise<boolean> => {
    if (!disconnectTarget) return true;
    const ok = await disconnect(disconnectTarget.id);
    if (!ok) return false;
    setDisconnectTarget(null);
    setNotice({ tone: 'info', key: 'mailboxOAuth.result.disconnected' });
    refresh();
    return true;
  };

  const list = connections?.ok ? connections.connections.filter((connection) => OAUTH_PROVIDER_TYPES.includes(connection.providerType)) : [];

  return (
    <section className="form-group settings-form__section mailbox-settings" data-testid="settings-mailbox-section" aria-labelledby="settings-mailbox-title">
      <h2 className="settings-form__legend" id="settings-mailbox-title">{t('mailboxOAuth.section.title')}</h2>
      <p className="form-hint">{t('mailboxOAuth.section.hint')}</p>

      {notice ? (
        <p className={notice.tone === 'error' ? 'form-error' : 'form-hint mailbox-settings__success'} role="status" data-testid="settings-mailbox-notice">
          {t(notice.key)}
        </p>
      ) : null}

      {pending ? (
        <div className="mailbox-settings__pending" role="alert" data-testid="settings-mailbox-pending">
          <p className="settings-form__legend">{t('mailboxOAuth.confirm.title')}</p>
          <p data-testid="settings-mailbox-pending-text">
            {t(pending.reason === 'account_changed' ? 'mailboxOAuth.confirm.textAccountChanged' : 'mailboxOAuth.confirm.text')
              .replace('{expected}', pending.expectedAddress)
              .replace('{detected}', pending.detectedAddress)}
          </p>
          <p className="form-hint">{t(pending.sourceKind === 'label' ? 'mailboxOAuth.confirm.label' : 'mailboxOAuth.confirm.folder').replace('{folder}', pending.sourceName)}</p>
          <div className="settings-form__actions">
            <Button type="button" variant="outline" disabled={pendingBusy} onClick={() => void handlePending('cancel')} data-testid="settings-mailbox-pending-cancel">
              {t('mailboxOAuth.confirm.reject')}
            </Button>
            <Button type="button" loading={pendingBusy} disabled={pendingBusy || !canWrite} onClick={() => void handlePending('confirm')} data-testid="settings-mailbox-pending-confirm">
              {t('mailboxOAuth.confirm.accept')}
            </Button>
          </div>
        </div>
      ) : null}

      {connections === null ? (
        <p className="form-hint" data-testid="settings-mailbox-loading">{t('mailboxOAuth.loading')}</p>
      ) : !connections.ok ? (
        <p className="form-hint" data-testid="settings-mailbox-unavailable">
          {t(
            connections.error === 'cloud_only' || connections.error === 'not_configured'
              ? 'mailboxOAuth.cloudOnly'
              : connections.error === 'not_deployed'
                ? 'mailboxOAuth.error.not_deployed'
                : 'mailboxOAuth.loadError',
          )}
        </p>
      ) : list.length === 0 ? (
        <p className="form-hint" data-testid="settings-mailbox-none">
          <StatusBadge tone="neutral" label={t('mailboxOAuth.state.disconnected')} /> {t('mailboxOAuth.none')}
        </p>
      ) : (
        <ul className="mailbox-settings__list">
          {list.map((connection) => {
            const state = mailboxDisplayState(connection);
            return (
              <li key={connection.id} className="mailbox-settings__item" data-testid="settings-mailbox-connection">
                <dl className="settings-invoices__preview-list">
                  <div>
                    <dt>{t('mailboxOAuth.field.address')}</dt>
                    <dd data-testid="settings-mailbox-address">{connection.mailboxAddress}</dd>
                  </div>
                  <div>
                    <dt>{t('mailboxOAuth.field.status')}</dt>
                    <dd data-testid="settings-mailbox-state" data-state={state}>
                      <StatusBadge
                        tone={state === 'connected' || state === 'syncing' ? 'success' : state === 'disconnected' ? 'neutral' : 'warning'}
                        label={t(`mailboxOAuth.state.${state}`)}
                      />{' '}
                      <span className="form-hint">{t(connection.providerType === 'google_gmail' ? 'mailboxOAuth.mode.google_gmail' : `mailboxOAuth.mode.${connection.authMode ?? 'application'}`)}</span>
                    </dd>
                  </div>
                  {connection.mailboxSourceName ? (
                    <div>
                      <dt>{t(connection.mailboxSourceKind === 'label' ? 'mailboxOAuth.field.label' : 'mailboxOAuth.field.folder')}</dt>
                      <dd data-testid="settings-mailbox-folder">{connection.mailboxSourceName}</dd>
                    </div>
                  ) : null}
                  {connection.importFrom ? (
                    <div>
                      <dt>{t('mailboxOAuth.field.importFrom')}</dt>
                      <dd data-testid="settings-mailbox-import-from">{formatDisplayDateTime(connection.importFrom)}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>{t('mailboxOAuth.field.lastSync')}</dt>
                    <dd data-testid="settings-mailbox-last-sync">
                      {connection.lastSuccessfulSyncAt ? formatDisplayDateTime(connection.lastSuccessfulSyncAt) : t('mailboxOAuth.neverSynced')}
                    </dd>
                  </div>
                  {connection.errorCategory && state !== 'disconnected' ? (
                    <div>
                      <dt>{t('mailboxOAuth.field.error')}</dt>
                      <dd data-testid="settings-mailbox-error">{t(mailboxConnectionErrorKey(connection))}</dd>
                    </div>
                  ) : null}
                </dl>
                {/* E-MAIL-07E: vom verbundenen Postfach direkt zu den eingegangenen E-Mails (dort auch „Jetzt abrufen"). */}
                {state !== 'disconnected' ? (
                  <p className="mailbox-settings__to-inbox">
                    <Link to="/kommunikation" className="btn btn--outline btn--sm" data-testid="settings-mailbox-to-inbox">
                      {t('mailboxOAuth.action.toInbox')}
                    </Link>
                  </p>
                ) : null}
                {canWrite && connection.authMode === 'delegated' ? (
                  <div className="settings-form__actions">
                    {state === 'disconnected' || state === 'reconnect' ? (
                      <Button type="button" variant="outline" size="sm" onClick={() => openForm(connection)} data-testid="settings-mailbox-reconnect">
                        {t('mailboxOAuth.action.reconnect')}
                      </Button>
                    ) : null}
                    {state !== 'disconnected' ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(event) => {
                          disconnectButtonRef.current = event.currentTarget;
                          setDisconnectTarget(connection);
                        }}
                        data-testid="settings-mailbox-disconnect"
                      >
                        {t('mailboxOAuth.action.disconnect')}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {!canWrite ? (
        <p className="form-hint" data-testid="settings-mailbox-readonly">{t('mailboxOAuth.readOnly')}</p>
      ) : connections?.ok && !formOpen && !list.some((connection) => connection.authMode === 'delegated') ? (
        <div className="settings-form__actions">
          <Button type="button" onClick={() => openForm()} data-testid="settings-mailbox-open">
            {t('mailboxOAuth.action.open')}
          </Button>
        </div>
      ) : null}

      {canWrite && formOpen ? (
        <form className="mailbox-settings__form" onSubmit={(event) => void handleConnect(event)} noValidate data-testid="settings-mailbox-form">
          <div className="settings-form__field">
            <label htmlFor="settings-mailbox-address-input">{t('mailboxOAuth.form.address')}</label>
            <input
              id="settings-mailbox-address-input"
              type="email"
              autoComplete="off"
              className={`input${formError === 'invalid_address' ? ' input--error' : ''}`}
              value={address}
              maxLength={254}
              onChange={(event) => {
                setAddress(event.target.value);
                setFormError(null);
              }}
              data-testid="settings-mailbox-address-input"
            />
            <p className="form-hint">{t('mailboxOAuth.form.address.hint')}</p>
          </div>
          <div className="settings-form__field">
            {FIXED_SOURCE_FOLDER ? (
              <>
                <span className="settings-form__label" id="settings-mailbox-folder-label">{t('mailboxOAuth.form.folder.fixed')}</span>
                <p className="mailbox-settings__fixed-folder" aria-labelledby="settings-mailbox-folder-label" data-testid="settings-mailbox-folder-fixed">
                  <strong>{FIXED_SOURCE_FOLDER}</strong>
                </p>
                <p className="form-hint" data-testid="settings-mailbox-folder-fixed-hint">{t('mailboxOAuth.form.folder.fixedHint')}</p>
              </>
            ) : (
              <>
                <label htmlFor="settings-mailbox-folder-input">{t('mailboxOAuth.form.folder')}</label>
                <input
                  id="settings-mailbox-folder-input"
                  type="text"
                  autoComplete="off"
                  className={`input${formError === 'invalid_source' ? ' input--error' : ''}`}
                  value={folder}
                  maxLength={100}
                  onChange={(event) => {
                    setFolder(event.target.value);
                    setFormError(null);
                  }}
                  data-testid="settings-mailbox-folder-input"
                />
                <p className="form-hint">{t('mailboxOAuth.form.folder.hint')}</p>
              </>
            )}
          </div>
          <div className="settings-form__field">
            <label htmlFor="settings-mailbox-import-days">{t('mailboxOAuth.form.importDays')}</label>
            <select
              id="settings-mailbox-import-days"
              className="input"
              value={importDays}
              onChange={(event) => setImportDays(Number(event.target.value))}
              data-testid="settings-mailbox-import-days"
            >
              {MAILBOX_IMPORT_DAY_OPTIONS.map((days) => (
                <option key={days} value={days}>
                  {t(`mailboxOAuth.form.importDays.${days}`)}
                </option>
              ))}
            </select>
            <p className="form-hint">{t('mailboxOAuth.form.importDays.hint')}</p>
          </div>
          <p className="form-hint" data-testid="settings-mailbox-permissions">{t('mailboxOAuth.form.permissions')}</p>
          {formError ? (
            <p className="form-error" role="alert" data-testid="settings-mailbox-form-error">{t(mailboxOAuthErrorKey(formError))}</p>
          ) : null}
          <div className="settings-form__actions">
            <Button type="button" variant="outline" disabled={starting} onClick={() => setFormOpen(false)} data-testid="settings-mailbox-form-cancel">
              {t('mailboxOAuth.action.cancel')}
            </Button>
            <Button type="submit" loading={starting} disabled={starting} data-testid="settings-mailbox-connect">
              {starting ? t('mailboxOAuth.action.redirecting') : t('mailboxOAuth.action.connect')}
            </Button>
          </div>
        </form>
      ) : null}

      <SimpleConfirmDialog
        open={disconnectTarget !== null}
        title={t('mailboxOAuth.disconnect.title')}
        message={t('mailboxOAuth.disconnect.text').replace('{address}', disconnectTarget?.mailboxAddress ?? '')}
        confirmLabel={t('mailboxOAuth.action.disconnect')}
        cancelLabel={t('mailboxOAuth.action.cancel')}
        failureMessage={t('mailboxOAuth.disconnect.failed')}
        confirmTestId="settings-mailbox-disconnect-confirm"
        cancelTestId="settings-mailbox-disconnect-cancel"
        dialogTestId="settings-mailbox-disconnect-dialog"
        returnFocusRef={disconnectButtonRef}
        onConfirm={handleDisconnect}
        onCancel={() => setDisconnectTarget(null)}
      />
    </section>
  );
}
