import { DEFAULT_SETUP, MOCK_TASKS, MOCK_VORGAENGE } from '../data/mockData';
import { createCompanyProfileFromSetup } from '../data/companyProfileDefaults';
import { migrateCompanyProfileLegacyFields } from './company/companyProfileLegacyMigrationService';
import { applyCompanyProfileSettingsContract } from './company/companyProfileSettingsContract';
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
  getAccountingStoreSnapshot,
  hydrateAccountingStore,
} from './accounting/accountingStore';
import {
  getAccountingPeriodStoreSnapshot,
  hydrateAccountingPeriodStore,
} from './accounting/accountingPeriodStore';
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
  getBusinessLetterStoreSnapshot,
  hydrateBusinessLetters,
  resetBusinessLetters,
} from './businessLetterService';
import { getOfferStoreSnapshot, hydrateOffers, resetOffers } from './offer/offerService';
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
import { getOrderDraftStoreSnapshot, hydrateOrderDrafts } from './order/orderDraftService';
import { getBankTransactionStoreSnapshot, hydrateBankTransactions } from './bank/bankTransactionStore';
import { getBankAccountStoreSnapshot, hydrateBankAccounts } from './bank/bankAccountStore';
import {
  getBankReconciliationStoreSnapshot,
  hydrateBankReconciliations,
} from './bank/bankReconciliationStore';
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
  | 'load_failed_lock'
  /** SYNC-AUTOMATIK-01A — ein anderer Tab hat diesen Bereich inzwischen neuer gespeichert. */
  | 'stale_tab';

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

/**
 * SYNC-AUTOMATIK-01A — zählt jede gelungene lokale Speicherung.
 *
 * Ein Sync-Lauf merkt sich den Wert bei seinem Start. Ist er beim Anwenden
 * des Ergebnisses ein anderer, wurde inzwischen lokal gespeichert, und das
 * Ergebnis darf den Speicher nicht einfach ersetzen (`syncLocalRebaseService`).
 */
let localMutationRevision = 0;

export function getLocalMutationRevision(): number {
  return localMutationRevision;
}

/*
 * SYNC-AUTOMATIK-01A — minimaler Schutz gegen das Überschreiben durch einen
 * älteren Tab.
 *
 * Mehrere Tabs teilen sich denselben Speicherschlüssel, aber jeder hält seinen
 * eigenen Arbeitsspeicher. Ein Tab, der vor einer Stunde geladen wurde, schrieb
 * bisher beim nächsten Speichern seinen alten Stand über alles, was ein anderer
 * Tab inzwischen gespeichert hatte.
 *
 * 01A-FIX3 — zwei Angaben, sauber getrennt, beide vorn im Bestand (lesbar ohne
 * vollständiges Einlesen, weiterhin genau ein `setItem` je Speichern):
 *
 *   - `businessRevision` — die **fachliche** Revision. Sie steigt nur, wenn
 *     sich der fachliche Inhalt ändert: eine lokale Eingabe oder echter neuer
 *     Inhalt aus der Cloud. Sie allein entscheidet, ob ein anderer Tab
 *     veraltet ist.
 *   - `writeGeneration` — ein rein **technischer** Zähler, der jeden
 *     Schreibvorgang zählt (Öffnen, Bootstrap, Sendenachweis …). Er dient nur
 *     der Nachvollziehbarkeit und sperrt nie einen Tab.
 *
 * `savedAt` bleibt Zeitstempel für Anzeige und Diagnose, ohne Wirkung auf den
 * Schutz.
 *
 * Bis FIX2 trug ein einziges Feld (`writeGeneration`) beide Rollen. Ein
 * technischer Schreibvorgang, den der Inhaltsvergleich fälschlich für fachlich
 * hielt, sperrte damit den anderen Tab. Jetzt wird bei Sync-Übernahmen der
 * fachliche Inhalt der **Speicher** vor und nach dem Anwenden verglichen — nicht
 * der rohe Kandidat —, und jede Erhöhung hält fest, welche Bereiche sich
 * geändert haben (`getLastBusinessRevisionChange`), damit ein unerwarteter
 * Anstieg ohne Rätselraten zuzuordnen ist.
 *
 * Ein Bestand ohne diese Angaben (älter, geleert) ist ungeschützt beschreibbar.
 * Ein Bestand aus FIX1/FIX2 (`writeGeneration` allein vorn) wird als fachliche
 * Revision gelesen — dort hatte das Feld bereits diese Bedeutung.
 */
