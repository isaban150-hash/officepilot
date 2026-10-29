/**
 * P1-KORREKTUR A-04 — Nacharbeit nach WEISS-FAIL (A04-WEISS-R1, A04-WEISS-R2), Client-Seite.
 *
 * R2  Aufteilungsart, Vorsteuerabzug und abziehbarer Betrag gehören zum Abschluss (Fassung 6). WEISS-Folge:
 *     Abschluss → Abziehbarkeit ändern → Kontierung erneut bestätigen → Abschlussstatus. Erwartet: „seit Abschluss
 *     geändert“, auch nach erneuter Bestätigung. Ältere Revisionen (Fassung 5) bleiben gültig und nachvollziehbar; für
 *     sie ist die Änderung gesperrt (Korrekturweg Wiederöffnen).
 * R1  (Client-Anteil) Ein Altclient verliert das Kennzeichen — den Erhalt übernimmt der Server (SQL-Tests der
 *     Migration). Hier: Der Cloud-Auftrag trägt das Schema-Kennzeichen; ein kennzeichenloser Altbefund erscheint in den
 *     Buchungsdaten nie vorbehaltlos als bestätigte Nullsteuer, im Paket und in der Übergabe als unklarer Fall.
 *
 * Synthetische Daten, kein Netzwerk.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { setExpenseStoreForTests, getExpenseFromStoreById } from '../expenseStore';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import { normalizeExpense } from '../expenseNormalize';
import { updateExpense } from '../expenseService';
import { setAccountingStoreForTests, getAccountingAssignmentForSource } from './accountingStore';
import { setAccountingPeriodStoreForTests, getActiveClosureForMonth } from './accountingPeriodStore';
import {
  closeAccountingPeriod,
  getAccountingPeriodState,
  reopenAccountingPeriod,
} from './accountingPeriodService';
import {
  buildPeriodCanonicalText,
  buildPeriodFingerprint,
  buildPeriodManifest,
  closureFingerprintVersion,
} from './accountingPeriodFingerprint';
import { confirmAccountingAssignment, updateAccountingAssignment } from './accountingAssignmentService';
import { buildBookingExport } from './accountingBookingExportService';
import { serverConfirmationFrom } from './accountingPeriodCloudSyncService';
import { buildMonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import { collectMonatsmappeInput } from '../steuerberater/monatsmappeInputService';
import { getSteuerberaterHandoverStatus } from '../steuerberaterOverviewService';
import { buildExpensePushPayload } from '../expense/expenseCloudSyncService';
import { EXPENSE_TAX_SPLIT_SCHEMA, resolveExpenseTaxSplitState } from '../expense/expenseTaxSplit';
import { isFinalBusinessRejectionMessage } from '../sync/syncRoleDenial';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import type { AccountingAssignment } from '../../types/accounting';
import type { AccountingPeriodClosure } from '../../types/accountingPeriod';
import type { Expense } from '../../types/expense';

const OKT = '2026-10';

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-a04-na',
    status: 'gebucht',
    category: 'material',
    supplierName: 'A04-NA Lieferant',
    invoiceNumber: 'A04-NA-1',
    title: 'A04-NA Material',
    issueDate: '2026-10-12',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    taxSplit: 'belegt',
    ...overrides,
  } as Expense);
}

function kontierung(sourceId = 'exp-a04-na', overrides: Partial<AccountingAssignment> = {}): AccountingAssignment {
  return {
    id: `k-${sourceId}`,
    sourceType: 'expense',
    sourceId,
    chartOfAccounts: 'SKR03',
    accountNumber: '3400',
    accountLabel: 'Wareneingang',
    taxTreatment: 'standard_19',
    bookingText: 'A04-NA',
    status: 'confirmed',
    origin: 'manual',
    confirmedAt: '2026-10-15T10:00:00.000Z',
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

/** Vertrag mit test-a04-server.sql (T21): das Client-Manifest des synthetischen Dezembers, wortgleich dort eingebettet. */
const VERTRAG_MANIFEST_DEZ = JSON.parse(
  '{"fingerprintVersion":6,"monthKey":"2026-12","chartOfAccounts":"SKR03","documentCount":1,"totalBrutto":119,"totalNetto":100,"totalSteuer":19,"entries":[{"sourceType":"expense","sourceId":"exp-a04-d1","belegnummer":"","datum":"2026-12-04","brutto":119,"netto":100,"steuer":19,"belegStatus":"aktiv","accountNumber":"3400","taxTreatment":"standard_19","bookingText":"A04","assignmentStatus":"confirmed","belegart":"eingangsbeleg","kontenrahmen":"SKR03","skontoAbzug":0,"steueraufteilung":"belegt","vorsteuerabzug":"teilweise","abziehbareVorsteuer":9.5}],"payments":[],"employeePayments":[],"offenePosten":[{"belegart":"eingangsbeleg","belegId":"exp-a04-d1","datum":"2026-12-04","brutto":119,"bezahlt":0,"offen":119,"faelligAm":""}]}',
);

