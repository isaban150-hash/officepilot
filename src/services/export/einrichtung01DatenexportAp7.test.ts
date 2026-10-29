/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.24) — lesbarer Export: Prüfung, feste Bindung (K5), Lückenexport, Inhalt, Abbruch.
 *
 * Katalog AP5–AP9 v2:
 *   D-05.1  offener Sync-Auftrag → die Prüfung nennt ihn; Export nur mit Lückenliste; der Export sendet nichts
 *   D-05.2  Datei nicht herunterladbar → Lückenliste und luecken.csv nennen sie
 *   D-05.3  alles abgeglichen → keine Lücke
 *   D-05.4  Konto- bzw. Betriebswechsel während des Exports → Abbruch ohne Datei
 *   D-05.5  Rollenminderung bzw. Entzug → Abbruch ohne Datei
 *   D-05.6  späte Antwort des früheren Kontos → verworfen
 *   D-05.7  offene Finanzaktion → als Lücke benannt, Export „unvollständig“, kein Paket-/Abschlussweg
 *   D-05.8  Abzug scheitert → Lückenliste nennt es
 *   D-05.9  nicht cloudbestätigte Daten → gekennzeichnet
 *   D-06.1  je Bereich alle Zeilen, Übersicht zählt richtig
 *   D-06.3  Geschäftstexte mit Markup → escaped, Inhaltsrichtlinie gesetzt
 *   D-06.4  Dateinamen bereinigt, Kollisionen aufgelöst
 *   D-08.1  Mitarbeiterzahlungen für andere Rollen verweigert
 *   D-09.1–3  Fortschritt, Abbruch ohne Datei, Download über den übergebenen Weg
 */
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import {
  buildAndDownloadDataExport,
  DATA_EXPORT_EMAIL_LIMIT,
  prepareDataExport,
  type BoundOperation,
  type DataExportDeps,
  type DataExportProgress,
} from './dataExportService';
import { buildEmployeePaymentsCsv, DataExportRoleError, type CloudStatusLookup } from './dataExportAreas';
import type { AppPersistedState } from '../../types/models';
import type { DocumentFileRef } from '../../types/documentFileRef';
import type { EmailMessage } from '../../types/emailMessage';
import type { SyncOutboxEntry } from '../../types/sync';

const ZEIT = new Date(2026, 9, 25, 8, 15);

function ref(id: string, name: string, extra: Partial<DocumentFileRef> = {}): DocumentFileRef {
  return {
    id,
    originalFileName: name,
    mimeType: 'application/pdf',
    fileSize: 4,
    contentHash: 'a'.repeat(64),
    storageType: 'indexeddb',
    localDataKey: id,
    createdAt: '2026-10-01T00:00:00.000Z',
    lifecycleStatus: 'committed',
    ...extra,
  } as DocumentFileRef;
}

