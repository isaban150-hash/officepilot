import { describe, expect, it, beforeEach } from 'vitest';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { createAuftragInboxItem, createOrderPosition, createTestVorgang, testSetup } from '../test/fixtures';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { SAMPLE_WERKVERTRAG_TEXT } from './contractAnalysisService';
import { confirmImportSafeContractPositions } from './contractPositionImportService';
import {
  createVorgangFromInboxWithContract,
  getContractPreviewForInbox,
  importSuggestedPositionsToVorgang,
} from './intakeWorkflowService';
import {
  buildInvoiceDraftForType,
  calculateInvoiceTotals,
  finalizeInvoiceDraft,
} from './invoiceService';
import { buildInvoicePrintModel } from './invoicePrintModel';
import { mapDetectedUnit } from './orderUnitMapper';
import { hydrateInboxStore } from './inboxService';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
import type { DetectedOrderPosition, InboxItem } from '../types/models';

const companyProfile = {
  companyName: 'Mustermann Sanitär GmbH',
  legalForm: 'GmbH',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  contactPerson: 'Max Mustermann',
  phone: '030 123456',
  email: 'info@mustermann-sanitaer.de',
  website: 'https://mustermann-sanitaer.de',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage netto',
  defaultSkonto: '2 % bei 7 Tagen',
  invoiceFooterNotes: '',
  logoDataUrl: 'data:image/png;base64,test-logo',
};

function cloneInbox(item: InboxItem, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    ...item,
    recognizedData: { ...item.recognizedData },
    digitalFolder: { ...item.digitalFolder },
    paperFiling: { ...item.paperFiling },
    taskTemplate: item.taskTemplate ? { ...item.taskTemplate } : undefined,
    ...overrides,
  };
}

function createWerkvertragItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return cloneInbox(createAuftragInboxItem(), {
    id: 'inbox-werkvertrag-flow',
    title: 'Werkvertrag Müller',
    recognizedData: {
      Kunde: 'Müller Bau GmbH',
      Baustelle: 'Hauptstr. 12, Berlin',
      Leistung: 'Badezimmer-Sanierung Müller',
      Angebotssumme: 'ca. 5.070 €',
      _vertragstext: SAMPLE_WERKVERTRAG_TEXT,
      Betreff: 'Mustermann Sanitär GmbH',
    },
    ...overrides,
  });
}

function createVorgangWithConfirmedPositions(item: InboxItem) {
  const preview = getContractPreviewForInbox(item);
  const created = createVorgangFromInboxWithContract(item);
  expect(created).not.toBeNull();
  if (preview.hasContractPositions) {
    confirmImportSafeContractPositions(created!.vorgang.id, preview.positions);
  }
  const vorgang = getVorgangById(created!.vorgang.id);
  expect(vorgang).not.toBeNull();
  return { inbox: created!.inbox, vorgang: vorgang! };
}

