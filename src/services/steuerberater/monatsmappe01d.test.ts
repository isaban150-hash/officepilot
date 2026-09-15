/**
 * FINANZ-CORE-DURABILITY-01D — Steuerberater-Monatsmappe.
 *
 *  A  Monat mit Ausgangsrechnung + Eingangsbeleg -> beide Kategorien
 *  B  mehrere Belege desselben Monats vollstaendig und genau einmal
 *  C  Belege ausserhalb des Monats fehlen
 *  D  Rechnungs- und Ausgabenzahlungen nach Zahlungsdatum
 *  E  Storno -> keine aktive Zahlung, Status storniert; Entwuerfe nie
 *  F  Grabsteine nie
 *  G  fehlendes Dokument gekennzeichnet; nicht ladbare Datei bricht ab (kein Fantasie-Dokument)
 *  H  gleiche Nummern kollidieren nicht
 *  L  Demo-Ausgaben/-Vorgaenge nie
 *  M  leerer Monat
 */
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { Expense } from '../../types/expense';
import type { CompanyDocument, InboxItem, VorgangInvoice } from '../../types/models';
import type { DocumentFileRef } from '../../types/documentFileRef';
import {
  buildMonatsmappeModel,
  buildUebersichtCsv,
  buildZahlungenCsv,
  safeFileNamePart,
  type MonatsmappeInput,
} from './monatsmappeModelService';
import { buildMonatsmappeExport, buildMonatsmappeZip, type MonatsmappeDocumentLoaders } from './monatsmappeExportService';

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-1',
    number: 'RE-2026-001',
    type: 'rechnung',
    positions: [],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'versendet',
    date: '2026-09-10',
    issueDate: '2026-09-10',
    createdAt: '2026-09-10T10:00:00.000Z',
    customerSnapshot: { name: 'Kunde A', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-real-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Lieferant GmbH',
    invoiceNumber: 'L-100',
    title: 'Material',
    description: '',
    issueDate: '2026-09-12',
    paymentDueDate: null,
    taxStatus: 'standard_19',
    netAmount: 50,
    taxAmount: 9.5,
    grossAmount: 59.5,
    currency: 'EUR',
    paymentStatus: 'offen',
    payments: [],
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'lieferant gmbh|l-100',
    tags: [],
    digitalFolder: { id: 'dig', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'f', register: 'A', label: 'x' },
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
    ...overrides,
  };
}

const fileRef = (id: string, mime = 'application/pdf'): DocumentFileRef =>
  ({ id, originalFileName: 'beleg.pdf', mimeType: mime, fileSize: 3, contentHash: 'a'.repeat(64), storageType: 'indexeddb', localDataKey: id, createdAt: 'x', lifecycleStatus: 'committed' }) as DocumentFileRef;

function input(overrides: Partial<MonatsmappeInput> = {}): MonatsmappeInput {
  return { monthKey: '2026-09', invoices: [], expenses: [], documents: [], inboxItems: [], fileRefs: [], ...overrides };
}

const loaders = (fail: string[] = []): MonatsmappeDocumentLoaders => ({
  invoicePdf: async (id) => { if (fail.includes(id)) throw new Error('pdf_encode_failed'); return new TextEncoder().encode(`%PDF-${id}`); },
  invoiceCorrectionPdf: async (id) => new TextEncoder().encode(`%PDF-corr-${id}`),
  fileRefBytes: async (id) => { if (fail.includes(id)) throw new Error('blob_unavailable'); return new TextEncoder().encode(`bytes-${id}`); },
});

