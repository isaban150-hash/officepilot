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

/**
 * Eine ausdrückliche Kundenentscheidung für die Vertragsannahme.
 *
 * CUSTOMER-FACHOBJEKT-04C — wer aus einem Vertrag einen Auftrag erzeugt, muss
 * zuvor entscheiden, **wer der Kunde ist**. Ohne Entscheidung lehnt
 * `acceptContractOrderFromProposal` mit `customerDecision.required` ab, und das
 * ist Absicht: Es verhindert, dass still ein falscher — oder gar der eigene —
 * Betrieb als Kunde entsteht.
 *
 * Der Name ist bewusst ein fremder Auftraggeber und **nie** der eigene
 * Firmenname, damit die Own-company-Prüfung im Test scharf bleibt.
 */
export function createTestCustomerDecision(name = 'Müller Bau GmbH'): {
  kind: 'new';
  input: { name: string };
} {
  return { kind: 'new', input: { name } };
}

/**
 * Eine Auftragsposition, an der die Leistung **tatsächlich erfasst** wurde.
 *
 * INVOICE-ACTUAL-QUANTITY-01B — die Planmenge ist kein Aufmass. `quantity`
 * einer Rechnungsposition wird deshalb aus dem **ausgeführten** Rest
 * vorgeschlagen (`getExecutedRemainingQuantity`) und bleibt ohne
 * Ausführungsstand bei 0. Ein Vorgang mit `plannedQuantity` allein ist damit
 * fachlich noch nicht abrechenbar — genau so soll es sein.
 *
 * Diese Hilfe modelliert den Normalfall einer abrechnungsreifen Position:
 * geplant **und** ausgeführt.
 */
export function createExecutedOrderPosition(overrides: Partial<OrderPosition> = {}): OrderPosition {
  const base = createOrderPosition(overrides);
  return { ...base, executedQuantity: overrides.executedQuantity ?? base.plannedQuantity };
}

/**
 * Ein Vorgang, an dem Leistung erfasst wurde und der deshalb abgerechnet
 * werden kann.
 *
 * Bewusst eine eigene Hilfe statt einer Änderung an `createTestVorgang`:
 * Tests, die den Nullmengenfall prüfen — also dass ohne Aufmass nichts
 * abgerechnet wird — brauchen weiterhin einen Vorgang **ohne**
 * Ausführungsstand.
 */
export function createTestVorgangWithExecutedQuantity(
  overrides: Partial<Vorgang> = {},
): Vorgang {
  return createTestVorgang({ orderPositions: [createExecutedOrderPosition()], ...overrides });
}

export function createTestVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return {
    id: 'v-test-1',
    title: 'Testvorgang',
    customer: 'Test Kunde',
    baustelle: 'Teststraße 1',
    status: 'eingegangen',
    materialSource: 'betrieb',
    customerBilling: {
      name: 'Test Kunde',
      contactPerson: '',
      street: 'Kundenweg 1',
      zip: '10115',
      city: 'Berlin',
      email: '',
      phone: '',
    },
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
