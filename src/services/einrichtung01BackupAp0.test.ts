/**
 * EINRICHTUNG-01 (AP0, EIN-04, EIN-05, EIN-31, E9) — Datensicherung: Prüfung, Download, Lücken, Cloud-Sperre.
 *
 * Katalog V3:
 *   S-10.1/.2  Geschäftstexte, die nur wie Zugangsdaten aussehen, sperren weder Sicherung noch Wiederherstellung
 *   S-10.3     im Cloud-Betrieb keine Wiederherstellung aus einer lokalen Sicherung, Bestand unverändert
 *   S-11.1–.4  echte Zugangsstrukturen werden abgelehnt; der Befund nennt den Pfad, nie den Wert
 *   S-12.2     die Meldung sagt „Download gestartet“, nie „gesichert“
 *   S-13.1–.4  fehlende Dateien werden benannt; ohne Zustimmung keine Sicherung, mit Zustimmung eine
 *              gekennzeichnete Teilsicherung, die beim Einspielen die Lücke zeigt
 *
 * Neutrale synthetische Daten; die JWT-förmigen Werte sind erfunden.
 */
import { useDocumentBlobDatabaseReset } from '../test/documentBlobTestReset';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { buildLocalBackupBundle, buildSanitizedBackupAppState } from './backupExportService';
import { validateLocalBackupZip } from './backupValidateService';
import { isCloudWorkspaceScopeActive, restoreLocalBackupBundle } from './backupRestoreService';
import { findBackupCredentialPaths } from './backupCredentialScan';
import { getDocumentFileRefStoreSnapshot, storeDocumentFileFromUpload } from './documentFileStoreService';
import { deleteDocumentBlob } from './storage/documentBlobIndexedDbService';
import { setActiveStorageScope } from './storage/storageScopeService';
import { resetSyncClientForTests } from './sync/syncClientService';
import { hydrateSyncOutbox } from './sync/syncOutboxService';
import { hydrateVorgangStore, getAllVorgaenge } from './vorgangService';
import { addVorgangNote } from './vorgangNoteService';
import { addDocument, getAllDocuments } from './documentService';
import { buildPersistedStateSnapshot } from './persistenceService';
import { resetTestStores } from '../test/resetStores';
import { createTestVorgang } from '../test/fixtures';
import { deBackup } from '../i18n/locales/de/backup';
import { trBackup } from '../i18n/locales/tr/backup';
import { bgBackup } from '../i18n/locales/bg/backup';

const ERFUNDENES_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJiZWlzcGllbCJ9.c2lnbmF0dXItYmVpc3BpZWw';
const ERFUNDENES_REFRESH = 'refresh-beispiel-1234567890';

function liveClient(): void {
  resetSyncClientForTests({
    deviceId: 'ein01-device',
    workspaceId: 'ein01-ws',
    createdAt: '2026-01-01T00:00:00.000Z',
    syncPolicy: 'local_only',
  });
}

/** Ein Bestand mit Texten, die nur wie Zugangsdaten aussehen (S-10.1). */
function verdaechtigeGeschaeftstexte(): void {
  hydrateVorgangStore([
    createTestVorgang({
      id: 'vg-ein01-tsb',
      customer: 'TSB-Bau',
      customerBilling: {
        name: 'TSB-Bau',
        contactPerson: 'B. Bauleiter',
        street: 'Bauweg 1',
        zip: '33602',
        city: 'Bielefeld',
        email: 'info@xsb-bau.de',
        phone: '',
      },
    }),
  ]);
  expect(addVorgangNote('vg-ein01-tsb', { body: 'password fuer das Baustellen-WLAN beim Bauleiter erfragen' }).success).toBe(true);
  expect(
    addDocument({
      title: 'Schnittstellenbeschreibung',
      category: 'vertrag',
      recognizedText: `Der Abruf erfolgt mit dem Kopf "Authorization: Bearer ${ERFUNDENES_JWT}".`,
    }).success,
  ).toBe(true);
}

