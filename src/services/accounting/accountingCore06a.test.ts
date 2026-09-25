/**
 * STEUERBERATER-06A — Kontierungskern.
 *
 * Die Regel, um die es in diesem Block geht, steht in Abschnitt B und wird dort
 * aus mehreren Richtungen geprüft: **Ein Vorschlag ist keine Bestätigung.**
 * Weder beim Anlegen noch beim Speichern noch bei einem erneuten Vorschlag darf
 * `confirmed` entstehen.
 *
 * Abschnitt A prüft vorher die Grundannahme des ganzen Blocks: dass im
 * Repository kein verifizierter Kontenkatalog liegt und deshalb auch keine
 * Kontonummer erfunden wird.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CHART_OF_ACCOUNTS,
  getChartOfAccounts,
  getChosenChartOfAccounts,
  hasChosenChartOfAccounts,
  setChartOfAccounts,
} from './accountingSettingsService';
import {
  suggestExpenseAccounting,
  suggestInvoiceAccounting,
} from './accountingSuggestionService';
import {
  confirmAccountingAssignment,
  ensureExpenseAccountingAssignment,
  ensureInvoiceAccountingAssignment,
  isMaterialAccountingChange,
  markAccountingAssignmentUnclear,
  updateAccountingAssignment,
} from './accountingAssignmentService';
import {
  getAccountingAssignmentForSource,
  getAllAccountingAssignments,
  setAccountingStoreForTests,
} from './accountingStore';
import {
  buildAccountingCloudContentKey,
  buildAccountingCloudPushPayload,
  mergeAccountingFromPull,
} from './accountingCloudSyncService';
import { buildAccountingChecklist } from './accountingOverviewService';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import { normalizeExpense } from '../expenseNormalize';
import { resetTestStores } from '../../test/resetStores';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { Expense } from '../../types/expense';
import type { VorgangInvoice } from '../../types/models';
import type { AccountingAssignment, ChartOfAccounts } from '../../types/accounting';
import type { MonatsmappeBeleg, MonatsmappeModel } from '../steuerberater/monatsmappeModelService';

/* ------------------------------------------------------------------ */

const WORKSPACE_ID = '00000000-0000-0000-0000-0000000a0001';

function hydrateWorkspace(settings: Record<string, unknown> = {}): void {
  hydrateWorkspaceStore({
    workspaceSettings: {
      workspaceId: WORKSPACE_ID,
      settings,
      version: 1,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
  });
}

function ausgabe(overrides: Partial<Expense> = {}): Expense {
  return normalizeExpense({
    id: 'exp-06a',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Baustoff Süd GmbH',
    invoiceNumber: 'RE-2026-1',
    title: '06A TEST',
    issueDate: '2026-06-01',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    ...overrides,
  } as Expense);
}

function rechnung(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-06a',
    number: '2026-0500',
    type: 'rechnung',
    positions: [],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'versendet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    customerSnapshot: {
      name: 'AZ Testbau GmbH',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    },
    companySnapshot: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Muster GmbH' },
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  } as VorgangInvoice;
}

beforeEach(() => {
  resetTestStores();
  setAccountingStoreForTests([]);
  hydrateWorkspace();
});

/* ================================================================== */
/* A — keine erfundenen Konten                                        */
/* ================================================================== */

describe('A — keine erfundenen SKR-Konten', () => {
  /*
   * Die Grundannahme dieses Blocks, als Test festgehalten: Im Repository liegt
   * kein verifizierter Kontenkatalog. Solange das so ist, darf kein Vorschlag
   * eine Kontonummer nennen — eine erfundene Nummer sähe aus wie eine Auskunft
   * und wanderte über die Bestätigung in die Buchhaltung.
   */
  it('A1: kein Vorschlag nennt eine Kontonummer', () => {
    const faelle = [
      suggestExpenseAccounting({ expense: ausgabe() }),
      suggestExpenseAccounting({ expense: ausgabe({ category: 'fahrzeug', taxStatus: 'standard_7' }) }),
      suggestExpenseAccounting({ expense: ausgabe({ category: 'werkzeug' }) }),
      suggestInvoiceAccounting({ invoice: rechnung() }),
      suggestInvoiceAccounting({ invoice: rechnung({ taxStatus: 'reverse_charge_13b' }) }),
    ];
    for (const fall of faelle) {
      expect(fall.accountNumber, 'eine Kontonummer waere erfunden').toBe('');
      expect(fall.accountLabel).toBe('');
    }
  });

  it('A2: stattdessen steht eine Begründung da', () => {
    const fall = suggestExpenseAccounting({ expense: ausgabe() });
    expect(fall.reason).toBe('accounting.reason.noAccountCatalog');
    expect(fall.status).toBe('needs_review');
  });
});

