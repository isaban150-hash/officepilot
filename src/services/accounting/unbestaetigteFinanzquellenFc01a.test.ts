/**
 * FINANZ-CORE-01A — Bericht 20 (END19-R1/R2/R3): ein Vertrag „ungeklärte Finanzwirkung bis zum autoritativen
 * Abgleich“ für alle Finanzaktionen, die einen Monatsabschluss beeinflussen (`collectUnconfirmedFinancialSources`).
 * Geprüft wird immer über die echten Abschluss- und Exportwege (`closeAccountingPeriod`,
 * `evaluateAccountingExportReadiness`), die aus dem Gerätebestand lesen.
 *
 *  L   Ausgabenlöschung im Lebenszyklus: vorgemerkt, unbestätigt, abgewiesen, Neustart, synchronisiert,
 *      wiederhergestellt, bereits abgeschlossener Monat; Datumsänderung sperrt alten und neuen Monat
 *  R   Rechteabweisung: Zahlung (Server unbekannt / bekannt), Rücknahme, Altzustand, Rechtewechsel in der Sitzung,
 *      offline, Zahlung in einem anderen Monat, Monat mit weiteren korrekten Belegen
 *  Q   weitere Quellen: Mitarbeiterzahlung (ausstehend, abgewiesen, bewusst erneut senden, Rücknahme), Kontierung,
 *      Rechnungszahlung (Vermerk beim Senden, Nachsicherung, Lokalbetrieb, stornierte Rechnung)
 *  O   Postausgang: Monate vereinigen, Ablösung erbt Monate, automatische Wege lösen nichts ab
 *  F   Fristklärung im Lokalbetrieb: Wiederholung, Konflikt, Parallelität, keine Spur eines Konflikts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetTestStores } from '../../test/resetStores';
import { abschluesseServerbestaetigt } from '../../test/accountingClosureTestUtils';
import { listInvoiceEntries } from '../invoice/invoiceRegistryService';
import { createTestVorgang } from '../../test/fixtures';
import * as supabaseLib from '../../lib/supabase';
import { buildPersistedStateSnapshot, persistAll } from '../persistenceService';
import { normalizeExpense } from '../expenseNormalize';
import { getAllExpensesFromStore, setExpenseStoreForTests } from '../expenseStore';
import { deleteExpense, getExpenseById, updateExpense } from '../expenseService';
import { recordExpensePayment, removeExpensePayment, setExpensePaymentProof } from '../expensePaymentService';
import {
  applyExpensePullToState,
  buildExpensePaymentEntityId,
  buildExpensePushPayload,
  collectDirtyExpenseKeys,
  type CloudExpensePaymentRow,
  type CloudExpenseRow,
  type ExpenseCloudPull,
} from '../expense/expenseCloudSyncService';
import {
  enqueueBackfillSyncOutbox,
  enqueueSyncOutbox,
  getSyncOutboxSnapshot,
  isResendableDeniedOutboxEntry,
  resendFinallyDeniedOutboxEntry,
  resetSyncOutboxForTests,
} from '../sync/syncOutboxService';
import { closeAccountingPeriod, getAccountingPeriodState } from './accountingPeriodService';
import { evaluateAccountingExportReadiness } from './accountingExportGateService';
import { collectUnconfirmedFinancialSources } from './unconfirmedFinancialSources';
import { setAccountingStoreForTests } from './accountingStore';
import { setAccountingPeriodStoreForTests } from './accountingPeriodStore';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import { createEmployee } from '../employee/employeeService';
import {
  confirmEmployeePayment,
  prepareEmployeePaymentConfirmation,
  reverseEmployeePayment,
} from '../employee/employeePaymentService';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { syncInvoicePaymentToCloud } from '../invoicePaymentService';
import * as zahlungCloud from '../invoice/workspaceInvoicePaymentCloudService';
import { resetInvoicePaymentResyncForTests, resyncLocalOnlyInvoicePayments } from '../invoice/invoicePaymentCloudResyncService';
import {
  getUnconfirmedInvoicePaymentKeys,
  isInvoicePaymentUnconfirmed,
  markInvoicePaymentUnconfirmed,
  resetInvoicePaymentConfirmationForTests,
} from '../invoice/invoicePaymentConfirmationStore';
import { getVorgangInvoice, hydrateVorgangStore } from '../vorgangService';
import { klaereRechnungsfrist } from '../invoice/invoiceFristKlaerungService';
import type { AccountingAssignment } from '../../types/accounting';
import type { Expense } from '../../types/expense';
import type { VorgangInvoice } from '../../types/models';
import type { SyncOutboxEntry } from '../../types/sync';

const WS = '00000000-0000-4000-8000-0000000b2001';
const JUNI = '2026-06';
const SPERRE = 'unconfirmed_financial_changes';
const ROLLE = 'finance_forbidden_role: Keine Berechtigung für Finanzaktionen';

/* ------------------------------------------------------------------ */
/* Helfer                                                              */
/* ------------------------------------------------------------------ */

function ausgabe(id: string, patch: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id,
    status: 'gebucht',
    category: 'material',
    supplierName: 'B20 Lieferant',
    invoiceNumber: `B20-${id}`,
    title: `B20 ${id}`,
    issueDate: '2026-06-05',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    ...patch,
  } as Expense);
}

function kontierung(sourceId: string, sourceType: 'expense' | 'invoice' = 'expense'): AccountingAssignment {
  return {
    id: `k-${sourceId}`,
    sourceType,
    sourceId,
    chartOfAccounts: 'SKR03',
    accountNumber: sourceType === 'invoice' ? '8400' : '4930',
    accountLabel: sourceType === 'invoice' ? 'Erlöse 19 %' : 'Bürobedarf',
    taxTreatment: 'standard_19',
    bookingText: `B20 ${sourceId}`,
    status: 'confirmed',
    origin: 'manual',
    confirmedAt: '2026-06-06T10:00:00.000Z',
    createdAt: '2026-06-06T10:00:00.000Z',
    updatedAt: '2026-06-06T10:00:00.000Z',
  };
}

/** Der Server hat alles Bisherige bestätigt (ein gelungener Sendelauf). */
function bestaetigt(): void {
  resetSyncOutboxForTests(getSyncOutboxSnapshot().map((entry) => ({ ...entry, status: 'completed' as const })));
}

