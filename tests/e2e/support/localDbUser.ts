import { randomBytes } from 'node:crypto';

/**
 * MANUAL-INVOICE-UI-01B1B — ein synthetischer Nutzer in der **lokalen**
 * Supabase-Instanz (Docker), angelegt über die GoTrue-Admin-API mit dem
 * lokalen service_role key aus der Umgebung.
 *
 * Grenzen, bewusst hart:
 *   * nur `127.0.0.1`/`localhost` — jede andere Adresse ist ein Fehler;
 *   * das Kennwort wird je Lauf erzeugt, nur im Speicher gehalten, nie
 *     protokolliert und nie in eine Datei geschrieben;
 *   * es handelt sich um ein Testkonto, nie um Zugangsdaten des Nutzers.
 */
export interface LocalDbUser {
  id: string;
  email: string;
  password: string;
}

function assertLocal(url: string): void {
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
    throw new Error(`Nur die lokale Instanz ist zulässig, nicht ${url}`);
  }
}

export async function provisionLocalDbUser(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  label: string;
}): Promise<LocalDbUser> {
  assertLocal(input.supabaseUrl);
  const stamp = Date.now().toString(36);
  const email = `e2e-${input.label}-${stamp}@example.invalid`;
  const password = `Pw-${randomBytes(12).toString('base64url')}`;
  const headers = {
    apikey: input.serviceRoleKey,
    Authorization: `Bearer ${input.serviceRoleKey}`,
    'Content-Type': 'application/json',
  };

  const created = await fetch(`${input.supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { companyName: 'E2E Manual GmbH', firstName: 'E2E', lastName: 'Manual' },
    }),
  });
  if (!created.ok) {
    throw new Error(`Testnutzer konnte nicht angelegt werden (${created.status})`);
  }
  const user = (await created.json()) as { id: string };

  /* Freischaltung wie durch die Administration: approved + aktive Lizenz + Rechtstexte akzeptiert. */
  const approved = await fetch(`${input.supabaseUrl}/rest/v1/profiles?id=eq.${user.id}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'approved',
      license_status: 'active',
      license_expires_at: null,
      accepted_terms_version: '1.0-draft',
      accepted_privacy_version: '1.0-draft',
      accepted_license_version: '1.0-draft',
      legal_accepted_at: new Date().toISOString(),
    }),
  });
  if (!approved.ok) {
    throw new Error(`Profil konnte nicht freigeschaltet werden (${approved.status})`);
  }

  return { id: user.id, email, password };
}

export async function removeLocalDbUser(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  userId: string;
}): Promise<void> {
  assertLocal(input.supabaseUrl);
  await fetch(`${input.supabaseUrl}/auth/v1/admin/users/${input.userId}`, {
    method: 'DELETE',
    headers: { apikey: input.serviceRoleKey, Authorization: `Bearer ${input.serviceRoleKey}` },
  });
}
