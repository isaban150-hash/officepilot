import { afterEach, describe, expect, it } from 'vitest';
import {
  getSupabaseAnonKey,
  getSupabaseClient,
  getSupabaseUrl,
  isSupabaseConfigured,
  resetSupabaseClientCache,
} from './lib/supabase';

describe('SUPABASE-AUTH-01 foundation', () => {
  afterEach(() => {
    resetSupabaseClientCache();
  });

  it('nutzt in Tests den gemockten Supabase-Client aus supabaseMockSetup', () => {
    expect(getSupabaseUrl()).toBe('https://example.supabase.co');
    expect(getSupabaseAnonKey()).toBe('mock-anon-key');
    expect(isSupabaseConfigured()).toBe(true);
    expect(getSupabaseClient()).not.toBeNull();
  });

  it('liefert null wenn der Client-Cache ohne Konfiguration zurückgesetzt wird', () => {
    resetSupabaseClientCache();
    expect(getSupabaseClient()).not.toBeNull();
  });
});
