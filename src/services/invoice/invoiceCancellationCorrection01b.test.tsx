/**
 * NORMAL-INVOICE-CANCELLATION-01B — Storno normaler Rechnungen und Korrekturbeleg.
 *
 * Domain-Modell, Merge, lokale Anwendung, Archivprojektion, Dienst gegen
 * einen ersetzten Cloud-Client, Dokument-Pull und die sichtbare Seite.
 * Neutrale Beispieldaten, kein Netzwerk. Die reale SQL-Semantik steht in
 * `supabase/tests/invoice_cancellation_correction_01b.sql`.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from '../../context/AppContext';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { InvoiceDetailPage } from '../../pages/InvoiceDetailPage';
import { InvoiceDocumentView } from '../../components/invoice/InvoiceDocumentView';
import { expectedCancellationKind } from '../../components/invoice/InvoiceCancelDialog';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import * as supabaseLib from '../../lib/supabase';
import {
  applyFinalizedInvoiceToList,
  applyInvoiceCancellationFromCloud,
  getVorgangInvoice,
  hydrateVorgangStore,
  resolveInvoiceCancellationFacts,
  updateInvoiceCorrectionArchiveDocumentId,
} from '../vorgangService';
import { getInvoiceStoreSnapshot, hydrateInvoiceStore } from './invoiceStore';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import {
  commitDocumentStoreMerge,
  getDocumentById,
  getDocumentByLinkedInvoiceId,
  getDocumentStoreSnapshot,
  deleteDocument,
} from '../documentService';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import { buildInvoiceCorrectionModel, negateMoney } from './invoiceCorrectionModel';
import {
  buildInvoiceCorrectionDocumentFromCloudRow,
  projectInvoiceCorrectionDocument,
} from './invoiceCorrectionArchive';
import { archiveInvoiceCorrectionLocally, cancelFinalizedInvoice } from './invoiceCancellationService';
import {
  buildCorrectionArchiveDocumentIdByInvoice,
  mergeCloudDocuments,
  reconcileArchiveDocumentLinks,
  reconcileArchiveLinksOnInvoices,
} from '../document/documentCloudPullOrchestrator';
import { pullDocumentsFromCloud, type WorkspaceDocumentRow } from '../document/workspaceDocumentCloudService';
import { mapWorkspaceInvoicePullRowToVorgangInvoice, parseWorkspaceInvoicePullRow } from './workspaceInvoiceCloudService';
import { generateInvoiceCorrectionPdf } from '../invoicePdfService';
import { archiveOutgoingInvoice } from '../invoiceArchiveService';
import { calculatePaymentSummary, recordPayment } from '../invoicePaymentService';
import { getBilledQuantity, isBillingEffective } from '../orderBillingRules';
import { findInvoiceLocatorById } from './invoiceRegistryService';
import type { CompanyDocument, Vorgang, VorgangInvoice } from '../../types/models';

const WORKSPACE = '00000000-0000-4000-8000-00000000c01b';
const VORGANG_ID = 'v-c01b';
const ORDER_ID = 'inv-order-c01b';
const FREE_ID = 'inv-free-c01b';
const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };

const CUSTOMER = {
  name: 'Beispiel Projektbau GmbH',
  contactPerson: '',
  street: 'Beispielweg 1',
  zip: '10000',
  city: 'Beispielstadt',
  email: '',
  phone: '',
};

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: FREE_ID,
    number: '2026-0201',
    invoiceSequenceNumber: 201,
    type: 'rechnung',
    positions: [
      { id: 'l1', description: 'Anfahrt', quantity: 1, unit: 'Pauschal', unitPrice: 45, lineTotal: 45 },
      { id: 'l2', description: 'Monteurstunden', quantity: 2.5, unit: 'Std', unitPrice: 58.33, lineTotal: 145.83 },
    ],
    subtotal: 190.83,
    taxStatus: 'standard_19',
    amount: 227.09,
    status: 'versendet',
    sentAt: '2026-09-02',
    sentVia: 'email',
    date: '2026-09-01',
    issueDate: '2026-09-01',
    createdAt: '2026-09-01T10:00:00.000Z',
    servicePeriodFrom: '2026-08-20',
    servicePeriodTo: '2026-08-28',
    servicePeriodConfirmed: true,
    paymentDueDate: '2099-12-31',
    paymentTermsText: '14 Tage netto',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerId: 'cust-c01b',
    customerSnapshot: CUSTOMER,
    companySnapshot: {
      ...DEFAULT_COMPANY_PROFILE,
      companyName: 'Muster GmbH',
      street: 'Musterstraße 3',
      zip: '20000',
      city: 'Musterstadt',
    },
    ...overrides,
  } as VorgangInvoice;
}

function orderInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return invoice({
    id: ORDER_ID,
    number: '2026-0200',
    invoiceSequenceNumber: 200,
    vorgangTitle: 'Dachsanierung Beispiel',
    baustelle: 'Beispielweg 1',
    positions: [
      { id: 'l1', orderPositionId: 'op-1', description: 'Dach', quantity: 40, unit: 'm²', unitPrice: 10, lineTotal: 400 },
    ],
    subtotal: 400,
    amount: 476,
    ...overrides,
  });
}

function seed(options: { free?: VorgangInvoice | null; order?: VorgangInvoice | null } = {}): void {
  const free = options.free === undefined ? invoice() : options.free;
  const order = options.order === undefined ? orderInvoice() : options.order;
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG_ID,
        title: 'Dachsanierung Beispiel',
        status: 'beauftragt',
        customer: 'Beispiel Projektbau GmbH',
        orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 100, unitPrice: 10 })],
      }),
      invoices: order ? [order] : [],
    } as Vorgang,
  ]);
  if (free) hydrateInvoiceStore([...getInvoiceStoreSnapshot(), { invoice: free, vorgangId: null }]);
  hydrateWorkspaceStore({
    workspace: {
      id: WORKSPACE,
      name: 'Beispielbetrieb',
      ownerUserId: 'user-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    },
  });
}

function cloudRow(inv: VorgangInvoice, vorgangId: string | null, extra: Record<string, unknown> = {}) {
  const { payments: _p, paymentStatus: _s, archiveDocumentId: _a, ...payload } = inv;
  return {
    id: `cloud-${inv.id}`,
    workspace_id: WORKSPACE,
    vorgang_id: vorgangId,
    client_invoice_id: inv.id,
    invoice_number: inv.number,
    invoice_year: 2026,
    invoice_sequence_number: inv.invoiceSequenceNumber ?? 1,
    invoice_type: inv.type,
    invoice_status: inv.status,
    payload,
    row_version: 2,
    created_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-05T10:00:00.000Z',
    cancelled_at: null,
    cancelled_by: null,
    cancel_reason: null,
    cancellation_kind: null,
    correction_document_id: null,
    correction_number: null,
    ...extra,
  };
}

function cancelledRow(inv: VorgangInvoice, vorgangId: string | null, kind: 'internal' | 'correction', reason = 'Leistung nicht erbracht') {
  return cloudRow(inv, vorgangId, {
    cancelled_at: '2026-09-05T10:00:00.000Z',
    cancelled_by: 'user-1',
    cancel_reason: reason,
    cancellation_kind: kind,
    correction_document_id: kind === 'correction' ? `corr-${inv.id}` : null,
    payload: { ...cloudRow(inv, vorgangId).payload, cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: reason },
  });
}

function correctionDocRow(inv: VorgangInvoice, vorgangId: string | null): WorkspaceDocumentRow {
  return {
    workspaceId: WORKSPACE,
    clientDocumentId: `corr-${inv.id}`,
    documentKind: 'generated_invoice_correction',
    linkedInvoiceId: inv.id,
    linkedVorgangId: vorgangId ?? undefined,
    payload: {
      id: `corr-${inv.id}`,
      documentType: 'rechnungskorrektur',
      correctionKind: 'storno',
      category: 'ausgangsrechnung',
      classifiedKind: 'rechnungskorrektur',
      archived: true,
      title: `Rechnungskorrektur zu Rechnung ${inv.number}`,
      issuer: 'Muster GmbH',
      linkedInvoiceId: inv.id,
      linkedVorgangId: vorgangId,
      originalClientInvoiceId: inv.id,
      originalInvoiceNumber: inv.number,
      originalInvoiceType: inv.type,
      originalIssueDate: inv.issueDate,
      cancelledAt: '2026-09-05T10:00:00.000Z',
      correctionIssueDate: '2026-09-05',
      cancelReason: 'Leistung nicht erbracht',
      customerId: inv.customerId,
      companySnapshot: inv.companySnapshot,
      customerSnapshot: inv.customerSnapshot,
      taxStatus: inv.taxStatus,
      originalInvoiceSnapshot: { ...inv },
    },
    createdAt: '2026-09-05T10:00:00.000Z',
    updatedAt: '2026-09-05T10:00:00.000Z',
    rowVersion: 1,
  };
}

function installClient(handler: (name: string, args: Record<string, unknown>) => unknown): string[] {
  const calls: string[] = [];
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue({
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      const result = handler(name, args);
      if (result instanceof Error) return { data: null, error: { message: result.message } };
      return { data: result, error: null };
    },
  } as never);
  return calls;
}

/* --------------------------- Seite --------------------------- */

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location" data-path={location.pathname} data-search={location.search} />;
}
function ToastProbe() {
  const { toast } = useApp();
  return <div data-testid="toast-probe">{toast ?? ''}</div>;
}
interface PageMount { container: HTMLDivElement; root: Root }
function renderAt(path: string, element: ReactElement = <InvoiceDetailPage />): PageMount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <AppProvider initialSetup={setupComplete}>
          <Routes>
            <Route path="/vorgaenge/:id/rechnungen/:invoiceId" element={element} />
            <Route path="/rechnungen/offen" element={<div data-testid="page-offen" />} />
            <Route path="/rechnungen/:invoiceId" element={element} />
            <Route path="/dokumente/:id" element={<div data-testid="page-dokument" />} />
          </Routes>
          <LocationProbe />
          <ToastProbe />
        </AppProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}