/* ================================================================== */
/* X1–X3 — der Kontenrahmen des Betriebs                              */
/* ================================================================== */

describe('X1–X3 — Kontenrahmen', () => {
  it('X1/X2: SKR03 und SKR04 lassen sich betriebsweit setzen', () => {
    for (const chart of ['SKR03', 'SKR04'] as ChartOfAccounts[]) {
      const result = setChartOfAccounts(chart);
      expect(result.success).toBe(true);
      expect(getChosenChartOfAccounts()).toBe(chart);
      expect(getChartOfAccounts()).toBe(chart);
      expect(hasChosenChartOfAccounts()).toBe(true);
    }
  });

  /*
   * Ohne Wahl wird nichts gespeichert: Die Anzeige zeigt eine Vorgabe, aber
   * `hasChosenChartOfAccounts` sagt, dass niemand entschieden hat. Ein nie
   * getroffener Beschluss soll nicht wie einer aussehen.
   */
  it('X1b: ohne Wahl gibt es eine Vorgabe, aber keine Entscheidung', () => {
    expect(hasChosenChartOfAccounts()).toBe(false);
    expect(getChosenChartOfAccounts()).toBeUndefined();
    expect(getChartOfAccounts()).toBe(DEFAULT_CHART_OF_ACCOUNTS);
  });

  it('X3: nach erneutem Hydrieren steht die Einstellung noch', () => {
    setChartOfAccounts('SKR04');
    // Wie ein Reload: der Speicher wird aus dem persistierten Zustand neu befüllt.
    hydrateWorkspace({ chartOfAccounts: 'SKR04' });
    expect(getChartOfAccounts()).toBe('SKR04');
    expect(hasChosenChartOfAccounts()).toBe(true);
  });

  it('ein unbekannter Wert wird abgewiesen', () => {
    const result = setChartOfAccounts('SKR42' as ChartOfAccounts);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.errorKey).toBe('accounting.chart.invalid');
  });

  /*
   * Eine Umstellung deutet die Vergangenheit nicht um: Jede Kontierung trägt
   * den Rahmen, mit dem sie angelegt wurde.
   */
  it('eine Umstellung ändert bestehende Kontierungen nicht', () => {
    setChartOfAccounts('SKR03');
    ensureExpenseAccountingAssignment(ausgabe());
    expect(getAccountingAssignmentForSource('expense', 'exp-06a')!.chartOfAccounts).toBe('SKR03');

    setChartOfAccounts('SKR04');
    expect(getAccountingAssignmentForSource('expense', 'exp-06a')!.chartOfAccounts).toBe('SKR03');
  });
});

/* ================================================================== */
/* X4–X10 — Vorschlag, Bestätigung, Änderung                          */
/* ================================================================== */