const BUSINESS_REVISION_FIELD = 'businessRevision';
const WRITE_GENERATION_FIELD = 'writeGeneration';
const REVISION_HEADER_PATTERN = /^\{"businessRevision":(\d+),"writeGeneration":(\d+)[,}]/;
const LEGACY_GENERATION_PATTERN = /^\{"writeGeneration":(\d+)[,}]/;

interface StoredRevisionHeader {
  businessRevision: number;
  writeGeneration: number;
}

/** Fachliche Revision, die dieser Tab zuletzt gelesen oder geschrieben hat. */
const knownBusinessRevisions = new Map<string, number>();
/** Fachlicher Inhalt je Bereich, den dieser Tab zuletzt gelesen oder geschrieben hat. */
const knownContentAreas = new Map<string, Map<string, string>>();
let staleTabDetected = false;

export interface BusinessRevisionChange {
  storageKey: string;
  businessRevision: number;
  /** Bereiche (oberste Schlüssel) mit geändertem fachlichem Inhalt — keine Werte. */
  areas: string[];
  source: 'save' | 'sync_apply';
  at: string;
}

let lastBusinessRevisionChange: BusinessRevisionChange | null = null;

/** Die zuletzt erhöhte fachliche Revision und ihr Anlass — zur Diagnose. */
export function getLastBusinessRevisionChange(): BusinessRevisionChange | null {
  return lastBusinessRevisionChange ? { ...lastBusinessRevisionChange, areas: [...lastBusinessRevisionChange.areas] } : null;
}

/** Oberste Felder ohne fachlichen Inhalt: Revision, Speicherformat, Zeitpunkt, Sendeaufträge, Gerät, Sync-Metadaten. */
const NON_CONTENT_TOP_LEVEL_KEYS = new Set([
  BUSINESS_REVISION_FIELD,
  WRITE_GENERATION_FIELD,
  'version',
  'savedAt',
  'syncOutbox',
  'syncClient',
  'setupSync',
  'companyProfileSync',
]);
/** Versionsangaben einzelner Einträge — Sync-Metadaten, kein Inhalt. */
const NON_CONTENT_META_KEYS: Record<string, ReadonlySet<string>> = {
  workspace: new Set(['version', 'updatedAt']),
  workspaceSettings: new Set(['version', 'updatedAt', 'updatedBy']),
};

/**
 * Stabile Textform des fachlichen Inhalts: Schlüssel sortiert, leere Werte
 * ausgelassen (eine Auffüllung mit `[]` ist keine Änderung), `sync` und
 * der Cloud-Pfad einer Datei ausgelassen. Dateiinhalte zählen über ihre
 * Kennung und Länge — sie ändern sich unter derselben Kennung nicht.
 */
function appendCanonical(value: unknown, out: string[], skip?: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    out.push('[');
    for (const item of value) {
      appendCanonical(item, out);
      out.push(',');
    }
    out.push(']');
    return;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    out.push('{');
    for (const key of Object.keys(record).sort()) {
      // `contentHash`: aus dem Dateiinhalt abgeleitet, nachgetragen beim Öffnen — kein neuer Inhalt.
      if (key === 'sync' || key === 'contentHash' || skip?.has(key)) continue;
      const child = record[key];
      if (key === 'cloud' && typeof child === 'object') continue;
      if (isEmptyContentValue(child)) continue;
      out.push(JSON.stringify(key), ':');
      appendCanonical(child, out);
      out.push(',');
    }
    out.push('}');
    return;
  }
  out.push(JSON.stringify(value) ?? 'null');
}

function isEmptyContentValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === 'object' && Object.keys(value as object).length === 0;
}

