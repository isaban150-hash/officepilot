/**
 * P1 MITARBEITERZAHLUNGEN — die neutrale Übergabe an den Steuerberater.
 *
 * Eigene Zeilen statt Belege oder Ausgabenzahlungen, eigene CSV, eigener
 * Nachweisordner, ein neuer Fingerprint (Version 3) — und alte Abschlüsse
 * (Versionen 1 und 2) bleiben nach ihrer eigenen Logik gültig.
 */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  MITARBEITER_NACHWEIS_FOLDER,
  buildMitarbeiterZahlungenCsv,
  buildMonatsmappeModel,
  buildZahlungenCsv,
  type MonatsmappeInput,
} from './monatsmappeModelService';
import { buildPeriodFingerprint, buildPeriodManifest, closureFingerprintVersion } from '../accounting/accountingPeriodFingerprint';
import { buildAccountingPeriodState } from '../accounting/accountingPeriodService';
import { buildBookingExport } from '../accounting/accountingBookingExportService';
import { buildAccountingExportPackage } from '../accounting/accountingExportPackageService';
import { rowToAccountingPeriodClosure } from '../accounting/accountingPeriodCloudSyncService';
import type { AccountingPeriodClosure, AccountingPeriodFingerprintVersion } from '../../types/accountingPeriod';
import type { EmployeePayment } from '../../types/employee';
import type { CompanyDocument } from '../../types/models';
import type { DocumentFileRef } from '../../types/documentFileRef';

const OKT = '2026-10';
const NOV = '2026-11';

function zahlung(overrides: Partial<EmployeePayment> = {}): EmployeePayment {
  return {
    id: 'pay-1',
    employeeId: 'emp-1',
    employeeName: 'Erika Beispiel',
    personnelNumber: 'P-01',
    kind: 'wage',
    amount: 800,
    paymentDate: '2026-10-02',
    paymentMethod: 'cash',
    wageMonth: '2026-09',
    purpose: 'Lohn September',
    receiptReference: 'MZ-20261002-ABCD2345',
    createdAt: '2026-10-02T09:00:00.000Z',
    ...overrides,
  };
}

const NACHWEIS: CompanyDocument = {
  id: 'doc-unterschrieben',
  title: 'Unterschriebene Auszahlungsquittung MZ-20261002-ABCD2345',
  category: 'personal',
  issuer: '',
  recognizedText: '',
  issueDate: '2026-10-02',
  validUntil: null,
  digitalFolder: { id: 'd', name: 'Zahlungsnachweise 2026', path: '/Mitarbeiter/Zahlungsnachweise/2026/' },
  paperFolder: { folderId: 'paper-personal', register: 'Lohn', label: 'Personal' },
  tags: [],
  linkedCompany: '',
  linkedVorgang: null,
  archived: true,
  createdAt: '2026-10-03T09:00:00.000Z',
  imagePreview: '📄',
  linkedInvoiceId: null,
  linkedLetterId: null,
  linkedOfferId: null,
  fileRefId: 'file-ref-nachweis',
} as CompanyDocument;

const DATEI = {
  id: 'file-ref-nachweis',
  mimeType: 'application/pdf',
  originalFileName: 'quittung.pdf',
  lifecycleStatus: 'committed',
} as DocumentFileRef;

function eingabe(monthKey: string, payments: EmployeePayment[], mitDokument = false): MonatsmappeInput {
  return {
    monthKey,
    invoices: [],
    expenses: [],
    documents: mitDokument ? [NACHWEIS] : [],
    inboxItems: [],
    fileRefs: mitDokument ? [DATEI] : [],
    employeePayments: payments,
  };
}

function abschluss(monthKey: string, payments: EmployeePayment[], version: AccountingPeriodFingerprintVersion): AccountingPeriodClosure {
  const manifest = buildPeriodManifest(buildMonatsmappeModel(eingabe(monthKey, payments)), [], 'SKR03', version);
  return {
    id: `closure-${version}`,
    monthKey,
    revision: 1,
    closedAt: '2026-11-01T10:00:00.000Z',
    fingerprint: buildPeriodFingerprint(manifest),
    manifest,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
  };
}

