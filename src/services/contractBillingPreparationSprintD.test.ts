/**
 * REFERENZVERTRAG V1 – SPRINT D — Abschläge & Schlussrechnung vorbereiten.
 * Happy-Path UI → REFERENCE WV-LV-01; hier CI/Fallback + Idempotenz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildBillingPreparationPatch,
  buildBillingPreparationViewFromSources,
  buildVorgangBillingPreparationView,
} from './contractBillingPreparationService';
import { buildContractOrderProposal } from './contractIntelligenceService';
import { acceptContractOrderFromProposal } from './contractOrderAcceptService';
import { hydrateDocumentStore } from './documentService';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { hydrateMemory, resetMemory } from './officePilotMemoryService';
import {
  buildSyntheticWerkvertragPages,
  buildSyntheticWerkvertragText,
} from '../test/werkvertragMultiSectionFixtures';
import type { InboxItem } from '../types/models';

const COMPANY = 'Test GmbH';

function createReferenceInbox(overrides: Partial<InboxItem> = {}): InboxItem {
  return createAuftragInboxItem({
    id: 'inbox-ref-wv-lv-01-sprint-d',
    title: 'Werkvertrag BV Test',
    sender: 'Isobautec GmbH',
    markedAsCompanyDocument: true,
    classifiedKind: 'werkvertrag',
    recognizedData: {
      Kunde: 'Isobautec GmbH',
      Baustelle: 'BV Sägewerk Fisch',
      _vertragstext: buildSyntheticWerkvertragText(),
      _pageTexts: JSON.stringify(buildSyntheticWerkvertragPages()),
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

describe('REFERENZVERTRAG V1 – SPRINT D – Abrechnung vorbereiten', () => {

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('CI liefert Zahlungsziel, Skonto, Abschlag und Schlussrechnung', () => {
    const item = seed();
    const proposal = buildContractOrderProposal(item)!;
    const patch = buildBillingPreparationPatch({
      intelligence: proposal.intelligence,
      proposal,
      item,
    });

    expect(patch.Zahlungsziel).toMatch(/30\s*Tage/i);
    expect(patch.Skonto).toMatch(/2\s*%|Skonto/i);
    expect(patch.AbschlaegeMoeglich).toBe('ja');
    expect(patch.Abschlagsregel).toMatch(/Abschlag|wöchentlich/i);
    expect(patch.SchlussrechnungVorgesehen).toBe('ja');
    expect(patch.Zahlungsbedingungen).toBeTruthy();
  });

  it('Inbox bleibt Fallback, wenn CI keine Payment-Terms hat', () => {
    const view = buildBillingPreparationViewFromSources({
      recognizedData: {
        Zahlungsziel: '21 Tage netto',
        Skonto: '3 % bei 10 Tagen',
        AbschlaegeMoeglich: 'nein',
        SchlussrechnungVorgesehen: 'ja',
      },
      intelligence: null,
    });

    expect(view.paymentDue).toBe('21 Tage netto');
    expect(view.skonto).toBe('3 % bei 10 Tagen');
    expect(view.progressBillingAllowed).toBe(false);
    expect(view.finalInvoicePlanned).toBe(true);
  });

  it('Accept übernimmt Billing-Daten; Re-Accept bleibt idempotent', () => {
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

    const inboxAfter = getInboxItemById(item.id)!;
    expect(inboxAfter.recognizedData.AbschlaegeMoeglich).toBe('ja');
    expect(inboxAfter.recognizedData.SchlussrechnungVorgesehen).toBe('ja');
    expect(inboxAfter.recognizedData.Zahlungsziel).toMatch(/30/i);
    expect(inboxAfter.recognizedData.Skonto).toMatch(/Skonto|2/i);

    const view = buildVorgangBillingPreparationView(getVorgangById(first.vorgang.id)!)!;
    expect(view.progressBillingAllowed).toBe(true);
    expect(view.finalInvoicePlanned).toBe(true);
    expect(view.paymentDue).toMatch(/30/i);
    expect(view.skonto).toMatch(/Skonto|2/i);

    const snapshot = { ...getInboxItemById(item.id)!.recognizedData };
    const second = acceptContractOrderFromProposal({
      item: getInboxItemById(item.id)!,
      proposal,
      selectedPositions: proposal.positions,
      companyName: COMPANY,
    });
    expect(second.success).toBe(true);
    if (!second.success) return;

    const again = getInboxItemById(item.id)!.recognizedData;
    expect(again.AbschlaegeMoeglich).toBe(snapshot.AbschlaegeMoeglich);
    expect(again.SchlussrechnungVorgesehen).toBe(snapshot.SchlussrechnungVorgesehen);
    expect(again.Zahlungsziel).toBe(snapshot.Zahlungsziel);
    expect(again.Skonto).toBe(snapshot.Skonto);
  });

  // Happy-Path Abrechnung-UI → REFERENCE WV-LV-01
});
