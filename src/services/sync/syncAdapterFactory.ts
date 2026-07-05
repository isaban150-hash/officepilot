import type { SyncProviderKind } from './syncAdapter';
import { LocalSyncAdapter } from './localSyncAdapter';
import type { SyncAdapter } from './syncAdapter';

export interface SyncAdapterFactoryOptions {
  provider?: SyncProviderKind;
}

export function createSyncAdapter(options: SyncAdapterFactoryOptions = {}): SyncAdapter {
  const provider = options.provider ?? 'local';

  switch (provider) {
    case 'local':
      return new LocalSyncAdapter();
    case 'supabase':
    case 'firebase':
    case 'node':
    case 'json':
      throw new Error(`Sync provider "${provider}" ist noch nicht implementiert.`);
    default:
      throw new Error(`Unbekannter Sync provider "${provider as string}".`);
  }
}

export function isSyncProviderAvailable(provider: SyncProviderKind): boolean {
  return provider === 'local';
}