/** Gerät in Ruhe: gespeichert (Änderungsverfolger kennt den Stand), alles Bisherige bestätigt. */
function ruhe(): void {
  persistAll();
  bestaetigt();
}

/** Bestand mit bestätigten Belegen und Kontierungen anlegen. */
function bestand(expenses: Expense[], assignments: AccountingAssignment[] = expenses.map((e) => kontierung(e.id))): void {
  setExpenseStoreForTests(expenses.map((e) => ({ ...e, sync: { version: 1, updatedAt: '2026-06-05T10:00:00.000Z', workspaceId: WS, deviceId: 'B', deleted: false } })));
  setAccountingStoreForTests(assignments);
  ruhe();
}

function auftraegeFuer(predicate: (entry: SyncOutboxEntry) => boolean): SyncOutboxEntry[] {
  return getSyncOutboxSnapshot().filter(predicate);
}

/** Den jüngsten passenden Auftrag umstellen (Antwort des Servers). */
function antwort(predicate: (entry: SyncOutboxEntry) => boolean, status: SyncOutboxEntry['status'], meldung?: string): SyncOutboxEntry {
  const ziel = auftraegeFuer(predicate).sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : -1))[0];
  if (!ziel) throw new Error('kein Auftrag');
  resetSyncOutboxForTests(
    getSyncOutboxSnapshot().map((entry) =>
      entry.id === ziel.id
        ? { ...entry, status, ...(meldung ? { lastErrorMessage: meldung, lastErrorAt: '2026-06-07T10:00:00.000Z', lastErrorRetryable: status === 'error' } : {}) }
        : entry,
    ),
  );
  return { ...ziel, status };
}

function sperrt(monat: string): boolean {
  return getAccountingPeriodState(monat).blockers.some((item) => item.code === SPERRE);
}

function sperrQuellen(monat: string): readonly string[] {
  return getAccountingPeriodState(monat).blockers.find((item) => item.code === SPERRE)?.sourceIds ?? [];
}

function abschlussScheitertAnSperre(monat: string): void {
  const result = closeAccountingPeriod(monat);
  expect(result.success).toBe(false);
  expect(result.success ? [] : (result.blockers ?? []).map((item) => item.code)).toContain(SPERRE);
  expect(evaluateAccountingExportReadiness(monat).packageAllowed).toBe(false);
}

/** Neustart: gespeicherter Stand → frischer Speicher. */
function neustart(): void {
  const gespeichert = JSON.parse(JSON.stringify(buildPersistedStateSnapshot())) as ReturnType<typeof buildPersistedStateSnapshot>;
  const kontierungen = gespeichert.accountingAssignments ?? [];
  resetTestStores();
  setAccountingPeriodStoreForTests([]);
  arbeitsbereich();
  setExpenseStoreForTests(gespeichert.expenses ?? []);
  setAccountingStoreForTests(kontierungen);
  resetSyncOutboxForTests(gespeichert.syncOutbox ?? []);
}

function serverZeile(expense: Expense, version = 1): CloudExpenseRow {
  const push = buildExpensePushPayload({ ...expense, sync: { version, updatedAt: '2026-06-05T10:00:00.000Z', workspaceId: WS, deviceId: 'A', deleted: false } }, false);
  return {
    client_expense_id: expense.id,
    status: expense.status,
    dedupe_key: String(push.dedupe_key),
    linked_inbox_id: null,
    archive_document_id: null,
    payload: push.payload as Record<string, unknown>,
    deleted: false,
    row_version: version,
    updated_at: '2026-06-05T10:00:00.000Z',
  };
}

function serverZahlung(expenseId: string, id: string, datum = '2026-06-10', reversed: string | null = null): CloudExpensePaymentRow {
  return {
    client_expense_id: expenseId,
    client_payment_id: id,
    amount: 119,
    paid_on: datum,
    reference: null,
    note: null,
    method: 'bank',
    created_at: '2026-06-10T09:00:00.000Z',
    row_version: 1,
    reversed_at: reversed,
  };
}

/** Ein vollständiger Abzug (wie der Adapter: Abweisungen aus dem Postausgang). */
function abgleich(pull: ExpenseCloudPull): void {
  const state = buildPersistedStateSnapshot();
  const merged = applyExpensePullToState(state, pull, {
    deviceId: 'B',
    workspaceId: WS,
    dirty: collectDirtyExpenseKeys(state.syncOutbox),
    now: '2026-06-08T08:00:00.000Z',
  }).state;
  setExpenseStoreForTests(merged.expenses ?? []);
}

function arbeitsbereich(): void {
  hydrateWorkspaceStore({
    workspaceSettings: { workspaceId: WS, settings: { chartOfAccounts: 'SKR03' }, version: 1, updatedAt: '2026-06-01T10:00:00.000Z' },
  });
}