describe('01D — Modell', () => {
  it('A/B/C: beide Kategorien, jeder Beleg genau einmal, andere Monate nicht', () => {
    const model = buildMonatsmappeModel(input({
      invoices: [
        { invoice: invoice(), vorgangId: 'v-real' },
        { invoice: invoice(), vorgangId: 'v-real' }, // Duplikat (gleiche ID) -> einmal
        { invoice: invoice({ id: 'inv-2', number: 'RE-2026-002', issueDate: '2026-09-28', date: '2026-09-28' }), vorgangId: null },
        { invoice: invoice({ id: 'inv-old', number: 'RE-2026-000', issueDate: '2026-08-31', date: '2026-08-31' }), vorgangId: null },
      ],
      expenses: [expense(), expense({ id: 'exp-real-2', invoiceNumber: 'L-101' }), expense({ id: 'exp-real-old', issueDate: '2026-10-01' })],
    }));
    expect(model.ausgangsrechnungen.map((b) => b.id)).toEqual(['inv-1', 'inv-2']);
    expect(model.eingangsbelege.map((b) => b.id)).toEqual(['exp-real-1', 'exp-real-2']);
    expect(model.isEmpty).toBe(false);
    const first = model.ausgangsrechnungen[0];
    expect(first).toMatchObject({ belegart: 'ausgangsrechnung', belegnummer: 'RE-2026-001', datum: '2026-09-10', gegenpartei: 'Kunde A', netto: 100, steuer: 19, brutto: 119, status: 'aktiv', documentStatus: 'generated' });
  });

  it('D: Zahlungen nach Zahlungsdatum — auch fuer Belege anderer Monate', () => {
    const model = buildMonatsmappeModel(input({
      invoices: [{ invoice: invoice({ id: 'inv-aug', issueDate: '2026-08-15', date: '2026-08-15', payments: [
        { id: 'pay-a', date: '2026-09-02', amount: 50, createdAt: 'x' },
        { id: 'pay-b', date: '2026-08-20', amount: 10, createdAt: 'x' },
      ] }), vorgangId: null }],
      expenses: [expense({ payments: [{ id: 'pay-e', date: '2026-09-30', amount: 59.5, createdAt: 'x', reference: 'UEB-1' }] })],
    }));
    expect(model.ausgangsrechnungen).toHaveLength(0);
    expect(model.zahlungenAusgang.map((z) => z.zahlungId)).toEqual(['pay-a']);
    expect(model.zahlungenEingang).toHaveLength(1);
    expect(model.zahlungenEingang[0]).toMatchObject({ belegId: 'exp-real-1', betrag: 59.5, referenz: 'UEB-1', datum: '2026-09-30' });
    expect(model.eingangsbelege[0].zahlungsstatus).toBe('bezahlt');
    expect(model.eingangsbelege[0].zahlungssumme).toBe(59.5);
  });

  it('E: Storno ist kein aktiver Beleg und hat keine aktive Zahlung; Entwuerfe nie', () => {
    const model = buildMonatsmappeModel(input({
      invoices: [
        { invoice: invoice({ cancelledAt: '2026-09-15T00:00:00.000Z', cancelReason: 'Fehler', cancellationKind: 'correction', correctionNumber: 'RK-2026-001', payments: [{ id: 'pay-x', date: '2026-09-11', amount: 119, createdAt: 'x' }] }), vorgangId: null },
        { invoice: invoice({ id: 'inv-draft', number: 'ENTWURF', status: 'entwurf' }), vorgangId: null },
      ],
      expenses: [
        expense({ status: 'storniert', cancelledAt: '2026-09-14T09:00:00.000Z', payments: [{ id: 'pay-s', date: '2026-09-13', amount: 5, createdAt: 'x' }] }),
        expense({ id: 'exp-draft', status: 'entwurf' }),
      ],
    }));
    expect(model.ausgangsrechnungen.map((b) => [b.id, b.status, b.zahlungsstatus, b.zahlungssumme])).toEqual([['inv-1', 'storniert', 'storniert', 0]]);
    // 01D2 — Original traegt nur sein eigenes PDF; die Korrektur ist ein eigener Storno-Beleg (Same-month hier).
    expect(model.ausgangsrechnungen[0].documents.map((d) => d.kind)).toEqual(['invoice_pdf']);
    expect(model.ausgangsrechnungen[0].hinweis).toContain('RK-2026-001');
    expect(model.stornos.map((s) => [s.belegart, s.belegnummer, s.datum, s.brutto, s.status])).toEqual([
      ['rechnungsstorno', 'RK-2026-001', '2026-09-15', -119, 'storno'],
      ['ausgabenstorno', 'L-100', '2026-09-14', -59.5, 'storno'],
    ].sort((a, b) => String(a[2]).localeCompare(String(b[2]))));
    expect(model.stornos.find((s) => s.belegart === 'rechnungsstorno')!.documents.map((d) => d.kind)).toEqual(['invoice_correction_pdf']);
    expect(model.zahlungenAusgang).toEqual([]);
    expect(model.eingangsbelege.map((b) => [b.id, b.status])).toEqual([['exp-real-1', 'storniert']]);
    expect(model.zahlungenEingang).toEqual([]);
  });

  it('F/L: Grabsteine, Demo-Ausgaben und Demo-Vorgaenge nie', () => {
    const model = buildMonatsmappeModel(input({
      invoices: [{ invoice: invoice({ id: 'inv-demo' }), vorgangId: 'v-001' }],
      expenses: [
        expense({ id: 'exp-001' }),
        expense({ id: 'exp-real-gone', sync: { updatedAt: 'x', version: 2, deleted: true, deviceId: 'd', workspaceId: 'w' } }),
      ],
    }));
    expect(model.isEmpty).toBe(true);
  });

  it('M: leerer Monat; ungueltiger Monat wird abgewiesen', () => {
    expect(buildMonatsmappeModel(input({ monthKey: '2026-07', expenses: [expense()] })).isEmpty).toBe(true);
    expect(() => buildMonatsmappeModel(input({ monthKey: '2026-13' }))).toThrow('Ungueltiger Monat');
  });

  it('G: Eingangsbeleg ohne Datei-Referenz ist gekennzeichnet; Archivdokument vor Eingang', () => {
    const documents = [{ id: 'doc-1', fileRefId: 'fr-doc' } as CompanyDocument];
    const inboxItems = [{ id: 'inbox-upload-1', fileRefId: 'fr-inbox' } as InboxItem];
    const model = buildMonatsmappeModel(input({
      expenses: [
        expense({ id: 'exp-real-a', archiveDocumentId: 'doc-1', linkedInboxId: 'inbox-upload-1' }),
        expense({ id: 'exp-real-b', linkedInboxId: 'inbox-upload-1' }),
        expense({ id: 'exp-real-c' }),
      ],
      documents, inboxItems, fileRefs: [fileRef('fr-doc'), fileRef('fr-inbox', 'image/jpeg')],
    }));
    const byId = Object.fromEntries(model.eingangsbelege.map((b) => [b.id, b]));
    expect(byId['exp-real-a'].documents[0]).toMatchObject({ kind: 'file_ref', fileRefId: 'fr-doc' });
    expect(byId['exp-real-a'].documents[0].fileName.endsWith('.pdf')).toBe(true);
    expect(byId['exp-real-b'].documents[0].fileRefId).toBe('fr-inbox');
    expect(byId['exp-real-b'].documents[0].fileName.endsWith('.jpg')).toBe(true);
    expect(byId['exp-real-c'].documentStatus).toBe('missing');
    expect(byId['exp-real-c'].documents).toEqual([]);
    expect(model.fehlendeDokumente).toEqual([{ belegart: 'eingangsbeleg', id: 'exp-real-c', belegnummer: 'L-100' }]);
    const csv = buildUebersichtCsv(model);
    expect(csv).toContain('Eingangsbeleg;exp-real-c;L-100;2026-09-12;Lieferant GmbH;50,00;9,50;59,50;aktiv;offen;0,00;nein;;Kein Originaldokument vorhanden');
  });

  it('H: gleiche Belegnummern ergeben verschiedene, sichere Dateinamen', () => {
    const model = buildMonatsmappeModel(input({
      invoices: [
        { invoice: invoice({ id: 'inv-aaaa1111', number: 'RE/2026 001' }), vorgangId: null },
        { invoice: invoice({ id: 'inv-bbbb2222', number: 'RE/2026 001' }), vorgangId: null },
      ],
      expenses: [expense({ id: 'exp-1111aaaa', supplierName: 'Müller & Söhne' }), expense({ id: 'exp-2222bbbb', supplierName: 'Müller & Söhne' })],
      documents: [], inboxItems: [{ id: 'i1', fileRefId: 'fr1' } as InboxItem],
      fileRefs: [fileRef('fr1')],
    }));
    const names = [...model.ausgangsrechnungen, ...model.eingangsbelege].flatMap((b) => b.documents.map((d) => d.fileName));
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(safeFileNamePart('Müller & Söhne')).toBe('Mueller_Soehne');
  });

  it('CSV: Zahlungen und Uebersicht mit BOM, Semikolon, Dezimalkomma; keine recognizedData', () => {
    const model = buildMonatsmappeModel(input({
      invoices: [{ invoice: invoice({ payments: [{ id: 'pay-1', date: '2026-09-11', amount: 19, createdAt: 'x', note: 'geheim' }] }), vorgangId: null }],
      expenses: [expense({ recognizedData: { iban: 'DE00', geheim: 'x' } })],
    }));
    const zahlungen = buildZahlungenCsv(model);
    expect(zahlungen.startsWith('﻿Belegart;Beleg-ID')).toBe(true);
    expect(zahlungen).toContain('Ausgangsrechnung;inv-1;RE-2026-001;pay-1;2026-09-11;19,00;;Kunde A');
    expect(zahlungen).not.toContain('geheim');
    expect(buildUebersichtCsv(model)).not.toContain('DE00');
  });
});

