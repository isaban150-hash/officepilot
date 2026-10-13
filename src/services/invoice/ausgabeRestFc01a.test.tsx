/**
 * FINANZ-CORE-01A — Ausgabe-Reste (AUS-10, AUS-11/EIN-07, AUS-14, AUS-16, AUS-17, AUS-19).
 *
 *  A10a  Rücklauf: das Register merkt die jüngste übergebene Zustellung; ein neuer Erfolg oder ein
 *        späterer manueller Versand hebt die Sperre auf
 *  A10b  Rücklauf: keine Zahlungserinnerung für eine nachweislich nicht zugestellte Rechnung
 *  A11a  Aufbewahrungshinweis: genau einmal, am Ende, abschaltbar; andere Hinweise und ein
 *        Steuerwechsel lassen ihn stehen
 *  A11b  Aufbewahrungshinweis in der E-Rechnung: Belegnotiz, nie Steuerbefreiungsgrund
 *  A11c  Formular: das Häkchen spiegelt den Hinweis
 *  A14a  PDF-Fehler nennt den Prüfgrund
 *  A14b  Druckfehler: eigene Meldung mit Grund
 *  A14c  Versanddialog: eine gescheiterte PDF-Vorschau wird gemeldet
 *  A15   Versand kurz nach Mitternacht: lokal der Geschäftstag (Europe/Berlin), nicht der UTC-Tag
 *  A16a  PDF: Zeilenumbrüche bleiben, keine 0-%-Zeile ohne Umsatzsteuer, Hinweis gedruckt
 *  A16b  PDF: mehrseitig mit „Seite x von y" und Tabellenkopf je Seite; einseitig ohne
 *  A17   Korrektur einer Schlussrechnung: „+" statt doppeltem Minus (PDF und Ansicht)
 *  A19a  Datum: Kalendertag auch westlich von UTC; Unlesbares bleibt sichtbar
 *  A19b  Versandhistorie: ein abgelöster Versuch heißt „Abgelöst – nicht gesendet"
 *  A19c  Korrektur eines OfficeTakt-Versands: Hinweis auf den manuellen Vermerk
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { PDFPage } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeliveryHistoryList } from '../../components/invoice/DeliveryHistoryList';
import { InvoiceDraftEditForm } from '../../components/invoice/InvoiceDraftEditForm';
import { InvoicePrintActions } from '../../components/invoice/InvoicePrintActions';
import { InvoiceSentPanel } from '../../components/invoice/InvoiceSentPanel';
import { InvoiceSummary } from '../../components/invoice/InvoiceSummary';
import { SendDocumentDialog } from '../../components/invoice/SendDocumentDialog';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { de, t, type TranslationKey } from '../../i18n';
import { analyzeInvoiceFinance } from '../brain/financeIntelligenceService';
import { resetCompanySessionForTests } from '../brain/companySessionService';
import { hydrateCommunicationHistory } from '../communicationHistoryService';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import {
  isInvoiceDeliveryBounced,
  recordInvoiceDeliveryOutcome,
  resetDeliveryBounceRegistryForTests,
} from '../delivery/deliveryBounceRegistry';
import { applyAcceptedDeliveryToLocalInvoice } from '../delivery/sendDocumentOrchestrator';
import { resetDunningDocumentations } from '../dunningDocumentationService';
import { buildCanonicalEInvoice } from '../einvoice/canonicalEInvoiceBuilder';
import { renderXRechnungCii } from '../einvoice/xrechnungCiiRenderer';
import { hydrateInboxStore } from '../inboxService';
import { formatSignedDeductionPdf, generateApprovedInvoicePdf } from '../invoicePdfService';
import { formatInvoiceDate } from '../invoicePrintModel';
import { buildInvoiceDraftForType, updateInvoiceDraftMetadata } from '../invoiceService';
import { normalizeLegalNoticesForTaxStatus, PRIVATE_RETENTION_NOTICE } from '../invoiceTaxService';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import { hydrateVorgangStore } from '../vorgangService';
import { alsInhaber } from '../../test/workspaceRoleTestUtils';
import { createOrderPosition, createTestVorgang, testSetup } from '../../test/fixtures';
import type { DocumentDelivery } from '../../types/documentDelivery';
import type { CompanyProfile, CustomerBilling, InvoiceDraft, InvoicePrintModel, VorgangInvoice } from '../../types/models';

const keyTranslate = (key: TranslationKey): string => key;
const deTranslate = (key: TranslationKey): string => t(key);

const SELLER = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Muster Handwerk',
  legalForm: 'GmbH',
  street: 'Werkstraße 12',
  zip: '80331',
  city: 'München',
  countryCode: 'DE',
  contactPerson: 'M. Muster',
  phone: '+49 89 123456',
  email: 'rechnung@muster-handwerk.invalid',
  taxNumber: '143/123/45678',
  vatId: 'DE111111111',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  invoiceFooterNotes: 'Vielen Dank.',
} as unknown as CompanyProfile;

const BUYER: CustomerBilling = {
  name: 'Beispiel Kundschaft',
  contactPerson: 'A. Beispiel',
  street: 'Musterweg 1',
  zip: '10115',
  city: 'Berlin',
  email: 'kunde@example.invalid',
  phone: '',
  countryCode: 'DE',
  buyerReference: 'REF-1',
};

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-aus',
    number: '2026-0077',
    type: 'rechnung',
    positions: [
      { id: 'line-1', orderPositionId: 'op-1', description: 'Fliesenarbeiten Bad', quantity: 8, unit: 'Stunden', unitPrice: 55, lineTotal: 440 },
    ],
    subtotal: 440,
    taxStatus: 'standard_19',
    amount: 523.6,
    status: 'vorbereitet',
    date: '2026-09-01',
    createdAt: '2026-09-01T08:00:00.000Z',
    issueDate: '2026-09-01',
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-31',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-09-15',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    skontoText: '',
    currencyCode: 'EUR',
    customerSnapshot: { ...BUYER },
    companySnapshot: { ...SELLER },
    legalNotices: [],
    previousAbschlagDeductions: [],
    payments: [],
    ...overrides,
  } as unknown as VorgangInvoice;
}

function lieferung(o: Partial<DocumentDelivery>): DocumentDelivery {
  return {
    id: 'd-x',
    clientDeliveryId: 'c-x',
    documentKind: 'invoice',
    status: 'provider_accepted',
    recipientEmail: 'kunde@example.invalid',
    requestedAt: '2026-09-10T08:00:00.000Z',
    attemptNumber: 1,
    ...o,
  } as unknown as DocumentDelivery;
}

/** Schneidet jeden gezeichneten Text mit, ohne das Zeichnen zu unterbinden. */
function zeichnungen(): string[] {
  const drawn: string[] = [];
  const original = PDFPage.prototype.drawText;
  vi.spyOn(PDFPage.prototype, 'drawText').mockImplementation(function (
    this: PDFPage,
    text: string,
    options?: Parameters<PDFPage['drawText']>[1],
  ) {
    drawn.push(text);
    return original.call(this, text, options);
  });
  return drawn;
}

