import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Card, PageHeader } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { SimpleConfirmDialog } from '../components/ui/SimpleConfirmDialog';
import { useAuth } from '../context/AuthContext';
import {
  adminApproveUser,
  adminApproveWithLicense,
  adminBlockUser,
  adminDeactivateLicense,
  adminExpireLicense,
  adminExtendLicense,
  adminListEvents,
  adminListOwnershipRepairCases,
  adminListProfiles,
  adminRequestOwnershipRepair,
  adminRevokeOwnershipRepair,
  type AdminActionResult,
  type OwnershipRepairCase,
  type PlatformEvent,
} from '../services/auth/profileAdminService';
import { readPersonalUiLanguage } from '../services/auth/personalUiLanguage';
import { getCachedSetup } from '../services/persistenceService';
import { failureText, t, type ShownFailure, type TranslationKey } from '../i18n';
import type { AppLanguage } from '../types/models';
import type { License, UserAccount } from '../types/auth';

/**
 * EINRICHTUNG-01 (AP4; EIN-08, EIN-20, EIN-21; P-01 bis P-09) — Plattform-Verwaltung.
 *
 * Genau ein Einstieg (Benutzermenü bzw. die Hinweisseiten ohne Betrieb), nicht in der Gruppe „Betrieb“, auch ohne
 * eigenes Setup und ohne Lizenz erreichbar. Nur Konto-, Status-, Lizenz- und Zustimmungsdaten, keine Geschäftsdaten.
 * Sperren und Lizenzänderungen fragen mit dem richtigen Ziel nach; das eigene Konto bietet keine Schaltflächen
 * (Selbständerungen nur durch einen anderen Admin). Fehler erscheinen übersetzt, nie als Servertext (P-08.1). Die Seite
 * hängt nicht am Betriebskontext und läuft deshalb auch vor jeder Einrichtung.
 */
export const PLATFORM_ADMIN_ROUTE = '/admin/users';

const LOCALES: Record<AppLanguage, string> = { de: 'de-DE', tr: 'tr-TR', bg: 'bg-BG', ro: 'ro-RO', ru: 'ru-RU' };

function formatDate(iso: string | undefined | null, language: AppLanguage): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? '—' : new Date(parsed).toLocaleDateString(LOCALES[language] ?? 'de-DE');
}

function defaultLicenseDate(): string {
  const date = new Date();
  date.setDate(date.getDate() + 90);
  return date.toISOString().slice(0, 10);
}

interface ConfirmState {
  message: string;
  testId: string;
  run: () => Promise<boolean>;
}

interface AdminUsersPageProps {
  /** Ohne Betrieb (Hinweisseiten des Gates): zurück dorthin. */
  onClose?: () => void;
}