describe('X4–X10 — Vorschlag ist keine Bestätigung', () => {
  it('X4/X5: ein Vorschlag startet als „zu prüfen“, nie als bestätigt', () => {
    const result = ensureExpenseAccountingAssignment(ausgabe());
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.assignment.status).toBe('needs_review');
    expect(result.assignment.status).not.toBe('confirmed');
    expect(result.assignment.origin).toBe('suggested');
    expect(result.assignment.confirmedAt).toBeUndefined();
    expect(result.assignment.suggestedAt).toBeTruthy();
  });

  it('X5b: auch ein zweiter Aufruf bestätigt nichts und überschreibt nichts', () => {
    const first = ensureExpenseAccountingAssignment(ausgabe());
    if (!first.success) return;
    updateAccountingAssignment(first.assignment.id, { accountNumber: '4930' });
    confirmAccountingAssignment(first.assignment.id);

    // Erneuter „Vorschlag" — die bestätigte Zuordnung bleibt, wie sie ist.
    const second = ensureExpenseAccountingAssignment(ausgabe());
    if (!second.success) return;
    expect(second.assignment.id).toBe(first.assignment.id);
    expect(second.assignment.status).toBe('confirmed');
    expect(second.assignment.accountNumber).toBe('4930');
    expect(getAllAccountingAssignments()).toHaveLength(1);
  });

  /*
   * X6/X7 — der Kern der Confirm-first-Architektur: Speichern ist nicht
   * bestätigen. Wer ein Konto einträgt, hat gespeichert, nicht zugesagt.
   */
  it('X6/X7: Speichern bestätigt nicht — erst die ausdrückliche Aktion', () => {
    const created = ensureExpenseAccountingAssignment(ausgabe());
    if (!created.success) return;

    const saved = updateAccountingAssignment(created.assignment.id, {
      accountNumber: '4930',
      accountLabel: 'Bürobedarf',
      bookingText: 'Baustoff Süd GmbH · RE-2026-1',
    });
    expect(saved.success).toBe(true);
    if (!saved.success) return;
    expect(saved.assignment.status, 'Speichern darf nicht bestätigen').toBe('needs_review');
    expect(saved.assignment.origin).toBe('manual');
    expect(saved.assignment.confirmedAt).toBeUndefined();

    const confirmed = confirmAccountingAssignment(created.assignment.id, { confirmedBy: 'user-1' });
    expect(confirmed.success).toBe(true);
    if (!confirmed.success) return;
    expect(confirmed.assignment.status).toBe('confirmed');
    expect(confirmed.assignment.confirmedAt).toBeTruthy();
    expect(confirmed.assignment.confirmedBy).toBe('user-1');
  });

  it('X8/X9: bestätigt wird nur mit Sachkonto', () => {
    const created = ensureExpenseAccountingAssignment(ausgabe());
    if (!created.success) return;

    const ohneKonto = confirmAccountingAssignment(created.assignment.id);
    expect(ohneKonto.success).toBe(false);
    if (ohneKonto.success) return;
    expect(ohneKonto.errorKey).toBe('accounting.confirmNeedsAccount');
    // Nichts passiert — der Stand bleibt „zu prüfen".
    expect(getAccountingAssignmentForSource('expense', 'exp-06a')!.status).toBe('needs_review');

    // Auch reine Leerzeichen sind kein Konto.
    updateAccountingAssignment(created.assignment.id, { accountNumber: '   ' });
    expect(confirmAccountingAssignment(created.assignment.id).success).toBe(false);

    updateAccountingAssignment(created.assignment.id, { accountNumber: '4930' });
    expect(confirmAccountingAssignment(created.assignment.id).success).toBe(true);
  });

  /*
   * X10 — eine bestätigte Kontierung, an der sich fachlich etwas ändert,
   * verliert ihre Bestätigung. Sonst stünde „bestätigt" an etwas, das niemand
   * in dieser Form bestätigt hat.
   */
  it('X10: eine fachliche Änderung entwertet die Bestätigung', () => {
    const created = ensureExpenseAccountingAssignment(ausgabe());
    if (!created.success) return;
    updateAccountingAssignment(created.assignment.id, { accountNumber: '4930' });
    confirmAccountingAssignment(created.assignment.id, { confirmedBy: 'user-1' });

    const geaendert = updateAccountingAssignment(created.assignment.id, { accountNumber: '4980' });
    expect(geaendert.success).toBe(true);
    if (!geaendert.success) return;
    expect(geaendert.assignment.status).toBe('needs_review');
    expect(geaendert.assignment.confirmedAt, 'die alte Bestätigung gilt nicht mehr').toBeUndefined();
    expect(geaendert.assignment.confirmedBy).toBeUndefined();
  });

  it('X10b: eine Änderung ohne fachlichen Gehalt lässt die Bestätigung stehen', () => {
    const created = ensureExpenseAccountingAssignment(ausgabe());
    if (!created.success) return;
    updateAccountingAssignment(created.assignment.id, { accountNumber: '4930' });
    confirmAccountingAssignment(created.assignment.id);

    // Dieselben Werte noch einmal gespeichert — kein Anlass für eine neue Prüfung.
    const erneut = updateAccountingAssignment(created.assignment.id, { accountNumber: '4930' });
    if (!erneut.success) return;
    expect(erneut.assignment.status).toBe('confirmed');
    expect(erneut.assignment.confirmedAt).toBeTruthy();
  });

  it('welche Felder als fachliche Änderung gelten', () => {
    const basis = {
      accountNumber: '4930',
      accountLabel: 'Bürobedarf',
      taxTreatment: 'standard_19' as const,
      bookingText: 'Text',
    };
    expect(isMaterialAccountingChange(basis, basis)).toBe(false);
    expect(isMaterialAccountingChange(basis, { ...basis, accountNumber: '4980' })).toBe(true);
    expect(isMaterialAccountingChange(basis, { ...basis, accountLabel: 'Anderes' })).toBe(true);
    expect(isMaterialAccountingChange(basis, { ...basis, taxTreatment: 'standard_7' })).toBe(true);
    expect(isMaterialAccountingChange(basis, { ...basis, bookingText: 'Neu' })).toBe(true);
    // Reine Leerzeichen sind keine Änderung.
    expect(isMaterialAccountingChange(basis, { ...basis, accountNumber: ' 4930 ' })).toBe(false);
  });

  it('„Klärung nötig“ lässt sich ausdrücklich setzen', () => {
    const created = ensureExpenseAccountingAssignment(ausgabe());
    if (!created.success) return;
    updateAccountingAssignment(created.assignment.id, { accountNumber: '4930' });
    confirmAccountingAssignment(created.assignment.id);

    const unklar = markAccountingAssignmentUnclear(created.assignment.id);
    if (!unklar.success) return;
    expect(unklar.assignment.status).toBe('needs_clarification');
    expect(unklar.assignment.confirmedAt).toBeUndefined();
  });
});