describe('invoice flow connect', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore(companyProfile);
    hydrateVorgangStore([]);
  });

  it('legt bei Werkvertrag alle erkannten Positionen erst nach Bestätigung an', () => {
    const item = createWerkvertragItem();
    hydrateInboxStore([item]);

    const preview = getContractPreviewForInbox(item);
    const beforeConfirm = createVorgangFromInboxWithContract(item);
    expect(beforeConfirm).not.toBeNull();
    expect(getVorgangById(beforeConfirm!.vorgang.id)?.orderPositions).toHaveLength(0);

    confirmImportSafeContractPositions(beforeConfirm!.vorgang.id, preview.positions);
    const vorgang = getVorgangById(beforeConfirm!.vorgang.id);
    expect(vorgang?.orderPositions).toHaveLength(3);
    expect(vorgang?.orderPositions.filter((p) => p.id.startsWith('op-inbox-'))).toHaveLength(0);
    expect(vorgang?.orderPositions[0]?.description).toContain('Demontage Badewanne');
  });

  it('legt keine zusätzliche Pauschalposition bei erkannten Vertragspositionen an', () => {
    const item = createWerkvertragItem();
    hydrateInboxStore([item]);

    const { vorgang } = createVorgangWithConfirmedPositions(item);

    expect(vorgang.orderPositions).toHaveLength(3);
    expect(vorgang.orderPositions.filter((p) => p.id.startsWith('op-inbox-'))).toHaveLength(0);
  });

  it('verwendet Pauschal-Fallback ohne erkannte Vertragspositionen', () => {
    const item = cloneInbox(MOCK_INBOX_ITEMS.find((i) => i.id === 'inbox-001')!, {
      id: 'inbox-pauschal-fallback',
    });
    hydrateInboxStore([item]);

    const result = createVorgangFromInboxWithContract(item);
    const vorgang = getVorgangById(result!.vorgang.id);

    expect(vorgang?.orderPositions).toHaveLength(1);
    expect(vorgang?.orderPositions[0]?.unit).toBe('Pauschal');
    expect(vorgang?.orderPositions[0]?.unitPrice).toBe(8500);
  });

  it('übernimmt Menge, Einheit, EP und Positionsformat korrekt', () => {
    const item = createWerkvertragItem();
    hydrateInboxStore([item]);

    const { vorgang } = createVorgangWithConfirmedPositions(item);
    const fliesen = vorgang.orderPositions.find((p) => p.description.includes('Fliesenarbeiten'));

    expect(fliesen).toMatchObject({
      plannedQuantity: 28,
      unit: 'm²',
      unitPrice: 65,
    });
    expect(fliesen?.description.startsWith('2')).toBe(true);
  });

  it('normalisiert lfm auf Meter und behält Anzeige lfm', () => {
    const positions: DetectedOrderPosition[] = [
      {
        positionNumber: '10',
        description: 'Kabelkanal verlegen',
        unit: 'lfm',
        quantity: 12,
        unitPrice: 18,
        lineTotal: 216,
      },
    ];

    hydrateVorgangStore([createTestVorgang({ orderPositions: [] })]);
    importSuggestedPositionsToVorgang('v-test-1', positions);

    const vorgang = getVorgangById('v-test-1');
    expect(vorgang?.orderPositions[0]).toMatchObject({
      unit: 'Meter',
      unitLabel: 'lfm',
      plannedQuantity: 12,
      unitPrice: 18,
    });
    expect(mapDetectedUnit('lfm.')).toEqual({ unit: 'Meter', unitLabel: 'lfm' });
  });

  it('erzeugt Rechnungsentwurf aus übernommenen Auftragspositionen', () => {
    const item = createWerkvertragItem();
    hydrateInboxStore([item]);
    const { vorgang } = createVorgangWithConfirmedPositions(item);

    const draft = buildInvoiceDraftForType(vorgang.id, testSetup, 'rechnung');
    expect(draft).not.toBeNull();
    expect(draft!.positions.length).toBe(3);
    expect(draft!.positions[0]?.description).toContain('Demontage Badewanne');
    expect(draft!.positions[0]?.unitPrice).toBe(450);
  });

  it('berechnet Summe neu wenn nur die Menge geändert wird', () => {
    hydrateVorgangStore([
      createTestVorgang({
        orderPositions: [
          createOrderPosition({
            id: 'op-qty-test',
            plannedQuantity: 10,
            unitPrice: 65,
            unit: 'Stunden',
          }),
        ],
      }),
    ]);

    const draft = buildInvoiceDraftForType('v-test-1', testSetup, 'rechnung')!;
    const originalSubtotal = calculateInvoiceTotals(draft, testSetup).subtotal;
    expect(originalSubtotal).toBe(650);

    const updatedDraft = {
      ...draft,
      positions: draft.positions.map((position) => ({ ...position, quantity: 8 })),
    };
    const updatedSubtotal = calculateInvoiceTotals(updatedDraft, testSetup).subtotal;

    expect(updatedSubtotal).toBe(520);
  });

  it('übernimmt Logo und Firmendaten in den Invoice-Snapshot', () => {
    const item = createWerkvertragItem();
    hydrateInboxStore([item]);
    const { vorgang } = createVorgangWithConfirmedPositions(item);

    const draft = buildInvoiceDraftForType(vorgang.id, testSetup, 'rechnung')!;
    expect(draft.companySnapshot.logoDataUrl).toBe(companyProfile.logoDataUrl);
    expect(draft.companySnapshot.companyName).toBe(companyProfile.companyName);
    expect(draft.companySnapshot.taxNumber).toBe(companyProfile.taxNumber);
    expect(draft.companySnapshot.vatId).toBe(companyProfile.vatId);
    expect(draft.companySnapshot.iban).toBe(companyProfile.iban);

    const withAddress = {
      ...draft,
      customerBilling: {
        ...draft.customerBilling,
        name: draft.customerBilling.name || 'Müller Bau GmbH',
        street: draft.customerBilling.street || 'Hauptstr. 12',
        zip: draft.customerBilling.zip || '10115',
        city: draft.customerBilling.city || 'Berlin',
      },
      positions: draft.positions.map((p) => ({
        ...p,
        quantity: p.quantity > 0 ? p.quantity : 1,
      })),
    };
    const result = finalizeInvoiceDraft(vorgang.id, withAddress, testSetup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.companySnapshot?.logoDataUrl).toBe(companyProfile.logoDataUrl);
    expect(result.invoice.paymentStatus).toBe('offen');
    expect(result.invoice.customerSnapshot?.name).toBeTruthy();
  });

  it('funktioniert ohne Logo ohne Fehler', () => {
    hydrateCompanyProfileStore({ ...companyProfile, logoDataUrl: undefined });
    const item = createWerkvertragItem();
    hydrateInboxStore([item]);
    const { vorgang } = createVorgangWithConfirmedPositions(item);

    const draft = buildInvoiceDraftForType(vorgang.id, testSetup, 'rechnung')!;
    expect(() => buildInvoicePrintModel(draft, testSetup)).not.toThrow();
    expect(draft.companySnapshot.logoDataUrl).toBeUndefined();
  });

  it('verhindert doppelte Aufträge und Positionsimporte', () => {
    const item = createWerkvertragItem();
    hydrateInboxStore([item]);

    const first = createVorgangWithConfirmedPositions(item);
    const second = createVorgangFromInboxWithContract(item);
    expect(second).toBeNull();

    const preview = getContractPreviewForInbox(item);
    const reimport = importSuggestedPositionsToVorgang(first.vorgang.id, preview.positions);
    expect(reimport.added).toBe(0);
    expect(reimport.skipped).toBe(preview.positions.length);

    const vorgang = getVorgangById(first.vorgang.id);
    expect(vorgang?.orderPositions).toHaveLength(3);
  });
});
