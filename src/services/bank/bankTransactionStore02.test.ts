/**
 * BANKABGLEICH-V1 BLOCK 2 — Bankbewegungen aufbewahren, Dubletten verhindern.
 *
 * Der Kern dieses Blocks ist eine einzige Frage: Wann ist eine Bewegung
 * dieselbe wie eine bereits gespeicherte? Die Tests pruefen beide Richtungen
 * dieser Frage — es darf nichts doppelt entstehen, und es darf nichts
 * verschluckt werden.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFingerprint,
  commitBankImport,
  getBankTransactionStoreSnapshot,
  hydrateBankTransactions,
  listBankTransactions,
  planBankImport,
  resetBankTransactionsForTests,
} from './bankTransactionStore';
import { parseBankStatementCsv } from './bankStatementCsvService';
import { getActiveStorageKey, setActiveStorageScope } from '../storage/storageScopeService';
 import {
  createBankAccount,
  ensureBankAccountForIdentifier,
  resetBankAccountsForTests,
} from './bankAccountStore';
import { hydrateExpenseStore, getExpenseStoreSnapshot } from '../expenseStore';
import type { BankStatementPreview } from '../../types/bankStatement';
import type { Expense } from '../../types/expense';

const KOPF = 'Auftragskonto;Buchungstag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;Betrag';

function vorschau(...zeilen: string[]): BankStatementPreview {
  const ergebnis = parseBankStatementCsv([KOPF, ...zeilen].join('\n'), 'auszug.csv');
  if (!ergebnis.ok) throw new Error(`nicht lesbar: ${ergebnis.problem}`);
  return ergebnis.preview;
}

/** Eine Datei ohne Auftragskonto-Spalte — der haeufige Fall. */
function vorschauOhneKonto(name: string, ...zeilen: string[]): BankStatementPreview {
  const ergebnis = parseBankStatementCsv(
    ['Buchungstag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;Betrag', ...zeilen].join('\n'),
    name,
  );
  if (!ergebnis.ok) throw new Error(`nicht lesbar: ${ergebnis.problem}`);
  return ergebnis.preview;
}

/**
 * Das Konto eines Auszugs so bestimmen, wie die Oberflaeche es tut.
 *
 * Nennt die Datei ein Konto, wird es automatisch zugeordnet; sonst steht
 * das vom Nutzer gewaehlte Konto bereit. Dadurch pruefen die Block-2-Faelle
 * weiterhin genau ihre urspruengliche Aussage.
 */
function kontoFuer(preview: BankStatementPreview): string {
  if (preview.accountKey) return ensureBankAccountForIdentifier(preview.accountKey).id;
  gewaehltesKonto ??= createBankAccount('Geschäftskonto').id;
  return gewaehltesKonto;
}

let gewaehltesKonto: string | null = null;

const uebernimm = (preview: BankStatementPreview) => commitBankImport(preview, kontoFuer(preview));
const plane = (preview: BankStatementPreview) => planBankImport(preview, kontoFuer(preview));

