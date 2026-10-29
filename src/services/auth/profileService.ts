import { getSupabaseClient } from '../../lib/supabase';
import type { ProfileRow } from '../../types/profile';
import type { ProfileLoadResult } from './profileMapper';

function requireClient() {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error('Supabase ist nicht konfiguriert.');
  }
  return client;
}

/** EINRICHTUNG-01 (AP2, A-01.1) — ein hängender Abruf zählt nach dieser Zeit als vorübergehender Fehler. */
export const PROFILE_FETCH_TIMEOUT_MS = 15_000;

/**
 * EINRICHTUNG-01 (AP2) — die Einordnung folgt Code und Status, nicht dem Wortlaut der Meldung: abgewiesene Sitzung
 * (401, PGRST301, `session_not_active`), sonst vorübergehend. Ein unbekannter Fehler meldet nie ab.
 */
export function classifyProfileFetchError(error: { message?: string; code?: string; status?: number } | null | undefined): 'session_invalid' | 'temporary' {
  if (!error) return 'temporary';
  if (error.status === 401 || error.code === 'PGRST301' || error.code === 'PGRST303') return 'session_invalid';
  if (typeof error.message === 'string' && error.message.startsWith('session_not_active')) return 'session_invalid';
  return 'temporary';
}

function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T | 'timeout'> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function fetchProfileById(userId: string): Promise<ProfileLoadResult> {
  const client = requireClient();
  let response: { data: unknown; error: { message?: string; code?: string; status?: number } | null } | 'timeout';
  try {
    response = await withTimeout(
      client.from('profiles').select('*').eq('id', userId).maybeSingle() as PromiseLike<{
        data: unknown;
        error: { message?: string; code?: string; status?: number } | null;
      }>,
      PROFILE_FETCH_TIMEOUT_MS,
    );
  } catch {
    // Netzfehler (fetch wirft) oder ein unerwarteter Fehler: keine Aussage über das Profil.
    return { success: false, error: 'temporary' };
  }
  if (response === 'timeout') return { success: false, error: 'temporary' };

  const { data, error } = response;
  if (error) {
    return { success: false, error: classifyProfileFetchError(error) };
  }

  if (!data) {
    return { success: false, error: 'not_found' };
  }

  return { success: true, profile: data as ProfileRow };
}

export async function fetchCurrentUserProfile(userId: string): Promise<ProfileLoadResult> {
  return fetchProfileById(userId);
}

export async function updateOwnProfile(input: {
  companyName: string;
  firstName: string;
  lastName: string;
  phone?: string;
  industry?: string;
}): Promise<ProfileLoadResult> {
  const client = requireClient();
  const { data, error } = await client.rpc('update_own_profile', {
    p_company_name: input.companyName,
    p_first_name: input.firstName,
    p_last_name: input.lastName,
    p_phone: input.phone ?? null,
    p_industry: input.industry ?? null,
  });

  if (error || !data) {
    return { success: false, error: 'query_failed' };
  }

  return { success: true, profile: data as ProfileRow };
}