async function pdf(invoice: VorgangInvoice): Promise<void> {
  const result = await generateApprovedInvoicePdf(invoice);
  expect(result.ok, JSON.stringify(result.ok ? '' : result)).toBe(true);
}

beforeEach(() => {
  localStorage.clear();
  resetDeliveryBounceRegistryForTests();
  alsInhaber();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ================================================================== */
/* AUS-10 — Rücklauf                                                    */
/* ================================================================== */

describe('AUS-10 — nicht zugestellte Rechnung', () => {
  const unzustellbar = lieferung({ id: 'd-2', deliveryState: 'bounced', requestedAt: '2026-09-12T08:00:00.000Z' });

  it('A10a: das Register merkt den Rücklauf; Erfolg oder späterer manueller Versand heben ihn auf', () => {
    // Neueste zuerst: ein nur vorbereiteter Versuch zählt nicht als Zustellung.
    recordInvoiceDeliveryOutcome('inv-a10', [lieferung({ id: 'd-3', status: 'prepared' }), unzustellbar]);
    expect(isInvoiceDeliveryBounced({ id: 'inv-a10', sentSource: 'officepilot', sentAt: '2026-09-12' })).toBe(true);
    // Per Post am selben oder einem späteren Tag vermerkt: Die Sperre fällt.
    expect(isInvoiceDeliveryBounced({ id: 'inv-a10', sentSource: 'manual', sentAt: '2026-09-12' })).toBe(false);
    expect(isInvoiceDeliveryBounced({ id: 'inv-a10', sentSource: 'manual', sentAt: '2026-09-15' })).toBe(false);
    // Ein manueller Vermerk von vor dem Rücklauf hebt nichts auf.
    expect(isInvoiceDeliveryBounced({ id: 'inv-a10', sentSource: 'manual', sentAt: '2026-09-11' })).toBe(true);

    // Eine neuere, zugestellte E-Mail: kein Rücklauf mehr.
    recordInvoiceDeliveryOutcome('inv-a10', [
      lieferung({ id: 'd-4', deliveryState: 'delivered', requestedAt: '2026-09-14T08:00:00.000Z' }),
      unzustellbar,
    ]);
    expect(isInvoiceDeliveryBounced({ id: 'inv-a10', sentSource: 'officepilot', sentAt: '2026-09-14' })).toBe(false);
  });

  it('A10b: keine Zahlungserinnerung für eine nicht zugestellte Rechnung', () => {
    resetCompanySessionForTests();
    hydrateCompanyProfileStore({ ...SELLER });
    hydrateInboxStore([]);
    hydrateCommunicationHistory([]);
    resetDunningDocumentations();
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-a10',
        title: 'Bad Beispiel',
        invoices: [
          rechnung({ id: 'inv-a10b', number: 'RE-2026-310', status: 'versendet', sentAt: '2026-06-15', sentSource: 'officepilot', paymentDueDate: '2026-06-29' }),
        ],
      }),
    ]);

    const vorher = analyzeInvoiceFinance('v-a10', 'inv-a10b', '2026-07-03');
    expect(vorher?.recommendations.some((r) => r.id === 'payment_reminder')).toBe(true);

    recordInvoiceDeliveryOutcome('inv-a10b', [unzustellbar]);
    const nachher = analyzeInvoiceFinance('v-a10', 'inv-a10b', '2026-07-03');
    expect(nachher?.recommendations.some((r) => r.id === 'payment_reminder' || r.id === 'mahnung')).toBe(false);
  });
});

