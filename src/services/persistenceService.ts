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
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
  resetDocumentFileRepresentationBindingStoreForTests,
} from './documentFileRepresentationBindingStoreService';
import {
  getDocumentFileDerivativeStepOutcomeStoreSnapshot,
  hydrateDocumentFileDerivativeStepOutcomeStore,
  resetDocumentFileDerivativeStepOutcomeStoreForTests,
} from './documentFileDerivativeStepOutcomeStoreService';
import {
  getDocumentFileDerivativeRecoveryContextStoreSnapshot,
  hydrateDocumentFileDerivativeRecoveryContextStore,
  resetDocumentFileDerivativeRecoveryContextStoreForTests,
} from './documentFileDerivativeRecoveryContextStoreService';
import {
  getDocumentFileIntakeTransformPlanCarryContextStoreSnapshot,
  hydrateDocumentFileIntakeTransformPlanCarryContextStore,
  resetDocumentFileIntakeTransformPlanCarryContextStoreForTests,
} from './documentFileIntakeTransformPlanCarryContextStoreService';
import {
  getDocumentWorkResultStoreSnapshot,
  hydrateDocumentWorkResultStore,
  resetDocumentWorkResultStoreForTests,
} from './documentWorkResultStoreService';
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
  getDunningDocumentationStoreSnapshot,
  hydrateDunningDocumentations,
  resetDunningDocumentations,
} from './dunningDocumentationService';
import {
  getTaskStoreSnapshot,
  hydrateTaskStore,
  resetTasks,
} from './taskService';
import { normalizeTask } from './taskNormalize';
import {
  cloneCustomer,
  getCustomerStoreSnapshot,
  hydrateCustomerStore,
  resetCustomers,
} from './customerStoreService';
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
  isValidPersistedStateV5,
  migratePersistedStateV1ToV2,
  migratePersistedStateV2ToV3,
  migratePersistedStateV3ToV4,
  migratePersistedStateV4ToV5,
  STORAGE_VERSION,
} from './sync/syncMigrationService';
import { ensureSyncClientFromState, hydrateSyncClient } from './sync/syncClientService';
import { hydrateSyncOutbox, getSyncOutboxSnapshot } from './sync/syncOutboxService';
import {
  resetSyncChangeTrackerFromState,
  trackPersistedChanges,
  captureSyncChangeTrackerState,
  restoreSyncChangeTrackerState,
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
import { LEGACY_SETUP_KEY } from './storage/storageScopeService';

export { STORAGE_VERSION } from './sync/syncMigrationService';
export const LEGACY_STORAGE_VERSION = 1;
export {
  STORAGE_KEY,
  LEGACY_GLOBAL_STORAGE_KEY,
  LEGACY_SETUP_KEY,
  buildStorageKey,
  getActiveStorageKey,
  getActiveStorageScope,
  setActiveStorageScope,
  resetStorageScopeForTests,
  type StorageScope,
} from './storage/storageScopeService';

export type PersistFailurePhase =
  | 'build_snapshot'
  | 'json_stringify'
  | 'localStorage_setItem';

export type PersistFailureReason =
  | 'quota_exceeded'
  | 'serialization_failed'
  | 'storage_unavailable'
  | 'unknown_persist_error';

export interface PersistFailureDiagnostic {
  phase: PersistFailurePhase;
  reason: PersistFailureReason;
  errorName: string;
  errorMessage: string;
  payloadCharacters: number;
  payloadBytesApprox: number;
  storageKey: string;
  existingStoredCharacters?: number;
}

export interface PersistFailureInfo {
  reason: PersistFailureReason;
  diagnostic?: PersistFailureDiagnostic;
}

export interface PersistSaveResult {
  success: boolean;
  failure?: PersistFailureInfo;
}

export type PersistResult = PersistSaveResult;

const PERSIST_ERROR_MESSAGE_MAX_LENGTH = 200;

let persistDiagnosticOverride: boolean | null = null;

export function setPersistDiagnosticEnabledForTests(enabled: boolean | null): void {
  persistDiagnosticOverride = enabled;
}

export function isPersistDiagnosticEnabled(): boolean {
  if (persistDiagnosticOverride !== null) return persistDiagnosticOverride;
  return import.meta.env.DEV || import.meta.env.MODE === 'test';
}

function truncatePersistErrorMessage(message: string): string {
  if (message.length <= PERSIST_ERROR_MESSAGE_MAX_LENGTH) return message;
  return message.slice(0, PERSIST_ERROR_MESSAGE_MAX_LENGTH);
}

function resolvePersistErrorName(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string' && name.length > 0) return name;
  }
  return 'Error';
}

function resolvePersistErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return truncatePersistErrorMessage(error.message);
  }
  if (typeof error === 'string') return truncatePersistErrorMessage(error);
  return 'Unbekannter Fehler';
}

function classifyPersistFailureReason(
  error: unknown,
  phase: PersistFailurePhase,
): PersistFailureReason {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return 'quota_exceeded';
  }
  if (phase === 'json_stringify') {
    return 'serialization_failed';
  }
  if (
    error instanceof DOMException &&
    (error.name === 'SecurityError' || error.name === 'InvalidStateError')
  ) {
    return 'storage_unavailable';
  }
  if (error instanceof ReferenceError) {
    return 'storage_unavailable';
  }
  return 'unknown_persist_error';
}

function readExistingStoredCharacters(storageKey: string): number | undefined {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw === null ? 0 : raw.length;
  } catch {
    return undefined;
  }
}

function estimatePayloadBytes(serialized: string): number {
  return new TextEncoder().encode(serialized).length;
}

function buildPersistFailureInfo(
  phase: PersistFailurePhase,
  error: unknown,
  context: {
    storageKey: string;
    payloadCharacters?: number;
    payloadBytesApprox?: number;
    existingStoredCharacters?: number;
  },
): PersistFailureInfo {
  const reason = classifyPersistFailureReason(error, phase);
  const info: PersistFailureInfo = { reason };
  if (isPersistDiagnosticEnabled()) {
    info.diagnostic = {
      phase,
      reason,
      errorName: resolvePersistErrorName(error),
      errorMessage: resolvePersistErrorMessage(error),
      payloadCharacters: context.payloadCharacters ?? 0,
      payloadBytesApprox: context.payloadBytesApprox ?? 0,
      storageKey: context.storageKey,
      ...(context.existingStoredCharacters !== undefined
        ? { existingStoredCharacters: context.existingStoredCharacters }
        : {}),
    };
  }
  return info;
}

let cachedSetup: CompanySetup = { ...DEFAULT_SETUP };
let lastPersistSuccess = true;
let lastPersistFailure: PersistFailureInfo | null = null;

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
    filingDecision: item.filingDecision ? { ...item.filingDecision } : undefined,
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
    archiveTruthSnapshot: doc.archiveTruthSnapshot
      ? (JSON.parse(JSON.stringify(doc.archiveTruthSnapshot)) as typeof doc.archiveTruthSnapshot)
      : undefined,
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
      documentFileRepresentationBindings: [],
      documentFileDerivativeStepOutcomes: [],
      documentFileDerivativeRecoveryContexts: [],
      documentFileIntakeTransformPlanCarryContexts: [],
      documentWorkResults: [],
      expenses: emptyBusinessData ? [] : MOCK_EXPENSES.map(cloneExpense),
      // No seeded customers and no backfill from Vorgang.customer.
      customers: [],
      vorgangNotes: [],
      dunningDocumentations: [],
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

import {
  buildStorageKey,
  getActiveStorageKey,
  getActiveStorageScope,
  setActiveStorageScope,
  type StorageScope,
} from './storage/storageScopeService';
import { notifyPersistenceHealthChanged } from './persistenceHealthService';

function publishPersistenceHealth(): void {
  notifyPersistenceHealthChanged({
    healthy: lastPersistSuccess,
    hasFailure: !lastPersistSuccess || lastPersistFailure !== null,
  });
}

function normalizeLoadedState(parsed: unknown, persistMigrations = true): AppPersistedState | null {
  if (isValidPersistedStateV5(parsed)) {
    return finalizeLoadedState(parsed);
  }
  if (isValidPersistedStateV4(parsed)) {
    const migrated = migratePersistedStateV4ToV5(parsed);
    if (persistMigrations) savePersistedState(migrated);
    return finalizeLoadedState(migrated);
  }
  if (isValidPersistedStateV3(parsed)) {
    const migrated = migratePersistedStateV4ToV5(migratePersistedStateV3ToV4(parsed));
    if (persistMigrations) savePersistedState(migrated);
    return finalizeLoadedState(migrated);
  }
  if (isValidPersistedStateV2(parsed)) {
    const migrated = migratePersistedStateV4ToV5(
      migratePersistedStateV3ToV4(migratePersistedStateV2ToV3(parsed)),
    );
    if (persistMigrations) savePersistedState(migrated);
    return finalizeLoadedState(migrated);
  }
  if (isValidPersistedStateV1(parsed)) {
    const migrated = migratePersistedStateV4ToV5(migratePersistedStateV1ToV2(parsed));
    if (persistMigrations) savePersistedState(migrated);
    return finalizeLoadedState(migrated);
  }
  return null;
}

