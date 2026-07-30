/**
 * SERVICE-FILING-CONFIRM-GATE-01 — Confirm-first at Inbox→Archiv service boundary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DOCUMENT_FILING_DECISION_REQUIRED_ERROR_KEY,
  resolveConfirmedFilingDecisionForInboxArchive,
} from './documentFilingDecisionService';
import {
  addDocument,
  getAllDocuments,
  getDocumentById,
  hydrateDocumentStore,
  importInboxDocument,
  updateDocumentFromInbox,
} from './documentService';
import { archiveMailInboxItem } from './mailImportService';
import {
  getInboxItemById,
  hydrateInboxStore,
  markInboxImportedToArchive,
} from './inboxService';
import { confirmFilingDecisionForTests } from '../test/confirmFilingDecisionForTests';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import type { InboxItem } from '../types/models';

function seedInbox(overrides: Partial<InboxItem> = {}): InboxItem {
  const item = createAuftragInboxItem({
    id: 'inbox-filing-gate-01',
    title: 'Filing Gate Doc',
    sender: 'Gate AG',
    ...overrides,
  });
  hydrateInboxStore([item]);
  return getInboxItemById(item.id)!;
}

describe('SERVICE-FILING-CONFIRM-GATE-01', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateDocumentStore([]);
  });

  afterEach(() => {
    resetTestStores();
  });

  it('1 — importInboxDocument ohne Confirm schlägt fehl und erzeugt kein Dokument', () => {
    const item = seedInbox();
    const before = getAllDocuments().length;
    const result = importInboxDocument(item, 'Test GmbH');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKey).toBe(DOCUMENT_FILING_DECISION_REQUIRED_ERROR_KEY);
    }
    expect(getAllDocuments()).toHaveLength(before);
  });

  it('2 — importInboxDocument mit Confirm funktioniert', () => {
    const item = seedInbox();
    const confirmed = confirmFilingDecisionForTests(item.id);
    const result = importInboxDocument(confirmed, 'Test GmbH');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.document.title).toBe('Filing Gate Doc');
      expect(getDocumentById(result.document.id)).toBeDefined();
    }
  });

  it('3 — updateDocumentFromInbox ohne Confirm schlägt fehl', () => {
    const item = seedInbox({ id: 'inbox-filing-gate-update' });
    const confirmed = confirmFilingDecisionForTests(item.id);
    const created = importInboxDocument(confirmed, 'Test GmbH');
    expect(created.success).toBe(true);
    if (!created.success) return;

    // Clear confirm from store while keeping a lookalike parameter.
    hydrateInboxStore([
      {
        ...getInboxItemById(item.id)!,
        filingDecision: undefined,
      },
    ]);
    const staleParam: InboxItem = {
      ...confirmed,
      filingDecision: confirmed.filingDecision,
    };
    const updated = updateDocumentFromInbox(created.document.id, staleParam, 'Test GmbH');
    expect(updated.success).toBe(false);
    if (!updated.success) {
      expect(updated.errorKey).toBe(DOCUMENT_FILING_DECISION_REQUIRED_ERROR_KEY);
    }
  });

  it('4 — updateDocumentFromInbox mit Confirm funktioniert', () => {
    const item = seedInbox({ id: 'inbox-filing-gate-update-ok', title: 'Alt Titel' });
    const confirmed = confirmFilingDecisionForTests(item.id);
    const created = importInboxDocument(confirmed, 'Test GmbH');
    expect(created.success).toBe(true);
    if (!created.success) return;

    hydrateInboxStore([
      {
        ...getInboxItemById(item.id)!,
        title: 'Neu Titel',
      },
    ]);
    // Re-confirm still true on store
    expect(getInboxItemById(item.id)?.filingDecision?.status).toBe('confirmed');
    const updated = updateDocumentFromInbox(
      created.document.id,
      getInboxItemById(item.id)!,
      'Test GmbH',
    );
    expect(updated.success).toBe(true);
    if (updated.success) {
      expect(updated.document.title).toBe('Neu Titel');
    }
  });

  it('5 — archiveMailInboxItem ohne Confirm schlägt ohne Side-Effects fehl', () => {
    const item = seedInbox({ id: 'inbox-filing-gate-mail' });
    const before = getAllDocuments().length;
    const documentId = archiveMailInboxItem(item, 'Test GmbH');
    expect(documentId).toBeNull();
    expect(getAllDocuments()).toHaveLength(before);
  });

  it('6 — archiveMailInboxItem mit Confirm funktioniert', () => {
    const item = seedInbox({ id: 'inbox-filing-gate-mail-ok' });
    confirmFilingDecisionForTests(item.id);
    const documentId = archiveMailInboxItem(getInboxItemById(item.id)!, 'Test GmbH');
    expect(documentId).toBeTruthy();
    expect(getDocumentById(documentId!)).toBeDefined();
  });

  it('7 — Fake-Confirm nur am Parameter wird abgelehnt wenn Store unconfirmed', () => {
    const item = seedInbox({ id: 'inbox-filing-gate-fake' });
    const fake: InboxItem = {
      ...item,
      filingDecision: {
        status: 'confirmed',
        scope: 'company',
        digitalPath: '/Firma/',
        digitalFolderName: 'Firma',
        confirmedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    expect(getInboxItemById(item.id)?.filingDecision?.status).not.toBe('confirmed');
    const result = importInboxDocument(fake, 'Test GmbH');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKey).toBe(DOCUMENT_FILING_DECISION_REQUIRED_ERROR_KEY);
    }
    expect(getAllDocuments()).toHaveLength(0);
  });

  it('8 — Store-bestätigt: veralteter Parameter ohne Confirm reicht wenn Store confirmed', () => {
    const item = seedInbox({ id: 'inbox-filing-gate-stale-param' });
    confirmFilingDecisionForTests(item.id);
    const staleParam: InboxItem = {
      ...item,
      filingDecision: undefined,
    };
    const result = importInboxDocument(staleParam, 'Test GmbH');
    expect(result.success).toBe(true);
  });

  it('9 — addDocument bleibt ohne Filing-Entscheidung nutzbar', () => {
    const result = addDocument({
      title: 'Manuell ohne Filing',
      category: 'sonstiges',
      linkedCompany: 'Test GmbH',
    });
    expect(result.success).toBe(true);
  });

  it('12 — Mehrfachaufruf ohne Confirm bleibt ohne Side-Effects', () => {
    const item = seedInbox({ id: 'inbox-filing-gate-multi' });
    const first = importInboxDocument(item, 'Test GmbH');
    const second = importInboxDocument(item, 'Test GmbH');
    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    expect(getAllDocuments()).toHaveLength(0);
  });

  it('12b — Mehrfachaufruf mit Confirm: zweiter Import erzeugt weiteres Dokument (bestehende Semantik)', () => {
    const item = seedInbox({ id: 'inbox-filing-gate-multi-ok' });
    confirmFilingDecisionForTests(item.id);
    const first = importInboxDocument(getInboxItemById(item.id)!, 'Test GmbH');
    expect(first.success).toBe(true);
    if (!first.success) return;
    markInboxImportedToArchive(item.id, first.document.id);
    const second = importInboxDocument(getInboxItemById(item.id)!, 'Test GmbH');
    expect(second.success).toBe(true);
    expect(getAllDocuments().length).toBeGreaterThanOrEqual(2);
  });

  it('13 — Guard-Helper lehnt fehlendes InboxItem ab', () => {
    const gate = resolveConfirmedFilingDecisionForInboxArchive('inbox-does-not-exist');
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.errorKey).toBe(DOCUMENT_FILING_DECISION_REQUIRED_ERROR_KEY);
    }
  });
});