export function AdminUsersPage({ onClose }: AdminUsersPageProps = {}) {
  const { refreshAuth, isAdmin, isAuthReady, user: self } = useAuth();
  const language: AppLanguage = readPersonalUiLanguage(self?.id ?? null) ?? getCachedSetup()?.language ?? 'de';
  const tr = useCallback((key: TranslationKey, params?: Record<string, string | number>) => t(key, language, params), [language]);
  const [rows, setRows] = useState<Array<{ user: UserAccount; license?: License }>>([]);
  const [events, setEvents] = useState<PlatformEvent[]>([]);
  const [repairCases, setRepairCases] = useState<OwnershipRepairCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ShownFailure | null>(null);
  const [success, setSuccess] = useState<TranslationKey | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [licenseDates, setLicenseDates] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const [profiles, trail, cases] = await Promise.all([adminListProfiles(), adminListEvents(100), adminListOwnershipRepairCases()]);
    if (!profiles.success) {
      setRows([]);
      setError({ errorKey: profiles.errorKey, ref: profiles.ref });
    } else {
      setRows(profiles.rows);
    }
    setEvents(trail.ok ? trail.events : []);
    setRepairCases(cases.ok ? cases.cases : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isAdmin) void loadAll();
  }, [isAdmin, loadAll]);

  const runAction = useCallback(
    async (userId: string, action: () => Promise<AdminActionResult | { ok: boolean; errorKey?: TranslationKey; ref?: string }>): Promise<boolean> => {
      setBusyUserId(userId);
      setError(null);
      setSuccess(null);
      const result = await action();
      const ok = 'success' in result ? result.success : result.ok;
      if (!ok) {
        // EINRICHTUNG-01 (AP9; 1.30) — mit Kurzreferenz, wenn die Meldung unbekannt war.
        setError('errorKey' in result && result.errorKey ? { errorKey: result.errorKey, ref: result.ref } : { errorKey: 'platform.error.unknown' });
      } else {
        setSuccess('platform.done');
        await loadAll();
        await refreshAuth();
      }
      setBusyUserId(null);
      return ok;
    },
    [loadAll, refreshAuth],
  );

  // Erst entscheiden, wenn die Anmeldung feststeht: sonst würde ein Admin beim direkten Aufruf vorschnell umgeleitet.
  if (!isAuthReady) {
    return <p data-testid="admin-users-auth-pending">{tr('platform.loading')}</p>;
  }

  // P-01.2 — für Nicht-Admins gibt es diese Seite nicht; die Adresse leitet um.
  if (!isAdmin) {
    return onClose ? null : <Navigate to="/" replace />;
  }

  const ask = (message: string, testId: string, run: () => Promise<boolean>) => setConfirm({ message, testId, run });
  const roleText = (value: string) => tr(value === 'admin' ? 'platform.role.admin' : 'platform.role.user');

  return (
    <div className="page admin-users-page" data-testid="admin-users-page">
      <PageHeader title={tr('platform.title')} subtitle={tr('platform.subtitle')} />
      {onClose ? (
        <Button type="button" variant="ghost" onClick={onClose} data-testid="admin-users-close">
          {tr('platform.back')}
        </Button>
      ) : null}
      <Card>
        <h2 className="settings-form__legend">{tr('platform.section.accounts')}</h2>
        {loading ? <p data-testid="admin-users-loading">{tr('platform.loading')}</p> : null}
        {error ? (
          <p className="form-error" role="alert" data-testid="admin-users-error">
            {failureText(language, error)}
          </p>
        ) : null}
        {success ? (
          <p className="form-success" role="status" data-testid="admin-users-success">
            {tr(success)}
          </p>
        ) : null}
        <div className="admin-users-table-wrap">
          <table className="admin-users-table" data-testid="admin-users-table">
            <thead>
              <tr>
                <th>{tr('platform.col.company')}</th>
                <th>{tr('platform.col.name')}</th>
                <th>{tr('platform.col.email')}</th>
                <th>{tr('platform.col.status')}</th>
                <th>{tr('platform.col.role')}</th>
                <th>{tr('platform.col.license')}</th>
                <th>{tr('platform.col.expires')}</th>
                <th>{tr('platform.col.terms')}</th>
                <th>{tr('platform.col.privacy')}</th>
                <th>{tr('platform.col.licenseTerms')}</th>
                <th>{tr('platform.col.consent')}</th>
                <th>{tr('platform.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ user }) => {
                const busy = busyUserId === user.id;
                const isSelf = user.id === self?.id;
                const label = `${user.firstName} ${user.lastName}`.trim() || user.email;
                const consent = (version?: string) => (version ? tr('platform.consent.yes', { version }) : tr('platform.consent.no'));
                return (
                  <tr key={user.id} data-testid={`admin-user-row-${user.id}`}>
                    <td>{user.companyName}</td>
                    <td>{label}</td>
                    <td>{user.email}</td>
                    <td data-testid={`admin-user-status-${user.id}`}>{tr(`platform.status.${user.status}` as TranslationKey)}</td>
                    <td>{roleText(user.role)}</td>
                    <td data-testid={`admin-user-license-${user.id}`}>{tr(`platform.license.${user.licenseStatus ?? 'inactive'}` as TranslationKey)}</td>
                    <td>{formatDate(user.licenseExpiresAt, language)}</td>
                    <td data-testid={`legal-terms-${user.id}`}>{consent(user.acceptedTermsVersion)}</td>
                    <td data-testid={`legal-privacy-${user.id}`}>{consent(user.acceptedPrivacyVersion)}</td>
                    <td data-testid={`legal-license-${user.id}`}>{consent(user.acceptedLicenseVersion)}</td>
                    <td data-testid={`legal-date-${user.id}`}>{formatDate(user.legalAcceptedAt ?? user.acceptedAt, language)}</td>
                    <td className="admin-users-table__actions">
                      {isSelf ? (
                        <p className="hint-text" data-testid={`admin-user-self-${user.id}`}>
                          {tr('platform.self')}
                        </p>
                      ) : (
                        <>
                          {user.status === 'pending' ? (
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => void runAction(user.id, () => adminApproveUser(user.id))}
                              data-testid={`approve-${user.id}`}
                            >
                              {tr('platform.action.approve')}
                            </Button>
                          ) : null}
                          {user.status !== 'blocked' ? (
                            <span className="admin-users-table__license">
                              <label className="edit-field">
                                <span className="edit-field__label">{tr('platform.approveLicense.label')}</span>
                                <input
                                  className="input"
                                  type="date"
                                  value={licenseDates[user.id] ?? defaultLicenseDate()}
                                  onChange={(event) => setLicenseDates((current) => ({ ...current, [user.id]: event.target.value }))}
                                  data-testid={`approve-license-date-${user.id}`}
                                />
                              </label>
                              <Button
                                variant="secondary"
                                disabled={busy}
                                onClick={() => {
                                  const day = licenseDates[user.id] ?? defaultLicenseDate();
                                  void runAction(user.id, () => adminApproveWithLicense(user.id, new Date(`${day}T23:59:59`).toISOString()));
                                }}
                                data-testid={`approve-license-${user.id}`}
                              >
                                {tr('platform.action.approveWithLicense')}
                              </Button>
                            </span>
                          ) : null}
                          {user.licenseStatus === 'active' ? (
                            <Button
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void runAction(user.id, () => adminExtendLicense(user.id, user.licenseExpiresAt ?? null))}
                              data-testid={`extend-${user.id}`}
                            >
                              {tr('platform.action.extend')}
                            </Button>
                          ) : null}
                          {user.licenseStatus === 'active' ? (
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                ask(tr('platform.confirm.deactivate', { name: label, email: user.email }), `confirm-deactivate-${user.id}`, () =>
                                  runAction(user.id, () => adminDeactivateLicense(user.id)),
                                )
                              }
                              data-testid={`deactivate-${user.id}`}
                            >
                              {tr('platform.action.deactivate')}
                            </Button>
                          ) : null}
                          {user.licenseStatus === 'active' ? (
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() =>
                                ask(tr('platform.confirm.expire', { name: label, email: user.email }), `confirm-expire-${user.id}`, () =>
                                  runAction(user.id, () => adminExpireLicense(user.id)),
                                )
                              }
                              data-testid={`expire-${user.id}`}
                            >
                              {tr('platform.action.expire')}
                            </Button>
                          ) : null}
                          {user.status !== 'blocked' ? (
                            <Button
                              variant="danger"
                              disabled={busy}
                              onClick={() =>
                                ask(tr('platform.confirm.block', { name: label, email: user.email }), `confirm-block-${user.id}`, () =>
                                  runAction(user.id, () => adminBlockUser(user.id)),
                                )
                              }
                              data-testid={`block-${user.id}`}
                            >
                              {tr('platform.action.block')}
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              disabled={busy}
                              onClick={() => void runAction(user.id, () => adminApproveUser(user.id))}
                              data-testid={`approve-${user.id}`}
                            >
                              {tr('platform.action.approve')}
                            </Button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <h2 className="settings-form__legend">{tr('platform.section.repair')}</h2>
        <div data-testid="admin-repair-cases">
          {repairCases.length === 0 ? (
            <p className="hint-text">{tr('platform.repair.none')}</p>
          ) : (
            repairCases.map((entry) => (
              <div className="data-row" key={entry.workspaceId} data-testid={`admin-repair-${entry.workspaceId}`}>
                <span className="data-row__label">
                  {entry.workspaceName} ·{' '}
                  {tr('platform.repair.owner', {
                    name: entry.ownerName ?? '—',
                    state: tr(`platform.repair.state.${entry.ownerState}` as TranslationKey),
                  })}
                </span>
                {entry.openTransfer ? (
                  <span className="data-row__value">
                    {tr('platform.repair.open', { date: formatDate(entry.openTransfer.expiresAt, language) })}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void runAction(entry.workspaceId, () => adminRevokeOwnershipRepair(entry.openTransfer!.transferId))}
                      data-testid={`admin-repair-revoke-${entry.workspaceId}`}
                    >
                      {tr('platform.repair.revoke')}
                    </Button>
                  </span>
                ) : entry.candidates.length === 0 ? (
                  <span className="data-row__value hint-text">{tr('platform.repair.noCandidate')}</span>
                ) : (
                  <span className="data-row__value">
                    {entry.candidates.map((candidate) => (
                      <Button
                        key={candidate.userId}
                        variant="secondary"
                        size="sm"
                        onClick={() =>
                          ask(
                            tr('platform.repair.confirm', { name: candidate.name ?? candidate.email ?? '—', workspace: entry.workspaceName }),
                            `confirm-repair-${entry.workspaceId}-${candidate.userId}`,
                            () => runAction(entry.workspaceId, () => adminRequestOwnershipRepair(entry.workspaceId, candidate.userId)),
                          )
                        }
                        data-testid={`admin-repair-request-${entry.workspaceId}-${candidate.userId}`}
                      >
                        {tr('platform.repair.request')}: {candidate.name ?? candidate.email ?? '—'}
                      </Button>
                    ))}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      </Card>

      <Card>
        <h2 className="settings-form__legend">{tr('platform.section.events')}</h2>
        <div data-testid="admin-events">
          {events.length === 0 ? (
            <p className="hint-text">{tr('platform.events.none')}</p>
          ) : (
            events.slice(0, 50).map((entry) => (
              <div className="data-row" key={entry.id} data-testid={`admin-event-${entry.id}`}>
                <span className="data-row__label">
                  {tr(`platform.event.${entry.action}` as TranslationKey)}
                  {entry.targetName ? ` · ${entry.targetName}` : ''}
                </span>
                <span className="data-row__value">
                  {entry.actorName ?? '—'} · {formatDate(entry.createdAt, language)}
                </span>
              </div>
            ))
          )}
        </div>
      </Card>

      <SimpleConfirmDialog
        open={confirm !== null}
        title={tr('platform.title')}
        message={confirm?.message ?? ''}
        confirmLabel={tr('platform.action.confirm')}
        cancelLabel={tr('platform.action.cancel')}
        dialogTestId="admin-confirm-dialog"
        confirmTestId={confirm?.testId ?? 'admin-confirm'}
        cancelTestId="admin-confirm-cancel"
        failureMessage={failureText(language, error ?? { errorKey: 'platform.error.unknown' })}
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
