import { describe, expect, it } from 'vitest';
import { createAuftragInboxItem } from './test/fixtures';
import {
  buildSyntheticWerkvertragPages,
  buildSyntheticWerkvertragText,
  SAMPLE_EINGANGSRECHNUNG_TEXT,
  SAMPLE_STUNDENPREIS_CONTRACT_TEXT,
} from './test/werkvertragMultiSectionFixtures';
import {
  analyzeContractIntelligenceFromText,
  buildContractOrderProposal,
  getContractSkontoOfferForVorgang,
} from './services/contractIntelligenceService';
import { detectClassifiedKindWithReason } from './services/documentClassificationService';
import { resolveContractTotalNet } from './services/documentAmountExtractionService';
import { segmentDocumentPages } from './services/documentSegmentationService';
import { extractBillOfQuantitiesPositions } from './services/billOfQuantitiesExtractionService';
import {
  applyAllOpenPositionsToDraft,
  buildInvoiceDraftForType,
} from './services/invoiceService';
import { CONTRACT_ORDER_INVOICE_TYPES } from './services/invoiceTypeService';
import { confirmImportSafeContractPositions } from './services/contractPositionImportService';
import {
  createVorgangFromInboxWithContract,
  getContractPreviewForInbox,
} from './services/intakeWorkflowService';
import { hydrateInboxStore } from './services/inboxService';
import { getVorgangById, hydrateVorgangStore } from './services/vorgangService';
import type { InboxItem } from './types/models';

function createSyntheticWerkvertragItem(): InboxItem {
  const pages = buildSyntheticWerkvertragPages();
  const text = buildSyntheticWerkvertragText();
  return {
    ...createAuftragInboxItem(),
    id: 'inbox-synthetic-werkvertrag',
    title: 'Werkvertrag BV Test',
    sender: 'Isobautec GmbH',
    recognizedData: {
      Kunde: 'Isobautec GmbH',
      Baustelle: 'BV Sägewerk Fisch',
      _vertragstext: text,
      _pageTexts: JSON.stringify(pages),
      Betreff: 'Werkvertrag',
    },
  };
}

describe('DOCUMENT-INTELLIGENCE-01 segmentation', () => {
  it('klassifiziert Vertragskern, LV und technische Anlagen auf variablen Seiten', () => {
    const pages = buildSyntheticWerkvertragPages();
    const result = segmentDocumentPages(pages);

    expect(result.contractCorePages).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.billOfQuantitiesPages).toEqual([8]);
    expect(result.technicalAttachmentPages).toEqual([9, 10, 11, 12]);
  });

  it('technische Zahlen beeinflussen Vertragssumme nicht', () => {
    const pages = buildSyntheticWerkvertragPages();
    const technicalText = pages
      .filter((page) => page.pageNumber >= 9)
      .map((page) => page.text)
      .join('\n');
    const total = resolveContractTotalNet(technicalText, pages.filter((p) => p.pageNumber >= 9));
    expect(total.status).toBe('not_found');
  });
});

describe('DOCUMENT-INTELLIGENCE-01 classification', () => {
  it('erkennt Werkvertrag mit Preisen nicht als Eingangsrechnung', () => {
    const text = buildSyntheticWerkvertragText();
    const pages = buildSyntheticWerkvertragPages();
    const result = detectClassifiedKindWithReason({ recognizedText: text, pageTexts: pages });
    expect(['werkvertrag', 'subunternehmervertrag']).toContain(result.kind);
    expect(result.reasonKey).toBe('classification.detect.werkvertragMitLv');
  });

  it('lässt echte Eingangsrechnung als Eingangsrechnung', () => {
    const result = detectClassifiedKindWithReason({ recognizedText: SAMPLE_EINGANGSRECHNUNG_TEXT });
    expect(result.kind).toMatch(/eingangsrechnung|rechnung/);
  });

  it('klassifiziert Leistungsverzeichnis allein nicht als Rechnung', () => {
    const lvPage = buildSyntheticWerkvertragPages().find((page) => page.pageNumber === 8)!;
    const result = detectClassifiedKindWithReason({ recognizedText: lvPage.text });
    expect(result.kind).not.toBe('eingangsrechnung');
    expect(result.kind).not.toBe('rechnung');
  });
});

describe('DOCUMENT-INTELLIGENCE-01 position extraction', () => {
  it('erkennt 11 Positionen im synthetischen Kontrollfall', () => {
    const pages = buildSyntheticWerkvertragPages();
    const lvPage = pages.find((page) => page.pageNumber === 8)!;
    const positions = extractBillOfQuantitiesPositions(lvPage.text, 8);
    expect(positions).toHaveLength(11);
  });

  it('validiert Mengen, Einheiten und Preise inkl. Rundung', () => {
    const intelligence = analyzeContractIntelligenceFromText(
      buildSyntheticWerkvertragText(),
      buildSyntheticWerkvertragPages(),
    );
    expect(intelligence).not.toBeNull();
    expect(intelligence!.positions).toHaveLength(11);

    const peFolie = intelligence!.positions.find((p) => p.description.includes('PE-Folie'));
    expect(peFolie?.quantity).toBe(4799);
    expect(peFolie?.unitPrice).toBe(0.35);
    expect(peFolie?.lineTotal).toBeCloseTo(1679.65, 2);

    const lichtkuppel = intelligence!.positions.find((p) => p.description.includes('Lichtkuppel'));
    expect(lichtkuppel?.quantity).toBe(4);
    expect(lichtkuppel?.unit).toMatch(/St/i);
  });
});

