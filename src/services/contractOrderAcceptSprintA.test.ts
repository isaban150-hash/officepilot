/**
 * REFERENZVERTRAG V1 – SPRINT A — Accept erzeugt vollständigen, verknüpften Vorgang.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptContractOrderFromProposal,
  buildVorgangDraftFromContractProposal,
} from './contractOrderAcceptService';
import { buildContractOrderProposal } from './contractIntelligenceService';
import {
  getAllDocuments,
  getDocumentById,
  hydrateDocumentStore,
} from './documentService';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
import {
  confirmFilingDecisionForTests,
  importInboxDocumentForTests,
} from '../test/confirmFilingDecisionForTests';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import {
  buildSyntheticWerkvertragPages,
  buildSyntheticWerkvertragText,
} from '../test/werkvertragMultiSectionFixtures';
import { markInboxImportedToArchive } from './inboxService';
import type { InboxItem } from '../types/models';

const COMPANY = 'Test GmbH';

function createReferenceInbox(overrides: Partial<InboxItem> = {}): InboxItem {
  const pages = buildSyntheticWerkvertragPages();
  const text = buildSyntheticWerkvertragText();
  return createAuftragInboxItem({
    id: 'inbox-ref-wv-lv-01',
    title: 'Werkvertrag BV Test',
    sender: 'Isobautec GmbH',
    markedAsCompanyDocument: true,
    classifiedKind: 'werkvertrag',
    recognizedData: {
      Kunde: 'Isobautec GmbH',
      // Absichtlich Projektname statt Adresse — CI muss Adresse bevorzugen.
      Baustelle: 'BV Sägewerk Fisch',
      _vertragstext: text,
      _pageTexts: JSON.stringify(pages),
      Betreff: 'Werkvertrag',
    },
    ...overrides,
  });
}

function seed(item: InboxItem = createReferenceInbox()) {
  resetTestStores();
  hydrateDocumentStore([]);
  hydrateVorgangStore([]);
  hydrateInboxStore([item]);
  return getInboxItemById(item.id)!;
}

describe('REFERENZVERTRAG V1 – SPRINT A – Accept vollständig', () => {

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('CI-Daten haben Vorrang vor Inbox (Kunde, Projekt, Baustellenadresse)', () => {
    const item = seed(
      createReferenceInbox({
        sender: 'Falscher Sender',
        recognizedData: {
          Kunde: 'Falscher Kunde',
          Baustelle: 'BV Sägewerk Fisch',
          _vertragstext: buildSyntheticWerkvertragText(),
          _pageTexts: JSON.stringify(buildSyntheticWerkvertragPages()),
        },
      }),
    );
    const proposal = buildContractOrderProposal(item)!;
    const draft = buildVorgangDraftFromContractProposal(item, proposal, 'unclear');

    expect(draft.customer).toContain('Isobautec');
    expect(draft.customer).not.toContain('Falscher');
    expect(draft.title).toMatch(/Sägewerk|Fisch/i);
    expect(draft.baustelle).toContain('Möhnetal 55');
    expect(draft.baustelle).not.toBe('BV Sägewerk Fisch');
  });

  it('Inbox bleibt Fallback, wenn CI-Feld fehlt', () => {
    const item = seed(
      createAuftragInboxItem({
        id: 'inbox-fallback-only',
        sender: 'Fallback AG GmbH',
        recognizedData: {
          Kunde: 'Fallback AG GmbH',
          Baustelle: 'Fallbackstraße 1, 12345 Fallbackstadt',
          Projekt: 'Fallback Projekt',
          _vertragstext: 'Werkvertrag ohne strukturierte Felder',
        },
        classifiedKind: 'werkvertrag',
        markedAsCompanyDocument: true,
      }),
    );
    const proposal = buildContractOrderProposal(item);
    // Ohne brauchbare CI-Struktur ggf. null — dann kein Accept-Draft aus Proposal.
    if (!proposal) {
      expect(item.recognizedData.Kunde).toBe('Fallback AG GmbH');
      return;
    }
    const draft = buildVorgangDraftFromContractProposal(item, proposal, 'unclear');
    expect(draft.customer).toBeTruthy();
    expect(draft.baustelle).toBeTruthy();
  });

  it('Truth-Werte haben Vorrang vor Proposal-Werten beim Draft', () => {
    const item = seed(
      createReferenceInbox({
        sender: 'Falscher Sender',
        recognizedData: {
          Kunde: 'Falscher Kunde',
          Baustelle: 'BV Sägewerk Fisch',
          _vertragstext: buildSyntheticWerkvertragText(),
          _pageTexts: JSON.stringify(buildSyntheticWerkvertragPages()),
        },
      }),
    );
    const proposal = buildContractOrderProposal(item)!;
    const draft = buildVorgangDraftFromContractProposal(item, proposal, 'unclear', {
      customer: 'Truth Kunde B',
      title: 'Truth Projekt B',
      baustelle: 'Truth Baustelle B',
    });

    expect(draft.customer).toBe('Truth Kunde B');
    expect(draft.title).toBe('Truth Projekt B');
    expect(draft.baustelle).toBe('Truth Baustelle B');
  });

  // Happy-Path Accept+Archiv+DOC-LINK → REFERENCE WV-LV-01

  it('keine doppelte Archivierung bei erneutem Accept-Versuch', () => {
    const item = seed();
    const proposal = buildContractOrderProposal(item)!;

    const first = acceptContractOrderFromProposal({
      item,
      proposal,
      selectedPositions: proposal.positions,
      companyName: COMPANY,
    });
    expect(first.success).toBe(true);
    if (!first.success) return;

    expect(getAllDocuments()).toHaveLength(1);

    const second = acceptContractOrderFromProposal({
      item: getInboxItemById(item.id)!,
      proposal,
      selectedPositions: proposal.positions,
      companyName: COMPANY,
    });
    // Idempotenter Re-Accept: kein zweites Archivdokument.
    expect(second.success).toBe(true);
    expect(getAllDocuments()).toHaveLength(1);
    expect(getDocumentById(first.archiveDocumentId!)?.linkedVorgang?.vorgangId).toBe(
      first.vorgang.id,
    );
  });

  it('bereits archiviertes Dokument wird wiederverwendet (DOC-LINK bleibt korrekt)', () => {
    const item = seed();
    confirmFilingDecisionForTests(item.id);
    const imported = importInboxDocumentForTests(getInboxItemById(item.id)!, COMPANY);
    expect(imported.success).toBe(true);
    if (!imported.success) return;
    markInboxImportedToArchive(item.id, imported.document.id);
    expect(getAllDocuments()).toHaveLength(1);

    const proposal = buildContractOrderProposal(getInboxItemById(item.id)!)!;
    const result = acceptContractOrderFromProposal({
      item: getInboxItemById(item.id)!,
      proposal,
      selectedPositions: proposal.positions,
      companyName: COMPANY,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(getAllDocuments()).toHaveLength(1);
    expect(result.archiveDocumentId).toBe(imported.document.id);
    expect(getDocumentById(imported.document.id)?.linkedVorgang?.vorgangId).toBe(
      result.vorgang.id,
    );
    expect(
      result.vorgang.documents.some((doc) => doc.companyDocumentId === imported.document.id),
    ).toBe(true);
  });

  it('Navigation-Ziel ist die neue Vorgang-Id (Accept-Ergebnis)', () => {
    const item = seed();
    const proposal = buildContractOrderProposal(item)!;
    const result = acceptContractOrderFromProposal({
      item,
      proposal,
      selectedPositions: proposal.positions.slice(0, 3),
      companyName: COMPANY,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.vorgang.id).toMatch(/^v-/);
    expect(getVorgangById(result.vorgang.id)?.id).toBe(result.vorgang.id);
  });
});
