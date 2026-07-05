import { DEFAULT_SETUP, MOCK_TASKS, MOCK_VORGAENGE } from '../data/mockData';
import { createCompanyProfileFromSetup } from '../data/companyProfileDefaults';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { MOCK_COMPANY_DOCUMENTS } from '../data/documentMockData';
import { MOCK_EXPENSES } from '../data/expenseMockData';
import type { CommunicationEvent } from '../types/communicationHistory';
import type { KnowledgeFact } from '../types/knowledge';
import type { OfficePilotMemoryState } from '../types/memory';
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

export const STORAGE_KEY = 'officepilot-state';
export const LEGACY_SETUP_KEY = 'officepilot-setup';
export const STORAGE_VERSION = 1;

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
  const companyProfile =
    isBetaTestMode() && setup.setupComplete
      ? { ...BETA_TEST_COMPANY_PROFILE, companyName: setup.companyName || BETA_TEST_SETUP.companyName }
      : createCompanyProfileFromSetup(setup);
  const invoiceNumberSequence: InvoiceNumberSequence = {
    year: new Date().getFullYear(),
    lastIssuedNumber: 0,
  };
  return {
    version: STORAGE_VERSION,
    setup,
    companyProfile,
    invoiceNumberSequence,
    inboxItems: MOCK_INBOX_ITEMS.map(cloneInboxItem),
    vorgaenge: MOCK_VORGAENGE.map(cloneVorgang),
    tasks: (MOCK_TASKS as Array<Partial<Task> & Pick<Task, 'id' | 'title'>>).map((t) =>
      normalizeTask(t),
    ),
    documents: MOCK_COMPANY_DOCUMENTS.map(cloneCompanyDocument),
    expenses: MOCK_EXPENSES.map(cloneExpense),
    vorgangNotes: [],
    communicationHistory: [],
    knowledgeFacts: [],
    officePilotMemory: {
      documentMemories: [],
      proofMemories: [],
      relations: [],
      paperRegisterEntries: [],
    },
    savedAt: new Date().toISOString(),
  };
}

function isValidPersistedState(value: unknown): value is AppPersistedState {
  if (!value || typeof value !== 'object') return false;
  const state = value as AppPersistedState;
  return (
    state.version === STORAGE_VERSION &&
    Array.isArray(state.inboxItems) &&
    Array.isArray(state.vorgaenge) &&
    Array.isArray(state.tasks) &&
    (Array.isArray(state.documents) || state.documents === undefined) &&
    (Array.isArray(state.expenses) || state.expenses === undefined) &&
    (Array.isArray(state.vorgangNotes) || state.vorgangNotes === undefined) &&
    (Array.isArray(state.communicationHistory) || state.communicationHistory === undefined) &&
    (Array.isArray(state.knowledgeFacts) || state.knowledgeFacts === undefined) &&
    (state.officePilotMemory === undefined ||
      (Array.isArray(state.officePilotMemory.documentMemories) &&
        Array.isArray(state.officePilotMemory.proofMemories) &&
        Array.isArray(state.officePilotMemory.relations) &&
        (state.officePilotMemory.paperRegisterEntries === undefined ||
          Array.isArray(state.officePilotMemory.paperRegisterEntries)))) &&
    typeof state.setup === 'object' &&
    state.setup !== null
  );
}

export function loadPersistedState(): AppPersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidPersistedState(parsed)) {
      console.warn('[OfficePilot] Ungültiger gespeicherter Zustand – Seed-Daten werden verwendet.');
      return null;
    }
    return {
      ...parsed,
      setup: { ...DEFAULT_SETUP, ...parsed.setup },
      companyProfile: parsed.companyProfile
        ? cloneCompanyProfile({ ...createCompanyProfileFromSetup(parsed.setup), ...parsed.companyProfile })
        : createCompanyProfileFromSetup({ ...DEFAULT_SETUP, ...parsed.setup }),
      invoiceNumberSequence: parsed.invoiceNumberSequence ?? {
        year: new Date().getFullYear(),
        lastIssuedNumber: 0,
      },
      inboxItems: parsed.inboxItems.map(cloneInboxItem),
      vorgaenge: parsed.vorgaenge.map(cloneVorgang),
      tasks: parsed.tasks.map(cloneTask),
      documents: (parsed.documents ?? MOCK_COMPANY_DOCUMENTS).map(cloneCompanyDocument),
      expenses: (parsed.expenses ?? []).map(cloneExpense),
      vorgangNotes: (parsed.vorgangNotes ?? []).map(cloneVorgangNote),
      communicationHistory: (parsed.communicationHistory ?? []).map(cloneCommunicationEvent),
      knowledgeFacts: (parsed.knowledgeFacts ?? []).map(cloneKnowledgeFact),
      officePilotMemory: cloneOfficePilotMemoryState(
        parsed.officePilotMemory ?? {
          documentMemories: [],
          proofMemories: [],
          relations: [],
          paperRegisterEntries: [],
        },
      ),
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

  const state: AppPersistedState = {
    version: STORAGE_VERSION,
    setup: getCachedSetup(),
    companyProfile: getCompanyProfileStoreSnapshot(),
    invoiceNumberSequence: getInvoiceNumberSequenceSnapshot(),
    inboxItems: getInboxStoreSnapshot(),
    vorgaenge: getVorgangStoreSnapshot(),
    tasks: getTaskStoreSnapshot(),
    documents: getDocumentStoreSnapshot(),
    expenses: getExpenseStoreSnapshot(),
    vorgangNotes: getVorgangNoteStoreSnapshot(),
    communicationHistory: getCommunicationHistorySnapshot(),
    knowledgeFacts: getKnowledgeSnapshot(),
    officePilotMemory: getOfficePilotMemorySnapshot(),
    savedAt: new Date().toISOString(),
  };

  savePersistedState(state);
}

export function resetDemoData(options?: { keepSetup?: boolean }): CompanySetup {
  const keepSetup = options?.keepSetup ?? false;
  const setup = keepSetup ? getCachedSetup() : { ...DEFAULT_SETUP, setupComplete: false };

  resetInboxItems();
  resetVorgaenge();
  resetTasks();
  resetDocuments();
  resetExpenses();
  resetVorgangNotes();
  resetCommunicationHistoryStore();
  resetKnowledgeStore();
  resetMemory();
  resetCompanyProfile(setup.companyName);
  resetInvoiceNumberSequence();

  const seed = createSeedState(setup);
  applyStateToStores(seed);
  savePersistedState(seed);

  if (!keepSetup) {
    localStorage.removeItem(LEGACY_SETUP_KEY);
  }

  return getCachedSetup();
}
