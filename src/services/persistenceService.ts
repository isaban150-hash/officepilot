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
  isValidPersistedStateV6,
  migratePersistedStateV1ToV2,
  migratePersistedStateV2ToV3,
  migratePersistedStateV3ToV4,
  migratePersistedStateV4ToV5,
  migratePersistedStateV5ToV6,
  STORAGE_VERSION,
} from './sync/syncMigrationService';
import { getInvoiceStoreSnapshot, hydrateInvoiceStore } from './invoice/invoiceStore';
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
  | 'unknown_persist_error'
  /** LOAD_FAILED-UX-GUARD-01B — der Bereich ist wegen eines Ladefehlers gesperrt. */
  | 'load_failed_lock';

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

/**
 * PERSISTENCE-MIGRATION-FAILURE-GUARD-01B2 — Sync-Metadaten berechnen, ohne sie
 * zu übernehmen.
 *
 * Bis hierher hydrierte diese Funktion `syncClient` und `syncOutbox` sofort —
 * über `ensureSyncClientFromState(state.syncClient)` schon in ihrer ersten
 * Zeile. Sie läuft aber **vor** der Aufbereitung, die noch scheitern kann. Ein
 * später abgebrochener Ladevorgang hinterliess damit einen halb übernommenen
 * Stand: Fachdaten unberührt, Sync-Zustand bereits der des fehlerhaften
 * Datensatzes.
 *
 * Der Client wird deshalb nur noch **gelesen**: der gespeicherte, sonst der
 * bereits vorhandene. Übernommen wird er erst, wenn die gesamte Kette steht —
 * siehe `adoptLoadedSyncState`.
 */
function withLoadedSyncMetadata(state: AppPersistedState): AppPersistedState {
  const client = state.syncClient ?? ensureSyncClientFromState();
  return applySyncMetadataToState(
    {
      ...state,
      syncClient: client,
      syncOutbox: state.syncOutbox ?? [],
    },
    client,
  );
}

