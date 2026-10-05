/**
 * BANKABGLEICH-V1 BLOCK 2B — die Cloud-Anbindung der Bankdaten.
 *
 * Geprüft wird der Weg in beide Richtungen: Was das Gerät sendet, was der
 * Server zurückgibt, und was davon lokal ankommt. Dazu die beiden Fragen, an
 * denen Bankdaten scheitern könnten — die Reihenfolge Konto vor Bewegung und
 * der Altbestand, den der Change-Tracker nie von sich aus nachmeldet.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyBankAccountPushResult,
  bankAccountFromCloud,
  bankTransactionFromCloud,
  buildBankAccountCloudContentKey,
  buildBankAccountCloudPushPayload,
  buildBankTransactionCloudContentKey,
  buildBankTransactionCloudPushPayload,
  mergeBankAccountsFromPull,
  mergeBankTransactionsFromPull,
  planBankAccountBackfill,
  planBankTransactionBackfill,
  type WorkspaceBankAccountRow,
  type WorkspaceBankTransactionRow,
} from './bankCloudService';
import {
  LOCAL_ONLY_SYNC_ENTITY_TYPES,
  SUPABASE_SYNC_ALLOWLIST,
  isSupabaseSyncAllowed,
} from '../sync/cloudSyncAllowlist';
import { TRACKED_SYNC_ENTITY_TYPES } from '../sync/syncChangeTrackerService';
import { extractCloudSyncEntity } from '../workspace/workspaceSyncPayloadService';
import { findEntityInState, listEntitiesByType } from '../sync/syncEntityRegistry';
import {
  commitBankImport,
  listBankTransactions,
  resetBankTransactionsForTests,
} from './bankTransactionStore';
import { createBankAccount, resetBankAccountsForTests } from './bankAccountStore';
import { parseBankStatementCsv } from './bankStatementCsvService';
import type { AppPersistedState } from '../../types/models';
import type { BankAccount } from '../../types/bankAccount';
import type { BankTransaction } from '../../types/bankTransaction';

const WS = 'ws-1';
const GERAET = 'dev-1';

function konto(overrides: Partial<BankAccount> = {}): BankAccount {
  return {
    id: 'bacc-1',
    displayName: 'Geschäftskonto',
    identifier: 'DE01',
    createdAt: '2026-10-04T10:00:00.000Z',
    ...overrides,
  };
}

function bewegung(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: 'btx-1',
    accountKey: 'bacc-1',
    importId: 'imp-1',
    fileName: 'auszug.csv',
    importedAt: '2026-10-04T10:00:00.000Z',
    bookingDate: '2026-10-04',
    amountCents: -80000,
    counterparty: 'Vermieter',
    purpose: 'Miete',
    fingerprint: 'bacc-1|2026-10-04|-80000|vermieter|miete|',
    occurrence: 1,
    ...overrides,
  };
}

function kontoZeile(overrides: Partial<WorkspaceBankAccountRow> = {}): WorkspaceBankAccountRow {
  return {
    workspace_id: WS,
    client_account_id: 'bacc-1',
    display_name: 'Geschäftskonto',
    identifier: 'DE01',
    payload: konto() as unknown as Record<string, unknown>,
    row_version: 1,
    updated_at: '2026-10-04T11:00:00.000Z',
    ...overrides,
  };
}

function bewegungZeile(
  overrides: Partial<WorkspaceBankTransactionRow> = {},
): WorkspaceBankTransactionRow {
  return {
    workspace_id: WS,
    client_transaction_id: 'btx-1',
    account_key: 'bacc-1',
    payload: bewegung() as unknown as Record<string, unknown>,
    row_version: 1,
    updated_at: '2026-10-04T11:00:00.000Z',
    ...overrides,
  };
}

describe('BANKABGLEICH-02B Cloud-Anbindung', () => {
  beforeEach(() => {
    localStorage.clear();
    resetBankTransactionsForTests();
    resetBankAccountsForTests();
  });

  /* ---- A) Freigabe ---- */

  it('A1 — beide Typen sind für den Cloud-Sync freigegeben', () => {
    expect(isSupabaseSyncAllowed('bank_account')).toBe(true);
    expect(isSupabaseSyncAllowed('bank_transaction')).toBe(true);
    expect(SUPABASE_SYNC_ALLOWLIST.has('bank_account')).toBe(true);
    expect(SUPABASE_SYNC_ALLOWLIST.has('bank_transaction')).toBe(true);
  });

  it('A2 — sie gelten nicht mehr als nur lokal', () => {
    expect(LOCAL_ONLY_SYNC_ENTITY_TYPES.has('bank_account')).toBe(false);
    expect(LOCAL_ONLY_SYNC_ENTITY_TYPES.has('bank_transaction')).toBe(false);
  });

  it('A3 — beide werden verfolgt, und keine bestehende Entität ging verloren', () => {
    expect(TRACKED_SYNC_ENTITY_TYPES).toContain('bank_account');
    expect(TRACKED_SYNC_ENTITY_TYPES).toContain('bank_transaction');
    for (const bestehend of ['inbox_item', 'task', 'expense', 'vorgang', 'customer', 'offer']) {
      expect(TRACKED_SYNC_ENTITY_TYPES).toContain(bestehend);
    }
    for (const bestehend of ['expense', 'task', 'offer', 'accounting_assignment']) {
      expect(SUPABASE_SYNC_ALLOWLIST.has(bestehend as never)).toBe(true);
    }
  });

  /* ---- B) Push ---- */

  it('B1 — die Konto-Nutzlast trägt Kennung und Client-Entität ohne Sync-Meta', () => {
    const payload = buildBankAccountCloudPushPayload({
      ...konto(),
      sync: { updatedAt: 'x', version: 3, deleted: false, deviceId: GERAET, workspaceId: WS },
    });
    expect(payload.account_id).toBe('bacc-1');
    expect(payload.payload).toMatchObject({ id: 'bacc-1', displayName: 'Geschäftskonto' });
    expect(payload.payload).not.toHaveProperty('sync');
  });

  it('B2 — die Bewegungs-Nutzlast trägt die Felder der Identität', () => {
    const payload = buildBankTransactionCloudPushPayload(bewegung());
    expect(payload.transaction_id).toBe('btx-1');
    expect(payload.payload).toMatchObject({
      accountKey: 'bacc-1',
      fingerprint: 'bacc-1|2026-10-04|-80000|vermieter|miete|',
      occurrence: 1,
      amountCents: -80000,
    });
    /* Kein Matching, keine Zahlung. */
    for (const feld of ['invoiceId', 'expenseId', 'paymentId', 'matchStatus']) {
      expect(payload.payload).not.toHaveProperty(feld);
    }
  });

  it('B3 — der Inhaltsschlüssel ändert sich beim Umbenennen, nicht aber die Kennung', () => {
    const vorher = buildBankAccountCloudContentKey(konto());
    const nachher = buildBankAccountCloudContentKey(konto({ displayName: 'Neuer Name' }));
    expect(vorher).not.toBe(nachher);
    expect(nachher).toContain('bacc-1');
  });

  it('B4 — der Extraktor findet beide Typen im Zustand', () => {
    const state = {
      bankAccounts: [konto()],
      bankTransactions: [bewegung()],
    } as unknown as AppPersistedState;

    const a = extractCloudSyncEntity(state, 'bank_account', 'bacc-1');
    expect(a).toMatchObject({ entityType: 'bank_account', rowVersion: 0, deleted: false });
    const t = extractCloudSyncEntity(state, 'bank_transaction', 'btx-1');
    expect(t).toMatchObject({ entityType: 'bank_transaction', rowVersion: 0, deleted: false });
  });

  it('B5 — die Registry kennt beide Typen', () => {
    const state = {
      bankAccounts: [konto()],
      bankTransactions: [bewegung()],
    } as unknown as AppPersistedState;
    expect(findEntityInState(state, 'bank_account', 'bacc-1')).toBeTruthy();
    expect(listEntitiesByType(state, 'bank_transaction')).toHaveLength(1);
  });

  it('B6 — nach erfolgreichem Push steht die bestätigte Serverversion', () => {
    const danach = applyBankAccountPushResult(
      [konto()],
      'bacc-1',
      7,
      '2026-10-04T12:00:00.000Z',
      GERAET,
      WS,
    );
    expect(danach[0]?.sync).toMatchObject({ version: 7, deleted: false, workspaceId: WS });
    /* Die Fachdaten bleiben unangetastet. */
    expect(danach[0]?.displayName).toBe('Geschäftskonto');
  });

  /* ---- C) Pull ---- */

  it('C1 — ein Konto aus der Cloud wird zur lokalen Entität', () => {
    const gelesen = bankAccountFromCloud(kontoZeile(), GERAET, WS);
    expect(gelesen).toMatchObject({ id: 'bacc-1', displayName: 'Geschäftskonto', identifier: 'DE01' });
    expect(gelesen?.sync).toMatchObject({ version: 1, workspaceId: WS, deleted: false });
  });

  it('C2 — eine Bewegung aus der Cloud wird zur lokalen Entität', () => {
    const gelesen = bankTransactionFromCloud(bewegungZeile(), GERAET, WS);
    expect(gelesen).toMatchObject({
      id: 'btx-1',
      accountKey: 'bacc-1',
      amountCents: -80000,
      occurrence: 1,
    });
  });

  it('C3 — eine unvollständige Zeile wird übersprungen, nicht geraten', () => {
    expect(bankAccountFromCloud(kontoZeile({ payload: {}, display_name: null }), GERAET, WS)).toBeNull();
    expect(bankTransactionFromCloud(bewegungZeile({ payload: { id: 'btx-9' } }))).toBeNull();
  });

  it('C4 — ein frischer lokaler Zustand bekommt die Bankdaten aus der Cloud zurück', () => {
    const konten = mergeBankAccountsFromPull([], [kontoZeile()], GERAET, WS);
    const bewegungen = mergeBankTransactionsFromPull([], [bewegungZeile()], GERAET, WS);
    expect(konten.accounts).toHaveLength(1);
    expect(konten.conflicts).toEqual([]);
    expect(bewegungen.transactions).toHaveLength(1);
    expect(bewegungen.conflicts).toEqual([]);
  });

  it('C5 — ein offener Sendeauftrag wird vom Abzug nicht überschrieben', () => {
    const lokal = konto({ displayName: 'Lokal geändert' });
    const ergebnis = mergeBankAccountsFromPull(
      [lokal],
      [kontoZeile()],
      GERAET,
      WS,
      new Set(['bacc-1']),
    );
    expect(ergebnis.accounts[0]?.displayName).toBe('Lokal geändert');
  });

  it('C6 — ein abweichender Nachweis ist ein Konflikt, keine stille Übernahme', () => {
    const lokal = bewegung({ amountCents: -99999 });
    const ergebnis = mergeBankTransactionsFromPull([lokal], [bewegungZeile()], GERAET, WS);
    expect(ergebnis.conflicts).toEqual(['bank_transaction:btx-1']);
    expect(ergebnis.transactions[0]?.amountCents).toBe(-99999);
  });

  it('C7 — derselbe Abzug zweimal angewandt ändert nichts (Retry)', () => {
    const erste = mergeBankTransactionsFromPull([], [bewegungZeile()], GERAET, WS);
    const zweite = mergeBankTransactionsFromPull(erste.transactions, [bewegungZeile()], GERAET, WS);
    expect(zweite.transactions).toHaveLength(1);
    expect(zweite.conflicts).toEqual([]);
  });

  /* ---- D) Altbestand ---- */

  it('D1 — lokale Bankdaten ohne Cloud-Entsprechung werden nachgetragen', () => {
    expect(planBankAccountBackfill([konto()], [])).toEqual(['bacc-1']);
    expect(planBankTransactionBackfill([bewegung()], [])).toEqual(['btx-1']);
  });

  it('D2 — was bereits oben ist, wird nicht erneut geplant', () => {
    expect(planBankAccountBackfill([konto()], [kontoZeile()])).toEqual([]);
    expect(planBankTransactionBackfill([bewegung()], [bewegungZeile()])).toEqual([]);
  });

  it('D3 — eine Unterbrechung lässt beim nächsten Lauf genau den Rest übrig', () => {
    const lokal = [bewegung(), bewegung({ id: 'btx-2', occurrence: 2 })];
    /* Nur die erste ist oben angekommen. */
    expect(planBankTransactionBackfill(lokal, [bewegungZeile()])).toEqual(['btx-2']);
  });

  /* ---- E) occurrence über die Cloud ---- */

  it('E1 — zwei echte gleiche Bewegungen überleben den Weg durch die Cloud', () => {
    const eins = bewegung({ id: 'btx-1', occurrence: 1 });
    const zwei = bewegung({ id: 'btx-2', occurrence: 2 });
    const ergebnis = mergeBankTransactionsFromPull(
      [],
      [
        bewegungZeile({ client_transaction_id: 'btx-1', payload: eins as unknown as Record<string, unknown> }),
        bewegungZeile({ client_transaction_id: 'btx-2', payload: zwei as unknown as Record<string, unknown> }),
      ],
    );
    expect(ergebnis.transactions.map((t) => t.occurrence).sort()).toEqual([1, 2]);
  });

  it('E2 — nach der Wiederherstellung gilt derselbe Auszug als bereits vorhanden', () => {
    /* Erst der Weg in die Cloud … */
    const a = createBankAccount('Geschäftskonto', 'DE01');
    const csv = parseBankStatementCsv(
      ['Buchungstag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;Betrag', '04.10.2026;Vermieter;Miete;-800,00'].join('\n'),
      'auszug.csv',
    );
    if (!csv.ok) throw new Error('nicht lesbar');
    commitBankImport(csv.preview, a.id);
    const ausDerCloud = listBankTransactions();
    expect(ausDerCloud).toHaveLength(1);

    /* … dann ein frischer lokaler Zustand, der nur den Abzug kennt. */
    resetBankTransactionsForTests();
    const merge = mergeBankTransactionsFromPull(
      [],
      ausDerCloud.map((t) => bewegungZeile({
        client_transaction_id: t.id,
        account_key: t.accountKey,
        payload: t as unknown as Record<string, unknown>,
      })),
      GERAET,
      WS,
    );
    expect(merge.transactions).toHaveLength(1);
  });

  /* ---- F) Kein Geld ---- */

  it('F1 — die Cloud-Anbindung ruft keine Zahlungsfunktion auf', async () => {
    const invoicePayments = await import('../invoicePaymentService');
    const expensePayments = await import('../expensePaymentService');
    const recordPayment = vi.spyOn(invoicePayments, 'recordPayment');
    const recordExpensePayment = vi.spyOn(expensePayments, 'recordExpensePayment');

    buildBankAccountCloudPushPayload(konto());
    buildBankTransactionCloudPushPayload(bewegung());
    mergeBankAccountsFromPull([], [kontoZeile()], GERAET, WS);
    mergeBankTransactionsFromPull([], [bewegungZeile()], GERAET, WS);

    expect(recordPayment).not.toHaveBeenCalled();
    expect(recordExpensePayment).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
