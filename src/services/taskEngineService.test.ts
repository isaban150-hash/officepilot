import { describe, expect, it, beforeEach } from 'vitest';
import { createTestVorgang } from '../test/fixtures';
import { hydrateCompanyProfileStore } from './companyProfileService';
import {
  archiveTask,
  buildDedupeKey,
  completeTask,
  createTaskFromProposal,
  createTasksFromContractAnalysis,
  getTasksFiltered,
  getTaskSummary,
  normalizeTask,
  proposePrimaryInboxTask,
  proposeTasksFromClassification,
  proposeTasksFromContract,
  proposeTasksFromOverdueInvoices,
  reopenTask,
  syncOverdueInvoiceTasks,
} from './taskEngineService';
import { isTaskDone, isTaskOpen } from './taskNormalize';
import { setTaskStoreForTests } from './taskStore';
import {
  confirmFiling,
  createContractTasksForItem,
  createTaskForItem,
} from './inboxTaskService';
import { hydrateInboxStore } from './inboxService';
import { analyzeContract, SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import { hydrateVorgangStore } from './vorgangService';
import { loadPersistedState, persistAll } from './persistenceService';
import type { CompanyProfile, InboxItem, Task, TaskProposal } from '../types/models';

const testProfile: CompanyProfile = {
  companyName: 'Mustermann Sanitär GmbH',
  legalForm: 'GmbH',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  contactPerson: 'Max Mustermann',
  phone: '030',
  email: 'info@mustermann-sanitaer.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

function createInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-task-test',
    title: 'Test Dokument Mustermann Sanitär GmbH',
    documentType: 'behoerde',
    sender: 'BG BAU',
    priority: 'mittel',
    deadline: '2026-04-10',
    recommendedAction: 'abheften',
    digitalFolder: { id: 'd', name: 'n', path: '/' },
    paperFiling: { folderId: 'folder-5', register: 'A', label: 'x' },
    status: 'neu',
    receivedAt: '2026-03-27',
    recognizedData: { Dokumentart: 'bg_bau', Betreff: 'Mustermann Sanitär GmbH' },
    officePilotSuggestion: 'Test',
    nextTaskLabel: 'Prüfen',
    securityHint: 'Test',
    ...overrides,
  };
}

function baseProposal(overrides: Partial<TaskProposal> = {}): TaskProposal {
  return {
    title: 'Testaufgabe',
    description: 'Beschreibung',
    priority: 'mittel',
    category: 'dokumente',
    sourceType: 'manual',
    sourceId: 'src-1',
    taskKind: 'test_kind',
    ...overrides,
  };
}

describe('taskEngineService core', () => {
  beforeEach(() => {
    localStorage.clear();
    setTaskStoreForTests([]);
    hydrateCompanyProfileStore(testProfile);
  });

  it('createTaskFromProposal erstellt Aufgabe', () => {
    const task = createTaskFromProposal(baseProposal());
    expect(task.id).toMatch(/^t-/);
    expect(task.status).toBe('open');
    expect(task.createdAt).toBeTruthy();
    expect(isTaskOpen(task)).toBe(true);
  });

  it('Dedupe verhindert doppelte offene Aufgabe', () => {
    const proposal = baseProposal({ dedupeKey: 'manual:src-1:test' });
    const first = createTaskFromProposal(proposal);
    const second = createTaskFromProposal(proposal);
    expect(second.id).toBe(first.id);
    expect(getTasksFiltered('offen')).toHaveLength(1);
  });

  it('erledigte Aufgabe darf neu erzeugt werden', () => {
    const proposal = baseProposal({ dedupeKey: 'manual:src-1:repeat' });
    const first = createTaskFromProposal(proposal);
    completeTask(first.id);
    const second = createTaskFromProposal(proposal);
    expect(second.id).not.toBe(first.id);
  });

  it('completeTask setzt completedAt', () => {
    const task = createTaskFromProposal(baseProposal({ dedupeKey: 'manual:1:complete' }));
    const done = completeTask(task.id);
    expect(done?.status).toBe('done');
    expect(done?.completedAt).toBeTruthy();
    expect(isTaskDone(done!)).toBe(true);
  });

  it('reopenTask entfernt completedAt', () => {
    const task = createTaskFromProposal(baseProposal({ dedupeKey: 'manual:1:reopen' }));
    completeTask(task.id);
    const reopened = reopenTask(task.id);
    expect(reopened?.status).toBe('open');
    expect(reopened?.completedAt).toBeUndefined();
  });

  it('archiveTask setzt status archived', () => {
    const task = createTaskFromProposal(baseProposal({ dedupeKey: 'manual:1:archive' }));
    const archived = archiveTask(task.id);
    expect(archived?.status).toBe('archived');
    expect(isTaskDone(archived!)).toBe(true);
  });

  it('buildDedupeKey nutzt sourceType, sourceId und taskKind', () => {
    expect(
      buildDedupeKey({ sourceType: 'invoice', sourceId: 'inv-1', taskKind: 'payment_overdue' }),
    ).toBe('invoice:inv-1:payment_overdue');
  });
});

