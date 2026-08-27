/**
 * OFFICEPILOT-ARCHIVE-LINK-LOCAL-DURABILITY-05B — der Link muss den Reload überleben.
 *
 * `updateInvoiceArchiveDocumentId` schrieb über `updateVorgangInStore`, und das
 * ist die Funktion, die das Ergebnis von `persistAll()` verwirft. Folge: Das
 * Archivdokument entsteht, `invoice.archiveDocumentId` steht im Arbeitsspeicher,
 * die Archivierung meldet Erfolg — und nach einem Reload ist der Link weg.
 *
 * Dieselbe Fehlerklasse wie beim Versandstatus (94f338e) und bei den Zahlungen
 * (52ae33f). Hier wird sie für die dritte und letzte bekannte Stelle geschlossen.
 *
 * Neutrale Beispieldaten, kein Netzwerk, keine Cloud.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStores } from '../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import {
  getVorgangInvoice,
  hydrateVorgangStore,
  updateInvoiceArchiveDocumentId,
} from './vorgangService';
import { archiveOutgoingInvoice } from './invoiceArchiveService';
import { getDocumentByLinkedInvoiceId, hydrateDocumentStore } from './documentService';
import { resetLastPersistFailureForTests } from './persistenceService';
import * as persistenceService from './persistenceService';
import type { Vorgang, VorgangInvoice } from '../types/models';

const VORGANG_ID = 'v-archive-link';
const INVOICE_ID = 'inv-archive-link';
const COMPANY = 'Muster GmbH';

function buildInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0002',
    invoiceSequenceNumber: 2,
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Dachsanierung',
        quantity: 100,
        unit: 'm²',
        unitPrice: 100,
        lineTotal: 10000,
      },
    ],
    subtotal: 10000,
    taxStatus: 'null_13b',
    amount: 10000,
    status: 'versendet',
    sentAt: '2026-08-25',
    sentVia: 'email',
    date: '2026-08-24',
    issueDate: '2026-08-24',
    createdAt: '2026-08-24T10:00:00.000Z',
    paymentDueDate: '2099-12-31',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  } as VorgangInvoice;
}

function seed(invoice: VorgangInvoice = buildInvoice()): void {
  hydrateDocumentStore([]);
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG_ID,
        title: 'Dachsanierung Beispielweg',
        status: 'beauftragt',
        customer: 'Beispiel Projektbau GmbH',
        orderPositions: [
          createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 100, unitPrice: 100 }),
        ],
      }),
      invoices: [invoice],
    } as Vorgang,
  ]);
}

function stored(): VorgangInvoice {
  return getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
}

/** Lässt `persistAll` die ersten `n` Aufrufe gelingen und danach scheitern. */
function failPersistAfter(n: number): void {
  const real = persistenceService.persistAll;
  let calls = 0;
  vi.spyOn(persistenceService, 'persistAll').mockImplementation(((...args: unknown[]) => {
    calls += 1;
    if (calls > n) return { success: false };
    return (real as (...a: unknown[]) => unknown)(...args);
  }) as typeof persistenceService.persistAll);
}

