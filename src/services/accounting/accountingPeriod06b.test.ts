/**
 * STEUERBERATER-06B — Monatsabschluss, Fingerprint und Wiederöffnung.
 *
 * Die zentrale Zusage, um die es geht: **Ein Abschluss behauptet nie mehr, als
 * er weiss.** Abschnitt AA prüft das aus mehreren Richtungen — ändert sich
 * etwas steuerlich Relevantes, kippt der Stand auf „seit Abschluss geändert",
 * und zwar ohne dass jemand daran denken muss.
 *
 * Abschnitt X prüft die Gegenseite, die genauso wichtig ist: Eine blosse
 * Umsortierung darf **keinen** Alarm auslösen. Ein Fingerprint, der bei jedem
 * Nichts anschlägt, wird ignoriert — und dann auch dann, wenn er recht hat.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildPeriodCanonicalText,
  buildPeriodFingerprint,
  buildPeriodManifest,
} from './accountingPeriodFingerprint';
import {
  buildAccountingPeriodState,
  closeAccountingPeriod,
  collectPeriodBlockers,
  getAccountingPeriodState,
  reopenAccountingPeriod,
} from './accountingPeriodService';
import {
  getActiveClosureForMonth,
  getClosuresForMonth,
  setAccountingPeriodStoreForTests,
} from './accountingPeriodStore';
import { setAccountingStoreForTests } from './accountingStore';
import { setExpenseStoreForTests } from '../expenseStore';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import { normalizeExpense } from '../expenseNormalize';
import { resetTestStores } from '../../test/resetStores';
import type { AccountingAssignment } from '../../types/accounting';
import type { AccountingPeriodClosure } from '../../types/accountingPeriod';
import type { Expense } from '../../types/expense';
import type { MonatsmappeBeleg, MonatsmappeModel } from '../steuerberater/monatsmappeModelService';

/* ------------------------------------------------------------------ */

const MONTH = '2026-09';

function beleg(overrides: Partial<MonatsmappeBeleg> = {}): MonatsmappeBeleg {
  return {
    belegart: 'eingangsbeleg',
    id: 'exp-1',
    belegnummer: 'RE-1',
    datum: '2026-09-05',
    gegenpartei: 'Baustoff Süd GmbH',
    netto: 100,
    steuer: 19,
    brutto: 119,
    status: 'aktiv',
    zahlungsstatus: 'offen',
    zahlungssumme: 0,
    documentStatus: 'archived',
    documents: [],
    ...overrides,
  };
}

function model(overrides: Partial<MonatsmappeModel> = {}): MonatsmappeModel {
  return {
    monthKey: MONTH,
    ausgangsrechnungen: [],
    eingangsbelege: [],
    zahlungenAusgang: [],
    zahlungenEingang: [],
    stornos: [],
    fehlendeDokumente: [],
    stornosOhneDatum: [],
    isEmpty: false,
    ...overrides,
  };
}

function kontierung(overrides: Partial<AccountingAssignment> = {}): AccountingAssignment {
  return {
    id: 'k1',
    sourceType: 'expense',
    sourceId: 'exp-1',
    chartOfAccounts: 'SKR03',
    accountNumber: '4930',
    accountLabel: 'Bürobedarf',
    taxTreatment: 'standard_19',
    bookingText: 'Baustoff Süd GmbH · RE-1',
    status: 'confirmed',
    origin: 'manual',
    confirmedAt: '2026-09-24T10:00:00.000Z',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-1',
    title: '06B',
    issueDate: '2026-09-05',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    ...overrides,
  } as Expense);
}

/** Ein bereiter Monat: ein Beleg, bestätigt kontiert. */
function bereiterMonat() {
  return {
    model: model({ eingangsbelege: [beleg()] }),
    assignments: [kontierung()],
  };
}

function zustand(
  input = bereiterMonat(),
  closures: readonly AccountingPeriodClosure[] = [],
) {
  return buildAccountingPeriodState(input.model, input.assignments, 'SKR03', closures);
}

