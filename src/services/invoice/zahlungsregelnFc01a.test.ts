/**
 * FINANZ-CORE-01A — Zahlungsregeln (ZAH-15, ZAH-16, ZAH-08, ZAH-12, ZAH-05).
 *
 *  S1  „1 Tag"-Skonto: Satz und Parser passen zusammen; Mehrzahl und Fremdwörter unverändert
 *  S2  „1 Tag"-Skonto wirkt im Zahlungsstand: fristgerecht gekürzt gezahlt = nichts mehr offen
 *  G1  Überfälligkeit nach Geschäftstag: 0:30 Uhr am Folgetag überfällig, 23:30 am Fälligkeitstag nicht
 *  O1  offen = offener Betrag: offen, teilbezahlt, überfällig — nicht bezahlt, nicht storniert
 *  O2  Assistent „offene Rechnungen": teilbezahlte Rechnung dabei, Summe exakt, Datum deutsch
 *  M1  Mahnung vor oder am Zahlungsziel wird nicht dokumentiert; Erinnerung schon
 *  M2  Mahnung nach dem Zahlungsziel wird dokumentiert
 *  K1  kein Erinnerungsentwurf zu bezahlter, stornierter oder nicht versendeter Rechnung
 *  K2  keine Mahnung vor dem Zahlungsziel; eine Erinnerung bleibt möglich
 *  K3  Mahnentwurf nach dem Zahlungsziel nennt das Datum deutsch
 *  F1  Mahnvorschlag erst eine Woche nach der dokumentierten Erinnerung
 *  Z1  (ZAH-10) das Zahlungsziel folgt einem geänderten Rechnungsdatum; ausdrücklich gesetzt geht vor
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgang } from '../../test/fixtures';
import { buildSkontoText, parseSkontoFromText } from '../invoiceTaxService';
import { updateInvoiceDraftMetadata } from '../invoiceService';
import type { InvoiceDraft } from '../../types/models';
import { getOpenAmount, getOverdueDays, isInvoiceOverdue } from '../invoicePaymentService';
import { getOutstandingInvoices } from '../invoiceOverviewService';
import { answerQuestion } from '../officeAssistantService';
import { documentDunningDelivery, resetDunningDocumentations } from '../dunningDocumentationService';
import { processCommunicationRequest } from '../communicationOrchestrator';
import { analyzeInvoiceFinance } from '../brain/financeIntelligenceService';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateInvoiceStore } from './invoiceStore';
import { hydrateVorgangStore } from '../vorgangService';
import { hydrateDocumentStore } from '../documentService';
import { hydrateInboxStore } from '../inboxService';
import { setTaskStoreForTests } from '../taskStore';
import * as persistenceService from '../persistenceService';
import type { CompanyProfile, InvoicePayment, VorgangInvoice } from '../../types/models';

const FREE_ID = 'inv-zah-frei';

function payment(amount: number, date: string): InvoicePayment {
  return { id: `pay-${amount}-${date}`, amount, date, createdAt: `${date}T09:00:00.000Z` } as InvoicePayment;
}

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: FREE_ID,
    number: 'RE-2026-0901',
    type: 'rechnung',
    positions: [],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    sentAt: '2026-09-01',
    sentVia: 'email',
    date: '2026-09-01',
    createdAt: '2026-09-01T08:00:00.000Z',
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

function hydrateFree(free: VorgangInvoice): void {
  hydrateVorgangStore([]);
  hydrateInvoiceStore([{ invoice: free, vorgangId: null }]);
}

function draftBodies(result: ReturnType<typeof processCommunicationRequest>): string {
  return Object.values(result.drafts ?? {})
    .map((draft) => draft?.body ?? '')
    .join('\n');
}

beforeEach(() => {
  localStorage.clear();
  resetDunningDocumentations();
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Muster GmbH', currency: 'EUR' });
  vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: true } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ZAH-15 — Skonto mit einem Tag Frist', () => {
  it('S1: der eigene Satz „1 Tag" wird gelesen, Mehrzahl und Fremdwörter bleiben wie bisher', () => {
    const sentence = buildSkontoText({
      ...DEFAULT_COMPANY_PROFILE,
      skontoEnabled: true,
      skontoPercent: 2,
      skontoDays: 1,
    } as CompanyProfile);
    expect(sentence).toBe('Bei Zahlung innerhalb von 1 Tag gewähren wir 2 % Skonto.');
    expect(parseSkontoFromText(sentence)).toEqual({ percent: 2, days: 1 });
    expect(parseSkontoFromText('3 % Skonto bei Zahlung innerhalb von 10 Tagen')).toEqual({ percent: 3, days: 10 });
    expect(parseSkontoFromText('14 Tage netto, 2,5 % Skonto')).toEqual({ percent: 2.5, days: 14 });
    expect(parseSkontoFromText('Tagung am Montag, 2 % Rabatt')).toBeNull();
  });

  it('S2: fristgerecht gekürzt gezahlt ist beglichen, verspätet bleibt der Rest offen', () => {
    const skontoText = 'Bei Zahlung innerhalb von 1 Tag gewähren wir 2 % Skonto.';
    const base = { amount: 1000, subtotal: 840.34, issueDate: '2026-09-01', skontoText };
    expect(getOpenAmount(invoice({ ...base, payments: [payment(980, '2026-09-02')] }))).toBe(0);
    expect(getOpenAmount(invoice({ ...base, payments: [payment(980, '2026-09-03')] }))).toBe(20);
  });
});

describe('ZAH-16 — Überfälligkeit nach Geschäftstag', () => {
  it('G1: 0:30 Uhr am Tag nach der Fälligkeit ist überfällig, 23:30 Uhr am Fälligkeitstag nicht', () => {
    /*
     * Ortszeit-Konstruktor: In Deutschland liegt 0:30 Uhr am 11.10. im UTC-Tag
     * 10.10. — genau dort sah die alte Rechnung noch keinen Verzug.
     */
    // Ein Mittwoch: Hier geht es um den Geschäftstag, nicht um § 193 BGB (dafür G2).
    const due = invoice({ paymentDueDate: '2026-10-14' });
    expect(isInvoiceOverdue(due, new Date(2026, 9, 15, 0, 30))).toBe(true);
    expect(isInvoiceOverdue(due, new Date(2026, 9, 14, 23, 30))).toBe(false);
  });

  it('G2 (ZAH-10): § 193 BGB — eine am Samstag fällige Rechnung ist am Montag noch nicht überfällig', () => {
    const samstag = invoice({ paymentDueDate: '2026-10-10' });
    expect(isInvoiceOverdue(samstag, new Date(2026, 9, 12, 23, 30))).toBe(false);
    expect(isInvoiceOverdue(samstag, new Date(2026, 9, 13, 0, 30))).toBe(true);
    const sonntag = invoice({ paymentDueDate: '2026-10-11' });
    expect(isInvoiceOverdue(sonntag, '2026-10-12')).toBe(false);
    expect(isInvoiceOverdue(sonntag, '2026-10-13')).toBe(true);
    expect(getOverdueDays(sonntag, '2026-10-15')).toBe(3);
  });
});