/* ================================================================== */
/* AUS-11 / EIN-07 — Aufbewahrungshinweis                               */
/* ================================================================== */

function entwurf(): InvoiceDraft {
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-a11',
      materialSource: 'betrieb',
      orderPositions: [
        createOrderPosition({ id: 'op-1', plannedQuantity: 2, executedQuantity: 2, unit: 'Stück', unitPrice: 100, category: 'arbeit' }),
      ],
    }),
  ]);
  const base = buildInvoiceDraftForType('v-a11', testSetup, 'rechnung');
  expect(base).not.toBeNull();
  return { ...base!, legalNotices: ['Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.'] };
}

describe('AUS-11/EIN-07 — Hinweis auf die Aufbewahrungspflicht', () => {
  it('A11a: genau einmal, am Ende, abschaltbar; andere Hinweise und Steuerwechsel lassen ihn stehen', () => {
    const an = updateInvoiceDraftMetadata(entwurf(), { privateRetentionNotice: true });
    expect(an.legalNotices).toEqual(['Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.', PRIVATE_RETENTION_NOTICE]);
    const nochmal = updateInvoiceDraftMetadata(an, { privateRetentionNotice: true });
    expect(nochmal.legalNotices.filter((text) => text === PRIVATE_RETENTION_NOTICE)).toHaveLength(1);
    const aus = updateInvoiceDraftMetadata(nochmal, { privateRetentionNotice: false });
    expect(aus.legalNotices).toEqual(['Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.']);
    // Wechsel zur Regelsteuer: der § 19-Text geht, der Aufbewahrungshinweis bleibt.
    expect(normalizeLegalNoticesForTaxStatus('standard_19', an.legalNotices)).toEqual([PRIVATE_RETENTION_NOTICE]);
  });

  it('A11b: in der E-Rechnung Belegnotiz, nie Steuerbefreiungsgrund', () => {
    const paragraf19 = 'Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.';
    const klein = buildCanonicalEInvoice(
      rechnung({ taxStatus: 'kleinunternehmer_19', amount: 440, legalNotices: [paragraf19, PRIVATE_RETENTION_NOTICE] }),
    );
    expect(klein.ok, JSON.stringify(klein.ok ? '' : klein.issues)).toBe(true);
    if (!klein.ok) return;
    expect(klein.value.tax[0]?.exemptionReason).toBe(paragraf19);
    expect(klein.value.notes).toContain(PRIVATE_RETENTION_NOTICE);

    // Der Hinweis ersetzt keinen fehlenden Befreiungsgrund.
    const nurHinweis = buildCanonicalEInvoice(
      rechnung({ taxStatus: 'kleinunternehmer_19', amount: 440, legalNotices: [PRIVATE_RETENTION_NOTICE] }),
    );
    expect(nurHinweis.ok ? [] : nurHinweis.issues.map((i) => i.code)).toContain('tax_exemption_reason_missing');

    // Regelsteuer: als Notiz im XML.
    const standard = buildCanonicalEInvoice(rechnung({ legalNotices: [PRIVATE_RETENTION_NOTICE] }));
    expect(standard.ok).toBe(true);
    if (!standard.ok) return;
    const xml = renderXRechnungCii(standard.value);
    expect(xml.ok && xml.xml).toContain('zwei Jahre lang aufzubewahren');
  });

  it('A11c: das Häkchen spiegelt den Hinweis', () => {
    const ohne = entwurf();
    const html = (draft: InvoiceDraft) =>
      renderToStaticMarkup(createElement(InvoiceDraftEditForm, { draft, onChange: () => {} }));
    const checkbox = (markup: string) => /<input[^>]*data-testid="invoice-edit-private-retention"[^>]*>/.exec(markup)?.[0] ?? '';
    expect(checkbox(html(ohne))).not.toBe('');
    expect(checkbox(html(ohne))).not.toContain('checked');
    expect(checkbox(html(updateInvoiceDraftMetadata(ohne, { privateRetentionNotice: true })))).toContain('checked');
  });
});