describe('BANKABGLEICH-02 Aufbewahren und Entdoppeln', () => {
  beforeEach(() => {
    localStorage.clear();
    resetBankTransactionsForTests();
    resetBankAccountsForTests();
    gewaehltesKonto = null;
  });

  /* ---- A) Persistenz ---- */

  it('A1 — eine uebernommene Bewegung wird aufbewahrt', () => {
    const outcome = uebernimm(vorschau('DE01;04.10.2026;Kunde Nord;Zahlung;500,00'));
    expect(outcome.added).toBe(1);
    expect(listBankTransactions()).toHaveLength(1);
    expect(listBankTransactions()[0]).toMatchObject({
      bookingDate: '2026-10-04',
      amountCents: 50000,
      counterparty: 'Kunde Nord',
      accountKey: ensureBankAccountForIdentifier('DE01').id,
      occurrence: 1,
    });
  });

  it('A2 — mehrere Bewegungen, neueste Buchung zuerst', () => {
    uebernimm(
      vorschau(
        'DE01;01.10.2026;A;Zweck;100,00',
        'DE01;05.10.2026;B;Zweck;200,00',
        'DE01;03.10.2026;C;Zweck;300,00',
      ),
    );
    expect(listBankTransactions().map((t) => t.bookingDate)).toEqual([
      '2026-10-05',
      '2026-10-03',
      '2026-10-01',
    ]);
  });

  it('A3 — der Bestand ueberlebt das Neuladen des Zustands', () => {
    uebernimm(vorschau('DE01;04.10.2026;Kunde Nord;Zahlung;500,00'));
    const schnappschuss = getBankTransactionStoreSnapshot();

    /* Wie nach einem Reload: Speicher leer, dann aus dem Zustand befuellt. */
    resetBankTransactionsForTests();
    expect(listBankTransactions()).toHaveLength(0);
    hydrateBankTransactions(schnappschuss);
    expect(listBankTransactions()).toHaveLength(1);
  });

  it('A4 — der Schnappschuss ist eine Kopie, kein Griff in den Speicher', () => {
    uebernimm(vorschau('DE01;04.10.2026;Kunde Nord;Zahlung;500,00'));
    const schnappschuss = getBankTransactionStoreSnapshot();
    schnappschuss[0]!.amountCents = 1;
    expect(listBankTransactions()[0]?.amountCents).toBe(50000);
  });

  it('A5 — zwei Betriebe teilen keinen Bestand', () => {
    /*
     * Die Trennung entsteht nicht im Bankdienst, sondern im Speicherschluessel:
     * Der gesamte Zustand liegt je Betrieb unter einem eigenen Schluessel.
     * Geprueft wird deshalb genau das — was unter Betrieb A gespeichert wird,
     * steht unter Betrieb B nicht.
     */
    setActiveStorageScope({ type: 'workspace', workspaceId: 'ws-a' });
    uebernimm(vorschau('DE01;04.10.2026;Kunde A;Zahlung;500,00'));
    const schluesselA = getActiveStorageKey();
    const standA = getBankTransactionStoreSnapshot();

    setActiveStorageScope({ type: 'workspace', workspaceId: 'ws-b' });
    const schluesselB = getActiveStorageKey();
    expect(schluesselB).not.toBe(schluesselA);
    /* Ein anderer Betrieb startet mit dem, was unter seinem Schluessel steht. */
    hydrateBankTransactions([]);
    expect(listBankTransactions()).toHaveLength(0);

    setActiveStorageScope({ type: 'workspace', workspaceId: 'ws-a' });
    hydrateBankTransactions(standA);
    expect(listBankTransactions()).toHaveLength(1);

    setActiveStorageScope({ type: 'guest' });
  });

  /* ---- B) Dubletten ---- */

  it('B1 — dieselbe Datei zweimal legt nichts doppelt an', () => {
    const datei = () => vorschau('DE01;04.10.2026;Kunde Nord;Zahlung;500,00', 'DE01;05.10.2026;B;Zweck;-80,00');

    const erster = uebernimm(datei());
    expect(erster).toMatchObject({ added: 2, alreadyPresent: 0 });

    const zweiter = uebernimm(datei());
    expect(zweiter).toMatchObject({ added: 0, alreadyPresent: 2 });
    expect(listBankTransactions()).toHaveLength(2);
  });

  it('B2 — ueberlappende Exporte: nur der neue Teil kommt hinzu', () => {
    /* Datei 1 deckt den 01.–15. ab. */
    uebernimm(
      vorschau(
        'DE01;01.10.2026;A;Zweck A;100,00',
        'DE01;10.10.2026;B;Zweck B;200,00',
        'DE01;15.10.2026;C;Zweck C;300,00',
      ),
    );

    /* Datei 2 deckt den 10.–31. ab — drei Zeilen ueberschneiden sich. */
    const zweiter = uebernimm(
      vorschau(
        'DE01;10.10.2026;B;Zweck B;200,00',
        'DE01;15.10.2026;C;Zweck C;300,00',
        'DE01;20.10.2026;D;Zweck D;400,00',
        'DE01;31.10.2026;E;Zweck E;-500,00',
      ),
    );

    expect(zweiter).toMatchObject({ added: 2, alreadyPresent: 2 });
    expect(listBankTransactions()).toHaveLength(5);
  });

  it('B3 — zwei echte identische Buchungen bleiben beide erhalten', () => {
    const outcome = uebernimm(
      vorschau('DE01;04.10.2026;Vermieter;Miete;-800,00', 'DE01;04.10.2026;Vermieter;Miete;-800,00'),
    );
    expect(outcome.added).toBe(2);
    expect(listBankTransactions().map((t) => t.occurrence).sort()).toEqual([1, 2]);
  });

  it('B4 — dieselben zwei identischen Buchungen beim zweiten Import erzeugen keine dritte', () => {
    const datei = () =>
      vorschau('DE01;04.10.2026;Vermieter;Miete;-800,00', 'DE01;04.10.2026;Vermieter;Miete;-800,00');

    uebernimm(datei());
    const zweiter = uebernimm(datei());

    expect(zweiter).toMatchObject({ added: 0, alreadyPresent: 2 });
    expect(listBankTransactions()).toHaveLength(2);
  });

  it('B5 — kommt eine dritte echte gleiche Buchung hinzu, wird sie aufbewahrt', () => {
    uebernimm(
      vorschau('DE01;04.10.2026;Vermieter;Miete;-800,00', 'DE01;04.10.2026;Vermieter;Miete;-800,00'),
    );
    const dritter = uebernimm(
      vorschau(
        'DE01;04.10.2026;Vermieter;Miete;-800,00',
        'DE01;04.10.2026;Vermieter;Miete;-800,00',
        'DE01;04.10.2026;Vermieter;Miete;-800,00',
      ),
    );
    expect(dritter).toMatchObject({ added: 1, alreadyPresent: 2 });
    expect(listBankTransactions()).toHaveLength(3);
  });

  it('B6 — eine Bankreferenz unterscheidet, verschmilzt aber nichts', () => {
    const mitReferenz = parseBankStatementCsv(
      [
        'Auftragskonto;Buchungstag;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;Betrag;Kundenreferenz',
        'DE01;04.10.2026;Vermieter;Miete;-800,00;REF-1',
        'DE01;04.10.2026;Vermieter;Miete;-800,00;REF-2',
      ].join('\n'),
      'mit-referenz.csv',
    );
    if (!mitReferenz.ok) throw new Error('nicht lesbar');

    const outcome = uebernimm(mitReferenz.preview);
    expect(outcome.added).toBe(2);
    /* Unterschiedliche Referenz heisst: unterschiedlicher Abdruck, beide occurrence 1. */
    expect(listBankTransactions().every((t) => t.occurrence === 1)).toBe(true);
    expect(new Set(listBankTransactions().map((t) => t.fingerprint)).size).toBe(2);
  });

  it('B7 — fehlt die Bankreferenz, traegt der Abdruck trotzdem', () => {
    const abdruck = buildFingerprint('DE01', {
      bookingDate: '2026-10-04',
      amountCents: -80000,
      counterparty: 'Vermieter',
      purpose: 'Miete',
    });
    expect(abdruck).toContain('2026-10-04');
    expect(abdruck).toContain('-80000');
    /* Gross-/Kleinschreibung und Leerraum sind kein Unterschied. */
    expect(
      buildFingerprint('DE01', {
        bookingDate: '2026-10-04',
        amountCents: -80000,
        counterparty: '  VERMIETER ',
        purpose: 'Miete',
      }),
    ).toBe(abdruck);
  });

  /* ---- C) Konten ---- */

  it('C1 — dieselbe Bewegung auf zwei Konten ist nicht dieselbe Bewegung', () => {
    uebernimm(vorschau('DE01;04.10.2026;Vermieter;Miete;-800,00'));
    const zweitesKonto = uebernimm(vorschau('DE02;04.10.2026;Vermieter;Miete;-800,00'));

    expect(zweitesKonto).toMatchObject({ added: 1, alreadyPresent: 0 });
    expect(listBankTransactions()).toHaveLength(2);
    /* Zwei verschiedene stabile Kontokennungen — nicht die IBAN aus der Datei. */
    expect(new Set(listBankTransactions().map((t) => t.accountKey)).size).toBe(2);
    expect(new Set(listBankTransactions().map((t) => t.accountKey))).toEqual(
      new Set([ensureBankAccountForIdentifier('DE01').id, ensureBankAccountForIdentifier('DE02').id]),
    );
  });

  it('C2 — ohne Auftragskonto-Spalte bleibt der Kontoschluessel leer und bleibt stabil', () => {
    const preview = vorschauOhneKonto('ohne-konto.csv', '04.10.2026;Vermieter;Miete;-800,00');
    expect(preview.accountKey).toBe('');
    uebernimm(preview);
    const zweiter = uebernimm(vorschauOhneKonto('ohne-konto.csv', '04.10.2026;Vermieter;Miete;-800,00'));
    expect(zweiter).toMatchObject({ added: 0, alreadyPresent: 1 });
  });

  /* ---- D) Problemzeilen ---- */

  it('D1 — problematische Zeilen werden nicht aufbewahrt', () => {
    const preview = vorschau(
      'DE01;04.10.2026;Kunde Nord;Zahlung;500,00',
      'DE01;kaputt;Firma;Zweck;100,00',
      'DE01;05.10.2026;Firma;Betrag kaputt;keine Ahnung',
    );
    expect(preview.issues).toHaveLength(2);

    const outcome = uebernimm(preview);
    expect(outcome).toMatchObject({ added: 1, skippedProblemRows: 2 });
    expect(listBankTransactions()).toHaveLength(1);
  });

  /* ---- E) Confirm-first ---- */

  it('E1 — die Planung allein speichert nichts', () => {
    const preview = vorschau('DE01;04.10.2026;Kunde Nord;Zahlung;500,00');
    const plan = plane(preview);

    expect(plan.neu).toHaveLength(1);
    expect(plan.vorhanden).toHaveLength(0);
    /* Entscheidend: Der Bestand ist nach der Planung unveraendert leer. */
    expect(listBankTransactions()).toHaveLength(0);
  });

  it('E2 — der Plan nennt vorhandene und neue Zeilen getrennt', () => {
    uebernimm(vorschau('DE01;04.10.2026;Kunde Nord;Zahlung;500,00'));

    const plan = plane(
      vorschau('DE01;04.10.2026;Kunde Nord;Zahlung;500,00', 'DE01;05.10.2026;Neu;Zweck;-20,00'),
    );
    expect(plan.vorhanden).toHaveLength(1);
    expect(plan.neu).toHaveLength(1);
    expect(plan.neu[0]?.counterparty).toBe('Neu');
  });

  it('E3 — erst die Uebernahme schreibt', () => {
    const preview = vorschau('DE01;04.10.2026;Kunde Nord;Zahlung;500,00');
    plane(preview);
    plane(preview);
    expect(listBankTransactions()).toHaveLength(0);

    uebernimm(preview);
    expect(listBankTransactions()).toHaveLength(1);
  });

  /* ---- F) Keine Zahlungswirkung ---- */

  it('F1 — ein Import ruft keine Zahlungsfunktion auf', async () => {
    const invoicePayments = await import('../invoicePaymentService');
    const expensePayments = await import('../expensePaymentService');
    const recordPayment = vi.spyOn(invoicePayments, 'recordPayment');
    const recordExpensePayment = vi.spyOn(expensePayments, 'recordExpensePayment');

    uebernimm(vorschau('DE01;04.10.2026;Kunde Nord;Zahlung RE-1;500,00'));

    expect(recordPayment).not.toHaveBeenCalled();
    expect(recordExpensePayment).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('F2 — der Zahlungsstatus einer Ausgabe bleibt unberuehrt', () => {
    const ausgabe: Expense = {
      id: 'exp-bank-1',
      status: 'gebucht',
      category: 'material',
      supplierName: 'Baustoff Handel GmbH',
      invoiceNumber: 'RE-55123',
      title: 'Materiallieferung',
      description: '',
      issueDate: '2026-10-01',
      paymentDueDate: '2026-10-15',
      taxStatus: 'standard_19',
      netAmount: 1000,
      taxAmount: 190,
      grossAmount: 1190.5,
      currency: 'EUR',
      paymentStatus: 'offen',
      payments: [],
      positions: [],
      allocations: [],
      isCreditNote: false,
      dedupeKey: 'baustoff handel gmbh|re-55123',
      tags: [],
      digitalFolder: { id: 'd', name: 'Ausgaben', path: '/Ausgaben/' },
      paperFolder: { folderId: 'f', register: 'A', label: 'T' },
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
    };
    hydrateExpenseStore([ausgabe]);

    /* Eine Bewegung, die exakt zu dieser Ausgabe passt — und trotzdem nichts bewirkt. */
    uebernimm(vorschau('DE01;05.10.2026;Baustoff Handel GmbH;Rechnung RE-55123;-1.190,50'));

    const danach = getExpenseStoreSnapshot()[0];
    expect(danach?.paymentStatus).toBe('offen');
    expect(danach?.payments ?? []).toHaveLength(0);
  });

  it('F3 — eine aufbewahrte Bewegung kennt weder Rechnung noch Zahlung', () => {
    uebernimm(vorschau('DE01;04.10.2026;Kunde Nord;Zahlung RE-1;500,00'));
    const eintrag = listBankTransactions()[0] as unknown as Record<string, unknown>;
    for (const feld of ['invoiceId', 'expenseId', 'paymentId', 'matchStatus', 'confidence', 'paymentStatus']) {
      expect(eintrag).not.toHaveProperty(feld);
    }
  });
});
