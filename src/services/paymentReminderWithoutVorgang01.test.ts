/**
 * PAYMENT-REMINDER-WITHOUT-VORGANG-01 — Zahlungserinnerung auch ohne Auftrag.
 *
 *  A  Kommunikationskontext einer freien Rechnung (ohne vorgangId): Kunde,
 *     Nummer, Datum, Fälligkeit, Beträge aus dem eigenen Snapshot
 *  B  Vorgangsrechnung unverändert (Auftragszeile bleibt, Werte identisch)
 *  C  offener Betrag nach Teilzahlung; D vollständig bezahlt; E storniert
 *  F  Mahnstufen-/Dokumentationslogik für die freie Rechnung
 *  G  keine unbeabsichtigte Duplikation
 *  H  Link/Ref-Auflösung ohne erfundene Auftragskennung
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { createTestVorgang } from '../test/fixtures';
import { buildCommunicationContext } from './communicationContextService';
import {
  buildKommunikationPath,
  parseContextRefFromSearchParams,
} from '../components/communication/communicationNavigation';
import {
  canDocumentDunningForInvoice,
  documentDunningDelivery,
  getDocumentedDunningLevel,
  getDunningDocumentationsForInvoice,
  getLatestDunningDocumentation,
  resetDunningDocumentations,
} from './dunningDocumentationService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { hydrateInvoiceStore } from './invoice/invoiceStore';
import { hydrateVorgangStore } from './vorgangService';
import { recordPayment } from './invoicePaymentService';
import * as persistenceService from './persistenceService';
import type { VorgangInvoice } from '../types/models';

const FREE_ID = 'inv-free-reminder';
const VORGANG_ID = 'v-reminder';
const VORGANG_INVOICE_ID = 'inv-vorgang-reminder';

function sentInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: FREE_ID,
    number: 'RE-2026-0013',
    type: 'rechnung',
    positions: [],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    sentAt: '2026-09-01',
    sentVia: 'email',
    date: '2026-09-01',
    createdAt: '2026-09-01T00:00:00.000Z',
    issueDate: '2026-09-01',
    paymentDueDate: '2026-09-15',
    customerSnapshot: {
      name: 'Bauherr Schmidt',
      contactPerson: '',
      street: 'Weg 1',
      zip: '10115',
      city: 'Berlin',
      email: 'schmidt@example.invalid',
      phone: '',
    },
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Muster GmbH' },
    legalNotices: [],
    previousAbschlagDeductions: [],
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

function hydrate(free: VorgangInvoice = sentInvoice()): void {
  const vorgangInvoice = sentInvoice({ id: VORGANG_INVOICE_ID, number: 'RE-2026-0014' });
  /* Reihenfolge zählt: `hydrateVorgangStore` baut den Rechnungsspeicher neu auf. */
  hydrateVorgangStore([
    createTestVorgang({
      id: VORGANG_ID,
      title: 'Bad Sanierung',
      customer: 'Bauherr Schmidt',
      invoices: [vorgangInvoice],
    }),
  ]);
  hydrateInvoiceStore([
    { invoice: free, vorgangId: null },
    { invoice: vorgangInvoice, vorgangId: VORGANG_ID },
  ]);
}

beforeEach(() => {
  resetDunningDocumentations();
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Muster GmbH', currency: 'EUR' });
  hydrate();
  vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: true } as never);
});

