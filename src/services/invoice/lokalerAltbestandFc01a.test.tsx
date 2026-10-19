/**
 * FC01A-P1-Restkorrektur (lokaler Altbestand) — ein fehlendes Rechnungsnetto wird nie durch das
 * Brutto ersetzt.
 *
 * WEISS-Endrecheck zu Bericht 14: Ein lokal gespeicherter Pauschalabschlag (400,00 netto als
 * Pauschalnetto, 476,00 brutto, 19 %, 2 % Skonto, Zahlung 466,48) ohne `subtotal` bekam bei der
 * Hydratisierung `subtotal = amount`. Der echte Nachdruck zeigte „476,00 netto + 90,44 USt =
 * 566,44 fällig“, der Steuerberaterexport „476,00 / 0,00 / 476,00“.
 *
 *  H   Hydratisierung: das fehlende Netto bleibt fehlend, die Rechnung unverändert.
 *  W   WEISS' Kette (Hydratisierung → echtes PDF → Export → E-Rechnung): 400 / 76 / 476.
 *  U   Nicht sicher ermittelbar: kein PDF, keine E-Rechnung, Export leer mit Hinweis, Anzeige mit
 *      Berichtigungsweg; nichts wird gespeichert oder geändert.
 *  G   Gegenproben: 7 %, § 19, § 13b, steuerfrei, unklar, Skonto, Teilzahlung, Rundung,
 *      widersprüchliche Altdaten, Schlussrechnung mit Abzug, Abrechnungsgrenzen, heutiger Bestand.
 *
 * PDF-Prüfungen lesen die erzeugten PDF-Bytes mit pdf.js (kein Zeichenspion). Mit
 * `FC01A_ALTBESTAND_OUT=<Ordner>` werden PDF, Text und Exportzeilen als Beleg abgelegt.
 * Neutrale Beispieldaten.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvoiceNetUnresolvedError, resolveInvoiceNet } from './invoiceNetResolution';
import { buildCanonicalEInvoice } from '../einvoice/canonicalEInvoiceBuilder';
import { renderXRechnungCii } from '../einvoice/xrechnungCiiRenderer';
import { buildZugferdInvoice } from '../einvoice/zugferd/zugferdArtifactService';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import { generateApprovedInvoicePdf, generateInvoiceCorrectionPdf } from '../invoicePdfService';
import { hasUnreliableAbschlagNet, validateFinalizedInvoiceForPdf } from '../invoiceValidationService';
import { getPreviousAbschlagDeductions } from '../invoiceService';
import { getCurrentBillableOrderNetCents, getRemainingFixedAmountBillableNetCents } from '../orderBillingRules';
import { summarizeOrderFinancials } from '../order/orderFinancialsService';
import { buildMonatsmappeModel, buildUebersichtCsv, NET_UNRESOLVED_HINT } from '../steuerberater/monatsmappeModelService';
import { buildMonatsmappeZip } from '../steuerberater/monatsmappeExportService';
import { buildBookingExport } from '../accounting/accountingBookingExportService';
import { buildPeriodCanonicalText, buildPeriodManifest } from '../accounting/accountingPeriodFingerprint';
import { getVorgangById, hydrateVorgangStore } from '../vorgangService';
import { getInvoiceStoreSnapshot } from './invoiceStore';
import { buildPersistedStateSnapshot } from '../persistenceService';
import { AppProvider } from '../../context/AppContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { InvoiceDetailPage } from '../../pages/InvoiceDetailPage';
import * as supabaseLib from '../../lib/supabase';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { alsInhaber } from '../../test/workspaceRoleTestUtils';
import { de } from '../../i18n';
import type { AbschlagDeduction, CompanyProfile, CustomerBilling, VorgangInvoice, VorgangInvoiceLine } from '../../types/models';

// Echte PDF-Erzeugung samt eingebetteter Schrift braucht im ersten Lauf länger als die 5-s-Grenze.
vi.setConfig({ testTimeout: 30_000 });

const SKONTO = '2 % Skonto bei Zahlung innerhalb von 10 Tagen';
const RC_HINWEIS = 'Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.';
const KU_HINWEIS = 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.';
const VORGANG = 'v-lok-alt';

/* ------------------------------------------------------------------ Belege (wie altformatNettoFc01aP1) */
const SELLER = {
  companyName: 'Cirmak Haustechnik',
  legalForm: 'GmbH',
  street: 'Ruhrallee 5',
  zip: '45138',
  city: 'Essen',
  country: 'Deutschland',
  countryCode: 'DE',
  contactPerson: 'Herr Cirmak',
  phone: '0201 999999',
  email: 'buero@cirmak.invalid',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE111111111',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'WELADED1ESN',
  accountHolder: 'Cirmak Haustechnik GmbH',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
  defaultSkonto: '',
  invoiceFooterNotes: '',
} as unknown as CompanyProfile;