/** FNV-1a über die Textform, dazu die Länge — genügt zum Erkennen einer Änderung. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}:${text.length}`;
}

/**
 * 01A-FIX2 — der Fingerabdruck vergleicht die **geladene Form**.
 *
 * Der Ladepfad ergänzt deterministisch Werte, die sich aus dem übrigen Bestand
 * ergeben — etwa `currency` und `defaultTaxStatus` im Firmenprofil
 * (`migrateCompanyProfileLegacyFields`). Der Cloud-Bootstrap schreibt dagegen
 * das Profil aus dem Cloud-Payload, dem diese Werte fehlen. Beide Fassungen
 * sind fachlich gleich; ohne gemeinsame Form hob schon das blosse Öffnen eines
 * zweiten Tabs die Generation (Browserbefund 01A-FIX1, Schreibpfad
 * `applyPersistedStateFromSync` im Cloud-Bootstrap). Deshalb läuft jeder
 * Stand vor dem Fingerabdruck durch dieselbe Aufbereitung wie beim Laden.
 */
function toLoadedForm(record: Record<string, unknown>): Record<string, unknown> {
  try {
    const state = record as unknown as AppPersistedState;
    return finalizeLoadedPersistedState({
      ...state,
      inboxItems: state.inboxItems ?? [],
      vorgaenge: state.vorgaenge ?? [],
      tasks: state.tasks ?? [],
    }) as unknown as Record<string, unknown>;
  } catch {
    return record;
  }
}

/** 01A-FIX3 — fachlicher Inhalt je Bereich (oberster Schlüssel) als Fingerabdruck. */
export function buildBusinessContentAreas(state: object): Map<string, string> {
  const record = toLoadedForm(state as Record<string, unknown>);
  const areas = new Map<string, string>();
  for (const key of Object.keys(record).sort()) {
    if (NON_CONTENT_TOP_LEVEL_KEYS.has(key)) continue;
    let child = record[key];
    if (isEmptyContentValue(child)) continue;
    if (key === 'documentFileBlobs' && typeof child === 'object') {
      child = Object.fromEntries(
        Object.entries(child as Record<string, unknown>).map(([id, blob]) => [
          id,
          typeof blob === 'string' ? blob.length : 0,
        ]),
      );
    }
    const out: string[] = [];
    appendCanonical(child, out, NON_CONTENT_META_KEYS[key]);
    areas.set(key, hashText(out.join('')));
  }
  return areas;
}

/** Ein Fingerabdruck über alle Bereiche — für Vergleiche im Ganzen. */
export function buildBusinessContentFingerprint(state: object): string {
  const areas = buildBusinessContentAreas(state);
  return hashText([...areas.entries()].map(([key, hash]) => `${key}=${hash}`).join('|'));
}

/** Bereiche, deren fachlicher Inhalt sich unterscheidet (hinzugekommen, entfallen, geändert). */
function diffContentAreas(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) !== after.get(key)) changed.push(key);
  }
  return changed.sort();
}

function contentAreasOfRaw(raw: string | null): Map<string, string> | null {
  if (!raw) return null;
  try {
    return buildBusinessContentAreas(JSON.parse(raw) as object);
  } catch {
    return null;
  }
}

function parseRevisionHeader(raw: string | null): StoredRevisionHeader | null {
  if (!raw) return null;
  const current = REVISION_HEADER_PATTERN.exec(raw);
  if (current) return { businessRevision: Number(current[1]), writeGeneration: Number(current[2]) };
  // FIX1/FIX2-Bestand: dort war `writeGeneration` bereits die fachliche Generation.
  const legacy = LEGACY_GENERATION_PATTERN.exec(raw);
  if (legacy) return { businessRevision: Number(legacy[1]), writeGeneration: Number(legacy[1]) };
  return null;
}

function readRevisionHeader(storageKey: string): StoredRevisionHeader | null {
  try {
    return parseRevisionHeader(localStorage.getItem(storageKey));
  } catch {
    return null;
  }
}