function bestand(overrides: Partial<Record<string, unknown>> = {}): AppPersistedState {
  return {
    version: 6,
    savedAt: '2026-10-25T00:00:00.000Z',
    setup: { companyName: 'Muster Bau GmbH' },
    companyProfile: { companyName: 'Muster Bau GmbH' },
    inboxItems: [],
    customers: [
      { id: 'k1', name: 'Müller & Söhne', contactPerson: '', street: 'Weg 1', zip: '33602', city: 'Bielefeld', email: 'm@example.invalid', phone: '', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '' },
      { id: 'k2', name: '=HYPERLINK("x")', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '', createdAt: '', updatedAt: '' },
      { id: 'k-weg', name: 'Gelöscht', sync: { deleted: true } },
    ],
    vorgaenge: [{ id: 'v1', title: 'Dach', customer: 'Müller & Söhne', baustelle: 'Hof', status: 'beauftragt', orderPositions: [], invoices: [] }],
    offers: [],
    invoiceEntries: [
      {
        vorgangId: 'v1',
        invoice: {
          id: 'r1', number: 'RE-2026-0001', type: 'rechnung', status: 'versendet', date: '2026-10-02', createdAt: '', taxStatus: 'regelbesteuert',
          amount: 119, subtotal: 100, positions: [{ id: 'p1', description: 'Arbeit', quantity: 1, unit: 'stk', unitPrice: 100, lineTotal: 100 }],
          payments: [{ id: 'z1', date: '2026-10-05', amount: 119, createdAt: '', cloudBestaetigt: true }],
        },
      },
    ],
    expenses: [],
    documents: [
      { id: 'd1', title: 'Beleg <script>', category: 'sonstiges', issuer: '', recognizedText: '', issueDate: null, validUntil: null, tags: [], linkedCompany: '', linkedVorgang: null, fileRefId: 'f1', createdAt: '' },
      { id: 'd2', title: 'Zweiter Beleg', category: 'sonstiges', issuer: '', recognizedText: '', issueDate: null, validUntil: null, tags: [], linkedCompany: '', linkedVorgang: null, fileRefId: 'f2', createdAt: '' },
      { id: 'd3', title: 'Dritter', category: 'sonstiges', issuer: '', recognizedText: '', issueDate: null, validUntil: null, tags: [], linkedCompany: '', linkedVorgang: null, fileRefId: 'f3', createdAt: '' },
    ],
    businessLetters: [],
    tasks: [{ id: 't1', title: 'Anrufen', description: '', status: 'open', priority: 'normal', category: 'sonstiges', autoCreated: false, createdAt: '' }],
    knowledgeFacts: [],
    bankTransactions: [{ id: 'b1', accountKey: 'DE00', bookingDate: '2026-10-03', amountCents: -1250, currency: 'EUR', fileName: 'auszug.csv', importedAt: '' }],
    employees: [{ id: 'e1', name: 'Erika', active: true, createdAt: '' }],
    employeePayments: [{ id: 'ep1', employeeId: 'e1', employeeName: 'Erika', kind: 'wage', amount: 1500, paymentDate: '2026-10-10', paymentMethod: 'bank', receiptReference: 'Q-1', createdAt: '' }],
    accountingAssignments: [],
    ...overrides,
  } as unknown as AppPersistedState;
}

interface Welt {
  key: string;
  workspaceId: string | null;
  role: 'owner' | 'admin' | 'member' | null;
  serverRole: 'owner' | 'admin' | 'member' | null;
  outbox: SyncOutboxEntry[];
  pulls: number;
  downloads: Array<{ blob: Blob; name: string }>;
  valid: boolean;
}

function welt(): Welt {
  return { key: 'scope:A', workspaceId: 'ws-1', role: 'owner', serverRole: 'owner', outbox: [], pulls: 0, downloads: [], valid: true };
}

function deps(w: Welt, overrides: Partial<DataExportDeps> = {}): DataExportDeps {
  const bound: BoundOperation = { client: null, confirmed: true, stillValid: async () => w.valid };
  const lokal = new Map<string, Blob>([
    ['f1', new Blob(['%PDF'])],
    ['f2', new Blob(['%PDF'])],
  ]);
  return {
    now: () => ZEIT,
    cloudConfigured: () => true,
    storageKey: () => w.key,
    account: () => ({ userId: 'u1', email: 'inhaber@example.invalid' }),
    workspaceId: () => w.workspaceId,
    bind: async () => bound,
    refreshRole: async () => w.serverRole,
    currentRole: () => w.role,
    localExportAllowed: () => true,
    outbox: () => w.outbox,
    isHeld: () => false,
    cloudSyncAllowed: () => true,
    pull: async () => {
      w.pulls += 1;
      return 'ok';
    },
    snapshot: () => bestand(),
    lastPersistOk: () => true,
    fileRefs: () => [ref('f1', 'beleg.pdf'), ref('f2', 'Beleg.pdf'), ref('f3', '../../etc/passwd', { storageType: 'cloud', cloud: { storagePath: 'ws-1/x' } })],
    bindings: () => [],
    readLocalFile: async (r) => lokal.get(r.id) ?? null,
    downloadCloudFile: async () => new Uint8Array([1, 2, 3, 4]),
    listSentEmails: async () => ({ ok: true, messages: [] }),
    downloadEmailAttachment: async () => ({ ok: true, blob: new Blob(['anhang']) }),
    unconfirmedInvoicePayments: () => new Set(),
    unconfirmedFinance: () => [],
    invoiceNetCents: (invoice) => Math.round((invoice.subtotal ?? 0) * 100),
    invoiceOpenAmount: () => 0,
    documentFolder: () => 'dateien/dokumente',
    download: (blob, name) => {
      w.downloads.push({ blob, name });
      return { revoke: () => undefined };
    },
    ...overrides,
  };
}