const BUYER: CustomerBilling = {
  name: 'AZ Testbau GmbH',
  contactPerson: 'Frau Meier',
  street: 'Industriestrasse 12',
  zip: '33602',
  city: 'Bielefeld',
  email: 'buero@az-testbau.invalid',
  phone: '0521 4711',
  countryCode: 'DE',
  vatId: 'DE987654321',
  buyerReference: 'TEST-BUYER-REF-A',
};

function line(o: Partial<VorgangInvoiceLine> = {}): VorgangInvoiceLine {
  return { id: 'p1', description: 'Wartung', quantity: 10, unit: 'Stunden', unitPrice: 100, lineTotal: 1000, ...o } as VorgangInvoiceLine;
}

function beleg(o: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-lok',
    number: '2026-0091',
    type: 'rechnung',
    positions: [line()],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    date: '2026-08-01',
    createdAt: '2026-08-01T08:00:00.000Z',
    issueDate: '2026-08-01',
    servicePeriodFrom: '2026-07-01',
    servicePeriodTo: '2026-07-31',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-08-15',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    skontoText: '',
    currencyCode: 'EUR',
    customerSnapshot: { ...BUYER },
    companySnapshot: { ...SELLER },
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...o,
  } as unknown as VorgangInvoice;
}

function zahlung(id: string, amount: number, date: string) {
  return { id, amount, date, createdAt: `${date}T09:00:00.000Z` };
}

/** Ein lokaler Altbeleg: das Netto fehlt (kein `subtotal`-Schlüssel), alles andere eingefroren. */
function ohneNetto(invoice: VorgangInvoice): VorgangInvoice {
  const { subtotal: _subtotal, ...rest } = invoice;
  return rest as VorgangInvoice;
}

/** WEISS' Nachstellung: Pauschalabschlag 400 netto / 476 brutto, 19 %, Skonto, Zahlung 466,48. */
function weissAltabschlag(o: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return ohneNetto(
    beleg({
      id: 'weiss-local-alt',
      number: 'WEISS-ALT',
      type: 'abschlag',
      abschlagNumber: 1,
      calculationMode: 'fixed_amount',
      fixedAmountNet: 400,
      positions: [],
      amount: 476,
      skontoText: SKONTO,
      payments: [zahlung('p-weiss', 466.48, '2026-08-05')],
      ...o,
    }),
  );
}

/** Derselbe Altabschlag ohne Pauschalnetto und ohne Positionen: das Netto ist nicht ermittelbar. */
function ungeklaerterAbschlag(o: Partial<VorgangInvoice> = {}): VorgangInvoice {
  const { calculationMode: _mode, fixedAmountNet: _net, ...rest } = weissAltabschlag({ id: 'alt-ungeklaert', number: 'ALT-U', ...o });
  return rest as VorgangInvoice;
}

/** Tatsächlich über `hydrateVorgangStore` und `getVorgangById` laden — wie die Anwendung. */
function hydriert(raw: VorgangInvoice, extra: VorgangInvoice[] = []): VorgangInvoice {
  hydrateVorgangStore([
    createTestVorgang({
      id: VORGANG,
      orderPositions: [createOrderPosition({ id: 'op-1', plannedQuantity: 10, unitPrice: 100 })],
      invoices: [raw, ...extra],
    }),
  ]);
  return getVorgangById(VORGANG)!.invoices.find((invoice) => invoice.id === raw.id)!;
}

function exportModel(invoices: VorgangInvoice[], monthKey = '2026-08') {
  return buildMonatsmappeModel({
    monthKey,
    invoices: invoices.map((invoice) => ({ invoice, vorgangId: VORGANG })),
    expenses: [],
    documents: [],
    inboxItems: [],
    fileRefs: [],
  });
}

const OUT = process.env.FC01A_ALTBESTAND_OUT;
function beleg_ablegen(name: string, inhalt: string | Uint8Array): void {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), inhalt);
}

/** Der Text der erzeugten PDF-Datei, gelesen mit pdf.js aus den Bytes. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true, verbosity: 0, useWorkerFetch: false }).promise;
  try {
    const parts: string[] = [];
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const content = await (await pdf.getPage(index)).getTextContent();
      for (const item of content.items) if ('str' in item && item.str.trim()) parts.push(item.str);
    }
    return parts.join('\n');
  } finally {
    await pdf.destroy();
  }
}

async function echtesPdf(invoice: VorgangInvoice, name: string): Promise<string> {
  const result = await generateApprovedInvoicePdf(invoice);
  if (!result.ok) throw new Error(`PDF nicht erzeugt: ${result.reason}`);
  const text = await pdfText(result.bytes);
  beleg_ablegen(`${name}.pdf`, result.bytes);
  beleg_ablegen(`${name}.txt`, text);
  return text;
}

beforeEach(() => {
  resetTestStores();
  alsInhaber();
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
  vi.spyOn(supabaseLib, 'getSupabaseClient').mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ================================================================== H — Hydratisierung */
