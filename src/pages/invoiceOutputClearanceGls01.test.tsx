/**
 * GO-LIVE-SECURITY-01 — verbindliche Ausgabe auf der Rechnungsdetailseite.
 *
 * Auf dem Gerät eines Mitglieds liegt eine Bestätigung des Leistungszeitraums
 * aus einem älteren Stand. Solange die Cloud nicht geantwortet hat, erzeugt
 * weder ein Klick noch ein Direktaufruf (`?auto=pdf`, `?auto=print`) noch
 * ZUGFeRD oder XRechnung eine Ausgabe. Trägt die Cloud die Bestätigung, geht es
 * weiter, mit einem früheren Nachweis auch offline. Ohne bestätigten
 * Leistungszeitraum verweigern auch die E-Rechnungsdienste, für jede Rolle.
 * Inhaber bleiben sonst unverändert. Kein Netzwerk.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alsInhaber, alsMitglied } from '../test/workspaceRoleTestUtils';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { resetTestStores } from '../test/resetStores';
import { createTestVorgang } from '../test/fixtures';
import { getVorgangInvoice, hydrateVorgangStore } from '../services/vorgangService';
import { validateFinalizedInvoiceForPdf } from '../services/invoiceValidationService';
import * as invoiceCloud from '../services/invoice/workspaceInvoiceCloudService';
import * as confirmService from '../services/invoice/invoiceServicePeriodConfirmService';
import type { ServicePeriodCloudState } from '../services/invoice/invoiceServicePeriodConfirmService';
import * as invoicePdfService from '../services/invoicePdfService';
import * as invoicePrintService from '../services/invoicePrintService';
import * as zugferdService from '../services/einvoice/zugferd/zugferdArtifactService';
import * as xrechnungService from '../services/einvoice/xrechnungArtifactService';
import {
  hasServicePeriodCloudProof,
  recordServicePeriodCloudProofs,
  resetServicePeriodCloudProofsForTests,
  resolveActiveCloudWorkspaceId,
} from '../services/invoice/invoiceOutputClearance';
import * as workspacePayload from '../services/workspace/workspaceSyncPayloadService';
import * as supabaseLib from '../lib/supabase';
import type { VorgangInvoice } from '../types/models';
import { InvoiceDetailPage } from './InvoiceDetailPage';

const WORKSPACE = '00000000-0000-4000-8000-000000000a05';
const VORGANG_ID = 'v-test-1';
const INVOICE_ID = 'inv-gls01-ausgabe';

/** Freigegeben und lokal bestätigt — ob die Cloud die Bestätigung trägt, entscheidet der Test. */
function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    ...rechnungBasis(),
    ...overrides,
  } as VorgangInvoice;
}

function rechnungBasis(): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0055',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-test-1',
        description: 'Montage- und Anpassungsarbeiten',
        quantity: 20,
        unit: 'Stunden',
        unitPrice: 100,
        lineTotal: 2000,
      },
    ],
    subtotal: 2000,
    taxStatus: 'standard_19',
    amount: 2380,
    status: 'vorbereitet',
    date: '2026-09-06',
    createdAt: '2026-09-06T10:00:00.000Z',
    issueDate: '2026-09-06',
    servicePeriodFrom: '2026-09-01',
    servicePeriodTo: '2026-09-05',
    servicePeriodConfirmed: true,
    paymentDueDate: '2099-09-20',
    paymentTermsText: 'Zahlbar in 14 Tagen',
    skontoText: '',
    customerSnapshot: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: '',
      street: 'Musterweg 1',
      zip: '12345',
      city: 'Beispielstadt',
      email: '',
      phone: '',
    },
    companySnapshot: {
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Beispiel Betrieb GmbH',
      street: 'Werkstraße 2',
      zip: '54321',
      city: 'Beispielstadt',
      iban: 'DE00 0000 0000 0000 0000 00',
    },
    legalNotices: [],
    previousAbschlagDeductions: [],
    baustelle: 'Teststraße 1',
    vorgangTitle: 'Testvorgang',
    paymentStatus: 'offen',
    payments: [],
  } as VorgangInvoice;
}

function offen<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Mount = { container: HTMLDivElement; root: Root };

