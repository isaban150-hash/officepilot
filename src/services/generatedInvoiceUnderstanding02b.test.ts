/**
 * OFFICEPILOT-GENERATED-INVOICE-UNDERSTANDING-02B — eigene Rechnung ist keine Fremdpost.
 *
 * Eine von OfficePilot selbst erzeugte Ausgangsrechnung lief bisher durch
 * dieselbe Erkennung wie unbekannte Eingangspost. Ohne OCR-Herkunft und ohne
 * Klassifikation fiel sie auf „Sonstiges“ zurück, das Zahlungsziel wurde als
 * Gültigkeitsfrist gelesen, und die offenen Nachweise des verknüpften Auftrags
 * erschienen als „benötigte Unterlagen“ dieser Rechnung.
 *
 * Der Betrieb bekam damit an seiner eigenen Rechnung falsche Anweisungen.
 * Die autoritative Wahrheit lag bereits vor — sie wurde nur nicht eingetragen
 * und an einer Stelle nicht gelesen.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStores } from '../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import {
  archiveOutgoingInvoice,
  buildOutgoingInvoiceDocumentInput,
} from './invoiceArchiveService';
import { addDocument, getDocumentById, hydrateDocumentStore } from './documentService';
import { getVorgangById, getVorgangInvoice, hydrateVorgangStore } from './vorgangService';
import { buildDocumentExplanation } from './memory/documentExplanationService';
import { upsertProofMemoryInStore } from './officePilotMemoryStore';
import { resolvePaperFiling } from './paperFolderService';
import type { CompanyDocument, Vorgang, VorgangInvoice } from '../types/models';
import type { ProofMemory } from '../types/memory';

const VORGANG_ID = 'v-gen-invoice';
const INVOICE_ID = 'inv-gen-1';
const TODAY = '2026-08-25';

function buildInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0001',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Dachsanierung',
        quantity: 10,
        unit: 'm²',
        unitPrice: 100,
        lineTotal: 1000,
      },
    ],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'vorbereitet',
    date: '2026-08-24',
    issueDate: '2026-08-24',
    createdAt: '2026-08-24T10:00:00.000Z',
    paymentDueDate: '2026-09-07',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: {
      name: 'Beispiel Projektbau GmbH',
      contactPerson: '',
      street: 'Weg 1',
      zip: '33330',
      city: 'Beispielstadt',
      email: '',
      phone: '',
    },
    ...overrides,
  } as VorgangInvoice;
}

function buildVorgang(): Vorgang {
  return {
    ...createTestVorgang({
      id: VORGANG_ID,
      status: 'beauftragt',
      customer: 'Beispiel Projektbau GmbH',
      customerId: 'cust-1',
      title: 'Gewerbepark – Dachsanierung',
      orderPositions: [
        createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 100 }),
      ],
    }),
    invoices: [buildInvoice()],
  };
}

/** Ein offener Nachweis am Auftrag — fachlich richtig, aber nicht an der Rechnung. */
function seedMissingProof(): void {
  upsertProofMemoryInStore({
    id: 'proof-haftpflicht',
    proofType: 'betriebshaftpflicht',
    status: 'missing',
    requiredByVorgangIds: [VORGANG_ID],
    lastCheckedAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  } as ProofMemory);
}

function archiveInvoice(): CompanyDocument {
  const invoice = getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
  const result = archiveOutgoingInvoice(VORGANG_ID, invoice, 'Test GmbH');
  if (!result.success) throw new Error('Archivierung fehlgeschlagen');
  return result.document;
}

