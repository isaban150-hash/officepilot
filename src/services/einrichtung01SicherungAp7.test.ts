/**
 * EINRICHTUNG-01 (AP7; Vertrag 1.23, F13) — Sicherung: Dateinamen, Zählung je Bereich vor dem Download und im
 * Manifest, Prüfung beim Einspielen (auch ältere Sicherungen ohne Zählung).
 *
 * Katalog AP5–AP9 v2:
 *   D-03.2  jeder Bereich belegt → Zählung je Bereich vollständig (Liste 1.23); Manifest gleich
 *   D-03.3  Dateinamen `OfficeTakt_Sicherung_…`, `OfficeTakt_Export_…`, `OfficeTakt_Steuerberater_…`, nie `OfficePilot_…`
 *
 * Neutrale synthetische Daten.
 */
import { useDocumentBlobDatabaseReset } from '../test/documentBlobTestReset';
import { beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildLocalBackupBundle, buildBackupFilename } from './backupExportService';
import { previewLocalBackupAreaCounts } from './backupAreaPreview';
import { buildBackupAreaCounts, parseBackupAreaCounts } from './backupAreaCounts';
import { validateLocalBackupZip } from './backupValidateService';
import {
  buildBackupFileName,
  buildDataExportFileName,
  buildSteuerberaterFileName,
  resolveBetriebName,
  sanitizeBetriebForFileName,
} from './exportFileNames';
import { buildMonatsmappeFilename } from './steuerberater/monatsmappeExportService';
import { storeDocumentFileFromUpload } from './documentFileStoreService';
import { hydrateVorgangStore } from './vorgangService';
import { addDocument } from './documentService';
import { hydrateCustomerStore } from './customerStoreService';
import { resetTestStores } from '../test/resetStores';
import { createTestVorgang } from '../test/fixtures';
import { BACKUP_AREA_KEYS } from '../types/backupExport';
import type { AppPersistedState, Customer } from '../types/models';
import { deBackup } from '../i18n/locales/de/backup';
import { trBackup } from '../i18n/locales/tr/backup';
import { bgBackup } from '../i18n/locales/bg/backup';

useDocumentBlobDatabaseReset();

const ZEIT = new Date(2026, 9, 25, 7, 4);

describe('EINRICHTUNG-01 AP7 — Dateinamen (1.23, D-03.3)', () => {
  it('Sicherung, Export und Steuerberater-Paket heißen OfficeTakt_…', () => {
    expect(buildBackupFileName('Muster Bau GmbH', ZEIT)).toBe('OfficeTakt_Sicherung_Muster-Bau-GmbH_2026-10-25_07-04.zip');
    expect(buildDataExportFileName('Muster Bau GmbH', ZEIT)).toBe('OfficeTakt_Export_Muster-Bau-GmbH_2026-10-25_07-04.zip');
    expect(buildDataExportFileName('Muster Bau GmbH', ZEIT, { incomplete: true })).toBe(
      'OfficeTakt_Export_Muster-Bau-GmbH_2026-10-25_07-04_unvollstaendig.zip',
    );
    expect(buildSteuerberaterFileName('2026-09')).toBe('OfficeTakt_Steuerberater_2026-09.zip');
    expect(buildMonatsmappeFilename('2026-09')).toBe('OfficeTakt_Steuerberater_2026-09.zip');
    expect(buildBackupFilename(ZEIT, 'Muster Bau GmbH')).toBe('OfficeTakt_Sicherung_Muster-Bau-GmbH_2026-10-25_07-04.zip');
    for (const name of [buildBackupFilename(ZEIT), buildDataExportFileName('', ZEIT), buildMonatsmappeFilename('2026-01')]) {
      expect(name).not.toMatch(/OfficePilot/);
    }
  });

  it('<Betrieb>: nur Buchstaben, Ziffern und Bindestrich, höchstens 40 Zeichen, sonst „Betrieb“', () => {
    const faelle: Array<[string | null | undefined, string]> = [
      ['Müller & Söhne GmbH', 'Müller-Söhne-GmbH'],
      ['Şahin İnşaat Ltd. Şti.', 'Şahin-İnşaat-Ltd-Şti'],
      ['Строй ЕООД', 'Строй-ЕООД'],
      ['../../etc/passwd', 'etc-passwd'],
      ['C:\\Windows\\x', 'C-Windows-x'],
      ['\\\\server\\freigabe', 'server-freigabe'],
      ['Firma\u0000mit\u0007Steuerzeichen\n', 'Firma-mit-Steuerzeichen'],
      ['ＡＢＣ　Ｂａｕ', 'ABC-Bau'],
      ['Bau 🏗️ Profi', 'Bau-Profi'],
      ['---', 'Betrieb'],
      ['   ', 'Betrieb'],
      ['', 'Betrieb'],
      [null, 'Betrieb'],
      [undefined, 'Betrieb'],
    ];
    for (const [eingabe, erwartet] of faelle) {
      expect(sanitizeBetriebForFileName(eingabe), String(eingabe)).toBe(erwartet);
    }
    const lang = sanitizeBetriebForFileName('Sehr Lange Firmenbezeichnung für Bauleistungen und Sanierung GmbH & Co. KG');
    expect(Array.from(lang).length).toBeLessThanOrEqual(40);
    expect(lang).toMatch(/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u);
    // Kein Bindestrich am Ende nach dem Kürzen.
    expect(sanitizeBetriebForFileName(`${'A'.repeat(39)} B`)).toBe('A'.repeat(39));
    expect(Array.from(sanitizeBetriebForFileName('Ä'.repeat(60))).length).toBe(40);
  });

  it('der Name kommt aus Firmenprofil, sonst Einrichtung, sonst Betriebsname', () => {
    expect(resolveBetriebName({ companyProfile: { companyName: ' Profil GmbH ' }, setup: { companyName: 'Setup' } })).toBe('Profil GmbH');
    expect(resolveBetriebName({ companyProfile: { companyName: '' }, setup: { companyName: 'Setup KG' } })).toBe('Setup KG');
    expect(resolveBetriebName({ companyProfile: { companyName: '' }, setup: { companyName: '' }, workspace: { name: 'Cloud-Betrieb' } })).toBe('Cloud-Betrieb');
    expect(resolveBetriebName({})).toBe('');
  });
});