/* ================================================================== */
/* AUS-14 — Druck- und PDF-Fehler                                       */
/* ================================================================== */

describe('AUS-14 — Fehler bei Druck und PDF', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  function zeigeAktionen(invoice: VorgangInvoice, generatePdf?: Parameters<typeof InvoicePrintActions>[0]['generatePdf']) {
    act(() => {
      root.render(
        createElement(InvoicePrintActions, {
          invoice,
          model: buildInvoicePrintModelFromInvoice(invoice),
          translate: deTranslate,
          ...(generatePdf ? { generatePdf } : {}),
        }),
      );
    });
  }

  it('A14a: der PDF-Fehler nennt den Prüfgrund', async () => {
    zeigeAktionen(rechnung(), async () => ({
      ok: false,
      reason: 'validation_failed',
      validation: {
        blockingErrors: [{ code: 'service_period_unconfirmed', messageKey: 'invoice.validation.servicePeriodUnconfirmed' }],
        warnings: [],
      } as never,
    }));
    await act(async () => {
      q('invoice-download-pdf')!.click();
    });
    const text = q('invoice-pdf-error')?.textContent ?? '';
    expect(text).toContain(de['invoice.pdf.errorPrefix' as keyof typeof de]);
    expect(text).toContain(t('invoice.validation.servicePeriodUnconfirmed' as TranslationKey));
  });

  it('A14b: der Druckfehler hat eine eigene Meldung mit Grund', async () => {
    zeigeAktionen(rechnung({ servicePeriodConfirmed: false }));
    await act(async () => {
      q('invoice-print')!.click();
    });
    const text = q('invoice-pdf-error')?.textContent ?? '';
    expect(text).toContain(t('invoice.print.error' as TranslationKey));
    expect(text).toContain(t('invoice.validation.servicePeriodUnconfirmed' as TranslationKey));
    expect(text).not.toContain(t('invoice.pdf.error' as TranslationKey));
  });

  it('A14c: eine gescheiterte PDF-Vorschau im Versanddialog wird gemeldet', async () => {
    act(() => {
      root.render(
        <SendDocumentDialog
          open
          invoice={rechnung({ status: 'entwurf' })}
          initialRecipient="kunde@example.invalid"
          canonicalRecipient="kunde@example.invalid"
          initialSubject="Rechnung"
          initialBody="Guten Tag"
          attachmentFilename="Rechnung.pdf"
          alreadySent={false}
          mode="send"
          phase={null}
          busy={false}
          errorKey={null}
          translate={keyTranslate}
          onCancel={() => {}}
          onSend={() => {}}
        />,
      );
    });
    expect(q('send-document-pdf-error')).toBeNull();
    await act(async () => {
      q('send-document-pdf')!.click();
    });
    expect(q('send-document-pdf-error')?.textContent).toBe('invoice.pdf.error');
  });
});

