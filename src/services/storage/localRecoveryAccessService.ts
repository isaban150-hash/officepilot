/**
 * EINRICHTUNG-01 (AP1, E8, EIN-07; T-01 bis T-03) — wer auf den Notfallseiten welchen lokalen Bestand sehen und
 * sichern darf.
 *
 * Die Notfallseiten laufen vor der Anmeldung, ohne AuthProvider und ohne Kontotrennung. Bisher listeten sie alle
 * Bestände aller Konten des Geräts samt Kennungen und exportierten sie per Klick — auf einem geteilten Gerät las
 * damit jeder fremde Betriebsdaten aus.
 *
 * Regel (E8):
 * - **Ohne Kontobindung** (Gastbestand, Altformate aus der Zeit vor der Kontotrennung, deren Quarantänekopien):
 *   sichtbar und sicherbar wie bisher.
 * - **Kontogebunden** (`user:<konto>`, `workspace:<betrieb>:account:<konto>:<sicht>`): erst nach Anmeldung genau
 *   dieses Kontos, und erst nachdem der Server die Identität bestätigt hat (`auth.getUser`). Ein gespeicherter
 *   Sitzungsstand allein genügt nicht (T-02.2/T-02.3).
 * - **Betriebsgebunden ohne Konto** (alter gemeinsamer Betriebsbestand `workspace:<betrieb>`): nur für ein bestätigtes
 *   Konto, das der Server als Inhaber oder Admin genau dieses Betriebs meldet (`get_workspace_access`, wie E9).
 * - Ohne Freigabe erscheinen gebundene Bestände nur als Anzahl — ohne Kennungen, Namen oder Details (T-01.2).
 * - Offline lässt sich die Identität nicht bestätigen: gebundene Bestände bleiben gesperrt; die Daten bleiben
 *   unverändert auf dem Gerät (T-02.4, Vertrag 1.11).
 *
 * Der Dienst liest nur. Er schreibt keinen Geschäftsbestand und startet keinen Abgleich.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  LEGACY_GLOBAL_STORAGE_KEY,
  LEGACY_QUARANTINE_PREFIX,
  LEGACY_SETUP_KEY,
  STORAGE_KEY_PREFIX,
} from './storageScopeService';

export type RecoveryBinding =
  | { kind: 'unbound' }
  | { kind: 'account'; userId: string }
  | { kind: 'workspace'; workspaceId: string };

export type RecoveryIdentity =
  /** Noch nicht geprüft. */
  | { state: 'checking' }
  /** Keine Anmeldung auf diesem Gerät. */
  | { state: 'signed_out' }
  /** Eine Sitzung ist gespeichert, der Server bestätigt sie aber nicht (abgelaufen, widerrufen, fremd). */
  | { state: 'invalid' }
  /** Ohne Netz oder bei einem Fehler der Prüfung: unbekannt, also gesperrt. */
  | { state: 'offline' }
  | { state: 'confirmed'; userId: string; email: string | null; workspaceRoles: Readonly<Record<string, string>> };

const ROLLEN_MIT_SICHERUNG: ReadonlySet<string> = new Set(['owner', 'admin']);

/** Die Bindung eines Speicherschlüssels — allein aus dem Schlüssel, nie aus dem Inhalt. */
export function recoveryBindingOf(storageKey: string): RecoveryBinding {
  if (
    storageKey === `${STORAGE_KEY_PREFIX}:guest` ||
    storageKey === LEGACY_GLOBAL_STORAGE_KEY ||
    storageKey === LEGACY_SETUP_KEY ||
    storageKey.startsWith(LEGACY_QUARANTINE_PREFIX)
  ) {
    return { kind: 'unbound' };
  }
  const userPrefix = `${STORAGE_KEY_PREFIX}:user:`;
  if (storageKey.startsWith(userPrefix)) {
    const userId = storageKey.slice(userPrefix.length);
    if (userId && !userId.includes(':')) return { kind: 'account', userId };
  }
  const workspacePrefix = `${STORAGE_KEY_PREFIX}:workspace:`;
  if (storageKey.startsWith(workspacePrefix)) {
    const rest = storageKey.slice(workspacePrefix.length);
    const konto = rest.match(/^([^:]+):account:([^:]+):(full|member)$/);
    if (konto) return { kind: 'account', userId: konto[2]! };
    if (rest && !rest.includes(':')) return { kind: 'workspace', workspaceId: rest };
  }
  // Unbekannte Form: fail-closed wie ein gebundener Bestand ohne Eigentümer.
  return { kind: 'workspace', workspaceId: '' };
}