describe('EINRICHTUNG-01 AP7 — Zählung je Bereich (1.23, D-03.2)', () => {
  beforeEach(() => {
    resetTestStores();
  });

  it('jeder der 17 Bereiche wird gezählt, in der Reihenfolge der Liste 1.23', () => {
    expect(BACKUP_AREA_KEYS).toEqual([
      'customers', 'vorgaenge', 'offers', 'invoices', 'payments', 'expenses', 'documents', 'files', 'letters', 'emails',
      'tasks', 'knowledge', 'bankTransactions', 'employees', 'employeePayments', 'accountingAssignments', 'settings',
    ]);
    const zwei = [{}, {}];
    const state = {
      version: 6,
      savedAt: '2026-10-25T00:00:00.000Z',
      setup: {},
      companyProfile: {},
      workspaceSettings: {},
      customers: [{}, {}, {}],
      vorgaenge: [{ invoices: [] }],
      offers: zwei,
      invoiceEntries: [
        { vorgangId: null, invoice: { payments: [{}, {}] } },
        { vorgangId: null, invoice: { payments: [{}] } },
        { vorgangId: null, invoice: {} },
      ],
      expenses: [{ payments: [{}] }, {}],
      documents: [{}, {}, {}, {}],
      businessLetters: [{}],
      mailImports: zwei,
      tasks: [{}, {}, {}],
      knowledgeFacts: [{}],
      bankTransactions: [{}, {}, {}, {}, {}],
      employees: zwei,
      employeePayments: [{}, {}, {}],
      accountingAssignments: [{}],
      inboxItems: [],
    } as unknown as AppPersistedState;
    expect(buildBackupAreaCounts(state, 7)).toEqual({
      customers: 3,
      vorgaenge: 1,
      offers: 2,
      invoices: 3,
      payments: 4,
      expenses: 2,
      documents: 4,
      files: 7,
      letters: 1,
      emails: 2,
      tasks: 3,
      knowledge: 1,
      bankTransactions: 5,
      employees: 2,
      employeePayments: 3,
      accountingAssignments: 1,
      settings: 3,
    });
  });

  it('ein Altbestand ohne Rechnungsablage zählt die Rechnungen in den Vorgängen', () => {
    const state = {
      version: 5,
      savedAt: '',
      setup: {},
      inboxItems: [],
      tasks: [],
      documents: [],
      vorgaenge: [{ invoices: [{ payments: [{}] }, {}] }, { invoices: [{}] }],
    } as unknown as AppPersistedState;
    const counts = buildBackupAreaCounts(state, 0);
    expect(counts.invoices).toBe(3);
    expect(counts.payments).toBe(1);
    expect(counts.settings).toBe(1);
  });

  it('Vorschau vor dem Download = Manifest = Prüfvorschau beim Einspielen', async () => {
    hydrateCustomerStore([
      { id: 'k-ap7-1', name: 'Kunde Eins' } as unknown as Customer,
      { id: 'k-ap7-2', name: 'Kunde Zwei' } as unknown as Customer,
    ]);
    hydrateVorgangStore([createTestVorgang({ id: 'vg-ap7-sicherung' })]);
    expect(addDocument({ title: 'Prüfdokument AP7', category: 'vertrag', recognizedText: 'Inhalt' }).success).toBe(true);
    await storeDocumentFileFromUpload(new File([new Uint8Array([1, 2, 3])], 'beleg.pdf', { type: 'application/pdf' }));

    const vorher = previewLocalBackupAreaCounts();
    expect(vorher.customers).toBe(2);
    expect(vorher.vorgaenge).toBe(1);
    expect(vorher.documents).toBe(1);
    expect(vorher.files).toBe(1);

    const built = await buildLocalBackupBundle(ZEIT);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.artifacts.manifest.areaCounts).toEqual(vorher);
    // Der Testbestand heißt „Test GmbH“ (resetTestStores); der Name kommt aus dem Firmenprofil.
    expect(built.artifacts.filename).toBe('OfficeTakt_Sicherung_Test-GmbH_2026-10-25_07-04.zip');

    const zip = await JSZip.loadAsync(built.artifacts.zipBlob);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    expect(parseBackupAreaCounts(manifest.areaCounts)).toEqual(vorher);

    const geprueft = await validateLocalBackupZip(built.artifacts.zipBlob);
    expect(geprueft.ok).toBe(true);
    if (!geprueft.ok) return;
    expect(geprueft.preview.areaCounts).toEqual(vorher);
    expect(geprueft.manifest.areaCounts).toEqual(vorher);
  });

  it('eine abweichende Zählung im Manifest wird abgewiesen; eine ältere Sicherung ohne Zählung bleibt gültig', async () => {
    hydrateVorgangStore([createTestVorgang({ id: 'vg-ap7-alt' })]);
    const built = await buildLocalBackupBundle(ZEIT);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const zip = await JSZip.loadAsync(built.artifacts.zipBlob);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));

    const manipuliert = await JSZip.loadAsync(built.artifacts.zipBlob);
    manipuliert.file('manifest.json', JSON.stringify({ ...manifest, areaCounts: { ...manifest.areaCounts, vorgaenge: 9 } }));
    const abgewiesen = await validateLocalBackupZip(await manipuliert.generateAsync({ type: 'uint8array' }));
    expect(abgewiesen.ok).toBe(false);
    if (!abgewiesen.ok) expect(abgewiesen.errorKey).toBe('backup.validate.error.manifest');

    const ungueltig = await JSZip.loadAsync(built.artifacts.zipBlob);
    ungueltig.file('manifest.json', JSON.stringify({ ...manifest, areaCounts: { vorgaenge: 1 } }));
    expect((await validateLocalBackupZip(await ungueltig.generateAsync({ type: 'uint8array' }))).ok).toBe(false);

    const alt = await JSZip.loadAsync(built.artifacts.zipBlob);
    const ohneZaehlung = { ...manifest };
    delete ohneZaehlung.areaCounts;
    alt.file('manifest.json', JSON.stringify(ohneZaehlung));
    const altGeprueft = await validateLocalBackupZip(await alt.generateAsync({ type: 'uint8array' }));
    expect(altGeprueft.ok).toBe(true);
    if (!altGeprueft.ok) return;
    expect(altGeprueft.manifest.areaCounts).toBeUndefined();
    expect(altGeprueft.preview.areaCounts.vorgaenge).toBe(1);
  });
});