/* ================================================================== */
/* AUS-15 — Versanddatum                                                */
/* ================================================================== */

describe('AUS-15 — Versanddatum nach dem E-Mail-Versand', () => {
  it('A15: kurz nach Mitternacht gilt lokal der Geschäftstag, nicht der UTC-Tag', () => {
    const invoice = rechnung({ id: 'inv-a15', status: 'vorbereitet' });
    hydrateVorgangStore([createTestVorgang({ id: 'v-a15', invoices: [invoice] })]);
    // 23:30 UTC am 12.10. ist 01:30 Uhr am 13.10. in Berlin (Sommerzeit).
    const angenommen = lieferung({
      id: 'd-a15',
      status: 'provider_accepted',
      requestedAt: '2026-10-12T23:29:00.000Z',
      providerAcceptedAt: '2026-10-12T23:30:00.000Z',
    });
    const nachher = applyAcceptedDeliveryToLocalInvoice('v-a15', invoice, angenommen);
    expect(nachher).toMatchObject({ status: 'versendet', sentSource: 'officepilot', sentAt: '2026-10-13' });

    // Der Rücklauf zählt am selben Geschäftstag: ein Postversand am 13.10. hebt die Sperre auf.
    recordInvoiceDeliveryOutcome('inv-a15', [{ ...angenommen, deliveryState: 'bounced' }]);
    expect(isInvoiceDeliveryBounced({ id: 'inv-a15', sentSource: 'officepilot', sentAt: '2026-10-13' })).toBe(true);
    expect(isInvoiceDeliveryBounced({ id: 'inv-a15', sentSource: 'manual', sentAt: '2026-10-13' })).toBe(false);
    // Ein Vermerk vom Vortag (Berlin) liegt vor dem Rücklauf und hebt nichts auf.
    expect(isInvoiceDeliveryBounced({ id: 'inv-a15', sentSource: 'manual', sentAt: '2026-10-12' })).toBe(true);
  });
});

/* ================================================================== */
/* AUS-16 — PDF wie am Bildschirm                                       */
/* ================================================================== */