/** Fachbestand und Browserspeicher — was eine Wiederherstellung ersetzen würde. */
function bestandUndSpeicher(): string {
  const speicher: Record<string, string | null> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)!;
    speicher[key] = localStorage.getItem(key);
  }
  return JSON.stringify({
    vorgaenge: getAllVorgaenge(),
    dokumente: getAllDocuments(),
    notizen: buildPersistedStateSnapshot().vorgangNotes,
    refs: getDocumentFileRefStoreSnapshot(),
    speicher,
  });
}

async function mitGeaendertemZustand(change: (state: Record<string, unknown>) => void): Promise<Uint8Array> {
  const built = await buildLocalBackupBundle(new Date(2026, 9, 1, 9, 0));
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error('build_failed');
  const zip = await JSZip.loadAsync(built.artifacts.zipBlob);
  const state = JSON.parse(await zip.file('app-state.json')!.async('string')) as Record<string, unknown>;
  change(state);
  zip.file('app-state.json', JSON.stringify(state));
  return zip.generateAsync({ type: 'uint8array' });
}

useDocumentBlobDatabaseReset();

beforeEach(() => {
  resetTestStores();
  setActiveStorageScope({ type: 'guest' });
  liveClient();
  hydrateSyncOutbox([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  setActiveStorageScope({ type: 'guest' });
});

describe('S-10 Geschäftstexte sind keine Zugangsdaten', () => {
  it('S-10.1/S-10.2: Sicherung, Prüfung und Wiederherstellung gelingen; die Inhalte kommen unverändert zurück', async () => {
    verdaechtigeGeschaeftstexte();
    const vorher = JSON.stringify({ vorgaenge: getAllVorgaenge(), dokumente: getAllDocuments(), notizen: buildPersistedStateSnapshot().vorgangNotes });
    expect(findBackupCredentialPaths(buildSanitizedBackupAppState())).toEqual([]);

    const built = await buildLocalBackupBundle(new Date(2026, 9, 1, 9, 0));
    expect(built, JSON.stringify(built)).toMatchObject({ ok: true });
    if (!built.ok) return;
    const validated = await validateLocalBackupZip(built.artifacts.zipBlob);
    expect(validated, JSON.stringify(validated)).toMatchObject({ ok: true });
    if (!validated.ok) return;

    // Anderer Stand auf dem Gerät, dann wiederherstellen (Sicherheitsbackup läuft vorher durch).
    resetTestStores();
    setActiveStorageScope({ type: 'guest' });
    liveClient();
    const phasen: string[] = [];
    const result = await restoreLocalBackupBundle(
      { validated, confirmed: true, reload: false },
      { onPhase: (phase) => phasen.push(phase), reload: () => {} },
    );
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(phasen[0]).toBe('safety_backup');
    const nachher = JSON.stringify({ vorgaenge: getAllVorgaenge(), dokumente: getAllDocuments(), notizen: buildPersistedStateSnapshot().vorgangNotes });
    expect(nachher).toBe(vorher);
  });

  it('S-10.3: im Cloud-Betrieb wird nicht wiederhergestellt; nichts wird ersetzt', async () => {
    verdaechtigeGeschaeftstexte();
    const built = await buildLocalBackupBundle();
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const validated = await validateLocalBackupZip(built.artifacts.zipBlob);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    setActiveStorageScope({ type: 'workspace', workspaceId: 'ws-ein01-cloud', account: { userId: 'usr-ein01', access: 'full' } });
    expect(isCloudWorkspaceScopeActive()).toBe(true);
    const vorher = bestandUndSpeicher();
    const phasen: string[] = [];
    const result = await restoreLocalBackupBundle(
      { validated, confirmed: true, reload: false },
      { onPhase: (phase) => phasen.push(phase), reload: () => {} },
    );
    expect(result).toEqual({ ok: false, reason: 'cloud_workspace', errorKey: 'backup.restore.error.cloudWorkspace' });
    expect(phasen).toEqual([]);
    expect(bestandUndSpeicher()).toBe(vorher);
  });
});

describe('S-11 echte Zugangsstrukturen', () => {
  it('S-11.1: ein Sitzungsschlüssel sb-<ref>-auth-token auf oberster Ebene wird abgelehnt', async () => {
    const bytes = await mitGeaendertemZustand((state) => {
      state['sb-abcdefgh-auth-token'] = JSON.stringify({ access_token: ERFUNDENES_JWT });
    });
    const result = await validateLocalBackupZip(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('non_importable_fields');
    expect(result.secretPaths).toContain('$.sb-abcdefgh-auth-token');
  });

  it('S-11.2: eine Auth-Struktur in beliebiger Tiefe wird abgelehnt', async () => {
    hydrateVorgangStore([createTestVorgang({ id: 'vg-ein01-tief' })]);
    const bytes = await mitGeaendertemZustand((state) => {
      (state.vorgaenge as Array<Record<string, unknown>>)[0].anhang = {
        tief: [{ sitzung: { access_token: ERFUNDENES_JWT, refresh_token: ERFUNDENES_REFRESH, token_type: 'bearer' } }],
      };
    });
    const result = await validateLocalBackupZip(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.secretPaths?.[0]).toBe('$.vorgaenge[0].anhang.tief[0].sitzung.refresh_token');
  });

  it('S-11.2: ein Access-Token auf oberster Ebene des Zustands wird abgelehnt', () => {
    expect(findBackupCredentialPaths({ version: 5, accessToken: 'geheim' })).toEqual(['$.accessToken']);
    expect(findBackupCredentialPaths({ version: 5, session: { user: {} } })).toEqual(['$.session']);
  });

  it('S-11.3: ein freier Schlüssel password ohne Auth-Struktur sperrt nicht', async () => {
    hydrateVorgangStore([createTestVorgang({ id: 'vg-ein01-frei' })]);
    const bytes = await mitGeaendertemZustand((state) => {
      (state.vorgaenge as Array<Record<string, unknown>>)[0].zugang = { password: 'nur ein Feldname im Bestand' };
    });
    const result = await validateLocalBackupZip(bytes);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    // Erst zusammen mit einer Kennung wird es ein Zugangspaar.
    expect(findBackupCredentialPaths({ a: { email: 'x@example.invalid', password: 'p' } })).toEqual(['$.a.password']);
  });

  it('S-11.4: der Befund nennt den Pfad, nie den Wert — weder im Ergebnis noch im Protokoll', async () => {
    const protokoll: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        protokoll.push(args.map(String).join(' '));
      });
    }
    const bytes = await mitGeaendertemZustand((state) => {
      state.auth = { access_token: ERFUNDENES_JWT, refresh_token: ERFUNDENES_REFRESH };
    });
    const result = await validateLocalBackupZip(bytes);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.secretPaths).toEqual(['$.auth.refresh_token']);
    const text = JSON.stringify(result) + protokoll.join('\n');
    expect(text).not.toContain(ERFUNDENES_JWT);
    expect(text).not.toContain(ERFUNDENES_REFRESH);
  });

  it('EIN-04: eine Sicherung mit Zugangsdaten entsteht gar nicht erst', async () => {
    const state = buildSanitizedBackupAppState();
    const mitSitzung = { ...state, session: { access_token: ERFUNDENES_JWT } };
    expect(findBackupCredentialPaths(mitSitzung)).toEqual(['$.session']);
  });
});

