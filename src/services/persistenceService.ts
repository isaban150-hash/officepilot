import { DEFAULT_SETUP, MOCK_TASKS, MOCK_VORGAENGE } from '../data/mockData';
import { createCompanyProfileFromSetup } from '../data/companyProfileDefaults';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { MOCK_COMPANY_DOCUMENTS } from '../data/documentMockData';
import { MOCK_EXPENSES } from '../data/expenseMockData';
import type { CommunicationEvent } from '../types/communicationHistory';
import type { KnowledgeFact } from '../types/knowledge';
import type { OfficePilotMemoryState } from '../types/memory';
import type { MailImport } from '../types/mailImport';
import type {
  AppPersistedState,
  CompanyDocument,
  CompanyProfile,
  CompanySetup,
  CustomerBilling,
  Expense,
  InboxItem,
  InvoiceNumberSequence,
  InvoicePayment,
  Task,
  Vorgang,
  VorgangInvoice,
  VorgangNote,
} from '../types/models';
import {
  getCompanyProfileStoreSnapshot,
  hydrateCompanyProfileStore,
  resetCompanyProfile,
  syncCompanyProfileFromSetup,
} from './companyProfileService';
import {
  getDocumentStoreSnapshot,
  hydrateDocumentStore,
  resetDocuments,
} from './documentService';
import {
  getUploadedDocumentStoreSnapshot,
  hydrateUploadedDocumentStore,
  resetUploadedDocumentStore,
} from './uploadedDocumentStore';
import {
  backfillMissingFileRefHashes,
  getDocumentFileBlobStoreSnapshot,
  getDocumentFileRefStoreSnapshot,
  hydrateDocumentFileStore,
  resetDocumentFileStoreForTests,
} from './documentFileStoreService';
import {
  getExpenseStoreSnapshot,
  hydrateExpenseStore,
  resetExpenses,
} from './expenseStore';
import {
  getInvoiceNumberSequenceSnapshot,
  hydrateInvoiceNumberSequence,
  resetInvoiceNumberSequence,
} from './invoiceNumberService';
import {
  getInboxStoreSnapshot,
  hydrateInboxStore,
  resetInboxItems,
} from './inboxService';
import {
  getVorgangStoreSnapshot,
  hydrateVorgangStore,
  resetVorgaenge,
} from './vorgangService';
import {
  getCommunicationHistorySnapshot,
  hydrateCommunicationHistory,
} from './communicationHistoryService';
import { resetCommunicationHistoryStore } from './communicationHistoryStore';
import {
  getKnowledgeSnapshot,
  hydrateKnowledgeFacts,
} from './knowledgeService';
import { resetKnowledgeStore } from './knowledgeStore';
import {
  getMailImportSnapshot,
  hydrateMailImports,
  resetMailImports,
} from './mailImportService';
import {
  getOfficePilotMemorySnapshot,
  hydrateMemory,
  resetMemory,
} from './officePilotMemoryService';
import {
  getVorgangNoteStoreSnapshot,
  hydrateVorgangNotes,
  resetVorgangNotes,
} from './vorgangNoteService';
import {
  getTaskStoreSnapshot,
  hydrateTaskStore,
  resetTasks,
} from './taskService';
import { normalizeTask } from './taskNormalize';
import { normalizeExpense } from './expenseNormalize';
import { normalizeExpensePaymentFields } from './expensePaymentCalculations';
import {
  BETA_TEST_COMPANY_PROFILE,
  BETA_TEST_SETUP,
  isBetaTestMode,
} from '../config/betaTestMode';
import {
  applySyncMetadataToState,
  isValidPersistedStateV1,
  isValidPersistedStateV2,
  isValidPersistedStateV3,
  isValidPersistedStateV4,
  migratePersistedStateV1ToV2,
  migratePersistedStateV2ToV3,
  migratePersistedStateV3ToV4,
  STORAGE_VERSION,
} from './sync/syncMigrationService';
import { ensureSyncClientFromState, hydrateSyncClient } from './sync/syncClientService';
import { hydrateSyncOutbox, getSyncOutboxSnapshot } from './sync/syncOutboxService';
import {
  resetSyncChangeTrackerFromState,
  trackPersistedChanges,
} from './sync/syncChangeTrackerService';
import {
  getCompanyProfileSyncSnapshot,
  getSetupSyncSnapshot,
  getWorkspaceMembersSnapshot,
  getWorkspaceSettingsSnapshot,
  getWorkspaceStoreSnapshot,
  hydrateWorkspaceStore,
  resetWorkspaceStore,
} from './workspace/workspaceStore';

