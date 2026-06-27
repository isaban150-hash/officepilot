import { DEFAULT_SETUP } from '../data/mockData';
import { hydrateInboxStore } from '../services/inboxService';
import { setCachedSetup } from '../services/persistenceService';
import { hydrateTaskStore } from '../services/taskService';
import { hydrateVorgangStore } from '../services/vorgangService';

export function resetTestStores(): void {
  hydrateInboxStore([]);
  hydrateVorgangStore([]);
  hydrateTaskStore([]);
  setCachedSetup({ ...DEFAULT_SETUP });
}