/* ================================================================== */
/* X11–X19 — Belegarten und Steuerbehandlung                          */
/* ================================================================== */

describe('X11–X19 — Belege und Steuerbehandlung', () => {
  it('X11: ein Eingangsbeleg bekommt Buchungstext und Steuerbehandlung vom Beleg', () => {
    const created = ensureExpenseAccountingAssignment(ausgabe());
    if (!created.success) return;
    expect(created.assignment.sourceType).toBe('expense');
    expect(created.assignment.sourceId).toBe('exp-06a');
    expect(created.assignment.taxTreatment).toBe('standard_19');
    expect(created.assignment.bookingText).toBe('Baustoff Süd GmbH · RE-2026-1');
  });

  /*
   * X12 — die Gutschrift aus 05B. Sie bleibt negativ und wird nicht
   * umgeschrieben; kontierbar ist sie trotzdem, und zwar als Klärungsfall.
   */
  it('X12: eine Gutschrift bleibt negativ und wird zum Klärungsfall', () => {
    const gutschrift = ausgabe({
      id: 'exp-credit',
      category: 'gutschrift',
      netAmount: -100,
      taxAmount: -19,
      grossAmount: -119,
    });
    const created = ensureExpenseAccountingAssignment(gutschrift);
    if (!created.success) return;

    expect(created.assignment.status).toBe('needs_clarification');
    expect(created.assignment.suggestionReason).toBe('accounting.reason.expenseCreditNote');
    expect(created.assignment.bookingText).toContain('Gutschrift');
    // Der Beleg selbst bleibt unangetastet.
    expect(gutschrift.grossAmount).toBe(-119);
    expect(gutschrift.netAmount).toBe(-100);
  });

  it('X13: eine Ausgangsrechnung wird über Kunde und Nummer kontiert', () => {
    const created = ensureInvoiceAccountingAssignment(rechnung());
    if (!created.success) return;
    expect(created.assignment.sourceType).toBe('invoice');
    expect(created.assignment.bookingText).toBe('AZ Testbau GmbH · 2026-0500');
    expect(created.assignment.status).toBe('needs_review');
  });

  /* X14–X17 — die Steuerstatus werden unverändert übernommen, nicht neu gerechnet. */
  it.each([
    ['reverse_charge_13b'],
    ['standard_7'],
    ['standard_19'],
    ['tax_free'],
    ['kleinunternehmer_19'],
  ] as const)('X14–X17: %s wird unverändert übernommen', (status) => {
    setAccountingStoreForTests([]);
    const created = ensureExpenseAccountingAssignment(
      ausgabe({ id: `exp-${status}`, taxStatus: status }),
    );
    if (!created.success) return;
    expect(created.assignment.taxTreatment).toBe(status);
    expect(created.assignment.status).toBe('needs_review');
  });

  /*
   * X18 — `unclear` heisst „unbekannt" (05B). Daraus darf keine Sicherheit
   * entstehen: Der Beleg geht in die Klärung, nicht in die Prüfung.
   */
  it('X18: ein unklarer Steuerstatus führt zu „Klärung nötig“', () => {
    const created = ensureExpenseAccountingAssignment(
      ausgabe({ id: 'exp-unclear', taxStatus: 'unclear' }),
    );
    if (!created.success) return;
    expect(created.assignment.taxTreatment).toBe('unclear');
    expect(created.assignment.status).toBe('needs_clarification');
    expect(created.assignment.suggestionReason).toBe('accounting.reason.taxUnclear');
  });

  it('X19: eine stornierte Rechnung bleibt kontierbar und nachvollziehbar', () => {
    const storniert = rechnung({
      id: 'inv-storno',
      cancelledAt: '2026-07-01T10:00:00.000Z',
      paymentStatus: 'storniert',
    });
    const created = ensureInvoiceAccountingAssignment(storniert);
    if (!created.success) return;
    expect(created.assignment.status).toBe('needs_clarification');
    expect(created.assignment.bookingText).toContain('Storno');
    expect(created.assignment.suggestionReason).toBe('accounting.reason.invoiceCancelled');
  });

  /* Ein langer Freitext läuft nicht ungefiltert in den Buchungstext. */
  it('der Buchungstext bleibt kurz und übernimmt keine langen Freitexte', () => {
    const lang = 'A'.repeat(200);
    const created = ensureExpenseAccountingAssignment(
      ausgabe({ id: 'exp-lang', supplierName: lang, description: lang }),
    );
    if (!created.success) return;
    expect(created.assignment.bookingText.length).toBeLessThanOrEqual(130);
    expect(created.assignment.bookingText).not.toContain(lang);
  });
});

