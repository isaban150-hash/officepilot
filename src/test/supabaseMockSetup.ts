import { vi } from 'vitest';
import { createMockSupabaseClient, resetMockSupabaseAuth } from './mockSupabaseAuth';

vi.mock('../lib/supabase', () => ({
  getSupabaseUrl: () => 'https://example.supabase.co',
  getSupabaseAnonKey: () => 'mock-anon-key',
  isSupabaseConfigured: () => true,
  getSupabaseClient: () => createMockSupabaseClient(),
  resetSupabaseClientCache: () => {},
}));

export { resetMockSupabaseAuth };