function eintrag(extra: Partial<SyncOutboxEntry>): SyncOutboxEntry {
  return { id: 'o1', entityType: 'customer', entityId: 'k1', operation: 'update', version: 1, queuedAt: '2026-10-24T00:00:00.000Z', retryCount: 0, status: 'pending', sequence: 1, ...extra } as SyncOutboxEntry;
}

async function inhalt(blob: Blob): Promise<JSZip> {
  return JSZip.loadAsync(await blob.arrayBuffer());
}

describe('EINRICHTUNG-01 AP7 — lesbarer Export (1.24)', { timeout: 30_000 }, () => {
  it('D-05.3/D-06.1: alles abgeglichen → keine Lücke; je Bereich alle Zeilen; Übersicht zählt richtig', async () => {
    const w = welt();
    const d = deps(w);
    const vorbereitet = await prepareDataExport(d);
    expect(vorbereitet.ok).toBe(true);
    if (!vorbereitet.ok) return;
    expect(vorbereitet.prepared.gaps).toEqual([]);
    expect(w.pulls).toBe(1);
    const fertig = await buildAndDownloadDataExport(d, vorbereitet.prepared, { acceptGaps: false });
    expect(fertig.ok).toBe(true);
    if (!fertig.ok) return;
    expect(fertig.fileName).toBe('OfficeTakt_Export_Muster-Bau-GmbH_2026-10-25_08-15.zip');
    expect(fertig.incomplete).toBe(false);
    expect(w.downloads).toHaveLength(1);
    const zip = await inhalt(w.downloads[0].blob);
    const kunden = await zip.file('csv/kunden.csv')!.async('string');
    expect(kunden.split('\r\n').filter(Boolean)).toHaveLength(3); // Kopf + 2 aktive Kunden (Grabstein fehlt)
    const luecken = await zip.file('luecken.csv')!.async('string');
    expect(luecken.split('\r\n').filter(Boolean)).toHaveLength(1);
    const uebersicht = await zip.file('uebersicht.html')!.async('string');
    expect(uebersicht).toContain('<td>Kunden</td><td>csv/kunden.csv</td><td>2</td>');
    expect(uebersicht).toContain('<td>Rechnungen</td><td>csv/rechnungen.csv</td><td>1</td>');
    expect(uebersicht).toContain('<td>Bankumsätze</td><td>csv/bankumsaetze.csv</td><td>1</td>');
    expect(uebersicht).toContain('Vollständiger allgemeiner Datenexport');
    for (const pfad of ['csv/vorgaenge.csv', 'csv/angebote.csv', 'csv/angebotspositionen.csv', 'csv/rechnungspositionen.csv', 'csv/zahlungseingaenge.csv', 'csv/ausgaben.csv', 'csv/dokumente.csv', 'csv/briefe.csv', 'csv/emails_gesendet.csv', 'csv/aufgaben.csv', 'csv/wissen.csv', 'csv/mitarbeiter.csv', 'csv/mitarbeiterzahlungen.csv', 'csv/kontierungen.csv']) {
      expect(zip.file(pfad), pfad).toBeTruthy();
    }
    const bank = await zip.file('csv/bankumsaetze.csv')!.async('string');
    expect(bank).toContain(';-12,50;EUR;');
  });

  it('D-05.1: offener Auftrag → genannt, kein Abzug, kein Senden; ohne Annahme keine Datei, mit Annahme „unvollständig“', async () => {
    const w = welt();
    w.outbox = [eintrag({ status: 'pending' })];
    const d = deps(w);
    const vorbereitet = await prepareDataExport(d);
    expect(vorbereitet.ok).toBe(true);
    if (!vorbereitet.ok) return;
    expect(w.pulls).toBe(0);
    expect(vorbereitet.prepared.gaps.map((g) => g.kind)).toEqual(['pull_skipped', 'sync_open']);
    const ohne = await buildAndDownloadDataExport(d, vorbereitet.prepared, { acceptGaps: false });
    expect(ohne).toEqual({ ok: false, reason: 'gaps_not_accepted' });
    expect(w.downloads).toHaveLength(0);
    const mit = await buildAndDownloadDataExport(d, vorbereitet.prepared, { acceptGaps: true });
    expect(mit.ok && mit.fileName).toBe('OfficeTakt_Export_Muster-Bau-GmbH_2026-10-25_08-15_unvollstaendig.zip');
    const zip = await inhalt(w.downloads[0].blob);
    const luecken = await zip.file('luecken.csv')!.async('string');
    expect(luecken).toContain('Offene Änderungen');
    expect(luecken).toContain('Kein frischer Abzug');
    expect(await zip.file('uebersicht.html')!.async('string')).toContain('UNVOLLSTÄNDIGER allgemeiner Datenexport');
    // D-05.9 — der betroffene Kunde ist als nicht bestätigt gekennzeichnet.
    expect(await zip.file('csv/kunden.csv')!.async('string')).toMatch(/Müller & Söhne;.*;nicht in der Cloud bestätigt/);
  });

  it('D-05.2/D-06.4: nicht herunterladbare Datei → Lücke; Namen bereinigt, Kollisionen aufgelöst, Originalname in der CSV', async () => {
    const w = welt();
    const d = deps(w, { downloadCloudFile: async () => { throw new Error('404'); } });
    const vorbereitet = await prepareDataExport(d);
    expect(vorbereitet.ok).toBe(true);
    if (!vorbereitet.ok) return;
    const luecke = vorbereitet.prepared.gaps.find((g) => g.kind === 'file_unavailable');
    expect(luecke?.reference).toBe('f3');
    expect(luecke?.description).toContain('../../etc/passwd');
    const pfade = vorbereitet.prepared.files.map((f) => f.entry.zipPath);
    expect(pfade).toEqual(['dateien/dokumente/beleg.pdf', 'dateien/dokumente/Beleg-2.pdf', null]);
    const fertig = await buildAndDownloadDataExport(d, vorbereitet.prepared, { acceptGaps: true });
    expect(fertig.ok).toBe(true);
    const zip = await inhalt(w.downloads[0].blob);
    expect(Object.keys(zip.files).every((name) => !name.startsWith('/') && !name.split('/').includes('..'))).toBe(true);
    const dokumente = await zip.file('csv/dokumente.csv')!.async('string');
    expect(dokumente).toContain('../../etc/passwd');
    expect(dokumente).toContain('fehlt (siehe luecken.csv)');
  });

  it('D-05.4: Kontowechsel während des Dateiabrufs → Abbruch ohne Datei', async () => {
    const w = welt();
    const d = deps(w, {
      readLocalFile: async (r) => {
        if (r.id === 'f2') w.key = 'scope:B';
        return new Blob(['%PDF']);
      },
    });
    const vorbereitet = await prepareDataExport(d);
    expect(vorbereitet).toEqual({ ok: false, reason: 'binding_changed' });
    expect(w.downloads).toHaveLength(0);
  });

  it('D-05.4: Betriebswechsel nach der Prüfung → die Erstellung bricht ohne Datei ab', async () => {
    const w = welt();
    const d = deps(w);
    const vorbereitet = await prepareDataExport(d);
    expect(vorbereitet.ok).toBe(true);
    if (!vorbereitet.ok) return;
    w.workspaceId = 'ws-2';
    const fertig = await buildAndDownloadDataExport(d, vorbereitet.prepared, { acceptGaps: false });
    expect(fertig).toEqual({ ok: false, reason: 'binding_changed' });
    expect(w.downloads).toHaveLength(0);
  });

  it('D-05.5: Herabstufung bzw. Entzug → Abbruch ohne Datei (Prüfung und Erstellung)', async () => {
    const w = welt();
    const d = deps(w, {
      readLocalFile: async () => {
        w.role = 'member';
        return new Blob(['%PDF']);
      },
    });
    expect(await prepareDataExport(d)).toEqual({ ok: false, reason: 'binding_changed' });

    const w2 = welt();
    const d2 = deps(w2);
    const vorbereitet = await prepareDataExport(d2);
    expect(vorbereitet.ok).toBe(true);
    if (!vorbereitet.ok) return;
    w2.serverRole = 'member';
    expect(await buildAndDownloadDataExport(d2, vorbereitet.prepared, { acceptGaps: false })).toEqual({ ok: false, reason: 'binding_changed' });
    w2.serverRole = null;
    expect(await buildAndDownloadDataExport(d2, vorbereitet.prepared, { acceptGaps: false })).toEqual({ ok: false, reason: 'binding_changed' });
    expect(w2.downloads).toHaveLength(0);

    const w3 = welt();
    w3.serverRole = 'member';
    expect(await prepareDataExport(deps(w3))).toEqual({ ok: false, reason: 'not_allowed' });
  });

  it('D-05.6: späte Antwort nach dem Wechsel wird verworfen (kein Eintrag, keine Datei)', async () => {
    const w = welt();
    const d = deps(w, {
      downloadCloudFile: async () => {
        w.valid = false; // die Anmeldung gehört inzwischen einem anderen Konto
        return new Uint8Array([9, 9, 9, 9]);
      },
    });
    expect(await prepareDataExport(d)).toEqual({ ok: false, reason: 'binding_changed' });
    expect(w.downloads).toHaveLength(0);
  });

  it('D-05.7/D-05.8: Finanzzustand und gescheiterter Abzug stehen in der Lückenliste; Hinweis „kein Steuerberater-Paket“', async () => {
    const w = welt();
    const d = deps(w, {
      pull: async () => 'failed',
      unconfirmedFinance: () => [{ kind: 'finance_unconfirmed', area: 'Ausgaben', description: 'Ausgabe: wartet auf den Abgleich; wirkt ab 2026-10.', reference: 'x1' }],
    });
    const vorbereitet = await prepareDataExport(d);
    expect(vorbereitet.ok).toBe(true);
    if (!vorbereitet.ok) return;
    expect(vorbereitet.prepared.gaps.map((g) => g.kind)).toEqual(['pull_failed', 'finance_unconfirmed']);
    const fertig = await buildAndDownloadDataExport(d, vorbereitet.prepared, { acceptGaps: true });
    expect(fertig.ok && fertig.incomplete).toBe(true);
    const uebersicht = await (await inhalt(w.downloads[0].blob)).file('uebersicht.html')!.async('string');
    expect(uebersicht).toContain('kein Steuerberater-Paket');
    expect(uebersicht).toContain('wirkt ab 2026-10');
  });

  it('D-05.9: Betrieb ohne Cloud → „nur lokal“, kein Abzug, keine E-Mails', async () => {
    const w = welt();
    const listSentEmails = vi.fn(async () => ({ ok: true as const, messages: [] }));
    const d = deps(w, { cloudConfigured: () => false, listSentEmails });
    const vorbereitet = await prepareDataExport(d);
    expect(vorbereitet.ok).toBe(true);
    if (!vorbereitet.ok) return;
    expect(w.pulls).toBe(0);
    expect(listSentEmails).not.toHaveBeenCalled();
    expect(vorbereitet.prepared.binding.role).toBe('local');
    await buildAndDownloadDataExport(d, vorbereitet.prepared, { acceptGaps: vorbereitet.prepared.gaps.length > 0 });
    const kunden = await (await inhalt(w.downloads[0].blob)).file('csv/kunden.csv')!.async('string');
    expect(kunden).toContain('nur lokal');
  });

  it('D-06.3: Markup in Firmen-, Kunden- und Dateinamen ist escaped; Inhaltsrichtlinie default-src none', async () => {
    const w = welt();
    const boese = '<img src=x onerror=alert(1)> & "x" \'y\'';
    const d = deps(w, {
      snapshot: () => bestand({ companyProfile: { companyName: `<script>alert(1)</script>${boese}` } }),
      pull: async () => 'failed',
    });
    const vorbereitet = await prepareDataExport(d);
    expect(vorbereitet.ok).toBe(true);
    if (!vorbereitet.ok) return;
    await buildAndDownloadDataExport(d, vorbereitet.prepared, { acceptGaps: true });
    const html = await (await inhalt(w.downloads[0].blob)).file('uebersicht.html')!.async('string');
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'">`);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; &quot;x&quot; &#39;y&#39;');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('D-07 im Export: Formel-Anfang geschützt, Beträge als Zahl', async () => {
    const w = welt();
    const d = deps(w);
    const vorbereitet = await prepareDataExport(d);
    if (!vorbereitet.ok) throw new Error('vorbereitet');
    await buildAndDownloadDataExport(d, vorbereitet.prepared, { acceptGaps: false });
    const zip = await inhalt(w.downloads[0].blob);
    const kunden = await zip.file('csv/kunden.csv')!.async('string');
    expect(kunden).toContain(`;"'=HYPERLINK(""x"")";`);
    const rechnungen = await zip.file('csv/rechnungen.csv')!.async('string');
    expect(rechnungen).toContain(';100,00;19,00;119,00;0,00;EUR;');
  });

  it('D-08.1: Mitarbeiterzahlungen nur für Inhaber, Admin oder den lokalen Betrieb', () => {
    const lookup: CloudStatusLookup = { entity: () => 'confirmed', invoice: () => 'confirmed', invoicePayment: () => 'confirmed', expensePayment: () => 'confirmed' };
    expect(() => buildEmployeePaymentsCsv([], 'member', lookup)).toThrow(DataExportRoleError);
    expect(() => buildEmployeePaymentsCsv([], 'unbekannt', lookup)).toThrow(DataExportRoleError);
    for (const rolle of ['owner', 'admin', 'local'] as const) {
      expect(buildEmployeePaymentsCsv([], rolle, lookup).rows).toBe(0);
    }
  });

  it('D-09.1/D-09.2: Fortschritt nach Phasen und Dateien; Abbrechen beendet ohne Datei', async () => {
    const w = welt();
    const fortschritt: DataExportProgress[] = [];
    const vorbereitet = await prepareDataExport(deps(w), { onProgress: (p) => fortschritt.push(p) });
    expect(vorbereitet.ok).toBe(true);
    expect(fortschritt.map((p) => p.phase)).toEqual(expect.arrayContaining(['binding', 'pull', 'check', 'files']));
    expect(fortschritt.some((p) => p.phase === 'files' && p.total === 3)).toBe(true);

    const abbruch = new AbortController();
    const w2 = welt();
    const d2 = deps(w2, {
      readLocalFile: async () => {
        abbruch.abort();
        return new Blob(['%PDF']);
      },
    });
    expect(await prepareDataExport(d2, { signal: abbruch.signal })).toEqual({ ok: false, reason: 'cancelled' });
    expect(w2.downloads).toHaveLength(0);

    if (!vorbereitet.ok) return;
    const abbruch2 = new AbortController();
    abbruch2.abort();
    expect(await buildAndDownloadDataExport(deps(w), vorbereitet.prepared, { acceptGaps: false, signal: abbruch2.signal })).toEqual({ ok: false, reason: 'cancelled' });
    expect(w.downloads).toHaveLength(0);
  });

  it('E-Mails: gesendete E-Mails mit Text und Anhängen; Grenze der Serverliste als Lücke', async () => {
    const w = welt();
    const mail = (n: number): EmailMessage => ({
      id: `m${n}`, direction: 'outbound', status: 'provider_accepted', to: ['kunde@example.invalid'], cc: [], bcc: [], subject: `Rechnung ${n}`,
      bodyText: '-5 Zeilen', senderName: 'Muster', createdAt: '2026-10-20T10:00:00.000Z',
      attachments: n === 0 ? [{ position: 0, filename: 'rechnung.pdf', mimeType: 'application/pdf', sizeBytes: 6, sha256: 'b'.repeat(64), storagePath: 'ws-1/x/rechnung.pdf', storageBucket: 'email-attachments' }] : [],
      skippedAttachments: [],
    } as unknown as EmailMessage);
    const d = deps(w, { listSentEmails: async () => ({ ok: true, messages: Array.from({ length: DATA_EXPORT_EMAIL_LIMIT }, (_, n) => mail(n)) }) });
    const vorbereitet = await prepareDataExport(d);
    expect(vorbereitet.ok).toBe(true);
    if (!vorbereitet.ok) return;
    expect(vorbereitet.prepared.gaps.map((g) => g.kind)).toEqual(['emails_truncated']);
    await buildAndDownloadDataExport(d, vorbereitet.prepared, { acceptGaps: true });
    const zip = await inhalt(w.downloads[0].blob);
    expect(zip.file('dateien/emails/rechnung.pdf')).toBeTruthy();
    const mails = await zip.file('csv/emails_gesendet.csv')!.async('string');
    expect(mails.split('\r\n').filter(Boolean)).toHaveLength(DATA_EXPORT_EMAIL_LIMIT + 1);
    expect(mails).toContain(`;'-5 Zeilen;`);
  });

  it('Mitglied oder lokale Sperre: kein Export', async () => {
    const w = welt();
    expect(await prepareDataExport(deps(w, { localExportAllowed: () => false }))).toEqual({ ok: false, reason: 'not_allowed' });
    expect(await prepareDataExport(deps(w, { bind: async () => null }))).toEqual({ ok: false, reason: 'binding_changed' });
    expect(w.downloads).toHaveLength(0);
  });
});
