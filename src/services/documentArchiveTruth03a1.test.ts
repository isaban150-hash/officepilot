/**
 * DOCUMENT-ARCHIVE-TRUTH-03A1 — Fill-Confirm → DWR overlay local persistence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentFieldFillConfirmPanel } from '../components/documents/DocumentFieldFillConfirmPanel';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import {
  buildDocumentFieldFillConfirmViewModel,
} from './documentFieldFillConfirmService';
import {
  persistFillConfirmRowsToDocumentWorkOverlay,
} from './documentFieldFillConfirmPersistService';
import {
  applyStoredOverlayToFillConfirmRows,
  mapFillConfirmRowsToDocumentWorkResultOverlayEntries,
  mapFillConfirmRowsToSessionTruthOverlay,
} from './documentFieldFillConfirmTruthBridge';
import {
  buildDocumentWorkTruthViewForInboxItem,
  getDocumentWorkResult,
  mergeDocumentWorkResultOnReanalysis,
  projectDocumentWorkResultFromWorkflow,
  resetDocumentWorkResultStoreForTests,
  upsertDocumentWorkResult,
} from './documentWorkResultService';
import { getDocumentWorkResultStoreSnapshot } from './documentWorkResultStoreService';
import { withInboxExtractedDocumentText } from './inboxDocumentText';
import { hydrateInboxStore } from './inboxService';
import { processUploadedDocument } from './intakeWorkflowService';
import {
  buildPersistedStateSnapshot,
  hydrateStoresFromStorage,
  savePersistedState,
} from './persistenceService';
import * as persistenceService from './persistenceService';
import { SUPABASE_SYNC_ALLOWLIST } from './sync/cloudSyncAllowlist';
import type { SyncEntityType } from '../types/sync';
import { createAuftragInboxItem } from '../test/fixtures';
import { setWorkspace } from './workspace/workspaceStore';
import type { DocumentFieldFillConfirmRow } from '../types/documentFieldFillConfirm';
import type { DocumentWorkResult } from '../types/documentWorkResult';
import type { InboxItem } from '../types/models';

const PREFIX = 'document-field-fill-confirm';

function itemWithText(text: string, overrides: Partial<InboxItem> = {}): InboxItem {
  const base = createAuftragInboxItem({
    id: 'inbox-03a1-fill',
    sender: '',
    deadline: null,
    title: '03A1 Test',
    ...overrides,
  });
  return {
    ...base,
    recognizedData: withInboxExtractedDocumentText(base.recognizedData, text),
  };
}

function seedDwrForItem(item: InboxItem): DocumentWorkResult {
  hydrateInboxStore([item]);
  const workflow = processUploadedDocument(item.id);
  expect(workflow).not.toBeNull();
  const stored = getDocumentWorkResult(item.id);
  expect(stored).not.toBeNull();
  return stored!;
}

function confirmRow(
  rows: readonly DocumentFieldFillConfirmRow[],
  fieldKey: string,
  confirmedValue?: string,
): DocumentFieldFillConfirmRow[] {
  return rows.map((row) => {
    if (row.fieldKey !== fieldKey) return row;
    const value = (confirmedValue ?? row.proposedValue).trim();
    return Object.freeze({
      ...row,
      status: 'confirmed' as const,
      confirmedValue: value,
    });
  });
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {  resetDocumentWorkResultStoreForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDocumentWorkResultStoreForTests();
  document.body.innerHTML = '';
});

describe('DOCUMENT-ARCHIVE-TRUTH-03A1 Fill-Confirm DWR overlay', () => {
  it('A — Bestätigung schreibt Overlay user_confirmed mit korrektem Slot', () => {
    const item = itemWithText('Absender: Muster GmbH\nBetrag: 1.200,00 EUR');
    seedDwrForItem(item);
    const rows = confirmRow(
      buildDocumentFieldFillConfirmViewModel(item).rows,
      'Betrag',
    );

    const result = persistFillConfirmRowsToDocumentWorkOverlay({
      inboxItemId: item.id,
      rows,
      updatedAt: '2026-07-29T12:00:00.000Z',
    });
    expect(result.success).toBe(true);

    const money = getDocumentWorkResult(item.id)?.overlay.find((e) => e.slotId === 'facts.money.0');
    expect(money?.status).toBe('user_confirmed');
    expect(money?.value).toMatchObject({
      amountFormatted: expect.stringMatching(/1\.200/),
    });
  });

  it('B — Korrektur schreibt user_corrected; Analyse-Snapshot unverändert', () => {
    const item = itemWithText('Betrag: 1.200,00 EUR');
    const before = seedDwrForItem(item);
    const analysisBiBefore = JSON.stringify(before.businessInterpretation);

    const rows = confirmRow(
      buildDocumentFieldFillConfirmViewModel(item).rows,
      'Betrag',
      '1.250,00 EUR',
    );
    expect(
      mapFillConfirmRowsToDocumentWorkResultOverlayEntries(rows)[0]?.status,
    ).toBe('user_corrected');

    const result = persistFillConfirmRowsToDocumentWorkOverlay({
      inboxItemId: item.id,
      rows,
    });
    expect(result.success).toBe(true);

    const after = getDocumentWorkResult(item.id)!;
    expect(JSON.stringify(after.businessInterpretation)).toBe(analysisBiBefore);
    const overlay = after.overlay.find((e) => e.slotId === 'facts.money.0');
    expect(overlay?.status).toBe('user_corrected');

    const truth = buildDocumentWorkTruthViewForInboxItem({ item });
    expect(truth?.slots.find((s) => s.slotId === 'facts.money.0')?.provenance).toMatch(
      /user_confirmed|user_corrected/,
    );
    const effective = truth?.businessInterpretation?.facts.money[0] as
      | { amountFormatted?: string; amount?: number }
      | undefined;
    expect(
      String(effective?.amountFormatted ?? '').includes('1.250') || effective?.amount === 1250,
    ).toBe(true);
  });

  it('C — Batch-Persistenz mehrerer Felder mit einem persistAll', () => {
    const item = itemWithText(
      'Absender: Alt GmbH\nFrist: 01.08.2026\nBetrag: 100,00 EUR',
    );
    seedDwrForItem(item);
    // Pre-existing overlay entry must survive unrelated slots.
    const seeded = getDocumentWorkResult(item.id)!;
    upsertDocumentWorkResult({
      ...seeded,
      overlay: [
        {
          slotId: 'facts.parties.ownCompany',
          status: 'user_confirmed',
          value: 'Eigene Firma',
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      ],
    });

    let rows = [...buildDocumentFieldFillConfirmViewModel(item).rows];
    rows = confirmRow(rows, 'Absender', 'Neu GmbH');
    rows = confirmRow(rows, 'Frist', '15.08.2026');
    rows = confirmRow(rows, 'Betrag', '100,00 EUR');

    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const result = persistFillConfirmRowsToDocumentWorkOverlay({
      inboxItemId: item.id,
      rows,
    });
    expect(result.success).toBe(true);
    expect(persistSpy).toHaveBeenCalledTimes(1);

    const overlay = getDocumentWorkResult(item.id)!.overlay;
    expect(overlay.find((e) => e.slotId === 'facts.parties.ownCompany')?.value).toBe(
      'Eigene Firma',
    );
    expect(overlay.find((e) => e.slotId === 'facts.parties.counterparty')?.value).toBe(
      'Neu GmbH',
    );
    expect(overlay.find((e) => e.slotId === 'facts.timeline.deadline')?.value).toBe(
      '15.08.2026',
    );
    expect(overlay.find((e) => e.slotId === 'facts.money.0')).toBeTruthy();
  });

  it('D — Reload/Hydration: TruthView behält Nutzerwert und Provenienz', () => {
    const item = itemWithText('Frist: 05.08.2026');
    seedDwrForItem(item);
    const rows = confirmRow(
      buildDocumentFieldFillConfirmViewModel(item).rows,
      'Frist',
      '15.08.2026',
    );
    expect(
      persistFillConfirmRowsToDocumentWorkOverlay({ inboxItemId: item.id, rows }).success,
    ).toBe(true);

    const snapshot = buildPersistedStateSnapshot();
    resetDocumentWorkResultStoreForTests();
    expect(getDocumentWorkResult(item.id)).toBeNull();

    savePersistedState(snapshot);
    hydrateStoresFromStorage();

    const restored = getDocumentWorkResult(item.id);
    expect(restored?.overlay.find((e) => e.slotId === 'facts.timeline.deadline')).toMatchObject({
      status: 'user_corrected',
      value: '15.08.2026',
    });

    hydrateInboxStore([item]);
    const truth = buildDocumentWorkTruthViewForInboxItem({ item });
    expect(truth?.businessInterpretation?.facts.timeline.deadline?.value).toBe('15.08.2026');
    expect(
      truth?.slots.find((s) => s.slotId === 'facts.timeline.deadline')?.provenance,
    ).toBe('user_corrected');

    const uiRows = applyStoredOverlayToFillConfirmRows(
      buildDocumentFieldFillConfirmViewModel(item).rows,
      restored?.overlay,
    );
    expect(uiRows.find((r) => r.fieldKey === 'Frist')).toMatchObject({
      status: 'confirmed',
      confirmedValue: '15.08.2026',
    });
  });

  it('E — Re-Analyse bewahrt Overlay und Nutzerwert', () => {
    const item = itemWithText('Betrag: 500,00 EUR');
    const first = seedDwrForItem(item);
    const rows = confirmRow(
      buildDocumentFieldFillConfirmViewModel(item).rows,
      'Betrag',
      '750,00 EUR',
    );
    expect(
      persistFillConfirmRowsToDocumentWorkOverlay({ inboxItemId: item.id, rows }).success,
    ).toBe(true);

    const withConfirm = getDocumentWorkResult(item.id)!;
    const reprojected = projectDocumentWorkResultFromWorkflow({
      workflow: processUploadedDocument(item.id)!,
      inboxItem: item,
      workspaceId: first.workspaceId ?? null,
    });
    const nextProjected: DocumentWorkResult = {
      ...reprojected,
      sourceFingerprint: `${first.sourceFingerprint}-changed`,
      businessInterpretation: first.businessInterpretation
        ? JSON.parse(JSON.stringify(first.businessInterpretation))
        : null,
    };
    const merged = mergeDocumentWorkResultOnReanalysis(withConfirm, nextProjected);
    const moneyOverlay = merged.overlay.find((e) => e.slotId === 'facts.money.0');
    expect(moneyOverlay?.status).toBe('user_corrected');
    expect(moneyOverlay?.reviewConflict).toBe(true);
    expect(moneyOverlay?.conflictReason).toBe('source_fingerprint_changed');
    expect(moneyOverlay?.value).toMatchObject({
      amountFormatted: '750,00 EUR',
    });
    // BI core remains the projected analysis snapshot, not overwritten by overlay write.
    expect(JSON.stringify(merged.businessInterpretation)).toBe(
      JSON.stringify(nextProjected.businessInterpretation),
    );
  });

  it('F — Workspace-Mismatch verhindert Write', () => {
    const item = itemWithText('Betrag: 10 EUR');
    const dwr = seedDwrForItem(item);
    upsertDocumentWorkResult({ ...dwr, workspaceId: 'ws-foreign' });
    setWorkspace({
      id: 'ws-local',
      name: 'Local',
      ownerUserId: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    });

    const before = JSON.stringify(getDocumentWorkResultStoreSnapshot());
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const rows = confirmRow(buildDocumentFieldFillConfirmViewModel(item).rows, 'Betrag');
    const result = persistFillConfirmRowsToDocumentWorkOverlay({
      inboxItemId: item.id,
      rows,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('workspace_mismatch');
    expect(persistSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(getDocumentWorkResultStoreSnapshot())).toBe(before);
  });

  it('G — Persistenzfehler: Store-Rollback, kein Erfolg', async () => {
    const item = itemWithText('Absender: Fail GmbH');
    seedDwrForItem(item);
    const beforeOverlay = JSON.stringify(getDocumentWorkResult(item.id)?.overlay ?? []);

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: {
        stage: 'localStorage_setItem',
        message: 'disk full',
        storageKey: 'test',
        existingStoredCharacters: 0,
      },
    } as ReturnType<typeof persistenceService.persistAll>);

    const rows = confirmRow(buildDocumentFieldFillConfirmViewModel(item).rows, 'Absender');
    const result = persistFillConfirmRowsToDocumentWorkOverlay({
      inboxItemId: item.id,
      rows,
    });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('persist_failed');
    expect(JSON.stringify(getDocumentWorkResult(item.id)?.overlay ?? [])).toBe(beforeOverlay);

    // UI: confirm reverts when persist fails
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let failedMessage: string | null = null;
    await act(async () => {
      root.render(
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(DocumentFieldFillConfirmPanel, {
            item,
            testIdPrefix: PREFIX,
            onPersistFailed: (message) => {
              failedMessage = message;
            },
          }),
        ),
      );
    });
    await flushUi();
    await act(async () => {
      (
        container.querySelector(
          `[data-testid="${PREFIX}-confirm-Absender"]`,
        ) as HTMLButtonElement
      ).click();
    });
    await flushUi();
    expect(
      container.querySelector(`[data-testid="${PREFIX}-row-Absender"]`)?.getAttribute(
        'data-status',
      ),
    ).toBe('proposed');
    expect(failedMessage).toMatch(/Speichern fehlgeschlagen/i);
    expect(container.querySelector(`[data-testid="${PREFIX}-persist-error"]`)).toBeTruthy();

    await act(async () => {
      root.unmount();
    });
  });

  it('H — keine Cloud-Nebenwirkung / Allowlist unverändert', () => {
    const item = itemWithText('Betrag: 1 EUR');
    seedDwrForItem(item);
    const allowlistBefore = [...SUPABASE_SYNC_ALLOWLIST].sort().join(',');
    expect(SUPABASE_SYNC_ALLOWLIST.has('document' as SyncEntityType)).toBe(false);
    expect(
      (SUPABASE_SYNC_ALLOWLIST as ReadonlySet<string>).has('document_work_result'),
    ).toBe(false);

    const rows = confirmRow(buildDocumentFieldFillConfirmViewModel(item).rows, 'Betrag');
    expect(
      persistFillConfirmRowsToDocumentWorkOverlay({ inboxItemId: item.id, rows }).success,
    ).toBe(true);

    expect([...SUPABASE_SYNC_ALLOWLIST].sort().join(',')).toBe(allowlistBefore);
    // Session mapper remains the shared source (same entries).
    expect(mapFillConfirmRowsToSessionTruthOverlay(rows).sessionOverlayEntries).toEqual(
      mapFillConfirmRowsToDocumentWorkResultOverlayEntries(rows),
    );
  });
});