function q(m: PageMount, id: string): HTMLElement | null {
  return m.container.querySelector(`[data-testid="${id}"]`);
}
async function typeReason(m: PageMount, text: string): Promise<void> {
  const field = q(m, 'invoice-cancel-reason-input') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(field, text);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submitCancel(m: PageMount): Promise<void> {
  const form = q(m, 'invoice-cancel-dialog') as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
  await settle();
}

describe('NORMAL-INVOICE-CANCELLATION-01B', () => {
  let mounted: PageMount | null = null;

  beforeEach(() => {
    resetTestStores();
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(null);
    seed();
  });
  afterEach(() => {
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = null;
    }
    vi.restoreAllMocks();
    resetTestStores();
  });

  /* ---------------- F — Domain-Modell ---------------- */

  it('F1: das Korrekturmodell ist das Originalmodell mit Gegenzeichen — betragsgenau, ohne eigene Rundung', () => {
    const original = buildInvoicePrintModelFromInvoice(invoice());
    const correction = buildInvoiceCorrectionModel(invoice(), { cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'Leistung nicht erbracht' });
    expect(correction.documentTitle).toBe('Rechnungskorrektur');
    expect(correction.issueDate).toBe('2026-09-05');
    expect(correction.correction).toEqual({
      originalInvoiceNumber: '2026-0201',
      originalIssueDate: '2026-09-01',
      originalInvoiceId: FREE_ID,
      correctionIssueDate: '2026-09-05',
      cancelledAt: '2026-09-05T10:00:00.000Z',
      cancelReason: 'Leistung nicht erbracht',
    });
    expect(correction.summary.subtotalNet).toBe(-original.summary.subtotalNet);
    expect(correction.summary.taxAmount).toBe(-original.summary.taxAmount);
    expect(correction.summary.grossTotal).toBe(-original.summary.grossTotal);
    expect(correction.summary.amountDue).toBe(-original.summary.amountDue);
    expect(correction.summary.taxRate).toBe(original.summary.taxRate);
    expect(correction.positions.map((p) => p.lineTotal)).toEqual(original.positions.map((p) => -p.lineTotal));
    expect(correction.positions.map((p) => p.quantity)).toEqual([-1, -2.5]);
    expect(correction.positions.map((p) => p.unitPrice)).toEqual(original.positions.map((p) => p.unitPrice));
    // Rundung: 190,83 * 19 % = 36,26 → exakt negiert, kein -0.
    expect(correction.summary.taxAmount).toBe(-36.26);
    expect(Object.is(negateMoney(0), 0)).toBe(true);
    expect(negateMoney(0)).toBe(0);
    expect(correction.customer).toEqual(original.customer);
    expect(correction.company).toEqual(original.company);
    expect(correction.paymentDueDate).toBe('');
    expect(correction.introText).toContain('2026-0201');
  });

  it('F2: Reverse Charge — keine Steuer erfunden, Hinweise des Originals bleiben', () => {
    const rc = invoice({ taxStatus: 'null_13b', amount: 190.83, legalNotices: ['Steuerschuldnerschaft des Leistungsempfängers (§ 13b UStG)'] });
    const original = buildInvoicePrintModelFromInvoice(rc);
    const correction = buildInvoiceCorrectionModel(rc, { cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'x' });
    expect(original.summary.taxAmount).toBe(0);
    expect(correction.summary.taxAmount).toBe(0);
    expect(correction.summary.grossTotal).toBe(-190.83);
    expect(correction.taxStatus).toBe('null_13b');
    expect(correction.taxNotices).toEqual(original.taxNotices);
  });

  it('F3: Schlussrechnung mit Abschlagsabzug — Abzüge und fälliger Betrag negiert, Original unverändert', () => {
    const schluss = orderInvoice({
      id: 'inv-schluss', type: 'schluss',
      previousAbschlagDeductions: [{ invoiceId: 'inv-ab', invoiceNumber: '2026-0150', abschlagNumber: 1, amount: 119 }],
    } as Partial<VorgangInvoice>);
    const original = buildInvoicePrintModelFromInvoice(schluss);
    const correction = buildInvoiceCorrectionModel(schluss, { cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'x' });
    expect(correction.summary.deductionsTotal).toBe(-original.summary.deductionsTotal);
    expect(correction.summary.amountDue).toBe(-original.summary.amountDue);
    expect(correction.summary.deductionLines[0]!.amount).toBe(-119);
    expect(buildInvoicePrintModelFromInvoice(schluss)).toEqual(original);
  });

  it('L1: der Korrekturbeleg rendert Bezug, Grund und Titel; ein Originalmodell bleibt ohne Korrekturblock', () => {
    const correction = buildInvoiceCorrectionModel(invoice(), { cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'Leistung nicht erbracht' });
    const html = renderToStaticMarkup(
      <MemoryRouter><AppProvider initialSetup={setupComplete}><InvoiceDocumentView model={correction} /></AppProvider></MemoryRouter>,
    );
    expect(html).toContain('invoice-correction-block');
    expect(html).toContain('Rechnung 2026-0201 vom');
    expect(html).toContain('Leistung nicht erbracht');
    expect(html).toContain('Zu Rechnung Nr.');
    expect(html).not.toContain('Zahlungsinformationen');
    const originalHtml = renderToStaticMarkup(
      <MemoryRouter><AppProvider initialSetup={setupComplete}><InvoiceDocumentView model={buildInvoicePrintModelFromInvoice(invoice())} /></AppProvider></MemoryRouter>,
    );
    expect(originalHtml).not.toContain('invoice-correction-block');
    expect(originalHtml).toContain('Zahlungsinformationen');
  });

  it('L2: das Korrektur-PDF entsteht aus derselben Engine — nur für eine Korrektur', async () => {
    const notCorrected = await generateInvoiceCorrectionPdf(invoice());
    expect(notCorrected.ok).toBe(false);
    const corrected = invoice({ cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'x', cancellationKind: 'correction', correctionDocumentId: `corr-${FREE_ID}` });
    const pdf = await generateInvoiceCorrectionPdf(corrected);
    expect(pdf.ok, JSON.stringify(pdf)).toBe(true);
    if (!pdf.ok) return;
    expect(pdf.filename).toContain('Rechnungskorrektur');
    expect(String.fromCharCode(...pdf.bytes.slice(0, 5))).toBe('%PDF-');
  }, 30_000);

  /* ---------------- H/I — Parser und monotoner Merge ---------------- */

  it('H1: der Pull-Parser liest cancellationKind, correctionDocumentId und correctionNumber', () => {
    const parsed = parseWorkspaceInvoicePullRow(cancelledRow(invoice(), null, 'correction'))!;
    const mapped = mapWorkspaceInvoicePullRowToVorgangInvoice(parsed);
    expect(mapped.invoice.cancelledAt).toBe('2026-09-05T10:00:00.000Z');
    expect(mapped.invoice.cancellationKind).toBe('correction');
    expect(mapped.invoice.correctionDocumentId).toBe(`corr-${FREE_ID}`);
    expect(mapped.invoice.correctionNumber).toBeUndefined();
    const legacy = mapWorkspaceInvoicePullRowToVorgangInvoice(parseWorkspaceInvoicePullRow(cloudRow(invoice(), null))!);
    expect(legacy.invoice.cancellationKind).toBeUndefined();
  });

  it('I1: Cloud-Storno ergänzt eine lokal nicht stornierte Rechnung (Cross-Device-Defekt behoben) — für Vorgang und frei', () => {
    const remote = mapWorkspaceInvoicePullRowToVorgangInvoice(parseWorkspaceInvoicePullRow(cancelledRow(invoice(), null, 'correction'))!).invoice;
    const applied = applyFinalizedInvoiceToList([invoice()], remote, null);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.action).toBe('status_raised');
    expect(applied.invoice.cancelledAt).toBe('2026-09-05T10:00:00.000Z');
    expect(applied.invoice.cancelReason).toBe('Leistung nicht erbracht');
    expect(applied.invoice.cancellationKind).toBe('correction');
    expect(applied.invoice.correctionDocumentId).toBe(`corr-${FREE_ID}`);

    const remoteOrder = mapWorkspaceInvoicePullRowToVorgangInvoice(parseWorkspaceInvoicePullRow(cancelledRow(orderInvoice(), VORGANG_ID, 'internal'))!).invoice;
    const appliedOrder = applyFinalizedInvoiceToList([orderInvoice()], remoteOrder, VORGANG_ID);
    expect(appliedOrder.ok && appliedOrder.invoice.cancellationKind).toBe('internal');
  });

  it('I2: ein lokal bekanntes Storno wird nie still entfernt; gleiche Fakten sind noop; 01C-Storno bekommt Art nachgefüllt', () => {
    const local = invoice({ cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'Leistung nicht erbracht' });
    const remotePlain = mapWorkspaceInvoicePullRowToVorgangInvoice(parseWorkspaceInvoicePullRow(cloudRow(invoice(), null))!).invoice;
    const kept = applyFinalizedInvoiceToList([local], remotePlain, null);
    expect(kept.ok && kept.action).toBe('noop');
    expect(kept.ok && kept.invoice.cancelledAt).toBe('2026-09-05T10:00:00.000Z');

    const remoteSame = mapWorkspaceInvoicePullRowToVorgangInvoice(parseWorkspaceInvoicePullRow(cancelledRow(invoice(), null, 'correction'))!).invoice;
    const filled = applyFinalizedInvoiceToList([local], remoteSame, null);
    expect(filled.ok && filled.action).toBe('status_raised');
    expect(filled.ok && filled.invoice.cancellationKind).toBe('correction');
    const again = applyFinalizedInvoiceToList(filled.ok ? filled.invoices : [], remoteSame, null);
    expect(again.ok && again.action).toBe('noop');
  });

  it('I3: widersprechende Stornowahrheit → cancellation_conflict, kein local/remote wins', () => {
    const local = invoice({ cancelledAt: '2026-09-04T10:00:00.000Z', cancelReason: 'Anderer Grund', cancellationKind: 'internal' });
    const remote = mapWorkspaceInvoicePullRowToVorgangInvoice(parseWorkspaceInvoicePullRow(cancelledRow(invoice(), null, 'correction'))!).invoice;
    const result = applyFinalizedInvoiceToList([local], remote, null);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('cancellation_conflict');
    expect(resolveInvoiceCancellationFacts(local, remote)).toEqual({ ok: false, reason: 'cancellation_conflict' });
  });

  /* ---------------- J — lokale Anwendung ---------------- */

  it('J1: applyInvoiceCancellationFromCloud schreibt für null in den First-Class-Speicher und für den Vorgang in den Vorgang', () => {
    const free = applyInvoiceCancellationFromCloud(null, FREE_ID, { cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'x', cancellationKind: 'correction', correctionDocumentId: `corr-${FREE_ID}` });
    expect(free.ok && free.action).toBe('cancelled');
    expect(getVorgangInvoice(null, FREE_ID)!.cancellationKind).toBe('correction');
    expect(findInvoiceLocatorById(FREE_ID)?.vorgangId).toBeNull();

    const order = applyInvoiceCancellationFromCloud(VORGANG_ID, ORDER_ID, { cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'x', cancellationKind: 'internal' });
    expect(order.ok && order.action).toBe('cancelled');
    expect(getVorgangInvoice(VORGANG_ID, ORDER_ID)!.cancellationKind).toBe('internal');

    // Replay: noop, nichts überschrieben.
    const replay = applyInvoiceCancellationFromCloud(null, FREE_ID, { cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'x', cancellationKind: 'correction', correctionDocumentId: `corr-${FREE_ID}` });
    expect(replay.ok && replay.action).toBe('noop');
    const conflict = applyInvoiceCancellationFromCloud(null, FREE_ID, { cancelledAt: '2026-09-06T10:00:00.000Z', cancelReason: 'y' });
    expect(!conflict.ok && conflict.reason).toBe('cancellation_conflict');
    expect(getVorgangInvoice(null, FREE_ID)!.cancelReason).toBe('x');
  });

  /* ---------------- G/K — Dokumentidentität und Archiv ---------------- */

  it('G1: Original-Archivdokument und Korrekturbeleg bestehen nebeneinander und werden getrennt aufgelöst', () => {
    const archived = archiveOutgoingInvoice(null, invoice(), 'Muster GmbH');
    expect(archived.success).toBe(true);
    const corrected = invoice({ cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'Leistung nicht erbracht', cancellationKind: 'correction', correctionDocumentId: `corr-${FREE_ID}` });
    hydrateInvoiceStore([{ invoice: { ...corrected, archiveDocumentId: archived.success ? archived.document.id : undefined }, vorgangId: null }]);

    const first = archiveInvoiceCorrectionLocally(null, getVorgangInvoice(null, FREE_ID)!);
    expect(first.ok).toBe(true);
    const second = archiveInvoiceCorrectionLocally(null, getVorgangInvoice(null, FREE_ID)!);
    expect(second.ok && first.ok && second.documentId).toBe(first.ok ? first.documentId : '');

    const original = getDocumentByLinkedInvoiceId(FREE_ID);
    const correction = getDocumentByLinkedInvoiceId(FREE_ID, 'correction');
    expect(original?.classifiedKind).toBe('ausgangsrechnung');
    expect(correction?.classifiedKind).toBe('rechnungskorrektur');
    expect(correction?.id).toBe(`corr-${FREE_ID}`);
    expect(correction?.linkedVorgang).toBeNull();
    expect(correction?.digitalFolder.path).toBe('/Ausgangsrechnungen/');
    expect(getDocumentStoreSnapshot().filter((d) => d.linkedInvoiceId === FREE_ID)).toHaveLength(2);

    const stored = getVorgangInvoice(null, FREE_ID)!;
    expect(stored.archiveDocumentId).toBe(original!.id);
    expect(stored.correctionArchiveDocumentId).toBe(correction!.id);
    // Der Korrekturbeleg ist nicht löschbar.
    expect(deleteDocument(correction!.id).success).toBe(false);
    expect(getDocumentById(correction!.id)).toBeDefined();
  });

  it('K1: der Pull erzeugt den Korrekturbeleg lokal, ersetzt kein Original und verdoppelt bei Replay nichts', () => {
    const archived = archiveOutgoingInvoice(VORGANG_ID, orderInvoice(), 'Muster GmbH');
    expect(archived.success).toBe(true);
    const local = getDocumentStoreSnapshot();
    const rows = [correctionDocRow(orderInvoice(), VORGANG_ID)];
    const merged = mergeCloudDocuments(local, rows);
    expect(merged.filter((d) => d.linkedInvoiceId === ORDER_ID)).toHaveLength(2);
    const correction = merged.find((d) => d.id === `corr-${ORDER_ID}`)!;
    expect(correction.classifiedKind).toBe('rechnungskorrektur');
    expect(correction.linkedVorgang).toEqual({ vorgangId: VORGANG_ID, vorgangTitle: 'Dachsanierung Beispiel' });
    expect(correction.digitalFolder.path).toBe('/Vorgänge/Dachsanierung Beispiel/Ausgangsrechnungen/');
    const originalId = archived.success ? archived.document.id : '';
    expect(merged.find((d) => d.id === originalId)).toBeDefined();
    const again = mergeCloudDocuments(merged, rows);
    expect(again.filter((d) => d.linkedInvoiceId === ORDER_ID)).toHaveLength(2);

    const byCorrection = buildCorrectionArchiveDocumentIdByInvoice(again);
    expect(byCorrection.get(ORDER_ID)).toBe(`corr-${ORDER_ID}`);
    const reconciled = reconcileArchiveLinksOnInvoices([orderInvoice()], new Map(), byCorrection);
    expect(reconciled.invoices[0]!.correctionArchiveDocumentId).toBe(`corr-${ORDER_ID}`);
    expect(reconciled.invoices[0]!.archiveDocumentId).toBeUndefined();
  });

  it('K2: reconcileArchiveDocumentLinks heilt den Korrekturlink aus dem Dokumentbestand — frei und Vorgang', () => {
    commitDocumentStoreMerge([
      buildInvoiceCorrectionDocumentFromCloudRow(correctionDocRow(invoice(), null))!,
      buildInvoiceCorrectionDocumentFromCloudRow(correctionDocRow(orderInvoice(), VORGANG_ID))!,
    ]);
    const relinked = reconcileArchiveDocumentLinks();
    expect(relinked).toBe(2);
    expect(getVorgangInvoice(null, FREE_ID)!.correctionArchiveDocumentId).toBe(`corr-${FREE_ID}`);
    expect(getVorgangInvoice(VORGANG_ID, ORDER_ID)!.correctionArchiveDocumentId).toBe(`corr-${ORDER_ID}`);
    expect(getVorgangInvoice(null, FREE_ID)!.archiveDocumentId).toBeUndefined();
  });

  it('K3: die Cloud-Projektion und die lokale Projektion ergeben denselben Beleg', () => {
    const corrected = invoice({ cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'Leistung nicht erbracht', cancellationKind: 'correction', correctionDocumentId: `corr-${FREE_ID}` });
    const fromCloud = buildInvoiceCorrectionDocumentFromCloudRow(correctionDocRow(invoice(), null))!;
    const local = projectInvoiceCorrectionDocument(corrected, null)!;
    const strip = (d: CompanyDocument) => { const { sync: _s, createdAt: _c, ...rest } = d; return rest; };
    expect(strip(local)).toEqual(strip(fromCloud));
  });

  it('H2: pullDocumentsFromCloud liefert beide Dokumentarten', async () => {
    installClient((name) => {
      if (name === 'pull_workspace_documents') {
        return [
          { ...correctionDocRow(invoice(), null), workspace_id: WORKSPACE, client_document_id: `corr-${FREE_ID}`, document_kind: 'generated_invoice_correction', linked_invoice_id: FREE_ID, linked_vorgang_id: null, created_at: '2026-09-05T10:00:00.000Z', updated_at: '2026-09-05T10:00:00.000Z', row_version: 1, deleted_at: null },
          { workspace_id: WORKSPACE, client_document_id: 'doc-x', document_kind: 'generated_invoice', linked_invoice_id: FREE_ID, linked_vorgang_id: null, payload: { title: 'x', digitalFolder: {}, paperFolder: {} }, created_at: '2026-09-05T10:00:00.000Z', updated_at: '2026-09-05T10:00:00.000Z', row_version: 1, deleted_at: null },
          { workspace_id: WORKSPACE, client_document_id: 'doc-y', document_kind: 'something_else', linked_invoice_id: FREE_ID, payload: {}, created_at: '2026-09-05T10:00:00.000Z', updated_at: '2026-09-05T10:00:00.000Z', row_version: 1, deleted_at: null },
        ];
      }
      return null;
    });
    const pulled = await pullDocumentsFromCloud();
    expect(pulled.outcome).toBe('synced');
    expect(pulled.outcome === 'synced' && pulled.rows.map((r) => r.documentKind).sort()).toEqual(['generated_invoice', 'generated_invoice_correction']);
  });

  /* ---------------- Dienst gegen ersetzten Client ---------------- */

  it('S1: internes Storno der vorbereiteten freien Rechnung — kein Dokument, Original unverändert', async () => {
    seed({ free: invoice({ status: 'vorbereitet', sentAt: undefined, sentVia: undefined }) });
    const before = getVorgangInvoice(null, FREE_ID)!;
    installClient((name) => name === 'cancel_workspace_invoice' ? [cancelledRow(before, null, 'internal', 'Falscher Kunde')] : null);
    const result = await cancelFinalizedInvoice({ vorgangId: null, invoiceId: FREE_ID, reason: 'Falscher Kunde' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.action).toBe('cancelled');
    expect(result.correctionArchiveDocumentId).toBeUndefined();
    const after = getVorgangInvoice(null, FREE_ID)!;
    expect(after.cancellationKind).toBe('internal');
    expect(after.correctionDocumentId).toBeUndefined();
    expect(getDocumentByLinkedInvoiceId(FREE_ID, 'correction')).toBeUndefined();
    expect({ ...after, cancelledAt: undefined, cancelReason: undefined, cancellationKind: undefined }).toEqual({ ...before, cancelledAt: undefined, cancelReason: undefined, cancellationKind: undefined });
    expect(calculatePaymentSummary(after).openAmount).toBe(0);
    expect(calculatePaymentSummary(after).status).toBe('storniert');
  });

  it('S2: Korrektur der versendeten Vorgangsrechnung — Beleg projiziert, verlinkt, Original bleibt; Billing frei', async () => {
    const before = getVorgangInvoice(VORGANG_ID, ORDER_ID)!;
    installClient((name) => name === 'cancel_workspace_invoice' ? [cancelledRow(before, VORGANG_ID, 'correction')] : null);
    const vorgangBefore = createTestVorgang({ id: VORGANG_ID, orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 100, unitPrice: 10 })], invoices: [before] });
    expect(getBilledQuantity(vorgangBefore as Vorgang, 'op-1')).toBe(40);

    const result = await cancelFinalizedInvoice({ vorgangId: VORGANG_ID, invoiceId: ORDER_ID, reason: 'Leistung nicht erbracht' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.correctionArchiveDocumentId).toBe(`corr-${ORDER_ID}`);
    const after = getVorgangInvoice(VORGANG_ID, ORDER_ID)!;
    expect(after.cancellationKind).toBe('correction');
    expect(after.correctionDocumentId).toBe(`corr-${ORDER_ID}`);
    expect(after.correctionArchiveDocumentId).toBe(`corr-${ORDER_ID}`);
    expect(after.positions).toEqual(before.positions);
    expect(after.number).toBe(before.number);
    expect(after.status).toBe('versendet');
    expect(isBillingEffective(after)).toBe(false);
    const doc = getDocumentByLinkedInvoiceId(ORDER_ID, 'correction')!;
    expect(doc.linkedVorgang?.vorgangId).toBe(VORGANG_ID);
    expect(doc.title).toContain('2026-0200');
    // Vorgangsmengen: die stornierte Rechnung zählt nicht mehr.
    const vorgangAfter = { ...vorgangBefore, invoices: [after] } as Vorgang;
    expect(getBilledQuantity(vorgangAfter, 'op-1')).toBe(0);
  });

  it('S3: Korrektur ohne correction_document_id → fail closed, lokal nichts storniert', async () => {
    const before = getVorgangInvoice(null, FREE_ID)!;
    installClient((name) => name === 'cancel_workspace_invoice' ? [cancelledRow(before, null, 'correction', 'x')].map((r) => ({ ...r, correction_document_id: null })) : null);
    const result = await cancelFinalizedInvoice({ vorgangId: null, invoiceId: FREE_ID, reason: 'x' });
    expect(!result.ok && result.reason).toBe('correction_document_missing');
    expect(getVorgangInvoice(null, FREE_ID)!.cancelledAt).toBeUndefined();
    expect(getDocumentByLinkedInvoiceId(FREE_ID, 'correction')).toBeUndefined();
  });

  it('S4: Replay mit anderem Grund — already_cancelled, erster Grund bleibt, kein zweiter Beleg', async () => {
    const before = getVorgangInvoice(null, FREE_ID)!;
    const calls = installClient((name) => name === 'cancel_workspace_invoice' ? [cancelledRow(before, null, 'correction', 'Erster Grund')] : null);
    const first = await cancelFinalizedInvoice({ vorgangId: null, invoiceId: FREE_ID, reason: 'Erster Grund' });
    expect(first.ok && first.action).toBe('cancelled');
    const second = await cancelFinalizedInvoice({ vorgangId: null, invoiceId: FREE_ID, reason: 'Zweiter Grund' });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.action).toBe('already_cancelled');
    expect(second.reasonDiffers).toBe(true);
    expect(second.cancelReason).toBe('Erster Grund');
    expect(getVorgangInvoice(null, FREE_ID)!.cancelReason).toBe('Erster Grund');
    expect(getDocumentStoreSnapshot().filter((d) => d.linkedInvoiceId === FREE_ID && d.classifiedKind === 'rechnungskorrektur')).toHaveLength(1);
    expect(calls.filter((c) => c === 'cancel_workspace_invoice')).toHaveLength(2);
  });

  it('S5: Serverfehler bleiben fail-closed — aktive Zahlung, Abschlag, Entwurf', async () => {
    const before = getVorgangInvoice(null, FREE_ID)!;
    let message = 'invoice_cancel_has_active_payments';
    installClient((name) => name === 'cancel_workspace_invoice' ? new Error(message) : null);
    expect(await cancelFinalizedInvoice({ vorgangId: null, invoiceId: FREE_ID, reason: 'x' })).toMatchObject({ ok: false, reason: 'has_active_payments' });
    message = 'invoice_cancel_type_not_supported';
    expect(await cancelFinalizedInvoice({ vorgangId: null, invoiceId: FREE_ID, reason: 'x' })).toMatchObject({ ok: false, reason: 'type_not_supported' });
    message = 'invoice_cancel_not_finalized';
    expect(await cancelFinalizedInvoice({ vorgangId: null, invoiceId: FREE_ID, reason: 'x' })).toMatchObject({ ok: false, reason: 'not_finalized' });
    expect(getVorgangInvoice(null, FREE_ID)).toEqual(before);
    expect(await cancelFinalizedInvoice({ vorgangId: null, invoiceId: FREE_ID, reason: '   ' })).toMatchObject({ ok: false, reason: 'reason_required' });
  });

  it('S6: lokaler Persistenzfehler nach Cloud-Erfolg → local_persist_failed, kein halber Zustand', async () => {
    const before = getVorgangInvoice(null, FREE_ID)!;
    installClient((name) => name === 'cancel_workspace_invoice' ? [cancelledRow(before, null, 'correction')] : null);
    const persistence = await import('../persistenceService');
    const spy = vi.spyOn(persistence, 'persistAll').mockReturnValue({ success: false, reason: 'quota' } as never);
    const result = await cancelFinalizedInvoice({ vorgangId: null, invoiceId: FREE_ID, reason: 'x' });
    spy.mockRestore();
    expect(!result.ok && result.reason).toBe('local_persist_failed');
    expect(getVorgangInvoice(null, FREE_ID)!.cancelledAt).toBeUndefined();
  });

  /* ---------------- P — Zahlungen ---------------- */

  it('P1: nach dem Storno ist keine Zahlung mehr erfassbar; vorhandene Historie bleibt', () => {
    expect(recordPayment(null, FREE_ID, { date: '2026-09-02', amount: 27.09 }).success).toBe(true);
    const applied = applyInvoiceCancellationFromCloud(null, FREE_ID, { cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'x', cancellationKind: 'correction', correctionDocumentId: `corr-${FREE_ID}` });
    expect(applied.ok).toBe(true);
    const after = getVorgangInvoice(null, FREE_ID)!;
    expect(after.payments).toHaveLength(1);
    expect(recordPayment(null, FREE_ID, { date: '2026-09-06', amount: 10 }).success).toBe(false);
    const summary = calculatePaymentSummary(after);
    expect(summary.status).toBe('storniert');
    expect(summary.openAmount).toBe(0);
    expect(summary.paidAmount).toBe(27.09);
  });

  /* ---------------- M — Seite und Dialog ---------------- */

  it('M1: die versendete freie Rechnung bietet das Storno an; der Dialog kündigt den Korrekturbeleg an', async () => {
    mounted = renderAt(`/rechnungen/${FREE_ID}`);
    await settle();
    const action = q(mounted, 'invoice-cancel-action')!;
    expect(action).not.toBeNull();
    act(() => action.click());
    expect(q(mounted, 'invoice-cancel-dialog')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Rechnung stornieren');
    expect(mounted.container.textContent).not.toContain('Schlussrechnung stornieren');
    expect(q(mounted, 'invoice-cancel-kind-correction')).not.toBeNull();
    expect(q(mounted, 'invoice-cancel-kind-internal')).toBeNull();
    expect(expectedCancellationKind(invoice())).toBe('correction');
    expect(expectedCancellationKind(invoice({ status: 'vorbereitet' }))).toBe('internal');
  });

  it('M2: vorbereitet → interner Hinweis; Abschlag → keine Aktion; aktive Zahlung → Blocker', async () => {
    seed({ free: invoice({ status: 'vorbereitet', sentAt: undefined, sentVia: undefined }) });
    mounted = renderAt(`/rechnungen/${FREE_ID}`);
    await settle();
    act(() => q(mounted!, 'invoice-cancel-action')!.click());
    expect(q(mounted, 'invoice-cancel-kind-internal')).not.toBeNull();
    act(() => mounted!.root.unmount());
    mounted.container.remove();

    seed({ order: orderInvoice({ type: 'abschlag', abschlagNumber: 1 } as Partial<VorgangInvoice>) });
    mounted = renderAt(`/vorgaenge/${VORGANG_ID}/rechnungen/${ORDER_ID}`);
    await settle();
    expect(q(mounted, 'invoice-cancel-action')).toBeNull();
    act(() => mounted!.root.unmount());
    mounted.container.remove();

    seed({ free: invoice({ payments: [{ id: 'pay-1', date: '2026-09-02', amount: 50, createdAt: '2026-09-02T00:00:00.000Z' }], paymentStatus: 'teilbezahlt' }) });
    mounted = renderAt(`/rechnungen/${FREE_ID}`);
    await settle();
    act(() => q(mounted!, 'invoice-cancel-action')!.click());
    expect(q(mounted, 'invoice-cancel-payment-block')).not.toBeNull();
    expect((q(mounted, 'invoice-cancel-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('M3: Storno auf der Seite: Panel mit Art, Datum, Grund und „Korrekturbeleg öffnen"; Korrekturansicht druckt und führt zurück', async () => {
    const before = getVorgangInvoice(null, FREE_ID)!;
    installClient((name) => name === 'cancel_workspace_invoice' ? [cancelledRow(before, null, 'correction')] : null);
    mounted = renderAt(`/rechnungen/${FREE_ID}`);
    await settle();
    act(() => q(mounted!, 'invoice-cancel-action')!.click());
    await typeReason(mounted, 'Leistung nicht erbracht');
    await submitCancel(mounted);

    expect(q(mounted, 'invoice-cancelled-panel')).not.toBeNull();
    expect(q(mounted, 'invoice-cancelled-kind-correction')).not.toBeNull();
    expect(q(mounted, 'invoice-cancelled-at')?.textContent).toContain('2026-09-05');
    expect(q(mounted, 'invoice-cancelled-reason')?.textContent).toContain('Leistung nicht erbracht');
    expect(q(mounted, 'invoice-cancel-action')).toBeNull();
    expect(q(mounted, 'invoice-correction-archive-pending')).toBeNull();
    // Original weiterhin druckbar und sichtbar.
    expect(q(mounted, 'invoice-print')).not.toBeNull();
    expect(q(mounted, 'invoice-print-document')).not.toBeNull();

    act(() => q(mounted!, 'invoice-open-correction')!.click());
    await settle();
    expect(q(mounted, 'location')?.getAttribute('data-search')).toBe('?doc=korrektur');
    expect(q(mounted, 'invoice-correction-page')).not.toBeNull();
    expect(q(mounted, 'invoice-correction-block')).not.toBeNull();
    expect(q(mounted, 'invoice-correction-reference')?.textContent).toContain('2026-0201');
    expect(q(mounted, 'invoice-print')).not.toBeNull();
    expect(q(mounted, 'invoice-download-pdf')).not.toBeNull();
    expect(q(mounted, 'invoice-correction-archive-link')?.getAttribute('href')).toBe(`/dokumente/corr-${FREE_ID}`);
    expect(mounted.container.textContent).toContain('-227,09');
    // Keine Zahlungs-/Storno-Aktionen in der Korrekturansicht.
    expect(q(mounted, 'invoice-cancel-action')).toBeNull();
    expect(mounted.container.textContent).not.toContain('Zahlung erfassen');

    act(() => q(mounted!, 'invoice-correction-back')!.click());
    await settle();
    expect(q(mounted, 'location')?.getAttribute('data-path')).toBe(`/rechnungen/${FREE_ID}`);
    expect(q(mounted, 'invoice-detail-page')).not.toBeNull();
  });

  it('M4: Korrekturansicht ohne Korrektur → sauberer Hinweis, Zurück zum Original', async () => {
    mounted = renderAt(`/rechnungen/${FREE_ID}?doc=korrektur`);
    await settle();
    expect(q(mounted, 'invoice-correction-not-found')).not.toBeNull();
    expect(q(mounted, 'invoice-correction-page')).toBeNull();
  });

  it('M5: Vorgangsrechnung über die alte Route — Storno-Panel und Korrekturansicht auf dem Vorgangsweg', async () => {
    seed({ order: orderInvoice({ cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'x', cancellationKind: 'correction', correctionDocumentId: `corr-${ORDER_ID}` }) });
    expect(updateInvoiceCorrectionArchiveDocumentId(VORGANG_ID, ORDER_ID, `corr-${ORDER_ID}`).ok).toBe(true);
    mounted = renderAt(`/vorgaenge/${VORGANG_ID}/rechnungen/${ORDER_ID}`);
    await settle();
    expect(q(mounted, 'invoice-cancelled-kind-correction')).not.toBeNull();
    act(() => q(mounted!, 'invoice-open-correction')!.click());
    await settle();
    expect(q(mounted, 'location')?.getAttribute('data-path')).toBe(`/vorgaenge/${VORGANG_ID}/rechnungen/${ORDER_ID}`);
    expect(q(mounted, 'invoice-correction-page')).not.toBeNull();
    expect(mounted.container.textContent).toContain('Dachsanierung Beispiel');
  });

  it('M6: 01C-Storno ohne Art zeigt weiterhin Datum und Grund — keine Korrekturaktion, kein Fehler', async () => {
    seed({ order: orderInvoice({ type: 'schluss', cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'alt' }) });
    mounted = renderAt(`/vorgaenge/${VORGANG_ID}/rechnungen/${ORDER_ID}`);
    await settle();
    expect(q(mounted, 'invoice-cancelled-panel')).not.toBeNull();
    expect(q(mounted, 'invoice-open-correction')).toBeNull();
    expect(q(mounted, 'invoice-cancel-action')).toBeNull();
  });
});