describe('ZAH-08 — offen heißt offener Betrag', () => {
  beforeEach(() => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-zah-offen',
        title: 'Sanierung Schmidt',
        customer: 'Bauherr Schmidt',
        invoices: [
          invoice({ id: 'inv-o-offen', number: '2026-0911', paymentDueDate: '2099-12-31' }),
          invoice({
            id: 'inv-o-teil',
            number: '2026-0912',
            paymentDueDate: '2099-12-31',
            payments: [payment(190, '2026-09-10')],
          }),
          invoice({ id: 'inv-o-verzug', number: '2026-0913', paymentDueDate: '2026-01-01' }),
          invoice({
            id: 'inv-o-bezahlt',
            number: '2026-0914',
            payments: [payment(1190, '2026-09-10')],
            paymentStatus: 'bezahlt',
          }),
          invoice({
            id: 'inv-o-storno',
            number: '2026-0915',
            paymentStatus: 'storniert',
            cancelledAt: '2026-09-20T10:00:00.000Z',
          }),
        ],
      }),
    ]);
  });

  it('O1: offen, teilbezahlt und überfällig zählen; bezahlt und storniert nicht', () => {
    const numbers = getOutstandingInvoices('2026-10-11').map((item) => item.invoice.number).sort();
    expect(numbers).toEqual(['2026-0911', '2026-0912', '2026-0913']);
  });

  it('O2: der Assistent nennt die teilbezahlte Rechnung, rechnet exakt und schreibt das Datum deutsch', () => {
    // Wie officeAssistantService.test: ohne Beispielbelege und Ordner, damit die Suche nicht vorgreift.
    hydrateInboxStore([]);
    hydrateDocumentStore([]);
    setTaskStoreForTests([]);
    /*
     * „Welche Rechnungen sind offen?" beantwortet bewusst zuerst die Suche
     * (officeSearchService.isSearchQuestion); hier geht es um die
     * Rechnungsantwort selbst, deshalb die Formulierung des Rechnungs-Intents.
     */
    const answer = answerQuestion('Was ist offen bei den Rechnungen?', '2026-10-11');
    expect(answer.summary).toContain('3 offene Rechnungen');
    expect(answer.summary).toContain('3.380,00');
    const partial = answer.bullets.find((bullet) => bullet.startsWith('2026-0912'));
    expect(partial).toContain('1.000,00');
    expect(partial).toContain('– teilbezahlt');
    const overdue = answer.bullets.find((bullet) => bullet.startsWith('2026-0913'));
    expect(overdue).toContain('fällig 01.01.2026');
    expect(overdue).toContain('– überfällig');
    expect(answer.bullets.join('\n')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('ZAH-12 — Mahndokumentation erst nach dem Zahlungsziel', () => {
  beforeEach(() => hydrateFree(invoice()));

  it('M1: eine Mahnung vor oder am Zahlungsziel wird abgelehnt, eine Erinnerung nicht', () => {
    for (const documentedAt of ['2026-09-10', '2026-09-15']) {
      expect(
        documentDunningDelivery(null, FREE_ID, { kind: 'dunning_notice', documentedAt, deliveryMethod: 'post' }),
      ).toEqual({ ok: false, reason: 'not_overdue' });
    }
    const reminder = documentDunningDelivery(null, FREE_ID, {
      kind: 'payment_reminder',
      documentedAt: '2026-09-10',
      deliveryMethod: 'email',
    });
    expect(reminder.ok).toBe(true);
  });

  it('M2: eine Mahnung nach dem Zahlungsziel wird dokumentiert', () => {
    const notice = documentDunningDelivery(null, FREE_ID, {
      kind: 'dunning_notice',
      documentedAt: '2026-09-16',
      deliveryMethod: 'post',
    });
    expect(notice.ok).toBe(true);
  });
});

describe('ZAH-12 — Erinnerungs- und Mahnentwürfe nur, wo sie stimmen', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 11, 10, 0));
  });

  const ask = (userText: string) =>
    processCommunicationRequest({ userText, contextRef: { type: 'invoice', id: FREE_ID } });

  it('K1: bezahlt, storniert oder nicht versendet — kein Entwurf, sondern ein ehrlicher Hinweis', () => {
    hydrateFree(invoice({ payments: [payment(1190, '2026-09-10')], paymentStatus: 'bezahlt' }));
    expect(ask('Bitte eine Zahlungserinnerung schreiben')).toMatchObject({
      status: 'blocked',
      summary: 'communication.block.invoiceSettled',
    });

    hydrateFree(invoice({ paymentStatus: 'storniert', cancelledAt: '2026-09-20T10:00:00.000Z' }));
    expect(ask('Bitte eine Mahnung schreiben')).toMatchObject({
      status: 'blocked',
      summary: 'communication.block.invoiceCancelled',
    });

    hydrateFree(invoice({ status: 'vorbereitet', sentAt: undefined, sentVia: undefined }));
    expect(ask('Bitte eine Zahlungserinnerung schreiben')).toMatchObject({
      status: 'blocked',
      summary: 'communication.block.invoiceNotSent',
    });
  });

  it('K2: vor dem Zahlungsziel keine Mahnung, aber eine Erinnerung mit deutschem Datum', () => {
    hydrateFree(invoice({ paymentDueDate: '2026-10-20' }));
    expect(ask('Bitte eine Mahnung schreiben')).toMatchObject({
      status: 'blocked',
      summary: 'communication.block.invoiceNotDue',
    });
    const reminder = ask('Bitte eine Zahlungserinnerung schreiben');
    expect(reminder.status).toBe('complete');
    expect(draftBodies(reminder)).toContain('Zahlungsziel: 20.10.2026');
  });

  it('K3: nach dem Zahlungsziel entsteht die Mahnung — mit deutschem, nicht ISO-Datum', () => {
    hydrateFree(invoice());
    const notice = ask('Bitte eine Mahnung schreiben');
    expect(notice.status).toBe('complete');
    const body = draftBodies(notice);
    expect(body).toContain('Zahlungsziel: 15.09.2026');
    expect(body).not.toContain('2026-09-15');
  });
});

