/**
 * BANKABGLEICH-V1 BLOCK 2B — die Konten, unter denen Auszüge aufbewahrt werden.
 *
 * Dasselbe Speichermuster wie `bankTransactionStore`. Keine Kontoverwaltung:
 * Ein Konto entsteht beiläufig beim ersten Import und trägt einen Namen und
 * eine optionale Kennung aus der Datei — mehr braucht die Entdopplung nicht.
 *
 * Bewusst **keine Wiederverwendung des Firmenprofils**: Dort steht die
 * Bankverbindung, mit der der Betrieb seine Rechnungen auszeichnet. Das ist
 * eine Angabe für Kunden, kein Verzeichnis der Konten, deren Auszüge
 * eingelesen werden — und ein Betrieb liest Auszüge von Konten ein, die er auf
 * keiner Rechnung nennt. Zwei verschiedene Dinge, zwei Wahrheiten.
 */
import { generateEntityId } from '../sync/syncMetaService';
import { persistAll } from '../persistenceService';
import type { BankAccount } from '../../types/bankAccount';

let accounts: BankAccount[] = [];

function clone(konto: BankAccount): BankAccount {
  return { ...konto };
}

/**
 * Vergleichsform einer Kontokennung aus der Datei.
 *
 * Leerzeichen und Kleinschreibung sind kein Unterschied: `DE89 3704 0044` und
 * `de8937040044` sind dasselbe Konto.
 */
export function normalizeAccountIdentifier(wert: string | null | undefined): string {
  return (wert ?? '').replace(/\s+/g, '').toUpperCase();
}

export function hydrateBankAccounts(eintraege: BankAccount[]): void {
  accounts = (eintraege ?? []).map(clone);
}

export function getBankAccountStoreSnapshot(): BankAccount[] {
  return accounts.map(clone);
}

export function listBankAccounts(): BankAccount[] {
  return accounts.map(clone).sort((a, b) => a.displayName.localeCompare(b.displayName, 'de'));
}

export function getBankAccountById(id: string): BankAccount | null {
  return accounts.find((konto) => konto.id === id) ? clone(accounts.find((konto) => konto.id === id)!) : null;
}

export function findBankAccountByIdentifier(identifier: string): BankAccount | null {
  const gesucht = normalizeAccountIdentifier(identifier);
  if (!gesucht) return null;
  const treffer = accounts.find((konto) => konto.identifier === gesucht);
  return treffer ? clone(treffer) : null;
}

/** Nur fuer Tests. */
export function resetBankAccountsForTests(): void {
  accounts = [];
}

/**
 * Ein Konto anlegen.
 *
 * `identifier` ist optional: Liefert die Datei keine Kontokennung, hat das
 * Konto nur einen Namen — und trotzdem eine stabile Kennung, weil die aus
 * `id` kommt und nicht aus dem Namen.
 */
export function createBankAccount(displayName: string, identifier = ''): BankAccount {
  const name = displayName.trim();
  if (!name) throw new Error('bankAccount.nameRequired');

  const konto: BankAccount = {
    id: generateEntityId('bacc'),
    displayName: name,
    identifier: normalizeAccountIdentifier(identifier),
    createdAt: new Date().toISOString(),
  };
  accounts.push(konto);
  persistAll();
  return clone(konto);
}

/**
 * Das Konto zu einer Kontokennung aus der Datei — vorhandenes oder neues.
 *
 * Der erzeugte Name nennt die Kennung, damit der Nutzer das Konto in einer
 * Liste wiedererkennt. Er darf ihn anschliessend frei ändern; die Zuordnung
 * bereits aufbewahrter Bewegungen bleibt davon unberührt.
 */
export function ensureBankAccountForIdentifier(identifier: string, vorschlag?: string): BankAccount {
  const normalisiert = normalizeAccountIdentifier(identifier);
  const vorhanden = findBankAccountByIdentifier(normalisiert);
  if (vorhanden) return vorhanden;
  return createBankAccount(vorschlag?.trim() || kontoNameAusKennung(normalisiert), normalisiert);
}

/**
 * Ein lesbarer Name aus einer Kontokennung.
 *
 * Gezeigt werden nur die letzten vier Stellen. Eine vollständige IBAN gehört
 * nicht in eine Übersichtsliste: Sie ist für den Wiedererkennungszweck
 * unnötig und steht sonst in jedem Screenshot.
 */
export function kontoNameAusKennung(identifier: string): string {
  const normalisiert = normalizeAccountIdentifier(identifier);
  if (!normalisiert) return 'Konto';
  const endung = normalisiert.slice(-4);
  return `Konto …${endung}`;
}

/** Den Anzeigenamen ändern — die Kennung bleibt, und damit die Entdopplung. */
export function renameBankAccount(id: string, displayName: string): BankAccount | null {
  const name = displayName.trim();
  if (!name) return null;
  const index = accounts.findIndex((konto) => konto.id === id);
  if (index === -1) return null;
  accounts[index] = { ...accounts[index]!, displayName: name };
  persistAll();
  return clone(accounts[index]!);
}