describe('A/H — Kommunikationskontext der freien Rechnung', () => {
  it('ohne vorgangId entsteht ein vollständiger Kontext aus dem Rechnungs-/Kundensnapshot', () => {
    const context = buildCommunicationContext({ type: 'invoice', id: FREE_ID });
    expect(context.relevanceAllowed).toBe(true);
    expect(context.relevanceBlockReason).toBeUndefined();
    expect(context.recipient).toEqual({ name: 'Bauherr Schmidt', organization: 'Bauherr Schmidt' });
    expect(context.subject).toBe('Rechnung RE-2026-0013');
    expect(context.invoiceSummary).toMatchObject({
      id: FREE_ID,
      number: 'RE-2026-0013',
      amount: 1190,
      openAmount: 1190,
      paidAmount: 0,
      dueDate: '2026-09-15',
      issueDate: '2026-09-01',
      currency: 'EUR',
      customerName: 'Bauherr Schmidt',
    });
    // Ohne Auftrag gibt es keine Auftragszeile — und keinen erfundenen Titel.
    expect(context.invoiceSummary?.vorgangTitle).toBeUndefined();
    expect(context.vorgangSummary).toBeUndefined();
    const factKeys = context.facts.map((fact) => fact.key);
    expect(factKeys).toContain('invoice:number');
    expect(factKeys).toContain('invoice:openAmount');
    expect(factKeys).toContain('invoice:dueDate');
  });

  it('H: Link und Rückauflösung tragen keine erfundene Auftragskennung', () => {
    const path = buildKommunikationPath({ type: 'invoice', id: FREE_ID });
    expect(path).toBe(`/kommunikation?context=invoice&id=${FREE_ID}`);
    expect(path).not.toContain('vorgangId');
    expect(parseContextRefFromSearchParams(new URLSearchParams(path.split('?')[1]))).toEqual({
      type: 'invoice',
      id: FREE_ID,
    });
    const withVorgang = new URLSearchParams(`context=invoice&id=${VORGANG_INVOICE_ID}&vorgangId=${VORGANG_ID}`);
    expect(parseContextRefFromSearchParams(withVorgang)).toEqual({
      type: 'invoice',
      id: VORGANG_INVOICE_ID,
      vorgangId: VORGANG_ID,
    });
  });

  it('unbekannte Rechnung wird sauber blockiert statt halb befüllt', () => {
    const context = buildCommunicationContext({ type: 'invoice', id: 'inv-gibt-es-nicht' });
    expect(context.relevanceAllowed).toBe(false);
    expect(context.relevanceBlockReason).toBe('communication.block.invoiceNotFound');
    expect(context.invoiceSummary).toBeUndefined();
  });
});

describe('B — Vorgangsrechnung unverändert', () => {
  it('Kontext behält Auftragszeile, Kunde und Beträge', () => {
    const context = buildCommunicationContext({
      type: 'invoice',
      id: VORGANG_INVOICE_ID,
      vorgangId: VORGANG_ID,
    });
    expect(context.invoiceSummary).toMatchObject({
      id: VORGANG_INVOICE_ID,
      number: 'RE-2026-0014',
      openAmount: 1190,
      vorgangTitle: 'Bad Sanierung',
    });
    expect(context.vorgangSummary).toMatchObject({ id: VORGANG_ID, title: 'Bad Sanierung' });
    expect(context.recipient?.name).toBe('Bauherr Schmidt');
  });
});

describe('C/D/E — Zahlungsstand und Storno', () => {
  it('C: Teilzahlung — offener Restbetrag im Kontext, weiterhin mahnbar', () => {
    const paid = recordPayment(null, FREE_ID, { date: '2026-09-10', amount: 190 });
    expect(paid.success).toBe(true);
    const context = buildCommunicationContext({ type: 'invoice', id: FREE_ID });
    expect(context.invoiceSummary).toMatchObject({ amount: 1190, paidAmount: 190, openAmount: 1000 });
    expect(context.facts.some((fact) => fact.key === 'invoice:paidAmount')).toBe(true);
    const invoice = paid.success ? paid.invoice : undefined;
    expect(canDocumentDunningForInvoice(invoice!)).toBe(true);
  });

  it('D: vollständig bezahlt — nicht mahnbar, Dienst lehnt ab', () => {
    const paid = recordPayment(null, FREE_ID, { date: '2026-09-10', amount: 1190 });
    expect(paid.success).toBe(true);
    const invoice = paid.success ? paid.invoice : undefined;
    expect(canDocumentDunningForInvoice(invoice!)).toBe(false);
    expect(documentDunningDelivery(null, FREE_ID, { kind: 'payment_reminder', documentedAt: '2026-09-20', deliveryMethod: 'email' })).toEqual({
      ok: false,
      reason: 'not_open',
    });
    expect(getDunningDocumentationsForInvoice(null, FREE_ID)).toHaveLength(0);
  });

  it('E: stornierte Rechnung — nicht mahnbar, Dienst lehnt ab', () => {
    hydrate(sentInvoice({ cancelledAt: '2026-09-12T10:00:00.000Z', cancelReason: 'Doppelt' }));
    const cancelled = sentInvoice({ cancelledAt: '2026-09-12T10:00:00.000Z' });
    expect(canDocumentDunningForInvoice(cancelled)).toBe(false);
    expect(documentDunningDelivery(null, FREE_ID, { kind: 'payment_reminder', documentedAt: '2026-09-20', deliveryMethod: 'email' })).toEqual({
      ok: false,
      reason: 'not_sent',
    });
  });

  it('Entwurf/vorbereitet ist nicht mahnbar', () => {
    expect(canDocumentDunningForInvoice(sentInvoice({ status: 'entwurf' }))).toBe(false);
    expect(canDocumentDunningForInvoice(sentInvoice({ status: 'vorbereitet' }))).toBe(false);
  });
});