const zustand = () => getAccountingPeriodState(OKT);
const mappe = () => buildMonatsmappeModel(collectMonatsmappeInput(OKT));

beforeEach(() => {
  localStorage.clear();
  setAccountingStoreForTests([]);
  setAccountingPeriodStoreForTests([]);
  setExpenseStoreForTests([]);
  hydrateInvoiceStore([]);
  hydrateWorkspaceStore({
    workspaceSettings: {
      workspaceId: '00000000-0000-0000-0000-0000000a04aa',
      settings: { chartOfAccounts: 'SKR03' },
      version: 1,
      updatedAt: '2026-10-01T10:00:00.000Z',
    },
  });
});

/* ================================================================== */

describe('R2 — Fassung 6 bindet Aufteilung und Vorsteuerabzug', () => {
  it('R2-1: neue Revisionen entstehen in Fassung 6; die E-Zeile trägt Aufteilung, Abzug und abziehbaren Betrag', () => {
    setExpenseStoreForTests([ausgabe({ inputTaxDeduction: 'teilweise', deductibleTaxAmount: 9.5 })]);
    setAccountingStoreForTests([kontierung()]);
    expect(closeAccountingPeriod(OKT).success).toBe(true);
    const closure = getActiveClosureForMonth(OKT)!;
    expect(closureFingerprintVersion(closure)).toBe(6);
    expect(closure.fingerprint.startsWith('p6:')).toBe(true);
    const text = buildPeriodCanonicalText(closure.manifest);
    expect(text.split('\n')[0]).toBe('v=6|month=2026-10|chart=SKR03');
    expect(text).toContain('E|expense|exp-a04-na|eingangsbeleg|2026-10-12|11900|10000|1900|0|aktiv|SKR03|3400|standard_19|confirmed|A04-NA|belegt|teilweise|950');
  });

  it.each([
    ['keiner', { inputTaxDeduction: 'keiner' as const }],
    ['teilweise 9,50', { inputTaxDeduction: 'teilweise' as const, deductibleTaxAmount: 9.5 }],
    ['gemischt', { taxSplit: 'gemischt' as const }],
  ])('R2-2 (WEISS-Folge, %s): Abschluss → Änderung → erneute Kontierungsbestätigung → bleibt „seit Abschluss geändert“', (_name, aenderung) => {
    setExpenseStoreForTests([ausgabe()]);
    setAccountingStoreForTests([kontierung()]);
    expect(closeAccountingPeriod(OKT).success).toBe(true);
    expect(zustand().readiness).toBe('closed');

    const geaendert = updateExpense('exp-a04-na', { ...aenderung, taxSplit: aenderung.taxSplit ?? 'belegt', taxAmount: 19 });
    expect(geaendert.success, JSON.stringify(geaendert)).toBe(true);
    expect(zustand().readiness).toBe('changed_after_close');

    // Die Kontierung ging in die Prüfung; erneut bestätigen (neuer Zeitstempel) …
    const k = getAccountingAssignmentForSource('expense', 'exp-a04-na')!;
    expect(k.status).toBe('needs_review');
    expect(updateAccountingAssignment(k.id, { accountNumber: '3400' }).success).toBe(true);
    expect(confirmAccountingAssignment(k.id, { sourceTaxTreatment: 'standard_19' }).success).toBe(true);
    // … macht die alte Revision nicht wieder gültig.
    const nachher = zustand();
    expect(nachher.readiness).toBe('changed_after_close');
    expect(nachher.isCurrentClosureValid).toBe(false);
  });

  it('R2-3: der Korrekturweg — wieder öffnen und neu abschließen bindet die neue Aussage (Revision 2)', () => {
    setExpenseStoreForTests([ausgabe()]);
    setAccountingStoreForTests([kontierung()]);
    expect(closeAccountingPeriod(OKT).success).toBe(true);
    expect(updateExpense('exp-a04-na', { taxSplit: 'belegt', taxAmount: 19, inputTaxDeduction: 'keiner' }).success).toBe(true);
    const k = getAccountingAssignmentForSource('expense', 'exp-a04-na')!;
    expect(confirmAccountingAssignment(k.id, { sourceTaxTreatment: 'standard_19' }).success).toBe(true);
    expect(reopenAccountingPeriod(OKT, { reason: 'A04-NA Vorsteuer nicht abziehbar' }).success).toBe(true);
    // Der Abgleich hat die Änderung bestätigt (sonst sperrt „unbestätigte Finanzänderung“ zu Recht).
    resetSyncOutboxForTests(getSyncOutboxSnapshot().map((entry) => ({ ...entry, status: 'completed' as const })));
    const zweiter = closeAccountingPeriod(OKT);
    expect(zweiter.success, JSON.stringify(zweiter)).toBe(true);
    const neu = getActiveClosureForMonth(OKT)!;
    expect(neu.revision).toBe(2);
    expect(buildPeriodCanonicalText(neu.manifest)).toContain('|belegt|keiner|');
    expect(zustand().readiness).toBe('closed');
  });

  it('R2-4: eine Revision der Fassung 5 bleibt gültig und nach Fassung 5 prüfbar; die Änderung der Merkmale ist dort gesperrt', () => {
    const start = ausgabe();
    setExpenseStoreForTests([start]);
    setAccountingStoreForTests([kontierung()]);
    const manifest5 = buildPeriodManifest(mappe(), [kontierung()], 'SKR03', 5);
    const alt: AccountingPeriodClosure = {
      id: 'closure-a04-v5',
      monthKey: OKT,
      revision: 1,
      closedAt: '2026-10-20T10:00:00.000Z',
      fingerprint: buildPeriodFingerprint(manifest5),
      manifest: manifest5,
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
    };
    setAccountingPeriodStoreForTests([alt]);
    expect(closureFingerprintVersion(alt)).toBe(5);
    expect(zustand().readiness).toBe('closed');

    // Abziehbarkeit, abziehbarer Betrag, Aufteilungsart: abgewiesen, gespeicherter Stand unverändert.
    for (const aenderung of [
      { inputTaxDeduction: 'keiner' as const },
      { inputTaxDeduction: 'teilweise' as const, deductibleTaxAmount: 9.5 },
      { taxSplit: 'gemischt' as const },
    ]) {
      expect(updateExpense('exp-a04-na', { taxSplit: 'belegt', taxAmount: 19, ...aenderung })).toEqual({
        success: false,
        errorKey: 'expense.taxSplit.closedPeriod',
      });
    }
    expect(getExpenseFromStoreById('exp-a04-na')).toEqual(start);
    // Andere Felder bleiben änderbar (Titel ist nicht gebunden).
    expect(updateExpense('exp-a04-na', { title: 'A04-NA umbenannt' }).success).toBe(true);
    expect(zustand().readiness).toBe('closed');
  });

  it('R2-6 (Vertrag mit dem Server): derselbe synthetische Dezember ergibt exakt den Text, den test-a04-server.sql (T21) vom Server verlangt', () => {
    setExpenseStoreForTests([
      ausgabe({
        id: 'exp-a04-d1', invoiceNumber: '', issueDate: '2026-12-04', paymentDueDate: null,
        inputTaxDeduction: 'teilweise', deductibleTaxAmount: 9.5,
      }),
    ]);
    const k = kontierung('exp-a04-d1', { bookingText: 'A04' });
    const model = buildMonatsmappeModel(collectMonatsmappeInput('2026-12'));
    const manifest = buildPeriodManifest(model, [k], 'SKR03', 6);
    // Dasselbe JSON sendet test-a04-server.sql (pg_temp.manifest_dez, T21a/T21d) an den Server.
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(VERTRAG_MANIFEST_DEZ);
    const text = buildPeriodCanonicalText(manifest);
    expect(text).toBe(
      [
        'v=6|month=2026-12|chart=SKR03',
        'E|expense|exp-a04-d1|eingangsbeleg|2026-12-04|11900|10000|1900|0|aktiv|SKR03|3400|standard_19|confirmed|A04|belegt|teilweise|950',
        'O|eingangsbeleg|exp-a04-d1|2026-12-04|11900|0|11900|',
      ].join('\n'),
    );
  });

  it('R2-5: Serverbestätigung — Fassung 6 nur mit p6, Fassung 5 weiter mit p5', () => {
    const basis = { finance_revision: 7, validated_at: '2026-10-20T10:00:00.000Z', revision: 1 };
    expect(serverConfirmationFrom({ ...basis, validated_version: 6, fingerprint: 'p6:abc' })?.validiert).toBe(true);
    expect(serverConfirmationFrom({ ...basis, validated_version: 5, fingerprint: 'p5:abc' })?.validiert).toBe(true);
    expect(serverConfirmationFrom({ ...basis, validated_version: 6, fingerprint: 'p5:abc' })).toBeUndefined();
    expect(serverConfirmationFrom({ ...basis, validated_version: 7, fingerprint: 'p7:abc' })).toBeUndefined();
  });
});

