/**
 * MANUAL-INVOICE-01B2c — die Rechnung ohne Auftrag als vollwertiger Beleg.
 *
 * 01B1/01B2/01B2b haben Modell, lokalen Lebenszyklus und Cloud-Vertrag
 * geöffnet. Hier geht es um alles, was danach kommt: Archiv, Bestand,
 * Zahlungen, Druckmodell, Pull-Abgleich. Die freie Rechnung muss überall
 * dort erscheinen, wo eine normale Rechnung erscheint — ohne dass irgendwo
 * ein Vorgang erfunden wird.
 *
 * Neutrale Beispieldaten, kein Netzwerk, keine Cloud.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { InvoiceProjectBlock } from '../../components/invoice/InvoiceProjectBlock';
import { archiveOutgoingInvoice } from '../invoiceArchiveService';
import { getAllDocuments, getDocumentByLinkedInvoiceId } from '../documentService';
import {
  getAllInvoiceOverview,
  hasVorgangRoute,
  summarizeInvoiceOverview,
} from '../invoiceOverviewService';
import { buildInvoiceReachPath } from '../invoiceNavigation';
import { recordPayment, removePayment } from '../invoicePaymentService';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import {
  buildManualInvoiceDraft,
  buildManualInvoicePosition,
  finalizeInvoiceDraft,
} from '../invoiceService';
import { getKundenOverview } from '../kundenOverviewService';
import { updateCompanyProfile } from '../companyProfileService';
import {
  getVorgangInvoice,
  hydrateVorgangStore,
  updateInvoiceArchiveDocumentId,
  upsertFinalizedManualInvoice,
} from '../vorgangService';
import {
  buildArchiveDocumentIdByInvoice,
  reconcileArchiveLinksOnInvoices,
} from '../document/documentCloudPullOrchestrator';
import { buildInvoiceEntriesAfterPull } from '../sync/supabaseSyncAdapter';
import { findInvoiceLocatorById } from './invoiceRegistryService';
import { getInvoiceStoreSnapshot, hydrateInvoiceStore, resetInvoiceStore } from './invoiceStore';
import { resetInvoiceNumberSequence } from '../invoiceNumberService';
import { createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { DEFAULT_SETUP } from '../../data/mockData';
import type { CompanySetup, VorgangInvoice } from '../../types/models';

const YEAR = 2026;

const CUSTOMER = {
  name: 'Müller Bau GmbH',
  contactPerson: '',
  street: 'Hauptstraße 12',
  zip: '45356',
  city: 'Essen',
  email: '',
  phone: '',
};

const SETUP: CompanySetup = {
  ...DEFAULT_SETUP,
  companyName: 'Cirmak Haustechnik GmbH',
  street: 'Ruhrallee 5',
  zip: '45138',
  city: 'Essen',
  setupComplete: true,
};

/** Eine freigegebene, versendete freie Rechnung über 53,55 € brutto. */
function freeInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-free-1',
    number: `${YEAR}-0012`,
    invoiceSequenceNumber: 12,
    type: 'rechnung',
    positions: [
      { id: 'line-1', description: 'Anfahrt', quantity: 1, unit: 'Pauschal', unitPrice: 45, lineTotal: 45 },
    ],
    subtotal: 45,
    taxStatus: 'standard_19',
    amount: 53.55,
    status: 'versendet',
    sentAt: `${YEAR}-05-05T09:00:00.000Z`,
    sentVia: 'email',
    date: `${YEAR}-05-04`,
    issueDate: `${YEAR}-05-04`,
    createdAt: `${YEAR}-05-04T09:00:00.000Z`,
    servicePeriodFrom: `${YEAR}-05-01`,
    servicePeriodTo: `${YEAR}-05-01`,
    paymentDueDate: `${YEAR}-05-18`,
    paymentTermsText: '14 Tage netto',
    skontoText: '',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: CUSTOMER,
    companySnapshot: SETUP,
    ...overrides,
  } as unknown as VorgangInvoice;
}