describe('taskEngineService filters', () => {
  beforeEach(() => {
    setTaskStoreForTests([]);
  });

  it('filter offen', () => {
    const open = createTaskFromProposal(baseProposal({ dedupeKey: 'f:1:open' }));
    createTaskFromProposal(baseProposal({ dedupeKey: 'f:2:done' }));
    const doneTask = getTasksFiltered('offen').find((t) => t.id !== open.id)!;
    completeTask(doneTask.id);
    expect(getTasksFiltered('offen')).toHaveLength(1);
  });

  it('filter heute', () => {
    createTaskFromProposal(
      baseProposal({ dedupeKey: 'f:heute:1', dueDate: '2026-06-27' }),
    );
    createTaskFromProposal(
      baseProposal({ dedupeKey: 'f:heute:2', dueDate: '2099-01-01' }),
    );
    expect(getTasksFiltered('heute', '2026-06-27')).toHaveLength(1);
  });

  it('filter überfällig', () => {
    createTaskFromProposal(
      baseProposal({ dedupeKey: 'f:over:1', dueDate: '2026-01-01' }),
    );
    createTaskFromProposal(
      baseProposal({ dedupeKey: 'f:over:2', dueDate: '2099-01-01' }),
    );
    expect(getTasksFiltered('ueberfaellig', '2026-06-27')).toHaveLength(1);
  });

  it('filter kritisch', () => {
    createTaskFromProposal(
      baseProposal({ dedupeKey: 'f:crit:1', priority: 'kritisch' }),
    );
    createTaskFromProposal(
      baseProposal({ dedupeKey: 'f:crit:2', priority: 'niedrig' }),
    );
    expect(getTasksFiltered('kritisch')).toHaveLength(1);
  });

  it('filter erledigt', () => {
    const task = createTaskFromProposal(baseProposal({ dedupeKey: 'f:done:1' }));
    completeTask(task.id);
    expect(getTasksFiltered('erledigt')).toHaveLength(1);
  });

  it('getTaskSummary liefert Zähler', () => {
    createTaskFromProposal(
      baseProposal({ dedupeKey: 's:1', priority: 'kritisch', dueDate: '2026-01-01' }),
    );
    const summary = getTaskSummary('2026-06-27');
    expect(summary.open).toBe(1);
    expect(summary.critical).toBe(1);
    expect(summary.overdue).toBe(1);
  });
});

describe('taskEngineService classification proposals', () => {
  beforeEach(() => {
    localStorage.clear();
    setTaskStoreForTests([]);
    hydrateCompanyProfileStore(testProfile);
  });

  it('Mahnung erzeugt Zahlungs-Task', () => {
    const item = createInboxItem({
      sender: 'Bauzentrum Nord GmbH',
      recognizedData: {
        Dokumentart: 'mahnung',
        Betreff: '2. Mahnung Mustermann Sanitär GmbH',
      },
      classifiedKind: 'mahnung',
    });
    const proposals = proposeTasksFromClassification(item, testProfile);
    expect(proposals.some((p) => p.taskKind === 'payment_check')).toBe(true);
    expect(proposals[0]?.category).toBe('zahlungen');
    expect(proposals[0]?.priority).toBe('kritisch');
  });

  it('BG BAU erzeugt Behörden-Task', () => {
    const item = createInboxItem({
      sender: 'BG BAU',
      recognizedData: { Dokumentart: 'bg_bau' },
      classifiedKind: 'bg_bau',
    });
    const proposals = proposeTasksFromClassification(item, testProfile);
    expect(proposals.some((p) => p.taskKind === 'authority_review:bg_bau')).toBe(true);
    expect(proposals[0]?.category).toBe('behoerden');
  });

  it('Freistellung erzeugt Steuer-/Nachweis-Tasks', () => {
    const item = createInboxItem({
      sender: 'Finanzamt',
      recognizedData: {
        Dokumentart: 'freistellungsbescheinigung',
        Gültig_bis: '31.12.2026',
      },
      classifiedKind: 'freistellungsbescheinigung',
    });
    const proposals = proposeTasksFromClassification(item, testProfile);
    expect(proposals.length).toBeGreaterThanOrEqual(2);
    expect(proposals.some((p) => p.taskKind === 'monitor_freistellung_validity')).toBe(true);
    expect(proposals.some((p) => p.taskKind === 'send_freistellung_to_client')).toBe(true);
  });
});

describe('taskEngineService invoice sync', () => {
  beforeEach(() => {
    localStorage.clear();
    setTaskStoreForTests([]);
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-overdue',
        title: 'Sanierung Müller',
        customer: 'Müller GmbH',
        invoices: [
          {
            id: 'inv-overdue-1',
            number: '2026-0999',
            type: 'schluss',
            positions: [],
            subtotal: 1000,
            taxStatus: 'standard_19',
            amount: 1190,
            status: 'versendet',
            date: '2026-01-01',
            createdAt: '2026-01-01T00:00:00.000Z',
            paymentDueDate: '2026-01-01',
          },
        ],
      }),
    ]);
  });

  it('überfällige Rechnung erzeugt Zahlungs-Task', () => {
    const proposals = proposeTasksFromOverdueInvoices('2026-06-27');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.linkedInvoiceId).toBe('inv-overdue-1');
    expect(proposals[0]?.category).toBe('zahlungen');
  });

  it('syncOverdueInvoiceTasks dedupliziert', () => {
    const first = syncOverdueInvoiceTasks('2026-06-27');
    const second = syncOverdueInvoiceTasks('2026-06-27');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.id).toBe(second[0]?.id);
  });
});

