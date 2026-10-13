/**
 * FINANZ-CORE-01A (WEISS-Nacharbeit N14/N15) — Firmierung und Briefschluss.
 *
 * WEISS N14: Firmenname endet auf „GmbH", Rechtsform ebenfalls „GmbH" — blindes
 * Zusammensetzen ergab „GmbH GmbH" in XML (BT-27), PDF und HTML.
 * WEISS N15: Mahnung 2026-0021 und Erinnerung zeigten „Mit freundlichen Grüßen" mit Firma
 * zweimal.
 *
 *  F1–F4  Firmierung: Doppelung entfällt, Wortteile zählen nicht, Punkte/Gross-
 *         schreibung egal; XML, PDF-Konsistenz, Mail, Quittung nutzen dieselbe Regel
 *  B1–B4  Briefschluss: E-Mail, Brief und Kurzfassung tragen Gruß und Firma genau einmal;
 *         der Brief eine Anrede; ein Entwurf ohne eigenen Schluss bekommt einen
 *
 * Die HTML-Ansicht (geschützter Snapshot) setzt die Firmierung noch selbst zusammen;
 * ihre Änderung wartet wie N13 auf die Freigabe des Snapshot-Vertrags.
 */
import { describe, expect, it } from 'vitest';

import { companyNameCarriesLegalForm, formatCompanyLegalName } from '../company/companyLegalName';
import { buildCanonicalEInvoice } from '../einvoice/canonicalEInvoiceBuilder';
import { checkZugferdPdfXmlConsistency } from '../einvoice/zugferd/zugferdPdfXmlConsistency';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import { buildDefaultEmailSignature } from '../delivery/deliveryMailComposer';
import { companyDisplayName } from '../delivery/documentDeliveryDefaults';
import { buildReceiptCompanyLines } from '../employee/payoutReceiptModel';
import { buildCommunicationDraft } from '../communicationDraftService';
import { renderAllChannels, splitTrailingClosing } from '../communicationChannelService';
import type { CommunicationContext, CommunicationDraft } from '../../types/communication';
import type { CompanyProfile, CustomerBilling, VorgangInvoice } from '../../types/models';

describe('N14 — Firmierung', () => {
  it('F1: die Rechtsform steht genau einmal', () => {
    expect(formatCompanyLegalName('Muster Handwerk GmbH', 'GmbH')).toBe('Muster Handwerk GmbH');
    expect(formatCompanyLegalName('Muster Handwerk', 'GmbH')).toBe('Muster Handwerk GmbH');
    expect(formatCompanyLegalName('Muster GmbH & Co. KG', 'GmbH & Co KG')).toBe('Muster GmbH & Co. KG');
    expect(formatCompanyLegalName('muster bau gmbh', 'GmbH')).toBe('muster bau gmbh');
    expect(formatCompanyLegalName('  Muster   Bau ', ' GmbH ')).toBe('Muster Bau GmbH');
    expect(formatCompanyLegalName('Muster Bau', '')).toBe('Muster Bau');
    expect(formatCompanyLegalName('', 'GmbH')).toBe('GmbH');
  });

  it('F2: ein Wortteil zählt nicht', () => {
    expect(companyNameCarriesLegalForm('Bauwerk Prag', 'AG')).toBe(false);
    expect(formatCompanyLegalName('Bauwerk Prag', 'AG')).toBe('Bauwerk Prag AG');
    expect(formatCompanyLegalName('Schmidt eK', 'e.K.')).toBe('Schmidt eK');
  });

  const SELLER = {
    companyName: 'Muster Handwerk GmbH',
    legalForm: 'GmbH',
    street: 'Werkstraße 12',
    zip: '80331',
    city: 'München',
    country: 'Deutschland',
    countryCode: 'DE',
    contactPerson: 'Frau Muster',
    phone: '089 123456',
    email: 'rechnung@muster-handwerk.invalid',
    taxNumber: '143/123/45678',
    vatId: 'DE123456789',
    iban: 'DE89370400440532013000',
    bic: 'COBADEFFXXX',
    accountHolder: 'Muster Handwerk GmbH',
  } as unknown as CompanyProfile;

  const BUYER: CustomerBilling = {
    name: 'AZ Testbau GmbH',
    contactPerson: 'Herr Kunde',
    street: 'Industriestraße 1',
    zip: '33602',
    city: 'Bielefeld',
    email: 'einkauf@az-testbau.invalid',
    phone: '0521 1',
    countryCode: 'DE',
    buyerReference: 'REF-1',
  };

  const RECHNUNG = {
    id: 'inv-n14',
    number: '2026-0099',
    type: 'rechnung',
    positions: [{ id: 'p1', description: 'Wartung', quantity: 10, unit: 'Stunden', unitPrice: 100, lineTotal: 1000 }],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'vorbereitet',
    date: '2026-09-24',
    issueDate: '2026-09-24',
    createdAt: '2026-09-24T08:00:00.000Z',
    servicePeriodFrom: '2026-09-01',
    servicePeriodTo: '2026-09-24',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-10-08',
    currencyCode: 'EUR',
    customerSnapshot: BUYER,
    companySnapshot: SELLER,
    legalNotices: [],
    previousAbschlagDeductions: [],
  } as unknown as VorgangInvoice;

  it('F3: BT-27 und die PDF/XML-Gleichheit nutzen dieselbe Firmierung', () => {
    const canonical = buildCanonicalEInvoice(RECHNUNG, { profile: 'en16931' });
    expect(canonical.ok, canonical.ok ? '' : JSON.stringify(canonical.issues)).toBe(true);
    if (!canonical.ok) return;
    expect(canonical.value.seller.name).toBe('Muster Handwerk GmbH');
    expect(checkZugferdPdfXmlConsistency(buildInvoicePrintModelFromInvoice(RECHNUNG), canonical.value)).toEqual({ ok: true });
  });

  it('F4: Mail-Signatur, Versandname und Quittung ohne Doppelung', () => {
    expect(buildDefaultEmailSignature(SELLER, 'de')).toContain('Muster Handwerk GmbH');
    expect(buildDefaultEmailSignature(SELLER, 'de')).not.toContain('GmbH GmbH');
    expect(companyDisplayName({ companySnapshot: SELLER })).toBe('Muster Handwerk GmbH');
    expect(buildReceiptCompanyLines(SELLER)[0]).toBe('Muster Handwerk GmbH');
  });
});