describe('H — ein fehlendes Netto bleibt fehlend', () => {
  it('H1: hydrateVorgangStore ersetzt das Netto nicht durch das Brutto; Betrag und Pauschalnetto bleiben', () => {
    const geladen = hydriert(weissAltabschlag());
    expect(geladen.subtotal).toBeUndefined();
    expect(geladen.amount).toBe(476);
    expect(geladen.fixedAmountNet).toBe(400);
    // Auch der gespeicherte Stand trägt kein erfundenes Netto.
    const gespeichert = getInvoiceStoreSnapshot().find((entry) => entry.invoice.id === 'weiss-local-alt');
    expect(gespeichert).toBeDefined();
    expect(gespeichert!.invoice.amount).toBe(476);
    expect('subtotal' in gespeichert!.invoice && gespeichert!.invoice.subtotal !== undefined).toBe(false);
    const persistiert = JSON.parse(JSON.stringify(buildPersistedStateSnapshot())) as { invoiceEntries: Array<{ invoice: VorgangInvoice }> };
    const eintrag = persistiert.invoiceEntries.find((entry) => entry.invoice.id === 'weiss-local-alt');
    expect(eintrag).toBeDefined();
    expect(eintrag!.invoice).not.toHaveProperty('subtotal');
  });

  it('H2: die Auflösung nimmt das eingefrorene Pauschalnetto, weil es genau den Betrag ergibt', () => {
    expect(resolveInvoiceNet(hydriert(weissAltabschlag()))).toEqual({ ok: true, netCents: 40000, source: 'fixed_amount' });
  });
});

/* ================================================================== W — WEISS' Kette */
describe('W — WEISS: Hydratisierung → echtes PDF → Export → E-Rechnung', () => {
  it('W1: das echte PDF zeigt 400,00 netto, 76,00 USt, 476,00 brutto und fällig — nie 566,44', async () => {
    const text = await echtesPdf(hydriert(weissAltabschlag()), 'W1-weiss-altabschlag');
    expect(text).toContain('Zwischensumme netto: 400,00 €');
    expect(text).toContain('Umsatzsteuer (19 %): 76,00 €');
    expect(text).toContain('Bruttosumme: 476,00 €');
    expect(text).toContain('Fälliger Betrag: 476,00 €');
    expect(text).not.toContain('566,44');
    expect(text).not.toContain('90,44');
    expect(text).not.toContain('Zwischensumme netto: 476,00');
  });

  it('W2: das Druckmodell rechnet dieselben Werte', () => {
    const { summary, positions } = buildInvoicePrintModelFromInvoice(hydriert(weissAltabschlag()));
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ unitPrice: 400, lineTotal: 400 });
    expect(summary).toMatchObject({ subtotalNet: 400, taxRate: 19, taxAmount: 76, grossTotal: 476, amountDue: 476 });
  });

  it('W3: der Steuerberaterexport bucht 400 / 76 / 476, bezahlt mit Skonto, ohne Prüfhinweis', () => {
    const model = exportModel([hydriert(weissAltabschlag())]);
    const [zeile] = model.ausgangsrechnungen;
    expect(zeile).toMatchObject({ netto: 400, steuer: 76, brutto: 476, status: 'aktiv', zahlungsstatus: 'bezahlt', skontoAbzug: 9.52, documentStatus: 'generated' });
    expect(zeile.hinweis).toBeUndefined();
    const csv = buildUebersichtCsv(model);
    expect(csv).toContain(';400,00;76,00;476,00;aktiv;');
    beleg_ablegen('W3-export-uebersicht.csv', csv);
    beleg_ablegen('W3-export-zeile.json', JSON.stringify(zeile, null, 2));
  });

  it('W4: XRechnung und ZUGFeRD weisen dieselben Werte aus', async () => {
    const invoice = hydriert(weissAltabschlag());
    const canonical = buildCanonicalEInvoice(invoice);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    expect(canonical.value.totals).toMatchObject({ lineNetTotal: 400, taxExclusiveAmount: 400, taxAmount: 76, taxInclusiveAmount: 476, payableAmount: 476 });
    const xml = renderXRechnungCii(canonical.value);
    expect(xml.ok).toBe(true);
    if (xml.ok) {
      expect(xml.xml).toContain('<ram:TaxBasisTotalAmount>400.00</ram:TaxBasisTotalAmount>');
      expect(xml.xml).toContain('<ram:GrandTotalAmount>476.00</ram:GrandTotalAmount>');
      beleg_ablegen('W4-xrechnung.xml', xml.xml);
    }
    const zugferd = await buildZugferdInvoice(invoice);
    expect(zugferd.ok).toBe(true);
    if (zugferd.ok) {
      expect(zugferd.artifact.xml).toContain('<ram:TaxBasisTotalAmount>400.00</ram:TaxBasisTotalAmount>');
      beleg_ablegen('W4-zugferd.pdf', zugferd.artifact.bytes);
    }
  });

  it('W5: ein schon normalisiert gespeicherter Altbestand (Netto = Brutto, die Spur der alten Regel) ergibt dasselbe', async () => {
    const invoice = hydriert({ ...weissAltabschlag(), subtotal: 476 });
    expect(invoice.subtotal).toBe(476); // gespeichert bleibt gespeichert
    expect(resolveInvoiceNet(invoice)).toEqual({ ok: true, netCents: 40000, source: 'fixed_amount' });
    const text = await echtesPdf(invoice, 'W5-normalisierter-altbestand');
    expect(text).toContain('Zwischensumme netto: 400,00 €');
    expect(text).not.toContain('566,44');
    expect(exportModel([invoice]).ausgangsrechnungen[0]).toMatchObject({ netto: 400, steuer: 76, brutto: 476 });
  });
});

