/**
 * REAL-PRODUCT-TEST-01C — eigene Ausgangsrechnung im Dokumentdetail.
 *
 *  A  Zahlungsziel der verknüpften Rechnung erscheint als Frist
 *  B  offene eigene Rechnung: keine Brief-Texte („Keine Frist erkannt", „Noch in Arbeit",
 *     „Nein – vorerst ablegen", „Bitte Inhalt prüfen und ablegen") — auch in der Karte
 *  C  offene Rechnung → Empfehlung Zahlungseingang überwachen; überfällig → anmahnen
 *  D  bezahlte Rechnung → keine offene Zahlungsaufforderung, keine offene Frist
 *  E  eigene Ausgangsrechnung ohne auffindbare Rechnung → sicherer Rückfall, kein Crash
 *  F  eingehendes Dokument → bisherige Erklärung unverändert
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStores } from '../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import { DEFAULT_SETUP } from '../data/mockData';
import { TestProviders } from '../test/testProviders';
import { archiveOutgoingInvoice } from './invoiceArchiveService';
import { addDocument, getDocumentById, hydrateDocumentStore } from './documentService';
import { getVorgangInvoice, hydrateVorgangStore } from './vorgangService';
import { buildDocumentExplanation } from './memory/documentExplanationService';
import { DocumentUnderstandingCard } from '../components/documents/DocumentUnderstandingCard';
import type { CompanyDocument, Vorgang, VorgangInvoice } from '../types/models';

const VORGANG_ID = 'v-own-invoice';
const INVOICE_ID = 'inv-own-1';
const TODAY = '2026-09-16';
const BRIEF_TEXTE = ['Keine Frist erkannt', 'Noch in Arbeit', 'Nein – vorerst ablegen', 'Bitte Inhalt prüfen und ablegen'];

function buildInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0012',
    type: 'rechnung',
    positions: [{ id: 'line-1', orderPositionId: 'op-1', description: 'Dachsanierung', quantity: 10, unit: 'm²', unitPrice: 100, lineTotal: 1000 }],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    date: '2026-09-07',
    issueDate: '2026-09-07',
    createdAt: '2026-09-07T10:00:00.000Z',
    paymentDueDate: '2026-09-21',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: { name: 'Beispiel Projektbau GmbH', contactPerson: '', street: 'Weg 1', zip: '33330', city: 'Beispielstadt', email: '', phone: '' },
    ...overrides,
  } as VorgangInvoice;
}

function buildVorgang(invoice: VorgangInvoice): Vorgang {
  return {
    ...createTestVorgang({
      id: VORGANG_ID,
      status: 'beauftragt',
      customer: 'Beispiel Projektbau GmbH',
      customerId: 'cust-1',
      title: 'Gewerbepark – Dachsanierung',
      orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 100 })],
    }),
    invoices: [invoice],
  };
}

function archiveOwnInvoice(overrides: Partial<VorgangInvoice> = {}): CompanyDocument {
  hydrateVorgangStore([buildVorgang(buildInvoice(overrides))]);
  const invoice = getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
  const result = archiveOutgoingInvoice(VORGANG_ID, invoice, 'Test GmbH');
  if (!result.success) throw new Error('Archivierung fehlgeschlagen');
  return result.document;
}

function renderCard(documentId: string): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TestProviders initialSetup={DEFAULT_SETUP}>
        <DocumentUnderstandingCard documentId={documentId} />
      </TestProviders>
    </MemoryRouter>,
  );
}

describe('REAL-PRODUCT-TEST-01C — eigene Ausgangsrechnung im Dokumentdetail', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('A: das Zahlungsziel der Rechnung ist die Frist', () => {
    const document = archiveOwnInvoice();
    const explanation = buildDocumentExplanation({ documentId: document.id }, TODAY)!;
    expect(explanation.deadline).toBe('Zahlungsziel 21.09.2026');
  });

  it('B: keine Brief-Texte an der eigenen offenen Rechnung — Erklärung und Karte', () => {
    const document = archiveOwnInvoice();
    const explanation = buildDocumentExplanation({ documentId: document.id }, TODAY)!;
    const all = [explanation.deadline, explanation.actionRequired, explanation.recommendation, ...explanation.nextSteps].join(' | ');
    for (const text of BRIEF_TEXTE) expect(all).not.toContain(text);
    expect(explanation.understandingStatus).toBe('understood');
    expect(explanation.uncertaintyNote).toBeUndefined();

    const html = renderCard(document.id);
    expect(html).toContain('data-testid="document-understanding-card"');
    for (const text of BRIEF_TEXTE) expect(html).not.toContain(text);
    expect(html).toContain('Verstanden');
    expect(html).toContain('Zahlungsziel 21.09.2026');
  });

  it('C: offen → Zahlungseingang überwachen; überfällig → anmahnen', () => {
    const open = archiveOwnInvoice();
    const openExplanation = buildDocumentExplanation({ documentId: open.id }, TODAY)!;
    expect(openExplanation.recommendation).toContain('Zahlungseingang überwachen');
    expect(openExplanation.actionRequired).toBe('Ja – Zahlungseingang überwachen.');
    expect(openExplanation.nextSteps).toEqual(['Zahlungseingang prüfen und Zahlung in der Rechnung erfassen.']);

    resetTestStores();
    const overdue = archiveOwnInvoice({ paymentDueDate: '2026-09-10' });
    const overdueExplanation = buildDocumentExplanation({ documentId: overdue.id }, TODAY)!;
    expect(overdueExplanation.deadline).toBe('Zahlungsziel 10.09.2026');
    expect(overdueExplanation.actionRequired).toContain('überschritten');
    expect(overdueExplanation.recommendation).toContain('überfällig');
  });

  it('D: bezahlt → keine offene Zahlungsaufforderung und keine offene Frist', () => {
    const paid = archiveOwnInvoice({
      payments: [{ id: 'p-1', date: '2026-09-10', amount: 1190, reference: 'Überweisung' }],
    });
    const explanation = buildDocumentExplanation({ documentId: paid.id }, TODAY)!;
    expect(explanation.deadline).toBe('Bezahlt – keine offene Frist');
    expect(explanation.actionRequired).toBe('Nein – Rechnung ist bezahlt.');
    expect(explanation.recommendation).not.toContain('überwachen');
    expect(explanation.recommendation).not.toContain('erinnern');
    expect(explanation.nextSteps).toEqual(['Keine weiteren Schritte – Rechnung ist bezahlt.']);
    expect(explanation.understandingStatus).toBe('understood');
  });

  it('E: eigene Ausgangsrechnung ohne auffindbare Rechnung → verständlicher Rückfall, kein Crash', () => {
    hydrateDocumentStore([]);
    const orphan = addDocument({
      title: 'Rechnung 2026-0099',
      category: 'ausgangsrechnung',
      issuer: 'Test GmbH',
      recognizedText: 'Rechnung 2026-0099',
      issueDate: '2026-09-01',
      linkedInvoiceId: 'inv-does-not-exist',
      archived: true,
    });
    expect(orphan.success).toBe(true);
    if (!orphan.success) return;
    const explanation = buildDocumentExplanation({ documentId: orphan.document.id }, TODAY)!;
    expect(explanation).not.toBeNull();
    expect(explanation.deadline).toBe('Zahlungsziel nicht ermittelbar');
    expect(explanation.deadline).not.toMatch(/\d{2}\.\d{2}\.\d{4}/);
    expect(explanation.recommendation).toContain('nicht gefunden');
    expect(explanation.understandingStatus).toBe('partial');
    expect(() => renderCard(orphan.document.id)).not.toThrow();
  });

  it('F: ein eingehendes Dokument behält seine bisherige Erklärung', () => {
    hydrateDocumentStore([]);
    const incoming = addDocument({
      title: 'Eingangsrechnung Holz AG',
      category: 'eingangsrechnung',
      issuer: 'Holz AG',
      recognizedText: 'Eingangsrechnung RE-2026-1',
      issueDate: '2026-08-01',
      validUntil: '2026-09-01',
      classifiedKind: 'eingangsrechnung',
      archived: true,
    });
    expect(incoming.success).toBe(true);
    if (!incoming.success) return;
    const stored = getDocumentById(incoming.document.id)!;
    const explanation = buildDocumentExplanation({ documentId: stored.id }, TODAY)!;
    expect(explanation.deadline).toContain('2026-09-01');
    expect(explanation.understandingStatus).toBeUndefined();
    expect(explanation.recommendation).not.toContain('Eigene Ausgangsrechnung');
  });
});