describe('N15 — Briefschluss genau einmal', () => {
  const context: CommunicationContext = {
    ref: { type: 'vorgang', id: 'v-1' },
    companyName: 'Muster GmbH',
    recipient: { name: 'Kunde Müller' },
    facts: [],
    relevanceAllowed: true,
    disclaimer: 'Disclaimer',
    invoiceSummary: { number: '2026-0021', openAmount: 11.9, dueDate: '2026-09-15' },
  } as CommunicationContext;

  const volltext = (draft: CommunicationDraft | undefined) =>
    [draft?.greeting, draft?.body, draft?.closing].filter(Boolean).join('\n');
  const zaehle = (text: string, teil: string) => text.split(teil).length - 1;

  for (const intent of ['payment_reminder', 'dunning_notice'] as const) {
    it(`B1: ${intent} — E-Mail und Brief tragen Gruß und Firma genau einmal`, () => {
      const core = buildCommunicationDraft({ userText: '', userAnswers: { invoiceReference: '2026-0021' } }, context, intent);
      expect(core).not.toBeNull();
      const kanaele = renderAllChannels(core!, context);
      for (const kanal of [kanaele.email, kanaele.letter]) {
        const text = volltext(kanal);
        expect(zaehle(text, 'Mit freundlichen Grüßen'), text).toBe(1);
        expect(zaehle(text, 'Sehr geehrte'), text).toBe(1);
      }
      // Im Brief steht die Firma als Absender oben und einmal unter dem Gruß.
      expect(zaehle(volltext(kanaele.letter), 'Muster GmbH')).toBe(2);
      expect(zaehle(volltext(kanaele.email), 'Muster GmbH')).toBe(1);
    });
  }

  it('B2: die Kurzfassung trägt ihren eigenen Gruß und die Firma einmal', () => {
    const core = buildCommunicationDraft({ userText: '', userAnswers: { invoiceReference: '2026-0021' } }, context, 'payment_reminder');
    const kurz = volltext(renderAllChannels(core!, context).whatsapp);
    expect(zaehle(kurz, 'Muster GmbH'), kurz).toBe(1);
    expect(kurz).not.toContain('Mit freundlichen Grüßen');
  });

  it('B3: der Brief nennt das Datum deutsch, nicht als ISO-Text', () => {
    const core = buildCommunicationDraft({ userText: '', userAnswers: { invoiceReference: '2026-0021' } }, context, 'dunning_notice');
    const brief = renderAllChannels(core!, context).letter!.body;
    expect(brief.split('\n')[1]).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });

  it('B4: ein Entwurf ohne eigenen Schluss bekommt genau einen', () => {
    expect(splitTrailingClosing('Guten Tag,\n\nkurze Rückfrage.').closing).toBeNull();
    const ohneSchluss = { intent: 'improve_text', subject: 'Text', body: 'Guten Tag,\n\nkurze Rückfrage.', tone: 'formal', basedOnFacts: [], notIncluded: [] } as never;
    const mail = volltext(renderAllChannels(ohneSchluss, context).email);
    expect(zaehle(mail, 'Mit freundlichen Grüßen')).toBe(1);
    expect(splitTrailingClosing('Text\n\nMit freundlichen Grüßen\nMuster GmbH').closing).toBe('Mit freundlichen Grüßen\nMuster GmbH');
  });
});
