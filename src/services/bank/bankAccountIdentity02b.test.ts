/**
 * BANKABGLEICH-V1 BLOCK 2B — Kontoidentität und Mehrkonto-Sicherheit.
 *
 * Die eine Frage dieses Blocks: Kann eine echte Bankbewegung verschwinden,
 * weil zwei Konten versehentlich als eines gelten? Die Tests prüfen beide
 * Richtungen — zwei Konten bleiben zwei, und dasselbe Konto bleibt eines,
 * auch nach einem Umbenennen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBankAccount,
  ensureBankAccountForIdentifier,
  findBankAccountByIdentifier,
  kontoNameAusKennung,
  listBankAccounts,
  normalizeAccountIdentifier,
  renameBankAccount,
  resetBankAccountsForTests,
} from './bankAccountStore';
import {
  commitBankImport,
  listBankTransactions,
  planBankImport,
  resetBankTransactionsForTests,
} from './bankTransactionStore';
import { parseBankStatementCsv } from './bankStatementCsvService';
import { LOCAL_ONLY_SYNC_ENTITY_TYPES, isSupabaseSyncAllowed } from '../sync/cloudSyncAllowlist';
import { findEntityInState, listEntitiesByType, upsertEntityInState } from '../sync/syncEntityRegistry';
import type { AppPersistedState } from '../../types/models';
import type { BankStatementPreview } from '../../types/bankStatement';

const MIT_KONTO = 'Auftragskonto;Buchungstag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;Betrag';
const OHNE_KONTO = 'Buchungstag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;Betrag';

function lies(kopf: string, ...zeilen: string[]): BankStatementPreview {
  const ergebnis = parseBankStatementCsv([kopf, ...zeilen].join('\n'), 'auszug.csv');
  if (!ergebnis.ok) throw new Error(`nicht lesbar: ${ergebnis.problem}`);
  return ergebnis.preview;
}

describe('BANKABGLEICH-02B Kontoidentität', () => {
  beforeEach(() => {
    localStorage.clear();
    resetBankTransactionsForTests();
    resetBankAccountsForTests();
  });

  /* ---- A) Kontoidentität ---- */

  it('A1 — nennt die Datei ein Konto, wird es automatisch zugeordnet', () => {
    const preview = lies(MIT_KONTO, 'DE89 3704 0044;04.10.2026;Kunde;Zahlung;500,00');
    /* Leerzeichen in der IBAN sind kein anderes Konto. */
    expect(preview.accountKey).toBe('DE8937040044');

    const konto = ensureBankAccountForIdentifier(preview.accountKey);
    expect(konto.identifier).toBe('DE8937040044');
    expect(listBankAccounts()).toHaveLength(1);
  });

  it('A2 — derselbe Auszug legt beim zweiten Mal kein zweites Konto an', () => {
    ensureBankAccountForIdentifier('DE8937040044');
    ensureBankAccountForIdentifier('DE89 3704 0044');
    expect(listBankAccounts()).toHaveLength(1);
  });

  it('A3 — nennt die Datei kein Konto, bleibt die Zuordnung offen', () => {
    const preview = lies(OHNE_KONTO, '04.10.2026;Kunde;Zahlung;500,00');
    expect(preview.accountKey).toBe('');
    expect(findBankAccountByIdentifier('')).toBeNull();
  });

  it('A4 — ohne Konto wird nichts gespeichert', () => {
    const preview = lies(OHNE_KONTO, '04.10.2026;Kunde;Zahlung;500,00');
    expect(() => commitBankImport(preview, '')).toThrow('bankImport.accountRequired');
    expect(listBankTransactions()).toHaveLength(0);
  });

  it('A5 — ein von Hand angelegtes Konto trägt den Auszug', () => {
    const preview = lies(OHNE_KONTO, '04.10.2026;Kunde;Zahlung;500,00');
    const konto = createBankAccount('Geschäftskonto Sparkasse');

    expect(commitBankImport(preview, konto.id)).toMatchObject({ added: 1 });
    expect(listBankTransactions()[0]?.accountKey).toBe(konto.id);
    /* Ohne Kennung aus der Datei — und trotzdem eindeutig. */
    expect(konto.identifier).toBe('');
  });

  it('A6 — die Kontoidentität ist die stabile Kennung, nicht der Name', () => {
    const konto = createBankAccount('Sparkasse');
    const preview = lies(OHNE_KONTO, '04.10.2026;Vermieter;Miete;-800,00');
    commitBankImport(preview, konto.id);

    /* Der Nutzer benennt das Konto um … */
    const umbenannt = renameBankAccount(konto.id, 'Geschäftskonto Sparkasse');
    expect(umbenannt?.displayName).toBe('Geschäftskonto Sparkasse');
    expect(umbenannt?.id).toBe(konto.id);

    /* … und derselbe Auszug wird weiterhin als bereits vorhanden erkannt. */
    const zweiter = commitBankImport(lies(OHNE_KONTO, '04.10.2026;Vermieter;Miete;-800,00'), konto.id);
    expect(zweiter).toMatchObject({ added: 0, alreadyPresent: 1 });
    expect(listBankTransactions()).toHaveLength(1);
  });

  it('A7 — ein Kontoname entsteht ohne die ganze Kontonummer zu zeigen', () => {
    expect(kontoNameAusKennung('DE89370400440532013000')).toBe('Konto …3000');
    /* Die vollstaendige Kennung steht nicht im Namen. */
    expect(kontoNameAusKennung('DE89370400440532013000')).not.toContain('DE89370400440532');
    expect(normalizeAccountIdentifier(' de89 3704 ')).toBe('DE893704');
  });

  it('A8 — ein Konto ohne Namen entsteht nicht', () => {
    expect(() => createBankAccount('   ')).toThrow('bankAccount.nameRequired');
    expect(listBankAccounts()).toHaveLength(0);
  });

  /* ---- B) Mehrkonto ---- */

  it('B1 — dieselbe Bewegung auf zwei Konten bleibt zweimal erhalten', () => {
    const a = createBankAccount('Konto A');
    const b = createBankAccount('Konto B');
    const zeile = () => lies(OHNE_KONTO, '04.10.2026;Vermieter;Miete;-800,00');

    expect(commitBankImport(zeile(), a.id)).toMatchObject({ added: 1 });
    expect(commitBankImport(zeile(), b.id)).toMatchObject({ added: 1, alreadyPresent: 0 });
    expect(listBankTransactions()).toHaveLength(2);
  });

  it('B2 — danach wird jeder Auszug auf seinem eigenen Konto wiedererkannt', () => {
    const a = createBankAccount('Konto A');
    const b = createBankAccount('Konto B');
    const zeile = () => lies(OHNE_KONTO, '04.10.2026;Vermieter;Miete;-800,00');

    commitBankImport(zeile(), a.id);
    commitBankImport(zeile(), b.id);

    expect(commitBankImport(zeile(), a.id)).toMatchObject({ added: 0, alreadyPresent: 1 });
    expect(commitBankImport(zeile(), b.id)).toMatchObject({ added: 0, alreadyPresent: 1 });
    expect(listBankTransactions()).toHaveLength(2);
  });

  it('B3 — dieselbe Datei bewusst einem anderen Konto zugeordnet ist keine Dublette', () => {
    const a = createBankAccount('Konto A');
    const b = createBankAccount('Konto B');
    const datei = () =>
      lies(OHNE_KONTO, '04.10.2026;Kunde;Zahlung;500,00', '05.10.2026;Lieferant;Rechnung;-120,00');

    commitBankImport(datei(), a.id);
    const andersZugeordnet = commitBankImport(datei(), b.id);

    expect(andersZugeordnet).toMatchObject({ added: 2, alreadyPresent: 0 });
    expect(listBankTransactions()).toHaveLength(4);
  });

  it('B4 — die Zählung echter Doppelbuchungen bleibt je Konto getrennt', () => {
    const a = createBankAccount('Konto A');
    const b = createBankAccount('Konto B');
    const doppelt = () =>
      lies(OHNE_KONTO, '04.10.2026;Vermieter;Miete;-800,00', '04.10.2026;Vermieter;Miete;-800,00');

    commitBankImport(doppelt(), a.id);
    commitBankImport(doppelt(), b.id);

    const aufA = listBankTransactions().filter((t) => t.accountKey === a.id);
    const aufB = listBankTransactions().filter((t) => t.accountKey === b.id);
    expect(aufA.map((t) => t.occurrence).sort()).toEqual([1, 2]);
    expect(aufB.map((t) => t.occurrence).sort()).toEqual([1, 2]);
  });

  it('B5 — eine Datei mit Kontospalte landet nicht im Topf eines Handkontos', () => {
    const hand = createBankAccount('Handkonto');
    commitBankImport(lies(OHNE_KONTO, '04.10.2026;Vermieter;Miete;-800,00'), hand.id);

    const ausDatei = lies(MIT_KONTO, 'DE02;04.10.2026;Vermieter;Miete;-800,00');
    const konto = ensureBankAccountForIdentifier(ausDatei.accountKey);
    expect(commitBankImport(ausDatei, konto.id)).toMatchObject({ added: 1, alreadyPresent: 0 });
    expect(listBankTransactions()).toHaveLength(2);
  });

  /* ---- C) Confirm-first bleibt ---- */

  it('C1 — die Planung mit Konto speichert weiterhin nichts', () => {
    const konto = createBankAccount('Konto A');
    const plan = planBankImport(lies(OHNE_KONTO, '04.10.2026;Kunde;Zahlung;500,00'), konto.id);
    expect(plan.neu).toHaveLength(1);
    expect(listBankTransactions()).toHaveLength(0);
  });

  /* ---- D) Cloud-Architektur ---- */

  it('D1 — Bankbewegung und Konto sind der Sync-Registry bekannt', () => {
    const konto = createBankAccount('Konto A');
    commitBankImport(lies(OHNE_KONTO, '04.10.2026;Kunde;Zahlung;500,00'), konto.id);
    const bewegung = listBankTransactions()[0]!;

    const state = {
      inboxItems: [],
      bankTransactions: [bewegung],
      bankAccounts: [konto],
    } as unknown as AppPersistedState;

    expect(findEntityInState(state, 'bank_transaction', bewegung.id)).toMatchObject({ id: bewegung.id });
    expect(findEntityInState(state, 'bank_account', konto.id)).toMatchObject({ id: konto.id });
    expect(listEntitiesByType(state, 'bank_transaction')).toHaveLength(1);
    expect(listEntitiesByType(state, 'bank_account')).toHaveLength(1);

    const danach = upsertEntityInState(state, 'bank_transaction', {
      ...bewegung,
      purpose: 'Geändert',
    });
    expect(danach.bankTransactions?.[0]?.purpose).toBe('Geändert');
    /* Die Eingangsliste bleibt unberührt — upsert ersetzt nicht den Zustand. */
    expect(state.bankTransactions?.[0]?.purpose).not.toBe('Geändert');
  });

  it('D2 — beide Typen sind fuer den Cloud-Sync freigegeben', () => {
    /*
     * Nicht vergessen, sondern bewusst: Ein freigegebener Typ ohne Tabelle
     * wuerde bei jedem Push scheitern. Dieser Test faellt genau dann, wenn
     * jemand die Freigabe erteilt — und erinnert daran, dass dann auch
     * Tracking und Altbestand drankommen.
     */
    expect(isSupabaseSyncAllowed('bank_transaction')).toBe(true);
    expect(isSupabaseSyncAllowed('bank_account')).toBe(true);
    expect(LOCAL_ONLY_SYNC_ENTITY_TYPES.has('bank_transaction')).toBe(false);
    expect(LOCAL_ONLY_SYNC_ENTITY_TYPES.has('bank_account')).toBe(false);
  });

  /* ---- E) Kein Geld ---- */

  it('E1 — Kontoanlage und Import rufen keine Zahlungsfunktion auf', async () => {
    const invoicePayments = await import('../invoicePaymentService');
    const expensePayments = await import('../expensePaymentService');
    const recordPayment = vi.spyOn(invoicePayments, 'recordPayment');
    const recordExpensePayment = vi.spyOn(expensePayments, 'recordExpensePayment');

    const konto = createBankAccount('Konto A');
    commitBankImport(lies(OHNE_KONTO, '04.10.2026;Kunde;Zahlung RE-1;500,00'), konto.id);

    expect(recordPayment).not.toHaveBeenCalled();
    expect(recordExpensePayment).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