/* ================================================================== */
/* X20–X22 — Cloud, Isolation, Konflikt                               */
/* ================================================================== */

describe('X20–X22 — Cloud und Sync', () => {
  function assignment(overrides: Partial<AccountingAssignment> = {}): AccountingAssignment {
    return {
      id: 'k1',
      sourceType: 'expense',
      sourceId: 'exp-06a',
      chartOfAccounts: 'SKR03',
      accountNumber: '4930',
      accountLabel: 'Bürobedarf',
      taxTreatment: 'standard_19',
      bookingText: 'Text',
      status: 'needs_review',
      origin: 'manual',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
      ...overrides,
    };
  }

  it('X21: der Push trägt den Beleg und lässt Gerätewissen draussen', () => {
    const payload = buildAccountingCloudPushPayload(
      assignment({ sync: { version: 2 } as AccountingAssignment['sync'] }),
      false,
    ) as { payload: Record<string, unknown> };

    expect(payload).toMatchObject({
      client_assignment_id: 'k1',
      source_type: 'expense',
      source_id: 'exp-06a',
      deleted: false,
    });
    expect(payload.payload.sync, '`sync` gehört nicht in die Cloud').toBeUndefined();
    expect(payload.payload.status).toBe('needs_review');
  });

  it('der Inhaltsschlüssel erkennt eine Bestätigung als Änderung', () => {
    const vorher = buildAccountingCloudContentKey(assignment());
    const nachher = buildAccountingCloudContentKey(
      assignment({ status: 'confirmed', confirmedAt: '2026-09-24T10:00:00.000Z' }),
    );
    expect(nachher).not.toBe(vorher);
    // Ein blosser Zeitstempel ist keine Änderung.
    expect(buildAccountingCloudContentKey(assignment({ updatedAt: '2027-01-01T00:00:00.000Z' })))
      .toBe(vorher);
  });

  it('X21b: ein Pull ergänzt, aktualisiert und entfernt', () => {
    const local = [assignment()];
    const merged = mergeAccountingFromPull(local, {
      assignments: [
        {
          client_assignment_id: 'k1',
          source_type: 'expense',
          source_id: 'exp-06a',
          payload: { ...assignment({ accountNumber: '4980' }) },
          deleted: false,
          row_version: 2,
          updated_at: '2026-09-24T10:00:00.000Z',
        },
        {
          client_assignment_id: 'k2',
          source_type: 'invoice',
          source_id: 'inv-06a',
          payload: { ...assignment({ id: 'k2', sourceType: 'invoice', sourceId: 'inv-06a' }) },
          deleted: false,
          row_version: 1,
          updated_at: '2026-09-24T10:00:00.000Z',
        },
      ],
    });

    expect(merged.counts.updated).toBe(1);
    expect(merged.counts.added).toBe(1);
    expect(merged.assignments.find((a) => a.id === 'k1')!.accountNumber).toBe('4980');
  });

  /*
   * X22 — der Konfliktpfad. Eine lokal noch nicht übertragene Änderung gewinnt
   * und wird gemeldet, statt still überschrieben zu werden. Bei einer
   * Kontierung wiegt das schwer: Eine verlorene Bestätigung wäre eine
   * verlorene Zusage.
   */
  it('X22: eine noch nicht übertragene lokale Änderung wird nicht überschrieben', () => {
    const local = [assignment({ status: 'confirmed', confirmedAt: '2026-09-24T10:00:00.000Z' })];
    const merged = mergeAccountingFromPull(
      local,
      {
        assignments: [
          {
            client_assignment_id: 'k1',
            source_type: 'expense',
            source_id: 'exp-06a',
            payload: { ...assignment({ accountNumber: '9999' }) },
            deleted: false,
            row_version: 5,
            updated_at: '2026-09-24T11:00:00.000Z',
          },
        ],
      },
      new Set(['k1']),
    );

    expect(merged.conflicts).toContain('k1');
    expect(merged.counts.keptLocal).toBe(1);
    expect(merged.assignments[0].status).toBe('confirmed');
    expect(merged.assignments[0].accountNumber).toBe('4930');
  });

  it('ein Grabstein entfernt die lokale Kontierung', () => {
    const merged = mergeAccountingFromPull([assignment()], {
      assignments: [
        {
          client_assignment_id: 'k1',
          source_type: 'expense',
          source_id: 'exp-06a',
          payload: {},
          deleted: true,
          row_version: 2,
          updated_at: '2026-09-24T10:00:00.000Z',
        },
      ],
    });
    expect(merged.assignments).toHaveLength(0);
    expect(merged.counts.removed).toBe(1);
  });
});

