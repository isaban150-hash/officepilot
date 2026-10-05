/**
 * BANKABGLEICH-V1 BLOCK 2 — Bankbewegungen dauerhaft aufbewahren.
 *
 * Bewusst dasselbe schlichte Speichermuster wie `orderDraftService`: ein
 * Modulspeicher, `hydrate`/`snapshot` am `PersistedState` und `persistAll`.
 * Keine Sonderarchitektur fuer Bankdaten. Die Trennung nach Betrieb entsteht
 * dadurch von selbst, weil der gesamte Zustand unter einem
 * workspace-bezogenen Speicherschluessel liegt (`storageScopeService`).
 *
 * **Keine Zahlungswirkung.** Dieser Dienst ruft keine Zahlungsfunktion auf,
 * aendert keinen Rechnungs- oder Ausgabenstatus und kennt weder Rechnung noch
 * Ausgabe. Er bewahrt nur auf, was die Bank gemeldet hat.
 */
import { generateEntityId } from '../sync/syncMetaService';
import { persistAll } from '../persistenceService';
import type { BankStatementPreview, BankStatementRow } from '../../types/bankStatement';
import type { BankImportOutcome, BankTransaction } from '../../types/bankTransaction';

let transactions: BankTransaction[] = [];

function clone(eintrag: BankTransaction): BankTransaction {
  return { ...eintrag };
}