describe('taskEngineService contract tasks', () => {
  it('Vertragsnachweise erzeugen mehrere Tasks', () => {
    setTaskStoreForTests([]);
    const analysis = analyzeContract({ recognizedText: SAMPLE_WERKVERTRAG_TEXT });
    const proposals = proposeTasksFromContract(analysis, 'inbox-contract-1');
    expect(proposals.length).toBeGreaterThan(0);
    const tasks = createTasksFromContractAnalysis(analysis, 'inbox-contract-1');
    expect(tasks.length).toBe(proposals.length);
    expect(new Set(tasks.map((t) => t.dedupeKey)).size).toBe(tasks.length);
  });
});

describe('taskEngineService company relevance gating', () => {
  beforeEach(() => {
    setTaskStoreForTests([]);
    hydrateCompanyProfileStore(testProfile);
  });

  it('blockiert Task-Proposals bei fehlendem Firmenbezug', () => {
    const item = createInboxItem({
      sender: 'Unbekannt Privat',
      title: 'Privater Brief',
      recognizedData: { Betreff: 'Privat' },
      documentType: 'brief',
    });
    expect(proposeTasksFromClassification(item, testProfile)).toHaveLength(0);
    expect(proposePrimaryInboxTask(item, testProfile)).toBeNull();
  });
});

describe('taskEngineService legacy normalization', () => {
  it('Legacy-Tasks ohne neue Felder crashen nicht', () => {
    const legacy = normalizeTask({
      id: 't-legacy',
      type: 'dokument_pruefen',
      title: 'Legacy Task',
      description: 'Alt',
      vorgangId: 'v-1',
      vorgangTitle: 'Vorgang',
      done: false,
      dueDate: '2026-04-01',
    } as Partial<Task> & Pick<Task, 'id' | 'title'>);
    expect(legacy.status).toBe('open');
    expect(legacy.dedupeKey).toBeTruthy();
    expect(legacy.category).toBe('dokumente');
    expect(legacy.linkedVorgangId).toBe('v-1');
  });
});

describe('inbox integration with task engine', () => {
  beforeEach(() => {
    localStorage.clear();
    setTaskStoreForTests([]);
    hydrateCompanyProfileStore(testProfile);
    hydrateInboxStore([
      createInboxItem({
        id: 'inbox-dedupe',
        taskTemplate: {
          type: 'dokument_pruefen',
          title: 'BG BAU prüfen',
          description: 'Schreiben prüfen',
          dueDate: '2026-04-10',
        },
        recognizedData: { Dokumentart: 'bg_bau', Betreff: 'BG BAU Beitrag Mustermann Sanitär GmbH' },
        classifiedKind: 'bg_bau',
        markedAsCompanyDocument: true,
      }),
    ]);
  });

  it('confirmFiling und createTaskForItem erzeugen nur eine Aufgabe', () => {
    const filing = confirmFiling('inbox-dedupe');
    expect(filing?.taskCreated).toBeTruthy();

    const manual = createTaskForItem('inbox-dedupe');
    expect(manual?.taskCreated?.id).toBe(filing?.taskCreated?.id);
    expect(getTasksFiltered('offen')).toHaveLength(1);
  });

  it('createContractTasksForItem erzeugt Aufgaben aus Vertrag', () => {
    hydrateInboxStore([
      createInboxItem({
        id: 'inbox-contract',
        recognizedData: {
          Dokumentart: 'werkvertrag',
          _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
        },
        classifiedKind: 'werkvertrag',
        markedAsCompanyDocument: true,
      }),
    ]);
    const result = createContractTasksForItem('inbox-contract');
    expect(result?.success).toBe(true);
    expect(getTasksFiltered('offen').length).toBeGreaterThan(0);
  });

  it('blockiert Erstellung ohne Firmenbezug', () => {
    hydrateInboxStore([
      createInboxItem({
        id: 'inbox-private',
        sender: 'Privatperson',
        title: 'Privat',
        recognizedData: { Betreff: 'Privat' },
        taskTemplate: {
          type: 'dokument_pruefen',
          title: 'Prüfen',
          description: 'Privat',
        },
      }),
    ]);
    expect(createTaskForItem('inbox-private')).toBeNull();
  });
});

describe('taskEngineService persistence', () => {
  it('persistiert Tasks über localStorage', () => {
    localStorage.clear();
    setTaskStoreForTests([]);
    createTaskFromProposal(baseProposal({ dedupeKey: 'persist:1' }));
    persistAll();
    const loaded = loadPersistedState();
    expect(loaded?.tasks).toHaveLength(1);
    expect(loaded?.tasks[0]?.title).toBe('Testaufgabe');
    expect(loaded?.tasks[0]?.dedupeKey).toBeTruthy();
  });
});