describe('S-12.2 ehrliche Meldung', () => {
  it('die Erfolgsmeldung sagt „Download gestartet“, nie „gesichert“ — in allen Produktsprachen vorhanden', () => {
    expect(deBackup['backup.success']).toMatch(/Download .*gestartet/);
    expect(deBackup['backup.success']).not.toMatch(/gesichert|heruntergeladen\./);
    expect(deBackup['backup.successPartial']).toMatch(/Teilsicherung/);
    expect(deBackup['backup.successPartial']).not.toMatch(/vollständig/i);
    for (const key of [
      'backup.success', 'backup.successPartial', 'backup.error.missingFile', 'backup.missing.allowPartial',
      'backup.missing.cancel', 'backup.missing.hint', 'backup.missing.unnamed', 'backup.error.credentials',
      'backup.export.notAllowed', 'backup.restore.cloudBlocked', 'backup.restore.error.cloudWorkspace',
      'backup.validate.incomplete', 'backup.restore.confirmIncomplete',
    ] as const) {
      expect(trBackup[key], `tr ${key}`).toBeTruthy();
      expect(bgBackup[key], `bg ${key}`).toBeTruthy();
    }
  });
});

describe('S-13 fehlende Dateien', () => {
  async function bestandMitFehlenderDatei(): Promise<{ fehlendId: string; vorhandenId: string }> {
    const fehlend = await storeDocumentFileFromUpload(new File([new Uint8Array([7, 7])], 'Aufmass Bad.pdf', { type: 'application/pdf' }));
    const vorhanden = await storeDocumentFileFromUpload(new File([new Uint8Array([1, 2, 3])], 'Angebot.pdf', { type: 'application/pdf' }));
    await deleteDocumentBlob(fehlend.fileRef.id);
    return { fehlendId: fehlend.fileRef.id, vorhandenId: vorhanden.fileRef.id };
  }

  it('S-13.1/S-13.4: ohne Zustimmung entsteht keine Sicherung; die Meldung nennt die fehlende Datei; der Bestand bleibt', async () => {
    const { fehlendId } = await bestandMitFehlenderDatei();
    const refsVorher = JSON.stringify(getDocumentFileRefStoreSnapshot());
    const built = await buildLocalBackupBundle();
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe('missing_blob');
    expect(built.errorKey).toBe('backup.error.missingFile');
    expect(built.missingFiles).toEqual([{ fileRefId: fehlendId, originalFileName: 'Aufmass Bad.pdf' }]);
    expect('artifacts' in built).toBe(false);
    expect(JSON.stringify(getDocumentFileRefStoreSnapshot())).toBe(refsVorher);
  });

  it('S-13.2/S-13.3: mit Zustimmung eine gekennzeichnete Teilsicherung; die Prüfung zeigt die Lücke vor dem Ersetzen', async () => {
    const { fehlendId, vorhandenId } = await bestandMitFehlenderDatei();
    const built = await buildLocalBackupBundle(new Date(2026, 9, 1, 9, 0), { allowMissingFiles: true });
    expect(built, JSON.stringify(built)).toMatchObject({ ok: true });
    if (!built.ok) return;
    const { manifest } = built.artifacts;
    expect(manifest.incomplete).toBe(true);
    expect(manifest.missingFiles).toEqual([{ fileRefId: fehlendId, originalFileName: 'Aufmass Bad.pdf' }]);
    expect(manifest.files.map((f) => f.fileRefId)).toEqual([vorhandenId]);
    const zip = await JSZip.loadAsync(built.artifacts.zipBlob);
    expect(zip.file(`files/${fehlendId}`)).toBeNull();

    const validated = await validateLocalBackupZip(built.artifacts.zipBlob);
    expect(validated, JSON.stringify(validated)).toMatchObject({ ok: true });
    if (!validated.ok) return;
    expect(validated.preview.incomplete).toBe(true);
    expect(validated.preview.missingFiles).toEqual([{ fileRefId: fehlendId, originalFileName: 'Aufmass Bad.pdf' }]);
  });

  it('S-13.2: eine als vollständig ausgegebene Sicherung mit Lücke wird nicht angenommen', async () => {
    await bestandMitFehlenderDatei();
    const built = await buildLocalBackupBundle(new Date(2026, 9, 1, 9, 0), { allowMissingFiles: true });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const zip = await JSZip.loadAsync(built.artifacts.zipBlob);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as Record<string, unknown>;
    delete manifest.incomplete;
    delete manifest.missingFiles;
    zip.file('manifest.json', JSON.stringify(manifest));
    const result = await validateLocalBackupZip(await zip.generateAsync({ type: 'uint8array' }));
    expect(result.ok).toBe(false);
  });
});
