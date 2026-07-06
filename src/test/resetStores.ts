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
import { setCachedSetup } from '../services/persistenceService';
import { hydrateTaskStore } from '../services/taskService';
import { hydrateVorgangStore } from '../services/vorgangService';
import { hydrateVorgangNotes } from '../services/vorgangNoteService';
import { resetCommunicationHistoryStore } from '../services/communicationHistoryStore';
import { resetKnowledgeStore } from '../services/knowledgeStore';
import { resetUploadedDocumentStore } from '../services/uploadedDocumentStore';

export function resetTestStores(): void {
  hydrateInboxStore([]);
  hydrateVorgangStore([]);
  hydrateTaskStore([]);
  hydrateDocumentStore([]);
  resetUploadedDocumentStore();
  hydrateExpenseStore([]);
  hydrateVorgangNotes([]);
  resetCommunicationHistoryStore();
  resetKnowledgeStore();
  setCachedSetup({ ...DEFAULT_SETUP });
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Test GmbH' });
  hydrateInvoiceNumberSequence({ year: 2026, lastIssuedNumber: 0 });
}