describe('AUS-16 — PDF', () => {
  it('A16a: Zeilenumbrüche bleiben, keine 0-%-Zeile ohne Umsatzsteuer, Hinweis gedruckt', async () => {
    const drawn = zeichnungen();
    await pdf(
      rechnung({
        taxStatus: 'kleinunternehmer_19',
        amount: 440,
        paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.\nBitte die Rechnungsnummer angeben.',
        legalNotices: ['Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.', PRIVATE_RETENTION_NOTICE],
      }),
    );
    expect(drawn).toContain('Zahlbar innerhalb von 14 Tagen.');
    expect(drawn).toContain('Bitte die Rechnungsnummer angeben.');
    expect(drawn.some((text) => text.includes('Tagen.Bitte'))).toBe(false);
    expect(drawn.some((text) => text.startsWith('Umsatzsteuer ('))).toBe(false);
    expect(drawn.join(' ')).toContain('zwei Jahre lang');

    // Mit Umsatzsteuer steht die Zeile weiter da.
    drawn.length = 0;
    await pdf(rechnung());
    expect(drawn.some((text) => text.startsWith('Umsatzsteuer (19 %)'))).toBe(true);
  });

  it('A16b: mehrseitig „Seite x von y" und Tabellenkopf je Seite; einseitig ohne', async () => {
    const drawn = zeichnungen();
    await pdf(rechnung());
    expect(drawn.some((text) => /^Seite \d+ von \d+$/.test(text))).toBe(false);
    expect(drawn.filter((text) => text === 'Beschreibung')).toHaveLength(1);

    drawn.length = 0;
    const positions = Array.from({ length: 70 }, (_, index) => ({
      id: `line-${index + 1}`,
      orderPositionId: `op-${index + 1}`,
      description: `Position ${index + 1}`,
      quantity: 1,
      unit: 'Stück',
      unitPrice: 10,
      lineTotal: 10,
    }));
    await pdf(rechnung({ positions, subtotal: 700, amount: 833 } as Partial<VorgangInvoice>));
    const seiten = drawn.filter((text) => /^Seite \d+ von \d+$/.test(text));
    expect(seiten.length).toBeGreaterThan(1);
    const gesamt = seiten.length;
    expect(seiten[0]).toBe(`Seite 1 von ${gesamt}`);
    expect(seiten).toContain(`Seite ${gesamt} von ${gesamt}`);
    // Der Kopf steht auf jeder Seite, die Positionen trägt (mindestens zwei).
    expect(drawn.filter((text) => text === 'Beschreibung').length).toBeGreaterThanOrEqual(2);
  });
});

/* ================================================================== */
/* AUS-17 — Vorzeichen im Korrekturbeleg                                */
/* ================================================================== */

describe('AUS-17 — kein doppeltes Minus', () => {
  it('A17: „-" im Original, „+" in der Korrektur — PDF und Ansicht', () => {
    expect(formatSignedDeductionPdf(1190)).toMatch(/^-1\.190,00/);
    expect(formatSignedDeductionPdf(-1190)).toMatch(/^\+1\.190,00/);
    expect(formatSignedDeductionPdf(-1190)).not.toContain('--');

    const modell = (betrag: number) =>
      ({
        type: 'schluss',
        summary: {
          subtotalNet: 5000,
          taxRate: 19,
          taxAmount: 950,
          grossTotal: 5950,
          deductionLines: [{ label: 'Abschlag 1', invoiceNumber: '2026-0010', amount: betrag }],
          deductionsTotal: betrag,
          amountDue: 5950 - betrag,
        },
      }) as unknown as InvoicePrintModel;
    const korrektur = renderToStaticMarkup(createElement(InvoiceSummary, { model: modell(-1190) }));
    expect(korrektur).toContain('+ 1.190,00');
    expect(korrektur).not.toMatch(/−\s*-/);
    const original = renderToStaticMarkup(createElement(InvoiceSummary, { model: modell(1190) }));
    expect(original).toContain('− 1.190,00');
    expect(original).not.toContain('+ 1.190,00');
  });
});