async function ruhe(): Promise<void> {
  for (let runde = 0; runde < 12; runde += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function oeffnen(search = ''): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/vorgaenge/${VORGANG_ID}/rechnungen/${INVOICE_ID}${search}`] },
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/vorgaenge/:id/rechnungen/:invoiceId',
              element: createElement(InvoiceDetailPage),
            }),
          ),
        ),
      ),
    );
  });
  await ruhe();
  return { container, root };
}

const q = (mount: Mount, id: string) => mount.container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const lokal = () => getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;

describe('GLS01 Ausgabe — Rechnungsdetailseite', () => {
  let mount: Mount | null = null;
  let pdf: ReturnType<typeof vi.spyOn>;
  let download: ReturnType<typeof vi.spyOn>;
  let druck: ReturnType<typeof vi.spyOn>;
  let zugferd: ReturnType<typeof vi.spyOn>;
  let xrechnung: ReturnType<typeof vi.spyOn>;
  let ankerKlicks: string[];
  let cloudRead: ReturnType<typeof vi.spyOn>;

  function cloudAntwortet(...antworten: Array<ServicePeriodCloudState | Promise<ServicePeriodCloudState>>): void {
    for (const antwort of antworten) cloudRead.mockImplementationOnce(() => Promise.resolve(antwort));
  }

  beforeEach(() => {
    resetTestStores();
    localStorage.clear();
    resetServicePeriodCloudProofsForTests();
    hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID, invoices: [rechnung()] })]);
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
      rpc: async () => ({ data: null, error: { message: 'im Test nicht vorgesehen' } }),
    } as never);
    vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE);
    vi.spyOn(invoiceCloud, 'rpcGetWorkspaceInvoiceSent').mockResolvedValue({
      found: true,
      snapshot: null,
      status: 'vorbereitet',
    });
    // Ohne ausdrückliche Antwort bleibt die Cloud stumm: Der Abgleich läuft noch.
    cloudRead = vi
      .spyOn(confirmService, 'readInvoiceServicePeriodConfirmationFromCloud')
      .mockImplementation(() => new Promise<ServicePeriodCloudState>(() => {}));
    // Wie der echte Erzeuger: erst der zentrale Validator, dann die Bytes.
    pdf = vi.spyOn(invoicePdfService, 'generateApprovedInvoicePdf').mockImplementation(async (invoice) =>
      validateFinalizedInvoiceForPdf(invoice).blockingErrors.length > 0
        ? ({ ok: false, reason: 'validation_failed' } as never)
        : {
            ok: true,
            bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
            filename: 'Rechnung.pdf',
            mimeType: 'application/pdf',
            statusUnchanged: invoice.status,
          },
    );
    download = vi.spyOn(invoicePdfService, 'downloadInvoicePdfBytes').mockReturnValue({ revoke: () => {} } as never);
    druck = vi.spyOn(invoicePrintService, 'printInvoice').mockImplementation(() => {});
    vi.spyOn(zugferdService, 'readZugferdArtifact').mockResolvedValue(null);
    zugferd = vi.spyOn(zugferdService, 'ensureZugferdArtifact').mockResolvedValue({
      ok: false,
      reason: 'no_archive_document',
    } as never);
    vi.spyOn(xrechnungService, 'readXRechnungArtifact').mockResolvedValue(null);
    // Ohne Ersatz läuft der echte Dienst — mit derselben Regel wie PDF und Druck.
    xrechnung = vi.spyOn(xrechnungService, 'ensureXRechnungArtifact');
    // Jeder ausgelöste Datei-Download (Anker-Klick) wird mitgeschrieben.
    ankerKlicks = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      ankerKlicks.push(this.download);
    });
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:test', writable: true, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, writable: true, configurable: true });
  });

  afterEach(() => {
    if (mount) {
      act(() => mount!.root.unmount());
      mount.container.remove();
      mount = null;
    }
    vi.restoreAllMocks();
    localStorage.clear();
    resetServicePeriodCloudProofsForTests();
    resetTestStores();
  });

  it('A1: Mitglied, Abgleich läuft — kein PDF per ?auto=pdf, kein Druck, kein ZUGFeRD', async () => {
    alsMitglied();
    mount = await oeffnen('?auto=pdf');

    expect(pdf).not.toHaveBeenCalled();
    expect(q(mount, 'invoice-output-hold-verifying')).not.toBeNull();
    expect(q(mount, 'invoice-print')!.disabled).toBe(true);
    expect(q(mount, 'invoice-download-pdf')!.disabled).toBe(true);
    expect(q(mount, 'invoice-zugferd-action')!.disabled).toBe(true);
    expect(q(mount, 'invoice-zugferd-output-hold')).not.toBeNull();

    // Auch ein Klick am gesperrten Knopf vorbei löst nichts aus.
    await act(async () => {
      q(mount!, 'invoice-print')!.click();
      q(mount!, 'invoice-download-pdf')!.click();
      q(mount!, 'invoice-zugferd-action')!.click();
    });
    expect(druck).not.toHaveBeenCalled();
    expect(pdf).not.toHaveBeenCalled();
    expect(zugferd).not.toHaveBeenCalled();
  });

  it('A2: Mitglied — ?auto=print wartet und druckt, sobald die Cloud die Bestätigung trägt', async () => {
    alsMitglied();
    const antwort = offen<ServicePeriodCloudState>();
    cloudRead.mockImplementationOnce(() => antwort.promise);
    mount = await oeffnen('?auto=print');
    expect(druck).not.toHaveBeenCalled();

    await act(async () => antwort.resolve('confirmed'));
    await ruhe();

    expect(druck).toHaveBeenCalledTimes(1);
    expect(q(mount, 'invoice-output-hold-verifying')).toBeNull();
    expect(q(mount, 'invoice-print')!.disabled).toBe(false);
    expect(hasServicePeriodCloudProof(resolveActiveCloudWorkspaceId(), INVOICE_ID)).toBe(true);
  });

  it('A3: Mitglied — trägt die Cloud die Bestätigung nicht, wird sie zurückgenommen und nichts ausgegeben', async () => {
    alsMitglied();
    cloudAntwortet('not_confirmed');
    mount = await oeffnen('?auto=pdf');

    expect(lokal().servicePeriodConfirmed).toBe(false);
    // Der Direktaufruf erreicht nur noch die zurückgenommene Fassung, und die lehnt der Validator ab.
    for (const [invoice] of pdf.mock.calls as Array<[VorgangInvoice]>) {
      expect(invoice.servicePeriodConfirmed).not.toBe(true);
    }
    expect(download).not.toHaveBeenCalled();
    expect(q(mount, 'invoice-service-period-role-aligned')).not.toBeNull();
    expect(hasServicePeriodCloudProof(resolveActiveCloudWorkspaceId(), INVOICE_ID)).toBe(false);
  });

  it('A4: Mitglied offline — gesperrt mit Hinweis; erneut geprüft und bestätigt geht es weiter', async () => {
    alsMitglied();
    cloudAntwortet('unknown', 'confirmed');
    mount = await oeffnen('?auto=pdf');

    expect(pdf).not.toHaveBeenCalled();
    expect(q(mount, 'invoice-output-hold-unverified')).not.toBeNull();
    expect(lokal().servicePeriodConfirmed).toBe(true);

    await act(async () => q(mount!, 'invoice-output-hold-retry')!.click());
    await ruhe();

    expect(q(mount, 'invoice-output-hold-unverified')).toBeNull();
    expect(pdf).toHaveBeenCalledTimes(1);
  });

  it('A5: Mitglied offline mit früherem Nachweis aus dem Abzug — die Ausgabe bleibt möglich', async () => {
    alsMitglied();
    recordServicePeriodCloudProofs(resolveActiveCloudWorkspaceId(), [INVOICE_ID]);
    cloudAntwortet('unknown');
    mount = await oeffnen('?auto=pdf');

    expect(pdf).toHaveBeenCalledTimes(1);
    expect(q(mount, 'invoice-output-hold-unverified')).toBeNull();
    expect(q(mount, 'invoice-zugferd-action')!.disabled).toBe(false);
  });

  it('A6: Inhaber — unverändert sofort, auch während der Abgleich läuft', async () => {
    alsInhaber();
    mount = await oeffnen('?auto=pdf');

    expect(pdf).toHaveBeenCalledTimes(1);
    expect(q(mount, 'invoice-output-hold-verifying')).toBeNull();
    expect(q(mount, 'invoice-print')!.disabled).toBe(false);
    expect(q(mount, 'invoice-zugferd-action')!.disabled).toBe(false);
    // Auf dem Gerät des Inhabers wird kein Nachweis abgelegt.
    expect(hasServicePeriodCloudProof(resolveActiveCloudWorkspaceId(), INVOICE_ID)).toBe(false);
  });

  it('A7: Rolle noch unbekannt — dieselbe Wartezeit wie für ein Mitglied', async () => {
    mount = await oeffnen('?auto=print');

    expect(druck).not.toHaveBeenCalled();
    expect(q(mount, 'invoice-output-hold-verifying')).not.toBeNull();
  });

  it('A8: XRechnung — Mitglied, Abgleich läuft: gesperrt, auch ein erzwungener Klick erzeugt nichts', async () => {
    alsMitglied();
    mount = await oeffnen();

    expect(q(mount, 'invoice-xrechnung-action')!.disabled).toBe(true);
    expect(q(mount, 'invoice-xrechnung-output-hold')).not.toBeNull();
    await act(async () => q(mount!, 'invoice-xrechnung-action')!.click());
    expect(xrechnung).not.toHaveBeenCalled();
    expect(ankerKlicks).toHaveLength(0);
  });

  it('A9: XRechnung — unbestätigter Leistungszeitraum: der Dienst verweigert, es entsteht keine Datei', async () => {
    alsMitglied();
    hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID, invoices: [rechnung({ servicePeriodConfirmed: false })] })]);
    mount = await oeffnen();

    // Ohne lokale Bestätigung wartet nichts — es sperrt die Regel selbst.
    expect(q(mount, 'invoice-xrechnung-action')!.disabled).toBe(false);
    await act(async () => q(mount!, 'invoice-xrechnung-action')!.click());
    await ruhe();

    expect(xrechnung).toHaveBeenCalledTimes(1);
    expect(ankerKlicks).toHaveLength(0);
    expect(q(mount, 'invoice-xrechnung-blocked')?.textContent).toContain('Der Leistungszeitraum ist nicht bestätigt');
  });

  it('A10: XRechnung — Mitglied mit Cloud-Nachweis: wie PDF freigegeben', async () => {
    alsMitglied();
    cloudAntwortet('confirmed');
    xrechnung.mockResolvedValue({
      ok: true,
      reused: false,
      artifact: { sourceInvoiceId: INVOICE_ID, sourceInvoiceNumber: '2026-0055', fileName: 'XRechnung-2026-0055.xml', bytes: new Uint8Array([60]) },
    } as never);
    mount = await oeffnen();

    expect(q(mount, 'invoice-xrechnung-action')!.disabled).toBe(false);
    await act(async () => q(mount!, 'invoice-xrechnung-action')!.click());
    await ruhe();
    expect(ankerKlicks).toEqual(['XRechnung-2026-0055.xml']);
  });

  it('A11: XRechnung — Inhaber unverändert, auch während der Abgleich läuft', async () => {
    alsInhaber();
    xrechnung.mockResolvedValue({
      ok: true,
      reused: false,
      artifact: { sourceInvoiceId: INVOICE_ID, sourceInvoiceNumber: '2026-0055', fileName: 'XRechnung-2026-0055.xml', bytes: new Uint8Array([60]) },
    } as never);
    mount = await oeffnen();

    expect(q(mount, 'invoice-xrechnung-output-hold')).toBeNull();
    await act(async () => q(mount!, 'invoice-xrechnung-action')!.click());
    await ruhe();
    expect(ankerKlicks).toEqual(['XRechnung-2026-0055.xml']);
  });

  it('A12: Inhaber, unbestätigter Altbeleg — XRechnung und ZUGFeRD nennen den Grund, wie das PDF', async () => {
    alsInhaber();
    // Der echte ZUGFeRD-Dienst statt der Vorgabe aus beforeEach.
    zugferd.mockRestore();
    zugferd = vi.spyOn(zugferdService, 'ensureZugferdArtifact');
    const alt = rechnung();
    delete alt.servicePeriodConfirmed;
    hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID, invoices: [alt] })]);
    mount = await oeffnen();

    await act(async () => q(mount!, 'invoice-xrechnung-action')!.click());
    await act(async () => q(mount!, 'invoice-zugferd-action')!.click());
    await ruhe();

    expect(ankerKlicks).toHaveLength(0);
    expect(q(mount, 'invoice-xrechnung-blocked')?.textContent).toContain('Der Leistungszeitraum ist nicht bestätigt');
    expect(q(mount, 'invoice-zugferd-blocked')?.textContent).toContain('Der Leistungszeitraum ist nicht bestätigt');
    // Der Weg, das zu ändern, steht darüber: Inhaber dürfen bestätigen.
    expect(q(mount, 'invoice-confirm-service-period')).not.toBeNull();
  });
});