describe('01D — Paket', () => {
  it('ZIP-Struktur: Monat/Uebersicht.csv, Zahlungen.csv, Manifest.json, Ordner, Fehlende_Dokumente.txt', async () => {
    const model = buildMonatsmappeModel(input({
      invoices: [{ invoice: invoice(), vorgangId: null }],
      expenses: [expense({ id: 'exp-real-doc', linkedInboxId: 'i1' }), expense({ id: 'exp-real-nodoc', invoiceNumber: 'L-200' })],
      inboxItems: [{ id: 'i1', fileRefId: 'fr1' } as InboxItem], fileRefs: [fileRef('fr1')],
    }));
    const built = await buildMonatsmappeZip(model, loaders(), '2026-10-01T00:00:00.000Z');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const zip = await JSZip.loadAsync(built.blob);
    const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir).sort();
    expect(paths).toEqual([
      '2026-09/Ausgangsrechnungen/RE-2026-001_1.pdf',
      '2026-09/Eingangsbelege/2026-09-12_Lieferant_GmbH_L-100_real-doc.pdf',
      '2026-09/Fehlende_Dokumente.txt',
      '2026-09/Manifest.json',
      '2026-09/Uebersicht.csv',
      '2026-09/Zahlungen.csv',
    ]);
    const manifest = JSON.parse(await zip.file('2026-09/Manifest.json')!.async('string'));
    expect(manifest.counts).toEqual({ ausgangsrechnungen: 1, eingangsbelege: 2, zahlungenAusgang: 0, zahlungenEingang: 0, stornos: 0, dokumente: 2 });
    expect(manifest.fehlendeDokumente).toEqual([{ belegart: 'eingangsbeleg', id: 'exp-real-nodoc', belegnummer: 'L-200' }]);
    expect(await zip.file('2026-09/Ausgangsrechnungen/RE-2026-001_1.pdf')!.async('string')).toBe('%PDF-inv-1');
  });

  it('G: nicht ladbare Datei -> document_load_failed, kein Paket, kein erfundenes Dokument', async () => {
    const collect = () => input({
      invoices: [{ invoice: invoice(), vorgangId: null }],
      expenses: [expense({ linkedInboxId: 'i1' })],
      inboxItems: [{ id: 'i1', fileRefId: 'fr-broken' } as InboxItem], fileRefs: [fileRef('fr-broken')],
    });
    const result = await buildMonatsmappeExport({ monthKey: '2026-09', userId: 'u', collect, loaders: loaders(['fr-broken']), skipGate: true });
    expect(result.outcome).toBe('document_load_failed');
    if (result.outcome !== 'document_load_failed') return;
    expect(result.failed).toEqual([{ id: 'exp-real-1', belegnummer: 'L-100', fileName: '2026-09-12_Lieferant_GmbH_L-100_real-1.pdf', detail: 'blob_unavailable' }]);
  });

  it('M/Export: leerer Monat -> empty; ungueltig -> invalid_month; Erfolg liefert Summary', async () => {
    expect((await buildMonatsmappeExport({ monthKey: '2026-09', userId: 'u', collect: () => input(), loaders: loaders(), skipGate: true })).outcome).toBe('empty');
    expect((await buildMonatsmappeExport({ monthKey: '09/2026', userId: 'u', collect: () => input(), loaders: loaders(), skipGate: true })).outcome).toBe('invalid_month');
    const ok = await buildMonatsmappeExport({ monthKey: '2026-09', userId: 'u', collect: () => input({ invoices: [{ invoice: invoice(), vorgangId: null }] }), loaders: loaders(), skipGate: true });
    expect(ok.outcome).toBe('exported');
    if (ok.outcome !== 'exported') return;
    expect(ok.summary).toMatchObject({ monthKey: '2026-09', filename: 'OfficePilot_Steuerberater_2026-09.zip', ausgangsrechnungen: 1, eingangsbelege: 0, stornos: 0, zahlungen: 0, dokumente: 1, fehlendeDokumente: [], stornosOhneDatum: [] });
  });
});

