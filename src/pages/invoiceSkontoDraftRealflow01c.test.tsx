/**
 * INVOICE-SKONTO-DRAFT-REALFLOW-01C — Selbsttest des Realgeräteablaufs.
 *
 * Auf dem iPhone wurden Skonto 7 % / 10 Tage in den Firmendaten gesetzt. Danach
 * zeigte dieselbe Rechnung trotzdem „Zahlbar innerhalb von 14 Tagen ohne
 * Abzug." und keinen Skontosatz. Verdacht: Der zuvor mit „Abbrechen" verlassene
 * Entwurf wurde wieder aufgenommen, und die neuen Firmendaten erreichten ihn
 * nie.
 *
 * Dieser Test stellt genau diesen Ablauf über den **echten** Weg nach —
 * `RechnungPage`, Router, Durability-Sitzung, IndexedDB-Ersatz — und beweist
 * oder widerlegt den Verdacht, statt ihn aus dem Quelltext zu erschliessen.
 *
 * Er ändert kein Verhalten: Er hält fest, was heute geschieht.
 *
 * Synthetische Daten, kein Netz, keine Finalisierung, keine Zugangsdaten.
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
import {
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from '../services/invoice/invoiceDraftDurabilityService';
import { buildInvoicePrintModel } from '../services/invoicePrintModel';
import * as workspaceSyncPayloadService from '../services/workspace/workspaceSyncPayloadService';
import type { CompanyProfile, InvoiceDraft } from '../types/models';

const WORKSPACE_ID = 'ws-skonto-realflow-01c';
const VORGANG_ID = 'v-test-1';

const STANDARD_WITH_DEDUCTION = 'Zahlbar innerhalb von 14 Tagen ohne Abzug.';
const STANDARD_PLAIN = 'Zahlbar innerhalb von 14 Tagen.';
const SKONTO_SENTENCE = 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 7 % Skonto.';

const baseCompany: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Realflow GmbH',
  street: 'Werk 1',
  zip: '80331',
  city: 'München',
  iban: 'DE89370400440532013000',
  bankName: 'Sparkasse',
  phone: '089 111',
  email: 'a@b.invalid',
  defaultPaymentDays: 14,
  defaultPaymentTerms: STANDARD_WITH_DEDUCTION,
  skontoEnabled: false,
  skontoPercent: 0,
  skontoDays: 0,
  defaultSkonto: '',
};

/** Wie auf dem Gerät: Zahlungsziel 14, Skonto 7 % in 10 Tagen. */
const companyWithSkonto: CompanyProfile = {
  ...baseCompany,
  skontoEnabled: true,
  skontoPercent: 7,
  skontoDays: 10,
};

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  resetInvoiceNumberSequence();
  hydrateDocumentStore([]);
  hydrateVorgangStore([
    createTestVorgang({
      id: VORGANG_ID,
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          description: 'Montagearbeiten',
          plannedQuantity: 20,
          executedQuantity: 20,
          unit: 'Stunden',
          unitPrice: 100,
          category: 'arbeit',
        }),
      ],
    }),
  ]);
  hydrateCompanyProfileStore(baseCompany);
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

async function settle(rounds = 12): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

