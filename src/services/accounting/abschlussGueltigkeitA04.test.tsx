/**
 * P1 A-04 — Nacharbeit nach WEISS-FAIL (Auftrag 27.10.2026): Gültigkeit bereits abgeschlossener Zahlungsmonate.
 *
 * Befund: `resolveReadiness` meldete bei unverändertem Fingerprint „abgeschlossen“ und `isCurrentClosureValid` war
 * wahr, obwohl inzwischen ein Sperrgrund bestand (hier: eine Zahlung des Monats auf einen Beleg eines anderen Monats,
 * dessen Steueraufteilung offen ist). Die Abschlussansicht zeigte den Monat damit uneingeschränkt als abgeschlossen;
 * die Übergabe sperrte nur über `period_blockers`.
 *
 * Soll: Eine bestehende Revision bleibt unverändert. Besteht bei gleichem Stand ein Sperrgrund, heißt der Zustand
 * „Erneute Prüfung erforderlich“ mit konkretem Grund; der Abschluss gilt nicht als gültig, die Übergabe bleibt
 * gesperrt. Fällt der Grund weg (gültige Steuerklärung), gilt dieselbe Revision wieder — ohne neue Revision.
 * Sperrgründe gelten nach den heutigen Regeln, auch für Revisionen älterer Fassung (Fassung 1 kennt keine Zahlungen).
 *
 * Realistischer Weg zum Befund: ein Altbestand-Beleg (0 € Steuer bei 19 %, Juli) mit Zahlung im September; der
 * September wird abgeschlossen; danach wählt der Nutzer am Beleg „Noch offen“ (so empfiehlt es der Altbestand-Hinweis).
 * Netto, Steuer, Brutto und Zahlung bleiben gleich — der September-Fingerprint auch.
 *
 * Synthetische Daten, kein Netzwerk.
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTestStores } from '../../test/resetStores';
import { abschluesseServerbestaetigt } from '../../test/accountingClosureTestUtils';
import { persistAll } from '../persistenceService';
import { normalizeExpense } from '../expenseNormalize';
import { getExpenseFromStoreById, setExpenseStoreForTests } from '../expenseStore';
import { addExpense, updateExpense } from '../expenseService';
import { resolveExpenseTaxSplitState } from '../expense/expenseTaxSplit';
import { hydrateInvoiceStore } from '../invoice/invoiceStore';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import { getSyncOutboxSnapshot, resetSyncOutboxForTests } from '../sync/syncOutboxService';
import { setAccountingStoreForTests } from './accountingStore';
import { getAllAccountingPeriodClosures, setAccountingPeriodStoreForTests } from './accountingPeriodStore';
import { buildAccountingPeriodState, closeAccountingPeriod, getAccountingPeriodState } from './accountingPeriodService';
import { buildPeriodFingerprint, buildPeriodManifest, closureFingerprintVersion } from './accountingPeriodFingerprint';
import { evaluateAccountingExportReadiness } from './accountingExportGateService';
import { buildAccountingExport } from './accountingExportRunner';
import { buildMonatsmappeModel } from '../steuerberater/monatsmappeModelService';
import { collectMonatsmappeInput } from '../steuerberater/monatsmappeInputService';
import { getSteuerberaterHandoverStatus } from '../steuerberaterOverviewService';
import { AccountingPeriodPanel } from '../../components/accounting/AccountingPeriodPanel';
import { SteuerberaterHandoverPanel } from '../../components/accounting/SteuerberaterHandoverPanel';
import { AccountingExportPanel } from '../../components/accounting/AccountingExportPanel';
import { bg, de, tr } from '../../i18n';
import type { TranslationKey } from '../../i18n';
import type { MonatsmappeDocumentLoaders } from '../steuerberater/monatsmappeExportService';
import type { AccountingAssignment } from '../../types/accounting';
import type { AccountingPeriodClosure } from '../../types/accountingPeriod';
import type { Expense } from '../../types/expense';

const WS = '00000000-0000-4000-8000-0000000a04c1';
const SEP = '2026-09';
const ALT = 'exp-ag-alt';
const SEPBELEG = 'exp-ag-sep';
const SYNC = { version: 1, updatedAt: '2026-09-20T10:00:00.000Z', workspaceId: WS, deviceId: 'G', deleted: false };

/** Altbestand aus dem Juli: 0 € Steuer bei 19 %, ohne Aufteilungskennzeichen, im September voll bezahlt. */
function altbestand(): Expense {
  return {
    ...normalizeExpense({
      id: ALT,
      status: 'gebucht',
      category: 'material',
      supplierName: 'AG Altlieferant',
      invoiceNumber: 'AG-ALT-1',
      title: 'AG Altbestand Juli',
      issueDate: '2026-07-10',
      taxStatus: 'standard_19',
      netAmount: 119,
      taxAmount: 0,
      grossAmount: 119,
      payments: [{ id: 'pay-ag-sep', date: '2026-09-05', amount: 119, method: 'bank', createdAt: '2026-09-05T10:00:00.000Z' }],
    } as Expense),
    sync: SYNC,
  };
}

