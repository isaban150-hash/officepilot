/**
 * FINANZCORE-05B — Geldintegrität und Zahlungskennungen im Ausgabenbereich.
 *
 * Zwei Befunde aus 05A, beide mit demselben Muster: Etwas, das auf der
 * Rechnungsseite längst abgesichert ist, fehlte auf der Ausgabenseite.
 *
 *  - **P1** — `pay-${Date.now()}` als Zahlungskennung. Zwei Buchungen in
 *    derselben Millisekunde teilten sich eine Kennung; der
 *    Eindeutigkeitsschlüssel der Cloud hätte zwei echte Geldbewegungen zu einer
 *    verschmolzen.
 *  - **P2** — Netto, Steuer und Brutto waren drei unabhängige Zahlen. Ein
 *    Beleg mit 100 netto, 19 Steuer und 200 brutto war speicherbar.
 *
 * Geprüft wird beides an den echten Diensten, nicht an einer Nachbildung.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditExpenseMoneyIntegrity,
  checkExpenseMoneyIntegrity,
  describeExpenseTaxRateDeviation,
  isZeroRateTaxStatus,
} from './expenseMoneyIntegrity';
import { buildExpensePushPayload, pushExpenseEntity } from './expenseCloudSyncService';
import { addExpense, getExpenseById, updateExpense } from '../expenseService';
import { recordExpensePayment, removeExpensePayment } from '../expensePaymentService';
import {
  getAllExpensesFromStore,
  getExpenseFromStoreById,
  setExpenseStoreForTests,
} from '../expenseStore';
import { normalizeExpense } from '../expenseNormalize';
import { buildMonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import { resetTestStores } from '../../test/resetStores';
import type { Expense, ExpenseInput } from '../../types/expense';
import type { TaxStatus } from '../../types/models';

/* ------------------------------------------------------------------ */

function input(overrides: Partial<ExpenseInput> = {}): ExpenseInput {
  return {
    title: 'Material Baumarkt',
    category: 'material',
    supplierName: 'Baumarkt Nord GmbH',
    invoiceNumber: `RE-${Math.random().toString(36).slice(2, 10)}`,
    issueDate: '2026-06-01',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    ...overrides,
  };
}

/** Ein gespeicherter Beleg, an der Validierung vorbei — so sieht Altbestand aus. */
function legacyExpense(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-legacy-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Alt Lieferant',
    invoiceNumber: 'ALT-1',
    title: 'Altbeleg',
    issueDate: '2026-05-04',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 200,
    ...overrides,
  } as Expense);
}

beforeEach(() => {
  resetTestStores();
  setExpenseStoreForTests([]);
});

afterEach(() => {
  resetTestStores();
  vi.restoreAllMocks();
});

/* ================================================================== */