/** „Rechnung vorbereiten" — der echte Einstieg über den Router. */
async function openInvoicePage(): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/vorgaenge/${VORGANG_ID}/rechnung?type=rechnung`]}>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
          <Routes>
            <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (host.querySelector('[data-testid="rechnung-page"]')) break;
    await settle(1);
  }
  await settle();
}

/** „Abbrechen" — die Seite verlassen. Mehr tut der Knopf nicht. */
async function leaveInvoicePage(): Promise<void> {
  await act(async () => {
    root.unmount();
  });
  await settle(4);
  root = createRoot(host);
}

/** Der gespeicherte Entwurf, wie ihn die Durability-Schicht kennt. */
async function persistedRecord() {
  const loaded = await loadInvoiceDraftRecordByLocator({
    sourceScopeKey: `workspace:${WORKSPACE_ID}`,
    workspaceId: WORKSPACE_ID,
    vorgangId: VORGANG_ID,
    invoiceType: 'rechnung',
  });
  return loaded;
}

async function previewText(): Promise<string> {
  const button = host.querySelector<HTMLButtonElement>(
    '[data-testid="invoice-continue-preview"]',
  );
  if (button) {
    await act(async () => {
      button.click();
    });
    await settle();
  }
  const block = host.querySelector('.invoice-payment-block, [data-testid="invoice-document"]');
  return (block?.textContent ?? host.textContent ?? '').replace(/\s+/g, ' ');
}

describe('SKONTO-REALFLOW-01C — der Ablauf vom Gerät', () => {
  it('T1/T2: der alte Entwurf wird wieder aufgenommen und behält seinen Stand', async () => {
    // A + B — Profil ohne Skonto, Entwurf entsteht.
    await openInvoicePage();
    const before = await persistedRecord();
    expect(before.ok, 'Kein Entwurf gespeichert').toBe(true);
    if (!before.ok) return;

    expect(before.draft.paymentTermsText).toBe(STANDARD_WITH_DEDUCTION);
    expect(before.draft.skontoText).toBe('');
    const draftIdBefore = before.record.draftId;

    // C + E — „Abbrechen": die Seite verlassen.
    await leaveInvoicePage();

    // D — Firmendaten ändern, genau wie am Gerät.
    hydrateCompanyProfileStore(companyWithSkonto);

    // E — erneut „Rechnung vorbereiten".
    await openInvoicePage();

    const after = await persistedRecord();
    expect(after.ok).toBe(true);
    if (!after.ok) return;

    /*
     * Der Beweis: dieselbe Entwurfskennung. Es wurde kein neuer Entwurf
     * erzeugt, also lief `createDraft` — und damit der Firmenstandard — gar
     * nicht erst.
     */
    expect(after.record.draftId, 'Es wurde ein neuer Entwurf erzeugt').toBe(draftIdBefore);
    expect(after.draft.paymentTermsText).toBe(STANDARD_WITH_DEDUCTION);
    expect(after.draft.skontoText).toBe('');
    expect(after.draft.paymentDueDate).toBe(before.draft.paymentDueDate);

    // Und genau das sieht der Nutzer — der Realgerätebefund, reproduziert.
    const preview = await previewText();
    expect(preview).toContain(STANDARD_WITH_DEDUCTION);
    expect(preview).not.toContain(SKONTO_SENTENCE);
  });

  it('T3/T4/T5: ein wirklich frischer Entwurf trägt 14 / 7 / 10 korrekt', async () => {
    // Erst der alte Entwurf, wie oben.
    await openInvoicePage();
    await leaveInvoicePage();
    hydrateCompanyProfileStore(companyWithSkonto);

    /*
     * G — ein *wirklich* frischer Entwurf. Am Gerät gibt es dafür heute keinen
     * Weg; hier wird der gespeicherte Datensatz entfernt, damit der reguläre
     * Neuanlagepfad läuft. Genau das fehlt dem Produkt als bewusste Aktion.
     */
    await resetInvoiceDraftDurabilityDatabaseForTests();
    await openInvoicePage();

    const fresh = await persistedRecord();
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;

    expect(fresh.draft.paymentTermsText).toBe(STANDARD_PLAIN);
    expect(fresh.draft.paymentTermsText).not.toContain('ohne Abzug');
    expect(fresh.draft.skontoText).toBe(SKONTO_SENTENCE);

    // H — Vorschau und Druckmodell tragen denselben Stand.
    const preview = await previewText();
    expect(preview).toContain(STANDARD_PLAIN);
    expect(preview).toContain(SKONTO_SENTENCE);
    expect(preview).not.toContain(STANDARD_WITH_DEDUCTION);

    const model = buildInvoicePrintModel(fresh.draft as InvoiceDraft, DEFAULT_SETUP);
    expect(model.paymentTermsText).toBe(STANDARD_PLAIN);
    expect(model.skontoText).toBe(SKONTO_SENTENCE);
  });
});