/** Der zu schreibende Text: beide Angaben vorn, der übrige Bestand unverändert dahinter. */
function serializeWithRevisionHeader(state: object, header: StoredRevisionHeader): string {
  const rest: Record<string, unknown> = { ...(state as Record<string, unknown>) };
  delete rest[BUSINESS_REVISION_FIELD];
  delete rest[WRITE_GENERATION_FIELD];
  return JSON.stringify({
    [BUSINESS_REVISION_FIELD]: header.businessRevision,
    [WRITE_GENERATION_FIELD]: header.writeGeneration,
    ...rest,
  });
}

/** Beim Laden: fachliche Revision und fachlichen Inhalt des gelesenen Bestands merken. */
function rememberWriteGeneration(storageKey: string): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey);
  } catch {
    raw = null;
  }
  knownBusinessRevisions.set(storageKey, parseRevisionHeader(raw)?.businessRevision ?? 0);
  const areas = contentAreasOfRaw(raw);
  if (areas) knownContentAreas.set(storageKey, areas);
  else knownContentAreas.delete(storageKey);
}

/**
 * Hat ein anderer Tab diesen Bestand seit unserem letzten Lesen/Schreiben
 * **fachlich** geändert? Nur die fachliche Revision zählt — nicht
 * `writeGeneration`, nicht `savedAt`.
 */
export function isStorageKeyWrittenByOtherTab(storageKey: string): boolean {
  const known = knownBusinessRevisions.get(storageKey);
  const stored = readRevisionHeader(storageKey);
  return known !== undefined && stored !== null && stored.businessRevision !== known;
}

/** Dieser Tab trägt einen veralteten Stand; Speichern und automatischer Sync pausieren. */
export function isLocalStateStaleInThisTab(): boolean {
  return staleTabDetected;
}

/**
 * 01A — sofort sichtbar machen, wenn ein anderer Tab fachlich speichert, nicht
 * erst beim nächsten eigenen Speicherversuch (der dann abgelehnt würde).
 */