describe('F/G — Mahnstufe und Duplikatschutz ohne Auftrag', () => {
  it('F: Erinnerung dokumentieren → Stufe 1, Mahnung → Stufe 2; Anzeige findet den Eintrag wieder', () => {
    expect(getDocumentedDunningLevel(null, FREE_ID)).toBe(0);
    const first = documentDunningDelivery(null, FREE_ID, { kind: 'payment_reminder', documentedAt: '2026-09-20', deliveryMethod: 'email' });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.documentation.vorgangId).toBeNull();
    expect(getDocumentedDunningLevel(null, FREE_ID)).toBe(1);
    expect(getLatestDunningDocumentation(null, FREE_ID)).toMatchObject({ kind: 'payment_reminder', documentedAt: '2026-09-20' });

    const second = documentDunningDelivery(null, FREE_ID, { kind: 'dunning_notice', documentedAt: '2026-09-27', deliveryMethod: 'post' });
    expect(second.ok).toBe(true);
    expect(getDocumentedDunningLevel(null, FREE_ID)).toBe(2);
    expect(getDunningDocumentationsForInvoice(null, FREE_ID)).toHaveLength(2);
  });

  it('G: dieselbe Übergabe zweimal bestätigt erzeugt keinen zweiten Eintrag; eine andere Angabe schon', () => {
    const input = { kind: 'payment_reminder' as const, documentedAt: '2026-09-20', deliveryMethod: 'email' as const };
    const first = documentDunningDelivery(null, FREE_ID, input);
    const replay = documentDunningDelivery(null, FREE_ID, input);
    expect(first.ok && replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.alreadyDocumented).toBe(true);
      expect(first.ok && replay.documentation.id).toBe(first.ok ? first.documentation.id : '');
    }
    expect(getDunningDocumentationsForInvoice(null, FREE_ID)).toHaveLength(1);

    const later = documentDunningDelivery(null, FREE_ID, { ...input, documentedAt: '2026-09-25' });
    expect(later.ok).toBe(true);
    if (later.ok) expect(later.alreadyDocumented).toBeUndefined();
    expect(getDunningDocumentationsForInvoice(null, FREE_ID)).toHaveLength(2);
  });

  it('Mahnstände von freier Rechnung und Vorgangsrechnung werden nicht vermischt', () => {
    documentDunningDelivery(null, FREE_ID, { kind: 'payment_reminder', documentedAt: '2026-09-20', deliveryMethod: 'email' });
    documentDunningDelivery(VORGANG_ID, VORGANG_INVOICE_ID, { kind: 'dunning_notice', documentedAt: '2026-09-21', deliveryMethod: 'post' });
    expect(getDocumentedDunningLevel(null, FREE_ID)).toBe(1);
    expect(getDocumentedDunningLevel(VORGANG_ID, VORGANG_INVOICE_ID)).toBe(2);
    expect(getDunningDocumentationsForInvoice(null, VORGANG_INVOICE_ID)).toHaveLength(0);
  });
});
