/**
 * STEUERBERATER-06C — Export-Gate, Buchungsdaten und Übergabepaket.
 *
 * Der wichtigste Abschnitt ist Z8: **Ein formal gültiger, aber fachlich
 * unvollständiger Abschluss darf nicht zum Export führen.** Genau so ein
 * Zustand entsteht, wenn jemand die Abschluss-RPC direkt aufruft — der Server
 * kann die fachliche Bereitschaft nicht nachrechnen (06B, Abschnitt L), also
 * muss das Gate sie vor jedem Export neu erheben.
 *
 * Abschnitt AB hält das Gegenstück fest: Für DATEV wird **nichts geraten**. Kein
 * Standardkonto, kein Gegenkonto, kein BU-Schlüssel.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  collectDatevBlockers,
  evaluateAccountingExportReadiness,
} from './accountingExportGateService';
import {
  buildBookingCsv,
  buildBookingExport,
  buildExportPackageFilename,
} from './accountingBookingExportService';
import {
  buildAccountingExportPackage,
  sanitizeEntryFileName,
} from './accountingExportPackageService';
import { buildAccountingPeriodState, closeAccountingPeriod, reopenAccountingPeriod } from './accountingPeriodService';
import { setAccountingPeriodStoreForTests } from './accountingPeriodStore';
import { setAccountingStoreForTests } from './accountingStore';
import { setExpenseStoreForTests } from '../expenseStore';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import { normalizeExpense } from '../expenseNormalize';
import { resetTestStores } from '../../test/resetStores';
import type { AccountingAssignment } from '../../types/accounting';
import type { AccountingPeriodClosure } from '../../types/accountingPeriod';
import type { Expense } from '../../types/expense';
import type {
  MonatsmappeBeleg,
  MonatsmappeModel,
} from '../steuerberater/monatsmappeModelService';
import type { MonatsmappeDocumentLoaders } from '../steuerberater/monatsmappeExportService';

/* ------------------------------------------------------------------ */

const MONTH = '2026-09';
const WORKSPACE = '00000000-0000-0000-0000-0000000c0001';

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
    documents: [{ kind: 'file_ref', fileRefId: 'ref-1', fileName: 'RE-1.pdf' }],
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
    title: '06C',
    issueDate: '2026-09-05',
    taxStatus: 'standard_19',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    ...overrides,
  } as Expense);
}

