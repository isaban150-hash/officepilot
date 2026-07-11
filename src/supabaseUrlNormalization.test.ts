import { describe, expect, it } from 'vitest';
import { normalizeSupabaseProjectUrl } from './lib/supabase';

describe('SUPABASE-AUTH-05 Supabase URL', () => {
  it('entfernt /rest/v1/ aus der Projekt-URL', () => {
    expect(normalizeSupabaseProjectUrl('https://proj.supabase.co/rest/v1/')).toBe(
      'https://proj.supabase.co',
    );
    expect(normalizeSupabaseProjectUrl('https://proj.supabase.co/rest/v1')).toBe(
      'https://proj.supabase.co',
    );
  });

  it('behält eine korrekte Basis-URL unverändert', () => {
    expect(normalizeSupabaseProjectUrl('https://proj.supabase.co/')).toBe('https://proj.supabase.co');
    expect(normalizeSupabaseProjectUrl('https://proj.supabase.co')).toBe('https://proj.supabase.co');
  });
});
