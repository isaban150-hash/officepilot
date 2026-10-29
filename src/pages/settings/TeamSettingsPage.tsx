import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { SettingsAccessNotice } from '../../components/settings/SettingsAccessNotice';
import { SettingsPageHeader } from '../../components/settings/SettingsPageHeader';
import { Button } from '../../components/ui/Button';
import { SimpleConfirmDialog } from '../../components/ui/SimpleConfirmDialog';
import { useApp } from '../../context/AppContext';
import { useAuth } from '../../context/AuthContext';
import { useWorkspaceWriteAccess } from '../../hooks/useWorkspaceWriteAccess';
import { isSupabaseConfigured } from '../../lib/supabase';
import { getWorkspaceStoreSnapshot } from '../../services/workspace/workspaceStore';
import { rebindWorkspace } from '../../services/workspace/workspaceMembershipChangeService';
import { COMPANY_SETTINGS_ROUTE } from './CompanySettingsPage';
import { SETTINGS_TARGET_PATHS } from './settingsHubConfig';
import {
  buildInvitationLink,
  changeMemberRole,
  getOpenTransfer,
  inviteMember,
  leaveWorkspace,
  listTeamEvents,
  listTeamInvitations,
  listTeamMembers,
  removeMember,
  requestOwnershipTransfer,
  resendInvitation,
  revokeInvitation,
  revokeOwnershipTransfer,
  sendInvitationMail,
  type CreatedInvitation,
  type InvitableRole,
  type OpenTransfer,
  type TeamEvent,
  type TeamInvitation,
  type TeamMember,
  type TeamResult,
} from '../../services/team/teamService';
import { failureText, t, type ShownFailure, type TranslationKey } from '../../i18n';
import type { AppLanguage } from '../../types/models';
import { useLeaveGuard } from '../../hooks/useLeaveGuard';

/**
 * EINRICHTUNG-01 (AP4; Verträge 1.3 mit E16, 1.4, 1.5, 1.6; M-01 bis M-17) — „Team“ unter `/einstellungen/team`.
 *
 * Die Seite bietet nur an, was die Rollenmatrix der eigenen Rolle erlaubt; der Server prüft jede Aktion selbst. Im
 * Nur-Lesen-Betrieb (Lizenz nicht wirksam) bleiben rechtemindernde Aktionen und die Übergabe erreichbar (E16), Einladen
 * und Aufstufen nicht. Teamaktionen sind cloudbestätigt: offline oder mit unbestätigten Rechten gesperrt (Vertrag 1.11).
 */
export const TEAM_SETTINGS_ROUTE = SETTINGS_TARGET_PATHS['team-members'];

const LOCALES: Record<AppLanguage, string> = { de: 'de-DE', tr: 'tr-TR', bg: 'bg-BG', ro: 'ro-RO', ru: 'ru-RU' };

function formatDate(value: string | null | undefined, language: AppLanguage): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? '—' : new Date(parsed).toLocaleDateString(LOCALES[language] ?? 'de-DE');
}

function formatDateTime(value: string | null | undefined, language: AppLanguage): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? '—' : new Date(parsed).toLocaleString(LOCALES[language] ?? 'de-DE');
}

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  testId: string;
  run: () => Promise<boolean>;
}

interface InviteOutcome {
  invitation: CreatedInvitation;
  link: string | null;
  mail: 'sent' | 'not_sent' | 'sending' | null;
}