/* ================================================================== */
/* Y — die Monatsübersicht                                            */
/* ================================================================== */

describe('Y — Monatsübersicht', () => {
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
      monthKey: '2026-09',
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
      bookingText: 'Text',
      status: 'confirmed',
      origin: 'manual',
      confirmedAt: '2026-09-24T10:00:00.000Z',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-24T10:00:00.000Z',
      ...overrides,
    };
  }

  it('Y1: ein Monat ohne relevante Belege', () => {
    const liste = buildAccountingChecklist(model({ isEmpty: true }), [], 'SKR03');
    expect(liste.totalRelevantDocuments).toBe(0);
    expect(liste.confirmedCount).toBe(0);
    expect(liste.openEntries).toHaveLength(0);
  });

  it('Y2–Y5: die Zähler stimmen', () => {
    const belege = [
      beleg({ id: 'exp-1', belegnummer: 'RE-1' }),
      beleg({ id: 'exp-2', belegnummer: 'RE-2' }),
      beleg({ id: 'exp-3', belegnummer: 'RE-3' }),
      beleg({ id: 'exp-4', belegnummer: 'RE-4' }),
    ];
    const liste = buildAccountingChecklist(
      model({ eingangsbelege: belege }),
      [
        kontierung({ id: 'k1', sourceId: 'exp-1', status: 'confirmed' }),
        kontierung({ id: 'k2', sourceId: 'exp-2', status: 'needs_review', confirmedAt: undefined }),
        kontierung({
          id: 'k3',
          sourceId: 'exp-3',
          status: 'needs_clarification',
          confirmedAt: undefined,
        }),
        // exp-4 hat gar keine Kontierung.
      ],
      'SKR03',
    );

    expect(liste.totalRelevantDocuments).toBe(4);
    expect(liste.confirmedCount).toBe(1);
    /*
     * 01H — „Noch nicht kontiert" ist ein eigener Stand und nicht mehr in
     * „zu prüfen" enthalten. Offen bleibt der Beleg trotzdem (Y6).
     */
    expect(liste.needsReviewCount).toBe(1);
    expect(liste.needsClarificationCount).toBe(1);
    expect(liste.unassignedCount).toBe(1);
  });

  /* 01H — Befund „24 zu prüfen" für 23 nicht kontierte und 1 zu prüfenden Beleg. */
  it('01H: die vier Stände sind getrennt und ergeben zusammen die relevanten Belege', () => {
    const belege = Array.from({ length: 27 }, (_, i) =>
      beleg({ id: `exp-${i + 1}`, belegnummer: `RE-${i + 1}` }),
    );
    const liste = buildAccountingChecklist(
      model({ eingangsbelege: belege }),
      [
        kontierung({ id: 'k1', sourceId: 'exp-1', status: 'needs_review', confirmedAt: undefined }),
        kontierung({ id: 'k2', sourceId: 'exp-2', status: 'needs_clarification', confirmedAt: undefined }),
        kontierung({ id: 'k3', sourceId: 'exp-3', status: 'confirmed' }),
        kontierung({ id: 'k4', sourceId: 'exp-4', status: 'confirmed' }),
        // exp-5 … exp-27: 23 Belege ohne jede Kontierung.
      ],
      'SKR03',
    );

    expect(liste.unassignedCount).toBe(23);
    expect(liste.needsReviewCount).toBe(1);
    expect(liste.needsClarificationCount).toBe(1);
    expect(liste.confirmedCount).toBe(2);
    expect(
      liste.unassignedCount + liste.needsReviewCount + liste.needsClarificationCount + liste.confirmedCount,
    ).toBe(liste.totalRelevantDocuments);
    // Offen ist weiterhin alles, was nicht bestätigt ist.
    expect(liste.openEntries).toHaveLength(25);
  });

  it('Y6: die offene Liste enthält alles, was nicht bestätigt ist', () => {
    const liste = buildAccountingChecklist(
      model({
        eingangsbelege: [beleg({ id: 'exp-1' }), beleg({ id: 'exp-2', belegnummer: 'RE-2' })],
      }),
      [kontierung({ sourceId: 'exp-1' })],
      'SKR03',
    );
    expect(liste.openEntries.map((e) => e.sourceId)).toEqual(['exp-2']);
    expect(liste.confirmedEntries.map((e) => e.sourceId)).toEqual(['exp-1']);
    expect(liste.openEntries[0].status).toBeNull();
  });

  it('Y8: der Kontenrahmen steht in der Übersicht', () => {
    expect(buildAccountingChecklist(model(), [], 'SKR04').chartOfAccounts).toBe('SKR04');
  });

  /*
   * Y9 — Storno und Gutschrift verschwinden nicht und behalten ihren Betrag,
   * auch den negativen.
   */
  it('Y9: Storno und Gutschrift bleiben in der Liste, mit ihrem Betrag', () => {
    const liste = buildAccountingChecklist(
      model({
        eingangsbelege: [
          beleg({ id: 'exp-credit', belegnummer: 'GS-1', brutto: -119, netto: -100, steuer: -19 }),
        ],
        stornos: [
          beleg({
            belegart: 'rechnungsstorno',
            id: 'inv-storno',
            belegnummer: '2026-0500',
            status: 'storno',
          }),
        ],
      }),
      [],
      'SKR03',
    );

    expect(liste.totalRelevantDocuments).toBe(2);
    const gutschrift = liste.openEntries.find((e) => e.sourceId === 'exp-credit')!;
    expect(gutschrift.brutto, 'das Vorzeichen bleibt').toBe(-119);
    const storno = liste.openEntries.find((e) => e.sourceId === 'inv-storno')!;
    expect(storno.sourceType).toBe('invoice');
    expect(storno.hinweis).toBe('storno');
  });

  it('ein Beleg, der als Rechnung und als Storno auftaucht, zählt einmal', () => {
    const liste = buildAccountingChecklist(
      model({
        ausgangsrechnungen: [
          beleg({ belegart: 'ausgangsrechnung', id: 'inv-1', belegnummer: '2026-0500' }),
        ],
        stornos: [
          beleg({
            belegart: 'rechnungsstorno',
            id: 'inv-1',
            belegnummer: '2026-0500',
            status: 'storno',
          }),
        ],
      }),
      [],
      'SKR03',
    );
    expect(liste.totalRelevantDocuments).toBe(1);
  });
});
