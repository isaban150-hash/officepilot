/**
 * DOCUMENT-ARCHIVE-TRUTH-03A2 — read-only CompanyDocument → TruthView adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDocumentFieldFillConfirmViewModel,
} from './documentFieldFillConfirmService';
import { persistFillConfirmRowsToDocumentWorkOverlay } from './documentFieldFillConfirmPersistService';
import {
  buildDocumentWorkResultSourceFingerprint,
  buildDocumentWorkTruthViewForInboxItem,
  getDocumentWorkResult,
  getDocumentWorkResultForItem,
  isDocumentWorkResultUsableForDisplay,
  mergeDocumentWorkResultOnReanalysis,
  projectDocumentWorkResultFromWorkflow,
  resetDocumentWorkResultStoreForTests,
  resolveDocumentWorkTruthViewForCompanyDocument,
  upsertDocumentWorkResult,
  upsertDocumentWorkResultOverlayEntry,
} from './documentWorkResultService';
import * as documentWorkResultStoreService from './documentWorkResultStoreService';
import { withInboxExtractedDocumentText } from './inboxDocumentText';
import { getInboxItemById, hydrateInboxStore, markInboxImportedToArchive } from './inboxService';
import { processUploadedDocument } from './intakeWorkflowService';
import { hydrateDocumentStore, importInboxDocument } from './documentService';
import * as persistenceService from './persistenceService';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { setWorkspace } from './workspace/workspaceStore';
import {
  DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
  DOCUMENT_WORK_RESULT_SCHEMA_VERSION,
  type DocumentWorkResult,
} from '../types/documentWorkResult';
import type { DocumentFieldFillConfirmRow } from '../types/documentFieldFillConfirm';
import type { CompanyDocument, InboxItem } from '../types/models';

function itemWithText(text: string, overrides: Partial<InboxItem> = {}): InboxItem {
  const base = createAuftragInboxItem({
    id: 'inbox-03a2-origin',
    sender: '',
    deadline: null,
    title: '03A2 Archiv',
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

function archiveDocFor(
  item: InboxItem,
  overrides: Partial<CompanyDocument> = {},
): CompanyDocument {
  const imported = importInboxDocument(item, 'Test GmbH');
  expect(imported.success).toBe(true);
  if (!imported.success) throw new Error('import failed');
  markInboxImportedToArchive(item.id, imported.document.id);
  return {
    ...imported.document,
    ...overrides,
    sourceInboxItemId: overrides.sourceInboxItemId ?? imported.document.sourceInboxItemId,
  };
}

beforeEach(() => {
  resetTestStores();
  resetDocumentWorkResultStoreForTests();
  hydrateDocumentStore([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetDocumentWorkResultStoreForTests();
  resetTestStores();
});

describe('DOCUMENT-ARCHIVE-TRUTH-03A2 CompanyDocument Truth adapter', () => {
  it('1 — Origin + persistiertes Confirm-Overlay: Wert und Provenienz erhalten', () => {
    const item = itemWithText('Betrag: 1.200,00 EUR');
    seedDwrForItem(item);
    const rows = confirmRow(
      buildDocumentFieldFillConfirmViewModel(item).rows,
      'Betrag',
      '1.250,00 EUR',
    );
    expect(
      persistFillConfirmRowsToDocumentWorkOverlay({ inboxItemId: item.id, rows }).success,
    ).toBe(true);

    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.reason).toBe('available');
    expect(result.truthView).not.toBeNull();
    expect(
      result.truthView?.slots.find((s) => s.slotId === 'facts.money.0')?.provenance,
    ).toMatch(/user_confirmed|user_corrected/);
    const money = result.truthView?.businessInterpretation?.facts.money[0] as
      | { amountFormatted?: string; amount?: number }
      | undefined;
    expect(
      String(money?.amountFormatted ?? '').includes('1.250') || money?.amount === 1250,
    ).toBe(true);
  });

  it('2 — Origin mit DWR ohne Overlay: Analyse-Truth, keine Confirm-Provenienz', () => {
    const item = itemWithText('Frist: 15.08.2026\nAbsender: Amt X');
    seedDwrForItem(item);
    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.reason).toBe('available');
    expect(result.truthView).not.toBeNull();
    const confirmed = result.truthView?.slots.filter(
      (s) => s.provenance === 'user_confirmed' || s.provenance === 'user_corrected',
    );
    expect(confirmed ?? []).toHaveLength(0);
  });

  it('3 — ohne sourceInboxItemId → no_source_inbox', () => {
    const doc: CompanyDocument = {
      id: 'doc-legacy',
      title: 'Legacy',
      category: 'sonstiges',
      issuer: 'X',
      recognizedText: 'text',
      issueDate: null,
      validUntil: null,
      digitalFolder: { id: 'd', name: 'F', path: '/F/' },
      paperFolder: { folderId: 'f', register: 'A', label: 'L' },
      tags: [],
      linkedCompany: 'Test GmbH',
      linkedVorgang: null,
      archived: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.truthView).toBeNull();
    expect(result.reason).toBe('no_source_inbox');
  });

  it('4 — sourceInboxItemId zeigt auf fehlendes InboxItem', () => {
    const doc: CompanyDocument = {
      id: 'doc-orphan',
      title: 'Orphan',
      category: 'sonstiges',
      issuer: 'X',
      recognizedText: '',
      issueDate: null,
      validUntil: null,
      digitalFolder: { id: 'd', name: 'F', path: '/F/' },
      paperFolder: { folderId: 'f', register: 'A', label: 'L' },
      tags: [],
      linkedCompany: 'Test GmbH',
      linkedVorgang: null,
      archived: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceInboxItemId: 'inbox-does-not-exist',
    };
    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.truthView).toBeNull();
    expect(result.reason).toBe('source_inbox_missing');
  });

  it('5 — Inbox vorhanden, DWR fehlt → truth_unavailable', () => {
    const item = itemWithText('Absender: Nur Inbox');
    hydrateInboxStore([item]);
    const doc: CompanyDocument = {
      id: 'doc-no-dwr',
      title: item.title,
      category: 'sonstiges',
      issuer: item.sender || 'X',
      recognizedText: '',
      issueDate: null,
      validUntil: null,
      digitalFolder: { ...item.digitalFolder },
      paperFolder: { ...item.paperFiling },
      tags: [],
      linkedCompany: 'Test GmbH',
      linkedVorgang: null,
      archived: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceInboxItemId: item.id,
    };
    expect(getDocumentWorkResult(item.id)).toBeNull();
    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.truthView).toBeNull();
    expect(result.reason).toBe('truth_unavailable');
  });

  it('6 — stale Fingerprint: keine TruthView, Overlay nicht still angewendet', () => {
    const item = itemWithText('Betrag: 100 EUR');
    const dwr = seedDwrForItem(item);
    let withOverlay = upsertDocumentWorkResultOverlayEntry(dwr, {
      slotId: 'facts.money.0',
      status: 'user_corrected',
      value: {
        kind: 'other',
        amount: 999,
        amountFormatted: '999,00 EUR',
        certainty: 'proposed',
        source: 'understanding',
      },
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    withOverlay = {
      ...withOverlay,
      sourceFingerprint: `${dwr.sourceFingerprint}-stale`,
    };
    upsertDocumentWorkResult(withOverlay);

    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.truthView).toBeNull();
    expect(result.reason).toBe('truth_unavailable');
  });

  it('7 — Workspace-Mismatch: keine TruthView (kein fremdes DWR)', () => {
    const item = itemWithText('Betrag: 50 EUR');
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

    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const result = resolveDocumentWorkTruthViewForCompanyDocument({
      document: doc,
      workspaceId: 'ws-local',
    });
    expect(result.truthView).toBeNull();
    expect(result.reason).toBe('truth_unavailable');
    expect(getDocumentWorkResultForItem(item.id, { workspaceId: 'ws-local' })).toBeNull();
  });

  it('8 — Legacy-DWR ohne workspaceId behält bestehendes Verhalten', () => {
    const item = itemWithText('Frist: 20.08.2026');
    const dwr = seedDwrForItem(item);
    upsertDocumentWorkResult({ ...dwr, workspaceId: null });
    setWorkspace({
      id: 'ws-local',
      name: 'Local',
      ownerUserId: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    });

    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const result = resolveDocumentWorkTruthViewForCompanyDocument({
      document: doc,
      workspaceId: 'ws-local',
    });
    expect(result.reason).toBe('available');
    expect(result.truthView).not.toBeNull();
    expect(
      isDocumentWorkResultUsableForDisplay(getDocumentWorkResult(item.id)!, getInboxItemById(item.id)!, {
        workspaceId: 'ws-local',
      }),
    ).toBe(true);
  });

  it('9 — fehlender archiveDocumentId-Rücklink blockiert nicht', () => {
    const item = itemWithText('Absender: Rücklink frei');
    seedDwrForItem(item);
    const live = getInboxItemById(item.id)!;
    const doc = archiveDocFor(live);
    hydrateInboxStore([
      {
        ...getInboxItemById(item.id)!,
        archiveDocumentId: undefined,
      },
    ]);
    expect(getDocumentWorkResult(item.id)).not.toBeNull();

    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.reason).toBe('available');
    expect(result.truthView).not.toBeNull();
    expect(result.diagnostic).toBeUndefined();
  });

  it('10 — widersprüchlicher archiveDocumentId: Truth folgt sourceInboxItemId', () => {
    const item = itemWithText('Absender: Konflikt');
    seedDwrForItem(item);
    const doc = archiveDocFor(getInboxItemById(item.id)!);
    hydrateInboxStore([
      {
        ...getInboxItemById(item.id)!,
        archiveDocumentId: 'doc-other-wrong',
      },
    ]);
    expect(getDocumentWorkResult(item.id)).not.toBeNull();

    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.reason).toBe('available');
    expect(result.truthView).not.toBeNull();
    expect(result.diagnostic).toBe('origin_conflict');
  });

  it('11 — zwei CompanyDocuments mit demselben Origin → gleiche Truth', () => {
    const item = itemWithText('Betrag: 300,00 EUR');
    seedDwrForItem(item);
    const rows = confirmRow(
      buildDocumentFieldFillConfirmViewModel(item).rows,
      'Betrag',
      '300,00 EUR',
    );
    expect(
      persistFillConfirmRowsToDocumentWorkOverlay({ inboxItemId: item.id, rows }).success,
    ).toBe(true);

    const live = getInboxItemById(item.id)!;
    const docA = archiveDocFor(live);
    const docB: CompanyDocument = {
      ...docA,
      id: 'doc-second-same-origin',
      title: 'Kopie',
      sourceInboxItemId: item.id,
    };

    const a = resolveDocumentWorkTruthViewForCompanyDocument({ document: docA });
    const b = resolveDocumentWorkTruthViewForCompanyDocument({ document: docB });
    expect(a.reason).toBe('available');
    expect(b.reason).toBe('available');
    expect(a.truthView?.inboxItemId).toBe(b.truthView?.inboxItemId);
    expect(
      a.truthView?.slots.find((s) => s.slotId === 'facts.money.0')?.provenance,
    ).toBe(b.truthView?.slots.find((s) => s.slotId === 'facts.money.0')?.provenance);
  });

  it('12 — Read-only: kein persistAll, keine Store-Mutation', () => {
    const item = itemWithText('Absender: Readonly');
    seedDwrForItem(item);
    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const dwrBefore = JSON.stringify(
      documentWorkResultStoreService.getDocumentWorkResultStoreSnapshot(),
    );
    const inboxBefore = JSON.stringify(getInboxItemById(item.id));

    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.reason).toBe('available');
    expect(persistSpy).not.toHaveBeenCalled();
    expect(
      JSON.stringify(documentWorkResultStoreService.getDocumentWorkResultStoreSnapshot()),
    ).toBe(dwrBefore);
    expect(JSON.stringify(getInboxItemById(item.id))).toBe(inboxBefore);
  });

  it('13 — discarded Overlay-Slot bleibt verworfen', () => {
    const item = itemWithText('Absender: Weg');
    const dwr = seedDwrForItem(item);
    upsertDocumentWorkResult(
      upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.parties.counterparty',
        status: 'discarded',
        value: null,
        updatedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.reason).toBe('available');
    const slot = result.truthView?.slots.find((s) => s.slotId === 'facts.parties.counterparty');
    expect(slot?.provenance).toBe('discarded');
  });

  it('14 — Re-Analyse-Konflikt bleibt sichtbar', () => {
    const item = itemWithText('Betrag: 10 EUR');
    const first = seedDwrForItem(item);
    const confirmed = upsertDocumentWorkResultOverlayEntry(first, {
      slotId: 'facts.money.0',
      status: 'user_corrected',
      value: {
        kind: 'other',
        amount: 42,
        amountFormatted: '42,00',
        certainty: 'proposed',
        source: 'understanding',
      },
      updatedAt: '2026-07-01T00:00:00.000Z',
    });
    const nextProjected: DocumentWorkResult = {
      ...projectDocumentWorkResultFromWorkflow({
        workflow: processUploadedDocument(item.id)!,
        inboxItem: getInboxItemById(item.id)!,
        workspaceId: first.workspaceId ?? null,
      }),
      sourceFingerprint: `${first.sourceFingerprint}-changed`,
      businessInterpretation: first.businessInterpretation
        ? JSON.parse(JSON.stringify(first.businessInterpretation))
        : null,
    };
    const merged = mergeDocumentWorkResultOnReanalysis(confirmed, nextProjected);
    expect(merged.overlay.find((e) => e.slotId === 'facts.money.0')?.reviewConflict).toBe(true);
    upsertDocumentWorkResult({
      ...merged,
      sourceFingerprint: buildDocumentWorkResultSourceFingerprint(getInboxItemById(item.id)!),
      schemaVersion: DOCUMENT_WORK_RESULT_SCHEMA_VERSION,
      analysisVersion: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });

    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.reason).toBe('available');
    expect(
      result.truthView?.unresolvedConflicts.some((c) => c.slotId === 'facts.money.0'),
    ).toBe(true);
  });

  it('15 — kein Hash-Fallback bei fehlendem Origin', () => {
    const item = itemWithText('Absender: Hash bait', {
      id: 'inbox-hash-bait',
      sourceFileHash: 'hash-shared-abc',
    });
    seedDwrForItem(item);
    const rows = confirmRow(
      buildDocumentFieldFillConfirmViewModel(item).rows,
      'Absender',
      'Hash bait',
    );
    expect(
      persistFillConfirmRowsToDocumentWorkOverlay({ inboxItemId: item.id, rows }).success,
    ).toBe(true);

    const doc: CompanyDocument = {
      id: 'doc-no-origin-same-hash',
      title: item.title,
      category: 'sonstiges',
      issuer: 'Hash bait',
      recognizedText: 'Absender: Hash bait',
      issueDate: null,
      validUntil: null,
      digitalFolder: { ...item.digitalFolder },
      paperFolder: { ...item.paperFiling },
      tags: [],
      linkedCompany: 'Test GmbH',
      linkedVorgang: null,
      archived: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceFileHash: 'hash-shared-abc',
    };

    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.truthView).toBeNull();
    expect(result.reason).toBe('no_source_inbox');
  });

  it('16 — expliziter workspaceId wird im Inbox-TruthView-Resolver/DWR-Guards verwendet', () => {
    const item = itemWithText('Betrag: 80 EUR');
    const dwr = seedDwrForItem(item);
    upsertDocumentWorkResult({ ...dwr, workspaceId: 'ws-explicit-match' });
    setWorkspace({
      id: 'ws-ambient-other',
      name: 'Ambient',
      ownerUserId: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    });
    const doc = archiveDocFor(getInboxItemById(item.id)!);

    // Ambient differs from DWR → no Truth without explicit override.
    const ambient = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(ambient.truthView).toBeNull();
    expect(ambient.reason).toBe('truth_unavailable');

    // Explicit matching workspace must reach the same DWR guards (not only a pre-check).
    // If only a pre-check used workspaceId and the builder used ambient, this would stay null.
    const explicit = resolveDocumentWorkTruthViewForCompanyDocument({
      document: doc,
      workspaceId: 'ws-explicit-match',
    });
    expect(explicit.reason).toBe('available');
    expect(explicit.truthView).not.toBeNull();
    expect(getDocumentWorkResultForItem(item.id, { workspaceId: 'ws-explicit-match' })).not.toBeNull();
    expect(getDocumentWorkResultForItem(item.id, { workspaceId: 'ws-ambient-other' })).toBeNull();
  });

  it('17 — Adapter greift nicht auf DWR-Rohsnapshot zu', () => {
    const item = itemWithText('Absender: Snapshot frei');
    seedDwrForItem(item);
    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const snapSpy = vi.spyOn(
      documentWorkResultStoreService,
      'getDocumentWorkResultStoreSnapshot',
    );

    const result = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc });
    expect(result.reason).toBe('available');
    expect(snapSpy).not.toHaveBeenCalled();
  });

  it('18 — buildDocumentWorkTruthViewForInboxItem ohne workspaceId behält Ambient-Verhalten', () => {
    const item = itemWithText('Absender: Ambient Call');
    const dwr = seedDwrForItem(item);
    upsertDocumentWorkResult({ ...dwr, workspaceId: 'ws-a' });

    setWorkspace({
      id: 'ws-a',
      name: 'A',
      ownerUserId: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    });
    expect(buildDocumentWorkTruthViewForInboxItem({ item })).not.toBeNull();

    setWorkspace({
      id: 'ws-b',
      name: 'B',
      ownerUserId: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    });
    // Without workspaceId param: ambient ws-b mismatches DWR → null (previous behavior).
    expect(buildDocumentWorkTruthViewForInboxItem({ item })).toBeNull();
    // Explicit override still available for callers that opt in.
    expect(
      buildDocumentWorkTruthViewForInboxItem({ item, workspaceId: 'ws-a' }),
    ).not.toBeNull();
  });
});