export { STORAGE_VERSION } from './sync/syncMigrationService';
export const LEGACY_STORAGE_VERSION = 1;
export const STORAGE_KEY = 'officepilot-state';
export const LEGACY_SETUP_KEY = 'officepilot-setup';

let cachedSetup: CompanySetup = { ...DEFAULT_SETUP };

function cloneInboxItem(item: InboxItem): InboxItem {
  return {
    ...item,
    digitalFolder: { ...item.digitalFolder },
    paperFiling: { ...item.paperFiling },
    recognizedData: { ...item.recognizedData },
    taskTemplate: item.taskTemplate ? { ...item.taskTemplate } : undefined,
    originalRecognizedData: item.originalRecognizedData
      ? { ...item.originalRecognizedData }
      : undefined,
  };
}

function cloneCustomerBilling(billing: CustomerBilling): CustomerBilling {
  return { ...billing };
}

function cloneCompanyProfile(profile: CompanyProfile): CompanyProfile {
  return { ...profile, logoDataUrl: profile.logoDataUrl };
}

function cloneInvoicePayment(payment: InvoicePayment): InvoicePayment {
  return { ...payment };
}

function cloneVorgangInvoice(invoice: VorgangInvoice): VorgangInvoice {
  return {
    ...invoice,
    positions: (invoice.positions ?? []).map((p) => ({ ...p })),
    legalNotices: invoice.legalNotices ? [...invoice.legalNotices] : undefined,
    previousAbschlagDeductions: invoice.previousAbschlagDeductions
      ? invoice.previousAbschlagDeductions.map((item) => ({ ...item }))
      : undefined,
    customerSnapshot: invoice.customerSnapshot
      ? cloneCustomerBilling(invoice.customerSnapshot)
      : undefined,
    companySnapshot: invoice.companySnapshot
      ? cloneCompanyProfile(invoice.companySnapshot)
      : undefined,
    payments: (invoice.payments ?? []).map(cloneInvoicePayment),
  };
}

function cloneVorgang(v: Vorgang): Vorgang {
  return {
    ...v,
    customerBilling: v.customerBilling ? cloneCustomerBilling(v.customerBilling) : undefined,
    orderPositions: (v.orderPositions ?? []).map((p) => ({ ...p })),
    documents: v.documents.map((d) => ({ ...d, paperFiling: d.paperFiling ? { ...d.paperFiling } : undefined })),
    tasks: v.tasks.map((t) => ({ ...t })),
    photos: v.photos.map((p) => ({ ...p })),
    invoices: (v.invoices ?? []).map(cloneVorgangInvoice),
  };
}

function cloneTask(t: Task): Task {
  return normalizeTask(t);
}

function cloneCompanyDocument(doc: CompanyDocument): CompanyDocument {
  return {
    ...doc,
    digitalFolder: { ...doc.digitalFolder },
    paperFolder: { ...doc.paperFolder },
    tags: [...doc.tags],
    linkedVorgang: doc.linkedVorgang ? { ...doc.linkedVorgang } : null,
  };
}

function cloneVorgangNote(note: VorgangNote): VorgangNote {
  return {
    ...note,
    tags: note.tags ? [...note.tags] : undefined,
  };
}

function cloneCommunicationEvent(event: CommunicationEvent): CommunicationEvent {
  return {
    ...event,
    contextRef: { ...event.contextRef },
  };
}

function cloneKnowledgeFact(fact: KnowledgeFact): KnowledgeFact {
  return { ...fact };
}

function cloneMailImport(item: MailImport): MailImport {
  return {
    ...item,
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    linkedInboxIds: [...item.linkedInboxIds],
    linkedDocumentIds: [...item.linkedDocumentIds],
  };
}