/** Der Sync-Zustand eines vollständig geladenen Datensatzes — erst jetzt gültig. */
function adoptLoadedSyncState(state: AppPersistedState): void {
  if (state.syncClient) hydrateSyncClient(state.syncClient);
  hydrateSyncOutbox(state.syncOutbox ?? []);
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

/**
 * PERSISTENCE-MIGRATION-FAILURE-GUARD-01B2 — das Ergebnis der Versions- und
 * Migrationsstufe.
 *
 * `migrated` ist der Stand, der **nach erfolgreichem Abschluss der gesamten
 * Ladekette** zurückgeschrieben werden soll. Bis dahin wird nichts gespeichert:
 * Der Rückschreibvorgang lag bisher direkt hier, also vor der Aufbereitung —
 * scheiterte diese, war der Rohwert bereits durch den migrierten Stand ersetzt,
 * obwohl der Ladevorgang als gescheitert galt.
 */
interface NormalizedLoadedState {
  state: AppPersistedState;
  migrated: AppPersistedState | null;
}

function normalizeLoadedState(parsed: unknown): NormalizedLoadedState | null {
  if (isValidPersistedStateV6(parsed)) {
    return { state: withLoadedSyncMetadata(parsed), migrated: null };
  }
  /*
   * FIRST-CLASS-LOCAL-INVOICE-STORE-01B — jede ältere Fassung endet über die
   * bestehende Kette bei V5 und wird von dort ein einziges Mal nach V6
   * gehoben. Die Fachlogik der Stufen V1–V5 bleibt unangetastet.
   */
  if (isValidPersistedStateV5(parsed)) {
    const migrated = migratePersistedStateV5ToV6(parsed);
    return { state: withLoadedSyncMetadata(migrated), migrated };
  }
  if (isValidPersistedStateV4(parsed)) {
    const migrated = migratePersistedStateV5ToV6(migratePersistedStateV4ToV5(parsed));
    return { state: withLoadedSyncMetadata(migrated), migrated };
  }
  if (isValidPersistedStateV3(parsed)) {
    const migrated = migratePersistedStateV5ToV6(
      migratePersistedStateV4ToV5(migratePersistedStateV3ToV4(parsed)),
    );
    return { state: withLoadedSyncMetadata(migrated), migrated };
  }
  if (isValidPersistedStateV2(parsed)) {
    const migrated = migratePersistedStateV5ToV6(
      migratePersistedStateV4ToV5(migratePersistedStateV3ToV4(migratePersistedStateV2ToV3(parsed))),
    );
    return { state: withLoadedSyncMetadata(migrated), migrated };
  }
  if (isValidPersistedStateV1(parsed)) {
    const migrated = migratePersistedStateV5ToV6(
      migratePersistedStateV4ToV5(migratePersistedStateV1ToV2(parsed)),
    );
    return { state: withLoadedSyncMetadata(migrated), migrated };
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

/**
 * PERSISTENCE-MIGRATION-FAILURE-GUARD-01B — warum ein Ladeversuch scheiterte.
 *
 * Rein beschreibend; der Aufrufer entscheidet allein anhand von `status`.
 */
export type PersistedStateLoadFailureReason =
  /** `localStorage` selbst war nicht lesbar. */
  | 'storage_unavailable'
  /** Der gespeicherte Text ist kein gültiges JSON. */
  | 'parse_error'
  /** Gültiges JSON, aber von keinem Versionsvalidator erkannt. */
  | 'unrecognized_state'
  /** Migration, Normalisierung oder Finalisierung hat geworfen. */
  | 'migration_failed';

/**
 * PERSISTENCE-MIGRATION-FAILURE-GUARD-01B — **„keine Daten" und „Daten nicht
 * lesbar" sind nicht dasselbe.**
 *
 * Der Ladepfad lieferte für beides `null`. Die Aufrufer schlossen daraus auf
 * einen Erststart, wendeten leere Seed-Daten an und schrieben sie über den
 * vorhandenen Schlüssel — ein Parse-, Migrations- oder Normalisierungsfehler
 * löschte damit den gesamten lokalen Bestand.
 *
 * Diese Unterscheidung ist die Voraussetzung jeder weiteren Storage-Migration:
 * Eine fehlschlagende Migration darf blockieren, aber niemals überschreiben.
 */
export type PersistedStateLoadResult =
  | { status: 'loaded'; state: AppPersistedState; storageKey: string }
  | { status: 'absent'; storageKey: string }
  | { status: 'failed'; reason: PersistedStateLoadFailureReason; storageKey: string };

export function loadPersistedStateResultFromKey(storageKey: string): PersistedStateLoadResult {
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey);
  } catch (error) {
    console.warn('[OfficePilot] localStorage konnte nicht gelesen werden:', error);
    return { status: 'failed', reason: 'storage_unavailable', storageKey };
  }

  // Der einzige Weg zu `absent`: Es liegt tatsächlich nichts vor.
  if (!raw) return { status: 'absent', storageKey };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn('[OfficePilot] Gespeicherter Zustand ist nicht lesbar:', error);
    return { status: 'failed', reason: 'parse_error', storageKey };
  }

  let normalized: NormalizedLoadedState | null;
  let state: AppPersistedState;
  try {
    normalized = normalizeLoadedState(parsed);
    if (!normalized) {
      console.warn('[OfficePilot] Gespeicherter Zustand wurde nicht erkannt.');
      return { status: 'failed', reason: 'unrecognized_state', storageKey };
    }
    /*
     * PERSISTENCE-MIGRATION-FAILURE-GUARD-01B2 — bis hierher ist noch nichts
     * geschrieben und nichts übernommen. Erst wenn die vollständige Kette —
     * Versionsprüfung, Migration, Sync-Metadaten, Aufbereitung — durchgelaufen
     * ist, gilt der Zustand als geladen.
     */
    state = finalizeLoadedPersistedState(normalized.state);
  } catch (error) {
    console.warn('[OfficePilot] Gespeicherter Zustand konnte nicht aufbereitet werden:', error);
    return { status: 'failed', reason: 'migration_failed', storageKey };
  }

  /*
   * Ab hier steht der Erfolg fest. Jetzt — und nur jetzt — darf der Sync-Zustand
   * dieses Datensatzes gelten, und ein migrierter Stand darf den alten ersetzen.
   * Der Rückschreibvorgang bleibt auf den aktiven Bereich beschränkt: Ein
   * fremder Schlüssel wird gelesen, aber nie überschrieben.
   */
  adoptLoadedSyncState(state);
  /*
   * LOAD_FAILED-UX-GUARD-01B — ein gelungener Ladevorgang **ist** die
   * Freigabebedingung für genau diesen Bereich.
   *
   * Die Aufhebung steht hier und nicht erst beim Aufrufer: Sonst hinge sie
   * daran, dass jeder Aufrufer `recordPersistedStateLoadOutcome` ruft — und ein
   * anschliessendes Zurückschreiben der Migration liefe gegen eine Sperre, die
   * in diesem Moment sachlich nicht mehr besteht.
   */
  writeLockedStorageKeys.delete(storageKey);
  if (normalized.migrated && storageKey === getActiveStorageKey()) {
    savePersistedState(normalized.migrated);
  }
  return { status: 'loaded', state, storageKey };
}