/* ================================================================== */
/* AUS-19 — Kleinpunkte                                                 */
/* ================================================================== */

describe('AUS-19 — Datum, Versandhistorie, Korrektur des Versandvermerks', () => {
  it('A19a: der Kalendertag bleibt auch westlich von UTC; Unlesbares bleibt sichtbar', () => {
    const vorher = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      // Vorbedingung: Die Zeitzone greift (UTC-Mitternacht ist dort der Vortag).
      expect(new Date('2026-03-01').getDate()).toBe(28);
      expect(formatInvoiceDate('2026-03-01')).toBe('1.3.2026');
    } finally {
      if (vorher === undefined) delete process.env.TZ;
      else process.env.TZ = vorher;
    }
    expect(formatInvoiceDate('kein Datum')).toBe('kein Datum');
    expect(formatInvoiceDate('')).toBe('—');
  });

  it('A19b: ein abgelöster Versuch heißt „Abgelöst – nicht gesendet"', () => {
    const html = renderToStaticMarkup(
      createElement(DeliveryHistoryList, {
        deliveries: [
          lieferung({ id: 'd-neu', status: 'provider_accepted' }),
          lieferung({ id: 'd-alt', status: 'prepared' }),
          lieferung({ id: 'd-aelter', status: 'queued' }),
        ],
        emptyKey: 'delivery.history.empty' as TranslationKey,
        translate: keyTranslate,
      }),
    );
    const labels = [...html.matchAll(/data-testid="invoice-delivery-status"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(['delivery.status.provider_accepted', 'delivery.status.superseded', 'delivery.status.superseded']);

    // Der jüngste Versuch bleibt, was er ist.
    const einzeln = renderToStaticMarkup(
      createElement(DeliveryHistoryList, {
        deliveries: [lieferung({ id: 'd-1', status: 'prepared' })],
        emptyKey: 'delivery.history.empty' as TranslationKey,
        translate: keyTranslate,
      }),
    );
    expect(einzeln).toContain('delivery.status.prepared');
    expect(t('delivery.status.superseded' as TranslationKey)).toBe('Abgelöst – nicht gesendet');
  });

  it('A19c: die Korrektur eines OfficeTakt-Versands erklärt den manuellen Vermerk', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const zeige = (sentSource: 'officepilot' | 'manual') => {
      const invoice = rechnung({ status: 'versendet', sentAt: '2026-09-10', sentVia: 'email', sentSource });
      hydrateVorgangStore([createTestVorgang({ id: 'v-a19', invoices: [invoice] })]);
      act(() => {
        root.render(
          createElement(InvoiceSentPanel, {
            vorgangId: 'v-a19',
            invoice,
            cloudState: { kind: 'synced' },
            translate: keyTranslate,
            onUpdated: () => {},
            onCloudStateChange: () => {},
          }),
        );
      });
    };
    try {
      zeige('officepilot');
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="invoice-sent-correct"]')!.click();
      });
      expect(container.querySelector('[data-testid="invoice-sent-officepilot-hint"]')).not.toBeNull();

      act(() => root.unmount());
      const root2 = createRoot(container);
      const invoice = rechnung({ status: 'versendet', sentAt: '2026-09-10', sentVia: 'post', sentSource: 'manual' });
      act(() => {
        root2.render(
          createElement(InvoiceSentPanel, {
            vorgangId: 'v-a19',
            invoice,
            cloudState: { kind: 'synced' },
            translate: keyTranslate,
            onUpdated: () => {},
            onCloudStateChange: () => {},
          }),
        );
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="invoice-sent-correct"]')!.click();
      });
      expect(container.querySelector('[data-testid="invoice-sent-officepilot-hint"]')).toBeNull();
      act(() => root2.unmount());
    } finally {
      container.remove();
    }
  });
});