describe('Monatsmappe — Mitarbeiterzahlungen als eigene, neutrale Zeilen', () => {
  it('Auswahl nach Auszahlungsdatum; Storno zum Monatsende; keine Zeile in zahlungen.csv', () => {
    const model = buildMonatsmappeModel(
      eingabe(OKT, [
        zahlung(),
        zahlung({ id: 'pay-2', receiptReference: 'MZ-20261005-BCDE3456', paymentDate: '2026-10-05', kind: 'advance', wageMonth: undefined, amount: 300, reversedAt: '2026-10-06T08:00:00.000Z', reversalReason: 'Doppelt erfasst' }),
        zahlung({ id: 'pay-sep', receiptReference: 'MZ-20260930-CDEF4567', paymentDate: '2026-09-30' }),
      ]),
    );
    expect(model.mitarbeiterZahlungen?.map((z) => [z.referenz, z.art, z.status, z.betrag])).toEqual([
      ['MZ-20261002-ABCD2345', 'zahlung', 'aktiv', 800],
      ['MZ-20261005-BCDE3456', 'zahlung', 'storniert', 300],
    ]);
    expect(model.isEmpty).toBe(false);
    expect(buildZahlungenCsv(model).trim().split('\r\n')).toHaveLength(1);
    expect(model.eingangsbelege).toEqual([]);
  });

  it('ein Storno nach Monatsende lässt den Monat unverändert und erscheint im Stornomonat', () => {
    const p = zahlung({ reversedAt: '2026-11-03T08:00:00.000Z', reversalReason: 'Falscher Mitarbeiter' });
    const oktober = buildMonatsmappeModel(eingabe(OKT, [p]));
    expect(oktober.mitarbeiterZahlungen?.[0]).toMatchObject({ status: 'aktiv', spaeterStorniertAm: '2026-11-03' });
    const november = buildMonatsmappeModel(eingabe(NOV, [p]));
    expect(november.mitarbeiterZahlungen).toHaveLength(1);
    expect(november.mitarbeiterZahlungen?.[0]).toMatchObject({ art: 'storno', status: 'storno', betrag: -800, datum: '2026-11-03', stornoGrund: 'Falscher Mitarbeiter' });
  });

  it('mitarbeiter_zahlungen.csv — Spalten, Einordnung je Art, Nachweis und Storno', () => {
    const model = buildMonatsmappeModel(
      eingabe(
        OKT,
        [
          zahlung({ proofDocumentId: 'doc-unterschrieben' }),
          zahlung({ id: 'pay-v', receiptReference: 'MZ-20261003-BBBB2222', paymentDate: '2026-10-03', kind: 'advance', wageMonth: undefined, amount: 150.5, paymentMethod: 'bank' }),
          zahlung({ id: 'pay-a', receiptReference: 'MZ-20261004-CCCC3333', paymentDate: '2026-10-04', kind: 'reimbursement', wageMonth: undefined, amount: 42 }),
          zahlung({ id: 'pay-r', receiptReference: 'MZ-20261005-DDDD4444', paymentDate: '2026-10-05', kind: 'travel', wageMonth: undefined, amount: 61.2 }),
          zahlung({ id: 'pay-s', receiptReference: 'MZ-20261006-EEEE5555', paymentDate: '2026-10-06', kind: 'other', wageMonth: undefined, purpose: undefined, amount: 20, note: 'Werkzeuggeld', reversedAt: '2026-10-07T08:00:00.000Z', reversalReason: 'Irrtum' }),
        ],
        true,
      ),
    );
    const csv = buildMitarbeiterZahlungenCsv(model);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const zeilen = csv.slice(1).trim().split('\r\n');
    expect(zeilen[0]).toBe(
      'Referenz;Datum;Mitarbeiter;Personalnummer;Art;Betrag;Zahlungsart;Lohnmonat;Notiz/Verwendungszweck;Nachweis vorhanden;Nachweisdatei;Status;Stornodatum;Stornogrund;Einordnung',
    );
    const lohn = zeilen.find((z) => z.startsWith('MZ-20261002-ABCD2345'))!;
    expect(lohn).toContain(';Lohn/Gehalt;800,00;Bar;2026-09;Lohn September;ja;');
    expect(lohn).toContain(`${MITARBEITER_NACHWEIS_FOLDER}/`);
    expect(lohn).toContain(';Gültig;;;Auszahlung Lohn/Gehalt – die Lohnabrechnung erstellt der Steuerberater');
    expect(zeilen.find((z) => z.startsWith('MZ-20261003'))).toContain('Vorschuss;150,50;Bank;');
    expect(zeilen.find((z) => z.startsWith('MZ-20261003'))).toContain('Forderung gegenüber dem Mitarbeiter, kein Aufwand');
    expect(zeilen.find((z) => z.startsWith('MZ-20261004'))).toContain('Auslagenerstattung – zugrunde liegenden Beleg prüfen');
    expect(zeilen.find((z) => z.startsWith('MZ-20261005'))).toContain('Reisekosten – zu prüfen');
    const sonstige = zeilen.find((z) => z.startsWith('MZ-20261006'))!;
    expect(sonstige).toContain(';Werkzeuggeld;nein;;Storniert;2026-10-07;Irrtum;Sonstige Zahlung – zu prüfen');
    /* Keine Lohnbuchung, keine Steuer, kein Sachkonto. */
    expect(csv).not.toMatch(/Sachkonto|Lohnsteuer|Sozialversicherung|DATEV/);
    expect(model.mitarbeiterNachweise).toHaveLength(1);
  });
});