/* ================================================================== U — nicht sicher ermittelbar */
describe('U — ungeklärtes Netto: sperren, Hinweis, Berichtigungsweg, nichts ändern', () => {
  it('U1: Validierung, PDF und Korrektur-PDF sperren mit verständlichem Hinweis', async () => {
    const invoice = hydriert(ungeklaerterAbschlag());
    expect(resolveInvoiceNet(invoice)).toEqual({ ok: false, reason: 'net_missing' });
    const validation = validateFinalizedInvoiceForPdf(invoice);
    expect(validation.blockingErrors).toEqual([{ code: 'net_unresolved', messageKey: 'invoice.pdf.netUnresolved' }]);
    expect(de['invoice.pdf.netUnresolved']).toContain('Rechnungskorrektur');
    const pdf = await generateApprovedInvoicePdf(invoice);
    expect(pdf.ok).toBe(false);
    if (!pdf.ok) expect(pdf.reason).toBe('validation_failed');
    const korrektur = await generateInvoiceCorrectionPdf({
      ...invoice,
      cancelledAt: '2026-08-20T10:00:00.000Z',
      cancelReason: 'Test',
      cancellationKind: 'correction',
      paymentStatus: 'storniert',
    });
    expect(korrektur.ok).toBe(false);
  });

  it('U2: es entsteht kein Druckmodell mit erfundenen Werten', () => {
    expect(() => buildInvoicePrintModelFromInvoice(hydriert(ungeklaerterAbschlag()))).toThrow(InvoiceNetUnresolvedError);
  });

  it('U3: keine XRechnung und keine ZUGFeRD-Rechnung — auch mit Positionen, deren Netto nicht zum Betrag passt', async () => {
    const invoice = hydriert(ungeklaerterAbschlag());
    expect(buildCanonicalEInvoice(invoice).ok).toBe(false);
    expect((await buildZugferdInvoice(invoice)).ok).toBe(false);
    // Rechnung ohne gespeichertes Netto, Positionen 1.000 netto, Betrag 1.000 bei 19 %: kein Kandidat passt.
    const mitPositionen = hydriert(ohneNetto(beleg({ id: 'r-u3', number: 'ALT-U3', amount: 1000 })));
    expect(validateFinalizedInvoiceForPdf(mitPositionen).blockingErrors[0]?.code).toBe('net_unresolved');
    const canonical = buildCanonicalEInvoice(mitPositionen);
    expect(canonical.ok).toBe(false);
    if (!canonical.ok) expect(canonical.issues.map((issue) => issue.code)).toContain('net_unresolved');
    const zugferd = await buildZugferdInvoice(mitPositionen);
    expect(zugferd.ok).toBe(false);
  });

  it('U4: der Steuerberaterexport lässt Netto und Steuer leer, mit Hinweis und als fehlendes Dokument — das Paket entsteht', async () => {
    const model = exportModel([hydriert(ungeklaerterAbschlag())]);
    const [zeile] = model.ausgangsrechnungen;
    expect(zeile).toMatchObject({ netto: null, steuer: null, brutto: 476, documentStatus: 'missing', documents: [] });
    expect(zeile.hinweis).toBe(NET_UNRESOLVED_HINT);
    expect(model.fehlendeDokumente.map((entry) => entry.id)).toEqual(['alt-ungeklaert']);
    const csv = buildUebersichtCsv(model);
    expect(csv).toContain(';;;476,00;aktiv;');
    expect(csv).not.toMatch(/;476,00;0,00;476,00;/);
    const pdfLader = vi.fn(async () => {
      throw new Error('kein PDF für ein ungeklärtes Netto');
    });
    const zip = await buildMonatsmappeZip(model, { invoicePdf: pdfLader, invoiceCorrectionPdf: pdfLader, fileRefBytes: pdfLader });
    expect(zip.ok).toBe(true);
    expect(pdfLader).not.toHaveBeenCalled();
    beleg_ablegen('U4-export-uebersicht.csv', csv);
    beleg_ablegen('U4-export-zeile.json', JSON.stringify(zeile, null, 2));
  });

  it('U5: Buchungsexport und Monatsabschluss: keine Buchung, gemeldet, keine geschätzte Zahl', () => {
    const model = exportModel([hydriert(ungeklaerterAbschlag())]);
    const bookings = buildBookingExport(model, [], 'SKR03');
    expect(bookings.rows).toHaveLength(0);
    expect(bookings.netUnresolved).toEqual([{ sourceId: 'alt-ungeklaert', belegnummer: 'ALT-U' }]);
    expect(Number.isFinite(bookings.totals.netto)).toBe(true);
    const manifest = buildPeriodManifest(model, [], 'SKR03');
    expect(manifest.entries[0]).toMatchObject({ netto: null, steuer: null, brutto: 476 });
    const text = buildPeriodCanonicalText(manifest);
    // Brutto steht fest, Netto und Steuer als „ungeklaert“ — nie als geschätzte Zahl.
    // Systemische Gesamtnacharbeit (Fassung 5) — ungeklärtes Netto/Steuer als „-“, nie geschätzt; Brutto in Cent.
    expect(text).toMatch(/\|47600\|-\|-\|/);
    expect(text).not.toContain('NaN');
  });

  it('U6: die gespeicherte Rechnung bleibt unverändert', async () => {
    const invoice = hydriert(ungeklaerterAbschlag());
    const vorher = JSON.stringify(invoice);
    validateFinalizedInvoiceForPdf(invoice);
    await generateApprovedInvoicePdf(invoice);
    exportModel([invoice]);
    expect(JSON.stringify(getVorgangById(VORGANG)!.invoices.find((entry) => entry.id === invoice.id))).toBe(vorher);
  });
});

