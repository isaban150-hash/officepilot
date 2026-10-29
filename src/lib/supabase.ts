import { createClient, type SupabaseClient } from '@supabase/supabase-js';

function readEnv(name: 'VITE_SUPABASE_URL' | 'VITE_SUPABASE_ANON_KEY'): string | undefined {
  const value = import.meta.env[name];
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return undefined;
}

/** REST-API-Pfad entfernen – Auth erwartet die Projekt-Basis-URL (…supabase.co). */
export function normalizeSupabaseProjectUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/rest\/v1$/i, '');
}

export function getSupabaseUrl(): string | undefined {
  const raw = readEnv('VITE_SUPABASE_URL');
  if (!raw) return undefined;
  return normalizeSupabaseProjectUrl(raw);
}

export function getSupabaseAnonKey(): string | undefined {
  return readEnv('VITE_SUPABASE_ANON_KEY');
}

export function isSupabaseConfigured(): boolean {
  return Boolean(getSupabaseUrl() && getSupabaseAnonKey());
}

let client: SupabaseClient | null | undefined;

export function getSupabaseClient(): SupabaseClient | null {
  if (client !== undefined) {
    return client;
  }

  const url = getSupabaseUrl();
  const anonKey = getSupabaseAnonKey();
  if (!url || !anonKey) {
    client = null;
    return client;
  }

  client = createClient(url, anonKey);
  return client;
}

/**
 * EINRICHTUNG-01 (AP3, K-03.3) — ein Client nur zum Prüfen von Zugangsdaten (etwa des aktuellen Passworts vor einem
 * Wechsel): ohne gespeicherte Sitzung, ohne Token-Erneuerung, mit eigenem Speicherschlüssel und damit ohne Abgleich mit
 * anderen Tabs. Die Anmeldung dieses Geräts bleibt unberührt — kein Sitzungswechsel, kein Ereignis, kein Bootstrap.
 * Jeder Aufruf erzeugt einen frischen Client; der Aufrufer beendet dessen Sitzung nach der Prüfung beim Server.
 */
export function createIsolatedAuthClient(): SupabaseClient | null {
  const url = getSupabaseUrl();
  const anonKey = getSupabaseAnonKey();
  if (!url || !anonKey) return null;
  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'officetakt-credential-check',
    },
  });
}

/** Nur für Tests: Client-Cache zurücksetzen. */
export function resetSupabaseClientCache(): void {
  client = undefined;
}