/** Vergleichsform eines Textfelds: Gross-/Kleinschreibung und Leerraum sind kein Unterschied. */
function leise(wert: string | undefined): string {
  return (wert ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Der fachliche Fingerabdruck einer Bankbewegung.
 *
 * Enthalten ist alles, was dieselbe Bewegung in zwei Exporten gleich
 * beschreibt — und das Konto, damit eine identische Buchung auf einem
 * **zweiten** Konto nicht faelschlich als dieselbe gilt.
 *
 * BLOCK 2B: Das Konto geht als **stabile Kontokennung** (`BankAccount.id`)
 * ein, nicht als Anzeigename und nicht als IBAN aus der Datei. Ein Umbenennen
 * des Kontos laesst die Entdopplung dadurch unberuehrt, und eine Datei ohne
 * Kontospalte kann trotzdem eindeutig zugeordnet werden.
 *
 * Die Bankreferenz geht als **zusaetzliches Unterscheidungsmerkmal** ein,
 * nicht als alleiniger Schluessel. Der Unterschied ist wichtig: Ob eine
 * Referenzspalte wirklich weltweit eindeutig ist, weiss niemand — manche
 * Banken schreiben dort eine Mandatsreferenz, die sich bei jeder Lastschrift
 * desselben Vertrags wiederholt. Als alleiniger Schluessel wuerde sie dann
 * verschiedene Bewegungen verschmelzen und echtes Geld verschlucken. Als
 * Bestandteil kann sie den Abdruck nur **genauer** machen, nie gröber.
 */
export function buildFingerprint(
  accountId: string,
  row: Pick<BankStatementRow, 'bookingDate' | 'amountCents' | 'counterparty' | 'purpose' | 'bankReference'>,
): string {
  return [
    accountId,
    row.bookingDate,
    String(row.amountCents),
    leise(row.counterparty),
    leise(row.purpose),
    leise(row.bankReference),
  ].join('|');
}

/* -------------------------------------------------------------------------- */
/* Speicher                                                                    */
/* -------------------------------------------------------------------------- */

export function hydrateBankTransactions(eintraege: BankTransaction[]): void {
  transactions = (eintraege ?? []).map(clone);
}

export function getBankTransactionStoreSnapshot(): BankTransaction[] {
  return transactions.map(clone);
}

/** Alle gespeicherten Bewegungen, neueste Buchung zuerst. */
export function listBankTransactions(): BankTransaction[] {
  return transactions
    .map(clone)
    .sort((a, b) =>
      a.bookingDate === b.bookingDate
        ? b.importedAt.localeCompare(a.importedAt)
        : b.bookingDate.localeCompare(a.bookingDate),
    );
}

/** Nur fuer Tests: den Speicher gezielt leeren. */
export function resetBankTransactionsForTests(): void {
  transactions = [];
}

/* -------------------------------------------------------------------------- */
/* Vorschau gegen Bestand halten                                               */
/* -------------------------------------------------------------------------- */

/**
 * Wie oft jeder Fingerabdruck bereits gespeichert ist.
 *
 * Diese Zaehlung ist der Kern der Idempotenz: Nicht „gibt es die Bewegung
 * schon?", sondern „wie viele davon gibt es schon?". Nur so bleiben zwei
 * echte gleiche Abbuchungen beide erhalten und werden beim zweiten Import
 * trotzdem beide als vorhanden erkannt.
 */
function bestandJeFingerabdruck(): Map<string, number> {
  const zaehler = new Map<string, number>();
  for (const eintrag of transactions) {
    zaehler.set(eintrag.fingerprint, (zaehler.get(eintrag.fingerprint) ?? 0) + 1);
  }
  return zaehler;
}

export interface BankImportPlan {
  /** Zeilen, die beim Uebernehmen wirklich neu entstehen. */
  neu: BankStatementRow[];
  /** Zeilen, die der Bestand bereits enthaelt. */
  vorhanden: BankStatementRow[];
  /** Zeilen, die gar nicht erst angeboten werden, weil sie nicht lesbar waren. */
  problemZeilen: number;
}

/**
 * Was ein Import bewirken wuerde — **ohne** etwas zu speichern.
 *
 * Diese Trennung ist der Confirm-first-Vertrag: Die Oberflaeche zeigt den
 * Plan, der Nutzer entscheidet, und erst `commitBankImport` schreibt.
 */
export function planBankImport(preview: BankStatementPreview, accountId: string): BankImportPlan {
  const verbleibend = bestandJeFingerabdruck();
  const neu: BankStatementRow[] = [];
  const vorhanden: BankStatementRow[] = [];

  for (const row of preview.rows) {
    const abdruck = buildFingerprint(accountId, row);
    const offen = verbleibend.get(abdruck) ?? 0;
    if (offen > 0) {
      /* Eine gespeicherte Bewegung deckt genau eine Zeile dieser Datei ab. */
      verbleibend.set(abdruck, offen - 1);
      vorhanden.push(row);
    } else {
      neu.push(row);
    }
  }

  return { neu, vorhanden, problemZeilen: preview.issues.length };
}

/**
 * Den geplanten Import ausfuehren.
 *
 * Problematische Zeilen werden nicht gespeichert — sie waren nie Teil des
 * Plans. Was bereits vorhanden ist, wird uebergangen statt ueberschrieben:
 * Der Bestand ist der Nachweis, und ein Nachweis wird nicht neu geschrieben,
 * nur weil dieselbe Datei noch einmal kommt.
 */
export function commitBankImport(preview: BankStatementPreview, accountId: string): BankImportOutcome {
  /*
   * BLOCK 2B — ohne Konto wird nicht gespeichert. Das ist kein Formfehler,
   * sondern der Schutz davor, dass zwei Konten zu einem verschmelzen.
   */
  if (!accountId) throw new Error('bankImport.accountRequired');
  const plan = planBankImport(preview, accountId);
  const importId = generateEntityId('bimp');
  const importedAt = new Date().toISOString();

  /* Die laufende Nummer zaehlt ueber Bestand **und** die gerade angelegten weiter. */
  const belegt = bestandJeFingerabdruck();

  for (const row of plan.neu) {
    const fingerprint = buildFingerprint(accountId, row);
    const occurrence = (belegt.get(fingerprint) ?? 0) + 1;
    belegt.set(fingerprint, occurrence);

    transactions.push({
      id: generateEntityId('btx'),
      accountKey: accountId,
      importId,
      fileName: preview.fileName,
      importedAt,
      bookingDate: row.bookingDate,
      ...(row.valueDate ? { valueDate: row.valueDate } : {}),
      amountCents: row.amountCents,
      ...(row.currency ? { currency: row.currency } : {}),
      ...(row.counterparty ? { counterparty: row.counterparty } : {}),
      ...(row.counterpartyIban ? { counterpartyIban: row.counterpartyIban } : {}),
      ...(row.purpose ? { purpose: row.purpose } : {}),
      ...(row.bankReference ? { bankReference: row.bankReference } : {}),
      fingerprint,
      occurrence,
    });
  }

  if (plan.neu.length > 0) persistAll();

  return {
    importId,
    fileName: preview.fileName,
    added: plan.neu.length,
    alreadyPresent: plan.vorhanden.length,
    skippedProblemRows: plan.problemZeilen,
  };
}