/* ================================================================== A — Rechnungsanzeige */
describe('A — die echte Rechnungsdetailseite', () => {
  let mount: { container: HTMLDivElement; root: Root } | null = null;

  function zeige(invoiceId: string) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    let root!: Root;
    act(() => {
      root = createRoot(container);
      root.render(
        <MemoryRouter initialEntries={[`/vorgaenge/${VORGANG}/rechnungen/${invoiceId}`]}>
          <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
            <Routes>
              <Route path="/vorgaenge/:id/rechnungen/:invoiceId" element={<InvoiceDetailPage />} />
              <Route path="/vorgaenge/:id" element={<div data-testid="page-vorgang" />} />
            </Routes>
          </AppProvider>
        </MemoryRouter>,
      );
    });
    mount = { container, root };
    return container;
  }

  afterEach(() => {
    if (mount) {
      act(() => mount!.root.unmount());
      mount.container.remove();
      mount = null;
    }
  });

  it('A1: ungeklärt — Hinweis mit festen Angaben und Berichtigungsweg, keine Beträge, kein 566,44', async () => {
    hydriert(ungeklaerterAbschlag());
    const container = zeige('alt-ungeklaert');
    await act(async () => {
      await Promise.resolve();
    });
    const notice = container.querySelector('[data-testid="invoice-net-unresolved"]');
    expect(notice).not.toBeNull();
    const text = container.textContent ?? '';
    expect(text).toContain('ALT-U');
    expect(text).toContain('476,00');
    expect(text).toContain('Rechnungskorrektur');
    expect(text).toContain('unverändert');
    expect(text).not.toContain('566,44');
    expect(text).not.toContain('90,44');
    expect(container.querySelectorAll('[data-testid="invoice-net-unresolved-steps"] li')).toHaveLength(3);
  });

  it('A2: rekonstruierbar — die Seite zeigt den Beleg mit 400,00 / 76,00 / 476,00', async () => {
    hydriert(weissAltabschlag());
    const container = zeige('weiss-local-alt');
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="invoice-net-unresolved"]')).toBeNull();
    const text = container.textContent ?? '';
    expect(text).toContain('400,00');
    expect(text).toContain('76,00');
    expect(text).not.toContain('566,44');
  });
});