beforeEach(() => {
  resetTestStores();
  setAccountingStoreForTests([]);
  setAccountingPeriodStoreForTests([]);
  setExpenseStoreForTests([ausgabe()]);
  hydrateWorkspaceStore({
    workspaceSettings: {
      workspaceId: '00000000-0000-0000-0000-0000000b0001',
      settings: { chartOfAccounts: 'SKR03' },
      version: 1,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
  });
});

/* ================================================================== */
/* W — Bereitschaft                                                   */
/* ================================================================== */

describe('W — Bereitschaft', () => {
  it('W1/W2: ein Beleg ohne Kontierung blockiert', () => {
    const state = zustand({ model: model({ eingangsbelege: [beleg()] }), assignments: [] });
    expect(state.readiness).toBe('not_ready');
    expect(state.blockers.map((b) => b.code)).toContain('unassigned_documents');
    expect(state.blockers[0].count).toBe(1);
    expect(state.blockers[0].sourceIds).toEqual(['exp-1']);
  });

  it('W3: „zu prüfen“ blockiert', () => {
    const state = zustand({
      model: model({ eingangsbelege: [beleg()] }),
      assignments: [kontierung({ status: 'needs_review', confirmedAt: undefined })],
    });
    expect(state.readiness).toBe('not_ready');
    expect(state.blockers.map((b) => b.code)).toContain('needs_review');
  });

  it('W4: „Klärung nötig“ blockiert', () => {
    const state = zustand({
      model: model({ eingangsbelege: [beleg()] }),
      assignments: [kontierung({ status: 'needs_clarification', confirmedAt: undefined })],
    });
    expect(state.readiness).toBe('not_ready');
    expect(state.blockers.map((b) => b.code)).toContain('needs_clarification');
  });

  it('W5: vollständig bestätigt ist bereit', () => {
    const state = zustand();
    expect(state.readiness).toBe('ready');
    expect(state.blockers).toHaveLength(0);
  });

  /*
   * W6 — eine bestätigte Kontierung ohne Sachkonto sollte es nicht geben
   * (Dienst und Server weisen sie ab). Ein Altbestand könnte sie trotzdem
   * enthalten, und der Abschluss darf nicht darüber hinweggehen.
   */
  it('W6: bestätigt ohne Sachkonto blockiert trotzdem', () => {
    const state = zustand({
      model: model({ eingangsbelege: [beleg()] }),
      assignments: [kontierung({ accountNumber: '  ' })],
    });
    expect(state.readiness).toBe('not_ready');
    expect(state.blockers.map((b) => b.code)).toContain('confirmed_without_account');
  });

  /* W7 — die Geldintegrität aus 05B. */
  it('W7: ein widersprüchlicher Betrag blockiert', () => {
    // netto 59,25 + steuer 11,26 ergibt nicht 42,10 — der Altbestandsfall aus 05B.
    setExpenseStoreForTests([
      ausgabe({ netAmount: 59.25, taxAmount: 11.26, grossAmount: 42.1 }),
    ]);
    const state = zustand();
    expect(state.readiness).toBe('not_ready');
    expect(state.blockers.map((b) => b.code)).toContain('money_integrity');
  });

  /*
   * W7b — aber nur für Belege **dieses** Monats. Ein widersprüchlicher Beleg
   * aus dem Vorjahr darf den September nicht blockieren.
   */
  it('W7b: ein widersprüchlicher Beleg eines anderen Monats blockiert nicht', () => {
    setExpenseStoreForTests([
      ausgabe(),
      ausgabe({ id: 'exp-alt', netAmount: 59.25, taxAmount: 11.26, grossAmount: 42.1 }),
    ]);
    const state = zustand();
    expect(state.blockers.map((b) => b.code)).not.toContain('money_integrity');
    expect(state.readiness).toBe('ready');
  });

  /* W8/W9 — Storno und Gutschrift gehören dazu und müssen kontiert sein. */
  it('W8/W9: Storno und Gutschrift zählen mit und brauchen eine Kontierung', () => {
    const state = zustand({
      model: model({
        eingangsbelege: [beleg({ id: 'exp-credit', belegnummer: 'GS-1', brutto: -119 })],
        stornos: [beleg({ belegart: 'rechnungsstorno', id: 'inv-s', belegnummer: '2026-1', status: 'storno' })],
      }),
      assignments: [],
    });
    expect(state.currentManifest.documentCount).toBe(2);
    expect(state.blockers.find((b) => b.code === 'unassigned_documents')!.count).toBe(2);
  });

  /*
   * Die Gegenprobe zu einer Entscheidung, die beim Bauen fiel: Die Monatsmappe
   * fuehrt fehlende Originaldokumente und Stornos ohne Stornodatum
   * ausdruecklich als „sichtbar, nie still" — sie zeigt sie an und blockiert
   * den Export nicht. Daraus hier einen Blocker zu machen waere strenger als
   * das Produkt, und ein fehlendes Stornodatum kann der Nutzer nicht
   * nachtragen. Ein Blocker, den niemand loesen kann, ist eine Sackgasse.
   */
  it('fehlende Dokumente und Stornos ohne Datum blockieren nicht', () => {
    const state = zustand({
      model: model({
        eingangsbelege: [beleg()],
        fehlendeDokumente: [{ belegart: 'eingangsbeleg', id: 'exp-1', belegnummer: 'RE-1' }],
        stornosOhneDatum: [{ belegart: 'ausgabenstorno', id: 'exp-2', belegnummer: 'RE-2' }],
      }),
      assignments: [kontierung()],
    });
    expect(state.blockers).toHaveLength(0);
    expect(state.readiness).toBe('ready');
  });

  /*
   * W10 — ein leerer Monat. Er ist nicht „bereit" (es gibt nichts zu prüfen),
   * aber auch nicht blockiert: Betriebsferien sind ein legitimer Monat und
   * müssen abschliessbar bleiben.
   */
  it('W10: ein Monat ohne Belege ist offen, aber nicht blockiert', () => {
    const state = zustand({ model: model({ isEmpty: true }), assignments: [] });
    expect(state.readiness).toBe('open');
    expect(state.blockers).toHaveLength(0);
    expect(state.currentManifest.documentCount).toBe(0);
  });
});

/* ================================================================== */
/* X — Fingerprint                                                    */
/* ================================================================== */

describe('X — Fingerprint', () => {
  const fp = (input = bereiterMonat(), chart = 'SKR03') =>
    buildPeriodFingerprint(buildPeriodManifest(input.model, input.assignments, chart));

  it('X1: identische Daten ergeben denselben Fingerprint', () => {
    expect(fp()).toBe(fp());
  });

  /*
   * X2 — der wichtigste Test dieses Abschnitts. Eine blosse Umsortierung darf
   * keinen Alarm auslösen; sonst wird der Alarm irgendwann ignoriert.
   */
  it('X2: eine geänderte Reihenfolge ergibt denselben Fingerprint', () => {
    const a = beleg({ id: 'exp-a', belegnummer: 'RE-A' });
    const b = beleg({ id: 'exp-b', belegnummer: 'RE-B' });
    const vorwaerts = fp({ model: model({ eingangsbelege: [a, b] }), assignments: [] });
    const rueckwaerts = fp({ model: model({ eingangsbelege: [b, a] }), assignments: [] });
    expect(rueckwaerts).toBe(vorwaerts);
  });

  it('X3: ein geänderter Betrag ergibt einen anderen Fingerprint', () => {
    expect(fp({ model: model({ eingangsbelege: [beleg({ brutto: 120 })] }), assignments: [kontierung()] }))
      .not.toBe(fp());
  });

  it('X4: eine geänderte Steuerbehandlung ergibt einen anderen Fingerprint', () => {
    expect(fp({ ...bereiterMonat(), assignments: [kontierung({ taxTreatment: 'standard_7' })] }))
      .not.toBe(fp());
  });

  it('X5: ein geändertes Konto ergibt einen anderen Fingerprint', () => {
    expect(fp({ ...bereiterMonat(), assignments: [kontierung({ accountNumber: '4980' })] }))
      .not.toBe(fp());
  });

  it('X6: ein geänderter Buchungstext ergibt einen anderen Fingerprint', () => {
    expect(fp({ ...bereiterMonat(), assignments: [kontierung({ bookingText: 'Anders' })] }))
      .not.toBe(fp());
  });

  it('X7: ein geänderter Kontierungsstand ergibt einen anderen Fingerprint', () => {
    expect(
      fp({ ...bereiterMonat(), assignments: [kontierung({ status: 'needs_review', confirmedAt: undefined })] }),
    ).not.toBe(fp());
  });

  it('X8: ein zusätzlicher Beleg ergibt einen anderen Fingerprint', () => {
    expect(
      fp({
        model: model({ eingangsbelege: [beleg(), beleg({ id: 'exp-2', belegnummer: 'RE-2' })] }),
        assignments: [kontierung()],
      }),
    ).not.toBe(fp());
  });

  it('ein geänderter Stornozustand ergibt einen anderen Fingerprint', () => {
    expect(
      fp({ model: model({ eingangsbelege: [beleg({ status: 'storniert' })] }), assignments: [kontierung()] }),
    ).not.toBe(fp());
  });

  /*
   * X9 — was **nicht** hineingehört. Weder ein Zeitstempel noch eine
   * Bestätigungsspur verändern die Buchung; sie würden nur falschen Alarm
   * erzeugen.
   */
  it('X9: Zeitstempel und Bestätigungsspur verändern den Fingerprint nicht', () => {
    expect(
      fp({
        ...bereiterMonat(),
        assignments: [
          kontierung({
            updatedAt: '2099-01-01T00:00:00.000Z',
            confirmedAt: '2099-01-01T00:00:00.000Z',
            confirmedBy: 'jemand-anders',
            origin: 'suggested',
            suggestionReason: 'egal',
            accountLabel: 'Bürobedarf',
          }),
        ],
      }),
    ).toBe(fp());
  });

  it('ein anderer Kontenrahmen ergibt einen anderen Fingerprint', () => {
    expect(fp(bereiterMonat(), 'SKR04')).not.toBe(fp(bereiterMonat(), 'SKR03'));
  });

  it('der kanonische Text nennt die Belege in stabiler Reihenfolge', () => {
    const text = buildPeriodCanonicalText(
      buildPeriodManifest(
        model({
          eingangsbelege: [beleg({ id: 'exp-b' }), beleg({ id: 'exp-a' })],
          ausgangsrechnungen: [beleg({ belegart: 'ausgangsrechnung', id: 'inv-1' })],
        }),
        [],
        'SKR03',
      ),
    );
    const zeilen = text.split('\n').slice(1).map((row) => row.split('\u0001')[1]);
    expect(zeilen).toEqual(['exp-a', 'exp-b', 'inv-1']);
  });
});

/* ================================================================== */
/* Y — abschliessen                                                   */
/* ================================================================== */

describe('Y — Abschluss', () => {
  /*
   * Diese Gruppe geht über die echten Speicher, weil `closeAccountingPeriod`
   * den Monat selbst zusammenstellt. Der Bestand wird über den Ausgabenspeicher
   * gesetzt; die Monatsmappe leitet daraus denselben September ab.
   */
  function seedMonat(expense: Expense = ausgabe(), assignment = kontierung()): void {
    setExpenseStoreForTests([expense]);
    setAccountingStoreForTests([assignment]);
  }

  it('Y1: ein nicht bereiter Monat lässt sich nicht abschliessen', () => {
    seedMonat(ausgabe(), kontierung({ status: 'needs_review', confirmedAt: undefined }));
    const result = closeAccountingPeriod(MONTH);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('accountingPeriod.notReady');
    expect(result.blockers?.map((b) => b.code)).toContain('needs_review');
    expect(getClosuresForMonth(MONTH)).toHaveLength(0);
  });

  it('Y2–Y6: ein bereiter Monat wird als Revision 1 abgeschlossen', () => {
    seedMonat();
    const state = getAccountingPeriodState(MONTH);
    expect(state.readiness).toBe('ready');

    const result = closeAccountingPeriod(MONTH, { closedBy: 'user-1' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.closure.revision).toBe(1);
    expect(result.closure.closedAt).toBeTruthy();
    expect(result.closure.closedBy).toBe('user-1');
    expect(result.closure.fingerprint).toBe(state.currentFingerprint);
    expect(result.closure.manifest.documentCount).toBe(state.currentManifest.documentCount);
    expect(result.closure.manifest.entries.length).toBeGreaterThan(0);
  });

  /* Y7 — derselbe Abschluss noch einmal erzeugt kein Duplikat. */
  it('Y7: ein zweiter identischer Abschluss erzeugt keine zweite Revision', () => {
    seedMonat();
    closeAccountingPeriod(MONTH);
    const zweiter = closeAccountingPeriod(MONTH);

    expect(zweiter.success).toBe(true);
    if (!zweiter.success) return;
    expect(zweiter.noop).toBe(true);
    expect(getClosuresForMonth(MONTH)).toHaveLength(1);
  });

  /*
   * Y8 — ein **anderer** Stand auf einen offenen Abschluss wäre ein stilles
   * Überschreiben. Dafür muss der Monat erst bewusst wieder geöffnet werden.
   */
  it('Y8: ein geänderter Stand überschreibt den offenen Abschluss nicht', () => {
    seedMonat();
    closeAccountingPeriod(MONTH);
    setAccountingStoreForTests([kontierung({ accountNumber: '4980' })]);

    const result = closeAccountingPeriod(MONTH);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('accountingPeriod.alreadyClosed');
    expect(getClosuresForMonth(MONTH)).toHaveLength(1);
    // Und die offene Revision traegt weiterhin den alten Stand.
    expect(getActiveClosureForMonth(MONTH)!.manifest.entries[0].accountNumber).toBe('4930');
  });

  it('Y10: der Abschluss übersteht ein erneutes Hydrieren', () => {
    seedMonat();
    const result = closeAccountingPeriod(MONTH);
    if (!result.success) return;

    // Wie nach einem Reload aus dem persistierten Zustand.
    setAccountingPeriodStoreForTests([result.closure]);
    const state = getAccountingPeriodState(MONTH);
    expect(state.readiness).toBe('closed');
    expect(state.activeClosure?.revision).toBe(1);
    expect(state.isCurrentClosureValid).toBe(true);
  });

  /* S — ein leerer Monat lässt sich abschliessen. */
  it('ein leerer Monat lässt sich abschliessen', () => {
    setExpenseStoreForTests([]);
    setAccountingStoreForTests([]);
    const result = closeAccountingPeriod('2026-01');
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.closure.manifest.documentCount).toBe(0);
  });
});

/* ================================================================== */
/* Z — wieder öffnen                                                  */
/* ================================================================== */

describe('Z — Wiederöffnen', () => {
  function seedUndClose() {
    setExpenseStoreForTests([ausgabe()]);
    setAccountingStoreForTests([kontierung()]);
    const result = closeAccountingPeriod(MONTH, { closedBy: 'user-1' });
    if (!result.success) throw new Error('Vorbedingung: Abschluss fehlgeschlagen');
    return result.closure;
  }

  it('Z1/Z2: ein abgeschlossener Monat lässt sich mit Spur wieder öffnen', () => {
    seedUndClose();
    const result = reopenAccountingPeriod(MONTH, { reopenedBy: 'user-2', reason: 'Beleg nachgereicht' });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.closure.reopenedAt).toBeTruthy();
    expect(result.closure.reopenedBy).toBe('user-2');
    expect(result.closure.reopenReason).toBe('Beleg nachgereicht');
    expect(getActiveClosureForMonth(MONTH)).toBeUndefined();
  });

  /*
   * Z3/Z6 — der Kern der Revisionsregel. Revision 1 behält Fingerprint,
   * Manifest, Abschlusszeitpunkt und Nummer. Eine alte Revision umzuschreiben
   * hiesse, den Nachweis zu fälschen.
   */
  it('Z3–Z6: ein erneuter Abschluss ergibt Revision 2, Revision 1 bleibt unverändert', () => {
    const erste = seedUndClose();
    reopenAccountingPeriod(MONTH, { reason: 'Korrektur' });

    // Z4 — nach dem Öffnen ist eine Änderung möglich.
    setAccountingStoreForTests([kontierung({ accountNumber: '4980' })]);

    const zweite = closeAccountingPeriod(MONTH, { closedBy: 'user-3' });
    expect(zweite.success).toBe(true);
    if (!zweite.success) return;
    expect(zweite.closure.revision).toBe(2);
    expect(zweite.closure.fingerprint).not.toBe(erste.fingerprint);

    const historie = getClosuresForMonth(MONTH);
    expect(historie).toHaveLength(2);
    const revision1 = historie.find((item) => item.revision === 1)!;
    expect(revision1.fingerprint).toBe(erste.fingerprint);
    expect(revision1.closedAt).toBe(erste.closedAt);
    expect(revision1.manifest.entries[0].accountNumber).toBe('4930');
    expect(revision1.reopenedAt).toBeTruthy();
  });

  it('ein nicht abgeschlossener Monat lässt sich nicht öffnen', () => {
    const result = reopenAccountingPeriod(MONTH);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('accountingPeriod.notClosed');
  });
});

