import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ auth: {} })),
}));

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

  it('liest nur VITE_SUPABASE_URL und VITE_SUPABASE_ANON_KEY', () => {
    vi.stubEnv('VITE_SUPABASE_URL', '');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', '');

    expect(getSupabaseUrl()).toBeUndefined();
    expect(getSupabaseAnonKey()).toBeUndefined();
    expect(isSupabaseConfigured()).toBe(false);
    expect(getSupabaseClient()).toBeNull();
  });

  it('erstellt Client wenn URL und Anon-Key gesetzt sind', () => {
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public-anon-key');

    expect(getSupabaseUrl()).toBe('https://example.supabase.co');
    expect(getSupabaseAnonKey()).toBe('public-anon-key');
    expect(isSupabaseConfigured()).toBe(true);
    expect(getSupabaseClient()).not.toBeNull();
  });
});
