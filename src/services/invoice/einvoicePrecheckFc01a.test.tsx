/**
 * FINANZ-CORE-01A (KUN-02) — E-Rechnungs-Vorprüfung vor der Freigabe.
 *
 *  E1  der Altbeleg-Hinweis nur bei fehlender Währung (echter Beleg vor 04B)
 *  E2  der Prüfkandidat zeigt, was einer E-Rechnung fehlen würde — vor der Freigabe
 *  E3  mit E-Rechnungs-Angaben beim Empfänger ist der Hinweis vordringlich
 *  E4  ein Entwurf mit Freigabesperre wird nicht vorgeprüft
 *  E5  der Hinweis: aufgeklappt bei Erwartung, sonst eingeklappt, ohne Befund nichts
 *  E6  AUS-18: fehlen nur XRechnung-Angaben, sagt der Hinweis, dass ZUGFeRD geht
 *  E7  AUS-18: fehlt auch eine Angabe nach EN 16931, bleibt der allgemeine Hinweis
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EInvoicePrecheckNotice } from '../../components/invoice/EInvoicePrecheckNotice';
import { t } from '../../i18n';
import { looksLikeLegacyInvoice } from '../einvoice/einvoiceIssueText';
import type { CanonicalEInvoiceIssue } from '../einvoice/canonicalEInvoice';
import { buildInvoiceDraftForType } from '../invoiceService';
import { hydrateVorgangStore } from '../vorgangService';
import { precheckInvoiceDraftForEInvoice } from './invoiceEInvoicePrecheck';
import { createOrderPosition, createTestVorgang, testSetup } from '../../test/fixtures';
import type { InvoiceDraft } from '../../types/models';

const VORGANG_ID = 'v-test-1';

function issue(code: CanonicalEInvoiceIssue['code']): CanonicalEInvoiceIssue {
  return { code, path: 'x' } as CanonicalEInvoiceIssue;
}

function draft(overrides: Partial<InvoiceDraft> = {}): InvoiceDraft {
  hydrateVorgangStore([
    createTestVorgang({
      id: VORGANG_ID,
      materialSource: 'betrieb',
      orderPositions: [
        // Erfasste Ausführung, damit die Rechnung ihre Menge vorbelegt.
        createOrderPosition({ id: 'op-1', plannedQuantity: 2, executedQuantity: 2, unit: 'Stück', unitPrice: 100, category: 'arbeit' }),
      ],
    }),
  ]);
  const base = buildInvoiceDraftForType(VORGANG_ID, testSetup, 'rechnung');
  expect(base).not.toBeNull();
  return {
    ...base!,
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-20',
    servicePeriodConfirmed: true,
    companySnapshot: {
      ...base!.companySnapshot,
      companyName: 'Muster GmbH',
      street: 'Musterallee 5',
      zip: '30000',
      city: 'Musterstadt',
      // FINANZ-CORE-01A (RE-09) — Steuer-ID ist Freigabepflicht; ohne sie entstünde gar kein Kandidat.
      taxNumber: '133/8150/8159',
      contactPerson: '',
      phone: '',
    },
    ...overrides,
  };
}

describe('KUN-02 — Altbeleg-Hinweis', () => {
  it('E1: nur die fehlende Währung kennzeichnet einen Altbeleg', () => {
    expect(looksLikeLegacyInvoice([issue('currency_missing')])).toBe(true);
    expect(looksLikeLegacyInvoice([issue('buyer_reference_missing')])).toBe(false);
    expect(looksLikeLegacyInvoice([issue('buyer_country_missing')])).toBe(false);
  });
});

describe('KUN-02 — Vorprüfung des Freigabekandidaten', () => {
  it('E2: fehlender Ansprechpartner und fehlende Käuferreferenz fallen vor der Freigabe auf', () => {
    const result = precheckInvoiceDraftForEInvoice(VORGANG_ID, draft(), testSetup);
    const codes = result.issues.map((entry) => entry.code);
    expect(codes).toContain('seller_contact_missing');
    expect(codes).toContain('buyer_reference_missing');
    expect(codes).not.toContain('source_not_finalized');
    expect(result.eInvoiceExpected).toBe(false);
  });

  it('E3: eine Käuferreferenz beim Empfänger macht den Hinweis vordringlich', () => {
    const base = draft();
    const result = precheckInvoiceDraftForEInvoice(
      VORGANG_ID,
      { ...base, customerBilling: { ...base.customerBilling, buyerReference: '04011000-12345-67' } },
      testSetup,
    );
    expect(result.eInvoiceExpected).toBe(true);
    const codes = result.issues.map((entry) => entry.code);
    expect(codes).toContain('seller_contact_missing');
    expect(codes).not.toContain('buyer_reference_missing');
  });

  it('E4: blockiert die Freigabeprüfung, gibt es noch nichts vorzuprüfen', () => {
    const result = precheckInvoiceDraftForEInvoice(VORGANG_ID, draft({ servicePeriodConfirmed: false }), testSetup);
    expect(result.issues).toEqual([]);
  });
});

describe('KUN-02 — Hinweis in der Vorschau', () => {
  const translate = (key: Parameters<typeof t>[0]) => t(key);

  it('E5: aufgeklappt bei Erwartung, eingeklappt ohne, nichts ohne Befund', () => {
    const expected = renderToStaticMarkup(
      <EInvoicePrecheckNotice precheck={{ issues: [issue('seller_contact_missing')], eInvoiceExpected: true }} translate={translate} />,
    );
    expect(expected).toContain('data-testid="invoice-einvoice-precheck"');
    expect(expected).toContain('open=""');
    expect(expected).toContain('Ansprechpartner mit Telefonnummer');
    expect(expected).toContain(t('invoice.einvoicePrecheck.titleExpected'));

    const quiet = renderToStaticMarkup(
      <EInvoicePrecheckNotice precheck={{ issues: [issue('buyer_reference_missing')], eInvoiceExpected: false }} translate={translate} />,
    );
    expect(quiet).not.toContain('open=""');
    expect(quiet).toContain(t('invoice.einvoicePrecheck.title'));

    expect(
      renderToStaticMarkup(<EInvoicePrecheckNotice precheck={{ issues: [], eInvoiceExpected: true }} translate={translate} />),
    ).toBe('');
  });
});

describe('AUS-18 — Vorprüfung unterscheidet XRechnung und ZUGFeRD', () => {
  const translate = (key: Parameters<typeof t>[0]) => t(key);

  it('E6: fehlen nur XRechnung-Angaben, sagt der Hinweis, dass ZUGFeRD geht', () => {
    const base = draft();
    const result = precheckInvoiceDraftForEInvoice(
      VORGANG_ID,
      {
        ...base,
        // IBAN und USt-IdNr. gelten für beide Formate; es fehlen nur XRechnung-Angaben.
        companySnapshot: { ...base.companySnapshot, vatId: 'DE123456789', iban: 'DE89370400440532013000' } as InvoiceDraft['companySnapshot'],
        customerBilling: {
          ...base.customerBilling,
          countryCode: 'DE',
          email: 'kunde@example.invalid',
          buyerReference: '',
          leitwegId: '',
        },
      },
      testSetup,
    );
    const codes = result.issues.map((entry) => entry.code);
    expect(codes).toContain('seller_contact_missing');
    expect(codes).toContain('buyer_reference_missing');
    expect(result.onlyXRechnung, JSON.stringify(codes)).toBe(true);

    const html = renderToStaticMarkup(<EInvoicePrecheckNotice precheck={result} translate={translate} />);
    expect(html).toContain(t('invoice.einvoicePrecheck.hintXRechnungOnly'));
    expect(html).not.toContain(t('invoice.einvoicePrecheck.hint'));
  });

  it('E7: fehlt auch eine Angabe nach EN 16931, bleibt der allgemeine Hinweis', () => {
    // Nur die Steuernummer: BR-CO-26 gilt für beide Formate.
    const result = precheckInvoiceDraftForEInvoice(VORGANG_ID, draft(), testSetup);
    expect(result.issues.map((entry) => entry.code)).toContain('seller_identifier_missing');
    expect(result.onlyXRechnung).toBeUndefined();
    const html = renderToStaticMarkup(<EInvoicePrecheckNotice precheck={result} translate={translate} />);
    expect(html).toContain(t('invoice.einvoicePrecheck.hint'));
  });
});