/** Ein eigener, sauber kontierter Beleg des Septembers. */
function septemberBeleg(): Expense {
  return {
    ...normalizeExpense({
      id: SEPBELEG,
      status: 'gebucht',
      category: 'material',
      supplierName: 'AG Lieferant September',
      invoiceNumber: 'AG-SEP-1',
      title: 'AG September',
      issueDate: '2026-09-12',
      taxStatus: 'standard_19',
      netAmount: 100,
      taxAmount: 19,
      grossAmount: 119,
      taxSplit: 'belegt',
    } as Expense),
    sync: SYNC,
  };
}

function kontierung(sourceId: string): AccountingAssignment {
  return {
    id: `k-${sourceId}`,
    sourceType: 'expense',
    sourceId,
    chartOfAccounts: 'SKR03',
    accountNumber: '3400',
    accountLabel: 'Wareneingang',
    taxTreatment: 'standard_19',
    bookingText: `AG ${sourceId}`,
    status: 'confirmed',
    origin: 'manual',
    confirmedAt: '2026-09-15T10:00:00.000Z',
    createdAt: '2026-09-15T10:00:00.000Z',
    updatedAt: '2026-09-15T10:00:00.000Z',
  };
}

const loaders: MonatsmappeDocumentLoaders = {
  invoicePdf: async () => new Uint8Array([37, 80, 68, 70, 45]),
  invoiceCorrectionPdf: async () => new Uint8Array([37, 80, 68, 70, 45]),
  fileRefBytes: async () => new Uint8Array([1, 2, 3]),
};

/** Der Server hat alles Bisherige bestätigt (ein gelungener Sendelauf). */
function bestaetigt(): void {
  resetSyncOutboxForTests(getSyncOutboxSnapshot().map((entry) => ({ ...entry, status: 'completed' as const })));
}
function ruhe(): void {
  persistAll();
  bestaetigt();
}
const septemberRevisionen = (): AccountingPeriodClosure[] => getAllAccountingPeriodClosures().filter((c) => c.monthKey === SEP);
const codes = (items: readonly { code: string }[]) => items.map((item) => item.code);

/** September abschließen (Fassung 6, vom Server angenommen) und die gespeicherte Revision festhalten. */
function septemberAbgeschlossen(): { revision: AccountingPeriodClosure; json: string } {
  setExpenseStoreForTests([altbestand(), septemberBeleg()]);
  setAccountingStoreForTests([kontierung(SEPBELEG)]);
  ruhe();
  const ergebnis = closeAccountingPeriod(SEP);
  expect(ergebnis.success, JSON.stringify(ergebnis)).toBe(true);
  abschluesseServerbestaetigt(SEP);
  const [revision] = septemberRevisionen();
  expect(closureFingerprintVersion(revision)).toBe(6);
  return { revision, json: JSON.stringify(septemberRevisionen()) };
}

