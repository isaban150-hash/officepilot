import { DEFAULT_SETUP } from '../data/mockData';
import { hydrateDocumentStore } from '../services/documentService';
import { hydrateInboxStore } from '../services/inboxService';
import { setCachedSetup } from '../services/persistenceService';
import { hydrateTaskStore } from '../services/taskService';
import { hydrateVorgangStore } from '../services/vorgangService';

export function resetTestStores(): void {
  hydrateInboxStore([]);
  hydrateVorgangStore([]);
  hydrateTaskStore([]);
  hydrateDocumentStore([]);
  setCachedSetup({ ...DEFAULT_SETUP });
}