describe('EINRICHTUNG-01 AP7 — Texte (1.23, D-03.1)', () => {
  it('de, tr, bg: die Sicherung betrifft diesen Betrieb auf diesem Gerät; alle 17 Bereiche benannt', () => {
    expect(deBackup['backup.hint']).toContain('Die Sicherung enthält die Daten dieses Betriebs auf diesem Gerät');
    expect(deBackup['backup.validate.replaceHint']).toBe('Die Wiederherstellung ersetzt die Daten dieses Betriebs auf diesem Gerät.');
    for (const texte of [deBackup, trBackup, bgBackup] as Array<Record<string, string>>) {
      for (const key of ['backup.hint', 'backup.validate.replaceHint', 'backup.restore.confirm', 'backup.restore.error.notConfirmed']) {
        expect(texte[key], key).not.toMatch(/alle lokalen|in diesem Browser|bu tarayıcıdaki tüm|в този браузър/);
      }
      for (const key of BACKUP_AREA_KEYS) {
        expect(texte[`backup.area.${key}`]?.trim().length ?? 0, `backup.area.${key}`).toBeGreaterThan(0);
      }
      expect(texte['backup.counts.title']?.length ?? 0).toBeGreaterThan(0);
      expect(texte['backup.counts.emailsHint']?.length ?? 0).toBeGreaterThan(0);
      expect(texte['backup.validate.contentTitle']?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