function finalizeLoadedPersistedState(normalized: AppPersistedState): AppPersistedState {
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
    documents: (normalized.documents ?? []).map(cloneCompanyDocument),
    expenses: (normalized.expenses ?? []).map(cloneExpense),
    customers: (normalized.customers ?? []).map(cloneCustomer),
    vorgangNotes: (normalized.vorgangNotes ?? []).map(cloneVorgangNote),
    dunningDocumentations: (normalized.dunningDocumentations ?? []).map((doc) => ({ ...doc })),
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
}

export function loadPersistedStateFromKey(storageKey: string): AppPersistedState | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const normalized = normalizeLoadedState(parsed, storageKey === getActiveStorageKey());
    if (!normalized) {
      console.warn('[OfficePilot] Ungültiger gespeicherter Zustand – Seed-Daten werden verwendet.');
      return null;
    }
    return finalizeLoadedPersistedState(normalized);
  } catch (error) {
    console.warn('[OfficePilot] localStorage konnte nicht gelesen werden:', error);
    return null;
  }
}

export function loadPersistedState(): AppPersistedState | null {
  return loadPersistedStateFromKey(getActiveStorageKey());
}

export function savePersistedStateToKey(
  scope: StorageScope,
  state: AppPersistedState,
): PersistSaveResult {
  const storageKey = buildStorageKey(scope);
  const existingStoredCharacters = readExistingStoredCharacters(storageKey);

  let serialized = '';
  try {
    serialized = JSON.stringify(state);
  } catch (error) {
    const failure = buildPersistFailureInfo('json_stringify', error, {
      storageKey,
      existingStoredCharacters,
    });
    console.warn('[OfficePilot] Speichern fehlgeschlagen:', error);
    lastPersistFailure = failure;
    return { success: false, failure };
  }

  const payloadCharacters = serialized.length;
  const payloadBytesApprox = estimatePayloadBytes(serialized);

  try {
    localStorage.setItem(storageKey, serialized);
    lastPersistFailure = null;
    return { success: true };
  } catch (error) {
    const failure = buildPersistFailureInfo('localStorage_setItem', error, {
      storageKey,
      payloadCharacters,
      payloadBytesApprox,
      existingStoredCharacters,
    });
    console.warn('[OfficePilot] Speichern fehlgeschlagen:', error);
    lastPersistFailure = failure;
    return { success: false, failure };
  }
}

export function savePersistedState(state: AppPersistedState): boolean {
  return savePersistedStateToKey(getActiveStorageScope(), state).success;
}

export function clearPersistedState(): void {
  localStorage.removeItem(getActiveStorageKey());
}

export function clearPersistedStateForScope(scope: StorageScope): void {
  localStorage.removeItem(buildStorageKey(scope));
}

export function setCachedSetup(setup: CompanySetup): void {
  cachedSetup = { ...setup };
}

export function getCachedSetup(): CompanySetup {
  return { ...cachedSetup };
}

export function clearInMemoryBusinessState(): void {
  resetInboxItems();
  resetVorgaenge();
  resetTasks();
  resetDocuments();
  resetUploadedDocumentStore();
  resetDocumentFileStoreForTests();
  resetDocumentFileRepresentationBindingStoreForTests();
  resetDocumentFileDerivativeStepOutcomeStoreForTests();
  resetDocumentFileDerivativeRecoveryContextStoreForTests();
  resetDocumentFileIntakeTransformPlanCarryContextStoreForTests();
  resetDocumentWorkResultStoreForTests();
  resetExpenses();
  resetCustomers();
  resetVorgangNotes();
  resetDunningDocumentations();
  resetCommunicationHistoryStore();
  resetMailImports();
  resetKnowledgeStore();
  resetMemory();
  resetCompanyProfile(DEFAULT_SETUP.companyName);
  resetInvoiceNumberSequence();
  resetWorkspaceStore();
  cachedSetup = { ...DEFAULT_SETUP };
}