describe('ZAH-05 — Mahnung folgt der dokumentierten Erinnerung', () => {
  it('F1: eine Woche Abstand zur Erinnerung, nicht nur sieben Tage Verzug', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-zah-mahn',
        title: 'Fassade Weber',
        invoices: [invoice({ id: 'inv-zah-mahn', number: 'RE-2026-0950', paymentDueDate: '2026-06-20' })],
      }),
    ]);
    const reminder = documentDunningDelivery('v-zah-mahn', 'inv-zah-mahn', {
      kind: 'payment_reminder',
      documentedAt: '2026-06-26',
      deliveryMethod: 'email',
    });
    expect(reminder.ok).toBe(true);

    // 11 Tage Verzug, aber erst 5 Tage seit der Erinnerung: noch keine Mahnung.
    const early = analyzeInvoiceFinance('v-zah-mahn', 'inv-zah-mahn', '2026-07-01');
    expect(early?.recommendations.some((r) => r.id === 'mahnung')).toBe(false);

    // 7 Tage nach der Erinnerung: jetzt die Mahnung.
    const due = analyzeInvoiceFinance('v-zah-mahn', 'inv-zah-mahn', '2026-07-03');
    expect(due?.recommendations.some((r) => r.id === 'mahnung')).toBe(true);
  });
});