function closure(overrides: Partial<AccountingPeriodClosure> = {}): AccountingPeriodClosure {
  return {
    id: 'cl-1',
    monthKey: MONTH,
    revision: 1,
    closedAt: '2026-09-24T10:00:00.000Z',
    closedBy: 'user-1',
    fingerprint: 'p1:aaaa:100',
    manifest: {
      monthKey: MONTH,
      chartOfAccounts: 'SKR03',
      documentCount: 1,
      totalBrutto: 119,
      totalNetto: 100,
      totalSteuer: 19,
      entries: [],
    },
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

/** Ein Zustand aus Modell, Kontierungen und Abschlüssen — rein, ohne Speicher. */
function zustand(
  belege: MonatsmappeBeleg[] = [beleg()],
  assignments: AccountingAssignment[] = [kontierung()],
  closures: AccountingPeriodClosure[] = [],
) {
  return buildAccountingPeriodState(
    model({ eingangsbelege: belege }),
    assignments,
    'SKR03',
    closures,
  );
}

const loaders: MonatsmappeDocumentLoaders = {
  invoicePdf: async () => new Uint8Array([1, 2, 3]),
  invoiceCorrectionPdf: async () => new Uint8Array([4, 5, 6]),
  fileRefBytes: async () => new Uint8Array([7, 8, 9]),
};

beforeEach(() => {
  resetTestStores();
  setAccountingStoreForTests([]);
  setAccountingPeriodStoreForTests([]);
  setExpenseStoreForTests([ausgabe()]);
  hydrateWorkspaceStore({
    workspaceSettings: {
      workspaceId: WORKSPACE,
      settings: { chartOfAccounts: 'SKR03' },
      version: 1,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
  });
});

/* ================================================================== */
/* Z — das Export-Gate                                                */
/* ================================================================== */

describe('Z — Export-Gate', () => {
  it('Z1: ein offener Monat wird blockiert', () => {
    const readiness = evaluateAccountingExportReadiness(MONTH, zustand());
    expect(readiness.packageAllowed).toBe(false);
    expect(readiness.packageBlockers.map((b) => b.code)).toContain('not_closed');
  });

  it('Z2/Z3: offene Kontierungen blockieren, auch mit Abschluss', () => {
    const ohneAbschluss = evaluateAccountingExportReadiness(
      MONTH,
      zustand([beleg()], [kontierung({ status: 'needs_review', confirmedAt: undefined })]),
    );
    expect(ohneAbschluss.packageAllowed).toBe(false);
    expect(ohneAbschluss.packageBlockers.map((b) => b.code)).toContain('period_blockers');
  });

  it('Z4: ein gültiger aktueller Abschluss erlaubt das Paket', () => {
    const vorher = zustand();
    const readiness = evaluateAccountingExportReadiness(
      MONTH,
      zustand([beleg()], [kontierung()], [closure({ fingerprint: vorher.currentFingerprint })]),
    );
    expect(readiness.packageAllowed).toBe(true);
    expect(readiness.packageBlockers).toHaveLength(0);
  });

  it('Z5: ein veränderter Stand blockiert', () => {
    const readiness = evaluateAccountingExportReadiness(
      MONTH,
      zustand([beleg()], [kontierung()], [closure({ fingerprint: 'p1:veraltet:1' })]),
    );
    expect(readiness.packageAllowed).toBe(false);
    expect(readiness.packageBlockers.map((b) => b.code)).toContain('changed_after_close');
  });

  it('Z6: ein wieder geöffneter Monat blockiert', () => {
    const vorher = zustand();
    const readiness = evaluateAccountingExportReadiness(
      MONTH,
      zustand(
        [beleg()],
        [kontierung()],
        [closure({ fingerprint: vorher.currentFingerprint, reopenedAt: '2026-09-25T10:00:00.000Z' })],
      ),
    );
    expect(readiness.packageAllowed).toBe(false);
    expect(readiness.packageBlockers.map((b) => b.code)).toContain('not_closed');
  });

  /* Z7 — über die echten Speicher: schliessen, ändern, wieder öffnen, neu schliessen. */
  it('Z7: nach erneutem Abschluss ist der Export wieder erlaubt', () => {
    setAccountingStoreForTests([kontierung()]);
    expect(closeAccountingPeriod(MONTH).success).toBe(true);
    expect(evaluateAccountingExportReadiness(MONTH).packageAllowed).toBe(true);

    setAccountingStoreForTests([kontierung({ accountNumber: '4980' })]);
    expect(evaluateAccountingExportReadiness(MONTH).packageAllowed).toBe(false);

    reopenAccountingPeriod(MONTH, { reason: 'Konto korrigiert' });
    expect(closeAccountingPeriod(MONTH).success).toBe(true);
    const danach = evaluateAccountingExportReadiness(MONTH);
    expect(danach.packageAllowed).toBe(true);
    expect(danach.state.activeClosure?.revision).toBe(2);
  });

  /*
   * Z8 — der Kern. Ein Abschluss, der die Bereitschaft nie durchlaufen hat
   * (formal gültig, fachlich unvollständig), darf nicht exportieren. Genau so
   * ein Zustand entsteht über einen direkten RPC-Aufruf.
   */
  it('Z8: ein formal gültiger, fachlich unvollständiger Abschluss blockiert trotzdem', () => {
    // Ein Abschluss, dessen Fingerprint zum aktuellen Stand passt …
    const unvollstaendig = zustand(
      [beleg()],
      [kontierung({ status: 'needs_review', confirmedAt: undefined })],
    );
    const readiness = evaluateAccountingExportReadiness(
      MONTH,
      zustand(
        [beleg()],
        [kontierung({ status: 'needs_review', confirmedAt: undefined })],
        [closure({ fingerprint: unvollstaendig.currentFingerprint })],
      ),
    );

    // … ist trotzdem kein Freibrief: die fachlichen Blocker werden neu erhoben.
    expect(readiness.packageAllowed).toBe(false);
    expect(readiness.packageBlockers.map((b) => b.code)).toContain('period_blockers');
    expect(readiness.packageBlockers.map((b) => b.code)).not.toContain('changed_after_close');
  });

  /* Z10 — ein bewusst abgeschlossener leerer Monat darf exportieren. */
  it('Z10: ein leerer, bewusst abgeschlossener Monat ist exportierbar', () => {
    const leer = buildAccountingPeriodState(model({ isEmpty: true }), [], 'SKR03', []);
    const readiness = evaluateAccountingExportReadiness(
      MONTH,
      buildAccountingPeriodState(model({ isEmpty: true }), [], 'SKR03', [
        closure({ fingerprint: leer.currentFingerprint }),
      ]),
    );
    expect(readiness.packageAllowed).toBe(true);
  });

  /* Z9 — der Monat eines anderen Workspace existiert hier nicht. */
  it('Z9: ohne Daten im aktiven Workspace gibt es nichts zu exportieren', () => {
    setExpenseStoreForTests([]);
    setAccountingStoreForTests([]);
    const readiness = evaluateAccountingExportReadiness(MONTH);
    expect(readiness.packageAllowed).toBe(false);
    expect(readiness.packageBlockers.map((b) => b.code)).toContain('not_closed');
  });
});

/* ================================================================== */
/* AB — DATEV-Bereitschaft                                            */
/* ================================================================== */

describe('AB — DATEV', () => {
  /*
   * Die Bestandsaufnahme als Test: Es gibt keine Formatspezifikation, kein
   * Gegenkonto, keinen BU-Schlüssel und kein Mandantenprofil. Solange das so
   * ist, entsteht keine Datei, die „DATEV" heisst.
   */
  it('AB1–AB5: DATEV ist nicht bereit, und die Gründe stehen einzeln da', () => {
    const codes = collectDatevBlockers().map((b) => b.code);
    expect(codes).toEqual([
      'datev_no_specification',
      'datev_no_counter_account',
      'datev_no_tax_key',
      'datev_no_client_profile',
    ]);
  });

  it('AB6: auch bei einem gültigen Abschluss bleibt DATEV blockiert', () => {
    const vorher = zustand();
    const readiness = evaluateAccountingExportReadiness(
      MONTH,
      zustand([beleg()], [kontierung()], [closure({ fingerprint: vorher.currentFingerprint })]),
    );
    expect(readiness.packageAllowed, 'das Paket bleibt erlaubt').toBe(true);
    expect(readiness.datevAllowed).toBe(false);
    expect(readiness.datevBlockers.length).toBeGreaterThan(0);
  });

  /*
   * AB7/AB8 — nichts wird geraten. Der gesamte Exportpfad enthält keine
   * Kontonummer, die nicht vom Nutzer stammt, und kein Gegenkonto.
   */
  it('AB7/AB8: kein erfundenes Konto und kein erfundenes Gegenkonto', () => {
    const bookings = buildBookingExport(
      model({ eingangsbelege: [beleg()] }),
      [kontierung()],
      'SKR03',
    );
    expect(bookings.rows[0].sachkonto, 'nur das Konto des Nutzers').toBe('4930');

    const csv = buildBookingCsv(bookings);
    expect(csv).not.toMatch(/Gegenkonto/i);
    expect(csv).not.toMatch(/Soll|Haben/i);
    expect(csv).not.toMatch(/BU-?Schl/i);
    expect(csv).not.toMatch(/DATEV/i);
  });
});

/* ================================================================== */
/* AA — Buchungsdaten und Paket                                       */
/* ================================================================== */

describe('AA — Buchungsdaten', () => {
  it('nur bestätigte Kontierungen kommen in den Export', () => {
    const bookings = buildBookingExport(
      model({
        eingangsbelege: [beleg(), beleg({ id: 'exp-2', belegnummer: 'RE-2' })],
      }),
      [
        kontierung(),
        kontierung({ id: 'k2', sourceId: 'exp-2', status: 'needs_review', confirmedAt: undefined }),
      ],
      'SKR03',
    );
    expect(bookings.rows.map((r) => r.sourceId)).toEqual(['exp-1']);
  });

  /* AA11 — die Kontrollsummen, centgenau. */
  it('AA11: die Kontrollsummen stimmen centgenau', () => {
    const bookings = buildBookingExport(
      model({
        eingangsbelege: [
          beleg({ id: 'exp-1', netto: 33.33, steuer: 6.33, brutto: 39.66 }),
          beleg({ id: 'exp-2', belegnummer: 'RE-2', netto: 33.33, steuer: 6.33, brutto: 39.66 }),
          beleg({ id: 'exp-3', belegnummer: 'RE-3', netto: 33.34, steuer: 6.33, brutto: 39.67 }),
        ],
      }),
      [
        kontierung({ sourceId: 'exp-1' }),
        kontierung({ id: 'k2', sourceId: 'exp-2' }),
        kontierung({ id: 'k3', sourceId: 'exp-3' }),
      ],
      'SKR03',
    );
    expect(bookings.totals.belegCount).toBe(3);
    expect(bookings.totals.netto).toBe(100);
    expect(bookings.totals.steuer).toBe(18.99);
    expect(bookings.totals.brutto).toBe(118.99);
  });

  /* AA6 — die Gutschrift behält ihr Vorzeichen. */
  it('AA5/AA6: Storno und Gutschrift bleiben erkennbar, mit Vorzeichen', () => {
    const bookings = buildBookingExport(
      model({
        eingangsbelege: [
          beleg({ id: 'exp-credit', belegnummer: 'GS-1', netto: -100, steuer: -19, brutto: -119 }),
        ],
        stornos: [
          beleg({
            belegart: 'rechnungsstorno',
            id: 'inv-s',
            belegnummer: '2026-0500',
            status: 'storno',
          }),
        ],
      }),
      [
        kontierung({ sourceId: 'exp-credit' }),
        kontierung({ id: 'k2', sourceType: 'invoice', sourceId: 'inv-s' }),
      ],
      'SKR03',
    );

    const gutschrift = bookings.rows.find((r) => r.sourceId === 'exp-credit')!;
    expect(gutschrift.brutto, 'das Vorzeichen bleibt').toBe(-119);
    expect(gutschrift.stornoOderGutschrift).toBe('ja');

    const storno = bookings.rows.find((r) => r.sourceId === 'inv-s')!;
    expect(storno.belegart).toBe('Storno Ausgangsrechnung');
    expect(storno.stornoOderGutschrift).toBe('ja');
    expect(bookings.totals.brutto).toBe(0);
  });

  /* AA12 / R — deterministische Reihenfolge. */
  it('AA12: dieselben Daten ergeben dieselbe Reihenfolge, unabhängig von der Eingabe', () => {
    const a = beleg({ id: 'exp-a', belegnummer: 'RE-A', datum: '2026-09-10' });
    const b = beleg({ id: 'exp-b', belegnummer: 'RE-B', datum: '2026-09-02' });
    const assignments = [
      kontierung({ sourceId: 'exp-a' }),
      kontierung({ id: 'k2', sourceId: 'exp-b' }),
    ];

    const vorwaerts = buildBookingExport(model({ eingangsbelege: [a, b] }), assignments, 'SKR03');
    const rueckwaerts = buildBookingExport(model({ eingangsbelege: [b, a] }), assignments, 'SKR03');

    expect(vorwaerts.rows.map((r) => r.sourceId)).toEqual(['exp-b', 'exp-a']);
    expect(buildBookingCsv(rueckwaerts)).toBe(buildBookingCsv(vorwaerts));
  });

  /* AA7 — ein fehlender Originalbeleg wird gemeldet, nicht verschwiegen. */
  it('AA7: ein fehlender Originalbeleg wird gemeldet', () => {
    const bookings = buildBookingExport(
      model({ eingangsbelege: [beleg({ documentStatus: 'missing', documents: [] })] }),
      [kontierung()],
      'SKR03',
    );
    expect(bookings.withoutDocument).toHaveLength(1);
    expect(bookings.withoutDocument[0].belegnummer).toBe('RE-1');
    // Trotzdem ist der Beleg gebucht — kein Ausschluss aus den Buchungsdaten.
    expect(bookings.rows).toHaveLength(1);
  });

  it('die CSV trägt keine technischen Enum-Werte', () => {
    const csv = buildBookingCsv(
      buildBookingExport(
        model({ eingangsbelege: [beleg({ status: 'storniert' })] }),
        [kontierung({ taxTreatment: 'reverse_charge_13b' })],
        'SKR03',
      ),
    );
    expect(csv).not.toMatch(/reverse_charge_13b|eingangsbeleg|confirmed|storniert;/);
    expect(csv).toContain('Reverse Charge (§ 13b UStG)');
    expect(csv).toContain('Eingangsbeleg');
    expect(csv).toContain('Bestätigt');
  });

  it('die CSV beginnt mit BOM und trennt mit Semikolon', () => {
    const csv = buildBookingCsv(
      buildBookingExport(model({ eingangsbelege: [beleg()] }), [kontierung()], 'SKR03'),
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.split('\r\n')[0]).toContain('Belegart;Beleg-ID;Belegnummer');
    // Deutsches Dezimalkomma, damit Excel die Beträge als Zahl liest.
    expect(csv).toContain('119,00');
  });
});

describe('AA — Übergabepaket', () => {
  async function paket(
    belege: MonatsmappeBeleg[] = [beleg()],
    assignments: AccountingAssignment[] = [kontierung()],
  ) {
    const m = model({ eingangsbelege: belege });
    const bookings = buildBookingExport(m, assignments, 'SKR03');
    return buildAccountingExportPackage(
      {
        model: m,
        bookings,
        closure: closure(),
        currentFingerprint: 'p1:aaaa:100',
        workspaceId: WORKSPACE,
        exportedAt: '2026-09-26T09:00:00.000Z',
      },
      loaders,
    );
  }

  it('AA1/AA2: Manifest und Buchungsdaten liegen im Paket', async () => {
    const result = await paket();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const zip = await (await import('jszip')).default.loadAsync(result.blob);
    const namen = Object.keys(zip.files);
    expect(namen.some((n) => n.endsWith('00_Abschluss/manifest.json'))).toBe(true);
    expect(namen.some((n) => n.endsWith('00_Abschluss/pruefbericht.txt'))).toBe(true);
    expect(namen.some((n) => n.endsWith('01_Buchungsdaten/buchungen.csv'))).toBe(true);
  });

  /* Q — das Manifest referenziert die Revision und schreibt nichts um. */
  it('Q: das Manifest nennt Revision, Fingerprint und Exportart', async () => {
    const result = await paket();
    if (!result.ok) return;

    expect(result.manifest).toMatchObject({
      workspaceId: WORKSPACE,
      monthKey: MONTH,
      revision: 1,
      closedAt: '2026-09-24T10:00:00.000Z',
      closureFingerprint: 'p1:aaaa:100',
      exportedAt: '2026-09-26T09:00:00.000Z',
      exportart: 'steuerberater_paket',
      datevFormat: false,
    });
    expect((result.manifest.datevNichtVerfuegbarWeil as string[]).length).toBe(4);
  });

  it('AA4: der Eingangsbeleg liegt in seinem Ordner', async () => {
    const result = await paket();
    if (!result.ok) return;
    const zip = await (await import('jszip')).default.loadAsync(result.blob);
    expect(Object.keys(zip.files).some((n) => n.includes('03_Eingangsbelege/RE-1.pdf'))).toBe(true);
    expect(result.documentCount).toBe(1);
  });

  it('AA3/AA5: Ausgangsrechnung und Storno landen in getrennten Ordnern', async () => {
    const m = model({
      ausgangsrechnungen: [
        {
          ...beleg({ belegart: 'ausgangsrechnung', id: 'inv-1', belegnummer: '2026-0500' }),
          documents: [{ kind: 'invoice_pdf', fileName: '2026-0500.pdf' }],
        },
      ],
      stornos: [
        {
          ...beleg({ belegart: 'rechnungsstorno', id: 'inv-2', belegnummer: '2026-0501', status: 'storno' }),
          documents: [{ kind: 'invoice_correction_pdf', fileName: '2026-0501-Korrektur.pdf' }],
        },
      ],
    });
    const bookings = buildBookingExport(
      m,
      [
        kontierung({ sourceType: 'invoice', sourceId: 'inv-1' }),
        kontierung({ id: 'k2', sourceType: 'invoice', sourceId: 'inv-2' }),
      ],
      'SKR03',
    );
    const result = await buildAccountingExportPackage(
      {
        model: m,
        bookings,
        closure: closure(),
        currentFingerprint: 'p1:aaaa:100',
        workspaceId: WORKSPACE,
        exportedAt: '2026-09-26T09:00:00.000Z',
      },
      loaders,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const namen = Object.keys((await (await import('jszip')).default.loadAsync(result.blob)).files);
    expect(namen.some((n) => n.includes('02_Ausgangsrechnungen/2026-0500.pdf'))).toBe(true);
    expect(namen.some((n) => n.includes('04_Stornos_Gutschriften/2026-0501-Korrektur.pdf'))).toBe(true);
  });

  /*
   * AA9 — eine Namenskollision überschreibt nichts still. Der bestehende
   * Monatsmappen-Export bricht hier ab; für eine Übergabe wäre das zu hart,
   * weil der Nutzer es nicht beheben kann.
   */
  it('AA9: bei gleichem Dateinamen entsteht ein zweiter, stabiler Name', async () => {
    const result = await paket(
      [
        beleg({ id: 'exp-1', documents: [{ kind: 'file_ref', fileRefId: 'r1', fileName: 'Beleg.pdf' }] }),
        beleg({
          id: 'exp-2',
          belegnummer: 'RE-2',
          documents: [{ kind: 'file_ref', fileRefId: 'r2', fileName: 'Beleg.pdf' }],
        }),
      ],
      [kontierung({ sourceId: 'exp-1' }), kontierung({ id: 'k2', sourceId: 'exp-2' })],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const zip = await (await import('jszip')).default.loadAsync(result.blob);
    // Ordnereintraege ausnehmen — JSZip fuehrt den Ordner selbst als Eintrag.
    const belege = Object.values(zip.files)
      .filter((entry) => !entry.dir && entry.name.includes('03_Eingangsbelege/'))
      .map((entry) => entry.name);
    expect(belege).toHaveLength(2);
    expect(new Set(belege).size, 'kein Name zweimal').toBe(2);
    expect(result.documentCount).toBe(2);
  });

  /* AA7 — der Prüfbericht nennt den fehlenden Originalbeleg. */
  it('AA7: der Prüfbericht meldet fehlende Originalbelege', async () => {
    const result = await paket([beleg({ documentStatus: 'missing', documents: [] })]);
    if (!result.ok) return;

    const zip = await (await import('jszip')).default.loadAsync(result.blob);
    const bericht = await zip.file(/pruefbericht\.txt$/)[0].async('string');
    expect(bericht).toContain('Originalbeleg fehlt (1)');
    expect(bericht).toContain('RE-1');
    expect(bericht).toContain('Kein DATEV-Buchungsstapel');
  });

  it('der Prüfbericht nennt die Kontrollsummen', async () => {
    const result = await paket();
    if (!result.ok) return;
    const zip = await (await import('jszip')).default.loadAsync(result.blob);
    const bericht = await zip.file(/pruefbericht\.txt$/)[0].async('string');
    expect(bericht).toContain('Belege: 1');
    expect(bericht).toContain('Brutto: 119.00');
  });

  /* F — ein leerer Monat erzeugt ein leeres, nachvollziehbares Paket. */
  it('F: ein leerer Monat ergibt ein leeres, aber nachvollziehbares Paket', async () => {
    const result = await paket([], []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.documentCount).toBe(0);
    expect((result.manifest.counts as Record<string, number>).buchungen).toBe(0);

    const zip = await (await import('jszip')).default.loadAsync(result.blob);
    const csv = await zip.file(/buchungen\.csv$/)[0].async('string');
    // Kopfzeile und Summenzeile — keine erfundenen Buchungssätze.
    expect(csv.split('\r\n').filter((l) => l.trim().length > 0)).toHaveLength(2);
  });

  /*
   * AA8/AA10 — der Dateiname im Paket ist ein Dateiname, kein Pfad.
   *
   * Die Monatsmappe baut ihre Namen bereits sicher; hier wird an der Stelle
   * geprueft, an der tatsaechlich geschrieben wird. Ein Paketdienst darf sich
   * nicht auf die Sauberkeit seines Aufrufers verlassen — ein Lieferantenname
   * mit `../` fuehrte sonst aus dem Paketordner heraus.
   */
  it('AA10: ein Dateiname mit Pfadanteilen wird bereinigt', () => {
    expect(sanitizeEntryFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeEntryFileName(String.raw`..\..\windows\system.ini`)).toBe('system.ini');
    expect(sanitizeEntryFileName('Muell GmbH & Co. KG/Beleg.pdf')).toBe('Beleg.pdf');
    // Umlaute bleiben lesbar, Endung bleibt erhalten.
    expect(sanitizeEntryFileName('Grünflächen Süd.pdf')).toBe('Gruenflaechen_Sued.pdf');
    for (const name of ['../x.pdf', 'a/b/c.pdf', '..', '/', 'x']) {
      expect(sanitizeEntryFileName(name), name).not.toMatch(/[\\/]/);
      expect(sanitizeEntryFileName(name), name).not.toContain('..');
    }
  });

  it('AA10b: ein manipulierter Belegname landet flach im Ordner', async () => {
    const result = await paket([
      beleg({
        documents: [{ kind: 'file_ref', fileRefId: 'r1', fileName: '../../../boese.pdf' }],
      }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const zip = await (await import('jszip')).default.loadAsync(result.blob);
    const dateien = Object.values(zip.files)
      .filter((entry) => !entry.dir)
      .map((entry) => entry.name);
    expect(dateien.every((n) => n.startsWith('Steuerberater_')), dateien.join()).toBe(true);
    expect(dateien.some((n) => n.includes('..'))).toBe(false);
    expect(dateien.some((n) => n.endsWith('03_Eingangsbelege/boese.pdf'))).toBe(true);
  });

  /* AA8 — derselbe Stand ergibt dieselben Dateinamen. */
  it('AA8: die Dateinamen im Paket sind stabil', async () => {
    const namen = async () => {
      const result = await paket();
      if (!result.ok) throw new Error('Paket fehlgeschlagen');
      const zip = await (await import('jszip')).default.loadAsync(result.blob);
      return Object.values(zip.files)
        .filter((entry) => !entry.dir)
        .map((entry) => entry.name)
        .sort();
    };
    expect(await namen()).toEqual(await namen());
  });

  /* S — Dateinamen sind stabil und ohne Pfadanteile. */
  it('S: der Paketname ist stabil und dateisystemsicher', () => {
    expect(buildExportPackageFilename('2026-09', 2)).toBe('Steuerberater_2026-09_Revision-2.zip');
    // Keine Pfadtraversale aus einem manipulierten Monatsschlüssel.
    expect(buildExportPackageFilename('../../etc', 1)).not.toContain('..');
    expect(buildExportPackageFilename('../../etc', 1)).not.toContain('/');
  });

  /* Y — der Export verändert nichts. */
  it('Y: der Export lässt Belege, Kontierungen und Abschluss unverändert', async () => {
    setAccountingStoreForTests([kontierung()]);
    const vorherAbschluss = closeAccountingPeriod(MONTH);
    expect(vorherAbschluss.success).toBe(true);
    if (!vorherAbschluss.success) return;

    const vorher = evaluateAccountingExportReadiness(MONTH);
    await paket();
    const nachher = evaluateAccountingExportReadiness(MONTH);

    expect(nachher.state.currentFingerprint).toBe(vorher.state.currentFingerprint);
    expect(nachher.state.activeClosure?.revision).toBe(vorher.state.activeClosure?.revision);
    expect(nachher.state.activeClosure?.fingerprint).toBe(vorher.state.activeClosure?.fingerprint);
    expect(nachher.state.revisionHistory).toHaveLength(1);
  });

  /* X — der Export schliesst nie selbst ab. */
  it('X: ein offener Monat wird durch einen Exportversuch nicht abgeschlossen', () => {
    setAccountingStoreForTests([kontierung()]);
    const readiness = evaluateAccountingExportReadiness(MONTH);
    expect(readiness.packageAllowed).toBe(false);
    expect(readiness.state.activeClosure).toBeNull();
    expect(readiness.state.revisionHistory).toHaveLength(0);
  });
});

/* ================================================================== */
/* 01H — wer abgeschlossen hat                                         */
/* ================================================================== */

/*
 * Befund: Im Paket stand `closedBy = null`. Der Server schreibt `auth.uid()`
 * in `closed_by`; die Oberfläche reichte beim lokalen Abschluss aber niemanden
 * durch, und bis zum nächsten Pull blieb das Feld leer. Ist wirklich niemand
 * bekannt, bleibt es leer — im Manifest als `null`, im Prüfbericht als Satz.
 */
describe('01H — closedBy in Manifest und Prüfbericht', () => {
  async function paketMit(closedBy: string | undefined) {
    const m = model({ eingangsbelege: [beleg()] });
    const bookings = buildBookingExport(m, [kontierung()], 'SKR03');
    const result = await buildAccountingExportPackage(
      {
        model: m,
        bookings,
        closure: closure({ closedBy }),
        currentFingerprint: 'p1:aaaa:100',
        workspaceId: WORKSPACE,
        exportedAt: '2026-09-26T09:00:00.000Z',
      },
      loaders,
    );
    if (!result.ok) throw new Error('Paket nicht gebaut');
    const zip = await (await import('jszip')).default.loadAsync(result.blob);
    const berichtName = Object.keys(zip.files).find((n) => n.endsWith('pruefbericht.txt'))!;
    const bericht = await zip.file(berichtName)!.async('string');
    return { manifest: result.manifest, bericht };
  }

  it('Actor vorhanden: Manifest und Prüfbericht nennen ihn', async () => {
    const { manifest, bericht } = await paketMit('7f1c2d3e-0000-4000-8000-000000000001');
    expect(manifest.closedBy).toBe('7f1c2d3e-0000-4000-8000-000000000001');
    expect(bericht).toContain('Abgeschlossen von: Benutzer-ID 7f1c2d3e-0000-4000-8000-000000000001');
  });

  it('Actor unbekannt: Manifest bleibt null, der Prüfbericht sagt „Nicht verfügbar“', async () => {
    const { manifest, bericht } = await paketMit(undefined);
    expect(manifest.closedBy).toBeNull();
    expect(bericht).toContain('Abgeschlossen von: Nicht verfügbar');
    expect(bericht).not.toMatch(/\bnull\b|\bundefined\b/);
  });

  it('Monatsabschluss übernimmt den übergebenen Actor', () => {
    setAccountingStoreForTests([kontierung()]);
    const result = closeAccountingPeriod(MONTH, { closedBy: 'user-01h' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.closure.closedBy).toBe('user-01h');
  });

  it('Monatsabschluss ohne Actor erfindet keinen', () => {
    setAccountingStoreForTests([kontierung()]);
    const result = closeAccountingPeriod(MONTH);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.closure.closedBy).toBeUndefined();
  });
});
