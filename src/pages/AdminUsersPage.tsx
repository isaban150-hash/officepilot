import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, PageHeader } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';
import {
  approveUser,
  blockUser,
  extendLicense,
  expireLicense,
  grantBetaLicense,
  listUsersForAdmin,
} from '../services/auth/authService';
import { getLicenseLabel } from '../services/auth/licenseService';

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

export function AdminUsersPage() {
  const { refreshAuth, isAdmin } = useAuth();
  const [version, setVersion] = useState(0);
  const rows = useMemo(() => listUsersForAdmin(), [version]);

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

  function handleAction(action: () => void) {
    action();
    refreshAuth();
    setVersion((v) => v + 1);
  }

  return (
    <div className="page admin-users-page" data-testid="admin-users-page">
      <PageHeader title="Benutzerverwaltung" subtitle="Freischaltung, Sperren und Lizenzen verwalten." />
      <Card>
        <div className="admin-users-table-wrap">
          <table className="admin-users-table" data-testid="admin-users-table">
            <thead>
              <tr>
                <th>Firma</th>
                <th>Name</th>
                <th>E-Mail</th>
                <th>Status</th>
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
              {rows.map(({ user, license }) => (
                <tr key={user.id} data-testid={`admin-user-row-${user.id}`}>
                  <td>{user.companyName}</td>
                  <td>
                    {user.firstName} {user.lastName}
                  </td>
                  <td>{user.email}</td>
                  <td>{user.status}</td>
                  <td>{getLicenseLabel(license)}</td>
                  <td>{formatDate(user.createdAt)}</td>
                  <td data-testid={`legal-terms-${user.id}`}>{formatConsentAccepted(user.acceptedTermsVersion)}</td>
                  <td data-testid={`legal-privacy-${user.id}`}>{formatConsentAccepted(user.acceptedPrivacyVersion)}</td>
                  <td data-testid={`legal-license-${user.id}`}>{formatConsentAccepted(user.acceptedLicenseVersion)}</td>
                  <td data-testid={`legal-date-${user.id}`}>{formatLegalDate(user)}</td>
                  <td>{formatDate(license?.expiresAt)}</td>
                  <td className="admin-users-table__actions">
                    {user.status !== 'active' ? (
                      <Button
                        variant="outline"
                        onClick={() => handleAction(() => approveUser(user.id))}
                        data-testid={`approve-${user.id}`}
                      >
                        Freischalten
                      </Button>
                    ) : null}
                    {user.status !== 'blocked' ? (
                      <Button
                        variant="danger"
                        onClick={() => handleAction(() => blockUser(user.id))}
                        data-testid={`block-${user.id}`}
                      >
                        Sperren
                      </Button>
                    ) : null}
                    <Button
                      variant="secondary"
                      onClick={() => handleAction(() => grantBetaLicense(user.id, 90))}
                      data-testid={`beta-${user.id}`}
                    >
                      Beta-Lizenz
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => handleAction(() => extendLicense(user.id, 30))}
                      data-testid={`extend-${user.id}`}
                    >
                      +30 Tage
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => handleAction(() => expireLicense(user.id))}
                      data-testid={`expire-${user.id}`}
                    >
                      Ablaufen lassen
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