export function watchOtherTabWrites(): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onStorage = (event: StorageEvent) => {
    const activeKey = getActiveStorageKey();
    if (event.key !== activeKey) return;
    if (!isStorageKeyWrittenByOtherTab(activeKey)) return;
    staleTabDetected = true;
    lastPersistFailure = { reason: 'stale_tab' };
    publishPersistenceHealth();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

/**
 * 01A-FIX1 — Grundlinie nach dem Laden: der fachliche Inhalt, wie er **nach**
 * der Übernahme in die Speicher aussieht. Aufzurufen unmittelbar nach dem
 * Anwenden eines geladenen Bestands.
 */
export function rememberLoadedContentBaseline(): void {
  try {
    knownContentAreas.set(getActiveStorageKey(), buildBusinessContentAreas(buildPersistedStateSnapshot()));
  } catch {
    /* ohne Grundlinie gilt der Vergleich mit dem Gespeicherten */
  }
}

/**
 * 01A-FIX3 — Stand der Speicher **vor** dem Anwenden eines Sync-Ergebnisses.
 * Zusammen mit `savePersistedStateAfterSyncApply` entscheidet er, ob die
 * Übernahme fachlich etwas geändert hat. Verglichen werden die Speicher, nicht
 * der rohe Kandidat: Deren Aufbereitung gleicht Formunterschiede der Cloud aus.
 */
export function captureBusinessContentBeforeSyncApply(): Map<string, string> | null {
  try {
    return buildBusinessContentAreas(buildPersistedStateSnapshot());
  } catch {
    return null;
  }
}

function noteBusinessRevisionChange(change: Omit<BusinessRevisionChange, 'at'>): void {
  lastBusinessRevisionChange = { ...change, at: new Date().toISOString() };
  const env = (import.meta as unknown as { env?: { DEV?: boolean; MODE?: string } }).env;
  if (env?.DEV && env.MODE !== 'test' && typeof window !== 'undefined') {
    // Nur Bereichsnamen, keine Inhalte — genug, um einen unerwarteten Anstieg zuzuordnen.
    (window as unknown as { __officetaktLastBusinessRevisionChange?: BusinessRevisionChange }).__officetaktLastBusinessRevisionChange =
      getLastBusinessRevisionChange() ?? undefined;
    console.info('[OfficeTakt] Fachliche Revision erhöht:', change.businessRevision, change.source, change.areas);
  }
}

export function resetWriteGenerationsForTests(): void {
  knownBusinessRevisions.clear();
  knownContentAreas.clear();
  staleTabDetected = false;
  lastBusinessRevisionChange = null;
}

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
  // SETTINGS-01B1 — Migration-on-read der neuen Felder (trim, gültiger Steuerstatus).
  return applyCompanyProfileSettingsContract({ ...profile, logoDataUrl: profile.logoDataUrl });
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
      businessLetters: [],
      offers: [],
      orderDrafts: [],
      bankTransactions: [],
      bankAccounts: [],
      bankReconciliations: [],
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
    staleTab: lastPersistFailure?.reason === 'stale_tab',
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
  const setup = { ...DEFAULT_SETUP, ...normalized.setup };
  const loadedProfile = normalized.companyProfile
    ? cloneCompanyProfile({
        ...createCompanyProfileFromSetup(normalized.setup),
        ...normalized.companyProfile,
      })
    : createCompanyProfileFromSetup(setup);
  /*
   * PRODUCT-BASIS-FIRMENPROFIL-01B — die eine Wahrheit beim Laden herstellen:
   * `defaultTaxStatus` einmalig aus dem Legacy-Spiegel, `currency` nur ohne
   * widersprechende Belege. Deterministisch und idempotent; ein Konflikt setzt
   * nichts und bleibt sichtbar (Feld fehlt weiterhin).
   */
  const migrated = migrateCompanyProfileLegacyFields({
    profile: loadedProfile,
    setup,
    documentCurrencies: (normalized.expenses ?? []).map((expense) => expense.currency),
  });
  return {
    ...normalized,
    setup,
    companyProfile: migrated.profile,
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
    businessLetters: (normalized.businessLetters ?? []).map((letter) => ({ ...letter })),
    offers: (normalized.offers ?? []).map((offer) => ({ ...offer })),
    orderDrafts: (normalized.orderDrafts ?? []).map((draft) => ({
      ...draft,
      customerBilling: { ...draft.customerBilling },
      positions: draft.positions.map((position) => ({ ...position })),
    })),
    bankTransactions: (normalized.bankTransactions ?? []).map((tx) => ({ ...tx })),
    bankAccounts: (normalized.bankAccounts ?? []).map((acc) => ({ ...acc })),
    bankReconciliations: (normalized.bankReconciliations ?? []).map((rec) => ({ ...rec })),
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
  // 01A — jeder Ladevorgang wird angewendet; ab hier kennt dieser Tab den gelesenen Stand.
  rememberWriteGeneration(storageKey);
  if (storageKey === getActiveStorageKey()) staleTabDetected = false;
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

export interface SavePersistedStateOptions {
  /**
   * 01A-FIX3 — Anwenden eines Sync-Ergebnisses: der fachliche Inhalt der
   * Speicher **vor** dem Anwenden (`captureBusinessContentBeforeSyncApply`).
   * Die Speicher tragen beim Aufruf bereits den angewendeten Stand; verglichen
   * wird Speicher gegen Speicher.
   */
  businessContentBefore?: Map<string, string> | null;
}

export function savePersistedStateToKey(
  scope: StorageScope,
  state: AppPersistedState,
  options: SavePersistedStateOptions = {},
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

  /*
   * SYNC-AUTOMATIK-01A-FIX3 — ein anderer Tab hat **fachlich** neuer
   * gespeichert: nicht blind überschreiben. Verglichen wird allein die
   * fachliche Revision; `writeGeneration` und `savedAt` spielen keine Rolle.
   */
  let storedRaw: string | null = null;
  try {
    storedRaw = localStorage.getItem(storageKey);
  } catch {
    storedRaw = null;
  }
  const storedHeader = parseRevisionHeader(storedRaw);
  const knownBusinessRevision = knownBusinessRevisions.get(storageKey);
  if (
    knownBusinessRevision !== undefined &&
    storedHeader !== null &&
    storedHeader.businessRevision !== knownBusinessRevision
  ) {
    staleTabDetected = true;
    const failure: PersistFailureInfo = { reason: 'stale_tab' };
    lastPersistFailure = failure;
    return { success: false, failure };
  }

  const existingStoredCharacters = storedRaw?.length;

  /*
   * 01A-FIX1/FIX3 — nur eine fachliche Änderung hebt die fachliche Revision.
   * Öffnen, Bootstrap, Neuladen, reine Sync-Metadaten oder Nachträge schreiben
   * technisch (neue `writeGeneration`), aber mit derselben fachlichen Revision.
   */
  let contentAfter: Map<string, string> | null = null;
  let changedAreas: string[] = [];
  const syncApply = options.businessContentBefore !== undefined;
  try {
    if (syncApply) {
      contentAfter = buildBusinessContentAreas(buildPersistedStateSnapshot());
      changedAreas = options.businessContentBefore
        ? diffContentAreas(options.businessContentBefore, contentAfter)
        : ['(unbekannter Vorstand)'];
    } else {
      contentAfter = buildBusinessContentAreas(state);
      let previous = knownContentAreas.get(storageKey);
      if (previous === undefined && storedHeader !== null) {
        // Noch nie gelesen (z. B. nach einem Bereichswechsel): mit dem Gespeicherten vergleichen.
        previous = contentAreasOfRaw(storedRaw) ?? undefined;
      }
      changedAreas = previous ? diffContentAreas(previous, contentAfter) : ['(neuer Bestand)'];
    }
  } catch {
    changedAreas = ['(nicht vergleichbar)'];
  }
  const businessChanged = changedAreas.length > 0;
  const nextHeader: StoredRevisionHeader = {
    businessRevision: (storedHeader?.businessRevision ?? 0) + (businessChanged ? 1 : 0),
    writeGeneration: (storedHeader?.writeGeneration ?? 0) + 1,
  };
  let serialized = '';
  try {
    serialized = serializeWithRevisionHeader(state, nextHeader);
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
    knownBusinessRevisions.set(storageKey, nextHeader.businessRevision);
    if (contentAfter) knownContentAreas.set(storageKey, contentAfter);
    else knownContentAreas.delete(storageKey);
    if (businessChanged) {
      noteBusinessRevisionChange({
        storageKey,
        businessRevision: nextHeader.businessRevision,
        areas: changedAreas,
        source: syncApply ? 'sync_apply' : 'save',
      });
    }
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

export function savePersistedState(state: AppPersistedState, options?: SavePersistedStateOptions): boolean {
  return savePersistedStateToKey(getActiveStorageScope(), state, options).success;
}

export function clearPersistedState(): void {
  localStorage.removeItem(getActiveStorageKey());
}

/**
 * SYNC-DURABILITY-01G5 — den Sendenachweis festhalten, **bevor** der
 * Schreibvorgang das Gerät verlässt.
 *
 * Bisher entstand er nur in der Arbeitskopie des Sendewegs und wurde erst am
 * Ende eines Laufs zurückgeschrieben. Stirbt die Seite zwischen „Server hat
 * angenommen" und „Antwort verarbeitet" — Neustart, Absturz, geschlossener
 * Reiter —, war er verloren, und mit ihm die einzige Möglichkeit, die neuere
 * Serverfassung später als die eigene zu erkennen.
 *
 * Geschrieben wird gezielt nur der Sendeauftrag: Ein vollständiges Speichern
 * mitten im Lauf würde den Stand der übrigen Bereiche aus den Arbeitsspeichern
 * übernehmen, die während einer Synchronisation bewusst auseinanderlaufen.
 * Hier wird der gespeicherte Stand gelesen, allein die Warteschlange ersetzt
 * und wieder zurückgeschrieben.
 */
export function persistSyncOutboxNow(): boolean {
  const storageKey = getActiveStorageKey();
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return false;
    // 01A — auch der Sendenachweis überschreibt keinen neueren Bestand eines anderen Tabs.
    if (isStorageKeyWrittenByOtherTab(storageKey)) {
      staleTabDetected = true;
      return false;
    }

    /*
     * Bewusst am Rohbestand und **ohne** die Schemaprüfung des Laders: Hier
     * wird nichts gedeutet, sondern ein einziges Feld ausgetauscht. Hinge der
     * Nachweis an der Prüfung, ginge er genau dort verloren, wo ein Bestand
     * gerade nicht sauber lesbar ist — und das ist der Moment, in dem er am
     * dringendsten gebraucht wird.
     */
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.syncOutbox = getSyncOutboxSnapshot();
    // 01A-FIX3 — Sendeaufträge sind kein fachlicher Inhalt: fachliche Revision bleibt, der Schreibvorgang zählt technisch.
    const header = parseRevisionHeader(raw);
    const nextHeader: StoredRevisionHeader = {
      businessRevision: header?.businessRevision ?? 0,
      writeGeneration: (header?.writeGeneration ?? 0) + 1,
    };
    localStorage.setItem(storageKey, serializeWithRevisionHeader(parsed, nextHeader));
    knownBusinessRevisions.set(storageKey, nextHeader.businessRevision);
    return true;
  } catch (error) {
    console.warn('[OfficePilot] Sendenachweis konnte nicht gespeichert werden:', error);
    return false;
  }
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
  resetBusinessLetters();
  resetOffers();
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
  // STEUERBERATER-06A — Kontierungen sind reload-fest wie jeder andere Bestand.
  hydrateAccountingStore(state.accountingAssignments ?? []);
  hydrateAccountingPeriodStore(state.accountingPeriodClosures ?? []);
  hydrateCustomerStore(state.customers ?? []);
  hydrateVorgangNotes(state.vorgangNotes ?? []);
  hydrateBusinessLetters(state.businessLetters ?? []);
  hydrateOffers(state.offers ?? []);
  hydrateOrderDrafts(state.orderDrafts ?? []);
  hydrateBankAccounts(state.bankAccounts ?? []);
  hydrateBankTransactions(state.bankTransactions ?? []);
  hydrateBankReconciliations(state.bankReconciliations ?? []);
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
      rememberLoadedContentBaseline();
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
    rememberLoadedContentBaseline();
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
  localMutationRevision += 1;
  publishPersistenceHealth();
  notifyLocalMutationListeners();
  return { success: true };
}

type LocalMutationListener = () => void;
const localMutationListeners = new Set<LocalMutationListener>();

/** SYNC-AUTOMATIK-01A — Auslöser für den Sync-Planer: „lokal wurde gespeichert". */
export function subscribeLocalMutations(listener: LocalMutationListener): () => void {
  localMutationListeners.add(listener);
  return () => {
    localMutationListeners.delete(listener);
  };
}

function notifyLocalMutationListeners(): void {
  for (const listener of [...localMutationListeners]) {
    try {
      listener();
    } catch {
      /* ein Beobachter darf das Speichern nie scheitern lassen */
    }
  }
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
    accountingAssignments: getAccountingStoreSnapshot(),
    accountingPeriodClosures: getAccountingPeriodStoreSnapshot(),
    customers: getCustomerStoreSnapshot(),
    vorgangNotes: getVorgangNoteStoreSnapshot(),
    businessLetters: getBusinessLetterStoreSnapshot(),
    offers: getOfferStoreSnapshot(),
    orderDrafts: getOrderDraftStoreSnapshot(),
    bankTransactions: getBankTransactionStoreSnapshot(),
    bankAccounts: getBankAccountStoreSnapshot(),
    bankReconciliations: getBankReconciliationStoreSnapshot(),
    dunningDocumentations: getDunningDocumentationStoreSnapshot(),
    communicationHistory: getCommunicationHistorySnapshot(),
    knowledgeFacts: getKnowledgeSnapshot(),
    officePilotMemory: getOfficePilotMemorySnapshot(),
    mailImports: getMailImportSnapshot().map(cloneMailImport),
    savedAt: new Date().toISOString(),
  };
}

export function applyPersistedStateFromSync(state: AppPersistedState): void {
  // 01A-FIX3 — fachlich zählt, was die Speicher vorher und nachher tragen, nicht der rohe Kandidat.
  const businessContentBefore = captureBusinessContentBeforeSyncApply();
  applyStateToStores(state);
  savePersistedState(state, { businessContentBefore });
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
  resetBusinessLetters();
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