describe('OFFICEPILOT-ARCHIVE-LINK-LOCAL-DURABILITY-05B', () => {
  beforeEach(() => {
    resetTestStores();
    resetLastPersistFailureForTests();
    seed();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
    resetLastPersistFailureForTests();
  });

  it('A: ein erfolgreicher Commit speichert den Archiv-Link', () => {
    const result = updateInvoiceArchiveDocumentId(VORGANG_ID, INVOICE_ID, 'doc-archive-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.archiveDocumentId).toBe('doc-archive-1');
    // Und zwar dort, wo es einen Reload überlebt.
    expect(stored().archiveDocumentId).toBe('doc-archive-1');
  });

  it('B: ein Persistenzfehler lässt keine halbe Mutation zurück', () => {
    vi.spyOn(persistenceService, 'persistAll').mockReturnValue({ success: false });

    const result = updateInvoiceArchiveDocumentId(VORGANG_ID, INVOICE_ID, 'doc-archive-1');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('persist_failed');

    /*
     * Der eigentliche Defekt: Vorher stand die Kennung jetzt im Arbeitsspeicher
     * und verschwand erst beim Reload. Der Nutzer hätte einen Link gesehen, den
     * es nicht gab.
     */
    expect(stored().archiveDocumentId).toBeUndefined();
    // Und der Rest der Rechnung ist unangetastet.
    expect(stored().number).toBe('2026-0002');
    expect(stored().status).toBe('versendet');
    expect(stored().amount).toBe(10000);
  });

  it('C: ein bestehender Link wird gezielt ersetzt, ohne Feldverlust', () => {
    seed(buildInvoice({ archiveDocumentId: 'doc-archive-alt', payments: [] }));

    const result = updateInvoiceArchiveDocumentId(VORGANG_ID, INVOICE_ID, 'doc-archive-neu');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(stored().archiveDocumentId).toBe('doc-archive-neu');
    // Keine Kollateralschäden an den Feldern daneben.
    expect(stored().sentAt).toBe('2026-08-25');
    expect(stored().sentVia).toBe('email');
    expect(stored().invoiceSequenceNumber).toBe(2);
    expect(stored().positions).toHaveLength(1);
    expect(stored().paymentDueDate).toBe('2099-12-31');
  });

  it('D: eine unbekannte Rechnung ist ein sauberer Fehler, kein Erfolg', () => {
    const unknownInvoice = updateInvoiceArchiveDocumentId(VORGANG_ID, 'inv-gibt-es-nicht', 'doc-1');
    expect(unknownInvoice.ok).toBe(false);
    if (unknownInvoice.ok) return;
    expect(unknownInvoice.reason).toBe('not_found');

    const unknownVorgang = updateInvoiceArchiveDocumentId('v-gibt-es-nicht', INVOICE_ID, 'doc-1');
    expect(unknownVorgang.ok).toBe(false);
    if (unknownVorgang.ok) return;
    expect(unknownVorgang.reason).toBe('not_found');

    // Der bestehende Stand bleibt unberührt.
    expect(stored().archiveDocumentId).toBeUndefined();
  });

  it('E: der Archive-Handoff meldet Erfolg nur mit Dokument und Link', () => {
    const result = archiveOutgoingInvoice(VORGANG_ID, buildInvoice(), COMPANY);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.created).toBe(true);
    expect(result.document.linkedInvoiceId).toBe(INVOICE_ID);
    expect(result.document.category).toBe('ausgangsrechnung');
    expect(result.document.classifiedKind).toBe('ausgangsrechnung');
    expect(result.invoice.archiveDocumentId).toBe(result.document.id);
    // Beide Seiten sind gespeichert, nicht nur zurückgegeben.
    expect(stored().archiveDocumentId).toBe(result.document.id);
    expect(getDocumentByLinkedInvoiceId(INVOICE_ID)?.id).toBe(result.document.id);
  });

  it('F: scheitert der Link, meldet der Handoff keinen Gesamterfolg', () => {
    // Die Dokumentanlage gelingt, der anschließende Link-Commit nicht.
    failPersistAfter(1);

    const result = archiveOutgoingInvoice(VORGANG_ID, buildInvoice(), COMPANY);

    expect(result.success).toBe(false);
    if (result.success) return;
    /*
     * Eigener Grund: „Vorgang nicht gefunden“ wäre eine falsche Diagnose. Der
     * Vorgang existiert; gescheitert ist das Speichern.
     */
    expect(result.reason).toBe('archive_link_persist_failed');
    // Die Rechnung trägt keinen Link, den es nicht dauerhaft gibt.
    expect(stored().archiveDocumentId).toBeUndefined();
  });

  it('F2: ein zweiter Versuch nach dem Fehler verknüpft dasselbe Dokument', () => {
    failPersistAfter(1);
    const failed = archiveOutgoingInvoice(VORGANG_ID, buildInvoice(), COMPANY);
    expect(failed.success).toBe(false);

    // Das angelegte Dokument bleibt bestehen — es ist bereits persistiert.
    const orphan = getDocumentByLinkedInvoiceId(INVOICE_ID);
    expect(orphan).toBeDefined();

    vi.restoreAllMocks();
    const retry = archiveOutgoingInvoice(VORGANG_ID, buildInvoice(), COMPANY);

    expect(retry.success).toBe(true);
    if (!retry.success) return;
    // Kein zweites Dokument: Der Wiederholungslauf findet das vorhandene.
    expect(retry.created).toBe(false);
    expect(retry.document.id).toBe(orphan!.id);
    expect(stored().archiveDocumentId).toBe(orphan!.id);
  });
});
