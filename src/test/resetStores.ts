import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { hydrateDocumentStore } from '../services/documentService';
import { hydrateExpenseStore } from '../services/expenseStore';
import {
  hydrateCompanyProfileStore,
} from '../services/companyProfileService';
import {
  hydrateInvoiceNumberSequence,
} from '../services/invoiceNumberService';
import { hydrateInboxStore } from '../services/inboxService';
import { resetLastPersistFailureForTests, setCachedSetup } from '../services/persistenceService';
import { hydrateTaskStore } from '../services/taskService';
import { hydrateVorgangStore } from '../services/vorgangService';
import { hydrateVorgangNotes } from '../services/vorgangNoteService';
import { resetCommunicationHistoryStore } from '../services/communicationHistoryStore';
import { resetKnowledgeStore } from '../services/knowledgeStore';
import { resetUploadedDocumentStore } from '../services/uploadedDocumentStore';
import { resetSyncChangeTrackerForTests } from '../services/sync/syncChangeTrackerService';
import { resetSyncCoordinatorForTests } from '../services/sync/syncCoordinator';
import { resetSyncClientForTests } from '../services/sync/syncClientService';
import { resetSyncOutboxForTests } from '../services/sync/syncOutboxService';
import { resetWorkspaceStore } from '../services/workspace/workspaceStore';
import { resetDocumentFileStoreForTests } from '../services/documentFileStoreService';
import { resetWorkspaceCloudBootstrapForTests } from '../services/workspace/workspaceCloudBootstrapService';
import { resetStorageScopeForTests } from '../services/storage/storageScopeService';

export function resetTestStores(): void {
  resetStorageScopeForTests();
  hydrateInboxStore([]);
  hydrateVorgangStore([]);
  hydrateTaskStore([]);
  hydrateDocumentStore([]);
  resetUploadedDocumentStore();
  resetDocumentFileStoreForTests();
  hydrateExpenseStore([]);
  hydrateVorgangNotes([]);
  resetCommunicationHistoryStore();
  resetKnowledgeStore();
  setCachedSetup({ ...DEFAULT_SETUP });
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Test GmbH' });
  hydrateInvoiceNumberSequence({ year: 2026, lastIssuedNumber: 0 });
  resetWorkspaceStore();
  resetSyncOutboxForTests([]);
  resetSyncClientForTests();
  resetSyncChangeTrackerForTests();
  resetSyncCoordinatorForTests();
  resetWorkspaceCloudBootstrapForTests();
  resetLastPersistFailureForTests();
}
