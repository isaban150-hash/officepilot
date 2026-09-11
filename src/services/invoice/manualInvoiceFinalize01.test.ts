/**
 * MANUAL-INVOICE-01B1 — die Freigabegrenze der Rechnung ohne Auftrag.
 *
 * Der Finalize-Validator ist die letzte Instanz vor der Cloud. Er muss zwei
 * Dinge zugleich können: die normale Rechnung **ohne** Auftrag annehmen und
 * Abschlag wie Schlussrechnung ohne Auftrag weiterhin abweisen — beide rechnen
 * gegen einen Auftragswert und sind ohne ihn nicht definiert.
 *
 * Ebenso wichtig ist, was **nicht** zulässig bleibt: Der Leerstring als
 * Ersatz für „kein Auftrag" wäre von einer echten Kennung nicht zu
 * unterscheiden und muss abgewiesen werden.
 *
 * Neutrale Beispieldaten, kein Netzwerk, keine Cloud.
 */
import { describe, expect, it } from 'vitest';
import {
  buildInvoicePayloadV1,
  PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
  PREPARED_FINALIZE_REQUEST_KIND,
  validatePreparedWorkspaceInvoiceFinalizeRequest,
} from './workspaceInvoiceFinalizeRequestValidator';
import { validateWorkspaceInvoiceCloudPayload } from './workspaceInvoiceCloudPayloadValidator';
import { canonicalJsonStringify } from './invoicePreparedResponseProjection';
import type { InvoiceDocumentType, VorgangInvoice } from '../../types/models';

const COMPANY = {
  companyName: 'Test GmbH',
  legalForm: 'GmbH',
  street: 'Teststr. 1',
  zip: '12345',
  city: 'Teststadt',
  country: 'Deutschland',
  contactPerson: 'Max Muster',
  phone: '030',
  email: 'info@test.de',
  website: '',
  taxNumber: '27/123/45678',
  vatId: 'DE123456789',
  bankName: 'Sparkasse',
  iban: 'DE89370400440532013000',
  bic: 'COBADEFFXXX',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

/** Eine freigegebene freie Rechnung: eine Zeile, kein Auftragsbezug. */
function freeInvoice(type: InvoiceDocumentType = 'rechnung'): VorgangInvoice {
  return {
    id: 'inv-free-1',
    number: '2026-0012',
    invoiceSequenceNumber: 12,
    type,
    positions: [
      {
        id: 'line-1',
        description: 'Anfahrt',
        quantity: 1,
        unit: 'Pauschal',
        unitPrice: 45,
        lineTotal: 45,
      },
    ],
    subtotal: 45,
    taxStatus: 'standard_19',
    amount: 53.55,
    status: 'vorbereitet',
    date: '2026-05-04',
    issueDate: '2026-05-04',
    createdAt: '2026-05-04T09:00:00.000Z',
    servicePeriodFrom: '2026-05-01',
    servicePeriodTo: '2026-05-01',
    paymentDueDate: '2026-05-18',
    paymentTermsText: '14 Tage netto',
    skontoText: '',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: {
      name: 'Müller Bau GmbH',
      contactPerson: '',
      street: 'Hauptstraße 12',
      zip: '45356',
      city: 'Essen',
      email: '',
      phone: '',
    },
    companySnapshot: COMPANY,
  } as unknown as VorgangInvoice;
}

function request(overrides: { vorgangId: string | null; type?: InvoiceDocumentType }) {
  const invoice = freeInvoice(overrides.type);
  const payload = buildInvoicePayloadV1(invoice);
  return {
    kind: PREPARED_FINALIZE_REQUEST_KIND,
    formatVersion: PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
    workspaceId: 'ws-1',
    vorgangId: overrides.vorgangId,
    clientInvoiceId: invoice.id,
    invoice,
    invoicePayload: payload,
    expectedResponseProjectionRawJson: canonicalJsonStringify({ ok: true }) ?? '{}',
  };
}

describe('MANUAL-INVOICE-01B1 — Finalisierung ohne Auftrag', () => {
  it('N1: eine normale Rechnung mit vorgangId null wird angenommen', () => {
    const result = validatePreparedWorkspaceInvoiceFinalizeRequest(
      request({ vorgangId: null }),
    );

    expect(result.ok, `Abgewiesen: ${(result as { detail?: string }).detail}`).toBe(true);
  });

  it('N2: eine auftragsgebundene Rechnung bleibt unverändert gültig', () => {
    const result = validatePreparedWorkspaceInvoiceFinalizeRequest(
      request({ vorgangId: 'v-1' }),
    );

    expect(result.ok, `Abgewiesen: ${(result as { detail?: string }).detail}`).toBe(true);
  });

  it('N3: ein Abschlag ohne Auftrag wird abgewiesen', () => {
    const result = validatePreparedWorkspaceInvoiceFinalizeRequest(
      request({ vorgangId: null, type: 'abschlag' }),
    );

    expect(result.ok, 'Ein Abschlag ohne Auftrag wurde angenommen').toBe(false);
    expect((result as { detail?: string }).detail).toContain('vorgangId');
  });

  it('N4: eine Schlussrechnung ohne Auftrag wird abgewiesen', () => {
    const result = validatePreparedWorkspaceInvoiceFinalizeRequest(
      request({ vorgangId: null, type: 'schluss' }),
    );

    expect(result.ok, 'Eine Schlussrechnung ohne Auftrag wurde angenommen').toBe(false);
    expect((result as { detail?: string }).detail).toContain('vorgangId');
  });

  it('N5: der Leerstring bleibt als Ersatz für „kein Auftrag" verboten', () => {
    const result = validatePreparedWorkspaceInvoiceFinalizeRequest(
      request({ vorgangId: '' as unknown as string }),
    );

    expect(result.ok, 'Der Leerstring wurde als Auftragsbezug akzeptiert').toBe(false);
  });

  it('N6: der Cloud-Payload akzeptiert eine Zeile ohne Auftragsbezug', () => {
    const payload = buildInvoicePayloadV1(freeInvoice());
    expect(payload, 'Der Payload liess sich nicht bauen').not.toBeNull();

    const result = validateWorkspaceInvoiceCloudPayload(payload);

    expect(result.ok, `Abgewiesen: ${(result as { detail?: string }).detail}`).toBe(true);
  });

  it('N7: eine leere Auftragskennung bleibt im Cloud-Payload verboten', () => {
    const invoice = freeInvoice();
    invoice.positions = [{ ...invoice.positions[0]!, orderPositionId: '' }];
    const payload = buildInvoicePayloadV1(invoice);

    const result = validateWorkspaceInvoiceCloudPayload(payload);

    expect(result.ok, 'Eine leere Auftragskennung wurde akzeptiert').toBe(false);
  });
});
