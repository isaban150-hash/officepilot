import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, PageHeader } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';
import {
  adminActivateLicense,
  adminApproveUser,
  adminBlockUser,
  adminClearLicenseExpiry,
  adminDeactivateLicense,
  adminExpireLicense,
  adminExtendLicense,
  adminListProfiles,
  adminSetLicenseExpiry,
} from '../services/auth/profileAdminService';
import { getLicenseLabel } from '../services/auth/licenseService';
import type { License, UserAccount } from '../types/auth';

function formatDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('de-DE');
}

function formatConsentAccepted(version?: string): string {
  return version ? `Ja (${version})` : 'Nein';
}

function formatLegalDate(user: { legalAcceptedAt?: string; acceptedAt?: string }): string {
  return formatDate(user.legalAcceptedAt ?? user.acceptedAt);
}

function formatStatus(status: UserAccount['status']): string {
  if (status === 'approved') return 'freigeschaltet';
  if (status === 'blocked') return 'gesperrt';
  return 'wartend';
}

function formatLicenseStatus(user: UserAccount): string {
  if (user.licenseStatus === 'active') return 'aktiv';
  if (user.licenseStatus === 'expired') return 'abgelaufen';
  return 'inaktiv';
}

export function AdminUsersPage() {
  const { refreshAuth, isAdmin } = useAuth();
  const [rows, setRows] = useState<Array<{ user: UserAccount; license?: License }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await adminListProfiles();
    if (!result.success) {
      setRows([]);
      setError(result.error);
    } else {
      setRows(result.rows);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isAdmin) {
      void loadProfiles();
    }
  }, [isAdmin, loadProfiles]);

  async function runAction(userId: string, action: () => Promise<{ success: boolean; error?: string }>, successMessage: string) {
    setBusyUserId(userId);
    setError(null);
    setSuccess(null);
    const result = await action();
    if (!result.success) {
      setError(result.error ?? 'Aktion fehlgeschlagen.');
    } else {
      setSuccess(successMessage);
      await loadProfiles();
      await refreshAuth();
    }
    setBusyUserId(null);
  }

  if (!isAdmin) {
    return (
      <div className="page admin-users-page" data-testid="admin-users-denied">
        <PageHeader title="Zugriff verweigert" subtitle="Nur Administratoren haben Zugriff auf diesen Bereich." />
        <Card>
          <Link to="/">Zurück zur Startseite</Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="page admin-users-page" data-testid="admin-users-page">
      <PageHeader title="Benutzerverwaltung" subtitle="Freischaltung, Sperren und Lizenzen verwalten." />
      <Card>
        {loading ? <p data-testid="admin-users-loading">Benutzerprofile werden geladen…</p> : null}
        {error ? (
          <p className="form-error" data-testid="admin-users-error">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className="form-success" data-testid="admin-users-success">
            {success}
          </p>
        ) : null}
        <div className="admin-users-table-wrap">
          <table className="admin-users-table" data-testid="admin-users-table">
            <thead>
              <tr>
                <th>Firma</th>
                <th>Name</th>
                <th>E-Mail</th>
                <th>Status</th>
                <th>Rolle</th>
                <th>Lizenz</th>
                <th>Registriert</th>
                <th>AGB</th>
                <th>Datenschutz</th>
                <th>Lizenzbed.</th>
                <th>Zustimmung</th>
                <th>Ablauf</th>
                <th>Aktionen</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ user, license }) => {
                const busy = busyUserId === user.id;
                return (
                  <tr key={user.id} data-testid={`admin-user-row-${user.id}`}>
                    <td>{user.companyName}</td>
                    <td>
                      {user.firstName} {user.lastName}
                    </td>
                    <td>{user.email}</td>
                    <td>{formatStatus(user.status)}</td>
                    <td>{user.role}</td>
                    <td>{getLicenseLabel(license)} ({formatLicenseStatus(user)})</td>
                    <td>{formatDate(user.createdAt)}</td>
                    <td data-testid={`legal-terms-${user.id}`}>{formatConsentAccepted(user.acceptedTermsVersion)}</td>
                    <td data-testid={`legal-privacy-${user.id}`}>{formatConsentAccepted(user.acceptedPrivacyVersion)}</td>
                    <td data-testid={`legal-license-${user.id}`}>{formatConsentAccepted(user.acceptedLicenseVersion)}</td>
                    <td data-testid={`legal-date-${user.id}`}>{formatLegalDate(user)}</td>
                    <td>{formatDate(license?.expiresAt)}</td>
                    <td className="admin-users-table__actions">
                      {user.status !== 'approved' ? (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void runAction(user.id, () => adminApproveUser(user.id), 'Benutzer wurde freigeschaltet.')
                          }
                          data-testid={`approve-${user.id}`}
                        >
                          Freischalten
                        </Button>
                      ) : null}
                      {user.status !== 'blocked' ? (
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() =>
                            void runAction(user.id, () => adminBlockUser(user.id), 'Benutzer wurde gesperrt.')
                          }
                          data-testid={`block-${user.id}`}
                        >
                          Sperren
                        </Button>
                      ) : null}
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          const expires = new Date();
                          expires.setDate(expires.getDate() + 90);
                          void runAction(
                            user.id,
                            () => adminActivateLicense(user.id, expires.toISOString()),
                            'Lizenz wurde aktiviert.',
                          );
                        }}
                        data-testid={`beta-${user.id}`}
                      >
                        Lizenz aktivieren
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void runAction(user.id, () => adminDeactivateLicense(user.id), 'Lizenz wurde deaktiviert.')
                        }
                        data-testid={`deactivate-${user.id}`}
                      >
                        Lizenz deaktivieren
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() =>
                          void runAction(user.id, () => adminExtendLicense(user.id, 30), 'Lizenz wurde verlängert.')
                        }
                        data-testid={`extend-${user.id}`}
                      >
                        +30 Tage
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          const expires = new Date();
                          expires.setDate(expires.getDate() + 14);
                          void runAction(
                            user.id,
                            () => adminSetLicenseExpiry(user.id, expires.toISOString()),
                            'Ablaufdatum wurde gesetzt.',
                          );
                        }}
                        data-testid={`set-expiry-${user.id}`}
                      >
                        Ablauf setzen
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void runAction(
                            user.id,
                            () => adminClearLicenseExpiry(user.id),
                            'Ablaufdatum wurde entfernt.',
                          )
                        }
                        data-testid={`clear-expiry-${user.id}`}
                      >
                        Ablauf entfernen
                      </Button>
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void runAction(user.id, () => adminExpireLicense(user.id), 'Lizenz wurde abgelaufen gesetzt.')
                        }
                        data-testid={`expire-${user.id}`}
                      >
                        Ablaufen lassen
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
