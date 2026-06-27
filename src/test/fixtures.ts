import { DEFAULT_SETUP } from '../data/mockData';
import type {
  CompanySetup,
  InboxItem,
  OrderPosition,
  Vorgang,
  VorgangInvoice,
} from '../types/models';

const baseInboxFields = {
  sender: 'Test Kunde',
  priority: 'mittel' as const,
  deadline: null,
  digitalFolder: { id: 'dig-1', name: 'Test', path: '/test/' },
  paperFiling: { folderId: 'folder-1', register: 'A', label: 'Test' },
  status: 'neu' as const,
  receivedAt: '2026-03-27',
  officePilotSuggestion: 'Test',
  nextTaskLabel: 'Test',
  securityHint: 'Test',
};

export function createAuftragInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  const { recognizedData: recognizedOverride, ...restOverrides } = overrides;
  return {
    ...baseInboxFields,
    id: 'inbox-test-auftrag',
    title: 'Neuer Auftrag',
    documentType: 'kundenauftrag',
    recommendedAction: 'auftrag_annehmen',
    recognizedData: {
      Leistung: 'Badezimmer-Sanierung',
      Angebotssumme: 'ca. 8.500 €',
      ...recognizedOverride,
    },
    ...restOverrides,
  };
}

export function createMaterialInboxItem(): InboxItem {
  return {
    ...baseInboxFields,
    id: 'inbox-test-material',
    title: 'Materialrechnung',
    documentType: 'eingangsrechnung',
    recommendedAction: 'zuordnen',
    recognizedData: { Rechnungsnummer: 'MR-1' },
  };
}

export function createOrderPosition(overrides: Partial<OrderPosition> = {}): OrderPosition {
  return {
    id: 'op-test-1',
    description: 'Testleistung',
    plannedQuantity: 10,
    unit: 'Stunden',
    unitPrice: 65,
    category: 'arbeit',
    ...overrides,
  };
}

export function createTestVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return {
    id: 'v-test-1',
    title: 'Testvorgang',
    customer: 'Test Kunde',
    baustelle: 'Teststraße 1',
    status: 'neu',
    materialSource: 'betrieb',
    orderPositions: [createOrderPosition()],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
    ...overrides,
  };
}

export function createAbschlagInvoice(
  orderPositionId: string,
  quantity: number,
  overrides: Partial<VorgangInvoice> = {},
): VorgangInvoice {
  return {
    id: 'inv-test-1',
    number: 'AR-2026-01',
    type: 'abschlag',
    abschlagNumber: 1,
    positions: [
      {
        id: 'line-1',
        orderPositionId,
        description: 'Testleistung',
        quantity,
        unit: 'Stunden',
        unitPrice: 65,
        lineTotal: quantity * 65,
      },
    ],
    subtotal: quantity * 65,
    taxStatus: 'standard_19',
    amount: quantity * 65 * 1.19,
    status: 'vorbereitet',
    date: '2026-03-01',
    createdAt: '2026-03-01T10:00:00.000Z',
    ...overrides,
  };
}

export const testSetup: CompanySetup = { ...DEFAULT_SETUP };
