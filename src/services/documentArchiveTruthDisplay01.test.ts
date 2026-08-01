import { importInboxDocumentForTests } from '../test/confirmFilingDecisionForTests';
/**
 * DOCUMENT-ARCHIVE-TRUTH-DISPLAY-01 — read-only archive TruthView facts UI model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentArchiveTruthFactsCard } from '../components/documents/DocumentArchiveTruthFactsCard';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDocumentArchiveTruthDisplayView } from './documentArchiveTruthDisplayService';
import { buildDocumentFieldFillConfirmViewModel } from './documentFieldFillConfirmService';
import { persistFillConfirmRowsToDocumentWorkOverlay } from './documentFieldFillConfirmPersistService';
import {
  buildDocumentWorkResultSourceFingerprint,
  buildDocumentWorkTruthAssistContextLines,
  getDocumentWorkResult,
  listDocumentWorkTruthAssistFacts,
  mergeDocumentWorkResultOnReanalysis,
  projectDocumentWorkResultFromWorkflow,
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
    id: 'inbox-display-01',
    sender: '',
    deadline: null,
    title: 'Display-01 Archiv',
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
  const imported = importInboxDocumentForTests(item, 'Test GmbH');
  expect(imported.success).toBe(true);
  if (!imported.success) throw new Error('import failed');
  markInboxImportedToArchive(item.id, imported.document.id);
  return {
    ...imported.document,
    ...overrides,
    sourceInboxItemId: overrides.sourceInboxItemId ?? imported.document.sourceInboxItemId,
  };
}

function legacyDoc(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-legacy-display',
    title: 'Legacy',
    category: 'rechnung',
    issuer: 'OCR Only',
    recognizedText: 'Nur OCR',
    issueDate: null,
    validUntil: null,
    digitalFolder: { id: 'd', name: 'F', path: '/F/' },
    paperFolder: { folderId: 'f', register: 'A', label: 'L' },
    tags: [],
    linkedCompany: 'Test GmbH',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {  hydrateDocumentStore([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetTestStores();
});

describe('DOCUMENT-ARCHIVE-TRUTH-DISPLAY-01', () => {
  it('1 — bestätigte Fakten: strukturiert provenance = confirmed', () => {
    const item = itemWithText('Absender: Amt X');
    const dwr = seedDwrForItem(item);
    upsertDocumentWorkResult(
      upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.parties.counterparty',
        status: 'user_confirmed',
        value: 'Bestätigter Partner',
        updatedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const view = buildDocumentArchiveTruthDisplayView(doc);
    expect(view).not.toBeNull();
    const fact = view!.facts.find((f) => /Bestätigter Partner/.test(f.labelValue));
    expect(fact?.provenance).toBe('confirmed');
    expect(fact?.labelValue).not.toMatch(/\[Nutzerbestätigung\]|\[Nutzerkorrektur\]/);
  });

  it('2 — korrigierte Fakten: strukturiert provenance = corrected', () => {
    const item = itemWithText('Betrag: 1.200,00 EUR');
    seedDwrForItem(item);
    expect(
      persistFillConfirmRowsToDocumentWorkOverlay({
        inboxItemId: item.id,
        rows: confirmRow(
          buildDocumentFieldFillConfirmViewModel(item).rows,
          'Betrag',
          '1.250,00 EUR',
        ),
      }).success,
    ).toBe(true);
    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const view = buildDocumentArchiveTruthDisplayView(doc);
    expect(view).not.toBeNull();
    const fact = view!.facts.find((f) => /1\.250/.test(f.labelValue));
    expect(fact?.provenance).toBe('corrected');
    expect(fact?.labelValue).not.toMatch(/\[Nutzerbestätigung\]|\[Nutzerkorrektur\]/);
  });

  it('3 — Analysewerte: strukturiert provenance = analysis', () => {
    const item = itemWithText('Frist: 15.08.2026\nAbsender: Analyse Amt');
    seedDwrForItem(item);
    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const view = buildDocumentArchiveTruthDisplayView(doc);
    expect(view).not.toBeNull();
    expect(view!.facts.some((f) => f.provenance === 'analysis')).toBe(true);
    expect(view!.facts.every((f) => f.provenance !== 'confirmed' && f.provenance !== 'corrected')).toBe(
      true,
    );
  });

  it('Provenienz kommt strukturiert aus TruthView, nicht aus Prompt-Markern', () => {
    const item = itemWithText('Absender: Markerfrei');
    const dwr = seedDwrForItem(item);
    upsertDocumentWorkResult(
      upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.parties.counterparty',
        status: 'user_confirmed',
        value: 'Struktur Partner',
        updatedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const truth = resolveDocumentWorkTruthViewForCompanyDocument({ document: doc }).truthView;
    expect(truth).not.toBeNull();
    const structured = listDocumentWorkTruthAssistFacts(truth!);
    const counterparty = structured.find((f) => f.label === 'Gegenpartei');
    expect(counterparty?.provenance).toBe('user_confirmed');

    const view = buildDocumentArchiveTruthDisplayView(doc);
    expect(view!.facts.find((f) => /Struktur Partner/.test(f.labelValue))?.provenance).toBe(
      'confirmed',
    );

    // Assist prompt lines may still contain markers; display must not depend on them.
    const assist = buildDocumentWorkTruthAssistContextLines(truth!);
    expect(assist.factLines.some((line) => line.includes('[Nutzerbestätigung]'))).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/\[Nutzerbestätigung\]|\[Nutzerkorrektur\]/);

    const displaySource = readFileSync(
      join(__dirname, 'documentArchiveTruthDisplayService.ts'),
      'utf8',
    );
    expect(displaySource).not.toMatch(/Nutzerbestätigung|Nutzerkorrektur|parseAssistFactLine/);
  });

  it('4 — Konflikte sichtbar', () => {
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
    upsertDocumentWorkResult({
      ...merged,
      sourceFingerprint: buildDocumentWorkResultSourceFingerprint(getInboxItemById(item.id)!),
      schemaVersion: DOCUMENT_WORK_RESULT_SCHEMA_VERSION,
      analysisVersion: DOCUMENT_WORK_RESULT_ANALYSIS_VERSION,
    });
    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const view = buildDocumentArchiveTruthDisplayView(doc);
    expect(view).not.toBeNull();
    expect(view!.conflictLines.length).toBeGreaterThan(0);
    expect(view!.conflictLines.join('\n')).toMatch(/Erneut prüfen/);
  });

  it('5 — Discarded erscheint nicht als Fakt', () => {
    const item = itemWithText('Absender: Weg damit');
    const dwr = seedDwrForItem(item);
    upsertDocumentWorkResult(
      upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.parties.counterparty',
        status: 'discarded',
        value: null,
        updatedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    const doc = archiveDocFor(getInboxItemById(item.id)!, { issuer: 'Weg damit' });
    const view = buildDocumentArchiveTruthDisplayView(doc);
    const text = view?.facts.map((f) => f.labelValue).join('\n') ?? '';
    expect(text).not.toMatch(/Weg damit/);
  });

  it('6 — fehlende TruthView blendet Abschnitt vollständig aus', () => {
    const doc = legacyDoc();
    expect(buildDocumentArchiveTruthDisplayView(doc)).toBeNull();
  });

  it('7 — stale DWR blendet Abschnitt aus', () => {
    const item = itemWithText('Betrag: 100 EUR');
    const dwr = seedDwrForItem(item);
    upsertDocumentWorkResult({
      ...dwr,
      sourceFingerprint: `${dwr.sourceFingerprint}-stale`,
    });
    const doc = archiveDocFor(getInboxItemById(item.id)!);
    expect(buildDocumentArchiveTruthDisplayView(doc)).toBeNull();
  });

  it('8 — Workspace-Mismatch blendet Abschnitt aus', () => {
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
    expect(buildDocumentArchiveTruthDisplayView(doc)).toBeNull();
  });

  it('9 — origin_conflict blockiert Anzeige nicht', () => {
    const item = itemWithText('Absender: Origin Konflikt');
    seedDwrForItem(item);
    const doc = archiveDocFor(getInboxItemById(item.id)!);
    hydrateInboxStore([
      {
        ...getInboxItemById(item.id)!,
        archiveDocumentId: 'doc-other-wrong',
      },
    ]);
    const view = buildDocumentArchiveTruthDisplayView(doc);
    expect(view).not.toBeNull();
    expect(JSON.stringify(view)).not.toMatch(/origin_conflict|workspaceId|sourceFingerprint/);
  });

  it('10–11 — Read-only: kein persistAll, keine Store-Mutation; Komponente ohne Truth = null', async () => {
    const item = itemWithText('Absender: Readonly');
    seedDwrForItem(item);
    const doc = archiveDocFor(getInboxItemById(item.id)!);
    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const dwrBefore = JSON.stringify(
      documentWorkResultStoreService.getDocumentWorkResultStoreSnapshot(),
    );
    const inboxBefore = JSON.stringify(getInboxItemById(item.id));

    buildDocumentArchiveTruthDisplayView(doc);

    expect(persistSpy).not.toHaveBeenCalled();
    expect(
      JSON.stringify(documentWorkResultStoreService.getDocumentWorkResultStoreSnapshot()),
    ).toBe(dwrBefore);
    expect(JSON.stringify(getInboxItemById(item.id))).toBe(inboxBefore);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          AppProvider,
          { initialSetup: DEFAULT_SETUP },
          createElement(DocumentArchiveTruthFactsCard, { document: legacyDoc() }),
        ),
      );
    });
    expect(container.querySelector('[data-testid="document-archive-truth-facts"]')).toBeNull();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it('Komponente rendert bestätigte Fakten bei verfügbarer TruthView', async () => {
    const item = itemWithText('Absender: Sichtbar');
    const dwr = seedDwrForItem(item);
    upsertDocumentWorkResult(
      upsertDocumentWorkResultOverlayEntry(dwr, {
        slotId: 'facts.parties.counterparty',
        status: 'user_confirmed',
        value: 'Partner Sichtbar',
        updatedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    const doc = archiveDocFor(getInboxItemById(item.id)!);

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          AppProvider,
          { initialSetup: DEFAULT_SETUP },
          createElement(DocumentArchiveTruthFactsCard, { document: doc }),
        ),
      );
    });
    const card = container.querySelector('[data-testid="document-archive-truth-facts"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toMatch(/Dokumentangaben/);
    expect(card?.textContent).toMatch(/Bestätigte und korrigierte Angaben werden vorrangig berücksichtigt/);
    expect(card?.textContent).toMatch(/Partner Sichtbar/);
    expect(card?.textContent).toMatch(/Bestätigt/);
    expect(card?.textContent).not.toMatch(/Geprüfte Angaben|Vorrang vor OCR/);
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
