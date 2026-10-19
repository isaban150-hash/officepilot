/**
 * FC01A-Nacharbeit (A6) — die Summenkarte im Rechnungsassistenten einer Schlussrechnung.
 *
 * Gefunden in der Fachprüfung: Die Karte zeigte „Zwischensumme 1.000 / MwSt. 190 / Gesamt 714"
 * — der Abzug der Abschläge fehlte, die Zahlen gingen scheinbar nicht auf. Jetzt: Gesamtbetrag
 * (brutto), „Abzüglich Abschläge" und „Restbetrag", wie im Beleg. Eine Rechnung ohne Abzüge
 * bleibt, wie sie war.
 *
 * Neutrale Beispieldaten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { RechnungPage } from './RechnungPage';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { hydrateDocumentStore } from '../services/documentService';
import { hydrateVorgangStore } from '../services/vorgangService';
import { resetInvoiceNumberSequence } from '../services/invoiceNumberService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import { resetInvoiceDraftDurabilityDatabaseForTests } from '../services/invoice/invoiceDraftDurabilityService';
import * as workspaceSyncPayloadService from '../services/workspace/workspaceSyncPayloadService';
import { t } from '../i18n';
import type { VorgangInvoice } from '../types/models';

const WORKSPACE_ID = 'ws-summenkarte-nach';

const company = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Summen GmbH',
  street: 'Werk 1',
  zip: '80331',
  city: 'München',
  iban: 'DE89370400440532013000',
  bankName: 'Sparkasse',
  phone: '089 111',
  email: 'a@b.invalid',
};

/** Pauschalabschlag 400 netto / 476 brutto, bezahlt. */
const ABSCHLAG: VorgangInvoice = {
  id: 'inv-ab-1',
  number: '2026-0017',
  type: 'abschlag',
  abschlagNumber: 1,
  calculationMode: 'fixed_amount',
  fixedAmountNet: 400,
  positions: [],
  subtotal: 400,
  taxStatus: 'standard_19',
  amount: 476,
  status: 'versendet',
  date: '2026-09-01',
  issueDate: '2026-09-01',
  createdAt: '2026-09-01T10:00:00.000Z',
  payments: [{ id: 'p-ab-1', amount: 476, date: '2026-09-05', createdAt: '2026-09-05T10:00:00.000Z' }],
};

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  try {
    localStorage.clear();
  } catch {
    // Ohne Speicher gibt es nichts zu leeren.
  }
  resetInvoiceNumberSequence();
  hydrateDocumentStore([]);
  hydrateCompanyProfileStore(company);
  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_ID });
  vi.spyOn(workspaceSyncPayloadService, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE_ID);
  await resetInvoiceDraftDurabilityDatabaseForTests();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function oeffne(type: 'schluss' | 'rechnung', invoices: VorgangInvoice[]): Promise<string> {
  hydrateVorgangStore([
    createTestVorgang({
      taxStatus: 'standard_19',
      orderPositions: [createOrderPosition({ id: 'op-test-1', plannedQuantity: 10, executedQuantity: 10, unitPrice: 100 })],
      invoices,
    }),
  ]);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/vorgaenge/v-test-1/rechnung?type=${type}`]}>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' }}>
          <Routes>
            <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (host.textContent?.includes(t('invoice.subtotal'))) break;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
  return host.textContent ?? '';
}

describe('FC01A-Nacharbeit A6 — Summenkarte der Schlussrechnung', () => {
  it('K1: Schlussrechnung mit bezahltem Abschlag — Brutto, Abzug und Restbetrag stehen da', async () => {
    const text = await oeffne('schluss', [ABSCHLAG]);
    expect(text).toContain(t('invoice.summary.grossBeforeDeductions'));
    expect(text).toContain(t('invoice.summary.deductions'));
    expect(text).toContain('− 476,00 €');
    expect(text).toContain(t('invoice.summary.amountDue'));
  });

  it('K2: Rechnung ohne Abzüge — die Karte bleibt, wie sie war', async () => {
    const text = await oeffne('rechnung', []);
    expect(text).toContain(t('invoice.total'));
    expect(text).not.toContain(t('invoice.summary.deductions'));
    expect(text).not.toContain(t('invoice.summary.amountDue'));
  });
});
