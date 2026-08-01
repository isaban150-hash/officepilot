/**
 * REFERENZVERTRAG V1 – SPRINT B — Nachweise nach Accept am Vorgang.
 * Happy-Path UI → REFERENCE WV-LV-01; hier Fallback + Idempotenz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptContractOrderFromProposal } from './contractOrderAcceptService';
import { buildContractOrderProposal } from './contractIntelligenceService';
import {
  buildRequiredDocumentsFromContractIntelligence,
} from './contractProofRequirementsFromIntelligence';
import { analyzeContractFromInbox } from './contractAnalysisService';
import {
  getMemoryRelations,
  getProofsForVorgang,
  hydrateMemory,
  resetMemory,
} from './officePilotMemoryService';
import { buildVorgangProofRequirementRows } from './vorgangProofRequirementsView';
import { hydrateDocumentStore } from './documentService';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { hydrateVorgangStore } from './vorgangService';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import {
  buildSyntheticWerkvertragPages,
  buildSyntheticWerkvertragText,
} from '../test/werkvertragMultiSectionFixtures';
import type { InboxItem } from '../types/models';

const COMPANY = 'Test GmbH';

function createReferenceInbox(overrides: Partial<InboxItem> = {}): InboxItem {
  const pages = buildSyntheticWerkvertragPages();
  const text = buildSyntheticWerkvertragText();
  return createAuftragInboxItem({
    id: 'inbox-ref-wv-lv-01-sprint-b',
    title: 'Werkvertrag BV Test',
    sender: 'Isobautec GmbH',
    markedAsCompanyDocument: true,
    classifiedKind: 'werkvertrag',
    recognizedData: {
      Kunde: 'Isobautec GmbH',
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
  resetMemory();
  hydrateMemory({
    documentMemories: [],
    proofMemories: [],
    relations: [],
    paperRegisterEntries: [],
  });
  hydrateDocumentStore([]);
  hydrateVorgangStore([]);
  hydrateInboxStore([item]);
  return getInboxItemById(item.id)!;
}

describe('REFERENZVERTRAG V1 – SPRINT B – Nachweise', () => {

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('CI liefert BG BAU und SOKA-BAU; Freistellung kommt aus Fallback', () => {
    const item = seed();
    const proposal = buildContractOrderProposal(item)!;
    const fallback = analyzeContractFromInbox(item);
    const resolved = buildRequiredDocumentsFromContractIntelligence(
      proposal.intelligence,
      fallback.requiredDocuments,
    );

    const byType = Object.fromEntries(resolved.map((entry) => [entry.proofType, entry.source]));
    expect(byType.bg_bau).toBe('ci');
    expect(byType.soka_bau).toBe('ci');
    expect(byType.freistellungsbescheinigung).toBe('fallback');
  });

  it('Inbox/Fallback bleibt, wenn CI-Feld fehlt', () => {
    const resolved = buildRequiredDocumentsFromContractIntelligence(null, [
      {
        type: 'freistellungsbescheinigung',
        priority: 'hoch',
        reason: 'Im Vertrag als Nachweis genannt',
      },
      {
        type: 'bg_bau',
        priority: 'hoch',
        reason: 'BG-BAU-Nachweis im Vertrag gefordert',
      },
    ]);
    expect(resolved).toHaveLength(2);
    expect(resolved.every((entry) => entry.source === 'fallback')).toBe(true);
  });

  it('Accept übernimmt Nachweise ohne Duplikate; Re-Accept aktualisiert idempotent', () => {
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

    const proofs = getProofsForVorgang(first.vorgang.id);
    const relations = getMemoryRelations().filter(
      (relation) => relation.fromType === 'vorgang' && relation.fromId === first.vorgang.id,
    );
    const types = new Set(relations.map((relation) => relation.toProofType));

    expect(types.has('bg_bau')).toBe(true);
    expect(types.has('soka_bau')).toBe(true);
    expect(types.has('freistellungsbescheinigung')).toBe(true);
    expect(relations).toHaveLength(types.size);
    expect(proofs.length).toBeGreaterThanOrEqual(3);

    const second = acceptContractOrderFromProposal({
      item: getInboxItemById(item.id)!,
      proposal,
      selectedPositions: proposal.positions,
      companyName: COMPANY,
    });
    expect(second.success).toBe(true);
    if (!second.success) return;

    const relationsAgain = getMemoryRelations().filter(
      (relation) => relation.fromType === 'vorgang' && relation.fromId === first.vorgang.id,
    );
    expect(relationsAgain).toHaveLength(relations.length);
    expect(
      relationsAgain.filter((relation) => relation.toProofType === 'bg_bau'),
    ).toHaveLength(1);
  });

  it('bestehende erfüllte Nachweise werden nicht auf missing zurückgesetzt', () => {
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

    hydrateMemory({
      documentMemories: [],
      proofMemories: [
        {
          id: 'proof-doc-bg_bau',
          proofType: 'bg_bau',
          status: 'valid',
          documentId: 'doc-bg',
          requiredByVorgangIds: [first.vorgang.id],
          lastCheckedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      relations: getMemoryRelations(),
      paperRegisterEntries: [],
    });

    const second = acceptContractOrderFromProposal({
      item: getInboxItemById(item.id)!,
      proposal,
      selectedPositions: proposal.positions,
      companyName: COMPANY,
    });
    expect(second.success).toBe(true);
    if (!second.success) return;

    const rows = buildVorgangProofRequirementRows(first.vorgang.id);
    expect(rows.find((row) => row.proofType === 'bg_bau')?.status).toBe('vorhanden');
  });
});