/* ================================================================== */

describe('R1 — Client-Anteil des Serververtrags', () => {
  it('R1-1: jeder Cloud-Auftrag trägt das Schema-Kennzeichen und die Aufteilung', () => {
    const push = buildExpensePushPayload(ausgabe({ taxSplit: 'offen', netAmount: 119, taxAmount: 0 }), false) as { payload: Record<string, unknown> };
    expect(push.payload.taxSplitSchema).toBe(EXPENSE_TAX_SPLIT_SCHEMA);
    expect(push.payload.taxSplit).toBe('offen');
    // Auch ein Altbestand ohne Aufteilung wird als „kennt die Aufteilung“ gesendet: Der Server übernimmt nichts Fremdes.
    const alt = buildExpensePushPayload(ausgabe({ taxSplit: undefined, netAmount: 119, taxAmount: 0 }), false) as { payload: Record<string, unknown> };
    expect(alt.payload.taxSplitSchema).toBe(EXPENSE_TAX_SPLIT_SCHEMA);
    expect('taxSplit' in alt.payload).toBe(false);
  });

  it('R1-2 (WEISS-Reproduktion ohne Servererhalt): Kennzeichen weg → Altbefund → Buchungszeile mit Vorbehalt „UNGEPRÜFT“, nie vorbehaltlose Nullsteuer', () => {
    // Was ein Altclient aus „offen“ macht: dieselben Beträge, ohne Kennzeichen (früheres normalizeExpense).
    const verloren = ausgabe({ taxSplit: undefined, netAmount: 119, taxAmount: 0 });
    expect(resolveExpenseTaxSplitState(verloren)).toBe('altbestand_pruefen');
    setExpenseStoreForTests([verloren]);
    const exportStand = buildBookingExport(mappe(), [kontierung()], 'SKR03');
    expect(exportStand.rows).toHaveLength(1);
    const zeile = exportStand.rows[0];
    expect([zeile.netto, zeile.steuer, zeile.brutto]).toEqual([119, 0, 119]);
    expect(zeile.steuerstatus).toMatch(/^Umsatzsteuer 19 % – UNGEPRÜFT: Altbestand mit 0,00 Steuer/);
    expect(zeile.steuerstatus).not.toBe('Umsatzsteuer 19 %');
  });

  it('R1-3: ungeprüfter Altbestand ist ein unklarer Fall der Übergabe (Mappe, Übersicht)', () => {
    setExpenseStoreForTests([ausgabe({ taxSplit: undefined, netAmount: 119, taxAmount: 0 })]);
    setAccountingStoreForTests([kontierung()]);
    expect(mappe().altbestandPruefen).toEqual([{ id: 'exp-a04-na', belegnummer: 'A04-NA-1' }]);
    const status = getSteuerberaterHandoverStatus(OKT);
    expect(status.counts.unclearCases).toBe(1);
    expect(status.packageComplete).toBe(false);
    // Den Abschluss sperrt ungeprüfter Altbestand weiterhin nicht (keine Sackgasse, Werte unverändert).
    expect(zustand().blockers.map((b) => b.code)).not.toContain('tax_split_open');
  });

  it('R1-4: die neuen Serverabweisungen gelten als endgültig (kein Endlos-Wiederholen)', () => {
    for (const code of [
      'expense_tax_split_conflict: …',
      'expense_tax_split_zero_tax: …',
      'expense_tax_split_closed_period: …',
      'expense_tax_split_open_allocations: …',
      'expense_input_tax_deduction_amount_invalid: …',
      'expense_payment_tax_split_open: …',
    ]) {
      expect(isFinalBusinessRejectionMessage(code), code).toBe(true);
    }
  });
});