/** Der Nutzer wählt am Altbestand „Noch offen“ (Netto, Steuer, Brutto und Zahlung bleiben gleich); der Server bestätigt. */
function altbestandWiederOffen(): void {
  const ergebnis = updateExpense(ALT, { taxSplit: 'offen' });
  expect(ergebnis.success, JSON.stringify(ergebnis)).toBe(true);
  expect(resolveExpenseTaxSplitState(getExpenseFromStoreById(ALT)!)).toBe('offen');
  ruhe();
}

const translate = (key: TranslationKey): string => de[key] ?? key;
let container: HTMLDivElement;
let root: Root;
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const wert = (id: string) => q(id)?.textContent ?? '';

async function zeige(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

beforeEach(() => {
  resetTestStores();
  localStorage.clear();
  setAccountingStoreForTests([]);
  setAccountingPeriodStoreForTests([]);
  setExpenseStoreForTests([]);
  hydrateInvoiceStore([]);
  hydrateWorkspaceStore({
    workspaceSettings: { workspaceId: WS, settings: { chartOfAccounts: 'SKR03' }, version: 1, updatedAt: '2026-09-01T10:00:00.000Z' },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetTestStores();
});

/* ================================================================== */

describe('G — abgeschlossener Zahlungsmonat bei neuem Sperrgrund', () => {
  it('G1 (WEISS-Befund): gleicher Fingerprint, neuer Sperrgrund → „Erneute Prüfung erforderlich“, Abschluss nicht gültig, Revision unverändert', () => {
    const { revision, json } = septemberAbgeschlossen();
    const vorher = getAccountingPeriodState(SEP);
    expect([vorher.readiness, vorher.isCurrentClosureValid, codes(vorher.blockers)]).toEqual(['closed', true, []]);

    altbestandWiederOffen();
    const nachher = getAccountingPeriodState(SEP);
    // Der gespeicherte Fingerprint passt weiterhin — nur der Sperrgrund ist neu.
    expect(nachher.currentFingerprint).toBe(revision.fingerprint);
    expect(nachher.blockers).toEqual([{ code: 'tax_split_open_payment', count: 1, sourceIds: [ALT] }]);
    expect(nachher.readiness).toBe('recheck_required');
    expect(nachher.isCurrentClosureValid).toBe(false);
    // Die Revision bleibt aktiv, unverändert und die einzige.
    expect(nachher.activeClosure?.id).toBe(revision.id);
    expect(nachher.activeClosureStatus).toBe('angenommen');
    expect(JSON.stringify(septemberRevisionen())).toBe(json);
  });

  it('G2 Exportsperre: Paket gesperrt mit eigenem Grund (nicht „seit Abschluss geändert“), auch lokal; Exportlauf blockiert', async () => {
    const { json } = septemberAbgeschlossen();
    expect(evaluateAccountingExportReadiness(SEP).packageAllowed).toBe(true);
    altbestandWiederOffen();

    const gate = evaluateAccountingExportReadiness(SEP);
    expect(gate.packageAllowed).toBe(false);
    expect(gate.datevAllowed).toBe(false);
    expect(gate.localHandoverAllowed).toBe(false);
    expect(codes(gate.packageBlockers)).toEqual(['closure_recheck_required', 'period_blockers']);
    for (const handover of ['regulaer', 'lokal'] as const) {
      const { result, blob } = await buildAccountingExport({ monthKey: SEP, userId: undefined, skipGate: true, loaders, handover });
      expect(result.outcome, handover).toBe('blocked');
      expect(blob, handover).toBeUndefined();
    }
    const status = getSteuerberaterHandoverStatus(SEP);
    expect(status.state).toBe('recheck_required');
    // Fehlende Originaldokumente der synthetischen Belege (`missing_proofs`) stehen wie bisher dahinter.
    expect(status.issues.slice(0, 2)).toEqual(['recheck_required', 'period_blockers']);
    expect(status.issues).not.toContain('changed_after_close');
    expect(status.issues).not.toContain('not_closed');
    expect(status.packageAllowed).toBe(false);
    expect(JSON.stringify(septemberRevisionen())).toBe(json);
  });

  it('G3 kein neuer Abschluss und keine stille Revision: erneutes Abschließen abgewiesen, Revision unverändert', () => {
    const { json } = septemberAbgeschlossen();
    altbestandWiederOffen();
    const ergebnis = closeAccountingPeriod(SEP);
    expect(ergebnis.success).toBe(false);
    expect(ergebnis).toMatchObject({ errorKey: 'accountingPeriod.notReady' });
    expect(JSON.stringify(septemberRevisionen())).toBe(json);
  });

  it('G4 Wegfall nach gültiger Steuerklärung: dieselbe Revision gilt wieder, Paket frei — keine neue Revision; 0 € ist keine Klärung', async () => {
    const { revision, json } = septemberAbgeschlossen();
    altbestandWiederOffen();
    // Keine Klärung (Regel B): 0 € Steuer bei 19 % bzw. „unklar“ — abgewiesen, der Zustand bleibt „erneut prüfen“.
    expect(updateExpense(ALT, { taxSplit: 'belegt', taxAmount: 0 })).toMatchObject({ success: false });
    expect(updateExpense(ALT, { taxStatus: 'unclear', taxSplit: 'belegt', taxAmount: 0 })).toMatchObject({ success: false });
    expect(getAccountingPeriodState(SEP).readiness).toBe('recheck_required');

    const klaerung = updateExpense(ALT, { taxSplit: 'belegt', netAmount: 100, taxAmount: 19 });
    expect(klaerung.success, JSON.stringify(klaerung)).toBe(true);
    ruhe();
    const danach = getAccountingPeriodState(SEP);
    expect([danach.readiness, danach.isCurrentClosureValid, codes(danach.blockers)]).toEqual(['closed', true, []]);
    expect(danach.currentFingerprint).toBe(revision.fingerprint);
    expect(danach.activeClosure?.id).toBe(revision.id);
    expect(JSON.stringify(septemberRevisionen())).toBe(json);
    const gate = evaluateAccountingExportReadiness(SEP);
    expect(gate.packageAllowed).toBe(true);
    const { result } = await buildAccountingExport({ monthKey: SEP, userId: undefined, skipGate: true, loaders });
    expect(result.outcome, JSON.stringify(result)).toBe('exported');
    expect(JSON.stringify(septemberRevisionen())).toBe(json);
  });

  it('G5 normaler gültiger Abschluss ohne Sperrgrund bleibt „abgeschlossen“ und übergabebereit', () => {
    septemberAbgeschlossen();
    const zustand = getAccountingPeriodState(SEP);
    expect([zustand.readiness, zustand.isCurrentClosureValid]).toEqual(['closed', true]);
    const gate = evaluateAccountingExportReadiness(SEP);
    expect([gate.packageAllowed, codes(gate.packageBlockers)]).toEqual([true, []]);
    expect(getSteuerberaterHandoverStatus(SEP).issues).not.toContain('recheck_required');
  });

  it('G6 Vorrang: geänderter Stand bleibt „seit Abschluss geändert“, auch wenn zusätzlich ein Sperrgrund besteht', () => {
    septemberAbgeschlossen();
    altbestandWiederOffen();
    const neu = addExpense({
      title: 'AG Nachtrag September', category: 'material', supplierName: 'AG Nachtrag', invoiceNumber: 'AG-SEP-2',
      issueDate: '2026-09-20', taxStatus: 'standard_19', grossAmount: 119, netAmount: 100, taxAmount: 19, taxSplit: 'belegt',
    });
    expect(neu.success, JSON.stringify(neu)).toBe(true);
    ruhe();
    const zustand = getAccountingPeriodState(SEP);
    expect(zustand.readiness).toBe('changed_after_close');
    expect(zustand.isCurrentClosureValid).toBe(false);
    expect(codes(zustand.blockers)).toContain('tax_split_open_payment');
    const gate = evaluateAccountingExportReadiness(SEP);
    expect(codes(gate.packageBlockers)).toContain('changed_after_close');
    expect(codes(gate.packageBlockers)).not.toContain('closure_recheck_required');
    expect(getSteuerberaterHandoverStatus(SEP).state).toBe('changed_after_close');
  });

  it('G7 Revision älterer Fassung (1, ohne Zahlungen im Manifest): der Sperrgrund des Zahlungsmonats wird trotzdem erkannt', () => {
    setExpenseStoreForTests([altbestand(), septemberBeleg()]);
    setAccountingStoreForTests([kontierung(SEPBELEG)]);
    ruhe();
    const manifest1 = buildPeriodManifest(buildMonatsmappeModel(collectMonatsmappeInput(SEP)), [kontierung(SEPBELEG)], 'SKR03', 1);
    expect(manifest1.payments).toBeUndefined();
    const alt: AccountingPeriodClosure = {
      id: 'closure-ag-v1', monthKey: SEP, revision: 1, closedAt: '2026-09-25T10:00:00.000Z',
      fingerprint: buildPeriodFingerprint(manifest1), manifest: manifest1,
      createdAt: '2026-09-25T10:00:00.000Z', updatedAt: '2026-09-25T10:00:00.000Z',
    };
    setAccountingPeriodStoreForTests([alt]);
    expect(getAccountingPeriodState(SEP).readiness).toBe('closed');
    const json = JSON.stringify(septemberRevisionen());

    altbestandWiederOffen();
    const zustand = getAccountingPeriodState(SEP);
    // Geprüft wird die Revision nach ihrer Fassung (Fingerprint gleich) — die Sperrgründe nach den heutigen Regeln.
    expect(zustand.currentFingerprint).toBe(alt.fingerprint);
    expect(codes(zustand.blockers)).toEqual(['tax_split_open_payment']);
    expect(zustand.readiness).toBe('recheck_required');
    expect(zustand.isCurrentClosureValid).toBe(false);
    expect(evaluateAccountingExportReadiness(SEP).packageAllowed).toBe(false);
    expect(JSON.stringify(septemberRevisionen())).toBe(json);
  });

  it('G7b Revision der Fassung 1 („historisch“): auch die ausdrücklich lokale Übergabe bleibt bei offenem Steuerfall im Zahlungsmonat gesperrt', async () => {
    setExpenseStoreForTests([altbestand(), septemberBeleg()]);
    setAccountingStoreForTests([kontierung(SEPBELEG)]);
    ruhe();
    const manifest1 = buildPeriodManifest(buildMonatsmappeModel(collectMonatsmappeInput(SEP)), [kontierung(SEPBELEG)], 'SKR03', 1);
    setAccountingPeriodStoreForTests([
      {
        id: 'closure-ag-v1-lokal', monthKey: SEP, revision: 1, closedAt: '2026-09-25T10:00:00.000Z',
        fingerprint: buildPeriodFingerprint(manifest1), manifest: manifest1,
        createdAt: '2026-09-25T10:00:00.000Z', updatedAt: '2026-09-25T10:00:00.000Z',
      },
    ]);
    // Ohne Sperrgrund: reguläres Paket nicht (nie serverzertifiziert), lokale Übergabe ja — wie bisher.
    const vorher = evaluateAccountingExportReadiness(SEP);
    expect([vorher.closureStatus, vorher.packageAllowed, vorher.localHandoverAllowed]).toEqual(['historisch', false, true]);
    const json = JSON.stringify(septemberRevisionen());

    altbestandWiederOffen();
    // Zuerst der echte Exportlauf (die Gegenprobe gegen die Vorher-Fassung zeigt so, ob ein Paket entstand), dann das Gate.
    const { result, blob } = await buildAccountingExport({ monthKey: SEP, userId: undefined, skipGate: true, loaders, handover: 'lokal' });
    expect(result.outcome).toBe('blocked');
    expect(blob).toBeUndefined();
    expect(evaluateAccountingExportReadiness(SEP).localHandoverAllowed).toBe(false);
    expect(JSON.stringify(septemberRevisionen())).toBe(json);
  });

  it('G8a weiterer Sperrgrund mit gleichem Fingerprint: eine vom Server noch nicht bestätigte Änderung', () => {
    const { revision, json } = septemberAbgeschlossen();
    // Eine Änderung am Septemberbeleg, die der Server noch nicht bestätigt hat (Titel: nicht im Fingerprint).
    expect(updateExpense(SEPBELEG, { title: 'AG September umbenannt' }).success).toBe(true);
    persistAll();
    const ausstehend = getAccountingPeriodState(SEP);
    expect(ausstehend.currentFingerprint).toBe(revision.fingerprint);
    expect(codes(ausstehend.blockers)).toEqual(['unconfirmed_financial_changes']);
    expect([ausstehend.readiness, ausstehend.isCurrentClosureValid]).toEqual(['recheck_required', false]);
    expect(codes(evaluateAccountingExportReadiness(SEP).packageBlockers)).toEqual(['closure_recheck_required', 'period_blockers']);
    bestaetigt();
    expect(getAccountingPeriodState(SEP).readiness).toBe('closed');
    expect(JSON.stringify(septemberRevisionen())).toBe(json);
  });

  it('G8b weiterer Sperrgrund mit gleichem Fingerprint: offene Aufteilung im Monat einer Revision der Fassung 5 (fremder Schreibweg)', () => {
    // Fassung 5 bindet die Aufteilungsart nicht; ein Altbestand des Monats wird von außen auf „offen“ gesetzt (gleiche Beträge).
    const monatsAltbestand: Expense = { ...septemberBeleg(), taxSplit: undefined, netAmount: 119, taxAmount: 0 };
    setExpenseStoreForTests([monatsAltbestand]);
    setAccountingStoreForTests([kontierung(SEPBELEG)]);
    ruhe();
    expect(resolveExpenseTaxSplitState(getExpenseFromStoreById(SEPBELEG)!)).toBe('altbestand_pruefen');
    const manifest5 = buildPeriodManifest(buildMonatsmappeModel(collectMonatsmappeInput(SEP)), [kontierung(SEPBELEG)], 'SKR03', 5);
    const alt: AccountingPeriodClosure = {
      id: 'closure-ag-v5', monthKey: SEP, revision: 1, closedAt: '2026-09-25T10:00:00.000Z',
      fingerprint: buildPeriodFingerprint(manifest5), manifest: manifest5,
      createdAt: '2026-09-25T10:00:00.000Z', updatedAt: '2026-09-25T10:00:00.000Z',
    };
    setAccountingPeriodStoreForTests([alt]);
    expect(getAccountingPeriodState(SEP).readiness).toBe('closed');
    const json = JSON.stringify(septemberRevisionen());

    setExpenseStoreForTests([{ ...monatsAltbestand, taxSplit: 'offen' }]);
    const fremd = getAccountingPeriodState(SEP);
    expect(fremd.currentFingerprint).toBe(alt.fingerprint);
    expect(codes(fremd.blockers)).toEqual(['tax_split_open']);
    expect(fremd.readiness).toBe('recheck_required');
    expect(fremd.isCurrentClosureValid).toBe(false);
    expect(evaluateAccountingExportReadiness(SEP).packageAllowed).toBe(false);
    expect(JSON.stringify(septemberRevisionen())).toBe(json);
  });

  it('G9 reine Ableitung: buildAccountingPeriodState ändert keine Revision und keinen Bestand', () => {
    const { json } = septemberAbgeschlossen();
    altbestandWiederOffen();
    const model = buildMonatsmappeModel(collectMonatsmappeInput(SEP));
    const einmal = buildAccountingPeriodState(model);
    const zweimal = buildAccountingPeriodState(model);
    expect(zweimal.readiness).toBe(einmal.readiness);
    expect(JSON.stringify(septemberRevisionen())).toBe(json);
  });
});

/* ================================================================== */

describe('GU — Anzeige in der Oberfläche', () => {
  it('GU1 Abschlussbereich: „Erneute Prüfung erforderlich“ mit konkretem Grund — kein uneingeschränkt gültiger Abschluss', async () => {
    septemberAbgeschlossen();
    altbestandWiederOffen();
    await zeige(
      <AccountingPeriodPanel state={getAccountingPeriodState(SEP)} monthLabel="September 2026" onChanged={() => {}} translate={translate} />,
    );
    expect(wert('accounting-period-state')).toBe('Erneute Prüfung erforderlich');
    expect(wert('accounting-period-revision')).toBe('1');
    const hinweis = wert('accounting-period-recheck');
    expect(hinweis).toContain('Revision 1');
    expect(hinweis).toContain('Zahlungen auf Belege mit offener Steuerprüfung (anderer Monat): 1');
    expect(wert('accounting-period-blocker-tax_split_open_payment')).toContain('offener Steuerprüfung');
    expect(q('accounting-period-closed-hint')).toBeNull();
    expect(q('accounting-period-changed')).toBeNull();
    expect(q('accounting-period-close')).toBeNull();
    expect(q('accounting-period-reopen')).not.toBeNull();
    expect(container.textContent).not.toMatch(/accountingPeriod\.|recheck_required|tax_split_open_payment/);
  });

  it('GU2 nach gültiger Klärung: wieder „Abgeschlossen“ mit dem bisherigen Hinweis, kein Prüfhinweis', async () => {
    septemberAbgeschlossen();
    altbestandWiederOffen();
    expect(updateExpense(ALT, { taxSplit: 'belegt', netAmount: 100, taxAmount: 19 }).success).toBe(true);
    ruhe();
    await zeige(
      <AccountingPeriodPanel state={getAccountingPeriodState(SEP)} monthLabel="September 2026" onChanged={() => {}} translate={translate} />,
    );
    expect(wert('accounting-period-state')).toBe('Abgeschlossen');
    expect(q('accounting-period-closed-hint')).not.toBeNull();
    expect(q('accounting-period-recheck')).toBeNull();
    expect(q('accounting-period-blockers')).toBeNull();
  });

  it('GU3 Übergabe- und Exportbereich: Revision genannt, erneute Prüfung verlangt, kein Paketknopf', async () => {
    septemberAbgeschlossen();
    altbestandWiederOffen();
    await zeige(<SteuerberaterHandoverPanel status={getSteuerberaterHandoverStatus(SEP)} translate={translate} />);
    expect(q('steuerberater-handover')?.getAttribute('data-state')).toBe('recheck_required');
    expect(wert('steuerberater-handover-closure')).toBe('Abgeschlossen (Revision 1) – erneute Prüfung erforderlich');
    expect(wert('steuerberater-handover-state')).toContain('Erneute Prüfung erforderlich');

    await zeige(
      <AccountingExportPanel readiness={evaluateAccountingExportReadiness(SEP)} onCreatePackage={async () => 'x.zip'} translate={translate} />,
    );
    expect(q('accounting-export-blocker-closure_recheck_required')).not.toBeNull();
    expect(q('accounting-export-blocker-changed_after_close')).toBeNull();
    expect(q('accounting-export-package-hint')).toBeNull();
    expect(container.textContent).not.toMatch(/accountingExport\.|closure_recheck_required/);
  });

  it('GU4 Texte in de, tr und bg vorhanden, mit gleichen Platzhaltern', () => {
    const schluessel = [
      'accountingPeriod.state.recheck_required',
      'accountingPeriod.recheckHint',
      'accountingExport.blocker.closure_recheck_required',
      'handover.state.recheck_required',
      'handover.closure.recheck',
    ];
    const platzhalter = (text: string) => [...text.matchAll(/\{[a-z]+\}/g)].map((m) => m[0]).sort();
    for (const key of schluessel) {
      const d = (de as Record<string, string>)[key];
      expect(d, `de ${key}`).toBeTruthy();
      for (const [sprache, katalog] of [['tr', tr], ['bg', bg]] as const) {
        const text = (katalog as Partial<Record<string, string>>)[key];
        expect(text, `${sprache} ${key}`).toBeTruthy();
        expect(text, `${sprache} ${key}`).not.toBe(d);
        expect(platzhalter(text!), `${sprache} ${key}`).toEqual(platzhalter(d));
      }
    }
  });
});