export function loadPersistedStateResult(): PersistedStateLoadResult {
  return loadPersistedStateResultFromKey(getActiveStorageKey());
}

/**
 * Bestandsform: `null` für „nicht geladen".
 *
 * Bewusst erhalten, damit Aufrufer, die nur den Erfolgsfall brauchen,
 * unverändert bleiben. **Wer zwischen `absent` und `failed` unterscheiden muss
 * — also jeder, der ersatzweise Seed-Daten schreiben würde —, nimmt
 * `loadPersistedStateResultFromKey`.**
 */
export function loadPersistedStateFromKey(storageKey: string): AppPersistedState | null {
  const result = loadPersistedStateResultFromKey(storageKey);
  return result.status === 'loaded' ? result.state : null;
}

export function loadPersistedState(): AppPersistedState | null {
  return loadPersistedStateFromKey(getActiveStorageKey());
}

export function savePersistedStateToKey(
  scope: StorageScope,
  state: AppPersistedState,
): PersistSaveResult {
  const storageKey = buildStorageKey(scope);

  /*
   * LOAD_FAILED-UX-GUARD-01B — die zweite Schutzschicht.
   *
   * `PERSISTENCE-MIGRATION-FAILURE-GUARD-01B/01B2` bewahrt den Rohwert während
   * des Ladens. Danach standen die Fachspeicher aber leer da, und dieser
   * Schnappschuss entsteht **aus ihnen** — die erste beliebige Nutzeraktion
   * hätte den geretteten Bestand überschrieben.
   *
   * Solange für diesen Schlüssel ein Ladefehler gilt, wird deshalb gar nicht
   * erst serialisiert. Der Aufrufer bekommt ein Ergebnis, keine Ausnahme; ein
   * Schreibversuch bleibt ohne Wirkung und hebt die Sperre nicht auf.
   *
   * Frei wird der Bereich erst, wenn wieder ein **vollständiger** Zustand in
   * die Speicher übernommen wurde — durch einen gelungenen Ladevorgang oder
   * durch eine ausdrückliche Wiederherstellung (`applyStateToStores`).
   */
  if (isBusinessStateWriteLocked(storageKey)) {
    const failure: PersistFailureInfo = { reason: 'load_failed_lock' };
    lastPersistFailure = failure;
    return { success: false, failure };
  }

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
  /*
   * LOAD_FAILED-UX-GUARD-01B — die Übernahme eines vollständigen Zustands ist
   * der einzige Weg zurück.
   *
   * Ein gelungener Ladevorgang, ein Cloud-Bootstrap und eine ausdrückliche
   * Wiederherstellung enden alle hier. Genau das ist die Bedingung, unter der
   * ein Schreibvorgang wieder unbedenklich ist: Die Speicher tragen wieder
   * einen echten Bestand, nicht die Leere nach einem Ladefehler.
   *
   * Ein **Schreibversuch** löst die Sperre bewusst nicht — sonst genügte ein
   * zweiter Anlauf, um den geretteten Bestand doch zu überschreiben.
   */
  writeLockedStorageKeys.delete(getActiveStorageKey());

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
  /*
   * FIRST-CLASS-LOCAL-INVOICE-STORE-01B — Reihenfolge zählt.
   *
   * `hydrateVorgangStore` übernimmt die Rechnungen, die noch an Vorgängen
   * hängen (V5-Bestände, Testvorbereitungen). Ein V6-Zustand trägt sie dort
   * nicht mehr, sondern in `invoiceEntries` — deshalb setzt der Aufruf danach
   * den Bestand endgültig.
   */
  hydrateVorgangStore(state.vorgaenge);
  if (state.invoiceEntries) {
    hydrateInvoiceStore(state.invoiceEntries);
  }
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
/**
 * PERSISTENCE-MIGRATION-FAILURE-GUARD-01B — der letzte fehlgeschlagene
 * Ladeversuch, damit ein Ladefehler nicht nur im Protokoll steht.
 *
 * Bewusst klein: kein Fehlerbildschirm, kein Wiederherstellungsablauf. Der
 * Zustand bleibt im Servicevertrag abrufbar; die Oberfläche kann ihn später
 * auswerten, ohne dass dieser Block sie umbaut.
 */
let lastPersistedStateLoadFailure: {
  reason: PersistedStateLoadFailureReason;
  storageKey: string;
} | null = null;

/**
 * LOAD_FAILED-UX-GUARD-01B — die gesperrten Speicherbereiche, je Schlüssel.
 *
 * Bewusst eine Menge und kein globaler Schalter: Ein Ladefehler betrifft genau
 * einen Bereich. Ein anderer Arbeitsbereich bleibt beschreibbar, und ein
 * erfolgreicher Wechsel dorthin darf die Sperre des ersten nicht aufheben.
 */
const writeLockedStorageKeys = new Set<string>();

export function getPersistedStateLoadFailure(): {
  reason: PersistedStateLoadFailureReason;
  storageKey: string;
} | null {
  return lastPersistedStateLoadFailure;
}

/**
 * Ist dieser Speicherbereich wegen eines Ladefehlers für Fachdaten gesperrt?
 *
 * Solange das gilt, wird der gespeicherte Rohwert **nicht** überschrieben — auch
 * nicht durch einen ganz normalen Speichervorgang im laufenden Betrieb.
 */
export function isBusinessStateWriteLocked(storageKey: string): boolean {
  return writeLockedStorageKeys.has(storageKey);
}

/**
 * Setzt oder löst die Sperre für **genau den** geladenen Bereich.
 *
 * `failed` sperrt, `loaded` und `absent` geben frei. Ein Ladevorgang für einen
 * anderen Schlüssel lässt bestehende Sperren unberührt.
 */
export function recordPersistedStateLoadOutcome(result: PersistedStateLoadResult): void {
  if (result.status === 'failed') {
    writeLockedStorageKeys.add(result.storageKey);
    lastPersistedStateLoadFailure = { reason: result.reason, storageKey: result.storageKey };
    return;
  }

  writeLockedStorageKeys.delete(result.storageKey);
  if (lastPersistedStateLoadFailure?.storageKey === result.storageKey) {
    lastPersistedStateLoadFailure = null;
  }
}

/** Nur für Tests: alle Sperren aufheben. */
export function resetBusinessStateWriteLocksForTests(): void {
  writeLockedStorageKeys.clear();
  lastPersistedStateLoadFailure = null;
}

export function hydrateStoresFromStorage(): CompanySetup {
  if (isBetaTestMode()) {
    const result = loadPersistedStateResult();
    recordPersistedStateLoadOutcome(result);
    if (result.status === 'loaded' && result.state.setup.setupComplete) {
      applyStateToStores(result.state);
      return getCachedSetup();
    }
    /*
     * Ein Ladefehler darf auch hier nicht in einen Erststart münden:
     * `bootstrapBetaTestState` legt einen frischen Bestand an und speichert ihn.
     */
    if (result.status === 'failed') return getCachedSetup();
    return bootstrapBetaTestState();
  }

  setActiveStorageScope({ type: 'guest' });
  const result = loadPersistedStateResult();
  recordPersistedStateLoadOutcome(result);
  if (result.status === 'loaded') {
    applyStateToStores(result.state);
    void backfillMissingFileRefHashes().then(() => persistAll());
    return getCachedSetup();
  }

  /*
   * PERSISTENCE-MIGRATION-FAILURE-GUARD-01B — Seed **nur** bei tatsächlich
   * leerem Speicher.
   *
   * Bis hierher lieferte der Ladepfad für „nichts gespeichert" und „gespeichert,
   * aber unlesbar" denselben `null`-Wert. Der Seed wurde deshalb auch dann
   * angewendet **und geschrieben**, wenn Daten vorhanden waren — der Fehlerfall
   * löschte den Bestand, den er schützen sollte. Bei `failed` wird jetzt weder
   * angewendet noch gespeichert; der Rohwert bleibt unangetastet und der Grund
   * bleibt über `getPersistedStateLoadFailure` abrufbar.
   */
  if (result.status === 'failed') return getCachedSetup();

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
    /**
     * REAL-DEVICE-CLOUD-COMPANY-POST-SEED-MUTATION-FIX-01 — dieselbe
     * Normalisierung wie in `applyStateToStores`. Vorher setzte dieser Pfad den
     * Override roh; ein aus der Cloud stammender Setup verlor damit die
     * Default-Auffüllung und die Schlüsselreihenfolge des Stores. Der
     * unmittelbar folgende `trackPersistedChanges` meldete das als
     * `company_setup`-Änderung, obwohl sich fachlich nichts geändert hatte.
     */
    cachedSetup = { ...DEFAULT_SETUP, ...setupOverride };
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
    /*
     * FIRST-CLASS-LOCAL-INVOICE-STORE-01B — die Trennlinie zwischen Laufzeit
     * und Persistenz.
     *
     * Zur Laufzeit trägt jeder Vorgang seine Rechnungen als Sicht; gespeichert
     * wird er ohne sie. Ohne dieses Abstreifen stünde jede Rechnung zweimal im
     * selben Datensatz — genau die zweite Wahrheit, die dieser Umbau beseitigt.
     */
    vorgaenge: getVorgangStoreSnapshot().map((vorgang) => ({ ...vorgang, invoices: [] })),
    invoiceEntries: getInvoiceStoreSnapshot(),
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
  /**
   * REAL-DEVICE-CLOUD-COMPANY-TRACKER-ECHO-FIX-01/01C — der Cloud-Bootstrap
   * wendet einen **rohen** Remote-Kandidaten an. `applyStateToStores` hydriert
   * ihn mit Default-Auffüllung und fester Schlüsselreihenfolge, setzt die
   * Tracker-Baseline aber aus genau diesem Rohzustand. Ein späterer
   * `persistAll()` vergleicht dagegen den store-normalisierten Snapshot und
   * meldete bisher eine Firmenänderung, die es nie gab.
   *
   * Die Baseline folgt deshalb dem Zustand, der tatsächlich in den Stores
   * aktiv ist — unabhängig vom Persistenzergebnis. Dieser Pfad rollt bewusst
   * **nicht** zurück: nach einem fehlgeschlagenen `savePersistedState` tragen
   * die Stores weiterhin den angewendeten Kandidaten, und genau gegen diesen
   * Zustand misst der nächste `persistAll()`.
   */
  seedSyncChangeTrackerFromCurrentStores();
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