describe('Steuerberater-Paket', () => {
  it('enthält mitarbeiter_zahlungen.csv, die unterschriebenen Nachweise und neutrale Zahlen im Manifest', async () => {
    const model = buildMonatsmappeModel(
      eingabe(OKT, [zahlung({ proofDocumentId: 'doc-unterschrieben' }), zahlung({ id: 'pay-v', receiptReference: 'MZ-20261003-BBBB2222', kind: 'advance', wageMonth: undefined, amount: 200 })], true),
    );
    const manifest = buildPeriodManifest(model, [], 'SKR03');
    const closure: AccountingPeriodClosure = {
      id: 'c1', monthKey: OKT, revision: 1, closedAt: '2026-11-01T10:00:00.000Z',
      fingerprint: buildPeriodFingerprint(manifest), manifest,
      createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z',
    };
    const geladen: string[] = [];
    const paket = await buildAccountingExportPackage(
      {
        model,
        bookings: buildBookingExport(model, [], 'SKR03'),
        closure,
        currentFingerprint: closure.fingerprint,
        workspaceId: 'ws-p1ma',
        exportedAt: '2026-11-02T10:00:00.000Z',
      },
      {
        invoicePdf: async () => new Uint8Array(),
        invoiceCorrectionPdf: async () => new Uint8Array(),
        fileRefBytes: async (id) => {
          geladen.push(id);
          return new TextEncoder().encode('%PDF-1.4 nachweis');
        },
      },
    );
    expect(paket.ok).toBe(true);
    if (!paket.ok) return;
    const zip = await JSZip.loadAsync(await paket.blob.arrayBuffer());
    const dateien = Object.keys(zip.files);
    const wurzel = 'Steuerberater_2026-10_Revision-1/';
    expect(dateien).toContain(`${wurzel}01_Buchungsdaten/mitarbeiter_zahlungen.csv`);
    expect(dateien.some((pfad) => pfad.startsWith(`${wurzel}Zahlungsnachweise/Mitarbeiterzahlungen/`) && pfad.endsWith('.pdf'))).toBe(true);
    // Abschlussphase: der Nachweis heißt wie seine Zahlung — die Referenz bleibt vollständig.
    expect(dateien).toContain(`${wurzel}Zahlungsnachweise/Mitarbeiterzahlungen/MZ-20261002-ABCD2345_Nachweis.pdf`);
    const csv = await zip.file(`${wurzel}01_Buchungsdaten/mitarbeiter_zahlungen.csv`)!.async('string');
    expect(csv).toContain('Zahlungsnachweise/Mitarbeiterzahlungen/MZ-20261002-ABCD2345_Nachweis.pdf');
    expect(geladen).toEqual(['file-ref-nachweis']);

    expect(paket.manifest.counts).toMatchObject({ mitarbeiterZahlungen: 2, mitarbeiterNachweise: 1, mitarbeiterBarOhneNachweis: 1 });
    expect(paket.manifest.summen).toMatchObject({ mitarbeiterZahlungen: 1000, mitarbeiterVorschuesse: 200 });
    const bericht = await zip.file(`${wurzel}00_Abschluss/pruefbericht.txt`)!.async('string');
    expect(bericht).toContain('Mitarbeiterzahlungen (siehe mitarbeiter_zahlungen.csv)');
    expect(bericht).toContain('davon Vorschüsse (Forderung, kein Aufwand): 200.00');
  });

  it('ohne Mitarbeiterzahlungen bleibt das Paket wie bisher (keine leere Datei)', async () => {
    const model = buildMonatsmappeModel(eingabe(OKT, []));
    const manifest = buildPeriodManifest(model, [], 'SKR03');
    const paket = await buildAccountingExportPackage(
      {
        model,
        bookings: buildBookingExport(model, [], 'SKR03'),
        closure: { id: 'c1', monthKey: OKT, revision: 1, closedAt: 'x', fingerprint: buildPeriodFingerprint(manifest), manifest, createdAt: 'x', updatedAt: 'x' },
        currentFingerprint: buildPeriodFingerprint(manifest),
        workspaceId: 'ws',
        exportedAt: 'x',
      },
      { invoicePdf: async () => new Uint8Array(), invoiceCorrectionPdf: async () => new Uint8Array(), fileRefBytes: async () => new Uint8Array() },
    );
    if (!paket.ok) throw new Error('paket');
    const zip = await JSZip.loadAsync(await paket.blob.arrayBuffer());
    expect(Object.keys(zip.files).some((pfad) => pfad.endsWith('mitarbeiter_zahlungen.csv'))).toBe(false);
  });
});

