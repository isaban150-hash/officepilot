import { vi } from 'vitest';
import { createMockIsolatedAuthClient, createMockSupabaseClient, resetMockSupabaseAuth } from './mockSupabaseAuth';

vi.mock('../lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/supabase')>();
  return {
    ...actual,
    getSupabaseUrl: () => 'https://example.supabase.co',
    getSupabaseAnonKey: () => 'mock-anon-key',
    isSupabaseConfigured: () => true,
    getSupabaseClient: () => createMockSupabaseClient(),
    // EINRICHTUNG-01 (AP3, K-03.3) — Prüf-Client ohne Wirkung auf die Sitzung dieses Geräts.
    createIsolatedAuthClient: () => createMockIsolatedAuthClient(),
    resetSupabaseClientCache: () => {},
  };
});

export { resetMockSupabaseAuth };