/* ================================================================== G — Gegenproben */
describe('G — Gegenproben', () => {
  it('G1: 7 % — Pauschalnetto 400, Betrag 428: 400 / 28 / 428; ohne Pauschalnetto gesperrt', async () => {
    const invoice = hydriert(weissAltabschlag({ taxStatus: 'standard_7', amount: 428, payments: [] }));
    const text = await echtesPdf(invoice, 'G1-7-prozent');
    expect(text).toContain('Zwischensumme netto: 400,00 €');
    expect(text).toContain('Umsatzsteuer (7 %): 28,00 €');
    expect(text).toContain('Bruttosumme: 428,00 €');
    expect(exportModel([invoice]).ausgangsrechnungen[0]).toMatchObject({ netto: 400, steuer: 28, brutto: 428 });
    const ohne = hydriert(ungeklaerterAbschlag({ taxStatus: 'standard_7', amount: 428, payments: [] }));
    expect(validateFinalizedInvoiceForPdf(ohne).blockingErrors[0]?.code).toBe('net_unresolved');
  });

  it('G2: § 19 — mit Pauschalnetto 400 / 0 / 400 im echten PDF; ohne Netto und ohne Kandidaten ist das Netto der Betrag', async () => {
    const pauschal = hydriert(weissAltabschlag({ taxStatus: 'kleinunternehmer_19', amount: 400, legalNotices: [KU_HINWEIS], payments: [] }));
    expect(resolveInvoiceNet(pauschal)).toEqual({ ok: true, netCents: 40000, source: 'fixed_amount' });
    const text = await echtesPdf(pauschal, 'G2-paragraf-19');
    expect(text).toContain('Zwischensumme netto: 400,00 €');
    expect(text).toContain('Bruttosumme: 400,00 €');
    expect(text).toContain('§ 19 UStG');
    expect(exportModel([pauschal]).ausgangsrechnungen[0]).toMatchObject({ netto: 400, steuer: 0, brutto: 400 });
    const ohne = hydriert(ungeklaerterAbschlag({ taxStatus: 'kleinunternehmer_19', amount: 400, legalNotices: [KU_HINWEIS], payments: [] }));
    expect(resolveInvoiceNet(ohne)).toEqual({ ok: true, netCents: 40000, source: 'tax_free_amount' });
    expect(exportModel([ohne]).ausgangsrechnungen[0]).toMatchObject({ netto: 400, steuer: 0, brutto: 400, documentStatus: 'generated' });
    // Ein PDF scheitert hier nur an den fehlenden Positionen, nicht am Netto.
    expect(validateFinalizedInvoiceForPdf(ohne).blockingErrors.map((issue) => issue.code)).not.toContain('net_unresolved');
  });

  it('G3: § 13b und steuerfrei — mit Pauschalnetto oder ohne Kandidaten eindeutig; widersprechende Positionen gesperrt', () => {
    const rc = hydriert(weissAltabschlag({ taxStatus: 'reverse_charge_13b', amount: 400, legalNotices: [RC_HINWEIS], payments: [] }));
    expect(resolveInvoiceNet(rc)).toEqual({ ok: true, netCents: 40000, source: 'fixed_amount' });
    expect(exportModel([rc]).ausgangsrechnungen[0]).toMatchObject({ netto: 400, steuer: 0, brutto: 400 });
    const frei = hydriert(ungeklaerterAbschlag({ taxStatus: 'tax_free', amount: 400, payments: [] }));
    expect(resolveInvoiceNet(frei)).toEqual({ ok: true, netCents: 40000, source: 'tax_free_amount' });
    const widerspruch = hydriert(ohneNetto(beleg({ id: 'frei-w', taxStatus: 'tax_free', amount: 900, positions: [line()] })));
    expect(resolveInvoiceNet(widerspruch)).toEqual({ ok: false, reason: 'net_contradicts' });
  });

  it('G4: „unklar" ist nicht steuerfrei — ohne Netto und Kandidaten bleibt es ungeklärt', () => {
    const invoice = hydriert(ungeklaerterAbschlag({ taxStatus: 'unclear', amount: 400, payments: [] }));
    expect(resolveInvoiceNet(invoice).ok).toBe(false);
    expect(validateFinalizedInvoiceForPdf(invoice).blockingErrors[0]?.code).toBe('net_unresolved');
  });

  it('G5: Skonto und Teilzahlung ändern das Netto nicht; offener Betrag bleibt brutto', () => {
    const skonto = exportModel([hydriert(weissAltabschlag())]).ausgangsrechnungen[0];
    expect(skonto).toMatchObject({ netto: 400, steuer: 76, zahlungssumme: 466.48, skontoAbzug: 9.52, offenerBetrag: 0 });
    const teil = exportModel([hydriert(weissAltabschlag({ payments: [zahlung('p-teil', 200, '2026-08-20')] }))]).ausgangsrechnungen[0];
    // Fällig am 15.08.: zum Monatsende teilbezahlt und überfällig.
    expect(teil).toMatchObject({ netto: 400, steuer: 76, brutto: 476, zahlungssumme: 200, offenerBetrag: 276, zahlungsstatus: 'ueberfaellig' });
    const teilUngeklaert = exportModel([hydriert(ungeklaerterAbschlag({ payments: [zahlung('p-teil', 200, '2026-08-20')] }))]).ausgangsrechnungen[0];
    expect(teilUngeklaert).toMatchObject({ netto: null, steuer: null, brutto: 476, zahlungssumme: 200, offenerBetrag: 276 });
  });

  it('G6: Rundung — Positionen 3 × 33,33: 99,99 / 19,00 / 118,99; ein Cent daneben bleibt ungeklärt', async () => {
    const posten = [line({ quantity: 3, unitPrice: 33.33, lineTotal: 99.99 })];
    const passt = hydriert(ohneNetto(beleg({ id: 'r-ok', positions: posten, amount: 118.99 })));
    expect(resolveInvoiceNet(passt)).toEqual({ ok: true, netCents: 9999, source: 'positions' });
    const text = await echtesPdf(passt, 'G6-rundung');
    expect(text).toContain('Zwischensumme netto: 99,99 €');
    expect(text).toContain('Umsatzsteuer (19 %): 19,00 €');
    expect(text).toContain('Bruttosumme: 118,99 €');
    expect(resolveInvoiceNet(hydriert(ohneNetto(beleg({ id: 'r-cent', positions: posten, amount: 119 }))))).toEqual({
      ok: false,
      reason: 'net_contradicts',
    });
    // Halber Cent je Zeile wie bei der Freigabe: 0,5 × 2,01 = 1,005 → 1,01; mit 10 × 100,00 netto 1.001,01, brutto 1.191,20.
    const halb = hydriert(ohneNetto(beleg({ id: 'r-halb', positions: [line(), line({ id: 'p2', quantity: 0.5, unitPrice: 2.01, lineTotal: 1.01 })], amount: 1191.2 })));
    expect(resolveInvoiceNet(halb)).toEqual({ ok: true, netCents: 100101, source: 'positions' });
    // 7 %: 99,99 + 7,00 = 106,99
    expect(resolveInvoiceNet(hydriert(ohneNetto(beleg({ id: 'r-7', positions: posten, taxStatus: 'standard_7', amount: 106.99 }))))).toEqual({
      ok: true,
      netCents: 9999,
      source: 'positions',
    });
  });

  it('G7: widersprüchliche Altdaten bleiben gesperrt — nur die Spur der alten Regel (Netto = Brutto) wird übergangen', () => {
    // anderes gespeichertes Netto als der Betrag: nicht still durch das Pauschalnetto ersetzen
    const anders = hydriert({ ...weissAltabschlag({ id: 'w-450' }), subtotal: 450 });
    expect(resolveInvoiceNet(anders)).toEqual({ ok: false, reason: 'net_contradicts' });
    // gespeichertes Netto passt zum Betrag, das Pauschalnetto nicht: ein Pauschalabschlag ist eine Zeile
    const pauschal = hydriert({ ...weissAltabschlag({ id: 'w-410', fixedAmountNet: 410 }), subtotal: 400 });
    expect(resolveInvoiceNet(pauschal)).toEqual({ ok: false, reason: 'net_contradicts' });
    expect(validateFinalizedInvoiceForPdf(pauschal).blockingErrors[0]?.code).toBe('net_unresolved');
    // Steuerstatus fehlte (Hydratisierung ergänzt 19 %), der Beleg war ohne Steuer: 400 ≠ 476 — gesperrt, nicht 400/76/476
    const { taxStatus: _status, ...ohneStatus } = weissAltabschlag({ id: 'w-ohne-status', amount: 400, payments: [] });
    const ergaenzt = hydriert(ohneStatus as VorgangInvoice);
    expect(ergaenzt.taxStatus).toBe('standard_19');
    expect(resolveInvoiceNet(ergaenzt).ok).toBe(false);
    expect(exportModel([ergaenzt]).ausgangsrechnungen[0]).toMatchObject({ netto: null, steuer: null, brutto: 400 });
  });

  it('G8: Schlussrechnung im Altbestand — Netto aus den Positionen, Abzug aus dem Abschlag', async () => {
    const abschlag = beleg({ id: 'a-neu', number: '2026-0082', type: 'abschlag', abschlagNumber: 1, calculationMode: 'fixed_amount', fixedAmountNet: 400, positions: [], subtotal: 400, amount: 476, payments: [zahlung('p-a', 476, '2026-08-05')] });
    const abzug: AbschlagDeduction = { invoiceId: 'a-neu', invoiceNumber: '2026-0082', abschlagNumber: 1, date: '2026-08-01', subtotal: 400, amount: 476, paidAmount: 476, skontoAmount: 0 };
    const schluss = hydriert(ohneNetto(beleg({ id: 's-alt', number: '2026-0101', type: 'schluss', amount: 714, previousAbschlagDeductions: [abzug] })), [abschlag]);
    expect(resolveInvoiceNet(schluss)).toEqual({ ok: true, netCents: 100000, source: 'positions' });
    const text = await echtesPdf(schluss, 'G8-schluss-altbestand');
    expect(text).toContain('Zwischensumme netto: 1.000,00 €');
    expect(text).toContain('Fälliger Betrag: 714,00 €');
    expect(exportModel([schluss]).ausgangsrechnungen[0]).toMatchObject({ netto: 600, steuer: 114, brutto: 714 });
  });

  it('G9: Abschlagsabzug — der Abzug spiegelt den gespeicherten Abschlag (#8); ohne gespeichertes Netto kein Brutto, die Schlussrechnung sperrt', () => {
    const alt = hydriert(weissAltabschlag());
    const [abzug] = getPreviousAbschlagDeductions(getVorgangById(VORGANG)!);
    expect(abzug).toMatchObject({ invoiceId: 'weiss-local-alt', amount: 476 });
    expect(abzug.subtotal).toBeUndefined(); // bis Bericht 14: 476 (Brutto)
    expect(hasUnreliableAbschlagNet('standard_19', [abzug], () => alt)).toBe(true);
    // Mit gespeichertem Netto unverändert.
    const heute = hydriert({ ...weissAltabschlag(), subtotal: 400 });
    const [mitNetto] = getPreviousAbschlagDeductions(getVorgangById(VORGANG)!);
    expect(mitNetto).toMatchObject({ subtotal: 400, amount: 476 });
    expect(hasUnreliableAbschlagNet('standard_19', [mitNetto], () => heute)).toBe(false);
  });

  it('G10: Abrechnungsgrenze und Auftragsübersicht — rekonstruiert 400; ungeklärt höchstens 476, mit Hinweis', () => {
    hydriert(weissAltabschlag());
    const basis = getCurrentBillableOrderNetCents(getVorgangById(VORGANG)!);
    expect(getRemainingFixedAmountBillableNetCents(getVorgangById(VORGANG)!)).toBe(basis - 40000);
    expect(summarizeOrderFinancials(getVorgangById(VORGANG)!).netUnresolvedInvoiceCount).toBe(0);
    hydriert(ungeklaerterAbschlag());
    expect(getRemainingFixedAmountBillableNetCents(getVorgangById(VORGANG)!)).toBe(basis - 47600);
    expect(summarizeOrderFinancials(getVorgangById(VORGANG)!).netUnresolvedInvoiceCount).toBe(1);
  });

  it('G11: heutiger Bestand — gespeichertes Netto gilt unverändert (Rechnung, Abschlag, § 13b)', async () => {
    const rechnung = hydriert(beleg({ id: 'heute-1' }));
    expect(resolveInvoiceNet(rechnung)).toEqual({ ok: true, netCents: 100000, source: 'stored' });
    const text = await echtesPdf(rechnung, 'G11-heutige-rechnung');
    expect(text).toContain('Zwischensumme netto: 1.000,00 €');
    expect(text).toContain('Umsatzsteuer (19 %): 190,00 €');
    expect(text).toContain('Bruttosumme: 1.190,00 €');
    const abschlag = hydriert(beleg({ id: 'heute-2', type: 'abschlag', abschlagNumber: 1, calculationMode: 'fixed_amount', fixedAmountNet: 400, positions: [], subtotal: 400, amount: 476 }));
    expect(resolveInvoiceNet(abschlag)).toEqual({ ok: true, netCents: 40000, source: 'stored' });
    const rc = hydriert(beleg({ id: 'heute-3', taxStatus: 'reverse_charge_13b', amount: 1000, legalNotices: [RC_HINWEIS] }));
    expect(resolveInvoiceNet(rc)).toEqual({ ok: true, netCents: 100000, source: 'stored' });
  });
});