describe('OFFICEPILOT-GENERATED-INVOICE-UNDERSTANDING-02B', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateVorgangStore([buildVorgang()]);
  });

  it('A: der Writer trägt die autoritative Wahrheit ein und missbraucht validUntil nicht', () => {
    const vorgang = getVorgangById(VORGANG_ID)!;
    const input = buildOutgoingInvoiceDocumentInput(buildInvoice(), vorgang, 'Test GmbH');

    expect(input.category).toBe('ausgangsrechnung');
    expect(input.classifiedKind).toBe('ausgangsrechnung');
    expect(input.linkedInvoiceId).toBe(INVOICE_ID);

    // Ein Zahlungsziel ist keine Dokumentgültigkeit.
    expect(input.validUntil ?? null).toBeNull();

    // Und es bleibt dort, wo es hingehört.
    expect(getVorgangInvoice(VORGANG_ID, INVOICE_ID)?.paymentDueDate).toBe('2026-09-07');
  });

  it('B: die Erklärung zeigt weder „Sonstiges“ noch eine Gültigkeitsfrist', () => {
    const document = archiveInvoice();
    const explanation = buildDocumentExplanation({ documentId: document.id }, TODAY)!;

    expect(explanation).not.toBeNull();
    expect(explanation.shortAnswer).not.toContain('Sonstiges');
    expect(explanation.deadline).not.toContain('2026-09-07');
    expect(explanation.actionRequired).not.toContain('Gültigkeit');
    expect(explanation.recommendation).not.toContain('Gültigkeit prüfen');
    expect(explanation.recommendation).not.toContain('erneuern');
  });

  it('C: offene Auftragsnachweise erscheinen nicht an der Ausgangsrechnung', () => {
    seedMissingProof();
    const document = archiveInvoice();
    const explanation = buildDocumentExplanation({ documentId: document.id }, TODAY)!;

    expect(explanation.requiredDocuments.join(' ')).not.toContain('Betriebshaftpflicht');
    expect(explanation.actionRequired).not.toContain('Nachweise');
  });

  it('D: beim Vertrag desselben Auftrags bleiben die Nachweise erhalten', () => {
    seedMissingProof();
    const contract = addDocument({
      title: 'Werkvertrag Dachsanierung',
      category: 'vertrag',
      issuer: 'Beispiel Projektbau GmbH',
      recognizedText: 'Werkvertrag',
      issueDate: '2026-03-01',
      linkedVorgang: { vorgangId: VORGANG_ID, vorgangTitle: 'Gewerbepark – Dachsanierung' },
      archived: true,
    });
    expect(contract.success).toBe(true);
    if (!contract.success) return;

    const explanation = buildDocumentExplanation({ documentId: contract.document.id }, TODAY)!;

    // Genau hier gehören sie hin — global abgeschaltet wurde nichts.
    expect(explanation.requiredDocuments.join(' ')).toContain('Betriebshaftpflicht');
  });

  it('E: die Papierablage folgt der Rechnungsregel, nicht „Sonstiges“', () => {
    const document = archiveInvoice();

    // Der Writer setzt den Ordner …
    expect(document.paperFolder.folderId).toBe('folder-3');

    // … und die Ablageregel kommt mit der Dokumentnatur zum selben Ergebnis.
    const resolved = resolvePaperFiling({ classifiedKind: document.classifiedKind });
    expect(resolved.rule?.folderId).toBe('folder-3');
    expect(resolved.rule?.folderId).not.toBe('paper-sonstiges');
  });

  it('F: für eine digital erzeugte Rechnung wird kein Papieroriginal verlangt', () => {
    const document = archiveInvoice();
    const explanation = buildDocumentExplanation({ documentId: document.id }, TODAY)!;

    expect(explanation.nextSteps.join(' ')).not.toContain('abheften');
    expect(explanation.paperLocation).not.toContain('Sonstiges');
  });

  it('G: eine echte Eingangsrechnung behält ihre Frist- und Guidance-Logik', () => {
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
    // Bei Fremdpost bleibt validUntil eine echte Frist.
    expect(stored.validUntil).toBe('2026-09-01');

    const explanation = buildDocumentExplanation({ documentId: stored.id }, TODAY)!;
    expect(explanation).not.toBeNull();
    expect(explanation.deadline).toContain('2026-09-01');
  });
});
