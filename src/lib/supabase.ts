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

/** Nur für Tests: Client-Cache zurücksetzen. */
export function resetSupabaseClientCache(): void {
  client = undefined;
}