describe('ZAH-10 — Zahlungsziel folgt dem Rechnungsdatum', () => {
  const entwurf = (issueDate: string, paymentDueDate: string) =>
    ({ issueDate, paymentDueDate, customerBilling: {} } as unknown as InvoiceDraft);

  it('Z1: die Frist bleibt, ein ausdrückliches Datum geht vor, leer bleibt leer', () => {
    // 14 Tage Frist: 01.09. → 15.09.; neues Rechnungsdatum 10.09. → 24.09.
    expect(updateInvoiceDraftMetadata(entwurf('2026-09-01', '2026-09-15'), { issueDate: '2026-09-10' }).paymentDueDate).toBe(
      '2026-09-24',
    );
    // Über den Monatswechsel, ohne Zeitzonenlücke.
    expect(updateInvoiceDraftMetadata(entwurf('2026-10-20', '2026-11-03'), { issueDate: '2026-10-25' }).paymentDueDate).toBe(
      '2026-11-08',
    );
    // Im selben Schritt gesetzt: dieses Datum gilt.
    expect(
      updateInvoiceDraftMetadata(entwurf('2026-09-01', '2026-09-15'), { issueDate: '2026-09-10', paymentDueDate: '2026-09-30' })
        .paymentDueDate,
    ).toBe('2026-09-30');
    // Kein Fälligkeitsdatum (eigene Auftragskonditionen) bleibt leer; ein unvollständiges Datum verschiebt nichts.
    expect(updateInvoiceDraftMetadata(entwurf('2026-09-01', ''), { issueDate: '2026-09-10' }).paymentDueDate).toBe('');
    expect(updateInvoiceDraftMetadata(entwurf('2026-09-01', '2026-09-15'), { issueDate: '' }).paymentDueDate).toBe('2026-09-15');
  });
});
