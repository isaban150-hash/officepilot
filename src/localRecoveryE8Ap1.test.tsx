/**
 * EINRICHTUNG-01 (AP1, E8, EIN-07) — Notfallseiten und Kontotrennung (Katalog V3, Gruppe T).
 *
 * Echte Freigaberegel ohne Testbaustein: Die Identität bestätigt das Auth-Mock wie der Server (`auth.getUser`), die
 * Rolle im alten Betriebsbestand liefert `get_workspace_access` je angemeldetem Konto.
 *
 *   T-01.1 abgemeldet: Gastbestand sichtbar und sicherbar; gebundene Bestände nur als Anzahl.
 *   T-01.2 abgemeldet: DOM, Konsole und Export ohne Kennungen, E-Mails, Namen oder Details gebundener Bestände.
 *   T-01.3 Gastbestand mit manipulierter Dateireferenz auf eine Datei von O1: Datei nicht im Gastexport.
 *   T-02.1 Anmeldung auf der Notfallseite als O1: nur O1-Bestände; M1 bleibt verborgen.
 *   T-02.2 gespeicherte gültige Sitzung von O1: Identität vor dem Export beim Server bestätigt, danach Export.
 *   T-02.3 Sitzung nicht bestätigbar (auch erst kurz vor dem Export): keine Freigabe, Anmeldung nötig.
 *   T-02.4 offline: gebundene Bestände gesperrt; Hinweis, dass die Daten unverändert bleiben.
 *   T-02.5 als M1: nur M1-Bestände; O1 und der alte Betriebsbestand (nur Inhaber/Admin) verborgen.
 *   T-03.1 /local-recovery/import: dieselben Regeln für Zielbereiche und Marker.
 *   N-T1.3 Notfallexport ohne Sitzungsschlüssel und Tokens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import JSZip from 'jszip';
import { RootShell } from './RootShell';
import { saveDocumentBlob, resetDocumentBlobDatabaseForTests } from './services/storage/documentBlobIndexedDbService';
import { getSupabaseClient } from './lib/supabase';
import { clearMockRpcHandlers, registerMockRpcHandler } from './test/mockProfileStore';
import { login, registerAndApproveUser, resetAuthForTests } from './test/authFixtures';
import { getMockCurrentSession, getMockGetUserCallCount, setMockGetUserFailure } from './test/mockSupabaseAuth';
import { resetTestStores } from './test/resetStores';
import { buildQuarantineMarkerKey } from './types/emergencyBackupQuarantine';

const WS = 'ws-e8-geheim';
const PASSWORT = 'TestPasswort1';
const O1_MAIL = 'o1-e8@example.invalid';
const M1_MAIL = 'm1-e8@example.invalid';
const O1_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x4f, 0x31, 0x4f, 0x31]);

let o1 = '';
let m1 = '';
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let konsole: string[] = [];

function zustand(company: string, extra: Record<string, unknown> = {}, betrieb: string | null = WS): string {
  return JSON.stringify({
    version: 5,
    setup: { companyName: company, setupComplete: true, setupVersion: 1, language: 'de' },
    companyProfile: { companyName: company, street: betrieb ? 'Geheimweg 7' : 'Gastweg 1', iban: 'DE89370400440532013000' },
    syncClient: betrieb
      ? { deviceId: 'geraet-e8', workspaceId: betrieb, serverWorkspaceId: betrieb, syncPolicy: 'cloud_ready' }
      : { deviceId: 'geraet-e8', workspaceId: 'lokal', syncPolicy: 'local_only' },
    vorgaenge: [{ id: 'v-1' }],
    documents: [],
    savedAt: '2026-10-20T08:00:00.000Z',
    ...extra,
  });
}

const schluessel = {
  gast: 'officepilot-state:guest',
  o1Konto: () => `officepilot-state:workspace:${WS}:account:${o1}:full`,
  m1Konto: () => `officepilot-state:workspace:${WS}:account:${m1}:member`,
  o1Nutzer: () => `officepilot-state:user:${o1}`,
  altBetrieb: `officepilot-state:workspace:${WS}`,
};

const GEHEIM = () => [o1, m1, WS, O1_MAIL, M1_MAIL, 'Inhaber Geheim GmbH', 'Mitglied Geheim GmbH', 'Inhaber Nutzerbestand', 'Alt Betrieb GmbH', 'Geheimweg'];

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function renderRoot(pathname: string): Promise<HTMLDivElement> {
  window.history.pushState({}, '', pathname);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<RootShell />);
  });
  await settle();
  return host;
}

const q = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`);

function setValue(element: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function anmelden(c: HTMLElement, mail: string): Promise<void> {
  await act(async () => {
    setValue(q(c, 'local-recovery-login-email') as HTMLInputElement, mail);
    setValue(q(c, 'local-recovery-login-password') as HTMLInputElement, PASSWORT);
  });
  await act(async () => {
    (q(c, 'local-recovery-login') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

function downloads() {
  const blobs: Blob[] = [];
  const originalCreate = URL.createObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = ((blob: Blob) => {
    blobs.push(blob);
    return 'blob:e8';
  }) as typeof URL.createObjectURL;
  HTMLAnchorElement.prototype.click = function () {};
  return {
    blobs,
    restore() {
      URL.createObjectURL = originalCreate;
      HTMLAnchorElement.prototype.click = originalClick;
    },
  };
}

async function zipText(blob: Blob): Promise<string> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const teile: string[] = [];
  for (const name of Object.keys(zip.files)) {
    teile.push(name);
    if (!zip.files[name]!.dir) teile.push(await zip.files[name]!.async('string'));
  }
  return teile.join('\n');
}

async function klick(c: HTMLElement, id: string): Promise<void> {
  const element = q(c, id) as HTMLButtonElement | null;
  expect(element, id).not.toBeNull();
  await act(async () => {
    element!.click();
  });
  await settle();
}

function sichtbareBestaende(c: HTMLElement): string[] {
  return Array.from(c.querySelectorAll('[data-testid^="local-recovery-copy-"]')).map((el) => el.getAttribute('data-testid')!.slice('local-recovery-copy-'.length));
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  resetAuthForTests();
  resetTestStores();
  await resetDocumentBlobDatabaseForTests();
  clearMockRpcHandlers();
  o1 = (await registerAndApproveUser(O1_MAIL)).id;
  m1 = (await registerAndApproveUser(M1_MAIL)).id;
  // Rolle im Betrieb je angemeldetem Konto, wie get_workspace_access sie meldet.
  registerMockRpcHandler('get_workspace_access', (args) => {
    const wer = getMockCurrentSession()?.user.id;
    if (args.p_workspace_id !== WS || (wer !== o1 && wer !== m1)) throw new Error('Kein Zugriff auf Workspace');
    return { workspace_id: WS, role: wer === o1 ? 'owner' : 'member', license_state: 'effective', license_effective: true };
  });
  localStorage.clear(); // Anmeldung der Vorbereitung nicht als gespeicherte Sitzung werten
  const mock = getSupabaseClient()!;
  await mock.auth.signOut();

  // Gastbestand mit einer manipulierten Referenz auf die Datei von O1 (T-01.3).
  localStorage.setItem(
    schluessel.gast,
    zustand('Gastbetrieb', { documentFileRefs: [{ id: 'ref-o1-datei', storageType: 'indexeddb', mimeType: 'application/pdf', fileSize: O1_BYTES.byteLength }] }, null),
  );
  localStorage.setItem(schluessel.o1Konto(), zustand('Inhaber Geheim GmbH'));
  localStorage.setItem(schluessel.m1Konto(), zustand('Mitglied Geheim GmbH'));
  localStorage.setItem(schluessel.o1Nutzer(), zustand('Inhaber Nutzerbestand'));
  localStorage.setItem(schluessel.altBetrieb, zustand('Alt Betrieb GmbH'));
  await saveDocumentBlob({
    fileRefId: 'ref-o1-datei',
    blob: new Blob([O1_BYTES], { type: 'application/pdf' }),
    mimeType: 'application/pdf',
    fileSize: O1_BYTES.byteLength,
    contentHash: 'h-o1',
    createdAt: '2026-10-20T08:00:00.000Z',
    scope: { type: 'workspace', workspaceId: WS, account: { userId: o1, access: 'full' } },
  });

  konsole = [];
  for (const art of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, art).mockImplementation((...args: unknown[]) => {
      konsole.push(args.map(String).join(' '));
    });
  }
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
  setMockGetUserFailure(null);
  vi.restoreAllMocks();
  clearMockRpcHandlers();
  resetTestStores();
  localStorage.clear();
  window.history.pushState({}, '', '/');
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('T-01 — abgemeldet', () => {
  it('T-01.1/T-01.2 Gastbestand sichtbar und sicherbar; gebundene nur als Anzahl, nirgends Kennungen oder Namen', async () => {
    const c = await renderRoot('/local-recovery');
    expect(q(c, 'local-recovery-identity')?.getAttribute('data-state')).toBe('signed_out');
    expect(sichtbareBestaende(c)).toEqual([schluessel.gast]);
    expect(q(c, 'local-recovery-bound-count')?.textContent).toContain('4');
    expect(q(c, 'local-recovery-login')).not.toBeNull();

    const dom = c.innerHTML;
    for (const geheim of GEHEIM()) {
      expect(dom, geheim).not.toContain(geheim);
      expect(konsole.join('\n'), geheim).not.toContain(geheim);
    }

    const d = downloads();
    try {
      await klick(c, `local-recovery-download-${schluessel.gast}`);
    } finally {
      d.restore();
    }
    expect(d.blobs).toHaveLength(1);
    const inhalt = await zipText(d.blobs[0]!);
    expect(inhalt).toContain('Gastbetrieb');
    for (const geheim of GEHEIM()) expect(inhalt, geheim).not.toContain(geheim);
  });

  it('T-01.3 eine manipulierte Dateireferenz im Gastbestand liefert die Datei von O1 nicht aus', async () => {
    const c = await renderRoot('/local-recovery');
    const d = downloads();
    try {
      await klick(c, `local-recovery-download-files-${schluessel.gast}`);
    } finally {
      d.restore();
    }
    expect(d.blobs).toHaveLength(1);
    const zip = await JSZip.loadAsync(await d.blobs[0]!.arrayBuffer());
    const dateien = Object.keys(zip.files).filter((name) => name.startsWith('files/') && !zip.files[name]!.dir);
    expect(dateien).toEqual([]);
    const manifest = JSON.parse(await zip.files['files-manifest.json']!.async('string')) as { entries: Array<{ fileRefId: string; status: string }> };
    expect(manifest.entries).toEqual([expect.objectContaining({ fileRefId: 'ref-o1-datei', status: 'missing' })]);
    expect(q(c, 'local-recovery-file-summary')?.textContent).toContain('fehlend: 1');
  });
});

describe('T-02 — Anmeldung und Bestätigung', () => {
  it('T-02.1 Anmeldung auf der Notfallseite als O1: nur O1-Bestände, M1 verborgen', async () => {
    const c = await renderRoot('/local-recovery');
    await anmelden(c, O1_MAIL);
    expect(q(c, 'local-recovery-identity')?.getAttribute('data-state')).toBe('confirmed');
    expect(sichtbareBestaende(c).sort()).toEqual([schluessel.altBetrieb, schluessel.gast, schluessel.o1Konto(), schluessel.o1Nutzer()].sort());
    expect(c.innerHTML).not.toContain('Mitglied Geheim GmbH');
    expect(c.innerHTML).not.toContain(m1);
    expect(q(c, 'local-recovery-bound-count')?.textContent).toContain('1');
    // Keine App-Anmeldung, kein Bootstrap: die Seite bleibt die Notfallseite.
    expect(q(c, 'local-recovery-page')).not.toBeNull();
    expect(q(c, 'app-shell')).toBeNull();
  });

  it('T-02.2 gespeicherte gültige Sitzung: vor dem Export erneut beim Server bestätigt, danach Export (ohne Tokens, N-T1.3)', async () => {
    await login(O1_MAIL, PASSWORT);
    const token = getMockCurrentSession()!.access_token;
    const c = await renderRoot('/local-recovery');
    expect(q(c, 'local-recovery-identity')?.getAttribute('data-state')).toBe('confirmed');
    const vorher = getMockGetUserCallCount();
    expect(vorher).toBeGreaterThan(0);

    const d = downloads();
    try {
      await klick(c, `local-recovery-download-${schluessel.o1Konto()}`);
    } finally {
      d.restore();
    }
    expect(getMockGetUserCallCount(), 'erneut bestätigt').toBeGreaterThan(vorher);
    expect(d.blobs).toHaveLength(1);
    const inhalt = await zipText(d.blobs[0]!);
    expect(inhalt).toContain('Inhaber Geheim GmbH');
    expect(inhalt).not.toContain(token);
    expect(inhalt).not.toContain('mock-refresh');
    expect(inhalt).not.toContain(PASSWORT);
  });

  it('T-02.3 nicht bestätigbare Sitzung: keine Freigabe; auch ein Widerruf kurz vor dem Export sperrt', async () => {
    await login(O1_MAIL, PASSWORT);
    setMockGetUserFailure('invalid');
    const c = await renderRoot('/local-recovery');
    expect(q(c, 'local-recovery-identity')?.getAttribute('data-state')).toBe('invalid');
    expect(sichtbareBestaende(c)).toEqual([schluessel.gast]);
    expect(q(c, 'local-recovery-login')).not.toBeNull();
    await act(async () => root?.unmount());
    host?.remove();

    // Zuerst bestätigt, dann vor dem Export widerrufen.
    setMockGetUserFailure(null);
    const c2 = await renderRoot('/local-recovery');
    expect(q(c2, 'local-recovery-identity')?.getAttribute('data-state')).toBe('confirmed');
    setMockGetUserFailure('invalid');
    const d = downloads();
    try {
      await klick(c2, `local-recovery-download-${schluessel.o1Konto()}`);
    } finally {
      d.restore();
    }
    expect(d.blobs).toHaveLength(0);
    expect(q(c2, 'local-recovery-export-blocked')).not.toBeNull();
    expect(sichtbareBestaende(c2)).toEqual([schluessel.gast]);
  });

  it('T-02.4 offline: gebundene Bestände gesperrt, Hinweis auf unveränderte Daten; ebenso bei Netzfehler der Prüfung', async () => {
    await login(O1_MAIL, PASSWORT);
    const vorher = { ...localStorage };
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const c = await renderRoot('/local-recovery');
    expect(q(c, 'local-recovery-identity')?.getAttribute('data-state')).toBe('offline');
    expect(q(c, 'local-recovery-identity')?.textContent).toContain('bleiben unverändert auf diesem Gerät');
    expect(sichtbareBestaende(c)).toEqual([schluessel.gast]);
    expect(q(c, 'local-recovery-login')).toBeNull();
    expect({ ...localStorage }).toEqual(vorher);
    await act(async () => root?.unmount());
    host?.remove();

    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    setMockGetUserFailure('network');
    const c2 = await renderRoot('/local-recovery');
    expect(q(c2, 'local-recovery-identity')?.getAttribute('data-state')).toBe('offline');
    expect(sichtbareBestaende(c2)).toEqual([schluessel.gast]);
  });

  it('T-02.5 als M1: nur M1-Bestände; O1 und der alte Betriebsbestand bleiben verborgen', async () => {
    const c = await renderRoot('/local-recovery');
    await anmelden(c, M1_MAIL);
    expect(q(c, 'local-recovery-identity')?.getAttribute('data-state')).toBe('confirmed');
    expect(sichtbareBestaende(c).sort()).toEqual([schluessel.gast, schluessel.m1Konto()].sort());
    for (const geheim of [o1, 'Inhaber Geheim GmbH', 'Inhaber Nutzerbestand', 'Alt Betrieb GmbH']) {
      expect(c.innerHTML, geheim).not.toContain(geheim);
    }
    expect(q(c, 'local-recovery-bound-count')?.textContent).toContain('3');
  });

  it('Abmelden auf der Notfallseite sperrt die gebundenen Bestände sofort wieder', async () => {
    const c = await renderRoot('/local-recovery');
    await anmelden(c, O1_MAIL);
    expect(sichtbareBestaende(c)).toContain(schluessel.o1Konto());
    await klick(c, 'local-recovery-logout');
    expect(q(c, 'local-recovery-identity')?.getAttribute('data-state')).toBe('signed_out');
    expect(sichtbareBestaende(c)).toEqual([schluessel.gast]);
  });
});

describe('T-03.1 — Import- und Quarantäneseite', () => {
  it('abgemeldet keine Zielbereiche und keine fremden Marker; als O1 nur dessen Bereiche', async () => {
    localStorage.setItem(
      buildQuarantineMarkerKey('q-e8e8e8e8e8e8e8e8-e8e8e8e8e8e8e8e8'),
      JSON.stringify({
        kind: 'officepilot-emergency-quarantine',
        formatVersion: 1,
        token: 'q-e8e8e8e8e8e8e8e8-e8e8e8e8e8e8e8e8',
        status: 'complete',
        sourceStorageKey: schluessel.m1Konto(),
        sourceScopeKey: `workspace:${WS}:account:${m1}:member`,
        workspaceId: WS,
        archiveSha256: '9'.repeat(64),
        sourceRawTextSha256: '8'.repeat(64),
        files: [],
        createdAt: '2026-10-20T08:00:00.000Z',
      }),
    );
    const c = await renderRoot('/local-recovery/import');
    expect(q(c, 'local-recovery-identity')?.getAttribute('data-state')).toBe('signed_out');
    expect(q(c, 'import-no-targets')).not.toBeNull();
    expect(c.querySelectorAll('[data-testid^="import-target-option-"]')).toHaveLength(0);
    expect(q(c, 'import-marker-list')).toBeNull();
    for (const geheim of GEHEIM()) expect(c.innerHTML, geheim).not.toContain(geheim);

    await anmelden(c, O1_MAIL);
    const ziele = Array.from(c.querySelectorAll('[data-testid^="import-target-option-"]')).map((el) =>
      el.getAttribute('data-testid')!.slice('import-target-option-'.length),
    );
    expect(ziele.sort()).toEqual([schluessel.altBetrieb, schluessel.o1Konto()].sort());
    // Der Marker gehört zum Bestand von M1 und bleibt für O1 unsichtbar.
    expect(q(c, 'import-marker-list')).toBeNull();
    expect(c.innerHTML).not.toContain(m1);
  });
});
