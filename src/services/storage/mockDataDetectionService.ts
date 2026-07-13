import type { AppPersistedState, InboxItem, Vorgang } from '../../types/models';

export const DEFINITE_MOCK_VORGANG_IDS = new Set(['v-001', 'v-002', 'v-003']);

export const DEFINITE_MOCK_VORGANG_TITLES = new Set([
  'Badezimmer-Sanierung Müller',
  'Elektroinstallation Weber',
  'Dachreparatur Schmidt',
]);

export const DEFINITE_MOCK_INBOX_IDS = new Set([
  'inbox-001',
  'inbox-002',
  'inbox-003',
  'inbox-004',
  'inbox-005',
  'inbox-006',
]);

export const DEFINITE_MOCK_TASK_IDS = new Set(['t-001', 't-002', 't-003']);

export function isDefinitelyMockVorgang(vorgang: Vorgang): boolean {
  if (DEFINITE_MOCK_VORGANG_IDS.has(vorgang.id)) return true;
  if (DEFINITE_MOCK_VORGANG_TITLES.has(vorgang.title.trim())) return true;
  return false;
}

export function isDefinitelyMockInboxItem(item: InboxItem): boolean {
  if (DEFINITE_MOCK_INBOX_IDS.has(item.id)) return true;
  if (item.vorgangId && DEFINITE_MOCK_VORGANG_IDS.has(item.vorgangId)) return true;
  return false;
}

export function stateContainsDefinitelyMockData(state: AppPersistedState): boolean {
  if (state.vorgaenge.some(isDefinitelyMockVorgang)) return true;
  if (state.inboxItems.some(isDefinitelyMockInboxItem)) return true;
  if (state.tasks.some((task) => DEFINITE_MOCK_TASK_IDS.has(task.id))) return true;
  return false;
}

export interface MockDataInventory {
  vorgaenge: Vorgang[];
  inboxItems: InboxItem[];
  taskIds: string[];
}

export function inventoryDefinitelyMockData(state: AppPersistedState): MockDataInventory {
  return {
    vorgaenge: state.vorgaenge.filter(isDefinitelyMockVorgang),
    inboxItems: state.inboxItems.filter(isDefinitelyMockInboxItem),
    taskIds: state.tasks.filter((task) => DEFINITE_MOCK_TASK_IDS.has(task.id)).map((t) => t.id),
  };
}

export function stripDefinitelyMockDataFromState(state: AppPersistedState): AppPersistedState {
  const mockVorgangIds = new Set(
    state.vorgaenge.filter(isDefinitelyMockVorgang).map((v) => v.id),
  );

  return {
    ...state,
    vorgaenge: state.vorgaenge.filter((v) => !isDefinitelyMockVorgang(v)),
    inboxItems: state.inboxItems.filter((item) => !isDefinitelyMockInboxItem(item)),
    tasks: state.tasks.filter((task) => !DEFINITE_MOCK_TASK_IDS.has(task.id)),
    documents: (state.documents ?? []).filter(
      (doc) => !doc.linkedVorgang?.vorgangId || !mockVorgangIds.has(doc.linkedVorgang.vorgangId),
    ),
  };
}

export function isDefinitelyMockVorgangId(vorgangId: string | undefined | null): boolean {
  return Boolean(vorgangId && DEFINITE_MOCK_VORGANG_IDS.has(vorgangId));
}
