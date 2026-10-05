/**
 * BANKABGLEICH-V1 BLOCK 2B — Bankkonten und Bankbewegungen in der Cloud.
 *
 * Bewusst nach dem Muster der **Mahnnachweise** (`dunningDocumentationCloudService`)
 * und nicht nach dem der Angebote: Bankdaten sind append-only. Es gibt kein
 * Löschen, und eine einmal eingelesene Bewegung ändert sich fachlich nicht —
 * sie ist ein Nachweis dessen, was die Bank gemeldet hat. Damit entfallen
 * Grabsteine, Lost-Ack-Adoption und Entwurfsauflösung, und es bleibt genau
 * das, was ein Nachweis braucht: anlegen, wiedererkennen, nachtragen.
 *
 * **Keine Zahlungswirkung.** Nichts hier ruft eine Zahlungsfunktion auf oder
 * berührt einen Zahlungsstatus.
 */
import type { SyncMeta } from '../../types/sync';
import type { BankAccount } from '../../types/bankAccount';
import type { BankTransaction } from '../../types/bankTransaction';

/* -------------------------------------------------------------------------- */
/* Zeilenform, wie sie der Server liefert                                      */
/* -------------------------------------------------------------------------- */

export interface WorkspaceBankAccountRow {
  id?: string;
  workspace_id: string;
  client_account_id: string;
  display_name: string | null;
  identifier: string | null;
  payload: Record<string, unknown>;
  row_version: number;
  deleted?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface WorkspaceBankTransactionRow {
  id?: string;
  workspace_id: string;
  client_transaction_id: string;
  account_key: string;
  payload: Record<string, unknown>;
  row_version: number;
  deleted?: boolean;
  created_at?: string;
  updated_at?: string;
}

/* -------------------------------------------------------------------------- */
/* Push                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Die Nutzlast, die der Server erwartet.
 *
 * Aussen die Kennung, die der Dispatcher liest; innen die Client-Entität
 * **ohne** Sync-Meta — die gehört dem Gerät, nicht der Cloud.
 */
export function buildBankAccountCloudPushPayload(account: BankAccount): Record<string, unknown> {
  return {
    account_id: account.id,
    payload: stripBankAccountForCloud(account),
  };
}

export function buildBankTransactionCloudPushPayload(
  transaction: BankTransaction,
): Record<string, unknown> {
  return {
    transaction_id: transaction.id,
    payload: stripBankTransactionForCloud(transaction),
  };
}

function stripBankAccountForCloud(account: BankAccount): Record<string, unknown> {
  const { sync: _sync, ...rest } = account;
  return rest as unknown as Record<string, unknown>;
}

function stripBankTransactionForCloud(transaction: BankTransaction): Record<string, unknown> {
  const { sync: _sync, ...rest } = transaction;
  return rest as unknown as Record<string, unknown>;
}

/**
 * Der Inhaltsschlüssel entscheidet, ob zwei Stände dasselbe sagen.
 *
 * Für das Konto zählt alles, was der Nutzer ändern kann; für die Bewegung
 * genügen die Felder der Identität — eine Bewegung ändert sich nicht, und
 * `importId`/`fileName` sind Herkunft, nicht Inhalt. Käme dieselbe Bewegung
 * aus einem zweiten Export derselben Datei, wäre sie trotzdem dieselbe.
 */
export function buildBankAccountCloudContentKey(account: BankAccount): string {
  return [account.id, account.displayName.trim(), account.identifier].join('|');
}

export function buildBankTransactionCloudContentKey(transaction: BankTransaction): string {
  return [
    transaction.id,
    transaction.accountKey,
    transaction.fingerprint,
    String(transaction.occurrence),
    String(transaction.amountCents),
    transaction.bookingDate,
  ].join('|');
}

/* -------------------------------------------------------------------------- */
/* Pull                                                                        */
/* -------------------------------------------------------------------------- */

function istText(wert: unknown): wert is string {
  return typeof wert === 'string' && wert.trim().length > 0;
}

/** Nur was wirklich dasteht — ein unvollständiger Satz wird übersprungen, nicht geraten. */
export function bankAccountFromCloud(
  row: WorkspaceBankAccountRow,
  deviceId: string,
  workspaceId: string,
): BankAccount | null {
  const inner = (row.payload ?? {}) as Record<string, unknown>;
  const id = istText(inner.id) ? inner.id : row.client_account_id;
  const displayName = istText(inner.displayName)
    ? inner.displayName
    : istText(row.display_name)
      ? row.display_name
      : null;
  if (!istText(id) || !displayName) return null;

  const sync: SyncMeta = {
    updatedAt: row.updated_at ?? new Date().toISOString(),
    version: Number(row.row_version ?? 0),
    deleted: false,
    deviceId,
    workspaceId,
  };

  return {
    id,
    displayName,
    identifier: istText(inner.identifier) ? inner.identifier : (row.identifier ?? ''),
    createdAt: istText(inner.createdAt) ? inner.createdAt : (row.created_at ?? new Date().toISOString()),
    sync,
  };
}

export function bankTransactionFromCloud(
  row: WorkspaceBankTransactionRow,
  deviceId: string,
  workspaceId: string,
): BankTransaction | null {
  const inner = (row.payload ?? {}) as Record<string, unknown>;
  const id = istText(inner.id) ? inner.id : row.client_transaction_id;
  const accountKey = istText(inner.accountKey) ? inner.accountKey : row.account_key;
  const fingerprint = istText(inner.fingerprint) ? inner.fingerprint : null;
  const bookingDate = istText(inner.bookingDate) ? inner.bookingDate : null;
  const amountCents = typeof inner.amountCents === 'number' ? inner.amountCents : null;
  const occurrence = typeof inner.occurrence === 'number' ? inner.occurrence : null;

  if (!istText(id) || !istText(accountKey) || !fingerprint || !bookingDate) return null;
  if (amountCents === null || occurrence === null) return null;

  return {
    id,
    accountKey,
    importId: istText(inner.importId) ? inner.importId : '',
    fileName: istText(inner.fileName) ? inner.fileName : '',
    importedAt: istText(inner.importedAt) ? inner.importedAt : (row.created_at ?? new Date().toISOString()),
    bookingDate,
    ...(istText(inner.valueDate) ? { valueDate: inner.valueDate } : {}),
    amountCents,
    ...(istText(inner.currency) ? { currency: inner.currency } : {}),
    ...(istText(inner.counterparty) ? { counterparty: inner.counterparty } : {}),
    ...(istText(inner.counterpartyIban) ? { counterpartyIban: inner.counterpartyIban } : {}),
    ...(istText(inner.purpose) ? { purpose: inner.purpose } : {}),
    ...(istText(inner.bankReference) ? { bankReference: inner.bankReference } : {}),
    fingerprint,
    occurrence,
    /*
     * Sichtbare Abnahme — ohne diese Meta kam eine aus der Cloud geholte
     * Bewegung mit Version 0 zurueck und sah damit aus wie ein nie
     * gesendeter Neuzugang. Das Konto trug seine bestaetigte Version schon,
     * die Bewegung nicht; derselbe Nachweis haette zwei verschiedene
     * Wahrheiten ueber sich selbst erzaehlt.
     */
    sync: {
      updatedAt: row.updated_at ?? new Date().toISOString(),
      version: Number(row.row_version ?? 0),
      deleted: false,
      deviceId,
      workspaceId,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Merge                                                                       */
/* -------------------------------------------------------------------------- */

export function mergeBankAccountsFromPull(
  local: BankAccount[],
  remoteRows: WorkspaceBankAccountRow[],
  deviceId: string,
  workspaceId: string,
  dirtyIds: ReadonlySet<string> = new Set(),
): { accounts: BankAccount[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const byId = new Map(local.map((account) => [account.id, account]));

  for (const row of remoteRows) {
    const remote = bankAccountFromCloud(row, deviceId, workspaceId);
    if (!remote) continue;

    const vorhanden = byId.get(remote.id) ?? null;
    if (!vorhanden) {
      byId.set(remote.id, remote);
      continue;
    }

    /* Ein offener Sendeauftrag gewinnt — der Server hat ihn noch nicht gesehen. */
    if (dirtyIds.has(remote.id)) continue;

    if (vorhanden.sync && vorhanden.sync.version === Number(row.row_version ?? 0)) {
      if (buildBankAccountCloudContentKey(vorhanden) !== buildBankAccountCloudContentKey(remote)) {
        conflicts.push(`bank_account:${remote.id}`);
        continue;
      }
    }
    byId.set(remote.id, remote);
  }

  return { accounts: [...byId.values()], conflicts };
}

export function mergeBankTransactionsFromPull(
  local: BankTransaction[],
  remoteRows: WorkspaceBankTransactionRow[],
  deviceId: string,
  workspaceId: string,
  dirtyIds: ReadonlySet<string> = new Set(),
): { transactions: BankTransaction[]; conflicts: string[] } {
  const conflicts: string[] = [];
  const byId = new Map(local.map((transaction) => [transaction.id, transaction]));

  for (const row of remoteRows) {
    const remote = bankTransactionFromCloud(row, deviceId, workspaceId);
    if (!remote) continue;

    const vorhanden = byId.get(remote.id) ?? null;
    if (!vorhanden) {
      byId.set(remote.id, remote);
      continue;
    }
    if (dirtyIds.has(remote.id)) continue;

    /*
     * Eine Bewegung ist ein Nachweis und ändert sich nicht. Weicht der Inhalt
     * trotzdem ab, ist das ein Konflikt und keine Übernahme — lieber den
     * lokalen Stand stehen lassen und melden, als einen Kontoauszug
     * stillschweigend umzuschreiben.
     */
    if (
      buildBankTransactionCloudContentKey(vorhanden) !==
      buildBankTransactionCloudContentKey(remote)
    ) {
      conflicts.push(`bank_transaction:${remote.id}`);
      continue;
    }
    byId.set(remote.id, remote);
  }

  return { transactions: [...byId.values()], conflicts };
}

/* -------------------------------------------------------------------------- */
/* Altbestand                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Welche lokalen Bankdaten der Server noch nicht kennt.
 *
 * Von Natur aus idempotent und wiederholbar: Verglichen wird gegen die
 * Kennungen, die derselbe Abzug gerade geliefert hat. Was einmal oben ist,
 * taucht im nächsten Abzug auf und wird nicht erneut geplant — und eine
 * Unterbrechung lässt beim nächsten Lauf einfach den Rest übrig.
 */
export function planBankAccountBackfill(
  local: BankAccount[],
  remoteRows: WorkspaceBankAccountRow[],
): string[] {
  const remoteIds = new Set(remoteRows.map((row) => row.client_account_id));
  return local.filter((account) => !remoteIds.has(account.id)).map((account) => account.id);
}

export function planBankTransactionBackfill(
  local: BankTransaction[],
  remoteRows: WorkspaceBankTransactionRow[],
): string[] {
  const remoteIds = new Set(remoteRows.map((row) => row.client_transaction_id));
  return local.filter((transaction) => !remoteIds.has(transaction.id)).map((t) => t.id);
}

/** Setzt nach erfolgreichem Push die Serverversion — ohne Fachdaten anzufassen. */
export function applyBankAccountPushResult(
  accounts: BankAccount[],
  accountId: string,
  rowVersion: number,
  updatedAt: string,
  deviceId: string,
  workspaceId: string,
): BankAccount[] {
  return accounts.map((account) =>
    account.id === accountId
      ? { ...account, sync: { updatedAt, version: rowVersion, deleted: false, deviceId, workspaceId } }
      : account,
  );
}

/* -------------------------------------------------------------------------- */
/* BLOCK 4 — bestätigte Zuordnungen (nur Pull)                                 */
/* -------------------------------------------------------------------------- */

export interface WorkspaceBankReconciliationRow {
  id?: string;
  workspace_id: string;
  client_reconciliation_id: string;
  bank_transaction_id: string;
  target_type: string;
  client_target_id: string;
  client_payment_id: string;
  amount_cents: number | string;
  paid_on: string;
  confirmed_at?: string;
  payload?: Record<string, unknown>;
  row_version?: number;
  deleted?: boolean;
}

/**
 * Eine Zuordnung aus der Cloud.
 *
 * Es gibt bewusst keinen Merge mit Konflikterkennung wie bei den anderen
 * Entitäten: Eine Zuordnung entsteht nur serverseitig und ändert sich
 * danach nicht. Der Server hat immer recht, und lokal gibt es nichts, was
 * mit ihm streiten könnte.
 */
export function bankReconciliationFromCloud(
  row: WorkspaceBankReconciliationRow,
  deviceId: string,
  workspaceId: string,
): import('../../types/bankReconciliation').BankReconciliation | null {
  if (!row.bank_transaction_id || !row.client_target_id || !row.client_payment_id) return null;
  return {
    id: row.client_reconciliation_id,
    bankTransactionId: row.bank_transaction_id,
    targetType: row.target_type === 'expense' ? 'expense' : 'invoice',
    targetId: row.client_target_id,
    paymentId: row.client_payment_id,
    amountCents: Number(row.amount_cents ?? 0),
    paidOn: row.paid_on,
    confirmedAt: row.confirmed_at ?? new Date().toISOString(),
    sync: {
      updatedAt: row.confirmed_at ?? new Date().toISOString(),
      version: Number(row.row_version ?? 1),
      deleted: false,
      deviceId,
      workspaceId,
    },
  };
}

/** Der Server ist die Wahrheit — die lokale Liste wird ersetzt, nicht gemischt. */
export function mergeBankReconciliationsFromPull(
  remoteRows: WorkspaceBankReconciliationRow[],
  deviceId: string,
  workspaceId: string,
): import('../../types/bankReconciliation').BankReconciliation[] {
  return remoteRows
    .map((row) => bankReconciliationFromCloud(row, deviceId, workspaceId))
    .filter((eintrag): eintrag is import('../../types/bankReconciliation').BankReconciliation =>
      eintrag !== null,
    );
}
