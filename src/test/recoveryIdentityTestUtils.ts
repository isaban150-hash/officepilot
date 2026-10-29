import { vi } from 'vitest';
import * as recoveryAccess from '../services/storage/localRecoveryAccessService';

/**
 * EINRICHTUNG-01 (AP1, E8) — die Notfallseiten geben kontogebundene Bestände erst frei, wenn der Server die Anmeldung
 * genau des Kontos bestätigt, dem sie gehören; alte gemeinsame Betriebsbestände nur dessen Inhaber oder Admin.
 *
 * Die bisherigen Sicherungs- und Quarantäneabläufe (LOCAL-SCOPE-RECOVERY, BLOB-RECOVERY, 02P3) gelten unverändert —
 * jetzt für dieses bestätigte Konto. Ihre Tests laufen deshalb als bestätigtes Konto; die Freigaberegel selbst prüft
 * `localRecoveryE8Ap1.test.tsx` ohne diesen Baustein.
 */
export function alsBestaetigtesKonto(
  userId: string,
  options: { email?: string; rolle?: 'owner' | 'admin' | 'member' } = {},
) {
  return vi.spyOn(recoveryAccess, 'confirmRecoveryIdentity').mockImplementation(async (_client, ids = []) => ({
    state: 'confirmed' as const,
    userId,
    email: options.email ?? 'konto@example.invalid',
    workspaceRoles: Object.fromEntries(ids.map((id) => [id, options.rolle ?? 'owner'])),
  }));
}
