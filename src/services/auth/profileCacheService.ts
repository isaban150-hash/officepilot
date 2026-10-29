import type { ProfileRow } from '../../types/profile';

/**
 * EINRICHTUNG-01 (AP2, EIN-09; A-01.1, A-02.1) — das zuletzt vom Server bestätigte Profil je Konto.
 *
 * Bisher setzte ein gescheiterter Profilabruf (Netzaussetzer, Zeitüberschreitung, 5xx) den Nutzer auf `null`; die App
 * zeigte die Anmeldeseite, und das Gate wertete das als Abmeldung. Der Offline-Pfad war so unerreichbar. Jetzt bleibt
 * bei einem vorübergehenden Fehler das letzte bestätigte Profil desselben Kontos stehen — als unbestätigt gekennzeichnet:
 * Rechte daraus gelten nicht für cloudbestätigte Aktionen (A-01.4, Vertrag 1.11).
 *
 * - Nur für genau dieses Konto (Schlüssel mit Konto-ID, geprüft beim Lesen).
 * - Außerhalb der Geschäftsbestände: Inventur, Notfallseite und Sicherung sehen es nicht.
 * - Beim ausdrücklichen Abmelden gelöscht.
 */
export const PROFILE_CACHE_KEY_PREFIX = 'officetakt-profile-cache:';

interface CachedProfile {
  profile: ProfileRow;
  confirmedAt: string;
}

function key(userId: string): string {
  return `${PROFILE_CACHE_KEY_PREFIX}${userId}`;
}

export function writeCachedProfile(profile: ProfileRow): void {
  if (!profile?.id) return;
  try {
    const value: CachedProfile = { profile, confirmedAt: new Date().toISOString() };
    localStorage.setItem(key(profile.id), JSON.stringify(value));
    writeLastConfirmedAccount(profile.id);
  } catch {
    // Ohne Speicher gibt es nur keinen Offline-Start; die Anmeldung selbst ist davon nicht betroffen.
  }
}

export function readCachedProfile(userId: string | null | undefined): ProfileRow | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(key(userId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<CachedProfile> | null;
    const profile = value?.profile;
    if (!profile || typeof profile !== 'object' || profile.id !== userId) return null;
    return profile;
  } catch {
    return null;
  }
}

export function clearCachedProfile(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    localStorage.removeItem(key(userId));
    if (readLastConfirmedAccount() === userId) localStorage.removeItem(LAST_ACCOUNT_KEY);
  } catch {
    // nichts zu tun
  }
}

/**
 * EINRICHTUNG-01 (AP2, B3; N-A1.5b, A-02.1) — das zuletzt auf diesem Gerät bestätigte Konto. Ist die gespeicherte
 * Sitzung beim Start vorübergehend nicht lesbar (etwa offline mit abgelaufenem Zugriffstoken), öffnet die App nur den
 * kontogebundenen Bestand dieses Kontos — ohne Schreibanfrage (DOKUMENTE-01 R1) und ohne automatische Abmeldung.
 * Nach dem ausdrücklichen Abmelden gibt es diesen Weg nicht mehr.
 */
const LAST_ACCOUNT_KEY = 'officetakt-auth-last-account';

export function writeLastConfirmedAccount(userId: string): void {
  try {
    localStorage.setItem(LAST_ACCOUNT_KEY, userId);
  } catch {
    // ohne Speicher kein Offline-Start
  }
}

export function readLastConfirmedAccount(): string | null {
  try {
    const value = localStorage.getItem(LAST_ACCOUNT_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}
