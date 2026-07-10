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

export async function fetchProfileById(userId: string): Promise<ProfileLoadResult> {
  const client = requireClient();
  const { data, error } = await client
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    return { success: false, error: 'query_failed' };
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