function isOnline(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

export function TeamSettingsPage() {
  const { translate, language } = useApp();
  const { user } = useAuth();
  const access = useWorkspaceWriteAccess();
  const workspace = getWorkspaceStoreSnapshot();
  const workspaceId = workspace?.id ?? null;
  const workspaceName = workspace?.name ?? '';
  const tr = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) => t(key, language, params),
    [language],
  );

  const role = access.reason === 'local_only' ? null : access.role;
  const isOwner = role === 'owner';
  const isManager = role === 'owner' || role === 'admin';
  const readOnly = access.licenseReadOnly === true;
  const [online, setOnline] = useState(isOnline());
  const confirmed = access.rightsUnconfirmed !== true && online;
  const cloud = isSupabaseConfigured() && Boolean(workspaceId) && role !== null;

  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [invitations, setInvitations] = useState<TeamInvitation[]>([]);
  const [events, setEvents] = useState<TeamEvent[]>([]);
  const [openTransfer, setOpenTransfer] = useState<OpenTransfer | null>(null);
  // EINRICHTUNG-01 (AP9; 1.30) — bekannter Ladefehler mit eigenem Text, unbekannter Code mit Kurzreferenz.
  const [loadFailed, setLoadFailed] = useState<ShownFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<InvitableRole>('member');
  const [inviteOutcome, setInviteOutcome] = useState<InviteOutcome | null>(null);
  const [copyState, setCopyState] = useState<'copied' | 'failed' | null>(null);
  // EINRICHTUNG-01 (AP8; 1.27) — eine begonnene Einladung schützt vor dem Verlassen (kein Entwurf).
  useLeaveGuard(inviteEmail.trim() !== '', false);

  useEffect(() => {
    const update = () => setOnline(isOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const load = useCallback(async () => {
    if (!cloud || !workspaceId) return;
    const memberResult = await listTeamMembers(workspaceId);
    if (!memberResult.ok) {
      setLoadFailed({ errorKey: 'team.loadFailed', ref: memberResult.ref });
      setMembers(null);
      return;
    }
    setLoadFailed(null);
    setMembers(memberResult.value);
    if (isManager) {
      const [inv, transfer, trail] = await Promise.all([
        listTeamInvitations(workspaceId),
        getOpenTransfer(workspaceId),
        listTeamEvents(workspaceId, 50),
      ]);
      setInvitations(inv.ok ? inv.value : []);
      setOpenTransfer(transfer.ok ? transfer.value : null);
      setEvents(trail.ok ? trail.value : []);
    }
  }, [cloud, isManager, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const finish = useCallback(
    async <T,>(result: TeamResult<T>, successKey?: TranslationKey, params?: Record<string, string | number>): Promise<boolean> => {
      if (!result.ok) {
        setError(failureText(language, result));
        setNotice(null);
        return false;
      }
      setError(null);
      if (successKey) setNotice(tr(successKey, params));
      await load();
      return true;
    },
    [language, load, tr],
  );

  const run = useCallback(
    async (action: () => Promise<boolean>) => {
      if (busy) return false;
      setBusy(true);
      try {
        return await action();
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const roleLabel = useCallback((value: string) => translate(`team.role.${value}` as TranslationKey), [translate]);

  const canAct = cloud && isManager && confirmed;
  const canInvite = canAct && !readOnly;

  const deliver = useCallback(
    async (invitation: CreatedInvitation) => {
      const link = invitation.token ? buildInvitationLink(invitation.token, invitation.email) : null;
      setCopyState(null);
      setInviteOutcome({ invitation, link, mail: link ? 'sending' : null });
      if (!invitation.token) return;
      const mail = await sendInvitationMail({ invitationId: invitation.invitationId, token: invitation.token, language });
      setInviteOutcome({ invitation, link, mail });
    },
    [language],
  );

  const submitInvite = async (event: FormEvent) => {
    event.preventDefault();
    if (!workspaceId || !canInvite) return;
    await run(async () => {
      const result = await inviteMember(workspaceId, inviteEmail.trim(), isOwner ? inviteRole : 'member');
      if (!result.ok) {
        setError(failureText(language, result));
        setNotice(null);
        return false;
      }
      setError(null);
      setNotice(
        tr(result.value.status === 'already_invited' ? 'team.invite.already' : 'team.invite.created', {
          date: formatDate(result.value.expiresAt, language),
        }),
      );
      setInviteEmail('');
      await deliver(result.value);
      await load();
      return true;
    });
  };

  const copyLink = async () => {
    if (!inviteOutcome?.link) return;
    try {
      await navigator.clipboard.writeText(inviteOutcome.link);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };

  const askRole = (member: TeamMember, nextRole: InvitableRole) =>
    setConfirm({
      title: translate('team.section.members'),
      message: tr('team.confirm.role', { name: member.name ?? '—', role: roleLabel(nextRole) }),
      confirmLabel: translate('team.action.confirm'),
      testId: 'team-confirm-role',
      run: () => run(async () => finish(await changeMemberRole(workspaceId!, member.userId, nextRole), 'team.saved')),
    });

  const askRemove = (member: TeamMember) =>
    setConfirm({
      title: translate('team.action.remove'),
      message: tr('team.confirm.remove', { name: member.name ?? '—' }),
      confirmLabel: translate('team.action.remove'),
      testId: 'team-confirm-remove',
      run: () => run(async () => finish(await removeMember(workspaceId!, member.userId), 'team.saved')),
    });

  const askTransfer = (member: TeamMember) =>
    setConfirm({
      title: translate('team.section.transfer'),
      message: tr('team.confirm.transfer', { name: member.name ?? '—' }),
      confirmLabel: translate('team.action.transfer'),
      testId: 'team-confirm-transfer',
      run: () =>
        run(async () =>
          finish(await requestOwnershipTransfer(workspaceId!, member.userId), 'team.transfer.requested', { name: member.name ?? '—' }),
        ),
    });

  const askRevoke = (invitation: TeamInvitation) =>
    setConfirm({
      title: translate('team.action.revoke'),
      message: tr('team.confirm.revoke', { email: invitation.email }),
      confirmLabel: translate('team.action.revoke'),
      testId: 'team-confirm-revoke',
      run: () => run(async () => finish(await revokeInvitation(invitation.invitationId), 'team.saved')),
    });

  const askLeave = () =>
    setConfirm({
      title: translate('team.section.leave'),
      message: translate('team.confirm.leave'),
      confirmLabel: translate('team.action.leave'),
      testId: 'team-confirm-leave',
      run: () =>
        run(async () => {
          const result = await leaveWorkspace(workspaceId!);
          if (!result.ok) {
            setError(failureText(language, result));
            return false;
          }
          rebindWorkspace({ userId: user?.id, notice: { kind: 'left', workspaceName } });
          return true;
        }),
    });

  const resend = (invitation: TeamInvitation) =>
    run(async () => {
      const result = await resendInvitation(invitation.invitationId);
      if (!result.ok) {
        setError(failureText(language, result));
        setNotice(null);
        return false;
      }
      setError(null);
      setNotice(tr('team.invite.resent', { date: formatDate(result.value.expiresAt, language) }));
      await deliver(result.value);
      await load();
      return true;
    });

  const revokeTransfer = () =>
    openTransfer
      ? run(async () => {
          const result = await revokeOwnershipTransfer(openTransfer.transferId);
          if (result.ok && !result.value.changed) {
            /* N-M2.2 — die Annahme kam dem Widerruf zuvor: Die eigene Rolle ist jetzt Admin, also neu binden mit Hinweis. */
            if (result.value.status === 'accepted') {
              rebindWorkspace({ userId: user?.id, notice: { kind: 'handedOver', workspaceName }, path: TEAM_SETTINGS_ROUTE });
              return true;
            }
            return finish(result, 'team.transfer.alreadyClosed');
          }
          return finish(result, 'team.saved');
        })
      : Promise.resolve(false);

  // EINRICHTUNG-01 (AP8; 1.28) — der Widerruf eines Übergabeantrags erst nach Rückfrage.
  const askRevokeTransfer = () =>
    setConfirm({
      title: translate('confirm.transferRevoke.title'),
      message: translate('confirm.transferRevoke.text'),
      confirmLabel: translate('confirm.transferRevoke.action'),
      testId: 'team-confirm-transfer-revoke',
      run: () => revokeTransfer(),
    });

  const eligibleTargets = useMemo(() => (members ?? []).filter((member) => member.transferEligible === true), [members]);

  if (!cloud) {
    return (
      <div className="page settings-page settings-subpage" data-testid="settings-team-page">
        <SettingsPageHeader target="team-members" subtitle={translate('team.subtitle')} backTestId="settings-team-back" />
        <p className="hint-text" data-testid="team-unavailable">
          {translate(role === null && isSupabaseConfigured() ? 'team.offline' : 'team.memberView')}
        </p>
      </div>
    );
  }

  return (
    <div className="page settings-page settings-subpage" data-testid="settings-team-page" data-role={role ?? 'unknown'}>
      <SettingsPageHeader target="team-members" subtitle={translate('team.subtitle')} backTestId="settings-team-back" />

      {readOnly && isManager ? (
        <p className="workspace-read-only-banner" role="status" data-testid="team-read-only">
          {translate('team.readOnly')}
        </p>
      ) : null}
      {/* EINRICHTUNG-01 (AP5; 1.16, N-03.6) — derselbe Hinweis „Rechte nicht bestätigt“ wie auf den übrigen Seiten. */}
      {!confirmed ? <SettingsAccessNotice variant="unconfirmed" testId="team-offline" /> : null}
      {notice ? (
        <p className="auth-form__success" role="status" data-testid="team-notice">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="auth-form__error" role="alert" data-testid="team-error">
          {error}
        </p>
      ) : null}

      <section className="settings-form__section" data-testid="team-members">
        <h2 className="settings-form__legend">{translate('team.section.members')}</h2>
        {loadFailed ? (
          <p className="hint-text" role="alert" data-testid="team-load-failed">
            {failureText(language, loadFailed)}
          </p>
        ) : members === null ? (
          <p className="hint-text">{translate('team.loading')}</p>
        ) : (
          members.map((member) => {
            const target = member.role;
            const canChangeRole = isOwner && canAct && target !== 'owner' && !member.isSelf;
            const canRemove =
              canAct && !member.isSelf && target !== 'owner' && (isOwner || (role === 'admin' && target === 'member'));
            return (
              <div className="data-row team-member" key={member.userId} data-testid={`team-member-${member.userId}`}>
                <span className="data-row__label">
                  {member.name ?? '—'}
                  {member.isSelf ? ` (${translate('team.member.you')})` : ''}
                  {member.email ? <span className="hint-text"> · {member.email}</span> : null}
                </span>
                <span className="data-row__value" data-testid={`team-member-role-${member.userId}`}>
                  {roleLabel(target)} · {tr('team.member.since', { date: formatDate(member.memberSince, language) })}
                </span>
                <div className="form-actions team-member__actions">
                  {canChangeRole && target === 'member' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || readOnly}
                      onClick={() => askRole(member, 'admin')}
                      data-testid={`team-action-make-admin-${member.userId}`}
                    >
                      {translate('team.action.makeAdmin')}
                    </Button>
                  ) : null}
                  {canChangeRole && target === 'admin' ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => askRole(member, 'member')}
                      data-testid={`team-action-make-member-${member.userId}`}
                    >
                      {translate('team.action.makeMember')}
                    </Button>
                  ) : null}
                  {isOwner && canAct && member.transferEligible ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => askTransfer(member)}
                      data-testid={`team-action-transfer-${member.userId}`}
                    >
                      {translate('team.action.transfer')}
                    </Button>
                  ) : null}
                  {canRemove ? (
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => askRemove(member)}
                      data-testid={`team-action-remove-${member.userId}`}
                    >
                      {translate('team.action.remove')}
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
        {!isManager ? (
          <p className="hint-text" data-testid="team-member-view">
            {translate('team.memberView')}
          </p>
        ) : null}
      </section>

      {isManager ? (
        <form className="settings-form__section" onSubmit={(event) => void submitInvite(event)} data-testid="team-invite">
          <h2 className="settings-form__legend">{translate('team.section.invite')}</h2>
          <label className="edit-field">
            <span className="edit-field__label">{translate('team.invite.email')}</span>
            <input
              className="input"
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              autoComplete="off"
              disabled={!canInvite}
              data-testid="team-invite-email"
            />
          </label>
          <label className="edit-field">
            <span className="edit-field__label">{translate('team.invite.role')}</span>
            <select
              className="select"
              value={isOwner ? inviteRole : 'member'}
              onChange={(event) => setInviteRole(event.target.value === 'admin' ? 'admin' : 'member')}
              disabled={!canInvite || !isOwner}
              data-testid="team-invite-role"
            >
              <option value="member">{translate('team.role.member')}</option>
              {isOwner ? <option value="admin">{translate('team.role.admin')}</option> : null}
            </select>
          </label>
          <p className="hint-text" data-testid="team-invite-role-hint">
            {translate((isOwner ? inviteRole : 'member') === 'admin' ? 'team.role.admin.hint' : 'team.role.member.hint')}
          </p>
          <Button type="submit" disabled={!canInvite || busy || !inviteEmail.trim()} data-testid="team-invite-submit">
            {translate('team.action.invite')}
          </Button>
          {inviteOutcome?.link ? (
            <div className="team-invite__result" data-testid="team-invite-result">
              <label className="edit-field">
                <span className="edit-field__label">{translate('team.invite.linkLabel')}</span>
                <input className="input" readOnly value={inviteOutcome.link} data-testid="team-invite-link" onFocus={(e) => e.currentTarget.select()} />
              </label>
              <Button type="button" variant="outline" size="sm" onClick={() => void copyLink()} data-testid="team-invite-copy">
                {translate('team.action.copyLink')}
              </Button>
              {copyState ? (
                <p className="hint-text" role="status" data-testid="team-invite-copy-state">
                  {translate(copyState === 'copied' ? 'team.invite.copied' : 'team.invite.copyFailed')}
                </p>
              ) : null}
              {inviteOutcome.mail === 'sent' || inviteOutcome.mail === 'not_sent' ? (
                <p
                  className={inviteOutcome.mail === 'sent' ? 'auth-form__success' : 'auth-form__error'}
                  role="status"
                  data-testid="team-invite-mail"
                  data-state={inviteOutcome.mail}
                >
                  {translate(inviteOutcome.mail === 'sent' ? 'team.invite.mailSent' : 'team.invite.mailNotSent')}
                </p>
              ) : null}
            </div>
          ) : null}
        </form>
      ) : null}

      {isManager ? (
        <section className="settings-form__section" data-testid="team-invitations">
          <h2 className="settings-form__legend">{translate('team.section.invitations')}</h2>
          {invitations.length === 0 ? (
            <p className="hint-text" data-testid="team-invitations-empty">
              {translate('team.invitation.none')}
            </p>
          ) : (
            invitations.map((invitation) => {
              const resendLocked =
                invitation.resendAvailableAt !== null && Date.parse(invitation.resendAvailableAt) > Date.now();
              return (
                <div className="data-row" key={invitation.invitationId} data-testid={`team-invitation-${invitation.invitationId}`}>
                  <span className="data-row__label">
                    {invitation.email} · {roleLabel(invitation.role)}
                  </span>
                  <span className="data-row__value">
                    {invitation.status === 'expired'
                      ? translate('team.invitation.expired')
                      : tr('team.invitation.expires', { date: formatDate(invitation.expiresAt, language) })}
                    {invitation.invitedByName ? ` · ${tr('team.invitation.by', { name: invitation.invitedByName })}` : ''}
                  </span>
                  {invitation.canManage && canAct ? (
                    <div className="form-actions">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy || readOnly || resendLocked || invitation.resendCount >= 5}
                        onClick={() => void resend(invitation)}
                        data-testid={`team-invitation-resend-${invitation.invitationId}`}
                      >
                        {translate('team.action.resend')}
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        disabled={busy}
                        onClick={() => askRevoke(invitation)}
                        data-testid={`team-invitation-revoke-${invitation.invitationId}`}
                      >
                        {translate('team.action.revoke')}
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </section>
      ) : null}

      {isManager ? (
        <section className="settings-form__section" data-testid="team-transfer">
          <h2 className="settings-form__legend">{translate('team.section.transfer')}</h2>
          {openTransfer ? (
            <p className="hint-text" data-testid="team-transfer-open">
              {openTransfer.expired
                ? tr('team.transfer.openExpired', { name: openTransfer.toName ?? '—' })
                : tr('team.transfer.open', { name: openTransfer.toName ?? '—', date: formatDate(openTransfer.expiresAt, language) })}
            </p>
          ) : (
            <p className="hint-text" data-testid="team-transfer-none">
              {translate('team.transfer.none')}
            </p>
          )}
          {isOwner && openTransfer && openTransfer.kind === 'owner' && canAct ? (
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={askRevokeTransfer} data-testid="team-transfer-revoke">
              {translate('team.action.revokeTransfer')}
            </Button>
          ) : null}
          {isOwner && eligibleTargets.length === 0 ? (
            <p className="hint-text" data-testid="team-transfer-no-eligible">
              {translate('team.transfer.noEligible')}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="settings-form__section" data-testid="team-name">
        <h2 className="settings-form__legend">{translate('team.section.rename')}</h2>
        <p className="data-row__value" data-testid="team-workspace-name">
          {workspaceName || '—'}
        </p>
        {isManager ? (
          <Link to={COMPANY_SETTINGS_ROUTE} className="btn btn--outline" data-testid="team-rename-link">
            {translate('team.action.rename')}
          </Link>
        ) : null}
      </section>

      <section className="settings-form__section" data-testid="team-leave">
        <h2 className="settings-form__legend">{translate('team.section.leave')}</h2>
        {isOwner ? (
          <p className="hint-text" data-testid="team-leave-owner-hint">
            {translate('team.transfer.ownerHint')}
          </p>
        ) : (
          <Button type="button" variant="danger" disabled={busy || !confirmed} onClick={askLeave} data-testid="team-leave-button">
            {translate('team.action.leave')}
          </Button>
        )}
      </section>

      {isManager ? (
        <section className="settings-form__section" data-testid="team-events">
          <h2 className="settings-form__legend">{translate('team.section.events')}</h2>
          {events.length === 0 ? (
            <p className="hint-text">{translate('team.events.none')}</p>
          ) : (
            events.slice(0, 20).map((entry) => (
              <div className="data-row" key={entry.id} data-testid={`team-event-${entry.id}`}>
                <span className="data-row__label">
                  {translate(`team.event.${entry.action}` as TranslationKey)}
                  {entry.targetName ? ` · ${entry.targetName}` : ''}
                </span>
                <span className="data-row__value">
                  {entry.actorName ?? '—'} · {formatDateTime(entry.createdAt, language)}
                </span>
              </div>
            ))
          )}
        </section>
      ) : null}

      <SimpleConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.confirmLabel ?? ''}
        cancelLabel={translate('team.action.cancel')}
        dialogTestId="team-confirm-dialog"
        confirmTestId={confirm?.testId ?? 'team-confirm'}
        cancelTestId="team-confirm-cancel"
        failureMessage={error ?? translate('team.error.unknown')}
        onConfirm={async () => {
          const current = confirm;
          if (!current) return true;
          const ok = await current.run();
          if (ok) setConfirm(null);
          return ok;
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
