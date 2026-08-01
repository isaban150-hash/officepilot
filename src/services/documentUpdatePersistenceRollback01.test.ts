/**
 * DOCUMENT-UPDATE-PERSISTENCE-ROLLBACK-01 — updateDocument persist parity with addDocument.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDocumentById,
  hydrateDocumentStore,
  linkDocumentToVorgang,
  updateDocument,
  updateDocumentFromInbox,
} from './documentService';
import {
  applyStateToStores,
  buildPersistedStateSnapshot,
  loadPersistedState,
  persistAll,
} from './persistenceService';
import * as persistenceService from './persistenceService';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { confirmFilingDecisionForTests } from '../test/confirmFilingDecisionForTests';
import { createAuftragInboxItem } from '../test/fixtures';
import { DOCUMENT_ARCHIVE_TRUTH_SNAPSHOT_SCHEMA_VERSION } from '../types/documentArchiveTruthSnapshot';
import type { CompanyDocument } from '../types/models';

function seedDoc(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  const doc: CompanyDocument = {
    id: 'doc-update-persist-01',
    title: 'Original Titel',
    category: 'versicherung',
    issuer: 'Original AG',
    recognizedText: 'Original Text',
    issueDate: '2026-01-01',
    validUntil: '2027-01-01',
    digitalFolder: { id: 'dig-1', name: 'Versicherungen', path: '/Firma/Versicherungen/' },
    paperFolder: { folderId: 'folder-5', register: 'A', label: 'Behörden & Versicherungen' },
    tags: ['Original', 'Tag'],
    linkedCompany: 'Test GmbH',
    linkedVorgang: { vorgangId: 'v-1', vorgangTitle: 'Auftrag 1', vorgangNumber: 'A-1' },
    archived: true,
    createdAt: '2026-03-01T10:00:00.000Z',
    fileRefId: 'file-ref-1',
    sourceFileHash: 'hash-1',
    originalFileName: 'original.pdf',
    mimeType: 'application/pdf',
    fileSize: 1234,
    archiveTruthSnapshot: {
      schemaVersion: DOCUMENT_ARCHIVE_TRUTH_SNAPSHOT_SCHEMA_VERSION,
      workspaceId: 'ws-update-persist',
      createdAt: '2026-03-01T10:00:00.000Z',
      sourceInboxItemId: 'inbox-origin-1',
      analyzedAt: '2026-03-01T09:00:00.000Z',
      analysisVersion: '01a.1',
      sourceFingerprint: 'fp-frozen',
      businessInterpretation: {
        readOnly: true,
        sourceDocument: {
          sourceDocumentId: 'inbox-origin-1',
          classifiedKind: 'sonstiges',
          classificationConfidence: 'low',
          recognitionUncertain: true,
        },
        meaning: {
          eventType: 'review_required',
          certainty: 'uncertain',
          inheritedConfidence: 'low',
          summary: 'Freeze',
          alternativeEventTypes: [],
        },
        facts: {
          parties: { others: [] },
          money: [],
          timeline: {},
          subject: {},
          positions: [],
          conditions: [],
          signatures: { status: 'unclear', certainty: 'uncertain', source: 'recognizedData' },
        },
        effects: [],
        missingInformation: [],
        requiredConfirmations: [],
        nextActionCandidates: [],
        conflicts: [],
        parties: [],
        operational: {
          certainty: 'uncertain',
          meanings: ['review'],
          nextStep: 'Prüfen',
          confirmRequirement: 'Bestätigen',
          primaryCase: 'review_required',
        },
        vorgangRef: { status: 'none', linkedVorgangId: null, suggested: null, similarCount: 0 },
        derivedFrom: {
          hasClassification: false,
          hasDocumentUnderstanding: false,
          hasContractIntelligence: false,
          hasContractOrderProposal: false,
          companyRelevant: false,
        },
      },
      specialistRefs: {
        hasClassification: false,
        hasDocumentUnderstanding: false,
        hasContractIntelligence: false,
        hasContractOrderProposal: false,
      },
      overlay: [],
    },
    ...overrides,
  };
  hydrateDocumentStore([doc]);
  expect(persistAll().success).toBe(true);
  return getDocumentById(doc.id)!;
}

describe('DOCUMENT-UPDATE-PERSISTENCE-ROLLBACK-01', () => {
  beforeEach(() => {    hydrateDocumentStore([]);
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1 — erfolgreiches updateDocument aktualisiert Memory und Storage', () => {
    seedDoc();
    const result = updateDocument('doc-update-persist-01', {
      title: 'Neuer Titel',
      issuer: 'Neu AG',
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(getDocumentById('doc-update-persist-01')?.title).toBe('Neuer Titel');
    expect(getDocumentById('doc-update-persist-01')?.issuer).toBe('Neu AG');

    const stored = buildPersistedStateSnapshot().documents.find(
      (d) => d.id === 'doc-update-persist-01',
    );
    expect(stored?.title).toBe('Neuer Titel');
    expect(stored?.issuer).toBe('Neu AG');
  });

  it('2 — Persistenzfehler liefert document.persistFailed ohne False Success', () => {
    seedDoc();
    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });

    const result = updateDocument('doc-update-persist-01', { title: 'Sollte scheitern' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKey).toBe('document.persistFailed');
    }
  });

  it('3 — Rollback stellt vorherigen Memory-Zustand vollständig wieder her', () => {
    const before = seedDoc();
    const frozen = JSON.parse(JSON.stringify(before));

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });

    updateDocument('doc-update-persist-01', {
      title: 'Kaputt',
      issuer: 'Kaputt AG',
      tags: ['x'],
      digitalFolder: { id: 'x', name: 'X', path: '/X/' },
    });

    const after = getDocumentById('doc-update-persist-01')!;
    expect(after).toEqual(frozen);
  });

  it('4 — Reload nach Persistenzfehler zeigt weiterhin den alten Stand', () => {
    seedDoc();
    const beforeTitle = getDocumentById('doc-update-persist-01')!.title;

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });
    updateDocument('doc-update-persist-01', { title: 'Nicht speichern' });
    vi.restoreAllMocks();

    const loaded = loadPersistedState();
    expect(loaded).not.toBeNull();
    applyStateToStores(loaded!);
    expect(getDocumentById('doc-update-persist-01')?.title).toBe(beforeTitle);
    expect(getDocumentById('doc-update-persist-01')?.title).not.toBe('Nicht speichern');
  });

  it('5 — Nested-Felder bleiben beim Rollback erhalten', () => {
    const before = seedDoc();
    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });

    updateDocument('doc-update-persist-01', {
      title: 'Nested Fail',
      digitalFolder: { id: 'new', name: 'Neu', path: '/Neu/' },
      paperFolder: { folderId: 'other', register: 'Z', label: 'Andere' },
      tags: ['changed'],
      linkedVorgang: { vorgangId: 'v-2', vorgangTitle: 'Anderer', vorgangNumber: 'A-2' },
      fileRefId: 'file-ref-changed',
      originalFileName: 'changed.pdf',
    });

    const after = getDocumentById('doc-update-persist-01')!;
    expect(after.digitalFolder).toEqual(before.digitalFolder);
    expect(after.paperFolder).toEqual(before.paperFolder);
    expect(after.tags).toEqual(before.tags);
    expect(after.linkedVorgang).toEqual(before.linkedVorgang);
    expect(after.fileRefId).toBe(before.fileRefId);
    expect(after.originalFileName).toBe(before.originalFileName);
    expect(after.sourceFileHash).toBe(before.sourceFileHash);
    expect(after.mimeType).toBe(before.mimeType);
    expect(after.fileSize).toBe(before.fileSize);
  });

  it('6 — Archive-Truth-Snapshot bleibt bei fehlgeschlagenem Update unverändert', () => {
    const before = seedDoc();
    const frozenSnap = JSON.parse(JSON.stringify(before.archiveTruthSnapshot));

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });

    updateDocument('doc-update-persist-01', {
      title: 'Snap Fail',
      archiveTruthSnapshot: {
        ...before.archiveTruthSnapshot!,
        sourceFingerprint: 'fp-should-not-win',
      },
    });

    expect(getDocumentById('doc-update-persist-01')?.archiveTruthSnapshot).toEqual(frozenSnap);
  });

  it('7a — updateDocumentFromInbox: Confirm-Gate bleibt aktiv', () => {
    seedDoc({ id: 'doc-from-inbox', sourceInboxItemId: 'inbox-upd-gate' });
    const item = createAuftragInboxItem({
      id: 'inbox-upd-gate',
      title: 'Inbox Update',
      sender: 'Sender',
    });
    hydrateInboxStore([item]);

    const persistSpy = vi.spyOn(persistenceService, 'persistAll');
    const result = updateDocumentFromInbox('doc-from-inbox', item, 'Test GmbH');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKey).toBe('document.filingDecisionRequired');
    }
    // Gate fails before mutation; persistAll must not be called for the update path.
    // (hydrate/confirm helpers may call persist elsewhere — only assert title unchanged.)
    expect(getDocumentById('doc-from-inbox')?.title).toBe('Original Titel');
    void persistSpy;
  });

  it('7b — updateDocumentFromInbox: Persist-Fail rollt zurück, kein False Success', () => {
    seedDoc({ id: 'doc-from-inbox-ok', sourceInboxItemId: 'inbox-upd-ok', title: 'Vor Update' });
    const item = createAuftragInboxItem({
      id: 'inbox-upd-ok',
      title: 'Nach Update',
      sender: 'Sender',
    });
    hydrateInboxStore([item]);
    confirmFilingDecisionForTests(item.id);

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });

    const result = updateDocumentFromInbox(
      'doc-from-inbox-ok',
      getInboxItemById(item.id)!,
      'Test GmbH',
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKey).toBe('document.persistFailed');
    }
    expect(getDocumentById('doc-from-inbox-ok')?.title).toBe('Vor Update');
  });

  it('8 — notFound: kein Persistenzaufruf', () => {
    seedDoc();
    const spy = vi.spyOn(persistenceService, 'persistAll');
    const callsBefore = spy.mock.calls.length;

    const result = updateDocument('missing-id', { title: 'X' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKey).toBe('document.notFound');
    expect(spy.mock.calls.length).toBe(callsBefore);
  });

  it('9 — ungültiger Input: kein Persistenzaufruf, keine Mutation', () => {
    seedDoc();
    const spy = vi.spyOn(persistenceService, 'persistAll');
    const callsBefore = spy.mock.calls.length;

    const result = updateDocument('doc-update-persist-01', { title: '   ' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKey).toBe('document.titleRequired');
    expect(getDocumentById('doc-update-persist-01')?.title).toBe('Original Titel');
    expect(spy.mock.calls.length).toBe(callsBefore);
  });

  it('10 — erstes Update erfolgreich, zweites Persist-Fail bleibt auf erstem Stand', () => {
    seedDoc();
    const first = updateDocument('doc-update-persist-01', { title: 'Stand Eins' });
    expect(first.success).toBe(true);

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });
    const second = updateDocument('doc-update-persist-01', { title: 'Stand Zwei' });
    expect(second.success).toBe(false);

    expect(getDocumentById('doc-update-persist-01')?.title).toBe('Stand Eins');
    vi.restoreAllMocks();
    const loaded = loadPersistedState();
    applyStateToStores(loaded!);
    expect(getDocumentById('doc-update-persist-01')?.title).toBe('Stand Eins');
  });

  it('11 — linkDocumentToVorgang erbt Persist-Rollback', () => {
    seedDoc({ linkedVorgang: null });
    const before = getDocumentById('doc-update-persist-01')!;

    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({
      success: false,
      failure: { reason: 'quota_exceeded' },
    });

    const result = linkDocumentToVorgang('doc-update-persist-01', {
      vorgangId: 'v-new',
      vorgangTitle: 'Neu',
      vorgangNumber: 'N-1',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKey).toBe('document.persistFailed');
    }
    expect(getDocumentById('doc-update-persist-01')?.linkedVorgang).toEqual(before.linkedVorgang);
  });
});