function cloneOfficePilotMemoryState(state: OfficePilotMemoryState): OfficePilotMemoryState {
  return {
    documentMemories: (state.documentMemories ?? []).map((item) => ({
      ...item,
      digitalFolder: { ...item.digitalFolder },
      paperFolder: { ...item.paperFolder },
    })),
    proofMemories: (state.proofMemories ?? []).map((item) => ({
      ...item,
      requiredByVorgangIds: [...item.requiredByVorgangIds],
    })),
    relations: (state.relations ?? []).map((item) => ({ ...item })),
    paperRegisterEntries: (state.paperRegisterEntries ?? []).map((item) => ({ ...item })),
  };
}

function cloneExpense(expense: Expense): Expense {
  return normalizeExpensePaymentFields(normalizeExpense(expense));
}

export function loadLegacySetup(): CompanySetup | null {
  try {
    const stored = localStorage.getItem(LEGACY_SETUP_KEY);
    if (stored) {
      return { ...DEFAULT_SETUP, ...JSON.parse(stored) };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function createSeedState(setupOverride?: CompanySetup): AppPersistedState {
  const setup = setupOverride ?? loadLegacySetup() ?? { ...DEFAULT_SETUP };
  const emptyBusinessData = true;
  const companyProfile =
    isBetaTestMode() && setup.setupComplete
      ? { ...BETA_TEST_COMPANY_PROFILE, companyName: setup.companyName || BETA_TEST_SETUP.companyName }
      : createCompanyProfileFromSetup(setup);
  const invoiceNumberSequence: InvoiceNumberSequence = {
    year: new Date().getFullYear(),
    lastIssuedNumber: 0,
  };
  return applySyncMetadataToState(
    {
      version: STORAGE_VERSION,
      syncClient: ensureSyncClientFromState(),
      syncOutbox: [],
      setup,
      companyProfile,
      invoiceNumberSequence,
      inboxItems: emptyBusinessData ? [] : MOCK_INBOX_ITEMS.map(cloneInboxItem),
      vorgaenge: emptyBusinessData ? [] : MOCK_VORGAENGE.map(cloneVorgang),
      tasks: emptyBusinessData
        ? []
        : (MOCK_TASKS as Array<Partial<Task> & Pick<Task, 'id' | 'title'>>).map((t) =>
            normalizeTask(t),
          ),
      documents: emptyBusinessData ? [] : MOCK_COMPANY_DOCUMENTS.map(cloneCompanyDocument),
      uploadedDocuments: [],
      documentFileRefs: [],
      documentFileBlobs: {},
      expenses: emptyBusinessData ? [] : MOCK_EXPENSES.map(cloneExpense),
      vorgangNotes: [],
      communicationHistory: [],
      knowledgeFacts: [],
      officePilotMemory: {
        documentMemories: [],
        proofMemories: [],
        relations: [],
        paperRegisterEntries: [],
      },
      mailImports: [],
      savedAt: new Date().toISOString(),
    },
    ensureSyncClientFromState(),
  );
}

function finalizeLoadedState(state: AppPersistedState): AppPersistedState {
  const client = ensureSyncClientFromState(state.syncClient);
  const withSync = applySyncMetadataToState(
    {
      ...state,
      syncClient: client,
      syncOutbox: state.syncOutbox ?? [],
    },
    client,
  );
  hydrateSyncClient(withSync.syncClient!);
  hydrateSyncOutbox(withSync.syncOutbox ?? []);
  return withSync;
}

function normalizeLoadedState(parsed: unknown): AppPersistedState | null {
  if (isValidPersistedStateV4(parsed)) {
    return finalizeLoadedState(parsed);
  }
  if (isValidPersistedStateV3(parsed)) {
    const migrated = migratePersistedStateV3ToV4(parsed);
    savePersistedState(migrated);
    return finalizeLoadedState(migrated);
  }
  if (isValidPersistedStateV2(parsed)) {
    const migrated = migratePersistedStateV3ToV4(migratePersistedStateV2ToV3(parsed));
    savePersistedState(migrated);
    return finalizeLoadedState(migrated);
  }
  if (isValidPersistedStateV1(parsed)) {
    const migrated = migratePersistedStateV1ToV2(parsed);
    savePersistedState(migrated);
    return finalizeLoadedState(migrated);
  }
  return null;
}

export function loadPersistedState(): AppPersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const normalized = normalizeLoadedState(parsed);
    if (!normalized) {
      console.warn('[OfficePilot] Ungültiger gespeicherter Zustand – Seed-Daten werden verwendet.');
      return null;
    }
    return {
      ...normalized,
      setup: { ...DEFAULT_SETUP, ...normalized.setup },
      companyProfile: normalized.companyProfile
        ? cloneCompanyProfile({
            ...createCompanyProfileFromSetup(normalized.setup),
            ...normalized.companyProfile,
          })
        : createCompanyProfileFromSetup({ ...DEFAULT_SETUP, ...normalized.setup }),
      invoiceNumberSequence: normalized.invoiceNumberSequence ?? {
        year: new Date().getFullYear(),
        lastIssuedNumber: 0,
      },
      inboxItems: normalized.inboxItems.map(cloneInboxItem),
      vorgaenge: normalized.vorgaenge.map(cloneVorgang),
      tasks: normalized.tasks.map(cloneTask),
      documents: (normalized.documents ?? MOCK_COMPANY_DOCUMENTS).map(cloneCompanyDocument),
      expenses: (normalized.expenses ?? []).map(cloneExpense),
      vorgangNotes: (normalized.vorgangNotes ?? []).map(cloneVorgangNote),
      communicationHistory: (normalized.communicationHistory ?? []).map(cloneCommunicationEvent),
      knowledgeFacts: (normalized.knowledgeFacts ?? []).map(cloneKnowledgeFact),
      officePilotMemory: cloneOfficePilotMemoryState(
        normalized.officePilotMemory ?? {
          documentMemories: [],
          proofMemories: [],
          relations: [],
          paperRegisterEntries: [],
        },
      ),
      mailImports: (normalized.mailImports ?? []).map(cloneMailImport),
    };
  } catch (error) {
    console.warn('[OfficePilot] localStorage konnte nicht gelesen werden:', error);
    return null;
  }
}

export function savePersistedState(state: AppPersistedState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('[OfficePilot] Speichern fehlgeschlagen:', error);
  }
}