beforeEach(() => {
  resetTestStores();
  resetSyncOutboxForTests([]);
  setAccountingStoreForTests([]);
  setAccountingPeriodStoreForTests([]);
  resetInvoicePaymentResyncForTests();
  resetInvoicePaymentConfirmationForTests();
  arbeitsbereich();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* L — Ausgabenlöschung im Lebenszyklus (END19-R1)                      */
/* ------------------------------------------------------------------ */

describe('L — Ausgabenlöschung: kein Abschluss, solange sie ungeklärt ist', () => {
  it('L1 vorgemerkt: der Grabstein verschwindet aus der Mappe, der Monat wird trotzdem nicht abschließbar', () => {
    bestand([ausgabe('exp-l1')]);
    expect(deleteExpense('exp-l1').success).toBe(true);
    const [auftrag] = auftraegeFuer((entry) => entry.entityType === 'expense' && entry.operation === 'delete');
    expect(auftrag).toMatchObject({ status: 'pending', affectedMonths: [JUNI] });
    // Die Mappe zählt den Grabstein nicht mehr — früher war der Monat damit „leer“ und abschließbar.
    expect(getAccountingPeriodState(JUNI).currentManifest.documentCount).toBe(0);
    expect(sperrQuellen(JUNI)).toEqual(['exp-l1']);
    abschlussScheitertAnSperre(JUNI);
  });

  it('L2 unbestätigt (Netzfehler) und L3 abgewiesen (fachlich wie Rechte) sperren gleich', () => {
    bestand([ausgabe('exp-l2')]);
    deleteExpense('exp-l2');
    antwort((entry) => entry.entityId === 'exp-l2', 'error', 'TypeError: Failed to fetch');
    abschlussScheitertAnSperre(JUNI);
    antwort((entry) => entry.entityId === 'exp-l2', 'failed', 'Ausgabe hat gebuchte Zahlungen');
    abschlussScheitertAnSperre(JUNI);
    antwort((entry) => entry.entityId === 'exp-l2', 'failed', ROLLE);
    abschlussScheitertAnSperre(JUNI);
  });

  it('L4 Neustart: die ungeklärte Löschung sperrt auch nach dem Laden', () => {
    bestand([ausgabe('exp-l4')]);
    deleteExpense('exp-l4');
    antwort((entry) => entry.entityId === 'exp-l4', 'failed', 'Ausgabe hat gebuchte Zahlungen');
    neustart();
    expect(getAllExpensesFromStore().find((e) => e.id === 'exp-l4')?.sync?.deleted).toBe(true);
    abschlussScheitertAnSperre(JUNI);
  });

  it('L5 synchronisiert: bestätigte Löschung → Monat leer und abschließbar', () => {
    bestand([ausgabe('exp-l5')]);
    deleteExpense('exp-l5');
    bestaetigt();
    expect(sperrt(JUNI)).toBe(false);
    expect(closeAccountingPeriod(JUNI).success).toBe(true);
  });

  it('L6 wiederhergestellt: der Abzug bringt den Serverbeleg samt Zahlung zurück, danach abschließbar', () => {
    const e = ausgabe('exp-l6');
    bestand([e]);
    deleteExpense('exp-l6');
    antwort((entry) => entry.entityId === 'exp-l6', 'failed', 'Ausgabe hat gebuchte Zahlungen');
    abschlussScheitertAnSperre(JUNI);
    abgleich({ expenses: [serverZeile(e)], payments: [serverZahlung(e.id, 'pay-A', '2026-06-10')] });
    const zurueck = getAllExpensesFromStore().find((x) => x.id === 'exp-l6')!;
    expect(zurueck.sync?.deleted).toBe(false);
    expect(zurueck.payments.map((p) => p.id)).toEqual(['pay-A']);
    expect(zurueck.rejectedChanges?.map((c) => c.kind)).toEqual(['delete']);
    ruhe();
    expect(sperrt(JUNI)).toBe(false);
    expect(closeAccountingPeriod(JUNI).success).toBe(true);
    expect(getAccountingPeriodState(JUNI).currentManifest.documentCount).toBe(1);
  });

  it('L7 abgeschlossener Monat: eine danach ungeklärte Löschung sperrt das Übergabepaket', () => {
    bestand([ausgabe('exp-l7')]);
    expect(closeAccountingPeriod(JUNI).success).toBe(true);
    abschluesseServerbestaetigt();
    expect(evaluateAccountingExportReadiness(JUNI).packageAllowed).toBe(true);
    deleteExpense('exp-l7');
    expect(evaluateAccountingExportReadiness(JUNI).packageAllowed).toBe(false);
    expect(sperrt(JUNI)).toBe(true);
  });

  it('L8 Datumsänderung: der alte Monat bleibt gesperrt, bis der Server die Änderung bestätigt', () => {
    bestand([ausgabe('exp-l8')]);
    expect(updateExpense('exp-l8', { issueDate: '2026-07-03' }).success).toBe(true);
    const [auftrag] = auftraegeFuer((entry) => entry.entityId === 'exp-l8' && entry.status === 'pending');
    expect(auftrag.affectedMonths).toEqual(['2026-06', '2026-07']);
    expect(getAccountingPeriodState(JUNI).currentManifest.documentCount).toBe(0);
    abschlussScheitertAnSperre(JUNI);
    expect(sperrt('2026-07')).toBe(true);
    // Monate vor dem ersten berührten Monat bleiben frei — keine pauschale Sperre.
    expect(sperrt('2026-05')).toBe(false);
    bestaetigt();
    expect(sperrt(JUNI)).toBe(false);
    expect(closeAccountingPeriod(JUNI).success).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* R — Rechteabweisung (END19-R2)                                       */
/* ------------------------------------------------------------------ */

describe('R — eine Rechteabweisung ist nach Rechtewiederkehr nicht abschlusssicher', () => {
  function bezahlt(id: string, datum = '2026-06-10'): string {
    bestand([ausgabe(id)]);
    expect(recordExpensePayment(id, { amount: 119, date: datum }).success).toBe(true);
    return getExpenseById(id)!.payments[0].id;
  }

  it('R1 Zahlung abgewiesen, Server kennt sie nicht: Sperre bis zum Abzug, auch nach Neustart; danach ohne Wirkung', () => {
    const paymentId = bezahlt('exp-r1');
    const auftrag = antwort((entry) => entry.entityType === 'expense_payment', 'failed', ROLLE);
    expect(auftrag.affectedMonths).toEqual([JUNI]);
    abschlussScheitertAnSperre(JUNI);
    // Rechte wieder da — lokal ändert das nichts; ohne Abzug bleibt die Abweisung ungeklärt.
    neustart();
    abschlussScheitertAnSperre(JUNI);
    abgleich({ expenses: [serverZeile(ausgabe('exp-r1'))], payments: [] });
    const e = getExpenseById('exp-r1')!;
    expect(e.payments).toEqual([]);
    expect(e.rejectedPayments?.map((p) => p.id)).toEqual([paymentId]);
    expect(sperrt(JUNI)).toBe(false);
    expect(closeAccountingPeriod(JUNI).success).toBe(true);
  });

  it('R2 Zahlung abgewiesen, Server kennt sie (verlorene frühere Antwort): bleibt genau einmal, als bestätigt belegt', () => {
    const paymentId = bezahlt('exp-r2');
    antwort((entry) => entry.entityType === 'expense_payment', 'failed', ROLLE);
    abschlussScheitertAnSperre(JUNI);
    abgleich({ expenses: [serverZeile(ausgabe('exp-r2'))], payments: [serverZahlung('exp-r2', paymentId)] });
    const e = getExpenseById('exp-r2')!;
    expect(e.payments.map((p) => p.id)).toEqual([paymentId]);
    expect(e.rejectedPayments ?? []).toEqual([]);
    expect(e.reconciledRejections).toMatchObject([{ outcome: 'server_confirmed', paymentId }]);
    // Ein zweiter Abzug (Neustart) belegt nichts doppelt.
    abgleich({ expenses: [serverZeile(ausgabe('exp-r2'))], payments: [serverZahlung('exp-r2', paymentId)] });
    expect(getExpenseById('exp-r2')!.reconciledRejections).toHaveLength(1);
    expect(sperrt(JUNI)).toBe(false);
    // Der Nachweis übersteht das Laden (Normalisierung) und eine spätere Nutzeränderung des Belegs.
    const geladen = normalizeExpense(JSON.parse(JSON.stringify(getExpenseById('exp-r2'))) as Expense);
    expect(geladen.reconciledRejections).toEqual(getExpenseById('exp-r2')!.reconciledRejections);
    ruhe();
    expect(updateExpense('exp-r2', { title: 'B20 später geändert' }).success).toBe(true);
    expect(getExpenseById('exp-r2')!.reconciledRejections).toHaveLength(1);
    bestaetigt();
    expect(sperrt(JUNI)).toBe(false);
  });

  it('R3 Rücknahme abgewiesen: lokal weg, der Monat der Zahlung bleibt gesperrt; der Abzug stellt sie wieder her', () => {
    const paymentId = bezahlt('exp-r3', '2026-06-20');
    bestaetigt();
    expect(removeExpensePayment('exp-r3', paymentId).success).toBe(true);
    const ruecknahme = antwort((entry) => entry.entityType === 'expense_payment' && entry.operation === 'delete', 'failed', ROLLE);
    expect(ruecknahme.affectedMonths).toEqual([JUNI]);
    expect(getExpenseById('exp-r3')!.payments).toEqual([]);
    abschlussScheitertAnSperre(JUNI);
    abgleich({ expenses: [serverZeile(ausgabe('exp-r3'))], payments: [serverZahlung('exp-r3', paymentId, '2026-06-20')] });
    const e = getExpenseById('exp-r3')!;
    expect(e.payments.map((p) => p.id)).toEqual([paymentId]);
    expect(e.rejectedChanges?.map((c) => c.kind)).toEqual(['payment_reverse']);
    expect(sperrt(JUNI)).toBe(false);
  });

  it('R3b Rücknahme abgewiesen, Server hatte sie nie oder schon storniert: nichts zurückzunehmen, belegt', () => {
    const paymentId = bezahlt('exp-r3b');
    bestaetigt();
    removeExpensePayment('exp-r3b', paymentId);
    antwort((entry) => entry.entityType === 'expense_payment' && entry.operation === 'delete', 'failed', ROLLE);
    abschlussScheitertAnSperre(JUNI);
    abgleich({ expenses: [serverZeile(ausgabe('exp-r3b'))], payments: [serverZahlung('exp-r3b', paymentId, '2026-06-10', '2026-06-11T10:00:00.000Z')] });
    expect(getExpenseById('exp-r3b')!.payments).toEqual([]);
    expect(getExpenseById('exp-r3b')!.reconciledRejections).toMatchObject([{ outcome: 'nothing_to_undo', paymentId }]);
    expect(sperrt(JUNI)).toBe(false);
  });

  /*
   * FINANZ-CORE-01A — WEISS B21-C1: Erstellen, Bestätigen, Zurücknehmen und Abweisen in DERSELBEN Millisekunde. Bisher
   * gewann der ältere erledigte Erstellauftrag (er steht in der Warteschlange hinter der jüngeren Rücknahme) — die
   * Abweisung verschwand, der Monat war abschließbar. Eingefrorene Zeit statt Glück mit der Uhr (R3b schlug bei WEISS
   * zeitabhängig fehl).
   */
  function gleicheMillisekunde(): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-20T10:00:00.000Z'));
  }

  it('R3c gleiche Millisekunde: die abgewiesene Rücknahme bleibt in der Abschlusskontrolle, der Abzug klärt sie', () => {
    gleicheMillisekunde();
    try {
      const paymentId = bezahlt('exp-r3c', '2026-06-20');
      bestaetigt();
      expect(removeExpensePayment('exp-r3c', paymentId).success).toBe(true);
      antwort((entry) => entry.entityType === 'expense_payment' && entry.operation === 'delete', 'failed', ROLLE);
      const auftraege = auftraegeFuer((entry) => entry.entityType === 'expense_payment');
      expect(new Set(auftraege.map((entry) => entry.queuedAt)).size).toBe(1);
      expect(new Set(auftraege.map((entry) => entry.sequence)).size).toBe(auftraege.length);
      expect(sperrQuellen(JUNI)).toContain('exp-r3c');
      abschlussScheitertAnSperre(JUNI);
      abgleich({ expenses: [serverZeile(ausgabe('exp-r3c'))], payments: [serverZahlung('exp-r3c', paymentId, '2026-06-20')] });
      expect(getExpenseById('exp-r3c')!.payments?.map((p) => p.id)).toEqual([paymentId]);
      expect(sperrt(JUNI)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('R3d gleiche Millisekunde, die jüngere Rücknahme steht hinten (zusammengeführter Sync-Lauf): weiter gesperrt', () => {
    gleicheMillisekunde();
    try {
      const paymentId = bezahlt('exp-r3d', '2026-06-20');
      bestaetigt();
      expect(removeExpensePayment('exp-r3d', paymentId).success).toBe(true);
      antwort((entry) => entry.entityType === 'expense_payment' && entry.operation === 'delete', 'failed', ROLLE);
      resetSyncOutboxForTests([...getSyncOutboxSnapshot()].reverse());
      expect(auftraegeFuer(() => true).at(-1)).toMatchObject({ operation: 'delete', status: 'failed' });
      abschlussScheitertAnSperre(JUNI);
    } finally {
      vi.useRealTimers();
    }
  });

  it('R3e WEISS-Gegenprobe mit 2 ms Abstand: unverändert gesperrt', () => {
    gleicheMillisekunde();
    try {
      const paymentId = bezahlt('exp-r3e', '2026-06-20');
      bestaetigt();
      vi.setSystemTime(new Date('2026-06-20T10:00:00.002Z'));
      expect(removeExpensePayment('exp-r3e', paymentId).success).toBe(true);
      antwort((entry) => entry.entityType === 'expense_payment' && entry.operation === 'delete', 'failed', ROLLE);
      abschlussScheitertAnSperre(JUNI);
    } finally {
      vi.useRealTimers();
    }
  });

  it('R4 Altzustand (Auftrag ohne Monatsangabe, Ausgabe ohne Nachweis): sperrt aus den Fakten', () => {
    bestand([{ ...ausgabe('exp-r4'), payments: [{ id: 'pay-alt', date: '2026-06-12', amount: 119, createdAt: '2026-06-12T10:00:00.000Z' }] }]);
    resetSyncOutboxForTests([
      {
        id: 'alt-1', entityType: 'expense_payment', entityId: buildExpensePaymentEntityId('exp-r4', 'pay-alt'), operation: 'create',
        version: 1, queuedAt: '2026-06-12T10:00:00.000Z', retryCount: 1, status: 'failed', lastErrorMessage: ROLLE,
      },
    ]);
    abschlussScheitertAnSperre(JUNI);
    abgleich({ expenses: [serverZeile(ausgabe('exp-r4'))], payments: [] });
    expect(getExpenseById('exp-r4')!.rejectedPayments?.map((p) => p.id)).toEqual(['pay-alt']);
    expect(sperrt(JUNI)).toBe(false);
  });

  it('R5 Rechtewechsel in der Sitzung: die bewusste neue Aktion löst die Abweisung ab, erbt ihren Monat und sperrt bis zur Bestätigung', () => {
    const paymentId = bezahlt('exp-r5');
    antwort((entry) => entry.entityType === 'expense_payment', 'failed', ROLLE);
    expect(setExpensePaymentProof('exp-r5', paymentId, null).success).toBe(true);
    const offen = auftraegeFuer((entry) => entry.entityType === 'expense_payment' && entry.status === 'pending');
    expect(offen).toHaveLength(1);
    expect(offen[0].affectedMonths).toEqual([JUNI]);
    abschlussScheitertAnSperre(JUNI);
    bestaetigt();
    expect(sperrt(JUNI)).toBe(false);
  });

  it('R6 offline: wiederholbare Fehler werden nie als bestätigt umgedeutet', () => {
    bezahlt('exp-r6');
    antwort((entry) => entry.entityType === 'expense_payment', 'error', 'TypeError: Failed to fetch');
    neustart();
    abschlussScheitertAnSperre(JUNI);
  });

  it('R7 Zahlung in einem späteren Monat: sperrt deren Monat und danach, nicht den Belegmonat davor', () => {
    bezahlt('exp-r7', '2026-07-15');
    antwort((entry) => entry.entityType === 'expense_payment', 'failed', ROLLE);
    expect(sperrt(JUNI)).toBe(false);
    expect(closeAccountingPeriod(JUNI).success).toBe(true);
    abschlussScheitertAnSperre('2026-07');
    expect(sperrt('2026-08')).toBe(true);
  });

  it('R8 Monat mit weiteren korrekten Belegen: nur die betroffene Ausgabe steht in der Sperre', () => {
    bestand([ausgabe('exp-ok-1'), ausgabe('exp-ok-2'), ausgabe('exp-r8')]);
    recordExpensePayment('exp-r8', { amount: 119, date: '2026-06-10' });
    antwort((entry) => entry.entityType === 'expense_payment', 'failed', ROLLE);
    expect(sperrQuellen(JUNI)).toEqual(['exp-r8']);
    abschlussScheitertAnSperre(JUNI);
  });
});

/* ------------------------------------------------------------------ */
/* Q — weitere Finanzquellen                                            */
/* ------------------------------------------------------------------ */

describe('Q — Mitarbeiterzahlungen, Kontierungen und Rechnungszahlungen folgen demselben Vertrag', () => {
  function mitarbeiterzahlung(datum: string): string {
    const employee = createEmployee({ name: 'Erika B20' }, { userId: 'owner-b20' });
    if (!employee.success) throw new Error(employee.errorKey);
    const prepared = prepareEmployeePaymentConfirmation({ employeeId: employee.employee.id, kind: 'wage', amount: '1.250,00', paymentDate: datum, paymentMethod: 'cash' });
    if (!prepared.ok) throw new Error(prepared.errorKey);
    const confirmed = confirmEmployeePayment(prepared.intent, { userId: 'owner-b20' });
    if (!confirmed.success) throw new Error(confirmed.errorKey);
    return confirmed.payment.id;
  }

  it('Q1 Mitarbeiterzahlung ausstehend: sperrt genau ihren Monat; bestätigt frei', () => {
    ruhe();
    const id = mitarbeiterzahlung('2026-06-25');
    expect(auftraegeFuer((entry) => entry.entityType === 'employee_payment')[0]).toMatchObject({ entityId: id, status: 'pending', affectedMonths: [JUNI] });
    expect(sperrQuellen(JUNI)).toEqual([id]);
    abschlussScheitertAnSperre(JUNI);
    expect(sperrt('2026-07')).toBe(false);
    bestaetigt();
    expect(sperrt(JUNI)).toBe(false);
  });

  it('Q2 Mitarbeiterzahlung rechteabgewiesen: sperrt; bewusst erneut senden → ausstehend (sperrt weiter) → angenommen frei', () => {
    ruhe();
    const id = mitarbeiterzahlung('2026-06-25');
    const abgewiesen = antwort((entry) => entry.entityType === 'employee_payment', 'failed', ROLLE);
    abschlussScheitertAnSperre(JUNI);
    neustart();
    abschlussScheitertAnSperre(JUNI);
    expect(isResendableDeniedOutboxEntry(getSyncOutboxSnapshot().find((entry) => entry.id === abgewiesen.id)!)).toBe(true);
    const neu = resendFinallyDeniedOutboxEntry(abgewiesen.id);
    expect(neu).toMatchObject({ entityId: id, status: 'pending', affectedMonths: [JUNI] });
    expect(getSyncOutboxSnapshot().find((entry) => entry.id === abgewiesen.id)?.status).toBe('completed');
    abschlussScheitertAnSperre(JUNI);
    // Nicht doppelt: der abgelöste Auftrag lässt sich nicht noch einmal senden.
    expect(resendFinallyDeniedOutboxEntry(abgewiesen.id)).toBeNull();
    bestaetigt();
    expect(sperrt(JUNI)).toBe(false);
  });

  it('Q3 Rücknahme einer Mitarbeiterzahlung im Folgemonat sperrt Zahlungs- und Rücknahmemonat', () => {
    ruhe();
    vi.useFakeTimers({ now: new Date('2026-07-02T10:00:00.000Z'), toFake: ['Date'] });
    try {
      const id = mitarbeiterzahlung('2026-06-25');
      bestaetigt();
      expect(reverseEmployeePayment(id, 'Doppelt erfasst').success).toBe(true);
      const [auftrag] = auftraegeFuer((entry) => entry.entityType === 'employee_payment' && entry.status === 'pending');
      expect(auftrag.affectedMonths).toEqual(['2026-06', '2026-07']);
      expect(sperrt(JUNI)).toBe(true);
      expect(sperrt('2026-07')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Q4 Kontierung ausstehend oder abgewiesen sperrt den Belegmonat; nur Ausgaben-Aufträge sind nicht „erneut sendbar“', () => {
    bestand([ausgabe('exp-q4')], []);
    setAccountingStoreForTests([kontierung('exp-q4')]);
    persistAll();
    expect(auftraegeFuer((entry) => entry.entityType === 'accounting_assignment')[0]?.status).toBe('pending');
    abschlussScheitertAnSperre(JUNI);
    const abgewiesen = antwort((entry) => entry.entityType === 'accounting_assignment', 'failed', ROLLE);
    abschlussScheitertAnSperre(JUNI);
    expect(resendFinallyDeniedOutboxEntry(abgewiesen.id)).not.toBeNull();
    bestaetigt();
    expect(sperrt(JUNI)).toBe(false);
    expect(closeAccountingPeriod(JUNI).success).toBe(true);
    // Ausgaben klärt der Abzug — kein Umweg über „erneut senden“.
    recordExpensePayment('exp-q4', { amount: 10, date: '2026-08-01' });
    const zahlung = antwort((entry) => entry.entityType === 'expense_payment', 'failed', ROLLE);
    expect(resendFinallyDeniedOutboxEntry(zahlung.id)).toBeNull();
  });

  function rechnung(id: string, payments: VorgangInvoice['payments'], patch: Partial<VorgangInvoice> = {}): VorgangInvoice {
    return {
      id,
      number: `RE-B20-${id}`,
      type: 'rechnung',
      status: 'versendet',
      amount: 119,
      subtotal: 100,
      taxStatus: 'standard_19',
      positions: [],
      date: '2026-06-03',
      issueDate: '2026-06-03',
      createdAt: '2026-06-03T08:00:00.000Z',
      paymentDueDate: '2026-06-17',
      customerSnapshot: { name: 'B20 Kunde', street: 'Weg 1', zip: '48431', city: 'Rheine' },
      payments,
      ...patch,
    } as unknown as VorgangInvoice;
  }

  const zahlung = (id: string, date: string) => ({ id, date, amount: 119, createdAt: `${date}T10:00:00.000Z` });

  it('Q5 Rechnungszahlung: vermerkt vor dem Senden, bleibt bei jedem Fehlschlag, fällt bei Bestätigung und im reinen Lokalbetrieb', async () => {
    hydrateInvoiceStore([{ invoice: rechnung('inv-q5', [zahlung('pay-q5', '2026-06-20')]), vorgangId: null }]);
    setAccountingStoreForTests([kontierung('inv-q5', 'invoice')]);
    ruhe();
    // Systemische Gesamtnacharbeit (D4) — im Cloudbetrieb zählt nur positive Evidenz: nie bestätigt heißt gesperrt.
    expect(sperrt(JUNI)).toBe(true);
    const spy = vi.spyOn(zahlungCloud, 'addInvoicePaymentToCloud');
    for (const outcome of ['failed', 'denied', 'conflict', 'workspace_missing', 'overpayment_unconfirmed'] as const) {
      spy.mockResolvedValueOnce({ outcome } as never);
      expect(await syncInvoicePaymentToCloud('inv-q5', zahlung('pay-q5', '2026-06-20'))).toBe(outcome);
      expect(isInvoicePaymentUnconfirmed('inv-q5', 'pay-q5')).toBe(true);
      abschlussScheitertAnSperre(JUNI);
    }
    expect(sperrt('2026-05')).toBe(false);
    expect(sperrt('2026-09')).toBe(true);
    spy.mockResolvedValueOnce({ outcome: 'synced', row: {} } as never);
    expect(await syncInvoicePaymentToCloud('inv-q5', zahlung('pay-q5', '2026-06-20'))).toBe('synced');
    expect(isInvoicePaymentUnconfirmed('inv-q5', 'pay-q5')).toBe(false);
    // D4 — die Bestätigung steht dauerhaft an der Zahlung im Hauptbestand.
    expect(listInvoiceEntries().find((e) => e.invoice.id === 'inv-q5')?.invoice.payments?.[0]?.cloudBestaetigt).toBe(true);
    expect(sperrt(JUNI)).toBe(false);
    spy.mockResolvedValueOnce({ outcome: 'supabase_not_configured' } as never);
    await syncInvoicePaymentToCloud('inv-q5', zahlung('pay-q5', '2026-06-20'));
    expect(getUnconfirmedInvoicePaymentKeys().size).toBe(0);
  });

  it('Q6 Rechnungszahlung: ein Sendeabbruch (Neustart mitten im Senden) lässt den Vermerk stehen', async () => {
    hydrateInvoiceStore([{ invoice: rechnung('inv-q6', [zahlung('pay-q6', '2026-06-20')]), vorgangId: null }]);
    vi.spyOn(zahlungCloud, 'addInvoicePaymentToCloud').mockRejectedValueOnce(new Error('Seite geschlossen'));
    expect(await syncInvoicePaymentToCloud('inv-q6', zahlung('pay-q6', '2026-06-20'))).toBe('failed');
    expect(isInvoicePaymentUnconfirmed('inv-q6', 'pay-q6')).toBe(true);
  });

  it('Q7 Nachsicherung: vollständiger Abzug vermerkt Zahlungen eines Altclients und hebt bekannte auf', async () => {
    const inv = rechnung('inv-q7', [zahlung('pay-alt', '2026-06-20'), zahlung('pay-bekannt', '2026-06-21')]);
    hydrateInvoiceStore([{ invoice: inv, vorgangId: null }]);
    markInvoicePaymentUnconfirmed('inv-q7', 'pay-bekannt');
    const report = await resyncLocalOnlyInvoicePayments(
      {
        listInvoices: () => [inv],
        pull: async () => ({ outcome: 'synced', rows: [{ clientInvoiceId: 'inv-q7', clientPaymentId: 'pay-bekannt' }] }) as never,
        push: async () => 'failed',
        now: () => Date.parse('2026-06-22T10:00:00.000Z'),
      },
      { force: true },
    );
    expect(report.candidates).toBe(1);
    expect([...getUnconfirmedInvoicePaymentKeys()]).toEqual(['inv-q7#pay-alt']);
    const nachher = await resyncLocalOnlyInvoicePayments(
      {
        listInvoices: () => [inv],
        pull: async () => ({ outcome: 'synced', rows: [{ clientInvoiceId: 'inv-q7', clientPaymentId: 'pay-bekannt' }] }) as never,
        push: async () => 'synced',
        now: () => Date.parse('2026-06-22T11:00:00.000Z'),
      },
      { force: true },
    );
    expect(nachher.synced).toBe(1);
    expect(getUnconfirmedInvoicePaymentKeys().size).toBe(0);
  });

  it('Q9 abgeschlossener Monat bleibt gültig, das Übergabepaket sperrt aber, sobald eine gebundene Zahlung als unbestätigt erkannt ist', () => {
    // Die Zahlung ist vom Server bestätigt (positive Evidenz an der Zahlung), der Abschluss angenommen.
    hydrateInvoiceStore([{ invoice: rechnung('inv-q9', [{ ...zahlung('pay-q9', '2026-06-20'), cloudBestaetigt: true }]), vorgangId: null }]);
    setAccountingStoreForTests([kontierung('inv-q9', 'invoice')]);
    ruhe();
    expect(closeAccountingPeriod(JUNI).success).toBe(true);
    abschluesseServerbestaetigt();
    expect(evaluateAccountingExportReadiness(JUNI).packageAllowed).toBe(true);
    // Die Nachsicherung stellt später fest: Der Server kennt diese Zahlung nicht (z. B. Altclient).
    markInvoicePaymentUnconfirmed('inv-q9', 'pay-q9');
    const state = getAccountingPeriodState(JUNI);
    expect(state.readiness).toBe('closed');
    expect(state.isCurrentClosureValid).toBe(true);
    const gate = evaluateAccountingExportReadiness(JUNI);
    expect(gate.packageAllowed).toBe(false);
    expect(gate.packageBlockers.map((b) => b.code)).toContain('period_blockers');
    expect(state.blockers.map((b) => b.code)).toEqual([SPERRE]);
  });

  /*
   * Systemische Gesamtnacharbeit (SYS-02 / D4) — ein Lese- oder Schreibfehler der Nebenablage darf nie „bestätigt“
   * bedeuten. Bisher lieferte ein nicht lesbarer Gerätespeicher keine Vermerke, und jede Zahlung galt als bestätigt.
   */
  it('Q10 Nebenablage nicht lesbar → eine Zahlung ohne Serverbestätigung sperrt trotzdem (Cloudbetrieb)', () => {
    hydrateInvoiceStore([{ invoice: rechnung('inv-q10', [zahlung('pay-q10', '2026-06-20')]), vorgangId: null }]);
    setAccountingStoreForTests([kontierung('inv-q10', 'invoice')]);
    ruhe();
    const lesen = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: Gerätespeicher gesperrt');
    });
    try {
      expect(getUnconfirmedInvoicePaymentKeys().size).toBe(0);
      expect(sperrt(JUNI)).toBe(true);
      expect(closeAccountingPeriod(JUNI).success).toBe(false);
    } finally {
      lesen.mockRestore();
    }
  });

  it('Q11 positive Bestätigung, Betrieb ohne Cloud und Entzug durch den Nachgleich', async () => {
    const bestaetigt = rechnung('inv-q11', [{ ...zahlung('pay-q11', '2026-06-20'), cloudBestaetigt: true }]);
    const quellen = (invoice: VorgangInvoice, cloudMode: boolean) =>
      collectUnconfirmedFinancialSources(JUNI, {
        outbox: [], expenses: [], employeePayments: [], assignments: [],
        invoices: [invoice],
        unconfirmedInvoicePayments: new Set(),
        cloudMode,
      });
    expect(quellen(bestaetigt, true)).toEqual([]);
    const ohne = rechnung('inv-q11', [zahlung('pay-q11', '2026-06-20')]);
    expect(quellen(ohne, true)).toEqual([{ sourceType: 'invoice_payment', sourceId: 'inv-q11', reason: 'nicht_gesichert', paymentId: 'pay-q11' }]);
    // Betrieb ohne Cloud: lokal, nicht gesperrt.
    expect(quellen(ohne, false)).toEqual([]);
    // Der vollständige Nachgleich belegt: Der Server kennt die Zahlung nicht → die Bestätigung fällt.
    hydrateInvoiceStore([{ invoice: bestaetigt, vorgangId: null }]);
    await resyncLocalOnlyInvoicePayments(
      {
        listInvoices: () => [bestaetigt],
        pull: async () => ({ outcome: 'synced', rows: [] }) as never,
        push: async () => 'failed',
        now: () => Date.parse('2026-06-22T12:00:00.000Z'),
      },
      { force: true },
    );
    expect(listInvoiceEntries().find((e) => e.invoice.id === 'inv-q11')?.invoice.payments?.[0]?.cloudBestaetigt).toBeUndefined();
  });

  it('Q8 Rechnungszahlung einer stornierten Rechnung zählt wie in der Mappe nicht', () => {
    hydrateInvoiceStore([{ invoice: rechnung('inv-q8', [zahlung('pay-q8', '2026-06-20')], { cancelledAt: '2026-06-25T10:00:00.000Z' }), vorgangId: null }]);
    markInvoicePaymentUnconfirmed('inv-q8', 'pay-q8');
    const quellen = (patch: Partial<VorgangInvoice>) =>
      collectUnconfirmedFinancialSources(JUNI, {
        outbox: [], expenses: [], employeePayments: [], assignments: [],
        invoices: [rechnung('inv-q8', [zahlung('pay-q8', '2026-06-20')], patch)],
        unconfirmedInvoicePayments: getUnconfirmedInvoicePaymentKeys(),
      });
    expect(quellen({ cancelledAt: '2026-06-25T10:00:00.000Z' })).toEqual([]);
    // Gegenprobe: dieselbe Zahlung an einer gültigen Rechnung sperrt.
    expect(quellen({})).toEqual([{ sourceType: 'invoice_payment', sourceId: 'inv-q8', reason: 'nicht_gesichert', paymentId: 'pay-q8' }]);
  });
});

/* ------------------------------------------------------------------ */
/* O — Postausgang                                                     */
/* ------------------------------------------------------------------ */

describe('O — die Monate eines Auftrags gehen nie verloren', () => {
  it('O1 zusammengeführte Aufträge vereinigen ihre Monate', () => {
    enqueueSyncOutbox({ entityType: 'expense', entityId: 'exp-o1', operation: 'update', version: 1, affectedMonths: ['2026-06'] });
    const merged = enqueueSyncOutbox({ entityType: 'expense', entityId: 'exp-o1', operation: 'update', version: 1, affectedMonths: ['2026-08', '2026-06'] });
    expect(merged.affectedMonths).toEqual(['2026-06', '2026-08']);
    expect(getSyncOutboxSnapshot()).toHaveLength(1);
  });

  it('O2 die Ablösung einer Abweisung erbt deren Monate; automatische Wege lösen nichts ab', () => {
    const erst = enqueueSyncOutbox({ entityType: 'employee_payment', entityId: 'mz-o2', operation: 'create', version: 1, affectedMonths: ['2026-05'] });
    resetSyncOutboxForTests(getSyncOutboxSnapshot().map((entry) => (entry.id === erst.id ? { ...entry, status: 'failed', lastErrorMessage: ROLLE } : entry)));
    expect(enqueueBackfillSyncOutbox({ entityType: 'employee_payment', entityId: 'mz-o2', operation: 'create', version: 1 })).toBeNull();
    const neu = enqueueSyncOutbox({ entityType: 'employee_payment', entityId: 'mz-o2', operation: 'update', version: 1, affectedMonths: ['2026-07'] });
    expect(neu.affectedMonths).toEqual(['2026-05', '2026-07']);
  });
});

/* ------------------------------------------------------------------ */
/* F — Fristklärung im Lokalbetrieb (END19-R3)                          */
/* ------------------------------------------------------------------ */

describe('F — widersprüchliche Fristklärung im Lokalbetrieb ist ein Konflikt', () => {
  function vorbereiten() {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    const invoice = {
      id: 'inv-f', number: 'RE-F', type: 'rechnung', status: 'versendet', amount: 476, subtotal: 400, taxStatus: 'standard_19', positions: [],
      date: '2026-05-25', issueDate: '2026-05-25', createdAt: '2026-05-25T08:00:00Z', paymentDueDate: '2026-06-08',
      customerSnapshot: { name: 'F Kunde', street: 'Weg 1', zip: '48431', city: 'Rheine' }, payments: [],
    } as unknown as VorgangInvoice;
    hydrateVorgangStore([createTestVorgang({ id: 'v-f', invoices: [invoice] })]);
    return { vorgangId: 'v-f', invoiceId: 'inv-f', klaerung: { art: 'inland' as const, region: 'NW' }, begruendung: 'Sitz geprüft', klaerungId: 'kl-f' };
  }

  it('F1 Wiederholung ändert nichts; andere Angabe oder anderer Grund mit derselben Kennung ist ein Konflikt ohne Spur', async () => {
    const arg = vorbereiten();
    expect((await klaereRechnungsfrist(arg)).ok).toBe(true);
    const nachErster = JSON.stringify(getVorgangInvoice('v-f', 'inv-f'));
    expect((await klaereRechnungsfrist(arg)).ok).toBe(true);
    expect(JSON.stringify(getVorgangInvoice('v-f', 'inv-f'))).toBe(nachErster);
    expect(await klaereRechnungsfrist({ ...arg, klaerung: { art: 'inland', region: 'NI' } })).toMatchObject({ ok: false, errorKey: 'invoice.frist.conflict' });
    expect(await klaereRechnungsfrist({ ...arg, begruendung: 'Anderer Grund' })).toMatchObject({ ok: false, errorKey: 'invoice.frist.conflict' });
    // Der Konflikt hinterlässt nichts: Angabe, Grund und Zeitpunkt der ersten Klärung bleiben.
    expect(JSON.stringify(getVorgangInvoice('v-f', 'inv-f'))).toBe(nachErster);
    expect(getVorgangInvoice('v-f', 'inv-f')!.fristBasis?.klaerung).toMatchObject({ id: 'kl-f', begruendung: 'Sitz geprüft', angabe: { art: 'inland', region: 'NW' } });
  });

  it('F2 parallel mit derselben Kennung: genau eine Fassung gewinnt, die andere ist ein Konflikt', async () => {
    const arg = vorbereiten();
    const [a, b] = await Promise.all([klaereRechnungsfrist(arg), klaereRechnungsfrist({ ...arg, klaerung: { art: 'inland', region: 'NI' } })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const gewonnen = a.ok ? 'NW' : 'NI';
    expect((a.ok ? b : a) as unknown).toMatchObject({ ok: false, errorKey: 'invoice.frist.conflict' });
    expect(getVorgangInvoice('v-f', 'inv-f')!.fristBasis?.klaerung?.angabe).toMatchObject({ region: gewonnen });
  });

  it('F3 eine neue Kennung ist eine neue bewusste Klärung (Berichtigung), kein Konflikt', async () => {
    const arg = vorbereiten();
    await klaereRechnungsfrist(arg);
    const neu = await klaereRechnungsfrist({ ...arg, klaerungId: 'kl-f-2', klaerung: { art: 'inland', region: 'NI' }, begruendung: 'Berichtigt' });
    expect(neu.ok).toBe(true);
    expect(getVorgangInvoice('v-f', 'inv-f')!.fristBasis?.klaerung).toMatchObject({ id: 'kl-f-2', angabe: { region: 'NI' } });
  });
});
