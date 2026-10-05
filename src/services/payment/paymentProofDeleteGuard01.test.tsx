/**
 * BARZAHLUNG-V1 NACHTRAG 1 — ein Zahlungsnachweis überlebt das Aufräumen.
 *
 * Die lokale Hälfte des Schutzes plus der Quelltext des Serververtrags. Die
 * eigentliche Strenge — auch für stornierte Zahlungen, die lokal gar nicht
 * projiziert werden — ist gegen eine echte PostgreSQL geprüft.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteDocument,
  getDocumentById,
  getDocumentDeleteBlockReason,
  hydrateDocumentStore,
  resetDocuments,
} from '../documentService';
import { recordExpensePayment, setExpensePaymentProof } from '../expensePaymentService';
import { getExpenseFromStoreById, hydrateExpenseStore } from '../expenseStore';
import { hydrateVorgangStore } from '../vorgangService';
import type { Expense } from '../../types/expense';
import type { ClassifiedDocumentKind, CompanyDocument } from '../../types/models';

const MIGRATION = resolve(
  __dirname,
  '../../../supabase/migrations/20261029120000_workspace_document_payment_proof_guard.sql',
);
const sql = readFileSync(MIGRATION, 'utf8');

function ausgabe(): Expense {
  return {
    id: 'exp-guard-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baumarkt GmbH',
    invoiceNumber: 'BON-G1',
    title: 'Materialeinkauf',
    description: '',
    issueDate: '2026-10-05',
    paymentDueDate: '2099-10-15',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 0,
    grossAmount: 100,
    currency: 'EUR',
    paymentStatus: 'offen',
    payments: [],
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'guard|1',
    tags: [],
    digitalFolder: { id: 'dig-1', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'folder-1', register: 'A', label: 'Test' },
    createdAt: '2026-10-05T08:00:00.000Z',
    updatedAt: '2026-10-05T08:00:00.000Z',
  };
}

function dokument(id: string, kind: ClassifiedDocumentKind, title: string): CompanyDocument {
  return {
    id,
    title,
    category: 'sonstiges',
    issuer: 'Baumarkt GmbH',
    recognizedText: '',
    issueDate: '2026-10-05',
    validUntil: null,
    digitalFolder: { id: 'dig-2', name: 'Belege', path: '/Belege/' },
    paperFolder: { folderId: 'folder-2', register: 'B', label: 'Belege' },
    tags: [],
    linkedCompany: '',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-10-05T09:00:00.000Z',
    classifiedKind: kind,
    documentDate: '2026-10-05',
  };
}

describe('NACHTRAG-1 Löschschutz für Zahlungsnachweise', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDocuments();
    hydrateVorgangStore([]);
    hydrateExpenseStore([ausgabe()]);
    hydrateDocumentStore([
      dokument('doc-nachweis', 'quittung', 'Quittung Baumarkt'),
      dokument('doc-frei', 'quittung', 'Quittung ohne Zahlungsbezug'),
    ]);
  });

  /* ---- A) Der lokale Schutz ---- */

  it('A1 — ein unreferenziertes Dokument bleibt löschbar', () => {
    expect(getDocumentDeleteBlockReason(getDocumentById('doc-frei')!)).toBeNull();
    expect(deleteDocument('doc-frei').success).toBe(true);
    expect(getDocumentById('doc-frei')).toBeUndefined();
  });

  it('A2 — der Nachweis einer aktiven Zahlung ist geschützt', () => {
    recordExpensePayment('exp-guard-1', {
      date: '2026-10-05', amount: 50, method: 'cash', proofDocumentId: 'doc-nachweis',
    });

    expect(getDocumentDeleteBlockReason(getDocumentById('doc-nachweis')!)).toBe('payment_proof');
    const ergebnis = deleteDocument('doc-nachweis');
    expect(ergebnis.success).toBe(false);
    if (ergebnis.success) return;
    expect(ergebnis.errorKey).toBe('document.delete.blocked.paymentProof');
  });

  it('A3 — der Löschversuch verändert weder Zahlung noch Nachweis', () => {
    const gebucht = recordExpensePayment('exp-guard-1', {
      date: '2026-10-05', amount: 50, method: 'cash', proofDocumentId: 'doc-nachweis',
    });
    if (!gebucht.success) throw new Error('Aufbau');

    deleteDocument('doc-nachweis');

    const zahlungen = getExpenseFromStoreById('exp-guard-1')?.payments ?? [];
    expect(zahlungen).toHaveLength(1);
    expect(zahlungen[0]?.amount).toBe(50);
    expect(zahlungen[0]?.method).toBe('cash');
    /* Entscheidend: die Referenz wird NICHT gelöst. */
    expect(zahlungen[0]?.proofDocumentId).toBe('doc-nachweis');
  });

  it('A4 — der Löschversuch erzeugt keinen Grabstein', () => {
    recordExpensePayment('exp-guard-1', {
      date: '2026-10-05', amount: 50, method: 'cash', proofDocumentId: 'doc-nachweis',
    });
    deleteDocument('doc-nachweis');
    /* Das Dokument ist weiterhin auflösbar — ein Grabstein wäre es nicht. */
    expect(getDocumentById('doc-nachweis')?.title).toBe('Quittung Baumarkt');
  });

  it('A5 — ein anderes Dokument bleibt davon unberührt löschbar', () => {
    recordExpensePayment('exp-guard-1', {
      date: '2026-10-05', amount: 50, method: 'cash', proofDocumentId: 'doc-nachweis',
    });
    expect(deleteDocument('doc-frei').success).toBe(true);
    expect(getDocumentById('doc-nachweis')).toBeDefined();
  });

  it('A6 — nach dem Lösen des Nachweises ist das Dokument wieder löschbar', () => {
    const gebucht = recordExpensePayment('exp-guard-1', {
      date: '2026-10-05', amount: 50, method: 'cash', proofDocumentId: 'doc-nachweis',
    });
    if (!gebucht.success) throw new Error('Aufbau');

    setExpensePaymentProof('exp-guard-1', gebucht.payment.id, null);
    expect(getDocumentDeleteBlockReason(getDocumentById('doc-nachweis')!)).toBeNull();
    expect(deleteDocument('doc-nachweis').success).toBe(true);
  });

  it('A7 — ein Wiederholungsversuch bleibt blockiert', () => {
    recordExpensePayment('exp-guard-1', {
      date: '2026-10-05', amount: 50, method: 'cash', proofDocumentId: 'doc-nachweis',
    });
    expect(deleteDocument('doc-nachweis').success).toBe(false);
    expect(deleteDocument('doc-nachweis').success).toBe(false);
    expect(getDocumentById('doc-nachweis')).toBeDefined();
  });

  it('A8 — ohne Zahlungsnachweis bleibt das bisherige Verhalten', () => {
    recordExpensePayment('exp-guard-1', { date: '2026-10-05', amount: 50, method: 'cash' });
    expect(getDocumentDeleteBlockReason(getDocumentById('doc-nachweis')!)).toBeNull();
    expect(deleteDocument('doc-nachweis').success).toBe(true);
  });

  /* ---- B) Der Serververtrag ---- */

  it('B1 — beide Löschwege rufen denselben Guard', () => {
    expect(sql).toContain('create or replace function public.assert_document_not_payment_proof');
    const aufrufe = sql.match(/perform public\.assert_document_not_payment_proof\(/g) ?? [];
    expect(aufrufe).toHaveLength(2);
    expect(sql).toContain('create or replace function public.upsert_workspace_intake_entity');
    expect(sql).toContain('create or replace function public.tombstone_workspace_document');
  });

  it('B2 — der Guard prüft beide Zahlungswelten', () => {
    const abschnitt = sql.slice(
      sql.indexOf('create or replace function public.assert_document_not_payment_proof'),
      sql.indexOf('create or replace function public.is_workspace_document_payment_proof'),
    );
    expect(abschnitt).toContain('from public.workspace_expense_payments p');
    expect(abschnitt).toContain('from public.workspace_invoice_payments p');
    /* Keine Unterscheidung aktiv/storniert — eine Prüfspur zählt genauso. */
    expect(abschnitt).not.toContain('reversed_at');
  });

  it('B3 — der Guard ist auf den eigenen Workspace beschränkt', () => {
    const abschnitt = sql.slice(
      sql.indexOf('create or replace function public.assert_document_not_payment_proof'),
      sql.indexOf('create or replace function public.is_workspace_document_payment_proof'),
    );
    const grenzen = abschnitt.match(/p\.workspace_id = p_workspace_id/g) ?? [];
    expect(grenzen).toHaveLength(2);
  });

  it('B4 — die Meldung verrät keine Zahlungsdaten', () => {
    expect(sql).toContain("raise exception 'Dokument ist als Zahlungsnachweis verknuepft'");
    const abschnitt = sql.slice(
      sql.indexOf('create or replace function public.assert_document_not_payment_proof'),
      sql.indexOf('create or replace function public.is_workspace_document_payment_proof'),
    );
    expect(abschnitt).not.toMatch(/client_payment_id.*\|\||amount/);
  });

  it('B5 — keine automatische Referenzlösung', () => {
    expect(sql).not.toMatch(/set\s+proof_document_id\s*=\s*null/i);
    expect(sql).not.toContain('delete from public.workspace_expense_payments');
    expect(sql).not.toContain('delete from public.workspace_invoice_payments');
  });

  it('B6 — das Rennen ist über dieselbe Zeilensperre geschlossen', () => {
    /* Beide Nachweis-Funktionen sperren die Dokumentzeile, die die Löschwege ebenfalls sperren. */
    const sperren = sql.match(/from public\.workspace_documents d[\s\S]{0,260}?for update;/g) ?? [];
    expect(sperren.length).toBeGreaterThanOrEqual(2);
    expect(sql).toContain('create or replace function public.set_workspace_expense_payment_proof');
    expect(sql).toContain('create or replace function public.set_workspace_invoice_payment_proof');
  });

  it('B7 — die Lesefunktion prüft die Mitgliedschaft', () => {
    const abschnitt = sql.slice(sql.indexOf('create or replace function public.is_workspace_document_payment_proof'));
    expect(abschnitt).toContain('if not public.is_active_workspace_member(p_workspace_id) then');
    expect(abschnitt).toContain("raise exception 'Kein Zugriff auf Workspace'");
  });

  it('B8 — bereits angewendete Migrationen bleiben unberührt', () => {
    const block1 = resolve(
      __dirname,
      '../../../supabase/migrations/20261028120000_workspace_payment_proof_document.sql',
    );
    expect(readFileSync(block1, 'utf8')).not.toContain('assert_document_not_payment_proof');
    const bank = resolve(
      __dirname,
      '../../../supabase/migrations/20261027120000_workspace_bank_reconciliation_release.sql',
    );
    expect(readFileSync(bank, 'utf8')).not.toContain('payment_proof');
  });
});
