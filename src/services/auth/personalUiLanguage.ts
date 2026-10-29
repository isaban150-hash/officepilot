/**
 * EINRICHTUNG-01 (E6, S-15.3; Vorstufe zu K-04) — die Oberflächensprache gehört
 * der Person, nicht dem Betrieb.
 *
 * Bisher schrieb jeder Sprachwechsel `CompanySetup.language` und damit den
 * synchronisierten `company_setup` des Betriebs: Ein Mitglied erzeugte so einen
 * Firmen-Schreibauftrag, den der Server abwies, und hätte nebenbei die Sprache
 * aller anderen umgestellt. Im Cloud-Betrieb (aktiver Betriebsbereich mit
 * angemeldetem Konto) liegt die Wahl deshalb je Person auf dem Gerät;
 * `company_setup` bleibt unberührt. Im lokalen Betrieb gehört das Setup dem
 * Gerät — dort bleibt es beim bisherigen Weg über das Setup.
 *
 * Der Schlüssel liegt bewusst ausserhalb des Präfixes der Geschäftsbestände:
 * Inventur, Notfallseite und Datensicherung sehen ihn nicht.
 */
import type { AppLanguage } from '../../types/models';
import { getActiveStorageAccount } from '../storage/storageScopeService';
import { getSupabaseClient } from '../../lib/supabase';

export const PERSONAL_UI_LANGUAGE_KEY_PREFIX = 'officetakt-ui-language:';

const APP_LANGUAGES: readonly AppLanguage[] = ['de', 'tr', 'bg', 'ro', 'ru'];

function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && (APP_LANGUAGES as readonly string[]).includes(value);
}

/** Das Konto, dem die Sprachwahl gehört; `null` im lokalen Betrieb (Gast, Nutzerbereich, Altbestand). */
export function getPersonalUiLanguageOwner(): string | null {
  const userId = getActiveStorageAccount()?.userId?.trim();
  return userId ? userId : null;
}

/** Die gespeicherte Wahl dieser Person auf diesem Gerät oder `null`. */
export function readPersonalUiLanguage(userId: string | null = getPersonalUiLanguageOwner()): AppLanguage | null {
  if (!userId) return null;
  try {
    const value = localStorage.getItem(`${PERSONAL_UI_LANGUAGE_KEY_PREFIX}${userId}`);
    return isAppLanguage(value) ? value : null;
  } catch {
    return null;
  }
}

/** Merkt die Wahl auf dem Gerät. `false`, wenn der Speicher nicht schreibbar ist — die Wahl gilt dann nur bis zum Neuladen. */
export function writePersonalUiLanguage(
  language: AppLanguage,
  userId: string | null = getPersonalUiLanguageOwner(),
): boolean {
  if (!userId || !isAppLanguage(language)) return false;
  try {
    localStorage.setItem(`${PERSONAL_UI_LANGUAGE_KEY_PREFIX}${userId}`, language);
    return true;
  } catch {
    return false;
  }
}

/**
 * EINRICHTUNG-01 (AP3, K-04.3) — die Wahl gilt auch auf anderen Geräten: Sie liegt zusätzlich am eigenen Profil
 * (`set_own_ui_language`, Ausnahme B — kein Firmen-Schreibauftrag, auch im Nur-Lesen-Betrieb). Scheitert das (offline),
 * bleibt die Wahl auf diesem Gerät; beim nächsten Wechsel wird sie erneut gesendet.
 */
export async function storePersonalUiLanguageOnProfile(language: AppLanguage): Promise<boolean> {
  if (!isAppLanguage(language)) return false;
  const client = getSupabaseClient();
  if (!client) return false;
  try {
    const { error } = await client.rpc('set_own_ui_language', { p_language: language });
    return !error;
  } catch {
    return false;
  }
}

/** Beim Anmelden: Die am Profil gespeicherte Wahl gilt auf diesem Gerät, wenn sie gültig ist. */
export function adoptProfileUiLanguage(userId: string, language: string | null | undefined): AppLanguage | null {
  if (!isAppLanguage(language)) return null;
  writePersonalUiLanguage(language, userId);
  return language;
}
