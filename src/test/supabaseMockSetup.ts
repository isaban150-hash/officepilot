import { vi } from 'vitest';
import { createMockSupabaseClient, resetMockSupabaseAuth } from './mockSupabaseAuth';

vi.mock('../lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/supabase')>();
  return {
    ...actual,
    getSupabaseUrl: () => 'https://example.supabase.co',
    getSupabaseAnonKey: () => 'mock-anon-key',
    isSupabaseConfigured: () => true,
    getSupabaseClient: () => createMockSupabaseClient(),
    resetSupabaseClientCache: () => {},
  };
});

export { resetMockSupabaseAuth };