describe('Fingerprint Version 3 — und keine stille Umdeutung alter Abschlüsse', () => {
  it('neue Stände entstehen mit Version 3 und enthalten die Mitarbeiterzahlungen', () => {
    const manifest = buildPeriodManifest(buildMonatsmappeModel(eingabe(OKT, [zahlung()])), [], 'SKR03');
    expect(manifest.fingerprintVersion).toBe(3);
    expect(manifest.employeePayments).toEqual([
      { paymentId: 'pay-1', art: 'zahlung', datum: '2026-10-02', betrag: 800, kind: 'wage', method: 'cash', status: 'aktiv' },
    ]);
    expect(buildPeriodFingerprint(manifest)).toMatch(/^p3:[0-9a-f]+:\d+$/);
  });

  it('eine neue Zahlung oder ein Storno im Monat ändert Version 3; ein Storno nach Monatsende nicht', () => {
    const fp = (payments: EmployeePayment[]) =>
      buildPeriodFingerprint(buildPeriodManifest(buildMonatsmappeModel(eingabe(OKT, payments)), [], 'SKR03'));
    const basis = fp([zahlung()]);
    expect(fp([])).not.toBe(basis);
    expect(fp([zahlung({ amount: 801 })])).not.toBe(basis);
    expect(fp([zahlung({ reversedAt: '2026-10-20T08:00:00.000Z', reversalReason: 'Test' })])).not.toBe(basis);
    expect(fp([zahlung({ reversedAt: '2026-11-03T08:00:00.000Z', reversalReason: 'Später' })])).toBe(basis);
  });

  it('ein Abschluss mit Version 2 (oder 1) bleibt gültig, auch wenn Mitarbeiterzahlungen hinzukommen', () => {
    for (const version of [1, 2] as const) {
      const alt = abschluss(OKT, [], version);
      expect(closureFingerprintVersion(alt)).toBe(version);
      const state = buildAccountingPeriodState(buildMonatsmappeModel(eingabe(OKT, [zahlung()])), [], 'SKR03', [alt]);
      expect(state.isCurrentClosureValid, `Version ${version}`).toBe(true);
      expect(state.currentFingerprint).toBe(alt.fingerprint);
    }
  });

  it('ein Abschluss mit Version 3 erkennt eine neue Mitarbeiterzahlung als Änderung', () => {
    const neu = abschluss(OKT, [], 3);
    expect(closureFingerprintVersion(neu)).toBe(3);
    const gleich = buildAccountingPeriodState(buildMonatsmappeModel(eingabe(OKT, [])), [], 'SKR03', [neu]);
    expect(gleich.isCurrentClosureValid).toBe(true);
    const geaendert = buildAccountingPeriodState(buildMonatsmappeModel(eingabe(OKT, [zahlung()])), [], 'SKR03', [neu]);
    expect(geaendert.isCurrentClosureValid).toBe(false);
    expect(geaendert.readiness).toBe('changed_after_close');
  });

  it('die Cloud-Zeile eines Abschlusses behält Version 3 samt Mitarbeiterzahlungen', () => {
    const neu = abschluss(OKT, [zahlung()], 3);
    const zurueck = rowToAccountingPeriodClosure({
      client_closure_id: neu.id,
      period_year: 2026,
      period_month: 10,
      revision: 1,
      closed_at: neu.closedAt,
      closed_by: null,
      fingerprint: neu.fingerprint,
      manifest: JSON.parse(JSON.stringify(neu.manifest)),
      reopened_at: null,
      reopened_by: null,
      reopen_reason: null,
      created_at: neu.createdAt,
      updated_at: neu.updatedAt,
    } as unknown as Parameters<typeof rowToAccountingPeriodClosure>[0]);
    expect(zurueck.manifest.fingerprintVersion).toBe(3);
    expect(zurueck.manifest.employeePayments).toEqual(neu.manifest.employeePayments);
    expect(buildPeriodFingerprint(zurueck.manifest)).toBe(neu.fingerprint);
  });
});