describe('01D2 — Periodenwahrheit Storno/Korrektur', () => {
  const augustInvoice = () => invoice({
    id: 'inv-aug', number: 'RE-2026-050', issueDate: '2026-08-28', date: '2026-08-28',
    cancelledAt: '2026-09-10T08:00:00.000Z', cancelReason: 'Falscher Betrag', cancellationKind: 'correction', correctionNumber: 'RK-2026-003',
    payments: [{ id: 'pay-aug', date: '2026-09-01', amount: 119, createdAt: 'x' }],
  });

  it('Kontrollfall: Original im August, Korrektur im September; keine Doppelzaehlung; Korrektur-PDF in der Korrekturperiode', () => {
    const data = { invoices: [{ invoice: augustInvoice(), vorgangId: null }] };
    const august = buildMonatsmappeModel(input({ monthKey: '2026-08', ...data }));
    const september = buildMonatsmappeModel(input({ monthKey: '2026-09', ...data }));

    expect(august.ausgangsrechnungen.map((b) => [b.id, b.status, b.brutto, b.datum])).toEqual([['inv-aug', 'storniert', 119, '2026-08-28']]);
    expect(august.ausgangsrechnungen[0].documents.map((d) => d.kind)).toEqual(['invoice_pdf']);
    expect(august.ausgangsrechnungen[0].hinweis).toBe('Storniert am 2026-09-10, Korrektur RK-2026-003');
    expect(august.stornos).toEqual([]);

    expect(september.ausgangsrechnungen).toEqual([]);
    expect(september.stornos).toHaveLength(1);
    expect(september.stornos[0]).toMatchObject({ belegart: 'rechnungsstorno', id: 'inv-aug', belegnummer: 'RK-2026-003', datum: '2026-09-10', netto: -100, steuer: -19, brutto: -119, status: 'storno', documentStatus: 'generated' });
    expect(september.stornos[0].documents).toEqual([{ kind: 'invoice_correction_pdf', fileName: 'Korrektur_zu_RE-2026-050_aug.pdf' }]);
    expect(september.stornos[0].hinweis).toBe('Rechnungskorrektur zu RE-2026-050 vom 2026-08-28');
    // Zahlungen stornierter Rechnungen sind in keinem Monat aktiv.
    expect(august.zahlungenAusgang).toEqual([]);
    expect(september.zahlungenAusgang).toEqual([]);
    // Summe ueber beide Perioden = 0: einmal +, einmal - — keine Doppelzaehlung.
    const sum = [...august.ausgangsrechnungen, ...august.stornos, ...september.ausgangsrechnungen, ...september.stornos].reduce((acc, b) => acc + b.brutto, 0);
    expect(sum).toBe(0);

    const csv = buildUebersichtCsv(september);
    expect(csv).toContain('Rechnungsstorno;inv-aug;RK-2026-003;2026-09-10;Kunde A;-100,00;-19,00;-119,00;storno;storniert;0,00;ja;Stornos_Korrekturen/Korrektur_zu_RE-2026-050_aug.pdf;Rechnungskorrektur zu RE-2026-050 vom 2026-08-28');
  });

  it('Korrektur ohne correctionNumber (heutiger Cloud-Stand): Korrektur-PDF trotzdem im Stornomonat', () => {
    const data = { invoices: [{ invoice: invoice({ issueDate: '2026-08-28', date: '2026-08-28', cancelledAt: '2026-09-10T08:00:00.000Z', cancelReason: 'x', cancellationKind: 'correction' }), vorgangId: null }] };
    const september = buildMonatsmappeModel(input({ monthKey: '2026-09', ...data }));
    expect(september.stornos[0]).toMatchObject({ belegart: 'rechnungsstorno', belegnummer: 'Korrektur-RE-2026-001', documentStatus: 'generated' });
    expect(september.stornos[0].documents.map((d) => d.kind)).toEqual(['invoice_correction_pdf']);
  });

  it('Interner Storno: eigener Beleg ohne Dokument (kein Fehlzustand), Same-month bleibt korrekt', () => {
    const data = { invoices: [{ invoice: invoice({ cancelledAt: '2026-09-20T10:00:00.000Z', cancelReason: 'Doppelt', cancellationKind: 'internal' }), vorgangId: null }] };
    const model = buildMonatsmappeModel(input({ monthKey: '2026-09', ...data }));
    expect(model.ausgangsrechnungen.map((b) => [b.id, b.status])).toEqual([['inv-1', 'storniert']]);
    expect(model.stornos).toHaveLength(1);
    expect(model.stornos[0]).toMatchObject({ belegart: 'rechnungsstorno', belegnummer: 'RE-2026-001', datum: '2026-09-20', brutto: -119, documentStatus: 'none', documents: [] });
    expect(model.fehlendeDokumente).toEqual([]);
    expect(buildUebersichtCsv(model)).toContain(';storno;storniert;0,00;kein Beleg;;Interner Storno zu RE-2026-001 vom 2026-09-10 (kein Korrekturbeleg)');
    expect(buildMonatsmappeModel(input({ monthKey: '2026-10', ...data })).isEmpty).toBe(true);
  });

  it('Ausgabenstorno: mit cancelledAt im Stornomonat (negiert); ohne cancelledAt nur gekennzeichnet (Datenmodell-Luecke sichtbar)', () => {
    const data = { expenses: [
      expense({ id: 'exp-real-dated', issueDate: '2026-08-05', status: 'storniert', cancelledAt: '2026-09-02T00:00:00.000Z', cancelReason: 'Retoure' }),
      expense({ id: 'exp-real-legacy', issueDate: '2026-08-06', invoiceNumber: 'L-LEG', status: 'storniert' }),
    ] };
    const august = buildMonatsmappeModel(input({ monthKey: '2026-08', ...data }));
    const september = buildMonatsmappeModel(input({ monthKey: '2026-09', ...data }));
    expect(august.eingangsbelege.map((b) => [b.id, b.status, b.hinweis])).toEqual([
      ['exp-real-dated', 'storniert', 'Storniert am 2026-09-02'],
      ['exp-real-legacy', 'storniert', 'Storniert (Stornodatum nicht erfasst)'],
    ]);
    expect(august.stornos).toEqual([]);
    expect(august.stornosOhneDatum).toEqual([{ belegart: 'eingangsbeleg', id: 'exp-real-legacy', belegnummer: 'L-LEG' }]);
    expect(september.stornos.map((s) => [s.belegart, s.id, s.datum, s.brutto, s.hinweis])).toEqual([['ausgabenstorno', 'exp-real-dated', '2026-09-02', -59.5, 'Storno zu Eingangsbeleg vom 2026-08-05 — Retoure']]);
    expect(september.stornosOhneDatum).toEqual([]);
    expect(september.isEmpty).toBe(false);
  });

  it('ZIP: Korrektur-PDF liegt unter Stornos_Korrekturen im Stornomonat, nicht im Monat des Originals', async () => {
    const data = { invoices: [{ invoice: augustInvoice(), vorgangId: null }] };
    const aug = await buildMonatsmappeZip(buildMonatsmappeModel(input({ monthKey: '2026-08', ...data })), loaders());
    const sep = await buildMonatsmappeZip(buildMonatsmappeModel(input({ monthKey: '2026-09', ...data })), loaders());
    expect(aug.ok && sep.ok).toBe(true);
    if (!aug.ok || !sep.ok) return;
    const files = async (blob: Blob) => Object.keys((await JSZip.loadAsync(blob)).files).filter((p) => !p.endsWith('/')).sort();
    expect(await files(aug.blob)).toEqual(['2026-08/Ausgangsrechnungen/RE-2026-050_aug.pdf', '2026-08/Manifest.json', '2026-08/Uebersicht.csv', '2026-08/Zahlungen.csv']);
    expect(await files(sep.blob)).toEqual(['2026-09/Manifest.json', '2026-09/Stornos_Korrekturen/Korrektur_zu_RE-2026-050_aug.pdf', '2026-09/Uebersicht.csv', '2026-09/Zahlungen.csv']);
    const manifest = JSON.parse(await (await JSZip.loadAsync(sep.blob)).file('2026-09/Manifest.json')!.async('string'));
    expect(manifest.counts).toMatchObject({ ausgangsrechnungen: 0, stornos: 1, dokumente: 1 });
  });
});