export function applyStateToStores(state: AppPersistedState): void {
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
  hydrateDocumentFileRepresentationBindingStore(state.documentFileRepresentationBindings ?? []);
  hydrateDocumentFileDerivativeStepOutcomeStore(state.documentFileDerivativeStepOutcomes ?? []);
  hydrateDocumentFileDerivativeRecoveryContextStore(
    state.documentFileDerivativeRecoveryContexts ?? [],
  );
  hydrateDocumentFileIntakeTransformPlanCarryContextStore(
    state.documentFileIntakeTransformPlanCarryContexts ?? [],
  );
  hydrateDocumentWorkResultStore(state.documentWorkResults ?? []);
  hydrateExpenseStore(state.expenses ?? []);
  hydrateCustomerStore(state.customers ?? []);
  hydrateVorgangNotes(state.vorgangNotes ?? []);
  hydrateDunningDocumentations(state.dunningDocumentations ?? []);
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

/** @deprecated Use bootstrapBusinessState() from storageBootstrapService after auth. */
export function hydrateStoresFromStorage(): CompanySetup {
  if (isBetaTestMode()) {
    const stored = loadPersistedState();
    if (stored && stored.setup.setupComplete) {
      applyStateToStores(stored);
      return getCachedSetup();
    }
    return bootstrapBetaTestState();
  }

  setActiveStorageScope({ type: 'guest' });
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


export function getLastPersistSuccess(): boolean {
  return lastPersistSuccess;
}

export function getLastPersistFailure(): PersistFailureInfo | null {
  return lastPersistFailure;
}

export function getPersistFailureDiagnosticForDev(): PersistFailureDiagnostic | null {
  if (!isPersistDiagnosticEnabled()) return null;
  return lastPersistFailure?.diagnostic ?? null;
}

export function resetLastPersistFailureForTests(): void {
  lastPersistFailure = null;
  lastPersistSuccess = true;
  persistDiagnosticOverride = null;
  publishPersistenceHealth();
}

export function persistAll(setupOverride?: CompanySetup): PersistResult {
  if (setupOverride) {
    cachedSetup = { ...setupOverride };
  }

  const storageKey = buildStorageKey(getActiveStorageScope());
  const existingStoredCharacters = readExistingStoredCharacters(storageKey);
  const syncOutboxBefore = getSyncOutboxSnapshot();
  const syncTrackerBefore = captureSyncChangeTrackerState();

  let snapshot: AppPersistedState;
  try {
    snapshot = buildPersistedStateSnapshot();
  } catch (error) {
    const failure = buildPersistFailureInfo('build_snapshot', error, {
      storageKey,
      existingStoredCharacters,
    });
    console.warn('[OfficePilot] Speichern fehlgeschlagen:', error);
    lastPersistFailure = failure;
    lastPersistSuccess = false;
    publishPersistenceHealth();
    return { success: false, failure };
  }

  trackPersistedChanges(snapshot);
  const saveResult = savePersistedStateToKey(getActiveStorageScope(), {
    ...snapshot,
    syncOutbox: getSyncOutboxSnapshot(),
    savedAt: new Date().toISOString(),
  });

  if (!saveResult.success) {
    hydrateSyncOutbox(syncOutboxBefore);
    restoreSyncChangeTrackerState(syncTrackerBefore);
    lastPersistFailure = saveResult.failure ?? null;
    lastPersistSuccess = false;
    publishPersistenceHealth();
    return { success: false, failure: saveResult.failure };
  }

  lastPersistFailure = null;
  lastPersistSuccess = true;
  publishPersistenceHealth();
  return { success: true };
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
    documentFileRepresentationBindings: getDocumentFileRepresentationBindingStoreSnapshot(),
    documentFileDerivativeStepOutcomes: getDocumentFileDerivativeStepOutcomeStoreSnapshot(),
    documentFileDerivativeRecoveryContexts:
      getDocumentFileDerivativeRecoveryContextStoreSnapshot(),
    documentFileIntakeTransformPlanCarryContexts:
      getDocumentFileIntakeTransformPlanCarryContextStoreSnapshot(),
    documentWorkResults: getDocumentWorkResultStoreSnapshot(),
    expenses: getExpenseStoreSnapshot(),
    customers: getCustomerStoreSnapshot(),
    vorgangNotes: getVorgangNoteStoreSnapshot(),
    dunningDocumentations: getDunningDocumentationStoreSnapshot(),
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
  resetDocumentFileRepresentationBindingStoreForTests();
  resetDocumentFileDerivativeStepOutcomeStoreForTests();
  resetDocumentFileDerivativeRecoveryContextStoreForTests();
  resetDocumentFileIntakeTransformPlanCarryContextStoreForTests();
  resetDocumentWorkResultStoreForTests();
  resetExpenses();
  resetCustomers();
  resetVorgangNotes();
  resetDunningDocumentations();
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