/* ================================================================== */
/* AA — seit Abschluss geändert                                       */
/* ================================================================== */

describe('AA — seit Abschluss geändert', () => {
  function abgeschlossen(): AccountingPeriodClosure {
    setExpenseStoreForTests([ausgabe()]);
    setAccountingStoreForTests([kontierung()]);
    const result = closeAccountingPeriod(MONTH);
    if (!result.success) throw new Error('Vorbedingung: Abschluss fehlgeschlagen');
    return result.closure;
  }

  it('AA1: ohne Änderung bleibt der Abschluss aktuell', () => {
    abgeschlossen();
    const state = getAccountingPeriodState(MONTH);
    expect(state.readiness).toBe('closed');
    expect(state.isCurrentClosureValid).toBe(true);
  });

  it('AA2: eine geänderte Kontierung macht den Abschluss veraltet', () => {
    abgeschlossen();
    setAccountingStoreForTests([kontierung({ bookingText: 'Nachträglich anders' })]);

    const state = getAccountingPeriodState(MONTH);
    expect(state.readiness).toBe('changed_after_close');
    expect(state.isCurrentClosureValid).toBe(false);
    // Der Abschluss selbst bleibt erhalten — er war zu seiner Zeit richtig.
    expect(state.activeClosure).not.toBeNull();
    expect(state.activeClosure!.manifest.entries[0].bookingText).toBe('Baustoff Süd GmbH · RE-1');
  });

  it('AA2b: ein geändertes Konto ebenso', () => {
    abgeschlossen();
    setAccountingStoreForTests([kontierung({ accountNumber: '4980' })]);
    expect(getAccountingPeriodState(MONTH).readiness).toBe('changed_after_close');
  });

  it('AA3: ein neuer relevanter Beleg macht den Abschluss veraltet', () => {
    abgeschlossen();
    setExpenseStoreForTests([
      ausgabe(),
      ausgabe({ id: 'exp-neu', invoiceNumber: 'RE-NEU', issueDate: '2026-09-20' }),
    ]);
    expect(getAccountingPeriodState(MONTH).readiness).toBe('changed_after_close');
  });

  it('AA4: ein Storno macht den Abschluss veraltet', () => {
    abgeschlossen();
    setExpenseStoreForTests([
      ausgabe({ status: 'storniert', cancelledAt: '2026-09-28T10:00:00.000Z' }),
    ]);
    expect(getAccountingPeriodState(MONTH).readiness).toBe('changed_after_close');
  });

  /*
   * AA — die Gegenprobe. Eine Ansichtseinstellung ist keine steuerlich
   * relevante Änderung und darf den Abschluss nicht entwerten.
   */
  it('AA7: eine irrelevante Einstellung lässt den Abschluss aktuell', () => {
    abgeschlossen();
    hydrateWorkspaceStore({
      workspaceSettings: {
        workspaceId: '00000000-0000-0000-0000-0000000b0001',
        settings: { chartOfAccounts: 'SKR03', sortPreference: 'datum-absteigend', lastTab: 'belege' },
        version: 2,
        updatedAt: '2026-09-30T10:00:00.000Z',
      },
    });
    expect(getAccountingPeriodState(MONTH).readiness).toBe('closed');
  });

  /* AA5 — für 06C erkennbar, AA6 — ein erneuter Abschluss stellt es wieder her. */
  it('AA5/AA6: 06C erkennt den Zustand, ein neuer Abschluss stellt ihn wieder her', () => {
    abgeschlossen();
    setAccountingStoreForTests([kontierung({ accountNumber: '4980' })]);

    const veraltet = getAccountingPeriodState(MONTH);
    expect(veraltet.isCurrentClosureValid).toBe(false);
    expect(veraltet.activeClosure).not.toBeNull();

    reopenAccountingPeriod(MONTH, { reason: 'Konto korrigiert' });
    const erneut = closeAccountingPeriod(MONTH);
    expect(erneut.success).toBe(true);

    const danach = getAccountingPeriodState(MONTH);
    expect(danach.readiness).toBe('closed');
    expect(danach.isCurrentClosureValid).toBe(true);
    expect(danach.activeClosure!.revision).toBe(2);
    expect(danach.revisionHistory).toHaveLength(2);
  });
});

/* ================================================================== */
/* U — die API für 06C                                                */
/* ================================================================== */

describe('U — die API für den DATEV-Block', () => {
  it('der Zustand trägt alles, was 06C zum Entscheiden braucht', () => {
    const state = zustand();
    expect(state).toMatchObject({
      monthKey: MONTH,
      readiness: 'ready',
      blockers: [],
      isCurrentClosureValid: false,
      activeClosure: null,
    });
    expect(state.currentFingerprint).toMatch(/^p1:[0-9a-f]+:\d+$/);
    expect(state.currentManifest.entries).toHaveLength(1);
    expect(Array.isArray(state.revisionHistory)).toBe(true);
  });

  it('die Blocker sind maschinenlesbar und zählbar', () => {
    const blockers = collectPeriodBlockers(
      buildPeriodManifest(model({ eingangsbelege: [beleg(), beleg({ id: 'exp-2' })] }), [], 'SKR03'),
    );
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ code: 'unassigned_documents', count: 2 });
  });
});