describe('DOCUMENT-INTELLIGENCE-01 amount logic', () => {
  it('übernimmt Vertragssumme netto nur mit eindeutigem Kontext', () => {
    const intelligence = analyzeContractIntelligenceFromText(
      buildSyntheticWerkvertragText(),
      buildSyntheticWerkvertragPages(),
    );
    expect(intelligence?.contractTotalNet?.value).toBeCloseTo(36029.05, 2);
    expect(intelligence?.contractTotalNet?.status).toBe('confirmed');
  });

  it('verwendet Stundenpreis nicht als Vertragssumme', () => {
    const intelligence = analyzeContractIntelligenceFromText(SAMPLE_STUNDENPREIS_CONTRACT_TEXT);
    expect(intelligence?.contractTotalNet?.value).toBeCloseTo(12500, 2);
    expect(intelligence?.contractTotalNet?.value).not.toBe(35);
  });
});

describe('DOCUMENT-INTELLIGENCE-01 order proposal', () => {
  it('baut Auftragsvorschlag mit 11 Positionen und Vertragssumme', () => {
    const item = createSyntheticWerkvertragItem();
    const proposal = buildContractOrderProposal(item);
    expect(proposal).not.toBeNull();
    expect(proposal!.positionCount).toBe(11);
    expect(proposal!.customer).toContain('Isobautec');
    expect(proposal!.contractor).toContain('Ivan Iliev');
    // Kein Folgefeld und kein Klauseltext am Namen (CONTRACT-CONTRACTOR-EXTRACTION-01).
    expect(proposal!.contractor).not.toMatch(/Baustellen|Vertragsbedingungen|SEITE/i);
    expect(proposal!.contractTotalNet).toContain('36.029,05');
    expect(proposal!.progressBillingHint).toBe('documentIntelligence.hint.progressBilling');
  });

  it('legt Auftrag erst nach expliziter Anlage mit allen Positionen an', () => {
    localStorage.clear();
    hydrateVorgangStore([]);
    const item = createSyntheticWerkvertragItem();
    hydrateInboxStore([item]);

    const preview = getContractPreviewForInbox(item);
    expect(preview.hasContractPositions).toBe(true);
    expect(preview.positionCount).toBe(11);

    const created = createVorgangFromInboxWithContract(item);
    expect(created).not.toBeNull();
    expect(getVorgangById(created!.vorgang.id)?.orderPositions).toHaveLength(0);
    confirmImportSafeContractPositions(created!.vorgang.id, preview.positions);
    const vorgang = getVorgangById(created!.vorgang.id);
    expect(vorgang?.orderPositions).toHaveLength(11);
    expect(created!.inbox.vorgangId).toBe(created!.vorgang.id);
  });
});

describe('DOCUMENT-INTELLIGENCE-01 invoice flow', () => {
  it('nutzt normale Rechnung als Standard ohne automatisches Skonto', () => {
    localStorage.clear();
    hydrateVorgangStore([]);
    const item = createSyntheticWerkvertragItem();
    hydrateInboxStore([item]);
    const preview = getContractPreviewForInbox(item);
    const created = createVorgangFromInboxWithContract(item)!;
    confirmImportSafeContractPositions(created.vorgang.id, preview.positions);
    const draft = buildInvoiceDraftForType(created.vorgang.id, {
      companyName: 'Test GmbH',
      industry: 'sanitaer',
      taxStatus: 'standard_19',
      materialStandard: 'eigen',
      language: 'de',
    }, 'rechnung');

    expect(draft.type).toBe('rechnung');
    expect(draft.skontoText).toBe('');
    expect(CONTRACT_ORDER_INVOICE_TYPES).toEqual(['rechnung', 'abschlag', 'schluss']);
  });

  it('bietet Vertragsskonto optional an und übernimmt alle offenen Mengen', () => {
    localStorage.clear();
    hydrateVorgangStore([]);
    const item = createSyntheticWerkvertragItem();
    hydrateInboxStore([item]);
    const preview = getContractPreviewForInbox(item);
    const created = createVorgangFromInboxWithContract(item)!;
    confirmImportSafeContractPositions(created.vorgang.id, preview.positions);
    const vorgang = getVorgangById(created.vorgang.id)!;
    vorgang.createdFromInboxId = item.id;

    const skontoOffer = getContractSkontoOfferForVorgang(vorgang);
    expect(skontoOffer?.percent).toBe(2);
    expect(skontoOffer?.days).toBe(14);

    const draft = buildInvoiceDraftForType(created.vorgang.id, {
      companyName: 'Test GmbH',
      industry: 'sanitaer',
      taxStatus: 'standard_19',
      materialStandard: 'eigen',
      language: 'de',
    }, 'rechnung');
    const filled = applyAllOpenPositionsToDraft(draft);
    expect(filled.positions.every((p) => p.quantity === p.openQuantity)).toBe(true);
  });
});