/** Darf diese Identität den Bestand sehen und sichern? */
export function isRecoveryCopyReleased(storageKey: string, identity: RecoveryIdentity): boolean {
  const binding = recoveryBindingOf(storageKey);
  if (binding.kind === 'unbound') return true;
  if (identity.state !== 'confirmed') return false;
  if (binding.kind === 'account') return binding.userId === identity.userId;
  if (!binding.workspaceId) return false;
  return ROLLEN_MIT_SICHERUNG.has(identity.workspaceRoles[binding.workspaceId] ?? '');
}

/** Die alten gemeinsamen Betriebsbestände, deren Freigabe eine Rollenauskunft braucht. */
export function legacyWorkspaceIdsOf(storageKeys: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const key of storageKeys) {
    const binding = recoveryBindingOf(key);
    if (binding.kind === 'workspace' && binding.workspaceId) ids.add(binding.workspaceId);
  }
  return [...ids].sort();
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function looksLikeNetworkError(error: unknown): boolean {
  const value = error as { name?: string; message?: string; status?: number } | null;
  if (!value) return false;
  if (value.name === 'AuthRetryableFetchError') return true;
  const message = value.message ?? '';
  return /Failed to fetch|NetworkError|Load failed|network/i.test(message) || value.status === 0;
}

/**
 * Bestätigt die Identität beim Server. Nur `confirmed` gibt gebundene Bestände frei. Die Rollen werden für die
 * übergebenen alten Betriebsbestände erfragt; eine fehlende oder abgewiesene Auskunft heißt „keine Freigabe“.
 */
export async function confirmRecoveryIdentity(
  client: SupabaseClient | null,
  legacyWorkspaceIds: readonly string[] = [],
): Promise<RecoveryIdentity> {
  if (!client) return { state: 'signed_out' };
  if (isOffline()) return { state: 'offline' };
  let sessionUserId: string | null = null;
  try {
    const { data } = await client.auth.getSession();
    sessionUserId = data?.session?.user?.id ?? null;
  } catch {
    return { state: 'offline' };
  }
  if (!sessionUserId) return { state: 'signed_out' };
  let confirmedUser: { id: string; email?: string | null } | null = null;
  try {
    const { data, error } = await client.auth.getUser();
    if (error) return looksLikeNetworkError(error) ? { state: 'offline' } : { state: 'invalid' };
    confirmedUser = data?.user ?? null;
  } catch (error) {
    return looksLikeNetworkError(error) ? { state: 'offline' } : { state: 'invalid' };
  }
  if (!confirmedUser?.id || confirmedUser.id !== sessionUserId) return { state: 'invalid' };

  const workspaceRoles: Record<string, string> = {};
  for (const workspaceId of legacyWorkspaceIds) {
    try {
      const { data, error } = await client.rpc('get_workspace_access', { p_workspace_id: workspaceId });
      const role = (data as { workspace_id?: unknown; role?: unknown } | null) ?? null;
      if (!error && role?.workspace_id === workspaceId && typeof role.role === 'string') {
        workspaceRoles[workspaceId] = role.role;
      }
    } catch {
      // keine Auskunft, keine Freigabe
    }
  }
  return { state: 'confirmed', userId: confirmedUser.id, email: confirmedUser.email ?? null, workspaceRoles };
}

/** Anmelden auf der Notfallseite — ohne Bootstrap, ohne Abgleich; danach wird die Identität neu bestätigt. */
export async function signInForRecovery(
  client: SupabaseClient | null,
  email: string,
  password: string,
): Promise<'ok' | 'invalid_credentials' | 'offline' | 'unavailable'> {
  if (!client) return 'unavailable';
  if (isOffline()) return 'offline';
  try {
    const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
    if (!error) return 'ok';
    return looksLikeNetworkError(error) ? 'offline' : 'invalid_credentials';
  } catch (error) {
    return looksLikeNetworkError(error) ? 'offline' : 'unavailable';
  }
}

/** Nur diese Sitzung beenden (`scope: 'local'`, Vertrag 1.8). */
export async function signOutFromRecovery(client: SupabaseClient | null): Promise<void> {
  if (!client) return;
  try {
    await client.auth.signOut({ scope: 'local' });
  } catch {
    // Abmelden ist hier nur ein Komfort; die Freigabe hängt ohnehin an der Bestätigung.
  }
}