function orderInvoice(): VorgangInvoice {
  return freeInvoice({
    id: 'inv-order-1',
    number: `${YEAR}-0011`,
    invoiceSequenceNumber: 11,
    vorgangTitle: 'Dachsanierung Müller',
    baustelle: 'Hauptstraße 12',
  } as Partial<VorgangInvoice>);
}

describe('MANUAL-INVOICE-01B2c — Rechnung ohne Auftrag im Produkt', () => {
  beforeEach(() => {
    resetTestStores();
    resetInvoiceStore();
    resetInvoiceNumberSequence();
    hydrateVorgangStore([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  /* ------------------------------------------------------------------ */
  /* A — Archiv                                                          */
  /* ------------------------------------------------------------------ */

  it('A1: die freie Rechnung archiviert ihr Dokument ohne Vorgang', () => {
    expect(upsertFinalizedManualInvoice(freeInvoice()).ok).toBe(true);

    const result = archiveOutgoingInvoice(null, freeInvoice(), SETUP.companyName);

    expect(result.success, `Archivieren scheiterte: ${JSON.stringify(result)}`).toBe(true);
    if (!result.success) return;
    expect(result.created).toBe(true);
    expect(result.document.linkedInvoiceId).toBe('inv-free-1');
    expect(result.document.linkedVorgang, 'Ein Vorgang wurde erfunden').toBeNull();
    expect(result.document.category).toBe('ausgangsrechnung');
    expect(result.document.digitalFolder.path).toBe('/Ausgangsrechnungen/');
    expect(result.document.digitalFolder.path).not.toContain('undefined');
    expect(result.document.tags).not.toContain('undefined');
    expect(result.document.recognizedText).not.toContain('Vorgang:');
    // Der Link steht auf der gespeicherten Rechnung, nicht nur im Rückgabewert.
    expect(findInvoiceLocatorById('inv-free-1')!.invoice.archiveDocumentId).toBe(result.document.id);
    expect(findInvoiceLocatorById('inv-free-1')!.vorgangId).toBeNull();
  });

  it('A2: ein zweiter Archivlauf erzeugt kein zweites Dokument', () => {
    expect(upsertFinalizedManualInvoice(freeInvoice()).ok).toBe(true);
    const first = archiveOutgoingInvoice(null, freeInvoice(), SETUP.companyName);
    expect(first.success).toBe(true);

    const second = archiveOutgoingInvoice(
      null,
      findInvoiceLocatorById('inv-free-1')!.invoice,
      SETUP.companyName,
    );
    expect(second.success).toBe(true);
    if (!second.success || !first.success) return;
    expect(second.created).toBe(false);
    expect(second.document.id).toBe(first.document.id);
    expect(getAllDocuments().filter((d) => d.linkedInvoiceId === 'inv-free-1')).toHaveLength(1);
  });

  it('A3: ein Persistenzfehler beim Verknüpfen wird gemeldet, nicht verschluckt', () => {
    expect(upsertFinalizedManualInvoice(freeInvoice()).ok).toBe(true);
    const before = getInvoiceStoreSnapshot();
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    const linked = updateInvoiceArchiveDocumentId(null, 'inv-free-1', 'doc-x');

    expect(linked.ok).toBe(false);
    if (!linked.ok) expect(linked.reason).toBe('persist_failed');
    expect(getInvoiceStoreSnapshot()).toEqual(before);
  });

  it('A4: eine auftragsgebundene Kennung wird über den freien Pfad nicht verknüpft', () => {
    hydrateInvoiceStore([{ invoice: orderInvoice(), vorgangId: 'v-1' }]);
    const linked = updateInvoiceArchiveDocumentId(null, 'inv-order-1', 'doc-x');
    expect(linked.ok).toBe(false);
    if (!linked.ok) expect(linked.reason).toBe('not_found');
  });

  it('A5: der Pull-Abgleich stellt den Archiv-Link einer freien Rechnung wieder her', () => {
    expect(upsertFinalizedManualInvoice(freeInvoice()).ok).toBe(true);
    const archived = archiveOutgoingInvoice(null, freeInvoice(), SETUP.companyName);
    expect(archived.success).toBe(true);
    if (!archived.success) return;

    // Frisches Gerät: Rechnung ohne Link, Dokument aus der Cloud.
    const byInvoice = buildArchiveDocumentIdByInvoice(getAllDocuments());
    const reconciled = reconcileArchiveLinksOnInvoices([freeInvoice()], byInvoice);
    expect(reconciled.changed).toBe(1);
    expect(reconciled.invoices[0]!.archiveDocumentId).toBe(archived.document.id);

    // Und ohne aktives Dokument wird ein toter Link entfernt.
    const cleared = reconcileArchiveLinksOnInvoices(
      [freeInvoice({ archiveDocumentId: 'doc-weg' })],
      new Map(),
    );
    expect(cleared.invoices[0]!.archiveDocumentId).toBeUndefined();
  });

  /* ------------------------------------------------------------------ */
  /* B — Bestand / Auffindbarkeit                                        */
  /* ------------------------------------------------------------------ */

  it('B1: die freie Rechnung steht im globalen Rechnungsbestand und zählt in den Summen', () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-1', title: 'Dachsanierung Müller' })]);
    hydrateInvoiceStore([
      { invoice: orderInvoice(), vorgangId: 'v-1' },
      { invoice: freeInvoice(), vorgangId: null },
    ]);

    const overview = getAllInvoiceOverview(`${YEAR}-05-10`);
    const frei = overview.find((item) => item.invoice.id === 'inv-free-1');
    expect(frei, 'Die freie Rechnung fehlt in der Übersicht').toBeDefined();
    expect(frei!.vorgangId).toBeNull();
    expect(frei!.vorgangTitle).toBe('');
    expect(frei!.customer).toBe(CUSTOMER.name);
    expect(frei!.paymentSummary.status).toBe('offen');

    const totals = summarizeInvoiceOverview(overview);
    expect(totals.totalInvoiceCount).toBe(2);
    expect(totals.openReceivables).toBeCloseTo(53.55 * 2, 2);
  });

  it('B2: ohne Auftrag führt der Weg auf die globale Detailroute (01B2) — nie nach /vorgaenge/null', () => {
    expect(buildInvoiceReachPath(null, 'inv-free-1')).toBe('/rechnungen/inv-free-1');
    expect(buildInvoiceReachPath('v-1', 'inv-order-1')).toBe('/vorgaenge/v-1/rechnungen/inv-order-1');
    expect(buildInvoiceReachPath(null, 'inv-free-1')).not.toContain('null');
  });

  it('B3: hasVorgangRoute trennt sauber', () => {
    hydrateInvoiceStore([{ invoice: freeInvoice(), vorgangId: null }]);
    const [frei] = getAllInvoiceOverview();
    expect(hasVorgangRoute(frei!)).toBe(false);
  });

  it('B4: die Detailauflösung über die Rechnungskennung findet die freie Rechnung', () => {
    hydrateInvoiceStore([{ invoice: freeInvoice(), vorgangId: null }]);
    expect(getVorgangInvoice(null, 'inv-free-1')?.number).toBe(`${YEAR}-0012`);
    expect(getVorgangInvoice('v-1', 'inv-free-1')).toBeUndefined();
  });

  /* ------------------------------------------------------------------ */
  /* C — Kundenhistorie (Grenze)                                         */
  /* ------------------------------------------------------------------ */

  it('C1: die freie Rechnung wird keinem Kunden über den Namen zugeordnet', () => {
    /*
     * Die Rechnung trägt per Regel keine customerId (invoiceCustomerIdentity01);
     * die Kundenhistorie ordnet strikt über den Vorgang. Ohne Vorgang gibt es
     * keine Zuordnung — und ausdrücklich keine über den Namen. Das ist der
     * STOPP-Punkt dieses Blocks, hier als Grenze festgehalten.
     */
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-1', title: 'Dachsanierung', customer: CUSTOMER.name }),
    ]);
    hydrateInvoiceStore([{ invoice: freeInvoice(), vorgangId: null }]);

    const kunden = getKundenOverview();
    const mueller = kunden.find((k) => k.name === CUSTOMER.name);
    expect(mueller?.openInvoiceCount ?? 0, 'Namenszuordnung fand statt').toBe(0);
  });

  /* ------------------------------------------------------------------ */
  /* D — Zahlungen                                                       */
  /* ------------------------------------------------------------------ */

  it('D1: die freie Rechnung nimmt eine Zahlung entgegen und wird bezahlt', () => {
    hydrateInvoiceStore([{ invoice: freeInvoice(), vorgangId: null }]);

    const result = recordPayment(null, 'inv-free-1', { amount: 53.55, date: `${YEAR}-05-10` });

    expect(result.success, `Zahlung scheiterte: ${JSON.stringify(result)}`).toBe(true);
    if (!result.success) return;
    expect(result.invoice.paymentStatus).toBe('bezahlt');
    expect(findInvoiceLocatorById('inv-free-1')!.invoice.payments).toHaveLength(1);
    expect(findInvoiceLocatorById('inv-free-1')!.vorgangId).toBeNull();
    // Historisch weiterhin auffindbar, jetzt als bezahlt.
    const item = getAllInvoiceOverview(`${YEAR}-05-11`).find((i) => i.invoice.id === 'inv-free-1');
    expect(item?.paymentSummary.status).toBe('bezahlt');
  });

  it('D2: eine Teilzahlung führt zu teilbezahlt mit korrektem Restbetrag', () => {
    /*
     * `recordPayment` leitet den Status auf das echte Heute ab; ein
     * überschrittenes Zahlungsziel gewinnt fachlich über „teilbezahlt". Damit
     * hier die Teilzahlung selbst sichtbar ist, liegt das Ziel in der Zukunft.
     */
    hydrateInvoiceStore([
      { invoice: freeInvoice({ paymentDueDate: '2999-12-31' } as Partial<VorgangInvoice>), vorgangId: null },
    ]);

    const result = recordPayment(null, 'inv-free-1', { amount: 20, date: `${YEAR}-05-10` });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.invoice.paymentStatus).toBe('teilbezahlt');
    const item = getAllInvoiceOverview(`${YEAR}-05-11`).find((i) => i.invoice.id === 'inv-free-1')!;
    expect(item.paymentSummary.openAmount).toBeCloseTo(33.55, 2);

    // Rücknahme geht denselben Weg.
    const removed = removePayment(null, 'inv-free-1', result.payment.id);
    expect(removed.success).toBe(true);
    expect(findInvoiceLocatorById('inv-free-1')!.invoice.payments).toHaveLength(0);
  });

  it('D3: Confirm-first bleibt — eine unversendete freie Rechnung braucht die Bestätigung', () => {
    hydrateInvoiceStore([
      { invoice: freeInvoice({ status: 'vorbereitet', sentAt: undefined, sentVia: undefined } as Partial<VorgangInvoice>), vorgangId: null },
    ]);
    const blocked = recordPayment(null, 'inv-free-1', { amount: 10, date: `${YEAR}-05-10` });
    expect(blocked.success).toBe(false);
    if (!blocked.success) expect(blocked.errorKey).toBe('payment.unsentConfirmationRequired');
  });

  it('D4: ein Persistenzfehler bei der Zahlung lässt die Rechnung unverändert', () => {
    hydrateInvoiceStore([{ invoice: freeInvoice(), vorgangId: null }]);
    const before = getInvoiceStoreSnapshot();
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    const result = recordPayment(null, 'inv-free-1', { amount: 10, date: `${YEAR}-05-10` });
    expect(result.success).toBe(false);
    expect(getInvoiceStoreSnapshot()).toEqual(before);
  });

  it('D5: Zahlungen überleben den Pull-Endzustand', () => {
    const paid = freeInvoice({
      payments: [{ id: 'pay-1', date: `${YEAR}-05-10`, amount: 53.55, createdAt: `${YEAR}-05-10T10:00:00.000Z` }],
      paymentStatus: 'bezahlt',
    } as Partial<VorgangInvoice>);
    const entries = buildInvoiceEntriesAfterPull([], [], [paid]);
    expect(entries[0]!.invoice.payments).toHaveLength(1);
    expect(entries[0]!.vorgangId).toBeNull();
  });

  /* ------------------------------------------------------------------ */
  /* E — Druckmodell                                                     */
  /* ------------------------------------------------------------------ */

  it('E1: ohne Auftrag gibt es keine Projektzeile — keinen Platzhalter', () => {
    const model = buildInvoicePrintModelFromInvoice(freeInvoice());
    expect(model.projectTitle).toBe('');
    expect(model.projectTitle).not.toBe('—');
    const html = renderToStaticMarkup(createElement(InvoiceProjectBlock, { model }));
    expect(html, 'Der Bauvorhaben-Block wurde trotzdem gerendert').toBe('');
  });

  it('E2: mit Auftrag bleibt die Projektinformation wie bisher', () => {
    const model = buildInvoicePrintModelFromInvoice(orderInvoice());
    expect(model.projectTitle).toBe('Dachsanierung Müller');
    const html = renderToStaticMarkup(createElement(InvoiceProjectBlock, { model }));
    expect(html).toContain('Bauvorhaben');
    expect(html).toContain('Dachsanierung Müller');
    expect(html).toContain('Hauptstraße 12');
  });

  it('E3: die übrigen Rechnungsinhalte sind unverändert', () => {
    const frei = buildInvoicePrintModelFromInvoice(freeInvoice());
    const auftrag = buildInvoicePrintModelFromInvoice(orderInvoice());
    expect(frei.grossTotal).toBe(auftrag.grossTotal);
    expect(frei.customer).toEqual(auftrag.customer);
    expect(frei.positions).toHaveLength(1);
  });

  /* ------------------------------------------------------------------ */
  /* F — lokale Finalisierung / Typregel                                 */
  /* ------------------------------------------------------------------ */

  it('F1: der lokale Finalize-Weg trägt die freie Rechnung inklusive Archiv', () => {
    // Das Firmenprofil kommt aus dem Profil-Store, nicht aus dem Setup.
    const profile = updateCompanyProfile({
      companyName: SETUP.companyName,
      street: 'Ruhrallee 5',
      zip: '45138',
      city: 'Essen',
    });
    expect(profile.success).toBe(true);
    const draft = buildManualInvoiceDraft({ billing: CUSTOMER }, SETUP);
    draft.positions = [
      buildManualInvoicePosition({ description: 'Anfahrt', quantity: 1, unit: 'Pauschal', unitPrice: 45 }),
    ];
    draft.servicePeriodFrom = `${YEAR}-05-01`;
    draft.servicePeriodTo = `${YEAR}-05-01`;
    // Confirm-first: die Bestätigung ist eine Nutzerhandlung am Entwurf.
    draft.servicePeriodConfirmed = true;

    const result = finalizeInvoiceDraft(null, draft, SETUP);

    expect(result.ok, `Finalize scheiterte: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return;
    const stored = findInvoiceLocatorById(result.invoice.id);
    expect(stored?.vorgangId).toBeNull();
    expect(stored?.invoice.archiveDocumentId, 'Kein Archivdokument').toBeDefined();
    expect(getDocumentByLinkedInvoiceId(result.invoice.id)?.linkedVorgang).toBeNull();
  });

  it('F2: Abschlag und Schluss ohne Auftrag bleiben lokal unzulässig', () => {
    for (const type of ['abschlag', 'schluss'] as const) {
      const draft = { ...buildManualInvoiceDraft({ billing: CUSTOMER }, SETUP), type };
      const result = finalizeInvoiceDraft(null, draft, SETUP);
      expect(result.ok, `${type} ohne Vorgang wurde finalisiert`).toBe(false);
      if (!result.ok) expect(result.reason).toBe('vorgang_missing');
    }
    expect(getInvoiceStoreSnapshot()).toHaveLength(0);
  });
});