export function clearPersistedState(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function setCachedSetup(setup: CompanySetup): void {
  cachedSetup = { ...setup };
}

export function getCachedSetup(): CompanySetup {
  return { ...cachedSetup };
}

function applyStateToStores(state: AppPersistedState): void {
  const client = ensureSyncClientFromState(state.syncClient);
  hydrateSyncClient(client);
  hydrateSyncOutbox(state.syncOutbox ?? []);
  cachedSetup = { ...DEFAULT_SETUP, ...state.setup };
  hydrateCompanyProfileStore(
    state.companyProfile ?? createCompanyProfileFromSetup(cachedSetup),
  );
  syncCompanyProfileFromSetup(cachedSetup.companyName);
  hydrateInvoiceNumberSequence(
    state.invoiceNumberSequence ?? {
      year: new Date().getFullYear(),
      lastIssuedNumber: 0,
    },
  );
  hydrateInboxStore(state.inboxItems);
  hydrateVorgangStore(state.vorgaenge);
  hydrateTaskStore(state.tasks);
  hydrateDocumentStore(state.documents ?? []);
  hydrateUploadedDocumentStore(state.uploadedDocuments ?? []);
  hydrateDocumentFileStore(state.documentFileRefs ?? [], state.documentFileBlobs ?? {});
  hydrateExpenseStore(state.expenses ?? []);
  hydrateVorgangNotes(state.vorgangNotes ?? []);
  hydrateCommunicationHistory(state.communicationHistory ?? []);
  hydrateKnowledgeFacts(state.knowledgeFacts ?? []);
  hydrateMemory(
    state.officePilotMemory ?? {
      documentMemories: [],
      proofMemories: [],
      relations: [],
      paperRegisterEntries: [],
    },
  );
  hydrateMailImports(state.mailImports ?? []);
  hydrateWorkspaceStore({
    workspace: state.workspace ?? null,
    workspaceMembers: state.workspaceMembers ?? [],
    workspaceSettings: state.workspaceSettings ?? null,
    setupSync: state.setupSync ?? null,
    companyProfileSync: state.companyProfileSync ?? null,
  });
  resetSyncChangeTrackerFromState(state);
}

function bootstrapBetaTestState(): CompanySetup {
  const seed = createSeedState({ ...BETA_TEST_SETUP });
  const betaSeed: AppPersistedState = {
    ...seed,
    setup: { ...BETA_TEST_SETUP },
    companyProfile: { ...BETA_TEST_COMPANY_PROFILE },
    invoiceNumberSequence: seed.invoiceNumberSequence ?? {
      year: new Date().getFullYear(),
      lastIssuedNumber: 0,
    },
  };
  applyStateToStores(betaSeed);
  savePersistedState(betaSeed);
  return getCachedSetup();
}

export function hydrateStoresFromStorage(): CompanySetup {
  if (isBetaTestMode()) {
    const stored = loadPersistedState();
    if (stored && stored.setup.setupComplete) {
      applyStateToStores(stored);
      return getCachedSetup();
    }
    return bootstrapBetaTestState();
  }

  const stored = loadPersistedState();
  if (stored) {
    applyStateToStores(stored);
    void backfillMissingFileRefHashes().then(() => persistAll());
    return getCachedSetup();
  }

  const seed = createSeedState();
  applyStateToStores(seed);
  savePersistedState(seed);
  return getCachedSetup();
}

export function persistAll(setupOverride?: CompanySetup): void {
  if (setupOverride) {
    cachedSetup = { ...setupOverride };
  }

  const snapshot = buildPersistedStateSnapshot();
  trackPersistedChanges(snapshot);
  savePersistedState({
    ...snapshot,
    syncOutbox: getSyncOutboxSnapshot(),
    savedAt: new Date().toISOString(),
  });
}

export function seedSyncChangeTrackerFromCurrentStores(): void {
  resetSyncChangeTrackerFromState(buildPersistedStateSnapshot());
}

export function buildPersistedStateSnapshot(): AppPersistedState {
  return {
    version: STORAGE_VERSION,
    syncClient: ensureSyncClientFromState(),
    syncOutbox: getSyncOutboxSnapshot(),
    workspace: getWorkspaceStoreSnapshot() ?? undefined,
    workspaceMembers: getWorkspaceMembersSnapshot(),
    workspaceSettings: getWorkspaceSettingsSnapshot() ?? undefined,
    setupSync: getSetupSyncSnapshot() ?? undefined,
    companyProfileSync: getCompanyProfileSyncSnapshot() ?? undefined,
    setup: getCachedSetup(),
    companyProfile: getCompanyProfileStoreSnapshot(),
    invoiceNumberSequence: getInvoiceNumberSequenceSnapshot(),
    inboxItems: getInboxStoreSnapshot(),
    vorgaenge: getVorgangStoreSnapshot(),
    tasks: getTaskStoreSnapshot(),
    documents: getDocumentStoreSnapshot(),
    uploadedDocuments: getUploadedDocumentStoreSnapshot(),
    documentFileRefs: getDocumentFileRefStoreSnapshot(),
    documentFileBlobs: getDocumentFileBlobStoreSnapshot(),
    expenses: getExpenseStoreSnapshot(),
    vorgangNotes: getVorgangNoteStoreSnapshot(),
    communicationHistory: getCommunicationHistorySnapshot(),
    knowledgeFacts: getKnowledgeSnapshot(),
    officePilotMemory: getOfficePilotMemorySnapshot(),
    mailImports: getMailImportSnapshot().map(cloneMailImport),
    savedAt: new Date().toISOString(),
  };
}

export function applyPersistedStateFromSync(state: AppPersistedState): void {
  applyStateToStores(state);
  savePersistedState(state);
}

export function resetDemoData(options?: { keepSetup?: boolean }): CompanySetup {
  const keepSetup = options?.keepSetup ?? false;
  const setup = keepSetup ? getCachedSetup() : { ...DEFAULT_SETUP, setupComplete: false };

  resetInboxItems();
  resetVorgaenge();
  resetTasks();
  resetDocuments();
  resetUploadedDocumentStore();
  resetDocumentFileStoreForTests();
  resetExpenses();
  resetVorgangNotes();
  resetCommunicationHistoryStore();
  resetMailImports();
  resetKnowledgeStore();
  resetMemory();
  resetCompanyProfile(setup.companyName);
  resetInvoiceNumberSequence();
  resetWorkspaceStore();

  const seed = createSeedState(setup);
  applyStateToStores(seed);
  savePersistedState(seed);

  if (!keepSetup) {
    localStorage.removeItem(LEGACY_SETUP_KEY);
  }

  return getCachedSetup();
}