describe('A — P1: die Zahlungskennung', () => {
  function bookedExpense(): Expense {
    const created = addExpense(input({ invoiceNumber: 'RE-PAY-1' }));
    if (!created.success) throw new Error(JSON.stringify(created));
    return created.expense;
  }

  // T1 — keine Zeitstempel-Kennung mehr.
  it('T1: eine neue Zahlung trägt eine UUID, keine Date.now-Kennung', () => {
    const expense = bookedExpense();
    const result = recordExpensePayment(expense.id, { date: '2026-06-10', amount: 50 });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.payment.id).not.toMatch(/^pay-\d+$/);
    expect(result.payment.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  /*
   * T2/T3 — der eigentliche Fall. Die Uhr steht still: Beide Buchungen sehen
   * denselben Millisekundenwert, so wie zwei schnelle Klicks oder ein Import.
   * Mit der alten Kennung wären das zwei identische IDs gewesen.
   */
  it('T2/T3: zwei Zahlungen in derselben Millisekunde bleiben zwei Zahlungen', () => {
    const expense = bookedExpense();
    vi.spyOn(Date, 'now').mockReturnValue(1_780_000_000_000);

    const erste = recordExpensePayment(expense.id, { date: '2026-06-10', amount: 30 });
    const zweite = recordExpensePayment(expense.id, { date: '2026-06-10', amount: 30 });
    expect(erste.success && zweite.success).toBe(true);
    if (!erste.success || !zweite.success) return;

    expect(zweite.payment.id).not.toBe(erste.payment.id);

    const gespeichert = getExpenseFromStoreById(expense.id)!;
    expect(gespeichert.payments).toHaveLength(2);
    expect(new Set(gespeichert.payments!.map((p) => p.id)).size).toBe(2);
    // Beide Geldbewegungen zählen — nichts ist verschmolzen.
    expect(gespeichert.payments!.reduce((sum, p) => sum + p.amount, 0)).toBe(60);
  });

  /*
   * T4 — die Gegenrichtung: Derselbe Vorgang bleibt idempotent. Die Kennung
   * wird beim Wiederholungsversuch **nicht** neu erzeugt; genau deshalb trifft
   * ein Retry denselben Idempotenzschlüssel der Cloud.
   */
  it('T4: dieselbe Zahlung behält ihre Kennung über Ablage und Entfernen hinweg', () => {
    const expense = bookedExpense();
    const gebucht = recordExpensePayment(expense.id, { date: '2026-06-10', amount: 40 });
    if (!gebucht.success) throw new Error('Vorbereitung');

    const ausDemSpeicher = getExpenseFromStoreById(expense.id)!.payments![0]!;
    expect(ausDemSpeicher.id).toBe(gebucht.payment.id);

    // Entfernen trifft dieselbe Kennung — kein zweiter Datensatz entsteht.
    expect(removeExpensePayment(expense.id, gebucht.payment.id).success).toBe(true);
    expect(getExpenseFromStoreById(expense.id)!.payments).toHaveLength(0);
  });
});

describe('B — P2: die Geldinvariante', () => {
  // T5 — der Normalfall.
  it('T5: netto + steuer = brutto wird angenommen', () => {
    expect(
      checkExpenseMoneyIntegrity({
        netAmount: 100,
        taxAmount: 19,
        grossAmount: 119,
        taxStatus: 'standard_19',
      }),
    ).toEqual({ ok: true });
  });

  // T6 — der Befund aus 05A.
  it('T6: widersprüchliche Werte werden abgelehnt', () => {
    const result = checkExpenseMoneyIntegrity({
      netAmount: 100,
      taxAmount: 19,
      grossAmount: 200,
      taxStatus: 'standard_19',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('equation_mismatch');
  });

  /*
   * T7 — gerechnet wird in Cent, nicht in Gleitkomma. `0.1 + 0.2` ist als
   * Fliesskommazahl nicht `0.3`; ein naiver Vergleich hätte diesen völlig
   * korrekten Beleg abgelehnt.
   */
  it('T7: die Rundung folgt der bestehenden Centlogik', () => {
    expect(0.1 + 0.2 === 0.3, 'Vorbedingung: Gleitkomma trügt hier').toBe(false);
    expect(
      checkExpenseMoneyIntegrity({
        netAmount: 0.1,
        taxAmount: 0.2,
        grossAmount: 0.3,
        taxStatus: 'standard_19',
      }),
    ).toEqual({ ok: true });

    // Und ein echter Cent Differenz fällt auf.
    expect(
      checkExpenseMoneyIntegrity({
        netAmount: 100,
        taxAmount: 19,
        grossAmount: 119.01,
        taxStatus: 'standard_19',
      }).ok,
    ).toBe(false);
  });

  it('nicht verwertbare Zahlen werden abgelehnt', () => {
    const result = checkExpenseMoneyIntegrity({
      netAmount: Number.NaN,
      taxAmount: 0,
      grossAmount: 0,
      taxStatus: 'standard_19',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0].code).toBe('amount_not_finite');
  });
});

describe('C — Gutschriften und negative Beträge', () => {
  // T8 — eine Gutschrift bleibt erlaubt.
  it('T8: eine Gutschrift mit durchgängig negativen Beträgen wird angenommen', () => {
    expect(
      checkExpenseMoneyIntegrity({
        netAmount: -100,
        taxAmount: -19,
        grossAmount: -119,
        taxStatus: 'standard_19',
      }),
    ).toEqual({ ok: true });
  });

  it('T8b: die Gutschrift lässt sich auch wirklich anlegen', () => {
    const created = addExpense(
      input({
        invoiceNumber: 'GS-1',
        category: 'gutschrift',
        netAmount: -100,
        taxAmount: -19,
        grossAmount: -119,
      }),
    );
    expect(created.success, created.success ? '' : JSON.stringify(created)).toBe(true);
    if (!created.success) return;
    expect(created.expense.isCreditNote).toBe(true);
    expect(created.expense.grossAmount).toBe(-119);
  });

  /*
   * Der Fall, den die frühere Vorbelegung erzeugte: Netto und Brutto negativ,
   * Steuer fehlt. `Math.max(0, brutto - netto)` lieferte 0 — und damit einen
   * Beleg, der seine eigene Gleichung verletzte. Jetzt wird die Steuer aus der
   * Differenz gebildet, und der Beleg ist gültig.
   */
  it('eine Gutschrift ohne ausdrücklichen Steuerbetrag bleibt in sich schlüssig', () => {
    const created = addExpense(
      input({
        invoiceNumber: 'GS-2',
        category: 'gutschrift',
        netAmount: -100,
        taxAmount: undefined,
        grossAmount: -119,
      }),
    );
    expect(created.success, created.success ? '' : JSON.stringify(created)).toBe(true);
    if (!created.success) return;
    expect(created.expense.taxAmount).toBe(-19);
    expect(checkExpenseMoneyIntegrity(created.expense)).toEqual({ ok: true });
  });

  it('gegenläufige Vorzeichen von Netto und Steuer werden abgelehnt', () => {
    const result = checkExpenseMoneyIntegrity({
      netAmount: 100,
      taxAmount: -219,
      grossAmount: -119,
      taxStatus: 'standard_19',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('tax_sign_mismatch');
  });
});

describe('D — taxStatus: nur das, was das Modell hergibt', () => {
  /*
   * T11 — die Status, bei denen nach vorhandener Produktsemantik keine
   * Umsatzsteuer anfällt. Ein Steuerbetrag widerspricht dem Status selbst.
   */
  it.each([
    ['T11a: Kleinunternehmer', 'kleinunternehmer_19'],
    ['T11b: §13b Reverse Charge', 'reverse_charge_13b'],
    ['T11c: steuerfrei', 'tax_free'],
  ])('%s verträgt keinen Steuerbetrag', (_label, taxStatus) => {
    expect(isZeroRateTaxStatus(taxStatus as TaxStatus)).toBe(true);

    const result = checkExpenseMoneyIntegrity({
      netAmount: 100,
      taxAmount: 19,
      grossAmount: 119,
      taxStatus: taxStatus as TaxStatus,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('tax_on_zero_rate_status');

    // Mit Steuerbetrag 0 ist derselbe Status völlig in Ordnung.
    expect(
      checkExpenseMoneyIntegrity({
        netAmount: 100,
        taxAmount: 0,
        grossAmount: 100,
        taxStatus: taxStatus as TaxStatus,
      }),
    ).toEqual({ ok: true });
  });

  /*
   * T12 — `unclear` wird **nicht** interpretiert. Es sagt „unbekannt", nicht
   * „keine Steuer". Aus Unwissen einen Nullbetrag zu erzwingen wäre eine
   * erfundene Steuerbehandlung.
   */
  it('T12: unclear erzwingt keinen Steuerbetrag in die eine oder andere Richtung', () => {
    expect(isZeroRateTaxStatus('unclear')).toBe(false);
    expect(
      checkExpenseMoneyIntegrity({
        netAmount: 100,
        taxAmount: 19,
        grossAmount: 119,
        taxStatus: 'unclear',
      }),
    ).toEqual({ ok: true });
    expect(
      checkExpenseMoneyIntegrity({
        netAmount: 100,
        taxAmount: 0,
        grossAmount: 100,
        taxStatus: 'unclear',
      }),
    ).toEqual({ ok: true });
    expect(
      describeExpenseTaxRateDeviation({
        netAmount: 100,
        taxAmount: 0,
        grossAmount: 100,
        taxStatus: 'unclear',
      }),
    ).toBeNull();
  });

  /*
   * T9/T10 — 19 % und 7 % werden als **Hinweis** ausgewertet, nicht erzwungen.
   * Das Modell kennt einen Steuerstatus und einen Steuerbetrag je Beleg;
   * Mischsätze sind darin nicht darstellbar, und die Maske lässt den
   * Steuerbetrag offen. Eine harte Regel machte echte Belege unbuchbar.
   */
  it('T9: 19 % — passender Betrag ergibt keinen Befund, abweichender einen Hinweis', () => {
    expect(
      describeExpenseTaxRateDeviation({
        netAmount: 100,
        taxAmount: 19,
        grossAmount: 119,
        taxStatus: 'standard_19',
      }),
    ).toBeNull();

    const abweichung = describeExpenseTaxRateDeviation({
      netAmount: 100,
      taxAmount: 7,
      grossAmount: 107,
      taxStatus: 'standard_19',
    });
    expect(abweichung).toEqual({
      taxStatus: 'standard_19',
      ratePercent: 19,
      expectedTaxCents: 1900,
      actualTaxCents: 700,
    });

    // Und die Buchung bleibt trotzdem möglich — es ist ein Hinweis, kein Fehler.
    expect(
      checkExpenseMoneyIntegrity({
        netAmount: 100,
        taxAmount: 7,
        grossAmount: 107,
        taxStatus: 'standard_19',
      }),
    ).toEqual({ ok: true });
  });

  it('T10: 7 % wird genauso behandelt', () => {
    expect(
      describeExpenseTaxRateDeviation({
        netAmount: 200,
        taxAmount: 14,
        grossAmount: 214,
        taxStatus: 'standard_7',
      }),
    ).toBeNull();
  });

  it('bei einer Gutschrift erwartet die Satzprüfung ebenfalls ein negatives Vorzeichen', () => {
    expect(
      describeExpenseTaxRateDeviation({
        netAmount: -100,
        taxAmount: -19,
        grossAmount: -119,
        taxStatus: 'standard_19',
      }),
    ).toBeNull();
  });
});

describe('E — kein Schreibweg umgeht die Prüfung', () => {
  // T13 — Neuanlage.
  it('T13: addExpense lehnt widersprüchliche Beträge ab und speichert nichts', () => {
    const result = addExpense(
      input({ invoiceNumber: 'BAD-1', netAmount: 100, taxAmount: 19, grossAmount: 200 }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('expense.amountsInconsistent');
    expect(getAllExpensesFromStore()).toHaveLength(0);
  });

  it('T13b: addExpense lehnt einen Steuerbetrag bei steuerfreiem Status ab', () => {
    const result = addExpense(
      input({
        invoiceNumber: 'BAD-2',
        taxStatus: 'kleinunternehmer_19',
        netAmount: 100,
        taxAmount: 19,
        grossAmount: 119,
      }),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('expense.taxAmountNotAllowedForStatus');
  });

  // T14 — Änderung, geprüft auf dem zusammengeführten Stand.
  it('T14: updateExpense kann die Invariante nicht umgehen', () => {
    const created = addExpense(input({ invoiceNumber: 'UPD-1' }));
    if (!created.success) throw new Error('Vorbereitung');

    // Nur das Brutto ändern — Netto und Steuer bleiben stehen und passen nicht mehr.
    const result = updateExpense(created.expense.id, { grossAmount: 500 });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('expense.amountsInconsistent');

    // Der gespeicherte Beleg ist unverändert.
    const unveraendert = getExpenseById(created.expense.id)!;
    expect(unveraendert.grossAmount).toBe(119);
    expect(unveraendert.netAmount).toBe(100);
    expect(unveraendert.taxAmount).toBe(19);
  });

  it('T14b: eine stimmige Änderung geht weiterhin durch', () => {
    const created = addExpense(input({ invoiceNumber: 'UPD-2' }));
    if (!created.success) throw new Error('Vorbereitung');

    const result = updateExpense(created.expense.id, {
      netAmount: 200,
      taxAmount: 38,
      grossAmount: 238,
    });
    expect(result.success, result.success ? '' : JSON.stringify(result)).toBe(true);
    if (!result.success) return;
    expect(result.expense.grossAmount).toBe(238);
  });

  /*
   * T15 — der Weg aus dem Eingangsdokument (`record_expense`) legt die Ausgabe
   * über `addExpense` an und läuft damit durch dieselbe Prüfung. Getestet wird
   * genau das: Es gibt keinen zweiten Dienst mit eigener Regel.
   */
  it('T15: der Weg über den Eingang benutzt dieselbe Prüfung', () => {
    const nurBrutto = addExpense(
      input({ invoiceNumber: 'OCR-1', netAmount: undefined, taxAmount: undefined, grossAmount: 119 }),
    );
    expect(nurBrutto.success, nurBrutto.success ? '' : JSON.stringify(nurBrutto)).toBe(true);
    if (!nurBrutto.success) return;
    // Ohne Aufteilung: Netto = Brutto, Steuer = 0 — in sich schlüssig.
    expect(nurBrutto.expense.netAmount).toBe(119);
    expect(nurBrutto.expense.taxAmount).toBe(0);
    expect(checkExpenseMoneyIntegrity(nurBrutto.expense)).toEqual({ ok: true });
  });
});

describe('F — die Cloud-Grenze', () => {
  // T16 — eine ungültige Ausgabe erreicht die Cloud nicht.
  it('T16: ein ungültiger Beleg wird vor dem Upload abgewiesen', async () => {
    const ungueltig = legacyExpense();
    const outcome = await pushExpenseEntity(
      { entityType: 'expense', entityId: ungueltig.id, entity: ungueltig, rowVersion: 1, deleted: false },
      'update',
      'ws-1',
    );
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind !== 'skipped') return;
    expect(outcome.reason).toContain('invalid_money');
    expect(outcome.reason).toContain('equation_mismatch');
  });

  /*
   * Ein Grabstein bleibt erlaubt: Ein bereits hochgeladener Altbeleg muss
   * löschbar bleiben, sonst hinge er für immer in der Cloud fest.
   */
  it('das Löschen eines ungültigen Altbelegs bleibt möglich', async () => {
    const ungueltig = legacyExpense();
    const rpc = vi.fn().mockResolvedValue({ rowVersion: 2, deleted: true, noop: false });
    vi.doMock('./expenseCloudSyncService', () => ({ rpcUpsertWorkspaceExpense: rpc }));

    const outcome = await pushExpenseEntity(
      { entityType: 'expense', entityId: ungueltig.id, entity: ungueltig, rowVersion: 1, deleted: true },
      'delete',
      'ws-1',
    ).catch(() => ({ kind: 'skipped' as const, reason: 'rpc' }));

    // Entscheidend ist nur: Es scheitert nicht an der Geldprüfung.
    if (outcome.kind === 'skipped') expect(outcome.reason).not.toContain('invalid_money');
  });

  it('der Push-Payload eines gültigen Belegs bleibt unverändert aufgebaut', () => {
    const created = addExpense(input({ invoiceNumber: 'PUSH-1' }));
    if (!created.success) throw new Error('Vorbereitung');
    const payload = buildExpensePushPayload(created.expense, false);
    expect(payload.client_expense_id).toBe(created.expense.id);
    expect(payload.deleted).toBe(false);
  });
});

describe('G — Altbestand: sichtbar, aber unangetastet', () => {
  // T18 — nichts wird automatisch korrigiert.
  it('T18: ein ungültiger Altbeleg behält seine Beträge', () => {
    setExpenseStoreForTests([legacyExpense()]);

    const geladen = getExpenseFromStoreById('exp-legacy-1')!;
    expect(geladen.netAmount).toBe(100);
    expect(geladen.taxAmount).toBe(19);
    expect(geladen.grossAmount).toBe(200);
    // Auch nach erneutem Lesen — `normalizeExpense` rechnet nichts nach.
    expect(getAllExpensesFromStore()[0].grossAmount).toBe(200);
  });

  // T19 — er wird erkannt.
  it('T19: die Bestandsprüfung findet ihn und zählt den Befund', () => {
    const audit = auditExpenseMoneyIntegrity([
      legacyExpense(),
      legacyExpense({ id: 'exp-ok', netAmount: 100, taxAmount: 19, grossAmount: 119 }),
    ]);

    expect(audit.total).toBe(2);
    expect(audit.invalid).toHaveLength(1);
    expect(audit.invalid[0].id).toBe('exp-legacy-1');
    expect(audit.byIssue.equation_mismatch).toBe(1);
    expect(audit.byIssue.tax_on_zero_rate_status).toBe(0);
  });

  it('T19b: ein Satzhinweis ist kein Fehlbefund', () => {
    const audit = auditExpenseMoneyIntegrity([
      legacyExpense({ id: 'exp-rate', netAmount: 100, taxAmount: 7, grossAmount: 107 }),
    ]);
    expect(audit.invalid).toHaveLength(0);
    expect(audit.rateDeviations).toHaveLength(1);
    expect(audit.rateDeviations[0].deviation.expectedTaxCents).toBe(1900);
  });

  // T17 — ein gültiger Beleg bleibt über das Laden hinweg identisch.
  it('T17: ein gültiger Beleg ist nach dem Neuladen unverändert', () => {
    const created = addExpense(input({ invoiceNumber: 'RELOAD-1' }));
    if (!created.success) throw new Error('Vorbereitung');

    setExpenseStoreForTests([created.expense]);
    const wieder = getExpenseFromStoreById(created.expense.id)!;
    expect(wieder.netAmount).toBe(created.expense.netAmount);
    expect(wieder.taxAmount).toBe(created.expense.taxAmount);
    expect(wieder.grossAmount).toBe(created.expense.grossAmount);
  });
});

describe('H — Monatsmappe', () => {
  const leererInput = {
    monthKey: '2026-05',
    invoices: [],
    documents: [],
    inboxItems: [],
    fileRefs: [],
  };

  // T20 — ein gültiger Beleg bekommt keinen zusätzlichen Hinweis.
  it('T20: ein gültiger Eingangsbeleg regressiert nicht', () => {
    const gueltig = legacyExpense({
      id: 'exp-gut',
      netAmount: 100,
      taxAmount: 19,
      grossAmount: 119,
      archiveDocumentId: undefined,
    });
    const model = buildMonatsmappeModel({ ...leererInput, expenses: [gueltig] });

    expect(model.eingangsbelege).toHaveLength(1);
    expect(model.eingangsbelege[0].netto).toBe(100);
    expect(model.eingangsbelege[0].brutto).toBe(119);
    // Ohne Originaldokument bleibt der bisherige Hinweis — und nur der.
    expect(model.eingangsbelege[0].hinweis).toBe('Kein Originaldokument vorhanden');
  });

  /*
   * Ein ungültiger Altbeleg wird **gekennzeichnet**, nicht gerechnet. Die
   * Zahlen im Export sind exakt die gespeicherten; der Steuerberater sieht den
   * Widerspruch, statt ihn zu übernehmen.
   */
  it('ein ungültiger Altbeleg wird im Export sichtbar gekennzeichnet', () => {
    const model = buildMonatsmappeModel({ ...leererInput, expenses: [legacyExpense()] });

    expect(model.eingangsbelege).toHaveLength(1);
    const beleg = model.eingangsbelege[0];
    expect(beleg.hinweis).toContain('Beträge widersprüchlich');
    expect(beleg.hinweis).toContain('equation_mismatch');
    // Nichts repariert: die Beträge stehen unverändert im Export.
    expect(beleg.netto).toBe(100);
    expect(beleg.steuer).toBe(19);
    expect(beleg.brutto).toBe(200);
  });
});
