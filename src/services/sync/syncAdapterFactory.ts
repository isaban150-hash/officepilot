import type { SyncProviderKind } from './syncAdapter';
import { LocalSyncAdapter } from './localSyncAdapter';
import { createSupabaseSyncAdapter } from './supabaseSyncAdapter';
import type { SyncAdapter } from './syncAdapter';
import { isSupabaseConfigured } from '../../lib/supabase';

export interface SyncAdapterFactoryOptions {
  provider?: SyncProviderKind;
}

export function createSyncAdapter(options: SyncAdapterFactoryOptions = {}): SyncAdapter {
  const provider = options.provider ?? 'local';

  switch (provider) {
    case 'local':
      return new LocalSyncAdapter();
    case 'supabase':
      return createSupabaseSyncAdapter();
    case 'firebase':
    case 'node':
    case 'json':
      throw new Error(`Sync provider "${provider}" ist noch nicht implementiert.`);
    default:
      throw new Error(`Unbekannter Sync provider "${provider as string}".`);
  }
}

export function isSyncProviderAvailable(provider: SyncProviderKind): boolean {
  if (provider === 'local') return true;
  if (provider === 'supabase') return isSupabaseConfigured();
  return false;
}
