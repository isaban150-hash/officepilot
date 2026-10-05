/**
 * BARZAHLUNG-V1 BLOCK 1 — der Zahlungsnachweis an der einzelnen Zahlung.
 *
 * Diese Datei prüft die **Client-Seite** und den Quelltext des Serververtrags.
 * Atomarität, Workspace-Isolation und Idempotenz sind zusätzlich gegen eine
 * echte PostgreSQL geprüft worden.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  findExpensePaymentsByProofDocument,
  recordExpensePayment,
  removeExpensePayment,
  setExpensePaymentProof,
} from '../expensePaymentService';
import { getExpenseFromStoreById, hydrateExpenseStore } from '../expenseStore';
import { hydrateDocumentStore, resetDocuments } from '../documentService';
import { ExpensePaymentHistory } from '../../components/expenses/ExpensePaymentHistory';
import {
  PAYMENT_PROOF_DOCUMENT_KINDS,
  isPaymentProofDocument,
  listOtherArchiveDocuments,
  listPaymentProofDocuments,
  paymentProofLabel,
} from '../../components/payment/PaymentProofField';
import type { Expense } from '../../types/expense';
import type { ClassifiedDocumentKind, CompanyDocument } from '../../types/models';
import type { TranslationKey } from '../../i18n';

const MIGRATION = resolve(
  __dirname,
  '../../../supabase/migrations/20261028120000_workspace_payment_proof_document.sql',
);
const sql = readFileSync(MIGRATION, 'utf8');

const translate = (key: TranslationKey): string => key;

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-bar-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baumarkt GmbH',
    invoiceNumber: 'BON-1',
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
    dedupeKey: 'bar|1',
    tags: [],
    digitalFolder: { id: 'dig-1', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'folder-1', register: 'A', label: 'Test' },
    createdAt: '2026-10-05T08:00:00.000Z',
    updatedAt: '2026-10-05T08:00:00.000Z',
    ...overrides,
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

describe('BARZAHLUNG-01 Zahlungsnachweis an der Zahlung', () => {
  beforeEach(() => {
    localStorage.clear();
    resetDocuments();
    hydrateExpenseStore([ausgabe()]);
    hydrateDocumentStore([
      dokument('doc-quittung-a', 'quittung', 'Quittung Baumarkt'),
      dokument('doc-kassenbeleg-b', 'kassenbeleg', 'Kassenbeleg Baumarkt'),
      dokument('doc-vertrag', 'arbeitsvertrag', 'Arbeitsvertrag'),
    ]);
  });

  /* ---- A) Barzahlung mit und ohne Nachweis ---- */

  it('A1 — eine Barzahlung ohne Nachweis wird gebucht und bleibt ohne Nachweis', () => {
    const ergebnis = recordExpensePayment('exp-bar-1', {
      date: '2026-10-05',
      amount: 80,
      method: 'cash',
    });

    expect(ergebnis.success).toBe(true);
    if (!ergebnis.success) return;
    expect(ergebnis.payment.method).toBe('cash');
    expect(ergebnis.payment.proofDocumentId).toBeUndefined();
  });

  it('A2 — eine Barzahlung mit Quittung trägt genau dieses Dokument', () => {
    const ergebnis = recordExpensePayment('exp-bar-1', {
      date: '2026-10-05',
      amount: 80,
      method: 'cash',
      proofDocumentId: 'doc-quittung-a',
    });

    expect(ergebnis.success).toBe(true);
    if (!ergebnis.success) return;
    expect(ergebnis.payment.proofDocumentId).toBe('doc-quittung-a');
    expect(ergebnis.payment.method).toBe('cash');
    expect(ergebnis.payment.amount).toBe(80);
  });

  it('A3 — ein Kassenbeleg ist ebenso ein Nachweis', () => {
    const ergebnis = recordExpensePayment('exp-bar-1', {
      date: '2026-10-05',
      amount: 80,
      method: 'cash',
      proofDocumentId: 'doc-kassenbeleg-b',
    });
    expect(ergebnis.success).toBe(true);
    if (!ergebnis.success) return;
    expect(ergebnis.payment.proofDocumentId).toBe('doc-kassenbeleg-b');
  });

  it('A4 — ein unbekanntes Dokument wird abgelehnt und bucht nichts', () => {
    const ergebnis = recordExpensePayment('exp-bar-1', {
      date: '2026-10-05',
      amount: 80,
      method: 'cash',
      proofDocumentId: 'doc-gibtsnicht',
    });

    expect(ergebnis.success).toBe(false);
    if (ergebnis.success) return;
    expect(ergebnis.errorKey).toBe('payment.proofNotFound');
    /* Entscheidend: keine halbe Buchung. */
    expect(getExpenseFromStoreById('exp-bar-1')?.payments ?? []).toEqual([]);
  });

  /* ---- B) Nachträglich setzen, tauschen, lösen ---- */

  it('B1 — der Nachweis lässt sich nachträglich anhängen, ohne Geld zu bewegen', () => {
    const gebucht = recordExpensePayment('exp-bar-1', { date: '2026-10-05', amount: 80, method: 'cash' });
    expect(gebucht.success).toBe(true);
    if (!gebucht.success) return;
    const vorher = getExpenseFromStoreById('exp-bar-1')!;

    const ergebnis = setExpensePaymentProof('exp-bar-1', gebucht.payment.id, 'doc-quittung-a');
    expect(ergebnis.success).toBe(true);
    if (!ergebnis.success) return;

    expect(ergebnis.payment.proofDocumentId).toBe('doc-quittung-a');
    expect(ergebnis.payment.amount).toBe(80);
    expect(ergebnis.payment.date).toBe('2026-10-05');
    expect(ergebnis.payment.method).toBe('cash');
    expect(ergebnis.expense.paymentStatus).toBe(vorher.paymentStatus);
    expect((ergebnis.expense.payments ?? []).length).toBe(1);
  });

  it('B2 — der Nachweis lässt sich wieder lösen', () => {
    const gebucht = recordExpensePayment('exp-bar-1', {
      date: '2026-10-05', amount: 80, method: 'cash', proofDocumentId: 'doc-quittung-a',
    });
    if (!gebucht.success) throw new Error('Aufbau');

    const ergebnis = setExpensePaymentProof('exp-bar-1', gebucht.payment.id, null);
    expect(ergebnis.success).toBe(true);
    if (!ergebnis.success) return;
    expect(ergebnis.payment.proofDocumentId).toBeUndefined();
    expect(ergebnis.payment.amount).toBe(80);
  });

  it('B3 — ein unbekanntes Dokument wird auch nachträglich abgelehnt', () => {
    const gebucht = recordExpensePayment('exp-bar-1', { date: '2026-10-05', amount: 80, method: 'cash' });
    if (!gebucht.success) throw new Error('Aufbau');

    const ergebnis = setExpensePaymentProof('exp-bar-1', gebucht.payment.id, 'doc-gibtsnicht');
    expect(ergebnis.success).toBe(false);
    if (ergebnis.success) return;
    expect(ergebnis.errorKey).toBe('payment.proofNotFound');
  });

  it('B4 — eine unbekannte Zahlung wird abgelehnt', () => {
    const ergebnis = setExpensePaymentProof('exp-bar-1', 'pay-gibtsnicht', 'doc-quittung-a');
    expect(ergebnis.success).toBe(false);
    if (ergebnis.success) return;
    expect(ergebnis.errorKey).toBe('payment.notFound');
  });

  /* ---- C) Teilzahlungen: der eigentliche Grund für diesen Block ---- */

  it('C1 — zwei Teilzahlungen tragen zwei verschiedene Nachweise', () => {
    const a = recordExpensePayment('exp-bar-1', {
      date: '2026-10-05', amount: 40, method: 'cash', proofDocumentId: 'doc-quittung-a',
    });
    const b = recordExpensePayment('exp-bar-1', {
      date: '2026-10-06', amount: 60, method: 'cash', proofDocumentId: 'doc-kassenbeleg-b',
    });
    if (!a.success || !b.success) throw new Error('Aufbau');

    const zahlungen = getExpenseFromStoreById('exp-bar-1')?.payments ?? [];
    expect(zahlungen).toHaveLength(2);
    expect(zahlungen.find((p) => p.id === a.payment.id)?.proofDocumentId).toBe('doc-quittung-a');
    expect(zahlungen.find((p) => p.id === b.payment.id)?.proofDocumentId).toBe('doc-kassenbeleg-b');
  });

  it('C2 — das Ändern an A lässt B unberührt', () => {
    const a = recordExpensePayment('exp-bar-1', {
      date: '2026-10-05', amount: 40, method: 'cash', proofDocumentId: 'doc-quittung-a',
    });
    const b = recordExpensePayment('exp-bar-1', {
      date: '2026-10-06', amount: 60, method: 'cash', proofDocumentId: 'doc-kassenbeleg-b',
    });
    if (!a.success || !b.success) throw new Error('Aufbau');

    setExpensePaymentProof('exp-bar-1', a.payment.id, null);

    const zahlungen = getExpenseFromStoreById('exp-bar-1')?.payments ?? [];
    expect(zahlungen.find((p) => p.id === a.payment.id)?.proofDocumentId).toBeUndefined();
    expect(zahlungen.find((p) => p.id === b.payment.id)?.proofDocumentId).toBe('doc-kassenbeleg-b');
  });

  it('C3 — der Storno von A rührt weder B noch die Dokumente an', () => {
    const a = recordExpensePayment('exp-bar-1', {
      date: '2026-10-05', amount: 40, method: 'cash', proofDocumentId: 'doc-quittung-a',
    });
    const b = recordExpensePayment('exp-bar-1', {
      date: '2026-10-06', amount: 60, method: 'cash', proofDocumentId: 'doc-kassenbeleg-b',
    });
    if (!a.success || !b.success) throw new Error('Aufbau');

    expect(removeExpensePayment('exp-bar-1', a.payment.id).success).toBe(true);

    const zahlungen = getExpenseFromStoreById('exp-bar-1')?.payments ?? [];
    expect(zahlungen).toHaveLength(1);
    expect(zahlungen[0]?.id).toBe(b.payment.id);
    expect(zahlungen[0]?.proofDocumentId).toBe('doc-kassenbeleg-b');
    /* Das Dokument ist ein Original und wird nie mitgelöscht. */
    expect(listPaymentProofDocuments().map((d) => d.id)).toContain('doc-quittung-a');
  });

  /* ---- D) Die Rückrichtung ---- */

  it('D1 — zu einem Dokument sind seine Zahlungen auffindbar', () => {
    const a = recordExpensePayment('exp-bar-1', {
      date: '2026-10-05', amount: 40, method: 'cash', proofDocumentId: 'doc-quittung-a',
    });
    if (!a.success) throw new Error('Aufbau');

    const treffer = findExpensePaymentsByProofDocument('doc-quittung-a');
    expect(treffer).toHaveLength(1);
    expect(treffer[0]?.expenseId).toBe('exp-bar-1');
    expect(treffer[0]?.payment.id).toBe(a.payment.id);
    expect(findExpensePaymentsByProofDocument('doc-kassenbeleg-b')).toEqual([]);
  });

  /* ---- E) Welche Dokumente kommen in Frage ---- */

  it('E1 — nur Belegarten, die eine Zahlung beweisen', () => {
    expect(PAYMENT_PROOF_DOCUMENT_KINDS).toContain('quittung');
    expect(PAYMENT_PROOF_DOCUMENT_KINDS).toContain('kassenbeleg');
    expect(PAYMENT_PROOF_DOCUMENT_KINDS).toContain('ec_beleg');
    expect(PAYMENT_PROOF_DOCUMENT_KINDS).toContain('kreditkartenbeleg');
    /* Eine Eingangsrechnung ist die Forderung, nicht ihr Beweis. */
    expect(PAYMENT_PROOF_DOCUMENT_KINDS).not.toContain('eingangsrechnung');
  });

  it('E2 — die Auswahl zeigt nur diese Arten', () => {
    const ids = listPaymentProofDocuments().map((d) => d.id);
    expect(ids).toContain('doc-quittung-a');
    expect(ids).toContain('doc-kassenbeleg-b');
    expect(ids).not.toContain('doc-vertrag');
    expect(isPaymentProofDocument(dokument('x', 'arbeitsvertrag', 'x'))).toBe(false);
  });

  it('E3 — die Beschriftung nennt nie die technische Kennung', () => {
    const beschriftung = paymentProofLabel(dokument('doc-geheim-123', 'quittung', 'Quittung Baumarkt'));
    expect(beschriftung).toContain('Quittung Baumarkt');
    expect(beschriftung).not.toContain('doc-geheim-123');
  });

  it('E4 — von Hand abgelegte Belege bleiben wählbar, nur weiter unten', () => {
    /* classifiedKind setzt allein die Erkennung; das Formular bietet es nicht an. */
    const ids = listOtherArchiveDocuments().map((d) => d.id);
    expect(ids).toContain('doc-vertrag');
    expect(ids).not.toContain('doc-quittung-a');
    const alle = [...listPaymentProofDocuments(), ...listOtherArchiveDocuments()].map((d) => d.id);
    expect(alle).toHaveLength(3);
    expect(alle.indexOf('doc-vertrag')).toBeGreaterThan(alle.indexOf('doc-quittung-a'));
  });

  it('E5 — ein unlesbares Datum erscheint nicht als „Invalid Date"', () => {
    const kaputt = { ...dokument('doc-x', 'quittung', 'Quittung ohne Datum'), documentDate: 'irgendwas', issueDate: null };
    const beschriftung = paymentProofLabel(kaputt);
    expect(beschriftung).toBe('Quittung ohne Datum');
    expect(beschriftung).not.toContain('Invalid');
  });

  /* ---- F) Die Zahlungshistorie ---- */

  function historie(expense: Expense): string {
    return renderToStaticMarkup(
      <MemoryRouter>
        <ExpensePaymentHistory expense={expense} translate={translate} allowRemove={false} />
      </MemoryRouter>,
    );
  }

  it('F1 — ohne Nachweis steht es sachlich da', () => {
    recordExpensePayment('exp-bar-1', { date: '2026-10-05', amount: 80, method: 'cash' });
    const html = historie(getExpenseFromStoreById('exp-bar-1')!);
    expect(html).toContain('payment.proof.missing');
    expect(html).not.toContain('payment.proof.linked');
  });

  it('F2 — mit Nachweis steht der Titel und ein Weg zum Beleg', () => {
    recordExpensePayment('exp-bar-1', {
      date: '2026-10-05', amount: 80, method: 'cash', proofDocumentId: 'doc-quittung-a',
    });
    const html = historie(getExpenseFromStoreById('exp-bar-1')!);
    expect(html).toContain('payment.proof.linked');
    expect(html).toContain('Quittung Baumarkt');
    expect(html).toContain('/dokumente/doc-quittung-a');
    expect(html).not.toContain('payment.proof.missing');
  });

  it('F3 — zwei Teilzahlungen zeigen zwei verschiedene Belege', () => {
    recordExpensePayment('exp-bar-1', {
      date: '2026-10-05', amount: 40, method: 'cash', proofDocumentId: 'doc-quittung-a',
    });
    recordExpensePayment('exp-bar-1', {
      date: '2026-10-06', amount: 60, method: 'cash', proofDocumentId: 'doc-kassenbeleg-b',
    });
    const html = historie(getExpenseFromStoreById('exp-bar-1')!);
    expect(html).toContain('/dokumente/doc-quittung-a');
    expect(html).toContain('/dokumente/doc-kassenbeleg-b');
  });

  it('F4 — ein zwischenzeitlich entferntes Dokument wird nicht als Link behauptet', () => {
    /*
     * Erwartung in NACHTRAG 1 bewusst geschärft: Früher stand hier
     * „Kein Zahlungsnachweis verknüpft" — dieselbe Aussage wie bei einer
     * Zahlung, die nie einen hatte. Das war falsch; siehe F7.
     */
    recordExpensePayment('exp-bar-1', {
      date: '2026-10-05', amount: 80, method: 'cash', proofDocumentId: 'doc-quittung-a',
    });
    hydrateDocumentStore([dokument('doc-kassenbeleg-b', 'kassenbeleg', 'Kassenbeleg Baumarkt')]);
    const html = historie(getExpenseFromStoreById('exp-bar-1')!);
    expect(html).toContain('payment.proof.unresolved');
    expect(html).not.toContain('/dokumente/doc-quittung-a');
  });

  it('F5 — ohne Rückruf bleibt die Historie reine Anzeige', () => {
    recordExpensePayment('exp-bar-1', { date: '2026-10-05', amount: 80, method: 'cash' });
    const html = historie(getExpenseFromStoreById('exp-bar-1')!);
    expect(html).not.toContain('payment-proof-edit-');
  });

  it('F6 — mit Rückruf gibt es einen sichtbaren Weg zum Nachweis', () => {
    recordExpensePayment('exp-bar-1', { date: '2026-10-05', amount: 80, method: 'cash' });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ExpensePaymentHistory
          expense={getExpenseFromStoreById('exp-bar-1')!}
          translate={translate}
          allowRemove={false}
          onProofChanged={() => {}}
        />
      </MemoryRouter>,
    );
    expect(html).toContain('payment-proof-edit-');
    expect(html).toContain('payment.proof.add');
  });

  /* ---- G) Nichts Bestehendes verändert ---- */

  it('G1 — eine Bankzahlung ohne Nachweis verhält sich unverändert', () => {
    const ergebnis = recordExpensePayment('exp-bar-1', {
      date: '2026-10-05', amount: 80, method: 'bank',
    });
    expect(ergebnis.success).toBe(true);
    if (!ergebnis.success) return;
    expect(ergebnis.payment.method).toBe('bank');
    expect(ergebnis.payment.proofDocumentId).toBeUndefined();
    expect('proofDocumentId' in ergebnis.payment).toBe(false);
  });

  it('G2 — eine Zahlung ohne Zahlungsart bleibt ohne Zahlungsart', () => {
    const ergebnis = recordExpensePayment('exp-bar-1', { date: '2026-10-05', amount: 80 });
    expect(ergebnis.success).toBe(true);
    if (!ergebnis.success) return;
    expect(ergebnis.payment.method).toBeUndefined();
    expect(ergebnis.payment.proofDocumentId).toBeUndefined();
  });

  it('F7 — ein nicht auffindbarer Nachweis wird benannt, nicht verschwiegen', () => {
    recordExpensePayment('exp-bar-1', {
      date: '2026-10-05', amount: 80, method: 'cash', proofDocumentId: 'doc-quittung-a',
    });
    hydrateDocumentStore([dokument('doc-kassenbeleg-b', 'kassenbeleg', 'Kassenbeleg Baumarkt')]);
    const html = historie(getExpenseFromStoreById('exp-bar-1')!);
    expect(html).toContain('payment.proof.unresolved');
    expect(html).not.toContain('payment.proof.missing');
    expect(html).not.toContain('doc-quittung-a');
  });

  /* ---- H) Der Serververtrag ---- */

  it('H1 — der Nachweis ist eine eigene Funktion, nicht Teil der Geldfunktionen', () => {
    expect(sql).toContain('create or replace function public.set_workspace_expense_payment_proof');
    expect(sql).toContain('create or replace function public.set_workspace_invoice_payment_proof');
    /* Die geldwirksamen Funktionen werden nicht angefasst. */
    expect(sql).not.toContain('function public.add_workspace_expense_payment');
    expect(sql).not.toContain('function public.add_workspace_invoice_payment');
    expect(sql).not.toContain('function public.reverse_workspace_expense_payment');
    expect(sql).not.toContain('function public.reverse_workspace_invoice_payment');
  });

  it('H2 — der Financial-Action-Guard steht in beiden neuen Funktionen', () => {
    const guards = sql.match(/perform public\.assert_financial_action_allowed\(p_workspace_id\)/g) ?? [];
    expect(guards).toHaveLength(2);
    expect(sql).toContain('security definer');
    expect(sql).toContain('set search_path = public');
  });

  it('H3 — das Dokument wird serverseitig gegen den eigenen Workspace geprüft', () => {
    const pruefungen = sql.match(/from public\.workspace_documents d/g) ?? [];
    expect(pruefungen).toHaveLength(2);
    expect(sql).toContain('where d.workspace_id = p_workspace_id');
    expect(sql).toContain("raise exception 'Zahlungsnachweis nicht gefunden'");
  });

  it('H4 — keine Datei in der Datenbank, nur eine Kennung', () => {
    expect(sql).toContain('add column if not exists proof_document_id text null');
    expect(sql).not.toMatch(/bytea|base64|file_content/i);
  });

  it('H5 — der Pull liefert den Nachweis mit', () => {
    const treffer = sql.match(/'proof_document_id', p\.proof_document_id/g) ?? [];
    expect(treffer).toHaveLength(2);
  });

  it('H6 — bereits angewendete Migrationen bleiben unberührt', () => {
    const bank = resolve(
      __dirname,
      '../../../supabase/migrations/20261027120000_workspace_bank_reconciliation_release.sql',
    );
    expect(readFileSync(bank, 'utf8')).not.toContain('proof_document_id');
    const zahlungsart = resolve(
      __dirname,
      '../../../supabase/migrations/20261020120000_workspace_payment_method.sql',
    );
    expect(readFileSync(zahlungsart, 'utf8')).not.toContain('proof_document_id');
  });
});
